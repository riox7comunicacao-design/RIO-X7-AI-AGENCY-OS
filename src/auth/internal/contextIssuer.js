// Emissor único de AuthorizationContext (Fase C do fechamento da fronteira de
// identidade e autorização).
//
// PRIVADO: este arquivo NÃO é exportado pelo barrel de src/auth. Só deve ser
// importado por userResolver.js (o resolver confiável, que emite) e por
// authorizationContext.js (que apenas CONSULTA a marca). Código de negócio
// nunca o importa; um teste estático de fronteiras (Fase F) vigia isso.
//
// O emissor:
//  - aceita SOMENTE um USER reconhecido por isDefinedUser(), isto é, devolvido
//    por defineUser();
//  - exige authUserId não nulo (a identidade técnica de runtime);
//  - deriva SEMPRE as permissions da ROLE, pela fonte canônica
//    (constants.getRolePermissions) — nunca confia em user.permissions;
//  - acrescenta authUserId ao contexto, congela o contexto e o marca como
//    emitido.
//
// A marca é por IDENTIDADE DE OBJETO: um literal, uma cópia ou um clone com os
// mesmos campos NÃO é reconhecido por isIssuedAuthorizationContext(). Isto é
// uma fronteira arquitetural interna confiável (trusted internal architectural
// boundary), NÃO um mecanismo criptográfico: não autentica ninguém e não
// protege contra código malicioso que já tenha controle do mesmo processo (que
// pode importar este arquivo, substituir funções ou fabricar o próprio
// registro). A autenticação real continua sendo a verificação do access token
// pelo servidor do Supabase (authAdapter.verifyAccessToken).

// A fonte canônica role -> permissions é lida pelo objeto do módulo, na hora da
// emissão (não desestruturada no carregamento), para que os testes provem que
// as permissions efetivas nascem dela e não do USER.
const constants = require('../constants');
const { isDefinedUser } = require('../user');

// Registro interno dos contextos emitidos. Só issueAuthorizationContext registra.
const ISSUED_CONTEXTS = new WeakSet();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Emite o AuthorizationContext de um USER definido. INACTIVE também emite: o
// contexto carrega o status e toda ação protegida o recusa (requireActiveUser).
function issueAuthorizationContext(user) {
  if (!isDefinedUser(user)) {
    throw new Error(
      'AuthorizationContext inválido: só um USER definido por defineUser() pode originar um contexto — ' +
        'um objeto solto, cópia ou literal (ex.: fabricado por um especialista de IA para simular um humano) nunca é aceito'
    );
  }
  if (!isNonEmptyString(user.authUserId)) {
    throw new Error(
      'AuthorizationContext inválido: authUserId é obrigatório — a identidade de runtime é o authUserId; ' +
        'um USER ainda sem vínculo com o provedor de autenticação não emite contexto'
    );
  }

  // As permissões efetivas vêm SEMPRE da role, pela fonte canônica — nunca de
  // user.permissions. Cópia congelada: nunca o mesmo array da tabela.
  const permissions = Object.freeze([...constants.getRolePermissions(user.role)]);

  const context = Object.freeze({
    userId: user.userId,
    authUserId: user.authUserId,
    name: user.name,
    role: user.role,
    permissions,
    status: user.status,
  });
  ISSUED_CONTEXTS.add(context);
  return context;
}

// true somente para um objeto que issueAuthorizationContext() efetivamente
// devolveu. Nunca lança, seja qual for o valor recebido.
function isIssuedAuthorizationContext(value) {
  return typeof value === 'object' && value !== null && ISSUED_CONTEXTS.has(value);
}

module.exports = { issueAuthorizationContext, isIssuedAuthorizationContext };
