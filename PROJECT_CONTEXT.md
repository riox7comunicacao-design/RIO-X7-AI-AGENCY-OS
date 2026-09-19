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
- **CRM** — Central Comercial + database Pipeline Comercial
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

Confirmado diretamente no schema do database em 2026-09-16. São exatamente **13 valores**:

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

O CRM central atualmente está no Notion. Não será criado um segundo CRM local neste passo.

## Skills

Já existem no Notion:

- RIO X7 SDR — Psicologia
- RIO X7 Raio-X Engine — Universal

Essas Skills são referências existentes e não devem ser recriadas ou modificadas neste momento.
