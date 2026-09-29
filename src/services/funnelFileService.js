// Funnel Service sobre o adapter de ARQUIVO local — peça de composição que liga Funis à raiz de composição
// (src/server/index.js), mesmo desenho de crmFileService.js. O servidor passa só um CAMINHO
// (RIO_X7_FUNNELS_PATH), nunca um adapter nem o domínio.
const { createFunnelService } = require('./funnelService');
const { createJsonFileFunnelRepository } = require('../crm/funnelRepository');

function createFileBackedFunnelService(dependencies) {
  const { authorizeOperation, filePath } = dependencies || {};
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createFileBackedFunnelService exige { filePath } (texto não vazio)');
  }
  return createFunnelService({ authorizeOperation, repository: createJsonFileFunnelRepository(filePath) });
}

module.exports = { createFileBackedFunnelService };
