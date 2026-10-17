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

// Uma requisição ao PostgREST: devolve { json, response }. `prefer` (opcional) é o valor do cabeçalho Prefer — só é enviado quando existe.
// As mensagens de erro nunca repetem o corpo da resposta (nem a mensagem do PostgREST): só o status HTTP ou o tipo da falha de rede.
async function send(config, { method, path, query, body, prefer }, fetchImpl) {
  const url = new URL(config.url + path);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers = { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (body !== undefined) headers.Prefer = 'return=representation';
  else if (prefer !== undefined) headers.Prefer = prefer;

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
    throw new Error(`Exclusão Permanente (Supabase): PostgREST recusou a operação (HTTP ${response.status}).`);
  }
  return { json, response };
}

async function postgrest(config, spec, fetchImpl) {
  return (await send(config, spec, fetchImpl)).json;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// LEITURA COMPLETA DA LISTA (Fase 2B-3.2B). Quem consulta as exclusões para DECIDIR (a promoção) precisa saber que a lista veio INTEIRA:
// um PostgREST limita as linhas por resposta (padrão 1000, configurável), e uma lista cortada em silêncio seria lida como "nada
// bate". Por isso a leitura:
//   - é paginada (limit/offset, ordem estável por created_at e id) e pede o total exato (Prefer: count=exact), que volta no
//     cabeçalho Content-Range ("0-499/1234", ou "*/0" quando a tabela está vazia);
//   - só termina quando o número de linhas lidas é IGUAL a esse total, e o total tem de ser o mesmo em todas as páginas;
//   - não aceita nada que não seja uma lista de objetos com a forma esperada, nem uma faixa que contradiga o que foi pedido, nem um
//     id repetido, nem um total que não dá para confirmar (Content-Range ausente ou "0-24/*");
//   - não tenta adivinhar: qualquer dúvida é um ERRO, e quem chama (o Service) a trata como "consulta indisponível".
// Nada disso é exercitado contra o Supabase REAL nesta etapa (só com um fetch falso): ver o relatório da 2B-3.2B.
// ---------------------------------------------------------------------------------------------------------------------------------
const PAGE_SIZE = 500;
const MAX_ROWS = 10000; // acima disso a lista não é lida (nunca "metade da lista")
const MAX_PAGES = 100; // teto de segurança contra um servidor que devolve páginas minúsculas para sempre

function listError(reason) {
  return new Error(`Exclusão Permanente (Supabase): a lista de exclusões não pôde ser lida por completo (${reason}).`);
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// "0-499/1234" -> { start: 0, end: 499, total: 1234 }; "*/0" -> { start: null, end: null, total: 0 }; qualquer outra forma (inclusive "0-24/*") -> null.
function parseContentRange(value) {
  if (typeof value !== 'string') return null;
  const found = /^(?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(value.trim());
  if (!found) return null;
  const total = Number(found[3]);
  if (found[1] === undefined) return { start: null, end: null, total };
  const start = Number(found[1]);
  const end = Number(found[2]);
  return end >= start ? { start, end, total } : null;
}

// A forma mínima de uma linha: o que o resto do sistema lê para decidir (id, nome, nome normalizado, ativo).
function isExclusionRow(row) {
  return (
    isPlainObject(row) &&
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.empresa_nome === 'string' &&
    typeof row.empresa_nome_normalizado === 'string' &&
    typeof row.ativo === 'boolean'
  );
}

// options: { url, serviceRoleKey } explícitos (testes) OU { env } de onde ler; { fetchImpl } sempre injetável.
function createSupabaseProspectingExclusionRepository(options = {}) {
  const { fetchImpl = fetch, table = TABLE } = options;
  if (typeof fetchImpl !== 'function') throw new Error('Exclusão Permanente (Supabase): fetchImpl deve ser uma função.');
  const hasExplicit = isNonEmptyString(options.url) && isNonEmptyString(options.serviceRoleKey);
  const config = hasExplicit ? Object.freeze({ url: options.url.replace(/\/+$/, ''), serviceRoleKey: options.serviceRoleKey }) : readConfig(options.env || process.env);

  // TODAS as exclusões (ativas e inativas), ou um erro — nunca uma parte delas e nunca "vazio" por uma resposta que não é uma lista.
  async function list() {
    const rows = [];
    const seen = new Set();
    let total = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const offset = rows.length;
      const { json, response } = await send(
        config,
        { method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', order: 'created_at.desc,id.asc', limit: String(PAGE_SIZE), offset: String(offset) }, prefer: 'count=exact' },
        fetchImpl
      );
      if (!Array.isArray(json)) throw listError('a resposta não é uma lista');
      const header = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-range') : null;
      const range = parseContentRange(header);
      if (range === null) throw listError('o total de exclusões não pôde ser confirmado');
      if (total === null) total = range.total;
      else if (range.total !== total) throw listError('o total mudou durante a leitura');
      if (total > MAX_ROWS) throw listError('há exclusões demais para uma leitura segura');

      if (json.length === 0) {
        if (rows.length !== total) throw listError('a leitura terminou antes do total');
        break;
      }
      // a faixa que o servidor diz ter devolvido tem de ser exatamente a que foi pedida e a que chegou
      if (range.start !== offset || range.end !== offset + json.length - 1) throw listError('a faixa devolvida não confere com a pedida');
      for (const row of json) {
        if (!isExclusionRow(row)) throw listError('uma linha tem formato inesperado');
        if (seen.has(row.id)) throw listError('uma exclusão apareceu duas vezes');
        seen.add(row.id);
        rows.push(row);
      }
      if (rows.length > total) throw listError('vieram mais linhas do que o total');
      if (rows.length === total) break;
    }
    if (total === null || rows.length !== total) throw listError('a leitura não chegou ao total');
    return rows.map(rowToExclusion);
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
