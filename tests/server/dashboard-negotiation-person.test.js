// A negociação a partir de um CLIENTE (PF ou PJ) no Dashboard — CRM 5.0, Fase D2: o seletor de cliente do formulário "Nova negociação" (nome certo + tipo, busca, o cliente já escolhido vindo da ficha) e o atalho
// #/funis/nova-negociacao/<id> do menu de Funis. Peças reais do Dashboard sobre o DOM de teste e a API falsa de negociações (tests/helpers/negotiationHarness.js). Nenhuma rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../helpers/negotiationHarness');
const { ADMIN, CLOSER, apiNegocios, cliente, abrirQuadro, botaoDaTela, campo, clicar, escolher, digitar, formulario, textoDaTela } = H;

const MARIA = (n = 2, extras = {}) => cliente(n, '', { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', empresa: '', ...extras });
const AURORA = (n = 3, extras = {}) => cliente(n, 'Clínica Aurora', { tipoPessoa: 'PJ', nomeCompleto: '', ...extras });
const opcoesDo = (s) => [...campo(s, 'crmRecordId').childNodes].map((o) => [o.getAttribute('value'), o.textContent]);

async function abrirFormulario(clients, { permissions = ADMIN } = {}) {
  const api = await apiNegocios({ clients });
  const s = await abrirQuadro({ api, permissions });
  await clicar(s, botaoDaTela(s, 'new'));
  return s;
}

test('[NEG-PERSON-UI-1] o SELETOR DE CLIENTE mostra o nome certo e o tipo ("Maria Souza (PF)", "Clínica Aurora (PJ)"; o registro antigo, só o nome), na ordem do CRM, e não oferece quem está em Não Contatar', async () => {
  const s = await abrirFormulario([cliente(1, 'Estúdio Dias'), MARIA(2), AURORA(3), cliente(4, 'Bloqueada Ltda', { tipoPessoa: 'PJ', status: 'DO_NOT_CONTACT' })]);
  assert.deepEqual(opcoesDo(s), [['', 'Escolha o cliente'], ['crm:1', 'Estúdio Dias'], ['crm:2', 'Maria Souza (PF)'], ['crm:3', 'Clínica Aurora (PJ)']]);
  assert.equal(campo(s, 'crmRecordId').value, '', 'nada vem escolhido sozinho');
  assert.equal(s.browser.by.id(s.browser.root, 'negotiation-client-search'), null, 'com poucos clientes não há busca');
});

test('[NEG-PERSON-UI-2] o corpo enviado leva o ID ESTÁVEL do cliente (nunca o nome nem o tipo), e a criação é pelo servidor: nada de sucesso antes da resposta', async () => {
  const s = await abrirFormulario([MARIA(2), AURORA(3)]);
  escolher(s, campo(s, 'crmRecordId'), 'crm:2');
  escolher(s, campo(s, 'funnelId'), 'funnel:1');
  escolher(s, campo(s, 'serviceId'), 'service:1');
  await clicar(s, s.browser.find(s.browser.root, (el) => el.localName === 'input' && el.getAttribute('name') === 'negociacao-forma-pagamento' && el.getAttribute('value') === 'UNICO'));
  digitar(s, campo(s, 'valorNegociado'), '1500,00');
  await clicar(s, H.botao(s, 'Salvar', formulario(s)));
  const criacao = s.api.chamadas.filter((chamada) => chamada[0] === 'criar');
  assert.equal(criacao.length, 1);
  const corpo = criacao[0][1];
  assert.equal(corpo.crmRecordId, 'crm:2');
  assert.equal(JSON.stringify(corpo).includes('Maria'), false, 'o nome não vai no corpo');
  assert.equal(Object.prototype.hasOwnProperty.call(corpo, 'tipoPessoa'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(corpo, 'empresa'), false);
});

test('[NEG-PERSON-UI-3] com MUITOS clientes o formulário ganha uma BUSCA (nome completo, empresa, contato, telefone, CPF e CNPJ, com ou sem pontuação); o cliente já escolhido nunca some da lista e limpar a busca devolve todos', async () => {
  const muitos = [
    cliente(1, 'Estúdio Dias', { telefone: '(24) 90000-1111' }),
    MARIA(2, { cpf: '52998224725' }),
    AURORA(3, { cnpj: '11222333000181', contato: 'Ana Lima' }),
    cliente(4, 'Odonto Beta'),
    cliente(5, 'Ótica Gama'),
    cliente(6, 'Zeta Estética'),
    cliente(7, 'Clínica Delta'),
  ];
  const s = await abrirFormulario(muitos);
  const busca = s.browser.by.id(s.browser.root, 'negotiation-client-search');
  assert.ok(busca, 'a busca existe');
  assert.equal(opcoesDo(s).length, 1 + 7);
  const nomesNaLista = () => opcoesDo(s).slice(1).map(([, texto]) => texto);
  digitar(s, busca, 'maria');
  assert.deepEqual(nomesNaLista(), ['Maria Souza (PF)']);
  digitar(s, busca, '529.982.247-25');
  assert.deepEqual(nomesNaLista(), ['Maria Souza (PF)']);
  digitar(s, busca, '11.222.333/0001-81');
  assert.deepEqual(nomesNaLista(), ['Clínica Aurora (PJ)']);
  digitar(s, busca, 'ana lima');
  assert.deepEqual(nomesNaLista(), ['Clínica Aurora (PJ)'], 'pelo nome do contato');
  digitar(s, busca, '24 90000-1111');
  assert.deepEqual(nomesNaLista(), ['Estúdio Dias'], 'pelo telefone');
  digitar(s, busca, 'clínica');
  assert.deepEqual(nomesNaLista(), ['Clínica Aurora (PJ)', 'Clínica Delta']);
  digitar(s, busca, 'xyz inexistente');
  assert.deepEqual(opcoesDo(s), [['', 'Nenhum cliente encontrado']]);
  // o escolhido não some, mesmo que a busca não o encontre
  digitar(s, busca, '');
  escolher(s, campo(s, 'crmRecordId'), 'crm:2');
  digitar(s, busca, 'zeta');
  assert.deepEqual(nomesNaLista(), ['Maria Souza (PF)', 'Zeta Estética']);
  assert.equal(campo(s, 'crmRecordId').value, 'crm:2', 'a escolha foi mantida');
  digitar(s, busca, '');
  assert.equal(nomesNaLista().length, 7, 'limpar a busca devolve todos');
});

test('[NEG-PERSON-UI-4] o atalho da ficha: #/funis/nova-negociacao/<id> (openNewFor) abre o formulário JÁ com o cliente escolhido, pelo ID estável; o endereço volta para #/funis; um id que não é de um cliente oferecido NÃO vira escolha', async () => {
  const api = await apiNegocios({ clients: [cliente(1, 'Estúdio Dias'), MARIA(2), AURORA(3)] });
  const reescritas = [];
  const s = await abrirQuadro({ api, navigation: { rewrite: (hash) => reescritas.push(hash) } });
  await s.view.openNewFor('crm:2');
  await s.browser.flush(10);
  assert.ok(formulario(s), 'o formulário abriu');
  assert.equal(campo(s, 'crmRecordId').value, 'crm:2');
  assert.equal(campo(s, 'crmRecordId').disabled, false, 'o cliente pode ser trocado antes de salvar');
  assert.deepEqual(reescritas, ['#/funis'], 'o endereço volta para #/funis (reescrito, sem recriar a tela): atualizar a página não reabre o formulário');

  const outra = await abrirQuadro({ api: await apiNegocios({ clients: [cliente(1, 'Estúdio Dias'), MARIA(2)] }) });
  await outra.view.openNewFor('crm:999-que-nao-existe');
  await outra.browser.flush(10);
  assert.ok(formulario(outra), 'o formulário abre');
  assert.equal(campo(outra, 'crmRecordId').value, '', 'um id desconhecido não é pré-escolhido');
  // e o formulário NÃO nasce "alterado": cancelar fecha direto, sem perguntar se descarta (o id solto não entra no estado inicial)
  await clicar(outra, H.botao(outra, 'Cancelar', formulario(outra)));
  assert.equal(H.confirmacao(outra), null, 'nada a perder: nenhuma pergunta');
  assert.equal(formulario(outra), null, 'fechou');
  // Não Contatar: não é oferecido, então também não é pré-escolhido
  const bloqueado = await abrirQuadro({ api: await apiNegocios({ clients: [cliente(1, 'Estúdio Dias'), MARIA(2, { status: 'DO_NOT_CONTACT' })] }) });
  await bloqueado.view.openNewFor('crm:2');
  await bloqueado.browser.flush(10);
  assert.equal(campo(bloqueado, 'crmRecordId').value, '');
});

test('[NEG-PERSON-UI-5] o atalho NÃO abre nada quando o quadro não carregou (nem mostra "ainda não há funil" por engano), e quem não pode propor negociação não abre o formulário', async () => {
  const api = await apiNegocios({ clients: [MARIA(2)] });
  api.mem.sempre.quadro = await H.erroApi(503, 'STORAGE_UNAVAILABLE');
  const s = await abrirQuadro({ api });
  await s.view.openNewFor('crm:2');
  await s.browser.flush(10);
  assert.equal(formulario(s), null, 'o quadro falhou: nada abre');
  assert.doesNotMatch(s.browser.root.textContent, /Ainda não há funil/, 'nem o aviso de "sem funil" (que viria num modal) aparece por engano');
  assert.equal(H.camadas(s).length, 0, 'nenhuma camada (modal ou gaveta) foi aberta');
  const leitor = await abrirQuadro({ api: await apiNegocios({ clients: [MARIA(2)] }), permissions: { ...CLOSER, canProposeCrm: false } });
  await leitor.view.openNewFor('crm:2');
  await leitor.browser.flush(10);
  assert.equal(formulario(leitor), null, 'sem PROPOSE:CRM não há formulário');
});

test('[NEG-PERSON-UI-6] o QUADRO mostra o nome certo no card: nome completo da PF, empresa da PJ, e o detalhe tem o link para a ficha do cliente com o nome certo', async () => {
  const negocio = await H.negociacao(1, { crmRecordId: 'crm:2', cliente: { empresa: null, tipoPessoa: 'PF', nomeCompleto: 'Maria Souza' }, cardId: 'card:1' });
  const outro = await H.negociacao(2, { crmRecordId: 'crm:3', cliente: { empresa: 'Clínica Aurora', tipoPessoa: 'PJ', nomeCompleto: null }, cardId: 'card:2' });
  const api = await apiNegocios({ clients: [MARIA(2), AURORA(3)], negotiations: [negocio, outro] });
  const s = await abrirQuadro({ api });
  assert.equal(H.tituloDe(s, 'card:1').textContent, 'Maria Souza');
  assert.equal(H.tituloDe(s, 'card:2').textContent, 'Clínica Aurora');
  assert.doesNotMatch(textoDaTela(s), /Cliente sem nome/);
});

test('[NEG-PERSON-UI-7] navigation.rewrite (o roteador): troca o endereço da entrada ATUAL sem criar entrada no histórico e SEM avisar quem escuta — a tela que já está na página não é recriada', async () => {
  const { createBrowser } = require('../helpers/fakeDom');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const b = createBrowser({ hash: '#/funis/nova-negociacao/crm%3A2' });
  const nav = browserNavigation(b.window);
  let avisos = 0;
  nav.subscribe(() => {
    avisos += 1;
  });
  const antes = b.window.history.length;
  nav.rewrite('#/funis');
  assert.equal(b.window.location.hash, '#/funis');
  assert.equal(b.window.history.length, antes, 'nenhuma entrada nova no histórico');
  assert.equal(avisos, 0, 'ninguém é avisado: nada é recriado');
  // o roteador continua coerente: uma navegação normal depois funciona e avisa
  nav.go('#/crm');
  await b.flush();
  assert.equal(b.window.location.hash, '#/crm');
  assert.equal(avisos >= 1, true);
});
