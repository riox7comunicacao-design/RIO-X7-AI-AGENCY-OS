// A fábrica dos catálogos por REPOSITORY_MODE (src/services/catalogRepositoryFactory.js) e o contador de uso do CRM legado
// (src/services/catalogUsage.js) — CRM 5.0, Fase 2B-1. NUNCA lê process.env (no `npm test` ele carrega o .env do desenvolvedor): todo `env` é
// explícito. NUNCA chama a rede real: o `fetch` global é substituído por um falso em todo teste que monta o modo "supabase". Arquivos só em
// diretórios temporários.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfiguredCatalogRepository, createConfiguredCatalogService, sharedFileCatalogRepository, sharedSupabaseCatalogRepository } = require('../../src/services/catalogRepositoryFactory');
const { createCrmCatalogUsageCounter } = require('../../src/services/catalogUsage');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { authorizeCatalogOperation } = require('../../src/auth');
const { CATALOG_ERROR } = require('../../src/crm/catalogConstants');
const { createFakePostgrestCatalogs } = require('../helpers/fakePostgrestCatalogs');
const { admin } = require('../helpers/promotionFixtures');

const SEGREDO = 'SEGREDO-DA-SERVICE-ROLE-NAO-PODE-VAZAR';
const URL_FALSA = 'https://exemplo-teste.supabase.co';
const ENV_SUPABASE = Object.freeze({ REPOSITORY_MODE: 'supabase', SUPABASE_URL: URL_FALSA, SUPABASE_SERVICE_ROLE_KEY: SEGREDO });

function pasta(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-factory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// O fetch global vira um falso que FALHA se alguém o chamar (a menos que o teste passe um PostgREST falso).
function semRedeReal(t, fetchFalso) {
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = fetchFalso || (async (...args) => { chamadas.push(args); throw new Error('rede real proibida nos testes'); });
  t.after(() => {
    globalThis.fetch = original;
  });
  return chamadas;
}

test('[CATFAC-1] sem REPOSITORY_MODE (ou "file") a fábrica devolve o adapter de ARQUIVO no caminho dado — sem credencial nenhuma, sem rede, e sem criar o arquivo só por montar', (t) => {
  const chamadas = semRedeReal(t);
  const caminho = path.join(pasta(t), 'crm-catalogs.json');
  for (const env of [{}, { REPOSITORY_MODE: '' }, { REPOSITORY_MODE: 'file' }, { REPOSITORY_MODE: '  file  ' }]) {
    const repo = createConfiguredCatalogRepository({ env, filePath: caminho });
    assert.deepEqual(Object.keys(repo).sort(), ['getById', 'insert', 'list', 'reorder', 'update'], JSON.stringify(env));
    assert.deepEqual(repo.list('nichos'), []);
  }
  assert.equal(fs.existsSync(caminho), false, 'ler não cria o arquivo');
  assert.deepEqual(chamadas, [], 'nenhuma chamada de rede');
});

test('[CATFAC-2] o modo "file" EXIGE o caminho (escolhido por quem compõe, sem padrão escondido); um REPOSITORY_MODE inválido é erro claro e nunca vira "file" por padrão', () => {
  for (const filePath of [undefined, null, '', '   ', 5]) {
    assert.throws(() => createConfiguredCatalogRepository({ env: {}, filePath }), /exige \{ filePath \}/);
  }
  assert.throws(() => createConfiguredCatalogRepository({ env: {} }), /exige \{ filePath \}/);
  // (nenhuma chamada sem `env`: ela leria o process.env, que no `npm test` traz o .env do desenvolvedor — os testes nunca dependem dele)
  for (const invalido of ['banana', 'FILE', 'Supabase', 'postgres', 'true']) {
    assert.throws(() => createConfiguredCatalogRepository({ env: { REPOSITORY_MODE: invalido }, filePath: '/tmp/x.json' }), /REPOSITORY_MODE inválido/, invalido);
  }
});

test('[CATFAC-3] INSTÂNCIA ÚNICA por armazenamento: o mesmo caminho devolve o MESMO repositório (a serialização das escritas é por objeto); caminhos diferentes, repositórios diferentes', (t) => {
  const dir = pasta(t);
  const a = createConfiguredCatalogRepository({ env: {}, filePath: path.join(dir, 'a.json') });
  const a2 = createConfiguredCatalogRepository({ env: {}, filePath: path.join(dir, 'a.json') });
  const b = createConfiguredCatalogRepository({ env: {}, filePath: path.join(dir, 'b.json') });
  assert.equal(a, a2);
  assert.notEqual(a, b);
  assert.equal(sharedFileCatalogRepository(path.join(dir, 'a.json')), a);
});

test('[CATFAC-4] modo "supabase": monta o adapter com as DUAS variáveis, sem nenhuma chamada de rede; a mesma configuração dá o MESMO repositório, outra chave dá outro', async (t) => {
  const fake = createFakePostgrestCatalogs({ url: URL_FALSA, serviceRoleKey: SEGREDO });
  semRedeReal(t, fake.fetchImpl);
  const a = createConfiguredCatalogRepository({ env: ENV_SUPABASE });
  const a2 = createConfiguredCatalogRepository({ env: { ...ENV_SUPABASE } });
  const outraChave = createConfiguredCatalogRepository({ env: { ...ENV_SUPABASE, SUPABASE_SERVICE_ROLE_KEY: `${SEGREDO}-outra` } });
  assert.equal(fake.calls.length, 0, 'montar não chama a rede (preguiçoso)');
  assert.equal(a, a2);
  assert.notEqual(a, outraChave);
  assert.deepEqual(Object.keys(a).sort(), ['getById', 'insert', 'list', 'reorder', 'update']);
  assert.equal(sharedSupabaseCatalogRepository({ url: URL_FALSA, serviceRoleKey: SEGREDO }), a);
  // ele de fato fala com o PostgREST configurado quando USADO — e o filePath é ignorado nesse modo
  assert.deepEqual(await a.list('servicos'), []);
  assert.equal(fake.calls.length, 1);
  assert.equal(new URL(fake.calls[0].url).pathname, '/rest/v1/crm_services');
  const comCaminho = createConfiguredCatalogRepository({ env: ENV_SUPABASE, filePath: path.join(pasta(t), 'ignorado.json') });
  assert.equal(comCaminho, a);
});

test('[CATFAC-5] NUNCA cai para "file" em silêncio: no modo "supabase" a configuração ausente ou inválida FALHA citando só o NOME da variável — mesmo com um filePath válido — e nada é criado em disco', (t) => {
  const chamadas = semRedeReal(t);
  const caminho = path.join(pasta(t), 'nao-deve-existir.json');
  const casos = [
    [{ REPOSITORY_MODE: 'supabase' }, /SUPABASE_URL não está configurada/],
    [{ REPOSITORY_MODE: 'supabase', SUPABASE_URL: URL_FALSA }, /SUPABASE_SERVICE_ROLE_KEY não está configurada/],
    [{ REPOSITORY_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: SEGREDO }, /SUPABASE_URL não está configurada/],
    [{ REPOSITORY_MODE: 'supabase', SUPABASE_URL: 'http://inseguro.test', SUPABASE_SERVICE_ROLE_KEY: SEGREDO }, /deve ser https/],
    [{ REPOSITORY_MODE: 'supabase', SUPABASE_URL: 'não é url', SUPABASE_SERVICE_ROLE_KEY: SEGREDO }, /não é uma URL válida/],
    [{ REPOSITORY_MODE: 'supabase', SUPABASE_URL: '   ', SUPABASE_SERVICE_ROLE_KEY: SEGREDO }, /SUPABASE_URL não está configurada/],
  ];
  for (const [env, mensagem] of casos) {
    let erro;
    try {
      createConfiguredCatalogRepository({ env, filePath: caminho });
    } catch (error) {
      erro = error;
    }
    assert.ok(erro, JSON.stringify(Object.keys(env)));
    assert.match(erro.message, mensagem);
    assert.doesNotMatch(erro.message, new RegExp(SEGREDO), 'a chave nunca aparece numa mensagem');
  }
  assert.equal(fs.existsSync(caminho), false);
  assert.deepEqual(chamadas, []);
});

test('[CATFAC-6] createConfiguredCatalogService devolve o Service completo (7 operações) sobre o repositório do modo escolhido; o arquivo só nasce quando um ADMIN cria o primeiro item; as dependências obrigatórias continuam obrigatórias', async (t) => {
  const caminho = path.join(pasta(t), 'crm-catalogs.json');
  const service = createConfiguredCatalogService({ env: {}, authorizeOperation: authorizeCatalogOperation, filePath: caminho, countUsage: async () => 0 });
  assert.deepEqual(Object.keys(service).sort(), ['activate', 'create', 'deactivate', 'get', 'list', 'reorder', 'update']);
  assert.deepEqual(await service.list(admin(), 'nichos'), []);
  assert.equal(fs.existsSync(caminho), false, 'consultar não cria o arquivo');
  const criado = await service.create(admin(), 'nichos', { nome: 'Estética', cor: 'azul' });
  assert.equal(fs.existsSync(caminho), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(caminho, 'utf8')).nichos[criado.id].nome, 'Estética');
  assert.throws(() => createConfiguredCatalogService({ env: {}, filePath: caminho, countUsage: async () => 0 }), /exige \{ authorizeOperation \}/);
  assert.throws(() => createConfiguredCatalogService({ env: {}, authorizeOperation: authorizeCatalogOperation, filePath: caminho }), /exige \{ countUsage \}/);
  assert.throws(() => createConfiguredCatalogService({ env: {}, authorizeOperation: authorizeCatalogOperation, countUsage: async () => 0 }), /exige \{ filePath \}/);
});

test('[CATFAC-7] dois Services montados pela fábrica para o MESMO arquivo compartilham o repositório: criações concorrentes do mesmo nome por eles resultam em UM item (sem isso, cada um teria a sua fila de escrita e criariam duas cópias)', async (t) => {
  const caminho = path.join(pasta(t), 'crm-catalogs.json');
  const montar = () => createConfiguredCatalogService({ env: {}, authorizeOperation: authorizeCatalogOperation, filePath: caminho, countUsage: async () => 0 });
  const [s1, s2] = [montar(), montar()];
  const resultados = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? s1 : s2).create(admin(), 'origens', { nome: i % 3 ? 'Indicação' : 'indicacao' })));
  assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.filter((r) => r.status === 'rejected' && r.reason.code === CATALOG_ERROR.DUPLICATE_NAME).length, 19);
  assert.equal((await s1.list(admin(), 'origens')).length, 1);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(caminho, 'utf8')).origens).length, 1);
});

test('[CATFAC-8] no modo "supabase" o Service funciona de ponta a ponta contra o PostgREST falso — e uma tabela ausente (migration não aplicada) vira CRM_CATALOG_PERSISTENCE com mensagem fixa, sem vazar o texto do banco', async (t) => {
  // uma chave PRÓPRIA deste teste: o repositório é cacheado por configuração (url + chave), então reaproveitar a chave de outro teste
  // devolveria um repositório já ligado ao `fetch` falso daquele teste
  const chave = `${SEGREDO}-ponta-a-ponta`;
  const fake = createFakePostgrestCatalogs({ url: URL_FALSA, serviceRoleKey: chave });
  semRedeReal(t, fake.fetchImpl);
  const env = { ...ENV_SUPABASE, SUPABASE_SERVICE_ROLE_KEY: chave };
  const service = createConfiguredCatalogService({ env, authorizeOperation: authorizeCatalogOperation, countUsage: async () => 0 });
  const item = await service.create(admin(), 'servicos', { nome: 'Site', precoReferencia: 900, tipoCobranca: 'UNICA' });
  assert.equal(item.nome, 'Site');
  assert.equal((await service.list(admin(), 'servicos')).length, 1);
  const lido = await service.get(admin(), 'servicos', item.id);
  assert.equal(lido.precoReferencia, 900);
  assert.ok(fake.tables.crm_services.has(item.id), 'gravou na tabela crm_services do banco falso');

  // tabela ausente: nenhuma migration aplicada naquele projeto
  semRedeReal(t, async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.crm_services' ${SEGREDO}` }) }));
  const outro = createConfiguredCatalogService({ env: { ...ENV_SUPABASE, SUPABASE_SERVICE_ROLE_KEY: `${SEGREDO}-2` }, authorizeOperation: authorizeCatalogOperation, countUsage: async () => 0 });
  let erro;
  try {
    await outro.list(admin(), 'servicos');
  } catch (error) {
    erro = error;
  }
  assert.equal(erro.code, CATALOG_ERROR.PERSISTENCE);
  assert.equal(erro.message, 'Cadastro: não foi possível ler ou gravar os dados.');
  assert.doesNotMatch(erro.message, /PGRST205|crm_services|SEGREDO/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// O contador de uso do CRM legado
// ---------------------------------------------------------------------------------------------------------------------------------
const registro = (id, campos) => ({ id: `crm:${id}`, empresa: `Empresa ${id}`, status: 'PROSPECT', historico: [{ to: 'PROSPECT' }], ...campos });
function crmCom(registros) {
  const repo = createInMemoryCrmRepository();
  for (const r of registros) repo.save(r);
  return repo;
}
const item = (nome, extras = {}) => ({ id: 'niche:x', nome, nomeNormalizado: undefined, ...extras });

test('[CATUSO-1] conta os registros cujo campo LEGADO (nicho / origem / servicoPotencial) tem o nome do item, comparado NORMALIZADO: caixa, acento, pontuação e espaços não importam', async () => {
  const crm = crmCom([
    registro(1, { nicho: 'Estética' }),
    registro(2, { nicho: 'estetica' }),
    registro(3, { nicho: '  ESTÉTICA!  ' }),
    registro(4, { nicho: 'Estética e beleza' }),
    registro(5, { nicho: 'Psicologia' }),
    registro(6, { nicho: null }),
    registro(7, {}),
    registro(8, { origem: 'Estética', servicoPotencial: 'Estética' }),
  ]);
  const contar = createCrmCatalogUsageCounter({ crmRepository: crm });
  assert.equal(await contar('nichos', { nome: 'Estética', nomeNormalizado: 'estetica' }), 3, 'só o campo `nicho` conta para o catálogo de nichos');
  assert.equal(await contar('origens', { nome: 'Estética', nomeNormalizado: 'estetica' }), 1, 'o catálogo de origens olha só `origem`');
  assert.equal(await contar('servicos', { nome: 'Estética', nomeNormalizado: 'estetica' }), 1, 'o de serviços olha só `servicoPotencial`');
  assert.equal(await contar('nichos', { nome: 'Psicologia', nomeNormalizado: 'psicologia' }), 1);
  assert.equal(await contar('nichos', { nome: 'Direito', nomeNormalizado: 'direito' }), 0);
});

test('[CATUSO-2] só os CAMPOS legados contam: o nome em observações, empresa ou outro campo livre NÃO é uso; valores que não são texto (número, objeto, lista) nunca contam', async () => {
  const crm = crmCom([
    registro(1, { observacoes: 'Clínica de Estética', empresa: 'Estética Bella', problemaIdentificado: 'estetica', raioXDeNicho: 'Estética' }),
    registro(2, { nicho: 5 }),
    registro(3, { nicho: ['Estética'] }),
    registro(4, { nicho: { nome: 'Estética' } }),
    registro(5, { nicho: true }),
  ]);
  const contar = createCrmCatalogUsageCounter({ crmRepository: crm });
  assert.equal(await contar('nichos', { nome: 'Estética', nomeNormalizado: 'estetica' }), 0);
});

test('[CATUSO-3] o nome normalizado do item vale; sem ele, usa o nome; um nome vazio ou sem letras nunca "usa" nada (0, mesmo que haja registros vazios)', async () => {
  const crm = crmCom([registro(1, { nicho: 'Estética' }), registro(2, { nicho: '' }), registro(3, { nicho: '!!!' }), registro(4, {})]);
  const contar = createCrmCatalogUsageCounter({ crmRepository: crm });
  assert.equal(await contar('nichos', item('Estética')), 1, 'sem nomeNormalizado, normaliza o nome');
  assert.equal(await contar('nichos', { nome: 'qualquer', nomeNormalizado: 'estetica' }), 1, 'o normalizado manda');
  for (const vazio of [item(''), item('!!!'), { nome: '', nomeNormalizado: '' }, {}, null, undefined]) assert.equal(await contar('nichos', vazio), 0, JSON.stringify(vazio));
});

test('[CATUSO-4] só LÊ o CRM (list) e devolve só um NÚMERO: nunca grava, nunca devolve dado de registro; funciona com repositório síncrono e assíncrono', async () => {
  const chamadas = { list: 0, outras: [] };
  const base = crmCom([registro(1, { nicho: 'Estética', telefone: '00 00000-0000', email: 'contato@exemplo.test' })]);
  const espiao = new Proxy(base, { get: (alvo, nome) => (nome === 'list' ? () => (chamadas.list++, alvo.list()) : (...args) => (chamadas.outras.push(nome), alvo[nome](...args))) });
  const contar = createCrmCatalogUsageCounter({ crmRepository: espiao });
  const resultado = await contar('nichos', { nome: 'Estética', nomeNormalizado: 'estetica' });
  assert.equal(resultado, 1);
  assert.equal(typeof resultado, 'number');
  assert.deepEqual(chamadas, { list: 1, outras: [] });
  const assincrono = createCrmCatalogUsageCounter({ crmRepository: { list: async () => base.list() } });
  assert.equal(await assincrono('nichos', { nome: 'Estética', nomeNormalizado: 'estetica' }), 1);
});

test('[CATUSO-5] argumentos inválidos falham: sem repositório com list(), catálogo desconhecido (inclusive chaves de protótipo) ou um repositório que devolve algo que não é lista', async () => {
  for (const ruim of [undefined, {}, { crmRepository: null }, { crmRepository: {} }, { crmRepository: { list: 5 } }]) {
    assert.throws(() => createCrmCatalogUsageCounter(ruim), /exige \{ crmRepository \}/);
  }
  assert.throws(() => createCrmCatalogUsageCounter(), /exige \{ crmRepository \}/);
  const contar = createCrmCatalogUsageCounter({ crmRepository: crmCom([]) });
  for (const catalogo of ['clientes', '__proto__', 'constructor', undefined, 5]) await assert.rejects(() => contar(catalogo, item('x')), /catálogo desconhecido/, String(catalogo));
  const quebrado = createCrmCatalogUsageCounter({ crmRepository: { list: () => 'não é lista' } });
  await assert.rejects(() => quebrado('nichos', { nome: 'x', nomeNormalizado: 'x' }), /lista inválida/);
  const falha = createCrmCatalogUsageCounter({ crmRepository: { list: async () => { throw new Error('crm fora'); } } });
  await assert.rejects(() => falha('nichos', { nome: 'x', nomeNormalizado: 'x' }), /crm fora/);
});
