// Testes da API do CRM (rotas /api/crm de src/server/app.js — decisão 0015): a camada HTTP FINA sobre o CRM Service.
//
// O que estes testes protegem: cada rota autentica pelo fluxo que já existe (Bearer -> verifyAccessToken real, contra um
// Supabase falso só na borda de rede -> AuthorizationContext) e entrega o contexto ao CRM Service, que é quem autoriza
// (READ:CRM / WRITE:CRM) e quem chama o domínio. Nada do que o navegador manda — corpo, query, cabeçalho — vira identidade
// ou permissão; e os erros viram HTTP com mensagem FIXA, nunca detalhe interno, stack, caminho, token ou authUserId.
//
// A maioria roda sobre peças REAIS (Service real, ponte de autorização real, adapter de arquivo real em diretório
// temporário). Os testes que provam a DELEGAÇÃO usam um double do Service, para OBSERVAR o que a API entrega a ele.
// Nenhum dado real: toda empresa, e-mail e telefone aqui é fictício (example.test).
//
// A maioria chama app.handle(req) com um `req` fake, sem socket; um pequeno grupo (marcado) sobe um http.Server de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { Readable } = require('node:stream');

const constants = require('../../src/auth/constants');
const { PERMISSION, createUserStore, defineUser, authorizeCrmOperation } = require('../../src/auth');
const crm = require('../../src/crm');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createApp } = require('../../src/server/app');
const { isIssuedAuthorizationContext, verifiedIdentityFor } = require('../helpers/authFixtures');
const { montarAmbiente, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');

// ---------------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------------
function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}

// Uma chamada à API como `usuario` (ou sem autenticação, com `null`). `contentType: null` omite o Content-Type.
async function chamar(env, usuario, { method = 'GET', url, body, headers = {}, contentType = 'application/json' } = {}) {
  const base = {};
  if (usuario) base.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if (body !== undefined && contentType !== null) base['content-type'] = contentType;
  const response = await env.app.handle(makeRequest({ method, url, headers: { ...base, ...headers }, body }));
  return { status: response.status, headers: response.headers, text: response.body, json: () => JSON.parse(response.body) };
}

const rota = (id, sufixo = '') => `/api/crm/${encodeURIComponent(id)}${sufixo}`;

// As 7 rotas da API, cada uma com um corpo válido quando tem corpo.
const rotasCrm = (id) => [
  { method: 'GET', url: '/api/crm' },
  { method: 'POST', url: '/api/crm', body: { empresa: 'Rota Teste' } },
  { method: 'GET', url: rota(id) },
  { method: 'PATCH', url: rota(id), body: { cidade: 'Cidade Nova' } },
  { method: 'GET', url: rota(id, '/history') },
  { method: 'POST', url: rota(id, '/status'), body: { to: 'RESEARCH' } },
  { method: 'POST', url: rota(id, '/dnc'), body: {} },
];

// Registros fictícios, com identidades (site, telefone, nome+cidade) todas diferentes entre si.
const ALFA = Object.freeze({ empresa: 'Clínica Alfa Teste', site: 'alfa.example.test', telefone: '24 90000-0001', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', email: 'contato@alfa.example.test' });
const BETA = Object.freeze({ empresa: 'Clínica Beta Teste', site: 'beta.example.test', telefone: '21 90000-0002', cidade: 'Niterói', estado: 'RJ', nicho: 'Odontologia' });
const GAMA = Object.freeze({ empresa: 'Clínica Gama Teste', site: 'gama.example.test', telefone: '11 90000-0003', cidade: 'São Paulo', estado: 'SP', nicho: 'Nutrição' });

const CAMPOS_PUBLICOS = ['id', ...crm.CRM_WRITABLE_FIELDS, 'status', 'dataDeEntrada', 'historico'].sort();
const ERRO_INTERNO = 'Erro interno. Tente novamente em instantes.';

// Grava um registro direto pelo domínio, sobre o MESMO arquivo que a API usa (semente do teste).
function semear(env, campos, status) {
  const repositorio = createJsonFileCrmRepository(env.crmFilePath);
  return crm.createRecord(repositorio, campos, {
    ...(status ? { status } : {}),
    actor: 'HUMAN',
    reviewedBy: { userId: 'user-semente', name: 'Semente', role: 'ADMIN' },
    motivo: 'semente do teste',
  }).record;
}

const bytes = (env) => (fs.existsSync(env.crmFilePath) ? fs.readFileSync(env.crmFilePath, 'utf8') : null);
const registros = (env) => createJsonFileCrmRepository(env.crmFilePath).list();
const registro = (env, id) => createJsonFileCrmRepository(env.crmFilePath).getById(id);
const operadorDe = (usuario) => ({ userId: usuario.userId, name: usuario.name, role: usuario.role });

// Um double do CRM Service: registra cada chamada ({ nome, args }) e devolve algo benigno. `falhar` faz uma operação lançar.
function criarServicoDuplo(chamadas, { falhar = {} } = {}) {
  const operacao = (nome, retorno) => (...args) => {
    chamadas.push({ nome, args });
    if (Object.prototype.hasOwnProperty.call(falhar, nome)) throw falhar[nome];
    return retorno;
  };
  return {
    listRecords: operacao('listRecords', []),
    getRecord: operacao('getRecord', { id: 'crm:duplo' }),
    getHistory: operacao('getHistory', []),
    createRecord: operacao('createRecord', { record: { id: 'crm:duplo' }, duplicidade: null }),
    updateRecord: operacao('updateRecord', { id: 'crm:duplo' }),
    moveStatus: operacao('moveStatus', { id: 'crm:duplo' }),
    markDoNotContact: operacao('markDoNotContact', { id: 'crm:duplo' }),
  };
}

// ===========================================================================
// AUTENTICAÇÃO — toda rota do CRM é protegida
// ===========================================================================
test('[CRM-API-1] sem Authorization -> 401 em TODAS as 7 rotas, e nada é lido nem gravado', async (t) => {
  const env = montarAmbiente(t, { crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  for (const requisicao of rotasCrm(alfa.id)) {
    const resposta = await chamar(env, null, requisicao);
    assert.equal(resposta.status, 401, `${requisicao.method} ${requisicao.url}`);
    assert.equal(resposta.json().error.code, 'UNAUTHENTICATED', `${requisicao.method} ${requisicao.url}`);
  }
  assert.equal(bytes(env), antes, 'nenhuma rota tocou no arquivo do CRM');
});

test('[CRM-API-2] token inválido (cabeçalho malformado, nunca emitido, "ADMIN", o userId) -> 401 em todas as rotas, e o Service nem é chamado', async (t) => {
  const chamadas = [];
  const env = montarAmbiente(t, { crmService: criarServicoDuplo(chamadas) });
  const cabecalhos = [
    { Authorization: 'Bearer' },
    { Authorization: 'Basic dXNlcjpwYXNz' },
    { Authorization: 'Bearer token-nao-emitido-por-ninguem' },
    { Authorization: 'Bearer ADMIN' },
    { Authorization: `Bearer ${BRENO.userId}` },
    { Authorization: `Bearer ${BRENO.authUserId}` },
  ];
  for (const headers of cabecalhos) {
    for (const requisicao of rotasCrm('crm:x')) {
      const resposta = await chamar(env, null, { ...requisicao, headers });
      assert.equal(resposta.status, 401, `${headers.Authorization} ${requisicao.method} ${requisicao.url}`);
      assert.equal(resposta.json().error.code, 'UNAUTHENTICATED');
    }
  }
  assert.deepEqual(chamadas, [], 'com um token que o Supabase não reconhece, o Service nunca é alcançado');
});

test('[CRM-API-3] token EXPIRADO (o Supabase o recusa) -> 401, e o Service nem é chamado', async (t) => {
  const chamadas = [];
  const env = montarAmbiente(t, { crmService: criarServicoDuplo(chamadas) });
  env.fakeAuth.respondToUnknownTokensWith(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired' });
  for (const requisicao of rotasCrm('crm:x')) {
    const resposta = await chamar(env, null, { ...requisicao, headers: { Authorization: 'Bearer token-expirado-de-teste' } });
    assert.equal(resposta.status, 401, `${requisicao.method} ${requisicao.url}`);
    assert.equal(resposta.json().error.code, 'UNAUTHENTICATED');
    assert.ok(!resposta.text.includes('expired'), 'a razão do Supabase não chega ao navegador');
  }
  assert.deepEqual(chamadas, []);
});

test('[CRM-API-4] token válido, mas SEM usuário cadastrado no store -> 403 NO_ACCESS em todas as rotas, e o Service nem é chamado', async (t) => {
  const chamadas = [];
  const env = montarAmbiente(t, { usuarios: [BRENO], crmService: criarServicoDuplo(chamadas) });
  const semCadastro = createApp({
    verifyAccessToken: env.verifyAccessToken,
    userStore: createUserStore([]), // ninguém cadastrado: o token de Breno é verdadeiro, mas ele não é um USER
    approvalQueueService: env.approvalQueueService,
    crmService: env.crmService,
    publicConfig: env.publicConfig,
    staticRoot: env.staticRoot,
  });
  for (const requisicao of rotasCrm('crm:x')) {
    const resposta = await semCadastro.handle(
      makeRequest({
        method: requisicao.method,
        url: requisicao.url,
        headers: { Authorization: `Bearer ${env.tokenFor(BRENO.userId)}`, ...(requisicao.body ? { 'content-type': 'application/json' } : {}) },
        body: requisicao.body,
      })
    );
    assert.equal(resposta.status, 403, `${requisicao.method} ${requisicao.url}`);
    assert.equal(JSON.parse(resposta.body).error.code, 'NO_ACCESS');
  }
  assert.deepEqual(chamadas, []);
});

test('[CRM-API-5] usuário INACTIVE -> 403 em todas as rotas, mesmo com token válido, e nada é gravado', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, EX_COLABORADOR], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  for (const requisicao of rotasCrm(alfa.id)) {
    const resposta = await chamar(env, EX_COLABORADOR, requisicao);
    assert.equal(resposta.status, 403, `${requisicao.method} ${requisicao.url}`);
    assert.equal(resposta.json().error.code, 'INACTIVE');
  }
  assert.equal(bytes(env), antes);
});

test('[CRM-API-6] usuário ativo, com contexto legítimo, mas SEM READ:CRM/WRITE:CRM -> 403 em todas as rotas; um id existente e um inexistente recebem a MESMA resposta (nada sobre a existência de um registro vaza para quem não tem acesso)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.APPROVE_LEAD_APPROVAL]));
  try {
    for (const requisicao of rotasCrm(alfa.id)) {
      const resposta = await chamar(env, BRENO, requisicao);
      assert.equal(resposta.status, 403, `${requisicao.method} ${requisicao.url}`);
      assert.equal(resposta.json().error.code, 'FORBIDDEN');
    }
    const existente = await chamar(env, BRENO, { url: rota(alfa.id) });
    const inexistente = await chamar(env, BRENO, { url: rota('crm:nao-existe') });
    assert.equal(existente.status, 403);
    assert.equal(existente.text, inexistente.text, 'a resposta não distingue registro existente de inexistente');
  } finally {
    derivacao.mock.restore();
  }
  assert.equal(bytes(env), antes);
});

// ===========================================================================
// LEITURA
// ===========================================================================
test('[CRM-API-7] GET /api/crm autenticado -> 200 { items }, para ADMIN e para COMMERCIAL_CLOSER (READ:CRM), com o formato público exato de cada registro', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true });
  const alfa = semear(env, ALFA);
  const beta = semear(env, BETA);
  for (const usuario of [BRENO, RAFAEL]) {
    const resposta = await chamar(env, usuario, { url: '/api/crm' });
    assert.equal(resposta.status, 200, usuario.userId);
    const corpo = resposta.json();
    assert.deepEqual(Object.keys(corpo), ['items']);
    assert.deepEqual(corpo.items.map((item) => item.id), [alfa.id, beta.id]);
    for (const item of corpo.items) assert.deepEqual(Object.keys(item).sort(), CAMPOS_PUBLICOS);
  }
});

test('[CRM-API-8] GET /api/crm/:id e /api/crm/:id/history -> 200 com o registro e a trilha de auditoria; registro inexistente -> 404 com mensagem fixa', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true });
  const alfa = semear(env, ALFA);

  const um = await chamar(env, RAFAEL, { url: rota(alfa.id) });
  assert.equal(um.status, 200);
  assert.equal(um.json().item.id, alfa.id);
  assert.equal(um.json().item.empresa, ALFA.empresa);

  const historico = await chamar(env, RAFAEL, { url: rota(alfa.id, '/history') });
  assert.equal(historico.status, 200);
  const { historico: entradas } = historico.json();
  assert.equal(entradas.length, 1);
  assert.deepEqual(entradas[0].reviewedBy, { userId: 'user-semente', name: 'Semente', role: 'ADMIN' });
  assert.equal(entradas[0].actor, 'HUMAN');
  assert.equal(entradas[0].to, 'PROSPECT');

  for (const url of [rota('crm:nao-existe'), rota('crm:nao-existe', '/history')]) {
    const ausente = await chamar(env, BRENO, { url });
    assert.equal(ausente.status, 404, url);
    assert.deepEqual(ausente.json(), { error: { code: 'NOT_FOUND', message: 'Item não encontrado.' } });
    assert.ok(!ausente.text.includes('nao-existe'), 'o id pedido não é repetido na resposta');
  }
});

// ===========================================================================
// ESCRITA autorizada (ADMIN, que tem WRITE:CRM)
// ===========================================================================
test('[CRM-API-9] POST /api/crm (ADMIN) -> 201, persiste, e a auditoria vem do CONTEXTO: reviewedBy = o usuário do token, actor = HUMAN', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const resposta = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { ...ALFA } });
  assert.equal(resposta.status, 201);
  const corpo = resposta.json();
  assert.deepEqual(Object.keys(corpo).sort(), ['duplicidade', 'item']);
  assert.equal(corpo.duplicidade, null);
  assert.deepEqual(Object.keys(corpo.item).sort(), CAMPOS_PUBLICOS);
  assert.equal(corpo.item.status, 'PROSPECT');
  assert.equal(corpo.item.empresa, ALFA.empresa);
  assert.match(corpo.item.id, /^crm:/);

  const gravado = registro(env, corpo.item.id);
  assert.equal(gravado.empresa, ALFA.empresa);
  assert.equal(gravado.historico.length, 1);
  assert.deepEqual(gravado.historico[0].reviewedBy, operadorDe(BRENO));
  assert.equal(gravado.historico[0].actor, 'HUMAN');
  assert.equal(gravado.historico[0].from, null);
  assert.equal(gravado.historico[0].to, 'PROSPECT');
});

test('[CRM-API-10] POST /api/crm com { status, reason }: status inicial e motivo entram na auditoria; status desconhecido ou de tipo errado, e motivo que não é texto -> 400, sem gravar', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const ok = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { ...ALFA, status: 'QUALIFIED_PROSPECT', reason: 'Indicação de um cliente' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json().item.status, 'QUALIFIED_PROSPECT');
  assert.equal(registro(env, ok.json().item.id).historico[0].motivo, 'Indicação de um cliente');
  assert.equal(registros(env).length, 1);

  const ruins = [
    { corpo: { ...BETA, status: 'NAO_EXISTE' }, mensagem: 'Status inválido.' },
    { corpo: { ...BETA, status: 42 }, mensagem: 'Status inválido.' },
    { corpo: { ...BETA, reason: 42 }, mensagem: 'O motivo deve ser um texto.' },
  ];
  for (const { corpo, mensagem } of ruins) {
    const resposta = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: corpo });
    assert.equal(resposta.status, 400, JSON.stringify(corpo));
    assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: mensagem } });
  }
  assert.equal(registros(env).length, 1, 'nenhum registro inválido foi gravado');
});

test('[CRM-API-11] PATCH /api/crm/:id (ADMIN) -> 200, muda só os campos enviados e nunca o status, o id nem o histórico; um corpo vazio é um no-op', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const resposta = await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: { cidade: 'Teresópolis', temperatura: 'Quente' } });
  assert.equal(resposta.status, 200);
  const { item } = resposta.json();
  assert.equal(item.cidade, 'Teresópolis');
  assert.equal(item.temperatura, 'Quente');
  assert.equal(item.empresa, ALFA.empresa, 'o que não foi enviado não muda');
  assert.equal(item.id, alfa.id);
  assert.equal(item.status, 'PROSPECT');
  assert.equal(item.historico.length, 1, 'editar campos não cria entrada de histórico (limite documentado na decisão 0014)');
  assert.equal(registro(env, alfa.id).cidade, 'Teresópolis');

  const vazio = await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: {} });
  assert.equal(vazio.status, 200);
  assert.equal(vazio.json().item.cidade, 'Teresópolis');
});

test('[CRM-API-12] POST /api/crm/:id/status (ADMIN) -> 200, muda o status e acrescenta a entrada de histórico com o motivo e o reviewedBy do CONTEXTO; transição proibida -> 409; destino desconhecido, ausente ou que não é texto -> 400', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const mover = (corpo) => chamar(env, BRENO, { method: 'POST', url: rota(alfa.id, '/status'), body: corpo });

  const ok = await mover({ to: 'CONTACTED', reason: 'Primeiro contato feito' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().item.status, 'CONTACTED');
  const ultima = registro(env, alfa.id).historico.at(-1);
  assert.deepEqual({ from: ultima.from, to: ultima.to, actor: ultima.actor, motivo: ultima.motivo }, { from: 'PROSPECT', to: 'CONTACTED', actor: 'HUMAN', motivo: 'Primeiro contato feito' });
  assert.deepEqual(ultima.reviewedBy, operadorDe(BRENO));

  assert.equal((await mover({ to: 'WON' })).status, 200);
  const proibida = await mover({ to: 'PROSPECT' }); // WON só pode ir para DO_NOT_CONTACT
  assert.equal(proibida.status, 409);
  assert.deepEqual(proibida.json(), { error: { code: 'INVALID_TRANSITION', message: 'Esta mudança de status não é permitida.' } });
  assert.ok(!proibida.text.includes('WON'), 'a mensagem é fixa: nem o status de origem nem o de destino são repetidos');

  for (const corpo of [{ to: 'NAO_EXISTE' }, {}, { to: 42 }, { to: null }]) {
    const invalida = await mover(corpo);
    assert.equal(invalida.status, 400, JSON.stringify(corpo));
    assert.deepEqual(invalida.json(), { error: { code: 'INVALID_REQUEST', message: 'Status inválido.' } });
  }
  assert.equal(registro(env, alfa.id).status, 'WON', 'nenhum pedido inválido mudou o registro');
  assert.equal(registro(env, alfa.id).historico.length, 3);
});

test('[CRM-API-13] POST /api/crm/:id/dnc (ADMIN) -> 200 DO_NOT_CONTACT; depois o registro é TERMINAL: editar -> 409 RECORD_LOCKED, mudar de status ou marcar de novo -> 409 INVALID_TRANSITION', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const bloqueio = await chamar(env, BRENO, { method: 'POST', url: rota(alfa.id, '/dnc'), body: { reason: 'Pediu para não ser contatado' } });
  assert.equal(bloqueio.status, 200);
  assert.equal(bloqueio.json().item.status, 'DO_NOT_CONTACT');
  const ultima = registro(env, alfa.id).historico.at(-1);
  assert.equal(ultima.to, 'DO_NOT_CONTACT');
  assert.equal(ultima.motivo, 'Pediu para não ser contatado');
  assert.deepEqual(ultima.reviewedBy, operadorDe(BRENO));

  const editar = await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: { cidade: 'Outra' } });
  assert.equal(editar.status, 409);
  assert.deepEqual(editar.json(), { error: { code: 'RECORD_LOCKED', message: 'Este registro está bloqueado como "não contatar" e não pode ser alterado.' } });
  for (const requisicao of [
    { url: rota(alfa.id, '/status'), body: { to: 'PROSPECT' } },
    { url: rota(alfa.id, '/dnc'), body: {} },
  ]) {
    const resposta = await chamar(env, BRENO, { method: 'POST', ...requisicao });
    assert.equal(resposta.status, 409, requisicao.url);
    assert.equal(resposta.json().error.code, 'INVALID_TRANSITION');
  }
  assert.equal(registro(env, alfa.id).status, 'DO_NOT_CONTACT');
  assert.equal(registro(env, alfa.id).cidade, ALFA.cidade);
});

// ===========================================================================
// SEM PERMISSÃO — COMMERCIAL_CLOSER lê (READ:CRM) e NÃO escreve (sem WRITE:CRM)
// ===========================================================================
test('[CRM-API-14] COMMERCIAL_CLOSER: criar, editar, mudar status e marcar DNC -> 403 FORBIDDEN, e o arquivo não muda um byte; as leituras seguem funcionando', async (t) => {
  const env = montarAmbiente(t, { usuarios: [RAFAEL], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const escritas = rotasCrm(alfa.id).filter((requisicao) => requisicao.method !== 'GET');
  assert.equal(escritas.length, 4);
  for (const requisicao of escritas) {
    const resposta = await chamar(env, RAFAEL, requisicao);
    assert.equal(resposta.status, 403, `${requisicao.method} ${requisicao.url}`);
    assert.deepEqual(resposta.json(), { error: { code: 'FORBIDDEN', message: 'Esta conta não possui acesso a esta área.' } });
  }
  assert.equal(bytes(env), antes, 'nenhuma escrita foi feita');
  for (const url of ['/api/crm', rota(alfa.id), rota(alfa.id, '/history')]) {
    assert.equal((await chamar(env, RAFAEL, { url })).status, 200, url);
  }
});

// ===========================================================================
// CONFLITOS — duplicidade, DNC
// ===========================================================================
test('[CRM-API-15] duplicidade: a mesma identidade (site ou telefone) -> 409 DUPLICATE_RECORD com mensagem fixa, sem gravar; só nome+cidade iguais é um AVISO (201 com duplicidade)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const criar = (corpo) => chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: corpo });

  for (const corpo of [
    { empresa: 'Outro Nome', site: ALFA.site },
    { empresa: 'Outro Nome', telefone: ALFA.telefone },
  ]) {
    const duplicado = await criar(corpo);
    assert.equal(duplicado.status, 409, JSON.stringify(corpo));
    assert.deepEqual(duplicado.json(), { error: { code: 'DUPLICATE_RECORD', message: 'Já existe um registro com esta identidade.' } });
    assert.ok(!duplicado.text.includes(alfa.id), 'o id do outro registro não sai na recusa');
    assert.ok(!duplicado.text.includes(ALFA.empresa), 'nem o nome do outro registro');
  }
  assert.equal(registros(env).length, 1, 'nenhuma duplicata foi gravada');

  const possivel = await criar({ empresa: ALFA.empresa, cidade: ALFA.cidade }); // só nome + cidade
  assert.equal(possivel.status, 201, 'um match só por nome+cidade não bloqueia (prefere-se falso negativo)');
  assert.equal(possivel.json().duplicidade.status, 'POSSIVEL_DUPLICADO');
  assert.equal(possivel.json().duplicidade.matchedRecordId, alfa.id);
  assert.ok(!possivel.text.includes(ALFA.email), 'o aviso não traz o registro do OUTRO: só o id e o critério');
  assert.equal(registros(env).length, 2);
});

test('[CRM-API-16] identidade BLOQUEADA (DO_NOT_CONTACT): criar com ela -> 409 DNC_BLOCKED; editar outro registro para ela -> 409 DNC_BLOCKED; editar para a de um registro ativo -> 409 DUPLICATE_RECORD; nada muda', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const bloqueado = semear(env, ALFA, 'DO_NOT_CONTACT');
  const beta = semear(env, BETA);
  const gama = semear(env, GAMA);
  const antes = bytes(env);

  for (const corpo of [{ empresa: 'Nome Diferente', site: ALFA.site }, { empresa: 'Nome Diferente', telefone: ALFA.telefone }]) {
    const criar = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: corpo });
    assert.equal(criar.status, 409, JSON.stringify(corpo));
    assert.deepEqual(criar.json(), { error: { code: 'DNC_BLOCKED', message: 'Esta identidade está bloqueada como "não contatar".' } });
    assert.ok(!criar.text.includes(bloqueado.id));
  }
  const editarParaBloqueado = await chamar(env, BRENO, { method: 'PATCH', url: rota(beta.id), body: { site: ALFA.site } });
  assert.equal(editarParaBloqueado.status, 409);
  assert.equal(editarParaBloqueado.json().error.code, 'DNC_BLOCKED');

  const editarParaAtivo = await chamar(env, BRENO, { method: 'PATCH', url: rota(beta.id), body: { site: GAMA.site } });
  assert.equal(editarParaAtivo.status, 409);
  assert.deepEqual(editarParaAtivo.json(), { error: { code: 'DUPLICATE_RECORD', message: 'Já existe um registro com esta identidade.' } });
  assert.ok(!editarParaAtivo.text.includes(gama.id));

  assert.equal(bytes(env), antes, 'nenhuma dessas tentativas gravou algo');
});

// ===========================================================================
// ENTRADA INVÁLIDA
// ===========================================================================
test('[CRM-API-17] payload inválido no POST/PATCH -> 400 com mensagem FIXA, sem gravar: empresa ausente ou em branco, campo desconhecido, campo gerenciado (id, status, historico, dataDeEntrada), tipo errado, valor negativo', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const CAMPOS = 'Campos não permitidos na requisição.';
  const VALOR = 'Valor inválido em um dos campos.';

  const criacao = [
    [{}, 'Informe a empresa.'],
    [{ empresa: '   ' }, 'Informe a empresa.'],
    [{ empresa: 'X', campoInventado: 1 }, CAMPOS],
    [{ empresa: 'X', id: 'crm:forjado' }, CAMPOS],
    [{ empresa: 'X', historico: [] }, CAMPOS],
    [{ empresa: 'X', dataDeEntrada: '2020-01-01T00:00:00.000Z' }, CAMPOS],
    [{ empresa: 42 }, VALOR],
    [{ empresa: { aninhado: 'objeto' } }, VALOR],
    [{ empresa: 'X', valorProposta: 'muito' }, VALOR],
    [{ empresa: 'X', valorProposta: -1 }, VALOR],
    [{ empresa: 'X', observacoes: ['lista'] }, VALOR],
  ];
  for (const [corpo, mensagem] of criacao) {
    const resposta = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: corpo });
    assert.equal(resposta.status, 400, `POST ${JSON.stringify(corpo)}`);
    assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: mensagem } }, `POST ${JSON.stringify(corpo)}`);
  }

  const edicao = [
    [{ empresa: '' }, 'A empresa não pode ficar vazia.'],
    [{ status: 'WON' }, CAMPOS], // o status só muda por /status
    [{ id: 'crm:outro' }, CAMPOS],
    [{ historico: [] }, CAMPOS],
    [{ campoInventado: 1 }, CAMPOS],
    [{ valorTotal: 'x' }, VALOR],
  ];
  for (const [corpo, mensagem] of edicao) {
    const resposta = await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: corpo });
    assert.equal(resposta.status, 400, `PATCH ${JSON.stringify(corpo)}`);
    assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: mensagem } }, `PATCH ${JSON.stringify(corpo)}`);
  }
  assert.equal(bytes(env), antes, 'nada inválido foi gravado');
});

test('[CRM-API-18] JSON inválido, vazio ou que não é um OBJETO (lista, texto, número, null) -> 400 em toda rota com corpo, sem gravar', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const comCorpo = rotasCrm(alfa.id).filter((requisicao) => requisicao.body !== undefined);
  assert.equal(comCorpo.length, 4);
  const ruins = [
    ['{ isto nao e json', 'JSON inválido.'],
    ['', 'JSON inválido.'],
    ['{"empresa": "X",}', 'JSON inválido.'],
    ['[]', 'O corpo deve ser um objeto JSON.'],
    ['[{"empresa":"X"}]', 'O corpo deve ser um objeto JSON.'],
    ['"texto"', 'O corpo deve ser um objeto JSON.'],
    ['123', 'O corpo deve ser um objeto JSON.'],
    ['true', 'O corpo deve ser um objeto JSON.'],
    ['null', 'O corpo deve ser um objeto JSON.'],
  ];
  for (const requisicao of comCorpo) {
    for (const [corpo, mensagem] of ruins) {
      const resposta = await chamar(env, BRENO, { ...requisicao, body: corpo });
      assert.equal(resposta.status, 400, `${requisicao.method} ${requisicao.url} ${corpo}`);
      assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: mensagem } }, `${requisicao.method} ${requisicao.url} ${corpo}`);
    }
  }
  assert.equal(bytes(env), antes);
});

test('[CRM-API-19] Content-Type diferente de application/json (ou ausente) -> 415; um corpo grande demais (declarado ou em streaming) -> 413; nada é gravado', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const escritas = rotasCrm(alfa.id).filter((requisicao) => requisicao.body !== undefined);

  for (const contentType of [null, 'text/plain', 'text/html', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx']) {
    for (const requisicao of escritas) {
      const resposta = await chamar(env, BRENO, { ...requisicao, contentType });
      assert.equal(resposta.status, 415, `${contentType} ${requisicao.method} ${requisicao.url}`);
      assert.equal(resposta.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
  }

  const grande = JSON.stringify({ empresa: 'Grande Demais', observacoes: 'x'.repeat(17 * 1024) });
  const emStreaming = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: grande });
  assert.equal(emStreaming.status, 413);
  assert.equal(emStreaming.json().error.code, 'PAYLOAD_TOO_LARGE');
  const declarado = await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: { cidade: 'Pequena' }, headers: { 'content-length': String(64 * 1024) } });
  assert.equal(declarado.status, 413);
  assert.equal(bytes(env), antes);

  // Controle: application/json com parâmetros e em maiúsculas é aceito.
  const aceito = await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { ...BETA }, contentType: 'Application/JSON; charset=utf-8' });
  assert.equal(aceito.status, 201);
});

test('[CRM-API-20] método errado -> 405 com o cabeçalho Allow exato, antes de qualquer outra coisa (inclusive sem autenticação); não existe exclusão, e um DELETE nunca apaga nada', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const casos = [
    ['DELETE', rota(alfa.id), 'GET, PATCH'],
    ['PUT', rota(alfa.id), 'GET, PATCH'],
    ['POST', rota(alfa.id), 'GET, PATCH'],
    ['DELETE', '/api/crm', 'GET, POST'],
    ['PUT', '/api/crm', 'GET, POST'],
    ['PATCH', '/api/crm', 'GET, POST'],
    ['POST', rota(alfa.id, '/history'), 'GET'],
    ['PATCH', rota(alfa.id, '/history'), 'GET'],
    ['DELETE', rota(alfa.id, '/history'), 'GET'],
    ['GET', rota(alfa.id, '/status'), 'POST'],
    ['PUT', rota(alfa.id, '/status'), 'POST'],
    ['PATCH', rota(alfa.id, '/status'), 'POST'],
    ['GET', rota(alfa.id, '/dnc'), 'POST'],
    ['DELETE', rota(alfa.id, '/dnc'), 'POST'],
    ['OPTIONS', '/api/crm', 'GET, POST'],
    ['HEAD', '/api/crm', 'GET, POST'],
    ['PROPFIND', rota(alfa.id), 'GET, PATCH'],
  ];
  for (const [method, url, permitidos] of casos) {
    for (const usuario of [null, BRENO]) {
      const resposta = await chamar(env, usuario, { method, url });
      assert.equal(resposta.status, 405, `${method} ${url}`);
      assert.equal(resposta.headers.Allow, permitidos, `${method} ${url}`);
      assert.equal(resposta.json().error.code, 'METHOD_NOT_ALLOWED');
    }
  }
  assert.equal(bytes(env), antes);
  assert.equal((await chamar(env, BRENO, { url: rota(alfa.id) })).status, 200, 'o registro continua lá');
});

test('[CRM-API-21] query string -> 400 em toda rota (a API não tem filtros nem busca); userId/role/permissions/authUserId na query nunca são lidos', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const consultas = ['?empresa=Alfa', '?cidade=Petropolis&estado=RJ', '?userId=user-breno', '?role=ADMIN', '?permissions=WRITE:CRM', '?authUserId=auth-breno', '?reviewedBy=x', '?x=1'];
  for (const consulta of consultas) {
    for (const requisicao of rotasCrm(alfa.id)) {
      const resposta = await chamar(env, BRENO, { ...requisicao, url: `${requisicao.url}${consulta}` });
      assert.equal(resposta.status, 400, `${requisicao.method} ${requisicao.url}${consulta}`);
      assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: 'Parâmetros não permitidos.' } });
    }
  }
  const comoCloser = await chamar(env, RAFAEL, { url: '/api/crm?role=ADMIN' });
  assert.equal(comoCloser.status, 400);
  assert.equal(bytes(env), antes);
});

test('[CRM-API-22] rotas que não existem sob /api/crm -> 404 (sem revelar nada), com ou sem autenticação', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const urls = ['/api/crm/', `${rota(alfa.id)}/`, `${rota(alfa.id)}/desconhecida`, `${rota(alfa.id, '/status')}/extra`, '/api/crmx', '/api/CRM', `/api/crm/${encodeURIComponent(alfa.id)}/HISTORY`, '/api/crm//x', '/api/crm/a/b/c/d'];
  for (const url of urls) {
    for (const usuario of [null, BRENO]) {
      const resposta = await chamar(env, usuario, { url });
      assert.equal(resposta.status, 404, url);
      assert.deepEqual(resposta.json(), { error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada.' } }, url);
    }
  }
});

// ===========================================================================
// IDENTIDADE E PERMISSÃO NUNCA VÊM DO NAVEGADOR
// ===========================================================================
const FORJADOS = Object.freeze({
  userId: 'user-atacante',
  authUserId: 'auth-atacante',
  role: 'ADMIN',
  permissions: ['WRITE:CRM', 'MANAGE:USERS'],
  reviewedBy: { userId: 'user-atacante', name: 'Atacante', role: 'ADMIN' },
  actor: 'SYSTEM',
});

test('[CRM-API-23] userId, authUserId, role, permissions, reviewedBy e actor enviados pelo navegador -> 400 em toda escrita (mesmo por um ADMIN), sem gravar; e o histórico legítimo traz SEMPRE a identidade do token', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);

  for (const [chave, valor] of Object.entries(FORJADOS)) {
    const requisicoes = [
      { method: 'POST', url: '/api/crm', body: { empresa: 'Forjada', [chave]: valor } },
      { method: 'PATCH', url: rota(alfa.id), body: { cidade: 'Forjada', [chave]: valor } },
      { method: 'POST', url: rota(alfa.id, '/status'), body: { to: 'CONTACTED', [chave]: valor } },
      { method: 'POST', url: rota(alfa.id, '/dnc'), body: { [chave]: valor } },
    ];
    for (const requisicao of requisicoes) {
      const resposta = await chamar(env, BRENO, requisicao);
      assert.equal(resposta.status, 400, `${requisicao.method} ${requisicao.url} com ${chave}`);
      assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: 'Campos não permitidos na requisição.' } }, `${requisicao.method} ${requisicao.url} com ${chave}`);
    }
  }
  assert.equal(bytes(env), antes, 'nenhuma requisição forjada gravou algo');

  // As mesmas escritas, sem os campos forjados: a auditoria é a do token, nunca a do corpo.
  const criada = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { ...BETA } })).json().item;
  await chamar(env, BRENO, { method: 'POST', url: rota(criada.id, '/status'), body: { to: 'CONTACTED', reason: 'ok' } });
  await chamar(env, BRENO, { method: 'POST', url: rota(criada.id, '/dnc'), body: {} });
  const historico = registro(env, criada.id).historico;
  assert.equal(historico.length, 3);
  for (const entrada of historico) {
    assert.deepEqual(entrada.reviewedBy, operadorDe(BRENO));
    assert.equal(entrada.actor, 'HUMAN');
  }
  assert.ok(!bytes(env).includes('user-atacante') && !bytes(env).includes('auth-atacante'), 'nada do forjado chegou ao arquivo');
});

test('[CRM-API-24] ESCALADA DE PRIVILÉGIO: um COMMERCIAL_CLOSER que envia role ADMIN / permissions / cabeçalhos de identidade continua sem escrever (403); o arquivo não muda e /api/me segue mostrando a role real', async (t) => {
  const env = montarAmbiente(t, { usuarios: [RAFAEL], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const cabecalhosForjados = { 'X-Role': 'ADMIN', 'X-User-Id': 'user-breno', 'X-Permissions': 'WRITE:CRM', 'X-Auth-User-Id': 'auth-breno', 'X-Forwarded-User': 'user-breno' };

  // No POST/PATCH, o corpo forjado chega ao Service como CAMPOS, e o Service autoriza ANTES de validar: 403.
  for (const requisicao of [
    { method: 'POST', url: '/api/crm', body: { empresa: 'Escalada', role: 'ADMIN', permissions: ['WRITE:CRM'] } },
    { method: 'PATCH', url: rota(alfa.id), body: { cidade: 'Escalada', role: 'ADMIN', permissions: ['WRITE:CRM'] } },
    { method: 'POST', url: rota(alfa.id, '/status'), body: { to: 'WON' } },
    { method: 'POST', url: rota(alfa.id, '/dnc'), body: {} },
  ]) {
    const comCabecalhos = await chamar(env, RAFAEL, { ...requisicao, headers: cabecalhosForjados });
    assert.equal(comCabecalhos.status, 403, `${requisicao.method} ${requisicao.url}`);
    assert.equal(comCabecalhos.json().error.code, 'FORBIDDEN');
  }
  // Nas rotas de ação, um campo forjado é recusado já na API (400): nunca chega a decidir nada.
  for (const requisicao of [
    { method: 'POST', url: rota(alfa.id, '/status'), body: { to: 'WON', role: 'ADMIN' } },
    { method: 'POST', url: rota(alfa.id, '/dnc'), body: { permissions: ['WRITE:CRM'] } },
  ]) {
    assert.equal((await chamar(env, RAFAEL, requisicao)).status, 400, `${requisicao.method} ${requisicao.url}`);
  }
  assert.equal(bytes(env), antes);

  const me = await env.app.handle(makeRequest({ url: '/api/me', headers: { Authorization: `Bearer ${env.tokenFor(RAFAEL.userId)}`, ...cabecalhosForjados } }));
  assert.equal(JSON.parse(me.body).role, 'COMMERCIAL_CLOSER');
  assert.ok(!JSON.parse(me.body).permissions.includes('WRITE:CRM'));
});

test('[CRM-API-25] POLUIÇÃO DE PROTÓTIPO por payload: "__proto__", "constructor" e "prototype" no corpo -> 400 em POST e PATCH, nada é gravado, e Object.prototype continua intacto', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const corpos = [
    '{"__proto__":{"empresa":"Poluida","status":"WON","polluted":true}}',
    '{"empresa":"Ok","__proto__":{"status":"WON","reviewedBy":"x"}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
    '{"empresa":"Ok","constructor":"x"}',
    '{"empresa":"Ok","prototype":"x"}',
    '{"empresa":"Ok","toString":"x","hasOwnProperty":"y","valueOf":"z"}',
    '{"empresa":"Ok","__defineGetter__":"x"}',
  ];
  for (const corpo of corpos) {
    for (const requisicao of [
      { method: 'POST', url: '/api/crm' },
      { method: 'PATCH', url: rota(alfa.id) },
      { method: 'POST', url: rota(alfa.id, '/status') },
      { method: 'POST', url: rota(alfa.id, '/dnc') },
    ]) {
      const resposta = await chamar(env, BRENO, { ...requisicao, body: corpo });
      assert.equal(resposta.status, 400, `${requisicao.method} ${requisicao.url} ${corpo}`);
    }
  }
  assert.equal(bytes(env), antes, 'nada foi gravado');
  const limpo = {};
  for (const chave of ['polluted', 'status', 'empresa', 'reviewedBy', 'reason', 'to']) {
    assert.equal(limpo[chave], undefined, `Object.prototype.${chave} continua indefinido`);
  }
  assert.equal(Object.getPrototypeOf(limpo), Object.prototype);
});

test('[CRM-API-25b] POLUIÇÃO em tempo de execução: com Object.prototype poluído por outro código (status, reason, to), nada herdado escolhe o status, o motivo ou o destino de uma operação', async (t) => {
  // Sem o SDK do Supabase no caminho: uma identidade JÁ verificada (real), para que só o código da API e do CRM rode poluído.
  const identidade = await verifiedIdentityFor(t, { authUserId: BRENO.authUserId, email: BRENO.email });
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const app = createApp({
    verifyAccessToken: async () => identidade,
    userStore: createUserStore([defineUser(BRENO)]),
    approvalQueueService: env.approvalQueueService,
    crmService: createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: env.crmFilePath }),
    publicConfig: env.publicConfig,
    staticRoot: env.staticRoot,
  });
  const chamarPoluido = async ({ method, url, body }) => {
    const resposta = await app.handle(makeRequest({ method, url, headers: { Authorization: 'Bearer qualquer', 'content-type': 'application/json' }, body }));
    return { status: resposta.status, json: () => JSON.parse(resposta.body) };
  };

  const pontos = ['status', 'reason', 'to', 'motivo', 'reviewedBy', 'actor'];
  t.after(() => pontos.forEach((chave) => delete Object.prototype[chave]));
  let resultado;
  try {
    Object.prototype.status = 'WON';
    Object.prototype.reason = 'motivo herdado';
    Object.prototype.to = 'DO_NOT_CONTACT';
    Object.prototype.motivo = 'motivo herdado';
    Object.prototype.reviewedBy = { userId: 'user-atacante', name: 'Atacante', role: 'ADMIN' };
    Object.prototype.actor = 'SYSTEM';

    const criar = await chamarPoluido({ method: 'POST', url: '/api/crm', body: { ...BETA } });
    const semDestino = await chamarPoluido({ method: 'POST', url: rota(alfa.id, '/status'), body: {} });
    const marcar = await chamarPoluido({ method: 'POST', url: rota(alfa.id, '/dnc'), body: {} });
    resultado = { criar, semDestino, marcar };
  } finally {
    pontos.forEach((chave) => delete Object.prototype[chave]);
  }

  assert.equal(resultado.criar.status, 201);
  assert.equal(resultado.criar.json().item.status, 'PROSPECT', 'o status inicial não veio do protótipo');
  const criado = registro(env, resultado.criar.json().item.id);
  assert.equal(criado.historico[0].motivo, null, 'o motivo não veio do protótipo');
  assert.deepEqual(criado.historico[0].reviewedBy, operadorDe(BRENO), 'reviewedBy não veio do protótipo');
  assert.equal(criado.historico[0].actor, 'HUMAN');

  assert.equal(resultado.semDestino.status, 400, 'sem "to" no corpo não existe destino — o do protótipo não conta');
  assert.equal(resultado.marcar.status, 200);
  const marcado = registro(env, alfa.id);
  assert.equal(marcado.status, 'DO_NOT_CONTACT');
  assert.equal(marcado.historico.at(-1).motivo, null, 'o motivo não veio do protótipo');
  assert.deepEqual(marcado.historico.at(-1).reviewedBy, operadorDe(BRENO));
});

// ===========================================================================
// IDS PERIGOSOS
// ===========================================================================
test('[CRM-API-26] ids perigosos na URL (__proto__, constructor, path traversal, NUL, só espaço, encoding inválido, gigante) -> 404 ou 400, NUNCA 500, e nada é criado nem alterado', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const ids404 = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', '../../etc/passwd', '..\\..\\windows', 'a/b', 'crm:x" OR "1"="1', '\u0000', '💥', 'a'.repeat(3000), 'crm:%'];
  const ids400 = ['   '];

  const rotasComId = (url) => [
    { method: 'GET', url },
    { method: 'GET', url: `${url}/history` },
    { method: 'PATCH', url, body: { cidade: 'X' } },
    { method: 'POST', url: `${url}/status`, body: { to: 'RESEARCH' } },
    { method: 'POST', url: `${url}/dnc`, body: {} },
  ];
  for (const id of ids404) {
    for (const requisicao of rotasComId(`/api/crm/${encodeURIComponent(id)}`)) {
      const resposta = await chamar(env, BRENO, requisicao);
      assert.equal(resposta.status, 404, `${requisicao.method} ${requisicao.url.slice(0, 80)}`);
      assert.equal(resposta.json().error.code, 'NOT_FOUND');
    }
  }
  for (const id of ids400) {
    for (const requisicao of rotasComId(`/api/crm/${encodeURIComponent(id)}`)) {
      const resposta = await chamar(env, BRENO, requisicao);
      assert.equal(resposta.status, 400, `${requisicao.method} ${requisicao.url}`);
      assert.deepEqual(resposta.json(), { error: { code: 'INVALID_REQUEST', message: 'Identificador inválido.' } });
    }
  }
  // Percent-encoding malformado (não passa por encodeURIComponent): recusado na decodificação.
  for (const cru of ['%', '%E0%A4%A', '%ZZ', '%C0%AF']) {
    for (const requisicao of rotasComId(`/api/crm/${cru}`)) {
      const resposta = await chamar(env, BRENO, requisicao);
      assert.ok([400, 404].includes(resposta.status), `${requisicao.method} ${requisicao.url} -> ${resposta.status}`);
      assert.notEqual(resposta.status, 500);
    }
  }
  assert.equal(bytes(env), antes);
  assert.equal(registro(env, alfa.id).empresa, ALFA.empresa);
});

test('[CRM-API-26b] os mesmos ids perigosos sobre um repositório EM MEMÓRIA (o outro adapter): __proto__/constructor/prototype nunca devolvem um objeto do protótipo — 404', async (t) => {
  const repositorio = crm.createInMemoryCrmRepository();
  const { createCrmService } = require('../../src/services/crmService');
  const env = montarAmbiente(t, { usuarios: [BRENO], crmService: createCrmService({ authorizeOperation: authorizeCrmOperation, repository: repositorio }) });
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    for (const requisicao of [
      { method: 'GET', url: rota(id) },
      { method: 'GET', url: rota(id, '/history') },
      { method: 'PATCH', url: rota(id), body: { cidade: 'X' } },
      { method: 'POST', url: rota(id, '/status'), body: { to: 'RESEARCH' } },
      { method: 'POST', url: rota(id, '/dnc'), body: {} },
    ]) {
      const resposta = await chamar(env, BRENO, requisicao);
      assert.equal(resposta.status, 404, `${requisicao.method} ${requisicao.url}`);
    }
  }
  assert.deepEqual(repositorio.list(), []);
});

test('[CRM-API-27] payloads inesperados que não são registros (aninhamento profundo, números gigantes, unicode, chaves vazias) -> 400, nunca 500', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const antes = bytes(env);
  const fundo = `${'['.repeat(4000)}${']'.repeat(4000)}`;
  const corpos = [
    `{"empresa":"X","observacoes":${fundo}}`,
    `{"empresa":"X","observacoes":{"a":{"b":{"c":{"d":1}}}}}`,
    '{"empresa":"X","valorProposta":1e999}',
    '{"empresa":"X","valorProposta":-1e999}',
    '{"":"vazio","empresa":"X"}',
    '{"empresa":"X","\\u0000":"nul"}',
    '{"empresa":"X","emoji💥":"x"}',
    '{"empresa":"X","valorProposta":null,"valorTotal":"NaN"}',
  ];
  for (const corpo of corpos) {
    for (const requisicao of [
      { method: 'POST', url: '/api/crm' },
      { method: 'PATCH', url: rota(alfa.id) },
    ]) {
      const resposta = await chamar(env, BRENO, { ...requisicao, body: corpo });
      assert.equal(resposta.status, 400, `${requisicao.method} ${corpo.slice(0, 60)} -> ${resposta.status}`);
      assert.equal(resposta.json().error.code, 'INVALID_REQUEST');
    }
  }
  assert.equal(bytes(env), antes);
});

// ===========================================================================
// VAZAMENTOS — token, authUserId, stack, detalhe interno
// ===========================================================================
test('[CRM-API-28] o access token nunca aparece em nenhuma resposta nem cabeçalho nem linha de log do CRM — sucesso, recusa e erro', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true });
  const alfa = semear(env, ALFA);
  const tokenBreno = env.tokenFor(BRENO.userId);
  const tokenRafael = env.tokenFor(RAFAEL.userId);
  const tokenForjado = 'token-forjado-nao-deveria-aparecer-em-lugar-algum';

  const respostas = [
    await chamar(env, BRENO, { url: '/api/crm' }),
    await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { ...BETA } }),
    await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: { cidade: 'X' } }),
    await chamar(env, BRENO, { method: 'POST', url: rota(alfa.id, '/status'), body: { to: 'NAO_EXISTE' } }),
    await chamar(env, BRENO, { url: rota('crm:nao-existe') }),
    await chamar(env, RAFAEL, { method: 'POST', url: '/api/crm', body: { empresa: 'X' } }),
    await chamar(env, null, { url: '/api/crm', headers: { Authorization: `Bearer ${tokenForjado}` } }),
    await chamar(env, null, { url: '/api/crm' }),
  ];
  for (const resposta of respostas) {
    for (const segredo of [tokenBreno, tokenRafael, tokenForjado]) {
      assert.ok(!resposta.text.includes(segredo), 'o token não pode estar no corpo');
      assert.ok(!JSON.stringify(resposta.headers).includes(segredo), 'nem nos cabeçalhos');
    }
  }
  assert.ok(env.logs.length > 0, 'sanidade: algo foi registrado');
  for (const linha of env.logs) {
    for (const segredo of [tokenBreno, tokenRafael, tokenForjado]) assert.ok(!linha.includes(segredo), `log com token: ${linha}`);
    assert.ok(!linha.toLowerCase().includes('authorization'), `log cita Authorization: ${linha}`);
  }
});

test('[CRM-API-29] authUserId, e-mail de login e dados internos NUNCA saem — nem quando o arquivo do CRM foi adulterado com campos que não existem no modelo', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  // Adultera o arquivo: campos internos no registro e na identidade do histórico.
  const dados = JSON.parse(fs.readFileSync(env.crmFilePath, 'utf8'));
  dados[alfa.id].authUserId = 'auth-vazado-no-registro';
  dados[alfa.id].token = 'token-vazado-no-registro';
  dados[alfa.id].permissions = ['WRITE:CRM'];
  dados[alfa.id].segredoInterno = 'segredo-interno-do-armazenamento';
  dados[alfa.id].historico[0].reviewedBy = { userId: 'user-semente', name: 'Semente', role: 'ADMIN', authUserId: 'auth-vazado-no-historico', email: 'login-vazado@example.test' };
  dados[alfa.id].historico[0].tokenVazado = 'token-vazado-na-entrada';
  fs.writeFileSync(env.crmFilePath, JSON.stringify(dados));

  const respostas = [
    await chamar(env, BRENO, { url: '/api/crm' }),
    await chamar(env, BRENO, { url: rota(alfa.id) }),
    await chamar(env, BRENO, { url: rota(alfa.id, '/history') }),
    await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: { cidade: 'Nova' } }),
    await chamar(env, BRENO, { method: 'POST', url: rota(alfa.id, '/status'), body: { to: 'CONTACTED' } }),
  ];
  for (const resposta of respostas) {
    assert.equal(resposta.status, 200);
    for (const proibido of ['auth-vazado', 'token-vazado', 'segredo-interno', 'login-vazado', BRENO.authUserId, BRENO.email, 'permissions', 'authUserId']) {
      assert.ok(!resposta.text.includes(proibido), `a resposta não pode conter "${proibido}"`);
    }
  }
  const item = respostas[1].json().item;
  assert.deepEqual(Object.keys(item).sort(), CAMPOS_PUBLICOS);
  assert.deepEqual(Object.keys(item.historico[0].reviewedBy).sort(), ['name', 'role', 'userId']);
});

test('[CRM-API-30] falhas internas -> 500 GENÉRICO, sem stack, caminho, nome de arquivo nem a mensagem original; o LOG do servidor recebe o diagnóstico (e a dica do arquivo corrompido não repete o conteúdo)', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  const generico = { error: { code: 'INTERNAL', message: ERRO_INTERNO } };

  // 1. Arquivo do CRM corrompido (um pedaço do conteúdo é citado na mensagem original do adapter).
  fs.writeFileSync(env.crmFilePath, '{ "segredo-no-arquivo": ');
  for (const requisicao of rotasCrm(alfa.id)) {
    const resposta = await chamar(env, BRENO, requisicao);
    assert.equal(resposta.status, 500, `${requisicao.method} ${requisicao.url}`);
    assert.deepEqual(resposta.json(), generico);
    for (const proibido of ['crm.json', 'SyntaxError', 'JSON', 'segredo-no-arquivo', '    at ', 'node_modules', 'corrompido', env.crmFilePath]) {
      assert.ok(!resposta.text.includes(proibido), `a resposta vazou "${proibido}"`);
    }
  }
  const linhas500 = env.logs.filter((linha) => linha.startsWith('erro 500'));
  assert.equal(linhas500.length, 7);
  assert.ok(linhas500.every((linha) => linha.includes('o arquivo do CRM em disco está corrompido')), 'o log traz a dica conhecida');
  assert.ok(linhas500.every((linha) => !linha.includes('segredo-no-arquivo') && !linha.includes(env.crmFilePath)), 'o log não repete o conteúdo nem o caminho do arquivo');

  // 2. Um Service que lança erros com stack, caminho e texto interno, em cada uma das 7 operações (e coisas que nem são Error).
  const veneno = 'EACCES: permission denied, open C:\\Users\\servidor\\segredo\\crm.json';
  const operacoes = ['listRecords', 'getRecord', 'getHistory', 'createRecord', 'updateRecord', 'moveStatus', 'markDoNotContact'];
  for (const lancar of [() => new Error(veneno), () => new TypeError(veneno), () => veneno, () => ({ message: veneno, stack: `Error: ${veneno}\n    at algo (/interno.js:1:1)` }), () => undefined]) {
    const chamadas = [];
    const falhar = Object.fromEntries(operacoes.map((nome) => [nome, lancar()]));
    const envDuplo = montarAmbiente(t, { usuarios: [BRENO], crmService: criarServicoDuplo(chamadas, { falhar }) });
    for (const requisicao of rotasCrm('crm:x')) {
      const resposta = await chamar(envDuplo, BRENO, requisicao);
      assert.equal(resposta.status, 500, `${requisicao.method} ${requisicao.url}`);
      assert.deepEqual(resposta.json(), generico);
      for (const proibido of ['EACCES', 'permission denied', 'segredo', '    at ', 'C:\\']) assert.ok(!resposta.text.includes(proibido), `vazou "${proibido}"`);
    }
    assert.equal(chamadas.length, 7, 'as 7 rotas chegaram ao Service');
  }
});

test('[CRM-API-31] uma resposta de ERRO nunca traz mais que { error: { code, message } } — nenhuma chave extra, nenhum detalhe do erro original', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true });
  const alfa = semear(env, ALFA);
  const respostas = [
    await chamar(env, null, { url: '/api/crm' }),
    await chamar(env, RAFAEL, { method: 'POST', url: '/api/crm', body: { empresa: 'X' } }),
    await chamar(env, BRENO, { url: rota('crm:nao-existe') }),
    await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { empresa: 'X', site: ALFA.site } }),
    await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: { valorTotal: 'x' } }),
    await chamar(env, BRENO, { method: 'POST', url: rota(alfa.id, '/status'), body: { to: 'XYZ' } }),
    await chamar(env, BRENO, { method: 'DELETE', url: rota(alfa.id) }),
    await chamar(env, BRENO, { url: '/api/crm/a/b/c/d' }),
  ];
  for (const resposta of respostas) {
    assert.ok(resposta.status >= 400 && resposta.status < 500, `${resposta.status}`);
    const corpo = resposta.json();
    assert.deepEqual(Object.keys(corpo), ['error']);
    assert.deepEqual(Object.keys(corpo.error).sort(), ['code', 'message']);
    assert.equal(typeof corpo.error.message, 'string');
  }
});

// ===========================================================================
// CABEÇALHOS, CORS
// ===========================================================================
test('[CRM-API-32] toda resposta do CRM (sucesso e erro) sai com application/json, no-store, CSP e os cabeçalhos de segurança — e NUNCA com cabeçalhos CORS, mesmo com um Origin estrangeiro', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true });
  const alfa = semear(env, ALFA);
  const estrangeiro = { Origin: 'https://site-malicioso.example.test' };
  const respostas = [
    await chamar(env, BRENO, { url: '/api/crm', headers: estrangeiro }),
    await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { ...BETA }, headers: estrangeiro }),
    await chamar(env, BRENO, { url: rota(alfa.id, '/history'), headers: estrangeiro }),
    await chamar(env, BRENO, { url: rota('crm:nao-existe'), headers: estrangeiro }),
    await chamar(env, RAFAEL, { method: 'PATCH', url: rota(alfa.id), body: { cidade: 'X' }, headers: estrangeiro }),
    await chamar(env, null, { url: '/api/crm', headers: estrangeiro }),
    await chamar(env, BRENO, { method: 'OPTIONS', url: '/api/crm', headers: { ...estrangeiro, 'Access-Control-Request-Method': 'POST' } }),
    await chamar(env, BRENO, { method: 'DELETE', url: rota(alfa.id), headers: estrangeiro }),
  ];
  for (const resposta of respostas) {
    assert.match(resposta.headers['Content-Type'], /^application\/json/);
    assert.equal(resposta.headers['Cache-Control'], 'no-store', 'dados de CRM nunca ficam em cache');
    assert.equal(resposta.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(resposta.headers['X-Frame-Options'], 'DENY');
    assert.equal(resposta.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(resposta.headers['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.equal(resposta.headers['Cross-Origin-Opener-Policy'], 'same-origin');
    assert.ok(resposta.headers['Content-Security-Policy'].includes("default-src 'none'"));
    assert.deepEqual(Object.keys(resposta.headers).filter((nome) => /^access-control-/i.test(nome)), [], 'nenhum cabeçalho CORS');
  }
  assert.equal(respostas.at(-2).status, 405, 'um preflight OPTIONS não tem rota: 405');
});

test('[CRM-API-33] o log de operação registra só método, rota com :id, status e userId — nunca o id do registro, o corpo, o nome de uma empresa nem um campo', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const alfa = semear(env, ALFA);
  await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { empresa: 'Empresa Que Nao Pode Ir Ao Log', email: 'nao-logar@example.test' } });
  await chamar(env, BRENO, { url: rota(alfa.id) });
  await chamar(env, BRENO, { method: 'PATCH', url: rota(alfa.id), body: { observacoes: 'texto-sigiloso-de-teste' } });
  await chamar(env, BRENO, { method: 'POST', url: rota(alfa.id, '/status'), body: { to: 'CONTACTED', reason: 'motivo-sigiloso-de-teste' } });
  assert.deepEqual(env.logs, [
    `POST /api/crm 201 user=${BRENO.userId}`,
    `GET /api/crm/:id 200 user=${BRENO.userId}`,
    `PATCH /api/crm/:id 200 user=${BRENO.userId}`,
    `POST /api/crm/:id/status 200 user=${BRENO.userId}`,
  ]);
});

// ===========================================================================
// DELEGAÇÃO — a API é fina: o Service é a ÚNICA camada que autoriza
// ===========================================================================
test('[CRM-API-34] a API NÃO autoriza: um COMMERCIAL_CLOSER que escreve CHEGA ao Service (que é quem recusa), sempre com o AuthorizationContext EMITIDO a partir do token — e com os argumentos exatos', async (t) => {
  const chamadas = [];
  const env = montarAmbiente(t, { usuarios: [RAFAEL], crmService: criarServicoDuplo(chamadas) });
  await chamar(env, RAFAEL, { method: 'POST', url: '/api/crm', body: { empresa: 'Delegada', cidade: 'Lugar', status: 'RESEARCH', reason: 'porque sim' } });
  await chamar(env, RAFAEL, { method: 'PATCH', url: rota('crm:1'), body: { cidade: 'Outro Lugar' } });
  await chamar(env, RAFAEL, { method: 'POST', url: rota('crm:1', '/status'), body: { to: 'CONTACTED', reason: 'r1' } });
  await chamar(env, RAFAEL, { method: 'POST', url: rota('crm:1', '/status'), body: { to: 'WON' } });
  await chamar(env, RAFAEL, { method: 'POST', url: rota('crm:1', '/dnc'), body: { reason: 'r2' } });
  await chamar(env, RAFAEL, { method: 'POST', url: rota('crm:1', '/dnc'), body: {} });
  await chamar(env, RAFAEL, { url: '/api/crm' });
  await chamar(env, RAFAEL, { url: rota('crm:1') });
  await chamar(env, RAFAEL, { url: rota('crm:1', '/history') });

  assert.deepEqual(chamadas.map((chamada) => chamada.nome), ['createRecord', 'updateRecord', 'moveStatus', 'moveStatus', 'markDoNotContact', 'markDoNotContact', 'listRecords', 'getRecord', 'getHistory']);
  for (const chamada of chamadas) {
    const contexto = chamada.args[0];
    assert.equal(isIssuedAuthorizationContext(contexto), true, `${chamada.nome}: o contexto é o EMITIDO pelo fluxo de autenticação`);
    assert.equal(contexto.userId, RAFAEL.userId);
    assert.equal(contexto.role, RAFAEL.role);
  }
  const [criar, atualizar, mover, moverSemMotivo, dnc, dncSemMotivo, listar, obter, historico] = chamadas.map((chamada) => chamada.args);
  assert.deepEqual({ ...criar[1] }, { empresa: 'Delegada', cidade: 'Lugar' }, 'os CAMPOS não incluem as opções status/reason');
  assert.deepEqual(criar[2], { status: 'RESEARCH', reason: 'porque sim' });
  assert.deepEqual(atualizar.slice(1), ['crm:1', { cidade: 'Outro Lugar' }]);
  assert.deepEqual(mover.slice(1), ['crm:1', 'CONTACTED', { reason: 'r1' }]);
  assert.deepEqual(moverSemMotivo.slice(1), ['crm:1', 'WON', {}]);
  assert.deepEqual([dnc[1], { ...dnc[2] }], ['crm:1', { reason: 'r2' }]);
  assert.deepEqual([dncSemMotivo[1], { ...dncSemMotivo[2] }], ['crm:1', {}]);
  assert.equal(listar.length, 1, 'listRecords recebe só o contexto: a API não envia filtros');
  assert.deepEqual(obter.slice(1), ['crm:1']);
  assert.deepEqual(historico.slice(1), ['crm:1']);
});

test('[CRM-API-35] o que o Service lança vira HTTP pelo catálogo: acesso negado -> 403, usuário inativo -> 403, registro inexistente -> 404 — a API só traduz, não decide', async (t) => {
  const chamadas = [];
  const falhar = {
    listRecords: new Error('acesso negado: o contexto não possui a permissão READ:CRM'),
    getRecord: new Error('usuário inativo: acesso negado'),
    getHistory: new Error('CRM: registro não encontrado: crm:x'),
  };
  const env = montarAmbiente(t, { usuarios: [BRENO], crmService: criarServicoDuplo(chamadas, { falhar }) });
  const lista = await chamar(env, BRENO, { url: '/api/crm' });
  assert.equal(lista.status, 403);
  assert.equal(lista.json().error.code, 'FORBIDDEN');
  const um = await chamar(env, BRENO, { url: rota('crm:x') });
  assert.equal(um.status, 403);
  assert.equal(um.json().error.code, 'INACTIVE');
  const historico = await chamar(env, BRENO, { url: rota('crm:x', '/history') });
  assert.equal(historico.status, 404);
  assert.equal(historico.json().error.code, 'NOT_FOUND');
  assert.equal(chamadas.length, 3);
});

test('[CRM-API-36] createApp valida o CRM Service na criação: ausente -> as rotas /api/crm não existem (404); presente mas incompleto, null ou de outro tipo -> falha fechada', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO] }); // sem CRM
  const semCrm = await chamar(env, BRENO, { url: '/api/crm' });
  assert.equal(semCrm.status, 404, 'sem o Service injetado, a rota nem existe');
  assert.equal(semCrm.json().error.code, 'ROUTE_NOT_FOUND');
  assert.equal((await chamar(env, BRENO, { url: '/api/approvals' })).status, 200, 'o resto do app segue igual');

  const base = { verifyAccessToken: env.verifyAccessToken, userStore: env.userStore, approvalQueueService: env.approvalQueueService, publicConfig: env.publicConfig, staticRoot: env.staticRoot };
  const completo = criarServicoDuplo([]);
  for (const operacao of Object.keys(completo)) {
    const incompleto = { ...completo };
    delete incompleto[operacao];
    assert.throws(() => createApp({ ...base, crmService: incompleto }), new RegExp(`crmService.*${operacao}`), operacao);
    assert.throws(() => createApp({ ...base, crmService: { ...completo, [operacao]: 'não é função' } }), new RegExp(`crmService.*${operacao}`), operacao);
  }
  for (const invalido of [null, 0, '', 'crm', false]) {
    assert.throws(() => createApp({ ...base, crmService: invalido }), /crmService/, String(invalido));
  }
  assert.doesNotThrow(() => createApp({ ...base, crmService: completo }));
});

// ===========================================================================
// Integração com socket REAL (prova a fiação de ponta a ponta; a lógica já foi provada acima)
// ===========================================================================
function iniciarServidorReal(t, app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app.listener);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

// Um cliente HTTP de verdade (node:http, não fetch): estes testes instalam um `fetch` GLOBAL falso (o do Supabase).
function requisicaoHttp(url, { method = 'GET', headers = {}, body } = {}) {
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

test('[CRM-API-37] round-trip REAL por socket: criar -> ler -> editar -> mudar status -> histórico -> DNC, com o parser HTTP nativo do Node; e o que é recusado continua recusado', async (t) => {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true });
  const base = await iniciarServidorReal(t, env.app);
  const auth = (usuario) => ({ Authorization: `Bearer ${env.tokenFor(usuario.userId)}` });
  const json = (usuario, corpo) => ({ ...auth(usuario), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) });

  const criar = JSON.stringify({ ...ALFA, reason: 'via socket' });
  const criada = await requisicaoHttp(`${base}/api/crm`, { method: 'POST', headers: json(BRENO, criar), body: criar });
  assert.equal(criada.status, 201);
  const id = criada.json().item.id;

  const um = await requisicaoHttp(`${base}${rota(id)}`, { headers: auth(RAFAEL) });
  assert.equal(um.status, 200);
  assert.equal(um.json().item.empresa, ALFA.empresa);

  const editar = JSON.stringify({ temperatura: 'Morno' });
  assert.equal((await requisicaoHttp(`${base}${rota(id)}`, { method: 'PATCH', headers: json(BRENO, editar), body: editar })).status, 200);
  const mover = JSON.stringify({ to: 'RESPONDED', reason: 'respondeu' });
  assert.equal((await requisicaoHttp(`${base}${rota(id, '/status')}`, { method: 'POST', headers: json(BRENO, mover), body: mover })).status, 200);

  const historico = await requisicaoHttp(`${base}${rota(id, '/history')}`, { headers: auth(RAFAEL) });
  assert.deepEqual(historico.json().historico.map((entrada) => entrada.to), ['PROSPECT', 'RESPONDED']);
  assert.deepEqual(historico.json().historico.map((entrada) => entrada.reviewedBy.userId), [BRENO.userId, BRENO.userId]);

  const doCloser = await requisicaoHttp(`${base}${rota(id, '/dnc')}`, { method: 'POST', headers: json(RAFAEL, '{}'), body: '{}' });
  assert.equal(doCloser.status, 403, 'o closer não escreve');
  const semToken = await requisicaoHttp(`${base}/api/crm`);
  assert.equal(semToken.status, 401);
  assert.equal(semToken.headers['content-security-policy'].includes("default-src 'none'"), true);
  assert.equal(semToken.headers['access-control-allow-origin'], undefined);

  const dnc = JSON.stringify({ reason: 'pediu para sair' });
  assert.equal((await requisicaoHttp(`${base}${rota(id, '/dnc')}`, { method: 'POST', headers: json(BRENO, dnc), body: dnc })).status, 200);
  assert.equal(registro(env, id).status, 'DO_NOT_CONTACT');
});

test('[CRM-API-38] persistência: o que uma instância do app grava, OUTRA instância (outro Service, outro processo lógico) sobre o mesmo arquivo lê — incluindo o histórico e o bloqueio DNC', async (t) => {
  const primeiro = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const criada = (await chamar(primeiro, BRENO, { method: 'POST', url: '/api/crm', body: { ...ALFA } })).json().item;
  await chamar(primeiro, BRENO, { method: 'POST', url: rota(criada.id, '/dnc'), body: { reason: 'bloqueio persistente' } });

  const segundo = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, crmFilePath: primeiro.crmFilePath });
  const lido = (await chamar(segundo, RAFAEL, { url: rota(criada.id) })).json().item;
  assert.equal(lido.status, 'DO_NOT_CONTACT');
  assert.equal(lido.historico.length, 2);
  assert.equal(lido.historico[1].motivo, 'bloqueio persistente');
  const tentativa = await chamar(segundo, BRENO, { method: 'POST', url: '/api/crm', body: { empresa: 'Nova', site: ALFA.site } });
  assert.equal(tentativa.status, 409, 'a segunda instância também enxerga o bloqueio DNC gravado pela primeira');
  assert.equal(tentativa.json().error.code, 'DNC_BLOCKED');
});
