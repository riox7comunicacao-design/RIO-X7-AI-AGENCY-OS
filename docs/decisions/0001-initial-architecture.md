# 0001 — Arquitetura Inicial

> **Nota de estado atual (2026-09-24):** este documento é um registro histórico, escrito quando o Notion era a fonte de verdade do CRM/Pipeline Comercial. Essa parte foi **revogada** pela [decisão 0012](./0012-crm-operational-source-of-truth.md) (2026-09-23): hoje o CRM operacional é o do próprio Rio X7 AI Agency OS (`src/crm` → CRM Service → API `/api/crm` → Dashboard) — o estado atual está em [CONTINUE-HERE](../operations/CONTINUE-HERE.md). O texto original abaixo foi preservado como histórico: onde ele disser que o CRM está no Notion, leia "estava". O Notion segue como base de conhecimento e repositório das Skills.

## Status

Decidido. Atualizado em 2026-09-16 após auditoria de correspondência entre a documentação local e o Notion real (Passo 0.4).

## Decisão

A Rio X7 adotará uma arquitetura híbrida, com uma única fonte de verdade por tipo de informação — nunca duas fontes de verdade para a mesma informação.

## Source of truth

**Notion:**

- CRM
- Estado comercial
- Skills nativas (SDR — Psicologia, Raio-X Engine — Universal)
- Operação comercial

**Projeto local (Claude Code):**

- Código
- Testes
- Documentação técnica
- Automações
- Configuração de execução

**Claude Chat:**

- Estratégia
- Arquitetura
- Planejamento
- Auditoria

**Google Calendar:**

- Agenda e reuniões

**VS Code** poderá ser utilizado como editor complementar, sem ser obrigatório.

## Princípio

Não duplicar dados ou Skills sem necessidade real. Evitar duas fontes de verdade para a mesma informação — quando uma informação já tem dono definido acima, o projeto local referencia, não copia.

## Migração

A migração entre camadas será gradual. Nenhuma camada é substituída de imediato — cada uma mantém seu papel até que uma transição consciente e testada seja decidida. Cada novo componente segue o ciclo:

```
CONSTRUIR
→ TESTAR
→ VALIDAR
→ DOCUMENTAR
→ APROVAR
→ AVANÇAR
```
