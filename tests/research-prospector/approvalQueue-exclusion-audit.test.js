'use strict';

// Fase 2B-3.2B — a AUDITORIA dos bloqueios por Exclusão Permanente no domínio da fila (recordPromotionBlocked): três códigos novos que são
// códigos de auditoria (NÃO estados — a máquina de estados não mudou), e a soma de tentativas idênticas para o histórico não crescer sem
// limite. Em memória, dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const domain = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');

const { QUEUE_STATE, PROMOTION_BLOCK, ALLOWED_TRANSITIONS } = domain;

const revisor = (userId) => ({ userId, name: `Revisor ${userId}`, role: 'ADMIN' });
const comoRevisor = (userId) => domain.createApprovalPromotionActions({ authorizeReviewer: () => revisor(userId) });
const aprovacao = domain.createApprovalReviewActions({ authorizeReviewer: () => revisor('user-aprovador') });

function filaComAprovado() {
  const queue = domain.createEmptyQueue();
  const resultado = runDiscoveryPipeline({
    briefing: { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', quantidadeDesejada: 5, exclusoes: [] },
    rawFindings: [{ empresa: 'Clínica Exemplo', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos: { site: [{ valor: 'clinica-exemplo.example.test', fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL }] }, fontes: [] }],
    crmRecords: [],
  }).resultados[0];
  const item = domain.addProspect(queue, resultado);
  aprovacao.approveProspect(queue, item.prospectId, {}, 'ok');
  return { queue, id: item.prospectId };
}
const bloqueios = (item) => item.historico.filter((e) => e.promocao && e.promocao.resultado === 'BLOQUEADO');
const MOTIVO = 'esta empresa consta nas Exclusões Permanentes de Prospecção';

// Registra UMA tentativa bloqueada feita por `quem` (o histórico fica em queue.items[id]).
const registrar = (queue, id, quem, codigo = PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivo = MOTIVO) => comoRevisor(quem).recordPromotionBlocked(queue, id, {}, { codigo, motivo });
// Quantas tentativas o HISTÓRICO atribui a cada pessoa: a soma dos contadores das linhas de bloqueio de que ela é a autora.
const tentativasPorOperador = (item, filtro = () => true) => {
  const soma = {};
  for (const entrada of bloqueios(item)) {
    if (filtro(entrada)) soma[entrada.reviewedBy.userId] = (soma[entrada.reviewedBy.userId] || 0) + (entrada.promocao.tentativas || 1);
  }
  return soma;
};
const semSufixo = (motivo) => motivo.replace(/ \(\d+ tentativas\)$/, '');

test('[EXCL-AUD-1] os códigos novos de auditoria existem, o conjunto é fechado e a máquina de estados é a mesma (nenhum estado novo)', () => {
  assert.deepEqual(Object.keys(PROMOTION_BLOCK).sort(), ['DADOS_INSUFICIENTES', 'DNC', 'DUPLICADO', 'EXCLUSAO_AMBIGUA', 'EXCLUSAO_NAO_VERIFICAVEL', 'EXCLUSAO_PERMANENTE']);
  assert.equal(Object.isFrozen(PROMOTION_BLOCK), true);
  assert.deepEqual(Object.keys(domain.QUEUE_STATE).sort(), ['AGUARDANDO_REVISAO', 'APROVADO_PARA_CRM', 'DADOS_INSUFICIENTES', 'DNC', 'DUPLICADO', 'EXPIRADO', 'REJEITADO']);
  assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS), ['AGUARDANDO_REVISAO'], 'só a revisão tem saída: nada mudou');
  const { queue, id } = filaComAprovado();
  comoRevisor('u1').recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivo: MOTIVO });
  assert.equal(queue.items[id].estado, QUEUE_STATE.APROVADO_PARA_CRM, 'o bloqueio nunca muda o estado');
  assert.throws(() => comoRevisor('u1').recordPromotionBlocked(queue, id, {}, { codigo: 'EXCLUSAO_INVENTADA', motivo: MOTIVO }), /código de bloqueio de promoção desconhecido/);
});

test('[EXCL-AUD-2] a MESMA recusa de exclusão, seguida e pela mesma pessoa, soma um contador em vez de abrir uma linha nova', () => {
  const { queue, id } = filaComAprovado();
  const registrar = comoRevisor('u1');
  const inicial = queue.items[id].historico.length;
  for (const codigo of [PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, PROMOTION_BLOCK.EXCLUSAO_AMBIGUA, PROMOTION_BLOCK.EXCLUSAO_NAO_VERIFICAVEL]) {
    for (let i = 0; i < 5; i += 1) registrar.recordPromotionBlocked(queue, id, {}, { codigo, motivo: `${MOTIVO} (${codigo})` });
  }
  const itens = bloqueios(queue.items[id]);
  assert.equal(itens.length, 3, 'uma linha por código');
  assert.equal(queue.items[id].historico.length, inicial + 3);
  for (const entrada of itens) {
    assert.equal(entrada.promocao.tentativas, 5);
    assert.ok(!Number.isNaN(Date.parse(entrada.promocao.ultimaTentativaEm)));
    assert.match(entrada.motivo, /\(5 tentativas\)$/);
    assert.equal(entrada.reviewedBy.userId, 'u1');
  }
});

test('[EXCL-AUD-3] outra pessoa, outro código, outro motivo, outro registro do CRM ou uma linha de outro tipo no meio abrem uma linha própria', () => {
  const { queue, id } = filaComAprovado();
  const base = { codigo: PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivo: MOTIVO };
  comoRevisor('u1').recordPromotionBlocked(queue, id, {}, base);
  comoRevisor('u2').recordPromotionBlocked(queue, id, {}, base); // outra pessoa
  comoRevisor('u2').recordPromotionBlocked(queue, id, {}, { ...base, motivo: `${MOTIVO} — outro texto` }); // outro motivo
  comoRevisor('u2').recordPromotionBlocked(queue, id, {}, { ...base, motivo: `${MOTIVO} — outro texto`, crmRecordId: 'crm:11111111-1111-4111-8111-111111111111' }); // outro registro
  comoRevisor('u2').recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.EXCLUSAO_AMBIGUA, motivo: `${MOTIVO} — outro texto`, crmRecordId: 'crm:11111111-1111-4111-8111-111111111111' }); // outro código
  assert.equal(bloqueios(queue.items[id]).length, 5);
  assert.ok(bloqueios(queue.items[id]).every((e) => e.promocao.tentativas === undefined));

  // um DNC no meio quebra a sequência: a mesma recusa de exclusão depois dele é uma linha nova
  comoRevisor('u2').recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.DNC, motivo: 'restrição de contato' });
  comoRevisor('u2').recordPromotionBlocked(queue, id, {}, { ...base, motivo: `${MOTIVO} — outro texto`, crmRecordId: 'crm:11111111-1111-4111-8111-111111111111' });
  assert.equal(bloqueios(queue.items[id]).length, 7);
});

test('[EXCL-AUD-4] os bloqueios que NÃO são de exclusão seguem como antes: DNC, duplicidade e dados insuficientes repetidos continuam uma linha por tentativa', () => {
  const { queue, id } = filaComAprovado();
  const registrar = comoRevisor('u1');
  for (const codigo of [PROMOTION_BLOCK.DNC, PROMOTION_BLOCK.DUPLICADO, PROMOTION_BLOCK.DADOS_INSUFICIENTES]) {
    for (let i = 0; i < 3; i += 1) registrar.recordPromotionBlocked(queue, id, {}, { codigo, motivo: 'mesmo motivo' });
  }
  assert.equal(bloqueios(queue.items[id]).length, 9);
  assert.ok(bloqueios(queue.items[id]).every((e) => e.promocao.tentativas === undefined && !/tentativas/.test(e.motivo)));
});

test('[EXCL-AUD-5] a soma sobrevive ao ciclo gravar/ler, tolera um contador corrompido no arquivo e não guarda nada além do código, do motivo e do contador (nenhum dado da exclusão)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exclusao-auditoria-'));
  try {
    const arquivo = path.join(dir, 'approval-queue.json');
    const { queue, id } = filaComAprovado();
    const registrar = comoRevisor('u1');
    for (let i = 0; i < 3; i += 1) registrar.recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivo: MOTIVO });
    domain.saveQueueToDisk(queue, arquivo);
    const lida = domain.loadQueueFromDisk(arquivo);
    comoRevisor('u1').recordPromotionBlocked(lida, id, {}, { codigo: PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivo: MOTIVO });
    assert.equal(bloqueios(lida.items[id]).length, 1);
    assert.equal(bloqueios(lida.items[id])[0].promocao.tentativas, 4);

    bloqueios(lida.items[id])[0].promocao.tentativas = 'lixo'; // arquivo adulterado
    comoRevisor('u1').recordPromotionBlocked(lida, id, {}, { codigo: PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivo: MOTIVO });
    assert.equal(bloqueios(lida.items[id])[0].promocao.tentativas, 2, 'um contador inválido vale 1 e segue');
    assert.deepEqual(Object.keys(bloqueios(lida.items[id])[0].promocao).sort(), ['codigo', 'crmRecordId', 'resultado', 'tentativas', 'ultimaTentativaEm']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('[EXCL-AUD-6] TETO: operadores que se ALTERNAM (a soma só vale para o mesmo operador em sequência) não fazem o histórico crescer uma linha por clique — passado o teto, a recusa idêntica soma na última linha igual, e nenhuma tentativa se perde', () => {
  assert.equal(domain.MAX_EXCLUSION_BLOCK_ENTRIES, 20, 'o teto documentado');
  const { queue, id } = filaComAprovado();
  const inicial = queue.items[id].historico.length;
  const base = { codigo: PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivo: MOTIVO };
  for (let i = 0; i < 100; i += 1) comoRevisor(i % 2 === 0 ? 'u1' : 'u2').recordPromotionBlocked(queue, id, {}, base);
  const itens = bloqueios(queue.items[id]);
  assert.equal(itens.length, domain.MAX_EXCLUSION_BLOCK_ENTRIES, 'no teto');
  assert.equal(queue.items[id].historico.length, inicial + domain.MAX_EXCLUSION_BLOCK_ENTRIES);
  assert.equal(itens.reduce((soma, e) => soma + (e.promocao.tentativas || 1), 0), 100, 'cada tentativa foi contada');
  assert.ok(itens.every((e) => e.reviewedBy && typeof e.reviewedBy.userId === 'string'), 'cada linha continua com quem a gerou');
  assert.equal(itens.some((e) => /tentativas\)$/.test(e.motivo)), true, 'o texto da linha acompanha o contador');
  assert.deepEqual(tentativasPorOperador(queue.items[id]), { u1: 50, u2: 50 }, 'e cada pessoa responde só pelas suas 50 tentativas');
});

test('[EXCL-AUD-7] TETO com códigos diferentes: passado o teto, cada operador abre UMA linha própria por código novo e as seguintes somam nela — o total é o teto mais (operadores × códigos novos) e cada pessoa responde só pelas suas tentativas de cada código', () => {
  const { queue, id } = filaComAprovado();
  const codigos = [PROMOTION_BLOCK.EXCLUSAO_AMBIGUA, PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, PROMOTION_BLOCK.EXCLUSAO_NAO_VERIFICAVEL];
  for (const codigo of codigos) {
    for (let i = 0; i < 40; i += 1) registrar(queue, id, i % 2 === 0 ? 'u1' : 'u2', codigo, `${MOTIVO} (${codigo})`);
  }
  const itens = bloqueios(queue.items[id]);
  assert.equal(itens.length, domain.MAX_EXCLUSION_BLOCK_ENTRIES + 2 * 2, 'o teto + 2 operadores × 2 códigos que chegaram depois do teto');
  for (const codigo of codigos) {
    assert.deepEqual(tentativasPorOperador(queue.items[id], (e) => e.promocao.codigo === codigo), { u1: 20, u2: 20 }, `${codigo}: 20 tentativas de cada pessoa`);
  }
  assert.equal(itens.reduce((soma, e) => soma + (e.promocao.tentativas || 1), 0), 120, 'nenhuma tentativa se perde');
  assert.equal(new Set(itens.map((e) => e.promocao.codigo)).size, 3, 'a ambígua nunca se mistura com a confirmada nem com a insuficiente');
});

test('[EXCL-AUD-8] o teto vale só para os bloqueios de exclusão: o DNC e os demais seguem uma linha por tentativa, mesmo com operadores alternados', () => {
  const { queue, id } = filaComAprovado();
  for (let i = 0; i < 30; i += 1) comoRevisor(i % 2 === 0 ? 'u1' : 'u2').recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.DNC, motivo: 'restrição de contato' });
  assert.equal(bloqueios(queue.items[id]).length, 30);
});

test('[EXCL-AUD-9] a auditoria não toca na aprovação humana nem no resto do item: depois de dezenas de bloqueios (com soma e teto), as linhas anteriores, o estado, o snapshot e a ausência de `promocao` são idênticos', () => {
  const { queue, id } = filaComAprovado();
  const antes = JSON.parse(JSON.stringify(queue.items[id]));
  const aprovacao = antes.historico.find((e) => e.to === 'APROVADO_PARA_CRM');
  assert.equal(aprovacao.actor, 'HUMAN');
  for (let i = 0; i < 60; i += 1) {
    const codigo = [PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, PROMOTION_BLOCK.EXCLUSAO_AMBIGUA, PROMOTION_BLOCK.EXCLUSAO_NAO_VERIFICAVEL][i % 3];
    comoRevisor(i % 2 === 0 ? 'u1' : 'u2').recordPromotionBlocked(queue, id, {}, { codigo, motivo: `${MOTIVO} (${codigo})` });
  }
  const depois = queue.items[id];
  assert.deepEqual(JSON.parse(JSON.stringify(depois.historico.slice(0, antes.historico.length))), antes.historico, 'as linhas anteriores (inclusive a aprovação) são idênticas');
  assert.equal(depois.estado, antes.estado);
  assert.deepEqual(JSON.parse(JSON.stringify(depois.discoverySnapshot)), antes.discoverySnapshot);
  assert.equal(depois.promocao, undefined);
  assert.equal(depois.empresa, antes.empresa);
  assert.equal(depois.criadoEm, antes.criadoEm);
});

test('[EXCL-AUD-10] o teto conta SÓ os bloqueios de exclusão: 25 linhas de DNC antes não fazem a recusa de exclusão de outro operador ser fundida — cada uma abre a sua linha até o teto próprio', () => {
  const { queue, id } = filaComAprovado();
  for (let i = 0; i < 25; i += 1) comoRevisor('u1').recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.DNC, motivo: 'restrição de contato' });
  for (let i = 0; i < 6; i += 1) comoRevisor(i % 2 === 0 ? 'u1' : 'u2').recordPromotionBlocked(queue, id, {}, { codigo: PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivo: MOTIVO });
  const exclusao = bloqueios(queue.items[id]).filter((e) => e.promocao.codigo === PROMOTION_BLOCK.EXCLUSAO_PERMANENTE);
  assert.equal(exclusao.length, 6, 'seis operadores alternados, seis linhas (abaixo do teto)');
  assert.equal(bloqueios(queue.items[id]).filter((e) => e.promocao.codigo === PROMOTION_BLOCK.DNC).length, 25);
});

test('[EXCL-AUD-11] AUTORIA — o cenário exato do defeito: 24 tentativas alternadas e mais 56 de um dos dois (80 no total) — o histórico atribui 12 a quem fez 12 e 68 a quem fez 68, e NUNCA o 10 / 70 de antes', () => {
  const { queue, id } = filaComAprovado();
  const feitas = { 'user-a': 0, 'user-b': 0 };
  const fazer = (quem) => {
    feitas[quem] += 1;
    registrar(queue, id, quem);
  };
  for (let i = 0; i < 24; i += 1) fazer(i % 2 === 0 ? 'user-a' : 'user-b');
  for (let i = 0; i < 56; i += 1) fazer('user-b');
  assert.deepEqual(feitas, { 'user-a': 12, 'user-b': 68 });

  const atribuido = tentativasPorOperador(queue.items[id]);
  assert.deepEqual(atribuido, { 'user-a': 12, 'user-b': 68 });
  assert.notDeepEqual(atribuido, { 'user-a': 10, 'user-b': 70 }, 'o resultado incorreto de antes não acontece mais');
  assert.equal(atribuido['user-a'] + atribuido['user-b'], 80, 'a quantidade total continua correta');
  assert.equal(bloqueios(queue.items[id]).length, 20, 'as duas pessoas já tinham linha: nenhuma linha nova depois do teto');

  // dados auditáveis preservados e nenhuma informação da exclusão
  for (const entrada of bloqueios(queue.items[id])) {
    const chaves = Object.keys(entrada.promocao).sort();
    assert.deepEqual(chaves, entrada.promocao.tentativas === undefined ? ['codigo', 'crmRecordId', 'resultado'] : ['codigo', 'crmRecordId', 'resultado', 'tentativas', 'ultimaTentativaEm']);
    assert.equal(entrada.actor, 'HUMAN');
    assert.match(entrada.reviewedBy.name, /^Revisor user-[ab]$/, 'quem é a pessoa vem do autorizador');
    assert.equal(semSufixo(entrada.motivo), `Promoção bloqueada: ${MOTIVO}`);
  }

  // IDEMPOTÊNCIA da soma: mais um clique de user-b muda UMA linha (contador, data da última tentativa e texto) e nada além disso
  const antes = JSON.parse(JSON.stringify(bloqueios(queue.items[id])));
  registrar(queue, id, 'user-b');
  const depois = bloqueios(queue.items[id]);
  assert.equal(depois.map((e, i) => JSON.stringify(e) !== JSON.stringify(antes[i])).filter(Boolean).length, 1, 'só uma linha mudou');
  assert.deepEqual(tentativasPorOperador(queue.items[id]), { 'user-a': 12, 'user-b': 69 });
});

test('[EXCL-AUD-12] TRÊS OU MAIS administradores: cada um responde só pelas suas tentativas, antes e depois do teto; quem chega depois do teto abre a sua própria linha (e só uma)', () => {
  const { queue, id } = filaComAprovado();
  const quatro = ['adm-1', 'adm-2', 'adm-3', 'adm-4'];
  for (let i = 0; i < 100; i += 1) registrar(queue, id, quatro[i % 4]);
  assert.deepEqual(tentativasPorOperador(queue.items[id]), { 'adm-1': 25, 'adm-2': 25, 'adm-3': 25, 'adm-4': 25 });
  assert.equal(bloqueios(queue.items[id]).length, 20);

  for (let i = 0; i < 10; i += 1) registrar(queue, id, 'adm-5'); // chega depois do teto
  assert.deepEqual(tentativasPorOperador(queue.items[id]), { 'adm-1': 25, 'adm-2': 25, 'adm-3': 25, 'adm-4': 25, 'adm-5': 10 });
  assert.equal(bloqueios(queue.items[id]).length, 21, 'uma linha própria para quem não tinha');
  assert.equal(bloqueios(queue.items[id]).at(-1).promocao.tentativas, 10);
  assert.equal(bloqueios(queue.items[id]).at(-1).reviewedBy.userId, 'adm-5');
});

test('[EXCL-AUD-13] o MESMO administrador com MOTIVOS diferentes: nunca se somam entre si — a contagem de cada motivo é exata, antes e depois do teto', () => {
  const { queue, id } = filaComAprovado();
  const motivos = [`${MOTIVO} — texto A`, `${MOTIVO} — texto B`];
  for (let i = 0; i < 60; i += 1) registrar(queue, id, 'adm-1', PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, motivos[i % 2]);
  const porMotivo = {};
  for (const entrada of bloqueios(queue.items[id])) {
    const chave = semSufixo(entrada.motivo);
    porMotivo[chave] = (porMotivo[chave] || 0) + (entrada.promocao.tentativas || 1);
  }
  assert.deepEqual(porMotivo, { [`Promoção bloqueada: ${motivos[0]}`]: 30, [`Promoção bloqueada: ${motivos[1]}`]: 30 });
  assert.equal(bloqueios(queue.items[id]).length, 20);
});

test('[EXCL-AUD-14] CÓDIGOS × OPERADORES depois do teto: cada par (pessoa, código) responde exatamente pelas suas tentativas e o total de linhas respeita teto + pessoas × códigos', () => {
  const { queue, id } = filaComAprovado();
  const pessoas = ['adm-1', 'adm-2'];
  const codigos = [PROMOTION_BLOCK.EXCLUSAO_PERMANENTE, PROMOTION_BLOCK.EXCLUSAO_AMBIGUA, PROMOTION_BLOCK.EXCLUSAO_NAO_VERIFICAVEL];
  const combinacoes = pessoas.flatMap((p) => codigos.map((c) => [p, c]));
  for (let volta = 0; volta < 10; volta += 1) for (const [p, c] of combinacoes) registrar(queue, id, p, c, `${MOTIVO} (${c})`);
  for (const [p, c] of combinacoes) {
    assert.equal(tentativasPorOperador(queue.items[id], (e) => e.promocao.codigo === c)[p], 10, `${p} / ${c}`);
  }
  assert.equal(bloqueios(queue.items[id]).reduce((soma, e) => soma + (e.promocao.tentativas || 1), 0), 60);
  assert.ok(bloqueios(queue.items[id]).length <= domain.MAX_EXCLUSION_BLOCK_ENTRIES + pessoas.length * codigos.length, `${bloqueios(queue.items[id]).length} linhas`);
});

test('[EXCL-AUD-15] CRESCIMENTO CONTROLADO, e honesto: o limite real do histórico é o teto mais UMA linha por (pessoa, código) que chega depois dele — depende da quantidade de operadores, não é um teto global rígido', () => {
  const { queue, id } = filaComAprovado();
  for (let i = 0; i < 20; i += 1) registrar(queue, id, i % 2 === 0 ? 'adm-1' : 'adm-2'); // atinge o teto
  assert.equal(bloqueios(queue.items[id]).length, domain.MAX_EXCLUSION_BLOCK_ENTRIES);
  const novos = ['adm-3', 'adm-4', 'adm-5', 'adm-6', 'adm-7', 'adm-8'];
  for (const pessoa of novos) for (let i = 0; i < 5; i += 1) registrar(queue, id, pessoa);
  assert.equal(bloqueios(queue.items[id]).length, domain.MAX_EXCLUSION_BLOCK_ENTRIES + novos.length, 'seis pessoas novas, seis linhas — e não trinta');
  for (const pessoa of novos) assert.equal(tentativasPorOperador(queue.items[id])[pessoa], 5, pessoa);
  for (let i = 0; i < 200; i += 1) registrar(queue, id, novos[i % novos.length]); // muitas tentativas depois não criam linha nenhuma
  assert.equal(bloqueios(queue.items[id]).length, domain.MAX_EXCLUSION_BLOCK_ENTRIES + novos.length);
});

test('[EXCL-AUD-16] DNC e decisões humanas intactos pelo agrupamento por operador: o DNC segue uma linha por tentativa e a aprovação original é idêntica depois de tudo', () => {
  const { queue, id } = filaComAprovado();
  const antes = JSON.parse(JSON.stringify(queue.items[id]));
  for (let i = 0; i < 30; i += 1) registrar(queue, id, i % 2 === 0 ? 'adm-1' : 'adm-2', PROMOTION_BLOCK.DNC, 'restrição de contato');
  for (let i = 0; i < 50; i += 1) registrar(queue, id, ['adm-1', 'adm-2', 'adm-3'][i % 3]);
  const dnc = bloqueios(queue.items[id]).filter((e) => e.promocao.codigo === PROMOTION_BLOCK.DNC);
  assert.equal(dnc.length, 30);
  assert.ok(dnc.every((e) => e.promocao.tentativas === undefined));
  assert.deepEqual(JSON.parse(JSON.stringify(queue.items[id].historico.slice(0, antes.historico.length))), antes.historico);
  assert.equal(queue.items[id].estado, antes.estado);
  assert.equal(queue.items[id].promocao, undefined);
});
