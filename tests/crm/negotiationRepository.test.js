// A porta e os adapters de NEGOCIAÇÕES (src/crm/negotiationRepositoryPort.js e negotiationRepository.js — CRM 5.0, Fase D1): o mesmo contrato para memória e arquivo local; o arquivo só
// nasce na primeira gravação; escrita atômica; arquivo corrompido falha alto; ids perigosos recusados; cópias (nunca referências). Diretórios temporários próprios; nada de data/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { REQUIRED_NEGOTIATION_REPOSITORY_METHODS, assertValidNegotiationRepository, createInMemoryNegotiationRepository, createJsonFileNegotiationRepository } = require('../../src/crm/negotiationRepository');

const item = (n, extras = {}) => ({ id: `negotiation:${n}`, valorNegociado: 100 * n, eventos: [{ tipo: 'CRIADA' }], ...extras });

function arquivoTemporario(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-neg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'negotiations.json');
}

const ADAPTERS = [
  ['MEMÓRIA', () => createInMemoryNegotiationRepository()],
  ['ARQUIVO', (t) => createJsonFileNegotiationRepository(arquivoTemporario(t))],
];

test('[NEGREPO-1] a PORTA exige exatamente list, getById e save; um objeto sem eles não é um repositório', () => {
  assert.deepEqual([...REQUIRED_NEGOTIATION_REPOSITORY_METHODS], ['list', 'getById', 'save']);
  assert.equal(Object.isFrozen(REQUIRED_NEGOTIATION_REPOSITORY_METHODS), true);
  for (const ruim of [undefined, null, 'texto', {}, { list() {}, getById() {} }, { list() {}, save() {} }]) assert.throws(() => assertValidNegotiationRepository(ruim), /repositório inválido/);
  const bom = createInMemoryNegotiationRepository();
  assert.equal(assertValidNegotiationRepository(bom), bom);
  assert.equal(Object.keys(bom).some((nome) => /delete|remove|destroy|archive/i.test(nome)), false, 'uma negociação nunca é apagada');
});

for (const [rotulo, fabrica] of ADAPTERS) {
  test(`[NEGREPO-2:${rotulo}] CONTRATO: vazio no começo; save cria e substitui a negociação INTEIRA; getById devolve null para o que não existe; list devolve todas`, async (t) => {
    const repo = fabrica(t);
    assert.deepEqual(await repo.list(), []);
    assert.equal(await repo.getById('negotiation:1'), null);
    assert.deepEqual(await repo.save(item(1)), item(1));
    await repo.save(item(2));
    assert.deepEqual(await repo.getById('negotiation:1'), item(1));
    assert.deepEqual((await repo.list()).map((x) => x.id).sort(), ['negotiation:1', 'negotiation:2']);
    // substitui por inteiro (é o domínio quem monta o objeto novo)
    await repo.save({ id: 'negotiation:1', valorNegociado: 5 });
    assert.deepEqual(await repo.getById('negotiation:1'), { id: 'negotiation:1', valorNegociado: 5 });
    assert.equal((await repo.list()).length, 2);
  });

  test(`[NEGREPO-3:${rotulo}] CÓPIAS: alterar o que foi devolvido ou o que foi entregue nunca altera o armazenado`, async (t) => {
    const repo = fabrica(t);
    const original = item(1);
    await repo.save(original);
    original.valorNegociado = 999;
    original.eventos.push({ tipo: 'X' });
    const lido = await repo.getById('negotiation:1');
    assert.deepEqual(lido, item(1));
    lido.eventos.push({ tipo: 'Y' });
    (await repo.list())[0].valorNegociado = 1;
    assert.deepEqual(await repo.getById('negotiation:1'), item(1));
  });

  test(`[NEGREPO-4:${rotulo}] SAVE recusa o que não é uma negociação com id e os ids perigosos (__proto__, constructor, prototype); nada é gravado`, async (t) => {
    const repo = fabrica(t);
    for (const ruim of [undefined, null, 'texto', [], {}, { id: '' }, { id: 42 }]) assert.throws(() => repo.save(ruim), /exige uma negociação com id/);
    for (const perigoso of ['__proto__', 'constructor', 'prototype']) assert.throws(() => repo.save({ id: perigoso }), /id não permitido/);
    assert.deepEqual(await repo.list(), []);
    assert.equal(await repo.getById('__proto__'), null);
    assert.equal(await repo.getById('toString'), null, 'uma chave herdada de Object nunca é uma negociação');
  });
}

test('[NEGREPO-5:ARQUIVO] o arquivo só NASCE na primeira gravação (ler nunca o cria), tem a forma { version, negotiations }, e a escrita é atômica (nenhum temporário sobra)', async (t) => {
  const caminho = arquivoTemporario(t);
  const repo = createJsonFileNegotiationRepository(caminho);
  await repo.list();
  await repo.getById('negotiation:1');
  assert.equal(fs.existsSync(caminho), false, 'ler não cria o arquivo');
  await repo.save(item(1));
  assert.equal(fs.existsSync(caminho), true);
  const cru = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  assert.deepEqual(Object.keys(cru).sort(), ['negotiations', 'version']);
  assert.equal(cru.version, 1);
  assert.deepEqual(cru.negotiations['negotiation:1'], item(1));
  assert.deepEqual(fs.readdirSync(path.dirname(caminho)), ['negotiations.json'], 'nenhum arquivo temporário sobrou');
  // outra instância sobre o mesmo arquivo enxerga o mesmo (sem estado em memória)
  assert.deepEqual(await createJsonFileNegotiationRepository(caminho).getById('negotiation:1'), item(1));
});

test('[NEGREPO-6:ARQUIVO] ARQUIVO CORROMPIDO falha ALTO (nunca devolve "vazio" em silêncio): JSON inválido e estrutura inválida; e o caminho precisa ser um texto', async (t) => {
  const caminho = arquivoTemporario(t);
  const repo = createJsonFileNegotiationRepository(caminho);
  fs.writeFileSync(caminho, '{ não é json');
  assert.throws(() => repo.list(), /arquivo de dados corrompido \(JSON inválido\)/);
  assert.throws(() => repo.save(item(1)), /arquivo de dados corrompido/);
  for (const conteudo of ['[]', '{}', '{"version":1}', '{"version":1,"negotiations":[]}', '{"version":1,"negotiations":"x"}', 'null']) {
    fs.writeFileSync(caminho, conteudo);
    assert.throws(() => repo.list(), /estrutura inválida/, conteudo);
  }
  assert.equal(fs.readFileSync(caminho, 'utf8'), 'null', 'uma recusa nunca sobrescreve o arquivo corrompido');
  for (const ruim of [undefined, null, '', '   ', 42]) assert.throws(() => createJsonFileNegotiationRepository(ruim), /exige um filePath/);
});
