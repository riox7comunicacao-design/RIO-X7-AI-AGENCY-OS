const test = require('node:test');
const assert = require('node:assert/strict');
const { createCandidate } = require('../../src/research-prospector/candidate');
const { INFO_STATUS, VALIDATION_STATUS } = require('../../src/research-prospector/constants');

test('empresa válida: campos presentes ficam VALIDADO, nenhum dado é inventado', () => {
  const candidate = createCandidate({
    empresa: 'Consultório Exemplo',
    telefone: '24999999999',
    site: 'https://exemplo.com.br',
    cidade: 'Petrópolis',
  });

  assert.equal(candidate.empresa, 'Consultório Exemplo');
  assert.equal(candidate.confianca.empresa, INFO_STATUS.VALIDADO);
  assert.equal(candidate.confianca.telefone, INFO_STATUS.VALIDADO);
  assert.equal(candidate.confianca.site, INFO_STATUS.VALIDADO);
  // Campo nunca pesquisado continua null, nunca um valor inventado.
  assert.equal(candidate.email, null);
  assert.equal(candidate.statusValidacao, VALIDATION_STATUS.NAO_REVISADO);
});

test('telefone ausente: fica null e marcado como NAO_VERIFICADO, nunca inventado', () => {
  const candidate = createCandidate({ empresa: 'Consultório Sem Telefone' });

  assert.equal(candidate.telefone, null);
  assert.equal(candidate.confianca.telefone, INFO_STATUS.NAO_VERIFICADO);
});

test('e-mail ausente: fica null e marcado como NAO_VERIFICADO, nunca inventado', () => {
  const candidate = createCandidate({ empresa: 'Consultório Sem Email' });

  assert.equal(candidate.email, null);
  assert.equal(candidate.confianca.email, INFO_STATUS.NAO_VERIFICADO);
});

test('informação não verificada: override explícito de confiança é respeitado', () => {
  // Caso real: telefone foi encontrado, mas a fonte não é confiável o
  // suficiente para ser tratado como VALIDADO — a pesquisa pode marcar
  // HIPOTESE mesmo com o campo preenchido.
  const candidate = createCandidate({
    empresa: 'Consultório Incerto',
    telefone: '24988887777',
    confianca: { telefone: INFO_STATUS.HIPOTESE },
  });

  assert.equal(candidate.telefone, '24988887777');
  assert.equal(candidate.confianca.telefone, INFO_STATUS.HIPOTESE);
});

test('empresa sem site: pipeline de dados continua, site fica null', () => {
  const candidate = createCandidate({ empresa: 'Consultório Sem Site', cidade: 'Petrópolis' });

  assert.equal(candidate.site, null);
  assert.equal(candidate.confianca.site, INFO_STATUS.NAO_VERIFICADO);
});

test('empresa ausente: nunca inventa um nome, sempre lança erro', () => {
  assert.throws(() => createCandidate({}), /empresa é obrigatória/);
  assert.throws(() => createCandidate({ empresa: '   ' }), /empresa é obrigatória/);
});

test('status de confiança inválido é rejeitado, nunca aceito silenciosamente', () => {
  assert.throws(
    () => createCandidate({ empresa: 'X', confianca: { telefone: 'TALVEZ' } }),
    /status de confiança inválido/
  );
});
