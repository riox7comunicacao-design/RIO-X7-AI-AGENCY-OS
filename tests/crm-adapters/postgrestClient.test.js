// O cliente PostgREST compartilhado dos adapters comerciais (src/crm-adapters/postgrestClient.js — Fase D1.1): a leitura COMPLETA (paginada, com o total exato conferido), as contagens e as falhas. As
// respostas são fabricadas aqui, uma a uma, para provar cada defesa isoladamente: uma lista só é devolvida quando TODAS as linhas chegaram e batem com o total; qualquer dúvida é erro. Nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgrestClient, parseContentRange } = require('../../src/crm-adapters/postgrestClient');
const { resposta } = require('../helpers/fakePostgrestCommercial');

const CHAVE = 'chave-de-servico-falsa-so-para-teste';
const cliente = (respostas) => {
  const pedidos = [];
  const fetchImpl = async (url, init) => {
    pedidos.push({ url: new URL(String(url)), init });
    const proxima = respostas.shift();
    if (!proxima) throw new Error('resposta inesperada: o cliente pediu mais páginas do que o previsto');
    return typeof proxima === 'function' ? proxima(pedidos.at(-1)) : proxima;
  };
  return { client: createPostgrestClient({ url: 'https://exemplo-teste.supabase.co/', serviceRoleKey: CHAVE, fetchImpl, label: 'Teste (Supabase)' }), pedidos };
};
const linhas = (de, ate) => Array.from({ length: ate - de + 1 }, (_, i) => ({ id: `x:${de + i}` }));
const ler = (client, opcoes = {}) => client.readAll({ table: 'tabela', order: 'id.asc', noun: 'as linhas', pageSize: 2, maxRows: 10, check: (row) => typeof row.id === 'string', ...opcoes });

test('[PGC-1] O Content-Range: "0-499/1234" e "*/0" são lidos; qualquer outra forma (inclusive o total desconhecido "0-24/*") é recusada', () => {
  assert.deepEqual(parseContentRange('0-499/1234'), { start: 0, end: 499, total: 1234 });
  assert.deepEqual(parseContentRange('*/0'), { start: null, end: null, total: 0 });
  for (const ruim of ['0-24/*', '', undefined, null, 5, '5-2/10', 'abc', '0-1/2/3', '-1-2/3']) assert.equal(parseContentRange(ruim), null, String(ruim));
});

test('[PGC-2] LEITURA COMPLETA: pede limit/offset e o total exato, junta as páginas em ordem e só devolve quando as linhas lidas == o total (uma página curta nunca é "a última" por si); a chave vai só nos cabeçalhos', async () => {
  const { client, pedidos } = cliente([
    resposta(206, linhas(1, 2), { 'content-range': '0-1/5' }),
    resposta(206, linhas(3, 4), { 'content-range': '2-3/5' }),
    resposta(200, linhas(5, 5), { 'content-range': '4-4/5' }),
  ]);
  const todas = await ler(client);
  assert.deepEqual(todas.map((l) => l.id), ['x:1', 'x:2', 'x:3', 'x:4', 'x:5']);
  assert.deepEqual(pedidos.map((p) => [p.url.searchParams.get('limit'), p.url.searchParams.get('offset')]), [['2', '0'], ['2', '2'], ['2', '4']]);
  assert.ok(pedidos.every((p) => p.init.headers.Prefer === 'count=exact' && p.url.searchParams.get('order') === 'id.asc'));
  assert.ok(pedidos.every((p) => p.init.headers.apikey === CHAVE && p.init.headers.Authorization === `Bearer ${CHAVE}` && !String(p.url).includes(CHAVE)));
  // vazia de verdade: total 0
  assert.deepEqual(await ler(cliente([resposta(200, [], { 'content-range': '*/0' })]).client), []);
});

test('[PGC-3] O TOTAL QUE MUDA NO MEIO DA LEITURA é erro: se entre as páginas aparece uma linha nova (o total vai de 2 para 3), ler só as 2 primeiras e declarar "completo" seria uma lista PARCIAL', async () => {
  const { client } = cliente([resposta(206, linhas(1, 1), { 'content-range': '0-0/2' }), resposta(206, linhas(2, 2), { 'content-range': '1-1/3' })]);
  await assert.rejects(() => ler(client, { pageSize: 1 }), /o total mudou durante a leitura/);
});

test('[PGC-4] TODA DÚVIDA É ERRO: corpo que não é lista, total ausente ou ilegível, faixa que não confere com a pedida, linha malformada, id repetido, mais linhas que o total, página maior que a pedida, leitura que termina antes do total e total acima do teto', async () => {
  const casos = [
    [[resposta(200, { x: 1 }, { 'content-range': '0-0/1' })], /não é uma lista/],
    [[resposta(200, linhas(1, 1), {})], /total não pôde ser confirmado/],
    [[resposta(200, linhas(1, 1), { 'content-range': '0-0/*' })], /total não pôde ser confirmado/],
    [[resposta(200, linhas(1, 2), { 'content-range': '3-4/2' })], /faixa devolvida/],
    [[resposta(200, [{ id: 'x:1' }, { nome: 'sem id' }], { 'content-range': '0-1/2' })], /formato inesperado/],
    [[resposta(200, [{ id: 'x:1' }, { id: 'x:1' }], { 'content-range': '0-1/2' })], /apareceu duas vezes/],
    [[resposta(200, linhas(1, 3), { 'content-range': '0-2/3' })], /página veio maior que a pedida/],
    [[resposta(200, linhas(1, 2), { 'content-range': '0-1/2' }), resposta(200, linhas(3, 3), { 'content-range': '2-2/2' })], null],
    [[resposta(200, linhas(1, 1), { 'content-range': '0-0/2' }), resposta(200, [], { 'content-range': '*/2' })], /terminou antes do total/],
    [[resposta(200, linhas(1, 2), { 'content-range': '0-1/50' })], /linhas demais/],
    [[resposta(200, [1, 2], { 'content-range': '0-1/2' })], /formato inesperado/],
  ];
  for (const [respostas, motivo] of casos) {
    const { client } = cliente(respostas);
    if (motivo === null) assert.deepEqual((await ler(client)).map((l) => l.id), ['x:1', 'x:2'], 'o caso feliz com total igual ao lido não pede mais páginas');
    else await assert.rejects(() => ler(client), motivo);
  }
});

test('[PGC-5] FALHAS: status de erro e corpo que não é JSON citam só o status (nunca o corpo nem a mensagem do PostgREST); a rede que cai não vaza a mensagem do erro; o `classify` do adapter recebe o status e o JSON', async () => {
  const falha = cliente([resposta(500, { code: 'XX000', message: 'segredo com dado do cliente' })]).client;
  await assert.rejects(() => falha.request({ method: 'POST', path: '/rest/v1/x', body: { a: 1 } }), (e) => e.status === 500 && /HTTP 500/.test(e.message) && !/segredo|dado do cliente|XX000/.test(e.message) && e.code === undefined);
  const html = cliente([resposta(502, '<html>erro do proxy com detalhes internos</html>')]).client;
  await assert.rejects(() => html.request({ method: 'GET', path: '/rest/v1/x' }), (e) => /HTTP 502/.test(e.message) && !/detalhes internos/.test(e.message));
  const classificada = cliente([resposta(409, { code: '23505', message: 'duplicate' })]).client;
  await assert.rejects(() => classificada.request({ method: 'POST', path: '/rest/v1/x', classify: (status, json) => (status === 409 && json.code === '23505' ? 'CODIGO_ESTAVEL' : null) }), (e) => e.code === 'CODIGO_ESTAVEL');
  const leitura = cliente([resposta(503, 'fora')]).client;
  await assert.rejects(() => ler(leitura), /recusou a leitura \(HTTP 503\)/);
  const semRede = createPostgrestClient({ url: 'https://x.supabase.co', serviceRoleKey: CHAVE, fetchImpl: async () => { throw Object.assign(new Error('host-interno-segredo'), { name: 'TypeError' }); }, label: 'Teste (Supabase)' });
  await assert.rejects(() => semRede.request({ method: 'GET', path: '/rest/v1/x' }), (e) => /falha de rede ao falar com o PostgREST \(TypeError\)/.test(e.message) && !/host-interno-segredo/.test(e.message));
  assert.throws(() => createPostgrestClient({ url: '', serviceRoleKey: CHAVE, fetchImpl: async () => {}, label: 'T' }), /configuração do Supabase incompleta/);
  assert.throws(() => createPostgrestClient({ url: 'https://x.supabase.co', serviceRoleKey: CHAVE, fetchImpl: 5, label: 'T' }), /fetchImpl deve ser uma função/);
});

test('[PGC-6] CONTAGEM: devolve o total do Content-Range sem trazer linhas; sem total confirmável é ERRO (nunca 0 por engano); corpo que não é lista é erro', async () => {
  const { client, pedidos } = cliente([resposta(200, [], { 'content-range': '*/7' }), resposta(206, [{ id: 'x:1' }], { 'content-range': '0-0/12' }), resposta(200, [], {}), resposta(200, { x: 1 }, { 'content-range': '*/0' })]);
  assert.equal(await client.countRows({ table: 'tabela', filters: { funnel_id: 'eq.f' }, noun: 'os cards' }), 7);
  assert.deepEqual([pedidos[0].url.searchParams.get('limit'), pedidos[0].url.searchParams.get('select'), pedidos[0].url.searchParams.get('funnel_id'), pedidos[0].init.headers.Prefer], ['1', 'id', 'eq.f', 'count=exact']);
  assert.equal(await client.countRows({ table: 'tabela', noun: 'os cards' }), 12);
  await assert.rejects(() => client.countRows({ table: 'tabela', noun: 'os cards' }), /total não pôde ser confirmado/);
  await assert.rejects(() => client.countRows({ table: 'tabela', noun: 'os cards' }), /não é uma lista/);
});
