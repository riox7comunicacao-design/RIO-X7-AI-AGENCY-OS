// Fase D — USER Resolver: só VerifiedIdentity, só authUserId, nenhum e-mail.
//
// O que estes testes protegem:
//   VerifiedIdentity -> authUserId -> USER encontrado    -> AuthorizationContext
//                                  -> USER não encontrado -> USER_NOT_FOUND
// NUNCA: authUserId não encontrado -> tentar e-mail -> encontrar/criar/vincular USER.
//
// A marca de VerifiedIdentity e a de USER definido são fronteiras
// arquiteturais internas confiáveis — NÃO criptografia: não protegem contra
// código malicioso que já controle o mesmo processo.
//
// Determinístico e sem rede: as identidades são REAIS (verifyAccessToken
// contra um Supabase falso — tests/helpers/authFixtures.js) e os USERs são
// definidos em memória. Nenhum dado real é usado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authBarrel = require('../../src/auth');
const userResolverModule = require('../../src/auth/userResolver');
const { verifiedIdentityFor, verifiedIdentitiesFor } = require('../helpers/authFixtures');

const {
  ROLE,
  USER_STATUS,
  PERMISSION,
  defineUser,
  createUserStore,
  resolveAuthorizationContext,
  requirePermission,
  UserResolutionError,
  USER_RESOLUTION_ERROR,
  USER_NOT_FOUND,
} = authBarrel;

const ADMIN_AUTH_ID = 'auth-res-admin';
const CLOSER_AUTH_ID = 'auth-res-closer';

function admin(overrides = {}) {
  return defineUser({
    userId: 'user-res-admin',
    authUserId: ADMIN_AUTH_ID,
    name: 'Admin Resolver',
    email: 'admin-res@example.test',
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });
}

function closer(overrides = {}) {
  return defineUser({
    userId: 'user-res-closer',
    authUserId: CLOSER_AUTH_ID,
    name: 'Closer Resolver',
    email: 'closer-res@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });
}

// Validador para assert.throws: erro de resolução/store com o código esperado.
const falhaCom = (codigo) => (erro) => {
  assert.ok(erro instanceof UserResolutionError, `esperava UserResolutionError, veio ${erro && erro.name}`);
  assert.equal(erro.code, codigo);
  return true;
};

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
// Resolução por authUserId (D1)
// ===========================================================================
test('[RES-1] o USER é encontrado por authUserId (de uma VerifiedIdentity) e o contexto é o dele', async (t) => {
  const store = createUserStore([admin(), closer()]);
  const [identidadeAdmin, identidadeCloser] = await verifiedIdentitiesFor(t, [
    { authUserId: ADMIN_AUTH_ID, email: 'qualquer@example.test' },
    { authUserId: CLOSER_AUTH_ID, email: 'qualquer@example.test' },
  ]);

  const contextoCloser = resolveAuthorizationContext(store, identidadeCloser);
  assert.equal(contextoCloser.userId, 'user-res-closer');
  assert.equal(contextoCloser.authUserId, CLOSER_AUTH_ID);
  assert.equal(contextoCloser.role, ROLE.COMMERCIAL_CLOSER);
  assert.equal(requirePermission(contextoCloser, PERMISSION.READ_CRM), contextoCloser, 'é um contexto emitido, aceito pelos serviços');

  const contextoAdmin = resolveAuthorizationContext(store, identidadeAdmin);
  assert.equal(contextoAdmin.userId, 'user-res-admin');
  assert.equal(contextoAdmin.role, ROLE.ADMIN);
  assert.notEqual(contextoAdmin.userId, contextoCloser.userId);
});

test('[RES-2] authUserId inexistente resulta em USER_NOT_FOUND (erro explícito, com código exportado pelo barrel)', async (t) => {
  const store = createUserStore([admin()]);
  const identidade = await verifiedIdentityFor(t, { authUserId: 'auth-que-nao-existe', email: 'x@example.test' });

  assert.throws(() => resolveAuthorizationContext(store, identidade), falhaCom('USER_NOT_FOUND'));
  assert.throws(() => resolveAuthorizationContext(store, identidade), /não encontrado/);

  // O código é uma constante exportada pelo barrel e faz parte do enum de códigos.
  assert.equal(typeof USER_NOT_FOUND, 'string');
  assert.equal(USER_NOT_FOUND, 'USER_NOT_FOUND');
  assert.equal(USER_RESOLUTION_ERROR.USER_NOT_FOUND, USER_NOT_FOUND);
  assert.equal(Object.isFrozen(USER_RESOLUTION_ERROR), true);

  // Store vazio: o mesmo resultado.
  assert.throws(() => resolveAuthorizationContext(createUserStore([]), identidade), falhaCom(USER_NOT_FOUND));
});

test('[RES-3] e-mail correto de um USER, mas authUserId inexistente, continua USER_NOT_FOUND (com e-mail confirmado ou não)', async (t) => {
  const store = createUserStore([admin(), closer()]);
  const identidades = await verifiedIdentitiesFor(t, [
    { authUserId: 'auth-inexistente-1', email: 'admin-res@example.test', emailConfirmed: true },
    { authUserId: 'auth-inexistente-2', email: 'admin-res@example.test', emailConfirmed: false },
    { authUserId: 'auth-inexistente-3', email: 'closer-res@example.test', emailConfirmed: true },
  ]);

  for (const identidade of identidades) {
    assert.throws(() => resolveAuthorizationContext(store, identidade), falhaCom(USER_NOT_FOUND), identidade.authUserId);
  }
});

test('[RES-4] o e-mail de outro USER nunca resolve: só o authUserId decide, e o e-mail nem é necessário', async (t) => {
  const store = createUserStore([admin(), closer()]);
  const [comEmailDoAdmin, semEmail] = await verifiedIdentitiesFor(t, [
    // authUserId do CLOSER, mas com o e-mail (confirmado) do ADMIN.
    { authUserId: CLOSER_AUTH_ID, email: 'admin-res@example.test', emailConfirmed: true },
    // authUserId do ADMIN e nenhum e-mail.
    { authUserId: ADMIN_AUTH_ID },
  ]);
  assert.equal(comEmailDoAdmin.email, 'admin-res@example.test');
  assert.equal(semEmail.email, null);

  const contexto = resolveAuthorizationContext(store, comEmailDoAdmin);
  assert.equal(contexto.userId, 'user-res-closer', 'resolve para o dono do authUserId, nunca para o dono do e-mail');
  assert.equal(contexto.role, ROLE.COMMERCIAL_CLOSER);
  assert.equal(contexto.permissions.includes(PERMISSION.MANAGE_USERS), false);

  const semEmailContexto = resolveAuthorizationContext(store, semEmail);
  assert.equal(semEmailContexto.userId, 'user-res-admin', 'sem e-mail, o authUserId basta');
});

test('[RES-5] não existe findByEmail (nem qualquer uso de e-mail) no store nem no resolver; isVerifiedIdentity e isDefinedUser não saem no barrel', () => {
  const store = createUserStore([admin()]);
  assert.equal(store.findByEmail, undefined);
  assert.deepEqual(Object.keys(store).sort(), ['add', 'all', 'findByAuthUserId']);
  assert.equal(userResolverModule.findByEmail, undefined);
  assert.equal(authBarrel.findByEmail, undefined);
  assert.equal(resolveAuthorizationContext.length, 2, 'só o store e a VerifiedIdentity: nada de e-mail, role ou permissions do chamador');

  // O código do resolver (fora dos comentários) nunca menciona e-mail.
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'auth', 'userResolver.js'), 'utf8');
  const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(semComentarios, /e-?mail/i);
  assert.match(semComentarios, /findByAuthUserId/, 'sanidade do teste: o código existe e os comentários foram removidos');

  // Ainda fora do barrel (decisão desta fase): as duas marcas internas.
  assert.equal(authBarrel.isVerifiedIdentity, undefined);
  assert.equal(authBarrel.isDefinedUser, undefined);
});

// ===========================================================================
// VerifiedIdentity obrigatória (D2)
// ===========================================================================
test('[RES-6] uma identidade literal é rejeitada (IDENTITY_NOT_VERIFIED), mesmo com os campos e o authUserId de um USER real', async (t) => {
  const store = createUserStore([admin()]);
  const literais = [
    ['literal com os 3 campos', { authUserId: ADMIN_AUTH_ID, email: 'admin-res@example.test', emailConfirmed: true }],
    ['literal congelado', Object.freeze({ authUserId: ADMIN_AUTH_ID, email: 'admin-res@example.test', emailConfirmed: true })],
    ['literal só com authUserId (o formato antigo)', { authUserId: ADMIN_AUTH_ID }],
    ['literal com role/permissions', { authUserId: ADMIN_AUTH_ID, role: ROLE.ADMIN, permissions: [PERMISSION.MANAGE_USERS] }],
  ];
  for (const [rotulo, literal] of literais) {
    assert.throws(() => resolveAuthorizationContext(store, literal), falhaCom(USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED), rotulo);
  }

  // Controle: a identidade REAL do mesmo USER resolve.
  const real = await verifiedIdentityFor(t, { authUserId: ADMIN_AUTH_ID, email: 'admin-res@example.test' });
  assert.equal(resolveAuthorizationContext(store, real).userId, 'user-res-admin');
});

test('[RES-7] um clone de uma VerifiedIdentity real é rejeitado (a marca é por objeto, não por conteúdo)', async (t) => {
  const store = createUserStore([admin()]);
  const original = await verifiedIdentityFor(t, { authUserId: ADMIN_AUTH_ID, email: 'admin-res@example.test', emailConfirmed: true });

  for (const [rotulo, copia] of copiasDe(original)) {
    assert.throws(() => resolveAuthorizationContext(store, copia), falhaCom(USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED), rotulo);
  }
  assert.equal(resolveAuthorizationContext(store, original).userId, 'user-res-admin', 'o original continua resolvendo');
});

test('[RES-8] uma identidade não marcada falha fechada: o store nem é consultado', async (t) => {
  const consultas = [];
  const storeEspiao = {
    findByAuthUserId(authUserId) {
      consultas.push(authUserId);
      return null;
    },
  };

  const naoMarcadas = [
    ['undefined', undefined],
    ['null', null],
    ['string vazia', ''],
    ['string com o authUserId', ADMIN_AUTH_ID],
    ['número', 42],
    ['true', true],
    ['função', () => ({ authUserId: ADMIN_AUTH_ID })],
    ['array', [ADMIN_AUTH_ID]],
    ['objeto vazio', {}],
    ['Object.create(null)', Object.create(null)],
    // O formato que resolveAuthenticatedIdentity() (baseado em sessão) devolveria: não é prova de identidade.
    ['saída de sessão { authUserId, email }', { authUserId: ADMIN_AUTH_ID, email: 'admin-res@example.test' }],
    ['Proxy de um literal', new Proxy({ authUserId: ADMIN_AUTH_ID }, {})],
  ];
  for (const [rotulo, valor] of naoMarcadas) {
    assert.throws(() => resolveAuthorizationContext(storeEspiao, valor), falhaCom(USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED), rotulo);
  }
  assert.equal(consultas.length, 0, 'nenhuma consulta ao store para uma identidade não verificada');

  // Controle: com uma identidade REAL o espião é consultado (então a contagem zero acima significa algo).
  const real = await verifiedIdentityFor(t, { authUserId: ADMIN_AUTH_ID, email: 'admin-res@example.test' });
  assert.throws(() => resolveAuthorizationContext(storeEspiao, real), falhaCom(USER_NOT_FOUND));
  assert.deepEqual(consultas, [ADMIN_AUTH_ID]);
});

// ===========================================================================
// Store: só USERs definidos e operacionais, únicos (D1)
// ===========================================================================
test('[RES-9] um USER não definido por defineUser() não entra no store (literal, cópia, clone)', () => {
  const definido = admin();
  const literal = { userId: 'user-literal', authUserId: 'auth-literal', name: 'L', email: 'l@example.test', role: ROLE.ADMIN, permissions: [], status: USER_STATUS.ACTIVE };
  const invalidos = [['literal', literal], ['literal congelado', Object.freeze({ ...literal })], ...copiasDe(definido), ['null', null], ['string', 'user-res-admin']];

  for (const [rotulo, invalido] of invalidos) {
    assert.throws(() => createUserStore([invalido]), falhaCom(USER_RESOLUTION_ERROR.USER_NOT_DEFINED), `createUserStore: ${rotulo}`);
    const store = createUserStore([]);
    assert.throws(() => store.add(invalido), falhaCom(USER_RESOLUTION_ERROR.USER_NOT_DEFINED), `add: ${rotulo}`);
    assert.equal(store.all().length, 0, `${rotulo}: o store continua vazio`);
  }

  // Controle: o USER definido entra.
  assert.equal(createUserStore([definido]).all().length, 1);
});

test('[RES-10] um USER sem authUserId não entra como USER operacional', () => {
  const semVinculo = defineUser({
    userId: 'user-sem-vinculo',
    authUserId: null,
    name: 'Sem Vínculo',
    email: 'sem-vinculo@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
  });
  const omitido = defineUser({
    userId: 'user-omitido',
    name: 'Omitido',
    email: 'omitido@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
  });
  assert.equal(semVinculo.authUserId, null);
  assert.equal(omitido.authUserId, null);

  for (const usuario of [semVinculo, omitido]) {
    assert.throws(() => createUserStore([usuario]), falhaCom(USER_RESOLUTION_ERROR.USER_NOT_OPERATIONAL), usuario.userId);
    const store = createUserStore([]);
    assert.throws(() => store.add(usuario), falhaCom(USER_RESOLUTION_ERROR.USER_NOT_OPERATIONAL), usuario.userId);
    assert.equal(store.all().length, 0);
  }

  // Um USER com authUserId, mesmo sendo o único, entra.
  assert.equal(createUserStore([closer()]).all().length, 1);
});

test('[RES-11] um userId duplicado é rejeitado, nunca sobrescreve o USER existente', () => {
  const primeiro = closer();
  const segundoMesmoUserId = closer({ authUserId: 'auth-res-outro', email: 'outro@example.test' });
  assert.equal(primeiro.userId, segundoMesmoUserId.userId);

  assert.throws(() => createUserStore([primeiro, segundoMesmoUserId]), falhaCom(USER_RESOLUTION_ERROR.USER_ID_DUPLICATE));

  const store = createUserStore([primeiro]);
  assert.throws(() => store.add(segundoMesmoUserId), falhaCom(USER_RESOLUTION_ERROR.USER_ID_DUPLICATE));
  assert.deepEqual(store.all(), [primeiro], 'o USER original permanece');
  assert.equal(store.findByAuthUserId(CLOSER_AUTH_ID), primeiro);
  assert.equal(store.findByAuthUserId('auth-res-outro'), null, 'o duplicado rejeitado não entrou por nenhum caminho');
});

test('[RES-12] um authUserId duplicado é rejeitado, e a resolução nunca escolhe "o primeiro" arbitrariamente', async (t) => {
  const primeiro = closer();
  const outroUserMesmoAuthUserId = admin({ authUserId: CLOSER_AUTH_ID });
  assert.equal(primeiro.authUserId, outroUserMesmoAuthUserId.authUserId);
  assert.notEqual(primeiro.userId, outroUserMesmoAuthUserId.userId);

  assert.throws(() => createUserStore([primeiro, outroUserMesmoAuthUserId]), falhaCom(USER_RESOLUTION_ERROR.AUTH_USER_ID_DUPLICATE));

  const store = createUserStore([primeiro]);
  assert.throws(() => store.add(outroUserMesmoAuthUserId), falhaCom(USER_RESOLUTION_ERROR.AUTH_USER_ID_DUPLICATE));
  assert.equal(store.all().length, 1);

  // A resolução segue determinística: só existe UM USER para esse authUserId.
  const identidade = await verifiedIdentityFor(t, { authUserId: CLOSER_AUTH_ID, email: 'x@example.test' });
  assert.equal(resolveAuthorizationContext(store, identidade).role, ROLE.COMMERCIAL_CLOSER);
});

// ===========================================================================
// Nenhum caminho cria USER
// ===========================================================================
test('[RES-13] nenhum caminho cria USER automaticamente: nem na falha, nem no sucesso, nem por entradas malformadas', async (t) => {
  const store = createUserStore([admin(), closer()]);
  const antes = store.all().map((u) => u.userId).sort();

  const [desconhecida, desconhecidaComEmailDeUserReal, conhecida] = await verifiedIdentitiesFor(t, [
    { authUserId: 'auth-que-nao-existe', email: 'novo@example.test', emailConfirmed: true },
    { authUserId: 'auth-que-nao-existe-2', email: 'admin-res@example.test', emailConfirmed: true },
    { authUserId: ADMIN_AUTH_ID, email: 'admin-res@example.test' },
  ]);

  // Falha por authUserId desconhecido (com e-mail novo, ou com o e-mail de um USER real).
  assert.throws(() => resolveAuthorizationContext(store, desconhecida), falhaCom(USER_NOT_FOUND));
  assert.throws(() => resolveAuthorizationContext(store, desconhecidaComEmailDeUserReal), falhaCom(USER_NOT_FOUND));
  // Sucesso.
  assert.equal(resolveAuthorizationContext(store, conhecida).userId, 'user-res-admin');
  // Entradas malformadas.
  for (const malformada of [undefined, null, {}, { authUserId: 'auth-que-nao-existe' }]) {
    assert.throws(() => resolveAuthorizationContext(store, malformada), falhaCom(USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED));
  }

  assert.deepEqual(store.all().map((u) => u.userId).sort(), antes, 'o conjunto de USERs não mudou');
  assert.equal(store.findByAuthUserId('auth-que-nao-existe'), null);
  assert.equal(store.findByAuthUserId('auth-que-nao-existe-2'), null);

  // O store não tem nenhuma operação de criação/vínculo além de add() (que só aceita USER já definido e operacional).
  assert.deepEqual(Object.keys(store).sort(), ['add', 'all', 'findByAuthUserId']);

  // O módulo do resolver não tem como criar USER: do módulo './user' ele importa SÓ
  // isDefinedUser (consulta) — nunca defineUser (criação) — e a função de resolução não grava em nenhum store.
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'auth', 'userResolver.js'), 'utf8');
  const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(semComentarios.split("require('./user')").length - 1, 1, "um único require('./user')");
  const importadosDeUser = /const\s*\{([^}]*)\}\s*=\s*require\('\.\/user'\)/.exec(semComentarios);
  assert.ok(importadosDeUser, "o require('./user') é desestruturado");
  assert.deepEqual(
    importadosDeUser[1].split(',').map((nome) => nome.trim()).filter(Boolean),
    ['isDefinedUser']
  );
  const corpo = semComentarios.slice(semComentarios.indexOf('function resolveAuthorizationContext'), semComentarios.indexOf('module.exports'));
  assert.ok(corpo.length > 50, 'sanidade: o corpo da função de resolução foi isolado');
  assert.doesNotMatch(corpo, /\.add\(|\.set\(/, 'a função de resolução não grava em nenhum store');
});
