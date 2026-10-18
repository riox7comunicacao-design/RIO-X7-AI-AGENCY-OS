'use strict';

// Clientes PF/PJ (CRM 5.0, Fase D2) nos DOIS armazenamentos do CRM: o mapeamento registro <-> linha, o adapter do Supabase sobre um PostgREST FALSO em memória e o adapter de ARQUIVO. Prova que a Pessoa Física
// (sem `empresa`) e o registro antigo (sem tipo) atravessam a persistência sem perda, que a duplicidade/DNC por documento funciona sobre o que o adapter LÊ, e que uma falha de rede nunca vira falso sucesso.
// Nenhuma rede, nenhum Supabase real, nenhuma chave real (a "chave" é um texto de teste), nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crm = require('../../src/crm/crmDomain');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { CRM_WRITABLE_FIELDS, CRM_LEGACY_WRITABLE_FIELDS } = require('../../src/crm/constants');
const { createSupabaseCrmRepository } = require('../../src/crm-adapters/crmSupabaseRepository');
const { recordToRow, rowToRecord } = require('../../src/crm-adapters/crmSupabaseMapping');
const { postgrestCrm, registro, idDe, resposta } = require('../helpers/fakePostgrestCrmList');

const URL_BASE = 'https://exemplo-falso.example.test';
const CHAVE = 'chave-falsa-de-teste-nao-e-real';
const OP = Object.freeze({ actor: 'HUMAN', reviewedBy: { userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' }, motivo: null });
const CPF_A = '529.982.247-25';
const CNPJ_A = '11.222.333/0001-81';

const repo = (fetchImpl) => createSupabaseCrmRepository({ url: URL_BASE, serviceRoleKey: CHAVE, fetchImpl });
const criar = (r, campos, opcoes = {}) => crm.createRecord(r, campos, { ...OP, ...opcoes });

test('[PERSON-SB-1] MAPEAMENTO: uma Pessoa Física (empresa nula) e uma PJ viram linha e voltam IDÊNTICAS; os 4 campos novos têm as colunas tipo_pessoa, nome_completo, cpf e cnpj', () => {
  const pf = registro({ id: idDe(1), empresa: null, tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: '52998224725', telefone: '24 90000-1111' });
  const linha = recordToRow(pf);
  assert.deepEqual([linha.tipo_pessoa, linha.nome_completo, linha.cpf, linha.cnpj, linha.empresa], ['PF', 'Maria Souza', '52998224725', null, null]);
  assert.deepEqual(rowToRecord(linha), pf);
  const pj = registro({ id: idDe(2), empresa: 'Clínica Aurora', tipoPessoa: 'PJ', cnpj: '11222333000181', contato: 'Ana Lima' });
  assert.deepEqual(rowToRecord(recordToRow(pj)), pj);
  // a linha tem as 35 colunas de campo (nenhuma a mais, nenhuma a menos)
  const colunasDeCampo = Object.keys(linha).filter((coluna) => !['id', 'status', 'data_de_entrada', 'historico'].includes(coluna));
  assert.equal(colunasDeCampo.length, CRM_WRITABLE_FIELDS.length);
});

test('[PERSON-SB-2] um registro ANTIGO lido do banco (colunas novas nulas, ou linha de antes da migration sem elas) volta com os 4 campos nulos — o tipo nunca é inferido', () => {
  const linhaNova = { ...recordToRow(registro({ id: idDe(3), empresa: 'Clínica Antiga' })), seq: 1, version: 1, updated_at: 'x' };
  assert.deepEqual(['tipo_pessoa', 'nome_completo', 'cpf', 'cnpj'].map((coluna) => linhaNova[coluna]), [null, null, null, null]);
  const lido = rowToRecord(linhaNova);
  assert.deepEqual([lido.tipoPessoa, lido.nomeCompleto, lido.cpf, lido.cnpj, lido.empresa], [null, null, null, null, 'Clínica Antiga']);
  const linhaAntesDaMigration = { ...linhaNova };
  for (const coluna of ['tipo_pessoa', 'nome_completo', 'cpf', 'cnpj']) delete linhaAntesDaMigration[coluna];
  assert.deepEqual([rowToRecord(linhaAntesDaMigration).tipoPessoa, rowToRecord(linhaAntesDaMigration).cpf], [null, null]);
});

test('[PERSON-SB-3] ADAPTER SUPABASE: criar PF e PJ pelo domínio grava a linha com as colunas novas (e `empresa` NULL na PF), lê de volta igual e não manda campo nenhum que a tabela não tenha', async () => {
  const s = postgrestCrm({ linhas: [] });
  const r = repo(s.fetchImpl);
  const { record: pf } = await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A });
  const { record: pj } = await criar(r, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: CNPJ_A });
  const posts = s.chamadas.filter((c) => c.metodo === 'POST');
  assert.equal(posts.length, 2);
  const corpoPf = JSON.parse(posts[0].init.body)[0];
  assert.deepEqual([corpoPf.tipo_pessoa, corpoPf.nome_completo, corpoPf.cpf, corpoPf.cnpj, corpoPf.empresa], ['PF', 'Maria Souza', '52998224725', null, null]);
  assert.deepEqual(Object.keys(corpoPf).sort(), Object.keys(recordToRow(pf)).sort(), 'exatamente as colunas do mapeamento');
  assert.equal(JSON.stringify(corpoPf).includes(CHAVE), false);
  const lidos = await r.list();
  assert.deepEqual(lidos.map((x) => x.id).sort(), [pf.id, pj.id].sort());
  assert.deepEqual(lidos.find((x) => x.id === pf.id), pf);
  assert.deepEqual(await r.getById(pj.id), pj);
});

test('[PERSON-SB-4] sobre o adapter do Supabase: duplicidade e DNC por DOCUMENTO usam o que o adapter LÊ (list); o mesmo CPF/CNPJ é recusado, o de um bloqueado também, documentos diferentes passam', async () => {
  const s = postgrestCrm({ linhas: [] });
  const r = repo(s.fetchImpl);
  const { record: pf } = await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A });
  await criar(r, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: CNPJ_A });
  await assert.rejects(() => criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Outra Pessoa', cpf: '52998224725' }), /já existe um registro com a mesma identidade \(cpf\)/);
  await assert.rejects(() => criar(r, { tipoPessoa: 'PJ', empresa: 'Outro Nome', cnpj: '11222333000181' }), /já existe um registro com a mesma identidade \(cnpj\)/);
  assert.equal(s.linhas().length, 2, 'nenhuma duplicata foi gravada');
  await crm.markDoNotContact(r, pf.id, OP);
  await assert.rejects(() => criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Nome Novo', cpf: CPF_A }), /identidade já bloqueada como DO_NOT_CONTACT/);
  assert.equal((await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Pessoa Livre', cpf: '111.444.777-35' })).record.cpf, '11144477735');
});

test('[PERSON-SB-5] REVISÃO de um registro antigo pelo adapter do Supabase: definir o tipo grava a linha completa com TODOS os campos originais intactos (e só os 4 novos mudam)', async () => {
  const antigo = registro({ id: idDe(7), empresa: 'Estúdio Dias', cidade: 'Niterói', nicho: 'Design', valorProposta: 900, valorTotal: 1800, observacoes: 'cliente antigo' });
  const s = postgrestCrm({ linhas: [antigo] });
  const r = repo(s.fetchImpl);
  const atualizado = await crm.updateRecord(r, antigo.id, { tipoPessoa: 'PF', nomeCompleto: 'Fulano Dias', cpf: CPF_A });
  const linha = s.linhas().find((x) => x.id === antigo.id);
  assert.deepEqual([linha.tipo_pessoa, linha.nome_completo, linha.cpf, linha.empresa], ['PF', 'Fulano Dias', '52998224725', 'Estúdio Dias']);
  for (const campo of CRM_LEGACY_WRITABLE_FIELDS) assert.deepEqual(atualizado[campo], antigo[campo], `${campo} intacto`);
  assert.deepEqual(atualizado.historico, antigo.historico);
});

test('[PERSON-SB-6] FALHA DE REDE nunca é falso sucesso: se o POST falha, o domínio rejeita, nada fica na tabela e a mensagem não carrega a chave nem o corpo', async () => {
  const s = postgrestCrm({ linhas: [] });
  const falha = async (url, init) => {
    if (init.method === 'POST') throw new Error(`socket fechado com ${CHAVE} e Maria Souza`);
    return s.fetchImpl(url, init);
  };
  const r = repo(falha);
  let erro = null;
  try {
    await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A });
  } catch (e) {
    erro = e;
  }
  assert.ok(erro, 'a criação falhou');
  assert.equal(String(erro.message).includes(CHAVE), false, 'a chave nunca aparece');
  assert.equal(String(erro.message).includes('Maria Souza'), false, 'o dado do cliente nunca aparece');
  assert.equal(s.linhas().length, 0, 'nada foi gravado');
  // e um 5xx do PostgREST também é erro, nunca um registro "criado"
  const s5 = postgrestCrm({ linhas: [], aoResponder: (n, init) => (init.method === 'POST' ? resposta(503, { message: 'indisponível' }) : null) });
  await assert.rejects(() => criar(repo(s5.fetchImpl), { tipoPessoa: 'PJ', empresa: 'Clínica Aurora' }));
  assert.equal(s5.linhas().length, 0);
});

test('[PERSON-SB-7] uma violação da restrição de coerência do BANCO (400 do PostgREST) vira erro de dado do adapter, nunca sucesso — a segunda barreira, por trás da validação do domínio', async () => {
  const s = postgrestCrm({ linhas: [], aoResponder: (n, init) => (init.method === 'POST' ? resposta(400, { code: '23514', message: 'new row for relation "crm_records" violates check constraint "crm_records_identificacao_check"' }) : null) });
  const r = repo(s.fetchImpl);
  let erro = null;
  try {
    await r.save(registro({ id: idDe(9), empresa: null, tipoPessoa: null, nomeCompleto: 'Maria' }));
  } catch (e) {
    erro = e;
  }
  assert.ok(erro, 'o banco recusou e o adapter propagou');
  assert.equal(erro.code, 'CRM_REPOSITORY_INVALID_REQUEST');
  assert.equal(String(erro.message).includes(CHAVE), false);
});

test('[PERSON-FILE-1] ADAPTER DE ARQUIVO: a PF e o registro antigo (sem as chaves novas no JSON) sobrevivem a gravar e reler, com a ordem e o conteúdo intactos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-file-'));
  const arquivo = path.join(dir, 'crm.json');
  try {
    const antigoBruto = {
      id: 'crm:00000000-0000-4000-8000-0000000000b1',
      ...Object.fromEntries(CRM_LEGACY_WRITABLE_FIELDS.map((campo) => [campo, null])),
      empresa: 'Clínica Antiga',
      status: 'PROSPECT',
      dataDeEntrada: '2026-09-10T12:00:00.000Z',
      historico: [{ timestamp: '2026-09-10T12:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: null, motivo: null }],
    };
    fs.writeFileSync(arquivo, JSON.stringify({ [antigoBruto.id]: antigoBruto }, null, 2));
    const r = createJsonFileCrmRepository(arquivo);
    const { record: pf } = await criar(r, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: CPF_A });
    const { record: pj } = await criar(r, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: CNPJ_A });
    const relido = createJsonFileCrmRepository(arquivo);
    assert.deepEqual(await relido.getById(pf.id), pf);
    assert.deepEqual(await relido.getById(pj.id), pj);
    assert.deepEqual(await relido.getById(antigoBruto.id), antigoBruto, 'o registro antigo continua byte a byte como era');
    assert.equal((await relido.list()).length, 3);
    // o arquivo antigo ainda é editável pelo domínio, sem as chaves novas
    const editado = await crm.updateRecord(relido, antigoBruto.id, { cidade: 'Niterói' });
    assert.equal(editado.cidade, 'Niterói');
    assert.equal(editado.empresa, 'Clínica Antiga');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
