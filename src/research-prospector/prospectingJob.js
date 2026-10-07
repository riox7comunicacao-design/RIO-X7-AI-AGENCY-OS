// JOB de prospecção (Fase 2 — "INICIAR PROSPECÇÃO"; motor comercial na Implementação 2): o modelo de uma execução automática de descoberta + validação, e o
// seu vocabulário. Módulo PURO (sem I/O, sem rede, sem relógio, sem processo): só estados, limites, identificadores e a decisão sobre um candidato a
// partir das páginas que foram lidas.
//
// O job NÃO é um segundo caminho de ingestão: ele descobre candidatos (motor externo injetado), valida cada um por código (fetchPage + verifyOnPage) e
// entrega os VALIDADOS, de uma vez só, ao caminho oficial que já existe (prospectingBriefService.ingestFindings -> exclusões -> deduplicação -> DNC ->
// Approval Queue). Quem aprova continua sendo um humano; nada aqui promove para o CRM.
//
// A META COMERCIAL do job é a quantidade de leads que CHEGARAM à Approval Queue: VALIDADO pelo motor (empresa + nicho + localização comprovados) NÃO é "entregue à
// fila" — depois da ingestão pelo pipeline oficial, um lead que termina DADOS_INSUFICIENTES, DNC, DUPLICADO ou REJEITADO não conta para a meta.
//
// LEAD VÁLIDO = empresa + nicho + localização COMPROVADOS no texto de uma página. O site oficial NÃO é requisito: uma empresa comprovada sem site próprio
// continua sendo um lead válido (e pode ser uma oportunidade comercial).

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
  SEM_FONTE_VERIFICAVEL: 'SEM_FONTE_VERIFICAVEL', // nenhuma página legível para conferir (sem site e sem fonte de terceiro legível)
  PAGINA_INACESSIVEL: 'PAGINA_INACESSIVEL', // as páginas tentadas não abriram
  EVIDENCIA_INCOMPLETA: 'EVIDENCIA_INCOMPLETA', // a página abriu, mas faltou empresa, nicho ou localização
  VALIDACAO_FALHOU: 'VALIDACAO_FALHOU',
});

const ERROR_CODE = Object.freeze({
  DISCOVERY_FAILED: 'DISCOVERY_FAILED',
  INTERRUPTED: 'JOB_INTERRUPTED',
  INGESTION_FAILED: 'INGESTION_FAILED',
  INTERNAL: 'JOB_INTERNAL',
});

// Por que a prospecção parou sem atingir a quantidade pedida (telemetria do job PARCIAL).
const STOP_REASON = Object.freeze({
  CANDIDATOS: 'CANDIDATOS', // o teto absoluto de candidatos
  CICLOS: 'CICLOS', // o máximo de ciclos de descoberta
  TEMPO: 'TEMPO', // o tempo máximo
  SEM_CANDIDATOS_NOVOS: 'SEM_CANDIDATOS_NOVOS', // o motor não trouxe nenhuma empresa nova
  DESCOBERTA: 'DESCOBERTA', // a descoberta falhou depois do primeiro ciclo
  ENTREGA_INSUFICIENTE: 'ENTREGA_INSUFICIENTE', // a quantidade foi VALIDADA pelo motor, mas menos leads chegaram de fato à Approval Queue
});

const LIMITS = Object.freeze({
  MAX_CANDIDATES: 40, // o teto ABSOLUTO de candidatos examinados: a quantidade pedida NÃO define o teto
  MAX_CYCLES: 6, // ciclos de descoberta
  BATCH_MULTIPLIER: 3, // candidatos pedidos por lead que ainda falta (supõe ~1 válido a cada 3)
  BATCH_MIN: 6,
  BATCH_MAX: 12,
  MAX_THIRD_PARTY_PAGES: 3, // páginas de terceiros (notícia/diretório) lidas por candidato, só quando o site oficial não comprova
  MAX_DURATION_MS: 15 * 60 * 1000, // tempo máximo de uma execução (descoberta + validação)
  DISCOVERY_TIMEOUT_MS: 5 * 60 * 1000, // tempo máximo de UMA chamada ao motor de descoberta
  CANDIDATE_TIMEOUT_MS: 60 * 1000, // tempo máximo de UM candidato pelo Researcher
  MAX_DISCOVERY_OUTPUT_BYTES: 256 * 1024, // tamanho máximo do que o motor devolve
  MAX_CANDIDATE_TEXT: 200,
  MAX_CANDIDATE_URL: 2048,
});

const JOB_ID_PATTERN = /^JOB-\d{8}-\d{3}$/;

// O tamanho do PRÓXIMO ciclo de descoberta: clamp(faltam x 3, 6, 12), onde faltam = quantidade pedida - quantidade validada — e nunca mais do que o que ainda
// cabe no teto absoluto de candidatos (`budget`). Ex.: 3 pedidos -> 9; 10 pedidos -> 12; falta 1 -> 6.
function computeBatchSize(quantity, validated, overrides = {}, budget = LIMITS.MAX_CANDIDATES) {
  const multiplier = overrides.multiplier ?? LIMITS.BATCH_MULTIPLIER;
  const min = overrides.min ?? LIMITS.BATCH_MIN;
  const max = overrides.max ?? LIMITS.BATCH_MAX;
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('computeBatchSize: a quantidade deve ser um inteiro >= 1');
  if (!Number.isInteger(validated) || validated < 0) throw new Error('computeBatchSize: validated deve ser um inteiro >= 0');
  const missing = Math.max(1, quantity - validated);
  const wanted = Math.min(max, Math.max(min, missing * multiplier));
  return Math.max(0, Math.min(wanted, budget));
}

function buildJobId(date, sequenceForDay) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `JOB-${yyyy}${mm}${dd}-${String(sequenceForDay).padStart(3, '0')}`;
}

const isActive = (status) => ACTIVE_STATUSES.includes(status);
const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

const ASPECTS = Object.freeze(['empresa', 'nicho', 'localizacao']);
const verdictOf = (verdict) => (verdict && verdict.status === 'VALIDADO' ? 'VALIDADO' : 'NAO_VERIFICADO');

// A DECISÃO sobre um candidato a partir das páginas que foram lidas (uma por fonte), cada uma com os vereditos de verifyOnPage:
//   pages: [{ origem: { url, tipo }, falha?, causa?, veredito?: { empresa, nicho, localizacao } }]
// Uma página que abriu traz `veredito`; uma que não abriu traz `falha`/`causa` (a causa técnica específica: DNS, TLS, ROBOTS_BLOQUEIA...).
// VALIDADO exige que UMA MESMA página comprove os três (empresa, nicho e localização) — as evidências nunca são "completadas" entre páginas diferentes.
// O site oficial NÃO é requisito: a página que comprova pode ser a do site, de um diretório ou de uma matéria. Qualquer outra coisa é NAO_VERIFICADO
// (nunca "incompatível": ausência de evidência não é evidência de incompatibilidade).
//   Devolve { resultado, motivo, empresa, nicho, localizacao, evidencias?, fonteDaValidacao?, causa?, faltando? } (estados e trechos curtos; nada de texto de página).
function decideLead(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const read = list.filter((page) => page && page.veredito && typeof page.veredito === 'object');
  const state = (page) => Object.fromEntries(ASPECTS.map((aspect) => [aspect, verdictOf(page.veredito[aspect])]));
  const count = (page) => ASPECTS.filter((aspect) => verdictOf(page.veredito[aspect]) === 'VALIDADO').length;

  const complete = read.find((page) => count(page) === ASPECTS.length);
  if (complete) {
    const evidencias = {};
    for (const aspect of ASPECTS) {
      const verdict = complete.veredito[aspect];
      evidencias[aspect] = { trecho: verdict.evidencia, regra: verdict.regra };
    }
    return { resultado: CANDIDATE_RESULT.VALIDADO, motivo: null, ...state(complete), evidencias, fonteDaValidacao: { url: complete.origem.url, tipo: complete.origem.tipo } };
  }
  const none = { empresa: 'NAO_VERIFICADO', nicho: 'NAO_VERIFICADO', localizacao: 'NAO_VERIFICADO' };
  if (read.length === 0) {
    const failed = list.find((page) => page && typeof page.causa === 'string');
    return { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: list.length === 0 ? CANDIDATE_REASON.SEM_FONTE_VERIFICAVEL : CANDIDATE_REASON.PAGINA_INACESSIVEL, ...none, ...(failed ? { causa: failed.causa } : {}), faltando: [...ASPECTS] };
  }
  const best = read.reduce((top, page) => (count(page) > count(top) ? page : top), read[0]);
  const states = state(best);
  return { resultado: CANDIDATE_RESULT.NAO_VERIFICADO, motivo: CANDIDATE_REASON.EVIDENCIA_INCOMPLETA, ...states, faltando: ASPECTS.filter((aspect) => states[aspect] !== 'VALIDADO') };
}

module.exports = {
  JOB_STATUS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  JOB_STEP,
  CANDIDATE_RESULT,
  CANDIDATE_REASON,
  ERROR_CODE,
  STOP_REASON,
  LIMITS,
  JOB_ID_PATTERN,
  VERIFICATION_ASPECTS: ASPECTS,
  computeBatchSize,
  buildJobId,
  isActive,
  isTerminal,
  decideLead,
};
