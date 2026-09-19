const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, normalizeNameCity } = require('../../src/research-prospector/normalize');

test('telefone: com e sem código de país +55 são reconhecidos como o mesmo número', () => {
  assert.equal(normalizePhone('+55 24 98765-4321'), normalizePhone('(24) 98765-4321'));
  assert.equal(normalizePhone('+55 24 98765-4321'), normalizePhone('24987654321'));
  assert.equal(normalizePhone('5524987654321'), normalizePhone('24987654321'));
});

test('telefone: DDDs diferentes nunca são tratados como equivalentes', () => {
  assert.notEqual(normalizePhone('+55 24 98765-4321'), normalizePhone('+55 21 98765-4321'));
});

test('telefone: não remove dígitos fora da regra objetiva de +55 (comprimento 12/13)', () => {
  // DDD 55 (Rio Grande do Sul) não pode ser confundido com o código de país.
  assert.equal(normalizePhone('55988887777'), '55988887777');
  assert.equal(normalizePhone('+55 55 98888-7777'), '55988887777');
});

test('nome+cidade: qualificador profissional no final não impede o match ("Helena Duarte" vs "Helena Duarte Psicóloga")', () => {
  assert.equal(
    normalizeNameCity('Helena Duarte', 'Petrópolis'),
    normalizeNameCity('Helena Duarte Psicóloga', 'Petrópolis')
  );
});

test('nome+cidade: título no início não impede o match ("Dra. Helena Duarte" vs "Helena Duarte")', () => {
  assert.equal(
    normalizeNameCity('Dra. Helena Duarte', 'Petrópolis'),
    normalizeNameCity('Helena Duarte', 'Petrópolis')
  );
});

test('nome+cidade: nomes claramente diferentes nunca são unificados', () => {
  assert.notEqual(
    normalizeNameCity('Helena Duarte', 'Petrópolis'),
    normalizeNameCity('Mariana Duarte', 'Petrópolis')
  );
});

test('nome+cidade: sobrenome real diferente não é removido (nunca assume ser a mesma pessoa)', () => {
  assert.notEqual(
    normalizeNameCity('Helena Duarte Silva', 'Petrópolis'),
    normalizeNameCity('Helena Duarte', 'Petrópolis')
  );
});
