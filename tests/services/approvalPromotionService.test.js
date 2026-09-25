'use strict';

// Approval Promotion Service — a fronteira de aplicação da AUDITORIA da promoção Approval Queue -> CRM (decisão 0016).
//
//   CRM Integration Service -> ApprovalPromotionService -> Approval Queue (domínio) -> arquivo da fila
//
// O que estes testes protegem: o Service só existe com um autorizador injetado; autoriza (APPROVE:LEAD_APPROVAL, pela
// ponte REAL de src/auth) ANTES de qualquer outra coisa e antes de tocar no arquivo; só aceita um AuthorizationContext
// emitido; não aceita identidade, estado nem nada além das chaves conhecidas; só grava quando o domínio terminou sem
// erro (o arquivo continua exatamente como estava quando falha); devolve CÓPIAS; e — a razão de ele existir à parte —
// a superfície do Approval Queue Service (a que a API expõe) NÃO ganhou nenhuma operação de promoção.
//
// Isolamento: o domínio, as pontes de autorização e o pipeline de descoberta são os REAIS; a fila é um arquivo
// TEMPORÁRIO (removido ao fim do teste). Determinístico, sem rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const domain = require('../../src/research-prospector/approvalQueue');
const { createApprovalPromotionService } = require('../../src/services/approvalPromotionService');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { analyzeSource } = require('../helpers/staticImports');
const { admin, closer, inativo, achado, aprovar, novoAmbiente, OPERADOR_ADMIN } = require('../helpers/promotionFixtures');

const { QUEUE_STATE, PROMOTION_RESULT, PROMOTION_BLOCK } = domain;
const SOURCE = path.join(__dirname, '..', '..', 'src', 'services', 'approvalPromotionService.js');
const CRM_ID = 'crm:11111111-1111-4111-8111-111111111111';

const ambienteComAprovado = (t) => {
  const env = novoAmbiente(t, { a: { finding: achado('Clínica Alfa', 'clinica-alfa') }, b: { finding: achado('Clínica Beta', 'clinica-beta') } });
  aprovar(env, 'a');
  return env;
};

test('[SP-1] o Service cria com dependências válidas (congelado, só as duas operações) e falha fechado NA CRIAÇÃO sem autorizador ou com um domínio incompleto', (t) => {
  const env = ambienteComAprovado(t);
  assert.equal(Object.isFrozen(env.promocao), true);
  assert.deepEqual(Object.keys(env.promocao).sort(), ['recordPromotion', 'recordPromotionBlocked']);

  for (const invalido of [undefined, null, {}, { authorizeReviewer: null }, { authorizeReviewer: 'sim' }]) {
    assert.throws(() => createApprovalPromotionService({ ...(invalido || {}), queuePath: env.queuePath }), /exige \{ authorizeReviewer \}/, String(invalido));
  }
  assert.throws(() => createApprovalPromotionService(undefined), /exige \{ authorizeReviewer \}/);
  for (const nome of ['createApprovalPromotionActions', 'loadQueueFromDisk', 'saveQueueToDisk']) {
    assert.throws(
      () => createApprovalPromotionService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: env.queuePath, approvalQueue: { ...domain, [nome]: undefined } }),
      new RegExp(`não tem a função ${nome}\\(\\)`),
      nome
    );
  }
  for (const invalido of [null, 'texto', 42]) {
    assert.throws(() => createApprovalPromotionService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: env.queuePath, approvalQueue: invalido }), /approvalQueue/, String(invalido));
  }
  for (const caminho of ['', '   ', 42, null]) {
    assert.throws(() => createApprovalPromotionService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: caminho }), /queuePath deve ser um texto não vazio/, String(caminho));
  }
  assert.throws(
    () => createApprovalPromotionService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: env.queuePath, approvalQueue: { ...domain, createApprovalPromotionActions: () => ({}) } }),
    /não devolveu as ações de auditoria da promoção/
  );
});

test('[SP-2] a superfície do Approval Queue Service (a que a API expõe) NÃO ganhou nenhuma operação de promoção — só as 5 de sempre', (t) => {
  const env = ambienteComAprovado(t);
  const servico = createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: env.queuePath });
  assert.deepEqual(Object.keys(servico).sort(), ['approveProspect', 'getHistory', 'getProspect', 'listQueue', 'rejectProspect']);
  assert.equal(servico.recordPromotion, undefined);
  assert.equal(servico.recordPromotionBlocked, undefined);
});

test('[SP-3] recordPromotion: autoriza, grava no arquivo, devolve uma CÓPIA e a identidade registrada é a do CONTEXTO (nunca a de um argumento)', (t) => {
  const env = ambienteComAprovado(t);
  const item = env.promocao.recordPromotion(admin(), env.ids.a, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID });
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(item.promocao.crmRecordId, CRM_ID);
  assert.deepEqual(item.promocao.promovidoPor, OPERADOR_ADMIN);

  const noArquivo = env.itemDaFila('a');
  assert.deepEqual(noArquivo, item, 'o que foi devolvido é o que foi gravado');
  item.promocao.crmRecordId = 'adulterado';
  item.historico.length = 0;
  assert.equal(env.itemDaFila('a').promocao.crmRecordId, CRM_ID, 'alterar a cópia devolvida não altera nada');

  // o mesmo registro de novo: idempotente
  const tamanho = env.itemDaFila('a').historico.length;
  env.promocao.recordPromotion(closer(), env.ids.a, { resultado: PROMOTION_RESULT.RECONCILIADO, crmRecordId: CRM_ID });
  assert.equal(env.itemDaFila('a').historico.length, tamanho);
});

test('[SP-4] recordPromotionBlocked: só uma entrada de auditoria, com o código, o motivo e quem tentou — sem `promocao` e sem mudar o estado', (t) => {
  const env = ambienteComAprovado(t);
  const item = env.promocao.recordPromotionBlocked(admin(), env.ids.a, { codigo: PROMOTION_BLOCK.DUPLICADO, motivo: 'já existe no CRM', crmRecordId: CRM_ID });
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.equal(item.promocao, undefined);
  const entrada = item.historico[item.historico.length - 1];
  assert.equal(entrada.motivo, 'Promoção bloqueada: já existe no CRM');
  assert.deepEqual(entrada.reviewedBy, OPERADOR_ADMIN);
  assert.deepEqual(entrada.promocao, { resultado: 'BLOQUEADO', codigo: PROMOTION_BLOCK.DUPLICADO, crmRecordId: CRM_ID });
});

test('[SP-5] a autorização vem PRIMEIRO e a fila não é tocada: contexto que não é emitido (literal, cópia, clone, vazio) e usuário inativo são recusados, com o arquivo idêntico', (t) => {
  const env = ambienteComAprovado(t);
  const antes = env.textoDaFila();
  const legitimo = admin();
  const naoEmitidos = [
    'Breno',
    42,
    null,
    undefined,
    [],
    {},
    { ...legitimo },
    structuredClone(legitimo),
    JSON.parse(JSON.stringify(legitimo)),
    Object.create(legitimo),
    new Proxy(legitimo, {}),
    { userId: legitimo.userId, name: legitimo.name, role: legitimo.role, permissions: [...legitimo.permissions] },
  ];
  const detalhes = { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID };
  for (const contexto of naoEmitidos) {
    assert.throws(() => env.promocao.recordPromotion(contexto, env.ids.a, detalhes), Error, String(contexto));
    assert.throws(() => env.promocao.recordPromotionBlocked(contexto, env.ids.a, { codigo: PROMOTION_BLOCK.DNC, motivo: 'x' }), Error, String(contexto));
  }
  assert.throws(() => env.promocao.recordPromotion(inativo(), env.ids.a, detalhes), /usuário inativo/);
  assert.throws(() => env.promocao.recordPromotionBlocked(inativo(), env.ids.a, { codigo: PROMOTION_BLOCK.DNC, motivo: 'x' }), /usuário inativo/);
  assert.equal(env.textoDaFila(), antes);
});

test('[SP-6] só as chaves conhecidas passam: userId, role, permissions, actor, reviewedBy, estado, promovidoPor... são recusados ANTES do disco; um Object.prototype poluído não completa os detalhes', (t) => {
  const env = ambienteComAprovado(t);
  const antes = env.textoDaFila();
  const base = { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID };
  for (const extra of ['userId', 'role', 'permissions', 'actor', 'reviewedBy', 'estado', 'promovidoPor', 'promocao', 'authUserId', 'approvalId', '__proto__x']) {
    assert.throws(() => env.promocao.recordPromotion(admin(), env.ids.a, { ...base, [extra]: 'forjado' }), /opções não reconhecidas/, extra);
  }
  for (const invalido of ['texto', 42, [], true]) {
    assert.throws(() => env.promocao.recordPromotion(admin(), env.ids.a, invalido), /as opções devem ser um objeto/, String(invalido));
  }
  for (const id of [undefined, null, '', '   ', 7, {}, []]) {
    assert.throws(() => env.promocao.recordPromotion(admin(), id, base), /prospectId deve ser um texto não vazio/, String(id));
  }
  assert.equal(env.textoDaFila(), antes);

  Object.prototype.resultado = PROMOTION_RESULT.CRIADO;
  Object.prototype.crmRecordId = CRM_ID;
  try {
    assert.throws(() => env.promocao.recordPromotion(admin(), env.ids.a, {}), /resultado de promoção desconhecido/);
    assert.throws(() => env.promocao.recordPromotion(admin(), env.ids.a), /resultado de promoção desconhecido/);
  } finally {
    delete Object.prototype.resultado;
    delete Object.prototype.crmRecordId;
  }
  assert.equal(env.textoDaFila(), antes);
});

test('[SP-7] só grava quando o domínio terminou sem erro: prospect pendente, inexistente ou com id herdado do protótipo => erro do domínio, arquivo idêntico; e uma falha de gravação não deixa nada pela metade', (t) => {
  const env = ambienteComAprovado(t);
  const antes = env.textoDaFila();
  const detalhes = { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID };
  assert.throws(() => env.promocao.recordPromotion(admin(), env.ids.b, detalhes), /só se registra em um prospect APROVADO_PARA_CRM/);
  for (const id of ['id:nao-existe', 'constructor', '__proto__', 'toString']) {
    assert.throws(() => env.promocao.recordPromotion(admin(), id, detalhes), /prospect não encontrado na fila/, id);
  }
  assert.equal(env.textoDaFila(), antes);

  const falhaAoGravar = createApprovalPromotionService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    approvalQueue: {
      ...domain,
      saveQueueToDisk: () => {
        throw new Error('disco cheio (simulado)');
      },
    },
  });
  assert.throws(() => falhaAoGravar.recordPromotion(admin(), env.ids.a, detalhes), /disco cheio \(simulado\)/, 'o erro de persistência passa intacto');
  assert.equal(env.textoDaFila(), antes, 'e o arquivo real continua como estava');
});

test('[SP-8] o Service não conhece o CRM nem a rede: nenhuma importação de src/crm, src/server ou do SDK; nenhum fetch, process, eval ou texto suspeito', () => {
  const analise = analyzeSource(fs.readFileSync(SOURCE, 'utf8'), 'src/services/approvalPromotionService.js');
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(analise.refs.map((ref) => ref.specifier).sort(), ['../auth', '../research-prospector/approvalQueue'], 'a lista de importações é fechada: nenhum CRM, servidor, SDK ou rede');
  const identificadores = new Set(analise.tokens.filter((token) => token.type === 'id').map((token) => token.value));
  for (const proibido of ['fetch', 'XMLHttpRequest', 'WebSocket', 'process', 'eval', 'Function', 'createClient']) {
    assert.equal(identificadores.has(proibido), false, `o código do Service não pode usar ${proibido}`);
  }
  for (const texto of analise.strings) {
    assert.doesNotMatch(texto.value, /supabase|notion|https?:|\.env|service_role|SUPABASE_|token/i, `texto suspeito: ${texto.value.slice(0, 60)}`);
  }
});

test('[SP-9] a autorização vem ANTES de validar a entrada e de ler o disco: quem não está autorizado recebe a recusa de AUTORIZAÇÃO (nunca detalhes de validação nem um erro do arquivo), mesmo com entrada inválida e com a fila corrompida', (t) => {
  const env = ambienteComAprovado(t);
  fs.writeFileSync(env.queuePath, '{ isto não é json', 'utf8');
  const invalidas = [
    [undefined, undefined],
    ['', { resultado: 'X' }],
    [env.ids.a, { userId: 'forjado' }],
    [env.ids.a, 'texto'],
    [env.ids.a, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID }],
  ];
  for (const [id, detalhes] of invalidas) {
    assert.throws(() => env.promocao.recordPromotion(inativo(), id, detalhes), /usuário inativo/, 'inativo');
    assert.throws(() => env.promocao.recordPromotion({ falso: true }, id, detalhes), (erro) => !/opções|prospectId|corrompido|JSON/.test(erro.message), 'contexto falso');
    assert.throws(() => env.promocao.recordPromotionBlocked(inativo(), id, detalhes), /usuário inativo/, 'bloqueio, inativo');
  }
  // com um contexto legítimo, aí sim o arquivo corrompido aparece
  assert.throws(() => env.promocao.recordPromotion(admin(), env.ids.a, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID }), /arquivo de fila corrompido/);
});

test('[SP-10] tudo o que sai do Service é uma CÓPIA, mesmo sobre um domínio que guarda a própria fila em memória: alterar o retorno não altera o que o domínio tem', (t) => {
  const env = ambienteComAprovado(t);
  const compartilhada = JSON.parse(fs.readFileSync(env.queuePath, 'utf8'));
  const servico = createApprovalPromotionService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    approvalQueue: { ...domain, loadQueueFromDisk: () => compartilhada, saveQueueToDisk: () => {} },
  });
  const item = servico.recordPromotion(admin(), env.ids.a, { resultado: PROMOTION_RESULT.CRIADO, crmRecordId: CRM_ID });
  assert.equal(compartilhada.items[env.ids.a].promocao.crmRecordId, CRM_ID);
  assert.notEqual(item, compartilhada.items[env.ids.a], 'não é o objeto vivo do domínio');
  item.promocao.crmRecordId = 'adulterado';
  item.historico.length = 0;
  assert.equal(compartilhada.items[env.ids.a].promocao.crmRecordId, CRM_ID);
  assert.ok(compartilhada.items[env.ids.a].historico.length > 0);
});
