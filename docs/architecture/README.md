# Arquitetura

> **Nota de estado atual (2026-09-24):** este documento é um registro histórico, escrito quando o Notion era a fonte de verdade do CRM/Pipeline Comercial. Essa parte foi **revogada** pela [decisão 0012](../decisions/0012-crm-operational-source-of-truth.md) (2026-09-23): hoje o CRM operacional é o do próprio Rio X7 AI Agency OS (`src/crm` → CRM Service → API `/api/crm` → Dashboard) — o estado atual está em [CONTINUE-HERE](../operations/CONTINUE-HERE.md). O texto original abaixo foi preservado como histórico: onde ele disser que o CRM está no Notion, leia "estava". O Notion segue como base de conhecimento e repositório das Skills.

A arquitetura completa do RIO X7 AI AGENCY OS será construída de forma incremental, módulo por módulo, seguindo o ciclo CONSTRUIR → TESTAR → VALIDAR → DOCUMENTAR → AVANÇAR descrito no [README.md](../../README.md).

O sistema é híbrido, dividido em camadas com responsabilidades distintas, para evitar duas fontes de verdade para a mesma informação.

## Camada Notion

Responsável, hoje, por:

- CRM
- Pipeline Comercial
- Central Comercial
- Skills nativas (SDR — Psicologia, Raio-X Engine — Universal)
- Estado operacional comercial (leads, status, temperatura, diagnósticos)

## Camada Claude Code (projeto local)

Responsável por:

- Código
- Automações
- Scripts
- Testes
- Documentação técnica
- Configuração
- Execução local
- Integração futura com as demais camadas

## Camada Claude Chat

Responsável por:

- Estratégia
- Planejamento
- Desenho de processos
- Auditoria
- Decisões de arquitetura
- Revisão dos resultados

## Camada Google Calendar

Responsável pela agenda e reuniões, quando integrada a um fluxo específico.

## Arquitetura oficial já existente no Notion

Confirmada por auditoria em 2026-09-16. Esta árvore já existe no Notion — não foi criada por este projeto, e não deve ser recriada por ele:

```
RIO-X7-AI-AGENCY-OS
├── CORE
├── SKILLS
├── CRM
├── SALES
├── RAIO-X
├── CLIENTS
├── MARKETING
├── WEB
├── AUTOMATIONS
└── QA
```

Nem todas as áreas possuem conteúdo operacional completo. Segundo a própria estrutura do Notion, as áreas **CLIENTS**, **MARKETING**, **WEB**, **AUTOMATIONS** e **QA** são reservadas para fases futuras do roadmap e estão vazias hoje — isso não deve ser presumido como ausência de planejamento, apenas como fase ainda não iniciada.

## Fluxo macro (conceitual)

Este fluxo é uma referência de alto nível para o desenvolvimento futuro. Ele **não é** a lista de valores do campo `Status` do CRM — ver [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md) para a distinção entre o funil macro e o Status real do CRM.

```
PROSPECTOR
→ RESEARCH
→ CRM
→ SDR
→ QUALIFICATION
→ MEETING
→ RAIO-X
→ CALL
→ SOLUTIONS
→ PROPOSAL
→ FOLLOW-UP
→ CLOSE
→ ONBOARDING
→ ONGOING
```

Nenhum desses módulos possui implementação local neste momento.

## Arquitetura de execução

O modelo de responsabilidades por sistema, fonte de verdade por tipo de informação, níveis de autonomia dos agentes, ações que sempre exigem aprovação humana, arquitetura conceitual dos futuros agentes, fluxo de dados e requisitos de segurança e testes está registrado em [docs/decisions/0002-execution-architecture.md](../decisions/0002-execution-architecture.md). Nenhum agente descrito ali está implementado — é a referência que qualquer implementação futura deve seguir.

O primeiro módulo a ser especificado, RESEARCH + PROSPECTOR, está detalhado em [docs/decisions/0003-research-prospector-module.md](../decisions/0003-research-prospector-module.md) — também apenas especificação, sem implementação.

## Equipe de especialistas de IA

A arquitetura organizacional completa da futura equipe virtual de especialistas (quem são, limites, dados, permissões, e o que ainda depende de decisão humana) está registrada em [docs/decisions/0008-specialist-team-architecture.md](../decisions/0008-specialist-team-architecture.md), com detalhamento em:

- [specialist-matrix.md](./specialist-matrix.md) — cada especialista, classificado como definido / a validar / futuro.
- [permissions-matrix.md](./permissions-matrix.md) — permissões (READ/WRITE/EXECUTE/SEND/PUBLISH/DELETE/APPROVE) por especialista.
- [data-domains.md](./data-domains.md) — domínios de dados, lacunas do CRM atual, e classificação de integrações.
- [human-approval-model.md](./human-approval-model.md) — ações que sempre exigem aprovação humana e papéis (Breno/Closer).

Nenhum especialista novo foi implementado por esses documentos — é a referência para autorizar, um de cada vez, no futuro.
