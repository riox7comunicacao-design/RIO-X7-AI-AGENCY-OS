# Changelog

## 2026-09-23 — CRM Domain: correções de segurança encontradas na auditoria do CRM-SERVICE

Correções no `src/crm/` (detalhes em [decisão 0013](./docs/decisions/0013-crm-domain.md), seção "Atualização"). Cada brecha foi reproduzida por experimento antes de ser corrigida e tem teste de regressão (`CRM-SEC-1` a `CRM-SEC-12`; 10 deles falham contra o código anterior).

- **`updateRecord` contornava DNC e deduplicação:** editar o `site`/telefone/Instagram de um registro ativo para os de um registro `DO_NOT_CONTACT` (ou de outro registro) criava um lead ativo com identidade bloqueada. Agora a edição de campos de identidade passa pelas mesmas regras da criação. `empresa` nunca pode ficar vazia.
- **Espaços nas pontas** de um texto (ex.: `"  x.example.test  "`) contornavam a deduplicação e o DNC; agora são removidos ao gravar.
- **Telefone × WhatsApp:** o mesmo número guardado no campo "errado" não era reconhecido (limitação do `identityKeys` compartilhado, **não alterado**); o domínio agora compara cada número separadamente.
- **Registros adulterados no armazenamento:** status herdado do protótipo do Object vira "transição não permitida" (antes, `TypeError`); registro sem histórico falha fechado em vez de ter a auditoria recriada.
- Nenhuma permissão, nenhuma regra de transição e nenhum arquivo de `research-prospector` foram alterados.

## 2026-09-23 — CRM Domain: modelo de dados, máquina de estados, DNC, deduplicação, repositório

Registrado [decisão 0013](./docs/decisions/0013-crm-domain.md), etapa CRM-DOMAIN.

- Novo domínio `src/crm/`: os 13 status oficiais do CRM, máquina de estados (funil livre entre si; WON/LOST fecham e só saem para DO_NOT_CONTACT; DO_NOT_CONTACT é terminal, alcançável de qualquer status), o modelo de dados (31 campos graváveis já aprovados, sem inventar nenhum novo), deduplicação e DNC reaproveitando `duplicateCheck.js`/`doNotContact.js` sem alterá-los.
- Persistência desacoplada por um repositório (`{ list, getById, save }`): um adapter em memória (testes) e um adapter de arquivo JSON local (desenvolvimento) — nenhum dos dois é a persistência de produção; Supabase segue como candidato futuro, não decidido.
- Achado de segurança corrigido nesta etapa: um id de registro `__proto__`/`constructor`/`prototype` poderia corromper o objeto de armazenamento do adapter de arquivo — corrigido com um objeto sem protótipo e checagem explícita.
- Domínio "puro": não importa `src/auth`, `src/server`, `dashboard` nem qualquer SDK externo — sem autorização embutida (fica para a etapa CRM-SERVICE, ainda não implementada).
- 56 testes novos (`tests/crm/`). Nenhuma permissão foi alterada; `ADMIN` continua com `WRITE:CRM`, `COMMERCIAL_CLOSER` continua sem.
- Nenhum código de Service, API ou Dashboard foi implementado por esta etapa.

## 2026-09-23 — Decisão arquitetural: CRM operacional próprio (revoga Notion como fonte de verdade)

Registrado [decisão 0012](./docs/decisions/0012-crm-operational-source-of-truth.md), autorizada pelo proprietário do projeto.

- O Notion deixa de ser a fonte de verdade do Pipeline Comercial. O Rio X7 AI Agency OS passa a ter um CRM operacional próprio, acessível pelo Dashboard, seguindo a mesma arquitetura em camadas já validada para a Approval Queue (`Dashboard → HTTP/API → CRM Service → CRM Domain → Persistência`).
- O Notion continua como base de conhecimento, documentação e repositório das Skills — não é desligado, só muda de papel. Nenhuma sincronização entre os dois foi criada.
- Persistência do CRM Domain é desenhada como camada substituível (repositório/porta), nunca acoplada diretamente a JSON — um adapter de desenvolvimento/teste vem primeiro; o Supabase já usado para autenticação é registrado como candidato futuro para persistência multi-dispositivo, **sem decisão de adoção nem implementação nesta etapa**.
- Permissões inalteradas: `ADMIN` mantém `WRITE:CRM`; `COMMERCIAL_CLOSER` continua sem `WRITE:CRM`.
- `PROJECT_CONTEXT.md` e `docs/architecture/data-domains.md` foram atualizados para refletir a nova decisão, preservando o texto anterior marcado como superado (não apagado).
- Nenhum código de CRM foi implementado por esta etapa (só a decisão e a documentação). Implementação segue em etapas próprias: CRM-DOMAIN, CRM-SERVICE, CRM-INTEGRATION, CRM-API, CRM-DASHBOARD.

## 2026-09-16 — Fundação inicial

Fundação inicial do RIO X7 AI AGENCY OS criada no Claude Code.

Registrado:

- Git foi inicializado neste diretório. O primeiro commit foi realizado no Passo 0.6 (commit `e6c94cd`, mensagem `chore: initial Rio X7 AI Agency OS foundation`).
- Estrutura mínima de pastas e documentos foi criada (`docs/`, `skills/`, `tests/`, arquivos de contexto e regras).
- Nenhum sistema externo (Notion, Google Calendar, contas de anúncios, WhatsApp) foi alterado.
- Nenhum pacote ou dependência foi instalado.
- Nenhum dado real de cliente ou negócio foi modificado.
