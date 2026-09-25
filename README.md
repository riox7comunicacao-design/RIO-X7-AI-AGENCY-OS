# RIO X7 AI AGENCY OS

Sistema operacional de agência orientado por IA da **Rio X7 Comunicação** (tráfego pago, assessoria comercial, criação de sites e landing pages). O objetivo é reduzir trabalho operacional e aumentar a capacidade de aquisição, atendimento, vendas e execução — com o humano (Breno) sempre no controle das decisões estratégicas, financeiras e de risco.

O projeto é construído em etapas pequenas, sempre no mesmo ciclo: `CONSTRUIR → TESTAR → VALIDAR → DOCUMENTAR → AVANÇAR`. Nenhuma etapa avança sem passar por ele, e nenhuma etapa nova começa sem autorização explícita do proprietário do projeto.

## Arquitetura atual

```
Navegador → Dashboard (dashboard/) → HTTP /api/* (src/server) → Services (src/services) → domínios (src/crm, src/research-prospector) → persistência local (data/*.json)
                  └── login e identidade: Supabase Auth (src/auth) — a autorização (roles ADMIN e COMMERCIAL_CLOSER) é decidida no servidor, nunca só na tela
```

| Parte | Onde está |
|---|---|
| **CRM operacional** (13 status, máquina de estados, "Não contatar", deduplicação) | domínio `src/crm/` → Service `src/services/crmService.js` → API `/api/crm` (`src/server/app.js`) → telas `dashboard/views/crm.mjs` |
| **Dashboard** (login, Visão Geral, CRM, Aprovações, Sair) | `dashboard/` — JavaScript puro, sem CDN (o SDK do Supabase vem do `node_modules`, instalado pelo `npm ci`); conversa com o servidor só por HTTP |
| **Fila de aprovação humana** (Research + Prospector) | `src/research-prospector/`, `src/services/approvalQueueService.js` |
| **Promoção Approval Queue → CRM** | `src/services/crmIntegrationService.js` (+ `prospectToCrmFields.js`, `approvalPromotionService.js`) — só serviço, sem rota HTTP nem tela |
| **Autenticação e permissões** | `src/auth/` (Supabase Auth; matriz em `docs/architecture/permissions-matrix.md`) |
| **Notion** | base de conhecimento, documentação e Skills nativas — **não** é mais o CRM (decisão 0012) |

## O que existe e o que ainda não

**Implementado e testado:** login com Supabase, Dashboard, fila de aprovação humana, o CRM completo da primeira versão (domínio → Service → API → Dashboard: lista, busca, filtros, ficha, histórico, criar, editar, mudar status, "Não contatar") e a **promoção controlada Approval Queue → CRM** (`src/services/crmIntegrationService.js`: só prospects aprovados por um humano, idempotente, com auditoria nos dois lados — como serviço; ver a [decisão 0016](./docs/decisions/0016-crm-integration.md)).

**Ainda não implementado:** uma rota HTTP e uma ação "Promover para CRM" no Dashboard (a promoção ainda não tem tela), Kanban do CRM, SDR, outbound, WhatsApp, prospecção automática, IA nos especialistas e **persistência centralizada** — hoje os dados operacionais (`data/*.json`) são locais a cada computador e não são sincronizados.

## Como iniciar e testar

Requer Node.js 22 ou mais recente e Git. Configuração local que **nunca** vai para o Git: `.env` (Supabase) e `data/users.json` (usuários) — o passo a passo está no handoff.

```bash
npm ci                                            # instala exatamente o que está no package-lock.json
node --env-file-if-exists=.env scripts/preflight.js   # confere o ambiente (mostra o que falta, sem revelar valores)
npm test                                          # a suíte inteira (sem .env, os poucos testes que precisam do Supabase real ficam "pulados")
npm start                                         # sobe o Dashboard em http://127.0.0.1:3000
```

## Como continuar o desenvolvimento

1. Leia [docs/operations/CONTINUE-HERE.md](./docs/operations/CONTINUE-HERE.md) — o estado exato de onde o trabalho parou e qual é a próxima etapa.
2. Num computador novo, siga [docs/operations/MULTICOMPUTER-HANDOFF.md](./docs/operations/MULTICOMPUTER-HANDOFF.md): clonar, instalar, criar `.env` e `data/users.json`, validar.
3. Confirme `HEAD == origin/main` (`git fetch origin` e compare `git rev-parse HEAD` com `git rev-parse origin/main`) antes de mexer em qualquer código.

## Documentação

- [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) — contexto de negócio validado
- [RULES.md](./RULES.md) — regras fundamentais (não inventar, testar antes de declarar, humano no controle, privacidade, não expor segredos, uma etapa por vez)
- [CHANGELOG.md](./CHANGELOG.md) — histórico de mudanças, etapa por etapa
- [docs/decisions/](./docs/decisions/) — decisões arquiteturais (0001–0016); as mais recentes: 0012 (CRM próprio), 0013 (domínio), 0014 (Service), 0015 (API), 0016 (promoção Approval Queue → CRM)
- [docs/architecture/](./docs/architecture/) — arquitetura, domínios de dados, permissões e especialistas
- [docs/operations/CONTINUE-HERE.md](./docs/operations/CONTINUE-HERE.md) e [docs/operations/MULTICOMPUTER-HANDOFF.md](./docs/operations/MULTICOMPUTER-HANDOFF.md) — retomada e handoff entre computadores
- [data/README.md](./data/README.md) — o que são os arquivos locais `data/*.json` e por que não vão para o Git
- [skills/README.md](./skills/README.md) — as Skills existentes no Notion · [tests/README.md](./tests/README.md) — filosofia de testes
