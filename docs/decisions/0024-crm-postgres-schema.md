# 0024 — Esquema PostgreSQL proposto para o CRM (Fase B.1)

## Status

**Proposta, não aplicada.** Escrito em 2026-09-27, sobre a decisão [0023](./0023-crm-async-persistence-port.md) (porta de persistência assíncrona) e a auditoria real do Supabase da etapa 4.3 (projeto `rio-x7-ai-agency-os`, região `sa-east-1`, plano Free, sem tabela de CRM existente). **Revisado na etapa 1.1** (2026-09-27), com D1, D2, D5, D-MONEY-SCALE e D-CONCURRENCY decididos pelo proprietário, e a tabela de identidade removida. **Estendido na etapa 2** (2026-09-27) com o scaffolding de código do futuro adapter (seção 10) — ainda **nada foi criado no Supabase real**: nenhuma tabela, coluna, policy ou configuração de Auth foi alterada, e nenhum código novo é usado por nenhum caminho de produção/dev.

Escopo: **só o CRM** (`src/crm/`, `src/services/crmService.js`). A Approval Queue, os lotes de prospecção, os dossiês, o Researcher e o Discovery continuam em `data/*.json` — sem nenhuma referência (foreign key) a eles nesta migration.

## 1. Estrutura atual (auditada)

- **Entidade:** um registro de CRM, definido por `CRM_WRITABLE_FIELDS` (31 campos graváveis, todos opcionais exceto `empresa`) mais os campos gerenciados pelo domínio: `id`, `status`, `dataDeEntrada`, `historico` (`CRM_MANAGED_FIELDS`, `src/crm/constants.js`).
- **Tipos:** 29 campos são texto (`typeof valor === 'string'`, e uma string em branco vira `null` antes de gravar — `sanitizeWritableInput`/`trimmedOrNull` em `crmDomain.js`); 2 são numéricos (`valorProposta`, `valorTotal`: `Number.isFinite(v) && v >= 0`, ou `null`).
- **Datas** (`dataDaAnalise`, `dataDaReuniao`, `ultimaInteracao`, `dataDaProximaAcao`): são **texto livre**, sem validação de formato — o domínio nunca exigiu ISO 8601 aqui (só a UI do Dashboard rotula esses campos como "date", `dashboard/crm-model.mjs`).
- **`id`:** `crm:<uuid>`, gerado pela aplicação (`crypto.randomUUID()`), nunca pelo banco.
- **`status`:** os 13 valores de `CRM_STATUS`. Máquina de estados em `ALLOWED_TRANSITIONS`: os 10 status de funil vão livremente entre si, ou para `WON`/`LOST`/`DO_NOT_CONTACT`; `WON` e `LOST` só vão para `DO_NOT_CONTACT`; `DO_NOT_CONTACT` é terminal (sem saída).
- **`dataDeEntrada`:** ISO 8601 exato (`new Date().toISOString()`), gerado uma vez, na criação.
- **`historico`:** lista de eventos `{ timestamp, from, to, actor, reviewedBy: {userId,name,role} | null, motivo }`, um por criação e por mudança de status (editar campos comuns **não** gera evento — limite já documentado na 0014). A idempotência da promoção Approval Queue → CRM depende de `historico[0]` carregar um marcador no `motivo` (`carriesMarker`, `crmIntegrationService.js`).
- **Identidade/duplicidade:** `IDENTITY_FIELDS = [empresa, site, telefone, whatsapp, instagram, cidade]`. A comparação de fato roda em `research-prospector/normalize.js` + `duplicateCheck.js`/`doNotContact.js`: domínio do site sem `www.`, telefone por dígitos (removendo `55` só quando o tamanho deixa claro), handle do Instagram normalizado; `telefone` e `whatsapp` geram **duas visões** independentes do mesmo registro. Um match forte (site/telefone/instagram) bloqueia criação (`DUPLICATE_RECORD`) ou aponta DNC (`DNC_BLOCKED`); um match só por nome+cidade é aviso, nunca bloqueio. **Esta migration não mexe nisso** — ver seção 5.
- **Concorrência:** hoje é só dentro de um processo — a porta assíncrona (0023) serializa as escritas de um mesmo repositório, então "ler, decidir, gravar" é indivisível **enquanto houver um único processo/servidor**. Não existe hoje nenhuma proteção entre processos.
- **Ordem:** a listagem (`listRecords`) devolve os registros na ordem de inserção do arquivo/objeto — nunca ordenada por outro critério.

## 2. Estrutura PostgreSQL proposta

Ver o SQL comentado em [`supabase/migrations/20260927120000_crm_initial_schema.sql`](../../supabase/migrations/20260927120000_crm_initial_schema.sql) para o detalhe campo a campo. Resumo:

| Domínio | Coluna Postgres | Tipo | Observação |
|---|---|---|---|
| `id` | `id` | `TEXT PRIMARY KEY` | `CHECK` no formato `crm:<uuid>`; gerado pela aplicação, não pelo banco |
| — | `seq` | `BIGINT GENERATED ALWAYS AS IDENTITY` | só para preservar a ordem de inserção; nunca exposta ao domínio |
| 29 campos de texto (`CRM_WRITABLE_FIELDS`) | snake_case (`googlePerfil` → `google_perfil`, `raioXDeNicho` → `raio_x_de_nicho`, ...) | `TEXT` | `CHECK` opcional: nunca uma string em branco, só `NULL` ou não-vazia (mesma regra do domínio) |
| `valorProposta`, `valorTotal` | `valor_proposta`, `valor_total` | `NUMERIC(15,2)` | `CHECK >= 0` ou `NULL` — **decidido** na etapa 1.1 (D-MONEY-SCALE) |
| `status` | `status` | `TEXT` | `CHECK IN (...)` com os 13 valores; **não** um `ENUM` nativo (ver justificativa no SQL) |
| `dataDeEntrada` | `data_de_entrada` | `TEXT` | mantém o ISO 8601 exato como string — **decidido** (D5) |
| `historico` | `historico` | `JSONB` | `CHECK` de array não vazio; preserva ordem e forma dos eventos |
| — | `version`, `updated_at` | `INTEGER`, `TIMESTAMPTZ` | concorrência otimista (D-CONCURRENCY); nenhum código de aplicação os usa ainda — ver seção 6 |

**RLS:** ligada em `crm_records`, **sem nenhuma policy** — **decidido** (D1 + D2, seção 4). Como o servidor usa a `service_role` (que ignora RLS), a ausência de policy para `anon`/`authenticated` não bloqueia o servidor; ela impede qualquer outro caminho.

**Sem tabela de identidade nesta migration** (ver seção 5): `crm_identity_index`, proposta na primeira versão deste documento, foi **removida** por decisão explícita da etapa 1.1.

## 3. Decisões tomadas

- **`CHECK`, não `ENUM`, para `status`:** evita `ALTER TYPE` para toda mudança futura; a lista oficial já vive em `constants.js` e passa a viver também aqui — um teste estrutural (`tests/db/crmMigration.test.js`) garante que as duas não divergem.
- **`TEXT`, não `DATE`, para os quatro campos de "data":** o domínio nunca validou formato; `DATE` recusaria uma entrada hoje aceita.
- **`TEXT`, não `TIMESTAMPTZ`, para `dataDeEntrada` (D5, confirmado):** evita que o driver/Postgres reformate a string na leitura, o que quebraria comparações de igualdade exata já usadas em testes.
- **`JSONB` para `historico`:** decisão já tomada na 0023, não reaberta aqui.
- **`NUMERIC(15,2)` para os campos monetários (D-MONEY-SCALE, confirmado):** o domínio não fixava escala; valores com mais de 2 casas decimais (nenhum caso conhecido hoje) seriam arredondados ao gravar — risco aceito explicitamente pelo proprietário.
- **`version`/`updated_at` com trigger (D-CONCURRENCY, confirmado):** preparam o lado do BANCO para concorrência otimista. O lado do DOMÍNIO (a porta `crmRepositoryPort.js` não tem como pedir "grave só se a versão ainda é esta") **não foi alterado** — é uma evolução de contrato registrada, não feita (seção 6). O trigger não muda nenhum comportamento observável hoje: nada lê ou escreve `version`/`updated_at`.
- **`service_role` no servidor, sem policy para anon/authenticated (D1 + D2, confirmado):** o navegador nunca fala com este banco; só o servidor, com uma credencial que ignora RLS. RLS fica ligada mesmo assim, como cinto de segurança contra qualquer outro caminho.
- **Sem `crm_identity_index` (confirmado):** a deduplicação continua só em JavaScript, como hoje. Réplicar `normalize.js` em SQL/triggers é uma decisão de arquitetura própria, para uma etapa específica — não uma consequência automática desta migration.
- **Sem foreign key para fila/lotes/dossiês:** fora do escopo desta etapa, por instrução explícita.

## 4. Credencial e RLS — D1 e D2 (decididas)

- **D1:** o servidor usa a `service_role` key para falar com este banco. Essa chave **nunca** chega ao navegador (nunca vai a `/config.json`, nunca a nenhuma resposta HTTP) — o mesmo cuidado que já vale hoje para `SUPABASE_ANON_KEY` vs. uma chave de servidor. O navegador **nunca** acessa o CRM PostgreSQL diretamente: só fala HTTP com o servidor (`/api/crm/...`), como já acontece com `data/crm.json`.
- **D2:** RLS fica **ENABLED**. Nesta primeira versão, **nenhuma policy** é criada para `anon`/`authenticated` — o acesso é exclusivamente pelo servidor autorizado. Como a `service_role` ignora RLS, isso não veta o servidor; veta qualquer outro caminho.

## 5. Deduplicação — removida desta migration

A etapa 1.1 removeu `crm_identity_index` (a tabela de chaves normalizadas para `UNIQUE(kind, normalized_key)` proposta na primeira versão deste documento). A deduplicação e o bloqueio DNC continuam **inteiramente** em `research-prospector/normalize.js` + `duplicateCheck.js`/`doNotContact.js`, exatamente como hoje — nenhuma tabela, índice ou constraint de identidade existe nesta migration. Uma etapa futura, com sua própria decisão, tratará se e como replicar essa proteção no banco.

## 6. Concorrência otimista — o que está preparado e o que falta

**Preparado nesta migration** (lado do banco): as colunas `version` (começa em 1) e `updated_at`, e um trigger que incrementa `version` e atualiza `updated_at` em toda atualização. O padrão de uso pretendido para o futuro adapter:

```sql
UPDATE public.crm_records SET <campos...> WHERE id = $1 AND version = $2 RETURNING *;
```

Zero linhas devolvidas = a versão esperada não bate mais (conflito de concorrência) — o adapter deve tratar isso como erro, nunca sobrescrever silenciosamente.

**NÃO preparado, e não decidido nesta etapa** (lado do domínio): a porta atual (`src/crm/crmRepositoryPort.js`) não tem como o domínio informar "a versão que eu li" nem como o adapter devolver "conflito de versão" de um jeito que o domínio entenda. Isso exige **evoluir o contrato da porta** — por exemplo, `save(record, { expectedVersion })` mais um erro estável que o Service saiba repassar. Essa mudança **não foi feita**: `crmDomain.js` e `crmService.js` continuam exatamente como na decisão 0023. Fica registrada como D-CONCURRENCY-PORT, para quando o adapter Supabase for de fato escrito.

## 7. Riscos

1. **`NUMERIC(15,2)` arredonda** um valor com mais de 2 casas decimais, se algum dia existir (nenhum hoje).
2. **`version`/`updated_at` sem uso real ainda:** até a porta evoluir (seção 6), a concorrência otimista só existe dentro do banco — o domínio continua vulnerável à mesma limitação de hoje (um único processo).
3. **`dataDeEntrada` como texto** perde a capacidade nativa do Postgres de indexar/comparar por data — aceito, ver D5.
4. **Sem proteção de duplicidade no banco:** exatamente como hoje (em memória/arquivo), a garantia inteira depende do código JavaScript rodando; um acesso direto ao banco (fora do servidor) poderia criar duplicatas — mitigado por D1/D2 (só o servidor acessa).
5. **Cadastro aberto no Auth** (achado da etapa 4.3, `disable_signup: false`): não é resolvido por esta migration; irrelevante para D1/D2 porque o acesso ao CRM não depende de `authenticated`.

## 8. Pontos que ainda precisam de confirmação

| # | Pendência | Opções |
|---|---|---|
| D-CONCURRENCY-PORT | Como o Repository Port vai expor `expectedVersion` ao domínio | estender `save()` com uma opção, ou um método novo — mudança de contrato, fora desta etapa |
| D-IDENTITY-FUTURA | Se e como replicar a deduplicação no banco | tabela de chaves normalizadas (como a removida) com população por trigger ou pelo adapter; decisão de uma etapa própria |

D1, D2, D5, D-MONEY-SCALE e D-CONCURRENCY (o lado do banco) estão **decididos** e refletidos na migration.

## 9. O que a Fase B.2 fará (proposta, parcialmente adiantada na etapa 2 — seção 10)

1. Você revisa esta migration (já com D1/D2/D5/D-MONEY-SCALE/D-CONCURRENCY aplicados) e decide se aplica ao projeto real.
2. Depois de aplicada: **configurar** `SUPABASE_SERVICE_ROLE_KEY` num ambiente de servidor (nunca versionado, nunca no navegador) e **ligar** o adapter (seção 10) a algum caminho real — nenhum existe hoje.
3. D-CONCURRENCY-PORT e D-IDENTITY-FUTURA decididos antes de o adapter usar `version` ou qualquer proteção de duplicidade no banco.

## 10. Scaffolding de código preparado na etapa 2 (sem ligação a produção, sem rede)

Sobre a auditoria do contrato atual (`src/crm/crmRepositoryPort.js`: `list()`/`getById(id)`/`save(record)`, todas aceitando síncrono ou assíncrono desde a 0023; erros como `Error` simples com prefixo `"CRM: "`; `save()` sempre recebe o registro INTEIRO e não devolve nada; a composição de produção em `src/server/index.js` monta os `*FileService` diretamente, sem seleção de adapter), três arquivos novos, todos em `src/crm/` (mesma pasta do adapter de arquivo, mesma fronteira de arquitetura — regra R12: só `src/services/` e o próprio `src/crm/` podem importar daqui):

- **`crmSupabaseConfig.js`** — `readSupabaseCrmConfig(env)` exige `SUPABASE_URL` (https) e a variável NOVA `SUPABASE_SERVICE_ROLE_KEY`; lança um erro citando só o NOME da variável ausente, nunca um valor. `isSupabaseCrmConfigured(env)` é a versão que não lança. Nada chama isto automaticamente — só quem construir o adapter explicitamente.
- **`crmSupabaseMapping.js`** — conversão PURA e sem rede entre o registro do domínio e a linha da tabela: `FIELD_COLUMNS` deriva mecanicamente (camelCase → snake_case) dos 31 `CRM_WRITABLE_FIELDS`, a mesma conversão já usada para escrever a migration; `recordToRow`/`rowToRecord` fazem a ida e volta sem perda, e `rowToRecord` descarta de propósito `seq`/`version`/`updated_at` (colunas de armazenamento que nunca fizeram parte do contrato do domínio — se vazassem, `moveStatus`/`updateRecord`, que fazem `{ ...record, ... }`, as carregariam adiante sem necessidade). Um teste (`tests/crm/crmSupabaseMapping.test.js`) confere que este módulo nunca diverge da migration real.
- **`crmSupabaseRepository.js`** — `createSupabaseCrmRepository({ url?, serviceRoleKey?, env?, fetchImpl?, table? })` implementa `list`/`getById`/`save` falando PostgREST **direto por `fetch` nativo** (sem `@supabase/supabase-js` — decisão explícita desta etapa, ver abaixo), todas `async`. `save()` faz um upsert por `id` (`Prefer: resolution=merge-duplicates,return=minimal`), preservando "insere ou substitui" e "não devolve nada" do contrato atual. Nenhum parâmetro de versão esperada existe (D-CONCURRENCY-PORT continua em aberto). `fetchImpl` é sempre injetável e nada no projeto o inicializa sozinho.

**Por que `fetch` e não o SDK:** a instrução da etapa foi explícita (preferir PostgREST/`fetch`, sem justificar uma dependência nova) e a regra R7 (`tests/auth/architecture-boundaries.test.js`) já restringe `@supabase/supabase-js` a `src/auth/authAdapter.js`. PostgREST é uma API REST simples o bastante para não precisar de SDK, e o `fetch` nativo do Node (≥ 22) evita qualquer dependência nova.

**Estratégia de segredos:** `SUPABASE_SERVICE_ROLE_KEY` é lida só por `crmSupabaseConfig.js`, só de `process.env` (ou de um objeto explícito em teste); nunca aparece em log (os três arquivos não chamam `console.*`, conferido por teste estático), nunca em mensagem de erro (todo erro cita só o nome da variável ou a mensagem que o PostgREST devolveu), nunca em `.env.example` com valor real, e nunca chega ao `publicConfig` que o servidor manda ao navegador (`src/server/index.js` continua só com `supabaseUrl`/`supabaseAnonKey` — testado). `dashboard/` (código client-side) nunca contém a palavra "service_role", em nenhuma caixa — testado.

**Nada disto é usado hoje:** `src/server/index.js`, `app.js` e `static.js` não importam `createSupabaseCrmRepository` nem leem `SUPABASE_SERVICE_ROLE_KEY` — testado estaticamente. O CRM local continua sendo a única persistência em uso; ligar o adapter novo a qualquer caminho real é uma decisão futura, não tomada aqui.

**Testes (33, sem rede, em `tests/crm-adapters/` desde a etapa 2.1):** `crmSupabaseConfig.test.js`, `crmSupabaseMapping.test.js`, `crmSupabaseRepository.test.js`, `architecture.test.js` — este último substitui o `fetch` global por uma função que lança, para todo o arquivo, como garantia extra de que nenhum teste (nem um escrito por engano) alcança a rede real; todo `fetch` usado é um double passado explicitamente.

## 11. Auditoria estática do adapter (etapa 2.2) — achados, sem alteração de código

Revisão linha a linha de `src/crm-adapters/*.js` contra `crmRepositoryPort.js`, `crmDomain.js`, `crmService.js`, a migration e `src/server/app.js`. **Nenhum código foi alterado**: nenhum achado abaixo é um erro objetivo e inequívoco que tornaria a implementação futura incorreta — só decisões de design a confirmar, ou lacunas já sabidas.

| Severidade | Achado |
|---|---|
| MÉDIO | **Tradução de erro HTTP não definida.** O catálogo de `mapErrorToHttp` (`src/server/app.js`) só reconhece mensagens com o prefixo exato `"CRM: "`; as do adapter usam `"CRM (Supabase): "`. Enquanto isso não for decidido, **todo** erro do adapter (rede fora, PostgREST recusando por qualquer motivo, 4xx ou 5xx) cairia no `INTERNAL` genérico (500 "Erro interno...") — seguro (nunca vaza nada), mas sem distinguir um erro de validação de uma queda de rede. Nada foi implementado: seria "inventar códigos novos", vetado nesta etapa. |
| MÉDIO | **O erro lançado por `postgrest()` não carrega o status HTTP nem o código do PostgREST como propriedade** (só a mensagem, como `Error` simples). Se uma tradução de erro for desenhada no futuro (item acima), vai precisar desse dado estruturado — hoje ele se perde depois do `throw`. Não alterei a forma do erro nesta etapa: qual seria essa forma (uma propriedade `.status`? uma classe própria, como `TransportError` em `research-adapters/httpsTransport.js`?) é uma decisão de design, não um bug a corrigir sozinho. |
| BAIXO | **`save()` não envia `on_conflict=id` explícito** no upsert (`Prefer: resolution=merge-duplicates`). O comportamento documentado do PostgREST, na ausência desse parâmetro, é usar a chave primária da tabela como alvo do conflito — que é exatamente `id` aqui, então o comportamento pretendido ("insere ou substitui por id") deveria valer sem o parâmetro. Não verificado contra uma instância real (esta auditoria é só estática — nenhuma chamada HTTP foi feita). Recomendação, não aplicada: passar `on_conflict: 'id'` explicitamente na Fase B.2, para não depender de um comportamento implícito do PostgREST. |
| BAIXO | **`table` (parâmetro de `createSupabaseCrmRepository`) é concatenado direto num caminho de URL, sem validação.** Só existe "para teste/depuração" (comentário do próprio arquivo) e nunca recebe entrada de fora do processo — sem risco real hoje, registrado só por completude. |
| — (verificado, não é achado) | **`historico` como JSONB:** Postgres/PostgREST embutem uma coluna `jsonb` como JSON aninhado (nunca como string escapada) — `rowToRecord` não re-parseia `row.historico`, o que está correto para esse comportamento documentado. Não testado contra uma instância real. |
| — (verificado, não é achado) | **`valorProposta`/`valorTotal` (NUMERIC) voltam como número JSON**, não como string — `Number.isFinite` no domínio continuaria válido. Não testado contra uma instância real. |
| — (verificado, não é achado) | **`list()` já usa `order=seq.asc`** (preserva a ordem de inserção); **`getById()`** filtra por `id=eq.<id>&limit=1` (a unicidade de `id` como chave primária torna "múltiplos registros" estruturalmente impossível); **`seq`/`version`/`updated_at`** são descartados por `rowToRecord` e nunca enviados por `recordToRow` — o domínio não os vê em nenhuma direção, e o trigger de versão só altera comportamento observável se algo um dia passar a ler essas colunas (não é o caso). |

**Compatibilidade com o Repository Port:** confirmada — `createSupabaseCrmRepository()` devolve `{ list, getById, save }`, todas `async`, satisfazendo `assertValidRepository` sem qualquer mudança no domínio (testado em `[SBR-2]`).

**Compatibilidade com a migration:** confirmada — todas as colunas usadas pelo mapeamento existem na migration com o tipo esperado (`tests/crm-adapters/crmSupabaseMapping.test.js` + `tests/db/crmMigration.test.js` cruzam os dois).

**Server composition — onde a troca vai acontecer:** `src/server/index.js`, função `createServer()`. Hoje ele monta **três** instâncias independentes de serviço/repositório de CRM (`createFileBackedCrmService`, dentro de `createFileBackedCrmIntegrationService` e de `createFileBackedProspectingService`, cada uma chamando `createJsonFileCrmRepository` de novo). Isso é inofensivo com o arquivo local, mas relevante para o dia da troca: a trava de escrita de `crmDomain.js` (decisão 0023) é por **objeto** repositório (`WeakMap`) — três instâncias separadas do adapter Supabase teriam três filas de escrita independentes, sem se protegerem entre si. Já registrado como parte de D-CONCURRENCY-PORT; reforçado aqui como um requisito concreto para quando `index.js` for alterado: as três composições devem compartilhar **uma única instância** do repositório escolhido.

**Dependências:** nenhuma nova — confirmado (`package.json` inalterado, `fetch` nativo).

## 12. Composição por REPOSITORY_MODE e instância única (etapa 2.3) — o achado de "server composition" da etapa 2.2, resolvido em parte

A seção 11 apontou que `src/server/index.js` montava **três** instâncias independentes de repositório de CRM. A etapa 2.3 resolveu isso, sem alterar o Repository Port nem o domínio:

- **`src/services/crmFileService.js`** passou a reaproveitar o repositório de arquivo **por caminho**, dentro do processo (`sharedFileCrmRepository`, um `Map` simples). O adapter de arquivo não tem estado em memória (cada operação relê o disco), então isso não muda nada que os testes já observavam — só faz com que chamadas para o MESMO caminho caiam na MESMA fila de escrita de `crmDomain.js` (decisão 0023), em vez de filas independentes. **Demonstrado por mutação**, não só argumentado: removendo o cache, a mesma corrida entre dois `createFileBackedCrmService()` cria 2 cópias do mesmo registro em 30 de 30 tentativas (`tests/services/crmFileService.test.js`, `[CRM-FILE-8]`); com o cache, 0 de 30. `createJsonFileCrmRepository()` chamado direto (fora desta fábrica) continua sem cache, como sempre — os testes que dependem disso (`[CRM-SVC-45]`, `[CRM-JSON-*]`) continuam passando sem alteração.
- **`src/services/crmRepositoryFactory.js`** (novo): lê `REPOSITORY_MODE` do ambiente — ausente ou `"file"` usa o adapter de arquivo (via `crmFileService.js`, logo com o mesmo cache); `"supabase"` é **recusado incondicionalmente** nesta versão (nunca cai para `"file"` em silêncio), com uma mensagem que aponta para esta decisão. Nenhuma chamada de rede acontece em nenhum modo — o bloqueio do modo `supabase` acontece ANTES de qualquer tentativa de montar o adapter.
- **`src/server/index.js`** só mudou a construção do CRM Service direto: `createFileBackedCrmService(...)` virou `createConfiguredCrmService({ env, ... })`. As chamadas de `createFileBackedCrmIntegrationService`/`createFileBackedProspectingService` (promoção e prospecção) **não mudaram uma linha** — elas continuam chamando `createFileBackedCrmService` internamente, e por isso acabam compartilhando o mesmo repositório automaticamente, via o cache de `crmFileService.js`. Como a construção do CRM Service é a primeira das três, um `REPOSITORY_MODE=supabase` já lança antes de a promoção/prospecção serem sequer montadas.
- **Por que a fábrica de modo fica em `src/services/`, não em `src/server/` nem em `src/crm-adapters/`:** mesmo raciocínio do resto do arquivo (seção 10) — só `src/services/` pode importar `src/crm` (R12) e, por construção simétrica, decidir ENTRE adapters é uma decisão de composição da aplicação, não responsabilidade de um adapter sobre o outro.
- **`REPOSITORY_MODE=file` nunca exigiu, e continua não exigindo, `SUPABASE_SERVICE_ROLE_KEY`** — são preocupações completamente independentes.

Testes: `tests/services/crmFileService.test.js` (`[CRM-FILE-8]`) e `tests/server/crm-repository-composition.test.js` (`[COMPOSE-1]` a `[COMPOSE-5]`, `[FACTORY-1]` a `[FACTORY-4]`) — modo file funcional, modo supabase bloqueado (com e sem `SUPABASE_SERVICE_ROLE_KEY` presente), modo inválido recusado, instância única provada por igualdade de objeto e por uma corrida real sobre o servidor de produção (`createServer`), e a leitura da prospecção enxergando o que a rota direta do CRM gravou. `tests/server/crm-api-boundaries.test.js` ([CRM-API-ARCH-3]/[CRM-API-ARCH-4]) foi atualizado para a nova forma exata da composição (o mesmo tipo de teste que já existia, só refletindo o import/chamada novos).

Pendências que isto NÃO resolve (inalteradas): D-CONCURRENCY-PORT, tradução de erro HTTP, `on_conflict` explícito, D-IDENTITY-FUTURA. `REPOSITORY_MODE=supabase` continua bloqueado até essas decisões avançarem.
