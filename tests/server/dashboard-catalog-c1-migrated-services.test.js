// AUDITORIA DE COMPATIBILIDADE da Fase C1 com os serviços JÁ cadastrados (no formato antigo, só tipo_cobranca/recorrencia), de ponta a ponta e sem tocar em nada real:
// o Dashboard (DOM de teste) -> o app REAL -> o Catalog Service REAL -> o adaptador REAL do Supabase -> um PostgREST FALSO (tests/helpers/fakePostgrestCatalogs.js) com linhas fictícias
// no formato antigo e o preenchimento da migration simulado (applyModalitiesMigration). Nenhuma rede, nenhum Supabase, nenhum dado de data/. Nomes e preços são fictícios.
//
// Prova: o que a migration preenche (UNICA, RECORRENTE com cada periodicidade, sem tipo), o que a tela mostra ANTES e DEPOIS dela, que editar nome/descrição/preço nunca mexe nas
// modalidades, que um PATCH parcial nunca vira true em false por engano e que ids, nomes e preços nunca mudam nem são reinterpretados como TCV/MRR.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSupabaseCatalogRepository } = require('../../src/crm-adapters/crmSupabaseCatalogRepository');
const { createCatalogService } = require('../../src/services/catalogService');
const { authorizeCatalogOperation } = require('../../src/auth');
const { createFakePostgrestCatalogs } = require('../helpers/fakePostgrestCatalogs');
const { createBrowser } = require('../helpers/fakeDom');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const T = '2026-10-10T10:00:00.000Z';
const ID = (n) => `service:00000000-0000-4000-8000-00000000000${n}`;
const linha = (n, extras) => ({
  id: ID(n), nome: `Serviço fictício ${n}`, nome_normalizado: `servico ficticio ${n}`, descricao: `Descrição ${n}`, ativo: true, ordem: n - 1, categoria: null, preco_referencia: null, tipo_cobranca: null, recorrencia: null,
  created_at: T, updated_at: T, created_by_user_id: 'user-antigo', created_by_name: 'Quem criou', updated_by_user_id: 'user-antigo', updated_by_name: 'Quem criou',
  // as colunas novas, como ficam logo depois do ADD COLUMN (os padrões do banco), ANTES do preenchimento
  permite_pagamento_unico: false, permite_pagamento_recorrente: false, periodicidades: [], ...extras,
});
// Os seis casos do formato antigo: UNICA; RECORRENTE com cada uma das quatro periodicidades; e um sem tipo_cobranca (legado sem informação).
const SEMENTES = () => [
  linha(1, { tipo_cobranca: 'UNICA', preco_referencia: 4800.5 }),
  linha(2, { tipo_cobranca: 'RECORRENTE', recorrencia: 'MENSAL', preco_referencia: 1500 }),
  linha(3, { tipo_cobranca: 'RECORRENTE', recorrencia: 'TRIMESTRAL', preco_referencia: 3900 }),
  linha(4, { tipo_cobranca: 'RECORRENTE', recorrencia: 'SEMESTRAL' }),
  linha(5, { tipo_cobranca: 'RECORRENTE', recorrencia: 'ANUAL', preco_referencia: 12000.99, ativo: false }),
  linha(6, { preco_referencia: 900 }),
];
const ESPERADO_DEPOIS = {
  1: ['Pagamento único', [true, false, []]],
  2: ['Pagamento recorrente (mensal)', [false, true, ['MENSAL']]],
  3: ['Pagamento recorrente (trimestral)', [false, true, ['TRIMESTRAL']]],
  4: ['Pagamento recorrente (semestral)', [false, true, ['SEMESTRAL']]],
  5: ['Pagamento recorrente (anual)', [false, true, ['ANUAL']]],
  6: ['Modalidades de pagamento não informadas', [false, false, []]],
};

async function subir(t) {
  const fake = createFakePostgrestCatalogs();
  for (const row of SEMENTES()) fake.tables.crm_services.set(row.id, structuredClone(row)); // como estavam no banco antes da migration
  const repository = createSupabaseCatalogRepository({ url: fake.url, serviceRoleKey: fake.serviceRoleKey, fetchImpl: fake.fetchImpl });
  const service = createCatalogService({ authorizeOperation: authorizeCatalogOperation, repository, countUsage: async () => 0 });
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, crmCatalogs: false, crmCatalogService: service });
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, bridgeFetch } = await loadFixtures();
  const browser = createBrowser({ hash: '#/crm/configuracoes/servicos' });
  const bridge = bridgeFetch(env.app);
  const fetchImpl = async (caminho, init) => (caminho === '/config.json' ? new Response(JSON.stringify(CONFIG), { status: 200 }) : bridge(caminho, init));
  fetchImpl.calls = bridge.calls;
  fetchImpl.responses = bridge.responses;
  const token = env.tokenFor(BRENO.userId);
  const sdk = createFakeSdk({ session: { access_token: token, refresh_token: 'refresh-de-teste-nao-real', user: { id: BRENO.authUserId } } });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation: browserNavigation(browser.window) });
  await browser.flush(10);
  return { fake, env, browser, fetchImpl, token, win: browser.window };
}

const principal = (s) => s.browser.by.id(s.browser.root, 'main');
const gaveta = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const botao = (s, rotulo, escopo) => s.browser.by.button(escopo || s.browser.root, rotulo);
const campo = (s, nome) => s.browser.by.id(s.browser.root, `catalog-field-${nome}`);
const linhaDe = (s, id) => s.browser.find(s.browser.root, (el) => el.localName === 'li' && el.getAttribute('data-id') === id);
const acao = (s, id, nome) => s.browser.find(s.browser.root, (el) => el.localName === 'button' && el.getAttribute('data-item') === id && el.getAttribute('data-action') === nome);
const clicar = async (s, el) => {
  s.browser.click(el);
  await s.browser.flush(12);
};
const digitar = (s, el, valor) => s.browser.type(el, valor);
const marcar = (s, nome, marcado = true) => s.browser.check(campo(s, nome), marcado);
const salvar = (s) => clicar(s, botao(s, 'Salvar', gaveta(s)));
const patches = (s) => s.fetchImpl.calls.filter((c) => c.method === 'PATCH');
const linhaBanco = (s, n) => s.fake.tables.crm_services.get(ID(n));
const modalidadesNoBanco = (s, n) => [linhaBanco(s, n).permite_pagamento_unico, linhaBanco(s, n).permite_pagamento_recorrente, linhaBanco(s, n).periodicidades];
const direto = (s, metodo, caminho, corpo) =>
  s.fetchImpl(caminho, { method: metodo, headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }) });
// O que NUNCA pode mudar por causa da migration nem de uma edição de modalidade: id, nome, nome normalizado, preço, ordem, ativo, categoria e os campos legados.
const identidade = (row) => JSON.stringify([row.id, row.nome, row.nome_normalizado, row.descricao, row.preco_referencia, row.ordem, row.ativo, row.categoria, row.tipo_cobranca, row.recorrencia, row.created_at, row.created_by_user_id, row.created_by_name]);

test('[C1AUD-1] ANTES da migration o servidor novo LÊ os serviços antigos sem erro e sem inferir nada; DEPOIS dela cada um aparece com as modalidades certas; ids, nomes, preços e o legado não mudam', async (t) => {
  const s = await subir(t);
  const identidadesAntes = [1, 2, 3, 4, 5, 6].map((n) => identidade(linhaBanco(s, n)));
  // a tela carrega e todos os seis aparecem; nenhum tem modalidade (a migration ainda não preencheu) — e nada é inferido do tipo antigo
  assert.equal(s.browser.by.cls(principal(s), 'catalog-row').length, 6);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.match(linhaDe(s, ID(n)).textContent, /Modalidades de pagamento não informadas/, `serviço ${n} antes da migration`);
  assert.equal(s.fetchImpl.responses.filter((r) => r.path.startsWith('/api/crm-catalogs')).every((r) => r.status === 200), true, 'nenhum erro de leitura');
  assert.equal(s.fetchImpl.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/api/crm-catalogs')).length, 0, 'abrir a tela não grava nada');

  // a migration (simulada): preenche só quem tem tipo_cobranca
  assert.equal(s.fake.applyModalitiesMigration(), 5, 'cinco linhas com tipo; a sem tipo não é tocada');
  await clicar(s, botao(s, 'Atualizar'));
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.match(linhaDe(s, ID(n)).textContent, new RegExp(ESPERADO_DEPOIS[n][0].replace(/[()]/g, '\\$&')), `serviço ${n} depois da migration`);
    assert.deepEqual(modalidadesNoBanco(s, n), ESPERADO_DEPOIS[n][1], `banco do serviço ${n}`);
  }
  assert.doesNotMatch(linhaDe(s, ID(6)).textContent, /único|recorrente \(/i, 'o sem tipo continua sem modalidade, sem erro');
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => identidade(linhaBanco(s, n))), identidadesAntes, 'ids, nomes, descrições, preços, ordem, ativo e o legado idênticos');
  // o que a API devolve: os mesmos preços, como NÚMERO de referência — e nenhum campo comercial inventado
  const resposta = await direto(s, 'GET', '/api/crm-catalogs/servicos?todos=1');
  const itens = (await resposta.json()).items;
  assert.deepEqual(itens.map((i) => i.precoReferencia), [4800.5, 1500, 3900, null, 12000.99, 900]);
  assert.deepEqual(itens.map((i) => i.id), [1, 2, 3, 4, 5, 6].map(ID));
  for (const item of itens) assert.equal(Object.keys(item).some((c) => /valor|tcv|mrr|prazo|parcela|receb|mensal(?!idade)/i.test(c)), false, `${item.nome}: nenhum campo comercial`);
  assert.deepEqual(itens.map((i) => [i.tipoCobranca, i.recorrencia]), [['UNICA', null], ['RECORRENTE', 'MENSAL'], ['RECORRENTE', 'TRIMESTRAL'], ['RECORRENTE', 'SEMESTRAL'], ['RECORRENTE', 'ANUAL'], [null, null]], 'o legado continua devolvido, só leitura');
});

test('[C1AUD-2] DEPOIS da migration a EDIÇÃO apresenta as modalidades migradas, e editar nome, descrição ou preço NUNCA mexe nelas (nem no legado); o corpo enviado leva só o que mudou', async (t) => {
  const s = await subir(t);
  s.fake.applyModalitiesMigration();
  await clicar(s, botao(s, 'Atualizar'));
  // o painel de edição de cada um mostra exatamente as caixas migradas
  const caixas = (n) => [campo(s, 'permitePagamentoUnico').checked, campo(s, 'permitePagamentoRecorrente').checked, ['mensal', 'trimestral', 'semestral', 'anual'].filter((v) => campo(s, `periodicidades-${v}`).checked).map((v) => v.toUpperCase())];
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await clicar(s, acao(s, ID(n), 'edit'));
    assert.deepEqual(caixas(n), ESPERADO_DEPOIS[n][1], `edição do serviço ${n}`);
    assert.equal(campo(s, 'periodicidades').hidden, !ESPERADO_DEPOIS[n][1][1], `periodicidades visíveis só quando recorrente (serviço ${n})`);
    await clicar(s, botao(s, 'Cancelar', gaveta(s)));
  }
  // editar nome, descrição e preço de um serviço migrado (recorrente mensal) e de um único
  for (const n of [2, 1]) {
    const antesModalidades = modalidadesNoBanco(s, n);
    const antesLegado = [linhaBanco(s, n).tipo_cobranca, linhaBanco(s, n).recorrencia];
    await clicar(s, acao(s, ID(n), 'edit'));
    digitar(s, campo(s, 'nome'), `Novo nome ${n}`);
    digitar(s, campo(s, 'descricao'), 'Descrição nova');
    digitar(s, campo(s, 'precoReferencia'), '2.222,22');
    await salvar(s);
    assert.deepEqual(patches(s).at(-1).body, { nome: `Novo nome ${n}`, descricao: 'Descrição nova', precoReferencia: 2222.22 }, 'o corpo leva só o que mudou: nenhuma modalidade');
    assert.deepEqual(modalidadesNoBanco(s, n), antesModalidades, `modalidades do serviço ${n} intactas`);
    assert.deepEqual([linhaBanco(s, n).tipo_cobranca, linhaBanco(s, n).recorrencia], antesLegado, 'o legado nunca é regravado');
    assert.equal(linhaBanco(s, n).id, ID(n));
    assert.equal(linhaBanco(s, n).preco_referencia, 2222.22);
  }
  // o serviço legado sem informação: editar só o preço não cria modalidade
  await clicar(s, acao(s, ID(6), 'edit'));
  digitar(s, campo(s, 'precoReferencia'), '950');
  await salvar(s);
  assert.deepEqual(patches(s).at(-1).body, { precoReferencia: 950 });
  assert.deepEqual(modalidadesNoBanco(s, 6), [false, false, []], 'continua sem modalidade');
  // nenhuma requisição do Dashboard citou colunas legadas
  assert.equal(JSON.stringify(s.fake.calls.filter((c) => c.method === 'PATCH' || c.method === 'POST').map((c) => c.body)).includes('tipo_cobranca'), false, 'o adaptador nunca grava tipo_cobranca/recorrencia');
});

test('[C1AUD-3] PATCH PARCIAL: nenhuma combinação de campos ausentes transforma true em false nem apaga periodicidades; só um pedido EXPLÍCITO e coerente muda as modalidades', async (t) => {
  const s = await subir(t);
  s.fake.applyModalitiesMigration();
  const patch = (n, corpo) => direto(s, 'PATCH', `/api/crm-catalogs/servicos/${encodeURIComponent(ID(n))}`, corpo);
  // pedidos que NÃO falam de modalidades — só o nome, só a descrição, só o preço (inclusive limpar) — nunca as tocam
  for (const corpo of [{ nome: 'Só nome' }, { descricao: null }, { precoReferencia: 10 }, { precoReferencia: null }, { categoria: 'Cat' }]) {
    for (const n of [1, 2, 6]) {
      const antes = modalidadesNoBanco(s, n);
      const r = await patch(n, n === 1 || n === 2 ? { ...corpo, ...(corpo.nome ? { nome: `${corpo.nome} ${n}` } : {}) } : corpo);
      assert.ok([200].includes(r.status), `${JSON.stringify(corpo)} no serviço ${n}: ${r.status}`);
      assert.deepEqual(modalidadesNoBanco(s, n), antes, `${JSON.stringify(corpo)} não mexe nas modalidades do serviço ${n}`);
    }
  }
  // pedidos que falam de UMA modalidade são julgados sobre o estado final: remover a última é recusado; periodicidade sem recorrente também
  const recusas = [
    [1, { permitePagamentoUnico: false }, 'MODALIDADE_OBRIGATORIA'],
    [2, { permitePagamentoRecorrente: false }, 'PERIODICIDADE_NAO_PERMITIDA'],
    [2, { periodicidades: [] }, 'PERIODICIDADE_OBRIGATORIA'],
    [1, { periodicidades: ['MENSAL'] }, 'PERIODICIDADE_NAO_PERMITIDA'],
    [2, { periodicidades: ['MENSAL', 'MENSAL'] }, 'PERIODICIDADE_REPETIDA'],
    [2, { permitePagamentoUnico: null }, 'TIPO_INVALIDO'],
    [2, { tipoCobranca: 'UNICA' }, 'CAMPO_NAO_EDITAVEL'],
    [2, { recorrencia: 'ANUAL' }, 'CAMPO_NAO_EDITAVEL'],
  ];
  for (const [n, corpo, codigo] of recusas) {
    const antes = modalidadesNoBanco(s, n);
    const r = await patch(n, corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.ok((await r.json()).error.details.some((d) => d.code === codigo), `${JSON.stringify(corpo)} -> ${codigo}`);
    assert.deepEqual(modalidadesNoBanco(s, n), antes, `${JSON.stringify(corpo)}: nada mudou`);
  }
  // um pedido explícito e coerente muda só o que pediu: acrescentar o recorrente trimestral a um serviço só-único
  const ok = await patch(1, { permitePagamentoRecorrente: true, periodicidades: ['TRIMESTRAL'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(modalidadesNoBanco(s, 1), [true, true, ['TRIMESTRAL']], 'o único continua verdadeiro');
  // e o resultado visto pela tela
  await clicar(s, botao(s, 'Atualizar'));
  assert.match(linhaDe(s, ID(1)).textContent, /Pagamento único \+ Pagamento recorrente \(trimestral\)/);
});

test('[C1AUD-4] REPETIR o preenchimento só atua onde ainda há tipo antigo SEM modalidade: não desfaz o que o ADMIN completou nem o que um serviço novo já tem', async (t) => {
  const s = await subir(t);
  s.fake.applyModalitiesMigration();
  const patch = (n, corpo) => direto(s, 'PATCH', `/api/crm-catalogs/servicos/${encodeURIComponent(ID(n))}`, corpo);
  assert.equal((await patch(6, { permitePagamentoUnico: true })).status, 200, 'o ADMIN completa o legado sem tipo');
  assert.equal((await patch(2, { permitePagamentoUnico: true, periodicidades: ['MENSAL', 'ANUAL'] })).status, 200, 'e amplia um migrado');
  const criado = await direto(s, 'POST', '/api/crm-catalogs/servicos', { nome: 'Serviço novo', permitePagamentoRecorrente: true, periodicidades: ['ANUAL'] });
  assert.equal(criado.status, 201);
  const antes = JSON.stringify([...s.fake.tables.crm_services.values()].map((r) => [r.id, r.permite_pagamento_unico, r.permite_pagamento_recorrente, r.periodicidades, r.updated_at]));
  assert.equal(s.fake.applyModalitiesMigration(), 0, 'nenhuma linha tem tipo antigo sem modalidade: nada a fazer');
  assert.equal(JSON.stringify([...s.fake.tables.crm_services.values()].map((r) => [r.id, r.permite_pagamento_unico, r.permite_pagamento_recorrente, r.periodicidades, r.updated_at])), antes, 'nada mudou, nem updated_at');
  // a ÚNICA situação em que a repetição atua: um servidor ANTIGO criou/editou um serviço depois da migration (só colunas antigas)
  s.fake.tables.crm_services.set(ID(7), { ...linha(7, { tipo_cobranca: 'RECORRENTE', recorrencia: 'SEMESTRAL' }), permite_pagamento_unico: false, permite_pagamento_recorrente: false, periodicidades: [] });
  assert.equal(s.fake.applyModalitiesMigration(), 1);
  assert.deepEqual(modalidadesNoBanco(s, 7), [false, true, ['SEMESTRAL']]);
});
