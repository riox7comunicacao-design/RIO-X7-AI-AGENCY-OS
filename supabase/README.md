# `supabase/` — migrations versionadas, NÃO aplicadas automaticamente

Este diretório guarda o SQL da persistência do CRM em Postgres/Supabase, como texto revisável no Git — não uma conexão ativa com o projeto. **Nada aqui é executado por `npm test`, por nenhum script do projeto, nem por CI**: aplicar uma migration é sempre uma ação humana e deliberada.

## Estado atual

- `migrations/20260927120000_crm_initial_schema.sql`: proposta de esquema para o CRM (decisão [0024](../docs/decisions/0024-crm-postgres-schema.md)). **Não aplicada** ao projeto Supabase real (`rio-x7-ai-agency-os`, `sa-east-1`).
- O CRM operacional continua em `data/crm.json` (adapter de arquivo, `src/crm/crmRepository.js`). Nenhum código lê ou escreve nas tabelas descritas aqui — elas não existem ainda no banco.

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
