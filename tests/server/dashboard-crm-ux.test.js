// CRM na UX 4.0.6 (mesmo padrão da Fila de Aprovação e do Histórico): a lista PERSISTENTE (busca, filtros, ordem, página e rolagem sobrevivem a abrir a ficha e a trocar de módulo),
// a FICHA numa gaveta com URL e abas (somente leitura), a atualização por EVENTOS (crm:changed) e pelo botão Atualizar — sem polling — e as ações de escrita de sempre
// (editar, mudar status, não contatar, excluir) ainda acessíveis dentro da gaveta. DOM de teste e API falsa: nenhum navegador, nenhuma rede, nenhum registro real.
// As regras de dados, permissões e escritas continuam cobertas por dashboard-crm-view.test.js, dashboard-fullstack.test.js e crm-api.test.js.

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
const css = read('dashboard', 'styles.css');

const ADMIN = Object.freeze({ canReadCrm: true, canWriteCrm: true, canDeleteCrm: false, canReview: true });
const ADMIN_DELETE = Object.freeze({ canReadCrm: true, canWriteCrm: true, canDeleteCrm: true, canReview: true });
const CLOSER = Object.freeze({ canReadCrm: true, canWriteCrm: false, canDeleteCrm: false, canReview: true });
const SO_EXCLUIR = Object.freeze({ canReadCrm: true, canWriteCrm: false, canDeleteCrm: true, canReview: true });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function registros() {
  const { crmRecord } = await loadFixtures();
  return [
    crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', contato: 'Maria Souza', nicho: 'Psicologia', cidade: 'Petrópolis', estado: 'RJ', status: 'CONTACTED', servicoPotencial: 'Gestão de tráfego', responsavel: 'Rafael', proximaAcao: 'Ligar na segunda', dataDaProximaAcao: '2026-10-05', valorProposta: 1500, telefone: '(24) 90000-0001', email: 'contato@alfa.example.test', site: 'alfa.example.test', dataDeEntrada: '2026-09-12T10:00:00.000Z' }),
    crmRecord({ id: 'crm:b', empresa: 'Odonto Beta', contato: 'João Pereira', nicho: 'Odontologia', cidade: 'Niterói', status: 'WON', responsavel: 'Breno', dataDeEntrada: '2026-09-14T10:00:00.000Z' }),
    crmRecord({ id: 'crm:c', empresa: 'Ótica Gama', nicho: 'psicologia', cidade: 'São Paulo', status: 'PROSPECT', valorProposta: 3000, dataDaProximaAcao: '2026-10-01', dataDeEntrada: '2026-09-13T10:00:00.000Z' }),
    crmRecord({ id: 'crm:d', empresa: 'Zeta Estética', nicho: 'Estética', cidade: 'Teresópolis', status: 'NEGOTIATION', valorProposta: 900, responsavel: 'Rafael', dataDeEntrada: '2026-09-10T10:00:00.000Z' }),
  ];
}

async function apiFalsa(items) {
  const { createFakeApi, ApiError } = await loadFixtures();
  const api = createFakeApi({ items: items || (await registros()) });
  api.deleteCrm = async (id, reason) => {
    api.calls.push({ name: 'deleteCrm', args: [id, reason] });
    const at = api.store.items.findIndex((item) => item.id === id);
    if (at < 0) throw new ApiError(404, 'NOT_FOUND', 'Item não encontrado.');
    api.store.items.splice(at, 1);
    return { deleted: true, id };
  };
  return api;
}

// Monta a tela como o painel faz: ui + barramento + (opcionalmente) a navegação real por # sobre o window de teste.
async function abrir({ items, permissions = ADMIN, comNavegacao = false, hash = '', pageSize, api: dada, semUi = false } = {}) {
  const { createCrmView } = await loadView();
  const { createDataBus, createUi } = await loadUi();
  const { browserNavigation, parseRoute } = await loadRouter();
  const browser = createBrowser({ hash });
  const api = dada || (await apiFalsa(items));
  const bus = createDataBus();
  const eventos = [];
  bus.subscribe('crm:changed', (p) => eventos.push(p));
  const destinos = [];
  const navigation = comNavegacao ? browserNavigation(browser.window) : null;
  let ui = null;
  let viewRoot = browser.root;
  if (!semUi) {
    const host = browser.document.createElement('div');
    host.className = 'overlay-host';
    viewRoot = browser.document.createElement('div');
    browser.root.append(viewRoot, host);
    ui = createUi({ document: browser.document, host, getInertTargets: () => [viewRoot] });
  }
  const view = createCrmView({ document: browser.document, root: viewRoot, api, permissions, navigate: (alvo) => destinos.push(alvo), bus, navigation, ...(ui ? { ui } : {}), ...(pageSize ? { pageSize } : {}) });
  if (navigation) navigation.subscribe(() => view.show(parseRoute(navigation.current())));
  const s = { browser, view, api, bus, eventos, destinos, navigation, ui, root: browser.root };
  await view.show(comNavegacao ? parseRoute(navigation.current()) : { name: 'crm-list' });
  await browser.flush();
  return s;
}

const gaveta = (s) => s.browser.find(s.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const escopo = (s) => gaveta(s) || s.root;
const botao = (s, nome) => s.browser.by.button(s.root, nome);
const nomes = (s) => s.browser.findAll(s.root, (el) => el.localName === 'tr' && el.getAttribute('data-record')).map((tr) => tr.children[0].textContent.trim());
const linha = (s, id) => s.browser.find(s.root, (el) => el.localName === 'tr' && el.getAttribute('data-record') === id);
const celula = (s, id, rotulo) => s.browser.find(linha(s, id), (el) => el.localName === 'td' && el.getAttribute('data-label') === rotulo);
const clicar = async (s, el) => { s.browser.click(el); await s.browser.flush(6); };
const teclar = async (s, tecla) => { s.browser.press(tecla); await s.browser.flush(6); };
const titulo = (s) => s.browser.by.cls(s.root, 'overlay-title')[0].textContent;
const contagem = (s) => s.browser.by.cls(s.root, 'crm-count')[0].textContent;
const conta = (s, nome) => s.api.callsOf(nome).length;
const aba = async (s, chave) => { await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('data-tab') === chave)); };
const painelDaAba = (s, chave) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tabpanel' && el.id === `crm-ficha-panel-${chave}`);
const abaSelecionada = (s) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true').getAttribute('data-tab');
const textoDaTela = (s) => s.root.textContent.replace(/\s+/g, ' ');
const rotulos = (s, el) => s.browser.by.tag(el, 'dt').map((dt) => dt.textContent.trim());

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A LISTA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-UX-1] a lista no padrão da Fila de Aprovação: cabeçalho, busca, filtros de status/nicho/responsável, ordenação, Atualizar e Novo registro; linhas "queue-row" com o nome da empresa como botão; só LÊ ao abrir', async () => {
  const s = await abrir();
  assert.equal(s.browser.by.tag(s.root, 'h2')[0].textContent, 'Clientes');
  assert.match(textoDaTela(s), /Os registros comerciais\. Clique em uma linha para abrir a ficha sem sair da lista\./);
  for (const rotulo of ['Buscar', 'Status', 'Nicho', 'Responsável', 'Ordenar por']) assert.ok(s.browser.by.label(s.root, rotulo), `campo "${rotulo}"`);
  assert.ok(botao(s, 'Atualizar'));
  assert.ok(botao(s, 'Limpar filtros'));
  assert.equal(s.browser.by.link(s.root, 'Novo registro').href, '#/crm/novo');
  assert.deepEqual(s.browser.by.tag(s.root, 'th').map((th) => th.textContent), ['Empresa', 'Contato', 'Nicho', 'Cidade', 'Status', 'Serviço potencial', 'Responsável', 'Próxima ação', 'Valor da proposta']);
  assert.match(linha(s, 'crm:a').className, /\bqueue-row\b/);
  assert.match(s.browser.by.tag(s.root, 'table')[0].className, /\bqueue\b/);
  assert.equal(botao(s, 'Clínica Alfa').getAttribute('data-item'), 'crm:a');
  assert.deepEqual(s.api.calls.map((c) => c.name), ['listCrm'], 'abrir a tela só LÊ a lista: nenhuma escrita, nenhum registro individual');
  assert.equal(gaveta(s), null);
  assert.equal(contagem(s), '4 registros');
});

test('[CRM-UX-2] ORDENAÇÃO só por critérios que existem nos dados: mais recentes/antigos, empresa, status (ordem do funil), próxima ação e maior valor — quem não tem o dado vai para o fim', async () => {
  const { SORT_OPTIONS } = await loadModel();
  const s = await abrir();
  const sorter = s.browser.by.label(s.root, 'Ordenar por');
  assert.deepEqual(s.browser.by.tag(sorter, 'option').map((o) => o.textContent), SORT_OPTIONS.map((o) => o.label));
  assert.equal(sorter.value, 'recentes');
  assert.deepEqual(nomes(s), ['Odonto Beta', 'Ótica Gama', 'Clínica Alfa', 'Zeta Estética'], 'o padrão de sempre: do mais recente');
  const ordem = async (valor) => { s.browser.choose(sorter, valor); return nomes(s); };
  assert.deepEqual(await ordem('antigos'), ['Zeta Estética', 'Clínica Alfa', 'Ótica Gama', 'Odonto Beta']);
  assert.deepEqual(await ordem('empresa'), ['Clínica Alfa', 'Odonto Beta', 'Ótica Gama', 'Zeta Estética']);
  assert.deepEqual(await ordem('status'), ['Ótica Gama', 'Clínica Alfa', 'Zeta Estética', 'Odonto Beta'], 'Lead em Prospecção, Contatado, Em Negociação, Fechada');
  assert.deepEqual(await ordem('proxima'), ['Ótica Gama', 'Clínica Alfa', 'Odonto Beta', 'Zeta Estética'], 'a data mais próxima primeiro; sem data, no fim (por empresa)');
  assert.deepEqual(await ordem('valor'), ['Ótica Gama', 'Clínica Alfa', 'Zeta Estética', 'Odonto Beta'], 'maior valor primeiro; sem valor, no fim');
  assert.equal(conta(s, 'listCrm'), 1, 'ordenar é do navegador: nenhuma chamada nova');

  // "Limpar filtros" restaura busca e filtros, mas a ordem escolhida é uma preferência e fica
  s.browser.type(s.browser.by.label(s.root, 'Buscar'), 'zeta');
  assert.deepEqual(nomes(s), ['Zeta Estética']);
  await clicar(s, botao(s, 'Limpar filtros'));
  assert.equal(nomes(s).length, 4);
  assert.equal(sorter.value, 'valor');
});

test('[CRM-UX-3] sortRecordsBy é puro e seguro (uma ordem desconhecida cai na padrão, valores inválidos vão para o fim) e as ABAS da ficha cobrem cada campo existente exatamente uma vez', async () => {
  const { sortRecordsBy, RECORD_TABS, FIELD_GROUPS } = await loadModel();
  const itens = [{ empresa: 'B', valorProposta: 'abc', dataDeEntrada: '2026-01-02' }, { empresa: 'A', valorProposta: 10, dataDeEntrada: '2026-01-01' }, { empresa: 'C', valorProposta: null, dataDeEntrada: '2026-01-03' }];
  const copia = JSON.stringify(itens);
  assert.deepEqual(sortRecordsBy(itens, 'valor').map((i) => i.empresa), ['A', 'B', 'C'], 'texto e null no fim, em ordem de empresa');
  assert.deepEqual(sortRecordsBy(itens, 'qualquer-coisa').map((i) => i.empresa), ['C', 'B', 'A'], 'ordem desconhecida = mais recentes');
  assert.deepEqual(sortRecordsBy(itens).map((i) => i.empresa), ['C', 'B', 'A']);
  assert.equal(JSON.stringify(itens), copia, 'a lista original não é alterada');

  const todos = FIELD_GROUPS.flatMap((grupo) => grupo.fields.map((campo) => campo.key));
  const usados = RECORD_TABS.flatMap((tab) => tab.sections.flatMap((secao) => secao.keys));
  assert.deepEqual([...usados].sort(), [...todos].sort(), 'cada campo existente aparece em uma aba — nenhum inventado, nenhum esquecido');
  assert.equal(new Set(usados).size, usados.length, 'e nenhum aparece duas vezes');
  assert.deepEqual(RECORD_TABS.map((tab) => tab.label), ['Resumo', 'Contato e presença', 'Comercial', 'Histórico']);
});

test('[CRM-UX-4] PAGINAÇÃO no navegador (o contrato da API continua uma lista só): pageSize, Anterior/Próxima, e busca/filtro/ordem/página sobrevivem a abrir e fechar a ficha', async () => {
  const { crmRecord } = await loadFixtures();
  const muitos = Array.from({ length: 45 }, (_, i) => crmRecord({ id: `crm:p${i}`, empresa: `Empresa ${String(i).padStart(2, '0')}`, nicho: i % 2 ? 'Odontologia' : 'Psicologia', dataDeEntrada: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z` }));
  const s = await abrir({ items: muitos, pageSize: 10 });
  assert.equal(nomes(s).length, 10);
  assert.match(textoDaTela(s), /Página 1 de 5 · 1–10 de 45/);
  await clicar(s, botao(s, 'Próxima'));
  await clicar(s, botao(s, 'Próxima'));
  assert.match(textoDaTela(s), /Página 3 de 5 · 21–30 de 45/);
  s.browser.choose(s.browser.by.label(s.root, 'Ordenar por'), 'empresa');
  assert.match(textoDaTela(s), /Página 1 de 5/, 'mudar a ordem volta à primeira página');
  await clicar(s, botao(s, 'Próxima'));
  const antes = nomes(s);
  assert.equal(antes[0], 'Empresa 10');

  await clicar(s, botao(s, antes[2]));
  assert.ok(gaveta(s));
  await teclar(s, 'Escape');
  assert.equal(gaveta(s), null);
  assert.deepEqual(nomes(s), antes, 'a mesma página, a mesma ordem');
  assert.match(textoDaTela(s), /Página 2 de 5/);
  assert.equal(s.browser.by.label(s.root, 'Ordenar por').value, 'empresa');
  assert.equal(conta(s, 'listCrm'), 1, 'abrir e fechar a ficha não recarrega a lista');

  s.browser.choose(s.browser.by.label(s.root, 'Nicho'), 'Odontologia');
  assert.equal(contagem(s), '22 de 45 registros');
  assert.match(textoDaTela(s), /Página 1 de 3/, 'filtrar volta à primeira página');
});

test('[CRM-UX-5] a linha INTEIRA é clicável (mouse, Enter e Espaço), sem parecer link; cliques rápidos abrem UMA gaveta e UM carregamento; a linha aberta fica marcada', async () => {
  const s = await abrir();
  assert.doesNotMatch(botao(s, 'Clínica Alfa').className, /link-button/);
  await clicar(s, celula(s, 'crm:b', 'Status'));
  assert.ok(gaveta(s), 'clicar em qualquer célula da linha abre');
  assert.equal(titulo(s), 'Odonto Beta');
  assert.match(linha(s, 'crm:b').className, /\bselected\b/, 'a linha aberta fica marcada');
  await teclar(s, 'Escape');
  const b = botao(s, 'Clínica Alfa');
  b.focus();
  await teclar(s, 'Enter');
  assert.equal(titulo(s), 'Clínica Alfa', 'Enter abre');
  await teclar(s, 'Escape');
  assert.equal(s.browser.document.activeElement === botao(s, 'Clínica Alfa'), true);
  await teclar(s, ' ');
  assert.ok(gaveta(s), 'Espaço abre');
  await teclar(s, 'Escape');

  const g = botao(s, 'Ótica Gama');
  s.browser.click(g);
  s.browser.click(celula(s, 'crm:c', 'Cidade'));
  s.browser.click(g);
  await s.browser.flush(8);
  assert.equal(s.browser.findAll(s.root, (el) => el.getAttribute('role') === 'dialog').length, 1, 'uma gaveta só');
  assert.equal(s.api.callsOf('getCrm').filter((c) => c.args[0] === 'crm:c').length, 1, 'e um carregamento só do registro clicado');
});

test('[CRM-UX-6] estados da lista: carregando (esqueleto), vazio (com o caminho para criar, só para quem pode), erro com nova tentativa e "sem resultado" com o botão que limpa', async () => {
  const { ApiError } = await loadFixtures();
  const api = await apiFalsa();
  const pendente = api.hold('listCrm');
  const { createCrmView } = await loadView();
  const browser = createBrowser();
  const view = createCrmView({ document: browser.document, root: browser.root, api, permissions: ADMIN, navigate() {} });
  view.show({ name: 'crm-list' });
  await pendente.arrived;
  assert.ok(browser.by.cls(browser.root, 'skeleton').length >= 1, 'esqueleto enquanto carrega');
  assert.match(browser.root.textContent, /Carregando registros…/);
  pendente.release();
  await browser.flush();
  assert.equal(browser.by.cls(browser.root, 'skeleton').length, 0);

  const vazio = await abrir({ items: [] });
  assert.ok(vazio.browser.by.id(vazio.root, 'crm-empty'), 'estado vazio próprio');
  assert.match(textoDaTela(vazio), /Nenhum registro no CRM ainda\./);
  assert.equal(vazio.browser.by.link(vazio.root, 'Criar o primeiro registro').href, '#/crm/novo');
  const vazioCloser = await abrir({ items: [], permissions: CLOSER });
  assert.equal(vazioCloser.browser.by.link(vazioCloser.root, 'Criar o primeiro registro'), null);

  const comErro = await apiFalsa();
  comErro.failNext('listCrm', new ApiError(500, 'INTERNAL', 'segredo C:\\interno'));
  const e = await abrir({ api: comErro });
  assert.match(textoDaTela(e), /Não foi possível concluir a operação agora/);
  assert.doesNotMatch(textoDaTela(e), /segredo|interno/);
  await clicar(e, botao(e, 'Tentar novamente'));
  assert.equal(nomes(e).length, 4);

  e.browser.type(e.browser.by.label(e.root, 'Buscar'), 'zzzz');
  assert.match(textoDaTela(e), /Nenhum registro encontrado/);
  await clicar(e, botao(e, 'Limpar busca e filtros'));
  assert.equal(nomes(e).length, 4);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A GAVETA (ficha somente leitura, em abas)
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-UX-7] a ficha abre numa GAVETA por cima da lista (a lista continua por baixo), com selo de status, quatro abas (Resumo, Contato e presença, Comercial, Histórico) e cada campo na aba certa', async () => {
  const { FIELD_GROUPS } = await loadModel();
  const s = await abrir();
  await clicar(s, botao(s, 'Clínica Alfa'));
  const g = gaveta(s);
  assert.equal(titulo(s), 'Clínica Alfa');
  assert.equal(s.browser.by.cls(g, 'ficha-head')[0].textContent, 'Contatado', 'o selo do status');
  assert.equal(s.browser.by.tag(s.root, 'table').length, 1, 'a lista continua na página, por baixo');
  assert.equal(s.browser.by.tag(s.root, 'tbody')[0].children.length, 4);
  assert.deepEqual(s.browser.by.tag(g, 'button').filter((b) => b.getAttribute('role') === 'tab').map((b) => b.textContent), ['Resumo', 'Contato e presença', 'Comercial', 'Histórico']);
  assert.equal(abaSelecionada(s), 'resumo');
  assert.equal(s.browser.by.tag(g, 'form').length, 0, 'somente leitura: nenhum formulário aberto');

  assert.deepEqual(rotulos(s, painelDaAba(s, 'resumo')), ['Empresa', 'Nicho', 'Cidade', 'Estado (UF)', 'Origem do Lead', 'Status', 'Data de entrada', 'Responsável', 'Última interação', 'Próxima ação', 'Data da próxima ação']);
  assert.deepEqual(rotulos(s, painelDaAba(s, 'contato')), ['Nome do contato', 'Cargo', 'Telefone', 'WhatsApp', 'E-mail', 'Site', 'Instagram', 'Facebook', 'Perfil no Google']);
  assert.deepEqual(rotulos(s, painelDaAba(s, 'comercial')), ['Serviço potencial', 'Temperatura', 'Problema identificado', 'Raio-X de nicho', 'Raio-X personalizado', 'Status do diagnóstico', 'Link do Raio-X', 'Data da análise', 'Valor da proposta', 'Valor total', 'Observações', 'Data da reunião', 'Link do Google Meet']);
  const todos = FIELD_GROUPS.flatMap((grupo) => grupo.fields.map((campo) => campo.label));
  assert.deepEqual(s.browser.by.tag(g, 'dt').map((dt) => dt.textContent.trim()).sort(), [...todos].sort(), 'só campos que existem, todos');
  const valor = (chave, rotulo) => { const dt = s.browser.find(painelDaAba(s, chave), (e) => e.localName === 'dt' && e.textContent.trim() === rotulo); return dt.parentNode.children[dt.parentNode.children.indexOf(dt) + 1].textContent; };
  assert.equal(valor('resumo', 'Cidade'), 'Petrópolis');
  assert.equal(valor('resumo', 'Origem do Lead'), '—', 'campo vazio vira "—" (nunca um valor inventado)');
  assert.equal(valor('contato', 'Telefone'), '(24) 90000-0001');
  assert.equal(valor('contato', 'Site'), 'alfa.example.test');
  assert.equal(valor('comercial', 'Valor da proposta').replace(/\u00a0/g, ' '), 'R$ 1.500,00');
  assert.equal(s.browser.by.tag(g, 'a').filter((a) => a.getAttribute('target') === '_blank').map((a) => a.href)[0], 'https://alfa.example.test/');
});

test('[CRM-UX-8] ABAS acessíveis: tablist/tab/tabpanel, só a ativa está no foco do teclado, setas/Home/End trocam de aba, cada ficha começa no Resumo e a aba Histórico mostra a linha do tempo', async () => {
  const s = await abrir();
  await clicar(s, botao(s, 'Clínica Alfa'));
  const lista = s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'tablist');
  assert.ok(lista.getAttribute('aria-label'));
  const abas = s.browser.by.tag(lista, 'button');
  assert.deepEqual(abas.map((b) => b.getAttribute('tabindex')), ['0', '-1', '-1', '-1']);
  for (const b of abas) assert.equal(s.browser.by.id(s.root, b.getAttribute('aria-controls')).getAttribute('aria-labelledby'), b.id);
  abas[0].focus();
  await teclar(s, 'ArrowRight');
  assert.equal(abaSelecionada(s), 'contato');
  assert.equal(s.browser.document.activeElement.getAttribute('data-tab'), 'contato');
  await teclar(s, 'End');
  assert.equal(abaSelecionada(s), 'historico');
  assert.equal(painelDaAba(s, 'resumo').hidden, true, 'a aba inativa fica escondida');
  assert.match(painelDaAba(s, 'historico').textContent, /Registro criado como Lead em Prospecção/);
  await teclar(s, 'Home');
  assert.equal(abaSelecionada(s), 'resumo');
  await aba(s, 'comercial');
  await teclar(s, 'Escape');
  await clicar(s, botao(s, 'Odonto Beta'));
  assert.equal(abaSelecionada(s), 'resumo', 'outra ficha começa no Resumo');
});

test('[CRM-UX-9] dados hostis nunca viram HTML na gaveta, e nada além dos campos do modelo aparece (authUserId, token, permissions...)', async () => {
  const { crmRecord } = await loadFixtures();
  const hostil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const registro = crmRecord({ id: 'crm:xss', empresa: hostil, observacoes: hostil, site: 'javascript:alert(1)', instagram: 'https://insta.example.test/x' });
  registro.authUserId = 'auth-vazado';
  registro.token = 'token-vazado';
  registro.permissions = ['WRITE:CRM'];
  const s = await abrir({ items: [registro] });
  await clicar(s, s.browser.find(s.root, (el) => el.localName === 'button' && el.getAttribute('data-item') === 'crm:xss'));
  const texto = textoDaTela(s);
  assert.ok(texto.includes(hostil));
  for (const proibida of ['img', 'script', 'iframe']) assert.equal(s.browser.by.tag(s.root, proibida).length, 0);
  for (const p of ['auth-vazado', 'token-vazado', 'WRITE:CRM']) assert.ok(!texto.includes(p));
  const links = s.browser.by.tag(gaveta(s), 'a');
  for (const a of links) assert.doesNotMatch(a.href || '', /^javascript:/i);
  assert.deepEqual(links.filter((a) => a.getAttribute('target') === '_blank').map((a) => a.getAttribute('rel')), ['noopener noreferrer']);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// NAVEGAÇÃO: URL, ESC, X, Voltar, Avançar, link direto, foco
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-UX-10] URL: abrir muda o endereço para #/crm/registro/<id>; ESC e X fecham; Voltar fecha SEM sair do módulo e Avançar reabre; busca e página da lista ficam; o foco volta à linha', async () => {
  const s = await abrir({ comNavegacao: true, hash: '#/crm' });
  const win = s.browser.window;
  s.browser.type(s.browser.by.label(s.root, 'Buscar'), 'a');
  await clicar(s, botao(s, 'Clínica Alfa'));
  assert.equal(win.location.hash, `#/crm/registro/${encodeURIComponent('crm:a')}`);
  assert.equal(win.history.length, 2);
  assert.equal(titulo(s), 'Clínica Alfa');

  win.history.back();
  await s.browser.flush(6);
  assert.equal(win.location.hash, '#/crm', 'o Voltar fica no módulo');
  assert.equal(gaveta(s), null, 'e fecha a gaveta');
  assert.equal(conta(s, 'listCrm'), 1, 'sem recarregar a lista');
  assert.equal(s.browser.by.label(s.root, 'Buscar').value, 'a', 'a busca ficou');
  win.history.forward();
  await s.browser.flush(6);
  assert.ok(gaveta(s), 'o Avançar reabre a mesma ficha');
  assert.equal(titulo(s), 'Clínica Alfa');

  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  assert.equal(win.location.hash, '#/crm', 'o X volta à lista');
  assert.equal(win.history.length, 2, 'fechar não cria entrada nova');
  assert.equal(s.browser.document.activeElement === botao(s, 'Clínica Alfa'), true, 'o foco voltou à linha');

  await clicar(s, botao(s, 'Odonto Beta'));
  await teclar(s, 'Escape');
  assert.equal(win.location.hash, '#/crm', 'ESC também volta à lista');
  assert.equal(gaveta(s), null);
  assert.equal(s.browser.document.activeElement === botao(s, 'Odonto Beta'), true);
});

test('[CRM-UX-11] LINK DIRETO: abre a ficha com a lista carregada por baixo (uma carga de cada); fechar troca a entrada; id inexistente mostra "Registro não encontrado." na gaveta; trocar o endereço com a gaveta aberta troca de registro', async () => {
  const direto = await abrir({ comNavegacao: true, hash: `#/crm/registro/${encodeURIComponent('crm:c')}` });
  assert.ok(gaveta(direto), 'o link direto abriu a gaveta');
  assert.equal(titulo(direto), 'Ótica Gama');
  assert.equal(conta(direto, 'listCrm'), 1, 'a lista é carregada por baixo, uma vez');
  assert.equal(conta(direto, 'getCrm'), 1);
  assert.equal(conta(direto, 'getCrmHistory'), 1);
  assert.equal(nomes(direto).length, 4, 'e aparece atrás da ficha');
  await teclar(direto, 'Escape');
  assert.equal(direto.browser.window.location.hash, '#/crm');
  assert.equal(direto.browser.window.history.length, 1, 'sem entrada anterior no app: a entrada é trocada');

  const trocar = await abrir({ comNavegacao: true, hash: '#/crm' });
  await clicar(trocar, botao(trocar, 'Clínica Alfa'));
  trocar.browser.window.location.hash = `#/crm/registro/${encodeURIComponent('crm:d')}`;
  await trocar.browser.flush(8);
  assert.equal(titulo(trocar), 'Zeta Estética');
  assert.equal(trocar.browser.findAll(trocar.root, (el) => el.getAttribute('role') === 'dialog').length, 1);

  const inexistente = await abrir({ comNavegacao: true, hash: `#/crm/registro/${encodeURIComponent('crm:nao-existe')}` });
  assert.ok(gaveta(inexistente));
  assert.match(textoDaTela(inexistente), /Registro não encontrado\./);
  assert.equal(inexistente.browser.by.button(gaveta(inexistente), 'Editar'), null, 'sem registro, sem ações');
  await clicar(inexistente, inexistente.browser.find(gaveta(inexistente), (el) => el.getAttribute('data-action') === 'close'));
  assert.equal(gaveta(inexistente), null);
  assert.equal(inexistente.browser.window.location.hash, '#/crm');
});

test('[CRM-UX-12] o endereço do registro é o mesmo de sempre (Fila de Aprovação, Visão Geral e Funis continuam apontando para ele) e ids com caracteres especiais fazem ida e volta', async () => {
  const { buildHash, parseRoute } = await loadRouter();
  for (const id of ['crm:a', 'crm:3f2a-9b', 'crm:com espaço/barra', 'crm:ç?#']) {
    const hash = buildHash({ name: 'crm-record', id });
    assert.equal(hash, `#/crm/registro/${encodeURIComponent(id)}`);
    assert.deepEqual(parseRoute(hash), { name: 'crm-record', id });
  }
  for (const arquivo of ['approvals.mjs', 'overview.mjs', 'funnels.mjs']) {
    assert.match(read('dashboard', 'views', arquivo), /name: 'crm-record'/, `${arquivo} continua apontando para a ficha do CRM`);
  }
  assert.equal(parseRoute('#/crm').name, 'crm-list');
  assert.equal(parseRoute('#/crm/novo').name, 'crm-new');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// CONTEXTO: a tela é persistente
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-UX-13] PERSISTENTE: ao sair do módulo a gaveta fecha (sem navegar) e a lista guarda busca, filtro, ordem, página e ROLAGEM; ao voltar, já aparece pronta e se atualiza em silêncio', async () => {
  const { crmRecord } = await loadFixtures();
  const muitos = Array.from({ length: 30 }, (_, i) => crmRecord({ id: `crm:q${i}`, empresa: `Empresa ${String(i).padStart(2, '0')}`, nicho: 'Psicologia', dataDeEntrada: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z` }));
  const s = await abrir({ items: muitos, pageSize: 10, comNavegacao: true, hash: '#/crm' });
  const rolagem = { scrollTop: 0 };
  s.browser.document.scrollingElement = rolagem;
  s.browser.type(s.browser.by.label(s.root, 'Buscar'), 'empresa');
  s.browser.choose(s.browser.by.label(s.root, 'Ordenar por'), 'empresa');
  await clicar(s, botao(s, 'Próxima'));
  rolagem.scrollTop = 480;
  await clicar(s, botao(s, 'Empresa 12'));
  const hashDaFicha = s.browser.window.location.hash;
  assert.ok(gaveta(s));

  s.view.hide(); // o shell trocou de módulo
  assert.equal(gaveta(s), null, 'a gaveta fechou');
  assert.equal(s.browser.window.location.hash, hashDaFicha, 'sem mexer no endereço: ele já é o do outro módulo');
  rolagem.scrollTop = 0; // a outra tela começa no topo
  const antes = conta(s, 'listCrm');

  await s.view.show({ name: 'crm-list' });
  assert.equal(s.browser.by.cls(s.root, 'skeleton').length, 0, 'volta já pronta: nada de "carregando"');
  assert.equal(nomes(s)[0], 'Empresa 10', 'mesma página e ordem');
  assert.equal(s.browser.by.label(s.root, 'Buscar').value, 'empresa');
  assert.equal(s.browser.by.label(s.root, 'Ordenar por').value, 'empresa');
  assert.equal(rolagem.scrollTop, 480, 'a rolagem voltou');
  await s.browser.flush(6);
  assert.equal(conta(s, 'listCrm'), antes + 1, 'uma atualização silenciosa ao voltar');
  assert.equal(nomes(s)[0], 'Empresa 10');
});

test('[CRM-UX-14] abrir "Novo registro" e voltar também preserva o contexto da lista (a página de criação não esconde campos repetidos da lista)', async () => {
  const s = await abrir();
  s.browser.type(s.browser.by.label(s.root, 'Buscar'), 'alfa');
  s.browser.choose(s.browser.by.label(s.root, 'Status'), 'CONTACTED');
  await s.view.show({ name: 'crm-new' });
  await s.browser.flush();
  assert.equal(s.browser.by.label(s.root, 'Nicho').getAttribute('name'), 'nicho', 'na página de novo registro o único "Nicho" é o do formulário');
  assert.equal(s.browser.by.tag(s.root, 'table').length, 0);
  await s.view.show({ name: 'crm-list' });
  await s.browser.flush();
  assert.equal(s.browser.by.label(s.root, 'Buscar').value, 'alfa');
  assert.equal(s.browser.by.label(s.root, 'Status').value, 'CONTACTED');
  assert.deepEqual(nomes(s), ['Clínica Alfa']);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// EVENTOS: crm:changed e Atualizar — sem polling
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-UX-15] EVENTO crm:changed de outra tela (ex.: promoção na Fila de Aprovação): a lista se atualiza em silêncio, com a gaveta aberta a ficha acompanha, e o botão Atualizar faz o mesmo à mão', async () => {
  const { crmRecord } = await loadFixtures();
  const s = await abrir();
  assert.equal(nomes(s).length, 4);
  s.api.store.items.push(crmRecord({ id: 'crm:novo', empresa: 'Promovida da Fila', dataDeEntrada: '2026-09-30T10:00:00.000Z' }));
  s.bus.publish('crm:changed', { prospectId: 'id:x', crmRecordId: 'crm:novo' });
  await s.browser.flush(8);
  assert.equal(conta(s, 'listCrm'), 2);
  assert.equal(nomes(s)[0], 'Promovida da Fila', 'o registro promovido já está na lista');
  assert.equal(contagem(s), '5 registros');
  assert.equal(s.browser.by.cls(s.root, 'skeleton').length, 0, 'sem piscar "carregando"');

  await clicar(s, botao(s, 'Clínica Alfa'));
  s.api.store.items.find((i) => i.id === 'crm:a').cidade = 'Teresópolis';
  s.bus.publish('crm:changed', { prospectId: 'id:y' });
  await s.browser.flush(8);
  const resumo = painelDaAba(s, 'resumo').textContent;
  assert.match(resumo, /Teresópolis/, 'a ficha aberta (só leitura) acompanha o que mudou');
  assert.equal(conta(s, 'getCrm'), 2);
  await teclar(s, 'Escape');

  s.api.store.items = s.api.store.items.filter((i) => i.id !== 'crm:novo');
  await clicar(s, botao(s, 'Atualizar'));
  assert.equal(nomes(s).includes('Promovida da Fila'), false, 'Atualizar traz o que mudou');
});

test('[CRM-UX-16] o evento NÃO sobrescreve um formulário em uso: com a edição aberta, a lista atualiza mas a ficha não é recarregada nem redesenhada e o que foi digitado fica', async () => {
  const s = await abrir();
  await clicar(s, botao(s, 'Clínica Alfa'));
  await clicar(s, botao(s, 'Editar'));
  const campo = s.browser.by.label(gaveta(s), 'Cidade');
  s.browser.type(campo, 'Digitando…');
  s.api.store.items.find((i) => i.id === 'crm:a').cidade = 'Outra pessoa mudou';
  const getAntes = conta(s, 'getCrm');
  s.bus.publish('crm:changed', { prospectId: 'id:z' });
  await s.browser.flush(8);
  assert.equal(s.browser.by.label(gaveta(s), 'Cidade'), campo, 'o mesmo campo, não recriado');
  assert.equal(campo.value, 'Digitando…', 'o que foi digitado ficou');
  assert.equal(conta(s, 'getCrm'), getAntes, 'a ficha em edição não é recarregada');
  assert.equal(conta(s, 'listCrm'), 2, 'a lista, por baixo, se atualizou');
  assert.match(celula(s, 'crm:a', 'Cidade').textContent, /Outra pessoa mudou/, 'a lista mostra o dado novo');

  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { cidade: 'Digitando…' }]);
});

test('[CRM-UX-17] fora de cena, o evento só marca a lista como desatualizada (nenhuma chamada); ao voltar ela se atualiza. Quem escreve publica crm:changed e NÃO dispara uma recarga à toa; destroy() solta a assinatura', async () => {
  const s = await abrir();
  s.view.hide();
  s.bus.publish('crm:changed', { prospectId: 'id:x' });
  await s.browser.flush(6);
  assert.equal(conta(s, 'listCrm'), 1, 'escondida: nenhuma chamada');
  await s.view.show({ name: 'crm-list' });
  await s.browser.flush(6);
  assert.equal(conta(s, 'listCrm'), 2);

  await clicar(s, botao(s, 'Clínica Alfa'));
  await clicar(s, botao(s, 'Editar'));
  s.browser.type(s.browser.by.label(gaveta(s), 'Cidade'), 'Nova');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.eventos.filter((e) => e.source === 'crm').map((e) => [e.source, e.action, e.id]), [['crm', 'update', 'crm:a']], 'a escrita avisa as outras telas');
  assert.equal(conta(s, 'listCrm'), 2, 'o próprio aviso não recarrega a lista');
  assert.match(celula(s, 'crm:a', 'Cidade').textContent, /Nova/, 'a lista já mostra o salvo, sem F5');

  await clicar(s, botao(s, 'Mudar status'));
  s.browser.choose(s.browser.by.label(gaveta(s), 'Novo status'), 'PROPOSAL');
  await clicar(s, botao(s, 'Confirmar mudança'));
  assert.equal(s.eventos.at(-1).action, 'status');
  assert.equal(celula(s, 'crm:a', 'Status').textContent, 'Proposta Enviada', 'o selo da lista acompanha');

  assert.equal(s.bus.listenerCount('crm:changed'), 2, 'a tela e o espião do teste');
  s.view.destroy();
  assert.equal(s.bus.listenerCount('crm:changed'), 1, 'destroy() soltou a assinatura');
});

test('[CRM-UX-18] SEM POLLING: a tela não usa temporizador nenhum para atualizar (nem setInterval, nem acompanhador), e ficar parada na lista ou com a gaveta aberta não faz nenhuma chamada', async () => {
  const fonte = read('dashboard', 'views', 'crm.mjs');
  assert.doesNotMatch(fonte, /setInterval|createPoller|setTimeout|requestAnimationFrame/, 'nenhum agendamento na tela do CRM');
  const original = globalThis.setInterval;
  let intervalos = 0;
  globalThis.setInterval = (...args) => { intervalos += 1; return original(...args); };
  try {
    const s = await abrir({ comNavegacao: true, hash: '#/crm' });
    await clicar(s, botao(s, 'Clínica Alfa'));
    await aba(s, 'historico');
    await s.browser.flush(30);
    assert.equal(s.api.calls.length, 3, 'só as três leituras da abertura: lista, ficha e histórico');
    assert.equal(intervalos, 0);
  } finally {
    globalThis.setInterval = original;
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// OPERAÇÕES ATUAIS: continuam acessíveis (agora dentro da gaveta), com as mesmas permissões
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CRM-UX-19] as ações de escrita continuam ACESSÍVEIS na gaveta, no rodapé fixo, conforme a permissão: ADMIN (editar, mudar status, não contatar), ADMIN com DELETE (+ excluir), só-excluir, closer (nenhuma, com o aviso) e registro bloqueado (só excluir, se puder)', async () => {
  const rodape = (s) => s.browser.by.tag(s.browser.find(gaveta(s), (el) => el.localName === 'footer'), 'button').map((b) => b.textContent);
  const admin = await abrir();
  await clicar(admin, botao(admin, 'Clínica Alfa'));
  assert.deepEqual(rodape(admin), ['Editar', 'Mudar status', 'Marcar como Não Contatar']);
  assert.equal(admin.browser.find(gaveta(admin), (el) => el.localName === 'footer').hidden, false);

  const completo = await abrir({ permissions: ADMIN_DELETE });
  await clicar(completo, botao(completo, 'Clínica Alfa'));
  assert.deepEqual(rodape(completo), ['Editar', 'Mudar status', 'Marcar como Não Contatar', 'Excluir registro']);

  const soExcluir = await abrir({ permissions: SO_EXCLUIR });
  await clicar(soExcluir, botao(soExcluir, 'Clínica Alfa'));
  assert.deepEqual(rodape(soExcluir), ['Excluir registro']);

  const closer = await abrir({ permissions: CLOSER });
  await clicar(closer, botao(closer, 'Clínica Alfa'));
  assert.equal(closer.browser.find(gaveta(closer), (el) => el.localName === 'footer').hidden, true, 'sem botões, sem rodapé');
  assert.match(textoDaTela(closer), /Seu perfil pode consultar o CRM, mas não pode criar nem alterar registros\./);
  assert.equal(closer.browser.by.link(closer.root, 'Novo registro'), null);

  const { crmRecord } = await loadFixtures();
  const bloqueado = await abrir({ items: [crmRecord({ id: 'crm:dnc', empresa: 'Bloqueada', status: 'DO_NOT_CONTACT' })], permissions: ADMIN_DELETE });
  await clicar(bloqueado, botao(bloqueado, 'Bloqueada'));
  assert.deepEqual(rodape(bloqueado), ['Excluir registro'], 'DNC é terminal: sem editar nem mudar status, mas excluir continua possível');
  assert.match(textoDaTela(bloqueado), /bloqueado como "Não Contatar"/);
  const bloqueadoSemExcluir = await abrir({ items: [crmRecord({ id: 'crm:dnc', empresa: 'Bloqueada', status: 'DO_NOT_CONTACT' })], permissions: ADMIN });
  await clicar(bloqueadoSemExcluir, botao(bloqueadoSemExcluir, 'Bloqueada'));
  assert.equal(bloqueadoSemExcluir.browser.find(gaveta(bloqueadoSemExcluir), (el) => el.localName === 'footer').hidden, true);
});

test('[CRM-UX-20] EDITAR dentro da gaveta: o formulário ocupa a gaveta (as abas saem da frente), salvar atualiza a ficha E a lista sem F5 e as abas voltam; nada de recarregar a página', async () => {
  const s = await abrir();
  await clicar(s, botao(s, 'Clínica Alfa'));
  await aba(s, 'comercial');
  await clicar(s, botao(s, 'Editar'));
  assert.equal(s.browser.by.cls(s.root, 'ficha-tabs')[0].hidden, true);
  assert.equal(s.browser.document.activeElement, s.browser.by.label(gaveta(s), 'Empresa (obrigatório)'));
  s.browser.type(s.browser.by.label(gaveta(s), 'Cidade'), 'Teresópolis');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.match(textoDaTela(s), /Alterações salvas\./);
  assert.equal(s.browser.by.cls(s.root, 'ficha-tabs')[0].hidden, false, 'as abas voltaram');
  assert.equal(abaSelecionada(s), 'comercial', 'na aba em que a pessoa estava');
  assert.match(painelDaAba(s, 'resumo').textContent, /Teresópolis/);
  assert.match(celula(s, 'crm:a', 'Cidade').textContent, /Teresópolis/, 'a lista, por baixo, já mostra');
  assert.equal(conta(s, 'listCrm'), 1, 'sem recarregar a lista');
  assert.equal(titulo(s), 'Clínica Alfa');
});

test('[CRM-UX-21] PROTEÇÃO do que foi digitado: com alterações na edição, ESC/X perguntam antes de descartar; sem alterações fecham direto; durante um envio a gaveta não fecha', async () => {
  const s = await abrir();
  await clicar(s, botao(s, 'Clínica Alfa'));
  await clicar(s, botao(s, 'Editar'));
  await teclar(s, 'Escape');
  assert.equal(gaveta(s), null, 'edição aberta mas SEM alterações: fecha direto');

  await clicar(s, botao(s, 'Clínica Alfa'));
  await clicar(s, botao(s, 'Editar'));
  s.browser.type(s.browser.by.label(gaveta(s), 'Cidade'), 'Rascunho');
  await teclar(s, 'Escape');
  assert.ok(gaveta(s), 'com alterações a gaveta NÃO fecha sozinha');
  assert.ok(confirmacao(s), 'e pergunta antes de descartar');
  assert.match(confirmacao(s).textContent, /Descartar alterações\?/);
  await clicar(s, s.browser.by.button(confirmacao(s), 'Continuar editando'));
  assert.equal(s.browser.by.label(gaveta(s), 'Cidade').value, 'Rascunho', 'continua editando, com o texto');
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close'));
  await clicar(s, s.browser.by.button(confirmacao(s), 'Descartar alterações'));
  assert.equal(gaveta(s), null);
  assert.equal(conta(s, 'updateCrm'), 0, 'descartar não grava nada');

  // durante um envio, ESC não fecha a gaveta no meio da operação
  await clicar(s, botao(s, 'Clínica Alfa'));
  await clicar(s, botao(s, 'Editar'));
  s.browser.type(s.browser.by.label(gaveta(s), 'Cidade'), 'Enviando');
  const pendente = s.api.hold('updateCrm');
  s.browser.click(botao(s, 'Salvar alterações'));
  await pendente.arrived;
  await teclar(s, 'Escape');
  assert.ok(gaveta(s), 'ocupada: não fecha');
  pendente.release();
  await s.browser.flush(8);
  assert.match(textoDaTela(s), /Alterações salvas\./);
  await teclar(s, 'Escape');
  assert.equal(gaveta(s), null, 'terminou: fecha normalmente');
});

test('[CRM-UX-22] EXCLUIR dentro da gaveta (só com DELETE:CRM): exige motivo e confirmação, envia o motivo, tira a linha da lista, fecha a gaveta e volta ao endereço da lista sem deixar a ficha excluída no histórico', async () => {
  const s = await abrir({ permissions: ADMIN_DELETE, comNavegacao: true, hash: '#/crm' });
  await clicar(s, botao(s, 'Odonto Beta'));
  await clicar(s, botao(s, 'Excluir registro'));
  assert.match(textoDaTela(s), /Esta ação removerá permanentemente este registro do CRM\./);
  await clicar(s, botao(s, 'Excluir permanentemente'));
  assert.match(textoDaTela(s), /Informe o motivo da exclusão\./);
  s.browser.type(s.browser.by.label(gaveta(s), 'Motivo da exclusão (obrigatório)'), 'Cadastro duplicado');
  await clicar(s, botao(s, 'Excluir permanentemente'));
  assert.match(textoDaTela(s), /Confirme que você entende que esta ação é irreversível\./);
  assert.equal(conta(s, 'deleteCrm'), 0, 'sem a confirmação nada é enviado');
  s.browser.check(s.browser.by.label(gaveta(s), 'Entendo que esta ação é irreversível.'));
  await clicar(s, botao(s, 'Excluir permanentemente'));

  assert.deepEqual(s.api.callsOf('deleteCrm')[0].args, ['crm:b', 'Cadastro duplicado']);
  assert.equal(gaveta(s), null, 'a ficha excluída não fica aberta');
  assert.equal(s.browser.window.location.hash, '#/crm');
  assert.equal(nomes(s).includes('Odonto Beta'), false, 'a linha saiu da lista');
  assert.equal(contagem(s), '3 registros');
  assert.match(textoDaTela(s), /Registro excluído\./);
  assert.deepEqual(s.eventos.map((e) => [e.action, e.id]), [['delete', 'crm:b']]);
  s.browser.window.history.back();
  await s.browser.flush(6);
  assert.ok(!/odonto beta/i.test(s.browser.by.cls(s.root, 'overlay-title').map((e) => e.textContent).join('|')), 'voltar não reabre o registro excluído');

  const semPermissao = await abrir({ permissions: ADMIN });
  await clicar(semPermissao, botao(semPermissao, 'Odonto Beta'));
  assert.equal(botao(semPermissao, 'Excluir registro'), null);
});

test('[CRM-UX-23] MUDAR STATUS e NÃO CONTATAR continuam como antes na gaveta: o servidor decide; a lista e o selo acompanham sem F5; DNC deixa o registro bloqueado e a linha com o novo status', async () => {
  const s = await abrir();
  await clicar(s, botao(s, 'Clínica Alfa'));
  await clicar(s, botao(s, 'Marcar como Não Contatar'));
  s.browser.check(s.browser.by.label(gaveta(s), 'Entendo que esta ação é terminal e não pode ser desfeita.'));
  await clicar(s, botao(s, 'Confirmar: marcar como Não Contatar'));
  assert.equal(conta(s, 'markCrmDnc'), 1);
  assert.equal(celula(s, 'crm:a', 'Status').textContent, 'Não Contatar');
  assert.match(textoDaTela(s), /Registro marcado como "Não Contatar"\. Ele agora está bloqueado\./);
  assert.equal(botao(s, 'Editar'), null);
  assert.equal(botao(s, 'Mudar status'), null);
  assert.equal(s.eventos.at(-1).action, 'dnc');
  const historico = painelDaAba(s, 'historico').textContent;
  assert.match(historico, /Contatado → Não Contatar/);
});

test('[CRM-UX-24] ESTÁTICO: a tela não usa innerHTML/eval/fetch/localStorage nem estilo inline, o CSS traz a gaveta, as abas e os cartões em telas pequenas, e o shell chama show/hide do CRM', async () => {
  const semComentarios = (texto) => texto.split('\n').map((linha) => linha.replace(/\s\/\/.*$/, '')).filter((linha) => !/^\s*\/\//.test(linha)).join('\n');
  const fonte = semComentarios(read('dashboard', 'views', 'crm.mjs')); // só o código, sem os comentários
  assert.doesNotMatch(fonte, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|\bfetch\(|localStorage|sessionStorage|document\.write/);
  assert.doesNotMatch(fonte, /setAttribute\('style'|\.style\./, 'sem estilo inline (CSP)');
  assert.match(css, /\.crm-ficha\s*\{/);
  assert.match(css, /\.crm-view \[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /table\.crm-table td\.empty/);
  assert.match(css, /@media \(max-width: 760px\)|@media \(max-width: 900px\)/);
  assert.match(css, /table\.queue td::before \{[^}]*attr\(data-label\)/, 'em telas pequenas a linha vira cartão rotulado');
  const main = read('dashboard', 'main.mjs');
  assert.match(main, /createCrmView\(\{[^}]*ui, bus, navigation[^}]*\}\)/);
  assert.match(main, /crmView\.hide\(\)/);
  assert.match(main, /crmView\.show\(route\)/);
});
