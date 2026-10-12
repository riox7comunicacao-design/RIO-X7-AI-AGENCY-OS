// A PORTA de persistência dos catálogos do CRM (src/crm/catalogRepositoryPort.js): o contrato, os códigos de erro comuns entre adapters e a
// validação de um repositório injetado.

const test = require('node:test');
const assert = require('node:assert/strict');

const port = require('../../src/crm/catalogRepositoryPort');
const { CATALOG_REPOSITORY_ERROR, REQUIRED_CATALOG_REPOSITORY_METHODS, COMMON_UPDATABLE_FIELDS, UPDATABLE_FIELDS, assertValidCatalogRepository, repositoryError } = port;
const { CATALOG_DEFINITIONS } = require('../../src/crm/catalogConstants');

test('[CATPORT-1] o contrato tem 5 métodos — list, getById, insert, update, reorder — e NENHUM de exclusão; os códigos de erro comuns são só dois, congelados', () => {
  assert.deepEqual([...REQUIRED_CATALOG_REPOSITORY_METHODS], ['list', 'getById', 'insert', 'update', 'reorder']);
  assert.deepEqual({ ...CATALOG_REPOSITORY_ERROR }, { DUPLICATE_NAME: 'CRM_CATALOG_REPOSITORY_DUPLICATE_NAME', NOT_FOUND: 'CRM_CATALOG_REPOSITORY_NOT_FOUND' });
  for (const objeto of [CATALOG_REPOSITORY_ERROR, REQUIRED_CATALOG_REPOSITORY_METHODS, COMMON_UPDATABLE_FIELDS, UPDATABLE_FIELDS]) assert.equal(Object.isFrozen(objeto), true);
  assert.equal(REQUIRED_CATALOG_REPOSITORY_METHODS.some((metodo) => /delete|remove|destroy|drop/i.test(metodo)), false, 'sem exclusão física (decisão D4)');
});

test('[CATPORT-2] os campos atualizáveis: os comuns nunca incluem id, criadoEm nem criadoPor*; a união cobre exatamente os campos específicos dos três catálogos', () => {
  assert.deepEqual([...COMMON_UPDATABLE_FIELDS], ['nome', 'nomeNormalizado', 'descricao', 'ativo', 'ordem', 'atualizadoEm', 'atualizadoPorUserId', 'atualizadoPorNome']);
  for (const imutavel of ['id', 'criadoEm', 'criadoPorUserId', 'criadoPorNome']) assert.equal(UPDATABLE_FIELDS.includes(imutavel), false, imutavel);
  const especificos = Object.values(CATALOG_DEFINITIONS).flatMap((definicao) => [...definicao.specificFields]);
  assert.deepEqual([...UPDATABLE_FIELDS].sort(), [...COMMON_UPDATABLE_FIELDS, ...especificos].sort());
});

test('[CATPORT-3] assertValidCatalogRepository aceita um repositório com os 5 métodos (síncrono ou assíncrono) e recusa o resto com mensagem clara', () => {
  const completo = { list() {}, getById() {}, insert() {}, update() {}, reorder() {} };
  assert.equal(assertValidCatalogRepository(completo), completo);
  assert.doesNotThrow(() => assertValidCatalogRepository({ list: async () => [], getById: async () => null, insert: async () => ({}), update: async () => null, reorder: async () => {} }));
  for (const ruim of [null, undefined, 'repo', 5, true]) assert.throws(() => assertValidCatalogRepository(ruim), /repositório inválido/);
  for (const metodo of REQUIRED_CATALOG_REPOSITORY_METHODS) {
    const parcial = { ...completo };
    delete parcial[metodo];
    assert.throws(() => assertValidCatalogRepository(parcial), new RegExp(`falta o método ${metodo}\\(\\)`));
    assert.throws(() => assertValidCatalogRepository({ ...completo, [metodo]: 'não é função' }), /falta o método/);
  }
});

test('[CATPORT-4] repositoryError cria um Error comum com o `code` estável do contrato (uma propriedade plana, nunca uma classe de outro módulo)', () => {
  const erro = repositoryError(CATALOG_REPOSITORY_ERROR.DUPLICATE_NAME, 'mensagem');
  assert.equal(erro instanceof Error, true);
  assert.equal(erro.constructor, Error);
  assert.equal(erro.code, 'CRM_CATALOG_REPOSITORY_DUPLICATE_NAME');
  assert.equal(erro.message, 'mensagem');
});
