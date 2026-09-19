# 0008 — Arquitetura da Equipe de Especialistas de IA

## Status

Documentação arquitetural (nenhum código implementado por esta decisão). Registrado em 2026-09-18.

## Contexto

Até este ponto, o projeto implementou uma única linha de execução técnica (Researcher + Prospector, via `discovery.js`, e a fila de aprovação humana via `approvalQueue.js` — Passos 0 a 3). Antes de continuar implementando funcionalidades, a Rio X7 precisa definir como sua futura equipe virtual de especialistas de IA se organiza como um todo — quais papéis existem, quais limites cada um tem, quais dados cada um pode tocar, e como a aprovação humana já praticada (Regra 6 do [RULES.md](../../RULES.md); [0002](./0002-execution-architecture.md)) se aplica a cada um deles.

## Problema

Sem esse mapa, cada novo especialista corre o risco de ser especificado ad hoc, com regras inconsistentes entre si, ou de duplicar responsabilidade com um especialista vizinho (o próprio processo deste passo já encontrou um caso concreto: "Follow-up" como especialista separado vs. função já embutida na Skill SDR — ver seção "Conflitos encontrados"). Também existe o risco de acoplar demais a lógica dos especialistas ao Notion, dificultando uma futura migração para um Dashboard/API próprios.

## Decisões

1. **Um especialista é uma função de negócio, nunca uma ferramenta.** WhatsApp, Instagram, e-mail, Meta Ads, Google Ads e CRM são ferramentas usadas por especialistas (SDR, Gestor de Tráfego), nunca especialistas em si.
2. **SDR e CRM AI/Atendimento permanecem especialistas distintos**, mesmo que ambos toquem o CRM — instrução explícita deste passo, registrada para nunca serem fundidos numa implementação futura.
3. **A lista de ações que sempre exigem aprovação humana** (0002, seção 4) foi consolidada e estendida em [human-approval-model.md](../architecture/human-approval-model.md), sem remover nenhum item anterior.
4. **Breno é ADMIN.** O Closer tem, hoje, exatamente um poder confirmado (autorizar o SDR) — nenhum poder adicional foi presumido.
5. **A granularidade da autorização de outbound do SDR (por campanha, por lead, ou ambos) não foi decidida.** Uma recomendação foi registrada separadamente em [human-approval-model.md](../architecture/human-approval-model.md), explicitamente marcada como recomendação, não decisão.
6. **A estratégia de "quantidade desejada + reserva de extras" para o Prospector foi registrada como especificação futura**, não implementada — o código atual (`discovery.js`) processa todos os achados recebidos, sem essa noção.
7. **Nenhum score, ranking, nota ou temperatura comercial automática foi criado** para nenhum especialista — reafirmação, não uma regra nova (já valia desde 0002/0006).
8. **A arquitetura de dados deve, no futuro, permitir `Dashboard → API/serviços → dados → especialistas`** sem reescrever a lógica de cada especialista — hoje, na prática, o Notion continua sendo o backend real desse modelo de dados; isso é uma intenção arquitetural registrada, não uma migração iniciada.

## Não-decisões (registradas explicitamente, para não serem esquecidas nem presumidas)

- Fronteira exata entre SDR e CRM AI/Atendimento na prática.
- Poderes do Closer além de autorizar o SDR.
- Granularidade da autorização de outbound (campanha/lead/ambos).
- Se "Follow-up" é um especialista próprio ou permanece dentro do SDR.
- Se "QA" deve virar um especialista transversal ou continuar embutido em cada Skill.
- Se "CRM/Sales Ops" é um especialista de IA ou apenas a infraestrutura de dados usada pelos demais.
- Extensão de schema do CRM (Proprietário, Facebook, LinkedIn, valor de proposta, valor total, alternância AI/HUMAN, evidências/fontes estruturadas por campo).
- Arquitetura técnica do futuro Dashboard/API.

## Princípios (reafirmados, não novos)

- Human in the loop (Regra 6 do RULES.md).
- Não inventar dado, nem inferir contato privado (Regra 1; 0004).
- Preferir falso negativo a falso positivo em deduplicação/identidade (0005; 0006).
- Não duplicar fonte de verdade sem necessidade (0002).
- Uma etapa por vez, com autorização própria a cada uma (Regra 10).

## Dependências

Ver diagrama de fluxo em [specialist-matrix.md](../architecture/specialist-matrix.md) ("Dependências entre especialistas"). Resumo: Researcher → Prospector → Fila de Aprovação → CRM → SDR → Raio-X Digital → Closer Assistant → Closer humano, com CRM/Sales Ops e QA como domínios transversais consultados por quase todos.

## Riscos

- **Sobreposição SDR × CRM AI × Customer Success** se a fronteira entre eles não for decidida antes de qualquer implementação — risco identificado, não resolvido aqui.
- **Divergência entre o modelo de dados "ideal" (Dashboard → API → dados) e o Notion real hoje** — se a diferença crescer sem revisão periódica, uma futura migração fica mais cara. Mitigação sugerida (não implementada): revisar este documento sempre que um novo especialista for de fato implementado.
- **Fila de aprovação (`approvalQueue.js`) crescer organicamente para dentro do território do SDR** sem uma decisão consciente — ver seção dedicada abaixo.

## Implicação para o Approval Queue existente

`approvalQueue.js` (Passo 3) **não foi alterado nem removido** nesta etapa — esta seção só avalia onde ele se encaixa na arquitetura de especialistas agora desenhada.

**Responsabilidades que parecem pertencer a ele:**
- Ser a barreira entre a saída do Prospector e a criação de um lead real no CRM — exatamente o papel que já cumpre hoje (`AGUARDANDO_REVISAO` → `APROVADO_PARA_CRM`/`REJEITADO`, sempre por ação humana).
- Registrar auditoria de quem aprovou/rejeitou o quê, quando e por quê — já implementado (`historico`, `actor`, `reviewer`, `motivo`).
- Bloquear duplicidade e DNC antes de qualquer decisão humana chegar a acontecer — já implementado.

**Responsabilidades que NÃO deveriam pertencer a ele:**
- Conduzir ou registrar a conversa de qualificação do SDR — isso é do SDR, não da fila de aprovação de prospects. A fila decide *se um candidato pode virar lead*; não decide *como ele é abordado depois*.
- Autorizar outbound (envio de mensagem) — é uma decisão diferente de "aprovar para CRM", tratada no modelo de aprovação humana ([human-approval-model.md](../architecture/human-approval-model.md)), possivelmente com sua própria granularidade (campanha/lead).
- Armazenar histórico de conversa com o prospect/cliente — isso pertence ao domínio do CRM (Notion) ou, futuramente, ao CRM AI/Atendimento, não à fila local de pré-aprovação.
- Ser a fonte de verdade de Status/Temperatura do lead depois que ele já está no CRM — a fila cobre só a fase pré-CRM.

**Decisões que ainda precisam ser tomadas:**
- Quando (e como) um item `APROVADO_PARA_CRM` na fila deve, de fato, virar um registro real no CRM — isso é o "Passo 4" já sugerido, ainda não autorizado.
- Se a fila deve ser descontinuada depois que o lead entra no CRM (ficando só como histórico), ou se continua sendo consultada depois.
- Se o mesmo mecanismo de fila (estados, transições, auditoria) deve ser reaproveitado para outras aprovações futuras (ex.: aprovação de campanha do Gestor de Tráfego) ou se cada domínio deveria ter sua própria fila.

**Riscos de acoplar o Approval Queue diretamente ao SDR:**
- Misturaria duas decisões humanas com semânticas diferentes ("este candidato é relevante o suficiente para virar lead" vs. "estou autorizando o SDR a abordar este lead agora") num único estado — perderia a distinção fina que o modelo de aprovação de outbound (por campanha/lead) precisa.
- Um `APROVADO_PARA_CRM` poderia ser mal-interpretado, no futuro, como "autorizado para contato" — exatamente o erro que este projeto já evitou explicitamente desde o Passo 1.6 ("NOVO ≠ APROVADO", "APROVADO_PARA_CRM não significa crie agora no CRM"). Acoplar ao SDR aumentaria esse risco de confusão semântica.
- Dificultaria testar e auditar cada barreira separadamente (a fila já tem 23 testes cobrindo exatamente seu escopo atual; misturar responsabilidades exigiria redesenhar esses testes).

Nenhuma dessas decisões foi tomada aqui — ficam registradas para quando o Passo 4 (ou equivalente) for autorizado.

## Conflitos encontrados com a arquitetura anterior

Nenhum conflito de fato — a arquitetura anterior (0001–0007) permanece válida e não foi contradita. Um ponto de atenção, não um conflito, foi identificado:

- **Follow-up como especialista (item 8 da lista deste passo) vs. cadência de follow-up já documentada dentro da Skill SDR** (seção 11 da Skill nativa, Notion). Não há contradição factual — apenas uma sobreposição de escopo a resolver antes de especificar "Follow-up" como especialista independente. Registrado como decisão pendente em [specialist-matrix.md](../architecture/specialist-matrix.md), seção B.8.

## Consolidação 0008.2 — evolução desta decisão (pós-Auditoria 0008.1)

Esta seção **não substitui** as decisões 1–8 registradas acima — ela registra decisões adicionais tomadas depois que a Auditoria 0008.1 encontrou pontos em aberto na versão original deste documento. Onde uma decisão original ficava em aberto (seção "Não-decisões"), o item correspondente foi resolvido ou permanece pendente, conforme detalhado abaixo — nenhuma decisão original foi apagada ou reescrita para parecer diferente do que foi.

### Decisões resolvidas nesta consolidação

9. **COO/Orquestrador — fronteira formalizada.** O que pode (receber solicitação, interpretar objetivo, escolher/encadear especialistas, consolidar, identificar pendências, solicitar aprovação) e o que não pode (escrever dados, movimentar CRM, enviar mensagem, publicar, alterar campanha, executar ação externa, decidir/aprovar negócio) está agora explícito em [specialist-matrix.md](../architecture/specialist-matrix.md). Formalizado também: o COO nunca lê fonte bruta diretamente (só saídas de especialistas), e nunca inicia trabalho sem solicitação/evento autorizado.
10. **CRM/Sales Ops — não é especialista de IA na V1.** É tratado como infraestrutura operacional / camada de dados / conjunto de serviços determinísticos (validação, movimentação controlada de estágio, deduplicação, histórico, auditoria, permissões, integridade). Pode evoluir para incluir um especialista dedicado no futuro, **se e quando** houver necessidade real de monitoramento/relatório que a camada de serviço não resolva sozinha — isso não está decidido, só registrado como possibilidade.
11. **CRM AI — uma fronteira específica com o SDR está definida.** CRM AI **não fará conversação outbound com prospects** nesta V1; essa responsabilidade é exclusiva do SDR. CRM AI continua "a validar" como especialista de inteligência (interpretar dados, resumir histórico, identificar inconsistências, sugerir ações/movimentações) — mas essa fronteira específica deixou de ser uma não-decisão. Qualquer futura capacidade de conversa do CRM AI (mesmo só com clientes já fechados) exige nova decisão explícita.
12. **Follow-up — não é especialista independente na V1.** Permanece capacidade do SDR, como já documentado na Skill nativa. Recomendação registrada (não implementada): um "Cadence Engine" compartilhado, determinístico, calculando apenas quando/parar o follow-up — nunca o conteúdo da mensagem — reutilizável por futuros especialistas de relacionamento (Onboarding, Customer Success).
13. **QA — duas camadas, ambas com papel definido.** Camada 1 (QA de domínio, embutido em cada Skill — SDR, Raio-X) é tratada como **capacidade de qualidade já definida**, não mais um estado provisório. Camada 2 (QA transversal, cobrindo o futuro pipeline de conteúdo — Copy/Design/Vídeo/Social/Tráfego/Web) permanece **especialista transversal futuro / a validar**, sem urgência (nenhum desses especialistas existe ainda).
14. **Outbound do SDR nunca reaproveita o Approval Queue existente (Lead Approval).** Independentemente de como a granularidade de autorização de outbound for decidida (item ainda pendente, ver abaixo), fica definido que essa autorização não compartilha a máquina de estados de `approvalQueue.js` — são perguntas de natureza diferente ("este achado pode virar lead?" vs. "posso contatar este lead agora?"). Detalhado em [human-approval-model.md](../architecture/human-approval-model.md).

### Não-decisões atualizadas (substituem a lista original — itens resolvidos foram removidos, novos itens foram adicionados)

- Fronteira operacional completa entre SDR e CRM AI, além da já resolvida "CRM AI não faz outbound" — ex.: quem registra interação de fato, quem pode sugerir movimentação de estágio.
- Poderes do Closer além de autorizar o SDR.
- Granularidade da autorização de outbound (campanha/lead/ambos) — recomendação registrada em [human-approval-model.md](../architecture/human-approval-model.md), ainda não decidida.
- Extensão de schema do CRM (Proprietário, Facebook, LinkedIn, valor de proposta, valor total, evidências/fontes estruturadas por campo).
- Arquitetura técnica do futuro Dashboard/API.
- **(Novo)** Modelo de identidade estruturada do `reviewer` no Approval Queue (`userId`/`role` em vez de texto livre) — requisito registrado; **parcialmente implementado no Passo 0009.2** (validação de forma + permissão declarada, sem autenticação real — ver 0009, "Atualização (Passo 0009.2)").
- **(Novo)** Schema do domínio "Conversas" (fonte, formato, por canal) — pré-requisito para o modo AI/HUMAN e para qualquer especialista de atendimento avançar.
- **(Novo)** Se/quando implementar o modo `AI`/`HUMAN` com pausa/reativação e auditoria de handoff no CRM.
- **(Novo)** Desenho dos futuros domínios de um eventual "Approval Service" (Outbound/Publishing/Campaign/Financial Approval) além do já existente Lead Approval.

## Camadas do sistema (formalizado em 0008.2)

### Camada 1 — Especialistas de IA

- **Núcleo (DEFINIDO):** COO, Researcher, Prospector, SDR, Raio-X Digital.
- **Apoio a validar:** CRM AI, Closer Assistant, QA (camada transversal).
- **Futuros:** Data Analyst, Copywriter, Designer, Editor de Vídeo, Social Media, Gestor de Tráfego, Web Developer, Onboarding, Customer Success, Financeiro, Administrativo, ADV/Jurídico.
- Follow-up **não** é especialista (capacidade do SDR). CRM/Sales Ops **não** é especialista (infraestrutura).

### Camada 2 — Serviços/Engines (conceitual — nada implementado nesta consolidação além do que já existia)

- **CRM Services** — validação, movimentação controlada de estágio, integridade (hoje: parcialmente o próprio Notion; camada de serviço dedicada é FUTURO).
- **Approval Service** — hoje, só o domínio "Lead Approval" existe (`approvalQueue.js`); Outbound/Publishing/Campaign/Financial Approval são FUTURO.
- **Cadence Engine** — FUTURO/RECOMENDAÇÃO (ver Follow-up acima).
- **Validation** — hoje implementado dentro de `discovery.js` (identidade/dados) e `candidate.js`.
- **Deduplication** — hoje implementado em `duplicateCheck.js`/`normalize.js`.
- **DO NOT CONTACT** — hoje implementado em `doNotContact.js`.
- **Permission/Authorization** — hoje é a lista fixa de `human-approval-model.md`, aplicada por convenção/documentação; não há um serviço técnico central que a imponha ainda (risco já registrado em 0008.1).
- **Audit** — hoje implementado dentro de `approvalQueue.js` (`historico`); não existe para outros domínios (ex.: conversas) ainda.

Nenhum serviço novo foi criado por esta consolidação — a lista acima só nomeia o que já existe tecnicamente e o que ainda é conceitual.

### Camada 3 — Dados

Ver domínios completos, com fonte/leitura/escrita/aprovação, em [data-domains.md](../architecture/data-domains.md): Prospects, Empresas/Contatos, Conversas (pendente), CRM, Reuniões, Propostas, Clientes, Conteúdo, Campanhas, Financeiro, Documentos/Jurídico, Auditoria.

## Princípio — Rio X7 como sistema futuro

Registrado nesta consolidação: a Rio X7 não está construindo apenas automações isoladas. Está construindo um sistema operacional interno de agência baseado em especialistas, serviços, dados, permissões, auditoria, aprovação humana e uma futura interface própria. Partes desse sistema **poderão**, no futuro, virar produto SaaS para clientes da Rio X7 — isso é um horizonte registrado, não uma decisão de produto, e **nada relacionado a SaaS é implementado nesta ou em nenhuma etapa até agora**.

## Consolidação 0008.3 — fechamento de decisões estruturais

Evolução adicional sobre 0008.2 (que, por sua vez, evoluiu 0008 original) — nenhuma decisão anterior foi reescrita ou apagada.

### Decisões definitivamente consolidadas nesta etapa

15. **Princípio SDR × CRM AI × CRM Services (DEFINIDO).** Três componentes nunca fundidos: **SDR conversa** (com prospects, mediante autorização); **CRM AI analisa** (dados/histórico/pipeline, nunca conversa outbound com prospect); **CRM Services persiste e aplica regras** (só ações já autorizadas — nunca decide por iniciativa própria). Detalhado em [specialist-matrix.md](../architecture/specialist-matrix.md).
16. **Modelo de outbound de dois níveis (DEFINIDO em nível conceitual, não implementado).** Autorização de campanha + autorização individual do lead (que pode autorizar, bloquear ou substituir a da campanha); DNC sempre vence qualquer autorização, em qualquer nível. Fluxo: `CAMPAIGN AUTHORIZATION → LEAD ELIGIBILITY → DNC CHECK → INDIVIDUAL OVERRIDE → OUTBOUND AUTHORIZED → SDR`. Detalhado em [human-approval-model.md](../architecture/human-approval-model.md). **A granularidade fina de aplicação e os poderes adicionais do Closer permanecem DECISÃO PENDENTE** — o que ficou definido é a existência e a ordem dos dois níveis, não todos os detalhes de aplicação.
17. **Lead Approval ≠ Outbound Approval (reafirmado e detalhado).** `approvalQueue.js` continua sendo exclusivamente Lead Approval ("este prospect pode entrar no CRM?"). Outbound Approval ("podemos contatar este lead?") é um domínio conceitual separado, não implementado, que nunca reaproveita a mesma máquina de estados.
18. **Modelo conceitual mínimo do domínio Conversations (DEFINIDO em nível conceitual, schema físico ainda pendente).** `CONVERSATION { conversationId, contactId, companyId, channel, messages[], mode, actor, timestamp, approval/audit metadata }`, com `channel` abstrato (`WHATSAPP`/`INSTAGRAM`/`EMAIL`/`OUTRO`, nenhum integrado), `messages` distinguindo `AI`/`HUMAN`/`CONTACT`, e `mode` (`AI`/`HUMAN`). Detalhado em [data-domains.md](../architecture/data-domains.md). Nenhum provedor/API foi escolhido.
19. **Modo AI/HUMAN — auditoria refinada.** Campos mínimos de auditoria de handoff: `actor`, `timestamp`, `previousMode`, `newMode`, `motivo/contexto`. Continua sendo requisito do domínio Conversations (pendente), não implementado.

### Reafirmações (já decididas em 0008.2, sem mudança de mérito nesta etapa)

- CRM/Sales Ops não é especialista de IA na V1 (infraestrutura/serviços).
- Follow-up não é especialista de IA na V1 (capacidade do SDR; Cadence Engine é recomendação futura).
- QA em duas camadas (domínio, já definida; transversal, futuro/a validar).
- Camadas do sistema (Especialistas / Serviços-Engines / Dados) — Camada 2 agora nomeia explicitamente "Lead Approval" como o único domínio de Approval Service que já existe.
- Dashboard não deve conter regra crítica de negócio; `PROPOSE ≠ WRITE` na matriz de permissões.

### Não-decisões que permanecem em aberto após 0008.3

- Fronteira operacional fina SDR × CRM AI, além do já resolvido "CRM AI não faz outbound".
- Poderes do Closer além de autorizar o SDR.
- Granularidade fina de aplicação do modelo de outbound de dois níveis (quais critérios tornam um lead "elegível" dentro de uma campanha já autorizada).
- Identidade estruturada do `reviewer` (userId/role) — requisito registrado; parcialmente implementado no Passo 0009.2 (ver 0009). Autenticação real, provedor e banco de usuários continuam em aberto.
- Schema físico/técnico do domínio Conversations.
- Implementação do modo AI/HUMAN.
- Extensão de schema do CRM.
- Arquitetura técnica do Dashboard/API.
- Desenho completo dos domínios futuros de um eventual Approval Service universal.

### Escopo explicitamente não autorizado nesta etapa (reafirmado)

Nenhuma das seguintes ações foi executada, e nenhuma está autorizada por este documento: Passo 4 (CRM write), implementação de CRM AI, schema físico de Conversations, implementação de AI/HUMAN, implementação de autorização de outbound, integração WhatsApp/Instagram/e-mail, Dashboard, autenticação de usuários, Approval Service universal. Tudo isso permanece como próximo trabalho, sujeito a autorização própria.

## Consolidação 0008.4 — identidade, roles e autorização

O modelo conceitual de identidade estruturada (entidade `USER`, roles `ADMIN`/`COMMERCIAL_CLOSER`, princípio `ROLE ≠ PERMISSION`, entidade genérica `APPROVAL`, enum `APPROVAL_TYPE`, e a camada explícita de Autorização entre API/Services e Data/Specialist) foi registrado em documento próprio: [0009-identity-roles-and-authorization-model.md](./0009-identity-roles-and-authorization-model.md) — dado o volume e a coesão do conteúdo, seguindo o mesmo padrão de "uma decisão coesa, um documento" já usado por 0001–0008.

Resolvido nesta rodada: a lacuna do `reviewer` em texto livre (identificada na Auditoria 0008.1) agora tem um modelo conceitual de substituição (`reviewedBy: userId`) — **não implementado nesta consolidação**; `approvalQueue.js`/`approvalQueue.test.js` permanecem exatamente como estavam nesta etapa. **Atualização:** a implementação parcial aconteceu no Passo 0009.2, posterior a esta consolidação (ver 0009, "Atualização (Passo 0009.2)") — `approveProspect`/`rejectProspect` agora exigem `identity` estruturado. Permanece pendente: tudo relacionado a autenticação real, provedor, banco de usuários, e a granularidade final de permissões — ver 0009, seção "Decisões pendentes".

## Próximos passos (sugestão, não autorização)

1. Resolver as decisões pendentes de maior impacto que restaram após 0008.4 (fronteira operacional fina SDR × CRM AI; granularidade fina do modelo de outbound; escolha de provedor de identidade/autenticação) antes de especificar esses pontos em código.
2. Quando autorizado, desenhar o "Passo 4" (conexão controlada entre `APROVADO_PARA_CRM` e a criação real no CRM), respeitando as responsabilidades do Approval Queue (Lead Approval) já delimitadas.
3. Definir o schema físico do domínio "Conversations" antes de avançar em qualquer especialista de atendimento (CRM AI) ou no modo AI/HUMAN.
4. ~~Quando autorizado, desenhar a substituição de `reviewer` (texto livre) por `reviewedBy: userId` em `approvalQueue.js`, seguindo o modelo de [0009](./0009-identity-roles-and-authorization-model.md).~~ Feito no Passo 0009.2 (identidade estruturada + permissão declarada; autenticação real continua pendente).
5. Revisar este documento sempre que um novo especialista for de fato implementado, para manter a matriz fiel à realidade (mesmo princípio já seguido pelos documentos 0001–0007).
