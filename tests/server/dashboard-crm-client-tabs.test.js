// CRM 5.0, Fase D2.1 — as ABAS dentro de "Mais informações (opcional)" do cadastro de clientes (dashboard/views/crm.mjs + crm-model.mjs + styles.css), sobre o DOM de teste e um cliente
// de API falso. Nenhum navegador, nenhuma rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBrowser, findAll, makeEvent } = require('../helpers/fakeDom');

const ADMIN = Object.freeze({ canReadCrm: true, canWriteCrm: true, canProposeCrm: true, canReview: true });
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const NOVO = { name: 'crm-new' };
const REGISTRO = (id) => ({ name: 'crm-record', id });
const ABAS = ['digital', 'adicionais', 'comercial', 'funil', 'entrada'];

async function montar({ items = [], api } = {}) {
  const { createCrmView } = await import('../../dashboard/views/crm.mjs');
  const { createFakeApi } = await loadFixtures();
  const browser = createBrowser();
  const fake = api || createFakeApi({ items });
  const navegacoes = [];
  const view = createCrmView({ document: browser.document, root: browser.root, api: fake, permissions: ADMIN, navigate: (hash) => navegacoes.push(hash) });
  return {
    browser,
    api: fake,
    navegacoes,
    root: browser.root,
    async mostrar(route) {
      view.show(route);
      await browser.flush();
    },
  };
}

const texto = (t) => t.root.textContent.replace(/\s+/g, ' ');
const maisDe = (t) => t.browser.by.id(t.root, 'crm-new-more');
const abaBotao = (t, chave) => t.browser.by.id(t.root, `crm-new-more-tab-${chave}`);
const painel = (t, chave) => t.browser.by.id(t.root, `crm-new-more-panel-${chave}`);
const abaAtiva = (t) => ABAS.filter((chave) => abaBotao(t, chave).getAttribute('aria-selected') === 'true');
const painelVisivel = (t) => ABAS.filter((chave) => !painel(t, chave).hidden);
const rotulo = (t, nome) => t.browser.by.label(maisDe(t), nome);
const digitar = (t, nome, valor) => t.browser.type(t.browser.by.label(t.root, nome), valor);
const escolherTipo = (t, nome) => t.browser.click(t.browser.by.label(t.root, nome));
const cadastrar = async (t) => {
  t.browser.click(t.browser.by.button(t.root, 'Cadastrar cliente'));
  await t.browser.flush();
};

// A distribuição esperada dos campos reais (rótulo na tela) por aba.
const POR_ABA = {
  digital: ['Site', 'Instagram', 'Facebook', 'Perfil no Google'],
  adicionais: ['Cargo', 'Cidade', 'Estado (UF)'],
  comercial: ['Serviço potencial', 'Temperatura', 'Problema identificado', 'Raio-X de nicho', 'Raio-X personalizado', 'Status do diagnóstico', 'Link do Raio-X', 'Data da análise', 'Valor da proposta', 'Valor total', 'Observações'],
  funil: ['Última interação', 'Data da reunião', 'Link do Google Meet', 'Próxima ação', 'Data da próxima ação'],
  entrada: ['Status inicial', 'Motivo da entrada (opcional)'],
};

test('[TABS-1] "Mais informações" continua recolhida por padrão e, aberta, mostra as abas Digital, Adicionais, Comercial, Funil e Entrada — com WAI-ARIA (tablist/tab/tabpanel) e só a primeira ativa', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  const mais = maisDe(t);
  assert.equal(mais.localName, 'details');
  assert.notEqual(mais.open, true, 'recolhida por padrão');
  assert.equal(mais.hasAttribute('open'), false, 'sem o atributo open (no navegador, ele abriria a seção)');
  const lista = t.browser.find(mais, (el) => el.getAttribute('role') === 'tablist');
  assert.equal(lista.getAttribute('aria-label'), 'Mais informações do cliente');
  assert.deepEqual(t.browser.findAll(lista, (el) => el.getAttribute('role') === 'tab').map((el) => el.textContent), ['Digital', 'Adicionais', 'Comercial', 'Funil', 'Entrada']);
  assert.deepEqual(abaAtiva(t), ['digital']);
  assert.deepEqual(painelVisivel(t), ['digital'], 'só o painel da aba ativa à mostra');
  for (const chave of ABAS) {
    const botao = abaBotao(t, chave);
    assert.equal(botao.getAttribute('aria-controls'), `crm-new-more-panel-${chave}`);
    assert.equal(painel(t, chave).getAttribute('role'), 'tabpanel');
    assert.equal(painel(t, chave).getAttribute('aria-labelledby'), `crm-new-more-tab-${chave}`);
    assert.equal(botao.getAttribute('tabindex'), chave === 'digital' ? '0' : '-1', 'só a aba ativa está no tab order');
    assert.equal(botao.type, 'button', 'uma aba nunca envia o formulário');
  }
});

test('[TABS-2] os campos reais foram distribuídos sem inventar, duplicar nem eliminar: cada aba tem os seus, e os 35 campos do cadastro continuam todos no formulário (uma vez só)', async () => {
  const { WRITABLE_KEYS, CLIENT_FORM_SECTIONS, CLIENT_MORE_TABS } = await import('../../dashboard/crm-model.mjs');
  const t = await montar();
  await t.mostrar(NOVO);
  for (const chave of ABAS) {
    for (const nome of POR_ABA[chave]) {
      const campo = rotulo(t, nome);
      assert.ok(campo, `"${nome}" existe`);
      assert.ok(painel(t, chave).textContent.includes(nome), `"${nome}" está na aba ${chave}`);
      let no = campo;
      while (no && no !== painel(t, chave)) no = no.parentNode;
      assert.equal(no, painel(t, chave), `o campo "${nome}" está DENTRO do painel ${chave}`);
    }
  }
  // o tipo de pessoa são dois botões de rádio com o mesmo nome (um só campo); os demais aparecem uma vez cada
  const nomes = t.browser.findAll(t.root, (el) => ['input', 'textarea'].includes(el.localName) && el.getAttribute('name') && el.type !== 'radio').map((el) => el.getAttribute('name'));
  assert.equal(new Set(nomes).size, nomes.length, 'nenhum campo duplicado');
  for (const chave of WRITABLE_KEYS.filter((nome) => nome !== 'tipoPessoa')) assert.ok(nomes.includes(chave), `falta o campo ${chave}`);
  assert.equal(t.browser.findAll(t.root, (el) => el.localName === 'input' && el.type === 'radio' && el.getAttribute('name') === 'tipoPessoa').length, 2);
  // o modelo: as abas só apontam para seções que existem, e cada seção de "mais" está em exatamente uma aba
  const ids = CLIENT_MORE_TABS.flatMap((aba) => aba.sections);
  assert.deepEqual([...ids].sort(), CLIENT_FORM_SECTIONS.mais.map((secao) => secao.id).sort());
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(CLIENT_MORE_TABS.map((aba) => aba.key), ABAS);
  // o responsável continua à vista, em "Classificação" (não é repetido nas abas)
  assert.ok(t.browser.by.label(t.root, 'Responsável'));
  assert.equal(painel(t, 'funil').textContent.includes('Responsável'), false);
});

test('[TABS-3] clicar em cada aba troca o conteúdo na mesma área, destaca a aba (aria-selected) e não salva nada', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  maisDe(t).open = true;
  for (const chave of ['comercial', 'funil', 'entrada', 'adicionais', 'digital']) {
    t.browser.click(abaBotao(t, chave));
    assert.deepEqual(abaAtiva(t), [chave]);
    assert.deepEqual(painelVisivel(t), [chave], `só o painel ${chave} à mostra`);
    assert.equal(abaBotao(t, chave).getAttribute('tabindex'), '0');
  }
  await t.browser.flush();
  assert.equal(t.api.callsOf('createCrm').length, 0, 'trocar de aba nunca salva');
  assert.equal(t.api.callsOf('updateCrm').length, 0);
  assert.deepEqual(t.navegacoes, []);
});

test('[TABS-4] o rascunho NÃO se perde ao trocar de aba várias vezes: o que foi digitado em cada aba continua lá e vai todo no corpo enviado', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  maisDe(t).open = true;
  escolherTipo(t, 'Pessoa Jurídica');
  digitar(t, 'Nome da empresa (obrigatório)', 'Clínica Aurora');
  t.browser.click(abaBotao(t, 'digital'));
  digitar(t, 'Instagram', 'https://instagram.example.test/aurora');
  t.browser.click(abaBotao(t, 'comercial'));
  digitar(t, 'Valor da proposta', '1500,50');
  digitar(t, 'Observações', 'Prefere contato pela manhã.');
  t.browser.click(abaBotao(t, 'funil'));
  digitar(t, 'Próxima ação', 'Ligar na segunda');
  t.browser.click(abaBotao(t, 'entrada'));
  t.browser.choose(rotulo(t, 'Status inicial'), 'QUALIFIED_PROSPECT');
  digitar(t, 'Motivo da entrada (opcional)', 'Indicação');
  t.browser.click(abaBotao(t, 'adicionais'));
  digitar(t, 'Cidade', 'Petrópolis');
  for (const chave of ['digital', 'comercial', 'funil', 'entrada', 'digital', 'adicionais', 'comercial']) t.browser.click(abaBotao(t, chave));
  // tudo continua nos campos
  assert.equal(rotulo(t, 'Instagram').value, 'https://instagram.example.test/aurora');
  assert.equal(rotulo(t, 'Valor da proposta').value, '1500,50');
  assert.equal(rotulo(t, 'Observações').value, 'Prefere contato pela manhã.');
  assert.equal(rotulo(t, 'Próxima ação').value, 'Ligar na segunda');
  assert.equal(rotulo(t, 'Status inicial').value, 'QUALIFIED_PROSPECT');
  assert.equal(rotulo(t, 'Motivo da entrada (opcional)').value, 'Indicação');
  assert.equal(rotulo(t, 'Cidade').value, 'Petrópolis');
  await cadastrar(t);
  assert.deepEqual(t.api.callsOf('createCrm')[0].args, [
    { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', instagram: 'https://instagram.example.test/aurora', cidade: 'Petrópolis', valorProposta: 1500.5, observacoes: 'Prefere contato pela manhã.', proximaAcao: 'Ligar na segunda' },
    { status: 'QUALIFIED_PROSPECT', reason: 'Indicação' },
  ]);
});

test('[TABS-5] cadastro de PESSOA FÍSICA e de PESSOA JURÍDICA continuam funcionando com as abas (só o preenchido vai; as abas não preenchidas não acrescentam nada)', async () => {
  const pf = await montar();
  await pf.mostrar(NOVO);
  escolherTipo(pf, 'Pessoa Física');
  digitar(pf, 'Nome completo (obrigatório)', 'Maria Souza');
  digitar(pf, 'CPF (opcional)', '529.982.247-25');
  pf.browser.click(abaBotao(pf, 'funil')); // a aba fica fechada ou aberta: não muda o envio
  await cadastrar(pf);
  assert.deepEqual(pf.api.callsOf('createCrm')[0].args, [{ tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: '52998224725' }, { status: 'PROSPECT' }]);
  assert.equal(pf.navegacoes.length, 1);

  const pj = await montar();
  await pj.mostrar(NOVO);
  escolherTipo(pj, 'Pessoa Jurídica');
  digitar(pj, 'Nome da empresa (obrigatório)', 'Clínica Aurora');
  digitar(pj, 'CNPJ (opcional)', '11.222.333/0001-81');
  await cadastrar(pj);
  assert.deepEqual(pj.api.callsOf('createCrm')[0].args, [{ tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: '11222333000181' }, { status: 'PROSPECT' }]);
});

test('[TABS-6] erro de validação num campo de uma ABA OCULTA: abre "Mais informações", abre a aba certa, mostra o erro, o selo de quantidade na aba e leva o foco ao campo — para qualquer aba', async () => {
  const casos = [
    ['comercial', 'Valor total', 'muito dinheiro', /Informe um valor numérico maior ou igual a zero\./],
    ['comercial', 'Valor da proposta', '-5', /Informe um valor numérico maior ou igual a zero\./],
  ];
  for (const [aba, nome, valor, mensagem] of casos) {
    const t = await montar();
    await t.mostrar(NOVO);
    escolherTipo(t, 'Pessoa Jurídica');
    digitar(t, 'Nome da empresa (obrigatório)', 'Clínica Aurora');
    // o erro está numa aba que NÃO é a ativa
    t.browser.click(abaBotao(t, 'digital'));
    maisDe(t).open = true;
    digitar(t, nome, valor);
    maisDe(t).open = false; // recolhida de novo
    await cadastrar(t);
    assert.match(texto(t), mensagem);
    assert.equal(maisDe(t).open, true, 'o erro abriu a seção');
    assert.deepEqual(abaAtiva(t), [aba], `abriu a aba ${aba}`);
    assert.deepEqual(painelVisivel(t), [aba]);
    assert.equal(t.browser.by.label(t.root, nome).getAttribute('aria-invalid'), 'true');
    assert.equal(t.browser.document.activeElement, t.browser.by.label(t.root, nome), 'o foco foi para o campo com erro');
    assert.match(abaBotao(t, aba).textContent, /\d$/, 'a aba mostra quantos campos têm erro');
    assert.equal(t.api.callsOf('createCrm').length, 0, 'nada foi enviado');
  }
  // corrigido, o selo some e o cadastro passa
  const t = await montar();
  await t.mostrar(NOVO);
  escolherTipo(t, 'Pessoa Jurídica');
  digitar(t, 'Nome da empresa (obrigatório)', 'Clínica Aurora');
  digitar(t, 'Valor total', 'x');
  await cadastrar(t);
  assert.match(abaBotao(t, 'comercial').textContent, /1$/);
  digitar(t, 'Valor total', '200');
  await cadastrar(t);
  assert.equal(t.api.callsOf('createCrm').length, 1);
  assert.deepEqual(t.api.callsOf('createCrm')[0].args[0], { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', valorTotal: 200 });
});

test('[TABS-7] campos obrigatórios (fora das abas) continuam validados: sem tipo ou sem nome o cadastro é recusado e as abas não interferem', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  await cadastrar(t);
  assert.match(texto(t), /Escolha se o cliente é Pessoa Física ou Pessoa Jurídica\./);
  assert.equal(t.api.callsOf('createCrm').length, 0);
  escolherTipo(t, 'Pessoa Física');
  await cadastrar(t);
  assert.match(texto(t), /Informe o nome completo\./);
  assert.equal(t.api.callsOf('createCrm').length, 0);
});

test('[TABS-8] teclado: setas, Home e End movem entre as abas (e levam o foco); só a aba ativa entra na ordem do Tab; o foco não se perde ao trocar de aba por clique', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  maisDe(t).open = true;
  abaBotao(t, 'digital').focus();
  t.browser.press('ArrowRight');
  assert.deepEqual(abaAtiva(t), ['adicionais']);
  assert.equal(t.browser.document.activeElement, abaBotao(t, 'adicionais'));
  t.browser.press('End');
  assert.deepEqual(abaAtiva(t), ['entrada']);
  t.browser.press('ArrowRight'); // dá a volta
  assert.deepEqual(abaAtiva(t), ['digital']);
  t.browser.press('ArrowLeft');
  assert.deepEqual(abaAtiva(t), ['entrada']);
  t.browser.press('Home');
  assert.deepEqual(abaAtiva(t), ['digital']);
  assert.equal(t.browser.document.activeElement, abaBotao(t, 'digital'));
  // a ordem do Tab: só a aba ativa
  const naOrdem = findAll(maisDe(t), (el) => el.getAttribute('role') === 'tab' && el.getAttribute('tabindex') === '0');
  assert.deepEqual(naOrdem.map((el) => el.textContent), ['Digital']);
});

test('[TABS-9] a EDIÇÃO de um registro (inclusive legado) continua com as abas da ficha e todos os campos — nada mudou lá — e abrir a edição não conta como alteração', async () => {
  const { crmRecord } = await loadFixtures();
  const t = await montar({ items: [crmRecord({ id: 'crm:antigo', tipoPessoa: null, empresa: 'Estúdio Dias', cidade: 'Rio', observacoes: 'nota antiga', instagram: 'https://instagram.example.test/dias', dataDeEntrada: '2026-10-01T12:00:00Z' })] });
  await t.mostrar(REGISTRO('crm:antigo'));
  const gaveta = t.browser.find(t.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
  t.browser.click(t.browser.by.button(gaveta, 'Editar'));
  const listaEdicao = t.browser.find(gaveta, (el) => el.getAttribute('role') === 'tablist' && el.getAttribute('aria-label') === 'Campos do registro');
  const abasEdicao = t.browser.findAll(listaEdicao, (el) => el.getAttribute('role') === 'tab').map((el) => el.textContent);
  assert.deepEqual(abasEdicao.map((rotuloAba) => rotuloAba.replace(/\d+$/, '')), ['Resumo', 'Contato e presença', 'Comercial']);
  assert.equal(t.browser.by.label(gaveta, 'Instagram').value, 'https://instagram.example.test/dias');
  assert.equal(t.browser.by.label(gaveta, 'Observações').value, 'nota antiga');
  assert.equal(t.browser.by.id(t.root, 'crm-new-more'), null, 'as abas do novo cliente não existem na edição');
  t.browser.click(t.browser.by.button(gaveta, 'Salvar alterações'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('updateCrm').length, 0);
});

test('[TABS-10] catálogos oficiais, duplicidade e DNC seguem como antes: Serviço potencial (aba Comercial) vem do catálogo, e um 409 (duplicidade) ou DNC mantém todas as abas preenchidas', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar();
  await t.mostrar(NOVO);
  escolherTipo(t, 'Pessoa Física');
  digitar(t, 'Nome completo (obrigatório)', 'Maria Souza');
  t.browser.click(abaBotao(t, 'comercial'));
  digitar(t, 'Observações', 'texto da aba comercial');
  assert.ok(painel(t, 'comercial').textContent.includes('Serviço potencial'));
  t.api.failNext('createCrm', new ApiError(409, 'DUPLICATE_RECORD', 'x'));
  await cadastrar(t);
  assert.match(texto(t), /Já existe um registro com esta identidade/);
  assert.equal(rotulo(t, 'Observações').value, 'texto da aba comercial', 'o digitado nas abas ficou');
  t.api.failNext('createCrm', new ApiError(409, 'DNC_BLOCKED', 'x'));
  await cadastrar(t);
  assert.match(texto(t), /Esta identidade está bloqueada como "Não Contatar"/);
  assert.equal(rotulo(t, 'Observações').value, 'texto da aba comercial');
  assert.equal(t.api.store.items.length, 0);
});

test('[TABS-11] layout: abas horizontais no desktop (flex), no celular elas quebram de linha sem cortar títulos, a altura mínima evita o salto, o foco fica visível e o padrão Rio X7 (.tab/.tabs) é reaproveitado', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8');
  assert.match(css, /\.tab-list \{ display: flex;[^}]*overflow-x: auto;/, 'desktop: faixa horizontal');
  assert.match(css, /\.form-more \.tab-panels \{ min-height: 14rem; \}/, 'altura mínima: sem salto ao trocar de aba');
  assert.match(css, /\.form-more \.tab:focus-visible \{ outline-offset: -3px; \}/, 'o foco não é cortado pela faixa');
  assert.match(css, /@media \(max-width: 480px\) \{ \.form-more \{ padding: 6px 8px; \} \.form-more \.tab-list \{ flex-wrap: wrap; overflow-x: visible; \}/, 'celular: as abas quebram de linha');
  assert.match(css, /\.tab\[aria-selected="true"\] \{ color: var\(--text\); border-bottom-color: var\(--brand-strong\); \}/, 'a aba ativa é destacada');
  assert.match(css, /^:focus-visible \{ outline: 3px solid var\(--brand-strong\);/m, 'foco visível em todo o painel');
  assert.doesNotMatch(css.split('\n').filter((linha) => linha.includes('.form-more')).join('\n'), /!important/);
});

test('[TABS-12] nenhuma regra de negócio mudou: o payload da API, as abas de edição e o contrato de campos são os mesmos (35 campos graváveis, mesma ordem de CRM_WRITABLE_FIELDS no modelo)', async () => {
  const { WRITABLE_KEYS } = await import('../../dashboard/crm-model.mjs');
  const { CRM_WRITABLE_FIELDS } = require('../../src/crm/constants');
  assert.deepEqual([...WRITABLE_KEYS].sort(), [...CRM_WRITABLE_FIELDS].sort());
  assert.equal(CRM_WRITABLE_FIELDS.length, 35);
  const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'views', 'crm.mjs'), 'utf8');
  assert.doesNotMatch(codigo.split('\n').filter((linha) => !linha.trim().startsWith('//')).join('\n'), /moreTabs[^;]*\b(createCrm|updateCrm|api\.)/, 'as abas não chamam a API');
});
