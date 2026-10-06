// Prospecting Brief Service — o WORKBENCH operacional de prospecção (Etapa "Prospecção 1"), a camada ANTES do
// Prospecting Service existente (prospectingService.js).
//
//   Workbench (Dashboard) -> ProspectingBriefService -> [gera o pacote de pesquisa | ingere achados] -> ProspectingService (EXISTENTE)
//
// O QUE FAZ: dá ao usuário um lugar para (1) criar um BRIEF (nicho, subnicho, geografia estruturada, quantidade,
// objetivo) num id amigável (PROS-YYYYMMDD-NNN) e acompanhar seu estado (RASCUNHO -> PRONTO_PARA_PESQUISA ->
// PESQUISANDO -> AGUARDANDO_REVISAO -> CONCLUIDO/CANCELADO); (2) gerar o PACOTE de pesquisa (ResearchProvider) que
// um humano leva ao Claude/Web; (3) ingerir de volta os achados (rawFindings, no formato já existente) chamando o
// Prospecting Service REAL — que já autoriza de novo, valida, deduplica contra CRM/fila, monta os dossiês e cria o
// LOTE de verdade. Este módulo NUNCA duplica essa lógica: ingestFindings só prepara a chamada e repassa o
// resultado, propagando qualquer erro intacto.
//
// O QUE NÃO FAZ: não pesquisa (nenhuma rede, nenhuma chamada de IA — ver researchProvider.js), não aprova, não
// rejeita, não promove para o CRM, não cria um segundo mecanismo de fila/CRM/lote.
//
// AUTORIZAÇÃO — reaproveita EXATAMENTE a mesma porta do Prospecting Service (nenhuma permissão nova):
//   authorizeProposer(context, PROPOSE:LEAD_APPROVAL) -> { userId, name, role }
// ADMIN tem essa permissão; COMMERCIAL_CLOSER não (mesma decisão já vigente para prospectingService.js).
//
// EXCLUSÕES PERMANENTES (implementadas na Etapa 2 — Workbench, ver src/services/prospectingExclusionService.js):
// este Service aceita uma dependência OPCIONAL `checkPermanentExclusion(finding) -> false | exclusão` (síncrona
// ou assíncrona) — mesmo padrão de injeção de hasActiveFunnelCards em crmService.js. Em produção (Supabase
// configurado), quem compõe passa `exclusionService.isExcluded`; SEM ela (REPOSITORY_MODE=file, ou qualquer
// composição que não a injete), NENHUM finding é excluído por esse motivo — nunca bloqueia por omissão, exatamente
// o comportamento de antes da Etapa 2. Um finding para o qual o checker devolve a exclusão correspondente é
// removido ANTES de chegar ao Prospecting Service — nunca pesquisado para contato, nunca promovido, nunca enviado
// à fila — e é preservado (empresa + motivo, nunca apagado em silêncio) em `bloqueiosPermanentes`, com a contagem
// em `excluidosPermanentemente`.
//
// FUNIL DE PROSPECÇÃO OUTBOUND (seção 11) — NÃO IMPLEMENTADO: não existe, no estado atual do sistema, o conceito
// de "o funil padrão de prospecção outbound" (Funis 1/2 são estruturas livres, criadas por um ADMIN, sem nenhum
// funil especial pré-definido). Automatizar CRM -> Card nesse funil exigiria uma decisão de produto (qual funil?
// criado automaticamente, ou escolhido nas configurações?) que este módulo não toma. Hoje, depois que um lead é
// promovido para o CRM (pela Approval Queue já existente), um ADMIN ou COMMERCIAL_CLOSER pode criar o card
// manualmente, no Kanban de Funis (Etapa "Funis 2"), com READ:CRM/PROPOSE:CRM — o caminho já existe; só não é
// automático.

const { validateBriefInput, buildBriefId, summarizeGeografia, BRIEF_STATUS, BRIEF_ID_PATTERN } = require('../research-prospector/prospectingBrief');
const { assertValidBriefRepository } = require('../research-prospector/briefRepository');
const { createManualBriefPackageProvider } = require('../research-prospector/researchProvider');
const { PERMISSION } = require('../auth');

class ProspectingBriefError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProspectingBriefError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const ERROR = Object.freeze({
  INVALID_INPUT: 'BRIEF_INVALID_INPUT',
  NOT_FOUND: 'BRIEF_NOT_FOUND',
  INVALID_STATE: 'BRIEF_INVALID_STATE',
  PERSISTENCE: 'BRIEF_PERSISTENCE',
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const copy = (value) => structuredClone(value);

function assertIdentity(identity) {
  if (!isPlainObject(identity) || typeof identity.then === 'function') {
    throw new Error('autorização recusada: o autorizador (proposta) não devolveu a identidade do usuário');
  }
  const keys = Object.keys(identity);
  if (keys.length !== 3 || !['userId', 'name', 'role'].every((key) => typeof identity[key] === 'string' && identity[key].trim() !== '')) {
    throw new Error('autorização recusada: o autorizador (proposta) devolveu uma identidade inválida');
  }
  return { userId: identity.userId.trim(), name: identity.name.trim(), role: identity.role.trim() };
}

// O briefing no formato JÁ ACEITO por prospectingService.js — nada de novo é ensinado a ele; a geografia
// estruturada vira um resumo textual em `regiao` (ver o cabeçalho de prospectingBrief.js).
function toLegacyBriefing(brief) {
  const briefing = { nicho: brief.nicho, quantidadeDesejada: brief.quantidade, regiao: summarizeGeografia(brief) };
  if (brief.subnicho) briefing.tipo = brief.subnicho;
  if (brief.observacoes) briefing.observacoes = brief.observacoes;
  return briefing;
}

// dependencies:
//   authorizeProposer(context, PROPOSE:LEAD_APPROVAL) — OBRIGATÓRIA (mesma ponte do Prospecting Service)
//   prospectingService — o Service REAL (só usa submitProspecting) — OBRIGATÓRIA
//   repository — a porta de brief (list/getById/save) — OBRIGATÓRIA
//   researchProvider (padrão: o manual, sem rede) — precisa de generateBriefPackage(brief)
//   checkPermanentExclusion (opcional) — (finding) => boolean | Promise<boolean>; padrão: nunca exclui
//   now, newSequenceForDay — padrões reais; testes fixam para determinismo
function createProspectingBriefService(dependencies) {
  const {
    authorizeProposer,
    prospectingService,
    repository,
    researchProvider = createManualBriefPackageProvider(),
    checkPermanentExclusion,
    now = () => new Date(),
  } = dependencies || {};

  if (typeof authorizeProposer !== 'function') throw new Error('createProspectingBriefService exige { authorizeProposer } (função)');
  if (!prospectingService || typeof prospectingService.submitProspecting !== 'function') {
    throw new Error('createProspectingBriefService exige { prospectingService } com submitProspecting()');
  }
  assertValidBriefRepository(repository);
  if (!researchProvider || typeof researchProvider.generateBriefPackage !== 'function') {
    throw new Error('createProspectingBriefService exige { researchProvider } com generateBriefPackage()');
  }
  if (checkPermanentExclusion !== undefined && checkPermanentExclusion !== null && typeof checkPermanentExclusion !== 'function') {
    throw new Error('createProspectingBriefService: checkPermanentExclusion, se informado, deve ser uma função');
  }
  const isPermanentlyExcluded = typeof checkPermanentExclusion === 'function' ? checkPermanentExclusion : () => false;
  if (typeof now !== 'function') throw new Error('createProspectingBriefService: now deve ser uma função');

  function authorize(context) {
    return assertIdentity(authorizeProposer(context, PERMISSION.PROPOSE_LEAD_APPROVAL));
  }

  function loadRepository() {
    try {
      return repository.list();
    } catch {
      throw new ProspectingBriefError(ERROR.PERSISTENCE, 'Prospecção: não foi possível ler os briefs.');
    }
  }

  function requireBrief(id) {
    if (typeof id !== 'string' || !BRIEF_ID_PATTERN.test(id)) throw new ProspectingBriefError(ERROR.INVALID_INPUT, 'Prospecção: identificador de brief inválido.');
    let brief;
    try {
      brief = repository.getById(id);
    } catch {
      throw new ProspectingBriefError(ERROR.PERSISTENCE, 'Prospecção: não foi possível ler os briefs.');
    }
    if (!brief) throw new ProspectingBriefError(ERROR.NOT_FOUND, 'Prospecção: brief não encontrado.');
    return brief;
  }

  function saveBrief(brief) {
    try {
      repository.save(brief);
    } catch {
      throw new ProspectingBriefError(ERROR.PERSISTENCE, 'Prospecção: não foi possível gravar o brief.');
    }
  }

  function requireStatus(brief, allowed) {
    if (!allowed.includes(brief.status)) {
      throw new ProspectingBriefError(ERROR.INVALID_STATE, `Prospecção: esta ação exige o brief em ${allowed.join(' ou ')} (está em ${brief.status}).`);
    }
  }

  function createBrief(context, input) {
    const author = authorize(context);
    const checked = validateBriefInput(input);
    if (!checked.ok) throw new ProspectingBriefError(ERROR.INVALID_INPUT, 'Prospecção: o brief é inválido.', { errors: checked.errors });
    const instant = now();
    const existentes = loadRepository();
    const prefixoDoDia = `PROS-${instant.getUTCFullYear()}${String(instant.getUTCMonth() + 1).padStart(2, '0')}${String(instant.getUTCDate()).padStart(2, '0')}`;
    const doDia = existentes.filter((brief) => brief.id.startsWith(`${prefixoDoDia}-`)).length;
    const id = buildBriefId(instant, doDia + 1);
    const brief = {
      id,
      status: BRIEF_STATUS.RASCUNHO,
      criadoPor: author,
      criadoEm: instant.toISOString(),
      atualizadoEm: instant.toISOString(),
      ...checked.value,
      pacotePesquisa: null,
      pacoteGeradoEm: null,
      loteRealId: null,
      contagens: null,
    };
    saveBrief(brief);
    return copy(brief);
  }

  function listBriefs(context) {
    authorize(context);
    return loadRepository()
      .map(copy)
      .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  }

  function getBrief(context, id) {
    authorize(context);
    return copy(requireBrief(id));
  }

  function markReadyForResearch(context, id) {
    authorize(context);
    const brief = requireBrief(id);
    requireStatus(brief, [BRIEF_STATUS.RASCUNHO]);
    brief.status = BRIEF_STATUS.PRONTO_PARA_PESQUISA;
    brief.atualizadoEm = now().toISOString();
    saveBrief(brief);
    return copy(brief);
  }

  // Gera (ou REGENERA — é idempotente: o mesmo brief pode pedir o pacote de novo) o pacote de pesquisa. Nunca
  // executa nenhuma pesquisa: só monta o pedido estruturado (ver researchProvider.js).
  async function generateResearchPackage(context, id) {
    authorize(context);
    const brief = requireBrief(id);
    requireStatus(brief, [BRIEF_STATUS.PRONTO_PARA_PESQUISA, BRIEF_STATUS.PESQUISANDO]);
    const pacote = await researchProvider.generateBriefPackage(copy(brief));
    const instant = now();
    brief.status = BRIEF_STATUS.PESQUISANDO;
    brief.pacotePesquisa = pacote;
    brief.pacoteGeradoEm = instant.toISOString();
    brief.atualizadoEm = instant.toISOString();
    saveBrief(brief);
    return copy(brief);
  }

  // Ingestão dos achados (rawFindings, no formato já existente): chama o Prospecting Service REAL. Nenhum erro
  // dele é mascarado; o brief só é atualizado em caso de SUCESSO (nada de "meia-ingestão").
  async function ingestFindings(context, id, rawFindings) {
    authorize(context);
    const brief = requireBrief(id);
    requireStatus(brief, [BRIEF_STATUS.PESQUISANDO]);

    const lista = Array.isArray(rawFindings) ? rawFindings : [];
    // Bloqueios permanentes (Etapa 2): nunca "apagados em silêncio" — cada um vira um registro { empresa, motivo }
    // preservado no brief (seção 8 do comando). `isPermanentlyExcluded` devolve `false` (nenhuma correspondência) ou
    // a EXCLUSÃO que bateu (nunca só um booleano) — ver o cabeçalho de prospectingExclusionService.js#isExcluded.
    const bloqueios = [];
    const incluidos = [];
    for (const finding of lista) {
      const correspondencia = await isPermanentlyExcluded(finding);
      if (correspondencia) {
        bloqueios.push({
          empresa: isPlainObject(finding) && typeof finding.empresa === 'string' ? finding.empresa : null,
          motivo: isPlainObject(correspondencia) && typeof correspondencia.motivo === 'string' ? correspondencia.motivo : null,
        });
      } else {
        incluidos.push(finding);
      }
    }

    const resultado = await prospectingService.submitProspecting(context, { briefing: toLegacyBriefing(brief), rawFindings: incluidos });

    const instant = now();
    brief.status = BRIEF_STATUS.AGUARDANDO_REVISAO;
    brief.loteRealId = resultado.loteId;
    brief.contagens = resultado.contagens;
    brief.excluidosPermanentemente = bloqueios.length;
    brief.bloqueiosPermanentes = bloqueios;
    brief.atualizadoEm = instant.toISOString();
    saveBrief(brief);
    return { brief: copy(brief), lote: resultado, excluidosPermanentemente: bloqueios.length, bloqueiosPermanentes: bloqueios };
  }

  function cancelBrief(context, id) {
    authorize(context);
    const brief = requireBrief(id);
    requireStatus(brief, [BRIEF_STATUS.RASCUNHO, BRIEF_STATUS.PRONTO_PARA_PESQUISA, BRIEF_STATUS.PESQUISANDO, BRIEF_STATUS.AGUARDANDO_REVISAO]);
    brief.status = BRIEF_STATUS.CANCELADO;
    brief.atualizadoEm = now().toISOString();
    saveBrief(brief);
    return copy(brief);
  }

  function markConcluded(context, id) {
    authorize(context);
    const brief = requireBrief(id);
    requireStatus(brief, [BRIEF_STATUS.AGUARDANDO_REVISAO]);
    brief.status = BRIEF_STATUS.CONCLUIDO;
    brief.atualizadoEm = now().toISOString();
    saveBrief(brief);
    return copy(brief);
  }

  return Object.freeze({ createBrief, listBriefs, getBrief, markReadyForResearch, generateResearchPackage, ingestFindings, cancelBrief, markConcluded });
}

module.exports = { createProspectingBriefService, ProspectingBriefError, ERROR };
