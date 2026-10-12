# 0026 — Catálogos do CRM: Serviços, Nichos e Origens dos Leads

## Status

**Implementado localmente em 2026-10-12** (CRM 5.0, Fase 2B-1 — somente a estrutura técnica, sem interface). **Não commitado.** A migration SQL (`supabase/migrations/20261012090000_crm_catalogs.sql`) é só uma proposta versionada, **NÃO APLICADA**: nada a executa, e o estado real do banco não foi consultado. Nenhum dado foi criado.

Decisões aprovadas pelo proprietário para esta etapa (D1–D5, na ordem abaixo). A interface administrativa é a **Fase 2B-2**, ainda não iniciada.

## 1. O que é

Três **listas controladas**, administradas por um ADMIN e consultadas por quem lê o CRM: **Serviços**, **Nichos** (com uma cor de uma paleta fixa) e **Origens dos Leads** (o canal por onde o lead chegou). Cada item tem um **identificador estável** — `service:<uuid>`, `niche:<uuid>`, `origin:<uuid>` —, gerado pela aplicação e **independente do nome**: no futuro, Clientes e Negociações referenciarão o catálogo pelo id, e um nome poderá mudar sem soltar as referências.

> **"Origem do Lead" não é a "origem" da prospecção.** Na pesquisa, `origem` quase sempre é a URL pública de onde um dado foi visto (a fonte). A origem **comercial** do lead é outra coisa; por isso o código chama o catálogo de `leadOrigin` / `crm_lead_origins`, e nenhum campo de URL ou integração existe nele.

## 2. D1 — três entidades independentes

| Catálogo (URL) | Tabela | Prefixo do id | Campos próprios (além de `nome` e `descricao`) |
|---|---|---|---|
| `servicos` | `crm_services` | `service:` | `categoria` (texto, até 60), `precoReferencia` (número ≥ 0, até 2 casas, até 1 bilhão), `tipoCobranca` (`UNICA` \| `RECORRENTE`), `recorrencia` (`MENSAL` \| `TRIMESTRAL` \| `SEMESTRAL` \| `ANUAL`) |
| `nichos` | `crm_niches` | `niche:` | `cor` (uma das 20 chaves da paleta) |
| `origens` | `crm_lead_origins` | `origin:` | `canal` (`PROSPECCAO_ATIVA` \| `ANUNCIO_PAGO` \| `INDICACAO` \| `ORGANICO` \| `PARCERIA` \| `OUTRO`) |

Campos comuns: `id`, `nome` (até 80), `nomeNormalizado`, `descricao` (até 500, opcional), `ativo`, `ordem`, `criadoEm`, `atualizadoEm` e o responsável por criar e por alterar (`criadoPor*`, `atualizadoPor*` — vêm só do autorizador, nunca do corpo).

- **Cobrança coerente:** `RECORRENTE` exige uma `recorrencia`, e só ele a tem. A regra vale no domínio **e** num `CHECK` da tabela, e na edição vale para o **estado resultante** (nada apaga uma recorrência em silêncio).
- **O preço de referência é só informativo.** Nenhum módulo o copia para `valorProposta` ou `valorTotal`; um teste confere que só quatro módulos o conhecem.
- **`canal` é uma taxonomia mínima**, definida por esta etapa e extensível por decisão do proprietário (acrescentar um valor exige mudar a constante **e** o `CHECK`, numa migration nova).

## 3. D2 — permissões

- **`MANAGE:CRM_CATALOGS`** (nova): criar, editar, reordenar, desativar, reativar e ver também os itens desativados. **Só ADMIN** (passa a ter 12 permissões); `COMMERCIAL_CLOSER` continua com as mesmas 5. Mesmo raciocínio de `MANAGE:FUNNELS`: uma capacidade administrativa distinta, nunca derivada de `WRITE:CRM`.
- **`READ:CRM`**: consultar os itens **ativos**. Quem só lê nunca vê um item desativado (para essa pessoa ele "não existe": 404), nem os campos de auditoria, nem `emUso`.
- A autorização é do **Catalog Service** (`PERMISSION_FOR`), **antes** de qualquer validação ou acesso ao armazenamento; a ponte é `src/auth/catalogBridge.js` e só aceita essas duas permissões.

## 4. D3 — compatibilidade com o CRM legado (estratégia **temporária**)

Os campos `nicho`, `origem` e `servicoPotencial` do registro **continuam texto livre**: os 31 campos de `CRM_WRITABLE_FIELDS`, as APIs comerciais, a promoção (Fila → CRM) e a prospecção **não mudaram**, e nenhum deles consulta um catálogo. O CRM aceita e devolve exatamente o digitado, existam ou não itens nos catálogos.

**Restrição temporária de renomeação:** como o registro guarda o **nome** como texto, renomear um item que algum registro usa soltaria esses registros dele. Por isso o Service pergunta ao **contador de uso** (`src/services/catalogUsage.js`, que só **lê** o CRM e devolve só um número) e, havendo uso, o nome **não pode ser alterado** (`409 CRM_CATALOG_NAME_IN_USE`; vale até para só a caixa). Cor, descrição, ordem e ativação seguem livres. Um registro "usa" um item quando o texto do campo legado, **normalizado**, é igual ao nome normalizado do item. Se a contagem falhar, a renomeação é **recusada** (falha fechada).

Essa restrição é do **modelo atual**, não da arquitetura: como os ids são estáveis e independentes do nome, quando Clientes e Negociações referenciarem os catálogos por identificador (e uma migração específica, **autorizada**, ligar os dados legados), o nome poderá ser editado livremente.

## 5. D4 — operações (sem exclusão física)

Criar, consultar, editar campos permitidos, reordenar, desativar e reativar. **Não existe exclusão física** em nenhuma camada (nem função, rota ou política de `DELETE`): "excluir" é desativar. Desativar nunca mexe nos registros do CRM que usam o item — só o tira das listas de escolha.

- **Edição segura:** um `PATCH` só toca os campos enviados; um valor igual ao atual não grava nada nem muda `atualizadoEm`; `ativo`, `ordem`, `id`, datas e responsáveis nunca vêm por edição (têm operações próprias ou são do sistema).
- **Reordenar** exige a lista **completa** (ativos e desativados), cada id uma vez; no Postgres é uma única chamada atômica (`reorder_crm_catalog`).
- **Ativar/desativar** são idempotentes.

## 6. D5 — nenhuma carga inicial

Nenhum serviço, nicho ou origem é cadastrado por código, migration ou script. As listas iniciais serão definidas pelo proprietário e cadastradas depois (pela interface da 2B-2 ou por um script revisado).

## 7. Unicidade (inclusive de desativados) e concorrência

`nomeNormalizado` = minúsculas, sem acento, qualquer sequência fora de `[a-z0-9]` vira um espaço, espaços colapsados. É **único por catálogo, contando os desativados** — reativar um item nunca colide com outro. Três camadas: o **domínio** recusa antes de gravar; o **adapter de arquivo** impõe a mesma regra; no **Postgres** há um `UNIQUE (nome_normalizado)` por tabela (o adapter traduz o `23505` em "nome duplicado"), que é a proteção entre processos. Dentro de um processo, as escritas de um repositório rodam uma por vez. Limite honesto: letras não latinas e símbolos não contam (um nome só de símbolos é recusado) e `C#`/`C++` normalizam igual a `C`.

## 8. Paleta fixa de 20 cores

O banco e a API guardam **só a chave** (`azul`); nenhum valor de cor é guardado ou aceito (`#125bd9`, `AZUL`, `cor-azul` são recusados). A interface a resolve por uma classe de CSS (`.cor-azul`, em `dashboard/styles.css`), o que mantém o CSP `style-src 'self'` e a regra DASH-GUARD-8 (nenhum estilo inline). Cada cor tem fundo claro, texto (contraste ≥ 7:1 — AAA) e um ponto de destaque (≥ 3:1 sobre o fundo e sobre o branco); o **nome do nicho vai sempre em texto** — a cor nunca é a única informação. Todos os pares de pontos ficam a ΔE (CIELAB) ≥ 25. Os testes **recalculam** contraste e distância, e conferem que o CSS, o código e o `CHECK` da migration usam exatamente as mesmas 20 chaves e tons.

## 9. API

Sob `/api/crm-catalogs/<catalogo>` (`servicos` | `nichos` | `origens`) — **não** `/api/crm/catalogs`, que seria lido como o id de um registro:

| Método e caminho | Função | Permissão |
|---|---|---|
| `GET /<catalogo>[?todos=1]` | lista (`todos=1` inclui desativados) | `READ:CRM` (`todos=1`: `MANAGE`) |
| `POST /<catalogo>` | cria | `MANAGE` |
| `POST /<catalogo>/reorder` | `{ orderedIds }` | `MANAGE` |
| `GET /<catalogo>/:id` | um item (o ADMIN recebe também `emUso`) | `READ:CRM` |
| `PATCH /<catalogo>/:id` | edita | `MANAGE` |
| `POST /<catalogo>/:id/activate` e `/deactivate` | corpo `{}` | `MANAGE` |

Erros por `code` estável, com mensagem fixa em português: `CRM_CATALOG_INVALID_INPUT` (400, com `details` = só `{ path, code }`), `…_NOT_FOUND` (404), `…_DUPLICATE_NAME` (409), `…_NAME_IN_USE` (409), `…_PERSISTENCE` (503). Corpo estrito (campo desconhecido, de identidade ou de auditoria é 400), query estrita, sem cache.

## 10. Armazenamento

Domínio puro (`src/crm/catalogDomain.js`) → Service com autorização (`src/services/catalogService.js`) → porta (`catalogRepositoryPort.js`) → dois adapters que passam pela **mesma suíte de contrato**: arquivo local (`src/crm/catalogRepository.js`, `data/crm-catalogs.json`, escrita atômica, só nasce no primeiro item) e Postgres/Supabase (`src/crm-adapters/crmSupabaseCatalogRepository.js`, PostgREST por `fetch` injetável). A fábrica `src/services/catalogRepositoryFactory.js` escolhe por `REPOSITORY_MODE` (`file` por padrão; `supabase` exige as duas variáveis e **nunca cai para `file` em silêncio**).

## 11. A migration (NÃO APLICADA)

Aditiva: três tabelas, índices, `UNIQUE`, `CHECK`s (formato do id, limites, listas fechadas, coerência de cobrança), RLS ligada **sem policy**, um gatilho de `updated_at` e a função `reorder_crm_catalog` (só a `service_role` executa). **Não toca `crm_records`**, não tem foreign keys, não insere nada, não apaga nada. Em `REPOSITORY_MODE=supabase`, sem ela, as rotas `/api/crm-catalogs` respondem 503 — o CRM e o resto não são afetados. O SQL **não foi executado** (nem há Postgres neste ambiente): sua correção foi conferida por leitura e por testes estruturais que o cruzam com o código; recomenda-se aplicá-lo primeiro numa transação.

## 12. Limitações conhecidas

- **Renomear item em uso é bloqueado** (seção 4): `PATCH` com outro nome devolve 409 até uma migração futura ligar os registros por id.
- **Sem versionamento de edição:** duas pessoas editando o mesmo item ao mesmo tempo — o último a gravar prevalece (por campo, porque o `PATCH` só envia o que mudou).
- **O contador de uso lê todos os registros do CRM** (como o próprio CRM já carrega tudo); é chamado só ao tentar mudar um nome e na consulta de um item pelo ADMIN.
- **A promoção não canonicaliza** `nicho`: o texto do briefing segue como veio (a ligação com os catálogos é da Fase 2B-3).
- **Serviço potencial é um valor só** por registro; vários serviços por negociação virão com a Fase 4.
- O Dashboard **ainda não tem a permissão nova nem telas**: a interface é a 2B-2.
