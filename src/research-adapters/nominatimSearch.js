// Adaptador da porta `search` sobre o OpenStreetMap Nominatim (decisão 0022) — dados ABERTOS (ODbL), API pública sem chave, sem conta,
// sem assinatura e sem raspagem de buscador. Toda peculiaridade do provedor fica AQUI: o Researcher só vê o formato da porta.
//
//   search({ consulta, limite }) -> { ok: true, resultados: [{ nome, url, tipoResultado, fonteUrl, cidade?, estado? }] } | { ok: false, falha }
//
// Uma consulta = UMA requisição (a política de uso do Nominatim: no máximo 1 requisição por segundo — o `minIntervalMs` do cliente —, User-Agent
// que identifica a aplicação, sem varredura em massa). O robots.txt do host é respeitado como em qualquer página (o cliente faz isso).
//
// O que um lugar do OSM vira: cada `website`/`contact:website` https vira um resultado SITE; `contact:instagram`, `contact:facebook`,
// `contact:linkedin` e `contact:youtube` viram resultados do canal (só a URL do próprio canal, revalidada pela política; um @usuário do
// Instagram/Facebook publicado no OSM é transformado na URL do perfil). Um `website` http NÃO é promovido a https (nada é inventado). A fonte
// (`fonteUrl`) é a página pública do próprio objeto no OpenStreetMap. Lugar sem nome ou sem nenhum endereço público de canal é descartado
// (conta em estatisticas, nunca vira dado inventado).

const { parsePublicUrl, classifyLink, RESULT_TYPE } = require('../research-prospector/researchPolicy');

const DEFAULT_BASE_URL = 'https://nominatim.openstreetmap.org';
const MAX_LIMIT = 40; // o teto do próprio Nominatim
const MAX_PLACES = 50;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const text = (value) => (typeof value === 'string' && value.trim() !== '' && value.length <= 200 ? value.trim() : null);

const CHANNEL_TAGS = Object.freeze([
  { tipo: RESULT_TYPE.SITE, canal: null, chaves: ['website', 'contact:website'], handle: null },
  { tipo: RESULT_TYPE.INSTAGRAM, canal: 'instagram', chaves: ['contact:instagram', 'instagram'], handle: (h) => `https://www.instagram.com/${h}` },
  { tipo: RESULT_TYPE.FACEBOOK, canal: 'facebook', chaves: ['contact:facebook', 'facebook'], handle: (h) => `https://www.facebook.com/${h}` },
  { tipo: RESULT_TYPE.LINKEDIN, canal: 'linkedin', chaves: ['contact:linkedin', 'linkedin'], handle: null },
  { tipo: RESULT_TYPE.YOUTUBE, canal: 'youtube', chaves: ['contact:youtube', 'youtube'], handle: null },
]);
const HANDLE = /^@?[A-Za-z0-9._-]{1,60}$/;

// O endereço público do canal a partir do valor de uma tag, ou null.
function channelUrl(entry, value) {
  const raw = text(value);
  if (raw === null) return null;
  let candidate = null;
  if (/^https:\/\//i.test(raw)) candidate = raw;
  else if (entry.handle && HANDLE.test(raw)) candidate = entry.handle(raw.replace(/^@/, ''));
  if (candidate === null) return null;
  if (entry.canal === null) return parsePublicUrl(candidate) === null ? null : candidate; // site: qualquer página pública https
  const link = classifyLink(candidate);
  return link !== null && link.canal === entry.canal ? link.url : null;
}

// Um lugar do Nominatim -> resultados da porta (lista, possivelmente vazia).
function mapPlace(place) {
  if (place === null || typeof place !== 'object' || Array.isArray(place)) return [];
  const nome = text(place.name);
  const tags = place.extratags !== null && typeof place.extratags === 'object' && !Array.isArray(place.extratags) ? place.extratags : {};
  if (nome === null || !['node', 'way', 'relation'].includes(place.osm_type) || !Number.isInteger(place.osm_id) || place.osm_id < 1) return [];
  const fonteUrl = `https://www.openstreetmap.org/${place.osm_type}/${place.osm_id}`;
  const address = place.address !== null && typeof place.address === 'object' && !Array.isArray(place.address) ? place.address : {};
  const cidade = text(address.city) || text(address.town) || text(address.village) || text(address.municipality);
  const estado = text(address.state);
  const out = [];
  for (const entry of CHANNEL_TAGS) {
    for (const key of entry.chaves) {
      if (!hasOwn(tags, key)) continue;
      const url = channelUrl(entry, tags[key]);
      if (url !== null) {
        out.push({ nome, url, tipoResultado: entry.tipo, fonteUrl, ...(cidade ? { cidade } : {}), ...(estado ? { estado } : {}) });
        break;
      }
    }
  }
  return out;
}

function createNominatimSearch({ web, baseUrl = DEFAULT_BASE_URL } = {}) {
  if (!web || typeof web.getJson !== 'function') throw new Error('createNominatimSearch exige { web } com getJson()');
  const base = parsePublicUrl(baseUrl);
  if (base === null || base.pathname !== '/' || base.search !== '') throw new Error('createNominatimSearch: baseUrl deve ser uma origem https pública');

  return async function search(request) {
    const consulta = request && typeof request.consulta === 'string' ? request.consulta.trim() : '';
    const limite = request && Number.isInteger(request.limite) ? request.limite : 0;
    if (consulta === '' || consulta.length > 300 || limite < 1) return { ok: false, falha: 'ERRO' };
    const params = new URLSearchParams({ q: consulta, format: 'jsonv2', limit: String(Math.min(limite, MAX_LIMIT)), addressdetails: '1', extratags: '1', 'accept-language': 'pt-BR' });
    const got = await web.getJson(`${base.origin}/search?${params.toString()}`);
    if (!got.ok) return { ok: false, falha: got.falha };
    if (!Array.isArray(got.data) || got.data.length > MAX_PLACES) return { ok: false, falha: 'ERRO' };
    return { ok: true, resultados: got.data.flatMap(mapPlace) };
  };
}

module.exports = { createNominatimSearch, mapPlace, DEFAULT_BASE_URL };
