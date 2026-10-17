// Adapter Postgres/Supabase de FUNIS, ETAPAS e CARDS (CRM 5.0, Fase D1.1, decisão 0029) — o adapter de PRODUÇÃO da porta de src/crm/funnelRepositoryPort.js, ao lado do adapter de arquivo
// (src/crm/funnelRepository.js), que continua existindo SÓ para desenvolvimento isolado e testes. Quem decide qual dos dois usar é a fábrica (src/services/commercialRepositoryFactory.js), por
// REPOSITORY_MODE, e NUNCA há fallback entre eles: em "supabase" só este adapter existe para as entidades comerciais.
//
// TABELAS (migrations 20260928220000_crm_funnels.sql + 20260929100000_crm_funnel_cards_funis2.sql — pré-requisitos — e 20261019090000_crm_negotiations.sql, todas NÃO APLICADAS por este
// código nem por nenhum teste): crm_funnels, crm_funnel_stages, crm_funnel_cards (+ negotiation_id) e crm_funnel_card_moves (histórico imutável).
//
// ATOMICIDADE: as gravações que tocam mais de uma linha NUNCA são vários POSTs soltos. O adapter oferece, além da porta, três operações OPCIONAIS que o domínio usa quando existem:
//   - commitCardChange({ card, move, expectedStageId })  -> RPC commit_crm_funnel_card_change: o card e o seu movimento de histórico, numa transação;
//   - reorderStages(funnelId, orderedIds)                -> RPC reorder_crm_funnel_stages: todas as posições mudam ou nenhuma;
//   - deleteFunnelCascade(funnelId)                      -> RPC delete_crm_funnel_if_empty: as etapas e o funil saem juntos, e só se não houver NENHUM card.
// saveFunnel/saveStage são upserts de UMA linha (atômicos por si); saveCard/saveCardMove existem pela porta, mas o domínio, quando commitCardChange existe, nunca os usa em dois passos.
//
// LEITURA: sempre COMPLETA e validada (postgrestClient.readAll): uma falha de leitura é um ERRO, nunca uma lista vazia. As contagens que guardam exclusões (countCardsBy*) e a que protege a
// exclusão de um registro do CRM (countActiveCardsByCrmRecord) contam TODOS os cards, inclusive os ARQUIVADOS — diferença deliberada do modo arquivo: no banco o card arquivado continua
// referenciando funil, etapa e cliente (integridade referencial e histórico preservado), então ele também impede essas exclusões.
//
// CONTRATO DE ERRO (comum aos adapters; o `code` é uma string plana e estável — nada de instanceof): FUNNEL_CARD_DUPLICATE (índice único dos cards avulsos ativos), FUNNEL_REPOSITORY_CONFLICT
// (o card mudou de etapa por outra via), FUNNEL_STAGE_MISMATCH (a etapa não é do funil do card), FUNNEL_HAS_CARDS e STAGE_HAS_CARDS (a guarda de exclusão). Qualquer outra falha sai SEM `code`.
// Os códigos conhecidos são os que app.js já traduz; um teste vigia a igualdade com src/crm/funnelRepositoryPort.js.
//
// SEGREDO: a service_role key fica só em memória (ver postgrestClient.js).

const { readSupabaseCrmConfig } = require('./crmSupabaseConfig');
const { createPostgrestClient, isPlainObject } = require('./postgrestClient');

const LABEL = 'Funis (Supabase)';
const TABLES = Object.freeze({ funnels: 'crm_funnels', stages: 'crm_funnel_stages', cards: 'crm_funnel_cards', moves: 'crm_funnel_card_moves' });
const RPC = Object.freeze({ card: 'commit_crm_funnel_card_change', reorder: 'reorder_crm_funnel_stages', deleteFunnel: 'delete_crm_funnel_if_empty', deleteStage: 'delete_crm_funnel_stage_if_empty' });

const FUNNEL_REPOSITORY_ERROR = Object.freeze({
  DUPLICATE_CARD: 'FUNNEL_CARD_DUPLICATE',
  CONFLICT: 'FUNNEL_REPOSITORY_CONFLICT',
  STAGE_MISMATCH: 'FUNNEL_STAGE_MISMATCH',
  FUNNEL_HAS_CARDS: 'FUNNEL_HAS_CARDS',
  STAGE_HAS_CARDS: 'STAGE_HAS_CARDS',
});

const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function requireId(id, label) {
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${LABEL}: id de ${label} deve ser um texto não vazio`);
  if (UNSAFE_IDS.has(id)) throw new Error(`${LABEL}: id de ${label} não permitido: ${id}`);
  return id;
}

// timestamptz do Postgres ("2026-10-12T12:00:00.123456+00:00") -> ISO 8601 em UTC com milissegundos, o formato do domínio.
function toIso(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
const toIntOrNull = (value) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

// Classifica SÓ o que o Postgres sinaliza de forma inequívoca (pelo código e pelo NOME fixo da restrição/função na migration).
function classify(status, json) {
  const code = json && typeof json.code === 'string' ? json.code : null;
  const text = `${json && typeof json.message === 'string' ? json.message : ''} ${json && typeof json.details === 'string' ? json.details : ''}`;
  if ((status === 409 || code === '23505') && /crm_funnel_cards_active_unique_idx/.test(text)) return FUNNEL_REPOSITORY_ERROR.DUPLICATE_CARD;
  if (code === 'P0001' && /crm_funnel_card_conflict/.test(text)) return FUNNEL_REPOSITORY_ERROR.CONFLICT;
  if (code === 'P0001' && /crm_funnel_cards_integrity: a etapa/.test(text)) return FUNNEL_REPOSITORY_ERROR.STAGE_MISMATCH;
  if (code === 'P0001' && /delete_crm_funnel_if_empty/.test(text)) return FUNNEL_REPOSITORY_ERROR.FUNNEL_HAS_CARDS;
  if (code === 'P0001' && /delete_crm_funnel_stage_if_empty/.test(text)) return FUNNEL_REPOSITORY_ERROR.STAGE_HAS_CARDS;
  return null;
}

const isRow = (row) => typeof row.id === 'string' && row.id.length > 0;

function rowToFunnel(row) {
  return {
    id: row.id,
    nome: row.nome,
    descricao: row.descricao ?? null,
    finalidade: row.finalidade ?? null,
    ativo: row.ativo === true,
    ordem: toIntOrNull(row.ordem) ?? 0,
    config: isPlainObject(row.config) ? row.config : {},
    criadoEm: toIso(row.criado_em),
  };
}
function funnelToRow(funnel) {
  return {
    id: funnel.id,
    nome: funnel.nome,
    descricao: funnel.descricao ?? null,
    finalidade: funnel.finalidade ?? null,
    ativo: funnel.ativo !== false,
    ordem: funnel.ordem ?? 0,
    config: isPlainObject(funnel.config) ? funnel.config : {},
    ...(funnel.criadoEm ? { criado_em: funnel.criadoEm } : {}),
  };
}
function rowToStage(row) {
  return {
    id: row.id,
    funnelId: row.funnel_id,
    nome: row.nome,
    ordem: toIntOrNull(row.ordem) ?? 0,
    ativo: row.ativo === true,
    config: isPlainObject(row.config) ? row.config : {},
    criadoEm: toIso(row.criado_em),
  };
}
function stageToRow(stage) {
  return {
    id: stage.id,
    funnel_id: stage.funnelId,
    nome: stage.nome,
    ordem: stage.ordem ?? 0,
    ativo: stage.ativo !== false,
    config: isPlainObject(stage.config) ? stage.config : {},
    ...(stage.criadoEm ? { criado_em: stage.criadoEm } : {}),
  };
}
function rowToCard(row) {
  const card = {
    id: row.id,
    funnelId: row.funnel_id,
    stageId: row.stage_id,
    crmRecordId: row.crm_record_id,
    removedAt: toIso(row.removed_at),
    criadoEm: toIso(row.criado_em),
    updatedAt: toIso(row.updated_at),
  };
  if (typeof row.negotiation_id === 'string' && row.negotiation_id.length > 0) card.negotiationId = row.negotiation_id;
  return card;
}
function cardToPayload(card) {
  return {
    id: card.id,
    funnelId: card.funnelId,
    stageId: card.stageId,
    crmRecordId: card.crmRecordId,
    negotiationId: card.negotiationId ?? null,
    criadoEm: card.criadoEm,
    updatedAt: card.updatedAt,
  };
}
function requireMovedBy(movedBy) {
  if (!isPlainObject(movedBy) || typeof movedBy.userId !== 'string' || !movedBy.userId.trim() || typeof movedBy.name !== 'string' || !movedBy.name.trim() || typeof movedBy.role !== 'string' || !movedBy.role.trim()) {
    throw new Error(`${LABEL}: o movimento do card exige quem moveu ({ userId, name, role }) — o histórico é obrigatório e nunca anônimo`);
  }
  return { userId: movedBy.userId, name: movedBy.name, role: movedBy.role };
}
function movePayload(move) {
  if (!isPlainObject(move)) throw new Error(`${LABEL}: o movimento do card é obrigatório`);
  requireId(move.cardId, 'card');
  requireId(move.stageTo, 'etapa');
  if (move.stageFrom !== null && move.stageFrom !== undefined) requireId(move.stageFrom, 'etapa');
  return { cardId: move.cardId, stageFrom: move.stageFrom ?? null, stageTo: move.stageTo, movedBy: requireMovedBy(move.movedBy), motivo: move.motivo ?? null, movedAt: move.movedAt };
}
function rowToMove(row) {
  return {
    cardId: row.card_id,
    stageFrom: row.stage_from ?? null,
    stageTo: row.stage_to,
    movedBy: { userId: row.moved_by_user_id, name: row.moved_by_name, role: row.moved_by_role },
    motivo: row.motivo ?? null,
    movedAt: toIso(row.moved_at),
  };
}

// options: { url, serviceRoleKey } (config explícita, senão lida de `env` por readSupabaseCrmConfig — exige AS DUAS variáveis), { env } e { fetchImpl } (padrão: o fetch global; sempre injetável).
function createSupabaseFunnelRepository(options = {}) {
  const { fetchImpl = fetch } = options;
  if (typeof fetchImpl !== 'function') throw new Error(`${LABEL}: fetchImpl deve ser uma função.`);
  const hasExplicitConfig = typeof options.url === 'string' && options.url.length > 0 && typeof options.serviceRoleKey === 'string' && options.serviceRoleKey.length > 0;
  const config = hasExplicitConfig ? { url: options.url, serviceRoleKey: options.serviceRoleKey } : readSupabaseCrmConfig(options.env || process.env);
  const client = createPostgrestClient({ url: config.url, serviceRoleKey: config.serviceRoleKey, fetchImpl, label: LABEL });
  const call = (spec) => client.request({ ...spec, classify });
  const one = async (table, filters) => {
    const { json } = await call({ method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', ...filters, limit: '1' } });
    return Array.isArray(json) && json.length > 0 ? json[0] : null;
  };
  const all = (table, filters, order, noun) => client.readAll({ table, filters, order, noun, check: isRow });
  const upsert = (table, row) => call({ method: 'POST', path: `/rest/v1/${table}`, body: [row], prefer: 'resolution=merge-duplicates,return=minimal' });

  const repository = {
    async listFunnels() {
      return (await all(TABLES.funnels, {}, 'ordem.asc,criado_em.asc,id.asc', 'os funis')).map(rowToFunnel);
    },
    async getFunnel(id) {
      requireId(id, 'funil');
      const row = await one(TABLES.funnels, { id: `eq.${id}` });
      return row ? rowToFunnel(row) : null;
    },
    async saveFunnel(funnel) {
      if (!isPlainObject(funnel)) throw new Error(`${LABEL}: saveFunnel() exige um funil`);
      requireId(funnel.id, 'funil');
      await upsert(TABLES.funnels, funnelToRow(funnel));
    },
    async deleteFunnel(id) {
      requireId(id, 'funil');
      await call({ method: 'POST', path: `/rest/v1/rpc/${RPC.deleteFunnel}`, body: { p_funnel_id: id } });
    },
    async listStages(funnelId) {
      requireId(funnelId, 'funil');
      return (await all(TABLES.stages, { funnel_id: `eq.${funnelId}` }, 'ordem.asc,criado_em.asc,id.asc', 'as etapas')).map(rowToStage);
    },
    async getStage(id) {
      requireId(id, 'etapa');
      const row = await one(TABLES.stages, { id: `eq.${id}` });
      return row ? rowToStage(row) : null;
    },
    async saveStage(stage) {
      if (!isPlainObject(stage)) throw new Error(`${LABEL}: saveStage() exige uma etapa`);
      requireId(stage.id, 'etapa');
      requireId(stage.funnelId, 'funil');
      await upsert(TABLES.stages, stageToRow(stage));
    },
    async deleteStage(id) {
      requireId(id, 'etapa');
      await call({ method: 'POST', path: `/rest/v1/rpc/${RPC.deleteStage}`, body: { p_stage_id: id } });
    },
    async countCardsByFunnel(funnelId) {
      requireId(funnelId, 'funil');
      return client.countRows({ table: TABLES.cards, filters: { funnel_id: `eq.${funnelId}` }, noun: 'os cards' });
    },
    async countCardsByStage(stageId) {
      requireId(stageId, 'etapa');
      return client.countRows({ table: TABLES.cards, filters: { stage_id: `eq.${stageId}` }, noun: 'os cards' });
    },
    async listCardsByFunnel(funnelId) {
      requireId(funnelId, 'funil');
      return (await all(TABLES.cards, { funnel_id: `eq.${funnelId}`, removed_at: 'is.null' }, 'criado_em.asc,id.asc', 'os cards')).map(rowToCard);
    },
    async getCardByFunnelAndRecord(funnelId, crmRecordId) {
      requireId(funnelId, 'funil');
      requireId(crmRecordId, 'registro do CRM');
      const row = await one(TABLES.cards, { funnel_id: `eq.${funnelId}`, crm_record_id: `eq.${crmRecordId}`, removed_at: 'is.null', negotiation_id: 'is.null' });
      return row ? rowToCard(row) : null;
    },
    async getCard(id) {
      requireId(id, 'card');
      const row = await one(TABLES.cards, { id: `eq.${id}` });
      return row ? rowToCard(row) : null;
    },
    async saveCard(card) {
      if (!isPlainObject(card)) throw new Error(`${LABEL}: saveCard() exige um card`);
      requireId(card.id, 'card');
      await upsert(TABLES.cards, {
        id: card.id,
        funnel_id: card.funnelId,
        stage_id: card.stageId,
        crm_record_id: card.crmRecordId,
        negotiation_id: card.negotiationId ?? null,
        removed_at: card.removedAt ?? null,
        ...(card.criadoEm ? { criado_em: card.criadoEm } : {}),
      });
    },
    // ARQUIVA (nunca apaga — o histórico referencia o card). Só cards ATIVOS e SEM negociação: o card de uma negociação nunca é arquivado por aqui.
    async archiveCard(id) {
      requireId(id, 'card');
      await call({ method: 'PATCH', path: `/rest/v1/${TABLES.cards}`, query: { id: `eq.${id}`, removed_at: 'is.null', negotiation_id: 'is.null' }, body: { removed_at: new Date().toISOString() } });
    },
    async listCardMoves(cardId) {
      requireId(cardId, 'card');
      return (await client.readAll({ table: TABLES.moves, filters: { card_id: `eq.${cardId}` }, order: 'moved_at.asc,id.asc', noun: 'o histórico do card', check: (row) => typeof row.card_id === 'string' })).map(rowToMove);
    },
    async saveCardMove(move) {
      const payload = movePayload(move);
      await call({
        method: 'POST',
        path: `/rest/v1/${TABLES.moves}`,
        body: [{ card_id: payload.cardId, stage_from: payload.stageFrom, stage_to: payload.stageTo, moved_by_user_id: payload.movedBy.userId, moved_by_name: payload.movedBy.name, moved_by_role: payload.movedBy.role, motivo: payload.motivo, moved_at: payload.movedAt }],
        prefer: 'return=minimal',
      });
    },
    // Os cards (de QUALQUER situação) que referenciam o registro: o banco os impede de ser apagados com o cliente (FK), então o arquivado também conta.
    async countActiveCardsByCrmRecord(crmRecordId) {
      requireId(crmRecordId, 'registro do CRM');
      return client.countRows({ table: TABLES.cards, filters: { crm_record_id: `eq.${crmRecordId}` }, noun: 'os cards' });
    },

    // ---- operações OPCIONAIS (atômicas) ----
    async commitCardChange({ card, move, expectedStageId = null }) {
      if (!isPlainObject(card)) throw new Error(`${LABEL}: commitCardChange() exige o card`);
      requireId(card.id, 'card');
      await call({ method: 'POST', path: `/rest/v1/rpc/${RPC.card}`, body: { p_card: cardToPayload(card), p_card_move: movePayload(move), p_expected_stage_id: expectedStageId } });
    },
    async reorderStages(funnelId, orderedIds) {
      requireId(funnelId, 'funil');
      if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) throw new Error(`${LABEL}: reorderStages() exige uma lista de ids (texto)`);
      orderedIds.forEach((id) => requireId(id, 'etapa'));
      await call({ method: 'POST', path: `/rest/v1/rpc/${RPC.reorder}`, body: { p_funnel_id: funnelId, p_ordered_ids: orderedIds } });
    },
    async deleteFunnelCascade(funnelId) {
      requireId(funnelId, 'funil');
      await call({ method: 'POST', path: `/rest/v1/rpc/${RPC.deleteFunnel}`, body: { p_funnel_id: funnelId } });
    },
  };
  return Object.freeze(repository);
}

module.exports = { createSupabaseFunnelRepository, FUNNEL_REPOSITORY_ERROR, TABLES, RPC };
