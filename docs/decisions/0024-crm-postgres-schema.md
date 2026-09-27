# 0024 — Esquema PostgreSQL proposto para o CRM (Fase B.1)

## Status

**Proposta, não aplicada.** Escrito em 2026-09-27, sobre a decisão [0023](./0023-crm-async-persistence-port.md) (porta de persistência assíncrona) e a auditoria real do Supabase da etapa 4.3 (projeto `rio-x7-ai-agency-os`, região `sa-east-1`, plano Free, sem tabela de CRM existente). **Revisado na etapa 1.1** (2026-09-27), com D1, D2, D5, D-MONEY-SCALE e D-CONCURRENCY decididos pelo proprietário, e a tabela de identidade removida. Este documento e a migration em `supabase/migrations/20260927120000_crm_initial_schema.sql` são só texto versionado — **nada foi criado no Supabase real**, nenhuma tabela, coluna, policy ou configuração de Auth foi alterada.

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

## 9. O que a Fase B.2 fará (proposta, não iniciada)

1. Você revisa esta migration (já com D1/D2/D5/D-MONEY-SCALE/D-CONCURRENCY aplicados) e decide se aplica ao projeto real.
2. Depois de aplicada: o adapter `src/crm/crmSupabaseRepository.js` (fora de `src/services/` e `src/crm/crmDomain.js`, respeitando R12), usando a `service_role` key (nunca exposta ao navegador), com testes contra um `fetch`/cliente falso — nunca contra o projeto real na suíte.
3. D-CONCURRENCY-PORT e D-IDENTITY-FUTURA decididos antes de o adapter usar `version` ou qualquer proteção de duplicidade no banco.
