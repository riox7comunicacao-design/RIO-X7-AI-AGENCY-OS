// Testes do adaptador HTTP (src/server/app.js) — a fronteira ÚNICA entre o navegador e o Approval Queue Service.
//
// O que estes testes protegem: o servidor autentica (Bearer -> verifyAccessToken real, contra um Supabase falso só
// na borda de rede) e autoriza pela cadeia já existente (resolveAuthorizationContext -> AuthorizationContext ->
// Service -> domínio) ANTES de qualquer ação; nada que o navegador envia — corpo, query, cabeçalho — determina
// identidade ou permissão; e os erros viram HTTP sem nunca vazar detalhe interno nem o token.
//
// A maioria dos testes chama app.handle(req) diretamente com um `req` fake (um stream.Readable com method/url/
// headers) — sem abrir socket, como pedido. Um pequeno grupo (marcado) sobe um http.Server real de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');

const domain = require('../../src/research-prospector/approvalQueue');
const constants = require('../../src/auth/constants');
const { PERMISSION, createUserStore } = require('../../src/auth');
const { montarAmbiente, novaFila, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json', ...extra };
}

async function readJson(response) {
  return JSON.parse(response.body);
}

// ===========================================================================
// AUTH (1-5)
// ===========================================================================
test('[SRV-AUTH-1] sem Authorization -> 401, em toda rota protegida', async (t) => {
  const { app } = montarAmbiente(t);
  for (const req of [makeRequest({ url: '/api/me' }), makeRequest({ url: '/api/approvals' }), makeRequest({ method: 'POST', url: '/api/approvals/x/approve', headers: jsonHeaders(), body: {} })]) {
    const response = await app.handle(req);
    assert.equal(response.status, 401, req.url);
    assert.equal((await readJson(response)).error.code, 'UNAUTHENTICATED', req.url);
  }
});

test('[SRV-AUTH-2] token inválido -> 401 (cabeçalho malformado e token rejeitado pelo Supabase)', async (t) => {
  const { app } = montarAmbiente(t);
  const malformados = [{ Authorization: 'Bearer' }, { Authorization: 'Basic dXNlcjpwYXNz' }, { Authorization: '' }, {}];
  for (const headers of malformados) {
    const response = await app.handle(makeRequest({ url: '/api/me', headers }));
    assert.equal(response.status, 401, JSON.stringify(headers));
  }
  const rejeitado = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: 'Bearer token-nao-emitido-por-ninguem' } }));
  assert.equal(rejeitado.status, 401);
  assert.equal((await readJson(rejeitado)).error.code, 'UNAUTHENTICATED');
});

test('[SRV-AUTH-3] token válido (identidade REALMENTE verificada), mas sem USER correspondente no store -> 403', async (t) => {
  const { verifiedIdentityFor } = require('../helpers/authFixtures');
  const identidadeOrfa = await verifiedIdentityFor(t, { authUserId: 'auth-orfa-sem-user', email: 'orfa-teste@example.test' });
  const app = require('../../src/server/app').createApp({
    verifyAccessToken: async () => identidadeOrfa, // sempre a mesma identidade verificada, para qualquer token
    userStore: createUserStore([]), // ninguém cadastrado
    approvalQueueService: { listQueue: () => [], approveProspect: () => {}, rejectProspect: () => {} },
    publicConfig: { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'anon-key-teste' },
    staticRoot: __dirname,
  });
  const response = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: 'Bearer qualquer-coisa' } }));
  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).error.code, 'NO_ACCESS');
});

test('[SRV-AUTH-4] usuário INACTIVE -> 403, mesmo com token válido', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO, EX_COLABORADOR] });
  const response = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenFor(EX_COLABORADOR.userId)}` } }));
  assert.equal(response.status, 403);
  assert.equal((await readJson(response)).error.code, 'INACTIVE');
});

test('[SRV-AUTH-5] contexto válido -> sucesso, para ADMIN e para COMMERCIAL_CLOSER', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO, RAFAEL] });
  for (const usuario of [BRENO, RAFAEL]) {
    const response = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenFor(usuario.userId)}` } }));
    assert.equal(response.status, 200, usuario.userId);
  }
});

// ===========================================================================
// ME (6-9)
// ===========================================================================
test('[SRV-ME-6] /api/me devolve a projeção correta (userId, name, role, permissions, status)', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO] });
  const response = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenFor(BRENO.userId)}` } }));
  const body = await readJson(response);
  assert.deepEqual(Object.keys(body).sort(), ['name', 'permissions', 'role', 'status', 'userId']);
  assert.equal(body.userId, BRENO.userId);
  assert.equal(body.name, BRENO.name);
  assert.equal(body.role, BRENO.role);
  assert.equal(body.status, BRENO.status);
  assert.deepEqual([...body.permissions].sort(), [...constants.getRolePermissions(BRENO.role)].sort());
});

test('[SRV-ME-7] /api/me nunca expõe authUserId (nem em nenhum outro campo)', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO] });
  const response = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenFor(BRENO.userId)}` } }));
  assert.ok(!response.body.includes(BRENO.authUserId), 'authUserId não deve aparecer no corpo da resposta');
  assert.ok(!('authUserId' in (await readJson(response))));
});

test('[SRV-ME-8] /api/me nunca expõe o access token', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO] });
  const token = tokenFor(BRENO.userId);
  const response = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${token}` } }));
  assert.ok(!response.body.includes(token));
  assert.ok(!JSON.stringify(response.headers).includes(token));
});

test('[SRV-ME-9] /api/me não aceita identidade enviada pelo cliente: um parâmetro como userId/role na query é recusado (400), nunca influencia a resposta', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO, RAFAEL] });
  for (const query of ['?userId=user-rafael', '?role=ADMIN', '?permissions=MANAGE:USERS', '?authUserId=auth-rafael']) {
    const response = await app.handle(makeRequest({ url: `/api/me${query}`, headers: { Authorization: `Bearer ${tokenFor(RAFAEL.userId)}` } }));
    assert.equal(response.status, 400, query);
    assert.equal((await readJson(response)).error.code, 'INVALID_REQUEST', query);
  }
  // Controle: sem query nenhuma, a mesma chamada funciona e devolve RAFAEL, nunca um valor "emprestado".
  const ok = await readJson(await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenFor(RAFAEL.userId)}` } })));
  assert.equal(ok.userId, RAFAEL.userId);
  assert.equal(ok.role, RAFAEL.role);
});

// ===========================================================================
// APPROVALS (10-21)
// ===========================================================================
test('[SRV-APR-10] listagem autorizada: estado padrão AGUARDANDO_REVISAO, e filtro por estado', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };

  const padrao = await readJson(await app.handle(makeRequest({ url: '/api/approvals', headers: auth })));
  assert.equal(padrao.estado, 'AGUARDANDO_REVISAO');
  assert.deepEqual(padrao.items.map((item) => item.prospectId).sort(), [ids.alfa, ids.beta].sort());

  const dnc = await readJson(await app.handle(makeRequest({ url: '/api/approvals?estado=DNC', headers: auth })));
  assert.deepEqual(dnc.items.map((item) => item.prospectId), [ids.bloqueado]);

  const invalido = await app.handle(makeRequest({ url: '/api/approvals?estado=NAO_EXISTE', headers: auth }));
  assert.equal(invalido.status, 400);

  const paramExtra = await app.handle(makeRequest({ url: '/api/approvals?estado=DNC&pagina=2', headers: auth }));
  assert.equal(paramExtra.status, 400, 'parâmetro desconhecido é recusado');
});

test('[SRV-APR-11] listagem sem a permissão de revisão -> 403, sem tocar na fila (contexto legitimamente emitido, mas sem APPROVE:LEAD_APPROVAL)', async (t) => {
  const { app, tokenFor, filePath } = montarAmbiente(t, { usuarios: [BRENO] });
  const antes = require('node:fs').readFileSync(filePath, 'utf8');
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  try {
    const response = await app.handle(makeRequest({ url: '/api/approvals', headers: { Authorization: `Bearer ${tokenFor(BRENO.userId)}` } }));
    assert.equal(response.status, 403);
    assert.equal((await readJson(response)).error.code, 'FORBIDDEN');
  } finally {
    derivacao.mock.restore();
  }
  assert.equal(require('node:fs').readFileSync(filePath, 'utf8'), antes, 'a fila não foi tocada');
});

test('[SRV-APR-12] aprovação autorizada: persiste, reviewedBy vem do CONTEXTO (nunca de um valor do corpo)', async (t) => {
  const { app, tokenFor, ids, filePath } = montarAmbiente(t, { usuarios: [BRENO] });
  const response = await app.handle(
    makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders({ Authorization: `Bearer ${tokenFor(BRENO.userId)}` }), body: { reason: 'Bom fit' } })
  );
  assert.equal(response.status, 200);
  const { item } = await readJson(response);
  assert.equal(item.estado, 'APROVADO_PARA_CRM');
  const gravado = domain.loadQueueFromDisk(filePath);
  const ultimo = domain.getProspect(gravado, ids.alfa).historico.at(-1);
  assert.deepEqual(ultimo.reviewedBy, { userId: BRENO.userId, name: BRENO.name, role: BRENO.role });
});

test('[SRV-APR-13] rejeição autorizada: persiste e exige motivo (regra do domínio)', async (t) => {
  const { app, tokenFor, ids, filePath } = montarAmbiente(t, { usuarios: [RAFAEL] });
  const response = await app.handle(
    makeRequest({ method: 'POST', url: `/api/approvals/${ids.beta}/reject`, headers: jsonHeaders({ Authorization: `Bearer ${tokenFor(RAFAEL.userId)}` }), body: { reason: 'Fora do ICP' } })
  );
  assert.equal(response.status, 200);
  const gravado = domain.loadQueueFromDisk(filePath);
  const item = domain.getProspect(gravado, ids.beta);
  assert.equal(item.estado, 'REJEITADO');
  assert.deepEqual(item.historico.at(-1).reviewedBy, { userId: RAFAEL.userId, name: RAFAEL.name, role: RAFAEL.role });
});

test('[SRV-APR-14] rejeição sem motivo -> 400, e motivo em branco também', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
  for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
    const response = await app.handle(makeRequest({ method: 'POST', url: `/api/approvals/${ids.beta}/reject`, headers: jsonHeaders(auth), body }));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await readJson(response)).error.code, 'INVALID_REQUEST');
  }
});

test('[SRV-APR-15] propriedades desconhecidas no corpo -> 400 (aprovar e rejeitar)', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
  for (const rota of ['approve', 'reject']) {
    const response = await app.handle(
      makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/${rota}`, headers: jsonHeaders(auth), body: { reason: 'ok', extra: true } })
    );
    assert.equal(response.status, 400, rota);
  }
});

test('[SRV-APR-16] um userId no corpo é recusado (400) e nunca substitui a identidade autenticada: o reviewedBy gravado é sempre o do token', async (t) => {
  const { app, tokenFor, ids, filePath } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
  const forjado = await app.handle(
    makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: { reason: 'ok', userId: 'user-atacante' } })
  );
  assert.equal(forjado.status, 400);

  const legitimo = await app.handle(makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: { reason: 'ok' } }));
  assert.equal(legitimo.status, 200);
  const gravado = domain.getProspect(domain.loadQueueFromDisk(filePath), ids.alfa);
  assert.equal(gravado.historico.at(-1).reviewedBy.userId, BRENO.userId);
});

test('[SRV-APR-17] uma role no corpo é recusada (400) e nunca substitui a role do contexto', async (t) => {
  const { app, tokenFor, ids, filePath } = montarAmbiente(t, { usuarios: [RAFAEL] });
  const auth = { Authorization: `Bearer ${tokenFor(RAFAEL.userId)}` };
  const forjado = await app.handle(
    makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: { reason: 'ok', role: 'ADMIN' } })
  );
  assert.equal(forjado.status, 400);

  const legitimo = await app.handle(makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: { reason: 'ok' } }));
  assert.equal(legitimo.status, 200);
  const gravado = domain.getProspect(domain.loadQueueFromDisk(filePath), ids.alfa);
  assert.equal(gravado.historico.at(-1).reviewedBy.role, RAFAEL.role);
});

test('[SRV-APR-18] permissions no corpo ou na query nunca dispensam a autorização real: são recusadas como campo desconhecido (400) ANTES de qualquer decisão de autorização, e um contexto sem a permissão real segue recusado (403) quando o corpo é válido', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  try {
    const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
    // "permissions" no corpo/na query é um campo desconhecido: nunca chega perto de decidir nada.
    const noCorpo = await app.handle(
      makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: { reason: 'ok', permissions: [PERMISSION.APPROVE_LEAD_APPROVAL] } })
    );
    assert.equal(noCorpo.status, 400);
    const naQuery = await app.handle(makeRequest({ url: '/api/approvals?estado=AGUARDANDO_REVISAO&permissions=APPROVE:LEAD_APPROVAL', headers: auth }));
    assert.equal(naQuery.status, 400);
    // Com um corpo VÁLIDO (só "reason"), o que decide é a permissão real do contexto — que aqui foi reduzida: 403.
    const semCampoExtra = await app.handle(makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: { reason: 'ok' } }));
    assert.equal(semCampoExtra.status, 403);
  } finally {
    derivacao.mock.restore();
  }
});

test('[SRV-APR-19] prospect inexistente -> 404', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
  const response = await app.handle(makeRequest({ method: 'POST', url: '/api/approvals/id%3Anao-existe/approve', headers: jsonHeaders(auth), body: { reason: 'ok' } }));
  assert.equal(response.status, 404);
  assert.equal((await readJson(response)).error.code, 'NOT_FOUND');
});

test('[SRV-APR-20] decisão duplicada -> 409', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
  const primeira = await app.handle(makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: { reason: 'ok' } }));
  assert.equal(primeira.status, 200);
  const segunda = await app.handle(makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/reject`, headers: jsonHeaders(auth), body: { reason: 'mudei de ideia' } }));
  assert.equal(segunda.status, 409);
  assert.equal((await readJson(segunda)).error.code, 'ALREADY_DECIDED');
});

test('[SRV-APR-21] erro inesperado do Service -> 500 sem detalhe interno na RESPOSTA (o log de operação, esse sim, recebe o diagnóstico)', async (t) => {
  const mensagemSensivel = 'ENOENT: /caminho/interno/do/servidor/nao-deveria-vazar-ao-cliente';
  const env = montarAmbiente(t, { usuarios: [BRENO] });
  const app = require('../../src/server/app').createApp({
    verifyAccessToken: env.verifyAccessToken,
    userStore: env.userStore,
    approvalQueueService: {
      listQueue: () => {
        throw new Error(mensagemSensivel);
      },
      approveProspect: () => {},
      rejectProspect: () => {},
    },
    publicConfig: env.publicConfig,
    staticRoot: env.staticRoot,
    log: (linha) => env.logs.push(linha),
  });

  const response = await app.handle(makeRequest({ url: '/api/approvals', headers: { Authorization: `Bearer ${env.tokenFor(BRENO.userId)}` } }));
  assert.equal(response.status, 500);
  assert.equal((await readJson(response)).error.code, 'INTERNAL');
  assert.ok(!response.body.includes(mensagemSensivel), 'a mensagem interna não pode vazar na resposta ao cliente');
  assert.ok(!response.body.includes('caminho/interno'));
  assert.ok(env.logs.some((linha) => linha.startsWith('erro 500')), 'o servidor registra o erro no PRÓPRIO log, para quem opera o sistema');
});

// ===========================================================================
// SECURITY (22-23): o token nunca aparece na resposta nem no log
// ===========================================================================
test('[SRV-SEC-22] o access token nunca aparece em NENHUMA resposta de erro (token ausente, malformado, rejeitado, ou de uma rota inexistente)', async (t) => {
  const { app } = montarAmbiente(t);
  const tokenSuspeito = 'token-secreto-de-teste-que-nao-pode-vazar.parte-b.parte-c';
  const casos = [
    makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenSuspeito}` } }), // rejeitado pelo Supabase falso
    makeRequest({ url: '/rota/que/nao/existe', headers: { Authorization: `Bearer ${tokenSuspeito}` } }),
    makeRequest({ method: 'POST', url: '/api/approvals/x/approve', headers: { Authorization: `Bearer ${tokenSuspeito}` } }), // sem Content-Type
  ];
  for (const req of casos) {
    const response = await app.handle(req);
    assert.ok(response.status >= 400, req.url);
    assert.ok(!response.body.includes(tokenSuspeito), `${req.url}: o token não pode aparecer na resposta`);
    assert.ok(!JSON.stringify(response.headers).includes(tokenSuspeito), `${req.url}: nem em nenhum cabeçalho`);
  }
});

test('[SRV-SEC-23] o cabeçalho Authorization (nem o token) nunca aparece no log do servidor, em nenhum cenário — sucesso, recusa ou erro', async (t) => {
  const { app, tokenFor, ids, logs } = montarAmbiente(t, { usuarios: [BRENO] });
  const tokenReal = tokenFor(BRENO.userId);
  const tokenForjado = 'Bearer token-forjado-nao-deveria-aparecer-em-log-algum';

  await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenReal}` } })); // sucesso
  await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: tokenForjado } })); // recusado
  await app.handle(makeRequest({ url: '/api/me' })); // sem header nenhum
  await app.handle(
    makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders({ Authorization: `Bearer ${tokenReal}` }), body: { reason: 'ok' } })
  ); // sucesso com corpo

  assert.ok(logs.length > 0, 'sanidade: algo foi registrado');
  for (const linha of logs) {
    assert.ok(!linha.includes(tokenReal), `log não pode conter o token real: ${linha}`);
    assert.ok(!linha.toLowerCase().includes('authorization'), `log não pode citar o cabeçalho Authorization: ${linha}`);
    assert.ok(!linha.includes('token-forjado'), `log não pode conter o token forjado: ${linha}`);
  }
});

// ===========================================================================
// Integração com socket REAL (poucos testes: provam a fiação do listener/http.Server, não a lógica de novo)
// ===========================================================================
function startRealServer(t, app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app.listener);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// Um cliente HTTP de verdade (node:http, não fetch): os testes desta seção instalam um `fetch` GLOBAL falso (para o
// Supabase, via installFakeSupabaseAuth), e usar `fetch` aqui para chamar o PRÓPRIO servidor cairia no mesmo mock.
function httpRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('[SRV-HTTP-1] round-trip real: GET /api/me sem token, por um socket de verdade, devolve 401 em JSON', async (t) => {
  const { app } = montarAmbiente(t);
  const baseUrl = await startRealServer(t, app);
  const response = await httpRequest(`${baseUrl}/api/me`);
  assert.equal(response.status, 401);
  assert.equal(response.json().error.code, 'UNAUTHENTICATED');
});

test('[SRV-HTTP-2] round-trip real: login -> listar -> aprovar, por sockets de verdade, com o parser HTTP nativo do Node', async (t) => {
  const { app, tokenFor, ids, filePath } = montarAmbiente(t, { usuarios: [BRENO] });
  const baseUrl = await startRealServer(t, app);
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };

  const me = await httpRequest(`${baseUrl}/api/me`, { headers: auth });
  assert.equal(me.status, 200);
  assert.equal(me.json().userId, BRENO.userId);

  const lista = await httpRequest(`${baseUrl}/api/approvals`, { headers: auth });
  assert.equal(lista.json().items.map((item) => item.prospectId).includes(ids.alfa), true);

  const corpo = JSON.stringify({ reason: 'ok via HTTP real' });
  const aprovar = await httpRequest(`${baseUrl}/api/approvals/${ids.alfa}/approve`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
    body: corpo,
  });
  assert.equal(aprovar.status, 200);
  assert.equal(domain.getProspect(domain.loadQueueFromDisk(filePath), ids.alfa).estado, 'APROVADO_PARA_CRM');
});

test('[SRV-HTTP-3] round-trip real: GET / serve o Dashboard com os cabeçalhos de segurança e o CSP', async (t) => {
  const { app } = montarAmbiente(t);
  const baseUrl = await startRealServer(t, app);
  const response = await httpRequest(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.ok(response.headers['content-security-policy'].includes("default-src 'none'"));
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cache-control'], 'no-cache');
});

// ===========================================================================
// Reforços adicionais (fail-closed em cenários que os 26 itens não nomeiam individualmente, mas a especificação
// de segurança exige): timeout da verificação do token, nenhum backdoor por substring, e-mail/query/corpo com
// role|permissions no /api/approvals, e o campo "reviewedBy" também recusado.
// ===========================================================================
test('[SRV-AUTH-6] um verifyAccessToken que nunca resolve -> 503 (timeout), nunca uma requisição pendurada para sempre', async (t) => {
  const app = require('../../src/server/app').createApp({
    verifyAccessToken: () => new Promise(() => {}), // nunca resolve nem rejeita
    userStore: createUserStore([]),
    approvalQueueService: { listQueue: () => [], approveProspect: () => {}, rejectProspect: () => {} },
    publicConfig: { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'anon-key-teste' },
    staticRoot: __dirname,
    authTimeoutMs: 20,
  });
  const response = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: 'Bearer qualquer' } }));
  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).error.code, 'AUTH_UNAVAILABLE');
});

test('[SRV-AUTH-7] nenhum token "parece" válido por conter um texto como ADMIN/bypass: só o Supabase real decide', async (t) => {
  const { app } = montarAmbiente(t);
  for (const suspeito of ['ADMIN', 'bypass', 'admin-token', 'x-ADMIN-x']) {
    const response = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${suspeito}` } }));
    assert.equal(response.status, 401, suspeito);
  }
});

test('[SRV-APR-22] a listagem também recusa userId/role no corpo… e na QUERY (não só "permissions", já coberto em SRV-APR-18)', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
  for (const query of ['?estado=AGUARDANDO_REVISAO&userId=user-atacante', '?estado=AGUARDANDO_REVISAO&role=ADMIN']) {
    const response = await app.handle(makeRequest({ url: `/api/approvals${query}`, headers: auth }));
    assert.equal(response.status, 400, query);
  }
});

test('[SRV-APR-23] "reviewedBy" no corpo de approve/reject é recusado (400) como qualquer outro campo desconhecido', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
  for (const rota of ['approve', 'reject']) {
    const response = await app.handle(
      makeRequest({
        method: 'POST',
        url: `/api/approvals/${ids.alfa}/${rota}`,
        headers: jsonHeaders(auth),
        body: { reason: 'ok', reviewedBy: { userId: 'user-atacante', name: 'Atacante', role: 'ADMIN' } },
      })
    );
    assert.equal(response.status, 400, rota);
  }
});

test('[SRV-SEC-22b] o access token nunca aparece na resposta mesmo quando o cabeçalho Authorization é malformado demais (comprimento excedido, "quase-Bearer")', async (t) => {
  const { app } = montarAmbiente(t);
  const tokenGigante = 'x'.repeat(9000); // acima de MAX_TOKEN_LENGTH — cai no branch de "match inválido"
  const respostaGigante = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenGigante}` } }));
  assert.equal(respostaGigante.status, 401);
  assert.ok(!respostaGigante.body.includes(tokenGigante.slice(0, 100)));

  const quaseSemEspaco = `BearerXtoken-suspeito-sem-espaco-${'y'.repeat(50)}`;
  const respostaMalformada = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: quaseSemEspaco } }));
  assert.equal(respostaMalformada.status, 401);
  assert.ok(!respostaMalformada.body.includes('token-suspeito-sem-espaco'));
});

test('[SRV-SEC-23b] um erro inesperado cuja MENSAGEM contém o token real: a resposta e o log nunca repetem o token (só a mensagem genérica sai na resposta; o log é limpo)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO] });
  const token = env.tokenFor(BRENO.userId);
  const app = require('../../src/server/app').createApp({
    verifyAccessToken: env.verifyAccessToken,
    userStore: env.userStore,
    approvalQueueService: {
      listQueue: () => {
        throw new Error(`falha ao consultar (token usado: ${token})`); // simula uma lib que ecoa o input no erro
      },
      approveProspect: () => {},
      rejectProspect: () => {},
    },
    publicConfig: env.publicConfig,
    staticRoot: env.staticRoot,
    log: (linha) => env.logs.push(linha),
  });
  const response = await app.handle(makeRequest({ url: '/api/approvals', headers: { Authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 500);
  assert.ok(!response.body.includes(token), 'o token não pode vazar na resposta');
  assert.ok(env.logs.every((linha) => !linha.includes(token)), 'o token também não pode vazar no log, mesmo vindo dentro da mensagem de um erro inesperado');
});

test('[SRV-SHAPE-1] sem Content-Type -> 415 (nunca tenta interpretar o corpo como JSON às cegas)', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const response = await app.handle(
    makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: { Authorization: `Bearer ${tokenFor(BRENO.userId)}` }, body: JSON.stringify({ reason: 'ok' }) })
  );
  assert.equal(response.status, 415);
});

test('[SRV-SHAPE-2] Content-Type: text/html com um corpo JSON válido -> 415 (o tipo declarado é o que conta, não o conteúdo)', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const response = await app.handle(
    makeRequest({
      method: 'POST',
      url: `/api/approvals/${ids.alfa}/approve`,
      headers: { Authorization: `Bearer ${tokenFor(BRENO.userId)}`, 'content-type': 'text/html' },
      body: JSON.stringify({ reason: 'ok' }),
    })
  );
  assert.equal(response.status, 415);
});

test('[SRV-SHAPE-3] um array JSON como corpo -> 400 (o corpo precisa ser um objeto, nunca uma lista) — inclusive uma lista VAZIA, que não tem nenhuma chave desconhecida para outra validação recusar', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const auth = { Authorization: `Bearer ${tokenFor(BRENO.userId)}` };
  const comConteudo = await app.handle(makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: ['reason', 'ok'] }));
  assert.equal(comConteudo.status, 400, 'lista com conteúdo');
  // Uma lista VAZIA não tem chave nenhuma (Object.keys([]) === []), então só a checagem "é um objeto, não uma
  // lista" pode recusá-la — sem ela, o approve trataria isto como "nenhuma opção", e teria sucesso (200).
  const vazia = await app.handle(makeRequest({ method: 'POST', url: `/api/approvals/${ids.alfa}/approve`, headers: jsonHeaders(auth), body: [] }));
  assert.equal(vazia.status, 400, 'lista vazia');
});

test('[SRV-SHAPE-4] um Content-Length DECLARADO maior que o limite é recusado (413) mesmo quando o corpo de verdade é pequeno — a checagem do cabeçalho declarado é ela mesma testada, não só o limite por streaming', async (t) => {
  const { app, tokenFor, ids } = montarAmbiente(t, { usuarios: [BRENO] });
  const corpoPequeno = JSON.stringify({ reason: 'ok' });
  const response = await app.handle(
    makeRequest({
      method: 'POST',
      url: `/api/approvals/${ids.alfa}/approve`,
      headers: jsonHeaders({ Authorization: `Bearer ${tokenFor(BRENO.userId)}`, 'content-length': String(20 * 1024) }), // > MAX_BODY_BYTES (16 KiB), mas o corpo de verdade é minúsculo
      body: corpoPequeno,
    })
  );
  assert.equal(response.status, 413);
});

// ===========================================================================
// Cabeçalhos de segurança e CSP, em TODA resposta (API, estático e erro)
// ===========================================================================
test('[SRV-XSS-1] a Content-Security-Policy é aplicada em toda resposta (sucesso, estático e erro) e restringe script-src ao próprio site e connect-src ao próprio site + ao Supabase configurado (nunca "*")', async (t) => {
  const { FAKE_ENV } = require('../helpers/authFixtures');
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO] });
  const sucesso = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenFor(BRENO.userId)}` } }));
  const erro = await app.handle(makeRequest({ url: '/api/me' }));
  const estatico = await app.handle(makeRequest({ url: '/' }));
  const origemSupabase = new URL(FAKE_ENV.SUPABASE_URL).origin;
  for (const response of [sucesso, erro, estatico]) {
    const csp = response.headers['Content-Security-Policy'];
    assert.ok(csp, 'toda resposta tem CSP');
    assert.ok(csp.includes("script-src 'self'"), 'script-src restrito ao próprio site');
    assert.doesNotMatch(csp, /script-src[^;]*\*/, 'script-src nunca libera qualquer origem');
    assert.doesNotMatch(csp, /connect-src[^;]*\*/, 'connect-src nunca libera qualquer origem');
    assert.ok(csp.includes(`connect-src 'self' ${origemSupabase}`), 'connect-src inclui exatamente o Supabase configurado');
  }
});

test('[SRV-XSS-2] os cabeçalhos de segurança (X-Frame-Options, X-Content-Type-Options, Referrer-Policy...) são aplicados em toda resposta', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO] });
  for (const response of [
    await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenFor(BRENO.userId)}` } })),
    await app.handle(makeRequest({ url: '/rota-inexistente' })),
    await app.handle(makeRequest({ url: '/' })),
  ]) {
    assert.equal(response.headers['X-Frame-Options'], 'DENY');
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(response.headers['Referrer-Policy'], 'no-referrer');
  }
});

test('[SRV-XSS-3] respostas da API (sucesso e erro) são sempre application/json e Cache-Control: no-store (dados de prospect nunca ficam em cache)', async (t) => {
  const { app, tokenFor } = montarAmbiente(t, { usuarios: [BRENO] });
  const sucesso = await app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${tokenFor(BRENO.userId)}` } }));
  const erro = await app.handle(makeRequest({ url: '/api/me' }));
  for (const response of [sucesso, erro]) {
    assert.match(response.headers['Content-Type'], /application\/json/);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
});
