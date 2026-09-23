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

## Como rodar localmente

Node.js 22 ou mais recente (ver `engines` em `package.json`; testado em produção com 24.x).

```bash
npm install
npm test
```

O Dashboard exige configuração local que nunca é versionada — `.env` (Supabase) e `data/users.json` (usuários operacionais). O passo a passo completo, do zero até `npm start`, está em [docs/operations/MULTICOMPUTER-HANDOFF.md](./docs/operations/MULTICOMPUTER-HANDOFF.md).

## Documentação relacionada

- [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) — contexto de negócio validado
- [RULES.md](./RULES.md) — regras fundamentais do projeto
- [CHANGELOG.md](./CHANGELOG.md) — histórico de mudanças
- [docs/architecture/](./docs/architecture/) — arquitetura incremental
- [docs/decisions/](./docs/decisions/) — decisões arquiteturais
- [docs/operations/CONTINUE-HERE.md](./docs/operations/CONTINUE-HERE.md) — ponto de partida para retomar o projeto (inclusive em outro computador)
- [docs/operations/MULTICOMPUTER-HANDOFF.md](./docs/operations/MULTICOMPUTER-HANDOFF.md) — como clonar, instalar, configurar e rodar do zero
- [skills/README.md](./skills/README.md) — referência às Skills existentes no Notion
- [tests/README.md](./tests/README.md) — filosofia de testes
