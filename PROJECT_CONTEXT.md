# Contexto do Projeto

Este documento contém somente contexto já validado sobre a empresa e o projeto.

## Empresa

Rio X7 Comunicação.

## Posicionamento

Agência digital com atuação em:

- Tráfego Pago
- Assessoria Comercial
- Criação de Sites
- Landing Pages de Alta Conversão

## Objetivo do projeto

Construir um sistema operacional de agência orientado por IA, reduzindo trabalho operacional e aumentando capacidade de aquisição, atendimento, vendas e execução.

## Princípio operacional

Breno permanece responsável por:

- Estratégia
- Reuniões
- Negociação
- Aprovação de propostas
- Decisões financeiras
- Decisões jurídicas
- Decisões de risco
- Relacionamentos estratégicos

A IA pode executar tarefas operacionais quando houver autorização, regras e testes adequados.

## Arquitetura operacional oficial (Notion)

Existe, no Notion, uma estrutura organizacional oficial chamada **`RIO-X7-AI-AGENCY-OS`**, confirmada por auditoria em 2026-09-16. Ela substitui uma árvore anterior de 15 pastas ("Master Architecture V1") e organiza a operação da Rio X7 nas seguintes áreas:

- **CORE** — base de conhecimento fixo (links para documentos publicados)
- **SKILLS** — Skills nativas (SDR — Psicologia, Raio-X Engine — Universal)
- **CRM** — Central Comercial + database Pipeline Comercial (no Notion, agora base de conhecimento/histórico: **o CRM operacional é o do próprio sistema desde 2026-09-23** — ver a seção "CRM" abaixo)
- **SALES** — processo comercial em uso
- **RAIO-X** — documentos de diagnóstico gerados
- **CLIENTS** — reservada, vazia (fase futura do roadmap)
- **MARKETING** — reservada, vazia (fase futura do roadmap)
- **WEB** — reservada, vazia
- **AUTOMATIONS** — reservada, vazia (fase futura do roadmap)
- **QA** — reservada; hoje o QA vive dentro de cada Skill, não como página própria

Esta é a estrutura organizacional que já existe no Notion. A implementação equivalente na camada local (Claude Code) será construída de forma gradual — este documento apenas registra o que já existe, sem presumir que as áreas reservadas e vazias tenham conteúdo operacional.

## Funil macro (conceitual) — não confundir com o Status do CRM

O funil abaixo é uma representação conceitual de alto nível do processo de aquisição-a-operação, usada para fins de planejamento e arquitetura. **Ele não corresponde aos valores reais do campo `Status` do CRM** e não deve ser tratado como lista de valores válidos para esse campo.

```
PROSPECTOR
→ RESEARCH
→ CRM
→ SDR
→ QUALIFICATION
→ MEETING
→ RAIO-X DIGITAL
→ BRENO CALL
→ SOLUTIONS
→ PROPOSAL
→ FOLLOW-UP
→ CLOSE
→ ONBOARDING
→ ONGOING
```

## Status real do campo `Status` (CRM — Pipeline Comercial)

Confirmado diretamente no schema do database do Notion em 2026-09-16. São exatamente **13 valores** (os mesmos 13 são hoje o enum de status do CRM operacional próprio — `src/crm/constants.js`, decisões 0012 e 0013):

1. PROSPECT
2. RESEARCH
3. QUALIFIED PROSPECT
4. CONTACTED
5. RESPONDED
6. QUALIFICATION
7. MEETING SCHEDULED
8. MEETING COMPLETED
9. PROPOSAL
10. NEGOTIATION
11. WON
12. LOST
13. DO NOT CONTACT

`DO NOT CONTACT` é um status operacional especial: significa que o lead pediu explicitamente para não ser mais contatado. **`LOST` e `DO NOT CONTACT` não são equivalentes** — `LOST` é uma oportunidade perdida no funil comercial normal; `DO NOT CONTACT` é uma restrição de contato solicitada pelo próprio lead e tem prioridade sobre qualquer outra ação (ver Regra 5 e Regra 6 em [RULES.md](./RULES.md)).

## Status de informação

Para uso geral no projeto:

- **VALIDADO**
- **HIPÓTESE**
- **NÃO VERIFICADO**

No Raio-X, utilizar internamente:

- **DADO**
- **ANÁLISE**
- **HIPÓTESE**
- **NÃO VERIFICADO**

Hipótese nunca deve ser apresentada como fato.

## CRM

**Histórico (SUPERADO em 2026-09-23 — ver [decisão 0012](./docs/decisions/0012-crm-operational-source-of-truth.md)):** até esta data, o texto desta seção era *"O CRM central atualmente está no Notion. Não será criado um segundo CRM local neste passo."* Essa decisão foi revogada explicitamente pelo proprietário do projeto.

**Estado atual:** o Rio X7 AI Agency OS passa a ter um CRM operacional próprio, acessível pelo Dashboard (Breno/Rafael), como nova fonte de verdade do Pipeline Comercial — substituindo o Notion nesse papel. O Notion continua como base de conhecimento, documentação e repositório das Skills nativas; uma eventual sincronização entre os dois é decisão futura, não implementada. Ver a decisão 0012 para o racional completo, o princípio de persistência desacoplada e o que ainda não foi implementado.

**Onde está implementado (2026-09-24):** domínio (`src/crm/`), CRM Service (`src/services/crmService.js`), API HTTP (`/api/crm`, `src/server/app.js`) e Dashboard V1 (`dashboard/`: lista, busca, filtros, ficha, histórico, criar, editar, mudar status, "Não contatar"). **Ainda não existe:** a promoção Approval Queue → CRM (CRM-INTEGRATION), Kanban, persistência centralizada (hoje é um arquivo local por computador, `data/crm.json`, fora do Git). O estado detalhado e a próxima etapa estão em [docs/operations/CONTINUE-HERE.md](./docs/operations/CONTINUE-HERE.md).

## Skills

Já existem no Notion:

- RIO X7 SDR — Psicologia
- RIO X7 Raio-X Engine — Universal

Essas Skills são referências existentes e não devem ser recriadas ou modificadas neste momento.
