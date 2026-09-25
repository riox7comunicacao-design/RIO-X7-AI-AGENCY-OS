# 0015 — CRM API (rotas HTTP finas sobre o CRM Service)

## Status

Implementado em 2026-09-23, etapa CRM-API, sobre [0012](./0012-crm-operational-source-of-truth.md), [0013](./0013-crm-domain.md) e [0014](./0014-crm-service.md). Só a camada HTTP e a composição do CRM no servidor — sem Dashboard, sem persistência de produção, sem permissão nova, sem subscription nova, sem IA. O domínio e o Service **não foram alterados**.

## Arquivos

- `src/server/app.js` — as 7 rotas `/api/crm...`, o catálogo de erros do CRM e o mapeamento das mensagens do Service/domínio.
- `src/server/index.js` — a composição: `createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath })` e a variável `RIO_X7_CRM_PATH`.
- `src/services/crmFileService.js` — **novo**: a fábrica que transforma um caminho de arquivo num CRM Service (ver "Conflito encontrado e como foi tratado").
- Testes: `tests/server/crm-api.test.js` (40), `crm-error-mapping.test.js` (10), `crm-composition.test.js` (4), `crm-api-boundaries.test.js` (4), `tests/services/crmFileService.test.js` (7). `tests/server/testEnv.js` ganhou um CRM **opcional** (por padrão o app de teste continua sem rotas de CRM, como antes).

## Arquitetura

```
Dashboard (futuro) -> HTTP /api/crm -> src/server (esta camada) -> CRM Service (src/services) -> CRM Domain (src/crm) -> porta de persistência -> adapter
```

A API é uma camada **fina**: autentica, valida a *forma* da requisição, chama **um** método do CRM Service com o `AuthorizationContext` que veio do token, e traduz o resultado em HTTP. Não importa o domínio, não conhece um status, um campo, uma permissão ou uma role, e não autoriza nada — o CRM Service continua sendo a **única** camada de autorização (0014). Isso é travado por testes: a lista de importações de `app.js` é fechada (`../auth`, `./static`), ele não contém nenhum identificador de autorização/domínio nem literal de permissão, status ou role (`tests/server/crm-api-boundaries.test.js`), e a regra R12 de `tests/auth/architecture-boundaries.test.js` — **inalterada** — continua barrando qualquer importação de `src/crm` fora de `src/services`. A prova de comportamento é `[CRM-API-34]`: um `COMMERCIAL_CLOSER` que escreve **chega** ao Service (a API não pré-autoriza), sempre com o contexto emitido a partir do token e com os argumentos exatos.

## Rotas e contratos

Todas exigem `Authorization: Bearer <access token>`, respondem `application/json` com `Cache-Control: no-store`, não têm CORS (mesma origem) e recusam qualquer query string (não há filtros nem busca: o Service não os tem). Corpos: `Content-Type: application/json` obrigatório, no máximo 16 KiB, um **objeto** JSON.

| Rota | Corpo | Sucesso | Service (permissão decidida por ele) |
|---|---|---|---|
| `GET /api/crm` | — | `200 { items }` | `listRecords` (`READ:CRM`) |
| `POST /api/crm` | os campos do registro + `status?` (status inicial) + `reason?` (motivo da entrada) | `201 { item, duplicidade }` | `createRecord` (`WRITE:CRM`) |
| `GET /api/crm/:id` | — | `200 { item }` | `getRecord` (`READ:CRM`) |
| `PATCH /api/crm/:id` | só os campos a mudar (nunca `status`/`id`/`historico`) | `200 { item }` | `updateRecord` (`WRITE:CRM`) |
| `GET /api/crm/:id/history` | — | `200 { historico }` | `getHistory` (`READ:CRM`) |
| `POST /api/crm/:id/status` | `{ to, reason? }` | `200 { item }` | `moveStatus` (`WRITE:CRM`) |
| `POST /api/crm/:id/dnc` | `{ reason? }` | `200 { item }` | `markDoNotContact` (`WRITE:CRM`) |

`item` é a projeção pública do Service (os 31 campos do modelo + `id`, `status`, `dataDeEntrada`, `historico`); `duplicidade` é `null` ou `{ status, matchedOn, matchedRecordId }` (só um aviso de *possível* duplicidade por nome+cidade — uma identidade forte idêntica é `409`). Só existem operações que o Service já tem: **não há exclusão, nem filtros, nem busca**, e `DELETE`/`PUT` são `405`. As rotas só existem quando o Service é injetado em `createApp` (sem ele, `/api/crm...` é `404`); presente, ele é validado por inteiro na criação.

## Autenticação e autorização

O pipeline é o da fila, sem atalhos: rota e método existem (`404`/`405`) → `Authorization: Bearer` (`401`) → `verifyAccessToken` real (`401`; `503` se o Supabase não responde) → `resolveAuthorizationContext` (`403` se não há `USER` para o `authUserId`) → usuário ativo (`403`) → query/`Content-Type`/tamanho/JSON (`400`/`413`/`415`) → **CRM Service** (`403` sem `READ:CRM`/`WRITE:CRM`; `404`; `409`; `400`). Nada do navegador — corpo, query, cabeçalho — vira identidade ou permissão:

- `userId`, `authUserId`, `role`, `permissions`, `reviewedBy` e `actor` **nunca são lidos**. Nas rotas de ação (`status`, `dnc`) as chaves aceitas são fixas na API (`to`, `reason`) e qualquer outra é `400` sem chegar ao Service. No `POST`/`PATCH` a API não conhece os nomes dos campos (só o domínio conhece, e ele é inalcançável daqui): o corpo segue como *campos* e o domínio recusa (`400`) todo nome desconhecido.
- O `reviewedBy` de cada entrada de histórico vem só do autorizador injetado (a ponte `authorizeCrmOperation`), a partir do contexto; `actor` é sempre `HUMAN`.
- O Service autoriza **antes** de validar: sem `WRITE:CRM` a resposta é `403` mesmo com um corpo forjado, e um usuário sem acesso recebe a **mesma** resposta para um id existente e um inexistente (nada sobre a existência de um registro vaza).
- Só propriedades **próprias** do corpo contam, e os objetos que a API monta para o Service não têm protótipo: um `Object.prototype` poluído por outro código não escolhe status, motivo nem destino (`[CRM-API-25b]`).

## Erros

Toda resposta de erro é `{ error: { code, message } }` com mensagem **fixa** em português — nunca a mensagem original, a stack, um caminho, um id, o token ou o `authUserId`. As mensagens do Service e do domínio (texto, sem código) são reconhecidas pelo **início** do texto (prefixo `CRM: `, ancorado); o que não é reconhecido é `500` genérico, e o log de operação recebe só uma dica (o arquivo corrompido não repete conteúdo nem caminho).

| Situação | Status / code |
|---|---|
| sem/ inválido/ expirado token | `401 UNAUTHENTICATED` |
| sem `USER`, usuário inativo, sem permissão | `403 NO_ACCESS` / `INACTIVE` / `FORBIDDEN` |
| registro inexistente | `404 NOT_FOUND` |
| rota inexistente / método errado | `404 ROUTE_NOT_FOUND` / `405 METHOD_NOT_ALLOWED` (+ `Allow`) |
| identidade já existente (site/telefone/Instagram) | `409 DUPLICATE_RECORD` |
| identidade bloqueada (`DO_NOT_CONTACT`) | `409 DNC_BLOCKED` |
| editar um registro bloqueado | `409 RECORD_LOCKED` |
| transição de status não permitida | `409 INVALID_TRANSITION` |
| entrada inválida (JSON, campo, valor, id, status, motivo) | `400 INVALID_REQUEST` (mensagem fixa por caso) |
| corpo grande / tipo errado | `413 PAYLOAD_TOO_LARGE` / `415 UNSUPPORTED_MEDIA_TYPE` |
| armazenamento corrompido, autorizador defeituoso, bug | `500 INTERNAL` |

O teste `[CRM-ERRMAP-8]` **varre o código-fonte**: toda mensagem `CRM: ...` que o domínio, o repositório e o Service podem lançar precisa estar mapeada ou declarada "interna por desenho"; uma mensagem nova, sem classificação, derruba a suíte.

## Conflito encontrado (código × documentação) e como foi tratado

O "Próximo passo" de [0014](./0014-crm-service.md) mandava compor `createCrmService({ authorizeOperation: authorizeCrmOperation, repository })` **no `src/server/index.js`**, com o adapter de arquivo. Mas a regra R12 (a mesma 0014) proíbe `src/server` de importar `src/crm` — e o adapter de arquivo vive em `src/crm`. Os dois textos não cabiam juntos.

**Resolução (sem alterar nenhuma regra nem nenhum teste de arquitetura):** uma fábrica na camada de serviços, `createFileBackedCrmService({ authorizeOperation, filePath })` (`src/services/crmFileService.js`), que só faz `createCrmService({ authorizeOperation, repository: createJsonFileCrmRepository(filePath) })`. `src/services` **pode** importar `src/crm` (R12), e a raiz de composição passa só um **caminho** — exatamente o desenho da Approval Queue (`queuePath`). O `crmService.js` continua sem conhecer adapter nem arquivo (`CRM-SVC-7` inalterado); a fábrica não decide nada (o autorizador é injetado, o caminho não tem padrão escondido). O texto do "Próximo passo" de 0014 foi corrigido para apontar para cá.

*Opção não escolhida, registrada:* abrir uma exceção na R12 para a raiz de composição importar `src/crm/crmRepository`. Enfraqueceria a garantia "só o Service alcança o domínio" (o servidor passaria a poder importar qualquer coisa de `src/crm`) sem ganhar nada além de uma indireção a menos. Reversível: a fábrica tem 5 linhas e um único uso.

## Composição e persistência

`RIO_X7_CRM_PATH` (opcional, padrão `data/crm.json`; caminho relativo é resolvido a partir do diretório de execução) aponta o arquivo JSON do CRM — o adapter de **desenvolvimento** (0013), que **não é a persistência de produção**. `data/*.json` está no `.gitignore`: quando houver dado real de prospects nesse arquivo ele nunca entra no Git. O arquivo só é lido/escrito quando uma operação roda: um arquivo corrompido aparece no primeiro uso como `500` das rotas do CRM, sem derrubar o resto do servidor (a fila e o `/api/me` seguem funcionando).

## Segurança verificada (com teste para cada item)

Sem token, token inválido, token expirado, usuário inexistente, usuário inativo, usuário sem permissão; escalada de privilégio (closer enviando `role: ADMIN`/`permissions`/cabeçalhos de identidade); `userId`/`authUserId`/`role`/`permissions`/`reviewedBy`/`actor` forjados em toda escrita; ids perigosos (`__proto__`, `constructor`, `prototype`, path traversal, NUL, só espaço, encoding inválido, gigante) em **ambos** os adapters; poluição de protótipo por payload e em tempo de execução; payloads inesperados (aninhamento profundo, números gigantes, chaves vazias); métodos errados e `Allow`; `Content-Type` errado; JSON inválido/vazio/não-objeto; corpo excessivo (declarado e em streaming); CORS ausente mesmo com `Origin` estrangeiro e preflight `OPTIONS` → `405`; cabeçalhos de segurança e CSP; o token nunca em resposta, cabeçalho ou log; `authUserId`, e-mail de login e campos internos nunca na resposta — nem com o arquivo adulterado; nenhum stack, caminho ou mensagem interna em `500`; o log nunca registra o id do registro, o corpo ou um campo.

Mutação (57 mutantes em cópia, em: pipeline e métodos, corpo e identidade forjada, prototype pollution, delegação ao Service, mapeamento de erros, composição, fábrica e fronteiras arquiteturais): **57 mutantes, 57 detectados** (nenhum sobrevivente). Um deles (a fábrica importando `src/auth`) só foi detectado depois de incluir `tests/services/crmFileService.test.js` no conjunto de testes da checagem — o `CRM-FILE-7`, que fecha a lista de importações da fábrica: era uma lacuna da seleção de testes da checagem, não do conjunto de testes. A linha de base (sem mutação) passou limpa. Mutantes típicos: a autenticação deixa de rodar antes das rotas; `DELETE`/`PUT` aceitos; a query deixa de ser recusada; o corpo das rotas de ação ganha protótipo ou lê chaves herdadas; `reviewedBy`/`actor` repassados como opções; a API passa a autorizar por role; um autorizador permissivo na composição; a mensagem de DNC repetindo o id; um padrão de erro sem âncora; a fábrica sobre o repositório em memória.

## Limites e decisões pendentes (registrados, não resolvidos)

- **Sem filtros, busca nem paginação:** `GET /api/crm` devolve todos os registros (o adapter de arquivo relê o arquivo inteiro a cada operação — aceitável para o volume desta etapa, não é produção). Filtros/busca são decisão de produto e do CRM-DASHBOARD.
- **Sem exclusão** (o domínio não tem; 0014).
- **Mensagens de validação genéricas:** `400` diz *o tipo* do problema (`Valor inválido em um dos campos.`), não *qual* campo. Se o Dashboard precisar de erro por campo, exige mudar o domínio para devolver códigos — decisão futura.
- **Recusas de duplicidade/DNC não dizem qual registro existe** (mensagem fixa, sem id): só o aviso de *possível* duplicidade de uma criação bem-sucedida traz `matchedRecordId`. Um Dashboard que queira "abrir o registro existente" precisará de uma decisão.
- **O closer não pode marcar `DO_NOT_CONTACT`** (não tem `WRITE:CRM`) e **editar campos não gera histórico** — ambos herdados de 0014, continuam pendentes.
- **Corpo de no máximo 16 KiB** (limite do servidor, o mesmo da fila): uma observação enorme é `413`.
- **Sem rate limiting e sem trava entre processos:** o servidor é local (`127.0.0.1`), um processo; um proxy HTTPS/limite de taxa é decisão de quando isso for exposto.
- **A porta de persistência é síncrona** (0014): um adapter de rede (Supabase/Postgres — candidato, não decidido) exigirá tornar domínio, Service e esta camada `async`.
- **Validado só com um Supabase falso na borda de rede:** o login real (Breno/Rafael) é validado manualmente por Breno; nenhuma credencial foi usada por esta etapa.
- **Achado aberto, fora do escopo, só reportado (0014):** `identityKeys()` de `research-prospector` considera um único número por registro; afeta a Approval Queue/descoberta, não o CRM.

## O que NÃO foi implementado

Dashboard do CRM, Kanban, qualquer UI, SDR, outbound, WhatsApp, prospecção, persistência Supabase/Postgres, permissões novas, subscriptions, IA no CRM, exclusão, filtros/busca, a promoção Approval Queue → CRM (CRM-INTEGRATION) e qualquer mudança em `research-prospector`. Nenhuma permissão foi criada ou alterada; a matriz é a de sempre (`ADMIN` lê e escreve; `COMMERCIAL_CLOSER` só lê).

## Próximo passo

**CRM-DASHBOARD** — as telas sobre estas rotas (o Dashboard só fala HTTP). Aguardando autorização explícita. **CRM-INTEGRATION** (promoção Approval Queue → CRM) segue pendente, sem data.

## Atualização (2026-09-24)

O "Dashboard (futuro)" do diagrama acima já existe: a etapa CRM-DASHBOARD V1 (2026-09-23) consome estas rotas sem alterar nenhum contrato desta decisão. O que foi feito, as limitações que a interface tornou visíveis e as decisões ainda pendentes estão no [CHANGELOG](../../CHANGELOG.md) (entrada "CRM Dashboard V1") e em [CONTINUE-HERE](../operations/CONTINUE-HERE.md).

## Atualização (2026-09-25)

A promoção Approval Queue → CRM (CRM-INTEGRATION), que esta decisão registrava como pendente, foi implementada como **serviço**; nenhuma rota `/api/crm` nem `/api/approvals` foi criada ou alterada por ela (uma rota "promover" é etapa futura). O texto acima descreve o estado da etapa em que esta decisão foi escrita e foi preservado como histórico. Ver [0016 — CRM-INTEGRATION](./0016-crm-integration.md) e o [CHANGELOG](../../CHANGELOG.md).
