// Approval Queue Service — a fronteira de aplicação da fila de aprovação humana.
//
//   CONSUMIDOR -> SERVICE -> DOMÍNIO (approvalQueue.js) -> persistência atual (arquivo)
//
// O que estes testes protegem: o Service autoriza (APPROVE:LEAD_APPROVAL, decidido pelo autorizador injetado —
// aqui, a ponte real de src/auth) ANTES de qualquer outra coisa; só aceita um AuthorizationContext emitido, nunca
// userId, role ou permissions do consumidor; chama o domínio só com o necessário; persiste pelo mecanismo atual;
// devolve cópias; e deixa passar intactos os erros do domínio.
//
// Isolamento: o domínio é o REAL, sobre uma fila em arquivo TEMPORÁRIO montada por ele mesmo (nenhum dado real,
// nenhum arquivo do projeto é tocado), e o autorizador é a ponte REAL de src/auth. Os "doubles" existem só onde
// não há outro jeito de provar o ponto, e nenhum esconde a lógica principal: um observador que DELEGA ao domínio real
// e só registra as chamadas (para provar o que o Service passa ao domínio e ao autorizador), autorizadores
// defeituosos ou permissivos (SVC-19/20), uma falha de gravação simulada (SVC-15) e uma cópia mutável do domínio (SVC-1).
//
// Determinístico e sem rede. As marcas de contexto são uma fronteira arquitetural interna confiável, NÃO
// criptografia.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const domain = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');
const serviceModule = require('../../src/services/approvalQueueService');
const {
  ROLE,
  USER_STATUS,
  PERMISSION,
  defineUser,
  createUserStore,
  resolveAuthorizationContext,
  authorizeReviewerForApprovalQueue,
  toApprovalQueueIdentity,
} = require('../../src/auth');
const constants = require('../../src/auth/constants');
const { createAuthorizationContext, verifiedIdentitiesFor } = require('../helpers/authFixtures');
const { analyzeSource } = require('../helpers/staticImports');

const { createApprovalQueueService } = serviceModule;
const { QUEUE_STATE, ACTOR } = domain;

const SERVICE_SOURCE = path.join(__dirname, '..', '..', 'src', 'services', 'approvalQueueService.js');
const ADMIN_LITERAL = ['READ:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'WRITE:CRM', 'APPROVE:LEAD_APPROVAL', 'APPROVE:OUTBOUND_APPROVAL', 'MANAGE:USERS'];

// ---------------------------------------------------------------------------
// Fixtures (fictícias)
// ---------------------------------------------------------------------------
const briefing = { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', quantidadeDesejada: 10, exclusoes: [] };

function achado(empresa, site) {
  return {
    empresa,
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: { site: [{ valor: site, fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
    fontes: [],
  };
}

function descoberta(rawFinding, crmRecords = []) {
  return runDiscoveryPipeline({ briefing, rawFindings: [rawFinding], crmRecords }).resultados[0];
}

// Uma fila REAL em arquivo temporário (removido ao fim do teste), montada pelo próprio domínio:
// alfa, beta e gama aguardam revisão; "bloqueado" é DNC.
function novaFila(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'approval-queue.json');
  const queue = domain.createEmptyQueue();
  const alfa = domain.addProspect(queue, descoberta(achado('Consultório Alfa', 'consultorio-alfa.example.test')));
  const beta = domain.addProspect(queue, descoberta(achado('Consultório Beta', 'consultorio-beta.example.test')));
  const gama = domain.addProspect(queue, descoberta(achado('Consultório Gama', 'consultorio-gama.example.test')));
  const bloqueado = domain.addProspect(
    queue,
    descoberta(achado('Clínica Bloqueada', 'clinica-bloqueada.example.test'), [
      { empresa: 'Bloqueada', site: 'https://clinica-bloqueada.example.test', doNotContact: true },
    ])
  );
  domain.saveQueueToDisk(queue, filePath);
  return { filePath, ids: { alfa: alfa.prospectId, beta: beta.prospectId, gama: gama.prospectId, bloqueado: bloqueado.prospectId } };
}

const lerArquivo = (filePath) => fs.readFileSync(filePath, 'utf8');

// Usuários e contextos REAIS (emitidos pelo emissor interno a partir de um USER definido).
const usuario = (overrides = {}) =>
  defineUser({
    userId: 'user-svc-1',
    authUserId: 'auth-svc-1',
    name: 'Closer do Serviço',
    email: 'closer-svc@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });
const contexto = (overrides) => createAuthorizationContext(usuario(overrides));

// O Service de produção: domínio real, autorizador real (a ponte de src/auth), fila em arquivo.
const criarServico = (filePath, extras = {}) =>
  createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: filePath, ...extras });

// As 5 operações do Service, com argumentos típicos — para exercitar todas de uma vez.
const operacoes = (servico, ids) => [
  ['listQueue', (ctx) => servico.listQueue(ctx)],
  ['getProspect', (ctx) => servico.getProspect(ctx, ids.alfa)],
  ['getHistory', (ctx) => servico.getHistory(ctx, ids.alfa)],
  ['approveProspect', (ctx) => servico.approveProspect(ctx, ids.alfa, { reason: 'ok' })],
  ['rejectProspect', (ctx) => servico.rejectProspect(ctx, ids.alfa, { reason: 'sem fit' })],
];

// Um observador do domínio: DELEGA a tudo ao domínio real e só registra as chamadas [nome, argumentos].
function domainoObservado(chamadas, sobrescritas = {}) {
  const registrar = (nome, funcao) => (...args) => {
    chamadas.push([nome, args]);
    return funcao(...args);
  };
  return {
    ...domain,
    createApprovalReviewActions(opcoes) {
      chamadas.push(['createApprovalReviewActions', [opcoes]]);
      const acoes = domain.createApprovalReviewActions(opcoes);
      return Object.freeze({
        approveProspect: registrar('approveProspect', acoes.approveProspect),
        rejectProspect: registrar('rejectProspect', acoes.rejectProspect),
      });
    },
    loadQueueFromDisk: registrar('loadQueueFromDisk', domain.loadQueueFromDisk),
    saveQueueToDisk: registrar('saveQueueToDisk', domain.saveQueueToDisk),
    getProspect: registrar('getProspect', domain.getProspect),
    listQueue: registrar('listQueue', domain.listQueue),
    getHistory: registrar('getHistory', domain.getHistory),
    ...sobrescritas,
  };
}

// Contextos que NÃO são um AuthorizationContext emitido: a antiga identidade simples, literais, cópias, clones e
// não-objetos — nenhum pode atravessar a fronteira.
function contextosNaoEmitidos() {
  const legitimo = contexto({ role: ROLE.ADMIN });
  const simples = { userId: legitimo.userId, name: legitimo.name, role: legitimo.role, permissions: [...legitimo.permissions] };
  const literal = { ...simples, authUserId: legitimo.authUserId, status: legitimo.status };
  return [
    ['texto livre (o antigo reviewer)', 'Breno'],
    ['um userId solto', legitimo.userId],
    ['número', 42],
    ['lista', []],
    ['função', () => legitimo],
    ['objeto vazio', {}],
    ['identidade simples { userId, name, role, permissions }', simples],
    ['identidade simples congelada', Object.freeze({ ...simples, permissions: Object.freeze([...simples.permissions]) })],
    ['literal com a forma perfeita de um contexto, congelado', Object.freeze({ ...literal, permissions: Object.freeze([...literal.permissions]) })],
    ['cópia rasa de um contexto real', { ...legitimo }],
    ['structuredClone de um contexto real', structuredClone(legitimo)],
    ['clone via JSON de um contexto real', JSON.parse(JSON.stringify(legitimo))],
    ['Object.create(contexto real)', Object.create(legitimo)],
    ['Proxy(contexto real)', new Proxy(legitimo, {})],
  ];
}

// Executa `fn` e devolve o erro lançado (ou null).
function erroDe(fn) {
  try {
    fn();
  } catch (erro) {
    return erro;
  }
  return null;
}

// ===========================================================================
// 1) O Service cria com dependências válidas — e falha fechado sem elas
// ===========================================================================
test('[SVC-1] o Service cria com dependências válidas (congelado, só as 5 operações) e falha fechado NA CRIAÇÃO com dependências ausentes ou inválidas', (t) => {
  const { filePath, ids } = novaFila(t);
  const servico = criarServico(filePath);

  assert.equal(Object.isFrozen(servico), true);
  assert.deepEqual(Object.keys(servico).sort(), ['approveProspect', 'getHistory', 'getProspect', 'listQueue', 'rejectProspect']);
  for (const nome of Object.keys(servico)) assert.equal(typeof servico[nome], 'function', nome);

  // Sem autorizador o Service nem existe: nenhum valor que não seja uma função serve.
  for (const semAutorizador of [
    undefined,
    null,
    {},
    { authorizeReviewer: undefined },
    { authorizeReviewer: null },
    { authorizeReviewer: 'autorizo' },
    { authorizeReviewer: {} },
    { authorizeReviewer: true },
    { queuePath: filePath },
    42,
    'x',
    [],
  ]) {
    // A mensagem é a do SERVICE (o domínio também recusaria, com outro texto): é o Service que precisa falhar na criação.
    assert.throws(() => createApprovalQueueService(semAutorizador), /^Error: createApprovalQueueService exige \{ authorizeReviewer \}/m, `dependências: ${String(semAutorizador)}`);
  }

  // Um domínio incompleto ou inválido falha na criação, dizendo qual função falta.
  for (const nome of ['createApprovalReviewActions', 'loadQueueFromDisk', 'saveQueueToDisk', 'getProspect', 'listQueue', 'getHistory']) {
    assert.throws(() => criarServico(filePath, { approvalQueue: { ...domain, [nome]: undefined } }), new RegExp(`não tem a função ${nome}\\(\\)`), nome);
  }
  for (const invalido of [null, 'domínio', 42, () => {}]) {
    assert.throws(() => criarServico(filePath, { approvalQueue: invalido }), /approvalQueue/, String(invalido));
  }
  assert.throws(() => criarServico(filePath, { approvalQueue: { ...domain, QUEUE_STATE: undefined } }), /QUEUE_STATE/);
  assert.throws(
    () => criarServico(filePath, { approvalQueue: { ...domain, createApprovalReviewActions: () => ({}) } }),
    /não devolveu as ações de revisão/
  );

  // queuePath, quando informado, precisa ser um texto não vazio.
  for (const ruim of ['', '   ', 42, null, {}, []]) {
    assert.throws(() => criarServico(filePath, { queuePath: ruim }), /queuePath/, String(ruim));
  }

  // O que o Service usa do domínio é capturado NA CRIAÇÃO: mexer no objeto injetado depois (trocar uma função por outra, ou
  // alterar os estados) não muda o Service — o que foi validado na criação é o que roda.
  const alteravel = { ...domain, QUEUE_STATE: { ...domain.QUEUE_STATE } };
  const capturado = criarServico(filePath, { approvalQueue: alteravel });
  const inutilizada = () => {
    throw new Error('o Service não pode buscar isto no domínio depois da criação');
  };
  for (const nome of ['createApprovalReviewActions', 'loadQueueFromDisk', 'saveQueueToDisk', 'getProspect', 'listQueue', 'getHistory']) {
    alteravel[nome] = inutilizada;
  }
  alteravel.QUEUE_STATE.INJETADO = 'INJETADO';
  delete alteravel.QUEUE_STATE.DNC;
  const ctx = contexto();
  assert.equal(capturado.listQueue(ctx).length, 4);
  assert.equal(capturado.listQueue(ctx, { estado: QUEUE_STATE.DNC }).length, 1, 'um estado removido do objeto depois da criação continua conhecido');
  assert.throws(() => capturado.listQueue(ctx, { estado: 'INJETADO' }), /estado desconhecido/, 'um estado acrescentado depois da criação continua desconhecido');
  assert.equal(capturado.getProspect(ctx, ids.alfa).prospectId, ids.alfa);
  assert.equal(capturado.getHistory(ctx, ids.alfa).length, 1);
  assert.equal(capturado.approveProspect(ctx, ids.alfa, { reason: 'ok' }).estado, QUEUE_STATE.APROVADO_PARA_CRM);
});

// ===========================================================================
// 2) Leitura permitida
// ===========================================================================
test('[SVC-2] a leitura é permitida ao contexto com a permissão: listQueue (com e sem filtro), getProspect e getHistory — ADMIN e CLOSER', (t) => {
  const { filePath, ids } = novaFila(t);
  const servico = criarServico(filePath);

  for (const role of [ROLE.ADMIN, ROLE.COMMERCIAL_CLOSER]) {
    const ctx = contexto({ role });

    const todos = servico.listQueue(ctx);
    assert.deepEqual(todos.map((p) => p.prospectId).sort(), Object.values(ids).sort(), role);
    assert.equal(servico.listQueue(ctx, { estado: QUEUE_STATE.AGUARDANDO_REVISAO }).length, 3, role);
    assert.deepEqual(servico.listQueue(ctx, { estado: QUEUE_STATE.DNC }).map((p) => p.prospectId), [ids.bloqueado], role);
    assert.deepEqual(servico.listQueue(ctx, { estado: QUEUE_STATE.APROVADO_PARA_CRM }), [], role);
    // estado ausente ou nulo = sem filtro; opções ausentes ou nulas = sem opções
    assert.equal(servico.listQueue(ctx, {}).length, 4);
    assert.equal(servico.listQueue(ctx, { estado: null }).length, 4);
    assert.equal(servico.listQueue(ctx, null).length, 4);
    assert.equal(servico.listQueue(ctx, undefined).length, 4);

    const alfa = servico.getProspect(ctx, ids.alfa);
    assert.equal(alfa.prospectId, ids.alfa, role);
    assert.equal(alfa.estado, QUEUE_STATE.AGUARDANDO_REVISAO, role);
    assert.equal(alfa.empresa, 'Consultório Alfa', role);
    // O domínio devolve null para um prospect inexistente — o Service preserva isso.
    assert.equal(servico.getProspect(ctx, 'id:que-nao-existe'), null, role);

    const historico = servico.getHistory(ctx, ids.alfa);
    assert.equal(historico.length, 1, role);
    assert.equal(historico[0].to, QUEUE_STATE.AGUARDANDO_REVISAO, role);
    assert.equal(historico[0].actor, ACTOR.SYSTEM, role);
  }
});

// ===========================================================================
// 3) Aprovação autorizada
// ===========================================================================
test('[SVC-3] a aprovação autorizada funciona: transita, grava o reviewedBy do CONTEXTO, persiste no arquivo e devolve uma cópia', (t) => {
  const { filePath, ids } = novaFila(t);
  const servico = criarServico(filePath);
  const ctx = contexto({ userId: 'user-svc-aprova', authUserId: 'auth-svc-aprova', name: 'Aprovadora', role: ROLE.ADMIN });

  const retorno = servico.approveProspect(ctx, ids.alfa, { reason: 'Bom fit — aprovado' });
  assert.equal(retorno.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  const ultimo = retorno.historico[retorno.historico.length - 1];
  assert.deepEqual(ultimo.reviewedBy, { userId: 'user-svc-aprova', name: 'Aprovadora', role: ROLE.ADMIN });
  assert.equal(ultimo.actor, ACTOR.HUMAN);
  assert.equal(ultimo.motivo, 'Bom fit — aprovado');
  assert.equal(ultimo.from, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(ultimo.to, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.ok(ultimo.timestamp);

  // Persistiu pelo mecanismo atual: recarregando o arquivo com o próprio domínio.
  const recarregada = domain.loadQueueFromDisk(filePath);
  assert.equal(domain.getProspect(recarregada, ids.alfa).estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.deepEqual(domain.getHistory(recarregada, ids.alfa), retorno.historico);
  // Os demais prospects não mudaram.
  for (const outro of [ids.beta, ids.gama]) assert.equal(domain.getProspect(recarregada, outro).estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(domain.getProspect(recarregada, ids.bloqueado).estado, QUEUE_STATE.DNC);

  // O motivo é opcional na aprovação — e opções nulas (ou vazias) são "sem opções".
  const semMotivo = servico.approveProspect(ctx, ids.beta);
  assert.equal(semMotivo.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(semMotivo.historico[semMotivo.historico.length - 1].motivo, null);
  const opcoesNulas = servico.approveProspect(ctx, ids.gama, null);
  assert.equal(opcoesNulas.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(opcoesNulas.historico[opcoesNulas.historico.length - 1].motivo, null);
});

// ===========================================================================
// 4) Rejeição autorizada
// ===========================================================================
test('[SVC-4] a rejeição autorizada funciona: exige motivo (regra do domínio), grava o reviewedBy do CONTEXTO e persiste', (t) => {
  const { filePath, ids } = novaFila(t);
  const servico = criarServico(filePath);
  const ctx = contexto({ userId: 'user-svc-rejeita', authUserId: 'auth-svc-rejeita', name: 'Rejeitador', role: ROLE.COMMERCIAL_CLOSER });

  const antes = lerArquivo(filePath);
  // O motivo obrigatório é do DOMÍNIO; o Service só valida o tipo. Nada é gravado quando falha.
  assert.throws(() => servico.rejectProspect(ctx, ids.beta), /rejeição exige um motivo/);
  assert.throws(() => servico.rejectProspect(ctx, ids.beta, {}), /rejeição exige um motivo/);
  assert.throws(() => servico.rejectProspect(ctx, ids.beta, { reason: '   ' }), /rejeição exige um motivo/);
  assert.throws(() => servico.rejectProspect(ctx, ids.beta, { reason: 42 }), /reason deve ser um texto/);
  assert.equal(lerArquivo(filePath), antes, 'nada foi gravado');

  const retorno = servico.rejectProspect(ctx, ids.beta, { reason: 'Fora do ICP' });
  assert.equal(retorno.estado, QUEUE_STATE.REJEITADO);
  const ultimo = retorno.historico[retorno.historico.length - 1];
  assert.deepEqual(ultimo.reviewedBy, { userId: 'user-svc-rejeita', name: 'Rejeitador', role: ROLE.COMMERCIAL_CLOSER });
  assert.equal(ultimo.actor, ACTOR.HUMAN);
  assert.equal(ultimo.motivo, 'Fora do ICP');

  const recarregada = domain.loadQueueFromDisk(filePath);
  assert.equal(domain.getProspect(recarregada, ids.beta).estado, QUEUE_STATE.REJEITADO);
  assert.equal(domain.getProspect(recarregada, ids.alfa).estado, QUEUE_STATE.AGUARDANDO_REVISAO);
});

// ===========================================================================
// 5) Contexto sem APPROVE:LEAD_APPROVAL
// ===========================================================================
test('[SVC-5] um contexto SEM APPROVE:LEAD_APPROVAL falha em TODAS as operações — sem tocar no arquivo e sem chamar o domínio', (t) => {
  const { filePath, ids } = novaFila(t);
  const antes = lerArquivo(filePath);
  const chamadas = [];
  const servico = criarServico(filePath, { approvalQueue: domainoObservado(chamadas) });
  chamadas.length = 0; // descarta a chamada da criação

  // Nenhuma role atual carece da permissão. O cenário é reproduzido SEM forjar nada: contextos REAIS emitidos sob uma
  // derivação role -> permissions reduzida (só neste teste) — a decisão lê só `permissions`, nunca a role.
  const usuarios = [usuario({ role: ROLE.ADMIN, userId: 'user-svc-admin', authUserId: 'auth-svc-admin', email: 'admin-svc@example.test' }), usuario()];
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  const cenarios = [[PERMISSION.READ_CRM], [], [PERMISSION.APPROVE_OUTBOUND_APPROVAL], [PERMISSION.WRITE_CRM, PERMISSION.MANAGE_USERS]];
  for (const cenario of cenarios) {
    derivacao.mock.mockImplementation(() => Object.freeze([...cenario]));
    for (const u of usuarios) {
      const ctx = createAuthorizationContext(u);
      assert.equal(ctx.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), false);
      for (const [nome, operar] of operacoes(servico, ids)) {
        assert.throws(() => operar(ctx), /acesso negado/, `${nome}: ${u.role} com [${cenario.join(', ')}]`);
      }
    }
  }

  assert.equal(lerArquivo(filePath), antes, 'o arquivo não foi tocado');
  assert.deepEqual(chamadas, [], 'o domínio nem foi chamado (nem para ler)');
});

// ===========================================================================
// 6) Contexto inválido
// ===========================================================================
test('[SVC-6] um contexto inválido falha em todas as operações: identidade simples, literal, cópia, clone, Proxy, não-objetos — sem tocar no arquivo', (t) => {
  const { filePath, ids } = novaFila(t);
  const antes = lerArquivo(filePath);
  const chamadas = [];
  const servico = criarServico(filePath, { approvalQueue: domainoObservado(chamadas) });
  chamadas.length = 0;

  for (const [rotulo, invalido] of contextosNaoEmitidos()) {
    for (const [nome, operar] of operacoes(servico, ids)) {
      assert.throws(() => operar(invalido), /AuthorizationContext inválido/, `${nome}: ${rotulo}`);
    }
  }
  assert.equal(lerArquivo(filePath), antes, 'o arquivo não foi tocado');
  assert.deepEqual(chamadas, [], 'o domínio nem foi chamado');

  // Controle: um contexto emitido de verdade continua funcionando depois de todas as tentativas.
  assert.equal(servico.listQueue(contexto()).length, 4);
});

// ===========================================================================
// 7) Ausência de contexto
// ===========================================================================
test('[SVC-7] a ausência de contexto falha em todas as operações (undefined, null, nenhum argumento) — sem tocar no arquivo', (t) => {
  const { filePath, ids } = novaFila(t);
  const antes = lerArquivo(filePath);
  const chamadas = [];
  const servico = criarServico(filePath, { approvalQueue: domainoObservado(chamadas) });
  chamadas.length = 0;

  for (const ausente of [undefined, null]) {
    for (const [nome, operar] of operacoes(servico, ids)) {
      assert.throws(() => operar(ausente), /AuthorizationContext inválido/, `${nome}: ${String(ausente)}`);
    }
  }
  // Sem nenhum argumento (nem contexto, nem id, nem opções).
  for (const nome of Object.keys(servico)) {
    assert.throws(() => servico[nome](), /AuthorizationContext inválido/, `${nome}() sem argumentos`);
  }
  assert.equal(lerArquivo(filePath), antes);
  assert.deepEqual(chamadas, []);
});

// ===========================================================================
// 8) Usuário inativo
// ===========================================================================
test('[SVC-8] um usuário INACTIVE falha em todas as operações, mesmo com a permissão e a forma corretas — sem tocar no arquivo', (t) => {
  const { filePath, ids } = novaFila(t);
  const antes = lerArquivo(filePath);
  const chamadas = [];
  const servico = criarServico(filePath, { approvalQueue: domainoObservado(chamadas) });
  chamadas.length = 0;

  for (const role of [ROLE.ADMIN, ROLE.COMMERCIAL_CLOSER]) {
    const inativo = contexto({ role, status: USER_STATUS.INACTIVE });
    assert.equal(inativo.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), true, 'o contexto inativo carrega a permissão: a recusa vem do status');
    for (const [nome, operar] of operacoes(servico, ids)) {
      assert.throws(() => operar(inativo), /usuário inativo/, `${nome}: ${role}`);
    }
  }
  assert.equal(lerArquivo(filePath), antes);
  assert.deepEqual(chamadas, []);
});

// ===========================================================================
// 9) Contexto fabricado não atravessa a fronteira
// ===========================================================================
test('[SVC-9] um contexto FABRICADO a partir de um legítimo não atravessa: promovido a ADMIN, com permissão a mais, Proxy, userId trocado, saída do adaptador legado', (t) => {
  const { filePath, ids } = novaFila(t);
  const antes = lerArquivo(filePath);
  const servico = criarServico(filePath);
  const legitimo = contexto({ role: ROLE.COMMERCIAL_CLOSER });

  const forjados = [
    ['cópia promovida a ADMIN', { ...legitimo, role: ROLE.ADMIN, permissions: [...ADMIN_LITERAL] }],
    ['cópia congelada promovida a ADMIN', Object.freeze({ ...legitimo, role: ROLE.ADMIN, permissions: Object.freeze([...ADMIN_LITERAL]) })],
    ['Object.create(legítimo) com a role trocada', Object.create(legitimo, { role: { value: ROLE.ADMIN } })],
    [
      'Proxy do legítimo forjando role e permissions',
      new Proxy(legitimo, { get: (alvo, prop) => (prop === 'role' ? ROLE.ADMIN : prop === 'permissions' ? [...ADMIN_LITERAL] : alvo[prop]) }),
    ],
    ['structuredClone com o userId trocado', { ...structuredClone(legitimo), userId: 'user-de-outra-pessoa' }],
    ['JSON com a permissão MANAGE:USERS a mais', JSON.parse(JSON.stringify({ ...legitimo, permissions: [...legitimo.permissions, PERMISSION.MANAGE_USERS] }))],
    ['a saída do adaptador legado toApprovalQueueIdentity', toApprovalQueueIdentity(legitimo)],
    ['identidade simples completa', { userId: legitimo.userId, name: legitimo.name, role: legitimo.role, permissions: [...legitimo.permissions] }],
  ];
  for (const [rotulo, forjado] of forjados) {
    for (const [nome, operar] of operacoes(servico, ids)) {
      assert.throws(() => operar(forjado), /AuthorizationContext inválido/, `${nome}: ${rotulo}`);
    }
  }
  assert.equal(lerArquivo(filePath), antes, 'nenhuma fabricação gravou nada');

  // O legítimo, intocado, segue funcionando.
  assert.equal(servico.approveProspect(legitimo, ids.alfa, { reason: 'ok' }).estado, QUEUE_STATE.APROVADO_PARA_CRM);
});

// ===========================================================================
// 10-12) userId, role e permissions do consumidor não substituem o contexto
// ===========================================================================
// As operações que leem opções, cada uma com as suas opções VÁLIDAS de base: o que o teste acrescenta em `extras` é a única
// coisa "sobrando" (senão uma chave desconhecida de outra operação, como `reason` em listQueue, esconderia o que se testa).
const chamadasComOpcoes = (servico, ids, ctx) => [
  ['approveProspect', (extras) => servico.approveProspect(ctx, ids.alfa, { reason: 'ok', ...extras })],
  ['rejectProspect', (extras) => servico.rejectProspect(ctx, ids.alfa, { reason: 'ok', ...extras })],
  ['listQueue', (extras) => servico.listQueue(ctx, { estado: QUEUE_STATE.AGUARDANDO_REVISAO, ...extras })],
];

test('[SVC-10] um userId fornecido pelo consumidor NÃO substitui a identidade autenticada: é recusado, e o reviewedBy é sempre o do contexto', (t) => {
  const { filePath, ids } = novaFila(t);
  const chamadas = [];
  const servico = criarServico(filePath, { approvalQueue: domainoObservado(chamadas) });
  chamadas.length = 0;
  const ctx = contexto({ userId: 'user-svc-real', authUserId: 'auth-svc-real', name: 'Revisor Real' });
  const antes = lerArquivo(filePath);

  const identidadesDoConsumidor = [
    { userId: 'user-atacante' },
    { authUserId: 'auth-atacante' },
    { name: 'Outro Nome' },
    { reviewedBy: { userId: 'user-atacante', name: 'Atacante', role: ROLE.ADMIN } },
    { reviewer: 'Breno' },
    { actor: 'HUMAN' },
    { identity: { userId: 'user-atacante', name: 'Atacante', role: ROLE.ADMIN, permissions: [...ADMIN_LITERAL] } },
  ];
  for (const [nome, chamar] of chamadasComOpcoes(servico, ids, ctx)) {
    for (const extras of identidadesDoConsumidor) {
      assert.throws(() => chamar(extras), /opções não reconhecidas/, `${nome}: ${Object.keys(extras)}`);
    }
  }
  assert.equal(lerArquivo(filePath), antes, 'nada foi gravado');
  assert.deepEqual(chamadas, [], 'o domínio nem foi chamado com essas opções');

  // Um userId no lugar do contexto também não serve.
  assert.throws(() => servico.approveProspect('user-svc-real', ids.alfa, { reason: 'ok' }), /AuthorizationContext inválido/);
  assert.throws(() => servico.approveProspect({ userId: 'user-svc-real' }, ids.alfa, { reason: 'ok' }), /AuthorizationContext inválido/);

  // O caminho legítimo grava a identidade do CONTEXTO, e só ela.
  const aprovado = servico.approveProspect(ctx, ids.alfa, { reason: 'ok' });
  assert.deepEqual(aprovado.historico[aprovado.historico.length - 1].reviewedBy, {
    userId: 'user-svc-real',
    name: 'Revisor Real',
    role: ROLE.COMMERCIAL_CLOSER,
  });
});

test('[SVC-11] uma role fornecida pelo consumidor NÃO substitui a role do contexto: é recusada, e o reviewedBy carrega a role do contexto', (t) => {
  const { filePath, ids } = novaFila(t);
  const servico = criarServico(filePath);
  const closer = contexto({ role: ROLE.COMMERCIAL_CLOSER });
  const antes = lerArquivo(filePath);

  for (const [nome, chamar] of chamadasComOpcoes(servico, ids, closer)) {
    for (const role of [ROLE.ADMIN, ROLE.COMMERCIAL_CLOSER, 'SYSTEM', 'SUPER_ADMIN']) {
      assert.throws(() => chamar({ role }), /opções não reconhecidas:.*\brole\b/, `${nome}: role ${role}`);
    }
  }
  assert.equal(lerArquivo(filePath), antes);

  // Um contexto "de ADMIN" só existe se foi emitido para um USER ADMIN: um literal ou uma cópia promovida não serve.
  assert.throws(() => servico.approveProspect({ ...closer, role: ROLE.ADMIN }, ids.alfa, { reason: 'ok' }), /AuthorizationContext inválido/);

  const aprovado = servico.approveProspect(closer, ids.alfa, { reason: 'ok' });
  assert.equal(aprovado.historico[aprovado.historico.length - 1].reviewedBy.role, ROLE.COMMERCIAL_CLOSER);
});

test('[SVC-12] permissions fornecidas pelo consumidor NÃO substituem as do contexto: um contexto sem a permissão não a ganha, e o que vale é só `permissions` do contexto', (t) => {
  const { filePath, ids } = novaFila(t);
  const chamadas = [];
  const servico = criarServico(filePath, { approvalQueue: domainoObservado(chamadas) });
  chamadas.length = 0;
  const antes = lerArquivo(filePath);

  // (a) Um contexto REAL sem a permissão (derivação reduzida só para emiti-lo) + permissions "concedidas" nas
  // opções: recusado pela AUTORIZAÇÃO (que vem antes de tudo), não pela validação das opções.
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  const semPermissao = createAuthorizationContext(usuario());
  derivacao.mock.restore();
  assert.equal(semPermissao.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), false);
  const concedidas = [{ permissions: [PERMISSION.APPROVE_LEAD_APPROVAL] }, { permissions: [...ADMIN_LITERAL] }, { permission: PERMISSION.APPROVE_LEAD_APPROVAL }];
  for (const [nome, chamar] of chamadasComOpcoes(servico, ids, semPermissao)) {
    for (const extras of concedidas) {
      assert.throws(() => chamar(extras), /acesso negado/, `${nome}: ${Object.keys(extras)}`);
    }
  }
  assert.deepEqual(chamadas, [], 'permissions nas opções não abrem nem o disco: a autorização vem primeiro, sem I/O');

  // (b) Um contexto legítimo COM a permissão + permissions nas opções: recusado como opção desconhecida.
  const legitimo = contexto();
  for (const [nome, chamar] of chamadasComOpcoes(servico, ids, legitimo)) {
    for (const extras of concedidas) {
      assert.throws(() => chamar(extras), /opções não reconhecidas/, `${nome}: ${Object.keys(extras)}`);
    }
  }
  assert.deepEqual(chamadas, [], 'as opções são validadas antes de qualquer acesso ao disco');

  // (c) O array `permissions` do contexto não é alterável, e uma cópia com permissions alteradas não é um contexto.
  assert.equal(Reflect.set(semPermissao, 'permissions', [PERMISSION.APPROVE_LEAD_APPROVAL]), false);
  assert.throws(() => Reflect.apply(Array.prototype.push, semPermissao.permissions, [PERMISSION.APPROVE_LEAD_APPROVAL]), TypeError);
  assert.throws(
    () => servico.approveProspect({ ...semPermissao, permissions: [PERMISSION.APPROVE_LEAD_APPROVAL] }, ids.alfa, { reason: 'ok' }),
    /AuthorizationContext inválido/
  );

  assert.equal(lerArquivo(filePath), antes, 'nada foi gravado');
});

// ===========================================================================
// 13) O domínio recebe só o necessário
// ===========================================================================
test('[SVC-13] o domínio e o autorizador recebem só o necessário: o autorizador, só (contexto, APPROVE:LEAD_APPROVAL); a fábrica, só o autorizador; as ações, só (fila, id, contexto, motivo); o disco, só o caminho — nada do que o consumidor acrescente', (t) => {
  const { filePath, ids } = novaFila(t);
  const chamadas = [];
  const servico = criarServico(filePath, { approvalQueue: domainoObservado(chamadas) });
  const ctx = contexto();

  // Na criação: UMA chamada à fábrica, só com o autorizador injetado.
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0][0], 'createApprovalReviewActions');
  assert.equal(chamadas[0][1].length, 1);
  assert.deepEqual(Object.keys(chamadas[0][1][0]), ['authorizeReviewer']);
  assert.equal(chamadas[0][1][0].authorizeReviewer, authorizeReviewerForApprovalQueue, 'o MESMO autorizador injetado');
  chamadas.length = 0;

  // Aprovar, com argumentos extras que o consumidor tenta acrescentar: nada disso chega ao domínio.
  servico.approveProspect(ctx, ids.alfa, { reason: 'ok' }, 'sobra', { userId: 'atacante', role: ROLE.ADMIN, permissions: ADMIN_LITERAL });
  assert.deepEqual(chamadas.map(([nome]) => nome), ['loadQueueFromDisk', 'approveProspect', 'saveQueueToDisk']);
  const [carga, aprovacao, gravacao] = chamadas;
  assert.deepEqual(carga[1], [filePath]);
  assert.equal(aprovacao[1].length, 4, 'a ação recebe exatamente (fila, id, contexto, motivo)');
  const [fila, id, contextoRecebido, motivo] = aprovacao[1];
  assert.ok(fila && typeof fila.items === 'object');
  assert.equal(id, ids.alfa);
  assert.equal(contextoRecebido, ctx, 'o contexto autorizado é repassado como está');
  assert.equal(motivo, 'ok');
  assert.equal(gravacao[1].length, 2);
  assert.equal(gravacao[1][0], fila, 'grava a MESMA fila que a ação alterou');
  assert.equal(gravacao[1][1], filePath);

  // Rejeitar: idem.
  chamadas.length = 0;
  servico.rejectProspect(ctx, ids.beta, { reason: 'sem fit' }, 'sobra');
  assert.deepEqual(chamadas.map(([nome]) => nome), ['loadQueueFromDisk', 'rejectProspect', 'saveQueueToDisk']);
  assert.equal(chamadas[1][1].length, 4);
  assert.deepEqual([chamadas[1][1][1], chamadas[1][1][2], chamadas[1][1][3]], [ids.beta, ctx, 'sem fit']);

  // Leituras: só (fila, id) ou (fila, filtro) — e o contexto nunca é passado ao domínio numa leitura.
  chamadas.length = 0;
  servico.getProspect(ctx, ids.alfa, { userId: 'atacante' });
  servico.getHistory(ctx, ids.alfa, { userId: 'atacante' });
  servico.listQueue(ctx, { estado: QUEUE_STATE.DNC });
  assert.deepEqual(chamadas.map(([nome, args]) => [nome, args.length]), [
    ['loadQueueFromDisk', 1],
    ['getProspect', 2],
    ['loadQueueFromDisk', 1],
    ['getHistory', 2],
    ['loadQueueFromDisk', 1],
    ['listQueue', 2],
  ]);
  for (const [, args] of chamadas.filter(([nome]) => ['getProspect', 'getHistory', 'listQueue'].includes(nome))) {
    assert.ok(!args.includes(ctx), 'uma leitura não leva o contexto ao domínio');
  }
  assert.equal(chamadas[5][1][1], QUEUE_STATE.DNC);

  // "Sem filtro" chega ao domínio do jeito que o domínio o entende (undefined), seja qual for a forma que o consumidor usou.
  for (const semFiltro of [undefined, null, {}, { estado: undefined }, { estado: null }]) {
    chamadas.length = 0;
    servico.listQueue(ctx, semFiltro);
    assert.deepEqual(chamadas.map(([nome, args]) => [nome, args.length]), [['loadQueueFromDisk', 1], ['listQueue', 2]], String(JSON.stringify(semFiltro)));
    assert.equal(chamadas[1][1][1], undefined, `sem filtro (${JSON.stringify(semFiltro)}) = undefined para o domínio`);
  }

  // O autorizador injetado recebe SÓ (contexto, APPROVE:LEAD_APPROVAL), em toda operação: o Service nomeia a permissão (não
  // depende do padrão da ponte) e não lhe passa nada que venha do consumidor. Uma leitura consulta o autorizador uma vez;
  // aprovar e rejeitar, duas — a do Service (antes de qualquer I/O) e a do domínio, que reautoriza com o mesmo autorizador.
  const outra = novaFila(t);
  const pedidos = [];
  const autorizadorObservado = (...args) => {
    pedidos.push(args);
    return authorizeReviewerForApprovalQueue(...args);
  };
  const auditado = criarServico(outra.filePath, { authorizeReviewer: autorizadorObservado });
  assert.deepEqual(pedidos, [], 'criar o Service não consulta o autorizador');
  const porOperacao = [
    ['listQueue', 1, () => auditado.listQueue(ctx, { estado: QUEUE_STATE.DNC })],
    ['getProspect', 1, () => auditado.getProspect(ctx, outra.ids.alfa, { userId: 'atacante' })],
    ['getHistory', 1, () => auditado.getHistory(ctx, outra.ids.alfa, { userId: 'atacante' })],
    ['approveProspect', 2, () => auditado.approveProspect(ctx, outra.ids.alfa, { reason: 'ok' }, { role: ROLE.ADMIN })],
    ['rejectProspect', 2, () => auditado.rejectProspect(ctx, outra.ids.beta, { reason: 'sem fit' }, { permissions: ADMIN_LITERAL })],
  ];
  for (const [nome, consultas, operar] of porOperacao) {
    pedidos.length = 0;
    operar();
    assert.equal(pedidos.length, consultas, `${nome}: consultas ao autorizador`);
    for (const args of pedidos) {
      assert.equal(args.length, 2, `${nome}: o autorizador recebe só (contexto, permissão)`);
      assert.equal(args[0], ctx, `${nome}: o contexto do consumidor, como está`);
      assert.equal(args[1], PERMISSION.APPROVE_LEAD_APPROVAL, `${nome}: a permissão exigida`);
    }
  }

  // Sem queuePath, o caminho é o que o domínio declara como padrão (aqui, um arquivo temporário: nada do projeto é tocado).
  const outras = [];
  const semCaminho = createApprovalQueueService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    approvalQueue: domainoObservado(outras, { DEFAULT_QUEUE_PATH: filePath }),
  });
  semCaminho.listQueue(ctx);
  assert.deepEqual(outras.find(([nome]) => nome === 'loadQueueFromDisk')[1], [filePath]);
});

// ===========================================================================
// 14) O Service não expõe internals do domínio
// ===========================================================================
test('[SVC-14] o Service não expõe internals do domínio: só as 5 operações, congelado, sem fila/domínio/caminho/autorizador — e devolve CÓPIAS', (t) => {
  const { filePath, ids } = novaFila(t);
  const servico = criarServico(filePath);
  const ctx = contexto();

  // A superfície: só as operações, nada mais alcançável.
  assert.equal(Object.isFrozen(servico), true);
  assert.equal(Object.getPrototypeOf(servico), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(servico).sort(), ['approveProspect', 'getHistory', 'getProspect', 'listQueue', 'rejectProspect']);
  for (const interno of ['queue', 'approvalQueue', 'domain', 'actions', 'reviewActions', 'authorizeReviewer', 'queuePath', 'filePath', 'load', 'save']) {
    assert.equal(interno in servico, false, `${interno} não pode existir no Service`);
  }
  assert.equal(Reflect.set(servico, 'approveProspect', () => 'burlado'), false, 'as operações não podem ser substituídas');
  assert.equal(Reflect.deleteProperty(servico, 'rejectProspect'), false);
  assert.equal(Reflect.set(servico, 'domain', domain), false, 'nada novo pode ser acrescentado');
  // O módulo do Service só exporta a fábrica.
  assert.deepEqual(Object.keys(serviceModule), ['createApprovalQueueService']);

  // Os dados que saem são CÓPIAS: alterá-los não altera a fila nem as leituras seguintes.
  const arquivoAntes = lerArquivo(filePath);
  const lista = servico.listQueue(ctx);
  const instantaneo = JSON.stringify(lista);
  lista[0].estado = QUEUE_STATE.APROVADO_PARA_CRM;
  lista[0].historico.push({ falso: true });
  lista.pop();
  const prospect = servico.getProspect(ctx, ids.alfa);
  prospect.estado = QUEUE_STATE.APROVADO_PARA_CRM;
  prospect.discoverySnapshot.empresa = 'Adulterada';
  const historico = servico.getHistory(ctx, ids.alfa);
  historico.length = 0;
  assert.equal(JSON.stringify(servico.listQueue(ctx)), instantaneo);
  assert.equal(servico.getProspect(ctx, ids.alfa).estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(servico.getHistory(ctx, ids.alfa).length, 1);
  assert.equal(lerArquivo(filePath), arquivoAntes, 'o arquivo não mudou');

  // O que uma aprovação devolve também é uma cópia: adulterá-la não muda o que foi gravado.
  const aprovado = servico.approveProspect(ctx, ids.alfa, { reason: 'ok' });
  aprovado.estado = QUEUE_STATE.REJEITADO;
  aprovado.historico.length = 0;
  assert.equal(servico.getProspect(ctx, ids.alfa).estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(servico.getHistory(ctx, ids.alfa).length, 2);

  // Com o domínio real a fila é relida do disco a cada operação, então até um objeto vivo seria inofensivo. Mas o Service
  // não pode depender disso: com um domínio que COMPARTILHA a fila em memória (uma implementação futura com cache), o que
  // sai continua sendo cópia — quem consome nunca segura uma referência viva do domínio.
  const compartilhada = domain.loadQueueFromDisk(filePath);
  const emMemoria = criarServico(filePath, {
    approvalQueue: domainoObservado([], { loadQueueFromDisk: () => compartilhada, saveQueueToDisk: () => {} }),
  });
  const antesDaLeitura = JSON.stringify(compartilhada);
  const doProspect = emMemoria.getProspect(ctx, ids.beta);
  doProspect.estado = QUEUE_STATE.REJEITADO;
  doProspect.historico.push({ falso: true });
  const daLista = emMemoria.listQueue(ctx);
  daLista[0].estado = QUEUE_STATE.REJEITADO;
  daLista.pop();
  const doHistorico = emMemoria.getHistory(ctx, ids.beta);
  doHistorico.length = 0;
  assert.equal(JSON.stringify(compartilhada), antesDaLeitura, 'a fila compartilhada do domínio não foi alterada por quem consome');
  const daAprovacao = emMemoria.approveProspect(ctx, ids.beta, { reason: 'ok' }); // esta SIM altera a fila do domínio, legitimamente
  const depoisDaAprovacao = JSON.stringify(compartilhada);
  daAprovacao.estado = QUEUE_STATE.REJEITADO;
  daAprovacao.historico.push({ falso: true });
  assert.equal(JSON.stringify(compartilhada), depoisDaAprovacao, 'o retorno da aprovação também é cópia');
});

// ===========================================================================
// 15) Erros previsíveis
// ===========================================================================
// Executa a MESMA operação direto no domínio (com a mesma ponte), para comparar o erro com o do Service.
function erroDoDominio(filePath, operar) {
  const acoes = domain.createApprovalReviewActions({ authorizeReviewer: authorizeReviewerForApprovalQueue });
  return erroDe(() => operar(acoes, domain.loadQueueFromDisk(filePath)));
}

test('[SVC-15] os erros são previsíveis: os do domínio passam intactos (mesma classe e mensagem) e nada é gravado; a entrada malformada falha com erro claro', (t) => {
  const { filePath, ids } = novaFila(t);
  const chamadas = [];
  const servico = criarServico(filePath, { approvalQueue: domainoObservado(chamadas) });
  const ctx = contexto();
  const antes = lerArquivo(filePath);

  // Erros do DOMÍNIO: o Service não traduz nem engole — mesma classe, mesma mensagem — e não grava.
  const casos = [
    ['aprovar prospect inexistente', () => servico.approveProspect(ctx, 'id:inexistente', { reason: 'ok' }), (a, f) => a.approveProspect(f, 'id:inexistente', ctx, 'ok'), /prospect não encontrado na fila/],
    ['rejeitar prospect inexistente', () => servico.rejectProspect(ctx, 'id:inexistente', { reason: 'x' }), (a, f) => a.rejectProspect(f, 'id:inexistente', ctx, 'x'), /prospect não encontrado na fila/],
    ['aprovar um prospect DNC', () => servico.approveProspect(ctx, ids.bloqueado, { reason: 'ok' }), (a, f) => a.approveProspect(f, ids.bloqueado, ctx, 'ok'), /transição não permitida: DNC -> APROVADO_PARA_CRM/],
    ['rejeitar um prospect DNC', () => servico.rejectProspect(ctx, ids.bloqueado, { reason: 'x' }), (a, f) => a.rejectProspect(f, ids.bloqueado, ctx, 'x'), /transição não permitida: DNC -> REJEITADO/],
    ['rejeitar sem motivo', () => servico.rejectProspect(ctx, ids.alfa), (a, f) => a.rejectProspect(f, ids.alfa, ctx, undefined), /rejeição exige um motivo/],
  ];
  for (const [rotulo, pelaServico, pelaDominio, mensagem] of casos) {
    const erroServico = erroDe(pelaServico);
    const erroDom = erroDoDominio(filePath, pelaDominio);
    assert.ok(erroServico, `${rotulo}: o Service lança`);
    assert.match(erroServico.message, mensagem, rotulo);
    assert.equal(erroServico.message, erroDom.message, `${rotulo}: a mesma mensagem do domínio`);
    assert.equal(erroServico.constructor, erroDom.constructor, `${rotulo}: a mesma classe do domínio`);
    assert.equal(lerArquivo(filePath), antes, `${rotulo}: nada foi gravado`);
  }
  assert.equal(chamadas.filter(([nome]) => nome === 'saveQueueToDisk').length, 0, 'nenhum erro do domínio chegou a gravar');
  assert.ok(chamadas.some(([nome]) => nome === 'loadQueueFromDisk'), 'sanidade: o domínio foi mesmo chamado (a fila foi carregada)');
  // Leitura de um prospect inexistente: getProspect devolve null (como o domínio); getHistory lança (como o domínio).
  assert.equal(servico.getProspect(ctx, 'id:inexistente'), null);
  assert.equal(erroDe(() => servico.getHistory(ctx, 'id:inexistente')).message, erroDoDominio(filePath, (a, f) => domain.getHistory(f, 'id:inexistente')).message);

  // Uma segunda aprovação é uma transição não permitida — e o que já foi gravado continua.
  servico.approveProspect(ctx, ids.alfa, { reason: 'ok' });
  const depoisDaAprovacao = lerArquivo(filePath);
  assert.throws(() => servico.approveProspect(ctx, ids.alfa, { reason: 'de novo' }), /transição não permitida/);
  assert.throws(() => servico.rejectProspect(ctx, ids.alfa, { reason: 'mudei de ideia' }), /transição não permitida/);
  assert.equal(lerArquivo(filePath), depoisDaAprovacao);

  // Ids que são propriedades herdadas do Object nunca viram um prospect: a leitura devolve null ou lança "não encontrado",
  // e nenhuma escrita acontece.
  for (const herdado of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(servico.getProspect(ctx, herdado), null, herdado);
    assert.throws(() => servico.getHistory(ctx, herdado), /prospect não encontrado na fila/, herdado);
    assert.throws(() => servico.approveProspect(ctx, herdado, { reason: 'x' }), Error, herdado);
    assert.throws(() => servico.rejectProspect(ctx, herdado, { reason: 'x' }), Error, herdado);
  }
  assert.equal(lerArquivo(filePath), depoisDaAprovacao, 'ids herdados não gravaram nada');

  // Entrada malformada: erro claro (a autorização vem primeiro, então o contexto é válido aqui).
  for (const idRuim of ['', '   ', 42, null, undefined, {}, [], true]) {
    for (const [nome, operar] of [
      ['getProspect', () => servico.getProspect(ctx, idRuim)],
      ['getHistory', () => servico.getHistory(ctx, idRuim)],
      ['approveProspect', () => servico.approveProspect(ctx, idRuim, { reason: 'x' })],
      ['rejectProspect', () => servico.rejectProspect(ctx, idRuim, { reason: 'x' })],
    ]) {
      assert.throws(operar, /prospectId deve ser um texto não vazio/, `${nome}(${String(idRuim)})`);
    }
  }
  for (const opcoesRuins of ['x', 42, [], () => {}, true]) {
    assert.throws(() => servico.approveProspect(ctx, ids.beta, opcoesRuins), /as opções devem ser um objeto/, String(opcoesRuins));
    assert.throws(() => servico.listQueue(ctx, opcoesRuins), /as opções devem ser um objeto/, String(opcoesRuins));
  }
  for (const estadoRuim of ['aprovado', 'AGUARDANDO', 42, {}, [], true]) {
    assert.throws(() => servico.listQueue(ctx, { estado: estadoRuim }), /estado desconhecido/, String(estadoRuim));
  }
  assert.throws(() => servico.approveProspect(ctx, ids.beta, { reason: {} }), /reason deve ser um texto/);
  assert.equal(lerArquivo(filePath), depoisDaAprovacao);

  // Uma falha ao GRAVAR também passa intacta (o mesmo erro): uma operação nunca parece ter dado certo sem que a fila tenha
  // sido gravada.
  const falhaDeDisco = new Error('disco cheio (simulado)');
  const semDisco = criarServico(filePath, {
    approvalQueue: domainoObservado([], {
      saveQueueToDisk: () => {
        throw falhaDeDisco;
      },
    }),
  });
  assert.equal(erroDe(() => semDisco.approveProspect(ctx, ids.beta, { reason: 'ok' })), falhaDeDisco);
  assert.equal(erroDe(() => semDisco.rejectProspect(ctx, ids.gama, { reason: 'sem fit' })), falhaDeDisco);
  assert.equal(lerArquivo(filePath), depoisDaAprovacao, 'sem gravar, o arquivo é o que era');

  // Um arquivo de fila CORROMPIDO nunca é mascarado nem sobrescrito: toda operação lança e o arquivo fica como está.
  const corrompido = '{ isso não é json válido ][';
  fs.writeFileSync(filePath, corrompido, 'utf8');
  for (const [nome, operar] of operacoes(servico, ids)) {
    assert.throws(() => operar(ctx), /corrompido/, nome);
  }
  assert.equal(lerArquivo(filePath), corrompido, 'o arquivo corrompido não foi tocado');
});

// ===========================================================================
// 16) Nenhuma chamada externa
// ===========================================================================
test('[SVC-16] nenhuma chamada externa: nenhuma requisição de rede em nenhuma operação, e o código do Service não tem nada de rede, Supabase, Notion ou ambiente', (t) => {
  const rede = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('o Service não pode fazer nenhuma requisição');
  });
  const { filePath, ids } = novaFila(t);
  const servico = criarServico(filePath);
  const ctx = contexto();

  servico.listQueue(ctx);
  servico.getProspect(ctx, ids.alfa);
  servico.getHistory(ctx, ids.alfa);
  servico.approveProspect(ctx, ids.alfa, { reason: 'ok' });
  servico.rejectProspect(ctx, ids.beta, { reason: 'sem fit' });
  for (const [, operar] of operacoes(servico, ids)) erroDe(() => operar(undefined));
  assert.equal(rede.mock.callCount(), 0, 'nenhuma chamada de rede');

  // Estático: só identificadores e textos de código (comentários ficam de fora).
  const analise = analyzeSource(fs.readFileSync(SERVICE_SOURCE, 'utf8'), 'src/services/approvalQueueService.js');
  const identificadores = new Set(analise.tokens.filter((token) => token.type === 'id').map((token) => token.value));
  for (const proibido of ['fetch', 'XMLHttpRequest', 'WebSocket', 'process', 'eval', 'Function', 'createClient']) {
    assert.equal(identificadores.has(proibido), false, `o código do Service não pode usar ${proibido}`);
  }
  for (const texto of analise.strings) {
    assert.doesNotMatch(texto.value, /supabase|notion|https?:|\.env|service_role|SUPABASE_|token/i, `texto suspeito no Service: ${texto.value.slice(0, 60)}`);
  }
});

// ===========================================================================
// Suporte: a cadeia real, a matriz de cobertura do domínio, autorizadores defeituosos e limites
// ===========================================================================
test('[SVC-17] cadeia real (access token verificado -> USER -> AuthorizationContext -> Service -> domínio): o USER ativo aprova; o inativo não passa', async (t) => {
  const { filePath, ids } = novaFila(t);
  const servico = criarServico(filePath);
  const store = createUserStore([
    usuario({ userId: 'user-cadeia-ativo', authUserId: 'auth-cadeia-ativo', name: 'Ativa da Cadeia', email: 'ativa-cadeia@example.test' }),
    usuario({ userId: 'user-cadeia-inativo', authUserId: 'auth-cadeia-inativo', email: 'inativo-cadeia@example.test', status: USER_STATUS.INACTIVE }),
  ]);
  const [identidadeAtiva, identidadeInativa] = await verifiedIdentitiesFor(t, [
    { authUserId: 'auth-cadeia-ativo', email: 'ativa-cadeia@example.test' },
    { authUserId: 'auth-cadeia-inativo', email: 'inativo-cadeia@example.test' },
  ]);

  const ctxAtivo = resolveAuthorizationContext(store, identidadeAtiva);
  assert.equal(servico.listQueue(ctxAtivo).length, 4);
  const aprovado = servico.approveProspect(ctxAtivo, ids.alfa, { reason: 'ok' });
  assert.deepEqual(aprovado.historico[aprovado.historico.length - 1].reviewedBy, {
    userId: 'user-cadeia-ativo',
    name: 'Ativa da Cadeia',
    role: ROLE.COMMERCIAL_CLOSER,
  });

  // O resolver ainda emite o contexto do inativo; quem recusa a ação é a autorização do Service.
  const ctxInativo = resolveAuthorizationContext(store, identidadeInativa);
  assert.equal(ctxInativo.status, USER_STATUS.INACTIVE);
  const antes = lerArquivo(filePath);
  for (const [nome, operar] of operacoes(servico, ids)) assert.throws(() => operar(ctxInativo), /usuário inativo/, nome);
  assert.equal(lerArquivo(filePath), antes);
});

test('[SVC-18] o Service cobre toda ação e leitura HUMANA do domínio; o que fica fora é do sistema ou de infraestrutura — e uma função pública NOVA do domínio exige uma classificação consciente', (t) => {
  // Toda função pública do domínio, classificada. Uma função nova faz este teste falhar até alguém decidir: coberta
  // pelo Service, do sistema, ou de infraestrutura.
  const classificacao = {
    // ações e leituras HUMANAS — cobertas pelo Service
    createApprovalReviewActions: 'servico: approveProspect, rejectProspect',
    // CRM-INTEGRATION (decisão 0016): as duas ações humanas de AUDITORIA da promoção para o CRM. Coberta por OUTRO Service
    // (src/services/approvalPromotionService.js), não por este: a superfície de 5 operações que a API expõe não muda.
    createApprovalPromotionActions: 'outro service: approvalPromotionService (recordPromotion, recordPromotionBlocked)',
    getProspect: 'servico: getProspect',
    listQueue: 'servico: listQueue',
    getHistory: 'servico: getHistory',
    // as funções soltas falham fechado: o Service nunca as usa e nada as torna necessárias
    approveProspect: 'solta: falha fechado',
    rejectProspect: 'solta: falha fechado',
    // transições e entrada de prospects feitas pelo SISTEMA — fora desta versão, de propósito
    addProspect: 'sistema: fora do Service (autorização de ator de sistema é decisão futura)',
    markDuplicado: 'sistema: fora do Service',
    markDnc: 'sistema: fora do Service',
    markDadosInsuficientes: 'sistema: fora do Service',
    // infraestrutura e auxiliares
    createEmptyQueue: 'infraestrutura',
    loadQueueFromDisk: 'infraestrutura (usada pelo Service)',
    saveQueueToDisk: 'infraestrutura (usada pelo Service)',
    buildStableId: 'auxiliar do domínio',
  };
  const funcoesDoDominio = Object.entries(domain).filter(([, valor]) => typeof valor === 'function').map(([nome]) => nome).sort();
  assert.deepEqual(funcoesDoDominio, Object.keys(classificacao).sort(), 'toda função pública do domínio precisa estar classificada');

  // O que a classificação diz que o Service cobre é exatamente o que o Service oferece.
  const { filePath } = novaFila(t);
  const servico = criarServico(filePath);
  const cobertas = Object.values(classificacao)
    .filter((texto) => texto.startsWith('servico: '))
    .flatMap((texto) => texto.replace('servico: ', '').split(', '))
    .sort();
  assert.deepEqual(cobertas, Object.keys(servico).sort());

  // Por outro caminho, o consumidor não aprova nem rejeita: as funções soltas falham fechado — a única via é a
  // fábrica com um autorizador, que é o que o Service compõe.
  const ctx = contexto();
  assert.throws(() => domain.approveProspect({ items: {} }, 'id:x', ctx, 'ok'), /solto está desativado/);
  assert.throws(() => domain.rejectProspect({ items: {} }, 'id:x', ctx, 'sem fit'), /solto está desativado/);
});

test('[SVC-19] um autorizador defeituoso falha fechado: tudo o que não for a identidade do revisor (false, undefined, texto, lista, Promise, assíncrono) é uma recusa — sem tocar no arquivo', (t) => {
  const { filePath, ids } = novaFila(t);
  const antes = lerArquivo(filePath);
  const identidade = { userId: 'user-x', name: 'X', role: ROLE.ADMIN };
  const jaTratada = () => {
    const recusada = Promise.reject(new Error('negado'));
    recusada.catch(() => {}); // evita um unhandledRejection: o teste só quer provar que o Service a recusa
    return recusada;
  };
  const defeituosos = [
    ['devolve false', () => false],
    ['devolve undefined', () => undefined],
    ['devolve null', () => null],
    ['devolve true', () => true],
    ['devolve texto', () => 'autorizado'],
    ['devolve número', () => 1],
    ['devolve uma lista', () => [identidade]],
    ['devolve uma Promise resolvida (autorizador assíncrono)', () => Promise.resolve(identidade)],
    ['função assíncrona', async () => identidade],
    ['devolve uma Promise rejeitada', jaTratada],
  ];
  for (const [rotulo, autorizador] of defeituosos) {
    const chamadas = [];
    const servico = criarServico(filePath, { authorizeReviewer: autorizador, approvalQueue: domainoObservado(chamadas) });
    chamadas.length = 0;
    for (const [nome, operar] of operacoes(servico, ids)) {
      assert.throws(() => operar(contexto()), /autorização recusada/, `${nome}: ${rotulo}`);
    }
    assert.deepEqual(chamadas, [], `${rotulo}: o domínio nem foi chamado`);
  }
  assert.equal(lerArquivo(filePath), antes);

  // Um autorizador que LANÇA propaga o erro dele (mesma classe e mensagem), sem tocar no disco.
  const nega = () => {
    throw new RangeError('revisão negada pelo autorizador de teste');
  };
  const servico = criarServico(filePath, { authorizeReviewer: nega });
  for (const [nome, operar] of operacoes(servico, ids)) {
    const erro = erroDe(() => operar(contexto()));
    assert.ok(erro instanceof RangeError, nome);
    assert.equal(erro.message, 'revisão negada pelo autorizador de teste', nome);
  }
  assert.equal(lerArquivo(filePath), antes);
});

test('[SVC-20] LIMITE DOCUMENTADO: o Service obedece ao autorizador injetado — quem compõe o Service escolhe o autorizador (fronteira arquitetural interna, não criptografia)', (t) => {
  // Um autorizador que sempre autoriza É obedecido, como no domínio. Este teste existe para não fingir uma proteção
  // que não existe: a composição do Service só deve acontecer em código confiável (a raiz da aplicação), nunca a
  // partir de entrada de consumidor. O consumidor recebe o Service pronto, não a fábrica.
  const { filePath, ids } = novaFila(t);
  const permissivo = criarServico(filePath, { authorizeReviewer: () => ({ userId: 'qualquer', name: 'Qualquer Um', role: ROLE.ADMIN }) });
  assert.equal(permissivo.listQueue(undefined).length, 4);
  const aprovado = permissivo.approveProspect(undefined, ids.alfa, { reason: 'ok' });
  assert.deepEqual(aprovado.historico[aprovado.historico.length - 1].reviewedBy, { userId: 'qualquer', name: 'Qualquer Um', role: ROLE.ADMIN });
});

test('[SVC-21] o Service só importa o domínio da fila e o catálogo de auth — nada de tests, Supabase, Notion, rede, módulos nativos ou pacotes externos', () => {
  const analise = analyzeSource(fs.readFileSync(SERVICE_SOURCE, 'utf8'), 'src/services/approvalQueueService.js');
  assert.deepEqual(analise.issues, [], 'nenhum carregamento dinâmico ou não analisável');
  assert.deepEqual(analise.refs.map((ref) => `${ref.kind}:${ref.specifier}`).sort(), ['require:../auth', 'require:../research-prospector/approvalQueue']);
  for (const ref of analise.refs) {
    assert.match(ref.specifier, /^\.\.\/(auth|research-prospector\/approvalQueue)$/, ref.specifier);
  }
});
