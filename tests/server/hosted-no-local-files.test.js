// A INSTÂNCIA HOSPEDADA NÃO USA O DISCO (Fase WEB 1, decisão 0033): a hospedagem tem disco efêmero (os diretórios gerenciados são sobrescritos a cada deploy), então em "crm-only" NENHUM arquivo
// operacional pode ser lido ou criado — nem na subida, nem ao importar os módulos, nem em qualquer rota (as do CRM e as desativadas).
//
// Como se prova: toda chamada do módulo `fs` (síncrona, de callback e de promessas) que recebe um caminho é REGISTRADA durante a composição REAL (`createServer` com o código recarregado do zero) e
// uma sequência de requisições. Depois: (a) nenhum acesso, de nenhum tipo, a data/; (b) nenhuma ESCRITA em lugar nenhum (nenhum arquivo, diretório ou renomeação). Ler os arquivos do próprio
// painel e do pacote supabase-js é esperado (são o código, entregues pelo deploy). Controles: o registrador DETECTA um acesso a data/ e uma escrita (sem tocar em nada real).
//
// Nenhuma rede real (fetch falso global), nenhum arquivo de data/ lido, criado ou alterado. Dados fictícios.

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

const REPO = path.join(__dirname, '..', '..');
const DATA = path.join(REPO, 'data');
const CHAVE = 'chave-de-servico-falsa-so-para-teste-sem-disco';
const ADMIN = { userId: 'user-admin-teste', authUserId: 'auth-admin-teste', name: 'Admin Teste', email: 'admin-teste@example.test', role: 'ADMIN', status: 'ACTIVE' };
const TOKEN = fakeAccessToken('sem-disco');

// ---------------------------------------------------------------------------
// O registrador do `fs`
// ---------------------------------------------------------------------------
const SO_LEITURA = ['readFileSync', 'readFile', 'existsSync', 'statSync', 'lstatSync', 'stat', 'lstat', 'readdirSync', 'readdir', 'accessSync', 'access', 'createReadStream', 'realpathSync', 'realpath', 'opendirSync', 'opendir'];
const ESCRITA = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'renameSync', 'rename', 'unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir', 'copyFileSync', 'copyFile', 'createWriteStream', 'truncateSync', 'truncate', 'symlinkSync', 'symlink', 'utimesSync', 'chmodSync', 'mkdtempSync', 'mkdtemp'];
const ABRE = ['openSync', 'open']; // escreve se as flags pedem
const PROMESSAS = ['readFile', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'stat', 'lstat', 'readdir', 'access', 'open', 'copyFile', 'realpath', 'mkdtemp', 'truncate', 'opendir'];

const comoCaminho = (valor) => (typeof valor === 'string' ? valor : valor instanceof URL ? valor.pathname : Buffer.isBuffer(valor) ? valor.toString() : null);
const abreParaEscrever = (flags) => typeof flags === 'string' && /[wa+]/.test(flags);

function instalarRegistrador() {
  const originais = [];
  const registros = [];
  const gravar = (alvo, nome, original, tipo) => {
    originais.push([alvo, nome, original]);
    alvo[nome] = function registrado(...args) {
      const caminhos = [comoCaminho(args[0])];
      if (nome === 'renameSync' || nome === 'rename' || nome === 'copyFileSync' || nome === 'copyFile' || nome === 'symlinkSync' || nome === 'symlink') caminhos.push(comoCaminho(args[1]));
      const escreve = tipo === 'escrita' || (tipo === 'abre' && abreParaEscrever(args[1]));
      for (const caminho of caminhos) if (caminho !== null) registros.push({ nome, caminho: path.resolve(caminho), escreve });
      return original.apply(this, args);
    };
  };
  for (const nome of SO_LEITURA) if (typeof fs[nome] === 'function') gravar(fs, nome, fs[nome], 'leitura');
  for (const nome of ESCRITA) if (typeof fs[nome] === 'function') gravar(fs, nome, fs[nome], 'escrita');
  for (const nome of ABRE) if (typeof fs[nome] === 'function') gravar(fs, nome, fs[nome], 'abre');
  for (const nome of PROMESSAS) if (typeof fs.promises[nome] === 'function') gravar(fs.promises, nome, fs.promises[nome], ESCRITA.includes(`${nome}Sync`) || ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'mkdtemp', 'truncate'].includes(nome) ? 'escrita' : nome === 'open' ? 'abre' : 'leitura');
  return {
    registros,
    restaurar() {
      for (const [alvo, nome, original] of originais.reverse()) alvo[nome] = original;
    },
    emData: () => registros.filter((r) => r.caminho === DATA || r.caminho.startsWith(DATA + path.sep)),
    escritas: () => registros.filter((r) => r.escreve),
  };
}

// ---------------------------------------------------------------------------
// O mundo falso (Supabase Auth + PostgREST), como em hosted-crm-only.test.js
// ---------------------------------------------------------------------------
const rede = { crm: null, catalogs: null, commercial: null };
const corpoAuth = supabaseUserBody({ authUserId: ADMIN.authUserId, email: ADMIN.email });
const json = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

test.before(() => {
  test.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/auth/v1/user') {
      const token = (new Headers(init.headers || {}).get('authorization') || '').replace(/^Bearer\s+/i, '');
      return token === TOKEN ? json(corpoAuth) : json({ code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }, 403);
    }
    const alvo = u.pathname.replace('/rest/v1/', '');
    if (!u.pathname.startsWith('/rest/v1/')) throw new Error(`requisição inesperada: ${u.host}${u.pathname}`);
    if (alvo === 'crm_records') return rede.crm.fetchImpl(url, init);
    if (alvo === 'crm_services' || alvo === 'crm_niches' || alvo === 'crm_lead_origins' || alvo === 'rpc/reorder_crm_catalog') return rede.catalogs.fetchImpl(url, init);
    return rede.commercial.fetchImpl(url, init);
  });
});
test.after(() => test.mock.restoreAll());

const env = () => ({
  ...FAKE_ENV,
  SUPABASE_SERVICE_ROLE_KEY: CHAVE,
  REPOSITORY_MODE: 'supabase',
  RIO_X7_DEPLOYMENT_MODE: 'crm-only',
  RIO_X7_PUBLIC_URL: 'https://crm.exemplo.test',
  RIO_X7_USERS_JSON: JSON.stringify([{ userId: ADMIN.userId, authUserId: ADMIN.authUserId, name: ADMIN.name, email: ADMIN.email, role: ADMIN.role, status: ADMIN.status }]),
});

function requisicao(method, url, { token, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
  return req;
}

// ===========================================================================
test('[HOSTED-FS-0] controles: o registrador DETECTA um acesso a data/ e uma escrita (sem tocar em nenhum dado real)', (t) => {
  const registrador = instalarRegistrador();
  const lixo = path.join(os.tmpdir(), `rx7-controle-${process.pid}.tmp`);
  try {
    fs.existsSync(path.join(DATA, '__controle_inexistente__.json')); // um caminho que não existe: só a TENTATIVA é registrada
    fs.writeFileSync(lixo, 'controle');
    fs.promises.stat(path.join(DATA, '__controle_inexistente__.json')).catch(() => {});
    fs.openSync(lixo, 'r+').valueOf();
  } finally {
    registrador.restaurar();
    fs.rmSync(lixo, { force: true });
  }
  assert.ok(registrador.emData().length >= 2, 'acessos a data/ são vistos (síncronos e de promessa)');
  assert.ok(registrador.escritas().some((r) => r.nome === 'writeFileSync' && r.caminho === path.resolve(lixo)), 'a escrita é vista');
  assert.ok(registrador.escritas().some((r) => r.nome === 'openSync'), 'e abrir com flags de escrita também');
  assert.equal(typeof fs.readFileSync, 'function');
  t.diagnostic(`${registrador.registros.length} chamadas registradas no controle`);
});

test('[HOSTED-FS-1] crm-only: subir (código recarregado do zero) e atender CRM, catálogos, funis, negociações, health, estáticos e TODAS as rotas desativadas NÃO lê nem cria arquivo algum de data/ e NÃO escreve em disco', async (t) => {
  rede.crm = postgrestCrm();
  rede.catalogs = createFakePostgrestCatalogs({ url: FAKE_ENV.SUPABASE_URL, serviceRoleKey: CHAVE });
  rede.commercial = criarPostgrestComercial();
  const logs = [];
  const registrador = instalarRegistrador();
  let composicao;
  const respostas = [];
  try {
    // código recarregado do zero: o registro também cobre o que os módulos fazem ao ser IMPORTADOS
    for (const chave of Object.keys(require.cache)) if (/[\\/]src[\\/]/.test(chave)) delete require.cache[chave];
    const { createServer } = require('../../src/server/index');
    composicao = createServer(env(), { log: (l) => logs.push(l) });
    const chamar = async (method, url, opcoes) => {
      const r = await composicao.app.handle(requisicao(method, url, opcoes));
      respostas.push(`${method} ${url} ${r.status}`);
      return r;
    };
    // o que a instância serve
    assert.equal((await chamar('GET', '/healthz')).status, 200);
    assert.equal((await chamar('GET', '/')).status, 200);
    assert.equal((await chamar('GET', '/main.mjs')).status, 200);
    assert.equal((await chamar('GET', '/lib/supabase.js')).status, 200);
    assert.equal((await chamar('GET', '/config.json')).status, 200);
    assert.equal((await chamar('GET', '/api/me', { token: TOKEN })).status, 200);
    assert.equal((await chamar('GET', '/api/crm', { token: TOKEN })).status, 200);
    assert.equal((await chamar('POST', '/api/crm', { token: TOKEN, body: { tipoPessoa: 'PJ', empresa: 'Empresa Sem Disco Teste', cnpj: '11222333000181' } })).status, 201);
    assert.equal((await chamar('GET', '/api/crm-catalogs/servicos', { token: TOKEN })).status, 200);
    assert.equal((await chamar('POST', '/api/crm-catalogs/origens', { token: TOKEN, body: { nome: 'Indicação Teste' } })).status, 201);
    assert.equal((await chamar('GET', '/api/funnels', { token: TOKEN })).status, 200);
    assert.equal((await chamar('GET', '/api/funnel-board', { token: TOKEN })).status, 200);
    assert.equal((await chamar('GET', '/api/negotiations/summary', { token: TOKEN })).status, 200);
    // o que NÃO existe: cada família desativada, com e sem sessão
    for (const [method, url] of [['GET', '/api/approvals'], ['POST', '/api/approvals/x/promote'], ['POST', '/api/prospecting/submit'], ['GET', '/api/prospecting/briefs'], ['POST', '/api/prospecting/jobs'], ['GET', '/api/prospecting/batches'], ['GET', '/api/prospecting/exclusions'], ['GET', '/api/leads/reprovados'], ['POST', '/api/leads/x/completar-pesquisa']]) {
      for (const opcoes of [{}, { token: TOKEN }]) assert.equal((await chamar(method, url, { ...opcoes, ...(method === 'GET' ? {} : { body: {} }) })).status, 404, `${method} ${url}`);
    }
  } finally {
    registrador.restaurar();
    if (composicao) composicao.server.close();
  }
  assert.ok(registrador.registros.length > 20, 'o registrador viu o que a composição e o servidor de arquivos estáticos leem (o código do painel e do supabase-js)');
  assert.deepEqual(registrador.emData(), [], 'nenhum acesso (leitura, existência, listagem, escrita) a data/ — nem users.json, nem a fila, nem os arquivos de prospecção');
  assert.deepEqual(registrador.escritas(), [], 'nenhuma escrita em disco: nem arquivo, nem diretório, nem renomeação, nem temporário');
  const fora = registrador.registros.filter((r) => !r.caminho.startsWith(REPO + path.sep) && !r.caminho.startsWith(os.tmpdir()));
  assert.ok(fora.every((r) => !/\.json$/i.test(r.caminho) || /package\.json$/i.test(r.caminho)), `nenhum .json de dados fora do repositório (${fora.map((r) => r.caminho).filter((c) => /\.json$/i.test(c)).join(', ')})`);
  assert.equal(composicao.deploymentMode, 'crm-only');
  assert.ok(respostas.length >= 30);
});

test('[HOSTED-FS-2] crm-only: a subida não recupera jobs antigos nem cria nenhum repositório de arquivo (o código dos módulos de arquivo nem é consultado durante a composição)', () => {
  const codigo = fs.readFileSync(path.join(REPO, 'src', 'server', 'index.js'), 'utf8');
  // cada criação de módulo de arquivo está DENTRO do bloco `if (!crmOnly) {` — a análise é estrutural: o trecho entre a abertura do bloco e o seu fim contém todas elas
  const abre = codigo.indexOf('  if (!crmOnly) {\n    approvalQueueService = createApprovalQueueService(');
  const fecha = codigo.indexOf('\n  }\n', abre);
  assert.ok(abre > 0 && fecha > abre, 'o bloco existe');
  const bloco = codigo.slice(abre, fecha);
  const fora = codigo.slice(0, abre) + codigo.slice(fecha);
  for (const criacao of ['createApprovalQueueService(', 'createFileBackedCrmIntegrationService(', 'createFileBackedProspectingService(', 'createFileBackedProspectingBriefService(', 'createFileBackedProspectingJobService(', 'recoverInterruptedJobs()', 'createFileBackedLeadEnrichmentService(', 'createFileBackedLeadReconsiderationService(', 'createConfiguredProspectingExclusionService(', 'createConfiguredPermanentExclusionGuard(']) {
    assert.ok(bloco.includes(criacao), `${criacao} está dentro do bloco do modo local`);
    // fora do bloco só resta a composição do CRM: nenhuma criação de módulo de arquivo (os imports não têm parêntese)
    assert.ok(!fora.includes(criacao), `${criacao} nunca é chamada fora do bloco do modo local`);
  }
});
