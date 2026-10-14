'use strict';

// Fase 2B-3.2A — PROTEÇÃO DO SNAPSHOT DA FILA DE APROVAÇÃO (decisão 0016).
//
// O defeito provado: `addProspect` regravava `discoverySnapshot` de um item JÁ DECIDIDO (aprovado, rejeitado, DNC, duplicado…) ANTES de
// olhar o estado terminal. A mensagem do histórico dizia "nenhuma alteração automática", mas o conteúdo que a promoção manda ao CRM (o
// snapshot ATUAL) passava a ser outro que o aprovado pelo humano. A correção: um item fora de AGUARDANDO_REVISAO tem o conteúdo CONGELADO;
// uma redescoberta só registra, no histórico, QUAIS campos a nova pesquisa trouxe diferentes (nunca os valores); a única mudança de dado é
// conservadora e de segurança — `statusDNC` → BLOQUEADO, e nunca o contrário. Um item em revisão segue a regra de sempre.
//
// Tudo EM MEMÓRIA, com dados fictícios (example.test): nenhum arquivo do projeto é lido ou gravado, nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const domain = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE, DNC_STATUS } = require('../../src/research-prospector/discovery');
const { mapProspectToCrmFields } = require('../../src/services/prospectToCrmFields');

const { QUEUE_STATE, ACTOR, REDISCOVERY_HISTORY_TYPE, MAX_REDISCOVERY_HISTORY_ENTRIES } = domain;

const REVISOR = { userId: 'user-revisor-teste', name: 'Revisor Teste', role: 'ADMIN' };
const revisao = domain.createApprovalReviewActions({ authorizeReviewer: () => ({ ...REVISOR }) });
const reaprovacao = domain.createApprovalReconsiderationActions({ authorizeReviewer: () => ({ ...REVISOR }) });
const promocao = domain.createApprovalPromotionActions({ authorizeReviewer: () => ({ ...REVISOR }) });

const A = { cidade: 'Petrópolis', nicho: 'Psicologia', telefone: '(24) 90000-0001', email: 'contato-a@clinica-demo.example.test', fonte: 'https://fonte-a.example.test/pagina' };
const B = { cidade: 'Niterói', nicho: 'Estética', telefone: '(21) 90000-0002', email: 'contato-b@clinica-demo.example.test', fonte: 'https://fonte-b.example.test/outra' };
const SITE = 'clinica-demo.example.test';
const DNC_NO_CRM = [{ empresa: 'Registro bloqueado fictício', site: `https://${SITE}`, doNotContact: true }];

const oficial = (valor) => ({ valor, fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL });

// Um achado fictício; `dados` troca cidade, nicho, telefone, e-mail e fonte (o site — a identidade forte — fica o mesmo: é a mesma entidade).
function descobrir(dados = A, crmRecords = [], extras = {}) {
  const campos = { site: [oficial(SITE)] };
  if (dados.telefone) campos.telefone = [oficial(dados.telefone)];
  if (dados.email) campos.email = [oficial(dados.email)];
  const achado = { empresa: 'Clínica Exemplo Demonstração', cidade: dados.cidade, estado: 'RJ', nicho: dados.nicho, campos, fontes: dados.fonte ? [dados.fonte] : [], ...extras };
  return runDiscoveryPipeline({
    briefing: { nicho: dados.nicho, regiao: `${dados.cidade}/RJ`, quantidadeDesejada: 5, exclusoes: [] },
    rawFindings: [achado],
    crmRecords,
    dataDaPesquisa: '2026-09-20',
  }).resultados[0];
}

const clone = (valor) => JSON.parse(JSON.stringify(valor));
const ultima = (item) => item.historico[item.historico.length - 1];
const redescobertas = (item) => item.historico.filter((e) => e.tipo === REDISCOVERY_HISTORY_TYPE);
const camposQueMudaram = (antes, depois) => Object.keys({ ...antes, ...depois }).filter((k) => JSON.stringify(antes[k] ?? null) !== JSON.stringify(depois[k] ?? null));
const CAMPOS_DA_REDESCOBERTA_A_B = ['cidade', 'nicho', 'telefone', 'email', 'fontes'];

// Um item na fila, no estado pedido, com o conteúdo A.
function itemEm(estado, dados = A, crmRecords = []) {
  const queue = domain.createEmptyQueue();
  const item = domain.addProspect(queue, descobrir(dados, crmRecords));
  if (estado === QUEUE_STATE.APROVADO_PARA_CRM) revisao.approveProspect(queue, item.prospectId, {}, 'aprovado pelo revisor');
  if (estado === QUEUE_STATE.REJEITADO) revisao.rejectProspect(queue, item.prospectId, {}, 'sem fit — decisão humana');
  return { queue, id: item.prospectId };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// O defeito e o congelamento
// ---------------------------------------------------------------------------------------------------------------------------------
test('[REDISC-1] aprovado e AINDA NÃO promovido, redescoberto com dados diferentes: o snapshot, o estado, a aprovação e o que iria ao CRM ficam EXATAMENTE como o humano aprovou', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const item = queue.items[id];
  const snapshotAprovado = clone(item.discoverySnapshot);
  const aprovacao = clone(item.historico.find((e) => e.to === QUEUE_STATE.APROVADO_PARA_CRM));
  const paraOCrm = mapProspectToCrmFields(clone(item));
  assert.equal(domain.buildStableId(descobrir(A)), domain.buildStableId(descobrir(B)), 'pré-condição: é a mesma entidade para a fila');

  domain.addProspect(queue, descobrir(B));

  const depois = queue.items[id];
  assert.equal(depois.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.deepEqual(clone(depois.discoverySnapshot), snapshotAprovado, 'nenhum campo do snapshot mudou');
  assert.deepEqual(mapProspectToCrmFields(clone(depois)), paraOCrm, 'o que a promoção mandaria ao CRM é idêntico');
  assert.deepEqual(clone(depois.historico.find((e) => e.to === QUEUE_STATE.APROVADO_PARA_CRM)), aprovacao, 'a aprovação humana está intacta');
  assert.equal(depois.empresa, 'Clínica Exemplo Demonstração');
  assert.equal(depois.prospectId, id);
});

test('[REDISC-2] o congelamento vale para todo estado fora da revisão: rejeitado, DNC, duplicado, dados insuficientes e expirado mantêm o snapshot e o estado', () => {
  const casos = [
    ['REJEITADO', itemEm(QUEUE_STATE.REJEITADO)],
    ['DNC', itemEm(QUEUE_STATE.DNC, A, DNC_NO_CRM)],
    ['DUPLICADO', itemEm(QUEUE_STATE.DUPLICADO, A, [{ empresa: 'Já no CRM', site: `https://${SITE}` }])],
    ['DADOS_INSUFICIENTES', (() => {
      const queue = domain.createEmptyQueue();
      const item = domain.addProspect(queue, descobrir(A));
      domain.markDadosInsuficientes(queue, item.prospectId, 'faltam dados');
      return { queue, id: item.prospectId };
    })()],
    ['EXPIRADO', (() => {
      const queue = domain.createEmptyQueue();
      const item = domain.addProspect(queue, descobrir(A));
      item.estado = QUEUE_STATE.EXPIRADO; // o estado existe no modelo, mas nenhuma automação o atribui
      return { queue, id: item.prospectId };
    })()],
  ];
  for (const [estado, { queue, id }] of casos) {
    const antes = clone(queue.items[id].discoverySnapshot);
    const estadoAntes = queue.items[id].estado;
    domain.addProspect(queue, descobrir(B));
    assert.equal(queue.items[id].estado, estadoAntes, `${estado}: o estado ficou`);
    assert.deepEqual(clone(queue.items[id].discoverySnapshot), antes, `${estado}: o snapshot ficou`);
    const entrada = ultima(queue.items[id]);
    assert.equal(entrada.tipo, REDISCOVERY_HISTORY_TYPE, estado);
    assert.equal(entrada.from, estadoAntes, estado);
    assert.equal(entrada.to, estadoAntes, estado);
  }
});

test('[REDISC-3] rejeitado: a decisão humana, o motivo e quem decidiu continuam; o snapshot não é trocado em silêncio', () => {
  const { queue, id } = itemEm(QUEUE_STATE.REJEITADO);
  const item = queue.items[id];
  const rejeicao = clone(item.historico.find((e) => e.to === QUEUE_STATE.REJEITADO));
  const snapshot = clone(item.discoverySnapshot);
  domain.addProspect(queue, descobrir(B));
  domain.addProspect(queue, descobrir(B));
  assert.equal(queue.items[id].estado, QUEUE_STATE.REJEITADO);
  assert.deepEqual(clone(queue.items[id].discoverySnapshot), snapshot);
  assert.deepEqual(clone(queue.items[id].historico.find((e) => e.to === QUEUE_STATE.REJEITADO)), rejeicao);
  assert.equal(rejeicao.reviewedBy.userId, REVISOR.userId);
  assert.equal(rejeicao.motivo, 'sem fit — decisão humana');
});

test('[REDISC-4] já PROMOVIDO: o resumo `promocao` e a entrada de promoção ficam intactos e o snapshot não muda (nenhuma alteração automática no que foi ao CRM)', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  promocao.recordPromotion(queue, id, {}, { resultado: 'CRIADO', crmRecordId: 'crm:11111111-1111-4111-8111-111111111111' });
  const antes = clone(queue.items[id]);
  const promovida = mapProspectToCrmFields(clone(queue.items[id]));

  domain.addProspect(queue, descobrir(B));

  const depois = queue.items[id];
  assert.deepEqual(clone(depois.promocao), antes.promocao);
  assert.deepEqual(clone(depois.discoverySnapshot), antes.discoverySnapshot);
  assert.deepEqual(mapProspectToCrmFields(clone(depois)), promovida, 'o snapshot continua dizendo o mesmo que foi ao CRM');
  assert.deepEqual(clone(depois.historico.slice(0, antes.historico.length)), antes.historico, 'todo o histórico anterior permanece, na mesma ordem');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// DNC
// ---------------------------------------------------------------------------------------------------------------------------------
test('[REDISC-5] o único valor de DNC que proíbe o contato é BLOQUEADO — e o literal local do domínio é o mesmo do discovery (paridade)', () => {
  assert.equal(domain.DNC_BLOCKED, DNC_STATUS.BLOQUEADO);
  assert.equal(descobrir(A).statusDNC, DNC_STATUS.NAO_ENCONTRADO, 'sem restrição no CRM: NAO_ENCONTRADO');
  assert.equal(descobrir(A, DNC_NO_CRM).statusDNC, DNC_STATUS.BLOQUEADO, 'com DO_NOT_CONTACT no CRM: BLOQUEADO');
});

test('[REDISC-6] DNC NOVO numa redescoberta de um aprovado: SÓ `statusDNC` muda (para BLOQUEADO); o resto do snapshot, o estado e a aprovação ficam; a promoção passa a falhar fechada e o histórico diz isso', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const antes = clone(queue.items[id].discoverySnapshot);
  assert.notEqual(antes.statusDNC, DNC_STATUS.BLOQUEADO, 'pré-condição');

  domain.addProspect(queue, descobrir(B, DNC_NO_CRM));

  const item = queue.items[id];
  assert.equal(item.estado, QUEUE_STATE.APROVADO_PARA_CRM, 'o estado não muda por causa do DNC (quem barra é a promoção)');
  assert.equal(item.discoverySnapshot.statusDNC, DNC_STATUS.BLOQUEADO);
  assert.deepEqual(camposQueMudaram(antes, clone(item.discoverySnapshot)), ['statusDNC'], 'nenhum outro campo mudou');
  const entrada = ultima(item);
  assert.equal(entrada.tipo, REDISCOVERY_HISTORY_TYPE);
  assert.equal(entrada.redescoberta.dncAtualizado, true);
  assert.equal(entrada.redescoberta.conteudoPreservado, true);
  assert.match(entrada.motivo, /restrição de contato \(DNC\) registrada/);
});

test('[REDISC-7] uma redescoberta MAIS LIMPA nunca remove um DNC já registrado: aprovado, rejeitado e em revisão (que voltou da rejeição) continuam BLOQUEADO', () => {
  for (const estado of [QUEUE_STATE.APROVADO_PARA_CRM, QUEUE_STATE.REJEITADO]) {
    const { queue, id } = itemEm(estado);
    domain.addProspect(queue, descobrir(A, DNC_NO_CRM));
    assert.equal(queue.items[id].discoverySnapshot.statusDNC, DNC_STATUS.BLOQUEADO, `${estado}: pré-condição`);

    domain.addProspect(queue, descobrir(B)); // pesquisa limpa: NAO_ENCONTRADO
    assert.equal(queue.items[id].discoverySnapshot.statusDNC, DNC_STATUS.BLOQUEADO, `${estado}: continua BLOQUEADO`);
    assert.ok(redescobertas(queue.items[id]).at(-1).redescoberta.camposDiferentes.includes('statusDNC'), `${estado}: o histórico diz que a nova pesquisa difere em DNC`);
    assert.equal(redescobertas(queue.items[id]).at(-1).redescoberta.dncAtualizado, false, `${estado}: e que nada de DNC foi alterado`);
  }

  // rejeitado -> DNC visto na redescoberta -> reaprovado (volta à revisão) -> redescoberta limpa: o item em revisão não perde o BLOQUEADO
  const { queue, id } = itemEm(QUEUE_STATE.REJEITADO);
  domain.addProspect(queue, descobrir(A, DNC_NO_CRM));
  reaprovacao.reconsiderProspect(queue, id, {}, 'reconsiderado');
  assert.equal(queue.items[id].estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  domain.addProspect(queue, descobrir(B));
  assert.equal(queue.items[id].estado, QUEUE_STATE.AGUARDANDO_REVISAO, 'a regra de estado do item em revisão não mudou');
  assert.equal(queue.items[id].discoverySnapshot.statusDNC, DNC_STATUS.BLOQUEADO, 'mas o snapshot não perdeu o BLOQUEADO');
  assert.equal(queue.items[id].discoverySnapshot.cidade, B.cidade, 'o resto do snapshot em revisão acompanhou a pesquisa, como sempre');
});

test('[REDISC-8] outros valores de DNC (NAO_VERIFICADO, NAO_ENCONTRADO) nunca são "restrição": não alteram o snapshot de um item decidido', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const antes = clone(queue.items[id].discoverySnapshot);
  for (const valor of [DNC_STATUS.NAO_VERIFICADO, DNC_STATUS.NAO_ENCONTRADO]) {
    const fresco = descobrir(B);
    fresco.statusDNC = valor;
    domain.addProspect(queue, fresco);
    assert.deepEqual(clone(queue.items[id].discoverySnapshot), antes, valor);
  }
});

test('[REDISC-9] DNC repetido: a segunda redescoberta com DNC não grava outra atualização de DNC (idempotente) — existe no máximo UMA entrada com dncAtualizado por item', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  for (let i = 0; i < 4; i += 1) domain.addProspect(queue, descobrir(B, DNC_NO_CRM));
  assert.equal(redescobertas(queue.items[id]).filter((e) => e.redescoberta.dncAtualizado).length, 1);
  assert.equal(queue.items[id].discoverySnapshot.statusDNC, DNC_STATUS.BLOQUEADO);
});

test('[REDISC-10] um item já em DNC (estado) continua em DNC e com o snapshot BLOQUEADO depois de uma redescoberta limpa', () => {
  const { queue, id } = itemEm(QUEUE_STATE.DNC, A, DNC_NO_CRM);
  assert.equal(queue.items[id].estado, QUEUE_STATE.DNC);
  domain.addProspect(queue, descobrir(B));
  assert.equal(queue.items[id].estado, QUEUE_STATE.DNC);
  assert.equal(queue.items[id].discoverySnapshot.statusDNC, DNC_STATUS.BLOQUEADO);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Itens em revisão e reconsideração humana
// ---------------------------------------------------------------------------------------------------------------------------------
test('[REDISC-11] item em REVISÃO: a regra de sempre — o snapshot acompanha a pesquisa mais recente e o histórico mantém as mensagens de antes', () => {
  const { queue, id } = itemEm(QUEUE_STATE.AGUARDANDO_REVISAO);
  domain.addProspect(queue, descobrir(B));
  const item = queue.items[id];
  assert.equal(item.estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(item.discoverySnapshot.cidade, B.cidade);
  assert.equal(item.discoverySnapshot.nicho, B.nicho);
  assert.equal(item.discoverySnapshot.telefone, B.telefone);
  assert.equal(ultima(item).motivo, 'Redescoberto — mesma classificação de sistema');
  assert.equal(ultima(item).tipo, undefined, 'a entrada de um item em revisão não ganhou formato novo');
  assert.equal(ultima(item).actor, ACTOR.SYSTEM);
});

test('[REDISC-12] item em REVISÃO que a pesquisa vê como DNC: segue para o estado DNC (transição de sistema de sempre)', () => {
  const { queue, id } = itemEm(QUEUE_STATE.AGUARDANDO_REVISAO);
  domain.addProspect(queue, descobrir(B, DNC_NO_CRM));
  assert.equal(queue.items[id].estado, QUEUE_STATE.DNC);
  assert.equal(queue.items[id].discoverySnapshot.statusDNC, DNC_STATUS.BLOQUEADO);
  assert.equal(ultima(queue.items[id]).to, QUEUE_STATE.DNC);
});

test('[REDISC-13] reconsideração humana preservada: rejeitado -> redescoberto -> reaprovado volta à revisão com a decisão anterior no histórico; depois disso o item em revisão volta a seguir a pesquisa', () => {
  const { queue, id } = itemEm(QUEUE_STATE.REJEITADO);
  const snapshotRejeitado = clone(queue.items[id].discoverySnapshot);
  domain.addProspect(queue, descobrir(B));
  reaprovacao.reconsiderProspect(queue, id, {}, 'Mudou o contexto');
  const item = queue.items[id];
  assert.equal(item.estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(item.reaprovacoes, 1);
  assert.deepEqual(clone(item.discoverySnapshot), snapshotRejeitado, 'a reconsideração mostra o que foi reprovado, não um conteúdo trocado em silêncio');
  assert.equal(ultima(item).tipo, 'REAPROVACAO');
  assert.ok(item.historico.some((e) => e.to === QUEUE_STATE.REJEITADO && e.reviewedBy && e.reviewedBy.userId === REVISOR.userId), 'a rejeição humana continua no histórico');

  domain.addProspect(queue, descobrir(B));
  assert.equal(queue.items[id].discoverySnapshot.cidade, B.cidade, 'agora em revisão: a pesquisa mais recente vale');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// O histórico da redescoberta
// ---------------------------------------------------------------------------------------------------------------------------------
test('[REDISC-14] a entrada de histórico é verdadeira e mínima: data, estado, campos diferentes e "conteúdo preservado" — e nenhum telefone, e-mail, site ou fonte (novo ou antigo)', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const antes = queue.items[id].historico.length;
  domain.addProspect(queue, descobrir(B));
  const item = queue.items[id];
  assert.equal(item.historico.length, antes + 1);
  const entrada = ultima(item);
  assert.deepEqual(Object.keys(entrada).sort(), ['actor', 'from', 'motivo', 'redescoberta', 'timestamp', 'tipo', 'to']);
  assert.equal(Number.isNaN(Date.parse(entrada.timestamp)), false, 'a data é um ISO válido');
  assert.equal(entrada.actor, ACTOR.SYSTEM);
  assert.equal(entrada.reviewedBy, undefined, 'não é uma decisão humana');
  assert.deepEqual(entrada.redescoberta, { camposDiferentes: CAMPOS_DA_REDESCOBERTA_A_B, conteudoPreservado: true, dncAtualizado: false, repeticoes: 1, ultimaEm: entrada.timestamp });
  assert.match(entrada.motivo, /difere em: cidade, nicho, telefone, e-mail, fontes\. Nada foi substituído; estado e conteúdo já decididos preservados/);
  const texto = JSON.stringify(entrada);
  for (const dado of [A.telefone, B.telefone, A.email, B.email, A.fonte, B.fonte, SITE, A.cidade, B.cidade, A.nicho, B.nicho]) {
    assert.equal(texto.includes(dado), false, `o histórico não repete "${dado}"`);
  }
});

test('[REDISC-15] a mensagem antiga ("nenhuma alteração automática") não é mais usada para um item decidido: o texto novo descreve o comportamento real, também quando nada difere', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  domain.addProspect(queue, descobrir(A));
  const entrada = ultima(queue.items[id]);
  assert.deepEqual(entrada.redescoberta.camposDiferentes, []);
  assert.match(entrada.motivo, /^Redescoberto — nenhum dado diferente do registrado; estado e conteúdo já decididos preservados$/);
  assert.equal(queue.items[id].historico.some((e) => /nenhuma alteração automática/.test(e.motivo)), false);
});

test('[REDISC-16] redescobertas IDÊNTICAS e consecutivas viram UMA entrada com contador: o histórico não cresce a cada repetição', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const antes = queue.items[id].historico.length;
  for (let i = 0; i < 6; i += 1) domain.addProspect(queue, descobrir(B));
  const item = queue.items[id];
  assert.equal(item.historico.length, antes + 1);
  assert.equal(ultima(item).redescoberta.repeticoes, 6);
  assert.match(ultima(item).motivo, /^Redescoberto 6 vezes — a nova pesquisa difere em:/);
  assert.equal(Date.parse(ultima(item).redescoberta.ultimaEm) >= Date.parse(ultima(item).timestamp), true);
});

test('[REDISC-17] o histórico de redescoberta é LIMITADO: com padrões alternados (que não se somam), nunca passa do teto, e nenhuma redescoberta se perde na contagem', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const antes = queue.items[id].historico.length;
  const so = (dados) => ({ cidade: dados.cidade, nicho: dados.nicho, telefone: dados.telefone, fonte: dados.fonte });
  const total = MAX_REDISCOVERY_HISTORY_ENTRIES * 3 + 7;
  for (let i = 0; i < total; i += 1) domain.addProspect(queue, descobrir(i % 2 === 0 ? so(B) : { ...so(A), cidade: 'Cabo Frio' }));
  const item = queue.items[id];
  assert.equal(redescobertas(item).length, MAX_REDISCOVERY_HISTORY_ENTRIES, 'no teto');
  assert.equal(item.historico.length, antes + MAX_REDISCOVERY_HISTORY_ENTRIES);
  assert.equal(redescobertas(item).reduce((soma, e) => soma + e.redescoberta.repeticoes, 0), total, 'cada redescoberta foi contada');
  assert.equal(JSON.stringify(item.historico).includes(B.telefone), false);
});

test('[REDISC-18] a entrada de DNC nunca é fundida com outras e não conta para o teto: depois de uma atualização de DNC a repetição seguinte abre uma entrada própria', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  domain.addProspect(queue, descobrir(B));
  domain.addProspect(queue, descobrir(B));
  domain.addProspect(queue, descobrir(B, DNC_NO_CRM));
  domain.addProspect(queue, descobrir(B));
  const lista = redescobertas(queue.items[id]);
  assert.equal(lista.length, 3);
  assert.deepEqual(lista.map((e) => [e.redescoberta.dncAtualizado, e.redescoberta.repeticoes]), [[false, 2], [true, 1], [false, 1]]);
});

test('[REDISC-26] a fusão do teto acontece na ÚLTIMA entrada comum e soma os campos novos aos que ela já listava (nada de uma redescoberta fica sem registro)', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const soNicho = { ...A, nicho: 'Odontologia' }; // difere só em nicho
  const soTelefone = { ...A, telefone: '(24) 90000-0009' }; // difere só em telefone
  for (let i = 0; i < MAX_REDISCOVERY_HISTORY_ENTRIES; i += 1) domain.addProspect(queue, descobrir(i % 2 === 0 ? soNicho : soTelefone));
  let lista = redescobertas(queue.items[id]);
  assert.equal(lista.length, MAX_REDISCOVERY_HISTORY_ENTRIES, 'pré-condição: no teto, nenhuma entrada somada');
  assert.deepEqual([lista[0].redescoberta.camposDiferentes, lista.at(-1).redescoberta.camposDiferentes], [['nicho'], ['telefone']]);

  domain.addProspect(queue, descobrir(soNicho)); // o 21º padrão: funde na última (a de telefone)
  lista = redescobertas(queue.items[id]);
  assert.equal(lista.length, MAX_REDISCOVERY_HISTORY_ENTRIES);
  assert.deepEqual(lista.at(-1).redescoberta.camposDiferentes, ['nicho', 'telefone'], 'a união dos campos');
  assert.equal(lista.at(-1).redescoberta.repeticoes, 2);
  assert.equal(lista[0].redescoberta.repeticoes, 1, 'as entradas anteriores não foram tocadas');
  assert.match(lista.at(-1).motivo, /^Redescoberto 2 vezes — a nova pesquisa difere em: nicho, telefone\./);
});

test('[REDISC-24] no teto, a fusão cai na última entrada COMUM — nunca na de DNC, mesmo quando a de DNC é a última do histórico', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const so = (dados) => ({ cidade: dados.cidade, nicho: dados.nicho, telefone: dados.telefone, fonte: dados.fonte });
  const padrao = (i) => (i % 2 === 0 ? so(B) : { ...so(A), cidade: 'Cabo Frio' });
  for (let i = 0; i < MAX_REDISCOVERY_HISTORY_ENTRIES - 1; i += 1) domain.addProspect(queue, descobrir(padrao(i)));
  domain.addProspect(queue, descobrir(B, DNC_NO_CRM)); // a atualização de DNC fica por último no histórico
  assert.equal(redescobertas(queue.items[id]).length, MAX_REDISCOVERY_HISTORY_ENTRIES, 'pré-condição: 19 comuns + 1 de DNC');
  assert.equal(ultima(queue.items[id]).redescoberta.dncAtualizado, true);

  domain.addProspect(queue, descobrir({ ...so(A), cidade: 'Arraial do Cabo' })); // um padrão novo: ainda cabe como a 20ª comum
  const lista = redescobertas(queue.items[id]);
  assert.equal(lista.filter((e) => !e.redescoberta.dncAtualizado).length, MAX_REDISCOVERY_HISTORY_ENTRIES);
  const dnc = lista.find((e) => e.redescoberta.dncAtualizado);
  assert.equal(dnc.redescoberta.repeticoes, 1, 'a entrada de DNC não absorveu nada');
  domain.addProspect(queue, descobrir({ ...so(A), cidade: 'Búzios' })); // agora é fusão
  const depois = redescobertas(queue.items[id]);
  assert.equal(depois.length, MAX_REDISCOVERY_HISTORY_ENTRIES + 1, 'o teto vale para as comuns; a de DNC é a única extra');
  assert.equal(depois.find((e) => e.redescoberta.dncAtualizado).redescoberta.repeticoes, 1);
  assert.equal(depois.at(-1).redescoberta.repeticoes, 2, 'a fusão aconteceu na última comum');
  assert.equal(depois.at(-1).redescoberta.dncAtualizado, false);
});

test('[REDISC-25] "sem valor" é um só: null e ausente não contam como diferença (nem de um lado, nem do outro)', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const fresco = descobrir(A);
  queue.items[id].discoverySnapshot.facebook = null; // gravado como null...
  delete fresco.facebook; // ...e a pesquisa nova não traz o campo
  queue.items[id].discoverySnapshot.linkedin = undefined; // gravado sem valor...
  fresco.linkedin = null; // ...e a pesquisa nova traz null
  domain.addProspect(queue, fresco);
  assert.deepEqual(ultima(queue.items[id]).redescoberta.camposDiferentes, [], 'nenhuma diferença real');
});

test('[REDISC-19] arquivos antigos: as entradas "Redescoberto — …" já gravadas continuam como estão; a primeira redescoberta nova só acrescenta uma entrada no formato novo', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const antiga = { timestamp: '2026-09-01T10:00:00.000Z', from: QUEUE_STATE.APROVADO_PARA_CRM, to: QUEUE_STATE.APROVADO_PARA_CRM, actor: ACTOR.SYSTEM, motivo: 'Redescoberto — estado já decidido/travado, nenhuma alteração automática' };
  queue.items[id].historico.push(clone(antiga), clone(antiga));
  const antes = clone(queue.items[id].historico);

  domain.addProspect(queue, descobrir(B));

  const item = queue.items[id];
  assert.deepEqual(clone(item.historico.slice(0, antes.length)), antes, 'nenhuma entrada antiga foi tocada, somada ou removida');
  assert.equal(item.historico.length, antes.length + 1);
  assert.equal(ultima(item).tipo, REDISCOVERY_HISTORY_TYPE);
});

test('[REDISC-20] compatibilidade de formato: a fila continua { items }, a entrada nova tem as chaves de sempre (timestamp, from, to, actor, motivo) e sobrevive ao ciclo gravar/ler do arquivo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rediscovery-format-'));
  try {
    const arquivo = path.join(dir, 'approval-queue.json');
    const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
    domain.addProspect(queue, descobrir(B));
    domain.addProspect(queue, descobrir(B, DNC_NO_CRM));
    domain.saveQueueToDisk(queue, arquivo);
    const lida = domain.loadQueueFromDisk(arquivo);
    assert.deepEqual(Object.keys(lida), ['items']);
    assert.deepEqual(lida, clone(queue), 'o que foi gravado volta igual');
    for (const entrada of lida.items[id].historico) {
      for (const chave of ['timestamp', 'from', 'to', 'actor', 'motivo']) assert.ok(chave in entrada, `${chave} presente`);
      assert.equal(typeof entrada.motivo, 'string');
    }
    // uma redescoberta sobre o item lido do arquivo continua funcionando (o item foi relido, não é o objeto em memória)
    domain.addProspect(lida, descobrir(B));
    assert.equal(ultima(lida.items[id]).tipo, REDISCOVERY_HISTORY_TYPE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Idempotência, identidade e metadados
// ---------------------------------------------------------------------------------------------------------------------------------
test('[REDISC-21] a identidade não mudou: a redescoberta nunca cria outro item nem altera o id, a empresa, o criadoEm ou os outros itens da fila; lastSeenAt acompanha', () => {
  const queue = domain.createEmptyQueue();
  const alfa = domain.addProspect(queue, descobrir(A));
  const outra = domain.addProspect(queue, runDiscoveryPipeline({ briefing: { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', quantidadeDesejada: 5, exclusoes: [] }, rawFindings: [{ empresa: 'Clínica Outra', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos: { site: [oficial('clinica-outra.example.test')] }, fontes: [] }], crmRecords: [] }).resultados[0]);
  revisao.approveProspect(queue, alfa.prospectId, {}, 'ok');
  const outraAntes = clone(queue.items[outra.prospectId]);
  const criadoEm = alfa.criadoEm;
  queue.items[alfa.prospectId].lastSeenAt = '2026-01-01T00:00:00.000Z';

  domain.addProspect(queue, descobrir(B));

  assert.equal(Object.keys(queue.items).length, 2);
  assert.equal(queue.items[alfa.prospectId].criadoEm, criadoEm);
  assert.equal(queue.items[alfa.prospectId].empresa, 'Clínica Exemplo Demonstração');
  assert.notEqual(queue.items[alfa.prospectId].lastSeenAt, '2026-01-01T00:00:00.000Z', 'a última vez que foi visto avança');
  assert.deepEqual(clone(queue.items[outra.prospectId]), outraAntes);
});

test('[REDISC-22] item sem snapshot utilizável (arquivo antigo ou corrompido): não há conteúdo decidido a preservar — recebe o da pesquisa e o histórico diz que o conteúdo NÃO foi preservado', () => {
  const { queue, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  delete queue.items[id].discoverySnapshot;
  domain.addProspect(queue, descobrir(B));
  assert.equal(queue.items[id].discoverySnapshot.cidade, B.cidade);
  assert.equal(ultima(queue.items[id]).redescoberta.conteudoPreservado, false);
  assert.equal(queue.items[id].estado, QUEUE_STATE.APROVADO_PARA_CRM);
});

test('[REDISC-23] a entrada inválida continua recusada, e o novo caminho não exige nada além do que addProspect já recebia', () => {
  const queue = domain.createEmptyQueue();
  assert.throws(() => domain.addProspect(queue, null), /discoveryResult inválido/);
  assert.throws(() => domain.addProspect(queue, {}), /discoveryResult inválido/);
  const { queue: q2, id } = itemEm(QUEUE_STATE.APROVADO_PARA_CRM);
  const fresco = descobrir(B);
  delete fresco.statusDNC; // um resultado sem o campo: nunca é "restrição"
  domain.addProspect(q2, fresco);
  assert.notEqual(q2.items[id].discoverySnapshot.statusDNC, DNC_STATUS.BLOQUEADO);
});
