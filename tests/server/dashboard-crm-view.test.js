// A tela do CRM (dashboard/views/crm.mjs) rodando de verdade sobre o DOM de teste (tests/helpers/fakeDom.js) e um
// cliente de API falso (tests/helpers/dashboardFixtures.mjs): lista, busca, filtros, ficha, histórico, criação, edição,
// mudança de status, DO_NOT_CONTACT, bloqueio do COMMERCIAL_CLOSER e o tratamento de 401/403/404/409/500.
//
// A tela é a mesma do navegador (recebe document, root e api por parâmetro). O que estes testes provam é o COMPORTAMENTO
// que uma pessoa vê e faz — o que aparece, o que um clique chama na API, o que a API responde e o que a tela mostra
// depois. A integração com a CRM-API de verdade (servidor, Service e domínio reais) está em dashboard-fullstack.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser, findAll } = require('../helpers/fakeDom');

const ADMIN = Object.freeze({ canReadCrm: true, canWriteCrm: true, canReview: true });
const CLOSER = Object.freeze({ canReadCrm: true, canWriteCrm: false, canReview: true });
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const nbsp = (text) => text.replace(/\u00a0/g, ' ');

// Monta a tela sobre um navegador de teste. `mostrar(route)` chama view.show e espera as respostas.
async function montar({ permissions = ADMIN, items = [], api, history } = {}) {
  const { createCrmView } = await import('../../dashboard/views/crm.mjs');
  const { createFakeApi } = await loadFixtures();
  const browser = createBrowser();
  const fake = api || createFakeApi({ items, history });
  const navegacoes = [];
  const view = createCrmView({ document: browser.document, root: browser.root, api: fake, permissions, navigate: (hash) => navegacoes.push(hash) });
  return {
    browser,
    view,
    api: fake,
    navegacoes,
    root: browser.root,
    async mostrar(route) {
      view.show(route);
      await browser.flush();
    },
  };
}

const LISTA = { name: 'crm-list' };
const NOVO = { name: 'crm-new' };
const REGISTRO = (id) => ({ name: 'crm-record', id });

// As linhas do <tbody> da tabela do CRM, cada uma como a lista dos textos das suas células.
const linhasDaTabela = (root) => {
  const [corpo] = findAll(root, (el) => el.localName === 'tbody');
  return corpo ? corpo.children.map((tr) => tr.children.map((td) => td.textContent.trim())) : [];
};

// A seção "Identificação", "Contato"... da ficha, e o valor de um campo dentro dela.
function secao(browser, titulo) {
  return browser.find(browser.root, (el) => el.localName === 'section' && el.children.some((filho) => filho.localName === 'h3' && filho.textContent.trim() === titulo));
}

function valorDe(browser, titulo, rotulo) {
  const bloco = secao(browser, titulo);
  assert.ok(bloco, `bloco ${titulo} não encontrado`);
  const dl = browser.by.tag(bloco, 'dl')[0];
  const filhos = dl.children;
  const indice = filhos.findIndex((el) => el.localName === 'dt' && el.textContent.trim() === rotulo);
  assert.ok(indice >= 0, `campo ${rotulo} não encontrado em ${titulo}`);
  return filhos[indice + 1];
}

// O texto da tela — e, sempre que se lê, confere que nenhuma tela mostra lixo de programação (null, undefined, NaN...).
const textoDaTela = (browser) => {
  const texto = browser.root.textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
  return texto;
};

async function registros() {
  const { crmRecord } = await loadFixtures();
  return [
    crmRecord({
      id: 'crm:a',
      empresa: 'Clínica Alfa',
      contato: 'Maria Souza',
      nicho: 'Psicologia',
      cidade: 'Petrópolis',
      estado: 'RJ',
      status: 'CONTACTED',
      servicoPotencial: 'Gestão de tráfego',
      responsavel: 'Rafael',
      proximaAcao: 'Ligar na segunda',
      dataDaProximaAcao: '2026-10-05',
      valorProposta: 1500,
      telefone: '(24) 90000-0001',
      email: 'contato@alfa.example.test',
      site: 'alfa.example.test',
      dataDeEntrada: '2026-09-12T10:00:00.000Z',
    }),
    crmRecord({ id: 'crm:b', empresa: 'Odonto Beta', contato: 'João Pereira', nicho: 'Odontologia', cidade: 'Niterói', status: 'WON', responsavel: 'Breno', dataDeEntrada: '2026-09-14T10:00:00.000Z' }),
    crmRecord({ id: 'crm:c', empresa: 'Ótica Gama', nicho: 'psicologia', cidade: 'São Paulo', status: 'PROSPECT', dataDeEntrada: '2026-09-13T10:00:00.000Z' }),
  ];
}

// ===========================================================================
// LISTA — carregamento, conteúdo, vazio, erro
// ===========================================================================
test('[DASH-CRM-1] a lista mostra "Carregando…" enquanto a API não responde e depois a tabela com as 9 colunas pedidas, do mais recente para o mais antigo', async () => {
  const { createFakeApi } = await loadFixtures();
  const t = await montar({ api: createFakeApi({ items: await registros() }) });
  const pendente = t.api.hold('listCrm');
  t.view.show(LISTA);
  await pendente.arrived;
  assert.match(textoDaTela(t.browser), /Carregando registros…/);
  assert.equal(t.browser.by.tag(t.root, 'table').length, 0);
  pendente.release();
  await t.browser.flush();

  assert.doesNotMatch(textoDaTela(t.browser), /Carregando registros/);
  const cabecalho = t.browser.by.tag(t.root, 'th').map((th) => th.textContent.trim());
  assert.deepEqual(cabecalho, ['Empresa', 'Contato', 'Nicho', 'Cidade', 'Status', 'Serviço potencial', 'Responsável', 'Próxima ação', 'Valor da proposta']);
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Odonto Beta', 'Ótica Gama', 'Clínica Alfa'], 'mais recente primeiro');
  assert.equal(t.browser.by.cls(t.root, 'crm-count')[0].textContent, '3 registros');
  assert.equal(t.api.callsOf('listCrm').length, 1);
});

test('[DASH-CRM-1b] a contagem de registros: "1 registro" no singular, "3 registros" no plural e "1 de 3 registros" quando há busca ou filtro', async () => {
  const { crmRecord } = await loadFixtures();
  const contagem = (t) => t.browser.by.cls(t.root, 'crm-count')[0].textContent;
  const um = await montar({ items: [crmRecord({ id: 'crm:solo', empresa: 'Solo Ltda' })] });
  await um.mostrar(LISTA);
  assert.equal(contagem(um), '1 registro');

  const t = await montar({ items: await registros() });
  await t.mostrar(LISTA);
  assert.equal(contagem(t), '3 registros');
  t.browser.type(t.browser.by.label(t.root, 'Buscar'), 'alfa');
  assert.equal(contagem(t), '1 de 3 registros');
});

test('[DASH-CRM-2] cada linha traz os dados do registro (cidade com UF, próxima ação com data, valor em reais, status como selo) e o link da ficha; campo vazio vira "—"', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(LISTA);
  const linha = linhasDaTabela(t.root).find((celulas) => celulas[0] === 'Clínica Alfa');
  assert.equal(linha[1], 'Maria Souza');
  assert.equal(linha[2], 'Psicologia');
  assert.equal(linha[3], 'Petrópolis/RJ');
  assert.equal(linha[4], 'Contacted');
  assert.equal(linha[5], 'Gestão de tráfego');
  assert.equal(linha[6], 'Rafael');
  assert.equal(linha[7], 'Ligar na segunda · 05/10/2026');
  assert.equal(nbsp(linha[8]), 'R$ 1.500,00');
  const beta = linhasDaTabela(t.root).find((celulas) => celulas[0] === 'Odonto Beta');
  assert.equal(beta[5], '—');
  assert.equal(beta[8], '—');

  const link = t.browser.by.link(t.root, 'Clínica Alfa');
  assert.equal(link.href, '#/crm/registro/crm%3Aa');
  const selo = t.browser.find(t.root, (el) => el.localName === 'span' && el.className.includes('badge') && el.textContent === 'Contacted');
  assert.ok(selo.className.includes('info'));
  // cada célula tem o rótulo da coluna (a tabela vira cartões em telas menores)
  const celulasRotuladas = t.browser.by.tag(t.root, 'td').filter((td) => td.getAttribute('data-label'));
  assert.equal(celulasRotuladas.length, 27);
});

test('[DASH-CRM-3] sem registros: a lista diz que está vazia; o ADMIN vê o atalho para criar o primeiro, o closer não vê nenhum botão de criação', async () => {
  const admin = await montar({ items: [] });
  await admin.mostrar(LISTA);
  assert.match(textoDaTela(admin.browser), /Nenhum registro no CRM ainda\./);
  assert.equal(admin.browser.by.link(admin.root, 'Criar o primeiro registro').href, '#/crm/novo');
  assert.equal(admin.browser.by.link(admin.root, 'Novo registro').href, '#/crm/novo');

  const closer = await montar({ items: [], permissions: CLOSER });
  await closer.mostrar(LISTA);
  assert.match(textoDaTela(closer.browser), /Nenhum registro no CRM ainda\./);
  assert.equal(closer.browser.by.link(closer.root, 'Criar o primeiro registro'), null);
  assert.equal(closer.browser.by.link(closer.root, 'Novo registro'), null);
});

test('[DASH-CRM-4] erro ao carregar: 500 mostra uma frase genérica (nunca o detalhe do servidor) com "Tentar novamente"; 403 diz que falta permissão; depois de tentar de novo a lista aparece', async () => {
  const { ApiError, createFakeApi } = await loadFixtures();
  const api = createFakeApi({ items: await registros() });
  const t = await montar({ api });
  api.failNext('listCrm', new ApiError(500, 'INTERNAL', 'detalhe interno C:\\segredo\\crm.json'));
  await t.mostrar(LISTA);
  assert.match(textoDaTela(t.browser), /Não foi possível concluir a operação agora/);
  assert.doesNotMatch(textoDaTela(t.browser), /segredo|crm\.json|detalhe interno/);
  assert.equal(t.browser.by.tag(t.root, 'table').length, 0);
  t.browser.click(t.browser.by.button(t.root, 'Tentar novamente'));
  await t.browser.flush();
  assert.equal(linhasDaTabela(t.root).length, 3);

  api.failNext('listCrm', new ApiError(403, 'FORBIDDEN', 'Esta conta não possui acesso a esta área.'));
  t.browser.click(t.browser.by.button(t.root, 'Atualizar'));
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Sua conta não tem permissão para esta ação\./);
  assert.equal(linhasDaTabela(t.root).length, 3, 'os dados já carregados continuam à vista quando uma atualização falha');
});

// ===========================================================================
// BUSCA e FILTROS
// ===========================================================================
test('[DASH-CRM-5] busca: filtra enquanto se digita SEM refazer o campo (o mesmo elemento, com foco), conta os resultados, ignora acento e caixa e encontra telefone por dígitos', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(LISTA);
  const busca = t.browser.by.label(t.root, 'Buscar');
  busca.focus();
  t.browser.type(busca, 'clinica');
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Clínica Alfa']);
  assert.equal(t.browser.by.cls(t.root, 'crm-count')[0].textContent, '1 de 3 registros');
  assert.equal(t.browser.by.label(t.root, 'Buscar'), busca, 'o campo de busca não foi recriado');
  assert.equal(t.browser.document.activeElement, busca, 'o foco continua no campo');

  t.browser.type(busca, '90000-0001');
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Clínica Alfa'], 'telefone por dígitos');
  t.browser.type(busca, 'JOÃO');
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Odonto Beta']);
  t.browser.type(busca, '');
  assert.equal(linhasDaTabela(t.root).length, 3);
  assert.equal(t.api.callsOf('listCrm').length, 1, 'a busca é do lado do navegador: nenhuma chamada nova à API');
});

test('[DASH-CRM-6] busca sem resultado: mostra a mensagem e o botão que limpa a busca e os filtros e traz tudo de volta', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(LISTA);
  const busca = t.browser.by.label(t.root, 'Buscar');
  t.browser.type(busca, 'zzzz-não-existe');
  assert.match(textoDaTela(t.browser), /Nenhum registro encontrado para esta busca ou filtro\./);
  assert.equal(t.browser.by.tag(t.root, 'table').length, 0);
  t.browser.click(t.browser.by.button(t.root, 'Limpar busca e filtros'));
  assert.equal(busca.value, '', 'o campo de busca foi esvaziado');
  assert.equal(linhasDaTabela(t.root).length, 3);
});

test('[DASH-CRM-7] filtros: status, nicho e responsável (as opções vêm dos dados, sem repetir "Psicologia" e "psicologia"), combinados com a busca; "Limpar filtros" restaura tudo', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(LISTA);
  const status = t.browser.by.label(t.root, 'Status');
  const nicho = t.browser.by.label(t.root, 'Nicho');
  const responsavel = t.browser.by.label(t.root, 'Responsável');
  const opcoes = (select) => t.browser.by.tag(select, 'option').map((option) => option.textContent);

  assert.equal(opcoes(status).length, 14, 'todos os status + "Todos os status"');
  assert.deepEqual(opcoes(status).slice(0, 3), ['Todos os status', 'Prospect', 'Research']);
  assert.deepEqual(opcoes(nicho), ['Todos os nichos', 'Odontologia', 'Psicologia'], 'uma grafia por nicho, em ordem alfabética');
  assert.deepEqual(opcoes(responsavel), ['Todos os responsáveis', 'Breno', 'Rafael'], 'quem não tem responsável não vira opção');

  t.browser.choose(nicho, 'Psicologia');
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]).sort(), ['Clínica Alfa', 'Ótica Gama'], 'Psicologia e psicologia são o mesmo nicho');
  t.browser.choose(responsavel, 'Rafael');
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Clínica Alfa']);
  t.browser.choose(status, 'WON');
  assert.match(textoDaTela(t.browser), /Nenhum registro encontrado/);
  assert.equal(t.browser.by.cls(t.root, 'crm-count')[0].textContent, '0 de 3 registros');

  t.browser.click(t.browser.by.button(t.root, 'Limpar filtros'));
  assert.equal(status.value, '');
  assert.equal(nicho.value, '');
  assert.equal(responsavel.value, '');
  assert.equal(linhasDaTabela(t.root).length, 3);
  t.browser.choose(status, 'WON');
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Odonto Beta']);
});

test('[DASH-CRM-7b] depois de atualizar, um filtro que aponta para um valor que deixou de existir volta para "todos" (a lista nunca fica vazia por causa de um filtro que não dá mais para ver)', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(LISTA);
  t.browser.choose(t.browser.by.label(t.root, 'Nicho'), 'Odontologia');
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Odonto Beta']);

  t.api.store.items = t.api.store.items.filter((item) => item.id !== 'crm:b'); // não existe mais nenhum registro de Odontologia
  t.browser.click(t.browser.by.button(t.root, 'Atualizar'));
  await t.browser.flush();
  assert.equal(t.browser.by.label(t.root, 'Nicho').value, '', 'o filtro voltou para "todos"');
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Ótica Gama', 'Clínica Alfa'], 'a lista mostra o que existe');
  assert.deepEqual(t.browser.by.tag(t.browser.by.label(t.root, 'Nicho'), 'option').map((o) => o.textContent), ['Todos os nichos', 'Psicologia']);
});

test('[DASH-CRM-8] uma lista grande mostra 100 por vez com "Mostrar mais"; buscar volta ao começo', async () => {
  const { crmRecord } = await loadFixtures();
  const muitos = Array.from({ length: 250 }, (_, indice) => crmRecord({ id: `crm:n${indice}`, empresa: `Empresa ${String(indice).padStart(3, '0')}`, dataDeEntrada: `2026-08-${String(1 + (indice % 28)).padStart(2, '0')}T10:00:00.000Z` }));
  const t = await montar({ items: muitos });
  await t.mostrar(LISTA);
  assert.equal(linhasDaTabela(t.root).length, 100);
  assert.match(textoDaTela(t.browser), /Mostrando 100 de 250\./);
  t.browser.click(t.browser.by.button(t.root, 'Mostrar mais'));
  assert.equal(linhasDaTabela(t.root).length, 200);
  t.browser.click(t.browser.by.button(t.root, 'Mostrar mais'));
  assert.equal(linhasDaTabela(t.root).length, 250);
  assert.equal(t.browser.by.button(t.root, 'Mostrar mais'), null, 'sem o botão quando já mostra tudo');
  t.browser.click(t.browser.by.button(t.root, 'Mostrar mais') || t.browser.by.button(t.root, 'Atualizar'));
  const busca = t.browser.by.label(t.root, 'Buscar');
  t.browser.type(busca, 'Empresa 0');
  assert.equal(linhasDaTabela(t.root).length, 100, 'buscar volta a mostrar 100');
});

// ===========================================================================
// FICHA
// ===========================================================================
test('[DASH-CRM-9] a ficha mostra os campos em blocos (Identificação, Contato, Presença digital, Comercial, Pipeline, Próxima ação) e o histórico; usa GET do registro e do histórico', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  const titulos = t.browser.by.tag(t.root, 'h3').map((h3) => h3.textContent.trim());
  assert.deepEqual(titulos, ['Identificação', 'Contato', 'Presença digital', 'Comercial', 'Pipeline', 'Próxima ação', 'Histórico']);
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Clínica Alfa');

  assert.equal(valorDe(t.browser, 'Identificação', 'Empresa').textContent, 'Clínica Alfa');
  assert.equal(valorDe(t.browser, 'Identificação', 'Cidade').textContent, 'Petrópolis');
  assert.equal(valorDe(t.browser, 'Contato', 'Telefone').textContent, '(24) 90000-0001');
  assert.equal(valorDe(t.browser, 'Contato', 'E-mail').textContent, 'contato@alfa.example.test');
  assert.equal(nbsp(valorDe(t.browser, 'Comercial', 'Valor da proposta').textContent), 'R$ 1.500,00');
  assert.equal(valorDe(t.browser, 'Pipeline', 'Status').textContent, 'Contacted');
  assert.equal(valorDe(t.browser, 'Pipeline', 'Responsável').textContent, 'Rafael');
  assert.equal(valorDe(t.browser, 'Próxima ação', 'Data da próxima ação').textContent, '05/10/2026');
  assert.equal(valorDe(t.browser, 'Presença digital', 'Instagram').textContent, '—', 'campo vazio');
  assert.match(valorDe(t.browser, 'Pipeline', 'Data de entrada').textContent, /12\/09\/2026/);

  assert.equal(t.api.callsOf('getCrm').length, 1, 'a ficha busca o registro atual');
  assert.equal(t.api.callsOf('getCrmHistory').length, 1, 'e o histórico em GET /api/crm/:id/history');
  assert.deepEqual(t.api.callsOf('getCrmHistory')[0].args, ['crm:a']);
  assert.equal(t.browser.by.link(t.root, '← Voltar à lista').href, '#/crm');
});

test('[DASH-CRM-10] o site vira link (com rel="noopener noreferrer"), mas endereço perigoso (javascript:, data:) e texto qualquer nunca viram link', async () => {
  const { crmRecord } = await loadFixtures();
  const registro = crmRecord({ id: 'crm:links', empresa: 'Links', site: 'alfa.example.test', instagram: 'javascript:alert(1)', facebook: 'data:text/html,<script>1</script>', googlePerfil: 'https://maps.example.test/lugar', linkDoMeet: '@so-um-nome', linkDoRaioX: 'https://usuario:senha@x.example.test' });
  const t = await montar({ items: [registro] });
  await t.mostrar(REGISTRO('crm:links'));
  const links = t.browser.by.tag(t.root, 'a').filter((a) => a.getAttribute('target') === '_blank');
  assert.deepEqual(links.map((a) => a.href).sort(), ['https://alfa.example.test/', 'https://maps.example.test/lugar']);
  for (const link of links) assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  for (const a of t.browser.by.tag(t.root, 'a')) assert.doesNotMatch(a.href, /^(javascript|data|vbscript|file):/i, 'nenhum link perigoso');
  // os valores perigosos aparecem como TEXTO, sem virar link
  assert.equal(valorDe(t.browser, 'Presença digital', 'Instagram').textContent, 'javascript:alert(1)');
  assert.equal(valorDe(t.browser, 'Presença digital', 'Instagram').localName, 'dd');
  assert.equal(t.browser.by.tag(valorDe(t.browser, 'Presença digital', 'Instagram'), 'a').length, 0);
  assert.equal(valorDe(t.browser, 'Pipeline', 'Link do Meet').textContent, '@so-um-nome');
});

test('[DASH-CRM-11] dados hostis nunca viram HTML: texto com marcação aparece como texto puro (nenhum <img>, <script> ou atributo de evento é criado) e campos que não existem no modelo (authUserId, token, permissions) nunca aparecem', async () => {
  const { crmRecord } = await loadFixtures();
  const hostil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const registro = crmRecord({ id: 'crm:xss', empresa: hostil, contato: hostil, observacoes: hostil, cidade: '"><b>negrito</b>' });
  registro.authUserId = 'auth-vazado-no-registro';
  registro.token = 'token-vazado-no-registro';
  registro.permissions = ['WRITE:CRM'];
  registro.segredoInterno = 'segredo-interno-do-armazenamento';
  registro.historico[0].reviewedBy.authUserId = 'auth-vazado-no-historico';
  registro.historico[0].token = 'token-vazado-na-entrada';
  const t = await montar({ items: [registro] });

  await t.mostrar(LISTA);
  const naLista = textoDaTela(t.browser);
  assert.ok(naLista.includes(hostil), 'o texto hostil aparece inteiro, como texto');
  await t.mostrar(REGISTRO('crm:xss'));
  const naFicha = textoDaTela(t.browser);
  assert.ok(naFicha.includes(hostil));

  for (const proibida of ['img', 'script', 'b', 'iframe', 'object']) assert.equal(t.browser.by.tag(t.root, proibida).length, 0, `nenhum <${proibida}> foi criado a partir de um dado`);
  for (const elemento of t.browser.findAll(t.root, () => true)) {
    for (const nome of elemento.attributes.keys()) assert.ok(!nome.startsWith('on'), `atributo de evento ${nome}`);
    assert.doesNotMatch(elemento.getAttribute('href') || '', /^javascript:/i);
  }
  for (const proibido of ['auth-vazado', 'token-vazado', 'segredo-interno', 'permissions', 'WRITE:CRM']) {
    assert.ok(!naLista.includes(proibido) && !naFicha.includes(proibido), `"${proibido}" não pode aparecer na interface`);
  }
});

test('[DASH-CRM-12] abrir a ficha por link direto (sem a lista carregada) mostra "Carregando…" e depois o registro; um registro que não existe mostra "Registro não encontrado." e o caminho de volta', async () => {
  const t = await montar({ items: await registros() });
  const pendente = t.api.hold('getCrm');
  t.view.show(REGISTRO('crm:b'));
  await pendente.arrived;
  assert.match(textoDaTela(t.browser), /Carregando registro…/);
  pendente.release();
  await t.browser.flush();
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Odonto Beta');

  await t.mostrar(REGISTRO('crm:nao-existe'));
  assert.match(textoDaTela(t.browser), /Registro não encontrado\./);
  assert.equal(t.browser.by.link(t.root, '← Voltar à lista').href, '#/crm');
  assert.equal(t.browser.by.button(t.root, 'Editar'), null, 'sem registro, sem ações');
});

test('[DASH-CRM-13] histórico: vem de GET /api/crm/:id/history, do mais recente para o mais antigo, com quem fez, quando e o motivo; tem estados de carregando, erro (com nova tentativa) e vazio', async () => {
  const { ApiError, crmRecord, createFakeApi } = await loadFixtures();
  const entradas = [
    { timestamp: '2026-09-10T12:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN' }, motivo: null },
    { timestamp: '2026-09-11T12:00:00.000Z', from: 'PROSPECT', to: 'CONTACTED', actor: 'HUMAN', reviewedBy: { userId: 'user-rafael', name: 'Rafael Closer', role: 'COMMERCIAL_CLOSER' }, motivo: 'Primeiro contato' },
  ];
  const registro = crmRecord({ id: 'crm:h', empresa: 'Histórico', historico: [] });
  const api = createFakeApi({ items: [registro], history: { 'crm:h': entradas } });
  const t = await montar({ api });

  const pendente = api.hold('getCrmHistory');
  t.view.show(REGISTRO('crm:h'));
  await pendente.arrived;
  assert.match(textoDaTela(t.browser), /Carregando histórico…/);
  pendente.release();
  await t.browser.flush();
  const itens = t.browser.by.tag(t.browser.by.cls(t.root, 'timeline')[0], 'li').map((li) => li.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(itens.length, 2);
  assert.match(itens[0], /^Prospect → Contacted — .*Rafael Closer \(Closer comercial\)/);
  assert.match(itens[0], /Primeiro contato/);
  assert.match(itens[1], /^Registro criado como Prospect — .*Breno Bento \(Administrador\)/);

  api.failNext('getCrmHistory', new ApiError(500, 'INTERNAL', 'x'));
  await t.mostrar(REGISTRO('crm:h'));
  assert.match(textoDaTela(t.browser), /Não foi possível concluir a operação agora/);
  t.browser.click(t.browser.by.button(t.root, 'Tentar novamente'));
  await t.browser.flush();
  assert.equal(t.browser.by.tag(t.browser.by.cls(t.root, 'timeline')[0], 'li').length, 2);

  api.store.histories['crm:h'] = [];
  await t.mostrar(REGISTRO('crm:h'));
  assert.match(textoDaTela(t.browser), /Nenhum evento registrado\./);
});

// ===========================================================================
// COMMERCIAL_CLOSER: pode ver, buscar, filtrar e abrir — não pode escrever
// ===========================================================================
test('[DASH-CRM-14] COMMERCIAL_CLOSER: vê a lista, busca, filtra e abre a ficha, mas não tem NENHUM botão de escrita (nem criar, nem editar, nem mudar status, nem DNC)', async () => {
  const t = await montar({ items: await registros(), permissions: CLOSER });
  await t.mostrar(LISTA);
  assert.equal(linhasDaTabela(t.root).length, 3);
  t.browser.type(t.browser.by.label(t.root, 'Buscar'), 'alfa');
  assert.equal(linhasDaTabela(t.root).length, 1);
  assert.equal(t.browser.by.link(t.root, 'Novo registro'), null);

  await t.mostrar(REGISTRO('crm:a'));
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Clínica Alfa');
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar']) assert.equal(t.browser.by.button(t.root, botao), null, botao);
  assert.match(textoDaTela(t.browser), /Seu perfil pode consultar o CRM, mas não pode criar nem alterar registros\./);

  await t.mostrar(NOVO);
  assert.match(textoDaTela(t.browser), /Sua conta não pode criar registros no CRM\./);
  assert.equal(t.browser.by.tag(t.root, 'form').length, 0, 'sem formulário de criação');
  for (const escrita of ['createCrm', 'updateCrm', 'moveCrmStatus', 'markCrmDnc']) assert.equal(t.api.callsOf(escrita).length, 0, `${escrita} nunca foi chamado`);
});

test('[DASH-CRM-15] se a API recusar uma escrita com 403 (uma conta que passou pela tela), a tela mostra a frase de permissão dentro do painel — nunca quebra nem mostra o texto do servidor', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  t.api.failNext('updateCrm', new ApiError(403, 'FORBIDDEN', 'Esta conta não possui acesso a esta área.'));
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  t.browser.type(t.browser.by.label(t.root, 'Cidade'), 'Outra');
  t.browser.click(t.browser.by.button(t.root, 'Salvar alterações'));
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Sua conta não tem permissão para esta ação\./);
  assert.equal(t.browser.by.button(t.root, 'Salvar alterações').disabled, false, 'o botão volta a funcionar');
  assert.equal(t.browser.by.label(t.root, 'Cidade').value, 'Outra', 'o que a pessoa digitou continua no formulário');
});

// ===========================================================================
// CRIAÇÃO (ADMIN)
// ===========================================================================
test('[DASH-CRM-16] criar: o formulário traz todos os campos gravaveis em blocos e só a empresa é obrigatória; ao salvar, envia SÓ campos preenchidos + status inicial e motivo, e leva à ficha do registro criado com a mensagem de sucesso', async () => {
  const { WRITABLE_KEYS } = await import('../../dashboard/crm-model.mjs');
  const { parseRoute } = await import('../../dashboard/router.mjs');
  const t = await montar();
  await t.mostrar(NOVO);
  assert.equal(t.browser.document.activeElement, t.browser.by.label(t.root, 'Empresa (obrigatório)'), 'o foco já começa no campo da empresa');
  const controles = t.browser.findAll(t.root, (el) => ['input', 'textarea'].includes(el.localName) && el.getAttribute('name'));
  const nomes = controles.map((el) => el.getAttribute('name'));
  for (const chave of WRITABLE_KEYS) assert.ok(nomes.includes(chave), `falta o campo ${chave}`);
  assert.deepEqual(nomes.filter((nome) => !WRITABLE_KEYS.includes(nome)).sort(), ['reason'], 'o único controle extra é o motivo da entrada');
  for (const proibido of ['userId', 'authUserId', 'role', 'permissions', 'actor', 'reviewedBy', 'id', 'historico']) assert.ok(!nomes.includes(proibido), `nenhum campo ${proibido}`);
  for (const rotulo of ['Valor da proposta', 'Valor total']) {
    const dinheiro = t.browser.by.label(t.root, rotulo);
    assert.equal(dinheiro.getAttribute('type'), 'text', `${rotulo}: campo de texto (um type="number" devolve vazio para "1.500,50" e, na edição, apagaria o valor sem aviso)`);
    assert.equal(dinheiro.getAttribute('inputmode'), 'decimal', `${rotulo}: teclado numérico no celular`);
  }
  assert.equal(t.browser.by.label(t.root, 'Status inicial').value, 'PROSPECT');
  const iniciais = t.browser.by.tag(t.browser.by.label(t.root, 'Status inicial'), 'option').map((o) => o.textContent);
  assert.equal(iniciais.length, 12, 'os 13 status, menos "Do Not Contact": um registro nunca nasce bloqueado sem o painel de confirmação');
  assert.ok(!iniciais.includes('Do Not Contact') && iniciais.includes('Won') && iniciais.includes('Prospect'));
  assert.equal(t.browser.by.tag(t.root, 'legend').map((el) => el.textContent).join('|'), 'Identificação|Contato|Presença digital|Comercial|Pipeline|Próxima ação|Entrada no CRM');

  t.browser.type(t.browser.by.label(t.root, 'Empresa (obrigatório)'), '  Clínica Nova  ');
  t.browser.type(t.browser.by.label(t.root, 'Cidade'), 'Niterói');
  t.browser.type(t.browser.by.label(t.root, 'Valor da proposta'), '1500,50');
  t.browser.choose(t.browser.by.label(t.root, 'Status inicial'), 'QUALIFIED_PROSPECT');
  t.browser.type(t.browser.by.label(t.root, 'Motivo da entrada (opcional)'), 'Indicação de cliente');
  t.browser.click(t.browser.by.button(t.root, 'Criar registro'));
  await t.browser.flush();

  const chamada = t.api.callsOf('createCrm');
  assert.equal(chamada.length, 1);
  assert.deepEqual(chamada[0].args, [{ empresa: 'Clínica Nova', cidade: 'Niterói', valorProposta: 1500.5 }, { status: 'QUALIFIED_PROSPECT', reason: 'Indicação de cliente' }]);
  assert.deepEqual(t.navegacoes, ['#/crm/registro/crm%3Acreated-1'], 'depois de criar, vai para a ficha do registro criado');

  await t.mostrar(parseRoute(t.navegacoes[0]));
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Clínica Nova');
  assert.match(textoDaTela(t.browser), /Registro criado\./);
  assert.equal(valorDe(t.browser, 'Pipeline', 'Status').textContent, 'Qualified Prospect');
});

test('[DASH-CRM-17] criar sem empresa (ou com valor em dinheiro inválido): a tela aponta o campo, foca nele e NÃO chama a API', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  t.browser.click(t.browser.by.button(t.root, 'Criar registro'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('createCrm').length, 0);
  assert.match(textoDaTela(t.browser), /Informe o nome da empresa\./);
  assert.match(textoDaTela(t.browser), /Corrija os campos destacados\./);
  const empresa = t.browser.by.label(t.root, 'Empresa (obrigatório)');
  assert.equal(empresa.getAttribute('aria-invalid'), 'true');
  assert.equal(t.browser.document.activeElement, empresa);

  t.browser.type(empresa, 'Ok Ltda');
  t.browser.type(t.browser.by.label(t.root, 'Valor total'), 'muito dinheiro');
  t.browser.click(t.browser.by.button(t.root, 'Criar registro'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('createCrm').length, 0);
  assert.match(textoDaTela(t.browser), /Informe um valor numérico maior ou igual a zero\./);
  assert.equal(empresa.getAttribute('aria-invalid'), null, 'o erro da empresa saiu quando ela foi preenchida');
});

test('[DASH-CRM-18] criar com identidade já existente (409): mostra a frase de duplicidade no formulário, mantém tudo o que foi digitado e deixa tentar de novo — sem navegar', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar();
  await t.mostrar(NOVO);
  t.browser.type(t.browser.by.label(t.root, 'Empresa (obrigatório)'), 'Repetida Ltda');
  t.browser.type(t.browser.by.label(t.root, 'Site'), 'repetida.example.test');
  t.api.failNext('createCrm', new ApiError(409, 'DUPLICATE_RECORD', 'Já existe um registro com esta identidade.'));
  t.browser.click(t.browser.by.button(t.root, 'Criar registro'));
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Já existe um registro com esta identidade \(mesmo site, telefone ou Instagram\)/);
  assert.equal(t.browser.by.label(t.root, 'Empresa (obrigatório)').value, 'Repetida Ltda');
  assert.equal(t.browser.by.label(t.root, 'Site').value, 'repetida.example.test');
  assert.equal(t.browser.by.button(t.root, 'Criar registro').disabled, false);
  assert.deepEqual(t.navegacoes, []);

  t.browser.type(t.browser.by.label(t.root, 'Site'), 'outra.example.test');
  t.browser.click(t.browser.by.button(t.root, 'Criar registro'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('createCrm').length, 2);
  assert.equal(t.navegacoes.length, 1, 'na segunda tentativa deu certo');
});

test('[DASH-CRM-19] criar com "possível duplicidade" (mesmo nome e cidade): o registro é criado, e a ficha avisa e oferece o link do registro semelhante', async () => {
  const { parseRoute } = await import('../../dashboard/router.mjs');
  const { crmRecord } = await loadFixtures();
  const existente = crmRecord({ id: 'crm:existente', empresa: 'Clínica Alfa', cidade: 'Petrópolis' });
  const t = await montar({ items: [existente] });
  const original = t.api.createCrm;
  t.api.createCrm = async (...args) => {
    const resposta = await original(...args);
    return { ...resposta, duplicidade: { status: 'POSSIVEL_DUPLICADO', matchedOn: ['nome+cidade'], matchedRecordId: 'crm:existente' } };
  };
  await t.mostrar(NOVO);
  t.browser.type(t.browser.by.label(t.root, 'Empresa (obrigatório)'), 'Clínica Alfa');
  t.browser.click(t.browser.by.button(t.root, 'Criar registro'));
  await t.browser.flush();
  await t.mostrar(parseRoute(t.navegacoes[0]));
  assert.match(textoDaTela(t.browser), /Registro criado\. Atenção: já existe um registro com o mesmo nome e cidade/);
  assert.equal(t.browser.by.link(t.root, 'Ver o registro semelhante').href, '#/crm/registro/crm%3Aexistente');
});

test('[DASH-CRM-20] as sugestões dos campos vêm dos dados já carregados (nicho, responsável, cidade...): nenhuma é inventada, e nenhuma repete', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(NOVO);
  const sugestoes = (chave) => t.browser.by.id(t.root, `crm-suggest-${chave}`);
  assert.deepEqual(t.browser.by.tag(sugestoes('nicho'), 'option').map((o) => o.getAttribute('value')), ['Odontologia', 'Psicologia']);
  assert.deepEqual(t.browser.by.tag(sugestoes('responsavel'), 'option').map((o) => o.getAttribute('value')), ['Breno', 'Rafael']);
  assert.equal(t.browser.by.label(t.root, 'Nicho').getAttribute('list'), 'crm-suggest-nicho');
  assert.equal(t.browser.by.label(t.root, 'Nome do contato').getAttribute('list'), null, 'campo sem sugestões');
  assert.equal(t.api.callsOf('listCrm').length, 1, 'a lista foi carregada em segundo plano ao abrir o formulário');

  // O formulário de EDIÇÃO também traz as sugestões (a lista já estava carregada).
  await t.mostrar(LISTA);
  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  assert.deepEqual(t.browser.by.tag(sugestoes('nicho'), 'option').map((o) => o.getAttribute('value')), ['Odontologia', 'Psicologia']);
  assert.equal(t.browser.by.label(t.root, 'Nicho').getAttribute('list'), 'crm-suggest-nicho');
});

// ===========================================================================
// EDIÇÃO (ADMIN)
// ===========================================================================
test('[DASH-CRM-21] editar: o formulário abre com os valores do registro, envia SÓ o que mudou (PATCH), atualiza a ficha na hora e confirma; sem nenhuma mudança não chama a API', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  assert.equal(t.browser.by.label(t.root, 'Empresa (obrigatório)').value, 'Clínica Alfa');
  assert.equal(t.browser.by.label(t.root, 'Valor da proposta').value, '1500');
  assert.equal(t.browser.by.label(t.root, 'Data da próxima ação').value, '2026-10-05');
  assert.equal(t.browser.by.tag(t.root, 'dl').length, 0, 'enquanto edita, os blocos de leitura saem da frente');
  assert.equal(t.browser.document.activeElement, t.browser.by.label(t.root, 'Empresa (obrigatório)'), 'o foco vai para o primeiro campo');

  t.browser.click(t.browser.by.button(t.root, 'Salvar alterações'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('updateCrm').length, 0, 'nada mudou: nada é enviado');
  assert.match(textoDaTela(t.browser), /Nenhuma alteração para salvar\./);

  t.browser.type(t.browser.by.label(t.root, 'Cidade'), 'Teresópolis');
  t.browser.type(t.browser.by.label(t.root, 'Valor da proposta'), '2000');
  t.browser.type(t.browser.by.label(t.root, 'Telefone'), '');
  t.browser.click(t.browser.by.button(t.root, 'Salvar alterações'));
  await t.browser.flush();
  const chamada = t.api.callsOf('updateCrm');
  assert.equal(chamada.length, 1);
  assert.deepEqual(chamada[0].args, ['crm:a', { cidade: 'Teresópolis', valorProposta: 2000, telefone: null }], 'só o que mudou; campo esvaziado vai como null');
  assert.match(textoDaTela(t.browser), /Alterações salvas\./);
  assert.equal(t.browser.by.tag(t.root, 'form').length, 0, 'o painel fechou');
  assert.equal(valorDe(t.browser, 'Identificação', 'Cidade').textContent, 'Teresópolis');
  assert.equal(nbsp(valorDe(t.browser, 'Comercial', 'Valor da proposta').textContent), 'R$ 2.000,00');
  assert.equal(valorDe(t.browser, 'Contato', 'Telefone').textContent, '—');
});

test('[DASH-CRM-22] editar com a empresa vazia (ou valor inválido): aponta o campo e NÃO chama a API; cancelar descarta o que foi digitado', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  t.browser.type(t.browser.by.label(t.root, 'Empresa (obrigatório)'), '   ');
  t.browser.click(t.browser.by.button(t.root, 'Salvar alterações'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('updateCrm').length, 0);
  assert.match(textoDaTela(t.browser), /Informe o nome da empresa\./);

  t.browser.click(t.browser.by.button(t.root, 'Cancelar'));
  assert.equal(t.browser.by.tag(t.root, 'form').length, 0);
  assert.equal(valorDe(t.browser, 'Identificação', 'Empresa').textContent, 'Clínica Alfa', 'nada foi alterado');
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  assert.equal(t.browser.by.label(t.root, 'Empresa (obrigatório)').value, 'Clínica Alfa', 'reabrir volta aos valores do registro');
});

test('[DASH-CRM-23] edição concorrente: se outra pessoa mudou um campo enquanto o formulário estava aberto, ele NÃO é sobrescrito — só o que a pessoa mexeu é enviado', async () => {
  const t = await montar({ items: await registros() });
  // A lista já tem o registro (cidade Petrópolis); a busca do registro atual demora e traz outra cidade.
  await t.mostrar(LISTA);
  const pendente = t.api.hold('getCrm');
  t.view.show(REGISTRO('crm:a'));
  await pendente.arrived;
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  assert.equal(t.browser.by.label(t.root, 'Cidade').value, 'Petrópolis');
  t.api.store.items.find((item) => item.id === 'crm:a').cidade = 'Teresópolis'; // outra pessoa editou
  pendente.release();
  await t.browser.flush();
  assert.equal(t.browser.by.label(t.root, 'Cidade').value, 'Petrópolis', 'o formulário aberto não é apagado pela resposta que chegou');

  t.browser.type(t.browser.by.label(t.root, 'Nicho'), 'Psicologia clínica');
  t.browser.click(t.browser.by.button(t.root, 'Salvar alterações'));
  await t.browser.flush();
  assert.deepEqual(t.api.callsOf('updateCrm')[0].args, ['crm:a', { nicho: 'Psicologia clínica' }], 'a cidade que a outra pessoa mudou não foi enviada');
  assert.equal(t.api.store.items.find((item) => item.id === 'crm:a').cidade, 'Teresópolis');
});

test('[DASH-CRM-24] erros ao salvar: 400 mostra a frase do servidor, 409 de duplicidade mostra a frase própria, 500 mostra uma frase genérica — sempre dentro do painel, com o formulário e o que foi digitado intactos', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  t.browser.type(t.browser.by.label(t.root, 'Site'), 'novo.example.test');

  const tentar = async (erro) => {
    t.api.failNext('updateCrm', erro);
    t.browser.click(t.browser.by.button(t.root, 'Salvar alterações'));
    await t.browser.flush();
    return textoDaTela(t.browser);
  };
  assert.match(await tentar(new ApiError(400, 'INVALID_REQUEST', 'Valor inválido em um dos campos.')), /Valor inválido em um dos campos\./);
  assert.match(await tentar(new ApiError(409, 'DUPLICATE_RECORD', 'Já existe um registro com esta identidade.')), /Já existe um registro com esta identidade \(mesmo site, telefone ou Instagram\)/);
  const generico = await tentar(new ApiError(500, 'INTERNAL', 'detalhe interno C:\\segredo\\crm.json'));
  assert.match(generico, /Não foi possível concluir a operação agora/);
  assert.doesNotMatch(generico, /segredo|crm\.json/);
  assert.equal(t.browser.by.label(t.root, 'Site').value, 'novo.example.test', 'o que foi digitado continua lá');
  assert.equal(t.browser.by.button(t.root, 'Salvar alterações').disabled, false);
});

test('[DASH-CRM-25] se o registro virou "Não contatar" por baixo (409 RECORD_LOCKED), a tela avisa e recarrega a ficha, que passa a mostrar o bloqueio em vez das ações', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  t.browser.type(t.browser.by.label(t.root, 'Cidade'), 'Outra');
  // Enquanto isso, outra pessoa marca o registro como DNC.
  t.api.store.items.find((item) => item.id === 'crm:a').status = 'DO_NOT_CONTACT';
  t.api.failNext('updateCrm', new ApiError(409, 'RECORD_LOCKED', 'Este registro está bloqueado.'));
  const antes = t.api.callsOf('getCrm').length;
  t.browser.click(t.browser.by.button(t.root, 'Salvar alterações'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('getCrm').length, antes + 1, 'a ficha foi recarregada');
  assert.match(textoDaTela(t.browser), /bloqueado como "Não contatar"/);
  assert.equal(t.browser.by.button(t.root, 'Editar'), null, 'as ações saíram');
  assert.equal(t.browser.by.tag(t.root, 'form').length, 0, 'o painel de edição saiu junto: um registro bloqueado não tem mais formulário');
  assert.ok(secao(t.browser, 'Identificação'), 'os blocos da ficha voltaram');
});

// ===========================================================================
// MUDAR STATUS (ADMIN)
// ===========================================================================
test('[DASH-CRM-26] mudar status: oferece os outros status (menos "Do Not Contact", que tem painel próprio), exige escolher um, envia o destino e o motivo, atualiza o selo e o histórico — a tela não decide se a mudança vale', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Mudar status'));
  const destino = t.browser.by.label(t.root, 'Novo status');
  const opcoes = t.browser.by.tag(destino, 'option').map((o) => o.textContent);
  assert.equal(opcoes.length, 12, 'o placeholder + os 13 status, menos o atual e menos "Do Not Contact"');
  assert.equal(opcoes[0], 'Escolha o novo status');
  assert.ok(!opcoes.includes('Contacted'), 'o status atual não é oferecido');
  assert.ok(!opcoes.includes('Do Not Contact'), '"Não contatar" é terminal: só pelo painel próprio, com o aviso e a confirmação');
  assert.ok(opcoes.includes('Won') && opcoes.includes('Prospect'));
  assert.match(textoDaTela(t.browser), /use o botão "Marcar como Não contatar": ele pede confirmação, porque a ação é terminal\./);
  assert.match(textoDaTela(t.browser), /Status atual: Contacted\./);
  assert.equal(t.browser.document.activeElement, destino);

  t.browser.click(t.browser.by.button(t.root, 'Confirmar mudança'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('moveCrmStatus').length, 0);
  assert.match(textoDaTela(t.browser), /Escolha o novo status\./);

  t.browser.choose(destino, 'PROPOSAL');
  t.browser.type(t.browser.by.label(t.root, 'Motivo (opcional)'), 'Enviamos a proposta');
  t.browser.click(t.browser.by.button(t.root, 'Confirmar mudança'));
  await t.browser.flush();
  assert.deepEqual(t.api.callsOf('moveCrmStatus')[0].args, ['crm:a', 'PROPOSAL', 'Enviamos a proposta']);
  assert.match(textoDaTela(t.browser), /Status alterado para Proposal\./);
  assert.equal(valorDe(t.browser, 'Pipeline', 'Status').textContent, 'Proposal');
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].parentNode.children[1].textContent, 'Proposal', 'o selo do cabeçalho mudou');
  assert.equal(t.api.callsOf('getCrmHistory').length, 2, 'o histórico foi buscado de novo');
  const itens = t.browser.by.tag(t.browser.by.cls(t.root, 'timeline')[0], 'li').map((li) => li.textContent);
  assert.match(itens[0], /^Contacted → Proposal/);
  assert.match(itens[0], /Enviamos a proposta/);
});

test('[DASH-CRM-27] mudança de status recusada pelo servidor (409 INVALID_TRANSITION): a frase do servidor aparece no painel, que continua aberto com a escolha feita; nada muda na ficha', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:b')); // WON: o domínio só deixa ir para DO_NOT_CONTACT
  t.browser.click(t.browser.by.button(t.root, 'Mudar status'));
  t.browser.choose(t.browser.by.label(t.root, 'Novo status'), 'PROSPECT');
  t.api.failNext('moveCrmStatus', new ApiError(409, 'INVALID_TRANSITION', 'Esta mudança de status não é permitida.'));
  t.browser.click(t.browser.by.button(t.root, 'Confirmar mudança'));
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Esta mudança de status não é permitida a partir do status atual\./);
  assert.equal(t.browser.by.label(t.root, 'Novo status').value, 'PROSPECT', 'o painel continua aberto, com a escolha');
  assert.equal(valorDe(t.browser, 'Pipeline', 'Status').textContent, 'Won');
  assert.equal(t.browser.by.button(t.root, 'Confirmar mudança').disabled, false);
});

// ===========================================================================
// NÃO CONTATAR (DO_NOT_CONTACT)
// ===========================================================================
test('[DASH-CRM-28] "Marcar como Não contatar" mostra que é uma ação TERMINAL, exige a confirmação marcada e só então chama a API; depois o registro fica bloqueado e as ações saem', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Marcar como Não contatar'));
  const painel = textoDaTela(t.browser);
  assert.match(painel, /ação TERMINAL e não pode ser desfeita/);
  assert.match(painel, /deixa de poder ser editado e de mudar de status/);
  assert.match(painel, /site, o telefone e o Instagram dele ficam bloqueados/);

  t.browser.type(t.browser.by.label(t.root, 'Motivo (opcional)'), 'Pediu para não ser contatado');
  t.browser.click(t.browser.by.button(t.root, 'Confirmar: marcar como Não contatar'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('markCrmDnc').length, 0, 'sem a confirmação marcada, nada é enviado');
  assert.match(textoDaTela(t.browser), /Confirme que você entende que a ação é terminal/);

  t.browser.check(t.browser.by.label(t.root, 'Entendo que esta ação é terminal e não pode ser desfeita.'));
  t.browser.click(t.browser.by.button(t.root, 'Confirmar: marcar como Não contatar'));
  await t.browser.flush();
  assert.deepEqual(t.api.callsOf('markCrmDnc')[0].args, ['crm:a', 'Pediu para não ser contatado']);
  assert.match(textoDaTela(t.browser), /Registro marcado como "Não contatar"\. Ele agora está bloqueado\./);
  assert.equal(valorDe(t.browser, 'Pipeline', 'Status').textContent, 'Do Not Contact');
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar']) assert.equal(t.browser.by.button(t.root, botao), null, `${botao} saiu`);
  assert.match(textoDaTela(t.browser), /Este registro está bloqueado como "Não contatar"\. Ele não pode mais ser editado nem mudar de status\./);
  const itens = t.browser.by.tag(t.browser.by.cls(t.root, 'timeline')[0], 'li').map((li) => li.textContent);
  assert.match(itens[0], /^Contacted → Do Not Contact/);
});

test('[DASH-CRM-28b] o ÚNICO caminho até "Não contatar" é o painel próprio (com o aviso e a confirmação): nenhum seletor de status da tela oferece "Do Not Contact" — só o FILTRO da lista, para achar os bloqueados', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(NOVO);
  const iniciais = t.browser.by.tag(t.browser.by.label(t.root, 'Status inicial'), 'option');
  assert.ok(iniciais.length > 0 && !iniciais.some((o) => o.value === 'DO_NOT_CONTACT'), 'a criação não oferece "Do Not Contact"');

  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Mudar status'));
  const destino = t.browser.by.label(t.root, 'Novo status');
  assert.ok(!t.browser.by.tag(destino, 'option').some((o) => o.value === 'DO_NOT_CONTACT'), 'mudar status não oferece "Do Not Contact"');
  t.browser.choose(destino, 'DO_NOT_CONTACT'); // um valor que não existe no seletor não fica escolhido
  t.browser.click(t.browser.by.button(t.root, 'Confirmar mudança'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('moveCrmStatus').length, 0);
  assert.equal(t.api.callsOf('markCrmDnc').length, 0);
  assert.match(textoDaTela(t.browser), /Escolha o novo status\./);

  await t.mostrar(LISTA);
  const filtro = t.browser.by.tag(t.browser.by.label(t.root, 'Status'), 'option');
  assert.ok(filtro.some((o) => o.value === 'DO_NOT_CONTACT'), 'o filtro da lista continua podendo mostrar os bloqueados');
});

test('[DASH-CRM-29] um registro que JÁ é "Não contatar" abre bloqueado: nem o ADMIN vê as ações de escrita, só o aviso', async () => {
  const { crmRecord } = await loadFixtures();
  const t = await montar({ items: [crmRecord({ id: 'crm:dnc', empresa: 'Bloqueada', status: 'DO_NOT_CONTACT' })] });
  await t.mostrar(REGISTRO('crm:dnc'));
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar']) assert.equal(t.browser.by.button(t.root, botao), null, botao);
  assert.match(textoDaTela(t.browser), /bloqueado como "Não contatar"/);
  assert.equal(t.browser.by.tag(t.root, 'form').length, 0);
});

// ===========================================================================
// SEGURANÇA e ROBUSTEZ
// ===========================================================================
test('[DASH-CRM-30] a tela nunca envia identidade de autorização: nas quatro escritas, nada além de campos do registro, status, motivo e id (userId, authUserId, role, permissions, actor e reviewedBy nunca aparecem)', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(NOVO);
  t.browser.type(t.browser.by.label(t.root, 'Empresa (obrigatório)'), 'Nova Ltda');
  t.browser.click(t.browser.by.button(t.root, 'Criar registro'));
  await t.browser.flush();

  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  t.browser.type(t.browser.by.label(t.root, 'Cidade'), 'Outra');
  t.browser.click(t.browser.by.button(t.root, 'Salvar alterações'));
  await t.browser.flush();
  t.browser.click(t.browser.by.button(t.root, 'Mudar status'));
  t.browser.choose(t.browser.by.label(t.root, 'Novo status'), 'RESPONDED');
  t.browser.click(t.browser.by.button(t.root, 'Confirmar mudança'));
  await t.browser.flush();
  t.browser.click(t.browser.by.button(t.root, 'Marcar como Não contatar'));
  t.browser.check(t.browser.by.label(t.root, 'Entendo que esta ação é terminal e não pode ser desfeita.'));
  t.browser.click(t.browser.by.button(t.root, 'Confirmar: marcar como Não contatar'));
  await t.browser.flush();

  const escritas = ['createCrm', 'updateCrm', 'moveCrmStatus', 'markCrmDnc'].flatMap((nome) => t.api.callsOf(nome));
  assert.equal(escritas.length, 4, 'as quatro escritas aconteceram');
  const texto = JSON.stringify(escritas.map((chamada) => chamada.args));
  for (const proibido of ['userId', 'authUserId', 'role', 'permissions', 'actor', 'reviewedBy', 'user-breno', 'ADMIN']) {
    assert.ok(!texto.includes(proibido), `"${proibido}" nunca é enviado pela interface`);
  }
});

test('[DASH-CRM-31] enviar duas vezes (clique duplo) faz UMA chamada: os botões ficam desabilitados enquanto a resposta não chega, e voltam quando ela falha', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ items: await registros() });
  await t.mostrar(REGISTRO('crm:a'));
  t.browser.click(t.browser.by.button(t.root, 'Editar'));
  t.browser.type(t.browser.by.label(t.root, 'Cidade'), 'Nova cidade');
  const pendente = t.api.hold('updateCrm');
  const salvar = t.browser.by.button(t.root, 'Salvar alterações');
  t.browser.click(salvar);
  await pendente.arrived;
  assert.equal(salvar.disabled, true, 'desabilitado enquanto envia');
  assert.equal(t.browser.by.button(t.root, 'Cancelar').disabled, true);
  t.browser.submit(t.browser.by.tag(t.root, 'form')[0]);
  t.browser.click(salvar);
  assert.equal(t.api.callsOf('updateCrm').length, 1, 'o segundo envio foi ignorado');
  pendente.fail(new ApiError(500, 'INTERNAL', 'x'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('updateCrm').length, 1);
  assert.equal(salvar.disabled, false, 'voltou a funcionar depois da falha');
});

test('[DASH-CRM-32] resposta tardia nunca apaga a tela atual: a lista que chega depois de abrir uma ficha, e a ficha A que chega depois da B, não são desenhadas por cima', async () => {
  const t = await montar({ items: await registros() });
  const lista = t.api.hold('listCrm');
  t.view.show(LISTA);
  await lista.arrived;
  t.view.show(REGISTRO('crm:b'));
  await t.browser.flush();
  lista.release();
  await t.browser.flush();
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Odonto Beta');
  assert.equal(t.browser.by.tag(t.root, 'table').length, 0, 'a lista atrasada não foi desenhada na ficha');

  const a = t.api.hold('getCrm');
  t.view.show(REGISTRO('crm:a'));
  await a.arrived;
  t.view.show(REGISTRO('crm:c'));
  await t.browser.flush();
  a.release();
  await t.browser.flush();
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Ótica Gama', 'só a ficha mais recente vale');
});

test('[DASH-CRM-32b] duas cargas da lista fora de ordem: a resposta ANTIGA, que chega por último, não sobrescreve a nova (a tela mostra sempre o que a última chamada trouxe)', async () => {
  const { crmRecord } = await loadFixtures();
  const t = await montar({ items: await registros() });
  const antiga = t.api.hold('listCrm');
  t.view.show(LISTA);
  await antiga.arrived;
  t.api.store.items = [crmRecord({ id: 'crm:novo', empresa: 'Só Depois', dataDeEntrada: '2026-09-20T10:00:00.000Z' })];
  t.browser.click(t.browser.by.button(t.root, 'Atualizar'));
  await t.browser.flush();
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Só Depois'], 'a chamada mais nova já desenhou');

  antiga.release({ items: [crmRecord({ id: 'crm:velho', empresa: 'Resposta Velha' })] });
  await t.browser.flush();
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Só Depois'], 'a resposta velha, que chegou por último, foi descartada');
  assert.doesNotMatch(textoDaTela(t.browser), /Resposta Velha/);
  assert.deepEqual(t.view.state.list.items.map((item) => item.id), ['crm:novo']);
});

test('[DASH-CRM-32c] o histórico da ficha A que chega depois de abrir a ficha B não aparece na B', async () => {
  const t = await montar({ items: await registros() });
  const a = t.api.hold('getCrmHistory');
  t.view.show(REGISTRO('crm:a'));
  await a.arrived;
  t.view.show(REGISTRO('crm:c'));
  await t.browser.flush();
  a.release({ historico: [{ timestamp: '2026-09-12T10:00:00.000Z', from: null, to: 'CONTACTED', actor: 'HUMAN', reviewedBy: { userId: 'user-breno', name: 'Breno Bento', role: 'ADMIN' }, motivo: 'Motivo só da ficha A' }] });
  await t.browser.flush();
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Ótica Gama');
  assert.doesNotMatch(textoDaTela(t.browser), /Motivo só da ficha A/, 'o histórico atrasado da A não entrou na B');
  assert.equal(t.api.callsOf('getCrmHistory').length, 2);
});

test('[DASH-CRM-32d] a falha tardia da ficha A (depois de abrir a B) não vira erro na B: nem na B que ainda carrega, nem na B já aberta', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ items: await registros() });
  const a = t.api.hold('getCrm');
  t.view.show(REGISTRO('crm:a'));
  await a.arrived;
  const b = t.api.hold('getCrm');
  t.view.show(REGISTRO('crm:c'));
  await b.arrived; // as duas chamadas estão pendentes
  a.fail(new ApiError(500, 'INTERNAL', 'x'));
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Carregando/, 'a B continua carregando: a falha da A não a marcou como erro');
  assert.doesNotMatch(textoDaTela(t.browser), /Não foi possível/);
  b.release();
  await t.browser.flush();
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Ótica Gama');

  const c = t.api.hold('getCrm');
  t.view.show(REGISTRO('crm:a'));
  await c.arrived;
  t.view.show(REGISTRO('crm:c')); // a B já está carregada (vem do que a tela já tinha)
  await t.browser.flush();
  c.fail(new ApiError(500, 'INTERNAL', 'x'));
  await t.browser.flush();
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Ótica Gama');
  assert.doesNotMatch(textoDaTela(t.browser), /Não foi possível/, 'a falha da A não aparece como aviso na B');
});

test('[DASH-CRM-32e] a falha tardia do histórico da ficha A não aparece no histórico da B', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar({ items: await registros() });
  const a = t.api.hold('getCrmHistory');
  t.view.show(REGISTRO('crm:a'));
  await a.arrived;
  t.view.show(REGISTRO('crm:c'));
  await t.browser.flush();
  a.fail(new ApiError(500, 'INTERNAL', 'x'));
  await t.browser.flush();
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Ótica Gama');
  assert.doesNotMatch(textoDaTela(t.browser), /Não foi possível/, 'a falha da A não virou erro no histórico da B');
  assert.equal(t.browser.by.cls(t.root, 'timeline').length, 1, 'a B mostra o histórico que ela mesma carregou');
});

test('[DASH-CRM-33] destroy() esvazia a tela e descarta os dados; respostas que chegam depois são ignoradas sem erro (nenhum dado de CRM sobra depois do logout)', async () => {
  const t = await montar({ items: await registros() });
  await t.mostrar(LISTA);
  assert.ok(textoDaTela(t.browser).includes('Clínica Alfa'));
  const pendente = t.api.hold('getCrm');
  t.view.show(REGISTRO('crm:a'));
  await pendente.arrived;
  t.view.destroy();
  assert.equal(textoDaTela(t.browser), '');
  assert.equal(t.view.state.list.items.length, 0);
  pendente.release();
  await t.browser.flush();
  assert.equal(textoDaTela(t.browser), '', 'nada foi desenhado depois');
  t.view.show(LISTA);
  assert.equal(textoDaTela(t.browser), '', 'uma tela destruída não volta a desenhar');
});

test('[DASH-CRM-33b] uma lista que chega depois do destroy() (logout com a carga em andamento) é ignorada, com sucesso ou com falha: nenhum dado do CRM volta para a memória nem para a tela', async () => {
  const { crmRecord, ApiError } = await loadFixtures();
  const t = await montar({ items: await registros() });
  const pendente = t.api.hold('listCrm');
  t.view.show(LISTA);
  await pendente.arrived;
  t.view.destroy();
  pendente.release({ items: [crmRecord({ id: 'crm:tardio', empresa: 'Chegou Tarde' })] });
  await t.browser.flush();
  assert.equal(t.view.state.list.items.length, 0, 'nada foi guardado depois do logout');
  assert.equal(textoDaTela(t.browser), '', 'nada foi desenhado');

  const outra = await montar({ items: await registros() });
  const pendente2 = outra.api.hold('listCrm');
  outra.view.show(LISTA);
  await pendente2.arrived;
  outra.view.destroy();
  pendente2.fail(new ApiError(500, 'INTERNAL', 'x'));
  await outra.browser.flush();
  assert.equal(outra.view.state.list.status, 'idle', 'uma falha tardia também é ignorada (o estado continua zerado)');
  assert.equal(textoDaTela(outra.browser), '');
});

test('[DASH-CRM-33c] um registro criado depois do destroy() (logout durante o envio) não volta para a memória nem para a tela, e a tela não navega', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  t.browser.type(t.browser.by.label(t.root, 'Empresa (obrigatório)'), 'Criada Tarde Ltda');
  const pendente = t.api.hold('createCrm');
  t.browser.click(t.browser.by.button(t.root, 'Criar registro'));
  await pendente.arrived;
  t.view.destroy();
  pendente.release();
  await t.browser.flush();
  assert.equal(t.view.state.list.items.length, 0, 'nada foi guardado depois do logout');
  assert.equal(textoDaTela(t.browser), '');
  assert.deepEqual(t.navegacoes, [], 'nem navegou');
});

test('[DASH-CRM-34] uma resposta malformada da API (lista que não é lista, itens sem id, registro com outro id) nunca derruba a tela nem mostra dado inventado', async () => {
  const { crmRecord } = await loadFixtures();
  const t = await montar();
  t.api.listCrm = async () => ({ items: [null, 42, 'x', {}, { id: '' }, { id: 7 }, crmRecord({ id: 'crm:ok', empresa: 'Só Esta' })] });
  await t.mostrar(LISTA);
  assert.deepEqual(linhasDaTabela(t.root).map((linha) => linha[0]), ['Só Esta']);

  t.api.listCrm = async () => ({ items: 'não é lista' });
  t.browser.click(t.browser.by.button(t.root, 'Atualizar'));
  await t.browser.flush();
  assert.match(textoDaTela(t.browser), /Nenhum registro no CRM ainda\./);

  t.api.getCrm = async () => ({ item: crmRecord({ id: 'crm:outro', empresa: 'Outro Registro' }) });
  await t.mostrar(REGISTRO('crm:pedido'));
  assert.doesNotMatch(textoDaTela(t.browser), /Outro Registro/, 'um registro com id diferente do pedido nunca é mostrado');
  assert.match(textoDaTela(t.browser), /Não foi possível concluir a operação agora/);
});
