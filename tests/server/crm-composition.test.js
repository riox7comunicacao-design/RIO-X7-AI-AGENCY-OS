// Testes da COMPOSIÇÃO do CRM em src/server/index.js (createServer) — decisão 0015.
//
// Os testes de tests/server/crm-api.test.js montam o app à mão. Estes usam a raiz de composição de verdade: o servidor lê
// o ambiente, liga o adapter de autenticação, o store de usuários, a fila e o CRM (createFileBackedCrmService com a ponte
// real authorizeCrmOperation e o arquivo indicado por RIO_X7_CRM_PATH), e entrega um app pronto. Só a borda de rede do
// Supabase é falsa. Nenhum teste aqui lê ou escreve o data/crm.json de verdade: o caminho padrão é provado por
// interceptação (a leitura é desviada para "arquivo inexistente" e nenhuma escrita acontece).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createServer } = require('../../src/server');
const { FAKE_ENV, fakeAccessToken, installFakeSupabaseAuth, supabaseUserBody } = require('../helpers/authFixtures');
const { BRENO, RAFAEL } = require('./testEnv');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function requisicao({ method = 'GET', url, token, body }) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  return req;
}

// `variaveis(dir)` devolve as variáveis de ambiente do CRM (ou nenhuma); o resto do ambiente é sempre sintético.
function comporServidor(t, variaveis = () => ({})) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-composition-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usersFile = path.join(dir, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify([BRENO, RAFAEL]));
  // `orfao`: um token que o Supabase falso reconhece, de alguém que NÃO está no arquivo de usuários.
  const tokens = { breno: fakeAccessToken('composicao-breno'), rafael: fakeAccessToken('composicao-rafael'), orfao: fakeAccessToken('composicao-orfao') };
  installFakeSupabaseAuth(t, {
    [tokens.breno]: supabaseUserBody({ authUserId: BRENO.authUserId, email: BRENO.email }),
    [tokens.rafael]: supabaseUserBody({ authUserId: RAFAEL.authUserId, email: RAFAEL.email }),
    [tokens.orfao]: supabaseUserBody({ authUserId: 'auth-que-ninguem-cadastrou', email: 'orfao-teste@example.test' }),
  });
  const env = { ...FAKE_ENV, RIO_X7_USERS_FILE: usersFile, RIO_X7_QUEUE_PATH: path.join(dir, 'approval-queue.json'), ...variaveis(dir) };
  const { app } = createServer(env, { log: () => {} });
  return { app, tokens, dir };
}

const chamar = async (app, opcoes) => {
  const resposta = await app.handle(requisicao(opcoes));
  return { status: resposta.status, text: resposta.body, json: () => JSON.parse(resposta.body) };
};

test('[CRM-COMP-1] createServer liga o CRM de ponta a ponta: rotas existentes e protegidas, autorização REAL (ADMIN escreve, COMMERCIAL_CLOSER só lê) e gravação no arquivo de RIO_X7_CRM_PATH', async (t) => {
  const { app, tokens, dir } = comporServidor(t, (d) => ({ RIO_X7_CRM_PATH: path.join(d, 'crm-composto.json') }));
  const arquivo = path.join(dir, 'crm-composto.json');

  assert.equal((await chamar(app, { url: '/api/crm' })).status, 401, 'a rota existe (não é 404) e exige token');
  assert.equal((await chamar(app, { url: '/api/crm', token: tokens.rafael })).status, 200);
  assert.equal(fs.existsSync(arquivo), false, 'ler não cria o arquivo');

  const criada = await chamar(app, { method: 'POST', url: '/api/crm', token: tokens.breno, body: { empresa: 'Clínica Composta', site: 'composta.example.test' } });
  assert.equal(criada.status, 201);
  const id = criada.json().item.id;
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(arquivo, 'utf8'))), [id], 'gravou no arquivo indicado por RIO_X7_CRM_PATH');
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, 'utf8'))[id].historico[0].reviewedBy, { userId: BRENO.userId, name: BRENO.name, role: BRENO.role });

  const doCloser = await chamar(app, { method: 'POST', url: '/api/crm', token: tokens.rafael, body: { empresa: 'Outra' } });
  assert.equal(doCloser.status, 403, 'a ponte real de src/auth nega WRITE:CRM ao closer');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(arquivo, 'utf8'))), [id]);

  const lista = await chamar(app, { url: '/api/crm', token: tokens.rafael });
  assert.deepEqual(lista.json().items.map((item) => item.id), [id]);
  assert.equal((await chamar(app, { url: '/api/approvals', token: tokens.breno })).status, 200, 'a fila continua ligada como antes');
});

// Intercepta a leitura de qualquer "crm.json" (devolve "arquivo inexistente") e conta as chamadas que criariam algo em disco.
function interceptarArquivoDoCrm(t) {
  const original = fs.readFileSync;
  const lidos = [];
  t.mock.method(fs, 'readFileSync', (arquivo, ...resto) => {
    if (path.basename(String(arquivo)).startsWith('crm')) {
      lidos.push(String(arquivo));
      throw Object.assign(new Error('ENOENT (simulado pelo teste)'), { code: 'ENOENT' });
    }
    return original(arquivo, ...resto);
  });
  const mkdir = t.mock.method(fs, 'mkdirSync');
  const abrir = t.mock.method(fs, 'openSync');
  return { lidos, escritas: () => mkdir.mock.callCount() + abrir.mock.callCount() };
}

test('[CRM-COMP-2] sem RIO_X7_CRM_PATH (ausente ou em branco) o CRM usa data/crm.json na raiz do projeto — provado sem tocar no arquivo real', async (t) => {
  for (const valor of [undefined, '', '   ']) {
    const { app, tokens } = comporServidor(t, () => (valor === undefined ? {} : { RIO_X7_CRM_PATH: valor }));
    const espiao = interceptarArquivoDoCrm(t);
    const lista = await chamar(app, { url: '/api/crm', token: tokens.breno });
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.json().items, []);
    assert.deepEqual(espiao.lidos, [path.join(REPO_ROOT, 'data', 'crm.json')], `valor ${JSON.stringify(valor)}`);
    assert.equal(espiao.escritas(), 0, 'uma leitura nunca escreve');
    t.mock.restoreAll();
  }
});

test('[CRM-COMP-3] um RIO_X7_CRM_PATH relativo é resolvido a partir do diretório de execução, e espaços nas pontas são ignorados', async (t) => {
  const { app, tokens } = comporServidor(t, () => ({ RIO_X7_CRM_PATH: '  dados-de-teste/crm-relativo.json  ' }));
  const espiao = interceptarArquivoDoCrm(t);
  const lista = await chamar(app, { url: '/api/crm', token: tokens.breno });
  assert.equal(lista.status, 200);
  assert.deepEqual(espiao.lidos, [path.resolve(process.cwd(), 'dados-de-teste', 'crm-relativo.json')]);
  assert.equal(espiao.escritas(), 0);
});

test('[CRM-COMP-4] a composição não expõe o CRM a quem não é USER: um token válido de quem não está no arquivo de usuários -> 403 NO_ACCESS, em leitura e em escrita', async (t) => {
  const { app, tokens } = comporServidor(t, (d) => ({ RIO_X7_CRM_PATH: path.join(d, 'crm.json') }));
  for (const requisicaoOrfa of [{ url: '/api/crm' }, { method: 'POST', url: '/api/crm', body: { empresa: 'X' } }]) {
    const resposta = await chamar(app, { ...requisicaoOrfa, token: tokens.orfao });
    assert.equal(resposta.status, 403);
    assert.equal(resposta.json().error.code, 'NO_ACCESS');
  }
});
