// TESTES DE INTEGRAÇÃO EXTERNA — Supabase Auth REAL (somente leitura). NÃO fazem parte do `npm test`.
//
// Estes são os testes que ANTES viviam em tests/auth/supabase-integration.test.js e tests/auth/identity-verification.test.js e podiam consultar o Supabase Auth real quando o `.env` do
// desenvolvedor era carregado pelo `npm test`. Foram MOVIDOS para cá sem alterar nenhuma asserção: a suíte comum (`npm test`) agora roda com um guarda hermético
// (tests/setup/hermetic.js) que remove as credenciais do ambiente e bloqueia qualquer acesso externo — ela nunca fala com um serviço real.
//
// COMO EXECUTAR (só com autorização explícita e configuração própria):
//   1. tenha um `.env` com SUPABASE_URL e SUPABASE_ANON_KEY do ambiente que você autoriza consultar (e, para o [REAL-2], RIO_X7_TEST_ACCESS_TOKEN de um usuário de TESTE);
//   2. defina RIO_X7_RUN_EXTERNAL_TESTS=1 e rode `npm run test:integration`
//        PowerShell:  $env:RIO_X7_RUN_EXTERNAL_TESTS = '1'; npm run test:integration
//        Bash:        RIO_X7_RUN_EXTERNAL_TESTS=1 npm run test:integration
// Sem a variável, todos os testes deste arquivo são PULADOS (nunca marcados como passando sem terem sido exercitados). Nenhum valor de URL, chave ou token é impresso; nada é escrito no Supabase.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSupabaseConfigured, createSupabaseAuthAdapter, SupabaseAdapterError, CONNECTIVITY_ERROR } = require('../../src/auth');

const AUTORIZADO = process.env.RIO_X7_RUN_EXTERNAL_TESTS === '1';
const configurado = isSupabaseConfigured(process.env);

// O portão de autorização: sem RIO_X7_RUN_EXTERNAL_TESTS=1 o teste é pulado de forma explícita.
function autorizado(t) {
  if (AUTORIZADO) return true;
  t.skip('INTEGRAÇÃO EXTERNA não autorizada: defina RIO_X7_RUN_EXTERNAL_TESTS=1 (e as credenciais próprias) para executar — ver o cabeçalho deste arquivo');
  return false;
}

// (copiado, sem alteração, de tests/auth/identity-verification.test.js) o erro esperado de uma recusa do adapter, por categoria
const expectError = (category, messageRe) => (err) => {
  assert.ok(err instanceof SupabaseAdapterError, `esperava SupabaseAdapterError, veio ${err && err.name}`);
  assert.equal(err.category, category);
  if (messageRe) assert.match(err.message, messageRe);
  return true;
};

test('NETWORK: checkConnectivity classifica corretamente um host inalcançável (não precisa de configuração real)', async (t) => {
  if (!autorizado(t)) return;
  const adapter = createSupabaseAuthAdapter({
    SUPABASE_URL: 'https://projeto-que-nao-existe-rio-x7-teste-0009-8.supabase.co',
    SUPABASE_ANON_KEY: 'chave-de-teste-nao-real',
  });
  const resultado = await adapter.checkConnectivity();
  assert.equal(resultado.status, CONNECTIVITY_ERROR.NETWORK);
});

test('conectividade real com o projeto Supabase configurado (só executa se .env estiver carregado)', async (t) => {
  if (!autorizado(t)) return;
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
  if (!autorizado(t)) return;
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
  if (!autorizado(t)) return;
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
  if (!autorizado(t)) return;
  if (!configurado) {
    t.skip('SUPABASE_URL/SUPABASE_ANON_KEY ausentes neste ambiente — NÃO VERIFICADO aqui');
    return;
  }
  const adapter = createSupabaseAuthAdapter(process.env);
  await assert.rejects(() => adapter.resolveAuthenticatedIdentity(), /nenhuma sessão autenticada/);
});

test('[REAL-1] token deliberadamente inválido contra o Supabase real é rejeitado como AUTH (só executa com .env carregado)', async (t) => {
  if (!autorizado(t)) return;
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
  if (!autorizado(t)) return;
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
