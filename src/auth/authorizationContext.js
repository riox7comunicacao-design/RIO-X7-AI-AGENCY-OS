// AuthorizationContext — a identidade humana autenticada que está executando
// uma ação, já resolvida e validada (Passo 0009.6 / decisão 0010).
//
// REGRA CENTRAL: a única forma legítima de obter um AuthorizationContext é
// chamar createAuthorizationContext() com um USER já resolvido (ver
// userResolver.js). Nenhum especialista de IA, nenhum código de orquestração,
// deve construir esse objeto à mão — hasPermission()/requirePermission()
// recusam qualquer objeto que não tenha sido produzido por esta função (ver
// assertIsAuthorizationContext abaixo). Isso não é prova criptográfica de
// origem — é uma mitigação estrutural, documentada como tal.

const { ROLE, USER_STATUS, isValidPermissionString } = require('./constants');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Constrói o contexto a partir de um USER já resolvido (defineUser() ou
// equivalente). Não faz nenhuma verificação de sessão/token — isso já
// aconteceu antes, na resolução do USER (authAdapter.js + userResolver.js).
function createAuthorizationContext(user) {
  if (!user || typeof user !== 'object') {
    throw new Error('AuthorizationContext inválido: um USER resolvido é obrigatório');
  }
  const { userId, name, role, permissions, status } = user;

  if (!isNonEmptyString(userId)) {
    throw new Error('AuthorizationContext inválido: userId é obrigatório');
  }
  if (!isNonEmptyString(name)) {
    throw new Error('AuthorizationContext inválido: name é obrigatório');
  }
  if (!Object.values(ROLE).includes(role)) {
    throw new Error(`AuthorizationContext inválido: role desconhecida "${role}"`);
  }
  if (!Array.isArray(permissions) || !permissions.every(isValidPermissionString)) {
    throw new Error('AuthorizationContext inválido: permissions deve ser uma lista de permissões válidas');
  }
  if (!Object.values(USER_STATUS).includes(status)) {
    throw new Error(`AuthorizationContext inválido: status desconhecido "${status}"`);
  }

  // Object.freeze aqui é o que assertIsAuthorizationContext() verifica
  // depois — um objeto fabricado à mão por outro código, mesmo com a forma
  // certa, não é frozen por esta função e é rejeitado (defesa em profundidade,
  // não uma garantia absoluta: nada impede alguém de chamar Object.freeze()
  // sobre um objeto forjado, mas isso deixa de ser um acidente e passa a
  // exigir intenção deliberada de contornar a regra).
  return Object.freeze({
    userId: userId.trim(),
    name: name.trim(),
    role,
    permissions: Object.freeze([...permissions]),
    status,
  });
}

function assertIsAuthorizationContext(context) {
  if (!context || typeof context !== 'object' || !Object.isFrozen(context)) {
    throw new Error(
      'AuthorizationContext inválido: objeto precisa ter sido criado por createAuthorizationContext() — ' +
        'um objeto solto (ex.: fabricado por um especialista de IA para simular um humano) nunca é aceito'
    );
  }
  if (
    !isNonEmptyString(context.userId) ||
    !isNonEmptyString(context.name) ||
    !Object.values(ROLE).includes(context.role) ||
    !Array.isArray(context.permissions) ||
    !Object.values(USER_STATUS).includes(context.status)
  ) {
    throw new Error('AuthorizationContext inválido: forma inesperada');
  }
}

function requireActiveUser(context) {
  assertIsAuthorizationContext(context);
  if (context.status !== USER_STATUS.ACTIVE) {
    throw new Error(`usuário inativo: ação recusada para userId=${context.userId}`);
  }
  return context;
}

// Consulta pura (booleana) — nunca lança só porque o usuário está inativo ou
// não tem a permissão (esses são resultados válidos: `false`); só lança para
// entrada estruturalmente inválida (contexto forjado, permissão malformada),
// que são erros de programação, não decisões de autorização. Nunca retorna
// `true` por omissão/fallback — usuário INACTIVE sempre resulta em `false`.
function hasPermission(context, permission) {
  assertIsAuthorizationContext(context);
  if (!isValidPermissionString(permission)) {
    throw new Error(`permissão inválida solicitada na checagem: ${permission}`);
  }
  return context.status === USER_STATUS.ACTIVE && context.permissions.includes(permission);
}

// Guarda de autorização — lança sempre que a ação não puder prosseguir.
// NUNCA implementa "se a permissão não existir, libere" (proibido pela
// decisão 0010, seção 9).
function requirePermission(context, permission) {
  requireActiveUser(context);
  if (!isValidPermissionString(permission)) {
    throw new Error(`permissão inválida solicitada na checagem: ${permission}`);
  }
  if (!context.permissions.includes(permission)) {
    throw new Error(`acesso negado: userId=${context.userId} não possui a permissão ${permission}`);
  }
  return context;
}

module.exports = {
  createAuthorizationContext,
  assertIsAuthorizationContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
};
