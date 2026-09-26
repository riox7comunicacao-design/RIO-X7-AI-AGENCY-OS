'use strict';

// CRM Integration Service — a PROMOÇÃO controlada Approval Queue -> CRM (etapa CRM-INTEGRATION, decisão 0016).
//
//   APPROVAL QUEUE (aprovação humana) -> CrmIntegrationService -> CRM Service -> CRM Domain -> arquivo
//                                                       \-> ApprovalPromotionService -> fila (auditoria)
//
// O que estes testes protegem: só um prospect APROVADO_PARA_CRM, com a aprovação humana no histórico da fila, é promovido;
// nada do que decide isso vem de fora (o único argumento é o id; opções nunca são aceitas); a autorização exige
// APPROVE:LEAD_APPROVAL e WRITE:CRM sem nenhuma permissão nova; a MESMA aprovação nunca cria dois registros
// (idempotência, também depois de uma falha no meio); o domínio do CRM continua decidindo identidade, duplicidade e DNC;
// o mapeamento preserva o que a fila tem, sem inventar; a auditoria fica nos DOIS lados; e nenhuma falha deixa um estado
// impossível.
//
// Isolamento: TUDO o que a produção usa é REAL — domínio da fila, pipeline de descoberta, os Services da fila, o CRM
// Service sobre o adapter de arquivo, o domínio do CRM e as pontes de autorização de src/auth, com contextos emitidos
// pelo emissor interno. Os arquivos são TEMPORÁRIOS (removidos ao fim de cada teste); nenhum arquivo do projeto é tocado.
// Os "doubles" existem só onde não há outro jeito de provar o ponto — e todos DELEGAM ao Service real, mudando só o que
// o teste precisa (uma falha de gravação simulada, um gancho que simula outro processo, um snapshot sem uma chave).
//
// Determinístico e sem rede (o fetch global é derrubado num teste para provar isso). Nenhum dado real: example.test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const queueDomain = require('../../src/research-prospector/approvalQueue');
const { createCrmIntegrationService, PROMOTION_OUTCOME, PROMOTION_ERROR } = require('../../src/services/crmIntegrationService');
const { authorizeCrmOperation } = require('../../src/auth');
const { CRM_STATUS, CRM_WRITABLE_FIELDS } = require('../../src/crm');
const { analyzeSource } = require('../helpers/staticImports');
const {
  admin,
  closer,
  inativo,
  achado,
  descoberta,
  evidencia,
  novoAmbiente,
  criarServicos,
  aprovar,
  OPERADOR_ADMIN,
  OPERADOR_CLOSER,
} = require('../helpers/promotionFixtures');

const { QUEUE_STATE } = queueDomain;
const SOURCE = path.join(__dirname, '..', '..', 'src', 'services', 'crmIntegrationService.js');
const SERVER_APP = path.join(__dirname, '..', '..', 'src', 'server', 'app.js');
const SERVER_INDEX = path.join(__dirname, '..', '..', 'src', 'server', 'index.js');

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const entrada = (nome, slug, extras) => ({ finding: achado(nome, slug, extras) });

// Telefones PRÓPRIOS: dois prospects com o mesmo telefone são, para o CRM, a mesma identidade (duplicidade).
const telefones = (telefone, whatsapp) => ({ telefone: [evidencia(telefone)], whatsapp: [evidencia(whatsapp)] });
const CONTATOS_BETA = telefones('(24) 98765-3000', '+55 24 98765-4000');

// Um ambiente com um prospect APROVADO por um humano (o closer aprova) e outro que continua pendente.
function ambienteAprovado(t, extras = {}) {
  const env = novoAmbiente(t, { a: entrada('Clínica Alfa', 'clinica-alfa'), b: entrada('Clínica Beta', 'clinica-beta', { campos: CONTATOS_BETA }), ...extras });
  aprovar(env, 'a');
  return env;
}

const promover = async (env, chave, contexto = admin()) => await env.integracao.promoteProspect(contexto, env.ids[chave]);

// Espera um erro da integração: o `code` estável e um trecho da mensagem.
async function recusa(fn, codigo, mensagem) {
  await assert.rejects(fn, (erro) => {
    assert.ok(erro instanceof Error);
    assert.equal(erro.code, codigo, `code esperado ${codigo}, veio ${erro.code}: ${erro.message}`);
    if (mensagem) assert.match(erro.message, mensagem);
    assert.match(erro.message, /^Promoção: /);
    return true;
  });
}

// O que uma operação NÃO pode fazer: gravar na fila ou no CRM.
async function semEfeitos(env, fn) {
  const fila = env.textoDaFila();
  const crm = env.textoDoCrm();
  try {
    return await fn();
  } finally {
    assert.equal(env.textoDaFila(), fila, 'a fila não pode ter sido alterada');
    assert.equal(env.textoDoCrm(), crm, 'o CRM não pode ter sido alterado');
  }
}

// Adultera o arquivo da fila (simula um arquivo editado à mão ou corrompido) — o que nenhum Service permite.
function editarFila(env, alterar) {
  const fila = env.lerFila();
  alterar(fila);
  fs.writeFileSync(env.queuePath, JSON.stringify(fila, null, 2), 'utf8');
}

// Um CRM Service que DELEGA ao real e falha (ou gancha) só onde o teste pede.
function crmComFalhas(crm, { createRecord, listRecords, getRecord, aoListar } = {}) {
  return {
    listRecords: async (...args) => {
      if (listRecords) throw listRecords;
      const lista = await crm.listRecords(...args);
      if (aoListar) await aoListar();
      return lista;
    },
    getRecord: async (...args) => {
      if (getRecord) throw getRecord;
      return await crm.getRecord(...args);
    },
    createRecord: async (...args) => {
      if (createRecord) throw createRecord;
      return await crm.createRecord(...args);
    },
  };
}

// O Service de auditoria que DELEGA ao real e falha nas primeiras `vezes` chamadas de cada operação.
function promocaoComFalhas(promocao, { recordPromotion = 0, recordPromotionBlocked = 0 } = {}) {
  const restantes = { recordPromotion, recordPromotionBlocked };
  const proteger = (nome) => (...args) => {
    if (restantes[nome] > 0) {
      restantes[nome] -= 1;
      throw new Error(`falha de gravação da fila (simulada): ${nome}`);
    }
    return promocao[nome](...args);
  };
  return { recordPromotion: proteger('recordPromotion'), recordPromotionBlocked: proteger('recordPromotionBlocked') };
}

const outroServico = (env, { crm, promocao, fila } = {}) =>
  createCrmIntegrationService({
    approvalQueueService: fila || env.fila,
    approvalPromotionService: promocao || env.promocao,
    crmService: crm || env.crm,
    authorizeOperation: authorizeCrmOperation,
  });

// ===========================================================================
// 1) O fluxo principal
// ===========================================================================
test('[INT-1] o serviço só existe com as quatro dependências e um autorizador síncrono; a superfície é UMA operação (promoteProspect) e o objeto é congelado', (t) => {
  const env = ambienteAprovado(t);
  assert.equal(Object.isFrozen(env.integracao), true);
  assert.deepEqual(Object.keys(env.integracao), ['promoteProspect']);
  const base = { approvalQueueService: env.fila, approvalPromotionService: env.promocao, crmService: env.crm, authorizeOperation: authorizeCrmOperation };
  assert.throws(() => createCrmIntegrationService(undefined), /exige \{ approvalQueueService \}/);
  for (const [nome, funcoes] of [
    ['approvalQueueService', ['getProspect']],
    ['approvalPromotionService', ['recordPromotion', 'recordPromotionBlocked']],
    ['crmService', ['listRecords', 'getRecord', 'createRecord']],
  ]) {
    assert.throws(() => createCrmIntegrationService({ ...base, [nome]: undefined }), new RegExp(`exige \\{ ${nome} \\}`), nome);
    assert.throws(() => createCrmIntegrationService({ ...base, [nome]: null }), new RegExp(`exige \\{ ${nome} \\}`), nome);
    for (const funcao of funcoes) {
      assert.throws(() => createCrmIntegrationService({ ...base, [nome]: { ...base[nome], [funcao]: undefined } }), new RegExp(`não tem a função ${funcao}\\(\\)`), `${nome}.${funcao}`);
    }
  }
  for (const invalido of [undefined, null, 'sim', {}]) {
    assert.throws(() => createCrmIntegrationService({ ...base, authorizeOperation: invalido }), /exige \{ authorizeOperation \}/, String(invalido));
  }
  assert.throws(() => createCrmIntegrationService({ ...base, authorizeOperation: async () => ({}) }), /deve ser síncrono/);
});

test('[INT-2] aprovação válida -> registro no CRM: CRIADO, com status PROSPECT, o registro devolvido, e a fila continua APROVADO_PARA_CRM (nenhum estado novo) com o resumo da promoção', async (t) => {
  const env = ambienteAprovado(t);
  assert.equal(env.registrosDoCrm().length, 0);
  const resultado = await promover(env, 'a');

  assert.equal(resultado.outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(resultado.prospectId, env.ids.a);
  assert.match(resultado.crmRecordId, /^crm:[0-9a-f-]{36}$/);
  assert.equal(resultado.record.id, resultado.crmRecordId);
  assert.equal(resultado.record.status, CRM_STATUS.PROSPECT);
  assert.equal(resultado.record.empresa, 'Clínica Alfa');
  assert.equal(resultado.possivelDuplicidade, null);

  const noCrm = env.registrosDoCrm();
  assert.equal(noCrm.length, 1);
  assert.equal(noCrm[0].id, resultado.crmRecordId);

  const item = env.itemDaFila('a');
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM, 'o estado histórico da aprovação continua — nenhum estado novo foi criado');
  assert.equal(item.promocao.crmRecordId, resultado.crmRecordId);
  assert.equal(item.promocao.resultado, 'CRIADO');
  assert.deepEqual(item.promocao.promovidoPor, OPERADOR_ADMIN);
  assert.equal(env.itemDaFila('b').estado, QUEUE_STATE.AGUARDANDO_REVISAO, 'o outro prospect não foi tocado');
  assert.equal(env.itemDaFila('b').promocao, undefined);
});

test('[INT-3] o retorno é o registro do CRM de verdade: idêntico ao que o CRM Service devolve, JSON-seguro, só com campos do contrato do CRM e sem dado de identidade (authUserId, e-mail de usuário, permissions, token)', async (t) => {
  const env = ambienteAprovado(t);
  const resultado = await promover(env, 'a');
  assert.deepEqual(resultado.record, await env.crm.getRecord(admin(), resultado.crmRecordId));
  assert.deepEqual(JSON.parse(JSON.stringify(resultado)), resultado, 'o resultado é JSON puro');
  assert.deepEqual(Object.keys(resultado).sort(), ['aprovacao', 'crmRecordId', 'outcome', 'possivelDuplicidade', 'promocao', 'prospectId', 'record']);
  assert.deepEqual(Object.keys(resultado.record).sort(), ['id', ...CRM_WRITABLE_FIELDS, 'status', 'dataDeEntrada', 'historico'].sort());
  const texto = JSON.stringify(resultado);
  for (const segredo of ['auth-admin-promo', 'auth-closer-promo', 'admin-promo@example.test', 'closer-promo@example.test', 'permissions', 'APPROVE:', 'WRITE:CRM', 'token']) {
    assert.ok(!texto.includes(segredo), `"${segredo}" não pode aparecer no resultado`);
  }
  // é uma cópia: alterar o resultado não altera o CRM
  resultado.record.empresa = 'Adulterada';
  resultado.aprovacao.por.name = 'Adulterado';
  assert.equal((await env.crm.getRecord(admin(), resultado.crmRecordId)).empresa, 'Clínica Alfa');
});

test('[INT-4] o mapeamento chega ao ARQUIVO do CRM exatamente: empresa, cidade, estado, nicho, telefone, WhatsApp, e-mail, site, Instagram, Facebook — e as observações da pesquisa, rotuladas', async (t) => {
  const env = ambienteAprovado(t);
  const { crmRecordId } = await promover(env, 'a');
  const gravado = env.lerCrm()[crmRecordId];
  assert.equal(gravado.empresa, 'Clínica Alfa');
  assert.equal(gravado.cidade, 'Petrópolis', 'a cidade é preservada');
  assert.equal(gravado.estado, 'RJ', 'o estado (estadoUf) é preservado');
  assert.equal(gravado.nicho, 'Clínica de Psicologia', 'o nicho é preservado');
  assert.equal(gravado.telefone, '(24) 98765-1000');
  assert.equal(gravado.whatsapp, '+55 24 98765-2000');
  assert.equal(gravado.email, 'contato@clinica-alfa.example.test');
  assert.equal(gravado.site, 'clinica-alfa.example.test');
  assert.equal(gravado.instagram, '@clinica_alfa');
  assert.equal(gravado.facebook, 'https://facebook.example.test/clinica-alfa');
  assert.match(gravado.observacoes, /^Observações da pesquisa: Atende adultos e adolescentes\.\nHipótese de oportunidade: HIPOTESE — Sem agendamento online no site\n/);
  assert.match(gravado.observacoes, /LinkedIn: https:\/\/linkedin\.example\.test\/company\/clinica-alfa/);
  assert.match(gravado.observacoes, /YouTube: https:\/\/youtube\.example\.test\/@clinica-alfa/);
  assert.match(gravado.observacoes, /Endereço: Rua de Teste, 10 — Petrópolis\/RJ/);
  assert.match(gravado.observacoes, /Fontes consultadas: https:\/\/clinica-alfa\.example\.test; Google Maps \(consulta manual\)/);
  assert.equal(gravado.problemaIdentificado, null, 'a hipótese nunca vira "problema identificado"');
  for (const semOrigem of ['contato', 'cargo', 'googlePerfil', 'temperatura', 'servicoPotencial', 'origem', 'valorProposta', 'valorTotal', 'responsavel']) {
    assert.equal(gravado[semOrigem], null, `${semOrigem}: a fila não tem esse dado — nada é inventado`);
  }
});

test('[INT-5] o mapeamento NÃO normaliza: "rj", "clinica" e "petropolis" (como a pesquisa os entregou) chegam ao CRM exatamente assim; "RJ" e "Petrópolis" também', async (t) => {
  const env = novoAmbiente(t, {
    minusculas: entrada('Consultório Minúsculo', 'consultorio-minusculo', { cidade: 'petropolis', estado: 'rj', nicho: 'clinica', campos: telefones('(24) 98765-5000', '+55 24 98765-6000') }),
    maiusculas: entrada('Consultório Maiúsculo', 'consultorio-maiusculo', { cidade: 'PETRÓPOLIS', estado: 'RJ', nicho: 'CLÍNICA', campos: telefones('(24) 98765-7000', '+55 24 98765-8000') }),
  });
  aprovar(env, 'minusculas');
  aprovar(env, 'maiusculas');
  const primeiro = await promover(env, 'minusculas');
  const segundo = await promover(env, 'maiusculas');
  const a = env.lerCrm()[primeiro.crmRecordId];
  const b = env.lerCrm()[segundo.crmRecordId];
  assert.deepEqual([a.cidade, a.estado, a.nicho], ['petropolis', 'rj', 'clinica']);
  assert.deepEqual([b.cidade, b.estado, b.nicho], ['PETRÓPOLIS', 'RJ', 'CLÍNICA']);
});

test('[INT-6] AUDITORIA nos dois lados: dá para responder qual prospect, qual aprovação, quem aprovou, quando, quem promoveu, quando, qual registro do CRM e se foi criado', async (t) => {
  const env = ambienteAprovado(t);
  const resultado = await promover(env, 'a', admin());

  // lado da FILA
  const item = env.itemDaFila('a');
  const aprovacao = item.historico.find((e) => e.to === QUEUE_STATE.APROVADO_PARA_CRM && e.from === QUEUE_STATE.AGUARDANDO_REVISAO);
  const promocao = item.historico[item.historico.length - 1];
  assert.equal(item.prospectId, env.ids.a, 'qual prospect');
  assert.deepEqual(aprovacao.reviewedBy, OPERADOR_CLOSER, 'quem aprovou');
  assert.match(aprovacao.timestamp, /^\d{4}-\d{2}-\d{2}T/, 'quando aprovou');
  assert.equal(aprovacao.actor, 'HUMAN');
  assert.deepEqual(promocao.reviewedBy, OPERADOR_ADMIN, 'quem executou a promoção');
  assert.match(promocao.timestamp, /^\d{4}-\d{2}-\d{2}T/, 'quando foi promovido');
  assert.equal(promocao.promocao.crmRecordId, resultado.crmRecordId, 'qual registro do CRM');
  assert.equal(promocao.promocao.resultado, 'CRIADO', 'foi criado');
  assert.equal(promocao.motivo, 'Promovido para o CRM');
  assert.deepEqual(resultado.aprovacao, { por: OPERADOR_CLOSER, em: aprovacao.timestamp });
  assert.deepEqual({ ...resultado.promocao, promovidoEm: undefined }, { resultado: 'CRIADO', crmRecordId: resultado.crmRecordId, promovidoEm: undefined, promovidoPor: OPERADOR_ADMIN });

  // lado do CRM (o histórico do próprio registro)
  const criacao = env.lerCrm()[resultado.crmRecordId].historico[0];
  assert.equal(criacao.from, null);
  assert.equal(criacao.to, CRM_STATUS.PROSPECT);
  assert.equal(criacao.actor, 'HUMAN');
  assert.deepEqual(criacao.reviewedBy, OPERADOR_ADMIN, 'quem promoveu (a identidade do autorizador, nunca de um argumento)');
  assert.equal(criacao.motivo, `Promovido da Approval Queue (prospect ${JSON.stringify(env.ids.a)}; aprovado por ${OPERADOR_CLOSER.name} em ${aprovacao.timestamp})`);
});

test('[INT-7] o serviço passa ao CRM Service SÓ os campos mapeados e o motivo (reason): nenhum status, reviewedBy, actor, userId ou permissão — a identidade do histórico é a do AUTORIZADOR do CRM', async (t) => {
  const env = ambienteAprovado(t);
  const chamadas = [];
  const crmObservado = {
    listRecords: async (...args) => await env.crm.listRecords(...args),
    getRecord: async (...args) => await env.crm.getRecord(...args),
    createRecord: async (...args) => {
      chamadas.push(args);
      return await env.crm.createRecord(...args);
    },
  };
  const servico = outroServico(env, { crm: crmObservado });
  await servico.promoteProspect(admin(), env.ids.a);
  assert.equal(chamadas.length, 1);
  const [, campos, opcoes] = chamadas[0];
  for (const chave of Object.keys(campos)) assert.ok(CRM_WRITABLE_FIELDS.includes(chave), chave);
  for (const proibido of ['status', 'reviewedBy', 'actor', 'userId', 'role', 'permissions', 'id', 'historico']) assert.equal(Object.prototype.hasOwnProperty.call(campos, proibido), false, proibido);
  assert.deepEqual(Object.keys(opcoes), ['reason']);
  assert.match(opcoes.reason, /^Promovido da Approval Queue \(prospect "id:clinica-alfa\.example\.test";/);
});

// ===========================================================================
// 2) Só o que foi aprovado por um humano
// ===========================================================================
test('[INT-8] AGUARDANDO_REVISAO NÃO entra no CRM: recusa clara, e nem a fila nem o CRM são tocados (nem uma entrada de auditoria)', async (t) => {
  const env = ambienteAprovado(t);
  await semEfeitos(env, async () => await recusa(async () => await promover(env, 'b'), PROMOTION_ERROR.NOT_APPROVED, /só um prospect APROVADO_PARA_CRM pode ser promovido \(estado atual: AGUARDANDO_REVISAO\)/));
  assert.equal(env.registrosDoCrm().length, 0);
});

test('[INT-9] REJEITADO NÃO entra no CRM, mesmo que alguém peça de novo e de novo', async (t) => {
  const env = novoAmbiente(t, { r: entrada('Clínica Rejeitada', 'clinica-rejeitada') });
  env.fila.rejectProspect(closer(), env.ids.r, { reason: 'sem fit' });
  assert.equal(env.itemDaFila('r').estado, QUEUE_STATE.REJEITADO);
  await semEfeitos(env, async () => {
    for (let i = 0; i < 3; i += 1) await recusa(async () => await promover(env, 'r'), PROMOTION_ERROR.NOT_APPROVED, /estado atual: REJEITADO/);
  });
});

test('[INT-10] DNC, DUPLICADO, DADOS_INSUFICIENTES e EXPIRADO NÃO entram no CRM: cada estado de bloqueio da fila é recusado, sem gravar nada', async (t) => {
  const env = novoAmbiente(t, {
    dnc: { finding: achado('Clínica DNC', 'clinica-dnc'), crmRecords: [{ empresa: 'DNC', site: 'https://clinica-dnc.example.test', doNotContact: true }] },
    duplicada: { finding: achado('Clínica Duplicada', 'clinica-duplicada'), crmRecords: [{ empresa: 'Existente', site: 'https://clinica-duplicada.example.test' }] },
    insuficiente: { finding: achado('Clínica Sem Dados', 'clinica-sem-dados', { campos: { site: [], instagram: [], telefone: [], whatsapp: [], email: [], facebook: [], linkedin: [], youtube: [], endereco: [] } }) },
    expirada: entrada('Clínica Expirada', 'clinica-expirada'),
  });
  editarFila(env, (fila) => {
    fila.items[env.ids.expirada].estado = QUEUE_STATE.EXPIRADO;
  });
  const esperados = { dnc: QUEUE_STATE.DNC, duplicada: QUEUE_STATE.DUPLICADO, insuficiente: QUEUE_STATE.DADOS_INSUFICIENTES, expirada: QUEUE_STATE.EXPIRADO };
  await semEfeitos(env, async () => {
    for (const [chave, estado] of Object.entries(esperados)) {
      assert.equal(env.itemDaFila(chave).estado, estado, `pré-condição: ${chave} está em ${estado}`);
      await recusa(async () => await promover(env, chave), PROMOTION_ERROR.NOT_APPROVED, new RegExp(`estado atual: ${estado}`));
    }
  });
});

test('[INT-11] um prospect INEXISTENTE ou um id perigoso (constructor, __proto__, toString, prototype, vazio, não-texto) nunca é promovido: recusa clara, nada gravado', async (t) => {
  const env = ambienteAprovado(t);
  await semEfeitos(env, async () => {
    for (const id of ['id:nao-existe.example.test', 'constructor', '__proto__', 'toString', 'prototype', 'hasOwnProperty', 'valueOf', 'id:__proto__']) {
      await recusa(async () => await env.integracao.promoteProspect(admin(), id), PROMOTION_ERROR.PROSPECT_NOT_FOUND, /prospect não encontrado na fila de aprovação/);
    }
    for (const id of ['', '   ', undefined, null, 7, {}, [], true, () => 'x', { prospectId: env.ids.a, estado: 'APROVADO_PARA_CRM' }]) {
      await recusa(async () => await env.integracao.promoteProspect(admin(), id), PROMOTION_ERROR.INVALID_INPUT, /prospectId deve ser um texto não vazio/);
    }
  });
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'promocao'), false);
});

test('[INT-12] APROVAÇÃO INEXISTENTE: um item que só DIZ "APROVADO_PARA_CRM" (arquivo editado, sem a aprovação humana no histórico) não é uma aprovação — e uma "aprovação" feita por SYSTEM, sem identidade, com identidade inválida ou que não é a transição real também não', async (t) => {
  const identidade = { userId: 'u', name: 'Revisor', role: 'ADMIN' };
  const aprovacaoReal = (fila, id) => fila.items[id].historico.find((e) => e.to === QUEUE_STATE.APROVADO_PARA_CRM);
  const casos = [
    ['estado editado à mão, nunca aprovado', false, (fila, id) => { fila.items[id].estado = QUEUE_STATE.APROVADO_PARA_CRM; }],
    ['aprovação feita por SYSTEM', true, (fila, id) => { aprovacaoReal(fila, id).actor = 'SYSTEM'; }],
    ['aprovação sem reviewedBy', true, (fila, id) => { delete aprovacaoReal(fila, id).reviewedBy; }],
    ['reviewedBy com role SYSTEM', true, (fila, id) => { aprovacaoReal(fila, id).reviewedBy = { ...identidade, role: 'SYSTEM' }; }],
    ['reviewedBy com campo a mais', true, (fila, id) => { aprovacaoReal(fila, id).reviewedBy = { ...identidade, permissions: ['X'] }; }],
    ['reviewedBy com nome vazio', true, (fila, id) => { aprovacaoReal(fila, id).reviewedBy = { ...identidade, name: ' ' }; }],
    ['a transição não parte de AGUARDANDO_REVISAO (parece um "redescoberto")', true, (fila, id) => { aprovacaoReal(fila, id).from = QUEUE_STATE.APROVADO_PARA_CRM; }],
    ['aprovação sem timestamp', true, (fila, id) => { delete aprovacaoReal(fila, id).timestamp; }],
    ['histórico que não é uma lista', true, (fila, id) => { fila.items[id].historico = 'aprovado'; }],
    ['histórico vazio', true, (fila, id) => { fila.items[id].historico = []; }],
  ];
  for (const [nome, aprovarAntes, adulterar] of casos) {
    const env = novoAmbiente(t, { a: entrada('Clínica Alfa', 'clinica-alfa') });
    if (aprovarAntes) aprovar(env, 'a');
    editarFila(env, (fila) => adulterar(fila, env.ids.a));
    assert.equal(env.itemDaFila('a').estado, QUEUE_STATE.APROVADO_PARA_CRM, `pré-condição (${nome}): o item diz aprovado`);
    await semEfeitos(env, async () => await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.APPROVAL_MISSING, /a aprovação humana deste prospect não está registrada no histórico da fila/));
    assert.equal(env.registrosDoCrm().length, 0, nome);
  }
});

test('[INT-13] o estado "aprovado" não vem de fora: nenhuma opção é aceita (estado, approvalId, reviewedBy, actor, userId, role, permissions, crmRecordId, status, reason...), nem um objeto no lugar do id', async (t) => {
  const env = ambienteAprovado(t);
  await semEfeitos(env, async () => {
    for (const chave of ['estado', 'state', 'approvalId', 'aprovado', 'reviewedBy', 'actor', 'userId', 'role', 'permissions', 'authUserId', 'crmRecordId', 'status', 'reason', 'motivo', 'promocao', 'force', 'promovidoPor']) {
      await recusa(async () => await env.integracao.promoteProspect(admin(), env.ids.b, { [chave]: 'APROVADO_PARA_CRM' }), PROMOTION_ERROR.INVALID_INPUT, /opções não reconhecidas/);
    }
    await recusa(async () => await env.integracao.promoteProspect(admin(), env.ids.b, { estado: 'APROVADO_PARA_CRM', reviewedBy: { userId: 'x', name: 'X', role: 'ADMIN' } }), PROMOTION_ERROR.INVALID_INPUT);
    for (const opcoes of ['texto', 42, true, [], ['estado'], () => ({})]) {
      await recusa(async () => await env.integracao.promoteProspect(admin(), env.ids.b, opcoes), PROMOTION_ERROR.INVALID_INPUT, /opções devem ser um objeto vazio/);
    }
    await recusa(async () => await env.integracao.promoteProspect(admin(), { prospectId: env.ids.b, estado: 'APROVADO_PARA_CRM' }), PROMOTION_ERROR.INVALID_INPUT);
    await recusa(async () => await env.integracao.promoteProspect(admin(), env.ids.b, Object.create({ estado: 'APROVADO_PARA_CRM' }), 'extra'), PROMOTION_ERROR.INVALID_INPUT);
  });
  // opções vazias ou ausentes são aceitas, e o prospect aprovado continua promovível
  assert.equal((await env.integracao.promoteProspect(admin(), env.ids.a, {})).outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal((await env.integracao.promoteProspect(admin(), env.ids.a, null)).outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
  assert.equal((await env.integracao.promoteProspect(admin(), env.ids.a, undefined)).outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
});

test('[INT-14] tentativa de BYPASS da fila: o CRM Service e a fila são chamados só depois do estado real; forjar o arquivo (estado aprovado sem aprovação) ou pedir a auditoria da promoção num item pendente não cria registro', async (t) => {
  const env = ambienteAprovado(t);
  // 1) registrar uma promoção num prospect pendente pelo Service de auditoria é recusado pelo domínio
  await semEfeitos(env, async () => {
    assert.throws(() => env.promocao.recordPromotion(admin(), env.ids.b, { resultado: 'CRIADO', crmRecordId: 'crm:11111111-1111-4111-8111-111111111111' }), /só se registra em um prospect APROVADO_PARA_CRM/);
  });
  // 2) forjar `promocao` num item pendente e chamar a integração continua sendo recusado pelo estado
  editarFila(env, (fila) => {
    fila.items[env.ids.b].promocao = { crmRecordId: 'crm:11111111-1111-4111-8111-111111111111', resultado: 'CRIADO', promovidoEm: 'x', promovidoPor: OPERADOR_ADMIN };
  });
  await semEfeitos(env, async () => await recusa(async () => await promover(env, 'b'), PROMOTION_ERROR.NOT_APPROVED));
  // 3) o único caminho até o CRM é a integração: o item pendente nunca chegou lá
  assert.equal(env.registrosDoCrm().length, 0);
});

// ===========================================================================
// 3) Autorização e identidade
// ===========================================================================
test('[INT-15] AUTORIZAÇÃO sem permissão nova: o ADMIN promove; o COMMERCIAL_CLOSER (APPROVE:LEAD_APPROVAL, sem WRITE:CRM) NÃO — recusado antes de qualquer leitura ou gravação, mesmo no caminho "já promovido"', async (t) => {
  const env = ambienteAprovado(t);
  await semEfeitos(env, async () => {
    await assert.rejects(async () => await promover(env, 'a', closer()), /permissão|WRITE:CRM|autorização/i);
  });
  const feito = await promover(env, 'a', admin());
  assert.equal(feito.outcome, PROMOTION_OUTCOME.CRIADO);
  await semEfeitos(env, async () => {
    await assert.rejects(async () => await promover(env, 'a', closer()), /permissão|WRITE:CRM|autorização/i, 'nem o "já promovido" (leitura) é dado a quem não tem WRITE:CRM');
  });
  assert.equal(env.registrosDoCrm().length, 1);
});

test('[INT-16] contexto que NÃO é um AuthorizationContext emitido, e usuário INATIVO, são recusados antes de tudo: literais, cópias, clones, proxies, não-objetos — fila e CRM intocados', async (t) => {
  const env = ambienteAprovado(t);
  const legitimo = admin();
  const naoEmitidos = [
    'Breno',
    42,
    null,
    undefined,
    [],
    {},
    () => legitimo,
    { ...legitimo },
    structuredClone(legitimo),
    JSON.parse(JSON.stringify(legitimo)),
    Object.create(legitimo),
    new Proxy(legitimo, {}),
    { userId: legitimo.userId, name: legitimo.name, role: 'ADMIN', permissions: ['WRITE:CRM', 'APPROVE:LEAD_APPROVAL'] },
    Object.freeze({ ...legitimo, permissions: Object.freeze([...legitimo.permissions]) }),
  ];
  await semEfeitos(env, async () => {
    for (const contexto of naoEmitidos) await assert.rejects(async () => await env.integracao.promoteProspect(contexto, env.ids.a), Error, String(contexto));
    await assert.rejects(async () => await env.integracao.promoteProspect(inativo(), env.ids.a), /usuário inativo/);
  });
});

test('[INT-17] identidade FALSIFICADA: nada de userId/role/permissions/actor/reviewedBy passa por opções; e a identidade gravada é SEMPRE a do contexto (o ADMIN que promoveu), nunca a de outra pessoa', async (t) => {
  const env = ambienteAprovado(t);
  await semEfeitos(env, async () => {
    await recusa(
      async () => await env.integracao.promoteProspect(admin(), env.ids.a, { userId: 'user-forjado', role: 'ADMIN', permissions: ['WRITE:CRM'], actor: 'SYSTEM', reviewedBy: { userId: 'forjado', name: 'Forjado', role: 'ADMIN' } }),
      PROMOTION_ERROR.INVALID_INPUT
    );
  });
  const resultado = await promover(env, 'a', admin());
  assert.deepEqual(env.lerCrm()[resultado.crmRecordId].historico[0].reviewedBy, OPERADOR_ADMIN);
  assert.deepEqual(env.itemDaFila('a').promocao.promovidoPor, OPERADOR_ADMIN);
  assert.ok(!env.textoDaFila().includes('forjado') && !env.textoDoCrm().includes('forjado'));
});

test('[INT-18] outro ADMIN promovendo depois vê o que já foi feito e NÃO reescreve a autoria: promovidoPor continua sendo quem promoveu primeiro', async (t) => {
  const env = ambienteAprovado(t);
  const primeiro = await promover(env, 'a', admin());
  const outroAdmin = admin({ userId: 'user-admin-2', authUserId: 'auth-admin-2', name: 'Segundo Admin', email: 'admin-2@example.test' });
  const segundo = await promover(env, 'a', outroAdmin);
  assert.equal(segundo.outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
  assert.equal(segundo.crmRecordId, primeiro.crmRecordId);
  assert.deepEqual(segundo.promocao.promovidoPor, OPERADOR_ADMIN);
  assert.equal(env.registrosDoCrm().length, 1);
});

// ===========================================================================
// 4) Idempotência
// ===========================================================================
test('[INT-19] IDEMPOTÊNCIA: promover o mesmo prospect aprovado várias vezes não duplica — JA_PROMOVIDO com o mesmo registro, e as chamadas repetidas NÃO gravam nada (nem na fila nem no CRM)', async (t) => {
  const env = ambienteAprovado(t);
  const primeira = await promover(env, 'a');
  assert.equal(primeira.outcome, PROMOTION_OUTCOME.CRIADO);
  const filaDepois = env.textoDaFila();
  const crmDepois = env.textoDoCrm();
  for (let i = 0; i < 5; i += 1) {
    const repetida = await promover(env, 'a');
    assert.equal(repetida.outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
    assert.equal(repetida.crmRecordId, primeira.crmRecordId);
    assert.deepEqual(repetida.record, primeira.record, 'o registro devolvido é o mesmo');
    assert.equal(repetida.possivelDuplicidade, null);
  }
  assert.equal(env.textoDaFila(), filaDepois, 'a fila não foi regravada');
  assert.equal(env.textoDoCrm(), crmDepois, 'o CRM não foi regravado');
  assert.equal(env.registrosDoCrm().length, 1);
  assert.equal(env.itemDaFila('a').historico.filter((e) => e.motivo === 'Promovido para o CRM').length, 1, 'uma só entrada de promoção');
});

test('[INT-20] a idempotência sobrevive a REINÍCIO: serviços NOVOS sobre os mesmos arquivos (como um processo novo) reconhecem a promoção já feita', async (t) => {
  const env = ambienteAprovado(t);
  const primeira = await promover(env, 'a');
  const reiniciado = criarServicos(env.queuePath, env.crmPath);
  assert.notEqual(reiniciado.integracao, env.integracao);
  const repetida = await reiniciado.integracao.promoteProspect(admin(), env.ids.a);
  assert.equal(repetida.outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
  assert.equal(repetida.crmRecordId, primeira.crmRecordId);
  assert.equal(env.registrosDoCrm().length, 1);
});

test('[INT-21] dois prospects diferentes, cada um com o seu registro: promover um não afeta nem reconhece o outro (o marcador é por prospect)', async (t) => {
  const env = ambienteAprovado(t);
  aprovar(env, 'b');
  const a = await promover(env, 'a');
  const b = await promover(env, 'b');
  assert.notEqual(a.crmRecordId, b.crmRecordId);
  assert.equal(b.outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(env.registrosDoCrm().length, 2);
  assert.equal((await promover(env, 'a')).crmRecordId, a.crmRecordId);
  assert.equal((await promover(env, 'b')).crmRecordId, b.crmRecordId);
});

test('[INT-22] o marcador não se confunde entre ids parecidos: "id:x" e "id:x; aprovado por y" (com ; ) e aspas) reconciliam cada um o SEU registro', async (t) => {
  const env = novoAmbiente(t, {});
  // Prospects montados direto na fila (ids de fallback: "id:<empresa em minúsculas>")
  const fila = queueDomain.createEmptyQueue();
  const revisao = queueDomain.createApprovalReviewActions({ authorizeReviewer: () => ({ userId: 'u-rev', name: 'Revisor', role: 'ADMIN' }) });
  const nomes = { x: 'marca x', y: 'marca x; aprovado por "y") fim' };
  const ids = {};
  for (const [chave, empresa] of Object.entries(nomes)) {
    const snapshot = { ...descoberta(achado(empresa, 'irrelevante')), site: null, instagram: null, telefone: null, whatsapp: null, cidade: null };
    const item = queueDomain.addProspect(fila, { ...snapshot, empresa });
    ids[chave] = item.prospectId;
    revisao.approveProspect(fila, item.prospectId, {}, 'ok');
  }
  queueDomain.saveQueueToDisk(fila, env.queuePath);
  assert.notEqual(ids.x, ids.y);
  assert.ok(ids.y.startsWith(ids.x), 'pré-condição: um id é prefixo do outro');

  const x = await env.integracao.promoteProspect(admin(), ids.x);
  const y = await env.integracao.promoteProspect(admin(), ids.y);
  assert.notEqual(x.crmRecordId, y.crmRecordId);
  // apaga o resumo do Y na fila (falha no meio) e promove de novo: reconcilia o registro do Y, não o do X
  editarFila(env, (f) => {
    delete f.items[ids.y].promocao;
  });
  const reconciliado = await env.integracao.promoteProspect(admin(), ids.y);
  assert.equal(reconciliado.outcome, PROMOTION_OUTCOME.RECONCILIADO);
  assert.equal(reconciliado.crmRecordId, y.crmRecordId);
  assert.equal(env.registrosDoCrm().length, 2);
});

// ===========================================================================
// 5) Identidade, duplicidade e DNC — do DOMÍNIO do CRM
// ===========================================================================
test('[INT-23] DUPLICIDADE: um registro do CRM com o mesmo site (identidade forte) BLOQUEIA — não cria, não promove, registra o bloqueio na fila com o id do registro existente', async (t) => {
  const env = ambienteAprovado(t);
  const existente = (await env.crm.createRecord(admin(), { empresa: 'Já no CRM', site: 'https://www.clinica-alfa.example.test/' })).record;
  const crmAntes = env.textoDoCrm();
  await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.BLOCKED_DUPLICATE, /já existe no CRM um registro com a mesma identidade/);
  assert.equal(env.textoDoCrm(), crmAntes, 'nada foi criado no CRM');
  assert.equal(env.registrosDoCrm().length, 1);

  const item = env.itemDaFila('a');
  assert.equal(item.promocao, undefined, 'não foi promovido');
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM, 'e o estado da aprovação não mudou');
  const auditoria = item.historico[item.historico.length - 1];
  assert.match(auditoria.motivo, /^Promoção bloqueada: já existe no CRM um registro com a mesma identidade/);
  assert.deepEqual(auditoria.promocao, { resultado: 'BLOQUEADO', codigo: 'DUPLICADO', crmRecordId: existente.id });
  assert.deepEqual(auditoria.reviewedBy, OPERADOR_ADMIN);
});

test('[INT-24] a duplicidade vale para telefone, WhatsApp e Instagram — inclusive o mesmo número guardado no campo "errado" (telefone x WhatsApp) — porque é o DOMÍNIO do CRM que decide, não uma regra paralela', async (t) => {
  const casos = [
    ['telefone igual', { telefone: '24 98765-1000' }],
    ['telefone do prospect no WhatsApp do CRM', { whatsapp: '(24) 98765-1000' }],
    ['WhatsApp do prospect no telefone do CRM', { telefone: '+55 24 98765-2000' }],
    ['Instagram igual', { instagram: 'https://www.instagram.com/clinica_alfa/' }],
    ['WhatsApp igual', { whatsapp: '24987652000' }],
  ];
  for (const [nome, existente] of casos) {
    const env = ambienteAprovado(t);
    await env.crm.createRecord(admin(), { empresa: `Existente ${nome}`, ...existente });
    const antes = env.textoDoCrm();
    await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.BLOCKED_DUPLICATE);
    assert.equal(env.textoDoCrm(), antes, nome);
    assert.equal(env.itemDaFila('a').promocao, undefined, nome);
  }
});

test('[INT-25] DNC no CRM: uma identidade já bloqueada como DO_NOT_CONTACT (site, telefone, WhatsApp ou Instagram) NÃO entra — falha fechada, com auditoria e sem tocar no registro bloqueado', async (t) => {
  const casos = [
    ['site', { site: 'clinica-alfa.example.test' }],
    ['telefone', { telefone: '(24) 98765-1000' }],
    ['WhatsApp no campo telefone', { telefone: '24 98765-2000' }],
    ['Instagram', { instagram: '@clinica_alfa' }],
  ];
  for (const [nome, identidade] of casos) {
    const env = ambienteAprovado(t);
    const bloqueado = (await env.crm.createRecord(admin(), { empresa: `Bloqueado por ${nome}`, ...identidade })).record;
    await env.crm.markDoNotContact(admin(), bloqueado.id, { reason: 'pediu para não ser contatado' });
    const crmAntes = env.textoDoCrm();

    await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.BLOCKED_DNC, /já está bloqueada como DO_NOT_CONTACT no CRM/);
    assert.equal(env.textoDoCrm(), crmAntes, `${nome}: nada foi criado nem alterado`);
    assert.equal(env.lerCrm()[bloqueado.id].status, CRM_STATUS.DO_NOT_CONTACT);
    const item = env.itemDaFila('a');
    assert.equal(item.promocao, undefined);
    const auditoria = item.historico[item.historico.length - 1];
    assert.deepEqual(auditoria.promocao, { resultado: 'BLOQUEADO', codigo: 'DNC', crmRecordId: bloqueado.id }, nome);
  }
});

test('[INT-26] DNC visto pela PESQUISA depois da aprovação: se a redescoberta marcou o snapshot statusDNC BLOQUEADO, o prospect aprovado NÃO é promovido (falha fechada), com auditoria', async (t) => {
  const env = ambienteAprovado(t);
  // a redescoberta REAL (addProspect) atualiza o snapshot de um item terminal e registra "redescoberto"
  const fila = env.lerFila();
  const redescoberto = descoberta(achado('Clínica Alfa', 'clinica-alfa'), [{ empresa: 'Alfa', site: 'https://clinica-alfa.example.test', doNotContact: true }]);
  queueDomain.addProspect(fila, redescoberto);
  queueDomain.saveQueueToDisk(fila, env.queuePath);
  assert.equal(env.itemDaFila('a').estado, QUEUE_STATE.APROVADO_PARA_CRM, 'pré-condição: o estado terminal não mudou');
  assert.equal(env.itemDaFila('a').discoverySnapshot.statusDNC, 'BLOQUEADO', 'pré-condição: o snapshot agora diz BLOQUEADO');

  await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.BLOCKED_DNC, /marcado como DO NOT CONTACT pela verificação de pesquisa/);
  assert.equal(env.registrosDoCrm().length, 0);
  assert.equal(env.itemDaFila('a').promocao, undefined);
  assert.equal(env.itemDaFila('a').historico[env.itemDaFila('a').historico.length - 1].promocao.codigo, 'DNC');
});

test('[INT-27] nome + cidade é SINALIZAÇÃO, nunca bloqueio: um registro do CRM com a mesma empresa e cidade (sem identidade forte igual) NÃO impede a promoção — o resultado traz possivelDuplicidade e a fila registra o id', async (t) => {
  const env = ambienteAprovado(t);
  const parecido = (await env.crm.createRecord(admin(), { empresa: 'Clínica Alfa', cidade: 'Petropolis', site: 'outro-site.example.test' })).record;
  const resultado = await promover(env, 'a');
  assert.equal(resultado.outcome, PROMOTION_OUTCOME.CRIADO, 'criou mesmo assim');
  assert.equal(env.registrosDoCrm().length, 2);
  assert.deepEqual(resultado.possivelDuplicidade, { status: 'POSSIVEL_DUPLICADO', matchedOn: ['nome_cidade'], matchedRecordId: parecido.id });
  const entrada = env.itemDaFila('a').historico.find((e) => e.motivo === 'Promovido para o CRM');
  assert.equal(entrada.promocao.possivelDuplicadoDe, parecido.id, 'a sinalização fica na auditoria da fila');
  // repetir a promoção não repete a sinalização nem grava nada
  assert.equal((await promover(env, 'a')).possivelDuplicidade, null);
});

test('[INT-28] o CRM já contém uma identidade EQUIVALENTE à de outro prospect: o prospect promovido antes NÃO é bloqueado pelo PRÓPRIO registro (JA_PROMOVIDO), e um SEGUNDO prospect (outro id, outro site) que só coincide no telefone é bloqueado como DUPLICADO, com o id do registro do primeiro na auditoria', async (t) => {
  const env = novoAmbiente(t, {
    a: entrada('Clínica Alfa', 'clinica-alfa'),
    d: entrada('Clínica Delta', 'clinica-delta'), // outro site, MESMO telefone e WhatsApp do padrão
  });
  assert.notEqual(env.ids.a, env.ids.d, 'pré-condição: prospects diferentes na fila');
  aprovar(env, 'a');
  aprovar(env, 'd');
  const primeira = await promover(env, 'a');
  assert.equal((await promover(env, 'a')).outcome, PROMOTION_OUTCOME.JA_PROMOVIDO, 'o próprio registro nunca bloqueia o prospect que o criou');

  await recusa(async () => await promover(env, 'd'), PROMOTION_ERROR.BLOCKED_DUPLICATE);
  assert.equal(env.registrosDoCrm().length, 1, 'o segundo não entrou');
  assert.equal(env.itemDaFila('d').promocao, undefined);
  const auditoria = env.itemDaFila('d').historico[env.itemDaFila('d').historico.length - 1];
  assert.deepEqual(auditoria.promocao, { resultado: 'BLOQUEADO', codigo: 'DUPLICADO', crmRecordId: primeira.crmRecordId });
});

// ===========================================================================
// 6) Dados insuficientes
// ===========================================================================
test('[INT-29] DADOS INSUFICIENTES para o CRM: um item aprovado sem o nome da empresa (obrigatório no CRM) é bloqueado, com auditoria — nada é fabricado', async (t) => {
  const env = ambienteAprovado(t);
  editarFila(env, (fila) => {
    delete fila.items[env.ids.a].empresa;
    fila.items[env.ids.a].discoverySnapshot.empresa = '   ';
  });
  await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.INSUFFICIENT_DATA, /não tem o nome da empresa/);
  assert.equal(env.registrosDoCrm().length, 0);
  const item = env.itemDaFila('a');
  assert.equal(item.promocao, undefined);
  assert.equal(item.historico[item.historico.length - 1].promocao.codigo, 'DADOS_INSUFICIENTES');
});

test('[INT-30] uma recusa do domínio do CRM por dados inválidos (campo com tipo errado, empresa vazia) vira DADOS_INSUFICIENTES, com auditoria; qualquer OUTRO erro passa intacto e sem auditoria', async (t) => {
  const env = ambienteAprovado(t);
  for (const mensagem of ['CRM: createRecord exige "empresa" (texto não vazio)', 'CRM: createRecord — campo "cidade" deve ser um texto ou null']) {
    const servico = outroServico(env, { crm: crmComFalhas(env.crm, { createRecord: new Error(mensagem) }) });
    await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), (erro) => erro.code === PROMOTION_ERROR.INSUFFICIENT_DATA && erro.auditoriaGravada === true);
  }
  assert.equal(env.itemDaFila('a').historico.filter((e) => /^Promoção bloqueada/.test(e.motivo)).length, 2);

  const antes = env.textoDaFila();
  for (const inesperado of [new Error('CRM: arquivo de dados corrompido (JSON inválido) em x'), new TypeError('boom'), new Error('CRM: transição não permitida: A -> B')]) {
    const servico = outroServico(env, { crm: crmComFalhas(env.crm, { createRecord: inesperado }) });
    await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), (erro) => erro === inesperado, 'o erro original, sem tradução');
  }
  assert.equal(env.textoDaFila(), antes, 'e nenhum erro inesperado deixa auditoria');
});

// ===========================================================================
// 7) Falhas de persistência e inconsistência
// ===========================================================================
test('[INT-31] ERRO DE PERSISTÊNCIA ao criar no CRM: o erro passa intacto, nada é gravado em lugar nenhum (nem promoção, nem auditoria) — e repetir depois funciona, sem duplicar', async (t) => {
  const env = ambienteAprovado(t);
  const falha = new Error('disco cheio (simulado) ao gravar o CRM');
  const servico = outroServico(env, { crm: crmComFalhas(env.crm, { createRecord: falha }) });
  await semEfeitos(env, async () => await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), (erro) => erro === falha));
  // o CRM voltou: a mesma aprovação é promovida normalmente
  assert.equal((await promover(env, 'a')).outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(env.registrosDoCrm().length, 1);

  // um CRM cujo arquivo está corrompido falha alto, sem criar nem auditar
  const outro = ambienteAprovado(t);
  fs.writeFileSync(outro.crmPath, '{ não é json', 'utf8');
  const filaAntes = outro.textoDaFila();
  await assert.rejects(async () => await outro.integracao.promoteProspect(admin(), outro.ids.a), /arquivo de dados corrompido/);
  assert.equal(outro.textoDaFila(), filaAntes);
});

test('[INT-32] FALHA PARCIAL (o CRM foi gravado, a fila não): erro PARTIAL claro; o CRM tem UM registro; a repetição RECONCILIA a fila sem criar outro; e a seguinte já é JA_PROMOVIDO', async (t) => {
  const env = ambienteAprovado(t);
  const servico = outroServico(env, { promocao: promocaoComFalhas(env.promocao, { recordPromotion: 1 }) });
  await recusa(async () => await servico.promoteProspect(admin(), env.ids.a), PROMOTION_ERROR.PARTIAL, /o registro foi criado no CRM, mas a fila de aprovação não pôde ser atualizada/);
  assert.equal(env.registrosDoCrm().length, 1, 'o registro existe no CRM');
  assert.equal(env.itemDaFila('a').promocao, undefined, 'a fila ainda não sabe');
  const existente = env.registrosDoCrm()[0].id;

  const reconciliado = await servico.promoteProspect(admin(), env.ids.a);
  assert.equal(reconciliado.outcome, PROMOTION_OUTCOME.RECONCILIADO);
  assert.equal(reconciliado.crmRecordId, existente);
  assert.equal(env.registrosDoCrm().length, 1, 'nenhum registro novo');
  assert.equal(env.itemDaFila('a').promocao.resultado, 'RECONCILIADO');
  assert.equal(env.itemDaFila('a').promocao.crmRecordId, existente);

  assert.equal((await servico.promoteProspect(admin(), env.ids.a)).outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
  assert.equal(env.registrosDoCrm().length, 1);
});

test('[INT-33] a falha parcial preserva a causa (error.cause) e a própria RECONCILIAÇÃO pode falhar de novo sem criar nada — até a fila voltar', async (t) => {
  const env = ambienteAprovado(t);
  const servico = outroServico(env, { promocao: promocaoComFalhas(env.promocao, { recordPromotion: 3 }) });
  await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), (erro) => erro.code === PROMOTION_ERROR.PARTIAL && /falha de gravação da fila \(simulada\)/.test(erro.cause.message));
  await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), (erro) => erro.code === PROMOTION_ERROR.PARTIAL && /já existe no CRM/.test(erro.message));
  await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), (erro) => erro.code === PROMOTION_ERROR.PARTIAL);
  assert.equal(env.registrosDoCrm().length, 1, 'três falhas seguidas, um só registro');
  assert.equal((await servico.promoteProspect(admin(), env.ids.a)).outcome, PROMOTION_OUTCOME.RECONCILIADO);
  assert.equal(env.registrosDoCrm().length, 1);
});

test('[INT-34] INCONSISTÊNCIA fila x CRM: a fila diz "promovido" mas o registro não existe, não é o desta promoção, o resumo está inválido, ou há mais de um registro do mesmo prospect — erro claro e NADA é alterado', async (t) => {
  const casos = [
    ['registro apontado não existe no CRM', (env, id) => editarFila(env, (f) => { f.items[id].promocao = { crmRecordId: 'crm:99999999-9999-4999-8999-999999999999', resultado: 'CRIADO', promovidoEm: 'x', promovidoPor: OPERADOR_ADMIN }; }), /o registro do CRM não existe/],
    ['resumo sem crmRecordId', (env, id) => editarFila(env, (f) => { f.items[id].promocao = { resultado: 'CRIADO' }; }), /o resumo da promoção na fila está inválido/],
    ['resumo que não é um objeto', (env, id) => editarFila(env, (f) => { f.items[id].promocao = 'promovido'; }), /o resumo da promoção na fila está inválido/],
    ['registro apontado é OUTRO (criado à mão, sem o marcador)', async (env, id) => {
      const manual = (await env.crm.createRecord(admin(), { empresa: 'Criado à mão', site: 'manual.example.test' })).record;
      editarFila(env, (f) => { f.items[id].promocao = { crmRecordId: manual.id, resultado: 'CRIADO', promovidoEm: 'x', promovidoPor: OPERADOR_ADMIN }; });
    }, /não foi criado por esta promoção/],
  ];
  for (const [nome, preparar, mensagem] of casos) {
    const env = ambienteAprovado(t);
    await preparar(env, env.ids.a);
    await semEfeitos(env, async () => await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.INCONSISTENT, mensagem));
    assert.equal(env.registrosDoCrm().filter((r) => /Promovido da Approval Queue/.test(JSON.stringify(r.historico))).length, 0, nome);
  }

  // o registro do CRM cujo primeiro evento NÃO é uma criação (arquivo adulterado) não é o desta promoção
  {
    const adulterado = ambienteAprovado(t);
    const feito = await promover(adulterado, 'a');
    const registrosAdulterados = adulterado.lerCrm();
    registrosAdulterados[feito.crmRecordId].historico[0].from = 'PROSPECT';
    fs.writeFileSync(adulterado.crmPath, JSON.stringify(registrosAdulterados, null, 2), 'utf8');
    await semEfeitos(adulterado, async () => await recusa(async () => await promover(adulterado, 'a'), PROMOTION_ERROR.INCONSISTENT, /não foi criado por esta promoção/));
  }

  // dois registros do CRM com o marcador do mesmo prospect
  const env = ambienteAprovado(t);
  const primeiro = await promover(env, 'a');
  const registros = env.lerCrm();
  const copia = structuredClone(registros[primeiro.crmRecordId]);
  copia.id = 'crm:88888888-8888-4888-8888-888888888888';
  registros[copia.id] = copia;
  fs.writeFileSync(env.crmPath, JSON.stringify(registros, null, 2), 'utf8');
  editarFila(env, (f) => { delete f.items[env.ids.a].promocao; });
  await semEfeitos(env, async () => await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.INCONSISTENT, /mais de um registro do CRM aponta para este prospect/));
});

test('[INT-35] se a própria AUDITORIA de um bloqueio falhar, a recusa continua valendo (nunca vira sucesso) e o erro acusa auditoriaGravada: false', async (t) => {
  const env = ambienteAprovado(t);
  await env.crm.createRecord(admin(), { empresa: 'Já no CRM', site: 'clinica-alfa.example.test' });
  const servico = outroServico(env, { promocao: promocaoComFalhas(env.promocao, { recordPromotionBlocked: 1 }) });
  await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), (erro) => erro.code === PROMOTION_ERROR.BLOCKED_DUPLICATE && erro.auditoriaGravada === false);
  assert.equal(env.registrosDoCrm().length, 1, 'nada foi criado');
  assert.equal(env.itemDaFila('a').promocao, undefined);
  await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), (erro) => erro.code === PROMOTION_ERROR.BLOCKED_DUPLICATE && erro.auditoriaGravada === true, 'na tentativa seguinte a auditoria é gravada');
});

test('[INT-36] um bloqueio pode deixar de existir: depois que o registro que bloqueava sai do caminho (aqui, outra identidade), a MESMA aprovação é promovida — o bloqueio foi só auditoria', async (t) => {
  const env = ambienteAprovado(t);
  const existente = (await env.crm.createRecord(admin(), { empresa: 'Já no CRM', site: 'clinica-alfa.example.test' })).record;
  await assert.rejects(async () => await promover(env, 'a'), (erro) => erro.code === PROMOTION_ERROR.BLOCKED_DUPLICATE);
  // o registro do CRM muda de site (edição legítima); a identidade não coincide mais
  await env.crm.updateRecord(admin(), existente.id, { site: 'novo-endereco.example.test' });
  const resultado = await promover(env, 'a');
  assert.equal(resultado.outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(env.registrosDoCrm().length, 2);
  const bloqueios = env.itemDaFila('a').historico.filter((e) => /^Promoção bloqueada/.test(e.motivo));
  assert.equal(bloqueios.length, 1, 'o histórico guarda o bloqueio e a promoção');
});

// ===========================================================================
// 8) Robustez: propriedades herdadas, poluição de protótipo
// ===========================================================================
test('[INT-37] propriedades HERDADAS: um Object.prototype poluído com promocao, statusDNC, historico, estado, reviewedBy, actor ou motivo NÃO faz um prospect parecer promovido, bloqueado ou aprovado — e não forja a auditoria', async (t) => {
  const env = ambienteAprovado(t);
  const outroProspect = env.ids.b;
  Object.prototype.promocao = { crmRecordId: 'crm:99999999-9999-4999-8999-999999999999', resultado: 'CRIADO' };
  Object.prototype.statusDNC = 'BLOQUEADO';
  Object.prototype.reviewedBy = { userId: 'forjado', name: 'Forjado', role: 'ADMIN' };
  Object.prototype.actor = 'SYSTEM';
  Object.prototype.motivo = 'motivo herdado';
  Object.prototype.estado = QUEUE_STATE.APROVADO_PARA_CRM;
  Object.prototype.historico = [{ from: 'AGUARDANDO_REVISAO', to: 'APROVADO_PARA_CRM', actor: 'HUMAN', timestamp: 'x', reviewedBy: { userId: 'forjado', name: 'Forjado', role: 'ADMIN' } }];
  try {
    // o item pendente continua pendente (o estado é o PRÓPRIO dele) — nada herdado o aprova
    await recusa(async () => await env.integracao.promoteProspect(admin(), outroProspect), PROMOTION_ERROR.NOT_APPROVED);
    // o aprovado é promovido normalmente, com a auditoria dos autorizadores — nada do protótipo entra
    const resultado = await env.integracao.promoteProspect(admin(), env.ids.a);
    assert.equal(resultado.outcome, PROMOTION_OUTCOME.CRIADO);
    const criacao = env.lerCrm()[resultado.crmRecordId].historico[0];
    assert.deepEqual(criacao.reviewedBy, OPERADOR_ADMIN);
    assert.equal(criacao.actor, 'HUMAN');
    assert.ok(!criacao.motivo.includes('herdado'));
    assert.deepEqual(env.itemDaFila('a').promocao.promovidoPor, OPERADOR_ADMIN);
  } finally {
    for (const chave of ['promocao', 'statusDNC', 'reviewedBy', 'actor', 'motivo', 'estado', 'historico']) delete Object.prototype[chave];
  }
});

test('[INT-38] entradas com protótipo herdado: um snapshot que só tem statusDNC e empresa no PROTÓTIPO não bloqueia nem nomeia o registro — só as propriedades PRÓPRIAS contam', async (t) => {
  const env = ambienteAprovado(t);
  const base = env.fila.getProspect(admin(), env.ids.a);
  const filaHerdada = {
    getProspect: () => {
      const item = structuredClone(base);
      item.discoverySnapshot = Object.create({ statusDNC: 'BLOQUEADO', empresa: 'Do Protótipo' });
      Object.defineProperty(item.discoverySnapshot, 'nicho', { value: 'Nicho Próprio', enumerable: true });
      return item;
    },
  };
  const servico = outroServico(env, { fila: filaHerdada });
  // não está bloqueado (o statusDNC herdado não conta); a empresa é a do ITEM, e só o nicho PRÓPRIO do snapshot entra
  const resultado = await servico.promoteProspect(admin(), env.ids.a);
  assert.equal(resultado.outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(resultado.record.empresa, 'Clínica Alfa');
  assert.equal(resultado.record.nicho, 'Nicho Próprio');
  assert.equal(resultado.record.cidade, null);
});

test('[INT-39] prototype pollution durante o fluxo completo (aprovar, promover, repetir, bloquear) não deixa rastro: o protótipo continua limpo e os registros gravados não têm chaves estranhas', async (t) => {
  const env = ambienteAprovado(t);
  const antes = Object.getOwnPropertyNames(Object.prototype).sort();
  await promover(env, 'a');
  await promover(env, 'a');
  await env.crm.createRecord(admin(), { empresa: 'Outro', site: 'outro.example.test' });
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), antes);
  const registro = Object.values(env.lerCrm())[0];
  assert.deepEqual(Object.keys(registro).sort(), ['id', ...CRM_WRITABLE_FIELDS, 'status', 'dataDeEntrada', 'historico'].sort());
  for (const perigosa of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(Object.prototype.hasOwnProperty.call(env.lerCrm(), perigosa), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env.lerFila().items, perigosa), false);
  }
});

// ===========================================================================
// 9) Concorrência (o que se garante e o que NÃO se garante)
// ===========================================================================
test('[INT-40] duas promoções "simultâneas" no MESMO processo se enfileiram (cada uma roda inteira antes da seguinte: fila de promessas por serviço): exatamente uma CRIA, a outra vê JA_PROMOVIDO — um só registro', async (t) => {
  const env = ambienteAprovado(t);
  const resultados = await Promise.all([
    Promise.resolve().then(async () => await promover(env, 'a')),
    Promise.resolve().then(async () => await promover(env, 'a', admin({ userId: 'user-admin-2', authUserId: 'auth-admin-2', name: 'Segundo Admin', email: 'admin-2@example.test' }))),
    Promise.resolve().then(async () => await promover(env, 'a')),
  ]);
  assert.deepEqual(resultados.map((r) => r.outcome).sort(), [PROMOTION_OUTCOME.CRIADO, PROMOTION_OUTCOME.JA_PROMOVIDO, PROMOTION_OUTCOME.JA_PROMOVIDO].sort());
  assert.equal(new Set(resultados.map((r) => r.crmRecordId)).size, 1);
  assert.equal(env.registrosDoCrm().length, 1);
});

test('[INT-41] corrida ENTRE PROCESSOS (simulada: outra instância termina a promoção entre a leitura do CRM e a criação): com identidade FORTE o DOMÍNIO do CRM barra a segunda criação — um só registro, e o bloqueio fica auditado', async (t) => {
  const env = ambienteAprovado(t);
  const outroProcesso = env.integracao; // outra "instância" sobre os mesmos arquivos
  let disparou = false;
  const corrida = outroServico(env, {
    crm: crmComFalhas(env.crm, {
      aoListar: async () => {
        if (disparou) return;
        disparou = true;
        await outroProcesso.promoteProspect(admin(), env.ids.a); // o outro processo conclui TUDO agora
      },
    }),
  });
  await assert.rejects(async () => await corrida.promoteProspect(admin(), env.ids.a), (erro) => erro.code === PROMOTION_ERROR.BLOCKED_DUPLICATE);
  assert.equal(env.registrosDoCrm().length, 1, 'um só registro no CRM');
  assert.equal(env.itemDaFila('a').promocao.resultado, 'CRIADO', 'a promoção do outro processo é a que vale');
  assert.ok(env.itemDaFila('a').historico.some((e) => /^Promoção bloqueada/.test(e.motivo)), 'e a tentativa perdedora ficou auditada');
  assert.equal((await promover(env, 'a')).outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
});

test('[INT-42] LIMITAÇÃO DOCUMENTADA (decisão 0016): entre PROCESSOS, um prospect SEM nenhum identificador forte (só nome e cidade) pode gerar dois registros — o arquivo não tem trava nem transação e o domínio não barra nome+cidade. Este teste registra o limite; se um dia ele for resolvido, o teste deve mudar de propósito', async (t) => {
  const env = novoAmbiente(t, {});
  // um prospect só com nome + cidade, montado direto na fila (o pipeline de descoberta o classificaria DADOS_INSUFICIENTES)
  const fila = queueDomain.createEmptyQueue();
  const base = { ...descoberta(achado('Consultório Só Nome', 'so-nome')), site: null, instagram: null, telefone: null, whatsapp: null, email: null };
  const item = queueDomain.addProspect(fila, base);
  queueDomain.createApprovalReviewActions({ authorizeReviewer: () => ({ userId: 'u-rev', name: 'Revisor', role: 'ADMIN' }) }).approveProspect(fila, item.prospectId, {}, 'ok');
  queueDomain.saveQueueToDisk(fila, env.queuePath);
  const id = item.prospectId;
  assert.match(id, /^id:consultorio so nome\|petropolis$/, 'pré-condição: a identidade é só nome+cidade');

  // sem corrida: um único registro, e a repetição não duplica
  const sozinho = novoAmbiente(t, {});
  queueDomain.saveQueueToDisk(fila, sozinho.queuePath);
  await sozinho.integracao.promoteProspect(admin(), id);
  await sozinho.integracao.promoteProspect(admin(), id);
  assert.equal(sozinho.registrosDoCrm().length, 1);

  // com a corrida simulada entre processos: dois
  const outroProcesso = env.integracao;
  let disparou = false;
  const corrida = outroServico(env, {
    crm: crmComFalhas(env.crm, {
      aoListar: async () => {
        if (disparou) return;
        disparou = true;
        await outroProcesso.promoteProspect(admin(), id);
      },
    }),
  });
  // a fila (a fonte de verdade da promoção) recusa ligar um SEGUNDO registro: o erro é claro, acusa o registro duplicado e a
  // tentativa perdedora fica auditada — mas o registro duplicado JÁ está no CRM (o CRM não tem exclusão)
  let erro = null;
  try {
    await corrida.promoteProspect(admin(), id);
  } catch (e) {
    erro = e;
  }
  assert.ok(erro, 'a tentativa perdedora falha, alto');
  assert.equal(erro.code, PROMOTION_ERROR.INCONSISTENT);
  assert.match(erro.message, /já foi promovido para outro registro do CRM \(corrida entre processos\)/);
  assert.match(erro.crmRecordId, /^crm:/, 'o erro acusa o registro que ficou duplicado');
  assert.equal(env.registrosDoCrm().length, 2, 'limite conhecido: sem trava entre processos, duas criações concorrentes para um prospect sem identificador forte passam');
  assert.ok(env.registrosDoCrm().some((r) => r.id === erro.crmRecordId));
  assert.ok(env.lerFila().items[id].historico.some((e) => /^Promoção bloqueada/.test(e.motivo) && e.promocao.crmRecordId === erro.crmRecordId), 'a tentativa perdedora ficou na auditoria da fila');
});

// ===========================================================================
// 10) Fronteiras: o que a camada é e não é
// ===========================================================================
test('[INT-43] a camada não fala com a rede: com o fetch global derrubado, a promoção completa (criar e repetir) funciona — nenhuma chamada externa', async (t) => {
  const rede = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('nenhuma chamada de rede é esperada');
  });
  const env = ambienteAprovado(t);
  await promover(env, 'a');
  await promover(env, 'a');
  assert.equal(rede.mock.callCount(), 0);
});

test('[INT-44] fronteira arquitetural: o serviço importa só a fila (domínio e descoberta), a autenticação e o mapeamento — NUNCA o domínio do CRM, o servidor, o disco ou a rede; e a rota HTTP só usa o serviço injetado (a composição fica na fábrica de arquivos)', () => {
  const analise = analyzeSource(fs.readFileSync(SOURCE, 'utf8'), 'src/services/crmIntegrationService.js');
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(
    analise.refs.map((ref) => ref.specifier).sort(),
    ['../auth', '../research-prospector/approvalQueue', '../research-prospector/discovery', './prospectToCrmFields'],
    'a lista de importações é fechada'
  );
  const identificadores = new Set(analise.tokens.filter((token) => token.type === 'id').map((token) => token.value));
  for (const proibido of ['fetch', 'XMLHttpRequest', 'WebSocket', 'process', 'eval', 'Function', 'readFileSync', 'writeFileSync', 'createJsonFileCrmRepository', 'createInMemoryCrmRepository']) {
    assert.equal(identificadores.has(proibido), false, `a integração não pode usar ${proibido}`);
  }
  for (const texto of analise.strings) {
    assert.doesNotMatch(texto.value, /supabase|notion|https?:|\.env|service_role|SUPABASE_/i, `texto suspeito: ${texto.value.slice(0, 60)}`);
  }
  // A promoção é exposta pela rota POST /api/approvals/:id/promote (etapa PROMOÇÃO PELO DASHBOARD): o servidor só usa o serviço
  // INJETADO (promoteProspect) e a raiz de composição só chama a fábrica de arquivos — nenhum dos dois constrói a integração
  // nem a auditoria à mão (as regras seguem no serviço).
  for (const arquivo of [SERVER_APP, SERVER_INDEX]) {
    const codigo = fs.readFileSync(arquivo, 'utf8');
    assert.ok(!/createCrmIntegrationService|createApprovalPromotionService|approvalPromotion/.test(codigo), `${path.basename(arquivo)} não constrói a integração nem a auditoria`);
  }
  assert.ok(/createFileBackedCrmIntegrationService/.test(fs.readFileSync(SERVER_INDEX, 'utf8')));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'api.mjs'), 'utf8').includes('promoteApproval'), 'o Dashboard tem a chamada de promoção');
});

test('[INT-45] a permissão exigida é só WRITE:CRM (pela ponte do CRM, logo no início) mais APPROVE:LEAD_APPROVAL (pela fila): nenhuma permissão nova, e o closer — que tem READ:CRM e APPROVE:LEAD_APPROVAL — continua sem poder promover', async (t) => {
  const pedidos = [];
  const autorizador = (contexto, permissao) => {
    pedidos.push(permissao);
    return authorizeCrmOperation(contexto, permissao);
  };
  const env = ambienteAprovado(t);
  const servico = createCrmIntegrationService({ approvalQueueService: env.fila, approvalPromotionService: env.promocao, crmService: env.crm, authorizeOperation: autorizador });
  await servico.promoteProspect(admin(), env.ids.a);
  assert.deepEqual(pedidos, ['WRITE:CRM'], 'a integração pede exatamente WRITE:CRM à ponte do CRM');
  await semEfeitos(env, async () => await assert.rejects(async () => await servico.promoteProspect(closer(), env.ids.a), /permissão|WRITE:CRM/i));
  assert.deepEqual(pedidos, ['WRITE:CRM', 'WRITE:CRM'], 'o closer também é barrado na primeira etapa: pediu WRITE:CRM e a ponte recusou');
});

// ===========================================================================
// 11) Autorizador defeituoso, marcador forjado e resumo adulterado
// ===========================================================================
test('[INT-46] um autorizador do CRM defeituoso falha fechado ANTES de tudo: false, undefined, texto, lista, Promise e "thenable" são recusas — nada é lido nem gravado; e um autorizador que lança tem o erro repassado', async (t) => {
  const env = ambienteAprovado(t);
  const identidade = { userId: 'u', name: 'U', role: 'ADMIN' };
  const defeituosos = [
    ['false', () => false],
    ['undefined', () => undefined],
    ['null', () => null],
    ['texto', () => 'autorizado'],
    ['número', () => 1],
    ['lista', () => [identidade]],
    ['Promise', () => Promise.resolve(identidade)],
    ['thenable', () => ({ ...identidade, then() {} })],
  ];
  const leituras = [];
  const observadoFila = { getProspect: (...args) => { leituras.push('getProspect'); return env.fila.getProspect(...args); } };
  await semEfeitos(env, async () => {
    for (const [nome, autorizador] of defeituosos) {
      const servico = createCrmIntegrationService({ approvalQueueService: observadoFila, approvalPromotionService: env.promocao, crmService: env.crm, authorizeOperation: autorizador });
      await assert.rejects(async () => await servico.promoteProspect(admin(), env.ids.a), /autorização recusada/, nome);
    }
    const falha = new Error('negado pelo autorizador do teste');
    const lanca = createCrmIntegrationService({ approvalQueueService: observadoFila, approvalPromotionService: env.promocao, crmService: env.crm, authorizeOperation: () => { throw falha; } });
    await assert.rejects(async () => await lanca.promoteProspect(admin(), env.ids.a), (erro) => erro === falha);
  });
  assert.deepEqual(leituras, [], 'a fila nem foi consultada antes da autorização');
});

test('[INT-47] um marcador FORJADO no CRM não vale como aprovação: para um prospect PENDENTE a recusa vem do estado (a reconciliação nunca é alcançada); para um aprovado, só quem tem WRITE:CRM pode ter criado o registro — e o marcador de OUTRO id nunca casa', async (t) => {
  const env = ambienteAprovado(t);
  const marcadorDe = (id) => `Promovido da Approval Queue (prospect ${JSON.stringify(id)}; aprovado por Fulano em 2026-01-01T00:00:00.000Z)`;
  // alguém com WRITE:CRM (só o ADMIN) cria à mão um registro com o marcador do prospect PENDENTE
  await env.crm.createRecord(admin(), { empresa: 'Forjado para o pendente', site: 'forjado-pendente.example.test' }, { reason: marcadorDe(env.ids.b) });
  await semEfeitos(env, async () => await recusa(async () => await promover(env, 'b'), PROMOTION_ERROR.NOT_APPROVED));
  assert.equal(env.itemDaFila('b').promocao, undefined, 'o pendente continua pendente e sem promoção');

  // um motivo que só CITA o marcador no meio do texto não é o marcador
  const citado = ambienteAprovado(t);
  await citado.crm.createRecord(admin(), { empresa: 'Cita o marcador', site: 'cita-o-marcador.example.test' }, { reason: `copiado de: ${marcadorDe(citado.ids.a)}` });
  assert.equal((await promover(citado, 'a')).outcome, PROMOTION_OUTCOME.CRIADO, 'o registro que só cita o marcador não é reconciliado');
  assert.equal(citado.registrosDoCrm().length, 2);

  // o marcador do OUTRO id não é reconhecido pelo prospect aprovado: ele é CRIADO normalmente
  const resultado = await promover(env, 'a');
  assert.equal(resultado.outcome, PROMOTION_OUTCOME.CRIADO);
  assert.equal(env.registrosDoCrm().length, 2);

  // limite de confiança, documentado: o ADMIN (WRITE:CRM) que cria à mão um registro com o marcador de um prospect APROVADO faz
  // a promoção RECONCILIAR com ele — o mesmo ADMIN já poderia criar qualquer registro; nada foi promovido sem aprovação humana
  const forjadoAprovado = ambienteAprovado(t);
  const feito = (await forjadoAprovado.crm.createRecord(admin(), { empresa: 'Feito à mão', site: 'feito-a-mao.example.test' }, { reason: marcadorDe(forjadoAprovado.ids.a) })).record;
  const reconciliado = await promover(forjadoAprovado, 'a');
  assert.equal(reconciliado.outcome, PROMOTION_OUTCOME.RECONCILIADO);
  assert.equal(reconciliado.crmRecordId, feito.id);
  assert.equal(forjadoAprovado.registrosDoCrm().length, 1);
});

test('[INT-48] um resumo de promoção ADULTERADO na fila (crmRecordId perigoso ou de tipo errado) nunca vira um registro: INCONSISTENTE, sem alterar nada', async (t) => {
  for (const perigoso of ['__proto__', 'constructor', 'toString', 'prototype', '', '   ', 42, null, { id: 'x' }, ['crm:x']]) {
    const env = ambienteAprovado(t);
    editarFila(env, (fila) => {
      fila.items[env.ids.a].promocao = { crmRecordId: perigoso, resultado: 'CRIADO', promovidoEm: 'x', promovidoPor: OPERADOR_ADMIN };
    });
    await semEfeitos(env, async () => await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.INCONSISTENT), String(perigoso));
    assert.equal(env.registrosDoCrm().length, 0);
  }
});

test('[INT-49] defesa em profundidade: se o Approval Queue Service devolvesse o item de OUTRO prospect para o id pedido, a promoção recusa (nunca promove o item errado) — e um resultado que não é objeto também', async (t) => {
  const env = ambienteAprovado(t);
  aprovar(env, 'b');
  const doOutro = env.fila.getProspect(admin(), env.ids.b);
  await semEfeitos(env, async () => {
    const outroItem = outroServico(env, { fila: { getProspect: () => structuredClone(doOutro) } });
    await recusa(async () => await outroItem.promoteProspect(admin(), env.ids.a), PROMOTION_ERROR.PROSPECT_NOT_FOUND);
    for (const resultado of [null, undefined, 'texto', 42, [], true]) {
      const defeituoso = outroServico(env, { fila: { getProspect: () => resultado } });
      await recusa(async () => await defeituoso.promoteProspect(admin(), env.ids.a), PROMOTION_ERROR.PROSPECT_NOT_FOUND);
    }
  });
});

test('[INT-50] o DNC da pesquisa só conta como propriedade PRÓPRIA do snapshot: um statusDNC "BLOQUEADO" que só existe no protótipo (Object.prototype poluído) e um snapshot SEM a chave não bloqueiam', async (t) => {
  const env = ambienteAprovado(t);
  const base = env.fila.getProspect(admin(), env.ids.a);
  const semChave = structuredClone(base);
  delete semChave.discoverySnapshot.statusDNC;
  Object.prototype.statusDNC = 'BLOQUEADO';
  try {
    const servico = outroServico(env, { fila: { getProspect: () => structuredClone(semChave) } });
    const resultado = await servico.promoteProspect(admin(), env.ids.a);
    assert.equal(resultado.outcome, PROMOTION_OUTCOME.CRIADO, 'o statusDNC herdado não bloqueou');
  } finally {
    delete Object.prototype.statusDNC;
  }
  assert.equal(env.registrosDoCrm().length, 1);
});

test('[INT-51] DNC vale MAIS que a duplicidade, como no domínio do CRM: um registro DO_NOT_CONTACT com a mesma empresa e cidade (mesmo sem nenhum identificador forte igual) BLOQUEIA a promoção, enquanto o mesmo nome+cidade num registro comum só sinaliza (INT-27)', async (t) => {
  const env = ambienteAprovado(t);
  const bloqueado = (await env.crm.createRecord(admin(), { empresa: 'Clínica Alfa', cidade: 'Petrópolis', site: 'outro-endereco.example.test' })).record;
  await env.crm.markDoNotContact(admin(), bloqueado.id, { reason: 'pediu para não ser contatado' });
  const crmAntes = env.textoDoCrm();
  await recusa(async () => await promover(env, 'a'), PROMOTION_ERROR.BLOCKED_DNC, /já está bloqueada como DO_NOT_CONTACT no CRM/);
  assert.equal(env.textoDoCrm(), crmAntes);
  assert.equal(env.itemDaFila('a').promocao, undefined);
  const auditoria = env.itemDaFila('a').historico[env.itemDaFila('a').historico.length - 1];
  assert.deepEqual(auditoria.promocao, { resultado: 'BLOQUEADO', codigo: 'DNC', crmRecordId: bloqueado.id });
});
