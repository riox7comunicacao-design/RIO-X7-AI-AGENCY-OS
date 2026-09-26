// Política de FONTES do Researcher V1 (decisão 0021) — funções puras, sem rede, sem disco, sem relógio.
//
// O que é permitido: só fontes PÚBLICAS acessíveis por https (checkUrl: sem usuário/senha, sem porta, sem IP nem host local). O que nunca
// é: login, captcha, controle de acesso, dado privado. Uma URL de login, o aviso de bloqueio de uma porta e um perfil privado são
// FALHAS REGISTRADAS (fato NAO_VERIFICADO com `motivo`), nunca um obstáculo contornado e nunca uma afirmação negativa.
//
// Nada aqui INFERE: só reconhece, por regra fixa, o que um link JÁ publicado é (o perfil do Instagram, a página do Facebook, o
// número de um link wa.me...). Telefone, WhatsApp e e-mail só existem quando publicados como link explícito (tel:, mailto:, wa.me).

const { checkUrl } = require('./rawFindingSchema');
const { MOTIVO } = require('./signalSchema');

// A ordem de prioridade das fontes (0003/0004): o que o Researcher tenta primeiro.
const SOURCE_PRIORITY = Object.freeze(['SITE_OFICIAL', 'GOOGLE_PERFIL', 'INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'OUTRAS_FONTES_PUBLICAS']);

// O tipo de resultado que uma busca pode devolver (vocabulário fechado da porta de busca).
const RESULT_TYPE = Object.freeze({ SITE: 'SITE', GOOGLE_PERFIL: 'GOOGLE_PERFIL', INSTAGRAM: 'INSTAGRAM', FACEBOOK: 'FACEBOOK', LINKEDIN: 'LINKEDIN', YOUTUBE: 'YOUTUBE' });

// campo do achado (rawFindingSchema.EVIDENCE_FIELDS) de cada tipo de resultado
const RESULT_FIELD = Object.freeze({ SITE: 'site', GOOGLE_PERFIL: 'googlePerfil', INSTAGRAM: 'instagram', FACEBOOK: 'facebook', LINKEDIN: 'linkedin', YOUTUBE: 'youtube' });

// Falhas que uma porta pode devolver (vocabulário fechado) -> o motivo do fato NAO_VERIFICADO. Qualquer código desconhecido é NAO_CONSULTADO.
const FAILURE = Object.freeze({
  FORA_DO_AR: 'FORA_DO_AR',
  PRIVADO: 'PRIVADO',
  LOGIN: 'LOGIN',
  CAPTCHA: 'CAPTCHA',
  BLOQUEADO: 'BLOQUEADO',
  ROBOTS: 'ROBOTS',
  REMOVIDA: 'REMOVIDA',
  SEM_RESULTADO: 'SEM_RESULTADO',
  DESATUALIZADA: 'DESATUALIZADA',
  TEMPO_ESGOTADO: 'TEMPO_ESGOTADO',
  ERRO: 'ERRO',
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// `site`: a falha de um site fora do ar é SITE_FORA_DO_AR; em qualquer outra página, NAO_CONSULTADO.
function motivoFor(failure, { site = false } = {}) {
  if (typeof failure !== 'string' || !hasOwn(FAILURE, failure)) return MOTIVO.NAO_CONSULTADO;
  switch (failure) {
    case FAILURE.FORA_DO_AR:
      return site ? MOTIVO.SITE_FORA_DO_AR : MOTIVO.NAO_CONSULTADO;
    case FAILURE.PRIVADO:
      return MOTIVO.PERFIL_PRIVADO;
    case FAILURE.LOGIN:
    case FAILURE.CAPTCHA:
    case FAILURE.BLOQUEADO:
    case FAILURE.ROBOTS:
      return MOTIVO.BLOQUEADO;
    case FAILURE.REMOVIDA:
      return MOTIVO.PAGINA_REMOVIDA;
    case FAILURE.SEM_RESULTADO:
      return MOTIVO.SEM_RESULTADO;
    case FAILURE.DESATUALIZADA:
      return MOTIVO.DESATUALIZADA;
    default:
      return MOTIVO.NAO_CONSULTADO;
  }
}

// A URL como objeto URL, só se for uma URL pública https aceita pelo esquema; senão null.
function parsePublicUrl(raw) {
  if (checkUrl(raw).error) return null;
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

const bareHost = (url) => url.hostname.toLowerCase().replace(/^www\./, '');
const segments = (url) => url.pathname.split('/').filter(Boolean);

// Uma página de LOGIN, checkpoint ou muro de autenticação: nunca é lida como conteúdo (a porta a devolveria como LOGIN; se a URL final
// for uma destas, o Researcher trata como bloqueio).
const LOGIN_WALL = /(^|\/)(login|signin|sign-in|accounts\/login|checkpoint|authwall|uas\/login|challenge|captcha)(\/|$|\?)/i;
function isLoginWall(raw) {
  const url = parsePublicUrl(raw);
  return url === null ? false : LOGIN_WALL.test(`${url.pathname.replace(/^\//, '')}${url.search}`);
}

const RESERVED = Object.freeze({
  instagram: new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'direct', 'about', 'legal', 'developer', 'web', 'privacy']),
  facebook: new Set(['sharer', 'sharer.php', 'share', 'share.php', 'tr', 'plugins', 'dialog', 'login', 'login.php', 'policies', 'help', 'privacy', 'watch', 'groups', 'events', 'marketplace', 'profile.php', 'ads', 'l.php']),
});
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const FB_SLUG = /^[A-Za-z0-9.\-]{3,80}$/;
const SLUG = /^[A-Za-z0-9\-_%]{1,100}$/;

// Reconhece, por regra fixa, o que um link publicado é. Devolve
//   { canal: 'instagram'|'facebook'|'linkedin'|'youtube'|'googlePerfil', url }   a URL CANÔNICA (https, sem query nem âncora)
//   { canal: 'whatsapp', numero }   de wa.me/<número> ou api.whatsapp.com/send?phone=<número>
//   { canal: 'telefone', numero }   de tel:
//   { canal: 'email', endereco }    de mailto:
//   null                            qualquer outra coisa (incluindo páginas de login, compartilhamento e links relativos)
function classifyLink(href) {
  if (typeof href !== 'string' || href.length > 2048) return null;
  const text = href.trim();
  const tel = /^tel:\+?([0-9()\s.\-]{8,30})$/i.exec(text);
  if (tel) {
    const digits = tel[1].replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? { canal: 'telefone', numero: text.slice(4) } : null;
  }
  const mail = /^mailto:([^\s@<>"'`?]+@[^\s@<>"'`?]+\.[^\s@<>"'`?]{2,})(\?.*)?$/i.exec(text);
  if (mail) return mail[1].length <= 254 ? { canal: 'email', endereco: mail[1] } : null;

  const url = parsePublicUrl(text);
  if (url === null || isLoginWall(text)) return null;
  const host = bareHost(url);
  const parts = segments(url);

  if (host === 'wa.me' && parts.length === 1 && /^\+?[0-9]{8,15}$/.test(parts[0])) return { canal: 'whatsapp', numero: parts[0].replace(/^\+/, '') };
  if (host === 'api.whatsapp.com' && parts[0] === 'send') {
    const phone = url.searchParams.get('phone');
    return phone && /^\+?[0-9]{8,15}$/.test(phone) ? { canal: 'whatsapp', numero: phone.replace(/^\+/, '') } : null;
  }
  if (host === 'instagram.com') {
    return parts.length >= 1 && HANDLE.test(parts[0]) && !RESERVED.instagram.has(parts[0].toLowerCase()) && parts.length === 1 ? { canal: 'instagram', url: `https://www.instagram.com/${parts[0]}` } : null;
  }
  if (host === 'facebook.com' || host === 'fb.com') {
    return parts.length === 1 && FB_SLUG.test(parts[0]) && !RESERVED.facebook.has(parts[0].toLowerCase()) ? { canal: 'facebook', url: `https://www.facebook.com/${parts[0]}` } : null;
  }
  if (host === 'linkedin.com') {
    return parts.length === 2 && ['company', 'in'].includes(parts[0]) && SLUG.test(parts[1]) ? { canal: 'linkedin', url: `https://www.linkedin.com/${parts[0]}/${parts[1]}` } : null;
  }
  if (host === 'youtube.com') {
    if (parts.length === 1 && /^@[A-Za-z0-9._\-]{1,60}$/.test(parts[0])) return { canal: 'youtube', url: `https://www.youtube.com/${parts[0]}` };
    return parts.length === 2 && ['channel', 'c', 'user'].includes(parts[0]) && SLUG.test(parts[1]) ? { canal: 'youtube', url: `https://www.youtube.com/${parts[0]}/${parts[1]}` } : null;
  }
  if ((host === 'google.com' && parts[0] === 'maps') || host === 'maps.google.com' || (host === 'g.page' && parts.length >= 1)) {
    return { canal: 'googlePerfil', url: `https://${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}` };
  }
  return null;
}

// Os hosts onde os anúncios são consultados. Só estas bibliotecas públicas valem como fonte de `anuncios.*`.
const ADS_PLATFORM = Object.freeze({ META: 'META', GOOGLE: 'GOOGLE' });
const ADS_FIELD = Object.freeze({ META: 'anuncios.meta', GOOGLE: 'anuncios.google' });
function isAdsLibraryUrl(platform, raw) {
  const url = parsePublicUrl(raw);
  if (url === null || isLoginWall(raw)) return false;
  if (platform === ADS_PLATFORM.META) return bareHost(url) === 'facebook.com' && url.pathname.startsWith('/ads/library');
  if (platform === ADS_PLATFORM.GOOGLE) return bareHost(url) === 'adstransparency.google.com';
  return false;
}

// Uma URL só serve de fonte de uma observação de um canal se for uma página DESSE canal (a do próprio perfil).
function isChannelPage(canal, raw) {
  const found = classifyLink(raw);
  return found !== null && found.canal === canal;
}

// Chamada para agendar: uma regra fixa e curta sobre o texto ou o destino de um link publicado na página (nunca sobre o texto corrido).
const SCHEDULING = /\b(agend[ae]\w*|marc(ar|e)\s+(uma\s+)?(consulta|sess[aã]o|hor[aá]rio)|calendly|reserv(ar|e)\s+hor[aá]rio)\b/i;
function isSchedulingLink(link) {
  const text = typeof link.texto === 'string' ? link.texto.slice(0, 200) : '';
  const parsed = typeof link.href === 'string' ? parsePublicUrl(link.href) : null;
  return SCHEDULING.test(text) || (parsed !== null && (bareHost(parsed) === 'calendly.com' || SCHEDULING.test(parsed.pathname)));
}

module.exports = {
  SOURCE_PRIORITY,
  RESULT_TYPE,
  RESULT_FIELD,
  FAILURE,
  ADS_PLATFORM,
  ADS_FIELD,
  motivoFor,
  parsePublicUrl,
  bareHost,
  isLoginWall,
  classifyLink,
  isAdsLibraryUrl,
  isChannelPage,
  isSchedulingLink,
};
