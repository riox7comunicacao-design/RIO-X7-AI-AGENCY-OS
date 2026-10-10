'use strict';

// Um DOM de TESTE — só o subconjunto do DOM que o Dashboard usa, sem dependência nenhuma (nada de jsdom).
//
// O Dashboard recebe `document`, `root` e a navegação por parâmetro (ver dashboard/main.mjs e as views), então as telas
// rodam aqui do mesmo jeito que no navegador. Este arquivo é USO SOMENTE EM TESTES: src/ e dashboard/ nunca o importam.
//
// O que ele imita, de propósito fiel ao navegador nos pontos em que os testes dependem:
//   - textContent (lê a árvore inteira; gravar troca os filhos por um texto), append/replaceChildren/remove;
//   - value de input/textarea/select (o valor padrão vem do atributo `value`, do texto do <textarea> ou da <option>
//     `selected`; depois de digitar, o valor é o digitado); select.value só aceita o valor de uma <option> que existe;
//   - checked (padrão = atributo), disabled, hidden, className, id;
//   - focus() e document.activeElement;
//   - eventos com propagação (bubbling), preventDefault e defaultPrevented;
//   - o comportamento PADRÃO de um clique: <a href="#..."> muda o fragmento (e o `hashchange` é assíncrono, como no
//     navegador), <button type=submit> dentro de um <form> envia o formulário (o evento `submit`), <input type=checkbox>
//     alterna e avisa (input/change).
// O que NÃO imita: layout, CSS, seletores, validação nativa de formulário, rede.
//
//   const browser = createBrowser();          // { document, window, ... } + as ações de "usuário"
//   browser.type(input, 'texto'); browser.click(botao); browser.choose(select, 'VALOR'); await browser.flush();

// Um elemento está fora de alcance do teclado/mouse se ele ou um ancestral é `inert` ou `hidden`.
function isInertOrHidden(element) {
  for (let current = element; current && current.nodeType === 1; current = current.parentNode) {
    if (current.hasAttribute('inert') || current.hidden) return true;
  }
  return false;
}

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

const BUBBLES = new Set(['click', 'input', 'change', 'submit', 'keydown', 'keyup']);

class FakeElement {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.nodeType = 1;
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this._value = undefined;
    this._checked = undefined;
    this._selected = undefined;
  }

  // --- atributos --------------------------------------------------------
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  get type() {
    const declared = this.getAttribute('type');
    if (declared !== null) return declared.toLowerCase();
    return this.localName === 'button' ? 'submit' : 'text';
  }

  get href() {
    return this.getAttribute('href') || '';
  }

  // --- árvore -----------------------------------------------------------
  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this._detachChildren();
    const text = value === null || value === undefined ? '' : String(value);
    if (text !== '') this._adopt(new FakeText(text));
  }

  _adopt(node) {
    if (this.localName === 'select') this._selected = undefined; // mudar as opções refaz a escolha padrão
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    node.parentNode = this;
    this.childNodes.push(node);
  }

  _detachChildren() {
    if (this.localName === 'select') this._selected = undefined;
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
  }

  // Como o navegador: um argumento que NÃO é um nó vira TEXTO (append(null) escreve "null", append(undefined) escreve
  // "undefined") — por isso os testes de tela conferem que nenhum desses textos aparece.
  append(...nodes) {
    for (const node of nodes) this._adopt(node && typeof node === 'object' && (node.nodeType === 1 || node.nodeType === 3) ? node : new FakeText(String(node)));
  }

  replaceChildren(...nodes) {
    this._detachChildren();
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
      this.parentNode = null;
    }
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  // --- valores de formulário --------------------------------------------
  get value() {
    if (this.localName === 'select') {
      const options = this._options();
      let chosen = this._selected;
      // Sem escolha (ou com a opção escolhida já removida), vale a <option selected> ou a primeira — como no navegador.
      // `null` é "nenhuma" (um valor que não existe foi atribuído): value = ''.
      if (chosen === undefined || (chosen !== null && !options.includes(chosen))) chosen = options.find((option) => option.hasAttribute('selected')) || options[0];
      return chosen ? chosen.value : '';
    }
    if (this.localName === 'option') return this.hasAttribute('value') ? this.getAttribute('value') : this.textContent;
    if (this._value !== undefined) return this._value;
    if (this.localName === 'textarea') return this.textContent;
    if (this.localName === 'input' && this.type === 'checkbox') return this.hasAttribute('value') ? this.getAttribute('value') : 'on';
    return this.getAttribute('value') || '';
  }

  set value(next) {
    const text = next === null || next === undefined ? '' : String(next);
    if (this.localName === 'select') {
      this._selected = this._options().find((option) => option.value === text) || null;
      return;
    }
    this._value = text;
  }

  get checked() {
    return this._checked !== undefined ? this._checked : this.hasAttribute('checked');
  }

  set checked(next) {
    this._checked = Boolean(next);
  }

  _options() {
    return this.childNodes.filter((node) => node.nodeType === 1 && node.localName === 'option');
  }

  // --- foco e eventos ---------------------------------------------------
  focus() {
    if (this.disabled || isInertOrHidden(this)) return;
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  // Dispara um evento com propagação até a raiz (como o navegador para click/input/change/submit).
  dispatchEvent(event) {
    event.target = this;
    for (let current = this; current; current = event.bubbles ? current.parentNode : null) {
      event.currentTarget = current;
      for (const listener of [...((current.listeners && current.listeners.get(event.type)) || [])]) listener.call(current, event);
      if (event.propagationStopped) break;
    }
    return !event.defaultPrevented;
  }
}

function makeEvent(type, extra = {}) {
  return {
    type,
    bubbles: BUBBLES.has(type),
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...extra,
  };
}

class FakeDocument {
  constructor() {
    this.title = '';
    this.activeElement = null;
    this.hidden = false;
    this._listeners = new Map();
    this.body = null; // um <body> de teste (criado sob demanda por createBrowser)
  }

  // Ouvintes no nível do document (como o ESC dos modais): addEventListener/removeEventListener e a contagem, para provar que nada vaza.
  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(type) || [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  listenerCount(type) {
    return (this._listeners.get(type) || []).length;
  }

  _dispatch(event) {
    for (const listener of [...(this._listeners.get(event.type) || [])]) listener.call(this, event);
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  createTextNode(text) {
    return new FakeText(text);
  }
}

// Um `window` com o mínimo que a navegação por # usa: location.hash, hashchange (assíncrono) e history.replaceState.
class FakeWindow {
  constructor(hash = '') {
    this._hash = hash;
    this._entries = [hash];
    this._index = 0;
    this._listeners = new Set();
    const win = this;
    this.location = {
      get hash() {
        return win._hash;
      },
      set hash(value) {
        const next = String(value).startsWith('#') ? String(value) : `#${value}`;
        if (next === win._hash) return;
        win._hash = next;
        win._entries.splice(win._index + 1, win._entries.length, next); // uma navegação nova descarta o "avançar"
        win._index += 1;
        queueMicrotask(() => win._emitHashChange());
      },
    };
    this.history = {
      replaceState(_state, _title, url) {
        win._hash = String(url);
        win._entries[win._index] = win._hash;
      },
      // voltar/avançar do navegador: move na pilha e avisa (hashchange assíncrono), se a entrada mudou
      go(delta) {
        const target = win._index + delta;
        if (target < 0 || target >= win._entries.length) return;
        win._index = target;
        const changed = win._entries[target] !== win._hash;
        win._hash = win._entries[target];
        if (changed) queueMicrotask(() => win._emitHashChange());
      },
      back() {
        this.go(-1);
      },
      forward() {
        this.go(1);
      },
      get length() {
        return win._entries.length;
      },
    };
  }

  addEventListener(type, listener) {
    if (type === 'hashchange') this._listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'hashchange') this._listeners.delete(listener);
  }

  _emitHashChange() {
    for (const listener of [...this._listeners]) listener({ type: 'hashchange' });
  }
}

// ---------------------------------------------------------------------------
// Buscas na árvore (para os testes)
// ---------------------------------------------------------------------------
function* walk(node) {
  for (const child of node.childNodes || []) {
    if (child.nodeType === 1) {
      yield child;
      yield* walk(child);
    }
  }
}

const classes = (element) => element.className.split(/\s+/).filter(Boolean);

// Todos os elementos abaixo de `root` que satisfazem o predicado.
function findAll(root, predicate) {
  return [...walk(root)].filter(predicate);
}

function find(root, predicate) {
  for (const element of walk(root)) if (predicate(element)) return element;
  return null;
}

// Busca pelo texto: `text` como string (o texto do elemento aparado é IGUAL) ou RegExp; `tag` opcional.
function matchText(element, text) {
  const own = element.textContent.trim();
  return text instanceof RegExp ? text.test(own) : own === text;
}

const by = {
  id: (root, id) => find(root, (element) => element.id === id),
  tag: (root, tag) => findAll(root, (element) => element.localName === tag),
  cls: (root, name) => findAll(root, (element) => classes(element).includes(name)),
  text: (root, text, tag) => find(root, (element) => (tag === undefined || element.localName === tag) && matchText(element, text)),
  texts: (root, text, tag) => findAll(root, (element) => (tag === undefined || element.localName === tag) && matchText(element, text)),
  // O controle de um <label>: pelo texto do rótulo (igual ou RegExp) -> o elemento cujo id é o `for` do rótulo.
  label: (root, text) => {
    const label = find(root, (element) => element.localName === 'label' && matchText(element, text));
    return label && label.getAttribute('for') ? by.id(root, label.getAttribute('for')) : null;
  },
  button: (root, text) => find(root, (element) => (element.localName === 'button' || (element.localName === 'a' && classes(element).includes('btn'))) && matchText(element, text)),
  link: (root, text) => find(root, (element) => element.localName === 'a' && matchText(element, text)),
};

// ---------------------------------------------------------------------------
// O "navegador" de teste: o document, o window e as ações de usuário
// ---------------------------------------------------------------------------
function createBrowser({ hash = '' } = {}) {
  const document = new FakeDocument();
  const window = new FakeWindow(hash);
  const root = document.createElement('div');
  document.body = document.createElement('body');

  const browser = {
    document,
    window,
    root,
    by,
    findAll,
    find,

    // Espera as promessas pendentes (e o `hashchange` assíncrono) terminarem.
    async flush(times = 4) {
      for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
    },

    text: (element = root) => element.textContent,

    // Teclado: keydown no elemento em foco (ou no `target`), com bubbling até a raiz e depois os ouvintes do document. O comportamento
    // padrão da tecla Tab (se ninguém o impediu) move o foco para o próximo (Shift+Tab: anterior) elemento focável fora de áreas inert/ocultas.
    press(key, { target, shiftKey = false } = {}) {
      const origin = target || document.activeElement || root;
      const event = makeEvent('keydown', { key, shiftKey });
      origin.dispatchEvent(event);
      if (!event.propagationStopped) document._dispatch(event);
      // comportamento padrão do navegador: Enter ou Espaço em um botão o aciona (clique)
      if ((key === 'Enter' || key === ' ') && !event.defaultPrevented && origin.localName === 'button') browser.click(origin);
      if (key === 'Tab' && !event.defaultPrevented) {
        const order = focusables(root);
        if (order.length > 0) {
          const at = order.indexOf(document.activeElement);
          const next = shiftKey ? (at <= 0 ? order.length - 1 : at - 1) : (at < 0 || at === order.length - 1 ? 0 : at + 1);
          order[next].focus();
        }
      }
      return event;
    },

    // Clique: o evento (com bubbling) e depois o comportamento PADRÃO do navegador, se ninguém o impediu.
    click(element) {
      if (element.disabled || isInertOrHidden(element)) return;
      const event = makeEvent('click');
      element.dispatchEvent(event);
      if (event.defaultPrevented) return;
      if (element.localName === 'a' && element.href.startsWith('#')) {
        window.location.hash = element.href;
      } else if (element.localName === 'input' && element.type === 'checkbox') {
        element.checked = !element.checked;
        element.dispatchEvent(makeEvent('input'));
        element.dispatchEvent(makeEvent('change'));
      } else if (element.localName === 'button' && element.type === 'submit') {
        const form = closest(element, 'form');
        if (form) browser.submit(form);
      }
    },

    submit(form) {
      form.dispatchEvent(makeEvent('submit'));
    },

    // Digitar num campo: troca o valor e avisa (input).
    type(element, text) {
      element.value = text;
      element.dispatchEvent(makeEvent('input'));
    },

    // Escolher uma opção de um <select>: troca o valor e avisa (change).
    choose(element, value) {
      element.value = value;
      element.dispatchEvent(makeEvent('change'));
    },

    check(element, checked = true) {
      if (element.checked !== checked) browser.click(element);
    },
  };
  return browser;
}

const FOCUSABLE_TAGS = new Set(['button', 'select', 'textarea', 'input', 'a']);

// Os elementos que o teclado alcança, na ordem do documento (button/input/select/textarea ativos, a[href], tabindex >= 0) — fora de áreas inert/ocultas.
function focusables(container) {
  return findAll(container, (element) => {
    if (element.disabled || isInertOrHidden(element)) return false;
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null) return Number(tabindex) >= 0;
    if (element.localName === 'a') return element.hasAttribute('href');
    if (element.localName === 'input' && element.type === 'hidden') return false;
    return FOCUSABLE_TAGS.has(element.localName);
  });
}

function closest(element, tag) {
  for (let current = element.parentNode; current; current = current.parentNode) if (current.localName === tag) return current;
  return null;
}

module.exports = { createBrowser, FakeDocument, FakeElement, FakeWindow, makeEvent, findAll, find, by, focusables, isInertOrHidden };
