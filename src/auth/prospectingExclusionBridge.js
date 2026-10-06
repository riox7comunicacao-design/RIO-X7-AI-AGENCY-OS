// Ponte entre AuthorizationContext e o Prospecting Permanent Exclusion Service (Workbench de Prospecção, Etapa
// 2 — Exclusões Permanentes) — mesmo desenho de funnelBridge.js/crmBridge.js.
//
// authorizeProspectingExclusionOperation(context, requiredPermission) -> { userId, name, role }
//
// A ÚNICA permissão que esta ponte autoriza é MANAGE:PROSPECTING_EXCLUSIONS — administrar a lista (criar, editar,
// ativar, desativar, consultar a gestão). A CHECAGEM AUTOMÁTICA de uma exclusão durante a ingestão de achados
// (isExcluded) NÃO passa por aqui: é um checker interno de sistema, sem autorização própria — o humano que chama
// ingestFindings já foi autorizado (PROPOSE:LEAD_APPROVAL) antes de chegar lá (mesmo princípio de
// hasActiveFunnelCards em crmService.js).
const { requireActiveUser, requirePermission } = require('./authorizationContext');
const { PERMISSION } = require('./constants');

const PROSPECTING_EXCLUSION_PERMISSIONS = Object.freeze([PERMISSION.MANAGE_PROSPECTING_EXCLUSIONS]);

function authorizeProspectingExclusionOperation(context, requiredPermission) {
  if (!PROSPECTING_EXCLUSION_PERMISSIONS.includes(requiredPermission)) {
    throw new Error(
      `ponte de Exclusões Permanentes só autoriza ${PROSPECTING_EXCLUSION_PERMISSIONS.join(' e ')}: permissão solicitada não suportada (${String(requiredPermission)})`
    );
  }
  const active = requireActiveUser(context);
  requirePermission(active, requiredPermission);
  return { userId: active.userId, name: active.name, role: active.role };
}

module.exports = { authorizeProspectingExclusionOperation, PROSPECTING_EXCLUSION_PERMISSIONS };
