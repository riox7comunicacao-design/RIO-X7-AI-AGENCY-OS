// Ação de PROPOSTA de candidatos do domínio da fila (createApprovalProposalActions em src/research-prospector/approvalQueue.js).
//
// O que estes testes provam: existe uma fábrica À PARTE (propor ≠ aprovar ≠ promover); sem autorizador nada existe; a ordem é autorizar
// e só então olhar o candidato; o autorizador é o de PROPOSE e a identidade não vem do chamador; um candidato bloqueado (DNC, duplicado,
// dados insuficientes) NUNCA entra; o elegível entra pela função addProspect já existente, como AGUARDANDO_REVISAO, sem aprovação e
// sem estado novo; e a máquina de estados e as fábricas de revisão e de promoção não mudaram.

const test = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE, OPERATIONAL_STATE } = require('../../src/research-prospector/discovery');

const IDENTIDADE = { userId: 'user-teste', name: 'Pessoa de Teste', role: 'ADMIN' };
const evidencia = (valor, tipoFonte = SOURCE_TYPE.OFICIAL) => ({ valor, fonte: 'Fonte de teste', tipoFonte });

function descoberta(campos, extras = {}, crmRecords = []) {
  const finding = { empresa: 'Empresa Proposta Teste', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos, fontes: [], ...extras };
  return runDiscoveryPipeline({ briefing: { nicho: 'Psicologia' }, rawFindings: [finding], crmRecords }).resultados[0];
}

const completo = () => descoberta({ site: [evidencia('proposta.example.test')], instagram: [evidencia('@proposta')], telefone: [evidencia('24999990001')] });

test('[PROP-1] a fábrica de proposta exige um autorizador (função): sem ele nada é criado, e o objeto tem SÓ proposeProspect', () => {
  for (const ruim of [undefined, null, {}, { authorizeProposer: 'x' }, { authorizeReviewer: () => IDENTIDADE }]) {
    assert.throws(() => queue.createApprovalProposalActions(ruim), /exige \{ authorizeProposer \}/);
  }
  const acoes = queue.createApprovalProposalActions({ authorizeProposer: () => IDENTIDADE });
  assert.deepEqual(Object.keys(acoes), ['proposeProspect']);
  assert.equal(Object.isFrozen(acoes), true);
  assert.equal('approveProspect' in acoes || 'rejectProspect' in acoes || 'recordPromotion' in acoes, false);
});

test('[PROP-2] propor não dá a capacidade de aprovar ou promover, e as outras fábricas continuam com exatamente as suas ações', () => {
  const revisao = queue.createApprovalReviewActions({ authorizeReviewer: () => IDENTIDADE });
  const promocao = queue.createApprovalPromotionActions({ authorizeReviewer: () => IDENTIDADE });
  assert.deepEqual(Object.keys(revisao).sort(), ['approveProspect', 'rejectProspect']);
  assert.deepEqual(Object.keys(promocao).sort(), ['recordPromotion', 'recordPromotionBlocked']);
  assert.throws(() => queue.createApprovalReviewActions({ authorizeProposer: () => IDENTIDADE }), /authorizeReviewer/);
  assert.throws(() => queue.createApprovalPromotionActions({ authorizeProposer: () => IDENTIDADE }), /authorizeReviewer/);
});

test('[PROP-3] a permissão pedida ao autorizador é EXATAMENTE PROPOSE:LEAD_APPROVAL, e o autorizador é chamado antes de qualquer olhada no candidato', () => {
  const pedidos = [];
  const acoes = queue.createApprovalProposalActions({ authorizeProposer: (contexto, permissao) => (pedidos.push([contexto, permissao]), IDENTIDADE) });
  const fila = queue.createEmptyQueue();
  acoes.proposeProspect(fila, 'contexto-opaco', completo());
  assert.deepEqual(pedidos, [['contexto-opaco', 'PROPOSE:LEAD_APPROVAL']]);
  assert.equal(queue.PERMISSION.PROPOSE_LEAD_APPROVAL, 'PROPOSE:LEAD_APPROVAL');
});

test('[PROP-4] sem autorização nada acontece: o autorizador lança e a fila fica exatamente como estava — e nem a validade do candidato é revelada', () => {
  const acoes = queue.createApprovalProposalActions({ authorizeProposer: () => { throw new Error('acesso negado: sem PROPOSE:LEAD_APPROVAL'); } });
  const fila = queue.createEmptyQueue();
  assert.throws(() => acoes.proposeProspect(fila, {}, completo()), /acesso negado/);
  assert.throws(() => acoes.proposeProspect(fila, {}, null), /acesso negado/, 'candidato inválido e sem autorização: a recusa de autorização vem primeiro');
  assert.deepEqual(fila, { items: {} });
});

test('[PROP-5] um autorizador defeituoso (identidade inválida, com permissions, SYSTEM, Promise, false) é recusado: nada entra na fila', () => {
  const maus = [() => false, () => undefined, () => 'ok', () => ({ userId: 'u', name: 'n', role: 'ADMIN', permissions: ['x'] }), () => ({ userId: 'u', name: 'n', role: 'SYSTEM' }), () => ({ userId: '', name: 'n', role: 'ADMIN' }), () => Promise.resolve(IDENTIDADE)];
  for (const mau of maus) {
    const acoes = queue.createApprovalProposalActions({ authorizeProposer: mau });
    const fila = queue.createEmptyQueue();
    assert.throws(() => acoes.proposeProspect(fila, {}, completo()));
    assert.deepEqual(fila, { items: {} });
  }
});

test('[PROP-6] o candidato elegível entra pela função addProspect existente: AGUARDANDO_REVISAO, ator SYSTEM, sem reviewedBy, sem promocao — e a possível duplicidade também entra (um humano precisa ver)', () => {
  const acoes = queue.createApprovalProposalActions({ authorizeProposer: () => IDENTIDADE });
  const fila = queue.createEmptyQueue();
  const item = acoes.proposeProspect(fila, {}, completo());
  assert.equal(item.estado, queue.QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(item.historico.length, 1);
  assert.equal(item.historico[0].actor, queue.ACTOR.SYSTEM);
  assert.equal('reviewedBy' in item.historico[0], false);
  assert.equal('promocao' in item, false);
  assert.equal(fila.items[item.prospectId], item);

  const possivel = descoberta({ site: [evidencia('novo-dominio.example.test')] }, { empresa: 'Mesmo Nome Teste' }, [{ empresa: 'Mesmo Nome Teste', cidade: 'Petrópolis' }]);
  assert.equal(possivel.estadoOperacional, OPERATIONAL_STATE.POSSIVEL_DUPLICADO);
  assert.equal(acoes.proposeProspect(fila, {}, possivel).estado, queue.QUEUE_STATE.AGUARDANDO_REVISAO);
});

test('[PROP-7] um candidato JÁ bloqueado pelo discovery (DNC, duplicado, dados insuficientes) nunca é proposto: a ação recusa e a fila não muda', () => {
  const acoes = queue.createApprovalProposalActions({ authorizeProposer: () => IDENTIDADE });
  const bloqueados = {
    DNC: descoberta({ site: [evidencia('bloqueado.example.test')] }, {}, [{ empresa: 'Outro', site: 'bloqueado.example.test', doNotContact: true }]),
    DUPLICADO: descoberta({ site: [evidencia('duplicado.example.test')] }, {}, [{ empresa: 'Outro', site: 'duplicado.example.test' }]),
    DADOS_INSUFICIENTES: descoberta({ site: [evidencia('fraco.example.test', SOURCE_TYPE.SECUNDARIA)] }),
  };
  for (const [nome, resultado] of Object.entries(bloqueados)) {
    assert.equal(resultado.estadoOperacional, nome, `pré-condição: ${nome}`);
    const fila = queue.createEmptyQueue();
    assert.throws(() => acoes.proposeProspect(fila, {}, resultado), /candidato bloqueado/, nome);
    assert.deepEqual(fila, { items: {} }, nome);
  }
});

test('[PROP-8] candidato inválido (sem empresa, não objeto): recusado depois da autorização, sem tocar na fila', () => {
  const acoes = queue.createApprovalProposalActions({ authorizeProposer: () => IDENTIDADE });
  for (const ruim of [null, undefined, 'texto', 5, {}, { empresa: '' }, { empresa: null }]) {
    const fila = queue.createEmptyQueue();
    assert.throws(() => acoes.proposeProspect(fila, {}, ruim), /discoveryResult inválido/);
    assert.deepEqual(fila, { items: {} });
  }
});

test('[PROP-9] a reentrada segue a regra existente: propor de novo não duplica o item nem sobrescreve uma decisão humana; e o autorizador capturado na criação não pode ser trocado depois', () => {
  const opcoes = { authorizeProposer: () => IDENTIDADE };
  const acoes = queue.createApprovalProposalActions(opcoes);
  opcoes.authorizeProposer = () => { throw new Error('trocado'); };
  const fila = queue.createEmptyQueue();
  const primeiro = acoes.proposeProspect(fila, {}, completo());
  const revisao = queue.createApprovalReviewActions({ authorizeReviewer: () => ({ userId: 'u-rev', name: 'Revisora', role: 'COMMERCIAL_CLOSER' }) });
  revisao.approveProspect(fila, primeiro.prospectId, {}, 'ok');
  const segundo = acoes.proposeProspect(fila, {}, completo());
  assert.equal(Object.keys(fila.items).length, 1);
  assert.equal(segundo.estado, queue.QUEUE_STATE.APROVADO_PARA_CRM, 'a decisão humana foi preservada');
  assert.match(segundo.historico.at(-1).motivo, /Redescoberto/);
});

test('[PROP-10] a máquina de estados não mudou: os mesmos sete estados e as mesmas transições', () => {
  assert.deepEqual(Object.keys(queue.QUEUE_STATE).sort(), ['AGUARDANDO_REVISAO', 'APROVADO_PARA_CRM', 'DADOS_INSUFICIENTES', 'DNC', 'DUPLICADO', 'EXPIRADO', 'REJEITADO']);
  assert.deepEqual(queue.ALLOWED_TRANSITIONS, {
    AGUARDANDO_REVISAO: ['APROVADO_PARA_CRM', 'REJEITADO', 'DADOS_INSUFICIENTES', 'DNC', 'DUPLICADO'],
  });
});
