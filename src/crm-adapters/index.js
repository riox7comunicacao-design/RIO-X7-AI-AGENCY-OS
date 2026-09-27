// Adaptadores REAIS de persistência do CRM fora do arquivo local (decisão 0024, etapa 2.1) — a composição, mesmo
// padrão de src/research-adapters/index.js. Nada aqui decide regra de negócio, autoriza, nem conhece a fila, o
// lote, o Approval Queue ou o Researcher; e o domínio do CRM (src/crm/) não conhece este diretório (a rede e o
// formato de uma tabela Postgres são detalhes daqui — regras R15/R16 em tests/auth/architecture-boundaries.test.js).
//
// NADA neste diretório é usado por nenhum caminho de produção/dev hoje: a composição real
// (src/server/index.js) continua só com o adapter de arquivo local (src/crm/crmRepository.js).

const { createSupabaseCrmRepository, DEFAULT_TABLE } = require('./crmSupabaseRepository');
const { readSupabaseCrmConfig, isSupabaseCrmConfigured } = require('./crmSupabaseConfig');
const { FIELD_COLUMNS, MANAGED_COLUMNS, camelToSnake, recordToRow, rowToRecord } = require('./crmSupabaseMapping');

module.exports = {
  createSupabaseCrmRepository,
  DEFAULT_TABLE,
  readSupabaseCrmConfig,
  isSupabaseCrmConfigured,
  FIELD_COLUMNS,
  MANAGED_COLUMNS,
  camelToSnake,
  recordToRow,
  rowToRecord,
};
