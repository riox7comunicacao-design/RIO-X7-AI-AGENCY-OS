# 0014 — CRM Service (autorização por operação, camada única, fronteira arquitetural)

## Status

Implementado em 2026-09-23, etapa CRM-SERVICE, sobre [0012](./0012-crm-operational-source-of-truth.md) e [0013](./0013-crm-domain.md). Só o Service e a sua ponte de autorização — sem rota HTTP, sem Dashboard, sem persistência de produção. A auditoria de segurança pedida para esta etapa encontrou e corrigiu brechas no domínio (ver "Achados").

## Arquivos

- `src/services/crmService.js` — o Service: `createCrmService({ authorizeOperation, repository })`.
- `src/auth/crmBridge.js` — a implementação real da porta `authorizeOperation` (`authorizeCrmOperation`), exportada pelo barrel de `src/auth`.
- `src/crm/crmRepositoryPort.js` — a porta de persistência separada dos adapters (contrato + `assertValidRepository`); `crmRepository.js` a reexporta.
- Correções de segurança em `src/crm/crmDomain.js` (ver "Achados").
- Testes: `tests/services/crmService.test.js` (50), `tests/auth/crm-bridge.test.js` (10), `tests/crm/crmRepositoryPort.test.js` (5), `CRM-SEC-13..15` em `tests/crm/crmDomain.test.js`, e as regras R3/R9/R12 em `tests/auth/architecture-boundaries.test.js` (`ARCH-14`, `ARCH-S9d`).

## Arquitetura

```
consumidor (futuro Dashboard/API) → CRM Service → CRM Domain → porta de persistência → adapter
```

O Service **não duplica regra do domínio**: status, transições, DNC, deduplicação, validação de campos e de id, histórico — tudo continua no domínio. O Service faz só o que é da camada de aplicação: recebe o `AuthorizationContext`, autoriza (antes de qualquer outra coisa, antes de tocar a persistência), valida o formato da entrada de aplicação (é um objeto simples, opções conhecidas, tipos), chama o domínio sobre o repositório **injetado**, e devolve projeções seguras. Nunca importa um adapter, `fs` ou o servidor.

## Permissões por operação (nenhuma permissão nova, matriz inalterada)

| Operação | Permissão | ADMIN | COMMERCIAL_CLOSER |
|---|---|---|---|
| `listRecords`, `getRecord`, `getHistory` | `READ:CRM` | sim | sim |
| `createRecord`, `updateRecord`, `moveStatus`, `markDoNotContact` | `WRITE:CRM` | sim | **não** |

A tabela `PERMISSION_FOR` em `crmService.js` é o único lugar onde isso é decidido. A ponte `authorizeCrmOperation` autoriza **só** `READ:CRM` e `WRITE:CRM`, não tem permissão padrão (omitir é recusa) e recusa qualquer outra permissão mesmo que o contexto a tenha. `ANALYZE:CRM` e `PROPOSE:CRM` (que o closer tem) **não** são usadas por nenhuma operação: o domínio não tem análise nem proposta, e inventar uma operação só para usá-las seria inventar escopo. Nenhum WRITE:CRM foi dado ao closer; nenhuma exceção por role existe (a decisão lê só `permissions`, nunca o nome da role — testado com um ADMIN sem `WRITE:CRM`).

## Camada única de autorização + fronteira arquitetural

0013 deixou em aberto se o CRM teria, como a Approval Queue, um autorizador também **dentro** do domínio. **Decisão desta etapa: não.** O Service é a única camada que autoriza, e a proteção que faltaria à segunda camada é arquitetural: a regra **R12** de `tests/auth/architecture-boundaries.test.js` só permite que `src/services` (e o próprio `src/crm`) importem `src/crm`. Qualquer outro caminho até o domínio — `src/server`, `src/auth`, `src/research-prospector` — contornaria a autorização, e o teste o barra (também no grafo de execução). R3 e R9 passaram a cobrir `src/crm` (o domínio não importa `src/auth` nem a camada de aplicação). *Opção não escolhida, registrada:* um autorizador injetado no domínio, como na Approval Queue — pode ser reavaliada se algum dia existir um segundo consumidor legítimo do domínio.

## Identidade e auditoria

O `reviewedBy` de cada entrada de histórico vem **só** do que o autorizador devolveu — validado no Service: exatamente `{ userId, name, role }`, textos não vazios, sem campos a mais (uma identidade com `permissions` ou `authUserId` é recusada), síncrono (uma Promise, ou qualquer coisa "thenable", é recusada) e nunca a role `SYSTEM`; o objeto é **copiado** (o Service não depende de o repositório copiar). `actor` é sempre `HUMAN`. Nada disso pode ser informado pelo consumidor: `userId`, `role`, `permissions`, `reviewedBy`, `authUserId`, `actor` nas opções ou nos campos são recusados como desconhecidos, e uma propriedade só conta se for **própria** (uma opção herdada, ou um `Object.prototype` poluído, nunca escolhe status, motivo ou identidade).

## O que sai do Service

Projeções por lista explícita de campos — nunca "o objeto que o domínio devolveu": os 31 campos do modelo + `id`, `status`, `dataDeEntrada`, `historico` (cada entrada com `timestamp`, `from`, `to`, `actor`, `reviewedBy` `{userId,name,role}`, `motivo`). Um valor que não seja texto, número finito ou null vira null. Um authUserId, e-mail, permissions ou token que apareça no armazenamento (adulteração, um adapter futuro) nunca chega ao consumidor. O aviso de possível duplicidade de `createRecord` é mínimo (`{ status, matchedOn, matchedRecordId }`) — nunca o registro inteiro de **outra** empresa. Corrupção do armazenamento aparece (erro claro), nunca é escondida.

## Persistência e a ressalva de sincronia

O Service **recebe** o repositório e nunca escolhe (nem conhece) um adapter — o teste `CRM-SVC-6` roda o Service sobre um repositório próprio de 3 métodos, e `CRM-SVC-7` prova por análise estática que o Service não importa `fs` nem adapter. **Ressalva à promessa de 0012/0013 ("trocar o adapter sem reescrever o domínio"):** as *regras* não mudam, mas a porta é **síncrona** (como a Approval Queue). Um adapter de rede (Supabase/Postgres — candidato, não decidido) é assíncrono e exigiria tornar o domínio e o Service `async`: mudança mecânica de assinatura, a fazer junto da decisão desse adapter, provavelmente com uma porta mais rica (a deduplicação hoje lê a lista inteira). Antes disso, um repositório declarado `async` é recusado na composição com mensagem clara (`assertValidRepository`) em vez de falhar no meio de uma operação. Não foi feito agora porque seria abstração sem necessidade provada.

## Achados da auditoria de segurança (todos com teste de regressão)

Corrigidos no domínio (commit `e6998a4` e nesta etapa), cada um **reproduzido por experimento antes** e com testes que falham contra o código anterior:

1. `updateRecord` contornava DNC e deduplicação (editar o `site` de um lead ativo para o de um bloqueado). Corrigido; a identidade só é reverificada quando **muda** (reenviar um formulário inteiro não trava por conflito legado).
2. Espaços nas pontas de um texto contornavam dedup/DNC (`"  x.example.test  "`). Textos são aparados ao gravar.
3. O mesmo número em `telefone` vs `whatsapp` não casava (o `identityKeys` compartilhado só olha um dos dois). O domínio compara cada número separadamente.
4. **Poluição do protótipo:** com `Object.prototype` poluído, o domínio gravava campos que ninguém enviou, escolhia o status inicial e **forjava a auditoria** (`actor`/`reviewedBy`/`motivo`). Opções agora só valem como propriedade própria; os campos saneados não têm protótipo.
5. `empresa` podia ser esvaziada por `updateRecord`; status herdado do protótipo virava `TypeError`; um registro sem histórico era aceito. Todos falham fechado, com mensagem clara.

**Achado aberto, fora do escopo (não corrigido, reportado):** `identityKeys()` em `research-prospector/normalize.js` considera só um número por registro (`telefone || whatsapp`). O CRM já não depende disso (item 3), mas a Approval Queue e o pipeline de descoberta continuam com essa limitação: um número guardado só como `whatsapp` de um prospect DNC pode passar como novo se entrar como `telefone`. A correção mínima seria `identityKeys` devolver todos os números e `checkDuplicate`/`checkDoNotContact` compararem por interseção — uma etapa própria, com os testes do `research-prospector`.

## Mutação (checagem de segurança)

80 mutantes da ponte, do Service e da lógica de segurança do domínio (permissão por operação, autorização removida ou reordenada, validação do autorizador, `reviewedBy`/`actor`, entrada, projeções, composição, dedup/DNC/transições): **79 detectados; 1 sobrevivente equivalente** — a chamada explícita a `requireActiveUser` na ponte, redundância deliberada porque `requirePermission` já a faz (mesma decisão da ponte da Approval Queue). A checagem apontou três lacunas de teste (identidade não copiada, `then` herdado, reverificação só na mudança) e uma **duplicata de regra**: a validação de id do Service repetia a do domínio (mesma mensagem) e foi removida, como pede "o Service não duplica regras do domínio".

## Decisões pendentes e limites (registrados, não resolvidos)

- **DECISÃO DE PRODUTO — o closer não pode marcar `DO_NOT_CONTACT`.** É uma escrita e ele não tem `WRITE:CRM`. Se o negócio quiser que quem conversa com o lead registre um "não me contate" na hora, é uma nova permissão (ou `WRITE:CRM` ao closer) — nunca uma exceção no Service.
- **Editar campos não gera histórico.** O domínio audita só a criação e as mudanças de status; auditoria de edição de campos exigiria mudar o domínio (decisão futura).
- **Sem exclusão, sem filtros/busca.** O domínio não tem exclusão (a história, inclusive um bloqueio DNC, não deve poder ser apagada sem decisão de produto); filtros ficam para CRM-API/CRM-DASHBOARD.
- **Sem trava entre processos** (arquivo local, um processo); Service síncrono.
- **Ordem das próximas etapas:** 0012 listava CRM-INTEGRATION (promoção Approval Queue → CRM) antes de CRM-API; a instrução mais recente do proprietário define **CRM-API** como a próxima. CRM-INTEGRATION segue pendente, sem data.

## O que NÃO foi implementado

Rotas HTTP, Dashboard/Kanban, a promoção Approval Queue → CRM, qualquer adapter de Supabase/Postgres, sincronização com Notion, operações de sistema/automação, exclusão, filtros. Nenhuma permissão foi criada ou alterada; nenhum arquivo de `research-prospector` foi tocado.

## Próximo passo

Etapa **CRM-API**: as rotas HTTP sobre este Service (`src/server`, no padrão das rotas da Approval Queue: autenticação Bearer, projeção segura, mapeamento de erros por mensagem, sem nunca aceitar `userId/role/permissions/reviewedBy` do navegador), compondo `createCrmService({ authorizeOperation: authorizeCrmOperation, repository })` no `src/server/index.js` com o adapter de arquivo de `data/` (fora do Git).
