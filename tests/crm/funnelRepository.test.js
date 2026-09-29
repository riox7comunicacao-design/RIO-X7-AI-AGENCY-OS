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

  test(`[FUNNEL-REPO-${nome}-7] countCardsByFunnel/countCardsByStage começam em 0`, () => {
    const repo = factory();
    assert.equal(repo.countCardsByFunnel('funnel:a'), 0);
    assert.equal(repo.countCardsByStage('stage:a'), 0);
  });

  test(`[FUNNEL-REPO-${nome}-8] assertValidFunnelRepository aceita o adapter`, () => {
    const repo = factory();
    assert.equal(assertValidFunnelRepository(repo), repo);
  });

  // ---- card (Etapa "Funis 2") ---------------------------------------------------------------------------------
  test(`[FUNNEL-REPO-${nome}-CARD-1] saveCard grava; getCard/listCardsByFunnel/getCardByFunnelAndRecord encontram; count reflete o card ATIVO`, () => {
    const repo = factory();
    repo.saveCard({ id: 'card:a', funnelId: 'funnel:a', stageId: 'stage:a', crmRecordId: 'crm:a', removedAt: null });
    assert.equal(repo.getCard('card:a').crmRecordId, 'crm:a');
    assert.deepEqual(repo.listCardsByFunnel('funnel:a').map((c) => c.id), ['card:a']);
    assert.equal(repo.getCardByFunnelAndRecord('funnel:a', 'crm:a').id, 'card:a');
    assert.equal(repo.getCardByFunnelAndRecord('funnel:a', 'crm:outro'), null);
    assert.equal(repo.countCardsByFunnel('funnel:a'), 1);
    assert.equal(repo.countCardsByStage('stage:a'), 1);
  });

  test(`[FUNNEL-REPO-${nome}-CARD-2] archiveCard marca removedAt — nunca apaga a linha: getCard continua achando, mas listCardsByFunnel/getCardByFunnelAndRecord/count deixam de contar`, () => {
    const repo = factory();
    repo.saveCard({ id: 'card:a', funnelId: 'funnel:a', stageId: 'stage:a', crmRecordId: 'crm:a', removedAt: null });
    repo.archiveCard('card:a');
    const arquivado = repo.getCard('card:a');
    assert.notEqual(arquivado, null, 'a linha continua existindo');
    assert.notEqual(arquivado.removedAt, null);
    assert.deepEqual(repo.listCardsByFunnel('funnel:a'), []);
    assert.equal(repo.getCardByFunnelAndRecord('funnel:a', 'crm:a'), null);
    assert.equal(repo.countCardsByFunnel('funnel:a'), 0);
    assert.equal(repo.countCardsByStage('stage:a'), 0);
    assert.doesNotThrow(() => repo.archiveCard('card:a'), 'arquivar de novo não lança');
    assert.doesNotThrow(() => repo.archiveCard('card:nao-existe'), 'arquivar um id inexistente não lança');
  });

  test(`[FUNNEL-REPO-${nome}-CARD-3] saveCard exige um card com id; id perigoso é recusado`, () => {
    const repo = factory();
    assert.throws(() => repo.saveCard({}), /id/);
    assert.throws(() => repo.saveCard({ id: '__proto__' }), /não permitido/);
  });

  test(`[FUNNEL-REPO-${nome}-CARD-4] listCardMoves/saveCardMove: histórico append-only, filtrado por cardId, na ordem em que foi gravado`, () => {
    const repo = factory();
    repo.saveCardMove({ cardId: 'card:a', stageFrom: null, stageTo: 'stage:1', movedAt: '2026-01-01T00:00:00.000Z' });
    repo.saveCardMove({ cardId: 'card:a', stageFrom: 'stage:1', stageTo: 'stage:2', movedAt: '2026-01-02T00:00:00.000Z' });
    repo.saveCardMove({ cardId: 'card:b', stageFrom: null, stageTo: 'stage:1', movedAt: '2026-01-01T00:00:00.000Z' });
    const historicoA = repo.listCardMoves('card:a');
    assert.equal(historicoA.length, 2);
    assert.deepEqual(historicoA.map((m) => m.stageTo), ['stage:1', 'stage:2']);
    assert.equal(repo.listCardMoves('card:b').length, 1);
    assert.deepEqual(repo.listCardMoves('card:nao-existe'), []);
  });

  test(`[FUNNEL-REPO-${nome}-CARD-5] getCard/listCardMoves devolvem CÓPIAS — alterar o retorno nunca muda o guardado`, () => {
    const repo = factory();
    repo.saveCard({ id: 'card:a', funnelId: 'funnel:a', stageId: 'stage:a', crmRecordId: 'crm:a', removedAt: null });
    const lido = repo.getCard('card:a');
    lido.stageId = 'adulterado';
    assert.equal(repo.getCard('card:a').stageId, 'stage:a');
    repo.saveCardMove({ cardId: 'card:a', stageFrom: null, stageTo: 'stage:a' });
    const [move] = repo.listCardMoves('card:a');
    move.stageTo = 'adulterado';
    assert.equal(repo.listCardMoves('card:a')[0].stageTo, 'stage:a');
  });

  // Etapa "Funis 2 — correção final de integridade CRM ↔ Card": a consulta que o CRM Service usa (por injeção) para
  // recusar excluir um registro do CRM com Cards ativos — em QUALQUER funil, e ignorando Cards arquivados.
  test(`[FUNNEL-REPO-${nome}-CARD-6] countActiveCardsByCrmRecord: 0 sem cards; conta cards ATIVOS de um registro em VÁRIOS funis; ignora cards ARQUIVADOS; nunca conta o card de OUTRO registro`, () => {
    const repo = factory();
    assert.equal(repo.countActiveCardsByCrmRecord('crm:a'), 0, 'sem nenhum card, a contagem é 0');

    repo.saveCard({ id: 'card:1', funnelId: 'funnel:outbound', stageId: 'stage:a', crmRecordId: 'crm:a', removedAt: null });
    assert.equal(repo.countActiveCardsByCrmRecord('crm:a'), 1);

    // O MESMO registro do CRM, num SEGUNDO funil (seção 3 da Etapa "Funis 2": permitido) — a contagem soma os dois.
    repo.saveCard({ id: 'card:2', funnelId: 'funnel:renovacao', stageId: 'stage:x', crmRecordId: 'crm:a', removedAt: null });
    assert.equal(repo.countActiveCardsByCrmRecord('crm:a'), 2);

    // Um card de OUTRO registro nunca entra na conta.
    repo.saveCard({ id: 'card:3', funnelId: 'funnel:outbound', stageId: 'stage:a', crmRecordId: 'crm:outro', removedAt: null });
    assert.equal(repo.countActiveCardsByCrmRecord('crm:a'), 2);
    assert.equal(repo.countActiveCardsByCrmRecord('crm:outro'), 1);

    // Arquivar um dos dois cards de crm:a reduz a contagem para 1 — nunca para 0: o outro continua ativo.
    repo.archiveCard('card:1');
    assert.equal(repo.countActiveCardsByCrmRecord('crm:a'), 1);

    // Arquivar o último também: a contagem cai para 0 — mesmo com a linha do card ainda existindo (getCard a acha).
    repo.archiveCard('card:2');
    assert.equal(repo.countActiveCardsByCrmRecord('crm:a'), 0);
    assert.notEqual(repo.getCard('card:2'), null, 'sanidade: archiveCard nunca apaga a linha');
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
