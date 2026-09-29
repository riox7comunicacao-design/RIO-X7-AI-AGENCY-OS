# 0025 — Exclusão administrativa e irreversível do CRM

## Status

Implementado localmente em 2026-09-28, sobre a decisão [0024](./0024-crm-postgres-schema.md) (esquema Postgres do CRM, já aplicado — `REPOSITORY_MODE=supabase`) e a análise técnica da etapa 3O.4 (H1-H5, aprovadas pelo proprietário). A migration SQL (`supabase/migrations/20260928090000_crm_delete_audit.sql`) está **escrita e auditada estaticamente, mas NÃO aplicada** ao Supabase real — aplicar é uma ação humana e deliberada do proprietário, feita depois desta decisão ser revisada.

Escopo: só a exclusão de um registro do CRM (`src/crm/crmDomain.js` `deleteRecord`, `src/services/crmService.js` `deleteRecord`, `DELETE /api/crm/:id`, o botão "Excluir registro" do Dashboard). Nenhuma outra operação do CRM muda.

## 1. Por que a exclusão foi introduzida

Até esta decisão, o CRM (decisão [0012](./0012-crm-operational-source-of-truth.md) em diante) deliberadamente **não tinha** exclusão — só criação, edição, mudança de status e bloqueio (`DO_NOT_CONTACT`). Isso mudou por pedido explícito do proprietário: existem cenários operacionais (registro de teste, duplicata clara, erro de cadastro) em que os mecanismos existentes não servem — `DO_NOT_CONTACT` bloqueia o contato futuro, mas **não remove** o registro nem o esconde da listagem, e não existe hoje nenhuma forma de tirar um registro do CRM. A decisão 0025 adiciona essa capacidade, **restrita e auditada**, sem alterar nenhum dos mecanismos existentes.

## 2. Só ADMIN tem DELETE:CRM

Uma permissão nova e própria, `DELETE:CRM` (`src/auth/constants.js`), deliberadamente **separada** de `WRITE:CRM`: excluir é uma ação destrutiva e irreversível, categoricamente diferente de criar/editar/mudar status. Ela entra:

- em `PERMISSION` (o catálogo de permissões existentes);
- em `ADMIN_PERMISSIONS` (a única role que a recebe — passa a ter 9 permissões);
- **nunca** em `COMMERCIAL_CLOSER_PERMISSIONS` (que continua com as mesmas 5 de sempre).

A autorização é feita **só pelo Service** (`crmService.deleteRecord`, `PERMISSION_FOR.deleteRecord = DELETE_CRM`), pelo mesmo `AuthorizationContext` emitido internamente por `src/auth` que autoriza toda outra operação do CRM — nunca por um nome de role comparado diretamente, e nunca pelo domínio (`crmDomain.js` não conhece `PERMISSION` nem `AuthorizationContext`, o mesmo princípio de `createRecord`/`updateRecord`/`moveStatus`). O bridge `src/auth/crmBridge.js` (`authorizeCrmOperation`) também precisou aceitar `DELETE:CRM` na sua lista própria (`CRM_PERMISSIONS`) — sem isso, mesmo um ADMIN com a permissão seria recusado pelo bridge, que é uma allowlist independente do catálogo geral.

O corpo de `DELETE /api/crm/:id` aceita **só** `{ "reason": "..." }` — nunca `role`, `permissions`, `userId`, `actor`, `reviewedBy` nem qualquer outro campo (`src/server/app.js`, `readActionBody`); um COMMERCIAL_CLOSER que chamasse a API diretamente, manipulando o navegador, recebe 403 do servidor de qualquer forma — a interface (`dashboard/views/crm.mjs`) só mostra ou esconde o botão por conveniência, nunca autoriza.

## 3. DELETE não é um substituto de DO_NOT_CONTACT

As duas ações continuam a existir lado a lado, com propósitos diferentes:

| | `DO_NOT_CONTACT` (decisão 0013) | `DELETE:CRM` (decisão 0025) |
|---|---|---|
| Efeito | bloqueia contato futuro; o registro **continua existindo** e visível | o registro **deixa de existir** |
| Reversível | não muda de status (terminal), mas o registro pode ser consultado/auditado para sempre | **nunca** — é hard delete |
| Quem pode | quem tem `WRITE:CRM` | só quem tem `DELETE:CRM` (hoje só ADMIN) |
| Uso correto | identidade que não deve mais ser contatada (pediu para sair, reclamação, etc.) | registro de teste, duplicata, erro de cadastro — algo que não deveria estar no CRM |

A exclusão **nunca** é automática: não existe nenhum gatilho, regra de negócio ou consequência de outra operação (DNC, mudança de status, etc.) que dispare uma exclusão — ela só acontece por uma ação humana explícita, pelo botão "Excluir registro" (ou por uma chamada direta e autorizada à API).

## 4. Hard delete, com auditoria completa no Supabase

Entre as três estratégias analisadas na etapa 3O.4 (F1 — soft delete/coluna `deleted_at`; F2 — hard delete com auditoria no Supabase; F3 — hard delete com log local em arquivo), o proprietário escolheu **F2**. O registro é **realmente apagado** de `public.crm_records` — não continua na tabela operacional com uma flag, e não volta em `listRecords`/`getRecord`/`getHistory` depois de excluído (a exclusão não é reversível pela aplicação). Antes de apagar, uma cópia completa vai para uma tabela de auditoria dedicada, `public.crm_record_deletions` (migration `20260928090000_crm_delete_audit.sql`), que preserva no mínimo:

- o id do registro original e a empresa;
- o registro **COMPLETO** como estava um instante antes (`record_snapshot`, JSONB — evita dezenas de colunas duplicadas), **sem nenhuma subtração de campo**: inclui todos os `CRM_WRITABLE_FIELDS`, os campos gerenciados, e também `historico`, `seq`, `version` e `updated_at` — nenhum dado do registro é descartado (correção 3O.5, sobre uma primeira versão desta migration que removia `historico`/`seq`/`version`/`updated_at` do snapshot; a tabela tem três `CHECK` próprios garantindo, no banco, que `historico`, `version` e `updated_at` continuam presentes em `record_snapshot`);
- o ator autenticado que excluiu (`deleted_by_user_id`, `deleted_by_name`, `deleted_by_role`) — nunca senha, token ou qualquer segredo;
- o motivo informado (`reason`, nunca vazio);
- o instante da exclusão (`deleted_at`).

Essa tabela é **só para auditoria**: nenhuma rota, Service ou domínio do CRM a lê como parte do funcionamento normal — ela existe para que uma exclusão possa ser investigada depois, nunca para ser consultada como um "CRM de registros apagados".

## 5. Atomicidade: uma função transacional, nunca duas chamadas independentes

O ponto mais crítico da implementação: gravar a auditoria e apagar o registro **não podem** ser duas chamadas HTTP/PostgREST independentes — uma falha entre as duas deixaria o sistema num estado inconsistente (registro apagado sem auditoria, ou uma auditoria "confirmando" uma exclusão que não aconteceu). A solução é a função PL/pgSQL `public.delete_crm_record_with_audit(p_id, p_deleted_by_user_id, p_deleted_by_name, p_deleted_by_role, p_reason)`, chamada pelo adapter (`src/crm-adapters/crmSupabaseRepository.js`, `delete()`) por RPC (`POST /rest/v1/rpc/delete_crm_record_with_audit`) — **nunca** um `DELETE` direto na tabela para esta operação. Dentro de uma única transação implícita, a função:

1. valida id, ator (userId/nome/role) e motivo — nenhum pode ser vazio (`RAISE EXCEPTION ... ERRCODE 22023` se algum faltar);
2. localiza e **trava** a linha (`SELECT ... FOR UPDATE`) — defesa contra uma corrida entre o `requireRecord()` do domínio (que já confirmou existência) e esta função; se o registro já não existir, `RAISE EXCEPTION ... ERRCODE P0002` (rede de segurança; o 404 esperado já foi tratado antes, pelo domínio);
3. monta o snapshot **completo** (`to_jsonb(linha)`, sem subtrair nenhum campo — ver a correção 3O.5 acima);
4. insere a auditoria;
5. só então apaga o registro.

Um `RAISE EXCEPTION` em qualquer um desses passos desfaz **tudo** que a função já tinha feito (comportamento nativo de uma função PL/pgSQL dentro da transação de quem a chama) — nunca há uma exclusão sem auditoria, nem uma auditoria de uma exclusão que não aconteceu.

**Segurança da função:** `SECURITY INVOKER` (o padrão do Postgres, explícito na migration) — não `SECURITY DEFINER`, porque o único chamador (`service_role`) já ignora RLS por natureza, então não há privilégio a elevar. Como o Postgres concede `EXECUTE` a `PUBLIC` em toda função nova, a migration revoga isso explicitamente e concede `EXECUTE` só a `service_role` — sem isso, o PostgREST exporia este RPC destrutivo aos papéis `anon`/`authenticated`, que hoje não têm nenhum acesso ao CRM (D1/D2, decisão 0024).

## 6. Motivo obrigatório

A exclusão é a **única** operação do CRM em que o motivo não é opcional, em três camadas independentes:

1. **UI** (`dashboard/views/crm.mjs`): o painel "Excluir registro" exige um texto no campo "Motivo da exclusão" e a marcação do checkbox "Entendo que esta ação é irreversível." antes de habilitar o envio — puramente para orientar quem usa a tela; não é a camada de segurança.
2. **HTTP/Service** (`src/server/app.js` + `src/services/crmService.js`): um motivo ausente, vazio ou só espaços é recusado com 400 (`readReason(options, { required: true })`), antes de qualquer chamada ao domínio ou ao repositório — nada é apagado.
3. **Banco** (migration): `reason TEXT NOT NULL CHECK (btrim(reason) <> '')` na tabela de auditoria, e a própria função SQL recusa (`ERRCODE 22023`) um `p_reason` vazio.

## 7. Limitação de concorrência (inalterada)

A exclusão usa a mesma trava de escrita por repositório já documentada na decisão 0023 (`serialized()`, fila de promessas por objeto repositório em `crmDomain.js`) — nenhuma estratégia nova de concorrência foi criada para esta etapa (decisão H3, aprovada pelo proprietário). As mesmas pendências já registradas na decisão 0023 (seção "Pendências para o Supabase", item 1 — concorrência entre processos/servidores) continuam valendo sem mudança.

## 8. Matriz de permissão

| Operação | READ:CRM | WRITE:CRM | DELETE:CRM |
|---|---|---|---|
| `listRecords`, `getRecord`, `getHistory` | ✅ | — | — |
| `createRecord`, `updateRecord`, `moveStatus`, `markDoNotContact` | — | ✅ | — |
| `deleteRecord` | — | — | ✅ |

| Role | READ:CRM | WRITE:CRM | DELETE:CRM |
|---|---|---|---|
| ADMIN | ✅ | ✅ | ✅ |
| COMMERCIAL_CLOSER | ✅ | ❌ | ❌ |

## 9. Comportamento da API — `DELETE /api/crm/:id`

Corpo: só `{ "reason": "<texto>" }`.

| Situação | Resposta |
|---|---|
| ADMIN, autorizado, registro existente, motivo válido | `200 { deleted: true, id }` |
| COMMERCIAL_CLOSER (mesmo chamando a API diretamente) | `403 FORBIDDEN` |
| sem token / token inválido | `401 UNAUTHENTICATED` |
| registro inexistente | `404 NOT_FOUND` |
| motivo ausente, vazio ou só espaços | `400 INVALID_REQUEST` ("Informe o motivo da exclusão.") |
| campo desconhecido no corpo (`role`, `userId`, ...) | `400 INVALID_REQUEST` ("Campos não permitidos na requisição.") |
| erro interno (rede, banco, etc.) | `500 INTERNAL` (genérico — nunca vaza detalhe do banco) |

## 10. Comportamento do Dashboard

O botão "Excluir registro" só aparece para quem tem `DELETE:CRM` (`canDeleteCrm`, `dashboard/crm-model.mjs`) — inclusive num registro já bloqueado como `DO_NOT_CONTACT` (excluir não é uma mudança de estado do CRM, e um registro DNC é exatamente um dos cenários que motivou esta decisão). Ao clicar, abre um painel de confirmação com:

- título "Excluir registro";
- aviso "Esta ação removerá permanentemente este registro do CRM.";
- campo obrigatório "Motivo da exclusão";
- checkbox obrigatório "Entendo que esta ação é irreversível.";
- botões "Excluir permanentemente" e "Cancelar".

Em sucesso: uma mensagem de confirmação, e a navegação volta para a lista do CRM (que é recarregada do servidor) — a ficha do registro excluído nunca continua aberta. Em falha (403, 404, 400, erro de rede), o painel mostra a recusa do servidor e nada é alterado; a interface nunca decide se a exclusão é permitida — só o servidor decide, mesmo que o JavaScript da página seja manipulado.

## 11. Testes

- **Domínio** (`tests/crm/`): excluir um registro existente (histórico e registro retornados como estavam antes de sumir do repositório); excluir um id inexistente (404 vindo de `requireRecord`); serialização (uma exclusão e uma escrita concorrentes no mesmo repositório nunca intercalam).
- **Service** (`tests/services/crmService.test.js`): ADMIN com `DELETE:CRM` consegue excluir; COMMERCIAL_CLOSER recebe a recusa de autorização; motivo obrigatório (ausente/vazio/só espaços lançam antes de tocar o domínio); opções desconhecidas são recusadas; a identidade nunca vem do payload, só do `AuthorizationContext`.
- **Repositório** (`tests/crm/`, `tests/crm-adapters/`): adapter de memória e de arquivo (delete remove a chave, ignora `meta`); adapter Supabase (delete chama o RPC certo, com os parâmetros certos, e nunca um `DELETE` direto).
- **API** (`tests/server/`): ADMIN → 200; CLOSER → 403; sem token → 401; inexistente → 404; sem motivo → 400; um corpo tentando forjar `role`/`permissions`/`userId` é recusado (400) e nunca chega ao Service.
- **Migration** (`tests/db/crmDeleteAuditMigration.test.js`): estrutura da tabela de auditoria, **snapshot completo (`record_snapshot` contém `historico`, `version` e `updated_at`, sem nenhuma subtração de campo)**, ausência de segredo, RLS sem policy, a função localiza→audita→apaga nessa ordem dentro do mesmo corpo, validação de entrada antes de tocar qualquer tabela, `SECURITY INVOKER` explícito, `REVOKE`/`GRANT` corretos, arquivo sintaticamente equilibrado, migration não executada por nenhum script do projeto.
- **Arquitetura**: as regras R10-R16 (camadas, imports fechados) continuam valendo sem exceção para o código novo.
