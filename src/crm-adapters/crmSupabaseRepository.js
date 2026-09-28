// Adapter Postgres/Supabase do CRM — PREPARAÇÃO (decisão 0024, etapa 2; realocado para src/crm-adapters/ na
// etapa 2.1 — igual ao par research-prospector/research-adapters já existente no projeto, decisão 0022: o
// domínio do CRM, src/crm/, é independente da rede; regras R15/R16 em tests/auth/architecture-boundaries.test.js
// garantem isso na direção certa). NÃO é usado por nenhum caminho de produção/dev hoje: nada em src/server/ o
// importa, nada o inicializa sozinho, nenhum script o chama. O CRM local (data/crm.json, via
// src/crm/crmRepository.js) continua sendo a única persistência realmente usada. Este arquivo existe para que,
// quando a migration 20260927120000_crm_initial_schema.sql for aplicada e a evolução de concorrência
// (docs/decisions/0024, seção "Proposta de evolução...") for decidida, o adapter já exista — testado inteiramente
// com um `fetch` FALSO (tests/crm-adapters/crmSupabaseRepository.test.js nunca chama a rede real).
//
// Fala PostgREST DIRETO por `fetch` nativo do Node — NÃO importa @supabase/supabase-js: só
// src/auth/authAdapter.js pode importar o SDK (regra R7, tests/auth/architecture-boundaries.test.js), e não há
// necessidade real de SDK aqui — PostgREST é uma API REST simples, sem dependência nova.
//
// CONTRATO: implementa exatamente { list, getById, save } de src/crm/crmRepositoryPort.js (a porta continua no
// domínio — só a IMPLEMENTAÇÃO que fala com a rede mora aqui). As 3 operações são `async` (a porta aceita isso
// desde a decisão 0023 — ver assertValidRepository). `save()` recebe sempre o registro INTEIRO (o domínio nunca
// manda um patch parcial) e faz um upsert por `id` (Prefer: resolution=merge-duplicates) — o mesmo "insere ou
// substitui" do adapter de arquivo, e não devolve nada (return=minimal), como a porta já documenta. NENHUM
// parâmetro de versão esperada existe ainda — ver a pendência D-CONCURRENCY-PORT em docs/decisions/0024.
//
// SEGREDO: a service_role key fica só em memória, só neste processo, só para montar o cabeçalho Authorization
// de cada requisição. Nunca é logada (este arquivo não chama console.*) e nunca aparece em nenhuma mensagem de
// erro lançada por ele — os erros citam status HTTP e a mensagem que o PostgREST devolveu, nunca o cabeçalho.

const { readSupabaseCrmConfig } = require('./crmSupabaseConfig');
const { recordToRow, rowToRecord } = require('./crmSupabaseMapping');

const DEFAULT_TABLE = 'crm_records';
const REQUEST_TIMEOUT_MS = 15000;

// A MESMA proteção que já existe em src/crm/crmRepository.js (save() do adapter de arquivo): um id herdado do
// protótipo do Object nunca é tratado como identificador de registro. Duplicada aqui (em vez de importada) de
// propósito — os dois adapters são independentes, e um não deve depender de um detalhe interno do outro.
const UNSAFE_RECORD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
function assertSafeRecordId(id) {
  if (UNSAFE_RECORD_IDS.has(id)) {
    throw new Error(`CRM: id de registro não permitido: ${id}`);
  }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// CONTRATO DE ERRO COMUM ENTRE ADAPTERS (etapa 3F, corrige o BLOCKER 2 da etapa 3E): src/server/app.js
// (mapErrorToHttp) NUNCA pode importar este arquivo (nem src/crm-adapters/ inteiro — regra R16, e a fronteira
// própria de app.js em [CRM-API-ARCH-1], que fecha sua lista de imports em `../auth`/`./static`). Por isso a
// classificação não pode usar `instanceof` de uma classe daqui — só uma propriedade PLANA e estável em `error`,
// exatamente como já funciona para PROSPECTING_ERROR/PROMOTION_ERROR (src/services/prospectingService.js e
// crmIntegrationService.js): o produtor do erro anexa um `code` de uma lista fechada e documentada; o tradutor
// (app.js) reconhece essa lista por STRING, sem importar nada de volta.
//
// Só dois casos são classificados — os únicos que o Postgres/PostgREST sinalizam de forma INEQUÍVOCA por código,
// nunca por adivinhação de texto: uma violação de restrição de DADO (tipo inválido, NOT NULL, CHECK — vira
// "requisição inválida", 400) e uma violação de UNICIDADE (vira "conflito", 409 — não alcançável hoje, porque
// save() faz upsert e não há nenhuma constraint UNIQUE além da chave primária, mas fica pronta para
// D-IDENTITY-FUTURA, docs/decisions/0024 seção 8). QUALQUER outra coisa — tabela ausente (PGRST205), rede fora,
// permissão negada, um 5xx do Postgres, uma resposta sem "code" reconhecível — fica SEM code: cai no INTERNAL
// genérico de sempre, exatamente o comportamento de HOJE, porque não temos como classificar essas causas sem
// arriscar enganar quem chama (ex.: uma tabela ausente NÃO é "seu registro não existe"). Nunca inclui a mensagem
// do PostgREST nem qualquer dado de negócio no `code` — só um rótulo fixo.
const CRM_REPOSITORY_ERROR = Object.freeze({
  INVALID_REQUEST: 'CRM_REPOSITORY_INVALID_REQUEST',
  CONFLICT: 'CRM_REPOSITORY_CONFLICT',
});
const POSTGRES_VALIDATION_CODES = new Set(['22P02', '23502', '23514']); // invalid_text_representation, not_null_violation, check_violation
const POSTGRES_CONFLICT_CODES = new Set(['23505']); // unique_violation

function classifyPostgrestFailure(status, json) {
  const postgresCode = json && typeof json.code === 'string' ? json.code : null;
  if (status === 409 || POSTGRES_CONFLICT_CODES.has(postgresCode)) return CRM_REPOSITORY_ERROR.CONFLICT;
  if (status === 400 || POSTGRES_VALIDATION_CODES.has(postgresCode)) return CRM_REPOSITORY_ERROR.INVALID_REQUEST;
  return null;
}

// Uma chamada ao PostgREST. `fetchImpl` é SEMPRE injetado por quem cria o repositório (nunca o fetch global
// direto) — ver createSupabaseCrmRepository. Nunca inclui o segredo em nada que possa vazar: só no cabeçalho da
// requisição, nunca no erro lançado.
async function postgrest(config, { method, path, query, body, prefer }, fetchImpl) {
  const url = new URL(config.url + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  const headers = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // nunca repete a mensagem bruta do erro de rede (poderia, em tese, ecoar detalhe de infraestrutura) — só o tipo.
    throw new Error(`CRM (Supabase): falha de rede ao falar com o PostgREST (${error && error.name ? error.name : 'erro desconhecido'}).`);
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // resposta que não é JSON (ex.: página de erro HTML de um proxy): json fica null, o texto NUNCA é repassado
      // (poderia conter qualquer coisa) — o erro abaixo cita só o status HTTP nesse caso.
    }
  }
  if (!response.ok) {
    const detalhe = json && typeof json.message === 'string' ? json.message : `HTTP ${response.status}`;
    const erro = new Error(`CRM (Supabase): PostgREST recusou a operação (${detalhe}).`);
    const classificado = classifyPostgrestFailure(response.status, json);
    if (classificado) erro.code = classificado;
    throw erro;
  }
  return json;
}

// options:
//   - { url, serviceRoleKey } — config explícita (testes, ou uma composição futura que já tenha os valores em
//     mãos). Se QUALQUER um dos dois faltar aqui, a config é lida do ambiente (nunca um "modo parcial" misturado).
//   - { env } — de onde ler quando a config não veio explícita (padrão: process.env). Lido por
//     readSupabaseCrmConfig(), que exige AS DUAS variáveis — nunca cria o repositório com metade da configuração.
//   - { fetchImpl } — padrão o `fetch` global do Node; SEMPRE injetável, e é isso que os testes fazem (nunca
//     chamam rede real).
//   - { table } — padrão 'crm_records' (o nome real da migration); só para teste/depuração trocar.
function createSupabaseCrmRepository(options = {}) {
  const { fetchImpl = fetch, table = DEFAULT_TABLE } = options;
  if (typeof fetchImpl !== 'function') {
    throw new Error('CRM (Supabase): fetchImpl deve ser uma função.');
  }
  const hasExplicitConfig = typeof options.url === 'string' && options.url.length > 0 && typeof options.serviceRoleKey === 'string' && options.serviceRoleKey.length > 0;
  const config = hasExplicitConfig
    ? Object.freeze({ url: options.url.replace(/\/+$/, ''), serviceRoleKey: options.serviceRoleKey })
    : readSupabaseCrmConfig(options.env || process.env);

  async function list() {
    const rows = await postgrest(config, { method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', order: 'seq.asc' } }, fetchImpl);
    return Array.isArray(rows) ? rows.map(rowToRecord) : [];
  }

  async function getById(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const rows = await postgrest(
      config,
      { method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', id: `eq.${id}`, limit: '1' } },
      fetchImpl
    );
    return Array.isArray(rows) && rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  async function save(record) {
    if (!isPlainObject(record) || typeof record.id !== 'string' || !record.id) {
      throw new Error('CRM: save() exige um registro com id');
    }
    assertSafeRecordId(record.id);
    await postgrest(
      config,
      { method: 'POST', path: `/rest/v1/${table}`, body: [recordToRow(record)], prefer: 'resolution=merge-duplicates,return=minimal' },
      fetchImpl
    );
  }

  return Object.freeze({ list, getById, save });
}

module.exports = { createSupabaseCrmRepository, DEFAULT_TABLE, CRM_REPOSITORY_ERROR };
