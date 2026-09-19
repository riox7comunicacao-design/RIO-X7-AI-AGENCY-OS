// Passo 0009.8, Fase B — integração real com Supabase Auth.
//
// Este arquivo assume dois estados possíveis do ambiente, e se comporta
// corretamente em ambos, sem nunca fingir um resultado:
//
// 1) SUPABASE_URL/SUPABASE_ANON_KEY carregados de um .env real (dev local,
//    quando configurado) — os testes de conectividade real RODAM de fato
//    contra o projeto Supabase configurado, sem criar nada (só leitura).
// 2) Nenhuma configuração presente (clone novo, CI sem segredos) — os
//    mesmos testes são pulados explicitamente (t.skip), nunca marcados
//    como "passando" sem terem sido de fato exercitados.
//
// Nenhum valor de SUPABASE_URL/SUPABASE_ANON_KEY é impresso em nenhum
// teste — só PRESENTE/AUSENTE (booleano) ou o resultado classificado de uma
// chamada (status HTTP, categoria de erro), nunca o conteúdo da variável.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLE,
  USER_STATUS,
  PERMISSION,
  ROLE_PERMISSION_TEMPLATE,
  defineUser,
  createUserStore,
  resolveAuthorizationContext,
  isSupabaseConfigured,
  createSupabaseAuthAdapter,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
} = require('../../src/auth');

const configurado = isSupabaseConfigured(process.env);

test('configuração real do ambiente: SUPABASE_URL/SUPABASE_ANON_KEY (nenhum valor exibido, só presença)', () => {
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'PRESENTE' : 'AUSENTE');
  console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'PRESENTE' : 'AUSENTE');
  console.log('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'PRESENTE (não utilizada por este módulo)' : 'AUSENTE');
  // Sem asserção de valor fixo aqui — este teste só documenta o estado real
  // do ambiente em que a suíte está rodando, de forma segura para logs.
  assert.equal(typeof isSupabaseConfigured(process.env), 'boolean');
});

test('CONFIGURACAO: adapter sem nenhuma variável de ambiente nunca finge estar configurado', () => {
  const adapter = createSupabaseAuthAdapter({});
  assert.equal(adapter.isConfigured(), false);
  assert.throws(() => adapter.getClient(), /CONFIGURACAO|Supabase não configurado/);
});

test('CONFIGURACAO: checkConnectivity classifica corretamente a ausência de configuração, sem tentar rede', async () => {
  const adapter = createSupabaseAuthAdapter({});
  const resultado = await adapter.checkConnectivity();
  assert.equal(resultado.status, CONNECTIVITY_ERROR.CONFIGURACAO);
});

test('NETWORK: checkConnectivity classifica corretamente um host inalcançável (não precisa de configuração real)', async () => {
  const adapter = createSupabaseAuthAdapter({
    SUPABASE_URL: 'https://projeto-que-nao-existe-rio-x7-teste-0009-8.supabase.co',
    SUPABASE_ANON_KEY: 'chave-de-teste-nao-real',
  });
  const resultado = await adapter.checkConnectivity();
  assert.equal(resultado.status, CONNECTIVITY_ERROR.NETWORK);
});

test('CONFIGURACAO: SUPABASE_URL malformada é rejeitada pelo próprio SDK ao criar o cliente', () => {
  const adapter = createSupabaseAuthAdapter({ SUPABASE_URL: 'nao-e-uma-url', SUPABASE_ANON_KEY: 'x' });
  assert.throws(() => adapter.getClient(), /CONFIGURACAO|inválid/);
});

test('conectividade real com o projeto Supabase configurado (só executa se .env estiver carregado)', async (t) => {
  if (!configurado) {
    t.skip('SUPABASE_URL/SUPABASE_ANON_KEY ausentes neste ambiente — NÃO VERIFICADO aqui, ver docs/decisions/0011-supabase-auth-integration.md');
    return;
  }
  const adapter = createSupabaseAuthAdapter(process.env);

  // Cliente inicializado = SIM (não lança).
  const client = adapter.getClient();
  assert.ok(client, 'cliente Supabase deveria ser criado com sucesso');
  assert.equal(typeof client.auth.getSession, 'function');

  // Conectividade REAL — usa o endpoint público /auth/v1/settings
  // (somente leitura). getSession() sozinho NÃO prova rede (resolve
  // localmente mesmo com URL inexistente, verificado durante este passo) —
  // por isso checkConnectivity() é a checagem que de fato importa aqui.
  const conectividade = await adapter.checkConnectivity();
  assert.equal(conectividade.status, 'OK', `esperava conectividade OK, obteve: ${JSON.stringify(conectividade)}`);
});

test('AUTH: chave inválida contra o host real configurado é classificada como AUTH, não como sucesso (só executa se .env estiver carregado)', async (t) => {
  if (!configurado) {
    t.skip('SUPABASE_URL ausente neste ambiente — NÃO VERIFICADO aqui');
    return;
  }
  const adapter = createSupabaseAuthAdapter({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: 'chave-deliberadamente-invalida-para-teste',
  });
  const resultado = await adapter.checkConnectivity();
  assert.equal(resultado.status, CONNECTIVITY_ERROR.AUTH);
});

test('D — getSession() nunca é tratado como erro quando não há sessão (só executa se .env estiver carregado)', async (t) => {
  if (!configurado) {
    t.skip('SUPABASE_URL/SUPABASE_ANON_KEY ausentes neste ambiente — NÃO VERIFICADO aqui');
    return;
  }
  const adapter = createSupabaseAuthAdapter(process.env);
  const status = await adapter.getSessionStatus();
  assert.equal(status.authenticated, false, 'nenhuma sessão foi criada por este passo — ausência de sessão é o resultado esperado (D), não um erro');
});

// B — sessão inexistente → resolveAuthenticatedIdentity() rejeita explicitamente,
// nunca inventa uma identidade.
test('B — resolveAuthenticatedIdentity() rejeita explicitamente quando não há sessão (só executa se .env estiver carregado)', async (t) => {
  if (!configurado) {
    t.skip('SUPABASE_URL/SUPABASE_ANON_KEY ausentes neste ambiente — NÃO VERIFICADO aqui');
    return;
  }
  const adapter = createSupabaseAuthAdapter(process.env);
  await assert.rejects(() => adapter.resolveAuthenticatedIdentity(), /nenhuma sessão autenticada/);
});

// C — authUserId desconhecido (mesmo com o "formato" de um UUID real que o
// Supabase emitiria) nunca é transformado em usuário — userResolver
// continua em memória, e uma identidade Supabase-shaped sem USER
// correspondente é rejeitada explicitamente (equivalente a USER_NOT_FOUND).
test('C — identidade autenticada (formato Supabase) sem USER correspondente é rejeitada, nunca inventada', () => {
  const storeVazio = createUserStore([]);
  assert.throws(
    () => resolveAuthorizationContext(storeVazio, { authUserId: '4b6f6a1e-9c2d-4a3b-8e7f-000000000000', email: 'desconhecido@example.test' }),
    /não encontrado/
  );
});

// D/E — authUserId de CLOSER/ADMIN resolve para o USER correto (já coberto
// em profundidade por tests/auth/security-attacks.test.js, Ataques O-1/O-6;
// repetido aqui no contexto específico de "identidade vinda do Supabase"
// para deixar a ponte auth Adapter -> userResolver explicitamente coberta).
test('D/E — authUserId simulando uma identidade real do Supabase resolve para o role correto (CLOSER e ADMIN)', () => {
  const admin = defineUser({
    userId: 'user-admin-supabase',
    authUserId: 'auth-admin-supabase-uuid',
    name: 'Admin Real',
    email: 'admin-real@example.test',
    role: ROLE.ADMIN,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.ADMIN],
    status: USER_STATUS.ACTIVE,
  });
  const closer = defineUser({
    userId: 'user-closer-supabase',
    authUserId: 'auth-closer-supabase-uuid',
    name: 'Closer Real',
    email: 'closer-real@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.COMMERCIAL_CLOSER],
    status: USER_STATUS.ACTIVE,
  });
  const store = createUserStore([admin, closer]);

  const contextoAdmin = resolveAuthorizationContext(store, { authUserId: 'auth-admin-supabase-uuid' });
  const contextoCloser = resolveAuthorizationContext(store, { authUserId: 'auth-closer-supabase-uuid' });

  assert.equal(contextoAdmin.role, ROLE.ADMIN);
  assert.equal(contextoCloser.role, ROLE.COMMERCIAL_CLOSER);
  assert.equal(contextoCloser.permissions.includes(PERMISSION.MANAGE_USERS), false);
});

// F — USER INACTIVE, mesmo vindo de uma identidade autenticada real,
// continua bloqueado (mesmo comportamento já garantido por
// requireActiveUser — repetido aqui no contexto de identidade vinda do
// Supabase, não de um objeto montado à mão).
test('F — USER INACTIVE vindo de uma identidade Supabase-shaped continua bloqueado em ações sensíveis', () => {
  const { requirePermission } = require('../../src/auth');
  const inactive = defineUser({
    userId: 'user-closer-supabase-inactive',
    authUserId: 'auth-closer-supabase-inactive-uuid',
    name: 'Closer Inativo',
    email: 'closer-inativo@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.COMMERCIAL_CLOSER],
    status: USER_STATUS.INACTIVE,
  });
  const store = createUserStore([inactive]);
  const contexto = resolveAuthorizationContext(store, { authUserId: 'auth-closer-supabase-inactive-uuid' });
  assert.throws(() => requirePermission(contexto, PERMISSION.APPROVE_LEAD_APPROVAL), /inativo/);
});

// G — "frontend" tentando enviar um role diferente ao resolver —
// resolveAuthorizationContext só aceita { authUserId, email }; um "role"
// extra é ignorado pela desestruturação, nunca sobrepõe o role real do USER
// armazenado (reforça Ataque O-5 de security-attacks.test.js, agora no
// contexto explícito de "dado vindo do frontend").
test('[G] resolveAuthorizationContext ignora um "role" fornecido pelo chamador — sempre usa o role do USER armazenado', () => {
  const closer = defineUser({
    userId: 'user-closer-frontend-g',
    authUserId: 'auth-closer-frontend-g',
    name: 'Closer Teste G',
    email: 'closer-frontend-g@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.COMMERCIAL_CLOSER],
    status: USER_STATUS.ACTIVE,
  });
  const store = createUserStore([closer]);

  const context = resolveAuthorizationContext(store, {
    authUserId: 'auth-closer-frontend-g',
    role: ROLE.ADMIN, // tentativa de "se passar" por ADMIN via dado externo
  });

  assert.equal(context.role, ROLE.COMMERCIAL_CLOSER);
});

// H — "frontend" tentando enviar permissions diferentes ao resolver — mesma
// proteção estrutural: a assinatura da função não tem espaço para isso.
test('[H] resolveAuthorizationContext ignora "permissions" fornecidas pelo chamador — sempre usa as permissions do USER armazenado', () => {
  const closer = defineUser({
    userId: 'user-closer-frontend-h',
    authUserId: 'auth-closer-frontend-h',
    name: 'Closer Teste H',
    email: 'closer-frontend-h@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    permissions: ROLE_PERMISSION_TEMPLATE[ROLE.COMMERCIAL_CLOSER],
    status: USER_STATUS.ACTIVE,
  });
  const store = createUserStore([closer]);

  const context = resolveAuthorizationContext(store, {
    authUserId: 'auth-closer-frontend-h',
    permissions: [PERMISSION.MANAGE_USERS, 'APPROVE:FINANCIAL_APPROVAL'], // tentativa de injeção
  });

  assert.deepEqual([...context.permissions].sort(), [...ROLE_PERMISSION_TEMPLATE[ROLE.COMMERCIAL_CLOSER]].sort());
  assert.equal(context.permissions.includes(PERMISSION.MANAGE_USERS), false);
});

// I/J/K — CLOSER exato (sem MANAGE:USERS, com APPROVE:LEAD_APPROVAL e
// APPROVE:OUTBOUND_APPROVAL) já coberto exaustivamente em
// tests/auth/authorization.test.js e tests/auth/security-attacks.test.js —
// não duplicado aqui.

// L — AI não vira HUMAN: nenhuma função de impersonation existe no módulo
// de autenticação. Verificação direta dos exports (mesmo padrão já usado
// em approvalQueue.test.js, teste [Q]).
test('L — nenhuma função de impersonation (loginAI/asUser/assumeRole/impersonateAdmin ou equivalente) existe em src/auth', () => {
  const authModule = require('../../src/auth');
  const authAdapterModule = require('../../src/auth/authAdapter');
  const userResolverModule = require('../../src/auth/userResolver');

  const todosOsNomes = [...Object.keys(authModule), ...Object.keys(authAdapterModule), ...Object.keys(userResolverModule)]
    .join(' ')
    .toLowerCase();

  assert.doesNotMatch(todosOsNomes, /loginai|asuser|assumerole|impersonate|fakeuser|mockidentity/);
});

// M — ausência de configuração Supabase → erro explícito (já coberto acima
// por "CONFIGURACAO: adapter sem nenhuma variável..."). Reforço direto do
// item M da lista do passo:
test('M — ausência de configuração produz erro explícito e corretamente categorizado (CONFIGURACAO), nunca uma sessão fabricada', async () => {
  const adapter = createSupabaseAuthAdapter({});
  const ehErroDeConfiguracao = (err) => err instanceof SupabaseAdapterError && err.category === CONNECTIVITY_ERROR.CONFIGURACAO;
  assert.throws(() => adapter.getClient(), ehErroDeConfiguracao);
  await assert.rejects(() => adapter.resolveAuthenticatedIdentity(), ehErroDeConfiguracao);
});

// N — nenhuma credencial aparece em nenhum teste deste arquivo: confirmação
// manual, não automatizável de forma significativa — todo valor usado
// acima é um placeholder óbvio ("chave-de-teste-nao-real",
// "chave-deliberadamente-invalida-para-teste") ou um resultado classificado
// (status HTTP, categoria de erro). Nenhum teste imprime
// process.env.SUPABASE_URL/SUPABASE_ANON_KEY — só o booleano de presença.
