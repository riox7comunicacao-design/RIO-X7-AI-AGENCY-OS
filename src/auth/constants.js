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

// Valida só a FORMA e se a ação (prefixo) é uma das 9 reconhecidas — nunca
// decide se um usuário específico deve ou não ter essa permissão (isso é
// hasPermission/requirePermission, em authorizationContext.js).
function isValidPermissionString(permission) {
  if (typeof permission !== 'string' || !PERMISSION_FORMAT.test(permission)) {
    return false;
  }
  const action = permission.split(':')[0];
  return Object.values(ACTION).includes(action);
}

// Template de permissões por role — usado SÓ como ponto de partida ao criar
// (seedar) um usuário. Nunca é lido em tempo de checagem de autorização
// (hasPermission/requirePermission sempre leem o array `permissions` já
// persistido no próprio USER, nunca derivam nada a partir do `role`) — isso
// é o que preserva ROLE != PERMISSION na prática, não só na intenção.
//
// ADMIN recebe, explicitamente, cada permissão já nomeada até este passo —
// nunca um coringa "*:*" (proibido pela decisão 0010, seção 10). Qualquer
// privilégio administrativo adicional no futuro precisa ser nomeado aqui
// explicitamente, nunca presumido a partir do role.
//
// COMMERCIAL_CLOSER recebe exatamente o conjunto aprovado no Passo 0009.6 —
// nenhum poder adicional foi presumido além do que foi explicitamente
// autorizado (MANAGE:USERS fica de fora, propositalmente).
const ROLE_PERMISSION_TEMPLATE = Object.freeze({
  [ROLE.ADMIN]: Object.freeze(Object.values(PERMISSION)),
  [ROLE.COMMERCIAL_CLOSER]: Object.freeze([
    PERMISSION.READ_CRM,
    PERMISSION.ANALYZE_CRM,
    PERMISSION.PROPOSE_CRM,
    PERMISSION.APPROVE_LEAD_APPROVAL,
    PERMISSION.APPROVE_OUTBOUND_APPROVAL,
  ]),
});

module.exports = {
  ACTION,
  ROLE,
  USER_STATUS,
  PERMISSION,
  ROLE_PERMISSION_TEMPLATE,
  isValidPermissionString,
};
