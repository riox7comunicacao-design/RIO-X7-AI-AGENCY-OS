# 0029 — Persistência OFICIAL das entidades comerciais no Supabase (Funis, Etapas, Cards, Negociações e o histórico)

## Status

**Fase D1.1 — implementada LOCALMENTE e testada; NÃO publicada (nenhum `git add`/commit/push), NENHUMA migration aplicada, servidor operacional NÃO reiniciado, Supabase principal NÃO consultado.** Fecha o ponto pendente da seção 6 da decisão [0028](0028-negotiations-and-funnel-board.md): o armazenamento das entidades comerciais deixa de ser o arquivo e passa a ser o Supabase. **As migrations nunca foram executadas num PostgreSQL real** (não havia nenhum disponível): o que existe é o texto da migration, testes que o leem e um PostgREST falso que emula as mesmas regras. A primeira execução real é a homologação.

## 1. A decisão do proprietário

**O Supabase é o armazenamento oficial das entidades comerciais.** `data/funnels.json` e `data/negotiations.json` **não são** o armazenamento operacional definitivo. O modo arquivo continua existindo **só** para desenvolvimento isolado, testes e compatibilidade, e **nunca há fallback silencioso**: com `REPOSITORY_MODE=supabase` o servidor usa **exclusivamente** os adapters do Supabase para funis, etapas, cards e negociações, e se a configuração faltar a composição **falha**; se a tabela não existir, a leitura **falha** (nunca "nenhuma negociação"). Funis e negociações saem da **mesma decisão** (a fábrica `src/services/commercialRepositoryFactory.js`): não existe "negociação no arquivo e funil no Supabase", nem card em outro armazenamento.

## 2. O que existe: código × instalado × dependente de migration

| | Itens |
|---|---|
| **A. Em código (repositório)** | portas e adapters de arquivo de funis e negociações; domínios, serviços, rotas e Dashboard da D1; migrations versionadas: `20260927120000` (CRM), `20260928090000` (exclusão com auditoria), `20260928220000` (funis), `20260929100000` (cards, arquivamento), `20260930090000` e `20261017090000` (Exclusões Permanentes), `20261012090000` (catálogos), `20261018090000` (modalidades — C1) e a **nova** `20261019090000` (negociações — D1.1) |
| **B. Sabidamente instalado no Supabase** (pela documentação e pelas ativações já feitas) | `crm_records` (aplicada e validada), `crm_record_deletions` + `delete_crm_record_with_audit` (aplicada e validada), os catálogos `crm_services`/`crm_niches`/`crm_lead_origins` e as modalidades de pagamento do serviço (C1, ativada em 2026-10-17 com ANTES/DEPOIS conferidos). |
| **C. Depende de migration (estado NÃO verificado)** | as tabelas de **funis** (`20260928220000`) e o arquivamento de cards (`20260929100000`) — a documentação diz "sem registro de aplicação"; **não se presume que existam**: o ANTES (somente leitura) decide se são aplicadas antes. E toda a **`20261019090000`** (negociações, histórico, funções). As Exclusões Permanentes (`20260930090000`/`20261017090000`) seguem o estado já documentado e **não** entram nesta fase. |

## 3. A migration `20261019090000_crm_negotiations.sql` (aditiva; NÃO aplicada)

- **Aborta se faltar pré-requisito** (primeiro comando, fail-closed): `crm_records`, as quatro tabelas de funis, `removed_at` e o índice único dos cards ativos, `crm_services` com as três colunas de modalidades, as funções de exclusão com guarda — e também se `crm_negotiations` já existir. Não repete nem substitui as migrations anteriores.
- **`crm_negotiations`**: FKs para o cliente (`crm_records`), o funil, o card (**único**, FK adiável) e o serviço (`crm_services`, que nunca é apagado: a identidade do serviço contratado é permanente; o **nome** é uma foto); `prazo_meses` 1–120; `forma_pagamento` `UNICO`/`RECORRENTE`; `periodicidade`; **`valor_centavos BIGINT` (1 a 1 bilhão de reais)**; CHECK de **coerência pagamento × periodicidade × prazo** (prazo múltiplo da periodicidade) e de **situação × motivo × fechamento** (perdida exige motivo); `created_*`/`updated_*` de auditoria; índices por cliente, funil+situação, serviço e data. **TCV, MRR e equivalente mensal não são gravados** (derivam do contrato no servidor); nenhum valor recebido, nenhum `valorProposta`/`valorTotal`.
- **`crm_negotiation_events`**: o histórico **imutável** (sequência única por negociação, tipos fechados, `detalhe` JSONB). `UPDATE`/`DELETE` são recusados por **gatilho** — nos eventos **e** nos movimentos de card (`crm_funnel_card_moves`).
- **Cards**: `+ negotiation_id` (FK adiável, único); o índice único "um card ativo por (funil, registro)" é **recriado** para valer só sem negociação (`removed_at IS NULL AND negotiation_id IS NULL`) — um cliente tem várias negociações no mesmo funil; **gatilho de integridade** (a etapa é do funil do card; funil, registro e negociação de um card nunca mudam) e, nas etapas, o funil nunca muda: **nenhuma escrita cruzada entre funis**. Uma verificação **adiada até o COMMIT** garante que negociação e card concordam (funil, cliente, ligação nos dois sentidos).
- **Funções (só `service_role`, `SECURITY INVOKER`, `search_path` fixo)**: `commit_crm_negotiation_change`, `commit_crm_funnel_card_change`, `reorder_crm_funnel_stages` (+ a auxiliar `crm_negotiation_service_check`).
- **RLS ligada nas duas tabelas novas, sem policy; `anon` e `authenticated` sem nenhum privilégio; funções revogadas de `PUBLIC`.** O Dashboard nunca fala com o banco: fala com a CRM-API, que autentica e aplica o RBAC antes de chegar ao adapter.
- **Não toca** `crm_records`, `crm_services`, `crm_niches`, `crm_lead_origins`, `crm_record_deletions` nem as Exclusões Permanentes; **não insere nenhum dado** (nenhum funil, etapa ou negociação de exemplo).

## 4. Os adapters e a atomicidade (a regra central)

Adapters: `src/crm-adapters/crmSupabaseFunnelRepository.js` e `crmSupabaseNegotiationRepository.js`, sobre o cliente PostgREST compartilhado `postgrestClient.js` (leitura **completa e paginada**: total exato, faixa conferida, `id` repetido ou linha malformada = erro; nunca lista parcial nem "vazia" por falha; segredo só no cabeçalho). As mesmas portas e os mesmos contratos de domínio e API.

| Operação | Como é gravada no Supabase |
|---|---|
| criar negociação | **1 chamada**: card + primeiro movimento + negociação + histórico `[CRIADA]` |
| editar, ganhar, perder, reabrir | **1 chamada**: negociação + **evento novo** (o histórico só cresce) |
| mudar de etapa | **1 chamada**: card + movimento + negociação + evento `ETAPA` |
| card avulso: criar / mover | **1 chamada**: card + movimento (concorrência pela etapa esperada) |
| reordenar etapas | **1 chamada** (todas as posições ou nenhuma) |
| excluir funil | **1 chamada**: etapas + funil, só se não houver **nenhum** card |
| criar/editar/desativar funil ou etapa | upsert de **uma** linha (atômico por si) |

Uma gravação **não é concluída se o histórico obrigatório falhar**: é uma função PL/pgSQL (uma transação). **Concorrência otimista**: quem editou envia o `atualizadoEm` que leu; se outra pessoa gravou no meio, o banco recusa (`NEGOTIATION_CONFLICT`, 409) em vez de sobrescrever. Nenhuma falha de leitura vira lista vazia e nenhuma falha de gravação devolve sucesso ao Dashboard. As regras do domínio (cliente "Não Contatar", funil/etapa/serviço inativos, forma de pagamento que o serviço permite) **são repetidas no banco** (defesa em profundidade, para o caso de uma corrida entre a conferência e a gravação).

## 5. Diferenças entre o modo `file` e o `supabase` (deliberadas)

| | `file` (desenvolvimento/testes) | `supabase` (oficial) |
|---|---|---|
| Atomicidade | em passos (card, movimento, depois negociação; card arquivado se a criação falhar) | **uma transação** por operação |
| Concorrência entre processos | não detectada (um único escritor) | **detectada** (409 `NEGOTIATION_CONFLICT`) |
| Card **arquivado** | não impede excluir funil/etapa/cliente | **impede** (FK + histórico preservado): funil/etapa/cliente com qualquer card, mesmo arquivado, não se exclui — desative |
| Histórico de card | aceita movimento sem autor | **exige** `{ userId, name, role }` (o Service sempre fornece) |
| Dinheiro | reais (número) | **centavos inteiros** exatos; mais de duas casas é recusado |
| Fallback | — | **nenhum** |

## 6. Compatibilidade e ativação

Dados locais pré-existentes (`data/funnels.json`, `data/negotiations.json`) **não foram lidos nem migrados** e **nada é importado automaticamente** — em produção ainda não havia funil. `REPOSITORY_MODE=file` permanece para ambiente isolado. Em `supabase` os caminhos `RIO_X7_FUNNELS_PATH`/`RIO_X7_NEGOTIATIONS_PATH` **não são usados**. Catálogos C1, Fila de Aprovação, Exclusões Permanentes e DNC não foram alterados; nenhuma prospecção nem promoção ocorre.

## 7. Riscos reais de implantação

1. **Nada foi executado num PostgreSQL real.** Sintaxe PL/pgSQL, ordem de verificação de gatilhos × FKs, comportamento do `FOR UPDATE`/gatilho adiável e o reconhecimento do esquema pelo PostgREST só se provam na homologação. Mitigação: transação única (`ROLLBACK` em qualquer erro), tabelas novas vazias (desfazer é seguro), ANTES/DEPOIS somente leitura.
2. **As migrations de Funis podem não estar aplicadas** (e nunca foram vistas num banco real): são aplicadas antes, uma de cada vez, se o ANTES mandar.
3. **Servidor novo antes da migration** faz o quadro falhar com erro claro (não com vazio); por isso a ordem é parar → migrar → conferir → subir.
4. **Limites temporários de leitura** (10 mil negociações, 50 mil eventos por leitura; a lista é relida a cada abertura do quadro): acima disso a leitura falha, nunca devolve metade. Ao se aproximar, a próxima fase troca a leitura por filtros no banco.
5. **Card arquivado impede excluir cliente/funil/etapa** (diferença do modo arquivo): é a escolha conservadora que preserva o histórico.
6. **Responsável e papel**: o histórico do card exige o papel de quem moveu; contas sem papel não gravam (o Service sempre o fornece).

## 8. Ordem segura (resumo; o passo a passo está em `PLANO-ATIVACAO-D11.md`, fora do repositório)

ANTES (leitura) → se faltar, aplicar as de Funis (uma de cada vez) → **parar** o servidor → aplicar a `20261019090000` numa transação → `NOTIFY pgrst, 'reload schema'` → DEPOIS (leitura; contagens antigas iguais, tabelas novas vazias, RLS/privilégios) → publicar o commit → subir o servidor novo → Ctrl+F5 → o ADMIN cria o funil e as etapas pelo painel. Nenhum dado é importado.

## 9. Testes

Suítes que rodam **nos dois modos** (o mesmo arquivo, com o armazenamento trocado por uma variável): domínio de Negociações, Negotiation Service, API de Negociações, ponta a ponta do Dashboard (servidor real), domínio de Funis, Funnel Service, API de Funis e integridade CRM ↔ Card. Mais: adapters (`SBFUN`, `SBNEG`), integração estrita (`NEGSB`: uma requisição por operação, falha no meio sem resíduo, concorrência entre dois processos, corridas contra as regras do banco, cards antigos, estrutura atômica, leitura nunca vazia, paginação, financeiro), migration (`MIG-NEG`), fábrica (`COMFAC`) e guardas de arquitetura. O PostgREST falso (`tests/helpers/fakePostgrestCommercial.js`) emula as regras da migration; **não substitui um Postgres real**.
