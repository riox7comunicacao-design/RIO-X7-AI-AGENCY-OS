# 0028 — Negociações, quadro de Funis de Vendas e Gestão de Funis e Etapas

## Status

**Fase D1 — implementada LOCALMENTE e testada; NÃO publicada (nenhum `git add`/commit/push), NENHUMA migration aplicada, servidor operacional NÃO reiniciado.** Os módulos novos só entram em uso depois do *deploy* descrito na seção 8. Continua a decisão [0027](0027-service-payment-modalities.md) (modalidades do Serviço): é ela que dá à negociação o que pode ser negociado.

## 1. O modelo: o cartão do funil É a negociação

- **Negociação** é uma entidade nova, em armazenamento próprio (`data/negotiations.json`, variável `RIO_X7_NEGOTIATIONS_PATH`; o arquivo só nasce na primeira gravação). Liga **um cliente** (registro do CRM), **um serviço** (catálogo), **um funil/etapa**, o **prazo**, a **forma de pagamento**, a **periodicidade**, o **valor negociado**, a **situação** e a **previsão de fechamento**.
- **Um cliente pode ter várias negociações, inclusive no mesmo funil** (decisão de arquitetura aprovada no checkpoint C1). O cartão do quadro representa a **negociação**, não o cliente. Os cards **avulsos** da Etapa "Funis 2" (um por cliente e funil, sem negociação) **continuam existindo e aparecendo** no quadro, marcados "Card avulso (sem negociação)"; as regras antigas valem só para eles. Um card de negociação só se move e só se arquiva pelas operações da negociação (`FUNNEL_CARD_HAS_NEGOTIATION` nas rotas antigas).
- **Responsável** = a conta que criou (nunca um campo do formulário). **Situação** (`ABERTA`, `GANHA`, `PERDIDA`) nunca é campo de formulário: muda só por ganhar, perder e reabrir.
- **Histórico append-only** (eventos `CRIADA`, `ATUALIZADA` com `alteracoes` de/para, `ETAPA`, `GANHA`, `PERDIDA` com motivo, `REABERTA`): nada é apagado; reabrir guarda o fechamento e a reabertura.
- **Cliente "Não Contatar" (`DO_NOT_CONTACT`) não recebe negociação** (`CLIENTE_NAO_CONTATAR`). Prospecção, Fila de Aprovação e Exclusões Permanentes **não foram tocadas**: nada é promovido, aprovado nem criado automaticamente a partir delas.

## 2. Finanças (uma só conta, no servidor; a tela só PRÉ-VISUALIZA com a mesma conta)

Tudo em **centavos inteiros**. `valorNegociado` tem **dois significados** conforme a forma de pagamento — e a tela diz qual:

| Forma | `valorNegociado` | TCV | MRR | Equivalente mensal |
|---|---|---|---|---|
| `UNICO` | valor **total** do contrato (uma cobrança) | = valor | — | — (não há recorrência a comparar) |
| `RECORRENTE` | valor de **cada** cobrança | valor × (prazo ÷ meses da periodicidade) | **só** na periodicidade `MENSAL` (= valor) | TCV ÷ prazo (só para **comparar**; arredondado uma vez, meio para cima) |

- **Prazo** em meses inteiros de 1 a 120 (atalhos 3, 6, 12 e "outro"). **Bloqueio:** prazo que não é múltiplo da periodicidade (`PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE`) — nunca arredonda em silêncio.
- A forma e a periodicidade têm de estar entre as que o **serviço permite** (decisão 0027); serviço inativo ou legado sem modalidades não aceita negociação nova. O **serviço não é alterado** pela negociação (leitura, `catalogService.get`).
- **Valor recebido NÃO é calculado nem inferido.** Ganhar é uma decisão comercial, não pagamento. TCV, MRR e equivalente mensal **nunca se misturam** num número só sem rótulo.
- `valorProposta`/`valorTotal` dos 31 campos legados do CRM **não são reinterpretados** nem lidos como TCV; o `precoReferencia` do serviço continua só informativo.

## 3. A API e as permissões (o servidor decide; a tela só mostra ou esconde)

| Rota | Permissão | Notas |
|---|---|---|
| `GET /api/funnel-board[?funnelId=]` | `READ:CRM` | o quadro inteiro (funis ativos/inativos, etapas, cards, totais por etapa); **totais vêm do servidor** |
| `GET /api/negotiations`, `/summary`, `/:id` | `READ:CRM` | `summary`: abertas, ganhas, perdidas, conversão, por etapa |
| `POST /api/negotiations`, `PATCH /:id`, `POST /:id/move`, `/win`, `/lose` | `PROPOSE:CRM` | `PATCH` é **parcial** (só o que mudou); `lose` exige `motivo`; só negociação **aberta** edita ou muda de etapa |
| `POST /api/negotiations/:id/reopen` | `WRITE:CRM` (só ADMIN) | confirma na tela |
| rotas de **estrutura** de funis/etapas (já existentes) | `MANAGE:FUNNELS` (só ADMIN) | continuam como eram; **o COMMERCIAL_CLOSER não lê a estrutura**, por isso o quadro tem a sua rota de leitura própria |

Corpos recusam campo desconhecido; `situacao`, responsável e financeiro nunca são aceitos. Mensagens de erro fixas por `code` (`NEGOTIATION_INVALID_INPUT`, `_NOT_FOUND`, `_CLOSED`, `_INVALID_STATE`, `_PERSISTENCE`), sem valor recusado nem texto de armazenamento.

## 4. O Dashboard (o que o usuário vê)

- **Catálogos** (bloco A): cartões em grade, modal centralizado de detalhes, formulários centralizados, desativar/reativar com confirmação e o **impacto** (quantos registros usam o item).
- **Funis de Vendas** (`#/funis`): quadro Kanban com uma coluna por etapa (contagem e valor em jogo vindos do servidor), cartões de negociação, busca, seletor de funil, modal de detalhes (condições, finanças, histórico), **nova negociação** e **editar** (cliente e funil travados), **mover** pelo seletor de etapa, **ganhar**, **perder** (motivo obrigatório) e **reabrir**. **Nada aparece como feito antes de o servidor confirmar**: cada ação relê o quadro; erro mostra a mensagem e deixa tudo como estava.
- **Gestão de Funis e Etapas** (`#/crm/configuracoes/funis`, só `MANAGE:FUNNELS`): criar/editar/desativar/reativar/excluir funis; criar/renomear/reordenar/desativar/excluir etapas. **Funil ou etapa com cartões nunca é excluído** — a tela explica (e o servidor recusa com 409 de verdade).
- **Dashboard Comercial** (`#/crm/dashboard`, `READ:CRM`): em negociação / contratado / perdido (quantidade, TCV, MRR, equivalente mensal das outras recorrências), taxa de conversão **só com negociações fechadas** ("Sem dados" caso contrário), abertas por etapa. Sem dado: estado vazio. **Nenhum número simulado.**
- "Dashboard Comercial" e "Gestão de Funis e Etapas" deixaram de ser páginas "Em desenvolvimento" (rotas, menu e título da aba atualizados); **Metas e Indicadores continua em desenvolvimento**.

## 5. Compatibilidade e dados

- Os **cinco serviços** reais, nichos e origens não foram alterados; o Catálogo só é **lido** pela negociação. Os **31 campos legados** do CRM, a Prospecção, a Fila de Aprovação, o DNC e as Exclusões Permanentes **não foram tocados**. Os 10 `data/*.json` do repositório continuam idênticos (hashes conferidos antes e depois da suíte).
- Cards avulsos antigos: lidos como sempre; o histórico deles continua no modal.
- **Visão Geral:** o indicador "Negociações" conta o **status** `NEGOCIAÇÃO` dos registros do CRM (rótulo "no status Negociação"); **não** é a contagem da entidade Negociação. Mantido de propósito (não era escopo); vale revisar o nome na próxima fase de UX.

## 6. Persistência — RESOLVIDA na decisão [0029](0029-commercial-persistence-supabase.md) (Fase D1.1)

> **Atualização (D1.1):** o proprietário decidiu que o **Supabase é o armazenamento oficial** das entidades comerciais; os adapters, a migration `20261019090000` e a fábrica por `REPOSITORY_MODE` estão na decisão 0029. O texto abaixo é o registro **histórico** da D1 (só adaptador de arquivo) e **não vale mais** como estado atual.

### (registro histórico) Persistência — o que NÃO estava resolvido

Hoje **Funis, Etapas, Cards e Negociações só têm adaptador em ARQUIVO** (`data/funnels.json`, `data/negotiations.json`), como já era com Funis. O CRM, esse sim, está no Supabase. Consequências reais: os dados vivem **no computador onde o servidor roda**, com **um único escritor** (gravação atômica e serializada, mas sem backup automático nem acesso de outro computador).

- **Decisão que cabe ao dono do projeto:** manter o arquivo no MVP (com cópia periódica de `data/funnels.json` e `data/negotiations.json`) **ou** aprovar o esquema Supabase.
- **Menor resolução:** uma migration **aditiva** (`crm_negotiations`, `crm_negotiation_events`, e — porque o card nasce junto da negociação — o adaptador Supabase dos funis/etapas/cards, cujas migrations já existem e estão testadas, **sem registro de aplicação**) + dois adaptadores no padrão do catálogo (porta já existente: `negotiationRepositoryPort.js`, `funnelRepositoryPort.js`). **Nenhuma migration foi preparada nesta fase** porque o modo arquivo não precisa de nenhuma e o esquema é decisão estrutural (sem `ANTES`/`DEPOIS` para entregar).
- Risco do salto para Supabase: a criação é em **dois passos** (card, depois negociação, com arquivamento compensatório se falhar); num banco isso deve virar uma operação transacional.

## 7. O que ficou de fora de propósito

Pagamentos e valor recebido; troca de responsável; metas e indicadores por vendedor; funis com regras por etapa; ordenar/copiar **funis** pela tela (as operações existem no serviço, sem rota nem tela); arrastar e soltar (a movimentação é pelo seletor de etapa — acessível e testável); notificações; propostas e contratos.

## 8. Implantação (quando for autorizada) — SUPERADA pela decisão [0029](0029-commercial-persistence-supabase.md) (seção 8): com o Supabase como armazenamento oficial há uma migration a aplicar e a ordem mudou. O texto abaixo é o registro histórico da D1.

1. Publicar o commit (fora desta fase). **Nenhuma migration a aplicar** no modo arquivo.
2. **Reiniciar o servidor** operacional (as rotas e a composição novas só existem depois) e dar Ctrl+F5 no painel.
3. Conferir: `GET /api/funnel-board` responde (200 com a conta ADMIN); sem `data/negotiations.json` até a primeira gravação.
4. Como o funil ainda **não existe** em produção, o ADMIN cria primeiro o funil e as etapas em **Gestão de Funis e Etapas**; só então o quadro aceita negociações.
5. Combinar a cópia periódica de `data/funnels.json` e `data/negotiations.json` (seção 6).

## 9. Testes

Suíte hermética: finanças (`NEGFIN`), repositório (`NEGREPO`), domínio (`NEG-DOM`), serviço (`NEG-SVC`), API (`NEG-API`), modelo do Dashboard (`NEGMODEL`), quadro (`FBOARD`), gestão de funis (`FADM`), dashboard comercial (`CDASH`), cartões de catálogo (`CATCARD`), **ponta a ponta com o servidor real em arquivos temporários** (`NEGFULL`), mais os guardas estáticos atualizados. Validação visual em navegador real contra um servidor isolado com dados fictícios (desktop e celular, sem rolagem horizontal).
