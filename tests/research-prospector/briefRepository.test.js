// Adapters de brief (src/research-prospector/briefRepository.js) — Etapa "Prospecção 1". Mesma bateria contra os
// dois adapters (memória, arquivo JSON), mesmo espírito de batchRepository.test.js/funnelRepository.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createInMemoryBriefRepository, createJsonFileBriefRepository, assertValidBriefRepository } = require('../../src/research-prospector/briefRepository');

function eachRepository(nome, factory) {
  test(`[BRIEF-REPO-${nome}-1] list() começa vazio; getById() de um id inexistente devolve null`, () => {
    const repo = factory();
    assert.deepEqual(repo.list(), []);
    assert.equal(repo.getById('PROS-20260929-001'), null);
  });

  test(`[BRIEF-REPO-${nome}-2] save() grava; getById()/list() encontram depois; o MESMO id substitui (upsert, nunca recusa)`, () => {
    const repo = factory();
    repo.save({ id: 'PROS-20260929-001', status: 'RASCUNHO', nicho: 'A' });
    assert.equal(repo.getById('PROS-20260929-001').nicho, 'A');
    repo.save({ id: 'PROS-20260929-001', status: 'PRONTO_PARA_PESQUISA', nicho: 'A' });
    assert.equal(repo.list().length, 1);
    assert.equal(repo.getById('PROS-20260929-001').status, 'PRONTO_PARA_PESQUISA');
  });

  test(`[BRIEF-REPO-${nome}-3] save() exige um brief com id; id perigoso (__proto__/constructor/prototype) é recusado`, () => {
    const repo = factory();
    for (const ruim of [{}, { id: '' }, { id: 42 }]) assert.throws(() => repo.save(ruim), /id/);
    for (const id of ['__proto__', 'constructor', 'prototype']) assert.throws(() => repo.save({ id }), /não permitido/, id);
    assert.equal(Object.getPrototypeOf({}), Object.prototype, 'sanidade: o protótipo global não foi alterado');
  });

  test(`[BRIEF-REPO-${nome}-4] list()/getById() devolvem CÓPIAS — alterar o retorno nunca muda o que está guardado`, () => {
    const repo = factory();
    repo.save({ id: 'PROS-20260929-001', status: 'RASCUNHO', contagens: { encontrados: 1 } });
    const lido = repo.getById('PROS-20260929-001');
    lido.status = 'CANCELADO';
    lido.contagens.encontrados = 999;
    assert.equal(repo.getById('PROS-20260929-001').status, 'RASCUNHO');
    assert.equal(repo.getById('PROS-20260929-001').contagens.encontrados, 1);
  });

  test(`[BRIEF-REPO-${nome}-5] assertValidBriefRepository aceita o adapter`, () => {
    assert.equal(assertValidBriefRepository(factory()), undefined);
  });
}

eachRepository('MEM', () => createInMemoryBriefRepository());
eachRepository('JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-repo-json-'));
  return createJsonFileBriefRepository(path.join(dir, 'briefs.json'));
});

test('[BRIEF-REPO-JSON-6] arquivo AUSENTE vira lista vazia (nunca erro); arquivo CORROMPIDO sempre lança', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-repo-corrompido-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'briefs.json');
  const repo = createJsonFileBriefRepository(filePath);
  assert.deepEqual(repo.list(), []);
  fs.writeFileSync(filePath, '{ isto não é JSON');
  assert.throws(() => repo.list(), /corrompido/);
});

test('[BRIEF-REPO-JSON-7] persiste de fato em disco: uma SEGUNDA instância, sobre o MESMO arquivo, enxerga os dados', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-repo-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'briefs.json');
  createJsonFileBriefRepository(filePath).save({ id: 'PROS-20260929-001', status: 'RASCUNHO' });
  const segunda = createJsonFileBriefRepository(filePath);
  assert.equal(segunda.getById('PROS-20260929-001').status, 'RASCUNHO');
});

test('[BRIEF-REPO-JSON-8] createJsonFileBriefRepository exige um filePath (texto não vazio)', () => {
  assert.throws(() => createJsonFileBriefRepository(''), /filePath/);
});
