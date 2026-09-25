'use strict';

// A AUDITORIA da promoção no domínio da fila (etapa CRM-INTEGRATION, decisão 0016): createApprovalPromotionActions.
//
// O que estes testes protegem: a promoção NÃO é um estado novo — o item continua APROVADO_PARA_CRM e a promoção fica num
// resumo (`promocao`) e numa entrada de histórico; só se registra num item APROVADO_PARA_CRM que o domínio tem como
// PRÓPRIO; a identidade registrada (`reviewedBy`, `promovidoPor`) vem SÓ do autorizador injetado (nunca dos detalhes);
// o autorizador é chamado primeiro e a fila não é tocada quando ele recusa; nada herdado do protótipo participa; e a
// fábrica de revisão (aprovar/rejeitar) continua exatamente a mesma.
//
// O domínio não importa src/auth: aqui o autorizador é uma função de teste que devolve a identidade mínima. Nenhum
// dado real. Determinístico, sem rede e sem disco.

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');

const { QUEUE_STATE, ACTOR, PERMISSION, PROMOTION_RESULT, PROMOTION_BLOCK, createApprovalPromotionActions, createApprovalReviewActions } = domain;

const REVISOR = Object.freeze({ userId: 'user-revisor', name: 'Revisora de Teste', role: 'ADMIN' });
const OUTRO = Object.freeze({ userId: 'user-outro', name: 'Outro Revisor', role: 'COMMERCIAL_CLOSER' });
const autorizadorDe = (identidade) => () => ({ ...identidade });

function descoberta(empresa, slug) {
  const achado = {
    empresa,
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: { site: [{ valor: `${slug}.example.test`, fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] },
    fontes: [],
  };
  return runDiscoveryPipeline({ briefing: { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', exclusoes: [] }, rawFindings: [achado], crmRecords: [] }).resultados[0];
}

// Uma fila em memória com: aprovado (APROVADO_PARA_CRM), pendente (AGUARDANDO_REVISAO) e rejeitado.
function fila() {
  const queue = domain.createEmptyQueue();
  const aprovado = domain.addProspect(queue, descoberta('Clínica Aprovada', 'aprovada'));
  const pendente = domain.addProspect(queue, descoberta('Clínica Pendente', 'pendente'));
  const rejeitado = domain.addProspect(queue, descoberta('Clínica Rejeitada', 'rejeitada'));
  const revisao = createApprovalReviewActions({ authorizeReviewer: autorizadorDe(OUTRO) });
  revisao.approveProspect(queue, aprovado.prospectId, {}, 'aprovada');
  revisao.rejectProspect(queue, rejeitado.prospectId, {}, 'sem fit');
  return { queue, ids: { aprovado: aprovado.prospectId, pendente: pendente.prospectId, rejeitado: rejeitado.prospectId } };
}

const acoes = (identidade = REVISOR) => createApprovalPromotionActions({ authorizeReviewer: autorizadorDe(identidade) });
const CRM_ID = 'crm:11111111-1111-4111-8111-111111111111';
const OUTRO_CRM_ID = 'crm:22222222-2222-4222-8222-222222222222';

test('[P-1] a fábrica falha fechada sem autorizador, captura o autorizador na criação e devolve um objeto congelado com só as duas ações — e a fábrica de REVISÃO continua a mesma', () => {
  for (const invalido of [undefined, null, {}, { authorizeReviewer: null }, { authorizeReviewer: 'sim' }, { authorizeReviewer: {} }]) {
    assert.throws(() => createApprovalPromotionActions(invalido), /exige \{ authorizeReviewer \}/, String(invalido));
  }
  const opcoes = { authorizeReviewer: autorizadorDe(REVISOR) };
  const criadas = createApprovalPromotionActions(opcoes);
  opcoes.authorizeReviewer = () => {
    throw new Error('não deve ser chamado: o autorizador foi capturado na criação');
  };
  const { queue, ids } = fila();
  assert.doesNotThrow(() => criadas.recordPromotion(queue, ids.aprovado, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID }));

  assert.equal(Object.isFrozen(criadas), true);
  assert.deepEqual(Object.keys(criadas).sort(), ['recordPromotion', 'recordPromotionBlocked']);
  assert.equal(Reflect.set(criadas, 'recordPromotion', () => {}), false);

  // a fábrica de revisão não ganhou nada: aprovar e rejeitar, só
  assert.deepEqual(Object.keys(createApprovalReviewActions({ authorizeReviewer: autorizadorDe(REVISOR) })).sort(), ['approveProspect', 'rejectProspect']);
  // e as funções soltas do domínio não registram promoção (não existem)
  assert.equal(typeof domain.recordPromotion, 'undefined');
});

test('[P-2] recordPromotion NÃO muda o estado: grava o resumo `promocao` e UMA entrada de histórico, com a identidade DO AUTORIZADOR (cópia) e actor HUMAN', () => {
  const { queue, ids } = fila();
  const item = acoes().recordPromotion(queue, ids.aprovado, { qualquer: 'coisa' }, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID });
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM, 'o estado histórico da aprovação continua');
  assert.equal(item.promocao.crmRecordId, CRM_ID);
  assert.equal(item.promocao.resultado, PROMOTION_RESULT.CRIADO);
  assert.deepEqual(item.promocao.promovidoPor, REVISOR);
  assert.match(item.promocao.promovidoEm, /^\d{4}-\d{2}-\d{2}T/);

  const entrada = item.historico[item.historico.length - 1];
  assert.equal(entrada.from, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(entrada.to, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(entrada.actor, ACTOR.HUMAN);
  assert.equal(entrada.motivo, 'Promovido para o CRM');
  assert.deepEqual(entrada.reviewedBy, REVISOR);
  assert.deepEqual(entrada.promocao, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID, possivelDuplicadoDe: null });
  assert.deepEqual(Object.keys(entrada).sort(), ['actor', 'from', 'motivo', 'promocao', 'reviewedBy', 'timestamp', 'to'], 'a forma da entrada é exatamente esta');
  assert.deepEqual(Object.keys(item.promocao).sort(), ['crmRecordId', 'promovidoEm', 'promovidoPor', 'resultado']);
  assert.deepEqual(Object.keys(item).sort(), Object.keys(queue.items[ids.pendente]).concat('promocao').sort(), 'o item só ganhou `promocao`');
  assert.notEqual(entrada.reviewedBy, item.promocao.promovidoPor, 'cópias independentes, não o mesmo objeto');
  assert.equal(item.historico.filter((e) => e.actor === ACTOR.HUMAN && e.to === QUEUE_STATE.APROVADO_PARA_CRM && e.from === QUEUE_STATE.AGUARDANDO_REVISAO).length, 1, 'a aprovação continua sendo uma só');
});

test('[P-3] a identidade registrada vem SÓ do autorizador: userId, role, actor, reviewedBy, estado ou promovidoPor nos detalhes são ignorados', () => {
  const { queue, ids } = fila();
  const item = acoes(REVISOR).recordPromotion(queue, ids.aprovado, {}, {
    resultado: PROMOTION_RESULT.CRIADO,
    crmRecordId: CRM_ID,
    reviewedBy: { userId: 'forjado', name: 'Forjado', role: 'ADMIN' },
    promovidoPor: { userId: 'forjado', name: 'Forjado', role: 'ADMIN' },
    userId: 'forjado',
    role: 'ADMIN',
    actor: 'SYSTEM',
    estado: 'REJEITADO',
  });
  assert.deepEqual(item.promocao.promovidoPor, REVISOR);
  const entrada = item.historico[item.historico.length - 1];
  assert.deepEqual(entrada.reviewedBy, REVISOR);
  assert.equal(entrada.actor, ACTOR.HUMAN);
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.ok(!JSON.stringify(item).includes('forjado'));
});

test('[P-4] o autorizador é chamado primeiro, uma vez por ação, com o contexto opaco e APPROVE:LEAD_APPROVAL; se recusar, a fila não é tocada e nem revela se o prospect existe', (t) => {
  const { queue, ids } = fila();
  const antes = JSON.stringify(queue);
  const chamadas = [];
  const recusa = t.mock.fn((contexto, permissao) => {
    chamadas.push([contexto, permissao]);
    throw new Error('negado pelo autorizador');
  });
  const recusadas = createApprovalPromotionActions({ authorizeReviewer: recusa });
  const contexto = { opaco: true };
  const detalhes = { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID };
  for (const id of [ids.aprovado, ids.pendente, 'id:que-nao-existe']) {
    assert.throws(() => recusadas.recordPromotion(queue, id, contexto, detalhes), /negado pelo autorizador/, id);
    assert.throws(() => recusadas.recordPromotionBlocked(queue, id, contexto, { codigo: PROMOTION_BLOCK.DNC, motivo: 'x' }), /negado pelo autorizador/, id);
  }
  assert.equal(recusa.mock.callCount(), 6);
  for (const [ctx, permissao] of chamadas) {
    assert.equal(ctx, contexto);
    assert.equal(permissao, PERMISSION.APPROVE_LEAD_APPROVAL);
  }
  assert.equal(JSON.stringify(queue), antes);
});

test('[P-5] um autorizador defeituoso falha fechado: Promise, SYSTEM, campos a mais, campos vazios e não-objetos nunca registram nada', () => {
  const { queue, ids } = fila();
  const antes = JSON.stringify(queue);
  const detalhes = { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID };
  const defeituosos = [
    ['undefined', () => undefined],
    ['null', () => null],
    ['false', () => false],
    ['texto', () => 'autorizado'],
    ['lista', () => [REVISOR]],
    ['Promise', () => Promise.resolve(REVISOR)],
    ['SYSTEM', () => ({ ...REVISOR, role: 'SYSTEM' })],
    ['system em minúsculas', () => ({ ...REVISOR, role: ' system ' })],
    ['com permissions', () => ({ ...REVISOR, permissions: ['APPROVE:LEAD_APPROVAL'] })],
    ['com authUserId', () => ({ ...REVISOR, authUserId: 'auth-x' })],
    ['userId vazio', () => ({ ...REVISOR, userId: '  ' })],
    ['name ausente', () => ({ userId: 'u', role: 'ADMIN' })],
  ];
  for (const [nome, autorizador] of defeituosos) {
    const defeituosas = createApprovalPromotionActions({ authorizeReviewer: autorizador });
    assert.throws(() => defeituosas.recordPromotion(queue, ids.aprovado, {}, detalhes), Error, nome);
    assert.throws(() => defeituosas.recordPromotionBlocked(queue, ids.aprovado, {}, { codigo: PROMOTION_BLOCK.DNC, motivo: 'x' }), Error, nome);
  }
  assert.equal(JSON.stringify(queue), antes);
});

test('[P-6] só se registra num prospect APROVADO_PARA_CRM: pendente, rejeitado e os estados de bloqueio são recusados; um estado adulterado sem histórico também não passa de "estado"', () => {
  const { queue, ids } = fila();
  const registrar = acoes();
  for (const [nome, id] of [['pendente', ids.pendente], ['rejeitado', ids.rejeitado]]) {
    assert.throws(() => registrar.recordPromotion(queue, id, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID }), /só se registra em um prospect APROVADO_PARA_CRM/, nome);
    assert.throws(() => registrar.recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.DNC, motivo: 'x' }), /só se registra em um prospect APROVADO_PARA_CRM/, nome);
    assert.equal(queue.items[id].promocao, undefined);
  }
  for (const estado of [QUEUE_STATE.DNC, QUEUE_STATE.DUPLICADO, QUEUE_STATE.DADOS_INSUFICIENTES, QUEUE_STATE.EXPIRADO, 'INVENTADO', undefined, 42]) {
    queue.items[ids.pendente].estado = estado;
    assert.throws(() => registrar.recordPromotion(queue, ids.pendente, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID }), /só se registra em um prospect APROVADO_PARA_CRM/, String(estado));
  }
  assert.equal(queue.items[ids.aprovado].promocao, undefined, 'o aprovado nunca foi tocado pelas recusas');
});

test('[P-7] um id que o domínio não tem como PRÓPRIO nunca é um item: constructor, __proto__, toString, prototype, hasOwnProperty, vazio e não-texto', () => {
  const { queue } = fila();
  const registrar = acoes();
  const antes = JSON.stringify(queue);
  for (const id of ['constructor', '__proto__', 'toString', 'prototype', 'hasOwnProperty', 'valueOf', '', '   ', 'id:nao-existe', undefined, null, 7, {}, []]) {
    assert.throws(() => registrar.recordPromotion(queue, id, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID }), /prospect não encontrado na fila/, String(id));
    assert.throws(() => registrar.recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.DNC, motivo: 'x' }), /prospect não encontrado na fila/, String(id));
  }
  assert.equal(JSON.stringify(queue), antes);
  assert.equal(Object.prototype.promocao, undefined, 'nada vazou para o protótipo');
});

test('[P-8] registrar de novo o MESMO registro do CRM é idempotente (sem entrada duplicada); registrar um SEGUNDO registro para o mesmo prospect é recusado', () => {
  const { queue, ids } = fila();
  const registrar = acoes();
  registrar.recordPromotion(queue, ids.aprovado, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID });
  const tamanho = queue.items[ids.aprovado].historico.length;
  const de_novo = acoes(OUTRO).recordPromotion(queue, ids.aprovado, {}, { resultado: PROMOTION_RESULT.RECONCILIADO, crmRecordId: CRM_ID });
  assert.equal(de_novo.historico.length, tamanho, 'nenhuma entrada nova');
  assert.deepEqual(de_novo.promocao.promovidoPor, REVISOR, 'quem promoveu primeiro continua sendo quem promoveu');
  assert.equal(de_novo.promocao.resultado, PROMOTION_RESULT.CRIADO);
  assert.throws(() => registrar.recordPromotion(queue, ids.aprovado, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: OUTRO_CRM_ID }), /já promovido para outro registro do CRM/);
  assert.equal(queue.items[ids.aprovado].promocao.crmRecordId, CRM_ID);
  assert.equal(queue.items[ids.aprovado].historico.length, tamanho);
});

test('[P-9] os detalhes são validados: resultado conhecido, crmRecordId texto não vazio (até 200), possivelDuplicadoDe texto ou null — e nada é gravado quando inválido', () => {
  const registrar = acoes();
  const invalidos = [
    [undefined, /resultado de promoção desconhecido/],
    [null, /resultado de promoção desconhecido/],
    [{}, /resultado de promoção desconhecido/],
    [{ resultado: 'PROMOVIDO', crmRecordId: CRM_ID }, /resultado de promoção desconhecido/],
    [{ resultado: PROMOTION_RESULT.CRIADO }, /crmRecordId deve ser um texto/],
    [{ resultado: PROMOTION_RESULT.CRIADO, crmRecordId: '   ' }, /crmRecordId deve ser um texto/],
    [{ resultado: PROMOTION_RESULT.CRIADO, crmRecordId: 42 }, /crmRecordId deve ser um texto/],
    [{ resultado: PROMOTION_RESULT.CRIADO, crmRecordId: { id: CRM_ID } }, /crmRecordId deve ser um texto/],
    [{ resultado: PROMOTION_RESULT.CRIADO, crmRecordId: 'x'.repeat(201) }, /crmRecordId deve ser um texto/],
    [{ resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID, possivelDuplicadoDe: 7 }, /crmRecordId deve ser um texto/],
    [{ resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID, possivelDuplicadoDe: '' }, /crmRecordId deve ser um texto/],
  ];
  for (const [detalhes, mensagem] of invalidos) {
    const { queue, ids } = fila();
    const antes = JSON.stringify(queue);
    assert.throws(() => registrar.recordPromotion(queue, ids.aprovado, {}, detalhes), mensagem, JSON.stringify(detalhes));
    assert.equal(JSON.stringify(queue), antes);
  }
  const { queue, ids } = fila();
  const item = registrar.recordPromotion(queue, ids.aprovado, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: `  ${CRM_ID}  `, possivelDuplicadoDe: OUTRO_CRM_ID });
  assert.equal(item.promocao.crmRecordId, CRM_ID, 'espaços nas pontas são removidos');
  assert.equal(item.historico[item.historico.length - 1].promocao.possivelDuplicadoDe, OUTRO_CRM_ID);
});

test('[P-10] recordPromotionBlocked é SÓ auditoria: uma entrada com o motivo e o código, sem `promocao`, sem mudar o estado — e o item ainda pode ser promovido depois', () => {
  const { queue, ids } = fila();
  const registrar = acoes();
  const item = registrar.recordPromotionBlocked(queue, ids.aprovado, {}, { codigo: PROMOTION_BLOCK.DNC, motivo: '  a identidade está bloqueada no CRM  ', crmRecordId: OUTRO_CRM_ID });
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(item.promocao, undefined);
  const entrada = item.historico[item.historico.length - 1];
  assert.equal(entrada.motivo, 'Promoção bloqueada: a identidade está bloqueada no CRM');
  assert.equal(entrada.actor, ACTOR.HUMAN);
  assert.deepEqual(entrada.reviewedBy, REVISOR);
  assert.deepEqual(entrada.promocao, { resultado: 'BLOQUEADO', codigo: PROMOTION_BLOCK.DNC, crmRecordId: OUTRO_CRM_ID });
  assert.deepEqual(Object.keys(entrada).sort(), ['actor', 'from', 'motivo', 'promocao', 'reviewedBy', 'timestamp', 'to'], 'a forma da entrada é exatamente esta (nenhum campo de estado)');
  assert.equal(entrada.to, QUEUE_STATE.APROVADO_PARA_CRM);

  registrar.recordPromotion(queue, ids.aprovado, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID });
  assert.equal(queue.items[ids.aprovado].promocao.crmRecordId, CRM_ID);

  for (const [detalhes, mensagem] of [
    [undefined, /código de bloqueio/],
    [{ codigo: 'OUTRO', motivo: 'x' }, /código de bloqueio/],
    [{ codigo: PROMOTION_BLOCK.DNC }, /motivo do bloqueio/],
    [{ codigo: PROMOTION_BLOCK.DNC, motivo: '   ' }, /motivo do bloqueio/],
    [{ codigo: PROMOTION_BLOCK.DNC, motivo: 'x'.repeat(501) }, /motivo do bloqueio/],
    [{ codigo: PROMOTION_BLOCK.DNC, motivo: 42 }, /motivo do bloqueio/],
    [{ codigo: PROMOTION_BLOCK.DNC, motivo: 'x', crmRecordId: 7 }, /crmRecordId deve ser um texto/],
  ]) {
    assert.throws(() => registrar.recordPromotionBlocked(queue, ids.aprovado, {}, detalhes), mensagem, JSON.stringify(detalhes));
  }
});

test('[P-11] propriedades HERDADAS nunca participam: Object.prototype poluído com promocao/crmRecordId/resultado/codigo não faz um item parecer promovido nem preenche os detalhes', () => {
  const { queue, ids } = fila();
  const registrar = acoes();
  Object.prototype.promocao = { crmRecordId: OUTRO_CRM_ID };
  Object.prototype.crmRecordId = OUTRO_CRM_ID;
  Object.prototype.resultado = PROMOTION_RESULT.CRIADO;
  Object.prototype.codigo = PROMOTION_BLOCK.DNC;
  Object.prototype.motivo = 'herdado';
  try {
    // detalhes vazios: nada é herdado para completá-los
    assert.throws(() => registrar.recordPromotion(queue, ids.aprovado, {}, {}), /resultado de promoção desconhecido/);
    assert.throws(() => registrar.recordPromotionBlocked(queue, ids.aprovado, {}, {}), /código de bloqueio/);
    // detalhes com protótipo herdado
    const herdados = Object.create({ resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID });
    assert.throws(() => registrar.recordPromotion(queue, ids.aprovado, {}, herdados), /resultado de promoção desconhecido/);
    // o item NÃO parece promovido (o `promocao` herdado não conta) e registra o que foi pedido
    const item = registrar.recordPromotion(queue, ids.aprovado, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID });
    assert.equal(Object.prototype.hasOwnProperty.call(item, 'promocao'), true);
    assert.equal(item.promocao.crmRecordId, CRM_ID);
  } finally {
    delete Object.prototype.promocao;
    delete Object.prototype.crmRecordId;
    delete Object.prototype.resultado;
    delete Object.prototype.codigo;
    delete Object.prototype.motivo;
  }
});

test('[P-12] o histórico da fila continua coerente: a promoção não cria transição de saída (APROVADO_PARA_CRM segue terminal) e a redescoberta não apaga o resumo', () => {
  const { queue, ids } = fila();
  acoes().recordPromotion(queue, ids.aprovado, {}, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID });
  assert.equal(domain.ALLOWED_TRANSITIONS[QUEUE_STATE.APROVADO_PARA_CRM], undefined);
  const redescoberto = domain.addProspect(queue, descoberta('Clínica Aprovada', 'aprovada'));
  assert.equal(redescoberto.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(redescoberto.promocao.crmRecordId, CRM_ID, 'a redescoberta só registra "redescoberto" e não mexe no resumo da promoção');
});
