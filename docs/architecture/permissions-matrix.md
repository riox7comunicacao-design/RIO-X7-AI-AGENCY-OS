# Matriz de Permissões por Especialista

**Categorias (consolidadas em 0008.2):** `READ`, `ANALYZE`, `PROPOSE`, `WRITE`, `EXECUTE`, `SEND`, `PUBLISH`, `DELETE`, `APPROVE`.

A Auditoria 0008.1 identificou que a versão anterior desta matriz usava `WRITE` para descrever o que, na prática, eram **sugestões** (ex.: "WRITE: Histórico/observações sugeridas") — isso é impreciso e pode ser lido como permissão de escrita real. Esta versão corrige **apenas a documentação**: `PROPOSE` (produzir uma sugestão/rascunho que um humano precisa confirmar) e `WRITE` (gravar de fato, sem revisão humana antes) agora são categorias distintas. Nenhum código foi alterado por essa correção — nenhum especialista tinha, de fato, permissão de escrita real hoje; a mudança é só deixar isso inequívoco na tabela.

`ANALYZE` (processar/interpretar informação já disponível, sem produzir uma ação ou sugestão de mudança) também passa a ser distinto de `PROPOSE` (que já implica uma sugestão de ação/mudança concreta).

Nenhuma permissão é concedida por padrão — cada célula reflete o que já está definido/implementado, o que é recomendação, ou o que é decisão pendente. Ver [human-approval-model.md](./human-approval-model.md) para a lista completa de ações que sempre exigem aprovação humana, independentemente do que esta tabela diz.

**Regra geral para V1 (consolidada em 0008.2):** IA pode `ANALYZE`; IA pode `PROPOSE`; IA pode `EXECUTE` apenas ações internas/preparatórias já explicitamente autorizadas; ações sensíveis (`SEND`, `PUBLISH`, `DELETE`, e `WRITE` em dados operacionais de terceiros) permanecem protegidas por aprovação humana, sempre.

**Nota:** "CRM/Sales Ops" e "Follow-up" não têm linha própria nesta tabela — deixaram de ser tratados como especialistas nesta consolidação (ver [specialist-matrix.md](./specialist-matrix.md), seção "CRM/Sales Ops e Follow-up — não são especialistas"). CRM/Sales Ops é infraestrutura/camada de serviço, consultada pelos demais especialistas conforme a permissão de cada um; Follow-up é capacidade do SDR.

**Nota sobre CRM Services (consolidação 0008.3):** CRM Services (a camada de serviço que persiste dados, valida regras, executa movimentações já autorizadas e mantém histórico/auditoria — ver [0008](../decisions/0008-specialist-team-architecture.md), "Camadas do sistema") não é uma linha de especialista nesta tabela pelo mesmo motivo que CRM/Sales Ops não é: é infraestrutura, não um agente com objetivos próprios. Sua "permissão" é diferente em natureza da de um especialista — ele tem `WRITE`/`EXECUTE` reais sobre dados operacionais, mas **somente para ações já autorizadas** (por um humano, ou por uma regra determinística já aprovada), nunca por iniciativa própria de "decidir" fazer algo. É a única camada do sistema com `WRITE` real sobre CRM/dados operacionais — e mesmo assim, condicionada, nunca livre.

**Nota sobre identidade e `APPROVE` (0008.4):** o `APPROVE` desta tabela sempre pressupõe um `USER` humano autorizado, nunca um especialista de IA — nunca um role sozinho (`role = COMMERCIAL_CLOSER` não implica `APPROVE` automático em nenhum domínio) e nunca um nome em texto livre. O modelo completo de `USER`/`role`/`permission`/`APPROVAL`/`approvalType` está em [0009-identity-roles-and-authorization-model.md](../decisions/0009-identity-roles-and-authorization-model.md) — puramente conceitual, nada implementado, `approvalQueue.js` não foi alterado.

| Especialista | READ | ANALYZE | PROPOSE | WRITE | EXECUTE | SEND | PUBLISH | DELETE | APPROVE |
|---|---|---|---|---|---|---|---|---|---|
| **COO/Orquestrador** | Saídas de especialistas (nunca fonte bruta diretamente) | Interpretação do objetivo da solicitação | Encadeamento de especialistas sugerido | ❌ Nunca | ❌ Nunca executa ação de negócio diretamente | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca (só solicita aprovação humana, nunca concede em nome de humano) |
| **Researcher** | Fontes públicas; CRM (leitura) | Classificação de campos (VALIDADO/HIPÓTESE/NÃO_VERIFICADO) | ❌ Não aplicável (não decide relevância — isso é do Prospector) | Achado bruto em memória/arquivo local (não é dado operacional) | Pesquisa | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca |
| **Prospector** | CRM (leitura); achados do Researcher | Deduplicação, DNC, identidade/dados | Item candidato para a fila (Lead Approval) | Fila de aprovação local (`approvalQueue.js`) | Roteamento para a fila | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca |
| **SDR** | CRM (leitura); Skill SDR (Notion) | Qualificação, classificação de temperatura | Mensagem sugerida; atualização sugerida de Status/Temperatura/Observações | ❌ Nunca (nada gravado no CRM sem revisão humana) | Preparo interno (pesquisa de contexto, elaboração de mensagem) | ⚠️ Requer aprovação humana | ❌ Nunca | ❌ Nunca | ❌ Nunca |
| **Raio-X Digital** | CRM (leitura); fontes públicas | Classificação DADO/ANÁLISE/HIPÓTESE/NÃO_VERIFICADO | Diagnóstico, serviços recomendados, campos de diagnóstico sugeridos | ❌ Nunca (nada gravado no CRM sem revisão humana) | Montagem do Relatório Interno/Apresentação | ⚠️ Requer aprovação humana (enviar ao cliente) | ⚠️ Requer aprovação humana | ❌ Nunca | ❌ Nunca |
| **CRM AI/Atendimento** (A VALIDAR) | CRM | Interpretar dados, identificar inconsistências | Sugerir ações/movimentações de estágio | DECISÃO PENDENTE | DECISÃO PENDENTE | ❌ **Nunca com prospects — DEFINIDO em 0008.2**; conversa com cliente já fechado é DECISÃO PENDENTE | DECISÃO PENDENTE | ❌ Nunca | ❌ Nunca |
| **Closer Assistant** (A VALIDAR) | CRM (leitura); saída do Raio-X | Consolidação de contexto | Resumo/preparo para o Closer; perguntas sugeridas | ❌ Nunca | Consolidação de briefing | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca |
| **QA — camada de domínio** (embutido em cada Skill) | Saída do próprio especialista (SDR, Raio-X) | Verificação contra o critério de QA já documentado na Skill | Sinalização de não conformidade | ❌ Nunca | Validação interna à Skill | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca (checagem técnica ≠ `APPROVE` de negócio) |
| **QA — camada transversal** (FUTURO) | Saída de outros especialistas (Copy/Design/Vídeo/Social/Tráfego/Web) | Verificação contra critério compartilhado | Aprovação/reprovação técnica sugerida | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca |
| **Data Analyst** (FUTURO) | CRM e demais fontes | Consolidação de métricas | Relatórios sugeridos | ❌ Nunca | ❌ Nunca | ❌ Nunca | DECISÃO PENDENTE | ❌ Nunca | ❌ Nunca |
| **Copywriter** (FUTURO) | Briefing/contexto | — | Rascunho de texto | ❌ Nunca | ❌ Nunca | ❌ Nunca | ⚠️ Requer aprovação humana | ❌ Nunca | ❌ Nunca |
| **Designer** (FUTURO) | Briefing/contexto | — | Peça visual (rascunho) | ❌ Nunca | ❌ Nunca | ❌ Nunca | ⚠️ Requer aprovação humana | ❌ Nunca | ❌ Nunca |
| **Editor de Vídeo** (FUTURO) | Briefing/contexto | — | Vídeo (rascunho) | ❌ Nunca | ❌ Nunca | ❌ Nunca | ⚠️ Requer aprovação humana | ❌ Nunca | ❌ Nunca |
| **Social Media** (FUTURO) | Calendário editorial | — | Rascunho de post | ❌ Nunca | ❌ Nunca | ❌ Nunca | ⚠️ Requer aprovação humana (publicação está na lista fixa de sempre-aprovação) | ❌ Nunca | ❌ Nunca |
| **Gestor de Tráfego** (FUTURO) | Contas/campanhas (Meta, Google, TikTok Ads) | Análise de desempenho | Proposta de alteração de campanha | ❌ Nunca | ❌ Nunca — qualquer execução de alteração exige aprovação humana | ❌ Nunca | ❌ Não aplicável | ❌ Nunca | ❌ Nunca |
| **Web Developer** (FUTURO) | Repositório de código | — | Proposta de mudança (PR/branch) | ✅ Código em ambiente de desenvolvimento | Build | ❌ Nunca | ⚠️ Requer aprovação humana para publicar em produção | ❌ Nunca | ❌ Nunca |
| **Onboarding** (FUTURO) | CRM (cliente fechado) | — | Checklist/plano sugerido | ❌ Nunca | ❌ Nunca | ⚠️ Requer aprovação humana | ❌ Nunca | ❌ Nunca | ❌ Nunca |
| **Customer Success** (FUTURO) | CRM (histórico do cliente) | — | Sugestão de resposta | ❌ Nunca | ❌ Nunca | ⚠️ Requer aprovação humana | ❌ Nunca | ❌ Nunca | ❌ Nunca |
| **Financeiro** (FUTURO) | Dados financeiros | — | — | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca — toda ação financeira é sempre humana |
| **Administrativo** (FUTURO) | DECISÃO PENDENTE | DECISÃO PENDENTE | DECISÃO PENDENTE | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca |
| **ADV/Jurídico** (FUTURO) | Documentos/contratos | Análise/alerta | Sinalização de risco | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca | ❌ Nunca — toda ação jurídica é sempre humana |

## Sobre `PROPOSE` ≠ `WRITE`

`PROPOSE` significa: o especialista produz uma sugestão (mensagem, rascunho, classificação, plano) que **precisa de confirmação humana** antes de virar dado real em qualquer sistema operacional (CRM, conteúdo publicado, campanha). `WRITE` significa gravação real, sem revisão humana antes. **Nesta V1, nenhum especialista de IA tem `WRITE` para dados operacionais de CRM/conteúdo/campanha** — o máximo que existe é `PROPOSE`. A única exceção é gravação em armazenamento **próprio e local** do especialista (ex.: achado bruto do Researcher em memória; item da fila local do Prospector) — que não é um dado operacional de terceiros, e mesmo assim nunca dispara uma ação por si só.

## Sobre `APPROVE`

Nenhum especialista de IA tem a permissão `APPROVE` no sentido de decisão de negócio (aprovar um lead, aprovar uma campanha, aprovar uma proposta) — essa permissão é **exclusivamente humana** (Breno = ADMIN; Closer = pode autorizar o SDR, demais poderes DECISÃO PENDENTE). A única forma de "aprovação" que um especialista de IA pode fazer é uma checagem técnica interna de QA — isso nunca substitui a aprovação humana de negócio.

## Sobre `SEND` e `PUBLISH`

Em toda a tabela, `SEND`/`PUBLISH` aparecem como "requer aprovação humana", nunca como "sim" incondicional — reflexo direto da lista fixa de ações sempre-aprovadas em [human-approval-model.md](./human-approval-model.md). Isso vale mesmo para especialistas ainda não implementados (FUTURO): a regra de aprovação não depende de o especialista existir, é uma regra do sistema como um todo.
