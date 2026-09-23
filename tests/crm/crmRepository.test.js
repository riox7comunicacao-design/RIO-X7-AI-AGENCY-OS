// Testes do repositório de CRM (porta + adapters de desenvolvimento) — decisão 0012.
//
// O que estes testes protegem: o CONTRATO { list, getById, save } é o mesmo para os dois
// adapters (memória e arquivo JSON) — o domínio nunca precisa saber qual está por trás; os dados
// que saem são sempre CÓPIAS (nunca o objeto interno do repositório); e nenhum dos dois aceita um
// id que corrompesse o objeto de armazenamento (constructor/__proto__/prototype).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertValidRepository, createInMemoryCrmRepository, createJsonFileCrmRepository, REQUIRED_REPOSITORY_METHODS } = require('../../src/crm/crmRepository');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'crm.json');
}

// Roda a MESMA bateria de testes contra os dois adapters — prova que o contrato é idêntico.
function eachRepository(nome, factory) {
  test(`[CRM-REPO-${nome}-1] list() começa vazio; getById() de um id inexistente devolve null`, () => {
    const repo = factory();
    assert.deepEqual(repo.list(), []);
    assert.equal(repo.getById('nao-existe'), null);
  });

  test(`[CRM-REPO-${nome}-2] save() grava, getById()/list() encontram depois`, () => {
    const repo = factory();
    repo.save({ id: 'a1', empresa: 'Empresa A' });
    assert.equal(repo.getById('a1').empresa, 'Empresa A');
    assert.equal(repo.list().length, 1);
    repo.save({ id: 'a2', empresa: 'Empresa B' });
    assert.equal(repo.list().length, 2);
  });

  test(`[CRM-REPO-${nome}-3] save() com o MESMO id substitui (upsert), nunca duplica`, () => {
    const repo = factory();
    repo.save({ id: 'a1', empresa: 'Original' });
    repo.save({ id: 'a1', empresa: 'Atualizada' });
    assert.equal(repo.list().length, 1);
    assert.equal(repo.getById('a1').empresa, 'Atualizada');
  });

  test(`[CRM-REPO-${nome}-4] save() exige um id (texto não vazio)`, () => {
    const repo = factory();
    for (const ruim of [{}, { id: '' }, { id: 42 }, { id: null }]) {
      assert.throws(() => repo.save(ruim), /id/);
    }
  });

  test(`[CRM-REPO-${nome}-5] ids perigosos (__proto__/constructor/prototype) são recusados, nunca corrompem o armazenamento`, () => {
    const repo = factory();
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(() => repo.save({ id, empresa: 'x' }), /não permitido/, id);
    }
    // O repositório continua funcionando normalmente depois das tentativas.
    repo.save({ id: 'legitimo', empresa: 'ok' });
    assert.equal(repo.list().length, 1);
    assert.equal(Object.getPrototypeOf({}), Object.prototype, 'sanidade: o protótipo global não foi alterado');
  });

  test(`[CRM-REPO-${nome}-6] list() e getById() devolvem CÓPIAS — alterar o retorno nunca muda o que está guardado`, () => {
    const repo = factory();
    repo.save({ id: 'a1', empresa: 'Empresa A', historico: [{ x: 1 }] });
    const lida = repo.getById('a1');
    lida.empresa = 'Adulterada';
    lida.historico.push({ falso: true });
    assert.equal(repo.getById('a1').empresa, 'Empresa A');
    assert.equal(repo.getById('a1').historico.length, 1);

    const [daLista] = repo.list();
    daLista.empresa = 'Também adulterada';
    assert.equal(repo.getById('a1').empresa, 'Empresa A');
  });
}

eachRepository('MEM', () => createInMemoryCrmRepository());
eachRepository('JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-repo-json-'));
  return createJsonFileCrmRepository(path.join(dir, 'crm.json'));
});

test('[CRM-REPO-MEM-7] createInMemoryCrmRepository(initialRecords) aceita uma carga inicial, também copiada', () => {
  const inicial = { id: 'seed-1', empresa: 'Semente' };
  const repo = createInMemoryCrmRepository([inicial]);
  inicial.empresa = 'Mudou depois';
  assert.equal(repo.getById('seed-1').empresa, 'Semente', 'a carga inicial também é copiada, não referenciada');
});

test('[CRM-REPO-MEM-8] createInMemoryCrmRepository recusa um registro inicial sem id', () => {
  assert.throws(() => createInMemoryCrmRepository([{ empresa: 'sem id' }]), /id/);
});

test('[CRM-REPO-JSON-9] arquivo AUSENTE vira lista vazia (nunca erro); arquivo CORROMPIDO sempre lança (nunca mascara corrupção)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-repo-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'crm.json');

  const repo = createJsonFileCrmRepository(file);
  assert.deepEqual(repo.list(), [], 'arquivo ausente = fila vazia');

  fs.writeFileSync(file, '{ isto não é json [[[', 'utf8');
  assert.throws(() => repo.list(), /corrompido/);
  assert.throws(() => repo.getById('x'), /corrompido/);

  fs.writeFileSync(file, '["um array, não um objeto"]', 'utf8');
  assert.throws(() => repo.list(), /corrompido/);
});

test('[CRM-REPO-JSON-10] persiste de fato em disco: uma SEGUNDA instância do repositório, sobre o MESMO arquivo, enxerga os dados', (t) => {
  const file = tempFile(t);
  const repoA = createJsonFileCrmRepository(file);
  repoA.save({ id: 'a1', empresa: 'Persistente' });

  const repoB = createJsonFileCrmRepository(file);
  assert.equal(repoB.getById('a1').empresa, 'Persistente');
  assert.equal(repoB.list().length, 1);
});

test('[CRM-REPO-JSON-11] createJsonFileCrmRepository exige um filePath (texto não vazio)', () => {
  for (const ruim of [undefined, null, '', '   ', 42, {}]) {
    assert.throws(() => createJsonFileCrmRepository(ruim), /filePath/);
  }
});

test('[CRM-REPO-JSON-12] uma escrita nunca deixa o arquivo num estado truncado: nenhum .tmp sobra depois de save()', (t) => {
  const file = tempFile(t);
  const repo = createJsonFileCrmRepository(file);
  repo.save({ id: 'a1', empresa: 'x' });
  const dir = path.dirname(file);
  const sobras = fs.readdirSync(dir).filter((nome) => nome.endsWith('.tmp'));
  assert.deepEqual(sobras, []);
});

test('[CRM-REPO-CONTRACT-1] assertValidRepository aceita um repositório completo e recusa um incompleto, nomeando o método que falta', () => {
  const completo = createInMemoryCrmRepository();
  assert.equal(assertValidRepository(completo), completo);

  for (const metodo of REQUIRED_REPOSITORY_METHODS) {
    const incompleto = { list: () => [], getById: () => null, save: () => {} };
    delete incompleto[metodo];
    assert.throws(() => assertValidRepository(incompleto), new RegExp(metodo));
  }
  for (const invalido of [null, undefined, 42, 'x', [], () => {}]) {
    assert.throws(() => assertValidRepository(invalido));
  }
});
