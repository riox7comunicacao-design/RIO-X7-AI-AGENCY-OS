// CRM Service — a fronteira de APLICAÇÃO do CRM operacional (decisões 0012, 0013 e 0014).
//
//   consumidor (futuro Dashboard/API) -> CrmService -> CRM Domain (src/crm) -> porta de persistência -> adapter
//
// O Service NÃO é o CRM. O domínio (src/crm/crmDomain.js) continua dono do modelo de dados, dos 13 status, da
// máquina de estados, do DNC, da deduplicação e do histórico. O Service é a porta de entrada das operações de um
// HUMANO autenticado:
//   - recebe SÓ um AuthorizationContext já emitido — nunca userId, role, permissions ou reviewedBy soltos do
//     consumidor;
//   - autoriza ANTES de qualquer outra coisa: antes de validar detalhes e antes de tocar na persistência;
//   - valida a entrada de APLICAÇÃO (é um objeto simples, as opções são conhecidas, os tipos) — a validação de
//     CAMPOS (quais existem, seus tipos, o que é obrigatório), a do ID e todas as regras de negócio continuam sendo
//     do domínio, sem cópia aqui (o domínio valida o id antes de tocar a persistência);
//   - chama o domínio, sobre o repositório INJETADO, e devolve projeções seguras dos dados, nunca objetos vivos.
//
// AUTORIZAÇÃO — por operação, decidida pelo autorizador INJETADO (a porta authorizeOperation; sua implementação é
// src/auth/crmBridge.js: contexto emitido, usuário ATIVO e a permissão pedida). O Service não reimplementa nada
// disso, e a permissão de cada operação está na tabela PERMISSION_FOR abaixo — o único lugar onde ela é decidida:
//   READ:CRM   listRecords, getRecord, getHistory
//   WRITE:CRM  createRecord, updateRecord, moveStatus, markDoNotContact
// ADMIN tem as duas; COMMERCIAL_CLOSER só READ:CRM — e assim continua: nenhuma permissão foi criada e a matriz de
// permissões não foi ampliada. ANALYZE:CRM e PROPOSE:CRM (que o closer tem) NÃO são usadas por nenhuma operação
// desta versão: o domínio não tem análise nem proposta, e inventar uma operação só para usá-las seria inventar
// escopo. Consequência registrada, não resolvida (decisão 0014): o closer NÃO pode marcar DO_NOT_CONTACT — é uma
// escrita, e ele não tem WRITE:CRM. Se o negócio quiser que quem conversa com o lead possa registrar um pedido de
// "não me contate" na hora, isso exige uma decisão de PRODUTO (uma permissão própria, ou WRITE:CRM para o closer),
// nunca uma exceção aqui.
//
// UMA CAMADA DE AUTORIZAÇÃO (diferente do Approval Queue Service, que autoriza no Service E de novo no domínio): o
// domínio do CRM não tem autorizador injetado (decisão 0013) — o Service é a ÚNICA camada. Por isso a fronteira é
// arquitetural: só src/services pode importar src/crm (regra R12 de tests/auth/architecture-boundaries.test.js) —
// qualquer outro caminho até o domínio contornaria esta autorização, e o teste de arquitetura o impede.
//
// IDENTIDADE NO HISTÓRICO: `reviewedBy` de cada entrada vem SÓ do que o autorizador devolveu (validado aqui: exatamente
// { userId, name, role }, textos não vazios, sem campos a mais, síncrono, e nunca a role SYSTEM); `actor` é sempre
// HUMAN. Operações de SISTEMA (automação, prospecção) ficam fora, como no Approval Queue Service: como um ator de
// sistema se autentica é uma decisão futura.
//
// OPERAÇÕES desta versão — as que o domínio já tem: listRecords, getRecord, getHistory, createRecord, updateRecord,
// moveStatus, markDoNotContact. Ficam FORA, de propósito: excluir (o domínio não tem exclusão, e a história de um
// registro — inclusive um bloqueio DNC — não deve poder ser apagada sem uma decisão de produto); filtros e busca
// (etapas CRM-API/CRM-DASHBOARD); a promoção de um prospect aprovado (etapa CRM-INTEGRATION); qualquer coisa de IA.
//
// PERSISTÊNCIA: o Service recebe o repositório (a porta de src/crm/crmRepositoryPort.js) e NUNCA conhece um adapter
// nem um arquivo — trocar o adapter não muda o Service (sujeito à ressalva de sincronia da porta, decisão 0014).
//
// ERROS: os do domínio e os da autorização passam intactos, sem tradução — mesma classe, mesma mensagem. Só a
// validação de entrada do próprio Service lança erros novos (Error simples, prefixo "CRM: ", como o domínio).
//
// LIMITES honestos: o Service obedece ao autorizador que recebe na criação (quem o compõe escolhe o autorizador —
// fronteira arquitetural interna confiável, não criptografia); a persistência atual é um arquivo sem trava entre
// processos (dentro de um processo cada operação é síncrona e, portanto, indivisível); o Service é síncrono, como o
// domínio; e editar campos comuns (updateRecord) NÃO gera entrada de histórico — o domínio audita só a criação e as
// mudanças de status (auditoria de edição de campos é uma decisão futura, registrada em 0014).

const crmDomainDefault = require('../crm/crmDomain');
const { assertValidRepository } = require('../crm/crmRepositoryPort');
const { ACTOR, CRM_WRITABLE_FIELDS } = require('../crm/constants');
const { PERMISSION } = require('../auth');

// A permissão exigida por cada operação — decidida aqui e em nenhum outro lugar (ver o cabeçalho).
const PERMISSION_FOR = Object.freeze({
  listRecords: PERMISSION.READ_CRM,
  getRecord: PERMISSION.READ_CRM,
  getHistory: PERMISSION.READ_CRM,
  createRecord: PERMISSION.WRITE_CRM,
  updateRecord: PERMISSION.WRITE_CRM,
  moveStatus: PERMISSION.WRITE_CRM,
  markDoNotContact: PERMISSION.WRITE_CRM,
});

// O que o Service usa do domínio (o contrato real de src/crm/crmDomain.js). É verificado na CRIAÇÃO: uma dependência
// incompleta falha fechada logo, em vez de falhar no meio de uma operação.
const REQUIRED_DOMAIN_FUNCTIONS = Object.freeze(['createRecord', 'getRecord', 'listRecords', 'updateRecord', 'moveStatus', 'markDoNotContact']);

// A única identidade que o autorizador pode devolver — e a única que entra no histórico.
const OPERATOR_FIELDS = Object.freeze(['userId', 'name', 'role']);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isAsyncFunction = (fn) => Object.prototype.toString.call(fn) === '[object AsyncFunction]';

// Objeto SIMPLES: literal, resultado de JSON.parse ou Object.create(null). Uma instância de classe ou um objeto com
// protótipo herdado (Object.create({ reason: 'x' })) nunca é uma entrada de aplicação: propriedades HERDADAS não
// devem poder participar de uma decisão. (Um Proxy de um objeto simples passa, e é inofensivo: cada campo é lido uma
// única vez e o valor lido é o que se valida e se usa.)
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const isText = (value) => typeof value === 'string';
const textOrNull = (value) => (isText(value) ? value : null);
const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function requireFields(value, name) {
  if (!isPlainObject(value)) {
    throw new Error(`CRM: ${name} deve ser um objeto simples`);
  }
  return value;
}

// Lê as opções de uma operação. Só passam as chaves conhecidas: qualquer outra — em especial userId, role,
// permissions, reviewedBy ou actor — é recusada, porque a identidade do operador vem SÓ do AuthorizationContext.
function readOptions(options, allowedKeys) {
  if (options === undefined || options === null) return {};
  if (!isPlainObject(options)) throw new Error('CRM: as opções devem ser um objeto simples');
  const unknown = Object.keys(options).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `CRM: opções não reconhecidas: ${unknown.join(', ')} — a identidade e as permissões do operador vêm só do AuthorizationContext, nunca das opções`
    );
  }
  return options;
}

// O motivo (opcional) de uma operação de escrita: texto, sem espaços nas pontas; vazio equivale a ausente.
function readReason(options) {
  const reason = hasOwn(options, 'reason') ? options.reason : undefined;
  if (reason !== undefined && reason !== null && !isText(reason)) {
    throw new Error('CRM: reason deve ser um texto');
  }
  const trimmed = isText(reason) ? reason.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

// Valida o que o AUTORIZADOR devolveu (a porta authorizeOperation). Tudo o que não for exatamente a identidade
// mínima { userId, name, role } é uma recusa, nunca uma autorização: false, undefined, texto, uma Promise de um
// autorizador assíncrono, um objeto com campos a mais (a antiga identidade { ..., permissions }, ou um authUserId
// que nunca deveria sair da camada de autenticação) ou a role SYSTEM (o ator de IA do projeto: nunca um operador).
// Devolve um objeto NOVO com os três campos: é ele que vira `reviewedBy`.
function readOperator(result) {
  if (!isPlainObject(result)) {
    throw new Error('autorização recusada: o autorizador não devolveu a identidade do operador');
  }
  if (typeof result.then === 'function') {
    throw new Error('autorização recusada: o autorizador deve ser síncrono (devolveu uma Promise)');
  }
  const extras = Object.keys(result).filter((key) => !OPERATOR_FIELDS.includes(key));
  if (extras.length > 0) {
    throw new Error(
      `autorização recusada: o autorizador devolveu campos além de { userId, name, role } (${extras.join(', ')}) — só a identidade mínima é aceita`
    );
  }
  for (const field of OPERATOR_FIELDS) {
    if (!isText(result[field]) || result[field].trim().length === 0) {
      throw new Error(`autorização recusada: o autorizador devolveu uma identidade inválida (${field} é obrigatório)`);
    }
  }
  if (result.role.trim().toUpperCase() === ACTOR.SYSTEM) {
    throw new Error('autorização recusada: SYSTEM não é um operador — o CRM Service atende só um humano autenticado');
  }
  return { userId: result.userId.trim(), name: result.name.trim(), role: result.role.trim() };
}

// ---------------------------------------------------------------------------
// Projeções: o que SAI do Service. Uma lista explícita de campos — nunca "o objeto que o domínio devolveu". O que
// não está na lista (um authUserId, um token, um campo interno que apareça no armazenamento por adulteração ou por
// um adapter futuro) nunca chega ao consumidor, e um valor que não seja texto, número finito ou null (um objeto ou
// uma lista adulterados no armazenamento) vira null em vez de sair como veio. A validação de TIPO de cada campo é do
// domínio, na escrita; aqui é só a garantia de que a saída é sempre JSON primitivo, com o formato de sempre.
// ---------------------------------------------------------------------------
function toPublicOperator(value) {
  if (!isPlainObject(value)) return null;
  if (!OPERATOR_FIELDS.every((field) => isText(value[field]))) return null;
  return { userId: value.userId, name: value.name, role: value.role };
}

function toPublicHistoryEntry(entry) {
  const source = isPlainObject(entry) ? entry : {};
  return {
    timestamp: textOrNull(source.timestamp),
    from: textOrNull(source.from),
    to: textOrNull(source.to),
    actor: textOrNull(source.actor),
    reviewedBy: toPublicOperator(source.reviewedBy),
    motivo: textOrNull(source.motivo),
  };
}

function toPublicRecord(record) {
  if (!isPlainObject(record) || !isText(record.id) || record.id.length === 0) {
    // Corrupção do armazenamento aparece (nunca é escondida nem vira um registro "vazio").
    throw new Error('CRM: registro inválido no armazenamento');
  }
  const result = { id: record.id };
  for (const field of CRM_WRITABLE_FIELDS) {
    const value = hasOwn(record, field) ? record[field] : null;
    result[field] = typeof value === 'number' ? numberOrNull(value) : textOrNull(value);
  }
  result.status = textOrNull(record.status);
  result.dataDeEntrada = textOrNull(record.dataDeEntrada);
  result.historico = Array.isArray(record.historico) ? record.historico.map(toPublicHistoryEntry) : [];
  return result;
}

// O aviso de possível duplicidade que createRecord devolve. Só o necessário para um humano decidir: o critério e o
// id do outro registro — nunca o registro inteiro de OUTRA empresa dentro da resposta de uma criação.
function toPublicDuplicidade(duplicidade) {
  if (!isPlainObject(duplicidade)) return null;
  return {
    status: textOrNull(duplicidade.status),
    matchedOn: Array.isArray(duplicidade.matchedOn) ? duplicidade.matchedOn.filter(isText) : [],
    matchedRecordId: isPlainObject(duplicidade.matchedRecord) ? textOrNull(duplicidade.matchedRecord.id) : null,
  };
}

// crm: o domínio (por padrão, o real). authorizeOperation: a porta de autorização — OBRIGATÓRIA, sem padrão: sem
// autorizador o Service nem existe. repository: a porta de persistência — OBRIGATÓRIA, sem padrão: o Service nunca
// escolhe (nem conhece) um adapter.
function createCrmService(dependencies) {
  const { crm = crmDomainDefault, authorizeOperation, repository } = dependencies || {};

  if (typeof authorizeOperation !== 'function') {
    throw new Error('createCrmService exige { authorizeOperation } (função): sem autorizador injetado o Service não existe');
  }
  if (isAsyncFunction(authorizeOperation)) {
    throw new Error('createCrmService: o autorizador deve ser síncrono (uma função async devolveria uma Promise)');
  }
  if (repository === undefined || repository === null) {
    throw new Error('createCrmService exige { repository } (a porta de persistência): o Service não escolhe um adapter');
  }
  assertValidRepository(repository);
  if (typeof crm !== 'object' || crm === null) {
    throw new Error('createCrmService: a dependência crm deve ser o domínio do CRM');
  }
  for (const name of REQUIRED_DOMAIN_FUNCTIONS) {
    if (typeof crm[name] !== 'function') {
      throw new Error(`createCrmService: a dependência crm não tem a função ${name}()`);
    }
  }

  // As funções do domínio ficam capturadas aqui: alterar o objeto injetado depois da criação não muda o Service.
  const domainCreateRecord = crm.createRecord;
  const domainGetRecord = crm.getRecord;
  const domainListRecords = crm.listRecords;
  const domainUpdateRecord = crm.updateRecord;
  const domainMoveStatus = crm.moveStatus;
  const domainMarkDoNotContact = crm.markDoNotContact;

  // Autoriza uma operação e devolve a identidade do operador. Lança quando o autorizador recusa (contexto inválido,
  // usuário inativo, permissão ausente) ou quando ele mesmo é defeituoso (ver readOperator): nunca há uma
  // autorização "por omissão".
  function authorize(context, operation) {
    return readOperator(authorizeOperation(context, PERMISSION_FOR[operation]));
  }

  // O registro que o repositório devolveu para `id` é mesmo o de `id`? Defesa em profundidade da leitura: um
  // repositório defeituoso (ou um id herdado do protótipo do Object, num adapter futuro) poderia devolver o registro
  // de OUTRO id. Um resultado que não é o registro do id pedido nunca sai como se fosse.
  const isRecordOf = (record, id) => isPlainObject(record) && record.id === id;

  function findRecord(recordId) {
    const record = domainGetRecord(repository, recordId);
    return isRecordOf(record, recordId) ? record : null;
  }

  function listRecords(context, options) {
    authorize(context, 'listRecords');
    readOptions(options, []);
    return domainListRecords(repository).map(toPublicRecord);
  }

  function getRecord(context, id) {
    authorize(context, 'getRecord');
    const record = findRecord(id);
    return record === null ? null : toPublicRecord(record);
  }

  function getHistory(context, id) {
    authorize(context, 'getHistory');
    const record = findRecord(id);
    if (record === null) throw new Error(`CRM: registro não encontrado: ${id}`);
    return toPublicRecord(record).historico;
  }

  // Escrever: autoriza -> valida a entrada de aplicação -> chama o domínio, com a identidade DO AUTORIZADOR ->
  // devolve a projeção. O domínio persiste; qualquer erro dele passa intacto, e nada é gravado quando ele lança.
  function createRecord(context, input, options) {
    const operator = authorize(context, 'createRecord');
    const fields = requireFields(input, 'input');
    const known = readOptions(options, ['status', 'reason']);
    const status = hasOwn(known, 'status') ? known.status : undefined;
    if (status !== undefined && status !== null && !isText(status)) {
      throw new Error('CRM: status deve ser um texto');
    }
    const result = domainCreateRecord(repository, fields, {
      ...(status === undefined || status === null ? {} : { status }),
      actor: ACTOR.HUMAN,
      reviewedBy: operator,
      motivo: readReason(known),
    });
    return { record: toPublicRecord(result.record), duplicidade: toPublicDuplicidade(result.duplicidade) };
  }

  function updateRecord(context, id, patch) {
    authorize(context, 'updateRecord');
    return toPublicRecord(domainUpdateRecord(repository, id, requireFields(patch, 'patch')));
  }

  function moveStatus(context, id, to, options) {
    const operator = authorize(context, 'moveStatus');
    if (!isText(to)) throw new Error('CRM: o status de destino deve ser um texto');
    const reason = readReason(readOptions(options, ['reason']));
    return toPublicRecord(domainMoveStatus(repository, id, to, { actor: ACTOR.HUMAN, reviewedBy: operator, motivo: reason }));
  }

  function markDoNotContact(context, id, options) {
    const operator = authorize(context, 'markDoNotContact');
    const reason = readReason(readOptions(options, ['reason']));
    return toPublicRecord(domainMarkDoNotContact(repository, id, { actor: ACTOR.HUMAN, reviewedBy: operator, motivo: reason }));
  }

  return Object.freeze({ listRecords, getRecord, getHistory, createRecord, updateRecord, moveStatus, markDoNotContact });
}

module.exports = { createCrmService };
