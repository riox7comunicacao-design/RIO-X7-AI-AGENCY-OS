// Lead Reconsideration Service (Implementação 3.0) — "LEADS REPROVADOS" e "REAPROVAR LEAD".
//
//   API -> LeadReconsiderationService -> Approval Queue (domínio, fábrica à parte) + CRM Service (só leitura) + perfil comercial do lead
//
// POR QUE É UM SERVICE À PARTE: o Approval Queue Service é a superfície que a API expõe para aprovar/rejeitar e testes vigiam o seu conjunto de operações; a reaprovação
// é uma ação nova e mais perigosa (reabre uma decisão humana) e precisa das barreiras do CRM (assíncrono), que o Approval Queue Service (síncrono) não conhece.
//
// O QUE FAZ:
//   listReprovados(context, { filtro? })
//       os leads que NÃO estão ativos na fila — REJEITADO (humano), DADOS_INSUFICIENTES, DUPLICADO, DNC e EXPIRADO —, cada um com todos os dados comerciais já
//       pesquisados (o snapshot da fila + o perfil comercial), o motivo, a data, quem decidiu, o job de origem e se pode ser reaprovado. Nada é apagado: é só leitura.
//       filtro: TODOS (padrão) | REPROVADOS | DADOS_INSUFICIENTES | DUPLICADOS | DNC | EXPIRADOS.
//   reconsiderLead(context, prospectId, { reason? })
//       A reaprovação é uma decisão HUMANA. NENHUMA pesquisa nova e NENHUMA reavaliação comercial: os dados do lead são preservados como estão. Só duas coisas são
//       verificadas — (A) o lead já existe no CRM? (B) é duplicado de outro lead? — e, se nenhuma barra, o lead volta à AGUARDANDO_REVISAO (um humano ainda decide aprovar ou
//       reprovar e, depois, PROMOVER explicitamente — reaprovar não aprova, não promove e não cria nada no CRM). Barreiras:
//         0. só um lead REJEITADO por um humano pode voltar (é o estado de partida da reaprovação; DNC/duplicado/dados insuficientes/expirado não são "rejeição humana");
//         A. o lead já está no CRM (domínio, telefone, Instagram ou nome+cidade) -> JA_NO_CRM;
//         B. já existe OUTRO item ativo na fila com a mesma identidade -> DUPLICADO_NA_FILA.
//       NÃO bloqueiam (decisão de produto): exclusão permanente, DNC, falta de site, de rede social ou de telefone, nova pesquisa ou qualquer outra avaliação automática.
//
// AUTORIZAÇÃO: APPROVE:LEAD_APPROVAL (a mesma da fila), decidida pelo autorizador INJETADO, ANTES de qualquer leitura; e de novo no domínio. A identidade de quem reaprovou
// vem SÓ do autorizador. Erros: `LeadReconsiderationError` com `code` estável para as barreiras; os da autorização passam intactos.

const approvalQueueDomain = require('../research-prospector/approvalQueue');
const { checkDuplicate } = require('../research-prospector/duplicateCheck');
const { identityViews, toProspectorRecords } = require('../research-prospector/crmAdapter');
const { DUPLICATE_STATUS } = require('../research-prospector/constants');
const { identityKeys } = require('../research-prospector/normalize');
const { PERMISSION } = require('../auth');

const REQUIRED_PERMISSION = PERMISSION.APPROVE_LEAD_APPROVAL;
const REQUIRED_DOMAIN_FUNCTIONS = Object.freeze(['createApprovalReconsiderationActions', 'loadQueueFromDisk', 'saveQueueToDisk', 'listQueue']);

const FILTER = Object.freeze({ TODOS: 'TODOS', REPROVADOS: 'REPROVADOS', DADOS_INSUFICIENTES: 'DADOS_INSUFICIENTES', DUPLICADOS: 'DUPLICADOS', DNC: 'DNC', EXPIRADOS: 'EXPIRADOS' });
const FILTER_STATES = Object.freeze({
  [FILTER.REPROVADOS]: ['REJEITADO'],
  [FILTER.DADOS_INSUFICIENTES]: ['DADOS_INSUFICIENTES'],
  [FILTER.DUPLICADOS]: ['DUPLICADO'],
  [FILTER.DNC]: ['DNC'],
  [FILTER.EXPIRADOS]: ['EXPIRADO'],
  [FILTER.TODOS]: ['REJEITADO', 'DADOS_INSUFICIENTES', 'DUPLICADO', 'DNC', 'EXPIRADO'],
});
const BLOCK = Object.freeze({
  NAO_REAPROVAVEL: 'NAO_REAPROVAVEL',
  JA_NO_CRM: 'JA_NO_CRM',
  DUPLICADO_NA_FILA: 'DUPLICADO_NA_FILA',
});
const ACTIVE_STATES = Object.freeze(['AGUARDANDO_REVISAO', 'APROVADO_PARA_CRM']);

class LeadReconsiderationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LeadReconsiderationError';
    this.code = code;
  }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const copy = (value) => structuredClone(value);

function requireProspectId(prospectId) {
  if (typeof prospectId !== 'string' || prospectId.trim().length === 0) throw new Error('prospectId deve ser um texto não vazio');
  return prospectId;
}

function readOptions(options, allowedKeys) {
  if (options === undefined || options === null) return {};
  if (!isPlainObject(options)) throw new Error('as opções devem ser um objeto');
  const unknown = Object.keys(options).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`opções não reconhecidas: ${unknown.join(', ')} — a identidade de quem reaprova vem só do AuthorizationContext`);
  return options;
}

const sameIdentity = (a, b) => {
  const x = identityKeys(a);
  const y = identityKeys(b);
  return Boolean((x.domain && x.domain === y.domain) || (x.phone && x.phone === y.phone) || (x.instagram && x.instagram === y.instagram) || (x.nameCity && x.nameCity === y.nameCity));
};

// Quando, por quem e por que o item chegou ao estado atual: a última entrada de histórico que TERMINA nele.
function lastDecision(item) {
  const entries = Array.isArray(item.historico) ? item.historico : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index] && entries[index].to === item.estado) return entries[index];
  }
  return null;
}

// dependencies:
//   authorizeReviewer      OBRIGATÓRIA — a porta síncrona (a ponte real de APPROVE:LEAD_APPROVAL)
//   crmService             OBRIGATÓRIA — só listRecords() (que autoriza READ:CRM de novo)
//   queuePath, approvalQueue (domínio)
//   profileRepository      opcional — { getById(prospectId) } do perfil comercial (sem ele, o perfil vem null)
function createLeadReconsiderationService(dependencies) {
  const { approvalQueue = approvalQueueDomain, authorizeReviewer, queuePath, crmService, profileRepository = null } = dependencies || {};
  if (typeof authorizeReviewer !== 'function') throw new Error('createLeadReconsiderationService exige { authorizeReviewer } (função): sem autorizador injetado o Service não existe');
  if (typeof approvalQueue !== 'object' || approvalQueue === null) throw new Error('createLeadReconsiderationService: a dependência approvalQueue deve ser o domínio da fila de aprovação');
  for (const name of REQUIRED_DOMAIN_FUNCTIONS) {
    if (typeof approvalQueue[name] !== 'function') throw new Error(`createLeadReconsiderationService: a dependência approvalQueue não tem a função ${name}()`);
  }
  if (!crmService || typeof crmService.listRecords !== 'function') throw new Error('createLeadReconsiderationService exige { crmService } com listRecords()');
  if (profileRepository !== null && typeof profileRepository.getById !== 'function') throw new Error('createLeadReconsiderationService: profileRepository, se informado, deve ter getById()');
  const filePath = queuePath === undefined ? approvalQueue.DEFAULT_QUEUE_PATH : queuePath;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new Error('createLeadReconsiderationService: queuePath deve ser um texto não vazio');

  const { loadQueueFromDisk, saveQueueToDisk } = approvalQueue;
  const actions = approvalQueue.createApprovalReconsiderationActions({ authorizeReviewer });
  if (!actions || typeof actions.reconsiderProspect !== 'function') throw new Error('createLeadReconsiderationService: a fábrica do domínio não devolveu a ação de reaprovação');

  function authorize(context) {
    const reviewer = authorizeReviewer(context, REQUIRED_PERMISSION);
    if (!isPlainObject(reviewer)) throw new Error('autorização recusada: o autorizador não devolveu a identidade do revisor');
    if (typeof reviewer.then === 'function') throw new Error('autorização recusada: o autorizador deve ser síncrono (devolveu uma Promise)');
  }

  const profileOf = (prospectId) => {
    if (profileRepository === null) return null;
    try {
      return profileRepository.getById(prospectId);
    } catch {
      return null;
    }
  };

  function view(item) {
    const decision = lastDecision(item);
    const human = decision && decision.actor === 'HUMAN';
    const profile = profileOf(item.prospectId);
    return {
      prospectId: item.prospectId,
      empresa: item.empresa,
      estado: item.estado,
      reaprovavel: item.estado === 'REJEITADO',
      reprovadoEm: decision ? decision.timestamp : null,
      reprovadoPor: human && decision.reviewedBy ? { userId: decision.reviewedBy.userId, name: decision.reviewedBy.name, role: decision.reviewedBy.role } : null,
      origemDaDecisao: human ? 'HUMANO' : 'SISTEMA',
      motivo: decision && typeof decision.motivo === 'string' ? decision.motivo : null,
      reaprovacoes: Number.isInteger(item.reaprovacoes) ? item.reaprovacoes : 0,
      jobOrigem: profile && typeof profile.jobId === 'string' ? profile.jobId : null,
      dadosComerciais: copy(item.discoverySnapshot || {}),
      perfil: profile ? copy(profile) : null,
      historico: copy(item.historico || []),
    };
  }

  function listReprovados(context, options) {
    authorize(context);
    const { filtro = FILTER.TODOS } = readOptions(options, ['filtro']);
    if (typeof filtro !== 'string' || !Object.prototype.hasOwnProperty.call(FILTER_STATES, filtro)) {
      throw new LeadReconsiderationError('FILTRO_INVALIDO', `filtro desconhecido: use um de ${Object.keys(FILTER_STATES).join(', ')}`);
    }
    const queue = loadQueueFromDisk(filePath);
    const items = FILTER_STATES[filtro].flatMap((estado) => approvalQueue.listQueue(queue, estado));
    return items.map(view).sort((a, b) => String(b.reprovadoEm || '').localeCompare(String(a.reprovadoEm || '')));
  }

  async function checkBarriers(context, queue, item) {
    if (item.estado !== 'REJEITADO') {
      throw new LeadReconsiderationError(BLOCK.NAO_REAPROVAVEL, item.estado === 'DNC'
        ? 'Reaprovação bloqueada: o lead está em DNC (restrição de contato) — não é uma rejeição comercial reativável.'
        : `Reaprovação bloqueada: só um lead REJEITADO por um humano pode voltar para a revisão (este está em ${item.estado}).`);
    }
    const snapshot = item.discoverySnapshot || {};
    const records = await crmService.listRecords(context);
    const crmList = Array.isArray(records) ? records : [];
    // as MESMAS checagens do pipeline de ingestão, sobre os registros do CRM traduzidos pelo crmAdapter (cada número do lead é uma visão própria)
    const registros = toProspectorRecords(crmList);
    const views = identityViews(snapshot);
    const duplicates = views.map((view) => checkDuplicate(view, registros).status);
    if (duplicates.some((status) => status === DUPLICATE_STATUS.DUPLICADO || status === DUPLICATE_STATUS.POSSIVEL_DUPLICADO)) {
      throw new LeadReconsiderationError(BLOCK.JA_NO_CRM, 'Reaprovação bloqueada: o lead já existe no CRM.');
    }
    for (const other of Object.values(queue.items)) {
      if (other.prospectId !== item.prospectId && ACTIVE_STATES.includes(other.estado) && sameIdentity(snapshot, other.discoverySnapshot || {})) {
        throw new LeadReconsiderationError(BLOCK.DUPLICADO_NA_FILA, 'Reaprovação bloqueada: já existe outro item ativo na fila com a mesma identidade.');
      }
    }
  }

  async function reconsiderLead(context, prospectId, options) {
    authorize(context);
    const id = requireProspectId(prospectId);
    const { reason } = readOptions(options, ['reason']);
    if (reason !== undefined && reason !== null && typeof reason !== 'string') throw new Error('reason deve ser um texto');
    const queue = loadQueueFromDisk(filePath);
    const item = Object.prototype.hasOwnProperty.call(queue.items, id) ? queue.items[id] : null;
    if (item === null) throw new Error(`prospect não encontrado na fila: ${id}`);
    await checkBarriers(context, queue, item);
    // recarrega: a checagem foi assíncrona; a decisão final é sobre o estado ATUAL do arquivo
    const fresh = loadQueueFromDisk(filePath);
    const updated = actions.reconsiderProspect(fresh, id, context, reason);
    saveQueueToDisk(fresh, filePath);
    return view(copy(updated));
  }

  // O perfil comercial de UM lead (para a Approval Queue mostrar o que foi pesquisado); null se o lead não tem perfil (ex.: veio de uma pesquisa manual).
  function getProfile(context, prospectId) {
    authorize(context);
    const id = requireProspectId(prospectId);
    const profile = profileOf(id);
    return profile ? copy(profile) : null;
  }

  return Object.freeze({ listReprovados, reconsiderLead, getProfile });
}

module.exports = { createLeadReconsiderationService, LeadReconsiderationError, FILTER, BLOCK };
