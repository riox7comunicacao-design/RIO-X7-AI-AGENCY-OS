// Ponte pequena e segura entre AuthorizationContext e o Approval Queue
// (Passo 0009.6 / decisão 0010, seção 13; inversão de dependência na Fase E do
// fechamento da fronteira de identidade e autorização).
//
// O Approval Queue (src/research-prospector/approvalQueue.js) não importa
// src/auth: ele recebe, por injeção, uma PORTA
//
//   authorizeReviewer(context, requiredPermission) -> { userId, name, role }
//
// e authorizeReviewerForApprovalQueue, abaixo, é o ADAPTADOR dessa porta. Ele
// só conhece o AuthorizationContext e as verificações de authorizationContext.js
// — nenhuma lógica da fila (estados, transições, DNC, histórico) vive aqui — e
// devolve ao domínio SOMENTE a identidade mínima de que ele precisa.
//
// Este módulo depende só de authorizationContext.js e constants.js — não importa
// nada de src/research-prospector/*, mantendo os dois domínios desacoplados e
// sem dependência circular. Quem liga os dois é o chamador (hoje, os testes;
// depois, a camada de Services): createApprovalReviewActions({ authorizeReviewer:
// authorizeReviewerForApprovalQueue }).
//
// Fronteira arquitetural interna confiável, não criptografia: a ponte decide
// sobre um AuthorizationContext emitido pelo emissor interno; não protege
// contra código que controle o mesmo processo e injete outro autorizador.
const { requireActiveUser, requirePermission } = require('./authorizationContext');
const { PERMISSION } = require('./constants');

// Autoriza a revisão (aprovar/rejeitar) de um prospect da fila. Lança — nunca
// devolve "não autorizado" — quando qualquer condição falha:
//  - `context` não é um AuthorizationContext emitido (objeto simples, literal,
//    cópia ou clone, mesmo com a forma perfeita, nunca é aceito);
//  - o usuário está inativo;
//  - o contexto não possui APPROVE:LEAD_APPROVAL (a decisão lê só `permissions`,
//    nunca o nome da role: ROLE != PERMISSION);
//  - a porta pediu OUTRA permissão. Esta ponte autoriza uma única coisa — a
//    revisão da fila —, então um pedido diferente (deriva do domínio, ou uso
//    indevido) é recusado em vez de ser atendido com a permissão errada.
//
// Omitir `requiredPermission` equivale a pedir a permissão da fila.
//
// A checagem de usuário ativo é chamada de forma EXPLÍCITA, embora
// requirePermission também a faça: a ponte não depende de um detalhe de
// implementação de outro módulo para recusar um usuário INACTIVE.
function authorizeReviewerForApprovalQueue(context, requiredPermission = PERMISSION.APPROVE_LEAD_APPROVAL) {
  if (requiredPermission !== PERMISSION.APPROVE_LEAD_APPROVAL) {
    throw new Error(
      `ponte do Approval Queue só autoriza ${PERMISSION.APPROVE_LEAD_APPROVAL}: permissão solicitada não suportada (${String(requiredPermission)})`
    );
  }
  const active = requireActiveUser(context);
  requirePermission(active, PERMISSION.APPROVE_LEAD_APPROVAL);
  return { userId: active.userId, name: active.name, role: active.role };
}

// DEPRECATED — adaptador TRANSITÓRIO, mantido só até a camada de Services existir.
//
// Converte um AuthorizationContext em uma identidade SIMPLES
// { userId, name, role, permissions }. Isso deixou de ser uma autorização: o
// Approval Queue não aceita mais esse objeto — só um autorizador injetado
// (authorizeReviewerForApprovalQueue) — e esta função NÃO verifica nenhuma
// permissão de negócio (só contexto emitido + usuário ativo). Não use em código
// novo, e nunca a injete como `authorizeReviewer`: o domínio recusa uma
// identidade com `permissions`.
//
// @deprecated use authorizeReviewerForApprovalQueue.
function toApprovalQueueIdentity(context) {
  const active = requireActiveUser(context);
  return {
    userId: active.userId,
    name: active.name,
    role: active.role,
    permissions: active.permissions,
  };
}

module.exports = { authorizeReviewerForApprovalQueue, toApprovalQueueIdentity };
