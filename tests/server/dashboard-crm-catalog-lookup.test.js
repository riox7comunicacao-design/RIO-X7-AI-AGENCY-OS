// CRM 5.0, Fase 2B-3.1 — a CONSULTA aos catálogos pelos formulários do CRM (dashboard/crm-catalog-lookup.mjs): o que é lido, o que é guardado, quando é lido de novo, como as falhas
// são classificadas e a NORMALIZAÇÃO — uma cópia da regra do servidor, aqui conferida contra ela (paridade). Só dados fictícios, DOM de teste e API falsa: nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeCatalogName: normalizeOnServer } = require('../../src/crm/catalogDomain');
const { createCrmCatalogUsageCounter } = require('../../src/services/catalogUsage');

const loadLookup = () => import('../../dashboard/crm-catalog-lookup.mjs');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');

// Um relógio que o teste move.
const relogio = (inicio = 1_000_000) => {
  let agora = inicio;
  return { now: () => agora, avancar: (ms) => { agora += ms; } };
};

async function montar({ catalogs, canManage = false, canRead = true, ttlMs, clock = relogio(), bus = null } = {}) {
  const { createFakeApi, catalogItem } = await loadFixtures();
  const { createCatalogLookup } = await loadLookup();
  const api = createFakeApi({
    catalogs: catalogs || {
      nichos: [catalogItem('nichos', 'Psicologia'), catalogItem('nichos', 'Odontologia'), catalogItem('nichos', 'Academias', { ativo: false })],
      origens: [catalogItem('origens', 'Indicação')],
      servicos: [],
    },
  });
  const lookup = createCatalogLookup({ api, bus, canRead, canManage, now: clock.now, ...(ttlMs ? { ttlMs } : {}) });
  return { api, lookup, clock, catalogItem };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// NORMALIZAÇÃO — paridade com o servidor
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATLK-1] NORMALIZAÇÃO: a cópia do Dashboard dá o MESMO resultado que a regra do servidor (src/crm/catalogDomain.js) — casos conhecidos, formas Unicode, símbolos, espaços estranhos e 3 mil textos sorteados', async () => {
  const { normalizeCatalogName } = await loadLookup();
  const conhecidos = [
    'Estética', 'estetica', ' ESTÉTICA ', 'Clínicas de Estética', 'clinicas-de-estetica', 'C#', 'C++', 'C', 'Gestão de redes sociais', 'Anúncio no Instagram',
    'São João da Boa Vista', 'ÇÃÕÉÜ', 'çãõéü', 'a  b   c', '\t\nolá\r\n', 'ǅ', 'ß', 'İstanbul', 'ı', 'Ωmega', '日本語', 'العربية', '😀 emoji', '---', '???', '', '   ', '1ª fase', 'nº 5', "O'Brien",
    'é', 'é', 'a​b', 'a b', 'ﬁ', 'Ⅻ', '１２３', 'ＡＢＣ', 'x'.repeat(500),
  ];
  for (const texto of conhecidos) assert.equal(normalizeCatalogName(texto), normalizeOnServer(texto), JSON.stringify(texto));
  // NFC e NFD do mesmo texto dão o mesmo resultado, e nos dois lados
  assert.equal(normalizeCatalogName('Estética'), normalizeCatalogName('Estetíca'));
  assert.equal(normalizeOnServer('Estética'), normalizeOnServer('Estetíca'));
  // o que não é texto vira '' nos dois lados
  for (const valor of [null, undefined, 7, {}, [], true]) assert.equal(normalizeCatalogName(valor), normalizeOnServer(valor));
  // sorteio determinístico (sem Math.random: o teste é sempre o mesmo)
  let semente = 20261013;
  const proximo = () => {
    semente = (semente * 1664525 + 1013904223) >>> 0;
    return semente;
  };
  const alfabeto = ['a', 'B', 'z', 'É', 'ç', 'ã', 'Ü', '0', '9', ' ', ' ', '-', '_', '.', ',', '/', '#', '+', '&', '\t', '́', ' ', 'ß', 'ı', 'İ', 'Ω', '日', '😀', 'ﬁ', 'Ⅻ', '１'];
  for (let indice = 0; indice < 3000; indice += 1) {
    const tamanho = proximo() % 24;
    let texto = '';
    for (let letra = 0; letra < tamanho; letra += 1) texto += alfabeto[proximo() % alfabeto.length];
    assert.equal(normalizeCatalogName(texto), normalizeOnServer(texto), JSON.stringify(texto));
  }
});

test('[CATLK-2] PARIDADE DE USO: dizer que um texto "corresponde" a um item no Dashboard é o MESMO que o contador de uso do servidor contar o registro como uso do item (a base da trava de renomeação)', async () => {
  const { classifyValue, simplifyCatalogItems } = await loadLookup();
  const { catalogItem } = await loadFixtures();
  const nomes = ['Estética', 'Clínicas de Estética', 'C#', 'Gestão de redes sociais', 'Anúncio no Instagram', 'São João'];
  const textos = ['Estética', 'estetica', ' ESTÉTICA ', 'estética!', 'Estetica clinica', 'clinicas de estetica', 'Clinicas-de-Estetica', 'c', 'C++', 'gestao de redes sociais', 'Gestão  de redes', 'anuncio no instagram', 'Sao Joao', 'são joão da boa vista', '', '   ', '???'];
  for (const nome of nomes) {
    const bruto = catalogItem('nichos', nome);
    const itens = simplifyCatalogItems([bruto]);
    for (const texto of textos) {
      const noServidor = await createCrmCatalogUsageCounter({ crmRepository: { list: async () => [{ nicho: texto }] } })('nichos', { nome, nomeNormalizado: bruto.nomeNormalizado });
      const aqui = classifyValue(texto, itens).kind;
      assert.equal(aqui === 'official' || aqui === 'different-spelling', noServidor === 1, `${JSON.stringify(texto)} × ${JSON.stringify(nome)} (${aqui})`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// O QUE SE GUARDA E COMO UM TEXTO É CLASSIFICADO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATLK-3] SÓ O NECESSÁRIO PARA ESCOLHER: de cada item ficam id, nome, ativo e a chave normalizada — nenhum preço de referência, cor, canal, descrição nem campo de auditoria; entradas que não são item são ignoradas', async () => {
  const { simplifyCatalogItems } = await loadLookup();
  const { catalogItem } = await loadFixtures();
  const servico = catalogItem('servicos', 'Gestão de redes sociais', { precoReferencia: 4321.5, categoria: 'Marketing' });
  const nicho = catalogItem('nichos', 'Psicologia', { cor: 'violeta' });
  const itens = simplifyCatalogItems([servico, nicho, null, 7, 'x', {}, { id: 'x' }, { nome: 'sem id' }, { id: ' ', nome: 'em branco' }, { id: 'a', nome: '   ' }, { ...nicho }, { id: 'niche:zz', nome: 'Inativo', ativo: 'sim' }]);
  assert.deepEqual(itens.map((item) => Object.keys(item).sort()), itens.map(() => ['ativo', 'id', 'key', 'nome']), 'só quatro propriedades');
  assert.deepEqual(itens.map((item) => item.nome), ['Gestão de redes sociais', 'Psicologia', 'Inativo'], 'duplicado pelo id, vazios e lixo ficam de fora');
  assert.deepEqual(itens.map((item) => item.ativo), [true, true, false], 'só `ativo === true` é ativo');
  assert.equal(itens[0].key, 'gestao de redes sociais');
  assert.ok(Object.isFrozen(itens[0]));
  const texto = JSON.stringify(itens);
  for (const proibido of ['4321', 'precoReferencia', 'violeta', 'cor', 'canal', 'descricao', 'criadoPor', 'atualizadoPor', 'Marketing']) assert.ok(!texto.includes(proibido), `não guarda ${proibido}`);
  assert.deepEqual(simplifyCatalogItems('não é lista'), []);
  assert.deepEqual(simplifyCatalogItems(undefined), []);
});

test('[CATLK-4] CLASSIFICAÇÃO de um texto já salvo: vazio, oficial (nome exato de item ativo), grafia diferente (casa só normalizado), desativado (só quando a lista traz os desativados) e fora do catálogo — nunca "desativado" por suposição', async () => {
  const { classifyValue, simplifyCatalogItems } = await loadLookup();
  const { catalogItem } = await loadFixtures();
  const todos = simplifyCatalogItems([catalogItem('nichos', 'Estética'), catalogItem('nichos', 'Odontologia'), catalogItem('nichos', 'Academias', { ativo: false })]);
  const soAtivos = todos.filter((item) => item.ativo);
  const tipo = (texto, itens = todos) => classifyValue(texto, itens).kind;
  assert.equal(tipo(''), 'empty');
  assert.equal(tipo('   '), 'empty');
  assert.equal(tipo(null), 'empty');
  assert.equal(tipo(42), 'empty');
  assert.equal(tipo('Estética'), 'official');
  assert.equal(tipo('  Estética  '), 'official', 'espaços nas pontas não contam (o CRM os remove ao gravar)');
  assert.equal(tipo('estetica'), 'different-spelling');
  assert.equal(tipo('ESTÉTICA'), 'different-spelling', 'a caixa conta: o nome oficial é um só');
  assert.equal(classifyValue('estetica', todos).item.nome, 'Estética', 'traz a grafia oficial');
  assert.equal(tipo('Academias'), 'inactive');
  assert.equal(tipo('academias'), 'inactive');
  assert.equal(classifyValue('Academias', todos).item.nome, 'Academias');
  assert.equal(tipo('Academias', soAtivos), 'outside', 'sem a lista dos desativados NÃO se presume que ausente = desativado: é "fora do catálogo"');
  assert.equal(tipo('Clínica Popular'), 'outside');
  assert.equal(tipo('???'), 'outside', 'um texto só de símbolos nunca casa com nada');
  assert.equal(tipo('Estética', []), 'outside');
  assert.equal(classifyValue('Estética', undefined).kind, 'outside');
  assert.equal(classifyValue('Estética', null).kind, 'outside');
  // um item ativo e um desativado com a mesma chave (não deveria existir): o ativo vence
  const mesmo = simplifyCatalogItems([catalogItem('nichos', 'Dentistas', { ativo: false }), catalogItem('nichos', 'Dentistas.')]);
  assert.equal(classifyValue('dentistas', mesmo).kind, 'different-spelling');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A CONSULTA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATLK-5] CONSULTA aos três catálogos pelos endpoints existentes: quem só lê pede os ativos; quem administra pede também os desativados (?todos=1); nada é lido antes de alguém pedir; o resultado é congelado', async () => {
  const leitor = await montar({ canManage: false });
  assert.equal(leitor.api.callsOf('listCatalog').length, 0, 'preguiçoso: nada é lido até um formulário pedir');
  assert.equal(leitor.lookup.peek('nichos').status, 'idle');
  const [nichos, origens, servicos] = await Promise.all(['nichos', 'origens', 'servicos'].map((catalogo) => leitor.lookup.ensure(catalogo)));
  assert.deepEqual(leitor.api.callsOf('listCatalog').map((c) => c.args).sort(), [['nichos', {}], ['origens', {}], ['servicos', {}]].sort());
  assert.equal(nichos.status, 'ready');
  assert.deepEqual(nichos.items.map((i) => i.nome), ['Psicologia', 'Odontologia'], 'quem só lê recebe só os ativos');
  assert.equal(origens.status, 'ready');
  assert.equal(servicos.status, 'empty', 'respondeu, mas não há item ativo');
  assert.ok(Object.isFrozen(nichos) && Object.isFrozen(nichos.items) && Object.isFrozen(nichos.activeItems));
  assert.equal(nichos.knowsInactive, false);

  const admin = await montar({ canManage: true });
  const comTodos = await admin.lookup.ensure('nichos');
  assert.deepEqual(admin.api.callsOf('listCatalog')[0].args, ['nichos', { todos: true }]);
  assert.deepEqual(comTodos.items.map((i) => [i.nome, i.ativo]), [['Psicologia', true], ['Odontologia', true], ['Academias', false]]);
  assert.deepEqual(comTodos.activeItems.map((i) => i.nome), ['Psicologia', 'Odontologia'], 'a lista de escolha tem só os ativos');
  assert.equal(comTodos.knowsInactive, true);
  assert.throws(() => admin.lookup.peek('clientes'), /catálogo desconhecido/);
});

test('[CATLK-6] SEM CONSULTAS DUPLICADAS: pedidos simultâneos viram UM; enquanto o cache vale nada é lido de novo; vencido (ou forçado) lê de novo; ler o estado (peek) nunca consulta', async () => {
  const t = await montar({ ttlMs: 60_000 });
  const retida = t.api.hold('listCatalog');
  const a = t.lookup.ensure('nichos');
  const b = t.lookup.ensure('nichos');
  const c = t.lookup.ensure('nichos');
  await retida.arrived;
  assert.equal(t.lookup.peek('nichos').status, 'loading');
  assert.equal(t.lookup.peek('nichos').refreshing, true);
  retida.release();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(t.api.callsOf('listCatalog').length, 1, 'três pedidos, uma requisição');
  assert.ok(ra === rb && rb === rc, 'todos recebem o mesmo resultado');

  await t.lookup.ensure('nichos');
  t.lookup.peek('nichos');
  assert.equal(t.api.callsOf('listCatalog').length, 1, 'cache valendo: nada novo');

  t.clock.avancar(59_999);
  await t.lookup.ensure('nichos');
  assert.equal(t.api.callsOf('listCatalog').length, 1, 'ainda vale');
  t.clock.avancar(2);
  await t.lookup.ensure('nichos');
  assert.equal(t.api.callsOf('listCatalog').length, 2, 'vencido: lê de novo');
  await t.lookup.ensure('nichos', { force: true });
  assert.equal(t.api.callsOf('listCatalog').length, 3, '"Tentar novamente" força');
  await t.lookup.ensure('origens');
  assert.equal(t.api.callsOf('listCatalog').length, 4, 'cada catálogo tem o seu cache');
});

test('[CATLK-7] FALHAS classificadas: 503 = indisponível; falha de rede = transitória (NÃO é "estrutura ausente"); outros erros e resposta torta = erro — e NENHUMA é guardada como definitiva (a próxima abertura tenta de novo)', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar();
  const falha = (catalogo, erro) => { t.api.store.catalogFailures[catalogo] = erro; };
  const limpa = (catalogo) => { delete t.api.store.catalogFailures[catalogo]; };

  falha('nichos', new ApiError(503, 'CRM_CATALOG_PERSISTENCE', 'x'));
  assert.equal((await t.lookup.ensure('nichos')).status, 'unavailable');
  falha('nichos', new ApiError(404, 'CRM_CATALOG_PERSISTENCE', 'x'));
  assert.equal((await t.lookup.ensure('nichos')).status, 'error', '404 é um erro qualquer');
  falha('nichos', new ApiError(500, 'CRM_CATALOG_PERSISTENCE', 'x'));
  assert.equal((await t.lookup.ensure('nichos')).status, 'unavailable', 'o código de persistência também conta');
  falha('nichos', new ApiError(0, 'NETWORK', ''));
  assert.equal((await t.lookup.ensure('nichos')).status, 'network');
  falha('nichos', new ApiError(500, 'HTTP_500', ''));
  assert.equal((await t.lookup.ensure('nichos')).status, 'error');
  falha('nichos', new ApiError(403, 'FORBIDDEN', ''));
  assert.equal((await t.lookup.ensure('nichos')).status, 'error');
  falha('nichos', new ApiError(401, 'UNAUTHENTICATED', ''));
  assert.equal((await t.lookup.ensure('nichos')).status, 'error', '401: o login cuida; aqui só não há opções');
  falha('nichos', new Error('qualquer coisa'));
  assert.equal((await t.lookup.ensure('nichos')).status, 'error');
  assert.deepEqual(t.lookup.peek('nichos').items, [], 'falha nunca deixa opções para trás');
  assert.equal(t.api.callsOf('listCatalog').length, 8, 'uma falha não vira cache: cada pedido tentou de novo');

  limpa('nichos');
  const recuperou = await t.lookup.ensure('nichos');
  assert.equal(recuperou.status, 'ready');
  assert.equal(recuperou.items.length, 2);

  // resposta torta
  const torta = await montar();
  torta.api.listCatalog = async () => ({ itens: [] });
  assert.equal((await torta.lookup.ensure('nichos')).status, 'error');
  torta.api.listCatalog = async () => null;
  assert.equal((await torta.lookup.ensure('nichos')).status, 'error');
});

test('[CATLK-8] UMA RELEITURA QUE FALHA nunca derruba o que já se sabia: as opções continuam, e a próxima abertura tenta de novo', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ ttlMs: 1000 });
  assert.equal((await t.lookup.ensure('nichos')).status, 'ready');
  t.clock.avancar(5000);
  t.api.store.catalogFailures.nichos = new ApiError(0, 'NETWORK', '');
  const depois = await t.lookup.ensure('nichos');
  assert.equal(depois.status, 'ready', 'continua com as opções que tinha');
  assert.equal(depois.items.length, 2);
  delete t.api.store.catalogFailures.nichos;
  await t.lookup.ensure('nichos');
  assert.equal(t.api.callsOf('listCatalog').length, 3, 'falhou uma vez e a abertura seguinte tentou de novo (não ficou "fresco" por engano)');
});

test('[CATLK-9] SEM INTEGRAÇÃO: sem permissão de leitura, ou com uma API sem listCatalog, o estado é "off" e NENHUMA chamada é feita', async () => {
  const semLeitura = await montar({ canRead: false });
  assert.equal(semLeitura.lookup.enabled, false);
  assert.equal(semLeitura.lookup.peek('nichos').status, 'off');
  assert.equal((await semLeitura.lookup.ensure('nichos')).status, 'off');
  assert.equal(semLeitura.api.callsOf('listCatalog').length, 0);

  const { createCatalogLookup } = await loadLookup();
  const { createFakeApi } = await loadFixtures();
  const semChamada = createCatalogLookup({ api: createFakeApi({ items: [] }), canRead: true });
  assert.equal(semChamada.enabled, false);
  assert.equal((await semChamada.ensure('origens')).status, 'off');
  assert.equal(createCatalogLookup({ api: null }).enabled, false);
  assert.equal(createCatalogLookup().enabled, false);
});

test('[CATLK-10] ATUALIZAÇÃO por aviso (crm-catalogs:changed) e SEM POLLING: o aviso só invalida o cache; relê na hora SÓ se algum formulário aberto espera aquele catálogo; sem catálogo no aviso, invalida todos; destruir solta o barramento', async () => {
  const { createDataBus } = await loadUi();
  const bus = createDataBus();
  const t = await montar({ bus });
  await t.lookup.ensure('nichos');
  await t.lookup.ensure('origens');
  assert.equal(t.api.callsOf('listCatalog').length, 2);

  bus.publish('crm-catalogs:changed', { catalog: 'nichos', action: 'create', id: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.api.callsOf('listCatalog').length, 2, 'ninguém esperando: nada é lido agora');
  await t.lookup.ensure('nichos');
  assert.equal(t.api.callsOf('listCatalog').length, 3, 'a próxima abertura relê o catálogo que mudou');
  await t.lookup.ensure('origens');
  assert.equal(t.api.callsOf('listCatalog').length, 3, 'o outro catálogo continua valendo');

  const recebidos = [];
  const cancelar = t.lookup.subscribe('nichos', (estado) => recebidos.push(estado.status));
  assert.equal(t.lookup.listenerCount('nichos'), 1);
  t.api.store.catalogs.nichos.push(t.catalogItem('nichos', 'Fisioterapia'));
  bus.publish('crm-catalogs:changed', { catalog: 'nichos', action: 'create', id: 'y' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.api.callsOf('listCatalog').length, 4, 'há formulário esperando: relê uma vez');
  assert.equal(t.lookup.peek('nichos').items.length, 3, 'Psicologia, Odontologia e a nova, Fisioterapia (quem só lê não vê o desativado)');
  assert.ok(recebidos.includes('ready'), 'o formulário foi avisado');
  cancelar();
  assert.equal(t.lookup.listenerCount('nichos'), 0);

  bus.publish('crm-catalogs:changed', {});
  bus.publish('crm-catalogs:changed', { catalog: 'inexistente' });
  bus.publish('crm-catalogs:changed');
  await t.lookup.ensure('nichos');
  await t.lookup.ensure('origens');
  await t.lookup.ensure('servicos');
  assert.equal(t.api.callsOf('listCatalog').length, 4 + 3, 'aviso sem catálogo (ou com um desconhecido) invalida os três');

  t.lookup.destroy();
  const antes = t.api.callsOf('listCatalog').length;
  bus.publish('crm-catalogs:changed', { catalog: 'nichos' });
  assert.equal((await t.lookup.ensure('nichos')).catalog, 'nichos');
  assert.equal(t.api.callsOf('listCatalog').length, antes, 'destruído: não escuta nem lê mais');
});

test('[CATLK-11] UM AVISO DURANTE A LEITURA não perde a mudança: a leitura em andamento termina, e (com formulário esperando) vem uma nova, só uma — sem laço', async () => {
  const { createDataBus } = await loadUi();
  const bus = createDataBus();
  const t = await montar({ bus });
  t.lookup.subscribe('nichos', () => {});
  const retida = t.api.hold('listCatalog');
  const primeira = t.lookup.ensure('nichos');
  await retida.arrived;
  t.api.store.catalogs.nichos.push(t.catalogItem('nichos', 'Nutrição'));
  bus.publish('crm-catalogs:changed', { catalog: 'nichos' });
  retida.release();
  await primeira;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.api.callsOf('listCatalog').length, 2, 'uma leitura a mais, não um laço');
  assert.ok(t.lookup.peek('nichos').items.some((item) => item.nome === 'Nutrição'), 'a mudança chegou');
});

test('[CATLK-12] SEM POLLING NEM TEMPORIZADOR: o módulo e o campo não usam setInterval, setTimeout, setImmediate nem requestAnimationFrame; só leem o que existe (listCatalog); e nunca escrevem em catálogo', () => {
  for (const arquivo of [['dashboard', 'crm-catalog-lookup.mjs'], ['dashboard', 'ui', 'catalogField.mjs']]) {
    const codigo = read(...arquivo).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(codigo, /setInterval|setTimeout|setImmediate|requestAnimationFrame|queueMicrotask/, arquivo.join('/'));
    assert.doesNotMatch(codigo, /createCatalogItem|updateCatalogItem|activateCatalogItem|deactivateCatalogItem|reorderCatalog|getCatalogItem/, `${arquivo.join('/')}: só leitura da lista`);
    assert.doesNotMatch(codigo, /precoReferencia|valorProposta|valorTotal/, `${arquivo.join('/')}: nenhum valor financeiro`);
    assert.doesNotMatch(codigo, /localStorage|sessionStorage|indexedDB|cookie/, `${arquivo.join('/')}: nada guardado no navegador`);
    assert.doesNotMatch(codigo, /innerHTML|outerHTML|insertAdjacentHTML|\.style\b|setAttribute\(\s*['"]style/, `${arquivo.join('/')}: nenhum HTML dinâmico nem estilo inline`);
  }
  assert.match(read('dashboard', 'crm-catalog-lookup.mjs'), /api\.listCatalog\(/);
});
