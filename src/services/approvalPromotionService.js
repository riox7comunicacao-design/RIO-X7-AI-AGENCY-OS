// Approval Promotion Service — a fronteira de APLICAÇÃO da AUDITORIA da promoção Approval Queue → CRM (decisão 0016).
//
//   CRM Integration Service -> ApprovalPromotionService -> Approval Queue (domínio) -> persistência atual (arquivo)
//
// POR QUE É UM SERVICE À PARTE (e não duas operações a mais no Approval Queue Service): o Approval Queue Service é o
// que a API HTTP expõe, e o seu conjunto de operações — listar, ler, aprovar, rejeitar — é uma superfície que testes
// vigiam de propósito. Registrar que um prospect foi promovido é uma ação que SÓ a camada de integração
// (crmIntegrationService.js) deve poder fazer; se ela morasse no Service exposto pela API, qualquer rota futura que
// repassasse "as operações do Service" a exporia por descuido. Aqui ela só existe para quem recebe ESTE objeto, e ele
// não é entregue a nenhuma rota.
//
// O QUE FAZ: só GUARDA, na fila, o que a integração fez — nunca escreve no CRM e nunca muda o ESTADO do item (o item
// continua APROVADO_PARA_CRM, o estado histórico da aprovação humana; ver approvalQueue.js):
//   recordPromotion(context, prospectId, { resultado, crmRecordId, possivelDuplicadoDe? })
//       o prospect foi promovido: grava `item.promocao` e uma entrada de histórico (idempotente para o MESMO registro do
//       CRM; um SEGUNDO registro para o mesmo prospect é recusado);
//   recordPromotionBlocked(context, prospectId, { codigo, motivo, crmRecordId? })
//       uma tentativa foi bloqueada (DNC, duplicidade, dados insuficientes): só uma entrada de auditoria.
//
// AUTORIZAÇÃO — a mesma política do Approval Queue Service: APPROVE:LEAD_APPROVAL, decidida pelo autorizador INJETADO
// (a ponte real é src/auth/approvalQueueBridge.js), ANTES de qualquer outra coisa e ANTES de tocar no disco; e de novo
// dentro do domínio, que nunca registra nada sem um autorizador. A identidade de quem promove (`reviewedBy` da entrada
// e `promovidoPor`) vem SÓ do autorizador — nunca de um argumento. Só recebe um AuthorizationContext já emitido.
//
// ERROS: os do domínio e os da autorização passam intactos. LIMITES honestos: o Service obedece ao autorizador que
// recebe (quem o compõe escolhe — fronteira arquitetural interna confiável, não criptografia); a persistência é o
// arquivo do domínio, sem trava entre processos (dentro de um processo cada operação é síncrona e, portanto,
// indivisível); e o Service é síncrono, como o domínio.

const approvalQueueDomain = require('../research-prospector/approvalQueue');
const { PERMISSION } = require('../auth');

const REQUIRED_PERMISSION = PERMISSION.APPROVE_LEAD_APPROVAL;

const REQUIRED_DOMAIN_FUNCTIONS = Object.freeze(['createApprovalPromotionActions', 'loadQueueFromDisk', 'saveQueueToDisk']);

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Todo dado que sai do Service é uma CÓPIA: quem consome nunca recebe (nem consegue alterar) objetos vivos do domínio.
const copy = (value) => structuredClone(value);

function requireProspectId(prospectId) {
  if (typeof prospectId !== 'string' || prospectId.trim().length === 0) {
    throw new Error('prospectId deve ser um texto não vazio');
  }
  return prospectId;
}

// Só passam as chaves conhecidas, e só como propriedades PRÓPRIAS: qualquer outra — em especial userId, role,
// permissions, reviewedBy, actor ou estado — é recusada, porque a identidade vem SÓ do AuthorizationContext e o estado
// do item nunca vem do chamador.
function readDetails(options, allowedKeys) {
  if (options === undefined || options === null) return {};
  if (!isPlainObject(options)) throw new Error('as opções devem ser um objeto');
  const unknown = Object.keys(options).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `opções não reconhecidas: ${unknown.join(', ')} — a identidade de quem promove vem só do AuthorizationContext, e o estado do item nunca vem do chamador`
    );
  }
  const details = {};
  for (const key of allowedKeys) {
    if (hasOwn(options, key)) details[key] = options[key];
  }
  return details;
}

// approvalQueue: o domínio (por padrão, o real). authorizeReviewer: a porta de autorização — OBRIGATÓRIA, sem padrão.
// queuePath: onde a fila está (por padrão, o caminho do domínio — o MESMO do Approval Queue Service).
function createApprovalPromotionService(dependencies) {
  const { approvalQueue = approvalQueueDomain, authorizeReviewer, queuePath } = dependencies || {};

  if (typeof authorizeReviewer !== 'function') {
    throw new Error('createApprovalPromotionService exige { authorizeReviewer } (função): sem autorizador injetado o Service não existe');
  }
  if (typeof approvalQueue !== 'object' || approvalQueue === null) {
    throw new Error('createApprovalPromotionService: a dependência approvalQueue deve ser o domínio da fila de aprovação');
  }
  for (const name of REQUIRED_DOMAIN_FUNCTIONS) {
    if (typeof approvalQueue[name] !== 'function') {
      throw new Error(`createApprovalPromotionService: a dependência approvalQueue não tem a função ${name}()`);
    }
  }
  const filePath = queuePath === undefined ? approvalQueue.DEFAULT_QUEUE_PATH : queuePath;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createApprovalPromotionService: queuePath deve ser um texto não vazio');
  }

  const { loadQueueFromDisk, saveQueueToDisk } = approvalQueue;
  const actions = approvalQueue.createApprovalPromotionActions({ authorizeReviewer });
  if (!actions || typeof actions.recordPromotion !== 'function' || typeof actions.recordPromotionBlocked !== 'function') {
    throw new Error('createApprovalPromotionService: a fábrica do domínio não devolveu as ações de auditoria da promoção');
  }

  // Autoriza uma operação. Lança quando o autorizador recusa. Fail closed também contra um autorizador defeituoso:
  // tudo o que não for a identidade (false, undefined, texto, uma Promise de um autorizador assíncrono) é uma recusa.
  function authorize(context) {
    const reviewer = authorizeReviewer(context, REQUIRED_PERMISSION);
    if (!isPlainObject(reviewer)) {
      throw new Error('autorização recusada: o autorizador não devolveu a identidade do revisor');
    }
    if (typeof reviewer.then === 'function') {
      throw new Error('autorização recusada: o autorizador deve ser síncrono (devolveu uma Promise)');
    }
  }

  // autoriza -> valida a entrada -> carrega a fila -> ação do domínio (que reautoriza e confere o estado) -> persiste
  // -> devolve uma cópia. Só grava se a ação do domínio terminou sem erro; qualquer erro passa intacto e o arquivo
  // continua como estava.
  function operation(action, allowedKeys) {
    return function recordInQueue(context, prospectId, options) {
      authorize(context);
      const id = requireProspectId(prospectId);
      const details = readDetails(options, allowedKeys);
      const queue = loadQueueFromDisk(filePath);
      const item = action(queue, id, context, details);
      saveQueueToDisk(queue, filePath);
      return copy(item);
    };
  }

  return Object.freeze({
    recordPromotion: operation(actions.recordPromotion, ['resultado', 'crmRecordId', 'possivelDuplicadoDe']),
    recordPromotionBlocked: operation(actions.recordPromotionBlocked, ['codigo', 'motivo', 'crmRecordId']),
  });
}

module.exports = { createApprovalPromotionService };
