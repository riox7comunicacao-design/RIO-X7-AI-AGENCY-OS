# CONTINUE HERE

## Projeto

Rio X7 AI Agency OS

## Repositório

`origin` → `https://github.com/riox7comunicacao-design/RIO-X7-AI-AGENCY-OS.git` (branch `main`)

## Última etapa concluída

CRM-DOMAIN (depois de CRM-ARCH). Ver [docs/decisions/0013-crm-domain.md](../decisions/0013-crm-domain.md) e [docs/decisions/0012-crm-operational-source-of-truth.md](../decisions/0012-crm-operational-source-of-truth.md).

## Último commit (de código)

`a5ed905` — `feat(crm): implement CRM domain and persistence port`

Este documento e `MULTICOMPUTER-HANDOFF.md` foram publicados num commit de documentação logo em seguida — **não confie neste número sozinho**, confirme com `git log -1 --oneline` antes de continuar.

## Estado

- `main` local deve estar igual a `origin/main` (confirme com `git status`, `git rev-parse HEAD`, `git rev-parse origin/main`).
- 491 testes automatizados, 0 falhas, no máximo 2 pulados (exigem `.env`/token real).
- Nenhum dado real de cliente/prospect está no Git. `.env` e `data/users.json` nunca foram versionados.

## Próxima etapa

**CRM-SERVICE** — a fronteira de autorização sobre o CRM Domain (padrão de `src/services/approvalQueueService.js`): decidir `WRITE:CRM`/`READ:CRM`/`ANALYZE:CRM` para cada operação, e como o `AuthorizationContext` (nunca o consumidor) preenche `reviewedBy`/`actor`. **Não implementar sem autorização explícita do proprietário do projeto.**

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
