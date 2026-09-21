// Fase F — fronteiras arquiteturais de autorização: testes ESTÁTICOS permanentes.
//
// O que estes testes protegem: as fronteiras de importação que sustentam a cadeia
//   Supabase Auth -> identidade verificada -> USER -> AuthorizationContext -> serviço -> domínio
// não podem ser rompidas por um arquivo NOVO. Eles não fotografam a árvore de hoje:
// percorrem TODOS os arquivos de código de src/ (a cada execução) e aplicam regras.
// Um arquivo criado amanhã que importe o emissor de contexto, dependa de tests/, ligue
// o prospector ao auth (ou o contrário) faz o teste falhar, dizendo QUAL arquivo,
// QUAL regra e QUAL dependência. Os auto-testes (ARCH-S*) provam isso em árvores
// sintéticas criadas em diretório temporário — uma regra que nunca foi vista falhando
// não é uma regra.
//
// Regras (o texto completo de cada uma está em RULES, logo abaixo):
//   R1  só userResolver.js e authorizationContext.js importam o emissor interno;
//   R2  src/ não depende de tests/ (nem de nada fora de src/);
//   R3  src/research-prospector/ não importa src/auth/;
//   R4  src/auth/ não importa src/research-prospector/;
//   R5  sem dependências circulares em src/;
//   R6  todo carregamento de módulo é estaticamente analisável (sem require dinâmico,
//       alias de require, createRequire, eval...) — do contrário a análise seria cega;
//   R7  só authAdapter.js importa o SDK do Supabase, e o adapter não importa src/;
//   R8  o catálogo PERMISSION nunca é enumerado (permissões de uma role são listas
//       literais; ADMIN nunca vira "todas as permissões" por Object.values(PERMISSION)).
// Além do grafo estático, o grafo REAL de execução (módulos que src/ de fato carrega,
// medido num processo filho) é conferido contra as mesmas regras e contra o grafo
// estático: qualquer aresta de execução que a análise estática não viu é um ponto cego.
//
// Limite honesto: análise estática é uma rede contra regressões acidentais ou
// preguiçosas — inclusive código escrito às pressas por uma pessoa ou por uma IA. É
// uma fronteira arquitetural interna confiável (trusted internal architectural
// boundary), NÃO criptografia nem sandbox: não impede código que controle o mesmo
// processo (que pode alterar módulos em memória, por exemplo).
//
// Sem rede, sem .env, sem docs/, sem caminho absoluto: tudo é relativo à raiz do
// repositório (dois níveis acima deste arquivo), e funciona em checkout limpo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { listSourceFiles, analyzeSource, resolveSpecifier, walkTokenArrays, toPosix } = require('../helpers/staticImports');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// As regras
// ---------------------------------------------------------------------------
const ISSUER_FILE = 'src/auth/internal/contextIssuer.js';
const ISSUER_MODULE = 'src/auth/internal/contextissuer'; // minúsculo e sem extensão, para comparar
const ISSUER_IMPORTERS = ['src/auth/userResolver.js', 'src/auth/authorizationContext.js'];
const SDK_PACKAGE = '@supabase/supabase-js';
const SDK_IMPORTER = 'src/auth/authAdapter.js';
const LOADER_BUILTINS = new Set(['module', 'vm']);

const RULES = {
  R1: 'Somente src/auth/userResolver.js e src/auth/authorizationContext.js podem importar o emissor interno src/auth/internal/contextIssuer.js.',
  R2: 'src/ não pode depender de tests/ (nem de qualquer arquivo fora de src/).',
  R3: 'src/research-prospector/ não pode importar src/auth/ (o domínio recebe a autorização por injeção).',
  R4: 'src/auth/ não pode importar src/research-prospector/ (AUTH != PROSPECTOR; a integração é da camada de serviço).',
  R5: 'src/ não pode ter dependências circulares.',
  R6: 'Todo carregamento de módulo em src/ precisa ser estaticamente analisável (um carregamento que a análise não enxerga escapa de todas as fronteiras).',
  R7: 'Somente src/auth/authAdapter.js importa @supabase/supabase-js, e o adapter não importa outros módulos de src/ (ele só responde "quem está autenticado?").',
  R8: 'O catálogo PERMISSION não pode ser enumerado nem passado como valor em src/: as permissões de uma role são listas literais e explícitas.',
};

// Detalhe de uma aresta (arquivo -> alvo) que viola uma regra; usado no grafo estático e no de execução.
const EDGE_DETAIL = {
  R1: 'importa diretamente o emissor interno de AuthorizationContext, reservado a userResolver.js e authorizationContext.js',
  R2: 'src/ não pode depender de tests/ nem de nada fora de src/',
  R3: 'o domínio research-prospector não pode importar src/auth',
  R4: 'src/auth não pode importar o domínio research-prospector',
};

const lc = (value) => value.toLowerCase();
const stripExtension = (value) => value.replace(/\.(?:c|m)?[jt]sx?$/i, '');
const insideSrc = (rel) => rel === 'src' || rel.startsWith('src/');
const ISSUER_IMPORTERS_LC = ISSUER_IMPORTERS.map(lc);

// As regras de ARESTA (R1-R4), aplicadas igualmente ao grafo estático e ao de execução.
function edgeRules(fromRel, toRel) {
  const from = lc(fromRel);
  const to = lc(toRel);
  const rules = [];
  if (stripExtension(to) === ISSUER_MODULE && !ISSUER_IMPORTERS_LC.includes(from)) rules.push('R1');
  if (!insideSrc(to)) rules.push('R2');
  if (from.startsWith('src/research-prospector/') && to.startsWith('src/auth/')) rules.push('R3');
  if (from.startsWith('src/auth/') && to.startsWith('src/research-prospector/')) rules.push('R4');
  return rules;
}

// Linhas onde o CATÁLOGO PERMISSION é usado como valor — enumerado, espalhado ou repassado —
// em vez de apenas lido por membro (PERMISSION.READ_CRM), declarado (const PERMISSION = ...)
// ou exportado/importado por atalho ({ PERMISSION }).
//
// "O catálogo" é: o identificador solto PERMISSION, ou a propriedade PERMISSION de uma variável
// que guarda um módulo do projeto (const c = require('./constants'); c.PERMISSION) ou de um
// require(...) direto. Uma propriedade HOMÔNIMA de outro objeto — a chave PERMISSION do enum
// CONNECTIVITY_ERROR (a categoria de erro HTTP 403), por exemplo — não é o catálogo.
function catalogUses(tokens) {
  const lines = [];
  const isPunct = (token, value) => Boolean(token) && token.type === 'punct' && token.value === value;

  // list[closeIndex] é o ")" de um require(...)?
  const endsRequireCall = (list, closeIndex) => {
    let depth = 0;
    for (let m = closeIndex; m >= 0; m -= 1) {
      if (isPunct(list[m], ')')) depth += 1;
      else if (isPunct(list[m], '(')) {
        depth -= 1;
        if (depth === 0) return Boolean(list[m - 1]) && list[m - 1].type === 'id' && list[m - 1].value === 'require';
      }
    }
    return false;
  };

  walkTokenArrays(tokens, (list) => {
    const moduleVars = new Set(); // const x = require('./...')
    list.forEach((token, k) => {
      if (token.type !== 'id' || !['const', 'let', 'var'].includes(token.value)) return;
      const [name, equals, requireId, open, specifier] = list.slice(k + 1, k + 6);
      if (name && name.type === 'id' && isPunct(equals, '=') && requireId && requireId.type === 'id' && requireId.value === 'require' && isPunct(open, '(') && specifier && specifier.type === 'str' && specifier.value.startsWith('.')) {
        moduleVars.add(name.value);
      }
    });

    list.forEach((token, k) => {
      if (token.type !== 'id' || token.value !== 'PERMISSION') return;
      const previous = list[k - 1];
      const next = list[k + 1];
      if (isPunct(next, ':') && (isPunct(previous, '{') || isPunct(previous, ','))) return; // chave de objeto: { PERMISSION: ... }

      const spread = isPunct(previous, '.') && isPunct(list[k - 2], '.') && isPunct(list[k - 3], '.'); // ...PERMISSION
      if (isPunct(previous, '.') && !spread) {
        const holder = list[k - 2];
        const holdsModule = Boolean(holder) && holder.type === 'id' && moduleVars.has(holder.value);
        if (!holdsModule && !(isPunct(holder, ')') && endsRequireCall(list, k - 2))) return; // propriedade homônima de outro objeto
      }

      const memberAccess = isPunct(next, '.');
      const declaration = Boolean(previous) && previous.type === 'id' && ['const', 'let', 'var'].includes(previous.value) && isPunct(next, '=');
      const shorthand = (isPunct(previous, '{') || isPunct(previous, ',')) && (isPunct(next, ',') || isPunct(next, '}'));
      if (!memberAccess && !declaration && !shorthand) lines.push(token.line);
    });
  });
  return lines;
}

function loadModules(repoRoot) {
  return listSourceFiles(path.join(repoRoot, 'src')).map((file) => {
    const rel = toPosix(path.relative(repoRoot, file));
    const analysis = analyzeSource(fs.readFileSync(file, 'utf8'), rel);
    const refs = analysis.refs.map((ref) => ({ ...ref, resolution: resolveSpecifier(file, ref.specifier, repoRoot) }));
    return { rel, ...analysis, refs };
  });
}

function readDeclaredDependencies(repoRoot) {
  const file = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(file)) return new Set();
  return new Set(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).dependencies || {}));
}

// Avalia TODAS as regras estáticas sobre a árvore em `repoRoot` e devolve a lista de
// violações { rule, file, line, dependency, detail } (vazia = tudo em ordem).
function evaluateBoundaries(repoRoot) {
  const modules = loadModules(repoRoot);
  const declared = readDeclaredDependencies(repoRoot);
  const violations = [];
  const violate = (rule, mod, line, dependency, detail) => violations.push({ rule, file: mod.rel, line, dependency, detail });

  for (const mod of modules) {
    const from = lc(mod.rel);
    const mayTouchIssuer = ISSUER_IMPORTERS_LC.includes(from) || from === lc(ISSUER_FILE);

    for (const issue of mod.issues) violate('R6', mod, issue.line, issue.code, issue.detail);

    for (const ref of mod.refs) {
      const via = `${ref.kind}('${ref.specifier}')`;
      const resolution = ref.resolution;
      if (resolution.kind === 'relative') {
        for (const rule of edgeRules(mod.rel, resolution.targetRel)) violate(rule, mod, ref.line, resolution.targetRel, `${via}: ${EDGE_DETAIL[rule]}`);
      } else if (resolution.kind === 'absolute') {
        violate('R2', mod, ref.line, ref.specifier, `${via}: import por caminho absoluto (depende da máquina e escapa de src/)`);
      } else if (resolution.kind === 'subpath') {
        violate('R6', mod, ref.line, ref.specifier, `${via}: imports de subcaminho (#...) podem apontar para qualquer arquivo e escapam da análise`);
      } else if (resolution.kind === 'builtin') {
        if (LOADER_BUILTINS.has(resolution.name)) violate('R6', mod, ref.line, resolution.name, `${via}: módulo nativo que carrega ou executa código fora da análise estática`);
      } else if (resolution.kind === 'package') {
        if (!declared.has(resolution.name)) violate('R6', mod, ref.line, resolution.name, `${via}: pacote que não é dependência declarada em package.json`);
        if (resolution.name === SDK_PACKAGE && from !== lc(SDK_IMPORTER)) violate('R7', mod, ref.line, SDK_PACKAGE, `${via}: só ${SDK_IMPORTER} importa o SDK`);
      }
    }

    if (from === lc(SDK_IMPORTER)) {
      for (const ref of mod.refs) {
        if (ref.resolution.kind === 'relative') violate('R7', mod, ref.line, ref.resolution.targetRel, `${ref.kind}('${ref.specifier}'): o adapter não importa outros módulos de src/`);
      }
    }

    if (!mayTouchIssuer) {
      for (const text of mod.strings) {
        if (lc(text.value).includes('contextissuer')) violate('R1', mod, text.line, 'contextIssuer', 'texto literal menciona o emissor interno (um caminho montado em tempo de execução para importá-lo)');
      }
    }

    for (const line of catalogUses(mod.tokens)) violate('R8', mod, line, 'PERMISSION', 'PERMISSION usado como valor (enumeração, espalhamento ou repasse do catálogo)');
  }

  // R5 — ciclos (DFS com marcação de "em andamento").
  const byRel = new Map(modules.map((mod) => [lc(mod.rel), mod]));
  const edges = new Map(
    modules.map((mod) => [
      lc(mod.rel),
      [...new Set(mod.refs.filter((ref) => ref.resolution.kind === 'relative').map((ref) => lc(ref.resolution.targetRel)).filter((target) => byRel.has(target)))],
    ])
  );
  const state = new Map();
  const reported = new Set();
  const stack = [];
  function visit(node) {
    state.set(node, 'andamento');
    stack.push(node);
    for (const next of edges.get(node)) {
      if (state.get(next) === 'andamento') {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = [...new Set(cycle)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          violate('R5', byRel.get(next), null, cycle.map((n) => byRel.get(n).rel).join(' -> '), 'ciclo de importação');
        }
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'concluido');
  }
  for (const node of edges.keys()) {
    if (!state.has(node)) visit(node);
  }

  return violations.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));
}

function formatViolation(violation) {
  return `[${violation.rule}] ${violation.file}${violation.line ? `:${violation.line}` : ''} -> ${violation.dependency} — ${violation.detail}`;
}

function report(rule, violations) {
  return `Regra ${rule} violada: ${RULES[rule]}\n${violations.map(formatViolation).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Grafo de EXECUÇÃO: o que src/ realmente carrega, medido num processo filho novo.
// Limite: mede os require() do CommonJS (Module._load). Um import ESM (.mjs) não passa
// por ali — esse caso só é coberto pela análise estática (que lê import/export/import()).
// ---------------------------------------------------------------------------
const RUNTIME_PROBE = [
  "const Module = require('node:module');",
  "const fs = require('node:fs');",
  "const { files } = JSON.parse(fs.readFileSync(0, 'utf8'));",
  'const edges = [];',
  'const failures = [];',
  'const originalLoad = Module._load;',
  'Module._load = function (request, parent, isMain) {',
  '  let resolved = null;',
  '  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (erro) { resolved = null; }',
  '  if (parent && parent.filename && resolved) edges.push([parent.filename, resolved]);',
  '  return originalLoad.apply(this, arguments);',
  '};',
  'for (const file of files) { try { require(file); } catch (erro) { failures.push([file, String(erro && erro.message)]); } }',
  'Module._load = originalLoad;',
  'process.stdout.write(JSON.stringify({ edges, failures }));',
].join(' ');

function evaluateRuntimeGraph(repoRoot) {
  const modules = loadModules(repoRoot);
  const files = modules.map((mod) => path.join(repoRoot, mod.rel));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // o filho não é um teste: não herda o contexto do executor
  const child = spawnSync(process.execPath, ['-e', RUNTIME_PROBE], { input: JSON.stringify({ files }), encoding: 'utf8', cwd: repoRoot, timeout: 30000, env });
  if (child.error || child.status !== 0) {
    throw new Error(`falha ao coletar o grafo de execução: ${child.error ? child.error.message : child.stderr}`);
  }
  const { edges, failures } = JSON.parse(child.stdout);

  const staticEdges = new Set();
  for (const mod of modules) {
    for (const ref of mod.refs) if (ref.resolution.kind === 'relative') staticEdges.add(`${lc(mod.rel)} -> ${lc(ref.resolution.targetRel)}`);
  }

  const violations = [];
  const blindSpots = [];
  const seen = new Set();
  for (const [from, to] of edges) {
    if (!path.isAbsolute(to)) continue; // módulo nativo
    const fromRel = toPosix(path.relative(repoRoot, from));
    if (!insideSrc(fromRel)) continue; // require feito pelo próprio script de medição
    const toRel = toPosix(path.relative(repoRoot, to));
    if (toRel.startsWith('node_modules/')) continue;
    const key = `${fromRel} -> ${toRel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const rule of edgeRules(fromRel, toRel)) violations.push({ rule, file: fromRel, line: null, dependency: toRel, detail: `carregado em tempo de execução: ${EDGE_DETAIL[rule]}` });
    if (!staticEdges.has(lc(key))) blindSpots.push(key);
  }
  return { violations, blindSpots, failures: failures.map(([file, message]) => `${toPosix(path.relative(repoRoot, file))}: ${message}`) };
}

// ---------------------------------------------------------------------------
// Fixtures de árvore sintética (diretório temporário, apagado ao fim do teste)
// ---------------------------------------------------------------------------
const CLEAN_TREE = {
  'package.json': JSON.stringify({ name: 'arch-fixture', dependencies: { [SDK_PACKAGE]: '^2.0.0' } }),
  'src/auth/internal/contextIssuer.js': 'module.exports = {};\n',
  'src/auth/authorizationContext.js': "const issuer = require('./internal/contextIssuer');\nmodule.exports = { issuer };\n",
  'src/auth/userResolver.js': "const issuer = require('./internal/contextIssuer');\nmodule.exports = { issuer };\n",
  'src/auth/constants.js': "const PERMISSION = Object.freeze({ READ_CRM: 'READ:CRM' });\nconst lista = [PERMISSION.READ_CRM];\nmodule.exports = { PERMISSION, lista };\n",
  'src/auth/authAdapter.js': `const sdk = require('${SDK_PACKAGE}');\nmodule.exports = { sdk };\n`,
  'src/auth/index.js': "const { PERMISSION } = require('./constants');\nconst resolver = require('./userResolver');\nmodule.exports = { PERMISSION, resolver };\n",
  'src/research-prospector/normalize.js': 'module.exports = {};\n',
  'src/research-prospector/index.js': "const normalize = require('./normalize');\nmodule.exports = { normalize };\n",
  'tests/helpers/authFixtures.js': 'module.exports = {};\n',
};

function makeTree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries({ ...CLEAN_TREE, ...files })) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

// "regra@arquivo" únicos, ordenados — o que os auto-testes comparam.
const pairs = (violations) => [...new Set(violations.map((v) => `${v.rule}@${v.file}`))].sort();

// ---------------------------------------------------------------------------
// Memoização: a árvore real é analisada uma vez por processo de teste.
// ---------------------------------------------------------------------------
let realStatic;
const realViolations = () => (realStatic ||= evaluateBoundaries(REPO_ROOT));
const only = (rule) => realViolations().filter((violation) => violation.rule === rule);
let realRuntime;
const realRuntimeGraph = () => (realRuntime ||= evaluateRuntimeGraph(REPO_ROOT));

// ===========================================================================
// A árvore REAL de src/
// ===========================================================================
test('[ARCH-1] R1: somente userResolver.js e authorizationContext.js importam o emissor interno de AuthorizationContext', () => {
  const violations = only('R1');
  assert.equal(violations.length, 0, report('R1', violations));
});

test('[ARCH-2] R2: src/ não depende de tests/ (nem de tests/helpers/authFixtures.js, nem de nada fora de src/)', () => {
  const violations = only('R2');
  assert.equal(violations.length, 0, report('R2', violations));
});

test('[ARCH-3] R3: research-prospector não importa src/auth — a autorização entra por injeção', () => {
  const violations = only('R3');
  assert.equal(violations.length, 0, report('R3', violations));
});

test('[ARCH-4] R4: src/auth não importa research-prospector — AUTH != PROSPECTOR', () => {
  const violations = only('R4');
  assert.equal(violations.length, 0, report('R4', violations));
});

test('[ARCH-5] R5: src/ não tem dependências circulares', () => {
  const violations = only('R5');
  assert.equal(violations.length, 0, report('R5', violations));
});

test('[ARCH-6] R6: todo carregamento de módulo em src/ é estaticamente analisável (sem require dinâmico, alias, createRequire, eval, imports de subcaminho ou pacotes não declarados)', () => {
  const violations = only('R6');
  assert.equal(violations.length, 0, report('R6', violations));
});

test('[ARCH-7] R7: só authAdapter.js importa o SDK do Supabase, e o adapter não importa outros módulos de src/', () => {
  const violations = only('R7');
  assert.equal(violations.length, 0, report('R7', violations));
});

test('[ARCH-8] R8: o catálogo PERMISSION nunca é enumerado em src/ — nenhum Object.values(PERMISSION) concede permissões', () => {
  const violations = only('R8');
  assert.equal(violations.length, 0, report('R8', violations));
});

test('[ARCH-9] o grafo REAL de execução respeita as mesmas regras e não contém nenhuma aresta que a análise estática não tenha visto', () => {
  const { violations, blindSpots, failures } = realRuntimeGraph();
  assert.deepEqual(failures, [], `arquivos de src/ que não carregam em tempo de execução:\n${failures.join('\n')}`);
  assert.equal(violations.length, 0, `Violações no grafo de execução:\n${violations.map(formatViolation).join('\n')}`);
  assert.deepEqual(blindSpots, [], `Ponto cego da análise estática — arestas carregadas em execução que o scanner não viu:\n${blindSpots.join('\n')}`);
});

test('[ARCH-10] a análise não é vazia: enxerga os importadores reais do emissor (exatamente os permitidos) e cobre os dois pacotes de src/', () => {
  const modules = loadModules(REPO_ROOT);
  const importers = modules
    .filter((mod) => mod.refs.some((ref) => ref.resolution.kind === 'relative' && lc(stripExtension(ref.resolution.targetRel)) === ISSUER_MODULE))
    .map((mod) => mod.rel)
    .sort();
  assert.deepEqual(importers, [...ISSUER_IMPORTERS].sort(), 'os importadores do emissor vistos pelo scanner devem ser exatamente os permitidos por R1');

  const scanned = modules.map((mod) => mod.rel);
  for (const esperado of [ISSUER_FILE, 'src/auth/index.js', 'src/auth/approvalQueueBridge.js', 'src/research-prospector/index.js', 'src/research-prospector/approvalQueue.js']) {
    assert.ok(scanned.includes(esperado), `o scanner não cobriu ${esperado}`);
  }
  assert.ok(modules.every((mod) => mod.issues.length === 0), 'nenhum arquivo real de src/ tem carregamento não analisável');
});

// ===========================================================================
// Auto-testes do SCANNER: o que ele enxerga e o que ele ignora
// ===========================================================================
const raw = String.raw;
const ANALYZER_CASES = [
  // ---- enxerga
  ['require simples', "const a = require('./a');", ['require:./a'], []],
  ['aspas duplas e espaços', 'require ( "./b" )', ['require:./b'], []],
  ['template sem interpolação', 'require(`./c`)', ['require:./c'], []],
  ['argumento em várias linhas', "const x = require(\n  './d'\n);", ['require:./d'], []],
  ['encadeado e desestruturado', "const { y } = require('./e').z;", ['require:./e'], []],
  ['require dentro de ${} de um template', "const t = `texto ${require('./f')} fim`;", ['require:./f'], []],
  ['require em template aninhado', "const t = `a ${`b ${require('./g')}`} c`;", ['require:./g'], []],
  ['require.resolve', "require.resolve('./h')", ['require.resolve:./h'], []],
  ['import padrão', "import a from './i.js';", ['import:./i.js'], []],
  ['import nomeado em várias linhas', "import {\n  a as b,\n  c,\n} from './j.js';", ['import:./j.js'], []],
  ['import namespace', 'import * as ns from "./k.js"', ['import:./k.js'], []],
  ['import por efeito colateral', "import './l.js';", ['import:./l.js'], []],
  ['export ... from', "export * from './m.js';\nexport { a } from './n.js';", ['export-from:./m.js', 'export-from:./n.js'], []],
  ['import() com literal', "const m = await import('./o.js');", ['dynamic-import:./o.js'], []],
  ['vários requires na mesma linha', "const a = require('./p'), b = require('./q');", ['require:./p', 'require:./q'], []],
  // ---- ignora (não é código de carregamento)
  ['comentário de linha', "// require('./x')\nconst a = 1;", [], []],
  ['comentário de bloco', "/* require('./x')\n   import y from './z' */ const a = 1;", [], []],
  ['dentro de uma string', 'const s = "require(\'./x\')"; const t = \'import a from "./y"\';', [], []],
  ['texto fixo de um template', "const t = `require('./x') e import('./y')`;", [], []],
  ['regex com aspas e barras', raw`const r = /require\('\.\/x'\)/g; const s = "'"; const d = a / b / c;`, [], []],
  ['divisão e regex', 'const a = (b + c) / 2; const d = e / f; const g = /x/.test(h); i++ / 2;', [], []],
  ['propriedade require de outro objeto', "foo.require('./x'); this.import('./y'); bar?.require('./z');", [], []],
  // ---- não analisável (vira issue)
  ['require com concatenação', "require('./a' + 'b');", [], ['DYNAMIC_REQUIRE']],
  ['require com variável', 'require(nome);', [], ['DYNAMIC_REQUIRE']],
  ['require com template interpolado', 'require(`./a${b}`);', [], ['DYNAMIC_REQUIRE']],
  ['require.resolve calculado', 'require.resolve(nome);', [], ['DYNAMIC_REQUIRE']],
  ['alias de require', "const r = require; r('./x');", [], ['REQUIRE_ALIAS']],
  ['require passado como argumento', 'carregar(require);', [], ['REQUIRE_ALIAS']],
  ['require.cache', 'require.cache[chave];', [], ['REQUIRE_ALIAS']],
  ['import() calculado', 'import(nome);', [], ['DYNAMIC_IMPORT']],
  ['module.require', "module.require('./x');", [], ['MODULE_REQUIRE']],
  ['createRequire', 'const r = createRequire(url);', [], ['CREATE_REQUIRE']],
  ['eval', "eval('1 + 1');", [], ['EVAL']],
  ['new Function', "new Function('return 1');", [], ['FUNCTION_CONSTRUCTOR']],
  ['identificador com escape unicode', raw`\u0072equire('./x');`, [], ['ESCAPED_IDENTIFIER']],
  ['barra invertida no especificador', raw`require('..\x');`, [], ['ESCAPED_SPECIFIER']],
];

for (const [titulo, fonte, refsEsperadas, issuesEsperadas] of ANALYZER_CASES) {
  test(`[ARCH-S1] scanner: ${titulo}`, () => {
    const { refs, issues } = analyzeSource(fonte, titulo);
    assert.deepEqual(refs.map((ref) => `${ref.kind}:${ref.specifier}`).sort(), [...refsEsperadas].sort());
    assert.deepEqual(issues.map((issue) => issue.code).sort(), [...issuesEsperadas].sort());
  });
}

test('[ARCH-S2] scanner: falha fechada — um arquivo que não pode ser analisado lança um erro claro, nunca "passa em branco"', () => {
  const quebrados = [
    ['string sem fechamento', 'const a = "abc;\nconst b = 1;'],
    ['comentário de bloco sem fechamento', 'const a = 1; /* abc'],
    ['template sem fechamento', 'const t = `abc'],
    ['expressão de template sem fechamento', 'const t = `abc ${a'],
    ['regex sem fechamento', 'const r = /abc'],
  ];
  for (const [titulo, fonte] of quebrados) {
    assert.throws(() => analyzeSource(fonte, 'src/x.js'), /não foi possível analisar src\/x\.js.*falha fechada/, titulo);
  }
});

test('[ARCH-S3] scanner: reporta a linha de cada referência e resolve especificadores para o caminho relativo ao repositório', (t) => {
  const { refs } = analyzeSource("const a = 1;\n\nconst b = require('./b');\nimport c from './c.js';", 'x');
  assert.deepEqual(refs.map((ref) => [ref.specifier, ref.line]), [['./b', 3], ['./c.js', 4]]);

  const root = makeTree(t, {});
  const from = path.join(root, 'src', 'auth', 'index.js');
  const resolucoes = {
    './internal/contextIssuer': { kind: 'relative', targetRel: 'src/auth/internal/contextIssuer.js', onDisk: true },
    './internal/../internal/contextIssuer.js': { kind: 'relative', targetRel: 'src/auth/internal/contextIssuer.js', onDisk: true },
    '../../tests/helpers/authFixtures': { kind: 'relative', targetRel: 'tests/helpers/authFixtures.js', onDisk: true },
    './nao-existe': { kind: 'relative', targetRel: 'src/auth/nao-existe', onDisk: false },
    fs: { kind: 'builtin', name: 'fs' },
    'node:vm': { kind: 'builtin', name: 'vm' },
    '@supabase/supabase-js': { kind: 'package', name: '@supabase/supabase-js' },
    '@supabase/supabase-js/dist/x': { kind: 'package', name: '@supabase/supabase-js' },
    'left-pad': { kind: 'package', name: 'left-pad' },
    '#interno': { kind: 'subpath' },
    '/etc/passwd': { kind: 'absolute' },
    'file:///x.js': { kind: 'absolute' },
  };
  for (const [especificador, esperado] of Object.entries(resolucoes)) {
    assert.deepEqual(resolveSpecifier(from, especificador, root), esperado, especificador);
  }
});

// ===========================================================================
// Auto-testes das REGRAS: árvores sintéticas com uma violação de cada vez
// ===========================================================================
test('[ARCH-S4] a árvore sintética limpa não tem nenhuma violação (o motor não acusa o que é permitido)', (t) => {
  assert.deepEqual(evaluateBoundaries(makeTree(t, {})), []);
});

test('[ARCH-S5] R1: qualquer NOVO arquivo de src/ que importe o emissor é detectado, em qualquer sintaxe e de qualquer pasta', (t) => {
  const importarEmissor = [
    ['require simples', '.js', "require('./internal/contextIssuer');"],
    ['aspas duplas e extensão', '.js', 'require("./internal/contextIssuer.js");'],
    ['template literal', '.js', 'require(`./internal/contextIssuer`);'],
    ['argumento em várias linhas', '.js', "require(\n  './internal/contextIssuer'\n);"],
    ['caminho com ..', '.js', "require('./internal/../internal/contextIssuer');"],
    ['diferença de maiúsculas', '.js', "require('./Internal/ContextIssuer');"],
    ['desestruturado', '.js', "const { issueAuthorizationContext } = require('./internal/contextIssuer');"],
    ['dentro de uma função', '.js', "function lazy() { return require('./internal/contextIssuer'); }"],
    ['dentro de ${} de um template', '.js', "const x = `${require('./internal/contextIssuer')}`;"],
    ['require.resolve', '.js', "require.resolve('./internal/contextIssuer');"],
    ['import nomeado (.mjs)', '.mjs', "import { issueAuthorizationContext } from './internal/contextIssuer.js';"],
    ['import namespace (.mjs)', '.mjs', "import * as emissor from './internal/contextIssuer.js';"],
    ['import por efeito colateral (.mjs)', '.mjs', "import './internal/contextIssuer.js';"],
    ['export ... from (.mjs)', '.mjs', "export * from './internal/contextIssuer.js';"],
    ['import() dinâmico com literal (.mjs)', '.mjs', "const m = await import('./internal/contextIssuer.js');"],
    ['arquivo TypeScript (.ts)', '.ts', "import { issueAuthorizationContext } from './internal/contextIssuer';"],
  ];
  const arquivos = {};
  const esperado = [];
  importarEmissor.forEach(([, extensao, codigo], indice) => {
    const rel = `src/auth/novo${indice}${extensao}`;
    arquivos[rel] = `${codigo}\n`;
    esperado.push(`R1@${rel}`);
  });
  // de uma subpasta de auth e de outro pacote
  arquivos['src/auth/sub/fundo.js'] = "require('../internal/contextIssuer');\n";
  arquivos['src/research-prospector/intruso.js'] = "require('../auth/internal/contextIssuer');\n";
  esperado.push('R1@src/auth/sub/fundo.js', 'R1@src/research-prospector/intruso.js', 'R3@src/research-prospector/intruso.js');
  // A lista de permitidos é por CAMINHO COMPLETO, não pelo nome do arquivo: um userResolver.js
  // (ou authorizationContext.js) em outra pasta é um infrator como qualquer outro.
  arquivos['src/research-prospector/userResolver.js'] = "require('../auth/internal/contextIssuer');\n";
  arquivos['src/auth/sub/authorizationContext.js'] = "require('../internal/contextIssuer');\n";
  esperado.push('R1@src/research-prospector/userResolver.js', 'R3@src/research-prospector/userResolver.js', 'R1@src/auth/sub/authorizationContext.js');

  const violacoes = evaluateBoundaries(makeTree(t, arquivos));
  assert.deepEqual(pairs(violacoes), esperado.sort());

  // R1 tem DUAS detecções (a aresta resolvida e a menção textual ao nome do emissor). Cada arquivo
  // precisa ser acusado pela ARESTA — senão uma detecção esconderia a falha da outra (um userResolver.js
  // em outra pasta continuaria acusado pela menção mesmo que a lista de permitidos fosse por nome).
  const acusadosPorAresta = new Set(violacoes.filter((v) => v.rule === 'R1' && lc(stripExtension(v.dependency)) === ISSUER_MODULE).map((v) => v.file));
  for (const arquivo of Object.keys(arquivos)) {
    assert.ok(acusadosPorAresta.has(arquivo), `${arquivo}: o import do emissor deveria ser detectado como aresta, e não só por menção textual`);
  }

  // A mensagem diz arquivo, regra e dependência.
  const dele = violacoes.find((v) => v.rule === 'R1' && v.file === 'src/auth/novo0.js');
  const texto = formatViolation(dele);
  assert.match(texto, /^\[R1\] src\/auth\/novo0\.js:1 -> src\/auth\/internal\/contextIssuer\.js — /);
  assert.match(texto, /require\('\.\/internal\/contextIssuer'\)/);
  assert.match(report('R1', [dele]), /Somente src\/auth\/userResolver\.js e src\/auth\/authorizationContext\.js/);
});

test('[ARCH-S6] R1: os dois importadores permitidos e o próprio emissor NÃO são acusados', (t) => {
  const violacoes = evaluateBoundaries(makeTree(t, {}));
  assert.deepEqual(violacoes.filter((v) => v.rule === 'R1'), []);
});

test('[ARCH-S7] R1/R6: tentar esconder o caminho do emissor (concatenação, alias, eval) é detectado', (t) => {
  const violacoes = evaluateBoundaries(
    makeTree(t, {
      'src/auth/concatenado.js': "module.exports = require('./internal/' + 'contextIssuer');\n",
      'src/auth/apelido.js': "const carregar = require;\nmodule.exports = carregar('./internal/contextIssuer');\n",
      'src/auth/calculado.js': "const nome = './internal/contextIssuer';\nmodule.exports = require(nome);\n",
      'src/auth/avaliado.js': "module.exports = eval(\"require('./internal/contextIssuer')\");\n",
      'src/auth/emissorPorPartes.js': "const p = ['.', 'internal', 'contextIssuer'].join('/');\nmodule.exports = require(p);\n",
    })
  );
  const encontrados = pairs(violacoes);
  for (const arquivo of ['concatenado', 'apelido', 'calculado', 'avaliado', 'emissorPorPartes']) {
    assert.ok(encontrados.includes(`R6@src/auth/${arquivo}.js`), `${arquivo}.js deveria violar R6`);
  }
  assert.ok(encontrados.includes('R1@src/auth/concatenado.js'), "o texto literal 'contextIssuer' também é apontado");
  assert.ok(encontrados.includes('R1@src/auth/apelido.js'));
});

test('[ARCH-S8] R2: src/ importando tests/ (ou qualquer coisa fora de src/) é detectado, de qualquer pacote', (t) => {
  const violacoes = evaluateBoundaries(
    makeTree(t, {
      'src/auth/vazamento.js': "require('../../tests/helpers/authFixtures');\n",
      'src/research-prospector/vazamento.js': "const f = require('../../tests/helpers/authFixtures.js');\n",
      'src/auth/vazamentoEsm.mjs': "import fixtures from '../../tests/helpers/authFixtures.js';\n",
      'src/auth/fora.js': "require('../../package.json');\n",
      'src/auth/absoluto.js': "require('/etc/passwd');\n",
    })
  );
  assert.deepEqual(pairs(violacoes), [
    'R2@src/auth/absoluto.js',
    'R2@src/auth/fora.js',
    'R2@src/auth/vazamento.js',
    'R2@src/auth/vazamentoEsm.mjs',
    'R2@src/research-prospector/vazamento.js',
  ]);
  assert.match(formatViolation(violacoes.find((v) => v.file === 'src/auth/vazamento.js')), /-> tests\/helpers\/authFixtures\.js — .*src\/ não pode depender de tests\//);
});

test('[ARCH-S9] R3 e R4: nenhuma dependência entre research-prospector e auth, em nenhuma direção nem forma de importar', (t) => {
  const violacoes = evaluateBoundaries(
    makeTree(t, {
      'src/research-prospector/a.js': "require('../auth');\n",
      'src/research-prospector/b.js': "require('../auth/constants');\n",
      'src/research-prospector/c.js': "require('../auth/index.js');\n",
      'src/research-prospector/d.mjs': "import { defineUser } from '../auth/user.js';\n",
      'src/auth/e.js': "require('../research-prospector');\n",
      'src/auth/f.js': "require('../research-prospector/normalize');\n",
      'src/auth/g.mjs': "export * from '../research-prospector/normalize.js';\n",
    })
  );
  assert.deepEqual(pairs(violacoes), [
    'R3@src/research-prospector/a.js',
    'R3@src/research-prospector/b.js',
    'R3@src/research-prospector/c.js',
    'R3@src/research-prospector/d.mjs',
    'R4@src/auth/e.js',
    'R4@src/auth/f.js',
    'R4@src/auth/g.mjs',
  ]);
});

test('[ARCH-S10] R5: um ciclo de importação é detectado e descrito pelo caminho completo', (t) => {
  const violacoes = evaluateBoundaries(
    makeTree(t, {
      'src/auth/ciclo1.js': "require('./ciclo2');\n",
      'src/auth/ciclo2.js': "require('./ciclo3');\n",
      'src/auth/ciclo3.js': "require('./ciclo1');\n",
    })
  );
  const ciclos = violacoes.filter((v) => v.rule === 'R5');
  assert.equal(ciclos.length, 1);
  assert.match(ciclos[0].dependency, /src\/auth\/ciclo[123]\.js -> src\/auth\/ciclo[123]\.js -> src\/auth\/ciclo[123]\.js -> src\/auth\/ciclo[123]\.js/);
});

test('[ARCH-S11] R6: subcaminhos (#), pacotes não declarados, módulos nativos de carregamento e arquivo não analisável são detectados', (t) => {
  const violacoes = evaluateBoundaries(
    makeTree(t, {
      'src/auth/alias.js': "require('#emissor');\n",
      'src/auth/pacote.js': "require('left-pad');\n",
      'src/auth/nativo1.js': "require('node:vm');\n",
      'src/auth/nativo2.js': "require('module');\n",
      'src/auth/permitidos.js': "require('fs'); require('node:path');\n",
    })
  );
  const r6 = pairs(violacoes.filter((v) => v.rule === 'R6'));
  assert.deepEqual(r6, ['R6@src/auth/alias.js', 'R6@src/auth/nativo1.js', 'R6@src/auth/nativo2.js', 'R6@src/auth/pacote.js']);
  assert.deepEqual(violacoes.filter((v) => v.file === 'src/auth/permitidos.js'), [], 'módulos nativos comuns são permitidos (a dependência declarada é exercida pelo adapter da árvore limpa)');

  // Um arquivo que a análise não consegue ler faz a avaliação inteira falhar (nunca passa em branco).
  const quebrada = makeTree(t, { 'src/auth/quebrado.js': "const a = 'sem fechamento;\n" });
  assert.throws(() => evaluateBoundaries(quebrada), /não foi possível analisar src\/auth\/quebrado\.js/);
});

test('[ARCH-S12] R7: o SDK do Supabase fica só no adapter, e o adapter não importa outros módulos de src/', (t) => {
  const violacoes = evaluateBoundaries(
    makeTree(t, {
      'src/research-prospector/sdk.js': `require('${SDK_PACKAGE}');\n`,
      'src/auth/outroSdk.mjs': `import { createClient } from '${SDK_PACKAGE}';\n`,
      'src/auth/authAdapter.js': `const sdk = require('${SDK_PACKAGE}');\nconst c = require('./constants');\nmodule.exports = { sdk, c };\n`,
    })
  );
  assert.deepEqual(pairs(violacoes.filter((v) => v.rule === 'R7')), ['R7@src/auth/authAdapter.js', 'R7@src/auth/outroSdk.mjs', 'R7@src/research-prospector/sdk.js']);
});

test('[ARCH-S13] R8: enumerar, espalhar ou repassar o catálogo PERMISSION é detectado; os usos legítimos não', (t) => {
  const violacoes = evaluateBoundaries(
    makeTree(t, {
      'src/auth/concede1.js': "const { PERMISSION } = require('./constants');\nmodule.exports = Object.values(PERMISSION);\n",
      'src/auth/concede2.js': "const constants = require('./constants');\nmodule.exports = Object.keys(constants.PERMISSION);\n",
      'src/auth/concede3.js': "const { PERMISSION } = require('./constants');\nmodule.exports = [...Object.entries(PERMISSION)];\n",
      'src/auth/concede4.js': "const { PERMISSION } = require('./constants');\nfor (const nome in PERMISSION) { console.log(nome); }\n",
      'src/auth/concede5.js': "const { PERMISSION } = require('./constants');\nmodule.exports = { ...PERMISSION };\n",
      'src/auth/concede6.js': "const { PERMISSION } = require('./constants');\nmodule.exports = `${Object.values(PERMISSION)}`;\n",
      'src/auth/concede7.js': "const { PERMISSION } = require('./constants');\nmodule.exports = [PERMISSION];\n",
      'src/auth/concede8.js': "module.exports = Object.values(require('./constants').PERMISSION);\n",
      'src/auth/concede9.js': "const { PERMISSION } = require('./constants');\nmodule.exports = Object.assign({}, PERMISSION);\n",
      'src/auth/legitimo.js': [
        "const { PERMISSION } = require('./constants');",
        "const c = require('./constants');",
        'module.exports = { a: PERMISSION.READ_CRM, b: c.PERMISSION.READ_CRM, PERMISSION };',
        'const PERMISSION_FORMAT = /x/;',
        '',
      ].join('\n'),
      // Uma propriedade HOMÔNIMA de outro objeto (como a categoria PERMISSION de CONNECTIVITY_ERROR) não é o catálogo.
      'src/auth/homonimo.js': [
        "const CATEGORIA = Object.freeze({ PERMISSION: 'PERMISSION', AUTH: 'AUTH' });",
        'const escolhida = CATEGORIA.PERMISSION;',
        'module.exports = { escolhida, todas: Object.values(CATEGORIA) };',
        '',
      ].join('\n'),
    })
  );
  const r8 = pairs(violacoes.filter((v) => v.rule === 'R8'));
  assert.deepEqual(r8, [
    'R8@src/auth/concede1.js',
    'R8@src/auth/concede2.js',
    'R8@src/auth/concede3.js',
    'R8@src/auth/concede4.js',
    'R8@src/auth/concede5.js',
    'R8@src/auth/concede6.js',
    'R8@src/auth/concede7.js',
    'R8@src/auth/concede8.js',
    'R8@src/auth/concede9.js',
  ]);
  for (const inocente of ['legitimo', 'homonimo']) {
    assert.deepEqual(violacoes.filter((v) => v.file === `src/auth/${inocente}.js`), [], `${inocente}.js usa PERMISSION de forma legítima`);
  }
});

test('[ARCH-S14] comentários, strings e regex que parecem imports não geram violação', (t) => {
  const violacoes = evaluateBoundaries(
    makeTree(t, {
      'src/research-prospector/inofensivo.js': [
        "// const a = require('../auth');",
        "/* require('../../tests/helpers/authFixtures'); */",
        'const texto = "require(\'../auth\') e import x from \'../auth/user.js\'";',
        "const modelo = `usa require('../auth') só como texto`;",
        "const padrao = /require\\('\\.\\.\\/auth'\\)/;",
        'module.exports = { texto, modelo, padrao };',
        '',
      ].join('\n'),
    })
  );
  assert.deepEqual(violacoes, []);
});

// ===========================================================================
// Auto-testes do grafo de EXECUÇÃO: ele pega o que a análise estática não pega
// ===========================================================================
// O adapter da árvore limpa requer o SDK real, que não existe num diretório temporário: nos testes
// de EXECUÇÃO ele é trocado por um módulo vazio (a análise estática o vê como qualquer outro).
const SEM_SDK = { 'src/auth/authAdapter.js': 'module.exports = {};\n' };

test('[ARCH-S15] o grafo de execução acusa um desvio dinâmico do emissor e o aponta como ponto cego da análise estática', (t) => {
  const raiz = makeTree(t, {
    ...SEM_SDK,
    'src/auth/desvio.js': "const nome = './internal/' + 'contextIssuer';\nmodule.exports = require(nome);\n",
  });
  const { violations, blindSpots, failures } = evaluateRuntimeGraph(raiz);
  assert.deepEqual(failures, []);
  assert.deepEqual(pairs(violations), ['R1@src/auth/desvio.js']);
  assert.deepEqual(blindSpots, ['src/auth/desvio.js -> src/auth/internal/contextIssuer.js']);
  assert.match(formatViolation(violations[0]), /carregado em tempo de execução/);
});

test('[ARCH-S16] o grafo de execução da árvore sintética limpa não tem violação, ponto cego nem arquivo que falhe ao carregar', (t) => {
  const { violations, blindSpots, failures } = evaluateRuntimeGraph(makeTree(t, SEM_SDK));
  assert.deepEqual({ violations, blindSpots, failures }, { violations: [], blindSpots: [], failures: [] });
});
