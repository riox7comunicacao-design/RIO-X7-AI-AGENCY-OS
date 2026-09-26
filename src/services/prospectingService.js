// Prospecting Service V1 — INGESTÃO CONTROLADA de uma submissão de prospecção.
//
//   (futuro) Central de Agentes -> [rota] -> ProspectingService -> discovery (existente) + CRM Service (leitura) + Approval Queue
//                                                                  (proposta) + repositório de lotes
//
// O QUE FAZ: recebe UMA submissão de um humano autenticado — um briefing e os achados brutos de uma pesquisa feita FORA deste
// módulo (a pesquisa web/IA não existe aqui) — e:
//   1) autoriza (PROPOSE:LEAD_APPROVAL e READ:CRM, antes de olhar qualquer dado);
//   2) valida o briefing e TODOS os achados brutos (rawFindingSchema — dado não confiável; tudo ou nada);
//   3) lê o CRM (só leitura) e o traduz para as checagens do Prospector (crmAdapter: o DNC do CRM é reconhecido);
//   4) roda o discovery JÁ EXISTENTE (identidade, dados, duplicidade, DNC — nada copiado);
//   5) para cada candidato ELEGÍVEL (nunca DNC, duplicado ou dados insuficientes) monta o DOSSIÊ (fatos traduzidos do achado por
//      dossierFromFinding, sinais derivados por buildDossier) e prepara a proposta à Approval Queue (nunca uma aprovação);
//   6) calcula a contabilidade do lote (função pura) e prepara o LOTE (entidade separada da fila e do dossiê);
//   7) grava, nesta ordem: DOSSIÊS -> FILA -> LOTE (o lote é o registro final);
//   8) devolve um relatório seguro (a associação lote/dossiê/prospect é só por identificadores).
//
// O QUE NÃO FAZ: não aprova, não rejeita, não promove, não escreve no CRM, não pesquisa, não usa IA, não faz rede, não tem rota nem
// interface, não cria estado novo na fila e não altera o schema dos itens da fila (o lote guarda os ids dos prospects; a fila
// não sabe do lote). Sem score, ranking ou temperatura.
//
// AUTORIZAÇÃO — duas portas injetadas, ambas decididas ANTES de qualquer outra coisa:
//   authorizeProposer(context, PROPOSE:LEAD_APPROVAL)  -> { userId, name, role }   (ponte: src/auth/leadProposalBridge.js)
//   authorizeOperation(context, READ:CRM)              -> { userId, name, role }   (ponte: src/auth/crmBridge.js)
// ADMIN tem as duas; COMMERCIAL_CLOSER não tem PROPOSE:LEAD_APPROVAL (decisão explícita), então não submete. PROPOSE ≠ APPROVE:
// este serviço nunca recebe nem usa a ponte de aprovação; e o domínio da fila só tem a proposta por uma fábrica própria
// (createApprovalProposalActions), separada das de revisão e de promoção. Quem submete (`criadoPor`) vem SÓ do autorizador:
// o corpo da submissão aceita exatamente { briefing, rawFindings } — qualquer outra chave (userId, role, permissions, actor,
// reviewedBy, approvalId, status, loteId, criadoPor, criadoEm, contagens...) é recusada, e nenhuma chave dos achados pode trazer
// status ou decisão (o esquema recusa). O lote, os timestamps, o status e todas as contagens são DERIVADOS aqui.
//
// IDEMPOTÊNCIA — o mesmo candidato repetido na submissão (mesmo id estável da fila) conta uma vez; um candidato que JÁ está na
// fila segue as regras existentes de reentrada (approvalQueue.addProspect: não duplica o item, nunca sobrescreve uma decisão).
// Nenhuma regra nova de deduplicação foi criada.
//
// ORDEM DE ESCRITA: valida e computa TUDO em memória → grava os dossiês → grava a fila (uma vez) → grava o lote. Falha antes de
// gravar: nada mudou. NÃO HÁ TRANSAÇÃO entre os três arquivos (limite registrado, decisão 0019): uma falha depois de outra gravação
// deixa o que já foi gravado (nada é apagado nem sobrescrito) e o erro traz só identificadores operacionais (loteId, dossierIds,
// prospectIds). Dossiê sem lote é um órfão detectável (o lote é o registro final) e inofensivo; repetir a submissão é um NOVO lote
// (a fila não duplica itens; os dossiês novos têm ids novos).
//
// ERROS — sempre ProspectingError com `code` estável e mensagem fixa em português (nunca stack, valor recebido, caminho ou dado do
// achado); `details` só carrega caminhos e códigos. Os erros de autorização passam intactos (mesma classe, mesma mensagem).
// LIMITES honestos: o serviço obedece aos autorizadores que recebe (fronteira interna confiável, não criptografia); síncrono, como
// os demais; sem trava entre processos (um servidor por pasta de dados); o CRM lido é o de agora (a fila e o CRM podem mudar depois).

const crypto = require('node:crypto');

const approvalQueueDomain = require('../research-prospector/approvalQueue');
const discovery = require('../research-prospector/discovery');
const { toProspectorRecords } = require('../research-prospector/crmAdapter');
const { computeBatchAccounting, MAX_DESIRED } = require('../research-prospector/batchAccounting');
const { assertValidBatchRepository, BATCH_ID_PATTERN } = require('../research-prospector/batchRepository');
const { buildDossier } = require('../research-prospector/dossier');
const { factsFromFinding } = require('../research-prospector/dossierFromFinding');
const { assertValidDossierRepository } = require('../research-prospector/dossierRepository');
const { validateRawFindings, checkText, ERROR: SCHEMA_ERROR, MESSAGES: SCHEMA_MESSAGES, LIMITS: SCHEMA_LIMITS } = require('../research-prospector/rawFindingSchema');
const { PERMISSION } = require('../auth');

const { QUEUE_STATE } = approvalQueueDomain;
const { OPERATIONAL_STATE } = discovery;

// Os códigos estáveis de erro desta camada.
const PROSPECTING_ERROR = Object.freeze({
  INVALID_INPUT: 'PROSPECTING_INVALID_INPUT',
  BRIEFING_INVALID: 'PROSPECTING_BRIEFING_INVALID',
  RAW_FINDINGS_INVALID: 'PROSPECTING_RAW_FINDINGS_INVALID',
  CRM_INVALID: 'PROSPECTING_CRM_INVALID',
  CANDIDATE_INVALID: 'PROSPECTING_CANDIDATE_INVALID',
  PERSISTENCE: 'PROSPECTING_PERSISTENCE',
  CONFLICT: 'PROSPECTING_CONFLICT',
  NOT_FOUND: 'PROSPECTING_NOT_FOUND',
});

const MESSAGES = Object.freeze({
  [PROSPECTING_ERROR.INVALID_INPUT]: 'Prospecção: a submissão é inválida (esperava exatamente { briefing, rawFindings }).',
  [PROSPECTING_ERROR.BRIEFING_INVALID]: 'Prospecção: o briefing é inválido.',
  [PROSPECTING_ERROR.RAW_FINDINGS_INVALID]: 'Prospecção: os achados da pesquisa são inválidos; nada foi processado.',
  [PROSPECTING_ERROR.CRM_INVALID]: 'Prospecção: o CRM não pôde ser lido ou tem registros inválidos; sem ele o DNC não pode ser verificado, então nada foi processado.',
  [PROSPECTING_ERROR.CANDIDATE_INVALID]: 'Prospecção: um candidato não pôde ser processado; nada foi gravado.',
  [PROSPECTING_ERROR.PERSISTENCE]: 'Prospecção: falha ao ler ou gravar os dados locais.',
  [PROSPECTING_ERROR.CONFLICT]: 'Prospecção: conflito ao registrar o lote.',
  [PROSPECTING_ERROR.NOT_FOUND]: 'Prospecção: lote não encontrado.',
});

class ProspectingError extends Error {
  constructor(code, details) {
    super(MESSAGES[code]);
    this.name = 'ProspectingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const BRIEFING_LIMITS = Object.freeze({
  NICHO: 120,
  REGIAO: 120,
  TIPO: 120,
  EXCLUSAO_MIN: 3,
  EXCLUSAO_MAX: 120,
  EXCLUSOES: 50,
  OBSERVACOES: 2000,
  QUANTIDADE_MAX: 1000, // razoável para uma submissão; a função pura aceita até MAX_DESIRED
});

const BRIEFING_KEYS = Object.freeze(['nicho', 'quantidadeDesejada', 'regiao', 'tipo', 'exclusoes', 'observacoes']);
const SUBMISSION_KEYS = Object.freeze(['briefing', 'rawFindings']);

// Os estados que a fila pode devolver para um item que JÁ existia e que valem mais do que a classificação de agora: uma decisão
// humana, o tempo ou um bloqueio anterior.
const QUEUE_STATES_THAT_WIN = Object.freeze([
  QUEUE_STATE.APROVADO_PARA_CRM,
  QUEUE_STATE.REJEITADO,
  QUEUE_STATE.EXPIRADO,
  QUEUE_STATE.DNC,
  QUEUE_STATE.DUPLICADO,
  QUEUE_STATE.DADOS_INSUFICIENTES,
]);

// Só estes estados operacionais do discovery são ELEGÍVEIS para a fila: identidade validada (dados suficientes ou parciais) e
// possível duplicidade (que um humano precisa ver). DNC, duplicado e dados insuficientes NUNCA entram.
const ELIGIBLE_STATES = Object.freeze([OPERATIONAL_STATE.VALIDADO_PARA_REVISAO, OPERATIONAL_STATE.AGUARDANDO_REVISAO, OPERATIONAL_STATE.POSSIVEL_DUPLICADO]);

const BLOCK_REASON = Object.freeze({
  [OPERATIONAL_STATE.DNC]: 'DNC',
  [OPERATIONAL_STATE.DUPLICADO]: 'DUPLICADO',
  [OPERATIONAL_STATE.DADOS_INSUFICIENTES]: 'DADOS_INSUFICIENTES',
});
const REASON_REPEATED = 'REPETIDO_NA_SUBMISSAO';

const BATCH_STATUS = Object.freeze({ META_ATINGIDA: 'META_ATINGIDA', EM_ANDAMENTO: 'EM_ANDAMENTO' });

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const copy = (value) => structuredClone(value);

// Só as chaves conhecidas, só como propriedades PRÓPRIAS de dado. Devolve { ok, entries } — nunca lança por conteúdo.
function readKnownKeys(object, allowed) {
  const values = {};
  const errors = [];
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(object, key) : undefined;
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      errors.push({ path: '', code: SCHEMA_ERROR.ESTRUTURA_INVALIDA });
    } else if (!allowed.includes(key)) {
      errors.push({ path: /^[A-Za-z]{1,40}$/.test(key) ? key : '?', code: SCHEMA_ERROR.CAMPO_DESCONHECIDO });
    } else {
      values[key] = descriptor.value;
    }
  }
  return { values, errors };
}

const withMessage = (error) => ({ ...error, message: SCHEMA_MESSAGES[error.code] });

// O briefing: só as chaves conhecidas, nicho obrigatório, quantidade inteira positiva dentro do limite, textos com limite, exclusões
// como lista limitada de textos (mínimo de 3 caracteres: uma exclusão curta demais excluiria quase tudo).
function validateBriefing(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: [withMessage({ path: 'briefing', code: SCHEMA_ERROR.NAO_E_OBJETO })] };
  const { values, errors: keyErrors } = readKnownKeys(raw, BRIEFING_KEYS);
  const errors = keyErrors.map((error) => withMessage({ ...error, path: `briefing.${error.path}`.replace(/\.$/, '') }));
  const value = {};
  const fail = (path, code) => errors.push(withMessage({ path: `briefing.${path}`, code }));
  const optional = (key) => (hasOwn(values, key) && values[key] !== null && values[key] !== undefined ? values[key] : undefined);

  const nicho = optional('nicho') === undefined ? { error: SCHEMA_ERROR.CAMPO_OBRIGATORIO } : checkText(values.nicho, BRIEFING_LIMITS.NICHO);
  if (nicho.error) fail('nicho', nicho.error);
  else value.nicho = nicho.value;

  const quantidade = optional('quantidadeDesejada');
  if (quantidade === undefined) fail('quantidadeDesejada', SCHEMA_ERROR.CAMPO_OBRIGATORIO);
  else if (typeof quantidade !== 'number' || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > Math.min(BRIEFING_LIMITS.QUANTIDADE_MAX, MAX_DESIRED)) {
    fail('quantidadeDesejada', SCHEMA_ERROR.VALOR_INVALIDO);
  } else value.quantidadeDesejada = quantidade;

  for (const [key, max] of [['regiao', BRIEFING_LIMITS.REGIAO], ['tipo', BRIEFING_LIMITS.TIPO]]) {
    if (optional(key) === undefined) continue;
    const text = checkText(values[key], max);
    if (text.error) fail(key, text.error);
    else value[key] = text.value;
  }
  if (optional('observacoes') !== undefined) {
    const text = checkText(values.observacoes, BRIEFING_LIMITS.OBSERVACOES, { allowNewlines: true });
    if (text.error) fail('observacoes', text.error);
    else value.observacoes = text.value;
  }
  if (optional('exclusoes') !== undefined) {
    const list = values.exclusoes;
    if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) fail('exclusoes', SCHEMA_ERROR.NAO_E_LISTA);
    else if (list.length > BRIEFING_LIMITS.EXCLUSOES) fail('exclusoes', SCHEMA_ERROR.TAMANHO_EXCESSIVO);
    else {
      const exclusoes = [];
      for (let index = 0; index < list.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
        const text = descriptor && hasOwn(descriptor, 'value') ? checkText(descriptor.value, BRIEFING_LIMITS.EXCLUSAO_MAX) : { error: SCHEMA_ERROR.ESTRUTURA_INVALIDA };
        if (text.error) fail(`exclusoes[${index}]`, text.error);
        else if (text.value.length < BRIEFING_LIMITS.EXCLUSAO_MIN) fail(`exclusoes[${index}]`, SCHEMA_ERROR.VALOR_INVALIDO);
        else exclusoes.push(text.value);
      }
      if (Reflect.ownKeys(list).length !== list.length + 1) fail('exclusoes', SCHEMA_ERROR.ESTRUTURA_INVALIDA);
      value.exclusoes = exclusoes;
    }
  }
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors: errors.slice(0, SCHEMA_LIMITS.MAX_ERRORS) };
}

// A identidade que um autorizador devolve: exatamente { userId, name, role }, textos não vazios, síncrona. Fail closed contra um
// autorizador defeituoso (false, undefined, texto, Promise...).
function assertIdentity(identity, portName) {
  if (!isPlainObject(identity) || typeof identity.then === 'function') {
    throw new Error(`autorização recusada: o autorizador (${portName}) não devolveu a identidade do usuário`);
  }
  const keys = Object.keys(identity);
  if (keys.length !== 3 || !['userId', 'name', 'role'].every((key) => typeof identity[key] === 'string' && identity[key].trim() !== '')) {
    throw new Error(`autorização recusada: o autorizador (${portName}) devolveu uma identidade inválida`);
  }
  if (identity.role.trim().toUpperCase() === approvalQueueDomain.ACTOR.SYSTEM) {
    throw new Error(`autorização recusada: o autorizador (${portName}) devolveu a role SYSTEM, que nunca é autora de uma submissão`);
  }
  return { userId: identity.userId.trim(), name: identity.name.trim(), role: identity.role.trim() };
}

// dependencies:
//   authorizeProposer(context, PROPOSE:LEAD_APPROVAL)  — OBRIGATÓRIA, sem padrão
//   authorizeOperation(context, READ:CRM)              — OBRIGATÓRIA, sem padrão (a porta do CRM)
//   crmService                                         — o CRM Service (só listRecords é usado; ele autoriza READ:CRM de novo)
//   batchRepository                                    — a porta de lotes (list/getById/add)
//   approvalQueue (padrão: o domínio real), queuePath (padrão: o da fila)
//   now, newId                                         — só para os testes fixarem o relógio e o id (padrões: Date e uuid)
function createProspectingService(dependencies) {
  const {
    authorizeProposer,
    authorizeOperation,
    crmService,
    batchRepository,
    dossierRepository,
    approvalQueue = approvalQueueDomain,
    queuePath,
    now = () => new Date(),
    newId = () => `lote:${crypto.randomUUID()}`,
    newDossierId, // só para os testes fixarem o id do dossiê (o padrão é o do buildDossier)
  } = dependencies || {};

  if (typeof authorizeProposer !== 'function') throw new Error('createProspectingService exige { authorizeProposer } (função): sem autorizador injetado o Service não existe');
  if (typeof authorizeOperation !== 'function') throw new Error('createProspectingService exige { authorizeOperation } (função): a leitura do CRM também é autorizada');
  if (!crmService || typeof crmService.listRecords !== 'function') throw new Error('createProspectingService exige { crmService } com listRecords()');
  assertValidBatchRepository(batchRepository);
  assertValidDossierRepository(dossierRepository);
  if (newDossierId !== undefined && typeof newDossierId !== 'function') throw new Error('createProspectingService: newDossierId deve ser uma função');
  for (const name of ['createApprovalProposalActions', 'loadQueueFromDisk', 'saveQueueToDisk', 'buildStableId']) {
    if (!approvalQueue || typeof approvalQueue[name] !== 'function') throw new Error(`createProspectingService: a dependência approvalQueue não tem a função ${name}()`);
  }
  const filePath = queuePath === undefined ? approvalQueue.DEFAULT_QUEUE_PATH : queuePath;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new Error('createProspectingService: queuePath deve ser um texto não vazio');
  if (typeof now !== 'function' || typeof newId !== 'function') throw new Error('createProspectingService: now e newId devem ser funções');

  const { loadQueueFromDisk, saveQueueToDisk, buildStableId } = approvalQueue;
  // A proposta usa a porta de PROPOSE — a de aprovação nunca chega aqui.
  const proposals = approvalQueue.createApprovalProposalActions({ authorizeProposer });

  // (1) Autoriza — antes de qualquer outra coisa. Devolve quem é o autor (só do autorizador).
  function authorizeSubmitter(context) {
    const author = assertIdentity(authorizeProposer(context, PERMISSION.PROPOSE_LEAD_APPROVAL), 'proposta');
    assertIdentity(authorizeOperation(context, PERMISSION.READ_CRM), 'CRM');
    return author;
  }

  function readSubmission(submission) {
    if (!isPlainObject(submission)) throw new ProspectingError(PROSPECTING_ERROR.INVALID_INPUT, { errors: [withMessage({ path: '', code: SCHEMA_ERROR.NAO_E_OBJETO })] });
    const { values, errors } = readKnownKeys(submission, SUBMISSION_KEYS);
    for (const key of SUBMISSION_KEYS) if (!hasOwn(values, key)) errors.push({ path: key, code: SCHEMA_ERROR.CAMPO_OBRIGATORIO });
    if (errors.length > 0) throw new ProspectingError(PROSPECTING_ERROR.INVALID_INPUT, { errors: errors.slice(0, SCHEMA_LIMITS.MAX_ERRORS).map(withMessage) });
    return values;
  }

  function loadCrmRecords(context) {
    try {
      const records = crmService.listRecords(context);
      toProspectorRecords(records); // valida a forma agora: um registro ilegível recusa a submissão inteira (falha fechada)
      return records;
    } catch {
      // A autorização (PROPOSE e READ:CRM) já foi decidida no passo 1: o que falha aqui é o DADO (arquivo do CRM corrompido ou
      // ilegível, registro inválido). Erro estável, sem repetir o texto do erro original (que pode citar caminho ou conteúdo).
      throw new ProspectingError(PROSPECTING_ERROR.CRM_INVALID);
    }
  }

  function submitProspecting(context, submission) {
    // 1) autorização
    const author = authorizeSubmitter(context);
    // 2) a forma da submissão, o briefing e os achados (tudo ou nada)
    const { briefing: rawBriefing, rawFindings } = readSubmission(submission);
    const checkedBriefing = validateBriefing(rawBriefing);
    if (!checkedBriefing.ok) throw new ProspectingError(PROSPECTING_ERROR.BRIEFING_INVALID, { errors: checkedBriefing.errors });
    const briefing = checkedBriefing.value;

    const instant = now();
    const checkedFindings = validateRawFindings(rawFindings, { now: instant });
    if (!checkedFindings.ok) {
      const errors = checkedFindings.errors.length > 0 ? checkedFindings.errors : checkedFindings.items.filter((item) => !item.ok).flatMap((item) => item.errors.map((error) => ({ ...error, path: `rawFindings[${item.index}]${error.path ? `.${error.path}` : ''}` })));
      throw new ProspectingError(PROSPECTING_ERROR.RAW_FINDINGS_INVALID, { errors: errors.slice(0, SCHEMA_LIMITS.MAX_ERRORS) });
    }

    // 3) CRM (só leitura) — sem ele o DNC não pode ser verificado: recusa em vez de seguir "sem DNC"
    const crmRecords = loadCrmRecords(context);

    // 4) discovery existente. As exclusões do briefing são aplicadas pela função existente, preservando o índice de cada achado.
    const exclusoes = (briefing.exclusoes || []).map((item) => item.toLowerCase());
    const indexOf = new Map(checkedFindings.validos.map((finding, index) => [finding, index]));
    const screened = discovery.screenExclusions(checkedFindings.validos, exclusoes);
    let pipeline;
    try {
      pipeline = discovery.runDiscoveryPipeline({
        briefing: { nicho: briefing.nicho, regiao: briefing.regiao, quantidadeDesejada: briefing.quantidadeDesejada, tipo: briefing.tipo, exclusoes: [] },
        rawFindings: screened.incluidos,
        crmRecords,
        crmDisponivel: true,
        dataDaPesquisa: instant.toISOString().slice(0, 10),
      });
    } catch {
      throw new ProspectingError(PROSPECTING_ERROR.CANDIDATE_INVALID);
    }

    // 5) o id do lote é DERIVADO aqui (o cliente nunca o envia) e é conferido antes de qualquer gravação
    const loteId = newId();
    if (typeof loteId !== 'string' || !BATCH_ID_PATTERN.test(loteId)) throw new ProspectingError(PROSPECTING_ERROR.PERSISTENCE);

    // 6) fila e dossiês: só os elegíveis; tudo em memória, gravação no fim
    let queue;
    try {
      queue = loadQueueFromDisk(filePath);
    } catch {
      throw new ProspectingError(PROSPECTING_ERROR.PERSISTENCE);
    }
    const seen = new Set();
    const dossiers = [];
    const resultados = [];
    let repetidos = 0;
    let adicionados = 0;
    let jaExistiam = 0;
    pipeline.resultados.forEach((result, position) => {
      const indice = indexOf.get(screened.incluidos[position]);
      let prospectId;
      try {
        prospectId = buildStableId(result);
      } catch {
        throw new ProspectingError(PROSPECTING_ERROR.CANDIDATE_INVALID);
      }
      if (seen.has(prospectId)) {
        repetidos += 1;
        resultados.push({ indice, empresa: result.empresa, prospectId, estadoOperacional: result.estadoOperacional, estadoLote: null, naFila: false, jaExistiaNaFila: false, estadoFila: null, dossierId: null, motivo: REASON_REPEATED, criterios: [] });
        return;
      }
      seen.add(prospectId);

      const entry = {
        indice,
        empresa: result.empresa,
        prospectId,
        estadoOperacional: result.estadoOperacional,
        estadoLote: result.estadoOperacional,
        naFila: false,
        jaExistiaNaFila: false,
        estadoFila: null,
        dossierId: null,
        motivo: BLOCK_REASON[result.estadoOperacional] || null,
        criterios: Array.isArray(result.matchedOn) ? [...result.matchedOn] : [],
      };
      if (ELIGIBLE_STATES.includes(result.estadoOperacional)) {
        const existed = hasOwn(queue.items, prospectId);
        let item;
        try {
          item = proposals.proposeProspect(queue, context, result);
        } catch (error) {
          // Só os erros DO CANDIDATO (dados inválidos, candidato bloqueado) viram um erro estável; qualquer outro — em especial
          // uma recusa de autorização — passa intacto.
          if (error && /^(discoveryResult inválido|candidato bloqueado)/.test(String(error.message))) throw new ProspectingError(PROSPECTING_ERROR.CANDIDATE_INVALID);
          throw error;
        }
        entry.naFila = true;
        entry.jaExistiaNaFila = existed;
        entry.estadoFila = item.estado;
        if (existed) jaExistiam += 1;
        else adicionados += 1;
        // o que a fila já decidiu para um item que existia vale mais do que a classificação de agora
        if (QUEUE_STATES_THAT_WIN.includes(item.estado)) entry.estadoLote = item.estado;
        // o dossiê do candidato pesquisado (só elegíveis; sem fatos, sem dossiê): associado por identificadores, nunca dentro da fila
        const fatos = factsFromFinding(checkedFindings.validos[indice], instant.toISOString().slice(0, 10));
        if (fatos.length > 0) {
          const built = buildDossier({ prospectId, loteId, fatos }, { now: instant, ...(newDossierId ? { newId: newDossierId } : {}) });
          if (!built.ok) throw new ProspectingError(PROSPECTING_ERROR.CANDIDATE_INVALID);
          dossiers.push(built.value);
          entry.dossierId = built.value.dossierId;
        }
      }
      resultados.push(entry);
    });

    // 7) contabilidade (pura) e o lote — todos os valores são derivados aqui
    const counted = resultados.filter((entry) => entry.motivo !== REASON_REPEATED);
    const accounting = computeBatchAccounting({ quantidadeDesejada: briefing.quantidadeDesejada, candidatos: counted.map((entry) => ({ estadoOperacional: entry.estadoLote })) });
    const batch = {
      loteId,
      status: accounting.falta === 0 ? BATCH_STATUS.META_ATINGIDA : BATCH_STATUS.EM_ANDAMENTO,
      criadoPor: author,
      criadoEm: instant.toISOString(),
      briefing,
      contagens: accounting,
      adicionadosNaFila: adicionados,
      jaExistiamNaFila: jaExistiam,
      repetidosNaSubmissao: repetidos,
      excluidosPeloBriefing: screened.excluidos.length,
      prospectIds: counted.filter((entry) => entry.naFila).map((entry) => entry.prospectId),
      dossierIds: dossiers.map((dossier) => dossier.dossierId),
      resultados,
    };

    // 8) grava, sem transação: os dossiês, depois a fila (só se algo entrou), por fim o lote (o registro final)
    const savedDossierIds = [];
    for (const dossier of dossiers) {
      try {
        dossierRepository.save(dossier);
      } catch {
        throw new ProspectingError(PROSPECTING_ERROR.PERSISTENCE, { loteId, dossierIds: savedDossierIds });
      }
      savedDossierIds.push(dossier.dossierId);
    }
    if (adicionados + jaExistiam > 0) {
      try {
        saveQueueToDisk(queue, filePath);
      } catch {
        throw new ProspectingError(PROSPECTING_ERROR.PERSISTENCE, { loteId, dossierIds: savedDossierIds });
      }
    }
    try {
      batchRepository.add(batch);
    } catch (error) {
      if (error && error.code === 'BATCH_CONFLICT') throw new ProspectingError(PROSPECTING_ERROR.CONFLICT);
      throw new ProspectingError(PROSPECTING_ERROR.PERSISTENCE, { loteId, dossierIds: savedDossierIds, prospectIds: batch.prospectIds });
    }
    return copy(batch);
  }

  function getBatch(context, loteId) {
    authorizeProposerOnly(context);
    if (typeof loteId !== 'string' || !BATCH_ID_PATTERN.test(loteId)) throw new ProspectingError(PROSPECTING_ERROR.INVALID_INPUT);
    let batch;
    try {
      batch = batchRepository.getById(loteId);
    } catch {
      throw new ProspectingError(PROSPECTING_ERROR.PERSISTENCE);
    }
    if (!batch) throw new ProspectingError(PROSPECTING_ERROR.NOT_FOUND);
    return copy(batch);
  }

  function listBatches(context) {
    authorizeProposerOnly(context);
    try {
      return batchRepository.list().map(copy).sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
    } catch {
      throw new ProspectingError(PROSPECTING_ERROR.PERSISTENCE);
    }
  }

  function authorizeProposerOnly(context) {
    assertIdentity(authorizeProposer(context, PERMISSION.PROPOSE_LEAD_APPROVAL), 'proposta');
  }

  return Object.freeze({ submitProspecting, getBatch, listBatches });
}

module.exports = { createProspectingService, ProspectingError, PROSPECTING_ERROR, BRIEFING_LIMITS, BATCH_STATUS, validateBriefing };
