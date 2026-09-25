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

## Atualização (etapa CRM-SERVICE, auditoria de segurança) — correções no domínio e uma ressalva à seção "Persistência"

A auditoria pedida para o CRM-SERVICE **reproduziu por experimento** quatro brechas neste domínio, todas corrigidas aqui, cada uma com teste de regressão (`CRM-SEC-1` a `CRM-SEC-12` em `tests/crm/crmDomain.test.js`; 10 deles falham contra o código anterior — verificado):

1. **Editar a identidade contornava o DNC e a deduplicação.** `updateRecord` não reverificava nada: bastava trocar o `site` de um lead ativo pelo de um registro `DO_NOT_CONTACT` (ou de outro lead) para o registro ativo passar a ter aquela identidade. Agora, quando a atualização muda um campo de identidade (`empresa`, `site`, `telefone`, `whatsapp`, `instagram`, `cidade`), valem as mesmas regras da criação: identidade de um registro bloqueado ou identidade forte idêntica à de outro registro é recusada; nome+cidade continua só `POSSIVEL_DUPLICADO` (não bloqueia). `empresa` também nunca pode ficar vazia numa edição.
2. **Espaços nas pontas do `site` contornavam a deduplicação e o DNC na criação.** A normalização de domínio falha com espaços, e o site "  x.example.test  " deixava de casar com "x.example.test". Agora os textos são gravados sem os espaços das pontas (só as pontas; um texto só de espaços vira `null`).
3. **O mesmo número em `telefone` e em `whatsapp` não casava.** `identityKeys()` (compartilhado, em `research-prospector/normalize.js`) usa só um dos dois (`telefone || whatsapp`); logo o número que um registro bloqueado tinha só como WhatsApp passava como "livre" se entrasse como telefone de um registro novo — trocar de canal contornava o bloqueio. O domínio agora apresenta **cada número** como uma visão própria às funções compartilhadas (`checkDuplicate`/`checkDoNotContact`), que continuam sendo quem compara. **Não foi alterado nenhum arquivo de `research-prospector`**: a limitação continua existindo lá (e, portanto, na Approval Queue) e fica registrada como achado para uma etapa própria — a correção mínima seria `identityKeys` devolver todos os números e as duas funções compararem por interseção.
4. **Status herdado do protótipo em um registro adulterado** (`"constructor"`, `"__proto__"`, `"toString"`) causava um `TypeError` opaco em `moveStatus`; agora é só "transição não permitida". Um registro sem `historico` válido nunca é "consertado" em silêncio (apagaria a auditoria): falha fechada.

**Ressalva à seção "Persistência" acima:** ela diz que um adapter futuro sobre Supabase/Postgres "só precisaria satisfazer os mesmos três métodos; nenhuma regra de domínio muda". As **regras** de fato não mudam, mas a porta é **síncrona** (como o Approval Queue e o Service que já existem): um adapter que fale com uma rede é assíncrono, e trocar para ele exige tornar as funções do domínio e do Service `async` (uma mudança mecânica de assinatura, que se faz quando esse adapter for decidido — e provavelmente junto com uma porta mais rica, por exemplo com busca por chave de identidade, já que hoje a deduplicação lê a lista inteira). O desenho do CRM Service ([0014](./0014-crm-service.md)) parte dessa realidade. Desde a etapa CRM-SERVICE o contrato da porta vive em `src/crm/crmRepositoryPort.js` (sem `fs`, sem adapter); `crmRepository.js` — os adapters — o reexporta.

## Atualização (2026-09-25)

A promoção Approval Queue → CRM, que esta decisão deixou de fora, foi implementada na etapa CRM-INTEGRATION (camada de Services; o domínio do CRM não foi alterado). O texto acima descreve o estado da etapa em que esta decisão foi escrita e foi preservado como histórico. Ver [0016 — CRM-INTEGRATION](./0016-crm-integration.md) e o [CHANGELOG](../../CHANGELOG.md).
