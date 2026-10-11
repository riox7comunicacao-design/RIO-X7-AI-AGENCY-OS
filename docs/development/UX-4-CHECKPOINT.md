# UX/UI 4.0 e CRM Comercial 5.0 — checkpoint de desenvolvimento

> **Isto é um CHECKPOINT de desenvolvimento, não a declaração de que o CRM Comercial 5.0 existe.** Serve para retomar o trabalho com segurança depois de uma pausa.
> Do CRM 5.0 só existe, até aqui, a **Fase 2A: menu lateral, idioma, compatibilidade de rotas e responsividade** (somente interface). **Nenhuma entidade, tabela, migration ou regra nova de CRM foi criada.**
> Não contém senhas, tokens, dados pessoais nem caminhos locais privados.
> Última atualização: 2026-10-11.

## 1. Ponto de partida e estado do Git

- **Commit de base (já publicado em `origin/main`):** `04183f611ed48130e1cec979c6f2c439fedba635` — `wip(ux): checkpoint dashboard modernization 4.0.5-4.0.6.3 pre CRM 5.0`. Antes dele: `3a5a482` (`wip(ux): checkpoint dashboard modernization 4.0`) e `9eddf79` (`feat(prospecting): add on-demand enrichment and commercial integrity (3.0.1–3.0.2)`).
- **Fase 2A:** implementada **só no diretório de trabalho**, **não preparada (sem `git add`), não commitada, não publicada**. A lista exata dos arquivos que entram no commit está na seção 8.
- Branch: `main`. Remoto esperado: `origin` → repositório `RIO-X7-AI-AGENCY-OS` da organização no GitHub.
- Backend comercial (Prospecção 3.0.2, CRM, Funis, Fila de Aprovação): **intocado** em todas as fases. Só `dashboard/`, `tests/` e este documento mudaram — nenhum arquivo de `src/`, `supabase/`, `scripts/` nem `package*.json`; nenhuma dependência instalada; nenhuma migration criada ou aplicada; nenhum `data/*.json` alterado.

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

Nada do CRM 5.0 está no código além da Fase 2A. A auditoria concluiu:

**Armazenamento**
- CRM (`crm_records`): **Supabase** é a fonte oficial desde 2026-09-28 (`REPOSITORY_MODE=supabase`); a política de dados registra 0 registros nessa data (reconfirmar antes de qualquer migração). `data/crm.json` é só a implementação de arquivo para desenvolvimento.
- Funis, etapas e cards: **apenas arquivo JSON**. As migrations de funis e cards existem e estão testadas, mas **marcadas como não aplicadas**, e não há adaptador Supabase para funis. Um card (arquivo) referencia um registro (Supabase) sem chave estrangeira.
- Fila de aprovação e Prospecção: arquivos JSON locais.

**Lacunas em relação ao 5.0:** registro plano (sem Cliente PF/PJ, contatos nem Negociação); campos livres onde o novo modelo exige catálogo (nicho, origem, temperatura, responsável); datas como texto livre; sem proposta/fechamento/pagamento/perda/atividade/meta; sem Dashboard Comercial; sem interface de administração de funis. O papel `COMMERCIAL_CLOSER` não tem `WRITE:CRM`.

**Decisões em aberto (antes da Fase 3):** permissões novas e o que o `COMMERCIAL_CLOSER` pode fazer; responsável como usuário (não texto); necessidade e proteção de CPF; dinheiro em centavos e as fórmulas de conversão, ticket médio, tempo de fechamento e "sem movimentação"; correspondência dos status antigos com as etapas; uso da coluna `version` para bloqueio otimista.

### 2.3 CRM 5.0 — Fase 2A: menu lateral, idioma, compatibilidade e responsividade (implementada localmente)

**Hierarquia definitiva do menu** (no máximo dois níveis de submenu; árvore em `dashboard/nav.mjs`):

```
Visão Geral
CRM                         (texto → #/crm/dashboard · seta → só expande/recolhe)
 ├ Dashboard Comercial      EM DESENVOLVIMENTO
 ├ Clientes                 (a lista atual do CRM)
 ├ Funis de Vendas
 ├ Metas e Indicadores      EM DESENVOLVIMENTO
 └ Configurações do CRM     EM DESENVOLVIMENTO
    ├ Serviços · Nichos e Cores · Gestão de Funis e Etapas · Origens dos Leads   (cada um EM DESENVOLVIMENTO)
Prospecção (grupo)          → Nova Prospecção · Histórico · Fila de Aprovação · Leads Reprovados
Agentes IA (grupo)          → Central de Agentes
Gestão (grupo)              → Exclusões Permanentes
                              + referências desabilitadas, SEM rota: Agenda · Conversas · Reuniões · Propostas · Relatórios · Configurações gerais
```

**Comportamento do menu** (`dashboard/ui/sidebar.mjs`)
- Botão recolhe/expande o menu todo (desktop): expandido = ícone + nome; recolhido = só ícones, com dica (tooltip) pelo nome ao passar o mouse **e** ao focar com o teclado. Os nomes continuam no DOM (visualmente ocultos) para leitores de tela.
- Entrada com rota e filhos (CRM, Configurações do CRM): o **texto** abre a rota e a **seta** (botão separado, com `aria-expanded`/`aria-controls`) só expande/recolhe. Grupos sem página (Prospecção, Agentes IA, Gestão): o texto inteiro alterna.
- Hierarquia reconhecível por indentação, linha-guia e espaçamento. Destaque da seção ativa (`aria-current="page"`; ancestrais abertos e marcados como ramo ativo). Contagem de pendentes na Fila de Aprovação soma no grupo Prospecção (aparece mesmo com o grupo recolhido).
- Teclado: ↑/↓ andam pelas entradas visíveis (pulam as escondidas e as desabilitadas), Home/End, → expande/entra, ← recolhe/volta ao pai, Enter/Espaço acionam botões.
- Permissões: cada entrada some quando a permissão falta; um pai some quando não sobra filho visível. **O menu é só um caminho** — a decisão real de acesso continua sendo do servidor.
- Celular/tablet (≤ 900 px): barra superior com botão do menu; o menu abre por cima (fora da tela e `inert` quando fechado), com fundo escurecido; ESC, o fundo, o botão "Fechar menu" e escolher um destino fecham e devolvem o foco ao botão. O recolhimento do desktop não vale no celular. Com um painel lateral de registro aberto, o ESC é do painel.
- Com muitos itens (grupo Gestão aberto) **só a navegação rola**; o rodapé (usuário e Sair) fica sempre visível.

**Compatibilidade de rotas** (`dashboard/router.mjs`)

| Endereço | O que abre | Observação |
|---|---|---|
| `#/crm` | Lista de Clientes | **rota legada mantida**; acende "Clientes"; não é remapeada para o Dashboard |
| `#/crm/clientes` | Lista de Clientes (a mesma tela) | rota nova |
| `#/crm/dashboard` | Dashboard Comercial — EM DESENVOLVIMENTO | destino do texto "CRM"; sem dados, sem API |
| `#/crm/registro/<id>`, `#/crm/novo` | Ficha em gaveta / Novo registro | inalterados; acendem "Clientes" |
| `#/crm/metas`, `#/crm/configuracoes`, `…/servicos`, `…/nichos`, `…/funis`, `…/origens` | página EM DESENVOLVIMENTO | sem dados, formulário nem botão de ação; zero chamadas de API |
| `#/aprovacoes`, `#/funis`, `#/prospeccao…`, `#/agentes`, `#/exclusoes-permanentes` | as telas atuais | inalterados |
| `#/agenda`, `#/conversas`, `#/reunioes`, `#/propostas`, `#/relatorios`, `#/configuracoes`, `#/leads` | "não encontrado" | **nenhuma rota falsa foi criada** para as referências do grupo Gestão |

`sectionOf` (qual tela) e `menuItemOf` (qual item acende) são funções separadas. Os links diretos (Fila de Aprovação → CRM, Visão Geral, Funis), Voltar/Avançar, ESC/X dos painéis e a proteção de alterações não salvas **foram preservados e têm teste** (a troca de item do menu com rascunho aberto pergunta antes; "Continuar editando" devolve o endereço sem empilhar entradas).

**Idioma — português do Brasil simples** (`dashboard/i18n/pt-BR.mjs`)
- O catálogo central cobre: nomes do menu, títulos de página, textos das páginas futuras, os 13 status, os papéis e o glossário (`TERMS`). Os textos próprios de cada tela continuam nas telas, já traduzidos, **guardados por um teste de vocabulário** que varre todas as strings do Dashboard atrás dos termos proibidos.
- Permanecem em inglês, por decisão do proprietário: LEAD, Dashboard, MQL, Status, Follow-up; nomes próprios (WhatsApp, Google Meet, Meta Ads, Google Ads, CRM); termos da agência (Raio-X, Briefing).
- Exemplos: Approval Queue → Fila de Aprovação; Pipeline → Funil de Vendas; DNC → Não Contatar; Prospect → Lead em Prospecção; Start → Reunião de Início; Won/Lost → Fechada/Perdida; `COMMERCIAL_CLOSER` → Vendedor; "Job de origem" → "Prospecção de origem".
- **Nada foi traduzido no que é código:** identificadores, valores guardados (`PROSPECT`, `DO_NOT_CONTACT`…), rotas, permissões, nomes de função e contratos de API continuam como eram; o domínio (`src/crm/constants.js`) mantém os seus rótulos em inglês. Texto **guardado** em inglês (histórico) só é traduzido **na exibição** ("Approval Queue" → "Fila de Aprovação", "prospect" → "lead"); a string original nunca é alterada.

**Preferência visual — exceção mínima e auditada ao `localStorage`** (`dashboard/preferences.mjs`)
- Guarda **só** o estado recolhido/expandido do menu: uma chave (`riox7.sidebar.collapsed`), valores `'1'`/`'0'`. Nunca usuários, registros, clientes, tokens, permissões ou dados comerciais. A expansão dos submenus fica só em memória.
- Armazenamento ausente, que lança ao acessar, ler ou gravar (cota cheia) **não quebra o menu**: a preferência passa a valer só na página.
- O guarda estático foi ajustado de forma restrita: só `preferences.mjs` pode conter o identificador `localStorage`; um segundo guarda confere a chave única, os valores `'1'`/`'0'`, só `getItem`/`setItem` e que só `app.mjs` o importa.

**Refinamentos finais (esta rodada)**
- Grupo **Gestão** voltou a referenciar os módulos antigos ainda inexistentes: **Agenda, Conversas, Reuniões, Propostas, Relatórios, Configurações gerais** — desabilitados, "Em desenvolvimento", **sem rota**, fora da ordem do teclado. Agenda/Conversas/Reuniões/Propostas só aparecem para quem tem `READ:CRM`; Relatórios e Configurações gerais não tinham permissão no menu antigo e seguem assim.
- **"Leads" NÃO foi reincluído** de propósito: já existe acesso real (Clientes, Fila de Aprovação, Leads Reprovados) e um item desabilitado só duplicaria e confundiria. Para reverter, basta adicionar a entrada em `nav.mjs` e em `NAV_LABELS`.
- "Configurações" virou **"Configurações gerais"** para não se confundir com "Configurações do CRM".
- Correções de CSS achadas na verificação visual: (a) no celular a barra superior ocupava um terço da tela (a grade repartia o espaço livre) — linhas `auto minmax(0, 1fr)`; (b) com o grupo Gestão aberto o rodapé cobria os últimos itens — só a navegação rola, rodapé fixo, e no modo recolhido a rolagem sai para as dicas não serem cortadas; (c) o selo "Em desenvolvimento" quebrava de forma irregular — agora fica sempre abaixo do nome.

## 3. Decisões arquiteturais aprovadas

- Um cliente pode ter várias negociações, inclusive no mesmo funil; o card passa a representar a **negociação**.
- O ciclo comercial pertence à **negociação**, não ao `status` legado do cliente (a máquina de estados dos 13 status e o Não Contatar terminal são preservados).
- **Supabase** é a base oficial das entidades novas, mantendo o adaptador local de desenvolvimento.
- **Nenhuma migração de dados** sem autorização específica; **nenhuma migration é aplicada** sem o proprietário.
- Interface em português do Brasil (regras de idioma na seção 2.3).
- `localStorage` **só** para preferência visual do menu, com exceção auditada no guarda estático.
- Módulos antigos só saem depois de existir substituição funcional validada.
- Não remapear `#/crm` em silêncio para um Dashboard inexistente: `#/crm` segue como alias da lista de Clientes; o Dashboard Comercial é uma página EM DESENVOLVIMENTO própria, sem métricas fictícias.
- Página futura = rota real + aviso "EM DESENVOLVIMENTO" + zero dados simulados + zero chamadas de API. Área sem página = item desabilitado, sem rota.
- O menu esconde o que a permissão não cobre, mas **não é controle de acesso**.

**Fases planejadas** (cada uma com aprovação humana antes da seguinte): 0 checkpoint ✔ → 1 auditoria ✔ → **2A menu, idioma, compatibilidade, responsividade ✔ (local, sem commit)** → 2B serviços, nichos e cores, origens dos leads → 3 clientes PF/PJ e contatos → 4 funis no Supabase e Quadro de Negociações → 5 edição comercial, propostas, perdas, fechamentos → 6 Dashboard Comercial e metas → 7 origens e integrações futuras → 8 auditoria final.

## 4. O que está REALMENTE implementado × o que é EM DESENVOLVIMENTO

**Implementado e testado**
- Menu lateral hierárquico e recolhível, menu do celular, preferência visual, catálogo de idioma e teste de vocabulário, rotas novas e antigas, página "EM DESENVOLVIMENTO" reutilizável.
- Todas as telas funcionais anteriores (Visão Geral, Clientes/CRM com ficha e edição, Funis, Fila de Aprovação, Nova Prospecção, Histórico, Leads Reprovados, Exclusões Permanentes, Central de Agentes), agora com o vocabulário em português.

**EM DESENVOLVIMENTO (sem funcionalidade, sem dado)**
- Páginas com rota: Dashboard Comercial, Metas e Indicadores, Configurações do CRM, Serviços, Nichos e Cores, Gestão de Funis e Etapas, Origens dos Leads.
- Referências sem rota (itens desabilitados): Agenda, Conversas, Reuniões, Propostas, Relatórios, Configurações gerais.
- Tudo do CRM 5.0 além do menu: Cliente PF/PJ, contatos, Negociação, Quadro de Negociações, propostas, perdas, fechamentos, metas, integrações.

## 5. Testes executados

**Suíte completa (2026-10-11, estado final da Fase 2A):** 2164 testes — **2162 passam, 0 falham, 2 pulados** (os mesmos 2 de antes). `git diff --check` limpo (só os avisos habituais de fim de linha). Os 10 arquivos `data/*.json` locais tiveram o **mesmo SHA-256 antes e depois**. Os testes não executam Claude real, não iniciam prospecção e não alteram dados.

**Direcionados (todos verdes):** `dashboard-sidebar` 19 (menu, permissões, texto × seta, teclado, celular, preferência, falha do armazenamento, rotas), `dashboard-menu-shell` 10 (menu no painel inteiro: CRM → Dashboard, `#/crm` legado, links antigos e Voltar/Avançar, páginas futuras, celular com ESC e painel lateral, permissões, proteção de rascunho ao trocar de menu), `dashboard-vocabulary` 5, `dashboard-static-guards` 10, `dashboard-shell` 24, `dashboard-central` 6, `dashboard-crm-view` 44, `dashboard-crm-ux` 24, `dashboard-crm-edit` 19, `dashboard-approvals-ux` 14, `dashboard-rejected-ux` 20, `dashboard-history-ux` 20, `dashboard-prospecting-ux` 38, `dashboard-fullstack` 10 (contra a API real, em diretório temporário), `crm-e2e` 4, `crm-commercial-flow` 8.

## 6. Validação visual: feita × pendente

**Feita** (navegador embutido do app, com uma página de demonstração **fora do repositório**, sem login e sem dados reais, usando o menu e o CSS reais): desktop expandido; desktop recolhido com a dica do nome; celular — barra superior, gaveta aberta, ESC fecha e devolve o foco ao botão; grupo Gestão com a navegação rolando e o rodapé fixo; item ativo destacado; selo "Em desenvolvimento".

**Pendente — no Dashboard real, com login** (`npm start`):
1. Menu com as telas reais por trás: CRM → Dashboard Comercial; `#/crm` e `#/crm/clientes`; ficha de registro aberta por link direto (Fila de Aprovação, Visão Geral, Funis); Voltar/Avançar; ESC e X do painel.
2. Proteção de rascunho ao trocar de item do menu (Novo registro com texto digitado).
3. A preferência recolhido/expandido depois de recarregar a página (provada em teste; falta ver no navegador real).
4. Larguras intermediárias (≈ 900–1100 px), celular de verdade (toque), zoom de 200%, Firefox e Safari.
5. Leitura por leitor de tela dos itens desabilitados e das setas.
6. Os itens de validação da seção 2.1 que já estavam pendentes (CRM, edição, Nova Prospecção, Histórico, Leads Reprovados).
7. Iniciar uma prospecção **real** usa o Claude Code local e consome limite de uso: só com decisão consciente.

## 7. Limites e riscos conhecidos

- Restaurar o endereço depende de `history.state`; provado no DOM de teste, falta confirmar em navegador real.
- O menu usa `inert` e `scrollbar-color`: navegadores muito antigos degradam (o menu do celular fechado poderia ficar alcançável pelo teclado).
- O catálogo é central só para o menu, títulos, status, papéis e glossário; os demais textos continuam nas telas e dependem do teste de vocabulário para não regredir. Texto em inglês **já gravado** em registros antigos (fora "Approval Queue" e "prospect" no histórico) aparece como foi salvo.
- Os ícones vêm de uma sprite SVG dentro de `index.html` (a regra estática proíbe `http://` no código). Ícone ausente = espaço vazio, nunca texto.
- "Leads" não existe como item de menu (decisão registrada na seção 2.3); Relatórios e Configurações gerais são visíveis a qualquer conta, como no menu antigo.
- "Novo registro" ainda é uma página (não uma gaveta). Visão Geral e Funis não assinam `crm:changed`. O CRM carrega **todos** os registros de uma vez e filtra no navegador (a API não pagina).
- CRM-API sem versionamento: o último a salvar prevalece (seção 2.1).
- `docs/development/UX-4-CHECKPOINT.md` é o nome histórico deste arquivo; o conteúdo agora cobre também o CRM 5.0.

## 8. Arquivos da Fase 2A (candidatos ao commit — 48)

Staging **explícito**, um caminho por vez; nunca `git add .` nem `git add -A`.

**Novos (8):** `dashboard/nav.mjs`, `dashboard/preferences.mjs`, `dashboard/i18n/pt-BR.mjs`, `dashboard/ui/sidebar.mjs`, `dashboard/views/comingSoon.mjs`, `tests/server/dashboard-sidebar.test.js`, `tests/server/dashboard-menu-shell.test.js`, `tests/server/dashboard-vocabulary.test.js`.

**Dashboard modificados (19):** `app.mjs`, `crm-model.mjs`, `format.mjs`, `index.html`, `main.mjs`, `router.mjs`, `styles.css`, `ui/routedDrawer.mjs`, `views/agents.mjs`, `views/approvals.mjs`, `views/crm.mjs`, `views/funnels.mjs`, `views/jobDetails.mjs`, `views/leadEnrichmentPanel.mjs`, `views/leadProfile.mjs`, `views/overview.mjs`, `views/prospecting.mjs`, `views/prospectingHistory.mjs`, `views/rejectedLeads.mjs`.

**Testes modificados (20), em `tests/server/`:** `crm-commercial-flow`, `crm-e2e`, `dashboard-approvals-refine`, `dashboard-approvals-ux`, `dashboard-central`, `dashboard-crm-edit`, `dashboard-crm-model`, `dashboard-crm-ux`, `dashboard-crm-view`, `dashboard-fullstack`, `dashboard-history-ux`, `dashboard-leads`, `dashboard-overview`, `dashboard-promotion`, `dashboard-prospecting-job`, `dashboard-prospecting-ux`, `dashboard-rejected-ux`, `dashboard-shell`, `dashboard-static-guards`, `lead-enrichment-legacy` (todos terminam em `.test.js`).

**Documentação (1):** `docs/development/UX-4-CHECKPOINT.md` (este arquivo).

**Fora do escopo, NÃO entram:** `.claude/` (inclui `launch.json`), `docs/security/` (modelo de ameaças à parte, ainda não revisado para publicação), `.env`, `data/*.json`, `backups/`, `tmp/`, `node_modules/`.

## 9. Próxima fase: 2B — Serviços, Nichos e Cores e Origens dos Leads

**Não iniciada. Só com autorização.** Hoje `#/crm/configuracoes/servicos`, `…/nichos` e `…/origens` são páginas EM DESENVOLVIMENTO; a 2B as substitui por cadastros reais (Gestão de Funis e Etapas continua EM DESENVOLVIMENTO até a Fase 4).

Pontos a decidir **antes** de codar (nenhum está decidido): onde guardar os catálogos (Supabase com adaptador local, conforme a decisão aprovada; qualquer migration só aplicada pelo proprietário); quem administra (permissão nova ou `ADMIN`); como as **cores** de nicho funcionam sob a política de segurança de conteúdo (`style-src 'self'` — sem estilo inline: será uma paleta fixa de classes/tokens, não uma cor livre); lista inicial de origens (e a relação com integrações futuras: Meta Ads, Google Ads, WhatsApp); e o que fazer com os campos livres atuais de nicho/origem nos registros existentes (**sem migração de dados sem autorização específica**).

## 10. Como retomar amanhã, sem reiniciar nada

1. Na pasta do projeto: `git status --short`, `git log --oneline -3` e `git remote -v`. Esperado se o commit da 2A ainda não foi feito: `HEAD` em `04183f6`, 48 arquivos candidatos (seção 8) como modificados/novos e, fora do escopo, `.claude/` e `docs/security/` não versionados. **Não refaça nada da 2A** — o código já está no diretório de trabalho. Se houver um commit da 2A depois de `04183f6`, a 2A já foi publicada: pule para o passo 4.
2. Confira o estado verde, sem reimplementar: mova para fora do repositório `data/prospecting-batches.json`, registre o SHA-256 de `data/*.json`, rode `npm test`, restaure o arquivo e compare os hashes. Esperado: 2164 testes, 2162 passam, 0 falham, 2 pulados; hashes idênticos; `git diff --check` limpo.
3. **Só com autorização:** commit da 2A com `git add` explícito dos 48 caminhos da seção 8 (conferindo antes `git diff --cached --name-only`), depois push normal (sem `--force`).
4. Validação visual real (seção 6, itens 1–6): `npm start`, abrir o painel e entrar com a conta de teste do projeto. Se um servidor antigo ainda estiver rodando, reinicie-o — processos iniciados antes de uma mudança respondem com a versão antiga.
5. Só depois, e **só com autorização expressa**, abrir a Fase 2B pela lista de decisões da seção 9.

## 11. Restrições que continuam valendo

- Preservar o backend comercial e as regras da Prospecção 3.0.2 (aprovação humana, promoção explícita ao CRM, Não Contatar, exclusões permanentes, deduplicação, histórico, permissões).
- Nunca versionar `.env`, credenciais, `data/*.json`, backups, `tmp/`, `node_modules/`, `.claude/launch.json` nem registros reais de leads. Nunca usar `git add .` ou `git add -A`. Nunca `push --force`.
- Testes não executam Claude real, não iniciam prospecção e não alteram dados históricos.
- Nenhuma migration é aplicada, nenhuma dependência é instalada e nenhum dado é migrado sem autorização do proprietário.
- Commit e push só depois de testes, varredura de dados sensíveis e `git diff --check`, e só com autorização.
