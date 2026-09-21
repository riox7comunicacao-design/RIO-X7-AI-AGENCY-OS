'use strict';

// Análise ESTÁTICA de imports para os testes de arquitetura (Fase F).
//
// Sem dependências externas: um tokenizador pequeno de JavaScript que separa
// comentários, strings, templates e regex do CÓDIGO, para que um `require('...')`
// só conte quando é código — nunca quando aparece num comentário, numa string ou
// no texto de um template. É deliberadamente conservador:
//  - FALHA FECHADA: se um arquivo não puder ser analisado (string, template,
//    regex ou comentário sem fechamento), lança um erro claro em vez de "achar que
//    está tudo bem";
//  - tudo o que NÃO dá para resolver estaticamente (require com argumento
//    calculado, `require` usado como valor, import() dinâmico, createRequire,
//    module.require, eval, new Function, identificador com escape unicode) vira
//    um "issue" — quem aplica as regras decide que isso é uma violação, porque um
//    carregamento que a análise não enxerga também escapa das fronteiras.
//
// USO SOMENTE EM TESTES: src/ nunca importa este arquivo (a própria regra R2 dos
// testes de arquitetura vigia isso). Não é um parser completo: é suficiente para o
// código deste projeto e para os fixtures de auto-teste em
// tests/auth/architecture-boundaries.test.js, que provam o que ele enxerga e o que
// ele ignora.

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

// Extensões tratadas como código-fonte. Node 24 executa .ts diretamente (remoção de
// tipos), então um .ts em src/ também pode ser importado — não pode ficar de fora.
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx']);
const RESOLVE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.node', '.ts', '.cts', '.mts'];

// Depois destas palavras, um `/` começa uma regex (e não uma divisão).
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const toPosix = (p) => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Tokenizador
// ---------------------------------------------------------------------------
const isDigit = (ch) => ch >= '0' && ch <= '9';
const isIdentStart = (ch) => /[A-Za-z_$]/.test(ch) || ch.charCodeAt(0) > 127;
const isIdentPart = (ch) => /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
const WHITESPACE = new Set([' ', '\t', '\r', '\f', '\v', ' ', '﻿', ' ', ' ']);

// Tipos de token: 'id', 'punct', 'str' ({ value, hasEscape }), 'tpl' ({ value: texto
// fixo, hasExpr, exprs: [tokens de cada ${...}] }), 'regex', 'num'.
function tokenize(source, label = '<memória>') {
  const n = source.length;
  let i = 0;
  let line = 1;

  function fail(message) {
    throw new Error(`não foi possível analisar ${label}: ${message} (linha ${line}) — falha fechada, o arquivo precisa ser analisável`);
  }

  function readString(quote) {
    const startLine = line;
    let j = i + 1;
    let hasEscape = false;
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        hasEscape = true;
        if (source[j + 1] === '\n') line += 1;
        j += 2;
        continue;
      }
      if (c === quote) {
        const token = { type: 'str', value: source.slice(i + 1, j), hasEscape, line: startLine };
        i = j + 1;
        return token;
      }
      if (c === '\n') fail('string sem fechamento (quebra de linha antes do fim)');
      j += 1;
    }
    return fail('string sem fechamento');
  }

  function readRegex() {
    const startLine = line;
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') fail('regex sem fechamento');
      if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') {
        inClass = true;
      } else if (c === '/') {
        j += 1;
        while (j < n && /[A-Za-z]/.test(source[j])) j += 1; // flags
        i = j;
        return { type: 'regex', line: startLine };
      }
      j += 1;
    }
    return fail('regex sem fechamento');
  }

  function regexAllowed(out) {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.type === 'num' || prev.type === 'str' || prev.type === 'tpl' || prev.type === 'regex') return false;
    if (prev.type === 'id') return KEYWORDS_BEFORE_REGEX.has(prev.value);
    // punctuator: depois de ) ] } assume divisão; depois de ++ / -- pós-fixo também.
    if (prev.value === ')' || prev.value === ']' || prev.value === '}') return false;
    if ((prev.value === '+' || prev.value === '-') && out.length >= 3) {
      const prev2 = out[out.length - 2];
      const prev3 = out[out.length - 3];
      if (prev2.type === 'punct' && prev2.value === prev.value) {
        const operandEnd = prev3.type === 'id' ? !KEYWORDS_BEFORE_REGEX.has(prev3.value) : prev3.type === 'punct' && (prev3.value === ')' || prev3.value === ']');
        if (operandEnd) return false;
      }
    }
    return true;
  }

  // Lê tokens até o fim do arquivo ou, dentro de um ${...}, até a chave sem par.
  function scan(insideTemplateExpr) {
    const out = [];
    let depth = 0;
    while (i < n) {
      const ch = source[i];
      const next = source[i + 1];

      if (ch === '\n') { line += 1; i += 1; continue; }
      if (WHITESPACE.has(ch)) { i += 1; continue; }

      if (ch === '/' && next === '/') {
        while (i < n && source[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        if (end === -1) fail('comentário /* sem fechamento');
        for (let j = i; j < end; j += 1) if (source[j] === '\n') line += 1;
        i = end + 2;
        continue;
      }
      if (ch === '#' && next === '!' && i === 0) {
        while (i < n && source[i] !== '\n') i += 1;
        continue;
      }

      if (ch === '"' || ch === "'") { out.push(readString(ch)); continue; }
      if (ch === '`') { out.push(readTemplate()); continue; }

      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < n && isIdentPart(source[j])) j += 1;
        out.push({ type: 'id', value: source.slice(i, j), line });
        i = j;
        continue;
      }

      if (isDigit(ch) || (ch === '.' && next !== undefined && isDigit(next))) {
        let j = i + 1;
        while (j < n) {
          const c = source[j];
          const previous = source[j - 1];
          if (/[0-9A-Za-z_.]/.test(c) || ((c === '+' || c === '-') && /[eE]/.test(previous) && !/^0[xX]/.test(source.slice(i, j)))) j += 1;
          else break;
        }
        out.push({ type: 'num', line });
        i = j;
        continue;
      }

      if (ch === '/') {
        if (regexAllowed(out)) out.push(readRegex());
        else { out.push({ type: 'punct', value: '/', line }); i += 1; }
        continue;
      }

      if (ch === '{') { depth += 1; out.push({ type: 'punct', value: '{', line }); i += 1; continue; }
      if (ch === '}') {
        if (insideTemplateExpr && depth === 0) { i += 1; return out; }
        depth -= 1;
        out.push({ type: 'punct', value: '}', line });
        i += 1;
        continue;
      }

      out.push({ type: 'punct', value: ch, line });
      i += 1;
    }
    if (insideTemplateExpr) fail('expressão ${ ... } de template sem fechamento');
    return out;
  }

  function readTemplate() {
    const startLine = line;
    let j = i + 1;
    let text = '';
    const exprs = [];
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        text += source.slice(j, j + 2);
        if (source[j + 1] === '\n') line += 1;
        j += 2;
        continue;
      }
      if (c === '`') {
        i = j + 1;
        return { type: 'tpl', value: text, hasExpr: exprs.length > 0, exprs, line: startLine };
      }
      if (c === '$' && source[j + 1] === '{') {
        i = j + 2;
        exprs.push(scan(true)); // consome até a '}' correspondente
        j = i;
        continue;
      }
      if (c === '\n') line += 1;
      text += c;
      j += 1;
    }
    return fail('template literal sem fechamento');
  }

  return scan(false);
}

// Percorre um array de tokens e, recursivamente, os das expressões ${...} de templates.
function walkTokenArrays(tokens, callback) {
  callback(tokens);
  for (const token of tokens) {
    if (token.type === 'tpl') for (const expr of token.exprs) walkTokenArrays(expr, callback);
  }
}

// ---------------------------------------------------------------------------
// Extração de referências a módulos
// ---------------------------------------------------------------------------
const isPunct = (token, value) => Boolean(token) && token.type === 'punct' && token.value === value;
const isId = (token, value) => Boolean(token) && token.type === 'id' && (value === undefined || token.value === value);
const isLiteralSpecifier = (token) => Boolean(token) && (token.type === 'str' || (token.type === 'tpl' && !token.hasExpr));

// Devolve { refs, issues, strings, tokens }:
//  - refs:    { kind, specifier, line } — cada módulo carregado com especificador literal;
//  - issues:  { code, line, detail } — carregamento que NÃO dá para resolver estaticamente;
//  - strings: { value, line } — todo texto literal (strings e texto fixo de templates);
//  - tokens:  a lista de tokens (para regras baseadas em padrão de tokens).
function analyzeSource(source, label = '<memória>') {
  const tokens = tokenize(source, label);
  const refs = [];
  const issues = [];
  const strings = [];

  function addRef(kind, token) {
    if (token.type === 'str' && token.hasEscape) {
      issues.push({ code: 'ESCAPED_SPECIFIER', line: token.line, detail: `${kind} com barra invertida no especificador (use "/" e nenhuma sequência de escape)` });
      return;
    }
    refs.push({ kind, specifier: token.value, line: token.line });
  }

  function visit(list) {
    for (let k = 0; k < list.length; k += 1) {
      const token = list[k];

      if (token.type === 'str') strings.push({ value: token.value, line: token.line });
      if (token.type === 'tpl') strings.push({ value: token.value, line: token.line });

      if (isPunct(token, '\\')) {
        issues.push({ code: 'ESCAPED_IDENTIFIER', line: token.line, detail: 'barra invertida fora de string/template/regex (identificador com escape unicode pode esconder um require)' });
        continue;
      }
      if (token.type !== 'id') continue;

      const previous = list[k - 1];
      const a = list[k + 1];
      const b = list[k + 2];
      const c = list[k + 3];
      const memberAccess = isPunct(previous, '.');

      if (token.value === 'require' && memberAccess) {
        if (isId(list[k - 2], 'module')) issues.push({ code: 'MODULE_REQUIRE', line: token.line, detail: 'module.require(...) carrega módulos fora da análise estática' });
        continue; // outro objeto qualquer com uma propriedade chamada require: não é o require do CommonJS
      }

      if (token.value === 'require') {
        if (isPunct(a, '(')) {
          if (isLiteralSpecifier(b) && isPunct(c, ')')) addRef('require', b);
          else issues.push({ code: 'DYNAMIC_REQUIRE', line: token.line, detail: 'require(...) com argumento que não é um único literal' });
        } else if (isPunct(a, '.') && isId(b, 'resolve') && isPunct(c, '(')) {
          const d = list[k + 4];
          const e = list[k + 5];
          if (isLiteralSpecifier(d) && isPunct(e, ')')) addRef('require.resolve', d);
          else issues.push({ code: 'DYNAMIC_REQUIRE', line: token.line, detail: 'require.resolve(...) com argumento que não é um único literal' });
        } else {
          issues.push({ code: 'REQUIRE_ALIAS', line: token.line, detail: '`require` usado como valor (alias, argumento ou propriedade): esconde carregamentos da análise' });
        }
        continue;
      }

      if (token.value === 'createRequire') {
        issues.push({ code: 'CREATE_REQUIRE', line: token.line, detail: 'createRequire(...) cria um require fora da análise estática' });
        continue;
      }
      if (token.value === 'eval' && !memberAccess) {
        issues.push({ code: 'EVAL', line: token.line, detail: 'eval(...) executa código fora da análise estática' });
        continue;
      }
      if (token.value === 'Function' && !memberAccess && (isPunct(a, '(') || isId(previous, 'new'))) {
        issues.push({ code: 'FUNCTION_CONSTRUCTOR', line: token.line, detail: 'new Function(...) executa código fora da análise estática' });
        continue;
      }

      if (token.value === 'import' && !memberAccess) {
        if (isPunct(a, '(')) {
          if (isLiteralSpecifier(b) && (isPunct(c, ')') || isPunct(c, ','))) addRef('dynamic-import', b);
          else issues.push({ code: 'DYNAMIC_IMPORT', line: token.line, detail: 'import(...) com argumento que não é um literal' });
        } else if (a && a.type === 'str') {
          addRef('import', a);
        } else if (!isPunct(a, '.')) {
          scanForFrom(list, k, 'import');
        }
        continue;
      }
      if (token.value === 'export' && !memberAccess) scanForFrom(list, k, 'export-from');
    }

    for (const token of list) {
      if (token.type === 'tpl') for (const expr of token.exprs) visit(expr);
    }
  }

  // `import x from 'm'`, `import {a} from 'm'`, `export * from 'm'`, `export {a} from 'm'`.
  function scanForFrom(list, from, kind) {
    for (let m = from + 1; m < list.length && m < from + 400; m += 1) {
      const t = list[m];
      if (isPunct(t, ';')) return;
      if (t.type === 'id' && (t.value === 'import' || t.value === 'export')) return;
      if (isId(t, 'from') && list[m + 1] && list[m + 1].type === 'str') {
        addRef(kind === 'import' ? 'import' : 'export-from', list[m + 1]);
        return;
      }
    }
  }

  visit(tokens);
  return { refs, issues, strings, tokens };
}

// ---------------------------------------------------------------------------
// Arquivos e resolução de especificadores
// ---------------------------------------------------------------------------
// Todos os arquivos de código sob `rootDir`, ignorando node_modules e .git. Um
// symlink dentro de src/ é recusado: a resolução lexical ("está dentro de src/")
// deixaria de valer para um alvo real fora dele.
function listSourceFiles(rootDir) {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symlink não permitido em ${toPosix(path.relative(rootDir, full)) || entry.name}: a análise de fronteiras assume uma árvore simples`);
      }
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  })(rootDir);
  return found.sort();
}

function isBuiltinModule(specifier) {
  return specifier.startsWith('node:') || builtinModules.includes(specifier);
}

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveOnDisk(base) {
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((extension) => base + extension),
    ...RESOLVE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // não existe: tenta o próximo candidato
    }
  }
  return null;
}

// Classifica um especificador visto em `fromFile`:
//   { kind: 'relative', targetRel, onDisk }  targetRel é relativo a repoRoot, com "/" ;
//   { kind: 'absolute' | 'subpath' | 'builtin' | 'package', ... }.
// Para um alvo relativo que não existe no disco, usa o caminho LEXICAL (é o que a
// regra precisa comparar: um import quebrado ainda revela a intenção).
function resolveSpecifier(fromFile, specifier, repoRoot) {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
    const base = path.resolve(path.dirname(fromFile), specifier);
    const real = resolveOnDisk(base);
    return { kind: 'relative', targetRel: toPosix(path.relative(repoRoot, real || base)), onDisk: real !== null };
  }
  if (specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith('file:')) return { kind: 'absolute' };
  if (specifier.startsWith('#')) return { kind: 'subpath' };
  if (isBuiltinModule(specifier)) return { kind: 'builtin', name: specifier.replace(/^node:/, '') };
  return { kind: 'package', name: packageNameOf(specifier) };
}

module.exports = {
  SOURCE_EXTENSIONS,
  tokenize,
  walkTokenArrays,
  analyzeSource,
  listSourceFiles,
  resolveSpecifier,
  toPosix,
};
