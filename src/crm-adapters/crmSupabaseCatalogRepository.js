// Adapter Postgres/Supabase dos CATÁLOGOS do CRM — Serviços, Nichos e Origens dos Leads (CRM 5.0, Fase 2B-1, decisão 0026). O adapter
// de PRODUÇÃO da porta de src/crm/catalogRepositoryPort.js, ao lado de crmSupabaseRepository.js: mesma árvore (src/crm-adapters/),
// mesmas regras (R15/R16: o domínio não conhece este diretório e este não importa src/crm/, src/auth, src/services nem src/server).
//
// Fala PostgREST DIRETO por `fetch` nativo — nunca importa o SDK do Supabase (só src/auth/authAdapter.js pode, regra R7). `fetchImpl`
// é SEMPRE injetável e é o que os testes fazem (tests/crm-adapters/crmSupabaseCatalogRepository.test.js nunca chama a rede real).
//
// AS TRÊS TABELAS (migration 20261012090000_crm_catalogs.sql — NÃO APLICADA por este código nem por nenhum teste): crm_services,
// crm_niches e crm_lead_origins. Um mesmo código atende as três por um mapa de colunas.
//
// CONTRATO DE ERRO (comum entre adapters — ver catalogRepositoryPort.js): só dois casos recebem `code`, e só quando o Postgres os
// sinaliza de forma INEQUÍVOCA: violação de UNICIDADE do nome normalizado (índice único `*_nome_normalizado_key`) -> DUPLICATE_NAME, que é a proteção contra
// duas criações concorrentes MESMO ENTRE PROCESSOS; e a função de reordenação que acusa item inexistente -> NOT_FOUND. Qualquer outra
// falha (rede, tabela ausente, permissão, 5xx, um CHECK violado) sai SEM `code`, e o domínio a trata como falha de armazenamento. As
// duas strings abaixo são uma CÓPIA literal da porta (R16 impede importá-la); um teste vigia que não divergem.
//
// SEGREDO: a service_role key fica só em memória, só no cabeçalho Authorization de cada requisição — nunca logada, nunca numa mensagem
// de erro (os erros citam só o status HTTP e a mensagem que o PostgREST devolveu).
//
// `updated_at` e REORDENAÇÃO: um gatilho do banco atualiza `updated_at` a cada UPDATE, então este adapter NÃO envia `atualizadoEm` em
// um update (o valor devolvido é o do banco). A reordenação chama a função SQL `reorder_crm_catalog` por RPC — atômica: ou todas as
// posições mudam, ou nenhuma — em vez de N PATCHes soltos.

const { readSupabaseCrmConfig } = require('./crmSupabaseConfig');

const REQUEST_TIMEOUT_MS = 15000;
const REORDER_RPC = 'reorder_crm_catalog';

const CATALOG_REPOSITORY_ERROR = Object.freeze({
  DUPLICATE_NAME: 'CRM_CATALOG_REPOSITORY_DUPLICATE_NAME',
  NOT_FOUND: 'CRM_CATALOG_REPOSITORY_NOT_FOUND',
});

// camelCase do item -> coluna. Os campos comuns são iguais nas três tabelas; os específicos mudam.
const COMMON_COLUMNS = Object.freeze({
  id: 'id',
  nome: 'nome',
  nomeNormalizado: 'nome_normalizado',
  descricao: 'descricao',
  ativo: 'ativo',
  ordem: 'ordem',
  criadoEm: 'created_at',
  atualizadoEm: 'updated_at',
  criadoPorUserId: 'created_by_user_id',
  criadoPorNome: 'created_by_name',
  atualizadoPorUserId: 'updated_by_user_id',
  atualizadoPorNome: 'updated_by_name',
});
// Os campos comuns que um UPDATE pode alterar (o resto — id, criado* — nunca muda depois da criação).
const UPDATABLE_COMMON = Object.freeze(['nome', 'nomeNormalizado', 'descricao', 'ativo', 'ordem', 'atualizadoEm', 'atualizadoPorUserId', 'atualizadoPorNome']);

const CATALOG_TABLES = Object.freeze({
  servicos: Object.freeze({
    table: 'crm_services',
    specific: Object.freeze({ categoria: 'categoria', precoReferencia: 'preco_referencia', tipoCobranca: 'tipo_cobranca', recorrencia: 'recorrencia' }),
  }),
  nichos: Object.freeze({ table: 'crm_niches', specific: Object.freeze({ cor: 'cor' }) }),
  origens: Object.freeze({ table: 'crm_lead_origins', specific: Object.freeze({ canal: 'canal' }) }),
});

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function tableOf(catalog) {
  if (typeof catalog !== 'string' || !hasOwn(CATALOG_TABLES, catalog)) throw new Error(`Cadastro (Supabase): catálogo desconhecido: ${String(catalog)}`);
  return CATALOG_TABLES[catalog];
}

function requireId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('Cadastro (Supabase): id deve ser um texto não vazio');
  if (UNSAFE_IDS.has(id)) throw new Error(`Cadastro (Supabase): id não permitido: ${id}`);
  return id;
}

// timestamptz do Postgres ("2026-10-12T12:00:00.123456+00:00") -> ISO 8601 em UTC com milissegundos, o formato do domínio.
function toIso(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// NUMERIC pode voltar como número ou como texto numérico, conforme a configuração do PostgREST.
function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function rowToItem(catalog, row) {
  const { specific } = tableOf(catalog);
  const item = {
    id: row.id,
    nome: row.nome,
    nomeNormalizado: row.nome_normalizado,
    descricao: row.descricao ?? null,
    ativo: row.ativo === true,
    ordem: toNumberOrNull(row.ordem),
    criadoEm: toIso(row.created_at),
    atualizadoEm: toIso(row.updated_at),
    criadoPorUserId: row.created_by_user_id ?? null,
    criadoPorNome: row.created_by_name ?? null,
    atualizadoPorUserId: row.updated_by_user_id ?? null,
    atualizadoPorNome: row.updated_by_name ?? null,
  };
  for (const [field, column] of Object.entries(specific)) item[field] = field === 'precoReferencia' ? toNumberOrNull(row[column]) : (row[column] ?? null);
  return item;
}

function itemToRow(catalog, item) {
  const { specific } = tableOf(catalog);
  const row = {};
  for (const [field, column] of Object.entries(COMMON_COLUMNS)) if (hasOwn(item, field) && item[field] !== undefined) row[column] = item[field];
  for (const [field, column] of Object.entries(specific)) if (hasOwn(item, field) && item[field] !== undefined) row[column] = item[field];
  return row;
}

// O patch (camelCase) vira colunas — SÓ as chaves conhecidas deste catálogo; qualquer outra é um erro de programação (o mesmo
// contrato do adapter de arquivo). `atualizadoEm` não é enviado: quem o define é o gatilho do banco.
function patchToRow(catalog, patch) {
  const { specific } = tableOf(catalog);
  const row = {};
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'atualizadoEm') continue;
    if (UPDATABLE_COMMON.includes(field)) row[COMMON_COLUMNS[field]] = value;
    else if (hasOwn(specific, field)) row[specific[field]] = value;
    else throw new Error(`Cadastro (Supabase): update() recebeu um campo que não pode ser alterado neste catálogo: ${field}`);
  }
  return row;
}

// Classifica SÓ o que o Postgres sinaliza de forma inequívoca (ver o cabeçalho). Nada por adivinhação de texto além do NOME da
// restrição/função, que é fixo na migration.
function classifyFailure(status, json) {
  const code = json && typeof json.code === 'string' ? json.code : null;
  const text = `${json && typeof json.message === 'string' ? json.message : ''} ${json && typeof json.details === 'string' ? json.details : ''}`;
  if ((status === 409 || code === '23505') && /nome_normalizado/.test(text)) return CATALOG_REPOSITORY_ERROR.DUPLICATE_NAME;
  if (code === 'P0001' && /inexistente/.test(text)) return CATALOG_REPOSITORY_ERROR.NOT_FOUND;
  return null;
}

async function postgrest(config, { method, path, query, body, prefer }, fetchImpl) {
  const url = new URL(config.url + path);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers = { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  let response;
  try {
    response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    // nunca repete a mensagem bruta do erro de rede — só o tipo.
    throw new Error(`Cadastro (Supabase): falha de rede ao falar com o PostgREST (${error && error.name ? error.name : 'erro desconhecido'}).`);
  }
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // resposta que não é JSON (ex.: página de erro de um proxy): o texto NUNCA é repassado.
    }
  }
  if (!response.ok) {
    const detail = json && typeof json.message === 'string' ? json.message : `HTTP ${response.status}`;
    const failure = new Error(`Cadastro (Supabase): PostgREST recusou a operação (${detail}).`);
    const classified = classifyFailure(response.status, json);
    if (classified) failure.code = classified;
    throw failure;
  }
  return json;
}

// options: { url, serviceRoleKey } (config explícita, senão lida de `env` por readSupabaseCrmConfig — exige AS DUAS variáveis),
// { env } e { fetchImpl } (padrão: o fetch global; sempre injetável).
function createSupabaseCatalogRepository(options = {}) {
  const { fetchImpl = fetch } = options;
  if (typeof fetchImpl !== 'function') throw new Error('Cadastro (Supabase): fetchImpl deve ser uma função.');
  const hasExplicitConfig = typeof options.url === 'string' && options.url.length > 0 && typeof options.serviceRoleKey === 'string' && options.serviceRoleKey.length > 0;
  const config = hasExplicitConfig ? Object.freeze({ url: options.url.replace(/\/+$/, ''), serviceRoleKey: options.serviceRoleKey }) : readSupabaseCrmConfig(options.env || process.env);

  async function list(catalog) {
    const { table } = tableOf(catalog);
    const rows = await postgrest(config, { method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', order: 'ordem.asc,nome_normalizado.asc,id.asc' } }, fetchImpl);
    return Array.isArray(rows) ? rows.map((row) => rowToItem(catalog, row)) : [];
  }

  async function getById(catalog, id) {
    const { table } = tableOf(catalog);
    requireId(id);
    const rows = await postgrest(config, { method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', id: `eq.${id}`, limit: '1' } }, fetchImpl);
    return Array.isArray(rows) && rows.length > 0 ? rowToItem(catalog, rows[0]) : null;
  }

  async function insert(catalog, item) {
    const { table } = tableOf(catalog);
    if (!isPlainObject(item)) throw new Error('Cadastro (Supabase): insert() exige um item (objeto)');
    requireId(item.id);
    const rows = await postgrest(config, { method: 'POST', path: `/rest/v1/${table}`, body: itemToRow(catalog, item), prefer: 'return=representation' }, fetchImpl);
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Cadastro (Supabase): o PostgREST não devolveu o item gravado.');
    return rowToItem(catalog, rows[0]);
  }

  async function update(catalog, id, patch) {
    const { table } = tableOf(catalog);
    requireId(id);
    if (!isPlainObject(patch)) throw new Error('Cadastro (Supabase): update() exige um patch (objeto)');
    const row = patchToRow(catalog, patch);
    if (Object.keys(row).length === 0) return getById(catalog, id);
    const rows = await postgrest(config, { method: 'PATCH', path: `/rest/v1/${table}`, query: { id: `eq.${id}` }, body: row, prefer: 'return=representation' }, fetchImpl);
    return Array.isArray(rows) && rows.length > 0 ? rowToItem(catalog, rows[0]) : null;
  }

  async function reorder(catalog, orderedIds, meta) {
    tableOf(catalog);
    if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) throw new Error('Cadastro (Supabase): reorder() exige uma lista de ids (texto)');
    orderedIds.forEach(requireId);
    const actor = isPlainObject(meta) ? meta : {};
    await postgrest(
      config,
      {
        method: 'POST',
        path: `/rest/v1/rpc/${REORDER_RPC}`,
        body: { p_catalog: catalog, p_ordered_ids: orderedIds, p_actor_user_id: actor.atualizadoPorUserId ?? null, p_actor_name: actor.atualizadoPorNome ?? null },
      },
      fetchImpl
    );
  }

  return Object.freeze({ list, getById, insert, update, reorder });
}

module.exports = { createSupabaseCatalogRepository, CATALOG_TABLES, CATALOG_REPOSITORY_ERROR, COMMON_COLUMNS, UPDATABLE_COMMON, REORDER_RPC };
