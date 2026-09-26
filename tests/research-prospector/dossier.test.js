// Dossiê de pesquisa e sinais (src/research-prospector/dossier.js e signalSchema.js) — decisão 0018.
//
// O que estes testes provam: o dossiê é uma entidade SEPARADA do prospect (só guarda prospectId e loteId), com FATOS (DADO | NAO_VERIFICADO), SINAIS
// derivados por regras fixas (o consumidor nunca envia um sinal) e ANÁLISES/HIPÓTESES apoiadas em fatos e sinais do próprio dossiê; tudo o que é do
// sistema (id, datas, fontes, sinais) é DERIVADO e nunca aceito de fora; a entrada é dado NÃO CONFIÁVEL (esquema estrito, HTTPS, limites, datas
// reais); ausência de evidência nunca vira afirmação negativa; e o módulo é independente do CRM, da rede e do disco. Tudo fictício (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildDossier, DOSSIER_ID_PATTERN, LIMITS, ANALYSIS_TYPE, DOSSIER_ERROR, FORBIDDEN_TEXT } = require('../../src/research-prospector/dossier');
const { FACT_CATALOG, FACT_STATUS, ANALYSIS_STATUS, SIGNAL_STATUS, SIGNAL_TYPE, ADS_STATE, RECENT_POST_DAYS, deriveSignals } = require('../../src/research-prospector/signalSchema');
const { INFO_STATUS } = require('../../src/research-prospector/constants');
const { SOURCE_TYPE } = require('../../src/research-prospector/discovery');
const { analyzeSource, toPosix } = require('../helpers/staticImports');

const AGORA = new Date('2026-09-25T15:00:00.000Z');
const ID = 'dossie:11111111-1111-4111-8111-111111111111';
const LOTE = 'lote:22222222-2222-4222-8222-222222222222';
const opcoes = { now: AGORA, newId: () => ID };

const fonte = (data = '2026-09-25', extras = {}) => ({ url: 'https://fonte.example.test/pagina', tipo: SOURCE_TYPE.OFICIAL, observadoEm: data, ...extras });
const dado = (campo, valor, data = '2026-09-25', extras = {}) => ({ campo, valor, status: 'DADO', fonte: fonte(data), observadoEm: data, ...extras });
const naoVerificado = (campo, data = '2026-09-25', extras = {}) => ({ campo, valor: null, status: 'NAO_VERIFICADO', observadoEm: data, ...extras });
const entrada = (fatos = [], extras = {}) => ({ prospectId: 'id:clinica-teste.example.test', fatos, ...extras });
const montar = (fatos, extras) => buildDossier(entrada(fatos, extras), opcoes);
const codigos = (r) => r.errors.map((e) => `${e.path}:${e.code}`);
const sinal = (r, tipo) => r.value.sinais.find((s) => s.tipo === tipo);

const instagramCompleto = () => [
  dado('instagram.url', 'https://instagram.example.test/clinica'),
  dado('instagram.postagensObservadas', ['2026-09-01', '2026-09-10', '2026-09-20']),
  dado('instagram.cta', 'Agende pelo link da bio'),
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Dossiê válido e o que é derivado
// ---------------------------------------------------------------------------------------------------------------------------------
test('[DOS-1] um dossiê válido: identidade própria, associação ao prospect e ao lote, e tudo o que é do sistema derivado (id, datas, ids dos fatos, sinais, fontes)', () => {
  const r = montar([dado('site.url', 'https://clinica.example.test'), dado('instagram.url', 'https://instagram.example.test/clinica', '2026-09-24')], { loteId: LOTE });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const d = r.value;
  assert.deepEqual(Object.keys(d).sort(), ['analises', 'criadoEm', 'dataDaPesquisa', 'dossierId', 'fatos', 'fontes', 'loteId', 'prospectId', 'sinais']);
  assert.equal(d.dossierId, ID);
  assert.match(d.dossierId, DOSSIER_ID_PATTERN);
  assert.equal(d.prospectId, 'id:clinica-teste.example.test');
  assert.equal(d.loteId, LOTE);
  assert.equal(d.criadoEm, AGORA.toISOString());
  assert.equal(d.dataDaPesquisa, '2026-09-25', 'a data mais recente observada nos fatos');
  assert.deepEqual(d.fatos.map((f) => f.factId), ['fato:site.url', 'fato:instagram.url']);
  assert.deepEqual(d.sinais.map((s) => s.sinalId).sort(), ['sinal:INSTAGRAM_EXISTENTE', 'sinal:SITE_EXISTENTE']);
  assert.equal(d.fontes.length, 2, 'as fontes são derivadas dos fatos (uma por url+tipo+data)');
  assert.deepEqual(d.analises, []);
});

test('[DOS-1b] fontes derivadas: dois fatos com a MESMA fonte geram uma só; o mesmo url com outro tipo ou outra data é outra fonte', () => {
  const mesma = fonte('2026-09-25');
  const r = montar([{ ...dado('site.url', 'https://a.example.test'), fonte: mesma }, { ...dado('facebook.url', 'https://facebook.example.test/a'), fonte: { ...mesma } }]);
  assert.equal(r.value.fontes.length, 1);
  const outras = montar([dado('site.url', 'https://a.example.test'), { ...dado('facebook.url', 'https://facebook.example.test/a'), fonte: fonte('2026-09-25', { tipo: SOURCE_TYPE.SECUNDARIA }) }, dado('youtube.url', 'https://youtube.example.test/a', '2026-09-24')]);
  assert.equal(outras.value.fontes.length, 3);
});

test('[DOS-2] o loteId é opcional (null); sem fatos o dossiê é válido e a data da pesquisa é a de agora; o dossiê não guarda nenhum dado de identidade/contato do prospect', () => {
  const r = buildDossier({ prospectId: 'id:x', fatos: [] }, opcoes);
  assert.equal(r.ok, true);
  assert.equal(r.value.loteId, null);
  assert.equal(r.value.dataDaPesquisa, '2026-09-25');
  assert.deepEqual([r.value.fatos, r.value.sinais, r.value.analises, r.value.fontes], [[], [], [], []]);
  for (const campo of ['empresa', 'telefone', 'whatsapp', 'email', 'site', 'instagram', 'cidade', 'nicho', 'score', 'temperatura', 'ranking', 'prioridade', 'problemaIdentificado']) {
    assert.equal(campo in r.value, false, `o dossiê não tem ${campo}`);
  }
});

test('[DOS-3] entrada inválida: não é objeto, sem prospectId, prospectId com tipo errado/vazio/gigante/controle, sem fatos, fatos que não é lista — recusada sem lançar', () => {
  for (const ruim of [null, undefined, 'x', 5, [], () => {}, new Map()]) assert.equal(buildDossier(ruim, opcoes).errors[0].code, 'NAO_E_OBJETO');
  assert.deepEqual(codigos(buildDossier({ fatos: [] }, opcoes)), ['prospectId:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(buildDossier({ prospectId: 'id:x' }, opcoes)), ['fatos:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(buildDossier({ prospectId: 'id:x', fatos: {} }, opcoes)), ['fatos:NAO_E_LISTA']);
  assert.deepEqual(codigos(buildDossier({ prospectId: 'id:x', fatos: 'texto' }, opcoes)), ['fatos:NAO_E_LISTA']);
  for (const prospectId of ['', '   ', 'a\nb', 5, {}, [], 'x'.repeat(LIMITS.PROSPECT_ID + 1), 'a\u0000b', 'a\u202Eb']) {
    assert.equal(buildDossier({ prospectId, fatos: [] }, opcoes).ok, false, JSON.stringify(prospectId));
  }
  assert.equal(buildDossier({ prospectId: 'x'.repeat(LIMITS.PROSPECT_ID), fatos: [] }, opcoes).ok, true);
});

test('[DOS-4] campos derivados ou de autoridade NÃO são aceitos de fora: dossierId, criadoEm, dataDaPesquisa, sinais, fontes, factId, status de sinal, score, temperatura, ranking, decisão', () => {
  for (const chave of ['dossierId', 'criadoEm', 'dataDaPesquisa', 'sinais', 'fontes', 'analiseId', 'status', 'score', 'temperatura', 'ranking', 'prioridade', 'aprovado', 'problemaIdentificado', 'userId', 'role', 'permissions', 'crm', 'empresa']) {
    const r = buildDossier({ ...entrada([]), [chave]: 'forjado' }, opcoes);
    assert.equal(r.ok, false, chave);
    assert.deepEqual(codigos(r), [`${chave}:CAMPO_DESCONHECIDO`], chave);
  }
  // dentro de um fato e de uma fonte também
  assert.deepEqual(codigos(montar([{ ...dado('site.url', 'https://a.example.test'), factId: 'fato:forjado' }])), ['fatos[0].factId:CAMPO_DESCONHECIDO']);
  assert.deepEqual(codigos(montar([{ ...dado('site.url', 'https://a.example.test'), fonte: fonte('2026-09-25', { confianca: 'VALIDADO' }) }])), ['fatos[0].fonte.confianca:CAMPO_DESCONHECIDO']);
});

test('[DOS-5] loteId: só o formato lote:<uuid> ou nulo; qualquer outra coisa é recusada', () => {
  for (const loteId of ['', 'lote:x', '__proto__', '../x', 5, {}, LOTE.toUpperCase(), ` ${LOTE}`]) assert.equal(montar([], { loteId }).ok, false, JSON.stringify(loteId));
  assert.equal(montar([], { loteId: null }).value.loteId, null);
  assert.equal(montar([], { loteId: LOTE }).value.loteId, LOTE);
});

test('[DOS-6] o id do dossiê é gerado pelo sistema (uuid por padrão, único a cada chamada) e um gerador defeituoso é recusado (nunca grava um id fora do formato)', () => {
  const a = buildDossier(entrada([]), { now: AGORA });
  const b = buildDossier(entrada([]), { now: AGORA });
  assert.match(a.value.dossierId, DOSSIER_ID_PATTERN);
  assert.notEqual(a.value.dossierId, b.value.dossierId);
  for (const ruim of ['__proto__', 'dossie:x', '', 5, null, undefined, 'dossie:AAAAAAAA-1111-4111-8111-111111111111', `${ID} `]) assert.equal(buildDossier(entrada([]), { now: AGORA, newId: () => ruim }).ok, false, String(ruim));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fatos
// ---------------------------------------------------------------------------------------------------------------------------------
test('[DOS-7] um fato válido: DADO com valor, fonte e data; NAO_VERIFICADO com valor nulo e fonte opcional', () => {
  const r = montar([dado('site.url', 'https://clinica.example.test'), naoVerificado('facebook.url'), naoVerificado('linkedin.url', '2026-09-25', { fonte: fonte('2026-09-25') })]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const [site, facebook, linkedin] = r.value.fatos;
  assert.deepEqual([site.status, site.valor, site.fonte.tipo], ['DADO', 'https://clinica.example.test', 'OFICIAL']);
  assert.deepEqual([facebook.status, facebook.valor, facebook.fonte], ['NAO_VERIFICADO', null, null]);
  assert.equal(linkedin.fonte.url, 'https://fonte.example.test/pagina');
});

test('[DOS-8] fato sem status, com status desconhecido ou de outro vocabulário (HIPOTESE, ANALISE, VALIDADO): recusado — uma hipótese nunca é armazenada como fato', () => {
  const semStatus = { ...dado('site.url', 'https://a.example.test') };
  delete semStatus.status;
  assert.deepEqual(codigos(montar([semStatus])), ['fatos[0].status:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(montar([{ ...semStatus, status: null }])), ['fatos[0].status:CAMPO_OBRIGATORIO']);
  for (const status of ['HIPOTESE', 'ANALISE', 'VALIDADO', 'dado', 'DADO ', 'CONFLITO', '', 'qualquer']) {
    assert.deepEqual(codigos(montar([{ ...dado('site.url', 'https://a.example.test'), status }])), ['fatos[0].status:STATUS_INVALIDO'], JSON.stringify(status));
  }
  for (const status of [5, true, [], {}]) assert.deepEqual(codigos(montar([{ ...dado('site.url', 'https://a.example.test'), status }])), ['fatos[0].status:TIPO_INVALIDO']);
  assert.deepEqual(Object.keys(FACT_STATUS), ['DADO', 'NAO_VERIFICADO']);
  assert.equal(Object.keys(FACT_STATUS).some((s) => Object.keys(ANALYSIS_STATUS).includes(s) && s !== 'x'), false, 'os vocabulários de fato e de análise não se sobrepõem');
});

test('[DOS-9] DADO exige valor e fonte; NAO_VERIFICADO não pode ter valor ("a pesquisa não confirmou nada")', () => {
  assert.deepEqual(codigos(montar([{ campo: 'site.url', status: 'DADO', observadoEm: '2026-09-25', fonte: fonte() }])), ['fatos[0].valor:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(montar([{ campo: 'site.url', valor: 'https://a.example.test', status: 'DADO', observadoEm: '2026-09-25' }])), ['fatos[0].fonte:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(montar([{ campo: 'site.url', valor: 'https://a.example.test', status: 'DADO', observadoEm: '2026-09-25', fonte: null }])), ['fatos[0].fonte:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(montar([{ campo: 'site.url', valor: 'https://a.example.test', status: 'NAO_VERIFICADO', observadoEm: '2026-09-25' }])), ['fatos[0].valor:VALOR_EM_FATO_NAO_VERIFICADO']);
  assert.deepEqual(codigos(montar([{ campo: 'anuncios.meta', valor: 'NAO_ENCONTRADO_NA_VERIFICACAO', status: 'NAO_VERIFICADO', observadoEm: '2026-09-25' }])), ['fatos[0].valor:VALOR_EM_FATO_NAO_VERIFICADO']);
  assert.deepEqual(codigos(montar([{ campo: 'site.url', status: 'NAO_VERIFICADO' }])), ['fatos[0].observadoEm:CAMPO_OBRIGATORIO']);
});

test('[DOS-10] o catálogo de campos é FECHADO: campo desconhecido, ausente, com tipo errado ou herdado do protótipo é recusado', () => {
  for (const campo of ['cpf', 'empresa', 'telefone', 'site', 'instagram.ativo', 'anuncios.tiktok', '__proto__', 'constructor', 'toString', '', 5, null, {}, []]) {
    const r = montar([{ ...dado('site.url', 'https://a.example.test'), campo }]);
    assert.equal(r.ok, false, JSON.stringify(campo));
    assert.equal(r.errors[0].path, 'fatos[0].campo');
  }
  assert.deepEqual(codigos(montar([{ valor: 'https://a.example.test', status: 'DADO', observadoEm: '2026-09-25', fonte: fonte() }])), ['fatos[0].campo:CAMPO_OBRIGATORIO']);
  assert.deepEqual(Object.keys(FACT_CATALOG).length, 15);
  assert.equal(Object.isFrozen(FACT_CATALOG), true);
});

test('[DOS-11] o formato do valor por campo: url https pública, data real, lista de datas (2 a 30), texto curto, presença só como true, anúncios só nos dois estados de uma verificação feita', () => {
  const ruim = (campo, valor) => assert.equal(montar([dado(campo, valor)]).ok, false, `${campo}: ${JSON.stringify(valor)}`);
  const bom = (campo, valor) => assert.equal(montar([dado(campo, valor)]).ok, true, `${campo}: ${JSON.stringify(valor)}`);
  for (const v of ['exemplo.example.test', 'ftp://a.example.test', '<b>', 5, true, ['x']]) ruim('site.url', v);
  bom('site.url', 'https://a.example.test/p');
  for (const v of ['25/09/2026', '2026-02-30', '2026-09-27', 5, 'ontem', ['2026-09-01']]) ruim('instagram.ultimaPostagemEm', v);
  bom('instagram.ultimaPostagemEm', '2026-09-20');
  ruim('instagram.postagensObservadas', ['2026-09-01']);
  ruim('instagram.postagensObservadas', '2026-09-01');
  ruim('instagram.postagensObservadas', ['2026-09-01', 'ontem']);
  const trinta = Array.from({ length: 30 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
  bom('instagram.postagensObservadas', trinta);
  ruim('instagram.postagensObservadas', [...trinta, '2026-09-01']);
  assert.deepEqual(codigos(montar([dado('instagram.postagensObservadas', [...trinta, '2026-09-01'])])), ['fatos[0].valor:TAMANHO_EXCESSIVO']);
  assert.deepEqual(codigos(montar([dado('instagram.postagensObservadas', ['2026-09-01'])])), ['fatos[0].valor:VALOR_INVALIDO']);
  const comExtra = ['2026-09-01', '2026-09-02'];
  comExtra.extra = 'x';
  assert.deepEqual(codigos(montar([dado('instagram.postagensObservadas', comExtra)])), ['fatos[0].valor:ESTRUTURA_INVALIDA']);
  bom('instagram.postagensObservadas', ['2026-09-01', '2026-09-05']);
  ruim('instagram.cta', '');
  ruim('instagram.cta', 'x'.repeat(201));
  ruim('instagram.cta', 'com\u0000controle');
  bom('instagram.cta', 'Agende pelo link da bio');
  for (const campo of ['whatsapp.publico', 'site.ctaWhatsapp', 'site.ctaAgendamento', 'site.formularioContato']) {
    for (const v of [false, 'true', 1, 'sim', {}]) ruim(campo, v);
    bom(campo, true);
  }
  for (const campo of ['anuncios.meta', 'anuncios.google']) {
    for (const v of ['NAO_ANUNCIA', 'NAO_VERIFICAVEL', 'identificado', 5, false, true, '']) ruim(campo, v);
    bom(campo, 'IDENTIFICADO');
    bom(campo, 'NAO_ENCONTRADO_NA_VERIFICACAO');
  }
});

test('[DOS-12] a lista de datas de postagens é normalizada (só a data, sem duplicatas, em ordem)', () => {
  const r = montar([dado('instagram.postagensObservadas', ['2026-09-20T10:00:00Z', '2026-09-01', '2026-09-10', '2026-09-10', '2026-09-20'])]);
  assert.deepEqual(r.value.fatos[0].valor, ['2026-09-01', '2026-09-10', '2026-09-20']);
});

test('[DOS-13] limites de quantidade: fatos por dossiê (60), fatos por campo (5) e análises (20) — o limite passa, um acima é recusado', () => {
  assert.deepEqual([LIMITS.FATOS, LIMITS.FATOS_POR_CAMPO, LIMITS.ANALISES, LIMITS.BASE_POR_ANALISE, LIMITS.TEXTO_ANALISE, LIMITS.PROSPECT_ID], [60, 5, 20, 10, 600, 200], 'os limites documentados na decisão 0018');
  const muitos = Array.from({ length: 60 }, (_, i) => dado('site.url', `https://a${i}.example.test`));
  assert.equal(montar(muitos.slice(0, LIMITS.FATOS_POR_CAMPO)).ok, true);
  assert.deepEqual(codigos(montar(muitos.slice(0, LIMITS.FATOS_POR_CAMPO + 1))), [`fatos[${LIMITS.FATOS_POR_CAMPO}]:FATOS_DO_CAMPO_EXCESSIVOS`]);
  assert.deepEqual(codigos(montar(Array.from({ length: LIMITS.FATOS + 1 }, () => naoVerificado('site.url')))), ['fatos:FATOS_EXCESSIVOS']);
  const analises = (n) => Array.from({ length: n }, () => ({ tipo: 'OUTRO', texto: 'Texto de análise.', baseadoEm: [{ fato: 'site.url' }], status: 'ANALISE' }));
  assert.equal(montar([dado('site.url', 'https://a.example.test')], { analises: analises(LIMITS.ANALISES) }).ok, true);
  assert.deepEqual(codigos(montar([dado('site.url', 'https://a.example.test')], { analises: analises(LIMITS.ANALISES + 1) })), ['analises:ANALISES_EXCESSIVAS']);
});

test('[DOS-14] limites de tamanho e estrutura: texto acima do limite, lista com lacunas, propriedade com getter, Symbol, classe, aninhamento profundo e circular — recusados sem lançar nem estourar', () => {
  assert.equal(montar([dado('instagram.cta', 'x'.repeat(5000))]).ok, false);
  const lacunas = [];
  lacunas[1] = dado('site.url', 'https://a.example.test');
  assert.equal(montar(lacunas).ok, false);
  let executou = false;
  const comGetter = { campo: 'site.url', status: 'NAO_VERIFICADO', observadoEm: '2026-09-25' };
  Object.defineProperty(comGetter, 'valor', { enumerable: true, get() { executou = true; return null; } });
  assert.equal(montar([comGetter]).ok, false);
  assert.equal(executou, false, 'um getter nunca é executado');
  assert.equal(buildDossier({ prospectId: 'id:x', fatos: [], [Symbol('s')]: 1 }, opcoes).ok, false);
  class Fato { constructor() { Object.assign(this, naoVerificado('site.url')); } }
  assert.equal(montar([new Fato()]).errors[0].code, 'NAO_E_OBJETO');
  let fundo = 'x';
  for (let i = 0; i < 100000; i += 1) fundo = [fundo];
  assert.equal(buildDossier({ prospectId: 'id:x', fatos: fundo }, opcoes).errors[0].code, 'PROFUNDIDADE_EXCESSIVA');
  const circular = { prospectId: 'id:x', fatos: [] };
  circular.fatos.push(circular);
  assert.equal(buildDossier(circular, opcoes).ok, false);
  const muitosNos = { prospectId: 'id:x', fatos: Array.from({ length: 3000 }, () => 1) };
  assert.equal(buildDossier(muitosNos, opcoes).ok, false);
});

test('[DOS-15] prototype pollution: chaves __proto__/constructor/prototype na entrada, em fatos, fontes e análises são recusadas como desconhecidas e nada é poluído', () => {
  const hostil = JSON.parse('{"prospectId":"id:x","fatos":[],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const r = buildDossier(hostil, opcoes);
  assert.equal(r.ok, false);
  assert.deepEqual(codigos(r).sort(), ['?:CAMPO_DESCONHECIDO', 'constructor:CAMPO_DESCONHECIDO'].sort());
  const noFato = JSON.parse('{"campo":"site.url","status":"NAO_VERIFICADO","observadoEm":"2026-09-25","__proto__":{"polluted":true}}');
  assert.equal(montar([noFato]).ok, false);
  const naAnalise = JSON.parse('{"tipo":"OUTRO","texto":"x","status":"HIPOTESE","baseadoEm":[{"fato":"site.url"}],"__proto__":{"polluted":true}}');
  assert.equal(montar([naoVerificado('site.url')], { analises: [naAnalise] }).ok, false);
  assert.equal({}.polluted, undefined);
  // um campo herdado do protótipo nunca é um campo do catálogo, nem uma referência de análise
  assert.equal(montar([naoVerificado('site.url')], { analises: [{ tipo: 'OUTRO', texto: 'x', status: 'HIPOTESE', baseadoEm: [{ fato: 'constructor' }] }] }).errors[0].code, 'REFERENCIA_INVALIDA');
  assert.equal(montar([naoVerificado('site.url')], { analises: [{ tipo: 'OUTRO', texto: 'x', status: 'HIPOTESE', baseadoEm: [{ sinal: '__proto__' }] }] }).errors[0].code, 'REFERENCIA_INVALIDA');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fontes e datas
// ---------------------------------------------------------------------------------------------------------------------------------
test('[DOS-16] fonte HTTPS válida passa (com nome opcional); a fonte tem exatamente { url, tipo, observadoEm } (+ nome) e o tipo é o do domínio (OFICIAL | SECUNDARIA)', () => {
  const r = montar([{ ...dado('site.url', 'https://a.example.test'), fonte: fonte('2026-09-25', { nome: 'Site oficial' }) }, { ...dado('facebook.url', 'https://facebook.example.test/a'), fonte: fonte('2026-09-25', { tipo: SOURCE_TYPE.SECUNDARIA }) }]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value.fatos[0].fonte, { url: 'https://fonte.example.test/pagina', tipo: 'OFICIAL', observadoEm: '2026-09-25', nome: 'Site oficial' });
  assert.deepEqual(r.value.fontes.map((f) => f.tipo), ['OFICIAL', 'SECUNDARIA']);
  for (const tipo of ['oficial', 'PRIMARIA', 'VALIDADO', '', 5, null]) {
    const ruim = montar([{ ...dado('site.url', 'https://a.example.test'), fonte: fonte('2026-09-25', { tipo }) }]);
    assert.equal(ruim.ok, false, JSON.stringify(tipo));
    assert.equal(ruim.errors[0].path, 'fatos[0].fonte.tipo');
  }
  for (const faltando of ['url', 'tipo', 'observadoEm']) {
    const parcial = { ...fonte() };
    delete parcial[faltando];
    assert.deepEqual(codigos(montar([{ ...dado('site.url', 'https://a.example.test'), fonte: parcial }])), [`fatos[0].fonte.${faltando}:CAMPO_OBRIGATORIO`]);
  }
});

test('[DOS-17] fonte HTTP, e qualquer outro protocolo, é rejeitada: http, ftp, javascript:, data:, file:, blob:, //host — no url da fonte', () => {
  for (const url of ['http://fonte.example.test', 'ftp://fonte.example.test', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///C:/Windows/win.ini', 'blob:https://fonte.example.test/x', '//fonte.example.test/x', 'vbscript:msgbox(1)']) {
    const r = montar([{ ...dado('site.url', 'https://a.example.test'), fonte: fonte('2026-09-25', { url }) }]);
    assert.equal(r.ok, false, url);
    assert.deepEqual(codigos(r), ['fatos[0].fonte.url:PROTOCOLO_PROIBIDO'], url);
  }
});

test('[DOS-18] fonte malformada ou privada é rejeitada: sem domínio, com espaço, usuário/senha, porta, IP, localhost, host interno, texto solto, url gigante, tipo errado', () => {
  for (const url of ['https://', 'https:exemplo', 'https://semponto/x', 'https://a.example.test/com espaço', 'https://usuario:senha@a.example.test', 'https://a.example.test:8443/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://localhost/x', 'https://servidor.local/x', 'texto solto', '', '   ', 5, {}, [], `https://a.example.test/${'x'.repeat(3000)}`]) {
    const r = montar([{ ...dado('site.url', 'https://a.example.test'), fonte: fonte('2026-09-25', { url }) }]);
    assert.equal(r.ok, false, JSON.stringify(url).slice(0, 50));
    assert.equal(r.errors[0].path, 'fatos[0].fonte.url');
  }
  for (const valor of ['https://127.0.0.1/x', 'https://localhost/x', 'javascript:alert(1)', 'http://a.example.test']) assert.equal(montar([dado('site.url', valor)]).ok, false, `valor ${valor}`);
  assert.equal(montar([{ ...dado('site.url', 'https://a.example.test'), fonte: 'https://fonte.example.test' }]).errors[0].path, 'fatos[0].fonte');
  assert.equal(montar([{ ...dado('site.url', 'https://a.example.test'), fonte: [] }]).errors[0].code, 'NAO_E_OBJETO');
});

test('[DOS-19] datas inválidas: formato brasileiro, impossíveis, antes de 2000, tipos errados — no fato e na fonte; e a data da fonte tem de ser a da observação do fato', () => {
  for (const data of ['25/09/2026', '2026-13-01', '2026-02-30', '1999-12-31', 'ontem', '', 20260925, true, {}, [], new Date('2026-09-25')]) {
    const r = montar([{ ...dado('site.url', 'https://a.example.test'), observadoEm: data }]);
    assert.equal(r.ok, false, JSON.stringify(data));
    assert.ok(r.errors.some((e) => e.path === 'fatos[0].observadoEm'), JSON.stringify(data));
    assert.equal(montar([{ ...dado('site.url', 'https://a.example.test'), fonte: fonte('2026-09-25', { observadoEm: data }) }]).ok, false, `fonte ${JSON.stringify(data)}`);
  }
  assert.deepEqual(codigos(montar([{ ...dado('site.url', 'https://a.example.test'), observadoEm: '2026-09-24' }])), ['fatos[0].fonte.observadoEm:DATA_DIVERGENTE']);
  assert.equal(montar([{ ...dado('site.url', 'https://a.example.test'), observadoEm: '2026-09-25T10:30:00-03:00' }]).ok, true, 'a mesma data, com hora, é a mesma observação');
});

test('[DOS-20] data futura indevida: uma observação depois de amanhã é recusada (o relógio é injetável); e uma postagem do Instagram não pode ser posterior à observação', () => {
  assert.equal(montar([dado('site.url', 'https://a.example.test', '2026-09-27')]).ok, false);
  assert.equal(montar([dado('site.url', 'https://a.example.test', '2027-01-01')]).ok, false);
  assert.equal(montar([dado('site.url', 'https://a.example.test', '2026-09-26')]).ok, true, 'até amanhã (fuso)');
  assert.equal(buildDossier(entrada([dado('site.url', 'https://a.example.test', '2026-09-27')]), { now: new Date('2026-09-28T00:00:00Z'), newId: () => ID }).ok, true);
  assert.deepEqual(codigos(montar([dado('instagram.ultimaPostagemEm', '2026-09-26', '2026-09-25')])), ['fatos.instagram.ultimaPostagemEm:POSTAGEM_APOS_OBSERVACAO']);
  assert.deepEqual(codigos(montar([dado('instagram.postagensObservadas', ['2026-09-20', '2026-09-26'], '2026-09-25')])), ['fatos.instagram.postagensObservadas:POSTAGEM_APOS_OBSERVACAO']);
  assert.deepEqual(codigos(montar([dado('instagram.ultimaPostagemEm', '2026-09-10'), dado('instagram.postagensObservadas', ['2026-09-01', '2026-09-20'])])), ['fatos.instagram.ultimaPostagemEm:POSTAGENS_INCONSISTENTES']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Sinais
// ---------------------------------------------------------------------------------------------------------------------------------
test('[DOS-21] os sinais conhecidos nascem de fatos, por regras fixas: canais, contato público, chamadas e formulário — status DADO, evidências = ids dos fatos, derivadoEm = o relógio', () => {
  const r = montar([
    dado('site.url', 'https://clinica.example.test'),
    dado('googlePerfil.url', 'https://maps.example.test/clinica'),
    dado('facebook.url', 'https://facebook.example.test/clinica'),
    dado('linkedin.url', 'https://linkedin.example.test/company/clinica'),
    dado('youtube.url', 'https://youtube.example.test/@clinica'),
    dado('whatsapp.publico', true),
    dado('site.ctaWhatsapp', true),
    dado('site.ctaAgendamento', true),
    dado('site.formularioContato', true),
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const esperados = { SITE_EXISTENTE: ['PRESENTE', 'fato:site.url'], GOOGLE_PERFIL_EXISTENTE: ['PRESENTE', 'fato:googlePerfil.url'], FACEBOOK_EXISTENTE: ['PRESENTE', 'fato:facebook.url'], LINKEDIN_EXISTENTE: ['PRESENTE', 'fato:linkedin.url'], YOUTUBE_EXISTENTE: ['PRESENTE', 'fato:youtube.url'], WHATSAPP_PUBLICO: ['PRESENTE', 'fato:whatsapp.publico'], CTA_WHATSAPP: ['OBSERVADO', 'fato:site.ctaWhatsapp'], CTA_AGENDAMENTO: ['OBSERVADO', 'fato:site.ctaAgendamento'], FORMULARIO_CONTATO: ['OBSERVADO', 'fato:site.formularioContato'] };
  for (const [tipo, [valor, evidencia]] of Object.entries(esperados)) {
    const s = sinal(r, tipo);
    assert.deepEqual([s.sinalId, s.valor, s.status, s.evidencias, s.derivadoEm], [`sinal:${tipo}`, valor, 'DADO', [evidencia], AGORA.toISOString()], tipo);
    assert.deepEqual(Object.keys(s).sort(), ['derivadoEm', 'evidencias', 'sinalId', 'status', 'tipo', 'valor']);
  }
  assert.equal(r.value.sinais.length, 9);
});

test('[DOS-22] o vocabulário de sinais é FECHADO e o consumidor nunca envia um sinal: nome desconhecido, sinal na entrada e sinal derivado de campo que não existe são impossíveis', () => {
  assert.deepEqual(Object.values(SIGNAL_TYPE).sort(), ['ANUNCIO_GOOGLE', 'ANUNCIO_META', 'CTA_AGENDAMENTO', 'CTA_WHATSAPP', 'FACEBOOK_EXISTENTE', 'FORMULARIO_CONTATO', 'GOOGLE_PERFIL_EXISTENTE', 'INSTAGRAM_ATIVIDADE', 'INSTAGRAM_EXISTENTE', 'LINKEDIN_EXISTENTE', 'SITE_EXISTENTE', 'WHATSAPP_PUBLICO', 'YOUTUBE_EXISTENTE']);
  assert.equal(Object.isFrozen(SIGNAL_TYPE), true);
  for (const tipo of ['INSTAGRAM_ATIVO', 'SITE_NAO_ENCONTRADO', 'NAO_ANUNCIA', 'SCORE_ALTO', 'LEAD_QUENTE', '__proto__', 'constructor']) {
    assert.equal(Object.values(SIGNAL_TYPE).includes(tipo), false, tipo);
    assert.deepEqual(codigos(montar([], { sinais: [{ tipo, valor: 'X', status: 'DADO' }] })), ['sinais:CAMPO_DESCONHECIDO'], `${tipo} enviado`);
  }
  assert.deepEqual(montar([]).value.sinais, [], 'sem fato, sem sinal (a ausência de sinal não é a ausência da coisa)');
  assert.equal(montar([dado('site.url', 'https://a.example.test')]).value.sinais.some((s) => s.tipo === 'INSTAGRAM_EXISTENTE'), false);
});

test('[DOS-23] só há sinal DADO com fatos DADO: um fato NAO_VERIFICADO dá um sinal NAO_VERIFICADO de valor nulo — nunca um "não existe"', () => {
  const r = montar([naoVerificado('site.url'), naoVerificado('site.formularioContato'), naoVerificado('whatsapp.publico')]);
  for (const tipo of ['SITE_EXISTENTE', 'FORMULARIO_CONTATO', 'WHATSAPP_PUBLICO']) {
    const s = sinal(r, tipo);
    assert.deepEqual([s.status, s.valor], ['NAO_VERIFICADO', null], tipo);
  }
  assert.equal(r.value.sinais.some((s) => /NAO_ENCONTRADO|INEXISTENTE|AUSENTE|NAO_TEM|SEM_/.test(JSON.stringify(s.valor) + s.tipo)), false);
});

test('[DOS-24] conflito factual: dois fatos DADO do mesmo campo com valores diferentes tornam o sinal NAO_VERIFICADO (nenhum valor é escolhido em silêncio); dois fatos que concordam mantêm DADO com as duas evidências', () => {
  const conflito = montar([dado('site.url', 'https://a.example.test'), { ...dado('site.url', 'https://b.example.test'), fonte: fonte('2026-09-25', { tipo: SOURCE_TYPE.SECUNDARIA }) }]);
  assert.equal(conflito.ok, true);
  assert.deepEqual(conflito.value.fatos.map((f) => f.factId), ['fato:site.url', 'fato:site.url#2'], 'os dois fatos ficam, cada um com a sua fonte');
  const s = sinal(conflito, 'SITE_EXISTENTE');
  assert.deepEqual([s.status, s.valor, s.evidencias], ['NAO_VERIFICADO', null, ['fato:site.url', 'fato:site.url#2']]);
  const concordam = montar([dado('site.url', 'https://a.example.test'), { ...dado('site.url', 'https://a.example.test'), fonte: fonte('2026-09-25', { url: 'https://outra.example.test/x' }) }]);
  const c = sinal(concordam, 'SITE_EXISTENTE');
  assert.deepEqual([c.status, c.valor, c.evidencias], ['DADO', 'PRESENTE', ['fato:site.url', 'fato:site.url#2']]);
  assert.equal(concordam.value.fontes.length, 2);
});

test('[DOS-25] Instagram: nunca "ativo = true" — o sinal guarda a data da observação, a última postagem, os dias desde ela, se foi nos últimos 15 dias, a frequência aparente (só com ≥ 3 datas), a CTA e a URL; e a existência do perfil sozinha só dá INSTAGRAM_EXISTENTE', () => {
  const r = montar(instagramCompleto());
  const s = sinal(r, 'INSTAGRAM_ATIVIDADE');
  assert.equal(s.status, 'DADO');
  assert.deepEqual(s.valor, { dataDaObservacao: '2026-09-25', ultimaPostagemEm: '2026-09-20', diasDesdeUltimaPostagem: 5, postouNosUltimos15Dias: true, frequenciaAparente: { postagensObservadas: 3, intervaloMedioDias: 9.5 }, cta: 'Agende pelo link da bio', url: 'https://instagram.example.test/clinica' });
  assert.deepEqual(s.evidencias.sort(), ['fato:instagram.cta', 'fato:instagram.postagensObservadas', 'fato:instagram.url']);
  for (const proibido of ['ativo', 'ATIVO', 'perfilAtivo']) assert.equal(JSON.stringify(r.value.sinais).includes(proibido), false, proibido);

  const soPerfil = montar([dado('instagram.url', 'https://instagram.example.test/clinica')]);
  assert.deepEqual(soPerfil.value.sinais.map((x) => x.tipo), ['INSTAGRAM_EXISTENTE'], 'só o perfil: nenhuma atividade é afirmada');
  assert.equal(RECENT_POST_DAYS, 15);
});

test('[DOS-26] Instagram: os 15 dias — 15 dias é "recente", 16 não; os dias vêm da data da observação; sem frequência com menos de 3 datas; a última postagem sozinha basta para o sinal', () => {
  const dias = (ultima, observacao) => sinal(montar([dado('instagram.ultimaPostagemEm', ultima, observacao)]), 'INSTAGRAM_ATIVIDADE').valor;
  assert.deepEqual([dias('2026-09-25', '2026-09-25').diasDesdeUltimaPostagem, dias('2026-09-25', '2026-09-25').postouNosUltimos15Dias], [0, true]);
  assert.deepEqual([dias('2026-09-10', '2026-09-25').diasDesdeUltimaPostagem, dias('2026-09-10', '2026-09-25').postouNosUltimos15Dias], [15, true]);
  assert.deepEqual([dias('2026-09-09', '2026-09-25').diasDesdeUltimaPostagem, dias('2026-09-09', '2026-09-25').postouNosUltimos15Dias], [16, false]);
  assert.deepEqual([dias('2025-09-25', '2026-09-25').diasDesdeUltimaPostagem, dias('2025-09-25', '2026-09-25').postouNosUltimos15Dias], [365, false]);
  const so = dias('2026-09-20', '2026-09-25');
  assert.deepEqual([so.frequenciaAparente, so.cta, so.url], [null, null, null]);
  const duas = sinal(montar([dado('instagram.postagensObservadas', ['2026-09-01', '2026-09-11'])]), 'INSTAGRAM_ATIVIDADE').valor;
  assert.equal(duas.frequenciaAparente, null, 'duas datas não bastam para dizer frequência');
  assert.equal(duas.ultimaPostagemEm, '2026-09-11');
  const tres = sinal(montar([dado('instagram.postagensObservadas', ['2026-09-01', '2026-09-11', '2026-09-21'])]), 'INSTAGRAM_ATIVIDADE').valor;
  assert.deepEqual(tres.frequenciaAparente, { postagensObservadas: 3, intervaloMedioDias: 10 });
});

test('[DOS-26b] Instagram: intervalo médio arredondado a uma casa; CTA/URL em conflito não entram no sinal nem nas evidências', () => {
  const f = sinal(montar([dado('instagram.postagensObservadas', ['2026-09-01', '2026-09-04', '2026-09-08', '2026-09-11'])]), 'INSTAGRAM_ATIVIDADE').valor.frequenciaAparente;
  assert.deepEqual(f, { postagensObservadas: 4, intervaloMedioDias: 3.3 });
  const r = montar([dado('instagram.ultimaPostagemEm', '2026-09-20'), dado('instagram.cta', 'Agende'), dado('instagram.cta', 'Compre agora'), dado('instagram.url', 'https://instagram.example.test/a'), dado('instagram.url', 'https://instagram.example.test/b')]);
  const s = sinal(r, 'INSTAGRAM_ATIVIDADE');
  assert.deepEqual([s.valor.cta, s.valor.url], [null, null]);
  assert.deepEqual(s.evidencias, ['fato:instagram.ultimaPostagemEm']);
});

test('[DOS-27] Instagram: fato NAO_VERIFICADO ou em conflito dá INSTAGRAM_ATIVIDADE NAO_VERIFICADO de valor nulo (nenhuma atividade é inventada)', () => {
  const naoVer = sinal(montar([naoVerificado('instagram.ultimaPostagemEm')]), 'INSTAGRAM_ATIVIDADE');
  assert.deepEqual([naoVer.status, naoVer.valor, naoVer.evidencias], ['NAO_VERIFICADO', null, ['fato:instagram.ultimaPostagemEm']]);
  const conflito = sinal(montar([dado('instagram.ultimaPostagemEm', '2026-09-20'), dado('instagram.ultimaPostagemEm', '2026-09-01')]), 'INSTAGRAM_ATIVIDADE');
  assert.deepEqual([conflito.status, conflito.valor], ['NAO_VERIFICADO', null]);
});

test('[DOS-28] anúncios: três estados distintos — IDENTIFICADO, NAO_ENCONTRADO_NA_VERIFICACAO (uma verificação feita, com fonte e data) e NAO_VERIFICAVEL (fato NAO_VERIFICADO) — e nunca "não anuncia"', () => {
  const r = montar([dado('anuncios.meta', 'IDENTIFICADO'), dado('anuncios.google', 'NAO_ENCONTRADO_NA_VERIFICACAO'), naoVerificado('anuncios.meta', '2026-09-24')]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const meta = sinal(r, 'ANUNCIO_META');
  const google = sinal(r, 'ANUNCIO_GOOGLE');
  assert.deepEqual([meta.valor, meta.status], ['IDENTIFICADO', 'DADO'], 'IDENTIFICADO prevalece sobre um "não verificável" de outra tentativa');
  assert.deepEqual([google.valor, google.status], ['NAO_ENCONTRADO_NA_VERIFICACAO', 'DADO']);
  const naoVer = sinal(montar([naoVerificado('anuncios.google')]), 'ANUNCIO_GOOGLE');
  assert.deepEqual([naoVer.valor, naoVer.status], ['NAO_VERIFICAVEL', 'NAO_VERIFICADO']);
  assert.deepEqual(Object.values(ADS_STATE).sort(), ['IDENTIFICADO', 'NAO_ENCONTRADO_NA_VERIFICACAO', 'NAO_VERIFICAVEL']);
  // "não encontrado" exige fonte: sem ela não é um fato
  assert.equal(montar([{ campo: 'anuncios.meta', valor: 'NAO_ENCONTRADO_NA_VERIFICACAO', status: 'DADO', observadoEm: '2026-09-25' }]).ok, false);
  // IDENTIFICADO prevalece sobre NAO_ENCONTRADO de outra fonte; e dois NAO_ENCONTRADO concordam
  const dois = sinal(montar([dado('anuncios.meta', 'NAO_ENCONTRADO_NA_VERIFICACAO'), dado('anuncios.meta', 'IDENTIFICADO', '2026-09-25', { fonte: fonte('2026-09-25', { url: 'https://biblioteca.example.test/a' }) })]), 'ANUNCIO_META');
  assert.deepEqual([dois.valor, dois.evidencias], ['IDENTIFICADO', ['fato:anuncios.meta#2']]);
});

test('[DOS-29] os sinais são determinísticos: os mesmos fatos dão os mesmos sinais, na mesma ordem, e a ordem dos fatos de entrada não muda o conjunto', () => {
  const fatos = [...instagramCompleto(), dado('site.url', 'https://clinica.example.test'), dado('anuncios.meta', 'IDENTIFICADO'), dado('whatsapp.publico', true)];
  const a = montar(fatos);
  const b = montar(fatos);
  assert.deepEqual(a.value.sinais, b.value.sinais);
  const invertida = montar([...fatos].reverse());
  const chave = (r) => r.value.sinais.map((s) => JSON.stringify([s.tipo, s.valor, s.status, [...s.evidencias].sort()])).sort();
  assert.deepEqual(chave(a), chave(invertida));
  assert.deepEqual(a.value.sinais.map((s) => s.tipo), ['SITE_EXISTENTE', 'INSTAGRAM_EXISTENTE', 'WHATSAPP_PUBLICO', 'ANUNCIO_META', 'INSTAGRAM_ATIVIDADE'].sort((x, y) => a.value.sinais.map((s) => s.tipo).indexOf(x) - a.value.sinais.map((s) => s.tipo).indexOf(y)));
  assert.deepEqual(deriveSignals([], AGORA.toISOString()), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Análises e hipóteses
// ---------------------------------------------------------------------------------------------------------------------------------
const analise = (extras = {}) => ({ tipo: 'ATIVIDADE_SOCIAL', texto: 'Última postagem observada há 5 dias, com chamada para agendar.', baseadoEm: [{ sinal: 'INSTAGRAM_ATIVIDADE' }], status: 'ANALISE', ...extras });

test('[DOS-30] análise válida: baseada em fato ou sinal do próprio dossiê, com status ANALISE, id derivado e a base resolvida para ids', () => {
  const r = montar(instagramCompleto(), { analises: [analise(), analise({ baseadoEm: [{ fato: 'instagram.cta' }, { sinal: 'INSTAGRAM_EXISTENTE' }, { fato: 'instagram.cta' }] })] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value.analises[0], { analiseId: 'analise:001', tipo: 'ATIVIDADE_SOCIAL', texto: 'Última postagem observada há 5 dias, com chamada para agendar.', baseadoEm: ['sinal:INSTAGRAM_ATIVIDADE'], status: 'ANALISE' });
  assert.deepEqual(r.value.analises[1].baseadoEm, ['fato:instagram.cta', 'sinal:INSTAGRAM_EXISTENTE'], 'referências repetidas viram uma só');
  assert.equal(r.value.analises[1].analiseId, 'analise:002');
});

test('[DOS-31] hipótese separada de fato: HIPOTESE vive só em analises (nunca em fatos), pode se apoiar num fato NAO_VERIFICADO, e um status de hipótese num fato é recusado', () => {
  const r = montar([naoVerificado('site.ctaAgendamento')], { analises: [{ tipo: 'CONVERSAO', texto: 'Possível ausência de agendamento online (não confirmada).', baseadoEm: [{ fato: 'site.ctaAgendamento' }], status: 'HIPOTESE' }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.analises[0].status, 'HIPOTESE');
  assert.equal(r.value.fatos.some((f) => f.status === 'HIPOTESE'), false);
  assert.equal(r.value.fatos.every((f) => ['DADO', 'NAO_VERIFICADO'].includes(f.status)), true);
  assert.equal(montar([{ ...naoVerificado('site.ctaAgendamento'), status: 'HIPOTESE' }]).ok, false, 'uma hipótese não entra como fato');
  assert.equal(montar([naoVerificado('site.ctaAgendamento')], { hipoteses: [] }).ok, false, 'não existe outro lugar para hipóteses');
  assert.deepEqual(Object.keys(ANALYSIS_STATUS), ['ANALISE', 'HIPOTESE']);
});

test('[DOS-32] análise sem evidência é rejeitada: ANALISE precisa de ao menos um fato/sinal DADO; só NAO_VERIFICADO na base exige HIPOTESE; sem base nenhuma, nada passa', () => {
  const soNaoVerificado = montar([naoVerificado('site.ctaAgendamento')], { analises: [analise({ baseadoEm: [{ fato: 'site.ctaAgendamento' }] })] });
  assert.deepEqual(codigos(soNaoVerificado), ['analises[0].status:ANALISE_SEM_EVIDENCIA']);
  const sinalNaoVerificado = montar([naoVerificado('anuncios.meta')], { analises: [analise({ tipo: 'ANUNCIOS', baseadoEm: [{ sinal: 'ANUNCIO_META' }] })] });
  assert.deepEqual(codigos(sinalNaoVerificado), ['analises[0].status:ANALISE_SEM_EVIDENCIA']);
  const misto = montar([naoVerificado('site.ctaAgendamento'), dado('site.url', 'https://a.example.test')], { analises: [analise({ baseadoEm: [{ fato: 'site.ctaAgendamento' }, { fato: 'site.url' }] })] });
  assert.equal(misto.ok, true, 'um fato DADO na base basta');
  for (const baseadoEm of [undefined, null, []]) {
    for (const status of ['ANALISE', 'HIPOTESE']) assert.deepEqual(codigos(montar([dado('site.url', 'https://a.example.test')], { analises: [analise({ baseadoEm, status })] })), ['analises[0].baseadoEm:ANALISE_SEM_BASE'], `${status} ${JSON.stringify(baseadoEm)}`);
  }
});

test('[DOS-33] a base da análise só cita o que existe no dossiê: fato ou sinal inexistente, referência com formato errado, com duas chaves, ou acima do limite, é recusada', () => {
  const um = [dado('site.url', 'https://a.example.test')];
  const com = (baseadoEm) => montar(um, { analises: [analise({ baseadoEm })] });
  assert.deepEqual(codigos(com([{ fato: 'instagram.cta' }])), ['analises[0].baseadoEm[0]:REFERENCIA_INVALIDA']);
  assert.deepEqual(codigos(com([{ sinal: 'INSTAGRAM_ATIVIDADE' }])), ['analises[0].baseadoEm[0]:REFERENCIA_INVALIDA']);
  assert.deepEqual(codigos(com([{ sinal: 'SCORE_ALTO' }])), ['analises[0].baseadoEm[0]:REFERENCIA_INVALIDA']);
  for (const ruim of ['fato:site.url', 5, null, [], {}, { fato: 5 }, { fato: 'site.url', sinal: 'SITE_EXISTENTE' }, { id: 'fato:site.url' }, { fato: 'site.url', extra: 1 }]) assert.equal(com([ruim]).ok, false, JSON.stringify(ruim));
  assert.equal(com({}).ok, false);
  for (const chave of ['SITE_EXISTENTE', 'foo', 'id', 'Fato', 'SINAL']) assert.equal(com([{ [chave]: 'SITE_EXISTENTE' }]).ok, false, chave);
  assert.deepEqual(codigos(com([{ foo: 'SITE_EXISTENTE' }])), ['analises[0].baseadoEm[0]:ESTRUTURA_INVALIDA']);
  assert.equal(com(Array.from({ length: LIMITS.BASE_POR_ANALISE }, () => ({ fato: 'site.url' }))).ok, true);
  assert.deepEqual(codigos(com(Array.from({ length: LIMITS.BASE_POR_ANALISE + 1 }, () => ({ fato: 'site.url' })))), ['analises[0].baseadoEm:BASE_EXCESSIVA']);
  // uma análise não pode citar o factId (só o campo): os ids são do sistema
  assert.equal(com([{ fato: 'fato:site.url' }]).ok, false);
});

test('[DOS-34] status e tipo de análise: só ANALISE | HIPOTESE e os tipos do vocabulário fechado; DADO, NAO_VERIFICADO e VALIDADO numa análise são recusados (análise nunca se apresenta como DADO)', () => {
  const um = [dado('site.url', 'https://a.example.test')];
  for (const status of ['DADO', 'NAO_VERIFICADO', 'VALIDADO', 'analise', '', 'FATO']) assert.deepEqual(codigos(montar(um, { analises: [analise({ status, baseadoEm: [{ fato: 'site.url' }] })] })), ['analises[0].status:STATUS_INVALIDO'], JSON.stringify(status));
  for (const status of [5, true, [], {}]) assert.deepEqual(codigos(montar(um, { analises: [analise({ status, baseadoEm: [{ fato: 'site.url' }] })] })), ['analises[0].status:TIPO_INVALIDO']);
  assert.deepEqual(codigos(montar(um, { analises: [{ tipo: 'OUTRO', texto: 'x', baseadoEm: [{ fato: 'site.url' }] }] })), ['analises[0].status:CAMPO_OBRIGATORIO']);
  for (const tipo of ['SCORE', 'LEAD_QUENTE', 'prioridade', '__proto__', 'constructor', '', 5, null]) assert.equal(montar(um, { analises: [analise({ tipo, baseadoEm: [{ fato: 'site.url' }] })] }).ok, false, JSON.stringify(tipo));
  assert.deepEqual(Object.keys(ANALYSIS_TYPE).sort(), ['ANUNCIOS', 'ATIVIDADE_SOCIAL', 'CONVERSAO', 'OUTRO', 'PRESENCA_DIGITAL']);
  assert.equal(montar(um, { analises: [{ ...analise({ baseadoEm: [{ fato: 'site.url' }] }), id: 'x' }] }).errors[0].code, 'CAMPO_DESCONHECIDO');
  assert.equal(montar(um, { analises: 'texto' }).errors[0].code, 'NAO_E_LISTA');
  assert.equal(montar(um, { analises: [null] }).ok, false);
});

test('[DOS-35] o texto da análise: sem promessa de resultado, sem urgência artificial, sem "não anuncia" — mas o texto honesto ("não encontrado na verificação") passa', () => {
  const base = [dado('anuncios.meta', 'NAO_ENCONTRADO_NA_VERIFICACAO')];
  const com = (texto) => montar(base, { analises: [{ tipo: 'ANUNCIOS', texto, baseadoEm: [{ fato: 'anuncios.meta' }], status: 'ANALISE' }] });
  for (const texto of ['Não anuncia no Meta.', 'não anuncia', 'A empresa não faz anúncios.', 'Não investe em anúncios pagos', 'Resultado garantido com tráfego pago', 'Garantimos mais clientes', 'É urgente agir agora', 'Urgência: última chance', 'Oferta imperdível só hoje', 'Vai dobrar as vendas', 'Vai aumentar o faturamento', 'Podemos triplicar os leads', 'Não possui anúncios']) {
    assert.deepEqual(codigos(com(texto)), ['analises[0].texto:TEXTO_PROIBIDO'], texto);
  }
  for (const texto of ['Anúncio não encontrado na verificação da biblioteca de anúncios em 25/09/2026.', 'Não foi possível verificar anúncios do Google.', 'A verificação não identificou anúncios ativos na data consultada.']) assert.equal(com(texto).ok, true, texto);
  assert.equal(com('').ok, false);
  assert.equal(com('x'.repeat(LIMITS.TEXTO_ANALISE + 1)).ok, false);
  assert.equal(com('com\u0000controle').ok, false);
  assert.ok(FORBIDDEN_TEXT.length >= 8);
});

test('[DOS-35b] o texto da análise pode ter várias linhas (mas nunca caracteres de controle)', () => {
  const r = montar([dado('site.url', 'https://a.example.test')], { analises: [{ tipo: 'OUTRO', texto: 'Linha um.\nLinha dois.', baseadoEm: [{ fato: 'site.url' }], status: 'ANALISE' }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('[DOS-36] não existe score, ranking, temperatura, prioridade nem decisão: nada disso aparece no dossiê, nos sinais nem no vocabulário; e o dossiê não escreve em campo do CRM', () => {
  const r = montar([...instagramCompleto(), dado('site.url', 'https://a.example.test'), dado('anuncios.meta', 'IDENTIFICADO')], { analises: [analise()] });
  const texto = JSON.stringify(r.value);
  for (const proibido of ['score', 'ranking', 'temperatura', 'prioridade', 'melhorLead', 'problemaIdentificado', 'quente', 'aprovado', 'aprovacao', 'crm']) assert.equal(texto.toLowerCase().includes(proibido.toLowerCase()), false, proibido);
  assert.equal(Object.keys(SIGNAL_TYPE).some((tipo) => /SCORE|RANK|TEMPERATURA|PRIORIDADE|QUENTE|MELHOR/.test(tipo)), false);
  assert.deepEqual(Object.keys(SIGNAL_STATUS), ['DADO', 'NAO_VERIFICADO']);
});

test('[DOS-37] os vocabulários: os status do dossiê seguem o esquema DADO/ANALISE/HIPOTESE/NAO_VERIFICADO da documentação, e NÃO se misturam com o esquema VALIDADO/HIPOTESE/NAO_VERIFICADO da confiança dos campos do prospect', () => {
  assert.equal(Object.values(FACT_STATUS).includes(INFO_STATUS.VALIDADO), false, 'VALIDADO é da confiança dos campos do prospect');
  assert.equal(Object.values(ANALYSIS_STATUS).includes(INFO_STATUS.NAO_VERIFICADO), false);
  assert.equal(FACT_STATUS.NAO_VERIFICADO, INFO_STATUS.NAO_VERIFICADO, 'o NAO_VERIFICADO é o mesmo termo');
  assert.equal(ANALYSIS_STATUS.HIPOTESE, INFO_STATUS.HIPOTESE, 'o HIPOTESE é o mesmo termo');
  assert.deepEqual(Object.values(SOURCE_TYPE).sort(), ['OFICIAL', 'SECUNDARIA'], 'o tipo de fonte é o do domínio, não um novo');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Erros, cópia e arquitetura
// ---------------------------------------------------------------------------------------------------------------------------------
test('[DOS-38] o erro nunca repete o valor recusado: só caminho (chaves conhecidas e índices), código e frase fixa; no máximo 50; e o resultado é uma CÓPIA independente da entrada', () => {
  const segredo = 'SEGREDO-NAO-REPETIR-<script>alert(1)</script>';
  const r = buildDossier({ prospectId: segredo + '\u0000', fatos: [{ campo: segredo, valor: segredo, status: segredo, observadoEm: segredo, fonte: { url: `javascript:${segredo}`, tipo: segredo, observadoEm: segredo } }], [segredo]: 1 }, opcoes);
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(r.errors).includes('SEGREDO'), false);
  assert.equal(JSON.stringify(r.errors).includes('script'), false);
  for (const erro of r.errors) assert.deepEqual(Object.keys(erro).sort(), ['code', 'message', 'path']);
  const muitos = buildDossier({ prospectId: 'id:x', fatos: Array.from({ length: 60 }, () => 5) }, opcoes);
  assert.ok(muitos.errors.length <= 50);

  const original = entrada([dado('site.url', 'https://a.example.test')]);
  const ok = buildDossier(original, opcoes);
  original.fatos[0].valor = 'https://alterado.example.test';
  original.fatos[0].fonte.url = 'https://alterado.example.test';
  assert.equal(ok.value.fatos[0].valor, 'https://a.example.test');
  assert.equal(ok.value.fatos[0].fonte.url, 'https://fonte.example.test/pagina');
  assert.notEqual(ok.value.fatos[0].fonte, original.fatos[0].fonte);
});

test('[DOS-39] o dossiê é independente do CRM, do disco e da rede: os módulos só importam irmãos e o esquema; nenhum importa src/crm, serviços, auth, servidor ou fila; e nenhum identificador de escrita no CRM existe', () => {
  const raiz = path.join(__dirname, '..', '..');
  for (const nome of ['dossier.js', 'signalSchema.js', 'dossierRepository.js']) {
    const arquivo = path.join(raiz, 'src', 'research-prospector', nome);
    const codigo = fs.readFileSync(arquivo, 'utf8');
    const analise = analyzeSource(codigo, toPosix(path.relative(raiz, arquivo)));
    assert.deepEqual(analise.issues, [], nome);
    for (const ref of analise.refs) {
      assert.match(ref.specifier, /^(\.\/(rawFindingSchema|signalSchema|dossier|batchRepository)|node:(fs|path|crypto))$/, `${nome} importa ${ref.specifier}`);
      assert.doesNotMatch(ref.specifier, /crm|services|auth|server|approvalQueue|discovery/i, `${nome}`);
    }
    const semComentarios = codigo.replace(/\/\/.*$/gm, '');
    for (const proibido of [/\bcreateRecord\b|\bupdateRecord\b|\bmoveStatus\b|\bmarkDoNotContact\b|\bcrmService\b|\bCrmService\b/, /\bfetch\(/, /XMLHttpRequest|WebSocket/, /child_process|node:https?|node:net|node:dns/, /\beval\(|new Function/, /process\.env/]) assert.doesNotMatch(semComentarios, proibido, `${nome}: ${proibido}`);
  }
  // só o repositório toca o disco; o domínio e os sinais são puros
  for (const nome of ['dossier.js', 'signalSchema.js']) assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'src', 'research-prospector', nome), 'utf8').replace(/\/\/.*$/gm, ''), /node:fs|node:path/, nome);
  // a Approval Queue não conhece o dossiê (o schema dos itens não mudou)
  assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'src', 'research-prospector', 'approvalQueue.js'), 'utf8'), /dossie|dossier/i);
  assert.doesNotMatch(fs.readFileSync(path.join(raiz, 'src', 'research-prospector', 'discovery.js'), 'utf8'), /dossie|dossier/i, 'o discovery continua sem conhecer o dossiê');
  // (a integração ao Prospecting Service veio na decisão 0019 e tem os seus próprios testes)
});

test('[DOS-40] executar o dossiê não escreve no CRM nem em nenhum arquivo: montar dossiês válidos e inválidos não cria, altera ou lê arquivo algum', () => {
  const escritas = [];
  const originais = {};
  for (const nome of ['writeFileSync', 'renameSync', 'openSync', 'mkdirSync', 'appendFileSync', 'readFileSync']) {
    originais[nome] = fs[nome];
    fs[nome] = (...args) => { escritas.push(nome); return originais[nome](...args); };
  }
  try {
    for (let i = 0; i < 5; i += 1) buildDossier(entrada([...instagramCompleto(), dado('anuncios.meta', 'IDENTIFICADO')], { analises: [analise()] }), opcoes);
    buildDossier(null, opcoes);
    buildDossier(entrada([{ campo: 'x' }]), opcoes);
  } finally {
    Object.assign(fs, originais);
  }
  assert.deepEqual(escritas, [], 'nenhuma operação de arquivo');
});
