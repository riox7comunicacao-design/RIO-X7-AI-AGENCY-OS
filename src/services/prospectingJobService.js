// Prospecting Job Service (Fase 2 — "INICIAR PROSPECÇÃO"): a execução AUTOMÁTICA de uma prospecção, a camada ACIMA do Prospecting Brief Service.
//
//   Dashboard -> ProspectingJobService -> [motor de descoberta] -> Researcher (fetchPage + verifyOnPage) -> UMA ingestão pelo caminho oficial
//                                                                    prospectingBriefService.ingestFindings -> exclusões -> dedup -> DNC -> Approval Queue
//
// O QUE FAZ: com o brief PRONTO_PARA_PESQUISA (e SÓ nele), cria um JOB persistido em arquivo, devolve o id NA HORA e executa em
// segundo plano: (1) descobre candidatos pelo motor injetado (`claude -p`, só ferramentas de pesquisa web) em ciclos ADAPTATIVOS — cada ciclo pede
// clamp(faltam x 3, 6, 12) candidatos, até 6 ciclos, 40 candidatos no total (a quantidade pedida NÃO define o teto) e 15 minutos;
// (2) aplica as exclusões permanentes ANTES de gastar uma leitura de página; (3) valida CADA candidato por código — a prova é o texto de uma página
// (verifyOnPage), nunca o que o agente afirmou: o site oficial é só uma HIPÓTESE (confirmada por domínio/título + nome + conteúdo) e NÃO é requisito do lead;
// as páginas de terceiros (diretório, notícia) servem de evidência de existência, nunca de "site oficial"; mapeia a presença digital pública (perfis só
// CONFIRMADOS por vínculo público); (4) faz UMA única passagem dos VALIDADOS pelo caminho oficial de ingestão.
//
// O QUE NÃO FAZ: não cria outro caminho de ingestão, não promove para o CRM (a Approval Queue segue sendo o ponto de aprovação humana), não altera
// permissões (reaproveita PROPOSE:LEAD_APPROVAL, a mesma do Brief Service), não "conserta" nem completa candidatos fracos para atingir a quantidade
// (se faltar: PARCIAL), não guarda prompt nem texto de página.
//
// ESTADOS: CRIADO -> EXECUTANDO -> CONCLUIDO | PARCIAL | CANCELADO | ERRO (e CANCELAMENTO_SOLICITADO entre o pedido de cancelamento e a próxima
// fronteira segura). CONCLUIDO = a quantidade pedida de leads que CHEGARAM à Approval Queue (o resultado real do pipeline de ingestão, não o veredito do
// motor); PARCIAL = menos (candidatos/ciclos/tempo, válidos insuficientes OU válidos que o pipeline reteve: dados insuficientes, DNC, duplicado...); ERRO só
// por falha operacional do job. Nunca se "completa" com candidatos não validados, e um validado que não chegou à fila continua nos resultados.
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
const { parseRegion, verifyOnPage, verifyOfficialSite } = require('../research-prospector/pageVerification');
const digital = require('../research-prospector/digitalPresence');
const { validateRawFindingsV2 } = require('../research-prospector/rawFindingV2');
const { summarizeGeografia, BRIEF_STATUS, GEO_LEVEL } = require('../research-prospector/prospectingBrief');
const { normalizeNameCity, normalizeDomain } = require('../research-prospector/normalize');
const { assertValidJobRepository } = require('../research-prospector/jobRepository');
const {
  JOB_STATUS,
  JOB_STEP,
  CANDIDATE_RESULT,
  CANDIDATE_REASON,
  ERROR_CODE,
  STOP_REASON,
  LIMITS,
  JOB_ID_PATTERN,
  computeBatchSize,
  buildJobId,
  isActive,
  decideLead,
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

// a identidade de um candidato para não repeti-lo entre ciclos: nome + site (ou, sem site, a primeira fonte)
const candidateKey = (candidate) => `${normalizeNameCity(candidate.nome, 'x') || candidate.nome.toLowerCase()}|${normalizeDomain(candidate.siteOficial || (candidate.fontesDescoberta[0] && candidate.fontesDescoberta[0].url) || '') || candidate.siteOficial || ''}`;

// O candidato como o job o usa: re-normalizado POR CÓDIGO (nunca se confia no tipo de uma fonte nem em um site de terceiro que veio do motor). null se não tem nome.
function normalizeCandidate(raw) {
  if (!isPlainObject(raw) || typeof raw.nome !== 'string' || raw.nome.trim() === '') return null;
  const origin = typeof raw.siteOficial === 'string' ? digital.normalizeToOrigin(raw.siteOficial) : null;
  return {
    nome: raw.nome.trim(),
    siteOficial: origin !== null && !digital.isKnownThirdPartyHost(digital.hostOf(origin)) ? origin : null,
    fontesDescoberta: digital.classifySources((Array.isArray(raw.fontesDescoberta) ? raw.fontesDescoberta : []).map((origem) => origem && origem.url)),
    presencaDigital: digital.readProfileHints(raw.presencaDigital),
  };
}

const CHANNEL_RESULT_TYPE = Object.freeze({ instagram: 'INSTAGRAM', facebook: 'FACEBOOK', linkedin: 'LINKEDIN', youtube: 'YOUTUBE', googleMeuNegocio: 'GOOGLE_PERFIL' });

// dependencies:
//   authorizeProposer(context, PROPOSE:LEAD_APPROVAL)   OBRIGATÓRIA — a mesma ponte do Brief Service (nenhuma permissão nova)
//   briefService      OBRIGATÓRIA — só usa getBrief, markResearching e ingestFindings (o caminho oficial; o pacote de pesquisa manual não é usado)
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
  for (const method of ['getBrief', 'markResearching', 'ingestFindings']) {
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
    // o teto ABSOLUTO de candidatos (nunca acima de 40); a quantidade pedida NÃO define o teto
    candidatesAbsoluteMax: Math.min(limitOverrides.candidatesAbsoluteMax ?? LIMITS.MAX_CANDIDATES, LIMITS.MAX_CANDIDATES),
    batchMultiplier: limitOverrides.batchMultiplier ?? LIMITS.BATCH_MULTIPLIER,
    batchMin: limitOverrides.batchMin ?? LIMITS.BATCH_MIN,
    batchMax: limitOverrides.batchMax ?? LIMITS.BATCH_MAX,
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

    // PRONTO_PARA_PESQUISA -> PESQUISANDO, SEM gerar o pacote de pesquisa (o fluxo manual é que o usa)
    await briefService.markResearching(context, brief.id);

    const instant = now();
    const prefix = `JOB-${instant.getUTCFullYear()}${String(instant.getUTCMonth() + 1).padStart(2, '0')}${String(instant.getUTCDate()).padStart(2, '0')}-`;
    const id = buildJobId(instant, all.filter((job) => job.id.startsWith(prefix)).length + 1);
    const maxCandidates = limits.candidatesAbsoluteMax;
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
    const maxCandidates = limits.candidatesAbsoluteMax;
    const quantity = brief.quantidade;
    const tele = { discoveryMs: 0, validationMs: 0, custoUsd: 0, webSearchRequests: 0, discoveryRuns: 0, limitReached: null };

    const seen = new Set();
    const candidates = []; // um registro por candidato: { _in (a hipótese do motor), ...o resultado que o job decidiu }
    const valid = []; // achados V2 validados (só os internos, até a ingestão)
    let stopReason = null;

    const RECORD_KEYS = ['resultado', 'motivo', 'entrega', 'causa', 'faltando', 'empresa', 'nicho', 'localizacao', 'evidencias', 'fonteDaValidacao', 'siteOficial', 'presencaDigital', 'outrasPresencas', 'fontesDescoberta'];
    // o que é persistido por candidato: estados, trechos curtos e URLs — nunca texto de página
    const summary = (entry) => ({
      nome: entry.nome,
      url: entry.siteOficial && entry.siteOficial.url ? entry.siteOficial.url : null,
      resultado: entry.resultado || null,
      ...Object.fromEntries(RECORD_KEYS.filter((key) => key !== 'resultado' && entry[key] !== undefined && entry[key] !== null).map((key) => [key, entry[key]])),
    });
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

    const cancelled = () => {
      finalize(id, JOB_STATUS.CANCELADO, { ...counts(), candidatos: candidates.map(summary), telemetria: { ...tele } });
      return true;
    };

    // leitura de página com cache POR JOB: a mesma URL nunca é lida duas vezes (o Researcher reaproveita o que o job já leu)
    const fetchPage = createFetchPage();
    const pageCache = new Map();
    const fetchCached = (url) => {
      if (!pageCache.has(url)) pageCache.set(url, Promise.resolve().then(() => fetchPage(url)).catch(() => ({ ok: false, falha: 'ERRO', causa: 'ERRO_INTERNO' })));
      return pageCache.get(url);
    };
    const hint = { cidade: region.cidade, estado: region.uf };
    const region0 = summarizeGeografia(brief);
    const verifyContext = (extra = {}) => ({ nicho: brief.nicho, cidade: hint.cidade, uf: hint.estado, ...extra });
    const failureOf = (page) => ({ falha: page && typeof page.falha === 'string' ? page.falha : 'ERRO', causa: page && typeof page.causa === 'string' ? page.causa : 'DESCONHECIDA' });

    // o achado V2 de um candidato COMPROVADO: o Researcher monta com o site oficial CONFIRMADO e os perfis CONFIRMADOS; sem nenhum dos dois, um achado mínimo (só o que
    // foi comprovado e as URLs de onde veio) — nada é inferido
    async function buildFinding(candidate, decision, siteOficial, presencaDigital, outrasPresencas) {
      const origem = decision.fonteDaValidacao.url;
      const results = [];
      if (siteOficial.status === digital.SITE_STATUS.ENCONTRADO) results.push({ nome: candidate.nome, url: siteOficial.url, tipoResultado: 'SITE', fonteUrl: origem, cidade: hint.cidade, ...(hint.estado ? { estado: hint.estado } : {}) });
      for (const { canal, url } of digital.confirmedChannels(presencaDigital)) {
        if (CHANNEL_RESULT_TYPE[canal]) results.push({ nome: candidate.nome, url, tipoResultado: CHANNEL_RESULT_TYPE[canal], fonteUrl: origem, cidade: hint.cidade, ...(hint.estado ? { estado: hint.estado } : {}) });
      }
      let finding = null;
      if (results.length > 0) {
        try {
          const researcher = createResearcher({ search: async () => ({ ok: true, resultados: results }), fetchPage: fetchCached }, { now, maxDurationMs: Math.max(1, Math.min(limits.candidateTimeoutMs, timeLeft())) });
          const output = await researcher.research({ nicho: brief.nicho, quantidadeDesejada: 1, regiao: region0, ...(brief.subnicho ? { tipo: brief.subnicho } : {}) });
          if (output && output.ok === true && Array.isArray(output.achados) && output.achados.length > 0) finding = output.achados[0];
        } catch {
          finding = null;
        }
      }
      if (finding === null) {
        const fontes = [...new Set([origem, ...outrasPresencas.map((p) => p.url)])].slice(0, 10);
        finding = { empresa: candidate.nome, cidade: hint.cidade, ...(hint.estado ? { estado: hint.estado } : {}), nicho: brief.nicho, fontes, dataDaPesquisa: now().toISOString().slice(0, 10) };
      }
      const checkedFinding = validateRawFindingsV2([finding], { now: now() });
      return checkedFinding.ok ? finding : null;
    }

    // ---- um candidato: exclusão permanente -> site oficial (hipótese) -> páginas de terceiros -> decisão -> presença digital -> achado ----
    async function evaluateCandidate(candidate) {
      const nothing = { empresa: 'NAO_VERIFICADO', nicho: 'NAO_VERIFICADO', localizacao: 'NAO_VERIFICADO', siteOficial: { status: digital.SITE_STATUS.NAO_ENCONTRADO, url: null }, presencaDigital: digital.emptyPresence(), outrasPresencas: [], fontesDescoberta: candidate.fontesDescoberta };
      try {
        const excluded = await isExcluded({ empresa: candidate.nome, cidade: hint.cidade, ...(hint.estado ? { estado: hint.estado } : {}) });
        if (excluded) return { record: { ...nothing, resultado: CANDIDATE_RESULT.DESCARTADO, motivo: CANDIDATE_REASON.EXCLUSAO_PERMANENTE } };
      } catch {
        return { record: { ...nothing, resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.EXCLUSAO_NAO_CONSULTADA } };
      }

      const pages = [];
      let siteOficial = { status: digital.SITE_STATUS.NAO_ENCONTRADO, url: null, motivo: 'NAO_INFORMADO' };
      let officialPage = null;

      // 1) o site oficial é uma HIPÓTESE: confirma-se por código (domínio/título + nome + conteúdo institucional); HTTP 200 sozinho não prova nada
      if (candidate.siteOficial) {
        const page = await fetchCached(candidate.siteOficial);
        if (!page || page.ok !== true) {
          const failure = failureOf(page);
          siteOficial = { status: digital.SITE_STATUS.NAO_ENCONTRADO, url: null, motivo: 'PAGINA_INACESSIVEL', causa: failure.causa };
          pages.push({ origem: { url: candidate.siteOficial, tipo: digital.classifySource(candidate.siteOficial) }, falha: failure.falha, causa: failure.causa });
        } else {
          const finalUrl = typeof page.urlFinal === 'string' ? page.urlFinal : candidate.siteOficial;
          const link = verifyOfficialSite(page.texto, { nome: candidate.nome, url: finalUrl, identidade: page.identidade, ...verifyContext() });
          if (link.status === 'VALIDADO') {
            const origin = digital.normalizeToOrigin(finalUrl);
            siteOficial = { status: digital.SITE_STATUS.ENCONTRADO, url: origin, regra: link.regra };
            officialPage = page;
            pages.push({ origem: { url: origin, tipo: digital.SOURCE_TYPE.OFICIAL }, veredito: verifyOnPage(page.texto, { nome: candidate.nome, ...verifyContext({ host: digital.hostOf(origin), identidade: page.identidade }) }) });
          } else {
            siteOficial = { status: digital.SITE_STATUS.NAO_ENCONTRADO, url: null, motivo: link.motivo };
          }
        }
      }

      // 2) sem uma página que comprove os três aspectos, as páginas de TERCEIROS (diretório, notícia) que descobriram a empresa: servem de evidência de
      //    existência, nunca de "site oficial"
      let decision = decideLead(pages);
      if (decision.resultado !== CANDIDATE_RESULT.VALIDADO) {
        const thirdParty = candidate.fontesDescoberta.filter((origem) => origem.tipo === digital.SOURCE_TYPE.DIRETORIO || origem.tipo === digital.SOURCE_TYPE.NOTICIA_OU_TERCEIRO).slice(0, LIMITS.MAX_THIRD_PARTY_PAGES);
        for (const origem of thirdParty) {
          if (timeLeft() <= 0 || wasCancelRequested(id)) break;
          const page = await fetchCached(origem.url);
          if (!page || page.ok !== true) {
            const failure = failureOf(page);
            pages.push({ origem, falha: failure.falha, causa: failure.causa });
          } else {
            pages.push({ origem, links: (Array.isArray(page.links) ? page.links : []).map((l) => l && l.href).filter((href) => typeof href === 'string'), veredito: verifyOnPage(page.texto, { nome: candidate.nome, ...verifyContext() }) });
          }
          decision = decideLead(pages);
          if (decision.resultado === CANDIDATE_RESULT.VALIDADO) break;
        }
      }

      // 3) a presença digital (separada do site) e as fontes classificadas por código
      const officialHost = siteOficial.status === digital.SITE_STATUS.ENCONTRADO ? digital.hostOf(siteOficial.url) : null;
      const validatingPage = decision.resultado === CANDIDATE_RESULT.VALIDADO ? pages.find((p) => p.origem.url === decision.fonteDaValidacao.url && p.origem.tipo !== digital.SOURCE_TYPE.OFICIAL) : null;
      const presencaDigital = digital.buildPresence({
        hints: candidate.presencaDigital,
        officialLinks: officialPage && Array.isArray(officialPage.links) ? officialPage.links.map((l) => l && l.href).filter((href) => typeof href === 'string') : [],
        crossLinks: validatingPage ? validatingPage.links : [],
        otherSources: candidate.fontesDescoberta.filter((origem) => origem.tipo === digital.SOURCE_TYPE.REDE_SOCIAL && (digital.classifyHost(digital.hostOf(origem.url)) || {}).canal === null),
      });
      const fontesDescoberta = digital.classifySources([...(officialHost ? [siteOficial.url] : []), ...candidate.fontesDescoberta.map((origem) => origem.url)], officialHost);
      const outrasPresencas = fontesDescoberta.filter((origem) => origem.tipo === digital.SOURCE_TYPE.DIRETORIO || origem.tipo === digital.SOURCE_TYPE.NOTICIA_OU_TERCEIRO);
      const { resultado, motivo, causa, faltando, empresa, nicho, localizacao, evidencias, fonteDaValidacao } = decision;
      const record = { resultado, motivo, causa, faltando, empresa, nicho, localizacao, evidencias, fonteDaValidacao, siteOficial, presencaDigital, outrasPresencas, fontesDescoberta };

      if (resultado !== CANDIDATE_RESULT.VALIDADO) return { record };
      const achado = await buildFinding(candidate, decision, siteOficial, presencaDigital, outrasPresencas);
      if (achado === null) return { record: { ...record, resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.VALIDACAO_FALHOU, evidencias: undefined, fonteDaValidacao: undefined } };
      return { record, achado };
    }

    // ---- ciclos de descoberta + validação (adaptativos) ----
    let cycle = 0;
    while (cycle < limits.maxCycles) {
      if (wasCancelRequested(id)) return cancelled();
      if (valid.length >= quantity) break;
      if (timeLeft() <= 0) {
        stopReason = STOP_REASON.TEMPO;
        break;
      }
      if (candidates.length >= maxCandidates) {
        stopReason = STOP_REASON.CANDIDATOS;
        break;
      }
      cycle += 1;
      patch(id, { currentStep: JOB_STEP.DESCOBRINDO, cycles: cycle, ...counts(), telemetria: { ...tele } });

      const batch = computeBatchSize(quantity, valid.length, { multiplier: limits.batchMultiplier, min: limits.batchMin, max: limits.batchMax }, maxCandidates - candidates.length);
      const askedAt = now().getTime();
      const found = await discoveryEngine.discover({
        nicho: brief.nicho,
        subnicho: brief.subnicho,
        cidade: region.cidade,
        uf: region.uf,
        limit: batch,
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
        stopReason = STOP_REASON.DESCOBERTA;
        break;
      }

      // candidatos novos (sem repetir nome/site já vistos), no máximo até o teto absoluto; nunca se inventa um candidato
      const fresh = [];
      for (const raw of found.candidatos) {
        if (candidates.length + fresh.length >= maxCandidates || fresh.length >= batch) break; // nunca além do teto absoluto nem do que foi pedido neste ciclo
        const item = normalizeCandidate(raw);
        if (item === null) continue;
        const key = candidateKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({ nome: item.nome, _in: item });
      }
      for (const entry of fresh) candidates.push(entry);
      save(JOB_STEP.VALIDANDO);
      if (fresh.length === 0) {
        stopReason = STOP_REASON.SEM_CANDIDATOS_NOVOS;
        break;
      }

      for (const entry of fresh) {
        if (wasCancelRequested(id)) return cancelled();
        if (valid.length >= quantity) break;
        if (timeLeft() <= 0) {
          stopReason = STOP_REASON.TEMPO;
          break;
        }
        const startedValidation = now().getTime();
        let outcome;
        try {
          outcome = await evaluateCandidate(entry._in);
        } catch {
          outcome = { record: { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.VALIDACAO_FALHOU } };
        }
        tele.validationMs += now().getTime() - startedValidation;
        Object.assign(entry, outcome.record);
        if (outcome.record.resultado === CANDIDATE_RESULT.VALIDADO && outcome.achado) valid.push(outcome.achado);
        save(JOB_STEP.VALIDANDO);
      }
      if (stopReason === STOP_REASON.TEMPO) break;
    }
    if (valid.length < quantity && stopReason === null) stopReason = candidates.length >= maxCandidates ? STOP_REASON.CANDIDATOS : STOP_REASON.CICLOS;

    // ---- fronteira segura final: ainda dá para cancelar, e SÓ ATÉ AQUI ----
    if (wasCancelRequested(id)) return cancelled();
    tele.limitReached = valid.length >= quantity ? null : stopReason;

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
    // A META COMERCIAL: o que o pipeline oficial REALMENTE entregou à Approval Queue (lote.prospectIds = os itens que entraram na fila). Um lead VALIDADO pelo
    // motor que termina DADOS_INSUFICIENTES, DNC, DUPLICADO ou REJEITADO NÃO conta; ele permanece nos resultados do job com o seu estado real no pipeline.
    const batch = result && result.lote && typeof result.lote === 'object' ? result.lote : null;
    const outcomes = batch && Array.isArray(batch.resultados) ? batch.resultados : [];
    const inQueue = batch && Array.isArray(batch.prospectIds) ? batch.prospectIds.length : outcomes.filter((item) => item && item.naFila === true).length;
    for (const finding of toIngest) {
      const entry = candidates.find((candidate) => candidate.nome === finding.empresa && candidate.resultado === CANDIDATE_RESULT.VALIDADO);
      const outcome = outcomes.find((item) => item && item.empresa === finding.empresa);
      if (entry && outcome) entry.entrega = { naFila: outcome.naFila === true, estadoOperacional: typeof outcome.estadoOperacional === 'string' ? outcome.estadoOperacional : null, ...(typeof outcome.motivo === 'string' ? { motivo: outcome.motivo } : {}) };
    }
    const delivered = inQueue >= quantity;
    if (!delivered) tele.limitReached = tele.limitReached || STOP_REASON.ENTREGA_INSUFICIENTE;
    const lote = {
      loteId: batch ? batch.loteId : null,
      contagens: batch ? batch.contagens : null,
      excluidosPermanentemente: result && Number.isInteger(result.excluidosPermanentemente) ? result.excluidosPermanentemente : 0,
      validadosPeloMotor: toIngest.length, // comprovados por código (empresa + nicho + localização)
      naFila: inQueue, // encaminhados de fato à Approval Queue: só estes contam para a meta
      foraDaFila: Math.max(0, toIngest.length - inQueue), // validados pelo motor, mas retidos pelo pipeline (dados insuficientes, DNC, duplicado...)
    };
    finalize(id, delivered ? JOB_STATUS.CONCLUIDO : JOB_STATUS.PARCIAL, { ...counts(), candidatos: candidates.map(summary), telemetria: { ...tele }, lote });
    return undefined;
  }

  return Object.freeze({ startJob, getJob, listJobs, cancelJob, recoverInterruptedJobs, waitFor });
}

module.exports = { createProspectingJobService, ProspectingJobError, ERROR };
