# 0003 — Especificação do Módulo RESEARCH + PROSPECTOR

> **Nota de estado atual (2026-09-24):** este documento é um registro histórico, escrito quando o Notion era a fonte de verdade do CRM/Pipeline Comercial. Essa parte foi **revogada** pela [decisão 0012](./0012-crm-operational-source-of-truth.md) (2026-09-23): hoje o CRM operacional é o do próprio Rio X7 AI Agency OS (`src/crm` → CRM Service → API `/api/crm` → Dashboard) — o estado atual está em [CONTINUE-HERE](../operations/CONTINUE-HERE.md). O texto original abaixo foi preservado como histórico: onde ele disser que o CRM está no Notion, leia "estava". O Notion segue como base de conhecimento e repositório das Skills.

## Status

Especificado (documentação conceitual). **Nada aqui está implementado.** Nenhum código, agente ou automação foi criado. Registrado em 2026-09-16, com base em [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md), [RULES.md](../../RULES.md), [docs/architecture/README.md](../architecture/README.md), [0001-initial-architecture.md](./0001-initial-architecture.md), [0002-execution-architecture.md](./0002-execution-architecture.md), [skills/README.md](../../skills/README.md), e em leitura direta (somente leitura) do Notion: `RIO X7 — Pipeline Comercial`, `RIO X7 — Central Comercial`, `RIO X7 SDR — Psicologia`, `RIO X7 Raio-X Engine — Universal`.

## Contexto

O módulo RESEARCH + PROSPECTOR é o primeiro elo da tabela de agentes futuros já registrada em 0002 (seção 5). Ele existe para, futuramente, ajudar a Rio X7 a encontrar empresas potenciais, pesquisar informação pública sobre elas, identificar oportunidades comerciais, evitar duplicidade no CRM, respeitar `DO NOT CONTACT`, e preparar dados estruturados para o CRM e para a Skill SDR. A decisão comercial final continua sempre humana; o módulo não fecha venda, não decide sozinho quem prospectar de verdade, e não cria lead no CRM sem aprovação.

## Problema

Ainda não existe especificação técnica de como RESEARCH e PROSPECTOR devem funcionar juntos, quais entradas eles aceitam, o que fazem quando a informação é insuficiente ou contraditória, como evitam duplicidade e violação de `DO NOT CONTACT`, e qual formato de saída entregam antes de qualquer coisa tocar o CRM real. Sem essa especificação, uma implementação futura correria o risco de inventar critérios não documentados ou de criar duplicidade/contato indevido.

## Decisão

Adotar a especificação abaixo como referência obrigatória para uma implementação futura do módulo RESEARCH + PROSPECTOR. Nenhuma parte é implementada nesta etapa.

---

## 1. Objetivo do módulo

**O que ele faz:** pesquisa informação pública sobre empresas/profissionais dentro de um nicho e ICP já documentados, verifica duplicidade contra o CRM, verifica restrição `DO NOT CONTACT`, e produz uma lista estruturada de candidatos a lead com fontes e nível de confiança de cada dado — pronta para revisão humana antes de virar registro real no CRM.

**O que ele NÃO faz:** não cria lead no CRM sozinho; não decide que um lead é "qualificado" (isso é papel da Skill SDR, seção 8 dela, sobre a conversa real); não contata ninguém; não fecha venda; não nego­cia preço; não decide, sozinho, qual nicho prospectar quando isso ainda não está documentado (ver seção 4 — Decisão Humana Necessária).

**Problema que resolve:** hoje a identificação de prospects e a pesquisa pública sobre eles é manual; o módulo prepara esse trabalho de forma estruturada e auditável, sem substituir a decisão humana de quem de fato deve ser contatado.

**Saída:** uma lista de candidatos a lead, no formato da seção 8, com status de validação e fontes — nunca um registro já escrito no CRM.

**Onde começa:** a partir de um critério de nicho/ICP já documentado (hoje, só Psicologia tem Skill SDR e ICP documentados) e, opcionalmente, uma lista de fontes públicas a varrer.

**Onde termina:** na entrega da lista estruturada de candidatos para revisão humana — a partir daí, a criação do lead no CRM e o início da conversa (Skill SDR) são etapas seguintes, distintas, cada uma com seu próprio ponto de aprovação (ver seção 11 — Handoff).

## 2. Entradas

| Entrada | Documentado hoje? | Detalhe |
|---|---|---|
| Nicho | Parcialmente | O CRM já tem 5 opções de Nicho (Psicologia, Estética, Escritórios, Instituições de Ensino, Outro), mas **só Psicologia tem Skill SDR e ICP documentados** hoje. Prospectar qualquer outro nicho sem uma Skill/ICP documentado é **DECISÃO HUMANA NECESSÁRIA**. |
| Cidade/região | Documentado para Psicologia | ICP da Skill SDR: Petrópolis/RJ (prioridade) ou remoto/online. Não documentado para os demais nichos — **DECISÃO HUMANA NECESSÁRIA** se for expandir região ou nicho. |
| Tipo de empresa | Documentado para Psicologia | ICP: psicólogos e terapeutas individuais ou pequenos consultórios. Não-ICP explícito: grandes clínicas com equipe de marketing própria, ou perfis sem atividade profissional visível. |
| Quantidade desejada por execução | Não documentado | **DECISÃO HUMANA NECESSÁRIA** — nenhuma Skill ou documento define um volume padrão; não deve ser presumido. |
| Critérios de inclusão | Documentado para Psicologia | Presença digital pouco estruturada (Instagram parado, sem Google Perfil, sem funil de captação claro) combinada com sinal de prática profissional real. |
| Critérios de exclusão | Documentado para Psicologia + regra global | ICP: excluir grandes clínicas com marketing próprio e perfis sem atividade visível. Regra global (todos os nichos): excluir qualquer empresa/lead marcado como `DO NOT CONTACT` no CRM (seção 7). |
| Empresas já existentes no CRM | Documentado | Usado para a verificação de duplicidade (seção 6), consultando o CRM em modo leitura antes de qualquer sugestão de novo candidato. |
| `DO NOT CONTACT` | Documentado | Ver seção 7 — restrição absoluta e global. |
| Outras restrições | Documentado (LGPD) | Usar somente dados públicos ou de fontes permitidas para fins comerciais (site, Instagram público, Google Perfil); nunca dado sensível (saúde, orientação, opinião política); nunca informação pessoal além do necessário à presença profissional/comercial (seção 12 da Skill SDR). |

## 3. Pesquisa — fontes públicas

Ordem de prioridade, herdada da Skill Raio-X Engine (seção 5 dela) por ser a mesma disciplina de pesquisa já validada pela Rio X7:

| Fonte | Objetivo | Tipo de informação buscada | Limitações | Registro da fonte | Registro da data |
|---|---|---|---|---|---|
| Site oficial | Confirmar existência/atualização da presença institucional | Serviços, contato, atualidade | Pode não existir; pode estar desatualizado | URL exata | Data da consulta |
| Google Perfil da Empresa / Maps | Confirmar presença local e reputação | Endereço, avaliações, categoria | Pode não existir para autônomos | URL/print do perfil | Data da consulta |
| Instagram | Avaliar atividade e comunicação | Frequência de posts, bio, contato | Perfis privados limitam a leitura | URL do perfil | Data da consulta |
| Facebook | Complementar presença institucional | Atividade, contato, avaliações | Uso decrescente em alguns nichos | URL da página | Data da consulta |
| LinkedIn | Avaliar presença profissional/B2B | Cargo, formação, atividade profissional | Mais relevante para nichos B2B do que para autônomos B2C | URL do perfil | Data da consulta |
| YouTube | Avaliar conteúdo/autoridade quando existir | Frequência, temas, alcance aparente | Nem todo nicho usa este canal | URL do canal | Data da consulta |
| Outras fontes públicas relevantes | Cobrir o que as fontes acima não alcançarem | Contexto adicional específico do nicho | Deve ser avaliada como confiável antes do uso (mesma regra da Skill Raio-X, seção 19) | URL ou descrição da fonte | Data da consulta |

Regra fixa, herdada das duas Skills existentes: **nada pode ser inventado.** Se uma informação não for encontrada ou confirmada, ela entra como **NÃO VERIFICADO** — nunca como fato assumido. Registrar exatamente quais fontes foram consultadas de verdade; nunca afirmar que uma fonte foi consultada se não foi.

**Nenhuma pesquisa real foi realizada nesta etapa** — esta seção é só a especificação de como a pesquisa deverá funcionar quando o módulo for implementado.

## 4. Processo de duplicidade

Baseado na regra já existente e documentada em `RIO X7 — Central Comercial`, na mesma ordem de prioridade:

1. Domínio do site
2. Telefone
3. Instagram
4. Nome + cidade

**Quando considerar duplicado:** houver correspondência exata em pelo menos um dos três primeiros critérios (domínio, telefone ou Instagram) com um registro já existente no CRM.

**Quando considerar possível duplicado:** houver correspondência apenas no critério 4 (nome + cidade), ou correspondência parcial/ambígua em qualquer critério (ex.: nome muito parecido, telefone com um dígito diferente).

**Quando não houver informação suficiente:** nenhum dos quatro critérios pôde ser verificado contra o CRM (ex.: empresa sem site, sem telefone público, sem Instagram, e nome comum). Nesse caso, a duplicidade fica marcada como **NÃO VERIFICADO** — o módulo não presume que é ou não é duplicado.

**O que fazer quando houver dúvida:** seguindo a regra já oficial da Central Comercial — **não criar um novo registro**; marcar o candidato para revisão humana, referenciando o registro existente mais parecido encontrado. O módulo nunca cria duplicidade deliberadamente, e nunca decide sozinho "resolver" a dúvida assumindo que não é duplicado.

## 5. Tratamento de `DO NOT CONTACT`

Regra absoluta, sem exceção:

- Se uma empresa/lead está marcada como `DO NOT CONTACT` no CRM, ela **não pode ser incluída** em nenhuma lista de candidatos para contato ou prospecção.
- O módulo **não tenta contornar** essa restrição.
- O módulo **não cria um registro alternativo** para a mesma empresa/pessoa.
- O módulo **não procura outro telefone** para tentar contatá-la por uma via diferente.
- O módulo **não procura outro canal** (e-mail, outro Instagram, outro número) como forma de driblar a restrição.
- A restrição é tratada como **global para aquela empresa/lead** — vale para todos os canais, todos os nichos, e todas as tentativas futuras, não só para o registro específico onde foi marcada.
- Isso é consistente com a Skill SDR (seção 11: "se o lead pedir para não receber mais contato, em qualquer momento — PARAR IMEDIATAMENTE") e com a Regra 5 do [RULES.md](../../RULES.md).

## 6. Saída

Formato estruturado proposto para o resultado da pesquisa — **nunca escrito diretamente no CRM**, sempre entregue como rascunho para revisão humana antes de qualquer criação de registro real:

```
Empresa
Contato
Cargo
Telefone
WhatsApp
E-mail
Site
Instagram
Google Perfil / Maps
Cidade
Estado
Nicho
Origem
Problema/Oportunidade observada
Fontes consultadas
Data da pesquisa
Confiança dos dados (VALIDADO / HIPÓTESE / NÃO VERIFICADO, por campo relevante)
Status de validação (NÃO REVISADO / REVISADO POR HUMANO)
Observações (incluindo, se aplicável, o candidato de duplicidade encontrado — seção 4)
```

Os campos até "Origem" foram alinhados propositalmente aos nomes já usados no CRM (`RIO X7 — Pipeline Comercial`), para que, no momento em que um candidato for aprovado por Breno, a transposição para um registro real seja direta e sem reinterpretação de nomenclatura.

## 7. Status de informação

O módulo deve usar os dois esquemas já oficiais, cada um no seu contexto:

- **VALIDADO / HIPÓTESE / NÃO VERIFICADO** — esquema padrão do módulo, usado em cada campo/dado coletado durante a pesquisa (ex.: um telefone encontrado no site é VALIDADO; uma suposição de que a empresa "provavelmente" atende presencialmente, sem confirmação, é HIPÓTESE; um dado que não foi possível confirmar em nenhuma fonte é NÃO VERIFICADO).
- **DADO / ANÁLISE / HIPÓTESE / NÃO VERIFICADO** — esquema específico do Raio-X Engine, usado apenas quando o material produzido por este módulo alimentar diretamente uma execução da Skill Raio-X (ver [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md), seção "Status de informação"). O módulo RESEARCH + PROSPECTOR, por si só, não substitui nem executa o Raio-X — apenas entrega o material que a Skill Raio-X poderá usar depois, sob seu próprio esquema de 4 níveis.

Em nenhum dos dois esquemas uma hipótese pode ser apresentada como fato — regra herdada de ambas as Skills e de PROJECT_CONTEXT.md.

## 8. Nível de autonomia

**Nível 1 — Preparação.**

Justificativa: o módulo produz um rascunho estruturado (lista de candidatos + dossiê de pesquisa), sem executar nenhuma ação externa. Isso é consistente com a própria tabela de agentes já registrada em 0002 (seção 5): tanto RESEARCH quanto PROSPECTOR estão descritos ali como agentes que "não alteram nada diretamente", com aprovação humana explicitamente exigida no momento de criar um lead novo no CRM. Nenhuma alteração real (CRM, Notion, Calendar) é executada por este módulo em nenhuma hipótese — a criação efetiva de um lead é uma ação de Nível 2 (Execução controlada), distinta e posterior, sujeita a aprovação individual, conforme a lista de ações que sempre exigem aprovação humana já definida em 0002 (seção 4: "Alterar CRM").

## 9. Handoff

```
RESEARCH
↓ (entrada: nicho/ICP documentado + fontes públicas)
  saída: dossiê de pesquisa por candidato (DADO/HIPÓTESE/NÃO VERIFICADO)
  responsabilidade: coletar e classificar informação pública, nunca inventar
↓
PROSPECTOR
↓ (entrada: dossiês do RESEARCH + leitura do CRM para dedupe)
  saída: lista de candidatos a lead, já checada contra duplicidade e DO NOT CONTACT
  responsabilidade: aplicar critério de ICP/exclusão e a regra de duplicidade (seção 4)
↓
[VALIDAÇÃO HUMANA — Breno decide quais candidatos viram lead de verdade]
↓
CRM
↓ (entrada: candidato aprovado por Breno)
  saída: registro real criado no Pipeline Comercial (Status inicial = PROSPECT ou RESEARCH)
  responsabilidade: única fonte de verdade do lead a partir deste ponto
↓
SDR
↓ (entrada: lead já registrado no CRM)
  saída: conversa de qualificação conduzida pela Skill SDR — Psicologia (ou Skill equivalente do nicho)
  responsabilidade: qualificação e handoff para Breno conforme já documentado na própria Skill
```

**Momento de validação humana:** entre PROSPECTOR e CRM — nenhum candidato vira registro real sem que Breno (ou quem ele designar) aprove. Esse é o único ponto de aprovação obrigatório dentro do próprio módulo RESEARCH + PROSPECTOR; o envio de mensagem pelo SDR já é uma etapa seguinte, com sua própria aprovação, já documentada na Skill SDR (seção 13 dela: "quem envia, hoje, é Breno").

## 10. Matriz de testes futuros

| Caso | O que o módulo deve fazer |
|---|---|
| Empresa válida | Produzir dossiê completo, sem duplicidade, sem DO NOT CONTACT — candidato elegível para revisão humana. |
| Empresa duplicada (match exato em domínio/telefone/Instagram) | Não incluir como novo candidato; sinalizar o registro existente para revisão. |
| Possível duplicidade (match só em nome+cidade, ou parcial) | Incluir como "possível duplicado", nunca como candidato limpo; sinalizar para revisão humana. |
| Empresa sem site | Seguir a pesquisa pelas demais fontes (seção 3); nunca inventar um site; registrar a ausência como NÃO VERIFICADO. |
| Dados incompletos | Entregar o dossiê com os campos disponíveis preenchidos e os ausentes marcados como NÃO VERIFICADO — nunca completar com suposição. |
| Informação contraditória (ex.: dois telefones diferentes em fontes distintas) | Registrar ambos com a fonte de cada um; nunca escolher um sozinho como "o correto" sem sinalizar a contradição. |
| Empresa `DO NOT CONTACT` | Excluir totalmente da lista de candidatos, sem exceção (seção 5). |
| Fonte indisponível (ex.: site fora do ar) | Registrar a fonte como não consultável na data da pesquisa; nunca afirmar que foi consultada. |
| Informação não verificável | Marcar como NÃO VERIFICADO; nunca apresentar como fato. |
| Tentativa de inventar telefone | Bloqueado por regra — o módulo nunca gera um dado de contato que não veio de uma fonte real. |
| Tentativa de inventar e-mail | Mesma regra — nunca gerar e-mail hipotético ou padrão (ex.: "contato@dominio.com" sem confirmação real). |
| Tentativa de contornar `DO NOT CONTACT` | Bloqueado por regra — nenhum canal alternativo é buscado para essa empresa/lead (seção 5). |
| Tentativa de criar lead sem autorização | Bloqueado por nível de autonomia — o módulo (Nível 1) nunca cria o registro no CRM sozinho; só entrega o candidato para aprovação (seção 9). |

Nenhum desses testes foi executado — é a matriz de referência para quando o módulo for implementado.

## 11. Limitações

O módulo **não pode garantir e não deve prometer**:

- Faturamento da empresa pesquisada.
- Intenção de compra.
- Orçamento disponível do prospect.
- Número de clientes da empresa pesquisada.
- Resultados de uma futura campanha ou abordagem.
- Interesse comercial real (isso só se confirma na conversa real, conduzida pela Skill SDR).
- Informações privadas ou não públicas sobre a empresa ou seus responsáveis.

## Consequências

- Existe, pela primeira vez, uma especificação escrita de como RESEARCH e PROSPECTOR devem se comportar, incluindo os pontos onde a documentação atual (Skills, CRM) já responde e os pontos que ainda exigem decisão humana (seção 2).
- Fica explícito que a criação de lead real é sempre um ato humano aprovado, nunca uma consequência automática da pesquisa.
- A especificação depende de decisões futuras (nicho/região/volume para além de Psicologia) antes de poder ser implementada com escopo mais amplo — isso é intencional, para não presumir critérios que a Rio X7 ainda não definiu.

## Alternativas consideradas

- **Deixar PROSPECTOR criar o lead diretamente no CRM quando a confiança dos dados for alta.** Rejeitada: contraria a Regra 6 do RULES.md (humano no controle) e a própria lista de ações que sempre exigem aprovação humana em 0002 (seção 4 — "Alterar CRM"), independentemente da confiança do dado.
- **Presumir critérios de nicho/cidade/volume não documentados, para tornar a especificação "mais completa".** Rejeitada: violaria a Regra 1 do RULES.md (não inventar) — por isso esses pontos ficam marcados como DECISÃO HUMANA NECESSÁRIA em vez de resolvidos por suposição.
- **Unificar RESEARCH e PROSPECTOR em um único agente sem separação de papéis.** Rejeitada: a tabela de 0002 já os trata como agentes distintos (um pesquisa, o outro aplica critério de ICP/dedupe) — manter a separação facilita testar e auditar cada responsabilidade isoladamente.
