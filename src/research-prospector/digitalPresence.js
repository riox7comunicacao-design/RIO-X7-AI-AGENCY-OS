// PRESENÇA DIGITAL e FONTES de um candidato (Implementação 2 — motor comercial de prospecção). Módulo PURO: só texto e URLs — sem rede, sem banco,
// sem LLM, sem relógio. Nunca busca nada: classifica o que o motor de descoberta e a leitura de páginas já trouxeram.
//
// Quatro coisas que NUNCA se misturam:
//   siteOficial       o site PRÓPRIO da empresa (https, na raiz). É uma HIPÓTESE do agente até ser confirmada por código (pageVerification.verifyOfficialSite).
//                     Não existir não invalida o lead: pode ser uma oportunidade comercial (criação de site).
//   presencaDigital   os perfis/canais públicos da empresa (Instagram, Facebook, Google Meu Negócio, LinkedIn, YouTube, TikTok, WhatsApp, outros), cada um
//                     com status (ENCONTRADO | NAO_ENCONTRADO | NAO_VERIFICADO) e confirmação (CONFIRMADO | NAO_CONFIRMADO). Um perfil só é CONFIRMADO por
//                     um VÍNCULO público (link no site oficial, link cruzado de uma página que comprova a empresa) — nunca só por um nome parecido.
//   fontesDescoberta  por onde o candidato foi achado, com um TIPO decidido por código (nunca pelo agente): OFICIAL (só o site oficial CONFIRMADO),
//                     REDE_SOCIAL, DIRETORIO, NOTICIA_OU_TERCEIRO.
//   outrasPresencas   as páginas de terceiros (notícia, portal, diretório, associação, marketplace): servem para descoberta, contexto e rastreabilidade;
//                     NÃO são perfis oficiais da empresa e nunca viram "site oficial".

const policy = require('./researchPolicy');

const CHANNELS = Object.freeze(['instagram', 'facebook', 'googleMeuNegocio', 'linkedin', 'youtube', 'tiktok', 'whatsapp']);
const SOURCE_TYPE = Object.freeze({ OFICIAL: 'OFICIAL', REDE_SOCIAL: 'REDE_SOCIAL', DIRETORIO: 'DIRETORIO', NOTICIA_OU_TERCEIRO: 'NOTICIA_OU_TERCEIRO' });
const PRESENCE_STATUS = Object.freeze({ ENCONTRADO: 'ENCONTRADO', NAO_ENCONTRADO: 'NAO_ENCONTRADO', NAO_VERIFICADO: 'NAO_VERIFICADO' });
const CONFIRMATION = Object.freeze({ CONFIRMADO: 'CONFIRMADO', NAO_CONFIRMADO: 'NAO_CONFIRMADO' });
const SITE_STATUS = Object.freeze({ ENCONTRADO: 'ENCONTRADO', NAO_ENCONTRADO: 'NAO_ENCONTRADO' });

const MAX_SOURCES = 10;
const MAX_OTHERS = 5;

// Hosts de terceiros por lista FECHADA (nenhum deles é "o site da empresa"). A lista é conservadora: um host fora dela NÃO vira oficial por isso —
// o vínculo com a empresa é sempre provado por pageVerification.verifyOfficialSite.
const SOCIAL_HOSTS = Object.freeze({
  'instagram.com': 'instagram', 'facebook.com': 'facebook', 'fb.com': 'facebook', 'fb.me': 'facebook', 'm.facebook.com': 'facebook', 'linkedin.com': 'linkedin',
  'youtube.com': 'youtube', 'youtu.be': 'youtube', 'tiktok.com': 'tiktok', 'wa.me': 'whatsapp', 'api.whatsapp.com': 'whatsapp', 'whatsapp.com': 'whatsapp',
  'maps.google.com': 'googleMeuNegocio', 'maps.app.goo.gl': 'googleMeuNegocio', 'g.page': 'googleMeuNegocio', 'business.google.com': 'googleMeuNegocio',
  'twitter.com': null, 'x.com': null, 'pinterest.com': null, 'threads.net': null, 'telegram.me': null, 't.me': null, 'kwai.com': null,
});
const DIRECTORY_HOSTS = Object.freeze([
  'guiamais.com.br', 'telelistas.net', 'apontador.com.br', 'yelp.com', 'yelp.com.br', 'tripadvisor.com', 'tripadvisor.com.br', 'doctoralia.com.br', 'cylex.com.br', 'solutudo.com.br',
  'esteticaguia.com', 'foursquare.com', 'yellowpages.com', 'cnpj.biz', 'casadosdados.com.br', 'econodata.com.br', 'cnpja.com', 'linktr.ee', 'linktree.com', 'beacons.ai', 'bio.link',
  'reclameaqui.com.br', 'guiadasemana.com.br', 'consultaremedios.com.br', 'boaconsulta.com', 'topdoctors.com.br', 'empresas.com.br', 'listamais.com.br', 'encontre.com.br',
]);
const PORTAL_HOSTS = Object.freeze([
  'globo.com', 'g1.globo.com', 'uol.com.br', 'terra.com.br', 'folha.uol.com.br', 'estadao.com.br', 'r7.com', 'ig.com.br', 'wikipedia.org', 'mercadolivre.com.br', 'olx.com.br',
  'jusbrasil.com.br', 'blogspot.com', 'wordpress.com', 'medium.com', 'issuu.com', 'scribd.com', 'slideshare.net', 'google.com', 'bing.com', 'duckduckgo.com',
]);

const hostMatches = (host, list) => list.some((item) => host === item || host.endsWith(`.${item}`));

function parseHttps(raw) {
  if (typeof raw !== 'string') return null;
  const url = policy.parsePublicUrl(raw);
  return url;
}

// o host sem "www." (minúsculo) de uma URL https pública, ou null
function hostOf(raw) {
  const url = parseHttps(raw);
  return url === null ? null : url.hostname.toLowerCase().replace(/^www\./, '');
}

// A origem (raiz) https de uma URL, ou null. O vínculo com a empresa se prova na página inicial, nunca num link profundo.
function normalizeToOrigin(raw) {
  const url = parseHttps(raw);
  return url === null ? null : `https://${url.hostname.toLowerCase()}/`;
}

// O "rótulo" do domínio registrável: marilzaestetica.com.br -> marilzaestetica; www.clinica-alfa.com -> clinicaalfa (só letras e dígitos).
function registrableLabel(host) {
  if (typeof host !== 'string' || host === '') return '';
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  const brSecond = new Set(['com', 'net', 'org', 'gov', 'edu', 'med', 'odo', 'adv', 'eco', 'art', 'blog', 'psc', 'esp']);
  const label = parts.length >= 3 && parts[parts.length - 1] === 'br' && brSecond.has(parts[parts.length - 2]) ? parts[parts.length - 3] : parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return label.replace(/[^a-z0-9]/g, '');
}

// O host é, por lista fechada, um terceiro (rede social, diretório, portal/notícia/marketplace)? { tipo, canal? } ou null (desconhecido).
function classifyHost(host) {
  if (typeof host !== 'string' || host === '') return null;
  for (const [social, canal] of Object.entries(SOCIAL_HOSTS)) if (host === social || host.endsWith(`.${social}`)) return { tipo: SOURCE_TYPE.REDE_SOCIAL, canal };
  if (hostMatches(host, DIRECTORY_HOSTS)) return { tipo: SOURCE_TYPE.DIRETORIO };
  if (hostMatches(host, PORTAL_HOSTS)) return { tipo: SOURCE_TYPE.NOTICIA_OU_TERCEIRO };
  return null;
}

const isKnownThirdPartyHost = (host) => classifyHost(host) !== null;

// O TIPO de uma fonte de descoberta, por código. OFICIAL só para o host do site oficial JÁ CONFIRMADO (`officialHost`); todo o resto é
// REDE_SOCIAL, DIRETORIO ou NOTICIA_OU_TERCEIRO (um host desconhecido que não é o site confirmado é "terceiro").
function classifySource(raw, officialHost = null) {
  const host = hostOf(raw);
  if (host === null) return null;
  if (officialHost && host === officialHost) return SOURCE_TYPE.OFICIAL;
  const known = classifyHost(host);
  return known ? known.tipo : SOURCE_TYPE.NOTICIA_OU_TERCEIRO;
}

// Lista de fontes { url, tipo } sem repetição (por URL sem âncora), só https públicas, no máximo MAX_SOURCES. Nunca confia no tipo de fora.
function classifySources(urls, officialHost = null) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = parseHttps(raw);
    if (url === null) continue;
    url.hash = '';
    const key = url.toString();
    if (seen.has(key)) continue;
    const tipo = classifySource(key, officialHost);
    if (tipo === null) continue;
    seen.add(key);
    out.push({ url: key, tipo });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

// A URL canônica de um PERFIL público do canal, ou null (página de login, compartilhamento, postagem, URL de outro canal...). Regra fixa.
function profileFor(canal, raw) {
  if (!CHANNELS.includes(canal) || typeof raw !== 'string') return null;
  if (canal === 'tiktok') {
    const url = parseHttps(raw);
    if (url === null || url.hostname.toLowerCase().replace(/^www\./, '') !== 'tiktok.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 1 && /^@[A-Za-z0-9._]{2,40}$/.test(parts[0]) ? `https://www.tiktok.com/${parts[0]}` : null;
  }
  const found = policy.classifyLink(raw);
  if (found === null) return null;
  const wanted = canal === 'googleMeuNegocio' ? 'googlePerfil' : canal;
  if (found.canal !== wanted) return null;
  if (canal === 'whatsapp') return `https://wa.me/${found.numero}`;
  return found.url;
}

const emptyChannel = () => ({ status: PRESENCE_STATUS.NAO_VERIFICADO, url: null, confirmacao: CONFIRMATION.NAO_CONFIRMADO });

function emptyPresence() {
  return { ...Object.fromEntries(CHANNELS.map((canal) => [canal, emptyChannel()])), outros: [] };
}

// Os perfis que o agente SUGERIU (hipótese): { canal: url | null | ausente } -> só os que são perfis válidos do canal. `null` = o agente
// procurou e não achou (NAO_ENCONTRADO); ausente = não procurou (NAO_VERIFICADO). Nunca devolve uma URL que não seja o perfil do canal.
function readProfileHints(raw) {
  const out = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const canal of CHANNELS) {
    if (!Object.prototype.hasOwnProperty.call(raw, canal)) continue;
    const value = raw[canal];
    if (value === null) out[canal] = null;
    else {
      const url = profileFor(canal, value);
      if (url !== null) out[canal] = url;
    }
  }
  return out;
}

const canonical = (canal, raw) => profileFor(canal, raw);

// Monta a presença digital a partir de hipóteses e VÍNCULOS públicos:
//   hints          { canal: url|null }         o que o agente sugeriu (hipótese)
//   officialLinks  [href]                      os links publicados NA PÁGINA do site oficial confirmado (vínculo mais forte)
//   crossLinks     [href]                      os links de uma página de terceiro que COMPROVA a empresa (nome + nicho + localização)
//   otherSources   [{ url, tipo }]             fontes de redes sociais sem canal próprio (outros)
// Regras: link no site oficial -> CONFIRMADO; link cruzado de página que comprova a empresa -> CONFIRMADO; senão, perfil só sugerido -> ENCONTRADO /
// NAO_CONFIRMADO (nunca por nome parecido). WhatsApp só vem de um link publicado no site oficial.
function buildPresence({ hints = {}, officialLinks = [], crossLinks = [], otherSources = [] } = {}) {
  const presence = emptyPresence();
  const fromOfficial = {};
  for (const href of officialLinks) {
    for (const canal of CHANNELS) {
      const url = canonical(canal, href);
      if (url !== null && !fromOfficial[canal]) fromOfficial[canal] = url;
    }
  }
  const cross = new Set();
  for (const href of crossLinks) for (const canal of CHANNELS) {
    const url = canonical(canal, href);
    if (url !== null) cross.add(url);
  }
  for (const canal of CHANNELS) {
    const slot = presence[canal];
    if (fromOfficial[canal]) {
      Object.assign(slot, { status: PRESENCE_STATUS.ENCONTRADO, url: fromOfficial[canal], confirmacao: CONFIRMATION.CONFIRMADO, regra: 'link_no_site_oficial' });
      continue;
    }
    if (canal === 'whatsapp') continue; // só do site oficial
    if (Object.prototype.hasOwnProperty.call(hints, canal)) {
      if (hints[canal] === null) {
        slot.status = PRESENCE_STATUS.NAO_ENCONTRADO;
        continue;
      }
      slot.status = PRESENCE_STATUS.ENCONTRADO;
      slot.url = hints[canal];
      if (cross.has(hints[canal])) Object.assign(slot, { confirmacao: CONFIRMATION.CONFIRMADO, regra: 'link_cruzado' });
    }
  }
  for (const source of otherSources) {
    if (presence.outros.length >= MAX_OTHERS) break;
    if (source && typeof source.url === 'string') presence.outros.push({ url: source.url, tipo: SOURCE_TYPE.REDE_SOCIAL });
  }
  return presence;
}

// Os canais CONFIRMADOS (os únicos que viram evidência do achado), como lista { canal, url }.
function confirmedChannels(presence) {
  if (!presence || typeof presence !== 'object') return [];
  return CHANNELS.filter((canal) => presence[canal] && presence[canal].confirmacao === CONFIRMATION.CONFIRMADO && typeof presence[canal].url === 'string').map((canal) => ({ canal, url: presence[canal].url }));
}

module.exports = {
  CHANNELS,
  SOURCE_TYPE,
  PRESENCE_STATUS,
  CONFIRMATION,
  SITE_STATUS,
  MAX_SOURCES,
  hostOf,
  normalizeToOrigin,
  registrableLabel,
  classifyHost,
  isKnownThirdPartyHost,
  classifySource,
  classifySources,
  profileFor,
  readProfileHints,
  emptyPresence,
  buildPresence,
  confirmedChannels,
};
