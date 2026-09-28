// CRM-INTEGRATION sobre os arquivos locais — a peça de composição que liga a promoção Approval Queue → CRM à raiz de
// composição (src/server/index.js) sem que o servidor importe src/crm nem o domínio da fila (decisão 0016).
//
//   src/server/index.js -> createFileBackedCrmIntegrationService({ authorizeReviewer, authorizeOperation, queuePath, crmService })
//
// A fila e a auditoria de promoção continuam sendo construídas AQUI, sobre CAMINHOS (o mesmo desenho de sempre) —
// só o CRM Service mudou (etapa 3F, BLOCKER 1 da etapa 3E): antes, este arquivo construía o SEU PRÓPRIO CRM
// Service a partir de um { crmPath }, chamando createFileBackedCrmService() por conta própria. Isso só continuava
// seguro porque o REPOSITÓRIO por trás era reaproveitado por caminho (sharedFileCrmRepository, em
// crmFileService.js) — mas o Service em si (o objeto com createRecord/getRecord/...) era um TERCEIRO objeto,
// distinto do `crmService` que src/server/index.js já tinha montado via createConfiguredCrmService(). Isso
// funcionava só porque REPOSITORY_MODE=supabase estava bloqueado incondicionalmente ANTES de qualquer composição
// ser tentada; se um dia o bloqueio caísse sem mais nada, ESTE arquivo continuaria montando o CRM em ARQUIVO
// LOCAL, mesmo com REPOSITORY_MODE=supabase, porque nunca consultava o modo. Agora o `crmService` é INJETADO
// (decidido UMA VEZ, centralizadamente, por quem compõe — hoje sempre src/server/index.js, via
// createConfiguredCrmService) — este arquivo nunca mais decide qual adapter usar, nem consulta REPOSITORY_MODE ou
// process.env: só recebe o Service já pronto e o repassa. Isso garante, por CONSTRUÇÃO (não por coincidência de
// cache), que a promoção sempre opera sobre a MESMA instância que o CRM direto usa — em qualquer modo futuro.
// NÃO DECIDE NADA: nenhuma regra, nenhuma autorização própria, nenhum caminho padrão escondido — os Services continuam
// sendo os únicos que autorizam. Não há um segundo mecanismo de promoção: isto só compõe o que já existe.

const { createApprovalQueueService } = require('./approvalQueueService');
const { createApprovalPromotionService } = require('./approvalPromotionService');
const { createCrmIntegrationService } = require('./crmIntegrationService');

// queuePath pode faltar (o padrão é o da fila, como no Approval Queue Service).
function requirePath(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createFileBackedCrmIntegrationService exige { ${name} } (texto não vazio): o caminho é escolhido por quem compõe, nunca por um padrão escondido`);
  }
}

// crmService: o CRM Service JÁ PRONTO (de createConfiguredCrmService/createFileBackedCrmService — nunca construído
// aqui) — a mesma validação de forma que createCrmIntegrationService já faz, só antecipada para uma mensagem clara.
function requireCrmService(crmService) {
  if (!crmService || typeof crmService.listRecords !== 'function' || typeof crmService.getRecord !== 'function' || typeof crmService.createRecord !== 'function') {
    throw new Error('createFileBackedCrmIntegrationService exige { crmService } (o CRM Service já pronto, injetado por quem compõe — nunca um caminho: quem decide o adapter é a composição, uma única vez)');
  }
}

function createFileBackedCrmIntegrationService(dependencies) {
  const { authorizeReviewer, authorizeOperation, queuePath, crmService } = dependencies || {};
  if (queuePath !== undefined) requirePath(queuePath, 'queuePath');
  requireCrmService(crmService);
  return createCrmIntegrationService({
    approvalQueueService: createApprovalQueueService({ authorizeReviewer, queuePath }),
    approvalPromotionService: createApprovalPromotionService({ authorizeReviewer, queuePath }),
    crmService,
    authorizeOperation,
  });
}

module.exports = { createFileBackedCrmIntegrationService };
