// Adaptador HTTP do Dashboard — a ÚNICA porta de entrada do navegador para o Approval Queue Service e o CRM Service.
//
//   navegador (dashboard/) -> HTTP /api/* -> ESTE MÓDULO -> Auth -> AuthorizationContext -> Approval Queue Service | CRM Service
//
// O navegador só fala HTTP. Este módulo não decide regra de negócio nem de permissão: ele autentica quem chama,
// monta o AuthorizationContext pelo fluxo já existente de src/auth, valida a FORMA da requisição, chama o Service
// e traduz o resultado (ou o erro) em HTTP. Quem autoriza é o Service — na fila, e de novo o domínio; no CRM o Service
// é a ÚNICA camada de autorização (decisão 0014), e por isso este módulo nunca chega ao domínio do CRM (regra R12):
// recebe o Service pronto, por injeção, e só chama os métodos dele.
//
// ROTAS (só estas; qualquer outra rota de /api é 404):
//   GET  /api/me                        a projeção segura do usuário autenticado
//   GET  /api/approvals[?estado=]       a fila (por padrão, AGUARDANDO_REVISAO)
//   POST /api/approvals/:id/approve     corpo { reason? }
//   POST /api/approvals/:id/reject      corpo { reason }   (motivo obrigatório)
// CRM (decisão 0015) — só existem quando o CRM Service é injetado; sem ele, /api/crm... é 404:
//   GET   /api/crm                      os registros                                    -> 200 { items }
//   POST  /api/crm                      cria; corpo = campos do registro + { status?, reason? } -> 201 { item, duplicidade }
//   GET   /api/crm/:id                  um registro                                     -> 200 { item }
//   PATCH /api/crm/:id                  edita campos; corpo = só os campos a mudar      -> 200 { item }
//   GET   /api/crm/:id/history          o histórico do registro                         -> 200 { historico }
//   POST  /api/crm/:id/status           muda o status; corpo { to, reason? }            -> 200 { item }
//   POST  /api/crm/:id/dnc              marca DO_NOT_CONTACT; corpo { reason? }         -> 200 { item }
// Não há exclusão, filtro nem busca: o Service não os tem, e a API não inventa operação.
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
// CRM: o corpo de POST/PATCH /api/crm é o REGISTRO (campos). Este módulo não conhece os nomes dos campos — só o domínio
// os conhece, e ele é inalcançável daqui (R12): o corpo vai ao Service, que o entrega ao domínio, e o domínio recusa (400)
// qualquer nome desconhecido, inclusive userId, role, permissions, reviewedBy, actor e authUserId. Nas rotas de ação
// (status, dnc) as chaves permitidas são fixas aqui (`to`, `reason`) e qualquer outra é 400 sem chegar ao Service. O
// Service autoriza ANTES de validar: sem WRITE:CRM a resposta é 403 mesmo com um corpo forjado. Só propriedades PRÓPRIAS
// do corpo contam, e o que vai ao Service nunca é lido do protótipo (um Object.prototype poluído não escolhe nada).
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
// A ÚNICA rota com corpo maior: a submissão de prospecção (até 500 achados brutos). O limite geral acima NÃO mudou; este vale só
// para POST /api/prospecting/submit e é conferido ANTES de ler o corpo (Content-Length) e durante a leitura (o corpo nunca é
// processado acima dele). Os limites estruturais do rawFindingSchema continuam valendo por dentro.
const MAX_PROSPECTING_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_TARGET_LENGTH = 4096;
const DEFAULT_AUTH_TIMEOUT_MS = 10000;

// O estado padrão da listagem. Duplica de propósito QUEUE_STATE.AGUARDANDO_REVISAO do domínio (este módulo não
// importa o domínio); um teste vigia que os dois não divirjam.
const DEFAULT_ESTADO = 'AGUARDANDO_REVISAO';

// As operações do CRM Service que a API usa (o contrato de src/services/crmService.js). Verificadas na criação do app.
const CRM_OPERATIONS = Object.freeze(['listRecords', 'getRecord', 'getHistory', 'createRecord', 'updateRecord', 'moveStatus', 'markDoNotContact']);

// A operação da promoção Approval Queue → CRM (src/services/crmIntegrationService.js) que a API usa. Verificada na criação.
const PROMOTION_OPERATION = 'promoteProspect';

// A operação do Prospecting Service (src/services/prospectingService.js) que a API usa. Verificada na criação.
const PROSPECTING_OPERATION = 'submitProspecting';

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
  // CRM (decisão 0015): conflitos com o estado do registro ou com outros registros. Mensagens FIXAS — nunca o id do
  // outro registro nem o critério que casou (o dado de um registro não sai na recusa de outro).
  DUPLICATE_RECORD: [409, 'Já existe um registro com esta identidade.'],
  DNC_BLOCKED: [409, 'Esta identidade está bloqueada como "não contatar".'],
  RECORD_LOCKED: [409, 'Este registro está bloqueado como "não contatar" e não pode ser alterado.'],
  INVALID_TRANSITION: [409, 'Esta mudança de status não é permitida.'],
  // Promoção Approval Queue → CRM (decisão 0016), por `code` estável do serviço. Mensagens FIXAS: nunca o id do registro
  // existente, o critério que casou nem o texto do serviço.
  PROMOTION_NOT_APPROVED: [409, 'Este prospect não está aprovado para o CRM.'],
  PROMOTION_APPROVAL_MISSING: [409, 'A aprovação deste prospect não está registrada. A promoção foi bloqueada.'],
  PROMOTION_BLOCKED_DNC: [409, 'Promoção bloqueada: existe uma restrição de contato para este prospect.'],
  PROMOTION_BLOCKED_DUPLICATE: [409, 'Este prospect parece já existir no CRM. A promoção foi bloqueada para não duplicar o registro.'],
  PROMOTION_INSUFFICIENT_DATA: [409, 'Os dados deste prospect não são suficientes para entrar no CRM.'],
  PROMOTION_INCONSISTENT: [409, 'O estado deste prospect está inconsistente entre a fila e o CRM. Nada foi alterado; peça uma revisão.'],
  PROMOTION_PARTIAL: [409, 'A promoção foi concluída só em parte. Tente promover de novo.'],
  // Prospecting Service V1, por `code` estável do serviço. Mensagens FIXAS: nunca o valor recusado, o texto do serviço, um
  // caminho, um id de prospect ou o texto do erro de armazenamento. A recusa de AUTORIZAÇÃO não passa por aqui (é 403 pelos
  // caminhos de sempre).
  PROSPECTING_INVALID_INPUT: [400, 'Submissão inválida: envie exatamente { briefing, rawFindings }.'],
  PROSPECTING_BRIEFING_INVALID: [400, 'O briefing é inválido.'],
  PROSPECTING_RAW_FINDINGS_INVALID: [400, 'Os achados da pesquisa são inválidos; nada foi processado.'],
  PROSPECTING_CANDIDATE_INVALID: [422, 'Um candidato não pôde ser processado; nada foi gravado.'],
  PROSPECTING_CONFLICT: [409, 'Conflito ao registrar o lote. Tente novamente.'],
  PROSPECTING_NOT_FOUND: [404, 'Lote não encontrado.'],
  PROSPECTING_CRM_INVALID: [503, 'Não foi possível ler o CRM agora; nada foi processado.'],
  PROSPECTING_PERSISTENCE: [503, 'Não foi possível ler ou gravar os dados locais agora. Tente novamente em instantes.'],
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
  // CRM (decisão 0015). As mensagens do CRM Service e do domínio do CRM têm o prefixo "CRM: ", que as distingue das da
  // fila; só entram aqui as que uma requisição HTTP consegue produzir — o resto (repositório defeituoso, registro
  // corrompido, autorizador defeituoso, opções que este módulo nunca envia) é bug ou falha de armazenamento: 500.
  // A ordem importa só entre padrões que possam casar a mesma mensagem, e estes não casam.
  [/^CRM: registro não encontrado/, 'NOT_FOUND'],
  [/^CRM: não é possível (?:criar — identidade já bloqueada|atualizar — a nova identidade coincide com a de um registro bloqueado)/, 'DNC_BLOCKED'],
  [/^CRM: não é possível (?:criar — já existe um registro|atualizar — a nova identidade coincide com a de outro registro)/, 'DUPLICATE_RECORD'],
  [/^CRM: registro bloqueado \(DO_NOT_CONTACT\) não pode ser atualizado/, 'RECORD_LOCKED'],
  [/^CRM: transição não permitida/, 'INVALID_TRANSITION'],
  [/^CRM: id deve ser um texto não vazio/, 'INVALID_REQUEST', 'Identificador inválido.'],
  [/^CRM: (?:createRecord|updateRecord) (?:não aceita campos gerenciados|tem campos desconhecidos)/, 'INVALID_REQUEST', 'Campos não permitidos na requisição.'],
  [/^CRM: (?:createRecord|updateRecord) — campo "/, 'INVALID_REQUEST', 'Valor inválido em um dos campos.'],
  [/^CRM: createRecord exige "empresa"/, 'INVALID_REQUEST', 'Informe a empresa.'],
  [/^CRM: updateRecord não pode deixar "empresa" vazia/, 'INVALID_REQUEST', 'A empresa não pode ficar vazia.'],
  [/^CRM: status desconhecido/, 'INVALID_REQUEST', 'Status inválido.'],
  [/^CRM: status deve ser um texto/, 'INVALID_REQUEST', 'Status inválido.'],
  [/^CRM: o status de destino deve ser um texto/, 'INVALID_REQUEST', 'Status inválido.'],
  [/^CRM: reason deve ser um texto/, 'INVALID_REQUEST', 'O motivo deve ser um texto.'],
]);

// Os `code` do serviço de promoção que a API reconhece. PROMOTION_INVALID_INPUT e PROMOTION_PROSPECT_NOT_FOUND viram os
// mesmos 400/404 das demais rotas; um teste vigia que esta lista não divirja de PROMOTION_ERROR.
const PROMOTION_CODES = Object.freeze({
  PROMOTION_INVALID_INPUT: 'INVALID_REQUEST',
  PROMOTION_PROSPECT_NOT_FOUND: 'NOT_FOUND',
  PROMOTION_NOT_APPROVED: 'PROMOTION_NOT_APPROVED',
  PROMOTION_APPROVAL_MISSING: 'PROMOTION_APPROVAL_MISSING',
  PROMOTION_BLOCKED_DNC: 'PROMOTION_BLOCKED_DNC',
  PROMOTION_BLOCKED_DUPLICATE: 'PROMOTION_BLOCKED_DUPLICATE',
  PROMOTION_INSUFFICIENT_DATA: 'PROMOTION_INSUFFICIENT_DATA',
  PROMOTION_INCONSISTENT: 'PROMOTION_INCONSISTENT',
  PROMOTION_PARTIAL: 'PROMOTION_PARTIAL',
});

// Os `code` do Prospecting Service que a API reconhece (o próprio código do serviço vira o código HTTP; o catálogo acima traz a
// mensagem fixa e o status). Um teste vigia que esta lista não diverge de PROSPECTING_ERROR.
const PROSPECTING_CODES = Object.freeze([
  'PROSPECTING_INVALID_INPUT',
  'PROSPECTING_BRIEFING_INVALID',
  'PROSPECTING_RAW_FINDINGS_INVALID',
  'PROSPECTING_CANDIDATE_INVALID',
  'PROSPECTING_CONFLICT',
  'PROSPECTING_NOT_FOUND',
  'PROSPECTING_CRM_INVALID',
  'PROSPECTING_PERSISTENCE',
]);

// Os detalhes de uma recusa de validação: só CAMINHO (formado por chaves conhecidas e índices) e CÓDIGO — nunca o valor recusado.
// Mesmo assim cada campo é reconferido aqui (forma e tamanho), no máximo 50 itens.
function safeDetails(details) {
  if (!details || typeof details !== 'object' || !Array.isArray(details.errors)) return undefined;
  const list = [];
  for (const item of details.errors.slice(0, 50)) {
    const path = item && typeof item.path === 'string' && /^[A-Za-z0-9_.[\]?]{0,120}$/.test(item.path) ? item.path : '';
    const itemCode = item && typeof item.code === 'string' && /^[A-Z_]{1,40}$/.test(item.code) ? item.code : 'INVALIDO';
    list.push({ path, code: itemCode });
  }
  return list;
}

// Dicas para o LOG de erros internos conhecidos — sem repetir a mensagem original, que pode trazer trechos de
// dados (um JSON de fila corrompido cita um pedaço do conteúdo).
const INTERNAL_HINTS = Object.freeze([
  [/^arquivo de fila corrompido/, 'a fila em disco está corrompida ou ilegível (confira RIO_X7_QUEUE_PATH e o arquivo)'],
  [/^CRM: arquivo de dados corrompido/, 'o arquivo do CRM em disco está corrompido ou ilegível (confira RIO_X7_CRM_PATH e o arquivo)'],
]);

// Traduz QUALQUER erro em { status, code, message, headers }. Nunca lança.
function mapErrorToHttp(error) {
  let code = 'INTERNAL';
  let detail;
  let headers;
  let details;
  if (error instanceof HttpError) {
    code = error.code;
    detail = error.detail;
    headers = error.headers;
  } else if (error instanceof SupabaseAdapterError) {
    code = error.category === CONNECTIVITY_ERROR.AUTH ? 'UNAUTHENTICATED' : 'AUTH_UNAVAILABLE';
  } else if (error instanceof UserResolutionError) {
    code = error.code === USER_NOT_FOUND ? 'NO_ACCESS' : 'INTERNAL';
  } else if (error && typeof error === 'object' && typeof error.code === 'string' && PROSPECTING_CODES.includes(error.code)) {
    code = error.code;
    // só as recusas de VALIDAÇÃO (400) levam caminho e código; nenhum outro erro carrega detalhe
    if (CATALOG[code][0] === 400) details = safeDetails(error.details);
  } else if (error && typeof error === 'object' && Object.prototype.hasOwnProperty.call(PROMOTION_CODES, error.code)) {
    code = PROMOTION_CODES[error.code];
    if (code === 'INVALID_REQUEST') detail = 'Identificador inválido.';
  } else {
    const message = error && typeof error.message === 'string' ? error.message : '';
    const known = KNOWN_MESSAGES.find(([pattern]) => pattern.test(message));
    if (known) {
      code = known[1];
      detail = known[2];
    }
  }
  const [status, message] = CATALOG[code] || CATALOG.INTERNAL;
  const failure = { status, code, message: code === 'INVALID_REQUEST' && detail ? detail : message, headers };
  if (details !== undefined) failure.details = details;
  return failure;
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
  const error = { code: failure.code, message: failure.message };
  if (failure.details !== undefined) error.details = failure.details;
  return respond(failure.status, { error }, failure.headers);
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
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError('UNSUPPORTED_MEDIA_TYPE');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError('PAYLOAD_TOO_LARGE', undefined, { Connection: 'close' });
  }
  const text = (await collectBody(req, limit)).toString('utf8');
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

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// O corpo de uma rota de AÇÃO do CRM (status, dnc): só as chaves listadas. Qualquer outra — userId, role, permissions,
// reviewedBy, actor, authUserId... — é 400 e nunca chega ao Service. Devolve um objeto SEM protótipo só com as chaves que o
// corpo tem como propriedade PRÓPRIA (nada herdado conta), com os valores como vieram: tipo e conteúdo são do Service.
function readActionBody(body, allowedKeys) {
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
  const picked = Object.create(null);
  for (const key of allowedKeys) {
    if (hasOwn(body, key)) picked[key] = body[key];
  }
  return picked;
}

// Separa o corpo de POST /api/crm em CAMPOS do registro e OPÇÕES do Service. `status` (o status inicial) e `reason` (o
// motivo da entrada) são as únicas opções de createRecord; todo o resto é campo, e quem sabe quais campos existem é o
// domínio, que recusa os desconhecidos. Os campos vão para um objeto SEM protótipo: uma chave "__proto__" do JSON vira
// uma propriedade comum (que o domínio recusa), nunca troca o protótipo de nada.
function splitCreateBody(body) {
  const fields = Object.create(null);
  const options = {};
  for (const key of Object.keys(body)) {
    if (key === 'status' || key === 'reason') options[key] = body[key];
    else fields[key] = body[key];
  }
  return { fields, options };
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

// `crm`: as rotas do CRM só existem quando o CRM Service foi injetado; sem ele, /api/crm... é uma rota desconhecida (404).
function matchRoute(pathname, { crm, promotion, prospecting }) {
  if (pathname === '/api/me') return { name: 'me', label: '/api/me', methods: ['GET'] };
  if (pathname === '/api/approvals') return { name: 'list', label: '/api/approvals', methods: ['GET'] };
  if (prospecting && pathname === '/api/prospecting/submit') return { name: 'prospecting-submit', label: '/api/prospecting/submit', methods: ['POST'] };
  if (promotion) {
    const promote = /^\/api\/approvals\/([^/]+)\/promote$/.exec(pathname);
    if (promote) return { name: 'promote', label: '/api/approvals/:id/promote', methods: ['POST'], rawId: promote[1] };
  }
  const decision = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (decision) return { name: decision[2], label: `/api/approvals/:id/${decision[2]}`, methods: ['POST'], rawId: decision[1] };
  if (crm) {
    if (pathname === '/api/crm') return { family: 'crm', name: 'crm-collection', label: '/api/crm', methods: ['GET', 'POST'] };
    const item = /^\/api\/crm\/([^/]+)(?:\/(history|status|dnc))?$/.exec(pathname);
    if (item) {
      const [, rawId, action] = item;
      if (action === undefined) return { family: 'crm', name: 'crm-item', label: '/api/crm/:id', methods: ['GET', 'PATCH'], rawId };
      if (action === 'history') return { family: 'crm', name: 'crm-history', label: '/api/crm/:id/history', methods: ['GET'], rawId };
      return { family: 'crm', name: `crm-${action}`, label: `/api/crm/:id/${action}`, methods: ['POST'], rawId };
    }
  }
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
// crmService: o CRM Service (as 7 operações de CRM_OPERATIONS) — OPCIONAL: sem ele as rotas /api/crm não existem (404).
//   Presente, é validado por inteiro na criação (falha fechada); `null` não é "ausente", é erro.
// crmIntegrationService: a promoção Approval Queue → CRM (promoteProspect) — OPCIONAL: sem ele a rota de promoção não existe (404).
// prospectingService: o Prospecting Service (submitProspecting) — OPCIONAL: sem ele a rota de submissão não existe (404).
// publicConfig: { supabaseUrl, supabaseAnonKey } — os valores PÚBLICOS que o navegador recebe.
// staticRoot / staticFiles: os arquivos do Dashboard (ver static.js).
// log: (texto) => void. authTimeoutMs: quanto esperar pela verificação do token.
function createApp(dependencies) {
  const { verifyAccessToken, userStore, approvalQueueService, crmService, crmIntegrationService, prospectingService, publicConfig, staticRoot, staticFiles, log = () => {}, authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS } =
    dependencies || {};
  requireFunction(verifyAccessToken, 'verifyAccessToken');
  requireFunction(log, 'log');
  if (!userStore || typeof userStore.findByAuthUserId !== 'function') throw new Error('createApp exige { userStore } (com findByAuthUserId)');
  for (const operation of ['listQueue', 'approveProspect', 'rejectProspect']) {
    if (!approvalQueueService || typeof approvalQueueService[operation] !== 'function') {
      throw new Error(`createApp exige { approvalQueueService } com ${operation}()`);
    }
  }
  if (crmService !== undefined) {
    for (const operation of CRM_OPERATIONS) {
      if (!crmService || typeof crmService[operation] !== 'function') throw new Error(`createApp exige { crmService } com ${operation}()`);
    }
  }
  if (crmIntegrationService !== undefined && (!crmIntegrationService || typeof crmIntegrationService[PROMOTION_OPERATION] !== 'function')) {
    throw new Error(`createApp exige { crmIntegrationService } com ${PROMOTION_OPERATION}()`);
  }
  if (prospectingService !== undefined && (!prospectingService || typeof prospectingService[PROSPECTING_OPERATION] !== 'function')) {
    throw new Error(`createApp exige { prospectingService } com ${PROSPECTING_OPERATION}()`);
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

  // As rotas do CRM (decisão 0015). Cada uma só traduz HTTP <-> uma chamada ao CRM Service, com o AuthorizationContext
  // que veio do token; a permissão (READ:CRM / WRITE:CRM), as regras do domínio e a identidade gravada no histórico são
  // do Service. Nada aqui importa o domínio, nem decide autorização, nem lê identidade do navegador.
  async function dispatchCrm(req, url, route, context) {
    readQuery(url, []); // sem filtros nem busca: o Service não os tem
    if (route.name === 'crm-collection') {
      if (req.method === 'GET') return respond(200, { items: crmService.listRecords(context) });
      const { fields, options } = splitCreateBody(await readJsonBody(req));
      const created = crmService.createRecord(context, fields, options);
      return respond(201, { item: created.record, duplicidade: created.duplicidade });
    }

    const id = decodeId(route.rawId);
    if (route.name === 'crm-history') return respond(200, { historico: crmService.getHistory(context, id) });
    if (route.name === 'crm-item') {
      if (req.method === 'GET') {
        const item = crmService.getRecord(context, id);
        if (item === null) throw new HttpError('NOT_FOUND');
        return respond(200, { item });
      }
      return respond(200, { item: crmService.updateRecord(context, id, await readJsonBody(req)) });
    }
    if (route.name === 'crm-status') {
      const picked = readActionBody(await readJsonBody(req), ['to', 'reason']);
      const options = hasOwn(picked, 'reason') ? { reason: picked.reason } : {};
      return respond(200, { item: crmService.moveStatus(context, id, picked.to, options) });
    }
    if (route.name === 'crm-dnc') {
      return respond(200, { item: crmService.markDoNotContact(context, id, readActionBody(await readJsonBody(req), ['reason'])) });
    }
    // Inalcançável: matchRoute só produz as cinco rotas acima. Existe para que uma rota nova, ainda sem tratamento aqui,
    // nunca caia por omissão numa operação de escrita (marcar DO_NOT_CONTACT).
    throw new HttpError('ROUTE_NOT_FOUND');
  }

  async function dispatch(req, trace) {
    const url = parseTarget(req);
    const route = matchRoute(url.pathname, { crm: crmService !== undefined, promotion: crmIntegrationService !== undefined, prospecting: prospectingService !== undefined });
    if (route === null) {
      trace.label = 'static';
      return serveStatic(req, url);
    }
    trace.label = route.label;
    if (route.name === 'unknown') throw new HttpError('ROUTE_NOT_FOUND');
    if (!route.methods.includes(req.method)) throw new HttpError('METHOD_NOT_ALLOWED', undefined, { Allow: route.methods.join(', ') });

    const context = await authenticate(req, trace);

    if (route.family === 'crm') return dispatchCrm(req, url, route, context);

    if (route.name === 'prospecting-submit') {
      // Só transporte: sem query, corpo JSON (objeto) de até 2 MiB, e o objeto INTEIRO vai ao serviço — que decide (autoriza
      // PROPOSE e READ do CRM, aceita exatamente { briefing, rawFindings } e deriva autor, lote, datas e contagens). O autor é o
      // `context` desta requisição (a identidade verificada), nunca algo do corpo. O relatório do serviço sai como está.
      readQuery(url, []);
      const submission = await readJsonBody(req, MAX_PROSPECTING_BODY_BYTES);
      return respond(201, await prospectingService.submitProspecting(context, submission));
    }

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
    if (route.name === 'promote') {
      // A ÚNICA entrada é o id do prospect (na URL). O corpo tem de ser {}: nada que decide a promoção vem do cliente —
      // nem estado, nem approvalId, nem actor, nem userId, nem role, nem permissions.
      if (Object.keys(await readJsonBody(req)).length > 0) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
      const promoted = await crmIntegrationService.promoteProspect(context, id);
      // Resultado SEGURO: só o desfecho, os dois ids e se há sinal de duplicidade (o registro inteiro e a outra
      // identidade não saem daqui).
      return respond(200, {
        outcome: promoted.outcome,
        prospectId: promoted.prospectId,
        crmRecordId: promoted.crmRecordId,
        possivelDuplicidade: promoted.possivelDuplicidade !== null && promoted.possivelDuplicidade !== undefined,
      });
    }
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

module.exports = { createApp, mapErrorToHttp, DEFAULT_ESTADO, MAX_BODY_BYTES, MAX_PROSPECTING_BODY_BYTES };
