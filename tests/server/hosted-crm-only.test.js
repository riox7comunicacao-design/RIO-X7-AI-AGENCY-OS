// A INSTÂNCIA HOSPEDADA — "crm-only" (Fase WEB 1, decisão 0033), sobre a composição REAL de produção (src/server/index.js createServer) em REPOSITORY_MODE=supabase.
//
// Prova: só o CRM Comercial funciona (login/identidade, Clientes, catálogos, funis, negociações, RBAC); a Approval Queue, a promoção, a prospecção, os briefs, os jobs, os leads reprovados e as
// exclusões respondem MODULE_DISABLED a QUALQUER método e ANTES da autenticação; o health check é público e mínimo; o HTTP é redirecionado/recusado; os cabeçalhos de internet (HSTS, sem CORS)
// estão lá; o limitador de falhas freia quem insiste com sessões inválidas; os erros e os logs não vazam token, chave nem dado pessoal; e um "reinício" (nova composição) enxerga o que o
// Supabase guardou. O modo local padrão não muda (conferido no fim).
//
// Nenhuma rede real: UM `fetch` falso global roteia o Supabase Auth e o PostgREST para os falsos da suíte (estado trocado por teste). Dados fictícios (example.test); credenciais FALSAS.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { FAKE_ENV, fakeAccessToken, supabaseUserBody } = require('../helpers/authFixtures');
const { postgrestCrm } = require('../helpers/fakePostgrestCrmList');
const { createFakePostgrestCatalogs } = require('../helpers/fakePostgrestCatalogs');
const { criarPostgrestComercial } = require('../helpers/fakePostgrestCommercial');

const CHAVE_SERVICO = 'chave-de-servico-falsa-so-para-teste-hospedado';
const ORIGEM = 'https://crm.exemplo.test';
const ADMIN = { userId: 'user-admin-teste', authUserId: 'auth-admin-teste', name: 'Admin Teste', email: 'admin-teste@example.test', role: 'ADMIN', status: 'ACTIVE' };
const CLOSER = { userId: 'user-closer-teste', authUserId: 'auth-closer-teste', name: 'Closer Teste', email: 'closer-teste@example.test', role: 'COMMERCIAL_CLOSER', status: 'ACTIVE' };
const INATIVO = { userId: 'user-inativo-teste', authUserId: 'auth-inativo-teste', name: 'Inativo Teste', email: 'inativo-teste@example.test', role: 'COMMERCIAL_CLOSER', status: 'INACTIVE' };
const SEM_ACESSO = { authUserId: 'auth-sem-acesso-teste', email: 'sem-acesso-teste@example.test' }; // existe no Supabase Auth, mas NÃO na lista de usuários da aplicação
const USUARIOS = [ADMIN, CLOSER, INATIVO];
const TOKENS = { [ADMIN.userId]: fakeAccessToken('admin'), [CLOSER.userId]: fakeAccessToken('closer'), [INATIVO.userId]: fakeAccessToken('inativo'), semAcesso: fakeAccessToken('sem-acesso') };

// ---------------------------------------------------------------------------
// O fetch falso (um só, para o arquivo inteiro: os repositórios Supabase capturam o fetch na criação)
// ---------------------------------------------------------------------------
const rede = { crm: null, catalogs: null, commercial: null, autenticacoes: 0, restChamadas: 0, inesperadas: [], falharRest: false };
const corposAuth = new Map([
  [TOKENS[ADMIN.userId], supabaseUserBody({ authUserId: ADMIN.authUserId, email: ADMIN.email })],
  [TOKENS[CLOSER.userId], supabaseUserBody({ authUserId: CLOSER.authUserId, email: CLOSER.email })],
  [TOKENS[INATIVO.userId], supabaseUserBody({ authUserId: INATIVO.authUserId, email: INATIVO.email })],
  [TOKENS.semAcesso, supabaseUserBody({ authUserId: SEM_ACESSO.authUserId, email: SEM_ACESSO.email })],
]);
const jsonResponse = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

function novoMundo() {
  rede.crm = postgrestCrm();
  rede.catalogs = createFakePostgrestCatalogs({ url: FAKE_ENV.SUPABASE_URL, serviceRoleKey: CHAVE_SERVICO });
  rede.commercial = criarPostgrestComercial();
  rede.autenticacoes = 0;
  rede.restChamadas = 0;
  rede.inesperadas = [];
  rede.falharRest = false;
}

test.before(() => {
  test.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/auth/v1/user') {
      rede.autenticacoes += 1;
      const token = (new Headers(init.headers || {}).get('authorization') || '').replace(/^Bearer\s+/i, '');
      return corposAuth.has(token) ? jsonResponse(corposAuth.get(token)) : jsonResponse({ code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }, 403);
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      rede.restChamadas += 1;
      if (rede.falharRest) throw new TypeError(`fetch failed: ${url} chave=${CHAVE_SERVICO}`);
      const alvo = u.pathname.slice('/rest/v1/'.length);
      if (alvo === 'crm_records') return rede.crm.fetchImpl(url, init);
      if (alvo === 'crm_services' || alvo === 'crm_niches' || alvo === 'crm_lead_origins' || alvo === 'rpc/reorder_crm_catalog') return rede.catalogs.fetchImpl(url, init);
      return rede.commercial.fetchImpl(url, init);
    }
    rede.inesperadas.push(`${init.method || 'GET'} ${u.host}${u.pathname}`);
    throw new Error(`requisição inesperada: ${u.host}${u.pathname}`);
  });
});
test.after(() => test.mock.restoreAll());

// ---------------------------------------------------------------------------
// A composição de produção em modo hospedado
// ---------------------------------------------------------------------------
const envHospedado = (extra = {}) => ({
  ...FAKE_ENV,
  SUPABASE_SERVICE_ROLE_KEY: CHAVE_SERVICO,
  REPOSITORY_MODE: 'supabase',
  RIO_X7_DEPLOYMENT_MODE: 'crm-only',
  RIO_X7_PUBLIC_URL: ORIGEM,
  RIO_X7_USERS_JSON: JSON.stringify(USUARIOS.map(({ userId, authUserId, name, email, role, status }) => ({ userId, authUserId, name, email, role, status }))),
  ...extra,
});

function requisicao({ method = 'GET', url = '/', headers = {}, body, token }) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries({ ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }).map(([k, v]) => [k.toLowerCase(), v]));
  return req;
}

function montar(t, { env = envHospedado(), now } = {}) {
  novoMundo();
  const logs = [];
  const { createServer } = require('../../src/server/index');
  const composicao = createServer(env, { log: (linha) => logs.push(linha), ...(now ? { now } : {}) });
  t.after(() => composicao.server.close());
  const chamar = async (quem, method, url, body, headers = {}) => {
    const token = quem === null || quem === undefined ? undefined : typeof quem === 'string' ? quem : TOKENS[quem.userId];
    const resposta = await composicao.app.handle(requisicao({ method, url, token, body, headers }));
    let json = null;
    try {
      json = JSON.parse(resposta.body);
    } catch {
      // sem corpo JSON
    }
    return { status: resposta.status, headers: resposta.headers, text: resposta.body, json };
  };
  return { ...composicao, chamar, logs };
}

// ===========================================================================
// O que funciona: login/identidade, CRM, catálogos, funis, negociações
// ===========================================================================
test('[HOSTED-1] a instância sobe só com o CRM: a composição não cria nenhum módulo de arquivo e informa o modo', (t) => {
  const s = montar(t);
  assert.equal(s.deploymentMode, 'crm-only');
  assert.equal(s.permanentExclusionsMode, undefined, 'sem guarda de promoção: não há promoção');
  assert.equal(s.usersCount, 3, 'os usuários vieram de RIO_X7_USERS_JSON');
  assert.equal(rede.autenticacoes + rede.restChamadas, 0, 'montar não fala com o Supabase (tudo é preguiçoso)');
});

test('[HOSTED-2] login/identidade: o token do Supabase vira a identidade da lista de usuários; sem token, token inválido, conta sem usuário e usuário inativo são recusados', async (t) => {
  const s = montar(t);
  const eu = await s.chamar(ADMIN, 'GET', '/api/me');
  assert.equal(eu.status, 200);
  assert.deepEqual([eu.json.userId, eu.json.role, eu.json.status], [ADMIN.userId, 'ADMIN', 'ACTIVE']);
  assert.ok(eu.json.permissions.includes('READ:CRM'));
  assert.equal((await s.chamar(CLOSER, 'GET', '/api/me')).json.role, 'COMMERCIAL_CLOSER');

  assert.equal((await s.chamar(null, 'GET', '/api/me')).status, 401);
  assert.equal((await s.chamar('token-que-ninguem-emitiu', 'GET', '/api/me')).status, 401);
  const semAcesso = await s.chamar(TOKENS.semAcesso, 'GET', '/api/me');
  assert.equal(semAcesso.status, 403, 'conta autêntica no Supabase mas fora da lista de usuários');
  assert.equal(semAcesso.json.error.code, 'NO_ACCESS');
  assert.equal((await s.chamar(INATIVO, 'GET', '/api/me')).status, 403, 'usuário inativo');
});

test('[HOSTED-3] CRM de ponta a ponta no Supabase: criar cliente PJ e PF, listar e ler; a persistência é a tabela do Supabase, não a memória do servidor', async (t) => {
  const s = montar(t);
  const pj = await s.chamar(ADMIN, 'POST', '/api/crm', { tipoPessoa: 'PJ', empresa: 'Clínica Aurora Teste', contato: 'Ana Lima', cnpj: '11222333000181' });
  assert.equal(pj.status, 201, pj.text);
  assert.equal((await s.chamar(CLOSER, 'POST', '/api/crm', { tipoPessoa: 'PF', nomeCompleto: 'Não Grava Teste', cpf: '52998224725' })).status, 403, 'closer lê e propõe, mas não grava registros do CRM (WRITE:CRM é do ADMIN)');
  const pf = await s.chamar(ADMIN, 'POST', '/api/crm', { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza Teste', cpf: '52998224725' });
  assert.equal(pf.status, 201, pf.text);
  const lista = await s.chamar(ADMIN, 'GET', '/api/crm');
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.json.items.map((i) => i.tipoPessoa).sort(), ['PF', 'PJ']);
  assert.equal(rede.crm.tabela.size, 2, 'as duas linhas estão na tabela falsa do Supabase');
  const um = await s.chamar(ADMIN, 'GET', `/api/crm/${encodeURIComponent(pj.json.item.id)}`);
  assert.equal(um.status, 200);
  assert.equal(um.json.item.empresa, 'Clínica Aurora Teste');
});

test('[HOSTED-4] catálogos, funis e negociações respondem sobre o Supabase; RBAC: quem não é ADMIN não administra catálogos e a leitura do CRM continua permitida', async (t) => {
  const s = montar(t);
  const nicho = await s.chamar(ADMIN, 'POST', '/api/crm-catalogs/nichos', { nome: 'Psicologia Teste' });
  assert.equal(nicho.status, 201, nicho.text);
  assert.equal((await s.chamar(CLOSER, 'POST', '/api/crm-catalogs/nichos', { nome: 'Outro Teste' })).status, 403, 'closer não administra catálogos (MANAGE:CRM_CATALOGS é do ADMIN)');
  const ativos = await s.chamar(CLOSER, 'GET', '/api/crm-catalogs/nichos');
  assert.equal(ativos.status, 200, ativos.text);
  assert.deepEqual(ativos.json.items.map((i) => i.nome), ['Psicologia Teste']);
  assert.equal((await s.chamar(CLOSER, 'GET', '/api/crm-catalogs/nichos?todos=1')).status, 403, 'ver desativados também é administrativo');

  const funis = await s.chamar(ADMIN, 'GET', '/api/funnels');
  assert.equal(funis.status, 200, funis.text);
  assert.equal((await s.chamar(CLOSER, 'POST', '/api/funnels', { nome: 'Funil Teste' })).status, 403, 'criar funil exige MANAGE:FUNNELS (ADMIN)');
  for (const url of ['/api/funnel-board', '/api/negotiations', '/api/negotiations/summary']) {
    const r = await s.chamar(CLOSER, 'GET', url);
    assert.equal(r.status, 200, `${url}: ${r.text}`);
  }
  assert.deepEqual(rede.inesperadas, []);
});

test('[HOSTED-5] toda rota do CRM exige sessão: sem token, 401 — e a recusa acontece antes de qualquer acesso ao banco', async (t) => {
  const s = montar(t);
  const rotas = [
    ['GET', '/api/me'], ['GET', '/api/crm'], ['POST', '/api/crm'], ['GET', '/api/crm/x'], ['PATCH', '/api/crm/x'], ['DELETE', '/api/crm/x'], ['GET', '/api/crm/x/history'], ['POST', '/api/crm/x/status'],
    ['GET', '/api/crm-catalogs/servicos'], ['POST', '/api/crm-catalogs/nichos'], ['GET', '/api/funnels'], ['POST', '/api/funnels'], ['GET', '/api/funnel-board'], ['GET', '/api/funnel-cards/x'],
    ['GET', '/api/negotiations'], ['POST', '/api/negotiations'], ['GET', '/api/negotiations/summary'], ['POST', '/api/negotiations/x/win'],
  ];
  for (const [method, url] of rotas) {
    const r = await s.chamar(null, method, url, method === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${url}`);
    assert.equal(r.json.error.code, 'UNAUTHENTICATED');
  }
  assert.equal(rede.restChamadas, 0, 'nenhuma consulta ao PostgREST sem sessão');
});

// ===========================================================================
// O que NÃO existe: os módulos de arquivo local
// ===========================================================================
const ROTAS_DESATIVADAS = [
  ['GET', '/api/approvals'], ['GET', '/api/approvals?estado=APROVADO_PARA_CRM'], ['POST', '/api/approvals/x/approve'], ['POST', '/api/approvals/x/reject'], ['POST', '/api/approvals/x/promote'],
  ['POST', '/api/prospecting/submit'], ['GET', '/api/prospecting/batches'], ['GET', '/api/prospecting/batches/b1'],
  ['GET', '/api/prospecting/briefs'], ['POST', '/api/prospecting/briefs'], ['GET', '/api/prospecting/briefs/b1'], ['POST', '/api/prospecting/briefs/b1/ready'], ['POST', '/api/prospecting/briefs/b1/package'], ['POST', '/api/prospecting/briefs/b1/findings'],
  ['GET', '/api/prospecting/jobs'], ['POST', '/api/prospecting/jobs'], ['GET', '/api/prospecting/jobs/j1/status'], ['POST', '/api/prospecting/jobs/j1/cancel'], ['POST', '/api/prospecting/jobs/j1/redo'],
  ['GET', '/api/prospecting/exclusions'], ['POST', '/api/prospecting/exclusions'], ['PATCH', '/api/prospecting/exclusions/e1'], ['POST', '/api/prospecting/exclusions/e1/activate'],
  ['GET', '/api/leads/reprovados'], ['POST', '/api/leads/reprovados/l1/reaprovar'], ['GET', '/api/leads/l1/perfil'], ['GET', '/api/leads/l1/completar-pesquisa'], ['POST', '/api/leads/l1/completar-pesquisa'], ['POST', '/api/leads/l1/rever-site'], ['POST', '/api/leads/l1/proposta-site'],
];

test('[HOSTED-6] Approval Queue, promoção, prospecção, briefs, jobs, leads e exclusões: 404 MODULE_DISABLED a QUALQUER método, com ou sem sessão, ANTES da autenticação e sem tocar no banco', async (t) => {
  const s = montar(t);
  for (const [method, url] of ROTAS_DESATIVADAS) {
    for (const quem of [null, ADMIN, 'token-invalido']) {
      const r = await s.chamar(quem, method, url, method === 'GET' ? undefined : {});
      assert.equal(r.status, 404, `${method} ${url} (${quem && quem.userId ? 'admin' : quem})`);
      assert.deepEqual(r.json, { error: { code: 'MODULE_DISABLED', message: 'Este módulo não está disponível nesta instalação.' } });
    }
  }
  // métodos que nem existem nessas rotas também são recusados como módulo desativado (nunca 405 nem 401 que denunciem a rota)
  for (const method of ['OPTIONS', 'DELETE', 'PUT', 'PATCH', 'HEAD']) {
    const r = await s.chamar(ADMIN, method, '/api/prospecting/briefs');
    assert.equal(r.status, 404, method);
  }
  assert.equal(rede.autenticacoes, 0, 'nenhuma verificação de token: a recusa vem antes da autenticação');
  assert.equal(rede.restChamadas, 0, 'e nenhuma consulta ao banco');
  assert.deepEqual(rede.inesperadas, []);
});

test('[HOSTED-7] o painel não recebe nenhuma rota de arquivo: as rotas desativadas nem existem como rota, e as vizinhas parecidas continuam sendo rotas do CRM ou 404 comum', async (t) => {
  const s = montar(t);
  // um caminho parecido, mas FORA dos prefixos desativados, segue o fluxo normal (404 comum, depois da autenticação)
  const r = await s.chamar(ADMIN, 'GET', '/api/approvalsx');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'ROUTE_NOT_FOUND');
  assert.equal((await s.chamar(null, 'GET', '/api/approvalsx')).status, 404, 'rota desconhecida: 404 sem exigir sessão (como sempre)');
  assert.equal((await s.chamar(ADMIN, 'GET', '/api/crm')).status, 200);
});

test('[HOSTED-8] createApp (crm-only) RECUSA receber qualquer módulo de arquivo local e exige a origem pública — nem como dependência morta', () => {
  const { createApp } = require('../../src/server/app');
  const base = {
    verifyAccessToken: async () => null,
    userStore: { findByAuthUserId: () => null },
    publicConfig: { supabaseUrl: FAKE_ENV.SUPABASE_URL, supabaseAnonKey: 'x' },
    staticRoot: path.join(__dirname, '..', '..', 'dashboard'),
    deploymentMode: 'crm-only',
    publicOrigin: ORIGEM,
  };
  assert.doesNotThrow(() => createApp(base), 'crm-only sem approvalQueueService é válido');
  const fila = { listQueue() {}, approveProspect() {}, rejectProspect() {} };
  assert.throws(() => createApp({ ...base, approvalQueueService: fila }), /não aceita módulos de arquivo local: approvalQueueService/);
  assert.throws(() => createApp({ ...base, prospectingService: { submitProspecting() {} } }), /prospectingService/);
  assert.throws(() => createApp({ ...base, crmIntegrationService: { promoteProspect() {} } }), /crmIntegrationService/);
  assert.throws(() => createApp({ ...base, prospectingJobService: {} }), /prospectingJobService/);
  assert.throws(() => createApp({ ...base, publicOrigin: undefined }), /exige \{ publicOrigin \}/);
  assert.throws(() => createApp({ ...base, publicOrigin: 'http://crm.exemplo.test' }), /exige \{ publicOrigin \}/);
  assert.throws(() => createApp({ ...base, deploymentMode: 'hospedado' }), /deploymentMode deve ser/);
  // e o modo local continua EXIGINDO a fila
  assert.throws(() => createApp({ ...base, deploymentMode: 'local' }), /exige \{ approvalQueueService \}/);
});

// ===========================================================================
// Health check, HTTPS, cabeçalhos, CORS
// ===========================================================================
test('[HOSTED-9] GET /healthz: público, só { status: "ok" }, sem tocar em Supabase nem em disco, fora do redirecionamento; outros métodos são recusados', async (t) => {
  const s = montar(t);
  const r = await s.chamar(null, 'GET', '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'ok' });
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal((await s.chamar(null, 'HEAD', '/healthz')).status, 200);
  assert.equal((await s.chamar(null, 'POST', '/healthz', {})).status, 405);
  const porHttp = await s.chamar(null, 'GET', '/healthz', undefined, { 'x-forwarded-proto': 'http' });
  assert.equal(porHttp.status, 200, 'a sonda interna da plataforma pode chegar por HTTP');
  for (const proibido of ['supabase', 'exemplo', 'version', 'versao', 'users', 'usuario', 'crm-only', 'data', 'path', 'memory', 'uptime']) assert.ok(!r.text.toLowerCase().includes(proibido), proibido);
  assert.equal(rede.autenticacoes + rede.restChamadas, 0);
  assert.equal(s.logs.length, 0, 'sondas frequentes não enchem o log');
});

test('[HOSTED-10] HTTPS: o proxy diz "http" -> leitura vai para a ORIGEM PÚBLICA configurada (nunca o Host da requisição); escrita é recusada; "https" ou sem cabeçalho segue normal', async (t) => {
  const s = montar(t);
  const http = { 'x-forwarded-proto': 'http' };
  const raiz = await s.chamar(null, 'GET', '/', undefined, { ...http, host: 'atacante.example.test' });
  assert.equal(raiz.status, 308);
  assert.equal(raiz.headers.Location, `${ORIGEM}/`);
  assert.equal((await s.chamar(null, 'HEAD', '/index.html', undefined, http)).headers.Location, `${ORIGEM}/index.html`);
  const api = await s.chamar(ADMIN, 'GET', '/api/crm?x=1', undefined, { ...http, host: 'atacante.example.test', 'x-forwarded-host': 'atacante.example.test' });
  assert.equal(api.status, 308);
  assert.equal(api.headers.Location, `${ORIGEM}/api/crm?x=1`);
  assert.equal(api.headers['Cache-Control'], 'no-store');
  assert.equal(rede.autenticacoes, 0, 'o redirecionamento acontece antes de qualquer autenticação');
  const escrita = await s.chamar(ADMIN, 'POST', '/api/crm', { tipoPessoa: 'PF', nomeCompleto: 'X Teste' }, http);
  assert.equal(escrita.status, 403);
  assert.equal(escrita.json.error.code, 'HTTPS_REQUIRED');
  assert.equal(rede.restChamadas, 0, 'nenhuma escrita por HTTP chegou ao banco');
  assert.equal((await s.chamar(ADMIN, 'GET', '/api/me', undefined, { 'x-forwarded-proto': 'https' })).status, 200);
  assert.equal((await s.chamar(ADMIN, 'GET', '/api/me')).status, 200, 'sem cabeçalho de proxy nada se sabe e nada se redireciona (a imposição é do domínio e do HSTS)');
  assert.equal((await s.chamar(ADMIN, 'GET', '/api/me', undefined, { 'x-forwarded-proto': 'https,http' })).status, 308, 'o último valor (proxy mais próximo) é que vale');
});

test('[HOSTED-11] cabeçalhos de internet: HSTS por um ano SEM includeSubDomains nem preload, Permissions-Policy, CSP e demais; NENHUM cabeçalho CORS; OPTIONS não vira preflight liberado', async (t) => {
  const s = montar(t);
  const respostas = [await s.chamar(ADMIN, 'GET', '/api/me'), await s.chamar(null, 'GET', '/'), await s.chamar(null, 'GET', '/config.json'), await s.chamar(null, 'GET', '/api/nao-existe'), await s.chamar(null, 'GET', '/healthz'), await s.chamar(null, 'GET', '/api/approvals')];
  for (const r of respostas) {
    assert.equal(r.headers['Strict-Transport-Security'], 'max-age=31536000');
    assert.doesNotMatch(r.headers['Strict-Transport-Security'], /includeSubDomains|preload/i);
    assert.match(r.headers['Permissions-Policy'], /camera=\(\)/);
    assert.match(r.headers['Content-Security-Policy'], /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(r.headers['X-Frame-Options'], 'DENY');
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(r.headers['Cross-Origin-Resource-Policy'], 'same-origin');
    for (const nome of Object.keys(r.headers)) assert.doesNotMatch(nome, /^access-control-/i, nome);
  }
  const preflight = await s.chamar(ADMIN, 'OPTIONS', '/api/crm', undefined, { origin: 'https://atacante.example.test', 'access-control-request-method': 'POST' });
  assert.equal(preflight.status, 405);
  for (const nome of Object.keys(preflight.headers)) assert.doesNotMatch(nome, /^access-control-/i);
  // a chave de serviço nunca chega ao navegador: /config.json traz só a URL, a chave anon e o modo
  const config = (await s.chamar(null, 'GET', '/config.json')).json;
  assert.deepEqual(Object.keys(config).sort(), ['modo', 'supabaseAnonKey', 'supabaseUrl']);
  assert.equal(config.modo, 'crm-only');
  const corpoTudo = respostas.map((r) => r.text).join('\n');
  assert.ok(!corpoTudo.includes(CHAVE_SERVICO));
});

// ===========================================================================
// Tentativas abusivas, erros e logs
// ===========================================================================
test('[HOSTED-12] limitador: 30 recusas por sessão ausente/inválida bloqueiam o cliente (429 + Retry-After), inclusive para um token válido; 10 minutos depois volta ao normal; indisponibilidade e 403 não contam', async (t) => {
  let agora = 1_700_000_000_000;
  const s = montar(t, { now: () => agora });
  for (let i = 0; i < 29; i += 1) assert.equal((await s.chamar(i % 2 === 0 ? null : 'token-ruim', 'GET', '/api/crm')).status, 401);
  assert.equal((await s.chamar(TOKENS.semAcesso, 'GET', '/api/me')).status, 403, 'conta sem usuário (403) não conta como falha de sessão');
  assert.equal((await s.chamar(ADMIN, 'GET', '/api/me')).status, 200, 'ainda abaixo do limite: o uso legítimo segue');
  assert.equal((await s.chamar(null, 'GET', '/api/crm')).status, 401, 'a 30ª falha');
  const bloqueado = await s.chamar(null, 'GET', '/api/crm');
  assert.equal(bloqueado.status, 429);
  assert.equal(bloqueado.json.error.code, 'RATE_LIMITED');
  assert.equal(bloqueado.headers['Retry-After'], '600');
  const comTokenValido = await s.chamar(ADMIN, 'GET', '/api/me');
  assert.equal(comTokenValido.status, 429, 'bloqueado é bloqueado, mesmo com token válido (o limite é por cliente)');
  const autenticacoesAntes = rede.autenticacoes;
  await s.chamar(ADMIN, 'GET', '/api/me');
  assert.equal(rede.autenticacoes, autenticacoesAntes, 'enquanto bloqueado nenhuma verificação vai ao Supabase');
  assert.equal((await s.chamar(null, 'GET', '/healthz')).status, 200, 'o health check e os arquivos estáticos não passam pelo limitador');
  assert.equal((await s.chamar(null, 'GET', '/')).status, 200);
  agora += 600_001;
  assert.equal((await s.chamar(ADMIN, 'GET', '/api/me')).status, 200, 'passados 10 minutos o cliente volta');
});

test('[HOSTED-13] o limitador usa o último X-Forwarded-For só com RIO_X7_TRUST_PROXY=1: clientes diferentes atrás do proxy não se bloqueiam entre si', async (t) => {
  const s = montar(t, { env: envHospedado({ RIO_X7_TRUST_PROXY: '1' }) });
  const de = (ip) => ({ 'x-forwarded-for': `198.51.100.250, ${ip}` });
  for (let i = 0; i < 30; i += 1) await s.chamar(null, 'GET', '/api/crm', undefined, de('203.0.113.7'));
  assert.equal((await s.chamar(null, 'GET', '/api/crm', undefined, de('203.0.113.7'))).status, 429);
  assert.equal((await s.chamar(ADMIN, 'GET', '/api/me', undefined, de('203.0.113.8'))).status, 200, 'outro cliente atrás do mesmo proxy não é afetado');
  // sem confiança no proxy (padrão) o cabeçalho é ignorado: todos compartilham a chave do socket
  const sem = montar(t);
  for (let i = 0; i < 30; i += 1) await sem.chamar(null, 'GET', '/api/crm', undefined, de('203.0.113.7'));
  assert.equal((await sem.chamar(ADMIN, 'GET', '/api/me', undefined, de('203.0.113.8'))).status, 429, 'sem RIO_X7_TRUST_PROXY o X-Forwarded-For forjado não escolhe a chave');
});

test('[HOSTED-14] erros sem vazamento: falha do banco vira resposta genérica (sem URL, chave, token nem stack), e os logs não têm token, chave, e-mail nem corpo', async (t) => {
  const s = montar(t);
  await s.chamar(ADMIN, 'GET', '/api/me');
  rede.falharRest = true;
  const falha = await s.chamar(ADMIN, 'GET', '/api/crm');
  assert.ok(falha.status >= 500, String(falha.status));
  for (const segredo of [CHAVE_SERVICO, 'exemplo.supabase.co', TOKENS[ADMIN.userId], 'fetch failed', 'TypeError', 'at ']) assert.ok(!falha.text.includes(segredo), `resposta vazou: ${segredo}`);
  const malformado = await s.chamar(ADMIN, 'POST', '/api/crm', undefined, { 'content-type': 'application/json' });
  assert.ok(malformado.status >= 400 && malformado.status < 500);
  const logTudo = s.logs.join('\n');
  assert.ok(s.logs.length > 0, 'o log de requisições existe');
  for (const segredo of [CHAVE_SERVICO, ...Object.values(TOKENS), ADMIN.email, CLOSER.email, 'exemplo.supabase.co']) assert.ok(!logTudo.includes(segredo), `log vazou: ${segredo}`);
  assert.match(logTudo, /GET \/api\/crm 5\d\d user=user-admin-teste/, 'o log tem método, rota, status e o id do usuário — nada mais');
});

// ===========================================================================
// Reinício e redeploy
// ===========================================================================
test('[HOSTED-15] reinício/redeploy simulados: uma NOVA composição (código recarregado, memória zerada) enxerga o que o Supabase guardou — nada depende de disco nem de memória do processo', async (t) => {
  const primeira = montar(t);
  const criado = await primeira.chamar(ADMIN, 'POST', '/api/crm', { tipoPessoa: 'PJ', empresa: 'Empresa Persistente Teste', cnpj: '11222333000181' });
  assert.equal(criado.status, 201, criado.text);
  const nicho = await primeira.chamar(ADMIN, 'POST', '/api/crm-catalogs/nichos', { nome: 'Nicho Persistente Teste' });
  assert.equal(nicho.status, 201, nicho.text);
  const banco = { crm: rede.crm, catalogs: rede.catalogs, commercial: rede.commercial };
  primeira.server.close();

  // "redeploy": todos os módulos de src/ são recarregados (como um processo novo) e a composição é refeita; o "banco" é o mesmo
  for (const chave of Object.keys(require.cache)) if (/[\\/]src[\\/]/.test(chave)) delete require.cache[chave];
  const novoCreateServer = require('../../src/server/index').createServer;
  const logs = [];
  const nova = novoCreateServer(envHospedado(), { log: (l) => logs.push(l) });
  t.after(() => nova.server.close());
  rede.crm = banco.crm;
  rede.catalogs = banco.catalogs;
  rede.commercial = banco.commercial;
  const chamar = async (quem, method, url) => {
    const r = await nova.app.handle(requisicao({ method, url, token: TOKENS[quem.userId] }));
    return { status: r.status, json: JSON.parse(r.body) };
  };
  const lista = await chamar(ADMIN, 'GET', '/api/crm');
  assert.deepEqual(lista.json.items.map((i) => i.empresa), ['Empresa Persistente Teste']);
  assert.deepEqual((await chamar(ADMIN, 'GET', '/api/crm-catalogs/nichos')).json.items.map((i) => i.nome), ['Nicho Persistente Teste']);
  assert.equal((await chamar(CLOSER, 'GET', '/api/me')).status, 200, 'os usuários também vêm do ambiente: nada a restaurar');
});

// ===========================================================================
// O modo local padrão não mudou
// ===========================================================================
test('[HOSTED-16] o modo local (padrão) continua com a fila, a prospecção e as rotas de arquivo; sem HSTS; /config.json com as duas chaves de sempre; e aceita o arquivo de usuários', (t) => {
  novoMundo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usuarios = path.join(dir, 'users.json');
  fs.writeFileSync(usuarios, JSON.stringify([{ userId: ADMIN.userId, authUserId: ADMIN.authUserId, name: ADMIN.name, email: ADMIN.email, role: 'ADMIN', status: 'ACTIVE' }]));
  const env = { ...FAKE_ENV, RIO_X7_USERS_FILE: usuarios, RIO_X7_QUEUE_PATH: path.join(dir, 'fila.json'), RIO_X7_CRM_PATH: path.join(dir, 'crm.json'), RIO_X7_FUNNELS_PATH: path.join(dir, 'funis.json'), RIO_X7_NEGOTIATIONS_PATH: path.join(dir, 'neg.json'), RIO_X7_CRM_CATALOGS_PATH: path.join(dir, 'cat.json'), RIO_X7_PROSPECTING_BRIEFS_PATH: path.join(dir, 'briefs.json'), RIO_X7_PROSPECTING_JOBS_PATH: path.join(dir, 'jobs.json'), RIO_X7_PROSPECTING_PROFILES_PATH: path.join(dir, 'perfis.json') };
  const { createServer } = require('../../src/server/index');
  const s = createServer(env, {});
  t.after(() => s.server.close());
  assert.equal(s.deploymentMode, 'local');
  return (async () => {
    const chamar = async (method, url, token) => s.app.handle(requisicao({ method, url, token }));
    const fila = await chamar('GET', '/api/approvals', TOKENS[ADMIN.userId]);
    assert.equal(fila.status, 200, 'a Approval Queue segue existindo no modo local');
    assert.equal(JSON.parse(fila.body).estado, 'AGUARDANDO_REVISAO');
    assert.equal((await chamar('GET', '/api/prospecting/briefs', TOKENS[ADMIN.userId])).status, 200);
    assert.equal((await chamar('GET', '/api/leads/reprovados', TOKENS[ADMIN.userId])).status, 200);
    const pagina = await chamar('GET', '/');
    assert.equal(pagina.headers['Strict-Transport-Security'], undefined, 'HSTS só na instância hospedada');
    assert.equal(pagina.headers['Permissions-Policy'], undefined);
    const config = JSON.parse((await chamar('GET', '/config.json')).body);
    assert.deepEqual(Object.keys(config).sort(), ['supabaseAnonKey', 'supabaseUrl']);
    const semRedirect = await s.app.handle(requisicao({ method: 'GET', url: '/', headers: { 'x-forwarded-proto': 'http' } }));
    assert.equal(semRedirect.status, 200, 'o modo local nunca redireciona por X-Forwarded-Proto');
    assert.equal(JSON.parse((await chamar('GET', '/healthz')).body).status, 'ok');
  })();
});

test('[HOSTED-17] a subida em crm-only é recusada com configuração insuficiente: sem REPOSITORY_MODE=supabase, sem a chave de serviço, sem usuários, sem a origem pública; cada mensagem cita só o NOME da variável', () => {
  novoMundo();
  const { createServer } = require('../../src/server/index');
  const sem = (nome) => {
    const env = envHospedado();
    delete env[nome];
    return env;
  };
  assert.throws(() => createServer(sem('REPOSITORY_MODE')), (e) => /crm-only exige REPOSITORY_MODE=supabase/.test(e.message));
  assert.throws(() => createServer(envHospedado({ REPOSITORY_MODE: 'file' })), /crm-only exige REPOSITORY_MODE=supabase/);
  assert.throws(() => createServer(sem('SUPABASE_SERVICE_ROLE_KEY')), (e) => /SUPABASE_SERVICE_ROLE_KEY/.test(e.message) && !e.message.includes(CHAVE_SERVICO));
  assert.throws(() => createServer(sem('RIO_X7_USERS_JSON')), /crm-only exige RIO_X7_USERS_JSON.*não existe arquivo de usuários padrão/);
  assert.throws(() => createServer(sem('RIO_X7_PUBLIC_URL')), /RIO_X7_PUBLIC_URL é obrigatória/);
  assert.throws(() => createServer(envHospedado({ RIO_X7_PUBLIC_URL: 'http://crm.exemplo.test' })), /RIO_X7_PUBLIC_URL inválida/);
  assert.throws(() => createServer(envHospedado({ RIO_X7_DEPLOYMENT_MODE: 'hospedado' })), /RIO_X7_DEPLOYMENT_MODE inválido/);
  assert.throws(() => createServer(envHospedado({ RIO_X7_USERS_JSON: '[{"userId":' })), /RIO_X7_USERS_JSON inválida/);
  assert.throws(() => createServer(envHospedado({ RIO_X7_USERS_FILE: path.join(os.tmpdir(), 'qualquer.json') })), /só UMA fonte de usuários/);
  assert.throws(() => createServer(envHospedado({ SUPABASE_URL: '' })), /SUPABASE_URL e SUPABASE_ANON_KEY/);
});
