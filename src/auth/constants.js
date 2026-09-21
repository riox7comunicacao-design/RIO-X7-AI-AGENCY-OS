// Fundação de identidade e autorização (Passo 0009.6 / decisão 0010).
//
// AUTHENTICATION != AUTHORIZATION: este módulo não autentica ninguém — quem
// autentica é o Supabase Auth (ver authAdapter.js). Este módulo só responde
// "essa pessoa já autenticada pode fazer o quê", a partir de ROLE/PERMISSION
// mantidos inteiramente pela Rio X7 (0009-identity-roles-and-authorization-model.md).

// As 9 ações conceituais já documentadas em permissions-matrix.md, mais
// MANAGE — explicitamente introduzida pelo Passo 0009.6 para a permissão
// MANAGE:USERS (administração de usuários, restrita ao ADMIN). Uma permissão
// sempre tem a forma {ACTION}:{DOMAIN} — o DOMAIN é livre e extensível (novos
// domínios não exigem mudança neste arquivo), mas a ACTION é fechada nesta
// lista.
const ACTION = Object.freeze({
  READ: 'READ',
  ANALYZE: 'ANALYZE',
  PROPOSE: 'PROPOSE',
  WRITE: 'WRITE',
  EXECUTE: 'EXECUTE',
  SEND: 'SEND',
  PUBLISH: 'PUBLISH',
  DELETE: 'DELETE',
  APPROVE: 'APPROVE',
  MANAGE: 'MANAGE',
});

// Papéis humanos confirmados até 0009. Nenhum outro role é criado aqui sem
// necessidade real — role é rótulo organizacional, nunca implica permissão
// por si só (ROLE != PERMISSION, seção 7 do Passo 0009.6).
const ROLE = Object.freeze({
  ADMIN: 'ADMIN',
  COMMERCIAL_CLOSER: 'COMMERCIAL_CLOSER',
});

const USER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
});

// Permissões já nomeadas/aprovadas até este passo. Esta lista pode crescer
// no futuro (novos domínios) sem alterar o formato ou a lógica de checagem —
// só isValidPermissionString() precisa reconhecer o formato, não cada valor.
const PERMISSION = Object.freeze({
  READ_CRM: 'READ:CRM',
  ANALYZE_CRM: 'ANALYZE:CRM',
  PROPOSE_CRM: 'PROPOSE:CRM',
  WRITE_CRM: 'WRITE:CRM',
  APPROVE_LEAD_APPROVAL: 'APPROVE:LEAD_APPROVAL',
  APPROVE_OUTBOUND_APPROVAL: 'APPROVE:OUTBOUND_APPROVAL',
  MANAGE_USERS: 'MANAGE:USERS',
});

const PERMISSION_FORMAT = /^[A-Z][A-Z0-9_]*:[A-Z][A-Z0-9_]*$/;

// Valida só a FORMA e se a ação (prefixo) é uma das 10 reconhecidas — nunca
// decide se um usuário específico deve ou não ter essa permissão (isso é
// hasPermission/requirePermission, em authorizationContext.js).
function isValidPermissionString(permission) {
  if (typeof permission !== 'string' || !PERMISSION_FORMAT.test(permission)) {
    return false;
  }
  const action = permission.split(':')[0];
  return Object.values(ACTION).includes(action);
}

// Permissões EFETIVAS por role (Fase A do fechamento da fronteira de
// identidade e autorização).
//
// Decisão do proprietário: as permissões efetivas de um USER são determinadas
// pela ROLE — não há customização por usuário nesta etapa (se um dia for
// necessária, será outro projeto arquitetural, nunca uma extensão silenciosa
// deste arquivo). Por isso cada role tem UMA lista literal e explícita, que
// NÃO é derivada do enum global PERMISSION: adicionar uma permissão nova ao
// enum não a concede a nenhuma role. Quem a adiciona precisa decidir,
// explicitamente, se ADMIN e COMMERCIAL_CLOSER a recebem e editar as listas
// abaixo — tests/auth/role-permissions.test.js falha até essa decisão ser
// tomada.
//
// ROLE != PERMISSION continua valendo: a role é o rótulo e a fonte destas
// listas, lidas quando o USER é criado (defineUser). As checagens de
// autorização (hasPermission/requirePermission) leem apenas o array
// `permissions` do contexto — nunca comparam o nome da role.
//
// ADMIN: exatamente as 7 permissões abaixo — nunca um coringa "*:*" (proibido
// pela decisão 0010, seção 10).
const ADMIN_PERMISSIONS = Object.freeze([
  PERMISSION.READ_CRM,
  PERMISSION.ANALYZE_CRM,
  PERMISSION.PROPOSE_CRM,
  PERMISSION.WRITE_CRM,
  PERMISSION.APPROVE_LEAD_APPROVAL,
  PERMISSION.APPROVE_OUTBOUND_APPROVAL,
  PERMISSION.MANAGE_USERS,
]);

// COMMERCIAL_CLOSER: exatamente as 5 permissões abaixo — WRITE:CRM e
// MANAGE:USERS ficam de fora, propositalmente.
const COMMERCIAL_CLOSER_PERMISSIONS = Object.freeze([
  PERMISSION.READ_CRM,
  PERMISSION.ANALYZE_CRM,
  PERMISSION.PROPOSE_CRM,
  PERMISSION.APPROVE_LEAD_APPROVAL,
  PERMISSION.APPROVE_OUTBOUND_APPROVAL,
]);

const ROLE_PERMISSIONS = Object.freeze({
  [ROLE.ADMIN]: ADMIN_PERMISSIONS,
  [ROLE.COMMERCIAL_CLOSER]: COMMERCIAL_CLOSER_PERMISSIONS,
});

// Devolve a lista canônica (congelada) de permissões efetivas de uma role.
// Lança para qualquer valor fora de ROLE — inclusive nomes herdados do
// protótipo ("constructor", "__proto__"), que nunca são roles.
function getRolePermissions(role) {
  if (!Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role)) {
    throw new Error(`role desconhecida "${String(role)}": nenhuma permissão definida`);
  }
  return ROLE_PERMISSIONS[role];
}

// Nome antigo (Passo 0009.6), mantido como alias do MESMO objeto para não
// quebrar os usos existentes. Código novo deve usar ROLE_PERMISSIONS.
const ROLE_PERMISSION_TEMPLATE = ROLE_PERMISSIONS;

module.exports = {
  ACTION,
  ROLE,
  USER_STATUS,
  PERMISSION,
  ADMIN_PERMISSIONS,
  COMMERCIAL_CLOSER_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_PERMISSION_TEMPLATE,
  getRolePermissions,
  isValidPermissionString,
};
