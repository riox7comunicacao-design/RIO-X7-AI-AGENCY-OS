// Peças de teste do Dashboard — USO SOMENTE EM TESTES (src/ e dashboard/ nunca importam este arquivo).
//
// - crmRecord(): um registro do CRM no formato PÚBLICO que a CRM-API devolve (os 31 campos + id, status, dataDeEntrada,
//   historico). Só dados fictícios (example.test).
// - createFakeApi(): o cliente de API (api.mjs) por trás de um "servidor" em memória, com chamadas registradas e falhas
//   programáveis — para testar as telas sem rede.
// - createFakeSdk(): o SDK do Supabase do navegador (createClient -> auth.*) sem rede.
// - scriptedFetch(): um `fetch` roteado por "MÉTODO /caminho", que devolve Response de verdade.
// - bridgeFetch(): um `fetch` que entrega a requisição ao app REAL do servidor (src/server/app.js) — o Dashboard de
//   verdade falando com a CRM-API de verdade, sem abrir socket.
//
// Este arquivo é ESM (.mjs) para importar os módulos do Dashboard direto; os testes (CommonJS) o carregam por import().

import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

import { ApiError } from '../../dashboard/api.mjs';

const require = createRequire(import.meta.url);
const { CRM_WRITABLE_FIELDS } = require('../../src/crm/constants');

export { ApiError };

const clone = (value) => (value === undefined ? value : structuredClone(value));

let sequence = 0;

// Um registro público. `overrides` sobrescreve qualquer campo (inclusive id, status e historico).
export function crmRecord(overrides = {}) {
  sequence += 1;
  const record = {
    id: `crm:fixture-${String(sequence).padStart(4, '0')}`,
    status: 'PROSPECT',
    dataDeEntrada: `2026-09-${String(10 + (sequence % 15)).padStart(2, '0')}T12:00:00.000Z`,
    historico: [
      {
        timestamp: '2026-09-10T12:00:00.000Z',
        from: null,
        to: 'PROSPECT',
        actor: 'HUMAN',
        reviewedBy: { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN' },
        motivo: null,
      },
    ],
  };
  for (const field of CRM_WRITABLE_FIELDS) record[field] = null;
  return { ...record, ...overrides };
}

// ---------------------------------------------------------------------------
// O cliente de API falso
// ---------------------------------------------------------------------------
// options: { items, approvals, me, history: { [id]: [...] } }. Cada método registra { name, args } em `calls`.
// api.failNext(name, error) faz a PRÓXIMA chamada rejeitar; api.failAll(name, error) faz todas; api.hold(name) devolve
// { release(valor), fail(erro) } e deixa a próxima chamada PENDENTE até o teste liberar — para testar respostas tardias.
export function createFakeApi(options = {}) {
  const store = {
    items: (options.items || []).map(clone),
    approvals: options.approvals || [],
    me: options.me || { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN', permissions: ['READ:CRM', 'WRITE:CRM', 'APPROVE:LEAD_APPROVAL'], status: 'ACTIVE' },
    histories: options.history || {},
  };
  const calls = [];
  const failures = new Map();
  const holds = new Map();
  let created = 0;

  const byId = (id) => store.items.find((item) => item.id === id);

  async function run(name, args, work) {
    calls.push({ name, args: clone(args) });
    const hold = holds.get(name);
    if (hold && !hold.used) {
      hold.used = true;
      return new Promise((resolve, reject) => {
        hold.release = (value) => resolve(value === undefined ? work() : value);
        hold.fail = reject;
        hold.armed();
      });
    }
    const failure = failures.get(name);
    if (failure) {
      if (!failure.always) failures.delete(name);
      throw failure.error;
    }
    return work();
  }

  const api = {
    calls,
    store,
    callsOf: (name) => calls.filter((call) => call.name === name),
    failNext: (name, error) => failures.set(name, { error, always: false }),
    failAll: (name, error) => failures.set(name, { error, always: true }),
    clearFailures: () => failures.clear(),
    hold(name) {
      const control = { used: false, release: null, fail: null, armed: () => {} };
      const ready = new Promise((resolve) => {
        control.armed = resolve;
      });
      holds.set(name, control);
      return {
        // Resolve quando a chamada de fato chegou ao "servidor".
        arrived: ready,
        release: (value) => control.release(value),
        fail: (error) => control.fail(error),
      };
    },

    me: () => run('me', [], () => clone(store.me)),
    listApprovals: () => run('listApprovals', [], () => ({ estado: 'AGUARDANDO_REVISAO', items: clone(store.approvals) })),

    listCrm: () => run('listCrm', [], () => ({ items: clone(store.items) })),
    getCrm: (id) =>
      run('getCrm', [id], () => {
        const item = byId(id);
        if (!item) throw new ApiError(404, 'NOT_FOUND', 'Item não encontrado.');
        return { item: clone(item) };
      }),
    getCrmHistory: (id) =>
      run('getCrmHistory', [id], () => {
        const item = byId(id);
        if (!item) throw new ApiError(404, 'NOT_FOUND', 'Item não encontrado.');
        return { historico: clone(store.histories[id] || item.historico) };
      }),
    createCrm: (fields, opts) =>
      run('createCrm', [fields, opts], () => {
        created += 1;
        const status = (opts && opts.status) || 'PROSPECT';
        const item = crmRecord({ ...fields, id: `crm:created-${created}`, status, historico: [{ timestamp: '2026-09-23T12:00:00.000Z', from: null, to: status, actor: 'HUMAN', reviewedBy: { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN' }, motivo: (opts && opts.reason) || null }] });
        store.items.push(item);
        return { item: clone(item), duplicidade: null };
      }),
    updateCrm: (id, patch) =>
      run('updateCrm', [id, patch], () => {
        const item = byId(id);
        if (!item) throw new ApiError(404, 'NOT_FOUND', 'Item não encontrado.');
        Object.assign(item, patch);
        return { item: clone(item) };
      }),
    moveCrmStatus: (id, to, reason) =>
      run('moveCrmStatus', [id, to, reason], () => {
        const item = byId(id);
        if (!item) throw new ApiError(404, 'NOT_FOUND', 'Item não encontrado.');
        const entry = { timestamp: '2026-09-23T13:00:00.000Z', from: item.status, to, actor: 'HUMAN', reviewedBy: { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN' }, motivo: reason || null };
        item.status = to;
        item.historico = [...item.historico, entry];
        return { item: clone(item) };
      }),
    markCrmDnc: (id, reason) =>
      run('markCrmDnc', [id, reason], () => {
        const item = byId(id);
        if (!item) throw new ApiError(404, 'NOT_FOUND', 'Item não encontrado.');
        const entry = { timestamp: '2026-09-23T14:00:00.000Z', from: item.status, to: 'DO_NOT_CONTACT', actor: 'HUMAN', reviewedBy: { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN' }, motivo: reason || null };
        item.status = 'DO_NOT_CONTACT';
        item.historico = [...item.historico, entry];
        return { item: clone(item) };
      }),
  };
  return api;
}

// ---------------------------------------------------------------------------
// O SDK do Supabase (navegador) falso
// ---------------------------------------------------------------------------
export const FAKE_SESSION = Object.freeze({ access_token: 'token-de-teste-do-navegador-nao-real', refresh_token: 'refresh-de-teste-nao-real', user: { id: 'auth-de-teste' } });

// options: { session, loginError, refreshSession }. `session` presente = já há sessão (o usuário já entrou).
export function createFakeSdk(options = {}) {
  const calls = { createClient: null, signIn: [], signOut: [], refresh: 0, getSession: 0 };
  let current = options.session === undefined ? null : options.session;
  const listeners = [];
  const emit = (event) => {
    for (const listener of listeners) listener(event, current);
  };
  const client = {
    auth: {
      async getSession() {
        calls.getSession += 1;
        return { data: { session: current } };
      },
      async signInWithPassword(credentials) {
        calls.signIn.push(credentials);
        if (options.loginError) return { data: { session: null }, error: options.loginError };
        current = options.loginSession || FAKE_SESSION;
        emit('SIGNED_IN');
        return { data: { session: current }, error: null };
      },
      async signOut(opts) {
        calls.signOut.push(opts === undefined ? null : opts);
        current = null;
        emit('SIGNED_OUT');
        return { error: null };
      },
      async refreshSession() {
        calls.refresh += 1;
        if (options.refreshSession !== undefined) {
          // Como o SDK de verdade: uma renovação bem-sucedida troca a sessão guardada (o próximo getSession já traz o token novo).
          if (options.refreshSession.data && options.refreshSession.data.session) current = options.refreshSession.data.session;
          return options.refreshSession;
        }
        return { data: { session: current }, error: null };
      },
      onAuthStateChange(listener) {
        listeners.push(listener);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
  return {
    createClient(url, key, clientOptions) {
      calls.createClient = { url, key, options: clientOptions };
      return client;
    },
    calls,
    setSession(next) {
      current = next;
    },
    emit,
  };
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// routes: { 'GET /api/me': (call) => body | { status, body } | Response }. `call` = { method, path, headers, body }.
// O que não tem rota é 404 (como o servidor). Cada chamada é registrada em `calls`.
export function scriptedFetch(routes) {
  const calls = [];
  async function fetchImpl(path, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const call = { method, path, headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const key = `${method} ${String(path).split('?')[0]}`;
    const route = routes[key];
    if (!route) return json(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada.' } });
    const result = typeof route === 'function' ? await route(call) : route;
    if (result instanceof Response) return result;
    if (result && typeof result === 'object' && typeof result.status === 'number' && 'body' in result) return json(result.status, result.body);
    return json(200, result);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

// Entrega a requisição ao app REAL (src/server/app.js): monta o `req` como o Node monta e devolve uma Response com o
// que o app respondeu. `tokenFor` NÃO é usado: quem coloca o Authorization é o cliente de API do Dashboard.
export function bridgeFetch(app) {
  const calls = [];
  const responses = [];
  async function fetchImpl(path, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const req = init.body === undefined ? Readable.from([]) : Readable.from([Buffer.from(init.body)]);
    req.method = method;
    req.url = path;
    req.headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    calls.push({ method, path, headers: req.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const response = await app.handle(req);
    responses.push({ method, path, status: response.status, text: String(response.body) });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
  fetchImpl.calls = calls;
  fetchImpl.responses = responses;
  return fetchImpl;
}
