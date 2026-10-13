# UX/UI 4.0 e CRM Comercial 5.0 — checkpoint de desenvolvimento

> **Isto é um CHECKPOINT de desenvolvimento, não a declaração de que o CRM Comercial 5.0 existe.** Serve para retomar o trabalho com segurança depois de uma pausa.
> Do CRM 5.0 existem, até aqui: a **Fase 2A** (menu lateral, idioma, compatibilidade de rotas e responsividade — **PUBLICADA**), a **Fase 2B-1** (a **estrutura técnica** dos catálogos de Serviços, Nichos e Origens dos Leads — **PUBLICADA** em `85d3d4f`) e a **Fase 2B-2** (a **interface administrativa** desses três catálogos — **implementada só no diretório de trabalho**, sem `git add`, sem commit, sem push). **Nenhuma entidade nova foi ligada ao CRM, nenhuma migration foi aplicada e nenhum dado real foi criado.**
> Não contém senhas, tokens, dados pessoais nem caminhos locais privados.
> Última atualização: 2026-10-12.

## 1. Ponto de partida e estado do Git

- **Commit de base, já publicado em `origin/main`:** `85d3d4f4250edf98ab9c7c3caf3d923f89927a59` — `feat(crm): estrutura dos catalogos comerciais fase 2B-1`. **A Fase 2B-1 está PUBLICADA nesse commit** (43 arquivos). Antes dele: `fd62799` (Fase 2A, publicada), `04183f6`, `3a5a482` e `9eddf79`.
- **Fase 2B-2:** implementada **só no diretório de trabalho**: **não preparada (sem `git add`), não commitada, não publicada**. A lista exata dos arquivos que entrariam no commit está na seção 8.
- Branch: `main`. Remoto esperado: `origin` → repositório `RIO-X7-AI-AGENCY-OS` da organização no GitHub.
- **O que a 2B-2 mexeu e o que não mexeu:** acrescentou as telas, o modelo e a página Configurações do CRM no `dashboard/`, o mapa de permissões do Dashboard, as rotas e o menu, o CSS das telas, o guarda hermético da suíte de testes e a separação dos testes de rede externa. **Não alterou** nada em `src/` (nenhuma regra, endpoint, permissão, migration ou adapter do backend), `crm_records`, os 31 campos do CRM, as APIs comerciais, a promoção, a prospecção, a Fila de Aprovação, as migrations (a de catálogos **continua NÃO APLICADA**), nenhuma dependência instalada e nenhum `data/*.json` (SHA-256 igual antes e depois da suíte completa).

## 2. Fases concluídas

### 2.1 UX/UI 4.0.x (telas existentes modernizadas)

Todas as telas seguem o mesmo padrão: lista com busca/ordenação/paginação e linha inteira clicável, gaveta (painel lateral) com URL, confirmação humana para ações, avisos (toasts), foco e ESC/X/Voltar/Avançar, atualização sem recarregar.

| Fase | Entrega | Estado |
|---|---|---|
| 4.0 | Componentes globais (`dashboard/ui/`: camadas modal/gaveta/confirmação, avisos, barramento de dados, acompanhador, componentes visuais) e a Fila de Aprovação como tela de referência | Concluída e validada no navegador |
| 4.0.1 | Refinamento visual da Fila de Aprovação | Concluída e validada no navegador |
| 4.0.2 | Leads Reprovados (lista, gaveta, RECONSIDERAR com confirmação, URL do lead) | Concluída |
| 4.0.3 | Leads Reprovados: filtros e estado vazio. Histórico de prospecções (lista, gaveta com Resumo/Candidatos/Resultados/Auditoria, atualização em segundo plano só com job em andamento, REFAZER com confirmação). Controlador compartilhado `ui/routedDrawer.mjs` | Concluída |
| 4.0.4 | Nova Prospecção: contrato briefing + job, confirmações, etapas reais sem percentual, gaveta da execução com URL | Concluída |
| 4.0.5 | Nova Prospecção em 3 abas (Nova pesquisa, Briefings salvos, Em andamento) com assistente de 3 etapas; valores conservadores (3 leads / 10 candidatos); proteção do rascunho ao atualizar/fechar a aba; localidades padronizadas só na exibição; "Em andamento" mostra só jobs realmente ativos | Aba/lista de briefings validadas no navegador; o restante implementado e testado |
| 4.0.6.1 + 4.0.6.2 | CRM: lista persistente (busca, filtros, ordenação, 20 por página, cartões em tela estreita) e ficha em gaveta `#/crm/registro/<id>` com abas (Resumo, Contato e presença, Comercial, Histórico); atualização por evento `crm:changed` e botão Atualizar, sem polling | Implementada e testada; **falta validação visual real** |
| 4.0.6.3 | Edição segura do CRM: 31 campos em abas, validação antes de enviar, só os campos alterados são enviados, Salvar sempre explícito; proteção de alterações não salvas em ESC, X, fundo, Voltar/Avançar, outro registro, troca de módulo e atualizar/fechar a aba | Implementada e testada; **falta validação visual real** |

Decisões técnicas da 4.0.x (importantes para o 5.0):
- "Não validado" e "descartado" nunca são chamados de "rejeitado por uma pessoa". Nenhuma tela inicia pesquisa, aprova, rejeita, reconsidera ou promove sozinha.
- **Voltar do navegador não pode ser cancelado**: o endereço já mudou quando o aviso chega. Com alterações não salvas a tela pergunta e, se a pessoa escolher "Continuar editando", `navigation.restore(hash)` leva o endereço de volta **sem empilhar entradas** (`history.go(±1)` quando a entrada vizinha é a certa; senão troca a entrada). A numeração das entradas fica em `history.state`.
- O `beforeunload` só **pede** o aviso nativo; o navegador decide se e como mostrá-lo. Vários guardas de saída convivem: basta um responder "há alteração".
- **A CRM-API não tem versionamento** na interface: duas pessoas que salvam o mesmo campo ao mesmo tempo → o último prevalece. A tela só reduz o risco enviando o que foi alterado e **não promete** proteção contra isso. (A tabela `crm_records` tem coluna `version` mantida por gatilho, mas nenhuma camada a usa ainda.)
- A lista do CRM, a Fila de Aprovação, o Histórico, Leads Reprovados, a Nova Prospecção e (2B-2) os catálogos são **persistentes** (`show/hide`): estado e rolagem sobrevivem à troca de módulo.

### 2.2 CRM 5.0 — Fase 1: auditoria (concluída, somente leitura)

**Armazenamento**
- CRM (`crm_records`): **Supabase** é a fonte oficial desde 2026-09-28 (`REPOSITORY_MODE=supabase`); a política de dados registra 0 registros nessa data (reconfirmar antes de qualquer migração). `data/crm.json` é só a implementação de arquivo para desenvolvimento.
- Funis, etapas e cards: **apenas arquivo JSON**. As migrations de funis e cards existem e estão testadas, mas **sem registro de aplicação**, e não há adaptador Supabase para funis. Um card (arquivo) referencia um registro (Supabase) sem chave estrangeira.
- Fila de aprovação e Prospecção: arquivos JSON locais.

**Lacunas em relação ao 5.0:** registro plano (sem Cliente PF/PJ, contatos nem Negociação); campos livres onde o novo modelo exige catálogo (nicho, origem, temperatura, responsável); datas como texto livre; sem proposta/fechamento/pagamento/perda/atividade/meta; sem Dashboard Comercial; sem interface de administração de funis. O papel `COMMERCIAL_CLOSER` não tem `WRITE:CRM`.

**Decisões em aberto (antes da Fase 3):** permissões novas e o que o `COMMERCIAL_CLOSER` pode fazer; responsável como usuário (não texto); necessidade e proteção de CPF; dinheiro em centavos e as fórmulas de conversão, ticket médio, tempo de fechamento e "sem movimentação"; correspondência dos status antigos com as etapas; uso da coluna `version` para bloqueio otimista.

### 2.3 CRM 5.0 — Fase 2A: menu, idioma, compatibilidade e responsividade (PUBLICADA em `fd62799`)

- **Menu lateral** hierárquico e recolhível (até 2 níveis; `dashboard/nav.mjs`, `dashboard/ui/sidebar.mjs`): Visão Geral · CRM (Dashboard Comercial, Clientes, Funis de Vendas, Metas e Indicadores, Configurações do CRM → Serviços, Nichos e Cores, Gestão de Funis e Etapas, Origens dos Leads) · Prospecção · Agentes IA · Gestão (Exclusões Permanentes + referências desabilitadas: Agenda, Conversas, Reuniões, Propostas, Relatórios, Configurações gerais). O texto "CRM" abre `#/crm/dashboard`; a seta só expande/recolhe. Teclado, permissões por item, menu do celular com ESC e foco, só a navegação rola (rodapé fixo).
- **Rotas:** `#/crm` segue como alias da lista de Clientes (`#/crm/clientes`); links de registros, Fila de Aprovação, Funis, Voltar/Avançar e a proteção de rascunho preservados; páginas futuras mostram EM DESENVOLVIMENTO, sem dados nem chamadas de API.
- **Idioma** em português do Brasil, com catálogo central (`dashboard/i18n/pt-BR.mjs`) e teste de vocabulário; identificadores, valores guardados, rotas, permissões e contratos de API não foram traduzidos.
- **Preferência visual:** única exceção ao `localStorage` (uma chave, `'1'`/`'0'`, só o menu recolhido), auditada no guarda estático.

### 2.4 CRM 5.0 — Fase 2B-1: estrutura técnica dos catálogos (PUBLICADA em `85d3d4f`)

Decisão registrada em [0026](../decisions/0026-crm-catalogs.md). **Só backend: nenhum formulário, nenhuma tela, nenhuma ligação com o CRM.** (A interface é a 2B-2, abaixo.)

**Entidades (D1)** — três independentes, cada uma com **identificador estável independente do nome** (`service:<uuid>`, `niche:<uuid>`, `origin:<uuid>`):

| Catálogo (URL) | Tabela prevista | Campos próprios |
|---|---|---|
| `servicos` | `crm_services` | `categoria`, `precoReferencia` (informativo; nunca vira valor de proposta), `tipoCobranca` (`UNICA`/`RECORRENTE`), `recorrencia` (só se recorrente) |
| `nichos` | `crm_niches` | `cor` — uma das **20 chaves** da paleta fixa (o backend **permite** cor nula) |
| `origens` | `crm_lead_origins` | `canal` (`PROSPECCAO_ATIVA`, `ANUNCIO_PAGO`, `INDICACAO`, `ORGANICO`, `PARCERIA`, `OUTRO`) — **não** é a URL de fonte da Prospecção |

Campos comuns: `nome` (até 80), `nomeNormalizado`, `descricao` (até 500), `ativo`, `ordem`, `criadoEm`/`atualizadoEm` e o responsável por criar/alterar (do autorizador, nunca do corpo).

**Permissões (D2):** `MANAGE:CRM_CATALOGS` (**nova**, só ADMIN — 12 permissões; `COMMERCIAL_CLOSER` segue com 5) administra; `READ:CRM` consulta os itens **ativos** (quem só lê não vê desativados, auditoria nem `emUso`). A autorização é do Service, **antes** de validar ou tocar o armazenamento.

**Operações (D4):** criar, consultar, editar campos permitidos, reordenar, desativar, reativar. **Sem exclusão física** em nenhuma camada. Edição parcial e segura (valor igual ao atual não grava; **um corpo vazio é recusado** com `NADA_A_ALTERAR`); `ativo`/`ordem`/`id`/datas/responsáveis nunca vêm por edição.

**API** (`/api/crm-catalogs/<catalogo>`, **não** `/api/crm/catalogs`, que seria lido como o id de um registro):

| Método e caminho | Permissão |
|---|---|
| `GET /<catalogo>[?todos=1]` | `READ:CRM` (`todos=1` exige gestão) |
| `POST /<catalogo>` · `POST /<catalogo>/reorder` | gestão |
| `GET /<catalogo>/:id` (o ADMIN recebe `emUso`) | `READ:CRM` |
| `PATCH /<catalogo>/:id` · `POST /<catalogo>/:id/activate` · `…/deactivate` | gestão |

Erros por `code` estável e mensagem fixa em português: `CRM_CATALOG_INVALID_INPUT` (400, `details` = só `{ path, code }`), `…_NOT_FOUND` (404), `…_DUPLICATE_NAME` (409), `…_NAME_IN_USE` (409), `…_PERSISTENCE` (503). Corpo e query estritos; sem cache.

**Unicidade:** o nome normalizado (minúsculas, sem acento, sem pontuação, espaços colapsados) é único por catálogo, **contando os desativados**, em três camadas: domínio, adapter de arquivo e `UNIQUE` no Postgres (a proteção entre processos). Criações concorrentes do mesmo nome resultam em UM item.

**Armazenamento:** domínio puro → Service → porta → **dois adapters pela mesma suíte de contrato** (arquivo local `data/crm-catalogs.json`, só criado quando um ADMIN cria o 1º item; e Postgres/Supabase por PostgREST com `fetch` injetável), escolhidos por `REPOSITORY_MODE` (`file` padrão; `supabase` exige as duas variáveis e **nunca cai para `file` em silêncio**). A variável `RIO_X7_CRM_CATALOGS_PATH` (opcional) muda o caminho do arquivo. O arquivo é `{ version, servicos: { <id>: item }, nichos: {…}, origens: {…} }`.

**Compatibilidade com o CRM legado (D3 — estratégia TEMPORÁRIA):** `nicho`, `origem` e `servicoPotencial` seguem **texto livre**; os 31 campos, as APIs comerciais, a promoção e a prospecção não consultam catálogos. **Restrição temporária de renomeação:** renomear um item que algum registro do CRM usa (comparação normalizada do campo legado) é recusado (`409 CRM_CATALOG_NAME_IN_USE`, vale até para só a caixa; se a contagem de uso falhar, também recusa). Cor, descrição, ordem e ativação seguem livres. Não é uma limitação da arquitetura: com ids estáveis, quando Clientes e Negociações referenciarem os catálogos por identificador (e uma migração específica, **autorizada**, ligar os dados legados), o nome poderá ser editado livremente.

**Paleta (20 cores):** o servidor e o banco guardam só a **chave** (`azul`); a interface a resolve pela classe `.cor-azul` em `dashboard/styles.css` (CSP `style-src 'self'`, DASH-GUARD-8: nenhum estilo inline nem valor de cor no JavaScript). Texto sobre fundo ≥ 7:1, ponto ≥ 3:1, todos os pares de pontos a ΔE ≥ 25 — **recalculados em teste**, que também confere que CSS, código e a migration usam as mesmas chaves e tons. O nome do nicho vai sempre em texto.

**Migration `20261012090000_crm_catalogs.sql` — NÃO APLICADA:** aditiva (três tabelas, `UNIQUE`, `CHECK`s, RLS sem policy, gatilho de `updated_at`, função atômica `reorder_crm_catalog`); **não toca `crm_records`**, sem foreign keys, sem carga inicial, sem exclusão. O SQL **não foi executado** (sem Postgres neste ambiente e sem autorização para o banco real): foi conferido por leitura e por testes estruturais que o cruzam com o código. Sem ela, em `REPOSITORY_MODE=supabase` as rotas de catálogo respondem 503; em `file` (padrão) funcionam. O `supabase/README.md` descreve as 6 migrations com o estado **documentado** e avisa que **o cabeçalho de todos os SQL diz "NÃO APLICADA" (texto da época da proposta) e que nada foi verificado no banco real**.

**D5 — nenhuma carga inicial:** nenhum serviço, nicho ou origem é cadastrado por código, migration ou script; as listas iniciais serão definidas pelo proprietário.

### 2.5 CRM 5.0 — Fase 2B-2: interface administrativa dos catálogos (implementada localmente, NÃO commitada)

Só o Dashboard. As três telas substituem as páginas EM DESENVOLVIMENTO de `#/crm/configuracoes/servicos`, `…/nichos` e `…/origens`, e a página **Configurações do CRM** (`#/crm/configuracoes`) deixou de ser EM DESENVOLVIMENTO: virou a porta de entrada dos cadastros. **Gestão de Funis e Etapas continua EM DESENVOLVIMENTO.**

**Telas e fluxo (iguais nos três catálogos, `dashboard/views/catalogs.mjs`)**
- Cabeçalho com título e descrição objetiva; botão **Novo Serviço / Novo Nicho / Nova Origem**; busca **por nome** (sem acento, sem diferenciar caixa); filtro de situação (ativos, inativos, todos — padrão: todos); contador; lista em linhas que viram **cartões no celular**, com situação (Ativo/Inativo), detalhes reais do item, ações Editar, Desativar/Reativar e ↑/↓.
- Estados de **carregando** (esqueleto anunciado), **vazio** (com a ação de criar), **erro** (com "Tentar novamente") e **nada encontrado** (com "Limpar busca e filtros"). **Estrutura de dados ausente** (a migration não aplicada → o servidor responde 503) vira uma mensagem clara — "os cadastros não estão disponíveis agora… a estrutura de dados ainda não foi preparada neste ambiente. Nada foi alterado." — e **nada é confirmado**.
- **Painel lateral com URL própria** (`…/novo` e `…/<id>`; `ui/routedDrawer.mjs`), sobre a lista (busca, filtro e rolagem preservados): cabeçalho e rodapé fixos, corpo rolável, foco no primeiro campo, ESC / X / fundo / Voltar / Avançar. **Proteção de alterações não salvas** ("Descartar alterações" / "Continuar editando") em ESC, X, fundo, Cancelar, Voltar/Avançar, outro item, **trocar de catálogo**, trocar de módulo e atualizar/fechar a aba; durante o envio nada fecha. Erros de campo **junto do campo** (códigos do servidor traduzidos), foco no primeiro erro, **o que foi digitado nunca é apagado por uma falha**, **sem envio duplicado**, **sucesso só depois da confirmação da API**.
- **Desativar** pede confirmação (nada é apagado); **reativar** é direto; "excluir" não existe. A lista só muda depois da resposta da API. **Reordenar:** a nova ordem aparece já, mas só vale depois da API — em falha a ordem anterior **volta**; fica **desabilitado com busca ou filtro ativos** (a ordem vale para todos os itens), com a explicação.
- **Atualização sem F5:** o item criado/alterado aparece na hora; o evento `crm-catalogs:changed` avisa o resto do painel; "Atualizar" traz o que mudou no servidor; ao voltar à tela, uma leitura em silêncio.

**Página Configurações do CRM** (`#/crm/configuracoes`, `dashboard/views/crmSettings.mjs`): um índice com cartões — Serviços, Nichos e Cores e Origens dos Leads (links para as rotas reais) e Gestão de Funis e Etapas (cartão desabilitado, sem link, marcado EM DESENVOLVIMENTO). Os três cadastros exigem `MANAGE:CRM_CATALOGS` e a gestão de funis exige `MANAGE:FUNNELS`; um cartão que a conta não pode usar **não aparece**, e sem nenhuma das duas permissões a página diz "sem acesso" (nenhum link administrativo é mostrado). Sem contagens, exemplos ou chamadas de API (nada simulado). Cada tela de catálogo tem o caminho de volta (migalha "Configurações do CRM / <tela>"); o item de menu deixou de ser marcado "em desenvolvimento" e a seção `crm-settings` é própria no roteador.

**Campos (só os do contrato; `dashboard/catalog-model.mjs`, copiado como dado estático porque o navegador nunca importa `src/` — a cópia é conferida contra o servidor em teste)**
- **Serviços:** nome, descrição, categoria, **preço de referência em reais** (formato brasileiro `1.500,00`; informativo — não altera propostas nem negociações), tipo de cobrança (Pagamento único / Cobrança recorrente) e recorrência (Mensal, Trimestral, Semestral, Anual — só aparece para a recorrente). Na edição vai **só o que mudou**; mudar o tipo de cobrança leva a recorrência junto.
- **Nichos e Cores:** nome, descrição e **cor**. Seletor visual com **exatamente 20 cores** (`ui/colorPicker.mjs`; `role="radiogroup"`, amostra + **nome em texto** + marca de selecionada, teclado com setas/Home/End), **sem opção "sem cor"**, e **prévia de cartão** com borda esquerda na cor escolhida. **O backend permite cor nula; isso não foi alterado.** A interface **exige uma das 20 cores ao criar** e trata um nicho legado sem cor com aspecto neutro e o texto "Sem cor definida" (editável sem que uma cor seja inventada). Só a **chave** viaja (`catalog-colors.mjs` é uma cópia estática, conferida contra a paleta do servidor); a aparência vem das classes `.cor-<chave>`: nenhum estilo inline, nenhum valor de cor no JavaScript, CSP intacto.
- **Origens dos Leads:** nome, descrição e **canal** (a taxonomia real: Prospecção ativa, Anúncio pago, Indicação, Orgânico, Parceria, Outro; opcional, "Não classificado"). **Nenhuma integração** (WhatsApp, Meta Ads, Google Ads, IA) é ativada e nenhuma origem real é cadastrada.
- **Em uso pelo CRM legado:** ao abrir a edição a tela lê `emUso` (GET do item) e, se houver registros, trava o nome com a explicação; o servidor continua a autoridade (um `409 NAME_IN_USE` aparece no campo).

**Permissões**
- Dashboard: `canManageCrmCatalogs` (`MANAGE:CRM_CATALOGS`, só ADMIN) e `canManageFunnels` (`MANAGE:FUNNELS`) em `permissionsOf`. As telas e os três itens do menu exigem a primeira; **Gestão de Funis e Etapas** (EM DESENVOLVIMENTO) exige a segunda. O vendedor (`COMMERCIAL_CLOSER`) **não vê nenhum item de Configurações do CRM** (o pai some sem filhos); por link direto, as telas dizem "Esta conta não possui acesso a esta área." e **nenhuma chamada de catálogo é feita**. O backend continua a autoridade final (403 para o vendedor, conferido em teste contra o servidor real).
- Nenhuma permissão do backend foi alterada.

**Rotas** (`router.mjs`): listas `#/crm/configuracoes/servicos|nichos|origens` (as rotas existentes, intactas); painéis `…/<catalogo>/novo` e `…/<catalogo>/<id codificado>` (`crm-catalog-new`, `crm-catalog-item`); seção `crm-catalogs`; o painel mantém aceso o item do menu e usa o título da lista. Chave de catálogo desconhecida, id vazio e `%` solto são "Página não encontrada". `#/crm`, `#/crm/clientes`, `#/crm/configuracoes`, `#/crm/configuracoes/funis` e todas as demais rotas seguem como eram.

**Cliente de API** (`api.mjs`): `listCatalog`, `getCatalogItem`, `createCatalogItem`, `updateCatalogItem`, `activateCatalogItem`, `deactivateCatalogItem`, `reorderCatalog` — o corpo só leva campos **graváveis** do catálogo (`id`, `ordem`, `ativo`, datas, responsáveis, `userId`, `role` e `permissions` são recusados **antes** de existir uma requisição) e o `ApiError` agora traz `details` (só `{ path, code }`).

**Testes de rede externa separados** (pedido da 2B-2): os testes que podiam consultar o Supabase Auth **real** quando o `.env` era carregado foram **movidos, sem alterar asserções**, para `tests/integration/` (7 testes); o `npm test` **não carrega mais o `.env`**, remove as credenciais do ambiente e roda com o guarda hermético `tests/setup/hermetic.js`, que **bloqueia** qualquer conexão, DNS ou processo `claude` fora do computador. A integração externa é `npm run test:integration` e só executa com `RIO_X7_RUN_EXTERNAL_TESTS=1` e credenciais próprias. Ver `tests/README.md`. A autenticação de produção **não foi alterada**.

## 3. Decisões arquiteturais aprovadas

- Um cliente pode ter várias negociações, inclusive no mesmo funil; o card passa a representar a **negociação**. O ciclo comercial pertence à **negociação**, não ao `status` legado do cliente (a máquina de estados dos 13 status e o Não Contatar terminal são preservados).
- **Supabase** é a base oficial das entidades novas, mantendo o adaptador local de desenvolvimento. **Nenhuma migração de dados** e **nenhuma migration aplicada** sem autorização específica do proprietário.
- Interface em português do Brasil (LEAD, Dashboard, MQL, Status, Follow-up, Raio-X, Briefing e nomes próprios ficam). `localStorage` **só** para a preferência visual do menu. Módulos antigos só saem depois de existir substituição funcional validada.
- Não remapear `#/crm` em silêncio: ele é alias de Clientes; o Dashboard Comercial é uma página EM DESENVOLVIMENTO própria, sem métricas fictícias. Página futura = rota real + aviso + zero dados simulados + zero chamadas de API; área sem página = item desabilitado, sem rota. O menu esconde o que a permissão não cobre, mas **não é controle de acesso**.
- **Catálogos (2B-1):** D1 três entidades independentes · D2 `MANAGE:CRM_CATALOGS` só ADMIN, leitura de ativos por `READ:CRM` · D3 compatibilidade com o texto livre legado, com ids estáveis e renomeação de itens em uso bloqueada **temporariamente** · D4 sem exclusão física · D5 sem carga inicial. O preço de referência de um serviço **nunca** define o valor de uma proposta.
- **Interface dos catálogos (2B-2):** painel lateral com URL; cor obrigatória só na criação de nicho (sem "sem cor"; o backend segue permitindo nulo); reordenar com desfazer em falha e só sem filtro; "Gestão de Funis e Etapas" e os catálogos exigem permissões administrativas; testes de rede externa fora do `npm test`.

**Fases planejadas** (cada uma com aprovação humana antes da seguinte): 0 checkpoint ✔ → 1 auditoria ✔ → 2A menu, idioma, compatibilidade, responsividade ✔ **publicada** → 2B-1 estrutura técnica dos catálogos ✔ **publicada** → **2B-2 interface administrativa dos catálogos ✔ (local, sem commit)** → **2B-3 integração com o CRM (seleção nos formulários, filtros, validação, promoção)** → 2B-4 (só com autorização) aplicar a migration, carga inicial e normalização opcional → 3 clientes PF/PJ e contatos → 4 funis no Supabase e Quadro de Negociações → 5 edição comercial, propostas, perdas, fechamentos → 6 Dashboard Comercial e metas → 7 origens e integrações futuras → 8 auditoria final.

## 4. O que está REALMENTE implementado × o que é EM DESENVOLVIMENTO

**Implementado e testado**
- Menu lateral hierárquico e recolhível, menu do celular, preferência visual, catálogo de idioma e teste de vocabulário, rotas novas e antigas, página "EM DESENVOLVIMENTO" reutilizável (2A, publicada).
- Todas as telas funcionais anteriores (Visão Geral, Clientes/CRM com ficha e edição, Funis, Fila de Aprovação, Nova Prospecção, Histórico, Leads Reprovados, Exclusões Permanentes, Central de Agentes), com o vocabulário em português.
- **Backend dos catálogos (2B-1, publicado):** domínio, permissão, serviço, API, os dois adapters, a fábrica, o contador de uso, a paleta no CSS e a migration (não aplicada). **Sem nenhum item cadastrado.**
- **Interface administrativa dos catálogos (2B-2, local):** a página Configurações do CRM e as telas de Serviços, Nichos e Cores e Origens dos Leads, como descrito na seção 2.5. Testada no DOM de teste, contra o servidor real em armazenamento temporário e vista num navegador (ver a seção 6).

**EM DESENVOLVIMENTO (sem funcionalidade, sem dado)**
- Páginas com rota: Dashboard Comercial, Metas e Indicadores, Gestão de Funis e Etapas.
- Referências sem rota (itens desabilitados): Agenda, Conversas, Reuniões, Propostas, Relatórios, Configurações gerais.
- Tudo do CRM 5.0 além disso: Cliente PF/PJ, contatos, Negociação, Quadro de Negociações, propostas, perdas, fechamentos, metas, integrações, e a **ligação dos catálogos ao CRM** (2B-3).

## 5. Testes executados

**Suíte completa (2026-10-12, estado final da 2B-2):** `npm test` — **2430 testes: 2429 passam, 0 falham, 1 pulado** (o do symlink em `SRV-SEC-24b`, que exige privilégio elevado no Windows), **18 s**. Antes (2B-1): 2355 testes, 2353 passam, 2 pulados. A diferença: **+82 novos** (71 das telas, do modelo e da página Configurações; 10 do guarda hermético; 1 substituto hermético do antigo teste de "host inalcançável") e **−7 movidos** para `tests/integration/`.
- **Isolamento da rede:** a suíte rodou com o guarda de rede registrando em arquivo: **0 tentativas** de acesso externo (as 7 de integração, sem autorização, ficam **7 pulados**). `tests/scripts/hermetic-suite.test.js` (10 testes) prova que o guarda está ativo, bloqueia socket, DNS, `fetch` e `claude`, deixa o computador local livre, impede regressões (nenhum teste comum cria o adapter com o `process.env` real) e garante que **nenhum arquivo de `src/`, `scripts/` ou `dashboard/` conhece o guarda** e que `start` e `dev` seguem carregando o `.env`. **Auditoria:** os 7 testes movidos são **idênticos** aos originais do `HEAD` (só mudam a linha do portão de autorização e `async () =>` → `async (t) =>` no antigo teste de "host inalcançável"), conferido por comparação de texto.
- **Dados:** os 10 `data/*.json` tiveram o **mesmo SHA-256 antes e depois**; `data/crm-catalogs.json` **não foi criado**. `git diff --check` limpo. Varredura de dados sensíveis (tokens, chaves, JWT, e-mails, telefones, CPF/CNPJ, caminhos locais) sem achados reais — só fixtures falsas.

**Novos da 2B-2 (71 + 11):** `dashboard-catalog-model` 11 (contrato do servidor × Dashboard, dinheiro em reais, corpos de criação/edição, mensagens de erro, cliente de API) · `dashboard-catalog-ui-colors` 7 (as 20 opções × servidor × CSS, seletor, teclado) · `dashboard-catalog-screens` 13 (lista, estados, busca/filtro, criar, validação, erros da API, editar, em uso, desativar/reativar, reordenar, permissões) · `dashboard-catalog-panel` 13 (link direto, Voltar/Avançar, ESC/X/fundo, rascunho, trocar de catálogo, sair do módulo, rotas) · `dashboard-catalog-niches-origins` 9 · `dashboard-catalog-shell` 6 (painel inteiro: menu por permissão, rascunho ao mudar de módulo, logout sem sobras, compatibilidade) · `dashboard-catalog-fullstack` 6 (**servidor real**, arquivo temporário: 400/409 reais, nome em uso, desativar, reordenar, vendedor 403, **migration ausente** com o adaptador real do Postgres e um PostgREST falso que responde "tabela não existe") · `dashboard-crm-settings` 6 (a página de acessos: permissões, painel inteiro, navegação, compatibilidade) · `hermetic-suite` 10 · +1 em `supabase-integration`.

**Ajustados por mudança intencional:** os testes de menu/permissões/rotas (`dashboard-sidebar`, `-menu-shell`, `-shell`, `-crm-model`, `-static-guards`, `-crm-edit`), `dashboard-catalog-colors` (a lista de opções agora mora em `catalog-colors.mjs`), `catalogCompatibility` (o preço de referência é conhecido também pelas três peças da interface dos catálogos), `crmCatalogsMigration` (o script `test:integration`).

**Verificação dos próprios testes:** 21 mutações temporárias no código de produção (as 4 da página Configurações — permissão ignorada, abertura sem permissão, funis como link, cadastro exigindo a permissão errada — e proteção de rascunho, sucesso antes da API, restaurar a ordem, reordenar com filtro, cor obrigatória, permissão da tela, `needs` do menu, campo `ativo` no corpo, edição enviando tudo, 21ª opção "sem cor", preço com 3 casas, "Continuar editando" sem restaurar o endereço, desativar sem confirmação, envio duplicado, erro apagando o digitado, sair do módulo sem perguntar, estilo inline) — **todas pegas**; cada arquivo foi restaurado depois.

## 6. Pendências de validação visual (no dashboard real, com login)

**Feito na 2B-2 (fora do repositório, sem login real e sem tocar no armazenamento operacional):** a página Configurações do CRM e as três telas foram vistas num navegador de verdade, servidas pelo **app real do servidor** (os mesmos cabeçalhos CSP de produção) sobre **armazenamento temporário**, escutando **só em 127.0.0.1**, com o Supabase Auth **falso** (nenhuma rede) e **dados 100% fictícios**. Quatro instâncias: com dados, **vazia**, com a **estrutura de dados ausente** (o adaptador real do Postgres sobre um PostgREST falso que responde "tabela não existe" — a migration "não aplicada") e **lenta** (para ver o carregamento). Os servidores foram **encerrados** depois (as portas não respondem mais) e os diretórios temporários foram removidos.

Evidências:
- **Larguras:** celular 375 px; intermediária 820 px (menu do celular) e 1000 px (menu lateral); desktop 1280 px. A captura de tela só mostra bem larguras de celular (cerca de 640 px de CSS); o desktop e o intermediário foram vistos com a página reduzida por zoom de CSS (as consultas de largura continuam sendo as da janela emulada) e confirmados por **medidas no DOM**: painel lateral de 640 px à direita, cabeçalho no topo e rodapé no fim da tela, corpo rolável; ações na mesma linha do nome; seletor de cores em 2 colunas no celular e 4 no painel largo; nenhum rolamento horizontal da página.
- **Configurações do CRM:** os quatro cartões numa linha em 1000 e 1280 px (empilhados no celular); o cartão da Gestão de Funis e Etapas tracejado, sem link, com "EM DESENVOLVIMENTO"; cada cartão abre a tela real; a migalha "Configurações do CRM / <tela>" e o Voltar do navegador voltam à página; o item do menu fica aceso e o título da aba muda.
- **Estados:** **carregando** (esqueleto com `aria-busy`, rótulo para leitor de tela, "Atualizar" desabilitado, depois as 9 linhas), **vazio** (com "Novo Serviço"), **erro** com a estrutura de dados ausente ("Os cadastros não estão disponíveis agora… Nada foi alterado.", sem nenhum detalhe técnico do banco, com "Tentar novamente") e, ao tentar salvar, o painel continua aberto com o nome digitado e **sem mensagem de sucesso**; link para um item que não existe: aviso e volta à lista.
- **Painel lateral, rascunho e histórico (navegador real):** com texto digitado, **Voltar** pergunta "Descartar alterações?", o painel e o texto continuam; "Continuar editando" devolve o endereço `…/novo` **sem entrada nova no histórico**; "Descartar" + **Avançar** reabre o painel **vazio** (o rascunho descartado não volta); ao sair por endereço com seleção de cor feita, a pergunta também aparece.
- **Seletor de cores:** 20 opções na ordem do servidor, cada uma com amostra, nome em texto e marca de selecionada; escolher **Violeta** marca só ela, a prévia ganha `cor-violeta` (borda esquerda de 5,2 px em `rgb(71, 18, 217)`) e a nota "Cor escolhida: Violeta."; alvos de 44 px; nenhuma opção "sem cor".
- **Contraste e legibilidade (medidos no navegador, WCAG):** títulos 14,7:1; subtítulo e textos de apoio **≥ 5,4:1**; nomes dos itens e detalhes ≥ 5,7:1 (os de itens inativos, em tom suave, 5,7:1); selos ≥ 6,7:1; botões ≥ 12:1; erros ≥ 7,3:1; **os 20 nomes de cor ≥ 7,05:1**; chip do nicho ≥ 7,2:1; menu ≥ 8,8:1. Tamanhos de texto de 12,5 px (selos) a 26 px (título); botões de ação de 40 px de altura no celular.
- **CSP e segurança:** o console ficou **sem nenhum erro nem violação de CSP**; nenhum atributo `style` na página; o vendedor (`?as=closer`) não vê Configurações do CRM no menu e recebe "sem acesso" na página e nos links diretos.

**Ainda pendente (2B-2):**
1. Entrar com a conta ADMIN **real** (`npm start`) e percorrer as três telas — com a migration **não aplicada**, em `REPOSITORY_MODE=supabase` esperam-se a mensagem de "estrutura de dados não preparada" e nenhuma gravação; em `REPOSITORY_MODE=file` (local) as telas funcionam e o primeiro cadastro cria `data/crm-catalogs.json` (**arquivo operacional: não cadastre exemplos no CRM real**).
2. Entrar com o vendedor: nenhum item de "Configurações do CRM" no menu e "sem acesso" nos links diretos.
3. Toque real, zoom de 200%, Firefox e Safari, leitor de tela (grupo de cores, mensagens de erro anunciadas, confirmações). (As larguras de 375, 820, 1000 e 1280 px já foram vistas, ver acima.)

**Da Fase 2A (publicada, ainda sem validação no Dashboard real):**
1. Menu com as telas reais por trás: CRM → Dashboard Comercial; `#/crm` e `#/crm/clientes`; ficha de registro aberta por link direto (Fila de Aprovação, Visão Geral, Funis); Voltar/Avançar; ESC e X do painel.
2. **Voltar/Avançar e a proteção de rascunho** ao trocar de item do menu (Novo registro com texto digitado).
3. A preferência recolhido/expandido depois de recarregar a página.
4. Os itens da seção 2.1 que já estavam pendentes (CRM, edição, Nova Prospecção, Histórico, Leads Reprovados).
5. Iniciar uma prospecção **real** usa o Claude Code local e consome limite de uso: só com decisão consciente.

## 7. Limites e riscos conhecidos

- Restaurar o endereço depende de `history.state`; provado no DOM de teste e confirmado num navegador real para o painel dos catálogos (2B-2); falta para as outras telas. O menu usa `inert` e `scrollbar-color`: navegadores muito antigos degradam.
- **Catálogos:** (a) **renomear item em uso é bloqueado** (seção 2.4) até uma migração futura ligar os registros por id; (b) sem versionamento de edição — dois ADMINs no mesmo item: o último a gravar prevalece, por campo; ao reordenar com a lista defasada o servidor recusa (`LISTA_INVALIDA`) e a tela recarrega; (c) o contador de uso lê **todos** os registros do CRM e roda só ao tentar mudar um nome e **a cada abertura da edição** de um item (o painel o consulta); (d) a **promoção não canonicaliza** `nicho` (o texto do briefing segue como veio); (e) `servicoPotencial` é um valor só por registro; (f) o SQL da migration **não foi executado** — recomenda-se aplicá-lo primeiro numa transação e conferir RLS; (g) letras não latinas e símbolos não contam na normalização do nome (`C#` e `C++` equivalem a `C`); (h) a **lista dos catálogos carrega todos os itens de uma vez** (sem paginação) — adequado para listas controladas pequenas.
- **Cor do nicho:** o backend aceita cor nula e a interface exige cor só ao criar; um nicho criado por outra via (API direta) sem cor aparece neutro. Se o proprietário quiser **cor obrigatória no backend**, é uma mudança de contrato (e de migration) a decidir, **não feita** nesta fase.
- **Higiene dos testes (anterior à 2B-2, não corrigida):** os testes do projeto criam diretórios temporários em `%TEMP%` (`server-*`, `crm-*`) e não os removem; milhares se acumularam entre rodadas (dados de teste fictícios, fora do repositório). Vale limpá-los no `after` dos testes numa fase própria.
- O estado real das migrations no banco (inclusive as de Funis, Cards, Exclusões e Catálogos) **não foi verificado**; o `supabase/README.md` diz isso.
- "Novo registro" ainda é uma página (não uma gaveta). Visão Geral e Funis não assinam `crm:changed`. O CRM carrega **todos** os registros de uma vez e filtra no navegador. CRM-API sem versionamento: o último a salvar prevalece.
- Relatórios e Configurações gerais são visíveis a qualquer conta, como no menu antigo.
- O `npm test` não carrega mais o `.env` (deliberado): quem dependia dele para um teste real deve usar `npm run test:integration`.

## 8. Arquivos da Fase 2B-2 (candidatos ao commit — 41)

Staging **explícito**, um caminho por vez; nunca `git add .` nem `git add -A`. **Nada disto foi preparado, commitado nem publicado.** Total: **41 arquivos** (18 novos + 23 modificados).

**Novos (18)**
- Dashboard (6): `dashboard/catalog-colors.mjs`, `dashboard/catalog-model.mjs`, `dashboard/ui/colorPicker.mjs`, `dashboard/views/catalogForm.mjs`, `dashboard/views/catalogs.mjs`, `dashboard/views/crmSettings.mjs`
- Apoio e guarda dos testes (3): `tests/helpers/catalogHarness.js`, `tests/setup/hermetic.js`, `tests/integration/supabase-auth.integration.test.js`
- Testes (9): `tests/scripts/hermetic-suite.test.js`, `tests/server/dashboard-catalog-model.test.js`, `tests/server/dashboard-catalog-ui-colors.test.js`, `tests/server/dashboard-catalog-screens.test.js`, `tests/server/dashboard-catalog-panel.test.js`, `tests/server/dashboard-catalog-niches-origins.test.js`, `tests/server/dashboard-catalog-shell.test.js`, `tests/server/dashboard-catalog-fullstack.test.js`, `tests/server/dashboard-crm-settings.test.js`

**Modificados (23)**
- Produção (`dashboard/`, 8): `api.mjs`, `crm-model.mjs`, `i18n/pt-BR.mjs`, `main.mjs`, `nav.mjs`, `router.mjs`, `styles.css`, `ui/index.mjs`
- Configuração e documentação (4): `package.json`, `docs/decisions/0026-crm-catalogs.md`, `docs/development/UX-4-CHECKPOINT.md` (este arquivo), `tests/README.md`
- Testes (11): `tests/auth/identity-verification.test.js`, `tests/auth/supabase-integration.test.js`, `tests/crm/catalogCompatibility.test.js`, `tests/db/crmCatalogsMigration.test.js`, `tests/server/dashboard-catalog-colors.test.js`, `tests/server/dashboard-crm-edit.test.js`, `tests/server/dashboard-crm-model.test.js`, `tests/server/dashboard-menu-shell.test.js`, `tests/server/dashboard-shell.test.js`, `tests/server/dashboard-sidebar.test.js`, `tests/server/dashboard-static-guards.test.js`

**Nenhum arquivo de `src/`, `supabase/` ou `data/` foi alterado** (`git diff HEAD --name-only -- src supabase data` vazio).

**Fora do escopo, NÃO entram:** `.claude/` (inclui `launch.json`), `docs/security/` (modelo de ameaças à parte, ainda não revisado para publicação), `.env`, `data/*.json`, `backups/`, `tmp/`, `node_modules/`.

## 9. Próxima fase: 2B-3 — integração dos catálogos com o cadastro atual do CRM

**Não iniciada. Só com autorização.** Escopo previsto: oferecer nos formulários do CRM a **seleção dos itens ativos** dos catálogos (Serviço potencial, Nicho, Origem) em vez de texto livre; filtros e validação por catálogo; a promoção da Fila de Aprovação resolvendo o nicho/origem; tratamento dos valores legados em texto que não existem no catálogo; e a revisão da trava de renomeação. **Fora da 2B-3:** aplicar a migration, carga inicial e normalização dos dados históricos (2B-4, só com autorização expressa).

Pontos a decidir antes (nenhum decidido): como tratar o texto livre legado que não casa com nenhum item (manter, mapear ou pedir correção); se a tela do CRM mostra itens desativados já usados por um registro; **a lista inicial** de serviços, nichos e origens (do proprietário); e se a cor do nicho passa a ser obrigatória também no backend.

## 10. Como retomar, sem reiniciar nada

1. Na pasta do projeto: `git status --short`, `git log --oneline -3` e `git remote -v`. Esperado: `HEAD` em `85d3d4f` (2B-1 publicada), os arquivos da seção 8 como modificados/novos e, fora do escopo, `.claude/` e `docs/security/` não versionados. **Não refaça a 2A, a 2B-1 nem a 2B-2** — o código já está no diretório de trabalho. Se houver um commit da 2B-2 depois de `85d3d4f`, ela já foi publicada: pule para o passo 4.
2. Confira o estado verde, sem reimplementar: mova para fora do repositório `data/prospecting-batches.json`, registre o SHA-256 de `data/*.json`, rode `npm test`, restaure o arquivo e compare os hashes. Esperado: 2430 testes, 2429 passam, 0 falham, 1 pulado; hashes idênticos; `git diff --check` limpo; `data/crm-catalogs.json` inexistente. Para provar o isolamento, defina `NETGUARD_LOG` com o caminho de um arquivo antes do `npm test`: o log deve terminar **vazio**.
3. **Só com autorização:** commit da 2B-2 com `git add` explícito dos caminhos da seção 8 (conferindo antes `git diff --cached --name-only`), depois push normal (sem `--force`).
4. **A migration NÃO deve ser aplicada** sem decisão do proprietário (ver `supabase/README.md`: revisar, aplicar numa transação, conferir RLS). Nenhuma tabela é criada por código.
5. Validação visual real (seção 6): `npm start`, abrir o painel e entrar com a conta de teste. Se um servidor antigo ainda estiver rodando, reinicie-o.
6. Só depois, e **só com autorização expressa**, abrir a Fase 2B-3 pela lista da seção 9.

## 11. Restrições que continuam valendo

- Preservar o backend comercial e as regras da Prospecção 3.0.2 (aprovação humana, promoção explícita ao CRM, Não Contatar, exclusões permanentes, deduplicação, histórico, permissões).
- Nunca versionar `.env`, credenciais, `data/*.json`, backups, `tmp/`, `node_modules/`, `.claude/launch.json` nem registros reais de leads. Nunca usar `git add .` ou `git add -A`. Nunca `push --force`. **Nunca editar uma migration já versionada** (uma mudança vira migration nova).
- Testes comuns **não executam Claude real, não iniciam prospecção, não tocam a rede nem o banco reais e não alteram dados históricos** (o guarda hermético os bloqueia); arquivos de teste só em diretórios temporários. O que precisa de um serviço real é `tests/integration/`, só com autorização explícita.
- Nenhuma migration é aplicada, nenhuma tabela é criada no Supabase real, nenhuma dependência é instalada e nenhum dado é migrado ou cadastrado sem autorização do proprietário.
- Commit e push só depois de testes, varredura de dados sensíveis e `git diff --check`, e só com autorização.

## 12. Auditoria pré-checkpoint da 2B-2: conclusão e mensagem de commit sugerida

**Conclusão: APTO** para o checkpoint (commit local e push normal, **só com autorização expressa**).

Critérios conferidos em 2026-10-12: `npm test` com **2430 testes, 2429 passam, 0 falham, 1 pulado** e o log do guarda de rede **vazio**; os 10 `data/*.json` com o **mesmo SHA-256** e `data/crm-catalogs.json` **inexistente**; `git diff --check` limpo (rastreados e novos, sem espaço em branco sobrando); varredura de dados sensíveis sem achados reais (só fixtures falsas); **nenhuma alteração em `src/`, `supabase/` ou `data/`**; a migration `20261012090000_crm_catalogs.sql` **continua NÃO APLICADA** e nenhum código a executa; os 7 testes de rede externa movidos são **idênticos** aos originais (exceto o portão); a página Configurações do CRM e as três telas **validadas em navegador real** com armazenamento temporário isolado, nos três tamanhos e nos estados de carregamento, vazio e erro.

**Condições que NÃO bloqueiam o checkpoint, mas seguem abertas** (seção 6 e 7): validação com a conta ADMIN **real** (`npm start`); Firefox, Safari, leitor de tela e zoom de 200%; a revisão das decisões de cor obrigatória no backend e de renomeação (2B-3); a limpeza dos diretórios temporários que os testes antigos deixam em `%TEMP%`.

**Mensagem sugerida** (assunto sem acentos, como nos commits anteriores):

```
feat(crm): interface administrativa dos catalogos fase 2B-2

CRM 5.0, Fase 2B-2: as telas administrativas de Servicos, Nichos e Cores e
Origens dos Leads, sobre o backend publicado na 2B-1. So o Dashboard: nenhum
arquivo de src/, supabase/ ou data/ foi alterado e a migration dos catalogos
continua NAO APLICADA.

- Telas em #/crm/configuracoes/servicos|nichos|origens: lista com busca por
  nome, filtro de ativos/inativos, estados de carregando, vazio, erro e nada
  encontrado; criar e editar em painel lateral com URL propria (novo e <id>),
  ESC/X/Voltar/Avancar e protecao de alteracoes nao salvas; desativar com
  confirmacao, reativar e reordenar (a ordem volta se a API falhar).
- Servicos: preco de referencia em reais (so informativo), cobranca e
  recorrencia. Nichos: seletor de 20 cores com previa, cor obrigatoria so ao
  criar (o backend continua aceitando nulo) e nicho legado sem cor neutro.
  Origens: canal real do backend, sem nenhuma integracao.
- Pagina Configuracoes do CRM (#/crm/configuracoes) deixa de ser "em
  desenvolvimento": cartoes para os tres cadastros e para a Gestao de Funis e
  Etapas (desabilitado, EM DESENVOLVIMENTO), por permissao.
- Permissoes: MANAGE:CRM_CATALOGS para os cadastros e MANAGE:FUNNELS para a
  gestao de funis; o vendedor nao ve nenhum item e recebe "sem acesso".
- Testes de rede externa separados: o npm test passa a rodar com um guarda
  hermetico (credenciais removidas, conexoes e processo claude bloqueados) e
  nao carrega mais o .env; os 7 testes de Supabase Auth real foram movidos,
  sem alterar assercoes, para tests/integration (npm run test:integration,
  so com RIO_X7_RUN_EXTERNAL_TESTS=1).
- Testes: 2430 (2429 passam, 0 falham, 1 pulado); os 10 data/*.json com
  SHA-256 identico; nenhum acesso externo na suite comum (guarda com log vazio).
- Pendente: validacao com a conta ADMIN real. Checkpoint em
  docs/development/UX-4-CHECKPOINT.md. Proxima fase: 2B-3 (integracao dos
  catalogos com o cadastro do CRM), so com autorizacao.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```
