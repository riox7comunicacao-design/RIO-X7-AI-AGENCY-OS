# 0013 — CRM Domain (modelo de dados, máquina de estados, DNC, deduplicação, repositório)

## Status

Implementado em 2026-09-23, etapa CRM-DOMAIN, sobre a decisão arquitetural [0012](./0012-crm-operational-source-of-truth.md). Só o domínio — sem Service, sem API HTTP, sem Dashboard, sem persistência de produção. Nenhum destes está implementado por esta etapa.

## Arquivos

- `src/crm/constants.js` — os 13 status oficiais, a máquina de transições, `ACTOR`, e a lista de campos graváveis/gerenciados.
- `src/crm/crmDomain.js` — as regras: `createRecord`, `getRecord`, `listRecords`, `updateRecord`, `moveStatus`, `markDoNotContact`.
- `src/crm/crmRepository.js` — o contrato de persistência (`assertValidRepository`) e os dois adapters desta etapa: `createInMemoryCrmRepository` (testes) e `createJsonFileCrmRepository` (desenvolvimento local).
- `src/crm/index.js` — barrel.
- `tests/crm/crmDomain.test.js` (37 testes), `tests/crm/crmRepository.test.js` (19 testes).

## Modelo de dados

Os campos são exatamente os já aprovados para o CRM V1 — nenhum foi inventado, nenhum foi removido:

**Graváveis (31):** `empresa`, `contato`, `cargo`, `telefone`, `whatsapp`, `email`, `site`, `instagram`, `facebook`, `googlePerfil`, `cidade`, `estado`, `nicho`, `origem`, `temperatura`, `servicoPotencial`, `problemaIdentificado`, `raioXDeNicho`, `raioXPersonalizado`, `statusDoDiagnostico`, `linkDoRaioX`, `dataDaAnalise`, `dataDaReuniao`, `linkDoMeet`, `proximaAcao`, `dataDaProximaAcao`, `responsavel`, `ultimaInteracao`, `valorProposta`, `valorTotal`, `observacoes`. Todos texto-ou-null, exceto `valorProposta`/`valorTotal` (número ≥ 0, ou null — únicos campos monetários; nenhum outro campo numérico foi inventado).

**Gerenciados pelo domínio, nunca aceitos como entrada de escrita:** `id` (gerado, `crm:<uuid>`), `status` (só muda por `moveStatus`/`markDoNotContact`), `dataDeEntrada` (definido na criação), `historico` (append-only).

**`empresa` é o único campo obrigatório** (mesmo princípio de `candidate.js`) — todo o resto nasce `null` quando omitido; nenhum valor é adivinhado.

**CONTATO ≠ RESPONSÁVEL:** `contato` (pessoa na empresa pesquisada) e `responsavel` (pessoa da Rio X7 dona da conta) são campos distintos, nunca inferidos um do outro. Reafirmando um gap já registrado em `data-domains.md` (linha "Responsável/decision maker"): este domínio **não** resolve "quem é o decisor" na empresa pesquisada — isso continua **DECISÃO PENDENTE**, não inventado aqui.

**`temperatura` é só um campo comum** — gravável/legível como qualquer outro, nunca calculado, nunca usado para ordenar ou pontuar (nenhum score, ranking ou "melhor lead" existe em nenhuma função deste módulo — testado explicitamente, `CRM-STATUS-2`).

## Os 13 status oficiais

Idênticos ao schema real do CRM confirmado antes da decisão 0012 (`PROJECT_CONTEXT.md`), só com o identificador em formato de código: `PROSPECT`, `RESEARCH`, `QUALIFIED_PROSPECT`, `CONTACTED`, `RESPONDED`, `QUALIFICATION`, `MEETING_SCHEDULED`, `MEETING_COMPLETED`, `PROPOSAL`, `NEGOTIATION`, `WON`, `LOST`, `DO_NOT_CONTACT`.

## Máquina de estados — decisão de design desta etapa

Não havia uma tabela de transições já aprovada para o CRM (ao contrário da Approval Queue, cuja tabela vem da decisão 0007). Esta etapa decidiu, e registra aqui para revisão:

- Os **10 status de funil** (todos exceto WON/LOST/DO_NOT_CONTACT) podem ir livremente para **qualquer outro** status de funil, inclusive "voltar" — um Kanban humano precisa poder corrigir um arraste ou reabrir um lead esfriado, do mesmo jeito que o board do Notion já permite hoje (`data-domains.md`: "Movimentação por humanos: já permite nativamente"). Nenhuma transição forward-only foi imposta.
- Qualquer status de funil pode fechar como **WON** ou **LOST**.
- **WON** e **LOST** só podem ir para **DO_NOT_CONTACT** — nunca voltam ao funil sozinhos (reabrir uma oportunidade fechada não foi pedido nesta etapa; se for necessário, é uma decisão futura).
- **DO_NOT_CONTACT é TERMINAL** — nenhuma transição de saída, de nenhum status, em nenhuma hipótese. `DO_NOT_CONTACT` é alcançável a partir de **qualquer** status, inclusive WON/LOST (a barreira de contato nunca depende de onde o lead está no funil).

Toda transição gera uma entrada de histórico (`timestamp`, `from`, `to`, `actor`, `reviewedBy`, `motivo`) — nenhuma mudança de status é silenciosa, mesmo padrão já usado em `approvalQueue.js`.

## DO NOT CONTACT

Reaproveita `research-prospector/doNotContact.js` (`checkDoNotContact`) sem alterar uma linha da lógica de comparação. Um registro em `DO_NOT_CONTACT` nunca é reaberto automaticamente (estado terminal), nunca aceita atualização de campos (`updateRecord` recusa um registro bloqueado), e **criar um registro NOVO para a mesma identidade também é recusado** — impede a burla óbvia de "criar de novo em vez de reabrir".

**Achado registrado, não uma escolha desta etapa:** `checkDoNotContact` (já existente, reaproveitado sem alteração) trata um match por **nome+cidade sozinho como suficiente** para considerar DNC — diferente de `checkDuplicate`, que trata o mesmo critério como só "possível" duplicidade. Essa assimetria já existia nas duas funções antes desta etapa; reaproveitá-las significa herdar essa diferença como está, não inventar uma nova regra.

## Deduplicação

Reaproveita `research-prospector/duplicateCheck.js` (`checkDuplicate`) sem reimplementar a comparação. Domínio/site, telefone e Instagram idênticos **impedem a criação** (`DUPLICADO`). Nome+cidade **nunca bloqueia** — vira `POSSIVEL_DUPLICADO`, informado no retorno de `createRecord` (`{ record, duplicidade }`) para um humano decidir, nunca decidido automaticamente pelo sistema. Preferido falso negativo a falso positivo, como pedido.

## Persistência — porta e adapters de desenvolvimento

`src/crm/crmRepository.js` define o contrato inteiro: `{ list(), getById(id), save(record) }`. O domínio (`crmDomain.js`) só chama esses três métodos — nunca importa `fs` nem qualquer SDK. Duas implementações nesta etapa, ambas explicitamente de desenvolvimento/teste:

- `createInMemoryCrmRepository()` — só memória.
- `createJsonFileCrmRepository(filePath)` — arquivo JSON local, escrita atômica (arquivo temporário + fsync + rename, mesmo padrão de `approvalQueue.saveQueueToDisk`).

**Nenhuma das duas é a persistência de produção** (decisão 0012). Um adapter futuro sobre Supabase/Postgres — candidato já registrado em 0012, **não decidido nem implementado aqui** — só precisaria satisfazer os mesmos três métodos; nenhuma regra de domínio muda.

**Achado de segurança corrigido nesta etapa:** um id de registro igual a `__proto__`/`constructor`/`prototype` poderia, no adapter de arquivo, reatribuir o protótipo do objeto de armazenamento em vez de virar uma chave comum (o mesmo tipo de risco já documentado para `queue.items[id]` em `approvalQueue.js`, mas explorável de fato aqui por passar por atribuição `objeto[chave] =`). Corrigido com um objeto de armazenamento sem protótipo (`Object.create(null)`) e uma checagem explícita em `save()` dos dois adapters — coberto por `CRM-REPO-*-5`.

## Limite honesto: autorização não existe neste domínio

`crmDomain.js` não sabe o que é `AuthorizationContext`, `ROLE` ou `PERMISSION`, e não importa `src/auth` (não pode, por instrução desta etapa). `actor`/`reviewedBy`/`motivo` são só **dados** que o chamador fornece para o histórico — o domínio os registra, mas não os verifica contra nada. Isto é seguro **somente enquanto o único chamador em produção for o futuro CRM Service**, que deve autorizar antes de chamar estas funções e nunca repassar um `reviewedBy` vindo diretamente do consumidor/rede — exatamente como `approvalQueueService.js` já faz para a Approval Queue. **Nenhum consumidor deve chamar `src/crm` diretamente.** Diferente da Approval Queue, este domínio não tem um autorizador injetado como segunda camada de defesa — decisão desta etapa, para não inventar uma peça de autorização antes do CRM-SERVICE decidir seu próprio desenho; registrado aqui para avaliação nessa etapa.

## O que NÃO foi implementado nesta etapa

CRM Service; qualquer rota HTTP; Dashboard/Kanban/detalhe/filtros; qualquer autorização (ROLE/PERMISSION) neste domínio; qualquer adapter de Supabase/Postgres; sincronização com Notion; a ponte Approval Queue → CRM (promoção); qualquer alteração em `approvalQueue.js`, `duplicateCheck.js` ou `doNotContact.js`.

## Testes

56 testes novos (`tests/crm/crmDomain.test.js`: 37; `tests/crm/crmRepository.test.js`: 19), cobrindo os 13 status, a máquina de transições (inclusive todas as combinações de fechamento e o terminal DNC), deduplicação forte/fraca, DNC (bloqueio, terminalidade, bloqueio de reentrada), leitura/cópias, atualização, os ids herdados do protótipo do Object, pureza de import (`CRM-PURITY-1/2`, varredura estática — nenhum import de `src/auth`/`src/server`/`dashboard`/`tests`/Supabase/Notion, nenhum `fetch`/`eval`/`Function`), e a mesma bateria de cenários críticos repetida sobre o adapter de arquivo JSON (prova de que o domínio não depende de qual repositório recebe).

## Próximo passo recomendado

Etapa **CRM-SERVICE**: a fronteira de autorização sobre este domínio (padrão de `approvalQueueService.js`), decidindo explicitamente se writes exigem `WRITE:CRM` e leituras `READ:CRM`/`ANALYZE:CRM` (permissões já existentes, inalteradas por esta etapa), e como o `AuthorizationContext` popula `reviewedBy`/`actor` sem nunca aceitar esses valores do consumidor.
