// A PALETA DE 20 CORES dos nichos no Dashboard (dashboard/styles.css — CRM 5.0, Fase 2B-1): as classes `.cor-<chave>` e o chip `.nicho-chip` são
// IDÊNTICOS à paleta do servidor (src/crm/catalogConstants.js#NICHE_COLORS), o contraste é recalculado a partir do que está no CSS, e a regra
// de segurança segue valendo: cores só por classe de CSS (CSP style-src 'self'; DASH-GUARD-8), nunca estilo inline nem hex no JavaScript.
// Ainda NÃO há tela que use estas classes (Fase 2B-2): o teste garante que o contrato entre o backend (guarda só a CHAVE) e a interface já
// está fechado, sem acoplar um ao outro — o Dashboard nunca importa nada de src/ (R11).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { NICHE_COLORS, NICHE_COLOR_KEYS } = require('../../src/crm/catalogConstants');
const { analyzeSource, listSourceFiles, toPosix } = require('../helpers/staticImports');
const { DASHBOARD_ROOT } = require('./testEnv');

const CSS = fs.readFileSync(path.join(DASHBOARD_ROOT, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const CSS_SEM_COMENTARIOS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const REGRAS = [...CSS_SEM_COMENTARIOS.matchAll(/^\.cor-([a-z]+) \{ --cor-fundo: (#[0-9a-f]{6}); --cor-texto: (#[0-9a-f]{6}); --cor-ponto: (#[0-9a-f]{6}); \}$/gm)].map((m) => ({ chave: m[1], fundo: m[2], texto: m[3], ponto: m[4] }));

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [claro, escuro] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (claro + 0.05) / (escuro + 0.05);
};

test('[CATCOLOR-1] o CSS tem EXATAMENTE as 20 classes .cor-<chave>, na ordem da paleta do servidor, com os MESMOS três tons — e nenhuma classe a mais', () => {
  assert.equal(REGRAS.length, 20);
  assert.deepEqual(REGRAS.map((regra) => regra.chave), [...NICHE_COLOR_KEYS]);
  for (const [i, cor] of NICHE_COLORS.entries()) {
    assert.deepEqual(REGRAS[i], { chave: cor.chave, fundo: cor.fundo, texto: cor.texto, ponto: cor.ponto }, cor.chave);
  }
  // nenhuma OUTRA definição de variável de cor de nicho, nem outra classe .cor-* fora das 20
  assert.equal((CSS_SEM_COMENTARIOS.match(/--cor-fundo:/g) || []).length, 21, '20 classes + o padrão neutro do chip');
  assert.equal((CSS_SEM_COMENTARIOS.match(/^\.cor-[a-z-]+/gm) || []).length, 20);
  for (const chave of NICHE_COLOR_KEYS) assert.equal((CSS_SEM_COMENTARIOS.match(new RegExp(`^\\.cor-${chave} `, 'gm')) || []).length, 1, `${chave}: uma única regra`);
});

test('[CATCOLOR-2] o CONTRASTE recalculado A PARTIR DO CSS: texto sobre o fundo >= 7:1 e o ponto >= 3:1 sobre o fundo e sobre o branco — o que a interface mostra, não só o que o backend declara', () => {
  for (const regra of REGRAS) {
    assert.ok(contrast(regra.texto, regra.fundo) >= 7, `${regra.chave}: texto×fundo ${contrast(regra.texto, regra.fundo).toFixed(2)}`);
    assert.ok(contrast(regra.ponto, regra.fundo) >= 3, `${regra.chave}: ponto×fundo ${contrast(regra.ponto, regra.fundo).toFixed(2)}`);
    assert.ok(contrast(regra.ponto, '#ffffff') >= 3, `${regra.chave}: ponto×branco`);
  }
});

test('[CATCOLOR-3] o CHIP: o padrão neutro é a cor "ardosia" (uma chave desconhecida ou a ausência de classe nunca fica sem cor legível); o texto e o fundo usam as variáveis; o ponto é um círculo com a cor de destaque; o NOME vai em texto', () => {
  const ardosia = NICHE_COLORS.find((cor) => cor.chave === 'ardosia');
  const chip = /^\.nicho-chip \{ ([^}]*) \}$/m.exec(CSS_SEM_COMENTARIOS);
  assert.ok(chip, 'existe a regra .nicho-chip');
  assert.match(chip[1], new RegExp(`--cor-fundo: ${ardosia.fundo}; --cor-texto: ${ardosia.texto}; --cor-ponto: ${ardosia.ponto};`), 'o padrão é o neutro');
  assert.match(chip[1], /background: var\(--cor-fundo\)/);
  assert.match(chip[1], /color: var\(--cor-texto\)/);
  assert.match(chip[1], /border-radius: 999px/);
  const ponto = /^\.nicho-chip::before \{ ([^}]*) \}$/m.exec(CSS_SEM_COMENTARIOS);
  assert.ok(ponto, 'existe o ponto');
  assert.match(ponto[1], /background: var\(--cor-ponto\)/);
  assert.match(ponto[1], /border-radius: 50%/);
  assert.match(ponto[1], /content: ""/, 'o ponto é decorativo: não acrescenta texto lido por leitor de tela');
  assert.doesNotMatch(ponto[1], /content: attr|content: "[^"]+"/, 'nenhum texto gerado por CSS carrega informação');
});

test('[CATCOLOR-4] CSP e DASH-GUARD-8: as cores vivem SÓ no CSS — nenhum .mjs do Dashboard tem cor em hex/rgb/hsl, nenhum usa `.style` ou o atributo style, e o CSS não carrega nada de fora (sem url(), @import ou origem externa)', () => {
  for (const arquivo of listSourceFiles(DASHBOARD_ROOT).filter((f) => f.endsWith('.mjs'))) {
    const nome = toPosix(path.relative(DASHBOARD_ROOT, arquivo));
    const codigo = fs.readFileSync(arquivo, 'utf8');
    assert.doesNotMatch(codigo.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{6}\b|\brgba?\(|\bhsla?\(/, `${nome}: nenhuma cor no JavaScript`);
    const analise = analyzeSource(codigo, nome);
    for (const { value } of analise.strings) assert.doesNotMatch(value, /\sstyle\s*=/i, `${nome}: atributo style em texto`);
  }
  assert.doesNotMatch(CSS, /url\(|@import|https?:\/\//i);
  assert.doesNotMatch(CSS_SEM_COMENTARIOS, /!important[^;}]*--cor-/);
});

test('[CATCOLOR-5] ACOPLAMENTO: o Dashboard não importa nada de src/ (R11) nem repete a lista de chaves da paleta no JavaScript; o servidor guarda só a CHAVE e o CSS resolve a cor — a ligação entre os dois é este teste', () => {
  for (const arquivo of listSourceFiles(DASHBOARD_ROOT).filter((f) => f.endsWith('.mjs'))) {
    const nome = toPosix(path.relative(DASHBOARD_ROOT, arquivo));
    const analise = analyzeSource(fs.readFileSync(arquivo, 'utf8'), nome);
    for (const ref of analise.refs) assert.doesNotMatch(ref.specifier, /(^|\/)src\//, `${nome} não pode importar de src/`);
    const textos = analise.strings.map((s) => s.value);
    const chavesNoJs = NICHE_COLOR_KEYS.filter((chave) => textos.includes(chave));
    assert.ok(chavesNoJs.length < 5, `${nome}: não deve repetir a paleta (achei ${chavesNoJs.join(', ')})`);
  }
  assert.ok(NICHE_COLOR_KEYS.every((chave) => /^[a-z]+$/.test(chave)), 'toda chave é um nome de classe válido, sem espaços nem acentos');
});
