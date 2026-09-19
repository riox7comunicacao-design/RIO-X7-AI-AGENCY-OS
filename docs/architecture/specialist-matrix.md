# Matriz de Especialistas — Equipe Virtual de IA da Rio X7

Este documento é documentação pura — **nenhum especialista aqui está implementado como agente executável**, salvo indicação explícita em contrário. Ele registra a arquitetura organizacional para orientar o que será construído, um especialista de cada vez, com autorização própria a cada etapa (Regra 10 do [RULES.md](../../RULES.md)).

## Princípio de design

Um especialista é uma **função de negócio**, não uma ferramenta externa. Ferramentas (WhatsApp, Instagram, e-mail, Meta Ads, Google Ads, CRM) são coisas que um especialista *usa* para cumprir sua função — nunca um especialista em si. Por isso a lista abaixo não contém "Agente WhatsApp" nem "Agente Meta": essas capacidades pertencem ao SDR e ao Gestor de Tráfego, respectivamente.

**Nota de identidade (0008.4):** o modelo de `USER`/`role`/`permission` definido em [0009-identity-roles-and-authorization-model.md](../decisions/0009-identity-roles-and-authorization-model.md) aplica-se a **humanos** (Breno, Closer) — nunca aos especialistas de IA listados aqui, que continuam identificados só como `actor: SYSTEM` (nunca `USER`, nunca podem `APPROVE`). COO e todos os demais especialistas mantêm exatamente as permissões já documentadas nesta matriz — nenhuma mudou nesta consolidação.

## Categorias

- **A) DEFINIDO** — função, limites e relação com outros especialistas já estão claros o bastante para orientar uma implementação futura (não significa que já está implementado em código).
- **B) A VALIDAR** — o conceito existe e tem requisitos parciais, mas depende de decisões humanas ainda pendentes antes de poder ser considerado definido.
- **C) FUTURO** — mencionado na visão do projeto, sem trabalho de definição ainda; não deve ser presumido necessário no curto prazo.

---

## A) ESPECIALISTAS DEFINIDOS

### 1. COO / Orquestrador

**Status: DEFINIDO** (consolidado na Auditoria 0008.1 / Consolidação 0008.2 — substitui a versão anterior deste especialista sem contradizê-la, apenas formalizando os limites que já estavam implícitos).

- **Função:** coordenar, rotear, encadear e consolidar o trabalho dos especialistas; nunca decide sozinho.

**O COO PODE:**
- Receber uma solicitação de tarefa.
- Interpretar o objetivo da solicitação.
- Escolher quais especialistas envolver.
- Encadear especialistas (passar a saída de um como entrada de outro).
- Consolidar resultados de múltiplos especialistas.
- Identificar pendências (ex.: dados insuficientes, decisão humana necessária).
- Solicitar aprovação humana.
- Delegar execução a especialistas já autorizados para aquela ação.

**O COO NÃO PODE (NÃO PERMITIDO):**
- Escrever diretamente dados operacionais (CRM ou qualquer outro).
- Movimentar CRM diretamente.
- Enviar mensagens.
- Publicar conteúdo.
- Alterar campanhas.
- Executar ações externas diretamente.
- Tomar decisões comerciais.
- Aprovar ações de negócio (só pode *solicitar* aprovação humana, nunca concedê-la em nome de um humano).

**Regra de leitura de dados (formalizada nesta consolidação):** o COO **não consulta fontes brutas diretamente** (não lê o CRM/Notion por conta própria). Ele só recebe informação através das saídas já produzidas pelos especialistas/serviços autorizados a ler aquela fonte. Não existe, e não deve existir, acesso direto irrestrito do COO ao CRM ou ao Notion.

**Regra de iniciativa (formalizada nesta consolidação):** o COO não inicia trabalho por conta própria. Todo encadeamento parte de uma solicitação ou de um evento explicitamente autorizado — nunca de uma decisão espontânea do próprio COO.

- **Entradas:** uma solicitação de tarefa (de Breno, do Closer, ou de outro especialista).
- **Saídas:** delegação para o especialista correto; consolidação de resultado.
- **Ferramentas:** nenhuma própria — opera através dos demais especialistas.
- **Ações que exigem aprovação humana:** sempre que delega uma ação de qualquer especialista que, por si, já exigiria aprovação (ver [human-approval-model.md](./human-approval-model.md), lista fixa — não um critério subjetivo de "sensibilidade").
- **Relação com outros:** conecta todos os demais especialistas; já descrito em [0002-execution-architecture.md](../decisions/0002-execution-architecture.md), seção 5 (tabela de agentes).
- **Status de implementação:** conceitual — não implementado em código.

### 2. Researcher

- **Função:** pesquisar informação pública sobre uma empresa/profissional específico, a partir de um critério já definido (nicho/ICP).
- **Responsabilidades:** consultar fontes públicas (site, Google/Maps, Instagram, Facebook, LinkedIn, YouTube, outras), registrar fonte + URL + data para cada dado, classificar cada campo como VALIDADO/HIPÓTESE/NÃO_VERIFICADO.
- **Limites:** nunca infere um dado a partir de outro (telefone→WhatsApp, site→e-mail, etc. — proibido desde [0004](../decisions/0004-controlled-web-research.md)); nunca contata ninguém; nunca decide se o candidato é relevante (isso é do Prospector).
- **Entradas:** nome/empresa candidato, ou critério de nicho/região a explorar.
- **Saídas:** achado bruto estruturado por campo, com evidências e fontes (formato já implementado em `discovery.js`, etapas IDENTIFICATION/CONFIRMATION).
- **Dados que consulta:** fontes públicas da internet; leitura do CRM (Notion) apenas para apoiar identificação, nunca para decidir duplicidade sozinho (isso é do Prospector).
- **Dados que altera:** nenhum — só produz um achado em memória/arquivo local.
- **Ferramentas:** navegador/busca web; leitura do Notion.
- **Ações que exigem aprovação humana:** nenhuma diretamente — é Nível 0/1 (leitura e preparação, conforme [0002](../decisions/0002-execution-architecture.md), seção 4).
- **Ações automáticas:** toda a pesquisa e classificação de campos.
- **Relação com outros:** entrega para o Prospector; hoje, no código, Researcher e Prospector são uma única implementação técnica (`discovery.js`) — ver seção "Nota sobre Researcher + Prospector" abaixo.
- **Status de implementação:** parcialmente implementado — `discovery.js` cobre IDENTIFICATION/CONFIRMATION; a pesquisa web em si é hoje feita por um agente de IA (Claude) navegando manualmente, não por uma automação própria.

### 3. Prospector

- **Função:** decidir, a partir dos achados do Researcher, quais candidatos entram na fila de revisão humana — aplicando deduplicação e DO NOT CONTACT.
- **Responsabilidades:** rodar a deduplicação oficial (domínio → telefone → Instagram → nome+cidade); verificar DNC contra o CRM (leitura); aplicar exclusões absolutas (ex.: "Agência Alfa Digital"); alimentar a fila de aprovação.
- **Limites:** nunca cria lead no CRM sozinho; nunca decide autonomamente expandir nicho/região além do briefing recebido (isso é DECISÃO HUMANA NECESSÁRIA, já registrado em [0003](../decisions/0003-research-prospector-module.md)); nunca transforma POSSÍVEL_DUPLICADO em DUPLICADO.
- **Entradas:** achados do Researcher + briefing de prospecção (nicho, quantidade desejada, região/escopo geográfico).
- **Saídas:** itens na fila de aprovação (ver `approvalQueue.js`), cada um com estado inicial `AGUARDANDO_REVISAO`, `DUPLICADO` ou `DADOS_INSUFICIENTES`.
- **Dados que consulta:** CRM (leitura), achados do Researcher.
- **Dados que altera:** a fila de aprovação local (nunca o CRM).
- **Ferramentas:** módulos `discovery.js`, `duplicateCheck.js`, `doNotContact.js`, `approvalQueue.js` (já implementados).
- **Ações que exigem aprovação humana:** criar um lead real no CRM (etapa futura, fora deste especialista).
- **Ações automáticas:** deduplicação, verificação de DNC, classificação de identidade/dados, roteamento para a fila.
- **Relação com outros:** recebe do Researcher; entrega para a fila de aprovação humana; a decisão final de aprovar/rejeitar é humana (Breno/Closer).
- **Status de implementação:** implementado em código (`discovery.js` + `approvalQueue.js`, Passos 2/2.1/3).
- **Estratégia de quantidade (novo, ainda não implementado):** "quantidade desejada" deve ser a meta principal; candidatos excedentes ficam em reserva para substituir duplicados/inválidos/inadequados — **isso ainda não está implementado no código** (hoje `discovery.js` processa todos os achados recebidos, sem noção de "quantidade alvo" nem "reserva"). Marcado como **FUTURO** (ver seção de não-decisões em [0008](../decisions/0008-specialist-team-architecture.md)).

### Nota sobre Researcher + Prospector

Na visão organizacional, são dois especialistas com responsabilidades distintas (pesquisar vs. decidir/filtrar). **Na implementação técnica atual, os dois vivem juntos no módulo `discovery.js`** — isso não é um erro, é o estado real do código hoje. Separar isso em dois módulos técnicos independentes é uma refatoração possível, não decidida, e **não foi feita neste passo** (instrução explícita de não alterar `src/research-prospector/*`).

### 4. SDR

- **Função:** conduzir a conversa de qualificação com o prospect, do primeiro contato até o agendamento com o Closer.
- **Responsabilidades:** pesquisar contexto antes de abordar; iniciar abordagem (mediante aprovação); responder e conduzir a conversa; qualificar; fazer follow-up conforme cadência; encaminhar para reunião; preparar briefing para o Closer.
- **Limites:** nunca fecha venda, nunca negocia preço, nunca cria desconto, nunca insiste após um "não" — todos já fixados na Skill nativa `RIO X7 SDR — Psicologia` (Notion). Escopo hoje: **só o nicho Psicologia** — expandir para outros nichos é DECISÃO HUMANA NECESSÁRIA (já registrado em 0003).
- **Entradas:** lead aprovado no CRM (com dados de pesquisa), histórico de conversa.
- **Saídas:** mensagens sugeridas (nunca enviadas sozinho), atualização sugerida de Status/Temperatura/Observações no CRM, briefing para o Closer quando qualificado.
- **Dados que consulta:** CRM (leitura), Skill SDR (Notion, lida em tempo de execução).
- **Dados que altera:** hoje, nenhum diretamente — toda alteração de CRM e todo envio de mensagem passam por aprovação humana (ver Skill, seção 13: "quem envia, hoje, é Breno").
- **Ferramentas:** WhatsApp, Instagram, e-mail (como canais de contato, sempre mediante aprovação), CRM.
- **Ações que exigem aprovação humana:** enviar qualquer mensagem/abordagem outbound; alterar CRM; agendar reunião.
- **Ações automáticas:** pesquisa de contexto, elaboração da mensagem sugerida, classificação de temperatura conforme critérios já fixados (FRIO/MORNO/QUENTE).
- **Relação com outros:** recebe do Prospector (via aprovação humana no CRM); é **independente do CRM AI** (instrução explícita deste passo — nunca fundir os dois); entrega briefing ao Closer Assistant/Closer humano.
- **Status de implementação:** Skill nativa existe e está documentada no Notion; nenhuma automação de execução (envio real) existe ainda.

### 9. Raio-X Digital

- **Função:** produzir o diagnóstico digital de um prospect/cliente, para uso interno e para apresentação na reunião com o Closer.
- **Responsabilidades:** aplicar o formulário universal de 10 perguntas; pesquisar a empresa e (quando relevante) concorrentes; classificar tudo como DADO/ANÁLISE/HIPÓTESE/NÃO_VERIFICADO; produzir os dois produtos (Relatório Interno de 23 seções + Apresentação Comercial de 12 slides); recomendar serviços só quando houver aderência real.
- **Limites:** nunca promete resultado; nunca cria pontuação/nota geral; nunca inventa dado; a decisão comercial final é sempre de Breno/Closer — todos já fixados na Skill nativa `RIO X7 Raio-X Engine — Universal` (Notion).
- **Entradas:** dados do CRM, respostas do formulário de 10 perguntas, pesquisa pública, contexto da reunião quando existir.
- **Saídas:** Relatório Interno, Apresentação Comercial (12 slides).
- **Dados que consulta:** CRM (leitura), fontes públicas.
- **Dados que altera:** campos de diagnóstico do CRM (Status do Diagnóstico, Link do Raio-X) — hoje sujeitos a aprovação humana antes de apresentar ao cliente.
- **Ferramentas:** pesquisa web, CRM.
- **Ações que exigem aprovação humana:** publicar/enviar a apresentação ao cliente.
- **Ações automáticas:** toda a pesquisa e montagem dos dois documentos.
- **Relação com outros:** recebe do SDR (quando o lead qualifica e agenda); alimenta a call do Closer.
- **Novidades deste passo (RECOMENDAÇÃO, não implementada):**
  - A proposta final deve permitir três condições comerciais **editáveis**: (1) fechamento na reunião, (2) resposta em até 24h, (3) resposta posterior/quando desejar — sem valores inventados, sem falsa urgência.
  - **Não inserir foto do Breno** na apresentação — restrição explícita registrada aqui.
  - Ambas as novidades acima ainda não existem na estrutura de 12 slides já documentada em 0003/na Skill nativa — ficam como **RECOMENDAÇÃO** para quando a Skill for revisada, não uma alteração feita agora (a Skill vive no Notion e não foi tocada).
- **Status de implementação:** Skill nativa completa e documentada no Notion; testada uma vez com empresa real (Passo 4.1, artifacts referenciados na página `RAIO-X`).

---

## B) ESPECIALISTAS A VALIDAR

**Nota desta consolidação (0008.2):** "CRM / Sales Ops" e "Follow-up" **saíram desta lista** — deixaram de ser tratados como candidatos a especialista de IA. Ver "CRM/Sales Ops e Follow-up — não são especialistas", logo após esta seção, para onde cada um foi realocado.

### Princípio SDR × CRM AI × CRM Services (DEFINIDO — consolidação 0008.3)

Três componentes distintos, nunca fundidos em um único agente:

| | Responsabilidade central |
|---|---|
| **SDR** | **Conversa.** Conversa com prospects; inicia abordagem autorizada; responde; conduz qualificação; faz follow-up; prepara handoff para o Closer; **pode propor** alterações/atualizações no CRM (nunca gravar sozinho — ver [permissions-matrix.md](./permissions-matrix.md)). |
| **CRM AI** | **Analisa.** Não conversa outbound com prospects na V1; analisa dados; resume histórico; identifica inconsistências; sugere próximas ações; sugere movimentações; auxilia organização do pipeline; gera insights. |
| **CRM Services** | **Persiste e aplica regras.** Camada de serviço (não especialista — ver "CRM/Sales Ops... não são especialistas" abaixo): persiste dados; valida regras; executa movimentações **já autorizadas**; mantém integridade; registra histórico/auditoria. |

**Regra fixa:** nenhum desses três componentes pode absorver a responsabilidade central de outro. Qualquer futura capacidade de conversa do CRM AI — mesmo que só com clientes já fechados, nunca com prospects — exige uma nova decisão arquitetural explícita; não se presume que a proibição de outbound com prospects abre espaço automático para outro tipo de conversa.

### 6. CRM AI / Atendimento

**Uma decisão já está DEFINIDA para V1 (consolidação 0008.2, reafirmada em 0008.3):** **CRM AI não fará conversação outbound com prospects.** Essa responsabilidade pertence exclusivamente ao SDR.

- **Fronteira definida:** SDR = relacionamento comercial outbound (ver tabela acima). CRM AI = inteligência sobre os dados e a operação do CRM (não conversa com prospect).
- **Função pretendida (orientação conceitual):** interpretar dados; resumir histórico; identificar inconsistências; sugerir ações; sugerir movimentações de estágio; auxiliar na organização do pipeline; produzir insights.
- **Explicitamente não deve ser criado como substituto do SDR.**
- **Status de implementação:** conceitual — nada implementado.
- **O que ainda falta decidir (DECISÃO PENDENTE):** os limites operacionais exatos de "auxiliar organização do pipeline" e "sugerir movimentações" — por exemplo, se o CRM AI pode gravar uma sugestão diretamente como rascunho no CRM ou só reportar para um humano decidir (a execução real de qualquer movimentação, uma vez autorizada, é sempre do CRM Services, nunca do CRM AI diretamente); e onde termina seu escopo em relação ao Customer Success (item 18, FUTURO), que também tocará clientes já fechados.
- **Qualquer futura capacidade de conversa do CRM AI (mesmo que só com clientes já fechados, não prospects) exige uma nova decisão arquitetural explícita** — não presumir que a proibição de outbound com prospects abre espaço automático para conversar com clientes.

### 7. Closer Assistant

- **Função pretendida:** preparar o Closer (humano) para a reunião — resumir Raio-X, histórico do lead, sugerir perguntas.
- **O que já está definido:** o Closer é o parceiro comercial de Breno; Closer pode autorizar o SDR (mesmo nível que Breno para essa ação específica).
- **O que falta decidir:** quais outros poderes o Closer tem além de autorizar o SDR — **DECISÃO PENDENTE**, marcado explicitamente para não presumir nada além do já definido.
- **Dependência:** consome a saída do Raio-X Digital e do histórico do SDR.

### 22. QA

**Decisão consolidada (0008.2): QA é tratado em duas camadas, não como uma única classificação.**

- **Camada 1 — QA de domínio: CAPACIDADE DE QUALIDADE DEFINIDA.** Cada especialista mantém suas próprias regras de qualidade, já documentadas onde o especialista existe de fato:
  - **SDR:** não inventar; respeitar aprovação; respeitar DNC; não prometer resultados; comunicação adequada (já fixado na Skill nativa, seção "QA — critério de revisão").
  - **Raio-X:** separar DADO/ANÁLISE/HIPÓTESE/NÃO_VERIFICADO; não inventar métricas; não prometer resultados; manter evidências (já fixado na Skill nativa, seção "QA obrigatório").
  - Isso já existia desde [0002](../decisions/0002-execution-architecture.md) ("QA vive dentro de cada Skill por enquanto") — esta consolidação apenas formaliza que essa camada **é** a forma definida de QA para os especialistas que já existem, não um estado provisório a substituir.
- **Camada 2 — QA transversal: ESPECIALISTA TRANSVERSAL FUTURO / A VALIDAR.** Um futuro especialista/módulo de QA poderia validar entregáveis **entre** áreas do pipeline de conteúdo (Copy, Design, Vídeo, Social, Tráfego, Web, outros) — nenhum desses especialistas existe ainda, então esta camada não tem urgência. **Não implementar agora.**

---

## CRM/Sales Ops e Follow-up — não são especialistas

**Decisão consolidada (0008.2):** nenhum dos dois entra na lista de especialistas de IA na V1.

### CRM / Sales Ops → infraestrutura/serviço, não especialista

O banco `RIO X7 — Pipeline Comercial` no Notion já funciona como o CRM operacional (schema completo já auditado; view "Pipeline" já é um Kanban por Status). A decisão é **não** criar um segundo "cérebro" de vendas de IA competindo com o SDR. `CRM/Sales Ops` é tratado como:
- infraestrutura operacional / camada de dados;
- um conjunto de serviços/regras determinísticas (validação, movimentação controlada de estágio, deduplicação, histórico, auditoria, permissões, regras de negócio, integridade de dados) — ver "Camadas do Sistema" em [0008](../decisions/0008-specialist-team-architecture.md).

O modelo **pode evoluir** no futuro para incluir um especialista dedicado, **se e quando** houver necessidade real de monitoramento/relatórios especializados que a camada de serviço sozinha não resolva — isso não está decidido, fica registrado como possibilidade, não como plano.

### Follow-up → capacidade do SDR, não especialista

**Decisão:** não criar Follow-up como especialista independente na V1. Follow-up permanece uma capacidade do SDR, exatamente como já documentado na Skill nativa `RIO X7 SDR — Psicologia` (seção 11: follow-up 1/2/final, com condição de parada).

**Arquitetura futura recomendada (RECOMENDAÇÃO, não implementada):** um módulo determinístico compartilhado — um "Cadence Engine" — poderia calcular quando fazer follow-up e a condição de parada/cadência, reutilizável por qualquer especialista dono de um relacionamento (SDR hoje; Onboarding/Customer Success no futuro). Esse módulo **nunca decidiria o conteúdo da mensagem** — isso continua sendo do especialista responsável pelo relacionamento. **Status: FUTURO/RECOMENDAÇÃO — não implementar agora.**

## C) ESPECIALISTAS FUTUROS

Mencionados na visão do projeto, sem definição de função/limites feita neste passo — **não presumir que algum deles é necessário no curto prazo**:

10. **Data Analyst** — consolidação de métricas de operação (já esboçado como "DATA / ANALYTICS" em 0002, seção 5).
11. **Copywriter** — produção de texto para conteúdo/campanhas.
12. **Designer** — produção de peças visuais.
13. **Editor de Vídeo** — edição de vídeo para conteúdo/campanhas.
14. **Social Media** — gestão de publicação em redes sociais (área "MARKETING" no Notion, hoje reservada/vazia).
15. **Gestor de Tráfego** — gestão de Meta Ads, Google Ads, TikTok Ads como ferramentas de uma única função (não um agente por plataforma).
16. **Web Developer** — criação/manutenção de sites (área "WEB" no Notion, hoje reservada/vazia).
17. **Onboarding** — processo pós-fechamento (já esboçado em 0002, seção 5).
18. **Customer Success** — atendimento a clientes ativos (já esboçado em 0002, seção 5; possível sobreposição com CRM AI, ver item 6).
19. **Financeiro** — qualquer ação financeira já exige aprovação humana sempre (ver [human-approval-model.md](./human-approval-model.md)); nenhuma automação prevista neste horizonte.
20. **Administrativo** — sem escopo definido ainda.
21. **ADV / Jurídico** — qualquer ação jurídica já exige aprovação humana sempre; nenhuma automação prevista.

## Dependências entre especialistas (visão de fluxo, não rígida)

Consolidado em 0008.2 — não é uma cadeia obrigatória de passo único; é a ordem típica quando tudo acontece.

```
Researcher → Prospector → Lead Approval (Approval Queue existente) → CRM → SDR → Raio-X Digital → Closer Assistant → Closer (humano)
                                                                       ↑
                                                        Outbound Approval (conceitual, FUTURO — ver human-approval-model.md)
                                                        sempre antes de qualquer abordagem real do SDR;
                                                        distinta e nunca reaproveitando a máquina de estados do Lead Approval.

COO pode coordenar/rotear a partir de qualquer ponto desta linha — não fica preso a uma posição fixa.

CRM AI atua sobre os dados/operação do CRM, em paralelo — NÃO substitui o SDR nem entra nesta linha como uma etapa sequencial.

QA (camada 1) atravessa cada etapa por dentro da própria Skill de quem a executa (SDR, Raio-X) — não é um nó à parte no fluxo.
QA (camada 2, transversal) é FUTURO e, se implementado, atravessaria o pipeline de conteúdo (Copy/Design/Vídeo/Social/Tráfego/Web), não esta linha.

Cadence Engine (futuro/recomendação) seria consultado pelo SDR hoje, e por Onboarding/Customer Success no futuro — não é uma etapa fixa, é um serviço chamado quando necessário.

CRM/Sales Ops (infraestrutura/dados) ← consultado por quase todos os especialistas acima, em qualquer ponto.

Data Analyst / Gestor de Tráfego / Social Media / Copywriter / Designer / Editor de Vídeo / Web Developer
    ← todos FUTUROS, dependem de haver conteúdo/campanha real para analisar/produzir
Onboarding / Customer Success ← dependem de um cliente fechado (Status = WON) existir
Financeiro / Administrativo / Jurídico ← transversais, acionados sob demanda, sempre com aprovação humana
```
