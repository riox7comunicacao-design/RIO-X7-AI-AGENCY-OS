// Consulta aos CATÁLOGOS pelos formulários do CRM (CRM 5.0, Fase 2B-3.1, decisão 0026) — Serviços, Nichos e Origens dos Leads.
//
//   formulário do CRM -> createCatalogLookup -> api.listCatalog -> GET /api/crm-catalogs/<catalogo>  (os endpoints que já existem)
//
// O QUE ESTE MÓDULO É: só LEITURA e só o que a SELEÇÃO precisa. Guarda, de cada item, { id, nome, ativo } e a chave normalizada do nome — nada de preço de referência,
// cor, descrição nem campos de auditoria. Não grava nada, não cria itens e não sabe o que é um registro do CRM: o registro continua guardando o NOME como TEXTO
// (os 31 campos e a API não mudam); este módulo só diz quais nomes existem e se um texto já salvo corresponde a algum deles.
//
// AUTENTICAÇÃO E ERROS: tudo passa pelo cliente de API (api.mjs): o mesmo token, a mesma renovação única em 401 e o mesmo tratamento de erros dos catálogos
// (catalogErrorInfo). Quem tem MANAGE:CRM_CATALOGS (ADMIN) lê também os itens DESATIVADOS (?todos=1) — a única forma de CONFIRMAR que um valor pertence a um item
// desativado; quem só lê (READ:CRM) recebe só os ativos e nunca é dito que algo "está desativado".
//
// CONSULTAS: no máximo UMA por catálogo enquanto o resultado vale (cache de alguns minutos). Consultas simultâneas viram uma só. Não há polling nem temporizador: a lista
// só é lida de novo quando um formulário abre com o cache vencido, quando a pessoa pede ("Tentar novamente") ou quando outra tela avisa que um catálogo mudou
// (`crm-catalogs:changed`) — e, nesse caso, só se algum formulário estiver mesmo aberto esperando por ele. Uma falha NUNCA é guardada como definitiva.
//
// NORMALIZAÇÃO: a MESMA do servidor (src/crm/catalogDomain.js, normalizeCatalogName) — minúsculas, sem acento, qualquer sequência fora de [a-z0-9] vira um espaço. O navegador
// nunca importa src/, então a regra é uma CÓPIA, conferida contra a do servidor por testes de paridade (tests/server/dashboard-crm-catalog-lookup.test.js).

import { catalogErrorInfo } from './catalog-model.mjs';

// O campo do CRM -> o catálogo que o substitui na seleção.
export const CATALOG_FIELDS = Object.freeze({ nicho: 'nichos', origem: 'origens', servicoPotencial: 'servicos' });
export const CATALOG_KEYS = Object.freeze(['servicos', 'nichos', 'origens']);

// O nome do cadastro, para mensagens e para o atalho do ADMIN.
export const CATALOG_TITLES = Object.freeze({ servicos: 'Serviços', nichos: 'Nichos e Cores', origens: 'Origens dos Leads' });

export const STATUS = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready', // há ao menos um item ATIVO para escolher
  EMPTY: 'empty', // o catálogo respondeu, mas não tem nenhum item ativo
  UNAVAILABLE: 'unavailable', // 503: a estrutura de dados não está disponível (a migration ainda não foi aplicada)
  NETWORK: 'network', // falha de conexão (transitória): NÃO diz nada sobre a estrutura do banco
  ERROR: 'error', // qualquer outro erro
  OFF: 'off', // sem integração (sem permissão de leitura ou sem a chamada na API): o formulário fica como sempre foi
});

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

// A MESMA regra de src/crm/catalogDomain.js (normalizeCatalogName).
export function normalizeCatalogName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Só o necessário para escolher. Entradas que não são um item (sem id ou sem nome) são ignoradas; nada além de { id, nome, ativo, key } sobrevive.
export function simplifyCatalogItems(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const nome = typeof entry.nome === 'string' ? entry.nome.trim() : '';
    if (id === '' || nome === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(Object.freeze({ id, nome, ativo: entry.ativo === true, key: normalizeCatalogName(nome) }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// O que um TEXTO já salvo é, diante do catálogo (função pura)
// ---------------------------------------------------------------------------
//   empty               nada preenchido
//   official            é exatamente o nome de um item ATIVO
//   different-spelling  casa com um item ATIVO só depois de normalizar (grafia diferente da oficial) — `item` é o oficial
//   inactive            casa com um item DESATIVADO (só quem administra sabe: a lista dos demais não traz os desativados) — `item` é o desativado
//   outside             não consta no catálogo (ou não dá para confirmar que consta)
export function classifyValue(value, items) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return { kind: 'empty', item: null };
  const list = Array.isArray(items) ? items : [];
  const exact = list.find((item) => item.ativo && item.nome === text);
  if (exact) return { kind: 'official', item: exact };
  const key = normalizeCatalogName(text);
  if (key === '') return { kind: 'outside', item: null };
  const sameKey = list.filter((item) => item.key === key);
  const active = sameKey.find((item) => item.ativo);
  if (active) return { kind: 'different-spelling', item: active };
  const inactive = sameKey.find((item) => !item.ativo);
  if (inactive) return { kind: 'inactive', item: inactive };
  return { kind: 'outside', item: null };
}

// ---------------------------------------------------------------------------
// A consulta, com cache, uma só requisição por vez e aviso aos formulários abertos
// ---------------------------------------------------------------------------
// api: o cliente de api.mjs (listCatalog). bus: o barramento da sessão (opcional). canRead: READ:CRM. canManage: MANAGE:CRM_CATALOGS (lê também os desativados).
// now/ttlMs: relógio e validade do cache (testes).
export function createCatalogLookup({ api, bus = null, canRead = true, canManage = false, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const enabled = Boolean(canRead) && api !== null && typeof api === 'object' && typeof api.listCatalog === 'function';
  const entries = new Map(
    CATALOG_KEYS.map((key) => [key, { status: enabled ? STATUS.IDLE : STATUS.OFF, items: [], fetchedAt: null, stale: false, pending: null, generation: 0, listeners: new Set() }])
  );
  let destroyed = false;

  const entryOf = (catalog) => {
    const entry = entries.get(catalog);
    if (!entry) throw new Error(`catálogo desconhecido: ${String(catalog)}`);
    return entry;
  };

  function snapshot(catalog) {
    const entry = entryOf(catalog);
    const items = Object.freeze([...entry.items]);
    return Object.freeze({ catalog, status: entry.status, items, activeItems: Object.freeze(items.filter((item) => item.ativo)), knowsInactive: Boolean(canManage), refreshing: entry.pending !== null });
  }

  function notify(catalog) {
    const entry = entryOf(catalog);
    const state = snapshot(catalog);
    for (const listener of [...entry.listeners]) {
      try {
        listener(state);
      } catch {
        // um ouvinte com defeito não impede os demais
      }
    }
  }

  const isFresh = (entry) => (entry.status === STATUS.READY || entry.status === STATUS.EMPTY) && !entry.stale && entry.fetchedAt !== null && now() - entry.fetchedAt < ttlMs;

  function load(catalog) {
    const entry = entryOf(catalog);
    const generation = entry.generation;
    const hadContent = entry.status === STATUS.READY || entry.status === STATUS.EMPTY;
    if (!hadContent) {
      entry.status = STATUS.LOADING;
    }
    entry.pending = (async () => {
      try {
        const data = await api.listCatalog(catalog, canManage ? { todos: true } : {});
        if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw Object.assign(new Error('resposta inesperada'), { status: 500 });
        entry.items = simplifyCatalogItems(data.items);
        entry.status = entry.items.some((item) => item.ativo) ? STATUS.READY : STATUS.EMPTY;
        entry.fetchedAt = now();
        entry.stale = generation !== entry.generation;
      } catch (error) {
        const info = catalogErrorInfo(error);
        const kind = info ? info.kind : 'other';
        if (hadContent) {
          // uma releitura que falha NUNCA derruba o que já se sabia: as opções continuam, e a próxima abertura tenta de novo
          entry.stale = true;
        } else {
          entry.status = kind === 'unavailable' ? STATUS.UNAVAILABLE : kind === 'network' ? STATUS.NETWORK : STATUS.ERROR;
          entry.items = [];
          entry.fetchedAt = null;
        }
      } finally {
        entry.pending = null;
      }
      const state = snapshot(catalog);
      notify(catalog);
      // um aviso de mudança chegou durante a leitura e há formulário esperando: uma nova leitura, só uma
      if (!destroyed && entry.stale && entry.listeners.size > 0 && entry.generation > generation && (entry.status === STATUS.READY || entry.status === STATUS.EMPTY)) load(catalog);
      return state;
    })();
    if (!hadContent) notify(catalog);
    return entry.pending;
  }

  // Garante o estado de um catálogo: o do cache enquanto vale; senão lê. Nunca lança (o resultado traz o estado, inclusive o de falha).
  function ensure(catalog, { force = false } = {}) {
    const entry = entryOf(catalog);
    if (!enabled || destroyed) return Promise.resolve(snapshot(catalog));
    if (entry.pending) return entry.pending;
    if (!force && isFresh(entry)) return Promise.resolve(snapshot(catalog));
    return load(catalog);
  }

  // Um catálogo mudou (aviso de outra tela): o cache deixa de valer. Só relê agora se algum formulário aberto o espera.
  function invalidate(catalog) {
    const targets = catalog === undefined || catalog === null || !entries.has(catalog) ? CATALOG_KEYS : [catalog];
    for (const key of targets) {
      const entry = entryOf(key);
      entry.stale = true;
      entry.generation += 1;
      if (enabled && !destroyed && entry.pending === null && entry.listeners.size > 0) load(key);
    }
  }

  const unsubscribeBus = bus && typeof bus.subscribe === 'function' ? bus.subscribe('crm-catalogs:changed', (event) => invalidate(event && typeof event === 'object' ? event.catalog : undefined)) : null;

  return Object.freeze({
    enabled,
    canManage: Boolean(canManage),
    peek: (catalog) => snapshot(catalog),
    ensure,
    invalidate,
    // Quem desenha um campo assina o catálogo dele; devolve a função que cancela.
    subscribe(catalog, listener) {
      if (typeof listener !== 'function') throw new Error('lookup: o ouvinte deve ser uma função');
      const entry = entryOf(catalog);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    listenerCount: (catalog) => entryOf(catalog).listeners.size,
    destroy() {
      destroyed = true;
      if (unsubscribeBus) unsubscribeBus();
      for (const entry of entries.values()) entry.listeners.clear();
    },
  });
}
