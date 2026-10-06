// Repositório de EXCLUSÕES PERMANENTES de prospecção (Workbench, Etapa 2) — a PORTA e o adapter de MEMÓRIA (para
// testes). Mesmo desenho de batchRepository.js. O adapter oficial de PRODUÇÃO é o Supabase, numa árvore própria
// (src/prospecting-adapters/) — por decisão explícita do proprietário, esta funcionalidade NÃO tem um terceiro
// adapter (arquivo local): só Supabase (oficial) e memória (testes).
//
// PORTA (aceita síncrono OU assíncrono — o adapter Supabase é assíncrono, o de memória não precisa ser):
//   list()             -> [exclusão, ...]              (cópias, todas — ativas e inativas)
//   getById(id)         -> exclusão | null              (cópia)
//   insert(exclusão)    -> a exclusão gravada (cópia)    (id é gerado por quem chama — a APLICAÇÃO, nunca o banco
//                                                          para o adapter de memória; o Supabase usa DEFAULT gen_random_uuid())
//   update(id, patch)  -> a exclusão atualizada | null   (merge raso; null se o id não existir)
//
// NUNCA HÁ DELETE FÍSICO nesta porta — "excluir" administrativamente é update(id, { ativo: false }) (seção 5 do
// comando: "excluir" significa desativar; histórico preservado).

const REQUIRED_METHODS = Object.freeze(['list', 'getById', 'insert', 'update']);
const clone = (value) => structuredClone(value);
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function assertValidPermanentExclusionRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new Error('Exclusão Permanente: repositório inválido — esperava um objeto');
  for (const method of REQUIRED_METHODS) {
    if (typeof repository[method] !== 'function') throw new Error(`Exclusão Permanente: repositório inválido — falta o método ${method}()`);
  }
  return repository;
}

function createInMemoryPermanentExclusionRepository(initial = []) {
  const rows = new Map();
  for (const row of initial) rows.set(row.id, clone(row));
  return {
    list() {
      return [...rows.values()].map(clone);
    },
    getById(id) {
      if (typeof id !== 'string' || UNSAFE_IDS.has(id)) return null;
      const row = rows.get(id);
      return row ? clone(row) : null;
    },
    insert(exclusao) {
      if (!exclusao || typeof exclusao.id !== 'string' || !exclusao.id) throw new Error('Exclusão Permanente: insert() exige um registro com id');
      if (UNSAFE_IDS.has(exclusao.id)) throw new Error(`Exclusão Permanente: id não permitido: ${exclusao.id}`);
      const gravado = clone(exclusao);
      rows.set(exclusao.id, gravado);
      return clone(gravado);
    },
    update(id, patch) {
      if (typeof id !== 'string' || UNSAFE_IDS.has(id)) return null;
      const atual = rows.get(id);
      if (!atual) return null;
      const atualizado = { ...atual, ...clone(patch) };
      rows.set(id, atualizado);
      return clone(atualizado);
    },
  };
}

module.exports = { REQUIRED_METHODS, assertValidPermanentExclusionRepository, createInMemoryPermanentExclusionRepository };
