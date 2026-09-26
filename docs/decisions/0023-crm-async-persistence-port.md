# 0023 — Porta de persistência do CRM ASSÍNCRONA (Fase A da migração para o Supabase)

## Status

Implementado em 2026-09-26, sobre o commit 2a1e415 (etapa 4.2 — Fase A), a partir da auditoria 4.1. **Só** a camada acima do repositório ficou preparada para uma persistência assíncrona. **Não** foram feitos: adapter Supabase, SQL, tabela, policy, migração de dados, variável de ambiente nova, mudança de autenticação, de permissão, de contrato HTTP ou do Dashboard. O CRM continua funcionando exatamente sobre `data/crm.json` (mesmo formato de arquivo).

## Decisão

A persistência futura do CRM será assíncrona (decisão do proprietário, etapa 4.2). Por isso:

1. **A porta aceita métodos síncronos E assíncronos** — `list()`, `getById(id)` e `save(record)` podem devolver o valor ou uma Promise dele (`crmRepositoryPort.js`). A recusa de método declarado `async` (decisão 0014) foi removida.
2. **Domínio e Service viram `async`.** `crmDomain.js` (`createRecord`, `updateRecord`, `moveStatus`, `markDoNotContact`, `getRecord`, `listRecords`) e `crmService.js` (as 7 operações) fazem `await` de cada chamada ao repositório e do domínio. `await` de um valor que não é Promise devolve o próprio valor: **os adapters de memória e de arquivo não mudaram** (seguem síncronos), e o formato de `data/crm.json` é o mesmo.
3. **A autorização continua SÍNCRONA** (`authorizeOperation` nunca devolve Promise; um autorizador assíncrono continua recusado). Só a persistência ganhou a possibilidade de esperar.
4. **Chamadores atualizados** só onde há chamada ao CRM: `crmIntegrationService.js` (promoção), `prospectingService.js` (leitura do CRM para DNC/duplicidade; `submitProspecting` passa a ser `async`) e `server/app.js` (as 7 rotas `/api/crm`, que já estavam dentro de um handler `async`). A fila de aprovação, o Researcher, o Discovery, o RawFinding e a autenticação **não** foram tocados.

## O que NÃO mudou (contratos preservados)

IDs (`crm:<uuid>`), os 13 status e a máquina de transições, o histórico (mesmos campos, mesma ordem), DNC terminal, duplicidade e DNC por identidade, `null` para campo ausente, números como número, a ordem da listagem (a de inserção), as cópias defensivas, todas as mensagens de erro, as permissões, as rotas e os códigos HTTP. A validação de entrada continua antes de qualquer acesso ao repositório.

## Ler → decidir → gravar continua indivisível (dentro de um processo)

Com a porta síncrona, cada operação de escrita era indivisível "de graça": nada cedia a vez ao meio. Com `await`, cada chamada cede a vez, e duas escritas do mesmo repositório poderiam intercalar (as duas veriam "não existe" e as duas criariam; ou duas mudanças de status perderiam uma gravação). Para preservar o comportamento atual:

- **`crmDomain.js`**: as ESCRITAS de um mesmo objeto repositório rodam **uma por vez, na ordem de chegada** (fila de promessas por repositório, `WeakMap`). Leituras não esperam. Uma falha não envenena a fila.
- **`crmIntegrationService.js`**: as promoções de um mesmo serviço rodam uma por vez (a operação inteira — ler a fila, olhar o CRM, criar, gravar a fila — continua indivisível).

Provado por mutação: sem a trava do domínio, `CRM-ASYNC-3` falha; sem a da promoção, `INT-40` e `PROMO-API-5` falham.

## Pendências para o Supabase (Fase B) — NADA disto está resolvido aqui

1. **Concorrência entre processos/servidores.** A trava acima é por objeto repositório e por processo. Não protege dois servidores, nem dois objetos repositório sobre o mesmo armazenamento. **Hoje a composição de produção (`src/server/index.js`) cria TRÊS serviços de CRM independentes** (CRM, integração e prospecção), cada um com o seu repositório de arquivo: com o arquivo isso é inofensivo (as operações não intercalam, porque cada uma roda inteira antes de outra começar), mas com um adapter remoto o correto é **compartilhar uma única instância de repositório** entre os três, ou travar por armazenamento. A proteção real entre processos (transação, restrição única sobre a identidade normalizada, RPC/função no banco) é da persistência remota. A identidade (site, telefone, Instagram) é normalizada em JavaScript (`normalize.js`): uma restrição única exigiria guardar as chaves normalizadas.
2. **Paginação.** `list()` alimenta a duplicidade e o DNC. O PostgREST limita respostas (padrão de 1000 linhas): um adapter que não pagine truncaria a lista em silêncio e desligaria essas barreiras.
3. **Ordem da listagem.** No arquivo é a de inserção; no banco exige `ORDER BY` explícito para manter o comportamento.
4. **Timestamps.** O domínio gera ISO com `Z` e milissegundos; `timestamptz` devolve outro formato. Guardar como texto, ou reformatar exatamente na leitura.
5. **Datas dos campos** (`dataDaReuniao` etc.) são texto livre no domínio: coluna de texto, não `date`.
6. **Histórico**: `jsonb` no registro ou tabela filha (decisão de negócio/arquitetura pendente).
7. **Credencial do servidor e RLS**: tabela sem RLS em `public` seria legível com a chave `anon` (que vai ao navegador). Decisão pendente sobre `service_role` no servidor.
8. **Disponibilidade e erros de rede**: hoje só existe o erro "arquivo corrompido"; um adapter remoto precisa de um erro estável ("persistência indisponível") mapeado no `app.js`.
9. **Escopo**: a fila de aprovação, os lotes e os dossiês continuam em `data/*.json` (síncronos, locais). A promoção liga dois armazenamentos; ela já tem recuperação ("RECONCILIADO"), mas a fila seguiria local por computador.
10. **R7 (arquitetura)**: só `src/auth/authAdapter.js` pode importar o SDK do Supabase; um adapter de CRM que use o SDK exige ajustar a regra, ou falar PostgREST direto por `fetch`.

## Testes

- Os 22 arquivos de teste que chamam o domínio/Service do CRM foram atualizados **somente** com `await`/`async` (mesmo número de testes e de asserções). Única mudança de sentido: `CRM-PORT-3` e o trecho correspondente de `CRM-SVC-3` (antes: "uma porta assíncrona é recusada"; agora: "é aceita").
- `tests/crm/crmAsyncPort.test.js` (novo, 7 testes, sem Supabase): o mesmo roteiro dá o mesmo resultado em memória, em memória assíncrona e em arquivo (síncrono e assíncrono); contrato de dados; escritas concorrentes; trava por repositório e leituras que não esperam; falha de gravação; validação antes de tocar o repositório; Service sobre a porta assíncrona.
- Uma armadilha de teste registrada: com `Object.prototype.then` poluído, qualquer `await` de um objeto nunca resolve; o teste `CRM-SVC-49` poluiu só durante a chamada síncrona.
