# Domínios de Dados

Este documento não altera nenhum schema real (Notion ou local) — apenas mapeia o que já existe, o que este passo pede para contemplar, e onde há lacuna. Nenhuma alteração de schema do Notion foi feita nem é proposta como ação imediata (exigiria autorização própria, conforme Regra 4 do [RULES.md](../../RULES.md)).

## Princípio de arquitetura de dados

A visão do projeto é que o Notion **não é obrigatoriamente a interface final**. O desenho-alvo é:

```
Dashboard (futuro) → API/serviços → dados → especialistas
```

Ou seja: os especialistas devem ser escritos contra um **modelo de dados**, não contra "o Notion" como acoplamento direto — para que uma futura troca de interface (Dashboard próprio) ou de armazenamento não exija reescrever a lógica de cada especialista. Hoje, na prática, o Notion **é** a implementação desse modelo de dados (fonte de verdade operacional, conforme [0001](../decisions/0001-initial-architecture.md) e [0002](../decisions/0002-execution-architecture.md)) — isso não muda neste passo. O que muda é a intenção arquitetural: tratar o Notion como *um* backend possível do modelo de dados, não como *o* modelo em si.

**Refinamento (0008.4):** entre "API/serviços" e "dados" existe uma camada de **Autorização**, explicitada em [0009-identity-roles-and-authorization-model.md](../decisions/0009-identity-roles-and-authorization-model.md) — `Dashboard → API/Services → Authorization → Data/Specialist`. A autorização (checar `USER`/`role`/`permission`/`approvalType`) nunca deve existir só na interface; mesmo uma chamada direta a um serviço, sem passar pelo Dashboard, deve continuar sendo barrada pela mesma camada. Nenhuma API/Authorization foi implementada.

## Dados de prospecção — comparação com o schema real do CRM

Campos pedidos neste passo vs. o que já existe no CRM real (`RIO X7 — Pipeline Comercial`, confirmado por auditoria):

| Campo pedido neste passo | Existe no CRM hoje? | Campo equivalente real |
|---|---|---|
| Empresa | ✅ Sim | `Empresa` (title) |
| Proprietário | ❌ Não | — (gap) |
| Responsável/decision maker | ⚠️ Parcial | `Contato` (texto livre, sem campo específico de "decision maker") |
| Cargo | ✅ Sim | `Cargo` |
| Telefone | ✅ Sim | `Telefone` |
| WhatsApp | ✅ Sim | `WhatsApp` |
| E-mail | ✅ Sim | `E-mail` |
| Site | ✅ Sim | `Site` |
| Instagram | ✅ Sim | `Instagram` |
| Facebook | ❌ Não | — (gap) |
| LinkedIn | ❌ Não | — (gap) |
| Google Business Profile | ✅ Sim | `Google Perfil / Maps` |
| Atividade do Instagram | ❌ Não | — (gap; hoje só a URL do perfil é guardada, não sinais de atividade) |
| Presença/publicidade aparente | ❌ Não | — (gap; hoje isso vive em texto livre dentro de `Problema Identificado`/`Observações`) |
| Serviços (da empresa pesquisada) | ❌ Não | — (gap; `Serviço Potencial` existe, mas é sobre o serviço da Rio X7 recomendado, não sobre o serviço do prospect) |
| Região | ✅ Sim | `Cidade` + `Estado` |
| Observações | ✅ Sim | `Observações` |
| Evidências | ❌ Não (estruturado) | Hoje só texto livre; `discovery.js` já produz evidências estruturadas (`statusCampos[...].evidencias`), mas isso não é sincronizado com o CRM |
| Fonte | ❌ Não (estruturado) | Mesma situação — existe no `discovery.js`, não no CRM |
| Data da pesquisa | ⚠️ Parcial | `Data da Análise` existe, mas é sobre a análise Raio-X, não sobre quando cada dado de pesquisa foi coletado |
| Status de validação | ❌ Não | O CRM não tem campo para VALIDADO/HIPÓTESE/NÃO_VERIFICADO por campo — isso só existe hoje em `discovery.js`/`approvalQueue.js` (`statusCampos`, `statusIdentidade`, `statusDados`) |

**Nenhuma dessas lacunas foi corrigida neste passo** — alterar o schema do Notion exigiria autorização explícita e específica (mesma regra que já bloqueou uma escrita no Passo 1.7 até confirmação humana sobre o campo `Origem`). Ficam registradas como **DECISÃO PENDENTE / FUTURO** para quando a Rio X7 decidir estender o CRM.

## Regras de dados que já são inegociáveis (reafirmadas, não nova regra)

- **Nunca inferir contato privado** — mesma regra já fixada em [0004](../decisions/0004-controlled-web-research.md): telefone→WhatsApp, site→e-mail, nome→e-mail continuam proibidos.
- **"Não encontrado" ≠ "não possui"** — ausência de evidência é sempre `NÃO_VERIFICADO`, nunca um fato negativo. Já é o comportamento implementado em `discovery.js`.

## Status de dados — duas camadas, preservadas sem simplificação

1. **Por campo individual:** `VALIDADO` / `HIPÓTESE` / `NÃO_VERIFICADO` (regra original, PROJECT_CONTEXT.md; implementada em `discovery.js`).
2. **Por candidato, em duas dimensões independentes** (Passo 2.1, [0006](../decisions/0006-identity-vs-data-sufficiency.md)):
   - `statusIdentidade`: `VALIDADA` / `NAO_VALIDADA` (com motivo: CONFIRMADA/CONFLITO/AMBIGUA/EVIDENCIA_FRACA/SEM_EVIDENCIA)
   - `statusDados`: `SUFICIENTES` / `PARCIAIS` / `INSUFICIENTES`

Este passo **reafirma explicitamente** que não se deve voltar a uma lógica simplista de contagem de campos — exatamente o problema que 0006 já corrigiu. Nenhuma mudança foi necessária aqui; é uma confirmação de que a arquitetura de especialistas deve continuar respeitando essa separação, não uma correção nova.

## Duplicidade — preservada sem alteração

Ordem oficial mantida sem mudança: domínio/site → telefone → Instagram → nome+cidade, com a normalização conservadora corrigida no Passo 1.9 ([0005](../decisions/0005-conservative-name-and-phone-matching.md)). Nenhum mecanismo agressivo de matching foi proposto ou implementado.

## DNC — proteção independente, sem bypass

Reafirmado: `DO NOT CONTACT` é checado independentemente de qualquer outro dado, nunca contornável trocando de canal (já implementado em `doNotContact.js`, e nunca revertido automaticamente na fila — `approvalQueue.js`, estado `DNC` é terminal).

## Domínios de dados principais (Camada 3 do sistema — consolidado em 0008.2)

Formalização pedida na Consolidação 0008.2. Nenhum domínio foi inventado além dos já mencionados na visão do projeto; a "fonte atual" reflete o que existe de fato hoje, não uma meta.

**Atualização (2026-09-23, [decisão 0012](../decisions/0012-crm-operational-source-of-truth.md)):** as linhas **CRM**, **Empresas/Contatos** e **Clientes (Status = WON)** abaixo descreviam o Notion como fonte de verdade — isso foi **revogado**. O texto original destas três linhas é preservado (histórico de quando o Notion ainda era a fonte), marcado com †.

**Atualização (2026-09-23, etapa CRM-DOMAIN, [decisão 0013](../decisions/0013-crm-domain.md)):** o domínio do CRM operacional (`src/crm/` — modelo de dados, os 13 status, máquina de estados, DNC, deduplicação, repositório de persistência) **já existe em código**. Ainda **não** existem: CRM Service (autorização), rotas HTTP, Dashboard/Kanban. Nenhum dado real foi migrado do Notion.

| Domínio | Fonte atual | Quem lê | Quem escreve | Quem aprova |
|---|---|---|---|---|
| **Prospects** (pré-CRM) | `discovery.js` + `approvalQueue.js` (JSON local, não versionado) | Researcher, Prospector, Breno/Closer | Researcher/Prospector (`addProspect`) | Breno/Closer (`approveProspect`/`rejectProspect`) |
| **Empresas / Contatos** | **EM TRANSIÇÃO** — domínio CRM operacional (`src/crm/`) já implementado; Service/API/Dashboard ainda não. † fonte anterior: CRM Notion (`RIO X7 — Pipeline Comercial`) | SDR, Raio-X, CRM AI (quando existir) | Humano (ou sugestão de IA sob aprovação) | Breno/Closer |
| **Conversas** | **Nenhuma fonte estruturada hoje** — só texto livre em `Observações` | — | **DECISÃO ARQUITETURAL PENDENTE** (ver seção dedicada abaixo) | Humano, sempre, para qualquer envio |
| **CRM** (estágio/Status/Temperatura) | **EM TRANSIÇÃO** — domínio CRM operacional (`src/crm/`) já implementado (13 status, máquina de estados, DNC, dedup); Service/API/Dashboard ainda não. † fonte anterior: Notion `Pipeline Comercial` | Quase todos os especialistas | Humano (testado uma vez sob autorização — Passo 1.7; escrita real no CRM operacional depende do CRM-SERVICE, ainda não implementado) | Breno/Closer |
| **Reuniões** | Google Calendar (leitura) + campos do CRM (`Data da Reunião`, `Link do Meet`) | SDR, Closer Assistant, Raio-X | Humano | Humano (criação/alteração de reunião está na lista fixa de sempre-aprovação) |
| **Propostas** | **Nenhuma estruturada hoje** (só a Apresentação Comercial do Raio-X, como artifact) | Raio-X, Closer | Raio-X Digital (produz, como sugestão) | Breno/Closer, antes de qualquer envio ao cliente |
| **Clientes** (Status = WON) | **EM TRANSIÇÃO** — subconjunto por Status do domínio CRM operacional (`src/crm/`), já implementado; Service/API/Dashboard ainda não. † fonte anterior: mesmo CRM Notion | Onboarding/Customer Success (futuros) | Humano | Humano |
| **Conteúdo** | **Nenhuma hoje** — área "MARKETING" no Notion está reservada e vazia | Copywriter/Designer/Editor de Vídeo/Social Media (futuros) | Mesmos (rascunho/PROPOSE) | Humano sempre (publicação está na lista fixa) |
| **Campanhas** (mídia paga) | **Nenhuma integração técnica hoje** (PLANEJADA) | Gestor de Tráfego (futuro) | Mesmo (proposta de alteração) | Humano sempre |
| **Financeiro** | **Nenhuma hoje** | Financeiro (futuro) | Humano sempre | Humano sempre, sem exceção |
| **Documentos/Jurídico** | **Nenhuma hoje** | ADV/Jurídico (futuro) | Humano sempre | Humano sempre |
| **Auditoria** | `approvalQueue.js` (`historico` por item, já implementado) + histórico nativo de página do Notion (parcial) | Qualquer especialista/humano que precise entender o histórico | O próprio sistema (`actor: SYSTEM`/`HUMAN`, já implementado na fila) | Não aplicável — auditoria é registrada, nunca aprovada |

### Domínio "Conversas" — decisão arquitetural pendente

Registrado explicitamente nesta consolidação: **hoje não existe uma fonte estruturada própria para conversas** — o que existe é texto livre dentro do campo `Observações` do CRM. Isso deixa de ser suficiente no momento em que o sistema precisar de:

- alternância entre modo `AI` e `HUMAN` numa mesma conversa;
- histórico estruturado (não só um parágrafo acumulado);
- registro de handoff (quando um humano assumiu, e de volta);
- auditoria por mensagem/evento, não só por página;
- múltiplos canais (WhatsApp, Instagram, e-mail) com formato próprio de cada um;
- consumo tanto pelo SDR quanto por um futuro CRM AI.

**Portanto: `DOMÍNIO CONVERSAS = DECISÃO ARQUITETURAL PENDENTE`** quanto ao schema físico/técnico. **Consolidação 0008.3:** o **modelo conceitual mínimo**, em nível de arquitetura (não de implementação), fica registrado como **DEFINIDO em nível conceitual**:

```
CONVERSATION
- conversationId
- contactId
- companyId
- channel        (abstrato — ver abaixo)
- messages[]     (cada mensagem distingue o remetente: AI | HUMAN | CONTACT)
- mode           (AI | HUMAN — ver human-approval-model.md)
- actor          (quem gerou o evento/transição mais recente)
- timestamp
- approval/audit metadata
```

**`channel` deve ser abstrato** — nunca acoplar o SDR (ou qualquer especialista) diretamente a uma implementação específica de um canal. Canais possíveis, hoje só nomeados, nenhum integrado: `WHATSAPP`, `INSTAGRAM`, `EMAIL`, `OUTRO`. **Não escolher provedor/API neste passo** (nem WhatsApp Business API, nem qualquer outro) — isso seria inventar uma integração sem necessidade técnica ainda resolvida.

O modelo acima é conceitual — orienta uma implementação futura, mas **o schema físico/técnico (banco, formato exato, índices, etc.) continua sendo `DECISÃO PENDENTE`**, e nada disso foi implementado nesta consolidação.

## Requisitos futuros do CRM (Kanban) — o que já existe vs. o que falta

| Requisito pedido | Já existe hoje? |
|---|---|
| Funcionar visualmente como Kanban | ✅ Sim — view "Pipeline" já é um board agrupado por `Status` (confirmado em auditoria anterior) |
| Visualizar estágio | ✅ Sim — campo `Status` |
| Visualizar dados completos do lead | ✅ Sim — todos os campos do database |
| Visualizar valor de proposta | ❌ Não — não existe campo de valor monetário no schema atual |
| Visualizar valor total (provavelmente soma por estágio/pipeline) | ❌ Não — dependeria do campo de valor acima existir primeiro |
| Movimentação por humanos | ✅ Sim — o Notion já permite isso nativamente |
| Movimentação controlada por IA | ⚠️ Parcial — tecnicamente possível via API do Notion, mas nenhuma automação de escrita foi autorizada/implementada além do teste controlado do Passo 1.7 |
| Registrar histórico | ⚠️ Parcial — Notion tem histórico de página nativo, mas não um log estruturado de transição de Status como o que `approvalQueue.js` já implementa para a fila de aprovação |
| Controlar próxima ação | ✅ Sim — campo `Próxima Ação` + `Data da Próxima Ação` já existem |
| Alternar entre AI e HUMAN numa conversa | ❌ Não — não existe hoje |
| Registrar quando humano assumiu conversa | ❌ Não — não existe hoje |

As lacunas acima (valor de proposta/total, alternância AI/HUMAN, log estruturado de transição, registro de handoff humano) são candidatas naturais para o **CRM AI / Atendimento** (especialista "a validar") ou para uma evolução de schema do CRM — **DECISÃO PENDENTE** em ambos os casos.

## Classificação de integrações

Nenhuma integração é presumida — cada uma é classificada pelo que foi realmente confirmado nesta sessão/projeto, nunca pelo que "deveria" existir.

| Integração | Classificação | Evidência |
|---|---|---|
| Notion — leitura (CRM, Skills, páginas) | **EXISTENTE/TESTADA** | Usada extensivamente e confirmada em múltiplas auditorias (Passos 0.4, 0.8, 1.3, 1.4, 2, 2.1, 3) |
| Notion — escrita de página em database | **EXISTENTE/TESTADA** | Um único registro real criado sob autorização explícita e controlada (Passo 1.7, identificado aqui como Candidato 01) — testada uma vez, não em uso rotineiro |
| Notion — alteração de schema (criar opção de select, novo campo) | **NÃO TESTADA / NÃO AUTORIZADA** | Nunca executada; o Passo 1.7 parou explicitamente diante da necessidade de uma opção nova, em vez de criá-la |
| Google Calendar — leitura | **EXISTENTE/TESTADA** | Confirmado no Passo 0.3/0.8 (listagem de calendários e eventos) |
| Google Calendar — escrita (criar/editar evento) | **NÃO TESTADA / NÃO AUTORIZADA** | Nunca executada em nenhum passo |
| WhatsApp (envio) | **PLANEJADA** | Mencionada como ferramenta futura do SDR; nenhuma integração técnica existe hoje |
| Instagram (envio/DM) | **PLANEJADA** | Mesma situação do WhatsApp |
| E-mail (envio) | **PLANEJADA** | Mesma situação |
| Meta Ads / Google Ads / TikTok Ads | **PLANEJADA** | Nenhuma integração técnica existe; dependem do especialista Gestor de Tráfego (FUTURO) |
| Dashboard próprio (API/serviços) | **DECISÃO PENDENTE** | Mencionado na visão do projeto; nenhuma arquitetura técnica de API foi definida ou proposta neste passo |
| Repositório de código / Git | **EXISTENTE/TESTADA** | Em uso desde o Passo 0.3 |

Nenhuma API foi inventada, nenhum acesso foi presumido, e nenhuma capacidade de escrita além da já testada (Notion, um registro) foi assumida.
