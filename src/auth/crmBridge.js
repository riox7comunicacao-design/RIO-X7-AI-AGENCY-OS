// Ponte pequena e segura entre AuthorizationContext e o CRM Service (decisão 0014; mesmo desenho de
// approvalQueueBridge.js).
//
// O CRM Service (src/services/crmService.js) não decide nada sobre quem pode o quê: recebe, por injeção, uma PORTA
//
//   authorizeOperation(context, requiredPermission) -> { userId, name, role }
//
// e authorizeCrmOperation, abaixo, é o ADAPTADOR dessa porta. Ele só conhece o AuthorizationContext e as
// verificações de authorizationContext.js — nenhuma regra do CRM (status, transições, DNC, deduplicação) vive aqui —
// e devolve ao Service SOMENTE a identidade mínima de que ele precisa para o histórico: { userId, name, role }
// (nunca permissions, authUserId, e-mail ou token).
//
// Este módulo depende só de authorizationContext.js e constants.js — não importa nada de src/crm nem de
// src/services, mantendo auth e domínio desacoplados e sem dependência circular. Quem liga as peças é a
// composição (src/server/index.js): createCrmService({ authorizeOperation: authorizeCrmOperation, repository }).
//
// Fronteira arquitetural interna confiável, não criptografia: a ponte decide sobre um AuthorizationContext emitido
// pelo emissor interno; não protege contra código que controle o mesmo processo e injete outro autorizador.
const { requireActiveUser, requirePermission } = require('./authorizationContext');
const { PERMISSION } = require('./constants');

// As ÚNICAS permissões que esta ponte autoriza: leitura e escrita do CRM. Não há padrão: omitir a permissão é uma
// recusa, nunca "leitura" nem "escrita" por omissão (diferente da ponte da fila, que só tem uma permissão possível).
// ANALYZE:CRM e PROPOSE:CRM existem na matriz, mas nenhuma operação do CRM Service as usa (o domínio não tem
// análise nem proposta) — ficam FORA daqui até uma operação real precisar delas (decisão 0014). Uma permissão
// diferente destas (deriva do Service, ou uso indevido) é recusada, mesmo que o contexto a possua.
const CRM_PERMISSIONS = Object.freeze([PERMISSION.READ_CRM, PERMISSION.WRITE_CRM]);

// Autoriza uma operação do CRM. Lança — nunca devolve "não autorizado" — quando qualquer condição falha:
//  - a permissão pedida não é READ:CRM nem WRITE:CRM (inclui omitida, null e qualquer outra);
//  - `context` não é um AuthorizationContext emitido (objeto simples, literal, cópia ou clone, mesmo com a forma
//    perfeita, nunca é aceito);
//  - o usuário está inativo;
//  - o contexto não possui a permissão pedida (a decisão lê só `permissions`, nunca o nome da role:
//    ROLE != PERMISSION).
// A checagem de permissão pedida vem ANTES da do contexto: um pedido malformado nunca chega a "consultar" nada.
// A checagem de usuário ativo é chamada de forma EXPLÍCITA, embora requirePermission também a faça: a ponte não
// depende de um detalhe de implementação de outro módulo para recusar um usuário INACTIVE.
function authorizeCrmOperation(context, requiredPermission) {
  if (!CRM_PERMISSIONS.includes(requiredPermission)) {
    throw new Error(
      `ponte do CRM só autoriza ${CRM_PERMISSIONS.join(' e ')}: permissão solicitada não suportada (${String(requiredPermission)})`
    );
  }
  const active = requireActiveUser(context);
  requirePermission(active, requiredPermission);
  return { userId: active.userId, name: active.name, role: active.role };
}

module.exports = { authorizeCrmOperation, CRM_PERMISSIONS };
