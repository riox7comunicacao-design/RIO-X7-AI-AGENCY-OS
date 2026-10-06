// permanentExclusion.js (Workbench de Prospecção, Etapa 2 — Exclusões Permanentes): normalização, validação do
// formulário administrativo e o critério de correspondência (nome + geografia, ou domínio).

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCompanyName, validateExclusionInput, matchesExclusion, DEFAULT_PAIS } = require('../../src/research-prospector/permanentExclusion');

const exclusaoBase = (extra = {}) => ({ id: 'ex-1', empresa: 'Força Digital', empresaNomeNormalizado: normalizeCompanyName('Força Digital'), cidade: 'Petrópolis', estado: 'RJ', ativo: true, ...extra });

// ---------------------------------------------------------------------------------------------------------------------------------
// Normalização (seção 3 do comando)
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-NORM-1] "FORÇA DIGITAL", "força digital" e "Força Digital" normalizam para a MESMA chave (exemplo obrigatório do comando)', () => {
  const a = normalizeCompanyName('FORÇA DIGITAL');
  const b = normalizeCompanyName('força digital');
  const c = normalizeCompanyName('Força Digital');
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a, 'forca digital');
});

test('[EXCL-NORM-2] espaços extras, pontuação e caracteres equivalentes são tratados; nunca fuzzy: duas empresas DIFERENTES nunca colapsam na mesma chave', () => {
  assert.equal(normalizeCompanyName('  Força   Digital  '), 'forca digital');
  assert.equal(normalizeCompanyName('Força-Digital Ltda.'), 'forca digital ltda');
  assert.notEqual(normalizeCompanyName('Força Digital'), normalizeCompanyName('Força Digital Marketing'));
  assert.notEqual(normalizeCompanyName('Clínica Alfa'), normalizeCompanyName('Clínica Beta'));
});

test('[EXCL-NORM-3] entrada inválida (não-texto, vazia) nunca lança — devolve null', () => {
  assert.equal(normalizeCompanyName(''), null);
  assert.equal(normalizeCompanyName('   '), null);
  assert.equal(normalizeCompanyName(42), null);
  assert.equal(normalizeCompanyName(null), null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Validação do formulário
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-VAL-1] criação: empresa e motivo são obrigatórios; país tem "Brasil" como padrão quando ausente', () => {
  const resultado = validateExclusionInput({ empresa: 'Força Digital', motivo: 'Exclusão permanente de prospecção' });
  assert.equal(resultado.ok, true);
  assert.equal(resultado.value.empresa, 'Força Digital');
  assert.equal(resultado.value.pais, DEFAULT_PAIS);
  assert.equal(resultado.value.empresaNomeNormalizado, 'forca digital');
});

test('[EXCL-VAL-2] sem empresa ou sem motivo, a criação é recusada (os dois, juntos, se faltarem)', () => {
  const semEmpresa = validateExclusionInput({ motivo: 'x' });
  assert.equal(semEmpresa.ok, false);
  assert.ok(semEmpresa.errors.some((e) => e.path === 'empresa'));
  const semMotivo = validateExclusionInput({ empresa: 'x' });
  assert.equal(semMotivo.ok, false);
  assert.ok(semMotivo.errors.some((e) => e.path === 'motivo'));
});

test('[EXCL-VAL-3] campos desconhecidos são recusados — nunca aceita id/ativo/criadoPor/criadoEm do cliente', () => {
  for (const chave of ['id', 'ativo', 'criadoPorUserId', 'criadoEm', 'empresaNomeNormalizado']) {
    const resultado = validateExclusionInput({ empresa: 'x', motivo: 'x', [chave]: 'forjado' });
    assert.equal(resultado.ok, false, chave);
    assert.ok(resultado.errors.some((e) => e.path === chave && e.code === 'CAMPO_DESCONHECIDO'), chave);
  }
});

test('[EXCL-VAL-4] edição (partial): nenhum campo é obrigatório em si — só o que vier é validado', () => {
  assert.deepEqual(validateExclusionInput({}, { partial: true }), { ok: true, value: {} });
  const resultado = validateExclusionInput({ cidade: 'Teresópolis' }, { partial: true });
  assert.equal(resultado.ok, true);
  assert.equal(resultado.value.cidade, 'Teresópolis');
  assert.equal(resultado.value.empresa, undefined);
});

test('[EXCL-VAL-5] cidade/estado/pais/dominio vazios viram null explícito (nunca omitidos, nunca "string vazia")', () => {
  const resultado = validateExclusionInput({ empresa: 'x', motivo: 'x', cidade: '', dominio: '   ' });
  assert.equal(resultado.ok, true);
  assert.equal(resultado.value.cidade, null);
  assert.equal(resultado.value.dominio, null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Critério de exclusão (seção 4)
// ---------------------------------------------------------------------------------------------------------------------------------
test('[EXCL-MATCH-1] empresa excluída, com a MESMA geografia, é detectada — mesmo com caixa/acento diferentes no finding', () => {
  const exclusao = exclusaoBase();
  assert.equal(matchesExclusion({ empresa: 'FORÇA DIGITAL', cidade: 'petrópolis', estado: 'rj' }, exclusao), true);
});

test('[EXCL-MATCH-2] empresa DIFERENTE, mesmo em nomes parecidos, NUNCA é bloqueada', () => {
  const exclusao = exclusaoBase();
  assert.equal(matchesExclusion({ empresa: 'Força Digital Marketing', cidade: 'Petrópolis', estado: 'RJ' }, exclusao), false);
  assert.equal(matchesExclusion({ empresa: 'Outra Empresa', cidade: 'Petrópolis', estado: 'RJ' }, exclusao), false);
});

test('[EXCL-MATCH-3] domínio cadastrado detecta a exclusão mesmo com nome diferente (critério independente do nome)', () => {
  const exclusao = exclusaoBase({ empresa: 'Nome Antigo Ltda', empresaNomeNormalizado: normalizeCompanyName('Nome Antigo Ltda'), cidade: null, estado: null, dominio: 'forcadigital.com.br' });
  assert.equal(matchesExclusion({ empresa: 'Força Digital (novo nome)', site: 'https://www.forcadigital.com.br/contato' }, exclusao), true);
});

test('[EXCL-MATCH-4] exclusão INATIVA nunca bloqueia', () => {
  const exclusao = exclusaoBase({ ativo: false });
  assert.equal(matchesExclusion({ empresa: 'Força Digital', cidade: 'Petrópolis', estado: 'RJ' }, exclusao), false);
});

test('[EXCL-MATCH-5] AMBIGUIDADE: exclusão com geografia especificada, finding SEM geografia conhecida -> NÃO bloqueia automaticamente', () => {
  const exclusao = exclusaoBase(); // cidade/estado preenchidos
  assert.equal(matchesExclusion({ empresa: 'Força Digital' }, exclusao), false, 'sem cidade/estado no finding, é ambíguo');
});

test('[EXCL-MATCH-6] nome bate, mas a geografia do finding é DIFERENTE da exclusão -> não bloqueia (empresas de mesmo nome em cidades diferentes são entidades distintas)', () => {
  const exclusao = exclusaoBase();
  assert.equal(matchesExclusion({ empresa: 'Força Digital', cidade: 'Curitiba', estado: 'PR' }, exclusao), false);
});

test('[EXCL-MATCH-7] exclusão SEM geografia especificada bloqueia pelo nome em qualquer lugar (exclusão global por nome)', () => {
  const exclusao = exclusaoBase({ cidade: null, estado: null });
  assert.equal(matchesExclusion({ empresa: 'Força Digital', cidade: 'Manaus', estado: 'AM' }, exclusao), true);
  assert.equal(matchesExclusion({ empresa: 'Força Digital' }, exclusao), true, 'sem geografia em nenhum dos dois, o nome já basta');
});

test('[EXCL-MATCH-8] múltiplas exclusões: cada uma é avaliada independentemente — nenhuma decide pela outra', () => {
  const exclusaoA = exclusaoBase({ id: 'a', empresa: 'Força Digital', empresaNomeNormalizado: normalizeCompanyName('Força Digital') });
  const exclusaoB = exclusaoBase({ id: 'b', empresa: 'Outra Marca', empresaNomeNormalizado: normalizeCompanyName('Outra Marca'), cidade: null, estado: null });
  const finding = { empresa: 'Força Digital', cidade: 'Petrópolis', estado: 'RJ' };
  assert.equal(matchesExclusion(finding, exclusaoA), true);
  assert.equal(matchesExclusion(finding, exclusaoB), false);
});

test('[EXCL-MATCH-9] entradas inválidas (não-objeto) nunca lançam — devolvem false', () => {
  assert.equal(matchesExclusion(null, exclusaoBase()), false);
  assert.equal(matchesExclusion({ empresa: 'x' }, null), false);
  assert.equal(matchesExclusion(undefined, undefined), false);
});
