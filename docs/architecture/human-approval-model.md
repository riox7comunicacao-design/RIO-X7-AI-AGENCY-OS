# Modelo de Aprovação Humana

Consolida e estende, sem contradizer, a lista de ações que sempre exigem aprovação humana já registrada em [0002-execution-architecture.md](../decisions/0002-execution-architecture.md), seção 4. Nenhuma das regras abaixo é nova permissão — é o mesmo princípio (humano no controle, Regra 6 do [RULES.md](../../RULES.md)) aplicado explicitamente à futura equipe de especialistas.

## Ações que SEMPRE exigem aprovação humana

Nenhum especialista, em nenhum nível de autonomia, pode executar sozinho:

- Envio de WhatsApp
- Envio de e-mail
- Contato outbound de qualquer tipo
- Início de abordagem (primeiro contato com um prospect)
- Alteração de dados importantes do CRM (Status, Temperatura, dados de contato)
- Criação/alteração de reunião
- Alteração de campanhas (mídia paga)
- Publicação de conteúdo
- Alteração financeira
- Ações jurídicas
- Exclusão de dados
- Contratação de ferramentas/serviços
- Mudanças que possam gerar custo financeiro
- Ações irreversíveis

Esta lista é a união da lista já existente em 0002 com a lista fornecida neste passo — nenhum item foi removido, e os novos itens ("contato outbound", "início de abordagem", "ações irreversíveis" como categoria explícita) são consistentes com o que já estava implícito em 0002 e nas Skills nativas (SDR, Raio-X).

## Papéis (roles)

| Papel | Definido? | Poderes confirmados |
|---|---|---|
| **Breno** | DEFINIDO | **ADMIN**. Pode autorizar qualquer ação, incluindo autorizar o SDR a iniciar abordagem outbound. |
| **Closer** | PARCIALMENTE DEFINIDO | Parceiro comercial de Breno. **Confirmado:** pode autorizar o SDR (mesmo poder que Breno, especificamente para essa ação). **Não confirmado:** qualquer outro poder além deste — ver "Decisões pendentes" abaixo. Não presumir acesso de ADMIN. |
| **Outros humanos** | NÃO DEFINIDO | Nenhum outro papel humano foi definido neste passo. |
| **Especialistas de IA (SYSTEM)** | DEFINIDO | Nunca podem executar, sozinhos, nenhum item da lista acima. Podem executar classificações técnicas (deduplicação, DNC, identidade/dados) — já implementado e testado em `discovery.js`/`approvalQueue.js`. |

## Autorização do SDR para abordagem outbound

**Confirmado:** existe autorização humana antes de qualquer outbound do SDR. Breno e o Closer podem autorizar.

**DECISÃO PENDENTE:** a granularidade da autorização —
- por campanha (autoriza uma vez, vale para todos os leads daquela leva de prospecção);
- por lead (autoriza individualmente, cada abordagem);
- ou ambas (ex.: autorização de campanha libera o lote, mas casos sinalizados como incertos — `POSSIVEL_DUPLICADO`, `DADOS_INSUFICIENTES`, conflito de identidade — exigem autorização individual adicional).

Isso **não foi decidido nem implementado**. Fica registrado como decisão pendente, com uma recomendação arquitetural separada abaixo — a recomendação não constitui decisão nem implementação.

### Recomendação arquitetural (não implementada, sujeita a aprovação humana antes de qualquer código)

Um modelo híbrido parece reduzir melhor o atrito operacional sem abrir mão do controle:
- Autorização **por campanha/lote** para candidatos com identidade `VALIDADA` e dados `SUFICIENTES` (ou seja, já saíram de `discovery.js`/`approvalQueue.js` como `AGUARDANDO_REVISAO` limpo, sem duplicidade/DNC/conflito).
- Autorização **por lead**, individual, para qualquer candidato que tenha passado por `DADOS_INSUFICIENTES`, `POSSIVEL_DUPLICADO`, ou qualquer conflito de identidade registrado — exatamente os casos que já saem sinalizados pela fila de aprovação existente.

Esta é uma recomendação, não uma decisão — precisa de aprovação explícita de Breno (e, dentro do escopo já combinado, o Closer também pode aprovar essa aprovação) antes de orientar qualquer implementação futura.

### Decisão consolidada (0008.3): modelo de dois níveis, DEFINIDO em nível conceitual

A recomendação acima foi promovida a **arquitetura V1, definida em nível conceitual** (não implementada): existem **dois níveis** de autorização de outbound, não um só.

- **A) Autorização de campanha** — libera que leads elegíveis daquela campanha/leva de prospecção possam ser abordados.
- **B) Autorização individual do lead** — pode autorizar, bloquear, ou **substituir** a autorização da campanha para um lead específico.

**DNC sempre vence qualquer autorização**, em qualquer nível — não há exceção.

Fluxo conceitual:

```
CAMPAIGN AUTHORIZATION
      ↓
LEAD ELIGIBILITY
      ↓
DNC CHECK                 ← sempre vence; se bloquear, nada abaixo acontece
      ↓
INDIVIDUAL OVERRIDE       ← pode autorizar, bloquear, ou substituir a autorização da campanha
      ↓
OUTBOUND AUTHORIZED
      ↓
SDR
```

**O que permanece pendente:** a granularidade *exata* de quando cada nível se aplica na prática (ex.: quais critérios tornam um lead elegível dentro de uma campanha já autorizada) e os poderes do Closer além de autorizar o SDR. **O que passa a estar definido:** a existência dos dois níveis, sua ordem relativa (campanha → elegibilidade → DNC → override individual → autorizado), e que DNC nunca pode ser contornado por nenhum dos dois níveis. **Nada disso foi implementado** — é arquitetura conceitual para orientar uma implementação futura.

### Lead Approval ≠ Outbound Approval (reafirmado)

Não confundir os dois:
- **Lead Approval** (o que `approvalQueue.js` já implementa) responde: *"este prospect pode entrar no CRM?"*
- **Outbound Approval** (fluxo acima, não implementado) responde: *"podemos entrar em contato com este lead?"*

São decisões diferentes, feitas em momentos diferentes, por critérios diferentes. **O Approval Queue atual continua sendo somente Lead Approval.** Não implementar a autorização de outbound agora.

### Decisão consolidada (0008.2): outbound não reaproveita o Lead Approval

Independentemente de como a granularidade acima for decidida, fica **definido agora**: a autorização de outbound do SDR **não deve reutilizar a mesma fila/máquina de estados do Approval Queue existente** (`AGUARDANDO_REVISAO → APROVADO_PARA_CRM`, hoje escopado a "este achado pode virar candidato a lead"). São perguntas de natureza diferente — ver detalhamento em "Relação com o Approval Queue já implementado", abaixo. Uma eventual fila de autorização de outbound é um **domínio separado** (FUTURO), ainda que possa reaproveitar o mesmo *padrão* (estados + actor + auditoria), nunca a mesma instância.

## Identidade do reviewer (requisito arquitetural — não implementado)

A Auditoria 0008.1 encontrou uma lacuna real: hoje, `approveProspect`/`rejectProspect` em `approvalQueue.js` aceitam **qualquer texto não vazio** como `reviewer` — não há validação de que quem aprovou é de fato Breno ou o Closer. Uma aprovação humana real não deveria depender só de um campo de texto livre com um nome.

**Registrado como requisito arquitetural para uma versão futura** (não implementado, `approvalQueue.js` não foi alterado): o modelo de aprovação deveria evoluir para uma identidade estruturada, por exemplo:

```
{ userId, role, timestamp, action, motivo }
```

com os papéis autorizados (`role`) definidos pelo sistema, não digitados livremente por quem chama a função. Isso vale tanto para o Approval Queue existente (Lead Approval) quanto para qualquer futuro domínio de aprovação (outbound, publicação, campanha, financeiro). **Não implementar autenticação/identidade neste passo.**

**Modelo completo (0008.4):** o modelo conceitual de `USER`, `role`, `permission` (com o princípio `ROLE ≠ PERMISSION`), a entidade genérica `APPROVAL` e o enum `APPROVAL_TYPE` (que formaliza `LEAD_APPROVAL`, `OUTBOUND_APPROVAL`, `PUBLISHING_APPROVAL`, `CAMPAIGN_APPROVAL`, `FINANCIAL_APPROVAL`, `LEGAL_APPROVAL`) estão detalhados em [0009-identity-roles-and-authorization-model.md](../decisions/0009-identity-roles-and-authorization-model.md). Este parágrafo permanece aqui por razões históricas (registro original da lacuna, na Auditoria 0008.1); 0009 é a referência completa e atual do modelo.

**Atualização (Passo 0009.2):** a lacuna descrita acima foi parcialmente corrigida — `approveProspect`/`rejectProspect` em `approvalQueue.js` agora exigem um contexto de identidade estruturado (`userId`/`name`/`role`/`permissions`) e a permissão `APPROVE:LEAD_APPROVAL`, em vez de qualquer texto não vazio. Isso continua sem ser autenticação real: não há verificação de que o `userId` apresentado corresponde a um usuário de fato autenticado. Ver 0009, seção 6, "Atualização (Passo 0009.2)".

## Alternância entre IA e humano (modo AI / HUMAN)

Requisito arquitetural registrado nesta consolidação — **não implementado**:

- Toda conversa conduzida com apoio de IA deve poder existir em um de dois modos: `AI` ou `HUMAN`.
- Deve ser possível **pausar** e **reativar** a IA numa conversa específica.
- **O estado (`AI`/`HUMAN`) deve existir na camada de serviço/dados, nunca só na interface.** O Dashboard (ou qualquer outra interface) não pode simplesmente esconder um botão para "impedir" a IA de agir — o serviço por trás precisa recusar a ação enquanto o modo for `HUMAN`, mesmo que alguém chame a API diretamente. Isso é a mesma regra já aplicada em "Dashboard não deve conter regra crítica de negócio" (ver [data-domains.md](./data-domains.md), princípio de arquitetura de dados).
- Toda transição de modo deve gerar auditoria com, no mínimo (refinado em 0008.3): `actor`, `timestamp`, `previousMode`, `newMode`, `motivo/contexto quando disponível` — mesmo princípio de auditoria já usado em `approvalQueue.js` (`historico`), aplicado a um domínio diferente (conversas, não prospects).

Este requisito depende do domínio "Conversas" (ver [data-domains.md](./data-domains.md)), hoje **DECISÃO ARQUITETURAL PENDENTE** — não há schema para implementar isso ainda. **Não implementar agora.**

## Relação com o Approval Queue já implementado (Lead Approval)

O módulo `approvalQueue.js` (Passo 3) já implementa uma peça deste modelo — hoje entendido, nesta consolidação, especificamente como **"Lead Approval"**: a barreira entre "descoberta" e "aprovado para CRM", respondendo exclusivamente à pergunta *"este prospect descoberto pode entrar no CRM?"*. Aprovação sempre humana (`actor: HUMAN` obrigatório, reviewer nomeado, motivo registrado).

**Ele não deve controlar diretamente:** conversa, SDR, WhatsApp, e-mail, publicação, campanhas, financeiro, jurídico. Não deve ser transformado em uma fila universal de aprovação.

**Arquitetura futura (conceitual, não implementada):** pode existir um "Approval Service" comum, com domínios separados — por exemplo:

- Lead Approval (o que já existe)
- Outbound Approval
- Publishing Approval
- Campaign Approval
- Financial Approval

Cada domínio manteria sua própria modelagem de estados (nem todo domínio de aprovação precisa dos mesmos estados de Lead Approval), **nunca compartilhando a mesma máquina de estados sem modelagem própria**. Não implementar nenhum desses novos domínios agora.

Ver a seção dedicada em [0008-specialist-team-architecture.md](../decisions/0008-specialist-team-architecture.md) ("Implicação para o Approval Queue existente") para as lacunas já identificadas (caller não restringido, reviewer em texto livre, escrita no CRM ainda não autorizada) — nenhuma delas foi resolvida nesta consolidação, e `approvalQueue.js`/`approvalQueue.test.js` não foram alterados.
