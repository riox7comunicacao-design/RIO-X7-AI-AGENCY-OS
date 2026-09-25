// A ação "Promover para CRM" no Dashboard (tela Aprovações — decisão 0016): o cliente de API, a tela e o ciclo completo
// contra o app REAL do servidor.
//
// O que estes testes protegem: o botão só existe para um prospect APROVADO e só para quem pode promover (conveniência —
// o servidor decide); o clique pede confirmação; um clique duplo nunca envia duas requisições; o corpo enviado é vazio
// (nada que decide a promoção sai do navegador); as recusas do servidor (duplicidade, restrição de contato, 403, 500)
// viram frases claras sem nenhum detalhe interno; e "Ver no CRM" usa SÓ o id que o servidor devolveu.
//
// Nenhum dado real: tudo fictício (example.test), fila e CRM em arquivos temporários.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const crm = require('../../src/crm');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { createBrowser } = require('../helpers/fakeDom');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const loadApi = () => import('../../dashboard/api.mjs');
const loadView = () => import('../../dashboard/views/approvals.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };

const PROMOVIDO = 'Prospect promovido para o CRM.';
const JA_PROMOVIDO = 'Este prospect já foi promovido para o CRM.';
const CONFIRMACAO = 'Este prospect será incluído no CRM e poderá entrar no pipeline comercial.';

// A mensagem de status exata (o texto também aparece no detalhe, então olhar só o texto da tela não basta).
const mensagem = (s) => {
  const alvo = s.browser.by.cls(s.browser.root, 'message')[0];
  return alvo ? alvo.textContent : null;
};

const tela = (browser) => {
  const texto = browser.root.textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
  return texto;
};

// ---------------------------------------------------------------------------
// Cliente de API
// ---------------------------------------------------------------------------
async function cliente(responder) {
  const { createApiClient } = await loadApi();
  const chamadas = [];
  const api = createApiClient({
    getAccessToken: async () => 'token-de-teste-nao-real',
    refreshAccessToken: async () => null,
    onSessionLost: () => {},
    fetchImpl: async (caminho, init) => {
      chamadas.push({ caminho, method: init.method, headers: init.headers, body: init.body });
      return responder ? responder(caminho, init) : new Response('{"items":[]}', { status: 200 });
    },
  });
  return { api, chamadas };
}

test('[DASH-PROMO-1] o cliente envia a promoção como POST com o id SÓ na URL (codificado), o token como única identidade e o corpo VAZIO', async () => {
  const { api, chamadas } = await cliente();
  await api.promoteApproval('prospect:abc def/x');
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].method, 'POST');
  assert.equal(chamadas[0].caminho, '/api/approvals/prospect%3Aabc%20def%2Fx/promote');
  assert.equal(chamadas[0].body, '{}');
  assert.equal(chamadas[0].headers.Authorization, 'Bearer token-de-teste-nao-real');
  assert.deepEqual(Object.keys(chamadas[0].headers).sort(), ['Accept', 'Authorization', 'Content-Type']);
});

test('[DASH-PROMO-2] a listagem de aprovações só leva ?estado= quando um estado é pedido; sem ele, é a URL de sempre', async () => {
  const { api, chamadas } = await cliente();
  await api.listApprovals();
  await api.listApprovals('APROVADO_PARA_CRM');
  await api.listApprovals('A B&c');
  assert.deepEqual(
    chamadas.map((chamada) => chamada.caminho),
    ['/api/approvals', '/api/approvals?estado=APROVADO_PARA_CRM', '/api/approvals?estado=A%20B%26c']
  );
});

// ---------------------------------------------------------------------------
// A tela, com uma API falsa
// ---------------------------------------------------------------------------
const aprovado = (id, empresa, extras = {}) => ({
  prospectId: id,
  empresa,
  estado: 'APROVADO_PARA_CRM',
  discoverySnapshot: { cidade: 'Petrópolis', estadoUf: 'RJ', nicho: 'Psicologia' },
  historico: [],
  ...extras,
});
const pendente = (id, empresa) => aprovado(id, empresa, { estado: 'AGUARDANDO_REVISAO' });

function apiFalsa({ pendentes = [], aprovados = [], promover } = {}) {
  const chamadas = [];
  return {
    chamadas,
    listApprovals: async (estado) => {
      chamadas.push(['listApprovals', estado]);
      return { items: estado === 'APROVADO_PARA_CRM' ? aprovados : pendentes };
    },
    promoteApproval: async (id) => {
      chamadas.push(['promoteApproval', id]);
      return promover ? promover(id) : { outcome: 'CRIADO', prospectId: id, crmRecordId: 'crm:11111111-1111-1111-1111-111111111111', possivelDuplicidade: false };
    },
    approve: async () => ({}),
    reject: async () => ({}),
  };
}

async function abrir({ api, canReview = true, canPromote = true, canReadCrm = true, filtro = 'Aprovados', selecionar } = {}) {
  const { createApprovalsView } = await loadView();
  const browser = createBrowser();
  const view = createApprovalsView({ document: browser.document, root: browser.root, api, canReview, canPromote, canReadCrm });
  await view.load();
  await browser.flush();
  if (filtro) {
    browser.click(browser.by.button(browser.root, filtro));
    await browser.flush();
  }
  if (selecionar) {
    browser.click(browser.by.button(browser.root, selecionar));
    await browser.flush();
  }
  return { browser, view };
}

const botao = (s, texto) => s.browser.by.button(s.browser.root, texto);
const clicar = async (s, texto) => {
  const alvo = botao(s, texto);
  assert.ok(alvo, `botão "${texto}" não encontrado`);
  s.browser.click(alvo);
  await s.browser.flush();
};

test('[DASH-PROMO-3] o botão "Promover para CRM" aparece SÓ para um prospect aprovado e SÓ para quem pode promover', async () => {
  const api = () => apiFalsa({ pendentes: [pendente('p1', 'Pendente Teste')], aprovados: [aprovado('a1', 'Aprovada Teste')] });

  const admin = await abrir({ api: api(), selecionar: 'Aprovada Teste' });
  assert.ok(botao(admin, 'Promover para CRM'), 'ADMIN vê o botão no aprovado');

  const closer = await abrir({ api: api(), canPromote: false, selecionar: 'Aprovada Teste' });
  assert.equal(botao(closer, 'Promover para CRM'), null, 'quem não pode promover não vê o botão');
  assert.match(tela(closer.browser), /Sua conta não pode promover prospects para o CRM\./);

  const pendenteAdmin = await abrir({ api: api(), filtro: null, selecionar: 'Pendente Teste' });
  assert.equal(botao(pendenteAdmin, 'Promover para CRM'), null, 'aguardando revisão nunca tem o botão');
  assert.ok(botao(pendenteAdmin, 'Aprovar'));
});

test('[DASH-PROMO-4] rejeitado, duplicado, DNC, dados insuficientes e expirado nunca mostram o botão, mesmo que a lista os traga', async () => {
  for (const estado of ['REJEITADO', 'DUPLICADO', 'DNC', 'DADOS_INSUFICIENTES', 'EXPIRADO']) {
    const s = await abrir({ api: apiFalsa({ aprovados: [aprovado('x1', 'Outro Estado', { estado })] }), selecionar: 'Outro Estado' });
    assert.equal(botao(s, 'Promover para CRM'), null, estado);
  }
});

test('[DASH-PROMO-5] clicar em "Promover para CRM" só pede a confirmação (nenhuma requisição); Cancelar volta sem promover', async () => {
  const api = apiFalsa({ aprovados: [aprovado('a1', 'Aprovada Teste')] });
  const s = await abrir({ api, selecionar: 'Aprovada Teste' });
  await clicar(s, 'Promover para CRM');
  assert.match(tela(s.browser), new RegExp(CONFIRMACAO.replace(/[.]/g, '\\.')));
  assert.ok(botao(s, 'Cancelar'));
  assert.ok(botao(s, 'Promover'));
  assert.equal(api.chamadas.filter(([nome]) => nome === 'promoteApproval').length, 0);
  await clicar(s, 'Cancelar');
  assert.equal(api.chamadas.filter(([nome]) => nome === 'promoteApproval').length, 0);
  assert.ok(botao(s, 'Promover para CRM'));
});

test('[DASH-PROMO-6] confirmar promove: uma requisição só com o id, a mensagem de sucesso e "Ver no CRM" com o id que o SERVIDOR devolveu', async () => {
  const id = 'crm:22222222-2222-2222-2222-222222222222';
  const api = apiFalsa({
    aprovados: [aprovado('a1', 'Aprovada Teste')],
    promover: (prospectId) => ({ outcome: 'CRIADO', prospectId, crmRecordId: id, possivelDuplicidade: false }),
  });
  const s = await abrir({ api, selecionar: 'Aprovada Teste' });
  await clicar(s, 'Promover para CRM');
  await clicar(s, 'Promover');
  assert.deepEqual(api.chamadas.filter(([nome]) => nome === 'promoteApproval'), [['promoteApproval', 'a1']]);
  assert.equal(mensagem(s), PROMOVIDO);
  const link = s.browser.by.link(s.browser.root, 'Ver no CRM');
  assert.ok(link);
  assert.equal(link.href, `#/crm/registro/${encodeURIComponent(id)}`);
  assert.equal(botao(s, 'Promover'), null, 'a confirmação saiu');
});

test('[DASH-PROMO-7] JA_PROMOVIDO: mensagem própria e o mesmo link; possível duplicidade vira um aviso', async () => {
  const id = 'crm:33333333-3333-3333-3333-333333333333';
  const s = await abrir({
    api: apiFalsa({ aprovados: [aprovado('a1', 'Aprovada Teste')], promover: (prospectId) => ({ outcome: 'JA_PROMOVIDO', prospectId, crmRecordId: id, possivelDuplicidade: false }) }),
    selecionar: 'Aprovada Teste',
  });
  await clicar(s, 'Promover para CRM');
  await clicar(s, 'Promover');
  assert.equal(mensagem(s), JA_PROMOVIDO);
  assert.equal(s.browser.by.link(s.browser.root, 'Ver no CRM').href, `#/crm/registro/${encodeURIComponent(id)}`);

  const comSinal = await abrir({
    api: apiFalsa({ aprovados: [aprovado('a1', 'Aprovada Teste')], promover: (prospectId) => ({ outcome: 'CRIADO', prospectId, crmRecordId: id, possivelDuplicidade: true }) }),
    selecionar: 'Aprovada Teste',
  });
  await clicar(comSinal, 'Promover para CRM');
  await clicar(comSinal, 'Promover');
  assert.match(tela(comSinal.browser), /possível duplicidade/);
});

test('[DASH-PROMO-8] um item já promovido (item.promocao vindo da fila) mostra o aviso e "Ver no CRM" — sem o botão de promover; uma promoção BLOQUEADA não conta', async () => {
  const promovido = aprovado('a1', 'Promovida Teste', { promocao: { resultado: 'CRIADO', crmRecordId: 'crm:44444444-4444-4444-4444-444444444444', promovidoEm: '2026-09-25T10:00:00.000Z', promovidoPor: { userId: 'u', name: 'n', role: 'ADMIN' } } });
  const s = await abrir({ api: apiFalsa({ aprovados: [promovido] }), selecionar: 'Promovida Teste' });
  assert.match(tela(s.browser), new RegExp(JA_PROMOVIDO.replace(/[.]/g, '\\.')));
  assert.equal(botao(s, 'Promover para CRM'), null);
  assert.equal(s.browser.by.link(s.browser.root, 'Ver no CRM').href, `#/crm/registro/${encodeURIComponent('crm:44444444-4444-4444-4444-444444444444')}`);

  const bloqueado = aprovado('a2', 'Bloqueada Teste', { promocao: { resultado: 'BLOQUEADO', crmRecordId: 'crm:55555555-5555-5555-5555-555555555555' } });
  const b = await abrir({ api: apiFalsa({ aprovados: [bloqueado] }), selecionar: 'Bloqueada Teste' });
  assert.ok(botao(b, 'Promover para CRM'));
  assert.equal(b.browser.by.link(b.browser.root, 'Ver no CRM'), null);

  const semAcessoAoCrm = await abrir({ api: apiFalsa({ aprovados: [promovido] }), canReadCrm: false, selecionar: 'Promovida Teste' });
  assert.equal(semAcessoAoCrm.browser.by.link(semAcessoAoCrm.browser.root, 'Ver no CRM'), null, 'sem READ:CRM não há o link');
});

test('[DASH-PROMO-9] clique duplo: a requisição sai UMA vez, o botão fica desabilitado e o botão antigo não dispara de novo', async () => {
  let liberar;
  const espera = new Promise((resolve) => {
    liberar = resolve;
  });
  const api = apiFalsa({ aprovados: [aprovado('a1', 'Aprovada Teste')], promover: async (prospectId) => (await espera, { outcome: 'CRIADO', prospectId, crmRecordId: 'crm:66666666-6666-6666-6666-666666666666', possivelDuplicidade: false }) });
  const s = await abrir({ api, selecionar: 'Aprovada Teste' });
  await clicar(s, 'Promover para CRM');
  const confirmar = botao(s, 'Promover');
  s.browser.click(confirmar);
  s.browser.click(confirmar); // o mesmo botão (agora antigo), de novo
  await s.browser.flush();
  const emAndamento = botao(s, 'Promovendo…');
  assert.ok(emAndamento);
  assert.equal(emAndamento.disabled, true);
  s.browser.click(emAndamento);
  assert.equal(api.chamadas.filter(([nome]) => nome === 'promoteApproval').length, 1);
  liberar();
  await s.browser.flush();
  assert.equal(api.chamadas.filter(([nome]) => nome === 'promoteApproval').length, 1);
  assert.match(tela(s.browser), new RegExp(PROMOVIDO.replace(/[.]/g, '\\.')));
});

test('[DASH-PROMO-10] as recusas do servidor viram frases claras: duplicidade, restrição de contato, 403, 404, 500 — sem nenhum detalhe interno', async () => {
  const { ApiError } = await loadApi();
  const casos = [
    [new ApiError(409, 'PROMOTION_BLOCKED_DUPLICATE', 'Este prospect parece já existir no CRM. A promoção foi bloqueada para não duplicar o registro.'), /parece já existir no CRM/],
    [new ApiError(409, 'PROMOTION_BLOCKED_DNC', 'Promoção bloqueada: existe uma restrição de contato para este prospect.'), /restrição de contato/],
    [new ApiError(409, 'PROMOTION_NOT_APPROVED', 'Este prospect não está aprovado para o CRM.'), /não está aprovado/],
    [new ApiError(409, 'OUTRO_CODIGO', 'texto que não é de promoção /caminho/segredo'), /^(?!.*segredo).*A promoção foi bloqueada\./],
    [new ApiError(403, 'FORBIDDEN', 'Esta conta não possui acesso a esta área.'), /Sua conta não pode promover prospects para o CRM\./],
    [new ApiError(404, 'NOT_FOUND', 'Item não encontrado.'), /Este prospect não foi encontrado/],
    [new ApiError(500, 'INTERNAL', 'Erro interno. Tente novamente em instantes.'), /Não foi possível concluir a operação agora/],
    [new ApiError(0, 'NETWORK', ''), /Não foi possível concluir a operação agora/],
  ];
  for (const [erro, esperado] of casos) {
    const api = apiFalsa({
      aprovados: [aprovado('a1', 'Aprovada Teste')],
      promover: () => {
        throw erro;
      },
    });
    const s = await abrir({ api, selecionar: 'Aprovada Teste' });
    await clicar(s, 'Promover para CRM');
    await clicar(s, 'Promover');
    const texto = tela(s.browser);
    assert.match(texto, esperado, `${erro.status} ${erro.code}`);
    assert.doesNotMatch(texto, /stack|Error:|ENOENT|token|authUserId/i);
    assert.equal(s.browser.by.link(s.browser.root, 'Ver no CRM'), null, 'sem sucesso não há link');
  }
});

test('[DASH-PROMO-11] uma resposta inesperada do servidor (sem id, desfecho desconhecido) não vira sucesso nem link', async () => {
  for (const resposta of [{}, null, { outcome: 'CRIADO' }, { outcome: 'CRIADO', crmRecordId: 42 }, { outcome: 'QUALQUER', crmRecordId: 'crm:x' }, 'texto']) {
    const s = await abrir({ api: apiFalsa({ aprovados: [aprovado('a1', 'Aprovada Teste')], promover: () => resposta }), selecionar: 'Aprovada Teste' });
    await clicar(s, 'Promover para CRM');
    await clicar(s, 'Promover');
    const texto = tela(s.browser);
    assert.doesNotMatch(texto, new RegExp(PROMOVIDO.replace(/[.]/g, '\\.')));
    assert.match(texto, /Não foi possível concluir a operação agora/);
    assert.equal(s.browser.by.link(s.browser.root, 'Ver no CRM'), null);
  }
});

test('[DASH-PROMO-12] o id do link é codificado e nunca vira HTML/URL perigosa (id com "/", "?", "<script>")', async () => {
  const id = 'crm:../x?y=<script>alert(1)</script>';
  const s = await abrir({ api: apiFalsa({ aprovados: [aprovado('a1', 'Aprovada Teste')], promover: (prospectId) => ({ outcome: 'CRIADO', prospectId, crmRecordId: id, possivelDuplicidade: false }) }), selecionar: 'Aprovada Teste' });
  await clicar(s, 'Promover para CRM');
  await clicar(s, 'Promover');
  const link = s.browser.by.link(s.browser.root, 'Ver no CRM');
  assert.equal(link.href, `#/crm/registro/${encodeURIComponent(id)}`);
  assert.equal(link.href.includes('<'), false);
  assert.equal(link.href.startsWith('#/crm/registro/'), true);
});

test('[DASH-PROMO-13] o filtro Pendentes/Aprovados: pendentes pedem a lista padrão, aprovados pedem ?estado=APROVADO_PARA_CRM; trocar limpa a seleção', async () => {
  const api = apiFalsa({ pendentes: [pendente('p1', 'Pendente Teste')], aprovados: [aprovado('a1', 'Aprovada Teste')] });
  const s = await abrir({ api, filtro: null });
  assert.match(tela(s.browser), /1 pendente/);
  await clicar(s, 'Aprovados');
  assert.match(tela(s.browser), /1 aprovado/);
  assert.ok(botao(s, 'Aprovada Teste'));
  assert.equal(botao(s, 'Pendente Teste'), null);
  await clicar(s, 'Pendentes');
  assert.ok(botao(s, 'Pendente Teste'));
  assert.deepEqual(api.chamadas.filter(([nome]) => nome === 'listApprovals').map(([, estado]) => estado), [undefined, 'APROVADO_PARA_CRM', undefined]);
});

// ---------------------------------------------------------------------------
// Ponta a ponta: o Dashboard de verdade contra o app REAL (fila, CRM, Services e autorização reais)
// ---------------------------------------------------------------------------
async function subir(t, { usuario = BRENO, hash = '#/aprovacoes', semear } = {}) {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, integracao: true });
  if (semear) semear(env);
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, bridgeFetch } = await loadFixtures();
  const browser = createBrowser({ hash });
  const bridge = bridgeFetch(env.app);
  const fetchImpl = async (path, init) => (path === '/config.json' ? new Response(JSON.stringify(CONFIG), { status: 200 }) : bridge(path, init));
  fetchImpl.calls = bridge.calls;
  fetchImpl.responses = bridge.responses;
  const sdk = createFakeSdk({ session: { access_token: env.tokenFor(usuario.userId), refresh_token: 'refresh-de-teste-nao-real', user: { id: usuario.authUserId } } });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation: browserNavigation(browser.window) });
  await browser.flush();
  return { env, browser, fetchImpl };
}

const registrosDoCrm = (s) => createJsonFileCrmRepository(s.env.crmFilePath).list();
const filaEmDisco = (s) => JSON.parse(fs.readFileSync(s.env.filePath, 'utf8'));
const promocoes = (s) => s.fetchImpl.calls.filter((chamada) => chamada.path.endsWith('/promote'));

async function aprovarPelaTela(s, empresa) {
  await clicar(s, empresa);
  await clicar(s, 'Aprovar');
  await clicar(s, 'Confirmar aprovação');
  assert.match(tela(s.browser), /Prospect aprovado\./);
}

test('[DASH-PROMO-14] ADMIN, ponta a ponta: aprovar -> Aprovados -> Promover -> confirmar -> registro no CRM -> "Ver no CRM" -> de volta: já promovido, sem duplicar', async (t) => {
  const s = await subir(t);
  await aprovarPelaTela(s, 'Consultório Alfa');
  await clicar(s, 'Aprovados');
  await clicar(s, 'Consultório Alfa');
  await clicar(s, 'Promover para CRM');
  assert.match(tela(s.browser), new RegExp(CONFIRMACAO.replace(/[.]/g, '\\.')));
  await clicar(s, 'Promover');

  assert.match(tela(s.browser), new RegExp(PROMOVIDO.replace(/[.]/g, '\\.')));
  const registros = registrosDoCrm(s);
  assert.equal(registros.length, 1);
  assert.equal(registros[0].empresa, 'Consultório Alfa');
  assert.match(registros[0].historico[0].motivo, /Promovido da Approval Queue/);
  assert.equal(registros[0].historico[0].reviewedBy.userId, BRENO.userId, 'quem promoveu é a identidade do token');

  // o que o navegador enviou: uma requisição, corpo vazio, id só na URL
  assert.equal(promocoes(s).length, 1);
  assert.deepEqual(promocoes(s)[0].body, {});
  assert.equal(promocoes(s)[0].path, `/api/approvals/${encodeURIComponent(s.env.ids.alfa)}/promote`);

  // a fila: continua APROVADO_PARA_CRM, com o resumo da promoção
  const item = filaEmDisco(s).items[s.env.ids.alfa];
  assert.equal(item.estado, 'APROVADO_PARA_CRM');
  assert.equal(item.promocao.crmRecordId, registros[0].id);

  // "Ver no CRM" usa o id devolvido pelo servidor e abre o registro real
  const link = s.browser.by.link(s.browser.root, 'Ver no CRM');
  assert.equal(link.href, `#/crm/registro/${encodeURIComponent(registros[0].id)}`);
  s.browser.click(link);
  await s.browser.flush();
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Consultório Alfa');

  // de volta às Aprovações: já promovido, sem botão, e nada de novo no CRM
  s.browser.window.location.hash = '#/aprovacoes';
  await s.browser.flush();
  await clicar(s, 'Aprovados');
  await clicar(s, 'Consultório Alfa');
  assert.match(tela(s.browser), new RegExp(JA_PROMOVIDO.replace(/[.]/g, '\\.')));
  assert.equal(botao(s, 'Promover para CRM'), null);
  assert.equal(promocoes(s).length, 1);
  assert.equal(registrosDoCrm(s).length, 1);
});

test('[DASH-PROMO-15] o closer aprova pela tela mas NÃO vê "Promover para CRM"; e, se forçar a rota, o servidor recusa (403) sem criar nada', async (t) => {
  const s = await subir(t, { usuario: RAFAEL });
  await aprovarPelaTela(s, 'Consultório Alfa');
  await clicar(s, 'Aprovados');
  await clicar(s, 'Consultório Alfa');
  assert.equal(botao(s, 'Promover para CRM'), null);
  assert.match(tela(s.browser), /Sua conta não pode promover prospects para o CRM\./);
  assert.equal(promocoes(s).length, 0);

  // a interface é só conveniência: a mesma chamada, feita à mão com o token do closer, é recusada pelo servidor
  const { createApiClient } = await loadApi();
  const { bridgeFetch } = await loadFixtures();
  const api = createApiClient({ getAccessToken: async () => s.env.tokenFor(RAFAEL.userId), refreshAccessToken: async () => null, onSessionLost: () => {}, fetchImpl: bridgeFetch(s.env.app) });
  await assert.rejects(api.promoteApproval(s.env.ids.alfa), (erro) => erro.status === 403);
  assert.equal(registrosDoCrm(s).length, 0);
});

test('[DASH-PROMO-16] duplicidade e restrição de contato no CRM aparecem como frases claras na tela, e nada é criado', async (t) => {
  const s = await subir(t, {
    semear: (env) => {
      const repositorio = createJsonFileCrmRepository(env.crmFilePath);
      const operador = { actor: 'HUMAN', reviewedBy: { userId: 'user-semente', name: 'Semente', role: 'ADMIN' }, motivo: 'semente do teste' };
      crm.createRecord(repositorio, { empresa: 'Já Existe', site: 'consultorio-alfa.example.test' }, operador);
      const bloqueada = crm.createRecord(repositorio, { empresa: 'Bloqueada', site: 'consultorio-beta.example.test' }, operador).record;
      crm.markDoNotContact(repositorio, bloqueada.id, operador);
    },
  });
  await aprovarPelaTela(s, 'Consultório Alfa');
  await aprovarPelaTela(s, 'Consultório Beta');
  await clicar(s, 'Aprovados');

  await clicar(s, 'Consultório Alfa');
  await clicar(s, 'Promover para CRM');
  await clicar(s, 'Promover');
  assert.match(tela(s.browser), /parece já existir no CRM/);

  await clicar(s, 'Consultório Beta');
  await clicar(s, 'Promover para CRM');
  await clicar(s, 'Promover');
  assert.match(tela(s.browser), /restrição de contato/);

  assert.equal(registrosDoCrm(s).length, 2, 'só os dois registros semeados');
  assert.equal(filaEmDisco(s).items[s.env.ids.alfa].promocao, undefined);
});

test('[DASH-PROMO-17] 404 (o prospect sumiu): a mensagem aparece, a seleção é limpa e a lista é recarregada; 409 também recarrega, mas mantém a seleção', async () => {
  const { ApiError } = await loadApi();
  for (const [status, mantemSelecao] of [[404, false], [409, true]]) {
    const api = apiFalsa({
      aprovados: [aprovado('a1', 'Aprovada Teste')],
      promover: () => {
        throw new ApiError(status, status === 409 ? 'PROMOTION_BLOCKED_DNC' : 'NOT_FOUND', 'Mensagem do servidor.');
      },
    });
    const s = await abrir({ api, selecionar: 'Aprovada Teste' });
    const antes = api.chamadas.filter(([nome]) => nome === 'listApprovals').length;
    await clicar(s, 'Promover para CRM');
    await clicar(s, 'Promover');
    assert.equal(api.chamadas.filter(([nome]) => nome === 'listApprovals').length, antes + 1, `${status}: a lista foi recarregada`);
    assert.equal(botao(s, 'Promover para CRM') !== null, mantemSelecao, `${status}: seleção`);
    assert.ok(mensagem(s), `${status}: a mensagem continua na tela`);
  }
});
