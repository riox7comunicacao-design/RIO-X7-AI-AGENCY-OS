# RIO X7 AI AGENCY OS

## Objetivo do projeto

Construir a camada operacional inteligente da Rio X7 Comunicação, utilizando IA para apoiar e, posteriormente, executar processos de:

- Aquisição
- SDR
- CRM
- Diagnóstico
- Vendas
- Marketing
- Mídia paga
- Desenvolvimento
- Atendimento
- Operações
- Análise
- QA

## Método de trabalho

O projeto está sendo desenvolvido de forma incremental, seguindo sempre o mesmo ciclo:

```
CONSTRUIR → TESTAR → VALIDAR → DOCUMENTAR → AVANÇAR
```

Nenhuma etapa avança para a próxima sem passar pelo ciclo completo.

## Princípio de segurança

Nenhuma automação crítica deve entrar em produção sem teste. Sistemas externos (Notion, Google Calendar, contas de anúncios, WhatsApp, sistemas financeiros e de clientes) não são alterados sem autorização explícita.

## Documentação relacionada

- [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) — contexto de negócio validado
- [RULES.md](./RULES.md) — regras fundamentais do projeto
- [CHANGELOG.md](./CHANGELOG.md) — histórico de mudanças
- [docs/architecture/](./docs/architecture/) — arquitetura incremental
- [docs/decisions/](./docs/decisions/) — decisões arquiteturais
- [skills/README.md](./skills/README.md) — referência às Skills existentes no Notion
- [tests/README.md](./tests/README.md) — filosofia de testes
