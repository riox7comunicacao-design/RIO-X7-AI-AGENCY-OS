# UX/UI 4.0 e CRM Comercial 5.0 — checkpoint de desenvolvimento

> **Isto é um CHECKPOINT de desenvolvimento, não a declaração de que o CRM Comercial 5.0 existe.** Serve para retomar o trabalho com segurança depois de uma pausa.
> Do CRM 5.0 existem, até aqui: a **Fase 2A** (menu lateral, idioma, compatibilidade de rotas e responsividade — **PUBLICADA**) e a **Fase 2B-1** (a **estrutura técnica** dos catálogos de Serviços, Nichos e Origens dos Leads — **só no diretório de trabalho**, sem interface). **Nenhuma entidade nova foi ligada ao CRM, nenhuma migration foi aplicada e nenhum dado foi criado.**
> Não contém senhas, tokens, dados pessoais nem caminhos locais privados.
> Última atualização: 2026-10-12.

## 1. Ponto de partida e estado do Git

- **Commit de base, já publicado em `origin/main`:** `fd6279995aa68c685ea7be593251507b00757084` — `feat(ux): CRM 5.0 phase 2A hierarchical navigation and pt-BR interface`. **A Fase 2A está PUBLICADA nesse commit.** Antes dele: `04183f611ed48130e1cec979c6f2c439fedba635` (`wip(ux): checkpoint dashboard modernization 4.0.5-4.0.6.3 pre CRM 5.0`), `3a5a482` e `9eddf79`.
- **Fase 2B-1:** implementada **só no diretório de trabalho**, **não preparada (sem `git add`), não commitada, não publicada**. A lista exata dos arquivos que entram no commit está na seção 8 (43 arquivos).
- Branch: `main`. Remoto esperado: `origin` → repositório `RIO-X7-AI-AGENCY-OS` da organização no GitHub.
- **O que a 2B-1 mexeu e o que não mexeu:** acrescentou módulos de catálogo em `src/` (domínio, ponte de autorização, serviço, adapters, fábrica), rotas em `src/server/app.js`, a composição em `src/server/index.js`, **uma migration aditiva NÃO aplicada** e testes. **Não alterou** `crm_records`, os 31 campos do CRM, as APIs comerciais existentes, a promoção, a prospecção, a Fila de Aprovação, as migrations anteriores (conferido por SHA-256 em teste), `package*.json` (nenhuma dependência instalada) nem nenhum `data/*.json` (SHA-256 igual antes e depois da suíte).

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
- A lista do CRM, a Fila de Aprovação, o Histórico, Leads Reprovados e a Nova Prospecção são **persistentes** (`show/hide`): estado e rolagem sobrevivem à troca de módulo.

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

### 2.4 CRM 5.0 — Fase 2B-1: estrutura técnica dos catálogos (implementada localmente, NÃO commitada)

Decisão registrada em [0026](../decisions/0026-crm-catalogs.md). **Só backend: nenhum formulário, nenhuma tela, nenhuma ligação com o CRM.**

**Entidades (D1)** — três independentes, cada uma com **identificador estável independente do nome** (`service:<uuid>`, `niche:<uuid>`, `origin:<uuid>`):

| Catálogo (URL) | Tabela prevista | Campos próprios |
|---|---|---|
| `servicos` | `crm_services` | `categoria`, `precoReferencia` (informativo; nunca vira valor de proposta), `tipoCobranca` (`UNICA`/`RECORRENTE`), `recorrencia` (só se recorrente) |
| `nichos` | `crm_niches` | `cor` — uma das **20 chaves** da paleta fixa |
| `origens` | `crm_lead_origins` | `canal` (`PROSPECCAO_ATIVA`, `ANUNCIO_PAGO`, `INDICACAO`, `ORGANICO`, `PARCERIA`, `OUTRO`) — **não** é a URL de fonte da Prospecção |

Campos comuns: `nome` (até 80), `nomeNormalizado`, `descricao` (até 500), `ativo`, `ordem`, `criadoEm`/`atualizadoEm` e o responsável por criar/alterar (do autorizador, nunca do corpo).

**Permissões (D2):** `MANAGE:CRM_CATALOGS` (**nova**, só ADMIN — agora 12 permissões; `COMMERCIAL_CLOSER` segue com 5) administra; `READ:CRM` consulta os itens **ativos** (quem só lê não vê desativados, auditoria nem `emUso`). A autorização é do Service, **antes** de validar ou tocar o armazenamento.

**Operações (D4):** criar, consultar, editar campos permitidos, reordenar, desativar, reativar. **Sem exclusão física** em nenhuma camada. Edição parcial e segura (valor igual ao atual não grava); `ativo`/`ordem`/`id`/datas/responsáveis nunca vêm por edição.

**API** (`/api/crm-catalogs/<catalogo>`, **não** `/api/crm/catalogs`, que seria lido como o id de um registro):

| Método e caminho | Permissão |
|---|---|
| `GET /<catalogo>[?todos=1]` | `READ:CRM` (`todos=1` exige gestão) |
| `POST /<catalogo>` · `POST /<catalogo>/reorder` | gestão |
| `GET /<catalogo>/:id` (o ADMIN recebe `emUso`) | `READ:CRM` |
| `PATCH /<catalogo>/:id` · `POST /<catalogo>/:id/activate` · `…/deactivate` | gestão |

Erros por `code` estável e mensagem fixa em português: `CRM_CATALOG_INVALID_INPUT` (400, `details` = só `{ path, code }`), `…_NOT_FOUND` (404), `…_DUPLICATE_NAME` (409), `…_NAME_IN_USE` (409), `…_PERSISTENCE` (503). Corpo e query estritos; sem cache.

**Unicidade:** o nome normalizado (minúsculas, sem acento, sem pontuação, espaços colapsados) é único por catálogo, **contando os desativados**, em três camadas: domínio, adapter de arquivo e `UNIQUE` no Postgres (a proteção entre processos). Criações concorrentes do mesmo nome resultam em UM item.

**Armazenamento:** domínio puro → Service → porta → **dois adapters pela mesma suíte de contrato** (arquivo local `data/crm-catalogs.json`, só criado quando um ADMIN cria o 1º item; e Postgres/Supabase por PostgREST com `fetch` injetável), escolhidos por `REPOSITORY_MODE` (`file` padrão; `supabase` exige as duas variáveis e **nunca cai para `file` em silêncio**). A variável `RIO_X7_CRM_CATALOGS_PATH` (opcional) muda o caminho do arquivo.

**Compatibilidade com o CRM legado (D3 — estratégia TEMPORÁRIA):** `nicho`, `origem` e `servicoPotencial` seguem **texto livre**; os 31 campos, as APIs comerciais, a promoção e a prospecção não consultam catálogos. **Restrição temporária de renomeação:** renomear um item que algum registro do CRM usa (comparação normalizada do campo legado) é recusado (`409 CRM_CATALOG_NAME_IN_USE`, vale até para só a caixa; se a contagem de uso falhar, também recusa). Cor, descrição, ordem e ativação seguem livres. Não é uma limitação da arquitetura: com ids estáveis, quando Clientes e Negociações referenciarem os catálogos por identificador (e uma migração específica, **autorizada**, ligar os dados legados), o nome poderá ser editado livremente.

**Paleta (20 cores):** o servidor e o banco guardam só a **chave** (`azul`); a interface a resolve pela classe `.cor-azul` em `dashboard/styles.css` (CSP `style-src 'self'`, DASH-GUARD-8: nenhum estilo inline nem cor no JavaScript). Texto sobre fundo ≥ 7:1, ponto ≥ 3:1, todos os pares de pontos a ΔE ≥ 25 — **recalculados em teste**, que também confere que CSS, código e a migration usam as mesmas chaves e tons. O nome do nicho vai sempre em texto. **Ainda sem tela que use as classes** (2B-2).

**Migration `20261012090000_crm_catalogs.sql` — NÃO APLICADA:** aditiva (três tabelas, `UNIQUE`, `CHECK`s, RLS sem policy, gatilho de `updated_at`, função atômica `reorder_crm_catalog`); **não toca `crm_records`**, sem foreign keys, sem carga inicial, sem exclusão. O SQL **não foi executado** (sem Postgres neste ambiente e sem autorização para o banco real): foi conferido por leitura e por testes estruturais que o cruzam com o código. Sem ela, em `REPOSITORY_MODE=supabase` as rotas de catálogo respondem 503; em `file` (padrão) funcionam. O `supabase/README.md` foi **corrigido**: descreve as 6 migrations com o estado **documentado** e avisa que **o cabeçalho de todos os SQL diz "NÃO APLICADA" (texto da época da proposta) e que nada foi verificado no banco real**.

**D5 — nenhuma carga inicial:** nenhum serviço, nicho ou origem é cadastrado por código, migration ou script; as listas iniciais serão definidas pelo proprietário.

## 3. Decisões arquiteturais aprovadas

- Um cliente pode ter várias negociações, inclusive no mesmo funil; o card passa a representar a **negociação**. O ciclo comercial pertence à **negociação**, não ao `status` legado do cliente (a máquina de estados dos 13 status e o Não Contatar terminal são preservados).
- **Supabase** é a base oficial das entidades novas, mantendo o adaptador local de desenvolvimento. **Nenhuma migração de dados** e **nenhuma migration aplicada** sem autorização específica do proprietário.
- Interface em português do Brasil (LEAD, Dashboard, MQL, Status, Follow-up, Raio-X, Briefing e nomes próprios ficam). `localStorage` **só** para a preferência visual do menu. Módulos antigos só saem depois de existir substituição funcional validada.
- Não remapear `#/crm` em silêncio: ele é alias de Clientes; o Dashboard Comercial é uma página EM DESENVOLVIMENTO própria, sem métricas fictícias. Página futura = rota real + aviso + zero dados simulados + zero chamadas de API; área sem página = item desabilitado, sem rota. O menu esconde o que a permissão não cobre, mas **não é controle de acesso**.
- **Catálogos (2B-1):** D1 três entidades independentes · D2 `MANAGE:CRM_CATALOGS` só ADMIN, leitura de ativos por `READ:CRM` · D3 compatibilidade com o texto livre legado, com ids estáveis e renomeação de itens em uso bloqueada **temporariamente** · D4 sem exclusão física · D5 sem carga inicial. O preço de referência de um serviço **nunca** define o valor de uma proposta.

**Fases planejadas** (cada uma com aprovação humana antes da seguinte): 0 checkpoint ✔ → 1 auditoria ✔ → 2A menu, idioma, compatibilidade, responsividade ✔ **publicada** → **2B-1 estrutura técnica dos catálogos ✔ (local, sem commit)** → **2B-2 interface administrativa dos catálogos** → 2B-3 integração com o CRM (seleção nos formulários, filtros, validação, promoção) → 2B-4 (só com autorização) aplicar a migration, carga inicial e normalização opcional → 3 clientes PF/PJ e contatos → 4 funis no Supabase e Quadro de Negociações → 5 edição comercial, propostas, perdas, fechamentos → 6 Dashboard Comercial e metas → 7 origens e integrações futuras → 8 auditoria final.

## 4. O que está REALMENTE implementado × o que é EM DESENVOLVIMENTO

**Implementado e testado**
- Menu lateral hierárquico e recolhível, menu do celular, preferência visual, catálogo de idioma e teste de vocabulário, rotas novas e antigas, página "EM DESENVOLVIMENTO" reutilizável (2A, publicada).
- Todas as telas funcionais anteriores (Visão Geral, Clientes/CRM com ficha e edição, Funis, Fila de Aprovação, Nova Prospecção, Histórico, Leads Reprovados, Exclusões Permanentes, Central de Agentes), com o vocabulário em português.
- **Backend dos catálogos (2B-1, local):** domínio, permissão, serviço, API, os dois adapters, a fábrica, o contador de uso, a paleta no CSS e a migration (não aplicada). **Sem nenhum item cadastrado.**

**EM DESENVOLVIMENTO (sem funcionalidade, sem dado)**
- Páginas com rota: Dashboard Comercial, Metas e Indicadores, Configurações do CRM, **Serviços, Nichos e Cores, Origens dos Leads** (a interface administrativa é a **2B-2**), Gestão de Funis e Etapas.
- Referências sem rota (itens desabilitados): Agenda, Conversas, Reuniões, Propostas, Relatórios, Configurações gerais.
- Tudo do CRM 5.0 além disso: Cliente PF/PJ, contatos, Negociação, Quadro de Negociações, propostas, perdas, fechamentos, metas, integrações, e a **ligação dos catálogos ao CRM**.

## 5. Testes executados

**Suíte completa (2026-10-12, estado final da 2B-1):** 2355 testes — **2353 passam, 0 falham, 2 pulados** (os mesmos 2 de antes; **+191** sobre os 2164 da 2A). Rodada pelo `npm test` (que carrega o `.env` do desenvolvedor — por isso nenhum teste novo depende de `process.env` nem toca a rede real: o `fetch` é sempre falso). Os 10 arquivos `data/*.json` tiveram o **mesmo SHA-256 antes e depois**; `data/crm-catalogs.json` **não foi criado**. `git diff --check` limpo. Varredura de dados sensíveis (tokens, chaves, JWT, e-mails, telefones, CPF/CNPJ, caminhos locais) sem achados reais — só fixtures falsas.

**Novos (191):** `catalogConstants` 6 · `catalogDomain` 26 · `catalogRepositoryPort` 4 · `catalogRepository` 32 (memória e arquivo) · `crmSupabaseCatalogRepository` 36 (contra um PostgREST falso) · `crmCatalogsMigration` 14 (SQL lido como texto) · `catalogBridge` 7 · `catalogService` 19 · `catalogRepositoryFactory` 13 (inclui o contador de uso) · `crm-catalog-api` 20 · `dashboard-catalog-colors` 5 · `catalogCompatibility` 8 · +1 regra de arquitetura em `crm-adapters/architecture`. A **suíte de contrato** (`tests/helpers/catalogRepositoryContract.js`) roda igual sobre memória, arquivo e Supabase.

**Ajustados por mudança intencional:** permissões do ADMIN 11 → 12 (`role-permissions`, `context-trust`, `user-identity-binding`, `boundary-hardening`, `lead-proposal-bridge`), os imports permitidos da composição e dos adapters (`crm-api-boundaries`, `crm-adapters/architecture`) e o ambiente de teste do servidor (`testEnv.js`, com `crmCatalogs`).

**Verificação dos próprios testes:** 7 mutações temporárias no código (unicidade, `updated_at` no PATCH, autorização do `create`, trava de renomeação, unicidade de desativados, um tom da paleta, o `UNIQUE` da migration) — a que escapou na primeira rodada (a regra de desativados do domínio, redundante com a do repositório) ganhou um teste próprio; todas passaram a ser pegas.

## 6. Pendências de validação visual (no dashboard real, com login)

**Da Fase 2A (publicada, ainda sem validação no Dashboard real):**
1. Menu com as telas reais por trás: CRM → Dashboard Comercial; `#/crm` e `#/crm/clientes`; ficha de registro aberta por link direto (Fila de Aprovação, Visão Geral, Funis); Voltar/Avançar; ESC e X do painel.
2. **Voltar/Avançar e a proteção de rascunho** ao trocar de item do menu (Novo registro com texto digitado).
3. A preferência recolhido/expandido depois de recarregar a página.
4. Larguras intermediárias (≈ 900–1100 px), celular de verdade (toque), zoom de 200%, Firefox e Safari, leitor de tela (itens desabilitados e setas).
5. Os itens da seção 2.1 que já estavam pendentes (CRM, edição, Nova Prospecção, Histórico, Leads Reprovados).
6. Iniciar uma prospecção **real** usa o Claude Code local e consome limite de uso: só com decisão consciente.

**Da 2B-1:** nada visual novo — só as classes de cor, ainda sem uso; serão validadas na 2B-2.

## 7. Limites e riscos conhecidos

- Restaurar o endereço depende de `history.state`; provado no DOM de teste, falta confirmar em navegador real. O menu usa `inert` e `scrollbar-color`: navegadores muito antigos degradam.
- **Catálogos:** (a) **renomear item em uso é bloqueado** (seção 2.4) até uma migração futura ligar os registros por id; (b) sem versionamento de edição — dois ADMINs no mesmo item: o último a gravar prevalece, por campo; (c) o contador de uso lê **todos** os registros do CRM (como o próprio CRM já faz) e roda só ao tentar mudar um nome e na consulta de um item pelo ADMIN; (d) a **promoção não canonicaliza** `nicho` (o texto do briefing segue como veio); (e) `servicoPotencial` é um valor só por registro; (f) o Dashboard **ainda não conhece** `MANAGE:CRM_CATALOGS` (a 2B-2 o acrescenta); (g) o SQL da migration **não foi executado** — recomenda-se aplicá-lo primeiro numa transação e conferir RLS; (h) letras não latinas e símbolos não contam na normalização do nome (`C#` e `C++` equivalem a `C`).
- O estado real das migrations no banco (inclusive as de Funis, Cards e Exclusões) **não foi verificado**; o `supabase/README.md` agora diz isso.
- "Novo registro" ainda é uma página (não uma gaveta). Visão Geral e Funis não assinam `crm:changed`. O CRM carrega **todos** os registros de uma vez e filtra no navegador. CRM-API sem versionamento: o último a salvar prevalece.
- Relatórios e Configurações gerais são visíveis a qualquer conta, como no menu antigo.

## 8. Arquivos da Fase 2B-1 (candidatos ao commit — 43)

Staging **explícito**, um caminho por vez; nunca `git add .` nem `git add -A`.

**Novos (25)**
- Domínio e persistência: `src/crm/catalogConstants.js`, `src/crm/catalogDomain.js`, `src/crm/catalogRepositoryPort.js`, `src/crm/catalogRepository.js`, `src/crm-adapters/crmSupabaseCatalogRepository.js`
- Autorização e serviço: `src/auth/catalogBridge.js`, `src/services/catalogService.js`, `src/services/catalogUsage.js`, `src/services/catalogRepositoryFactory.js`
- Banco e documentação: `supabase/migrations/20261012090000_crm_catalogs.sql`, `docs/decisions/0026-crm-catalogs.md`
- Testes: `tests/auth/catalogBridge.test.js`, `tests/crm/catalogConstants.test.js`, `tests/crm/catalogDomain.test.js`, `tests/crm/catalogRepositoryPort.test.js`, `tests/crm/catalogRepository.test.js`, `tests/crm/catalogCompatibility.test.js`, `tests/crm-adapters/crmSupabaseCatalogRepository.test.js`, `tests/db/crmCatalogsMigration.test.js`, `tests/services/catalogService.test.js`, `tests/services/catalogRepositoryFactory.test.js`, `tests/server/crm-catalog-api.test.js`, `tests/server/dashboard-catalog-colors.test.js`, `tests/helpers/catalogRepositoryContract.js`, `tests/helpers/fakePostgrestCatalogs.js`

**Modificados (18)**
- Produção: `src/auth/constants.js`, `src/auth/index.js`, `src/crm-adapters/index.js`, `src/server/app.js`, `src/server/index.js`, `dashboard/styles.css`, `.env.example`
- Documentação: `supabase/README.md`, `data/README.md`, `docs/development/UX-4-CHECKPOINT.md` (este arquivo)
- Testes: `tests/auth/boundary-hardening.test.js`, `tests/auth/context-trust.test.js`, `tests/auth/lead-proposal-bridge.test.js`, `tests/auth/role-permissions.test.js`, `tests/auth/user-identity-binding.test.js`, `tests/crm-adapters/architecture.test.js`, `tests/server/crm-api-boundaries.test.js`, `tests/server/testEnv.js`

**Fora do escopo, NÃO entram:** `.claude/` (inclui `launch.json`), `docs/security/` (modelo de ameaças à parte, ainda não revisado para publicação), `.env`, `data/*.json`, `backups/`, `tmp/`, `node_modules/`.

## 9. Próxima fase: 2B-2 — interface administrativa dos catálogos

**Não iniciada. Só com autorização.** Hoje `#/crm/configuracoes/servicos`, `…/nichos` e `…/origens` são páginas EM DESENVOLVIMENTO; a 2B-2 as substitui pelas telas reais (Gestão de Funis e Etapas continua EM DESENVOLVIMENTO até a Fase 4).

Escopo previsto: lista, gaveta com URL e formulários (criar, editar, desativar/reativar, reordenar, ver desativados por `?todos=1`); **seletor de cor acessível** (radiogroup das 20 chaves, classe `.cor-<chave>`, nome em texto); campos próprios de serviço (cobrança/recorrência) e de origem (canal); mostrar `emUso` e explicar a trava de renomeação; mapear `details` (`path`/`code`) em mensagens por campo em português; proteção de rascunho e ESC/X/Voltar como nas demais telas. No Dashboard: acrescentar `MANAGE:CRM_CATALOGS` ao mapa de permissões, ajustar o `needs` dos itens do menu, manter o teste de vocabulário, o CSP e DASH-GUARD-8, e nenhum módulo órfão.

**Fora da 2B-2:** ligar os catálogos aos formulários e à promoção do CRM (2B-3) e aplicar a migration/carga inicial (2B-4).

Pontos a decidir antes (nenhum decidido): os rótulos em português dos canais de origem e da cobrança; se COMMERCIAL_CLOSER vê as telas de configuração em modo leitura; a lista inicial de serviços, nichos e origens (do proprietário).

## 10. Como retomar, sem reiniciar nada

1. Na pasta do projeto: `git status --short`, `git log --oneline -3` e `git remote -v`. Esperado: `HEAD` em `fd62799` (2A publicada), os 43 arquivos da seção 8 como modificados/novos e, fora do escopo, `.claude/` e `docs/security/` não versionados. **Não refaça a 2A nem a 2B-1** — o código já está no diretório de trabalho. Se houver um commit da 2B-1 depois de `fd62799`, ela já foi publicada: pule para o passo 4.
2. Confira o estado verde, sem reimplementar: mova para fora do repositório `data/prospecting-batches.json`, registre o SHA-256 de `data/*.json`, rode `npm test`, restaure o arquivo e compare os hashes. Esperado: 2355 testes, 2353 passam, 0 falham, 2 pulados; hashes idênticos; `git diff --check` limpo; `data/crm-catalogs.json` inexistente.
3. **Só com autorização:** commit da 2B-1 com `git add` explícito dos 43 caminhos da seção 8 (conferindo antes `git diff --cached --name-only`), depois push normal (sem `--force`).
4. **A migration NÃO deve ser aplicada** sem decisão do proprietário (ver `supabase/README.md`: revisar, aplicar numa transação, conferir RLS). Nenhuma tabela é criada por código.
5. Validação visual real (seção 6): `npm start`, abrir o painel e entrar com a conta de teste. Se um servidor antigo ainda estiver rodando, reinicie-o.
6. Só depois, e **só com autorização expressa**, abrir a Fase 2B-2 pela lista da seção 9.

## 11. Restrições que continuam valendo

- Preservar o backend comercial e as regras da Prospecção 3.0.2 (aprovação humana, promoção explícita ao CRM, Não Contatar, exclusões permanentes, deduplicação, histórico, permissões).
- Nunca versionar `.env`, credenciais, `data/*.json`, backups, `tmp/`, `node_modules/`, `.claude/launch.json` nem registros reais de leads. Nunca usar `git add .` ou `git add -A`. Nunca `push --force`. **Nunca editar uma migration já versionada** (uma mudança vira migration nova).
- Testes não executam Claude real, não iniciam prospecção, não tocam a rede nem o banco reais e não alteram dados históricos; arquivos de teste só em diretórios temporários.
- Nenhuma migration é aplicada, nenhuma tabela é criada no Supabase real, nenhuma dependência é instalada e nenhum dado é migrado ou cadastrado sem autorização do proprietário.
- Commit e push só depois de testes, varredura de dados sensíveis e `git diff --check`, e só com autorização.
