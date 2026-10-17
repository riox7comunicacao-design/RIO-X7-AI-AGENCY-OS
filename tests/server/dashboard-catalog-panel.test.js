// O PAINEL LATERAL dos catálogos do CRM (CRM 5.0, Fase 2B-2): endereço próprio, ESC / X / fundo / Voltar / Avançar, preservação da lista (busca, filtro) e PROTEÇÃO DE ALTERAÇÕES NÃO SALVAS
// (Descartar alterações / Continuar editando) — inclusive ao trocar de catálogo e ao sair do módulo. DOM de teste e API falsa: nenhum navegador, nenhuma rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../helpers/catalogHarness');
const { servico, nicho, apiFalsa, abrir, gaveta, confirmacao, botao, campo, linhas, nomes, acao, avisos, texto, hash, clicar, digitar, marcar, salvar, emFoco, erroApi } = H;

const mesmo = (a, b, mensagem) => assert.ok(a === b, mensagem || 'deveria ser o mesmo elemento');
const TRES = () => [servico(1, { nome: 'Gestão de redes', precoReferencia: 1500 }), servico(2, { nome: 'Criação de site' }), servico(3, { nome: 'Consultoria' })];
const LISTA = '#/crm/configuracoes/servicos';
const NOVO = `${LISTA}/novo`;
const ITEM2 = `${LISTA}/service%3A2`;

const fechar = (s) => s.browser.find(gaveta(s), (el) => el.getAttribute('data-action') === 'close');
const fundo = (s) => s.browser.find(s.browser.root, (el) => el.className === 'overlay-backdrop' && el.parentNode.getAttribute('data-overlay') === 'drawer');
const pergunta = (s) => confirmacao(s);
const botoesDa = (s, c) => s.browser.by.tag(c, 'button').map((b) => b.textContent).filter((t) => t !== '×');
const abrirNovo = async (s) => clicar(s, botao(s, 'Novo Serviço'));
const sujar = async (s, valor = 'Rascunho em andamento') => {
  digitar(s, campo(s, 'nome'), valor);
  marcar(s, 'permitePagamentoUnico'); // um serviço novo precisa de ao menos uma forma de pagamento para poder ser salvo
  await s.browser.flush(2);
};
const historico = (s) => s.browser.window.history.length;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// links diretos e histórico
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATPNL-1] LINK DIRETO: abrir #…/novo ou #…/<id> já mostra o painel sobre a lista; o endereço não muda; fechar troca a entrada do histórico (não cria outra)', async () => {
  const novo = await abrir({ api: apiFalsa({ servicos: TRES() }), hash: NOVO });
  assert.ok(gaveta(novo), 'o painel de novo serviço abre sozinho');
  assert.equal(hash(novo), NOVO);
  assert.deepEqual(nomes(novo), ['Gestão de redes', 'Criação de site', 'Consultoria'], 'a lista está atrás');
  assert.equal(historico(novo), 1);
  await clicar(novo, fechar(novo));
  assert.equal(gaveta(novo), null);
  assert.equal(hash(novo), LISTA);
  assert.equal(historico(novo), 1, 'o link direto não deixa uma entrada a mais: fechar substitui');

  const item = await abrir({ api: apiFalsa({ servicos: TRES() }), hash: ITEM2 });
  assert.ok(gaveta(item));
  assert.equal(campo(item, 'nome').value, 'Criação de site');
  assert.equal(hash(item), ITEM2);
  await clicar(item, fechar(item));
  assert.equal(hash(item), LISTA);
  assert.equal(item.api.quantas('listar'), 1);
});

test('[CATPNL-2] LINK DE UM ITEM QUE NÃO EXISTE (mais): aviso claro e volta à lista, sem painel quebrado; endereço malformado é "não encontrado"', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: TRES() }), hash: `${LISTA}/service%3Afantasma` });
  assert.equal(gaveta(s), null);
  assert.equal(hash(s), LISTA);
  assert.deepEqual(avisos(s), ['Este serviço não foi encontrado na lista.']);
  const faixa = s.browser.by.cls(s.browser.root, 'warn').filter((el) => el.localName === 'p' && /\bmessage\b/.test(el.className));
  assert.deepEqual(faixa.map((el) => el.textContent), ['Este serviço não foi encontrado na lista.'], 'o aviso na página usa o estilo de alerta (classe "warn" existente no CSS)');
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria']);
  const { parseRoute } = await H.loadRouter();
  assert.deepEqual(parseRoute(`${LISTA}/%E0%A4%A`), { name: 'not-found' });
  assert.deepEqual(parseRoute(`${LISTA}/%20`), { name: 'not-found' });
  assert.deepEqual(parseRoute(`${LISTA}/outro/mais`), { name: 'not-found' });
  assert.deepEqual(parseRoute('#/crm/configuracoes/funis/novo'), { name: 'not-found' }, 'a Gestão de Funis não tem painel');
  assert.deepEqual(parseRoute('#/crm/configuracoes/clientes/novo'), { name: 'not-found' });
});

test('[CATPNL-3] VOLTAR e AVANÇAR: o clique empilha uma entrada; Voltar fecha o painel e mantém busca, filtro e lista; Avançar reabre o mesmo item', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  const busca = s.browser.by.id(s.browser.root, 'catalog-search-servicos');
  digitar(s, busca, 'site');
  assert.deepEqual(nomes(s), ['Criação de site']);
  await clicar(s, acao(s, 'service:2', 'edit'));
  assert.equal(hash(s), ITEM2);
  assert.equal(historico(s), 2);
  assert.ok(gaveta(s));

  s.browser.window.history.back();
  await s.browser.flush(8);
  assert.equal(gaveta(s), null, 'Voltar fecha o painel');
  assert.equal(hash(s), LISTA);
  assert.equal(busca.value, 'site', 'a busca continua');
  assert.deepEqual(nomes(s), ['Criação de site'], 'o filtro continua');
  assert.equal(api.quantas('listar'), 1, 'e a lista não foi recarregada');
  mesmo(emFoco(s), acao(s, 'service:2', 'edit'), 'o foco volta ao item que abriu o painel');

  s.browser.window.history.forward();
  await s.browser.flush(8);
  assert.ok(gaveta(s), 'Avançar reabre');
  assert.equal(campo(s, 'nome').value, 'Criação de site');
  assert.equal(hash(s), ITEM2);

  // fechar pelo X de um painel aberto por clique volta UMA entrada (sem deixar entradas repetidas)
  await clicar(s, fechar(s));
  assert.equal(hash(s), LISTA);
  assert.equal(historico(s), 2);
});

test('[CATPNL-4] ESC, X e clique no fundo fecham o painel SEM alteração, sem perguntar nada; o foco volta ao botão que abriu', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: TRES() }) });
  for (const [como, fecharIsso] of [
    ['ESC', () => s.browser.press('Escape')],
    ['X', () => s.browser.click(fechar(s))],
    ['fundo', () => s.browser.click(fundo(s))],
  ]) {
    await abrirNovo(s);
    assert.ok(gaveta(s), como);
    fecharIsso();
    await s.browser.flush(6);
    assert.equal(gaveta(s), null, como);
    assert.equal(pergunta(s), null, `${como}: sem alteração não há pergunta`);
    assert.equal(hash(s), LISTA, como);
    mesmo(emFoco(s), botao(s, 'Novo Serviço'), `${como}: foco de volta ao botão`);
  }
  assert.equal(historico(s), 2, 'abrir e fechar três vezes não deixa entradas sobrando');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// alterações não salvas
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATPNL-5] ALTERAÇÃO NÃO SALVA + ESC: pergunta "Descartar alterações?" (Continuar editando em foco); continuar mantém o painel e o texto; descartar fecha e NADA vaza para o próximo painel', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  await abrirNovo(s);
  await sujar(s, 'Rascunho importante');
  digitar(s, campo(s, 'descricao'), 'Meu texto');
  s.browser.press('Escape');
  await s.browser.flush(4);
  const p = pergunta(s);
  assert.ok(p, 'pergunta antes de descartar');
  assert.equal(p.getAttribute('role'), 'alertdialog');
  assert.equal(s.browser.find(p, (el) => el.className === 'overlay-title').textContent, 'Descartar alterações?');
  assert.match(p.textContent, /Há alterações que ainda não foram salvas\. Se você fechar agora, elas serão perdidas\./);
  assert.deepEqual(botoesDa(s, p), ['Continuar editando', 'Descartar alterações']);
  assert.equal(emFoco(s).textContent, 'Continuar editando', 'o botão seguro nasce em foco');

  await clicar(s, botao(s, 'Continuar editando', p));
  assert.equal(pergunta(s), null);
  assert.ok(gaveta(s), 'o painel continua');
  assert.equal(campo(s, 'nome').value, 'Rascunho importante');
  assert.equal(campo(s, 'descricao').value, 'Meu texto');
  assert.equal(hash(s), NOVO);
  assert.equal(api.escritas().length, 0);

  s.browser.press('Escape');
  await s.browser.flush(4);
  await clicar(s, botao(s, 'Descartar alterações', pergunta(s)));
  assert.equal(gaveta(s), null);
  assert.equal(pergunta(s), null);
  assert.equal(hash(s), LISTA);
  assert.equal(api.escritas().length, 0, 'nada foi gravado');
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria']);
  mesmo(emFoco(s), botao(s, 'Novo Serviço'));

  await abrirNovo(s);
  assert.equal(campo(s, 'nome').value, '', 'o rascunho descartado não volta');
  assert.equal(campo(s, 'descricao').value, '');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(pergunta(s), null, 'um painel limpo fecha direto');
});

test('[CATPNL-6] ALTERAÇÃO NÃO SALVA + X, clique no fundo e Cancelar: a mesma pergunta nos três; em todos, "Continuar editando" preserva o rascunho', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: TRES() }) });
  await abrirNovo(s);
  await sujar(s, 'Rascunho');
  for (const [como, acionar] of [
    ['X', () => s.browser.click(fechar(s))],
    ['fundo', () => s.browser.click(fundo(s))],
    ['Cancelar', () => s.browser.click(botao(s, 'Cancelar', gaveta(s)))],
  ]) {
    acionar();
    await s.browser.flush(4);
    assert.ok(pergunta(s), `${como}: pergunta`);
    assert.equal(s.browser.find(pergunta(s), (el) => el.className === 'overlay-title').textContent, 'Descartar alterações?', como);
    await clicar(s, botao(s, 'Continuar editando', pergunta(s)));
    assert.ok(gaveta(s), `${como}: continua aberto`);
    assert.equal(campo(s, 'nome').value, 'Rascunho', como);
  }
  // Cancelar sem alteração fecha direto (marcar uma forma de pagamento também é alteração: desmarcar volta ao estado limpo)
  digitar(s, campo(s, 'nome'), '');
  marcar(s, 'permitePagamentoUnico', false);
  await s.browser.flush(2);
  await clicar(s, botao(s, 'Cancelar', gaveta(s)));
  assert.equal(gaveta(s), null);
  assert.equal(pergunta(s), null);
  // voltar o texto ao original (sem alteração líquida) também não pergunta
  await clicar(s, acao(s, 'service:2', 'edit'));
  digitar(s, campo(s, 'nome'), 'Outro nome');
  digitar(s, campo(s, 'nome'), 'Criação de site');
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(pergunta(s), null, 'sem alteração líquida não há o que perder');
  assert.equal(gaveta(s), null);
});

test('[CATPNL-7] ALTERAÇÃO NÃO SALVA + VOLTAR: o navegador já mudou o endereço, então a tela pergunta; "Continuar editando" leva o endereço de volta SEM empilhar entradas e sem perder o rascunho; "Descartar" segue', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: TRES() }) });
  await abrirNovo(s);
  await sujar(s, 'Rascunho do Voltar');
  const entradas = historico(s);
  s.browser.window.history.back();
  await s.browser.flush(8);
  assert.ok(pergunta(s), 'a pergunta aparece');
  assert.ok(gaveta(s), 'o painel não foi fechado sozinho');
  assert.equal(campo(s, 'nome').value, 'Rascunho do Voltar');

  await clicar(s, botao(s, 'Continuar editando', pergunta(s)));
  assert.equal(hash(s), NOVO, 'o endereço voltou ao painel');
  assert.equal(historico(s), entradas, 'sem entradas novas');
  assert.ok(gaveta(s));
  assert.equal(campo(s, 'nome').value, 'Rascunho do Voltar', 'o rascunho está intacto');
  assert.equal(pergunta(s), null, 'e não pergunta de novo (nenhum laço)');

  s.browser.window.history.back();
  await s.browser.flush(8);
  await clicar(s, botao(s, 'Descartar alterações', pergunta(s)));
  assert.equal(gaveta(s), null);
  assert.equal(hash(s), LISTA);
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria']);

  // Avançar com o painel limpo reabre; sujo e Voltar de novo: a mesma pergunta
  s.browser.window.history.forward();
  await s.browser.flush(8);
  assert.ok(gaveta(s));
  assert.equal(campo(s, 'nome').value, '', 'o rascunho descartado não voltou');
});

test('[CATPNL-8] OUTRO ITEM com alteração não salva: abrir outro endereço do mesmo catálogo também pergunta; só o descarte troca de item', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: TRES() }), hash: ITEM2 });
  digitar(s, campo(s, 'descricao'), 'Mudei algo');
  await s.browser.flush(2);
  s.browser.window.location.hash = `${LISTA}/service%3A3`;
  await s.browser.flush(8);
  assert.ok(pergunta(s));
  assert.equal(campo(s, 'nome').value, 'Criação de site', 'ainda o item 2');
  await clicar(s, botao(s, 'Continuar editando', pergunta(s)));
  assert.equal(hash(s), ITEM2, 'o endereço voltou ao item 2');
  assert.equal(campo(s, 'descricao').value, 'Mudei algo');

  s.browser.window.location.hash = `${LISTA}/service%3A3`;
  await s.browser.flush(8);
  await clicar(s, botao(s, 'Descartar alterações', pergunta(s)));
  assert.equal(campo(s, 'nome').value, 'Consultoria', 'agora o item 3');
  assert.equal(campo(s, 'descricao').value, '');
  assert.equal(hash(s), `${LISTA}/service%3A3`);
});

test('[CATPNL-9] SALVANDO não dá para sair: Voltar durante o envio avisa e devolve o endereço; ESC e X não fecham; ao terminar, o painel fecha normalmente', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  await abrirNovo(s);
  await sujar(s, 'Salvando');
  const pausa = api.pausar('criar');
  s.browser.click(botao(s, 'Salvar', gaveta(s)));
  await s.browser.flush(4);
  s.browser.window.history.back();
  await s.browser.flush(8);
  assert.ok(gaveta(s));
  assert.equal(pergunta(s), null, 'não pergunta: simplesmente não deixa sair');
  assert.equal(hash(s), NOVO, 'o endereço voltou');
  assert.ok(avisos(s).includes('Aguarde o salvamento terminar antes de sair.'));
  s.browser.press('Escape');
  s.browser.click(fechar(s));
  await s.browser.flush(4);
  assert.ok(gaveta(s));
  pausa.liberar();
  await s.browser.flush(8);
  assert.equal(gaveta(s), null);
  assert.equal(hash(s), LISTA);
  assert.ok(nomes(s).includes('Salvando'));
});

test('[CATPNL-10] ATUALIZAR/FECHAR A ABA: com alteração (ou salvando) a tela pede o aviso nativo do navegador; sem alteração, nunca bloqueia', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  const win = s.browser.window;
  assert.equal(win.fireBeforeUnload().prevented, false, 'lista parada: nada a pedir');
  await abrirNovo(s);
  assert.equal(win.fireBeforeUnload().prevented, false, 'painel aberto mas limpo: nada a pedir');
  await sujar(s);
  assert.equal(win.fireBeforeUnload().prevented, true, 'com alteração pede o aviso');
  const pausa = api.pausar('criar');
  s.browser.click(botao(s, 'Salvar', gaveta(s)));
  await s.browser.flush(4);
  assert.equal(win.fireBeforeUnload().prevented, true, 'salvando também pede');
  pausa.liberar();
  await s.browser.flush(8);
  assert.equal(win.fireBeforeUnload().prevented, false, 'salvo: nada a pedir');
  s.view.destroy();
  assert.equal(win.listenerCount('beforeunload'), 0, 'o guarda é removido ao destruir (sem vazamento)');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// trocar de catálogo e sair do módulo
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATPNL-11] TROCAR DE CATÁLOGO com alteração não salva (Serviços -> Nichos): pergunta; continuar editando volta ao painel de Serviços; descartar abre Nichos — cada catálogo guarda a sua própria lista', async () => {
  const api = apiFalsa({ servicos: TRES(), nichos: [nicho(1, { nome: 'Estética' })] });
  const s = await abrir({ api });
  await abrirNovo(s);
  await sujar(s, 'Rascunho de serviço');
  s.browser.window.location.hash = '#/crm/configuracoes/nichos';
  await s.browser.flush(8);
  assert.ok(pergunta(s), 'pergunta antes de trocar');
  assert.equal(s.browser.find(s.browser.root, (el) => el.localName === 'h2' && el.id === 'catalog-title-servicos') !== null, true, 'ainda é a tela de Serviços');
  assert.equal(api.quantas('listar'), 1, 'Nichos nem carregou');

  await clicar(s, botao(s, 'Continuar editando', pergunta(s)));
  assert.equal(hash(s), NOVO, 'o endereço voltou');
  assert.equal(campo(s, 'nome').value, 'Rascunho de serviço');

  s.browser.window.location.hash = '#/crm/configuracoes/nichos';
  await s.browser.flush(8);
  await clicar(s, botao(s, 'Descartar alterações', pergunta(s)));
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Nichos e Cores');
  assert.equal(gaveta(s), null, 'o painel de Serviços foi fechado');
  assert.deepEqual(nomes(s), ['Estética']);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'listar').map((c) => c[1]), ['servicos', 'nichos']);

  // voltar a Serviços: a lista está guardada, o rascunho não
  s.browser.window.location.hash = LISTA;
  await s.browser.flush(8);
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Serviços');
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria']);
  assert.equal(gaveta(s), null);
});

test('[CATPNL-12] SAIR DO MÓDULO: leaveState/confirmLeave (usados pelo menu) dizem se há o que perder; hide() fecha o painel sem navegar e guarda busca e filtros; destroy() libera tudo', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  assert.equal(s.view.leaveState(), null);
  let seguiu = 0;
  s.view.confirmLeave({ discard: () => { seguiu += 1; }, stay: () => assert.fail('não deveria ficar') });
  assert.equal(seguiu, 1, 'sem alteração segue direto');

  await abrirNovo(s);
  assert.equal(s.view.leaveState(), null, 'painel limpo: livre');
  await sujar(s);
  assert.equal(s.view.leaveState(), 'unsaved');
  assert.equal(s.view.hasUnsavedChanges(), true);
  let ficou = 0;
  s.view.confirmLeave({ discard: () => { seguiu += 1; }, stay: () => { ficou += 1; } });
  await s.browser.flush(4);
  assert.ok(pergunta(s));
  await clicar(s, botao(s, 'Continuar editando', pergunta(s)));
  assert.deepEqual([seguiu, ficou], [1, 1], 'continuar editando = ficar');
  s.view.confirmLeave({ discard: () => { seguiu += 1; }, stay: () => { ficou += 1; } });
  await s.browser.flush(4);
  await clicar(s, botao(s, 'Descartar alterações', pergunta(s)));
  assert.deepEqual([seguiu, ficou], [2, 1], 'descartar = seguir');
  assert.equal(s.view.leaveState(), null, 'depois de descartar não há mais o que perder');

  // salvando
  const pausa = api.pausar('criar');
  digitar(s, campo(s, 'nome'), 'Em voo');
  marcar(s, 'permitePagamentoUnico');
  s.browser.click(botao(s, 'Salvar', gaveta(s)));
  await s.browser.flush(4);
  assert.equal(s.view.leaveState(), 'saving');
  s.view.confirmLeave({ discard: () => { seguiu += 1; }, stay: () => { ficou += 1; } });
  assert.deepEqual([seguiu, ficou], [2, 2], 'salvando = fica');
  pausa.liberar();
  await s.browser.flush(8);

  // hide: o painel fecha sem navegar; busca e filtros ficam
  const busca = s.browser.by.id(s.browser.root, 'catalog-search-servicos');
  digitar(s, busca, 'site');
  await clicar(s, acao(s, 'service:2', 'edit'));
  const enderecoDoPainel = hash(s);
  s.view.hide();
  assert.equal(gaveta(s), null);
  assert.equal(hash(s), enderecoDoPainel, 'hide não mexe no endereço (quem saiu foi o menu)');
  assert.equal(busca.value, 'site');
  const { parseRoute } = await H.loadRouter();
  await s.view.show(parseRoute(LISTA));
  await s.browser.flush(6);
  assert.equal(busca.value, 'site', 'ao voltar, a busca está lá');
  assert.deepEqual(nomes(s), ['Criação de site']);
  assert.equal(api.quantas('listar'), 2, 'e a lista é atualizada em silêncio ao voltar');

  s.view.destroy();
  assert.equal(s.browser.root.childNodes.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// rotas
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATROUTE-1] ROTAS dos catálogos: ida e volta de lista, novo e item (id codificado); chave desconhecida, id vazio e "%" solto são "não encontrado"; o menu acende o catálogo certo; as rotas antigas não mudam', async () => {
  const { parseRoute, buildHash, sectionOf, catalogOfRoute, catalogListRouteName, CATALOG_LIST_ROUTES } = await H.loadRouter();
  const { menuItemOf } = await import('../../dashboard/nav.mjs');
  assert.deepEqual({ ...CATALOG_LIST_ROUTES }, { servicos: 'crm-settings-services', nichos: 'crm-settings-niches', origens: 'crm-settings-origins' });
  for (const [catalogo, lista, menu] of [['servicos', 'crm-settings-services', 'crm-settings-services'], ['nichos', 'crm-settings-niches', 'crm-settings-niches'], ['origens', 'crm-settings-origins', 'crm-settings-origins']]) {
    const hashDaLista = `#/crm/configuracoes/${catalogo}`;
    assert.deepEqual(parseRoute(hashDaLista), { name: lista });
    assert.equal(buildHash({ name: lista }), hashDaLista);
    const novo = { name: 'crm-catalog-new', catalog: catalogo };
    assert.deepEqual(parseRoute(`${hashDaLista}/novo`), novo);
    assert.equal(buildHash(novo), `${hashDaLista}/novo`);
    assert.deepEqual(parseRoute(`${hashDaLista}/novo/`), novo, 'barra no fim');
    for (const id of ['service:abc-123', 'niche:com espaço', 'origin:ç/ã?#%', 'x']) {
      const item = { name: 'crm-catalog-item', catalog: catalogo, id };
      const endereco = buildHash(item);
      assert.deepEqual(parseRoute(endereco), item, id);
      assert.ok(!endereco.slice(hashDaLista.length + 1).includes('/'), 'o id vai codificado, sem barras');
    }
    for (const rota of [{ name: lista }, novo, { name: 'crm-catalog-item', catalog: catalogo, id: 'a:b' }]) {
      assert.equal(catalogOfRoute(rota), catalogo);
      assert.equal(catalogListRouteName(rota), lista);
      assert.equal(sectionOf(rota), 'crm-catalogs');
      assert.equal(menuItemOf(rota), menu, 'o painel mantém aceso o item do catálogo');
    }
  }
  // o que NÃO é rota
  for (const ruim of ['#/crm/configuracoes/servicos/', '#/crm/configuracoes/servicos//', '#/crm/configuracoes/servicos/%20', '#/crm/configuracoes/servicos/%', '#/crm/configuracoes/servicos/a/b', '#/crm/configuracoes/outros/novo', '#/crm/configuracoes/__proto__/novo', '#/crm/configuracoes/constructor/x', '#/crm/configuracoes/funis/novo', '#/crm/configuracoes/funis/x']) {
    const rota = parseRoute(ruim);
    if (ruim === '#/crm/configuracoes/servicos/') assert.deepEqual(rota, { name: 'crm-settings-services' }, 'a barra final é ignorada, como nas outras rotas');
    else if (ruim === '#/crm/configuracoes/servicos//') assert.deepEqual(rota, { name: 'crm-settings-services' });
    else assert.deepEqual(rota, { name: 'not-found' }, ruim);
  }
  assert.equal(buildHash({ name: 'crm-catalog-new', catalog: 'clientes' }), '#/', 'catálogo desconhecido volta ao início');
  assert.equal(buildHash({ name: 'crm-catalog-item', catalog: 'constructor', id: 'x' }), '#/');
  assert.equal(catalogOfRoute({ name: 'crm-catalog-new', catalog: 'clientes' }), null);
  assert.equal(catalogOfRoute({ name: 'crm-settings-funnels' }), null, 'a Gestão de Funis e Etapas não é catálogo');
  assert.equal(catalogOfRoute(null), null);
  assert.equal(catalogListRouteName({ name: 'overview' }), null);
  // as rotas ANTIGAS continuam exatamente como eram
  assert.deepEqual(parseRoute('#/crm/configuracoes'), { name: 'crm-settings' });
  assert.deepEqual(parseRoute('#/crm/configuracoes/funis'), { name: 'crm-settings-funnels' });
  assert.deepEqual(parseRoute('#/crm/registro/crm%3Aa'), { name: 'crm-record', id: 'crm:a' });
  assert.equal(sectionOf({ name: 'crm-settings' }), 'crm-settings', 'a página de acessos aos cadastros');
  assert.equal(sectionOf({ name: 'crm-settings-funnels' }), 'crm-funnel-admin');
});
