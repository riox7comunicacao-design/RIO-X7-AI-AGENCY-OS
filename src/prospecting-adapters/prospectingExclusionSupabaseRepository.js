// Adapter Postgres/Supabase das EXCLUSÕES PERMANENTES de prospecção (Workbench, Etapa 2) — o adapter OFICIAL de
// produção desta funcionalidade (decisão explícita do proprietário: nunca um arquivo JSON como fonte oficial).
// Vive numa árvore PRÓPRIA (src/prospecting-adapters/, irmã de src/crm-adapters/) e não dentro do diretório dos
// adaptadores de busca web do Researcher — aquela árvore tem guardas próprias (nenhum uso de variável de
// ambiente, só módulos irmãos) que não fazem sentido para um adapter de PERSISTÊNCIA como este.
//
// Mesmo desenho de src/crm-adapters/crmSupabaseRepository.js: fala PostgREST DIRETO por `fetch` nativo (nunca
// importa o SDK do Supabase — só src/auth/authAdapter.js pode). Por isso a leitura de configuração (SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY) é uma cópia PRÓPRIA, independente do adapter do CRM — mesmo princípio já documentado
// lá ("os dois adapters são independentes, um não deve depender de um detalhe interno do outro").
//
// CONTRATO: implementa { list, getById, insert, update } da porta de exclusões permanentes — todas assíncronas.
// NUNCA um DELETE: não existe método de exclusão física nesta tabela nem neste adapter (seção 5 do comando).
//
// SEGREDO: a service_role key fica só em memória, só neste processo, só no cabeçalho Authorization de cada
// requisição — nunca logada, nunca em uma mensagem de erro.

const TABLE = 'prospecting_permanent_exclusions';
const REQUEST_TIMEOUT_MS = 15000;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

// Cópia independente de readSupabaseCrmConfig (ver o cabeçalho) — as MESMAS duas variáveis de ambiente, lidas de
// novo aqui de propósito.
function readConfig(env = process.env) {
  const rawUrl = env && isNonEmptyString(env.SUPABASE_URL) ? env.SUPABASE_URL.trim() : '';
  if (!rawUrl) throw new Error('Exclusão Permanente (Supabase): SUPABASE_URL não está configurada.');
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Exclusão Permanente (Supabase): SUPABASE_URL não é uma URL válida.');
  }
  if (parsed.protocol !== 'https:') throw new Error('Exclusão Permanente (Supabase): SUPABASE_URL deve ser https.');
  const serviceRoleKey = env && isNonEmptyString(env.SUPABASE_SERVICE_ROLE_KEY) ? env.SUPABASE_SERVICE_ROLE_KEY.trim() : '';
  if (!serviceRoleKey) throw new Error('Exclusão Permanente (Supabase): SUPABASE_SERVICE_ROLE_KEY não está configurada.');
  return Object.freeze({ url: rawUrl.replace(/\/+$/, ''), serviceRoleKey });
}

function rowToExclusion(row) {
  return {
    id: row.id,
    empresa: row.empresa_nome,
    empresaNomeNormalizado: row.empresa_nome_normalizado,
    cidade: row.cidade ?? null,
    estado: row.estado ?? null,
    pais: row.pais ?? null,
    dominio: row.dominio ?? null,
    motivo: row.motivo,
    ativo: row.ativo === true,
    criadoEm: row.created_at ?? null,
    atualizadoEm: row.updated_at ?? null,
    criadoPorUserId: row.created_by_user_id ?? null,
    criadoPorNome: row.created_by_name ?? null,
  };
}

function exclusionToInsertRow(exclusao) {
  return {
    // O id é gerado pela APLICAÇÃO (mesma convenção do resto do projeto — crm_records, funis, cards — nunca só
    // pelo banco); a coluna mantém DEFAULT gen_random_uuid() só como rede de segurança para um insert direto.
    ...(typeof exclusao.id === 'string' && exclusao.id ? { id: exclusao.id } : {}),
    empresa_nome: exclusao.empresa,
    empresa_nome_normalizado: exclusao.empresaNomeNormalizado,
    cidade: exclusao.cidade ?? null,
    estado: exclusao.estado ?? null,
    pais: exclusao.pais ?? 'Brasil',
    dominio: exclusao.dominio ?? null,
    motivo: exclusao.motivo,
    ativo: exclusao.ativo !== false,
    created_by_user_id: exclusao.criadoPorUserId ?? null,
    created_by_name: exclusao.criadoPorNome ?? null,
  };
}

// O mesmo patch (camelCase) vira colunas — só as chaves conhecidas viram coluna; nada mais é aceito.
const PATCH_COLUMN = Object.freeze({
  empresa: 'empresa_nome',
  empresaNomeNormalizado: 'empresa_nome_normalizado',
  cidade: 'cidade',
  estado: 'estado',
  pais: 'pais',
  dominio: 'dominio',
  motivo: 'motivo',
  ativo: 'ativo',
});
function patchToRow(patch) {
  const row = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (Object.prototype.hasOwnProperty.call(PATCH_COLUMN, key)) row[PATCH_COLUMN[key]] = value;
  }
  return row;
}

async function postgrest(config, { method, path, query, body }, fetchImpl) {
  const url = new URL(config.url + path);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers = { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  headers.Prefer = body !== undefined ? 'return=representation' : headers.Prefer;

  let response;
  try {
    response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Exclusão Permanente (Supabase): falha de rede ao falar com o PostgREST (${error && error.name ? error.name : 'erro desconhecido'}).`);
  }
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // resposta não-JSON: json fica null; o texto nunca é repassado.
    }
  }
  if (!response.ok) {
    const detalhe = json && typeof json.message === 'string' ? json.message : `HTTP ${response.status}`;
    throw new Error(`Exclusão Permanente (Supabase): PostgREST recusou a operação (${detalhe}).`);
  }
  return json;
}

// options: { url, serviceRoleKey } explícitos (testes) OU { env } de onde ler; { fetchImpl } sempre injetável.
function createSupabaseProspectingExclusionRepository(options = {}) {
  const { fetchImpl = fetch, table = TABLE } = options;
  if (typeof fetchImpl !== 'function') throw new Error('Exclusão Permanente (Supabase): fetchImpl deve ser uma função.');
  const hasExplicit = isNonEmptyString(options.url) && isNonEmptyString(options.serviceRoleKey);
  const config = hasExplicit ? Object.freeze({ url: options.url.replace(/\/+$/, ''), serviceRoleKey: options.serviceRoleKey }) : readConfig(options.env || process.env);

  async function list() {
    const rows = await postgrest(config, { method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', order: 'created_at.desc' } }, fetchImpl);
    return Array.isArray(rows) ? rows.map(rowToExclusion) : [];
  }

  async function getById(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    const rows = await postgrest(config, { method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', id: `eq.${id}`, limit: '1' } }, fetchImpl);
    return Array.isArray(rows) && rows.length > 0 ? rowToExclusion(rows[0]) : null;
  }

  async function insert(exclusao) {
    if (!exclusao || typeof exclusao !== 'object') throw new Error('Exclusão Permanente: insert() exige um objeto');
    const rows = await postgrest(config, { method: 'POST', path: `/rest/v1/${table}`, body: [exclusionToInsertRow(exclusao)] }, fetchImpl);
    return Array.isArray(rows) && rows.length > 0 ? rowToExclusion(rows[0]) : null;
  }

  async function update(id, patch) {
    if (typeof id !== 'string' || !id) throw new Error('Exclusão Permanente: update() exige um id (texto não vazio)');
    const rows = await postgrest(config, { method: 'PATCH', path: `/rest/v1/${table}`, query: { id: `eq.${id}` }, body: patchToRow(patch) }, fetchImpl);
    return Array.isArray(rows) && rows.length > 0 ? rowToExclusion(rows[0]) : null;
  }

  return Object.freeze({ list, getById, insert, update });
}

module.exports = { createSupabaseProspectingExclusionRepository, TABLE };
