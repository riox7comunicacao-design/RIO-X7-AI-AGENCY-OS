// Mapeamento entre o registro do domínio (src/crm/crmDomain.js) e a linha da tabela Postgres proposta na decisão
// 0024/migration 20260927120000_crm_initial_schema.sql — preparação da etapa 2, realocada para src/crm-adapters/
// na etapa 2.1.
//
// POR QUE FICA AQUI E NÃO EM src/crm/ (decisão da etapa 2.1, registrada em docs/decisions/0024, seção 10):
// embora esta função seja pura, determinística e sem I/O — passaria nos dois testes de pureza de src/crm/
// (CRM-PURITY-1/2 em tests/crm/crmDomain.test.js) —, o que ela conhece é ESPECÍFICO de uma tecnologia de
// persistência: os nomes exatos das colunas de uma tabela Postgres (snake_case, JSONB) e a forma de linha que o
// PostgREST espera. Isso é conhecimento de INFRAESTRUTURA (como research-adapters/htmlExtract.js conhece a forma
// de uma página HTML), não uma regra de negócio do CRM — o domínio não precisa, e não deve precisar, saber que a
// persistência de produção é (ou pode vir a ser) Postgres. Ficar em src/crm/ só porque "é fácil de testar lá" ou
// porque reaproveita CRM_WRITABLE_FIELDS foi exatamente o critério que a etapa 2.1 pediu para NÃO usar.
//
// A conversão de nome de campo é MECÂNICA (camelCase -> snake_case), a MESMA usada para escrever a migration e
// para os testes estruturais dela (tests/db/crmMigration.test.js): nenhum nome de coluna foi escolhido à mão
// campo a campo. tests/crm-adapters/crmSupabaseMapping.test.js confere que FIELD_COLUMNS bate exatamente com as
// colunas que a migration realmente declara — os dois nunca podem divergir em silêncio.
//
// POR QUE A LISTA É LITERAL AQUI (não `require('../crm/constants')`): a regra R12 (decisão 0014,
// tests/auth/architecture-boundaries.test.js) só deixa `src/crm/` ser importado por `src/services/` e por si
// mesmo — de propósito, para que ninguém contorne a autorização do CRM Service. `src/crm-adapters/` não é
// nenhum dos dois, então IMPORTAR `src/crm/constants.js` daqui, mesmo só por um array de nomes de campo,
// abriria uma exceção numa regra de segurança já deliberada. Em vez de pedir essa exceção, o adapter guarda a
// SUA PRÓPRIA cópia da lista, e tests/crm-adapters/crmSupabaseMapping.test.js ([MAP-1]) confere, a cada execução
// da suíte, que ela é IDÊNTICA a CRM_WRITABLE_FIELDS (o teste, fora de src/, pode importar dos dois lados sem
// violar R12) — a lista nunca diverge em silêncio, sem precisar abrir mão da fronteira.
const CRM_WRITABLE_FIELDS = Object.freeze([
  'empresa', 'contato', 'cargo', 'telefone', 'whatsapp', 'email', 'site', 'instagram', 'facebook', 'googlePerfil',
  'cidade', 'estado', 'nicho', 'origem', 'temperatura', 'servicoPotencial', 'problemaIdentificado', 'raioXDeNicho',
  'raioXPersonalizado', 'statusDoDiagnostico', 'linkDoRaioX', 'dataDaAnalise', 'dataDaReuniao', 'linkDoMeet',
  'proximaAcao', 'dataDaProximaAcao', 'responsavel', 'ultimaInteracao', 'valorProposta', 'valorTotal', 'observacoes',
]);

const camelToSnake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// { empresa: 'empresa', googlePerfil: 'google_perfil', raioXDeNicho: 'raio_x_de_nicho', ... } — os 31 campos
// graváveis do domínio, na mesma ordem de CRM_WRITABLE_FIELDS.
const FIELD_COLUMNS = Object.freeze(Object.fromEntries(CRM_WRITABLE_FIELDS.map((field) => [field, camelToSnake(field)])));

// Os 3 campos gerenciados que têm coluna própria na tabela (id não entra aqui: id -> id, sem tradução).
const MANAGED_COLUMNS = Object.freeze({ status: 'status', dataDeEntrada: 'data_de_entrada', historico: 'historico' });

// Registro do domínio (a forma exata que crmDomain.js produz: id + os 31 campos + status/dataDeEntrada/historico)
// -> linha pronta para o corpo de uma requisição PostgREST. `historico` viaja como ARRAY/OBJETO JS mesmo (não
// como texto): a coluna é JSONB, e o corpo da requisição inteiro é serializado uma vez, no adapter (JSON.stringify
// já lida com objetos aninhados). Um campo ausente no registro (não deveria acontecer — o domínio sempre grava
// os 31) vira `null` aqui, nunca `undefined` (PostgREST não aceita `undefined` em JSON).
function recordToRow(record) {
  const row = { id: record.id };
  for (const [field, column] of Object.entries(MANAGED_COLUMNS)) {
    row[column] = record[field] ?? null;
  }
  for (const [field, column] of Object.entries(FIELD_COLUMNS)) {
    row[column] = Object.prototype.hasOwnProperty.call(record, field) && record[field] !== undefined ? record[field] : null;
  }
  return row;
}

// Linha devolvida pelo PostgREST (inclui colunas de armazenamento que o domínio NÃO conhece: seq, version,
// updated_at) -> registro no formato exato que o domínio espera de list()/getById() — SÓ id + os 31 campos +
// status/dataDeEntrada/historico. `seq`/`version`/`updated_at` são DESCARTADOS aqui de propósito: se vazassem
// para o domínio, `moveStatus`/`updateRecord` (que fazem `{ ...record, ... }`) os carregariam adiante sem
// necessidade, e eles nunca fizeram parte do contrato público do CRM (crmService.toPublicRecord também não os
// conhece). Um campo que a linha não tiver (não deveria acontecer, a tabela tem as 31 colunas) também vira `null`.
function rowToRecord(row) {
  const record = { id: row.id };
  for (const [field, column] of Object.entries(MANAGED_COLUMNS)) {
    record[field] = Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null;
  }
  for (const [field, column] of Object.entries(FIELD_COLUMNS)) {
    record[field] = Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null;
  }
  return record;
}

module.exports = { FIELD_COLUMNS, MANAGED_COLUMNS, camelToSnake, recordToRow, rowToRecord };
