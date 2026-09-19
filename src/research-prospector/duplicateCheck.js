const { DUPLICATE_STATUS } = require('./constants');
const { identityKeys } = require('./normalize');

// Regra oficial (RIO X7 — Central Comercial), nesta ordem de prioridade:
// 1. domínio do site  2. telefone  3. Instagram  4. nome + cidade
// Ver docs/decisions/0003-research-prospector-module.md, seção 4.
function checkDuplicate(candidate, existingRecords = []) {
  const keys = identityKeys(candidate);
  const hasAnyKey = Boolean(keys.domain || keys.phone || keys.instagram || keys.nameCity);

  if (!hasAnyKey) {
    // Nenhum dos 4 critérios pôde ser verificado — não presumir que é novo.
    return { status: DUPLICATE_STATUS.NAO_VERIFICADO, matchedOn: [], matchedRecord: null };
  }

  for (const existing of existingRecords) {
    const existingKeys = identityKeys(existing);
    const matchedOn = [];
    if (keys.domain && keys.domain === existingKeys.domain) matchedOn.push('dominio');
    if (keys.phone && keys.phone === existingKeys.phone) matchedOn.push('telefone');
    if (keys.instagram && keys.instagram === existingKeys.instagram) matchedOn.push('instagram');

    if (matchedOn.length > 0) {
      return { status: DUPLICATE_STATUS.DUPLICADO, matchedOn, matchedRecord: existing };
    }
  }

  for (const existing of existingRecords) {
    const existingKeys = identityKeys(existing);
    if (keys.nameCity && keys.nameCity === existingKeys.nameCity) {
      return {
        status: DUPLICATE_STATUS.POSSIVEL_DUPLICADO,
        matchedOn: ['nome_cidade'],
        matchedRecord: existing,
      };
    }
  }

  return { status: DUPLICATE_STATUS.NOVO, matchedOn: [], matchedRecord: null };
}

module.exports = { checkDuplicate };
