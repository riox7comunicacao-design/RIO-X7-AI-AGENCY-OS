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
  // as 20 opções: o NOME INTEIRO, numa linha, em qualquer largura (ver CATUI-9 e CATUI-10)
  assert.match(regra('.color-swatch .swatch-name'), /white-space: nowrap/);
  assert.doesNotMatch(CSS, /\.color-grid \{ grid-template-columns: repeat\(2/, 'sem colunas fixas que estreitem as opções no celular');
  const trecho = CSS.slice(CSS.indexOf('telas dos catálogos do CRM'));
  assert.doesNotMatch(trecho, /url\(/);
  assert.doesNotMatch(trecho, /@import|expression\(/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// os NOMES das 20 cores: inteiros, numa linha, em qualquer largura (refinamento da 2B-2: "Vermelho" e "Esmeralda" quebravam no meio da palavra)
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATUI-8] OS 20 NOMES: cada um aparece INTEIRO, num único texto (sem hífen condicional, espaço invisível nem quebra de linha embutida), na ordem do servidor — e dentro do formulário de nicho também', async () => {
  const { picker, opcoesDom, browser } = await montar();
  const nomes = opcoesDom().map((o) => browser.find(o, (el) => el.className === 'swatch-name'));
  assert.equal(nomes.length, 20);
  assert.deepEqual(nomes.map((n) => n.textContent), NICHE_COLORS.map((c) => c.nome));
  for (const n of nomes) {
    assert.equal(n.childNodes.length, 1, `${n.textContent}: um único nó de texto`);
    assert.equal(n.childNodes[0].nodeType, 3);
    assert.doesNotMatch(n.textContent, /[­​-‍⁠﻿\n\r\t]/, `${n.textContent}: nenhum ponto de quebra escondido`);
    assert.equal(n.textContent, n.textContent.trim());
    assert.equal(browser.findAll(n, (el) => el.localName === 'wbr' || el.localName === 'br').length, 0);
  }
  assert.ok(nomes.some((n) => n.textContent === 'Vermelho') && nomes.some((n) => n.textContent === 'Esmeralda'), 'os dois que quebravam');
  assert.equal(picker.swatch('vermelho').getAttribute('aria-label'), null, 'o nome acessível é o texto visível (nada de rótulo diferente)');
  // dentro do formulário de nicho (o caminho real da tela)
  const H = require('../helpers/catalogHarness');
  const s = await H.abrir({ catalogo: 'nichos', api: H.apiFalsa({ nichos: [H.nicho(1)] }) });
  await H.clicar(s, H.botao(s, 'Novo Nicho'));
  const noForm = s.browser.findAll(H.gaveta(s), (el) => el.className === 'swatch-name').map((n) => n.textContent);
  assert.deepEqual(noForm, NICHE_COLORS.map((c) => c.nome));
});

test('[CATUI-9] REGRESSÃO da seleção e da prévia nas 20 cores: clicar e usar o teclado em CADA cor marca só ela, move o foco, atualiza a classe e o texto da prévia e mantém o nome visível', async () => {
  const H = require('../helpers/catalogHarness');
  const s = await H.abrir({ catalogo: 'nichos', api: H.apiFalsa({ nichos: [H.nicho(1)] }) });
  await H.clicar(s, H.botao(s, 'Novo Nicho'));
  const g = H.gaveta(s);
  const radios = () => s.browser.findAll(g, (el) => el.getAttribute('role') === 'radio');
  const previa = () => s.browser.find(g, (el) => /\bpreview-card\b/.test(el.className));
  const marcadas = () => radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('data-color'));
  const ehMesmo = (a, b, mensagem) => assert.ok(a === b, mensagem);
  // clique, uma a uma
  for (const cor of NICHE_COLORS) {
    const opcao = radios().find((r) => r.getAttribute('data-color') === cor.chave);
    s.browser.click(opcao);
    assert.deepEqual(marcadas(), [cor.chave], cor.chave);
    assert.ok(new RegExp(`\\bcor-${cor.chave}\\b`).test(previa().className), `prévia: ${cor.chave}`);
    assert.equal(previa().getAttribute('data-color'), cor.chave);
    assert.ok(g.textContent.includes(`Cor escolhida: ${cor.nome}.`), `nota da prévia: ${cor.nome}`);
    assert.equal(s.browser.find(opcao, (el) => el.className === 'swatch-name').textContent, cor.nome, 'o nome continua visível na opção escolhida');
  }
  // teclado: ArrowRight percorre as 20 na ordem e volta ao começo
  radios()[0].focus();
  s.browser.press('Home');
  const vistas = [marcadas()[0]];
  for (let i = 0; i < 19; i += 1) {
    s.browser.press('ArrowRight');
    vistas.push(marcadas()[0]);
    ehMesmo(s.browser.document.activeElement, radios().find((r) => r.getAttribute('data-color') === marcadas()[0]), 'o foco acompanha a escolha');
    assert.ok(new RegExp(`\\bcor-${marcadas()[0]}\\b`).test(previa().className));
  }
  assert.deepEqual(vistas, NICHE_COLORS.map((c) => c.chave), 'as 20, na ordem do servidor');
  s.browser.press('ArrowRight');
  assert.deepEqual(marcadas(), ['vermelho'], 'e volta ao começo');
  assert.equal(radios().filter((r) => r.getAttribute('tabindex') === '0').length, 1, 'uma única parada do Tab');
  // escolher a cor continua levando só a chave ao servidor
  H.digitar(s, H.campo(s, 'nome'), 'Nicho de teste');
  await H.salvar(s);
  assert.deepEqual(s.api.chamadas.filter(([n]) => n === 'criar')[0].slice(1), ['nichos', { nome: 'Nicho de teste', cor: 'vermelho' }]);
});

test('[CATUI-10] RESPONSIVIDADE do seletor: a coluna mínima vem da MEDIDA do nome mais largo; em todas as larguras de painel (celular de 320 px ao desktop) há ao menos 2 colunas e cada opção tem folga para o nome inteiro, que nunca quebra no meio', () => {
  const regra = (seletor) => {
    const inicio = CSS.indexOf(`${seletor} {`);
    assert.ok(inicio >= 0, seletor);
    return CSS.slice(inicio, CSS.indexOf('}', inicio) + 1);
  };
  const nome = regra('.color-swatch .swatch-name');
  assert.match(nome, /white-space: nowrap/);
  assert.match(nome, /overflow-wrap: normal/);
  assert.match(nome, /word-break: normal/);
  assert.match(nome, /hyphens: none/);
  assert.doesNotMatch(nome, /anywhere|break-word|break-all/, 'nenhuma regra que parta uma palavra');
  assert.doesNotMatch(CSS, /\.color-swatch[^{]*\{[^}]*(overflow-wrap: anywhere|word-break: break-all)/);

  // os números do CSS
  const grade = regra('.color-grid');
  const minimo = Number(/minmax\((\d+)px, 1fr\)/.exec(grade)[1]);
  const folga = Number(/gap: (\d+)px/.exec(grade)[1]);
  const opcao = regra('.color-swatch');
  const padding = /padding: (\d+)px (\d+)px (\d+)px (\d+)px/.exec(opcao);
  const direita = Number(padding[2]);
  const esquerda = Number(padding[4]);
  const borda = Number(/border: (\d+)px solid/.exec(opcao)[1]);
  const espaco = Number(/gap: (\d+)px/.exec(opcao)[1]);
  const amostra = Number(/width: (\d+)px/.exec(regra('.color-swatch .swatch-dot'))[1]);
  const reserva = 2 * borda + esquerda + amostra + espaco + direita; // tudo na opção que não é o nome
  // MEDIDA no navegador (Chromium, system-ui 600 13,5 px): o nome mais largo é "Esmeralda", 62,68 px; com 10% de folga para fontes mais largas
  const MAIS_LARGO = 62.68;
  assert.ok(minimo >= reserva + MAIS_LARGO * 1.1, `coluna mínima ${minimo}px >= reserva ${reserva}px + nome mais largo com folga ${(MAIS_LARGO * 1.1).toFixed(1)}px`);
  assert.match(opcao, /font-size: 13\.5px/, 'a fonte não foi reduzida para caber');
  // simula o auto-fill da grade nas larguras úteis do painel: 320 px (celular pequeno), 375, 600 e as largas
  const larguras = { 'celular 320': 320 - 32, 'celular 375': 375 - 32, 'tablet 600': 600 - 32, 'painel 576': 576, 'painel 592': 592, 'painel 656': 656, 'tela cheia 760': 760 - 32 };
  for (const [rotulo, largura] of Object.entries(larguras)) {
    const colunas = Math.max(1, Math.floor((largura + folga) / (minimo + folga)));
    const colunaReal = (largura - (colunas - 1) * folga) / colunas;
    assert.ok(colunas >= 2, `${rotulo}: ${colunas} colunas (>= 2)`);
    assert.ok(colunaReal - reserva >= MAIS_LARGO * 1.1, `${rotulo}: sobram ${(colunaReal - reserva).toFixed(1)}px para o nome`);
  }
  // a prévia e a seleção continuam como eram
  assert.match(regra('.color-swatch.selected'), /border-color: var\(--cor-texto\)/);
  assert.match(regra('.preview-card'), /border-left: 6px solid var\(--cor-ponto, #3c4653\)/);
  assert.match(regra('.color-swatch:focus-visible'), /outline: 3px solid/);
});
