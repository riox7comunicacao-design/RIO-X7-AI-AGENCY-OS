const { createCandidate } = require('./candidate');
const { checkDuplicate } = require('./duplicateCheck');
const { checkDoNotContact } = require('./doNotContact');
const { VALIDATION_STATUS } = require('./constants');

// Pipeline conceitual de docs/decisions/0003-research-prospector-module.md:
// INPUT → RESEARCH → NORMALIZATION → DUPLICATE CHECK → VALIDATION → OUTPUT
//
// Este pipeline não pesquisa nada de verdade e não escreve em nenhum
// sistema externo — é a estrutura técnica local descrita no Passo 1.0.
// `existingRecords` simula uma leitura já feita do CRM (nunca uma escrita).

// Etapa 1 — INPUT: valida o formato mínimo e constrói o modelo de dados.
function input(rawInput) {
  return createCandidate(rawInput);
}

// Etapa 2 — RESEARCH: placeholder. Nesta etapa técnica não há pesquisa
// pública real (Passo 1.0 é só estrutura) — a função existe para que uma
// implementação futura substitua este ponto por buscas reais, sem alterar
// o resto do pipeline. Nunca inventa nem completa dado nenhum sozinha.
function research(candidate) {
  return candidate;
}

// Etapa 3 — NORMALIZATION: por enquanto não há transformação adicional
// sobre os dados exibidos (a normalização de comparação vive em normalize.js
// e é usada internamente pela etapa de duplicidade, sem alterar o candidato).
function normalization(candidate) {
  return candidate;
}

// Etapa 4 — DUPLICATE CHECK: aplica a regra oficial de deduplicação e a
// proteção de DO NOT CONTACT contra os registros já existentes informados.
function duplicateCheckStage(candidate, existingRecords) {
  const duplicidade = checkDuplicate(candidate, existingRecords);
  const dnc = checkDoNotContact(candidate, existingRecords);

  return {
    ...candidate,
    duplicidade,
    doNotContact: dnc.doNotContact,
    bloqueadoParaContato: dnc.doNotContact,
  };
}

// Etapa 5 — VALIDATION: confere invariantes antes da saída. Nunca marca o
// candidato como revisado por humano — isso só acontece fora deste módulo.
function validation(candidate) {
  if (!candidate.empresa) {
    throw new Error('candidato inválido: empresa ausente após o pipeline');
  }
  if (candidate.statusValidacao !== VALIDATION_STATUS.NAO_REVISADO) {
    throw new Error('candidato inválido: statusValidacao só pode ser definido por revisão humana externa');
  }
  return candidate;
}

// Etapa 6 — OUTPUT: estrutura final, serializável em JSON, pronta para
// revisão humana. Nunca escreve em Notion, CRM ou qualquer sistema externo.
function output(candidate) {
  return { ...candidate };
}

function runPipeline(rawInput, existingRecords = []) {
  let candidate = input(rawInput);
  candidate = research(candidate);
  candidate = normalization(candidate);
  candidate = duplicateCheckStage(candidate, existingRecords);
  candidate = validation(candidate);
  return output(candidate);
}

module.exports = {
  runPipeline,
  input,
  research,
  normalization,
  duplicateCheckStage,
  validation,
  output,
};
