// A PORTA de persistência de NEGOCIAÇÕES (CRM 5.0, Fase D1, decisão 0028). Só o CONTRATO, nunca uma implementação — o mesmo desenho de funnelRepositoryPort.js.
//
//   list()           -> todas as negociações (qualquer situação), em qualquer ordem (quem consome ordena)
//   getById(id)      -> a negociação, ou null
//   save(negotiation) -> grava (cria ou substitui) a negociação INTEIRA, com o histórico (`eventos`) dentro dela; devolve a negociação gravada
//
// OPERAÇÃO OPCIONAL (Fase D1.1, decisão 0029) — commit({ mode, negotiation, expectedUpdatedAt, card, cardMove }): o adaptador do Supabase a oferece e o domínio a USA quando existe. Grava, numa
// ÚNICA transação, a negociação, os eventos NOVOS do histórico (nunca altera nem apaga um já gravado) e — na criação e na mudança de etapa — o card e o movimento do card. Sem ela (arquivo), o domínio
// grava o card, o movimento e depois a negociação, como na Fase D1. `mode`: 'create' | 'update'; `expectedUpdatedAt` (update): o `atualizadoEm` que quem editou LEU (concorrência otimista).
// Erros (`error.code`, strings planas): NEGOTIATION_REPOSITORY_NOT_FOUND, _CONFLICT, _CLOSED e _REJECTED (ver NEGOTIATION_REPOSITORY_ERROR); qualquer outra falha sai sem `code` (armazenamento).
//
// Não há exclusão: uma negociação nunca é apagada (ganha ou perdida, continua; um erro de cadastro se corrige editando). A porta aceita implementações
// síncronas E assíncronas (a mesma decisão 0023 do CRM). A serialização das ESCRITAS é do domínio (por repositório), não do adaptador.

const REQUIRED_NEGOTIATION_REPOSITORY_METHODS = Object.freeze(['list', 'getById', 'save']);

const OPTIONAL_NEGOTIATION_REPOSITORY_METHODS = Object.freeze(['commit']);

// Cópia literal vigiada por teste em src/crm-adapters/crmSupabaseNegotiationRepository.js (as regras R15/R16 impedem importar um do outro).
const NEGOTIATION_REPOSITORY_ERROR = Object.freeze({
  NOT_FOUND: 'NEGOTIATION_REPOSITORY_NOT_FOUND',
  CONFLICT: 'NEGOTIATION_REPOSITORY_CONFLICT',
  CLOSED: 'NEGOTIATION_REPOSITORY_CLOSED',
  REJECTED: 'NEGOTIATION_REPOSITORY_REJECTED',
});

function assertValidNegotiationRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new Error('Negociação: repositório inválido — esperava um objeto com list(), getById() e save()');
  }
  for (const method of REQUIRED_NEGOTIATION_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new Error(`Negociação: repositório inválido — falta o método ${method}()`);
  }
  for (const method of OPTIONAL_NEGOTIATION_REPOSITORY_METHODS) {
    if (repository[method] !== undefined && typeof repository[method] !== 'function') throw new Error(`Negociação: repositório inválido — ${method} deve ser uma função quando existe`);
  }
  return repository;
}

module.exports = { REQUIRED_NEGOTIATION_REPOSITORY_METHODS, OPTIONAL_NEGOTIATION_REPOSITORY_METHODS, NEGOTIATION_REPOSITORY_ERROR, assertValidNegotiationRepository };
