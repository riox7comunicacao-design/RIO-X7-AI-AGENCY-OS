// Adapter de MEMÓRIA das Exclusões Permanentes de Prospecção (Workbench, Etapa 2) —
// src/research-prospector/permanentExclusionRepository.js. Mesmo espírito de batchRepository.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryPermanentExclusionRepository, assertValidPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');

const exclusao = (overrides = {}) => ({ id: 'ex-1', empresa: 'Força Digital', empresaNomeNormalizado: 'forca digital', cidade: 'Petrópolis', estado: 'RJ', pais: 'Brasil', dominio: null, motivo: 'Exclusão permanente', ativo: true, ...overrides });

test('[EXCL-REPO-1] list() começa vazio; getById() de um id inexistente devolve null', () => {
  const repo = createInMemoryPermanentExclusionRepository();
  assert.deepEqual(repo.list(), []);
  assert.equal(repo.getById('nao-existe'), null);
});

test('[EXCL-REPO-2] insert() grava; getById()/list() encontram depois', () => {
  const repo = createInMemoryPermanentExclusionRepository();
  const gravado = repo.insert(exclusao());
  assert.equal(gravado.id, 'ex-1');
  assert.equal(repo.getById('ex-1').empresa, 'Força Digital');
  assert.equal(repo.list().length, 1);
});

test('[EXCL-REPO-3] insert() exige um registro com id; id perigoso (__proto__/constructor/prototype) é recusado', () => {
  const repo = createInMemoryPermanentExclusionRepository();
  assert.throws(() => repo.insert({}), /id/);
  assert.throws(() => repo.insert(exclusao({ id: '__proto__' })), /não permitido/);
  assert.equal(Object.getPrototypeOf({}), Object.prototype, 'sanidade: o protótipo global não foi alterado');
});

test('[EXCL-REPO-4] update() faz merge raso e devolve o registro atualizado; um id inexistente devolve null (nunca lança)', () => {
  const repo = createInMemoryPermanentExclusionRepository();
  repo.insert(exclusao());
  const atualizado = repo.update('ex-1', { cidade: 'Teresópolis' });
  assert.equal(atualizado.cidade, 'Teresópolis');
  assert.equal(atualizado.empresa, 'Força Digital', 'o resto do registro é preservado');
  assert.equal(repo.update('nao-existe', { cidade: 'x' }), null);
});

test('[EXCL-REPO-5] update({ ativo: false }) desativa — a linha continua existindo (nunca some de list()/getById())', () => {
  const repo = createInMemoryPermanentExclusionRepository();
  repo.insert(exclusao());
  const desativado = repo.update('ex-1', { ativo: false });
  assert.equal(desativado.ativo, false);
  assert.notEqual(repo.getById('ex-1'), null, 'a linha continua existindo — nunca DELETE físico');
  assert.equal(repo.list().length, 1);
});

test('[EXCL-REPO-6] list()/getById() devolvem CÓPIAS — alterar o retorno nunca muda o que está guardado', () => {
  const repo = createInMemoryPermanentExclusionRepository();
  repo.insert(exclusao());
  const lido = repo.getById('ex-1');
  lido.empresa = 'Adulterado';
  assert.equal(repo.getById('ex-1').empresa, 'Força Digital');
});

test('[EXCL-REPO-7] assertValidPermanentExclusionRepository aceita o adapter e recusa um objeto incompleto', () => {
  const repo = createInMemoryPermanentExclusionRepository();
  assert.equal(assertValidPermanentExclusionRepository(repo), repo);
  assert.throws(() => assertValidPermanentExclusionRepository({}), /falta o método/);
  assert.throws(() => assertValidPermanentExclusionRepository(null), /repositório inválido/);
});

test('[EXCL-REPO-8] múltiplas exclusões coexistem independentemente', () => {
  const repo = createInMemoryPermanentExclusionRepository();
  repo.insert(exclusao({ id: 'ex-1', empresa: 'Força Digital' }));
  repo.insert(exclusao({ id: 'ex-2', empresa: 'Outra Marca', empresaNomeNormalizado: 'outra marca' }));
  assert.equal(repo.list().length, 2);
  repo.update('ex-1', { ativo: false });
  assert.equal(repo.getById('ex-1').ativo, false);
  assert.equal(repo.getById('ex-2').ativo, true, 'desativar uma nunca afeta a outra');
});
