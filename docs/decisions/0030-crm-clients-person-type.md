# 0030 — Clientes Pessoa Física e Pessoa Jurídica no CRM (CRM 5.0, Fase D2)

**Estado:** implementado localmente; **a migration `20261020090000_crm_client_person_type.sql` está NÃO APLICADA** (só o proprietário a aplica, na ordem descrita abaixo). Nenhum acesso ao Supabase principal foi feito nesta fase.

## Contexto

- O cadastro de Clientes reaproveitava o formulário legado do CRM (31 campos) em que `empresa` é obrigatória. Não havia como cadastrar uma **pessoa** sem digitar o nome dela no campo "Empresa".
- A tela "Nova negociação" exige um cliente que já exista no CRM (D1/D1.1). Faltava um cadastro de cliente simples, com Pessoa Física (PF) e Pessoa Jurídica (PJ), ligado a esse fluxo.
- Restrições do proprietário: **não criar um CRM paralelo**, não quebrar nem substituir o registro legado de 31 campos, preservar IDs, auditoria, duplicidade, DNC, Exclusões Permanentes, promoção da Prospecção, RBAC e os dados financeiros históricos; migration **nova** se houver mudança de banco.

## Decisão

### 1. O registro continua sendo `crm_records`; quatro campos ADITIVOS
`tipoPessoa` (`PF` | `PJ` | `null`), `nomeCompleto`, `cpf`, `cnpj` — depois dos 31 legados, que seguem **exatamente** como eram e na mesma ordem (`CRM_LEGACY_WRITABLE_FIELDS`; `CRM_WRITABLE_FIELDS` passa a ter 35). Colunas novas: `tipo_pessoa`, `nome_completo`, `cpf`, `cnpj`, todas opcionais. Nenhuma tabela nova.

### 2. O nome de uma pessoa NÃO vai em `empresa`
Alternativa descartada: gravar o nome da PF em `empresa` (manteria o `NOT NULL`, mas é "nome artificial em campo errado" e contamina duplicidade, DNC, relatórios e a ficha). Escolhido: **PF se identifica por `nomeCompleto`** e `empresa` deixa de ser `NOT NULL`. Para não perder a garantia que o `NOT NULL` dava, entra uma restrição de **coerência** (no banco e no domínio, com a mesma regra, provada por paridade em 48 combinações):

| Tipo | Obrigatório | Proibido |
|---|---|---|
| sem tipo (registro antigo) | `empresa` | nome completo, CPF, CNPJ |
| PF | `nomeCompleto` | CNPJ (`empresa` opcional) |
| PJ | `empresa` | nome completo, CPF |

O **nome de exibição** é `clientDisplayName`: PF → nome completo; PJ e registro sem tipo → empresa (cada um cai no outro se faltar). O Dashboard tem uma cópia dessa regra (R11: não importa `src/`), comparada por teste.

### 3. Registros antigos: nunca inferidos
Todo registro que existe tem `tipo_pessoa = NULL` ("Sem tipo definido") e continua válido sem nenhuma alteração. **Nada** deduz PF/PJ pelo nome, pelo site ou por um documento. Uma pessoa (ADMIN) revisa pela edição: definir o tipo **preserva todos os campos originais** (um registro antigo convertido para PF mantém a `empresa` que tinha). O tipo, uma vez definido, só se **troca** (PF ↔ PJ), nunca se remove — e trocar exige deixar a identificação coerente (nada se perde em silêncio). A **promoção da Prospecção** continua criando registros sem tipo (regra preservada; o domínio só exige o tipo quando a API de cadastro pede).

### 4. Tipo obrigatório só no cadastro humano
A API `POST /api/crm` liga a opção **interna** `exigirTipoPessoa` (montada no servidor; um `exigirTipoPessoa` no corpo cairia em "campo desconhecido"). Domínio e Service aceitam registro sem tipo para a promoção e para os dados antigos. A permissão não mudou: criar/editar continua `WRITE:CRM` (só ADMIN); o COMMERCIAL_CLOSER lê e abre negociação (`PROPOSE:CRM`).

### 5. CPF e CNPJ
- Opcionais. Preenchidos, são **normalizados** (só os caracteres do documento, sem pontuação) e **validados** (formato e dígitos verificadores) no domínio e, para avisar antes, no Dashboard.
- **CNPJ alfanumérico** da Receita Federal (12 caracteres `0-9`/`A-Z` + 2 dígitos) vale, e convive com o numérico (a conta é a mesma para um CNPJ só numérico).
- O banco garante **só o formato** (`^[0-9]{11}$` e `^[0-9A-Z]{12}[0-9]{2}$`); os dígitos verificadores são da aplicação.
- Um documento é identidade **forte**: o mesmo CPF/CNPJ (com qualquer pontuação) é duplicidade (`DUPLICADO`, 409) e, se for de um registro `DO_NOT_CONTACT`, bloqueia a criação/edição (`DNC_BLOCKED`). Sem documento nada muda: nome + cidade continua sendo só um aviso de possível duplicidade, e agora compara o **nome completo da PF** também com a **empresa** de registros antigos.
- **Sem índice único** em `cpf`/`cnpj` no banco: a duplicidade é decidida pelo domínio, como a de site e telefone; a proteção entre processos continua sendo o limite já registrado (uma instância).

### 6. A exclusão com auditoria precisa conhecer a PF
`crm_record_deletions.empresa` é `NOT NULL` e `delete_crm_record_with_audit` copiava `v_row.empresa`: excluir uma PF (sem empresa) falharia. A migration recria a função **só trocando a expressão** do nome para `COALESCE(empresa, nome_completo)` (corpo, assinatura e `SECURITY INVOKER` iguais — teste compara o corpo com o original) e restabelece o `EXECUTE` **nominal** (`REVOKE … FROM PUBLIC, anon, authenticated`; só `service_role`), a lição da PRE-1/D1.1.

### 6b. Privilégios de `crm_records` (correção de segurança descoberta no ANTES real)
A verificação ANTES no Supabase real mostrou `anon` e `authenticated` com `SELECT/INSERT/UPDATE/DELETE` em `crm_records` (o padrão do Supabase para tabela nova em `public`): a RLS ligada e **sem policy** era a única barreira. A migration passa a **revogar nominalmente** (`FROM PUBLIC, anon, authenticated`) todo privilégio direto sobre `crm_records` e `crm_record_deletions` (a auditoria guarda o registro completo, inclusive CPF/CNPJ e nome), sobre as duas sequências de identidade e sobre a função de gatilho `crm_records_bump_version()`, e a restabelecer só para `service_role` o que o servidor usa. **O backend não depende de `anon`/`authenticated`:** todo acesso às tabelas do CRM é pelo PostgREST com a chave `service_role` (`src/crm-adapters/*`); a chave `anon` do navegador serve só para autenticar (`auth.getUser`/`getSession`) e nunca lê estas tabelas (um teste confere). RLS continua ligada e **zero policies**. O `DEPOIS` exige `false` para anon/authenticated em cada privilégio (inclusive de coluna e herdado por PUBLIC) e `true` para service_role. **Fora do escopo desta migration (a auditar à parte):** as demais tabelas comerciais criadas antes (funis, etapas, cards, movimentos e catálogos) podem ter a mesma concessão padrão.

### 7. Formulário de Novo Cliente
Seção principal: **PF ou PJ** (obrigatório, nunca escolhido sozinho), nome completo (PF) ou nome da empresa (PJ), documento opcional, nome do contato (PJ), telefone/WhatsApp, e-mail, nicho, origem do lead, responsável. Seção **expansível** ("Mais informações"): redes sociais, informações adicionais, diagnóstico e histórico comercial, reunião e próxima ação e a entrada no CRM. **Todo campo editável aparece em exatamente um bloco** (teste). Os campos de PF/PJ aparecem conforme o tipo; um campo já preenchido nunca é escondido. A edição completa (abas) continua, com os 35 campos. A lista ganhou a coluna **Tipo**, o filtro por tipo (inclusive "Sem tipo definido", para a revisão administrativa) e a busca por **CPF/CNPJ** (com ou sem pontuação).

#### 7.1 (Fase D2.1) Abas dentro de "Mais informações"
A seção expansível deixou de ser uma lista longa: aberta, mostra **abas** (o mesmo componente acessível das fichas — WAI-ARIA, setas/Home/End, só a aba ativa no Tab) que trocam o conteúdo no mesmo lugar. Distribuição dos campos **reais** (nenhum inventado, duplicado ou eliminado; os 35 continuam todos no DOM o tempo todo, então trocar de aba nunca perde o digitado e nunca salva): **Digital** (site, Instagram, Facebook, perfil no Google), **Adicionais** (cargo, cidade, estado — não cabiam nas quatro abas sugeridas), **Comercial** (serviço potencial, temperatura, problema, Raio-X, status e link do diagnóstico, data da análise, valores e observações), **Funil** (última interação, reunião e link do Meet, próxima ação e data) e **Entrada** (status inicial e motivo da entrada no CRM — não são campos do cliente). O **responsável** continua em "Classificação", à vista. Um erro de validação numa aba oculta abre a seção, abre a aba do campo, mostra o erro, o foco vai ao campo e a aba ganha um selo com a quantidade de erros. A edição de um registro já usava abas (as da ficha) e não mudou. Sem mudança de payload, API, domínio ou banco; no celular as abas quebram de linha em vez de cortar o título.

### 8. Integração com Negociações
- O cliente é escolhido pelo **ID estável** (`crm:<uuid>`); o rótulo mostra o nome e o tipo ("Maria Souza (PF)", "Clínica Aurora (PJ)"). Com muitos clientes, o formulário de negociação ganha uma busca (nome, contato, telefone, CPF ou CNPJ).
- A ficha do cliente tem **"Nova negociação"** (`PROPOSE:CRM`, não existe para registro bloqueado): leva a `#/funis/nova-negociacao/<id>`, que abre o formulário **já com o cliente escolhido** (o id só vale se for um dos clientes oferecidos; o servidor confere de novo) e volta o endereço para `#/funis`.
- Um cliente pode ter **várias** negociações (inalterado da D1.1). Cadastrar um cliente **não** cria negociação. `valorProposta`/`valorTotal` legados **não** são copiados para a negociação (inalterado; teste).
- As projeções de card e de negociação passaram a levar `tipoPessoa` e `nomeCompleto` junto de `empresa`, para o nome certo aparecer no quadro.

### 9. O que NÃO foi feito (e por quê)
- **Desativar cliente:** não existe contrato de desativação no domínio (só o bloqueio DNC, terminal, e a exclusão administrativa com auditoria). Inventar uma operação exigiria contrato e migration próprios; **Desativar não foi implementado**. Editar existe.
- **Exclusão física nova:** nenhuma.
- **Modal do Novo Cliente:** o cadastro continua sendo a página `#/crm/novo` (a ficha continua na gaveta roteada); migrar o cadastro para um modal exigiria refazer a navegação/proteção de rascunho já coberta por testes.
- **Responsável:** o campo de texto existente do CRM (`responsavel`) foi mantido; não há seletor de usuários (isso exigiria um endpoint de usuários, fora do escopo).

## Implantação segura (resumo; o detalhe está no cabeçalho da migration e em `supabase/README.md`)
1. Parar o servidor operacional. 2. `ANTES` (leitura). 3. Aplicar a migration numa transação. 4. `NOTIFY pgrst, 'reload schema'` se preciso e `DEPOIS` (leitura). 5. Só então atualizar o código e subir o servidor. O código novo grava as quatro colunas em **todo** registro: **sem a migration, toda escrita no CRM é recusada pelo PostgREST**. O servidor antigo é compatível com o banco migrado (ignora as colunas novas). **Cuidado:** o servidor serve o Dashboard do disco a cada requisição; com o código novo no diretório e o backend antigo em memória, o formulário novo envia `tipoPessoa` e a API antiga o recusa (400) — não cadastre clientes entre atualizar os arquivos e reiniciar.

## Limites do que foi provado
Testes herméticos (lê o texto da migration; um avaliador de CHECK com lógica de três valores prova a paridade banco × domínio; PostgREST falso; navegador de teste). **Nunca** executado num PostgreSQL real nem no Supabase principal. A sintaxe PL/pgSQL da função recriada, o `NOT NULL` real removido e o comportamento do PostgREST com as colunas novas só se provam na homologação.
