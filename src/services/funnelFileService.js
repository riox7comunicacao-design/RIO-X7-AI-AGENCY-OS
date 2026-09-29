// Funnel Service sobre o adapter de ARQUIVO local — peça de composição que liga Funis à raiz de composição
// (src/server/index.js), mesmo desenho de crmFileService.js. O servidor passa só um CAMINHO
// (RIO_X7_FUNNELS_PATH), nunca um adapter nem o domínio. `crmRepository`/`crmService` (Etapa "Funis 2") vêm
// PRONTOS de quem compõe — o mesmo `crmRepository`/`crmService` que REPOSITORY_MODE decidiu para o CRM (nunca
// uma segunda instância): ver o cabeçalho de src/server/index.js.
const { createFunnelService } = require('./funnelService');
const { createJsonFileFunnelRepository } = require('../crm/funnelRepository');

function createFileBackedFunnelService(dependencies) {
  const { authorizeOperation, authorizeCrmOperation, filePath, crmRepository, crmService } = dependencies || {};
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createFileBackedFunnelService exige { filePath } (texto não vazio)');
  }
  return createFunnelService({
    authorizeOperation,
    authorizeCrmOperation,
    repository: createJsonFileFunnelRepository(filePath),
    crmRepository,
    crmService,
  });
}

module.exports = { createFileBackedFunnelService };
