// Funções PURAS de apresentação compartilhadas pelas telas do Dashboard (Aprovações, CRM, Visão Geral).
//
// Nada aqui toca o DOM, a rede ou o servidor: recebem um valor de dado — NÃO CONFIÁVEL: vem de pesquisa na web, de
// digitação humana e, no futuro, de IA — e devolvem texto simples ou uma URL segura. Foram extraídas de
// views/approvals.mjs sem mudar o comportamento (as telas continuam exportando os mesmos nomes; os testes de
// tests/server/static-security.test.js seguem valendo).

// Um valor de dado vira texto só se for um texto, número ou booleano; qualquer outra coisa (objeto, lista) é ignorada.
export function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

// Devolve uma URL http(s) segura ou null. Nunca javascript:, data:, file:, blob:, vbscript:... e nunca URL com
// usuário/senha. `assumeHttps` (só para o campo "site", que é um domínio por definição) aceita "exemplo.com.br".
export function safeHttpUrl(value, { assumeHttps = false } = {}) {
  const raw = textOf(value);
  if (raw === '' || /\s/.test(raw)) return null;
  let candidate = raw;
  if (assumeHttps && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?([/?#].*)?$/.test(raw)) {
    candidate = `https://${raw}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

// "2026-01-15" -> "15/01/2026" (sem fuso horário: é uma data, não um instante).
export function formatDate(value) {
  const raw = textOf(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : raw;
}

export function formatDateTime(value) {
  const raw = textOf(value);
  const date = new Date(raw);
  if (raw === '' || Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

// Os nomes que a pessoa vê para cada role. Só apresentação: quem decide o que a role pode é o servidor.
export const ROLE_LABELS = Object.freeze({ ADMIN: 'Administrador', COMMERCIAL_CLOSER: 'Closer comercial' });

// Só uma role CONHECIDA (propriedade própria) ganha o nome amigável; qualquer outra é mostrada como veio (texto).
export function roleLabel(role) {
  if (typeof role !== 'string') return '';
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? ROLE_LABELS[role] : role;
}
