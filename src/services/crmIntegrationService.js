// CRM Integration Service — a PROMOÇÃO controlada Approval Queue -> CRM (etapa CRM-INTEGRATION, decisão 0016).
//
//   APPROVAL QUEUE (aprovação humana) -> CrmIntegrationService -> CRM Service -> CRM Domain -> persistência
//                                                      \-> Approval Promotion Service -> fila (auditoria da promoção)
//
// Esta camada NÃO é a fila nem o CRM. A fila continua sendo, sozinha, a barreira humana ("este achado pode virar
// lead?"); o CRM continua sendo o dono da identidade, da deduplicação, do DNC e do histórico. Aqui só se COMPÕE, por
// cima dos dois Services — que autorizam cada um a sua parte — uma operação nova, explícita e nunca automática:
//
//   promoteProspect(context, prospectId)
//
// Nada nesta camada importa o domínio do CRM (regra R12: só src/services importa src/crm, e este módulo nem precisa:
// fala com o CRM pelo CRM Service) nem o navegador. A API HTTP e o Dashboard NÃO foram alterados: nenhuma rota expõe
// esta operação ainda (uma rota "Promover para CRM" é uma etapa futura, e passará por uma rota autorizada).
//
// REGRAS
//   1. Só um prospect APROVADO_PARA_CRM, com a aprovação HUMANA registrada no histórico da fila, é promovido. Pendente,
//      rejeitado, DNC, duplicado, dados insuficientes e expirado NÃO são — e nada aceita o estado "aprovado" de fora:
//      o único argumento é o id do prospect, e as opções não aceitam NADA (userId, role, permissions, actor,
//      reviewedBy, estado, id de aprovação... são recusados). A aprovação vem da fila real, lida aqui.
//   2. AUTORIZAÇÃO — sem permissão nova: quem promove precisa de APPROVE:LEAD_APPROVAL (a fila autoriza ao ler o
//      prospect e ao registrar a promoção) E de WRITE:CRM (o CRM Service autoriza ao criar; esta camada também exige
//      WRITE:CRM logo no início, pela mesma porta do CRM, para que NENHUM caminho — nem a reconciliação — grave sem
//      ela). Hoje só o ADMIN tem as duas: o COMMERCIAL_CLOSER aprova, mas não promove. A identidade de quem promove
//      (auditoria, no CRM e na fila) vem SÓ dos autorizadores, nunca de um argumento.
//   3. IDEMPOTÊNCIA — a mesma aprovação nunca cria dois registros. (a) Fila: o item promovido guarda `promocao`; uma
//      segunda chamada só CONFERE que o registro do CRM existe e é o desta promoção, e devolve JA_PROMOVIDO sem
//      gravar nada. (b) Recuperação: o registro criado por uma promoção leva, no PRIMEIRO evento do seu histórico, o
//      motivo "Promovido da Approval Queue (prospect <id>; ...)" — se o CRM foi gravado e a fila não (falha entre as
//      duas gravações), a chamada seguinte acha esse registro e só RECONCILIA a fila, sem criar outro. (c) Identidade:
//      quem impede duas entradas equivalentes no CRM é o DOMÍNIO DO CRM (domínio, telefone, WhatsApp, Instagram),
//      não uma regra paralela daqui: a recusa dele vira DUPLICADO. Nome+cidade só SINALIZA (possivelDuplicidade), nunca
//      bloqueia, como no domínio.
//   4. DNC — uma identidade bloqueada no CRM NÃO entra (recusa do domínio do CRM => DNC), e um prospect cujo snapshot
//      diz statusDNC BLOQUEADO (a pesquisa o viu bloqueado depois da aprovação) também não: falha fechada.
//   5. AUDITORIA — cada promoção deixa rastro nos DOIS lados, sem sistema paralelo: na fila, `promocao` + uma entrada
//      de histórico (quem promoveu, quando, qual registro do CRM, criado ou reconciliado, sinalização de nome+cidade);
//      no CRM, o histórico do registro (criação por HUMAN, reviewedBy = quem promoveu, motivo com o id do prospect,
//      quem aprovou e quando). Um bloqueio (DNC, duplicidade, dados insuficientes) também vira uma entrada de
//      histórico na fila, com o motivo — o estado do item NÃO muda (não existe estado novo).
//   6. FALHAS — nunca deixam um estado impossível: o CRM é gravado ANTES da fila, e a única janela ("criado no CRM, fila
//      não atualizada") é recuperável e detectada (regra 3b). Um registro apontado pela fila que não existe no CRM (ou
//      que não é o desta promoção) é INCONSISTENTE: nada é alterado e o erro é claro.
//
// CONCORRÊNCIA — honesto: dentro de UM processo, promoteProspect é indivisível de ponta a ponta (ler a fila, olhar o CRM,
// criar, gravar a fila): o CRM é assíncrono desde a decisão 0023, então as promoções de um mesmo serviço rodam UMA POR VEZ, na
// ordem de chegada (fila de promessas), e a segunda vê a primeira (JA_PROMOVIDO). Os arquivos, porém, não têm trava nem transação entre PROCESSOS: dois servidores sobre os
// mesmos arquivos podem intercalar as etapas. Para prospects com identidade forte (site, telefone, WhatsApp,
// Instagram) o domínio do CRM ainda barra a segunda criação; para um prospect só com nome (sem nenhum identificador
// forte) NÃO existe essa barreira, e uma corrida entre processos poderia criar dois registros. Não há trava de
// arquivo nem transação entre os dois arquivos, e nenhuma foi fingida: um único processo servidor é o pressuposto
// desta persistência de desenvolvimento (decisões 0012, 0013, 0014 e 0016).
//
// ERROS: os das autorizações e da persistência passam intactos, sem tradução. Os desta camada têm mensagem própria
// ("Promoção: ...") e uma propriedade `code` estável (PROMOTION_ERROR).

const approvalQueueDomain = require('../research-prospector/approvalQueue');
const { DNC_STATUS } = require('../research-prospector/discovery');
const { PERMISSION } = require('../auth');
const { mapProspectToCrmFields } = require('./prospectToCrmFields');

const { QUEUE_STATE, ACTOR, PROMOTION_RESULT, PROMOTION_BLOCK } = approvalQueueDomain;

// Como uma promoção terminou (sem erro): criou-se o registro, já estava promovido, ou reconciliou-se uma falha anterior.
const PROMOTION_OUTCOME = Object.freeze({
  CRIADO: 'CRIADO',
  JA_PROMOVIDO: 'JA_PROMOVIDO',
  RECONCILIADO: 'RECONCILIADO',
});

// Os erros desta camada, por `code` estável.
const PROMOTION_ERROR = Object.freeze({
  INVALID_INPUT: 'PROMOTION_INVALID_INPUT',
  PROSPECT_NOT_FOUND: 'PROMOTION_PROSPECT_NOT_FOUND',
  NOT_APPROVED: 'PROMOTION_NOT_APPROVED',
  APPROVAL_MISSING: 'PROMOTION_APPROVAL_MISSING',
  BLOCKED_DNC: 'PROMOTION_BLOCKED_DNC',
  BLOCKED_DUPLICATE: 'PROMOTION_BLOCKED_DUPLICATE',
  INSUFFICIENT_DATA: 'PROMOTION_INSUFFICIENT_DATA',
  INCONSISTENT: 'PROMOTION_INCONSISTENT',
  PARTIAL: 'PROMOTION_PARTIAL',
});

const MARKER_PREFIX = 'Promovido da Approval Queue (prospect ';
const CRM_ID_PATTERN = /crm:[0-9a-fA-F-]{36}/;

// As recusas do DOMÍNIO DO CRM que esta camada reconhece (a mesma mensagem que a CRM-API mapeia para 409). Uma
// mudança de mensagem no domínio quebra os testes daqui, que rodam o domínio de verdade.
const CRM_DNC_REFUSAL = /^CRM: não é possível criar — identidade já bloqueada como DO_NOT_CONTACT/;
const CRM_DUPLICATE_REFUSAL = /^CRM: não é possível criar — já existe um registro com a mesma identidade/;
const CRM_INVALID_DATA_REFUSAL = /^CRM: createRecord (?:exige "empresa"|— campo ")/;

const OPERATOR_FIELDS = Object.freeze(['userId', 'name', 'role']);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isAsyncFunction = (fn) => Object.prototype.toString.call(fn) === '[object AsyncFunction]';
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function promotionError(code, message) {
  const error = new Error(`Promoção: ${message}`);
  error.code = code;
  return error;
}

// A identidade de quem aprovou/promoveu: exatamente { userId, name, role }, textos não vazios, nunca SYSTEM.
function isOperator(value) {
  return (
    isPlainObject(value) &&
    OPERATOR_FIELDS.every((field) => isText(value[field])) &&
    Object.keys(value).every((key) => OPERATOR_FIELDS.includes(key)) &&
    value.role.trim().toUpperCase() !== ACTOR.SYSTEM
  );
}

// A aprovação HUMANA de verdade no histórico da fila: a transição AGUARDANDO_REVISAO -> APROVADO_PARA_CRM feita por um
// HUMAN com a identidade de quem aprovou. Um item que só diz "estado APROVADO_PARA_CRM" (um arquivo adulterado, um
// estado forjado) SEM essa entrada não é uma aprovação. Vale a entrada mais recente (o estado é terminal: só há uma).
function findApproval(prospect) {
  const history = hasOwn(prospect, 'historico') && Array.isArray(prospect.historico) ? prospect.historico : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (
      isPlainObject(entry) &&
      entry.from === QUEUE_STATE.AGUARDANDO_REVISAO &&
      entry.to === QUEUE_STATE.APROVADO_PARA_CRM &&
      entry.actor === ACTOR.HUMAN &&
      isText(entry.timestamp) &&
      isOperator(entry.reviewedBy)
    ) {
      return { por: { userId: entry.reviewedBy.userId, name: entry.reviewedBy.name, role: entry.reviewedBy.role }, em: entry.timestamp };
    }
  }
  return null;
}

// O marcador que liga um registro do CRM ao prospect que o originou: o PRIMEIRO texto do motivo da criação. O id do
// prospect entra como JSON: o fechamento das aspas o delimita, e um id que contenha ";" ou ")" nunca é confundido com
// o prefixo de OUTRO id.
const markerStart = (prospectId) => `${MARKER_PREFIX}${JSON.stringify(prospectId)};`;
const buildReason = (prospectId, approval) => `${markerStart(prospectId)} aprovado por ${approval.por.name} em ${approval.em})`;

// O registro do CRM foi criado por ESTA promoção? O primeiro evento do histórico (a criação) traz o marcador.
function carriesMarker(record, prospectId) {
  if (!isPlainObject(record) || !Array.isArray(record.historico) || record.historico.length === 0) return false;
  const first = record.historico[0];
  return isPlainObject(first) && first.from === null && typeof first.motivo === 'string' && first.motivo.startsWith(markerStart(prospectId));
}

// As opções da promoção: NENHUMA. Qualquer chave é uma tentativa de decidir de fora o que só a fila e os autorizadores
// decidem.
function requireNoOptions(options) {
  if (options === undefined || options === null) return;
  if (!isPlainObject(options)) throw promotionError(PROMOTION_ERROR.INVALID_INPUT, 'as opções devem ser um objeto vazio (nada é aceito de fora)');
  const keys = Object.keys(options);
  if (keys.length > 0) {
    throw promotionError(
      PROMOTION_ERROR.INVALID_INPUT,
      `opções não reconhecidas: ${keys.join(', ')} — a aprovação vem da fila e a identidade dos autorizadores; nada disso é aceito de fora`
    );
  }
}

function requireProspectId(prospectId) {
  if (typeof prospectId !== 'string' || prospectId.trim().length === 0) {
    throw promotionError(PROMOTION_ERROR.INVALID_INPUT, 'prospectId deve ser um texto não vazio');
  }
  return prospectId;
}

// approvalQueueService: o Approval Queue Service (getProspect). approvalPromotionService: a auditoria da promoção na fila
// (recordPromotion, recordPromotionBlocked). crmService: o CRM Service (listRecords, getRecord, createRecord).
// authorizeOperation: a porta do CRM (em produção, authorizeCrmOperation de src/auth), usada só para exigir WRITE:CRM
// logo no início. Todas OBRIGATÓRIAS, sem padrão: sem elas o Service nem existe.
function createCrmIntegrationService(dependencies) {
  const { approvalQueueService, approvalPromotionService, crmService, authorizeOperation } = dependencies || {};

  const requireFunctions = (owner, name, functions) => {
    if (typeof owner !== 'object' || owner === null) throw new Error(`createCrmIntegrationService exige { ${name} }`);
    for (const fn of functions) {
      if (typeof owner[fn] !== 'function') throw new Error(`createCrmIntegrationService: a dependência ${name} não tem a função ${fn}()`);
    }
  };
  requireFunctions(approvalQueueService, 'approvalQueueService', ['getProspect']);
  requireFunctions(approvalPromotionService, 'approvalPromotionService', ['recordPromotion', 'recordPromotionBlocked']);
  requireFunctions(crmService, 'crmService', ['listRecords', 'getRecord', 'createRecord']);
  if (typeof authorizeOperation !== 'function') {
    throw new Error('createCrmIntegrationService exige { authorizeOperation } (função): sem autorizador injetado o Service não existe');
  }
  if (isAsyncFunction(authorizeOperation)) {
    throw new Error('createCrmIntegrationService: o autorizador deve ser síncrono (uma função async devolveria uma Promise)');
  }

  // As funções ficam capturadas aqui: alterar os objetos injetados depois da criação não muda o Service.
  const { getProspect } = approvalQueueService;
  const { recordPromotion, recordPromotionBlocked } = approvalPromotionService;
  const { listRecords, getRecord, createRecord } = crmService;

  // Exige WRITE:CRM (a mesma porta do CRM). Tudo o que não for uma identidade é uma recusa, nunca uma autorização.
  function requireCrmWrite(context) {
    const operator = authorizeOperation(context, PERMISSION.WRITE_CRM);
    if (!isPlainObject(operator) || typeof operator.then === 'function') {
      throw new Error('autorização recusada: o autorizador não devolveu a identidade do operador');
    }
  }

  // Registra um bloqueio na fila (auditoria) e devolve o erro a lançar. Se a própria auditoria falhar, a recusa continua
  // valendo — o erro acusa `auditoriaGravada: false`; nada é escondido e nenhuma falha de auditoria vira sucesso.
  function blocked(context, prospectId, block, errorCode, message, crmRecordId) {
    let auditoriaGravada = true;
    try {
      recordPromotionBlocked(context, prospectId, { codigo: block, motivo: message, crmRecordId: crmRecordId || null });
    } catch {
      auditoriaGravada = false;
    }
    const error = promotionError(errorCode, message);
    error.auditoriaGravada = auditoriaGravada;
    return error;
  }

  const idFromRefusal = (error) => {
    const found = CRM_ID_PATTERN.exec(String(error.message));
    return found ? found[0] : null;
  };

  function result(outcome, prospectId, record, approval, promocao, possivelDuplicidade) {
    return {
      outcome,
      prospectId,
      crmRecordId: record.id,
      record,
      aprovacao: approval,
      promocao: { resultado: promocao.resultado, crmRecordId: promocao.crmRecordId, promovidoEm: promocao.promovidoEm, promovidoPor: promocao.promovidoPor },
      possivelDuplicidade: possivelDuplicidade || null,
    };
  }

  // O registro do CRM que a fila diz ter sido promovido tem de EXISTIR e ser o desta promoção; senão é uma
  // inconsistência clara, e nada é alterado.
  async function alreadyPromoted(context, prospectId, prospect, approval) {
    const promocao = prospect.promocao;
    const inconsistent = (why) =>
      promotionError(PROMOTION_ERROR.INCONSISTENT, `a fila diz que este prospect já foi promovido, mas ${why} — nada foi alterado`);
    if (!isPlainObject(promocao) || !isText(promocao.crmRecordId)) throw inconsistent('o resumo da promoção na fila está inválido');
    const record = await getRecord(context, promocao.crmRecordId);
    if (record === null || record === undefined) throw inconsistent('o registro do CRM não existe');
    if (!carriesMarker(record, prospectId)) throw inconsistent('o registro do CRM apontado não foi criado por esta promoção');
    return result(PROMOTION_OUTCOME.JA_PROMOVIDO, prospectId, record, approval, promocao, null);
  }

  // As promoções de UM serviço rodam uma por vez, na ordem de chegada: a operação inteira (ler a fila, olhar o CRM, criar, gravar a
  // fila) continua indivisível dentro do processo, agora que o CRM é assíncrono e cada `await` cederia a vez (decisão 0023).
  let promotionTail = Promise.resolve();
  function promoteProspect(context, prospectId, options) {
    const run = promotionTail.then(() => promoteProspectUnlocked(context, prospectId, options));
    promotionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function promoteProspectUnlocked(context, prospectId, options) {
    requireCrmWrite(context);
    const id = requireProspectId(prospectId);
    requireNoOptions(options);

    // 1) a aprovação, lida da fila REAL (a fila autoriza APPROVE:LEAD_APPROVAL)
    const prospect = getProspect(context, id);
    if (!isPlainObject(prospect) || prospect.prospectId !== id) {
      throw promotionError(PROMOTION_ERROR.PROSPECT_NOT_FOUND, 'prospect não encontrado na fila de aprovação');
    }
    if (prospect.estado !== QUEUE_STATE.APROVADO_PARA_CRM) {
      throw promotionError(
        PROMOTION_ERROR.NOT_APPROVED,
        `só um prospect ${QUEUE_STATE.APROVADO_PARA_CRM} pode ser promovido (estado atual: ${String(prospect.estado)})`
      );
    }
    const approval = findApproval(prospect);
    if (approval === null) {
      throw promotionError(PROMOTION_ERROR.APPROVAL_MISSING, 'a aprovação humana deste prospect não está registrada no histórico da fila');
    }

    // 2) já promovido? só conferir — nada é gravado
    if (hasOwn(prospect, 'promocao') && prospect.promocao) return await alreadyPromoted(context, id, prospect, approval);

    // 3) recuperação: um registro deste prospect que o CRM já tem (criado antes de uma falha ao gravar a fila)
    const previous = (await listRecords(context)).filter((record) => carriesMarker(record, id));
    if (previous.length > 1) {
      throw promotionError(PROMOTION_ERROR.INCONSISTENT, 'mais de um registro do CRM aponta para este prospect — nada foi alterado');
    }
    if (previous.length === 1) return reconcile(context, id, previous[0], approval);

    // 4) DNC visto pela pesquisa depois da aprovação: falha fechada
    const snapshot = hasOwn(prospect, 'discoverySnapshot') && isPlainObject(prospect.discoverySnapshot) ? prospect.discoverySnapshot : {};
    if (hasOwn(snapshot, 'statusDNC') && snapshot.statusDNC === DNC_STATUS.BLOQUEADO) {
      throw blocked(context, id, PROMOTION_BLOCK.DNC, PROMOTION_ERROR.BLOCKED_DNC, 'o prospect está marcado como DO NOT CONTACT pela verificação de pesquisa', null);
    }

    // 5) o mapeamento (a empresa é a única obrigatória do CRM; nada é fabricado)
    const fields = mapProspectToCrmFields(prospect);
    if (!hasOwn(fields, 'empresa')) {
      throw blocked(context, id, PROMOTION_BLOCK.DADOS_INSUFICIENTES, PROMOTION_ERROR.INSUFFICIENT_DATA, 'o prospect não tem o nome da empresa, obrigatório no CRM', null);
    }

    // 6) criar no CRM (o CRM Service autoriza WRITE:CRM; o DOMÍNIO decide identidade, duplicidade e DNC)
    let created;
    try {
      created = await createRecord(context, fields, { reason: buildReason(id, approval) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (CRM_DNC_REFUSAL.test(message)) {
        throw blocked(context, id, PROMOTION_BLOCK.DNC, PROMOTION_ERROR.BLOCKED_DNC, 'a identidade deste prospect já está bloqueada como DO_NOT_CONTACT no CRM', idFromRefusal(error));
      }
      if (CRM_DUPLICATE_REFUSAL.test(message)) {
        throw blocked(context, id, PROMOTION_BLOCK.DUPLICADO, PROMOTION_ERROR.BLOCKED_DUPLICATE, 'já existe no CRM um registro com a mesma identidade (site, telefone, WhatsApp ou Instagram)', idFromRefusal(error));
      }
      if (CRM_INVALID_DATA_REFUSAL.test(message)) {
        throw blocked(context, id, PROMOTION_BLOCK.DADOS_INSUFICIENTES, PROMOTION_ERROR.INSUFFICIENT_DATA, 'os dados do prospect não são aceitos pelo CRM', null);
      }
      throw error; // autorização, persistência e o inesperado passam intactos — e nada foi gravado
    }

    // 7) registrar na fila (auditoria). O CRM já foi gravado: se isto falhar, a próxima chamada reconcilia (passo 3).
    const possivelDuplicidade = created.duplicidade && isText(created.duplicidade.matchedRecordId) ? created.duplicidade : null;
    let queued;
    try {
      queued = recordPromotion(context, id, {
        resultado: PROMOTION_RESULT.CRIADO,
        crmRecordId: created.record.id,
        possivelDuplicadoDe: possivelDuplicidade ? possivelDuplicidade.matchedRecordId : null,
      });
    } catch (error) {
      // A fila recusa ligar um SEGUNDO registro a um prospect que outro processo já promoveu: é a corrida entre processos
      // (ver CONCORRÊNCIA). O registro que acabou de ser criado ficou duplicado; a tentativa perdedora é auditada.
      if (/já promovido para outro registro do CRM/.test(String(error && error.message))) {
        const raced = blocked(
          context,
          id,
          PROMOTION_BLOCK.DUPLICADO,
          PROMOTION_ERROR.INCONSISTENT,
          'este prospect já foi promovido para outro registro do CRM (corrida entre processos): o registro recém-criado ficou duplicado e precisa de revisão humana',
          created.record.id
        );
        raced.crmRecordId = created.record.id;
        raced.cause = error;
        throw raced;
      }
      const partial = promotionError(
        PROMOTION_ERROR.PARTIAL,
        'o registro foi criado no CRM, mas a fila de aprovação não pôde ser atualizada — repita a promoção: ela reconcilia sem criar outro registro'
      );
      partial.crmRecordId = created.record.id;
      partial.cause = error;
      throw partial;
    }
    return result(PROMOTION_OUTCOME.CRIADO, id, created.record, approval, queued.promocao, possivelDuplicidade);
  }

  // Um registro do CRM já existe para este prospect (criado por uma promoção interrompida): só a fila é atualizada.
  function reconcile(context, prospectId, record, approval) {
    let queued;
    try {
      queued = recordPromotion(context, prospectId, { resultado: PROMOTION_RESULT.RECONCILIADO, crmRecordId: record.id });
    } catch (error) {
      const partial = promotionError(
        PROMOTION_ERROR.PARTIAL,
        'o registro deste prospect já existe no CRM, mas a fila de aprovação não pôde ser atualizada — repita a promoção'
      );
      partial.cause = error;
      throw partial;
    }
    return result(PROMOTION_OUTCOME.RECONCILIADO, prospectId, record, approval, queued.promocao, null);
  }

  return Object.freeze({ promoteProspect });
}

module.exports = { createCrmIntegrationService, PROMOTION_OUTCOME, PROMOTION_ERROR };
