// Lead Enrichment Service (Implementação 3.0.2) — "COMPLETAR PESQUISA": o enriquecimento comercial APROFUNDADO, SOB DEMANDA, para UM lead.
//
//   API -> LeadEnrichmentService -> motor de enriquecimento (claude -p, só WebSearch/WebFetch) + leitura de página pública + perfil comercial do lead
//
// POR QUE SOB DEMANDA: a prospecção automática (Descoberta -> Validação -> Ingestão -> Approval Queue) não chama o Claude para enriquecer: ela só grava o que o CÓDIGO já extraiu das páginas
// consultadas. Pesquisar responsável, anúncios, atividade e os canais que faltam para TODO lead gastava tempo e tokens em leads que ninguém ia aprovar. Aqui o humano escolhe UM lead.
//
// O QUE FAZ
//   start(context, prospectId)      identifica os campos ausentes / não verificados do perfil e pesquisa EXCLUSIVAMENTE esses (numa nova tentativa, só os que ficaram PENDENTES). Responde
//                                   na hora (EM_ANDAMENTO); a pesquisa roda em segundo plano. Uma execução por lead por vez (ALREADY_RUNNING). Nada confirmado é pesquisado de novo.
//   getStatus(context, prospectId)  o estado: NAO_EXECUTADO | EM_ANDAMENTO (etapa, tempo decorrido) | COMPLETO | INCOMPLETO | FALHOU, os campos pendentes, a última execução (fontes, data, duração,
//                                   custo informado pelo motor) e se pode (re)tentar.
//
// RESULTADO POR CAMPO (ajuste de confiabilidade): uma execução sem erro NÃO é, por si só, uma pesquisa completa. Cada campo pedido termina ENCONTRADO (obtido e validado por código),
//   NAO_ENCONTRADO_COM_VERIFICACAO (o motor respondeu, a execução não foi cortada e o CÓDIGO confirmou a leitura de ao menos uma fonte consultada: a tentativa está documentada; não prova que
//   a informação não existe) ou NAO_VERIFICADO (omitido sem consulta, fonte não confirmada, resposta vazia, dado descartado, falha ou limite). Campo omitido/vazio NUNCA vira "não encontrado"
//   sozinho; o status COMPLETO só existe com TODOS os campos pedidos resolvidos (research-prospector/enrichmentResolution.js). Os campos NAO_VERIFICADO podem ser pesquisados de novo — mesmo
//   depois de um COMPLETO antigo —, sempre por ação explícita, de um lead, e só eles.
//
// REGRAS (todas por código; o que o motor afirma NÃO é prova)
//   - o perfil é MESCLADO (commercialProfile.applyEnrichment): nunca apaga nem rebaixa algo confirmado; telefones, WhatsApps, e-mails e URLs sem duplicar; uma URL sugerida NUNCA vira canal CONFIRMADO;
//   - o responsável só entra se a página citada contém nome e cargo; um site sugerido só vale se verifyOfficialSite o vincular à empresa (e então os contatos/endereço/perfis DELE entram por código);
//   - anúncios e postagens: "nenhuma evidência" nunca vira "não anuncia"; sem data visível, atividade fica NAO_VERIFICADO;
//   - NÃO altera a Approval Queue: o estado, a decisão e o histórico do item ficam exatamente como estão (este Service só LÊ o snapshot do item);
//   - falha, limite de turnos ou limite de uso do Claude: o perfil continua com tudo o que já estava confirmado, e o estado diz claramente o que ficou pendente e por quê.
//
// REVER SITE OFICIAL (reviewSite): ação EXPLÍCITA, de UM lead, que reverifica o vínculo do domínio com a empresa por evidência pública (verifyOfficialSite sobre a página real). NENHUMA substituição
// automática de um domínio já confirmado: se a revisão comprova OUTRO domínio, ele vira uma PROPOSTA PENDENTE (`propostaSite`) com as evidências dos dois, o site atual é PRESERVADO e só uma decisão
// HUMANA (decideSiteProposal: CONFIRMAR ou MANTER, sem nova pesquisa) troca o domínio, registrando usuário, data, domínios, fontes e decisão. Se não havia site, um site comprovado entra direto.
// O resultado, as fontes e o histórico (últimas 10) ficam em `revisaoSite`; as decisões (últimas 20) em `decisoesSite`.
//
// SEM LOTE (3.0.2): cada pesquisa é iniciada por um usuário autorizado, para UM lead, por uma chamada explícita. Não existe operação em lote nem agendamento; a prospecção automática não chama este
// Service; e há UMA pesquisa por vez no processo (outra, mesmo de outro lead, é recusada com ENRICH_BUSY) — um script não consegue disparar várias em paralelo. Um lead em DNC não é enriquecido.
//
// AUTORIZAÇÃO: APPROVE:LEAD_APPROVAL (a mesma de ver o perfil), decidida pelo autorizador INJETADO ANTES de qualquer leitura.

const approvalQueueDomain = require('../research-prospector/approvalQueue');
const commercial = require('../research-prospector/commercialProfile');
const digital = require('../research-prospector/digitalPresence');
const resolution = require('../research-prospector/enrichmentResolution');
const { verifyOfficialSite } = require('../research-prospector/pageVerification');
const { PERMISSION } = require('../auth');

const REQUIRED_PERMISSION = PERMISSION.APPROVE_LEAD_APPROVAL;
const REQUIRED_DOMAIN_FUNCTIONS = Object.freeze(['loadQueueFromDisk']);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EXECUTIONS = 10;
const MAX_DECISIONS = 20;
// ORÇAMENTO DE LEITURAS DE VERIFICAÇÃO (padrão CONSERVADOR, configurável por quem monta o Service): páginas DISTINTAS que o código lê, por execução, para conferir as fontes que o motor disse ter consultado
// de campos não encontrados. A leitura de uma página já feita na mesma execução (cache) não gasta orçamento. 0 desliga a verificação (nada é documentado: tudo fica NAO_VERIFICADO).
const DEFAULT_VERIFICATION_READS = 4;
const MAX_VERIFICATION_READS = 10; // teto da configuração
const DEFAULT_READS_PER_FIELD = 2; // tentativas de fonte por campo (para na PRIMEIRA fonte pertinente)
const MAX_READS_PER_FIELD = 3;
// por que a validação descartou o que o motor trouxe para o campo (motivo registrado, sem guardar o conteúdo)
const DISCARD_REASON = Object.freeze({
  siteOficial: 'VINCULO_COM_A_EMPRESA_NAO_COMPROVADO',
  responsavel: 'ORIGEM_NAO_CONFIRMA_NOME_E_CARGO',
  endereco: 'FORMATO_OU_ORIGEM_INVALIDOS',
  telefones: 'FORMATO_OU_ORIGEM_INVALIDOS',
  whatsapps: 'FORMATO_OU_ORIGEM_INVALIDOS',
  emails: 'FORMATO_OU_ORIGEM_INVALIDOS',
  presencaDigital: 'PERFIL_INVALIDO',
  trafegoPago: 'PLATAFORMA_OU_URL_INVALIDA',
  atividadeRecente: 'SEM_DATA_OU_CANAL_NAO_CONFIRMADO',
});

const ERROR = Object.freeze({
  INVALID_INPUT: 'ENRICH_INVALID_INPUT',
  NOT_FOUND: 'ENRICH_NOT_FOUND',
  ALREADY_RUNNING: 'ENRICH_ALREADY_RUNNING',
  UNAVAILABLE: 'ENRICH_UNAVAILABLE',
  BUSY: 'ENRICH_BUSY',
  NOT_ALLOWED: 'ENRICH_NOT_ALLOWED',
  NO_PROPOSAL: 'ENRICH_NO_PROPOSAL',
});

// Mensagens para a pessoa, por motivo (nunca o texto técnico do processo).
const MESSAGES = Object.freeze({
  SPAWN_FAILED: 'O Claude não está disponível neste computador (não foi possível iniciá-lo).',
  USAGE_LIMIT: 'O limite de uso do Claude foi atingido. Tente novamente mais tarde.',
  TIMEOUT: 'A pesquisa excedeu o tempo limite. Os campos pendentes podem ser tentados de novo.',
  MAX_TURNS: 'A pesquisa atingiu o limite de turnos do motor antes de terminar. Os campos pendentes podem ser tentados de novo.',
  AGENT_ERROR: 'O Claude devolveu um erro. Tente novamente.',
  EXIT_NONZERO: 'O Claude encerrou com erro. Tente novamente.',
  OUTPUT_INVALID: 'A resposta do Claude não pôde ser usada. Tente novamente.',
  OUTPUT_TOO_LARGE: 'A resposta do Claude foi grande demais para ser usada.',
  ABORTED: 'A pesquisa foi interrompida.',
  INTERROMPIDO: 'A pesquisa foi interrompida (o servidor foi reiniciado). Os campos pendentes podem ser tentados de novo.',
  BUSY: 'Já existe uma pesquisa em andamento para outro lead. Aguarde ela terminar: as pesquisas são feitas uma de cada vez, lead a lead.',
  DNC: 'Este lead está em DNC (não contatar): a pesquisa de contatos não é permitida.',
  SEM_RESPOSTA_PARA_O_LEAD: 'O Claude terminou, mas não respondeu para este lead.',
  VERIFICACAO_INSUFICIENTE: 'A pesquisa terminou sem documentar a verificação de alguns campos: eles continuam NÃO VERIFICADOS e podem ser pesquisados de novo.',
  MAX_TURNS_NAO_CONFIRMADO: 'O limite de turnos foi registrado por contagem, sem confirmação do motor (pode ter sido um término normal). Os campos pendentes podem ser tentados de novo.',
  BLOQUEADO_POR_PRE_REQUISITO: 'A atividade recente exige um canal oficial confirmado (Instagram, Facebook etc.). Confirme um canal para poder pesquisá-la; perfis apenas sugeridos não valem.',
  LEGADO_SEM_VERIFICACAO: 'Uma pesquisa anterior foi registrada como concluída, mas não guardou a verificação dos campos que faltam: eles estão NÃO VERIFICADOS e podem ser pesquisados de novo.',
  ERRO_INTERNO: 'A pesquisa falhou por um erro interno.',
});

// Um texto gravado por uma versão anterior com um defeito conhecido (a palavra "campos" trocada por "resolucao" numa renomeação): é CORRIGIDO só na exibição; o registro histórico não é reescrito.
const CORRUPTED_MESSAGES = Object.freeze({
  'A pesquisa terminou sem documentar a verificação de alguns resolucao: eles continuam NÃO VERIFICADOS e podem ser pesquisados de novo.': 'VERIFICACAO_INSUFICIENTE',
});
const displayMessage = (text) => (typeof text === 'string' && Object.prototype.hasOwnProperty.call(CORRUPTED_MESSAGES, text) ? MESSAGES[CORRUPTED_MESSAGES[text]] : text);

class LeadEnrichmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LeadEnrichmentError';
    this.code = code;
  }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const copy = (value) => structuredClone(value);
const plain = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

function requireProspectId(prospectId) {
  if (typeof prospectId !== 'string' || prospectId.trim().length === 0) throw new LeadEnrichmentError(ERROR.INVALID_INPUT, 'prospectId deve ser um texto não vazio');
  return prospectId;
}

// dependencies:
//   authorizeReviewer   OBRIGATÓRIA — a porta síncrona (a ponte real de APPROVE:LEAD_APPROVAL)
//   queuePath           onde está a Approval Queue (SÓ leitura do snapshot do item)
//   profileRepository   OBRIGATÓRIA — { getById, save } do perfil comercial
//   enrichmentEngine    opcional — { enrich(request) }; sem ele o Service existe, mas start() responde ENRICH_UNAVAILABLE
//   createFetchPage     opcional — () => fetchPage: a leitura de página pública (nova a cada execução); sem ela o site e o responsável sugeridos não são conferidos (e não entram)
//   now, timeoutMs      injetáveis nos testes
function createLeadEnrichmentService(dependencies) {
  const { approvalQueue = approvalQueueDomain, authorizeReviewer, queuePath, profileRepository, enrichmentEngine = null, createFetchPage = null, now = () => new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, maxVerificationReads = DEFAULT_VERIFICATION_READS, maxReadsPerField = DEFAULT_READS_PER_FIELD } = dependencies || {};
  if (typeof authorizeReviewer !== 'function') throw new Error('createLeadEnrichmentService exige { authorizeReviewer } (função): sem autorizador injetado o Service não existe');
  for (const name of REQUIRED_DOMAIN_FUNCTIONS) if (!approvalQueue || typeof approvalQueue[name] !== 'function') throw new Error(`createLeadEnrichmentService: a dependência approvalQueue não tem a função ${name}()`);
  const filePath = queuePath === undefined ? approvalQueue.DEFAULT_QUEUE_PATH : queuePath;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new Error('createLeadEnrichmentService: queuePath deve ser um texto não vazio');
  if (!profileRepository || typeof profileRepository.getById !== 'function' || typeof profileRepository.save !== 'function') throw new Error('createLeadEnrichmentService exige { profileRepository } com getById() e save()');
  if (enrichmentEngine !== null && typeof enrichmentEngine.enrich !== 'function') throw new Error('createLeadEnrichmentService: enrichmentEngine, se informado, deve ter enrich()');
  if (createFetchPage !== null && typeof createFetchPage !== 'function') throw new Error('createLeadEnrichmentService: createFetchPage, se informado, deve ser uma função');
  if (!Number.isInteger(maxVerificationReads) || maxVerificationReads < 0 || maxVerificationReads > MAX_VERIFICATION_READS) throw new Error(`createLeadEnrichmentService: maxVerificationReads deve ser um inteiro de 0 a ${MAX_VERIFICATION_READS}`);
  if (!Number.isInteger(maxReadsPerField) || maxReadsPerField < 1 || maxReadsPerField > MAX_READS_PER_FIELD) throw new Error(`createLeadEnrichmentService: maxReadsPerField deve ser um inteiro de 1 a ${MAX_READS_PER_FIELD}`);

  const runs = new Map(); // prospectId -> { iniciadoEm, startMs, etapa, camposSolicitados, promise }

  function authorize(context) {
    const reviewer = authorizeReviewer(context, REQUIRED_PERMISSION);
    if (!isPlainObject(reviewer)) throw new Error('autorização recusada: o autorizador não devolveu a identidade do revisor');
    if (typeof reviewer.then === 'function') throw new Error('autorização recusada: o autorizador deve ser síncrono (devolveu uma Promise)');
    return { userId: String(reviewer.userId || ''), name: String(reviewer.name || ''), role: String(reviewer.role || '') };
  }

  function loadItem(id) {
    const queue = approvalQueue.loadQueueFromDisk(filePath);
    const item = Object.prototype.hasOwnProperty.call(queue.items, id) ? queue.items[id] : null;
    if (item === null) throw new LeadEnrichmentError(ERROR.NOT_FOUND, `prospect não encontrado na fila: ${id}`);
    return item;
  }

  const today = () => now().toISOString().slice(0, 10);
  const KNOWN_STATUS = ['NAO_EXECUTADO', 'EM_ANDAMENTO', 'COMPLETO', 'INCOMPLETO', 'FALHOU'];

  // COMPATIBILIDADE com perfis ANTIGOS (3.0 / 3.0.1, gravados pelo job, sem os metadados da 3.0.2): inicializa o que falta SEM apagar nada — o contexto (cidade/UF/nicho) vem do snapshot da fila, o
  // estado do enriquecimento antigo (ex.: INCOMPLETO por limite de turnos, com os campos pendentes) é preservado e completado (listas, flag), e um estado desconhecido vira NAO_EXECUTADO com os
  // pendentes recalculados. Um lead SEM perfil (pesquisa manual) ganha o perfil-base do snapshot. Só é persistido quando uma execução grava o perfil; ler o estado nunca escreve.
  function profileFor(id, item) {
    const stored = loadProfile(id);
    const snapshot = isPlainObject(item.discoverySnapshot) ? item.discoverySnapshot : {};
    if (stored === null) return commercial.baseProfileFromSnapshot(snapshot, today());
    const out = { ...stored };
    if (!isPlainObject(out.contexto)) out.contexto = { cidade: typeof snapshot.cidade === 'string' ? snapshot.cidade : null, uf: typeof snapshot.estadoUf === 'string' ? snapshot.estadoUf : null, nicho: typeof snapshot.nicho === 'string' ? snapshot.nicho : null };
    for (const key of ['fontesDescoberta', 'fontesValidacao', 'fontesEnriquecimento', 'outrasPresencas', 'telefones', 'whatsapps', 'emails']) if (!Array.isArray(out[key])) out[key] = [];
    const info = isPlainObject(out.enriquecimento) ? out.enriquecimento : null;
    if (info && KNOWN_STATUS.includes(info.status)) {
      out.enriquecimento = { ...info, camposPendentes: Array.isArray(info.camposPendentes) ? info.camposPendentes : [], camposNaoEncontrados: Array.isArray(info.camposNaoEncontrados) ? info.camposNaoEncontrados : [], limiteDeTurnos: Boolean(info.limiteDeTurnos) };
    } else {
      out.enriquecimento = { status: 'NAO_EXECUTADO', camposPendentes: commercial.enrichmentNeeds(out), limiteDeTurnos: false, motivo: 'SOB_DEMANDA' };
    }
    return out;
  }
  const loadProfile = (id) => {
    const found = profileRepository.getById(id);
    if (!found) return null;
    const { prospectId, ...profile } = found;
    return profile;
  };

  // os campos a pesquisar: os que FALTAM no perfil e ainda NÃO estão resolvidos (nem ENCONTRADOS, nem NAO_ENCONTRADO_COM_VERIFICACAO). Vale para qualquer estado anterior — inclusive um COMPLETO
  // antigo que não guardou a verificação dos campos que faltam. O que já foi confirmado ou verificado não é pesquisado de novo.
  function fieldsToSearch(profile) {
    const current = commercial.enrichmentNeeds(profile);
    return searchScope(profile, current, resolution.fieldStates(profile, current)).open;
  }

  // `unresolved`: todos os campos que faltam e não estão resolvidos. `open`: os que uma nova tentativa pesquisa. Num registro ANTIGO (sem resultado por campo, ou que ainda carrega a origem
  // LEGADO) a tentativa se limita aos campos que AQUELE registro tinha pedido/pendente (o custo de uma nova tentativa não cresce por causa da migração); se nenhum deles ainda falta, vale o resto.
  function searchScope(profile, current, states) {
    const info = isPlainObject(profile.enriquecimento) ? profile.enriquecimento : {};
    const unresolved = current.filter((field) => states[field].resolvido !== true);
    const ran = isPlainObject(info.resolucao);
    const legacy = isPlainObject(info.legado) || !ran;
    const blocked = unresolved.filter((field) => states[field] && states[field].bloqueio);
    const searchable = (list) => list.filter((field) => !(states[field] && states[field].bloqueio));
    if (!legacy) return { unresolved, open: searchable(unresolved), blocked };
    const lists = [info.camposPendentes, info.camposNaoEncontrados, info.camposSolicitados, isPlainObject(info.legado) ? info.legado.camposPendentesAnterior : null, isPlainObject(info.legado) ? info.legado.camposNaoEncontradosAnterior : null];
    const listed = new Set([...lists.flatMap((list) => (Array.isArray(list) ? list : [])), ...Object.keys(isPlainObject(info.resolucao) ? info.resolucao : {})]);
    // um responsável encontrado SEM o vínculo com a empresa demonstrado (ou pendente) entra no escopo: a regra de vínculo é mais nova que o registro
    if (['PENDENTE', 'NAO_DEMONSTRADO'].includes(commercial.responsibleLinkState(profile))) listed.add('responsavel');
    const scoped = unresolved.filter((field) => listed.has(field));
    // um registro antigo que JÁ foi pesquisado de novo (tem resultado por campo) é avaliado só pelos campos que ele pediu; um que ainda não foi, cai nos que faltam se nenhum dos antigos falta mais
    return { unresolved, open: searchable(scoped.length > 0 || ran ? scoped : unresolved), blocked };
  }

  // O que o motor recebe de fontes: páginas NÃO sociais já guardadas (até 3) em `fontes`; perfis de rede social NÃO confirmados vão à parte, em `pistas` (até 2) — só indício de onde procurar, nunca evidência
  // oficial nem fonte de dado (o leitor público não os abre). Perfis JÁ confirmados seguem em `canais`.
  function sourceHints(profile, canais) {
    const urls = [...new Set([...(profile.fontesValidacao || []), ...(profile.fontesDescoberta || [])].map((source) => source && source.url).filter((url) => typeof url === 'string'))];
    const social = (url) => {
      const known = digital.classifyHost(digital.hostOf(url));
      return known !== null && known.tipo === digital.SOURCE_TYPE.REDE_SOCIAL;
    };
    const bare = (url) => String(url).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
    const confirmedUrls = new Set(Object.values(canais).map(bare));
    const fontes = urls.filter((url) => !social(url)).slice(0, 3);
    const pistas = urls.filter((url) => social(url) && !confirmedUrls.has(bare(url))).slice(0, 2);
    return { fontes, ...(pistas.length > 0 ? { pistas } : {}) };
  }

  function siteReviewView(profile) {
    const info = profile && isPlainObject(profile.revisaoSite) ? copy(profile.revisaoSite) : null;
    if (info && info.status === 'EM_ANDAMENTO') return { status: 'FALHOU', motivo: 'INTERROMPIDO', mensagem: MESSAGES.INTERROMPIDO, ultimaRevisao: info.ultimaRevisao || null };
    return info ? { status: info.status, ultimaRevisao: info.ultimaRevisao || null } : null;
  }

  // a PROPOSTA pendente de novo domínio (sem os dados internos usados para completar o perfil) e as últimas decisões humanas
  function siteProposalView(profile, running = false) {
    const proposal = profile && isPlainObject(profile.propostaSite) && profile.propostaSite.status === 'PENDENTE' ? profile.propostaSite : null;
    const { dadosDoNovo, ...visible } = proposal || {};
    return {
      propostaSite: proposal ? copy(visible) : null,
      podeDecidirSite: Boolean(proposal) && !running,
      decisoesSite: profile && Array.isArray(profile.decisoesSite) ? copy(profile.decisoesSite.slice(-5)) : [],
    };
  }

  function view(id, profile, item) {
    const run = runs.get(id);
    const blocked = Boolean(item) && item.estado === 'DNC';
    if (run) {
      return { prospectId: id, tipo: run.tipo || 'PESQUISA', status: 'EM_ANDAMENTO', etapa: run.etapa, iniciadoEm: run.iniciadoEm, elapsedMs: Math.max(0, now().getTime() - run.startMs), camposSolicitados: [...run.camposSolicitados], camposPendentes: [...run.camposSolicitados], podeCompletar: false, podeRever: false, disponivel: enrichmentEngine !== null, revisaoSite: siteReviewView(profile), ...siteProposalView(profile, true) };
    }
    let info = profile && isPlainObject(profile.enriquecimento) ? copy(profile.enriquecimento) : null;
    if (info && info.status === 'EM_ANDAMENTO') {
      // ficou "em andamento" no arquivo mas não há execução neste processo: o servidor foi reiniciado no meio — nunca finge que ainda roda
      info = { ...info, status: 'FALHOU', motivo: 'INTERROMPIDO', mensagem: MESSAGES.INTERROMPIDO, limiteDeTurnos: false };
    }
    // O estado de cada campo vem do RESULTADO POR CAMPO (e de um registro antigo sem ele, lido como NAO_VERIFICADO/LEGADO): o status gravado não basta para dizer que a pesquisa está completa.
    const needsNow = profile ? commercial.enrichmentNeeds(profile) : [];
    const resolucao = profile ? resolution.fieldStates(profile, needsNow) : {};
    const scope = profile ? searchScope(profile, needsNow, resolucao) : { unresolved: [], open: [] };
    const open = scope.open;
    const blockedNow = scope.blocked || [];
    const documented = resolution.FIELDS.filter((field) => resolucao[field] && resolucao[field].status === resolution.FIELD_STATUS.NAO_ENCONTRADO_COM_VERIFICACAO && resolucao[field].resolvido === true);
    const legacyRecord = Boolean(info) && !isPlainObject(info.resolucao) && ['COMPLETO', 'INCOMPLETO', 'FALHOU'].includes(info.status);
    // um COMPLETO gravado antes deste ajuste (ou obsoleto) com campos sem resolução NÃO é mostrado como completo; o registro original fica como está no perfil (statusRegistrado)
    const registered = info ? info.status : 'NAO_EXECUTADO';
    const downgraded = registered === 'COMPLETO' && (open.length > 0 || blockedNow.length > 0);
    const status = downgraded ? 'INCOMPLETO' : registered;
    const rawLast = info && info.ultimaExecucao ? info.ultimaExecucao : null;
    // uma execução gravada como LIMITE_DE_TURNOS SEM o subtype do motor foi classificada pela contagem de turnos (heurística anterior): o limite não foi confirmado pelo motor — o registro não é alterado
    const unconfirmedLimit = Boolean(rawLast) && rawLast.encerramento === 'LIMITE_DE_TURNOS' && !rawLast.subtype;
    const last = rawLast ? { ...(isPlainObject(rawLast.resultadosPorCampo) ? rawLast : { ...rawLast, origem: resolution.ORIGEM_LEGADO }), ...(unconfirmedLimit ? { limiteNaoConfirmado: true } : {}) } : null;
    return {
      prospectId: id,
      status,
      ...(downgraded ? { statusRegistrado: registered } : {}),
      camposPendentes: open,
      camposNaoEncontrados: documented,
      resolucao,
      camposBloqueados: blockedNow,
      bloqueios: blockedNow.map((campo) => ({ campo, motivo: resolution.REASON.BLOQUEADO_POR_PRE_REQUISITO, requer: resolution.REQUIRES[campo], mensagem: MESSAGES.BLOQUEADO_POR_PRE_REQUISITO })),
      pesquisaCompleta: Boolean(info) && registered !== 'NAO_EXECUTADO' && open.length === 0 && blockedNow.length === 0,
      origem: legacyRecord || (info && isPlainObject(info.legado)) ? resolution.ORIGEM_LEGADO : null,
      limiteDeTurnos: Boolean(info && info.limiteDeTurnos),
      motivo: info && info.motivo ? info.motivo : downgraded ? 'VERIFICACAO_INSUFICIENTE' : null,
      mensagem: info && info.mensagem ? (unconfirmedLimit && info.motivo === 'MAX_TURNS' ? MESSAGES.MAX_TURNS_NAO_CONFIRMADO : displayMessage(info.mensagem)) : downgraded ? (legacyRecord ? MESSAGES.LEGADO_SEM_VERIFICACAO : MESSAGES.VERIFICACAO_INSUFICIENTE) : null,
      ultimaExecucao: last,
      elapsedMs: last ? last.duracaoMs : 0,
      custoUsd: last && typeof last.custoUsd === 'number' ? last.custoUsd : null,
      podeCompletar: enrichmentEngine !== null && !blocked && runs.size === 0 && open.length > 0,
      podeRever: enrichmentEngine !== null && !blocked && runs.size === 0,
      disponivel: enrichmentEngine !== null,
      ...(blocked ? { bloqueio: 'DNC', mensagem: MESSAGES.DNC } : {}),
      revisaoSite: siteReviewView(profile),
      ...siteProposalView(profile),
    };
  }

  function getStatus(context, prospectId) {
    authorize(context);
    const id = requireProspectId(prospectId);
    const item = loadItem(id);
    // um lead sem perfil (pesquisa manual) tem o perfil-base do snapshot: o estado já diz o que há para pesquisar
    return view(id, profileFor(id, item), item);
  }

  function persist(id, profile, enriquecimento) {
    profileRepository.save(id, { ...profile, enriquecimento });
  }

  async function execute(id, run, profile, item, needs) {
    const startedAt = now().getTime();
    const previousInfo = isPlainObject(profile.enriquecimento) ? profile.enriquecimento : {};
    const previous = Array.isArray(previousInfo.execucoes) ? previousInfo.execucoes : [];
    const knownBefore = new Set((Array.isArray(profile.fontesEnriquecimento) ? profile.fontesEnriquecimento : []).map((source) => source && source.url).filter(Boolean));
    // O REGISTRO DA EXECUÇÃO (auditoria): o que foi pedido, o que o motor devolveu, o que foi validado ou descartado (e por quê), as fontes NOVAS (separadas das acumuladas), as ferramentas medidas
    // ("NAO_MEDIDO" quando o executor não informa — nunca um número inventado), tempo, turnos, custo informado, o motivo do encerramento e o resultado de CADA campo. Nada de resposta bruta.
    const record = {
      iniciadoEm: run.iniciadoEm,
      concluidoEm: null,
      duracaoMs: 0,
      custoUsd: null,
      webSearchRequests: null,
      turnos: null,
      ferramentas: resolution.toolCounts(null),
      subtype: null, // o desfecho informado pelo Claude Code (success | error_max_turns | ...); null quando não informado — nunca inventado
      terminalReason: null,
      tempoApiMs: null,
      camposSolicitados: needs,
      camposRetornados: [],
      camposDescartados: [],
      camposObtidos: [],
      camposPendentes: needs,
      resultadosPorCampo: {},
      resultado: null,
      motivo: null,
      encerramento: null,
      verificacao: { leituras: 0, limite: maxVerificationReads, encerramento: 'NENHUMA_LEITURA_NECESSARIA' },
      fontes: [], // ACUMULADAS: tudo o que o perfil já guardou até o fim desta execução
      fontesNovas: [], // só as que ESTA execução acrescentou
    };
    const finish = (profileFinal, status, extra = {}) => {
      record.concluidoEm = now().toISOString();
      record.duracaoMs = Math.max(0, now().getTime() - startedAt);
      record.resultado = status;
      const fields = extra.resolucao || {};
      record.resultadosPorCampo = fields;
      record.camposPendentes = resolution.unresolved(fields);
      if (extra.motivo) record.motivo = extra.motivo;
      record.encerramento = extra.encerramento || 'CONCLUIDA';
      // o resultado por campo fica no perfil (só dos campos que AINDA faltam): é ele que decide, nas próximas leituras, o que está resolvido e o que pode ser pesquisado de novo
      const storedFields = isPlainObject(previousInfo.resolucao) ? previousInfo.resolucao : {};
      const stillMissing = new Set(commercial.enrichmentNeeds(profileFinal));
      const resolucao = {};
      for (const [field, entry] of Object.entries({ ...storedFields, ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { ...value, execucao: record.iniciadoEm }])) })) if (stillMissing.has(field)) resolucao[field] = entry;
      const legado = run.legado || (isPlainObject(previousInfo.legado) ? previousInfo.legado : null);
      const enriquecimento = {
        status,
        camposPendentes: record.camposPendentes,
        camposNaoEncontrados: [...new Set([...Object.keys(resolucao).filter((field) => resolucao[field].status === resolution.FIELD_STATUS.NAO_ENCONTRADO_COM_VERIFICACAO && resolucao[field].resolvido === true), ...resolution.documentedAbsent(fields)])],
        limiteDeTurnos: Boolean(extra.limiteDeTurnos),
        ...(extra.motivo ? { motivo: extra.motivo } : {}),
        ...(extra.mensagem ? { mensagem: extra.mensagem } : {}),
        resolucao,
        ...(legado ? { legado } : {}),
        ultimaExecucao: { ...record },
        execucoes: [...previous, { ...record }].slice(-MAX_EXECUTIONS),
      };
      persist(id, profileFinal, enriquecimento);
    };
    const failed = (profileFinal, code, message, limit = false) => {
      const resolucao = resolution.resolveFields({ requested: needs, obtained: new Set(), returned: new Set(), interrupted: limit ? resolution.REASON.LIMITE_DE_TURNOS : code });
      finish(profileFinal, 'FALHOU', { resolucao, limiteDeTurnos: limit, motivo: code, mensagem: message, encerramento: limit ? 'LIMITE_DE_TURNOS' : code });
    };
    try {
      const snapshot = isPlainObject(item.discoverySnapshot) ? item.discoverySnapshot : {};
      const contexto = isPlainObject(profile.contexto) ? profile.contexto : {};
      const cidade = contexto.cidade || snapshot.cidade || '';
      const uf = contexto.uf || snapshot.estadoUf || '';
      const nicho = contexto.nicho || snapshot.nicho || '';
      const nome = typeof profile.empresa === 'string' && profile.empresa !== '' ? profile.empresa : item.empresa;
      const confirmed = digital.confirmedChannels(profile.presencaDigital);
      const canais = Object.fromEntries(confirmed.map(({ canal, url }) => [canal, url]));

      run.etapa = 'PESQUISANDO';
      let found;
      try {
        found = await enrichmentEngine.enrich({
          // SÓ: nome, cidade/UF, site confirmado, perfis já confirmados, até 3 fontes JÁ guardadas e a lista do que falta — nunca texto de página nem o CRM
          leads: [{
            nome,
            cidade,
            ...(uf ? { uf } : {}),
            site: profile.siteOficial && profile.siteOficial.status === 'ENCONTRADO' ? profile.siteOficial.url : null,
            canais,
            ...sourceHints(profile, canais),
            precisa: needs,
          }],
          timeoutMs,
        });
      } catch {
        found = null;
      }
      if (found && typeof found.custoUsd === 'number') record.custoUsd = found.custoUsd;
      if (found && Number.isInteger(found.webSearchRequests)) record.webSearchRequests = found.webSearchRequests;
      if (found && Number.isInteger(found.turnos)) record.turnos = found.turnos;
      record.ferramentas = resolution.toolCounts(found);
      if (found && typeof found.subtype === 'string') record.subtype = found.subtype;
      if (found && typeof found.terminalReason === 'string') record.terminalReason = found.terminalReason;
      if (found && Number.isInteger(found.tempoApiMs)) record.tempoApiMs = found.tempoApiMs;
      if (found && found.proximoDoLimite === true) record.proximoDoLimite = true; // chegou perto do limite de turnos, mas terminou normalmente: não é limite
      const hitLimit = Boolean(found && (found.limiteDeTurnos === true || found.code === 'MAX_TURNS'));

      if (!found || found.ok !== true || !Array.isArray(found.resultados)) {
        const code = found && typeof found.code === 'string' ? found.code : 'ERRO_INTERNO';
        failed(profile, code, MESSAGES[code] || MESSAGES.ERRO_INTERNO, hitLimit);
        return;
      }

      run.etapa = 'VALIDANDO';
      const answered = found.resultados.find((entry) => entry && entry.nome === nome) || null;
      // SÓ os campos PEDIDOS entram: o que o motor devolver além disso (um campo já confirmado, por exemplo) é ignorado — nada confirmado é reescrito
      const raw = answered ? Object.fromEntries(Object.entries(answered).filter(([field]) => field === 'nome' || needs.includes(field))) : null;
      const declared = answered && isPlainObject(answered.consultas) ? answered.consultas : {};
      const fetchPage = createFetchPage ? createFetchPage() : null;
      const cache = new Map();
      const fetchCached = async (url) => {
        if (fetchPage === null) return null;
        // uma EXCEÇÃO do leitor não vira um "não abriu" anônimo: fica marcada como EXCECAO_NA_LEITURA (sem a mensagem do erro, que pode trazer dados sensíveis)
        if (!cache.has(url)) cache.set(url, Promise.resolve().then(() => fetchPage(url)).catch(() => ({ ok: false, falha: 'EXCECAO_NA_LEITURA', causa: 'EXCECAO_NA_LEITURA' })));
        return cache.get(url);
      };
      let enrichment = null;
      const pendingSources = new Map();
      if (raw) {
        const confirmedSources = new Set();
        const vinculos = new Map();
        const claim = raw.responsavel;
        if (claim && typeof claim.origem === 'string' && typeof claim.nome === 'string' && typeof claim.cargo === 'string') {
          const page = await fetchCached(claim.origem);
          if (page && page.ok === true && typeof page.texto === 'string' && plain(page.texto).includes(plain(claim.nome)) && plain(page.texto).includes(plain(claim.cargo))) {
            // nome + cargo na página NÃO bastam: a página precisa identificar inequivocamente A EMPRESA (site oficial, ou o nome dela mais um identificador que o perfil já tinha por outra fonte)
            const link = commercial.assessResponsibleLink({ page, url: claim.origem, profile, company: nome });
            if (link.demonstrado) {
              confirmedSources.add(claim.origem);
              vinculos.set(claim.origem, link);
            } else {
              pendingSources.set(claim.origem, link.motivo);
            }
          }
        }
        enrichment = commercial.normalizeEnrichment(raw, { today: today(), confirmedSources, pendingSources, vinculos, confirmedChannels: new Set(Object.keys(canais)) });
        // site sugerido: só vale se a página o vincular à empresa (verifyOfficialSite); então os contatos, o endereço e os perfis DELE entram por código
        if (needs.includes('siteOficial') && enrichment.siteSugerido) {
          const page = await fetchCached(enrichment.siteSugerido);
          if (page && page.ok === true && typeof page.texto === 'string') {
            const origin = digital.normalizeToOrigin(typeof page.urlFinal === 'string' ? page.urlFinal : enrichment.siteSugerido);
            const verdict = origin ? verifyOfficialSite(page.texto, { nome, url: origin, identidade: page.identidade, nicho, cidade, uf }) : { status: 'NAO_VERIFICADO' };
            if (verdict.status === 'VALIDADO') {
              const fromSite = commercial.enrichmentFromOfficialPage({ texto: page.texto, links: page.links, origem: origin, identidade: page.identidade });
              enrichment = {
                ...enrichment,
                siteOficial: fromSite.siteOficial,
                telefones: [...fromSite.telefones, ...enrichment.telefones],
                whatsapps: [...fromSite.whatsapps, ...enrichment.whatsapps],
                emails: [...fromSite.emails, ...enrichment.emails],
                endereco: fromSite.endereco || enrichment.endereco,
                responsavel: fromSite.responsavel || enrichment.responsavel,
                presencaConfirmada: fromSite.presencaConfirmada,
                origens: [...(enrichment.origens || []), { url: origin, tipo: digital.SOURCE_TYPE.OFICIAL }],
              };
            }
          }
        }
      }

      // o que o motor trouxe (antes de qualquer verificação): decide quais campos precisam de conferência
      const returned = new Set(raw ? needs.filter((field) => resolution.isReturned(raw[field])) : []);
      let obtained = commercial.enrichmentObtained(enrichment);

      // VERIFICAÇÃO DAS FONTES CITADAS. O que o motor disse ter consultado é só uma declaração: para cada campo NÃO achado e NÃO descartado, o CÓDIGO lê a fonte citada e só a aceita se ela for PERTINENTE
      // à empresa e ao campo (resolution.assessSource) — uma leitura genérica não prova nada. Para na PRIMEIRA fonte pertinente de cada campo e quando as fontes acabam ou o orçamento de leituras
      // (maxVerificationReads, páginas distintas) se esgota; páginas já lidas na execução não gastam orçamento. Tráfego pago NUNCA se documenta por leitura de página (só pela consulta à biblioteca
      // de anúncios que o motor devolveu) e, se não foi solicitado, nada de anúncios é pedido nem exigido. Sem leitor de página (ou com a execução cortada) ninguém é documentado.
      const interrupted = hitLimit ? resolution.REASON.LIMITE_DE_TURNOS : null;
      const verified = {};
      const declaredCount = {};
      const rejected = {};
      const fromPages = {};
      // O REGISTRO DAS FONTES, por campo: as URLs que o motor CITOU e cada tentativa do código (leitura, categoria da falha, pertinência). Só URLs reduzidas a origem + caminho e códigos fixos —
      // nunca o conteúdo da página, nem a mensagem de um erro.
      const evidencias = {};
      for (const field of needs) {
        declaredCount[field] = Array.isArray(declared[field]) ? declared[field].length : 0;
        const citadas = (Array.isArray(declared[field]) ? declared[field] : []).map((url) => resolution.safeSourceUrl(url)).filter(Boolean).slice(0, resolution.MAX_SOURCES_PER_FIELD);
        if (citadas.length > 0) evidencias[field] = { citadas, tentativas: [] };
      }
      if (raw && enrichment && !interrupted && fetchPage !== null) {
        const siteUrl = profile.siteOficial && profile.siteOficial.status === 'ENCONTRADO' ? profile.siteOficial.url : null;
        const ctx = {
          company: nome,
          officialOrigin: siteUrl ? digital.normalizeToOrigin(siteUrl) : null,
          knownUrls: [siteUrl, ...Object.values(canais), ...[...(profile.fontesValidacao || []), ...(profile.fontesDescoberta || [])].map((source) => source && source.url)].filter((url) => typeof url === 'string'),
        };
        const candidates = needs.filter((field) => field !== 'trafegoPago' && !returned.has(field) && (!obtained.has(field) || field === 'presencaDigital') && declaredCount[field] > 0);
        let exhausted = false;
        for (const field of candidates) {
          for (const url of declared[field].filter((entry) => typeof entry === 'string').slice(0, maxReadsPerField)) {
            const shown = resolution.safeSourceUrl(url);
            if (!shown) {
              // URL insegura (não https, com credencial) nunca é lida
              rejected[field] = resolution.REASON.FONTES_NAO_CONFIRMADAS;
              continue;
            }
            if (!cache.has(url)) {
              if (record.verificacao.leituras >= maxVerificationReads) {
                exhausted = true;
                rejected[field] = resolution.REASON.LIMITE_DE_LEITURAS;
                if (shown && evidencias[field]) evidencias[field].tentativas.push({ url: shown, leitura: 'NAO_TENTADA', causa: resolution.REASON.LIMITE_DE_LEITURAS });
                break;
              }
              record.verificacao.leituras += 1;
            }
            const page = await fetchCached(url);
            const outcome = resolution.readOutcome(page);
            let verdict;
            try {
              verdict = resolution.assessSource(field, page, url, ctx);
            } catch {
              verdict = { ok: false, motivo: resolution.REASON.ERRO_NA_AVALIACAO };
            }
            if (evidencias[field]) evidencias[field].tentativas.push({ url: shown, ...outcome, ...(outcome.leitura === 'OK' ? { pertinencia: verdict.pertinente ? (verdict.encontrado ? 'DADO_NA_PAGINA_OFICIAL' : 'PERTINENTE') : verdict.motivo, ...(verdict.testes ? { testes: verdict.testes } : {}), ...(Number.isInteger(verdict.candidatos) ? { candidatos: verdict.candidatos } : {}) } : {}) });
            if (!verdict.ok) {
              rejected[field] = verdict.motivo;
              continue;
            }
            delete rejected[field];
            if (verdict.encontrado) fromPages[field] = verdict; // a página OFICIAL lida traz o dado: ele entra por código (nunca vira "não encontrado")
            else verified[field] = [shown]; // a fonte REGISTRADA é a URL reduzida (sem consulta nem âncora)
            break;
          }
        }
        record.verificacao.encerramento = candidates.length === 0 ? 'NENHUMA_LEITURA_NECESSARIA' : exhausted ? 'ORCAMENTO_ESGOTADO' : candidates.every((field) => verified[field] || fromPages[field]) ? 'CAMPOS_RESOLVIDOS' : 'FONTES_ESGOTADAS';
      }
      // dados que a própria página oficial lida trouxe para um campo que o motor deixou de fora: mesclados como a revisão do site faz (mesmas regras de extração)
      if (Object.keys(fromPages).length > 0) {
        const patch = {};
        for (const [field, verdict] of Object.entries(fromPages)) patch[field] = verdict.encontrado[field];
        enrichment = { ...enrichment, ...patch, origens: [...(enrichment.origens || []), ...[...new Set(Object.values(fromPages).map((verdict) => verdict.origem))].map((url) => ({ url, tipo: digital.SOURCE_TYPE.OFICIAL }))] };
        obtained = commercial.enrichmentObtained(enrichment);
      }

      run.etapa = 'SALVANDO';
      const discarded = [...returned].filter((field) => !obtained.has(field)).map((campo) => ({ campo, motivo: campo === 'responsavel' && pendingSources.size > 0 ? 'VINCULO_COM_A_EMPRESA_NAO_COMPROVADO' : DISCARD_REASON[campo] || resolution.REASON.DESCARTADO_NA_VALIDACAO }));
      const merged = enrichment ? commercial.applyEnrichment(profile, enrichment, { today: today() }) : profile;
      const adsNow = enrichment && isPlainObject(enrichment.ads) ? Object.values(enrichment.ads).filter((entry) => entry && entry.status !== 'NAO_VERIFICADO') : [];
      const adsOnlyNone = adsNow.length > 0 && adsNow.every((entry) => entry.status === 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA');
      const adsSources = adsNow.map((entry) => entry.origem && entry.origem.url).filter(Boolean);
      const fields = resolution.resolveFields({
        requested: needs,
        obtained,
        returned,
        discarded,
        verified,
        declared: declaredCount,
        rejected,
        evidencias,
        residual: new Set(commercial.enrichmentNeeds(merged)),
        interrupted,
        answered: Boolean(raw),
        adsOnlyNone,
        adsSources,
        canVerifyPages: fetchPage !== null,
      });

      record.camposRetornados = [...returned];
      record.camposDescartados = discarded;
      record.camposObtidos = needs.filter((field) => obtained.has(field));
      const accumulated = (Array.isArray(merged.fontesEnriquecimento) ? merged.fontesEnriquecimento : []).map((source) => source && source.url).filter(Boolean);
      record.fontes = accumulated.slice(0, 20);
      record.fontesNovas = accumulated.filter((url) => !knownBefore.has(url)).slice(0, 20);

      // COMPLETO só com TODOS os campos pedidos resolvidos; senão INCOMPLETO, com os não resolvidos como pendentes (NAO_VERIFICADO) e os verificados à parte
      // um responsável JÁ gravado como pendente (ou sem vínculo demonstrado) NUNCA é dado como ausente porque esta pesquisa não achou outro: o campo segue NAO_VERIFICADO/pendente e pesquisável
      if (fields.responsavel && ['PENDENTE', 'NAO_DEMONSTRADO'].includes(commercial.responsibleLinkState(merged))) fields.responsavel = resolution.holdPendingResponsible(fields.responsavel);
      // campos que dependem de um pré-requisito ausente (atividade recente sem canal oficial confirmado) ficam BLOQUEADOS: não foram pedidos ao motor, não estão resolvidos e não são "inexistentes"
      for (const field of resolution.blockedFields(merged, commercial.enrichmentNeeds(merged))) fields[field] = resolution.blockedEntry(field);
      const unresolvedAll = resolution.unresolved(fields);
      const open = unresolvedAll.filter((field) => !fields[field].bloqueio);
      const status = unresolvedAll.length === 0 ? 'COMPLETO' : 'INCOMPLETO';
      const motivo = !raw ? 'SEM_RESPOSTA_PARA_O_LEAD' : hitLimit && open.length > 0 ? 'MAX_TURNS' : open.length > 0 ? 'VERIFICACAO_INSUFICIENTE' : unresolvedAll.length > 0 ? 'BLOQUEADO_POR_PRE_REQUISITO' : null;
      finish(merged, status, {
        resolucao: fields,
        limiteDeTurnos: hitLimit,
        encerramento: hitLimit ? 'LIMITE_DE_TURNOS' : !raw ? 'SEM_RESPOSTA_PARA_O_LEAD' : 'CONCLUIDA',
        ...(motivo ? { motivo, mensagem: MESSAGES[motivo] } : {}),
      });
    } catch {
      try {
        failed(profile, 'ERRO_INTERNO', MESSAGES.ERRO_INTERNO);
      } catch {
        // não foi possível nem registrar a falha: o estado fica como estava (EM_ANDAMENTO no arquivo vira INTERROMPIDO na próxima leitura)
      }
    }
  }

  async function start(context, prospectId) {
    authorize(context);
    const id = requireProspectId(prospectId);
    const item = loadItem(id);
    guardStart(id, item);
    const profile = profileFor(id, item);
    const needs = fieldsToSearch(profile);
    if (needs.length === 0) {
      const shown = view(id, profile, item);
      return { ...shown, mensagem: shown.camposBloqueados.length > 0 ? `Nada a pesquisar agora. ${MESSAGES.BLOQUEADO_POR_PRE_REQUISITO}` : 'Nada a pesquisar: todos os campos estão encontrados ou verificados.' };
    }

    const run = { iniciadoEm: now().toISOString(), startMs: now().getTime(), etapa: 'PREPARANDO', camposSolicitados: needs, promise: null };
    const previousInfo = isPlainObject(profile.enriquecimento) ? profile.enriquecimento : {};
    // COMPATIBILIDADE: o estado geral de um registro ANTIGO (3.0 / 3.0.1 / anterior ao resultado por campo) é sobrescrito por esta execução; antes disso, a origem LEGADO dele é preservada à parte.
    // O histórico real das execuções (`execucoes`) nunca é reescrito nem ganha execuções inventadas.
    run.legado = resolution.legacyOrigin(previousInfo, run.iniciadoEm);
    runs.set(id, run);
    try {
      persist(id, profile, { ...previousInfo, ...(run.legado ? { legado: run.legado } : {}), status: 'EM_ANDAMENTO', iniciadoEm: run.iniciadoEm, camposSolicitados: needs, camposPendentes: needs, limiteDeTurnos: false });
    } catch {
      runs.delete(id);
      throw new Error('Não foi possível gravar o perfil.');
    }
    run.promise = Promise.resolve()
      .then(() => execute(id, run, profile, item, needs))
      .finally(() => runs.delete(id));
    return view(id, profile, item);
  }

  // As travas de TODA pesquisa: Claude disponível, lead fora de DNC, e UMA pesquisa por vez no processo (sem lote, sem paralelo).
  function guardStart(id, item) {
    if (enrichmentEngine === null) throw new LeadEnrichmentError(ERROR.UNAVAILABLE, MESSAGES.SPAWN_FAILED);
    if (item.estado === 'DNC') throw new LeadEnrichmentError(ERROR.NOT_ALLOWED, MESSAGES.DNC);
    if (runs.has(id)) throw new LeadEnrichmentError(ERROR.ALREADY_RUNNING, 'Já existe uma pesquisa em andamento para este lead.');
    if (runs.size > 0) throw new LeadEnrichmentError(ERROR.BUSY, MESSAGES.BUSY);
  }

  // ---- REVER SITE OFICIAL ----
  // as evidências de UM domínio, compactas, para o humano comparar: comprovado ou não, por quê (regra/vínculos), o título da página e o motivo da falha
  const evidence = (check, url) => ({ url: check.origin || url, comprovado: Boolean(check.ok), motivo: check.motivo || null, titulo: check.titulo || null, vinculo: check.ok ? (check.verdict && check.verdict.vinculos) || null : check.vinculo || null, regra: check.ok && check.verdict ? check.verdict.regra || null : null });
  const sameOrigin = (a, b) => Boolean(a) && Boolean(b) && digital.normalizeToOrigin(a) === digital.normalizeToOrigin(b);

  async function executeSiteReview(id, run, profile, item) {
    const startedAt = now().getTime();
    const record = { iniciadoEm: run.iniciadoEm, concluidoEm: null, duracaoMs: 0, custoUsd: null, webSearchRequests: null, turnos: null, resultado: null, motivo: null, mensagem: null, siteAtual: null, siteCandidato: null, siteFinal: null, siteAnterior: null, alternativo: null, vinculo: null, fontes: [] };
    const previous = isPlainObject(profile.revisaoSite) && Array.isArray(profile.revisaoSite.historico) ? profile.revisaoSite.historico : [];
    const finish = (profileFinal, status, resultado, extra = {}) => {
      record.concluidoEm = now().toISOString();
      record.duracaoMs = Math.max(0, now().getTime() - startedAt);
      record.resultado = resultado;
      Object.assign(record, extra);
      profileRepository.save(id, { ...profileFinal, revisaoSite: { status, ultimaRevisao: { ...record }, historico: [...previous, { ...record }].slice(-MAX_EXECUTIONS) } });
    };
    try {
      const snapshot = isPlainObject(item.discoverySnapshot) ? item.discoverySnapshot : {};
      const contexto = isPlainObject(profile.contexto) ? profile.contexto : {};
      const cidade = contexto.cidade || snapshot.cidade || '';
      const uf = contexto.uf || snapshot.estadoUf || '';
      const nicho = contexto.nicho || snapshot.nicho || '';
      const nome = typeof profile.empresa === 'string' && profile.empresa !== '' ? profile.empresa : item.empresa;
      const current = profile.siteOficial && profile.siteOficial.status === 'ENCONTRADO' && profile.siteOficial.url ? profile.siteOficial.url : null;
      record.siteAtual = current;
      const canais = Object.fromEntries(digital.confirmedChannels(profile.presencaDigital).map(({ canal, url }) => [canal, url]));

      run.etapa = 'PESQUISANDO';
      let found;
      try {
        found = await enrichmentEngine.enrich({
          leads: [{ nome, cidade, ...(uf ? { uf } : {}), site: current, canais, fontes: [...(profile.fontesValidacao || []), ...(profile.fontesDescoberta || [])].map((source) => source && source.url).filter(Boolean).slice(0, 3), precisa: ['siteOficial'], revisarSite: true }],
          timeoutMs,
        });
      } catch {
        found = null;
      }
      if (found && typeof found.custoUsd === 'number') record.custoUsd = found.custoUsd;
      if (found && Number.isInteger(found.webSearchRequests)) record.webSearchRequests = found.webSearchRequests;
      if (found && Number.isInteger(found.turnos)) record.turnos = found.turnos;
      if (!found || found.ok !== true || !Array.isArray(found.resultados)) {
        const code = found && typeof found.code === 'string' ? found.code : 'ERRO_INTERNO';
        finish(profile, 'FALHOU', 'FALHOU', { motivo: code, mensagem: MESSAGES[code] || MESSAGES.ERRO_INTERNO, siteFinal: current });
        return;
      }

      run.etapa = 'VALIDANDO';
      const answered = found.resultados.find((entry) => entry && entry.nome === nome) || null;
      const enrichment = answered ? commercial.normalizeEnrichment({ nome, siteOficial: answered.siteOficial }, { today: today() }) : null;
      const candidate = enrichment && enrichment.siteSugerido ? enrichment.siteSugerido : null;
      record.siteCandidato = candidate;

      const fetchPage = createFetchPage ? createFetchPage() : null;
      const verify = async (url) => {
        if (fetchPage === null || !url) return { ok: false, motivo: 'SEM_LEITURA_DE_PAGINA' };
        let page;
        try {
          page = await fetchPage(url);
        } catch {
          page = null;
        }
        if (!page || page.ok !== true || typeof page.texto !== 'string') return { ok: false, motivo: 'PAGINA_INACESSIVEL', origin: digital.normalizeToOrigin(url) };
        const origin = digital.normalizeToOrigin(typeof page.urlFinal === 'string' ? page.urlFinal : url);
        const titulo = typeof page.identidade === 'string' ? page.identidade.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
        const verdict = origin ? verifyOfficialSite(page.texto, { nome, url: origin, identidade: page.identidade, nicho, cidade, uf }) : { status: 'NAO_VERIFICADO', motivo: 'URL_INVALIDA' };
        if (verdict.status !== 'VALIDADO') return { ok: false, motivo: verdict.motivo || 'VINCULO_NAO_CONFIRMADO', origin, titulo, vinculo: verdict.vinculos || null };
        return { ok: true, origin, titulo, verdict, fromPage: commercial.enrichmentFromOfficialPage({ texto: page.texto, links: page.links, origem: origin, identidade: page.identidade }) };
      };
      const currentCheck = current ? await verify(current) : { ok: false, motivo: 'SEM_SITE' };
      const sameAsCurrent = candidate && sameOrigin(candidate, current);
      const candidateCheck = candidate && !sameAsCurrent ? await verify(candidate) : null;
      const sources = [];
      if (current) sources.push(current);
      if (candidate && !sameAsCurrent) sources.push(candidate);

      run.etapa = 'SALVANDO';
      let resultado;
      let verified = null; // a verificação cujas informações podem COMPLETAR o perfil (só preenche o que falta)
      let base = profile;
      const extra = {};
      let proposal = null;
      // um domínio comprovado DIFERENTE do registrado NUNCA o substitui sozinho: vira uma PROPOSTA PENDENTE (o site atual fica) e só uma decisão humana troca
      const makeProposal = () => ({
        status: 'PENDENTE',
        criadaEm: now().toISOString(),
        dominioAtual: current,
        dominioNovo: candidateCheck.origin,
        atualSustentado: currentCheck.ok,
        evidencias: { atual: evidence(currentCheck, current), novo: evidence(candidateCheck, candidateCheck.origin) },
        fontes: [...new Set([current, candidateCheck.origin])],
        dadosDoNovo: { telefones: candidateCheck.fromPage.telefones, whatsapps: candidateCheck.fromPage.whatsapps, emails: candidateCheck.fromPage.emails, endereco: candidateCheck.fromPage.endereco, responsavel: candidateCheck.fromPage.responsavel, presencaConfirmada: candidateCheck.fromPage.presencaConfirmada },
      });
      if (current && currentCheck.ok && candidateCheck && candidateCheck.ok) {
        resultado = 'PROPOSTA_PENDENTE'; // dois domínios comprovados: o confirmado fica; a escolha é humana
        verified = currentCheck;
        proposal = makeProposal();
        extra.alternativo = candidateCheck.origin;
        extra.vinculo = currentCheck.verdict.vinculos || null;
        extra.mensagem = 'Foi comprovado um segundo domínio vinculado à empresa. O site atual foi mantido; a alteração aguarda a confirmação de um usuário autorizado.';
      } else if (current && currentCheck.ok) {
        resultado = 'CONFIRMADO';
        verified = currentCheck;
        extra.vinculo = currentCheck.verdict.vinculos || null;
        extra.mensagem = 'O vínculo do site atual com a empresa foi reconfirmado.';
      } else if (current && candidateCheck && candidateCheck.ok) {
        resultado = 'PROPOSTA_PENDENTE'; // o site confirmado não se sustentou agora e outro foi comprovado: mesmo assim NÃO troca sozinho
        proposal = makeProposal();
        extra.alternativo = candidateCheck.origin;
        extra.mensagem = 'O site atual não pôde ser reconfirmado e outro domínio foi comprovado. O site atual foi mantido; a alteração aguarda a confirmação de um usuário autorizado.';
      } else if (!current && candidateCheck && candidateCheck.ok) {
        resultado = 'ENCONTRADO';
        verified = candidateCheck;
        extra.vinculo = candidateCheck.verdict.vinculos || null;
        extra.mensagem = 'Um site oficial foi comprovado e adicionado ao perfil.';
      } else {
        resultado = 'SEM_COMPROVACAO';
        extra.motivo = (candidateCheck && candidateCheck.motivo) || currentCheck.motivo || (candidate ? 'VINCULO_NAO_CONFIRMADO' : 'NENHUM_SITE_ENCONTRADO');
        extra.mensagem = current ? 'Não houve comprovação suficiente para alterar: o site confirmado foi mantido.' : 'Nenhum site oficial pôde ser comprovado.';
      }
      extra.siteFinal = base.siteOficial && base.siteOficial.status === 'ENCONTRADO' ? base.siteOficial.url : null;
      let merged = base;
      if (verified) {
        const pieces = { ...verified.fromPage, origens: [{ url: verified.origin, tipo: digital.SOURCE_TYPE.OFICIAL }] };
        merged = commercial.applyEnrichment(base, pieces, { today: today() });
      }
      if (proposal !== null) {
        // uma proposta pendente anterior para OUTRO domínio é substituída (registrada); a mesma é só atualizada
        const earlier = isPlainObject(profile.propostaSite) && profile.propostaSite.status === 'PENDENTE' ? profile.propostaSite : null;
        const log = Array.isArray(profile.decisoesSite) ? profile.decisoesSite : [];
        merged = { ...merged, propostaSite: proposal, decisoesSite: earlier && earlier.dominioNovo !== proposal.dominioNovo ? [...log, { decisao: 'SUBSTITUIDA', usuario: null, data: now().toISOString(), dominioAnterior: earlier.dominioAtual, dominioNovo: earlier.dominioNovo, fontes: earlier.fontes || [], propostaCriadaEm: earlier.criadaEm }].slice(-MAX_DECISIONS) : log };
      }
      extra.fontes = [...new Set([...sources, ...(verified ? [verified.origin] : [])])].slice(0, 10);
      finish(merged, 'CONCLUIDA', resultado, extra);
    } catch {
      try {
        finish(profile, 'FALHOU', 'FALHOU', { motivo: 'ERRO_INTERNO', mensagem: MESSAGES.ERRO_INTERNO, siteFinal: profile.siteOficial && profile.siteOficial.url ? profile.siteOficial.url : null });
      } catch {
        // sem como registrar: na próxima leitura o estado em andamento vira INTERROMPIDO
      }
    }
  }

  // A DECISÃO HUMANA sobre a proposta: CONFIRMAR (troca o domínio) ou MANTER (descarta a proposta). SEM nova pesquisa, SEM Claude, SEM leitura de página — usa só as evidências já registradas.
  // Síncrona de ponta a ponta (nenhum await entre ler e gravar): duas confirmações seguidas não se atropelam — a 2ª encontra a proposta já decidida e é recusada (ENRICH_NO_PROPOSAL), sem duplicar
  // nem registrar de novo. Não toca na Approval Queue, no CRM, no DNC nem no estado comercial do lead.
  async function decideSiteProposal(context, prospectId, decision) {
    const reviewer = authorize(context);
    const id = requireProspectId(prospectId);
    if (decision !== 'CONFIRMAR' && decision !== 'MANTER') throw new LeadEnrichmentError(ERROR.INVALID_INPUT, 'decisao deve ser CONFIRMAR ou MANTER');
    const item = loadItem(id);
    if (runs.has(id)) throw new LeadEnrichmentError(ERROR.ALREADY_RUNNING, 'Há uma pesquisa em andamento para este lead: aguarde terminar antes de decidir.');
    const profile = loadProfile(id);
    const proposal = profile && isPlainObject(profile.propostaSite) && profile.propostaSite.status === 'PENDENTE' ? profile.propostaSite : null;
    if (proposal === null) throw new LeadEnrichmentError(ERROR.NO_PROPOSAL, 'Não há proposta de novo site oficial pendente para este lead.');
    const entry = {
      decisao: decision === 'CONFIRMAR' ? 'CONFIRMADA' : 'MANTIDA',
      usuario: reviewer,
      data: now().toISOString(),
      dominioAnterior: proposal.dominioAtual,
      dominioNovo: proposal.dominioNovo,
      fontes: proposal.fontes || [],
      propostaCriadaEm: proposal.criadaEm,
      evidencias: proposal.evidencias,
    };
    let next = { ...profile, propostaSite: null, decisoesSite: [...(Array.isArray(profile.decisoesSite) ? profile.decisoesSite : []), entry].slice(-MAX_DECISIONS) };
    if (decision === 'CONFIRMAR') {
      next = { ...next, siteOficial: { status: 'ENCONTRADO', url: proposal.dominioNovo } };
      // só COMPLETA o que faltava com o que a página do novo domínio já mostrou na revisão (nenhuma leitura nova)
      next = commercial.applyEnrichment(next, { ...(proposal.dadosDoNovo || {}), origens: [{ url: proposal.dominioNovo, tipo: digital.SOURCE_TYPE.OFICIAL }] }, { today: today() });
    }
    profileRepository.save(id, next);
    return view(id, next, item);
  }

  async function reviewSite(context, prospectId) {
    authorize(context);
    const id = requireProspectId(prospectId);
    const item = loadItem(id);
    guardStart(id, item);
    const profile = profileFor(id, item);
    const run = { tipo: 'REVISAO_SITE', iniciadoEm: now().toISOString(), startMs: now().getTime(), etapa: 'PREPARANDO', camposSolicitados: ['siteOficial'], promise: null };
    runs.set(id, run);
    try {
      profileRepository.save(id, { ...profile, revisaoSite: { ...(isPlainObject(profile.revisaoSite) ? profile.revisaoSite : {}), status: 'EM_ANDAMENTO', iniciadoEm: run.iniciadoEm } });
    } catch {
      runs.delete(id);
      throw new Error('Não foi possível gravar o perfil.');
    }
    run.promise = Promise.resolve()
      .then(() => executeSiteReview(id, run, profile, item))
      .finally(() => runs.delete(id));
    return view(id, profile, item);
  }

  async function waitFor(prospectId) {
    const run = runs.get(prospectId);
    if (run) await run.promise;
  }

  return Object.freeze({ start, reviewSite, decideSiteProposal, getStatus, waitFor });
}

module.exports = { createLeadEnrichmentService, LeadEnrichmentError, ENRICH_ERROR: ERROR, ENRICH_MESSAGES: MESSAGES };
