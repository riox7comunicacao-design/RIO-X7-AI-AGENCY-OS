// prospectingBrief.js (Etapa "Prospecção 1" — Workbench): validação PURA do formulário "Novo lote", resumo de
// geografia e id amigável do brief (PROS-YYYYMMDD-NNN).

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateBriefInput, summarizeGeografia, buildBriefId, splitList, BRIEF_ID_PATTERN, GEO_LEVEL, LIMITS } = require('../../src/research-prospector/prospectingBrief');

const valido = (extra = {}) => ({ nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis, Teresópolis', quantidade: 50, ...extra });

test('[BRIEF-1] um brief válido (cidade, múltiplas cidades) passa; quantidade e cidades chegam como listas/limpas', () => {
  const resultado = validateBriefInput(valido({ subnicho: 'Harmonização facial', observacoes: 'Objetivo de teste' }));
  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.value, {
    nicho: 'Clínicas de estética',
    subnicho: 'Harmonização facial',
    nivelGeografico: 'CIDADE',
    cidades: ['Petrópolis', 'Teresópolis'],
    quantidade: 50,
    observacoes: 'Objetivo de teste',
  });
});

test('[BRIEF-2] nível ESTADO: exige `estados` (múltiplos, por vírgula); CIDADE não entra na saída', () => {
  const resultado = validateBriefInput({ nicho: 'Odontologia', nivelGeografico: 'ESTADO', estados: 'RJ, SP', quantidade: 10 });
  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.value.estados, ['RJ', 'SP']);
  assert.equal(resultado.value.cidades, undefined);
});

test('[BRIEF-3] nível NACIONAL: país é opcional, com "Brasil" como padrão quando omitido — nunca inventado se outro país for digitado', () => {
  const semPais = validateBriefInput({ nicho: 'Clínicas', nivelGeografico: 'NACIONAL', quantidade: 5 });
  assert.equal(semPais.ok, true);
  assert.equal(semPais.value.pais, 'Brasil');

  const comPais = validateBriefInput({ nicho: 'Clínicas', nivelGeografico: 'NACIONAL', pais: 'Portugal', quantidade: 5 });
  assert.equal(comPais.ok, true);
  assert.equal(comPais.value.pais, 'Portugal');
});

test('[BRIEF-4] nicho é obrigatório; nível geográfico é obrigatório e só aceita CIDADE/ESTADO/NACIONAL', () => {
  assert.deepEqual(
    validateBriefInput({ nivelGeografico: 'CIDADE', cidades: 'X', quantidade: 1 }).errors.map((e) => e.path),
    ['nicho']
  );
  const semNivel = validateBriefInput({ nicho: 'X', quantidade: 1 });
  assert.ok(semNivel.errors.some((e) => e.path === 'nivelGeografico' && e.code === 'CAMPO_OBRIGATORIO'));
  const nivelInvalido = validateBriefInput({ nicho: 'X', nivelGeografico: 'PLANETA', quantidade: 1 });
  assert.ok(nivelInvalido.errors.some((e) => e.path === 'nivelGeografico' && e.code === 'VALOR_INVALIDO'));
});

test('[BRIEF-5] cidade(s)/estado(s) são obrigatórios quando o nível exige — uma lista vazia ou ausente é recusada', () => {
  for (const ruim of [{ cidades: '' }, { cidades: '   ' }, {}]) {
    const resultado = validateBriefInput({ nicho: 'X', nivelGeografico: 'CIDADE', quantidade: 1, ...ruim });
    assert.equal(resultado.ok, false);
    assert.ok(resultado.errors.some((e) => e.path === 'cidades'));
  }
});

test('[BRIEF-6] quantidade: inteiro entre 1 e 300 — 0, negativo, fracionário, texto, acima de 300 e ausente são recusados', () => {
  for (const ruim of [0, -1, 1.5, '50', 301, undefined]) {
    const input = valido();
    if (ruim === undefined) delete input.quantidade;
    else input.quantidade = ruim;
    const resultado = validateBriefInput(input);
    assert.equal(resultado.ok, false, String(ruim));
    assert.ok(resultado.errors.some((e) => e.path === 'quantidade'), String(ruim));
  }
  assert.equal(validateBriefInput(valido({ quantidade: 1 })).ok, true);
  assert.equal(validateBriefInput(valido({ quantidade: 300 })).ok, true);
});

test('[BRIEF-7] campos desconhecidos são recusados; nunca aceita id/status/autor/data vindos do cliente', () => {
  for (const chave of ['id', 'status', 'criadoPor', 'criadoEm', 'loteRealId', 'userId', 'role']) {
    const resultado = validateBriefInput({ ...valido(), [chave]: 'forjado' });
    assert.equal(resultado.ok, false, chave);
    assert.ok(resultado.errors.some((e) => e.path === chave && e.code === 'CAMPO_DESCONHECIDO'), chave);
  }
});

test('[BRIEF-8] textos têm limite (nicho, subnicho, observações) e um valor não-texto é recusado', () => {
  assert.equal(validateBriefInput(valido({ nicho: 'x'.repeat(LIMITS.NICHO + 1) })).ok, false);
  assert.equal(validateBriefInput(valido({ subnicho: 'x'.repeat(LIMITS.SUBNICHO + 1) })).ok, false);
  assert.equal(validateBriefInput(valido({ observacoes: 'x'.repeat(LIMITS.OBSERVACOES + 1) })).ok, false);
  assert.equal(validateBriefInput(valido({ nicho: 42 })).ok, false);
});

test('[BRIEF-9] splitList: separa por vírgula, apara espaços, remove vazios e duplicatas (case-insensitive), preserva a ordem', () => {
  assert.deepEqual(splitList('Petrópolis, Teresópolis,  , petrópolis ,Nova Friburgo'), ['Petrópolis', 'Teresópolis', 'Nova Friburgo']);
  assert.equal(splitList(42), null);
});

test('[BRIEF-10] no máximo 20 cidades/estados — acima disso é recusado (nunca truncado em silêncio)', () => {
  const muitas = Array.from({ length: 21 }, (_, i) => `Cidade${i}`).join(', ');
  const resultado = validateBriefInput({ nicho: 'X', nivelGeografico: 'CIDADE', cidades: muitas, quantidade: 1 });
  assert.equal(resultado.ok, false);
  assert.ok(resultado.errors.some((e) => e.path === 'cidades' && e.code === 'TAMANHO_EXCESSIVO'));
});

test('[BRIEF-11] summarizeGeografia: um resumo textual fiel para cada nível — nunca inventa uma cidade/estado/país que não foi informado', () => {
  assert.equal(summarizeGeografia({ nivelGeografico: GEO_LEVEL.CIDADE, cidades: ['Petrópolis', 'Teresópolis'] }), 'Cidade: Petrópolis, Teresópolis');
  assert.equal(summarizeGeografia({ nivelGeografico: GEO_LEVEL.ESTADO, estados: ['RJ'] }), 'Estado: RJ');
  assert.equal(summarizeGeografia({ nivelGeografico: GEO_LEVEL.NACIONAL, pais: 'Brasil' }), 'Nacional: Brasil');
});

test('[BRIEF-12] buildBriefId: formato PROS-YYYYMMDD-NNN, com a sequência do dia com 3 dígitos', () => {
  const id1 = buildBriefId(new Date('2026-09-29T12:00:00.000Z'), 1);
  const id2 = buildBriefId(new Date('2026-09-29T12:00:00.000Z'), 12);
  assert.equal(id1, 'PROS-20260929-001');
  assert.equal(id2, 'PROS-20260929-012');
  assert.match(id1, BRIEF_ID_PATTERN);
  assert.match(id2, BRIEF_ID_PATTERN);
  assert.doesNotMatch('lote:00000000-0000-4000-8000-000000000000', BRIEF_ID_PATTERN);
});
