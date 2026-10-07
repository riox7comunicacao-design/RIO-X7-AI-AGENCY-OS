// Prospecting Job Service (Fase 2 — "INICIAR PROSPECÇÃO"): a execução AUTOMÁTICA de uma prospecção, a camada ACIMA do Prospecting Brief Service.
//
//   Dashboard -> ProspectingJobService -> [motor de descoberta] -> Researcher (fetchPage + verifyOnPage) -> UMA ingestão pelo caminho oficial
//                                                                    prospectingBriefService.ingestFindings -> exclusões -> dedup -> DNC -> Approval Queue
//
// O QUE FAZ: com o brief PRONTO_PARA_PESQUISA (e SÓ nele), cria um JOB persistido em arquivo, devolve o id NA HORA e executa em
// segundo plano: (1) descobre candidatos pelo motor injetado (`claude -p`, só ferramentas de pesquisa web; limite = quantidade x 2, no máximo 40);
// (2) aplica as exclusões permanentes ANTES de gastar uma leitura de página; (3) valida CADA candidato pelo Researcher existente — a prova é o texto
// da página (verifyOnPage), nunca o que o agente afirmou; (4) faz UMA única passagem dos VALIDADOS pelo caminho oficial de ingestão.
//
// O QUE NÃO FAZ: não cria outro caminho de ingestão, não promove para o CRM (a Approval Queue segue sendo o ponto de aprovação humana), não altera
// permissões (reaproveita PROPOSE:LEAD_APPROVAL, a mesma do Brief Service), não "conserta" nem completa candidatos fracos para atingir a quantidade
// (se faltar: PARCIAL), não guarda prompt nem texto de página.
//
// ESTADOS: CRIADO -> EXECUTANDO -> CONCLUIDO | PARCIAL | CANCELADO | ERRO (e CANCELAMENTO_SOLICITADO entre o pedido de cancelamento e a próxima
// fronteira segura). CONCLUIDO = a quantidade pedida foi validada; PARCIAL = menos (candidatos/ciclos/tempo/válidos insuficientes); nunca se
// "completa" com candidatos não validados.
//
// CANCELAR: só ANTES da ingestão. O pedido marca o job e aborta o motor de descoberta em andamento; a execução para na PRÓXIMA fronteira segura
// (antes de uma nova descoberta, de uma nova validação ou da ingestão) e termina CANCELADO, sem ingestão parcial. Quando a ingestão começa, o job
// recusa o cancelamento (nada é desfeito).
//
// REINÍCIO: um job que estava rodando quando o servidor caiu NUNCA finge ter concluído — `recoverInterruptedJobs()` (chamado na subida) o marca ERRO
// com o código JOB_INTERRUPTED.
//
// PERSISTÊNCIA (arquivo local, sem Supabase): só o necessário — contadores, um resumo de cada candidato (nome, site, resultado, motivo), os achados
// VALIDADOS enquanto a execução não termina (apagados no fim) e a telemetria agregada (tempo, custo, buscas). Nenhum prompt, nenhum texto de página.

const { PERMISSION } = require('../auth');
const { createResearcher } = require('../research-prospector/researcher');
const { parseRegion } = require('../research-prospector/pageVerification');
const { summarizeGeografia, BRIEF_STATUS, GEO_LEVEL } = require('../research-prospector/prospectingBrief');
const { normalizeNameCity, normalizeDomain } = require('../research-prospector/normalize');
const { assertValidJobRepository } = require('../research-prospector/jobRepository');
const {
  JOB_STATUS,
  JOB_STEP,
  CANDIDATE_RESULT,
  CANDIDATE_REASON,
  ERROR_CODE,
  LIMITS,
  JOB_ID_PATTERN,
  computeCandidateLimit,
  buildJobId,
  isActive,
  classifyResearch,
} = require('../research-prospector/prospectingJob');

class ProspectingJobError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProspectingJobError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const ERROR = Object.freeze({
  INVALID_INPUT: 'JOB_INVALID_INPUT',
  NOT_FOUND: 'JOB_NOT_FOUND',
  INVALID_STATE: 'JOB_INVALID_STATE',
  ALREADY_RUNNING: 'JOB_ALREADY_RUNNING',
  BRIEF_UNSUPPORTED: 'JOB_BRIEF_UNSUPPORTED',
  PERSISTENCE: 'JOB_PERSISTENCE',
});

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const copy = (value) => structuredClone(value);

function assertIdentity(identity) {
  if (!isPlainObject(identity) || typeof identity.then === 'function') throw new Error('autorização recusada: o autorizador (proposta) não devolveu a identidade do usuário');
  const keys = Object.keys(identity);
  if (keys.length !== 3 || !['userId', 'name', 'role'].every((key) => typeof identity[key] === 'string' && identity[key].trim() !== '')) {
    throw new Error('autorização recusada: o autorizador (proposta) devolveu uma identidade inválida');
  }
  return { userId: identity.userId.trim(), name: identity.name.trim(), role: identity.role.trim() };
}

// o processo existe? (sinal 0 só testa; EPERM = existe, mas é de outro usuário)
function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

const candidateKey = (candidate) => `${normalizeNameCity(candidate.nome, 'x') || candidate.nome.toLowerCase()}|${normalizeDomain(candidate.url) || candidate.url}`;

// dependencies:
//   authorizeProposer(context, PROPOSE:LEAD_APPROVAL)   OBRIGATÓRIA — a mesma ponte do Brief Service (nenhuma permissão nova)
//   briefService      OBRIGATÓRIA — só usa getBrief, generateResearchPackage e ingestFindings (o caminho oficial)
//   repository        OBRIGATÓRIA — a porta de jobs (list/getById/save)
//   discoveryEngine   OBRIGATÓRIA — { discover(request) } (o motor externo; nos testes, um double)
//   createFetchPage   OBRIGATÓRIA — () => fetchPage: a porta de leitura de página, nova a cada job (orçamento próprio)
//   checkPermanentExclusion (opcional) — (finding) => false | exclusão (o MESMO isExcluded das exclusões permanentes)
//   now, limits (sobrescritas dos limites, só para testes)
//   processId, isProcessAlive (injetáveis nos testes): o job guarda o PID do processo que o executa; a recuperação NÃO marca como interrompido um job
//   cujo processo (outro, ainda vivo) é o dono — por exemplo, uma suíte de testes não pode estragar a prospecção real de um servidor em execução
function createProspectingJobService(dependencies) {
  const { authorizeProposer, briefService, repository, discoveryEngine, createFetchPage, checkPermanentExclusion, now = () => new Date(), limits: limitOverrides = {}, processId = process.pid, isProcessAlive = defaultIsProcessAlive } = dependencies || {};

  if (typeof authorizeProposer !== 'function') throw new Error('createProspectingJobService exige { authorizeProposer } (função)');
  for (const method of ['getBrief', 'generateResearchPackage', 'ingestFindings']) {
    if (!briefService || typeof briefService[method] !== 'function') throw new Error(`createProspectingJobService exige { briefService } com ${method}()`);
  }
  assertValidJobRepository(repository);
  if (!discoveryEngine || typeof discoveryEngine.discover !== 'function') throw new Error('createProspectingJobService exige { discoveryEngine } com discover()');
  if (typeof createFetchPage !== 'function') throw new Error('createProspectingJobService exige { createFetchPage } (função)');
  if (checkPermanentExclusion !== undefined && checkPermanentExclusion !== null && typeof checkPermanentExclusion !== 'function') {
    throw new Error('createProspectingJobService: checkPermanentExclusion, se informado, deve ser uma função');
  }
  if (typeof now !== 'function') throw new Error('createProspectingJobService: now deve ser uma função');
  const isExcluded = typeof checkPermanentExclusion === 'function' ? checkPermanentExclusion : () => false;

  const limits = Object.freeze({
    candidatesMultiplier: limitOverrides.candidatesMultiplier ?? LIMITS.CANDIDATES_MULTIPLIER,
    candidatesAbsoluteMax: Math.min(limitOverrides.candidatesAbsoluteMax ?? LIMITS.CANDIDATES_ABSOLUTE_MAX, LIMITS.CANDIDATES_ABSOLUTE_MAX),
    maxCycles: limitOverrides.maxCycles ?? LIMITS.MAX_CYCLES,
    maxDurationMs: limitOverrides.maxDurationMs ?? LIMITS.MAX_DURATION_MS,
    discoveryTimeoutMs: limitOverrides.discoveryTimeoutMs ?? LIMITS.DISCOVERY_TIMEOUT_MS,
    candidateTimeoutMs: limitOverrides.candidateTimeoutMs ?? LIMITS.CANDIDATE_TIMEOUT_MS,
  });
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`createProspectingJobService: o limite ${name} deve ser um inteiro >= 1`);
  }

  // job id -> { controller, promise } dos jobs em execução NESTE processo
  const running = new Map();

  function authorize(context) {
    return assertIdentity(authorizeProposer(context, PERMISSION.PROPOSE_LEAD_APPROVAL));
  }

  function loadAll() {
    try {
      return repository.list();
    } catch {
      throw new ProspectingJobError(ERROR.PERSISTENCE, 'Prospecção: não foi possível ler os jobs.');
    }
  }

  function requireJob(id) {
    if (typeof id !== 'string' || !JOB_ID_PATTERN.test(id)) throw new ProspectingJobError(ERROR.INVALID_INPUT, 'Prospecção: identificador de job inválido.');
    let job;
    try {
      job = repository.getById(id);
    } catch {
      throw new ProspectingJobError(ERROR.PERSISTENCE, 'Prospecção: não foi possível ler os jobs.');
    }
    if (!job) throw new ProspectingJobError(ERROR.NOT_FOUND, 'Prospecção: job não encontrado.');
    return job;
  }

  function saveJob(job) {
    try {
      repository.save(job);
    } catch {
      throw new ProspectingJobError(ERROR.PERSISTENCE, 'Prospecção: não foi possível gravar o job.');
    }
  }

  // Lê o job mais recente, aplica só os campos informados e grava (nunca sobrescreve `cancelRequested`, que outro caminho escreve).
  function patch(id, fields) {
    const job = requireJob(id);
    Object.assign(job, fields);
    saveJob(job);
    return job;
  }

  // a visão que sai para quem consulta: o job sem os achados internos, com o tempo decorrido calculado
  function view(job) {
    const out = copy(job);
    delete out.achadosValidados;
    const start = out.startedAt ? Date.parse(out.startedAt) : null;
    const end = out.finishedAt ? Date.parse(out.finishedAt) : now().getTime();
    out.elapsedMs = start === null ? 0 : Math.max(0, end - start);
    return out;
  }

  const wasCancelRequested = (id) => requireJob(id).cancelRequested === true;

  // ------------------------------------------------------------------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------------------------------------------------------------------

  async function startJob(context, input) {
    const author = authorize(context);
    if (!isPlainObject(input) || Object.keys(input).length !== 1 || typeof input.briefId !== 'string') {
      throw new ProspectingJobError(ERROR.INVALID_INPUT, 'Prospecção: envie exatamente { briefId }.');
    }
    const brief = await briefService.getBrief(context, input.briefId);
    // máquina de estados explícita: PRONTO_PARA_PESQUISA -> job. Um brief em PESQUISANDO (ou em qualquer outro estado) NUNCA inicia um novo job.
    if (brief.status !== BRIEF_STATUS.PRONTO_PARA_PESQUISA) {
      throw new ProspectingJobError(ERROR.INVALID_STATE, `Prospecção: iniciar a prospecção exige o brief PRONTO_PARA_PESQUISA (está em ${brief.status}).`);
    }
    // O MVP valida a localização pelo texto da página para UMA cidade: outros níveis geográficos não têm como ser comprovados por código.
    const region = brief.nivelGeografico === GEO_LEVEL.CIDADE && Array.isArray(brief.cidades) && brief.cidades.length === 1 ? parseRegion(summarizeGeografia(brief)) : null;
    if (region === null) {
      throw new ProspectingJobError(ERROR.BRIEF_UNSUPPORTED, 'Prospecção: a prospecção automática exige um brief de UMA cidade (a localização é comprovada pela página).');
    }
    const all = loadAll();
    // uma prospecção automática por vez (cada uma consome pesquisa e leitura de páginas): nunca duas em paralelo
    if (all.some((job) => isActive(job.status))) throw new ProspectingJobError(ERROR.ALREADY_RUNNING, 'Prospecção: já existe uma prospecção em execução.');

    await briefService.generateResearchPackage(context, brief.id); // PRONTO -> PESQUISANDO

    const instant = now();
    const prefix = `JOB-${instant.getUTCFullYear()}${String(instant.getUTCMonth() + 1).padStart(2, '0')}${String(instant.getUTCDate()).padStart(2, '0')}-`;
    const id = buildJobId(instant, all.filter((job) => job.id.startsWith(prefix)).length + 1);
    const maxCandidates = computeCandidateLimit(brief.quantidade, { multiplier: limits.candidatesMultiplier, absoluteMax: limits.candidatesAbsoluteMax });
    const job = {
      id,
      briefId: brief.id,
      status: JOB_STATUS.CRIADO,
      createdAt: instant.toISOString(),
      startedAt: null,
      finishedAt: null,
      criadoPor: author,
      processId,
      requestedQuantity: brief.quantidade,
      candidatesDiscovered: 0,
      candidatesValidated: 0,
      candidatesRejected: 0,
      candidatesUnverified: 0,
      candidatesDiscarded: 0,
      progress: 0,
      currentStep: JOB_STEP.PREPARANDO,
      error: null,
      cancelRequested: false,
      ingestionStarted: false,
      limits: { maxCandidates, maxDurationMs: limits.maxDurationMs, maxCycles: limits.maxCycles },
      cycles: 0,
      candidatos: [],
      achadosValidados: [],
      lote: null,
      telemetria: { discoveryMs: 0, validationMs: 0, custoUsd: 0, webSearchRequests: 0, discoveryRuns: 0, limitReached: null },
    };
    saveJob(job);
    job.status = JOB_STATUS.EXECUTANDO;
    job.startedAt = instant.toISOString();
    saveJob(job);

    const controller = new AbortController();
    const promise = Promise.resolve().then(() => execute(id, context, brief, region, controller));
    running.set(id, { controller, promise });
    return view(job);
  }

  function getJob(context, id) {
    authorize(context);
    return view(requireJob(id));
  }

  function listJobs(context, filter = {}) {
    authorize(context);
    const briefId = isPlainObject(filter) && typeof filter.briefId === 'string' ? filter.briefId : null;
    return loadAll()
      .filter((job) => briefId === null || job.briefId === briefId)
      .map(view)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  // Só ANTES da ingestão. Marca o pedido e aborta a descoberta em andamento; a execução termina CANCELADO na próxima fronteira segura.
  function cancelJob(context, id) {
    authorize(context);
    const job = requireJob(id);
    if (!isActive(job.status)) throw new ProspectingJobError(ERROR.INVALID_STATE, `Prospecção: o job está ${job.status} e não pode mais ser cancelado.`);
    if (job.ingestionStarted === true) throw new ProspectingJobError(ERROR.INVALID_STATE, 'Prospecção: a ingestão já começou e não pode ser cancelada.');
    job.cancelRequested = true;
    job.status = JOB_STATUS.CANCELAMENTO_SOLICITADO;
    saveJob(job);
    const entry = running.get(id);
    if (entry) entry.controller.abort();
    return view(job);
  }

  // Na subida do servidor: o que estava ativo e não tem execução neste processo foi INTERROMPIDO — nunca finge ter concluído.
  function recoverInterruptedJobs() {
    let recovered = 0;
    for (const job of loadAll()) {
      if (!isActive(job.status) || running.has(job.id)) continue;
      // o dono é OUTRO processo que ainda está vivo: a execução não é nossa para encerrar
      if (Number.isInteger(job.processId) && job.processId !== processId && isProcessAlive(job.processId)) continue;
      job.status = JOB_STATUS.ERRO;
      job.error = { code: ERROR_CODE.INTERRUPTED, message: job.ingestionStarted ? 'A execução foi interrompida durante a ingestão; confira o estado do brief antes de repetir.' : 'A execução foi interrompida (o servidor foi reiniciado).' };
      job.finishedAt = now().toISOString();
      job.currentStep = JOB_STEP.FINALIZADO;
      job.achadosValidados = [];
      saveJob(job);
      recovered += 1;
    }
    return recovered;
  }

  // Espera a execução em segundo plano de um job (testes e composição; nenhuma rota HTTP usa isto).
  async function waitFor(id) {
    const entry = running.get(id);
    if (entry) await entry.promise;
    return view(requireJob(id));
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Execução (em segundo plano)
  // ------------------------------------------------------------------------------------------------------------------------------

  async function execute(id, context, brief, region, controller) {
    try {
      await run(id, context, brief, region, controller);
    } catch (error) {
      try {
        finalize(id, JOB_STATUS.ERRO, { error: { code: error && error.code === ERROR_CODE.INGESTION_FAILED ? ERROR_CODE.INGESTION_FAILED : ERROR_CODE.INTERNAL, message: 'A prospecção falhou por um erro interno.' } });
      } catch {
        // o armazenamento também falhou: não há mais o que registrar
      }
    } finally {
      running.delete(id);
    }
  }

  function finalize(id, status, extra = {}) {
    const job = requireJob(id);
    return patch(id, { ...extra, status, finishedAt: now().toISOString(), currentStep: JOB_STEP.FINALIZADO, achadosValidados: [], progress: status === JOB_STATUS.CONCLUIDO || status === JOB_STATUS.PARCIAL ? 100 : job.progress });
  }

  async function run(id, context, brief, region, controller) {
    const startMs = now().getTime();
    const deadline = startMs + limits.maxDurationMs;
    const timeLeft = () => deadline - now().getTime();
    const maxCandidates = requireJob(id).limits.maxCandidates;
    const quantity = brief.quantidade;
    const tele = { discoveryMs: 0, validationMs: 0, custoUsd: 0, webSearchRequests: 0, discoveryRuns: 0, limitReached: null };

    const seen = new Set();
    const candidates = []; // { nome, url, fonteUrl, resultado, motivo, causa? }
    const valid = []; // achados V2 validados
    let limitReached = null;

    const counts = () => ({
      candidatesDiscovered: candidates.length,
      candidatesValidated: candidates.filter((c) => c.resultado === CANDIDATE_RESULT.VALIDADO).length,
      candidatesRejected: candidates.filter((c) => c.resultado === CANDIDATE_RESULT.NAO_VERIFICADO || c.resultado === CANDIDATE_RESULT.DESCARTADO).length,
      candidatesUnverified: candidates.filter((c) => c.resultado === CANDIDATE_RESULT.NAO_VERIFICADO).length,
      candidatesDiscarded: candidates.filter((c) => c.resultado === CANDIDATE_RESULT.DESCARTADO).length,
    });
    const checked = () => candidates.filter((c) => c.resultado !== undefined).length;
    // 15% = descobrindo; de 20% a 90% = candidatos já examinados; 95% = ingestão; 100% = terminou. Nunca regride.
    const progressNow = () => (candidates.length === 0 ? 15 : Math.min(90, 20 + Math.round((70 * checked()) / candidates.length)));
    const save = (step, extra = {}) => patch(id, { ...counts(), currentStep: step, progress: Math.max(requireJob(id).progress, extra.progress ?? progressNow()), candidatos: candidates.map(summary), achadosValidados: valid, telemetria: { ...tele }, ...extra });
    const summary = (c) => ({ nome: c.nome, url: c.url, resultado: c.resultado || null, ...(c.motivo ? { motivo: c.motivo } : {}), ...(c.causa ? { causa: c.causa } : {}), ...(c.faltando ? { faltando: c.faltando } : {}) });

    const cancelled = () => {
      finalize(id, JOB_STATUS.CANCELADO, { ...counts(), candidatos: candidates.map(summary), telemetria: { ...tele } });
      return true;
    };

    const fetchPage = createFetchPage();
    const hint = { cidade: region.cidade, estado: region.uf };
    const region0 = summarizeGeografia(brief);

    // ---- um candidato: exclusão permanente -> Researcher (página + verificação por código) ----
    async function validateCandidate(candidate) {
      try {
        const excluded = await isExcluded({ empresa: candidate.nome, cidade: hint.cidade, ...(hint.estado ? { estado: hint.estado } : {}) });
        if (excluded) return { resultado: CANDIDATE_RESULT.DESCARTADO, motivo: CANDIDATE_REASON.EXCLUSAO_PERMANENTE };
      } catch {
        return { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.EXCLUSAO_NAO_CONSULTADA };
      }
      try {
        const researcher = createResearcher(
          { search: async () => ({ ok: true, resultados: [{ nome: candidate.nome, url: candidate.url, tipoResultado: 'SITE', fonteUrl: candidate.fonteUrl }] }), fetchPage },
          { now, maxDurationMs: Math.max(1, Math.min(limits.candidateTimeoutMs, timeLeft())) }
        );
        const output = await researcher.research({ nicho: brief.nicho, quantidadeDesejada: 1, regiao: region0, ...(brief.subnicho ? { tipo: brief.subnicho } : {}) });
        return classifyResearch(output);
      } catch {
        return { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.VALIDACAO_FALHOU };
      }
    }

    // ---- ciclos de descoberta + validação ----
    for (let cycle = 1; cycle <= limits.maxCycles; cycle += 1) {
      if (wasCancelRequested(id)) return cancelled();
      if (timeLeft() <= 0) {
        limitReached = 'TEMPO';
        break;
      }
      if (candidates.length >= maxCandidates) {
        limitReached = 'CANDIDATOS';
        break;
      }
      patch(id, { currentStep: JOB_STEP.DESCOBRINDO, cycles: cycle, ...counts(), telemetria: { ...tele } });

      const askedAt = now().getTime();
      const found = await discoveryEngine.discover({
        nicho: brief.nicho,
        subnicho: brief.subnicho,
        cidade: region.cidade,
        uf: region.uf,
        limit: maxCandidates - candidates.length,
        excluir: candidates.map((c) => c.nome),
        signal: controller.signal,
        timeoutMs: Math.max(1, Math.min(limits.discoveryTimeoutMs, timeLeft())),
      });
      tele.discoveryMs += now().getTime() - askedAt;
      tele.discoveryRuns += 1;
      if (found && typeof found.custoUsd === 'number') tele.custoUsd += found.custoUsd;
      if (found && Number.isInteger(found.webSearchRequests)) tele.webSearchRequests += found.webSearchRequests;

      if (wasCancelRequested(id)) return cancelled();
      if (!found || found.ok !== true || !Array.isArray(found.candidatos)) {
        if (cycle === 1 && candidates.length === 0) {
          finalize(id, JOB_STATUS.ERRO, { ...counts(), telemetria: { ...tele }, error: { code: ERROR_CODE.DISCOVERY_FAILED, message: 'A descoberta de candidatos falhou.', cause: found && typeof found.code === 'string' ? found.code : 'DESCONHECIDA' } });
          return undefined;
        }
        limitReached = limitReached || 'DESCOBERTA';
        break;
      }

      // candidatos novos (sem repetir nome/site já vistos), no máximo até o limite
      const fresh = [];
      for (const item of found.candidatos) {
        if (candidates.length + fresh.length >= maxCandidates) break;
        const key = candidateKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({ nome: item.nome, url: item.url, fonteUrl: item.fonteUrl });
      }
      for (const item of fresh) candidates.push(item);
      save(JOB_STEP.VALIDANDO);
      if (fresh.length === 0) break; // nada novo: não adianta repetir

      for (const candidate of fresh) {
        if (wasCancelRequested(id)) return cancelled();
        if (valid.length >= quantity) break;
        if (timeLeft() <= 0) {
          limitReached = 'TEMPO';
          break;
        }
        const startedValidation = now().getTime();
        const outcome = await validateCandidate(candidate);
        tele.validationMs += now().getTime() - startedValidation;
        candidate.resultado = outcome.resultado;
        if (outcome.motivo) candidate.motivo = outcome.motivo;
        if (outcome.causa) candidate.causa = outcome.causa;
        if (outcome.faltando) candidate.faltando = outcome.faltando;
        if (outcome.resultado === CANDIDATE_RESULT.VALIDADO && outcome.achado) valid.push(outcome.achado);
        save(JOB_STEP.VALIDANDO);
      }
      if (valid.length >= quantity || limitReached) break;
    }
    if (limitReached === null && valid.length < quantity && candidates.length >= maxCandidates) limitReached = 'CANDIDATOS';

    // ---- fronteira segura final: ainda dá para cancelar, e SÓ ATÉ AQUI ----
    if (wasCancelRequested(id)) return cancelled();
    tele.limitReached = limitReached;

    // nada validado: nada a ingerir (o brief continua PESQUISANDO; um novo job não é aceito nesse estado)
    if (valid.length === 0) {
      finalize(id, JOB_STATUS.PARCIAL, { ...counts(), candidatos: candidates.map(summary), telemetria: { ...tele } });
      return undefined;
    }

    // ---- a ingestão: UMA passagem pelo caminho oficial. A partir daqui o cancelamento é recusado. ----
    const toIngest = valid.slice(0, quantity);
    patch(id, { ingestionStarted: true, currentStep: JOB_STEP.INGERINDO, progress: 95, ...counts(), candidatos: candidates.map(summary), telemetria: { ...tele } });
    let result;
    try {
      result = await briefService.ingestFindings(context, brief.id, toIngest);
    } catch {
      finalize(id, JOB_STATUS.ERRO, { ...counts(), telemetria: { ...tele }, error: { code: ERROR_CODE.INGESTION_FAILED, message: 'A ingestão dos candidatos validados falhou; nada foi promovido ao CRM.' } });
      return undefined;
    }
    const lote = {
      loteId: result && result.lote ? result.lote.loteId : null,
      contagens: result && result.lote ? result.lote.contagens : null,
      excluidosPermanentemente: result && Number.isInteger(result.excluidosPermanentemente) ? result.excluidosPermanentemente : 0,
    };
    finalize(id, valid.length >= quantity ? JOB_STATUS.CONCLUIDO : JOB_STATUS.PARCIAL, { ...counts(), candidatos: candidates.map(summary), telemetria: { ...tele }, lote });
    return undefined;
  }

  return Object.freeze({ startJob, getJob, listJobs, cancelJob, recoverInterruptedJobs, waitFor });
}

module.exports = { createProspectingJobService, ProspectingJobError, ERROR };
