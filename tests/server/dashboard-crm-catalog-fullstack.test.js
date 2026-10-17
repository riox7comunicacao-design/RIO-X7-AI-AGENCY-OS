// CRM 5.0, Fase 2B-3.1 — a seleção assistida dos catálogos nos formulários do CRM falando com o SERVIDOR REAL: o painel (dashboard/main.mjs e as telas), sobre o DOM de teste, faz as requisições HTTP
// que faria no navegador e cada uma cai no app REAL (src/server/app.js): autenticação pelo fluxo real, Catalog Service e CRM Service reais, domínios reais e armazenamento REAL em modo "arquivo" — num
// diretório TEMPORÁRIO PRÓPRIO do teste. Para "a estrutura de dados ainda não foi preparada" usa-se o adaptador REAL do Postgres/Supabase com um `fetch` falso que responde como o PostgREST responde
// quando a tabela não existe (a migration NÃO foi aplicada) — nenhuma rede. Nada toca data/ nem o Supabase. Só dados fictícios (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { CRM_WRITABLE_FIELDS } = require('../../src/crm/constants');
const crm = require('../../src/crm');
const { createCatalogService } = require('../../src/services/catalogService');
const { createSupabaseCatalogRepository } = require('../../src/crm-adapters/crmSupabaseCatalogRepository');
const { authorizeCatalogOperation } = require('../../src/auth');
const { createBrowser } = require('../helpers/fakeDom');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const REPO_DATA = path.join(__dirname, '..', '..', 'data');
const CHAVES = ['nicho', 'origem', 'servicoPotencial'];

async function subir(t, { usuario = BRENO, hash = '', sementes = [], ambiente = {} } = {}) {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, crmCatalogs: true, ...ambiente });
  const repositorio = createJsonFileCrmRepository(env.crmFilePath);
  const semeados = [];
  for (const campos of sementes) semeados.push((await crm.createRecord(repositorio, campos, { actor: 'HUMAN', reviewedBy: { userId: 'user-semente', name: 'Semente', role: 'ADMIN' }, motivo: 'semente do teste' })).record);
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
  return { env, browser, fetchImpl, token, win: browser.window, repositorio, semeados };
}

const texto = (s) => s.browser.root.textContent.replace(/\s+/g, ' ');
const gaveta = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const escopo = (s) => gaveta(s) || s.browser.root;
const botao = (s, rotulo) => s.browser.by.button(escopo(s), rotulo);
const ir = async (s, hash) => {
  s.win.location.hash = hash;
  await s.browser.flush(12);
};
const clicar = async (s, el) => {
  assert.ok(el, 'elemento não encontrado');
  s.browser.click(el);
  await s.browser.flush(12);
};
const seletor = (s, chave) => s.browser.by.id(s.browser.root, `crm-field-${chave}-select`);
const campoTexto = (s, chave) => s.browser.by.id(s.browser.root, `crm-field-${chave}`);
const aviso = (s, chave) => s.browser.by.id(s.browser.root, `crm-field-${chave}-note`);
const avisoDe = (s, chave) => aviso(s, chave).textContent.replace(/\s+/g, ' ').trim();
const visao = (s, chave) => s.browser.find(s.browser.root, (el) => /\bcatalog-field\b/.test(el.className) && el.children.some((filho) => filho.getAttribute('id') === `crm-field-${chave}`)).getAttribute('data-view');
const opcoes = (select) => select.children.filter((el) => el.localName === 'option').map((o) => o.textContent);
const escolher = async (s, chave, rotulo) => {
  const opcao = seletor(s, chave).children.find((el) => el.localName === 'option' && el.textContent === rotulo);
  assert.ok(opcao, `opção "${rotulo}": ${opcoes(seletor(s, chave)).join(' | ')}`);
  s.browser.choose(seletor(s, chave), opcao.value);
  await s.browser.flush(6);
};
const gravados = (s) => createJsonFileCrmRepository(s.env.crmFilePath).list();
const doCatalogo = (s) => s.fetchImpl.calls.filter((c) => c.path.startsWith('/api/crm-catalogs'));

// Chama a API REAL como a conta do teste (para semear os catálogos fictícios), pelo mesmo caminho do painel.
async function chamar(s, metodo, caminho, corpo) {
  const resposta = await s.fetchImpl(caminho, { method: metodo, headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, ...(corpo ? { body: JSON.stringify(corpo) } : {}) });
  return { status: resposta.status, body: await resposta.json() };
}

async function semearCatalogos(s) {
  const criar = async (catalogo, corpo) => {
    const r = await chamar(s, 'POST', `/api/crm-catalogs/${catalogo}`, corpo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.item;
  };
  const estetica = await criar('nichos', { nome: 'Estética', cor: 'rosa' });
  await criar('nichos', { nome: 'Odontologia', cor: 'azul' });
  const academias = await criar('nichos', { nome: 'Academias', cor: 'marrom' });
  assert.equal((await chamar(s, 'POST', `/api/crm-catalogs/nichos/${encodeURIComponent(academias.id)}/deactivate`, {})).status, 200);
  await criar('origens', { nome: 'Indicação', canal: 'INDICACAO' });
  await criar('origens', { nome: 'Anúncio no Instagram', canal: 'ANUNCIO_PAGO' });
  await criar('servicos', { nome: 'Gestão de redes sociais', precoReferencia: 1800, permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] });
  await criar('servicos', { nome: 'Criação de site', precoReferencia: 4800, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] });
  return { estetica };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATFULLCRM-1] COM CATÁLOGOS REAIS: o formulário "Novo registro" lê os três catálogos pelos endpoints reais (o ADMIN com ?todos=1), oferece só os itens ativos, e o CRM REAL grava os NOMES como TEXTO — sem criar nenhum item de catálogo, sem tocar valores financeiros', async (t) => {
  const s = await subir(t);
  await semearCatalogos(s);
  const marca = s.fetchImpl.calls.length;
  await ir(s, '#/crm/novo');

  assert.deepEqual(s.fetchImpl.calls.slice(marca).filter((c) => c.path.startsWith('/api/crm-catalogs')).map((c) => `${c.method} ${c.path}`).sort(), ['GET /api/crm-catalogs/nichos?todos=1', 'GET /api/crm-catalogs/origens?todos=1', 'GET /api/crm-catalogs/servicos?todos=1']);
  for (const chave of CHAVES) assert.equal(visao(s, chave), 'select', chave);
  assert.deepEqual(opcoes(seletor(s, 'nicho')), ['Nenhum (deixar em branco)', 'Estética', 'Odontologia', 'Informar outro valor'], 'o desativado não é oferecido');
  assert.deepEqual(opcoes(seletor(s, 'origem')), ['Nenhum (deixar em branco)', 'Indicação', 'Anúncio no Instagram', 'Informar outro valor']);
  assert.deepEqual(opcoes(seletor(s, 'servicoPotencial')), ['Nenhum (deixar em branco)', 'Gestão de redes sociais', 'Criação de site', 'Informar outro valor']);
  assert.ok(!texto(s).includes('1800') && !texto(s).includes('4800') && !/1\.800|4\.800/.test(texto(s)), 'o preço de referência nunca chega ao formulário do CRM');

  s.browser.type(s.browser.by.label(s.browser.root, 'Empresa (obrigatório)'), 'Clínica Real Teste');
  s.browser.type(s.browser.by.label(s.browser.root, 'Site'), 'real.example.test');
  await escolher(s, 'nicho', 'Estética');
  await escolher(s, 'origem', 'Indicação');
  await escolher(s, 'servicoPotencial', 'Gestão de redes sociais');
  await clicar(s, botao(s, 'Criar registro'));

  const [criado] = gravados(s);
  assert.equal(gravados(s).length, 1);
  assert.equal(criado.empresa, 'Clínica Real Teste');
  assert.equal(criado.nicho, 'Estética', 'o NOME, como texto');
  assert.equal(criado.origem, 'Indicação');
  assert.equal(criado.servicoPotencial, 'Gestão de redes sociais');
  assert.equal(criado.valorProposta, null, 'o preço do serviço não virou valor de proposta');
  assert.equal(criado.valorTotal, null);
  assert.deepEqual(Object.keys(criado).sort(), [...CRM_WRITABLE_FIELDS, 'id', 'status', 'dataDeEntrada', 'historico'].sort(), 'os 31 campos e nada além (nenhum identificador de catálogo)');
  assert.equal(typeof criado.nicho, 'string');

  const depois = await chamar(s, 'GET', '/api/crm-catalogs/nichos?todos=1');
  assert.equal(depois.body.items.length, 3, 'nenhum item foi criado pela escolha');
  assert.deepEqual(s.fetchImpl.calls.slice(marca).filter((c) => c.path.startsWith('/api/crm-catalogs') && c.method !== 'GET'), [], 'nenhuma escrita em catálogo saiu do formulário');
});

test('[CATFULLCRM-2] EDITAR um registro legado: a grafia diferente é só mostrada e a escolha é explícita; o PATCH real leva só o campo trocado; e o texto que o formulário grava é o MESMO que o servidor usa para contar o uso do item (a trava de renomeação continua valendo)', async (t) => {
  const s = await subir(t, { sementes: [{ empresa: 'Clínica Legada', site: 'legada.example.test', cidade: 'Petrópolis', nicho: 'estetica', origem: 'boca a boca', servicoPotencial: 'Criação de site' }] });
  const { estetica } = await semearCatalogos(s);
  const [legado] = s.semeados;
  await ir(s, `#/crm/registro/${encodeURIComponent(legado.id)}`);
  await clicar(s, botao(s, 'Editar'));

  assert.equal(visao(s, 'nicho'), 'select');
  assert.match(avisoDe(s, 'nicho'), /Grafia diferente da oficial \("Estética"\)/);
  assert.match(avisoDe(s, 'origem'), /^Fora do catálogo/);
  assert.equal(avisoDe(s, 'servicoPotencial'), '', 'o serviço já é exatamente o nome oficial');
  const antes = s.fetchImpl.calls.length;
  await clicar(s, botao(s, 'Salvar alterações'));
  assert.deepEqual(s.fetchImpl.calls.slice(antes).filter((c) => c.method === 'PATCH'), [], 'nada foi trocado sozinho: nada a salvar');

  await clicar(s, s.browser.by.button(aviso(s, 'nicho'), 'Usar a grafia oficial'));
  await clicar(s, botao(s, 'Salvar alterações'));
  const patch = s.fetchImpl.calls.slice(antes).filter((c) => c.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.deepEqual(patch[0].body, { nicho: 'Estética' }, 'só o campo que a pessoa trocou');
  const gravado = createJsonFileCrmRepository(s.env.crmFilePath).getById(legado.id);
  assert.equal(gravado.nicho, 'Estética');
  assert.equal(gravado.origem, 'boca a boca', 'o valor legado não tocado ficou exatamente como estava');
  assert.equal(gravado.servicoPotencial, 'Criação de site');

  // o texto gravado agora é "uso" do item para o servidor: renomear o item é recusado (a trava da decisão 0026)
  const renomear = await chamar(s, 'PATCH', `/api/crm-catalogs/nichos/${encodeURIComponent(estetica.id)}`, { nome: 'Estética Corporal' });
  assert.equal(renomear.status, 409);
  assert.equal(renomear.body.error.code, 'CRM_CATALOG_NAME_IN_USE');
});

test('[CATFULLCRM-3] ESTRUTURA DE DADOS AUSENTE (migration NÃO aplicada): com o adaptador real do Postgres e um PostgREST falso que responde "tabela não existe", os formulários caem para texto livre com a mensagem clara — e criar no CRM REAL funciona; nenhuma gravação sai para os catálogos', async (t) => {
  const chamadasAoPostgrest = [];
  const fetchSemTabelas = async (url, init = {}) => {
    chamadasAoPostgrest.push(`${init.method || 'GET'} ${String(url).replace(/^https:\/\/exemplo-teste\.supabase\.co/, '')}`);
    return new Response(JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.crm_niches' in the schema cache" }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  const repository = createSupabaseCatalogRepository({ url: 'https://exemplo-teste.supabase.co', serviceRoleKey: 'chave-de-servico-falsa-so-para-teste', fetchImpl: fetchSemTabelas });
  const service = createCatalogService({ authorizeOperation: authorizeCatalogOperation, repository, countUsage: async () => 0 });
  const s = await subir(t, { ambiente: { crmCatalogs: false, crmCatalogService: service } });
  await ir(s, '#/crm/novo');

  const respostasDoCatalogo = s.fetchImpl.responses.filter((r) => r.path.startsWith('/api/crm-catalogs'));
  assert.equal(respostasDoCatalogo.length, 3);
  assert.ok(respostasDoCatalogo.every((r) => r.status === 503 && JSON.parse(r.text).error.code === 'CRM_CATALOG_PERSISTENCE'));
  // os TRÊS falharam pelo mesmo motivo (503): um aviso só, no início do formulário — não três iguais
  const avisoUnico = s.browser.findAll(s.browser.root, (el) => el.className.split(/\s+/).includes('catalog-notice') && !el.hidden);
  assert.equal(avisoUnico.length, 1, 'um aviso só');
  assert.match(avisoUnico[0].textContent, /^Os cadastros estão indisponíveis neste ambiente, então as opções oficiais não foram carregadas\. Nicho, Origem do Lead e Serviço potencial continuam disponíveis para preenchimento manual/);
  assert.ok(s.browser.by.button(avisoUnico[0], 'Verificar novamente'));
  for (const chave of CHAVES) {
    assert.equal(visao(s, chave), 'text', chave);
    assert.equal(avisoDe(s, chave), '', 'o campo não repete o aviso');
  }
  assert.doesNotMatch(texto(s), /PGRST|crm_niches|schema cache/, 'o detalhe técnico do banco nunca chega à tela');

  // o CRM continua funcionando de ponta a ponta
  s.browser.type(s.browser.by.label(s.browser.root, 'Empresa (obrigatório)'), 'Clínica Sem Cadastros');
  s.browser.type(s.browser.by.label(s.browser.root, 'Site'), 'semcadastros.example.test');
  s.browser.type(campoTexto(s, 'nicho'), 'Fisioterapia');
  s.browser.type(campoTexto(s, 'origem'), 'Indicação de colega');
  s.browser.type(campoTexto(s, 'servicoPotencial'), 'Consultoria');
  await clicar(s, s.browser.by.button(avisoUnico[0], 'Verificar novamente'));
  assert.equal(s.fetchImpl.responses.filter((r) => r.path.startsWith('/api/crm-catalogs')).length, 6, '"Verificar novamente" é uma leitura por catálogo');
  assert.ok(s.fetchImpl.responses.filter((r) => r.path.startsWith('/api/crm-catalogs')).every((r) => r.status === 503));
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.className.split(/\s+/).includes('catalog-notice') && !el.hidden).length, 1, 'continua um aviso só');
  assert.equal(gravados(s).length, 0, '"Verificar novamente" só relê os cadastros: não cria o registro');
  assert.equal(campoTexto(s, 'nicho').value, 'Fisioterapia', 'e o digitado continua');
  await clicar(s, botao(s, 'Criar registro'));
  const [criado] = gravados(s);
  assert.equal(gravados(s).length, 1);
  assert.deepEqual([criado.nicho, criado.origem, criado.servicoPotencial], ['Fisioterapia', 'Indicação de colega', 'Consultoria']);
  assert.match(texto(s), /Registro criado\./);

  assert.deepEqual(doCatalogo(s).filter((c) => c.method !== 'GET'), [], 'nenhuma gravação saiu para os catálogos');
  assert.ok(chamadasAoPostgrest.every((c) => c.startsWith('GET ')), 'e nenhuma gravação chegou ao PostgREST');
  assert.ok(!texto(s).includes('undefined') && !texto(s).includes('[object'));
});

test('[CATFULLCRM-4] QUEM SÓ LÊ O CRM (COMMERCIAL_CLOSER): sem formulário, nenhuma consulta a catálogos; e o servidor real recusa ?todos=1 para essa conta (por isso o Dashboard só o pede a quem administra)', async (t) => {
  const s = await subir(t, { usuario: RAFAEL, sementes: [{ empresa: 'Clínica Só Leitura', site: 'leitura.example.test', nicho: 'Psicologia' }] });
  const [registro] = s.semeados;
  await ir(s, `#/crm/registro/${encodeURIComponent(registro.id)}`);
  assert.equal(botao(s, 'Editar'), null, 'sem a permissão comercial de escrita não há edição');
  await ir(s, '#/crm/novo');
  assert.match(texto(s), /Sua conta não pode criar registros no CRM/);
  assert.deepEqual(doCatalogo(s), [], 'nenhuma consulta a catálogos');
  assert.equal((await chamar(s, 'GET', '/api/crm-catalogs/nichos')).status, 200, 'consultar os ativos é permitido (READ:CRM)');
  assert.equal((await chamar(s, 'GET', '/api/crm-catalogs/nichos?todos=1')).status, 403, 'os desativados são da administração');
});

test('[CATFULLCRM-5] ISOLAMENTO: nenhum teste desta tela escreve no data/ do projeto; os arquivos ficam na pasta temporária e data/crm-catalogs.json não é criado', () => {
  assert.equal(fs.existsSync(path.join(REPO_DATA, 'crm-catalogs.json')), false);
});
