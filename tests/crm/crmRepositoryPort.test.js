// Testes da PORTA de persistência do CRM (src/crm/crmRepositoryPort.js): só o contrato, nunca uma implementação.
// O contrato completo dos adapters (memória e arquivo) está em crmRepository.test.js; aqui fica o que é próprio da
// porta — quem a valida (o CRM Service), a exigência de ser síncrona nesta versão, e a ausência de qualquer adapter.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REQUIRED_REPOSITORY_METHODS, assertValidRepository } = require('../../src/crm/crmRepositoryPort');
const crmRepository = require('../../src/crm/crmRepository');
const { analyzeSource } = require('../helpers/staticImports');

const PORT_FILE = path.join(__dirname, '..', '..', 'src', 'crm', 'crmRepositoryPort.js');

test('[CRM-PORT-1] o contrato tem exatamente os três métodos { list, getById, save }, congelados, e crmRepository.js reexporta a MESMA definição', () => {
  assert.deepEqual([...REQUIRED_REPOSITORY_METHODS], ['list', 'getById', 'save']);
  assert.ok(Object.isFrozen(REQUIRED_REPOSITORY_METHODS));
  assert.equal(crmRepository.assertValidRepository, assertValidRepository, 'uma só definição, reexportada — nunca duas cópias que possam divergir');
  assert.equal(crmRepository.REQUIRED_REPOSITORY_METHODS, REQUIRED_REPOSITORY_METHODS);
});

test('[CRM-PORT-2] um repositório com os três métodos síncronos é aceito e devolvido como está (a mesma referência)', () => {
  const repositorio = { list: () => [], getById: () => null, save: () => {} };
  assert.equal(assertValidRepository(repositorio), repositorio);
});

test('[CRM-PORT-3] a porta é SÍNCRONA nesta versão: um método declarado async é recusado na composição, com uma mensagem que nomeia o método — nunca no meio de uma operação, com um erro opaco', () => {
  for (const metodo of REQUIRED_REPOSITORY_METHODS) {
    const repositorio = { list: () => [], getById: () => null, save: () => {} };
    repositorio[metodo] = async () => (metodo === 'list' ? [] : null);
    assert.throws(() => assertValidRepository(repositorio), new RegExp(`${metodo}\\(\\) é assíncrono`));
  }
});

test('[CRM-PORT-4] métodos ausentes ou não-funções são recusados nomeando o método; entradas que nem são um objeto também', () => {
  for (const metodo of REQUIRED_REPOSITORY_METHODS) {
    const incompleto = { list: () => [], getById: () => null, save: () => {} };
    incompleto[metodo] = 'não é uma função';
    assert.throws(() => assertValidRepository(incompleto), new RegExp(`falta o método ${metodo}`));
    delete incompleto[metodo];
    assert.throws(() => assertValidRepository(incompleto), new RegExp(`falta o método ${metodo}`));
  }
  for (const invalido of [null, undefined, 42, 'x', () => {}]) {
    assert.throws(() => assertValidRepository(invalido), /repositório inválido/);
  }
});

test('[CRM-PORT-5] o arquivo da porta não importa NADA — nem fs, nem adapter, nem outro módulo de src/: quem só precisa do contrato nunca herda um adapter', () => {
  const analise = analyzeSource(fs.readFileSync(PORT_FILE, 'utf8'), 'src/crm/crmRepositoryPort.js');
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(
    analise.refs.map((ref) => ref.specifier),
    [],
    'crmRepositoryPort.js é contrato puro: nenhuma dependência'
  );
});
