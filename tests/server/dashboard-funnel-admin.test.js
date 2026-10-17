// A GESTÃO DE FUNIS E ETAPAS (dashboard/views/funnelAdmin.mjs — CRM 5.0, Fase D1): criar, renomear, ativar/desativar e excluir funis; criar, renomear, reordenar, ativar/desativar e excluir etapas.
// DOM de teste e API falsa em memória (a mesma do quadro): nenhum navegador, nenhuma rede, nenhum dado real.
// O que mais importa aqui: NADA muda na tela antes de o servidor confirmar; funil/etapa com cartões nunca é excluído (a tela explica); só quem tem MANAGE:FUNNELS usa a tela.

const test = require('node:test');
const assert = require('node:assert/strict');

const N = require('../helpers/negotiationHarness');
const { ADMIN, CLOSER, funil, etapa, negociacao, erroApi, apiNegocios, abrirAdmin, modal, confirmacao, formulario, botao, avisos, camadas, clicar, digitar } = N;

const semLixo = (texto) => assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
const acao = (s, nome, escopo) => s.browser.find(escopo || s.screen, (el) => el.localName === 'button' && el.getAttribute('data-action') === nome);
const linhaDa = (s, stageId) => s.browser.find(s.screen, (el) => el.localName === 'li' && el.getAttribute('data-stage') === stageId);
const botaoDaLinha = (s, stageId, nome) => acao(s, nome, linhaDa(s, stageId));
const funisDaLista = (s) => s.browser.findAll(s.screen, (el) => el.localName === 'button' && el.hasAttribute('data-funnel'));
const nomesDasEtapas = (s) => s.browser.findAll(s.screen, (el) => /\bfunnel-admin-stage-name\b/.test(el.className)).map((el) => el.textContent);
const texto = (s) => s.screen.textContent.replace(/\s+/g, ' ').split(String.fromCharCode(160)).join(' ');
const campoDoForm = (s, nome) => s.browser.by.id(s.browser.root, `funnel-admin-${nome}`);
const erroDe = (s, nome) => s.browser.by.id(s.browser.root, `funnel-admin-${nome}-error`);

// um funil com três etapas; a etapa 1 tem uma negociação, a 2 também, a 3 está vazia
const comCartoes = async () => ({ negotiations: [await negociacao(1), await negociacao(2, { stageId: 'stage:2', stageNome: 'Proposta', cliente: { empresa: 'Clínica Beta' }, crmRecordId: 'crm:2' })] });

test('[FADM-1] A TELA carrega a estrutura SÓ por leitura: funis em lista, o primeiro já escolhido, as etapas na ordem com a contagem de cartões de cada uma; nada é gravado', async () => {
  const api = await apiNegocios({ funnels: [funil(1), funil(2, { ativo: false })], stages: [etapa(1, 'funnel:1', 'Contato'), etapa(2, 'funnel:1', 'Proposta'), etapa(3, 'funnel:1', 'Fechamento', { ativo: false }), etapa(4, 'funnel:2', 'Velha')], ...(await comCartoes()) });
  const s = await abrirAdmin({ api });
  assert.deepEqual(api.chamadas.map(([n]) => n), ['funis', 'etapas', 'quadro'], 'só leituras');
  assert.match(texto(s), /Gestão de Funis e Etapas/);
  assert.deepEqual(funisDaLista(s).map((b) => b.textContent), ['Funil 1', 'Funil 2Desativado']);
  assert.equal(funisDaLista(s)[0].getAttribute('aria-current'), 'true');
  assert.deepEqual(nomesDasEtapas(s), ['Contato', 'Proposta', 'Fechamento']);
  assert.match(linhaDa(s, 'stage:1').textContent, /1 cartão/);
  assert.match(linhaDa(s, 'stage:2').textContent, /1 cartão/);
  assert.match(linhaDa(s, 'stage:3').textContent, /0 cartões/);
  assert.match(linhaDa(s, 'stage:3').textContent, /Desativada/);
  assert.match(texto(s), /2 cartões neste funil\./);
  assert.equal(botaoDaLinha(s, 'stage:1', 'stage-up').disabled, true, 'a primeira não sobe');
  assert.equal(botaoDaLinha(s, 'stage:3', 'stage-down').disabled, true, 'a última não desce');
  assert.equal(api.escritas().length, 0);
  semLixo(texto(s));
  // trocar de funil lê as etapas do outro (e a contagem dele); o funil desativado mostra o botão Reativar
  await clicar(s, funisDaLista(s)[1]);
  assert.deepEqual(api.chamadas.slice(3).map(([n]) => n), ['etapas', 'quadro']);
  assert.deepEqual(nomesDasEtapas(s), ['Velha']);
  assert.equal(acao(s, 'funnel-toggle').textContent, 'Reativar funil');
  assert.equal(api.chamadas.filter(([n]) => n === 'etapas').pop()[1], 'funnel:2');
});

test('[FADM-2] SEM PERMISSÃO a tela nem chama a API (a decisão real é do servidor); sem funis, estado vazio com "Novo funil"; funil sem etapas explica o que fazer', async () => {
  const api = await apiNegocios();
  const sem = await abrirAdmin({ api, permissions: CLOSER });
  assert.match(texto(sem), /Sua conta não tem permissão para administrar os funis\./);
  assert.deepEqual(api.chamadas, []);
  assert.equal(acao(sem, 'funnel-new'), null);

  const vazio = await abrirAdmin({ api: await apiNegocios({ funnels: [], stages: [] }) });
  assert.match(texto(vazio), /Nenhum funil criado ainda\./);
  assert.ok(acao(vazio, 'funnel-new'));

  const semEtapas = await abrirAdmin({ api: await apiNegocios({ funnels: [funil(1)], stages: [] }) });
  assert.match(texto(semEtapas), /Este funil ainda não tem etapas\./);
  assert.match(texto(semEtapas), /Sem etapas, não há onde colocar as negociações\./);
  assert.ok(acao(semEtapas, 'stage-new'));
});

test('[FADM-3] ERROS DE CARGA: a primeira falha mostra o erro com "Tentar novamente"; falha nas etapas tem o seu próprio "Tentar novamente"; sem a contagem de cartões a tela segue (sem inventar número)', async () => {
  const api = await apiNegocios();
  api.mem.falhas.funis = await erroApi(500, 'INTERNAL');
  const s = await abrirAdmin({ api });
  assert.match(texto(s), /Não foi possível carregar os funis agora\. Tente novamente\./);
  await clicar(s, acao(s, 'retry'));
  assert.deepEqual(nomesDasEtapas(s), ['Contato', 'Proposta', 'Fechamento']);

  const etapas = await apiNegocios();
  etapas.mem.falhas.etapas = await erroApi(0, 'NETWORK');
  const s2 = await abrirAdmin({ api: etapas });
  assert.match(texto(s2), /Não foi possível carregar as etapas deste funil\./);
  await clicar(s2, acao(s2, 'retry-stages'));
  assert.deepEqual(nomesDasEtapas(s2), ['Contato', 'Proposta', 'Fechamento']);

  const semContagem = await apiNegocios(await comCartoes());
  semContagem.mem.falhas.quadro = await erroApi(500, 'INTERNAL');
  const s3 = await abrirAdmin({ api: semContagem });
  assert.deepEqual(nomesDasEtapas(s3), ['Contato', 'Proposta', 'Fechamento'], 'as etapas aparecem');
  assert.doesNotMatch(texto(s3), /\d+ cartões?/, 'sem a contagem, nenhum número de cartões é mostrado');

  const proibido = await apiNegocios();
  proibido.mem.falhas.funis = await erroApi(403, 'FORBIDDEN');
  assert.match(texto(await abrirAdmin({ api: proibido })), /Sua conta não tem permissão para administrar os funis\./);
  const antigo = await apiNegocios();
  antigo.mem.falhas.funis = await erroApi(404, 'NOT_FOUND');
  assert.match(texto(await abrirAdmin({ api: antigo })), /não está disponível neste servidor/);
});

test('[FADM-4] NOVO FUNIL: nome obrigatório, corpo só com o que foi preenchido, o funil só aparece DEPOIS da resposta, clique duplo cria um só, e uma falha mantém o formulário e o texto digitado', async () => {
  const api = await apiNegocios();
  const s = await abrirAdmin({ api });
  await clicar(s, acao(s, 'funnel-new'));
  assert.match(formulario(s).className, /\bis-centered\b/);
  assert.match(formulario(s).textContent, /O funil nasce ativo e sem etapas/);
  await clicar(s, botao(s, 'Criar funil', formulario(s)));
  assert.equal(erroDe(s, 'nome').textContent, 'Informe o nome do funil.');
  assert.equal(api.quantas('criarFunil'), 0, 'sem nome nada é enviado');
  digitar(s, campoDoForm(s, 'nome'), '  Funil de Eventos  ');
  api.mem.falhas.criarFunil = await erroApi(503, 'FUNNEL_PERSISTENCE');
  await clicar(s, botao(s, 'Criar funil', formulario(s)));
  assert.match(formulario(s).textContent, /A estrutura dos funis não está disponível agora\. Nada foi alterado\./);
  assert.equal(campoDoForm(s, 'nome').value, '  Funil de Eventos  ', 'o que foi digitado fica');
  digitar(s, campoDoForm(s, 'descricao'), 'Eventos e feiras');
  const pausa = api.pausar('criarFunil');
  s.browser.click(botao(s, 'Criar funil', formulario(s)));
  s.browser.click(botao(s, 'Salvando…', formulario(s)));
  await s.browser.flush(6);
  assert.equal(api.quantas('criarFunil'), 2, 'a tentativa que falhou + uma só nova');
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criarFunil')[1][1], { nome: 'Funil de Eventos', descricao: 'Eventos e feiras' }, 'só os campos preenchidos, sem espaços sobrando');
  assert.equal(funisDaLista(s).length, 1, 'o funil novo ainda NÃO está na lista');
  assert.deepEqual(avisos(s), []);
  s.browser.press('Escape');
  assert.ok(formulario(s), 'salvando: ESC não fecha');
  pausa.liberar();
  await s.browser.flush(14);
  assert.equal(formulario(s), null);
  assert.deepEqual(avisos(s), ['Funil criado.']);
  assert.deepEqual(funisDaLista(s).map((b) => b.textContent), ['Funil 1', 'Funil de Eventos']);
  assert.equal(funisDaLista(s)[1].getAttribute('aria-current'), 'true', 'o funil novo já fica escolhido');
  assert.match(texto(s), /Este funil ainda não tem etapas\./);
  // com texto digitado, fechar pergunta antes; sem alteração, fecha direto
  await clicar(s, acao(s, 'funnel-new'));
  await clicar(s, botao(s, 'Cancelar', formulario(s)));
  assert.equal(formulario(s), null);
  await clicar(s, acao(s, 'funnel-new'));
  digitar(s, campoDoForm(s, 'nome'), 'Rascunho');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.match(confirmacao(s).textContent, /Descartar alterações\?/);
});

test('[FADM-5] EDITAR FUNIL: abre com os valores atuais; só o que MUDOU vai ao servidor; sem mudança nada é enviado; o nome em branco é recusado', async () => {
  const api = await apiNegocios({ funnels: [funil(1, { descricao: 'Vendas', finalidade: 'Recorrentes' })] });
  const s = await abrirAdmin({ api });
  await clicar(s, acao(s, 'funnel-edit'));
  assert.deepEqual([campoDoForm(s, 'nome').value, campoDoForm(s, 'descricao').value, campoDoForm(s, 'finalidade').value], ['Funil 1', 'Vendas', 'Recorrentes']);
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(formulario(s).textContent, /Nenhuma alteração foi feita\./);
  assert.equal(api.quantas('editarFunil'), 0);
  digitar(s, campoDoForm(s, 'nome'), '   ');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.equal(erroDe(s, 'nome').textContent, 'Informe o nome do funil.');
  digitar(s, campoDoForm(s, 'nome'), 'Vendas B2B');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'editarFunil'), [['editarFunil', 'funnel:1', { nome: 'Vendas B2B' }]], 'só o nome');
  assert.equal(formulario(s), null);
  assert.deepEqual(avisos(s), ['Funil atualizado.']);
  assert.deepEqual(funisDaLista(s).map((b) => b.textContent), ['Vendas B2B']);
});

test('[FADM-6] DESATIVAR e REATIVAR FUNIL: pedem confirmação com o IMPACTO; só mudam a tela depois da resposta; o erro fica dentro da confirmação', async () => {
  const api = await apiNegocios(await comCartoes());
  const s = await abrirAdmin({ api });
  await clicar(s, acao(s, 'funnel-toggle'));
  assert.match(confirmacao(s).textContent, /Desativar o funil\?/);
  assert.match(confirmacao(s).textContent, /deixa de aceitar negociações NOVAS/);
  assert.match(confirmacao(s).textContent, /As negociações que já estão nele não são apagadas nem alteradas\./);
  api.mem.falhas.editarFunil = await erroApi(503, 'FUNNEL_PERSISTENCE');
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.ok(confirmacao(s), 'a confirmação continua aberta');
  assert.match(confirmacao(s).textContent, /A estrutura dos funis não está disponível agora\./);
  assert.equal(api.mem.funnels[0].ativo, true);
  assert.deepEqual(avisos(s), []);
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'editarFunil').pop(), ['editarFunil', 'funnel:1', { ativo: false }]);
  assert.equal(confirmacao(s), null);
  assert.deepEqual(avisos(s), ['Funil desativado.']);
  assert.match(funisDaLista(s)[0].textContent, /Desativado/);
  assert.equal(acao(s, 'funnel-toggle').textContent, 'Reativar funil');
  await clicar(s, acao(s, 'funnel-toggle'));
  assert.match(confirmacao(s).textContent, /Reativar o funil\?/);
  await clicar(s, botao(s, 'Reativar', confirmacao(s)));
  assert.equal(api.mem.funnels[0].ativo, true);
  assert.doesNotMatch(funisDaLista(s)[0].textContent, /Desativado/);
});

test('[FADM-7] EXCLUIR FUNIL: com cartões a tela EXPLICA e nada é enviado; sem cartões pede confirmação e exclui; se outra pessoa pôs um cartão no meio (409), o erro aparece e a lista é relida', async () => {
  const api = await apiNegocios({ funnels: [funil(1), funil(2)], stages: [etapa(1, 'funnel:1', 'Contato'), etapa(2, 'funnel:2', 'Triagem')], negotiations: [await negociacao(1, { stageId: 'stage:1' })] });
  const s = await abrirAdmin({ api });
  await clicar(s, acao(s, 'funnel-delete'));
  assert.match(modal(s) ? modal(s).textContent : confirmacao(s).textContent, /Este funil tem cartões/);
  assert.match(confirmacao(s).textContent, /Mova as negociações para outro funil ou desative este funil: nada é apagado\./);
  assert.equal(api.quantas('excluirFunil'), 0);
  await clicar(s, botao(s, 'Entendi', confirmacao(s)));
  // o funil vazio: confirmação e exclusão
  await clicar(s, funisDaLista(s)[1]);
  await clicar(s, acao(s, 'funnel-delete'));
  assert.match(confirmacao(s).textContent, /Excluir o funil\?/);
  assert.match(confirmacao(s).textContent, /Só é possível porque nenhum cartão está nele\./);
  await clicar(s, botao(s, 'Excluir funil', confirmacao(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'excluirFunil'), [['excluirFunil', 'funnel:2']]);
  assert.deepEqual(avisos(s), ['Funil excluído.']);
  assert.deepEqual(funisDaLista(s).map((b) => b.textContent), ['Funil 1']);
  assert.equal(funisDaLista(s)[0].getAttribute('aria-current'), 'true', 'a escolha volta para o que existe');
  // corrida: a tela achava que estava vazio, mas o servidor recusa
  await clicar(s, acao(s, 'funnel-new'));
  digitar(s, campoDoForm(s, 'nome'), 'Outro');
  await clicar(s, botao(s, 'Criar funil', formulario(s)));
  const etapasAntes = api.quantas('etapas');
  api.mem.falhas.excluirFunil = await erroApi(409, 'FUNNEL_HAS_CARDS');
  await clicar(s, acao(s, 'funnel-delete'));
  await clicar(s, botao(s, 'Excluir funil', confirmacao(s)));
  assert.match(confirmacao(s).textContent, /Há cartões neste item: ele não pode ser excluído\./);
  assert.ok(api.quantas('funis') >= 3, 'a lista foi relida');
  assert.ok(api.quantas('etapas') >= etapasAntes);
});

test('[FADM-8] ETAPAS: nova (entra no fim), renomear (só o nome), desativar/reativar com o impacto; nada muda antes da resposta e o corpo leva só o necessário', async () => {
  const api = await apiNegocios(await comCartoes());
  const s = await abrirAdmin({ api });
  await clicar(s, acao(s, 'stage-new'));
  await clicar(s, botao(s, 'Criar etapa', formulario(s)));
  assert.equal(erroDe(s, 'nome').textContent, 'Informe o nome da etapa.');
  digitar(s, campoDoForm(s, 'nome'), ' Negociação final ');
  const pausa = api.pausar('criarEtapa');
  s.browser.click(botao(s, 'Criar etapa', formulario(s)));
  await s.browser.flush(6);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criarEtapa'), [['criarEtapa', 'funnel:1', { nome: 'Negociação final' }]]);
  assert.deepEqual(nomesDasEtapas(s), ['Contato', 'Proposta', 'Fechamento'], 'a etapa nova ainda NÃO está na lista');
  pausa.liberar();
  await s.browser.flush(14);
  assert.deepEqual(nomesDasEtapas(s), ['Contato', 'Proposta', 'Fechamento', 'Negociação final']);
  assert.deepEqual(avisos(s), ['Etapa criada.']);
  // renomear
  await clicar(s, botaoDaLinha(s, 'stage:1', 'stage-rename'));
  assert.equal(campoDoForm(s, 'nome').value, 'Contato');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(formulario(s).textContent, /Nenhuma alteração foi feita\./);
  digitar(s, campoDoForm(s, 'nome'), 'Primeiro contato');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'editarEtapa'), [['editarEtapa', 'stage:1', { nome: 'Primeiro contato' }]]);
  assert.equal(nomesDasEtapas(s)[0], 'Primeiro contato');
  // desativar uma etapa COM cartão: explica que ele fica
  await clicar(s, botaoDaLinha(s, 'stage:2', 'stage-toggle'));
  assert.match(confirmacao(s).textContent, /1 cartão está nesta etapa e continua lá: nada é movido nem apagado\./);
  assert.match(confirmacao(s).textContent, /Nenhum cartão poderá ser movido PARA uma etapa desativada\./);
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'editarEtapa').pop(), ['editarEtapa', 'stage:2', { ativo: false }]);
  assert.match(linhaDa(s, 'stage:2').textContent, /Desativada/);
  assert.equal(botaoDaLinha(s, 'stage:2', 'stage-toggle').textContent, 'Reativar');
  await clicar(s, botaoDaLinha(s, 'stage:2', 'stage-toggle'));
  await clicar(s, botao(s, 'Reativar', confirmacao(s)));
  assert.doesNotMatch(linhaDa(s, 'stage:2').textContent, /Desativada/);
});

test('[FADM-9] EXCLUIR ETAPA: com cartão a tela explica e nada é enviado; vazia pede confirmação e exclui; o erro do servidor (409) aparece na confirmação', async () => {
  const api = await apiNegocios(await comCartoes());
  const s = await abrirAdmin({ api });
  await clicar(s, botaoDaLinha(s, 'stage:1', 'stage-delete'));
  assert.match(confirmacao(s).textContent, /Esta etapa tem cartões/);
  assert.match(confirmacao(s).textContent, /1 cartão está nesta etapa, por isso ela não pode ser excluída\./);
  assert.equal(api.quantas('excluirEtapa'), 0);
  await clicar(s, botao(s, 'Entendi', confirmacao(s)));
  // a vazia
  await clicar(s, botaoDaLinha(s, 'stage:3', 'stage-delete'));
  assert.match(confirmacao(s).textContent, /Excluir a etapa\?/);
  await clicar(s, botao(s, 'Excluir etapa', confirmacao(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'excluirEtapa'), [['excluirEtapa', 'stage:3']]);
  assert.deepEqual(nomesDasEtapas(s), ['Contato', 'Proposta']);
  assert.deepEqual(avisos(s), ['Etapa excluída.']);
  // o servidor recusa (alguém pôs um cartão na etapa vazia)
  api.mem.falhas.excluirEtapa = await erroApi(409, 'STAGE_HAS_CARDS');
  await clicar(s, botaoDaLinha(s, 'stage:1', 'stage-delete'));
  await clicar(s, botao(s, 'Entendi', confirmacao(s)));
  api.mem.negotiations.length = 0; // a tela ainda não sabe
  await clicar(s, botaoDaLinha(s, 'stage:2', 'stage-delete'));
  assert.ok(confirmacao(s));
});

test('[FADM-10] REORDENAR: as setas mandam a lista COMPLETA de ids na nova ordem, a tela só muda depois da resposta (relida), uma falha deixa a ordem como estava, e não há clique duplo', async () => {
  const api = await apiNegocios();
  const s = await abrirAdmin({ api });
  const pausa = api.pausar('reordenar');
  s.browser.click(botaoDaLinha(s, 'stage:2', 'stage-up'));
  s.browser.click(botaoDaLinha(s, 'stage:2', 'stage-up'));
  await s.browser.flush(6);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'reordenar'), [['reordenar', 'funnel:1', ['stage:2', 'stage:1', 'stage:3']]], 'um envio só, com todas as etapas');
  assert.deepEqual(nomesDasEtapas(s), ['Contato', 'Proposta', 'Fechamento'], 'a ordem na tela ainda é a antiga');
  assert.ok(botaoDaLinha(s, 'stage:2', 'stage-up').disabled, 'enquanto salva, as ações ficam desabilitadas');
  pausa.liberar();
  await s.browser.flush(14);
  assert.deepEqual(nomesDasEtapas(s), ['Proposta', 'Contato', 'Fechamento']);
  assert.deepEqual(avisos(s), ['Ordem das etapas atualizada.']);
  api.mem.falhas.reordenar = await erroApi(503, 'FUNNEL_PERSISTENCE');
  await clicar(s, botaoDaLinha(s, 'stage:3', 'stage-up'));
  assert.deepEqual(nomesDasEtapas(s), ['Proposta', 'Contato', 'Fechamento'], 'a falha não mudou a ordem');
  assert.ok(avisos(s).some((a) => /A estrutura dos funis não está disponível agora\./.test(a)));
  await clicar(s, botaoDaLinha(s, 'stage:1', 'stage-down'));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'reordenar').pop()[2], ['stage:2', 'stage:3', 'stage:1']);
});

test('[FADM-11] SAIR DA TELA fecha o que ela abriu; nenhum estilo inline; nomes vindos dos dados nunca viram marcação', async () => {
  const perigoso = { funnels: [funil(1, { nome: '<img src=x onerror=alert(1)>' })], stages: [etapa(1, 'funnel:1', '"><script>alert(1)</script>')] };
  const api = await apiNegocios(perigoso);
  const s = await abrirAdmin({ api });
  assert.equal(s.browser.findAll(s.screen, (el) => el.hasAttribute('style')).length, 0);
  assert.equal(s.browser.findAll(s.screen, (el) => ['img', 'script'].includes(el.localName)).length, 0);
  assert.match(texto(s), /<img src=x onerror=alert\(1\)>/);
  // com uma janela aberta a tela fica inerte (nada por trás recebe clique): cada camada é testada na sua vez
  await clicar(s, acao(s, 'funnel-new'));
  assert.equal(camadas(s).length, 1);
  s.view.destroy();
  assert.equal(camadas(s).length, 0, 'o formulário fecha com a tela');
  assert.equal(s.screen.childNodes.length, 0);
  const outra = await abrirAdmin({ api: await apiNegocios(perigoso) });
  await clicar(outra, botaoDaLinha(outra, 'stage:1', 'stage-toggle'));
  assert.equal(camadas(outra).length, 1);
  assert.match(confirmacao(outra).textContent, /<script>alert\(1\)<\/script>/, 'o nome aparece como texto');
  assert.equal(outra.browser.findAll(outra.browser.root, (el) => el.localName === 'script').length, 0);
  outra.view.destroy();
  assert.equal(camadas(outra).length, 0, 'a confirmação fecha com a tela');
});
