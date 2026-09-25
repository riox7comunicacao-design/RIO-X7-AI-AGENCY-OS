# 0016 — CRM-INTEGRATION: promoção controlada Approval Queue → CRM

## Status

Implementado em 2026-09-25, etapa CRM-INTEGRATION, sobre [0007](./0007-human-approval-queue.md), [0009](./0009-identity-roles-and-authorization-model.md), [0012](./0012-crm-operational-source-of-truth.md), [0013](./0013-crm-domain.md), [0014](./0014-crm-service.md) e [0015](./0015-crm-api.md). É só a camada de **serviços** (mais a auditoria no domínio da fila): **nenhuma rota HTTP, nenhum Dashboard, nenhuma permissão nova, nenhuma dependência nova**. A API, o Dashboard, o domínio do CRM e o CRM Service não foram alterados.

## O que decide esta etapa

Um prospect que um humano **aprovou** na Approval Queue (`APROVADO_PARA_CRM`) pode ser **promovido** para o CRM por uma operação nova, explícita e nunca automática — de forma segura, rastreável e idempotente. A fila continua sendo a barreira humana; o CRM continua sendo o dono da identidade, da deduplicação e do DNC.

```
APPROVAL QUEUE (aprovação humana)
        ↓
CrmIntegrationService.promoteProspect(context, prospectId)      src/services/crmIntegrationService.js
   ├─ Approval Queue Service      (lê o prospect; autoriza APPROVE:LEAD_APPROVAL)
   ├─ CRM Service                 (lista/lê/cria; autoriza READ:CRM e WRITE:CRM)
   │        ↓
   │   CRM Domain → persistência  (identidade, duplicidade, DNC, histórico — as regras de sempre)
   └─ Approval Promotion Service  (guarda na fila o que aconteceu; autoriza APPROVE:LEAD_APPROVAL)
            ↓
        Approval Queue (domínio) → persistência
```

### Onde a integração vive, e por quê

Em `src/services/`, a camada de aplicação, pelas fronteiras que já existem (`tests/auth/architecture-boundaries.test.js`): o domínio da fila não importa `src/auth` (R3) nem `src/services` (R9); só `src/services` importa o domínio do CRM (R12), e o servidor não importa o domínio da fila (R10). A integração compõe **dois Services** — cada um autoriza a sua parte — e nem precisa importar o domínio do CRM: fala com ele pelo CRM Service. Nenhuma fronteira foi enfraquecida; nenhuma regra nova de arquitetura foi necessária. O Dashboard continua sem qualquer caminho até o domínio (R11), e nenhuma rota HTTP expõe a promoção.

### Por que um Service à parte para a auditoria na fila

Registrar "este prospect foi promovido" na fila é uma ação que **só a integração** deve poder fazer. O Approval Queue Service é o que a API HTTP expõe, e a sua superfície (listar, ler, aprovar, rejeitar) é vigiada por testes de propósito. Pôr a auditoria da promoção nele a exporia por descuido a qualquer rota futura que repassasse "as operações do Service". Por isso ela vive em `src/services/approvalPromotionService.js` (só `recordPromotion` e `recordPromotionBlocked`), sobre uma fábrica própria do domínio da fila (`createApprovalPromotionActions`) — e a fábrica de revisão (`createApprovalReviewActions`) continua com exatamente as suas duas ações. A única linha alterada em um teste existente foi a classificação de `createApprovalPromotionActions` em `SVC-18` de `tests/services/approvalQueueService.test.js` — um teste que **exige** essa classificação consciente para toda função pública nova do domínio da fila.

## Arquivos

- `src/services/crmIntegrationService.js` — `createCrmIntegrationService({ approvalQueueService, approvalPromotionService, crmService, authorizeOperation })` → `{ promoteProspect }`; exporta `PROMOTION_OUTCOME` e `PROMOTION_ERROR`.
- `src/services/prospectToCrmFields.js` — o **mapeamento** (função pura): item da fila → campos do CRM.
- `src/services/approvalPromotionService.js` — a auditoria da promoção na fila.
- `src/research-prospector/approvalQueue.js` — `createApprovalPromotionActions`, `PROMOTION_RESULT`, `PROMOTION_BLOCK` (aditivo: nada existente mudou).
- Testes: `tests/services/crmIntegrationService.test.js` (51), `tests/services/prospectToCrmFields.test.js` (11), `tests/services/approvalPromotionService.test.js` (10), `tests/research-prospector/approvalQueue-promotion.test.js` (12), mais a fixture `tests/helpers/promotionFixtures.js`.

## O fluxo de `promoteProspect(context, prospectId)`

Tudo **síncrono** de ponta a ponta:

1. **WRITE:CRM** exigido logo no início, pela mesma ponte do CRM — nenhum caminho (nem "já promovido", nem reconciliação) lê ou grava sem ele.
2. `prospectId` deve ser texto; as **opções não aceitam nada** (ver "Regras de aprovação").
3. Lê o prospect **da fila real** (o Approval Queue Service autoriza `APPROVE:LEAD_APPROVAL`). Inexistente → `PROMOTION_PROSPECT_NOT_FOUND`.
4. Estado ≠ `APROVADO_PARA_CRM` → `PROMOTION_NOT_APPROVED`. Sem a aprovação humana no histórico → `PROMOTION_APPROVAL_MISSING`.
5. Já promovido (`promocao` na fila)? **Só confere** que o registro do CRM existe e é o desta promoção, e devolve `JA_PROMOVIDO` sem gravar nada; senão `PROMOTION_INCONSISTENT`.
6. **Recuperação:** procura no CRM um registro criado por esta promoção (marcador abaixo). Se achar (uma promoção interrompida), só **reconcilia** a fila (`RECONCILIADO`), sem criar outro registro.
7. Snapshot com `statusDNC` `BLOQUEADO` (a pesquisa o viu bloqueado depois da aprovação) → bloqueia (`PROMOTION_BLOCKED_DNC`), com auditoria.
8. Mapeia os campos; sem `empresa` → `PROMOTION_INSUFFICIENT_DATA`, com auditoria.
9. **Cria no CRM** (o CRM Service autoriza `WRITE:CRM`; o **domínio do CRM** decide identidade, duplicidade e DNC). Recusa por DNC → `BLOCKED_DNC`; por duplicidade → `BLOCKED_DUPLICATE`; por dado inválido → `INSUFFICIENT_DATA` — as três com auditoria na fila. Qualquer outro erro (autorização, persistência, inesperado) **passa intacto**, sem auditoria, e nada foi gravado.
10. **Registra na fila** (`promocao` + uma entrada de histórico) e devolve `CRIADO`.

Retorno (JSON puro): `{ outcome, prospectId, crmRecordId, record, aprovacao: { por, em }, promocao: { resultado, crmRecordId, promovidoEm, promovidoPor }, possivelDuplicidade }`. `record` é a projeção pública do CRM Service (sem `authUserId`, e-mail de usuário, permissions ou token).

## Regras de aprovação

- Só **`APROVADO_PARA_CRM`** é promovido — **e** com a aprovação humana registrada no histórico da fila: a transição `AGUARDANDO_REVISAO → APROVADO_PARA_CRM`, feita por `HUMAN`, com a identidade `{ userId, name, role }` de quem aprovou (nunca `SYSTEM`, nunca com campos a mais). Um item que só *diz* `APROVADO_PARA_CRM` (arquivo editado à mão, sem essa entrada) **não** é uma aprovação. `AGUARDANDO_REVISAO`, `REJEITADO`, `DUPLICADO`, `DNC`, `DADOS_INSUFICIENTES` e `EXPIRADO` não são promovidos, e nenhum atalho existe.
- **Nada vem do navegador (nem de nenhum chamador):** o único argumento é o id do prospect. As opções são recusadas **inteiras** — `estado`, `approvalId`, `reviewedBy`, `actor`, `userId`, `role`, `permissions`, `crmRecordId`, `status`, `reason`... — porque a aprovação vem da fila lida aqui e a identidade vem dos autorizadores.

## Autorização — sem permissão nova

| Quem promove precisa de | Decidido por |
|---|---|
| `APPROVE:LEAD_APPROVAL` | a fila (`getProspect`, `recordPromotion`, `recordPromotionBlocked`), pela ponte `authorizeReviewerForApprovalQueue` |
| `WRITE:CRM` | a ponte `authorizeCrmOperation`, exigida no início pela integração e de novo pelo CRM Service ao criar |

Hoje só o **ADMIN** tem as duas. O **COMMERCIAL_CLOSER** tem `APPROVE:LEAD_APPROVAL` mas não `WRITE:CRM`: **aprova, mas não promove** — coerente com 0014 (todo registro no CRM exige `WRITE:CRM`). A identidade gravada como "quem promoveu" (no CRM: `reviewedBy` da criação; na fila: `promovidoPor` e `reviewedBy` da entrada) vem **só dos autorizadores**.

## Idempotência (três camadas)

1. **A fila é a fonte de verdade da promoção:** o item promovido guarda `promocao`. Uma segunda chamada só *confere* que o registro do CRM existe e é o desta promoção, e devolve `JA_PROMOVIDO` — as repetições **não gravam nada** (nem na fila, nem no CRM), e outro ADMIN promovendo depois **não reescreve** a autoria.
2. **Recuperação de falha no meio:** o CRM é gravado **antes** da fila. Se a fila falhar depois (erro `PROMOTION_PARTIAL`), o registro do CRM já existe e leva, no **primeiro evento do seu histórico**, o motivo `Promovido da Approval Queue (prospect "<id>"; aprovado por <nome> em <data>)`. A repetição acha esse registro e só reconcilia. O id do prospect entra como JSON: o fechamento das aspas o delimita, e um id que contenha `;` ou `)` nunca é confundido com o prefixo de outro id.
3. **Identidade:** quem impede duas entradas equivalentes no CRM é o **domínio do CRM** (domínio do site, telefone, WhatsApp, Instagram — inclusive o mesmo número no campo "errado"), **não** uma regra paralela desta camada: a recusa dele vira `DUPLICADO`.

## Duplicidade e DNC — do domínio do CRM

- **Nome + cidade continua sendo sinalização**, nunca bloqueio (0005/0006): o registro é criado e o resultado traz `possivelDuplicidade` (`{ status, matchedOn, matchedRecordId }`); a fila guarda o id em `possivelDuplicadoDe`.
- **DNC:** uma identidade já bloqueada como `DO_NOT_CONTACT` no CRM **não entra** — incluindo o critério nome+cidade, como o domínio do CRM já faz para DNC ("trocar de canal" nunca contorna o bloqueio). O registro bloqueado não é tocado. Um snapshot com `statusDNC: BLOQUEADO` também bloqueia (falha fechada).
- Um bloqueio **não muda o estado** do item (não existe estado novo): fica como uma entrada de auditoria com o motivo e o id do registro que bloqueou, e o item pode ser promovido depois se o bloqueio deixar de existir. Se a própria auditoria falhar, a recusa continua valendo e o erro acusa `auditoriaGravada: false`.

## Estado da Approval Queue — nenhum estado novo

`APROVADO_PARA_CRM` continua sendo o estado histórico da aprovação humana e continua terminal. A promoção é registrada em **`item.promocao`** (`{ crmRecordId, resultado: CRIADO|RECONCILIADO, promovidoEm, promovidoPor }`) e numa **entrada de histórico** (`from` e `to` iguais a `APROVADO_PARA_CRM`, `actor: HUMAN`, `reviewedBy` = quem promoveu, `promocao: { resultado, crmRecordId, possivelDuplicadoDe }`). O item só **ganha** esse resumo: nada do que existia foi alterado, e a redescoberta não o apaga.

## Mapeamento de campos (fila → CRM)

Cada campo do CRM vem de **uma** origem nomeada; o valor é preservado **exatamente** (caixa, acento e formato — o mapeamento nunca normaliza; só remove espaços das pontas); ausente, vazio ou que não seja texto é **omitido** (nunca `null` inventado); só saem chaves de `CRM_WRITABLE_FIELDS`. O status inicial é `PROSPECT` (o padrão do domínio).

| Campo do CRM | Origem na fila |
|---|---|
| `empresa` | `item.empresa` (senão `snapshot.empresa`; sem nenhuma → dados insuficientes, nada é fabricado) |
| `cidade`, `nicho` | `snapshot.cidade`, `snapshot.nicho` |
| `estado` | `snapshot.estadoUf` |
| `site`, `instagram`, `facebook`, `telefone`, `whatsapp`, `email` | os campos de mesmo nome do snapshot |
| `origem` | `snapshot.origem`, se existir (a fila hoje não o tem: fica vazio) |
| `observacoes` | linhas **rotuladas**, em ordem, do que a fila tem e o CRM não tem campo próprio: *Observações da pesquisa*, *Hipótese de oportunidade* (continua marcada `HIPOTESE — …`), *Tipo*, *LinkedIn*, *YouTube*, *Endereço*, *Pesquisado em*, *Fontes consultadas* (só textos, até 10, até 300 caracteres cada); teto de 4000 caracteres |

- A **hipótese nunca vira `problemaIdentificado`**: isso afirmaria como fato um problema que a pesquisa só levantou como hipótese (Regra 2 do `RULES.md`).
- **Não copiado:** metadado de revisão da fila (`statusIdentidade`, `statusDados`, `statusDuplicidade`, `matchedOn`, `statusDNC`, `estadoOperacionalDiscovery`) — não é dado do lead, e duplicidade/DNC são do domínio do CRM.
- **Sem origem na fila, portanto vazios no CRM:** `contato`, `cargo`, `googlePerfil`, `temperatura`, `servicoPotencial`, valores, datas, responsável... A pesquisa produz `googlePerfil`, mas a fila **não o guarda no snapshot** (limite abaixo).

## Auditoria — dá para responder

| Pergunta | Onde está |
|---|---|
| Qual prospect | `item.prospectId`; no CRM, o marcador no motivo da criação |
| Qual aprovação / quem aprovou / quando | a entrada `AGUARDANDO_REVISAO → APROVADO_PARA_CRM` do histórico da fila (`reviewedBy`, `timestamp`); no CRM, o motivo da criação também traz o nome e a data |
| Quem promoveu / quando | `item.promocao.promovidoPor` / `promovidoEm` e a entrada de histórico na fila; no CRM, `reviewedBy` e `timestamp` do primeiro evento do registro |
| Qual registro do CRM foi criado | `item.promocao.crmRecordId` |
| Foi criado ou já existia | `item.promocao.resultado` (`CRIADO` / `RECONCILIADO`); o retorno diz `outcome` (`CRIADO` / `JA_PROMOVIDO` / `RECONCILIADO`) |
| Houve bloqueio, e por quê | entradas `Promoção bloqueada: <motivo>` na fila, com `codigo` (`DNC`, `DUPLICADO`, `DADOS_INSUFICIENTES`) e o id do registro que bloqueou |

Nenhum sistema de auditoria paralelo: são os históricos que a fila e o CRM já têm.

## Falhas — o que acontece

| # | Situação | Resultado |
|---|---|---|
| 1 | aprovação inexistente (estado forjado, sem a entrada de aprovação) | `PROMOTION_APPROVAL_MISSING`, nada gravado |
| 2 | não aprovado (pendente, rejeitado, DNC, duplicado, insuficiente, expirado) | `PROMOTION_NOT_APPROVED`, nada gravado |
| 3 | prospect inexistente / id perigoso (`__proto__`, `constructor`, `toString`…) | `PROMOTION_PROSPECT_NOT_FOUND` |
| 4 | DNC (no CRM, ou no snapshot) | `PROMOTION_BLOCKED_DNC` + auditoria; nada criado |
| 5 | duplicidade forte no CRM | `PROMOTION_BLOCKED_DUPLICATE` + auditoria; nada criado |
| 6 | já promovido | `JA_PROMOVIDO`, **sem gravar nada** |
| 7 | dados insuficientes | `PROMOTION_INSUFFICIENT_DATA` + auditoria |
| 8 | sem permissão / contexto falso / usuário inativo | a recusa do autorizador (`acesso negado…`, `usuário inativo`), **antes** de ler ou gravar qualquer coisa — sem auditoria |
| 9 | erro de persistência | ao criar no CRM: o erro passa intacto e nada é gravado (repetir funciona); depois de criar, ao gravar a fila: `PROMOTION_PARTIAL` (com `crmRecordId` e `cause`) e a repetição reconcilia |
| 10 | inconsistência fila × CRM | `PROMOTION_INCONSISTENT` e **nada é alterado**: a fila diz "promovido" mas o registro não existe, não é o desta promoção, o resumo está inválido, ou há mais de um registro do mesmo prospect |

Nenhuma falha parcial cria um estado impossível: o CRM é gravado antes da fila, e a única janela ("criado no CRM, fila não atualizada") é detectada e recuperável.

## Concorrência — o que se garante e o que **não** se garante

- **Dentro de um processo**, `promoteProspect` é síncrona de ponta a ponta e, portanto, indivisível: duas chamadas quase simultâneas se enfileiram; uma cria, a outra vê `JA_PROMOVIDO`.
- **Entre processos, não há garantia.** Os arquivos não têm trava nem transação (e não há transação entre **dois** arquivos), e nada disso foi fingido. Se outro processo concluir a promoção entre a leitura e a criação, para um prospect com **identidade forte** o domínio do CRM barra a segunda criação (um registro só, tentativa perdedora auditada). Para um prospect **só com nome e cidade** (sem site, telefone, WhatsApp nem Instagram) **não existe barreira**: pode nascer um registro duplicado. A fila recusa ligá-lo (`PROMOTION_INCONSISTENT`, com o id do duplicado e auditoria) — mas como o CRM não tem exclusão, o duplicado precisa de **revisão humana**. Um único processo servidor é o pressuposto desta persistência de desenvolvimento (0012–0014); o limite tem teste (`INT-42`) e só muda com uma persistência transacional (Supabase/Postgres — candidato, não decidido).

## Segurança — auditoria e resultado

- **Escalada de privilégio:** nenhuma permissão nova; o closer não promove; a autorização vem antes de tudo (contexto falso, clone, proxy, usuário inativo, autorizador defeituoso — `false`, `undefined`, texto, Promise, "thenable" — todos recusados sem tocar em nada).
- **Aprovação, estado, `approvalId`, `actor`, `reviewedBy` falsificados:** impossíveis pela interface (opções recusadas) e ineficazes no arquivo (a aprovação exige a entrada humana real no histórico). **Marcador forjado no CRM:** para um prospect não aprovado, a recusa vem do estado antes de qualquer reconciliação; para um aprovado, só quem tem `WRITE:CRM` (o ADMIN) poderia ter criado o registro — limite de confiança aceito e documentado (`INT-47`).
- **Propriedades herdadas e prototype pollution:** só propriedades **próprias** decidem (`promocao`, `statusDNC`, `estado`, `historico`, `reviewedBy`, `actor`, `motivo`, os campos do snapshot, os detalhes das ações); testado com `Object.prototype` poluído, objetos sem protótipo e chaves `__proto__` vindas de JSON.
- **IDs perigosos:** `__proto__`, `constructor`, `prototype`, `toString`… nunca são um prospect nem um registro.
- **DNC e duplicidade:** cobertos, inclusive número no campo trocado e DNC por nome+cidade; **vazamento:** o retorno e as mensagens não têm `authUserId`, e-mail de usuário, permissions, token nem dado do registro que bloqueou (só o id, na auditoria); **rede:** nenhuma chamada externa (teste com o `fetch` global derrubado); **PII:** nenhum dado real nos testes.
- **Regressões:** todas as recusas acima têm teste que falha se a proteção for removida. **Checagem de mutação:** 73 mutantes (autorização, aprovação, idempotência, recuperação, DNC, duplicidade, mapeamento, auditoria e o domínio da fila): 66 detectados de primeira e 7 sobreviventes que apontaram lacunas de teste (item de outro id, `statusDNC` herdado, marcador fora do evento de criação ou fora do início do texto, autorização do Service de auditoria antes da validação, cópia do retorno, forma exata da entrada de bloqueio) — todos os 7 passaram a ser detectados. **73 de 73.**

## Limites e decisões pendentes (registrados, não resolvidos)

- **Exposição pelo Dashboard (2026-09-25, etapa seguinte).** A promoção agora é exposta por `POST /api/approvals/:id/promote` (só o id na URL e corpo `{}`; autenticação obrigatória; chama `promoteProspect(contexto, id)` pelo serviço injetado; resposta segura `{ outcome, prospectId, crmRecordId, possivelDuplicidade }`; erros por `code` com mensagem fixa: 400/401/403/404/409/500) e pela ação "Promover para CRM" na tela Aprovações (só para `APROVADO_PARA_CRM` e só para quem tem as duas permissões). A rota **não** compõe nada nem duplica regra: recebe o serviço pronto, montado por `src/services/crmIntegrationFileService.js` sobre os mesmos arquivos e pontes de autorização. Nenhuma permissão nova; a matriz não mudou. Aprovar continua diferente de promover.
- **O snapshot pode mudar depois da aprovação:** a redescoberta atualiza o `discoverySnapshot` mesmo de um item terminal, então a promoção usa os dados **atuais** da fila, não os do momento da aprovação. Congelar o que foi aprovado exigiria mudar a aprovação na fila — decisão futura.
- **`googlePerfil` não chega ao CRM:** a pesquisa o produz, mas `sanitizeSnapshot` da fila não o guarda (`fontes` pode citar o Google Maps). Corrigir é uma mudança no snapshot da fila — decisão futura.
- **Perda do CRM com a fila intacta:** se `data/crm.json` se perder e a fila disser "promovido", a promoção falha claramente (`INCONSISTENT`) em vez de recriar; recuperar é ação manual (remover o `promocao` do item) até existir uma operação administrativa — decisão futura.
- **Registro duplicado por corrida entre processos** (acima): sem exclusão no CRM, é revisão humana.
- **Auditoria de bloqueios** cresce a cada tentativa bloqueada (só um ADMIN as dispara).
- **Persistência centralizada** (compartilhar CRM e fila entre computadores) segue como necessidade futura, ainda não decidida.
- Continuam valendo as decisões pendentes de 0014/0015 (o closer não marca DNC; editar campos não gera histórico; sem filtros no servidor; etc.).

## O que NÃO foi implementado

Prospector e nova pesquisa web, SDR, outbound, WhatsApp, e-mail, automação de contato, CRM com IA, Supabase/Postgres, permissão nova, sincronização com o Notion, promoção automática (nenhum item vira `APROVADO_PARA_CRM` por esta camada; ela só consome uma aprovação que já existe) e qualquer promoção em lote.

## Próximo passo

A etapa seguinte **não está definida**: o proprietário decide depois de revisar esta implementação. Candidatas naturais (nenhuma iniciada): o snapshot da fila (`googlePerfil`, congelar o que foi aprovado); persistência centralizada.
