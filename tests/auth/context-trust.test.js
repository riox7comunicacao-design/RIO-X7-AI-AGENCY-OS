// Fase C — AuthorizationContext emitido só pelo caminho interno confiável.
//
// O que estes testes protegem: um AuthorizationContext só existe se o emissor
// interno o emitiu, a partir de um USER definido por defineUser() com
// authUserId; as permissions efetivas vêm SEMPRE da role (fonte canônica), e
// nenhum objeto solto, cópia ou clone é aceito como USER definido ou como
// contexto. As marcas são fronteiras arquiteturais internas confiáveis (por
// identidade de objeto) — NÃO mecanismos criptográficos: não protegem contra
// código malicioso que já controle o mesmo processo.
//
// Determinístico e sem rede: só USER/contexto em memória. O emissor interno é
// obtido pelo helper de composição de testes (tests/helpers/authFixtures.js),
// que é o único ponto de teste que importa o caminho interno.

const test = require('node:test');
const assert = require('node:assert/strict');

const authBarrel = require('../../src/auth');
const authorizationContextModule = require('../../src/auth/authorizationContext');
const userModule = require('../../src/auth/user');
const userResolverModule = require('../../src/auth/userResolver');
const authAdapterModule = require('../../src/auth/authAdapter');
const bridgeModule = require('../../src/auth/approvalQueueBridge');
const constants = require('../../src/auth/constants');
const { contextIssuerModule, issueAuthorizationContext, isIssuedAuthorizationContext } = require('../helpers/authFixtures');

const { ROLE, USER_STATUS, PERMISSION, defineUser, requireActiveUser, hasPermission, requirePermission, assertIsAuthorizationContext } =
  authBarrel;
const { isDefinedUser } = userModule;

// Listas LITERAIS, independentes de src/ (as mesmas de role-permissions.test.js).
const ADMIN_LITERAL = [
  'READ:CRM',
  'ANALYZE:CRM',
  'PROPOSE:CRM',
  'WRITE:CRM',
  'PROPOSE:LEAD_APPROVAL',
  'APPROVE:LEAD_APPROVAL',
  'APPROVE:OUTBOUND_APPROVAL',
  'MANAGE:USERS',
];
const CLOSER_LITERAL = ['READ:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL'];

const USER_FIELDS = ['authUserId', 'createdAt', 'email', 'name', 'permissions', 'role', 'status', 'updatedAt', 'userId'];
const CONTEXT_FIELDS = ['authUserId', 'name', 'permissions', 'role', 'status', 'userId'];

const sorted = (list) => [...list].sort();
const hasOwn = (objeto, nome) => Object.prototype.hasOwnProperty.call(objeto, nome);

function userInput(overrides = {}) {
  return {
    userId: 'user-ctx-1',
    authUserId: 'auth-ctx-1',
    name: 'Usuário Contexto',
    email: 'ctx@example.test',
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  };
}

// Formas de cópia/clone de um objeto congelado — nenhuma pode ser reconhecida.
function copiasDe(original) {
  return [
    ['spread', { ...original }],
    ['spread congelada', Object.freeze({ ...original })],
    ['Object.assign', Object.assign({}, original)],
    ['Object.fromEntries', Object.fromEntries(Object.entries(original))],
    ['structuredClone', structuredClone(original)],
    ['clone via JSON', JSON.parse(JSON.stringify(original))],
    ['Object.create(original)', Object.create(original)],
    ['Proxy(original)', new Proxy(original, {})],
  ];
}

// ===========================================================================
// USER definido (C1)
// ===========================================================================
test('[CTXT-1] um USER definido por defineUser() é reconhecido por isDefinedUser(), e literais, cópias e clones dele NÃO são', () => {
  const usuario = defineUser(userInput());
  assert.equal(isDefinedUser(usuario), true);

  // Contrato de campos do USER inalterado; a marca não vive no objeto.
  assert.deepEqual(sorted(Object.keys(usuario)), USER_FIELDS);
  assert.deepEqual(Reflect.ownKeys(usuario).map(String).sort(), USER_FIELDS);
  assert.equal(Object.isFrozen(usuario), true);

  const literal = {
    userId: usuario.userId,
    authUserId: usuario.authUserId,
    name: usuario.name,
    email: usuario.email,
    role: usuario.role,
    permissions: [...usuario.permissions],
    status: usuario.status,
    createdAt: usuario.createdAt,
    updatedAt: usuario.updatedAt,
  };
  for (const [rotulo, copia] of [['literal com os mesmos campos', literal], ['literal congelado', Object.freeze(literal)], ...copiasDe(usuario)]) {
    assert.equal(isDefinedUser(copia), false, rotulo);
  }

  for (const naoObjeto of [undefined, null, '', 'userId', 0, 42, true, 1n, Symbol('x'), () => {}, [], {}]) {
    assert.equal(isDefinedUser(naoObjeto), false);
  }

  // Cada defineUser() devolve um objeto próprio, e todos são reconhecidos; o original segue reconhecido.
  const outro = defineUser(userInput());
  assert.notEqual(outro, usuario);
  assert.equal(isDefinedUser(outro), true);
  assert.equal(isDefinedUser(usuario), true);
});

// ===========================================================================
// Emissor: authUserId obrigatório (C2)
// ===========================================================================
test('[CTXT-2] um USER sem authUserId não emite contexto: a identidade de runtime é obrigatória', () => {
  const semVinculo = defineUser(userInput({ authUserId: null }));
  const omitido = defineUser(userInput({ authUserId: undefined }));

  // São USERs válidos (por exemplo, um convite ainda sem vínculo com o provedor)...
  assert.equal(semVinculo.authUserId, null);
  assert.equal(isDefinedUser(semVinculo), true);
  assert.equal(isDefinedUser(omitido), true);

  // ...mas nenhum deles origina um contexto.
  for (const usuario of [semVinculo, omitido]) {
    assert.throws(() => issueAuthorizationContext(usuario), /authUserId é obrigatório/);
  }

  // authUserId vazio/inválido nem chega a ser um USER definido.
  for (const invalido of ['', '   ', 123]) {
    assert.throws(() => defineUser(userInput({ authUserId: invalido })), /authUserId/, String(invalido));
  }

  // Precedência: um literal (não definido) é recusado por isso, antes de qualquer outro motivo.
  assert.throws(() => issueAuthorizationContext({ ...userInput(), authUserId: null }), /USER definido por defineUser/);

  // Com authUserId, emite normalmente.
  assert.equal(isIssuedAuthorizationContext(issueAuthorizationContext(defineUser(userInput()))), true);
});

test('[CTXT-3] o contexto emitido contém authUserId (a identidade técnica de runtime), exatamente os 6 campos, congelado', () => {
  const usuario = defineUser(userInput({ role: ROLE.COMMERCIAL_CLOSER }));
  const contexto = issueAuthorizationContext(usuario);

  assert.equal(contexto.authUserId, 'auth-ctx-1');
  assert.equal(contexto.userId, usuario.userId);
  assert.equal(contexto.name, usuario.name);
  assert.equal(contexto.role, usuario.role);
  assert.equal(contexto.status, usuario.status);

  assert.deepEqual(sorted(Object.keys(contexto)), CONTEXT_FIELDS);
  assert.deepEqual(Reflect.ownKeys(contexto).map(String).sort(), CONTEXT_FIELDS, 'a marca não vive no objeto');
  assert.equal(Object.isFrozen(contexto), true);
  assert.equal(Object.isFrozen(contexto.permissions), true);

  // Nada além dos 6 campos: sem e-mail, datas, segredos ou ator.
  for (const fora of ['email', 'createdAt', 'updatedAt', 'password', 'token', 'actorType']) {
    assert.equal(hasOwn(contexto, fora), false, `${fora} não pode existir no contexto`);
  }

  // Emitir de novo gera outro objeto, também reconhecido.
  const outro = issueAuthorizationContext(usuario);
  assert.notEqual(outro, contexto);
  assert.equal(isIssuedAuthorizationContext(outro), true);
  assert.equal(isIssuedAuthorizationContext(contexto), true);
});

// ===========================================================================
// Permissions derivadas da role (C2)
// ===========================================================================
test('[CTXT-4] as permissions do contexto são derivadas da role: ADMIN = 8 e COMMERCIAL_CLOSER = 5, em cópia congelada', () => {
  const admin = defineUser(userInput({ role: ROLE.ADMIN }));
  const closer = defineUser(userInput({ userId: 'user-ctx-2', authUserId: 'auth-ctx-2', email: 'ctx2@example.test', role: ROLE.COMMERCIAL_CLOSER }));
  const adminContext = issueAuthorizationContext(admin);
  const closerContext = issueAuthorizationContext(closer);

  assert.equal(adminContext.permissions.length, 8);
  assert.equal(closerContext.permissions.length, 5);
  assert.deepEqual(sorted(adminContext.permissions), sorted(ADMIN_LITERAL));
  assert.deepEqual(sorted(closerContext.permissions), sorted(CLOSER_LITERAL));

  // Cópias: nunca o array do USER nem o da tabela da role.
  assert.notEqual(adminContext.permissions, admin.permissions);
  assert.notEqual(adminContext.permissions, constants.ADMIN_PERMISSIONS);
  assert.notEqual(closerContext.permissions, closer.permissions);
  assert.notEqual(closerContext.permissions, constants.COMMERCIAL_CLOSER_PERMISSIONS);

  // Um USER INACTIVE também tem as permissions da role — quem nega a ação é o status.
  const inativo = issueAuthorizationContext(
    defineUser(userInput({ userId: 'user-ctx-3', authUserId: 'auth-ctx-3', email: 'ctx3@example.test', role: ROLE.COMMERCIAL_CLOSER, status: USER_STATUS.INACTIVE }))
  );
  assert.equal(inativo.permissions.length, 5);
  assert.equal(inativo.status, USER_STATUS.INACTIVE);
  assert.equal(hasPermission(inativo, PERMISSION.READ_CRM), false);
  assert.throws(() => requireActiveUser(inativo), /inativo/);
});

test('[CTXT-5] a origem das permissions efetivas é a fonte canônica da role: user.permissions nunca é lido, e não há como alterá-lo', (t) => {
  const usuario = defineUser(userInput({ role: ROLE.ADMIN }));
  assert.equal(usuario.permissions.length, 8);

  // Trocamos SÓ a fonte canônica (neste teste, com restauração automática): o
  // contexto segue a fonte, e o USER — com suas 8 permissions — é ignorado.
  t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  const contexto = issueAuthorizationContext(usuario);

  assert.deepEqual([...contexto.permissions], [PERMISSION.READ_CRM]);
  assert.equal(constants.getRolePermissions.mock.callCount() >= 1, true, 'a fonte canônica foi consultada na emissão');
  assert.equal(usuario.permissions.length, 8, 'o USER não mudou');

  // Alterar user.permissions (ou as do contexto) é recusado: USER, contexto e arrays são congelados.
  assert.equal(Reflect.set(usuario, 'permissions', [PERMISSION.MANAGE_USERS]), false);
  assert.equal(Reflect.set(contexto, 'permissions', [PERMISSION.MANAGE_USERS]), false);
  assert.throws(() => Reflect.apply(Array.prototype.push, usuario.permissions, ['MANAGE:USERS']), TypeError);
  assert.throws(() => Reflect.apply(Array.prototype.push, contexto.permissions, ['MANAGE:USERS']), TypeError);
  assert.equal(usuario.permissions.length, 8);
  assert.equal(contexto.permissions.length, 1);
});

// ===========================================================================
// Contexto: a marca de emissão (C3)
// ===========================================================================
test('[CTXT-6] contexto literal, clonado ou sem marca é rejeitado por todas as checagens: a marca vale antes da forma e do Object.freeze', () => {
  const original = issueAuthorizationContext(defineUser(userInput({ role: ROLE.COMMERCIAL_CLOSER })));

  // O contexto emitido passa em tudo.
  assert.equal(requirePermission(original, PERMISSION.READ_CRM), original);
  assert.equal(requireActiveUser(original), original);
  assert.equal(hasPermission(original, PERMISSION.READ_CRM), true);
  assert.doesNotThrow(() => assertIsAuthorizationContext(original));

  const literal = {
    userId: original.userId,
    authUserId: original.authUserId,
    name: original.name,
    role: original.role,
    permissions: [...original.permissions],
    status: original.status,
  };
  const imitacoes = [
    ['literal com os mesmos campos', literal],
    ['literal congelado (o atalho antigo)', Object.freeze({ ...literal, permissions: Object.freeze([...literal.permissions]) })],
    ...copiasDe(original),
    ['objeto incompleto congelado', Object.freeze({ userId: 'x' })],
    ['objeto vazio', {}],
  ];

  for (const [rotulo, imitacao] of imitacoes) {
    assert.equal(isIssuedAuthorizationContext(imitacao), false, rotulo);
    assert.throws(() => assertIsAuthorizationContext(imitacao), /emitido pelo emissor interno confiável/, rotulo);
    assert.throws(() => requireActiveUser(imitacao), /emitido pelo emissor interno confiável/, rotulo);
    assert.throws(() => hasPermission(imitacao, PERMISSION.READ_CRM), /emitido pelo emissor interno confiável/, rotulo);
    assert.throws(() => requirePermission(imitacao, PERMISSION.READ_CRM), /emitido pelo emissor interno confiável/, rotulo);
  }

  for (const naoObjeto of [undefined, null, '', 'contexto', 0, 42, true, () => {}]) {
    assert.throws(() => assertIsAuthorizationContext(naoObjeto), /AuthorizationContext inválido/);
  }

  // O original continua válido depois de todas as tentativas.
  assert.equal(isIssuedAuthorizationContext(original), true);
});

// ===========================================================================
// Superfície pública (C2/C3)
// ===========================================================================
test('[CTXT-7] o emissor de contexto não é exportado pelo barrel de src/auth, nem por nenhum módulo público de src/auth', () => {
  const nomesProibidos = ['issueAuthorizationContext', 'isIssuedAuthorizationContext', 'createAuthorizationContext', 'contextIssuer'];
  const modulos = {
    'src/auth (barrel)': authBarrel,
    'authorizationContext.js': authorizationContextModule,
    'user.js': userModule,
    'userResolver.js': userResolverModule,
    'authAdapter.js': authAdapterModule,
    'approvalQueueBridge.js': bridgeModule,
    'constants.js': constants,
  };
  for (const [rotulo, modulo] of Object.entries(modulos)) {
    for (const nome of nomesProibidos) {
      assert.equal(hasOwn(modulo, nome), false, `${rotulo} não deve exportar ${nome}`);
    }
  }

  // Nenhum valor exportado pelo barrel é a função emissora (nem sob outro nome).
  for (const [nome, valor] of Object.entries(authBarrel)) {
    assert.notEqual(valor, issueAuthorizationContext, `o barrel exporta o emissor sob o nome ${nome}`);
    assert.notEqual(valor, isIssuedAuthorizationContext, `o barrel exporta a consulta de marca sob o nome ${nome}`);
  }

  // O módulo interno exporta exatamente o emissor e a consulta de marca — nada mais.
  assert.deepEqual(sorted(Object.keys(contextIssuerModule)), ['isIssuedAuthorizationContext', 'issueAuthorizationContext']);
});

test('[CTXT-8] createAuthorizationContext não permanece como construtor público: nem no barrel, nem no módulo de contexto, nem sob outro nome', () => {
  assert.equal(authBarrel.createAuthorizationContext, undefined);
  assert.equal(authorizationContextModule.createAuthorizationContext, undefined);
  assert.equal(hasOwn(authBarrel, 'createAuthorizationContext'), false);
  assert.equal(hasOwn(authorizationContextModule, 'createAuthorizationContext'), false);

  // O que o barrel e o módulo oferecem sobre contexto são só VERIFICAÇÕES.
  for (const nome of ['assertIsAuthorizationContext', 'requireActiveUser', 'hasPermission', 'requirePermission']) {
    assert.equal(typeof authBarrel[nome], 'function', nome);
    assert.equal(authBarrel[nome], authorizationContextModule[nome], `${nome} é a mesma função do módulo`);
  }
  assert.deepEqual(sorted(Object.keys(authorizationContextModule)), ['assertIsAuthorizationContext', 'hasPermission', 'requireActiveUser', 'requirePermission']);

  // Nenhum nome exportado pelo barrel sugere um construtor/emissor de contexto (o resolver, que só resolve, é o legítimo).
  for (const nome of Object.keys(authBarrel)) {
    assert.doesNotMatch(nome, /(create|issue|make|build|emit|mint|new)\w*context/i, `export suspeito no barrel: ${nome}`);
  }
  assert.equal(typeof authBarrel.resolveAuthorizationContext, 'function');
});
