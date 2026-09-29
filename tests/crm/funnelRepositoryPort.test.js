// Testes da PORTA de persistência de Funis (src/crm/funnelRepositoryPort.js) — Etapa "Funis 1" da reestruturação
// Prospecção/CRM/Funis. Só o contrato, nunca uma implementação — mesmo espírito de crmRepositoryPort.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { REQUIRED_FUNNEL_REPOSITORY_METHODS, assertValidFunnelRepository } = require('../../src/crm/funnelRepositoryPort');
const funnelRepository = require('../../src/crm/funnelRepository');

function completo() {
  return {
    listFunnels: () => [],
    getFunnel: () => null,
    saveFunnel: () => {},
    deleteFunnel: () => {},
    listStages: () => [],
    getStage: () => null,
    saveStage: () => {},
    deleteStage: () => {},
    countCardsByFunnel: () => 0,
    countCardsByStage: () => 0,
    listCardsByFunnel: () => [],
    getCardByFunnelAndRecord: () => null,
    getCard: () => null,
    saveCard: () => {},
    archiveCard: () => {},
    listCardMoves: () => [],
    saveCardMove: () => {},
  };
}

test('[FUNNEL-PORT-1] o contrato tem exatamente os 17 métodos documentados (Etapa "Funis 2" acrescentou os 7 de card), congelado, e funnelRepository.js reexporta a MESMA definição', () => {
  assert.deepEqual([...REQUIRED_FUNNEL_REPOSITORY_METHODS], [
    'listFunnels', 'getFunnel', 'saveFunnel', 'deleteFunnel',
    'listStages', 'getStage', 'saveStage', 'deleteStage',
    'countCardsByFunnel', 'countCardsByStage',
    'listCardsByFunnel', 'getCardByFunnelAndRecord', 'getCard', 'saveCard', 'archiveCard', 'listCardMoves', 'saveCardMove',
  ]);
  assert.ok(Object.isFrozen(REQUIRED_FUNNEL_REPOSITORY_METHODS));
  assert.equal(funnelRepository.assertValidFunnelRepository, assertValidFunnelRepository);
  assert.equal(funnelRepository.REQUIRED_FUNNEL_REPOSITORY_METHODS, REQUIRED_FUNNEL_REPOSITORY_METHODS);
});

test('[FUNNEL-PORT-2] um repositório completo é aceito e devolvido como está (a mesma referência)', () => {
  const repo = completo();
  assert.equal(assertValidFunnelRepository(repo), repo);
});

test('[FUNNEL-PORT-3] métodos ausentes ou não-funções são recusados nomeando o método; entradas que nem são um objeto também', () => {
  for (const metodo of REQUIRED_FUNNEL_REPOSITORY_METHODS) {
    const incompleto = completo();
    incompleto[metodo] = 'não é uma função';
    assert.throws(() => assertValidFunnelRepository(incompleto), new RegExp(`falta o método ${metodo}`));
    delete incompleto[metodo];
    assert.throws(() => assertValidFunnelRepository(incompleto), new RegExp(`falta o método ${metodo}`));
  }
  for (const invalido of [null, undefined, 42, 'x', () => {}]) {
    assert.throws(() => assertValidFunnelRepository(invalido), /repositório inválido/);
  }
});

test('[FUNNEL-PORT-4] a porta aceita métodos assíncronos (mesmo desenho do CRM — decisão 0023)', () => {
  const repo = completo();
  for (const metodo of REQUIRED_FUNNEL_REPOSITORY_METHODS) repo[metodo] = async () => undefined;
  assert.equal(assertValidFunnelRepository(repo), repo);
});
