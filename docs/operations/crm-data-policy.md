# Política de Dados do CRM — Rio X7 AI Agency OS

Escrito na etapa 3L, sobre o estado confirmado nas etapas 3I-B/3J/3K. Este documento é **operacional**: não
altera nem substitui nenhuma decisão arquitetural já registrada em `docs/decisions/0012` a `0024`. Ele existe
para que a operação diária do CRM (backup, troca de backend, recuperação) siga uma política clara, escrita antes
de haver dados reais em jogo.

## Estado atual

- **`file` (`data/crm.json`) é a fonte de verdade atual.** `REPOSITORY_MODE` está ausente do `.env` de produção —
  o padrão do sistema, confirmado por `src/services/crmRepositoryFactory.js`, é `"file"`.
- **O Supabase está integrado e tecnicamente validado** (schema aplicado, adapter testado contra o banco real,
  ativação controlada aprovada na etapa 3I-B) **mas não é o backend oficial neste momento.**
- **Ambos os armazenamentos estão vazios** — `public.crm_records` = 0 registros, `data/crm.json` = `{}`
  (confirmado nesta mesma etapa).
- **Não existe sincronização automática entre os dois.** `sharedFileCrmRepository` (arquivo) e
  `sharedSupabaseCrmRepository` (Supabase) são caches completamente independentes — nada no código lê de um para
  escrever no outro.

## Após ativação oficial

Quando `REPOSITORY_MODE=supabase` for oficialmente adotado (decisão futura do proprietário, fora do escopo desta
etapa), a política passa a ser:

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

- **Estado atual:** `file` (`data/crm.json`).
- **Estado futuro, após a ativação oficial:** Supabase (`public.crm_records`).

A ativação oficial **não é feita por este documento** — é uma decisão própria e futura do proprietário, registrada
em uma etapa dedicada, nunca implícita numa mudança de configuração isolada.
