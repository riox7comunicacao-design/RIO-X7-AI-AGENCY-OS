// Modelo de domínio do USER Rio X7 (schema conceitual da decisão 0009,
// formalizado como validação de código no Passo 0009.6 / decisão 0010).
//
// Este arquivo NÃO persiste nada em disco/rede — não é um banco de dados,
// não é um cliente Supabase. É só a definição + validação da estrutura que
// um USER real precisa ter, reutilizável por qualquer store futuro (em
// memória, aqui; um banco real, quando autorizado).
//
// Nunca aceita/armazena senha, token, ou qualquer segredo — isso nunca
// pertenceu a este modelo (Regra 8/9 do RULES.md; 0009, seção 1).

const { ROLE, USER_STATUS, isValidPermissionString } = require('./constants');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// authUserId é nullable propositalmente: um usuário pode ser cadastrado
// (convite) antes de completar o primeiro login no provedor de autenticação
// — só nesse momento o vínculo authUserId é preenchido (0009.5, seção B/F).
function defineUser({
  userId,
  authUserId = null,
  name,
  email,
  role,
  permissions,
  status,
  createdAt = new Date().toISOString(),
  updatedAt = new Date().toISOString(),
} = {}) {
  if (!isNonEmptyString(userId)) {
    throw new Error('USER inválido: userId é obrigatório');
  }
  if (authUserId !== null && !isNonEmptyString(authUserId)) {
    throw new Error('USER inválido: authUserId deve ser string ou null (nenhum login realizado ainda)');
  }
  if (!isNonEmptyString(name)) {
    throw new Error('USER inválido: name é obrigatório');
  }
  if (!isNonEmptyString(email) || !email.includes('@')) {
    throw new Error('USER inválido: email é obrigatório e deve ter um formato mínimo válido');
  }
  if (!Object.values(ROLE).includes(role)) {
    throw new Error(`USER inválido: role desconhecida "${role}"`);
  }
  if (!Array.isArray(permissions) || !permissions.every(isValidPermissionString)) {
    throw new Error('USER inválido: permissions deve ser uma lista de permissões no formato ACTION:DOMAIN');
  }
  if (!Object.values(USER_STATUS).includes(status)) {
    throw new Error(`USER inválido: status desconhecido "${status}"`);
  }
  if (!isNonEmptyString(createdAt) || !isNonEmptyString(updatedAt)) {
    throw new Error('USER inválido: createdAt/updatedAt são obrigatórios');
  }

  return Object.freeze({
    userId: userId.trim(),
    authUserId: authUserId === null ? null : authUserId.trim(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    role,
    permissions: Object.freeze([...permissions]),
    status,
    createdAt,
    updatedAt,
  });
}

module.exports = { defineUser };
