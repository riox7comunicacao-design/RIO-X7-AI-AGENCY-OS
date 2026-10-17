// O QUADRO de Negociações (dashboard/views/funnels.mjs + negotiationForm.mjs — CRM 5.0, Fase D1): colunas por etapa com contagem e valor em jogo vindos do servidor, cartões, modal de detalhes, mover,
// nova negociação, editar, ganhar, perder, reabrir e as permissões que a tela mostra. DOM de teste e API falsa em memória: nenhum navegador, nenhuma rede, nenhum dado real.
// O que mais importa aqui: NADA muda na tela antes de o servidor confirmar, e uma falha nunca deixa uma movimentação falsa.

const test = require('node:test');
const assert = require('node:assert/strict');

const N = require('../helpers/negotiationHarness');
const { ADMIN, CLOSER, LEITOR, funil, etapa, cliente, servico, negociacao, erroApi, apiNegocios, abrirQuadro, colunaDe, cartoes, cartaoDe, tituloDe, botaoDaTela, moverDe, textoDaTela, modal, confirmacao, formulario, doModal, campo, erroDoCampo, botao, avisos, camadas, clicar, digitar, escolher } = N;

const mesmo = (a, b, mensagem) => assert.ok(a === b, mensagem || 'deveria ser o mesmo elemento');
const semLixo = (texto) => assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
const duas = async () => [await negociacao(1), await negociacao(2, { stageId: 'stage:2', stageNome: 'Proposta', cliente: { empresa: 'Clínica Beta' }, crmRecordId: 'crm:2', servicoNome: 'Site', formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 8000, prazoMeses: 6 })];

test('[FBOARD-1] O QUADRO carrega só por LEITURA: uma coluna por etapa, a contagem e o valor em jogo de cada uma vêm do SERVIDOR, o cartão mostra cliente, serviço, condições, TCV e responsável', async () => {
  const api = await apiNegocios({ negotiations: await duas() });
  const s = await abrirQuadro({ api });
  assert.deepEqual(api.chamadas, [['quadro', null]], 'uma leitura do quadro; nada além disso');
  assert.equal(api.escritas().length, 0);
  assert.deepEqual(['stage:1', 'stage:2', 'stage:3'].map((id) => colunaDe(s, id).textContent.replace(/\s+/g, ' ').split(String.fromCharCode(160)).join(' ')), [
    'Contato1Em negociação: R$ 18.000,00 (TCV)Clínica AlfaGestão de redesPagamento recorrente (mensal) · 12 mesesTCV R$ 18.000,00Responsável: Breno BentoMover para…PropostaFechamento',
    'Proposta1Em negociação: R$ 8.000,00 (TCV)Clínica BetaSitePagamento único · 6 mesesTCV R$ 8.000,00Responsável: Breno BentoMover para…ContatoFechamento',
    'Fechamento0Nenhum cartão.',
  ]);
  assert.equal(cartoes(s).length, 2);
  assert.match(textoDaTela(s), /Cada cartão é uma negociação/);
  assert.equal(botaoDaTela(s, 'new').textContent, 'Nova negociação');
  semLixo(textoDaTela(s));
  // busca: cliente, serviço e responsável; os totais continuam os do servidor
  const busca = s.browser.find(s.screen, (el) => el.localName === 'input' && el.getAttribute('type') === 'search');
  digitar(s, busca, 'beta');
  await s.browser.flush(4);
  assert.equal(cartoes(s).length, 1);
  assert.match(cartoes(s)[0].textContent, /Clínica Beta/);
  assert.match(colunaDe(s, 'stage:1').textContent, /Nenhum cartão na busca\./);
  digitar(s, s.browser.find(s.screen, (el) => el.localName === 'input' && el.getAttribute('type') === 'search'), 'site');
  await s.browser.flush(4);
  assert.equal(cartoes(s).length, 1, 'pelo serviço');
  digitar(s, s.browser.find(s.screen, (el) => el.localName === 'input' && el.getAttribute('type') === 'search'), '');
  await s.browser.flush(4);
  assert.equal(cartoes(s).length, 2);
  assert.equal(api.quantas('quadro'), 1, 'buscar não vai ao servidor');
});

test('[FBOARD-2] VÁRIOS FUNIS: o seletor mostra só os ativos, trocar de funil lê o quadro daquele funil; sem funil, sem etapas e sem negociações a tela explica o que fazer (e para quem)', async () => {
  const api = await apiNegocios({ funnels: [funil(1), funil(2), funil(3, { ativo: false })], stages: [etapa(1, 'funnel:1', 'Contato'), etapa(2, 'funnel:2', 'Triagem'), etapa(3, 'funnel:3', 'Velha')] });
  const s = await abrirQuadro({ api });
  const seletor = s.browser.find(s.screen, (el) => el.localName === 'select' && el.getAttribute('data-action') === 'select-funnel');
  assert.deepEqual([...seletor.childNodes].map((o) => o.textContent), ['Funil 1', 'Funil 2'], 'o funil desativado não aparece');
  assert.match(textoDaTela(s), /Nenhuma negociação neste funil ainda\./);
  assert.match(textoDaTela(s), /Abra a primeira negociação: escolha o cliente, o serviço e as condições acordadas\./);
  assert.equal(botaoDaTela(s, 'new-empty').textContent, 'Nova negociação');
  escolher(s, seletor, 'funnel:2');
  await s.browser.flush(10);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'quadro'), [['quadro', null], ['quadro', 'funnel:2']]);
  assert.match(textoDaTela(s), /Triagem/);
  assert.doesNotMatch(textoDaTela(s), /Proposta/);

  // nenhum funil: ADMIN recebe o caminho da Gestão de Funis e Etapas; os demais, o pedido ao administrador
  const vazioAdmin = await abrirQuadro({ api: await apiNegocios({ funnels: [], stages: [] }), permissions: ADMIN });
  assert.match(textoDaTela(vazioAdmin), /Nenhum funil configurado ainda\./);
  assert.match(textoDaTela(vazioAdmin), /Crie o primeiro funil e as suas etapas/);
  const link = vazioAdmin.browser.find(vazioAdmin.screen, (el) => el.localName === 'a' && /Gestão de Funis e Etapas/.test(el.textContent));
  assert.equal(link.getAttribute('href'), '#/crm/configuracoes/funis');
  const vazioCloser = await abrirQuadro({ api: await apiNegocios({ funnels: [], stages: [] }), permissions: CLOSER });
  assert.match(textoDaTela(vazioCloser), /Peça a um administrador para criar o funil e as etapas\./);
  assert.equal(vazioCloser.browser.find(vazioCloser.screen, (el) => el.localName === 'a'), null, 'quem não administra não recebe o link');
  // funil sem etapas
  const semEtapas = await abrirQuadro({ api: await apiNegocios({ funnels: [funil(1)], stages: [] }), permissions: ADMIN });
  assert.match(textoDaTela(semEtapas), /Este funil ainda não tem etapas\./);
  assert.equal(semEtapas.browser.find(semEtapas.screen, (el) => el.localName === 'a' && /Gestão de Funis e Etapas/.test(el.textContent)) !== null, true);
});

test('[FBOARD-3] ERROS DE CARGA: a primeira falha mostra o erro com "Tentar novamente"; uma falha ao ATUALIZAR mantém o quadro que estava na tela e só avisa — nunca esvazia nem inventa', async () => {
  const api = await apiNegocios({ negotiations: await duas() });
  api.mem.falhas.quadro = await erroApi(500, 'INTERNAL');
  const s = await abrirQuadro({ api });
  assert.match(textoDaTela(s), /Não foi possível carregar o quadro agora\. Tente novamente\./);
  assert.equal(cartoes(s).length, 0);
  await clicar(s, botaoDaTela(s, 'retry'));
  assert.equal(cartoes(s).length, 2);
  assert.doesNotMatch(textoDaTela(s), /Não foi possível carregar/);
  // atualizar com a rede caída: o quadro fica
  api.mem.falhas.quadro = await erroApi(0, 'NETWORK');
  await clicar(s, botaoDaTela(s, 'refresh'));
  assert.equal(cartoes(s).length, 2, 'o quadro anterior continua na tela');
  assert.ok(avisos(s).some((a) => /Sem conexão com o servidor/.test(a)));
  // 403: mensagem de permissão; 404: servidor sem o quadro
  const proibido = await apiNegocios();
  proibido.mem.falhas.quadro = await erroApi(403, 'FORBIDDEN');
  assert.match(textoDaTela(await abrirQuadro({ api: proibido })), /não tem permissão para ver o quadro de negociações/);
  const antigo = await apiNegocios();
  antigo.mem.falhas.quadro = await erroApi(404, 'NOT_FOUND');
  assert.match(textoDaTela(await abrirQuadro({ api: antigo })), /não está disponível neste servidor/);
  // sem READ:CRM a tela nem chama a API
  const semLeitura = await apiNegocios();
  const bloqueada = await abrirQuadro({ api: semLeitura, permissions: { canReadCrm: false }, carregar: false });
  bloqueada.view.render();
  assert.match(textoDaTela(bloqueada), /não tem permissão para ver o Quadro de Negociações/);
  assert.deepEqual(semLeitura.chamadas, []);
});

test('[FBOARD-4] MODAL DE DETALHES: o cartão (e o botão do título) abre um modal com condições, finanças (TCV, MRR ou equivalente mensal e o cronograma) e o histórico; Escape fecha e o foco volta ao cartão; clique duplo não empilha', async () => {
  const api = await apiNegocios({ negotiations: [...(await duas()), await negociacao(3, { formaPagamento: 'RECORRENTE', periodicidade: 'TRIMESTRAL', valorNegociado: 3000, prazoMeses: 12, stageId: 'stage:3', stageNome: 'Fechamento', previsaoFechamento: '2026-12-31', eventos: [{ tipo: 'CRIADA', em: '2026-10-18T12:00:00.000Z', porNome: 'Breno Bento' }, { tipo: 'ETAPA', em: '2026-10-18T13:00:00.000Z', porNome: 'Rafael Closer', detalhe: { deEtapaNome: 'Contato', paraEtapaNome: 'Fechamento', motivo: 'Cliente topou' } }] })] });
  const s = await abrirQuadro({ api });
  const antes = api.chamadas.length;
  s.browser.click(cartaoDe(s, 'card:1'));
  s.browser.click(tituloDe(s, 'card:1'));
  await s.browser.flush(6);
  assert.equal(camadas(s).length, 1, 'um modal só (a propagação do botão é contida)');
  const texto = modal(s).textContent.replace(/\s+/g, ' ');
  assert.match(texto, /Clínica Alfa/);
  assert.match(texto, /Detalhes da negociação/);
  assert.match(texto, /Pagamento recorrente \(mensal\)/);
  assert.match(texto, /Prazo do contrato12 meses/);
  assert.match(texto, /Valor negociado.*R\$.*1\.500,00.*Valor de cada cobrança/);
  assert.match(texto, /TCV \(valor total do contrato\).*18\.000,00/);
  assert.match(texto, /MRR \(receita recorrente mensal\).*1\.500,00/);
  assert.match(texto, /12 cobranças de .*1\.500,00, todo mês/);
  assert.match(texto, /Negociação criada\./);
  assert.equal(api.chamadas.length, antes, 'abrir o modal só LÊ o que já está na tela');
  assert.deepEqual(['detail-close', 'detail-edit', 'detail-lose', 'detail-win'].map((a) => doModal(s, a).textContent), ['Fechar', 'Editar', 'Perder', 'Ganhar']);
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(modal(s), null);
  mesmo(s.browser.document.activeElement, tituloDe(s, 'card:1'), 'o foco volta ao cartão que abriu');
  // pagamento único: sem MRR nem equivalente mensal; recorrência trimestral: equivalente mensal (não MRR) e o histórico de etapa com motivo
  await clicar(s, tituloDe(s, 'card:2'));
  assert.doesNotMatch(modal(s).textContent, /MRR|Equivalente mensal/);
  assert.match(modal(s).textContent, /1 cobrança de /);
  s.browser.press('Escape');
  await s.browser.flush(4);
  await clicar(s, tituloDe(s, 'card:3'));
  const trimestral = modal(s).textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(trimestral, /MRR/, 'só a recorrência mensal tem MRR');
  assert.match(trimestral, /Equivalente mensal.*1\.000,00.*comparação; não é o que entra no caixa/);
  assert.match(trimestral, /4 cobranças de .*3\.000,00, a cada 3 meses/);
  assert.match(trimestral, /Previsão de fechamento31\/12\/2026/);
  assert.match(trimestral, /Mudou de etapa: Contato → Fechamento\. Motivo: Cliente topou/);
  assert.ok(trimestral.indexOf('Mudou de etapa') < trimestral.indexOf('Negociação criada'), 'o histórico mostra o mais recente primeiro');
  semLixo(trimestral);
});

test('[FBOARD-5] CARD AVULSO (de antes das negociações): continua no quadro, o modal diz que é só a posição do cliente, lê o histórico dele e só o ADMIN o remove (com confirmação)', async () => {
  const api = await apiNegocios({ legacyCards: [{ id: 'card:9', funnelId: 'funnel:1', stageId: 'stage:1', crmRecordId: 'crm:7', criadoEm: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z', crm: { empresa: 'Clínica Antiga', contato: 'Maria', status: 'PROSPECT', responsavel: 'Breno', proximaAcao: 'Ligar na segunda' } }] });
  const s = await abrirQuadro({ api, permissions: CLOSER });
  assert.match(cartaoDe(s, 'card:9').textContent, /Clínica Antiga/);
  assert.match(cartaoDe(s, 'card:9').textContent, /Card avulso \(sem negociação\)/);
  assert.match(cartaoDe(s, 'card:9').textContent, /Próxima ação: Ligar na segunda/);
  assert.equal(moverDe(s, 'card:9'), null, 'um card avulso não se move por aqui');
  await clicar(s, tituloDe(s, 'card:9'));
  assert.match(modal(s).textContent, /Card avulso \(sem negociação\): só a posição do cliente neste funil/);
  assert.match(modal(s).textContent, /Entrou na etapa Contato\./, 'o histórico do card');
  assert.equal(api.quantas('historico'), 1);
  assert.equal(doModal(s, 'detail-archive'), null, 'o closer não remove');
  s.browser.press('Escape');
  await s.browser.flush(4);
  const admin = await abrirQuadro({ api, permissions: ADMIN });
  await clicar(admin, tituloDe(admin, 'card:9'));
  await clicar(admin, doModal(admin, 'detail-archive'));
  assert.ok(confirmacao(admin), 'pede confirmação');
  assert.match(confirmacao(admin).textContent, /O registro do cliente no CRM e o histórico não são apagados\./);
  await clicar(admin, botao(admin, 'Remover', confirmacao(admin)));
  assert.equal(api.quantas('arquivar'), 1);
  assert.equal(cartoes(admin).length, 0);
  assert.ok(avisos(admin).includes('Card removido do funil.'));
  assert.equal(modal(admin), null, 'o modal do card removido fecha');
});

test('[FBOARD-6] MOVER: o cartão só muda de coluna DEPOIS da resposta do servidor (o quadro é relido); durante a espera nada se move; uma falha mostra o erro e o cartão continua onde estava; fechada não tem seletor', async () => {
  const api = await apiNegocios({ negotiations: await duas() });
  const s = await abrirQuadro({ api });
  const pausa = api.pausar('mover');
  escolher(s, moverDe(s, 'card:1'), 'stage:2');
  await s.browser.flush(6);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'mover'), [['mover', 'negotiation:1', 'stage:2', null]]);
  assert.match(colunaDe(s, 'stage:1').textContent, /Clínica Alfa/, 'enquanto o servidor não responde, o cartão NÃO mudou de coluna');
  assert.doesNotMatch(colunaDe(s, 'stage:2').textContent, /Clínica Alfa/);
  assert.equal(moverDe(s, 'card:1').disabled, true, 'sem mover duas vezes');
  assert.deepEqual(avisos(s), [], 'nenhum aviso de sucesso antes da resposta');
  pausa.liberar();
  await s.browser.flush(10);
  assert.match(colunaDe(s, 'stage:2').textContent, /Clínica Alfa/);
  assert.doesNotMatch(colunaDe(s, 'stage:1').textContent, /Clínica Alfa/);
  assert.ok(avisos(s).includes('Etapa atualizada.'));
  assert.equal(api.quantas('quadro'), 2, 'o quadro foi relido do servidor');
  assert.match(colunaDe(s, 'stage:2').textContent, /Em negociação: R\$.26\.000,00 \(TCV\)|Em negociação: R\$.*26\.000,00/, 'o total da coluna é o do servidor');
  // falha: o cartão fica, o erro aparece e dá para tentar de novo
  api.mem.falhas.mover = await erroApi(503, 'NEGOTIATION_PERSISTENCE');
  escolher(s, moverDe(s, 'card:1'), 'stage:3');
  await s.browser.flush(10);
  assert.match(colunaDe(s, 'stage:2').textContent, /Clínica Alfa/, 'a falha não moveu nada');
  assert.ok(avisos(s).some((a) => /As negociações não estão disponíveis agora\. Nada foi alterado\./.test(a)));
  assert.equal(moverDe(s, 'card:1').disabled, false);
  // outra pessoa já fechou: 409 -> o quadro é relido e o cartão mostra a verdade (sem seletor)
  api.mem.negotiations[0].situacao = 'GANHA';
  api.mem.falhas.mover = await erroApi(409, 'NEGOTIATION_CLOSED');
  const lidasAntes = api.quantas('quadro');
  escolher(s, moverDe(s, 'card:1'), 'stage:3');
  await s.browser.flush(10);
  assert.equal(api.quantas('quadro'), lidasAntes + 1);
  assert.equal(moverDe(s, 'card:1'), null, 'uma negociação ganha não tem seletor de etapa');
  assert.match(cartaoDe(s, 'card:1').textContent, /Ganha/);
  assert.ok(avisos(s).some((a) => /Só uma negociação aberta pode ser editada ou mudar de etapa/.test(a)));
});

test('[FBOARD-7] NOVA NEGOCIAÇÃO — bloqueios explicados: sem clientes, sem serviços ativos, sem funil; e a leitura dos clientes e serviços que falha não abre um formulário quebrado', async () => {
  const semClientes = await apiNegocios({ clients: [], negotiations: [] });
  const s1 = await abrirQuadro({ api: semClientes });
  await clicar(s1, botaoDaTela(s1, 'new'));
  assert.equal(formulario(s1), null);
  assert.match(confirmacao(s1).textContent, /Ainda não há clientes/);
  assert.match(confirmacao(s1).textContent, /sempre de um cliente que já está no CRM/);
    const irParaClientes = s1.browser.find(confirmacao(s1), (el) => el.localName === 'a');
  assert.equal(irParaClientes.getAttribute('href'), '#/crm');
  // só clientes "Não Contatar": também não há a quem abrir
  const soDnc = await apiNegocios({ clients: [cliente(1, 'Bloqueada', { status: 'DO_NOT_CONTACT' })] });
  const s2 = await abrirQuadro({ api: soDnc });
  await clicar(s2, botaoDaTela(s2, 'new'));
  assert.match(confirmacao(s2).textContent, /Ainda não há clientes/);
  const semServicos = await apiNegocios({ services: [servico(1, 'Velho', { ativo: false })] });
  const s3 = await abrirQuadro({ api: semServicos });
  await clicar(s3, botaoDaTela(s3, 'new'));
  assert.match(confirmacao(s3).textContent, /Ainda não há serviços ativos/);
  assert.match(confirmacao(s3).textContent, /Cadastre o serviço em Configurações do CRM → Serviços\./);
  const semFunil = await apiNegocios({ funnels: [], stages: [] });
  const s4 = await abrirQuadro({ api: semFunil });
  await clicar(s4, botaoDaTela(s4, 'new'));
  assert.equal(formulario(s4), null, 'sem funil o formulário não abre');
  assert.match(confirmacao(s4).textContent, /Ainda não há funil/);
  const falha = await apiNegocios();
  const s5 = await abrirQuadro({ api: falha });
  falha.mem.falhas.clientes = await erroApi(0, 'NETWORK');
  await clicar(s5, botaoDaTela(s5, 'new'));
  assert.equal(formulario(s5), null, 'sem os clientes o formulário não abre');
  assert.ok(avisos(s5).some((a) => /Sem conexão com o servidor/.test(a)));
  assert.equal(botaoDaTela(s5, 'new').disabled, false, 'dá para tentar de novo');
});

async function abrirFormulario(extras = {}) {
  const api = await apiNegocios(extras);
  const s = await abrirQuadro({ api });
  await clicar(s, botaoDaTela(s, 'new'));
  return { api, s };
}
const preencher = async (s, { cliente: c = 'crm:1', servicoId = 'service:1', forma = 'recorrente', periodicidade = 'MENSAL', prazo = '12', valor = '1.500,00' } = {}) => {
  escolher(s, campo(s, 'crmRecordId'), c);
  escolher(s, campo(s, 'serviceId'), servicoId);
  if (forma) await clicar(s, campo(s, `formaPagamento-${forma}`));
  if (periodicidade) escolher(s, campo(s, 'periodicidade'), periodicidade);
  if (['3', '6', '12'].includes(prazo)) await clicar(s, campo(s, `prazo-${prazo}`));
  else {
    await clicar(s, campo(s, 'prazo-outro'));
    digitar(s, campo(s, 'prazoMeses'), prazo);
  }
  digitar(s, campo(s, 'valorNegociado'), valor);
};

test('[FBOARD-8] NOVA NEGOCIAÇÃO — o formulário: campos reais, centralizado, só com clientes e serviços ATIVOS e sem "Não Contatar"; o serviço limita as formas de pagamento e as periodicidades; prazo em 3, 6, 12 ou outro; prévia do contrato', async () => {
  const { api, s } = await abrirFormulario({ clients: [cliente(1, 'Clínica Alfa'), cliente(2, 'Clínica Beta'), cliente(3, 'Bloqueada', { status: 'DO_NOT_CONTACT' })], services: [servico(1, 'Gestão de redes'), servico(2, 'Site', { permitePagamentoRecorrente: false, periodicidades: [] }), servico(3, 'Velho', { ativo: false }), servico(4, 'Sem forma', { permitePagamentoUnico: false, permitePagamentoRecorrente: false, periodicidades: [] })] });
  assert.deepEqual(api.chamadas.map(([n]) => n), ['quadro', 'clientes', 'servicos']);
  const f = formulario(s);
  assert.match(f.className, /\bis-centered\b/, 'no centro da tela');
  assert.deepEqual([...campo(s, 'crmRecordId').childNodes].map((o) => o.textContent), ['Escolha o cliente', 'Clínica Alfa', 'Clínica Beta'], 'o cliente Não Contatar não é oferecido');
  assert.deepEqual([...campo(s, 'serviceId').childNodes].map((o) => o.textContent), ['Escolha o serviço', 'Gestão de redes', 'Site', 'Sem forma'], 'só serviços ativos');
  assert.match(f.textContent, /Os campos marcados com \* são obrigatórios\./);
  assert.match(f.textContent, /A negociação entra na primeira etapa ativa do funil\./);
  assert.match(f.textContent, /Nada no serviço é alterado\./);
  assert.equal(campo(s, 'funnelId').value, 'funnel:1', 'o funil do quadro já vem escolhido');
  for (const nome of ['formaPagamento-unico', 'formaPagamento-recorrente', 'prazo-3', 'prazo-6', 'prazo-12', 'prazo-outro']) assert.ok(campo(s, nome), nome);
  assert.equal(campo(s, 'prazo-12').checked, true, 'o prazo começa em 12 meses');
  assert.equal(campo(s, 'prazoMeses').parentNode.hidden, true, 'o campo de outro prazo só aparece com "Outro prazo"');
  assert.equal(campo(s, 'periodicidade').parentNode.hidden, true, 'a periodicidade só aparece no pagamento recorrente');
  assert.equal(campo(s, 'formaPagamento-unico').checked || campo(s, 'formaPagamento-recorrente').checked, false, 'nenhuma forma de pagamento vem escolhida: a escolha é da negociação');
  assert.match(f.textContent, /Escolha o serviço para ver as formas de pagamento que ele permite\./);
  // serviço só-único: o recorrente fica desabilitado; o serviço que permite os dois habilita ambos
  escolher(s, campo(s, 'serviceId'), 'service:2');
  assert.equal(campo(s, 'formaPagamento-recorrente').disabled, true);
  assert.equal(campo(s, 'formaPagamento-unico').disabled, false);
  assert.match(f.textContent, /O serviço permite: pagamento único\./);
  escolher(s, campo(s, 'serviceId'), 'service:1');
  assert.equal(campo(s, 'formaPagamento-recorrente').disabled, false);
  assert.match(f.textContent, /O serviço permite: pagamento único e pagamento recorrente \(mensal, trimestral\)\./);
  // serviço legado sem forma nenhuma: avisa
  escolher(s, campo(s, 'serviceId'), 'service:4');
  assert.match(f.textContent, /Este serviço ainda não tem as formas de pagamento informadas\. Peça a um administrador para completar o cadastro do serviço\./);
  escolher(s, campo(s, 'serviceId'), 'service:1');
  // recorrente: aparece a periodicidade, só as do serviço (anual e semestral escondidas) e a prévia
  await clicar(s, campo(s, 'formaPagamento-recorrente'));
  assert.equal(campo(s, 'periodicidade').parentNode.hidden, false);
  const visiveis = [...campo(s, 'periodicidade').childNodes].filter((o) => !o.hidden).map((o) => o.textContent);
  assert.deepEqual(visiveis, ['Escolha a periodicidade', 'Mensal', 'Trimestral']);
  assert.match(campo(s, 'valorNegociado').parentNode.textContent, /Valor de CADA cobrança \(a cada período\)/);
  await clicar(s, campo(s, 'formaPagamento-unico'));
  assert.equal(campo(s, 'periodicidade').parentNode.hidden, true);
  assert.equal(campo(s, 'periodicidade').value, '', 'trocar para único limpa a periodicidade');
  assert.match(campo(s, 'valorNegociado').parentNode.textContent, /Valor TOTAL do contrato \(uma cobrança só\)/);
  // a prévia
  const previa = () => s.browser.by.id(s.browser.root, 'negotiation-preview').textContent.replace(/\s+/g, ' ').split(String.fromCharCode(160)).join(' ');
  assert.match(previa(), /Preencha a forma de pagamento, o prazo e o valor para ver o total do contrato \(TCV\) e o cronograma\./);
  digitar(s, campo(s, 'valorNegociado'), '8.000,00');
  await s.browser.flush(2);
  assert.match(previa(), /Prévia do contrato \(nada é salvo por aqui\)/);
  assert.match(previa(), /TCV \(valor total do contrato\)\s*R\$ 8\.000,00/);
  assert.match(previa(), /Cronogramas*1 cobrança de R\$ 8\.000,00/);
  assert.doesNotMatch(previa(), /MRR|Equivalente mensal/);
  await clicar(s, campo(s, 'formaPagamento-recorrente'));
  escolher(s, campo(s, 'periodicidade'), 'TRIMESTRAL');
  digitar(s, campo(s, 'valorNegociado'), '3.000,00');
  await s.browser.flush(2);
  assert.match(previa(), /TCV \(valor total do contrato\)\s*R\$ 12\.000,00/);
  assert.match(previa(), /Equivalente mensal\s*R\$ 1\.000,00 \(comparação; não é o que entra no caixa\)/);
  assert.match(previa(), /Cronogramas*4 cobranças de R\$ 3\.000,00, a cada 3 meses/);
  // prazo que não fecha com a periodicidade: a prévia avisa ANTES de salvar
  await clicar(s, campo(s, 'prazo-outro'));
  assert.equal(campo(s, 'prazoMeses').parentNode.hidden, false);
  digitar(s, campo(s, 'prazoMeses'), '10');
  await s.browser.flush(2);
  assert.match(previa(), /O prazo precisa ser um múltiplo da periodicidade/);
  digitar(s, campo(s, 'prazoMeses'), '18');
  await s.browser.flush(2);
  assert.match(previa(), /Cronogramas*6 cobranças de R\$ 3\.000,00, a cada 3 meses/);
  assert.equal(api.escritas().length, 0, 'preencher e ver a prévia não grava nada');
  semLixo(f.textContent);
});

test('[FBOARD-9] NOVA NEGOCIAÇÃO — salvar: o corpo leva SÓ os campos do contrato (valor em número, prazo inteiro), o sucesso só aparece DEPOIS da resposta, o clique duplo não cria duas, e o quadro é relido do servidor', async () => {
  const { api, s } = await abrirFormulario();
  await preencher(s, { prazo: '6', periodicidade: 'MENSAL', valor: '1.500,50' });
  escolher(s, campo(s, 'previsaoFechamento'), '2026-12-31');
  const pausa = api.pausar('criar');
  s.browser.click(botao(s, 'Salvar', formulario(s)));
  s.browser.click(botao(s, 'Salvando…', formulario(s)));
  s.browser.press('Enter', { target: campo(s, 'valorNegociado') });
  await s.browser.flush(8);
  assert.equal(api.quantas('criar'), 1, 'um único envio');
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar')[0][1], { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', prazoMeses: 6, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500.5, previsaoFechamento: '2026-12-31' });
  assert.equal(botao(s, 'Salvando…', formulario(s)).disabled, true);
  assert.equal(formulario(s).getAttribute('aria-busy'), 'true');
  assert.deepEqual(avisos(s), [], 'nenhum sucesso antes da resposta');
  assert.equal(cartoes(s).length, 0, 'o cartão novo ainda NÃO está no quadro');
  s.browser.press('Escape');
  assert.ok(formulario(s), 'salvando: ESC não fecha');
  pausa.liberar();
  await s.browser.flush(12);
  assert.equal(formulario(s), null, 'fecha depois da confirmação');
  assert.deepEqual(avisos(s), ['Negociação criada.']);
  assert.equal(api.quantas('criar'), 1);
  assert.equal(cartoes(s).length, 1);
  assert.match(colunaDe(s, 'stage:1').textContent, /Clínica Alfa/);
  assert.match(colunaDe(s, 'stage:1').textContent, /Em negociação: R\$.9\.003,00|Em negociação: R\$.*9\.003,00/, '6 meses × 1.500,50 = 9.003,00, calculado pelo servidor');
  assert.equal(api.quantas('quadro'), 2, 'relido do servidor');
  // pagamento único não leva periodicidade, mesmo que tenha sobrado uma no formulário
  await clicar(s, botaoDaTela(s, 'new'));
  await preencher(s, { cliente: 'crm:2', servicoId: 'service:2', forma: 'unico', periodicidade: null, prazo: '10', valor: '5000' });
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar')[1][1], { crmRecordId: 'crm:2', funnelId: 'funnel:1', serviceId: 'service:2', prazoMeses: 10, formaPagamento: 'UNICO', valorNegociado: 5000 });
  assert.equal(cartoes(s).length, 2);
});

test('[FBOARD-10] NOVA NEGOCIAÇÃO — validação ANTES de enviar: obrigatórios, valor, prazo, periodicidade e o que o serviço permite aparecem perto do campo, o foco vai ao primeiro erro e nada é enviado; o servidor ainda pode recusar (erros por campo) e o que foi digitado fica', async () => {
  const { api, s } = await abrirFormulario();
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.equal(api.quantas('criar'), 0);
  assert.equal(erroDoCampo(s, 'crmRecordId').textContent, 'Escolha o cliente.');
  assert.equal(erroDoCampo(s, 'serviceId').textContent, 'Escolha o serviço.');
  assert.equal(erroDoCampo(s, 'formaPagamento').textContent, 'Escolha a forma de pagamento: único ou recorrente.');
  assert.equal(erroDoCampo(s, 'valorNegociado').textContent, 'Informe o valor negociado.');
  assert.equal(erroDoCampo(s, 'crmRecordId').getAttribute('role'), 'alert');
  assert.match(formulario(s).textContent, /Confira os campos destacados e tente novamente\./);
  mesmo(s.browser.document.activeElement, campo(s, 'crmRecordId'), 'o foco vai ao primeiro campo com erro');
  // valor e prazo
  await preencher(s, { valor: '12,345', prazo: '0' });
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(erroDoCampo(s, 'valorNegociado').textContent, /duas casas/);
  assert.match(erroDoCampo(s, 'prazoMeses').textContent, /de 1 a 120/);
  digitar(s, campo(s, 'valorNegociado'), '0');
  digitar(s, campo(s, 'prazoMeses'), '10');
  escolher(s, campo(s, 'periodicidade'), 'TRIMESTRAL');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(erroDoCampo(s, 'valorNegociado').textContent, /maior que zero/);
  digitar(s, campo(s, 'valorNegociado'), '3.000,00');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(erroDoCampo(s, 'prazoMeses').textContent, /múltiplo da periodicidade/, 'a combinação que não fecha é recusada na hora');
  assert.equal(api.quantas('criar'), 0, 'nada foi enviado');
  // recorrente sem periodicidade
  escolher(s, campo(s, 'periodicidade'), '');
  digitar(s, campo(s, 'prazoMeses'), '12');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.equal(erroDoCampo(s, 'periodicidade').textContent, 'Escolha a periodicidade da cobrança recorrente.');
  // o servidor também pode recusar: os erros aparecem por campo e o que foi digitado fica
  escolher(s, campo(s, 'periodicidade'), 'TRIMESTRAL');
  api.mem.falhas.criar = await erroApi(400, 'NEGOTIATION_INVALID_INPUT', [{ path: 'serviceId', code: 'SERVICO_INATIVO' }, { path: 'crmRecordId', code: 'CLIENTE_NAO_CONTATAR' }]);
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.equal(api.quantas('criar'), 1);
  assert.equal(erroDoCampo(s, 'serviceId').textContent, 'Este serviço está desativado e não aceita negociações novas.');
  assert.match(erroDoCampo(s, 'crmRecordId').textContent, /marcado como "Não Contatar"/);
  assert.ok(formulario(s), 'o formulário continua aberto');
  assert.deepEqual([campo(s, 'valorNegociado').value, campo(s, 'prazoMeses').value, campo(s, 'periodicidade').value], ['3.000,00', '12', 'TRIMESTRAL'], 'nada digitado se perde');
  assert.equal(botao(s, 'Salvar', formulario(s)).disabled, false, 'dá para tentar de novo');
  // falha de rede / indisponível: mensagem geral, sem fechar
  api.mem.falhas.criar = await erroApi(0, 'NETWORK');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(formulario(s).textContent, /Sem conexão com o servidor/);
  api.mem.falhas.criar = await erroApi(503, 'NEGOTIATION_PERSISTENCE');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(formulario(s).textContent, /As negociações não estão disponíveis agora\. Nada foi alterado\./);
  assert.equal(cartoes(s).length, 0);
  // com alterações não salvas, fechar pergunta antes (e cancelar sem alterar não pergunta)
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.match(confirmacao(s).textContent, /Descartar alterações\?/);
  await clicar(s, botao(s, 'Descartar alterações', confirmacao(s)));
  assert.equal(formulario(s), null);
  await clicar(s, botaoDaTela(s, 'new'));
  await clicar(s, botao(s, 'Cancelar', formulario(s)));
  assert.equal(formulario(s), null);
  assert.equal(confirmacao(s), null, 'sem alteração, cancelar fecha direto');
});

test('[FBOARD-11] EDITAR: abre com os valores atuais (cliente e funil travados); só o que MUDOU vai ao servidor (o resto nunca é reenviado); sem mudança nada é enviado; uma negociação fechada não tem "Editar"', async () => {
  const api = await apiNegocios({ negotiations: await duas() });
  const s = await abrirQuadro({ api });
  await clicar(s, tituloDe(s, 'card:1'));
  await clicar(s, doModal(s, 'detail-edit'));
  assert.equal(modal(s), null, 'o modal de detalhes fecha');
  const f = formulario(s);
  assert.match(f.className, /\bis-centered\b/);
  assert.match(f.textContent, /Clínica Alfa — editar negociação/);
  assert.deepEqual([campo(s, 'crmRecordId').value, campo(s, 'crmRecordId').disabled, campo(s, 'funnelId').disabled, campo(s, 'serviceId').value, campo(s, 'valorNegociado').value, campo(s, 'periodicidade').value], ['crm:1', true, true, 'service:1', '1.500,00', 'MENSAL']);
  assert.equal(campo(s, 'formaPagamento-recorrente').checked, true);
  assert.equal(campo(s, 'prazo-12').checked, true);
  // sem mudança: nada é enviado
  await clicar(s, botao(s, 'Salvar', f));
  assert.match(f.textContent, /Nenhuma alteração foi feita\./);
  assert.equal(api.quantas('atualizar'), 0);
  // só o valor
  digitar(s, campo(s, 'valorNegociado'), '2.000,00');
  await clicar(s, botao(s, 'Salvar', f));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar'), [['atualizar', 'negotiation:1', { valorNegociado: 2000 }]], 'só o valor: a forma de pagamento e o prazo não vão');
  assert.equal(formulario(s), null);
  assert.ok(avisos(s).includes('Negociação atualizada.'));
  assert.match(colunaDe(s, 'stage:1').textContent, /TCV R\$.24\.000,00|TCV R\$.*24\.000,00/);
  // prazo "outro" (18 meses, mensal) e a previsão
  await clicar(s, tituloDe(s, 'card:1'));
  await clicar(s, doModal(s, 'detail-edit'));
  await clicar(s, campo(s, 'prazo-outro'));
  digitar(s, campo(s, 'prazoMeses'), '18');
  escolher(s, campo(s, 'previsaoFechamento'), '2027-01-15');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[1], ['atualizar', 'negotiation:1', { prazoMeses: 18, previsaoFechamento: '2027-01-15' }]);
  // trocar para pagamento único leva forma e periodicidade juntas
  await clicar(s, tituloDe(s, 'card:1'));
  await clicar(s, doModal(s, 'detail-edit'));
  await clicar(s, campo(s, 'formaPagamento-unico'));
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[2], ['atualizar', 'negotiation:1', { formaPagamento: 'UNICO', periodicidade: null }]);
  // fechada: sem Editar
  await clicar(s, tituloDe(s, 'card:2'));
  await clicar(s, doModal(s, 'detail-win'));
  await clicar(s, botao(s, 'Marcar como ganha', confirmacao(s)));
  await clicar(s, tituloDe(s, 'card:2'));
  assert.equal(doModal(s, 'detail-edit'), null);
});

test('[FBOARD-12] GANHAR e PERDER: pedem confirmação (ganhar explica que não é pagamento; perder EXIGE o motivo), só mudam a tela DEPOIS da resposta, e o erro de uma falha aparece DENTRO da confirmação, sem fechá-la', async () => {
  const api = await apiNegocios({ negotiations: await duas() });
  const s = await abrirQuadro({ api });
  await clicar(s, tituloDe(s, 'card:1'));
  await clicar(s, doModal(s, 'detail-win'));
  assert.match(confirmacao(s).textContent, /Marcar como ganha\?/);
  assert.match(confirmacao(s).textContent, /Não registra pagamento: o valor recebido virá dos pagamentos, em outra etapa do sistema\./);
  // falha: o erro fica na confirmação
  api.mem.falhas.ganhar = await erroApi(503, 'NEGOTIATION_PERSISTENCE');
  await clicar(s, botao(s, 'Marcar como ganha', confirmacao(s)));
  assert.ok(confirmacao(s), 'a confirmação continua aberta');
  assert.match(confirmacao(s).textContent, /As negociações não estão disponíveis agora\./);
  assert.equal(api.mem.negotiations[0].situacao, 'ABERTA');
  assert.deepEqual(avisos(s), []);
  // sucesso: só depois da resposta; cliques repetidos enviam uma vez
  const pausa = api.pausar('ganhar');
  s.browser.click(botao(s, 'Marcar como ganha', confirmacao(s)));
  s.browser.click(botao(s, 'Salvando…', confirmacao(s)));
  await s.browser.flush(6);
  assert.equal(api.quantas('ganhar'), 2, 'a tentativa que falhou + uma só nova');
  assert.match(cartaoDe(s, 'card:1').textContent, /Clínica Alfa/);
  assert.doesNotMatch(cartaoDe(s, 'card:1').textContent, /Ganha/, 'antes da resposta nada mudou');
  pausa.liberar();
  await s.browser.flush(12);
  assert.equal(confirmacao(s), null);
  assert.ok(avisos(s).includes('Negociação marcada como ganha.'));
  assert.match(cartaoDe(s, 'card:1').textContent, /Ganha/);
  assert.match(modal(s).textContent, /Marcada como ganha\./, 'o modal aberto mostra o novo histórico');
  assert.equal(doModal(s, 'detail-win'), null, 'uma ganha não oferece ganhar nem perder');
  s.browser.press('Escape');
  await s.browser.flush(4);
  // perder: o motivo é obrigatório
  await clicar(s, tituloDe(s, 'card:2'));
  await clicar(s, doModal(s, 'detail-lose'));
  assert.match(confirmacao(s).textContent, /Marcar como perdida\?/);
  assert.match(confirmacao(s).textContent, /Conte o motivo: ele fica no histórico da negociação\. Nada é apagado\./);
  await clicar(s, botao(s, 'Marcar como perdida', confirmacao(s)));
  assert.match(confirmacao(s).textContent, /Informe o motivo da perda\./);
  assert.equal(api.quantas('perder'), 0, 'sem motivo nada é enviado');
  digitar(s, s.browser.by.id(s.browser.root, 'negotiation-lose-reason'), '  Escolheu outra agência ');
  await clicar(s, botao(s, 'Marcar como perdida', confirmacao(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'perder'), [['perder', 'negotiation:2', 'Escolheu outra agência']]);
  assert.match(cartaoDe(s, 'card:2').textContent, /Perdida/);
  assert.match(modal(s).textContent, /Motivo da perdaEscolheu outra agência/);
  assert.ok(avisos(s).includes('Negociação marcada como perdida.'));
});

test('[FBOARD-13] OUTRA PESSOA MUDOU ANTES: ganhar uma negociação que já foi fechada (409) mostra o erro na confirmação e RELÊ o quadro, que passa a mostrar a verdade', async () => {
  const api = await apiNegocios({ negotiations: await duas() });
  const s = await abrirQuadro({ api });
  await clicar(s, tituloDe(s, 'card:1'));
  await clicar(s, doModal(s, 'detail-win'));
  api.mem.negotiations[0].situacao = 'PERDIDA';
  api.mem.negotiations[0].motivoPerda = 'Outra pessoa fechou';
  const lidas = api.quantas('quadro');
  await clicar(s, botao(s, 'Marcar como ganha', confirmacao(s)));
  assert.match(confirmacao(s).textContent, /Esta ação não é possível na situação atual da negociação\. Atualize o quadro\./);
  assert.equal(api.quantas('quadro'), lidas + 1, 'o quadro foi relido');
  assert.match(cartaoDe(s, 'card:1').textContent, /Perdida/);
  await clicar(s, botao(s, 'Cancelar', confirmacao(s)));
  assert.match(modal(s).textContent, /Motivo da perdaOutra pessoa fechou/);
});

test('[FBOARD-14] REABRIR: só o ADMIN vê a ação; confirma antes; a negociação volta a ABERTA (com o seletor de etapa) e o histórico guarda tudo', async () => {
  const fechada = await negociacao(1, { situacao: 'PERDIDA', motivoPerda: 'Sem orçamento', fechadoEm: '2026-10-18T13:00:00.000Z' });
  const api = await apiNegocios({ negotiations: [fechada] });
  const closer = await abrirQuadro({ api, permissions: CLOSER });
  await clicar(closer, tituloDe(closer, 'card:1'));
  assert.equal(doModal(closer, 'detail-reopen'), null, 'o closer não reabre');
  assert.equal(moverDe(closer, 'card:1'), null);
  closer.browser.press('Escape');
  await closer.browser.flush(4);
  const s = await abrirQuadro({ api, permissions: ADMIN });
  await clicar(s, tituloDe(s, 'card:1'));
  assert.match(modal(s).textContent, /Motivo da perdaSem orçamento/);
  await clicar(s, doModal(s, 'detail-reopen'));
  assert.match(confirmacao(s).textContent, /Reabrir a negociação\?/);
  assert.match(confirmacao(s).textContent, /O histórico guarda o fechamento e a reabertura\./);
  await clicar(s, botao(s, 'Reabrir', confirmacao(s)));
  assert.equal(api.quantas('reabrir'), 1);
  assert.ok(avisos(s).includes('Negociação reaberta.'));
  assert.doesNotMatch(cartaoDe(s, 'card:1').textContent, /Perdida/);
  assert.ok(moverDe(s, 'card:1'), 'reaberta, volta a ter o seletor de etapa');
  assert.match(modal(s).textContent, /Reaberta \(estava perdida\)\./);
  assert.ok(doModal(s, 'detail-edit') && doModal(s, 'detail-win') && doModal(s, 'detail-lose'));
});

test('[FBOARD-15] PERMISSÕES NA TELA: quem só LÊ vê o quadro e os detalhes mas não tem Nova negociação, seletor de etapa, Editar, Ganhar, Perder nem Reabrir; o closer não reabre nem remove card avulso; o ADMIN tem tudo — e o servidor decide de verdade', async () => {
  const dados = { negotiations: await duas(), legacyCards: [{ id: 'card:9', funnelId: 'funnel:1', stageId: 'stage:1', crmRecordId: 'crm:7', criadoEm: N.T, updatedAt: N.T, crm: { empresa: 'Antiga' } }] };
  const leitor = await abrirQuadro({ api: await apiNegocios(dados), permissions: LEITOR });
  assert.equal(botaoDaTela(leitor, 'new'), null);
  assert.equal(moverDe(leitor, 'card:1'), null);
  await clicar(leitor, tituloDe(leitor, 'card:1'));
  assert.deepEqual([...leitor.browser.findAll(modal(leitor), (el) => el.localName === 'button' && /^detail-/.test(el.getAttribute('data-action') || ''))].map((b) => b.getAttribute('data-action')), ['detail-close']);
  assert.equal(leitor.api.escritas().length, 0);
  const closer = await abrirQuadro({ api: await apiNegocios(dados), permissions: CLOSER });
  assert.ok(botaoDaTela(closer, 'new') && moverDe(closer, 'card:1'));
  await clicar(closer, tituloDe(closer, 'card:9'));
  assert.equal(doModal(closer, 'detail-archive'), null);
  const admin = await abrirQuadro({ api: await apiNegocios(dados), permissions: ADMIN });
  await clicar(admin, tituloDe(admin, 'card:9'));
  assert.ok(doModal(admin, 'detail-archive'));
  // o servidor continua a autoridade: 403 numa ação aparece como aviso, sem mudar o quadro
  const api = await apiNegocios(dados);
  const s = await abrirQuadro({ api, permissions: ADMIN });
  api.mem.falhas.mover = await erroApi(403, 'FORBIDDEN');
  escolher(s, moverDe(s, 'card:1'), 'stage:2');
  await s.browser.flush(10);
  assert.ok(avisos(s).includes('Sua conta não tem permissão para esta ação.'));
  assert.match(colunaDe(s, 'stage:1').textContent, /Clínica Alfa/);
});

test('[FBOARD-16] SAIR DA TELA fecha modais, formulários e confirmações abertos por ela; o HTML da tela nunca tem estilo inline nem texto técnico, e o texto vindo dos dados nunca vira marcação', async () => {
  const perigosa = await negociacao(1, { cliente: { empresa: '<img src=x onerror=alert(1)>' }, servicoNome: '<b>Serviço</b>', responsavelNome: '"><script>alert(1)</script>' });
  const api = await apiNegocios({ negotiations: [perigosa] });
  const s = await abrirQuadro({ api });
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.hasAttribute('style')).length, 0, 'nenhum estilo inline');
  assert.equal(s.browser.findAll(s.browser.root, (el) => ['img', 'script', 'b'].includes(el.localName)).length, 0, 'o texto dos dados nunca vira elemento');
  assert.match(textoDaTela(s), /<img src=x onerror=alert\(1\)>/, 'aparece como TEXTO');
  await clicar(s, tituloDe(s, 'card:1'));
  assert.equal(s.browser.findAll(modal(s), (el) => ['img', 'script', 'b'].includes(el.localName)).length, 0);
  await clicar(s, doModal(s, 'detail-lose'));
  assert.equal(camadas(s).length, 2);
  s.view.destroy();
  assert.equal(camadas(s).length, 0, 'tudo o que a tela abriu fecha com ela');
  assert.equal(s.browser.document.body.hasAttribute('data-overlay-open'), false);
  assert.equal(s.screen.childNodes.length, 0);
});

test('[FBOARD-17] OUTRA PESSOA GRAVOU ANTES (409 de concorrência do banco): mover, ganhar e editar mostram "foi alterada por outra pessoa", RELEEM o quadro e não mostram nenhum sucesso; o formulário de edição fica aberto com o que foi digitado', async () => {
  const api = await apiNegocios({ negotiations: await duas() });
  const s = await abrirQuadro({ api });
  // mover
  api.mem.falhas.mover = await erroApi(409, 'NEGOTIATION_CONFLICT');
  const antesMover = api.quantas('quadro');
  escolher(s, moverDe(s, 'card:1'), 'stage:2');
  await s.browser.flush(10);
  assert.ok(avisos(s).some((a) => /alterada por outra pessoa/.test(a)), 'o aviso explica');
  assert.equal(api.quantas('quadro'), antesMover + 1, 'o quadro foi relido');
  assert.ok(!avisos(s).includes('Etapa atualizada.'));
  // ganhar: o erro fica dentro da confirmação, e o quadro é relido
  await clicar(s, tituloDe(s, 'card:1'));
  await clicar(s, doModal(s, 'detail-win'));
  api.mem.falhas.ganhar = await erroApi(409, 'NEGOTIATION_CONFLICT');
  const antesGanhar = api.quantas('quadro');
  await clicar(s, botao(s, 'Marcar como ganha', confirmacao(s)));
  assert.match(confirmacao(s).textContent, /alterada por outra pessoa/);
  assert.equal(api.quantas('quadro'), antesGanhar + 1);
  await clicar(s, botao(s, 'Cancelar', confirmacao(s)));
  s.browser.press('Escape');
  await s.browser.flush(6);
  // editar: o formulário continua com o texto digitado, mostra o aviso e o quadro é relido
  await clicar(s, tituloDe(s, 'card:1'));
  await clicar(s, doModal(s, 'detail-edit'));
  digitar(s, campo(s, 'valorNegociado'), '1.700,00');
  api.mem.falhas.atualizar = await erroApi(409, 'NEGOTIATION_CONFLICT');
  const antesEditar = api.quantas('quadro');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.ok(formulario(s), 'o formulário continua aberto');
  assert.match(formulario(s).textContent, /alterada por outra pessoa/);
  assert.equal(campo(s, 'valorNegociado').value, '1.700,00', 'o que foi digitado fica');
  assert.equal(api.quantas('quadro'), antesEditar + 1);
});
