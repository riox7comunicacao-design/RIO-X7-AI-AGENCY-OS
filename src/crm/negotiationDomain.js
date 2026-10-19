// Domínio de NEGOCIAÇÕES (CRM 5.0, Fase D1, decisão 0028): a oportunidade comercial de UM cliente (um registro do CRM) por UM serviço do catálogo, num funil, com as condições
// ACORDADAS — prazo contratual, forma de pagamento, periodicidade e valor. Regras de negócio puras sobre repositórios injetados (a porta de negociações, a de funis e a do CRM); nunca
// autorização, HTTP nem um adaptador específico — o mesmo princípio de funnelDomain.js e catalogDomain.js.
//
// O QUE ESTE DOMÍNIO GARANTE
//   - UM cliente pode ter VÁRIAS negociações, até no mesmo funil: o card do funil REPRESENTA a negociação (funnelDomain.createNegotiationCard) e a etapa vive no card.
//   - A forma de pagamento (único ou recorrente) e a periodicidade são ESCOLHIDAS AQUI, dentro do que o SERVIÇO permite (catálogo, decisão 0027) — nada disto altera o catálogo: o preço
//     de referência e as modalidades do serviço nunca são lidos para calcular nem gravados. O nome do serviço é copiado como FOTO (para o histórico não mudar se o catálogo mudar).
//   - O prazo é independente da periodicidade; a combinação que não fecha (prazo que não é múltiplo da periodicidade) é BLOQUEADA — ver negotiationFinance.js.
//   - (Fase D3) A DURAÇÃO do contrato é DEFINIDA (o prazo em meses) ou INDETERMINADA (sem prazo final, só recorrente): nesta o prazo é `null`, o TCV é indeterminado (`null`, nunca zero nem estimado) e o AVISO PRÉVIO de
//     cancelamento (`avisoPrevioDias`, opcional) é só uma condição do contrato — não é duração, período mínimo nem cobrança. Uma negociação anterior à D3 (sem `duracao`) vale como DEFINIDA, sem nenhuma alteração.
//   - Os 31 campos legados do CRM (valorProposta, valorTotal…) NUNCA são lidos nem gravados por aqui. O valor negociado desta negociação é outro campo, de outra entidade.
//   - A situação segue ABERTA -> GANHA | PERDIDA; só uma negociação ABERTA se edita ou muda de etapa; reabrir é uma decisão separada (autorização mais alta, no Service). GANHA não é
//     "dinheiro recebido": o valor recebido virá de eventos de pagamento (fase futura).
//   - Um histórico APPEND-ONLY (`eventos`) dentro da negociação: criada, atualizada (campo, de, para), mudou de etapa, ganha, perdida (com o motivo), reaberta — sempre com quem e quando.
//   - Nunca se apaga. Nenhuma gravação é "silenciosa": o que não foi enviado num PATCH é preservado, e um PATCH sem mudança real não grava nada.
//   - ESCRITAS serializadas por repositório (como o catálogo e o CRM): duas edições simultâneas nunca se perdem uma à outra.

const crypto = require('node:crypto');

const { assertValidNegotiationRepository, NEGOTIATION_REPOSITORY_ERROR } = require('./negotiationRepositoryPort');
const { assertValidFunnelRepository } = require('./funnelRepositoryPort');
const funnelDomain = require('./funnelDomain');
const { BILLING, DURATION, PERIODICITIES, LIMITS, computeFinance } = require('./negotiationFinance');
const { CRM_STATUS } = require('./constants');

const NEGOTIATION_ERROR = Object.freeze({
  INVALID_INPUT: 'NEGOTIATION_INVALID_INPUT',
  NOT_FOUND: 'NEGOTIATION_NOT_FOUND',
  CLOSED: 'NEGOTIATION_CLOSED',
  INVALID_STATE: 'NEGOTIATION_INVALID_STATE',
  CONFLICT: 'NEGOTIATION_CONFLICT',
  PERSISTENCE: 'NEGOTIATION_PERSISTENCE',
});

const SITUATION = Object.freeze({ OPEN: 'ABERTA', WON: 'GANHA', LOST: 'PERDIDA' });
const EVENT = Object.freeze({ CREATED: 'CRIADA', UPDATED: 'ATUALIZADA', MOVED: 'ETAPA', WON: 'GANHA', LOST: 'PERDIDA', REOPENED: 'REABERTA' });
const LIMIT = Object.freeze({ MOTIVO_PERDA: 300, ID: 200, MOTIVO_ETAPA: 300 });

class NegotiationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'NegotiationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = (value) => structuredClone(value);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠﻿]/;

function invalidInput(errors) {
  const summary = errors.slice(0, 5).map((error) => (error.path ? `${error.path}: ${error.code}` : error.code)).join('; ');
  return new NegotiationError(NEGOTIATION_ERROR.INVALID_INPUT, `Negociação: dados inválidos (${summary}).`, { errors });
}
const notFound = () => new NegotiationError(NEGOTIATION_ERROR.NOT_FOUND, 'Negociação: não encontrada.');
const closedError = () => new NegotiationError(NEGOTIATION_ERROR.CLOSED, 'Negociação: só uma negociação ABERTA pode ser editada ou mudar de etapa.');
const invalidState = (message) => new NegotiationError(NEGOTIATION_ERROR.INVALID_STATE, `Negociação: ${message}`);

// ---------------------------------------------------------------------------------------------------------------------------------
// ENTRADA — um verificador por campo. Cada um devolve { ok, value } ou { ok: false, code }; o caminho é o nome do campo.
// ---------------------------------------------------------------------------------------------------------------------------------
const checkId = (value) => (typeof value === 'string' && value.trim() !== '' && value.length <= LIMIT.ID && !CONTROL.test(value) ? { ok: true, value } : { ok: false, code: typeof value === 'string' ? 'ID_INVALIDO' : 'TIPO_INVALIDO' });
const checkInteger = (value) => (Number.isInteger(value) ? { ok: true, value } : { ok: false, code: typeof value === 'number' ? 'VALOR_INVALIDO' : 'TIPO_INVALIDO' });
const checkNumber = (value) => (typeof value === 'number' ? { ok: true, value } : { ok: false, code: 'TIPO_INVALIDO' });
// prazo: inteiro, ou null (contrato INDETERMINADO; o estado final decide se vale)
const checkTerm = (value) => (value === null ? { ok: true, value: null } : checkInteger(value));
const checkNotice = (value) => (value === null ? { ok: true, value: null } : checkInteger(value));
const checkDuration = (value) => (typeof value !== 'string' ? { ok: false, code: 'TIPO_INVALIDO' } : Object.values(DURATION).includes(value) ? { ok: true, value } : { ok: false, code: 'VALOR_INVALIDO' });
const checkBilling = (value) => (typeof value !== 'string' ? { ok: false, code: 'TIPO_INVALIDO' } : Object.values(BILLING).includes(value) ? { ok: true, value } : { ok: false, code: 'VALOR_INVALIDO' });
function checkPeriodicity(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, code: 'TIPO_INVALIDO' };
  return PERIODICITIES.includes(value) ? { ok: true, value } : { ok: false, code: 'VALOR_INVALIDO' };
}
function checkDate(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, code: 'TIPO_INVALIDO' };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { ok: false, code: 'DATA_INVALIDA' };
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const real = date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
  return real ? { ok: true, value } : { ok: false, code: 'DATA_INVALIDA' };
}
function checkReason(max) {
  return (value) => {
    if (typeof value !== 'string') return { ok: false, code: 'TIPO_INVALIDO' };
    const text = value.replace(/\s+/g, ' ').trim();
    if (text === '') return { ok: false, code: 'OBRIGATORIO' };
    if (text.length > max) return { ok: false, code: 'MUITO_LONGO' };
    if (CONTROL.test(text)) return { ok: false, code: 'CARACTERE_INVALIDO' };
    return { ok: true, value: text };
  };
}

// Os campos que se enviam ao CRIAR e os que se podem EDITAR (as referências — cliente, funil — nunca mudam depois).
const CREATE_FIELDS = Object.freeze({ crmRecordId: checkId, funnelId: checkId, serviceId: checkId, duracao: checkDuration, prazoMeses: checkTerm, avisoPrevioDias: checkNotice, formaPagamento: checkBilling, periodicidade: checkPeriodicity, valorNegociado: checkNumber, previsaoFechamento: checkDate });
// o prazo só é obrigatório quando a duração é DEFINIDA (o padrão; ver createNegotiation)
const REQUIRED_ON_CREATE = Object.freeze(['crmRecordId', 'funnelId', 'serviceId', 'formaPagamento', 'valorNegociado']);
const EDITABLE_FIELDS = Object.freeze(['serviceId', 'prazoMeses', 'formaPagamento', 'periodicidade', 'valorNegociado', 'previsaoFechamento', 'duracao', 'avisoPrevioDias']);
const NON_EDITABLE = Object.freeze(['id', 'crmRecordId', 'funnelId', 'cardId', 'situacao', 'motivoPerda', 'fechadoEm', 'criadoEm', 'atualizadoEm', 'criadoPorUserId', 'criadoPorNome', 'atualizadoPorUserId', 'atualizadoPorNome', 'responsavelUserId', 'responsavelNome', 'servicoNome', 'eventos', 'stageId']);
const SAFE_PATH = /^[A-Za-z0-9_]{1,40}$/;

// Lê só os campos permitidos de `input`; devolve { value (sem protótipo), errors }.
function readFields(input, allowed) {
  const value = Object.create(null);
  const errors = [];
  if (!isPlainObject(input)) return { value, errors: [{ path: '', code: 'TIPO_INVALIDO' }] };
  for (const key of Object.keys(input)) {
    if (allowed.includes(key)) continue;
    errors.push({ path: SAFE_PATH.test(key) ? key : '', code: NON_EDITABLE.includes(key) ? 'CAMPO_NAO_EDITAVEL' : 'CAMPO_DESCONHECIDO' });
  }
  for (const key of allowed) {
    if (!hasOwn(input, key)) continue;
    const checked = CREATE_FIELDS[key](input[key]);
    if (checked.ok) value[key] = checked.value;
    else errors.push({ path: key, code: checked.code });
  }
  return { value, errors };
}

// Os erros do cálculo financeiro viram erros por CAMPO.
const FINANCE_PATH = Object.freeze({
  VALOR_INVALIDO: 'valorNegociado',
  PRAZO_INVALIDO: 'prazoMeses',
  PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE: 'prazoMeses',
  FORMA_PAGAMENTO_INVALIDA: 'formaPagamento',
  PERIODICIDADE_OBRIGATORIA: 'periodicidade',
  PERIODICIDADE_INVALIDA: 'periodicidade',
  PERIODICIDADE_NAO_PERMITIDA: 'periodicidade',
  DURACAO_INVALIDA: 'duracao',
  DURACAO_INDETERMINADA_EXIGE_RECORRENCIA: 'duracao',
  PRAZO_PROIBIDO_NO_INDETERMINADO: 'prazoMeses',
});

// O AVISO PRÉVIO (dias): só existe num contrato INDETERMINADO, de 1 a 365; num de duração definida é recusado (as condições dele continuam as de sempre).
function noticeErrors(state) {
  const notice = state.avisoPrevioDias === undefined ? null : state.avisoPrevioDias;
  if (notice === null) return [];
  if (state.duracao !== DURATION.INDETERMINADA) return [{ path: 'avisoPrevioDias', code: 'AVISO_PREVIO_NAO_PERMITIDO' }];
  return Number.isInteger(notice) && notice >= LIMITS.AVISO_PREVIO_MINIMO && notice <= LIMITS.AVISO_PREVIO_MAXIMO ? [] : [{ path: 'avisoPrevioDias', code: 'AVISO_PREVIO_INVALIDO' }];
}

// Uma negociação anterior à D3 não traz a duração nem o aviso prévio: vale como DEFINIDA, sem aviso (nada é gravado por causa disto).
const withContractDefaults = (negotiation) => ({ ...negotiation, duracao: negotiation.duracao ?? DURATION.DEFINIDA, avisoPrevioDias: negotiation.avisoPrevioDias ?? null });

// O que o SERVIÇO permite (catálogo): `service` = { id, nome, ativo, permitePagamentoUnico, permitePagamentoRecorrente, periodicidades }.
function serviceErrors(state, service, { checkChoice, checkActive }) {
  const errors = [];
  if (!service || typeof service !== 'object' || service.id !== state.serviceId) return [{ path: 'serviceId', code: 'SERVICO_NAO_ENCONTRADO' }];
  if (checkActive && service.ativo === false) errors.push({ path: 'serviceId', code: 'SERVICO_INATIVO' });
  const unique = service.permitePagamentoUnico === true;
  const recurring = service.permitePagamentoRecorrente === true;
  if (!unique && !recurring) {
    // um serviço LEGADO sem nenhuma forma de pagamento informada: o ADMIN a completa no catálogo — nada é presumido aqui
    if (checkChoice || checkActive) errors.push({ path: 'serviceId', code: 'SERVICO_SEM_MODALIDADE' });
    return errors;
  }
  if (checkChoice) {
    if (state.formaPagamento === BILLING.UNICO && !unique) errors.push({ path: 'formaPagamento', code: 'FORMA_NAO_PERMITIDA_PELO_SERVICO' });
    if (state.formaPagamento === BILLING.RECORRENTE) {
      if (!recurring) errors.push({ path: 'formaPagamento', code: 'FORMA_NAO_PERMITIDA_PELO_SERVICO' });
      else if (PERIODICITIES.includes(state.periodicidade) && !(Array.isArray(service.periodicidades) && service.periodicidades.includes(state.periodicidade))) errors.push({ path: 'periodicidade', code: 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO' });
    }
  }
  return errors;
}

// Valida o ESTADO resultante (criação ou edição): finanças e regras do serviço.
function stateErrors(state, service, options) {
  const errors = [];
  const finance = computeFinance(state);
  if (!finance.ok) errors.push({ path: FINANCE_PATH[finance.code] || '', code: finance.code });
  errors.push(...noticeErrors(state));
  const known = new Set(errors.map((error) => error.path));
  for (const error of serviceErrors(state, service, options)) if (!(known.has(error.path) && error.path !== 'serviceId')) errors.push(error);
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// SERIALIZAÇÃO das ESCRITAS de um mesmo repositório (leituras não esperam).
// ---------------------------------------------------------------------------------------------------------------------------------
const writeTails = new WeakMap();
function serialized(repository, task) {
  const run = (writeTails.get(repository) || Promise.resolve()).then(task);
  writeTails.set(repository, run.then(() => undefined, () => undefined));
  return run;
}

// Uma falha do ARMAZENAMENTO vira um erro de domínio de mensagem FIXA (a causa fica só em `cause`, nunca vai ao cliente).
async function viaRepository(task) {
  try {
    return await task();
  } catch (cause) {
    if (cause instanceof NegotiationError) throw cause;
    const known = cause && typeof cause.code === 'string' ? cause.code : null;
    if (known === NEGOTIATION_REPOSITORY_ERROR.NOT_FOUND) throw notFound();
    if (known === NEGOTIATION_REPOSITORY_ERROR.CLOSED) throw closedError();
    if (known === NEGOTIATION_REPOSITORY_ERROR.CONFLICT) {
      const conflict = new NegotiationError(NEGOTIATION_ERROR.CONFLICT, 'Negociação: foi alterada por outra pessoa; atualize e tente de novo.');
      conflict.cause = cause;
      throw conflict;
    }
    if (known === NEGOTIATION_REPOSITORY_ERROR.REJECTED) {
      const rejected = invalidState('o banco recusou a alteração pelas regras da negociação.');
      rejected.cause = cause;
      throw rejected;
    }
    const error = new NegotiationError(NEGOTIATION_ERROR.PERSISTENCE, 'Negociação: não foi possível ler ou gravar as negociações agora.');
    error.cause = cause;
    throw error;
  }
}

function requireDeps(deps) {
  const { repository, funnelRepository, crmRepository } = deps || {};
  assertValidNegotiationRepository(repository);
  assertValidFunnelRepository(funnelRepository);
  if (!crmRepository || typeof crmRepository.getById !== 'function') throw new Error('Negociação: crmRepository inválido — falta getById()');
  return { repository, funnelRepository, crmRepository };
}

function requireOperator(operator) {
  if (!isPlainObject(operator) || typeof operator.userId !== 'string' || operator.userId.trim() === '' || typeof operator.name !== 'string' || operator.name.trim() === '') {
    throw new Error('Negociação: operador inválido — esperava { userId, name } (texto não vazio)');
  }
  return { userId: operator.userId.trim(), name: operator.name.trim(), ...(typeof operator.role === 'string' && operator.role.trim() !== '' ? { role: operator.role.trim() } : {}) };
}

function requireId(id) {
  const checked = checkId(id);
  if (!checked.ok) throw invalidInput([{ path: 'id', code: 'ID_INVALIDO' }]);
  return checked.value;
}

// GRAVA uma mudança da negociação — a ÚNICA porta de escrita deste domínio.
//   - repositório com `commit` (Supabase): UMA transação grava a negociação, os eventos novos do histórico e (criação/mudança de etapa) o card e o movimento do card. Nada é gravado pela
//     metade e o histórico obrigatório nunca fica de fora; `previous` é a negociação como foi LIDA (a concorrência otimista compara o `atualizadoEm`).
//   - sem `commit` (arquivo, só desenvolvimento isolado e testes): o card e o movimento, depois a negociação — e, se a negociação falhar numa CRIAÇÃO, o card é arquivado (nunca fica órfão).
async function persistChange(d, { mode, negotiation, previous = null, card = null, move = null }) {
  if (typeof d.repository.commit === 'function') {
    await viaRepository(() => d.repository.commit({ mode, negotiation, expectedUpdatedAt: previous ? previous.atualizadoEm : null, card, cardMove: move }));
    return;
  }
  if (card !== null) {
    await viaRepository(async () => {
      if (typeof d.funnelRepository.commitCardChange === 'function') await d.funnelRepository.commitCardChange({ card, move, expectedStageId: move.stageFrom });
      else {
        await d.funnelRepository.saveCard(card);
        await d.funnelRepository.saveCardMove(move);
      }
    });
  }
  try {
    await viaRepository(() => d.repository.save(negotiation));
  } catch (error) {
    if (mode === 'create' && card !== null) await Promise.resolve(d.funnelRepository.archiveCard(card.id)).catch(() => undefined);
    throw error;
  }
}

const nowIso = (options) => (options && typeof options.now === 'function' ? options.now() : new Date()).toISOString();
const event = (type, operator, at, detail) => ({ tipo: type, em: at, porUserId: operator.userId, porNome: operator.name, ...(detail === undefined ? {} : { detalhe: detail }) });

async function loadNegotiation(repository, id) {
  const found = await viaRepository(() => repository.getById(requireId(id)));
  if (!found || typeof found !== 'object' || found.id !== id) throw notFound();
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// PROJEÇÃO: a negociação + o que se deriva dela (finanças) + onde ela está no funil (a etapa vive no CARD). Nada é gravado a partir daqui.
// ---------------------------------------------------------------------------------------------------------------------------------
function financeOf(negotiation) {
  const finance = computeFinance(negotiation);
  return finance.ok ? finance : null;
}

async function toView(deps, negotiation, cache = new Map()) {
  const { funnelRepository } = deps;
  const lookup = async (key, load) => {
    if (!cache.has(key)) cache.set(key, Promise.resolve(load()).catch(() => null));
    return cache.get(key);
  };
  const card = await lookup(`card:${negotiation.cardId}`, () => funnelRepository.getCard(negotiation.cardId));
  const stage = card ? await lookup(`stage:${card.stageId}`, () => funnelRepository.getStage(card.stageId)) : null;
  const funnel = await lookup(`funnel:${negotiation.funnelId}`, () => funnelRepository.getFunnel(negotiation.funnelId));
  const finance = financeOf(negotiation);
  return {
    ...clone(negotiation),
    ...withContractDefaults({ duracao: negotiation.duracao, avisoPrevioDias: negotiation.avisoPrevioDias }),
    stageId: card ? card.stageId : null,
    stageNome: stage ? stage.nome : null,
    funnelNome: funnel ? funnel.nome : null,
    financeiro: finance
      ? { tcv: finance.tcv, tcvIndeterminado: finance.tcvIndeterminado, mrr: finance.mrr, equivalenteMensal: finance.equivalenteMensal, tcvCentavos: finance.tcvCentavos, mrrCentavos: finance.mrrCentavos, equivalenteMensalCentavos: finance.equivalenteMensalCentavos, cronograma: { ...finance.cronograma } }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// OPERAÇÕES
// ---------------------------------------------------------------------------------------------------------------------------------
async function getNegotiation(deps, id) {
  const d = requireDeps(deps);
  const found = await loadNegotiation(d.repository, id).catch((error) => (error.code === NEGOTIATION_ERROR.NOT_FOUND ? null : Promise.reject(error)));
  return found === null ? null : toView(d, found);
}

// Todas as negociações (ou as de um funil / situação / cliente), da mais recente para a mais antiga. `options`: { funnelId, situacao, crmRecordId }.
async function listNegotiations(deps, options = {}) {
  const d = requireDeps(deps);
  const all = await viaRepository(() => d.repository.list());
  if (!Array.isArray(all)) throw new NegotiationError(NEGOTIATION_ERROR.PERSISTENCE, 'Negociação: não foi possível ler as negociações agora.');
  const chosen = all.filter((item) => item && typeof item.id === 'string' && (options.funnelId === undefined || item.funnelId === options.funnelId) && (options.situacao === undefined || item.situacao === options.situacao) && (options.crmRecordId === undefined || item.crmRecordId === options.crmRecordId));
  chosen.sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : a.criadoEm > b.criadoEm ? -1 : a.id < b.id ? -1 : 1));
  const cache = new Map();
  return Promise.all(chosen.map((item) => toView(d, item, cache)));
}

// Cria a negociação (e o card do funil que a representa, na primeira etapa ativa). `service`: o serviço do catálogo lido por quem chama (o domínio não conhece o catálogo).
async function createNegotiation(deps, input, service, operator, options = {}) {
  const d = requireDeps(deps);
  const author = requireOperator(operator);
  return serialized(d.repository, async () => {
    const { value, errors } = readFields(input, Object.keys(CREATE_FIELDS));
    const duration = hasOwn(value, 'duracao') ? value.duracao : DURATION.DEFINIDA;
    const required = duration === DURATION.INDETERMINADA ? REQUIRED_ON_CREATE : [...REQUIRED_ON_CREATE, 'prazoMeses'];
    for (const key of required) if (!hasOwn(value, key) && !errors.some((error) => error.path === key)) errors.push({ path: key, code: 'OBRIGATORIO' });
    const state = { periodicidade: null, previsaoFechamento: null, avisoPrevioDias: null, ...value, duracao: duration };
    if (duration === DURATION.INDETERMINADA && !hasOwn(value, 'prazoMeses')) state.prazoMeses = null;
    if (errors.length === 0) {
      // as REFERÊNCIAS: o cliente (registro do CRM) e o funil têm de existir; o funil, estar ativo
      const record = await viaRepository(() => d.crmRepository.getById(state.crmRecordId));
      if (!record || typeof record !== 'object' || record.id !== state.crmRecordId) errors.push({ path: 'crmRecordId', code: 'CLIENTE_NAO_ENCONTRADO' });
      else if (record.status === CRM_STATUS.DO_NOT_CONTACT) errors.push({ path: 'crmRecordId', code: 'CLIENTE_NAO_CONTATAR' }); // Não Contatar é terminal: nenhuma negociação nova para quem pediu para não ser contatado
      const funnel = await viaRepository(() => d.funnelRepository.getFunnel(state.funnelId));
      if (!funnel || typeof funnel !== 'object' || funnel.id !== state.funnelId) errors.push({ path: 'funnelId', code: 'FUNIL_NAO_ENCONTRADO' });
      else if (funnel.ativo === false) errors.push({ path: 'funnelId', code: 'FUNIL_INATIVO' });
      errors.push(...stateErrors(state, service, { checkChoice: true, checkActive: true }));
    }
    if (errors.length > 0) throw invalidInput(errors);

    const at = nowIso(options);
    const id = `negotiation:${crypto.randomUUID()}`;
    // 1) o card (a posição no funil) — 2) a negociação. Se a gravação da negociação falhar, o card é arquivado (nunca fica um card órfão visível).
    let card;
    let cardMove;
    try {
      ({ card, move: cardMove } = await funnelDomain.planNegotiationCard(d.funnelRepository, d.crmRepository, { funnelId: state.funnelId, crmRecordId: state.crmRecordId, negotiationId: id }, { reviewedBy: author }));
    } catch (cause) {
      if (cause && cause.code === 'FUNNEL_HAS_NO_STAGES') throw invalidInput([{ path: 'funnelId', code: 'FUNIL_SEM_ETAPAS' }]);
      throw cause instanceof NegotiationError ? cause : Object.assign(new NegotiationError(NEGOTIATION_ERROR.PERSISTENCE, 'Negociação: não foi possível criar o card no funil.'), { cause });
    }
    const negotiation = {
      id,
      crmRecordId: state.crmRecordId,
      funnelId: state.funnelId,
      cardId: card.id,
      serviceId: state.serviceId,
      servicoNome: typeof service.nome === 'string' ? service.nome : null,
      responsavelUserId: author.userId,
      responsavelNome: author.name,
      duracao: state.duracao,
      prazoMeses: state.duracao === DURATION.INDETERMINADA ? null : state.prazoMeses,
      avisoPrevioDias: state.duracao === DURATION.INDETERMINADA ? state.avisoPrevioDias : null,
      formaPagamento: state.formaPagamento,
      periodicidade: state.formaPagamento === BILLING.RECORRENTE ? state.periodicidade : null,
      valorNegociado: state.valorNegociado,
      previsaoFechamento: state.previsaoFechamento,
      situacao: SITUATION.OPEN,
      motivoPerda: null,
      fechadoEm: null,
      criadoEm: at,
      atualizadoEm: at,
      criadoPorUserId: author.userId,
      criadoPorNome: author.name,
      atualizadoPorUserId: author.userId,
      atualizadoPorNome: author.name,
      eventos: [event(EVENT.CREATED, author, at, { etapaId: card.stageId })],
    };
    await persistChange(d, { mode: 'create', negotiation, card, move: cardMove });
    return toView(d, negotiation);
  });
}

// Edita (PATCH PARCIAL): só os campos enviados mudam; o resultado é validado como um TODO. `service`: o serviço do estado RESULTANTE (o atual, ou o novo se `serviceId` mudou).
async function updateNegotiation(deps, id, patch, service, operator, options = {}) {
  const d = requireDeps(deps);
  const author = requireOperator(operator);
  return serialized(d.repository, async () => {
    const current = withContractDefaults(await loadNegotiation(d.repository, id));
    const { value, errors } = readFields(patch, EDITABLE_FIELDS);
    if (errors.length === 0 && Object.keys(value).length === 0) errors.push({ path: '', code: 'NADA_A_ALTERAR' });
    if (errors.length > 0) throw invalidInput(errors);
    if (current.situacao !== SITUATION.OPEN) throw closedError();

    const next = { ...current };
    for (const key of Object.keys(value)) next[key] = value[key];
    if (next.formaPagamento === BILLING.UNICO && !hasOwn(value, 'periodicidade')) next.periodicidade = null; // trocar para pagamento único nunca deixa uma periodicidade antiga
    // passar para prazo INDETERMINADO tira o prazo; voltar para prazo DEFINIDO tira o aviso prévio (o que não foi enviado e deixou de valer nunca fica para trás)
    if (next.duracao === DURATION.INDETERMINADA && !hasOwn(value, 'prazoMeses')) next.prazoMeses = null;
    if (next.duracao === DURATION.DEFINIDA && !hasOwn(value, 'avisoPrevioDias')) next.avisoPrevioDias = null;
    const touchesChoice = ['serviceId', 'formaPagamento', 'periodicidade'].some((key) => hasOwn(value, key));
    const serviceChanged = hasOwn(value, 'serviceId') && value.serviceId !== current.serviceId;
    const stateProblems = stateErrors(next, service, { checkChoice: touchesChoice, checkActive: serviceChanged });
    if (stateProblems.length > 0) throw invalidInput(stateProblems);

    const changes = [];
    for (const key of [...EDITABLE_FIELDS, 'periodicidade']) {
      if (!changes.some((change) => change.campo === key) && !Object.is(current[key] ?? null, next[key] ?? null)) changes.push({ campo: key, de: current[key] ?? null, para: next[key] ?? null });
    }
    if (changes.length === 0) return toView(d, current); // nada mudou de verdade: nada é gravado, nem o histórico

    const at = nowIso(options);
    const saved = {
      ...next,
      servicoNome: serviceChanged && typeof service.nome === 'string' ? service.nome : current.servicoNome,
      atualizadoEm: at,
      atualizadoPorUserId: author.userId,
      atualizadoPorNome: author.name,
      eventos: [...current.eventos, event(EVENT.UPDATED, author, at, { alteracoes: changes })],
    };
    await persistChange(d, { mode: 'update', negotiation: saved, previous: current });
    return toView(d, saved);
  });
}

// Muda a negociação de etapa (o card se move; o histórico do card e o da negociação registram). Só ABERTA; só para uma etapa ATIVA do MESMO funil. Idempotente.
async function moveNegotiation(deps, id, stageId, operator, options = {}) {
  const d = requireDeps(deps);
  const author = requireOperator(operator);
  return serialized(d.repository, async () => {
    const current = await loadNegotiation(d.repository, id);
    const checked = checkId(stageId);
    if (!checked.ok) throw invalidInput([{ path: 'stageId', code: checked.code }]);
    const reason = options.motivo === undefined || options.motivo === null ? { ok: true, value: null } : checkReason(LIMIT.MOTIVO_ETAPA)(options.motivo);
    if (!reason.ok) throw invalidInput([{ path: 'motivo', code: reason.code }]);
    if (current.situacao !== SITUATION.OPEN) throw closedError();
    const before = await viaRepository(() => d.funnelRepository.getCard(current.cardId));
    if (!before) throw invalidState('o card da negociação não foi encontrado no funil.');
    const fromStage = await viaRepository(() => d.funnelRepository.getStage(before.stageId));
    let plan;
    try {
      plan = await funnelDomain.planNegotiationCardMove(d.funnelRepository, current.cardId, checked.value, { reviewedBy: author, motivo: reason.value });
    } catch (cause) {
      if (cause && cause.code === 'FUNNEL_STAGE_MISMATCH') throw invalidInput([{ path: 'stageId', code: 'ETAPA_DE_OUTRO_FUNIL' }]);
      if (cause && cause.code === 'FUNNEL_STAGE_INACTIVE') throw invalidInput([{ path: 'stageId', code: 'ETAPA_DESATIVADA' }]);
      if (cause && /etapa não encontrada/.test(String(cause.message))) throw invalidInput([{ path: 'stageId', code: 'ETAPA_NAO_ENCONTRADA' }]);
      throw cause instanceof NegotiationError ? cause : Object.assign(new NegotiationError(NEGOTIATION_ERROR.PERSISTENCE, 'Negociação: não foi possível mover o card agora.'), { cause });
    }
    if (!plan.changed) return toView(d, current); // já estava lá: nada a registrar
    const toStage = await viaRepository(() => d.funnelRepository.getStage(plan.card.stageId));
    const at = nowIso(options);
    const saved = {
      ...current,
      atualizadoEm: at,
      atualizadoPorUserId: author.userId,
      atualizadoPorNome: author.name,
      eventos: [...current.eventos, event(EVENT.MOVED, author, at, { deEtapaId: before.stageId, deEtapaNome: fromStage ? fromStage.nome : null, paraEtapaId: plan.card.stageId, paraEtapaNome: toStage ? toStage.nome : null, ...(reason.value ? { motivo: reason.value } : {}) })],
    };
    await persistChange(d, { mode: 'update', negotiation: saved, previous: current, card: plan.card, move: plan.move });
    return toView(d, saved);
  });
}

// Fecha como GANHA. Só ABERTA. Não é "dinheiro recebido" — só a decisão comercial.
async function winNegotiation(deps, id, operator, options = {}) {
  const d = requireDeps(deps);
  const author = requireOperator(operator);
  return serialized(d.repository, async () => {
    const current = await loadNegotiation(d.repository, id);
    if (current.situacao !== SITUATION.OPEN) throw invalidState('só uma negociação ABERTA pode ser ganha.');
    const at = nowIso(options);
    const saved = { ...current, situacao: SITUATION.WON, motivoPerda: null, fechadoEm: at, atualizadoEm: at, atualizadoPorUserId: author.userId, atualizadoPorNome: author.name, eventos: [...current.eventos, event(EVENT.WON, author, at)] };
    await persistChange(d, { mode: 'update', negotiation: saved, previous: current });
    return toView(d, saved);
  });
}

// Fecha como PERDIDA, com o MOTIVO (obrigatório). Só ABERTA.
async function loseNegotiation(deps, id, motivo, operator, options = {}) {
  const d = requireDeps(deps);
  const author = requireOperator(operator);
  return serialized(d.repository, async () => {
    const current = await loadNegotiation(d.repository, id);
    const reason = checkReason(LIMIT.MOTIVO_PERDA)(motivo);
    if (!reason.ok) throw invalidInput([{ path: 'motivo', code: reason.code }]);
    if (current.situacao !== SITUATION.OPEN) throw invalidState('só uma negociação ABERTA pode ser perdida.');
    const at = nowIso(options);
    const saved = { ...current, situacao: SITUATION.LOST, motivoPerda: reason.value, fechadoEm: at, atualizadoEm: at, atualizadoPorUserId: author.userId, atualizadoPorNome: author.name, eventos: [...current.eventos, event(EVENT.LOST, author, at, { motivo: reason.value })] };
    await persistChange(d, { mode: 'update', negotiation: saved, previous: current });
    return toView(d, saved);
  });
}

// Reabre uma negociação GANHA ou PERDIDA (quem chama garante a autorização mais alta). Volta a ABERTA, na etapa em que estava; limpa o fechamento e o motivo — o histórico guarda tudo.
async function reopenNegotiation(deps, id, operator, options = {}) {
  const d = requireDeps(deps);
  const author = requireOperator(operator);
  return serialized(d.repository, async () => {
    const current = await loadNegotiation(d.repository, id);
    if (current.situacao === SITUATION.OPEN) throw invalidState('a negociação já está aberta.');
    const at = nowIso(options);
    const saved = { ...current, situacao: SITUATION.OPEN, motivoPerda: null, fechadoEm: null, atualizadoEm: at, atualizadoPorUserId: author.userId, atualizadoPorNome: author.name, eventos: [...current.eventos, event(EVENT.REOPENED, author, at, { de: current.situacao })] };
    await persistChange(d, { mode: 'update', negotiation: saved, previous: current });
    return toView(d, saved);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// INDICADORES (puro): a partir das negociações já projetadas. Tudo em centavos inteiros.
//   (D3) `tcv` é o TCV CONHECIDO: soma só os contratos com TCV determinado. Um contrato por prazo INDETERMINADO tem TCV indeterminado: NÃO entra na soma (nem como zero, nem estimado) e é contado à parte em
//   `tcvIndeterminado` (quantidade). O MRR dele entra normalmente: depende só da cobrança mensal.
//   abertas   -> o que está EM NEGOCIAÇÃO (nunca é receita): quantidade, TCV, MRR e equivalente mensal em jogo
//   ganhas    -> o que foi CONTRATADO (decisão comercial, não dinheiro recebido): quantidade, TCV, MRR (só mensais) e equivalente mensal das demais recorrências
//   perdidas  -> quantidade e TCV que se deixou de fechar
//   conversao -> ganhas ÷ (ganhas + perdidas), só quando há ao menos uma negociação fechada (sem fechadas não há taxa — nunca "0%" de mentira)
//   porEtapa  -> as ABERTAS por etapa (quantidade e TCV)
// ---------------------------------------------------------------------------------------------------------------------------------
function summarizeNegotiations(views) {
  const list = Array.isArray(views) ? views : [];
  const zero = () => ({ quantidade: 0, tcvCentavos: 0, tcvIndeterminadas: 0, mrrCentavos: 0, equivalenteMensalOutrasCentavos: 0, semCalculo: 0 });
  const buckets = { [SITUATION.OPEN]: zero(), [SITUATION.WON]: zero(), [SITUATION.LOST]: zero() };
  const byStage = new Map();
  for (const view of list) {
    const bucket = buckets[view.situacao];
    if (!bucket) continue;
    bucket.quantidade += 1;
    const finance = view.financeiro;
    if (finance) {
      if (finance.tcvCentavos === null) bucket.tcvIndeterminadas += 1;
      else bucket.tcvCentavos += finance.tcvCentavos;
      if (finance.mrrCentavos !== null) bucket.mrrCentavos += finance.mrrCentavos;
      else if (finance.equivalenteMensalCentavos !== null) bucket.equivalenteMensalOutrasCentavos += finance.equivalenteMensalCentavos;
    } else {
      bucket.semCalculo += 1;
    }
    if (view.situacao === SITUATION.OPEN) {
      const key = `${view.funnelId}|${view.stageId}`;
      const row = byStage.get(key) || { funnelId: view.funnelId, funnelNome: view.funnelNome, stageId: view.stageId, stageNome: view.stageNome, quantidade: 0, tcvCentavos: 0, tcvIndeterminadas: 0, mrrCentavos: 0 };
      row.quantidade += 1;
      if (finance) {
        if (finance.tcvCentavos === null) row.tcvIndeterminadas += 1;
        else row.tcvCentavos += finance.tcvCentavos;
        if (finance.mrrCentavos !== null) row.mrrCentavos += finance.mrrCentavos;
      }
      byStage.set(key, row);
    }
  }
  const money = (cents) => cents / 100;
  const shape = (bucket) => ({ quantidade: bucket.quantidade, tcv: money(bucket.tcvCentavos), tcvIndeterminado: bucket.tcvIndeterminadas, mrr: money(bucket.mrrCentavos), equivalenteMensalOutrasRecorrencias: money(bucket.equivalenteMensalOutrasCentavos), receitaMensalEquivalenteTotal: money(bucket.mrrCentavos + bucket.equivalenteMensalOutrasCentavos), semCalculo: bucket.semCalculo });
  const won = buckets[SITUATION.WON].quantidade;
  const lost = buckets[SITUATION.LOST].quantidade;
  return {
    abertas: shape(buckets[SITUATION.OPEN]),
    ganhas: shape(buckets[SITUATION.WON]),
    perdidas: shape(buckets[SITUATION.LOST]),
    conversao: { fechadas: won + lost, ganhas: won, perdidas: lost, taxa: won + lost > 0 ? won / (won + lost) : null },
    porEtapa: [...byStage.values()].map((row) => ({ ...row, tcv: money(row.tcvCentavos), mrr: money(row.mrrCentavos) })),
    total: list.length,
  };
}

module.exports = {
  NEGOTIATION_ERROR,
  SITUATION,
  EVENT,
  LIMIT,
  LIMITS,
  NegotiationError,
  EDITABLE_FIELDS,
  getNegotiation,
  listNegotiations,
  createNegotiation,
  updateNegotiation,
  moveNegotiation,
  winNegotiation,
  loseNegotiation,
  reopenNegotiation,
  summarizeNegotiations,
};
