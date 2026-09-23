# 0012 — CRM Operacional Próprio: Nova Fonte de Verdade do Pipeline Comercial

## Status

Decidido em 2026-09-23, pelo proprietário do projeto (Breno Bento), na etapa "CRM V1". **Revoga explicitamente** a decisão anterior registrada em [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md) ("O CRM central atualmente está no Notion. Não será criado um segundo CRM local neste passo.") e em [data-domains.md](../architecture/data-domains.md) (domínio "CRM", fonte atual = Notion `Pipeline Comercial`). Este documento é só a decisão arquitetural — nenhum código de CRM foi implementado por ele (ver "O que NÃO foi feito", abaixo). A implementação segue em etapas próprias e autorizadas individualmente: CRM-DOMAIN, CRM-SERVICE, CRM-INTEGRATION, CRM-API, CRM-DASHBOARD.

## 1. Decisão anterior (revogada)

Até este passo, o projeto tratava o Notion como a fonte de verdade operacional do Pipeline Comercial:

- `PROJECT_CONTEXT.md`, seção "## CRM": *"O CRM central atualmente está no Notion. Não será criado um segundo CRM local neste passo."*
- `docs/architecture/data-domains.md`, tabela de domínios: o domínio **CRM** (estágio/Status/Temperatura) tinha como "fonte atual" o Notion `Pipeline Comercial`, lido por quase todos os especialistas, escrito por humano (testado uma vez, Passo 1.7).
- `docs/decisions/0008-specialist-team-architecture.md`: registrava "CRM Services" (a camada de serviço dedicada ao CRM) como **FUTURO**, e a ponte Approval→CRM ("Passo 4") como dependente de autorização própria — sempre no pressuposto de que o destino final continuava sendo o Notion.

Essa auditoria foi feita e apresentada a Breno antes desta decisão (mensagem "CRM V1 — AUDITORIA CONCLUÍDA"), que respondeu com a revogação explícita abaixo.

## 2. Motivo da revogação

Decisão de produto do proprietário, não uma inferência técnica: o Rio X7 AI Agency OS passa a ser a interface operacional principal para Breno e Rafael (já é, desde o Dashboard MVP, para a Approval Queue), e o Pipeline Comercial precisa fazer parte dessa mesma interface, com a mesma cadeia de autorização (`AuthorizationContext` → Service → Domínio) já validada para a fila de aprovação — em vez de continuar dividido entre o Dashboard (aprovação) e o Notion (pipeline).

## 3. Nova fonte de verdade

A partir desta decisão: **o próprio Rio X7 AI Agency OS é a fonte de verdade operacional do Pipeline Comercial** — não mais o Notion. O CRM operacional segue a mesma arquitetura em camadas já estabelecida para a Approval Queue:

```
Dashboard (browser) → HTTP/API → CRM Service → CRM Domain → Persistência
```

- O Dashboard nunca importa o domínio nem a persistência diretamente — fala só HTTP com o servidor, como já vale para a Approval Queue.
- O CRM Service é a única porta de entrada para o domínio, autoriza pelo `AuthorizationContext` já existente, e não expõe internals — mesmo padrão do `approvalQueueService.js`.
- Nenhum mecanismo de autenticação/autorização é reimplementado: reaproveita integralmente `src/auth/` (USER, ROLE, PERMISSION, AuthorizationContext, verificação Supabase) tal como está.

## 4. Papel futuro do Notion

O Notion não é desligado nem descontinuado — muda de papel. A partir desta decisão, o Notion segue como:

- base de conhecimento e documentação;
- repositório das Skills nativas (SDR — Psicologia, Raio-X Engine — Universal);
- referência operacional para o que ainda não migrou (ex.: Conversas, Propostas — ver `data-domains.md`);
- eventual origem/destino de uma sincronização futura com o CRM operacional — **não decidida, não implementada, não desenhada nesta etapa** (instrução explícita: "NÃO criar sincronização com Notion nesta etapa").

Não haverá dois CRMs como fonte de verdade simultânea: o Pipeline Comercial passa a viver só no CRM operacional a partir do momento em que ele existir; o Notion não é mais escrito automaticamente por nenhum fluxo deste sistema para esse domínio.

## 5. Princípio de persistência desacoplada

Instrução explícita do proprietário, registrada aqui como princípio arquitetural do CRM Domain: **a persistência é uma camada substituível, nunca uma dependência direta do domínio.**

- O CRM Domain não importa `fs`, JSON, nem qualquer SDK de banco diretamente — ele opera sobre um **repositório** (porta/adapter), da mesma forma que `approvalQueue.js` recebe `authorizeReviewer` por injeção em vez de importar `src/auth`.
- Etapas CRM-DOMAIN/CRM-SERVICE implementam primeiro um **adapter de desenvolvimento/teste** para esse repositório (persistência local, não versionada — `data/*.json`, já coberto pelo `.gitignore` existente), permitindo Breno continuar o trabalho de diferentes máquinas via Git **sem** que dados operacionais viajem pelo repositório.
- **Candidato documentado para persistência de produção multi-dispositivo: o Supabase já em uso para autenticação** (mesmo projeto, plano FREE, sem custo adicional — todo projeto Supabase já inclui um banco Postgres, mesmo que hoje só a parte de Auth esteja em uso; nenhuma tabela de CRM existe). **Isto NÃO é uma decisão de adoção** — exige avaliação própria (RLS vs. acesso só server-side, schema, migrations) e autorização explícita antes de qualquer implementação, conforme já pedido ("apresente essa possibilidade separadamente antes de adotá-la como persistência definitiva"). Nenhuma tabela, policy ou migration é criada por esta decisão.
- Consequência prática: o contrato do repositório (as operações que o domínio precisa — ex. `find`, `save`, `list`, `existsByDedupeKey`) é desenhado na etapa CRM-DOMAIN de forma independente de onde os dados acabam gravados, para que trocar o adapter (JSON local → Supabase, se e quando decidido) não exija reescrever o domínio.

## 6. Implicações

- **Permissões inalteradas.** ADMIN mantém `WRITE:CRM`; `COMMERCIAL_CLOSER` continua sem `WRITE:CRM`. Esta decisão não concede, nem implicitamente, nenhuma permissão nova a nenhuma role — reafirmado por instrução explícita do proprietário.
- **Approval Queue inalterada.** `src/research-prospector/approvalQueue.js` continua sendo, sozinho, o domínio "Lead Approval" — decide só "este achado pode virar lead?". A promoção `APROVADO_PARA_CRM → CRM` (etapa CRM-INTEGRATION, futura) é uma operação nova e explícita, nunca automática, preservando a responsabilidade da fila já documentada em `0008`.
- **Nenhuma migração de dado real do Notion para o novo CRM é implicada por esta decisão.** O CRM operacional nasce vazio; popular com dados reais de clientes/prospects é decisão e execução futuras, fora desta etapa.
- **Divergência com o Notion passa a ser aceita conscientemente**, não mais um risco não decidido: `0008` registrava essa divergência como risco "se a diferença crescer sem revisão periódica" — esta decisão formaliza que o pipeline comercial deixa de crescer no Notion a partir de quando o CRM operacional estiver em uso.

## 7. O que NÃO foi feito nesta etapa (CRM-ARCH)

Nenhum código de CRM foi escrito. Não foram criados: domínio, Service, rotas HTTP, telas de Dashboard, adapters de persistência (nem JSON, nem Supabase), migrations, tabelas, policies, nem qualquer sincronização com o Notion. Esta etapa é exclusivamente a decisão arquitetural e a atualização da documentação que ela exige.

## Próximo passo recomendado

Etapa **CRM-DOMAIN**: desenhar e implementar o domínio do CRM (modelo de dados, status, transições, DNC, deduplicação reaproveitando `duplicateCheck.js`/`doNotContact.js`, e o contrato do repositório de persistência descrito na seção 5), com testes, sobre um adapter de desenvolvimento — sem Service, sem API, sem Dashboard ainda.
