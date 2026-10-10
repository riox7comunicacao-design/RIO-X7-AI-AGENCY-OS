# UX/UI 4.0 — checkpoint de desenvolvimento

> **Isto é um CHECKPOINT (`wip`), não a declaração de que a UX/UI 4.0.4 está concluída.** Serve para retomar o trabalho com segurança depois de uma pausa.
> Não contém senhas, tokens, dados pessoais nem caminhos locais privados.

## 1. Ponto de partida

- Último commit estável anterior a este checkpoint: `9eddf79` — `feat(prospecting): add on-demand enrichment and commercial integrity (3.0.1–3.0.2)`.
- Branch: `main`. Remoto esperado: `origin` → repositório `RIO-X7-AI-AGENCY-OS` da organização no GitHub.
- Backend comercial (Prospecção 3.0.2): **intocado** em todas as fases abaixo. Só `dashboard/` e `tests/` mudaram.

## 2. O que foi feito

Todas as telas seguem o mesmo padrão: lista com busca/ordenação/paginação e linha inteira clicável, gaveta (drawer) com URL, confirmação humana para ações, avisos (toasts), foco e ESC/X/Voltar/Avançar, atualização sem recarregar.

| Fase | Entrega | Estado |
|---|---|---|
| 4.0 | Componentes globais (`dashboard/ui/`: camadas modal/drawer/confirmação, avisos, barramento de dados, poller, componentes visuais) e a Approval Queue como tela de referência | Concluída e validada no navegador |
| 4.0.1 | Refinamento visual da Approval Queue (resumo sem duplicidade, cartão do responsável, gaveta com rodapé fixo, linha clicável) | Concluída e validada no navegador |
| 4.0.2 | Leads Reprovados (lista, gaveta com decisão/motivo/data/responsável, RECONSIDERAR com confirmação, URL do lead) | Concluída |
| 4.0.3 | Leads Reprovados: barra de filtros em duas linhas e estado vazio que orienta para o Histórico. Histórico de prospecções modernizado (lista, gaveta com Resumo/Candidatos/Resultados/Auditoria, atualização em segundo plano só com job em andamento, REFAZER com confirmação). Controlador compartilhado `ui/routedDrawer.mjs` | Concluída |
| 4.0.4 | Nova Prospecção: formulário em seções com validação, contrato briefing (sem `maxCandidates`) + job (`briefId` + `maxCandidates`), confirmação antes de iniciar/refazer/cancelar briefing, etapas reais sem percentual, acompanhamento moderado que para sozinho, gaveta da execução com URL, detalhe compartilhado com o Histórico (`views/jobDetails.mjs`) | **Implementada e testada; falta a validação visual no dashboard real e a aprovação** |

Decisões de produto registradas no código:
- "Não validado" e "descartado" nunca são chamados de "rejeitado por uma pessoa" (só um lead da Approval Queue pode ser rejeitado por humano).
- Candidatos descartados durante a prospecção vivem só no job (Histórico); Leads Reprovados lista só o que passou pela Approval Queue e saiu dela. Uma auditoria somente-leitura confirmou que a lista vazia de Leads Reprovados era legítima.
- Nenhuma tela inicia pesquisa, aprova, rejeita, reconsidera ou promove sozinha.

## 3. Arquivos e módulos

Código novo: `dashboard/ui/` (overlays, toasts, dataBus, components, routedDrawer, index) e `dashboard/views/jobDetails.mjs`.

Código alterado: `dashboard/main.mjs`, `dashboard/router.mjs`, `dashboard/styles.css`, `dashboard/views/approvals.mjs` (reescrito), `rejectedLeads.mjs` (reescrito), `prospectingHistory.mjs` (reescrito), `prospecting.mjs` (reescrito), `leadEnrichmentPanel.mjs` (`pause()`).

Testes novos: `dashboard-ui-overlays`, `dashboard-approvals-ux`, `dashboard-approvals-refine`, `dashboard-rejected-ux`, `dashboard-history-ux`, `dashboard-prospecting-ux`. Testes ajustados por mudanças intencionais de comportamento: `dashboard-crm-model`, `dashboard-leads`, `dashboard-promotion`, `dashboard-enrichment`, `dashboard-enrichment-site`, `dashboard-prospecting-job`, `dashboard-job-start-e2e`, `dashboard-static-guards` (lista de módulos) e o helper `tests/helpers/fakeDom.js`.

## 4. Resultados dos testes (suíte completa)

2070 testes: **2068 passam, 0 falham, 2 pulados** (os 2 pulados já existiam). `git diff --check` limpo. Os 10 arquivos `data/*.json` locais tiveram o mesmo SHA-256 antes e depois da suíte.

## 5. Pendências de validação visual (no dashboard real, com login)

1. Nova Prospecção (`#/prospeccao`): formulário em seções, validação, rascunho ao trocar de módulo, modal de confirmação (cancelar não faz nada), cartão de execução com etapas, gaveta (ESC/X/Voltar/Avançar/link direto), celular.
   - Iniciar uma prospecção **real** usa o Claude Code local e consome limite de uso: só fazer com decisão consciente.
2. Histórico (`#/prospeccao/historico`) com os jobs reais: indicadores, candidatos por grupo, atualização em segundo plano.
3. Leads Reprovados: barra de filtros em duas linhas e estado vazio.
4. Tabela do Histórico entre 761 e ~900 px de largura (rola na horizontal dentro do cartão).

## 6. Próxima tarefa exata

1. Validar a UX/UI 4.0.4 no dashboard real (item 5.1) e corrigir o que aparecer.
2. Depois disso, em sessões separadas e com autorização: migrar a Approval Queue e Leads Reprovados para `ui/routedDrawer.mjs` e extrair um módulo compartilhado `leadParts` (cartão do responsável, fontes, histórico, contatos, hoje duplicados entre `approvals.mjs` e `rejectedLeads.mjs`), usando os testes existentes como rede de segurança.
3. Em seguida, expandir o padrão: CRM, Visão Geral, Funis, Exclusões Permanentes, Central de Agentes. Módulos "em desenvolvimento" só recebem os componentes visuais e o padrão de navegação, sem backend inventado.

## 7. Como retomar depois de reiniciar o computador

1. Abrir o terminal na pasta do projeto e conferir: `git status`, `git log --oneline -3`, `git remote -v` e que `main` está igual a `origin/main`.
2. Instalar dependências se necessário (`npm install`); o arquivo `.env` local não é versionado e deve continuar existindo.
3. Rodar a suíte: antes, mover para fora do repositório o arquivo local `data/prospecting-batches.json` (a suíte pode tocá-lo), registrar o SHA-256 de `data/*.json`, rodar `npm test`, restaurar o arquivo e conferir que os hashes não mudaram.
4. Para ver as telas: `npm start`, abrir o painel e entrar com a conta de teste do projeto.
5. Se um servidor antigo ainda estiver rodando, reiniciá-lo: processos iniciados antes de uma mudança de contrato respondem com a versão antiga.

## 8. Restrições que continuam valendo

- Preservar o backend comercial e as regras da Prospecção 3.0.2 (aprovação humana, promoção explícita ao CRM, DNC, exclusões permanentes, deduplicação, histórico, permissões).
- Nunca versionar `.env`, credenciais, `data/*.json`, backups, `tmp/`, `node_modules/`, `.claude/launch.json` nem registros reais de leads. Nunca usar `git add .` ou `git add -A`.
- Testes não executam Claude real, não iniciam prospecção e não alteram dados históricos.
- Commit e push só depois de testes, varredura de dados sensíveis e `git diff --check`.
