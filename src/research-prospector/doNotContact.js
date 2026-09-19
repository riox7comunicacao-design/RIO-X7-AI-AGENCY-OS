const { identityKeys } = require('./normalize');

// Proteção local de DO NOT CONTACT (docs/decisions/0003, seção 5 e 6).
// Casa a identidade do candidato contra QUALQUER um dos critérios de
// identidade (domínio, telefone, Instagram ou nome+cidade) — de propósito,
// não só o telefone — para que trocar de canal de contato não seja uma
// forma de contornar a restrição.
function checkDoNotContact(candidate, existingRecords = []) {
  const keys = identityKeys(candidate);

  for (const existing of existingRecords) {
    if (!existing.doNotContact) continue;

    const existingKeys = identityKeys(existing);
    const matched =
      (keys.domain && keys.domain === existingKeys.domain) ||
      (keys.phone && keys.phone === existingKeys.phone) ||
      (keys.instagram && keys.instagram === existingKeys.instagram) ||
      (keys.nameCity && keys.nameCity === existingKeys.nameCity);

    if (matched) {
      return { doNotContact: true, matchedRecord: existing };
    }
  }

  return { doNotContact: false, matchedRecord: null };
}

module.exports = { checkDoNotContact };
