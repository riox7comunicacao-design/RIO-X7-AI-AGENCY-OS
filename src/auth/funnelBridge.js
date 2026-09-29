// Ponte entre AuthorizationContext e o Funnel Service (reestruturação Prospecção/CRM/Funis, Etapa "Funis 1") —
// mesmo desenho de crmBridge.js/approvalQueueBridge.js.
//
// authorizeFunnelOperation(context, requiredPermission) -> { userId, name, role }
//
// A ÚNICA permissão que esta ponte autoriza é MANAGE:FUNNELS (criar/editar/copiar/excluir/reordenar funil ou
// etapa). Mover um CARD entre etapas (Etapa "Funis 2") NÃO passa por aqui — é uma operação sobre um registro do
// CRM, e reusa authorizeCrmOperation (READ:CRM/WRITE:CRM) de propósito, para não inventar uma segunda porta de
// autorização para a mesma ação de sempre.
const { requireActiveUser, requirePermission } = require('./authorizationContext');
const { PERMISSION } = require('./constants');

const FUNNEL_PERMISSIONS = Object.freeze([PERMISSION.MANAGE_FUNNELS]);

function authorizeFunnelOperation(context, requiredPermission) {
  if (!FUNNEL_PERMISSIONS.includes(requiredPermission)) {
    throw new Error(`ponte de Funis só autoriza ${FUNNEL_PERMISSIONS.join(' e ')}: permissão solicitada não suportada (${String(requiredPermission)})`);
  }
  const active = requireActiveUser(context);
  requirePermission(active, requiredPermission);
  return { userId: active.userId, name: active.name, role: active.role };
}

module.exports = { authorizeFunnelOperation, FUNNEL_PERMISSIONS };
