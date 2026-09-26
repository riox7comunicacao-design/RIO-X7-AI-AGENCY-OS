// Adaptadores REAIS das portas do Researcher (decisão 0022) — a composição. Nada aqui decide, grava, autoriza ou conhece o CRM, a fila,
// o lote ou o serviço de prospecção; e o Researcher (src/research-prospector/) não conhece este diretório (a rede é um detalhe daqui).
//
//   createResearchPorts({ userAgent, ...limites }) -> { search, fetchPage, estatisticas }     (lookupAds NÃO existe: ver abaixo)
//
// `lookupAds` (anúncios) NÃO tem adaptador: as bibliotecas públicas de anúncios (Meta Ad Library, Google Ads Transparency) exigem token de
// aplicativo/conta ou executam JavaScript com desafio anti-robô, e o que existe de "API" para isso é pago ou de terceiros. Sem uma fonte pública
// realmente adequada, a porta fica ausente: o Researcher simplesmente não produz nenhum fato de anúncio (nunca "não anuncia").

const { createHttpsTransport } = require('./httpsTransport');
const { createPublicWeb } = require('./publicWeb');
const { createNominatimSearch } = require('./nominatimSearch');

function createResearchPorts(options) {
  const { transport = createHttpsTransport(), searchBaseUrl, ...webOptions } = options || {};
  const web = createPublicWeb({ transport, ...webOptions });
  const search = createNominatimSearch({ web, ...(searchBaseUrl === undefined ? {} : { baseUrl: searchBaseUrl }) });
  return Object.freeze({ search, fetchPage: web.fetchPage, estatisticas: web.estatisticas });
}

module.exports = { createResearchPorts };
