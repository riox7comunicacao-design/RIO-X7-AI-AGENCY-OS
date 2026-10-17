// O QUADRO DE NEGOCIAÇÕES, o DASHBOARD COMERCIAL e a GESTÃO DE FUNIS falando com o SERVIDOR REAL (CRM 5.0, Fase D1): o painel (dashboard/main.mjs e as telas), sobre o DOM de teste, faz as requisições HTTP
// que faria no navegador e cada uma cai no app REAL (src/server/app.js): autenticação pelo fluxo real, serviços reais, domínio real e armazenamento REAL em modo "arquivo" — em diretórios TEMPORÁRIOS
// PRÓPRIOS do teste. Nada toca data/ nem o Supabase: o ambiente de teste nem tem credenciais, e o guarda hermético bloqueia qualquer acesso externo.
//
// É o teste que impede o Dashboard e a API de se afastarem: se o servidor mudar um contrato, um campo, um código ou uma regra (prazo × periodicidade, serviço permitido, quem pode reabrir), a interface falha
// aqui. O que NÃO é real: o navegador (um DOM de teste), o SDK do Supabase do navegador (um falso) e a rede (sem socket). Usuários, e-mails e nomes são fictícios (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const crm = require('../../src/crm');
const { createBrowser } = require('../helpers/fakeDom');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const REPO_DATA = path.join(__dirname, '..', '..', 'data');
// O MESMO conjunto roda nos dois modos (Fase D1.1): dashboard-negotiation-fullstack.test.js (arquivo) e ....supabase.test.js (adapters do Supabase sobre o PostgREST falso).
const MODO = process.env.NEG_TEST_STORAGE === 'supabase' ? 'supabase' : 'arquivo';
const NBSP = String.fromCharCode(160);
const CLIENTE = Object.freeze({ empresa: 'Clínica Alfa', site: 'alfa.example.test', telefone: '24 90000-0003', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', origem: 'Indicação', servicoPotencial: 'Gestão de redes' });
const OUTRO_CLIENTE = Object.freeze({ ...CLIENTE, empresa: 'Clínica Beta', site: 'beta.example.test', telefone: '24 90000-0004' });

async function subir(t, { usuario = BRENO, hash = '#/funis', semear = true } = {}) {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, funnels: true, crmCatalogs: true, negotiations: true, commercialStorage: MODO });
  const repositorio = createJsonFileCrmRepository(env.crmFilePath);
  const reviewedBy = { userId: 'user-semente', name: 'Semente', role: 'ADMIN' };
  if (semear) {
    for (const campos of [CLIENTE, OUTRO_CLIENTE]) await crm.createRecord(repositorio, campos, { actor: 'HUMAN', reviewedBy, motivo: 'semente do teste' });
  }
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, bridgeFetch } = await loadFixtures();
  // uma ponte PRÓPRIA para semear pelo servidor real (as chamadas do painel ficam separadas)
  const semente = bridgeFetch(env.app);
  const chamar = async (usuarioDaSemente, metodo, caminho, corpo) => {
    const resposta = await semente(caminho, { method: metodo, headers: { authorization: `Bearer ${env.tokenFor(usuarioDaSemente.userId)}`, 'content-type': 'application/json' }, ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }) });
    const texto = await resposta.text();
    return { status: resposta.status, json: texto ? JSON.parse(texto) : null };
  };
  const ids = {};
  if (semear) {
    const funil = await chamar(BRENO, 'POST', '/api/funnels', { nome: 'Vendas' });
    assert.equal(funil.status, 201);
    ids.funil = funil.json.item.id;
    ids.etapas = [];
    for (const nome of ['Contato', 'Proposta', 'Fechamento']) {
      const etapa = await chamar(BRENO, 'POST', `/api/funnels/${encodeURIComponent(ids.funil)}/stages`, { nome });
      assert.equal(etapa.status, 201);
      ids.etapas.push(etapa.json.item.id);
    }
    const servico = await chamar(BRENO, 'POST', '/api/crm-catalogs/servicos', { nome: 'Gestão de redes', precoReferencia: 1500, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] });
    assert.equal(servico.status, 201, JSON.stringify(servico.json));
    ids.servico = servico.json.item.id;
    const sitesoUnico = await chamar(BRENO, 'POST', '/api/crm-catalogs/servicos', { nome: 'Site institucional', precoReferencia: 6000, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] });
    assert.equal(sitesoUnico.status, 201, JSON.stringify(sitesoUnico.json));
    ids.site = sitesoUnico.json.item.id;
  }
  const browser = createBrowser({ hash });
  const bridge = bridgeFetch(env.app);
  const fetchImpl = async (caminho, init) => (caminho === '/config.json' ? new Response(JSON.stringify(CONFIG), { status: 200 }) : bridge(caminho, init));
  fetchImpl.calls = bridge.calls;
  fetchImpl.responses = bridge.responses;
  const token = env.tokenFor(usuario.userId);
  const sdk = createFakeSdk({ session: { access_token: token, refresh_token: 'refresh-de-teste-nao-real', user: { id: usuario.authUserId } } });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation: browserNavigation(browser.window) });
  await browser.flush(14);
  return { env, browser, fetchImpl, token, win: browser.window, ids, chamar };
}

// --- o que a pessoa vê e faz ---
const principal = (s) => s.browser.by.id(s.browser.root, 'main');
const texto = (s) => principal(s).textContent.replace(/\s+/g, ' ').split(NBSP).join(' ');
const botaoDaTela = (s, acao) => s.browser.find(principal(s), (el) => el.localName === 'button' && el.getAttribute('data-action') === acao);
const coluna = (s, indice) => s.browser.by.cls(principal(s), 'funnel-column')[indice];
const cartoes = (s) => s.browser.by.cls(principal(s), 'funnel-card');
const tituloDe = (s, empresa) => s.browser.find(principal(s), (el) => el.localName === 'button' && el.getAttribute('data-action') === 'open' && el.textContent === empresa);
const moverDe = (s, empresa) => s.browser.find(s.browser.find(principal(s), (el) => /\bfunnel-card\b/.test(el.className) && el.textContent.startsWith(empresa)), (el) => el.localName === 'select' && el.getAttribute('data-action') === 'move');
const modal = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bmodal\b/.test(el.className) && /\bsize-md\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.browser.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className) && /\bsize-sm\b/.test(el.className));
const formulario = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const botao = (s, rotulo, escopo) => s.browser.by.button(escopo || s.browser.root, rotulo);
const campo = (s, nome) => s.browser.by.id(s.browser.root, `negotiation-field-${nome}`);
const erroDoCampo = (s, nome) => s.browser.by.id(s.browser.root, `negotiation-field-${nome}-error`);
const doModal = (s, acao) => s.browser.find(modal(s), (el) => el.localName === 'button' && el.getAttribute('data-action') === acao);
const clicar = async (s, el) => {
  s.browser.click(el);
  await s.browser.flush(14);
};
const ir = async (s, hash) => {
  s.win.location.hash = hash;
  await s.browser.flush(14);
};
const digitar = (s, el, valor) => s.browser.type(el, valor);
const escolher = (s, el, valor) => s.browser.choose(el, valor);
const semLixo = (s) => assert.doesNotMatch(texto(s), /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/);
const respostas = (s, prefixo) => s.fetchImpl.responses.filter((r) => r.path.startsWith(prefixo));
const escritas = (s) => s.fetchImpl.calls.filter((c) => c.method !== 'GET' && c.path.startsWith('/api/') && !c.path.startsWith('/api/auth'));
// As negociações como estão GRAVADAS (o arquivo temporário, ou as linhas do banco falso — o mesmo formato do domínio onde os testes olham).
const negociacoesNoArquivo = (s) => {
  if (MODO === 'supabase') {
    return [...s.env.commercialDb.tabelas.crm_negotiations.values()].map((row) => ({ id: row.id, situacao: row.situacao, motivoPerda: row.motivo_perda, valorNegociado: row.valor_centavos / 100, crmRecordId: row.crm_record_id }));
  }
  if (!fs.existsSync(s.env.negotiationFilePath)) return [];
  const bruto = JSON.parse(fs.readFileSync(s.env.negotiationFilePath, 'utf8'));
  return Object.values(bruto.negotiations || bruto.items || {});
};
const publicas = async (s) => (await s.chamar(BRENO, 'GET', '/api/negotiations')).json.items;
// "nada foi gravado": nenhum arquivo de negociações (arquivo) ou nenhuma linha de negociação/histórico/card/movimento (banco).
const nadaGravado = (s) => {
  if (MODO === 'supabase') {
    const t = s.env.commercialDb.tabelas;
    return [t.crm_negotiations.size, t.crm_negotiation_events.length, t.crm_funnel_card_moves.length, [...t.crm_funnel_cards.values()].filter((c) => c.negotiation_id).length].every((n) => n === 0);
  }
  return !fs.existsSync(s.env.negotiationFilePath);
};
const escolherCliente = (s, empresa) => {
  const opcao = [...campo(s, 'crmRecordId').childNodes].find((o) => o.textContent === empresa);
  escolher(s, campo(s, 'crmRecordId'), opcao.value);
};
const escolherServico = (s, nome) => {
  const opcao = [...campo(s, 'serviceId').childNodes].find((o) => o.textContent === nome);
  escolher(s, campo(s, 'serviceId'), opcao.value);
};

test('[NEGFULL-1] O FLUXO COMPLETO no servidor real: quadro vazio → nova negociação recorrente (o 201 real, o arquivo, o cartão com o TCV calculado pelo servidor) → mover → detalhes → ganhar; tudo persistido, nada fora da pasta temporária', async (t) => {
  const s = await subir(t);
  assert.ok(!path.resolve(s.env.negotiationFilePath).startsWith(path.resolve(REPO_DATA)), 'o arquivo de teste NÃO é o data/ do projeto');
  assert.ok(path.resolve(s.env.negotiationFilePath).startsWith(path.resolve(os.tmpdir())), 'e vive na pasta temporária');
  if (MODO === 'supabase') assert.ok(s.env.commercialDb, 'no modo supabase o armazenamento é o banco (falso) — nenhum arquivo é usado');
  assert.match(texto(s), /Funis de Vendas|Cada cartão é uma negociação/);
  assert.equal(s.browser.by.cls(principal(s), 'funnel-column').length, 3, 'as três etapas reais do funil real');
  assert.match(texto(s), /Nenhum cartão\./);
  assert.equal(nadaGravado(s), true, 'ler o quadro não grava nada');
  assert.deepEqual(escritas(s), [], 'abrir o quadro só lê');

  // nova negociação: cliente, serviço, recorrente mensal, 12 meses, 1.500,00 por mês
  await clicar(s, botaoDaTela(s, 'new'));
  assert.ok(formulario(s));
  assert.deepEqual([...campo(s, 'crmRecordId').childNodes].map((o) => o.textContent).sort(), ['Clínica Alfa', 'Clínica Beta', 'Escolha o cliente'].sort());
  assert.deepEqual([...campo(s, 'serviceId').childNodes].map((o) => o.textContent), ['Escolha o serviço', 'Gestão de redes', 'Site institucional']);
  escolherCliente(s, 'Clínica Alfa');
  escolherServico(s, 'Gestão de redes');
  await clicar(s, campo(s, 'formaPagamento-recorrente'));
  escolher(s, campo(s, 'periodicidade'), 'MENSAL');
  await clicar(s, campo(s, 'prazo-12'));
  digitar(s, campo(s, 'valorNegociado'), '1.500,00');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  const criar = escritas(s).find((c) => c.method === 'POST' && c.path === '/api/negotiations');
  assert.deepEqual(Object.keys(criar.body).sort(), ['crmRecordId', 'formaPagamento', 'funnelId', 'periodicidade', 'prazoMeses', 'serviceId', 'valorNegociado'], 'só os campos do contrato: nunca situação, responsável ou financeiro');
  assert.equal(respostas(s, '/api/negotiations').find((r) => r.method === 'POST').status, 201);
  assert.equal(formulario(s), null);
  assert.equal(cartoes(s).length, 1);
  assert.match(coluna(s, 0).textContent.split(NBSP).join(' '), /Clínica Alfa/);
  assert.match(coluna(s, 0).textContent.split(NBSP).join(' '), /TCV R\$ 18\.000,00/, '12 × 1.500,00, calculado pelo servidor');
  assert.match(coluna(s, 0).textContent.split(NBSP).join(' '), /Em negociação: R\$ 18\.000,00 \(TCV\)/);
  assert.match(coluna(s, 0).textContent, /Responsável: Breno Bento/, 'o responsável vem da conta, não de um campo');
  const gravadas = negociacoesNoArquivo(s);
  assert.equal(gravadas.length, 1);
  assert.equal(gravadas[0].valorNegociado, 1500);
  assert.equal(gravadas[0].situacao, 'ABERTA');
  assert.equal(gravadas[0].crmRecordId.startsWith('crm:'), true);

  // mover para Proposta: o servidor registra a etapa e o histórico
  escolher(s, moverDe(s, 'Clínica Alfa'), s.ids.etapas[1]);
  await s.browser.flush(14);
  assert.match(coluna(s, 1).textContent, /Clínica Alfa/);
  assert.doesNotMatch(coluna(s, 0).textContent, /Clínica Alfa/);
  assert.equal((await publicas(s))[0].stageId, s.ids.etapas[1], 'o servidor guardou a etapa nova');
  // detalhes com histórico real
  await clicar(s, tituloDe(s, 'Clínica Alfa'));
  const detalhes = modal(s).textContent.replace(/\s+/g, ' ').split(NBSP).join(' ');
  assert.match(detalhes, /MRR \(receita recorrente mensal\).*1\.500,00/);
  assert.match(detalhes, /12 cobranças de R\$ 1\.500,00, todo mês/);
  assert.match(detalhes, /Mudou de etapa: Contato → Proposta/);
  assert.match(detalhes, /Negociação criada\./);
  // ganhar (sem pagamento)
  await clicar(s, doModal(s, 'detail-win'));
  assert.match(confirmacao(s).textContent, /Não registra pagamento/);
  await clicar(s, botao(s, 'Marcar como ganha', confirmacao(s)));
  assert.equal(negociacoesNoArquivo(s)[0].situacao, 'GANHA');
  assert.match(modal(s).textContent, /Marcada como ganha\./);
  assert.equal(doModal(s, 'detail-win'), null);
  semLixo(s);
  assert.equal(fs.existsSync(path.join(REPO_DATA, 'negotiations.json')), false, 'nada foi gravado no data/ do projeto');
});

test('[NEGFULL-2] O SERVIDOR REAL tem a palavra final: prazo que não fecha com a periodicidade e forma de pagamento que o serviço não permite voltam como erro por campo (400 real) e NADA é gravado; a tela confere antes, mas o servidor confere de novo', async (t) => {
  const s = await subir(t);
  // direto no servidor: prazo 10 com periodicidade trimestral; recorrente num serviço só-único; cliente inexistente
  const cliente = (await s.chamar(BRENO, 'GET', '/api/crm')).json.items.find((item) => item.empresa === 'Clínica Alfa');
  const base = { crmRecordId: cliente.id, funnelId: s.ids.funil, serviceId: s.ids.servico, prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'TRIMESTRAL', valorNegociado: 3000 };
  const casos = [
    [{ ...base, prazoMeses: 10 }, 'prazoMeses'],
    [{ ...base, serviceId: s.ids.site }, 'formaPagamento'],
    [{ ...base, crmRecordId: 'crm:inexistente' }, 'crmRecordId'],
    [{ ...base, valorNegociado: 12.345 }, 'valorNegociado'],
    [{ ...base, situacao: 'GANHA' }, null],
  ];
  for (const [corpo, caminho] of casos) {
    const resposta = await s.chamar(BRENO, 'POST', '/api/negotiations', corpo);
    assert.equal(resposta.status, 400, JSON.stringify(corpo));
    if (caminho) assert.ok(resposta.json.error.details.some((d) => d.path === caminho), `${caminho}: ${JSON.stringify(resposta.json)}`);
  }
  assert.equal(nadaGravado(s), true, 'nenhuma recusa gravou nada');
  // pelo painel: um prazo "Outro" que o servidor aceitaria só com periodicidade mensal; a tela recusa antes de enviar
  await clicar(s, botaoDaTela(s, 'new'));
  escolherCliente(s, 'Clínica Alfa');
  escolherServico(s, 'Gestão de redes');
  await clicar(s, campo(s, 'formaPagamento-recorrente'));
  escolher(s, campo(s, 'periodicidade'), 'TRIMESTRAL');
  await clicar(s, campo(s, 'prazo-outro'));
  digitar(s, campo(s, 'prazoMeses'), '10');
  digitar(s, campo(s, 'valorNegociado'), '3.000,00');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(erroDoCampo(s, 'prazoMeses').textContent, /múltiplo da periodicidade/);
  assert.equal(escritas(s).filter((c) => c.path === '/api/negotiations').length, 0, 'a tela não enviou');
  // corrige para 12 meses trimestral: 4 cobranças de 3.000 = 12.000 de TCV e equivalente mensal de 1.000
  digitar(s, campo(s, 'prazoMeses'), '12');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.equal(cartoes(s).length, 1);
  assert.match(texto(s), /TCV R\$ 12\.000,00/);
  await clicar(s, tituloDe(s, 'Clínica Alfa'));
  assert.doesNotMatch(modal(s).textContent, /MRR/, 'recorrência trimestral não é MRR');
  assert.match(modal(s).textContent.split(NBSP).join(' '), /Equivalente mensal.*1\.000,00/);
  assert.match(modal(s).textContent, /4 cobranças de R\$.3\.000,00, a cada 3 meses/);
});

test('[NEGFULL-3] EDITAR e PERDER no servidor real: o PATCH leva só o que mudou, o histórico guarda de/para, perder exige o motivo, e reabrir é do ADMIN (o COMMERCIAL_CLOSER não vê a ação e o servidor real recusa com 403)', async (t) => {
  const s = await subir(t);
  const cliente = (await s.chamar(BRENO, 'GET', '/api/crm')).json.items.find((item) => item.empresa === 'Clínica Beta');
  const criada = await s.chamar(BRENO, 'POST', '/api/negotiations', { crmRecordId: cliente.id, funnelId: s.ids.funil, serviceId: s.ids.site, prazoMeses: 6, formaPagamento: 'UNICO', valorNegociado: 6000 });
  assert.equal(criada.status, 201);
  await clicar(s, botaoDaTela(s, 'refresh'));
  assert.equal(cartoes(s).length, 1, 'o quadro relido mostra a negociação criada por outra via');
  // editar só o valor
  await clicar(s, tituloDe(s, 'Clínica Beta'));
  await clicar(s, doModal(s, 'detail-edit'));
  digitar(s, campo(s, 'valorNegociado'), '5.500,00');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  const patch = escritas(s).find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body, { valorNegociado: 5500 }, 'só o valor: nada de prazo, forma de pagamento ou serviço');
  assert.equal(negociacoesNoArquivo(s)[0].valorNegociado, 5500);
  assert.match(texto(s).split(NBSP).join(' '), /TCV R\$ 5\.500,00/);
  await clicar(s, tituloDe(s, 'Clínica Beta'));
  assert.match(modal(s).textContent.split(NBSP).join(' '), /Valor negociado: de R\$ 6\.000,00 para R\$ 5\.500,00/);
  // perder: motivo obrigatório
  await clicar(s, doModal(s, 'detail-lose'));
  await clicar(s, botao(s, 'Marcar como perdida', confirmacao(s)));
  assert.match(confirmacao(s).textContent, /Informe o motivo da perda\./);
  assert.equal(escritas(s).filter((c) => c.path.endsWith('/lose')).length, 0);
  digitar(s, s.browser.by.id(s.browser.root, 'negotiation-lose-reason'), 'Sem orçamento este ano');
  await clicar(s, botao(s, 'Marcar como perdida', confirmacao(s)));
  assert.equal(negociacoesNoArquivo(s)[0].situacao, 'PERDIDA');
  assert.equal(negociacoesNoArquivo(s)[0].motivoPerda, 'Sem orçamento este ano');
  assert.match(modal(s).textContent, /Motivo da perdaSem orçamento este ano/);
  // o ADMIN pode reabrir (confirmação); o closer não vê a ação e o servidor recusa
  const id = negociacoesNoArquivo(s)[0].id;
  const recusa = await s.chamar(RAFAEL, 'POST', `/api/negotiations/${encodeURIComponent(id)}/reopen`, {});
  assert.equal(recusa.status, 403);
  assert.equal(negociacoesNoArquivo(s)[0].situacao, 'PERDIDA', 'a recusa não mudou nada');
  await clicar(s, doModal(s, 'detail-reopen'));
  await clicar(s, botao(s, 'Reabrir', confirmacao(s)));
  assert.equal(negociacoesNoArquivo(s)[0].situacao, 'ABERTA');
  assert.match(modal(s).textContent, /Reaberta \(estava perdida\)\./);
});

test('[NEGFULL-4] O COMMERCIAL_CLOSER no servidor real: vê o quadro e abre negociações, mas não reabre, não vê a Gestão de Funis (sem acesso, e o 403 real nas rotas de estrutura) e a lista de funis do quadro é só leitura', async (t) => {
  const s = await subir(t, { usuario: RAFAEL });
  assert.equal(s.browser.by.cls(principal(s), 'funnel-column').length, 3, 'o closer lê o quadro (READ:CRM)');
  assert.ok(botaoDaTela(s, 'new'), 'e abre negociações (PROPOSE:CRM)');
  await clicar(s, botaoDaTela(s, 'new'));
  escolherCliente(s, 'Clínica Beta');
  escolherServico(s, 'Site institucional');
  await clicar(s, campo(s, 'formaPagamento-unico'));
  await clicar(s, campo(s, 'prazo-6'));
  digitar(s, campo(s, 'valorNegociado'), '6.000,00');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.equal(cartoes(s).length, 1);
  assert.match(coluna(s, 0).textContent, /Responsável: Rafael Closer/);
  // a estrutura é do ADMIN: a rota real recusa e a tela diz "sem acesso" sem chamar nada
  assert.equal((await s.chamar(RAFAEL, 'GET', '/api/funnels')).status, 403);
  assert.equal((await s.chamar(RAFAEL, 'POST', '/api/funnels', { nome: 'Intruso' })).status, 403);
  const antes = s.fetchImpl.calls.length;
  await ir(s, '#/crm/configuracoes/funis');
  assert.match(texto(s), /Esta conta não possui acesso a esta área\./);
  assert.equal(s.fetchImpl.calls.length, antes, 'nenhuma chamada para a estrutura');
  // o Dashboard Comercial (READ:CRM) funciona para o closer
  await ir(s, '#/crm/dashboard');
  assert.match(texto(s), /Em negociação/);
  assert.match(texto(s), /Negociações1/);
  const abertas = s.browser.find(principal(s), (el) => el.localName === 'section' && el.getAttribute('data-group') === 'abertas').textContent.replace(/\s+/g, ' ').split(NBSP).join(' ');
  assert.match(abertas, /TCV \(valor total dos contratos\)R\$ 6\.000,00/);
  assert.match(abertas, /MRR \(receita recorrente mensal\)R\$ 0,00/);
});

test('[NEGFULL-5] GESTÃO DE FUNIS E ETAPAS no servidor real (ADMIN): criar funil e etapas, reordenar, renomear, desativar e excluir pelo painel; um funil/etapa com cartão NUNCA é excluído (a tela explica e o 409 real confirma)', async (t) => {
  const s = await subir(t, { hash: '#/crm/configuracoes/funis' });
  assert.match(texto(s), /Gestão de Funis e Etapas/);
  const nomesDeEtapas = () => s.browser.findAll(principal(s), (el) => /\bfunnel-admin-stage-name\b/.test(el.className)).map((el) => el.textContent);
  assert.deepEqual(nomesDeEtapas(), ['Contato', 'Proposta', 'Fechamento']);
  // novo funil pelo painel
  await clicar(s, s.browser.find(principal(s), (el) => el.getAttribute('data-action') === 'funnel-new'));
  digitar(s, s.browser.by.id(s.browser.root, 'funnel-admin-nome'), 'Pós-venda');
  await clicar(s, botao(s, 'Criar funil', formulario(s)));
  const criado = respostas(s, '/api/funnels').find((r) => r.method === 'POST');
  assert.equal(criado.status, 201);
  assert.match(texto(s), /Pós-venda/);
  assert.match(texto(s), /Este funil ainda não tem etapas\./);
  // nova etapa no funil novo
  await clicar(s, s.browser.find(principal(s), (el) => el.getAttribute('data-action') === 'stage-new'));
  digitar(s, s.browser.by.id(s.browser.root, 'funnel-admin-nome'), 'Onboarding');
  await clicar(s, botao(s, 'Criar etapa', formulario(s)));
  assert.deepEqual(nomesDeEtapas(), ['Onboarding']);
  // excluir a etapa vazia e o funil vazio
  await clicar(s, s.browser.find(principal(s), (el) => el.getAttribute('data-action') === 'stage-delete'));
  await clicar(s, botao(s, 'Excluir etapa', confirmacao(s)));
  assert.deepEqual(nomesDeEtapas(), []);
  await clicar(s, s.browser.find(principal(s), (el) => el.getAttribute('data-action') === 'funnel-delete'));
  await clicar(s, botao(s, 'Excluir funil', confirmacao(s)));
  assert.equal(s.browser.findAll(principal(s), (el) => el.localName === 'button' && el.hasAttribute('data-funnel')).length, 1, 'só o funil Vendas ficou');
  // reordenar no funil que ficou: Proposta sobe
  const linha = (nome) => s.browser.find(principal(s), (el) => el.localName === 'li' && /\bfunnel-admin-stage\b/.test(el.className) && el.textContent.startsWith(nome));
  await clicar(s, s.browser.find(linha('Proposta'), (el) => el.getAttribute('data-action') === 'stage-up'));
  assert.deepEqual(nomesDeEtapas(), ['Proposta', 'Contato', 'Fechamento']);
  const lista = (await s.chamar(BRENO, 'GET', `/api/funnels/${encodeURIComponent(s.ids.funil)}/stages`)).json.items;
  assert.deepEqual(lista.map((e) => e.nome), ['Proposta', 'Contato', 'Fechamento'], 'persistido no servidor');
  // a negociação nova entra na PRIMEIRA etapa (agora Proposta, depois de reordenar): explicação na tela e 409 real no servidor
  const cliente = (await s.chamar(BRENO, 'GET', '/api/crm')).json.items[0];
  const criada = await s.chamar(BRENO, 'POST', '/api/negotiations', { crmRecordId: cliente.id, funnelId: s.ids.funil, serviceId: s.ids.site, prazoMeses: 6, formaPagamento: 'UNICO', valorNegociado: 6000 });
  assert.equal(criada.status, 201);
  await ir(s, '#/crm/configuracoes/servicos');
  await ir(s, '#/crm/configuracoes/funis');
  assert.match(linha('Proposta').textContent, /1 cartão/);
  assert.match(linha('Contato').textContent, /0 cartões/);
  const apagadas = escritas(s).filter((c) => c.method === 'DELETE').length;
  await clicar(s, s.browser.find(linha('Proposta'), (el) => el.getAttribute('data-action') === 'stage-delete'));
  assert.match(confirmacao(s).textContent, /1 cartão está nesta etapa, por isso ela não pode ser excluída\./);
  assert.equal(escritas(s).filter((c) => c.method === 'DELETE').length, apagadas, 'a tela explicou e não enviou');
  await clicar(s, botao(s, 'Entendi', confirmacao(s)));
  const direto = await s.chamar(BRENO, 'DELETE', `/api/funnel-stages/${encodeURIComponent(lista[0].id)}`, {});
  assert.equal(direto.status, 409, 'o servidor real recusa de verdade');
  const funilDireto = await s.chamar(BRENO, 'DELETE', `/api/funnels/${encodeURIComponent(s.ids.funil)}`, {});
  assert.equal(funilDireto.status, 409);
  assert.equal(negociacoesNoArquivo(s).length, 1, 'a negociação continua intacta');
  semLixo(s);
});
