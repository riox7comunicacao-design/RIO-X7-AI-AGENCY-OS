# UX/UI 4.0 — checkpoint de desenvolvimento (pré-CRM 5.0)

> **Isto é um CHECKPOINT (`wip`), não a declaração de que a UX/UI 4.0 está concluída nem de que o CRM 5.0 existe.** Serve para retomar o trabalho com segurança depois de uma pausa.
> **A modernização do CRM Comercial 5.0 AINDA NÃO FOI IMPLEMENTADA.** Este checkpoint cobre só a UX/UI 4.0.x (telas existentes modernizadas) e registra o resultado da auditoria que prepara o 5.0 (seção 7).
> Não contém senhas, tokens, dados pessoais nem caminhos locais privados.
> Última atualização: 2026-10-11.

## 1. Ponto de partida

- Commit anterior a este checkpoint: `3a5a482` — `wip(ux): checkpoint dashboard modernization 4.0` (já publicado em `origin/main`). Antes dele: `9eddf79` — `feat(prospecting): add on-demand enrichment and commercial integrity (3.0.1–3.0.2)`.
- Branch: `main`. Remoto esperado: `origin` → repositório `RIO-X7-AI-AGENCY-OS` da organização no GitHub.
- Backend comercial (Prospecção 3.0.2, CRM, Funis, Fila de Aprovação): **intocado** em todas as fases abaixo. Só `dashboard/` e `tests/` mudaram — nenhum arquivo de `src/`, `supabase/`, `scripts/` nem `package*.json` foi alterado, nenhuma dependência foi instalada e nenhuma migration foi criada ou aplicada.

## 2. O que foi feito

Todas as telas seguem o mesmo padrão: lista com busca/ordenação/paginação e linha inteira clicável, gaveta (painel lateral) com URL, confirmação humana para ações, avisos (toasts), foco e ESC/X/Voltar/Avançar, atualização sem recarregar.

| Fase | Entrega | Estado |
|---|---|---|
| 4.0 | Componentes globais (`dashboard/ui/`: camadas modal/gaveta/confirmação, avisos, barramento de dados, acompanhador, componentes visuais) e a Approval Queue como tela de referência | Concluída e validada no navegador |
| 4.0.1 | Refinamento visual da Approval Queue | Concluída e validada no navegador |
| 4.0.2 | Leads Reprovados (lista, gaveta, RECONSIDERAR com confirmação, URL do lead) | Concluída |
| 4.0.3 | Leads Reprovados: filtros em duas linhas e estado vazio. Histórico de prospecções (lista, gaveta com Resumo/Candidatos/Resultados/Auditoria, atualização em segundo plano só com job em andamento, REFAZER com confirmação). Controlador compartilhado `ui/routedDrawer.mjs` | Concluída |
| 4.0.4 | Nova Prospecção: contrato briefing (sem `maxCandidates`) + job (`briefId` + `maxCandidates`), confirmações, etapas reais sem percentual, gaveta da execução com URL | Concluída |
| 4.0.5 | Nova Prospecção em **3 abas** (Nova pesquisa, Briefings salvos, Em andamento) com **assistente de 3 etapas**; valores conservadores (3 leads / 10 candidatos); briefings salvos com busca, filtro, ordem e paginação | **Validada no navegador** (abas e lista de briefings aprovadas) |
| 4.0.5 (refinamento) | Formulário centralizado e responsivo (teto de 820 px); proteção do rascunho ao atualizar/fechar a aba (`beforeunload`); localidades padronizadas **só na exibição** (`formatLocation`: "petrópolis/rj" → "Petrópolis/RJ"; o valor guardado e o enviado não mudam); "Em andamento" mostra **só jobs realmente ativos** (um briefing antigo "Pesquisando" não é prova de job; o resultado de uma execução que acabou na sessão aparece à parte e pode ser fechado) | Implementada e testada; sem validação visual própria |
| 4.0.6.1 + 4.0.6.2 | **CRM**: lista persistente (busca, filtros, **ordenação**, **paginação** de 20 por página, linha inteira clicável, cartões em telas pequenas, botão Atualizar) e **ficha em gaveta** `#/crm/registro/<id>` com abas (Resumo, Contato e presença, Comercial, Histórico) somente leitura; atualização por evento `crm:changed` e botão Atualizar, **sem polling**; contexto (busca, filtros, página, rolagem) preservado ao abrir a ficha e ao trocar de módulo. Ações de escrita (editar, mudar status, Não contatar, excluir) continuam acessíveis dentro da gaveta, com as mesmas permissões | Implementada e testada; **falta validação visual** |
| 4.0.6.3 | **Edição segura do CRM**: os 31 campos em abas (Resumo, Contato e presença, Comercial) com obrigatório claro, validação antes de enviar sem perder o digitado, estado de salvamento, sucesso só depois da API, só os campos alterados são enviados, Salvar sempre explícito (sem salvamento automático). **Proteção de alterações não salvas** em ESC, X, fundo, Voltar/Avançar, outro registro/endereço, troca de módulo e atualizar/fechar a aba; durante o salvamento nada fecha. A página "Novo registro" tem a mesma proteção. Rascunho preservado diante de evento, resposta tardia ou bloqueio do registro por baixo | Implementada e testada; **falta validação visual** |

Decisões técnicas registradas no código (importantes para o 5.0):
- "Não validado" e "descartado" nunca são chamados de "rejeitado por uma pessoa". Nenhuma tela inicia pesquisa, aprova, rejeita, reconsidera ou promove sozinha.
- **Voltar do navegador não pode ser cancelado**: o endereço já mudou quando o aviso chega. Por isso, com alterações não salvas a tela pergunta e, se a pessoa escolher "Continuar editando", `navigation.restore(hash)` leva o endereço de volta **sem empilhar entradas** (usa `history.go(±1)` quando a entrada vizinha é a certa; senão troca a entrada). A numeração das entradas fica em `history.state` e sobrevive a recarregar a página.
- O `beforeunload` só **pede** o aviso nativo; o navegador decide se e como mostrá-lo. Vários guardas de saída convivem (CRM e Nova Prospecção): basta um responder "há alteração".
- **A CRM-API não tem versionamento** na interface: duas pessoas que salvam o mesmo campo ao mesmo tempo → o último prevalece. A tela só reduz o risco enviando apenas o que foi alterado e **não promete** proteção contra isso. (A tabela `crm_records` tem coluna `version` mantida por gatilho, mas nenhuma camada a usa ainda.)
- O botão de descarte é "Descartar alterações" em todo o painel (antes "Descartar"), e o gerenciador de camadas devolve o foco à linha de origem quando uma gaveta fecha com uma confirmação por cima.
- A lista do CRM, a Approval Queue, o Histórico, Leads Reprovados e a Nova Prospecção são **persistentes** (`show/hide`): estado e rolagem sobrevivem à troca de módulo.

## 3. Arquivos e módulos (candidatos a este checkpoint)

Código (`dashboard/`, 10 arquivos modificados): `crm-model.mjs` (ordenação, abas da ficha), `format.mjs` (`formatLocation`), `main.mjs` (CRM persistente, pergunta ao sair do CRM com edição), `router.mjs` (`restore`, vários guardas, numeração do histórico), `styles.css`, `ui/overlays.mjs`, `ui/routedDrawer.mjs`, `views/crm.mjs` (reescrito: lista persistente, gaveta, edição em abas, proteção), `views/jobDetails.mjs`, `views/prospecting.mjs` (reescrito na 4.0.5).

Testes novos: `dashboard-crm-ux.test.js` (24) e `dashboard-crm-edit.test.js` (19).
Testes ajustados por mudanças intencionais de comportamento (ficha-página → gaveta, abas, "Descartar alterações", "Em andamento" só com jobs ativos): `crm-commercial-flow`, `crm-e2e`, `dashboard-approvals-ux`, `dashboard-crm-view`, `dashboard-fullstack`, `dashboard-job-start-e2e`, `dashboard-promotion`, `dashboard-prospecting-job`, `dashboard-prospecting-ux`, `dashboard-rejected-ux`, `dashboard-shell`, `dashboard-ui-overlays` e o helper `tests/helpers/fakeDom.js` (`history.state`, `beforeunload`).

Este documento (`docs/development/UX-4-CHECKPOINT.md`) também entra.

## 4. Resultados dos testes (suíte completa)

2129 testes: **2127 passam, 0 falham, 2 pulados** (os mesmos 2 que já existiam). `git diff --check` limpo. Os 10 arquivos `data/*.json` locais tiveram o mesmo SHA-256 antes e depois da suíte.

Direcionados (todos verdes): `dashboard-crm-edit` 19, `dashboard-crm-ux` 24, `dashboard-crm-view` 44, `dashboard-crm-model` 14, `dashboard-shell` 24, `dashboard-fullstack` 10 (contra a API real, em diretório temporário), `dashboard-promotion` 17, `dashboard-prospecting-ux` 38, `dashboard-prospecting-job` 18, `dashboard-job-start-e2e` 2, `dashboard-history-ux` 20, `dashboard-rejected-ux` 20, `dashboard-approvals-ux` 14, `dashboard-ui-overlays` 11, `dashboard-static-guards` 9, `crm-commercial-flow` 8, `crm-e2e` 4.

## 5. Pendências de validação visual (no dashboard real, com login)

1. **CRM** (`#/crm`): lista (busca, filtros, ordenação, paginação, cartões em tela estreita); ficha em gaveta (abas, ESC/X/Voltar/Avançar, link direto, foco na linha); edição em abas e a proteção de alterações (Voltar, ESC, X, fundo, menu, atualizar a aba com F5 — o aviso nativo depende do navegador); "Novo registro" com texto digitado.
2. **Nova Prospecção** (refinamento): formulário centralizado, aviso ao atualizar com rascunho, localidades padronizadas, "Em andamento" vazio quando não há job ativo.
3. Histórico e Leads Reprovados (itens das fases anteriores ainda sem conferência no navegador real).
4. Iniciar uma prospecção **real** usa o Claude Code local e consome limite de uso: só com decisão consciente.

## 6. Limites conhecidos

- Restaurar o endereço depende de `history.state`; está provado no DOM de teste, falta confirmar em navegador real.
- "Novo registro" ainda é uma página (não uma gaveta); migrar fica para o CRM 5.0.
- Visão Geral e Funis não assinam `crm:changed`; recarregam ao entrar na tela.
- O CRM carrega **todos** os registros de uma vez e filtra no navegador (a API não pagina).
- Textos da interface ainda estão espalhados pelas telas e há termos em inglês (ver seção 7); não existe catálogo central.

## 7. CRM Comercial 5.0 — NÃO implementado; resultado da auditoria (Fase 1)

Nada do CRM 5.0 está no código. A auditoria (somente leitura, sem dados sensíveis) concluiu:

**Estado do armazenamento**
- CRM (`crm_records`): **Supabase** é a fonte oficial desde 2026-09-28 (`REPOSITORY_MODE=supabase`); a política de dados registra 0 registros nessa data (reconfirmar antes de qualquer migração). `data/crm.json` é só a implementação de arquivo para desenvolvimento.
- Funis, etapas e cards: **apenas arquivo JSON** (`data/funnels.json`, inexistente neste computador). As migrations de funis e cards existem e estão testadas, mas **marcadas como não aplicadas**, e não há adaptador Supabase para funis. Um card (arquivo) referencia um registro (Supabase) sem chave estrangeira.
- Fila de aprovação e Prospecção: arquivos JSON locais.

**Lacunas em relação ao 5.0**: registro plano (sem Cliente PF/PJ, contatos nem Negociação), campos livres onde o novo modelo exige catálogo (nicho, origem, temperatura, responsável), datas como texto livre, sem proposta/fechamento/pagamento/perda/atividade/meta, sem Dashboard Comercial, sem interface de administração de funis, menu lateral plano e sem catálogo central de textos. O papel `COMMERCIAL_CLOSER` não tem `WRITE:CRM`.

**Decisões já aprovadas pelo proprietário**
- Um cliente pode ter várias negociações, inclusive no mesmo funil; o card passa a representar a **negociação**.
- O ciclo comercial pertence à **negociação**, não ao `status` legado do cliente (a máquina de estados dos 13 status e o Não Contatar terminal são preservados).
- **Supabase** é a base oficial das entidades novas, mantendo o adaptador local de desenvolvimento.
- **Nenhuma migração de dados** sem autorização específica; nenhuma migration é aplicada sem o proprietário.
- Interface em português do Brasil; mantêm-se LEAD, Dashboard, MQL, Status, Follow-up, Raio-X e Briefing; "Google Meet" mantém o nome próprio.
- O menu lateral poderá usar `localStorage` **exclusivamente** para preferências visuais, com **exceção auditada** nos guardas estáticos no momento da implementação (hoje eles proíbem `localStorage`).
- Módulos antigos só saem depois de existir substituição funcional validada.

**Fases planejadas** (cada uma com aprovação humana antes da seguinte): 0 checkpoint (este documento) → 2A menu lateral recolhível e catálogo de textos em português (só interface) → 2B serviços, nichos e cores, origens → 3 clientes PF/PJ e contatos → 4 funis no Supabase e Quadro de Negociações → 5 edição comercial, propostas, perdas, fechamentos → 6 Dashboard Comercial e metas → 7 origens e integrações futuras → 8 auditoria final.

**Decisões ainda em aberto** (antes da Fase 3): permissões novas e o que o `COMMERCIAL_CLOSER` pode fazer; responsável como usuário (não texto); necessidade e proteção de CPF; dinheiro em centavos e as fórmulas de conversão, ticket médio, tempo de fechamento e "sem movimentação"; correspondência dos status antigos com as etapas; uso da coluna `version` para bloqueio otimista.

## 8. Próxima tarefa exata

1. Revisar e autorizar o commit deste checkpoint (a lista de arquivos está na seção 3; nada é adicionado com `git add .`).
2. Depois do commit, e só com autorização: **Fase 2A** do CRM 5.0 — catálogo de textos em português + teste de vocabulário e menu lateral recolhível/hierárquico (somente interface; sem backend, sem migration, sem nova entidade).
3. Em paralelo e sem código: validar no navegador real os itens da seção 5.

## 9. Como retomar depois de reiniciar o computador

1. Abrir o terminal na pasta do projeto e conferir: `git status`, `git log --oneline -3`, `git remote -v` e se `main` está igual a `origin/main`.
2. Instalar dependências se necessário (`npm install`); o arquivo `.env` local não é versionado e deve continuar existindo.
3. Rodar a suíte: antes, mover para fora do repositório o arquivo local `data/prospecting-batches.json` (a suíte pode tocá-lo), registrar o SHA-256 de `data/*.json`, rodar `npm test`, restaurar o arquivo e conferir que os hashes não mudaram.
4. Para ver as telas: `npm start`, abrir o painel e entrar com a conta de teste do projeto.
5. Se um servidor antigo ainda estiver rodando, reiniciá-lo: processos iniciados antes de uma mudança de contrato respondem com a versão antiga.

## 10. Restrições que continuam valendo

- Preservar o backend comercial e as regras da Prospecção 3.0.2 (aprovação humana, promoção explícita ao CRM, Não Contatar, exclusões permanentes, deduplicação, histórico, permissões).
- Nunca versionar `.env`, credenciais, `data/*.json`, backups, `tmp/`, `node_modules/`, `.claude/launch.json` nem registros reais de leads. Nunca usar `git add .` ou `git add -A`.
- `docs/security/0001-authorization-threat-model.md` está **fora do escopo** deste checkpoint (documento à parte, ainda não revisado para publicação).
- Testes não executam Claude real, não iniciam prospecção e não alteram dados históricos.
- Commit e push só depois de testes, varredura de dados sensíveis e `git diff --check`, e só com autorização.
