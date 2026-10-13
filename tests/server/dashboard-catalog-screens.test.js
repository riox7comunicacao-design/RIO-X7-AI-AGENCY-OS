// As TELAS ADMINISTRATIVAS dos catálogos do CRM (CRM 5.0, Fase 2B-2) — o comportamento comum e a tela de SERVIÇOS: lista, estados, busca e filtro, criar e editar no painel lateral (com URL),
// validação, proteção de alterações não salvas, ativar/desativar, reordenar e permissões. DOM de teste e API falsa em memória: nenhum navegador, nenhuma rede, nenhum dado real.
// (Nichos e Origens estão em dashboard-catalog-niches-origins.test.js; o painel inteiro sobre o servidor real, em dashboard-catalog-fullstack.test.js.)

const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../helpers/catalogHarness');
const { servico, apiFalsa, abrir, gaveta, confirmacao, botao, campo, erroDoCampo, linhas, linhaDe, nomes, acao, avisos, texto, hash, clicar, digitar, salvar, emFoco, erroApi } = H;

const TRES = () => [
  servico(1, { nome: 'Gestão de redes', descricao: 'Posts e stories', categoria: 'Marketing', precoReferencia: 1500, tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' }),
  servico(2, { nome: 'Criação de site', tipoCobranca: 'UNICA', precoReferencia: 4800.5 }),
  servico(3, { nome: 'Consultoria', ativo: false }),
];
// Elementos do DOM de teste nunca vão para assert.equal: uma falha tentaria imprimir o documento inteiro (e estoura a memória). A identidade é conferida assim.
const mesmo = (a, b, mensagem) => assert.ok(a === b, mensagem || 'deveria ser o mesmo elemento');
const semLixo = (s) => assert.doesNotMatch(texto(s), /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// carregar, estados e rotas
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATSCR-1] SERVIÇOS carrega pela rota #/crm/configuracoes/servicos: título, descrição objetiva, "Novo Serviço", a lista na ordem do servidor com situação e detalhes reais; abrir só LÊ', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Serviços');
  assert.match(texto(s), /O preço de referência é apenas informativo: ele não altera propostas nem negociações\./);
  assert.ok(botao(s, 'Novo Serviço'));
  assert.ok(botao(s, 'Atualizar'));
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria']);
  assert.match(texto(s), /3 serviços/);
  assert.match(linhaDe(s, 'service:1').textContent, /Ativo/);
  assert.match(linhaDe(s, 'service:1').textContent, /Marketing · Preço de referência: R\$\s1\.500,00 · Cobrança recorrente \(mensal\)/);
  assert.match(linhaDe(s, 'service:1').textContent, /Posts e stories/);
  assert.match(linhaDe(s, 'service:2').textContent, /Preço de referência: R\$\s4\.800,50 · Pagamento único/);
  assert.match(linhaDe(s, 'service:3').textContent, /Inativo/);
  assert.match(linhaDe(s, 'service:3').className, /\bis-inactive\b/);
  assert.deepEqual(api.chamadas, [['listar', 'servicos', { todos: true }]], 'uma leitura da lista COM os desativados; nada além disso');
  assert.equal(api.escritas().length, 0);
  assert.equal(gaveta(s), null, 'nenhum painel aberto');
  assert.equal(botao(s, 'Novo Serviço').getAttribute('data-action'), 'new');
  assert.equal(s.browser.by.tag(s.browser.root, 'ul')[0].getAttribute('aria-label'), 'Serviços');
  semLixo(s);
});

test('[CATSCR-2] ESTADOS: carregando (esqueleto anunciado), vazio (com a ação de criar), erro com "Tentar novamente", estrutura de dados ausente explicada com clareza, e sem permissão do servidor', async () => {
  // carregando
  const lenta = apiFalsa({ servicos: TRES() });
  const pausa = lenta.pausar('listar');
  const s = await abrir({ api: lenta, carregar: false });
  const abertura = s.view.show(s.parseRoute(s.navigation.current()));
  await s.browser.flush(3);
  const esqueleto = s.browser.by.cls(s.browser.root, 'skeleton')[0];
  assert.ok(esqueleto, 'esqueleto enquanto carrega');
  assert.equal(esqueleto.getAttribute('role'), 'status');
  assert.equal(esqueleto.getAttribute('aria-busy'), 'true');
  assert.match(esqueleto.textContent, /Carregando os serviços…/);
  assert.equal(linhas(s).length, 0);
  assert.equal(botao(s, 'Atualizar').disabled, true, 'não se atualiza duas vezes ao mesmo tempo');
  pausa.liberar();
  await abertura;
  await s.browser.flush(6);
  assert.equal(s.browser.by.cls(s.browser.root, 'skeleton').length, 0);
  assert.equal(linhas(s).length, 3);
  assert.equal(botao(s, 'Atualizar').disabled, false);

  // vazio
  const vazio = await abrir({ api: apiFalsa() });
  assert.match(texto(vazio), /Nenhum serviço cadastrado ainda\./);
  assert.match(texto(vazio), /0 serviços/);
  const criar = botao(vazio, 'Novo Serviço', vazio.browser.by.id(vazio.browser.root, 'catalog-empty-servicos'));
  assert.ok(criar, 'o estado vazio oferece criar o primeiro');
  await clicar(vazio, criar);
  assert.ok(gaveta(vazio));
  assert.equal(hash(vazio), '#/crm/configuracoes/servicos/novo');

  // erro: a estrutura de dados dos cadastros ainda não existe (migration não aplicada) -> o servidor responde 503
  const indisponivel = apiFalsa({ servicos: TRES() });
  indisponivel.mem.falhas.listar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE', [], 'x');
  const e = await abrir({ api: indisponivel });
  assert.match(texto(e), /Os cadastros não estão disponíveis agora\. Isso acontece, por exemplo, quando a estrutura de dados dos cadastros ainda não foi preparada neste ambiente\. Nada foi alterado\./);
  assert.equal(linhas(e).length, 0);
  assert.equal(e.browser.find(e.browser.root, (el) => el.getAttribute('role') === 'alert' && /não estão disponíveis/.test(el.textContent)) !== null, true, 'o erro é anunciado');
  assert.doesNotMatch(texto(e), /Serviço criado|salvo com sucesso/);
  await clicar(e, botao(e, 'Tentar novamente'));
  assert.deepEqual(nomes(e), ['Gestão de redes', 'Criação de site', 'Consultoria'], 'tentar de novo carrega');
  assert.doesNotMatch(texto(e), /não estão disponíveis/);

  // outros erros do servidor
  for (const [status, esperado] of [[403, /Sua conta não tem permissão/], [0, /Sem conexão com o servidor/], [500, /Não foi possível concluir agora/]]) {
    const api = apiFalsa({ servicos: TRES() });
    api.mem.falhas.listar = await erroApi(status, 'X');
    const f = await abrir({ api });
    assert.match(texto(f), esperado, `status ${status}`);
    semLixo(f);
  }
});

test('[CATSCR-3] BUSCA e FILTRO: busca pelo nome (sem acento), filtro de situação, contador, estado "nada encontrado" com "Limpar busca e filtros"; nada é recarregado do servidor', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  const busca = s.browser.by.id(s.browser.root, 'catalog-search-servicos');
  const situacao = s.browser.by.id(s.browser.root, 'catalog-status-servicos');
  mesmo(s.browser.by.label(s.browser.root, 'Buscar serviço'), busca);
  mesmo(s.browser.by.label(s.browser.root, 'Situação'), situacao);
  assert.deepEqual([...situacao.childNodes].map((o) => o.textContent), ['Somente ativos', 'Somente inativos', 'Todos']);
  assert.equal(situacao.value, 'TODOS', 'o administrador vê tudo ao abrir');

  digitar(s, busca, 'GESTAO');
  assert.deepEqual(nomes(s), ['Gestão de redes']);
  assert.match(texto(s), /3 serviços · 1 no filtro/);
  digitar(s, busca, 'site');
  assert.deepEqual(nomes(s), ['Criação de site']);
  digitar(s, busca, '');
  s.browser.choose(situacao, 'ATIVOS');
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site']);
  s.browser.choose(situacao, 'INATIVOS');
  assert.deepEqual(nomes(s), ['Consultoria']);
  assert.match(texto(s), /3 serviços · 1 no filtro/);
  digitar(s, busca, 'inexistente');
  assert.equal(linhas(s).length, 0);
  assert.match(texto(s), /Nenhum serviço encontrado/);
  await clicar(s, botao(s, 'Limpar busca e filtros'));
  assert.equal(busca.value, '');
  assert.equal(situacao.value, 'TODOS');
  assert.equal(linhas(s).length, 3);
  mesmo(emFoco(s), busca, 'o foco volta à busca');
  assert.equal(api.quantas('listar'), 1, 'buscar e filtrar não vão ao servidor');
});

test('[CATSCR-4] ATUALIZAÇÃO sem F5: criar mostra o item na hora (sem recarregar a página), avisa o resto do painel pelo barramento e "Atualizar" traz o que mudou no servidor', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Tráfego pago');
  await salvar(s);
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria', 'Tráfego pago']);
  assert.match(texto(s), /4 serviços/);
  assert.equal(api.quantas('listar'), 1, 'a lista não foi recarregada');
  assert.deepEqual(s.eventos, [['servicos', 'create', 'service:novo-3']]);
  // mudança feita por outra pessoa: "Atualizar" traz
  api.mem.servicos.push(servico(9, { nome: 'Vídeo institucional', ordem: 9 }));
  await clicar(s, botao(s, 'Atualizar'));
  assert.equal(api.quantas('listar'), 2);
  assert.ok(nomes(s).includes('Vídeo institucional'));
  assert.equal(botao(s, 'Atualizar').disabled, false);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// criar
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATSCR-5] CRIAR: o painel lateral abre sobre a lista (endereço próprio), com cabeçalho e rodapé fixos; os campos são os REAIS do contrato; o sucesso só aparece DEPOIS da resposta da API; sem envio duplicado', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  await clicar(s, botao(s, 'Novo Serviço'));
  assert.equal(hash(s), '#/crm/configuracoes/servicos/novo');
  const g = gaveta(s);
  assert.ok(g);
  assert.equal(g.getAttribute('aria-modal'), 'true');
  assert.equal(s.browser.find(g, (el) => el.className === 'overlay-title').textContent, 'Novo serviço');
  assert.equal(s.browser.find(g, (el) => el.localName === 'header' && el.className === 'overlay-head') !== null, true, 'cabeçalho fixo');
  assert.equal(s.browser.find(g, (el) => el.className === 'overlay-body') !== null, true, 'corpo rolável');
  const rodape = s.browser.find(g, (el) => el.localName === 'footer' && el.className === 'overlay-footer');
  assert.ok(rodape && rodape.hidden === false, 'rodapé fixo');
  assert.deepEqual(s.browser.by.tag(rodape, 'button').map((b) => b.textContent), ['Cancelar', 'Salvar']);
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria'], 'a lista continua atrás do painel');
  mesmo(emFoco(s), campo(s, 'nome'), 'o foco vai ao primeiro campo');

  // os campos reais (e só eles)
  for (const nome of ['nome', 'descricao', 'categoria', 'precoReferencia', 'tipoCobranca', 'recorrencia']) assert.ok(campo(s, nome), nome);
  mesmo(s.browser.by.label(g, 'Nome do serviço'), campo(s, 'nome'));
  assert.equal(s.browser.by.label(g, 'Preço de referência (R$)'), campo(s, 'precoReferencia'));
  assert.equal(campo(s, 'nome').getAttribute('aria-required'), 'true');
  assert.equal(campo(s, 'nome').getAttribute('maxlength'), '80');
  assert.equal(campo(s, 'descricao').getAttribute('maxlength'), '500');
  assert.equal(campo(s, 'categoria').getAttribute('maxlength'), '60');
  assert.equal(campo(s, 'precoReferencia').getAttribute('inputmode'), 'decimal');
  assert.deepEqual([...campo(s, 'tipoCobranca').childNodes].map((o) => [o.value, o.textContent]), [['', 'Não informado'], ['UNICA', 'Pagamento único'], ['RECORRENTE', 'Cobrança recorrente']]);
  assert.equal(campo(s, 'recorrencia').parentNode.hidden, true, 'a recorrência só aparece para a cobrança recorrente');
  assert.match(g.textContent, /apenas informativo: não altera propostas nem negociações/);
  assert.equal(s.browser.findAll(g, (el) => el.hasAttribute('style')).length, 0, 'nenhum estilo inline');
  // nada de campos que o contrato não tem
  assert.equal(s.browser.findAll(g, (el) => ['input', 'select', 'textarea'].includes(el.localName)).length, 6);

  digitar(s, campo(s, 'nome'), '  Gestão de   tráfego  ');
  digitar(s, campo(s, 'descricao'), 'Campanhas mensais');
  digitar(s, campo(s, 'categoria'), 'Marketing');
  digitar(s, campo(s, 'precoReferencia'), '2.500,00');
  s.browser.choose(campo(s, 'tipoCobranca'), 'RECORRENTE');
  assert.equal(campo(s, 'recorrencia').parentNode.hidden, false);
  s.browser.choose(campo(s, 'recorrencia'), 'MENSAL');

  const pausa = api.pausar('criar');
  s.browser.click(botao(s, 'Salvar', g));
  s.browser.click(botao(s, 'Salvando…', g)); // um segundo clique (botão desabilitado) não envia de novo
  s.browser.press('Enter', { target: campo(s, 'nome') }); // nem Enter
  await s.browser.flush(6);
  assert.equal(api.quantas('criar'), 1, 'um único envio');
  assert.equal(botao(s, 'Salvando…', g).disabled, true);
  assert.equal(botao(s, 'Cancelar', g).disabled, true);
  assert.equal(g.getAttribute('aria-busy'), 'true');
  assert.deepEqual(avisos(s), [], 'nenhum aviso de sucesso antes da resposta');
  assert.doesNotMatch(texto(s), /Serviço criado/);
  assert.deepEqual(nomes(s).length, 3, 'o item novo ainda NÃO está na lista');
  s.browser.press('Escape'); // salvando: ESC não fecha o painel
  assert.ok(gaveta(s));
  assert.equal(hash(s), '#/crm/configuracoes/servicos/novo');

  pausa.liberar();
  await s.browser.flush(8);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar'), [['criar', 'servicos', { nome: 'Gestão de tráfego', descricao: 'Campanhas mensais', categoria: 'Marketing', precoReferencia: 2500, tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' }]]);
  assert.equal(gaveta(s), null, 'o painel fecha depois da confirmação');
  assert.equal(hash(s), '#/crm/configuracoes/servicos', 'e o endereço volta à lista');
  assert.deepEqual(avisos(s), ['Serviço criado.']);
  assert.ok(nomes(s).includes('Gestão de tráfego'));
  assert.match(linhaDe(s, 'service:novo-3').textContent, /Preço de referência: R\$\s2\.500,00 · Cobrança recorrente \(mensal\)/);
  mesmo(emFoco(s), botao(s, 'Novo Serviço'), 'o foco volta ao botão que abriu o painel');
  semLixo(s);
});

test('[CATSCR-6] VALIDAÇÃO dos campos: nome vazio, preço inválido e preço com mais de 2 casas são recusados perto do campo ANTES de qualquer requisição; o foco vai ao primeiro erro; corrigir e salvar funciona', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  await clicar(s, botao(s, 'Novo Serviço'));
  await salvar(s);
  assert.equal(erroDoCampo(s, 'nome').textContent, 'Informe o nome.');
  assert.equal(erroDoCampo(s, 'nome').hidden, false);
  assert.equal(erroDoCampo(s, 'nome').getAttribute('role'), 'alert');
  assert.equal(campo(s, 'nome').getAttribute('aria-invalid'), 'true');
  assert.match(campo(s, 'nome').getAttribute('aria-describedby'), /catalog-field-nome-error/);
  mesmo(emFoco(s), campo(s, 'nome'));
  assert.equal(api.escritas().length, 0, 'nenhuma requisição');

  digitar(s, campo(s, 'nome'), 'Novo');
  digitar(s, campo(s, 'precoReferencia'), '12,345');
  await salvar(s);
  assert.equal(erroDoCampo(s, 'nome').hidden, true, 'o erro antigo some');
  assert.equal(erroDoCampo(s, 'precoReferencia').textContent, 'Use no máximo duas casas decimais (os centavos).');
  mesmo(emFoco(s), campo(s, 'precoReferencia'));
  digitar(s, campo(s, 'precoReferencia'), 'dez reais');
  await salvar(s);
  assert.equal(erroDoCampo(s, 'precoReferencia').textContent, 'Informe o valor em reais, como 1.500,00.');
  digitar(s, campo(s, 'precoReferencia'), '-5');
  await salvar(s);
  assert.equal(erroDoCampo(s, 'precoReferencia').textContent, 'Informe um valor entre R$ 0,00 e R$ 1.000.000.000,00.');
  digitar(s, campo(s, 'precoReferencia'), '1.000.000.001');
  await salvar(s);
  assert.equal(erroDoCampo(s, 'precoReferencia').textContent, 'Informe um valor entre R$ 0,00 e R$ 1.000.000.000,00.');
  assert.equal(api.escritas().length, 0);
  assert.match(gaveta(s).textContent, /Confira os campos destacados e tente novamente\./);

  digitar(s, campo(s, 'precoReferencia'), '99,9');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar')[0].slice(1), ['servicos', { nome: 'Novo', precoReferencia: 99.9 }]);
  assert.equal(gaveta(s), null);
});

test('[CATSCR-7] ERROS DA API ao salvar aparecem junto do campo certo e NADA digitado se perde: nome duplicado (mesmo desativado), recorrência obrigatória, API fora do ar e rede caída', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Consultoria');
  digitar(s, campo(s, 'descricao'), 'Texto que não pode sumir');
  digitar(s, campo(s, 'precoReferencia'), '300');

  api.mem.falhas.criar = await erroApi(409, 'CRM_CATALOG_DUPLICATE_NAME', [], 'Já existe um item com este nome (mesmo desativado).');
  await salvar(s);
  assert.equal(erroDoCampo(s, 'nome').textContent, 'Já existe um item com este nome, mesmo desativado. Use outro nome ou reative o item existente.');
  mesmo(emFoco(s), campo(s, 'nome'));
  assert.ok(gaveta(s), 'o painel continua aberto');
  assert.equal(campo(s, 'descricao').value, 'Texto que não pode sumir');
  assert.equal(campo(s, 'precoReferencia').value, '300');
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, false, 'dá para tentar de novo');
  assert.deepEqual(avisos(s), []);

  s.browser.choose(campo(s, 'tipoCobranca'), 'RECORRENTE');
  digitar(s, campo(s, 'nome'), 'Mentoria');
  api.mem.falhas.criar = await erroApi(400, 'CRM_CATALOG_INVALID_INPUT', [{ path: 'recorrencia', code: 'RECORRENCIA_OBRIGATORIA' }, { path: 'categoria', code: 'MUITO_LONGO' }]);
  await salvar(s);
  assert.equal(erroDoCampo(s, 'recorrencia').textContent, 'Escolha a recorrência: a cobrança é recorrente.');
  assert.equal(erroDoCampo(s, 'categoria').textContent, 'A categoria pode ter no máximo 60 caracteres.');
  assert.equal(erroDoCampo(s, 'nome').hidden, true);
  mesmo(emFoco(s), campo(s, 'categoria'), 'o foco vai ao primeiro campo com erro na ordem da tela');

  // falha de REDE: transitória — não é "estrutura ausente": o Salvar continua habilitado e dá para tentar de novo
  api.mem.falhas.criar = await erroApi(0, 'NETWORK');
  await salvar(s);
  assert.match(gaveta(s).textContent, /Sem conexão com o servidor/);
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, false, 'uma falha de rede não bloqueia as gravações');
  assert.equal(s.view.screen('servicos').isUnavailable(), false);
  api.mem.falhas.criar = await erroApi(403, 'FORBIDDEN');
  await salvar(s);
  assert.match(gaveta(s).textContent, /Sua conta não tem permissão para administrar estes cadastros\./);

  // 503: o servidor CONFIRMA que os cadastros estão indisponíveis — o rascunho fica, o Salvar é pausado e nada mais é enviado
  api.mem.falhas.criar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
  await salvar(s);
  assert.match(gaveta(s).textContent, /ainda não foi preparada neste ambiente\. Nada foi alterado\./);
  assert.match(gaveta(s).textContent, /O que você digitou foi mantido nesta tela\./);
  assert.doesNotMatch(texto(s), /Serviço criado/);
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, true);
  assert.equal(api.quantas('criar'), 5, '409, 400, rede, 403 e o 503: cinco tentativas até aqui');
  await salvar(s);
  s.browser.press('Enter', { target: campo(s, 'nome') });
  await s.browser.flush(4);
  assert.equal(api.quantas('criar'), 5, 'com a indisponibilidade confirmada nada é enviado, nem por Enter');

  assert.equal(campo(s, 'descricao').value, 'Texto que não pode sumir', 'o rascunho continua inteiro');
  assert.equal(campo(s, 'nome').value, 'Mentoria');
  assert.equal(api.mem.servicos.length, 3, 'nada foi criado');
  assert.deepEqual(avisos(s), []);

  // "Verificar novamente" traz o servidor de volta: o Salvar volta e a sexta tentativa funciona
  await clicar(s, botao(s, 'Verificar novamente', gaveta(s)));
  assert.equal(botao(s, 'Salvar', gaveta(s)).disabled, false);
  assert.equal(s.browser.by.cls(gaveta(s), 'catalog-unavailable').length, 0, 'o aviso some');
  await salvar(s);
  assert.equal(gaveta(s), null);
  assert.deepEqual(avisos(s), ['Serviço criado.']);
  assert.equal(api.mem.servicos.length, 4);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// editar
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATSCR-8] EDITAR: o painel abre pelo nome (endereço do item), preenche os campos com o preço no formato brasileiro e só envia o que MUDOU; sem mudança nada é enviado', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  await clicar(s, acao(s, 'service:1', 'edit'));
  assert.equal(hash(s), '#/crm/configuracoes/servicos/service%3A1');
  const g = gaveta(s);
  assert.equal(s.browser.find(g, (el) => el.className === 'overlay-title').textContent, 'Gestão de redes');
  assert.match(g.textContent, /Editar serviço/);
  assert.equal(campo(s, 'nome').value, 'Gestão de redes');
  assert.equal(campo(s, 'descricao').value, 'Posts e stories');
  assert.equal(campo(s, 'categoria').value, 'Marketing');
  assert.equal(campo(s, 'precoReferencia').value, '1.500,00');
  assert.equal(campo(s, 'tipoCobranca').value, 'RECORRENTE');
  assert.equal(campo(s, 'recorrencia').value, 'MENSAL');
  assert.equal(campo(s, 'recorrencia').parentNode.hidden, false);
  assert.match(g.textContent, /Criado em .* por Breno Bento\. Última alteração em .* por Breno Bento\./);

  // sem alterar nada
  await salvar(s);
  assert.match(g.textContent, /Nenhuma alteração foi feita\./);
  assert.equal(api.escritas().length, 0, 'nenhuma requisição');
  assert.ok(gaveta(s));

  // só o preço
  digitar(s, campo(s, 'precoReferencia'), '1.800,50');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar'), [['atualizar', 'servicos', 'service:1', { precoReferencia: 1800.5 }]]);
  assert.equal(gaveta(s), null);
  assert.equal(hash(s), '#/crm/configuracoes/servicos');
  assert.deepEqual(avisos(s), ['Serviço atualizado.']);
  assert.match(linhaDe(s, 'service:1').textContent, /R\$\s1\.800,50/);
  mesmo(emFoco(s), acao(s, 'service:1', 'edit'), 'o foco volta ao nome do item editado');
});

test('[CATSCR-9] EDITAR limpando campos envia null só deles; trocar para pagamento único leva a recorrência junto; o nome em uso pelo CRM fica travado com a explicação (e o servidor continua a autoridade)', async () => {
  const api = apiFalsa({ servicos: TRES(), emUso: { 'service:1': 4, 'service:2': 0 } });
  const s = await abrir({ api });
  await clicar(s, acao(s, 'service:2', 'edit'));
  assert.ok(!campo(s, 'nome').readOnly, 'sem uso no CRM o nome é editável');
  assert.doesNotMatch(gaveta(s).textContent, /é usado em/);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'obter'), [['obter', 'servicos', 'service:2']]);
  digitar(s, campo(s, 'precoReferencia'), '');
  s.browser.choose(campo(s, 'tipoCobranca'), '');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[0].slice(2), ['service:2', { precoReferencia: null, tipoCobranca: null, recorrencia: null }]);

  await clicar(s, acao(s, 'service:1', 'edit'));
  s.browser.choose(campo(s, 'tipoCobranca'), 'UNICA');
  assert.equal(campo(s, 'recorrencia').parentNode.hidden, true);
  assert.equal(campo(s, 'recorrencia').value, '', 'a recorrência é limpa junto');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[1].slice(2), ['service:1', { tipoCobranca: 'UNICA', recorrencia: null }]);

  // em uso: o nome trava; o resto continua editável. A contagem demora, e a pessoa já digitou no nome antes de ela chegar.
  const pausaUso = api.pausar('obter');
  s.browser.click(acao(s, 'service:1', 'edit'));
  await s.browser.flush(6);
  assert.ok(!campo(s, 'nome').readOnly, 'enquanto a contagem não chega o nome é editável (o servidor ainda decide)');
  digitar(s, campo(s, 'nome'), 'Nome que o servidor recusaria');
  pausaUso.liberar();
  await s.browser.flush(6);
  assert.match(gaveta(s).textContent, /Este serviço é usado em 4 registros do CRM\. Por isso o nome não pode ser alterado nesta fase; as demais informações podem ser editadas\./);
  assert.equal(campo(s, 'nome').readOnly, true);
  assert.equal(campo(s, 'nome').getAttribute('readonly'), 'readonly');
  assert.equal(campo(s, 'nome').value, 'Gestão de redes', 'o texto digitado antes da resposta é devolvido ao nome real');
  digitar(s, campo(s, 'descricao'), 'Nova descrição');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[2].slice(2), ['service:1', { descricao: 'Nova descrição' }], 'o nome não vai no corpo');

  // e se mesmo assim o servidor recusar a troca (informação defasada), a recusa aparece no campo
  const outra = apiFalsa({ servicos: TRES() });
  const t = await abrir({ api: outra });
  await clicar(t, acao(t, 'service:2', 'edit'));
  digitar(t, campo(t, 'nome'), 'Site novo');
  outra.mem.falhas.atualizar = await erroApi(409, 'CRM_CATALOG_NAME_IN_USE');
  await salvar(t);
  assert.match(erroDoCampo(t, 'nome').textContent, /já é usado em registros do CRM, então o nome não pode ser alterado nesta fase/);
  assert.equal(campo(t, 'nome').value, 'Site novo');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// desativar e reativar
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATSCR-10] DESATIVAR pede confirmação (nada é apagado); cancelar não faz nada; confirmar só muda a lista DEPOIS da API; REATIVAR é direto; falhas aparecem sem falsa confirmação', async () => {
  const api = apiFalsa({ servicos: TRES() });
  const s = await abrir({ api });
  assert.equal(acao(s, 'service:1', 'toggle').textContent, 'Desativar');
  assert.equal(acao(s, 'service:3', 'toggle').textContent, 'Reativar');
  assert.equal(acao(s, 'service:1', 'toggle').getAttribute('aria-label'), 'Desativar serviço Gestão de redes');

  await clicar(s, acao(s, 'service:1', 'toggle'));
  const c = confirmacao(s);
  assert.ok(c);
  assert.equal(s.browser.find(c, (el) => el.className === 'overlay-title').textContent, 'Desativar serviço?');
  assert.match(c.textContent, /Gestão de redes/);
  assert.match(c.textContent, /Nada é apagado: o que já usa este serviço continua como está, e você pode reativá-lo quando quiser\./);
  assert.deepEqual(s.browser.by.tag(c, 'button').map((b) => b.textContent).filter((t) => t !== '×'), ['Cancelar', 'Desativar'], 'cancelar vem primeiro e é o que nasce em foco');
  assert.equal(emFoco(s).textContent, 'Cancelar');
  await clicar(s, botao(s, 'Cancelar', c));
  assert.equal(confirmacao(s), null);
  assert.equal(api.escritas().length, 0);
  assert.match(linhaDe(s, 'service:1').textContent, /Ativo/);

  // confirmar, com a API demorando: a lista só muda depois
  const pausa = api.pausar('desativar');
  await clicar(s, acao(s, 'service:1', 'toggle'));
  s.browser.click(botao(s, 'Desativar', confirmacao(s)));
  await s.browser.flush(6);
  assert.match(botao(s, 'Desativando…', confirmacao(s)).textContent, /Desativando…/);
  assert.equal(botao(s, 'Desativando…', confirmacao(s)).disabled, true, 'sem segundo envio');
  assert.match(linhaDe(s, 'service:1').textContent, /Ativo/, 'ainda ativo: a API não respondeu');
  assert.deepEqual(avisos(s), []);
  pausa.liberar();
  await s.browser.flush(8);
  assert.equal(confirmacao(s), null);
  assert.match(linhaDe(s, 'service:1').textContent, /Inativo/);
  assert.match(linhaDe(s, 'service:1').className, /\bis-inactive\b/);
  assert.equal(acao(s, 'service:1', 'toggle').textContent, 'Reativar');
  assert.deepEqual(avisos(s), ['Serviço desativado.']);
  mesmo(emFoco(s), acao(s, 'service:1', 'toggle'), 'o foco volta ao botão da linha');
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'desativar'), [['desativar', 'servicos', 'service:1']]);

  // reativar: direto
  await clicar(s, acao(s, 'service:3', 'toggle'));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'ativar'), [['ativar', 'servicos', 'service:3']]);
  assert.match(linhaDe(s, 'service:3').textContent, /Ativo/);
  assert.equal(confirmacao(s), null, 'reativar não pede confirmação');
  assert.ok(avisos(s).includes('Serviço reativado.'));
  assert.deepEqual(s.eventos.map((e) => e[1]), ['deactivate', 'activate']);

  // falha ao desativar: o diálogo continua aberto com o erro, a lista não muda e nada é "confirmado"
  api.mem.falhas.desativar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
  await clicar(s, acao(s, 'service:2', 'toggle'));
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.ok(confirmacao(s), 'a confirmação continua aberta');
  assert.match(confirmacao(s).textContent, /ainda não foi preparada neste ambiente/);
  assert.match(linhaDe(s, 'service:2').textContent, /Ativo/);
  assert.ok(!avisos(s).includes('Serviço desativado.'), 'a falha não gera aviso de sucesso');
  assert.equal(api.quantas('desativar'), 2, 'foram duas tentativas: a primeira confirmada, a segunda recusada');
  assert.match(linhaDe(s, 'service:2').textContent, /Ativo/);
  await clicar(s, botao(s, 'Cancelar', confirmacao(s)));
  // o 503 CONFIRMOU a indisponibilidade: toda gravação fica pausada (nada é enviado) até uma nova verificação dar certo
  assert.equal(s.view.screen('servicos').isUnavailable(), true);
  assert.equal(botao(s, 'Novo Serviço').disabled, true);
  for (const id of ['service:1', 'service:2', 'service:3']) for (const nomeDaAcao of ['up', 'down', 'toggle']) assert.equal(acao(s, id, nomeDaAcao).disabled, true, `${id} ${nomeDaAcao}`);
  assert.equal(acao(s, 'service:2', 'edit').disabled, false, 'a navegação (abrir o item para ler) continua');
  const escritasAteAqui = api.escritas().length;
  s.browser.click(acao(s, 'service:2', 'toggle'));
  await s.browser.flush(4);
  assert.equal(api.escritas().length, escritasAteAqui, 'um botão pausado não envia nada');
  await clicar(s, botao(s, 'Tentar novamente'));
  assert.equal(s.view.screen('servicos').isUnavailable(), false);
  assert.equal(acao(s, 'service:2', 'toggle').disabled, false, 'depois de uma verificação bem-sucedida as ações voltam');

  // falha ao reativar: aviso de erro, nada muda
  api.mem.falhas.ativar = await erroApi(0, 'NETWORK');
  await clicar(s, acao(s, 'service:1', 'toggle'));
  assert.match(linhaDe(s, 'service:1').textContent, /Inativo/);
  assert.match(texto(s), /Sem conexão com o servidor/);
  assert.ok(avisos(s).some((a) => /Sem conexão/.test(a)));
  // item que sumiu do servidor: o 404 recarrega a lista
  api.mem.servicos = api.mem.servicos.filter((i) => i.id !== 'service:1');
  await clicar(s, acao(s, 'service:1', 'toggle'));
  assert.match(texto(s), /Este item não existe mais\. A lista foi atualizada\./);
  assert.ok(!nomes(s).includes('Gestão de redes'), 'a lista foi recarregada');
  semLixo(s);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// reordenar
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATSCR-11] REORDENAR: subir e descer (com rótulo acessível); as pontas ficam desabilitadas; a nova ordem aparece já, mas só vale depois da API; em falha a ordem ANTERIOR volta', async () => {
  const api = apiFalsa({ servicos: [servico(1), servico(2), servico(3), servico(4)] });
  const s = await abrir({ api });
  assert.equal(acao(s, 'service:1', 'up').disabled, true, 'o primeiro não sobe');
  assert.equal(acao(s, 'service:4', 'down').disabled, true, 'o último não desce');
  assert.equal(acao(s, 'service:2', 'up').disabled, false);
  assert.equal(acao(s, 'service:2', 'up').getAttribute('aria-label'), 'Subir serviço Serviço 2 na ordem');
  assert.equal(acao(s, 'service:2', 'down').getAttribute('aria-label'), 'Descer serviço Serviço 2 na ordem');

  // descer o primeiro, com a API demorando
  const pausa = api.pausar('reordenar');
  s.browser.click(acao(s, 'service:1', 'down'));
  await s.browser.flush(5);
  assert.deepEqual(nomes(s), ['Serviço 2', 'Serviço 1', 'Serviço 3', 'Serviço 4'], 'a nova ordem já aparece');
  assert.deepEqual(avisos(s), [], 'mas ainda não está salva: nenhum aviso de sucesso');
  assert.ok([...s.browser.by.tag(s.browser.root, 'button')].filter((b) => ['up', 'down', 'toggle', 'edit'].includes(b.getAttribute('data-action'))).every((b) => b.disabled), 'durante o envio nada mais pode ser acionado');
  pausa.liberar();
  await s.browser.flush(8);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'reordenar'), [['reordenar', 'servicos', ['service:2', 'service:1', 'service:3', 'service:4']]], 'a lista COMPLETA, na nova ordem');
  assert.deepEqual(nomes(s), ['Serviço 2', 'Serviço 1', 'Serviço 3', 'Serviço 4']);
  assert.deepEqual(avisos(s), ['Ordem dos serviços atualizada.']);
  mesmo(emFoco(s), acao(s, 'service:1', 'down'), 'o foco acompanha o item movido');
  assert.deepEqual(s.eventos.at(-1), ['servicos', 'reorder', null]);

  // subir
  await clicar(s, acao(s, 'service:3', 'up'));
  assert.deepEqual(nomes(s), ['Serviço 2', 'Serviço 3', 'Serviço 1', 'Serviço 4']);
  mesmo(emFoco(s), acao(s, 'service:3', 'up'));

  // falha: a ordem anterior volta
  api.mem.falhas.reordenar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
  const antes = nomes(s);
  await clicar(s, acao(s, 'service:4', 'up'));
  assert.deepEqual(nomes(s), antes, 'a ordem anterior foi restaurada');
  assert.match(texto(s), /ainda não foi preparada neste ambiente\. Nada foi alterado\./);
  assert.doesNotMatch(texto(s), /Nada foi alterado\. A ordem não foi alterada/, 'a mensagem não se repete');
  assert.equal(acao(s, 'service:4', 'up').disabled, true, 'o 503 confirmou a indisponibilidade: a reordenação fica pausada');
  const reordenacoes = api.quantas('reordenar');
  s.browser.click(acao(s, 'service:4', 'up'));
  await s.browser.flush(4);
  assert.equal(api.quantas('reordenar'), reordenacoes, 'nada é enviado enquanto a indisponibilidade persistir');
  await clicar(s, botao(s, 'Tentar novamente'));
  assert.equal(acao(s, 'service:4', 'up').disabled, false, 'depois de uma verificação bem-sucedida dá para tentar de novo');
  // lista defasada (o servidor recusa a lista de ids): avisa e recarrega
  api.mem.falhas.reordenar = await erroApi(400, 'CRM_CATALOG_INVALID_INPUT', [{ path: 'orderedIds', code: 'LISTA_INVALIDA' }]);
  api.mem.servicos.push(servico(5, { ordem: 4 }));
  await clicar(s, acao(s, 'service:4', 'up'));
  assert.match(texto(s), /A lista mudou desde a última atualização/);
  assert.ok(nomes(s).includes('Serviço 5'), 'a lista foi recarregada');
});

test('[CATSCR-12] REORDENAR fica DESABILITADO com busca ou filtro ativos (a ordem vale para todos os itens), com a explicação, e volta ao limpar', async () => {
  const api = apiFalsa({ servicos: [servico(1), servico(2), servico(3)] });
  const s = await abrir({ api });
  const busca = s.browser.by.id(s.browser.root, 'catalog-search-servicos');
  const situacao = s.browser.by.id(s.browser.root, 'catalog-status-servicos');
  assert.equal(acao(s, 'service:2', 'up').disabled, false);
  assert.doesNotMatch(texto(s), /Para reordenar, limpe a busca/);

  digitar(s, busca, 'Serviço');
  for (const id of ['service:1', 'service:2', 'service:3']) {
    assert.equal(acao(s, id, 'up').disabled, true, id);
    assert.equal(acao(s, id, 'down').disabled, true, id);
  }
  assert.match(texto(s), /Para reordenar, limpe a busca e mostre todos os itens\./);
  s.browser.click(acao(s, 'service:2', 'up')); // desabilitado: o clique não faz nada
  await s.browser.flush(4);
  digitar(s, busca, '');
  s.browser.choose(situacao, 'ATIVOS');
  assert.equal(acao(s, 'service:2', 'up').disabled, true);
  assert.match(texto(s), /Para reordenar/);
  s.browser.choose(situacao, 'TODOS');
  assert.equal(acao(s, 'service:2', 'up').disabled, false);
  assert.doesNotMatch(texto(s), /Para reordenar/);
  assert.equal(api.quantas('reordenar'), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// permissões
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATSCR-13] PERMISSÕES: sem MANAGE:CRM_CATALOGS a tela não mostra nenhuma ação nem chama a API; com ela (ADMIN), tudo aparece', async () => {
  const vendedor = apiFalsa({ servicos: TRES() });
  const v = await abrir({ api: vendedor, permissions: H.VENDEDOR });
  assert.match(texto(v), /Esta conta não possui acesso a esta área\./);
  assert.equal(botao(v, 'Novo Serviço'), null);
  assert.equal(botao(v, 'Atualizar'), null);
  assert.equal(linhas(v).length, 0);
  assert.deepEqual(vendedor.chamadas, [], 'nenhuma chamada à API');
  assert.equal(v.browser.by.tag(v.browser.root, 'button').length, 0, 'nenhum botão');
  // o link direto de um painel também não abre nada
  const direto = await abrir({ api: vendedor, permissions: H.VENDEDOR, hash: '#/crm/configuracoes/servicos/novo' });
  assert.equal(gaveta(direto), null);
  assert.deepEqual(vendedor.chamadas, []);
  // permissões ausentes ou estranhas = sem acesso
  for (const permissions of [null, {}, { canManageCrmCatalogs: 'true' }, { canManageCrmCatalogs: 1 }, { canManageCrmCatalogs: false, canManageFunnels: true }, { canReadCrm: true }]) {
    const api = apiFalsa({ servicos: TRES() });
    const t = await abrir({ api, permissions });
    assert.equal(linhas(t).length, 0, JSON.stringify(permissions));
    assert.deepEqual(api.chamadas, [], JSON.stringify(permissions));
    assert.match(texto(t), /Esta conta não possui acesso a esta área\./);
  }
  const admin = await abrir({ api: apiFalsa({ servicos: TRES() }), permissions: H.ADMIN });
  for (const rotulo of ['Novo Serviço', 'Atualizar']) assert.ok(botao(admin, rotulo), rotulo);
  assert.ok(acao(admin, 'service:1', 'edit') && acao(admin, 'service:1', 'toggle') && acao(admin, 'service:1', 'up') && acao(admin, 'service:1', 'down'));
});
