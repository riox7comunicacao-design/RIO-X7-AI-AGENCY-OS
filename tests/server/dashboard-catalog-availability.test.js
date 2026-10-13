// A DISPONIBILIDADE dos catálogos do CRM (CRM 5.0, Fase 2B-2, refinamento): quando o servidor CONFIRMA (503) que a estrutura dos cadastros está indisponível — por exemplo, a migration ainda NÃO foi
// aplicada —, a tela explica com clareza, PAUSA toda gravação (criar, editar, ativar/desativar, reordenar: nada é enviado), mantém a navegação e o "Tentar novamente" e preserva o rascunho de um
// painel aberto. Uma falha TRANSITÓRIA (rede, erro comum) NÃO é tratada como ausência da estrutura. Sucesso só depois da confirmação do servidor. DOM de teste e API falsa: nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConstants = require('../../src/auth/constants');
const { createBrowser } = require('../helpers/fakeDom');
const H = require('../helpers/catalogHarness');

const { servico, nicho, origem, apiFalsa, abrir, gaveta, confirmacao, botao, campo, linhas, nomes, acao, avisos, texto, hash, clicar, digitar, salvar, erroApi } = H;

const mesmo = (a, b, mensagem) => assert.ok(a === b, mensagem || 'deveria ser o mesmo elemento');
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const INDISPONIVEL = /Os cadastros não estão disponíveis agora\. Isso acontece, por exemplo, quando a estrutura de dados dos cadastros ainda não foi preparada neste ambiente\. Nada foi alterado\./;
const PAUSADO = /Enquanto isso, nada é enviado: criar, editar, ativar, desativar e reordenar ficam pausados\./;
const CATALOGOS = [
  ['servicos', 'Novo Serviço', () => [servico(1, { nome: 'Gestão de redes' }), servico(2, { nome: 'Site' })]],
  ['nichos', 'Novo Nicho', () => [nicho(1, { nome: 'Estética' }), nicho(2, { nome: 'Odontologia' })]],
  ['origens', 'Nova Origem', () => [origem(1, { nome: 'Indicação' }), origem(2, { nome: 'Anúncio' })]],
];
const LISTA = { servicos: '#/crm/configuracoes/servicos', nichos: '#/crm/configuracoes/nichos', origens: '#/crm/configuracoes/origens' };
const tela = (s, catalogo) => s.view.screen(catalogo);
const indisponivel = async (api) => {
  api.mem.sempre.listar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
};
const voltou = (api) => {
  delete api.mem.sempre.listar;
};
const faixa = (s) => s.browser.by.cls(s.browser.root, 'catalog-unavailable');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// a leitura da lista falha com 503
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATAV-1] 503 AO CARREGAR (nos três catálogos): mensagem clara em português, "Novo …" DESABILITADO, nenhuma gravação, e "Tentar novamente" traz a lista de volta e reabilita tudo', async () => {
  for (const [catalogo, rotuloNovo, itens] of CATALOGOS) {
    const api = apiFalsa({ [catalogo]: itens() });
    await indisponivel(api);
    const s = await abrir({ catalogo, api });
    assert.match(texto(s), INDISPONIVEL, catalogo);
    assert.equal(linhas(s).length, 0, 'nenhum item inventado');
    assert.equal(botao(s, rotuloNovo).disabled, true, `${catalogo}: criar fica desabilitado`);
    assert.ok(botao(s, 'Tentar novamente'), 'a nova tentativa continua disponível');
    assert.equal(tela(s, catalogo).isUnavailable(), true);
    assert.doesNotMatch(texto(s), /PGRST|schema cache|crm_|undefined|null/);
    s.browser.click(botao(s, rotuloNovo));
    await s.browser.flush(4);
    assert.equal(gaveta(s), null, 'um botão desabilitado não abre o painel');
    assert.equal(api.escritas().length, 0, 'nenhuma gravação');
    assert.equal(hash(s), LISTA[catalogo]);

    const leituras = api.quantas('listar');
    await clicar(s, botao(s, 'Tentar novamente'));
    assert.equal(api.quantas('listar'), leituras + 1, 'tentar de novo é uma nova LEITURA');
    assert.equal(botao(s, rotuloNovo).disabled, true, 'continua pausado enquanto o servidor segue indisponível');

    voltou(api);
    await clicar(s, botao(s, 'Tentar novamente'));
    assert.equal(linhas(s).length, 2, `${catalogo}: a lista voltou`);
    assert.equal(botao(s, rotuloNovo).disabled, false, 'criar volta');
    assert.equal(tela(s, catalogo).isUnavailable(), false);
    assert.doesNotMatch(texto(s), INDISPONIVEL);
    await clicar(s, botao(s, rotuloNovo));
    assert.ok(gaveta(s), 'e o painel abre');
  }
});

test('[CATAV-2] CRIAR por LINK DIRETO com a indisponibilidade confirmada: o painel NÃO abre, o endereço volta à lista, o motivo é explicado e nenhuma gravação é feita — nos três catálogos', async () => {
  for (const [catalogo, , itens] of CATALOGOS) {
    const api = apiFalsa({ [catalogo]: itens() });
    await indisponivel(api);
    const s = await abrir({ catalogo, api, hash: `${LISTA[catalogo]}/novo` });
    assert.equal(gaveta(s), null, catalogo);
    assert.equal(hash(s), LISTA[catalogo], 'o endereço volta à lista');
    assert.match(texto(s), /Não é possível criar agora: os cadastros estão indisponíveis\./);
    assert.match(texto(s), INDISPONIVEL);
    assert.equal(api.escritas().length, 0);
  }
  // a lista JÁ carregada e a indisponibilidade só confirmada depois: o link para criar também é barrado
  const api = apiFalsa({ servicos: [servico(1)] });
  const s = await abrir({ api });
  assert.equal(linhas(s).length, 1);
  await indisponivel(api);
  await clicar(s, botao(s, 'Atualizar'));
  assert.equal(tela(s, 'servicos').isUnavailable(), true);
  assert.equal(linhas(s).length, 1, 'a lista que já estava na tela fica (só leitura)');
  s.browser.window.location.hash = `${LISTA.servicos}/novo`;
  await s.browser.flush(10);
  assert.equal(gaveta(s), null);
  assert.equal(hash(s), LISTA.servicos);
  assert.equal(api.escritas().length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// falhas TRANSITÓRIAS não são "estrutura ausente"
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATAV-3] FALHA DE REDE ao carregar NÃO é indisponibilidade da estrutura: a mensagem é a de conexão, criar continua habilitado e uma gravação É enviada (e só confirmada pelo servidor)', async () => {
  const api = apiFalsa({ servicos: [servico(1)] });
  api.mem.falhas.listar = await erroApi(0, 'NETWORK');
  const s = await abrir({ api });
  assert.match(texto(s), /Sem conexão com o servidor\. Verifique a internet e tente novamente\. Nada foi alterado\./);
  assert.doesNotMatch(texto(s), INDISPONIVEL, 'não se diz que a estrutura está ausente');
  assert.equal(tela(s, 'servicos').isUnavailable(), false);
  assert.equal(botao(s, 'Novo Serviço').disabled, false, 'uma falha de rede é transitória: nada é bloqueado');
  assert.equal(faixa(s).length, 0);
  // dá para tentar criar: a gravação é enviada e, só com a resposta do servidor, o sucesso aparece
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Serviço novo');
  const pausa = api.pausar('criar');
  s.browser.click(botao(s, 'Salvar', gaveta(s)));
  await s.browser.flush(4);
  assert.equal(api.quantas('criar'), 1, 'a gravação saiu');
  assert.deepEqual(avisos(s), [], 'nenhum sucesso antes da resposta');
  pausa.liberar();
  await s.browser.flush(8);
  assert.deepEqual(avisos(s), ['Serviço criado.']);
  assert.equal(gaveta(s), null);
});

test('[CATAV-4] ERROS COMUNS (rede, 500) em ativar/desativar/reordenar/criar NUNCA pausam as gravações: os botões seguem habilitados e a segunda tentativa é enviada', async () => {
  const api = apiFalsa({ servicos: [servico(1), servico(2), servico(3)] });
  const s = await abrir({ api });
  api.mem.falhas.reativar = null;
  // reordenar: rede, depois 500
  api.mem.falhas.reordenar = await erroApi(0, 'NETWORK');
  await clicar(s, acao(s, 'service:2', 'up'));
  assert.match(texto(s), /Sem conexão com o servidor/);
  api.mem.falhas.reordenar = await erroApi(500, 'INTERNAL');
  await clicar(s, acao(s, 'service:2', 'up'));
  assert.match(texto(s), /Não foi possível concluir agora/);
  assert.equal(tela(s, 'servicos').isUnavailable(), false);
  assert.equal(acao(s, 'service:2', 'up').disabled, false);
  await clicar(s, acao(s, 'service:2', 'up'));
  assert.equal(api.quantas('reordenar'), 3, 'a terceira tentativa foi enviada e funcionou');
  assert.deepEqual(nomes(s).slice(0, 2), ['Serviço 2', 'Serviço 1']);
  // desativar: rede, depois funciona
  api.mem.falhas.desativar = await erroApi(0, 'NETWORK');
  await clicar(s, acao(s, 'service:3', 'toggle'));
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.ok(confirmacao(s), 'a confirmação continua aberta com o erro');
  assert.match(confirmacao(s).textContent, /Sem conexão com o servidor/);
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.equal(confirmacao(s), null);
  assert.match(linhas(s).at(-1).textContent, /Inativo/);
  assert.equal(api.quantas('desativar'), 2);
  assert.equal(botao(s, 'Novo Serviço').disabled, false);
  assert.equal(faixa(s).length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o painel aberto e o rascunho
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATAV-5] RASCUNHO com a indisponibilidade confirmada ao salvar: o painel fica aberto com TUDO o que foi digitado, explica o problema, pausa o Salvar (nem Enter envia), mantém a proteção de saída e, com "Verificar novamente", volta a salvar — sucesso só depois do servidor', async () => {
  const api = apiFalsa({ servicos: [servico(1)] });
  const s = await abrir({ api });
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Serviço de longa descrição');
  digitar(s, campo(s, 'descricao'), 'Um texto que levou tempo para escrever');
  digitar(s, campo(s, 'precoReferencia'), '1.250,00');
  s.browser.choose(campo(s, 'tipoCobranca'), 'UNICA');

  api.mem.sempre.criar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
  await salvar(s);
  assert.equal(api.quantas('criar'), 1);
  assert.ok(gaveta(s), 'o painel continua aberto');
  assert.match(gaveta(s).textContent, INDISPONIVEL);
  assert.match(gaveta(s).textContent, PAUSADO);
  assert.match(gaveta(s).textContent, /O que você digitou foi mantido nesta tela\. Quando os cadastros voltarem a responder, use "Verificar novamente" e salve\./);
  assert.equal(faixa(s).filter((el) => gaveta(s).contains(el)).length, 1, 'um único aviso no painel');
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, true);
  assert.equal(campo(s, 'nome').value, 'Serviço de longa descrição');
  assert.equal(campo(s, 'descricao').value, 'Um texto que levou tempo para escrever');
  assert.equal(campo(s, 'precoReferencia').value, '1.250,00');
  assert.equal(campo(s, 'tipoCobranca').value, 'UNICA');
  assert.deepEqual(avisos(s), [], 'nada de sucesso');
  assert.equal(botao(s, 'Novo Serviço').disabled, true, 'a tela por trás também pausa');

  // nada mais é enviado: clique, Enter e envio programático
  s.browser.click(botao(s, 'Salvar', gaveta(s)));
  s.browser.press('Enter', { target: campo(s, 'nome') });
  await s.browser.flush(6);
  assert.equal(api.quantas('criar'), 1, 'nenhuma segunda gravação');

  // a proteção de saída continua valendo para o rascunho: ESC pergunta; "Continuar editando" mantém tudo
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.ok(confirmacao(s));
  await clicar(s, botao(s, 'Continuar editando', confirmacao(s)));
  assert.equal(campo(s, 'descricao').value, 'Um texto que levou tempo para escrever');
  assert.ok(gaveta(s));

  // "Verificar novamente" com o servidor ainda fora (a leitura também falha com 503): continua pausado, o rascunho fica e a verificação foi uma LEITURA
  await indisponivel(api);
  const leituras = api.quantas('listar');
  await clicar(s, botao(s, 'Verificar novamente', gaveta(s)));
  assert.equal(api.quantas('listar'), leituras + 1);
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, true);
  assert.equal(api.quantas('criar'), 1);
  assert.equal(campo(s, 'nome').value, 'Serviço de longa descrição');

  // uma falha de REDE na verificação não "libera" nem "condena": segue pausado, sem enviar nada
  voltou(api);
  api.mem.falhas.listar = await erroApi(0, 'NETWORK');
  await clicar(s, botao(s, 'Verificar novamente', gaveta(s)));
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, true, 'sem confirmação de volta, continua pausado');
  assert.equal(api.quantas('criar'), 1);

  // o servidor volta: a verificação libera o Salvar; a gravação sai e o sucesso só aparece DEPOIS da resposta
  delete api.mem.sempre.criar;
  await clicar(s, botao(s, 'Verificar novamente', gaveta(s)));
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, false);
  assert.equal(faixa(s).filter((el) => gaveta(s).contains(el)).length, 0, 'o aviso some');
  assert.equal(campo(s, 'nome').value, 'Serviço de longa descrição', 'o rascunho sobreviveu a tudo');
  const pausa = api.pausar('criar');
  s.browser.click(botao(s, 'Salvar', gaveta(s)));
  await s.browser.flush(4);
  assert.equal(api.quantas('criar'), 2);
  assert.deepEqual(avisos(s).filter((a) => /criado|salvo|atualizado/i.test(a)), [], 'nenhum sucesso antes da confirmação do servidor (o aviso de rede de antes não é um sucesso)');
  assert.doesNotMatch(texto(s), /Serviço criado/);
  pausa.liberar();
  await s.browser.flush(8);
  assert.deepEqual(avisos(s), ['Serviço criado.']);
  assert.equal(gaveta(s), null);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar')[1].slice(1), ['servicos', { nome: 'Serviço de longa descrição', descricao: 'Um texto que levou tempo para escrever', precoReferencia: 1250, tipoCobranca: 'UNICA' }]);
});

test('[CATAV-6] EDITAR com a indisponibilidade confirmada: o painel abre já avisando, com o Salvar pausado e as alterações digitadas preservadas; nada é enviado', async () => {
  const api = apiFalsa({ servicos: [servico(1, { nome: 'Gestão de redes' }), servico(2)] });
  const s = await abrir({ api });
  api.mem.falhas.atualizar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
  await clicar(s, acao(s, 'service:1', 'edit'));
  digitar(s, campo(s, 'descricao'), 'Descrição nova');
  await salvar(s); // 503 confirmado pelo servidor
  assert.equal(api.quantas('atualizar'), 1);
  assert.match(gaveta(s).textContent, INDISPONIVEL);
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, true);
  assert.equal(campo(s, 'descricao').value, 'Descrição nova');
  await clicar(s, botao(s, 'Cancelar', gaveta(s)));
  await clicar(s, botao(s, 'Descartar alterações', confirmacao(s)));
  assert.equal(gaveta(s), null);
  // abrir OUTRO item agora: avisa desde o início e não envia
  await clicar(s, acao(s, 'service:2', 'edit'));
  assert.match(gaveta(s).textContent, INDISPONIVEL);
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, true);
  digitar(s, campo(s, 'descricao'), 'Outra');
  s.browser.press('Enter', { target: campo(s, 'nome') });
  await s.browser.flush(4);
  assert.equal(api.quantas('atualizar'), 1, 'nenhuma segunda gravação');
  assert.equal(api.escritas().length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// a lista, quando a indisponibilidade aparece numa ação
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATAV-7] 503 EM UMA AÇÃO (reativar, desativar ou reordenar): a lista fica (só leitura), um aviso persistente com "Tentar novamente" aparece, criar, ativar, desativar e reordenar ficam pausados, abrir o item continua, e uma leitura bem-sucedida reabilita', async () => {
  for (const acaoQueFalha of ['reordenar', 'ativar', 'desativar']) {
    const api = apiFalsa({ servicos: [servico(1), servico(2, { ativo: false }), servico(3)] });
    const s = await abrir({ api });
    api.mem.falhas[acaoQueFalha] = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
    if (acaoQueFalha === 'reordenar') await clicar(s, acao(s, 'service:3', 'up'));
    else if (acaoQueFalha === 'ativar') await clicar(s, acao(s, 'service:2', 'toggle'));
    else {
      await clicar(s, acao(s, 'service:1', 'toggle'));
      await clicar(s, botao(s, 'Desativar', confirmacao(s)));
      await clicar(s, botao(s, 'Cancelar', confirmacao(s)));
    }
    assert.equal(tela(s, 'servicos').isUnavailable(), true, acaoQueFalha);
    assert.equal(faixa(s).length, 1, `${acaoQueFalha}: o aviso persistente (uma só vez)`);
    assert.match(faixa(s)[0].textContent, INDISPONIVEL);
    assert.match(faixa(s)[0].textContent, PAUSADO);
    assert.equal(linhas(s).length, 3, 'a lista continua à vista');
    assert.deepEqual(nomes(s), ['Serviço 1', 'Serviço 2', 'Serviço 3'], 'a ordem anterior foi restaurada');
    assert.equal(botao(s, 'Novo Serviço').disabled, true);
    for (const id of ['service:1', 'service:2', 'service:3']) for (const nomeDaAcao of ['up', 'down', 'toggle']) assert.equal(acao(s, id, nomeDaAcao).disabled, true, `${acaoQueFalha}: ${id} ${nomeDaAcao}`);
    assert.equal(acao(s, 'service:1', 'edit').disabled, false, 'abrir o item para ler continua');
    assert.deepEqual(avisos(s).filter((a) => /criado|atualizad|desativado|reativado/.test(a)), [], 'nenhum sucesso');

    const escritas = api.escritas().length;
    for (const id of ['service:1', 'service:2', 'service:3']) for (const nomeDaAcao of ['up', 'down', 'toggle']) s.browser.click(acao(s, id, nomeDaAcao));
    s.browser.click(botao(s, 'Novo Serviço'));
    await s.browser.flush(6);
    assert.equal(api.escritas().length, escritas, 'nenhuma gravação enquanto durar');
    assert.equal(gaveta(s), null);
    assert.equal(confirmacao(s), null);

    await clicar(s, botao(s, 'Tentar novamente'));
    assert.equal(tela(s, 'servicos').isUnavailable(), false);
    assert.equal(faixa(s).length, 0);
    assert.equal(botao(s, 'Novo Serviço').disabled, false);
    assert.equal(acao(s, 'service:3', 'up').disabled, false);
  }
});

test('[CATAV-8] NÃO ENVIA GRAVAÇÃO CONHECIDAMENTE CONDENADA: com a indisponibilidade confirmada, tentar por todos os caminhos (botões, Enter, link direto, chamada programática) deixa a contagem de gravações exatamente onde estava', async () => {
  const api = apiFalsa({ servicos: [servico(1), servico(2)] });
  const s = await abrir({ api });
  api.mem.falhas.criar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Condenado');
  await salvar(s);
  assert.equal(api.escritas().length, 1, 'só a tentativa que revelou a indisponibilidade');
  await clicar(s, botao(s, 'Cancelar', gaveta(s)));
  await clicar(s, botao(s, 'Descartar alterações', confirmacao(s)));

  const antes = api.escritas().length;
  tela(s, 'servicos').openNew(); // chamada programática
  await s.browser.flush(4);
  assert.equal(gaveta(s), null, 'nem a chamada programática abre o painel de criação');
  s.browser.click(botao(s, 'Novo Serviço'));
  s.browser.window.location.hash = `${LISTA.servicos}/novo`;
  await s.browser.flush(10);
  for (const id of ['service:1', 'service:2']) for (const nomeDaAcao of ['up', 'down', 'toggle']) s.browser.click(acao(s, id, nomeDaAcao));
  await clicar(s, acao(s, 'service:1', 'edit'));
  digitar(s, campo(s, 'nome'), 'Outro nome');
  await salvar(s);
  s.browser.press('Enter', { target: campo(s, 'nome') });
  await s.browser.flush(6);
  assert.equal(api.escritas().length, antes, 'zero gravações novas');
  assert.deepEqual(api.chamadas.filter(([n]) => ['ativar', 'desativar', 'reordenar'].includes(n)), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// o painel inteiro: navegação preservada
// ---------------------------------------------------------------------------------------------------------------------------------------------

const ME_ADMIN = { userId: 'user-breno', name: 'Breno', role: 'ADMIN', permissions: [...authConstants.getRolePermissions('ADMIN')], status: 'ACTIVE' };

test('[CATAV-9] NO PAINEL com os cadastros indisponíveis: a navegação continua (Configurações ↔ telas, migalha, Voltar), "Tentar novamente" faz novas LEITURAS, nenhuma gravação sai e o sucesso nunca é mostrado', async () => {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await H.loadRouter();
  const { createFakeSdk, scriptedFetch, FAKE_SESSION } = await loadFixtures();
  const fora = () => ({ status: 503, body: { error: { code: 'CRM_CATALOG_PERSISTENCE', message: 'Não foi possível ler ou gravar os cadastros agora.' } } });
  const browser = createBrowser({ hash: '#/crm/configuracoes' });
  const fetchImpl = scriptedFetch({
    'GET /config.json': CONFIG,
    'GET /api/me': ME_ADMIN,
    'GET /api/crm': { items: [] },
    'GET /api/approvals': { estado: 'AGUARDANDO_REVISAO', items: [] },
    'GET /api/crm-catalogs/servicos': fora,
    'GET /api/crm-catalogs/nichos': fora,
    'GET /api/crm-catalogs/origens': fora,
  });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk: createFakeSdk({ session: FAKE_SESSION }), navigation: browserNavigation(browser.window) });
  await browser.flush(10);
  const principal = () => browser.by.id(browser.root, 'main');
  const ir = async (alvo) => {
    browser.window.location.hash = alvo;
    await browser.flush(10);
  };
  const catalogos = () => fetchImpl.calls.filter((c) => c.path.startsWith('/api/crm-catalogs'));
  assert.equal(browser.by.tag(principal(), 'h2')[0].textContent, 'Configurações do CRM');
  assert.equal(catalogos().length, 0, 'a página de Configurações não chama a API');

  for (const [id, rota, titulo, rotuloNovo] of [['servicos', '#/crm/configuracoes/servicos', 'Serviços', 'Novo Serviço'], ['nichos', '#/crm/configuracoes/nichos', 'Nichos e Cores', 'Novo Nicho'], ['origens', '#/crm/configuracoes/origens', 'Origens dos Leads', 'Nova Origem']]) {
    browser.click(browser.find(principal(), (el) => el.localName === 'a' && el.getAttribute('data-entry') === id));
    await browser.flush(10);
    assert.equal(browser.window.location.hash, rota);
    assert.equal(browser.by.tag(principal(), 'h2')[0].textContent, titulo);
    assert.match(principal().textContent, INDISPONIVEL);
    assert.equal(browser.by.button(principal(), rotuloNovo).disabled, true, `${titulo}: criar pausado`);
    const leituras = catalogos().length;
    browser.click(browser.by.button(principal(), 'Tentar novamente'));
    await browser.flush(10);
    assert.equal(catalogos().length, leituras + 1, 'nova leitura');
    // a navegação continua: migalha de volta e Voltar do navegador
    browser.click(browser.by.tag(browser.find(principal(), (el) => el.className === 'breadcrumb'), 'a')[0]);
    await browser.flush(10);
    assert.equal(browser.window.location.hash, '#/crm/configuracoes');
  }
  browser.window.history.back();
  await browser.flush(10);
  assert.equal(browser.window.location.hash, '#/crm/configuracoes/origens', 'Voltar do navegador funciona');
  await ir('#/crm/configuracoes/servicos/novo');
  assert.equal(browser.window.location.hash, '#/crm/configuracoes/servicos', 'criar por link direto também é barrado no painel inteiro');
  assert.equal(fetchImpl.calls.filter((c) => c.method !== 'GET').length, 0, 'nenhuma gravação em todo o percurso');
  assert.doesNotMatch(browser.root.textContent, /Serviço criado|Nicho criado|Origem criada|salvo com sucesso/);
});
