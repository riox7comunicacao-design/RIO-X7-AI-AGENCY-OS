// Adaptador HTTP do Dashboard — a ÚNICA porta de entrada do navegador para o Approval Queue Service.
//
//   navegador (dashboard/) -> HTTP /api/* -> ESTE MÓDULO -> Auth -> AuthorizationContext -> Approval Queue Service
//
// O navegador só fala HTTP. Este módulo não decide regra de negócio nem de permissão: ele autentica quem chama,
// monta o AuthorizationContext pelo fluxo já existente de src/auth, valida a FORMA da requisição, chama o Service
// e traduz o resultado (ou o erro) em HTTP. Quem autoriza é o Service — e, de novo, o domínio.
//
// ROTAS (só estas; qualquer outra rota de /api é 404):
//   GET  /api/me                        a projeção segura do usuário autenticado
//   GET  /api/approvals[?estado=]       a fila (por padrão, AGUARDANDO_REVISAO)
//   POST /api/approvals/:id/approve     corpo { reason? }
//   POST /api/approvals/:id/reject      corpo { reason }   (motivo obrigatório)
// Tudo fora de /api é arquivo estático (ver static.js).
//
// PIPELINE de toda rota de /api, sempre nesta ordem:
//   1. rota e método existem?                        (404 / 405)
//   2. Authorization: Bearer <access token>          (401 sem token)
//   3. verifyAccessToken(token)                      (401 recusado; 503 se o Supabase não responde)
//   4. resolveAuthorizationContext(userStore, id)    (403 se não há USER para o authUserId)
//   5. usuário ATIVO                                 (403 se inativo)
//   6. a requisição: query, Content-Type, tamanho e JSON estritos      (400 / 413 / 415)
//   7. Service                                       (403 sem a permissão; 404; 409; 400)
// Nada do que vem do navegador — corpo, query, cabeçalho — participa da identidade ou da permissão: NENHUMA rota
// lê userId, role, permissions, reviewedBy ou authUserId de lugar nenhum, e um campo desconhecido no corpo é 400.
// O reviewedBy gravado na fila vem do contexto, que vem do token.
//
// LEITURA (provisório, decisão D6): as leituras usam a mesma autorização das ações — a que o Service aplica hoje.
// Isso NÃO define a permissão definitiva de leitura da fila; será revisto antes de existir um usuário só-leitura.
//
// ERROS (decisão D5): os erros do Service, do domínio e do auth são traduzidos AQUI, e o Service não foi alterado
// para isso. Como esses erros são texto (não têm código), a tradução compara o início da mensagem — e isso é
// travado por um teste de contrato que produz cada erro real. Toda resposta de erro tem mensagem FIXA em português:
// nunca a mensagem, a stack ou a causa do erro original. Qualquer coisa que não seja reconhecida é 500 genérico.
//
// SEGURANÇA DO TOKEN: o access token nunca é gravado em log, nunca entra em resposta e nunca é repetido em erro. O
// log registra só método, rota (com :id no lugar do prospect), status e userId; uma mensagem de erro que
// eventualmente contenha o token é limpa antes de ser registrada.
//
// Este arquivo não lê ambiente, disco nem rede na importação: quem o compõe é src/server/index.js.

const {
  resolveAuthorizationContext,
  requireActiveUser,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
  UserResolutionError,
  USER_NOT_FOUND,
} = require('../auth');
const { createStaticHandler } = require('./static');

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_TARGET_LENGTH = 4096;
const DEFAULT_AUTH_TIMEOUT_MS = 10000;

// O estado padrão da listagem. Duplica de propósito QUEUE_STATE.AGUARDANDO_REVISAO do domínio (este módulo não
// importa o domínio); um teste vigia que os dois não divirjam.
const DEFAULT_ESTADO = 'AGUARDANDO_REVISAO';

const NO_ACCESS_MESSAGE = 'Esta conta não possui acesso a esta área.';

// O catálogo de respostas de erro: status + mensagem fixa.
const CATALOG = Object.freeze({
  UNAUTHENTICATED: [401, 'Sessão ausente, inválida ou expirada. Entre novamente.'],
  NO_ACCESS: [403, NO_ACCESS_MESSAGE],
  INACTIVE: [403, NO_ACCESS_MESSAGE],
  FORBIDDEN: [403, NO_ACCESS_MESSAGE],
  ROUTE_NOT_FOUND: [404, 'Rota não encontrada.'],
  NOT_FOUND: [404, 'Item não encontrado.'],
  METHOD_NOT_ALLOWED: [405, 'Método não permitido.'],
  ALREADY_DECIDED: [409, 'Este item já foi decidido.'],
  PAYLOAD_TOO_LARGE: [413, 'Requisição grande demais.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Envie o corpo como application/json.'],
  INVALID_REQUEST: [400, 'Requisição inválida.'],
  AUTH_UNAVAILABLE: [503, 'Não foi possível verificar a sessão agora. Tente novamente em instantes.'],
  INTERNAL: [500, 'Erro interno. Tente novamente em instantes.'],
});

// Um erro DESTE módulo: um código do catálogo, um detalhe (só para INVALID_REQUEST, de um conjunto fixo) e
// cabeçalhos extras (Allow, Connection).
class HttpError extends Error {
  constructor(code, detail, headers) {
    super(code);
    this.name = 'HttpError';
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

// As mensagens EXISTENTES do Service, do domínio e do auth, reconhecidas pelo começo do texto (D5). O que não
// está aqui é INTERNAL. O teste de contrato (tests/server) produz cada uma destas com os módulos reais.
const KNOWN_MESSAGES = Object.freeze([
  [/^usuário inativo/, 'INACTIVE'],
  [/^acesso negado/, 'FORBIDDEN'],
  [/^prospect não encontrado na fila/, 'NOT_FOUND'],
  [/^transição não permitida/, 'ALREADY_DECIDED'],
  [/^rejeição exige um motivo/, 'INVALID_REQUEST', 'Informe o motivo da rejeição.'],
  [/^reason deve ser um texto/, 'INVALID_REQUEST', 'O motivo deve ser um texto.'],
  [/^opções não reconhecidas/, 'INVALID_REQUEST', 'Campos não permitidos na requisição.'],
  [/^as opções devem ser um objeto/, 'INVALID_REQUEST', 'Campos não permitidos na requisição.'],
  [/^estado desconhecido/, 'INVALID_REQUEST', 'Estado inválido.'],
  [/^prospectId deve ser um texto não vazio/, 'INVALID_REQUEST', 'Identificador inválido.'],
]);

// Dicas para o LOG de erros internos conhecidos — sem repetir a mensagem original, que pode trazer trechos de
// dados (um JSON de fila corrompido cita um pedaço do conteúdo).
const INTERNAL_HINTS = Object.freeze([
  [/^arquivo de fila corrompido/, 'a fila em disco está corrompida ou ilegível (confira RIO_X7_QUEUE_PATH e o arquivo)'],
]);

// Traduz QUALQUER erro em { status, code, message, headers }. Nunca lança.
function mapErrorToHttp(error) {
  let code = 'INTERNAL';
  let detail;
  let headers;
  if (error instanceof HttpError) {
    code = error.code;
    detail = error.detail;
    headers = error.headers;
  } else if (error instanceof SupabaseAdapterError) {
    code = error.category === CONNECTIVITY_ERROR.AUTH ? 'UNAUTHENTICATED' : 'AUTH_UNAVAILABLE';
  } else if (error instanceof UserResolutionError) {
    code = error.code === USER_NOT_FOUND ? 'NO_ACCESS' : 'INTERNAL';
  } else {
    const message = error && typeof error.message === 'string' ? error.message : '';
    const known = KNOWN_MESSAGES.find(([pattern]) => pattern.test(message));
    if (known) {
      code = known[1];
      detail = known[2];
    }
  }
  const [status, message] = CATALOG[code] || CATALOG.INTERNAL;
  return { status, code, message: code === 'INVALID_REQUEST' && detail ? detail : message, headers };
}

function respond(status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(body)),
      ...headers,
    },
    body,
  };
}

function errorResponse(failure) {
  return respond(failure.status, { error: { code: failure.code, message: failure.message } }, failure.headers);
}

// Remove o token de um texto (defesa em profundidade: o adapter já o limpa das suas mensagens).
function scrub(text, token) {
  const value = String(text == null ? '' : text);
  return token ? value.split(token).join('[token omitido]') : value;
}

// O que vai para o log quando um erro é inesperado: a dica conhecida, ou classe + mensagem curta e sem o token.
function describeError(error, token) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  const hint = INTERNAL_HINTS.find(([pattern]) => pattern.test(message));
  if (hint) return hint[1];
  const name = error && typeof error.name === 'string' ? error.name : 'Error';
  return `${name}: ${scrub(message, token).slice(0, 200)}`;
}

function bearerToken(header) {
  if (typeof header !== 'string') throw new HttpError('UNAUTHENTICATED');
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) throw new HttpError('UNAUTHENTICATED');
  return match[1];
}

// Uma verificação de token que não responde vira 503 (falha fechada), nunca uma requisição pendurada.
function withTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new HttpError('AUTH_UNAVAILABLE')), milliseconds);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function collectBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (done, value) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      done(value);
    };
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        settle(reject, new HttpError('PAYLOAD_TOO_LARGE', undefined, { Connection: 'close' }));
        return;
      }
      chunks.push(buffer);
    }
    req.on('data', onData);
    req.once('end', () => settle(resolve, Buffer.concat(chunks)));
    req.once('error', (error) => settle(reject, error));
    req.once('close', () => settle(reject, new HttpError('INVALID_REQUEST', 'Requisição interrompida.')));
  });
}

// Content-Type application/json obrigatório, tamanho limitado, JSON estrito: o corpo é um OBJETO.
async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError('UNSUPPORTED_MEDIA_TYPE');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError('PAYLOAD_TOO_LARGE', undefined, { Connection: 'close' });
  }
  const text = (await collectBody(req, MAX_BODY_BYTES)).toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError('INVALID_REQUEST', 'JSON inválido.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError('INVALID_REQUEST', 'O corpo deve ser um objeto JSON.');
  }
  return value;
}

// O único campo aceito nas decisões é `reason`. Qualquer outro — userId, role, permissions, reviewedBy,
// authUserId... — é recusado, e nunca chega ao Service.
function readReason(body, { required }) {
  if (Object.keys(body).some((key) => key !== 'reason')) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
  if (body.reason !== undefined && typeof body.reason !== 'string') throw new HttpError('INVALID_REQUEST', 'O motivo deve ser um texto.');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (required && reason.length === 0) throw new HttpError('INVALID_REQUEST', 'Informe o motivo da rejeição.');
  return reason.length > 0 ? reason : undefined;
}

function parseTarget(req) {
  const target = req.url;
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.includes('\\') || target.length > MAX_TARGET_LENGTH) {
    throw new HttpError('INVALID_REQUEST');
  }
  try {
    return new URL(target, 'http://localhost');
  } catch {
    throw new HttpError('INVALID_REQUEST');
  }
}

function matchRoute(pathname) {
  if (pathname === '/api/me') return { name: 'me', label: '/api/me', methods: ['GET'] };
  if (pathname === '/api/approvals') return { name: 'list', label: '/api/approvals', methods: ['GET'] };
  const decision = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (decision) return { name: decision[2], label: `/api/approvals/:id/${decision[2]}`, methods: ['POST'], rawId: decision[1] };
  if (pathname === '/api' || pathname.startsWith('/api/')) return { name: 'unknown', label: '/api/*', methods: [] };
  return null;
}

function decodeId(rawId) {
  try {
    return decodeURIComponent(rawId);
  } catch {
    throw new HttpError('INVALID_REQUEST', 'Identificador inválido.');
  }
}

// Sem nenhuma query, salvo as chaves permitidas (e cada uma uma única vez).
function readQuery(url, allowedKeys) {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !allowedKeys.includes(key))) throw new HttpError('INVALID_REQUEST', 'Parâmetros não permitidos.');
  for (const key of allowedKeys) {
    if (url.searchParams.getAll(key).length > 1) throw new HttpError('INVALID_REQUEST', 'Parâmetros não permitidos.');
  }
  return url.searchParams;
}

function projectIdentity(context) {
  return {
    userId: context.userId,
    name: context.name,
    role: context.role,
    permissions: [...context.permissions],
    status: context.status,
  };
}

function contentSecurityPolicy(connectOrigin) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${connectOrigin}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`createApp exige { ${name} } (função)`);
}

// verifyAccessToken: async (token) -> VerifiedIdentity (o adapter de src/auth).
// userStore: o store de USERs (findByAuthUserId).
// approvalQueueService: o Approval Queue Service (listQueue, approveProspect, rejectProspect).
// publicConfig: { supabaseUrl, supabaseAnonKey } — os valores PÚBLICOS que o navegador recebe.
// staticRoot / staticFiles: os arquivos do Dashboard (ver static.js).
// log: (texto) => void. authTimeoutMs: quanto esperar pela verificação do token.
function createApp(dependencies) {
  const { verifyAccessToken, userStore, approvalQueueService, publicConfig, staticRoot, staticFiles, log = () => {}, authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS } =
    dependencies || {};
  requireFunction(verifyAccessToken, 'verifyAccessToken');
  requireFunction(log, 'log');
  if (!userStore || typeof userStore.findByAuthUserId !== 'function') throw new Error('createApp exige { userStore } (com findByAuthUserId)');
  for (const operation of ['listQueue', 'approveProspect', 'rejectProspect']) {
    if (!approvalQueueService || typeof approvalQueueService[operation] !== 'function') {
      throw new Error(`createApp exige { approvalQueueService } com ${operation}()`);
    }
  }
  if (!publicConfig || typeof publicConfig.supabaseUrl !== 'string' || typeof publicConfig.supabaseAnonKey !== 'string') {
    throw new Error('createApp exige { publicConfig: { supabaseUrl, supabaseAnonKey } }');
  }
  let connectOrigin;
  try {
    connectOrigin = new URL(publicConfig.supabaseUrl).origin;
  } catch {
    throw new Error('createApp: publicConfig.supabaseUrl não é uma URL válida');
  }
  const csp = contentSecurityPolicy(connectOrigin);
  // O que o navegador recebe em /config.json: EXATAMENTE estes dois valores públicos, nomeados um a um.
  const staticHandler = createStaticHandler({
    root: staticRoot,
    files: staticFiles,
    config: { supabaseUrl: publicConfig.supabaseUrl, supabaseAnonKey: publicConfig.supabaseAnonKey },
  });

  // Autentica e devolve o contexto. Só o servidor decide: o token é a única coisa do cliente que conta.
  async function authenticate(req, trace) {
    const token = bearerToken(req.headers.authorization);
    trace.token = token;
    const identity = await withTimeout(verifyAccessToken(token), authTimeoutMs);
    const context = resolveAuthorizationContext(userStore, identity);
    requireActiveUser(context);
    trace.userId = context.userId;
    return context;
  }

  async function serveStatic(req, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError('METHOD_NOT_ALLOWED', undefined, { Allow: 'GET, HEAD' });
    return staticHandler.serve(url.pathname);
  }

  async function dispatch(req, trace) {
    const url = parseTarget(req);
    const route = matchRoute(url.pathname);
    if (route === null) {
      trace.label = 'static';
      return serveStatic(req, url);
    }
    trace.label = route.label;
    if (route.name === 'unknown') throw new HttpError('ROUTE_NOT_FOUND');
    if (!route.methods.includes(req.method)) throw new HttpError('METHOD_NOT_ALLOWED', undefined, { Allow: route.methods.join(', ') });

    const context = await authenticate(req, trace);

    if (route.name === 'me') {
      readQuery(url, []);
      return respond(200, projectIdentity(context));
    }
    if (route.name === 'list') {
      const query = readQuery(url, ['estado']);
      const estado = query.has('estado') ? query.get('estado') : DEFAULT_ESTADO;
      return respond(200, { estado, items: approvalQueueService.listQueue(context, { estado }) });
    }

    readQuery(url, []);
    const id = decodeId(route.rawId);
    const reason = readReason(await readJsonBody(req), { required: route.name === 'reject' });
    const options = reason === undefined ? {} : { reason };
    const item =
      route.name === 'approve'
        ? approvalQueueService.approveProspect(context, id, options)
        : approvalQueueService.rejectProspect(context, id, options);
    return respond(200, { item });
  }

  // Toda resposta — de API, de arquivo ou de erro — sai com os cabeçalhos de segurança e o CSP.
  function finalize(response) {
    const headers = { ...response.headers, ...SECURITY_HEADERS, 'Content-Security-Policy': csp };
    if (response.body !== undefined && headers['Content-Length'] === undefined) headers['Content-Length'] = String(Buffer.byteLength(response.body));
    return { ...response, headers };
  }

  // Devolve { status, headers, body }. Nunca lança.
  async function handle(req) {
    const trace = { label: 'request', userId: null, token: null };
    let response;
    try {
      response = await dispatch(req, trace);
    } catch (error) {
      const failure = mapErrorToHttp(error);
      if (failure.status >= 500) log(`erro ${failure.status} em ${req.method} ${trace.label}: ${describeError(error, trace.token)}`);
      response = errorResponse(failure);
    }
    if (trace.label !== 'static') {
      log(`${req.method} ${trace.label} ${response.status}${trace.userId ? ` user=${trace.userId}` : ''}`);
    }
    return finalize(response);
  }

  async function listener(req, res) {
    let response;
    try {
      response = await handle(req);
    } catch (error) {
      response = finalize(errorResponse(mapErrorToHttp(error)));
    }
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  }

  return { handle, listener };
}

module.exports = { createApp, mapErrorToHttp, DEFAULT_ESTADO, MAX_BODY_BYTES };
