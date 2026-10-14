// CRM 5.0, Fase 2B-3.1 — SELEÇÃO ASSISTIDA dos catálogos nos formulários "Novo registro" e "Editar registro" (dashboard/views/crm.mjs + dashboard/ui/catalogField.mjs): Nicho, Origem e Serviço
// potencial. A tela do CRM de verdade, sobre o DOM de teste e uma API falsa com catálogos fictícios: nenhuma rede, nenhum dado real. O que se prova: a lista oficial quando há itens ativos; o texto
// livre quando o catálogo está vazio, indisponível (503) ou falhou por rede — sem nunca bloquear o CRM; valores legados mostrados exatamente como estão ("fora do catálogo", grafia diferente,
// desativado) e NUNCA trocados sem uma ação explícita; "Informar outro valor" só para quem administra; o valor continua sendo TEXTO e o PATCH leva só o que mudou; respostas tardias e avisos de
// mudança não sobrescrevem o que a pessoa está fazendo; nenhum valor financeiro é tocado; a Fila de Aprovação e a Prospecção não conhecem nada disto.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBrowser } = require('../helpers/fakeDom');
const { CRM_WRITABLE_FIELDS } = require('../../src/crm/constants');

const loadView = () => import('../../dashboard/views/crm.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8').replace(/\r\n/g, '\n');

const ADMIN = Object.freeze({ canReadCrm: true, canWriteCrm: true, canDeleteCrm: false, canReview: true, canManageCrmCatalogs: true });
// Escreve no CRM mas NÃO administra os catálogos (hoje só o ADMIN escreve; a permissão é a pergunta certa do ponto de vista do formulário).
const ESCRITOR = Object.freeze({ canReadCrm: true, canWriteCrm: true, canDeleteCrm: false, canReview: true, canManageCrmCatalogs: false });
const CLOSER = Object.freeze({ canReadCrm: true, canWriteCrm: false, canDeleteCrm: false, canReview: true, canManageCrmCatalogs: false });
const NOVO = { name: 'crm-new' };

async function catalogosPadrao() {
  const { catalogItem } = await loadFixtures();
  return {
    nichos: [catalogItem('nichos', 'Psicologia'), catalogItem('nichos', 'Odontologia'), catalogItem('nichos', 'Estética'), catalogItem('nichos', 'Academias', { ativo: false })],
    origens: [catalogItem('origens', 'Indicação'), catalogItem('origens', 'Anúncio no Instagram'), catalogItem('origens', 'Parceria com agência'), catalogItem('origens', 'Feira antiga', { ativo: false })],
    servicos: [catalogItem('servicos', 'Gestão de redes sociais', { precoReferencia: 1800 }), catalogItem('servicos', 'Criação de site', { precoReferencia: 4800 }), catalogItem('servicos', 'Consultoria', { ativo: false, precoReferencia: 900 })],
  };
}

async function registro(campos = {}) {
  const { crmRecord } = await loadFixtures();
  return crmRecord({ id: 'crm:a', empresa: 'Clínica Alfa', cidade: 'Petrópolis', estado: 'RJ', status: 'CONTACTED', valorProposta: 1500, valorTotal: 3000, dataDeEntrada: '2026-09-12T10:00:00.000Z', ...campos });
}

async function abrir({ permissions = ADMIN, items, catalogs, api: dada, bus: busDado, semCatalogos = false } = {}) {
  const { createCrmView } = await loadView();
  const { createDataBus, createUi } = await loadUi();
  const { createFakeApi } = await loadFixtures();
  const browser = createBrowser();
  const api = dada || createFakeApi({ items: items || [await registro()], ...(semCatalogos ? {} : { catalogs: catalogs || (await catalogosPadrao()) }) });
  const bus = busDado || createDataBus();
  const host = browser.document.createElement('div');
  host.className = 'overlay-host';
  const viewRoot = browser.document.createElement('div');
  browser.root.append(viewRoot, host);
  const ui = createUi({ document: browser.document, host, getInertTargets: () => [viewRoot] });
  const view = createCrmView({ document: browser.document, root: viewRoot, api, permissions, navigate() {}, bus, navigation: null, ui });
  const s = { browser, view, api, bus, ui, root: browser.root };
  await view.show({ name: 'crm-list' });
  await browser.flush();
  return s;
}

const gaveta = (s) => s.browser.find(s.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const botao = (s, nome) => s.browser.by.button(s.root, nome);
const clicar = async (s, el) => {
  s.browser.click(el);
  await s.browser.flush(8);
};
const conta = (s, nome) => s.api.callsOf(nome).length;
const statusDeEdicao = (s) => s.browser.by.id(s.root, 'crm-edit-status').textContent;
const textoDaTela = (s) => s.root.textContent.replace(/\s+/g, ' ');
// O aviso ÚNICO de catálogos indisponíveis (visível), o formulário de campos e o primeiro elemento dele.
const avisosCompartilhados = (s) => s.browser.findAll(s.root, (el) => el.className.split(/\s+/).includes('catalog-notice') && !el.hidden);
const formulario = (s) => s.browser.find(s.root, (el) => el.className.split(/\s+/).includes('field-form') || el.className.split(/\s+/).includes('field-form-tabs'));
const primeiroDoFormulario = (s) => formulario(s).children[0];

const bloco = (s, chave) => s.browser.find(s.root, (el) => /\bcatalog-field\b/.test(el.className) && el.children.some((filho) => filho.getAttribute('id') === `crm-field-${chave}`));
const seletor = (s, chave) => s.browser.by.id(s.root, `crm-field-${chave}-select`);
const texto = (s, chave) => s.browser.by.id(s.root, `crm-field-${chave}`);
const aviso = (s, chave) => s.browser.by.id(s.root, `crm-field-${chave}-note`);
const rotuloDe = (s, rotulo) => s.browser.find(s.root, (el) => el.localName === 'label' && el.textContent.trim() === rotulo);
const opcoes = (select) => select.children.filter((el) => el.localName === 'option').map((o) => o.textContent);
const opcaoDe = (select, rotulo) => select.children.find((el) => el.localName === 'option' && el.textContent === rotulo);
const textoDoAviso = (s, chave) => aviso(s, chave).textContent.replace(/\s+/g, ' ').trim();
const visao = (s, chave) => bloco(s, chave).getAttribute('data-view');
const escolher = async (s, chave, rotulo) => {
  const select = seletor(s, chave);
  const opcao = opcaoDe(select, rotulo);
  assert.ok(opcao, `opção "${rotulo}" em ${chave}: ${opcoes(select).join(' | ')}`);
  s.browser.choose(select, opcao.value);
  await s.browser.flush(4);
};
const sair = (s, el) => {
  el.blur();
  el.dispatchEvent({ type: 'blur', bubbles: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
};

async function abrirNovo(opcoesDaTela) {
  const s = await abrir(opcoesDaTela);
  await s.view.show(NOVO);
  await s.browser.flush(8);
  return s;
}

async function abrirEdicao(opcoesDaTela, empresa = 'Clínica Alfa') {
  const s = await abrir(opcoesDaTela);
  await clicar(s, botao(s, empresa));
  await clicar(s, botao(s, 'Editar'));
  assert.ok(gaveta(s));
  return s;
}

const CHAVES = ['nicho', 'origem', 'servicoPotencial'];
// Os nomes que só a seleção assistida usa (o api.mjs tem catalogFields, que é outra coisa: o corpo das escritas dos catálogos).
const MARCA_DA_SELECAO = /crm-catalog-lookup\.mjs|catalogField\.mjs|createCatalogField|createCatalogLookup|listCatalog/;
const ROTULO = Object.freeze({ nicho: 'Nicho', origem: 'Origem do Lead', servicoPotencial: 'Serviço potencial' });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// COM ITENS ATIVOS
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATFLD-1] NOVO REGISTRO com itens ativos: os três campos mostram as opções OFICIAIS (só as ativas, na ordem do servidor), nada vem escolhido, o rótulo aponta para a lista e nenhum item é criado', async () => {
  const { createFakeApi } = await loadFixtures();
  const api = createFakeApi({ items: [await registro()], catalogs: await catalogosPadrao() });
  const catalogosAntes = JSON.stringify(api.store.catalogs);
  const s = await abrirNovo({ permissions: ADMIN, api });
  const esperado = {
    nicho: ['Psicologia', 'Odontologia', 'Estética'],
    origem: ['Indicação', 'Anúncio no Instagram', 'Parceria com agência'],
    servicoPotencial: ['Gestão de redes sociais', 'Criação de site'],
  };
  for (const chave of CHAVES) {
    assert.equal(visao(s, chave), 'select', chave);
    assert.equal(seletor(s, chave).hidden, false);
    assert.equal(texto(s, chave).hidden, true, `${chave}: o texto livre só aparece se for preciso`);
    assert.deepEqual(opcoes(seletor(s, chave)), ['Nenhum (deixar em branco)', ...esperado[chave], 'Informar outro valor'], chave);
    assert.equal(seletor(s, chave).value, 'none', `${chave}: nenhum item é escolhido sozinho`);
    assert.ok(!textoDaTela(s).includes('Academias') && !textoDaTela(s).includes('Feira antiga') && !textoDaTela(s).includes('Consultoria'), 'um item desativado nunca é oferecido');
    assert.match(seletor(s, chave).getAttribute('aria-describedby'), new RegExp(`^crm-field-${chave}-note crm-catalog-notice-\\d+ crm-field-${chave}-error$`), 'descrito pelo aviso do campo, pelo aviso único do formulário e pelo erro');
  }
  assert.equal(rotuloDe(s, 'Nicho').getAttribute('for'), 'crm-field-nicho-select');
  assert.equal(rotuloDe(s, 'Origem do Lead').getAttribute('for'), 'crm-field-origem-select');
  assert.equal(rotuloDe(s, 'Serviço potencial').getAttribute('for'), 'crm-field-servicoPotencial-select');
  assert.equal(s.browser.by.label(s.root, 'Nicho'), seletor(s, 'nicho'), 'o rótulo leva à lista');
  assert.deepEqual(s.api.calls.map((c) => c.name).filter((n) => n !== 'listCrm').sort(), ['listCatalog', 'listCatalog', 'listCatalog'], 'três leituras, uma por catálogo, e mais nada');
  assert.deepEqual(s.api.callsOf('listCatalog').map((c) => c.args[0]).sort(), ['nichos', 'origens', 'servicos']);
  assert.equal(JSON.stringify(s.api.store.catalogs), catalogosAntes, 'os catálogos não foram tocados');
});

test('[CATFLD-2] QUEM ADMINISTRA lê também os desativados (para poder confirmá-los) e vê "Informar outro valor"; quem só escreve no CRM lê só os ativos e NÃO vê essa opção nem o atalho do cadastro', async () => {
  const admin = await abrirNovo({ permissions: ADMIN });
  assert.deepEqual(admin.api.callsOf('listCatalog').map((c) => c.args[1]), [{ todos: true }, { todos: true }, { todos: true }]);
  for (const chave of CHAVES) assert.ok(opcoes(seletor(admin, chave)).includes('Informar outro valor'));

  const escritor = await abrirNovo({ permissions: ESCRITOR });
  assert.deepEqual(escritor.api.callsOf('listCatalog').map((c) => c.args[1]), [{}, {}, {}], 'sem ?todos=1');
  for (const chave of CHAVES) {
    assert.ok(!opcoes(seletor(escritor, chave)).includes('Informar outro valor'), `${chave}: sem a opção de criar valor`);
    assert.equal(seletor(escritor, chave).value, 'none');
  }
  assert.equal(escritor.browser.by.link(escritor.root, /Abrir o cadastro/), null, 'nenhum atalho administrativo');
});

test('[CATFLD-3] CRIAR escolhendo nas listas: o corpo enviado ao CRM leva os NOMES como texto nos mesmos campos de sempre, e só os preenchidos; os catálogos não são escritos', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [] });
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Nova');
  await escolher(s, 'nicho', 'Estética');
  await escolher(s, 'origem', 'Indicação');
  await escolher(s, 'servicoPotencial', 'Gestão de redes sociais');
  await clicar(s, botao(s, 'Criar registro'));
  const [chamada] = s.api.callsOf('createCrm');
  assert.deepEqual(chamada.args[0], { empresa: 'Clínica Nova', nicho: 'Estética', origem: 'Indicação', servicoPotencial: 'Gestão de redes sociais' });
  assert.ok(Object.values(chamada.args[0]).every((valor) => typeof valor === 'string'), 'tudo texto');
  assert.deepEqual(Object.keys(s.api).filter((nome) => /Catalog/.test(nome)), ['listCatalog'], 'a API falsa nem tem como escrever em catálogo');
  assert.equal(s.api.store.items.length, 1);
  assert.equal(s.api.store.items[0].nicho, 'Estética');
});

test('[CATFLD-4] "Nenhum" deixa o campo em branco: escolher e voltar a "Nenhum" não envia o campo; nada é preenchido por conta própria', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [] });
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Vazia');
  await escolher(s, 'nicho', 'Estética');
  await escolher(s, 'nicho', 'Nenhum (deixar em branco)');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Vazia' });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// EDITAR — valores legados
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATFLD-5] EDITAR um registro cujo valor é um item oficial: aparece escolhido, nada está "alterado", e salvar OUTRO campo envia só esse campo (os três catálogos ficam de fora do PATCH)', async () => {
  const s = await abrirEdicao({ items: [await registro({ nicho: 'Psicologia', origem: 'Indicação', servicoPotencial: 'Criação de site' })] });
  assert.match(seletor(s, 'nicho').value, /^item:niche:/, 'um item escolhido');
  assert.equal(seletor(s, 'nicho').children.find((o) => o.value === seletor(s, 'nicho').value).textContent, 'Psicologia');
  assert.equal(seletor(s, 'origem').children.find((o) => o.value === seletor(s, 'origem').value).textContent, 'Indicação');
  assert.equal(statusDeEdicao(s), '', 'nada alterado');
  assert.equal(textoDoAviso(s, 'nicho'), '', 'um valor oficial não ganha aviso');
  s.browser.type(s.browser.by.label(gaveta(s), 'Cidade'), 'Niterói');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { cidade: 'Niterói' }], 'só o que mudou');
});

test('[CATFLD-6] VALOR LEGADO FORA DO CATÁLOGO: aparece EXATAMENTE como foi salvo, escolhido, identificado como "fora do catálogo", sem ser normalizado nem trocado; salvar outro campo não o toca; as opções oficiais continuam ali e dá para voltar ao valor antigo', async () => {
  const legado = 'clinica  Odontológica popular (RJ)';
  const s = await abrirEdicao({ items: [await registro({ nicho: legado })] });
  const select = seletor(s, 'nicho');
  assert.equal(select.value, 'legacy');
  assert.equal(opcaoDe(select, `${legado} — fora do catálogo`).value, 'legacy', 'o texto salvo, intacto, mais a identificação');
  assert.match(textoDoAviso(s, 'nicho'), /^Fora do catálogo: valor mantido como está\./);
  assert.ok(textoDoAviso(s, 'nicho').endsWith('Valor atual: "clinica Odontológica popular (RJ)"'), 'o valor atual aparece por inteiro no aviso (o <select> corta textos longos)');
  assert.equal(statusDeEdicao(s), '', 'abrir não altera nada');
  assert.deepEqual(opcoes(select).slice(0, 2), ['Nenhum (deixar em branco)', `${legado} — fora do catálogo`]);
  assert.ok(opcoes(select).includes('Psicologia'), 'as opções oficiais estão disponíveis');

  s.browser.type(s.browser.by.label(gaveta(s), 'Cidade'), 'Niterói');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args[1], { cidade: 'Niterói' }, 'o valor antigo não foi enviado de volta');
  assert.equal(s.api.store.items[0].nicho, legado, 'e continua exatamente como era');
});

test('[CATFLD-7] ESCOLHER OUTRA COISA e VOLTAR ao valor antigo: o valor legado continua na lista como uma opção, e o PATCH só leva o campo quando o valor de fato mudou', async () => {
  const legado = 'Clínicas veterinárias';
  const s = await abrirEdicao({ items: [await registro({ nicho: legado })] });
  await escolher(s, 'nicho', 'Estética');
  assert.equal(statusDeEdicao(s), 'Alterações não salvas');
  assert.equal(textoDoAviso(s, 'nicho'), '', 'ao escolher um item oficial o aviso some');
  await escolher(s, 'nicho', `${legado} — fora do catálogo`);
  assert.equal(statusDeEdicao(s), '', 'de volta ao valor original: nada a salvar');
  assert.match(textoDoAviso(s, 'nicho'), /^Fora do catálogo/);
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.equal(conta(s, 'updateCrm'), 0, 'nada a enviar');
  assert.match(textoDaTela(s), /Nenhuma alteração para salvar/);
  await escolher(s, 'nicho', 'Odontologia');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { nicho: 'Odontologia' }], 'só o nicho, só agora');
});

test('[CATFLD-8] GRAFIA DIFERENTE da oficial: mostra a grafia oficial e a ação "Usar a grafia oficial"; o campo só muda DEPOIS dessa ação explícita (e então o PATCH leva a grafia oficial)', async () => {
  const s = await abrirEdicao({ items: [await registro({ nicho: 'estetica' })] });
  const select = seletor(s, 'nicho');
  assert.equal(select.value, 'legacy');
  assert.equal(opcaoDe(select, 'estetica — grafia diferente').value, 'legacy');
  assert.match(textoDoAviso(s, 'nicho'), /Grafia diferente da oficial \("Estética"\)\. O valor só muda se você usar a grafia oficial\.\s*Valor atual: "estetica"\s*Usar a grafia oficial$/);
  assert.equal(statusDeEdicao(s), '', 'ver a grafia oficial não altera o valor');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.equal(conta(s, 'updateCrm'), 0, 'sem a ação explícita nada é enviado');

  await clicar(s, s.browser.by.button(aviso(s, 'nicho'), 'Usar a grafia oficial'));
  assert.equal(select.children.find((o) => o.value === select.value).textContent, 'Estética');
  assert.equal(statusDeEdicao(s), 'Alterações não salvas', 'a ação explícita é uma alteração (e avisa o formulário)');
  assert.equal(textoDoAviso(s, 'nicho'), '');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { nicho: 'Estética' }]);
  assert.equal(s.api.store.items[0].nicho, 'Estética');
});

test('[CATFLD-9] ITEM DESATIVADO: quem administra vê "Desativado" (a API autorizada confirmou) e o valor é preservado; o item NÃO é oferecido como nova escolha; quem só escreve vê "Fora do catálogo" — nunca se presume "desativado"', async () => {
  const s = await abrirEdicao({ permissions: ADMIN, items: [await registro({ nicho: 'Academias' })] });
  const select = seletor(s, 'nicho');
  assert.equal(select.value, 'legacy');
  assert.equal(opcaoDe(select, 'Academias — desativado').value, 'legacy');
  assert.match(textoDoAviso(s, 'nicho'), /^Desativado no cadastro: valor mantido, mas não oferecido para novas escolhas\./);
  assert.deepEqual(opcoes(select).filter((rotulo) => rotulo.startsWith('Academias')), ['Academias — desativado'], 'o desativado só aparece como o valor atual, nunca como escolha');
  assert.equal(statusDeEdicao(s), '');

  const escritor = await abrirEdicao({ permissions: ESCRITOR, items: [await registro({ nicho: 'Academias' })] });
  assert.equal(opcaoDe(seletor(escritor, 'nicho'), 'Academias — fora do catálogo').value, 'legacy', 'sem a lista dos desativados não dá para confirmar');
  assert.match(textoDoAviso(escritor, 'nicho'), /^Fora do catálogo/);
  assert.doesNotMatch(textoDaTela(escritor), /Desativado no cadastro/);
});

test('[CATFLD-10] "INFORMAR OUTRO VALOR" (só ADMIN): abre o texto livre com o foco, o valor é enviado como TEXTO e NÃO é criado no catálogo; trocar para um item e voltar não perde o que foi digitado', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [] });
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Livre');
  assert.equal(texto(s, 'nicho').hidden, true);
  await escolher(s, 'nicho', 'Informar outro valor');
  assert.equal(texto(s, 'nicho').hidden, false, 'o texto livre aparece');
  assert.equal(s.browser.document.activeElement, texto(s, 'nicho'), 'com o foco');
  assert.equal(texto(s, 'nicho').getAttribute('aria-label'), 'Nicho (outro valor)', 'e um nome acessível próprio');
  assert.match(textoDoAviso(s, 'nicho'), /Valor só deste registro: não é criado no cadastro\./);
  s.browser.type(texto(s, 'nicho'), 'Nicho de transição');
  await escolher(s, 'nicho', 'Estética');
  assert.equal(texto(s, 'nicho').hidden, true);
  await escolher(s, 'nicho', 'Informar outro valor');
  assert.equal(texto(s, 'nicho').value, 'Nicho de transição', 'o que foi digitado continua ali');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Livre', nicho: 'Nicho de transição' });
  assert.equal(s.api.store.catalogs.nichos.length, 4, 'nenhum item foi criado no catálogo');
});

test('[CATFLD-11] EDITAR UM VALOR LEGADO com a permissão comercial, sem administrar catálogos: o valor aparece como está e pode ser MANTIDO ou TROCADO por uma opção oficial — mas essa conta não vê "Informar outro valor" nem atalhos administrativos', async () => {
  const s = await abrirEdicao({ permissions: ESCRITOR, items: [await registro({ origem: 'boca a boca', servicoPotencial: 'Gestão de redes sociais' })] });
  assert.equal(opcaoDe(seletor(s, 'origem'), 'boca a boca — fora do catálogo').value, 'legacy');
  assert.ok(!opcoes(seletor(s, 'origem')).includes('Informar outro valor'));
  assert.equal(statusDeEdicao(s), '');
  await escolher(s, 'origem', 'Parceria com agência');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args[1], { origem: 'Parceria com agência' });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// CATÁLOGO VAZIO, INDISPONÍVEL E FALHA DE REDE — o CRM nunca fica bloqueado
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATFLD-12] CATÁLOGO VAZIO: o campo é de texto livre, com um aviso informativo; o ADMIN ganha o atalho para o cadastro correspondente (quem só escreve não); digitar e salvar funciona', async () => {
  const vazio = { nichos: [], origens: [], servicos: [] };
  const s = await abrirNovo({ permissions: ADMIN, items: [], catalogs: vazio });
  for (const chave of CHAVES) {
    assert.equal(visao(s, chave), 'text', chave);
    assert.equal(texto(s, chave).hidden, false);
    assert.equal(seletor(s, chave).hidden, true);
    assert.match(textoDoAviso(s, chave), /Cadastro sem itens ativos: digite o valor livremente por enquanto\./);
    assert.equal(s.browser.by.label(s.root, ROTULO[chave]), texto(s, chave), 'o rótulo leva ao texto livre');
  }
  const links = s.browser.findAll(s.root, (el) => el.localName === 'a' && /^Abrir o cadastro de/.test(el.textContent));
  assert.deepEqual(links.map((a) => [a.textContent, a.getAttribute('href')]), [['Abrir o cadastro de Nichos e Cores', '#/crm/configuracoes/nichos'], ['Abrir o cadastro de Origens dos Leads', '#/crm/configuracoes/origens'], ['Abrir o cadastro de Serviços', '#/crm/configuracoes/servicos']]);
  assert.ok(links.every((a) => a.getAttribute('target') === '_blank' && /noopener/.test(a.getAttribute('rel'))), 'abre noutra aba: o rascunho do formulário fica onde está');
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Texto');
  s.browser.type(texto(s, 'nicho'), 'Fisioterapia');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Texto', nicho: 'Fisioterapia' });

  const escritor = await abrirNovo({ permissions: ESCRITOR, items: [], catalogs: vazio });
  assert.match(textoDoAviso(escritor, 'nicho'), /Cadastro sem itens ativos/);
  assert.equal(escritor.browser.findAll(escritor.root, (el) => el.localName === 'a' && /^Abrir o cadastro de/.test(el.textContent)).length, 0, 'sem atalho para quem não administra');
});

test('[CATFLD-13] CATÁLOGO SÓ COM ITENS DESATIVADOS: sem item para escolher é "vazio" — texto livre —, e o valor de um registro que usa um desativado continua intacto', async () => {
  const { catalogItem } = await loadFixtures();
  const s = await abrirEdicao({ permissions: ADMIN, items: [await registro({ nicho: 'Academias' })], catalogs: { nichos: [catalogItem('nichos', 'Academias', { ativo: false })], origens: [], servicos: [] } });
  assert.equal(visao(s, 'nicho'), 'text');
  assert.equal(texto(s, 'nicho').value, 'Academias');
  assert.equal(statusDeEdicao(s), '');
});

test('[CATFLD-14] ATUALIZAR OPÇÕES num catálogo vazio: quando o ADMIN cadastra itens (noutra aba) e volta, "Atualizar opções" troca o texto livre pela lista SEM perder o que já foi digitado — que vira o valor atual "fora do catálogo"', async () => {
  const { catalogItem } = await loadFixtures();
  const s = await abrirNovo({ permissions: ADMIN, items: [], catalogs: { nichos: [], origens: [], servicos: [] } });
  s.browser.type(texto(s, 'nicho'), 'Nutrição esportiva');
  s.api.store.catalogs.nichos.push(catalogItem('nichos', 'Nutrição'), catalogItem('nichos', 'Psicologia'));
  const lidas = conta(s, 'listCatalog');
  await clicar(s, s.browser.by.button(aviso(s, 'nicho'), 'Atualizar opções'));
  assert.equal(conta(s, 'listCatalog'), lidas + 1, 'uma leitura só, só desse catálogo');
  assert.equal(visao(s, 'nicho'), 'select');
  assert.equal(seletor(s, 'nicho').value, 'legacy');
  assert.equal(opcaoDe(seletor(s, 'nicho'), 'Nutrição esportiva — fora do catálogo').value, 'legacy', 'o digitado virou o valor atual');
  assert.deepEqual(opcoes(seletor(s, 'nicho')).slice(2, 4), ['Nutrição', 'Psicologia']);
  assert.equal(visao(s, 'origem'), 'text', 'os outros campos seguem como estavam');
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Atualizada');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Atualizada', nicho: 'Nutrição esportiva' });
});

test('[CATFLD-15] TRÊS CATÁLOGOS INDISPONÍVEIS (503, estrutura de dados não preparada): UM só aviso, no início do formulário, diz que os campos seguem disponíveis para preenchimento manual e oferece "Verificar novamente"; os três campos não repetem o aviso; o digitado fica e criar o registro funciona', async () => {
  const { ApiError } = await loadFixtures();
  const t = await abrir({ permissions: ADMIN, items: [] });
  for (const catalogo of ['nichos', 'origens', 'servicos']) t.api.store.catalogFailures[catalogo] = new ApiError(503, 'CRM_CATALOG_PERSISTENCE', 'x');
  await t.view.show(NOVO);
  await t.browser.flush(8);

  const avisos = avisosCompartilhados(t);
  assert.equal(avisos.length, 1, 'um aviso só');
  assert.equal(avisos[0].getAttribute('data-kind'), 'unavailable');
  assert.equal(avisos[0].textContent.replace(/\s+/g, ' ').replace(/Verificar novamente$/, '').trim(), 'Os cadastros estão indisponíveis neste ambiente, então as opções oficiais não foram carregadas. Nicho, Origem do Lead e Serviço potencial continuam disponíveis para preenchimento manual, e o registro pode ser salvo normalmente.');
  assert.deepEqual(t.browser.findAll(avisos[0], (el) => el.localName === 'button').map((b) => b.textContent), ['Verificar novamente']);
  assert.equal(avisos[0].getAttribute('role'), 'status', 'anunciado sem tirar o foco');
  assert.equal(primeiroDoFormulario(t), avisos[0], 'no início do formulário, antes do primeiro bloco');
  for (const chave of CHAVES) {
    assert.equal(visao(t, chave), 'text', chave);
    assert.equal(textoDoAviso(t, chave), '', `${chave}: o campo não repete o aviso`);
    assert.equal(t.browser.findAll(aviso(t, chave), (el) => el.localName === 'button').length, 0, `${chave}: nem o "Tentar novamente"`);
    assert.ok(seletor(t, chave).getAttribute('aria-describedby').includes(avisos[0].id), 'o aviso único descreve o campo');
  }
  assert.equal((textoDaTela(t).match(/indisponíveis neste ambiente/g) || []).length, 1, 'a mensagem aparece uma vez só na tela');
  assert.doesNotMatch(textoDaTela(t), /null|undefined|\[object/);
  assert.equal(conta(t, 'listCatalog'), 3, 'uma leitura por catálogo e nada mais (sem polling)');

  // o digitado fica; "Verificar novamente" com o servidor ainda fora do ar: uma leitura por catálogo, um aviso só, o foco volta ao botão
  t.browser.type(t.browser.by.label(t.root, 'Empresa (obrigatório)'), 'Clínica Sem Catálogo');
  t.browser.type(texto(t, 'origem'), 'Indicação de colega');
  t.browser.type(t.browser.by.label(t.root, 'Valor da proposta'), '1500');
  const botaoDoAviso = t.browser.by.button(avisos[0], 'Verificar novamente');
  botaoDoAviso.focus();
  await clicar(t, botaoDoAviso);
  assert.equal(conta(t, 'listCatalog'), 6, 'três leituras, uma por catálogo');
  assert.equal(avisosCompartilhados(t).length, 1);
  assert.equal(visao(t, 'origem'), 'text');
  assert.equal(texto(t, 'origem').value, 'Indicação de colega', 'nada digitado foi tocado');
  assert.equal(conta(t, 'createCrm'), 0, '"Verificar novamente" não envia o formulário');
  assert.equal(t.browser.document.activeElement, t.browser.by.button(avisosCompartilhados(t)[0], 'Verificar novamente'), 'o foco volta ao botão (o novo, o antigo foi refeito)');

  // o CRM continua funcionando: salva o texto, e nenhum valor financeiro é inventado
  await clicar(t, botao(t, 'Criar registro'));
  assert.deepEqual(t.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Sem Catálogo', origem: 'Indicação de colega', valorProposta: 1500 });
  assert.equal(t.api.store.items[0].origem, 'Indicação de colega');
});

test('[CATFLD-16] 503 DEPOIS RECUPERADO: "Tentar novamente" vira a lista; o texto digitado é o valor atual "fora do catálogo", nada é escolhido sozinho e salvar envia exatamente o digitado', async () => {
  const { ApiError } = await loadFixtures();
  const s = await abrir({ permissions: ADMIN, items: [] });
  s.api.store.catalogFailures.origens = new ApiError(503, 'CRM_CATALOG_PERSISTENCE', 'x');
  await s.view.show(NOVO);
  await s.browser.flush(8);
  assert.equal(visao(s, 'nicho'), 'select', 'só o catálogo que falhou cai para o texto');
  assert.equal(visao(s, 'origem'), 'text');
  s.browser.type(texto(s, 'origem'), 'Rede de contatos');
  delete s.api.store.catalogFailures.origens;
  await clicar(s, s.browser.by.button(aviso(s, 'origem'), 'Tentar novamente'));
  assert.equal(visao(s, 'origem'), 'select');
  assert.equal(seletor(s, 'origem').value, 'legacy');
  assert.equal(opcaoDe(seletor(s, 'origem'), 'Rede de contatos — fora do catálogo').value, 'legacy');
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Recuperada');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Recuperada', origem: 'Rede de contatos' });
});

test('[CATFLD-17] FALHA TRANSITÓRIA DE REDE nos três catálogos: UM aviso de falha TEMPORÁRIA — sem dizer que a estrutura do banco está ausente — com "Verificar novamente"; a edição segue possível e o PATCH leva só o alterado', async () => {
  const { ApiError } = await loadFixtures();
  const s = await abrir({ permissions: ADMIN, items: [await registro({ nicho: 'Psicologia' })] });
  for (const catalogo of ['nichos', 'origens', 'servicos']) s.api.store.catalogFailures[catalogo] = new ApiError(0, 'NETWORK', '');
  await clicar(s, botao(s, 'Clínica Alfa'));
  await clicar(s, botao(s, 'Editar'));
  const avisos = avisosCompartilhados(s);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].getAttribute('data-kind'), 'network');
  assert.match(avisos[0].textContent, /^Falha temporária de conexão ao carregar as opções oficiais\. Nicho, Origem do Lead e Serviço potencial continuam disponíveis para preenchimento manual/);
  assert.doesNotMatch(avisos[0].textContent, /indispon|estrutura|banco|migration|preparada/i, 'não declara ausência da estrutura');
  assert.ok(s.browser.by.button(avisos[0], 'Verificar novamente'));
  for (const chave of CHAVES) {
    assert.equal(visao(s, chave), 'text');
    assert.equal(textoDoAviso(s, chave), '');
  }
  assert.equal(texto(s, 'nicho').value, 'Psicologia', 'o valor salvo continua ali, editável');
  s.browser.type(texto(s, 'nicho'), 'Psicologia infantil');
  s.browser.type(s.browser.by.label(gaveta(s), 'Cidade'), 'Niterói');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { nicho: 'Psicologia infantil', cidade: 'Niterói' }]);
});

test('[CATFLD-18] OUTRO ERRO (500) tem a sua mensagem e também deixa digitar; e nenhum erro de catálogo vira toast, sucesso nem mensagem de erro do formulário', async () => {
  const { ApiError } = await loadFixtures();
  const s = await abrir({ permissions: ADMIN, items: [] });
  s.api.store.catalogFailures.nichos = new ApiError(500, 'HTTP_500', '');
  await s.view.show(NOVO);
  await s.browser.flush(8);
  assert.match(textoDoAviso(s, 'nicho'), /^Não foi possível carregar as opções agora\. Digite o valor livremente/);
  assert.equal(s.browser.by.cls(s.root, 'toast').length, 0, 'sem toast');
  assert.doesNotMatch(textoDaTela(s), /Registro criado|sucesso/i);
  assert.equal(s.browser.by.cls(s.root, 'panel-message')[0].textContent.trim(), '', 'o formulário não acusa erro por causa do catálogo');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// RESPOSTA TARDIA, AVISOS DE MUDANÇA E RASCUNHO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATFLD-19] RESPOSTA TARDIA com a pessoa NO CAMPO: o texto livre não é trocado debaixo das mãos dela; ao SAIR do campo as opções aparecem e o que ela digitou é o valor atual — nada se perde', async () => {
  const s = await abrir({ permissions: ADMIN, items: [] });
  const retida = s.api.hold('listCatalog'); // a primeira leitura é a do catálogo de nichos
  await s.view.show(NOVO);
  await retida.arrived;
  assert.equal(visao(s, 'nicho'), 'text', 'enquanto carrega, o campo é de texto: nada fica bloqueado');
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Tardia');
  texto(s, 'nicho').focus();
  s.browser.type(texto(s, 'nicho'), 'Dermatologia estética');
  retida.release();
  await s.browser.flush(8);
  assert.equal(visao(s, 'nicho'), 'text', 'chegou, mas a pessoa está digitando: nada muda');
  assert.equal(texto(s, 'nicho').value, 'Dermatologia estética');
  assert.equal(s.browser.document.activeElement, texto(s, 'nicho'), 'o foco continua onde estava');
  assert.equal(visao(s, 'origem'), 'select', 'os outros campos já receberam as opções');

  sair(s, texto(s, 'nicho'));
  assert.equal(visao(s, 'nicho'), 'select');
  assert.equal(seletor(s, 'nicho').value, 'legacy');
  assert.equal(opcaoDe(seletor(s, 'nicho'), 'Dermatologia estética — fora do catálogo').value, 'legacy');
  assert.match(textoDoAviso(s, 'nicho'), /^Fora do catálogo/);
  assert.equal(s.browser.by.label(s.root, 'Empresa (obrigatório)').value, 'Clínica Tardia', 'o resto do rascunho está intacto');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Tardia', nicho: 'Dermatologia estética' });
});

test('[CATFLD-20] RESPOSTA TARDIA com a pessoa fora do campo: a lista aparece sozinha, o que foi digitado vira o valor atual e um texto idêntico a um item oficial já fica escolhido — sem criar nem trocar nada', async () => {
  const s = await abrir({ permissions: ADMIN, items: [] });
  const retida = s.api.hold('listCatalog');
  await s.view.show(NOVO);
  await retida.arrived;
  s.browser.type(texto(s, 'nicho'), 'Estética');
  retida.release();
  await s.browser.flush(8);
  assert.equal(visao(s, 'nicho'), 'select');
  assert.equal(seletor(s, 'nicho').children.find((o) => o.value === seletor(s, 'nicho').value).textContent, 'Estética', 'idêntico ao item oficial: já é ele, sem aviso');
  assert.equal(textoDoAviso(s, 'nicho'), '');
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica X');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica X', nicho: 'Estética' });
});

test('[CATFLD-21] AVISO DE MUDANÇA DOS CATÁLOGOS com a edição aberta: as opções novas chegam SEM tirar a escolha da pessoa, e só quando ela sai do campo; a escolha e o rascunho continuam', async () => {
  const { catalogItem } = await loadFixtures();
  const s = await abrirEdicao({ permissions: ADMIN, items: [await registro({ nicho: 'Psicologia' })] });
  const antes = conta(s, 'listCatalog');
  await escolher(s, 'nicho', 'Odontologia');
  seletor(s, 'nicho').focus();
  s.api.store.catalogs.nichos.push(catalogItem('nichos', 'Fisioterapia'));
  s.bus.publish('crm-catalogs:changed', { catalog: 'nichos', action: 'create', id: 'x' });
  await s.browser.flush(8);
  assert.equal(conta(s, 'listCatalog'), antes + 1, 'releu uma vez, só o catálogo que mudou');
  assert.ok(!opcoes(seletor(s, 'nicho')).includes('Fisioterapia'), 'com a lista em uso, as opções não são refeitas');
  assert.equal(seletor(s, 'nicho').children.find((o) => o.value === seletor(s, 'nicho').value).textContent, 'Odontologia', 'a escolha continua');
  sair(s, seletor(s, 'nicho'));
  assert.ok(opcoes(seletor(s, 'nicho')).includes('Fisioterapia'), 'ao sair do campo a opção nova aparece');
  assert.equal(seletor(s, 'nicho').children.find((o) => o.value === seletor(s, 'nicho').value).textContent, 'Odontologia', 'e a escolha segue a mesma');
  assert.equal(statusDeEdicao(s), 'Alterações não salvas');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { nicho: 'Odontologia' }]);
});

test('[CATFLD-22] UM ITEM ESCOLHIDO QUE DEIXA DE SER OFERECIDO (desativado noutra tela) não some do formulário: o texto escolhido vira o valor atual; nada é trocado por outra coisa', async () => {
  const s = await abrirNovo({ permissions: ESCRITOR, items: [] });
  await escolher(s, 'nicho', 'Estética');
  s.api.store.catalogs.nichos.find((item) => item.nome === 'Estética').ativo = false;
  s.bus.publish('crm-catalogs:changed', { catalog: 'nichos', action: 'deactivate', id: 'y' });
  await s.browser.flush(8);
  assert.equal(seletor(s, 'nicho').value, 'legacy');
  assert.equal(opcaoDe(seletor(s, 'nicho'), 'Estética — fora do catálogo').value, 'legacy');
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Y');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Y', nicho: 'Estética' });
});

test('[CATFLD-23] O CATÁLOGO FICA VAZIO com o formulário aberto: o valor de agora vai para o texto livre, intacto', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [] });
  await escolher(s, 'servicoPotencial', 'Criação de site');
  for (const item of s.api.store.catalogs.servicos) item.ativo = false;
  s.bus.publish('crm-catalogs:changed', { catalog: 'servicos' });
  await s.browser.flush(8);
  assert.equal(visao(s, 'servicoPotencial'), 'text');
  assert.equal(texto(s, 'servicoPotencial').value, 'Criação de site');
  assert.match(textoDoAviso(s, 'servicoPotencial'), /Cadastro sem itens ativos/);
});

test('[CATFLD-24] PROTEÇÃO DO RASCUNHO: escolher uma opção conta como alteração (o formulário pergunta antes de descartar) e o cancelamento "Continuar editando" mantém a escolha; sem escolher nada, nada pergunta', async () => {
  const s = await abrirEdicao({ items: [await registro({ nicho: 'Psicologia' })] });
  assert.equal(s.view.hasUnsavedChanges(), false);
  await escolher(s, 'nicho', 'Odontologia');
  assert.equal(s.view.hasUnsavedChanges(), true, 'a escolha é uma alteração não salva');
  assert.equal(s.view.leaveState(), 'unsaved');
  await clicar(s, botao(s, 'Cancelar'));
  const modal = s.browser.find(s.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
  assert.ok(modal, 'perguntou');
  assert.match(modal.textContent, /Descartar alterações\?/);
  await clicar(s, s.browser.by.button(modal, 'Continuar editando'));
  assert.equal(seletor(s, 'nicho').children.find((o) => o.value === seletor(s, 'nicho').value).textContent, 'Odontologia', 'a escolha continua');
  assert.equal(conta(s, 'updateCrm'), 0);
  await escolher(s, 'nicho', 'Psicologia');
  assert.equal(s.view.hasUnsavedChanges(), false, 'voltar ao valor original não é alteração');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// DINHEIRO, PERMISSÕES, SEM INTEGRAÇÃO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATFLD-25] NENHUM VALOR FINANCEIRO é tocado: escolher um serviço (que tem preço de referência no catálogo) não preenche nem altera valor da proposta ou valor total, e o corpo enviado não os leva', async () => {
  const s = await abrirEdicao({ items: [await registro({ servicoPotencial: null })] });
  assert.equal(s.browser.by.label(gaveta(s), 'Valor da proposta').value, '1500');
  assert.equal(s.browser.by.label(gaveta(s), 'Valor total').value, '3000');
  await escolher(s, 'servicoPotencial', 'Criação de site');
  assert.equal(s.browser.by.label(gaveta(s), 'Valor da proposta').value, '1500', 'o preço de referência (4800) não vira valor de proposta');
  assert.equal(s.browser.by.label(gaveta(s), 'Valor total').value, '3000');
  assert.ok(!/4\.?800|4800|1999/.test(textoDaTela(s)), 'o preço de referência nem aparece no formulário do CRM');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { servicoPotencial: 'Criação de site' }]);
  assert.equal(s.api.store.items[0].valorProposta, 1500);
  assert.equal(s.api.store.items[0].valorTotal, 3000);

  const novo = await abrirNovo({ permissions: ADMIN, items: [] });
  novo.browser.type(novo.browser.by.label(novo.root, 'Empresa (obrigatório)'), 'Sem Valor');
  await escolher(novo, 'servicoPotencial', 'Gestão de redes sociais');
  await clicar(novo, botao(novo, 'Criar registro'));
  assert.deepEqual(Object.keys(novo.api.callsOf('createCrm')[0].args[0]).sort(), ['empresa', 'servicoPotencial']);
});

test('[CATFLD-26] SÓ UM SERVIÇO por registro: o campo de serviço é uma escolha única (nada de seleção múltipla) e grava um único nome', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [] });
  assert.equal(seletor(s, 'servicoPotencial').getAttribute('multiple'), null);
  assert.equal(seletor(s, 'servicoPotencial').localName, 'select');
});

test('[CATFLD-27] PERMISSÕES: quem só lê o CRM (COMMERCIAL_CLOSER) não tem formulário e NENHUM catálogo é consultado; sem READ:CRM os campos ficam como sempre foram e nada é consultado', async () => {
  const closer = await abrir({ permissions: CLOSER });
  await clicar(closer, botao(closer, 'Clínica Alfa'));
  assert.equal(botao(closer, 'Editar'), null);
  assert.equal(conta(closer, 'listCatalog'), 0, 'nenhuma consulta: formulário nenhum');
  await closer.view.show(NOVO);
  await closer.browser.flush(8);
  assert.match(textoDaTela(closer), /Sua conta não pode criar registros no CRM/);
  assert.equal(conta(closer, 'listCatalog'), 0);

  const semLeitura = await abrirNovo({ permissions: { canReadCrm: false, canWriteCrm: true } });
  assert.equal(conta(semLeitura, 'listCatalog'), 0);
  assert.equal(bloco(semLeitura, 'nicho'), null, 'sem o campo de catálogo');
  assert.equal(texto(semLeitura, 'nicho').getAttribute('list'), 'crm-suggest-nicho', 'o campo de texto de sempre, com as sugestões dos registros');
});

test('[CATFLD-28] SEM INTEGRAÇÃO (API sem listCatalog): o formulário é o de SEMPRE — texto livre com sugestões dos registros —, sem avisos nem leituras; criar e editar enviam o digitado', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [await registro({ nicho: 'Psicologia' })], semCatalogos: true });
  assert.equal(s.api.listCatalog, undefined);
  for (const chave of CHAVES) {
    assert.equal(bloco(s, chave), null, chave);
    assert.equal(seletor(s, chave), null);
    assert.equal(texto(s, chave).getAttribute('list'), `crm-suggest-${chave}`);
  }
  assert.doesNotMatch(textoDaTela(s), /opções oficiais|cadastro/i);
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Clássica');
  s.browser.type(texto(s, 'nicho'), 'Qualquer texto');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Clássica', nicho: 'Qualquer texto' });
});

test('[CATFLD-29] CONSULTAS: uma leitura por catálogo ao abrir o formulário; reabrir com o cache valendo não lê de novo; a lista do CRM (sem formulário) nunca consulta catálogos', async () => {
  const s = await abrir({ permissions: ADMIN });
  assert.equal(conta(s, 'listCatalog'), 0, 'só a lista: nada de catálogos');
  await clicar(s, botao(s, 'Clínica Alfa'));
  assert.equal(conta(s, 'listCatalog'), 0, 'abrir a ficha (leitura) também não consulta');
  await clicar(s, botao(s, 'Editar'));
  assert.equal(conta(s, 'listCatalog'), 3);
  await clicar(s, botao(s, 'Cancelar'));
  await clicar(s, botao(s, 'Editar'));
  assert.equal(conta(s, 'listCatalog'), 3, 'cache valendo: reabrir não lê de novo');
});

test('[CATFLD-30] DESCARTE: os campos assinam o catálogo só enquanto o formulário existe — fechar a edição, sair do "Novo registro" e destruir a tela soltam as assinaturas (nada pendurado, nada atualizado em tela morta)', async () => {
  const s = await abrirEdicao({ permissions: ADMIN, items: [await registro({ nicho: 'Psicologia' })] });
  const lidas = conta(s, 'listCatalog');
  await clicar(s, botao(s, 'Cancelar'));
  s.bus.publish('crm-catalogs:changed', { catalog: 'nichos' });
  await s.browser.flush(8);
  assert.equal(conta(s, 'listCatalog'), lidas, 'o formulário fechou: ninguém espera o catálogo, nenhuma releitura');

  await s.view.show(NOVO);
  await s.browser.flush(8);
  await s.view.show({ name: 'crm-list' });
  s.bus.publish('crm-catalogs:changed', { catalog: 'origens' });
  await s.browser.flush(8);
  const depois = conta(s, 'listCatalog');
  s.view.destroy();
  s.bus.publish('crm-catalogs:changed', { catalog: 'servicos' });
  await s.browser.flush(8);
  assert.equal(conta(s, 'listCatalog'), depois, 'tela destruída: não escuta o barramento');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// TECLADO, MÓVEL E REGRESSÕES
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATFLD-31] TECLADO: a lista é um <select> nativo (setas, digitação e Tab do navegador); o texto livre escondido não entra na ordem do Tab; "Informar outro valor" leva o foco ao texto; avisos e ações são botões e links nativos', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [] });
  assert.equal(seletor(s, 'nicho').localName, 'select');
  assert.equal(seletor(s, 'nicho').getAttribute('tabindex'), null, 'sem tabindex improvisado');
  assert.equal(texto(s, 'nicho').hidden, true);
  seletor(s, 'nicho').focus();
  s.browser.press('Tab');
  assert.notEqual(s.browser.document.activeElement, texto(s, 'nicho'), 'o campo escondido não recebe o foco');
  assert.ok(s.browser.document.activeElement, 'o foco seguiu para o próximo controle');
  await escolher(s, 'nicho', 'Informar outro valor');
  assert.equal(s.browser.document.activeElement, texto(s, 'nicho'));
  assert.equal(aviso(s, 'nicho').getAttribute('aria-live'), 'polite', 'avisos anunciados sem tirar o foco');

  const falho = await abrir({ permissions: ADMIN, items: [] });
  const { ApiError } = await loadFixtures();
  falho.api.store.catalogFailures.nichos = new ApiError(503, 'x', 'x');
  await falho.view.show(NOVO);
  await falho.browser.flush(8);
  const tentar = falho.browser.by.button(aviso(falho, 'nicho'), 'Tentar novamente');
  assert.equal(tentar.localName, 'button');
  assert.equal(tentar.getAttribute('type'), 'button', 'não envia o formulário');
  tentar.focus();
  delete falho.api.store.catalogFailures.nichos;
  falho.browser.press('Enter');
  await falho.browser.flush(8);
  assert.equal(visao(falho, 'nicho'), 'select', 'Enter no botão tenta de novo');
  assert.equal(conta(falho, 'createCrm'), 0, 'e não criou nada');
});

test('[CATFLD-32] CELULAR: o CSS do campo é responsivo (uma coluna, controles de largura total, botões de aviso com área de toque maior em tela estreita) e usa só classes — nenhum estilo inline', () => {
  const css = read('dashboard', 'styles.css');
  assert.match(css, /\.catalog-field \{ display: grid; gap: 6px; min-width: 0; \}/);
  assert.match(css, /\.catalog-field \[hidden\] \{ display: none; \}/);
  assert.match(css, /\.catalog-field-note:empty \{ display: none; \}/);
  assert.match(css, /select \{[^}]*width: 100%/, 'a lista ocupa a largura toda do campo');
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.catalog-field-note \.btn, \.catalog-notice \.btn \{ min-height: 40px; \}\s*\}/);
  assert.match(css, /select\[aria-invalid="true"\] \{ border-color: var\(--danger\); \}/);
  assert.match(css, /\.form-grid \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(240px, 1fr\)\)/, 'a grade dos formulários continua se adaptando');
  assert.doesNotMatch(read('dashboard', 'ui', 'catalogField.mjs').replace(/\/\/.*$/gm, ''), /\bstyle\b/);
});

test('[CATFLD-33] REGRESSÃO — Fila de Aprovação, Prospecção e promoção: nenhuma dessas telas (nem nada em src/) conhece a consulta ou o campo de catálogo; o mapeamento da promoção continua copiando o texto do jeito de sempre', () => {
  const importadores = [];
  for (const dir of [['dashboard'], ['dashboard', 'views'], ['dashboard', 'ui']]) {
    for (const arquivo of fs.readdirSync(path.join(__dirname, '..', '..', ...dir))) {
      if (!arquivo.endsWith('.mjs')) continue;
      if (MARCA_DA_SELECAO.test(read(...dir, arquivo).replace(/\/\/.*$/gm, ''))) importadores.push([...dir, arquivo].join('/'));
    }
  }
  assert.deepEqual(importadores.sort(), ['dashboard/api.mjs', 'dashboard/crm-catalog-lookup.mjs', 'dashboard/ui/catalogField.mjs', 'dashboard/views/catalogs.mjs', 'dashboard/views/crm.mjs'], 'só o cliente de API, as telas dos catálogos e do CRM e os módulos da seleção falam de catálogos');
  for (const tela of ['approvals', 'prospecting', 'prospectingHistory', 'prospectingExclusions', 'rejectedLeads', 'leadProfile', 'jobDetails', 'funnels', 'overview']) {
    assert.doesNotMatch(read('dashboard', 'views', `${tela}.mjs`), MARCA_DA_SELECAO, `${tela}.mjs não conhece a consulta de catálogos`);
  }
  const ocorrencias = [];
  const varrer = (dir) => {
    for (const entrada of fs.readdirSync(path.join(__dirname, '..', '..', dir), { withFileTypes: true })) {
      const rel = `${dir}/${entrada.name}`;
      if (entrada.isDirectory()) varrer(rel);
      else if (/\.js$/.test(entrada.name) && MARCA_DA_SELECAO.test(read(rel))) ocorrencias.push(rel);
    }
  };
  varrer('src');
  assert.deepEqual(ocorrencias, [], 'o servidor não sabe nada disto');
  const { mapProspectToCrmFields, DIRECT_FIELDS } = require('../../src/services/prospectToCrmFields');
  assert.deepEqual(DIRECT_FIELDS.find(([crm]) => crm === 'nicho'), ['nicho', 'nicho']);
  assert.deepEqual(mapProspectToCrmFields({ empresa: 'Clínica Bella', discoverySnapshot: { nicho: 'clinica de EStética' } }), { empresa: 'Clínica Bella', nicho: 'clinica de EStética' }, 'a promoção continua copiando o texto exato');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// REFINAMENTO FINAL DA 2B-3.1 — aviso único de indisponibilidade, "Origem do Lead" e layout
// ---------------------------------------------------------------------------------------------------------------------------------------------

const falhar = async (s, falhas) => {
  const { ApiError } = await loadFixtures();
  const erros = { 503: () => new ApiError(503, 'CRM_CATALOG_PERSISTENCE', 'x'), rede: () => new ApiError(0, 'NETWORK', ''), 500: () => new ApiError(500, 'HTTP_500', '') };
  for (const [catalogo, tipo] of Object.entries(falhas)) s.api.store.catalogFailures[catalogo] = erros[tipo]();
};

test('[CATFLD-34] SÓ UM CATÁLOGO INDISPONÍVEL: nenhum aviso compartilhado — o aviso é específico, só do campo daquele catálogo, com "Tentar novamente"; os outros dois campos seguem como lista; vale para Novo registro e Editar', async () => {
  for (const modo of ['novo', 'edicao']) {
    const s = modo === 'novo' ? await abrir({ permissions: ADMIN, items: [] }) : await abrir({ permissions: ADMIN, items: [await registro({ nicho: 'Psicologia' })] });
    await falhar(s, { servicos: 503 });
    if (modo === 'novo') {
      await s.view.show(NOVO);
      await s.browser.flush(8);
    } else {
      await clicar(s, botao(s, 'Clínica Alfa'));
      await clicar(s, botao(s, 'Editar'));
    }
    assert.equal(avisosCompartilhados(s).length, 0, `${modo}: nada compartilhado`);
    assert.equal(visao(s, 'nicho'), 'select');
    assert.equal(visao(s, 'origem'), 'select');
    assert.equal(visao(s, 'servicoPotencial'), 'text');
    assert.match(textoDoAviso(s, 'servicoPotencial'), /^Opções oficiais indisponíveis neste ambiente\. Digite o valor livremente; o registro é salvo normalmente\./);
    assert.ok(s.browser.by.button(aviso(s, 'servicoPotencial'), 'Tentar novamente'));
    assert.equal(textoDoAviso(s, 'nicho'), '', 'os campos que carregaram não têm aviso de falha');
    assert.equal(s.browser.by.button(s.root, 'Verificar novamente'), null, 'sem o botão compartilhado');
  }
});

test('[CATFLD-35] DOIS CATÁLOGOS INDISPONÍVEIS pelo mesmo motivo (e um carregou): ainda NÃO é o aviso compartilhado — cada campo falho mantém o seu aviso específico', async () => {
  const s = await abrir({ permissions: ADMIN, items: [] });
  await falhar(s, { nichos: 503, origens: 503 });
  await s.view.show(NOVO);
  await s.browser.flush(8);
  assert.equal(avisosCompartilhados(s).length, 0);
  assert.match(textoDoAviso(s, 'nicho'), /^Opções oficiais indisponíveis neste ambiente\./);
  assert.match(textoDoAviso(s, 'origem'), /^Opções oficiais indisponíveis neste ambiente\./);
  assert.equal(visao(s, 'servicoPotencial'), 'select');
  assert.equal(textoDoAviso(s, 'servicoPotencial'), '');
});

test('[CATFLD-36] MOTIVOS DIFERENTES (503, falha de rede e outro erro): sem aviso compartilhado — cada campo diz o seu motivo, sem confundir estrutura indisponível com rede nem com erro', async () => {
  const s = await abrir({ permissions: ADMIN, items: [] });
  await falhar(s, { nichos: 503, origens: 'rede', servicos: 500 });
  await s.view.show(NOVO);
  await s.browser.flush(8);
  assert.equal(avisosCompartilhados(s).length, 0);
  assert.match(textoDoAviso(s, 'nicho'), /^Opções oficiais indisponíveis neste ambiente\./);
  assert.match(textoDoAviso(s, 'origem'), /^Falha temporária de conexão ao carregar as opções\./);
  assert.match(textoDoAviso(s, 'servicoPotencial'), /^Não foi possível carregar as opções agora\./);
  assert.doesNotMatch(textoDoAviso(s, 'origem'), /indispon|estrutura/i);
  for (const chave of CHAVES) {
    assert.equal(visao(s, chave), 'text');
    assert.ok(s.browser.by.button(aviso(s, chave), 'Tentar novamente'));
  }
});

test('[CATFLD-37] OUTRO ERRO nos três catálogos (500): um aviso compartilhado do MESMO tipo, com o texto de erro — não o de rede nem o de estrutura indisponível', async () => {
  const s = await abrir({ permissions: ADMIN, items: [] });
  await falhar(s, { nichos: 500, origens: 500, servicos: 500 });
  await s.view.show(NOVO);
  await s.browser.flush(8);
  const [aviso1, ...resto] = avisosCompartilhados(s);
  assert.equal(resto.length, 0);
  assert.equal(aviso1.getAttribute('data-kind'), 'error');
  assert.match(aviso1.textContent, /^Não foi possível carregar as opções oficiais agora\. Nicho, Origem do Lead e Serviço potencial continuam disponíveis para preenchimento manual/);
  assert.doesNotMatch(aviso1.textContent, /indispon|conexão/i);
});

test('[CATFLD-38] CATÁLOGOS VAZIOS não entram no aviso compartilhado: cada campo mantém o seu aviso de "cadastro sem itens ativos" (cada um com o atalho do próprio cadastro) — vazio não é falha', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [], catalogs: { nichos: [], origens: [], servicos: [] } });
  assert.equal(avisosCompartilhados(s).length, 0);
  for (const chave of CHAVES) assert.match(textoDoAviso(s, chave), /^Cadastro sem itens ativos: digite o valor livremente por enquanto\./);
  assert.equal(s.browser.findAll(s.root, (el) => el.localName === 'a' && /^Abrir o cadastro de/.test(el.textContent)).length, 3);
  assert.equal(s.browser.by.button(s.root, 'Verificar novamente'), null);
});

test('[CATFLD-39] RECUPERAÇÃO após "Verificar novamente": uma leitura por catálogo; o aviso some; as listas aparecem; o digitado vira o valor atual "fora do catálogo" (nada é apagado nem escolhido); o foco vai para o primeiro campo; sem toast nem sucesso falso', async () => {
  const s = await abrir({ permissions: ADMIN, items: [] });
  await falhar(s, { nichos: 503, origens: 503, servicos: 503 });
  await s.view.show(NOVO);
  await s.browser.flush(8);
  s.browser.type(texto(s, 'nicho'), 'Fisioterapia');
  s.browser.type(texto(s, 'servicoPotencial'), 'Consultoria geral');
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Recuperada');
  s.api.store.catalogFailures = {};
  const verificar = s.browser.by.button(avisosCompartilhados(s)[0], 'Verificar novamente');
  verificar.focus();
  await clicar(s, verificar);
  assert.equal(conta(s, 'createCrm'), 0, '"Verificar novamente" não envia o formulário');
  assert.equal(conta(s, 'listCatalog'), 6, 'três leituras iniciais mais três de "Verificar novamente"');
  assert.equal(avisosCompartilhados(s).length, 0, 'o aviso saiu de cena');
  for (const chave of CHAVES) assert.equal(visao(s, chave), 'select', chave);
  assert.equal(opcaoDe(seletor(s, 'nicho'), 'Fisioterapia — fora do catálogo').value, 'legacy');
  assert.equal(seletor(s, 'nicho').value, 'legacy');
  assert.equal(opcaoDe(seletor(s, 'servicoPotencial'), 'Consultoria geral — fora do catálogo').value, 'legacy');
  assert.equal(seletor(s, 'origem').value, 'none', 'o que estava vazio continua vazio: nada é escolhido sozinho');
  assert.equal(s.browser.document.activeElement, seletor(s, 'nicho'), 'o foco vai para o primeiro campo do catálogo');
  assert.equal(s.browser.by.cls(s.root, 'toast').length, 0);
  assert.doesNotMatch(textoDaTela(s), /Registro criado|sucesso/i);
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Recuperada', nicho: 'Fisioterapia', servicoPotencial: 'Consultoria geral' });
});

test('[CATFLD-40] RECUPERAÇÃO PARCIAL: se só alguns catálogos voltam, o aviso compartilhado é trocado pelo aviso específico do que ainda falha (com o seu "Tentar novamente"), e os que voltaram viram lista', async () => {
  const s = await abrir({ permissions: ADMIN, items: [] });
  await falhar(s, { nichos: 503, origens: 503, servicos: 503 });
  await s.view.show(NOVO);
  await s.browser.flush(8);
  assert.equal(avisosCompartilhados(s).length, 1);
  delete s.api.store.catalogFailures.nichos;
  delete s.api.store.catalogFailures.servicos;
  await clicar(s, s.browser.by.button(avisosCompartilhados(s)[0], 'Verificar novamente'));
  assert.equal(avisosCompartilhados(s).length, 0);
  assert.equal(visao(s, 'nicho'), 'select');
  assert.equal(visao(s, 'servicoPotencial'), 'select');
  assert.equal(visao(s, 'origem'), 'text');
  assert.match(textoDoAviso(s, 'origem'), /^Opções oficiais indisponíveis neste ambiente\./);
  // o botão do campo funciona: ao voltar o último, o campo vira lista
  delete s.api.store.catalogFailures.origens;
  await clicar(s, s.browser.by.button(aviso(s, 'origem'), 'Tentar novamente'));
  assert.equal(visao(s, 'origem'), 'select');
  assert.equal(conta(s, 'listCatalog'), 3 + 3 + 1);
});

test('[CATFLD-41] EDITAR com os três catálogos indisponíveis: o aviso único fica ACIMA das abas, os valores legados continuam exatamente como estavam (editáveis), abrir não altera nada e o PATCH leva só o que a pessoa mudou', async () => {
  const s = await abrir({ permissions: ADMIN, items: [await registro({ nicho: 'Clínicas veterinárias', origem: 'boca a boca', servicoPotencial: 'Consultoria geral' })] });
  await falhar(s, { nichos: 503, origens: 503, servicos: 503 });
  await clicar(s, botao(s, 'Clínica Alfa'));
  await clicar(s, botao(s, 'Editar'));
  const avisos = avisosCompartilhados(s);
  assert.equal(avisos.length, 1, 'também na edição');
  assert.ok(gaveta(s).contains(avisos[0]));
  assert.equal(primeiroDoFormulario(s), avisos[0]);
  const formularioDaEdicao = formulario(s);
  assert.equal(formularioDaEdicao.children.indexOf(avisos[0]), 0, 'antes das abas');
  assert.equal(formularioDaEdicao.children.length, 2, 'o aviso e as abas');
  assert.deepEqual(CHAVES.map((chave) => texto(s, chave).value), ['Clínicas veterinárias', 'boca a boca', 'Consultoria geral']);
  assert.equal(statusDeEdicao(s), '', 'abrir não altera nada');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.equal(conta(s, 'updateCrm'), 0, 'nada a enviar');
  s.browser.type(texto(s, 'origem'), 'indicação de cliente');
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.api.callsOf('updateCrm')[0].args, ['crm:a', { origem: 'indicação de cliente' }], 'só o campo mudado');
  assert.equal(s.api.store.items[0].valorProposta, 1500, 'nenhum valor financeiro foi tocado');
  assert.equal(s.api.store.items[0].valorTotal, 3000);
  assert.equal(s.api.store.items[0].nicho, 'Clínicas veterinárias');
});

test('[CATFLD-42] SEM FALHA NÃO HÁ AVISO: com os catálogos respondendo, ou ainda carregando, nenhum aviso compartilhado aparece (ele só surge com a falha CONFIRMADA dos três), e a abertura faz só uma leitura por catálogo', async () => {
  const s = await abrir({ permissions: ADMIN, items: [] });
  const retida = s.api.hold('listCatalog');
  await s.view.show(NOVO);
  await retida.arrived;
  assert.equal(avisosCompartilhados(s).length, 0, 'carregando não é falha');
  retida.release();
  await s.browser.flush(8);
  assert.equal(avisosCompartilhados(s).length, 0);
  assert.equal(conta(s, 'listCatalog'), 3);
  await s.browser.flush(8);
  assert.equal(conta(s, 'listCatalog'), 3, 'sem polling');
});

test('[CATFLD-43] O AVISO CHEGA DEPOIS e o RASCUNHO fica: a pessoa já está digitando no Nicho quando as leituras falham — o texto e o foco continuam, o aviso único aparece no topo e nada é trocado debaixo das mãos dela', async () => {
  const { ApiError } = await loadFixtures();
  const s = await abrir({ permissions: ADMIN, items: [] });
  await falhar(s, { nichos: 503, origens: 503, servicos: 503 });
  const retida = s.api.hold('listCatalog');
  await s.view.show(NOVO);
  await retida.arrived;
  texto(s, 'nicho').focus();
  s.browser.type(texto(s, 'nicho'), 'Dermatologia');
  assert.equal(avisosCompartilhados(s).length, 0);
  retida.fail(new ApiError(503, 'CRM_CATALOG_PERSISTENCE', 'x'));
  await s.browser.flush(8);
  assert.equal(avisosCompartilhados(s).length, 1, 'o aviso apareceu');
  assert.equal(textoDoAviso(s, 'origem'), '', 'os avisos que os campos já mostravam saíram de cena: agora quem fala é o aviso único');
  assert.equal(textoDoAviso(s, 'servicoPotencial'), '');
  assert.equal(texto(s, 'nicho').value, 'Dermatologia');
  assert.equal(s.browser.document.activeElement, texto(s, 'nicho'), 'o foco continua no campo');
  assert.equal(visao(s, 'nicho'), 'text');
});

test('[CATFLD-44] NOMENCLATURA: o rótulo visível é "Origem do Lead" (formulários e ficha de leitura); o campo técnico `origem`, o id do campo, o corpo da API e os demais rótulos NÃO mudaram — nenhum "Origem" solto sobra no formulário', async () => {
  const s = await abrirNovo({ permissions: ADMIN, items: [] });
  const rotulos = s.browser.findAll(s.root, (el) => el.localName === 'label').map((l) => l.textContent.trim());
  assert.ok(rotulos.includes('Origem do Lead'));
  assert.ok(!rotulos.includes('Origem'), 'o rótulo antigo não existe mais');
  assert.deepEqual(rotulos.filter((r) => /Nicho|Serviço|Raio-X/.test(r)), ['Nicho', 'Serviço potencial', 'Raio-X de nicho', 'Raio-X personalizado', 'Link do Raio-X'], 'os outros rótulos continuam como eram');
  assert.equal(s.browser.by.label(s.root, 'Origem do Lead'), seletor(s, 'origem'));
  assert.equal(seletor(s, 'origem').getAttribute('id'), 'crm-field-origem-select');
  assert.equal(texto(s, 'origem').getAttribute('name'), 'origem', 'o nome técnico do campo');
  assert.equal(texto(s, 'origem').getAttribute('aria-label'), 'Origem do Lead (outro valor)');
  await escolher(s, 'origem', 'Indicação');
  s.browser.type(s.browser.by.label(s.root, 'Empresa (obrigatório)'), 'Clínica Nome');
  await clicar(s, botao(s, 'Criar registro'));
  assert.deepEqual(s.api.callsOf('createCrm')[0].args[0], { empresa: 'Clínica Nome', origem: 'Indicação' }, 'a API continua recebendo `origem`');

  // a edição e a ficha de leitura
  const e = await abrirEdicao({ items: [await registro({ origem: 'Indicação' })] });
  assert.equal(e.browser.by.label(gaveta(e), 'Origem do Lead'), seletor(e, 'origem'));
  await clicar(e, botao(e, 'Cancelar'));
  const leitura = e.browser.findAll(gaveta(e), (el) => el.localName === 'dt').map((dt) => dt.textContent.trim());
  assert.ok(leitura.includes('Origem do Lead') && !leitura.includes('Origem'), 'a ficha mostra o mesmo rótulo');

  // só o rótulo mudou: o modelo continua com as mesmas chaves e a mesma quantidade de campos
  const { FIELD_GROUPS, WRITABLE_KEYS, EDITABLE_FIELDS } = await import('../../dashboard/crm-model.mjs');
  const campos = FIELD_GROUPS.flatMap((grupo) => grupo.fields);
  assert.equal(campos.find((campo) => campo.key === 'origem').label, 'Origem do Lead');
  assert.equal(WRITABLE_KEYS.length, 31, 'os 31 campos do CRM');
  assert.deepEqual([...WRITABLE_KEYS].sort(), [...CRM_WRITABLE_FIELDS].sort(), 'as mesmas chaves do servidor');
  assert.equal(EDITABLE_FIELDS.length, 31);
  assert.equal(campos.length, 33, 'os 31 graváveis e os 2 só de exibição (status e data de entrada)');
  assert.deepEqual(campos.filter((campo) => /Origem/.test(campo.label)).map((campo) => campo.key), ['origem']);
});

test('[CATFLD-45] LAYOUT: o aviso único é um bloco no topo do formulário (acima do primeiro bloco e das abas), os avisos de campo são curtos, a grade do formulário alinha pelo topo (uma coluna mais alta não estica o campo vizinho) e há regras para o celular — sem reformular o formulário', async () => {
  const css = read('dashboard', 'styles.css');
  assert.match(css, /\.catalog-notice \{ display: grid; gap: 8px; justify-items: start; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var\(--line\); border-radius: 10px; background: var\(--info-bg\); color: var\(--info-text\);/);
  assert.match(css, /\.catalog-notice\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.field-form \.form-grid \{ align-items: start; \}/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.catalog-field-note \.btn, \.catalog-notice \.btn \{ min-height: 40px; \}\s*\}/);
  assert.match(css, /\.form-grid \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(240px, 1fr\)\)/, 'a grade e as divisões atuais continuam');
  // os textos de aviso de UM campo são curtos: nenhum passa de 120 caracteres (um aviso comprido deixa a coluna mais alta)
  const { FIELD_TEXT } = await import('../../dashboard/ui/catalogField.mjs');
  for (const [nome, valor] of Object.entries(FIELD_TEXT)) {
    const texto = typeof valor === 'function' ? valor('Clínicas de estética') : valor;
    assert.ok(texto.length <= 120, `${nome}: ${texto.length} caracteres`);
  }
  // com o aviso único, a tela tem UMA mensagem de indisponibilidade em vez de três
  const s = await abrirNovo({ permissions: ADMIN, items: [] });
  assert.equal(avisosCompartilhados(s).length, 0);
  assert.equal(formulario(s).children.filter((el) => !el.hidden)[0].localName, 'fieldset', 'sem falha, o formulário começa pelo primeiro bloco');
  assert.equal(formulario(s).children.filter((el) => el.localName === 'fieldset').length, 6, 'as seis divisões atuais do formulário continuam');
});
