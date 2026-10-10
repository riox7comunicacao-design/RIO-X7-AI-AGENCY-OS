// Componentes globais do Dashboard (UX 4.0) — camadas (modal, drawer, confirmação), notificações, abas, paginação, barramento e acompanhador.
// DOM de teste (tests/helpers/fakeDom.js), nenhum navegador, nenhuma rede.
//
// O que estes testes protegem: ESC fecha SÓ a camada do topo; X / fundo / ESC respeitam alterações não salvas; o foco entra, fica preso, o fundo fica
// inert e o foco volta a quem abriu; nada vaza (um ouvinte de teclado, removido ao fechar a última camada); clique duplo não empilha nem envia duas vezes;
// o erro de uma confirmação preserva o que foi digitado; toasts têm papel correto e somem; abas e paginação funcionam pelo teclado.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

const loadUi = () => import('../../dashboard/ui/index.mjs');

async function ambiente({ conteudoFundo = true } = {}) {
  const ui = await loadUi();
  const browser = createBrowser();
  const app = browser.document.createElement('div');
  const fundo = browser.document.createElement('main');
  const abrir = browser.document.createElement('button');
  abrir.setAttribute('type', 'button');
  abrir.append('Abrir');
  const outro = browser.document.createElement('button');
  outro.setAttribute('type', 'button');
  outro.append('Outro botão do fundo');
  if (conteudoFundo) fundo.append(abrir, outro);
  const host = browser.document.createElement('div');
  app.append(fundo, host);
  browser.root.append(app);
  const kit = ui.createUi({ document: browser.document, host, getInertTargets: () => [fundo], schedule: () => () => {} });
  const campo = (rotulo, id) => {
    const input = browser.document.createElement('textarea');
    input.setAttribute('id', id);
    return input;
  };
  return { ui, browser, kit, fundo, host, abrir, outro, campo, document: browser.document };
}

const dialogo = (s) => s.browser.find(s.host, (el) => el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog');
const botao = (raiz, texto) => raiz && raiz.textContent !== undefined && require('../helpers/fakeDom').by.button(raiz, texto);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Camadas
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[UI-OV-1] abrir/fechar: o drawer abre na tela atual com role="dialog", aria-modal e título associado; X, ESC e fundo fecham; nada recarrega e o conteúdo de baixo continua', async () => {
  const s = await ambiente();
  s.abrir.focus();
  const handle = s.kit.overlays.openDrawer({ title: 'Lead Teste', subtitle: 'Petrópolis/RJ', content: s.document.createElement('p') });
  const d = dialogo(s);
  assert.ok(d && handle.isOpen);
  assert.equal(d.getAttribute('aria-modal'), 'true');
  const titulo = s.browser.find(d, (el) => el.localName === 'h2');
  assert.equal(titulo.textContent, 'Lead Teste');
  assert.equal(d.getAttribute('aria-labelledby'), titulo.id);
  assert.match(d.className, /drawer/);
  assert.equal(s.fundo.textContent.includes('Abrir'), true, 'o conteúdo de baixo segue na página');
  assert.equal(s.document.body.hasAttribute('data-overlay-open'), true, 'rolagem do fundo travada (atributo no body)');

  s.browser.press('Escape');
  assert.equal(handle.isOpen, false);
  assert.equal(dialogo(s), null);
  assert.equal(s.document.body.hasAttribute('data-overlay-open'), false);

  const porX = s.kit.overlays.openModal({ title: 'Modal' });
  s.browser.click(s.browser.find(s.host, (el) => el.getAttribute('data-action') === 'close'));
  assert.equal(porX.isOpen, false, 'o botão X fecha');

  const porFundo = s.kit.overlays.openModal({ title: 'Modal 2' });
  s.browser.click(s.browser.find(s.host, (el) => el.className === 'overlay-backdrop'));
  assert.equal(porFundo.isOpen, false, 'clicar fora fecha quando apropriado');

  const semFundo = s.kit.overlays.openModal({ title: 'Modal 3', closeOnBackdrop: false });
  s.browser.click(s.browser.find(s.host, (el) => el.className === 'overlay-backdrop'));
  assert.equal(semFundo.isOpen, true, 'closeOnBackdrop:false não fecha pelo fundo');
  s.browser.press('Escape');
  assert.equal(semFundo.isOpen, false);
});

test('[UI-OV-2] pilha: ESC fecha SOMENTE a camada do topo; a de baixo fica aberta e volta a ser a ativa; o fundo e a camada de baixo ficam inert enquanto houver topo', async () => {
  const s = await ambiente();
  const baixo = s.kit.overlays.openDrawer({ title: 'Drawer' });
  const topo = s.kit.overlays.openModal({ title: 'Modal em cima' });
  assert.equal(s.kit.overlays.depth(), 2);
  assert.equal(s.fundo.hasAttribute('inert'), true);
  assert.equal(baixo.element.parentNode.hasAttribute('inert'), true, 'a camada de baixo está inert');
  assert.equal(topo.element.parentNode.hasAttribute('inert'), false);

  s.browser.press('Escape');
  assert.deepEqual([topo.isOpen, baixo.isOpen, s.kit.overlays.depth()], [false, true, 1]);
  assert.equal(baixo.element.parentNode.hasAttribute('inert'), false, 'a de baixo voltou a ser a ativa');
  assert.equal(s.fundo.hasAttribute('inert'), true, 'o fundo continua inert');

  s.browser.press('Escape');
  assert.equal(s.kit.overlays.depth(), 0);
  assert.equal(s.fundo.hasAttribute('inert'), false, 'sem camadas, o fundo volta ao normal');
  assert.equal(s.fundo.hasAttribute('aria-hidden'), false);
});

test('[UI-OV-3] FOCO: entra na camada, Tab/Shift+Tab ficam presos dentro, o fundo inert não recebe foco nem clique, e ao fechar o foco volta a quem abriu (ou ao getReturnFocus)', async () => {
  const s = await ambiente();
  let cliques = 0;
  s.outro.addEventListener('click', () => { cliques += 1; });
  s.abrir.focus();
  assert.equal(s.document.activeElement, s.abrir);
  const conteudo = s.document.createElement('div');
  const b1 = s.document.createElement('button');
  b1.setAttribute('type', 'button');
  b1.append('Primeiro');
  const b2 = s.document.createElement('button');
  b2.setAttribute('type', 'button');
  b2.append('Segundo');
  conteudo.append(b1, b2);
  const handle = s.kit.overlays.openModal({ title: 'Foco', content: conteudo });
  assert.equal(s.document.activeElement, handle.element, 'o foco foi para dentro da camada');
  assert.equal(handle.element.contains(s.document.activeElement), true);

  // o fundo não recebe foco nem clique
  s.outro.focus();
  assert.notEqual(s.document.activeElement, s.outro, 'elemento inert não recebe foco');
  s.browser.click(s.outro);
  assert.equal(cliques, 0, 'elemento inert não recebe clique');

  // Tab percorre X -> Primeiro -> Segundo -> volta ao X (nunca sai da camada); Shift+Tab faz o caminho inverso
  s.browser.press('Tab');
  const x = s.browser.find(handle.element, (el) => el.getAttribute('data-action') === 'close');
  assert.equal(s.document.activeElement, x);
  s.browser.press('Tab');
  assert.equal(s.document.activeElement, b1);
  s.browser.press('Tab');
  assert.equal(s.document.activeElement, b2);
  s.browser.press('Tab');
  assert.equal(s.document.activeElement, x, 'do último volta ao primeiro');
  s.browser.press('Tab', { shiftKey: true });
  assert.equal(s.document.activeElement, b2, 'Shift+Tab do primeiro vai ao último');

  s.browser.press('Escape');
  assert.equal(s.document.activeElement, s.abrir, 'o foco voltou ao elemento que abriu');

  // se o elemento que abriu saiu da tela, vale o getReturnFocus
  const alvo = s.document.createElement('button');
  alvo.setAttribute('type', 'button');
  s.fundo.append(alvo);
  s.abrir.focus();
  const h2 = s.kit.overlays.openModal({ title: 'Outro', getReturnFocus: () => alvo });
  s.abrir.remove();
  s.browser.press('Escape');
  assert.equal(h2.isOpen, false);
  assert.equal(s.document.activeElement, alvo);
});

test('[UI-OV-4] ALTERAÇÕES NÃO SALVAS: fechar por ESC, X ou fundo pergunta antes de descartar; "Continuar editando" mantém tudo; "Descartar" fecha; sem alteração fecha direto', async () => {
  const s = await ambiente();
  let sujo = false;
  let fechou = null;
  const handle = s.kit.overlays.openModal({ title: 'Formulário', isDirty: () => sujo, onClose: (motivo) => { fechou = motivo; } });
  s.browser.press('Escape');
  assert.equal(handle.isOpen, false, 'sem alteração, fecha direto');
  assert.equal(fechou, 'escape');

  sujo = true;
  fechou = null;
  const h2 = s.kit.overlays.openModal({ title: 'Formulário 2', isDirty: () => sujo, onClose: (motivo) => { fechou = motivo; } });
  for (const gesto of ['escape', 'x', 'fundo']) {
    if (gesto === 'escape') s.browser.press('Escape');
    else if (gesto === 'x') s.browser.click(s.browser.find(h2.element, (el) => el.getAttribute('data-action') === 'close'));
    else s.browser.click(s.browser.find(h2.element.parentNode, (el) => el.className === 'overlay-backdrop'));
    assert.equal(h2.isOpen, true, `${gesto}: não fecha sem confirmar`);
    const pergunta = s.browser.find(s.host, (el) => el.getAttribute('role') === 'alertdialog');
    assert.ok(pergunta, `${gesto}: pergunta antes de descartar`);
    assert.match(pergunta.textContent, /Descartar alterações\?/);
    // "Continuar editando" (cancela e mantém tudo) — o foco inicial já está nele
    assert.equal(s.document.activeElement.textContent, 'Continuar editando');
    s.browser.click(s.document.activeElement);
    assert.equal(h2.isOpen, true);
    assert.equal(s.kit.overlays.depth(), 1);
  }
  s.browser.press('Escape');
  s.browser.click(s.browser.find(s.host, (el) => el.localName === 'button' && el.textContent === 'Descartar'));
  await s.browser.flush();
  assert.equal(h2.isOpen, false, 'Descartar fecha');
  assert.equal(fechou, 'escape');
  assert.equal(s.kit.overlays.depth(), 0);
});

test('[UI-OV-5] SEM VAZAMENTO e SEM DUPLICAÇÃO: um único ouvinte de teclado no document (removido ao fechar a última camada); a mesma key não empilha duas; destroy limpa tudo', async () => {
  const s = await ambiente();
  assert.equal(s.document.listenerCount('keydown'), 0);
  const a = s.kit.overlays.openDrawer({ title: 'Lead', key: 'lead:1' });
  const b = s.kit.overlays.openDrawer({ title: 'Lead', key: 'lead:1' });
  assert.equal(s.kit.overlays.depth(), 1, 'clique duplo não empilha duas camadas');
  assert.equal(a.element, b.element);
  const c = s.kit.overlays.openModal({ title: 'Outra', key: 'outra' });
  assert.equal(s.document.listenerCount('keydown'), 1, 'um ouvinte só, mesmo com duas camadas');
  c.close();
  assert.equal(s.document.listenerCount('keydown'), 1);
  a.close();
  assert.equal(s.document.listenerCount('keydown'), 0, 'ouvinte removido ao fechar a última');
  for (let i = 0; i < 25; i += 1) s.kit.overlays.openModal({ title: `M${i}` }).close();
  assert.equal(s.document.listenerCount('keydown'), 0);
  assert.equal(s.host.children.filter((el) => /overlay\b/.test(el.className)).length, 0, 'nenhuma camada sobrou no DOM');

  s.kit.overlays.openModal({ title: 'x' });
  s.kit.overlays.openModal({ title: 'y' });
  s.kit.destroy();
  assert.equal(s.document.listenerCount('keydown'), 0);
  assert.throws(() => s.kit.overlays.openModal({ title: 'depois de destruir' }), /destruído/);
});

test('[UI-OV-6] CONFIRMAÇÃO: campo obrigatório vazio mostra o erro e não envia; clique duplo envia UMA vez; erro do servidor preserva o texto e deixa tentar de novo; sucesso fecha; cancelar fecha sem enviar; ESC com texto pergunta', async () => {
  const s = await ambiente();
  const chamadas = [];
  let falhar = true;
  let resolver = null;
  const handle = s.kit.overlays.openConfirm({
    key: 'rejeitar',
    title: 'Confirmar rejeição',
    message: 'Prospect: Teste',
    tone: 'danger',
    confirmLabel: 'Confirmar rejeição',
    field: { id: 'reason-input', label: 'Motivo (obrigatório)', required: true, requiredMessage: 'Informe o motivo da rejeição.' },
    onConfirm: (valor) => {
      chamadas.push(valor);
      return new Promise((resolve, reject) => { resolver = () => (falhar ? reject(new Error('O servidor recusou. Tente novamente.')) : resolve()); });
    },
  });
  const d = handle.element;
  assert.equal(d.getAttribute('role'), 'alertdialog');
  assert.equal(s.document.activeElement.id, 'reason-input', 'o foco inicial está no campo do motivo');
  const confirmar = s.browser.find(d, (el) => el.getAttribute('data-action') === 'confirm');
  const campo = s.browser.find(d, (el) => el.id === 'reason-input');

  s.browser.click(confirmar);
  assert.match(d.textContent, /Informe o motivo da rejeição\./);
  assert.equal(chamadas.length, 0, 'campo obrigatório vazio: nada é enviado');
  assert.equal(campo.getAttribute('aria-invalid'), 'true');

  s.browser.type(campo, 'Fora do perfil comercial');
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  s.browser.click(confirmar);
  assert.equal(chamadas.length, 1, 'três cliques seguidos enviam UMA vez');
  assert.equal(confirmar.disabled, true);
  assert.equal(confirmar.textContent, 'Enviando…');
  s.browser.press('Escape');
  assert.equal(handle.isOpen, true, 'durante o envio a camada não fecha');
  resolver();
  await s.browser.flush();
  assert.equal(handle.isOpen, true, 'erro: continua aberta');
  assert.match(d.textContent, /O servidor recusou\. Tente novamente\./);
  assert.equal(campo.value, 'Fora do perfil comercial', 'o texto digitado foi preservado');
  assert.equal(confirmar.disabled, false);
  assert.equal(confirmar.textContent, 'Confirmar rejeição');

  falhar = false;
  s.browser.click(confirmar);
  resolver();
  await s.browser.flush();
  assert.deepEqual(chamadas, ['Fora do perfil comercial', 'Fora do perfil comercial']);
  assert.equal(handle.isOpen, false, 'sucesso fecha');

  // cancelar fecha sem enviar; ESC com texto digitado pergunta
  const n = chamadas.length;
  const h2 = s.kit.overlays.openConfirm({ key: 'k2', title: 'Aprovar', field: { id: 'r2', label: 'Motivo' }, onConfirm: async () => { chamadas.push('x'); } });
  s.browser.type(s.browser.find(h2.element, (el) => el.id === 'r2'), 'rascunho');
  s.browser.press('Escape');
  assert.equal(h2.isOpen, true);
  assert.ok(s.browser.find(s.host, (el) => el.localName === 'button' && el.textContent === 'Descartar'));
  s.browser.click(s.browser.find(s.host, (el) => el.localName === 'button' && el.textContent === 'Continuar editando'));
  s.browser.click(s.browser.find(h2.element, (el) => el.getAttribute('data-action') === 'cancel'));
  assert.equal(h2.isOpen, false, 'Cancelar é uma escolha explícita: fecha');
  assert.equal(chamadas.length, n, 'cancelar não envia');
});

test('[UI-OV-7] o conteúdo pode ser trocado com a camada aberta (atualização de dados) sem perder a rolagem; e um erro de closeDialog fecha a confirmação', async () => {
  const s = await ambiente();
  const p1 = s.document.createElement('p');
  p1.append('versão 1');
  const handle = s.kit.overlays.openDrawer({ title: 'Lead', content: p1 });
  handle.body.scrollTop = 240;
  const p2 = s.document.createElement('p');
  p2.append('versão 2 (atualizada)');
  handle.setContent(p2);
  assert.equal(handle.body.scrollTop, 240, 'a rolagem foi preservada');
  assert.match(handle.element.textContent, /versão 2/);
  handle.setTitle('Lead atualizado');
  assert.match(handle.element.textContent, /Lead atualizado/);

  const conf = s.kit.overlays.openConfirm({ key: 'cd', title: 'Confirmar', onConfirm: async () => { throw Object.assign(new Error('x'), { closeDialog: true }); } });
  s.browser.click(s.browser.find(conf.element, (el) => el.getAttribute('data-action') === 'confirm'));
  await s.browser.flush();
  assert.equal(conf.isOpen, false, 'erro com closeDialog fecha a confirmação');
  assert.equal(handle.isOpen, true, 'a camada de baixo segue aberta');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Notificações
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[UI-TOAST-1] toasts: papéis (status/alert), fechar no X, sumir sozinho pelo agendador, máximo de 4, a mesma key substitui; texto vazio não aparece; destroy limpa', async () => {
  const ui = await loadUi();
  const browser = createBrowser();
  const host = browser.document.createElement('div');
  browser.root.append(host);
  const tarefas = [];
  const toasts = ui.createToaster({ document: browser.document, host, schedule: (fn, ms) => { const t = { fn, ms, cancelado: false }; tarefas.push(t); return () => { t.cancelado = true; }; } });
  assert.equal(host.children[0].getAttribute('aria-label'), 'Notificações');

  const ok = toasts.success('Prospect aprovado.');
  const erro = toasts.error('Não foi possível concluir.');
  const aviso = toasts.warning('Atenção: possível duplicidade.');
  assert.deepEqual([ok.element.getAttribute('role'), erro.element.getAttribute('role'), aviso.element.getAttribute('role')], ['status', 'alert', 'status']);
  assert.deepEqual(tarefas.map((t) => t.ms), [5000, 10000, 8000], 'sucesso 5 s, erro 10 s, aviso 8 s');
  assert.equal(toasts.count(), 3);
  tarefas[0].fn();
  assert.equal(toasts.count(), 2, 'sumiu sozinho');
  browser.click(browser.find(erro.element, (el) => el.localName === 'button'));
  assert.equal(toasts.count(), 1, 'o botão fecha na hora');
  assert.equal(tarefas[1].cancelado, true, 'o agendamento foi cancelado (sem vazamento)');

  toasts.success('A', { key: 'k' });
  toasts.success('B', { key: 'k' });
  const mensagens = browser.findAll(host, (el) => el.className === 'toast-message').map((el) => el.textContent);
  assert.deepEqual(mensagens.filter((m) => m === 'A' || m === 'B'), ['B'], 'a mesma key substitui o toast anterior');
  for (let i = 0; i < 10; i += 1) toasts.info(`mensagem ${i}`);
  assert.equal(toasts.count(), 4, 'no máximo 4 ao mesmo tempo');
  assert.equal(toasts.show({ kind: 'info', text: '   ' }).element, undefined, 'texto vazio não vira toast');
  toasts.destroy();
  assert.equal(host.children.length, 0);
  assert.ok(tarefas.every((t) => t.cancelado || t.fn), 'ok');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Abas, paginação, estados, barramento, acompanhador
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[UI-COMP-1] abas (WAI-ARIA): só a ativa no tab order; setas/Home/End navegam; todos os painéis ficam no DOM (hidden); badge atualizável; onChange avisa só quando muda', async () => {
  const ui = await loadUi();
  const browser = createBrowser();
  const painel = (texto) => { const p = browser.document.createElement('p'); p.append(texto); return p; };
  const mudancas = [];
  const tabs = ui.createTabs(browser.document, { idPrefix: 'lead', label: 'Seções do lead', active: 'resumo', onChange: (k) => mudancas.push(k), tabs: [{ key: 'resumo', label: 'Resumo', content: painel('conteúdo do resumo') }, { key: 'contatos', label: 'Contatos', content: painel('conteúdo dos contatos') }, { key: 'fontes', label: 'Fontes', content: painel('conteúdo das fontes'), badge: '3' }] });
  browser.root.append(tabs.element);
  const botoes = browser.findAll(tabs.element, (el) => el.getAttribute('role') === 'tab');
  assert.deepEqual(botoes.map((b) => [b.getAttribute('aria-selected'), b.getAttribute('tabindex')]), [['true', '0'], ['false', '-1'], ['false', '-1']]);
  const paineis = browser.findAll(tabs.element, (el) => el.getAttribute('role') === 'tabpanel');
  assert.deepEqual(paineis.map((p) => p.hidden), [false, true, true]);
  assert.match(tabs.element.textContent, /conteúdo dos contatos/, 'painéis inativos continuam no DOM');
  assert.equal(botoes[0].getAttribute('aria-controls'), paineis[0].id);
  assert.equal(paineis[0].getAttribute('aria-labelledby'), botoes[0].id);

  botoes[0].focus();
  browser.press('ArrowRight');
  assert.equal(tabs.active, 'contatos');
  assert.equal(browser.document.activeElement, botoes[1]);
  browser.press('End');
  assert.equal(tabs.active, 'fontes');
  browser.press('ArrowRight');
  assert.equal(tabs.active, 'resumo', 'dá a volta');
  browser.press('ArrowLeft');
  assert.equal(tabs.active, 'fontes');
  browser.press('Home');
  assert.equal(tabs.active, 'resumo');
  browser.click(botoes[1]);
  browser.click(botoes[1]);
  assert.deepEqual(mudancas, ['contatos', 'fontes', 'resumo', 'fontes', 'resumo', 'contatos'], 'só avisa quando a aba muda');
  tabs.setBadge('contatos', '2');
  assert.match(botoes[1].textContent, /Contatos2/);
  tabs.setBadge('fontes', '');
  assert.doesNotMatch(botoes[2].textContent, /3/);
  tabs.setPanel('resumo', painel('novo resumo'));
  assert.match(tabs.panel('resumo').textContent, /novo resumo/);
});

test('[UI-COMP-2] busca, filtro, paginação, estado vazio, esqueleto e selo: rótulos associados, o campo mantém o texto, a paginação some com uma página só', async () => {
  const ui = await loadUi();
  const browser = createBrowser();
  const digitado = [];
  const busca = ui.searchField(browser.document, { id: 'q', label: 'Buscar lead', placeholder: 'Empresa, cidade…', onInput: (v) => digitado.push(v) });
  const filtro = ui.selectField(browser.document, { id: 'f', label: 'Estado', options: [{ value: 'a', label: 'Pendentes' }, { value: 'b', label: 'Aprovados' }], value: 'b', onChange: (v) => digitado.push(`filtro:${v}`) });
  browser.root.append(busca.element, filtro.element);
  assert.equal(browser.by.label(browser.root, 'Buscar lead'), busca.input);
  assert.equal(filtro.select.value, 'b');
  browser.type(busca.input, 'alfa');
  browser.choose(filtro.select, 'a');
  assert.deepEqual(digitado, ['alfa', 'filtro:a']);
  assert.equal(busca.input.value, 'alfa', 'o campo não é recriado: o texto fica');

  const paginas = [];
  assert.equal(ui.pagination(browser.document, { page: 1, pageCount: 1, total: 5, pageSize: 10, onPage: () => {} }), null, 'uma página só: sem paginação');
  const nav = ui.pagination(browser.document, { page: 2, pageCount: 3, total: 25, pageSize: 10, onPage: (p) => paginas.push(p) });
  assert.match(nav.textContent, /Página 2 de 3 · 11–20 de 25/);
  browser.click(browser.by.button(nav, 'Próxima'));
  browser.click(browser.by.button(nav, 'Anterior'));
  assert.deepEqual(paginas, [3, 1]);
  const primeira = ui.pagination(browser.document, { page: 1, pageCount: 3, total: 25, pageSize: 10, onPage: () => {} });
  assert.equal(browser.by.button(primeira, 'Anterior').disabled, true);

  const vazio = ui.emptyState(browser.document, { title: 'Nenhum lead', text: 'Ajuste a busca.' });
  assert.match(vazio.textContent, /Nenhum lead.*Ajuste a busca\./);
  assert.equal(vazio.getAttribute('role'), 'status');
  const esq = ui.skeleton(browser.document, { rows: 3, label: 'Carregando leads…' });
  assert.equal(esq.getAttribute('aria-busy'), 'true');
  assert.equal(browser.findAll(esq, (el) => el.getAttribute('aria-hidden') === 'true').length, 3);
  assert.equal(ui.statusBadge(browser.document, 'Pendente', 'warn').className, 'badge warn');
  assert.equal(ui.statusBadge(browser.document, 'x', 'tom-inventado').className, 'badge neutral', 'tom desconhecido vira neutro');
  const kv = ui.kvList(browser.document, [['Cidade', browser.document.createTextNode('Petrópolis')], ['Vazio', null]]);
  assert.equal(kv.children.length, 2, 'linhas sem conteúdo não aparecem');
});

test('[UI-DATA-1] barramento: publica para quem assinou, cancela a assinatura, isola ouvintes com defeito; o acompanhador roda só enquanto há o que acompanhar, nunca em paralelo, pausa com a aba escondida, desiste após falhas e para na hora', async () => {
  const ui = await loadUi();
  const bus = ui.createDataBus();
  const recebidos = [];
  const cancelar = bus.subscribe('approvals:changed', (p) => recebidos.push(p));
  bus.subscribe('approvals:changed', () => { throw new Error('ouvinte com defeito'); });
  bus.subscribe('approvals:changed', (p) => recebidos.push(`2:${p.action}`));
  bus.publish('approvals:changed', { action: 'approve' });
  assert.deepEqual(recebidos, [{ action: 'approve' }, '2:approve'], 'o defeito de um não impede os outros');
  cancelar();
  bus.publish('approvals:changed', { action: 'reject' });
  assert.deepEqual(recebidos, [{ action: 'approve' }, '2:approve', '2:reject']);
  assert.equal(bus.listenerCount('approvals:changed'), 2);

  const agenda = [];
  const schedule = (fn, ms) => { const t = { fn, ms, cancelado: false }; agenda.push(t); return () => { t.cancelado = true; }; };
  const proxima = async () => { const t = agenda.filter((x) => !x.cancelado && !x.feito).at(-1); if (!t) return false; t.feito = true; await t.fn(); return true; };
  let estados = ['EM_ANDAMENTO', 'EM_ANDAMENTO', 'COMPLETO'];
  let chamadas = 0;
  const poller = ui.createPoller({ tick: async () => { chamadas += 1; return estados.shift(); }, shouldContinue: (estado) => estado === 'EM_ANDAMENTO', intervalMs: 10, schedule });
  assert.equal(agenda.length, 0, 'não consulta antes de start()');
  poller.start();
  poller.start();
  assert.equal(agenda.length, 1, 'start duplo não agenda duas vezes');
  assert.equal(agenda[0].ms >= 1000, true, 'intervalo mínimo de 1 s: nada de consulta agressiva');
  await proxima();
  await proxima();
  assert.equal(poller.running, true);
  await proxima();
  assert.equal(chamadas, 3);
  assert.equal(poller.running, false, 'terminou: o acompanhamento para sozinho');
  assert.equal(agenda.filter((x) => !x.cancelado && !x.feito).length, 0, 'nada agendado depois de terminar');

  let escondida = true;
  let tiques = 0;
  const pausado = ui.createPoller({ tick: async () => { tiques += 1; return 'EM_ANDAMENTO'; }, shouldContinue: () => true, schedule, isHidden: () => escondida });
  pausado.start();
  await proxima();
  assert.equal(tiques, 0, 'aba escondida: não chama o servidor');
  escondida = false;
  await proxima();
  assert.equal(tiques, 1);
  pausado.stop();
  assert.equal(pausado.running, false);
  assert.equal(agenda.filter((x) => !x.cancelado && !x.feito).length, 0, 'stop cancela o agendamento');

  let desistiu = false;
  const falho = ui.createPoller({ tick: async () => { throw new Error('rede'); }, shouldContinue: () => true, maxFailures: 3, onGiveUp: () => { desistiu = true; }, schedule });
  falho.start();
  await proxima();
  await proxima();
  assert.equal(desistiu, false);
  await proxima();
  assert.deepEqual([desistiu, falho.running], [true, false], 'depois de 3 falhas seguidas desiste');
});
