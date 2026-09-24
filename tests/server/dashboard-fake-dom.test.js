// O DOM de teste (tests/helpers/fakeDom.js) é a base de todos os testes de interface do Dashboard: se ele se comportasse
// diferente do navegador, um teste poderia passar por um motivo errado. Estes testes travam os comportamentos em que os
// outros testes dependem — e cada um deles é também o comportamento de um navegador de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

async function dom() {
  const { h } = await import('../../dashboard/dom.mjs');
  const browser = createBrowser();
  return { browser, h: (tag, props, ...children) => h(browser.document, tag, props, ...children) };
}

test('[FAKEDOM-1] textContent lê a árvore inteira; gravar troca os filhos por um texto; replaceChildren e remove mexem só na árvore', async () => {
  const { browser, h } = await dom();
  const item = h('li', { text: 'um' }, h('b', { text: ' dois' }));
  const lista = h('ul', {}, item, h('li', { text: 'tres' }));
  assert.equal(lista.textContent, 'um doistres');
  item.textContent = 'novo';
  assert.equal(item.children.length, 0, 'gravar textContent descarta os filhos');
  assert.equal(lista.textContent, 'novotres');
  lista.replaceChildren(h('li', { text: 'só' }));
  assert.equal(lista.textContent, 'só');
  const filho = lista.children[0];
  filho.remove();
  assert.equal(lista.children.length, 0);
  assert.equal(browser.text(lista), '');
});

test('[FAKEDOM-2] o valor de input/textarea/select segue as regras do navegador: padrão vem do atributo, do texto ou da opção selected; depois de digitar, vale o digitado', async () => {
  const { browser, h } = await dom();
  const input = h('input', { type: 'text', value: 'inicial' });
  assert.equal(input.value, 'inicial');
  browser.type(input, 'digitado');
  assert.equal(input.value, 'digitado');

  const area = h('textarea', { text: 'padrão' });
  assert.equal(area.value, 'padrão');
  area.value = 'outro';
  assert.equal(area.value, 'outro');

  const select = h('select', {}, h('option', { value: 'a', text: 'A' }), h('option', { value: 'b', text: 'B', selected: true }), h('option', { value: 'c', text: 'C' }));
  assert.equal(select.value, 'b', 'a opção selected é o padrão');
  browser.choose(select, 'c');
  assert.equal(select.value, 'c');
  select.value = 'não existe';
  assert.equal(select.value, '', 'um valor sem opção deixa o select sem escolha, como no navegador');
  select.replaceChildren(h('option', { value: 'x', text: 'X' }), h('option', { value: 'y', text: 'Y' }));
  assert.equal(select.value, 'x', 'trocar as opções volta ao padrão: a primeira');
});

test('[FAKEDOM-3] checkbox: o padrão vem do atributo; clicar alterna e avisa (input e change); um botão desabilitado não recebe clique', async () => {
  const { browser, h } = await dom();
  const marcado = h('input', { type: 'checkbox', checked: true });
  const desmarcado = h('input', { type: 'checkbox' });
  assert.equal(marcado.checked, true);
  assert.equal(desmarcado.checked, false);
  const avisos = [];
  desmarcado.addEventListener('change', () => avisos.push('change'));
  browser.click(desmarcado);
  assert.equal(desmarcado.checked, true);
  assert.deepEqual(avisos, ['change']);
  browser.check(desmarcado, false);
  assert.equal(desmarcado.checked, false);

  let cliques = 0;
  const botao = h('button', { type: 'button', disabled: true, onclick: () => (cliques += 1) });
  browser.click(botao);
  assert.equal(cliques, 0);
});

test('[FAKEDOM-4] um botão submit dentro de um form envia o form (e preventDefault é respeitado); um botão type=button não envia', async () => {
  const { browser, h } = await dom();
  const envios = [];
  const enviar = h('button', { type: 'submit' });
  const outro = h('button', { type: 'button' });
  const form = h('form', { onsubmit: (event) => { event.preventDefault(); envios.push(event.defaultPrevented); } }, enviar, outro);
  browser.click(enviar);
  browser.click(outro);
  assert.deepEqual(envios, [true]);
  assert.equal(form.children.length, 2);
});

test('[FAKEDOM-5] eventos sobem (bubbling) até a raiz; stopPropagation para a subida', async () => {
  const { browser, h } = await dom();
  const chamadas = [];
  const filho = h('button', { type: 'button', onclick: () => chamadas.push('filho') });
  const pai = h('div', { onclick: () => chamadas.push('pai') }, filho);
  browser.click(filho);
  assert.deepEqual(chamadas, ['filho', 'pai']);
  chamadas.length = 0;
  filho.addEventListener('click', (event) => event.stopPropagation());
  browser.click(filho);
  assert.deepEqual(chamadas, ['filho']);
  assert.equal(pai.children.length, 1);
});

test('[FAKEDOM-6] clicar num link de # muda o fragmento e o hashchange chega DEPOIS (assíncrono); replaceState não dispara nada', async () => {
  const { browser, h } = await dom();
  const avisos = [];
  browser.window.addEventListener('hashchange', () => avisos.push(browser.window.location.hash));
  const link = h('a', { href: '#/crm', text: 'CRM' });
  browser.click(link);
  assert.equal(browser.window.location.hash, '#/crm');
  assert.deepEqual(avisos, [], 'o hashchange não é síncrono');
  await browser.flush();
  assert.deepEqual(avisos, ['#/crm']);
  browser.window.history.replaceState(null, '', '#/outro');
  await browser.flush();
  assert.equal(browser.window.location.hash, '#/outro');
  assert.deepEqual(avisos, ['#/crm'], 'replaceState não emite hashchange');
});

test('[FAKEDOM-7] focus() só funciona num elemento habilitado e atualiza document.activeElement; as buscas encontram por texto, rótulo e classe', async () => {
  const { browser, h } = await dom();
  const campo = h('input', { id: 'nome', type: 'text' });
  const bloqueado = h('input', { id: 'x', type: 'text', disabled: true });
  const tela = h('form', { className: 'painel grande' }, h('label', { for: 'nome', text: 'Nome' }), campo, bloqueado, h('button', { type: 'button', text: 'Salvar' }));
  browser.root.replaceChildren(tela);
  campo.focus();
  assert.equal(browser.document.activeElement, campo);
  bloqueado.focus();
  assert.equal(browser.document.activeElement, campo, 'um campo desabilitado não recebe foco');
  assert.equal(browser.by.label(browser.root, 'Nome'), campo);
  assert.equal(browser.by.button(browser.root, 'Salvar').localName, 'button');
  assert.equal(browser.by.cls(browser.root, 'grande').length, 1);
  assert.equal(browser.by.text(browser.root, /^Sal/).localName, 'button');
});
