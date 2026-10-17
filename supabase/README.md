# `supabase/` — migrations versionadas, NÃO aplicadas automaticamente

Este diretório guarda o SQL da persistência do projeto em Postgres/Supabase, como texto revisável no Git — não uma conexão ativa com o projeto. **Nada aqui é executado por `npm test`, por nenhum script do projeto, nem por CI**: aplicar uma migration é sempre uma ação humana e deliberada do proprietário.

## Estado das migrations — o que está DOCUMENTADO (não verificado no banco)

> **Leia isto antes de confiar na coluna "estado".** Ela registra **o que a documentação do projeto afirma**. **Nenhuma consulta ao banco real foi feita** ao escrevê-la, e **o cabeçalho de todos os arquivos SQL diz "NÃO APLICADA"** — um texto da época em que cada um era só uma proposta, que não foi atualizado depois das aplicações. Por isso o cabeçalho **não prova nada** para nenhum dos lados. Antes de qualquer decisão que dependa do estado real, confira no painel do Supabase (Table Editor / SQL Editor).

| Migration | O que cria | Estado **documentado** | Fonte |
|---|---|---|---|
| `20260927120000_crm_initial_schema.sql` | `crm_records` (os 31 campos graváveis do CRM + `status`, `historico`, `version`), RLS ligada sem policy, gatilho de versão | Documentada como **aplicada e validada remotamente** (RLS ligada, 0 policies, 1 trigger). `REPOSITORY_MODE=supabase` é a persistência oficial do CRM | decisão [0024](../docs/decisions/0024-crm-postgres-schema.md) §13 |
| `20260928090000_crm_delete_audit.sql` | `crm_record_deletions` e a função transacional `delete_crm_record_with_audit` (exclusão administrativa e irreversível do CRM) | Documentada como **aplicada e validada** (teste E2E real, etapas 3O.8–3O.10) | decisão [0025](../docs/decisions/0025-crm-admin-delete.md) |
| `20260928220000_crm_funnels.sql` | `crm_funnels`, `crm_funnel_stages`, `crm_funnel_cards`, `crm_funnel_card_moves` e funções de exclusão com guarda (Funis, etapa "Funis 1") | Documentada como **NÃO aplicada**: o backend de Funis usa só o arquivo local (`data/funnels.json`); um adaptador Supabase de Funis não existe | README anterior deste diretório |
| `20260929100000_crm_funnel_cards_funis2.sql` | Complementa os cards de Funis (arquivamento em vez de exclusão física; etapa "Funis 2") | **Sem registro de aplicação** na documentação. Soma-se à anterior e depende dela | cabeçalho do arquivo |
| `20260930090000_prospecting_permanent_exclusions.sql` | `prospecting_permanent_exclusions` (Exclusões Permanentes de Prospecção) | **Sem registro de aplicação** na documentação (estado **NÃO VERIFICADO**; o banco não foi consultado). A funcionalidade só existe com `REPOSITORY_MODE=supabase` e exige esta tabela. Desde a Fase 2B-3.2B a **promoção para o CRM** também a consulta: sem a tabela disponível, a promoção em modo Supabase fica **bloqueada por indisponibilidade (503)** — falha segura, não um defeito | cabeçalho do arquivo |
| `20261012090000_crm_catalogs.sql` | `crm_services`, `crm_niches`, `crm_lead_origins` (catálogos do CRM) e a função de reordenação `reorder_crm_catalog` — **aditiva** | **NÃO APLICADA** — é a proposta da Fase 2B-1 do CRM 5.0 (decisão [0026](../docs/decisions/0026-crm-catalogs.md)); nada a executa e o estado real no banco não foi verificado | decisão 0026 |

### A migration dos catálogos (`20261012090000_crm_catalogs.sql`)

- **Aditiva:** só cria três tabelas, índices, restrições, um gatilho de `updated_at` e uma função. **Não toca em `crm_records`** nem em nenhuma tabela existente; os campos `nicho`, `origem` e `servico_potencial` do CRM continuam texto livre.
- **Sem carga inicial:** nenhuma linha de negócio (serviços, nichos, origens). Quem decide a lista inicial é o proprietário, depois, pela interface.
- **Unicidade** do nome normalizado por tabela, **inclusive para itens desativados**; **sem exclusão física**; **RLS ligada e sem policy** (só a `service_role`, no servidor).
- **Sem aplicação, o servidor continua funcionando:** em `REPOSITORY_MODE=file` (o padrão) os catálogos usam um arquivo local. Em `REPOSITORY_MODE=supabase` sem esta migration, as rotas `/api/crm-catalogs/...` respondem 503 (tabela ausente) — o CRM e o resto não são afetados.
- **Antes de aplicar:** revise o arquivo e a decisão 0026; aplique numa transação e confira que as três tabelas nasceram com RLS ligada e **sem** policies. **Para desfazer** (só se algo der errado; não faz parte do arquivo): `DROP FUNCTION public.reorder_crm_catalog(TEXT, TEXT[], TEXT, TEXT); DROP TABLE public.crm_services, public.crm_niches, public.crm_lead_origins; DROP FUNCTION public.crm_catalogs_bump_updated_at();` — nada mais depende delas nesta fase.

## Código dos adaptadores

`src/crm-adapters/` (`crmSupabaseConfig.js`, `crmSupabaseMapping.js`, `crmSupabaseRepository.js`, `crmSupabaseCatalogRepository.js`) fala PostgREST direto, sem SDK. Quem escolhe entre o adaptador de arquivo e o do Supabase são as fábricas `src/services/crmRepositoryFactory.js` e `src/services/catalogRepositoryFactory.js`, por `REPOSITORY_MODE` (`file` por padrão; `supabase` exige `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, e **nunca cai para `file` em silêncio**). Os testes (`tests/crm-adapters/`) usam um `fetch` falso e nunca tocam a rede real.

## Decisões já confirmadas (etapa 1.1)

- **Credencial (D1):** o servidor fala com este banco usando a `service_role` key. Ela **nunca** chega ao navegador; o navegador **nunca** acessa este banco diretamente — só HTTP com o servidor.
- **RLS (D2):** ligada em todas as tabelas, **sem** nenhuma policy para `anon`/`authenticated`. Como a `service_role` ignora RLS, isso não bloqueia o servidor — só qualquer outro caminho.
- **Sem tabela de deduplicação no CRM:** a checagem de duplicidade/DNC continua só em JavaScript (`research-prospector/normalize.js`).

## Como aplicar (quando for a hora — decisão do proprietário)

1. Leia a migration inteira e a decisão correspondente.
2. Aplique pelo SQL Editor do painel do Supabase, colando o arquivo, **ou** com o CLI oficial (`supabase db push`), se o projeto já estiver linkado localmente — nenhuma das duas coisas é feita por código deste repositório.
3. Confirme no painel (Table Editor) que as tabelas nasceram com RLS ligada e sem policies.
4. Configure a `service_role` key como variável de ambiente só do servidor (nunca em `.env.example`, nunca versionada, nunca enviada ao navegador).
5. Aplique **em ordem** (as mais antigas primeiro) e **uma de cada vez**: a de Funis (cards) depende da de Funis, e a de catálogos é independente de todas.

## Convenção de nome

`migrations/<AAAAMMDDHHMMSS>_<descrição>.sql` — o mesmo padrão do CLI oficial do Supabase, para que este diretório funcione com `supabase db push` sem precisar renomear nada. **Nunca edite uma migration já versionada**: uma mudança vira uma migration nova.
