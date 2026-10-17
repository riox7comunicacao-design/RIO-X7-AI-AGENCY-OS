// Adapter Postgres/Supabase de NEGOCIAÇÕES (CRM 5.0, Fase D1.1, decisão 0029) — o adapter de PRODUÇÃO da porta de src/crm/negotiationRepositoryPort.js, ao lado do adapter de arquivo
// (src/crm/negotiationRepository.js), que continua existindo SÓ para desenvolvimento isolado e testes. Nunca há fallback entre eles: a fábrica (src/services/commercialRepositoryFactory.js)
// escolhe UM por REPOSITORY_MODE, e em "supabase" as negociações, os funis, as etapas e os cards vão TODOS para o Supabase (nunca negociação num armazenamento e funil em outro).
//
// TABELAS (migration 20261019090000_crm_negotiations.sql — NÃO APLICADA por este código nem por nenhum teste): crm_negotiations e crm_negotiation_events (histórico IMUTÁVEL), mais o card e o
// movimento do card (crm_funnel_cards, crm_funnel_card_moves — ver crmSupabaseFunnelRepository.js).
//
// O OBJETO DO DOMÍNIO: a negociação com o histórico DENTRO dela (`eventos`) e o valor em REAIS (`valorNegociado`). No banco o valor é `valor_centavos` (inteiro): a conversão é exata —
// um valor que não é um número positivo com no máximo duas casas é RECUSADO aqui (nunca arredondado em silêncio). TCV, MRR e equivalente mensal não são gravados: derivam no domínio.
//
// ATOMICIDADE (a regra central): NENHUMA gravação é uma sequência de requisições soltas. `commit()` chama UMA função SQL (commit_crm_negotiation_change) que, numa única transação, grava a
// negociação, ACRESCENTA os eventos novos ao histórico (nunca altera nem apaga um já gravado) e — quando é criação ou mudança de etapa — o card e o movimento do card. Uma gravação não
// existe sem o seu histórico obrigatório: se qualquer parte falhar, nada é gravado e o erro sobe (o Dashboard nunca vê sucesso). A concorrência é OTIMISTA: `expectedUpdatedAt` é o `atualizadoEm`
// que quem editou LEU; se outra pessoa gravou no meio, a função recusa (conflito) em vez de sobrescrever.
//
// LEITURA: sempre COMPLETA e validada (postgrestClient.readAll) — as negociações e os eventos de todas; uma falha ou uma resposta fora do formato é um ERRO, nunca "não há negociações".
// LIMITES OPERACIONAIS TEMPORÁRIOS (não são a capacidade do produto): 10 mil negociações e 50 mil eventos por leitura; acima disso a leitura FALHA (nunca devolve metade).
//
// CONTRATO DE ERRO (strings planas e estáveis; as MESMAS de src/crm/negotiationRepositoryPort.js — um teste vigia a igualdade, porque as regras R15/R16 impedem importar o domínio aqui):
// NEGOTIATION_REPOSITORY_NOT_FOUND, _CONFLICT (concorrência), _CLOSED (uma negociação fechada só muda por reabrir) e _REJECTED (qualquer outra regra do banco). Falha de rede, tabela ausente,
// permissão ou um CHECK violado saem SEM `code` e o domínio as trata como falha de armazenamento (503).
//
// SEGREDO: a service_role key fica só em memória (ver postgrestClient.js).

const { readSupabaseCrmConfig } = require('./crmSupabaseConfig');
const { createPostgrestClient, isPlainObject } = require('./postgrestClient');

const LABEL = 'Negociações (Supabase)';
const TABLES = Object.freeze({ negotiations: 'crm_negotiations', events: 'crm_negotiation_events' });
const COMMIT_RPC = 'commit_crm_negotiation_change';
const EVENTS_MAX_ROWS = 50000;

const NEGOTIATION_REPOSITORY_ERROR = Object.freeze({
  NOT_FOUND: 'NEGOTIATION_REPOSITORY_NOT_FOUND',
  CONFLICT: 'NEGOTIATION_REPOSITORY_CONFLICT',
  CLOSED: 'NEGOTIATION_REPOSITORY_CLOSED',
  REJECTED: 'NEGOTIATION_REPOSITORY_REJECTED',
});

const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function requireId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${LABEL}: id deve ser um texto não vazio`);
  if (UNSAFE_IDS.has(id)) throw new Error(`${LABEL}: id não permitido: ${id}`);
  return id;
}

const toIso = (value) => {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// reais (número) -> centavos inteiros EXATOS, ou erro. (A mesma regra de src/crm/negotiationFinance.js toCents; um teste vigia a paridade.)
const MAX_CENTS = 100_000_000_000;
function toCentsOrThrow(reais) {
  if (typeof reais !== 'number' || !Number.isFinite(reais) || reais <= 0) throw new Error(`${LABEL}: valorNegociado deve ser um número positivo em reais`);
  const cents = Math.round(reais * 100);
  if (Math.abs(reais * 100 - cents) > 1e-6) throw new Error(`${LABEL}: valorNegociado aceita no máximo duas casas decimais`);
  if (cents < 1 || cents > MAX_CENTS) throw new Error(`${LABEL}: valorNegociado fora do intervalo permitido`);
  return cents;
}
function centsToReais(value) {
  const cents = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_CENTS) throw new Error(`${LABEL}: valor em centavos inválido na linha lida`);
  return cents / 100;
}

function classify(status, json) {
  const code = json && typeof json.code === 'string' ? json.code : null;
  const text = `${json && typeof json.message === 'string' ? json.message : ''} ${json && typeof json.details === 'string' ? json.details : ''}`;
  if (code === 'P0001') {
    if (/crm_negotiation_not_found/.test(text)) return NEGOTIATION_REPOSITORY_ERROR.NOT_FOUND;
    if (/crm_negotiation_conflict/.test(text)) return NEGOTIATION_REPOSITORY_ERROR.CONFLICT;
    if (/crm_negotiation_closed/.test(text)) return NEGOTIATION_REPOSITORY_ERROR.CLOSED;
    if (/crm_negotiation_|crm_funnel_cards_integrity/.test(text)) return NEGOTIATION_REPOSITORY_ERROR.REJECTED;
  }
  return null;
}

function rowToEvent(row) {
  const event = { tipo: row.tipo, em: toIso(row.em), porUserId: row.por_user_id, porNome: row.por_nome };
  if (row.detalhe !== null && row.detalhe !== undefined) event.detalhe = row.detalhe;
  return event;
}

function rowToNegotiation(row, events) {
  return {
    id: row.id,
    crmRecordId: row.crm_record_id,
    funnelId: row.funnel_id,
    cardId: row.card_id,
    serviceId: row.service_id,
    servicoNome: row.servico_nome ?? null,
    responsavelUserId: row.responsavel_user_id,
    responsavelNome: row.responsavel_nome,
    prazoMeses: Number(row.prazo_meses),
    formaPagamento: row.forma_pagamento,
    periodicidade: row.periodicidade ?? null,
    valorNegociado: centsToReais(row.valor_centavos),
    previsaoFechamento: typeof row.previsao_fechamento === 'string' ? row.previsao_fechamento.slice(0, 10) : null,
    situacao: row.situacao,
    motivoPerda: row.motivo_perda ?? null,
    fechadoEm: toIso(row.fechado_em),
    criadoEm: toIso(row.created_at),
    atualizadoEm: toIso(row.updated_at),
    criadoPorUserId: row.created_by_user_id,
    criadoPorNome: row.created_by_name,
    atualizadoPorUserId: row.updated_by_user_id,
    atualizadoPorNome: row.updated_by_name,
    eventos: events,
  };
}

function eventToPayload(event) {
  if (!isPlainObject(event) || typeof event.tipo !== 'string' || typeof event.em !== 'string' || typeof event.porUserId !== 'string' || typeof event.porNome !== 'string') {
    throw new Error(`${LABEL}: evento de histórico inválido`);
  }
  return { tipo: event.tipo, em: event.em, porUserId: event.porUserId, porNome: event.porNome, ...(event.detalhe === undefined || event.detalhe === null ? {} : { detalhe: event.detalhe }) };
}

function negotiationToPayload(negotiation) {
  if (!isPlainObject(negotiation)) throw new Error(`${LABEL}: a negociação deve ser um objeto`);
  requireId(negotiation.id);
  if (!Array.isArray(negotiation.eventos) || negotiation.eventos.length === 0) throw new Error(`${LABEL}: a negociação não traz o histórico obrigatório`);
  return {
    id: negotiation.id,
    crmRecordId: negotiation.crmRecordId,
    funnelId: negotiation.funnelId,
    cardId: negotiation.cardId,
    serviceId: negotiation.serviceId,
    servicoNome: negotiation.servicoNome ?? null,
    responsavelUserId: negotiation.responsavelUserId,
    responsavelNome: negotiation.responsavelNome,
    prazoMeses: negotiation.prazoMeses,
    formaPagamento: negotiation.formaPagamento,
    periodicidade: negotiation.periodicidade ?? null,
    valorCentavos: toCentsOrThrow(negotiation.valorNegociado),
    previsaoFechamento: negotiation.previsaoFechamento ?? null,
    situacao: negotiation.situacao,
    motivoPerda: negotiation.motivoPerda ?? null,
    fechadoEm: negotiation.fechadoEm ?? null,
    criadoEm: negotiation.criadoEm,
    atualizadoEm: negotiation.atualizadoEm,
    criadoPorUserId: negotiation.criadoPorUserId,
    criadoPorNome: negotiation.criadoPorNome,
    atualizadoPorUserId: negotiation.atualizadoPorUserId,
    atualizadoPorNome: negotiation.atualizadoPorNome,
    eventos: negotiation.eventos.map(eventToPayload),
  };
}

function cardPayload(card) {
  if (!isPlainObject(card)) throw new Error(`${LABEL}: o card deve ser um objeto`);
  return { id: card.id, funnelId: card.funnelId, stageId: card.stageId, crmRecordId: card.crmRecordId, negotiationId: card.negotiationId ?? null, criadoEm: card.criadoEm, updatedAt: card.updatedAt };
}
function movePayload(move) {
  if (!isPlainObject(move) || !isPlainObject(move.movedBy) || typeof move.movedBy.userId !== 'string' || !move.movedBy.userId.trim() || typeof move.movedBy.name !== 'string' || !move.movedBy.name.trim()
    || typeof move.movedBy.role !== 'string' || !move.movedBy.role.trim()) {
    throw new Error(`${LABEL}: o movimento do card exige quem moveu ({ userId, name, role }) — o histórico é obrigatório e nunca anônimo`);
  }
  return { cardId: move.cardId, stageFrom: move.stageFrom ?? null, stageTo: move.stageTo, movedBy: { userId: move.movedBy.userId, name: move.movedBy.name, role: move.movedBy.role }, motivo: move.motivo ?? null, movedAt: move.movedAt };
}

function createSupabaseNegotiationRepository(options = {}) {
  const { fetchImpl = fetch } = options;
  if (typeof fetchImpl !== 'function') throw new Error(`${LABEL}: fetchImpl deve ser uma função.`);
  const hasExplicitConfig = typeof options.url === 'string' && options.url.length > 0 && typeof options.serviceRoleKey === 'string' && options.serviceRoleKey.length > 0;
  const config = hasExplicitConfig ? { url: options.url, serviceRoleKey: options.serviceRoleKey } : readSupabaseCrmConfig(options.env || process.env);
  const client = createPostgrestClient({ url: config.url, serviceRoleKey: config.serviceRoleKey, fetchImpl, label: LABEL });

  const isNegotiationRow = (row) => typeof row.id === 'string' && row.id.length > 0;
  // agrupa as linhas de evento por negociação, EXIGINDO a sequência contínua 0..n-1 (um buraco no histórico é erro, nunca "mostra o que der")
  function groupEvents(rows) {
    const byNegotiation = new Map();
    for (const row of rows) {
      if (typeof row.negotiation_id !== 'string' || !Number.isInteger(row.seq)) throw new Error(`${LABEL}: um evento de histórico tem formato inesperado.`);
      if (!byNegotiation.has(row.negotiation_id)) byNegotiation.set(row.negotiation_id, []);
      byNegotiation.get(row.negotiation_id).push(row);
    }
    for (const [, list] of byNegotiation) {
      list.sort((a, b) => a.seq - b.seq);
      list.forEach((row, index) => {
        if (row.seq !== index) throw new Error(`${LABEL}: o histórico de uma negociação está incompleto.`);
      });
    }
    return byNegotiation;
  }
  function assemble(negotiationRows, eventsByNegotiation) {
    return negotiationRows.map((row) => {
      const events = eventsByNegotiation.get(row.id);
      if (!events || events.length === 0) throw new Error(`${LABEL}: uma negociação veio sem o histórico obrigatório.`);
      return rowToNegotiation(row, events.map(rowToEvent));
    });
  }

  async function list() {
    const rows = await client.readAll({ table: TABLES.negotiations, order: 'created_at.asc,id.asc', noun: 'as negociações', check: isNegotiationRow });
    const eventRows = await client.readAll({ table: TABLES.events, order: 'negotiation_id.asc,seq.asc', noun: 'o histórico das negociações', maxRows: EVENTS_MAX_ROWS, check: (row) => typeof row.negotiation_id === 'string' });
    return assemble(rows, groupEvents(eventRows));
  }

  async function getById(id) {
    requireId(id);
    const { json } = await client.request({ method: 'GET', path: `/rest/v1/${TABLES.negotiations}`, query: { select: '*', id: `eq.${id}`, limit: '1' }, classify });
    if (!Array.isArray(json)) throw new Error(`${LABEL}: a resposta não é uma lista.`);
    if (json.length === 0) return null;
    const eventRows = await client.readAll({ table: TABLES.events, filters: { negotiation_id: `eq.${id}` }, order: 'seq.asc', noun: 'o histórico da negociação', check: (row) => Number.isInteger(row.seq) && row.negotiation_id === id });
    return assemble([json[0]], groupEvents(eventRows))[0];
  }

  // { mode: 'create' | 'update', negotiation, expectedUpdatedAt (update), card, cardMove }: tudo numa transação (ver o cabeçalho).
  async function commit({ mode, negotiation, expectedUpdatedAt = null, card = null, cardMove = null }) {
    if (mode !== 'create' && mode !== 'update') throw new Error(`${LABEL}: commit() exige mode "create" ou "update"`);
    if (mode === 'update' && (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt.length === 0)) throw new Error(`${LABEL}: commit("update") exige expectedUpdatedAt (a concorrência é otimista)`);
    if ((card === null) !== (cardMove === null)) throw new Error(`${LABEL}: o card e o movimento do card vêm juntos`);
    await client.request({
      method: 'POST',
      path: `/rest/v1/rpc/${COMMIT_RPC}`,
      body: { p_mode: mode, p_negotiation: negotiationToPayload(negotiation), p_card: card === null ? null : cardPayload(card), p_card_move: cardMove === null ? null : movePayload(cardMove), p_expected_updated_at: mode === 'update' ? expectedUpdatedAt : null },
      classify,
    });
  }

  // A porta pede save(): aqui só ATUALIZA uma negociação que já existe (lê o `atualizadoEm` atual como o esperado) — criar exige o card e vai por commit({ mode: 'create' }).
  async function save(negotiation) {
    if (!isPlainObject(negotiation)) throw new Error(`${LABEL}: save() exige uma negociação`);
    const current = await getById(negotiation.id);
    if (current === null) throw new Error(`${LABEL}: save() não cria negociação (ela nasce com o card, por commit)`);
    await commit({ mode: 'update', negotiation, expectedUpdatedAt: current.atualizadoEm });
    return negotiation;
  }

  return Object.freeze({ list, getById, save, commit });
}

module.exports = { createSupabaseNegotiationRepository, NEGOTIATION_REPOSITORY_ERROR, TABLES, COMMIT_RPC };
