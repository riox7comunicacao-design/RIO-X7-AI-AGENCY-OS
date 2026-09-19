const test = require('node:test');
const assert = require('node:assert/strict');
const { runPipeline } = require('../../src/research-prospector/pipeline');
const { DUPLICATE_STATUS } = require('../../src/research-prospector/constants');

test('pipeline completo: candidato novo válido produz saída estruturada, sem tocar sistema externo', () => {
  const output = runPipeline({
    empresa: 'Consultório Integração',
    telefone: '24977776666',
    cidade: 'Petrópolis',
    site: 'https://consultoriointegracao.com.br',
  }, []);

  assert.equal(output.empresa, 'Consultório Integração');
  assert.equal(output.duplicidade.status, DUPLICATE_STATUS.NOVO);
  assert.equal(output.doNotContact, false);
  assert.equal(output.bloqueadoParaContato, false);
  // Saída precisa ser serializável em JSON (seção 8 de 0003).
  assert.doesNotThrow(() => JSON.stringify(output));
});

test('pipeline completo: candidato DO NOT CONTACT sai bloqueado para contato', () => {
  const existing = [{ empresa: 'Consultório Bloqueado', telefone: '24955550000', doNotContact: true }];

  const output = runPipeline({
    empresa: 'Consultório Bloqueado',
    telefone: '24955550000',
  }, existing);

  assert.equal(output.doNotContact, true);
  assert.equal(output.bloqueadoParaContato, true);
});

test('pipeline completo: candidato possível duplicado é sinalizado, não descartado nem promovido a duplicado', () => {
  const existing = [{ empresa: 'Consultório Ana', cidade: 'Petrópolis', telefone: '24911119999' }];

  const output = runPipeline({ empresa: 'Consultório Ana', cidade: 'Petrópolis' }, existing);

  assert.equal(output.duplicidade.status, DUPLICATE_STATUS.POSSIVEL_DUPLICADO);
});

test('pipeline nunca cria/edita nada fora do objeto retornado (sem efeitos colaterais nos registros existentes)', () => {
  const existing = [{ empresa: 'Consultório Original', telefone: '24900001234' }];
  const existingSnapshot = JSON.parse(JSON.stringify(existing));

  runPipeline({ empresa: 'Consultório Original', telefone: '24900001234' }, existing);

  assert.deepEqual(existing, existingSnapshot);
});

test('empresa ausente: pipeline recusa e não inventa nome', () => {
  assert.throws(() => runPipeline({ telefone: '24900000000' }, []), /empresa é obrigatória/);
});
