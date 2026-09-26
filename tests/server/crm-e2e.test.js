// CRM ponta a ponta, num só encadeamento, sobre o código REAL (sem doubles de serviço):
//
//   POST /api/prospecting/submit -> lote + Approval Queue -> aprovação/rejeição humana -> promoção -> CRM -> status -> histórico -> DNC
//
// O que este arquivo acrescenta aos testes por rota (prospecting-api, promotion-api, crm-api, dashboard-*) e ao funil comercial
// (crm-commercial-flow): os passos ENCADEADOS. Cada rota já é provada sozinha; aqui o que sai de um passo é a entrada do seguinte, no mesmo
// ambiente, e o que um usuário não pode fazer (COMMERCIAL_CLOSER, inativo, sem token) é conferido em cada elo. O Dashboard é exercido sobre
// o MESMO estado, pela API real. Também prova que a composição de produção (src/server/index.js createServer) liga as mesmas peças.
//
// SOMENTE dados sintéticos (example.test). Fila, CRM, lotes e dossiês vivem num diretório temporário próprio, removido no fim de cada
// teste (a remoção é conferida). Nenhum caminho de data/ é usado: todo caminho é passado explicitamente. Nenhum navegador, credencial
// ou rede reais: a autenticação usa o adapter REAL do Supabase contra um fetch falso só na borda de rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { createServer } = require('../../src/server/index');
const { createBrowser } = require('../helpers/fakeDom');
const { FAKE_ENV, fakeAccessToken, installFakeSupabaseAuth, supabaseUserBody } = require('../helpers/authFixtures');
const { montarAmbiente, novaFila, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');

const CONFIG = { supabaseUrl: FAKE_ENV.SUPABASE_URL, supabaseAnonKey: FAKE_ENV.SUPABASE_ANON_KEY };
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const enc = encodeURIComponent;
const lerJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function requisicao({ method, url, token, body }) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = {};
  if (token) req.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) req.headers['content-type'] = 'application/json';
  return req;
}
const chamador = (app, tokenDe) => async (usuario, method, url, body) => {
  const resposta = await app.handle(requisicao({ method, url, token: usuario ? tokenDe(usuario) : undefined, body }));
  let json = null;
  try {
    json = JSON.parse(resposta.body);
  } catch {
    // corpo que não é JSON
  }
  return { status: resposta.status, json, text: resposta.body };
};

const ev = (valor) => ({ valor, fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' });
const achado = (empresa, slug, telefone) => ({
  empresa,
  tipo: 'clínica',
  cidade: 'Petrópolis',
  estado: 'RJ',
  nicho: 'Psicologia',
  campos: { site: [ev(`${slug}.example.test`)], instagram: [ev(`@${slug.replace(/-/g, '_')}`)], telefone: [ev(telefone)] },
  fontes: [`https://${slug}.example.test`],
});
const achadoFraco = (empresa, slug) => ({ empresa, cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos: { site: [{ valor: `${slug}.example.test`, fonte: 'Busca', tipoFonte: 'SECUNDARIA' }] }, fontes: ['https://busca.example.test'] });
const corpoDeSubmissao = (achados, quantidade = 3) => ({ briefing: { nicho: 'Psicologia', quantidadeDesejada: quantidade, regiao: 'Petrópolis/RJ' }, rawFindings: achados });

function ambienteVazio(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-e2e-'));
  let removido = false;
  const limpar = () => {
    if (!removido) fs.rmSync(dir, { recursive: true, force: true });
    removido = true;
  };
  t.after(limpar);
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL, EX_COLABORADOR], crm: true, integracao: true, prospeccao: true, crmFilePath: path.join(dir, 'crm.json'), queue: { filePath: path.join(dir, 'approval-queue.json'), ids: {} } });
  return { env, dir, limpar, chamar: chamador(env.app, (usuario) => env.tokenFor(usuario.userId)) };
}

// ===========================================================================
// 1. O CICLO INTEIRO, pela API real, do submit ao DNC
// ===========================================================================
test('[E2E-1] submit -> fila -> aprovação -> promoção -> CRM -> status -> histórico -> DNC, encadeados, com ADMIN e COMMERCIAL_CLOSER — e o ambiente temporário some no fim', async (t) => {
  const { env, dir, limpar, chamar } = ambienteVazio(t);
  const crmArquivo = env.crmFilePath;
  const filaArquivo = env.filePath;
  const registrosNoDisco = () => (fs.existsSync(crmArquivo) ? createJsonFileCrmRepository(crmArquivo).list() : []);
  const naFila = () => (fs.existsSync(filaArquivo) ? lerJson(filaArquivo).items : {});

  // --- 0. tudo vazio ---------------------------------------------------------------------------------------------------------------
  let r = await chamar(BRENO, 'GET', '/api/crm');
  assert.deepEqual([r.status, r.json], [200, { items: [] }], 'CRM vazio');
  assert.equal(fs.existsSync(crmArquivo), false, 'ler o CRM vazio não cria o arquivo');
  r = await chamar(BRENO, 'GET', '/api/approvals');
  assert.deepEqual([r.status, r.json.items], [200, []], 'fila vazia');

  // --- 1. sementes no CRM (só pela API): um registro ativo e um bloqueado (DNC) ---------------------------------------------------
  r = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Clínica Existente Teste', site: 'existente.example.test', telefone: '24 98765-2001', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia' });
  assert.equal(r.status, 201);
  const existenteId = r.json.item.id;
  r = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Clínica Bloqueada Teste', site: 'bloqueada.example.test', telefone: '24 98765-2002', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia' });
  assert.equal(r.status, 201);
  r = await chamar(BRENO, 'POST', `/api/crm/${enc(r.json.item.id)}/dnc`, { reason: 'Pediu para não ser contatado (teste)' });
  assert.deepEqual([r.status, r.json.item.status], [200, 'DO_NOT_CONTACT']);
  assert.equal(registrosNoDisco().length, 2);

  // --- 2. POST /api/prospecting/submit ---------------------------------------------------------------------------------------------
  assert.deepEqual([fs.existsSync(filaArquivo), fs.existsSync(env.batchPath)], [false, false]);
  r = await chamar(RAFAEL, 'POST', '/api/prospecting/submit', corpoDeSubmissao([achado('Clínica Alfa Teste', 'alfa-teste', '(24) 98765-1001')]));
  assert.equal(r.status, 403, 'o closer não propõe prospecção');
  assert.deepEqual([fs.existsSync(filaArquivo), fs.existsSync(env.batchPath)], [false, false], 'nada foi gravado');
  assert.equal((await chamar(null, 'POST', '/api/prospecting/submit', corpoDeSubmissao([]))).status, 401);

  const crmAntesDoSubmit = fs.readFileSync(crmArquivo, 'utf8');
  r = await chamar(BRENO, 'POST', '/api/prospecting/submit', corpoDeSubmissao([
    achado('Clínica Alfa Teste', 'alfa-teste', '(24) 98765-1001'),
    achado('Clínica Beta Teste', 'beta-teste', '(24) 98765-1002'),
    achado('Clínica Gama Teste', 'gama-teste', '(24) 98765-1003'),
    achadoFraco('Clínica Fraca Teste', 'fraca-teste'),
    achado('Clínica Existente Teste', 'existente', '(24) 98765-2001'), // já no CRM (site e telefone iguais)
    achado('Clínica Bloqueada Teste', 'bloqueada', '(24) 98765-2002'), // DNC no CRM
    achado('Clínica Alfa Teste', 'alfa-teste', '(24) 98765-1001'), // repetida na própria submissão
  ], 3));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const lote = r.json;
  assert.match(lote.loteId, /^lote:/);
  assert.equal(lote.criadoPor.userId, BRENO.userId, 'o autor é a identidade do token');
  assert.equal(lote.contagens.encontrados, 6, '7 enviados, 1 repetido na própria submissão');
  assert.equal(lote.contagens.dnc, 1, 'o registro em DO_NOT_CONTACT foi contado como DNC');
  assert.equal(lote.contagens.duplicados, 1, 'o que já está no CRM foi contado como duplicado');
  assert.equal(lote.contagens.dadosInsuficientes, 1);
  assert.equal(lote.repetidosNaSubmissao, 1);
  assert.deepEqual([...lote.prospectIds].sort(), ['id:alfa-teste.example.test', 'id:beta-teste.example.test', 'id:gama-teste.example.test']);
  assert.equal(fs.readFileSync(crmArquivo, 'utf8'), crmAntesDoSubmit, 'submeter nunca escreve no CRM');
  assert.ok(lerJson(env.batchPath)[lote.loteId], 'o lote foi gravado');
  const [alfa, beta, gama] = ['alfa', 'beta', 'gama'].map((s) => `id:${s}-teste.example.test`);
  assert.deepEqual(Object.keys(naFila()).sort(), [alfa, beta, gama].sort(), 'só os elegíveis entraram na fila (DNC, duplicado e dados insuficientes não)');
  for (const id of [alfa, beta, gama]) assert.equal(naFila()[id].estado, 'AGUARDANDO_REVISAO');

  // --- 3. Approval Queue: leitura e decisão humana -----------------------------------------------------------------------------------
  r = await chamar(RAFAEL, 'GET', '/api/approvals');
  assert.equal(r.status, 200, 'o closer lê a fila (revisão faz parte do papel dele)');
  assert.equal(r.json.items.length, 3);
  r = await chamar(BRENO, 'POST', `/api/approvals/${enc(alfa)}/reject`, {});
  assert.equal(r.status, 400, 'rejeitar exige motivo');
  assert.equal(naFila()[alfa].estado, 'AGUARDANDO_REVISAO');
  r = await chamar(BRENO, 'POST', `/api/approvals/${enc(alfa)}/approve`, { reason: 'Conferido (teste)' });
  assert.deepEqual([r.status, r.json.item.estado], [200, 'APROVADO_PARA_CRM']);
  r = await chamar(BRENO, 'POST', `/api/approvals/${enc(beta)}/reject`, { reason: 'Fora do perfil (teste)' });
  assert.deepEqual([r.status, r.json.item.estado], [200, 'REJEITADO']);
  r = await chamar(BRENO, 'POST', `/api/approvals/${enc(alfa)}/approve`, {});
  assert.deepEqual([r.status, r.json.error.code], [409, 'ALREADY_DECIDED'], 'decidir de novo o que já foi decidido');
  assert.equal(registrosNoDisco().length, 2, 'aprovar e rejeitar não criam nada no CRM');

  // --- 4. Promoção -------------------------------------------------------------------------------------------------------------------
  const promover = (usuario, id) => chamar(usuario, 'POST', `/api/approvals/${enc(id)}/promote`, {});
  for (const [id, motivo] of [[beta, 'rejeitado'], [gama, 'pendente']]) {
    r = await promover(BRENO, id);
    assert.deepEqual([r.status, r.json.error.code], [409, 'PROMOTION_NOT_APPROVED'], `${motivo} não promove`);
  }
  assert.equal((await promover(BRENO, 'id:nao-existe.example.test')).status, 404);
  r = await promover(RAFAEL, alfa);
  assert.deepEqual([r.status, r.json.error.code], [403, 'FORBIDDEN'], 'o closer não promove');
  assert.equal((await promover(null, alfa)).status, 401);
  assert.equal((await promover(EX_COLABORADOR, alfa)).status, 403, 'usuário inativo');
  assert.equal(registrosNoDisco().length, 2, 'nenhuma tentativa indevida criou registro');

  r = await promover(BRENO, alfa);
  assert.deepEqual([r.status, r.json.outcome, r.json.prospectId], [200, 'CRIADO', alfa]);
  const alfaCrmId = r.json.crmRecordId;
  assert.match(alfaCrmId, /^crm:/);
  const [r1, r2] = await Promise.all([promover(BRENO, alfa), promover(BRENO, alfa)]);
  for (const x of [r1, r2]) assert.deepEqual([x.status, x.json.outcome, x.json.crmRecordId], [200, 'JA_PROMOVIDO', alfaCrmId]);
  assert.equal(registrosNoDisco().length, 3, 'exatamente um registro novo (repetir e clicar duas vezes não duplica)');

  // --- 5. o registro criado no CRM ---------------------------------------------------------------------------------------------------
  r = await chamar(BRENO, 'GET', `/api/crm/${enc(alfaCrmId)}`);
  assert.equal(r.status, 200);
  const lead = r.json.item;
  assert.equal(lead.status, 'PROSPECT', 'status inicial');
  assert.equal(lead.empresa, 'Clínica Alfa Teste');
  assert.equal(lead.site, 'alfa-teste.example.test');
  assert.equal(lead.telefone, '(24) 98765-1001');
  assert.equal(lead.instagram, '@alfa_teste');
  assert.equal([lead.cidade, lead.estado, lead.nicho].join('|'), 'Petrópolis|RJ|Psicologia');
  assert.equal(lead.historico.length, 1);
  assert.deepEqual([lead.historico[0].from, lead.historico[0].to, lead.historico[0].actor], [null, 'PROSPECT', 'HUMAN']);
  assert.equal(lead.historico[0].reviewedBy.userId, BRENO.userId, 'quem promoveu é o dono do token');
  assert.match(lead.historico[0].motivo, /Promovido da Approval Queue/);
  assert.equal(naFila()[alfa].estado, 'APROVADO_PARA_CRM');
  assert.equal(naFila()[alfa].promocao.crmRecordId, alfaCrmId, 'a fila guarda a ligação com o registro');

  // --- 6. proteção contra duplicação ---------------------------------------------------------------------------------------------------
  r = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Outro Nome Teste', site: 'alfa-teste.example.test' });
  assert.deepEqual([r.status, r.json.error.code], [409, 'DUPLICATE_RECORD'], 'criar com a identidade de um registro existente');
  assert.equal((await chamar(BRENO, 'POST', `/api/approvals/${enc(gama)}/approve`, {})).status, 200);
  r = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Registro Manual Gama', site: 'gama-teste.example.test' });
  assert.equal(r.status, 201);
  const total = registrosNoDisco().length;
  r = await promover(BRENO, gama);
  assert.equal(r.status, 409, 'a identidade do prospect passou a existir no CRM depois da submissão: a promoção recusa');
  assert.equal(registrosNoDisco().length, total, 'a promoção duplicada não criou registro');

  // --- 7. o closer: lê, mas não escreve ---------------------------------------------------------------------------------------------------
  const antesCloser = fs.readFileSync(crmArquivo, 'utf8');
  for (const url of ['/api/crm', `/api/crm/${enc(alfaCrmId)}`, `/api/crm/${enc(alfaCrmId)}/history`]) assert.equal((await chamar(RAFAEL, 'GET', url)).status, 200, url);
  for (const [method, url, body] of [
    ['POST', '/api/crm', { empresa: 'Closer Não Cria Teste' }],
    ['PATCH', `/api/crm/${enc(alfaCrmId)}`, { nicho: 'Outro' }],
    ['POST', `/api/crm/${enc(alfaCrmId)}/status`, { to: 'CONTACTED' }],
    ['POST', `/api/crm/${enc(alfaCrmId)}/dnc`, {}],
  ]) {
    r = await chamar(RAFAEL, method, url, body);
    assert.deepEqual([r.status, r.json.error.code], [403, 'FORBIDDEN'], `${method} ${url}`);
  }
  assert.equal(fs.readFileSync(crmArquivo, 'utf8'), antesCloser, 'o arquivo do CRM não mudou um byte');

  // --- 8. status e histórico -----------------------------------------------------------------------------------------------------------
  r = await chamar(BRENO, 'POST', `/api/crm/${enc(alfaCrmId)}/status`, { to: 'CONTACTED', reason: 'Primeiro contato (teste)' });
  assert.deepEqual([r.status, r.json.item.status], [200, 'CONTACTED']);
  assert.equal((await chamar(BRENO, 'POST', `/api/crm/${enc(alfaCrmId)}/status`, { to: 'NAO_EXISTE' })).status, 400);
  r = await chamar(BRENO, 'GET', `/api/crm/${enc(alfaCrmId)}/history`);
  assert.deepEqual(r.json.historico.map((h) => `${h.from}>${h.to}`), ['null>PROSPECT', 'PROSPECT>CONTACTED']);
  assert.equal(r.json.historico[1].motivo, 'Primeiro contato (teste)');
  assert.equal(r.json.historico[1].reviewedBy.userId, BRENO.userId);
  assert.equal((await chamar(BRENO, 'GET', '/api/crm')).json.items.find((i) => i.id === alfaCrmId).status, 'CONTACTED', 'a lista reflete o status novo');

  // --- 9. DNC ----------------------------------------------------------------------------------------------------------------------------
  r = await chamar(BRENO, 'POST', `/api/crm/${enc(alfaCrmId)}/dnc`, { reason: 'Pediu para sair da lista (teste)' });
  assert.deepEqual([r.status, r.json.item.status], [200, 'DO_NOT_CONTACT']);
  r = await chamar(BRENO, 'PATCH', `/api/crm/${enc(alfaCrmId)}`, { nicho: 'Outro' });
  assert.deepEqual([r.status, r.json.error.code], [409, 'RECORD_LOCKED'], 'DNC é terminal: não edita');
  r = await chamar(BRENO, 'POST', `/api/crm/${enc(alfaCrmId)}/status`, { to: 'PROSPECT' });
  assert.deepEqual([r.status, r.json.error.code], [409, 'INVALID_TRANSITION'], 'nem muda de status');
  r = await chamar(BRENO, 'GET', `/api/crm/${enc(alfaCrmId)}/history`);
  assert.deepEqual(r.json.historico.map((h) => h.to), ['PROSPECT', 'CONTACTED', 'DO_NOT_CONTACT']);
  const filaAntes = Object.keys(naFila()).length;
  r = await chamar(BRENO, 'POST', '/api/prospecting/submit', corpoDeSubmissao([achado('Clínica Alfa Teste', 'alfa-teste', '(24) 98765-1001')], 1));
  assert.equal(r.status, 201);
  assert.equal(r.json.contagens.dnc, 1, 'o DNC vale para a próxima prospecção');
  assert.deepEqual(r.json.prospectIds, []);
  assert.equal(Object.keys(naFila()).length, filaAntes, 'nada novo na fila');
  assert.ok(registrosNoDisco().some((rec) => rec.id === existenteId && rec.status === 'PROSPECT'), 'o registro ativo não foi tocado');

  // --- 10. limpeza garantida -----------------------------------------------------------------------------------------------------------
  limpar();
  assert.equal(fs.existsSync(dir), false, 'o diretório temporário (CRM, fila, lotes, dossiês) foi removido');
});

// ===========================================================================
// 2. autenticação/autorização em cada elo do fluxo
// ===========================================================================
test('[E2E-2] sem token, token inválido e usuário inativo: nenhuma rota do fluxo responde com dado nem grava', async (t) => {
  const { env, chamar } = ambienteVazio(t);
  const seed = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Semente Teste', site: 'semente.example.test' });
  const id = seed.json.item.id;
  const antes = fs.readFileSync(env.crmFilePath, 'utf8');
  const rotas = [
    ['GET', '/api/me'],
    ['GET', '/api/approvals'],
    ['POST', '/api/prospecting/submit', corpoDeSubmissao([])],
    ['POST', `/api/approvals/${enc('id:x.example.test')}/approve`, {}],
    ['POST', `/api/approvals/${enc('id:x.example.test')}/promote`, {}],
    ['GET', '/api/crm'],
    ['POST', '/api/crm', { empresa: 'Sem Token Teste' }],
    ['GET', `/api/crm/${enc(id)}`],
    ['GET', `/api/crm/${enc(id)}/history`],
    ['POST', `/api/crm/${enc(id)}/status`, { to: 'CONTACTED' }],
    ['POST', `/api/crm/${enc(id)}/dnc`, {}],
  ];
  for (const [method, url, body] of rotas) {
    assert.equal((await env.app.handle(requisicao({ method, url, body }))).status, 401, `sem token: ${method} ${url}`);
    assert.equal((await env.app.handle(requisicao({ method, url, body, token: 'token-que-nunca-foi-emitido' }))).status, 401, `token inválido: ${method} ${url}`);
    assert.equal((await chamar(EX_COLABORADOR, method, url, body)).status, 403, `usuário inativo: ${method} ${url}`);
  }
  assert.equal(fs.readFileSync(env.crmFilePath, 'utf8'), antes, 'nada foi gravado');
  assert.equal(fs.existsSync(env.filePath), false, 'a fila nem foi criada');
});

// ===========================================================================
// 3. a composição de PRODUÇÃO (src/server/index.js createServer) — o mesmo fluxo, sem o submit
// ===========================================================================
test('[E2E-3] a composição de produção (createServer) sobre arquivos temporários: aprovar -> promover -> status -> histórico -> DNC, e o closer barrado', async (t) => {
  const fila = novaFila(t); // alfa, beta e uma DNC, em diretório temporário
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-e2e-prod-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usersFile = path.join(dir, 'users.json');
  const usuarios = [BRENO, RAFAEL];
  fs.writeFileSync(usersFile, JSON.stringify(usuarios.map(({ userId, authUserId, name, email, role, status }) => ({ userId, authUserId, name, email, role, status }))));
  const tokens = {};
  const corpos = {};
  usuarios.forEach((u, i) => {
    tokens[u.userId] = fakeAccessToken(`prod-${i}`);
    corpos[tokens[u.userId]] = supabaseUserBody({ authUserId: u.authUserId, email: u.email });
  });
  installFakeSupabaseAuth(t, corpos);
  const crmArquivo = path.join(dir, 'crm.json');
  // O submit fica de fora: a composição de produção usa os caminhos padrão (data/) para lotes e dossiês, que não têm variável de ambiente.
  const { app, usersCount } = createServer({ ...FAKE_ENV, RIO_X7_USERS_FILE: usersFile, RIO_X7_QUEUE_PATH: fila.filePath, RIO_X7_CRM_PATH: crmArquivo });
  assert.equal(usersCount, 2);
  const chamar = chamador(app, (u) => tokens[u.userId]);

  let r = await chamar(BRENO, 'GET', '/api/me');
  assert.deepEqual([r.status, r.json.role], [200, 'ADMIN']);
  assert.equal((await chamar(RAFAEL, 'GET', '/api/me')).json.role, 'COMMERCIAL_CLOSER');
  r = await chamar(BRENO, 'GET', '/api/approvals');
  assert.equal(r.json.items.length, 2, 'os dois aguardando revisão (o bloqueado por DNC nem entrou como pendente)');
  const alfa = fila.ids.alfa;
  assert.equal((await chamar(BRENO, 'POST', `/api/approvals/${enc(alfa)}/approve`, {})).status, 200);
  assert.equal((await chamar(RAFAEL, 'POST', `/api/approvals/${enc(alfa)}/promote`, {})).status, 403);
  assert.equal(fs.existsSync(crmArquivo), false, 'o closer não criou nada');
  r = await chamar(BRENO, 'POST', `/api/approvals/${enc(alfa)}/promote`, {});
  assert.deepEqual([r.status, r.json.outcome], [200, 'CRIADO']);
  const id = r.json.crmRecordId;
  assert.deepEqual([(await chamar(BRENO, 'GET', '/api/crm')).json.items.length, (await chamar(RAFAEL, 'GET', '/api/crm')).json.items.length], [1, 1]);
  assert.equal((await chamar(BRENO, 'POST', `/api/crm/${enc(id)}/status`, { to: 'RESEARCH', reason: 'teste' })).json.item.status, 'RESEARCH');
  assert.equal((await chamar(BRENO, 'GET', `/api/crm/${enc(id)}/history`)).json.historico.length, 2);
  assert.equal((await chamar(BRENO, 'POST', `/api/crm/${enc(id)}/dnc`, {})).json.item.status, 'DO_NOT_CONTACT');
  assert.equal((await chamar(BRENO, 'PATCH', `/api/crm/${enc(id)}`, { nicho: 'x' })).status, 409);
});

// ===========================================================================
// 4. Dashboard sobre o estado real
// ===========================================================================
async function subirPainel(env, usuario, hash = '') {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, bridgeFetch } = await loadFixtures();
  const browser = createBrowser({ hash });
  const bridge = bridgeFetch(env.app);
  const fetchImpl = async (caminho, init) => (caminho === '/config.json' ? new Response(JSON.stringify(CONFIG), { status: 200 }) : bridge(caminho, init));
  fetchImpl.calls = bridge.calls;
  const sdk = createFakeSdk({ session: { access_token: env.tokenFor(usuario.userId), refresh_token: 'refresh-de-teste-nao-real', user: { id: usuario.authUserId } } });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation: browserNavigation(browser.window) });
  await browser.flush(12);
  return { browser, fetchImpl };
}
const tela = (browser) => {
  const texto = browser.root.textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
  return texto;
};
const irPara = async (browser, hash) => {
  browser.window.location.hash = hash;
  await browser.flush(12);
};

test('[E2E-4] Dashboard (ADMIN e closer) sobre o estado real: Visão Geral, CRM (busca, filtro, ficha, histórico, DNC), Aprovações e Central de Agentes', async (t) => {
  const { env, dir, limpar, chamar } = ambienteVazio(t);
  // estado: alfa promovido e em CONTACTED; bloqueado em DNC; beta e gama pendentes na fila
  const sub = await chamar(BRENO, 'POST', '/api/prospecting/submit', corpoDeSubmissao([achado('Clínica Alfa Teste', 'alfa-teste', '(24) 98765-1001'), achado('Clínica Beta Teste', 'beta-teste', '(24) 98765-1002'), achado('Clínica Gama Teste', 'gama-teste', '(24) 98765-1003')]));
  assert.equal(sub.status, 201);
  const alfaFila = 'id:alfa-teste.example.test';
  await chamar(BRENO, 'POST', `/api/approvals/${enc(alfaFila)}/approve`, {});
  const promo = await chamar(BRENO, 'POST', `/api/approvals/${enc(alfaFila)}/promote`, {});
  const alfaId = promo.json.crmRecordId;
  await chamar(BRENO, 'POST', `/api/crm/${enc(alfaId)}/status`, { to: 'CONTACTED', reason: 'Primeiro contato (teste)' });
  const bloq = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Clínica Bloqueada Teste', site: 'bloqueada.example.test', cidade: 'Niterói', estado: 'RJ', nicho: 'Odontologia' });
  await chamar(BRENO, 'POST', `/api/crm/${enc(bloq.json.item.id)}/dnc`, { reason: 'Pediu para não ser contatado (teste)' });

  // ---- ADMIN ----
  const admin = await subirPainel(env, BRENO);
  let texto = tela(admin.browser);
  assert.match(texto, /Bo(m|a) (dia|tarde|noite), Breno Bento/, 'saudação com o usuário do token');
  assert.match(texto, /Leads no CRM\s*2/);
  assert.match(texto, /Aprovações pendentes\s*2/);
  const status = (nome) => admin.browser.by.cls(admin.browser.root, 'pipeline-row').map((li) => [admin.browser.by.cls(li, 'badge')[0].textContent, admin.browser.by.cls(li, 'pipeline-count')[0].textContent]).find(([n]) => n === nome)[1];
  assert.equal(status('Contatado'), '1');
  assert.equal(status('Não Contatar'), '1');

  await irPara(admin.browser, '#/crm');
  texto = tela(admin.browser);
  assert.match(texto, /Clínica Alfa Teste/);
  assert.match(texto, /Clínica Bloqueada Teste/);
  assert.match(texto, /2 registros/);
  admin.browser.type(admin.browser.by.label(admin.browser.root, 'Buscar'), 'alfa');
  texto = tela(admin.browser);
  assert.match(texto, /1 de 2 registros/);
  assert.doesNotMatch(texto, /Clínica Bloqueada Teste/);
  admin.browser.click(admin.browser.by.button(admin.browser.root, 'Limpar filtros') || admin.browser.by.button(admin.browser.root, 'Limpar busca e filtros'));
  admin.browser.choose(admin.browser.by.label(admin.browser.root, 'Status'), 'DO_NOT_CONTACT');
  texto = tela(admin.browser);
  assert.match(texto, /Clínica Bloqueada Teste/);
  assert.doesNotMatch(texto, /Clínica Alfa Teste/);

  await irPara(admin.browser, `#/crm/registro/${enc(alfaId)}`);
  assert.equal(admin.browser.by.tag(admin.browser.root, 'h2')[0].textContent, 'Clínica Alfa Teste');
  texto = tela(admin.browser);
  assert.match(texto, /Contacted/);
  assert.match(texto, /Promovido da Approval Queue/);
  assert.match(texto, /Primeiro contato \(teste\)/);
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar']) assert.ok(admin.browser.by.button(admin.browser.root, botao), `ADMIN vê "${botao}"`);

  await irPara(admin.browser, `#/crm/registro/${enc(bloq.json.item.id)}`);
  assert.match(tela(admin.browser), /bloqueado como "Não contatar"/);
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar']) assert.equal(admin.browser.by.button(admin.browser.root, botao), null, `DNC não mostra "${botao}"`);

  await irPara(admin.browser, '#/aprovacoes');
  texto = tela(admin.browser);
  assert.match(texto, /Clínica Beta Teste/);
  assert.match(texto, /Clínica Gama Teste/);
  assert.doesNotMatch(texto, /Clínica Alfa Teste/, 'o aprovado não está mais entre os pendentes');
  admin.browser.click(admin.browser.by.button(admin.browser.root, 'Aprovados'));
  await admin.browser.flush(12);
  assert.match(tela(admin.browser), /Clínica Alfa Teste/);

  await irPara(admin.browser, '#/agentes');
  assert.equal(admin.browser.by.cls(admin.browser.root, 'agent-card').length, 14);
  assert.match(tela(admin.browser), /Em desenvolvimento/);

  for (const chamada of admin.fetchImpl.calls) {
    assert.doesNotMatch(JSON.stringify(chamada.body || {}), /userId|authUserId|"role"|permissions|reviewedBy|actor/, `${chamada.method} ${chamada.path}: o painel nunca envia identidade nem autorização`);
  }

  // ---- COMMERCIAL_CLOSER: lê, não escreve ----
  const closer = await subirPainel(env, RAFAEL, `#/crm/registro/${enc(alfaId)}`);
  assert.equal(closer.browser.by.tag(closer.browser.root, 'h2')[0].textContent, 'Clínica Alfa Teste');
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar', 'Novo registro']) assert.equal(closer.browser.by.button(closer.browser.root, botao), null, `closer não vê "${botao}"`);
  await irPara(closer.browser, '#/aprovacoes');
  assert.equal(closer.browser.by.button(closer.browser.root, 'Promover para CRM'), null, 'o closer não vê "Promover para CRM"');

  limpar();
  assert.equal(fs.existsSync(dir), false);
});
