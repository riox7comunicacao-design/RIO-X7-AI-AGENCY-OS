// A tela de CLIENTES (dashboard/views/crm.mjs — CRM 5.0, Fase D2) rodando de verdade sobre o DOM de teste e um cliente de API falso: o formulário de NOVO CLIENTE com Pessoa Física/Jurídica (campos condicionais,
// seção expansível, validação, erros do servidor e falha de rede sem falso sucesso), a lista com Tipo, filtro e busca por documento, a ficha, a revisão de um registro ANTIGO sem tipo, o botão "Nova negociação" e
// as permissões. Nenhum navegador, nenhuma rede, nenhum dado real — documentos de exemplo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBrowser, findAll } = require('../helpers/fakeDom');

const ADMIN = Object.freeze({ canReadCrm: true, canWriteCrm: true, canProposeCrm: true, canReview: true });
const CLOSER = Object.freeze({ canReadCrm: true, canWriteCrm: false, canProposeCrm: true, canReview: true });
const LEITOR = Object.freeze({ canReadCrm: true, canWriteCrm: false, canProposeCrm: false });
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const LISTA = { name: 'crm-list' };
const NOVO = { name: 'crm-new' };
const REGISTRO = (id) => ({ name: 'crm-record', id });

async function montar({ permissions = ADMIN, items = [], api } = {}) {
  const { createCrmView } = await import('../../dashboard/views/crm.mjs');
  const { createFakeApi } = await loadFixtures();
  const browser = createBrowser();
  const fake = api || createFakeApi({ items });
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

const gavetaDe = (t) => t.browser.find(t.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const novaTelaDe = (t) => {
  const host = t.browser.find(t.root, (el) => /\bcrm-new-host\b/.test(el.className));
  return host && !host.hidden && host.children.length > 0 ? host : null;
};
const escopo = (t) => gavetaDe(t) || novaTelaDe(t) || t.root;
const texto = (t) => t.root.textContent.replace(/\s+/g, ' ');
const nbsp = (valor) => valor.replace(/ /g, ' ');
const campo = (t, chave) => t.browser.by.id(t.root, `crm-field-${chave}`);
const visivel = (t, chave) => !campo(t, chave).parentNode.hidden; // o <div class="field"> do campo
const radio = (t, rotulo) => t.browser.by.label(escopo(t), rotulo);
const escolherTipo = (t, rotulo) => t.browser.click(radio(t, rotulo));
const digitar = (t, rotulo, valor) => t.browser.type(t.browser.by.label(escopo(t), rotulo), valor);
const cadastrar = async (t) => {
  t.browser.click(t.browser.by.button(escopo(t), 'Cadastrar cliente'));
  await t.browser.flush();
};
const linhasDaTabela = (root) => {
  const [corpo] = findAll(root, (el) => el.localName === 'tbody');
  return corpo ? corpo.children.map((tr) => tr.children.map((td) => td.textContent.trim())) : [];
};
function secao(browser, titulo) {
  return browser.find(browser.root, (el) => el.localName === 'section' && el.children.some((filho) => filho.localName === 'h3' && filho.textContent.trim() === titulo));
}
const rotulosDe = (t, titulo) => t.browser.by.tag(secao(t.browser, titulo), 'dt').map((dt) => dt.textContent.trim());
function valorDe(browser, titulo, rotulo) {
  const dl = browser.by.tag(secao(browser, titulo), 'dl')[0];
  const indice = dl.children.findIndex((el) => el.localName === 'dt' && el.textContent.trim() === rotulo);
  assert.ok(indice >= 0, `campo ${rotulo} não encontrado em ${titulo}`);
  return dl.children[indice + 1];
}

async function registrosMistos() {
  const { crmRecord } = await loadFixtures();
  return [
    crmRecord({ id: 'crm:pf', tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', empresa: null, cpf: '52998224725', telefone: '(24) 90000-1111', cidade: 'Niterói', dataDeEntrada: '2026-10-03T12:00:00Z' }),
    crmRecord({ id: 'crm:pj', tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: '11222333000181', contato: 'Ana Lima', cidade: 'Petrópolis', dataDeEntrada: '2026-10-02T12:00:00Z' }),
    crmRecord({ id: 'crm:antigo', tipoPessoa: null, empresa: 'Estúdio Dias', cidade: 'Rio', dataDeEntrada: '2026-10-01T12:00:00Z' }),
  ];
}

// ===========================================================================
// NOVO CLIENTE
// ===========================================================================
test('[PERSON-UI-1] NOVO CLIENTE, estado inicial: o tipo (PF/PJ) vem SEM escolha, os campos de identificação ficam escondidos até escolher, o resto está à vista e o "Mais informações" vem recolhido — com todos os campos no DOM', async () => {
  const { WRITABLE_KEYS } = await import('../../dashboard/crm-model.mjs');
  const t = await montar();
  await t.mostrar(NOVO);
  assert.equal(t.browser.by.tag(t.root, 'h2')[0].textContent, 'Novo cliente');
  assert.equal(radio(t, 'Pessoa Física').checked, false);
  assert.equal(radio(t, 'Pessoa Jurídica').checked, false, 'o tipo nunca vem escolhido sozinho');
  assert.match(texto(t), /Escolha primeiro: os campos mudam conforme o tipo\./);
  for (const chave of ['nomeCompleto', 'empresa', 'cpf', 'cnpj', 'contato']) assert.equal(visivel(t, chave), false, `${chave} escondido até escolher o tipo`);
  for (const chave of ['telefone', 'whatsapp', 'email', 'nicho', 'origem', 'responsavel']) assert.equal(visivel(t, chave), true, `${chave} à vista`);
  const mais = t.browser.by.id(t.root, 'crm-new-more');
  assert.equal(mais.localName, 'details');
  assert.notEqual(mais.open, true, 'a seção "Mais informações" começa recolhida');
  assert.equal(t.browser.by.tag(mais, 'summary')[0].textContent, 'Mais informações (opcional)');
  // nenhum campo foi eliminado: os 35 existem no formulário (o tipo são os dois botões de rádio)
  const nomes = new Set(t.browser.findAll(escopo(t), (el) => ['input', 'textarea'].includes(el.localName) && el.getAttribute('name')).map((el) => el.getAttribute('name')));
  for (const chave of WRITABLE_KEYS) assert.ok(nomes.has(chave), `falta o campo ${chave}`);
  assert.equal(t.browser.by.cls(t.root, 'crm-person-type').length, 1);
  assert.equal(t.browser.by.tag(radio(t, 'Pessoa Física').parentNode.parentNode, 'legend')[0].textContent, 'Tipo de pessoa (obrigatório)');
  assert.equal(t.api.callsOf('createCrm').length, 0);
});

test('[PERSON-UI-2] Pessoa FÍSICA: escolher PF mostra nome completo (obrigatório) e CPF (opcional) e esconde empresa, CNPJ e contato; o corpo enviado leva só o preenchido, com o CPF só com os dígitos', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  escolherTipo(t, 'Pessoa Física');
  assert.equal(visivel(t, 'nomeCompleto'), true);
  assert.equal(visivel(t, 'cpf'), true);
  for (const chave of ['empresa', 'cnpj', 'contato']) assert.equal(visivel(t, chave), false, `${chave} escondido na PF`);
  assert.doesNotMatch(texto(t), /Escolha primeiro/);
  assert.equal(t.browser.by.label(escopo(t), 'Nome completo (obrigatório)').getAttribute('aria-required'), 'true');
  assert.ok(t.browser.by.label(escopo(t), 'CPF (opcional)'));
  digitar(t, 'Nome completo (obrigatório)', '  Maria Souza  ');
  digitar(t, 'CPF (opcional)', '529.982.247-25');
  digitar(t, 'Telefone', '24 90000-1111');
  digitar(t, 'E-mail', 'maria@example.test');
  await cadastrar(t);
  const chamada = t.api.callsOf('createCrm');
  assert.equal(chamada.length, 1);
  assert.deepEqual(chamada[0].args[0], { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: '52998224725', telefone: '24 90000-1111', email: 'maria@example.test' });
  assert.deepEqual(chamada[0].args[1], { status: 'PROSPECT' });
  assert.equal(t.navegacoes.length, 1);
  assert.match(t.navegacoes[0], /^#\/crm\/registro\/crm%3Acreated-1$/);
});

test('[PERSON-UI-3] Pessoa JURÍDICA: escolher PJ mostra empresa (obrigatória), CNPJ (opcional) e nome do contato e esconde nome completo e CPF; o CNPJ alfanumérico vale e vai em maiúsculas', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  escolherTipo(t, 'Pessoa Jurídica');
  for (const chave of ['empresa', 'cnpj', 'contato']) assert.equal(visivel(t, chave), true, `${chave} visível na PJ`);
  for (const chave of ['nomeCompleto', 'cpf']) assert.equal(visivel(t, chave), false, `${chave} escondido na PJ`);
  assert.equal(t.browser.by.label(escopo(t), 'Nome da empresa (obrigatório)').getAttribute('aria-required'), 'true');
  assert.ok(t.browser.by.label(escopo(t), 'CNPJ (opcional)'));
  digitar(t, 'Nome da empresa (obrigatório)', 'Clínica Aurora');
  digitar(t, 'CNPJ (opcional)', '12.abc.345/01de-35');
  digitar(t, 'Nome do contato', 'Ana Lima');
  await cadastrar(t);
  assert.deepEqual(t.api.callsOf('createCrm')[0].args[0], { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: '12ABC34501DE35', contato: 'Ana Lima' });
});

test('[PERSON-UI-4] TROCAR DE TIPO nunca descarta o que foi digitado: um campo já preenchido continua visível, o formulário aponta o conflito (nada é enviado) e só segue quando a pessoa resolve', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  escolherTipo(t, 'Pessoa Física');
  digitar(t, 'Nome completo (obrigatório)', 'Maria Souza');
  digitar(t, 'CPF (opcional)', '529.982.247-25');
  escolherTipo(t, 'Pessoa Jurídica');
  assert.equal(visivel(t, 'nomeCompleto'), true, 'o nome completo digitado continua à vista');
  assert.equal(visivel(t, 'cpf'), true, 'o CPF digitado continua à vista');
  digitar(t, 'Nome da empresa (obrigatório)', 'Clínica Aurora');
  await cadastrar(t);
  assert.equal(t.api.callsOf('createCrm').length, 0, 'conflito: nada vai ao servidor');
  assert.match(texto(t), /O nome completo só vale para Pessoa Física; para uma empresa use o campo Empresa\./);
  assert.match(texto(t), /O CPF só vale para Pessoa Física\./);
  assert.equal(t.browser.by.label(escopo(t), 'Nome completo').getAttribute('aria-invalid'), 'true');
  digitar(t, 'Nome completo', '');
  digitar(t, 'CPF (opcional)', '');
  assert.equal(visivel(t, 'nomeCompleto'), true, 'esvaziar o campo não o esconde debaixo das mãos da pessoa (ele só some quando o tipo muda de novo)');
  await cadastrar(t);
  assert.equal(t.api.callsOf('createCrm').length, 1);
  assert.deepEqual(t.api.callsOf('createCrm')[0].args[0], { tipoPessoa: 'PJ', empresa: 'Clínica Aurora' });
  // trocar o tipo de novo esconde o que está vazio
  escolherTipo(t, 'Pessoa Física');
  escolherTipo(t, 'Pessoa Jurídica');
  assert.equal(visivel(t, 'nomeCompleto'), false);
  assert.equal(visivel(t, 'cpf'), false);
});

test('[PERSON-UI-5] VALIDAÇÃO ANTES DE ENVIAR: sem tipo, PF sem nome, PJ sem empresa, CPF/CNPJ inválidos e valor em dinheiro inválido — mensagem clara, foco no campo e NENHUMA chamada à API', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  await cadastrar(t);
  assert.match(texto(t), /Escolha se o cliente é Pessoa Física ou Pessoa Jurídica\./);
  assert.equal(t.browser.document.activeElement, radio(t, 'Pessoa Física'), 'o foco vai para o tipo');
  escolherTipo(t, 'Pessoa Física');
  await cadastrar(t);
  assert.match(texto(t), /Informe o nome completo\./);
  assert.equal(t.browser.document.activeElement, t.browser.by.label(escopo(t), 'Nome completo (obrigatório)'));
  digitar(t, 'Nome completo (obrigatório)', 'Maria Souza');
  digitar(t, 'CPF (opcional)', '529.982.247-24');
  await cadastrar(t);
  assert.match(texto(t), /CPF inválido\. Confira os 11 números\./);
  assert.equal(t.browser.by.label(escopo(t), 'CPF (opcional)').getAttribute('aria-invalid'), 'true');
  digitar(t, 'CPF (opcional)', '529.982.247-25');
  escolherTipo(t, 'Pessoa Jurídica');
  digitar(t, 'Nome completo', '');
  digitar(t, 'CPF (opcional)', '');
  await cadastrar(t);
  assert.match(texto(t), /Informe o nome da empresa\./);
  digitar(t, 'Nome da empresa (obrigatório)', 'Clínica Aurora');
  digitar(t, 'CNPJ (opcional)', '11.222.333/0001-82');
  await cadastrar(t);
  assert.match(texto(t), /CNPJ inválido\. Confira os 14 caracteres\./);
  digitar(t, 'CNPJ (opcional)', '');
  // um erro na seção RECOLHIDA a abre (o valor em dinheiro fica em "Mais informações")
  digitar(t, 'Valor total', 'muito dinheiro');
  await cadastrar(t);
  assert.match(texto(t), /Informe um valor numérico maior ou igual a zero\./);
  assert.equal(t.browser.by.id(t.root, 'crm-new-more').open, true, 'o erro abriu a seção expansível');
  assert.equal(t.api.callsOf('createCrm').length, 0, 'nenhuma das tentativas chegou à API');
});

test('[PERSON-UI-6] ERROS DO SERVIDOR e FALHA DE REDE: duplicidade (409) e bloqueio (DNC) mostram a frase certa e mantêm tudo; a rede caindo NUNCA vira sucesso (sem navegar, botão liberado, nada na lista)', async () => {
  const { ApiError } = await loadFixtures();
  const t = await montar();
  await t.mostrar(NOVO);
  escolherTipo(t, 'Pessoa Física');
  digitar(t, 'Nome completo (obrigatório)', 'Maria Souza');
  digitar(t, 'CPF (opcional)', '529.982.247-25');
  t.api.failNext('createCrm', new ApiError(409, 'DUPLICATE_RECORD', 'x'));
  await cadastrar(t);
  assert.match(texto(t), /Já existe um registro com esta identidade/);
  assert.equal(t.browser.by.label(escopo(t), 'Nome completo (obrigatório)').value, 'Maria Souza', 'o digitado ficou');
  assert.equal(t.browser.by.label(escopo(t), 'CPF (opcional)').value, '529.982.247-25');
  t.api.failNext('createCrm', new ApiError(409, 'DNC_BLOCKED', 'x'));
  await cadastrar(t);
  assert.match(texto(t), /Esta identidade está bloqueada como "Não Contatar"/);
  t.api.failNext('createCrm', new ApiError(400, 'INVALID_REQUEST', 'CPF inválido. Confira os 11 números.'));
  await cadastrar(t);
  assert.match(texto(t), /CPF inválido\. Confira os 11 números\./, 'a frase do servidor (fixa) é mostrada');
  // a rede cai
  t.api.failNext('createCrm', new ApiError(0, 'NETWORK', 'falha de rede'));
  await cadastrar(t);
  assert.match(texto(t), /Sem conexão com o servidor\. Verifique a internet e tente novamente\./);
  assert.deepEqual(t.navegacoes, [], 'nenhuma navegação: nada foi criado');
  assert.equal(t.browser.by.button(escopo(t), 'Cadastrar cliente').disabled, false, 'o botão voltou');
  assert.doesNotMatch(texto(t), /Cliente cadastrado/, 'nenhuma mensagem de sucesso');
  assert.equal(t.api.store.items.length, 0);
  // e a tentativa seguinte, com a rede de volta, funciona
  await cadastrar(t);
  assert.equal(t.api.store.items.length, 1);
  assert.equal(t.navegacoes.length, 1);
});

test('[PERSON-UI-7] a seção "Mais informações" guarda o resto SEM perder nada: redes sociais, informações adicionais, diagnóstico/histórico comercial, reunião e a entrada no CRM (status e motivo) — e o enviado leva só o preenchido', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  const mais = t.browser.by.id(t.root, 'crm-new-more');
  const legends = t.browser.by.tag(mais, 'legend').map((el) => el.textContent);
  assert.deepEqual(legends, ['Redes sociais e presença digital', 'Informações adicionais', 'Diagnóstico e histórico comercial', 'Reunião e próxima ação', 'Entrada no CRM']);
  for (const rotulo of ['Site', 'Instagram', 'Facebook', 'Perfil no Google', 'Cargo', 'Cidade', 'Estado (UF)', 'Observações', 'Serviço potencial', 'Temperatura', 'Problema identificado', 'Raio-X de nicho', 'Raio-X personalizado', 'Status do diagnóstico', 'Link do Raio-X', 'Data da análise', 'Valor da proposta', 'Valor total', 'Última interação', 'Data da reunião', 'Link do Google Meet', 'Próxima ação', 'Data da próxima ação', 'Status inicial', 'Motivo da entrada (opcional)']) {
    assert.ok(t.browser.by.label(mais, rotulo), `"${rotulo}" está na seção expansível`);
  }
  escolherTipo(t, 'Pessoa Jurídica');
  digitar(t, 'Nome da empresa (obrigatório)', 'Clínica Aurora');
  digitar(t, 'Instagram', 'https://instagram.example.test/aurora');
  digitar(t, 'Observações', 'Prefere contato pela manhã.');
  digitar(t, 'Valor da proposta', '1500,50');
  t.browser.choose(t.browser.by.label(mais, 'Status inicial'), 'QUALIFIED_PROSPECT');
  digitar(t, 'Motivo da entrada (opcional)', 'Indicação');
  await cadastrar(t);
  assert.deepEqual(t.api.callsOf('createCrm')[0].args, [{ tipoPessoa: 'PJ', empresa: 'Clínica Aurora', instagram: 'https://instagram.example.test/aurora', observacoes: 'Prefere contato pela manhã.', valorProposta: 1500.5 }, { status: 'QUALIFIED_PROSPECT', reason: 'Indicação' }]);
});

// ===========================================================================
// LISTA
// ===========================================================================
test('[PERSON-UI-8] LISTA: a primeira coluna mostra o nome certo (nome completo da PF, empresa da PJ), a coluna Tipo diz PF/PJ/Sem tipo, o filtro por tipo inclui "Sem tipo definido" e a busca acha por nome completo e por CPF/CNPJ', async () => {
  const t = await montar({ items: await registrosMistos() });
  await t.mostrar(LISTA);
  const cabecalho = t.browser.by.tag(t.root, 'th').map((th) => th.textContent.trim());
  assert.deepEqual(cabecalho.slice(0, 3), ['Cliente', 'Tipo', 'Contato']);
  const linhas = linhasDaTabela(t.root);
  assert.deepEqual(linhas.map((linha) => [linha[0], linha[1]]), [['Maria Souza', 'PF'], ['Clínica Aurora', 'PJ'], ['Estúdio Dias', 'Sem tipo']]);
  const tipo = t.browser.by.label(t.root, 'Tipo');
  assert.deepEqual(t.browser.by.tag(tipo, 'option').map((o) => o.textContent), ['Todos os tipos', 'Pessoa Física', 'Pessoa Jurídica', 'Sem tipo definido']);
  t.browser.choose(tipo, 'PF');
  assert.deepEqual(linhasDaTabela(t.root).map((l) => l[0]), ['Maria Souza']);
  t.browser.choose(tipo, 'SEM_TIPO');
  assert.deepEqual(linhasDaTabela(t.root).map((l) => l[0]), ['Estúdio Dias'], 'a revisão administrativa acha os registros sem tipo');
  t.browser.choose(tipo, '');
  const busca = t.browser.by.label(t.root, 'Buscar');
  t.browser.type(busca, '529.982.247-25');
  assert.deepEqual(linhasDaTabela(t.root).map((l) => l[0]), ['Maria Souza']);
  t.browser.type(busca, '11222333');
  assert.deepEqual(linhasDaTabela(t.root).map((l) => l[0]), ['Clínica Aurora']);
  t.browser.type(busca, 'maria');
  assert.deepEqual(linhasDaTabela(t.root).map((l) => l[0]), ['Maria Souza']);
  t.browser.type(busca, 'cliente inexistente');
  assert.deepEqual(linhasDaTabela(t.root), []);
  assert.equal(t.api.callsOf('listCrm').length, 1, 'filtrar e buscar não vão ao servidor');
  // "Limpar filtros" também zera o tipo
  t.browser.choose(tipo, 'PJ');
  t.browser.click(t.browser.by.button(t.root, 'Limpar filtros'));
  await t.browser.flush();
  assert.equal(t.browser.by.label(t.root, 'Tipo').value, '');
});

// ===========================================================================
// FICHA
// ===========================================================================
test('[PERSON-UI-9] FICHA: PF mostra tipo, nome completo e CPF com máscara (e nenhum CNPJ vazio); PJ mostra a empresa e o CNPJ com máscara; o registro antigo diz "Sem tipo definido" — o título é sempre o nome de exibição', async () => {
  const t = await montar({ items: await registrosMistos() });
  await t.mostrar(REGISTRO('crm:pf'));
  assert.equal(t.browser.by.cls(t.root, 'overlay-title')[0].textContent, 'Maria Souza');
  assert.deepEqual(t.browser.by.cls(t.root, 'ficha-head')[0].children.map((el) => el.textContent), ['Lead em Prospecção', 'Pessoa Física']);
  assert.equal(valorDe(t.browser, 'Identificação', 'Tipo de pessoa').textContent, 'Pessoa Física');
  assert.equal(valorDe(t.browser, 'Identificação', 'Nome completo').textContent, 'Maria Souza');
  assert.equal(valorDe(t.browser, 'Identificação', 'CPF').textContent, '529.982.247-25');
  assert.equal(valorDe(t.browser, 'Identificação', 'Empresa').textContent, '—');
  assert.ok(!rotulosDe(t, 'Identificação').includes('CNPJ'), 'um CNPJ vazio numa PF seria só ruído');

  await t.mostrar(REGISTRO('crm:pj'));
  assert.equal(t.browser.by.cls(t.root, 'overlay-title')[0].textContent, 'Clínica Aurora');
  assert.equal(valorDe(t.browser, 'Identificação', 'CNPJ').textContent, '11.222.333/0001-81');
  assert.ok(!rotulosDe(t, 'Identificação').includes('CPF'));
  assert.ok(!rotulosDe(t, 'Identificação').includes('Nome completo'));

  await t.mostrar(REGISTRO('crm:antigo'));
  assert.equal(t.browser.by.cls(t.root, 'overlay-title')[0].textContent, 'Estúdio Dias');
  assert.deepEqual(t.browser.by.cls(t.root, 'ficha-head')[0].children.map((el) => el.textContent), ['Lead em Prospecção', 'Sem tipo definido']);
  assert.equal(valorDe(t.browser, 'Identificação', 'Tipo de pessoa').textContent, 'Sem tipo definido');
  assert.ok(!rotulosDe(t, 'Identificação').some((rotulo) => ['Nome completo', 'CPF', 'CNPJ'].includes(rotulo)));
});

// ===========================================================================
// REVISÃO DE UM REGISTRO ANTIGO (edição)
// ===========================================================================
test('[PERSON-UI-10] REVISÃO ADMINISTRATIVA: o registro antigo abre a edição com o aviso, sem tipo escolhido e com a empresa obrigatória; escolher PF pede o nome completo, mantém a empresa original e o PATCH leva SÓ o tipo e o nome', async () => {
  const t = await montar({ items: await registrosMistos() });
  await t.mostrar(REGISTRO('crm:antigo'));
  t.browser.click(t.browser.by.button(escopo(t), 'Editar'));
  assert.match(texto(t), /Este é um registro antigo, ainda sem tipo de pessoa\. Escolha Pessoa Física ou Pessoa Jurídica para completar o cadastro: os dados atuais são mantidos\./);
  assert.equal(radio(t, 'Pessoa Física').checked, false);
  assert.equal(radio(t, 'Pessoa Jurídica').checked, false, 'o tipo NÃO é inferido: a pessoa escolhe');
  assert.equal(t.browser.by.label(escopo(t), 'Empresa (obrigatório)').value, 'Estúdio Dias', 'a empresa original continua, obrigatória enquanto não há tipo');
  assert.equal(visivel(t, 'nomeCompleto'), false);
  assert.match(texto(t), /Sem tipo definido ainda\./);
  // abrir a edição não conta como alteração
  t.browser.click(t.browser.by.button(escopo(t), 'Salvar alterações'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('updateCrm').length, 0);
  assert.match(texto(t), /Nenhuma alteração para salvar\./);
  // escolher PF sem o nome completo: erro, nada enviado
  escolherTipo(t, 'Pessoa Física');
  assert.equal(visivel(t, 'nomeCompleto'), true);
  assert.equal(visivel(t, 'empresa'), true, 'a empresa original continua visível (preenchida)');
  assert.equal(t.browser.by.label(escopo(t), 'Empresa').value, 'Estúdio Dias');
  t.browser.click(t.browser.by.button(escopo(t), 'Salvar alterações'));
  await t.browser.flush();
  assert.match(texto(t), /Informe o nome completo\./);
  assert.equal(t.api.callsOf('updateCrm').length, 0);
  digitar(t, 'Nome completo (obrigatório)', 'Fulano Dias');
  t.browser.click(t.browser.by.button(escopo(t), 'Salvar alterações'));
  await t.browser.flush();
  assert.deepEqual(t.api.callsOf('updateCrm')[0].args, ['crm:antigo', { tipoPessoa: 'PF', nomeCompleto: 'Fulano Dias' }], 'só o que mudou: a empresa e os demais campos não são reenviados');
  assert.match(texto(t), /Alterações salvas\./);
  assert.equal(t.api.store.items.find((item) => item.id === 'crm:antigo').empresa, 'Estúdio Dias', 'a empresa original foi preservada');
  assert.equal(t.browser.by.cls(t.root, 'overlay-title')[0].textContent, 'Fulano Dias', 'o nome de exibição agora é o da PF');
});

test('[PERSON-UI-11] EDITAR uma PF existente: abre com o tipo escolhido e SEM aviso de registro antigo; o CPF aparece com máscara mas reabrir e salvar não envia nada; trocar o CPF envia só o CPF (só os dígitos)', async () => {
  const t = await montar({ items: await registrosMistos() });
  await t.mostrar(REGISTRO('crm:pf'));
  t.browser.click(t.browser.by.button(escopo(t), 'Editar'));
  assert.equal(radio(t, 'Pessoa Física').checked, true);
  assert.doesNotMatch(texto(t), /registro antigo/);
  assert.equal(t.browser.by.label(escopo(t), 'CPF').value, '529.982.247-25', 'a máscara é só da tela');
  assert.equal(visivel(t, 'empresa'), false, 'a PF sem empresa não mostra o campo vazio');
  t.browser.click(t.browser.by.button(escopo(t), 'Salvar alterações'));
  await t.browser.flush();
  assert.equal(t.api.callsOf('updateCrm').length, 0, 'a máscara não conta como alteração');
  digitar(t, 'CPF', '111.444.777-35');
  t.browser.click(t.browser.by.button(escopo(t), 'Salvar alterações'));
  await t.browser.flush();
  assert.deepEqual(t.api.callsOf('updateCrm')[0].args, ['crm:pf', { cpf: '11144477735' }]);
});

// ===========================================================================
// NOVA NEGOCIAÇÃO e PERMISSÕES
// ===========================================================================
test('[PERSON-UI-12] "Nova negociação" na ficha: ADMIN e COMMERCIAL_CLOSER têm o atalho (para o ID estável do cliente); quem só lê não; e o registro BLOQUEADO (Não Contatar) também não', async () => {
  const { crmRecord } = await loadFixtures();
  const itens = [...(await registrosMistos()), crmRecord({ id: 'crm:bloqueado', tipoPessoa: 'PJ', empresa: 'Bloqueada Ltda', status: 'DO_NOT_CONTACT' })];
  const esperado = '#/funis/nova-negociacao/crm%3Apf';
  for (const [nome, permissions] of [['ADMIN', ADMIN], ['CLOSER', CLOSER]]) {
    const t = await montar({ items: itens, permissions });
    await t.mostrar(REGISTRO('crm:pf'));
    const atalho = t.browser.by.link(escopo(t), 'Nova negociação');
    assert.ok(atalho, `${nome} vê "Nova negociação"`);
    assert.equal(atalho.href, esperado);
    await t.mostrar(REGISTRO('crm:bloqueado'));
    assert.equal(t.browser.by.link(escopo(t), 'Nova negociação'), null, `${nome}: registro bloqueado não abre negociação`);
  }
  const leitor = await montar({ items: itens, permissions: LEITOR });
  await leitor.mostrar(REGISTRO('crm:pf'));
  assert.equal(leitor.browser.by.link(escopo(leitor), 'Nova negociação'), null);
});

test('[PERSON-UI-13] RBAC na tela: o COMMERCIAL_CLOSER vê a lista com os tipos e a ficha, mas não tem "Novo cliente", "Editar", "Mudar status" nem DNC; só o ADMIN vê o botão de cadastro', async () => {
  const closer = await montar({ items: await registrosMistos(), permissions: CLOSER });
  await closer.mostrar(LISTA);
  assert.deepEqual(linhasDaTabela(closer.root).map((l) => l[1]), ['PF', 'PJ', 'Sem tipo']);
  assert.equal(closer.browser.by.link(closer.root, 'Novo cliente'), null);
  await closer.mostrar(REGISTRO('crm:pf'));
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não Contatar']) assert.equal(closer.browser.by.button(escopo(closer), botao), null, botao);
  await closer.mostrar(NOVO);
  assert.match(texto(closer), /Sua conta não pode cadastrar clientes no CRM\./);
  assert.equal(closer.browser.by.tag(escopo(closer), 'form').length, 0, 'sem formulário de cadastro');
  const admin = await montar({ items: await registrosMistos(), permissions: ADMIN });
  await admin.mostrar(LISTA);
  assert.equal(admin.browser.by.link(admin.root, 'Novo cliente').href, '#/crm/novo');
  for (const escrita of ['createCrm', 'updateCrm', 'moveCrmStatus', 'markCrmDnc']) assert.equal(closer.api.callsOf(escrita).length, 0, `${escrita} nunca foi chamado pelo closer`);
});

// ===========================================================================
// ACESSIBILIDADE, CELULAR e SEGURANÇA
// ===========================================================================
test('[PERSON-UI-14] ACESSIBILIDADE: o tipo é um grupo de botões de rádio com legenda, cada campo tem rótulo e área de erro (role=alert), "(obrigatório)" também vai em aria-required, e os campos escondidos saem da ordem do teclado', async () => {
  const t = await montar();
  await t.mostrar(NOVO);
  const grupo = campo(t, 'tipoPessoa');
  assert.equal(grupo.localName, 'fieldset');
  assert.match(grupo.getAttribute('aria-describedby'), /crm-field-tipoPessoa-hint/);
  assert.equal(t.browser.by.tag(grupo, 'input').length, 2);
  assert.ok(t.browser.by.tag(grupo, 'input').every((el) => el.getAttribute('type') === 'radio' && el.getAttribute('name') === 'tipoPessoa'));
  assert.equal(t.browser.by.id(t.root, 'crm-field-tipoPessoa-error').getAttribute('role'), 'alert');
  escolherTipo(t, 'Pessoa Física');
  const nome = t.browser.by.label(escopo(t), 'Nome completo (obrigatório)');
  assert.equal(nome.getAttribute('aria-required'), 'true');
  assert.equal(t.browser.by.id(t.root, 'crm-field-nomeCompleto-error').getAttribute('role'), 'alert');
  // escondido (hidden) = fora do teclado e do leitor de tela
  assert.equal(campo(t, 'empresa').parentNode.hidden, true);
  escolherTipo(t, 'Pessoa Jurídica');
  assert.equal(campo(t, 'empresa').parentNode.hidden, false);
  assert.equal(t.browser.by.label(escopo(t), 'Nome da empresa (obrigatório)').getAttribute('aria-required'), 'true');
  assert.equal(nome.getAttribute('aria-required'), null, 'o nome completo deixou de ser obrigatório na PJ');
});

test('[PERSON-UI-15] CELULAR e visual: o CSS tem as regras do tipo de pessoa (uma coluna em tela estreita), da seção expansível e dos campos escondidos; nada de estilo inline nem de HTML montado com dados', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8');
  assert.match(css, /\.field\[hidden\], \.form-block\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.crm-person-type \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 640px\) \{ \.crm-person-type \{ grid-template-columns: 1fr; \} \}/);
  assert.match(css, /\.form-more \{/);
  assert.match(css, /\.form-more > summary \{ cursor: pointer;/);
  assert.match(css, /\.crm-person-badge \{/);
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'views', 'crm.mjs'), 'utf8');
  const semComentarios = fonte.split('\n').filter((linha) => !/^\s*\/\//.test(linha)).join('\n');
  assert.doesNotMatch(semComentarios, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(semComentarios, /\bstyle\s*:/);
});

test('[PERSON-UI-16] dados HOSTIS nunca viram HTML: um nome completo, uma empresa e um CPF com marcação aparecem como TEXTO na lista, na ficha e no formulário de edição', async () => {
  const { crmRecord } = await loadFixtures();
  const hostil = crmRecord({ id: 'crm:hostil', tipoPessoa: 'PF', nomeCompleto: '<img src=x onerror=alert(1)>Maria', empresa: null, cpf: '<script>1</script>', cidade: '"><svg onload=1>' });
  const t = await montar({ items: [hostil] });
  await t.mostrar(LISTA);
  assert.equal(linhasDaTabela(t.root)[0][0], '<img src=x onerror=alert(1)>Maria');
  assert.equal(t.browser.by.tag(t.root, 'img').length, 0);
  await t.mostrar(REGISTRO('crm:hostil'));
  assert.equal(valorDe(t.browser, 'Identificação', 'Nome completo').textContent, '<img src=x onerror=alert(1)>Maria');
  assert.equal(valorDe(t.browser, 'Identificação', 'CPF').textContent, '<script>1</script>', 'um valor que não é um CPF válido passa como TEXTO');
  assert.equal(t.browser.by.tag(t.root, 'img').length + t.browser.by.tag(t.root, 'script').length + t.browser.by.tag(t.root, 'svg').length, 0);
});
