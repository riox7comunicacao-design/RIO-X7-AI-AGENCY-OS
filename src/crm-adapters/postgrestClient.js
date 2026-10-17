// Cliente PostgREST mínimo e COMPARTILHADO pelos adapters comerciais (Funis e Negociações — CRM 5.0, Fase D1.1, decisão 0029). Fala PostgREST DIRETO por `fetch` nativo (nunca o SDK do
// Supabase: só src/auth/authAdapter.js pode importá-lo, regra R7); `fetchImpl` é SEMPRE injetável e é o que os testes fazem — nenhum teste chama a rede real. Mesmas regras de
// src/crm-adapters/: o domínio não conhece este diretório e este não importa src/crm/, src/auth, src/services nem src/server (regras R15/R16).
//
// SEGREDO: a service_role key fica só em memória, só no cabeçalho de cada requisição — nunca logada, nunca numa mensagem de erro. As mensagens de erro citam só o rótulo do adapter e o
// status HTTP (nunca o corpo, nunca a mensagem do PostgREST: poderia citar dados comerciais).
//
// LEITURA COMPLETA (mesma política da Fase H3.2 do CRM): `readAll` é paginada (limit/offset) e pede o total exato (Prefer: count=exact → Content-Range "0-499/1234", "*/0" se vazia); só termina
// quando o número de linhas lidas é IGUAL ao total (e o total é o mesmo em todas as páginas); confere a faixa devolvida; recusa linha com formato inesperado e `id` repetido; nunca devolve
// uma lista PARCIAL e nunca "vazio" por uma resposta que não é uma lista — qualquer dúvida é um ERRO (quem chama o trata como falha da operação, nunca como "não há nada").
// SEM SNAPSHOT entre as páginas: uma gravação no meio da leitura costuma mudar o total e a leitura falha — mas não se afirma que toda alteração concorrente seja detectável.

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_ROWS = 10000;

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

// options: { url, serviceRoleKey, fetchImpl, label } — `label` abre as mensagens de erro ("Funis (Supabase)").
function createPostgrestClient({ url, serviceRoleKey, fetchImpl, label }) {
  if (typeof url !== 'string' || url.length === 0 || typeof serviceRoleKey !== 'string' || serviceRoleKey.length === 0) throw new Error(`${label}: configuração do Supabase incompleta.`);
  if (typeof fetchImpl !== 'function') throw new Error(`${label}: fetchImpl deve ser uma função.`);
  const base = url.replace(/\/+$/, '');

  // Uma chamada. Devolve { json, response }. `classify(status, json)` (opcional) devolve um `code` estável para as falhas que o Postgres sinaliza de forma INEQUÍVOCA.
  async function request({ method, path, query, body, prefer, safeError = false, classify }) {
    const target = new URL(base + path);
    if (query) for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    let response;
    try {
      response = await fetchImpl(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      // nunca repete a mensagem bruta do erro de rede — só o tipo.
      throw new Error(`${label}: falha de rede ao falar com o PostgREST (${error && error.name ? error.name : 'erro desconhecido'}).`);
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
      const failure = new Error(safeError ? `${label}: PostgREST recusou a leitura (HTTP ${response.status}).` : `${label}: PostgREST recusou a operação (HTTP ${response.status}).`);
      failure.status = response.status;
      const code = typeof classify === 'function' ? classify(response.status, json) : null;
      if (code) failure.code = code;
      throw failure;
    }
    return { json, response };
  }

  function failRead(noun, reason) {
    return new Error(`${label}: ${noun} não puderam ser lidos por completo (${reason}).`);
  }

  // TODAS as linhas (na ordem pedida), ou um erro. `filters`: { coluna: 'eq.valor' } (já no formato do PostgREST). `check(row)`: a forma estrutural mínima (true/false).
  async function readAll({ table, select = '*', order, filters = {}, check, noun, pageSize = DEFAULT_PAGE_SIZE, maxRows = DEFAULT_MAX_ROWS }) {
    const maxPages = Math.ceil(maxRows / pageSize) + 1;
    const rows = [];
    const seen = new Set();
    let total = null;
    for (let page = 0; page < maxPages; page += 1) {
      const offset = rows.length;
      const { json, response } = await request({
        method: 'GET',
        path: `/rest/v1/${table}`,
        query: { select, ...filters, ...(order ? { order } : {}), limit: String(pageSize), offset: String(offset) },
        prefer: 'count=exact',
        safeError: true,
      });
      if (!Array.isArray(json)) throw failRead(noun, 'a resposta não é uma lista');
      const header = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-range') : null;
      const range = parseContentRange(header);
      if (range === null) throw failRead(noun, 'o total não pôde ser confirmado');
      if (total === null) total = range.total;
      else if (range.total !== total) throw failRead(noun, 'o total mudou durante a leitura');
      if (total > maxRows) throw failRead(noun, 'há linhas demais para uma leitura segura');
      if (json.length === 0) {
        if (rows.length !== total) throw failRead(noun, 'a leitura terminou antes do total');
        break;
      }
      if (json.length > pageSize) throw failRead(noun, 'a página veio maior que a pedida');
      if (range.start !== offset || range.end !== offset + json.length - 1) throw failRead(noun, 'a faixa devolvida não confere com a pedida');
      for (const row of json) {
        if (!isPlainObject(row) || (typeof check === 'function' && !check(row))) throw failRead(noun, 'uma linha tem formato inesperado');
        const key = typeof row.id === 'string' ? row.id : null;
        if (key !== null) {
          if (seen.has(key)) throw failRead(noun, 'uma linha apareceu duas vezes');
          seen.add(key);
        }
        rows.push(row);
      }
      if (rows.length > total) throw failRead(noun, 'vieram mais linhas do que o total');
      if (rows.length === total) break;
    }
    if (total === null || rows.length !== total) throw failRead(noun, 'a leitura não chegou ao total');
    return rows;
  }

  // O número de linhas que casam com `filters` (count=exact, sem trazer linhas). Erro se o total não puder ser confirmado — nunca 0 por engano.
  async function countRows({ table, filters = {}, noun }) {
    const { json, response } = await request({ method: 'GET', path: `/rest/v1/${table}`, query: { select: 'id', ...filters, limit: '1' }, prefer: 'count=exact', safeError: true });
    if (!Array.isArray(json)) throw failRead(noun, 'a resposta não é uma lista');
    const header = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-range') : null;
    const range = parseContentRange(header);
    if (range === null) throw failRead(noun, 'o total não pôde ser confirmado');
    return range.total;
  }

  return Object.freeze({ request, readAll, countRows });
}

module.exports = { createPostgrestClient, parseContentRange, DEFAULT_PAGE_SIZE, DEFAULT_MAX_ROWS, isPlainObject };
