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
//   - (Fase C1, migration 20261018090000_crm_services_payment_modalities.sql) as COLUNAS de cada tabela: um corpo com uma coluna que não existe é
//     recusado como o PostgREST faz (400, PGRST204); com `schema: 'novo'` (o padrão) crm_services tem permite_pagamento_unico/permite_pagamento_recorrente/
//     periodicidades, com os padrões do banco e as quatro restrições; com `schema: 'antigo'` não tem — gravar essas colunas falha e a leitura não as traz
//     (a TRANSIÇÃO: servidor novo sobre o esquema antigo); as colunas legadas tipo_cobranca/recorrencia existem nos dois, com a restrição antiga;
//   - applyModalitiesMigration(): o UPDATE de preenchimento da migration, sobre as linhas que existem (e o gatilho de updated_at).
// Registra cada chamada (método, URL, cabeçalhos, corpo) em `calls`, para os testes conferirem o que o adapter envia.

const TABLES = Object.freeze({
  crm_services: Object.freeze({ idPrefix: 'service' }),
  crm_niches: Object.freeze({ idPrefix: 'niche' }),
  crm_lead_origins: Object.freeze({ idPrefix: 'origin' }),
});
const CATALOG_TABLE = Object.freeze({ servicos: 'crm_services', nichos: 'crm_niches', origens: 'crm_lead_origins' });

const COMMON_COLUMNS = ['id', 'nome', 'nome_normalizado', 'descricao', 'ativo', 'ordem', 'created_at', 'updated_at', 'created_by_user_id', 'created_by_name', 'updated_by_user_id', 'updated_by_name'];
const MODALITY_COLUMNS = ['permite_pagamento_unico', 'permite_pagamento_recorrente', 'periodicidades'];
const columnsOf = (table, schema) => ({
  crm_services: [...COMMON_COLUMNS, 'categoria', 'preco_referencia', 'tipo_cobranca', 'recorrencia', ...(schema === 'novo' ? MODALITY_COLUMNS : [])],
  crm_niches: [...COMMON_COLUMNS, 'cor'],
  crm_lead_origins: [...COMMON_COLUMNS, 'canal'],
}[table]);
const PERIODICITIES = ['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'];

// As restrições de crm_services: devolve o NOME da primeira violada (ou null). As quatro novas só valem no esquema novo; a antiga (tipo/recorrência) vale sempre.
function serviceViolation(row, schema) {
  if (row.tipo_cobranca !== undefined && row.tipo_cobranca !== null && !['UNICA', 'RECORRENTE'].includes(row.tipo_cobranca)) return 'crm_services_tipo_cobranca_check';
  if ((row.tipo_cobranca === 'RECORRENTE') !== (row.recorrencia !== undefined && row.recorrencia !== null)) return 'crm_services_cobranca_coerente';
  if (schema !== 'novo') return null;
  const lista = row.periodicidades;
  if (!Array.isArray(lista) || lista.some((entry) => !PERIODICITIES.includes(entry))) return 'crm_services_periodicidades_validas';
  if (new Set(lista).size !== lista.length) return 'crm_services_periodicidades_sem_repeticao';
  if (row.permite_pagamento_recorrente === true && lista.length === 0) return 'crm_services_recorrente_exige_periodicidade';
  if (row.permite_pagamento_recorrente !== true && lista.length > 0) return 'crm_services_nao_recorrente_sem_periodicidade';
  if (typeof row.permite_pagamento_unico !== 'boolean' || typeof row.permite_pagamento_recorrente !== 'boolean') return 'crm_services_modalidade_nao_booleana';
  return null;
}

function createFakePostgrestCatalogs({ url = 'https://exemplo-teste.supabase.co', serviceRoleKey = 'chave-de-servico-falsa-so-para-teste', numericAsString = false, startAt = '2026-10-12T13:00:00.000Z', schema = 'novo' } = {}) {
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
    if (schema === 'novo' && row.id && row.id.startsWith('service:')) {
      out.permite_pagamento_unico = row.permite_pagamento_unico ?? false;
      out.permite_pagamento_recorrente = row.permite_pagamento_recorrente ?? false;
      out.periodicidades = row.periodicidades ?? [];
    }
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
      const unknownColumn = Object.keys(row).find((column) => !columnsOf(table, schema).includes(column));
      if (unknownColumn) return reply(400, { code: 'PGRST204', message: `Could not find the '${unknownColumn}' column of '${table}' in the schema cache` });
      const now = tick().toISOString();
      const stored = { ativo: true, ordem: 0, created_at: now, updated_at: now, ...(table === 'crm_services' && schema === 'novo' ? { permite_pagamento_unico: false, permite_pagamento_recorrente: false, periodicidades: [] } : {}), ...row };
      const broken = table === 'crm_services' ? serviceViolation(stored, schema) : null;
      if (broken) return reply(400, { code: '23514', message: `new row for relation "${table}" violates check constraint "${broken}"` });
      tables[table].set(stored.id, stored);
      return reply(201, [present(stored)]);
    }

    if (method === 'PATCH') {
      if (wantedId === null) return reply(400, { message: 'PATCH sem filtro de id' });
      const current = tables[table].get(wantedId);
      if (!current) return reply(200, []);
      const unknownColumn = Object.keys(body).find((column) => !columnsOf(table, schema).includes(column));
      if (unknownColumn) return reply(400, { code: 'PGRST204', message: `Could not find the '${unknownColumn}' column of '${table}' in the schema cache` });
      const merged = { ...current, ...body };
      if (table === 'crm_services') {
        const broken = serviceViolation({ ...(schema === 'novo' ? { permite_pagamento_unico: false, permite_pagamento_recorrente: false, periodicidades: [] } : {}), ...merged }, schema);
        if (broken) return reply(400, { code: '23514', message: `new row for relation "${table}" violates check constraint "${broken}"` });
      }
      if (body.nome_normalizado !== undefined && uniqueNameClash(table, merged, wantedId)) return violation(`${table}_nome_normalizado_key`, `Key (nome_normalizado)=(${merged.nome_normalizado}) already exists.`);
      // o gatilho: updated_at é do BANCO, nunca o que o cliente mandou
      merged.updated_at = tick().toISOString();
      tables[table].set(wantedId, merged);
      return reply(200, [present(merged)]);
    }

    return reply(405, { message: 'método não suportado pelo falso' });
  }

  // O UPDATE de preenchimento da migration 20261018090000, sobre as linhas existentes: SÓ as três colunas novas, SÓ as linhas com tipo_cobranca e ainda sem
  // nenhuma modalidade nova; o gatilho de updated_at dispara nas linhas tocadas. Devolve quantas linhas foram tocadas.
  function applyModalitiesMigration() {
    let touched = 0;
    for (const [id, row] of tables.crm_services) {
      const unset = row.permite_pagamento_unico !== true && row.permite_pagamento_recorrente !== true && (row.periodicidades || []).length === 0;
      if (row.tipo_cobranca === undefined || row.tipo_cobranca === null || !unset) continue;
      tables.crm_services.set(id, {
        ...row,
        permite_pagamento_unico: row.tipo_cobranca === 'UNICA',
        permite_pagamento_recorrente: row.tipo_cobranca === 'RECORRENTE',
        periodicidades: row.tipo_cobranca === 'RECORRENTE' ? [row.recorrencia] : [],
        updated_at: tick().toISOString(),
      });
      touched += 1;
    }
    return touched;
  }

  return { fetchImpl, calls, tables, url, serviceRoleKey, tick, applyModalitiesMigration, schema };
}

module.exports = { createFakePostgrestCatalogs, CATALOG_TABLE };
