# 0009 — Modelo de Identidade, Roles e Autorização

## Status

Documentação arquitetural pura (nenhum código implementado por esta decisão). Registrado em 2026-09-18, como evolução direta de [0007](./0007-human-approval-queue.md) e [0008](./0008-specialist-team-architecture.md)/0008.1–0008.3.

## Por que um documento novo

As consolidações 0008.1–0008.3 já registraram uma lacuna real: `approvalQueue.js` aceita `reviewer` como texto livre, sem validar identidade. O volume e a coesão do que este passo precisa definir para resolver isso em nível conceitual — uma entidade `USER`, a separação `ROLE ≠ PERMISSION`, uma entidade `APPROVAL` genérica, um enum `APPROVAL_TYPE`, e o princípio de autorização na camada de serviço — formam uma decisão arquitetural própria, no mesmo padrão já usado por 0001–0008 (uma decisão coesa, um documento), em vez de fragmentar o conceito entre `permissions-matrix.md`, `human-approval-model.md` e `data-domains.md` sem um lugar central. Os demais documentos foram atualizados só com referências cruzadas a este.

## Contexto

Nenhuma alteração de código acompanha esta decisão. `approvalQueue.js` e `approvalQueue.test.js` **não foram tocados** — a lacuna do `reviewer` em texto livre, identificada desde a Auditoria 0008.1, continua existindo no código exatamente como estava. Este documento define o modelo que uma implementação futura deveria seguir para resolver essa lacuna, sem resolvê-la agora.

## Objetivo

Eliminar a dependência de campos de texto livre para representar identidade humana, definindo o modelo conceitual de identidade, usuários, roles, permissões, autorização e aprovação — **sem** implementar autenticação, sem escolher provedor, banco, OAuth, ou qualquer ferramenta específica (Clerk/Auth0/Supabase/etc.).

## 1. Entidade `USER` (modelo conceitual)

```
USER
- userId        identificador estável e único
- name          nome de exibição, só para auditoria legível — NUNCA usado como mecanismo de autorização
- role          rótulo de papel (ver seção 2) — não implica permissões automaticamente (ver seção 3)
- permissions   lista explícita de permissões concedidas a este usuário
- status        ACTIVE | INACTIVE
```

**Campos avaliados e descartados deste modelo, por serem desnecessários neste nível de arquitetura ou por violarem a Regra 8 do [RULES.md](../../RULES.md) (privacidade — não coletar dado pessoal desnecessário):**
- **Senha/credencial:** explicitamente fora deste modelo — autenticação real é responsabilidade de um provedor a ser escolhido no futuro, fora do escopo desta decisão.
- **E-mail/telefone pessoal:** não incluídos aqui; se um provedor de autenticação futuro exigir, isso é decisão daquele momento, não deste modelo conceitual.

**Por que `status` é necessário:** um usuário desativado nunca deve poder ser um `reviewedBy` válido numa nova aprovação — mas registros de aprovação **passados** feitos por ele continuam válidos para auditoria (o histórico nunca é apagado, mesmo que o usuário seja desativado depois).

## 2. Roles

Só os dois papéis já confirmados em decisões anteriores recebem identificador técnico — nenhum poder novo foi inventado:

- **`ADMIN`** — Breno. Já confirmado: pode autorizar qualquer ação (0002, seção 4; 0008).
- **`COMMERCIAL_CLOSER`** — Closer, parceiro comercial da Rio X7. Já confirmado: pode autorizar o SDR. **Qualquer poder além deste continua DECISÃO PENDENTE** — não presumir nada a mais.

Nenhum outro role foi criado. Um futuro role (ex.: para um funcionário administrativo, ou para um cliente num eventual produto SaaS) é FUTURO, sem definição.

## 3. `ROLE ≠ PERMISSION` (princípio formalizado)

`role` é um rótulo; **não implica automaticamente um conjunto de permissões**. `role = COMMERCIAL_CLOSER` **não** significa "aprovar tudo" — significa apenas que esse usuário é o Closer. As permissões reais de um usuário vêm do campo `permissions`, sempre concedidas explicitamente, nunca inferidas só do `role`.

**Formato conceitual de uma permissão, escopada por domínio (nunca genérica):**

```
{AÇÃO}:{DOMÍNIO}
```

Exemplos: `APPROVE:LEAD_APPROVAL`, `APPROVE:OUTBOUND_APPROVAL`, `APPROVE:FINANCIAL_APPROVAL`. Isso implementa diretamente a regra "a autorização deve ser específica ao tipo de ação/domínio" (seção 9) — nunca um `APPROVE` universal.

**Única exceção reconhecida:** o role `ADMIN` (Breno) já foi definido, em decisões anteriores, como podendo autorizar qualquer ação — então, conceitualmente, `ADMIN` é o único role que implica o conjunto completo de permissões por definição do próprio role. Para `COMMERCIAL_CLOSER`, nenhuma permissão é implícita: hoje, a única confirmada é a equivalente a `APPROVE:OUTBOUND_APPROVAL` (autorizar o SDR) — **`APPROVE:LEAD_APPROVAL` para o Closer não foi confirmado em nenhuma decisão anterior e fica registrado como DECISÃO PENDENTE**, não presumido.

## 4. Entidade `APPROVAL` (modelo conceitual, genérico por domínio)

```
APPROVAL
- approvalId
- approvalType   (ver enum na seção 5)
- requestedBy    userId (ou identificador do especialista que solicitou, quando aplicável)
- reviewedBy     userId — estruturado, nunca texto livre
- action         descrição do que está sendo aprovado
- decision       APPROVED | REJECTED
- timestamp
- reason         obrigatório quando decision = REJECTED; recomendado quando APPROVED
```

Este modelo generaliza o que `approvalQueue.js` **já implementa hoje**, de forma mais restrita, em cada entrada de `historico` (`timestamp, from, to, actor, motivo, reviewer`). A diferença central: `reviewedBy` é `userId` estruturado (não uma string livre como `reviewer` hoje), e `approvalType` deixa explícito a qual domínio aquela aprovação pertence — hoje, sempre `LEAD_APPROVAL`.

## 5. `APPROVAL_TYPE` (enum conceitual)

```
LEAD_APPROVAL        ← único que existe de fato hoje (approvalQueue.js)
OUTBOUND_APPROVAL     FUTURO
PUBLISHING_APPROVAL   FUTURO
CAMPAIGN_APPROVAL     FUTURO
FINANCIAL_APPROVAL    FUTURO
LEGAL_APPROVAL        FUTURO
```

Nenhum desses domínios além de `LEAD_APPROVAL` foi implementado. `approvalQueue.js` **permanece exclusivamente `LEAD_APPROVAL`** — reafirmado, não alterado.

## 6. Reviewer → `reviewedBy` (lacuna reconhecida, não corrigida)

**Estado atual do código (inalterado por esta decisão):** `approveProspect(queue, id, reviewer, reason)` em `approvalQueue.js` aceita `reviewer` como **texto livre**, sem validar contra nenhuma identidade real. Essa é uma lacuna arquitetural conhecida desde a Auditoria 0008.1.

**Modelo futuro (conceitual, não implementado):** o parâmetro `reviewer` (string) seria substituído por `reviewedBy` (`userId`), resolvendo `role`/`permissions` a partir da entidade `USER` (seção 1) em vez de confiar no nome digitado. **Isso não será implementado neste passo — `approvalQueue.js` e `approvalQueue.test.js` não foram alterados.**

**Atualização (Passo 0009.2):** a substituição descrita acima foi parcialmente implementada — `approveProspect`/`rejectProspect` agora exigem um contexto `identity: { userId, name, role, permissions }` e validam a presença de `APPROVE:LEAD_APPROVAL`; o histórico passa a gravar `reviewedBy: { userId, name, role }` em vez de `reviewer` (texto livre). **O que continua exatamente como descrito neste documento, sem nenhuma mudança:** não existe autenticação real, provedor de identidade, banco de usuários, sessão ou login — o código só valida a *forma* do contexto apresentado e a permissão declarada nele, nunca prova que esse `userId` corresponde a um usuário de fato existente/ativo. Todos os itens da seção 14 ("Decisões pendentes") continuam pendentes sem alteração.

## 7. Human in the loop (reafirmado com o modelo de identidade)

`AI ≠ HUMAN`. Um especialista de IA pode `READ`, `ANALYZE`, `PROPOSE` quando permitido (ver [permissions-matrix.md](../architecture/permissions-matrix.md)). Um especialista de IA **nunca** recebe automaticamente `APPROVE`, `SEND`, `PUBLISH`, `DELETE`, ações financeiras, jurídicas ou irreversíveis — isso já valia desde [0002](./0002-execution-architecture.md)/[human-approval-model.md](../architecture/human-approval-model.md). O que este documento acrescenta: **uma aprovação humana só é válida quando vem de um `USER` com `status: ACTIVE` e a `permission` específica daquele domínio** — nunca só "porque um humano digitou algo".

## 8. Auditoria

Cada registro `APPROVAL` (seção 4) já **é** o registro de auditoria — não existe uma estrutura de auditoria separada. O princípio de integridade (já praticado em `approvalQueue.js`, nunca alterado) é: **um registro de aprovação, uma vez criado, nunca é editado ou apagado** — apenas novos registros são adicionados. Isso vale para qualquer futuro domínio de `APPROVAL_TYPE`, não só `LEAD_APPROVAL`.

## 9. Outbound — aplicação do modelo

Reafirmado: Breno (`ADMIN`) e o Closer (`COMMERCIAL_CLOSER`, com a permissão específica `APPROVE:OUTBOUND_APPROVAL`, quando esse domínio existir) podem autorizar o SDR. **`role = COMMERCIAL_CLOSER` sozinho não é suficiente** — a permissão específica ao domínio `OUTBOUND_APPROVAL` é o que autoriza, não o role em si. Nada disso está implementado — o domínio `OUTBOUND_APPROVAL` em si ainda é FUTURO (ver [human-approval-model.md](../architecture/human-approval-model.md), modelo de dois níveis).

## 10. Conversa AI/HUMAN — consistência de identidade

O modelo de modo `AI`/`HUMAN` e handoff, já registrado em [human-approval-model.md](../architecture/human-approval-model.md) (consolidação 0008.3), é preservado sem alteração de mérito. Refinamento desta decisão: quando o `actor` de uma transição de modo for `HUMAN`, ele também deveria resolver para um `userId` desta mesma entidade `USER` — nunca um nome livre — pela mesma razão da seção 6. Ainda **DECISÃO PENDENTE** (schema físico do domínio Conversations continua em aberto).

## 11. Camada de serviço — autorização nunca só na interface

Refinamento do princípio já registrado em [data-domains.md](../architecture/data-domains.md) (`Dashboard → API/serviços → dados → especialistas`): esta decisão nomeia explicitamente uma camada de **Autorização** entre o serviço e o dado:

```
Dashboard
   ↓
API / Services
   ↓
Authorization       ← verifica USER + role + permission + approvalType, sempre aqui
   ↓
Data / Specialist
```

**Mesmo que um serviço seja chamado diretamente (sem passar pelo Dashboard), a autorização deve continuar sendo aplicada** — nunca é uma responsabilidade só da interface. Nenhuma API foi criada por esta decisão.

## 12. Permissões do COO (reafirmado, sem mudança de mérito)

Sem alteração em relação ao já definido em [specialist-matrix.md](../architecture/specialist-matrix.md) (consolidação 0008.2): o COO coordena, roteia, encadeia, consolida, solicita aprovação — nunca aprova, envia, publica, executa ação externa, ou decide comercialmente. **`APPROVE` nunca é concedido ao COO**, em nenhuma hipótese.

## 13. Permissões dos especialistas (reafirmado, com ressalva de domínio)

Sem alteração em relação ao já definido em [permissions-matrix.md](../architecture/permissions-matrix.md): especialistas podem `READ`/`ANALYZE`/`PROPOSE` quando autorizados. `WRITE` real sobre dado operacional de terceiro nunca é automático — pertence à camada de serviço (CRM Services), só após autorização/regra aplicável. **Ressalva registrada nesta decisão:** isso é o princípio-padrão, não uma regra absoluta e imutável para todo domínio futuro — um domínio específico *poderia*, em uma decisão própria e futura, definir uma regra diferente (ex.: um especialista com escrita direta em um dado exclusivamente seu, não operacional de terceiro — como já ocorre hoje com o achado local do Researcher e a fila local do Prospector). Qualquer exceção ao padrão exige decisão explícita, nunca é presumida.

## 14. Decisões pendentes (consolidadas)

- Autenticação (mecanismo técnico).
- Provedor de identidade.
- Banco de usuários.
- Mecanismo técnico de sessão.
- Poderes adicionais do Closer, além de `APPROVE:OUTBOUND_APPROVAL`.
- Granularidade definitiva de permissões por domínio (além do formato conceitual `{AÇÃO}:{DOMÍNIO}`).
- Gestão de usuários num futuro Dashboard.
- Implementação física do Approval Service (múltiplos `APPROVAL_TYPE`).
- Integração do Approval Service com autenticação real.
- Se `APPROVE:LEAD_APPROVAL` deve ser concedido ao Closer (hoje não confirmado).

## Consequências

- Fica definido um vocabulário comum (`USER`, `role`, `permission`, `APPROVAL`, `approvalType`) para quando a lacuna do `reviewer` em texto livre for de fato corrigida — sem essa correção acontecer agora.
- O princípio `ROLE ≠ PERMISSION` passa a orientar qualquer implementação futura de autorização, evitando que um role vire sinônimo de "pode tudo".
- Nenhuma mudança de comportamento ocorre hoje — `approvalQueue.js` continua aceitando `reviewer` como texto livre até uma implementação futura explicitamente autorizada.

## Alternativas consideradas

- **Corrigir `approvalQueue.js` agora, já validando `reviewer` contra uma lista fixa `["Breno", "Closer"]`.** Rejeitada: mesmo uma lista fixa de nomes ainda seria texto livre por baixo, sem resolver a lacuna de fundo (nenhuma verdadeira identidade, nenhum papel/permissão estruturados) — e a instrução deste passo foi explícita em não alterar `approvalQueue.js`.
- **Adicionar permissões diretamente ao enum de `role`, sem uma lista `permissions` separada.** Rejeitada: contradiria diretamente o princípio pedido `ROLE ≠ PERMISSION` — um role fixo não pode carregar permissões variáveis por usuário.
- **Já modelar múltiplos `APPROVAL_TYPE` com estados próprios.** Rejeitada nesta etapa: o pedido foi separar os tipos conceitualmente, não desenhar cada máquina de estados — isso fica para quando cada domínio for de fato autorizado a ser implementado.
