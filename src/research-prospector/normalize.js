// Normalização usada só para comparação de duplicidade/DO NOT CONTACT.
// Nunca substitui o dado original exibido ao humano — é um valor auxiliar interno.

function normalizeDomain(site) {
  if (!site) return null;
  try {
    const url = site.includes('://') ? site : `https://${site}`;
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

// Normaliza um telefone brasileiro para o "número nacional" (DDD + número),
// removendo o código de país +55 somente quando o comprimento do número deixa
// isso objetivamente claro — nunca por suposição. Um número nacional tem 10
// dígitos (DDD + fixo de 8) ou 11 (DDD + celular de 9); com o "55" na frente,
// o total sobe para 12 ou 13. Fora dessa condição exata, nenhum dígito é
// removido — dois números só empatam quando representam o mesmo número real.
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits.length) return null;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    return digits.slice(2);
  }
  return digits;
}

function normalizeInstagram(instagram) {
  if (!instagram) return null;
  let handle = String(instagram).trim().toLowerCase();
  handle = handle.replace(/^https?:\/\/(www\.)?instagram\.com\//, '');
  handle = handle.replace(/^@/, '');
  handle = handle.replace(/\/+$/, '');
  return handle.length ? handle : null;
}

function stripAccents(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Títulos profissionais reconhecidos no início do nome (lista fixa e curta —
// nunca removida por suposição, só quando isolada como primeiro token).
const NAME_TITLE_PREFIXES = ['dr', 'dra', 'prof', 'profa'];

// Qualificadores profissionais reconhecidos no final do nome (lista fixa,
// ligada ao vocabulário do nicho atual — nunca um sobrenome real é removido).
const NAME_PROFESSIONAL_SUFFIXES = ['psicologa', 'psicologo'];

// Normalização conservadora de nome para comparação de "nome + cidade":
// minúsculas, sem acento, sem pontuação, espaços colapsados, e remoção de
// no máximo um título no início e um qualificador profissional no final —
// nunca fuzzy matching, nunca remoção de sobrenome real.
function baseNameForMatch(name) {
  if (!name) return null;
  let normalized = stripAccents(String(name).toLowerCase());
  normalized = normalized.replace(/[^a-z0-9\s]/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const tokens = normalized.split(' ');

  if (tokens.length > 1 && NAME_TITLE_PREFIXES.includes(tokens[0])) {
    tokens.shift();
  }
  if (tokens.length > 1 && NAME_PROFESSIONAL_SUFFIXES.includes(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  return tokens.join(' ') || null;
}

function normalizeNameCity(empresa, cidade) {
  const nome = baseNameForMatch(empresa);
  const cid = cidade ? stripAccents(String(cidade).toLowerCase()).trim() : null;
  if (!nome || !cid) return null;
  return `${nome}|${cid}`;
}

// Chaves de identidade de um registro (candidato ou existente no CRM),
// na mesma ordem de prioridade da regra oficial (domínio → telefone → Instagram → nome+cidade).
function identityKeys(record) {
  return {
    domain: normalizeDomain(record.site),
    phone: normalizePhone(record.telefone || record.whatsapp),
    instagram: normalizeInstagram(record.instagram),
    nameCity: normalizeNameCity(record.empresa, record.cidade),
  };
}

module.exports = {
  normalizeDomain,
  normalizePhone,
  normalizeInstagram,
  normalizeNameCity,
  identityKeys,
};
