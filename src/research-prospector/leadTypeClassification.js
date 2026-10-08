// Classificação do TIPO DE LEAD (Implementação 3.0 — Prospecção Comercial). Resolve o problema de um briefing pedir
// "Clínicas de estética" e o motor trazer profissionais individuais: o sistema agora identifica, por EVIDÊNCIA pública
// e nunca por suposição, se um candidato é uma EMPRESA, um PROFISSIONAL individual ou a UNIDADE_FRANQUIA de uma rede.
// Módulo PURO: só texto — sem rede, sem banco, sem LLM, sem relógio.
//
// tipoLead NÃO é um score, nota, ranking ou temperatura comercial — é só uma IDENTIFICAÇÃO de tipo. PROFISSIONAL não é
// um lead ruim: a decisão comercial continua sendo humana (quem usa este módulo nunca rejeita automaticamente por isto).
//
// NUNCA classifica só "pelo nome" isoladamente quando o nome não traz um sinal claro e fechado (um termo empresarial, um
// sufixo jurídico, um marcador de unidade, ou o formato de um nome de pessoa com título/profissão): nome, título da
// página, H1 e descrição institucional (tudo já lido por quem chama — este módulo nunca busca nada) entram como
// evidência. Sem evidência suficiente, ou com evidências que se CONTRADIZEM (ex.: termo empresarial e título de pessoa
// ao mesmo tempo), o resultado é NAO_VERIFICADO — nunca um palpite.
//
// Prioridade das evidências (a mais específica primeiro): indicação de franquia/unidade > termo empresarial > padrão de
// nome de pessoa > NAO_VERIFICADO.

// Dependência só de normalize.js (folha, sem requires próprios): pageVerification/digitalPresence/researchPolicy formam um ciclo entre si
// (digitalPresence -> researchPolicy -> rawFindingSchema -> discovery) — como discovery.js e rawFindingSchema.js PRECISAM desta classificação,
// importar qualquer um daqueles aqui recriaria o ciclo. O vocabulário empresarial abaixo é, por isso, PRÓPRIO (fechado e pequeno; não é o
// algoritmo de verificação de nicho de pageVerification.js, só uma lista de palavras com o mesmo propósito declarado nas RULES do briefing).
const { stripAccents } = require('./normalize');

const LEAD_TYPE = Object.freeze({
  EMPRESA: 'EMPRESA',
  PROFISSIONAL: 'PROFISSIONAL',
  UNIDADE_FRANQUIA: 'UNIDADE_FRANQUIA',
  NAO_VERIFICADO: 'NAO_VERIFICADO',
});

const MAX_NAME = 300;
const MAX_TEXT = 20000;

// Termos empresariais do próprio vocabulário do briefing (RULES: "negócio/estabelecimento comercial... clínica, espaço, empresa, estúdio,
// centro, instituto, loja ou negócio local") e sufixos jurídicos comuns — vocabulário fechado e explícito.
const BUSINESS_TERMS = new Set([
  'clinica', 'estetica', 'instituto', 'espaco', 'centro', 'studio', 'estudio', 'spa', 'empresa', 'loja', 'negocio',
  'estabelecimento', 'saude', 'dermatologia', 'odontologia', 'odonto', 'medicina', 'consultorio',
  'ltda', 'me', 'epp', 'eireli', 'sa', 'mei', 'cia',
]);

// Marcadores de UNIDADE/FILIAL no próprio nome ("Clínica XYZ - Unidade Petrópolis"). De propósito SEM "loja": "loja"
// sozinha é só um tipo de estabelecimento (EMPRESA), não prova vínculo com uma rede/franquia.
const UNIT_NAME_MARKERS = Object.freeze(['unidade', 'filial', 'matriz']);

// Indicação EXPLÍCITA de franquia/rede no texto institucional (título/H1/descrição da página oficial) — nunca inferida
// do nome sozinho quando o nome não tem um marcador de unidade.
const FRANCHISE_TEXT_PATTERN = /\bunidade\b[^.\n]{0,40}\b(da rede|franqueada|licenciada)\b|\bfranquia\b|\brede\b[^.\n]{0,40}\bunidade\b/;

const TITLE_PREFIXES = Object.freeze(['dr', 'dra', 'prof', 'profa']);
// Designações de profissão que, junto de um nome (2+ palavras), identificam um PROFISSIONAL — vocabulário fechado.
const PROFESSION_TERMS = Object.freeze([
  'dermatologista', 'advogado', 'advogada', 'medico', 'medica', 'dentista', 'nutricionista', 'nutricionista(a)',
  'psicologo', 'psicologa', 'fisioterapeuta', 'esteticista', 'veterinario', 'veterinaria', 'contador', 'contadora',
  'arquiteto', 'arquiteta', 'engenheiro', 'engenheira', 'cirurgiao', 'cirurgia', 'ortodontista',
]);

function tokens(text, max = MAX_NAME) {
  if (typeof text !== 'string') return [];
  return stripAccents(text.slice(0, max))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Um texto institucional "comparável" (sem acento, minúsculo) para procurar indicação de franquia/termo empresarial —
// nunca para montar evidência textual nova (este módulo não devolve trechos de página, só o tipo e a regra que decidiu).
function comparableText(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .map((part) => stripAccents(part.slice(0, MAX_TEXT)).toLowerCase())
    .join(' \n ');
}

function hasWholeWord(text, word) {
  return new RegExp(`\\b${word}\\b`).test(text);
}

// Dr./Dra./Prof./Profa. + nome (2+ palavras no total), OU nome (2+ palavras) + designação de profissão no final —
// sempre a partir do PRÓPRIO NOME (a evidência mais confiável de que se trata de uma pessoa).
function matchesPersonPattern(nameTokens) {
  if (nameTokens.length < 2) return false;
  if (TITLE_PREFIXES.includes(nameTokens[0]) && nameTokens.length >= 3) return true;
  const last = nameTokens[nameTokens.length - 1];
  return PROFESSION_TERMS.includes(last) && nameTokens.length >= 3;
}

// classifyLeadType({ nome, identidade?, texto? }) -> { tipo, regra }
//   nome       o nome do candidato/empresa (única evidência sempre disponível)
//   identidade título/H1 da página oficial já lida (opcional)
//   texto      o texto visível da página oficial já lida (opcional)
// Nunca lança: entrada inválida ou sem nome -> NAO_VERIFICADO.
function classifyLeadType(input) {
  const { nome, identidade, texto } = input && typeof input === 'object' ? input : {};
  const nameTokens = tokens(nome);
  if (nameTokens.length === 0) return { tipo: LEAD_TYPE.NAO_VERIFICADO, regra: 'SEM_NOME' };

  const institutional = comparableText(identidade, texto);

  const unitInName = nameTokens.some((token, index) => index > 0 && UNIT_NAME_MARKERS.includes(token));
  const franchiseInText = institutional !== '' && FRANCHISE_TEXT_PATTERN.test(institutional);
  const isFranchise = unitInName || franchiseInText;

  const businessInName = nameTokens.some((token) => BUSINESS_TERMS.has(token));
  const businessInText = institutional !== '' && [...BUSINESS_TERMS].some((term) => term.length >= 4 && hasWholeWord(institutional, term));
  const isBusiness = businessInName || businessInText;

  const isPerson = matchesPersonPattern(nameTokens);

  if (isFranchise) return { tipo: LEAD_TYPE.UNIDADE_FRANQUIA, regra: unitInName ? 'NOME_UNIDADE' : 'INDICACAO_FRANQUIA_TEXTO' };
  if (isBusiness && isPerson) return { tipo: LEAD_TYPE.NAO_VERIFICADO, regra: 'CONFLITO_NOME_AMBIGUO' };
  if (isBusiness) return { tipo: LEAD_TYPE.EMPRESA, regra: businessInName ? 'NOME_EMPRESARIAL' : 'TEXTO_INSTITUCIONAL_EMPRESARIAL' };
  if (isPerson) return { tipo: LEAD_TYPE.PROFISSIONAL, regra: 'NOME_PROFISSIONAL' };
  return { tipo: LEAD_TYPE.NAO_VERIFICADO, regra: 'SEM_EVIDENCIA' };
}

module.exports = { LEAD_TYPE, classifyLeadType };
