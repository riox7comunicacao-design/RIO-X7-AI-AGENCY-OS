// Testes dos adapters de Funis (src/crm/funnelRepository.js) — Etapa "Funis 1". Mesma bateria contra os dois
// adapters (memória, arquivo JSON), mesmo espírito de crmRepository.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createInMemoryFunnelRepository, createJsonFileFunnelRepository, assertValidFunnelRepository } = require('../../src/crm/funnelRepository');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'funnels.json');
}

function eachRepository(nome, factory) {
  test(`[FUNNEL-REPO-${nome}-1] listFunnels()/listStages() começam vazios; getFunnel()/getStage() de um id inexistente devolvem null`, () => {
    const repo = factory();
    assert.deepEqual(repo.listFunnels(), []);
    assert.deepEqual(repo.listStages('funnel:x'), []);
    assert.equal(repo.getFunnel('nao-existe'), null);
    assert.equal(repo.getStage('nao-existe'), null);
  });

  test(`[FUNNEL-REPO-${nome}-2] saveFunnel()/saveStage() gravam; getById()/list() encontram depois; MESMO id substitui (upsert)`, () => {
    const repo = factory();
    repo.saveFunnel({ id: 'funnel:a', nome: 'Outbound' });
    assert.equal(repo.getFunnel('funnel:a').nome, 'Outbound');
    repo.saveFunnel({ id: 'funnel:a', nome: 'Outbound Editado' });
    assert.equal(repo.listFunnels().length, 1);
    assert.equal(repo.getFunnel('funnel:a').nome, 'Outbound Editado');

    repo.saveStage({ id: 'stage:a', funnelId: 'funnel:a', nome: 'Etapa 1' });
    assert.equal(repo.getStage('stage:a').nome, 'Etapa 1');
    assert.deepEqual(repo.listStages('funnel:a').map((s) => s.id), ['stage:a']);
  });

  test(`[FUNNEL-REPO-${nome}-3] listStages(funnelId) só devolve as etapas DAQUELE funil`, () => {
    const repo = factory();
    repo.saveFunnel({ id: 'funnel:a', nome: 'A' });
    repo.saveFunnel({ id: 'funnel:b', nome: 'B' });
    repo.saveStage({ id: 'stage:a1', funnelId: 'funnel:a', nome: 'A1' });
    repo.saveStage({ id: 'stage:b1', funnelId: 'funnel:b', nome: 'B1' });
    assert.deepEqual(repo.listStages('funnel:a').map((s) => s.id), ['stage:a1']);
    assert.deepEqual(repo.listStages('funnel:b').map((s) => s.id), ['stage:b1']);
  });

  test(`[FUNNEL-REPO-${nome}-4] deleteFunnel()/deleteStage() removem; de um id inexistente não lançam`, () => {
    const repo = factory();
    repo.saveFunnel({ id: 'funnel:a', nome: 'A' });
    repo.saveStage({ id: 'stage:a', funnelId: 'funnel:a', nome: 'A1' });
    repo.deleteFunnel('funnel:a');
    repo.deleteStage('stage:a');
    assert.equal(repo.getFunnel('funnel:a'), null);
    assert.equal(repo.getStage('stage:a'), null);
    assert.doesNotThrow(() => repo.deleteFunnel('nao-existe'));
    assert.doesNotThrow(() => repo.deleteStage('nao-existe'));
  });

  test(`[FUNNEL-REPO-${nome}-5] saveFunnel()/saveStage() exigem um id (texto não vazio); ids perigosos (__proto__/constructor/prototype) são recusados`, () => {
    const repo = factory();
    for (const ruim of [{}, { id: '' }, { id: 42 }, { id: null }]) {
      assert.throws(() => repo.saveFunnel(ruim), /id/);
      assert.throws(() => repo.saveStage(ruim), /id/);
    }
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(() => repo.saveFunnel({ id, nome: 'x' }), /não permitido/, id);
      assert.throws(() => repo.saveStage({ id, funnelId: 'funnel:a', nome: 'x' }), /não permitido/, id);
    }
    assert.equal(Object.getPrototypeOf({}), Object.prototype, 'sanidade: o protótipo global não foi alterado');
  });

  test(`[FUNNEL-REPO-${nome}-6] list/get devolvem CÓPIAS — alterar o retorno nunca muda o que está guardado`, () => {
    const repo = factory();
    repo.saveFunnel({ id: 'funnel:a', nome: 'A', config: { x: 1 } });
    const lido = repo.getFunnel('funnel:a');
    lido.nome = 'Adulterado';
    lido.config.x = 999;
    assert.equal(repo.getFunnel('funnel:a').nome, 'A');
    assert.equal(repo.getFunnel('funnel:a').config.x, 1);
  });

  test(`[FUNNEL-REPO-${nome}-7] countCardsByFunnel/countCardsByStage sempre devolvem 0 nesta etapa (nenhum card ainda existe — Etapa "Funis 2")`, () => {
    const repo = factory();
    assert.equal(repo.countCardsByFunnel('funnel:a'), 0);
    assert.equal(repo.countCardsByStage('stage:a'), 0);
  });

  test(`[FUNNEL-REPO-${nome}-8] assertValidFunnelRepository aceita o adapter`, () => {
    const repo = factory();
    assert.equal(assertValidFunnelRepository(repo), repo);
  });
}

eachRepository('MEM', () => createInMemoryFunnelRepository());
eachRepository('JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-repo-json-'));
  return createJsonFileFunnelRepository(path.join(dir, 'funnels.json'));
});

test('[FUNNEL-REPO-JSON-9] arquivo AUSENTE vira listas vazias (nunca erro); arquivo CORROMPIDO sempre lança', (t) => {
  const file = tempFile(t);
  const repo = createJsonFileFunnelRepository(file);
  assert.deepEqual(repo.listFunnels(), []);

  fs.writeFileSync(file, '{ isto não é json [[[', 'utf8');
  assert.throws(() => repo.listFunnels(), /corrompido/);

  fs.writeFileSync(file, '{"funnels": {}}', 'utf8'); // sem "stages" -> estrutura inválida
  assert.throws(() => repo.listFunnels(), /corrompido/);
});

test('[FUNNEL-REPO-JSON-10] persiste de fato em disco: uma SEGUNDA instância, sobre o MESMO arquivo, enxerga os dados', (t) => {
  const file = tempFile(t);
  const repoA = createJsonFileFunnelRepository(file);
  repoA.saveFunnel({ id: 'funnel:a', nome: 'Persistente' });
  repoA.saveStage({ id: 'stage:a', funnelId: 'funnel:a', nome: 'Etapa' });

  const repoB = createJsonFileFunnelRepository(file);
  assert.equal(repoB.getFunnel('funnel:a').nome, 'Persistente');
  assert.equal(repoB.listStages('funnel:a').length, 1);
});

test('[FUNNEL-REPO-JSON-11] createJsonFileFunnelRepository exige um filePath (texto não vazio)', () => {
  for (const ruim of [undefined, null, '', '   ', 42, {}]) {
    assert.throws(() => createJsonFileFunnelRepository(ruim), /filePath/);
  }
});

test('[FUNNEL-REPO-JSON-12] uma escrita nunca deixa o arquivo num estado truncado: nenhum .tmp sobra depois de save()', (t) => {
  const file = tempFile(t);
  const repo = createJsonFileFunnelRepository(file);
  repo.saveFunnel({ id: 'funnel:a', nome: 'x' });
  const sobras = fs.readdirSync(path.dirname(file)).filter((nome) => nome.endsWith('.tmp'));
  assert.deepEqual(sobras, []);
});
