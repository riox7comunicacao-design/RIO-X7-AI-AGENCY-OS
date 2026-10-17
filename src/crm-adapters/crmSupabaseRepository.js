// Adapter Postgres/Supabase do CRM (decisão 0024, etapa 2; realocado para src/crm-adapters/ na etapa 2.1 — igual
// ao par research-prospector/research-adapters já existente no projeto, decisão 0022: o domínio do CRM, src/crm/,
// é independente da rede; regras R15/R16 em tests/auth/architecture-boundaries.test.js garantem isso na direção
// certa). ATUALIZADO NA ETAPA 3M (correção 3O.5, que só revisa este comentário — nada de funcional mudou aqui):
// `REPOSITORY_MODE=supabase` é a configuração OFICIAL atual (`.env`), e este é o caminho de PRODUÇÃO — o Supabase
// é a fonte oficial do CRM. Quem decide QUAL adapter usar é a fábrica src/services/crmRepositoryFactory.js, que lê
// `REPOSITORY_MODE` e, no modo "supabase", importa e chama `createSupabaseCrmRepository` (este arquivo); em
// "file", usa o adapter de arquivo local (src/crm/crmRepository.js) — ambos continuam existindo como alternativas
// válidas, mas NÃO EXISTE sincronização nem fallback automático entre os dois: escolher um modo significa que só
// aquele armazenamento é lido/escrito; trocar de modo não migra dados. Testado inteiramente com um `fetch` FALSO
// (tests/crm-adapters/crmSupabaseRepository.test.js nunca chama a rede real).
//
// Fala PostgREST DIRETO por `fetch` nativo do Node — NÃO importa @supabase/supabase-js: só
// src/auth/authAdapter.js pode importar o SDK (regra R7, tests/auth/architecture-boundaries.test.js), e não há
// necessidade real de SDK aqui — PostgREST é uma API REST simples, sem dependência nova.
//
// CONTRATO: implementa exatamente { list, getById, save, delete } de src/crm/crmRepositoryPort.js (a porta continua
// no domínio — só a IMPLEMENTAÇÃO que fala com a rede mora aqui). As 4 operações são `async` (a porta aceita isso
// desde a decisão 0023 — ver assertValidRepository). `save()` recebe sempre o registro INTEIRO (o domínio nunca
// manda um patch parcial) e faz um upsert por `id` (Prefer: resolution=merge-duplicates) — o mesmo "insere ou
// substitui" do adapter de arquivo, e não devolve nada (return=minimal), como a porta já documenta. NENHUM
// parâmetro de versão esperada existe ainda — ver a pendência D-CONCURRENCY-PORT em docs/decisions/0024. `delete()`
// (decisão 0025) NUNCA apaga direto: chama a função SQL transacional delete_crm_record_with_audit via RPC, que
// audita (crm_record_deletions) e apaga numa única transação de banco — ver o comentário da função abaixo.
//
// SEGREDO: a service_role key fica só em memória, só neste processo, só para montar o cabeçalho Authorization
// de cada requisição. Nunca é logada (este arquivo não chama console.*) e nunca aparece em nenhuma mensagem de
// erro lançada por ele — os erros citam status HTTP e a mensagem que o PostgREST devolveu (a leitura da lista, desde a Fase H3.2, só cita o status), nunca o cabeçalho.

const { readSupabaseCrmConfig } = require('./crmSupabaseConfig');
const { recordToRow, rowToRecord } = require('./crmSupabaseMapping');

const DEFAULT_TABLE = 'crm_records';
const REQUEST_TIMEOUT_MS = 15000;
// A função SQL transacional da migration de auditoria de exclusão (decisão 0025) — localiza, audita
// (crm_record_deletions) e apaga, numa ÚNICA transação implícita (uma função PL/pgSQL nunca deixa um apagamento
// sem auditoria, nem uma auditoria de um apagamento que não aconteceu). Nome FIXO: esta é a única chamada no
// projeto inteiro a este RPC — trocar o nome aqui sem trocar na migration quebra a exclusão em produção.
const DELETE_WITH_AUDIT_RPC = 'delete_crm_record_with_audit';

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
const POSTGRES_VALIDATION_CODES = new Set(['22P02', '23502', '23514', '22023']); // invalid_text_representation, not_null_violation, check_violation, invalid_parameter_value
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
async function send(config, { method, path, query, body, prefer, safeError }, fetchImpl) {
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
    // `safeError` (a leitura da lista): só o status HTTP — nunca a mensagem do PostgREST (poderia citar dados do registro).
    if (safeError) throw new Error(`CRM (Supabase): PostgREST recusou a leitura da lista (HTTP ${response.status}).`);
    const detalhe = json && typeof json.message === 'string' ? json.message : `HTTP ${response.status}`;
    const erro = new Error(`CRM (Supabase): PostgREST recusou a operação (${detalhe}).`);
    const classificado = classifyPostgrestFailure(response.status, json);
    if (classificado) erro.code = classificado;
    throw erro;
  }
  return { json, response };
}

async function postgrest(config, spec, fetchImpl) {
  return (await send(config, spec, fetchImpl)).json;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// LEITURA COMPLETA DA LISTA (Fase H3.2). `list()` alimenta a duplicidade, o DNC, a reconciliação da promoção, a contagem de uso dos catálogos,
// `GET /api/crm` e o export: se ela vier CORTADA ou "vazia por engano", essas barreiras ficam cegas SEM nenhum aviso (comprovado na auditoria
// H3.1 e previsto na pendência nº 2 da decisão 0023). Um PostgREST limita as linhas por resposta (padrão 1000, configurável) e, ordenando por
// `seq` crescente, o corte descarta os registros MAIS NOVOS. Por isso a leitura:
//   - é paginada (limit/offset) e pede o total exato (Prefer: count=exact), que volta em Content-Range ("0-499/1234", ou "*/0" com a tabela vazia);
//   - só termina quando o número de linhas lidas é IGUAL a esse total, e o total tem de ser o mesmo em todas as páginas; uma página curta NUNCA é
//     tomada como a última (o servidor pode ter um teto menor que o pedido);
//   - confere, a cada página, que a faixa devolvida é exatamente a que foi pedida e a que chegou;
//   - não aceita nada que não seja uma lista de objetos com `id` e `status` em texto (os campos estruturais de TODO registro: `id` é a chave
//     primária e `status` é NOT NULL), nem um `id` repetido, nem um Content-Range ausente ou ilegível;
//   - nunca devolve uma lista PARCIAL: qualquer dúvida, ou qualquer falha em qualquer página, é um ERRO, e quem chama (o domínio) a trata como falha
//     da operação — nunca como "CRM vazio";
//   - as mensagens de erro citam só o status HTTP ou um motivo fixo: nunca o corpo da resposta nem a mensagem do PostgREST.
// ORDEM: `seq` (BIGINT GENERATED ALWAYS AS IDENTITY) é preenchida só pelo banco e nunca repetida; MAS a migration não declara UNIQUE sobre ela.
// Por isso o desempate por `id` (chave primária): a ordem pública é a mesma de sempre e a paginação é determinística mesmo num empate teórico.
// LIMITES OPERACIONAIS TEMPORÁRIOS (não são a capacidade definitiva do produto): 10 mil registros e 100 páginas. Acima disso a leitura FALHA
// (nunca devolve "metade da lista"): cada operação que precisa da lista inteira (criar, promover, `GET /api/crm`, export) para até uma decisão.
// SEM SNAPSHOT: as páginas são requisições independentes, sem transação entre elas. Uma inserção ou exclusão no meio da leitura costuma mudar o
// total (ou repetir/pular uma linha) e a leitura falha — mas NÃO se afirma que toda alteração concorrente seja detectável (ex.: uma troca que
// mantenha o total). Não há cache: cada leitura é nova.
// Nada disto foi exercitado contra o Supabase REAL (só com `fetch` falso): ver o relatório da Fase H3.2.
// ---------------------------------------------------------------------------------------------------------------------------------
const LIST_PAGE_SIZE = 500;
const LIST_MAX_ROWS = 10000;
const LIST_MAX_PAGES = 100;

function listError(reason) {
  return new Error(`CRM (Supabase): a lista de registros não pôde ser lida por completo (${reason}).`);
}

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

// A forma estrutural mínima de uma linha: o que o domínio precisa para decidir (id e status). Nada mais é exigido, para nunca descartar um registro
// legítimo antigo.
function isCrmRow(row) {
  return isPlainObject(row) && typeof row.id === 'string' && row.id.length > 0 && typeof row.status === 'string';
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

  // TODOS os registros (na ordem de inserção), ou um erro — nunca uma parte deles e nunca "vazio" por uma resposta que não é uma lista.
  async function list() {
    const rows = [];
    const seen = new Set();
    let total = null;
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const offset = rows.length;
      const { json, response } = await send(
        config,
        { method: 'GET', path: `/rest/v1/${table}`, query: { select: '*', order: 'seq.asc,id.asc', limit: String(LIST_PAGE_SIZE), offset: String(offset) }, prefer: 'count=exact', safeError: true },
        fetchImpl
      );
      if (!Array.isArray(json)) throw listError('a resposta não é uma lista');
      const header = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-range') : null;
      const range = parseContentRange(header);
      if (range === null) throw listError('o total de registros não pôde ser confirmado');
      if (total === null) total = range.total;
      else if (range.total !== total) throw listError('o total mudou durante a leitura');
      if (total > LIST_MAX_ROWS) throw listError('há registros demais para uma leitura segura');

      if (json.length === 0) {
        if (rows.length !== total) throw listError('a leitura terminou antes do total');
        break;
      }
      if (json.length > LIST_PAGE_SIZE) throw listError('a página veio maior que a pedida');
      // a faixa que o servidor diz ter devolvido tem de ser exatamente a que foi pedida e a que chegou
      if (range.start !== offset || range.end !== offset + json.length - 1) throw listError('a faixa devolvida não confere com a pedida');
      for (const row of json) {
        if (!isCrmRow(row)) throw listError('um registro tem formato inesperado');
        if (seen.has(row.id)) throw listError('um registro apareceu duas vezes');
        seen.add(row.id);
        rows.push(row);
      }
      if (rows.length > total) throw listError('vieram mais registros do que o total');
      if (rows.length === total) break;
    }
    if (total === null || rows.length !== total) throw listError('a leitura não chegou ao total');
    return rows.map(rowToRecord);
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

  // Exclusão ADMINISTRATIVA e IRREVERSÍVEL (decisão 0025). NUNCA um DELETE simples do PostgREST: chama a função
  // SQL transacional (RPC), que localiza o registro, grava a auditoria (crm_record_deletions) e só então apaga —
  // tudo numa única transação de banco. `meta.reviewedBy` ({ userId, name, role }) e `meta.motivo` são OBRIGATÓRIOS
  // aqui (o Service já os valida antes de chegar neste adapter — esta checagem é defesa em profundidade, nunca a
  // única camada). Nada disto envia a service_role no CORPO da requisição — ela vai só no cabeçalho, como em toda
  // chamada deste adapter.
  async function deleteRecord(id, meta) {
    if (typeof id !== 'string' || !id) {
      throw new Error('CRM: delete() exige um id (texto não vazio)');
    }
    assertSafeRecordId(id);
    const reviewedBy = isPlainObject(meta) ? meta.reviewedBy : null;
    const motivo = isPlainObject(meta) ? meta.motivo : null;
    if (!isPlainObject(reviewedBy) || typeof reviewedBy.userId !== 'string' || !reviewedBy.userId || typeof reviewedBy.name !== 'string' || !reviewedBy.name || typeof reviewedBy.role !== 'string' || !reviewedBy.role) {
      throw new Error('CRM: delete() exige meta.reviewedBy = { userId, name, role } para a auditoria');
    }
    if (typeof motivo !== 'string' || motivo.trim().length === 0) {
      throw new Error('CRM: delete() exige meta.motivo (texto não vazio) para a auditoria');
    }
    await postgrest(
      config,
      {
        method: 'POST',
        path: `/rest/v1/rpc/${DELETE_WITH_AUDIT_RPC}`,
        body: { p_id: id, p_deleted_by_user_id: reviewedBy.userId, p_deleted_by_name: reviewedBy.name, p_deleted_by_role: reviewedBy.role, p_reason: motivo },
      },
      fetchImpl
    );
  }

  return Object.freeze({ list, getById, save, delete: deleteRecord });
}

module.exports = { createSupabaseCrmRepository, DEFAULT_TABLE, CRM_REPOSITORY_ERROR };
