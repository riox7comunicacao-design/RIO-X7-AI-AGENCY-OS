// O SELETOR das 20 cores dos nichos no Dashboard (CRM 5.0, Fase 2B-2): dashboard/catalog-colors.mjs (as opções) e dashboard/ui/colorPicker.mjs (o grupo de opções acessível).
// As opções são conferidas contra a paleta do SERVIDOR (chave, nome e ordem) e contra as classes de CSS; o seletor é testado no DOM de teste (teclado, estados, ausência de estilo inline).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { NICHE_COLORS } = require('../../src/crm/catalogConstants');
const { createBrowser } = require('../helpers/fakeDom');

const DASHBOARD = path.join(__dirname, '..', '..', 'dashboard');
const CSS = fs.readFileSync(path.join(DASHBOARD, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');

const loadColors = () => import('../../dashboard/catalog-colors.mjs');
const loadPicker = () => import('../../dashboard/ui/colorPicker.mjs');

test('[CATUI-1] AS 20 OPÇÕES: exatamente 20, na ordem e com os nomes do servidor, cada uma com a sua classe escrita por extenso e existente no CSS', async () => {
  const { NICHE_COLOR_OPTIONS, NICHE_COLOR_KEYS } = await loadColors();
  assert.equal(NICHE_COLOR_OPTIONS.length, 20);
  assert.equal(NICHE_COLORS.length, 20);
  assert.deepEqual(NICHE_COLOR_OPTIONS.map((o) => [o.chave, o.nome]), NICHE_COLORS.map((c) => [c.chave, c.nome]), 'mesma chave, mesmo nome, mesma ordem do servidor');
  assert.deepEqual([...NICHE_COLOR_KEYS], NICHE_COLORS.map((c) => c.chave));
  assert.equal(new Set(NICHE_COLOR_OPTIONS.map((o) => o.chave)).size, 20, 'sem repetição');
  assert.equal(new Set(NICHE_COLOR_OPTIONS.map((o) => o.nome)).size, 20, 'nomes diferentes: a cor nunca é a única informação');
  for (const o of NICHE_COLOR_OPTIONS) {
    assert.equal(o.className, `cor-${o.chave}`);
    assert.match(CSS, new RegExp(`^\\.cor-${o.chave} \\{ --cor-fundo: #[0-9a-f]{6}; --cor-texto: #[0-9a-f]{6}; --cor-ponto: #[0-9a-f]{6}; \\}$`, 'm'), `${o.chave} existe no CSS`);
  }
  assert.ok(Object.isFrozen(NICHE_COLOR_OPTIONS) && NICHE_COLOR_OPTIONS.every((o) => Object.isFrozen(o)), 'a paleta não pode ser alterada em execução');
});

test('[CATUI-2] SÓ A CHAVE aprovada vale: uma chave desconhecida, vazia ou de outro tipo não tem opção, classe nem nome; o módulo não tem valor de cor nem estilo', async () => {
  const c = await loadColors();
  assert.equal(c.colorOption('azul').nome, 'Azul');
  assert.equal(c.colorClassOf('indigo'), 'cor-indigo');
  assert.equal(c.colorNameOf('ambar'), 'Âmbar');
  for (const ruim of ['', 'AZUL', 'azul ', '#125bd9', 'rgb(0,0,0)', 'cor-azul', '__proto__', 'constructor', 'toString', null, undefined, 5, {}, ['azul']]) {
    assert.equal(c.colorOption(ruim), null, String(ruim));
    assert.equal(c.colorClassOf(ruim), '', String(ruim));
    assert.equal(c.colorNameOf(ruim), '', String(ruim));
  }
  const fonte = fs.readFileSync(path.join(DASHBOARD, 'catalog-colors.mjs'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(fonte, /#[0-9a-fA-F]{3,8}\b/, 'nenhum valor de cor no JavaScript');
  assert.doesNotMatch(fonte, /\.style\b|setAttribute\(\s*['"]style|rgb\(|hsl\(/);
  assert.doesNotMatch(fonte, /`[^`]*cor-/, 'nenhuma classe de cor montada por concatenação');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o seletor
// ---------------------------------------------------------------------------------------------------------------------------------------------

async function montar(opcoes = {}) {
  const { colorPicker } = await loadPicker();
  const { NICHE_COLOR_OPTIONS } = await loadColors();
  const browser = createBrowser();
  const escolhas = [];
  const picker = colorPicker(browser.document, { id: 'cor-teste', label: 'Cor do nicho', options: NICHE_COLOR_OPTIONS, required: true, help: 'Escolha uma cor.', onChange: (chave) => escolhas.push(chave), ...opcoes });
  browser.root.append(picker.element);
  browser.document.body.append(browser.root);
  const opcoesDom = () => browser.findAll(picker.element, (el) => el.getAttribute('role') === 'radio');
  return { browser, picker, escolhas, opcoesDom };
}

test('[CATUI-3] O SELETOR mostra EXATAMENTE 20 opções num grupo acessível: cada uma com amostra, nome em texto e a classe da cor; nada marcado ao começar', async () => {
  const { picker, opcoesDom, browser } = await montar();
  assert.equal(picker.group.getAttribute('role'), 'radiogroup');
  assert.equal(picker.group.getAttribute('aria-required'), 'true');
  const label = browser.find(picker.element, (el) => el.id === 'cor-teste-label');
  assert.equal(picker.group.getAttribute('aria-labelledby'), 'cor-teste-label');
  assert.equal(label.textContent, 'Cor do nicho');
  const opcoes = opcoesDom();
  assert.equal(opcoes.length, 20);
  assert.deepEqual(opcoes.map((o) => o.getAttribute('data-color')), NICHE_COLORS.map((c) => c.chave));
  for (const o of opcoes) {
    const chave = o.getAttribute('data-color');
    assert.match(o.className, new RegExp(`\\bcor-${chave}\\b`));
    assert.equal(o.getAttribute('aria-checked'), 'false');
    assert.equal(browser.find(o, (el) => el.className === 'swatch-name').textContent, NICHE_COLORS.find((c) => c.chave === chave).nome, 'o nome da cor está em texto');
    assert.equal(browser.find(o, (el) => el.className === 'swatch-dot').getAttribute('aria-hidden'), 'true', 'a amostra é decorativa: o nome é o que se lê');
    assert.equal(o.getAttribute('type'), 'button');
  }
  assert.equal(picker.value, '');
  // nenhum estilo inline em nenhum lugar do seletor
  assert.equal(browser.findAll(picker.element, (el) => el.hasAttribute('style')).length, 0);
  assert.equal(opcoes.filter((o) => o.getAttribute('tabindex') === '0').length, 1, 'uma só parada do Tab; sem escolha, é a primeira');
  assert.equal(opcoes[0].getAttribute('tabindex'), '0');
});

test('[CATUI-4] ESCOLHER: o clique marca só a opção (aria-checked e a classe `selected`), avisa uma vez, a marca "✓" acompanha, e escolher de novo a mesma não avisa', async () => {
  const { picker, opcoesDom, escolhas, browser } = await montar();
  const azul = opcoesDom().find((o) => o.getAttribute('data-color') === 'azul');
  browser.click(azul);
  assert.equal(picker.value, 'azul');
  assert.deepEqual(escolhas, ['azul']);
  assert.equal(azul.getAttribute('aria-checked'), 'true');
  assert.match(azul.className, /\bselected\b/);
  assert.equal(opcoesDom().filter((o) => o.getAttribute('aria-checked') === 'true').length, 1, 'escolha única');
  assert.equal(azul.getAttribute('tabindex'), '0');
  assert.equal(opcoesDom().filter((o) => o.getAttribute('tabindex') === '0').length, 1);
  browser.click(azul);
  assert.deepEqual(escolhas, ['azul'], 'a mesma escolha não avisa de novo');
  const rosa = opcoesDom().find((o) => o.getAttribute('data-color') === 'rosa');
  browser.click(rosa);
  assert.deepEqual(escolhas, ['azul', 'rosa']);
  assert.equal(azul.getAttribute('aria-checked'), 'false');
  assert.doesNotMatch(azul.className, /\bselected\b/);
  assert.match(rosa.className, /\bselected\b/);
});

test('[CATUI-5] TECLADO: setas movem a escolha e o foco (com volta ao início/fim), Home e End vão às pontas; sem escolha, ArrowRight escolhe a primeira e ArrowLeft a última', async () => {
  const { picker, opcoesDom, escolhas, browser } = await montar();
  const porChave = (chave) => opcoesDom().find((o) => o.getAttribute('data-color') === chave);
  opcoesDom()[0].focus();
  browser.press('ArrowRight', { target: opcoesDom()[0] });
  assert.equal(picker.value, 'vermelho', 'sem escolha, a primeira');
  assert.equal(browser.document.activeElement, porChave('vermelho'));
  browser.press('ArrowRight');
  browser.press('ArrowDown');
  assert.equal(picker.value, 'ambar');
  browser.press('ArrowLeft');
  browser.press('ArrowUp');
  assert.equal(picker.value, 'vermelho');
  browser.press('ArrowLeft');
  assert.equal(picker.value, 'ardosia', 'volta ao fim');
  browser.press('ArrowRight');
  assert.equal(picker.value, 'vermelho', 'e ao início');
  browser.press('End');
  assert.equal(picker.value, 'ardosia');
  browser.press('Home');
  assert.equal(picker.value, 'vermelho');
  assert.equal(browser.document.activeElement, porChave('vermelho'));
  assert.equal(escolhas.at(-1), 'vermelho');
  const outro = await montar();
  outro.opcoesDom()[3].focus();
  outro.browser.press('ArrowLeft', { target: outro.opcoesDom()[3] });
  assert.equal(outro.picker.value, 'ardosia', 'sem escolha, ArrowLeft escolhe a última');
  // Enter e Espaço numa opção focada a escolhem (o botão é acionado)
  const enter = await montar();
  const alvo = enter.opcoesDom().find((o) => o.getAttribute('data-color') === 'verde');
  alvo.focus();
  enter.browser.press('Enter');
  assert.equal(enter.picker.value, 'verde');
  const espaco = await montar();
  const alvo2 = espaco.opcoesDom().find((o) => o.getAttribute('data-color') === 'roxo');
  alvo2.focus();
  espaco.browser.press(' ');
  assert.equal(espaco.picker.value, 'roxo');
});

test('[CATUI-6] VALOR de fora: setValue só aceita uma das 20 chaves; erro e desabilitar funcionam; foco vai à escolhida', async () => {
  const { picker, opcoesDom, browser } = await montar({ value: 'turquesa' });
  assert.equal(picker.value, 'turquesa', 'o valor inicial aprovado vale');
  picker.setValue('hotpink');
  assert.equal(picker.value, '', 'uma chave fora da paleta vira "nenhuma"');
  picker.setValue('lima');
  assert.equal(picker.value, 'lima');
  assert.equal((await montar({ value: 'azul-bebe' })).picker.value, '', 'valor inicial fora da paleta é ignorado (nicho legado)');

  picker.setError('Escolha uma das 20 cores.');
  const erro = browser.find(picker.element, (el) => el.id === 'cor-teste-error');
  assert.equal(erro.hidden, false);
  assert.equal(erro.getAttribute('role'), 'alert');
  assert.equal(erro.textContent, 'Escolha uma das 20 cores.');
  assert.equal(picker.group.getAttribute('aria-invalid'), 'true');
  assert.match(picker.group.getAttribute('aria-describedby'), /cor-teste-error/);
  picker.setError(null);
  assert.equal(erro.hidden, true);
  assert.equal(picker.group.getAttribute('aria-invalid'), null);

  picker.focus();
  assert.equal(browser.document.activeElement, picker.swatch('lima'), 'o foco vai à opção escolhida');
  picker.setDisabled(true);
  assert.ok(opcoesDom().every((o) => o.disabled));
  browser.click(picker.swatch('rosa'));
  assert.equal(picker.value, 'lima', 'desabilitado não escolhe');
  picker.setDisabled(false);
  assert.ok(opcoesDom().every((o) => !o.disabled));
});

test('[CATUI-7] CSS do seletor e da lista: classes responsivas, foco visível e nenhuma cor fixa fora da paleta nas regras de nicho; sem url() nem estilo inline', () => {
  const regra = (seletor) => {
    const inicio = CSS.indexOf(`${seletor} {`);
    assert.ok(inicio >= 0, `${seletor} existe no CSS`);
    return CSS.slice(inicio, CSS.indexOf('}', inicio) + 1);
  };
  assert.match(regra('.color-swatch'), /background: var\(--cor-fundo\)/);
  assert.match(regra('.color-swatch'), /color: var\(--cor-texto\)/);
  assert.match(regra('.color-swatch .swatch-dot'), /background: var\(--cor-ponto\)/);
  assert.match(regra('.color-swatch.selected'), /border-color: var\(--cor-texto\)/);
  assert.match(regra('.color-swatch.selected .swatch-check'), /display: inline/);
  assert.match(regra('.color-swatch:focus-visible'), /outline: 3px solid/);
  assert.match(regra('.preview-card'), /border-left: 6px solid var\(--cor-ponto, #3c4653\)/, 'a borda esquerda do cartão usa a cor escolhida (neutra sem escolha)');
  assert.match(regra('.catalog-row.is-niche'), /border-left: 6px solid var\(--cor-ponto, #3c4653\)/);
  assert.match(CSS, /@media \(max-width: 760px\)\s*\{[^@]*\.catalog-row-actions \{ width: 100%; \}/, 'a lista vira cartões e as ações ocupam a linha no celular');
  assert.match(CSS, /\.color-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  const trecho = CSS.slice(CSS.indexOf('telas dos catálogos do CRM'));
  assert.doesNotMatch(trecho, /url\(/);
  assert.doesNotMatch(trecho, /@import|expression\(/);
});
