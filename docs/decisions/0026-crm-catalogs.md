# 0026 — Catálogos do CRM: Serviços, Nichos e Origens dos Leads

## Status

**Fase 2B-1 (estrutura técnica) publicada** em 2026-10-12 (commit `85d3d4f`). **Fase 2B-2 (interface administrativa) publicada** em `b9ed092`, com o refinamento de cores e de disponibilidade publicado em `61e0fea` — ver "Atualização da Fase 2B-2" e `docs/development/UX-4-CHECKPOINT.md`. **Fase 2B-3.1 (seleção assistida dos catálogos nos formulários do CRM) publicada** em `5eafc9a` — ver "Atualização da Fase 2B-3.1" no fim deste documento. Depois dela, no mesmo plano da Fase 2B-3.2, foram publicadas a **2B-3.2A** (proteção do snapshot da Fila de Aprovação, `5d6b147`) e a **2B-3.2B** (verificação das Exclusões Permanentes na promoção, `df1e8ed`), e a **2B-3.2B-H2** (compatibilidade do `userId` textual nas Exclusões Permanentes, uma migration corretiva de um único comando) está preparada e é publicada no checkpoint que acrescenta este texto; a 2B-3.2C não foi iniciada. A migration SQL (`supabase/migrations/20261012090000_crm_catalogs.sql`) é só uma proposta versionada: **sem aplicação confirmada** — nada no projeto a executa e o estado real do banco **não foi consultado**. O mesmo vale para as migrations das Exclusões Permanentes (`20260930090000` e a corretiva `20261017090000`): **sem aplicação confirmada**. A **homologação operacional continua pendente** (ver `docs/development/UX-4-CHECKPOINT.md`). Nenhum dado foi criado.

Decisões aprovadas pelo proprietário para esta etapa (D1–D5, na ordem abaixo). A interface administrativa é a **Fase 2B-2** (publicada); a seleção nos formulários do CRM é a **Fase 2B-3.1** (só no Dashboard; publicada em `5eafc9a`); a migration continua **sem aplicação confirmada**.

## 1. O que é

Três **listas controladas**, administradas por um ADMIN e consultadas por quem lê o CRM: **Serviços**, **Nichos** (com uma cor de uma paleta fixa) e **Origens dos Leads** (o canal por onde o lead chegou). Cada item tem um **identificador estável** — `service:<uuid>`, `niche:<uuid>`, `origin:<uuid>` —, gerado pela aplicação e **independente do nome**: no futuro, Clientes e Negociações referenciarão o catálogo pelo id, e um nome poderá mudar sem soltar as referências.

> **"Origem do Lead" não é a "origem" da prospecção.** Na pesquisa, `origem` quase sempre é a URL pública de onde um dado foi visto (a fonte). A origem **comercial** do lead é outra coisa; por isso o código chama o catálogo de `leadOrigin` / `crm_lead_origins`, e nenhum campo de URL ou integração existe nele.

## 2. D1 — três entidades independentes

| Catálogo (URL) | Tabela | Prefixo do id | Campos próprios (além de `nome` e `descricao`) |
|---|---|---|---|
| `servicos` | `crm_services` | `service:` | `categoria` (texto, até 60), `precoReferencia` (número ≥ 0, até 2 casas, até 1 bilhão), `permitePagamentoUnico`, `permitePagamentoRecorrente` e `periodicidades` (`MENSAL` \| `TRIMESTRAL` \| `SEMESTRAL` \| `ANUAL`) — as **modalidades de pagamento** da Fase C1, decisão [0027](0027-service-payment-modalities.md); `tipoCobranca` e `recorrencia` são **legado somente leitura** (a coluna nunca é gravada) |
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

Os campos `nicho`, `origem` e `servicoPotencial` do registro **continuam texto livre**: os 31 campos de `CRM_WRITABLE_FIELDS`, as APIs comerciais, a promoção (Fila → CRM) e a prospecção **não mudaram**, e nenhum deles consulta um catálogo. O CRM aceita e devolve exatamente o digitado, existam ou não itens nos catálogos. (Desde a Fase 2B-3.1 os **formulários do Dashboard** passam a oferecer os itens dos catálogos para escolher, mas o valor gravado segue sendo o **nome, como texto**, e o servidor continua sem consultar catálogo nenhum — ver a seção 14.)

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
- **A promoção não canonicaliza** `nicho`: o texto do briefing segue como veio. A Fase 2B-3.1 **não mexeu na promoção**: um registro promovido da Fila traz o texto da pesquisa, que o formulário de edição mostra como "fora do catálogo" quando não for igual a um item (o tratamento da promoção é de uma entrega posterior da Fase 2B-3, só com autorização).
- **Serviço potencial é um valor só** por registro; vários serviços por negociação virão com a Fase 4.
- ~~O Dashboard ainda não tem a permissão nova nem telas~~ — resolvido na Fase 2B-2 (ver abaixo).

## 13. Atualização da Fase 2B-2 — interface administrativa (publicada em `b9ed092`; refinada em `61e0fea`)

Só o Dashboard; **nenhuma regra, endpoint, permissão ou migration do backend foi alterada** e a migration segue **NÃO APLICADA**.

- **Telas** `#/crm/configuracoes/servicos`, `…/nichos` e `…/origens` (lista, busca por nome, filtro de ativos/inativos, criar e editar num painel lateral com URL própria `…/novo` e `…/<id>`, desativar com confirmação, reativar, reordenar). Só o `MANAGE:CRM_CATALOGS` (`canManageCrmCatalogs`) as vê; o servidor continua a autoridade final.
- **Cor do nicho:** o backend **permite** cor nula (um nicho legado pode não ter cor) e **isso não foi alterado**; a interface **exige uma das 20 cores ao criar** um nicho, não oferece a opção "sem cor", e mostra um nicho legado sem cor com tratamento neutro ("Sem cor definida"). Só a **chave** da cor é enviada; a aparência vem das classes `.cor-<chave>` (CSP `style-src 'self'`, nenhum estilo inline).
- **Reordenar:** a nova ordem aparece já, mas só é considerada salva depois da resposta da API; em falha a ordem anterior volta. Desabilitado com busca ou filtro ativos (a ordem vale para todos os itens, ativos e desativados).
- **Nome em uso pelo CRM legado:** a tela consulta `emUso` ao abrir a edição e, se maior que zero, trava o nome com a explicação (a restrição da seção 4 continua sendo do servidor).
- **Página Configurações do CRM** (`#/crm/configuracoes`): deixou de ser "em desenvolvimento" e virou um índice com cartões para os três cadastros (links para as rotas reais) e para a Gestão de Funis e Etapas (desabilitado, EM DESENVOLVIMENTO), por permissão; sem informação simulada.
- **Menu:** os três itens exigem `MANAGE:CRM_CATALOGS`; "Gestão de Funis e Etapas" (ainda EM DESENVOLVIMENTO) exige `MANAGE:FUNNELS`. Sem nenhuma das duas, "Configurações do CRM" não aparece.
- **Sem integração, sem proposta, sem carga inicial:** nenhuma origem real é cadastrada e nenhuma integração (WhatsApp, Meta Ads, Google Ads, IA) é ativada; o preço de referência segue só informativo.
- **Refinamento publicado em `61e0fea`:** os 20 nomes de cor aparecem sempre inteiros (grade com coluna mínima medida a partir do nome mais largo, sem quebra no meio da palavra); e uma indisponibilidade **confirmada** do servidor (503) pausa criar, editar, ativar, desativar e reordenar — sem enviar nenhuma gravação —, preserva o rascunho e só é desfeita por uma leitura bem-sucedida. Uma falha de rede nunca é tratada como ausência da estrutura.

## 14. Atualização da Fase 2B-3.1 — seleção assistida dos catálogos nos formulários do CRM (publicada em `5eafc9a`)

**Só o Dashboard.** Nenhum arquivo de `src/` ou `supabase/` foi alterado, nenhuma migration foi aplicada e nenhum dado foi criado. O CRM continua com os **31 campos**, os mesmos nomes na API e `nicho`, `origem` e `servicoPotencial` guardados como **texto** (o NOME do item). O servidor continua sem consultar catálogos ao gravar um registro; o domínio comercial, o repositório, as regras de Não Contatar, a máquina de estados, a prevenção de duplicidades, as permissões comerciais, o histórico e a **promoção da Fila de Aprovação** não foram tocados.

- **Os formulários** "Novo registro" e "Editar registro" trocam a digitação livre desses três campos por uma **lista dos itens ATIVOS** do catálogo correspondente (um `<select>` nativo: teclado, leitor de tela e celular). Nada vem escolhido sozinho, nenhum item é criado ao escolher, e "Nenhum" deixa o campo em branco. A ordem dos campos não mudou; o rótulo visível de `origem` passou a ser **Origem do Lead** (só o texto: o campo técnico `origem`, a API, o banco e o histórico seguem iguais; Nicho e Serviço potencial mantêm o rótulo).
- **Consulta** (`dashboard/crm-catalog-lookup.mjs`): só LEITURA, pelos endpoints que já existem (`GET /api/crm-catalogs/<catalogo>`), com o mesmo cliente de API (token, renovação única em 401, `catalogErrorInfo`). Guarda de cada item só `id`, `nome`, `ativo` e a chave normalizada — nunca preço de referência, cor, descrição nem auditoria. Preguiçosa (nada é lido até um formulário abrir), com cache de 5 minutos, uma só requisição por catálogo (pedidos simultâneos viram um), sem polling nem temporizador; relê quando outra tela avisa (`crm-catalogs:changed`) e só se um formulário aberto espera aquele catálogo. Quem administra (`MANAGE:CRM_CATALOGS`) pede também os desativados (`?todos=1`), a única forma de **confirmar** "desativado"; quem só lê pede os ativos.
- **Normalização:** a MESMA do servidor (`normalizeCatalogName`), copiada para o Dashboard e **conferida por testes de paridade** (casos conhecidos, formas Unicode e 3 mil textos sorteados) e contra o contador de uso do servidor — o que o formulário trata como "corresponde" é exatamente o que a trava de renomeação conta como "em uso". Os dados gravados **não** são normalizados.
- **Valor já salvo (legado)** aparece **exatamente como está**, já escolhido, e nunca é alterado sem ação da pessoa: "**fora do catálogo**" (não consta, ou não dá para confirmar), "**grafia diferente**" (casa só depois de normalizar: mostra a grafia oficial e a ação explícita "Usar a grafia oficial") e "**desativado**" (só quando a API autorizada confirmou, isto é, para quem administra; para os demais é "fora do catálogo" — nunca se presume "desativado"). O texto salvo aparece por inteiro no aviso (o `<select>` corta textos longos). O PATCH continua levando **só os campos alterados**: um valor legado não tocado nunca é reenviado.
- **"Informar outro valor"** (só para quem administra os catálogos, durante a transição): abre o texto livre; o valor é enviado como texto e **não é criado no catálogo**. Quem só escreve no CRM não vê essa opção nem o atalho do cadastro, mas pode manter um valor legado ou trocá-lo por uma opção oficial.
- **Catálogo vazio, indisponível ou com falha — o CRM nunca fica bloqueado:** o campo vira texto livre (como sempre foi, com as sugestões dos registros) e um aviso explica. Refinamento final: quando os **três** catálogos falham pelo **mesmo** motivo, em vez de três avisos iguais há **um aviso ÚNICO**, no início do formulário (Novo registro e Editar, acima das abas): diz que **Nicho, Origem do Lead e Serviço potencial continuam disponíveis para preenchimento manual** e oferece "**Verificar novamente**" (uma leitura por catálogo, sem polling; nada do que foi digitado é tocado; o foco volta ao botão, ou ao primeiro campo se o aviso sai de cena). Quando falham só **um ou dois**, ou por **motivos diferentes**, cada campo mantém o **seu** aviso específico, curto, com "Tentar novamente". Os três motivos têm texto próprio e nunca se confundem: *estrutura de dados indisponível* (503), *falha temporária de conexão* (sem dizer que a estrutura está ausente) e *outro erro*. **Catálogo vazio não é falha** e nunca entra no aviso único: cada campo mantém o seu aviso de "cadastro sem itens ativos" (o ADMIN, com o atalho para o cadastro correspondente, em outra aba, e "Atualizar opções"). Nenhum erro de catálogo vira toast, sucesso ou erro do formulário.
- **Rascunho e resposta tardia:** quando as opções chegam depois de a pessoa já ter digitado, o digitado vira o valor atual ("fora do catálogo") — nada é apagado nem escolhido por ela; e se ela está com o foco no campo, a troca (ou a releitura das opções) espera ela sair dele. Um item escolhido que deixa de ser oferecido vira o valor atual. Os campos assinam o catálogo só enquanto o formulário existe.
- **Dinheiro:** escolher um serviço **não** preenche nem altera valor de proposta nem valor total (o preço de referência nem chega ao formulário do CRM; o teste CATCOMPAT-3 continua valendo). **Um serviço potencial por registro**, sem seleção múltipla.
- **Sem integração:** sem `READ:CRM` (ou numa API sem `listCatalog`) os campos ficam exatamente como eram, sem avisos nem leituras; quem só lê o CRM (`COMMERCIAL_CLOSER`) não tem formulário e nenhum catálogo é consultado.

**Limitações:** o servidor **não valida** o valor contra os catálogos (uma chamada direta à API continua podendo gravar qualquer texto); um item renomeado entre a escolha e o salvamento deixa o texto "fora do catálogo" (corrida rara, a trava de renomeação cobre os itens em uso); a lista é nativa, sem busca além da digitação do navegador (listas controladas e pequenas); mudanças de catálogo em **outra aba ou sessão** chegam pelo cache vencido ou por "Atualizar opções"; a edição de campo continua sem registro no histórico do CRM; registros promovidos da Fila trazem o texto da pesquisa. **Entregas seguintes da Fase 2B-3.2:** a 2B-3.2A (a Fila de Aprovação, `5d6b147`) e a 2B-3.2B (as Exclusões Permanentes na promoção, `df1e8ed`) já foram publicadas; a 2B-3.2C e o restante (a leitura, busca e filtros e a regressão final) seguem como entregas separadas, **mediante autorização**.

## 15. Atualização da Fase C1 — modalidades de pagamento dos Serviços (PUBLICADA no checkpoint C1; migration NÃO APLICADA; ativação operacional pendente)

Um serviço pode permitir pagamento **único**, **recorrente** (com uma ou mais periodicidades) ou **os dois**: três campos novos (`permitePagamentoUnico`, `permitePagamentoRecorrente`, `periodicidades`) no lugar do par `tipoCobranca`/`recorrencia`, que passa a **legado somente leitura**. Cadastro novo exige ao menos uma forma de pagamento; um serviço **legado** pode seguir sem nenhuma (nada é inferido) e o ADMIN completa pela edição; o PATCH parcial nunca apaga modalidades. O preço de referência segue opcional e apenas informativo. **Toda a regra, a migration `20261018090000_crm_services_payment_modalities.sql` (aditiva; NÃO APLICADA), a transição entre esquemas, a ordem segura de implantação e os contratos futuros (prazo contratado, TCV, MRR, valor recebido) estão na decisão [0027](0027-service-payment-modalities.md).** O restante desta decisão (D1–D5, 2B-2, 2B-3.1) continua valendo para Nichos, Origens e para tudo o que não é a cobrança do Serviço.
