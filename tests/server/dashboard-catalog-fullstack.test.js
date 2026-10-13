// As telas dos catálogos do CRM falando com o SERVIDOR REAL (CRM 5.0, Fase 2B-2): o painel (dashboard/main.mjs e as telas), sobre o DOM de teste, faz as requisições HTTP que faria no navegador
// e cada uma cai no app REAL (src/server/app.js): autenticação pelo fluxo real, Catalog Service real, domínio real e armazenamento REAL em modo "arquivo" — num diretório TEMPORÁRIO PRÓPRIO do
// teste. Nada toca data/ nem o Supabase: o ambiente de teste nem tem credenciais, e o guarda hermético bloqueia qualquer acesso externo.
//
// É o teste que impede o Dashboard e a API de se afastarem: se o servidor mudar um contrato, um campo, um código ou uma regra (recorrência obrigatória, nome único mesmo desativado, nome em uso
// pelo CRM, ordem), a interface falha aqui. Para "a estrutura de dados ainda não foi preparada" usa-se o adaptador REAL do Postgres/Supabase com um `fetch` falso que responde como o PostgREST
// responde quando a tabela não existe (a migration NÃO foi aplicada) — nenhuma rede.
// O que NÃO é real: o navegador (um DOM de teste), o SDK do Supabase do navegador (um falso) e a rede (sem socket). Usuários, e-mails e nomes são fictícios (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const crm = require('../../src/crm');
const { createCatalogService } = require('../../src/services/catalogService');
const { createSupabaseCatalogRepository } = require('../../src/crm-adapters/crmSupabaseCatalogRepository');
const { authorizeCatalogOperation } = require('../../src/auth');
const { createBrowser } = require('../helpers/fakeDom');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const REPO_DATA = path.join(__dirname, '..', '..', 'data');
const CLIENTE_DO_CRM = Object.freeze({ empresa: 'Cliente Teste', site: 'cliente.example.test', telefone: '24 90000-0003', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', origem: 'Indicação', servicoPotencial: 'Criação de site' });

async function subir(t, { usuario = BRENO, hash = '', sementes = [], ambiente = {} } = {}) {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, crmCatalogs: true, ...ambiente });
  const repositorio = createJsonFileCrmRepository(env.crmFilePath);
  for (const campos of sementes) await crm.createRecord(repositorio, campos, { actor: 'HUMAN', reviewedBy: { userId: 'user-semente', name: 'Semente', role: 'ADMIN' }, motivo: 'semente do teste' });
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, bridgeFetch } = await loadFixtures();
  const browser = createBrowser({ hash });
  const bridge = bridgeFetch(env.app);
  const fetchImpl = async (caminho, init) => (caminho === '/config.json' ? new Response(JSON.stringify(CONFIG), { status: 200 }) : bridge(caminho, init));
  fetchImpl.calls = bridge.calls;
  fetchImpl.responses = bridge.responses;
  const token = env.tokenFor(usuario.userId);
  const sdk = createFakeSdk({ session: { access_token: token, refresh_token: 'refresh-de-teste-nao-real', user: { id: usuario.authUserId } } });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation: browserNavigation(browser.window) });
  await browser.flush(10);
  return { env, browser, fetchImpl, token, win: browser.window };
}

// --- o que a pessoa vê e faz ---
const principal = (s) => s.browser.by.id(s.browser.root, 'main');
const texto = (s) => principal(s).textContent.replace(/\s+/g, ' ');
const gaveta = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.browser.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className));
const botao = (s, rotulo, escopo) => s.browser.by.button(escopo || s.browser.root, rotulo);
const campo = (s, nome) => s.browser.by.id(s.browser.root, `catalog-field-${nome}`);
const erroDe = (s, nome) => s.browser.by.id(s.browser.root, `catalog-field-${nome}-error`);
const acao = (s, id, nome) => s.browser.find(s.browser.root, (el) => el.localName === 'button' && el.getAttribute('data-item') === id && el.getAttribute('data-action') === nome);
const nomes = (s) => s.browser.by.cls(principal(s), 'catalog-row').map((li) => s.browser.find(li, (el) => el.localName === 'button' && el.getAttribute('data-action') === 'edit').textContent);
const linhas = (s) => s.browser.by.cls(principal(s), 'catalog-row');
const idDe = (s, nome) => linhas(s).map((li) => [li.getAttribute('data-id'), s.browser.find(li, (el) => el.getAttribute('data-action') === 'edit').textContent]).find(([, n]) => n === nome)[0];
const ir = async (s, hash) => {
  s.win.location.hash = hash;
  await s.browser.flush(12);
};
const clicar = async (s, el) => {
  s.browser.click(el);
  await s.browser.flush(12);
};
const digitar = (s, el, valor) => s.browser.type(el, valor);
const escolher = (s, el, valor) => s.browser.choose(el, valor);
const salvar = (s) => clicar(s, botao(s, 'Salvar', gaveta(s)));
// O arquivo é { version, servicos: { <id>: item }, nichos: {...}, origens: {...} }: aqui cada catálogo vira uma lista na ordem de exibição.
const arquivo = (s) => {
  const bruto = JSON.parse(fs.readFileSync(s.env.crmCatalogFilePath, 'utf8'));
  const lista = (grupo) => Object.values(grupo || {}).sort((a, b) => a.ordem - b.ordem);
  return { servicos: lista(bruto.servicos), nichos: lista(bruto.nichos), origens: lista(bruto.origens) };
};
const respostas = (s) => s.fetchImpl.responses.filter((r) => r.path.startsWith('/api/crm-catalogs'));
const ultima = (s) => respostas(s).at(-1);
const semLixo = (s) => assert.doesNotMatch(texto(s), /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/);

test('[CATFULL-1] SERVIÇOS de ponta a ponta no servidor real: vazio, recorrência obrigatória (400 real), criar, nome duplicado mesmo com acento/maiúscula (409 real), editar, em uso pelo CRM, desativar, reativar e reordenar — tudo em arquivo temporário', async (t) => {
  const s = await subir(t, { hash: '#/crm/configuracoes/servicos', sementes: [CLIENTE_DO_CRM] });
  assert.ok(!path.resolve(s.env.crmCatalogFilePath).startsWith(path.resolve(REPO_DATA)), 'o arquivo de teste NÃO é o data/ do projeto');
  assert.ok(path.resolve(s.env.crmCatalogFilePath).startsWith(path.resolve(os.tmpdir())), 'e vive na pasta temporária');
  assert.match(texto(s), /Nenhum serviço cadastrado ainda\./);
  assert.equal(fs.existsSync(s.env.crmCatalogFilePath), false, 'ler não cria o arquivo');
  assert.equal(ultima(s).status, 200);

  // 1) recorrente sem recorrência: o SERVIDOR recusa e a tela mostra junto do campo
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Gestão de redes');
  escolher(s, campo(s, 'tipoCobranca'), 'RECORRENTE');
  digitar(s, campo(s, 'precoReferencia'), '1.500,00');
  await salvar(s);
  assert.equal(ultima(s).status, 400);
  assert.equal(JSON.parse(ultima(s).text).error.code, 'CRM_CATALOG_INVALID_INPUT');
  assert.deepEqual(JSON.parse(ultima(s).text).error.details, [{ path: 'recorrencia', code: 'RECORRENCIA_OBRIGATORIA' }]);
  assert.equal(erroDe(s, 'recorrencia').textContent, 'Escolha a recorrência: a cobrança é recorrente.');
  assert.ok(gaveta(s), 'o painel continua aberto com tudo o que foi digitado');
  assert.equal(campo(s, 'nome').value, 'Gestão de redes');
  assert.equal(fs.existsSync(s.env.crmCatalogFilePath), false, 'nada foi gravado');

  // 2) criar de verdade
  escolher(s, campo(s, 'recorrencia'), 'MENSAL');
  await salvar(s);
  assert.equal(ultima(s).status, 201);
  assert.equal(gaveta(s), null);
  assert.deepEqual(nomes(s), ['Gestão de redes']);
  assert.match(texto(s), /Serviço criado\./);
  const gravado = arquivo(s).servicos[0];
  assert.match(gravado.id, /^service:/);
  assert.deepEqual([gravado.nome, gravado.precoReferencia, gravado.tipoCobranca, gravado.recorrencia, gravado.ativo, gravado.ordem], ['Gestão de redes', 1500, 'RECORRENTE', 'MENSAL', true, 0]);
  assert.equal(gravado.criadoPorNome, 'Breno Bento', 'quem criou vem do token, não da tela');
  assert.match(texto(s), /Preço de referência: R\$\s1\.500,00 · Cobrança recorrente \(mensal\)/);

  // 3) nome duplicado: a normalização é do servidor (acento, caixa, espaços)
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), '  GESTAO   de REDES ');
  await salvar(s);
  assert.equal(ultima(s).status, 409);
  assert.equal(erroDe(s, 'nome').textContent, 'Já existe um item com este nome, mesmo desativado. Use outro nome ou reative o item existente.');
  assert.equal(arquivo(s).servicos.length, 1);
  digitar(s, campo(s, 'nome'), 'Criação de site');
  await salvar(s);
  assert.equal(ultima(s).status, 201);
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Consultoria');
  await salvar(s);
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria']);
  assert.deepEqual(arquivo(s).servicos.map((i) => i.ordem), [0, 1, 2]);

  // 4) editar só o preço
  await clicar(s, acao(s, idDe(s, 'Gestão de redes'), 'edit'));
  assert.equal(campo(s, 'precoReferencia').value, '1.500,00');
  digitar(s, campo(s, 'precoReferencia'), '1.800,50');
  await salvar(s);
  assert.equal(ultima(s).status, 200);
  assert.deepEqual(s.fetchImpl.calls.filter((c) => c.method === 'PATCH').at(-1).body, { precoReferencia: 1800.5 });
  assert.equal(arquivo(s).servicos[0].precoReferencia, 1800.5);

  // 5) em uso pelo CRM legado: o nome trava na tela E o servidor recusa a troca se for pedida direto
  const idSite = idDe(s, 'Criação de site');
  await clicar(s, acao(s, idSite, 'edit'));
  assert.match(gaveta(s).textContent, /Este serviço é usado em 1 registro do CRM\. Por isso o nome não pode ser alterado nesta fase/);
  assert.equal(campo(s, 'nome').readOnly, true);
  digitar(s, campo(s, 'categoria'), 'Web');
  await salvar(s);
  assert.deepEqual(s.fetchImpl.calls.filter((c) => c.method === 'PATCH').at(-1).body, { categoria: 'Web' }, 'o nome não vai no corpo');
  const direto = await s.fetchImpl(`/api/crm-catalogs/servicos/${encodeURIComponent(idSite)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: 'Outro nome' }) });
  assert.equal(direto.status, 409);
  assert.equal((await direto.json()).error.code, 'CRM_CATALOG_NAME_IN_USE');
  assert.equal(arquivo(s).servicos[1].nome, 'Criação de site');

  // 6) desativar (confirmação) e reativar: nada é apagado
  const idConsultoria = idDe(s, 'Consultoria');
  await clicar(s, acao(s, idConsultoria, 'toggle'));
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.equal(arquivo(s).servicos.length, 3, 'nada foi apagado');
  assert.equal(arquivo(s).servicos[2].ativo, false);
  assert.match(texto(s), /Serviço desativado\./);
  await clicar(s, acao(s, idConsultoria, 'toggle'));
  assert.equal(arquivo(s).servicos[2].ativo, true);

  // 7) reordenar: a lista COMPLETA vai ao servidor e a ordem fica no arquivo
  await clicar(s, acao(s, idConsultoria, 'up'));
  assert.deepEqual(s.fetchImpl.calls.filter((c) => c.path.endsWith('/reorder')).at(-1).body, { orderedIds: [idDe(s, 'Gestão de redes'), idConsultoria, idSite] });
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Consultoria', 'Criação de site']);
  assert.deepEqual(arquivo(s).servicos.map((i) => [i.nome, i.ordem]), [['Gestão de redes', 0], ['Consultoria', 1], ['Criação de site', 2]]);
  // recarregar a lista do servidor traz a mesma ordem
  await clicar(s, botao(s, 'Atualizar'));
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Consultoria', 'Criação de site']);
  semLixo(s);

  // o servidor nunca recebeu identidade, ordem, ativo ou datas vindos da tela
  for (const chamada of s.fetchImpl.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH')) {
    for (const proibido of ['id', 'ordem', 'ativo', 'userId', 'role', 'permissions', 'criadoPorNome', 'atualizadoPorNome', 'criadoEm', 'atualizadoEm']) assert.ok(!Object.prototype.hasOwnProperty.call(chamada.body || {}, proibido), `${chamada.path}: ${proibido}`);
  }
});

test('[CATFULL-2] NICHOS E CORES no servidor real: só a CHAVE da cor é gravada; o nicho legado sem cor aparece neutro e pode ser editado sem receber uma cor inventada', async (t) => {
  const s = await subir(t, { hash: '#/crm/configuracoes/nichos' });
  await clicar(s, botao(s, 'Novo Nicho'));
  digitar(s, campo(s, 'nome'), 'Clínicas de estética');
  await salvar(s);
  assert.ok(gaveta(s), 'sem cor, a tela não envia');
  assert.equal(s.fetchImpl.calls.filter((c) => c.method === 'POST').length, 0);
  const azul = s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'radio' && el.getAttribute('data-color') === 'azul');
  await clicar(s, azul);
  await salvar(s);
  assert.equal(ultima(s).status, 201);
  assert.deepEqual(s.fetchImpl.calls.filter((c) => c.method === 'POST').at(-1).body, { nome: 'Clínicas de estética', cor: 'azul' });
  const gravado = arquivo(s).nichos[0];
  assert.equal(gravado.cor, 'azul');
  assert.equal(JSON.stringify(arquivo(s)).includes('#'), false, 'nenhum valor de cor foi gravado');
  const linha = linhas(s)[0];
  assert.ok(/\bcor-azul\b/.test(linha.className));
  assert.equal(s.browser.find(linha, (el) => /\bnicho-chip\b/.test(el.className)).textContent, 'Azul');

  // um nicho LEGADO sem cor (o servidor aceita cor nula): chega pela API, a tela o mostra neutro
  const criado = await s.fetchImpl('/api/crm-catalogs/nichos', { method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: 'Nicho antigo' }) });
  assert.equal(criado.status, 201);
  assert.equal((await criado.json()).item.cor, null);
  await clicar(s, botao(s, 'Atualizar'));
  assert.deepEqual(nomes(s), ['Clínicas de estética', 'Nicho antigo']);
  const antigo = linhas(s)[1];
  assert.ok(!/\bcor-/.test(antigo.className), 'neutro, sem classe de cor');
  assert.equal(s.browser.find(antigo, (el) => /\bnicho-chip\b/.test(el.className)).textContent, 'Sem cor definida');
  await clicar(s, acao(s, antigo.getAttribute('data-id'), 'edit'));
  digitar(s, campo(s, 'descricao'), 'Descrição nova');
  await salvar(s);
  assert.deepEqual(s.fetchImpl.calls.filter((c) => c.method === 'PATCH').at(-1).body, { descricao: 'Descrição nova' });
  assert.equal(arquivo(s).nichos[1].cor, null, 'a cor continua sem valor: nada foi inventado');
  // e trocar a cor do primeiro
  await clicar(s, acao(s, linhas(s)[0].getAttribute('data-id'), 'edit'));
  await clicar(s, s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'radio' && el.getAttribute('data-color') === 'indigo'));
  await salvar(s);
  assert.equal(arquivo(s).nichos[0].cor, 'indigo');
  assert.ok(/\bcor-indigo\b/.test(linhas(s)[0].className));
});

test('[CATFULL-3] ORIGENS DOS LEADS no servidor real: nome e canal (taxonomia real); nenhuma integração; desativar não apaga', async (t) => {
  const s = await subir(t, { hash: '#/crm/configuracoes/origens' });
  await clicar(s, botao(s, 'Nova Origem'));
  digitar(s, campo(s, 'nome'), 'Indicação de cliente');
  escolher(s, campo(s, 'canal'), 'INDICACAO');
  digitar(s, campo(s, 'descricao'), 'Quem já é cliente indica');
  await salvar(s);
  assert.equal(ultima(s).status, 201);
  assert.deepEqual([arquivo(s).origens[0].canal, arquivo(s).origens[0].nome, arquivo(s).origens[0].ativo], ['INDICACAO', 'Indicação de cliente', true]);
  assert.match(texto(s), /Indicação de cliente.*Ativo.*Indicação.*Quem já é cliente indica/);
  await clicar(s, acao(s, idDe(s, 'Indicação de cliente'), 'toggle'));
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.equal(arquivo(s).origens[0].ativo, false);
  assert.equal(arquivo(s).origens.length, 1);
  assert.deepEqual([...new Set(s.fetchImpl.calls.map((c) => c.path.split('?')[0].replace(/\/origin%3A[^/]+/, '/:id')))].filter((p) => p.startsWith('/api/') && !p.startsWith('/api/crm-catalogs')).sort(), ['/api/me'], 'a tela só falou com os catálogos (e /api/me)');
});

test('[CATFULL-4] O VENDEDOR no servidor real: o menu não mostra os cadastros, os links diretos dizem "sem acesso", nenhuma chamada de catálogo sai — e o servidor, chamado direto, recusa (403) tudo o que é administrativo', async (t) => {
  const s = await subir(t, { usuario: RAFAEL, hash: '#/crm/configuracoes/servicos' });
  assert.match(texto(s), /Esta conta não possui acesso a esta área\./);
  const menu = s.browser.by.tag(s.browser.by.tag(s.browser.root, 'nav')[0], 'a').map((a) => a.textContent);
  for (const rotulo of ['Serviços', 'Nichos e Cores', 'Origens dos Leads', 'Configurações do CRM', 'Gestão de Funis e Etapas']) assert.ok(!menu.includes(rotulo), rotulo);
  for (const hash of ['#/crm/configuracoes/nichos', '#/crm/configuracoes/origens/novo']) {
    await ir(s, hash);
    assert.match(texto(s), /Esta conta não possui acesso a esta área\./, hash);
  }
  assert.deepEqual(respostas(s), [], 'nenhuma chamada a /api/crm-catalogs');
  const chamar = (metodo, caminho, corpo) => s.fetchImpl(caminho, { method: metodo, headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, ...(corpo ? { body: JSON.stringify(corpo) } : {}) });
  assert.equal((await chamar('GET', '/api/crm-catalogs/servicos?todos=1')).status, 403, 'ver os desativados é administrativo');
  assert.equal((await chamar('POST', '/api/crm-catalogs/servicos', { nome: 'X' })).status, 403);
  assert.equal((await chamar('POST', '/api/crm-catalogs/nichos/reorder', { orderedIds: [] })).status, 403);
  assert.equal((await chamar('POST', '/api/crm-catalogs/origens/origin%3Ax/deactivate', {})).status, 403);
  assert.equal((await chamar('GET', '/api/crm-catalogs/servicos')).status, 200, 'consultar os ATIVOS continua permitido (READ:CRM) — para as futuras telas comerciais');
  assert.equal(fs.existsSync(s.env.crmCatalogFilePath), false, 'e nada foi gravado');
});

test('[CATFULL-5] ESTRUTURA DE DADOS AUSENTE (migration NÃO aplicada): com o adaptador real do Postgres/Supabase e um PostgREST falso que responde "tabela não existe", a tela explica com clareza, não confirma nada e continua usável', async (t) => {
  const chamadasAoPostgrest = [];
  const fetchSemTabelas = async (url, init = {}) => {
    chamadasAoPostgrest.push(`${init.method || 'GET'} ${String(url).replace(/^https:\/\/exemplo-teste\.supabase\.co/, '')}`);
    return new Response(JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.crm_services' in the schema cache" }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  const repository = createSupabaseCatalogRepository({ url: 'https://exemplo-teste.supabase.co', serviceRoleKey: 'chave-de-servico-falsa-so-para-teste', fetchImpl: fetchSemTabelas });
  const service = createCatalogService({ authorizeOperation: authorizeCatalogOperation, repository, countUsage: async () => 0 });
  const s = await subir(t, { hash: '#/crm/configuracoes/servicos', ambiente: { crmCatalogs: false, crmCatalogService: service } });
  assert.equal(ultima(s).status, 503);
  assert.equal(JSON.parse(ultima(s).text).error.code, 'CRM_CATALOG_PERSISTENCE');
  assert.match(texto(s), /Os cadastros não estão disponíveis agora\. Isso acontece, por exemplo, quando a estrutura de dados dos cadastros ainda não foi preparada neste ambiente\. Nada foi alterado\./);
  assert.doesNotMatch(texto(s), /PGRST|crm_services|schema cache/, 'o detalhe técnico do banco nunca chega à tela');
  assert.equal(linhas(s).length, 0);
  assert.ok(botao(s, 'Tentar novamente'));
  // a indisponibilidade foi CONFIRMADA pelo servidor (503): criar não é possível — o botão está desabilitado, o painel não abre (nem por link direto) e NENHUMA gravação é enviada
  assert.equal(botao(s, 'Novo Serviço').disabled, true);
  await clicar(s, botao(s, 'Novo Serviço'));
  assert.equal(gaveta(s), null);
  await ir(s, '#/crm/configuracoes/servicos/novo');
  assert.equal(gaveta(s), null, 'nem por link direto');
  assert.equal(s.win.location.hash, '#/crm/configuracoes/servicos', 'o endereço volta à lista');
  assert.match(texto(s), /Não é possível criar agora: os cadastros estão indisponíveis\./);
  assert.deepEqual(s.fetchImpl.calls.filter((c) => c.method !== 'GET'), [], 'nenhuma gravação saiu da tela');
  assert.ok(chamadasAoPostgrest.every((c) => c.startsWith('GET ')), 'e nenhuma gravação chegou ao PostgREST');
  // a navegação e a nova tentativa de carregar continuam: o servidor segue indisponível, e nada é gravado
  const leiturasAntes = chamadasAoPostgrest.length;
  await clicar(s, botao(s, 'Tentar novamente'));
  assert.equal(ultima(s).status, 503);
  assert.ok(chamadasAoPostgrest.length > leiturasAntes, 'tentar de novo é uma nova LEITURA');
  assert.equal(botao(s, 'Novo Serviço').disabled, true);
  assert.doesNotMatch(texto(s), /Serviço criado/);
  assert.ok(chamadasAoPostgrest.every((c) => c.includes('/rest/v1/')), 'só PostgREST falso; nenhuma outra chamada');
  assert.ok(!chamadasAoPostgrest.some((c) => c.startsWith('DELETE')), 'e nunca um DELETE');
});

test('[CATFULL-6] ISOLAMENTO: nenhum teste desta tela escreve no data/ do projeto; os arquivos de teste ficam na pasta temporária e data/crm-catalogs.json não é criado', async () => {
  assert.equal(fs.existsSync(path.join(REPO_DATA, 'crm-catalogs.json')), false, 'o arquivo operacional dos catálogos não existe e não foi criado');
});
