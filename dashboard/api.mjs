// Cliente HTTP do Dashboard — a única conversa do navegador com o servidor.
//
// O navegador só fala HTTP: nada aqui importa src/, e o servidor (src/server) é quem autentica, autoriza e chama o
// Service. Este módulo só (1) anexa o access token da sessão (Authorization: Bearer) e (2) trata a sessão
// expirada — sem nunca decidir permissão nenhuma. Ele NUNCA envia userId, role ou permissions: o corpo de uma
// decisão é só { reason }.
//
// SESSÃO EXPIRADA (401): tenta renovar a sessão UMA vez, repete a requisição UMA vez e, se ainda assim falhar (ou se
// não houver sessão), avisa onSessionLost() e desiste — sem laços. 403 NÃO tenta renovar: a conta autenticou, mas
// não tem acesso.
//
// getAccessToken(): async () => token | null. refreshAccessToken(): async () => token | null (nunca lança).
// onSessionLost(): a UI volta para o login. fetchImpl: para testes (o padrão é o fetch do navegador).

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
    listApprovals: () => request('GET', '/api/approvals'),
    approve: (prospectId, reason) => request('POST', `/api/approvals/${encodeURIComponent(prospectId)}/approve`, reason ? { reason } : {}),
    reject: (prospectId, reason) => request('POST', `/api/approvals/${encodeURIComponent(prospectId)}/reject`, { reason }),
  };
}
