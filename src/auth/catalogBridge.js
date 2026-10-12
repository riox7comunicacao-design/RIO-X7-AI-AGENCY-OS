// Ponte entre AuthorizationContext e o Catalog Service — os catálogos do CRM: Serviços, Nichos e Origens dos Leads (CRM 5.0, Fase
// 2B-1, decisão 0026). Mesmo desenho de crmBridge.js e funnelBridge.js.
//
// authorizeCatalogOperation(context, requiredPermission) -> { userId, name, role }
//
// As ÚNICAS permissões que esta ponte autoriza são duas, e o Service escolhe qual cada operação exige (PERMISSION_FOR em
// src/services/catalogService.js):
//   READ:CRM              consultar os itens ATIVOS dos catálogos (a permissão de leitura do CRM que já existe — quem lê o CRM
//                          precisa ver as listas de escolha);
//   MANAGE:CRM_CATALOGS   administrar: criar, editar, reordenar, desativar, reativar e ver também os itens DESATIVADOS (só ADMIN).
// Qualquer outra permissão — inclusive omitida, null ou WRITE:CRM — é recusada, mesmo que o contexto a possua: nada se autoriza "por
// omissão". Devolve ao Service SÓ a identidade mínima ({ userId, name, role }) — nunca permissions, authUserId, e-mail ou token.
//
// Este módulo depende só de authorizationContext.js e constants.js (nada de src/crm nem de src/services): auth e domínio ficam
// desacoplados e sem dependência circular. Fronteira arquitetural interna confiável, não criptografia.
const { requireActiveUser, requirePermission } = require('./authorizationContext');
const { PERMISSION } = require('./constants');

const CATALOG_PERMISSIONS = Object.freeze([PERMISSION.READ_CRM, PERMISSION.MANAGE_CRM_CATALOGS]);

function authorizeCatalogOperation(context, requiredPermission) {
  if (!CATALOG_PERMISSIONS.includes(requiredPermission)) {
    throw new Error(`ponte dos catálogos do CRM só autoriza ${CATALOG_PERMISSIONS.join(' e ')}: permissão solicitada não suportada (${String(requiredPermission)})`);
  }
  const active = requireActiveUser(context);
  requirePermission(active, requiredPermission);
  return { userId: active.userId, name: active.name, role: active.role };
}

module.exports = { authorizeCatalogOperation, CATALOG_PERMISSIONS };
