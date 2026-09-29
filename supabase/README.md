# `supabase/` — migrations versionadas, NÃO aplicadas automaticamente

Este diretório guarda o SQL da persistência do CRM em Postgres/Supabase, como texto revisável no Git — não uma conexão ativa com o projeto. **Nada aqui é executado por `npm test`, por nenhum script do projeto, nem por CI**: aplicar uma migration é sempre uma ação humana e deliberada.

## Estado atual

- `migrations/20260927120000_crm_initial_schema.sql`: esquema do CRM (decisão [0024](../docs/decisions/0024-crm-postgres-schema.md)), já aplicado ao projeto Supabase real (`rio-x7-ai-agency-os`, `sa-east-1`) — `REPOSITORY_MODE=supabase` é a persistência oficial desde a etapa 3M.
- `migrations/20260928090000_crm_delete_audit.sql`: tabela `crm_record_deletions` e a função transacional `delete_crm_record_with_audit`, para a exclusão administrativa e irreversível do CRM (decisão [0025](../docs/decisions/0025-crm-admin-delete.md)). **Já aplicada e validada** (etapa 3O.8-3O.10, com teste E2E real).
- `migrations/20260928220000_crm_funnels.sql`: schema completo de Funis configuráveis (`crm_funnels`, `crm_funnel_stages`, `crm_funnel_cards`, `crm_funnel_card_moves`) para a reestruturação Prospecção/CRM/Funis, Etapa "Funis 1". **Não aplicada** — o backend desta etapa usa só o adapter de arquivo local (`data/funnels.json`); um adapter Supabase para estas tabelas é uma etapa futura ("Funis 2", junto com os cards e o Kanban).

## Código de preparação (etapa 2)

`src/crm/crmSupabaseConfig.js`, `crmSupabaseMapping.js` e `crmSupabaseRepository.js` (mais testes em `tests/crm/`) já existem — ver a seção 10 da decisão [0024](../docs/decisions/0024-crm-postgres-schema.md). **Nada disso é usado por nenhum caminho de produção/dev**: nada em `src/server/` os importa, nenhuma chamada à rede acontece fora de teste (e os testes nunca tocam a rede real). `SUPABASE_SERVICE_ROLE_KEY` **não é exigida** para o CRM local continuar funcionando.

## Decisões já confirmadas (etapa 1.1)

- **Credencial (D1):** o futuro servidor fala com este banco usando a `service_role` key. Ela **nunca** chega ao navegador; o navegador **nunca** acessa este banco diretamente — só HTTP com o servidor, como já é hoje.
- **RLS (D2):** ligada em `crm_records`, **sem** nenhuma policy para `anon`/`authenticated` nesta primeira versão. Como a `service_role` ignora RLS, isso não bloqueia o servidor — só qualquer outro caminho.
- **Sem tabela de deduplicação nesta migration:** a checagem de duplicidade/DNC continua só em JavaScript (`research-prospector/normalize.js`), como hoje.

## Como aplicar (quando for a hora — decisão do proprietário)

1. Leia a migration inteira e a decisão 0024, especialmente as pendências que restam (D-CONCURRENCY-PORT, D-IDENTITY-FUTURA).
2. Aplique pelo SQL Editor do painel do Supabase, colando o arquivo, **ou** com o CLI oficial (`supabase db push`), se o projeto já estiver linkado localmente — nenhuma das duas coisas foi feita por esta sessão.
3. Confirme no painel (Table Editor) que `crm_records` nasceu com RLS ligada e sem policies.
4. Configure a `service_role` key como variável de ambiente só do servidor (nunca em `.env.example`, nunca versionada, nunca enviada ao navegador).
5. Só depois disso a Fase B.2 (o adapter Supabase de `src/crm/`, ainda não escrito) tem uma tabela real para conversar.

## Convenção de nome

`migrations/<AAAAMMDDHHMMSS>_<descrição>.sql` — o mesmo padrão do CLI oficial do Supabase, para que este diretório funcione com `supabase db push` no futuro sem precisar renomear nada.
