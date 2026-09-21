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
//
// As permissões efetivas de um USER são DETERMINADAS PELA ROLE (constants.js:
// ROLE_PERMISSIONS) — não há customização por usuário nesta etapa. O campo
// `permissions` do USER é sempre a lista canônica da role. Por compatibilidade
// transitória, defineUser() ainda aceita um `permissions` explícito, mas SOMENTE
// quando for exatamente o conjunto da role; qualquer outro conjunto é rejeitado.
//
// Marca interna (Fase C): defineUser() registra cada USER que devolve em um
// registro privado deste módulo, e isDefinedUser() só reconhece objetos
// efetivamente devolvidos por defineUser() — nunca um literal, uma cópia ou um
// clone com os mesmos campos (a marca é por identidade de objeto). Isto é uma
// fronteira arquitetural interna confiável (trusted internal architectural
// boundary), NÃO um mecanismo criptográfico: não autentica ninguém e não
// protege contra código malicioso que já controle o mesmo processo. O contrato
// de campos do USER não mudou.

const { ROLE, USER_STATUS, isValidPermissionString, getRolePermissions } = require('./constants');

// Registro interno dos USERs devolvidos por defineUser (ver o cabeçalho). Só
// defineUser registra; nenhuma função exportada marca objetos.
const DEFINED_USERS = new WeakSet();

// true somente para um objeto que defineUser() efetivamente devolveu. Nunca
// lança, seja qual for o valor recebido.
function isDefinedUser(value) {
  return typeof value === 'object' && value !== null && DEFINED_USERS.has(value);
}

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
  // `permissions` é OPCIONAL (compatibilidade transitória): quando informado,
  // precisa ser uma lista de permissões válidas — e, mais abaixo, exatamente o
  // conjunto da role. Só `undefined` significa "omitido"; qualquer outro valor
  // que não seja uma lista válida (null, string, objeto…) continua rejeitado.
  if (permissions !== undefined && (!Array.isArray(permissions) || !permissions.every(isValidPermissionString))) {
    throw new Error('USER inválido: permissions deve ser uma lista de permissões no formato ACTION:DOMAIN');
  }
  if (!Object.values(USER_STATUS).includes(status)) {
    throw new Error(`USER inválido: status desconhecido "${status}"`);
  }
  if (!isNonEmptyString(createdAt) || !isNonEmptyString(updatedAt)) {
    throw new Error('USER inválido: createdAt/updatedAt são obrigatórios');
  }

  // ÚLTIMA validação (preserva a precedência dos erros acima). As permissões
  // efetivas vêm da role; um `permissions` explícito só é aceito se for
  // exatamente o conjunto da role — mesmos membros e mesma contagem, em
  // qualquer ordem, ou seja, sem faltar, sobrar nem repetir nenhuma.
  const rolePermissions = getRolePermissions(role);
  if (
    permissions !== undefined &&
    !(permissions.length === rolePermissions.length && rolePermissions.every((permission) => permissions.includes(permission)))
  ) {
    throw new Error(
      `USER inválido: permissions não podem diferir das permissions da role ${role} ` +
        '(as permissões efetivas são determinadas pela role; não há customização por usuário — omita "permissions" ou informe exatamente o conjunto da role)'
    );
  }

  const user = Object.freeze({
    userId: userId.trim(),
    authUserId: authUserId === null ? null : authUserId.trim(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    role,
    permissions: Object.freeze([...rolePermissions]),
    status,
    createdAt,
    updatedAt,
  });
  // Único ponto que registra um USER: o fim de defineUser, depois de todas as validações.
  DEFINED_USERS.add(user);
  return user;
}

module.exports = { defineUser, isDefinedUser };
