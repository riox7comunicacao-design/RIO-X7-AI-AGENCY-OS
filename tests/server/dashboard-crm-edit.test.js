// CRM na UX 4.0.6.3 — EDIÇÃO SEGURA. Prova que uma edição (ou um "Novo registro") com texto digitado NUNCA se perde sem a pessoa decidir: ESC, X, fundo, Voltar do navegador, outro
// endereço, outro registro, troca de módulo e atualizar/fechar a aba perguntam ("Continuar editando" ou "Descartar alterações"); "Continuar editando" devolve o endereço sem empilhar
// entradas nem criar laços; sem alterações nada pergunta; durante um salvamento nada fecha. E que a edição em si é segura: 31 campos em abas, obrigatórios claros, validação antes de
// enviar sem perder o digitado, só os campos alterados, estado de salvamento, sucesso só depois da API, lista e ficha atualizadas sem F5, eventos/respostas tardias sem sobrescrever
// o formulário, sem salvamento automático. DOM de teste e API falsa: nenhuma rede, nenhum registro real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBrowser } = require('../helpers/fakeDom');

const loadView = () => import('../../dashboard/views/crm.mjs');
const loadModel = () => import('../../dashboard/crm-model.mjs');
const loadRouter = () => import('../../dashboard/router.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8').replace(/\r\n/g, '\n');

const ADMIN = Object.freeze({ canReadCrm: true, canWriteCrm: true, canDeleteCrm: false, canReview: true });
const CLOSER = Object.freeze({ canReadCrm: true, canWriteCrm: false, canDeleteCrm: false, canReview: true });
const SO_EXCLUIR = Object.freeze({ canReadCrm: true, canWriteCrm: false, canDeleteCrm: true, canReview: true });

async function registros() {
  const { crmRecord } = await loadFixtures();
  return [
    crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', contato: 'Maria Souza', nicho: 'Psicologia', cidade: 'Petrópolis', estado: 'RJ', status: 'CONTACTED', responsavel: 'Rafael', proximaAcao: 'Ligar na segunda', dataDaProximaAcao: '2026-10-05', valorProposta: 1500, telefone: '(24) 90000-0001', email: 'contato@alfa.example.test', site: 'alfa.example.test', dataDeEntrada: '2026-09-12T10:00:00.000Z' }),
    crmRecord({ id: 'crm:b', empresa: 'Odonto Beta', nicho: 'Odontologia', cidade: 'Niterói', status: 'WON', dataDeEntrada: '2026-09-14T10:00:00.000Z' }),
  ];
}

async function apiFalsa(items) {
  const { createFakeApi } = await loadFixtures();
  return createFakeApi({ items: items || (await registros()) });
}

async function abrir({ items, permissions = ADMIN, comNavegacao = false, hash = '', api: dada, bus: busDado } = {}) {
  const { createCrmView } = await loadView();
  const { createDataBus, createUi } = await loadUi();
  const { browserNavigation, parseRoute } = await loadRouter();
  const browser = createBrowser({ hash });
  const api = dada || (await apiFalsa(items));
  const bus = busDado || createDataBus();
  const eventos = [];
  bus.subscribe('crm:changed', (p) => eventos.push(p));
  const navigation = comNavegacao ? browserNavigation(browser.window) : null;
  const host = browser.document.createElement('div');
  host.className = 'overlay-host';
  const viewRoot = browser.document.createElement('div');
  browser.root.append(viewRoot, host);
  const ui = createUi({ document: browser.document, host, getInertTargets: () => [viewRoot] });
  const view = createCrmView({ document: browser.document, root: viewRoot, api, permissions, navigate() {}, bus, navigation, ui });
  if (navigation) navigation.subscribe(() => view.show(parseRoute(navigation.current())));
  const s = { browser, view, api, bus, eventos, navigation, ui, root: browser.root, win: browser.window };
  await view.show(comNavegacao ? parseRoute(navigation.current()) : { name: 'crm-list' });
  await browser.flush();
  return s;
}

const gaveta = (s) => s.browser.find(s.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const botao = (s, nome) => s.browser.by.button(s.root, nome);
const noModal = (s, nome) => s.browser.by.button(confirmacao(s), nome);
const rotulo = (s, nome) => s.browser.by.label(gaveta(s), nome);
const clicar = async (s, el) => { s.browser.click(el); await s.browser.flush(8); };
const teclar = async (s, tecla) => { s.browser.press(tecla); await s.browser.flush(8); };
const digitar = (s, nome, valor) => s.browser.type(rotulo(s, nome), valor);
const conta = (s, nome) => s.api.callsOf(nome).length;
const titulo = (s) => s.browser.by.cls(s.root, 'overlay-title')[0].textContent;
const textoDaTela = (s) => s.root.textContent.replace(/\s+/g, ' ');
const statusDeEdicao = (s) => s.browser.by.id(s.root, 'crm-edit-status').textContent;
const hashDe = (id) => `#/crm/registro/${encodeURIComponent(id)}`;

async function abrirEdicao(s, empresa = 'Clínica Alfa') {
  await clicar(s, botao(s, empresa));
  await clicar(s, botao(s, 'Editar'));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PRIORIDADE 1 — proteger alterações não salvas
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-ED-1] VOLTAR do navegador com edição não salva NÃO fecha a gaveta: pergunta; "Continuar editando" devolve o endereço sem empilhar entradas nem fazer laço; "Descartar alterações" sai; sem alterações o Voltar é livre', async () => {
  const s = await abrir({ comNavegacao: true, hash: '#/crm' });
  const win = s.win;
  await abrirEdicao(s);
  assert.equal(win.location.hash, hashDe('crm:a'));
  assert.equal(win.history.length, 2);
  digitar(s, 'Cidade', 'Rascunho de cidade');
  const entradasAntes = [...win._entries];
  const getAntes = conta(s, 'getCrm');

  win.history.back();
  await s.browser.flush(10);
  assert.ok(gaveta(s), 'a gaveta NÃO fechou');
  assert.ok(confirmacao(s), 'e perguntou');
  assert.match(confirmacao(s).textContent, /Descartar alterações\?/);
  assert.ok(noModal(s, 'Continuar editando') && noModal(s, 'Descartar alterações'));
  assert.equal(rotulo(s, 'Cidade').value, 'Rascunho de cidade', 'nada foi descartado automaticamente');

  await clicar(s, noModal(s, 'Continuar editando'));
  assert.equal(confirmacao(s), null);
  assert.equal(win.location.hash, hashDe('crm:a'), 'o endereço voltou ao da ficha');
  assert.deepEqual(win._entries, entradasAntes, 'nenhuma entrada nova no histórico (nem uma a menos)');
  assert.equal(win.history.length, 2);
  assert.ok(gaveta(s));
  assert.equal(rotulo(s, 'Cidade').value, 'Rascunho de cidade', 'o rascunho continua');
  assert.equal(confirmacao(s), null, 'sem laço: voltar ao endereço da ficha não pergunta de novo');
  assert.equal(conta(s, 'getCrm'), getAntes, 'a ficha em edição não foi recarregada');
  assert.equal(statusDeEdicao(s), 'Alterações não salvas');

  win.history.back();
  await s.browser.flush(10);
  assert.ok(confirmacao(s), 'o Voltar de novo pergunta de novo');
  await clicar(s, noModal(s, 'Descartar alterações'));
  assert.equal(gaveta(s), null, 'descartou: a gaveta fechou');
  assert.equal(win.location.hash, '#/crm');
  assert.equal(conta(s, 'updateCrm'), 0, 'descartar não grava nada');

  win.history.forward();
  await s.browser.flush(10);
  assert.ok(gaveta(s), 'o Avançar continua funcionando');
  assert.equal(titulo(s), 'Clínica Alfa');
  assert.equal(s.browser.by.cls(s.root, 'ficha-tabs')[0].hidden, false, 'reabriu em leitura: o rascunho foi descartado');

  // sem alterações, o Voltar é livre (nem a edição aberta, mas sem digitar, pergunta)
  await clicar(s, botao(s, 'Editar'));
  win.history.back();
  await s.browser.flush(10);
  assert.equal(gaveta(s), null);
  assert.equal(confirmacao(s), null, 'nenhuma pergunta sem alterações');
  assert.equal(win.location.hash, '#/crm');
});

test('[CRM-ED-2] ESC, X e clique no fundo com rascunho perguntam (a mesma pergunta); "Continuar editando" mantém o texto e o foco; "Descartar alterações" fecha e volta o endereço; sem rascunho fecham direto', async () => {
  const s = await abrir({ comNavegacao: true, hash: '#/crm' });
  await abrirEdicao(s);
  digitar(s, 'Cidade', 'Rascunho');
  const campo = rotulo(s, 'Cidade');
  campo.focus();

  await teclar(s, 'Escape');
  assert.ok(gaveta(s) && confirmacao(s), 'ESC pergunta');
  await clicar(s, noModal(s, 'Continuar editando'));
  assert.equal(rotulo(s, 'Cidade'), campo, 'o mesmo campo, não recriado');
  assert.equal(campo.value, 'Rascunho');
  assert.equal(s.browser.document.activeElement, campo, 'o foco volta para onde a pessoa estava');

  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  assert.ok(confirmacao(s), 'o X pergunta');
  await teclar(s, 'Escape'); // ESC com a pergunta aberta fecha a pergunta (= continuar editando)
  assert.equal(confirmacao(s), null);
  assert.ok(gaveta(s));
  assert.equal(campo.value, 'Rascunho');

  await clicar(s, s.browser.by.cls(s.root, 'overlay-backdrop')[0]);
  assert.ok(confirmacao(s), 'o clique no fundo pergunta');
  await clicar(s, noModal(s, 'Continuar editando'));
  assert.ok(gaveta(s) && campo.value === 'Rascunho');
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await clicar(s, noModal(s, 'Descartar alterações'));
  assert.equal(gaveta(s), null);
  assert.equal(s.win.location.hash, '#/crm', 'fechar pela interface devolve o endereço da lista');
  assert.equal(s.win.history.length, 2, 'sem entradas novas');
  assert.equal(s.browser.document.activeElement === botao(s, 'Clínica Alfa'), true, 'o foco voltou à linha');
  assert.equal(conta(s, 'updateCrm'), 0);

  await abrirEdicao(s, 'Odonto Beta');
  await teclar(s, 'Escape');
  assert.equal(gaveta(s), null, 'sem rascunho, ESC fecha direto');
});

test('[CRM-ED-3] outro ENDEREÇO com rascunho (outro registro, a lista, "Novo registro"): pergunta; continuar devolve o endereço da ficha; descartar vai para onde a pessoa pediu', async () => {
  const s = await abrir({ comNavegacao: true, hash: '#/crm' });
  await abrirEdicao(s);
  digitar(s, 'Cidade', 'Rascunho');

  s.win.location.hash = hashDe('crm:b'); // abrir OUTRO registro (link, endereço digitado...)
  await s.browser.flush(10);
  assert.equal(titulo(s), 'Clínica Alfa', 'nada trocou');
  assert.ok(confirmacao(s));
  await clicar(s, noModal(s, 'Continuar editando'));
  assert.equal(s.win.location.hash, hashDe('crm:a'), 'o endereço voltou à ficha em edição');
  assert.equal(rotulo(s, 'Cidade').value, 'Rascunho');

  s.win.location.hash = '#/crm/novo';
  await s.browser.flush(10);
  assert.ok(confirmacao(s));
  assert.equal(s.browser.by.tag(s.root, 'table').length, 1, 'a lista continua por baixo, a página de novo registro não abriu');
  await clicar(s, noModal(s, 'Continuar editando'));
  assert.equal(s.win.location.hash, hashDe('crm:a'));

  s.win.location.hash = hashDe('crm:b');
  await s.browser.flush(10);
  await clicar(s, noModal(s, 'Descartar alterações'));
  assert.equal(titulo(s), 'Odonto Beta', 'descartou e abriu o registro pedido');
  assert.equal(s.win.location.hash, hashDe('crm:b'));
  assert.equal(conta(s, 'updateCrm'), 0);
});

test('[CRM-ED-4] vários "Voltar" seguidos com a pergunta aberta continuam sendo UMA pergunta; escolher continuar devolve o endereço uma vez', async () => {
  const s = await abrir({ comNavegacao: true, hash: '#/crm' });
  await abrirEdicao(s);
  digitar(s, 'Cidade', 'Rascunho');
  s.win.history.back();
  await s.browser.flush(10);
  assert.equal(s.browser.findAll(s.root, (el) => el.getAttribute('role') === 'alertdialog' || (el.getAttribute('role') === 'dialog' && /\bmodal\b/.test(el.className))).length, 1);
  s.win.location.hash = '#/crm/novo'; // a pessoa insiste, com a pergunta ainda aberta
  await s.browser.flush(10);
  assert.equal(s.browser.findAll(s.root, (el) => el.getAttribute('role') === 'alertdialog' || (el.getAttribute('role') === 'dialog' && /\bmodal\b/.test(el.className))).length, 1, 'continua uma pergunta só');
  await clicar(s, noModal(s, 'Continuar editando'));
  assert.equal(s.win.location.hash, hashDe('crm:a'));
  assert.ok(gaveta(s));
  assert.equal(rotulo(s, 'Cidade').value, 'Rascunho');
  assert.equal(s.browser.document.activeElement !== null, true);
});

test('[CRM-ED-5] FECHAR/ATUALIZAR A ABA (beforeunload): só com alteração não salva (ou salvando); sem alteração nada é pedido; some depois de salvar/descartar/destruir; convive com o guarda de outra tela; o texto não promete o aviso', async () => {
  const s = await abrir({ comNavegacao: true, hash: '#/crm' });
  const win = s.win;
  assert.equal(win.listenerCount('beforeunload'), 1, 'o guarda do CRM está registrado');
  assert.equal(win.fireBeforeUnload().prevented, false, 'lista parada: nada a pedir');
  await abrirEdicao(s);
  assert.equal(win.fireBeforeUnload().prevented, false, 'edição aberta mas sem alterações: nada a pedir (a navegação normal não é bloqueada)');
  digitar(s, 'Cidade', 'Rascunho');
  assert.equal(win.fireBeforeUnload().prevented, true, 'com alterações pede o aviso nativo');
  digitar(s, 'Cidade', 'Petrópolis');
  assert.equal(win.fireBeforeUnload().prevented, false, 'voltou ao valor original: nada a perder');
  digitar(s, 'Cidade', 'Outra');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.equal(win.fireBeforeUnload().prevented, false, 'salvou: nada a perder');

  await clicar(s, botao(s, 'Editar'));
  digitar(s, 'Cidade', 'Rascunho 2');
  assert.equal(win.fireBeforeUnload().prevented, true);
  await clicar(s, botao(s, 'Cancelar'));
  await clicar(s, noModal(s, 'Descartar alterações'));
  assert.equal(win.fireBeforeUnload().prevented, false, 'descartou: nada a perder');

  // salvando: também pede
  await clicar(s, botao(s, 'Editar'));
  digitar(s, 'Cidade', 'Enviando');
  const pendente = s.api.hold('updateCrm');
  s.browser.click(botao(s, 'Salvar alterações'));
  await pendente.arrived;
  assert.equal(win.fireBeforeUnload().prevented, true, 'durante o salvamento fechar a aba também pede confirmação');
  pendente.release();
  await s.browser.flush(8);
  assert.equal(win.fireBeforeUnload().prevented, false);

  s.view.destroy();
  assert.equal(win.listenerCount('beforeunload'), 0, 'destroy() remove o ouvinte');

  // dois guardas (CRM + outra tela) não se atropelam: basta um responder
  const { browserNavigation } = await loadRouter();
  const b = createBrowser();
  const nav = browserNavigation(b.window);
  let a1 = false;
  let a2 = false;
  const solta1 = nav.setLeaveGuard(() => a1);
  const solta2 = nav.setLeaveGuard(() => a2);
  assert.equal(b.window.listenerCount('beforeunload'), 1, 'um único ouvinte no window');
  assert.equal(b.window.fireBeforeUnload().prevented, false);
  a2 = true;
  assert.equal(b.window.fireBeforeUnload().prevented, true, 'o segundo guarda vale');
  a2 = false;
  a1 = true;
  assert.equal(b.window.fireBeforeUnload().prevented, true, 'e o primeiro também (um não substitui o outro)');
  solta1();
  assert.equal(b.window.fireBeforeUnload().prevented, false, 'soltar um deixa o outro');
  solta2();
  assert.equal(b.window.listenerCount('beforeunload'), 0);

  const fonte = read('dashboard', 'views', 'crm.mjs');
  assert.match(fonte, /o navegador decide se e como mostra o aviso/i, 'o código registra o limite real do navegador');
});

test('[CRM-ED-6] SALVANDO nada fecha: ESC/X/fundo são ignorados, o Voltar do navegador é recusado (endereço devolvido, com aviso) e o resultado do salvamento aparece normalmente', async () => {
  const s = await abrir({ comNavegacao: true, hash: '#/crm' });
  await abrirEdicao(s);
  digitar(s, 'Cidade', 'Salvando isto');
  const pendente = s.api.hold('updateCrm');
  s.browser.click(botao(s, 'Salvar alterações'));
  await pendente.arrived;
  assert.equal(botao(s, 'Salvando…').disabled, true, 'o botão mostra o estado e fica travado');
  assert.equal(statusDeEdicao(s), 'Salvando…');
  assert.doesNotMatch(textoDaTela(s), /Alterações salvas\./, 'sucesso SÓ depois da API');

  await teclar(s, 'Escape');
  assert.ok(gaveta(s), 'ESC ignorado');
  await clicar(s, s.browser.by.cls(s.root, 'overlay-backdrop')[0]);
  assert.ok(gaveta(s), 'fundo ignorado');
  assert.equal(s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close').disabled, true, 'o X fica desabilitado');
  s.win.history.back();
  await s.browser.flush(10);
  assert.ok(gaveta(s), 'o Voltar não fecha');
  assert.equal(confirmacao(s), null, 'e não pergunta: simplesmente aguarda');
  assert.equal(s.win.location.hash, hashDe('crm:a'), 'o endereço foi devolvido');
  assert.match(textoDaTela(s), /Aguarde o salvamento terminar antes de sair\./);
  assert.equal(conta(s, 'updateCrm'), 1);

  pendente.release();
  await s.browser.flush(10);
  assert.match(textoDaTela(s), /Alterações salvas\./);
  await teclar(s, 'Escape');
  assert.equal(gaveta(s), null, 'terminou: fecha normalmente');
});

test('[CRM-ED-7] "NOVO REGISTRO" também é protegido: texto digitado + Voltar/outro endereço perguntam; sem texto nada pergunta; criado com sucesso não pergunta; beforeunload só com texto', async () => {
  const s = await abrir({ comNavegacao: true, hash: '#/crm' });
  s.win.location.hash = '#/crm/novo';
  await s.browser.flush(10);
  assert.equal(s.win.fireBeforeUnload().prevented, false, 'página aberta e vazia: nada a perder');
  s.win.history.back();
  await s.browser.flush(10);
  assert.equal(s.win.location.hash, '#/crm', 'vazia: sai sem perguntar');
  assert.equal(confirmacao(s), null);

  s.win.history.forward();
  await s.browser.flush(10);
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Nova Ltda');
  assert.equal(s.win.fireBeforeUnload().prevented, true);
  s.win.history.back();
  await s.browser.flush(10);
  assert.ok(confirmacao(s), 'com texto digitado, o Voltar pergunta');
  assert.equal(s.browser.by.label(s.root, 'Empresa (obrigatório)').value, 'Nova Ltda');
  await clicar(s, noModal(s, 'Continuar editando'));
  assert.equal(s.win.location.hash, '#/crm/novo');
  assert.equal(s.browser.by.label(s.root, 'Empresa (obrigatório)').value, 'Nova Ltda', 'o rascunho continua');

  await clicar(s, s.browser.by.button(s.root, 'Criar registro'));
  assert.equal(conta(s, 'createCrm'), 1);
  assert.equal(s.win.fireBeforeUnload().prevented, false, 'criado: nada mais a perder');

  const outro = await abrir({ comNavegacao: true, hash: '#/crm/novo' });
  outro.browser.type(outro.browser.by.label(outro.root, 'Empresa (obrigatório)'), 'Descartável');
  outro.win.location.hash = '#/crm';
  await outro.browser.flush(10);
  assert.ok(confirmacao(outro));
  await clicar(outro, noModal(outro, 'Descartar alterações'));
  assert.equal(outro.win.location.hash, '#/crm');
  assert.equal(conta(outro, 'createCrm'), 0);
  assert.equal(outro.browser.by.tag(outro.root, 'table').length, 1, 'voltou à lista');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o adaptador de navegação (router): desfazer sem empilhar
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-ED-8] restore(hash) leva o endereço de volta SEM criar entradas: usa o histórico quando a vizinha é a certa, troca a entrada quando não sabe, e a numeração sobrevive a recarregar a página', async () => {
  const { browserNavigation } = await loadRouter();
  const preparar = (hash) => {
    const b = createBrowser({ hash });
    const nav = browserNavigation(b.window);
    const avisos = [];
    nav.subscribe(() => avisos.push(nav.current()));
    return { b, nav, avisos };
  };

  // Voltar e restaurar: a entrada vizinha ("avançar") é a certa
  const um = preparar('#/crm');
  um.nav.go('#/crm/registro/x');
  await um.b.flush();
  um.b.window.history.back();
  await um.b.flush();
  assert.equal(um.nav.current(), '#/crm');
  um.nav.restore('#/crm/registro/x');
  await um.b.flush();
  assert.equal(um.nav.current(), '#/crm/registro/x');
  assert.deepEqual(um.b.window._entries, ['#/crm', '#/crm/registro/x'], 'nenhuma entrada nova');

  // trocar de módulo por um clique (entrada nova) e restaurar: volta uma entrada, sem empilhar
  const dois = preparar('#/crm/registro/x');
  dois.nav.go('#/aprovacoes');
  await dois.b.flush();
  dois.nav.restore('#/crm/registro/x');
  await dois.b.flush();
  assert.equal(dois.nav.current(), '#/crm/registro/x');
  assert.equal(dois.b.window._entries.length, 2);
  dois.b.window.history.forward();
  await dois.b.flush();
  assert.equal(dois.nav.current(), '#/aprovacoes', 'o Avançar continua levando para onde a pessoa tinha ido');

  // já está lá: nada acontece
  const antes = [...dois.avisos];
  dois.nav.restore('#/aprovacoes');
  await dois.b.flush();
  assert.deepEqual(dois.avisos, antes);

  // entrada desconhecida (nunca visitada nesta página): troca a atual, nunca empilha
  const tres = preparar('#/crm');
  tres.nav.restore('#/crm/registro/y');
  assert.equal(tres.nav.current(), '#/crm/registro/y');
  assert.equal(tres.b.window.history.length, 1);

  // RECARREGAR a página: o history.state (numeração) fica na entrada, e a vizinha continua reconhecida
  const quatro = preparar('#/crm');
  quatro.nav.go('#/crm/registro/z');
  await quatro.b.flush();
  const janela = quatro.b.window; // a "mesma aba": o histórico e os estados ficam, o JavaScript da página recomeça
  const recarregada = browserNavigation(janela);
  const avisos = [];
  recarregada.subscribe(() => avisos.push(recarregada.current()));
  janela.history.back();
  await quatro.b.flush();
  assert.equal(recarregada.current(), '#/crm');
  recarregada.restore('#/crm/registro/z');
  await quatro.b.flush();
  assert.equal(recarregada.current(), '#/crm/registro/z', 'voltou à ficha depois de recarregar');
  assert.equal(janela.history.length, 2, 'e sem entradas novas');

  // o endereço aberto direto (sem entrada anterior no app) também não quebra
  const cinco = preparar('');
  cinco.nav.go('#/crm');
  await cinco.b.flush();
  cinco.nav.replace('#/crm/registro/w');
  assert.equal(cinco.nav.current(), '#/crm/registro/w');
  assert.equal(cinco.b.window.history.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PRIORIDADE 2 — a edição no drawer
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-ED-9] os 31 campos na edição, em abas (Resumo, Contato e presença, Comercial), cada um uma vez, com o valor do registro; obrigatório claro; status e data de entrada só para ler; trocar de aba não perde o digitado', async () => {
  const { WRITABLE_KEYS, FIELD_GROUPS } = await loadModel();
  const s = await abrir();
  await abrirEdicao(s);
  const g = gaveta(s);
  const controles = s.browser.findAll(g, (el) => ['input', 'textarea'].includes(el.localName) && el.getAttribute('name'));
  assert.deepEqual(controles.map((el) => el.getAttribute('name')).sort(), [...WRITABLE_KEYS].sort(), 'exatamente os 31 campos gravaveis, cada um uma vez');
  assert.equal(WRITABLE_KEYS.length, 31);
  const abas = s.browser.findAll(g, (el) => el.getAttribute('role') === 'tab' && /^crm-edit-tab-/.test(el.id));
  assert.deepEqual(abas.map((b) => b.textContent.trim()), ['Resumo', 'Contato e presença', 'Comercial']);
  const painelDe = (chave) => s.browser.by.id(g, `crm-edit-panel-${chave}`);
  const nomesDe = (chave) => s.browser.findAll(painelDe(chave), (el) => ['input', 'textarea'].includes(el.localName) && el.getAttribute('name')).map((el) => el.getAttribute('name'));
  assert.deepEqual(nomesDe('resumo'), ['empresa', 'nicho', 'cidade', 'estado', 'origem', 'responsavel', 'ultimaInteracao', 'proximaAcao', 'dataDaProximaAcao']);
  assert.deepEqual(nomesDe('contato'), ['contato', 'cargo', 'telefone', 'whatsapp', 'email', 'site', 'instagram', 'facebook', 'googlePerfil']);
  assert.equal(nomesDe('comercial').length, 13);

  assert.equal(rotulo(s, 'Empresa (obrigatório)').getAttribute('aria-required'), 'true', 'o obrigatório é dito no rótulo e para o leitor de tela');
  assert.equal(s.browser.findAll(g, (el) => el.localName === 'label' && /obrigatório/.test(el.textContent)).length, 1, 'só a empresa é obrigatória');
  assert.match(textoDaTela(s), /Os campos marcados como "\(obrigatório\)" precisam ser preenchidos\./);
  assert.match(textoDaTela(s), /nada é salvo automaticamente/);
  assert.equal(rotulo(s, 'Empresa (obrigatório)').value, 'Clínica Alfa');
  assert.equal(rotulo(s, 'Valor da proposta').value, '1500');
  assert.equal(rotulo(s, 'Data da próxima ação').value, '2026-10-05');
  assert.equal(s.browser.document.activeElement, rotulo(s, 'Empresa (obrigatório)'), 'o foco começa na empresa, na aba Resumo');
  assert.equal(painelDe('resumo').hidden, false);
  assert.equal(painelDe('contato').hidden, true);
  // os campos gerenciados pelo domínio só aparecem para ler
  assert.equal(s.browser.findAll(g, (el) => ['input', 'textarea', 'select'].includes(el.localName) && ['status', 'dataDeEntrada'].includes(el.getAttribute('name'))).length, 0);
  assert.match(painelDe('resumo').textContent, /Para mudar o status, use "Mudar status"\./);
  assert.match(painelDe('resumo').textContent, /Data de entrada.*12\/09\/2026/);

  digitar(s, 'Nome do contato', 'Contato digitado');
  await clicar(s, abas[2]);
  digitar(s, 'Observações', 'Texto longo\ncom duas linhas');
  await clicar(s, abas[0]);
  assert.equal(rotulo(s, 'Nome do contato').value, 'Contato digitado', 'trocar de aba não perde o digitado');
  assert.equal(rotulo(s, 'Observações').value, 'Texto longo\ncom duas linhas');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { contato: 'Contato digitado', observacoes: 'Texto longo\ncom duas linhas' }], 'só os campos alterados, de abas diferentes');
  const todos = FIELD_GROUPS.flatMap((grupo) => grupo.fields).length;
  assert.equal(todos, 33, 'sanidade: 31 gravaveis + 2 gerenciados');
});

test('[CRM-ED-10] VALIDAÇÃO antes de enviar: o erro aparece no campo, a aba com erro mostra quantos, o foco vai ao primeiro erro (abrindo a aba), NADA vai ao servidor e tudo o que foi digitado fica', async () => {
  const s = await abrir();
  await abrirEdicao(s);
  const abas = s.browser.findAll(gaveta(s), (el) => el.getAttribute('role') === 'tab' && /^crm-edit-tab-/.test(el.id));
  await clicar(s, abas[2]);
  digitar(s, 'Valor total', 'muito dinheiro');
  digitar(s, 'Valor da proposta', 'abc');
  await clicar(s, abas[1]);
  digitar(s, 'Nome do contato', 'Mantido na outra aba');
  await clicar(s, abas[0]);
  digitar(s, 'Empresa (obrigatório)', '   ');
  await clicar(s, botao(s, 'Salvar alterações'));

  assert.equal(conta(s, 'updateCrm'), 0, 'nada vai ao servidor');
  assert.match(textoDaTela(s), /Corrija os 3 campos destacados\. O que você digitou foi mantido\./);
  assert.equal(rotulo(s, 'Empresa (obrigatório)').getAttribute('aria-invalid'), 'true');
  assert.match(textoDaTela(s), /Informe o nome da empresa\./);
  assert.equal(s.browser.document.activeElement, rotulo(s, 'Empresa (obrigatório)'));
  assert.deepEqual(abas.map((b) => (s.browser.by.cls(b, 'tab-badge')[0] || { textContent: '' }).textContent), ['1', '', '2'], 'cada aba mostra quantos erros tem');
  assert.equal(rotulo(s, 'Nome do contato').value, 'Mantido na outra aba');
  assert.equal(rotulo(s, 'Valor total').value, 'muito dinheiro', 'o texto inválido continua lá para ser corrigido');

  // corrige só a empresa: o erro dela sai, os da aba Comercial continuam, e o foco vai à aba que ainda tem erro
  digitar(s, 'Empresa (obrigatório)', 'Clínica Alfa Ltda');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.equal(conta(s, 'updateCrm'), 0);
  assert.equal(rotulo(s, 'Empresa (obrigatório)').getAttribute('aria-invalid'), null);
  assert.equal(abas[2].getAttribute('aria-selected'), 'true', 'abriu a aba do primeiro erro restante');
  assert.equal(s.browser.document.activeElement, rotulo(s, 'Valor da proposta'));
  assert.deepEqual(abas.map((b) => (s.browser.by.cls(b, 'tab-badge')[0] || { textContent: '' }).textContent), ['', '', '2']);

  digitar(s, 'Valor total', '1234,5');
  digitar(s, 'Valor da proposta', '2000');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.equal(conta(s, 'updateCrm'), 1);
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { empresa: 'Clínica Alfa Ltda', contato: 'Mantido na outra aba', valorProposta: 2000, valorTotal: 1234.5 }]);
});

test('[CRM-ED-11] ESTADO DE SALVAMENTO e RESULTADO: "Alterações não salvas" some ao voltar ao valor original; salvando trava e mostra "Salvando…"; sucesso só depois da API, atualizando ficha e lista sem F5; erro (400/409/500/403) fica no painel com o digitado e o botão volta', async () => {
  const { ApiError } = await loadFixtures();
  const s = await abrir();
  await abrirEdicao(s);
  assert.equal(statusDeEdicao(s), '', 'sem alteração, sem aviso');
  digitar(s, 'Cidade', 'Teresópolis');
  assert.equal(statusDeEdicao(s), 'Alterações não salvas');
  digitar(s, 'Cidade', 'Petrópolis');
  assert.equal(statusDeEdicao(s), '', 'voltou ao valor original');
  digitar(s, 'Cidade', 'Teresópolis');

  for (const [erro, esperado] of [
    [new ApiError(400, 'INVALID_REQUEST', 'Valor inválido em um dos campos.'), /Valor inválido em um dos campos\./],
    [new ApiError(409, 'DUPLICATE_RECORD', 'dup'), /Já existe um registro com esta identidade/],
    [new ApiError(403, 'FORBIDDEN', 'x'), /Sua conta não tem permissão para esta ação\./],
    [new ApiError(500, 'INTERNAL', 'detalhe C:\\segredo'), /Não foi possível concluir a operação agora/],
  ]) {
    s.api.failNext('updateCrm', erro);
    await clicar(s, botao(s, 'Salvar alterações'));
    assert.match(textoDaTela(s), esperado);
    assert.doesNotMatch(textoDaTela(s), /segredo/);
    assert.doesNotMatch(textoDaTela(s), /Alterações salvas\./, 'erro nunca vira sucesso');
    assert.equal(rotulo(s, 'Cidade').value, 'Teresópolis', 'o digitado continua');
    assert.equal(botao(s, 'Salvar alterações').disabled, false, 'o botão volta');
    assert.equal(statusDeEdicao(s), 'Alterações não salvas');
    assert.ok(gaveta(s), 'a gaveta continua aberta, na edição');
  }
  assert.equal(s.api.store.items.find((i) => i.id === 'crm:a').cidade, 'Petrópolis', 'o servidor não mudou');

  const pendente = s.api.hold('updateCrm');
  s.browser.click(botao(s, 'Salvar alterações'));
  await pendente.arrived;
  assert.equal(statusDeEdicao(s), 'Salvando…');
  assert.equal(botao(s, 'Cancelar').disabled, true);
  assert.equal(s.api.store.items.find((i) => i.id === 'crm:a').cidade, 'Petrópolis');
  assert.match(s.browser.by.tag(s.root, 'tbody')[0].textContent, /Petrópolis/, 'a lista ainda mostra o valor antigo: nada foi dado como salvo antes da API');
  pendente.release();
  await s.browser.flush(10);
  assert.match(textoDaTela(s), /Alterações salvas\./);
  assert.equal(s.browser.by.cls(s.root, 'ficha-tabs')[0].hidden, false, 'voltou à leitura');
  assert.match(s.browser.by.id(gaveta(s), 'crm-ficha-panel-resumo').textContent, /Teresópolis/, 'a ficha mostra o salvo');
  assert.match(s.browser.by.tag(s.root, 'tbody')[0].textContent, /Teresópolis/, 'a lista também, sem F5');
  assert.equal(conta(s, 'listCrm'), 1, 'e sem recarregar a lista');
  assert.equal(s.eventos.filter((e) => e.source === 'crm').length, 1);
});

test('[CRM-ED-12] CANCELAR: sem alterações fecha direto; com alterações pergunta ("Continuar editando" mantém o texto, "Descartar alterações" volta à leitura); em nenhum caso vai nada ao servidor', async () => {
  const s = await abrir();
  await abrirEdicao(s);
  await clicar(s, botao(s, 'Cancelar'));
  assert.equal(confirmacao(s), null, 'sem alterações: sem pergunta');
  assert.equal(s.browser.by.cls(s.root, 'ficha-tabs')[0].hidden, false);

  await clicar(s, botao(s, 'Editar'));
  digitar(s, 'Cidade', 'Rascunho');
  await clicar(s, botao(s, 'Cancelar'));
  assert.ok(confirmacao(s));
  await clicar(s, noModal(s, 'Continuar editando'));
  assert.equal(rotulo(s, 'Cidade').value, 'Rascunho');
  await clicar(s, botao(s, 'Cancelar'));
  await clicar(s, noModal(s, 'Descartar alterações'));
  assert.equal(s.browser.by.cls(s.root, 'ficha-tabs')[0].hidden, false, 'voltou à leitura');
  assert.equal(conta(s, 'updateCrm'), 0);
  assert.match(s.browser.by.id(gaveta(s), 'crm-ficha-panel-resumo').textContent, /Petrópolis/);
  await clicar(s, botao(s, 'Editar'));
  assert.equal(rotulo(s, 'Cidade').value, 'Petrópolis', 'reabrir volta aos valores do registro');
});

test('[CRM-ED-13] NÃO há salvamento automático: digitar, esperar e perder o foco nunca chama a API; só o botão (ou Enter no formulário) salva, e o código não tem temporizador', async () => {
  const s = await abrir();
  await abrirEdicao(s);
  digitar(s, 'Cidade', 'Digitado');
  rotulo(s, 'Cidade').focus();
  rotulo(s, 'Nicho').focus();
  await s.browser.flush(40);
  assert.equal(conta(s, 'updateCrm'), 0);
  assert.equal(statusDeEdicao(s), 'Alterações não salvas');
  const fonte = read('dashboard', 'views', 'crm.mjs');
  assert.doesNotMatch(fonte.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'), /setTimeout|setInterval|debounce|autosave|autoSave/i);
  s.browser.submit(s.browser.by.tag(gaveta(s), 'form')[0]); // Enter num campo = salvar explícito
  await s.browser.flush(8);
  assert.equal(conta(s, 'updateCrm'), 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PRIORIDADE 3 — atualização segura
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-ED-14] EVENTOS e RESPOSTAS TARDIAS durante a edição nunca sobrescrevem o digitado: crm:changed, getCrm atrasado, lista atualizada; e se o registro for bloqueado por baixo, o rascunho fica (sem poder salvar)', async () => {
  const s = await abrir();
  await clicar(s, botao(s, 'Clínica Alfa'));
  const atrasada = s.api.hold('getCrm');
  s.bus.publish('crm:changed', { prospectId: 'id:x' });
  await atrasada.arrived;
  await clicar(s, botao(s, 'Editar'));
  digitar(s, 'Cidade', 'Meu rascunho');
  digitar(s, 'Nicho', 'Nicho digitado');
  const campo = rotulo(s, 'Cidade');
  s.api.store.items.find((i) => i.id === 'crm:a').cidade = 'Mudou por fora';
  atrasada.release(); // a resposta antiga/tardia chega com a edição aberta
  await s.browser.flush(10);
  assert.equal(rotulo(s, 'Cidade'), campo, 'o formulário não foi recriado');
  assert.equal(campo.value, 'Meu rascunho');
  assert.equal(rotulo(s, 'Nicho').value, 'Nicho digitado');

  s.bus.publish('crm:changed', { prospectId: 'id:y' });
  await s.browser.flush(10);
  assert.equal(campo.value, 'Meu rascunho');
  assert.match(s.browser.by.tag(s.root, 'tbody')[0].textContent, /Mudou por fora/, 'a lista, por baixo, mostra o dado novo');

  // por baixo, outra pessoa marca "Não contatar": o rascunho continua à vista, mas não dá mais para salvar
  s.api.store.items.find((i) => i.id === 'crm:a').status = 'DO_NOT_CONTACT';
  s.bus.publish('crm:changed', { prospectId: 'id:z' });
  await s.browser.flush(10);
  assert.equal(campo.value, 'Meu rascunho', 'o rascunho não sumiu');
  assert.equal(botao(s, 'Salvar alterações').disabled, true);
  assert.match(textoDaTela(s), /O que você digitou continua aqui, mas não pode ser salvo/);
  assert.equal(statusDeEdicao(s), 'Registro bloqueado: não pode ser salvo');
  assert.equal(conta(s, 'updateCrm'), 0);
  await clicar(s, botao(s, 'Cancelar'));
  await clicar(s, noModal(s, 'Descartar alterações'));
  assert.equal(botao(s, 'Editar'), null, 'agora sim: registro bloqueado, sem edição');
});

test('[CRM-ED-15] DUPLO ENVIO e OPERAÇÕES CONCORRENTES: clique duplo, Enter + clique e cliques nos outros botões durante o envio fazem UMA chamada; na edição só existem Salvar e Cancelar (as outras ações esperam)', async () => {
  const s = await abrir();
  await abrirEdicao(s);
  const rodape = s.browser.by.tag(s.browser.find(gaveta(s), (el) => el.localName === 'footer'), 'button').map((b) => b.textContent);
  assert.deepEqual(rodape, ['Salvar alterações', 'Cancelar'], 'durante a edição não há Mudar status / Não contatar / Excluir ao alcance');
  assert.equal(botao(s, 'Mudar status'), null);
  digitar(s, 'Cidade', 'Uma vez só');
  const pendente = s.api.hold('updateCrm');
  const salvar = botao(s, 'Salvar alterações');
  s.browser.click(salvar);
  await pendente.arrived;
  s.browser.click(salvar);
  s.browser.submit(s.browser.by.tag(gaveta(s), 'form')[0]);
  s.browser.click(botao(s, 'Salvando…'));
  await s.browser.flush(6);
  assert.equal(conta(s, 'updateCrm'), 1, 'uma única chamada');
  pendente.release();
  await s.browser.flush(10);
  assert.equal(conta(s, 'updateCrm'), 1);
  assert.deepEqual(s.browser.by.tag(s.browser.find(gaveta(s), (el) => el.localName === 'footer'), 'button').map((b) => b.textContent), ['Editar', 'Mudar status', 'Marcar como Não contatar'], 'as ações voltam depois de salvar');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PRIORIDADE 4 — permissões e compatibilidade
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-ED-16] PERMISSÕES: sem WRITE:CRM não existe Editar nem formulário (closer, só-excluir); registro bloqueado não abre edição; a tela nunca monta identidade nem campos fora do modelo', async () => {
  for (const permissions of [CLOSER, SO_EXCLUIR]) {
    const s = await abrir({ permissions });
    await clicar(s, botao(s, 'Clínica Alfa'));
    assert.equal(botao(s, 'Editar'), null);
    assert.equal(s.browser.by.tag(gaveta(s), 'form').length, 0);
    assert.equal(s.win.listenerCount('beforeunload'), 0);
  }
  const { crmRecord } = await loadFixtures();
  const bloqueado = await abrir({ items: [crmRecord({ id: 'crm:dnc', empresa: 'Bloqueada', status: 'DO_NOT_CONTACT' })] });
  await clicar(bloqueado, botao(bloqueado, 'Bloqueada'));
  assert.equal(botao(bloqueado, 'Editar'), null);

  const s = await abrir();
  await abrirEdicao(s);
  digitar(s, 'Cidade', 'X');
  await clicar(s, botao(s, 'Salvar alterações'));
  const texto = JSON.stringify(s.api.callsOf('updateCrm').map((c) => c.args));
  for (const proibido of ['userId', 'authUserId', 'role', 'permissions', 'actor', 'reviewedBy']) assert.ok(!texto.includes(proibido), proibido);
});

test('[CRM-ED-17] COMPATIBILIDADE com registros existentes: um registro com TODOS os campos preenchidos (texto, datas, dinheiro, multilinha), com campos nulos ou com chaves a mais abre a edição sem estar "alterado", não envia nada sem mexer e envia só o mexido', async () => {
  const { EDITABLE_FIELDS } = await loadModel();
  const { crmRecord } = await loadFixtures();
  const cheio = crmRecord({ id: 'crm:cheio', empresa: 'Registro Completo' });
  for (const campo of EDITABLE_FIELDS) {
    cheio[campo.key] = campo.kind === 'number' ? 1234.5 : campo.kind === 'date' ? '2026-10-05' : campo.kind === 'email' ? 'cheio@example.test' : campo.kind === 'tel' ? '24 90000-1234' : campo.kind === 'url' ? `https://cheio.example.test/${campo.key}` : campo.kind === 'textarea' ? 'linha 1\nlinha 2' : `valor ${campo.key}`;
  }
  cheio.empresa = 'Registro Completo';
  cheio.campoDesconhecido = 'vindo de uma versão futura';
  cheio.authUserId = 'nao-deve-aparecer';
  const vazio = crmRecord({ id: 'crm:vazio', empresa: 'Registro Mínimo' });
  const s = await abrir({ items: [cheio, vazio] });
  for (const [empresa, id] of [['Registro Completo', 'crm:cheio'], ['Registro Mínimo', 'crm:vazio']]) {
    await clicar(s, botao(s, empresa));
    await clicar(s, botao(s, 'Editar'));
    assert.equal(statusDeEdicao(s), '', `${id}: abrir a edição não conta como alteração`);
    assert.equal(s.win.fireBeforeUnload().prevented, false);
    await clicar(s, botao(s, 'Salvar alterações'));
    assert.match(textoDaTela(s), /Nenhuma alteração para salvar\./);
    assert.equal(conta(s, 'updateCrm'), 0, `${id}: nada enviado sem alteração`);
    await clicar(s, botao(s, 'Cancelar'));
    assert.equal(confirmacao(s), null);
    await teclar(s, 'Escape');
    assert.equal(gaveta(s), null);
  }
  assert.doesNotMatch(textoDaTela(s), /nao-deve-aparecer|campoDesconhecido/);
  await clicar(s, botao(s, 'Registro Completo'));
  await clicar(s, botao(s, 'Editar'));
  assert.equal(rotulo(s, 'Observações').value, 'linha 1\nlinha 2', 'multilinha preservada');
  assert.equal(rotulo(s, 'Valor total').value, '1234.5');
  digitar(s, 'Telefone', '');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:cheio', { telefone: null }], 'só o campo esvaziado, como null');
});

test('[CRM-ED-18] o código não promete o que a API não dá: nenhum texto de "conflito resolvido" ou de versão; o aviso real é só o que é verdade (só o alterado é enviado, nada é automático)', async () => {
  const fonte = read('dashboard', 'views', 'crm.mjs');
  const semComentarios = fonte.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(semComentarios, /conflito|sincroniz|versão do registro|outra pessoa não/i);
  assert.match(fonte, /não tem versionamento/i, 'o limite está registrado no código');
});

test('[CRM-ED-19] ESTÁTICO: o CSS traz o rodapé de edição, o estado "não salvo" e as abas de campos (inclusive em telas pequenas); nenhum estilo inline; o shell pergunta antes de sair do CRM com edição', async () => {
  const css = read('dashboard', 'styles.css');
  assert.match(css, /\.edit-footer\s*\{/);
  assert.match(css, /\.edit-status\.dirty\s*\{[^}]*font-weight/);
  assert.match(css, /\.field-form-tabs \.tab-panels/);
  assert.match(css, /@media \(max-width: 560px\)\s*\{[\s\S]*\.edit-footer \.btn/);
  const fonte = read('dashboard', 'views', 'crm.mjs').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(fonte, /setAttribute\('style'|\.style\./);
  const main = read('dashboard', 'main.mjs');
  assert.match(main, /crmView\.leaveState\(\)/);
  assert.match(main, /crmView\.confirmLeave\(/);
  assert.match(main, /navigation\.restore\(renderedHash\)/);
  const router = read('dashboard', 'router.mjs');
  assert.match(router, /restore\(hash\)/);
  assert.match(router, /guards\.add\(fn\)/, 'vários guardas de saída');
});
