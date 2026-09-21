// Primeira fronteira REAL de autenticação: authAdapter.verifyAccessToken().
//
// Testes unitários: o SDK REAL do Supabase roda contra um `fetch` falso
// (instalado ANTES de o adapter criar o cliente — o SDK captura o `fetch`
// global na criação), então a interpretação de respostas HTTP reais é
// exercitada sem rede. Nenhum teste unitário toca o Supabase.
//
// Testes de integração real (no fim): só leitura (GET /auth/v1/user). O teste
// com token REAL só executa se RIO_X7_TEST_ACCESS_TOKEN estiver definido no
// ambiente; caso contrário fica explicitamente PENDENTE (skip) — nenhum token
// é inventado. Nenhum valor de token/URL/chave é impresso.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROLE,
  USER_STATUS,
  ROLE_PERMISSION_TEMPLATE,
  defineUser,
  createUserStore,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
} = require('../../src/auth');

const FAKE_ENV = Object.freeze({ SUPABASE_URL: 'https://exemplo.supabase.co', SUPABASE_ANON_KEY: 'chave-de-teste-nao-real' });
const TOKEN = 'token-de-teste-nao-real.parte-b.parte-c'; // placeholder óbvio, NÃO é um token real
const AUTH_ID = '00000000-0000-4000-8000-00000000000a'; // UUID fictício

function newAdapter() {
  return createSupabaseAuthAdapter({ ...FAKE_ENV });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function userBody(overrides = {}) {
  return {
    id: AUTH_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'usuario-teste@example.test',
    email_confirmed_at: '2026-01-01T00:00:00.123456Z',
    phone: '',
    confirmed_at: '2026-01-01T00:00:00.123456Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Instala um fetch falso; DEVE ser chamado antes de criar/usar o cliente do adapter.
function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({
      url: String(url),
      method: String((init && init.method) || 'GET').toUpperCase(),
      headers: new Headers((init && init.headers) || {}),
    });
    return handler(String(url), init);
  });
  return calls;
}

// Espiona auth.getUser do cliente do adapter. Para entrada inválida o SDK NÃO pode nem ser chamado:
// com jwt falsy (ex.: '') o getUser() do SDK cai para a SESSÃO do cliente, que não é prova de
// identidade — por isso a guarda do adapter precisa barrar a entrada antes de chegar ao SDK.
function spyGetUser(t, adapter) {
  return t.mock.method(adapter.getClient().auth, 'getUser', async () => {
    throw new Error('getUser não deveria ser chamado para entrada inválida');
  });
}

const expectError = (category, messageRe) => (err) => {
  assert.ok(err instanceof SupabaseAdapterError, `esperava SupabaseAdapterError, veio ${err && err.name}`);
  assert.equal(err.category, category);
  if (messageRe) assert.match(err.message, messageRe);
  return true;
};

// ===========================================================================
// Validação de entrada — nenhuma chamada de rede para entradas inválidas
// ===========================================================================
test('[TOKEN-1] token ausente é rejeitado como AUTH, sem nenhuma chamada de rede e sem chamar o SDK', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();
  const getUser = spyGetUser(t, adapter);
  const guarda = /ausente, vazio ou não é uma string/;
  await assert.rejects(() => adapter.verifyAccessToken(), expectError(CONNECTIVITY_ERROR.AUTH, guarda));
  await assert.rejects(() => adapter.verifyAccessToken(undefined), expectError(CONNECTIVITY_ERROR.AUTH, guarda));
  await assert.rejects(() => adapter.verifyAccessToken(null), expectError(CONNECTIVITY_ERROR.AUTH, guarda));
  assert.equal(calls.length, 0);
  assert.equal(getUser.mock.callCount(), 0);
});

test('[TOKEN-2] token vazio ou só espaços é rejeitado como AUTH, sem nenhuma chamada de rede e sem chamar o SDK', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();
  const getUser = spyGetUser(t, adapter);
  for (const vazio of ['', '   ', '\n\t ']) {
    await assert.rejects(() => adapter.verifyAccessToken(vazio), expectError(CONNECTIVITY_ERROR.AUTH, /ausente, vazio ou não é uma string/));
  }
  assert.equal(calls.length, 0);
  assert.equal(getUser.mock.callCount(), 0);
});

test('[TOKEN-3] token que não é string é rejeitado como AUTH, sem nenhuma chamada de rede e sem chamar o SDK', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();
  const getUser = spyGetUser(t, adapter);
  const naoStrings = [123, true, {}, [], () => TOKEN, { accessToken: TOKEN }, [TOKEN], Buffer.from(TOKEN)];
  for (const valor of naoStrings) {
    await assert.rejects(() => adapter.verifyAccessToken(valor), expectError(CONNECTIVITY_ERROR.AUTH, /ausente, vazio ou não é uma string/));
  }
  assert.equal(calls.length, 0);
  assert.equal(getUser.mock.callCount(), 0);
});

test('[TOKEN-4] sem SUPABASE_URL/ANON_KEY, mesmo um token bem formado gera erro CONFIGURACAO (nunca uma identidade)', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(userBody()));
  const adapter = createSupabaseAuthAdapter({});
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.CONFIGURACAO));
  assert.equal(calls.length, 0);
});

// ===========================================================================
// Interpretação da resposta do Supabase
// ===========================================================================
test('[RESP-1] resposta sem user (SDK devolve user nulo, ou corpo vazio) é AUTH — nunca uma identidade', async (t) => {
  const adapter = newAdapter();
  const client = adapter.getClient();
  t.mock.method(client.auth, 'getUser', async () => ({ data: { user: null }, error: null }));
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.AUTH, /não devolveu nenhum usuário/));

  client.auth.getUser.mock.mockImplementation(async () => ({ data: null, error: null }));
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.AUTH, /não devolveu nenhum usuário/));

  client.auth.getUser.mock.mockImplementation(async () => undefined);
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.AUTH));
});

test('[RESP-2] resposta HTTP 200 com corpo sem id de usuário é AUTH (o SDK a entrega como user sem id)', async (t) => {
  mockFetch(t, () => jsonResponse({}));
  const adapter = newAdapter();
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.AUTH, /sem user\.id válido/));
});

test('[RESP-3] user.id ausente, vazio ou não-string é AUTH', async (t) => {
  const adapter = newAdapter();
  const client = adapter.getClient();
  t.mock.method(client.auth, 'getUser', async () => ({ data: { user: { id: '', email: 'a@example.test' } }, error: null }));
  for (const id of ['', '   ', undefined, null, 123, {}]) {
    client.auth.getUser.mock.mockImplementation(async () => ({ data: { user: { id, email: 'a@example.test' } }, error: null }));
    await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.AUTH, /sem user\.id válido/));
  }
});

test('[RESP-4] sem user.id, nenhum outro campo (sub, user_metadata, identities) é usado como authUserId', async (t) => {
  const corpo = userBody({
    sub: 'sub-forjado',
    user_metadata: { sub: 'sub-metadata-forjado', user_id: 'user-id-metadata-forjado', authUserId: 'authUserId-metadata-forjado' },
    identities: [{ id: 'identity-id-forjado', user_id: 'identity-user-id-forjado', identity_data: { sub: 'identity-sub-forjado' } }],
  });
  delete corpo.id;
  mockFetch(t, () => jsonResponse(corpo));
  const adapter = newAdapter();
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.AUTH, /sem user\.id válido/));
});

test('[ERRO-1] erro retornado pelo Supabase (token inválido: HTTP 403 bad_jwt, formato observado no Supabase real) é AUTH, com status e código, sem vazar o token', async (t) => {
  mockFetch(t, () =>
    jsonResponse(
      { code: 403, error_code: 'bad_jwt', msg: `invalid JWT: unable to parse or verify signature, token is malformed (${TOKEN})` },
      403
    )
  );
  const adapter = newAdapter();
  await assert.rejects(
    () => adapter.verifyAccessToken(TOKEN),
    (err) => {
      expectError(CONNECTIVITY_ERROR.AUTH, /HTTP 403, bad_jwt/)(err);
      assert.equal(err.message.includes(TOKEN), false, 'o access token nunca deve aparecer na mensagem de erro');
      assert.match(err.message, /\[token omitido\]/);
      return true;
    }
  );
});

test('[ERRO-2] token expirado (HTTP 401) e sessão encerrada (HTTP 403) são AUTH', async (t) => {
  let status = 401;
  mockFetch(t, () =>
    status === 401
      ? jsonResponse({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT: token has invalid claims: token is expired' }, 401)
      : jsonResponse({ code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' }, 403)
  );
  const adapter = newAdapter();
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.AUTH, /expired/));
  status = 403;
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.AUTH));
});

test('[ERRO-3] falha de rede é NETWORK — nunca um veredito sobre o token e nunca uma identidade', async (t) => {
  mockFetch(t, () => {
    throw new TypeError('fetch failed');
  });
  const adapter = newAdapter();
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.NETWORK));
});

test('[ERRO-3b] indisponibilidade do servidor (HTTP 500/502/503/504) é NETWORK: o SDK a trata como falha de infraestrutura, não como token inválido', async (t) => {
  let status = 500;
  mockFetch(t, () => jsonResponse({ code: status, error_code: 'unexpected_failure', msg: 'erro interno' }, status));
  const adapter = newAdapter();
  for (status of [500, 502, 503, 504]) {
    await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.NETWORK), `HTTP ${status}`);
  }
});

test('[ERRO-3c] erro 5xx que o SDK não trata como retentável (ex.: HTTP 505) é UNKNOWN — ainda assim falha fechada, sem identidade', async (t) => {
  mockFetch(t, () => jsonResponse({ code: 505, error_code: 'unexpected_failure', msg: 'versão http não suportada' }, 505));
  const adapter = newAdapter();
  await assert.rejects(() => adapter.verifyAccessToken(TOKEN), expectError(CONNECTIVITY_ERROR.UNKNOWN, /HTTP 505/));
});

test('[ERRO-4] exceção inesperada do SDK é categorizada como SDK, sem vazar o token', async (t) => {
  const adapter = newAdapter();
  const client = adapter.getClient();
  t.mock.method(client.auth, 'getUser', async () => {
    throw new Error(`explosão interna com ${TOKEN}`);
  });
  await assert.rejects(
    () => adapter.verifyAccessToken(TOKEN),
    (err) => {
      expectError(CONNECTIVITY_ERROR.SDK)(err);
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    }
  );
});

// ===========================================================================
// Identidade verificada: e-mail e confirmação vêm SÓ do Supabase
// ===========================================================================
test('[ID-1] usuário COM e-mail: devolve authUserId, email e emailConfirmed, exatamente estes 3 campos', async (t) => {
  mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();
  const identidade = await adapter.verifyAccessToken(TOKEN);
  assert.deepEqual(identidade, { authUserId: AUTH_ID, email: 'usuario-teste@example.test', emailConfirmed: true });
  assert.deepEqual(Object.keys(identidade).sort(), ['authUserId', 'email', 'emailConfirmed']);
  assert.equal(Object.isFrozen(identidade), true);
});

test('[ID-2] usuário SEM e-mail (ex.: só telefone): email é null e emailConfirmed é false, mesmo que exista email_confirmed_at', async (t) => {
  const variantes = [{ email: undefined }, { email: null }, { email: '' }, { email: '   ' }, { email: 42 }];
  let corpo = userBody();
  mockFetch(t, () => jsonResponse(corpo));
  const adapter = newAdapter();
  for (const v of variantes) {
    corpo = userBody(v);
    if (v.email === undefined) delete corpo.email;
    const identidade = await adapter.verifyAccessToken(TOKEN);
    assert.equal(identidade.authUserId, AUTH_ID);
    assert.equal(identidade.email, null);
    assert.equal(identidade.emailConfirmed, false);
  }
});

test('[ID-3] e-mail CONFIRMADO: emailConfirmed é true (timestamps com e sem fração de segundo)', async (t) => {
  let corpo = userBody();
  mockFetch(t, () => jsonResponse(corpo));
  const adapter = newAdapter();
  for (const ts of ['2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.5+00:00']) {
    corpo = userBody({ email_confirmed_at: ts });
    assert.equal((await adapter.verifyAccessToken(TOKEN)).emailConfirmed, true, ts);
  }
});

test('[ID-4] e-mail NÃO confirmado: emailConfirmed é false (ausente, nulo, vazio ou lixo não vira confirmação)', async (t) => {
  let corpo = userBody();
  mockFetch(t, () => jsonResponse(corpo));
  const adapter = newAdapter();
  for (const v of [null, '', '   ', 'true', 'sim', 'nao-e-uma-data', 12345, {}]) {
    corpo = userBody({ email_confirmed_at: v });
    const identidade = await adapter.verifyAccessToken(TOKEN);
    assert.equal(identidade.email, 'usuario-teste@example.test');
    assert.equal(identidade.emailConfirmed, false, `valor ${JSON.stringify(v)} não pode contar como confirmado`);
  }
  corpo = userBody();
  delete corpo.email_confirmed_at;
  assert.equal((await adapter.verifyAccessToken(TOKEN)).emailConfirmed, false);
});

test('[ID-6] sem user.email, o e-mail NÃO é buscado em user_metadata nem em identities: fica null', async (t) => {
  const corpo = userBody({
    user_metadata: { email: 'forjado-metadata@example.test', email_verified: true },
    identities: [{ identity_data: { email: 'forjado-identity@example.test', email_verified: true } }],
  });
  delete corpo.email;
  mockFetch(t, () => jsonResponse(corpo));
  const adapter = newAdapter();
  const identidade = await adapter.verifyAccessToken(TOKEN);
  assert.equal(identidade.authUserId, AUTH_ID);
  assert.equal(identidade.email, null);
  assert.equal(identidade.emailConfirmed, false);
});

test('[ID-5] confirmação vem só de email_confirmed_at: confirmed_at e user_metadata.email_verified não contam', async (t) => {
  mockFetch(t, () =>
    jsonResponse(
      userBody({ email_confirmed_at: null, confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { email_verified: true } })
    )
  );
  const adapter = newAdapter();
  assert.equal((await adapter.verifyAccessToken(TOKEN)).emailConfirmed, false);
});

// ===========================================================================
// Como a verificação acontece de fato (servidor, sem sessão, somente leitura)
// ===========================================================================
test('[REQ-1] faz UMA requisição GET /auth/v1/user com o token em Authorization e a chave anon em apikey — nenhuma escrita', async (t) => {
  const calls = mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();
  await adapter.verifyAccessToken(`  ${TOKEN}  `); // espaços nas pontas são removidos
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(new URL(calls[0].url).origin, 'https://exemplo.supabase.co');
  assert.equal(new URL(calls[0].url).pathname, '/auth/v1/user');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(calls[0].headers.get('apikey'), FAKE_ENV.SUPABASE_ANON_KEY);
});

test('[REQ-2] nunca confia em getSession() e nunca grava sessão no cliente compartilhado', async (t) => {
  mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();
  const client = adapter.getClient();
  t.mock.method(client.auth, 'getSession', async () => {
    throw new Error('getSession() não pode ser usado como prova de identidade');
  });

  const identidade = await adapter.verifyAccessToken(TOKEN);
  assert.equal(identidade.authUserId, AUTH_ID);
  assert.equal(client.auth.getSession.mock.callCount(), 0);

  // O token verificado não "vazou" para o cliente em cache: o próximo consumidor não herda a sessão.
  client.auth.getSession.mock.restore();
  assert.deepEqual(await adapter.getSessionStatus(), { authenticated: false });
});

test('[REQ-3] só devolve os 3 campos mínimos: role/permissions/metadata vindos do Supabase nunca viram identidade', async (t) => {
  mockFetch(t, () =>
    jsonResponse(
      userBody({
        role: 'ADMIN',
        app_metadata: { provider: 'email', role: 'ADMIN', permissions: ['MANAGE:USERS'], status: 'ACTIVE' },
        user_metadata: { role: 'ADMIN', permissions: ['MANAGE:USERS'], status: 'ACTIVE', userId: 'forjado', email: 'forjado@example.test' },
      })
    )
  );
  const adapter = newAdapter();
  const identidade = await adapter.verifyAccessToken(TOKEN);
  assert.deepEqual(Object.keys(identidade).sort(), ['authUserId', 'email', 'emailConfirmed']);
  assert.equal(identidade.email, 'usuario-teste@example.test', 'o e-mail vem de user.email, nunca de user_metadata.email');
  for (const proibido of ['role', 'permissions', 'status', 'userId', 'name']) {
    assert.equal(Object.prototype.hasOwnProperty.call(identidade, proibido), false, `${proibido} não pode existir na identidade verificada`);
  }
});

// ===========================================================================
// Segurança: o chamador NUNCA fabrica a identidade
// ===========================================================================
test('[SEC-1] authUserId fornecido pelo chamador nunca é aceito como identidade', async (t) => {
  mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();

  // Como 2º argumento: ignorado. A identidade vem do Supabase.
  const identidade = await adapter.verifyAccessToken(TOKEN, { authUserId: 'authUserId-forjado-pelo-chamador' });
  assert.equal(identidade.authUserId, AUTH_ID);
  assert.notEqual(identidade.authUserId, 'authUserId-forjado-pelo-chamador');

  // Como parte de um objeto no lugar do token: não é string, portanto rejeitado.
  await assert.rejects(
    () => adapter.verifyAccessToken({ accessToken: TOKEN, authUserId: 'authUserId-forjado-pelo-chamador' }),
    expectError(CONNECTIVITY_ERROR.AUTH)
  );
  assert.equal(adapter.verifyAccessToken.length, 1, 'a função só declara o parâmetro accessToken');
});

test('[SEC-2] email fornecido pelo chamador nunca é aceito como identidade', async (t) => {
  mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();

  const identidade = await adapter.verifyAccessToken(TOKEN, { email: 'admin-forjado@example.test', emailConfirmed: true });
  assert.equal(identidade.email, 'usuario-teste@example.test');
  assert.notEqual(identidade.email, 'admin-forjado@example.test');

  await assert.rejects(
    () => adapter.verifyAccessToken({ accessToken: TOKEN, email: 'admin-forjado@example.test' }),
    expectError(CONNECTIVITY_ERROR.AUTH)
  );
});

test('[SEC-3] nenhum objeto USER (nem role/permissions/status) fabrica ou influencia a identidade verificada', async (t) => {
  mockFetch(t, () => jsonResponse(userBody()));
  const adapter = newAdapter();
  const admin = defineUser({
    userId: 'user-admin-forjado',
    authUserId: 'auth-admin-forjado',
    name: 'Admin Forjado',
    email: 'admin-forjado@example.test',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  });
  const store = createUserStore([admin]); // existe um USER com o e-mail/authUserId forjados

  // Um USER no lugar do token: rejeitado (não é string).
  await assert.rejects(() => adapter.verifyAccessToken(admin), expectError(CONNECTIVITY_ERROR.AUTH));
  await assert.rejects(() => adapter.verifyAccessToken(store), expectError(CONNECTIVITY_ERROR.AUTH));

  // Um USER como argumento extra: ignorado; a identidade continua sendo a do Supabase.
  const identidade = await adapter.verifyAccessToken(TOKEN, admin, store, { role: ROLE.ADMIN, permissions: ['MANAGE:USERS'], status: 'ACTIVE' });
  assert.equal(identidade.authUserId, AUTH_ID);
  assert.equal(identidade.email, 'usuario-teste@example.test');
  assert.equal(Object.prototype.hasOwnProperty.call(identidade, 'role'), false);
});

test('[SEC-4] o adapter não importa USER/resolver/AuthorizationContext, não usa getSession() para verificar e não cria contexto', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'auth', 'authAdapter.js'), 'utf8');
  const semComentarios = fonte.replace(/\/\/.*$/gm, '');

  assert.doesNotMatch(semComentarios, /require\(\s*['"]\.\/(user|userResolver|authorizationContext|approvalQueueBridge|constants)['"]\s*\)/);
  assert.doesNotMatch(semComentarios, /createAuthorizationContext|resolveAuthorizationContext|defineUser|createUserStore/);

  const inicio = semComentarios.indexOf('async function verifyAccessToken');
  const fim = semComentarios.indexOf('async function resolveAuthenticatedIdentity');
  assert.ok(inicio > 0 && fim > inicio, 'delimitadores da função encontrados');
  const corpo = semComentarios.slice(inicio, fim);
  assert.doesNotMatch(corpo, /getSession|setSession|signIn|signUp|signOut|refreshSession/);
  assert.match(corpo, /getUser\(\s*token\s*\)/);
});

// ===========================================================================
// Integração REAL — somente leitura (GET /auth/v1/user). Nenhuma escrita.
// ===========================================================================
const configurado = isSupabaseConfigured(process.env);

test('[REAL-1] token deliberadamente inválido contra o Supabase real é rejeitado como AUTH (só executa com .env carregado)', async (t) => {
  if (!configurado) {
    t.skip('SUPABASE_URL/SUPABASE_ANON_KEY ausentes neste ambiente — NÃO VERIFICADO aqui');
    return;
  }
  const adapter = createSupabaseAuthAdapter(process.env);
  await assert.rejects(() => adapter.verifyAccessToken('token-invalido-de-proposito-nao-e-um-jwt'), expectError(CONNECTIVITY_ERROR.AUTH));
  assert.deepEqual(await adapter.getSessionStatus(), { authenticated: false }, 'nenhuma sessão foi criada no cliente');
});

// PENDENTE / CONDICIONAL: exige um access token REAL, de curta duração, de um
// usuário de TESTE, fornecido pela variável de ambiente RIO_X7_TEST_ACCESS_TOKEN.
// Hoje essa variável NÃO existe, então o teste é explicitamente pulado — nenhum
// token é inventado. Nada do token/identidade é impresso.
test('[REAL-2] token REAL (RIO_X7_TEST_ACCESS_TOKEN) resulta em identidade verificada pelo Supabase real — PENDENTE se a variável não existir', async (t) => {
  const tokenReal = process.env.RIO_X7_TEST_ACCESS_TOKEN;
  if (!configurado || typeof tokenReal !== 'string' || tokenReal.trim() === '') {
    t.skip('PENDENTE: defina RIO_X7_TEST_ACCESS_TOKEN (access token real, curta duração, usuário de TESTE) para executar');
    return;
  }
  const adapter = createSupabaseAuthAdapter(process.env);
  const identidade = await adapter.verifyAccessToken(tokenReal);

  assert.deepEqual(Object.keys(identidade).sort(), ['authUserId', 'email', 'emailConfirmed']);
  assert.equal(typeof identidade.authUserId, 'string');
  assert.ok(identidade.authUserId.length > 0);
  assert.ok(identidade.email === null || typeof identidade.email === 'string');
  assert.equal(typeof identidade.emailConfirmed, 'boolean');
  assert.deepEqual(await adapter.getSessionStatus(), { authenticated: false }, 'verificar o token não cria sessão no cliente');
});
