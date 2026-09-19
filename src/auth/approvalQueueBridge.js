// Ponte pequena e segura entre AuthorizationContext e o Approval Queue já
// existente (Passo 0009.6 / decisão 0010, seção 13).
//
// approvalQueue.js NÃO foi alterado por este passo — assertValidIdentity()
// lá dentro já aceita exatamente { userId, name, role, permissions } desde
// 0009.2. Esta função só converte um AuthorizationContext (que também tem
// `status`) para essa forma, garantindo antes que o usuário está ATIVO —
// nunca entrega ao Approval Queue um contexto de um usuário inativo.
//
// Este módulo depende só de authorizationContext.js — não importa nada de
// src/research-prospector/*, mantendo os dois domínios desacoplados. Quem
// liga os dois de fato é o código que chama approveProspect/rejectProspect
// (hoje, só os testes deste passo fazem isso, para provar que a integração
// funciona sem modificar approvalQueue.js).
const { requireActiveUser } = require('./authorizationContext');

function toApprovalQueueIdentity(context) {
  const active = requireActiveUser(context);
  return {
    userId: active.userId,
    name: active.name,
    role: active.role,
    permissions: active.permissions,
  };
}

module.exports = { toApprovalQueueIdentity };
