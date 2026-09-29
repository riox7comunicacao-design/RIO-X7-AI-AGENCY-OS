// A PORTA de persistência de FUNIS (Etapa "Funis 1" — funil/etapa; Etapa "Funis 2" — card). Só o CONTRATO, nunca
// uma implementação — mesmo desenho de crmRepositoryPort.js.
//
//   listFunnels()/getFunnel(id)/saveFunnel(f)/deleteFunnel(id)         — funil
//   listStages(funnelId)/getStage(id)/saveStage(s)/deleteStage(id)     — etapa
//   countCardsByFunnel(id)/countCardsByStage(id)                       — só cards ATIVOS (guardas de exclusão)
//   listCardsByFunnel(funnelId)                                       — só cards ATIVOS, para o Kanban
//   getCardByFunnelAndRecord(funnelId, crmRecordId)                   — o card ATIVO daquele par, ou null (dedup)
//   getCard(id)/saveCard(c)                                           — um card específico, ATIVO ou ARQUIVADO
//   archiveCard(id)                                                   — ARQUIVA (nunca apaga — Etapa "Funis 2",
//                                                                        decisão do proprietário: um DELETE físico
//                                                                        quebraria a FK do histórico)
//   listCardMoves(cardId)/saveCardMove(m)                              — histórico de movimentação, append-only
//
// A porta aceita implementações síncronas E assíncronas (mesmo desenho da decisão 0023 do CRM).

const REQUIRED_FUNNEL_REPOSITORY_METHODS = Object.freeze([
  'listFunnels',
  'getFunnel',
  'saveFunnel',
  'deleteFunnel',
  'listStages',
  'getStage',
  'saveStage',
  'deleteStage',
  'countCardsByFunnel',
  'countCardsByStage',
  'listCardsByFunnel',
  'getCardByFunnelAndRecord',
  'getCard',
  'saveCard',
  'archiveCard',
  'listCardMoves',
  'saveCardMove',
]);

function assertValidFunnelRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('Funil: repositório inválido — esperava um objeto com os métodos de funil/etapa/card');
  }
  for (const method of REQUIRED_FUNNEL_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new Error(`Funil: repositório inválido — falta o método ${method}()`);
    }
  }
  return repository;
}

module.exports = { REQUIRED_FUNNEL_REPOSITORY_METHODS, assertValidFunnelRepository };
