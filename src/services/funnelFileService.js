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

// Etapa "Funis 2 — correção final de integridade CRM ↔ Card": a ABSTRAÇÃO que o CRM Service usa (por injeção,
// `hasActiveFunnelCards` — ver o cabeçalho de src/services/crmService.js) para recusar excluir um registro do CRM
// que ainda tenha Cards ativos, SEM que o CRM (nem src/server/, que nunca pode importar src/crm/ — regra R12)
// importe o domínio ou o adapter de Funil diretamente. Devolve só uma FUNÇÃO `(crmRecordId) => número de cards
// ativos` — nunca o repositório inteiro: o CRM Service não tem nenhum uso para os outros 17 métodos da porta de
// Funil, e não deveria conhecê-los. O adapter de arquivo é sem estado (cada chamada relê o disco — ver
// funnelRepository.js), então construir aqui uma instância PRÓPRIA (em vez de reaproveitar a que
// createFileBackedFunnelService cria por baixo) nunca diverge: as duas leem e enxergam o MESMO arquivo.
function createFileBackedActiveFunnelCardsChecker({ filePath } = {}) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createFileBackedActiveFunnelCardsChecker exige { filePath } (texto não vazio)');
  }
  const repository = createJsonFileFunnelRepository(filePath);
  return (crmRecordId) => repository.countActiveCardsByCrmRecord(crmRecordId);
}

module.exports = { createFileBackedFunnelService, createFileBackedActiveFunnelCardsChecker };
