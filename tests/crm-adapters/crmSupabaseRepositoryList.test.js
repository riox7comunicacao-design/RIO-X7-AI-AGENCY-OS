'use strict';

// Fase H3.2 — a LEITURA COMPLETA e validada de list() no adapter Supabase do CRM (src/crm-adapters/crmSupabaseRepository.js).
//
// list() alimenta a duplicidade, o DNC, a reconciliação da promoção, a contagem de uso dos catálogos, GET /api/crm e o export. Quem decide com essa
// lista não pode ler "nada encontrado" de uma resposta cortada, malformada ou vazia por engano (auditoria H3.1; pendência nº 2 da decisão 0023).
// Tudo com um PostgREST FALSO em memória (tests/helpers/fakePostgrestCrmList.js): nenhuma rede, nenhum Supabase real, nenhuma chave real
// (a "chave" é um texto de teste) e nenhum dado real. O adapter NUNCA foi exercitado contra o Supabase real.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSupabaseCrmRepository } = require('../../src/crm-adapters/crmSupabaseRepository');
const { recordToRow } = require('../../src/crm-adapters/crmSupabaseMapping');
const { postgrestCrm, enchimento, registro, idDe, resposta } = require('../helpers/fakePostgrestCrmList');

const URL_BASE = 'https://exemplo-falso.example.test';
const CHAVE = 'chave-falsa-de-teste-nao-e-real';
const SEGREDO_NO_CORPO = 'segredo-que-so-existe-no-corpo-da-resposta';

const repo = (fetchImpl) => createSupabaseCrmRepository({ url: URL_BASE, serviceRoleKey: CHAVE, fetchImpl });
const comLinhas = (n, opcoes = {}) => postgrestCrm({ linhas: enchimento(n), ...opcoes });
async function falha(promessa) {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava um erro e a leitura terminou com sucesso');
}
const LEITURA_INCOMPLETA = /não pôde ser lida por completo/;

// ---------------------------------------------------------------------------------------------------------------------------------
test('[SBL-1] CRM vazio COMPROVADO por contagem exata: corpo [] com Content-Range "*/0" é uma lista vazia válida — com UMA requisição', async () => {
  const s = postgrestCrm({ linhas: [] });
  assert.deepEqual(await repo(s.fetchImpl).list(), []);
  assert.equal(s.chamadas.length, 1);
  assert.equal(s.chamadas[0].prefer, 'count=exact');
});

test('[SBL-2] UMA página: poucos registros, uma requisição, ordem preservada e saída pública igual à de sempre (sem seq/version/updated_at)', async () => {
  const s = comLinhas(3);
  const lidos = await repo(s.fetchImpl).list();
  assert.equal(s.chamadas.length, 1);
  assert.deepEqual(lidos.map((r) => r.empresa), ['Empresa Enchimento 1', 'Empresa Enchimento 2', 'Empresa Enchimento 3']);
  for (const r of lidos) for (const chave of ['seq', 'version', 'updated_at']) assert.equal(Object.prototype.hasOwnProperty.call(r, chave), false, chave);
  assert.deepEqual(lidos[0], registro({ id: idDe(1), empresa: 'Empresa Enchimento 1', site: 'enchimento-1.example.test' }), 'o mesmo mapeamento rowToRecord de sempre');
});

test('[SBL-3] limites de página: EXATAMENTE 500 registros = 1 requisição; 501 = 2 requisições', async () => {
  const a = comLinhas(500);
  assert.equal((await repo(a.fetchImpl).list()).length, 500);
  assert.equal(a.chamadas.length, 1);
  const b = comLinhas(501);
  assert.equal((await repo(b.fetchImpl).list()).length, 501);
  assert.deepEqual(b.chamadas.map((c) => c.query.offset), ['0', '500']);
});

test('[SBL-4] 1.100 registros com o teto padrão de 1000 linhas do servidor: três páginas (offsets 0, 500, 1000), todos lidos, sem repetir, na ordem de inserção', async () => {
  const s = comLinhas(1100);
  const lidos = await repo(s.fetchImpl).list();
  assert.equal(lidos.length, 1100);
  assert.deepEqual(s.chamadas.map((c) => c.query.offset), ['0', '500', '1000']);
  assert.ok(s.chamadas.every((c) => c.query.limit === '500' && c.query.order === 'seq.asc,id.asc' && c.query.select === '*' && c.prefer === 'count=exact'));
  assert.equal(new Set(lidos.map((r) => r.id)).size, 1100);
  assert.deepEqual(lidos.map((r) => r.id), enchimento(1100).map((r) => r.id), 'a ordem pública é a de inserção — inclusive os registros MAIS NOVOS, que o corte antigo descartava');
});

test('[SBL-5] servidor com teto de linhas MENOR que o pedido (100 por resposta, 500 pedidas): a leitura segue pelo total; uma página curta NÃO é tomada como a última', async () => {
  const s = comLinhas(250, { maxRows: 100 });
  assert.equal((await repo(s.fetchImpl).list()).length, 250);
  assert.deepEqual(s.chamadas.map((c) => c.query.offset), ['0', '100', '200']);
});

test('[SBL-6] até 10.000 registros: lidos por completo (20 páginas), mesmo com o teto de 1000 do servidor', async () => {
  const s = comLinhas(10000);
  const lidos = await repo(s.fetchImpl).list();
  assert.equal(lidos.length, 10000);
  assert.equal(s.chamadas.length, 20);
  assert.equal(lidos.at(-1).empresa, 'Empresa Enchimento 10000');
});

test('[SBL-7] MAIS de 10.000 registros: erro explícito já na primeira resposta, sem lista parcial e sem ler o resto', async () => {
  const s = comLinhas(10001);
  const erro = await falha(repo(s.fetchImpl).list());
  assert.match(erro.message, /registros demais para uma leitura segura/);
  assert.equal(s.chamadas.length, 1, 'não leu as demais páginas');
});

test('[SBL-8] limite de 100 PÁGINAS: um servidor que devolve uma linha por resposta para sempre é interrompido na 100ª página — erro, não lista parcial', async () => {
  const s = postgrestCrm({
    aoResponder: (n) => resposta(206, [{ ...recordToRow(registro({ id: idDe(n) })), seq: n }], { 'content-range': `${n - 1}-${n - 1}/9000` }),
  });
  const erro = await falha(repo(s.fetchImpl).list());
  assert.match(erro.message, /não chegou ao total/);
  assert.equal(s.chamadas.length, 100);

  // A FRONTEIRA com um servidor legítimo: 10.000 linhas com teto de 100 por resposta são EXATAMENTE 100 páginas — lidas por completo, sem pular nem
  // repetir; com teto de 99 seriam 102 páginas — erro na 100ª, sem lista parcial.
  const exatas = postgrestCrm({ linhas: enchimento(10000), maxRows: 100 });
  const lidos = await repo(exatas.fetchImpl).list();
  assert.equal(exatas.chamadas.length, 100);
  assert.deepEqual(lidos.map((r) => r.id), enchimento(10000).map((r) => r.id));
  const demais = postgrestCrm({ linhas: enchimento(10000), maxRows: 99 });
  assert.match((await falha(repo(demais.fetchImpl).list())).message, /não chegou ao total/);
  assert.equal(demais.chamadas.length, 100);
});

test('[SBL-9] ERRO DEPOIS da primeira página válida (HTTP 500, rede, 401): rejeita; nunca devolve a primeira página como se fosse tudo', async () => {
  for (const falhaNaSegunda of [
    () => resposta(500, '<html>erro</html>'),
    () => resposta(401, { message: SEGREDO_NO_CORPO }),
    () => { throw new TypeError(`ECONNRESET ${SEGREDO_NO_CORPO}`); },
  ]) {
    const s = comLinhas(1100, { aoResponder: (n) => (n === 2 ? falhaNaSegunda() : null) });
    const erro = await falha(repo(s.fetchImpl).list());
    assert.ok(erro instanceof Error);
    assert.equal(erro.message.includes(SEGREDO_NO_CORPO), false);
    assert.equal(s.chamadas.length, 2);
  }
});

test('[SBL-10] Content-Range AUSENTE, inválido ou sem total ("0-24/*"): erro — o total não pôde ser confirmado', async () => {
  const corpo = JSON.stringify([{ ...recordToRow(registro({ id: idDe(1) })), seq: 1 }]);
  for (const cabecalho of [undefined, '', 'lixo', '0-0/*', '*/*', '5-2/10', '0-0', '0-a/1', '-1-0/1']) {
    const cabecalhos = cabecalho === undefined ? {} : { 'content-range': cabecalho };
    const erro = await falha(repo(postgrestCrm({ aoResponder: () => resposta(200, corpo, cabecalhos) }).fetchImpl).list());
    assert.match(erro.message, /o total de registros não pôde ser confirmado/, String(cabecalho));
  }
});

test('[SBL-11] Content-Range INCONSISTENTE com o pedido: faixa que não começa no offset, que não bate com a quantidade recebida, mais linhas que o total ou página maior que a pedida', async () => {
  const pagina = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ ...recordToRow(registro({ id: idDe(i + 1) })), seq: i + 1 })));
  const casos = {
    'faixa deslocada': [resposta(206, pagina(10), { 'content-range': '5-14/100' }), /a faixa devolvida não confere com a pedida/],
    'faixa menor que o recebido': [resposta(206, pagina(10), { 'content-range': '0-4/100' }), /a faixa devolvida não confere com a pedida/],
    'faixa maior que o recebido': [resposta(206, pagina(10), { 'content-range': '0-19/100' }), /a faixa devolvida não confere com a pedida/],
    'mais linhas que o total': [resposta(200, pagina(10), { 'content-range': '0-9/5' }), /vieram mais registros do que o total/],
    'página maior que a pedida': [resposta(206, pagina(501), { 'content-range': '0-500/9000' }), /a página veio maior que a pedida/],
    'página vazia antes do total': [resposta(200, '[]', { 'content-range': '*/50' }), /a leitura terminou antes do total/],
  };
  // cada caso tem de falhar PELO MOTIVO CERTO (senão uma verificação removida passaria despercebida, coberta por outra)
  for (const [nome, [r, motivo]] of Object.entries(casos)) {
    const erro = await falha(repo(postgrestCrm({ aoResponder: () => r }).fetchImpl).list());
    assert.match(erro.message, motivo, nome);
  }
});

test('[SBL-12] TOTAL que MUDA durante a leitura (um registro apagado ou inserido entre as páginas): erro — a leitura é repetida por quem chama, nunca aceita', async () => {
  const apagado = comLinhas(1100, { aoResponder: (n, init, api) => { if (n === 2) api.tabela.delete(idDe(5)); return null; } });
  assert.match((await falha(repo(apagado.fetchImpl).list())).message, /o total mudou durante a leitura/);
  const inserido = comLinhas(1100, { aoResponder: (n, init, api) => { if (n === 2) api.tabela.set(idDe(9999), { ...recordToRow(registro({ id: idDe(9999) })), seq: 9999 }); return null; } });
  assert.match((await falha(repo(inserido.fetchImpl).list())).message, /o total mudou durante a leitura/);
});

test('[SBL-13] DESLOCAMENTO que repete uma linha (id duplicado entre páginas): erro', async () => {
  const s = comLinhas(1100, {
    aoResponder: (n, init, api) => (n === 2 ? resposta(206, api.linhas().slice(499, 999), { 'content-range': '500-999/1100' }) : null),
  });
  assert.match((await falha(repo(s.fetchImpl).list())).message, /apareceu duas vezes/);
  // dentro da MESMA página
  const mesma = [{ ...recordToRow(registro({ id: idDe(1) })), seq: 1 }, { ...recordToRow(registro({ id: idDe(1) })), seq: 2 }];
  assert.match((await falha(repo(postgrestCrm({ aoResponder: () => resposta(200, mesma, { 'content-range': '0-1/2' }) }).fetchImpl).list())).message, /apareceu duas vezes/);
});

test('[SBL-14] registro ESTRUTURALMENTE inválido (sem id, id vazio ou que não é texto, sem status, status que não é texto, null, texto, lista): erro — mas um registro legítimo antigo (só id e status) passa', async () => {
  const boa = { ...recordToRow(registro({ id: idDe(1) })), seq: 1 };
  const invalidos = [{ ...boa, id: undefined }, { ...boa, id: '' }, { ...boa, id: 42 }, { ...boa, status: undefined }, { ...boa, status: null }, { ...boa, status: 7 }, null, 'texto', [boa]];
  for (const ruim of invalidos) {
    const erro = await falha(repo(postgrestCrm({ aoResponder: () => resposta(200, JSON.stringify([ruim]), { 'content-range': '0-0/1' }) }).fetchImpl).list());
    assert.match(erro.message, /formato inesperado/, JSON.stringify(ruim));
  }
  // um registro antigo, sem várias colunas: não é descartado (os campos que faltam viram null, como sempre)
  const antigo = { id: idDe(7), status: 'WON', empresa: 'Empresa Antiga Fictícia' };
  const [lido] = await repo(postgrestCrm({ aoResponder: () => resposta(200, [antigo], { 'content-range': '0-0/1' }) }).fetchImpl).list();
  assert.equal(lido.id, idDe(7));
  assert.equal(lido.status, 'WON');
  assert.equal(lido.empresa, 'Empresa Antiga Fictícia');
  assert.equal(lido.site, null);
});

test('[SBL-15] HTTP 200 e 206 são ambos válidos (o 206 é a resposta parcial normal de uma página com count=exact); outros 2xx também', async () => {
  const s = comLinhas(1100);
  assert.equal((await repo(s.fetchImpl).list()).length, 1100);
  // o servidor falso responde 206 nas páginas parciais e 200 na última: a leitura acima aceitou as duas
  const primeira = await s.fetchImpl(new URL(`${URL_BASE}/rest/v1/crm_records?limit=500&offset=0`), { method: 'GET', headers: { Prefer: 'count=exact' } });
  assert.equal(primeira.status, 206);
  const ultima = await s.fetchImpl(new URL(`${URL_BASE}/rest/v1/crm_records?limit=500&offset=1000`), { method: 'GET', headers: { Prefer: 'count=exact' } });
  assert.equal(ultima.status, 200);
});

test('[SBL-16] corpo que NÃO é lista — null, objeto, texto, número, corpo vazio, HTML, JSON malformado — NUNCA vira lista vazia', async () => {
  for (const corpo of ['null', '{"message":"x"}', '"ola"', '42', '', '<html>portal</html>', '[{"id":', 'true']) {
    for (const cabecalhos of [{ 'content-range': '*/0' }, {}]) {
      const erro = await falha(repo(postgrestCrm({ aoResponder: () => resposta(200, corpo, cabecalhos) }).fetchImpl).list());
      assert.match(erro.message, /a resposta não é uma lista/, corpo);
    }
  }
});

test('[SBL-17] HTTP 401, 403, 404 e 500: erro com SÓ o status — nunca o corpo da resposta, a mensagem do PostgREST nem a chave', async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    for (const corpo of [{ message: SEGREDO_NO_CORPO, code: 'PGRST301', details: SEGREDO_NO_CORPO }, `<html>${SEGREDO_NO_CORPO}</html>`, '']) {
      const erro = await falha(repo(postgrestCrm({ aoResponder: () => resposta(status, corpo) }).fetchImpl).list());
      assert.match(erro.message, new RegExp(`HTTP ${status}`));
      assert.equal(erro.message.includes(SEGREDO_NO_CORPO), false, `${status}: vazou o corpo`);
      assert.equal(erro.message.includes(CHAVE), false);
      assert.equal(erro.code, undefined, 'sem code: cai no erro genérico do servidor, como qualquer falha inesperada');
    }
  }
});

test('[SBL-18] TIMEOUT e falha de REDE: erro estável com o tipo da falha — nunca a mensagem bruta —, a requisição leva um AbortSignal e nada é devolvido', async () => {
  const sinais = [];
  const timeout = async (url, init) => { sinais.push(init.signal); throw Object.assign(new Error(`demorou ${SEGREDO_NO_CORPO}`), { name: 'TimeoutError' }); };
  const e1 = await falha(repo(timeout).list());
  assert.match(e1.message, /falha de rede ao falar com o PostgREST \(TimeoutError\)/);
  assert.ok(sinais[0] && typeof sinais[0].aborted === 'boolean', 'há um timeout por requisição');
  const rede = async () => { throw new TypeError(`fetch failed ${SEGREDO_NO_CORPO} ${CHAVE}`); };
  const e2 = await falha(repo(rede).list());
  assert.match(e2.message, /falha de rede ao falar com o PostgREST \(TypeError\)/);
  for (const e of [e1, e2]) {
    assert.equal(e.message.includes(SEGREDO_NO_CORPO), false);
    assert.equal(e.message.includes(CHAVE), false);
  }
});

test('[SBL-19] nenhuma leitura devolve dados parciais: toda falha REJEITA a promessa (nada é entregue), e a leitura seguinte, com o servidor normal, funciona', async () => {
  let quebrar = true;
  const s = comLinhas(1100, { aoResponder: (n) => (quebrar && n === 3 ? resposta(500, '') : null) });
  const r = repo(s.fetchImpl);
  let entregue;
  try {
    entregue = await r.list();
  } catch {
    entregue = undefined;
  }
  assert.equal(entregue, undefined);
  quebrar = false;
  assert.equal((await r.list()).length, 1100, 'sem cache: cada leitura é nova');
});

test('[SBL-20] a chave de serviço só vai no cabeçalho; a leitura é SEMPRE um GET (nunca escreve) e não envia corpo', async () => {
  const s = comLinhas(1100);
  await repo(s.fetchImpl).list();
  for (const c of s.chamadas) {
    assert.equal(c.metodo, 'GET');
    assert.equal(c.init.body, undefined);
    assert.equal(c.init.headers.apikey, CHAVE);
    assert.equal(c.init.headers.Authorization, `Bearer ${CHAVE}`);
    assert.equal(JSON.stringify(c.query).includes(CHAVE), false);
  }
  assert.equal(s.tabela.size, 1100, 'nada foi gravado');
});

test('[SBL-21] as outras operações NÃO mudaram: getById continua uma leitura de uma linha (id=eq.…, limit=1, sem paginação) e save() continua um upsert', async () => {
  const s = comLinhas(3);
  const r = repo(s.fetchImpl);
  const um = await r.getById(idDe(2));
  assert.equal(um.empresa, 'Empresa Enchimento 2');
  assert.deepEqual([s.chamadas[0].query.id, s.chamadas[0].query.limit, s.chamadas[0].query.offset], [`eq.${idDe(2)}`, '1', undefined]);
  await r.save(registro({ id: idDe(2), empresa: 'Nome Novo' }));
  assert.equal(s.chamadas[1].metodo, 'POST');
  assert.match(s.chamadas[1].prefer, /resolution=merge-duplicates/);
});
