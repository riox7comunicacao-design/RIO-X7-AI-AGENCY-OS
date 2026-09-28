# Política de Dados do CRM — Rio X7 AI Agency OS

Escrito na etapa 3L, sobre o estado confirmado nas etapas 3I-B/3J/3K. Atualizado na etapa 3M, quando a ativação
oficial foi concluída. Este documento é **operacional**: não altera nem substitui nenhuma decisão arquitetural já
registrada em `docs/decisions/0012` a `0024`. Ele existe para que a operação diária do CRM (backup, troca de
backend, recuperação) siga uma política clara.

## Ativação oficial (etapa 3M)

- **Concluída em 2026-09-28.**
- **`REPOSITORY_MODE=supabase`** foi definido no `.env` de produção — configuração oficial e permanente a partir
  desta data (não um teste temporário como as ativações controladas das etapas 3I-B/3M-smoke).
- Validado de ponta a ponta antes de considerar a ativação concluída: servidor real subindo com a configuração
  oficial, autenticação, leitura, criação, edição, mudança de status, histórico, duplicidade (409), DNC e seu
  bloqueio terminal (409) — tudo através do caminho real da aplicação (HTTP → Service → Domínio → Supabase
  Repository → Supabase), nunca direto no repositório. O único registro sintético criado para essa validação foi
  removido antes de considerar a etapa concluída; o banco terminou, e permanece, com 0 registros.

## Estado anterior (etapas 3I-B a 3L)

Antes da etapa 3M, `file` (`data/crm.json`) era a fonte de verdade operacional — `REPOSITORY_MODE` estava ausente
do `.env`, e o Supabase, embora integrado e tecnicamente validado, não era o backend oficial.

## Estado atual

- **`public.crm_records` (Supabase) é a fonte oficial de verdade do CRM.** `REPOSITORY_MODE=supabase` está
  definido no `.env` de produção.
- **`data/crm.json` deixou de ser a fonte operacional do CRM** a partir da ativação oficial — ele **não é uma
  réplica**: continua existindo como implementação técnica do adapter de arquivo, mas não é mais atualizado pelo
  uso normal do sistema.
- **Ambos os armazenamentos permanecem vazios** — `public.crm_records` = 0 registros (confirmado de forma
  independente após a validação da etapa 3M), `data/crm.json` = `{}` (nunca foi tocado pela ativação nem pela
  validação).
- **Não existe sincronização automática entre os dois, e nunca existiu.** `sharedFileCrmRepository` (arquivo) e
  `sharedSupabaseCrmRepository` (Supabase) são caches completamente independentes — nada no código lê de um para
  escrever no outro. O adapter de arquivo **permanece disponível** como implementação técnica (não foi removido,
  e não deveria ser) — ele só não é mais o backend oficial enquanto `REPOSITORY_MODE=supabase` estiver configurado.
- **A responsabilidade de backup/export continua inteiramente operacional**, não automatizada — ver a seção
  Backup abaixo. Nenhuma automação (cron, workflow) foi criada.
- **Restore/import continuam não implementados** — ver a seção Restauração.

## Política (vale desde a ativação oficial)

- **`public.crm_records` será a fonte oficial de verdade do CRM.**
- **`data/crm.json` não será réplica** — ele simplesmente para de ser atualizado a partir do momento da ativação.
- **Não haverá sincronização automática** entre os dois backends, nunca — isso continua sendo uma limitação de
  desenho, não um bug a corrigir.
- **Nenhuma troca de backend deve ser casual.** Alternar `REPOSITORY_MODE` é sempre uma decisão humana explícita,
  nunca uma resposta automática a um problema (ex.: "o Supabase caiu, vamos voltar pro arquivo" não deveria
  acontecer sem entender o que isso significa para os dados — ver seção Rollback).
- **Qualquer migração de dados entre os dois backends deve ser deliberada.** Hoje **não existe** nenhum mecanismo
  de migração `file → Supabase` nem `Supabase → file` (ver seção Restauração) — construir um é trabalho de uma
  etapa própria, só quando for realmente necessário.
- **O histórico (`historico`) de cada registro deve ser preservado** em qualquer operação de recuperação ou
  migração futura — nunca reconstruído do zero, porque ele é a auditoria do CRM (decisão 0014).
- **Qualquer operação destrutiva (apagar em massa, truncar, sobrescrever sem revisão) exige autorização humana
  explícita** — nunca automação silenciosa.

## Backup

- **O plano atual do projeto Supabase é Free**, confirmado visualmente no Dashboard (etapa 3K).
- **Não devemos considerar a existência de backup automático/Point-in-Time Recovery como garantida** nesse plano
  — isso não foi (e não pôde ser, dado o acesso disponível a este código) reconfirmado de forma programática; é
  uma responsabilidade de quem administra o projeto verificar diretamente no Dashboard do Supabase.
- **O projeto terá um export lógico do CRM** via `scripts/export-crm.js` (etapa 3L) — um backup **manual**, feito
  sob demanda por quem operar o sistema.
- **Periodicidade ainda não definida.** Não presumir uma frequência (diária, semanal, etc.) até que o
  proprietário decida uma.
- **O export contém só os dados do CRM** (os mesmos campos que o domínio já expõe via `list()`: id, os 31 campos
  graváveis, status, data de entrada e histórico) **mais uma metadata operacional não sensível** (formato,
  versão do formato, origem, tabela, data/hora do export, quantidade de registros).
- **Secrets nunca fazem parte do backup.** `scripts/export-crm.js` nunca escreve `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` ou qualquer outra credencial no arquivo exportado, e nunca os imprime no terminal.
- **Backups devem ser armazenados fora do Git** — `backups/crm/` está no `.gitignore` (etapa 3L); nenhum arquivo
  desse diretório deve ser commitado, em nenhuma circunstância.
- **Backup não é réplica operacional.** Um arquivo de export é uma fotografia de um instante; ele não substitui
  a fonte de verdade nem é lido automaticamente por nenhuma parte do sistema.
- **Restauração/migração exige um procedimento separado** — ver a seção "Restauração" abaixo, que hoje ainda não
  existe como mecanismo automatizado.

## Restauração

- **Exportação implementada.** `scripts/export-crm.js` produz um backup lógico, somente leitura, de
  `public.crm_records`.
- **Restauração/importação ainda não implementada.** Não existe `import-crm.js`, `restore-crm.js` nem qualquer
  mecanismo que leia um arquivo de export e grave de volta no Supabase ou no arquivo local. Construir isso é uma
  etapa futura, só se e quando for necessário.
- **Uma recuperação futura precisa ser deliberada** — nunca automática, nunca silenciosa.
- **Qualquer restore deve exigir autorização humana explícita** antes de gravar qualquer coisa de volta no CRM.
- **O histórico deve ser preservado** em qualquer restore futuro — o formato de export já preserva `historico`
  por registro, exatamente porque uma restauração sem histórico apagaria a auditoria do CRM.
- **Não fazer rollback simplesmente alterando `REPOSITORY_MODE`** se existirem dados em apenas um dos backends —
  ver a seção seguinte.

## Rollback entre `file` e Supabase

**Trocar o backend não copia dados.** Esta é a regra mais importante deste documento — repetida aqui porque é
fácil presumir o contrário.

### `file` → Supabase

Só deveria ocorrer depois de, nesta ordem:
1. verificar se há dados em `data/crm.json` que precisam ser preservados;
2. decidir explicitamente se esses dados precisam ser migrados para o Supabase;
3. garantir que a migração (quando existir — ver "Restauração") não cria duplicidade de identidade
   (empresa/site/telefone/whatsapp/instagram/cidade — as mesmas regras do domínio);
4. executar essa migração de forma deliberada, nunca automática;
5. validar o resultado;
6. só então mudar `REPOSITORY_MODE` para `supabase` no `.env` e reiniciar o servidor.

### Supabase → `file`

Mesma regra, na direção oposta: verificar dados no Supabase, decidir se precisam ser preservados, migrar
deliberadamente antes de trocar `REPOSITORY_MODE` de volta para ausente/`"file"`.

### O que acontece se a troca for feita sem migrar

- Registros que existiam **só no lado abandonado** continuam existindo ali, fisicamente intactos, mas o servidor
  **para de enxergá-los** assim que a variável muda.
- Nenhum aviso automático informa que isso aconteceu — o sistema simplesmente passa a operar sobre um conjunto de
  dados diferente.

## Fonte oficial de verdade

- **Estado atual (desde a etapa 3M, 2026-09-28):** Supabase (`public.crm_records`).
- **Estado anterior:** `file` (`data/crm.json`).

A ativação oficial foi feita por decisão explícita do proprietário, registrada na etapa 3M — nunca implícita numa
mudança de configuração isolada.
