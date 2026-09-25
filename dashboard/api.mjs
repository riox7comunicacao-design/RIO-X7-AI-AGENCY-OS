// Cliente HTTP do Dashboard — a única conversa do navegador com o servidor.
//
// O navegador só fala HTTP: nada aqui importa src/, e o servidor (src/server) é quem autentica, autoriza e chama o
// Service. Este módulo só (1) anexa o access token da sessão (Authorization: Bearer) e (2) trata a sessão
// expirada — sem nunca decidir permissão nenhuma. Ele NUNCA envia userId, role ou permissions: o corpo de uma
// decisão é só { reason }.
//
// CRM (CRM-API, decisão 0015): as chamadas de /api/crm passam pelo MESMO caminho — o token da sessão, a renovação
// única em 401, nenhum efeito em 403. O corpo de uma escrita do CRM só leva campos do registro (a lista fechada de
// WRITABLE_KEYS) e as duas opções que a API aceita (status inicial e motivo): userId, role, permissions, actor,
// reviewedBy e qualquer outra chave são RECUSADOS aqui, antes de existir uma requisição — a identidade de quem escreve
// vem do token, verificada pelo servidor, nunca da interface.
//
// SESSÃO EXPIRADA (401): tenta renovar a sessão UMA vez, repete a requisição UMA vez e, se ainda assim falhar (ou se
// não houver sessão), avisa onSessionLost() e desiste — sem laços. 403 NÃO tenta renovar: a conta autenticou, mas
// não tem acesso.
//
// getAccessToken(): async () => token | null. refreshAccessToken(): async () => token | null (nunca lança).
// onSessionLost(): a UI volta para o login. fetchImpl: para testes (o padrão é o fetch do navegador).

import { WRITABLE_KEYS } from './crm-model.mjs';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.serverMessage = message || '';
  }
}

async function readApiError(response) {
  let code = `HTTP_${response.status}`;
  let message = '';
  try {
    const data = await response.json();
    if (data && data.error) {
      code = typeof data.error.code === 'string' ? data.error.code : code;
      message = typeof data.error.message === 'string' ? data.error.message : '';
    }
  } catch {
    // corpo que não é JSON (um proxy, por exemplo): fica só o status.
  }
  return new ApiError(response.status, code, message);
}

// Os campos de um registro do CRM que vão no corpo: um objeto simples só com chaves de WRITABLE_KEYS. Qualquer outra
// chave (userId, role, permissions, actor, reviewedBy, status...) é um erro de programação — nunca vai para a rede.
function crmFields(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('crm: os campos devem ser um objeto');
  const unknown = Object.keys(fields).filter((key) => !WRITABLE_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`crm: campo não permitido no corpo: ${unknown.join(', ')}`);
  return { ...fields };
}

const CREATE_OPTION_KEYS = Object.freeze(['status', 'reason']);

// As opções da criação: só o status inicial e o motivo da entrada, e só quando preenchidos (texto não vazio).
function crmCreateOptions(options) {
  const picked = {};
  if (options === undefined || options === null) return picked;
  if (typeof options !== 'object' || Array.isArray(options)) throw new Error('crm: as opções devem ser um objeto');
  const unknown = Object.keys(options).filter((key) => !CREATE_OPTION_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`crm: opção não permitida no corpo: ${unknown.join(', ')}`);
  for (const key of CREATE_OPTION_KEYS) {
    if (typeof options[key] === 'string' && options[key].trim() !== '') picked[key] = options[key];
  }
  return picked;
}

const crmPath = (id, suffix = '') => `/api/crm/${encodeURIComponent(id)}${suffix}`;

export function createApiClient({ getAccessToken, refreshAccessToken, onSessionLost, fetchImpl }) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function send(method, path, body, token) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const init = { method, headers, cache: 'no-store' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      return await doFetch(path, init);
    } catch {
      throw new ApiError(0, 'NETWORK', '');
    }
  }

  function sessionLost() {
    onSessionLost();
    return new ApiError(401, 'UNAUTHENTICATED', '');
  }

  async function request(method, path, body) {
    const token = await getAccessToken();
    if (!token) throw sessionLost();

    let response = await send(method, path, body, token);
    if (response.status === 401) {
      const renewed = await refreshAccessToken();
      if (!renewed) throw sessionLost();
      response = await send(method, path, body, renewed);
      if (response.status === 401) throw sessionLost();
    }

    if (!response.ok) throw await readApiError(response);
    try {
      return await response.json();
    } catch {
      throw new ApiError(response.status, 'INVALID_RESPONSE', '');
    }
  }

  return {
    me: () => request('GET', '/api/me'),
    // `estado` só filtra a listagem (o servidor valida e decide); sem ele, a lista padrão do servidor (pendentes).
    listApprovals: (estado) => request('GET', typeof estado === 'string' && estado !== '' ? `/api/approvals?estado=${encodeURIComponent(estado)}` : '/api/approvals'),
    approve: (prospectId, reason) => request('POST', `/api/approvals/${encodeURIComponent(prospectId)}/approve`, reason ? { reason } : {}),
    reject: (prospectId, reason) => request('POST', `/api/approvals/${encodeURIComponent(prospectId)}/reject`, { reason }),
    // Promoção Approval Queue -> CRM (decisão 0016): SÓ o id do prospect (na URL) e um corpo VAZIO. Quem promove vem do
    // token; a aprovação, o estado e a autorização o servidor confere na fila real — nada disso sai daqui.
    promoteApproval: (prospectId) => request('POST', `/api/approvals/${encodeURIComponent(prospectId)}/promote`, {}),

    // CRM. As escritas são `async`: um corpo recusado por crmFields/crmCreateOptions vira uma promessa rejeitada, como
    // qualquer outra falha (e nenhuma requisição sai).
    listCrm: () => request('GET', '/api/crm'),
    getCrm: (id) => request('GET', crmPath(id)),
    getCrmHistory: (id) => request('GET', crmPath(id, '/history')),
    createCrm: async (fields, options) => request('POST', '/api/crm', { ...crmFields(fields), ...crmCreateOptions(options) }),
    updateCrm: async (id, patch) => request('PATCH', crmPath(id), crmFields(patch)),
    moveCrmStatus: (id, to, reason) => request('POST', crmPath(id, '/status'), typeof reason === 'string' && reason.trim() !== '' ? { to, reason } : { to }),
    markCrmDnc: (id, reason) => request('POST', crmPath(id, '/dnc'), typeof reason === 'string' && reason.trim() !== '' ? { reason } : {}),
  };
}
