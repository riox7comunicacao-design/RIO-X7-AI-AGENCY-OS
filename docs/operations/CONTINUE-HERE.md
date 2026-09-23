# CONTINUE HERE

## Projeto

Rio X7 AI Agency OS

## Repositório

`origin` → `https://github.com/riox7comunicacao-design/RIO-X7-AI-AGENCY-OS.git` (branch `main`)

## Última etapa concluída

CRM-SERVICE (depois de CRM-ARCH e CRM-DOMAIN). Ver [docs/decisions/0014-crm-service.md](../decisions/0014-crm-service.md), [0013](../decisions/0013-crm-domain.md) e [0012](../decisions/0012-crm-operational-source-of-truth.md).

## Último commit (de código)

Os commits da etapa CRM-SERVICE (o mais recente de código: `feat(services): add CRM service ...`, precedido por `fix(crm): block identity bypasses ...`) — **não confie em nenhum número de commit escrito aqui**: confirme com `git log -5 --oneline` antes de continuar.

## Estado

- `main` local deve estar igual a `origin/main` (confirme com `git status`, `git rev-parse HEAD`, `git rev-parse origin/main`).
- 573 testes automatizados, 0 falhas, no máximo 2 pulados (exigem `.env`/token real).
- Nenhum dado real de cliente/prospect está no Git. `.env` e `data/users.json` nunca foram versionados.

## Próxima etapa

**CRM-API** — as rotas HTTP sobre o CRM Service (`src/server`, no padrão das rotas da Approval Queue: Bearer, projeção segura, erros mapeados por mensagem, nunca `userId/role/permissions/reviewedBy` do navegador), compondo `createCrmService({ authorizeOperation: authorizeCrmOperation, repository })` no `src/server/index.js`. Depois: CRM-DASHBOARD; a promoção Approval Queue → CRM (CRM-INTEGRATION) segue pendente. **Não implementar sem autorização explícita do proprietário do projeto.** Decisões pendentes que a API/Dashboard vão encontrar (ver 0014): o closer não pode marcar DO_NOT_CONTACT (não tem `WRITE:CRM`); editar campos não gera histórico.

## Comando inicial

```powershell
git pull
npm install
node --env-file-if-exists=.env scripts/preflight.js
```

## Teste inicial

```powershell
npm test
```

## Documentos essenciais

- [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md)
- [RULES.md](../../RULES.md)
- [README.md](../../README.md)
- [docs/operations/MULTICOMPUTER-HANDOFF.md](./MULTICOMPUTER-HANDOFF.md)
- [docs/architecture/](../architecture/)
- [docs/decisions/](../decisions/)

## Regra

Antes de alterar código:

- ler este documento (`CONTINUE-HERE.md`);
- ler `PROJECT_CONTEXT.md`;
- ler `RULES.md`;
- verificar `git status`;
- verificar `HEAD` (`git rev-parse HEAD`);
- verificar `origin/main` (`git rev-parse origin/main`) e confirmar que são iguais;
- executar `npm test`;
- continuar **somente** a partir da próxima etapa aprovada acima — nunca implementar uma etapa nova sem autorização explícita do proprietário do projeto, mesmo que pareça óbvia.
