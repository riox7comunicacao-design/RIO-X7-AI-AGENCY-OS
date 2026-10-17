// A PORTA de persistência de FUNIS (Etapa "Funis 1" — funil/etapa; Etapa "Funis 2" — card). Só o CONTRATO, nunca
// uma implementação — mesmo desenho de crmRepositoryPort.js.
//
//   listFunnels()/getFunnel(id)/saveFunnel(f)/deleteFunnel(id)         — funil
//   listStages(funnelId)/getStage(id)/saveStage(s)/deleteStage(id)     — etapa
//   countCardsByFunnel(id)/countCardsByStage(id)                       — só cards ATIVOS (guardas de exclusão)
//   listCardsByFunnel(funnelId)                                       — só cards ATIVOS, para o Kanban
//   getCardByFunnelAndRecord(funnelId, crmRecordId)                   — o card ATIVO daquele par, ou null (dedup). Só vê os cards SEM
//                                                                        negociação (`negotiationId` ausente): um cliente pode ter várias
//                                                                        negociações no mesmo funil (Fase D1, decisão 0028)
//   getCard(id)/saveCard(c)                                           — um card específico, ATIVO ou ARQUIVADO
//   archiveCard(id)                                                   — ARQUIVA (nunca apaga — Etapa "Funis 2",
//                                                                        decisão do proprietário: um DELETE físico
//                                                                        quebraria a FK do histórico)
//   listCardMoves(cardId)/saveCardMove(m)                              — histórico de movimentação, append-only
//   countActiveCardsByCrmRecord(crmRecordId)                          — só cards ATIVOS de UM registro do CRM,
//                                                                        em QUALQUER funil (Etapa "Funis 2 —
//                                                                        correção de integridade CRM ↔ Card"): é
//                                                                        a consulta que o CRM Service usa, por
//                                                                        injeção (ver src/services/crmService.js),
//                                                                        para recusar excluir um registro do CRM
//                                                                        enquanto ele ainda tiver Cards ativos.
//
// OPERAÇÕES OPCIONAIS (Fase D1.1, decisão 0029) — o adaptador do Supabase as oferece para que gravações de mais de uma linha sejam ATÔMICAS (uma transação); o de arquivo não precisa delas:
//   commitCardChange({ card, move, expectedStageId })  grava o card e o seu movimento de histórico JUNTOS (expectedStageId: a etapa em que o card foi lido, ao mover; null ao criar)
//   reorderStages(funnelId, orderedIds)                 todas as posições mudam ou nenhuma
//   deleteFunnelCascade(funnelId)                       as etapas e o funil saem juntos (e só sem NENHUM card)
// O domínio usa cada uma quando existe e, quando não existe, faz os passos de sempre. Os códigos de erro (`error.code`) que um adaptador pode lançar e o app traduz:
//   FUNNEL_CARD_DUPLICATE, FUNNEL_REPOSITORY_CONFLICT, FUNNEL_STAGE_MISMATCH, FUNNEL_HAS_CARDS, STAGE_HAS_CARDS (ver FUNNEL_REPOSITORY_ERROR).
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
  'countActiveCardsByCrmRecord',
]);

const OPTIONAL_FUNNEL_REPOSITORY_METHODS = Object.freeze(['commitCardChange', 'reorderStages', 'deleteFunnelCascade']);

// Os códigos de erro que um adaptador pode lançar (cópia literal vigiada por teste em src/crm-adapters/crmSupabaseFunnelRepository.js: as regras R15/R16 impedem importar um do outro).
const FUNNEL_REPOSITORY_ERROR = Object.freeze({
  DUPLICATE_CARD: 'FUNNEL_CARD_DUPLICATE',
  CONFLICT: 'FUNNEL_REPOSITORY_CONFLICT',
  STAGE_MISMATCH: 'FUNNEL_STAGE_MISMATCH',
  FUNNEL_HAS_CARDS: 'FUNNEL_HAS_CARDS',
  STAGE_HAS_CARDS: 'STAGE_HAS_CARDS',
});

function assertValidFunnelRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('Funil: repositório inválido — esperava um objeto com os métodos de funil/etapa/card');
  }
  for (const method of REQUIRED_FUNNEL_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new Error(`Funil: repositório inválido — falta o método ${method}()`);
    }
  }
  for (const method of OPTIONAL_FUNNEL_REPOSITORY_METHODS) {
    if (repository[method] !== undefined && typeof repository[method] !== 'function') {
      throw new Error(`Funil: repositório inválido — ${method} deve ser uma função quando existe`);
    }
  }
  return repository;
}

module.exports = { REQUIRED_FUNNEL_REPOSITORY_METHODS, OPTIONAL_FUNNEL_REPOSITORY_METHODS, FUNNEL_REPOSITORY_ERROR, assertValidFunnelRepository };
