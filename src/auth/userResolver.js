// User Resolver — liga uma VerifiedIdentity (a identidade que
// authAdapter.verifyAccessToken devolveu) a um USER Rio X7 já cadastrado, e
// produz o AuthorizationContext correspondente (Passo 0009.6 / decisão 0010;
// Fase D do fechamento da fronteira de identidade e autorização).
//
// Regras:
//  - A identidade de runtime é EXCLUSIVAMENTE o authUserId de uma
//    VerifiedIdentity (isVerifiedIdentity, do authAdapter): um objeto simples,
//    literal, cópia ou clone nunca é aceito (falha fechada).
//  - O e-mail NÃO participa da resolução nem da autorização: não há fallback
//    por e-mail, nem vínculo por e-mail, e nenhum USER é criado por conta
//    própria. Sem USER para o authUserId: USER_NOT_FOUND.
//  - O store só aceita USERs definidos por defineUser() e operacionais (com
//    authUserId), com userId e authUserId únicos.
//  - A marca de VerifiedIdentity é uma fronteira arquitetural interna
//    confiável, não criptografia (ver authAdapter.js).
//
// Este é um store EM MEMÓRIA — não é um banco real, não persiste em disco,
// não se conecta a nada externo. Representa o "schema esperado"
// (docs/decisions/0009-identity-roles-and-authorization-model.md, seção 1)
// de forma testável, sem inventar uma camada de persistência real que este
// passo não pediu e não deveria criar.

// O resolver é o ÚNICO módulo que emite AuthorizationContext (Fase C): usa o
// emissor interno, que só aceita um USER definido por defineUser() com authUserId.
const { isDefinedUser } = require('./user');
// isVerifiedIdentity é importada DIRETO do authAdapter (não é exportada pelo barrel).
const { isVerifiedIdentity } = require('./authAdapter');
const { issueAuthorizationContext } = require('./internal/contextIssuer');

// Erros do store e da resolução, com código estável (os testes afirmam pelo
// `code`, não pelo texto da mensagem).
const USER_RESOLUTION_ERROR = Object.freeze({
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  IDENTITY_NOT_VERIFIED: 'IDENTITY_NOT_VERIFIED',
  USER_NOT_DEFINED: 'USER_NOT_DEFINED',
  USER_NOT_OPERATIONAL: 'USER_NOT_OPERATIONAL',
  USER_ID_DUPLICATE: 'USER_ID_DUPLICATE',
  AUTH_USER_ID_DUPLICATE: 'AUTH_USER_ID_DUPLICATE',
});
const USER_NOT_FOUND = USER_RESOLUTION_ERROR.USER_NOT_FOUND;

class UserResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserResolutionError';
    this.code = code;
  }
}

// Store EM MEMÓRIA de USERs OPERACIONAIS. Só entra um USER que defineUser()
// devolveu (isDefinedUser) e que tem authUserId (a identidade técnica de
// runtime): um literal, cópia ou clone, ou um USER ainda sem vínculo, nunca
// entra. userId e authUserId são únicos — um duplicado é rejeitado, nunca
// sobrescreve nem escolhe "o primeiro".
function createUserStore(initialUsers = []) {
  const byUserId = new Map();
  const byAuthUserId = new Map();

  function add(user) {
    if (!isDefinedUser(user)) {
      throw new UserResolutionError(
        USER_RESOLUTION_ERROR.USER_NOT_DEFINED,
        'USER inválido para o store: só um USER definido por defineUser() entra — um objeto solto, cópia ou literal nunca é aceito'
      );
    }
    if (typeof user.authUserId !== 'string' || user.authUserId.length === 0) {
      throw new UserResolutionError(
        USER_RESOLUTION_ERROR.USER_NOT_OPERATIONAL,
        'USER inválido para o store: authUserId é obrigatório — só um USER operacional (com authUserId) entra no store'
      );
    }
    if (byUserId.has(user.userId)) {
      throw new UserResolutionError(USER_RESOLUTION_ERROR.USER_ID_DUPLICATE, 'USER duplicado: já existe um USER com este userId');
    }
    if (byAuthUserId.has(user.authUserId)) {
      throw new UserResolutionError(USER_RESOLUTION_ERROR.AUTH_USER_ID_DUPLICATE, 'USER duplicado: já existe um USER com este authUserId');
    }
    byUserId.set(user.userId, user);
    byAuthUserId.set(user.authUserId, user);
    return user;
  }

  for (const user of initialUsers) {
    add(user);
  }

  return {
    add,
    findByAuthUserId(authUserId) {
      if (typeof authUserId !== 'string' || authUserId.length === 0) return null;
      return byAuthUserId.get(authUserId) || null;
    },
    all() {
      return [...byUserId.values()];
    },
  };
}

// Resolve o USER EXCLUSIVAMENTE pelo authUserId de uma VerifiedIdentity:
//
//   VerifiedIdentity -> authUserId -> USER encontrado  -> AuthorizationContext
//                                  -> USER não encontrado -> USER_NOT_FOUND
//
// Não há fallback por e-mail, nem vínculo por e-mail, e nenhum USER é criado por
// conta própria. Cadastro de usuário é administração (MANAGE:USERS), fora do
// escopo. Só há dois parâmetros: nenhum role/permissions/e-mail do chamador tem
// como participar.
function resolveAuthorizationContext(userStore, verifiedIdentity) {
  if (!isVerifiedIdentity(verifiedIdentity)) {
    throw new UserResolutionError(
      USER_RESOLUTION_ERROR.IDENTITY_NOT_VERIFIED,
      'identidade não verificada: só uma VerifiedIdentity devolvida por verifyAccessToken é aceita — um objeto simples, literal, cópia ou clone nunca é aceito'
    );
  }

  const user = userStore.findByAuthUserId(verifiedIdentity.authUserId);
  if (!user) {
    throw new UserResolutionError(
      USER_NOT_FOUND,
      'usuário não encontrado: nenhum USER Rio X7 corresponde ao authUserId desta identidade verificada'
    );
  }

  return issueAuthorizationContext(user);
}

module.exports = { createUserStore, resolveAuthorizationContext, UserResolutionError, USER_RESOLUTION_ERROR, USER_NOT_FOUND };
