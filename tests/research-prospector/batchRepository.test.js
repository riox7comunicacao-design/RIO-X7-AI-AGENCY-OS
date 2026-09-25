// Repositório de lotes (src/research-prospector/batchRepository.js): a porta e os dois adapters.
//
// O que estes testes provam: o lote é uma entidade SEPARADA (nada de lote no schema da fila); o adapter de arquivo trata ENOENT como
// coleção vazia, recusa arquivo corrompido, escreve de forma atômica, nunca sobrescreve um loteId existente, nunca aceita id
// perigoso, devolve cópias e escolhe o caminho só por quem compõe. Os dois adapters obedecem ao mesmo contrato.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_BATCH_PATH,
  BATCH_ID_PATTERN,
  REQUIRED_BATCH_REPOSITORY_METHODS,
  assertValidBatchRepository,
  createInMemoryBatchRepository,
  createJsonFileBatchRepository,
} = require('../../src/research-prospector/batchRepository');

const ID_A = 'lote:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'lote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const lote = (loteId, extras = {}) => ({ loteId, status: 'EM_ANDAMENTO', contagens: { encontrados: 1, validos: 1 }, prospectIds: ['id:a.example.test'], ...extras });

function arquivoTemporario(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'sub', 'lotes.json') };
}

const adapters = (t) => [
  ['memória', () => createInMemoryBatchRepository()],
  ['arquivo', () => createJsonFileBatchRepository(arquivoTemporario(t).file)],
];

test('[BATCH-REPO-1] o contrato é o mesmo nos dois adapters: add/list/getById, cópias, ordem de inserção, id inexistente é null', (t) => {
  for (const [nome, criar] of adapters(t)) {
    const repo = criar();
    assertValidBatchRepository(repo);
    assert.deepEqual(repo.list(), [], `${nome}: vazio`);
    assert.equal(repo.getById(ID_A), null, nome);
    repo.add(lote(ID_A));
    repo.add(lote(ID_B, { status: 'META_ATINGIDA' }));
    assert.deepEqual(repo.list().map((l) => l.loteId), [ID_A, ID_B], nome);
    assert.equal(repo.getById(ID_B).status, 'META_ATINGIDA', nome);
    // cópias: mudar o que voltou não muda o repositório
    const lido = repo.getById(ID_A);
    lido.contagens.validos = 99;
    lido.prospectIds.push('forjado');
    repo.list()[0].status = 'FORJADO';
    assert.equal(repo.getById(ID_A).contagens.validos, 1, nome);
    assert.deepEqual(repo.getById(ID_A).prospectIds, ['id:a.example.test'], nome);
    assert.equal(repo.getById(ID_A).status, 'EM_ANDAMENTO', nome);
    // e o que foi passado a add() também é copiado
    const original = lote('lote:cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    repo.add(original);
    original.contagens.validos = 12345;
    assert.equal(repo.getById(original.loteId).contagens.validos, 1, nome);
    for (const ruim of [undefined, null, 5, {}, [], '__proto__', 'constructor', 'toString']) assert.equal(repo.getById(ruim), null, `${nome}: ${JSON.stringify(ruim)}`);
  }
});

test('[BATCH-REPO-2] nunca sobrescreve: um loteId que já existe recusa com BATCH_CONFLICT e o original fica intacto', (t) => {
  for (const [nome, criar] of adapters(t)) {
    const repo = criar();
    repo.add(lote(ID_A, { status: 'ORIGINAL' }));
    assert.throws(() => repo.add(lote(ID_A, { status: 'OUTRO' })), (erro) => erro.code === 'BATCH_CONFLICT' && /^Lote: /.test(erro.message));
    assert.equal(repo.getById(ID_A).status, 'ORIGINAL', nome);
    assert.equal(repo.list().length, 1, nome);
  }
});

test('[BATCH-REPO-3] só entra um lote com loteId no formato lote:<uuid>: __proto__, constructor, caminhos, texto solto e tipos errados são recusados', (t) => {
  for (const [nome, criar] of adapters(t)) {
    const repo = criar();
    for (const loteId of ['__proto__', 'constructor', 'prototype', '../x', 'lote:x', 'lote:AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ' lote:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '', 5, null, undefined, {}, []]) {
      assert.throws(() => repo.add({ loteId }), /loteId no formato/, `${nome}: ${JSON.stringify(loteId)}`);
    }
    for (const ruim of [null, undefined, 'texto', 5, []]) assert.throws(() => repo.add(ruim), /exige um lote/, `${nome}: ${JSON.stringify(ruim)}`);
    assert.deepEqual(repo.list(), [], nome);
  }
  assert.equal(BATCH_ID_PATTERN.test(ID_A), true);
});

test('[BATCH-REPO-4] adapter de arquivo: ENOENT é coleção vazia (e NÃO cria o arquivo ao ler); depois do add o arquivo existe, cria a pasta, e um adapter novo sobre o mesmo arquivo relê tudo (reabertura)', (t) => {
  const { dir, file } = arquivoTemporario(t);
  const repo = createJsonFileBatchRepository(file);
  assert.deepEqual(repo.list(), []);
  assert.equal(repo.getById(ID_A), null);
  assert.equal(fs.existsSync(path.dirname(file)), false, 'ler não cria nada');
  repo.add(lote(ID_A));
  assert.ok(fs.existsSync(file));
  const reaberto = createJsonFileBatchRepository(file);
  assert.deepEqual(reaberto.getById(ID_A), lote(ID_A));
  reaberto.add(lote(ID_B));
  assert.deepEqual(createJsonFileBatchRepository(file).list().map((l) => l.loteId), [ID_A, ID_B]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), [], 'nenhum temporário sobra (escrita atômica)');
  assert.ok(dir);
});

test('[BATCH-REPO-5] arquivo existente e corrompido LANÇA (nunca é tratado como vazio, nunca é sobrescrito): JSON inválido, lista, texto, null', (t) => {
  for (const conteudo of ['{ nao é json', '[]', '"texto"', 'null', '42']) {
    const { file } = arquivoTemporario(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, conteudo);
    const repo = createJsonFileBatchRepository(file);
    assert.throws(() => repo.list(), /arquivo de lotes corrompido/, conteudo);
    assert.throws(() => repo.getById(ID_A), /arquivo de lotes corrompido/, conteudo);
    assert.throws(() => repo.add(lote(ID_A)), /arquivo de lotes corrompido/, conteudo);
    assert.equal(fs.readFileSync(file, 'utf8'), conteudo, 'o arquivo corrompido não foi sobrescrito');
  }
});

test('[BATCH-REPO-6] uma chave "__proto__" vinda do arquivo é dado comum, nunca reatribui o protótipo; e um lote nunca contamina Object.prototype', (t) => {
  const { file } = arquivoTemporario(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `{ "__proto__": { "polluted": true }, "${ID_A}": ${JSON.stringify(lote(ID_A))} }`);
  const repo = createJsonFileBatchRepository(file);
  assert.equal(repo.getById(ID_A).loteId, ID_A);
  assert.equal({}.polluted, undefined);
  repo.add(lote(ID_B));
  assert.equal({}.polluted, undefined);
  assert.equal(repo.getById('__proto__') === null || typeof repo.getById('__proto__') === 'object', true);
});

test('[BATCH-REPO-7] uma falha ao escrever não deixa temporário nem corrompe o arquivo anterior', (t) => {
  const { file } = arquivoTemporario(t);
  const repo = createJsonFileBatchRepository(file);
  repo.add(lote(ID_A));
  const antes = fs.readFileSync(file, 'utf8');
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('rename falhou'); };
  try {
    assert.throws(() => repo.add(lote(ID_B)), /rename falhou/);
  } finally {
    fs.renameSync = original;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), antes, 'o arquivo final continua na versão anterior completa');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), [], 'o temporário foi removido');
  assert.equal(createJsonFileBatchRepository(file).getById(ID_B), null);
});

test('[BATCH-REPO-8] o caminho: o padrão é seguro (data/prospecting-batches.json, dentro do repositório e ignorado pelo Git), e um caminho inválido é recusado', () => {
  assert.equal(path.basename(DEFAULT_BATCH_PATH), 'prospecting-batches.json');
  assert.equal(path.basename(path.dirname(DEFAULT_BATCH_PATH)), 'data');
  assert.equal(path.resolve(DEFAULT_BATCH_PATH), path.resolve(__dirname, '..', '..', 'data', 'prospecting-batches.json'));
  const gitignore = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
  assert.match(gitignore, /^data\/\*\.json$/m, 'data/*.json está fora do Git');
  for (const ruim of ['', '   ', 5, null, {}, []]) assert.throws(() => createJsonFileBatchRepository(ruim), /filePath/, JSON.stringify(ruim));
  assert.doesNotThrow(() => createJsonFileBatchRepository());
  assert.equal(fs.existsSync(DEFAULT_BATCH_PATH), false, 'criar o adapter com o padrão não cria arquivo');
});

test('[BATCH-REPO-9] a verificação do contrato falha fechada: faltando qualquer método (list, getById, add), ou não sendo objeto, o repositório é recusado', () => {
  assert.deepEqual([...REQUIRED_BATCH_REPOSITORY_METHODS], ['list', 'getById', 'add']);
  for (const metodo of REQUIRED_BATCH_REPOSITORY_METHODS) {
    const repo = { list() {}, getById() {}, add() {} };
    delete repo[metodo];
    assert.throws(() => assertValidBatchRepository(repo), new RegExp(metodo));
    assert.throws(() => assertValidBatchRepository({ ...repo, [metodo]: 'x' }), new RegExp(metodo));
  }
  for (const ruim of [null, undefined, 'x', 5]) assert.throws(() => assertValidBatchRepository(ruim), /repositório de lotes inválido/);
  assert.doesNotThrow(() => assertValidBatchRepository({ list() {}, getById() {}, add() {} }));
});

test('[BATCH-REPO-10] o lote é separado da fila: o repositório não importa a fila e o schema dos itens da fila não tem campo de lote', () => {
  const codigo = fs.readFileSync(require.resolve('../../src/research-prospector/batchRepository.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /approvalQueue|QUEUE_STATE|discovery/);
  const fila = fs.readFileSync(require.resolve('../../src/research-prospector/approvalQueue.js'), 'utf8');
  assert.doesNotMatch(fila, /loteId/, 'a fila não conhece o lote');
});
