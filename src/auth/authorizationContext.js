// AuthorizationContext — a identidade humana autenticada que está executando
// uma ação, já resolvida e validada (Passo 0009.6 / decisão 0010; emissão
// fechada na Fase C do fechamento da fronteira de identidade e autorização).
//
// REGRA CENTRAL: este módulo NÃO emite contextos — só os VERIFICA. A única
// forma de obter um AuthorizationContext é o emissor interno
// (internal/contextIssuer.js), que só aceita um USER definido por defineUser()
// com authUserId, deriva as permissions da role e é chamado apenas pelo
// userResolver. hasPermission()/requirePermission()/requireActiveUser() recusam
// qualquer objeto que o emissor não tenha emitido: um literal, uma cópia ou um
// clone com a forma exata de um contexto (mesmo congelado) não é aceito.
//
// Isto é uma fronteira arquitetural interna confiável (trusted internal
// architectural boundary), NÃO um mecanismo criptográfico: impede que código de
// negócio trate por engano — ou por ingenuidade — um objeto qualquer como
// contexto, e faz a violação aparecer em teste. Não protege contra código
// malicioso que já tenha controle do mesmo processo (que pode importar o
// emissor, substituir funções ou fabricar o próprio registro).
//
// Nenhuma checagem abaixo lê `role`: as decisões usam só `permissions` e
// `status` do contexto (ROLE != PERMISSION).

const { USER_STATUS, isValidPermissionString } = require('./constants');
const { isIssuedAuthorizationContext } = require('./internal/contextIssuer');

// A marca vem ANTES de qualquer outra verificação: um objeto que o emissor não
// emitiu é rejeitado mesmo que tenha a forma exata de um contexto.
function assertIsAuthorizationContext(context) {
  if (!isIssuedAuthorizationContext(context)) {
    throw new Error(
      'AuthorizationContext inválido: objeto não foi emitido pelo emissor interno confiável — ' +
        'um objeto solto (ex.: fabricado por um especialista de IA para simular um humano) nunca é aceito'
    );
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
// entrada estruturalmente inválida (contexto não emitido, permissão malformada),
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

// Este módulo só exporta VERIFICAÇÕES. O antigo createAuthorizationContext deixou
// de existir como construtor público: a emissão é do emissor interno.
module.exports = {
  assertIsAuthorizationContext,
  requireActiveUser,
  hasPermission,
  requirePermission,
};
