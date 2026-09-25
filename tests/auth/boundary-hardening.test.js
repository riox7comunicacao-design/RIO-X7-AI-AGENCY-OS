// Fase F — hardening comportamental das fronteiras de identidade e autorização.
//
// Fecha as lacunas que a revisão dos testes existentes (Fases A-E) deixou comprovadas
// para as Fronteiras 5 a 9. Não cria mecanismo novo: prova, por execução, que os
// mecanismos atuais (marcas de objeto, objetos congelados, permissões derivadas da
// role, scrub do token) continuam impedindo o que precisam impedir.
//   [HARD-1] o único caminho público até um AuthorizationContext (Fronteira 5);
//   [HARD-2] o access token não vaza em nenhuma vista do erro (Fronteira 6, item 9);
//   [HARD-3] o caminho legado por sessão nunca vira identidade verificada (Fronteira 6);
//   [HARD-4] nenhuma permissão extra ou faltante entra em um USER (Fronteira 9);
//   [HARD-5] a tabela de decisão da resolução de USER (Fronteira 7).
//
// As marcas e os Object.freeze são uma fronteira arquitetural interna confiável
// (trusted internal architectural boundary), NÃO criptografia: não protegem contra
// código que controle o mesmo processo. Determinístico, sem rede (fetch substituído),
// sem .env; dados fictícios (example.test) e tokens de teste obviamente falsos.

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');

const authBarrel = require('../../src/auth');
const authorizationContextModule = require('../../src/auth/authorizationContext');
const userResolverModule = require('../../src/auth/userResolver');
const userModule = require('../../src/auth/user');
const constantsModule = require('../../src/auth/constants');
const bridgeModule = require('../../src/auth/approvalQueueBridge');
const authAdapterModule = require('../../src/auth/authAdapter');
const {
  ROLE,
  USER_STATUS,
  PERMISSION,
  USER_NOT_FOUND,
  USER_RESOLUTION_ERROR,
  UserResolutionError,
  CONNECTIVITY_ERROR,
  SupabaseAdapterError,
  defineUser,
  createUserStore,
  resolveAuthorizationContext,
  requireActiveUser,
  hasPermission,
  createSupabaseAuthAdapter,
} = authBarrel;
const { FAKE_ENV, isIssuedAuthorizationContext, verifiedIdentitiesFor, jsonResponse } = require('../helpers/authFixtures');

function userInput(overrides = {}) {
  return {
    userId: 'user-hard-1',
    authUserId: 'auth-hard-1',
    name: 'Usuário Hard',
    email: 'hard1@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  };
}

const resolutionError = (code) => (error) => error instanceof UserResolutionError && error.code === code;

// ===========================================================================
// [HARD-1] Fronteira 5 — o único caminho público até um AuthorizationContext
// ===========================================================================
// O que já existia (CTXT-7/8) confere NOMES exportados. Isto confere COMPORTAMENTO: cada
// função pública exportada por src/auth (e cada método de um store) é chamada com um
// conjunto grande de entradas — lixo, objetos simples, USERs definidos, USERs sem vínculo,
// USERs inativos, uma VerifiedIdentity real, um store real — e NENHUMA pode devolver um
// AuthorizationContext emitido, exceto resolveAuthorizationContext(store real que contém o
// USER, VerifiedIdentity real). Um contexto emitido não entra no conjunto de entradas: senão
// as funções que apenas devolvem o que recebem (requirePermission) seriam falsos positivos.
test('[HARD-1] nenhuma função pública, com nenhuma entrada, produz um AuthorizationContext — exceto resolveAuthorizationContext(store real com o USER, VerifiedIdentity real)', async (t) => {
  const [identidade, outraIdentidade] = await verifiedIdentitiesFor(t, [
    { authUserId: 'auth-hard-1', email: 'hard1@example.test' },
    { authUserId: 'auth-hard-2', email: 'hard2@example.test' },
  ]);
  const usuario = defineUser(userInput());
  const semVinculo = defineUser(userInput({ userId: 'user-hard-sv', authUserId: null }));
  const inativo = defineUser(userInput({ userId: 'user-hard-in', authUserId: 'auth-hard-in', status: USER_STATUS.INACTIVE }));
  const lojaReal = createUserStore([usuario]);

  const entradas = [
    ['undefined', undefined],
    ['null', null],
    ['texto vazio', ''],
    ['texto', 'auth-hard-1'],
    ['número', 0],
    ['objeto vazio', {}],
    ['lista', []],
    ['função', () => {}],
    ['VerifiedIdentity real', identidade],
    ['outra VerifiedIdentity real', outraIdentidade],
    ['identidade literal com os campos certos', { authUserId: 'auth-hard-1', email: 'hard1@example.test', emailConfirmed: true }],
    ['USER definido', usuario],
    ['USER definido sem vínculo', semVinculo],
    ['USER definido inativo', inativo],
    ['USER literal (cópia)', { ...usuario }],
    ['contexto literal', { userId: 'u', authUserId: 'auth-hard-1', name: 'n', role: ROLE.ADMIN, permissions: [...constantsModule.ADMIN_PERMISSIONS], status: USER_STATUS.ACTIVE }],
    ['store real com o USER', lojaReal],
    ['store real vazio', createUserStore([])],
  ];

  // A superfície pública: funções exportadas pelo barrel e pelos módulos de src/auth, e os métodos de um store.
  const modulos = {
    'src/auth (barrel)': authBarrel,
    'authorizationContext.js': authorizationContextModule,
    'userResolver.js': userResolverModule,
    'user.js': userModule,
    'constants.js': constantsModule,
    'approvalQueueBridge.js': bridgeModule,
    'authAdapter.js': authAdapterModule,
  };
  const superficie = new Map();
  for (const [modulo, exportados] of Object.entries(modulos)) {
    for (const [nome, valor] of Object.entries(exportados)) {
      if (typeof valor === 'function' && !superficie.has(valor)) superficie.set(valor, `${modulo}::${nome}`);
    }
  }
  for (const [nome, valor] of Object.entries(createUserStore([usuario]))) {
    if (typeof valor === 'function') superficie.set(valor, `createUserStore()::${nome}`);
  }

  // Um AuthorizationContext emitido, ou dentro de um valor devolvido (até 3 níveis).
  const contemContexto = (valor, profundidade = 3, vistos = new Set()) => {
    if (isIssuedAuthorizationContext(valor)) return true;
    if (profundidade === 0 || typeof valor !== 'object' || valor === null || vistos.has(valor)) return false;
    vistos.add(valor);
    return Object.values(valor).some((interno) => contemContexto(interno, profundidade - 1, vistos));
  };

  const tuplas = [[], ...entradas.map((entrada) => [entrada]), ...entradas.flatMap((a) => entradas.map((b) => [a, b]))];
  let chamadas = 0;
  let emissoesLegitimas = 0;
  const emissoesIndevidas = [];
  for (const [funcao, nome] of superficie) {
    for (const tupla of tuplas) {
      const valores = tupla.map(([, valor]) => valor);
      let resultado;
      try {
        resultado = funcao(...valores);
      } catch {
        continue; // recusar é o esperado para quase todas as entradas
      }
      chamadas += 1;
      if (!contemContexto(resultado)) continue;
      const legitima = funcao === userResolverModule.resolveAuthorizationContext && valores[0] === lojaReal && valores[1] === identidade;
      if (legitima) emissoesLegitimas += 1;
      else emissoesIndevidas.push(`${nome}(${tupla.map(([rotulo]) => rotulo).join(', ')})`);
    }
  }

  assert.deepEqual(emissoesIndevidas, [], `funções públicas que produziram um AuthorizationContext fora do caminho do resolver:\n${emissoesIndevidas.join('\n')}`);
  assert.ok(emissoesLegitimas >= 1, 'o teste enxergou a emissão legítima — não é vazio');
  assert.ok(superficie.size >= 15, `a varredura cobriu ${superficie.size} funções`);
  assert.ok(chamadas > 1000, `a varredura fez ${chamadas} chamadas que não lançaram`);
});

// ===========================================================================
// [HARD-2] Fronteira 6, item 9 — o access token não vaza em nenhuma vista do erro
// ===========================================================================
// Os testes ERRO-1 e ERRO-4 olham só err.message. Aqui o token é repetido duas vezes na
// mensagem que o SDK/servidor devolveria (pega um scrub que troque só a primeira ocorrência)
// e o erro é examinado por todas as vistas: message, stack, String(erro), JSON com as
// propriedades próprias, util.inspect com propriedades ocultas e a cadeia `cause`. Uma
// linha "para depurar" como `{ cause: err }` no verifyAccessToken faria o token aparecer.
const TOKEN = 'token-de-teste-nao-real.hard-payload-9f3a.hard-sig-77b1'; // placeholder óbvio, NÃO é um token real
const PEDACOS_DO_TOKEN = [TOKEN, ...TOKEN.split('.')];

function assertSemToken(erro, rotulo) {
  const causas = [];
  for (let causa = erro.cause; causa; causa = causa.cause) causas.push(causa);
  const vistas = {
    message: String(erro.message),
    stack: String(erro.stack),
    texto: String(erro),
    json: JSON.stringify(erro, Object.getOwnPropertyNames(erro)),
    inspecao: util.inspect(erro, { depth: null, showHidden: true, breakLength: Infinity }),
    'cause (mensagens e stacks)': causas.map((causa) => `${causa.message} ${causa.stack}`).join(' '),
  };
  for (const [vista, texto] of Object.entries(vistas)) {
    for (const pedaco of PEDACOS_DO_TOKEN) {
      assert.equal(texto.includes(pedaco), false, `${rotulo}: "${pedaco}" apareceu em ${vista}`);
    }
  }
}

test('[HARD-2] o access token não aparece em nenhuma vista do erro (message, stack, texto, JSON, inspect, cause), em nenhum caminho de falha', async (t) => {
  let resposta;
  t.mock.method(globalThis, 'fetch', async () => resposta());

  const cenarios = [
    ['HTTP 403 (token inválido), token repetido na mensagem', CONNECTIVITY_ERROR.AUTH, () => jsonResponse({ code: 403, error_code: 'bad_jwt', msg: `invalid JWT ${TOKEN} e de novo ${TOKEN}` }, 403)],
    ['HTTP 401 (expirado), token na mensagem', CONNECTIVITY_ERROR.AUTH, () => jsonResponse({ code: 401, error_code: 'bad_jwt', msg: `token expirado ${TOKEN} / ${TOKEN}` }, 401)],
    ['HTTP 500 (servidor), token na mensagem', CONNECTIVITY_ERROR.NETWORK, () => jsonResponse({ code: 500, error_code: 'unexpected_failure', msg: `falha ${TOKEN} / ${TOKEN}` }, 500)],
    ['HTTP 505 (não retentável), token na mensagem', CONNECTIVITY_ERROR.UNKNOWN, () => jsonResponse({ code: 505, error_code: 'unexpected_failure', msg: `versão ${TOKEN} / ${TOKEN}` }, 505)],
    [
      'falha de rede cuja mensagem contém o token',
      CONNECTIVITY_ERROR.NETWORK,
      () => {
        throw new TypeError(`fetch failed (Authorization: Bearer ${TOKEN}) ${TOKEN}`);
      },
    ],
    ['HTTP 200 sem usuário', CONNECTIVITY_ERROR.AUTH, () => jsonResponse({}, 200)],
    ['HTTP 200 com usuário sem id', CONNECTIVITY_ERROR.AUTH, () => jsonResponse({ email: 'sem-id@example.test', aud: 'authenticated' }, 200)],
  ];
  for (const [rotulo, categoria, montarResposta] of cenarios) {
    resposta = montarResposta;
    const adapter = createSupabaseAuthAdapter({ ...FAKE_ENV });
    await assert.rejects(
      () => adapter.verifyAccessToken(`  ${TOKEN}  `), // com espaços: o adapter aparava o token antes de usar
      (erro) => {
        assert.ok(erro instanceof SupabaseAdapterError, `${rotulo}: esperava SupabaseAdapterError, veio ${erro && erro.name}`);
        assert.equal(erro.category, categoria, rotulo);
        assertSemToken(erro, rotulo);
        return true;
      }
    );
  }

  // Exceção lançada pelo próprio SDK (não devolvida como erro), com o token na mensagem.
  const adapter = createSupabaseAuthAdapter({ ...FAKE_ENV });
  t.mock.method(adapter.getClient().auth, 'getUser', async () => {
    throw new Error(`explosão interna com ${TOKEN} e de novo ${TOKEN}`);
  });
  await assert.rejects(
    () => adapter.verifyAccessToken(TOKEN),
    (erro) => {
      assert.equal(erro.category, CONNECTIVITY_ERROR.SDK);
      assertSemToken(erro, 'exceção do SDK');
      return true;
    }
  );
});

// ===========================================================================
// [HARD-3] Fronteira 6 — o caminho legado por sessão nunca vira identidade verificada
// ===========================================================================
// O RES-8 prova que um LITERAL com o formato de resolveAuthenticatedIdentity() é recusado.
// Aqui é a SAÍDA REAL dessa função, com uma sessão presente no cliente: se um dia ela
// passar a ser marcada como verificada, só este teste denuncia.
test('[HARD-3] resolveAuthenticatedIdentity e getSessionStatus (caminho por sessão) nunca produzem uma identidade verificada — mesmo com sessão presente e USER cadastrado — e o resolver a recusa', async (t) => {
  const adapter = createSupabaseAuthAdapter({ ...FAKE_ENV });
  t.mock.method(adapter.getClient().auth, 'getSession', async () => ({
    data: { session: { user: { id: 'auth-hard-legado', email: 'legado@example.test' } } },
    error: null,
  }));
  const rede = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('o caminho por sessão não deveria ir à rede');
  });

  const legado = await adapter.resolveAuthenticatedIdentity();
  assert.deepEqual(legado, { authUserId: 'auth-hard-legado', email: 'legado@example.test' });
  const status = await adapter.getSessionStatus();
  assert.deepEqual(status, { authenticated: true, authUserId: 'auth-hard-legado', email: 'legado@example.test' });

  // O USER do authUserId existe — a recusa vem da falta da marca, não da falta de USER.
  const loja = createUserStore([defineUser(userInput({ userId: 'user-hard-legado', authUserId: 'auth-hard-legado', email: 'legado@example.test' }))]);
  for (const [rotulo, identidade] of [['saída de resolveAuthenticatedIdentity()', legado], ['saída de getSessionStatus()', status]]) {
    assert.equal(authAdapterModule.isVerifiedIdentity(identidade), false, rotulo);
    assert.throws(() => resolveAuthorizationContext(loja, identidade), resolutionError(USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED), rotulo);
  }
  assert.equal(rede.mock.callCount(), 0, 'nenhuma chamada de rede');
});

// ===========================================================================
// [HARD-4] Fronteira 9 — nenhuma permissão extra ou faltante entra em um USER
// ===========================================================================
const ADMIN_LITERAL = ['READ:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'WRITE:CRM', 'PROPOSE:LEAD_APPROVAL', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL', 'MANAGE:USERS'];
const CLOSER_LITERAL = ['READ:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL'];

test('[HARD-4] nenhuma permissão extra, faltante ou de outra role entra em um USER — ADMIN e CLOSER, uma a uma', () => {
  const naoPodemDiferir = /não podem diferir das permissions da role/;
  // Permissões de formato válido e ação reconhecida, mas FORA da matriz atual (o USER-2 só cobre duplicatas para o ADMIN).
  const foraDaMatriz = ['DELETE:CRM', 'EXECUTE:CRM', 'SEND:CRM', 'PUBLISH:CRM', 'MANAGE:CRM', 'APPROVE:BILLING', 'READ:USERS', 'WRITE:USERS', 'DELETE:USERS'];
  for (const extra of foraDaMatriz) {
    assert.throws(() => defineUser(userInput({ role: ROLE.ADMIN, permissions: [...ADMIN_LITERAL, extra] })), naoPodemDiferir, `ADMIN + ${extra}`);
    assert.throws(() => defineUser(userInput({ role: ROLE.ADMIN, permissions: [extra] })), naoPodemDiferir, `ADMIN só com ${extra}`);
    assert.throws(() => defineUser(userInput({ role: ROLE.COMMERCIAL_CLOSER, permissions: [...CLOSER_LITERAL, extra] })), naoPodemDiferir, `CLOSER + ${extra}`);
  }

  // CLOSER + cada permissão que só o ADMIN tem (as administrativas).
  for (const administrativa of ADMIN_LITERAL.filter((permissao) => !CLOSER_LITERAL.includes(permissao))) {
    assert.throws(() => defineUser(userInput({ role: ROLE.COMMERCIAL_CLOSER, permissions: [...CLOSER_LITERAL, administrativa] })), naoPodemDiferir, `CLOSER + ${administrativa}`);
    // trocar uma das dele pela administrativa (mesma contagem)
    assert.throws(() => defineUser(userInput({ role: ROLE.COMMERCIAL_CLOSER, permissions: [...CLOSER_LITERAL.slice(1), administrativa] })), naoPodemDiferir, `CLOSER com ${administrativa} no lugar de uma`);
  }

  // Permissões INCOMPLETAS: tirar cada uma, individualmente, de cada role.
  for (const [role, canonica] of [[ROLE.ADMIN, ADMIN_LITERAL], [ROLE.COMMERCIAL_CLOSER, CLOSER_LITERAL]]) {
    for (const ausente of canonica) {
      assert.throws(() => defineUser(userInput({ role, permissions: canonica.filter((permissao) => permissao !== ausente) })), naoPodemDiferir, `${role} sem ${ausente}`);
    }
  }

  // Permissões FALSIFICADAS (formato inválido, curinga) e role desconhecida ou SYSTEM continuam recusadas.
  for (const falsificada of ['*:*', '*', 'ADMIN', 'read:crm', 'READ:crm', 'READ:CRM ', ':CRM', 'READ:', 'FLY:CRM']) {
    assert.throws(() => defineUser(userInput({ role: ROLE.ADMIN, permissions: [falsificada] })), /permissions/, `permissions [${falsificada}]`);
    assert.throws(() => defineUser(userInput({ role: ROLE.ADMIN, permissions: [...ADMIN_LITERAL, falsificada] })), /permissions/, `ADMIN + ${falsificada}`);
  }
  for (const role of ['SYSTEM', 'SUPER_ADMIN', 'CLOSER', 'admin', '', undefined, null, 'constructor']) {
    assert.throws(() => defineUser(userInput({ role })), /role desconhecida/, `role ${String(role)}`);
  }

  // As permissões efetivas de um USER definido são SEMPRE as da role — e o array é uma cópia congelada.
  for (const [role, canonica] of [[ROLE.ADMIN, ADMIN_LITERAL], [ROLE.COMMERCIAL_CLOSER, CLOSER_LITERAL]]) {
    const usuario = defineUser(userInput({ role }));
    assert.deepEqual([...usuario.permissions].sort(), [...canonica].sort(), `${role}: exatamente o conjunto canônico`);
    assert.equal(Object.isFrozen(usuario.permissions), true);
    assert.equal(usuario.permissions.includes('*:*'), false, 'nenhum curinga');
    assert.equal(usuario.permissions.includes(PERMISSION.MANAGE_USERS), role === ROLE.ADMIN, 'MANAGE:USERS é só do ADMIN');
  }
});

// ===========================================================================
// [HARD-5] Fronteira 7 — a tabela de decisão da resolução de USER
// ===========================================================================
// Uma tabela única, legível, do contrato que a Fase D estabeleceu (cada linha também é
// coberta em detalhe pelos testes RES-*; aqui está a especificação junta).
test('[HARD-5] tabela de decisão da resolução de USER: identidade verificada + USER, USER inexistente, identidade falsa, authUserId diferente, USER inativo, USER sem authUserId', async (t) => {
  const [idA, idSemUser, idInativo] = await verifiedIdentitiesFor(t, [
    { authUserId: 'auth-hard-A', email: 'hard-a@example.test' },
    { authUserId: 'auth-hard-sem-user', email: 'sem-user@example.test' },
    { authUserId: 'auth-hard-inativo', email: 'inativo@example.test' },
  ]);
  const usuarioA = defineUser(userInput({ userId: 'user-hard-A', authUserId: 'auth-hard-A', email: 'hard-a@example.test', role: ROLE.COMMERCIAL_CLOSER }));
  const usuarioInativo = defineUser(userInput({ userId: 'user-hard-inativo', authUserId: 'auth-hard-inativo', email: 'inativo@example.test', status: USER_STATUS.INACTIVE }));
  const loja = createUserStore([usuarioA, usuarioInativo]);

  // 1) identidade verificada + USER existente -> o contexto é o desse USER, com as permissões da role.
  const contexto = resolveAuthorizationContext(loja, idA);
  assert.equal(isIssuedAuthorizationContext(contexto), true);
  assert.equal(contexto.userId, 'user-hard-A');
  assert.equal(contexto.authUserId, 'auth-hard-A');
  assert.equal(contexto.role, ROLE.COMMERCIAL_CLOSER);
  assert.deepEqual([...contexto.permissions].sort(), [...CLOSER_LITERAL].sort());

  // 2) identidade verificada + USER inexistente -> USER_NOT_FOUND (e nenhum USER é criado).
  assert.throws(() => resolveAuthorizationContext(loja, idSemUser), resolutionError(USER_NOT_FOUND));
  assert.equal(loja.all().length, 2, 'nenhum USER foi criado');

  // 3) identidade falsa -> IDENTITY_NOT_VERIFIED, mesmo com o authUserId e o e-mail de um USER real.
  const falsas = [
    ['literal', { authUserId: 'auth-hard-A', email: 'hard-a@example.test', emailConfirmed: true }],
    ['cópia', { ...idA }],
    ['cópia congelada', Object.freeze({ ...idA })],
    ['structuredClone', structuredClone(idA)],
    ['Object.create', Object.create(idA)],
    ['Proxy', new Proxy(idA, {})],
  ];
  for (const [rotulo, falsa] of falsas) {
    assert.throws(() => resolveAuthorizationContext(loja, falsa), resolutionError(USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED), rotulo);
  }
  for (const naoIdentidade of [undefined, null, '', 'auth-hard-A', 42, [], () => {}]) {
    assert.throws(() => resolveAuthorizationContext(loja, naoIdentidade), resolutionError(USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED));
  }

  // 4) authUserId diferente -> USER_NOT_FOUND: o e-mail igual, o nome e a role nunca substituem o authUserId.
  const soOutroUsuario = createUserStore([usuarioInativo]);
  assert.throws(() => resolveAuthorizationContext(soOutroUsuario, idA), resolutionError(USER_NOT_FOUND));
  const mesmoEmailOutroId = defineUser(userInput({ userId: 'user-hard-mesmo-email', authUserId: 'auth-hard-outro-id', email: 'hard-a@example.test' }));
  assert.throws(() => resolveAuthorizationContext(createUserStore([mesmoEmailOutroId]), idA), resolutionError(USER_NOT_FOUND));

  // 5) USER inativo -> o contexto é emitido com status INACTIVE (comportamento atual) e a AÇÃO é recusada.
  const contextoInativo = resolveAuthorizationContext(loja, idInativo);
  assert.equal(contextoInativo.status, USER_STATUS.INACTIVE);
  assert.throws(() => requireActiveUser(contextoInativo), /usuário inativo/);
  assert.equal(hasPermission(contextoInativo, PERMISSION.READ_CRM), false);

  // 6) USER sem authUserId -> não entra no store operacional (e, portanto, não emite contexto).
  const semVinculo = defineUser(userInput({ userId: 'user-hard-sv', authUserId: null }));
  assert.throws(() => createUserStore([semVinculo]), resolutionError(USER_RESOLUTION_ERROR.USER_NOT_OPERATIONAL));
  assert.throws(() => loja.add(semVinculo), resolutionError(USER_RESOLUTION_ERROR.USER_NOT_OPERATIONAL));
});
