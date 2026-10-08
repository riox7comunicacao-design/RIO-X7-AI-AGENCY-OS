// PERFIL COMERCIAL de um lead validado (Implementação 3.0 — Prospecção Comercial). Módulo PURO: só texto, URLs e datas — sem rede, sem banco, sem LLM,
// sem relógio (a data da pesquisa chega de fora). Nunca busca nada: extrai por REGRA FIXA o que uma página pública já trouxe e valida o que um
// motor de enriquecimento AFIRMA. Princípios (todos por código, nunca pelo agente):
//   - nada é inventado nem inferido: sem origem pública (URL https) o dado NÃO entra; o que não foi confirmado fica NAO_VERIFICADO / NAO_ENCONTRADO;
//   - o RESPONSÁVEL nunca é deduzido (nome de domínio, e-mail, título de perfil): só entra com cargo explícito e a origem onde o nome aparece;
//   - "nenhuma evidência pública encontrada" de anúncio NÃO é "não faz tráfego pago";
//   - uma notícia ou diretório é `outrasPresencas`, nunca "site oficial";
//   - as fontes ficam SEPARADAS: descoberta, validação e enriquecimento.

const digital = require('./digitalPresence');
const { LEAD_TYPE, classifyLeadType } = require('./leadTypeClassification');

const SITE_STATUS = Object.freeze({
  ENCONTRADO: 'ENCONTRADO',
  NAO_ENCONTRADO: 'NAO_ENCONTRADO',
  // "não encontrado" NUNCA significa "não possui": só estes dois estados existem
});
const ADS_STATUS = Object.freeze({
  EVIDENCIA_ENCONTRADA: 'EVIDENCIA_ENCONTRADA',
  NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA',
  NAO_VERIFICADO: 'NAO_VERIFICADO',
});
const ACTIVITY = Object.freeze({ SIM: 'SIM', NAO: 'NAO', NAO_VERIFICADO: 'NAO_VERIFICADO' });
const PLATFORMS = Object.freeze(['meta', 'google', 'tiktok']);
const WINDOWS = Object.freeze([7, 30, 60, 90]);
const CONFIDENCE = Object.freeze({ ALTA: 'ALTA', MEDIA: 'MEDIA' });
const PROFILE_VERSION = 1;

const MAX_CONTACTS = 6;
const MAX_TEXT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

// Bibliotecas PÚBLICAS de anúncios (lista fechada): só uma URL destas vale como evidência (ou consulta) de anúncio — nada de login.
const AD_LIBRARIES = Object.freeze({
  meta: Object.freeze(['facebook.com']),
  google: Object.freeze(['adstransparency.google.com']),
  tiktok: Object.freeze(['library.tiktok.com', 'ads.tiktok.com']),
});

const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/;

function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string' || CONTROL.test(value)) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text !== '' && text.length <= max ? text : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Telefones, WhatsApps, e-mails e endereço de UMA página pública (links + texto visível). Tudo com a ORIGEM (a URL da página).
// ---------------------------------------------------------------------------------------------------------------------------------------------

// Um número brasileiro em forma canônica "+55DDNNNNNNNNN" (10 ou 11 dígitos nacionais, DDD 11-99), ou null.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2);
  if (digits.length !== 10 && digits.length !== 11) return null;
  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  const local = digits.slice(2);
  if (digits.length === 11 && local[0] !== '9') return null;
  if (digits.length === 10 && !/^[2-5]/.test(local)) return null;
  if (/^(\d)\1+$/.test(local)) return null;
  return `+55${digits}`;
}

const isMobile = (canonical) => /^\+55\d{2}9\d{8}$/.test(canonical);

function whatsappNumberOf(href) {
  if (typeof href !== 'string') return null;
  let url;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'wa.me') return normalizePhone(url.pathname.replace(/^\//, ''));
  if (host === 'api.whatsapp.com' && url.pathname.replace(/\/$/, '') === '/send') return normalizePhone(url.searchParams.get('phone') || '');
  return null;
}

const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g;
const BLOCKED_EMAIL = /(^|[._-])(example|exemplo|test|teste|sentry|wixpress|noreply|no-reply)([._-]|@)|@(example|exemplo)\.|\.(png|jpe?g|gif|webp|svg)$/i;
const PHONE_TEXT = /(?:\+?55[\s.-]?)?\(?\b([1-9]\d)\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b/g;

function pushUnique(list, key, entry, seen) {
  if (seen.has(key) || list.length >= MAX_CONTACTS) return;
  seen.add(key);
  list.push(entry);
}

// { telefones: [{ numero, origem }], whatsapps: [{ numero, origem }], emails: [{ email, origem }] } de uma página.
// WhatsApp só por LINK explícito (wa.me / api.whatsapp.com/send); número em texto corrido é telefone (nunca se presume WhatsApp).
function extractContacts({ texto, links, origem }) {
  const telefones = [];
  const whatsapps = [];
  const emails = [];
  if (typeof origem !== 'string' || digital.hostOf(origem) === null) return { telefones, whatsapps, emails };
  const seenPhone = new Set();
  const seenWhats = new Set();
  const seenMail = new Set();
  for (const link of Array.isArray(links) ? links : []) {
    const href = link && typeof link.href === 'string' ? link.href : typeof link === 'string' ? link : null;
    if (href === null) continue;
    if (/^tel:/i.test(href)) {
      const phone = normalizePhone(decodeURIComponent(href.slice(4)).replace(/[^\d+]/g, ''));
      if (phone) pushUnique(telefones, phone, { numero: phone, origem }, seenPhone);
    } else if (/^mailto:/i.test(href)) {
      const address = href.slice(7).split('?')[0].trim().toLowerCase();
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(address) && !BLOCKED_EMAIL.test(address)) pushUnique(emails, address, { email: address, origem }, seenMail);
    } else {
      const phone = whatsappNumberOf(href);
      if (phone) pushUnique(whatsapps, phone, { numero: phone, origem }, seenWhats);
    }
  }
  const text = typeof texto === 'string' ? texto : '';
  for (const match of text.matchAll(PHONE_TEXT)) {
    const phone = normalizePhone(`${match[1]}${match[2]}${match[3]}`);
    if (phone) pushUnique(telefones, phone, { numero: phone, origem }, seenPhone);
  }
  for (const match of text.matchAll(EMAIL)) {
    const address = match[0].toLowerCase();
    if (!BLOCKED_EMAIL.test(address)) pushUnique(emails, address, { email: address, origem }, seenMail);
  }
  return { telefones, whatsapps, emails };
}

const STREET = /\b((?:Rua|R\.|Avenida|Av\.|Travessa|Tv\.|Alameda|Al\.|Rodovia|Estrada|Praça|Pça\.|Largo)\s+[^,\n;|]{2,70}?(?:,\s*(?:n[ºo°.]*\s*)?\d{1,6}[A-Za-z]?)?)(?=\s*(?:[,\-–|;]|$|\n|CEP|\d{5}-?\d{3}))/u;
const CEP = /\b(\d{5})-?(\d{3})\b/;
const CITY_UF = /([A-ZÀ-Ú][A-Za-zÀ-ú' ]{2,40}?)\s*[-–/,]\s*([A-Z]{2})\b/u;
const UFS = new Set(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);

// O endereço de uma página: só quando há CEP E uma rua no mesmo trecho; cidade/UF só se o trecho trouxer "Cidade - UF". Sem inventar: o que falta é null.
function extractAddress({ texto, origem }) {
  if (typeof texto !== 'string' || typeof origem !== 'string' || digital.hostOf(origem) === null) return null;
  const flat = texto.replace(/\s+/g, ' ');
  const cepMatch = CEP.exec(flat);
  if (cepMatch === null) return null;
  const window = flat.slice(Math.max(0, cepMatch.index - 160), cepMatch.index + 60);
  const street = STREET.exec(window);
  if (street === null) return null;
  let cidade = null;
  let estado = null;
  const around = flat.slice(Math.max(0, cepMatch.index - 100), cepMatch.index + 40);
  for (const match of around.matchAll(new RegExp(CITY_UF.source, 'gu'))) {
    if (UFS.has(match[2])) {
      cidade = match[1].replace(/^(?:Bairro|Centro)\s+/i, '').trim();
      estado = match[2];
    }
  }
  return { rua: cleanText(street[1], 120), cidade, estado, cep: `${cepMatch[1]}-${cepMatch[2]}`, origem };
}

// O RESPONSÁVEL: só com CARGO EXPLÍCITO ao lado do nome na página oficial ("Responsável técnico: Dra. Ana Souza", "Fundador: ...", "Proprietário: ...").
// Nunca se deduz de domínio, e-mail, título de perfil ou nome da empresa. Sem padrão exato: null.
const ROLE = '(Respons[aá]vel(?: t[eé]cnic[oa])?|Diretor(?:a)?(?: (?:cl[ií]nic[oa]|geral|comercial))?|Fundador(?:a)?|Propriet[aá]ri[oa]|CEO|S[oó]ci[oa](?:-administrador(?:a)?)?|Gerente(?: geral)?)';
const PERSON = '((?:Dr\\.?|Dra\\.?|Prof\\.?|Profa\\.?)?\\s*[A-ZÀ-Ú][a-zà-ú]{1,20}(?:\\s+(?:d[aeo]s?|e)\\s+|\\s+)[A-ZÀ-Ú][a-zà-ú]{1,20}(?:\\s+(?:d[aeo]s?\\s+)?[A-ZÀ-Ú][a-zà-ú]{1,20}){0,2})';
const ROLE_PERSON = new RegExp(`${ROLE}\\s*[:\\-–]\\s*${PERSON}`, 'u');
const NOT_A_PERSON = /\b(?:Ltda|Eireli|Clínica|Clinica|Estética|Estetica|Studio|Estúdio|Instituto|Centro|Espaço|Espaco|Odontologia|Saúde|Saude|Atendimento|Contato|Fale|Política|Politica|Termos)\b/i;

const TRAILING = /^(?:Telefone|Tel|Fone|CRM|CRO|CREFITO|CRBM|CNPJ|CPF|Email|E-mail|Contato|Endere[cç]o|Whatsapp|WhatsApp|Atendimento|Hor[aá]rio|Rua|Av|Avenida|Clínica|Clinica)$/i;

// Linha a linha (o texto visível separa os blocos por quebra de linha): o nome termina onde começa um rótulo ("... Lima Telefone" -> "... Lima").
function extractResponsavel({ texto, origem }) {
  if (typeof texto !== 'string' || typeof origem !== 'string' || digital.hostOf(origem) === null) return null;
  for (const line of texto.split(/\n/)) {
    const match = ROLE_PERSON.exec(line.replace(/\s+/g, ' '));
    if (match === null) continue;
    const words = match[2].replace(/\s+/g, ' ').trim().split(' ');
    while (words.length > 0 && TRAILING.test(words[words.length - 1])) words.pop();
    const nome = cleanText(words.join(' '), 80);
    if (nome === null || NOT_A_PERSON.test(nome) || nome.split(' ').length < 2) continue;
    return { nome, cargo: cleanText(match[1], 60), origem, confianca: CONFIDENCE.ALTA };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Tráfego pago e atividade recente: a partir do que o motor de enriquecimento AFIRMA — validado aqui, nunca confiado.
// ---------------------------------------------------------------------------------------------------------------------------------------------

function isoDate(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return null;
  const limit = Date.parse(`${today}T00:00:00Z`);
  if (!(time <= limit) || limit - time > 10 * 366 * DAY_MS) return null; // nunca no futuro, nunca absurdamente antiga
  return value;
}

function libraryUrl(platform, raw) {
  let url = null;
  try {
    url = typeof raw === 'string' && raw.length <= 2048 ? new URL(raw.trim()) : null;
  } catch {
    url = null;
  }
  if (url === null || url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!AD_LIBRARIES[platform].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
  if (platform === 'meta' && !/^\/ads\/library/i.test(url.pathname)) return null;
  url.hash = '';
  return url.toString().slice(0, 2048);
}

// { meta, google, tiktok }: cada plataforma { status, origem?, data?, observacao }. Padrão NAO_VERIFICADO. EVIDENCIA_ENCONTRADA exige uma URL de biblioteca
// pública da plataforma; NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA exige a URL da consulta feita. Em NENHUM caso "sem evidência" vira "não anuncia".
function normalizeAds(raw, today) {
  const out = {};
  for (const platform of PLATFORMS) {
    const item = isPlainObject(raw) ? raw[platform] : undefined;
    let entry = { status: ADS_STATUS.NAO_VERIFICADO, observacao: 'Não verificado nesta pesquisa.' };
    if (isPlainObject(item)) {
      const url = libraryUrl(platform, item.url);
      const date = isoDate(item.data, today);
      if (url !== null && item.resultado === ADS_STATUS.EVIDENCIA_ENCONTRADA) {
        entry = { status: ADS_STATUS.EVIDENCIA_ENCONTRADA, origem: { url }, ...(date ? { data: date } : {}), observacao: cleanText(item.observacao, 300) || 'Anúncio público encontrado na biblioteca de anúncios.' };
      } else if (url !== null && item.resultado === ADS_STATUS.NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA) {
        entry = { status: ADS_STATUS.NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA, origem: { url }, ...(date ? { data: date } : {}), observacao: 'Nenhuma evidência pública encontrada nesta consulta; isso NÃO significa que a empresa não faça tráfego pago.' };
      }
    }
    out[platform] = entry;
  }
  return out;
}

function daysBetween(from, to) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

// ultimaPostagem { canal, url, data } (data ISO verificada) -> as janelas de 7/30/60/90 dias. Sem a DATA da última postagem tudo é NAO_VERIFICADO
// (nunca se chuta). Com a data: SIM se a última postagem cai na janela; NAO se é mais antiga (a última postagem já é a mais recente que existe).
function deriveActivity(raw, today, allowedChannels = null) {
  const empty = { ultimaPostagem: null, janelas: Object.fromEntries(WINDOWS.map((days) => [`ultimos${days}Dias`, ACTIVITY.NAO_VERIFICADO])), dataPesquisa: today };
  if (!isPlainObject(raw)) return empty;
  const data = isoDate(raw.data, today);
  const url = typeof raw.url === 'string' && digital.hostOf(raw.url) !== null ? raw.url.slice(0, 2048) : null;
  const canal = digital.CHANNELS.includes(raw.canal) ? raw.canal : null;
  if (data === null || url === null || canal === null) return empty;
  // a postagem tem de estar num canal JÁ confirmado do lead e a URL tem de ser desse canal (nunca um perfil de outro lugar)
  if (allowedChannels instanceof Set && !allowedChannels.has(canal)) return empty;
  const known = digital.classifyHost(digital.hostOf(url));
  if (known === null || known.canal !== canal) return empty;
  const age = daysBetween(data, today);
  return {
    ultimaPostagem: { canal, url, data },
    janelas: Object.fromEntries(WINDOWS.map((days) => [`ultimos${days}Dias`, age <= days ? ACTIVITY.SIM : ACTIVITY.NAO])),
    dataPesquisa: today,
  };
}

// Valida o que o motor de enriquecimento devolveu para UM lead. `responsavel` só passa se a origem citada for confirmada por quem chama
// (`confirmedSources`: URLs cujo texto contém o nome) — a confirmação é feita pelo job com a leitura de página, nunca aqui.
function normalizeEnrichment(raw, { today, confirmedSources = new Set(), confirmedChannels = null }) {
  const out = { responsavel: null, ads: normalizeAds(isPlainObject(raw) ? raw.trafegoPago : undefined, today), atividade: deriveActivity(isPlainObject(raw) ? raw.atividadeRecente : undefined, today, confirmedChannels), origens: [] };
  if (!isPlainObject(raw)) return out;
  const r = raw.responsavel;
  if (isPlainObject(r)) {
    const nome = cleanText(r.nome, 80);
    const cargo = cleanText(r.cargo, 60);
    const origemUrl = typeof r.origem === 'string' && digital.hostOf(r.origem) !== null ? r.origem : null;
    if (nome && cargo && origemUrl && confirmedSources.has(origemUrl)) out.responsavel = { nome, cargo, origem: origemUrl, confianca: CONFIDENCE.MEDIA };
  }
  const origens = [];
  if (out.responsavel) origens.push(out.responsavel.origem);
  for (const platform of PLATFORMS) if (out.ads[platform].origem) origens.push(out.ads[platform].origem.url);
  if (out.atividade.ultimaPostagem) origens.push(out.atividade.ultimaPostagem.url);
  out.origens = digital.classifySources(origens);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// O perfil final do lead.
// ---------------------------------------------------------------------------------------------------------------------------------------------

function mergeContacts(pieces) {
  const telefones = [];
  const whatsapps = [];
  const emails = [];
  const seen = { t: new Set(), w: new Set(), e: new Set() };
  for (const piece of pieces) {
    for (const item of piece.telefones) pushUnique(telefones, item.numero, { ...item, celular: isMobile(item.numero) }, seen.t);
    for (const item of piece.whatsapps) pushUnique(whatsapps, item.numero, item, seen.w);
    for (const item of piece.emails) pushUnique(emails, item.email, item, seen.e);
  }
  return { telefones, whatsapps, emails };
}

// A análise comercial de UM lead validado. `pages`: as páginas JÁ lidas na validação (origem + texto + links): nada é buscado de novo.
function buildCommercialProfile({ empresa, siteOficial, presencaDigital, outrasPresencas, fontesDescoberta, fontesValidacao, pages, enrichment, today }) {
  const readPages = (Array.isArray(pages) ? pages : []).filter((page) => page && typeof page.origem === 'string');
  const contacts = mergeContacts(readPages.map((page) => extractContacts({ texto: page.texto, links: page.links, origem: page.origem })));
  const official = readPages.find((page) => page.oficial === true) || null;
  const address = official ? extractAddress({ texto: official.texto, origem: official.origem }) : null;
  const deterministicOwner = official ? extractResponsavel({ texto: official.texto, origem: official.origem }) : null;
  const enriched = isPlainObject(enrichment) ? enrichment : normalizeEnrichment(null, { today });
  const owner = deterministicOwner || enriched.responsavel || null;
  // TIPO DE LEAD (RULES: distinguir EMPRESA/PROFISSIONAL/UNIDADE_FRANQUIA, porque o briefing pode pedir "clínicas" e o motor trazer profissionais
  // individuais): pelo nome e, quando há, pelo título/H1 e o texto da página oficial já lida — nunca por uma busca nova.
  const tipoLead = classifyLeadType({ nome: empresa, identidade: official ? official.identidade : null, texto: official ? official.texto : null }).tipo;

  let site = { status: SITE_STATUS.NAO_ENCONTRADO, url: null };
  if (siteOficial && siteOficial.status === SITE_STATUS.ENCONTRADO && typeof siteOficial.url === 'string') site = { status: SITE_STATUS.ENCONTRADO, url: siteOficial.url };

  const enrichmentSources = digital.classifySources([
    ...readPages.filter((page) => page.oficial === true).map((page) => page.origem),
    ...(enriched.origens || []).map((origem) => origem.url),
  ]);
  return {
    versao: PROFILE_VERSION,
    empresa: typeof empresa === 'string' ? empresa : null,
    tipoLead,
    responsavel: owner ? { status: 'ENCONTRADO', ...owner } : { status: 'NAO_ENCONTRADO', nome: null, cargo: null, origem: null, confianca: null },
    endereco: address ? { status: 'ENCONTRADO', ...address } : { status: 'NAO_ENCONTRADO', rua: null, cidade: null, estado: null, cep: null, origem: null },
    siteOficial: site,
    presencaDigital: presencaDigital || digital.emptyPresence(),
    telefones: contacts.telefones,
    whatsapps: contacts.whatsapps,
    emails: contacts.emails,
    trafegoPago: enriched.ads,
    atividadeRecente: enriched.atividade,
    fontesDescoberta: Array.isArray(fontesDescoberta) ? fontesDescoberta : [],
    fontesValidacao: Array.isArray(fontesValidacao) ? fontesValidacao : [],
    fontesEnriquecimento: enrichmentSources,
    outrasPresencas: Array.isArray(outrasPresencas) ? outrasPresencas : [],
    dataPesquisa: today,
  };
}

module.exports = {
  SITE_STATUS,
  ADS_STATUS,
  ACTIVITY,
  PLATFORMS,
  WINDOWS,
  CONFIDENCE,
  AD_LIBRARIES,
  PROFILE_VERSION,
  LEAD_TYPE,
  normalizePhone,
  extractContacts,
  extractAddress,
  extractResponsavel,
  normalizeAds,
  deriveActivity,
  normalizeEnrichment,
  buildCommercialProfile,
};
