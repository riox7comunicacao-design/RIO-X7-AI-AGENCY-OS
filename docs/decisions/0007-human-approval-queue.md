# 0007 — Fila Persistente de Aprovação Humana

> **Nota de estado atual (2026-09-24):** este documento é um registro histórico, escrito quando o Notion era a fonte de verdade do CRM/Pipeline Comercial. Essa parte foi **revogada** pela [decisão 0012](./0012-crm-operational-source-of-truth.md) (2026-09-23): hoje o CRM operacional é o do próprio Rio X7 AI Agency OS (`src/crm` → CRM Service → API `/api/crm` → Dashboard) — o estado atual está em [CONTINUE-HERE](../operations/CONTINUE-HERE.md). O texto original abaixo foi preservado como histórico: onde ele disser que o CRM está no Notion, leia "estava". O Notion segue como base de conhecimento e repositório das Skills.

## Status

Implementado. Registrado em 2026-09-18.

## Objetivo

Criar a primeira barreira formal e persistente entre "o sistema descobriu um candidato" e "este candidato pode um dia virar um registro no CRM". Princípio central:

```
DESCOBERTA ≠ APROVAÇÃO ≠ CRM ≠ CONTATO
```

Nenhuma das quatro etapas acontece automaticamente a partir da anterior. A fila implementada em [src/research-prospector/approvalQueue.js](../../src/research-prospector/approvalQueue.js) cobre apenas a segunda etapa (aprovação) — ela consome a saída de `discovery.js` (Passo 2/2.1) e não escreve em nenhum sistema externo.

## Arquitetura

```
DISCOVERY (discovery.js)
   ↓
VALIDATION (já feita dentro de discovery.js)
   ↓
APPROVAL QUEUE (approvalQueue.js) ← este documento
   ↓
HUMAN REVIEW (ação humana explícita: approveProspect / rejectProspect)
   ↓
APROVADO_PARA_CRM (apenas um rótulo — nenhuma escrita acontece aqui)
   ↓
futuro Passo 4 (fora de escopo: só ali, com autorização própria, um registro
real poderia ser criado no CRM)
```

Nenhuma lógica de descoberta, normalização, deduplicação ou DO NOT CONTACT foi duplicada — `approvalQueue.js` importa e reaproveita `identityKeys()` de `normalize.js` (só para gerar um ID estável) e consome os campos `statusDuplicidade`, `statusDNC` e `estadoOperacional` já calculados por `discovery.js`. Nenhum algoritmo paralelo existe.

## Estados

```
AGUARDANDO_REVISAO   — estado inicial de todo prospect novo
APROVADO_PARA_CRM    — decisão humana explícita; NÃO significa "criado no CRM"
REJEITADO            — decisão humana explícita
DUPLICADO            — a deduplicação (discovery.js) já confirmou correspondência forte
DNC                  — a verificação de DO NOT CONTACT confirmou bloqueio
DADOS_INSUFICIENTES  — identidade não confirmada ou dados insuficientes (discovery.js)
EXPIRADO             — existe no modelo; nenhuma automação o produz nesta etapa (ver seção "Expiração")
```

Nenhum score, ranking, temperatura ou probabilidade de fechamento foi criado — só estas sete etiquetas categóricas.

**`APROVADO_PARA_CRM` significa exclusivamente**: *"este prospect pode, futuramente, ser encaminhado para eventual criação no CRM."* Não significa "crie agora", não dispara nenhuma escrita, e não é interpretado por nenhum outro código deste projeto como autorização de contato.

## Transições permitidas

Um único mapa (`ALLOWED_TRANSITIONS`) governa todas as mudanças de estado:

```
AGUARDANDO_REVISAO → APROVADO_PARA_CRM   (só actor HUMAN)
AGUARDANDO_REVISAO → REJEITADO            (só actor HUMAN)
AGUARDANDO_REVISAO → DADOS_INSUFICIENTES  (actor SYSTEM ou HUMAN)
AGUARDANDO_REVISAO → DNC                  (actor SYSTEM)
AGUARDANDO_REVISAO → DUPLICADO            (actor SYSTEM)
```

Todos os demais estados (`APROVADO_PARA_CRM`, `REJEITADO`, `DUPLICADO`, `DNC`, `DADOS_INSUFICIENTES`) **não têm nenhuma transição de saída definida** — são terminais por construção. Isso implementa, com um único mecanismo (`assertTransitionAllowed`), tanto a proibição de "estados arbitrários" quanto a garantia de que uma decisão humana ou um bloqueio de DNC/duplicidade nunca é silenciosamente revertido: qualquer tentativa de transicionar a partir de um estado terminal lança erro.

## Aprovação humana

**Atualizado no Passo 0009.2** — o parâmetro `reviewer` (texto livre) foi substituído por `identity`, um contexto estruturado `{ userId, name, role, permissions }`, seguindo o modelo `USER` de [0009](./0009-identity-roles-and-authorization-model.md). Uma string simples (ex.: `"Breno"`) não é mais aceita. Isto **não é autenticação real** — a função só valida a forma do contexto e a presença da permissão `APPROVE:LEAD_APPROVAL`; não há sessão, login, senha, token ou banco de usuários. Resolver `identity` a partir de um usuário de fato autenticado continua sendo decisão futura (ver 0009, "Decisões pendentes").

`approveProspect(queue, id, identity, reason)`:
- Exige `identity` estruturado e válido (`userId`, `name`, `role` não vazios; `permissions` uma lista contendo `APPROVE:LEAD_APPROVAL`) — lança erro caso contrário. Não existe parâmetro de "actor"; a função sempre grava `actor: HUMAN` internamente, e há uma segunda trava estrutural em `transitionState()` que rejeita qualquer tentativa de gravar `APROVADO_PARA_CRM` com um actor diferente de `HUMAN`. Não há caminho de código para `SYSTEM` aprovar.
- Registra no histórico: `timestamp`, `from`, `to`, `actor: HUMAN`, `reviewedBy: { userId, name, role }`, `motivo` (quando informado). `permissions` não é persistido no histórico.

`rejectProspect(queue, id, identity, reason)`:
- Exige `identity` válido (mesma regra acima, mesma permissão `APPROVE:LEAD_APPROVAL`) **e** `reason` não vazio.
- Registra a mesma estrutura de histórico, com `actor: HUMAN`.

## Duplicidade e DO NOT CONTACT

- Um resultado de `discovery.js` com `statusDuplicidade === 'DUPLICADO'` faz o prospect entrar (ou transicionar) diretamente para o estado `DUPLICADO` da fila — nunca fica como candidato "normal" aguardando revisão. `POSSIVEL_DUPLICADO`, deliberadamente, **não** é promovido a `DUPLICADO` automaticamente — permanece `AGUARDANDO_REVISAO`, para decisão humana (mesma regra já fixada em 0003/0005/0006).
- Um `statusDNC === 'BLOQUEADO'` sempre resulta em `DNC`. **Prioridade:** quando o mesmo prospect é simultaneamente `DUPLICADO` e `DNC`, `DNC` prevalece — é o bloqueio mais severo, e a mesma ordem já usada dentro de `discovery.js`.
- `statusDNC === 'NAO_VERIFICADO'` (CRM indisponível na consulta) nunca vira `DNC` — mas também nunca é tratado como "liberado"; o prospect permanece em `AGUARDANDO_REVISAO`, deixando claro que a ausência de verificação não é uma autorização.

## Reentrada (mesmo prospect descoberto de novo)

O ID de cada item é estável entre execuções — `buildStableId()` reaproveita `identityKeys()` (domínio → telefone → Instagram → nome+cidade, mesma prioridade oficial). Ao redescobrir um prospect já existente na fila:

- Se o estado atual é **terminal** (`APROVADO_PARA_CRM`, `REJEITADO`, `DNC`, `DUPLICADO` ou `DADOS_INSUFICIENTES`): o estado **nunca** muda automaticamente. Só se registra uma entrada de histórico "redescoberto" e a data de última observação (`lastSeenAt`) é atualizada.
- Se o estado atual é `AGUARDANDO_REVISAO` (ainda sem decisão): o sistema pode reclassificá-lo (para `DUPLICADO`, `DNC` ou `DADOS_INSUFICIENTES`, ou mantê-lo) com base na nova leitura de `discovery.js` — isso é sempre uma transição válida a partir de `AGUARDANDO_REVISAO`, nunca uma reversão de decisão humana.

## Auditoria

Toda mudança de estado gera uma entrada de histórico:

```json
{ "timestamp": "...", "from": "...", "to": "...", "actor": "HUMAN|SYSTEM", "motivo": "...", "reviewedBy": { "userId": "...", "name": "...", "role": "..." } }
```

`reviewedBy` (atualizado no Passo 0009.2) só aparece em entradas de aprovação/rejeição — entradas geradas por `SYSTEM` (dedup/DNC/dados insuficientes/criação inicial) não têm esse campo. `actor` distingue rigorosamente quem causou a transição: `HUMAN` só aparece em aprovações/rejeições explícitas; `SYSTEM` aparece em classificações automáticas de duplicidade/DNC/dados insuficientes e na criação inicial do item. Nunca existe uma entrada `SYSTEM` com `to: APROVADO_PARA_CRM` — isso é impedido estruturalmente em `transitionState()`.

## Persistência

Solução deliberadamente simples: um arquivo JSON local (`data/approval-queue.json`), lido/escrito com `fs` nativo do Node — nenhum banco de dados, nenhuma dependência nova, nenhum serviço contratado. `loadQueueFromDisk()`/`saveQueueToDisk()` são funções separadas das operações de domínio (`addProspect`, `approveProspect`, etc.), que operam sobre um objeto em memória — isso mantém os testes rápidos e determinísticos, e deixa explícito o momento em que algo é gravado em disco.

**Atualizado no Passo 0009.2:** `saveQueueToDisk()` agora escreve por arquivo temporário (no mesmo diretório) + `fsync` + `rename` atômico, para que uma interrupção do processo durante a escrita nunca deixe `approval-queue.json` truncado. `loadQueueFromDisk()` só trata a ausência do arquivo (`ENOENT`) como fila vazia — um arquivo existente com JSON inválido, ou com estrutura inesperada (ex.: sem a chave `items`), agora lança um erro explícito em vez de ser silenciosamente tratado como fila vazia; o arquivo corrompido nunca é apagado, sobrescrito ou "consertado" automaticamente.

O arquivo de fila fica em `data/`, uma pasta nova, deliberadamente separada de `src/`, `tests/` e `docs/` (ver `data/README.md`). **Este arquivo não é versionado no Git** — foi adicionado ao `.gitignore` (`data/*.json`) porque conterá dados pessoais reais (nome, telefone, e-mail) de prospects pesquisados publicamente. Mantê-lo fora do histórico do repositório é consistente com a Regra 8 do [RULES.md](../../RULES.md) e com o princípio, já registrado em [0002](./0002-execution-architecture.md), de não duplicar permanentemente dado de lead fora do Notion — aqui a duplicação é apenas transitória e local (pré-CRM), nunca versionada.

Nenhum dado sensível (senha, token, credencial, cookie) é armazenado — `sanitizeSnapshot()` só copia os campos públicos/comerciais que `discovery.js` já produz.

## Expiração

O estado `EXPIRADO` existe no enum do modelo, mas **nenhuma automação foi implementada** nesta etapa — nenhuma função o produz, e ele não aparece como destino de nenhuma transição permitida. Implementar expiração automática exigiria definir uma janela de tempo (quantos dias um item pode ficar em `AGUARDANDO_REVISAO`?), e essa é uma decisão de negócio que ninguém pediu ainda — inventar um número aqui violaria a Regra 1 do RULES.md (não inventar). Se e quando isso for necessário, a duração deverá ser configurável e documentada numa decisão própria.

## Limites explícitos deste passo

- **CRM continua somente leitura.** Nenhuma função deste módulo cria, edita ou apaga registros no Notion — o módulo nem importa nenhuma ferramenta de escrita.
- **Nenhum contato é realizado.** Não existe, em nenhum lugar do módulo, código de envio de mensagem, e-mail, WhatsApp ou criação de evento.
- **Nenhuma interface foi criada.** Apenas funções de módulo (`addProspect`, `approveProspect`, `rejectProspect`, `markDuplicado`, `markDnc`, `markDadosInsuficientes`, `getProspect`, `listQueue`, `getHistory`) — sem CLI, sem servidor web.

## Por que a fila não representa autorização de contato

`APROVADO_PARA_CRM` é uma etiqueta interna de triagem — indica que um humano revisou o candidato e concorda que ele pode, no futuro, virar um registro comercial. Isso é uma decisão sobre **relevância do candidato**, não sobre **permissão de contato**. Mesmo depois de aprovado aqui, criar o registro no CRM, contatar o prospect, ou avançar para o SDR continuam sendo etapas futuras, cada uma exigindo sua própria autorização explícita — exatamente como já documentado no fluxo RESEARCH → PROSPECTOR → [validação humana] → CRM → SDR de [0003](./0003-research-prospector-module.md).

## Consequências

- Existe agora um ponto único e auditável onde "quem decidiu o quê, quando e por quê" fica registrado para cada prospect, sem depender de memória ou de planilhas paralelas.
- A persistência local em JSON introduz uma exceção pontual e documentada ao princípio geral de "não duplicar dado de lead fora do Notion" — mitigada por nunca versionar o arquivo no Git.
- Um bug real foi encontrado e corrigido durante a implementação: a primeira versão de `deriveSystemState()` verificava duplicidade antes de DNC, invertendo a prioridade já estabelecida em `discovery.js` (onde DNC deve sempre prevalecer, por ser o bloqueio mais severo). Corrigido antes deste registro, com teste de regressão específico (`[I]`/`[O]` em `approvalQueue.test.js`, usando um cenário onde o mesmo registro do CRM é simultaneamente candidato a duplicidade e a DNC).

## Alternativas consideradas

- **Usar um banco de dados local (SQLite, etc.).** Rejeitada nesta etapa: adicionaria uma dependência nova sem necessidade real — um JSON simples já é auditável, versionável (localmente) e suficiente para o volume esperado.
- **Persistir automaticamente a cada chamada de função.** Rejeitada: acoplar E/S de disco a cada operação de domínio dificultaria testes e escondificaria o momento exato de gravação; preferiu-se manter `load`/`save` como passos explícitos, chamados pelo código que orquestra a fila.
- **Implementar expiração automática com um prazo "razoável" (ex.: 30 dias).** Rejeitada: qualquer prazo aqui seria inventado sem pedido de negócio — a Regra 1 do RULES.md desaconselha isso explicitamente.
