// User Resolver — liga uma identidade autenticada (authUserId/email, vinda
// do authAdapter.js) a um USER Rio X7 já cadastrado, e produz o
// AuthorizationContext correspondente (Passo 0009.6 / decisão 0010).
//
// Este é um store EM MEMÓRIA — não é um banco real, não persiste em disco,
// não se conecta a nada externo. Representa o "schema esperado"
// (docs/decisions/0009-identity-roles-and-authorization-model.md, seção 1)
// de forma testável, sem inventar uma camada de persistência real que este
// passo não pediu e não deveria criar.

// O resolver é o ÚNICO módulo que emite AuthorizationContext (Fase C): usa o
// emissor interno, que só aceita um USER definido por defineUser() com authUserId.
const { issueAuthorizationContext } = require('./internal/contextIssuer');

function createUserStore(initialUsers = []) {
  const byUserId = new Map();
  for (const user of initialUsers) {
    byUserId.set(user.userId, user);
  }

  return {
    add(user) {
      byUserId.set(user.userId, user);
      return user;
    },
    findByAuthUserId(authUserId) {
      if (!authUserId) return null;
      for (const user of byUserId.values()) {
        if (user.authUserId === authUserId) return user;
      }
      return null;
    },
    findByEmail(email) {
      if (!email) return null;
      const normalized = String(email).trim().toLowerCase();
      for (const user of byUserId.values()) {
        if (user.email === normalized) return user;
      }
      return null;
    },
    all() {
      return [...byUserId.values()];
    },
  };
}

// Resolve o USER a partir da identidade que o authAdapter devolveria após um
// login real (authUserId sempre; email como apoio para o primeiro login,
// quando o convite já existe mas o vínculo authUserId ainda não foi feito —
// ver 0009.5, seção F). Este resolver NUNCA cria um usuário novo por conta
// própria — só localiza um já cadastrado; cadastro de usuário é
// administração (MANAGE:USERS), fora do escopo deste passo (seção 18).
function resolveAuthorizationContext(userStore, { authUserId, email } = {}) {
  if (!authUserId && !email) {
    throw new Error('resolução de identidade inválida: authUserId ou email é obrigatório');
  }

  let user = userStore.findByAuthUserId(authUserId);
  if (!user && email) {
    user = userStore.findByEmail(email);
  }

  if (!user) {
    throw new Error('usuário não encontrado: nenhum USER Rio X7 corresponde a esta identidade autenticada');
  }

  return issueAuthorizationContext(user);
}

module.exports = { createUserStore, resolveAuthorizationContext };
