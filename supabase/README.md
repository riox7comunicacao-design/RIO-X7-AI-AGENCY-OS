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
| `20260930090000_prospecting_permanent_exclusions.sql` | `prospecting_permanent_exclusions` (Exclusões Permanentes de Prospecção) | **Sem registro de aplicação** na documentação (estado **NÃO VERIFICADO**; o banco não foi consultado). A funcionalidade só existe com `REPOSITORY_MODE=supabase` e exige esta tabela. Desde a Fase 2B-3.2B a **promoção para o CRM** também a consulta: sem a tabela disponível, a promoção em modo Supabase fica **bloqueada por indisponibilidade (503)** — falha segura, não um defeito. **Atenção:** esta migration declara `created_by_user_id` como `UUID`, tipo incompatível com o `userId` textual do projeto — corrigido pela migration corretiva logo abaixo (a histórica **não** é editada) | cabeçalho do arquivo |
| `20261012090000_crm_catalogs.sql` | `crm_services`, `crm_niches`, `crm_lead_origins` (catálogos do CRM) e a função de reordenação `reorder_crm_catalog` — **aditiva** | **NÃO APLICADA** — é a proposta da Fase 2B-1 do CRM 5.0 (decisão [0026](../docs/decisions/0026-crm-catalogs.md)); nada a executa e o estado real no banco não foi verificado | decisão 0026 |
| `20261017090000_prospecting_permanent_exclusions_created_by_text.sql` | **Corretiva** da migration das Exclusões Permanentes: altera **apenas o tipo** da coluna `created_by_user_id`, de `UUID` para `TEXT` (com o cast do valor, preservando as linhas) — um único comando. Nenhuma restrição, outra coluna, índice, policy, gatilho ou linha muda | **NÃO APLICADA** e o estado do banco **NÃO VERIFICADO** — é a proposta da Fase 2B-3.2B-H2; nada a executa. Aplique-a **depois** da `20260930090000_prospecting_permanent_exclusions.sql` | cabeçalho do arquivo |
| `20261018090000_crm_services_payment_modalities.sql` | **Aditiva** em `crm_services`: três colunas novas com padrão (`permite_pagamento_unico`, `permite_pagamento_recorrente`, `periodicidades`), quatro restrições e um preenchimento só das colunas novas a partir do contrato antigo (`tipo_cobranca`/`recorrencia`, que ficam como LEGADO, intactos). Nenhuma coluna, índice, gatilho, policy ou privilégio é removido | **NÃO APLICADA** e o estado do banco **NÃO VERIFICADO** — é a proposta da Fase C1 do CRM 5.0 (decisão [0027](../docs/decisions/0027-service-payment-modalities.md)); nada a executa | decisão 0027 |

### A migration dos catálogos (`20261012090000_crm_catalogs.sql`)

- **Aditiva:** só cria três tabelas, índices, restrições, um gatilho de `updated_at` e uma função. **Não toca em `crm_records`** nem em nenhuma tabela existente; os campos `nicho`, `origem` e `servico_potencial` do CRM continuam texto livre.
- **Sem carga inicial:** nenhuma linha de negócio (serviços, nichos, origens). Quem decide a lista inicial é o proprietário, depois, pela interface.
- **Unicidade** do nome normalizado por tabela, **inclusive para itens desativados**; **sem exclusão física**; **RLS ligada e sem policy** (só a `service_role`, no servidor).
- **Sem aplicação, o servidor continua funcionando:** em `REPOSITORY_MODE=file` (o padrão) os catálogos usam um arquivo local. Em `REPOSITORY_MODE=supabase` sem esta migration, as rotas `/api/crm-catalogs/...` respondem 503 (tabela ausente) — o CRM e o resto não são afetados.
- **Antes de aplicar:** revise o arquivo e a decisão 0026; aplique numa transação e confira que as três tabelas nasceram com RLS ligada e **sem** policies. **Para desfazer** (só se algo der errado; não faz parte do arquivo): `DROP FUNCTION public.reorder_crm_catalog(TEXT, TEXT[], TEXT, TEXT); DROP TABLE public.crm_services, public.crm_niches, public.crm_lead_origins; DROP FUNCTION public.crm_catalogs_bump_updated_at();` — nada mais depende delas nesta fase.

### A migration corretiva das Exclusões Permanentes (`20261017090000_prospecting_permanent_exclusions_created_by_text.sql`)

- **Por quê:** o identificador do usuário do projeto (`userId`) é um **texto livre** não vazio (`"breno"`, `"user-admin"`…), nunca convertido para UUID, e o serviço o grava em `created_by_user_id` exatamente como veio. A migration original declara essa coluna como `UUID`: com ela, cadastrar uma exclusão com um `userId` textual falharia no banco (`22P02`) e a tela responderia 503. As demais colunas de autoria do projeto (catálogos, funis, exclusão administrativa do CRM) já são `TEXT`.
- **O que faz — e apenas isso:** `ALTER TABLE public.prospecting_permanent_exclusions ALTER COLUMN created_by_user_id TYPE TEXT USING created_by_user_id::TEXT` — **um único comando**, que muda **só o tipo** da coluna. **Não cria nenhuma restrição nem regra nova de banco**: a validação de `userId` não vazio já existe na aplicação, e o banco não passa a recusar nada (nem um dado histórico incomum). Preserva os ids e as linhas; não toca nenhuma outra coluna, a RLS (continua ligada, **sem** policy), os índices, o gatilho nem os privilégios; não insere, altera nem apaga linhas; não usa `DROP`.
- **Ordem de aplicação:** **depois** da `20260930090000_prospecting_permanent_exclusions.sql`, nunca antes. Funciona se a original **já** foi aplicada (a coluna muda de tipo e as linhas existentes ficam como estão) e se as duas serão aplicadas em sequência (a original cria a tabela vazia e a corretiva a corrige). O carimbo é posterior ao dos catálogos de propósito: o CLI (`supabase db push`) nunca a trata como "fora de ordem", qualquer que seja o estado real do banco.
- **A ausência da tabela não é escondida:** a corretiva **não** cria a tabela e não usa `IF EXISTS`. Aplicada num banco sem a tabela, ela falha com `relation "public.prospecting_permanent_exclusions" does not exist` (`42P01`) — o sinal de que falta aplicar a original primeiro.
- **É um único comando, portanto atômico** (ou vale inteiro ou não vale). Ele pede um bloqueio exclusivo curto e reescreve a tabela (pequena): faça-o sem promoções em andamento. Repetir o comando depois de aplicado é inofensivo (a coluna já é `TEXT`; nada muda).
- **Depois de aplicar, confira (somente leitura):** `select data_type from information_schema.columns where table_schema='public' and table_name='prospecting_permanent_exclusions' and column_name='created_by_user_id';` deve devolver `text`; e `select count(*) from pg_policies where tablename='prospecting_permanent_exclusions';` deve continuar `0`. Se a gravação ainda falhar logo depois, recarregue o esquema do PostgREST (`NOTIFY pgrst, 'reload schema';` no SQL Editor).
- **Desfazer** não faz parte do arquivo e normalmente não é desejável (UUID é incompatível com o `userId` do projeto); só funcionaria se todos os valores gravados fossem UUIDs válidos.
- **Limite do que foi provado:** testes locais, com um simulador de esquema que lê o texto das migrations (`tests/helpers/migrationSchemaSimulator.js`) — **não** um Postgres. O tipo real da coluna no banco operacional **não foi consultado**.

### A migration das modalidades de pagamento dos Serviços (`20261018090000_crm_services_payment_modalities.sql`)

- **Por quê:** um mesmo serviço pode oferecer ao mesmo tempo o pagamento **único** e o **recorrente** (mensal, trimestral, semestral, anual). O contrato antigo (`tipo_cobranca` UNICA *ou* RECORRENTE + uma `recorrencia`) não consegue dizer isso. O **prazo contratado**, o **TCV**, o **MRR** e o **valor recebido** não são do serviço: são da negociação (decisão 0027, fase futura).
- **O que faz — e apenas isso, só em `crm_services`:** (1) `ADD COLUMN` ×3, todas com padrão constante (`permite_pagamento_unico BOOLEAN NOT NULL DEFAULT false`, `permite_pagamento_recorrente BOOLEAN NOT NULL DEFAULT false`, `periodicidades TEXT[] NOT NULL DEFAULT '{}'`) — nenhuma linha existente fica inválida; (2) quatro restrições (só MENSAL/TRIMESTRAL/SEMESTRAL/ANUAL; sem repetição; recorrente exige ao menos uma periodicidade; não recorrente exige a lista vazia); (3) um `UPDATE` que toca **somente as três colunas novas**, **somente** nas linhas com `tipo_cobranca` informado e ainda sem modalidade nova: UNICA → único; RECORRENTE + `recorrencia` → recorrente com aquela periodicidade; **sem `tipo_cobranca` → a linha não é tocada** (serviço LEGADO: nada é inferido, o ADMIN completa pela tela); (4) dois `COMMENT ON COLUMN` marcando as colunas antigas como legado.
- **O que não muda:** `tipo_cobranca` e `recorrencia` continuam, com os valores e as restrições antigas; ids, nomes, descrições, categorias, **preços de referência**, ordem, ativo e a auditoria (`created_*`/`updated_*`) ficam como estão; a RLS segue ligada e sem policy; nada é inserido ou apagado; nenhuma outra tabela é tocada.
- **`updated_at`:** o gatilho que já existe (`crm_services_bump_updated_at_trigger`) atualiza `updated_at` **só** das linhas que o `UPDATE` tocar; `updated_by_*` não muda. Se isso for indesejado: não preencher (o ADMIN define pela tela) ou desligar o gatilho só durante a migration — decisão do proprietário, não feita no arquivo.
- **Ordem segura de implantação** (um único servidor local; a *leitura* funciona com os dois esquemas, a *gravação* de serviço só com o novo):
  1. **Antes:** rode a conferência "ANTES" abaixo (somente leitura) e anote as contagens.
  2. **Pare o servidor** (o antigo). Assim ninguém cria nem edita serviço entre a migration e a subida do novo: não há janela de divergência. (O código antigo, `735b0ce`, funciona com o esquema atual e também com o novo, ignorando as colunas novas; o código da C1 **lê** os dois esquemas, mas só **grava** serviço com o novo.)
  3. **Aplique esta migration numa transação** (`BEGIN;` … `COMMIT;`; em caso de erro, `ROLLBACK;` — nada muda e o servidor antigo pode voltar como estava).
  4. **Confira "DEPOIS"** (abaixo): totais e colunas antigas iguais, modalidades preenchidas, "pendentes" = 0. Se algo estiver errado, **não suba o servidor novo**: use o "Desfazer" do cabeçalho do arquivo (as colunas antigas continuam intactas) e suba o servidor antigo.
  5. **Suba o servidor novo** (código da C1) e **recarregue (Ctrl+F5) cada aba aberta do Dashboard**: uma aba antiga que tente gravar `tipoCobranca`/`recorrencia` recebe um erro claro (campo não editável), nunca grava algo divergente. Se o PostgREST ainda não enxergar as colunas novas, rode `NOTIFY pgrst, 'reload schema';`.
  6. **Verifique os serviços** pela tela de Serviços **sem editar nada**: a mesma quantidade, nomes e preços iguais, e cada um com as modalidades esperadas (UNICA → "Pagamento único"; RECORRENTE X → "Pagamento recorrente (x)"; sem tipo → "Modalidades de pagamento não informadas").
  7. **Repetir o `UPDATE` só tem sentido se "pendentes" > 0**, o que só ocorre se um servidor antigo gravou serviços depois do passo 3 — com o servidor parado no passo 2, **não é necessário e não se repete**. É seguro porque só alcança linhas com `tipo_cobranca` informado e **sem nenhuma modalidade**: uma linha que o ADMIN completou já tem modalidade, e um serviço criado pelo servidor novo tem `tipo_cobranca` nulo (e a aplicação nunca deixa um serviço com modalidade ficar sem nenhuma).
  - Subir o servidor novo **antes** da migration não corrompe nada: ler funciona, mas criar/editar um serviço falha (o PostgREST recusa as colunas inexistentes) e a tela mostra o erro genérico de gravação.
- **Conferência ANTES (somente leitura; sem nomes nem preços):**

  ```sql
  select count(*) as total_servicos from public.crm_services;
  select tipo_cobranca, recorrencia, count(*) as servicos from public.crm_services group by 1, 2 order by 1, 2;
  ```

- **Conferência DEPOIS (somente leitura; sem nomes nem preços):**

  ```sql
  select count(*) as total_servicos from public.crm_services;                                  -- igual ao ANTES
  select tipo_cobranca, recorrencia, count(*) as servicos from public.crm_services group by 1, 2 order by 1, 2;  -- igual ao ANTES (as colunas antigas não mudaram)
  select permite_pagamento_unico as unico, permite_pagamento_recorrente as recorrente, periodicidades, count(*) as servicos
    from public.crm_services group by 1, 2, 3 order by 1, 2, 3;                               -- UNICA→(true,false,{}); RECORRENTE+X→(false,true,{X}); sem tipo→(false,false,{})
  select count(*) as sem_modalidade from public.crm_services where not permite_pagamento_unico and not permite_pagamento_recorrente;  -- = os serviços sem tipo_cobranca
  select count(*) as pendentes from public.crm_services where tipo_cobranca is not null and not permite_pagamento_unico and not permite_pagamento_recorrente;  -- tem de ser 0 (só então o preenchimento está completo)
  select conname from pg_constraint where conrelid = 'public.crm_services'::regclass and conname in ('crm_services_periodicidades_validas', 'crm_services_periodicidades_sem_repeticao', 'crm_services_recorrente_exige_periodicidade', 'crm_services_nao_recorrente_sem_periodicidade') order by 1;  -- 4 linhas
  ```

- **Desfazer** não faz parte do arquivo (veja o comentário no cabeçalho): remover as quatro restrições e as três colunas; o contrato antigo continua intacto.
- **Limite do que foi provado:** testes locais que leem o **texto** da migration e conferem que o modelo em JavaScript e o SQL dizem a mesma coisa, mais um simulador do preenchimento no PostgREST falso — **não** um Postgres. O comportamento real das restrições e do gatilho só se confirma aplicando, e isso é decisão do proprietário.

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
5. Aplique **em ordem** (as mais antigas primeiro) e **uma de cada vez**: a de Funis (cards) depende da de Funis, e a de catálogos é independente de todas. **A corretiva das Exclusões Permanentes (`20261017090000…`) vem sempre depois da `20260930090000_prospecting_permanent_exclusions.sql`** (sem ela, falha com "a tabela não existe" — `42P01` — de propósito). **A das modalidades de pagamento dos Serviços (`20261018090000…`) vem sempre depois da dos catálogos (`20261012090000_crm_catalogs.sql`), que cria `crm_services`** — e tem uma ordem própria — parar o servidor, aplicar, conferir e só então subir o novo (seção acima).

## Convenção de nome

`migrations/<AAAAMMDDHHMMSS>_<descrição>.sql` — o mesmo padrão do CLI oficial do Supabase, para que este diretório funcione com `supabase db push` sem precisar renomear nada. **Nunca edite uma migration já versionada**: uma mudança vira uma migration nova.
