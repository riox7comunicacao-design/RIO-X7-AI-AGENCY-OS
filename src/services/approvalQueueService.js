// Approval Queue Service — a fronteira de APLICAÇÃO da fila de aprovação humana (Lead Approval).
//
//   consumidor (futuro Dashboard/API) -> ApprovalQueueService -> Approval Queue (domínio) -> persistência atual
//
// O Service NÃO é a Approval Queue. O domínio (src/research-prospector/approvalQueue.js) continua dono dos
// estados, das transições, do DNC, da deduplicação, do histórico, das invariantes e da persistência em disco.
// O Service é a porta de entrada das ações e das leituras de um HUMANO autenticado:
//   - recebe SÓ um AuthorizationContext já emitido — nunca userId, role ou permissions soltos do consumidor;
//   - autoriza ANTES de qualquer outra coisa: antes de validar detalhes e antes de tocar no disco;
//   - valida a entrada de aplicação (tipos, opções conhecidas);
//   - chama o domínio, persiste pelo mecanismo atual e devolve CÓPIAS dos dados, nunca objetos vivos do domínio.
//
// AUTORIZAÇÃO — uma única política: toda operação exige APPROVE:LEAD_APPROVAL, decidida pelo autorizador
// INJETADO (a porta authorizeReviewer; sua implementação é src/auth/approvalQueueBridge.js: contexto emitido,
// usuário ATIVO e permissão). O Service não reimplementa nada disso. Para aprovar e rejeitar, o domínio é chamado
// pela fábrica createApprovalReviewActions com o MESMO autorizador — as funções soltas approveProspect e
// rejectProspect do domínio falham fechado, e o Service nunca as usa. Logo a autorização acontece duas vezes, em
// camadas independentes: no Service (antes de qualquer I/O, e é o que protege as leituras) e de novo no domínio,
// que nunca age sem autorizador.
//
// LEITURAS (V1): usam a mesma autorização das ações, só porque é a que hoje dá acesso à fila. Isto NÃO define, de
// forma permanente, o que é a permissão de "leitura" da Approval Queue: essa semântica será definida antes do
// Dashboard. Nenhuma permission foi criada e a matriz de permissões não foi ampliada.
//
// OPERAÇÕES desta primeira versão — só as ações e leituras HUMANAS que o domínio já tem:
//   listQueue, getProspect, getHistory, approveProspect, rejectProspect.
// Ficam FORA, de propósito: as transições e a entrada de prospects feitas pelo SISTEMA (addProspect,
// markDuplicado, markDnc, markDadosInsuficientes). Elas não têm autorização humana por desenho, e como um ator de
// sistema se autentica é uma decisão futura, ainda não tomada: será tratada junto do Prospecting Service (execução
// automática).
//
// ERROS: os do domínio e os da autorização passam intactos, sem tradução — mesma classe, mesma mensagem. Só a
// validação de entrada do próprio Service lança erros novos (Error simples, como no resto do projeto).
//
// LIMITES honestos: o Service obedece ao autorizador que recebe na criação (quem o compõe escolhe o autorizador —
// fronteira arquitetural interna confiável, não criptografia); a persistência é o arquivo do domínio, sem trava
// entre processos (dentro de um processo cada operação é síncrona e, portanto, indivisível); e o Service é
// síncrono, como o domínio.

const approvalQueueDomain = require('../research-prospector/approvalQueue');
const { PERMISSION } = require('../auth');

// A única permissão exigida, em toda operação (ver o cabeçalho).
const REQUIRED_PERMISSION = PERMISSION.APPROVE_LEAD_APPROVAL;

// O que o Service usa do domínio (o contrato real de approvalQueue.js). É verificado na CRIAÇÃO: uma dependência
// incompleta falha fechada logo, em vez de falhar no meio de uma operação.
const REQUIRED_DOMAIN_FUNCTIONS = Object.freeze([
  'createApprovalReviewActions',
  'loadQueueFromDisk',
  'saveQueueToDisk',
  'getProspect',
  'listQueue',
  'getHistory',
]);

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// Todo dado que sai do Service é uma CÓPIA: quem consome nunca recebe (nem consegue alterar) objetos vivos do domínio.
const copy = (value) => structuredClone(value);

function requireProspectId(prospectId) {
  if (typeof prospectId !== 'string' || prospectId.trim().length === 0) {
    throw new Error('prospectId deve ser um texto não vazio');
  }
  return prospectId;
}

// Lê as opções de uma operação. Só passam as chaves conhecidas: qualquer outra — em especial userId, role,
// permissions ou reviewedBy — é recusada, porque a identidade do revisor vem SÓ do AuthorizationContext.
function readOptions(options, allowedKeys) {
  if (options === undefined || options === null) return {};
  if (!isPlainObject(options)) throw new Error('as opções devem ser um objeto');
  const unknown = Object.keys(options).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `opções não reconhecidas: ${unknown.join(', ')} — a identidade e as permissões do revisor vêm só do AuthorizationContext, nunca das opções`
    );
  }
  return options;
}

function readReason(options) {
  const { reason } = options;
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw new Error('reason deve ser um texto');
  }
  return reason;
}

// O item devolvido pelo domínio é mesmo o prospect pedido? Defesa em profundidade da leitura: o domínio busca em
// queue.items[id], e um id como "constructor" ou "__proto__" acharia uma propriedade herdada do Object, não um
// prospect. Um resultado que não é o registro do id pedido nunca sai como se fosse um prospect.
// DÉBITO TÉCNICO registrado (o domínio NÃO foi alterado): o lookup do domínio deve passar a exigir propriedade
// própria (por exemplo, Object.hasOwn(queue.items, id)). Depois disso esta defesa fica redundante, sem prejuízo.
const isProspectRecord = (item, id) => isPlainObject(item) && item.prospectId === id;

// approvalQueue: o domínio (por padrão, o real). authorizeReviewer: a porta de autorização — OBRIGATÓRIA, sem
// padrão: sem autorizador o Service nem existe. queuePath: onde a fila está (por padrão, o caminho do domínio).
function createApprovalQueueService(dependencies) {
  const { approvalQueue = approvalQueueDomain, authorizeReviewer, queuePath } = dependencies || {};

  if (typeof authorizeReviewer !== 'function') {
    throw new Error('createApprovalQueueService exige { authorizeReviewer } (função): sem autorizador injetado o Service não existe');
  }
  if (typeof approvalQueue !== 'object' || approvalQueue === null) {
    throw new Error('createApprovalQueueService: a dependência approvalQueue deve ser o domínio da fila de aprovação');
  }
  for (const name of REQUIRED_DOMAIN_FUNCTIONS) {
    if (typeof approvalQueue[name] !== 'function') {
      throw new Error(`createApprovalQueueService: a dependência approvalQueue não tem a função ${name}()`);
    }
  }
  if (!isPlainObject(approvalQueue.QUEUE_STATE)) {
    throw new Error('createApprovalQueueService: a dependência approvalQueue não tem QUEUE_STATE');
  }
  const filePath = queuePath === undefined ? approvalQueue.DEFAULT_QUEUE_PATH : queuePath;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createApprovalQueueService: queuePath deve ser um texto não vazio');
  }

  // As funções do domínio ficam capturadas aqui: alterar o objeto injetado depois da criação não muda o Service.
  const { loadQueueFromDisk, saveQueueToDisk } = approvalQueue;
  const domainGetProspect = approvalQueue.getProspect;
  const domainListQueue = approvalQueue.listQueue;
  const domainGetHistory = approvalQueue.getHistory;
  const knownStates = Object.freeze(Object.values(approvalQueue.QUEUE_STATE));

  // A fábrica do domínio é o único caminho de aprovar/rejeitar; leva SÓ o autorizador.
  const reviewActions = approvalQueue.createApprovalReviewActions({ authorizeReviewer });
  if (!reviewActions || typeof reviewActions.approveProspect !== 'function' || typeof reviewActions.rejectProspect !== 'function') {
    throw new Error('createApprovalQueueService: a fábrica do domínio não devolveu as ações de revisão');
  }

  // Autoriza uma operação. Lança quando o autorizador recusa (contexto inválido, usuário inativo, permissão
  // ausente). Fail closed também contra um autorizador defeituoso: tudo o que não for a identidade do revisor
  // (false, undefined, texto, uma Promise de um autorizador assíncrono) é uma recusa, nunca uma autorização.
  function authorize(context) {
    const reviewer = authorizeReviewer(context, REQUIRED_PERMISSION);
    if (!isPlainObject(reviewer)) {
      throw new Error('autorização recusada: o autorizador não devolveu a identidade do revisor');
    }
    if (typeof reviewer.then === 'function') {
      throw new Error('autorização recusada: o autorizador deve ser síncrono (devolveu uma Promise)');
    }
  }

  function listQueue(context, options) {
    authorize(context);
    const { estado } = readOptions(options, ['estado']);
    if (estado !== undefined && estado !== null && (typeof estado !== 'string' || !knownStates.includes(estado))) {
      throw new Error(`estado desconhecido: use um dos estados da fila (${knownStates.join(', ')})`);
    }
    const queue = loadQueueFromDisk(filePath);
    return copy(domainListQueue(queue, estado === null ? undefined : estado));
  }

  function getProspect(context, prospectId) {
    authorize(context);
    const id = requireProspectId(prospectId);
    const item = domainGetProspect(loadQueueFromDisk(filePath), id);
    return isProspectRecord(item, id) ? copy(item) : null;
  }

  function getHistory(context, prospectId) {
    authorize(context);
    const id = requireProspectId(prospectId);
    const history = domainGetHistory(loadQueueFromDisk(filePath), id);
    // Para um prospect inexistente o domínio lança; isto só cobre o id herdado do Object (ver isProspectRecord),
    // com a mesma mensagem que o domínio usa para um prospect inexistente.
    if (!Array.isArray(history)) throw new Error(`prospect não encontrado na fila: ${id}`);
    return copy(history);
  }

  // Aprovar e rejeitar: autoriza -> valida a entrada -> carrega a fila -> ação do domínio (que reautoriza) ->
  // persiste -> devolve uma cópia. Só grava se a ação do domínio terminou sem erro; qualquer erro do domínio
  // passa intacto, e o arquivo continua como estava.
  function review(action) {
    return function reviewProspect(context, prospectId, options) {
      authorize(context);
      const id = requireProspectId(prospectId);
      const reason = readReason(readOptions(options, ['reason']));
      const queue = loadQueueFromDisk(filePath);
      const item = action(queue, id, context, reason);
      saveQueueToDisk(queue, filePath);
      return copy(item);
    };
  }

  return Object.freeze({
    listQueue,
    getProspect,
    getHistory,
    approveProspect: review(reviewActions.approveProspect),
    rejectProspect: review(reviewActions.rejectProspect),
  });
}

module.exports = { createApprovalQueueService };
