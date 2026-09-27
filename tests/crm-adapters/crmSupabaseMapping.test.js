// Mapeamento registro-do-domínio <-> linha-Postgres (decisão 0024, etapa 2) — PURO, sem rede, sem banco.
// Confere: os 31 campos batem 1:1 com CRM_WRITABLE_FIELDS, round-trip sem perda, seq/version/updated_at
// descartados na volta, e que o mapeamento nunca diverge da migration real (mesmas colunas dos dois lados).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CRM_WRITABLE_FIELDS } = require('../../src/crm/constants');
const { FIELD_COLUMNS, MANAGED_COLUMNS, camelToSnake, recordToRow, rowToRecord } = require('../../src/crm-adapters/crmSupabaseMapping');

const SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260927120000_crm_initial_schema.sql'), 'utf8');

function registroCompleto() {
  const registro = {
    id: 'crm:11111111-1111-4111-8111-111111111111',
    status: 'CONTACTED',
    dataDeEntrada: '2026-09-27T12:00:00.000Z',
    historico: [
      { timestamp: '2026-09-27T12:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: { userId: 'u1', name: 'Alguém', role: 'ADMIN' }, motivo: null },
      { timestamp: '2026-09-27T12:05:00.000Z', from: 'PROSPECT', to: 'CONTACTED', actor: 'HUMAN', reviewedBy: null, motivo: 'Primeiro contato' },
    ],
  };
  for (const field of CRM_WRITABLE_FIELDS) registro[field] = null;
  registro.empresa = 'Clínica Mapeamento Teste';
  registro.site = 'mapeamento.example.test';
  registro.valorProposta = 1500.5;
  registro.valorTotal = 0;
  registro.observacoes = 'Duas linhas.\nSegunda linha.';
  return registro;
}

test('[MAP-1] FIELD_COLUMNS tem exatamente os 31 CRM_WRITABLE_FIELDS, cada um convertido para snake_case', () => {
  assert.equal(Object.keys(FIELD_COLUMNS).length, 31);
  assert.deepEqual(Object.keys(FIELD_COLUMNS), CRM_WRITABLE_FIELDS);
  assert.equal(FIELD_COLUMNS.googlePerfil, 'google_perfil');
  assert.equal(FIELD_COLUMNS.raioXDeNicho, 'raio_x_de_nicho');
  assert.equal(FIELD_COLUMNS.valorProposta, 'valor_proposta');
  assert.equal(camelToSnake('raioXPersonalizado'), 'raio_x_personalizado');
});

test('[MAP-2] recordToRow -> rowToRecord é IDÊNTICO (round-trip): todos os 31 campos, o histórico completo, status e dataDeEntrada preservados exatamente', () => {
  const registro = registroCompleto();
  const linha = recordToRow(registro);
  assert.equal(linha.id, registro.id);
  assert.equal(linha.empresa, 'Clínica Mapeamento Teste');
  assert.equal(linha.valor_proposta, 1500.5);
  assert.equal(linha.valor_total, 0);
  assert.equal(linha.data_de_entrada, registro.dataDeEntrada);
  assert.deepEqual(linha.historico, registro.historico);

  const devolta = rowToRecord(linha);
  assert.deepEqual(devolta, registro);
});

test('[MAP-3] rowToRecord DESCARTA seq/version/updated_at (e qualquer outra coluna extra) — nunca vazam para o domínio', () => {
  const linha = recordToRow(registroCompleto());
  linha.seq = 42;
  linha.version = 7;
  linha.updated_at = '2026-09-27T13:00:00Z';
  linha.coluna_desconhecida = 'não deveria existir';
  const registro = rowToRecord(linha);
  for (const chave of ['seq', 'version', 'updated_at', 'coluna_desconhecida']) {
    assert.equal(Object.prototype.hasOwnProperty.call(registro, chave), false, chave);
  }
  assert.deepEqual(Object.keys(registro).sort(), ['id', ...Object.keys(MANAGED_COLUMNS), ...CRM_WRITABLE_FIELDS].sort());
});

test('[MAP-4] campo ausente no registro (não deveria acontecer — o domínio sempre grava os 31) vira NULL na linha, nunca undefined', () => {
  const registro = registroCompleto();
  delete registro.temperatura;
  const linha = recordToRow(registro);
  assert.equal(linha.temperatura, null);
  assert.notEqual(linha.temperatura, undefined);
  assert.ok(Object.prototype.hasOwnProperty.call(linha, 'temperatura'), 'a chave existe, com valor null (JSON não aceita undefined)');
});

test('[MAP-5] coluna ausente na linha (defensivo) vira NULL no registro', () => {
  const linha = recordToRow(registroCompleto());
  delete linha.responsavel;
  const registro = rowToRecord(linha);
  assert.equal(registro.responsavel, null);
});

test('[MAP-6] nenhuma coluna do mapeamento diverge da migration real: cada valor de FIELD_COLUMNS/MANAGED_COLUMNS aparece como coluna na migration, e "id" também', () => {
  for (const column of [...Object.values(FIELD_COLUMNS), ...Object.values(MANAGED_COLUMNS), 'id']) {
    assert.match(SQL, new RegExp(`^\\s*${column}\\s+(TEXT|NUMERIC|JSONB)\\b`, 'm'), `coluna "${column}" não encontrada na migration`);
  }
});
