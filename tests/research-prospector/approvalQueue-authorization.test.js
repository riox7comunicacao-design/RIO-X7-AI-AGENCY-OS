// Fase E — o Approval Queue recebe a autorização por INJEÇÃO (fecha R1).
//
// Cobre três frentes:
//  1) a PORTA authorizeReviewer(context, requiredPermission) -> { userId, name, role }
//     vista do domínio, com autorizadores de teste: falha fechada sem autorizador,
//     autorizar ANTES de tocar na fila, resposta mínima obrigatória, SYSTEM nunca
//     revisor, reviewedBy sempre vindo do autorizador;
//  2) a INTEGRAÇÃO com a ponte real de src/auth e AuthorizationContext REAIS —
//     inclusive a cadeia completa (access token verificado -> USER -> contexto ->
//     ação), sem rede: CLOSER autorizado aprova/rejeita, INACTIVE, contexto
//     inválido e identidade simples são recusados, o adaptador legado não contorna
//     nada, e as transições/DNC existentes seguem iguais;
//  3) as FRONTEIRAS: o domínio não importa src/auth e não deriva da permissão do
//     catálogo de auth.
//
// A confiança do domínio no autorizador é uma fronteira arquitetural interna
// confiável (trusted internal architectural boundary), NÃO criptografia: quem
// controla a composição escolhe o autorizador — o teste [E-19] documenta esse
// limite em vez de fingir uma proteção que não existe.
//
// Determinístico e sem rede: fila em memória e contextos fictícios (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const approvalQueueModule = require('../../src/research-prospector/approvalQueue');
const {
  QUEUE_STATE,
  ACTOR,
  ALLOWED_TRANSITIONS,
  createEmptyQueue,
  addProspect,
  createApprovalReviewActions,
  getProspect,
  getHistory,
  markDuplicado,
  markDnc,
  markDadosInsuficientes,
} = approvalQueueModule;
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');

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
const { createAuthorizationContext, verifiedIdentityFor, verifiedIdentitiesFor } = require('../helpers/authFixtures');

// ---------------------------------------------------------------------------
// Fixtures (fictícias)
// ---------------------------------------------------------------------------
const briefing = { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', quantidadeDesejada: 10, exclusoes: [] };

function novoAchado(overrides = {}) {
  return {
    empresa: 'Consultório Exemplo',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: {
      site: [{ valor: 'consultorioexemplo.com.br', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }],
    },
    fontes: [],
    ...overrides,
  };
}

function discoveryFor(rawFindings, crmRecords = []) {
  return runDiscoveryPipeline({ briefing, rawFindings, crmRecords }).resultados[0];
}

function filaComProspect(crmRecords = []) {
  const queue = createEmptyQueue();
  const item = addProspect(queue, discoveryFor([novoAchado()], crmRecords));
  return { queue, item, id: item.prospectId };
}

const snapshot = (queue) => JSON.stringify(queue);
const crmComDnc = [{ empresa: 'Bloqueado', site: 'https://consultorioexemplo.com.br', doNotContact: true }];
const crmComDuplicado = [{ empresa: 'Já Cadastrado', site: 'https://consultorioexemplo.com.br', cidade: 'Petrópolis' }];

function buildUser(overrides = {}) {
  return defineUser({
    userId: 'user-closer-1',
    authUserId: 'auth-closer-1',
    name: 'Closer de Teste',
    email: 'closer@example.test',
    role: ROLE.COMMERCIAL_CLOSER,
    status: USER_STATUS.ACTIVE,
    ...overrides,
  });
}

const contextFor = (overrides) => createAuthorizationContext(buildUser(overrides));

// A composição de produção: a porta real (a ponte de src/auth) injetada no domínio.
const acoesReais = () => createApprovalReviewActions({ authorizeReviewer: authorizeReviewerForApprovalQueue });

// Só as linhas de CÓDIGO: descarta as de comentário (// , /* e * ).
function linhasDeCodigo(fonte) {
  return fonte
    .split('\n')
    .filter((linha) => !/^\s*(\/\/|\/\*|\*)/.test(linha))
    .join('\n');
}

// Contextos que NÃO são um AuthorizationContext emitido (a antiga identidade simples,
// literais, cópias e clones de um contexto real, não-objetos). Usado por vários testes.
function contextosNaoEmitidos() {
  const original = contextFor({ role: ROLE.ADMIN });
  const simples = { userId: original.userId, name: original.name, role: original.role, permissions: [...original.permissions] };
  const literal = { ...simples, authUserId: original.authUserId, status: original.status };
  return [
    ['undefined', undefined],
    ['null', null],
    ['texto livre (o antigo reviewer)', 'Breno'],
    ['número', 42],
    ['lista', []],
    ['objeto vazio', {}],
    ['identidade simples { userId, name, role, permissions }', simples],
    ['identidade simples congelada', Object.freeze({ ...simples, permissions: Object.freeze([...simples.permissions]) })],
    ['literal com a forma perfeita de um contexto, congelado', Object.freeze({ ...literal, permissions: Object.freeze([...literal.permissions]) })],
    ['cópia rasa de um contexto real', { ...original }],
    ['structuredClone de um contexto real', structuredClone(original)],
    ['clone via JSON de um contexto real', JSON.parse(JSON.stringify(original))],
    ['Object.create(contexto real)', Object.create(original)],
  ];
}

// ===========================================================================
// 1) Falha fechada sem autorizador  (item 2)
// ===========================================================================
test('[E-1] sem autorizador injetado a fábrica falha fechada, e as funções soltas approveProspect/rejectProspect também — mesmo com um contexto perfeito', () => {
  const { queue, id } = filaComProspect();
  const antes = snapshot(queue);

  for (const opcoes of [
    undefined,
    null,
    {},
    { authorizeReviewer: undefined },
    { authorizeReviewer: null },
    { authorizeReviewer: 'autorizo' },
    { authorizeReviewer: {} },
    { authorizeReviewer: true },
    42,
    'x',
    [],
  ]) {
    assert.throws(() => createApprovalReviewActions(opcoes), /exige \{ authorizeReviewer \}/, `opções: ${String(opcoes)}`);
  }
  assert.throws(() => createApprovalReviewActions(), /authorizeReviewer/);

  // As funções soltas existem só para falhar fechado — nunca aprovam nem rejeitam.
  const contexto = contextFor({ role: ROLE.ADMIN });
  assert.throws(() => approvalQueueModule.approveProspect(queue, id, contexto, 'ok'), /approveProspect solto está desativado/);
  assert.throws(() => approvalQueueModule.rejectProspect(queue, id, contexto, 'sem fit'), /rejectProspect solto está desativado/);
  assert.throws(() => approvalQueueModule.approveProspect(), /solto está desativado/);
  assert.throws(() => approvalQueueModule.rejectProspect(), /solto está desativado/);

  assert.equal(snapshot(queue), antes, 'a fila não mudou');
  assert.equal(getProspect(queue, id).estado, QUEUE_STATE.AGUARDANDO_REVISAO);
});

test('[E-2] o autorizador é capturado na criação e o objeto de ações é congelado: nada muda depois', (t) => {
  const { queue, id } = filaComProspect();
  const nega = t.mock.fn(() => {
    throw new Error('negado pelo autorizador capturado');
  });
  const opcoes = { authorizeReviewer: nega };
  const acoes = createApprovalReviewActions(opcoes);

  // Trocar o autorizador nas opções depois da criação não afeta as ações já criadas.
  opcoes.authorizeReviewer = () => ({ userId: 'x', name: 'X', role: ROLE.ADMIN });
  assert.throws(() => acoes.approveProspect(queue, id, {}, 'ok'), /negado pelo autorizador capturado/);
  assert.equal(nega.mock.callCount(), 1);

  assert.equal(Object.isFrozen(acoes), true);
  assert.deepEqual(Object.keys(acoes).sort(), ['approveProspect', 'rejectProspect']);
  assert.equal(Reflect.set(acoes, 'approveProspect', () => {}), false, 'as ações não podem ser substituídas no objeto devolvido');
  assert.equal(Reflect.deleteProperty(acoes, 'rejectProspect'), false);
});

// ===========================================================================
// 2) Contrato da porta, com autorizadores de teste  (itens 3 e 13, parte)
// ===========================================================================
test('[E-3] o domínio chama o autorizador uma vez por ação, com o contexto opaco e APPROVE:LEAD_APPROVAL, antes de tocar na fila', (t) => {
  const contextoOpaco = Object.freeze({ qualquer: 'coisa', que: 'só o autorizador entende' });
  const autorizador = t.mock.fn(() => ({ userId: 'u-1', name: 'Revisora', role: ROLE.ADMIN }));
  const { approveProspect, rejectProspect } = createApprovalReviewActions({ authorizeReviewer: autorizador });

  const a = filaComProspect();
  const rejeitado = rejectProspect(a.queue, a.id, contextoOpaco, 'Fora do ICP');
  assert.equal(rejeitado.estado, QUEUE_STATE.REJEITADO);
  assert.equal(autorizador.mock.callCount(), 1);
  assert.deepEqual(autorizador.mock.calls[0].arguments, [contextoOpaco, 'APPROVE:LEAD_APPROVAL']);
  assert.equal(autorizador.mock.calls[0].arguments[0], contextoOpaco, 'o contexto é repassado sem cópia nem interpretação');

  const b = filaComProspect();
  const aprovado = approveProspect(b.queue, b.id, contextoOpaco, 'ok');
  assert.equal(aprovado.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(autorizador.mock.callCount(), 2);
  assert.deepEqual(autorizador.mock.calls[1].arguments, [contextoOpaco, 'APPROVE:LEAD_APPROVAL']);
});

test('[E-4] autorizador que nega: o erro é propagado, a transição não acontece e a fila permanece exatamente como estava', (t) => {
  const { queue, id } = filaComProspect();
  const antes = snapshot(queue);
  const historicoAntes = getHistory(queue, id).length;
  const autorizador = t.mock.fn(() => {
    throw new Error('revisão negada pelo autorizador de teste');
  });
  const { approveProspect, rejectProspect } = createApprovalReviewActions({ authorizeReviewer: autorizador });

  assert.throws(() => approveProspect(queue, id, {}, 'ok'), /revisão negada pelo autorizador de teste/);
  assert.throws(() => rejectProspect(queue, id, {}, 'sem fit'), /revisão negada pelo autorizador de teste/);
  assert.equal(autorizador.mock.callCount(), 2);

  assert.equal(snapshot(queue), antes, 'nenhuma mudança na fila');
  assert.equal(getProspect(queue, id).estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(getHistory(queue, id).length, historicoAntes, 'nenhuma entrada nova no histórico');
});

test('[E-5] a autorização vem antes de tudo: sem autorização não há oráculo da existência do prospect nem da validação do motivo', () => {
  const { queue, id } = filaComProspect();
  const nega = () => {
    throw new Error('negado');
  };
  const sem = createApprovalReviewActions({ authorizeReviewer: nega });

  assert.throws(() => sem.approveProspect(queue, 'id:que-nao-existe', {}, 'ok'), /negado/);
  assert.throws(() => sem.rejectProspect(queue, 'id:que-nao-existe', {}, 'sem fit'), /negado/);
  assert.throws(() => sem.rejectProspect(queue, id, {}, ''), /negado/);
  assert.throws(() => sem.rejectProspect(queue, id, {}, undefined), /negado/);

  // Autorizado, os erros de validação continuam aparecendo normalmente.
  const { approveProspect, rejectProspect } = acoesReais();
  const contexto = contextFor();
  assert.throws(() => approveProspect(queue, 'id:que-nao-existe', contexto, 'ok'), /não encontrado/);
  assert.throws(() => rejectProspect(queue, id, contexto, ''), /motivo/);
});

test('[E-6] o domínio só aceita de volta uma identidade MÍNIMA { userId, name, role }: qualquer outra resposta do autorizador falha fechado', () => {
  const respostasInvalidas = [
    ['undefined', undefined, /esperava um objeto/],
    ['null', null, /esperava um objeto/],
    ['true (autorizou, sem identidade)', true, /esperava um objeto/],
    ['texto', 'Breno', /esperava um objeto/],
    ['lista', [], /esperava um objeto/],
    ['sem userId', { name: 'N', role: ROLE.ADMIN }, /userId é obrigatório/],
    ['sem name', { userId: 'u', role: ROLE.ADMIN }, /name é obrigatório/],
    ['sem role', { userId: 'u', name: 'N' }, /role é obrigatório/],
    ['userId em branco', { userId: '   ', name: 'N', role: ROLE.ADMIN }, /userId é obrigatório/],
    ['name que não é texto', { userId: 'u', name: 42, role: ROLE.ADMIN }, /name é obrigatório/],
    ['role vazia', { userId: 'u', name: 'N', role: '' }, /role é obrigatório/],
    [
      'com permissions (a identidade legada)',
      { userId: 'u', name: 'N', role: ROLE.ADMIN, permissions: ['APPROVE:LEAD_APPROVAL'] },
      /campos não permitidos: permissions/,
    ],
    ['com authUserId', { userId: 'u', name: 'N', role: ROLE.ADMIN, authUserId: 'a' }, /campos não permitidos: authUserId/],
    ['com status', { userId: 'u', name: 'N', role: ROLE.ADMIN, status: 'ACTIVE' }, /campos não permitidos: status/],
    ['Promise (autorizador assíncrono)', Promise.resolve({ userId: 'u', name: 'N', role: ROLE.ADMIN }), /síncrona/],
  ];

  for (const [rotulo, resposta, mensagem] of respostasInvalidas) {
    const { queue, id } = filaComProspect();
    const antes = snapshot(queue);
    const acoes = createApprovalReviewActions({ authorizeReviewer: () => resposta });

    assert.throws(() => acoes.approveProspect(queue, id, {}, 'ok'), mensagem, `approve: ${rotulo}`);
    assert.throws(() => acoes.rejectProspect(queue, id, {}, 'sem fit'), mensagem, `reject: ${rotulo}`);
    assert.equal(snapshot(queue), antes, `a fila não mudou: ${rotulo}`);
  }
});

test('[E-7] reviewedBy é a identidade que o AUTORIZADOR devolveu (aparada, só { userId, name, role }) — nunca algo lido do contexto', () => {
  const contexto = { userId: 'do-contexto', name: 'Do Contexto', role: ROLE.ADMIN };
  const acoes = createApprovalReviewActions({
    authorizeReviewer: () => ({ userId: '  u-9  ', name: ' Nome do Autorizador ', role: ` ${ROLE.COMMERCIAL_CLOSER} ` }),
  });
  const esperado = { userId: 'u-9', name: 'Nome do Autorizador', role: ROLE.COMMERCIAL_CLOSER };

  const a = filaComProspect();
  const aprovado = acoes.approveProspect(a.queue, a.id, contexto, 'ok');
  const registroAprovacao = aprovado.historico[aprovado.historico.length - 1];
  assert.deepEqual(registroAprovacao.reviewedBy, esperado);
  assert.equal(registroAprovacao.actor, ACTOR.HUMAN);

  const b = filaComProspect();
  const rejeitado = acoes.rejectProspect(b.queue, b.id, contexto, 'Fora do ICP');
  const registroRejeicao = rejeitado.historico[rejeitado.historico.length - 1];
  assert.deepEqual(registroRejeicao.reviewedBy, esperado);
  assert.equal(registroRejeicao.actor, ACTOR.HUMAN);
  assert.equal(registroRejeicao.motivo, 'Fora do ICP');
});

// ===========================================================================
// SYSTEM continua bloqueado  (item 9)
// ===========================================================================
test('[E-8] SYSTEM continua bloqueado: um autorizador que devolva a role SYSTEM (em qualquer caixa) nunca aprova nem rejeita', () => {
  for (const role of ['SYSTEM', 'system', ' System ', 'SYSTEM ']) {
    const { queue, id } = filaComProspect();
    const antes = snapshot(queue);
    const acoes = createApprovalReviewActions({
      authorizeReviewer: () => ({ userId: 'ia-1', name: 'Especialista de IA', role }),
    });

    assert.throws(() => acoes.approveProspect(queue, id, {}, 'ok'), /SYSTEM não é um revisor/, `approve: "${role}"`);
    assert.throws(() => acoes.rejectProspect(queue, id, {}, 'sem fit'), /SYSTEM não é um revisor/, `reject: "${role}"`);
    assert.equal(snapshot(queue), antes, `a fila não mudou: "${role}"`);
  }

  // Pela cadeia real, SYSTEM nem chega a ser uma role de USER: não há contexto a apresentar.
  assert.throws(() => buildUser({ role: 'SYSTEM' }));

  // E nenhuma TRANSIÇÃO para APROVADO_PARA_CRM tem actor SYSTEM, em nenhum caminho. (A nota
  // de redescoberta que o sistema grava num item já decidido tem from == to: não é uma
  // transição, e por isso fica fora desta checagem.)
  const { queue, id } = filaComProspect();
  acoesReais().approveProspect(queue, id, contextFor(), 'ok');
  addProspect(queue, discoveryFor([novoAchado()]));
  const transicoesParaAprovado = getHistory(queue, id).filter(
    (entrada) => entrada.to === QUEUE_STATE.APROVADO_PARA_CRM && entrada.from !== entrada.to
  );
  assert.equal(transicoesParaAprovado.length, 1);
  assert.equal(transicoesParaAprovado[0].actor, ACTOR.HUMAN);
});

// ===========================================================================
// 3) Integração com a ponte real e contextos reais
// ===========================================================================
test('[E-9] cadeia completa (access token verificado -> USER -> contexto -> ponte -> fila): um CLOSER autorizado aprova e outro rejeita, com reviewedBy correto', async (t) => {
  const store = createUserStore([
    buildUser({ userId: 'user-closer-1', authUserId: 'auth-closer-1', name: 'Closer Um', email: 'um@example.test' }),
    buildUser({ userId: 'user-closer-2', authUserId: 'auth-closer-2', name: 'Closer Dois', email: 'dois@example.test' }),
  ]);
  const [identidade1, identidade2] = await verifiedIdentitiesFor(t, [
    { authUserId: 'auth-closer-1', email: 'um@example.test' },
    { authUserId: 'auth-closer-2', email: 'dois@example.test' },
  ]);
  const contexto1 = resolveAuthorizationContext(store, identidade1);
  const contexto2 = resolveAuthorizationContext(store, identidade2);
  const acoes = acoesReais();

  // Item 4 — o CLOSER autorizado consegue aprovar.
  const a = filaComProspect();
  const aprovado = acoes.approveProspect(a.queue, a.id, contexto1, 'Bom fit — aprovado');
  assert.equal(aprovado.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  const registroAprovacao = aprovado.historico[aprovado.historico.length - 1];
  assert.deepEqual(registroAprovacao.reviewedBy, { userId: 'user-closer-1', name: 'Closer Um', role: ROLE.COMMERCIAL_CLOSER });
  assert.equal(registroAprovacao.actor, ACTOR.HUMAN);
  assert.equal(registroAprovacao.motivo, 'Bom fit — aprovado');
  assert.ok(registroAprovacao.timestamp);

  // Item 5 — o CLOSER autorizado consegue rejeitar.
  const b = filaComProspect();
  const rejeitado = acoes.rejectProspect(b.queue, b.id, contexto2, 'Fora do ICP');
  assert.equal(rejeitado.estado, QUEUE_STATE.REJEITADO);
  const registroRejeicao = rejeitado.historico[rejeitado.historico.length - 1];
  assert.deepEqual(registroRejeicao.reviewedBy, { userId: 'user-closer-2', name: 'Closer Dois', role: ROLE.COMMERCIAL_CLOSER });
  assert.equal(registroRejeicao.actor, ACTOR.HUMAN);
  assert.equal(registroRejeicao.motivo, 'Fora do ICP');
});

test('[E-10] usuário INACTIVE é recusado (aprovar e rejeitar), mesmo com USER cadastrado e identidade verificada — a fila não muda', async (t) => {
  const store = createUserStore([buildUser({ status: USER_STATUS.INACTIVE })]);
  const identidade = await verifiedIdentityFor(t, { authUserId: 'auth-closer-1', email: 'closer@example.test' });
  const contexto = resolveAuthorizationContext(store, identidade);
  assert.equal(contexto.status, USER_STATUS.INACTIVE, 'o resolver ainda emite o contexto: a recusa é da ponte');

  const { queue, id } = filaComProspect();
  const antes = snapshot(queue);
  const acoes = acoesReais();

  assert.throws(() => acoes.approveProspect(queue, id, contexto, 'ok'), /usuário inativo/);
  assert.throws(() => acoes.rejectProspect(queue, id, contexto, 'sem fit'), /usuário inativo/);
  assert.equal(snapshot(queue), antes);
});

test('[E-11] contexto ou identidade inválidos são recusados: ausente, não-objeto, literal, cópia, clone, imitação congelada — e a fila não muda', () => {
  const acoes = acoesReais();
  const { queue, id } = filaComProspect();
  const antes = snapshot(queue);

  for (const [rotulo, invalido] of contextosNaoEmitidos()) {
    assert.throws(() => acoes.approveProspect(queue, id, invalido, 'ok'), /AuthorizationContext inválido/, `approve: ${rotulo}`);
    assert.throws(() => acoes.rejectProspect(queue, id, invalido, 'sem fit'), /AuthorizationContext inválido/, `reject: ${rotulo}`);
  }
  assert.equal(snapshot(queue), antes);

  // Um contexto emitido de verdade continua funcionando depois de todas as tentativas.
  assert.equal(acoes.approveProspect(queue, id, contextFor(), 'ok').estado, QUEUE_STATE.APROVADO_PARA_CRM);
});

test('[E-12] uma identidade simples NÃO é suficiente: nem completa, nem congelada, nem com a permissão certa — só um AuthorizationContext emitido', () => {
  const emitido = contextFor({ role: ROLE.ADMIN });
  const simples = { userId: emitido.userId, name: emitido.name, role: emitido.role, permissions: [...emitido.permissions] };
  assert.equal(simples.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), true, 'a identidade simples carrega a permissão certa');

  const acoes = acoesReais();
  for (const identidade of [simples, Object.freeze({ ...simples, permissions: Object.freeze([...simples.permissions]) })]) {
    const { queue, id } = filaComProspect();
    const antes = snapshot(queue);

    // pela composição real: não é um contexto emitido
    assert.throws(() => acoes.approveProspect(queue, id, identidade, 'ok'), /AuthorizationContext inválido/);
    assert.throws(() => acoes.rejectProspect(queue, id, identidade, 'sem fit'), /AuthorizationContext inválido/);
    // pelas funções soltas: não existe caminho sem autorizador
    assert.throws(() => approvalQueueModule.approveProspect(queue, id, identidade, 'ok'), /solto está desativado/);
    assert.throws(() => approvalQueueModule.rejectProspect(queue, id, identidade, 'sem fit'), /solto está desativado/);

    assert.equal(snapshot(queue), antes);
    assert.equal(getProspect(queue, id).estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  }
});

test('[E-13] o legado toApprovalQueueIdentity não contorna a autorização: nem como contexto, nem nas funções soltas, nem injetado como autorizador', (t) => {
  const contexto = contextFor({ role: ROLE.ADMIN });
  const legado = toApprovalQueueIdentity(contexto); // o adaptador transitório ainda converte…
  assert.equal(legado.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), true);

  const acoes = acoesReais();
  const { queue, id } = filaComProspect();
  const antes = snapshot(queue);

  // 1) …mas o resultado não é um contexto emitido: a ponte real o recusa.
  assert.throws(() => acoes.approveProspect(queue, id, legado, 'ok'), /AuthorizationContext inválido/);
  assert.throws(() => acoes.rejectProspect(queue, id, legado, 'sem fit'), /AuthorizationContext inválido/);

  // 2) As funções soltas não o aceitam.
  assert.throws(() => approvalQueueModule.approveProspect(queue, id, legado, 'ok'), /solto está desativado/);
  assert.throws(() => approvalQueueModule.rejectProspect(queue, id, legado, 'sem fit'), /solto está desativado/);

  // 3) Injetado como autorizador ele devolve `permissions`, que o domínio recusa —
  //    mesmo com um contexto válido e ativo (ele não confere a permissão exigida).
  const injetado = createApprovalReviewActions({ authorizeReviewer: toApprovalQueueIdentity });
  assert.throws(() => injetado.approveProspect(queue, id, contexto, 'ok'), /campos não permitidos: permissions/);
  assert.throws(() => injetado.rejectProspect(queue, id, contexto, 'sem fit'), /campos não permitidos: permissions/);

  // 4) O caso que importa: um contexto real SEM a permissão (derivação reduzida só
  //    neste teste). O adaptador legado o converte sem olhar a permissão de negócio;
  //    mesmo injetado, o domínio o recusa; a ponte nova nega com "acesso negado".
  const usuario = buildUser({ userId: 'user-sem-aprovacao', authUserId: 'auth-sem-aprovacao' });
  t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  const semPermissao = createAuthorizationContext(usuario);
  assert.equal(semPermissao.permissions.includes(PERMISSION.APPROVE_LEAD_APPROVAL), false);
  assert.doesNotThrow(() => toApprovalQueueIdentity(semPermissao), 'o legado não confere a permissão de negócio');
  assert.throws(() => injetado.approveProspect(queue, id, semPermissao, 'ok'), /campos não permitidos: permissions/);
  assert.throws(() => acoes.approveProspect(queue, id, semPermissao, 'ok'), /acesso negado/);

  assert.equal(snapshot(queue), antes, 'a fila permanece inalterada');
});

// ===========================================================================
// reviewedBy, transições e DNC  (itens 10, 11 e 12)
// ===========================================================================
test('[E-14] reviewedBy correto pela composição real: só { userId, name, role } do USER, sem permissions, authUserId, status ou e-mail', () => {
  const acoes = acoesReais();
  for (const role of [ROLE.ADMIN, ROLE.COMMERCIAL_CLOSER]) {
    const contexto = contextFor({ role, userId: `user-${role}`, authUserId: `auth-${role}`, name: `Revisor ${role}` });
    const esperado = { userId: `user-${role}`, name: `Revisor ${role}`, role };

    const a = filaComProspect();
    const aprovado = acoes.approveProspect(a.queue, a.id, contexto, 'ok');
    assert.deepEqual(aprovado.historico[aprovado.historico.length - 1].reviewedBy, esperado, `approve ${role}`);

    const b = filaComProspect();
    const rejeitado = acoes.rejectProspect(b.queue, b.id, contexto, 'sem fit');
    assert.deepEqual(rejeitado.historico[rejeitado.historico.length - 1].reviewedBy, esperado, `reject ${role}`);
  }

  // Nada além disso é persistido: o item serializado não contém o authUserId nem o e-mail do USER.
  const { queue, id } = filaComProspect();
  acoes.approveProspect(queue, id, contextFor({ authUserId: 'auth-nao-deve-vazar', email: 'nao-deve-vazar@example.test' }), 'ok');
  const serializado = JSON.stringify(queue);
  assert.doesNotMatch(serializado, /auth-nao-deve-vazar|nao-deve-vazar@example\.test/);
  assert.doesNotMatch(serializado, /"permissions"/);
});

test('[E-15] as transições existentes continuam: AGUARDANDO_REVISAO -> APROVADO_PARA_CRM | REJEITADO; os estados terminais seguem terminais; estados e mapa não mudaram', () => {
  // Estados e transições exatamente como antes da Fase E.
  assert.deepEqual(QUEUE_STATE, {
    AGUARDANDO_REVISAO: 'AGUARDANDO_REVISAO',
    APROVADO_PARA_CRM: 'APROVADO_PARA_CRM',
    REJEITADO: 'REJEITADO',
    DUPLICADO: 'DUPLICADO',
    DNC: 'DNC',
    DADOS_INSUFICIENTES: 'DADOS_INSUFICIENTES',
    EXPIRADO: 'EXPIRADO',
  });
  assert.deepEqual(ALLOWED_TRANSITIONS, {
    AGUARDANDO_REVISAO: ['APROVADO_PARA_CRM', 'REJEITADO', 'DADOS_INSUFICIENTES', 'DNC', 'DUPLICADO'],
  });

  const acoes = acoesReais();
  const contexto = contextFor({ role: ROLE.ADMIN });
  const naoPermitida = /transição não permitida/;

  for (const [rotulo, decidir, estadoFinal] of [
    ['aprovado', (q, i) => acoes.approveProspect(q, i, contexto, 'ok'), QUEUE_STATE.APROVADO_PARA_CRM],
    ['rejeitado', (q, i) => acoes.rejectProspect(q, i, contexto, 'sem fit'), QUEUE_STATE.REJEITADO],
  ]) {
    const { queue, id } = filaComProspect();
    const item = decidir(queue, id);
    assert.equal(item.estado, estadoFinal, rotulo);
    assert.equal(getHistory(queue, id).length, 2, `${rotulo}: uma entrada nova no histórico`);
    const entrada = getHistory(queue, id)[1];
    assert.equal(entrada.from, QUEUE_STATE.AGUARDANDO_REVISAO);
    assert.equal(entrada.to, estadoFinal);

    // Terminal: nenhuma decisão nem marcação de sistema sai desse estado.
    const antes = snapshot(queue);
    assert.throws(() => acoes.approveProspect(queue, id, contexto, 'de novo'), naoPermitida, `${rotulo}: aprovar de novo`);
    assert.throws(() => acoes.rejectProspect(queue, id, contexto, 'mudei de ideia'), naoPermitida, `${rotulo}: rejeitar depois`);
    assert.throws(() => markDuplicado(queue, id, ['dominio']), naoPermitida, `${rotulo}: markDuplicado`);
    assert.throws(() => markDnc(queue, id), naoPermitida, `${rotulo}: markDnc`);
    assert.throws(() => markDadosInsuficientes(queue, id, 'motivo'), naoPermitida, `${rotulo}: markDadosInsuficientes`);
    assert.equal(snapshot(queue), antes, `${rotulo}: nada mudou`);
  }
});

test('[E-16] o DNC continua funcionando: um revisor autorizado não aprova nem rejeita um prospect DNC (nem DUPLICADO), e a redescoberta não o reabre', () => {
  const acoes = acoesReais();
  const contexto = contextFor({ role: ROLE.ADMIN });

  // DNC vindo da verificação do CRM.
  const dnc = filaComProspect(crmComDnc);
  assert.equal(dnc.item.estado, QUEUE_STATE.DNC);
  const antesDnc = snapshot(dnc.queue);
  assert.throws(() => acoes.approveProspect(dnc.queue, dnc.id, contexto, 'ok'), /transição não permitida: DNC -> APROVADO_PARA_CRM/);
  assert.throws(() => acoes.rejectProspect(dnc.queue, dnc.id, contexto, 'sem fit'), /transição não permitida: DNC -> REJEITADO/);
  assert.equal(snapshot(dnc.queue), antesDnc);

  // A redescoberta, mesmo sem DNC no CRM, não reabre o prospect.
  addProspect(dnc.queue, discoveryFor([novoAchado()], []));
  assert.equal(getProspect(dnc.queue, dnc.id).estado, QUEUE_STATE.DNC);

  // DNC marcado pelo sistema sobre um prospect ainda em revisão.
  const marcado = filaComProspect();
  markDnc(marcado.queue, marcado.id);
  assert.equal(getProspect(marcado.queue, marcado.id).estado, QUEUE_STATE.DNC);
  assert.throws(() => acoes.approveProspect(marcado.queue, marcado.id, contexto, 'ok'), /transição não permitida/);

  // DUPLICADO também bloqueia a decisão humana.
  const duplicado = filaComProspect(crmComDuplicado);
  assert.equal(duplicado.item.estado, QUEUE_STATE.DUPLICADO);
  assert.throws(() => acoes.approveProspect(duplicado.queue, duplicado.id, contexto, 'ok'), /transição não permitida: DUPLICADO -> APROVADO_PARA_CRM/);
  assert.throws(() => acoes.rejectProspect(duplicado.queue, duplicado.id, contexto, 'sem fit'), /transição não permitida: DUPLICADO -> REJEITADO/);
});

// ===========================================================================
// Fila inalterada quando a autorização falha  (item 13)
// ===========================================================================
test('[E-17] toda recusa de autorização deixa a fila, o estado e o histórico exatamente como estavam — aprovar e rejeitar', async (t) => {
  const store = createUserStore([buildUser({ status: USER_STATUS.INACTIVE })]);
  const identidade = await verifiedIdentityFor(t, { authUserId: 'auth-closer-1', email: 'closer@example.test' });
  const contextoInativo = resolveAuthorizationContext(store, identidade);

  // Um contexto REAL sem a permissão (derivação reduzida só neste teste).
  const usuarioSemPermissao = buildUser({ userId: 'user-sem-aprovacao', authUserId: 'auth-sem-aprovacao' });
  const derivacao = t.mock.method(constants, 'getRolePermissions', () => Object.freeze([PERMISSION.READ_CRM]));
  const contextoSemPermissao = createAuthorizationContext(usuarioSemPermissao);
  derivacao.mock.restore();

  const real = acoesReais();
  const cenarios = [
    ['contexto ausente', real, undefined],
    ['identidade simples', real, { userId: 'u', name: 'N', role: ROLE.ADMIN, permissions: ['APPROVE:LEAD_APPROVAL'] }],
    ['literal com a forma perfeita', real, Object.freeze({ ...contextFor(), permissions: Object.freeze([PERMISSION.APPROVE_LEAD_APPROVAL]) })],
    ['usuário INACTIVE', real, contextoInativo],
    ['sem a permissão APPROVE:LEAD_APPROVAL', real, contextoSemPermissao],
    [
      'autorizador que lança',
      createApprovalReviewActions({
        authorizeReviewer: () => {
          throw new Error('negado');
        },
      }),
      {},
    ],
    ['autorizador que devolve algo inválido', createApprovalReviewActions({ authorizeReviewer: () => ({ userId: 'u' }) }), {}],
    ['autorizador que devolve role SYSTEM', createApprovalReviewActions({ authorizeReviewer: () => ({ userId: 'ia', name: 'IA', role: 'SYSTEM' }) }), {}],
  ];

  for (const [rotulo, acoes, contexto] of cenarios) {
    const { queue, id } = filaComProspect();
    const itemAntes = structuredClone(getProspect(queue, id));
    const antes = snapshot(queue);

    assert.throws(() => acoes.approveProspect(queue, id, contexto, 'ok'), undefined, `approve: ${rotulo}`);
    assert.throws(() => acoes.rejectProspect(queue, id, contexto, 'sem fit'), undefined, `reject: ${rotulo}`);

    assert.equal(snapshot(queue), antes, `fila inalterada: ${rotulo}`);
    assert.deepEqual(getProspect(queue, id), itemAntes, `item inalterado: ${rotulo}`);
    assert.equal(getProspect(queue, id).estado, QUEUE_STATE.AGUARDANDO_REVISAO, `estado: ${rotulo}`);
    assert.equal(getHistory(queue, id).length, 1, `histórico: ${rotulo}`);
    assert.equal(
      getHistory(queue, id).some((entrada) => Object.prototype.hasOwnProperty.call(entrada, 'reviewedBy')),
      false,
      `nenhum reviewedBy foi gravado: ${rotulo}`
    );
  }
});

// ===========================================================================
// 4) Fronteiras
// ===========================================================================
test('[E-18] a permissão do domínio e a do catálogo de src/auth não divergem (o domínio duplica o literal de propósito)', () => {
  assert.equal(approvalQueueModule.PERMISSION.APPROVE_LEAD_APPROVAL, PERMISSION.APPROVE_LEAD_APPROVAL);
  assert.equal(approvalQueueModule.PERMISSION.APPROVE_LEAD_APPROVAL, 'APPROVE:LEAD_APPROVAL');
  assert.deepEqual(Object.keys(approvalQueueModule.PERMISSION), ['APPROVE_LEAD_APPROVAL'], 'o domínio só conhece a permissão do seu próprio domínio');
});

test('[E-19] LIMITE DOCUMENTADO: o domínio obedece ao autorizador injetado — proteger a composição é papel da camada de Services, não do domínio', () => {
  // Fronteira arquitetural interna confiável, não criptografia: quem controla a
  // composição escolhe o autorizador. Um autorizador que sempre autoriza É
  // obedecido pelo domínio. Este teste existe para não fingir uma proteção que
  // não existe (ver docs/security/0001-authorization-threat-model.md); a
  // mitigação é composição só em código confiável (Services), Fase F.
  const { queue, id } = filaComProspect();
  const permissivo = createApprovalReviewActions({
    authorizeReviewer: () => ({ userId: 'qualquer', name: 'Qualquer Um', role: ROLE.ADMIN }),
  });
  const aprovado = permissivo.approveProspect(queue, id, undefined, 'ok');
  assert.equal(aprovado.estado, QUEUE_STATE.APROVADO_PARA_CRM);
});

test('[E-20] o domínio research-prospector NÃO importa src/auth (a fronteira é só a porta authorizeReviewer) e assertValidIdentity deixou de existir', () => {
  const dominioDir = path.join(__dirname, '../../src/research-prospector');
  const authDir = path.join(__dirname, '../../src/auth');
  const arquivos = fs.readdirSync(dominioDir).filter((arquivo) => arquivo.endsWith('.js'));
  assert.ok(arquivos.includes('approvalQueue.js'));

  for (const arquivo of arquivos) {
    const codigo = linhasDeCodigo(fs.readFileSync(path.join(dominioDir, arquivo), 'utf8'));
    for (const [, alvo] of codigo.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!alvo.startsWith('.')) continue; // módulos nativos (fs, path) e pacotes
      const resolvido = path.resolve(dominioDir, alvo);
      const importaAuth = resolvido === authDir || resolvido.startsWith(authDir + path.sep);
      assert.equal(importaAuth, false, `${arquivo} importa ${alvo}, que resolve para dentro de src/auth`);
    }
    assert.doesNotMatch(codigo, /\bassertValidIdentity\b/, `${arquivo} ainda define ou usa assertValidIdentity`);
  }
});

// A guarda de transitionState (SYSTEM nunca transiciona para APROVADO_PARA_CRM) é uma
// camada de defesa em profundidade INALCANÇÁVEL pela API pública: as ações fixam
// ACTOR.HUMAN, e transitionState não é (nem deve ser) exportado — exportá-lo abriria um
// caminho de transição arbitrária, sem autorização. Por isso ela é testada de caixa-branca
// numa cópia PRIVADA do módulo, compilada aqui só com um export extra: o módulo de
// produção não muda e nenhuma outra parte do processo enxerga essa cópia.
function copiaPrivadaDoDominio() {
  const arquivo = require.resolve('../../src/research-prospector/approvalQueue');
  const fonte = `${fs.readFileSync(arquivo, 'utf8')}\nmodule.exports.__transitionState = transitionState;\n`;
  const copia = new Module(arquivo, module);
  copia.filename = arquivo;
  copia.paths = Module._nodeModulePaths(path.dirname(arquivo));
  copia._compile(fonte, arquivo);
  return copia.exports;
}

test('[E-21] a guarda de transitionState contra SYSTEM está viva (caixa-branca, cópia privada): SYSTEM nunca transiciona para APROVADO_PARA_CRM', () => {
  const dominio = copiaPrivadaDoDominio();
  assert.notEqual(dominio, approvalQueueModule, 'é uma cópia privada, não o módulo de produção');
  assert.equal(approvalQueueModule.__transitionState, undefined, 'o módulo de produção NÃO exporta transitionState');
  assert.equal(typeof dominio.__transitionState, 'function');
  const transitionState = dominio.__transitionState;
  const novoItem = () => addProspect(createEmptyQueue(), discoveryFor([novoAchado()]));
  const agora = () => new Date().toISOString();

  // SYSTEM não aprova — e o item não muda.
  const alvo = novoItem();
  const antes = JSON.stringify(alvo);
  assert.throws(
    () => transitionState(alvo, QUEUE_STATE.APROVADO_PARA_CRM, ACTOR.SYSTEM, 'tentativa', agora(), {}),
    /SYSTEM não pode aprovar/
  );
  assert.equal(JSON.stringify(alvo), antes);
  assert.equal(alvo.estado, QUEUE_STATE.AGUARDANDO_REVISAO);

  // A mesma função, com actor HUMAN, aprova; e o SYSTEM segue fazendo as transições de sistema.
  const humano = novoItem();
  transitionState(humano, QUEUE_STATE.APROVADO_PARA_CRM, ACTOR.HUMAN, 'ok', agora(), {});
  assert.equal(humano.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  const sistema = novoItem();
  transitionState(sistema, QUEUE_STATE.DNC, ACTOR.SYSTEM, 'DNC confirmado', agora(), {});
  assert.equal(sistema.estado, QUEUE_STATE.DNC);
});
