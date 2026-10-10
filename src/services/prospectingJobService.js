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
// REPOSIÇÃO (2.2): se a ingestão deixa a meta por atingir (parte dos leads foi retida pelo pipeline), o job descobre candidatos NOVOS e repete validação, ingestão e medição
// — até a meta, 6 ciclos TOTAIS, 40 candidatos ou 15 minutos, o que vier primeiro. Candidatos já vistos no job (qualquer desfecho) nunca voltam; uma rodada sem nenhum
// candidato novo encerra o job (PARCIAL). Cada ingestão passa pela MESMA cadeia (exclusões, deduplicação, DNC, Approval Queue); reposição não é um estado novo.
//
// CANCELAR: o pedido marca o job e aborta o motor de descoberta em andamento; a execução para na PRÓXIMA fronteira segura (antes de uma nova descoberta, de uma nova
// validação ou de uma ingestão) e termina CANCELADO. Enquanto uma ingestão está EM ANDAMENTO o job recusa o cancelamento (nada é desfeito); o que já foi entregue à fila
// em rodadas anteriores fica entregue e continua no resultado do job.
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
const { summarizeGeografia, BRIEF_STATUS, GEO_LEVEL, BRIEF_INPUT_KEYS } = require('../research-prospector/prospectingBrief');
const { normalizeNameCity, normalizeDomain } = require('../research-prospector/normalize');
const { assertValidJobRepository } = require('../research-prospector/jobRepository');
const commercial = require('../research-prospector/commercialProfile');
const { classifyLeadType } = require('../research-prospector/leadTypeClassification');
const { createInMemoryLeadProfileRepository, assertValidLeadProfileRepository } = require('../research-prospector/leadProfileRepository');
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

// As CHAVES de identidade de um candidato, para nunca reprocessá-lo entre ciclos/reposições (a deduplicação do pipeline continua sendo a autoridade final; isto só
// impede a repetição DURANTE a descoberta): o domínio do site (confirmado, ou o hipotético até a confirmação), depois nome + cidade; sem nenhum dos dois, o nome. Um candidato
// é CONHECIDO se QUALQUER chave já foi vista — e continua conhecido seja qual for o seu desfecho (fora da fila, DNC, duplicado, erro...).
const candidateKeys = (candidate, cidade) => {
  const keys = [];
  const domain = candidate.siteOficial ? normalizeDomain(candidate.siteOficial) : null;
  if (domain) keys.push(`dominio:${domain}`);
  const nameCity = normalizeNameCity(candidate.nome, cidade);
  keys.push(nameCity ? `nome:${nameCity}` : `nome:${candidate.nome.toLowerCase()}`);
  return keys;
};

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
//   briefService      OBRIGATÓRIA — só usa getBrief, markResearching, ingestFindings e ingestReplacementFindings (o caminho oficial de ingestão, a 1ª e as de reposição; o pacote de pesquisa manual não é usado)
//   repository        OBRIGATÓRIA — a porta de jobs (list/getById/save)
//   discoveryEngine   OBRIGATÓRIA — { discover(request) } (o motor externo; nos testes, um double)
//   createFetchPage   OBRIGATÓRIA — () => fetchPage: a porta de leitura de página, nova a cada job (orçamento próprio)
//   checkPermanentExclusion (opcional) — (finding) => false | exclusão (o MESMO isExcluded das exclusões permanentes)
//   now, limits (sobrescritas dos limites, só para testes)
//   processId, isProcessAlive (injetáveis nos testes): o job guarda o PID do processo que o executa; a recuperação NÃO marca como interrompido um job
//   cujo processo (outro, ainda vivo) é o dono — por exemplo, uma suíte de testes não pode estragar a prospecção real de um servidor em execução
function createProspectingJobService(dependencies) {
  const { authorizeProposer, briefService, repository, discoveryEngine, knownIdentities = null, profileRepository = createInMemoryLeadProfileRepository(), createFetchPage, checkPermanentExclusion, now = () => new Date(), limits: limitOverrides = {}, processId = process.pid, isProcessAlive = defaultIsProcessAlive } = dependencies || {};

  if (typeof authorizeProposer !== 'function') throw new Error('createProspectingJobService exige { authorizeProposer } (função)');
  for (const method of ['getBrief', 'markResearching', 'ingestFindings', 'ingestReplacementFindings']) {
    if (!briefService || typeof briefService[method] !== 'function') throw new Error(`createProspectingJobService exige { briefService } com ${method}()`);
  }
  assertValidJobRepository(repository);
  assertValidLeadProfileRepository(profileRepository);
  if (knownIdentities !== null && typeof knownIdentities !== 'function') throw new Error('createProspectingJobService: knownIdentities, se informado, deve ser uma função');
  if (!discoveryEngine || typeof discoveryEngine.discover !== 'function') throw new Error('createProspectingJobService exige { discoveryEngine } com discover()');
  if (typeof createFetchPage !== 'function') throw new Error('createProspectingJobService exige { createFetchPage } (função)');
  if (checkPermanentExclusion !== undefined && checkPermanentExclusion !== null && typeof checkPermanentExclusion !== 'function') {
    throw new Error('createProspectingJobService: checkPermanentExclusion, se informado, deve ser uma função');
  }
  if (typeof now !== 'function') throw new Error('createProspectingJobService: now deve ser uma função');
  const isExcluded = typeof checkPermanentExclusion === 'function' ? checkPermanentExclusion : () => false;

  const limits = Object.freeze({
    // o teto de candidatos POR EXECUÇÃO: padrão 50, configurável até 100 (por job via { maxCandidates }); a quantidade pedida NÃO define o teto
    candidatesAbsoluteMax: Math.min(limitOverrides.candidatesAbsoluteMax ?? LIMITS.MAX_CANDIDATES, LIMITS.MAX_CANDIDATES_CAP),
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

  // O RESUMO padronizado do resultado (contadores únicos, sem dupla contagem): tudo derivado do que o job já guarda — nunca de uma segunda contagem.
  // naApprovalQueue = o que ESTE job entregou; jaExistentes = o que o pipeline encontrou JÁ na fila/CRM (não é entrega nova).
  function summarize(job, elapsedMs) {
    const list = Array.isArray(job.candidatos) ? job.candidatos : [];
    const deliveries = list.map((candidate) => candidate.entrega).filter(Boolean);
    const byState = (state) => deliveries.filter((delivery) => delivery.estadoOperacional === state && delivery.naFila !== true).length;
    const tele = job.telemetria && typeof job.telemetria === 'object' ? job.telemetria : {};
    const lote = job.lote && typeof job.lote === 'object' ? job.lote : {};
    const limitsOf = job.limits && typeof job.limits === 'object' ? job.limits : {};
    return {
      solicitados: job.requestedQuantity,
      limiteDeCandidatos: limitsOf.maxCandidates ?? null,
      candidatosProcessados: list.filter((candidate) => candidate.resultado).length,
      descobertos: Number.isInteger(tele.candidatosDescobertos) ? tele.candidatosDescobertos : list.length,
      novos: Number.isInteger(tele.candidatosNovos) ? tele.candidatosNovos : list.length,
      repetidos: Number.isInteger(tele.candidatosRepetidos) ? tele.candidatosRepetidos : 0,
      validados: job.candidatesValidated || 0,
      naoValidados: job.candidatesRejected || 0,
      naApprovalQueue: Number.isInteger(lote.naFila) ? lote.naFila : job.leadsNaFila || 0,
      // cada categoria soma o que o pipeline classificou + o que o filtro de economia reconheceu ANTES (repetidosPor): são conjuntos disjuntos (um candidato filtrado nunca chega ao pipeline)
      jaExistentes: (Number.isInteger(lote.jaEstavamNaFila) ? lote.jaEstavamNaFila : 0) + (tele.repetidosPor ? tele.repetidosPor.fila : 0),
      dadosInsuficientes: byState('DADOS_INSUFICIENTES'),
      duplicados: byState('DUPLICADO') + (tele.repetidosPor ? tele.repetidosPor.duplicado : 0),
      dnc: byState('DNC') + (tele.repetidosPor ? tele.repetidosPor.dnc : 0),
      repetidosDnc: tele.repetidosPor ? tele.repetidosPor.dnc : 0,
      repetidosDuplicados: tele.repetidosPor ? tele.repetidosPor.duplicado : 0,
      repetidosNaFila: tele.repetidosPor ? tele.repetidosPor.fila : 0,
      repetidosNoJob: tele.repetidosPor ? tele.repetidosPor.job : 0,
      reposicoes: Number.isInteger(tele.reposicoesRealizadas) ? tele.reposicoesRealizadas : 0,
      enriquecidos: tele.enriquecimento && Number.isInteger(tele.enriquecimento.leadsEnriquecidos) ? tele.enriquecimento.leadsEnriquecidos : 0,
      tempoMs: elapsedMs,
      descobertaSegundos: typeof tele.descobertaSegundos === 'number' ? tele.descobertaSegundos : 0,
      validacaoSegundos: typeof tele.validacaoSegundos === 'number' ? tele.validacaoSegundos : 0,
      enriquecimentoSegundos: typeof tele.enriquecimentoSegundos === 'number' ? tele.enriquecimentoSegundos : 0,
      ingestaoSegundos: typeof tele.ingestaoSegundos === 'number' ? tele.ingestaoSegundos : 0,
      totalSegundos: Math.round(elapsedMs / 100) / 10,
      custoUsd: typeof tele.custoUsd === 'number' ? tele.custoUsd : 0,
    };
  }

  // a visão que sai para quem consulta: o job sem os achados internos, com o tempo decorrido calculado e o resumo padronizado
  function view(job) {
    const out = copy(job);
    delete out.achadosValidados;
    const start = out.startedAt ? Date.parse(out.startedAt) : null;
    const end = out.finishedAt ? Date.parse(out.finishedAt) : now().getTime();
    out.elapsedMs = start === null ? 0 : Math.max(0, end - start);
    out.resumo = summarize(out, out.elapsedMs);
    return out;
  }

  const wasCancelRequested = (id) => requireJob(id).cancelRequested === true;

  // ------------------------------------------------------------------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------------------------------------------------------------------

  async function startJob(context, input) {
    return begin(context, input, {});
  }

  async function begin(context, input, extra) {
    const author = authorize(context);
    if (!isPlainObject(input) || typeof input.briefId !== 'string' || Object.keys(input).some((key) => key !== 'briefId' && key !== 'maxCandidates')) {
      throw new ProspectingJobError(ERROR.INVALID_INPUT, 'Prospecção: envie { briefId } e, opcionalmente, { maxCandidates }.');
    }
    if (input.maxCandidates !== undefined && (!Number.isInteger(input.maxCandidates) || input.maxCandidates < 1 || input.maxCandidates > LIMITS.MAX_CANDIDATES_CAP)) {
      throw new ProspectingJobError(ERROR.INVALID_INPUT, `Prospecção: maxCandidates deve ser um inteiro entre 1 e ${LIMITS.MAX_CANDIDATES_CAP}.`);
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
    const maxCandidates = input.maxCandidates ?? limits.candidatesAbsoluteMax;
    const job = {
      id,
      briefId: brief.id,
      ...extra,
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
      leadsNaFila: 0,
      // os ciclos acompanham o teto escolhido quando ele passa do padrão (50 -> 6 ciclos; 100 -> 12): sem isso 100 candidatos nunca seriam alcançáveis em 6 ciclos de 12
      limits: { maxCandidates, maxDurationMs: limits.maxDurationMs, maxCycles: maxCandidates <= limits.candidatesAbsoluteMax ? limits.maxCycles : Math.ceil((limits.maxCycles * maxCandidates) / limits.candidatesAbsoluteMax) },
      cycles: 0,
      candidatos: [],
      achadosValidados: [],
      lote: null,
      telemetria: { discoveryMs: 0, validationMs: 0, custoUsd: 0, webSearchRequests: 0, discoveryRuns: 0, limitReached: null, ciclosExecutados: 0, ciclosReposicao: 0, candidatosDescobertos: 0, candidatosNovos: 0, candidatosRepetidos: 0, validadosPeloMotor: 0, naFila: 0, foraDaFila: 0, reposicoesNecessarias: 0, reposicoesRealizadas: 0, eventos: [] },
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

  // REFAZER PROSPECÇÃO (Implementação 3.0): um job NOVO sobre um brief NOVO com o mesmo briefing do job anterior. O job anterior e o seu brief ficam intactos (histórico
  // preservado), as exclusões permanentes, o DNC e a deduplicação valem como em qualquer job (a mesma cadeia de ingestão) e o que já está na fila/CRM não volta como entrega.
  // Só um job TERMINADO pode ser refeito. A quantidade de candidatos do job anterior é reaproveitada.
  async function redoJob(context, id) {
    authorize(context);
    const previous = requireJob(id);
    if (isActive(previous.status)) throw new ProspectingJobError(ERROR.INVALID_STATE, `Prospecção: o job está ${previous.status}; só um job terminado pode ser refeito.`);
    for (const method of ['createBrief', 'markReadyForResearch']) {
      if (typeof briefService[method] !== 'function') throw new ProspectingJobError(ERROR.INVALID_STATE, 'Prospecção: refazer exige o Brief Service completo.');
    }
    const old = await briefService.getBrief(context, previous.briefId);
    const input = Object.fromEntries(BRIEF_INPUT_KEYS.filter((key) => old[key] !== undefined && old[key] !== null).map((key) => [key, old[key]]));
    const created = await briefService.createBrief(context, input);
    await briefService.markReadyForResearch(context, created.id);
    const maxCandidates = previous.limits && Number.isInteger(previous.limits.maxCandidates) ? previous.limits.maxCandidates : undefined;
    return begin(context, { briefId: created.id, ...(maxCandidates ? { maxCandidates } : {}) }, { refeitoDe: previous.id });
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
    const maxCycles = requireJob(id).limits.maxCycles;
    const quantity = brief.quantidade;
    const tele = {
      discoveryMs: 0,
      validationMs: 0,
      ingestaoMs: 0, // tempo gasto na ingestão (pipeline oficial: exclusões, deduplicação, DNC, Approval Queue)
      custoUsd: 0,
      webSearchRequests: 0,
      discoveryRuns: 0,
      limitReached: null,
      ciclosExecutados: 0, // ciclos de descoberta (TOTAIS: os mesmos 6 para a busca inicial e para a reposição)
      ciclosReposicao: 0, // os ciclos que começaram DEPOIS de uma ingestão, com a meta ainda por atingir
      candidatosDescobertos: 0, // novos + repetidos, como o motor devolveu
      candidatosNovos: 0, // os que entraram no processamento do job
      candidatosRepetidos: 0, // os já conhecidos: nunca voltam à validação, à ingestão nem à fila
      validadosPeloMotor: 0,
      naFila: 0,
      jaEstavamNaFila: 0, // validados que o pipeline encontrou JÁ na fila (não são entrega deste job)
      foraDaFila: 0,
      // identidades JÁ CONHECIDAS (Approval Queue + CRM) entregues à descoberta para ela não as reencontrar; `repetidos` = quantos candidatos devolvidos casaram com elas
      conhecidos: { fila: 0, crm: 0, indisponivel: false, repetidos: 0, rodadasSoRepetidos: 0 },
      // as IDENTIDADES repetidas por origem, SEM sobreposição nem dupla contagem (cada uma em UMA categoria, a mais restritiva: dnc > duplicado > fila > job). candidatosRepetidos conta as
      // DEVOLUÇÕES repetidas do motor (o mesmo lead pode voltar várias vezes); repetidosPor conta o lead uma vez só
      repetidosPor: { dnc: 0, duplicado: 0, fila: 0, job: 0 },
      reposicoesNecessarias: 0, // quantas vezes a ingestão deixou a meta por atingir
      reposicoesRealizadas: 0, // ciclos de reposição que terminaram
      // NÍVEL 3 (enriquecimento comercial): só para leads JÁ entregues à fila; uma chamada em lote por rodada
      enriquecimento: { perfisGerados: 0, leadsEnriquecidos: 0, chamadas: 0, falhas: 0, pulado: 0, incompletos: 0, limiteDeTurnos: 0, ms: 0 },
      eventos: [], // REPOSICAO_INICIADA | REPOSICAO_CONCLUIDA | REPOSICAO_SEM_CANDIDATOS_NOVOS | META_ATINGIDA (só código e ciclo)
    };
    const event = (codigo, ciclo) => {
      if (tele.eventos.length < 50) tele.eventos.push({ codigo, ciclo });
    };

    const knownKeys = new Set(); // os candidatos já vistos neste job (qualquer desfecho)
    const candidates = []; // um registro por candidato: { _in (a hipótese do motor), ...o resultado que o job decidiu }
    let pending = []; // os achados validados NESTA rodada, ainda não ingeridos (só os internos)
    const delivered = new Set(); // os prospectIds que CHEGARAM à Approval Queue: cada lead conta uma única vez
    const lotes = []; // o lote de cada ingestão (identificadores e contagens, nunca texto de página)
    let ingestedAchados = 0; // quantos achados já foram entregues ao pipeline de ingestão
    let excludedTotal = 0;
    let alreadyInQueue = 0; // validados que o pipeline encontrou JÁ na fila (não são entrega deste job)
    let stopReason = null;

    const RECORD_KEYS = ['resultado', 'motivo', 'entrega', 'causa', 'faltando', 'empresa', 'nicho', 'localizacao', 'evidencias', 'fonteDaValidacao', 'siteOficial', 'presencaDigital', 'outrasPresencas', 'fontesDescoberta', 'tipoLead'];
    // o que é persistido por candidato: estados, trechos curtos e URLs — nunca texto de página
    const summary = (entry) => ({
      nome: entry.nome,
      url: entry.siteOficial && entry.siteOficial.url ? entry.siteOficial.url : null,
      resultado: entry.resultado || null,
      ...(entry.ciclo ? { ciclo: entry.ciclo } : {}),
      ...Object.fromEntries(RECORD_KEYS.filter((key) => key !== 'resultado' && entry[key] !== undefined && entry[key] !== null).map((key) => [key, entry[key]])),
    });
    const counts = () => ({
      candidatesDiscovered: candidates.length,
      candidatesValidated: candidates.filter((c) => c.resultado === CANDIDATE_RESULT.VALIDADO).length,
      candidatesRejected: candidates.filter((c) => c.resultado === CANDIDATE_RESULT.NAO_VERIFICADO || c.resultado === CANDIDATE_RESULT.DESCARTADO).length,
      candidatesUnverified: candidates.filter((c) => c.resultado === CANDIDATE_RESULT.NAO_VERIFICADO).length,
      candidatesDiscarded: candidates.filter((c) => c.resultado === CANDIDATE_RESULT.DESCARTADO).length,
      leadsNaFila: delivered.size,
    });
    const syncTelemetry = () => {
      tele.validadosPeloMotor = ingestedAchados + pending.length;
      tele.naFila = delivered.size;
      tele.foraDaFila = Math.max(0, ingestedAchados - delivered.size);
      tele.jaEstavamNaFila = alreadyInQueue;
      // tempos por etapa (ms e segundos): reaproveitam os contadores existentes (discoveryMs/validationMs/enriquecimento.ms) com nomes claros para a tela
      const seconds = (ms) => Math.round(ms / 100) / 10;
      tele.descobertaMs = tele.discoveryMs;
      tele.validacaoMs = tele.validationMs;
      tele.enriquecimentoMs = tele.enriquecimento.ms;
      tele.totalMs = Math.max(0, now().getTime() - startMs);
      tele.descobertaSegundos = seconds(tele.descobertaMs);
      tele.validacaoSegundos = seconds(tele.validacaoMs);
      tele.enriquecimentoSegundos = seconds(tele.enriquecimentoMs);
      tele.ingestaoSegundos = seconds(tele.ingestaoMs);
      tele.totalSegundos = seconds(tele.totalMs);
      return { ...tele, conhecidos: { ...tele.conhecidos }, repetidosPor: { ...tele.repetidosPor }, eventos: tele.eventos.map((e) => ({ ...e })) };
    };
    const checked = () => candidates.filter((c) => c.resultado !== undefined).length;
    // 15% = descobrindo; de 20% a 90% = candidatos já examinados; 92% = ingerindo; 100% = terminou. Nunca regride.
    const progressNow = () => (candidates.length === 0 ? 15 : Math.min(90, 20 + Math.round((70 * checked()) / candidates.length)));
    const save = (step, extra = {}) =>
      patch(id, { ...counts(), currentStep: step, progress: Math.max(requireJob(id).progress, extra.progress ?? progressNow()), candidatos: candidates.map(summary), achadosValidados: pending, telemetria: syncTelemetry(), ...extra });

    // o agregado das ingestões (uma ou mais): o último lote, todos os ids, e a distinção validado pelo motor x entregue à fila x retido pelo pipeline
    const aggregateLote = () =>
      lotes.length === 0
        ? null
        : {
            loteId: lotes[lotes.length - 1].loteId,
            lotes: lotes.map((lote) => lote.loteId),
            contagens: lotes[lotes.length - 1].contagens,
            excluidosPermanentemente: excludedTotal,
            prospectIds: [...delivered], // os leads que ESTE job entregou à fila (para o resultado ligar o job à Approval Queue, sem dupla contagem)
            validadosPeloMotor: ingestedAchados, // comprovados por código (empresa + nicho + localização)
            naFila: delivered.size, // encaminhados de fato à Approval Queue: só estes contam para a meta
            foraDaFila: Math.max(0, ingestedAchados - delivered.size), // validados pelo motor, mas que NÃO foram uma nova entrega deste job (retidos: dados insuficientes, DNC, duplicado...; ou já estavam na fila)
            jaEstavamNaFila: alreadyInQueue, // dos validados, os que o pipeline encontrou JÁ na fila (jaExistiaNaFila): auditoria, não contam para a meta
          };

    const cancelled = () => {
      finalize(id, JOB_STATUS.CANCELADO, { ...counts(), candidatos: candidates.map(summary), telemetria: syncTelemetry(), ...(lotes.length > 0 ? { lote: aggregateLote() } : {}) });
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
    async function buildFinding(candidate, decision, siteOficial, presencaDigital, outrasPresencas, tipoLead) {
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
      // empresa + nicho + localização já foram comprovados por código (decision VALIDADO): o lead é válido mesmo sem site, rede social ou telefone
      finding = { ...finding, comprovadoPorCodigo: true, tipoLead };
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
      // tipoLead (RULES — distinguir EMPRESA/PROFISSIONAL/UNIDADE_FRANQUIA): pelo nome e, quando o site oficial foi lido, pelo título/H1 e o texto
      // já obtidos (nenhuma leitura nova). Nunca decide sozinho se o candidato é aprovado: só classifica o tipo.
      const tipoLead = classifyLeadType({ nome: candidate.nome, identidade: officialPage ? officialPage.identidade : null, texto: officialPage ? officialPage.texto : null }).tipo;
      const { resultado, motivo, causa, faltando, empresa, nicho, localizacao, evidencias, fonteDaValidacao } = decision;
      const record = { resultado, motivo, causa, faltando, empresa, nicho, localizacao, evidencias, fonteDaValidacao, siteOficial, presencaDigital, outrasPresencas, fontesDescoberta, tipoLead };

      if (resultado !== CANDIDATE_RESULT.VALIDADO) return { record };
      const achado = await buildFinding(candidate, decision, siteOficial, presencaDigital, outrasPresencas, tipoLead);
      if (achado === null) return { record: { ...record, resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.VALIDACAO_FALHOU, evidencias: undefined, fonteDaValidacao: undefined } };
      // 4) NÍVEL 2 -> 3: a base do perfil comercial, só do que o site oficial JÁ trouxe (contatos, endereço, responsável com cargo explícito): nenhuma leitura nova
      const perfilInput = {
        empresa: candidate.nome,
        siteOficial,
        presencaDigital,
        outrasPresencas,
        fontesDescoberta,
        fontesValidacao: digital.classifySources([decision.fonteDaValidacao.url], officialHost),
        pages: officialPage && siteOficial.status === digital.SITE_STATUS.ENCONTRADO ? [{ origem: siteOficial.url, oficial: true, texto: officialPage.texto, links: officialPage.links, identidade: officialPage.identidade }] : [],
        today: now().toISOString().slice(0, 10),
      };
      return { record, achado, perfilInput };
    }

    // ---- ciclos: DESCOBERTA -> VALIDAÇÃO -> INGESTÃO -> MEDIÇÃO DA ENTREGA -> (meta atingida? senão, REPOSIÇÃO com candidatos NOVOS) ----
    // Os limites são GLOBAIS (os mesmos para a busca inicial e para a reposição): 6 ciclos, 40 candidatos, 15 minutos. A meta é só o que CHEGOU à Approval Queue.
    // Os candidatos NOVOS que ainda não foram examinados (porque a rodada já comprovou o que faltava) ficam no `backlog` e são examinados antes de uma nova descoberta:
    // se o pipeline reter os comprovados, os que sobraram continuam podendo entrar na fila — nada que foi descoberto é jogado fora.
    const backlog = [];

    // ---- PERFIL COMERCIAL dos leads entregues, SEM novas chamadas de IA (3.0.2) ----
    // A prospecção automática é: Descoberta -> Validação -> Ingestão -> Approval Queue. Para cada lead ENTREGUE o job só grava o perfil que o CÓDIGO já extraiu das páginas consultadas
    // (empresa, tipo de lead, site, endereço/CEP, telefones, WhatsApps, e-mails, redes sociais, fontes) — nenhuma leitura nova, nenhum Claude. O enriquecimento aprofundado (responsável, anúncios,
    // atividade, canais que faltam...) é SOB DEMANDA: o botão COMPLETAR PESQUISA do perfil (leadEnrichmentService), só para o lead selecionado e só para os campos pendentes.
    const enrichmentStatus = (needs) => ({ status: 'NAO_EXECUTADO', camposPendentes: needs, limiteDeTurnos: false, motivo: 'SOB_DEMANDA' });
    function saveDeliveredProfiles(round, outcomes) {
      for (const finding of round) {
        const outcome = outcomes.find((item) => item && item.empresa === finding.empresa && item.naFila === true && item.jaExistiaNaFila !== true && typeof item.prospectId === 'string');
        const entry = candidates.find((candidate) => candidate.nome === finding.empresa && candidate._perfilInput);
        if (!outcome || !entry) continue;
        try {
          const profile = commercial.buildCommercialProfile(entry._perfilInput);
          profileRepository.save(outcome.prospectId, { ...profile, contexto: { cidade: hint.cidade, uf: hint.estado || null, nicho: brief.nicho }, enriquecimento: enrichmentStatus(commercial.enrichmentNeeds(profile)), jobId: id, briefId: brief.id });
          tele.enriquecimento.perfisGerados += 1;
        } catch {
          tele.enriquecimento.falhas += 1;
        }
      }
    }

    // uma RODADA sobre o backlog: valida até comprovar o que ainda FALTA na fila, ingere pela cadeia EXISTENTE (a 1ª pelo caminho de sempre; as seguintes pela ingestão de
    // reposição do Brief Service, que passa pelas mesmas exclusões, deduplicação, DNC e Approval Queue) e MEDE a entrega. Devolve true se o job já terminou (cancelado/erro).
    async function processRound() {
      pending = [];
      while (backlog.length > 0) {
        if (wasCancelRequested(id)) return cancelled();
        if (pending.length >= quantity - delivered.size) break;
        if (timeLeft() <= 0) {
          stopReason = STOP_REASON.TEMPO;
          break;
        }
        const entry = backlog.shift();
        const startedValidation = now().getTime();
        let outcome;
        try {
          outcome = await evaluateCandidate(entry._in);
        } catch {
          outcome = { record: { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.VALIDACAO_FALHOU } };
        }
        tele.validationMs += now().getTime() - startedValidation;
        Object.assign(entry, outcome.record);
        const confirmed = outcome.record.siteOficial && outcome.record.siteOficial.url ? normalizeDomain(outcome.record.siteOficial.url) : null;
        if (confirmed) knownKeys.add(`dominio:${confirmed}`); // o domínio confirmado também identifica o candidato
        if (outcome.record.resultado === CANDIDATE_RESULT.VALIDADO && outcome.achado) {
          pending.push(outcome.achado);
          if (outcome.perfilInput) entry._perfilInput = outcome.perfilInput;
        }
        save(JOB_STEP.VALIDANDO);
      }
      if (pending.length === 0) return false;

      // o cancelamento é recusado SÓ enquanto a ingestão está EM ANDAMENTO
      if (wasCancelRequested(id)) return cancelled();
      const round = pending;
      patch(id, { ingestionStarted: true, currentStep: JOB_STEP.INGERINDO, progress: Math.max(requireJob(id).progress, 92), ...counts(), candidatos: candidates.map(summary), achadosValidados: round, telemetria: syncTelemetry() });
      let result;
      const ingestStartedAt = now().getTime();
      try {
        result = lotes.length === 0 ? await briefService.ingestFindings(context, brief.id, round) : await briefService.ingestReplacementFindings(context, brief.id, round);
      } catch {
        patch(id, { ingestionStarted: false });
        finalize(id, JOB_STATUS.ERRO, { ...counts(), candidatos: candidates.map(summary), telemetria: syncTelemetry(), ...(lotes.length > 0 ? { lote: aggregateLote() } : {}), error: { code: ERROR_CODE.INGESTION_FAILED, message: 'A ingestão dos candidatos validados falhou; nada foi promovido ao CRM.' } });
        return true;
      }
      tele.ingestaoMs += now().getTime() - ingestStartedAt;
      // MEDIÇÃO DA ENTREGA: o que o pipeline REALMENTE entregou à fila nesta rodada (lote.prospectIds); só isto conta para a meta. Um validado retido
      // (DADOS_INSUFICIENTES, DNC, DUPLICADO, REJEITADO...) NÃO conta e permanece nos resultados com o seu estado real.
      const batchResult = result && result.lote && typeof result.lote === 'object' ? result.lote : null;
      const outcomes = batchResult && Array.isArray(batchResult.resultados) ? batchResult.resultados : [];
      // SÓ conta o lead que ESTE job entregou à fila: o pipeline marca `naFila` também para um prospect que JÁ estava na fila (`jaExistiaNaFila`, de outro job, ainda
      // aguardando, já aprovado ou já rejeitado) — isso continua verdadeiro e auditável, mas NÃO é uma nova entrega do job. Sem o detalhe por candidato (`resultados`),
      // cai-se nos `prospectIds` do lote.
      const roundIds = Array.isArray(batchResult && batchResult.resultados)
        ? outcomes.filter((item) => item && item.naFila === true && item.jaExistiaNaFila !== true && typeof item.prospectId === 'string').map((item) => item.prospectId)
        : batchResult && Array.isArray(batchResult.prospectIds)
          ? batchResult.prospectIds
          : [];
      for (const prospectId of roundIds) delivered.add(prospectId);
      alreadyInQueue += outcomes.filter((item) => item && item.naFila === true && item.jaExistiaNaFila === true).length;
      for (const finding of round) {
        const entry = candidates.find((candidate) => candidate.nome === finding.empresa && candidate.resultado === CANDIDATE_RESULT.VALIDADO && !candidate.entrega);
        const outcome = outcomes.find((item) => item && item.empresa === finding.empresa);
        if (entry && outcome) entry.entrega = { naFila: outcome.naFila === true && outcome.jaExistiaNaFila !== true, ...(outcome.jaExistiaNaFila === true ? { jaExistiaNaFila: true } : {}), estadoOperacional: typeof outcome.estadoOperacional === 'string' ? outcome.estadoOperacional : null, ...(typeof outcome.motivo === 'string' ? { motivo: outcome.motivo } : {}) };
      }
      lotes.push({ loteId: batchResult ? batchResult.loteId : null, contagens: batchResult ? batchResult.contagens : null });
      excludedTotal += result && Number.isInteger(result.excluidosPermanentemente) ? result.excluidosPermanentemente : 0;
      ingestedAchados += round.length;
      pending = [];
      patch(id, { ingestionStarted: false });
      saveDeliveredProfiles(round, outcomes);
      if (delivered.size < quantity) tele.reposicoesNecessarias += 1;
      save(JOB_STEP.VALIDANDO);
      return false;
    }

    // ---- ANTI-REPETIÇÃO: o que a Approval Queue e o CRM já têm entra em `knownKeys` (mesmas chaves de identidade da deduplicação: domínio, depois nome + cidade) e na lista
    // COMPACTA que a descoberta recebe (nome | domínio | Instagram). É um filtro de ECONOMIA: a deduplicação do pipeline continua sendo a autoridade final.
    const externalKinds = new Map(); // chave de identidade -> 'dnc' | 'duplicado' | 'fila' (a mais restritiva vence)
    const KIND_PRIORITY = { dnc: 0, duplicado: 1, fila: 2 };
    const externalGroup = new Map(); // chave -> identidade conhecida (uma identidade tem várias chaves)
    let groupSeq = 0;
    const countedRepeats = new Set(); // identidades distintas já contadas em repetidosPor (o motor pode devolver a MESMA várias vezes: o lead conta uma vez)
    const strictestKind = (keys) => keys.map((key) => externalKinds.get(key)).filter(Boolean).sort((a, b) => KIND_PRIORITY[a] - KIND_PRIORITY[b])[0] || null;
    let externalForPrompt = [];
    if (knownIdentities !== null) {
      try {
        const known = await knownIdentities(context, { cidade: hint.cidade, uf: hint.estado });
        const list = known && Array.isArray(known.identidades) ? known.identidades : [];
        tele.conhecidos.fila = known && Number.isInteger(known.fila) ? known.fila : 0;
        tele.conhecidos.crm = known && Number.isInteger(known.crm) ? known.crm : 0;
        tele.conhecidos.indisponivel = Boolean(known && known.crmIndisponivel);
        for (const identity of list) {
          if (!isPlainObject(identity)) continue;
          const keys = candidateKeys({ nome: typeof identity.nome === 'string' && identity.nome.trim() !== '' ? identity.nome.trim() : '?', siteOficial: identity.dominio ? `https://${identity.dominio}/` : null }, identity.cidade || hint.cidade);
          if (typeof identity.nome !== 'string' || identity.nome.trim() === '') keys.splice(keys.findIndex((key) => key.startsWith('nome:')), 1);
          const kind = Object.prototype.hasOwnProperty.call(KIND_PRIORITY, identity.categoria) ? identity.categoria : 'fila';
          groupSeq += 1;
          for (const key of keys) {
            if (!externalGroup.has(key)) externalGroup.set(key, groupSeq);
            knownKeys.add(key);
            const current = externalKinds.get(key);
            if (!current || KIND_PRIORITY[kind] < KIND_PRIORITY[current]) externalKinds.set(key, kind);
          }
        }
        externalForPrompt = list.filter(isPlainObject);
      } catch {
        tele.conhecidos.indisponivel = true; // sem a lista a descoberta funciona como antes; a deduplicação do pipeline continua protegendo
      }
    }
    // ao motor vão SÓ os identificadores compactos (nome, cidade/UF, domínio, Instagram): a categoria de segurança e qualquer outro campo ficam aqui dentro
    const compactForEngine = (identity) => Object.fromEntries(['nome', 'cidade', 'uf', 'dominio', 'instagram'].filter((field) => typeof identity[field] === 'string' && identity[field] !== '').map((field) => [field, identity[field]]));
    const knownForDiscovery = () => [...externalForPrompt.map(compactForEngine), ...candidates.map((c) => ({ nome: c.nome, ...(c._in && c._in.siteOficial ? { dominio: normalizeDomain(c._in.siteOficial) } : {}) }))];
    let emptyRounds = 0; // rodadas seguidas em que a descoberta só trouxe candidatos já conhecidos

    let cycle = 0;
    for (;;) {
      if (wasCancelRequested(id)) return cancelled();
      if (delivered.size >= quantity) break;
      if (timeLeft() <= 0) {
        stopReason = STOP_REASON.TEMPO;
        break;
      }
      if (backlog.length > 0) {
        if (await processRound()) return undefined;
        if (stopReason === STOP_REASON.TEMPO) break;
        continue;
      }
      if (cycle >= maxCycles) break;
      if (candidates.length >= maxCandidates) {
        stopReason = STOP_REASON.CANDIDATOS;
        break;
      }
      cycle += 1;
      tele.ciclosExecutados = cycle;
      const replenishing = lotes.length > 0; // já houve uma ingestão e a meta ainda não foi atingida
      if (replenishing) {
        tele.ciclosReposicao += 1;
        event('REPOSICAO_INICIADA', cycle);
      }
      patch(id, { currentStep: JOB_STEP.DESCOBRINDO, cycles: cycle, ...counts(), telemetria: syncTelemetry() });

      // faltam = pedidos - JÁ NA FILA; o ciclo pede clamp(faltam x 3, 6, 12), nunca mais do que cabe nos 40
      const batch = computeBatchSize(quantity, delivered.size, { multiplier: limits.batchMultiplier, min: limits.batchMin, max: limits.batchMax }, maxCandidates - candidates.length);
      const askedAt = now().getTime();
      const found = await discoveryEngine.discover({
        nicho: brief.nicho,
        subnicho: brief.subnicho,
        cidade: region.cidade,
        uf: region.uf,
        limit: batch,
        excluir: candidates.map((c) => c.nome),
        conhecidos: knownForDiscovery(),
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
          finalize(id, JOB_STATUS.ERRO, { ...counts(), telemetria: syncTelemetry(), error: { code: ERROR_CODE.DISCOVERY_FAILED, message: 'A descoberta de candidatos falhou.', cause: found && typeof found.code === 'string' ? found.code : 'DESCONHECIDA' } });
          return undefined;
        }
        stopReason = STOP_REASON.DESCOBERTA;
        break;
      }

      // só candidatos NOVOS entram no processamento; os já conhecidos (qualquer desfecho anterior) são contados na telemetria e nada mais: nunca voltam à validação,
      // à ingestão nem à fila. Nunca além do teto absoluto nem do que foi pedido neste ciclo; nunca se inventa um candidato.
      const fresh = [];
      let repeated = 0;
      for (const raw of found.candidatos) {
        const item = normalizeCandidate(raw);
        if (item === null) continue;
        const keys = candidateKeys(item, hint.cidade);
        if (keys.some((key) => knownKeys.has(key))) {
          repeated += 1;
          const kind = strictestKind(keys);
          if (kind !== null) tele.conhecidos.repetidos += 1; // devoluções repetidas do motor (eventos)
          // repetidosPor conta IDENTIDADES distintas, cada uma em UMA categoria (a mais restritiva): o mesmo lead devolvido de novo não é contado outra vez
          const matched = keys.find((key) => knownKeys.has(key));
          const groupId = kind !== null ? externalGroup.get(keys.find((key) => externalKinds.get(key) === kind)) : matched;
          const countKey = `${kind || 'job'}:${groupId}`;
          if (!countedRepeats.has(countKey)) {
            countedRepeats.add(countKey);
            tele.repetidosPor[kind || 'job'] += 1;
          }
          continue;
        }
        if (candidates.length + fresh.length >= maxCandidates || fresh.length >= batch) break;
        for (const key of keys) knownKeys.add(key);
        fresh.push({ nome: item.nome, ciclo: cycle, _in: item });
      }
      tele.candidatosRepetidos += repeated;
      tele.candidatosNovos += fresh.length;
      tele.candidatosDescobertos += fresh.length + repeated;
      for (const entry of fresh) {
        candidates.push(entry);
        backlog.push(entry);
      }
      save(JOB_STEP.VALIDANDO);
      if (fresh.length === 0) {
        // o motor não trouxe NADA aproveitável: acabou. Só trouxe REPETIDOS: a reposição tenta de novo (com os repetidos agora também na lista de conhecidos), mas no máximo
        // 2 rodadas seguidas assim — dentro dos mesmos limites de ciclos, candidatos e tempo.
        emptyRounds += 1;
        tele.conhecidos.rodadasSoRepetidos += repeated > 0 ? 1 : 0;
        if (repeated === 0 || emptyRounds >= 2) {
          stopReason = STOP_REASON.SEM_CANDIDATOS_NOVOS;
          if (replenishing) event('REPOSICAO_SEM_CANDIDATOS_NOVOS', cycle);
          break;
        }
        event('DESCOBERTA_SO_REPETIDOS', cycle);
        continue;
      }
      emptyRounds = 0;

      if (await processRound()) return undefined;
      if (replenishing) {
        tele.reposicoesRealizadas += 1;
        event('REPOSICAO_CONCLUIDA', cycle);
      }
      if (stopReason === STOP_REASON.TEMPO) break;
    }
    if (delivered.size < quantity && stopReason === null) stopReason = candidates.length >= maxCandidates ? STOP_REASON.CANDIDATOS : STOP_REASON.CICLOS;
    const metaAtingida = delivered.size >= quantity;
    if (metaAtingida) event('META_ATINGIDA', cycle);

    // sem nenhuma ingestão ainda, um cancelamento tardio ainda vale (nada foi entregue); depois de uma ingestão o job termina pelo que foi entregue
    if (lotes.length === 0 && wasCancelRequested(id)) return cancelled();
    tele.limitReached = metaAtingida ? null : stopReason;

    // nada validado e nada ingerido: nada a entregar (o brief continua PESQUISANDO; um novo job não é aceito nesse estado)
    if (lotes.length === 0) {
      finalize(id, JOB_STATUS.PARCIAL, { ...counts(), candidatos: candidates.map(summary), telemetria: syncTelemetry() });
      return undefined;
    }
    // CONCLUIDO = a quantidade pedida de leads que CHEGARAM à Approval Queue; senão PARCIAL
    finalize(id, metaAtingida ? JOB_STATUS.CONCLUIDO : JOB_STATUS.PARCIAL, { ...counts(), candidatos: candidates.map(summary), telemetria: syncTelemetry(), lote: aggregateLote() });
    return undefined;
  }

  return Object.freeze({ startJob, redoJob, getJob, listJobs, cancelJob, recoverInterruptedJobs, waitFor });
}

module.exports = { createProspectingJobService, ProspectingJobError, ERROR };
