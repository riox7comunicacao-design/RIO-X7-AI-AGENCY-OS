# 0002 — Arquitetura de Execução

## Status

Decidido (documentação conceitual). Nenhuma parte descrita aqui está implementada. Registrado em 2026-09-16.

## Contexto

A decisão [0001-initial-architecture.md](./0001-initial-architecture.md) definiu a arquitetura híbrida em alto nível (Notion / Claude Code / Claude Chat / Google Calendar) e o princípio de não duplicar fontes de verdade. Esta decisão aprofunda esse modelo para o momento em que passarem a existir agentes de execução: como eles vão localizar e usar as Skills, com que nível de autonomia, o que precisa de aprovação humana, e como o fluxo de dados deve funcionar entre Notion, Claude Code, Git e Google Calendar.

Confirmado por leitura direta do Notion em 2026-09-16 (mesmo estado já registrado na auditoria do Passo 0.4, sem alterações desde então):
- A árvore oficial `RIO-X7-AI-AGENCY-OS` existe com as áreas CORE, SKILLS, CRM, SALES, RAIO-X, CLIENTS, MARKETING, WEB, AUTOMATIONS e QA — as cinco últimas estão vazias, reservadas para fases futuras do roadmap.
- `RIO X7 SDR — Psicologia` e `RIO X7 Raio-X Engine — Universal` são Skills nativas do Notion (confirmado via ferramenta de busca de Skills).
- O CRM (`RIO X7 — Pipeline Comercial`) tem 13 valores de Status, incluindo `DO NOT CONTACT`, conforme já registrado em [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md).

## Problema

Ainda não existe nenhum agente de execução no projeto. Antes de construir o primeiro, é preciso responder, sem ambiguidade: quem é dono de cada tipo de informação; o que um agente pode fazer sozinho e o que precisa de aprovação humana; o que fazer quando a Skill não existir, estiver conflitante, desatualizada, ou marcada como hipótese/não verificada; e como testar isso antes de qualquer uso real. Sem essas respostas por escrito, qualquer agente futuro corre o risco de agir fora do que Breno realmente autorizou.

## Decisão

Adotar o modelo de responsabilidades, fonte de verdade, níveis de autonomia, fluxo de dados e segurança descritos abaixo como referência obrigatória para qualquer agente construído a partir deste projeto. Nenhum agente é implementado nesta etapa — esta decisão é só o contrato que a implementação futura deve respeitar.

---

## 1. Responsabilidades por sistema

- **Notion** → fonte de verdade para conhecimento operacional, Skills, CRM, processos e dados comerciais.
- **Claude Code** → execução técnica: código, testes, integrações e automações.
- **Claude Chat** → estratégia, planejamento, arquitetura, auditoria e decisões.
- **Google Calendar** → agenda e compromissos.
- **Git** → versionamento do projeto técnico (código e documentação local, nunca dados comerciais).

## 2. Fonte de verdade

| Item | Fonte de verdade | Quem pode ler | Quem pode alterar | Cópia local permitida? | Observações |
|---|---|---|---|---|---|
| Estratégia | Claude Chat (decisões registradas em `docs/decisions/`) | Todos os agentes, Breno | Breno, com apoio do Claude Chat | Sim — é o próprio registro | Uma vez decidida, a estratégia vira decisão versionada localmente. |
| Regras | `RULES.md` (projeto local) | Todos os agentes | Breno (via autorização explícita) | N/A — já é local | É a única fonte para regras de comportamento dos agentes. |
| Skills | Notion (Skills nativas) | Agentes (leitura em tempo de execução), Breno | Breno / quem ele designar no Notion | **Não** (só referência/metadados) | Ver seção 3 — nenhuma cópia integral, para não divergir. |
| CRM | Notion (`RIO X7 — Pipeline Comercial`) | Agentes autorizados, Breno | Agentes de Nível 2+ autorizados, Breno | **Não** | Nenhum CRM paralelo local. |
| Leads | Notion (registros do Pipeline Comercial) | Agentes autorizados, Breno | Agentes de Nível 2+ autorizados, Breno | **Não** | Mesma base do CRM. |
| Clientes | Notion (Status = WON) | Agentes autorizados, Breno | Breno, com aprovação para mudanças sensíveis | **Não** | Dado comercial sensível — ver seção 7. |
| Raio-X | Notion (página `RAIO-X` + anexos/artifacts) | Agentes autorizados, Breno | Skill Raio-X Engine (sob supervisão), Breno | Cache técnico temporário é aceitável, não versão "oficial" | Documentos finais e PDFs originais ficam fora do Notion como anexos do projeto — a página `RAIO-X` é o índice. |
| Agenda | Google Calendar | Agentes autorizados (leitura), Breno | Breno; agentes só com autorização explícita | Não | Nunca criar/alterar evento sem aprovação (Nível 2 mínimo). |
| Código | Git (projeto local) | Todos | Quem tiver acesso ao repositório, via commit autorizado | N/A — é a fonte | Fonte de verdade nativa do Claude Code. |
| Automações | Git (projeto local) | Todos | Quem tiver acesso ao repositório | N/A — é a fonte | Ainda não existe nenhuma automação implementada. |
| Testes | Git (projeto local, `tests/`) | Todos | Quem tiver acesso ao repositório | N/A — é a fonte | Segue a filosofia de [tests/README.md](../../tests/README.md). |
| Documentação técnica | Git (projeto local, `docs/`) | Todos | Quem tiver acesso ao repositório | N/A — é a fonte | Este próprio documento é um exemplo. |
| Decisões arquiteturais | Git (projeto local, `docs/decisions/`) | Todos | Aprovadas por Breno antes do commit | N/A — é a fonte | Segue o padrão ADR já iniciado em 0001. |
| Secrets | **Nenhuma fonte ainda existe** | Ninguém (não foram criados) | N/A | **Nunca em texto plano no Git** | Ver seção 7 — nenhum secret foi criado até agora. |
| Logs | A definir quando existir automação real | A definir | A definir | Local, mas nunca com dado pessoal desnecessário (Regra 8 do RULES.md) | Hoje não existe nenhum log de execução — não há automação rodando. |

**Regra fundamental (reafirmada):** o projeto local nunca duplica integralmente uma informação operacional que já tem fonte oficial no Notion. Onde a tabela diz "Não" em cópia local, isso vale mesmo para cache "temporário" que vire hábito — exceção só para cache técnico volátil e explicitamente descartável.

## 3. Como agentes futuros usarão as Skills (fluxo conceitual)

```
AGENTE
↓
identifica a Skill necessária
↓
consulta a fonte oficial (Notion, em tempo de execução)
↓
carrega as regras vigentes daquela consulta
↓
executa a tarefa dentro dos limites da Skill e do nível de autonomia atribuído
↓
valida o resultado (contra RULES.md e critérios de QA da própria Skill)
↓
registra o resultado (CRM quando aplicável, log técnico local)
```

Comportamento definido para os casos de exceção:

- **Skill não existir:** o agente para e sinaliza a Breno que não há Skill oficial para aquela tarefa. Nunca improvisar um comportamento não documentado para uma área que deveria ter Skill.
- **Informação conflitante:** o agente não escolhe sozinho qual versão é válida — sinaliza o conflito para revisão humana antes de agir.
- **Informação desatualizada:** o agente trata a Skill/CRM do Notion como sempre a versão mais atual disponível (é a fonte de verdade); se perceber uma inconsistência (ex.: campo que não existe mais), reporta em vez de assumir o comportamento antigo.
- **Informação marcada como HIPÓTESE:** nunca é apresentada como fato, nem para o lead nem internamente na decisão do agente (mesma regra já fixada nas duas Skills e em PROJECT_CONTEXT.md).
- **Informação NÃO VERIFICADA:** o agente não pode usá-la como base para uma decisão de execução (ex.: não pode qualificar um lead com base em um dado não verificado) — só pode registrá-la como tal.
- **Agente sem permissão para a ação:** para e solicita aprovação humana; nunca contorna a permissão nem executa uma versão "parcial" da ação sem autorização.

## 4. Níveis de autonomia

- **Nível 0 — Leitura:** pesquisa e análise. Não produz nenhuma ação nem rascunho persistente fora de uso imediato.
- **Nível 1 — Preparação:** produz rascunhos, análises, diagnósticos e planos, sem executar nenhuma ação externa.
- **Nível 2 — Execução controlada:** executa ações previamente autorizadas, uma de cada vez, com escopo definido pela autorização.
- **Nível 3 — Autonomia limitada:** executa apenas tarefas que já foram explicitamente autorizadas *como classe* — reconhecidas como seguras e reversíveis — sem precisar de aprovação individual a cada repetição.

**Ações que SEMPRE exigem aprovação humana explícita, independentemente do nível de autonomia do agente:**

- Enviar WhatsApp
- Enviar e-mail
- Prospectar (iniciar contato com um novo lead)
- Alterar CRM (incluindo mudança de Status, Temperatura, ou qualquer campo)
- Criar reunião (evento no Google Calendar)
- Alterar campanhas (mídia paga)
- Gastar dinheiro
- Publicar conteúdo
- Contratar ferramentas
- Alterar dados de clientes
- Excluir dados
- Ações financeiras
- Ações jurídicas

Essas ações permanecem na lista de aprovação obrigatória mesmo para um agente hipoteticamente classificado como Nível 3 — autonomia limitada nunca significa autonomia sobre estas categorias, que envolvem risco financeiro, jurídico, reputacional ou de relação com o cliente (consistente com a Regra 6 do RULES.md: humano no controle).

## 5. Arquitetura futura dos agentes (conceitual — nenhum implementado)

| Agente | Objetivo | Entradas principais | Fontes | Saída | Pode consultar | Pode alterar | Aprovação humana |
|---|---|---|---|---|---|---|---|
| ORQUESTRADOR | Coordenar os demais agentes, rotear tarefas | Solicitação de tarefa | Todas as fontes indiretamente, via subagentes | Delegação e consolidação de resultado | Todas (leitura) | Nenhuma diretamente | Sempre que delega ação de Nível 2+ |
| RESEARCH | Pesquisar informação pública sobre um prospect/empresa | Nome/empresa, URLs públicas | Site, Instagram, Google, redes públicas | Dossiê de pesquisa (DADO/NÃO VERIFICADO) | Fontes públicas | Nada | Não, é Nível 0/1 |
| PROSPECTOR | Identificar novos prospects dentro do ICP | Critérios de nicho/ICP | Fontes públicas, CRM (para dedupe) | Lista de candidatos a lead | CRM (leitura), fontes públicas | Nada diretamente | Sim, para criar lead novo no CRM |
| SDR | Conduzir a conversa de qualificação (Skill SDR) | Dados do lead, histórico de conversa | CRM, Skill SDR (Notion) | Mensagem sugerida, atualização de CRM sugerida | CRM (leitura), Skill SDR | Nada diretamente (sugestão apenas) | Sim, para enviar mensagem e para alterar CRM |
| QUALIFICATION | Aplicar critérios de qualificação e temperatura | Conversa/dados do lead | Skill SDR (critérios), CRM | Classificação sugerida (Status/Temperatura) | CRM (leitura), Skill SDR | Nada diretamente | Sim, para gravar no CRM |
| SCHEDULER | Propor/organizar horários de reunião | Disponibilidade, lead qualificado | Google Calendar (leitura) | Sugestão de horário | Google Calendar (leitura) | Nada diretamente | Sim, para criar evento |
| RAIO-X | Gerar diagnóstico (Skill Raio-X Engine) | Formulário de 10 perguntas, pesquisa pública | Skill Raio-X (Notion), CRM | Relatório interno + apresentação comercial | CRM (leitura), fontes públicas, Skill Raio-X | Campos de diagnóstico no CRM (sugestão) | Sim, para publicar/enviar ao cliente |
| SALES | Apoiar Breno na condução comercial (nunca decide sozinho) | Contexto do lead, Raio-X | CRM, Raio-X | Resumo/preparo para a call de Breno | CRM (leitura) | Nada | Sempre — decisão comercial é sempre humana |
| PROPOSAL | Montar rascunho de proposta a partir do diagnóstico | Raio-X aprovado, serviços de aderência | CRM, Raio-X | Rascunho de proposta | CRM (leitura) | Nada diretamente | Sim, para enviar proposta |
| FOLLOW-UP | Sugerir e lembrar follow-ups conforme cadência da Skill SDR | Datas/Status do CRM | CRM, Skill SDR | Lembrete/sugestão de mensagem | CRM (leitura) | Nada diretamente | Sim, para enviar mensagem |
| ONBOARDING | Apoiar processo pós-fechamento (WON) | Dados do cliente fechado | CRM | Checklist/plano de onboarding | CRM (leitura) | Nada diretamente | Sim, para ações no cliente |
| MARKETING | Apoiar planejamento de conteúdo/mídia | Briefing, calendário editorial | A definir (área reservada no Notion) | Rascunhos de conteúdo | A definir | Nada diretamente | Sim, para publicar |
| MEDIA BUYING | Apoiar análise de campanhas pagas | Dados de campanha | Contas de anúncio (quando integradas) | Análise/recomendação | Contas de anúncio (leitura) | Nada diretamente | Sempre, para alterar campanha/orçamento |
| WEB | Apoiar manutenção/criação de sites | Especificação do projeto | Repositório de código | Código, build | Repositório | Repositório (via commit) | Sim, para publicar em produção |
| FINANCE | Apoiar organização financeira | Dados financeiros | A definir | Relatórios/análises | A definir | Nada diretamente | Sempre — ação financeira é sempre humana |
| LEGAL | Apoiar revisão de aspectos jurídicos | Documentos/contratos | A definir | Análise/alerta | A definir | Nada | Sempre — ação jurídica é sempre humana |
| CS | Apoiar atendimento a clientes ativos | Histórico do cliente | CRM | Sugestão de resposta | CRM (leitura) | Nada diretamente | Sim, para responder ao cliente |
| QA | Validar resultados de outros agentes antes de uso real | Saída de outro agente | Critérios de QA de cada Skill | Aprovação/reprovação | Saída do agente avaliado | Nada | Reporta a Breno em caso de reprovação |
| DATA / ANALYTICS | Consolidar métricas de operação | Dados do CRM e demais fontes | CRM, outras fontes quando existirem | Relatórios | Fontes de dados (leitura) | Nada | Não, para leitura; sim, para qualquer ação decorrente |

Nenhum desses agentes existe hoje. Esta tabela é só a referência conceitual para quando a construção for autorizada, um de cada vez.

## 6. Fluxo de dados

```
FONTE DE DADOS
↓
SKILL / PROCESSO
↓
AGENTE
↓
VALIDAÇÃO
↓
APROVAÇÃO QUANDO NECESSÁRIA
↓
AÇÃO
↓
RESULTADO
↓
REGISTRO
```

- **Fonte de dados:** Notion (CRM, Skills, Central Comercial), fontes públicas (site, Instagram, Google), Google Calendar.
- **Skill/Processo:** a Skill nativa correspondente (lida do Notion em tempo de execução, nunca de uma cópia local desatualizada).
- **Agente:** aplica a Skill ao caso concreto.
- **Validação:** confere contra RULES.md, contra os critérios de QA da própria Skill, e contra o nível de autonomia atribuído ao agente.
- **Aprovação quando necessária:** qualquer ação da lista da seção 4 para antes de prosseguir e aguarda decisão humana.
- **Ação:** a execução em si (ex.: enviar mensagem, atualizar campo do CRM, criar evento).
- **Resultado:** o efeito observável da ação (mensagem enviada, campo atualizado, evento criado).
- **Registro:** atualização no Notion (quando a ação for comercial) e/ou log técnico local (quando a ação for técnica). Git versiona código e documentação técnica, nunca dado comercial ou pessoal de lead/cliente.

## 7. Segurança

- **Secrets e credenciais:** nenhum secret existe hoje no projeto. Quando existirem, nunca em texto plano no Git — via variáveis de ambiente locais (`.env`, já coberto pelo `.gitignore`) ou um cofre de segredos dedicado, nunca commitado.
- **Princípio do menor privilégio:** cada agente recebe apenas o nível de autonomia e o escopo de sistemas necessários para sua função específica (ver tabela da seção 5) — nunca acesso amplo "por conveniência".
- **Leitura versus escrita:** leitura é o padrão; escrita em qualquer sistema externo (Notion, Google Calendar) exige autorização conforme o nível de autonomia e a lista de ações da seção 4.
- **Proteção do Git:** o repositório local não deve conter dado pessoal de lead/cliente, credenciais, ou conteúdo integral de Skills (ver seção 2). Commits são revisados antes de acontecer (nenhum commit automático sem revisão humana neste momento do projeto).
- **Proteção de dados de clientes:** dados de clientes/leads permanecem no Notion (fonte de verdade); nenhuma cópia local, nenhum uso além do necessário para a tarefa autorizada (Regra 8 do RULES.md — privacidade).
- **Logs:** quando passarem a existir (com automação real), não devem conter dado pessoal desnecessário, nem segredo, nem conteúdo integral de conversa sensível sem necessidade — apenas o necessário para auditoria técnica.
- **Aprovação humana:** é a barreira de segurança central deste projeto — toda ação da lista da seção 4 é bloqueada até aprovação explícita, independentemente da confiança depositada no agente.
- **Ações irreversíveis:** (excluir dado, enviar mensagem, gastar dinheiro, publicar conteúdo) exigem sempre o nível mais alto de cautela — aprovação explícita e, quando possível, uma etapa de confirmação adicional antes da execução.

## 8. Estrutura de testes para futuros agentes

Quando um agente for implementado, ele deve ter, documentado (seguindo o padrão de [tests/README.md](../../tests/README.md)):

- **Testes unitários** — cada função/regra isolada do agente se comporta como esperado.
- **Testes de integração** — o agente consegue de fato ler/escrever nas fontes corretas (Notion, Google Calendar) dentro do escopo autorizado.
- **Testes de segurança** — o agente não consegue executar uma ação fora do seu nível de autonomia, mesmo se instruído a isso.
- **Testes de regressão** — mudanças no agente não quebram comportamento já validado anteriormente.
- **Testes de autorização** — toda ação da lista da seção 4 é de fato bloqueada até aprovação explícita, em todos os agentes que a tocam.
- **Testes contra alucinação** — o agente não inventa dado, número, resultado ou fonte (Regra 1 do RULES.md); testado com casos onde a informação real não existe.
- **Testes de DO NOT CONTACT** — um lead marcado como `DO NOT CONTACT` nunca é contatado por nenhum agente, em nenhum fluxo, mesmo indireto (ex.: incluído por engano numa campanha).
- **Testes de informação HIPÓTESE/NÃO VERIFICADO** — o agente nunca apresenta hipótese como fato, nem usa informação não verificada como base de decisão de execução.

Nenhum desses testes existe ainda, porque nenhum agente existe ainda.

## Consequências

- Fica definido, por escrito, o que qualquer agente futuro pode e não pode fazer sozinho — reduz o risco de um agente executar algo fora do que Breno autorizou.
- Cria um contrato único (esta decisão) que qualquer nova Skill ou agente deve respeitar, evitando que cada componente novo reinvente suas próprias regras de autonomia.
- Aumenta a carga de documentação antes da implementação — decisão consciente, alinhada ao princípio "uma etapa por vez" (Regra 10 do RULES.md) e ao ciclo CONSTRUIR → TESTAR → VALIDAR → DOCUMENTAR → APROVAR → AVANÇAR já registrado em 0001.

## Alternativas consideradas

- **Deixar a autonomia de cada agente ser decidida caso a caso, no momento da implementação.** Rejeitada: geraria inconsistência entre agentes e risco de um agente novo assumir mais autonomia do que deveria por falta de um padrão prévio.
- **Copiar o conteúdo das Skills para o projeto local para acesso mais rápido.** Rejeitada: cria uma segunda fonte de verdade, que diverge do Notion com o tempo (mesmo risco já identificado em `skills/README.md`).
- **Permitir que agentes de Nível 3 executem ações da lista da seção 4 sem aprovação individual, desde que "de baixo risco".** Rejeitada por ora: a lista da seção 4 (comunicação, CRM, agenda, dinheiro, dados de cliente, jurídico) é definida como sempre sujeita a aprovação humana, sem exceção por nível de autonomia, para manter o humano no controle (Regra 6 do RULES.md).
