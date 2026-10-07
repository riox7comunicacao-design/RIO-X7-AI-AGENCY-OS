// JOB de prospecção (Fase 2 — "INICIAR PROSPECÇÃO"): o modelo de uma execução automática de descoberta + validação, e o
// seu vocabulário. Módulo PURO (sem I/O, sem rede, sem relógio, sem processo): só estados, limites, identificadores e a
// classificação de um candidato a partir do que o Researcher devolveu.
//
// O job NÃO é um segundo caminho de ingestão: ele só descobre candidatos (motor externo injetado), valida cada um pelo
// Researcher existente (fetchPage + verifyOnPage) e entrega os VALIDADOS, de uma vez só, ao caminho oficial que já existe
// (prospectingBriefService.ingestFindings -> exclusões -> deduplicação -> DNC -> Approval Queue). Quem aprova continua sendo
// um humano, na Approval Queue; nada aqui promove para o CRM.

const JOB_STATUS = Object.freeze({
  CRIADO: 'CRIADO',
  EXECUTANDO: 'EXECUTANDO',
  CANCELAMENTO_SOLICITADO: 'CANCELAMENTO_SOLICITADO',
  CANCELADO: 'CANCELADO',
  CONCLUIDO: 'CONCLUIDO',
  PARCIAL: 'PARCIAL',
  ERRO: 'ERRO',
});

const ACTIVE_STATUSES = Object.freeze([JOB_STATUS.CRIADO, JOB_STATUS.EXECUTANDO, JOB_STATUS.CANCELAMENTO_SOLICITADO]);
const TERMINAL_STATUSES = Object.freeze([JOB_STATUS.CANCELADO, JOB_STATUS.CONCLUIDO, JOB_STATUS.PARCIAL, JOB_STATUS.ERRO]);

const JOB_STEP = Object.freeze({
  PREPARANDO: 'PREPARANDO',
  DESCOBRINDO: 'DESCOBRINDO',
  VALIDANDO: 'VALIDANDO',
  INGERINDO: 'INGERINDO',
  FINALIZADO: 'FINALIZADO',
});

// O resultado de UM candidato.
const CANDIDATE_RESULT = Object.freeze({
  VALIDADO: 'VALIDADO',
  NAO_VERIFICADO: 'NAO_VERIFICADO',
  DESCARTADO: 'DESCARTADO',
});

// Por que um candidato não foi validado (vocabulário fechado; vai para a tela e para o histórico do job, nunca texto livre da web).
const CANDIDATE_REASON = Object.freeze({
  EXCLUSAO_PERMANENTE: 'EXCLUSAO_PERMANENTE',
  EXCLUSAO_NAO_CONSULTADA: 'EXCLUSAO_NAO_CONSULTADA',
  URL_INVALIDA: 'URL_INVALIDA',
  PAGINA_INACESSIVEL: 'PAGINA_INACESSIVEL',
  EVIDENCIA_INCOMPLETA: 'EVIDENCIA_INCOMPLETA',
  VALIDACAO_FALHOU: 'VALIDACAO_FALHOU',
});

const ERROR_CODE = Object.freeze({
  DISCOVERY_FAILED: 'DISCOVERY_FAILED',
  INTERRUPTED: 'JOB_INTERRUPTED',
  INGESTION_FAILED: 'INGESTION_FAILED',
  INTERNAL: 'JOB_INTERNAL',
});

const LIMITS = Object.freeze({
  CANDIDATES_MULTIPLIER: 2, // candidatos a descobrir = quantidade pedida x 2
  CANDIDATES_ABSOLUTE_MAX: 40, // nunca mais do que isto, qualquer que seja a quantidade
  MAX_CYCLES: 2, // ciclos de descoberta (o primeiro e, no máximo, mais um)
  MAX_DURATION_MS: 15 * 60 * 1000, // tempo máximo de uma execução (descoberta + validação)
  DISCOVERY_TIMEOUT_MS: 5 * 60 * 1000, // tempo máximo de UMA chamada ao motor de descoberta
  CANDIDATE_TIMEOUT_MS: 60 * 1000, // tempo máximo de UM candidato pelo Researcher
  MAX_DISCOVERY_OUTPUT_BYTES: 256 * 1024, // tamanho máximo do que o motor devolve
  MAX_CANDIDATE_TEXT: 200,
  MAX_CANDIDATE_URL: 2048,
});

const JOB_ID_PATTERN = /^JOB-\d{8}-\d{3}$/;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// candidatos a descobrir = quantidade x 2, no máximo 40 (e nunca menos de 1)
function computeCandidateLimit(quantity, overrides = {}) {
  const multiplier = overrides.multiplier ?? LIMITS.CANDIDATES_MULTIPLIER;
  const absoluteMax = Math.min(overrides.absoluteMax ?? LIMITS.CANDIDATES_ABSOLUTE_MAX, LIMITS.CANDIDATES_ABSOLUTE_MAX);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('computeCandidateLimit: a quantidade deve ser um inteiro >= 1');
  return Math.max(1, Math.min(quantity * multiplier, absoluteMax));
}

function buildJobId(date, sequenceForDay) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `JOB-${yyyy}${mm}${dd}-${String(sequenceForDay).padStart(3, '0')}`;
}

const isActive = (status) => ACTIVE_STATUSES.includes(status);
const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

// A classificação de UM candidato a partir do que o Researcher devolveu para ele (uma pesquisa de um candidato só). A prova é a página:
// VALIDADO exige a página oficial lida E os TRÊS vereditos (empresa, nicho, localização) comprovados por código (relatorio.verificacoes, que o
// Researcher preenche com o resultado de verifyOnPage); qualquer outra coisa é NAO_VERIFICADO (nunca "incompatível": ausência de evidência não é
// evidência de incompatibilidade). DESCARTADO é só o que é determinístico e decidido fora da página (exclusão permanente, URL inválida) — ver o
// serviço. Nunca "conserta" nem completa nada.
//   output: { ok, achados, relatorio } do Researcher. Devolve { resultado, motivo, causa?, faltando?, achado? }.
const VERIFICATION_ASPECTS = Object.freeze(['empresa', 'nicho', 'localizacao']);

function classifyResearch(output) {
  if (!output || typeof output !== 'object' || output.ok !== true || !Array.isArray(output.achados) || typeof output.relatorio !== 'object' || output.relatorio === null) {
    return { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.VALIDACAO_FALHOU };
  }
  const report = output.relatorio;
  const verification = Array.isArray(report.verificacoes) && report.verificacoes.length > 0 && report.verificacoes[0] && typeof report.verificacoes[0] === 'object' ? report.verificacoes[0] : null;
  if (output.achados.length === 0) {
    if (report.resultadosInvalidos > 0) return { resultado: CANDIDATE_RESULT.DESCARTADO, motivo: CANDIDATE_REASON.URL_INVALIDA };
    return { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.PAGINA_INACESSIVEL, ...firstCause(report) };
  }
  if (verification === null || verification.paginaOficial !== true) {
    return { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.PAGINA_INACESSIVEL, ...firstCause(report), faltando: [...VERIFICATION_ASPECTS] };
  }
  const missing = VERIFICATION_ASPECTS.filter((aspect) => verification[aspect] !== 'VALIDADO');
  if (missing.length > 0) return { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.EVIDENCIA_INCOMPLETA, faltando: missing };
  return { resultado: CANDIDATE_RESULT.VALIDADO, motivo: null, achado: output.achados[0] };
}

// A causa técnica da PRIMEIRA falha do relatório (o site oficial é a primeira página visitada), se houver.
function firstCause(report) {
  const causas = report && report.causas && typeof report.causas === 'object' ? Object.keys(report.causas) : [];
  return causas.length > 0 ? { causa: causas[0] } : {};
}

module.exports = {
  JOB_STATUS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  JOB_STEP,
  CANDIDATE_RESULT,
  CANDIDATE_REASON,
  ERROR_CODE,
  LIMITS,
  JOB_ID_PATTERN,
  VERIFICATION_ASPECTS,
  computeCandidateLimit,
  buildJobId,
  isActive,
  isTerminal,
  classifyResearch,
  hasOwn,
};
