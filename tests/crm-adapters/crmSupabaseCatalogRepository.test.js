// O adapter Postgres/Supabase dos catálogos do CRM (src/crm-adapters/crmSupabaseCatalogRepository.js) — Fase 2B-1. NUNCA chama a rede real:
// tudo roda contra um PostgREST FALSO (tests/helpers/fakePostgrestCatalogs.js) que emula as garantias do banco (unicidade, gatilho de
// updated_at, RPC de reordenação). Passa pela MESMA suíte de contrato dos adapters locais, e tem casos próprios: formato das requisições,
// classificação de erros, sigilo da service_role e paridade com as definições do domínio.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSupabaseCatalogRepository, CATALOG_TABLES, CATALOG_REPOSITORY_ERROR: ADAPTER_ERROR, COMMON_COLUMNS, UPDATABLE_COMMON, REORDER_RPC } = require('../../src/crm-adapters/crmSupabaseCatalogRepository');
const { CATALOG_REPOSITORY_ERROR: PORT_ERROR, COMMON_UPDATABLE_FIELDS } = require('../../src/crm/catalogRepositoryPort');
const { CATALOG_DEFINITIONS, CATALOG_KEYS, COMMON_ITEM_FIELDS } = require('../../src/crm/catalogConstants');
const { createFakePostgrestCatalogs } = require('../helpers/fakePostgrestCatalogs');
const { runCatalogRepositoryContract, makeItem, uuid } = require('../helpers/catalogRepositoryContract');

const SEGREDO = 'SEGREDO-DA-SERVICE-ROLE-NAO-PODE-VAZAR';

function montar(opcoes = {}) {
  const fake = createFakePostgrestCatalogs({ serviceRoleKey: SEGREDO, ...opcoes });
  const repo = createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: SEGREDO, fetchImpl: fake.fetchImpl });
  return { fake, repo };
}

// O contrato comum — também com o NUMERIC voltando como texto (uma configuração possível do PostgREST).
runCatalogRepositoryContract('SUPABASE', () => montar().repo);
runCatalogRepositoryContract('SUPABASE-NUMERIC-TEXTO', () => montar({ numericAsString: true }).repo);

test('[CATSUPA-1] PARIDADE com o domínio: as tabelas e as colunas específicas de cada catálogo são exatamente as das definições; os campos comuns e os atualizáveis batem com a porta; os códigos de erro são cópias literais da porta', () => {
  assert.deepEqual(Object.keys(CATALOG_TABLES), [...CATALOG_KEYS]);
  for (const key of CATALOG_KEYS) {
    assert.equal(CATALOG_TABLES[key].table, CATALOG_DEFINITIONS[key].table, `${key}: tabela`);
    assert.deepEqual(Object.keys(CATALOG_TABLES[key].specific), [...CATALOG_DEFINITIONS[key].specificFields], `${key}: campos específicos`);
  }
  assert.deepEqual(Object.keys(COMMON_COLUMNS), [...COMMON_ITEM_FIELDS], 'os campos comuns, na mesma ordem');
  assert.deepEqual([...UPDATABLE_COMMON], [...COMMON_UPDATABLE_FIELDS]);
  assert.deepEqual({ ...ADAPTER_ERROR }, { ...PORT_ERROR }, 'R16 impede importar a porta: a cópia literal não pode divergir');
  assert.equal(REORDER_RPC, 'reorder_crm_catalog');
  for (const coluna of Object.values(COMMON_COLUMNS)) assert.match(coluna, /^[a-z_]+$/);
});

test('[CATSUPA-2] FORMATO DAS REQUISIÇÕES: tabela certa por catálogo, cabeçalhos de serviço, ordenação e filtro por id na consulta, Prefer return=representation — e NUNCA um DELETE', async () => {
  const { fake, repo } = montar();
  const tabela = { servicos: 'crm_services', nichos: 'crm_niches', origens: 'crm_lead_origins' };
  for (const catalog of CATALOG_KEYS) {
    const item = makeItem(catalog, 1, { nome: `Item de ${catalog}` });
    await repo.list(catalog);
    await repo.insert(catalog, item);
    await repo.getById(catalog, item.id);
    await repo.update(catalog, item.id, { descricao: 'x', atualizadoEm: '2026-10-12T12:30:00.000Z', atualizadoPorUserId: 'u', atualizadoPorNome: 'n' });
    await repo.reorder(catalog, [item.id], { atualizadoEm: '2026-10-12T12:40:00.000Z', atualizadoPorUserId: 'u', atualizadoPorNome: 'n' });
  }
  assert.deepEqual([...new Set(fake.calls.map((call) => call.method))].sort(), ['GET', 'PATCH', 'POST']);
  for (const call of fake.calls) {
    assert.equal(call.headers.apikey, SEGREDO);
    assert.equal(call.headers.Authorization, `Bearer ${SEGREDO}`);
    assert.equal(call.headers.Accept, 'application/json');
    assert.equal(new URL(call.url).origin, new URL(fake.url).origin, 'só fala com o projeto configurado');
    assert.doesNotMatch(call.url, new RegExp(SEGREDO), 'a chave nunca vai na URL');
    if (call.body !== undefined) assert.doesNotMatch(JSON.stringify(call.body), new RegExp(SEGREDO), 'nem no corpo');
  }
  for (const catalog of CATALOG_KEYS) {
    const doCatalogo = fake.calls.filter((call) => call.path === `/rest/v1/${tabela[catalog]}`);
    assert.deepEqual(doCatalogo.map((call) => call.method), ['GET', 'POST', 'GET', 'PATCH'], `${catalog}: list, insert, getById, update`);
  }
  const lista = fake.calls.find((call) => call.method === 'GET' && call.query.order);
  assert.deepEqual(lista.query, { select: '*', order: 'ordem.asc,nome_normalizado.asc,id.asc' });
  const um = fake.calls.find((call) => call.method === 'GET' && call.query.id);
  assert.equal(um.query.limit, '1');
  assert.match(um.query.id, /^eq\.(service|niche|origin):/);
  for (const call of fake.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/rest/v1/crm_'))) {
    assert.equal(call.headers.Prefer, 'return=representation');
    assert.equal(call.headers['Content-Type'], 'application/json');
  }
});

test('[CATSUPA-3] INSERT: o corpo usa as colunas em snake_case (inclusive created_at/updated_at e os responsáveis), só com o que o item tem — sem `seq`, sem campos inventados', async () => {
  const { fake, repo } = montar();
  await repo.insert('servicos', makeItem('servicos', 1, { nome: 'Site', descricao: 'D', categoria: 'Web', precoReferencia: 1500.5, tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' }));
  const post = fake.calls.find((call) => call.method === 'POST');
  assert.deepEqual(post.body, {
    id: `service:${uuid(1)}`,
    nome: 'Site',
    nome_normalizado: 'site',
    descricao: 'D',
    ativo: true,
    ordem: 1,
    created_at: '2026-10-12T12:00:00.000Z',
    updated_at: '2026-10-12T12:00:00.000Z',
    created_by_user_id: 'user-a',
    created_by_name: 'Admin A',
    updated_by_user_id: 'user-a',
    updated_by_name: 'Admin A',
    categoria: 'Web',
    preco_referencia: 1500.5,
    tipo_cobranca: 'RECORRENTE',
    recorrencia: 'MENSAL',
  });
  await repo.insert('nichos', makeItem('nichos', 1, { nome: 'Estética', cor: 'azul' }));
  assert.equal(fake.calls.filter((call) => call.method === 'POST').at(-1).body.cor, 'azul');
});

test('[CATSUPA-4] UPDATE: só as colunas do patch vão no corpo; `atualizadoEm` NÃO vai (o gatilho do banco o define); um patch só com a data vira uma consulta, nunca um PATCH vazio; o id vai como filtro codificado, sem injetar parâmetros', async () => {
  const { fake, repo } = montar();
  const item = await repo.insert('nichos', makeItem('nichos', 1, { nome: 'Estética' }));
  fake.calls.length = 0;
  const atualizado = await repo.update('nichos', item.id, { cor: 'rosa', atualizadoEm: '2020-01-01T00:00:00.000Z', atualizadoPorUserId: 'user-b', atualizadoPorNome: 'Admin B' });
  const patch = fake.calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch.body, { cor: 'rosa', updated_by_user_id: 'user-b', updated_by_name: 'Admin B' });
  assert.equal(patch.query.id, `eq.${item.id}`);
  assert.ok(Date.parse(atualizado.atualizadoEm) > Date.parse('2026-10-12T13:00:00.000Z'), 'a data veio do banco (gatilho), não do cliente');
  assert.notEqual(atualizado.atualizadoEm, '2020-01-01T00:00:00.000Z');

  fake.calls.length = 0;
  const so = await repo.update('nichos', item.id, { atualizadoEm: '2026-10-12T18:00:00.000Z' });
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET'], 'sem coluna para gravar: só consulta');
  assert.equal(so.id, item.id);

  // um id com caracteres de URL não vira outro parâmetro
  fake.calls.length = 0;
  assert.equal(await repo.update('nichos', 'niche:1&select=senha&id=eq.2', { cor: 'azul' }), null);
  const url = new URL(fake.calls[0].url);
  assert.deepEqual([...url.searchParams.keys()], ['id']);
  assert.equal(url.searchParams.get('id'), 'eq.niche:1&select=senha&id=eq.2');
});

test('[CATSUPA-5] campos que não podem mudar (e os de outro catálogo) falham ANTES de qualquer chamada de rede', async () => {
  const { fake, repo } = montar();
  const item = await repo.insert('servicos', makeItem('servicos', 1, { nome: 'Serviço' }));
  fake.calls.length = 0;
  for (const campo of ['id', 'criadoEm', 'criadoPorUserId', 'cor', 'canal', 'inventado']) {
    await assert.rejects(async () => repo.update('servicos', item.id, { [campo]: 'x' }), /não pode ser alterado neste catálogo/, campo);
  }
  await assert.rejects(async () => repo.update('servicos', item.id, 'texto'), /exige um patch/);
  await assert.rejects(async () => repo.update('servicos', '__proto__', { descricao: 'x' }), /id não permitido/);
  await assert.rejects(async () => repo.list('clientes'), /catálogo desconhecido/);
  await assert.rejects(async () => repo.insert('servicos', null), /exige um item/);
  await assert.rejects(async () => repo.reorder('servicos', [1], {}), /lista de ids/);
  assert.deepEqual(fake.calls, [], 'nenhuma requisição foi feita');
});

test('[CATSUPA-6] REORDENAR: uma única chamada ao RPC reorder_crm_catalog com o catálogo, a lista e o responsável — nunca vários PATCHes soltos; sem responsável, vai null', async () => {
  const { fake, repo } = montar();
  const a = await repo.insert('origens', makeItem('origens', 1, { nome: 'Alfa', ordem: 0 }));
  const b = await repo.insert('origens', makeItem('origens', 2, { nome: 'Beta', ordem: 1 }));
  fake.calls.length = 0;
  await repo.reorder('origens', [b.id, a.id], { atualizadoEm: '2026-10-12T19:00:00.000Z', atualizadoPorUserId: 'user-b', atualizadoPorNome: 'Admin B' });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].method, 'POST');
  assert.equal(fake.calls[0].path, '/rest/v1/rpc/reorder_crm_catalog');
  assert.deepEqual(fake.calls[0].body, { p_catalog: 'origens', p_ordered_ids: [b.id, a.id], p_actor_user_id: 'user-b', p_actor_name: 'Admin B' });
  fake.calls.length = 0;
  await repo.reorder('origens', [a.id, b.id], undefined);
  assert.deepEqual(fake.calls[0].body, { p_catalog: 'origens', p_ordered_ids: [a.id, b.id], p_actor_user_id: null, p_actor_name: null });
});

test('[CATSUPA-7] CLASSIFICAÇÃO DE ERROS: só unicidade do nome normalizado (DUPLICATE_NAME) e id inexistente no RPC (NOT_FOUND) recebem código; todo o resto sai SEM código — e nenhuma mensagem contém a chave', async () => {
  const { fake, repo } = montar();
  const a = await repo.insert('nichos', makeItem('nichos', 1, { nome: 'Estética' }));
  const semCodigo = async (task, mensagem) => {
    let erro;
    try {
      await task();
    } catch (error) {
      erro = error;
    }
    assert.ok(erro, mensagem);
    assert.equal(erro.code, undefined, `${mensagem}: sem código`);
    assert.doesNotMatch(`${erro.message}\n${erro.stack}`, new RegExp(SEGREDO), `${mensagem}: a chave não vaza`);
    return erro;
  };
  const comCodigo = async (task, codigo) => {
    try {
      await task();
    } catch (error) {
      assert.equal(error.code, codigo);
      assert.doesNotMatch(error.message, new RegExp(SEGREDO));
      return;
    }
    assert.fail('esperava falha');
  };
  await comCodigo(() => repo.insert('nichos', makeItem('nichos', 2, { nome: 'ESTETICA' })), PORT_ERROR.DUPLICATE_NAME);
  await comCodigo(() => repo.reorder('nichos', [a.id, 'niche:00000000-0000-4000-8000-000000000999'], {}), PORT_ERROR.NOT_FOUND);
  // chave primária repetida: é um 23505, mas NÃO do nome — sem código
  await semCodigo(() => repo.insert('nichos', { ...makeItem('nichos', 1, { nome: 'Outro nome totalmente diferente' }) }), 'id repetido (pkey)');

  // respostas do PostgREST fabricadas à mão
  const resposta = (status, corpo, texto) => ({ ok: status < 400, status, text: async () => (texto !== undefined ? texto : JSON.stringify(corpo)) });
  const com = (res) => createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: SEGREDO, fetchImpl: async () => res });
  const e400 = await semCodigo(() => com(resposta(400, { code: '23514', message: 'new row violates check constraint "crm_niches_cor_check"' })).insert('nichos', makeItem('nichos', 5, { nome: 'Cinco' })), 'CHECK violado');
  assert.match(e400.message, /PostgREST recusou a operação/);
  const e401 = await semCodigo(() => com(resposta(401, { message: 'JWT inválido' })).list('nichos'), '401');
  assert.match(e401.message, /JWT inválido/);
  await semCodigo(() => com(resposta(404, { code: 'PGRST205', message: "Could not find the table 'public.crm_niches'" })).list('nichos'), 'tabela ausente (migration não aplicada)');
  const e502 = await semCodigo(() => com(resposta(502, null, '<html>Bad gateway SEGREDO-DE-PROXY</html>')).list('nichos'), 'corpo que não é JSON');
  assert.match(e502.message, /HTTP 502/);
  assert.doesNotMatch(e502.message, /SEGREDO-DE-PROXY|html/i, 'o texto de uma resposta que não é JSON nunca é repassado');
  await semCodigo(() => com(resposta(500, { code: 'XX000', message: 'erro interno' })).list('nichos'), '5xx');
  // um 23505 que não é sobre o nome, e um P0001 que não é "inexistente"
  await semCodigo(() => com(resposta(409, { code: '23505', message: 'duplicate key value violates unique constraint "outra_coisa_key"', details: 'Key (algo)=(x) already exists.' })).insert('nichos', makeItem('nichos', 6, { nome: 'Seis' })), '23505 de outra restrição');
  await semCodigo(() => com(resposta(400, { code: 'P0001', message: 'reorder_crm_catalog: ids repetidos' })).reorder('nichos', [a.id], {}), 'P0001 de lista repetida');
  // o PostgREST não devolve o item gravado
  await semCodigo(() => com(resposta(201, [])).insert('nichos', makeItem('nichos', 7, { nome: 'Sete' })), 'insert sem representação');
  // falha de rede: só o TIPO do erro, nunca a mensagem original
  const rede = createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: SEGREDO, fetchImpl: async () => { const erro = new TypeError(`fetch failed (conectando com ${SEGREDO})`); throw erro; } });
  const eRede = await semCodigo(() => rede.list('nichos'), 'rede');
  assert.match(eRede.message, /falha de rede ao falar com o PostgREST \(TypeError\)/);
});

test('[CATSUPA-8] NORMALIZAÇÃO DAS RESPOSTAS: timestamptz com microssegundos e "+00:00" volta ISO em UTC com milissegundos; NUMERIC como texto vira número; colunas ausentes viram null; ativo só é true se for true', async () => {
  const fake = createFakePostgrestCatalogs({ serviceRoleKey: SEGREDO });
  const linha = {
    id: `service:${uuid(1)}`, nome: 'Site', nome_normalizado: 'site', descricao: null, ativo: true, ordem: '3',
    created_at: '2026-10-12T12:00:00.123456+00:00', updated_at: '2026-10-12T09:30:00.5-03:00',
    created_by_user_id: null, created_by_name: null, updated_by_user_id: null, updated_by_name: null,
    categoria: null, preco_referencia: '1500.50', tipo_cobranca: null, recorrencia: null,
  };
  const repo = createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: SEGREDO, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify([linha, { ...linha, id: `service:${uuid(2)}`, ativo: 'true', preco_referencia: null, created_at: 'não é data' }]) }) });
  const [um, dois] = await repo.list('servicos');
  assert.equal(um.criadoEm, '2026-10-12T12:00:00.123Z');
  assert.equal(um.atualizadoEm, '2026-10-12T12:30:00.500Z', 'o fuso é convertido para UTC');
  assert.equal(um.precoReferencia, 1500.5);
  assert.equal(um.ordem, 3);
  assert.equal(um.criadoPorNome, null);
  assert.equal(dois.ativo, false, 'só o booleano true é ativo');
  assert.equal(dois.precoReferencia, null);
  assert.equal(dois.criadoEm, null, 'uma data ilegível vira null, nunca "Invalid Date"');
  const vazia = createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: SEGREDO, fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'null' }) });
  assert.deepEqual(await vazia.list('nichos'), [], 'uma resposta que não é lista vira lista vazia');
  assert.equal(await vazia.getById('nichos', 'niche:x'), null);
});

test('[CATSUPA-9] CONFIGURAÇÃO: config explícita (a URL perde as barras finais) ou lida de env — exige as DUAS variáveis, https e cita só o NOME da que falta; nunca cria o repositório com metade da configuração; fetchImpl precisa ser função', async () => {
  const fake = createFakePostgrestCatalogs({ serviceRoleKey: SEGREDO });
  const repo = createSupabaseCatalogRepository({ url: `${fake.url}///`, serviceRoleKey: SEGREDO, fetchImpl: fake.fetchImpl });
  await repo.list('nichos');
  assert.equal(new URL(fake.calls[0].url).pathname, '/rest/v1/crm_niches', 'sem barras duplicadas');

  const doEnv = (env) => () => createSupabaseCatalogRepository({ env, fetchImpl: fake.fetchImpl });
  assert.throws(doEnv({}), /SUPABASE_URL não está configurada/);
  assert.throws(doEnv({ SUPABASE_URL: fake.url }), /SUPABASE_SERVICE_ROLE_KEY não está configurada/);
  assert.throws(doEnv({ SUPABASE_URL: 'http://inseguro.test', SUPABASE_SERVICE_ROLE_KEY: SEGREDO }), /deve ser https/);
  assert.throws(doEnv({ SUPABASE_URL: 'não é url', SUPABASE_SERVICE_ROLE_KEY: SEGREDO }), /não é uma URL válida/);
  for (const env of [{}, { SUPABASE_URL: fake.url }, { SUPABASE_URL: 'http://x.test', SUPABASE_SERVICE_ROLE_KEY: SEGREDO }]) {
    try {
      doEnv(env)();
    } catch (erro) {
      assert.doesNotMatch(erro.message, new RegExp(SEGREDO), 'nenhuma mensagem de configuração traz a chave');
    }
  }
  const ok = createSupabaseCatalogRepository({ env: { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: SEGREDO }, fetchImpl: fake.fetchImpl });
  assert.deepEqual(await ok.list('origens'), []);
  // config explícita incompleta cai na leitura do ambiente (nunca um modo parcial misturado)
  assert.throws(() => createSupabaseCatalogRepository({ url: fake.url, fetchImpl: fake.fetchImpl, env: {} }), /SUPABASE_URL não está configurada/);
  for (const ruim of [null, 'fetch', 5, {}]) assert.throws(() => createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: SEGREDO, fetchImpl: ruim }), /fetchImpl deve ser uma função/);
  assert.equal(Object.isFrozen(repo), true);
  assert.deepEqual(Object.keys(repo).sort(), ['getById', 'insert', 'list', 'reorder', 'update']);
});

test('[CATSUPA-10] sem fetchImpl o adapter usa o fetch GLOBAL (e os testes o substituem — nenhuma rede real); criar o adapter não faz nenhuma chamada (preguiçoso)', async (t) => {
  const fake = createFakePostgrestCatalogs({ serviceRoleKey: SEGREDO });
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  t.after(() => {
    globalThis.fetch = original;
  });
  const repo = createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: SEGREDO });
  assert.equal(fake.calls.length, 0, 'criar não chama a rede');
  assert.deepEqual(await repo.list('servicos'), []);
  assert.equal(fake.calls.length, 1);
});
