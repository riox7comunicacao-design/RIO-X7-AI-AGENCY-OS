# 0001 — Arquitetura Inicial

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
