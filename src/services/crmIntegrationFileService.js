// CRM-INTEGRATION sobre os arquivos locais — a peça de composição que liga a promoção Approval Queue → CRM à raiz de
// composição (src/server/index.js) sem que o servidor importe src/crm nem o domínio da fila (decisão 0016).
//
//   src/server/index.js -> createFileBackedCrmIntegrationService({ authorizeReviewer, authorizeOperation, queuePath, crmPath })
//
// É o mesmo desenho de crmFileService.js: o servidor passa só CAMINHOS e as duas portas de autorização; aqui os Services
// existentes (fila, auditoria de promoção, CRM) são criados sobre esses arquivos e entregues ao serviço de promoção.
// NÃO DECIDE NADA: nenhuma regra, nenhuma autorização própria, nenhum caminho padrão escondido — os Services continuam
// sendo os únicos que autorizam. Não há um segundo mecanismo de promoção: isto só compõe o que já existe.

const { createApprovalQueueService } = require('./approvalQueueService');
const { createApprovalPromotionService } = require('./approvalPromotionService');
const { createFileBackedCrmService } = require('./crmFileService');
const { createCrmIntegrationService } = require('./crmIntegrationService');

// queuePath pode faltar (o padrão é o da fila, como no Approval Queue Service); crmPath é sempre explícito.
function requirePath(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createFileBackedCrmIntegrationService exige { ${name} } (texto não vazio): o caminho é escolhido por quem compõe, nunca por um padrão escondido`);
  }
}

function createFileBackedCrmIntegrationService(dependencies) {
  const { authorizeReviewer, authorizeOperation, queuePath, crmPath } = dependencies || {};
  if (queuePath !== undefined) requirePath(queuePath, 'queuePath');
  requirePath(crmPath, 'crmPath');
  return createCrmIntegrationService({
    approvalQueueService: createApprovalQueueService({ authorizeReviewer, queuePath }),
    approvalPromotionService: createApprovalPromotionService({ authorizeReviewer, queuePath }),
    crmService: createFileBackedCrmService({ authorizeOperation, filePath: crmPath }),
    authorizeOperation,
  });
}

module.exports = { createFileBackedCrmIntegrationService };
