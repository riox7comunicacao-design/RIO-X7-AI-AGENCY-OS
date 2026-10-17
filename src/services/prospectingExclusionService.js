// Prospecting Permanent Exclusion Service (Workbench de Prospecção, Etapa 2) — a fronteira de APLICAÇÃO das
// Exclusões Permanentes.
//
//   ADMIN (Dashboard) -> este Service -> repositório (Supabase em produção, memória em teste)
//   ingestFindings (prospectingBriefService.js) -> este Service (isExcluded) -> repositório
//
// AUTORIZAÇÃO (seção 7 do comando): list/getById/create/update/deactivate/activate exigem MANAGE:PROSPECTING_
// EXCLUSIONS (só ADMIN — src/auth/prospectingExclusionBridge.js). `isExcluded` é a checagem INTERNA que a
// ingestão de achados usa automaticamente — SEM autorização própria (mesmo princípio de hasActiveFunnelCards em
// crmService.js: quem chega até ali já foi autorizado a propor/ingerir achados; isExcluded só responde uma
// pergunta de dado, nunca decide quem pode administrar a lista).
//
// "EXCLUIR" = DESATIVAR (seção 5): nunca um DELETE físico — não existe esse método em nenhuma camada. Histórico
// preservado: reativar uma exclusão nunca perde `criadoEm`/`criadoPor`.
//
// "NÃO ENCONTRADO" != "LIBERADO" (seção 9): isExcluded devolve `false` quando nenhuma exclusão ATIVA bate — isso
// nunca é gravado nem tratado como uma decisão permanente de "liberado"; é reavaliado a cada chamada.

const crypto = require('node:crypto');
const {
  EXCLUSION_MATCH,
  EXCLUSION_VERDICT: VERDICT,
  normalizeCompanyName,
  validateExclusionInput,
  classifyExclusionMatch,
  matchesExclusion,
  hasVerifiableIdentity,
} = require('../research-prospector/permanentExclusion');
const { assertValidPermanentExclusionRepository } = require('../research-prospector/permanentExclusionRepository');
const { PERMISSION } = require('../auth');

class ProspectingExclusionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProspectingExclusionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const ERROR = Object.freeze({
  INVALID_INPUT: 'EXCLUSION_INVALID_INPUT',
  NOT_FOUND: 'EXCLUSION_NOT_FOUND',
  PERSISTENCE: 'EXCLUSION_PERSISTENCE',
});

// O veredito da verificação OBRIGATÓRIA da promoção (verifyCandidate; os valores vêm de EXCLUSION_VERDICT, no domínio) — quatro situações
// que NÃO são equivalentes:
//   CORRESPONDENCIA_CONFIRMADA — há uma exclusão ATIVA que bate com o candidato.
//   AMBIGUA                    — nenhuma confirmada, mas há uma exclusão ativa de mesmo nome que o candidato não permite confirmar
//                                nem descartar (falta a cidade/UF que ela exige).
//   SEM_CORRESPONDENCIA        — a lista INTEIRA foi consultada e nada bate nem é ambíguo.
//   DADOS_INSUFICIENTES        — o candidato não tem um nome verificável; a lista nem é consultada.
// A QUINTA situação — a consulta falhar ou vier incompleta — não é um veredito: é um erro (EXCLUSION_PERSISTENCE).

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
function assertIdentity(identity) {
  if (!isPlainObject(identity) || typeof identity.then === 'function') {
    throw new Error('autorização recusada: o autorizador (Exclusões Permanentes) não devolveu a identidade do usuário');
  }
  const keys = Object.keys(identity);
  if (keys.length !== 3 || !['userId', 'name', 'role'].every((key) => typeof identity[key] === 'string' && identity[key].trim() !== '')) {
    throw new Error('autorização recusada: o autorizador (Exclusões Permanentes) devolveu uma identidade inválida');
  }
  return { userId: identity.userId.trim(), name: identity.name.trim(), role: identity.role.trim() };
}

// dependencies: authorizeOperation(context, MANAGE:PROSPECTING_EXCLUSIONS) — OBRIGATÓRIA; repository — OBRIGATÓRIA;
// now — padrão Date (testes fixam).
function createProspectingExclusionService(dependencies) {
  const { authorizeOperation, repository, now = () => new Date() } = dependencies || {};
  if (typeof authorizeOperation !== 'function') throw new Error('createProspectingExclusionService exige { authorizeOperation } (função)');
  assertValidPermanentExclusionRepository(repository);
  if (typeof now !== 'function') throw new Error('createProspectingExclusionService: now deve ser uma função');

  function authorize(context) {
    return assertIdentity(authorizeOperation(context, PERMISSION.MANAGE_PROSPECTING_EXCLUSIONS));
  }

  async function list(context) {
    authorize(context);
    try {
      return await repository.list();
    } catch {
      throw new ProspectingExclusionError(ERROR.PERSISTENCE, 'Exclusões Permanentes: não foi possível ler a lista.');
    }
  }

  async function requireExclusion(id) {
    if (typeof id !== 'string' || id.trim() === '') throw new ProspectingExclusionError(ERROR.INVALID_INPUT, 'Exclusões Permanentes: identificador inválido.');
    let exclusao;
    try {
      exclusao = await repository.getById(id);
    } catch {
      throw new ProspectingExclusionError(ERROR.PERSISTENCE, 'Exclusões Permanentes: não foi possível ler a exclusão.');
    }
    if (!exclusao) throw new ProspectingExclusionError(ERROR.NOT_FOUND, 'Exclusões Permanentes: exclusão não encontrada.');
    return exclusao;
  }

  async function getById(context, id) {
    authorize(context);
    return requireExclusion(id);
  }

  // Cria — SEMPRE ativa. `created_by_user_id`/`created_by_name` vêm SÓ do autorizador (o cliente nunca os envia —
  // seção 12 do comando).
  async function create(context, input) {
    const operador = authorize(context);
    const checado = validateExclusionInput(input, { partial: false });
    if (!checado.ok) throw new ProspectingExclusionError(ERROR.INVALID_INPUT, 'Exclusões Permanentes: entrada inválida.', { errors: checado.errors });
    const instant = now();
    const exclusao = {
      id: crypto.randomUUID(),
      ...checado.value,
      ativo: true,
      criadoPorUserId: operador.userId,
      criadoPorNome: operador.name,
      criadoEm: instant.toISOString(),
      atualizadoEm: instant.toISOString(),
    };
    try {
      return await repository.insert(exclusao);
    } catch {
      throw new ProspectingExclusionError(ERROR.PERSISTENCE, 'Exclusões Permanentes: não foi possível gravar a exclusão.');
    }
  }

  // Edita campos (empresa/cidade/estado/pais/dominio/motivo) — nunca `ativo` (isso é ativar/desativar, abaixo) e
  // nunca `criadoPor*`/`criadoEm` (histórico preservado).
  async function update(context, id, patch) {
    authorize(context);
    await requireExclusion(id);
    const checado = validateExclusionInput(patch, { partial: true });
    if (!checado.ok) throw new ProspectingExclusionError(ERROR.INVALID_INPUT, 'Exclusões Permanentes: entrada inválida.', { errors: checado.errors });
    const instant = now();
    let atualizado;
    try {
      atualizado = await repository.update(id, { ...checado.value, atualizadoEm: instant.toISOString() });
    } catch {
      throw new ProspectingExclusionError(ERROR.PERSISTENCE, 'Exclusões Permanentes: não foi possível gravar a exclusão.');
    }
    if (!atualizado) throw new ProspectingExclusionError(ERROR.NOT_FOUND, 'Exclusões Permanentes: exclusão não encontrada.');
    return atualizado;
  }

  async function setActive(context, id, ativo) {
    authorize(context);
    await requireExclusion(id);
    const instant = now();
    let atualizado;
    try {
      atualizado = await repository.update(id, { ativo, atualizadoEm: instant.toISOString() });
    } catch {
      throw new ProspectingExclusionError(ERROR.PERSISTENCE, 'Exclusões Permanentes: não foi possível gravar a exclusão.');
    }
    if (!atualizado) throw new ProspectingExclusionError(ERROR.NOT_FOUND, 'Exclusões Permanentes: exclusão não encontrada.');
    return atualizado;
  }

  const deactivate = (context, id) => setActive(context, id, false);
  const activate = (context, id) => setActive(context, id, true);

  // A checagem AUTOMÁTICA (sem autorização própria — ver o cabeçalho). Devolve `false` (nenhuma correspondência
  // ATIVA — "não encontrado" nunca é "liberado", seção 9) ou a EXCLUSÃO que bateu (para o chamador preservar o
  // motivo — seção 8: "preservar a informação de que foi bloqueado").
  async function isExcluded(finding) {
    let todas;
    try {
      todas = await repository.list();
    } catch {
      throw new ProspectingExclusionError(ERROR.PERSISTENCE, 'Exclusões Permanentes: não foi possível consultar a lista.');
    }
    return todas.find((exclusao) => matchesExclusion(finding, exclusao)) || false;
  }

  // A verificação OBRIGATÓRIA da promoção para o CRM (Fase 2B-3.2B). Como isExcluded, é uma checagem INTERNA, sem autorização própria:
  // quem chega até aqui já passou pelas duas autorizações da promoção (APPROVE:LEAD_APPROVAL e WRITE:CRM), e nenhuma rota expõe esta
  // função. Diferente de isExcluded, ela:
  //   - separa os quatro vereditos (VERDICT) em vez de devolver `false` para tudo;
  //   - devolve só os IDS das exclusões que bateram — nunca o motivo, o nome ou o domínio cadastrados;
  //   - FALHA FECHADA: uma lista que não é uma lista, uma linha que não é um objeto, ou uma exclusão ATIVA sem um nome utilizável não
  //     são "nada encontrado": viram EXCLUSION_PERSISTENCE, como uma leitura que falha. Só um repositório que devolve a lista COMPLETA
  //     (o adapter do Supabase garante isso ou lança) pode produzir SEM_CORRESPONDENCIA.
  async function verifyCandidate(candidate) {
    if (!hasVerifiableIdentity(candidate)) return Object.freeze({ resultado: VERDICT.DADOS_INSUFICIENTES, exclusaoIds: [] });
    const unreadable = () => new ProspectingExclusionError(ERROR.PERSISTENCE, 'Exclusões Permanentes: não foi possível consultar a lista.');
    let todas;
    try {
      todas = await repository.list();
    } catch {
      throw unreadable();
    }
    if (!Array.isArray(todas)) throw unreadable();
    const confirmadas = [];
    const ambiguas = [];
    for (const exclusao of todas) {
      if (!isPlainObject(exclusao)) throw unreadable();
      if (exclusao.ativo !== true) continue;
      if (!(exclusao.empresaNomeNormalizado || normalizeCompanyName(exclusao.empresa))) throw unreadable();
      const relacao = classifyExclusionMatch(candidate, exclusao);
      const id = typeof exclusao.id === 'string' ? exclusao.id : null;
      if (relacao === EXCLUSION_MATCH.CORRESPONDENCIA_CONFIRMADA) confirmadas.push(id);
      else if (relacao === EXCLUSION_MATCH.AMBIGUA) ambiguas.push(id);
    }
    if (confirmadas.length > 0) return Object.freeze({ resultado: VERDICT.CORRESPONDENCIA_CONFIRMADA, exclusaoIds: Object.freeze(confirmadas) });
    if (ambiguas.length > 0) return Object.freeze({ resultado: VERDICT.AMBIGUA, exclusaoIds: Object.freeze(ambiguas) });
    return Object.freeze({ resultado: VERDICT.SEM_CORRESPONDENCIA, exclusaoIds: Object.freeze([]) });
  }

  return Object.freeze({ list, getById, create, update, deactivate, activate, isExcluded, verifyCandidate });
}

module.exports = { createProspectingExclusionService, ProspectingExclusionError, ERROR, VERDICT };
