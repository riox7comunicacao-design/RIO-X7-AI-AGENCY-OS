# CONTINUE HERE

## Projeto

Rio X7 AI Agency OS

## Repositório

`origin` → `https://github.com/riox7comunicacao-design/RIO-X7-AI-AGENCY-OS.git` (branch `main`)

## Última etapa concluída

CRM-DASHBOARD V1 (depois de CRM-ARCH, CRM-DOMAIN, CRM-SERVICE e CRM-API): a primeira interface operacional do CRM no Dashboard — lista com busca e filtros, ficha, histórico, criar, editar, mudar status e "Não contatar". O que foi feito e como está no [CHANGELOG.md](../../CHANGELOG.md) (entrada "CRM Dashboard V1"); os contratos da API estão em [docs/decisions/0015-crm-api.md](../decisions/0015-crm-api.md), e as camadas abaixo em [0014](../decisions/0014-crm-service.md), [0013](../decisions/0013-crm-domain.md) e [0012](../decisions/0012-crm-operational-source-of-truth.md). Nenhuma decisão arquitetural nova.

## Último commit (de código)

Os commits da etapa CRM-DASHBOARD (o mais recente de código: `feat(dashboard): add the CRM interface ...`, precedido pela etapa CRM-API, `feat(server): add CRM API routes ...`) — **não confie em nenhum número de commit escrito aqui**: confirme com `git log -5 --oneline` antes de continuar.

## Estado

- `main` local deve estar igual a `origin/main` (confirme com `git status`, `git rev-parse HEAD`, `git rev-parse origin/main`).
- 752 testes automatizados, 0 falhas, no máximo 2 pulados (exigem `.env`/token real).
- Nenhum dado real de cliente/prospect está no Git. `.env`, `data/users.json` e `data/crm.json` nunca foram versionados.
- O Dashboard foi validado, nesta etapa, só com um serviço de autenticação **falso** (nenhuma credencial real foi usada). **Falta a validação com o login real** de Breno/Rafael — roteiro no passo 9 do [MULTICOMPUTER-HANDOFF.md](./MULTICOMPUTER-HANDOFF.md).

## Próxima etapa

**CRM-INTEGRATION** — a promoção Approval Queue → CRM (um prospect aprovado vira um registro do CRM), que segue pendente. **Não implementar sem autorização explícita do proprietário do projeto.**

Decisões pendentes que a interface tornou visíveis (nenhuma foi resolvida; ver 0014, 0015 e o CHANGELOG): a API não informa as transições permitidas (a tela oferece os outros status e o servidor recusa o que não vale); os rótulos dos status são os do domínio, em inglês; a API não tem filtro nem paginação no servidor, nem erro de validação por campo; as recusas de duplicidade/DNC não trazem o id do registro existente; o closer não pode marcar "Não contatar" (não tem `WRITE:CRM`); editar campos não gera histórico. Documentos com um pequeno atraso, fora do escopo da última etapa e ainda não atualizados: `docs/architecture/data-domains.md` (diz que o Dashboard do CRM não existe) e `data/README.md` (não menciona `data/crm.json`).

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
