# CONTINUE HERE

Este é o primeiro documento a ler antes de mexer em qualquer coisa. Ele diz **onde o trabalho parou** e **qual é a próxima etapa** — e nunca é substituto de conferir o estado real com os comandos abaixo.

## Projeto

Rio X7 AI Agency OS — ver o [README.md](../../README.md) para o que é, a arquitetura e onde está cada parte.

## Repositório

`origin` → `https://github.com/riox7comunicacao-design/RIO-X7-AI-AGENCY-OS.git` (branch `main`)

## Antes de alterar qualquer código

1. Ler este documento, o [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md) e o [RULES.md](../../RULES.md).
2. Conferir que o clone está sincronizado (os dois hashes precisam coincidir):

   ```powershell
   git fetch origin
   git status
   git rev-parse HEAD
   git rev-parse origin/main
   ```

3. Se `HEAD` e `origin/main` forem diferentes, `git pull` (ou decida deliberadamente qual lado prevalece — nunca resolva isso com `git reset --hard` sem entender a diferença).
4. Rodar `npm test` e o preflight (abaixo) e comparar com o baseline desta página.
5. Continuar **somente** a partir da próxima etapa aprovada (última seção) — nunca implementar uma etapa nova sem autorização explícita do proprietário do projeto, mesmo que pareça óbvia.

**Não confie em nenhum número de commit escrito aqui**: confirme com `git log -5 --oneline`.

## Computador novo (resumo)

O passo a passo completo está em [MULTICOMPUTER-HANDOFF.md](./MULTICOMPUTER-HANDOFF.md). Em uma linha: clonar → `npm ci` → criar `.env` (a partir de `.env.example`) e `data/users.json` → `node --env-file-if-exists=.env scripts/preflight.js` → `npm test` → `npm start`. `.env` e `data/*.json` **não estão no Git** e são recriados à mão em cada computador.

## Comandos

```powershell
npm ci
node --env-file-if-exists=.env scripts/preflight.js
npm test
npm start
```

## Baseline dos testes (2026-09-25)

| Onde | Total | Passam | Falham | Pulados |
|---|---|---|---|---|
| Neste computador, com `.env` | 877 | 875 | 0 | 2 |
| Sem `.env` e sem `data/*.json` (um clone limpo) | 877 | 870 | 0 | 7 |

Nenhuma falha. Os pulados são esperados: sem `.env` (5 testes de conectividade/autenticação contra o Supabase real), o `[REAL-2]` (só roda com `RIO_X7_TEST_ACCESS_TOKEN`, um token real de teste) e o `[SRV-SEC-24b]` (symlink, que o Windows sem privilégio não permite). O preflight sem `.env` **falha de propósito** (`.env` e `data/users.json` ausentes; conectividade pulada) — é o comportamento correto de um computador ainda não configurado.

## Investigação manual do CRM (cidade/estado) — resultado

Na primeira validação manual real, a ficha de "TESTE CRM Rio X7" mostrou a **cidade vazia** e o **estado como `rj`** (o arquivo tinha `nicho: "clinica"`, `estado: "rj"`, `cidade: null`). Investigação:

- **Não foi reproduzida.** O caminho inteiro (formulário → corpo do POST → CRM-API → Service → domínio → arquivo em disco → GET → ficha) grava e devolve exatamente o que recebe: nenhuma camada muda caixa, tira acento ou descarta a cidade (há testes por camada, e mutações plantadas em cada camada são detectadas). Digitação real no navegador embutido e no Chrome, com o CRM vazio e com dados, também gravou `Clínica`/`Petrópolis`/`RJ` corretamente.
- **Segunda validação manual real** ("TESTE REDE 02"), com o **Request Payload confirmado no Chrome**: `{ "empresa": "TESTE REDE 02", "nicho": "clinica", "cidade": "Petrópolis", "estado": "rj", "status": "PROSPECT" }` → `201 Created` → a ficha mostrou Cidade "Petrópolis" (e, segundo o relato do proprietário, Estado "RJ"). Ou seja: **a cidade chega à API, é persistida e é recuperada corretamente**.
- **Conclusão do proprietário:** não há causa raiz reproduzível para o primeiro caso, e a diferença de caixa em nicho/estado vem dos **valores das opções de sugestão** (os campos Nicho, Cidade e Estado oferecem sugestões tiradas dos registros já existentes). **Nenhuma correção de produção foi feita** por causa daquele caso, e a normalização de UF/nicho **não foi alterada**. Se, numa nova conferência, a ficha mostrar uma caixa diferente da que foi enviada (payload no Chrome vs. resposta do `GET /api/crm/:id`), isso é um achado novo — capture os dois antes de mexer no código.
- **Decisão pendente (não tomada):** padronizar UF (por exemplo, sempre maiúsculas) e nicho. Hoje o sistema **preserva o que foi digitado**, só removendo espaços nas pontas. Se o proprietário quiser padronizar, o lugar certo é uma regra única no domínio (`src/crm`), decidida e documentada — não maquiar só na tela.

**Testes de regressão preservados** (todos passam, sem rede, sem credencial real, sem dado real; os valores são fictícios): `[DASH-FULL-9]` (o caso relatado pela interface, camada por camada, com o CRM vazio, incluindo o arquivo lido cru do disco), `[DASH-FULL-10]` (o mesmo caso direto na API, sem o Dashboard — localiza se um problema futuro é do servidor) e `[DASH-CRM-35]` (as sugestões dos campos nunca reescrevem o que foi digitado, mesmo chegando depois de a pessoa começar a digitar).

## CRM-INTEGRATION (promoção Approval Queue → CRM) — o que existe

[Decisão 0016](../decisions/0016-crm-integration.md). `promoteProspect(context, prospectId)` (`src/services/crmIntegrationService.js`) promove, para o CRM, um prospect que um **humano aprovou** na fila: explícita (nunca automática), idempotente (a mesma aprovação nunca cria dois registros — nem depois de uma falha no meio) e com auditoria na fila **e** no CRM. Exige `APPROVE:LEAD_APPROVAL` e `WRITE:CRM` (nenhuma permissão nova): o ADMIN promove; o closer aprova, mas não promove. A duplicidade e o DNC continuam sendo do **domínio do CRM**; nome+cidade só sinaliza. Nenhum estado novo na fila (`APROVADO_PARA_CRM` continua terminal; a promoção fica em `item.promocao` e no histórico).

**Exposta pelo Dashboard** (2026-09-25): `POST /api/approvals/:id/promote` (só o id na URL e corpo `{}`; autenticação obrigatória; chama `promoteProspect(contexto, id)` pelo serviço injetado; resposta segura `{ outcome, prospectId, crmRecordId, possivelDuplicidade }`; erros por `code` com mensagem fixa: 400/401/403/404/409/500) e, na tela Aprovações, o filtro **Pendentes/Aprovados** e o botão **Promover para CRM** (só em `APROVADO_PARA_CRM`, só para o ADMIN; o closer não o vê e a rota o recusa com 403), com confirmação, trava contra clique duplo e **Ver no CRM** (com o id devolvido pelo servidor). A rota só existe se o servidor recebe o serviço de promoção; a composição fica em `src/services/crmIntegrationFileService.js`. **Limites** (detalhes na 0016): sem trava entre processos (dois processos podem criar um registro duplicado para um prospect só com nome e cidade; o CRM não tem exclusão — revisão humana); a promoção usa o snapshot **atual** da fila (a redescoberta o atualiza mesmo depois da aprovação); `googlePerfil` não chega ao CRM (a fila não o guarda); se `data/crm.json` se perder com a fila intacta, a promoção falha claramente (`PROMOTION_INCONSISTENT`) e a recuperação é manual.

## Decisões pendentes que a interface do CRM tornou visíveis (nenhuma resolvida)

A API não informa as transições permitidas (a tela oferece os outros status e o servidor recusa o que não vale); os rótulos dos status são os do domínio, em inglês; a API não tem filtro nem paginação no servidor, nem erro de validação por campo; as recusas de duplicidade/DNC não trazem o id do registro existente; o closer não pode marcar "Não contatar" (não tem `WRITE:CRM`); editar campos não gera histórico; padronização de UF/nicho (acima). Detalhes em [0014](../decisions/0014-crm-service.md), [0015](../decisions/0015-crm-api.md) e no [CHANGELOG.md](../../CHANGELOG.md). **Persistência centralizada** (compartilhar o CRM entre computadores) é uma necessidade futura, ainda não decidida nem implementada: hoje `data/crm.json` é local a cada máquina.

---

## ESTADO ATUAL (2026-09-25)

- CRM-DOMAIN: concluído
- CRM-SERVICE: concluído
- CRM-API: concluído
- CRM-DASHBOARD V1: concluído
- investigação manual da cidade: **não reproduzida** (sem correção de produção)
- testes de regressão: concluídos (`DASH-FULL-9`, `DASH-FULL-10`, `DASH-CRM-35`)
- documentação e handoff para outro computador: concluídos e ensaiados com um clone limpo do `origin/main`
- CRM-INTEGRATION: **concluído** (decisão 0016) — serviço, rota `POST /api/approvals/:id/promote` e ação "Promover para CRM" no Dashboard
- Kanban, Prospector, SDR, outbound: NÃO implementados
- persistência centralizada / sincronização entre computadores: NÃO implementada (necessidade futura)

## PRÓXIMA ETAPA

**Ainda não definida.** O proprietário (Breno Bento) decide depois de revisar a promoção pelo Dashboard. Candidatas naturais, **nenhuma iniciada**: melhorias no snapshot da fila (`googlePerfil`, congelar o que foi aprovado); persistência centralizada.

**Não iniciar nenhuma etapa automaticamente** — nem o Prospector. Só começa com autorização explícita do proprietário do projeto.
