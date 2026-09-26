// Repositório de dossiês (src/research-prospector/dossierRepository.js) — decisão 0018.
// Porta list/getById/save; save INSERE e nunca sobrescreve; ids seguros; escrita atômica; arquivo local fora do Git.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildDossier } = require('../../src/research-prospector/dossier');
const repoModule = require('../../src/research-prospector/dossierRepository');
const { createInMemoryDossierRepository, createJsonFileDossierRepository, assertValidDossierRepository, DEFAULT_DOSSIER_PATH } = repoModule;

const AGORA = new Date('2026-09-25T15:00:00.000Z');
const novo = (i = 1, extras = {}) => {
  const r = buildDossier({
    prospectId: `id:clinica-${i}.example.test`,
    fatos: [{ campo: 'site.url', valor: `https://clinica${i}.example.test`, status: 'DADO', observadoEm: '2026-09-25', fonte: { url: 'https://fonte.example.test/p', tipo: 'OFICIAL', observadoEm: '2026-09-25' } }, ...(extras.fatos || [])],
  }, { now: AGORA });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.value;
};
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dossie-'));
  return { dir, file: path.join(dir, 'dados', 'prospecting-dossiers.json'), limpar: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const adapters = () => {
  const t = tmp();
  return [['memória', () => createInMemoryDossierRepository(), () => {}], ['arquivo', () => createJsonFileDossierRepository(t.file), t.limpar]];
};

for (const [nome, criar, limpar] of adapters()) {
  test(`[DOSREPO-1:${nome}] porta completa; repositório vazio lista [] e getById devolve null`, () => {
    try {
      const repo = criar();
      assertValidDossierRepository(repo);
      assert.deepEqual(repo.list(), []);
      assert.equal(repo.getById('dossie:11111111-1111-4111-8111-111111111111'), null);
    } finally { limpar(); }
  });

  test(`[DOSREPO-2:${nome}] save, getById e list preservam o dossiê e a ordem de gravação`, () => {
    try {
      const repo = criar();
      const a = novo(1);
      const b = novo(2);
      repo.save(a);
      repo.save(b);
      assert.deepEqual(repo.getById(a.dossierId), a);
      assert.deepEqual(repo.list().map((d) => d.dossierId), [a.dossierId, b.dossierId]);
    } finally { limpar(); }
  });

  test(`[DOSREPO-3:${nome}] save NÃO sobrescreve: o mesmo dossierId é recusado com DOSSIER_CONFLICT e o original fica intacto`, () => {
    try {
      const repo = criar();
      const a = novo(1);
      repo.save(a);
      const outro = { ...novo(2), dossierId: a.dossierId };
      assert.throws(() => repo.save(outro), (e) => e.code === 'DOSSIER_CONFLICT');
      assert.deepEqual(repo.getById(a.dossierId), a);
      assert.equal(repo.list().length, 1);
    } finally { limpar(); }
  });

  test(`[DOSREPO-4:${nome}] cópia defensiva: mutar o que entrou ou o que saiu não altera o armazenado`, () => {
    try {
      const repo = criar();
      const a = novo(1);
      const copiaOriginal = structuredClone(a);
      repo.save(a);
      a.fatos[0].valor = 'https://mutado.example.test';
      const lido = repo.getById(copiaOriginal.dossierId);
      lido.fatos[0].valor = 'https://mutado2.example.test';
      repo.list()[0].fatos.length = 0;
      assert.deepEqual(repo.getById(copiaOriginal.dossierId), copiaOriginal);
    } finally { limpar(); }
  });

  test(`[DOSREPO-5:${nome}] id inválido: save recusa dossiê sem id, com id fora do formato, path traversal e chaves do protótipo; getById devolve null sem lançar`, () => {
    try {
      const repo = criar();
      for (const dossierId of [undefined, null, 5, '', 'x', '__proto__', 'constructor', 'toString', '../../etc/passwd', '..\\..\\x', 'dossie:../x', 'dossie:11111111-1111-4111-8111-111111111111/../x', 'DOSSIE:11111111-1111-4111-8111-111111111111']) {
        assert.throws(() => repo.save({ ...novo(1), dossierId }), /Dossiê: save\(\) exige/, JSON.stringify(dossierId));
      }
      for (const ruim of [null, undefined, 'x', 5, [], () => {}]) assert.throws(() => repo.save(ruim), /Dossiê: save\(\) exige/);
      for (const id of ['__proto__', 'constructor', 'hasOwnProperty', '../x', '', null, undefined, 5, {}, []]) assert.equal(repo.getById(id), null, String(id));
      assert.deepEqual(repo.list(), []);
      assert.equal({}.polluted, undefined);
    } finally { limpar(); }
  });
}

test('[DOSREPO-6] o arquivo persiste entre instâncias e fica em JSON legível indexado pelo dossierId; o diretório é criado; não sobra temporário', () => {
  const t = tmp();
  try {
    const a = novo(1);
    createJsonFileDossierRepository(t.file).save(a);
    const reaberto = createJsonFileDossierRepository(t.file);
    assert.deepEqual(reaberto.getById(a.dossierId), a);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(t.file, 'utf8'))), [a.dossierId]);
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['prospecting-dossiers.json'], 'sem .tmp deixado');
    assert.throws(() => reaberto.save(a), (e) => e.code === 'DOSSIER_CONFLICT');
  } finally { t.limpar(); }
});

test('[DOSREPO-7] arquivo corrompido ou de estrutura errada LANÇA (nunca é tratado como vazio, e nunca é sobrescrito); ENOENT é vazio', () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    for (const conteudo of ['{ quebrado', '[]', 'null', '"texto"', '5']) {
      fs.writeFileSync(t.file, conteudo);
      const repo = createJsonFileDossierRepository(t.file);
      assert.throws(() => repo.list(), /arquivo de dossiês corrompido/, conteudo);
      assert.throws(() => repo.save(novo(1)), /arquivo de dossiês corrompido/, conteudo);
      assert.equal(fs.readFileSync(t.file, 'utf8'), conteudo, 'o arquivo corrompido não é sobrescrito');
    }
    fs.rmSync(t.file);
    assert.deepEqual(createJsonFileDossierRepository(t.file).list(), []);
  } finally { t.limpar(); }
});

test('[DOSREPO-8] prototype pollution no arquivo: uma chave __proto__ vira dado comum, não polui nada e nunca é devolvida por getById', () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, '{"__proto__":{"polluted":true},"constructor":{"x":1}}');
    const repo = createJsonFileDossierRepository(t.file);
    assert.equal({}.polluted, undefined);
    assert.equal(repo.getById('__proto__'), null);
    assert.equal(repo.getById('constructor'), null);
    const a = novo(1);
    repo.save(a);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(repo.getById(a.dossierId), a);
    const gravado = JSON.parse(fs.readFileSync(t.file, 'utf8'));
    assert.deepEqual(Object.keys(gravado).sort(), ['__proto__', 'constructor', a.dossierId].sort(), 'os dados do arquivo são preservados como chaves comuns');
  } finally { t.limpar(); }
});

test('[DOSREPO-9] escrita atômica: uma falha na escrita não deixa o arquivo pela metade nem um temporário; o conteúdo anterior fica íntegro', () => {
  const t = tmp();
  try {
    const repo = createJsonFileDossierRepository(t.file);
    const a = novo(1);
    repo.save(a);
    const antes = fs.readFileSync(t.file, 'utf8');
    const original = fs.renameSync;
    fs.renameSync = () => { throw new Error('falha simulada no rename'); };
    try {
      assert.throws(() => repo.save(novo(2)), /falha simulada/);
    } finally { fs.renameSync = original; }
    assert.equal(fs.readFileSync(t.file, 'utf8'), antes);
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['prospecting-dossiers.json']);
  } finally { t.limpar(); }
});

test('[DOSREPO-10] o caminho vem só de quem compõe: filePath inválido é recusado, o dossiê nunca escolhe onde gravar, e o padrão é data/prospecting-dossiers.json', () => {
  for (const ruim of ['', '   ', null, 5, {}, []]) assert.throws(() => createJsonFileDossierRepository(ruim), /exige um filePath/);
  assert.equal(path.basename(DEFAULT_DOSSIER_PATH), 'prospecting-dossiers.json');
  assert.equal(path.basename(path.dirname(DEFAULT_DOSSIER_PATH)), 'data');
  const t = tmp();
  try {
    const repo = createJsonFileDossierRepository(t.file);
    const hostil = { ...novo(1), prospectId: '../../fora.json' };
    repo.save(hostil);
    assert.deepEqual(fs.readdirSync(t.dir), ['dados']);
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['prospecting-dossiers.json']);
  } finally { t.limpar(); }
});

test('[DOSREPO-11] o arquivo real de dossiês é ignorado pelo Git e nenhum data/*.json é versionado', () => {
  const raiz = path.join(__dirname, '..', '..');
  const ignorado = execFileSync('git', ['check-ignore', 'data/prospecting-dossiers.json'], { cwd: raiz, encoding: 'utf8' }).trim();
  assert.equal(ignorado, 'data/prospecting-dossiers.json');
  const rastreados = execFileSync('git', ['ls-files', 'data'], { cwd: raiz, encoding: 'utf8' }).split('\n').filter((l) => l.endsWith('.json'));
  assert.deepEqual(rastreados, []);
});

test('[DOSREPO-12] a porta rejeita repositórios incompletos e o adapter em memória aceita dossiês iniciais (copiados) e recusa os inválidos', () => {
  for (const ruim of [null, undefined, 5, {}, { list() {}, getById() {} }, { list() {}, save() {} }, { getById() {}, save() {} }]) assert.throws(() => assertValidDossierRepository(ruim), /repositório de dossiês inválido/);
  const a = novo(1);
  const repo = createInMemoryDossierRepository([a]);
  a.fatos.length = 0;
  assert.equal(repo.getById(a.dossierId).fatos.length, 1);
  assert.throws(() => createInMemoryDossierRepository([{ dossierId: 'x' }]), /Dossiê: save\(\) exige/);
});
