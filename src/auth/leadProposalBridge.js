// Ponte pequena e segura entre AuthorizationContext e a PROPOSTA de candidatos à Approval Queue (Prospecting Service).
//
// PROPOR ≠ APROVAR ≠ PROMOVER. Esta ponte autoriza uma única coisa — PROPOR candidatos para análise humana —, com a
// permissão PROPOSE:LEAD_APPROVAL. Ela NÃO autoriza aprovar/rejeitar (APPROVE:LEAD_APPROVAL, ponte do Approval Queue), NÃO autoriza
// promover (WRITE:CRM, ponte do CRM) e não devolve nada que dê essas permissões: só a identidade mínima de quem propõe.
// Quem tem só esta permissão não consegue aprovar nada, e quem tem só APPROVE:LEAD_APPROVAL não consegue propor.
//
// Mesmo desenho de approvalQueueBridge.js: depende só de authorizationContext.js e constants.js (não importa o domínio do
// Prospector), recusa por exceção, decide só pelo array `permissions` do contexto emitido (nunca pelo nome da role) e recusa qualquer
// outra permissão pedida (uma ponte, uma permissão).
const { requireActiveUser, requirePermission } = require('./authorizationContext');
const { PERMISSION } = require('./constants');

function authorizeProposerForLeadApproval(context, requiredPermission = PERMISSION.PROPOSE_LEAD_APPROVAL) {
  if (requiredPermission !== PERMISSION.PROPOSE_LEAD_APPROVAL) {
    throw new Error(
      `ponte de proposta só autoriza ${PERMISSION.PROPOSE_LEAD_APPROVAL}: permissão solicitada não suportada (${String(requiredPermission)})`
    );
  }
  const active = requireActiveUser(context);
  requirePermission(active, PERMISSION.PROPOSE_LEAD_APPROVAL);
  return { userId: active.userId, name: active.name, role: active.role };
}

module.exports = { authorizeProposerForLeadApproval };
