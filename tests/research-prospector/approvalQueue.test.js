const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  QUEUE_STATE,
  ACTOR,
  createEmptyQueue,
  loadQueueFromDisk,
  saveQueueToDisk,
  addProspect,
  createApprovalReviewActions,
  markDuplicado,
  markDnc,
  markDadosInsuficientes,
  getProspect,
  listQueue,
  getHistory,
  buildStableId,
} = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');
// Fase E: o domínio não importa src/auth — recebe a autorização por injeção. Estes
// testes fazem a composição (é o que a camada de Services fará): a porta real, a
// ponte de src/auth, e AuthorizationContext REAIS (emitidos a partir de um USER
// definido), no lugar da antiga identidade simples { userId, name, role, permissions }.
const { authorizeReviewerForApprovalQueue, defineUser, ROLE, USER_STATUS } = require('../../src/auth');
const { createAuthorizationContext } = require('../helpers/authFixtures');

// As ações de revisão (fábrica + autorizador injetado). Os nomes são os mesmos
// de antes para manter os testes legíveis; as funções SOLTAS homônimas exportadas
// pelo módulo agora só falham fechado (testadas em approvalQueue-authorization.test.js).
const { approveProspect, rejectProspect } = createApprovalReviewActions({
  authorizeReviewer: authorizeReviewerForApprovalQueue,
});

const briefing = { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', quantidadeDesejada: 10, exclusoes: ['Agência Alfa Digital'] };

function discoveryFor(rawFindings) {
  return runDiscoveryPipeline({ briefing, rawFindings, crmRecords: [] }).resultados[0];
}

function novoAchado(overrides = {}) {
  return {
    empresa: 'Consultório Exemplo',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: {
      site: [{ valor: 'consultorioexemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }],
      instagram: [{ valor: 'consultorioexemplo', fonte: 'Instagram', tipoFonte: SOURCE_TYPE.OFICIAL }],
    },
    fontes: [],
    ...overrides,
  };
}

// Contexto de revisor REAL (Fase E): um AuthorizationContext emitido pelo emissor
// interno a partir de um USER definido por defineUser() — substitui o objeto de
// identidade simples { userId, name, role, permissions } (Passo 0009.2), que o
// Approval Queue não aceita mais como autorização. Fictício: example.test.
function reviewerContext(overrides = {}) {
  return createAuthorizationContext(
    defineUser({
      userId: 'user-breno',
      authUserId: 'auth-breno',
      name: 'Breno',
      email: 'breno@example.test',
      role: ROLE.ADMIN,
      status: USER_STATUS.ACTIVE,
      ...overrides,
    })
  );
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'approval-queue-test-'));
}

// A — novo prospect entra AGUARDANDO_REVISAO
test('[A] novo prospect (sem duplicidade/DNC) entra como AGUARDANDO_REVISAO', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  assert.equal(item.estado, QUEUE_STATE.AGUARDANDO_REVISAO);
});

// B, C, D — aprovação exige um contexto de autorização válido, registra reviewedBy + timestamp
test('[B][C][D] aprovação exige contexto de autorização válido, e registra reviewedBy + timestamp', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));

  assert.throws(() => approveProspect(queue, item.prospectId, null, 'ok'), /AuthorizationContext inválido/);
  assert.throws(() => approveProspect(queue, item.prospectId, {}, 'ok'), /AuthorizationContext inválido/);

  const aprovado = approveProspect(queue, item.prospectId, reviewerContext(), 'Bom fit, aprovar');
  assert.equal(aprovado.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  const ultimo = aprovado.historico[aprovado.historico.length - 1];
  assert.equal(ultimo.reviewedBy.userId, 'user-breno');
  assert.equal(ultimo.reviewedBy.name, 'Breno');
  assert.ok(ultimo.timestamp);
  assert.equal(ultimo.actor, ACTOR.HUMAN);
});

// E — aprovação registra histórico
test('[E] aprovação adiciona entrada ao histórico sem apagar as anteriores', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  const historicoAntes = getHistory(queue, item.prospectId).length;

  approveProspect(queue, item.prospectId, reviewerContext(), 'ok');

  const historicoDepois = getHistory(queue, item.prospectId);
  assert.equal(historicoDepois.length, historicoAntes + 1);
});

// F, G — rejeição exige motivo e contexto de autorização válido, e os registra
test('[F][G] rejeição exige motivo e contexto de autorização válido, e os registra', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));

  assert.throws(() => rejectProspect(queue, item.prospectId, reviewerContext(), ''), /motivo/);
  assert.throws(() => rejectProspect(queue, item.prospectId, null, 'sem fit'), /AuthorizationContext inválido/);

  const rejeitado = rejectProspect(queue, item.prospectId, reviewerContext(), 'Fora do ICP');
  assert.equal(rejeitado.estado, QUEUE_STATE.REJEITADO);
  const ultimo = rejeitado.historico[rejeitado.historico.length - 1];
  assert.equal(ultimo.motivo, 'Fora do ICP');
  assert.equal(ultimo.reviewedBy.userId, 'user-breno');
});

// H — DUPLICADO bloqueia aprovação
test('[H] prospect DUPLICADO não pode ser aprovado', () => {
  const queue = createEmptyQueue();
  const crmRecords = [{ empresa: 'Já Cadastrado', site: 'https://consultorioexemplo.com.br', cidade: 'Petrópolis' }];
  const resultado = runDiscoveryPipeline({ briefing, rawFindings: [novoAchado()], crmRecords }).resultados[0];
  const item = addProspect(queue, resultado);

  assert.equal(item.estado, QUEUE_STATE.DUPLICADO);
  assert.throws(() => approveProspect(queue, item.prospectId, reviewerContext(), 'ok'), /transição não permitida/);
});

// I — DNC bloqueia aprovação
test('[I] prospect DNC não pode ser aprovado', () => {
  const queue = createEmptyQueue();
  const crmRecords = [{ empresa: 'Bloqueado', site: 'https://consultorioexemplo.com.br', doNotContact: true }];
  const resultado = runDiscoveryPipeline({ briefing, rawFindings: [novoAchado()], crmRecords }).resultados[0];
  const item = addProspect(queue, resultado);

  assert.equal(item.estado, QUEUE_STATE.DNC);
  assert.throws(() => approveProspect(queue, item.prospectId, reviewerContext(), 'ok'), /transição não permitida/);
});

// J — NAO_VERIFICADO não vira DNC
test('[J] DNC não verificável nunca vira DNC nem libera automaticamente', () => {
  const queue = createEmptyQueue();
  const resultado = runDiscoveryPipeline({
    briefing, rawFindings: [novoAchado()], crmRecords: [], crmDisponivel: false,
  }).resultados[0];

  assert.equal(resultado.statusDNC, 'NAO_VERIFICADO');
  const item = addProspect(queue, resultado);
  assert.notEqual(item.estado, QUEUE_STATE.DNC);
  assert.equal(item.estado, QUEUE_STATE.AGUARDANDO_REVISAO);
});

// K — POSSIVEL_DUPLICADO pode permanecer aguardando revisão
test('[K] POSSIVEL_DUPLICADO entra como AGUARDANDO_REVISAO, nunca DUPLICADO automaticamente', () => {
  const queue = createEmptyQueue();
  const achado = novoAchado({ empresa: 'Fulano', campos: {} });
  const crmRecords = [{ empresa: 'Fulano', cidade: 'Petrópolis' }];
  const resultado = runDiscoveryPipeline({ briefing, rawFindings: [achado], crmRecords }).resultados[0];

  assert.equal(resultado.statusDuplicidade, 'POSSIVEL_DUPLICADO');
  const item = addProspect(queue, resultado);
  assert.equal(item.estado, QUEUE_STATE.AGUARDANDO_REVISAO);
});

// L — reentrada não cria duplicata
test('[L] o mesmo prospect descoberto de novo não cria uma segunda entrada', () => {
  const queue = createEmptyQueue();
  addProspect(queue, discoveryFor([novoAchado()]));
  addProspect(queue, discoveryFor([novoAchado()]));

  assert.equal(listQueue(queue).length, 1);
});

// M — reentrada não sobrescreve APROVADO_PARA_CRM
test('[M] reentrada nunca reverte um prospect já APROVADO_PARA_CRM', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  approveProspect(queue, item.prospectId, reviewerContext(), 'ok');

  addProspect(queue, discoveryFor([novoAchado()]));

  assert.equal(getProspect(queue, item.prospectId).estado, QUEUE_STATE.APROVADO_PARA_CRM);
});

// N — reentrada não sobrescreve REJEITADO
test('[N] reentrada nunca reverte um prospect já REJEITADO', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  rejectProspect(queue, item.prospectId, reviewerContext(), 'sem fit');

  addProspect(queue, discoveryFor([novoAchado()]));

  assert.equal(getProspect(queue, item.prospectId).estado, QUEUE_STATE.REJEITADO);
});

// O — reentrada não sobrescreve DNC
test('[O] reentrada nunca reabre um prospect já DNC', () => {
  const queue = createEmptyQueue();
  const crmRecords = [{ empresa: 'Bloqueado', site: 'https://consultorioexemplo.com.br', doNotContact: true }];
  const resultado1 = runDiscoveryPipeline({ briefing, rawFindings: [novoAchado()], crmRecords }).resultados[0];
  const item = addProspect(queue, resultado1);
  assert.equal(item.estado, QUEUE_STATE.DNC);

  // Redescoberta posterior, mesmo que o CRM já não marque mais DNC (não deve importar).
  const resultado2 = runDiscoveryPipeline({ briefing, rawFindings: [novoAchado()], crmRecords: [] }).resultados[0];
  addProspect(queue, resultado2);

  assert.equal(getProspect(queue, item.prospectId).estado, QUEUE_STATE.DNC);
});

// P — sistema não escreve no CRM (nenhum efeito colateral fora da fila em memória)
test('[P] operações da fila nunca alteram os registros de CRM recebidos', () => {
  const queue = createEmptyQueue();
  const crmRecords = [{ empresa: 'Já Cadastrado', site: 'https://consultorioexemplo.com.br', cidade: 'Petrópolis' }];
  const snapshot = JSON.parse(JSON.stringify(crmRecords));
  const resultado = runDiscoveryPipeline({ briefing, rawFindings: [novoAchado()], crmRecords }).resultados[0];
  addProspect(queue, resultado);

  assert.deepEqual(crmRecords, snapshot);
});

// Q — nenhum contato é realizado (nenhuma função de envio existe no módulo)
test('[Q] módulo não expõe nenhuma função de envio/contato', () => {
  const approvalQueue = require('../../src/research-prospector/approvalQueue');
  const nomes = Object.keys(approvalQueue).join(' ').toLowerCase();
  assert.doesNotMatch(nomes, /send|enviar|contact|contatar|whatsapp|email/);
});

// R — nenhum estado arbitrário é permitido
test('[R] transição para um estado fora do mapa permitido lança erro', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  approveProspect(queue, item.prospectId, reviewerContext(), 'ok');

  // APROVADO_PARA_CRM é terminal — qualquer nova transição deve falhar.
  assert.throws(() => rejectProspect(queue, item.prospectId, reviewerContext(), 'mudei de ideia'), /transição não permitida/);
  assert.throws(() => markDuplicado(queue, item.prospectId, ['dominio']), /transição não permitida/);
  assert.throws(() => markDnc(queue, item.prospectId), /transição não permitida/);
  assert.throws(() => markDadosInsuficientes(queue, item.prospectId, 'motivo'), /transição não permitida/);
});

// S — histórico mantém transições
test('[S] histórico preserva a sequência completa de transições', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  approveProspect(queue, item.prospectId, reviewerContext(), 'ok');

  const historico = getHistory(queue, item.prospectId);
  assert.equal(historico.length, 2);
  assert.equal(historico[0].to, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(historico[1].to, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(historico[1].from, QUEUE_STATE.AGUARDANDO_REVISAO);
});

// T — actor SYSTEM não pode aprovar
test('[T] não existe caminho para SYSTEM aprovar um prospect', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  // approveProspect() sempre grava ACTOR.HUMAN internamente — não há parâmetro
  // de actor exposto para chamadas externas simularem SYSTEM.
  const aprovado = approveProspect(queue, item.prospectId, reviewerContext(), 'ok');
  assert.equal(aprovado.historico[aprovado.historico.length - 1].actor, ACTOR.HUMAN);
});

// U — actor HUMAN pode aprovar
test('[U] actor HUMAN aprova normalmente', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  const aprovado = approveProspect(queue, item.prospectId, reviewerContext(), 'ok');
  assert.equal(aprovado.estado, QUEUE_STATE.APROVADO_PARA_CRM);
});

// V — dados sensíveis não são persistidos
test('[V] item da fila nunca contém senha/token/credencial', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  const serializado = JSON.stringify(item).toLowerCase();
  assert.doesNotMatch(serializado, /senha|password|token|credential|secret|cookie/);
});

// W — Agência Alfa Digital nunca entra na fila
test('[W] "Agência Alfa Digital" nunca chega à fila (já excluída em discovery.js)', () => {
  const queue = createEmptyQueue();
  const { resultados } = runDiscoveryPipeline({
    briefing,
    rawFindings: [novoAchado({ empresa: 'Agência Alfa Digital' }), novoAchado({ empresa: 'Consultório Normal', campos: { site: [{ valor: 'normal.com.br', fonte: 'Site', tipoFonte: SOURCE_TYPE.OFICIAL }] } })],
    crmRecords: [],
  });
  for (const r of resultados) addProspect(queue, r);

  const empresas = listQueue(queue).map((i) => i.empresa);
  assert.equal(empresas.includes('Agência Alfa Digital'), false);
});

// X — EXPIRADO não é aplicado automaticamente
test('[X] EXPIRADO existe no modelo mas nenhuma função o aplica automaticamente', () => {
  const approvalQueue = require('../../src/research-prospector/approvalQueue');
  assert.equal(QUEUE_STATE.EXPIRADO, 'EXPIRADO');
  assert.equal(approvalQueue.ALLOWED_TRANSITIONS[QUEUE_STATE.AGUARDANDO_REVISAO].includes(QUEUE_STATE.EXPIRADO), false);

  // Um item "antigo" não é automaticamente expirado ao ser redescoberto ou lido.
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  item.criadoEm = '2000-01-01T00:00:00.000Z';
  addProspect(queue, discoveryFor([novoAchado()]));
  assert.notEqual(getProspect(queue, item.prospectId).estado, QUEUE_STATE.EXPIRADO);
});

test('buildStableId: mesma entidade produz o mesmo ID em execuções diferentes', () => {
  const id1 = buildStableId(discoveryFor([novoAchado()]));
  const id2 = buildStableId(discoveryFor([novoAchado()]));
  assert.equal(id1, id2);
});

test('aprovar/rejeitar/marcar em prospect inexistente lança erro claro', () => {
  const queue = createEmptyQueue();
  assert.throws(() => approveProspect(queue, 'id:inexistente', reviewerContext(), 'ok'), /não encontrado/);
  assert.throws(() => rejectProspect(queue, 'id:inexistente', reviewerContext(), 'x'), /não encontrado/);
});

// ===========================================================================
// Passo 0009.2 — identidade estruturada, autorização e persistência robusta
// ===========================================================================

// [0009.2-A] contexto inválido ou sem a permissão correta é sempre recusado
//
// Fase E: quem confere a FORMA do contexto e a permissão é o autorizador injetado
// (aqui, a ponte real de src/auth), não mais o domínio. Os antigos casos de
// "identidade incompleta" (sem userId, sem name, sem role, sem permissions)
// deixaram de ter mensagens próprias: um objeto simples — inclusive a antiga
// identidade completa { userId, name, role, permissions } — nunca é um
// AuthorizationContext emitido, e é recusado inteiro.
test('[0009.2-A] aprovação com contexto inválido ou sem a permissão correta falha, e a fila não muda', (t) => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  const antes = JSON.stringify(queue);

  const naoEmitidos = [
    undefined,
    { name: 'Breno', role: 'ADMIN', permissions: ['APPROVE:LEAD_APPROVAL'] }, // sem userId
    { userId: 'u1', role: 'ADMIN', permissions: ['APPROVE:LEAD_APPROVAL'] }, // sem name
    { userId: 'u1', name: 'Breno', permissions: ['APPROVE:LEAD_APPROVAL'] }, // sem role
    { userId: 'u1', name: 'Breno', role: 'ADMIN' }, // sem permissions
    { userId: 'u1', name: 'Breno', role: 'ADMIN', permissions: ['APPROVE:LEAD_APPROVAL'] }, // completo, mas simples (não emitido)
  ];
  for (const contexto of naoEmitidos) {
    assert.throws(() => approveProspect(queue, item.prospectId, contexto, 'ok'), /AuthorizationContext inválido/);
  }

  // Contexto REAL e ativo, mas cuja role não concede a permissão: a fonte canônica
  // role -> permissions é trocada só neste teste (as decisões leem só `permissions`).
  const constants = require('../../src/auth/constants');
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([]));
  // permissions vazia — sem a permissão necessária.
  assert.throws(() => approveProspect(queue, item.prospectId, reviewerContext(), 'ok'), /acesso negado/);
  // permissão de outro domínio — não é suficiente para Lead Approval.
  derivacao.mock.mockImplementation(() => Object.freeze(['APPROVE:OUTBOUND_APPROVAL']));
  assert.throws(() => approveProspect(queue, item.prospectId, reviewerContext(), 'ok'), /acesso negado/);

  assert.equal(JSON.stringify(queue), antes, 'a fila não mudou');
  assert.equal(getProspect(queue, item.prospectId).estado, QUEUE_STATE.AGUARDANDO_REVISAO);
});

// [0009.2-B] string livre (o antigo "reviewer") nunca é mais aceita
test('[0009.2-B] string livre não é mais aceita como identidade, mesmo sendo "Breno"', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  assert.throws(() => approveProspect(queue, item.prospectId, 'Breno', 'ok'), /AuthorizationContext inválido/);
  assert.throws(() => rejectProspect(queue, item.prospectId, 'Breno', 'sem fit'), /AuthorizationContext inválido/);
  assert.throws(() => approveProspect(queue, item.prospectId, { name: 'Breno' }, 'ok'), /AuthorizationContext inválido/);
});

// [0009.2-C] SYSTEM nunca alcança APROVADO_PARA_CRM, nem via addProspect
test('[0009.2-C] actor SYSTEM nunca alcança APROVADO_PARA_CRM, nem mesmo via addProspect com um candidato limpo', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  assert.equal(item.estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.notEqual(item.estado, QUEUE_STATE.APROVADO_PARA_CRM);

  // Redescoberta do mesmo candidato limpo tampouco produz aprovação.
  const redescoberto = addProspect(queue, discoveryFor([novoAchado()]));
  assert.notEqual(redescoberto.estado, QUEUE_STATE.APROVADO_PARA_CRM);

  // Toda entrada de histórico com destino APROVADO_PARA_CRM só pode ter sido
  // gravada por actor HUMAN — nunca SYSTEM, em nenhum caminho de código.
  for (const entrada of getHistory(queue, item.prospectId)) {
    if (entrada.to === QUEUE_STATE.APROVADO_PARA_CRM) {
      assert.equal(entrada.actor, ACTOR.HUMAN);
    }
  }
});

// [0009.2-D] histórico registra userId/name/role, nunca permissions ou segredos
test('[0009.2-D] aprovação registra userId, name e role da identidade, sem registrar permissions ou segredos', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  const aprovado = approveProspect(
    queue,
    item.prospectId,
    reviewerContext({ userId: 'u-42', authUserId: 'auth-u-42', name: 'Breno Silva', role: ROLE.ADMIN }),
    'ok'
  );
  const ultimo = aprovado.historico[aprovado.historico.length - 1];

  assert.equal(ultimo.reviewedBy.userId, 'u-42');
  assert.equal(ultimo.reviewedBy.name, 'Breno Silva');
  assert.equal(ultimo.reviewedBy.role, 'ADMIN');
  assert.equal(Object.prototype.hasOwnProperty.call(ultimo.reviewedBy, 'permissions'), false);
  // Fase E: nada além de { userId, name, role } — nem authUserId, nem status, nem e-mail.
  assert.deepEqual(Object.keys(ultimo.reviewedBy).sort(), ['name', 'role', 'userId']);

  const serializado = JSON.stringify(aprovado).toLowerCase();
  assert.doesNotMatch(serializado, /senha|password|token|credential|secret|cookie/);
});

// [0009.2-E] save + load preserva itens e histórico
test('[0009.2-E] saveQueueToDisk + loadQueueFromDisk preserva itens e histórico', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'approval-queue.json');
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  approveProspect(queue, item.prospectId, reviewerContext(), 'ok');

  saveQueueToDisk(queue, filePath);
  const recarregada = loadQueueFromDisk(filePath);

  assert.deepEqual(Object.keys(recarregada.items), Object.keys(queue.items));
  const itemRecarregado = recarregada.items[item.prospectId];
  assert.equal(itemRecarregado.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.deepEqual(itemRecarregado.historico, queue.items[item.prospectId].historico);

  fs.rmSync(dir, { recursive: true, force: true });
});

// [0009.2-F] arquivo inexistente carrega fila vazia
test('[0009.2-F] loadQueueFromDisk com arquivo inexistente retorna fila vazia', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'nao-existe.json');
  const carregada = loadQueueFromDisk(filePath);
  assert.deepEqual(carregada, createEmptyQueue());
  fs.rmSync(dir, { recursive: true, force: true });
});

// [0009.2-G] JSON corrompido lança erro explícito e não é apagado/sobrescrito
test('[0009.2-G] loadQueueFromDisk com JSON corrompido lança erro explícito, sem apagar o arquivo', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'approval-queue.json');
  const conteudoCorrompido = '{ isso não é json válido ][';
  fs.writeFileSync(filePath, conteudoCorrompido, 'utf8');

  assert.throws(() => loadQueueFromDisk(filePath), /corrompido/);

  // O conteúdo corrompido continua exatamente como estava — nada foi
  // apagado, sobrescrito ou "consertado" automaticamente.
  assert.equal(fs.readFileSync(filePath, 'utf8'), conteudoCorrompido);

  fs.rmSync(dir, { recursive: true, force: true });
});

// [0009.2-H] JSON válido mas com estrutura inesperada também lança erro explícito
test('[0009.2-H] loadQueueFromDisk com JSON válido mas estrutura inesperada também lança erro explícito', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'approval-queue.json');
  fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');

  assert.throws(() => loadQueueFromDisk(filePath), /corrompido/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// [0009.2-I] escrita atômica: sem arquivo temporário residual, sem truncamento no fluxo normal
test('[0009.2-I] saveQueueToDisk grava por arquivo temporário + rename, sem deixar resíduo nem truncamento', () => {
  const dir = tempDir();
  const filePath = path.join(dir, 'approval-queue.json');
  const queue = createEmptyQueue();
  addProspect(queue, discoveryFor([novoAchado()]));

  saveQueueToDisk(queue, filePath);

  const arquivosNoDir = fs.readdirSync(dir);
  assert.deepEqual(arquivosNoDir, ['approval-queue.json']);
  const conteudo = fs.readFileSync(filePath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(conteudo));

  fs.rmSync(dir, { recursive: true, force: true });
});

// [0009.2-J] idempotência: dupla aprovação/rejeição continua bloqueada; redescoberta não reverte estado terminal
test('[0009.2-J] segunda aprovação/rejeição continua bloqueada; redescoberta não reverte estado terminal', () => {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()]));
  approveProspect(queue, item.prospectId, reviewerContext(), 'ok');

  assert.throws(() => approveProspect(queue, item.prospectId, reviewerContext(), 'de novo'), /transição não permitida/);
  assert.throws(() => rejectProspect(queue, item.prospectId, reviewerContext(), 'mudei de ideia'), /transição não permitida/);

  addProspect(queue, discoveryFor([novoAchado()]));
  assert.equal(getProspect(queue, item.prospectId).estado, QUEUE_STATE.APROVADO_PARA_CRM);
});
