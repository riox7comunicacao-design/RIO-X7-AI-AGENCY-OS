// Identificação do CLIENTE do CRM como Pessoa Física (PF) ou Pessoa Jurídica (PJ) — Fase D2.
//
// Este módulo é PURO (nenhum I/O) e concentra TUDO o que o domínio sabe sobre PF/PJ, CPF e CNPJ:
//   - o vocabulário (TIPO_PESSOA);
//   - a normalização e a validação de CPF (11 dígitos + 2 dígitos verificadores) e de CNPJ (14 caracteres + 2 dígitos
//     verificadores; aceita o CNPJ alfanumérico da Receita Federal, que convive com o numérico);
//   - o nome de exibição do cliente (clientDisplayName);
//   - a regra de coerência da identificação (resolvePersonFields).
//
// O QUE NÃO FAZ: não decide duplicidade nem DO_NOT_CONTACT (isso é do crmDomain.js, que usa os documentos normalizados
// daqui como mais uma chave de identidade), não conhece autorização e não infere NADA: um registro antigo, sem tipo, continua
// sem tipo até uma pessoa definir (nunca se adivinha PF/PJ pelo nome, pelo site ou por um documento).
//
// POR QUE O CAMPO `empresa` NÃO GUARDA O NOME DE UMA PESSOA: `empresa` é a identificação de uma PJ (e o contrato legado de
// 31 campos). O nome de uma PF vai em `nomeCompleto`, e `empresa` pode ficar vazia nela — nunca um nome artificial num campo
// errado. A migration correspondente (20261020090000_crm_client_person_type.sql) libera o NOT NULL de `empresa` e o substitui
// por uma restrição que exige `empresa` para PJ e para registros sem tipo, e `nomeCompleto` para PF.

const TIPO_PESSOA = Object.freeze({ PF: 'PF', PJ: 'PJ' });
const TIPO_PESSOA_VALUES = Object.freeze(Object.values(TIPO_PESSOA));

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

// "123.456.789-09" -> "12345678909"; "12.ABC.345/01DE-35" -> "12ABC34501DE35". Pontos, barras, hífens e espaços saem, as letras
// ficam em maiúsculas. Vazio vira null. NÃO valida: um texto com outros caracteres segue (em maiúsculas) e é recusado por
// isValidCpf/isValidCnpj, com a mensagem de "inválido" — nunca "corrigido" em silêncio.
function normalizeDocument(value) {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(/[.\-/\s]/g, '').toUpperCase();
  return stripped.length === 0 ? null : stripped;
}

const allSame = (text) => text.split('').every((char) => char === text[0]);

function isValidCpf(value) {
  const cpf = normalizeDocument(value);
  if (cpf === null || !/^\d{11}$/.test(cpf) || allSame(cpf)) return false;
  const digits = cpf.split('').map(Number);
  const check = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += digits[i] * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === digits[9] && check(10) === digits[10];
}

// CNPJ: 12 caracteres (0-9 ou A-Z) + 2 dígitos verificadores numéricos. O valor de cada caractere é o código ASCII menos 48
// (dígitos valem 0 a 9, letras valem 17 a 42): para um CNPJ só numérico a conta é exatamente a de sempre.
const CNPJ_WEIGHTS_12 = Object.freeze([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
const CNPJ_WEIGHTS_13 = Object.freeze([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

function cnpjCheckDigit(chars, weights) {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) sum += (chars.charCodeAt(i) - 48) * weights[i];
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function isValidCnpj(value) {
  const cnpj = normalizeDocument(value);
  if (cnpj === null || !/^[0-9A-Z]{12}\d{2}$/.test(cnpj) || allSame(cnpj)) return false;
  const base = cnpj.slice(0, 12);
  const first = cnpjCheckDigit(base, CNPJ_WEIGHTS_12);
  const second = cnpjCheckDigit(base + String(first), CNPJ_WEIGHTS_13);
  return cnpj.slice(12) === `${first}${second}`;
}

// O nome pelo qual o cliente é mostrado: PF -> nomeCompleto; PJ e registros sem tipo -> empresa. Cada um cai no outro quando o
// primeiro falta (um registro antigo convertido para PF mantém a empresa original, que então ainda serve de nome).
function clientDisplayName(record) {
  if (!record || typeof record !== 'object') return null;
  const empresa = isNonEmptyString(record.empresa) ? record.empresa.trim() : null;
  const nomeCompleto = isNonEmptyString(record.nomeCompleto) ? record.nomeCompleto.trim() : null;
  return record.tipoPessoa === TIPO_PESSOA.PF ? nomeCompleto || empresa : empresa || nomeCompleto;
}

// A regra de coerência da identificação, sobre o registro RESULTANTE (na criação, os campos informados; na edição, o registro com
// o que mudou já aplicado). Devolve { tipoPessoa, nomeCompleto, cpf, cnpj } já normalizados (documento só com os caracteres
// válidos, em maiúsculas). Lança uma mensagem com o prefixo "CRM: <contexto>" — o servidor traduz cada uma para uma frase.
// A exigência de `empresa` (PJ e sem tipo) é do chamador: a mensagem dela é a do contrato legado e não muda.
function resolvePersonFields(record, context) {
  const tipoPessoa = record.tipoPessoa === undefined ? null : record.tipoPessoa;
  if (tipoPessoa !== null && !TIPO_PESSOA_VALUES.includes(tipoPessoa)) {
    throw new Error(`CRM: ${context} — campo "tipoPessoa" deve ser "PF" ou "PJ"`);
  }
  const nomeCompleto = isNonEmptyString(record.nomeCompleto) ? record.nomeCompleto.trim() : null;
  const cpf = normalizeDocument(record.cpf);
  const cnpj = normalizeDocument(record.cnpj);

  if (tipoPessoa === null && (nomeCompleto !== null || cpf !== null || cnpj !== null)) {
    throw new Error(`CRM: ${context} — defina o tipo de pessoa (PF ou PJ) para informar nome completo, CPF ou CNPJ`);
  }
  if (tipoPessoa === TIPO_PESSOA.PF) {
    if (nomeCompleto === null) throw new Error(`CRM: ${context} exige "nomeCompleto" para Pessoa Física`);
    if (cnpj !== null) throw new Error(`CRM: ${context} — CNPJ só se aplica a Pessoa Jurídica`);
  }
  if (tipoPessoa === TIPO_PESSOA.PJ) {
    if (nomeCompleto !== null) throw new Error(`CRM: ${context} — nomeCompleto só se aplica a Pessoa Física`);
    if (cpf !== null) throw new Error(`CRM: ${context} — CPF só se aplica a Pessoa Física`);
  }
  if (cpf !== null && !isValidCpf(cpf)) throw new Error(`CRM: ${context} — CPF inválido`);
  if (cnpj !== null && !isValidCnpj(cnpj)) throw new Error(`CRM: ${context} — CNPJ inválido`);
  return { tipoPessoa, nomeCompleto, cpf, cnpj };
}

module.exports = { TIPO_PESSOA, TIPO_PESSOA_VALUES, normalizeDocument, isValidCpf, isValidCnpj, clientDisplayName, resolvePersonFields };
