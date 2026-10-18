// O MENU LATERAL dentro do PAINEL inteiro (CRM 5.0, Fase 2A): o texto "CRM" abre o Dashboard Comercial (EM DESENVOLVIMENTO), as rotas antigas continuam levando às mesmas telas, as páginas
// futuras não têm dado nem ação, recolher/expandir e a preferência, o menu do celular, as permissões e a PROTEÇÃO de rascunhos ao trocar de item do menu. DOM de teste, SDK falso e fetch
// roteado — nenhuma credencial real, nenhuma rede, nenhum registro real.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const me = (role, name) => ({ userId: `user-${name.toLowerCase()}`, name, role, permissions: [...authConstants.getRolePermissions(role)], status: 'ACTIVE' });
const ME_ADMIN = me('ADMIN', 'Breno');
const ME_CLOSER = me('COMMERCIAL_CLOSER', 'Rafael');

async function iniciar({ perfil = ME_ADMIN, hash = '', preferences, viewport, extras = {} } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, scriptedFetch, FAKE_SESSION, crmRecord } = await loadFixtures();
  const itens = [
    crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', status: 'CONTACTED', nicho: 'Psicologia', dataDeEntrada: '2026-09-12T10:00:00.000Z' }),
    crmRecord({ id: 'crm:b', empresa: 'Odonto Beta', status: 'WON', nicho: 'Odontologia', dataDeEntrada: '2026-09-14T10:00:00.000Z' }),
  ];
  const aprovacoes = [{ prospectId: 'id:x', empresa: 'Lead X', estado: 'AGUARDANDO_REVISAO', discoverySnapshot: { cidade: 'Petrópolis', estadoUf: 'RJ', nicho: 'Psicologia' } }, { prospectId: 'id:y', empresa: 'Lead Y', estado: 'AGUARDANDO_REVISAO', discoverySnapshot: { cidade: 'Niterói', estadoUf: 'RJ', nicho: 'Estética' } }];
  const routes = {
    'GET /api/me': perfil,
    'GET /api/crm': { items: itens },
    'GET /api/crm/crm%3Aa': { item: itens[0] },
    'GET /api/crm/crm%3Aa/history': { historico: itens[0].historico },
    'GET /api/approvals': { estado: 'AGUARDANDO_REVISAO', items: aprovacoes },
    ...extras,
  };
  const browser = createBrowser({ hash });
  const sdk = createFakeSdk({ session: FAKE_SESSION });
  const fetchImpl = scriptedFetch({ 'GET /config.json': CONFIG, ...routes });
  const navigation = browserNavigation(browser.window);
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation, ...(preferences ? { preferences } : {}), ...(viewport ? { viewport } : {}) });
  await browser.flush(8);
  return { browser, fetchImpl, navigation, win: browser.window };
}

const texto = (t) => t.browser.root.textContent.replace(/\s+/g, ' ');
const nav = (t) => t.browser.by.tag(t.browser.root, 'nav')[0];
const links = (t) => t.browser.by.tag(nav(t), 'a');
const marcados = (t) => links(t).filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent);
const chamadas = (t) => t.fetchImpl.calls.filter((c) => c.path.startsWith('/api/')).map((c) => `${c.method} ${c.path}`);
// botões só com ícone têm o NOME no aria-label (o texto visível fica vazio)
const porRotulo = (t, rotulo) => t.browser.find(t.browser.root, (el) => el.localName === 'button' && el.getAttribute('aria-label') === rotulo);
const ir = async (t, hash) => {
  t.win.location.hash = hash;
  await t.browser.flush(10);
};
const clicar = async (t, el) => {
  t.browser.click(el);
  await t.browser.flush(10);
};
const gaveta = (t) => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'dialog' && /drawer/.test(el.className));
const pergunta = (t) => t.browser.find(t.browser.root, (el) => el.getAttribute('role') === 'alertdialog');
const memoria = () => {
  const dados = new Map();
  const gravacoes = [];
  return { dados, gravacoes, getItem: (k) => (dados.has(k) ? dados.get(k) : null), setItem: (k, v) => { gravacoes.push([k, v]); dados.set(k, String(v)); } };
};
const viewportFalso = (mobile) => {
  const ouvintes = new Set();
  return { mobile, isMobile() { return this.mobile; }, subscribe(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); }, mudar(v) { this.mobile = v; for (const fn of [...ouvintes]) fn(); } };
};

test('[MENU-1] clicar no TEXTO "CRM" abre o Dashboard Comercial — a tela REAL (Fase D1), que só LÊ os indicadores (uma chamada GET) e não simula número nenhum; a seta só expande o submenu', async () => {
  const t = await iniciar();
  const crm = t.browser.by.link(nav(t), 'CRM');
  assert.equal(crm.href, '#/crm/dashboard');
  const base = chamadas(t); // o que a Visão Geral (a tela inicial) já carregou
  const seta = porRotulo(t, 'Expandir CRM');
  assert.ok(seta, 'a seta é um botão à parte');
  const antes = t.win.location.hash;
  await clicar(t, seta);
  assert.equal(t.win.location.hash, antes, 'a seta não navega');
  assert.equal(porRotulo(t, 'Recolher CRM').getAttribute('aria-expanded'), 'true');

  await clicar(t, crm);
  assert.equal(t.win.location.hash, '#/crm/dashboard');
  assert.deepEqual(marcados(t), ['Dashboard Comercial']);
  assert.equal(t.browser.document.title, 'Dashboard Comercial — Rio X7 AI Agency OS');
  assert.equal(t.browser.by.tag(t.browser.root, 'h2')[0].textContent, 'Dashboard Comercial');
  assert.doesNotMatch(texto(t), /EM DESENVOLVIMENTO/, 'o Dashboard Comercial existe');
  assert.equal(t.browser.by.tag(t.browser.root, 'form').length, 0);
  assert.equal(t.browser.by.cls(t.browser.root, 'kpi').length, 0, 'nenhum indicador simulado');
  assert.deepEqual(chamadas(t), [...base, 'GET /api/negotiations/summary'], 'uma única leitura, só GET');
});

test('[MENU-2] COMPATIBILIDADE: #/crm (a rota antiga) e #/crm/clientes mostram a MESMA lista de registros e acendem "Clientes"; nada foi remapeado em silêncio para o Dashboard', async () => {
  for (const hash of ['#/crm', '#/crm/clientes']) {
    const t = await iniciar({ hash });
    assert.equal(t.win.location.hash, hash, 'o endereço NÃO foi trocado');
    assert.deepEqual(marcados(t), ['Clientes'], hash);
    assert.equal(t.browser.by.tag(t.browser.root, 'h2')[0].textContent, 'Clientes');
    assert.match(texto(t), /Odonto Beta/);
    assert.match(texto(t), /Clínica Alfa/);
    assert.doesNotMatch(texto(t), /EM DESENVOLVIMENTO/);
    assert.equal(t.browser.document.title, 'Clientes · CRM — Rio X7 AI Agency OS');
    assert.equal(t.browser.by.tag(t.browser.root, 'table').length, 1);
  }
});

test('[MENU-3] os LINKS ANTIGOS seguem funcionando: a ficha #/crm/registro/<id> (usada pela Fila de Aprovação, Visão Geral e Funis) abre o painel lateral por cima da lista e acende "Clientes"; fechar volta ao endereço da lista pelo qual a pessoa chegou; Voltar/Avançar funcionam', async () => {
  const t = await iniciar({ hash: '#/crm/clientes' });
  await clicar(t, t.browser.by.button(t.browser.root, 'Clínica Alfa'));
  assert.equal(t.win.location.hash, '#/crm/registro/crm%3Aa');
  assert.ok(gaveta(t));
  assert.deepEqual(marcados(t), ['Clientes']);
  t.win.history.back();
  await t.browser.flush(10);
  assert.equal(t.win.location.hash, '#/crm/clientes');
  assert.equal(gaveta(t), null, 'Voltar fecha o painel');
  t.win.history.forward();
  await t.browser.flush(10);
  assert.ok(gaveta(t), 'Avançar reabre');
  t.browser.press('Escape');
  await t.browser.flush(10);
  assert.equal(gaveta(t), null, 'ESC fecha o painel lateral');
  assert.equal(t.win.location.hash, '#/crm/clientes');

  // link direto de fora (como o "Ver no CRM" da Fila de Aprovação)
  const direto = await iniciar({ hash: '#/crm/registro/crm%3Aa' });
  assert.ok(gaveta(direto));
  assert.deepEqual(marcados(direto), ['Clientes']);
  assert.equal(direto.browser.document.title, 'Registro · CRM — Rio X7 AI Agency OS');
  const fechar = direto.browser.find(gaveta(direto), (el) => el.getAttribute('data-action') === 'close');
  await clicar(direto, fechar);
  assert.equal(direto.win.location.hash, '#/crm', 'sem lista anterior, volta à rota antiga da lista (a mesma tela)');
  assert.match(texto(direto), /Odonto Beta/);
});

test('[MENU-4] as PÁGINAS FUTURAS (metas; o Dashboard Comercial e a Gestão de Funis e Etapas são telas reais — Fase D1; Configurações do CRM, Serviços, Nichos e Origens já são telas reais — ver dashboard-crm-settings.test.js) dizem EM DESENVOLVIMENTO e não têm dado, formulário nem botão de ação; cada uma acende a sua entrada e abre o ramo; nenhuma chama a API', async () => {
  const paginas = [
    ['#/crm/metas', 'Metas e Indicadores', 'Metas e Indicadores · CRM'],
  ];
  for (const [hash, nome, titulo] of paginas) {
    const t = await iniciar({ hash });
    assert.equal(t.browser.by.tag(t.browser.root, 'h2')[0].textContent, nome, hash);
    assert.match(texto(t), /EM DESENVOLVIMENTO/, hash);
    assert.deepEqual(marcados(t), [nome], `${hash}: acende só a sua entrada`);
    assert.equal(t.browser.document.title, `${titulo} — Rio X7 AI Agency OS`);
    const principal = t.browser.by.id(t.browser.root, 'main');
    assert.equal(t.browser.by.tag(principal, 'form').length, 0, hash);
    assert.equal(t.browser.by.tag(principal, 'table').length, 0, hash);
    assert.equal(t.browser.by.tag(principal, 'input').length, 0, hash);
    assert.equal(t.browser.by.tag(principal, 'button').length, 0, `${hash}: nenhum botão de ação (só links de navegação)`);
    assert.deepEqual(chamadas(t), ['GET /api/me'], hash);
    // o ramo do CRM abre sozinho para mostrar onde a pessoa está
    assert.equal(porRotulo(t, 'Recolher CRM') !== null, true, `${hash}: o ramo CRM está aberto`);
  }
});

test('[MENU-5] RECOLHER e EXPANDIR no painel: o botão muda o estado; a preferência é lembrada numa próxima visita; o conteúdo ganha o espaço; e só a chave do menu é guardada', async () => {
  const prefs = memoria();
  const { createVisualPreferences } = await import('../../dashboard/preferences.mjs');
  const t = await iniciar({ preferences: createVisualPreferences({ localStorage: prefs }) });
  const shell = t.browser.by.cls(t.browser.root, 'shell')[0];
  assert.equal(shell.getAttribute('data-sidebar'), 'expanded');
  await clicar(t, porRotulo(t, 'Recolher menu'));
  assert.equal(shell.getAttribute('data-sidebar'), 'collapsed');
  assert.deepEqual(prefs.gravacoes, [['riox7.sidebar.collapsed', '1']]);

  const proxima = await iniciar({ preferences: createVisualPreferences({ localStorage: prefs }) });
  assert.equal(proxima.browser.by.cls(proxima.browser.root, 'shell')[0].getAttribute('data-sidebar'), 'collapsed', 'a próxima visita já abre recolhida');
  await clicar(proxima, porRotulo(proxima, 'Expandir menu'));
  assert.equal(prefs.dados.get('riox7.sidebar.collapsed'), '0');

  // armazenamento que falha: o painel inteiro continua funcionando
  const quebrado = await iniciar({ preferences: createVisualPreferences({ get localStorage() { throw new Error('bloqueado'); } }) });
  await clicar(quebrado, porRotulo(quebrado, 'Recolher menu'));
  assert.equal(quebrado.browser.by.cls(quebrado.browser.root, 'shell')[0].getAttribute('data-sidebar'), 'collapsed');
  await clicar(quebrado, quebrado.browser.by.link(quebrado.browser.root, 'Visão Geral'));
  assert.match(texto(quebrado), /Visão Geral/);
  assert.equal(prefs.gravacoes.every(([k, v]) => k === 'riox7.sidebar.collapsed' && (v === '1' || v === '0')), true);
});

test('[MENU-6] MENU DO CELULAR no painel: abre e fecha pelo botão do topo sem ocupar a tela; ESC fecha; escolher um destino fecha; com o painel lateral de um registro aberto o ESC é do painel', async () => {
  const vp = viewportFalso(true);
  const t = await iniciar({ viewport: vp });
  const shell = t.browser.by.cls(t.browser.root, 'shell')[0];
  const lateral = t.browser.by.tag(t.browser.root, 'aside')[0];
  assert.equal(lateral.hasAttribute('inert'), true, 'fechado');
  await clicar(t, porRotulo(t, 'Abrir menu'));
  assert.equal(shell.getAttribute('data-nav-open'), 'true');
  assert.equal(lateral.hasAttribute('inert'), false);
  t.browser.press('Escape');
  assert.equal(shell.getAttribute('data-nav-open'), 'false');

  await clicar(t, porRotulo(t, 'Abrir menu'));
  await clicar(t, t.browser.by.link(nav(t), 'CRM'));
  assert.equal(t.win.location.hash, '#/crm/dashboard');
  assert.equal(shell.getAttribute('data-nav-open'), 'false', 'escolher um destino fecha o menu');

  // um painel lateral aberto: o ESC fecha o painel (o menu já está fechado e nada muda por baixo)
  await ir(t, '#/crm/registro/crm%3Aa');
  assert.ok(gaveta(t));
  t.browser.press('Escape');
  await t.browser.flush(10);
  assert.equal(gaveta(t), null);
  assert.equal(shell.getAttribute('data-nav-open'), 'false');
  assert.equal(t.browser.document.listenerCount('keydown'), 0, 'nenhum ouvinte de teclado sobrou');
});

test('[MENU-7] PERMISSÕES no painel: o vendedor vê o CRM, a fila e os reprovados, mas não "Nova Prospecção", "Histórico" nem "Exclusões Permanentes"; uma conta sem READ:CRM não vê o CRM, e o link direto para qualquer página do CRM mostra "sem acesso" SEM chamar a API', async () => {
  const vendedor = await iniciar({ perfil: ME_CLOSER });
  const nomes = links(vendedor).map((a) => a.textContent);
  for (const quero of ['CRM', 'Clientes', 'Funis de Vendas', 'Fila de Aprovação', 'Leads Reprovados', 'Central de Agentes']) assert.ok(nomes.includes(quero), quero);
  for (const nao of ['Nova Prospecção', 'Histórico', 'Exclusões Permanentes']) assert.equal(nomes.includes(nao), false, nao);

  const semCrm = { ...ME_ADMIN, permissions: ['APPROVE:LEAD_APPROVAL'] };
  for (const hash of ['#/crm', '#/crm/clientes', '#/crm/dashboard', '#/crm/metas', '#/crm/configuracoes', '#/crm/configuracoes/servicos', '#/funis']) {
    const t = await iniciar({ perfil: semCrm, hash });
    assert.equal(links(t).map((a) => a.textContent).includes('CRM'), false, `${hash}: sem CRM no menu`);
    assert.match(texto(t), /Esta conta não possui acesso a esta área\./, hash);
    assert.equal(chamadas(t).some((c) => c.includes('/api/crm') || c.includes('/api/funnels')), false, `${hash}: sem chamar a API do CRM`);
    assert.doesNotMatch(texto(t), /EM DESENVOLVIMENTO/, `${hash}: nem a página futura aparece`);
  }
});

test('[MENU-8] a contagem de pendentes aparece na Fila de Aprovação e no grupo Prospecção do menu (e some ao zerar), sem abrir a fila', async () => {
  const t = await iniciar({ hash: '#/aprovacoes' });
  const fila = t.browser.by.link(nav(t), 'Fila de Aprovação');
  assert.equal(fila.getAttribute('data-count'), '2');
  assert.equal(fila.getAttribute('aria-label'), 'Fila de Aprovação, 2 pendentes');
  const grupo = t.browser.by.button(nav(t), 'Prospecção');
  assert.equal(grupo.getAttribute('data-count'), '2', 'o grupo soma, para o número não se esconder com o grupo recolhido');
  assert.deepEqual(marcados(t), ['Fila de Aprovação']);
  assert.equal(grupo.getAttribute('aria-expanded'), 'true', 'o grupo da rota atual está aberto');
});

test('[MENU-9] PROTEÇÃO DE RASCUNHO ao trocar de item do menu: com texto digitado em "Novo registro", clicar em outro item pergunta (nada muda até a pessoa decidir); "Continuar editando" devolve o endereço sem empilhar entradas; "Descartar alterações" segue para o item; sem texto a troca é livre', async () => {
  const t = await iniciar({ hash: '#/crm/novo' });
  await clicar(t, t.browser.by.link(nav(t), 'Clientes')); // sem nada digitado: livre
  assert.equal(pergunta(t), null);
  assert.deepEqual(marcados(t), ['Clientes']);

  await ir(t, '#/crm/novo');
  t.browser.click(t.browser.by.label(t.browser.root, 'Pessoa Jurídica'));
  t.browser.type(t.browser.by.label(t.browser.root, 'Nome da empresa (obrigatório)'), 'Rascunho Ltda');
  const entradas = t.win.history.length;
  await clicar(t, t.browser.by.link(nav(t), 'Dashboard Comercial'));
  assert.ok(pergunta(t), 'perguntou');
  assert.deepEqual(marcados(t), ['Clientes'], 'o menu e a tela continuam onde estavam');
  assert.equal(t.browser.by.label(t.browser.root, 'Nome da empresa (obrigatório)').value, 'Rascunho Ltda');
  assert.equal(t.win.fireBeforeUnload().prevented, true, 'atualizar a página também avisa');

  await clicar(t, t.browser.by.button(pergunta(t), 'Continuar editando'));
  assert.equal(t.win.location.hash, '#/crm/novo', 'o endereço voltou');
  assert.equal(t.win.history.length, entradas + 1, 'só a entrada que a própria pessoa criou ao clicar; nenhuma a mais');
  assert.equal(t.browser.by.label(t.browser.root, 'Nome da empresa (obrigatório)').value, 'Rascunho Ltda', 'o rascunho continua');

  await clicar(t, t.browser.by.button(nav(t), 'Prospecção')); // abre o grupo
  await clicar(t, t.browser.by.link(nav(t), 'Fila de Aprovação'));
  assert.ok(pergunta(t));
  await clicar(t, t.browser.by.button(pergunta(t), 'Descartar alterações'));
  assert.deepEqual(marcados(t), ['Fila de Aprovação'], 'descartou e foi para onde pediu');
  assert.equal(chamadas(t).filter((c) => c.startsWith('POST')).length, 0, 'nada foi criado');
  assert.equal(t.win.fireBeforeUnload().prevented, false);
});

test('[MENU-10] ESC com o painel lateral aberto fecha o painel (não mexe no menu) e a edição não salva do painel segue protegida mesmo clicando no menu pelo teclado do navegador (Voltar); sem alterações o ESC fecha direto', async () => {
  const t = await iniciar({ hash: '#/crm/clientes' });
  await clicar(t, t.browser.by.button(t.browser.root, 'Clínica Alfa'));
  await clicar(t, t.browser.by.button(gaveta(t), 'Editar'));
  t.browser.type(t.browser.by.label(gaveta(t), 'Cidade'), 'Rascunho');
  assert.equal(t.browser.by.cls(t.browser.root, 'shell')[0].hasAttribute('inert'), true, 'com o painel aberto a moldura (menu incluso) fica inerte: não dá para clicar nele');
  t.browser.press('Escape');
  await t.browser.flush(10);
  assert.ok(gaveta(t), 'com alterações o ESC pergunta antes de fechar');
  assert.ok(pergunta(t));
  await clicar(t, t.browser.by.button(pergunta(t), 'Continuar editando'));
  assert.equal(t.browser.by.label(gaveta(t), 'Cidade').value, 'Rascunho');

  t.win.history.back(); // o Voltar do navegador também é protegido
  await t.browser.flush(10);
  assert.ok(pergunta(t));
  await clicar(t, t.browser.by.button(pergunta(t), 'Continuar editando'));
  assert.equal(t.win.location.hash, '#/crm/registro/crm%3Aa');
  assert.ok(gaveta(t));
});
