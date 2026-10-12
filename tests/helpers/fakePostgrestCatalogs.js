// Um PostgREST FALSO para os testes do adapter Supabase dos catálogos do CRM (src/crm-adapters/crmSupabaseCatalogRepository.js). NÃO é um
// arquivo de teste (sem *.test.js: node --test não o executa sozinho). Nunca toca a rede: é um `fetchImpl` que entende só o que o adapter
// usa e emula as garantias do banco que a migration 20261012090000_crm_catalogs.sql promete:
//   - UNICIDADE de nome_normalizado por tabela (409 + código 23505, "duplicate key value violates unique constraint ..."), contando os
//     itens desativados, e unicidade da chave primária;
//   - o GATILHO de updated_at (em todo UPDATE, inclusive os do RPC) — com um relógio falso monotônico, DIFERENTE do que o cliente mandou;
//   - o formato do Postgres para timestamptz ("2026-10-12T12:00:00.123456+00:00"), que o adapter precisa normalizar;
//   - o RPC reorder_crm_catalog (lista vazia, ids repetidos, catálogo desconhecido e id inexistente -> P0001; só as linhas cuja ordem muda
//     são atualizadas);
//   - o filtro `id=eq.<id>`, `limit` e a ordenação pedida em `order`.
// Registra cada chamada (método, URL, cabeçalhos, corpo) em `calls`, para os testes conferirem o que o adapter envia.

const TABLES = Object.freeze({
  crm_services: Object.freeze({ idPrefix: 'service' }),
  crm_niches: Object.freeze({ idPrefix: 'niche' }),
  crm_lead_origins: Object.freeze({ idPrefix: 'origin' }),
});
const CATALOG_TABLE = Object.freeze({ servicos: 'crm_services', nichos: 'crm_niches', origens: 'crm_lead_origins' });

function createFakePostgrestCatalogs({ url = 'https://exemplo-teste.supabase.co', serviceRoleKey = 'chave-de-servico-falsa-so-para-teste', numericAsString = false, startAt = '2026-10-12T13:00:00.000Z' } = {}) {
  const tables = { crm_services: new Map(), crm_niches: new Map(), crm_lead_origins: new Map() };
  const calls = [];
  let clock = new Date(startAt).getTime();
  const tick = () => {
    clock += 1000;
    return new Date(clock);
  };

  // "2026-10-12T12:00:00.123Z" -> "2026-10-12T12:00:00.123000+00:00" (o formato de uma coluna timestamptz).
  const asPostgres = (iso) => (typeof iso === 'string' ? iso.replace(/\.(\d{3})Z$/, '.$1000+00:00') : iso);
  const present = (row) => {
    const out = { ...row, created_at: asPostgres(row.created_at), updated_at: asPostgres(row.updated_at) };
    if (out.preco_referencia !== undefined && out.preco_referencia !== null && numericAsString) out.preco_referencia = String(out.preco_referencia);
    return out;
  };

  function reply(status, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  }
  const violation = (constraint, detail) => reply(409, { code: '23505', details: detail, hint: null, message: `duplicate key value violates unique constraint "${constraint}"` });

  function uniqueNameClash(table, row, exceptId) {
    return [...tables[table].values()].find((other) => other.id !== exceptId && other.nome_normalizado === row.nome_normalizado);
  }
  function orderRows(rows, order) {
    if (!order) return rows;
    const keys = order.split(',').map((part) => {
      const [column, direction = 'asc'] = part.split('.');
      return { column, factor: direction === 'desc' ? -1 : 1 };
    });
    return [...rows].sort((a, b) => {
      for (const { column, factor } of keys) {
        if (a[column] < b[column]) return -1 * factor;
        if (a[column] > b[column]) return 1 * factor;
      }
      return 0;
    });
  }

  async function fetchImpl(requestUrl, init = {}) {
    const target = new URL(String(requestUrl));
    const method = init.method || 'GET';
    const headers = init.headers || {};
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, url: target.toString(), path: target.pathname, query: Object.fromEntries(target.searchParams), headers: { ...headers }, body });

    if (target.origin !== new URL(url).origin) return reply(404, { message: 'origem inesperada' });
    if (headers.apikey !== serviceRoleKey || headers.Authorization !== `Bearer ${serviceRoleKey}`) return reply(401, { message: 'JWT inválido' });

    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(target.pathname);
    if (rpc) {
      if (rpc[1] !== 'reorder_crm_catalog' || method !== 'POST') return reply(404, { code: 'PGRST202', message: 'Could not find the function' });
      const { p_catalog: catalog, p_ordered_ids: ids, p_actor_user_id: actorId, p_actor_name: actorName } = body;
      const p0001 = (message) => reply(400, { code: 'P0001', details: null, hint: null, message });
      if (!Array.isArray(ids) || ids.length === 0) return p0001('reorder_crm_catalog: lista de ids vazia');
      if (new Set(ids).size !== ids.length) return p0001('reorder_crm_catalog: ids repetidos');
      const table = CATALOG_TABLE[catalog];
      if (!table) return p0001('reorder_crm_catalog: catálogo desconhecido');
      if (!ids.every((id) => tables[table].has(id))) return p0001('reorder_crm_catalog: item inexistente');
      const now = tick().toISOString();
      ids.forEach((id, position) => {
        const row = tables[table].get(id);
        if (row.ordem === position) return;
        tables[table].set(id, { ...row, ordem: position, updated_by_user_id: actorId, updated_by_name: actorName, updated_at: now });
      });
      return reply(204);
    }

    const rest = /^\/rest\/v1\/([a-z_]+)$/.exec(target.pathname);
    if (!rest || !TABLES[rest[1]]) return reply(404, { code: 'PGRST205', message: `Could not find the table 'public.${rest ? rest[1] : '?'}'` });
    const table = rest[1];
    const idFilter = target.searchParams.get('id');
    const wantedId = idFilter && idFilter.startsWith('eq.') ? idFilter.slice(3) : null;

    if (method === 'GET') {
      let rows = [...tables[table].values()];
      if (wantedId !== null) rows = rows.filter((row) => row.id === wantedId);
      rows = orderRows(rows, target.searchParams.get('order'));
      const limit = Number(target.searchParams.get('limit'));
      if (Number.isInteger(limit) && limit > 0) rows = rows.slice(0, limit);
      return reply(200, rows.map(present));
    }

    if (method === 'POST') {
      const row = { ...body };
      if (typeof row.id !== 'string' || !new RegExp(`^${TABLES[table].idPrefix}:[0-9a-f-]{36}$`).test(row.id)) return reply(400, { code: '23514', message: `new row for relation "${table}" violates check constraint "${table}_id_check"` });
      if (typeof row.nome !== 'string' || typeof row.nome_normalizado !== 'string') return reply(400, { code: '23502', message: 'null value in column violates not-null constraint' });
      if (tables[table].has(row.id)) return violation(`${table}_pkey`, `Key (id)=(${row.id}) already exists.`);
      if (uniqueNameClash(table, row, null)) return violation(`${table}_nome_normalizado_key`, `Key (nome_normalizado)=(${row.nome_normalizado}) already exists.`);
      const now = tick().toISOString();
      const stored = { ativo: true, ordem: 0, created_at: now, updated_at: now, ...row };
      tables[table].set(stored.id, stored);
      return reply(201, [present(stored)]);
    }

    if (method === 'PATCH') {
      if (wantedId === null) return reply(400, { message: 'PATCH sem filtro de id' });
      const current = tables[table].get(wantedId);
      if (!current) return reply(200, []);
      const merged = { ...current, ...body };
      if (body.nome_normalizado !== undefined && uniqueNameClash(table, merged, wantedId)) return violation(`${table}_nome_normalizado_key`, `Key (nome_normalizado)=(${merged.nome_normalizado}) already exists.`);
      // o gatilho: updated_at é do BANCO, nunca o que o cliente mandou
      merged.updated_at = tick().toISOString();
      tables[table].set(wantedId, merged);
      return reply(200, [present(merged)]);
    }

    return reply(405, { message: 'método não suportado pelo falso' });
  }

  return { fetchImpl, calls, tables, url, serviceRoleKey, tick };
}

module.exports = { createFakePostgrestCatalogs, CATALOG_TABLE };
