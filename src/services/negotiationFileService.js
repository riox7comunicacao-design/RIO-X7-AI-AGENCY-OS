// Negotiation Service sobre os adapters de ARQUIVO local — a peça de composição que liga Negociações à raiz de composição (src/server/index.js), no mesmo desenho de
// funnelFileService.js: o servidor passa só CAMINHOS, nunca um adapter nem o domínio.
//   filePath         o arquivo das negociações (RIO_X7_NEGOTIATIONS_PATH; padrão data/negotiations.json; só nasce na PRIMEIRA gravação)
//   funnelsFilePath  o MESMO arquivo de Funis que o Funnel Service usa (RIO_X7_FUNNELS_PATH): o card de uma negociação vive lá. O adapter de arquivo é sem estado (cada chamada relê o
//                    disco), então uma instância própria aqui enxerga exatamente o mesmo que a do Funnel Service.
// `crmRepository`/`crmService`/`catalogService` chegam PRONTOS de quem compõe — os MESMOS que REPOSITORY_MODE decidiu (nunca uma segunda instância).
// O adapter de PRODUÇÃO no Supabase é uma decisão e uma fase próprias (decisão 0028).
const { createNegotiationService } = require('./negotiationService');
const { createJsonFileNegotiationRepository } = require('../crm/negotiationRepository');
const { createJsonFileFunnelRepository } = require('../crm/funnelRepository');

function createFileBackedNegotiationService(dependencies) {
  const { authorizeCrmOperation, filePath, funnelsFilePath, crmRepository, crmService, catalogService } = dependencies || {};
  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new Error('createFileBackedNegotiationService exige { filePath } (texto não vazio)');
  if (typeof funnelsFilePath !== 'string' || funnelsFilePath.trim().length === 0) throw new Error('createFileBackedNegotiationService exige { funnelsFilePath } (texto não vazio)');
  return createNegotiationService({
    authorizeCrmOperation,
    repository: createJsonFileNegotiationRepository(filePath),
    funnelRepository: createJsonFileFunnelRepository(funnelsFilePath),
    crmRepository,
    crmService,
    catalogService,
  });
}

module.exports = { createFileBackedNegotiationService };
