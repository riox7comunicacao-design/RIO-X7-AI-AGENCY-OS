# 0017 — Rota autenticada de ingestão de prospecção

> **Atualização (0020, 2026-09-25):** o limite do corpo desta rota passou de 2 MiB para **4 MiB** e uma submissão passou de 500 para **150 achados** ([0020](./0020-raw-finding-v2.md)). Onde este documento diz 2 MiB, leia 4 MiB.

## Status

Implementado em 2026-09-25, sobre o Prospecting Service V1 (`src/services/prospectingService.js`). Só a **rota HTTP**: sem Dashboard, sem pesquisa web, sem IA, sem exclusão persistente. CRM (domínio, Service, API), a Approval Queue, o Promotion Service e o modelo da fila **não foram alterados**; nenhuma permissão nova (usa `PROPOSE:LEAD_APPROVAL` e `READ:CRM`, que já existiam).

## O que existe

`POST /api/prospecting/submit` (`src/server/app.js`). A rota é **só transporte**: autentica pelo fluxo de sempre (Bearer → adapter do Supabase → `AuthorizationContext`), lê o corpo JSON e entrega ao serviço `submitProspecting(context, corpo)`. Nada de discovery, deduplicação, DNC, validação, contabilidade de lote, fila, autorização ou persistência mora na rota — tudo isso continua no serviço. Sem o serviço injetado (`prospectingService` no `createApp`) a rota **não existe** (404), como as demais opcionais.

| Aspecto | Comportamento |
|---|---|
| Método | Só `POST`. `GET`/`PUT`/`PATCH`/`DELETE`/`OPTIONS`/`HEAD` → 405 com `Allow: POST`. Sem CORS. |
| Autenticação | 401 sem token ou com token inválido. A autorização é do **serviço**: `PROPOSE:LEAD_APPROVAL` e `READ:CRM`, antes de olhar qualquer dado (o COMMERCIAL_CLOSER recebe 403; nem um corpo inválido é revelado a ele). |
| Corpo | JSON, objeto, exatamente `{ "briefing": {}, "rawFindings": [] }`. Qualquer outra chave — inclusive userId, role, permissions, actor, reviewedBy, approvalId, status, loteId, criadoPor, criadoEm, contagens — é 400. Query string é 400. `Content-Type` diferente de `application/json` é 415. |
| Tamanho | **2 MiB só nesta rota** (`MAX_PROSPECTING_BODY_BYTES`), conferido no `Content-Length` antes de ler e durante a leitura (o corpo acima disso nunca é processado: 413, `Connection: close`). O limite geral das outras rotas **continua 16 KiB**. Os limites do `rawFindingSchema` (500 achados, 10 evidências por campo, 50 fontes, profundidade, nós, textos) continuam valendo por dentro; 500 achados reais cabem nos 2 MiB (há teste). |
| Autor | Vem **só** do contexto autenticado (o serviço grava `criadoPor` a partir do autorizador). Cabeçalhos como `x-user-id` são ignorados. |
| Sucesso | `201` com o relatório do serviço, sem campos novos: `loteId`, `status`, `criadoPor { userId, name, role }`, `criadoEm`, `briefing`, `contagens`, `prospectIds`, `resultados[]`, etc. Nunca token, `authUserId`, permissões, caminhos ou o id de um registro do CRM. |

## Erros

Os códigos estáveis `PROSPECTING_*` do serviço viram HTTP de forma determinística, com **mensagem fixa** da API (nunca o texto do serviço, um valor recusado, um caminho ou um id de prospect):

| Código | HTTP |
|---|---|
| `PROSPECTING_INVALID_INPUT`, `PROSPECTING_BRIEFING_INVALID`, `PROSPECTING_RAW_FINDINGS_INVALID` | 400 (com `details`: só `{ path, code }`, no máximo 50, reconferidos na API) |
| `PROSPECTING_CANDIDATE_INVALID` | 422 |
| `PROSPECTING_CONFLICT` | 409 |
| `PROSPECTING_NOT_FOUND` | 404 |
| `PROSPECTING_CRM_INVALID`, `PROSPECTING_PERSISTENCE` | 503 |
| qualquer outro erro (inclusive um `code` que só parece do serviço) | 500 genérico |

A recusa de autorização segue os caminhos de sempre (403) e **nunca** vira erro de candidato. `details` só existe nas recusas de validação (400).

## Composição

`src/server/index.js` só chama `createFileBackedProspectingService` (fábrica de `src/services`), com as pontes `authorizeProposerForLeadApproval` (PROPOSE) e `authorizeCrmOperation` (READ:CRM) e **os mesmos arquivos** da fila e do CRM do resto do servidor. O arquivo dos lotes usa o padrão seguro do adapter (`data/prospecting-batches.json`, fora do Git). O servidor **não** importa `src/crm` nem `src/research-prospector` (R10/R12; há um teste que percorre todo `src/server`).

## Inspeção de segurança da nova entrada HTTP

- **Identidade e permissão:** nada vem do cliente; o corpo não carrega chave de autorização e o serviço recusa qualquer uma. Teste de que o serviço recebe o contexto **emitido** e de que o autor gravado é o do token.
- **Tamanho e forma:** limite de 2 MiB antes e durante a leitura; JSON quebrado, bomba de aninhamento (1 milhão de níveis) e achado profundo são recusados sem estourar; `__proto__` não polui nada; corpo que não é objeto é 400.
- **Vazamento:** nem stack, caminho, valor recusado, id de prospect, token, `authUserId` ou permissões saem no sucesso ou nos erros; o token não vai para o log.
- **Escrita:** a rota não escreve no CRM (arquivo do CRM inalterado nos testes) e a fila só recebe candidatos elegíveis pelo serviço.
- **Método e origem:** só POST; sem cabeçalhos CORS.

## Limites (não resolvidos aqui)

- **Sem limite de taxa e sem timeout de leitura próprio** desta rota (o servidor não os tem para nenhuma rota; um cliente autenticado lento ou repetido pode ocupar o processo). Fica como decisão do servidor como um todo.
- **O processamento é síncrono** (como os demais Services): uma submissão de 500 candidatos bloqueia o processo por instantes.
- O corpo de 2 MiB é **lido na memória** antes de validar (dentro do limite).
- Sem `GET` de lotes: `getBatch`/`listBatches` existem no serviço, mas **não há rota** para eles ainda.
- Continuam valendo os limites do Prospecting Service V1 (um lote por submissão, duplicidade entre candidatos só pelo id estável, sem exclusão persistente, sem transação entre fila e lote, sem trava entre processos). Um servidor já em execução precisa ser **reiniciado** para ganhar a rota.
