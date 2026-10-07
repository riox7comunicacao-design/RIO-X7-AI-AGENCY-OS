// Implementação 2.1 — a CONCLUSÃO COMERCIAL do job: a meta é de leads que CHEGARAM à Approval Queue, medidos pelo resultado REAL do pipeline de ingestão.
// VALIDADO pelo motor (empresa + nicho + localização comprovados) NÃO significa entregue à fila. Peças REAIS e FAKES: ver tests/helpers/jobFixtures.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { JOB_STATUS, CANDIDATE_RESULT, STOP_REASON } = require('../../src/research-prospector/prospectingJob');
const { admin } = require('../helpers/promotionFixtures');
const { siteDe, paginaTerceiro, candidato, motorFake, ambiente, iniciar, tresBons, paginasBoas } = require('../helpers/jobFixtures');

const DIRETORIO = 'https://www.guiamais.com.br/petropolis-rj/clinica-delta';
const TEXTO_DELTA = 'Clínica Delta — clínica de estética e harmonização facial. Rua das Flores, 10 - Petrópolis - RJ';

// o CRM real já tem estes sites em DO_NOT_CONTACT (o pipeline oficial os retém como DNC)
async function marcarDnc(env, slugs) {
  for (const slug of slugs) {
    const registro = (await env.crmService.createRecord(admin(), { empresa: `${slug} antiga`, cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe(slug) })).record;
    await env.crmService.markDoNotContact(admin(), registro.id, { reason: 'pediu para não ser contatado' });
  }
}

async function rodar(env, quantidade = 3, { lerLote = true } = {}) {
  const { brief, job } = await iniciar(env, { quantidade });
  const fim = await env.servico.waitFor(job.id);
  const lote = fim.lote && lerLote ? env.prospectingService.getBatch(admin(), (await env.briefService.getBrief(admin(), brief.id)).loteRealId) : null;
  return { fim, lote, porNome: Object.fromEntries(fim.candidatos.map((c) => [c.nome, c])) };
}

const novoEnv = (t, candidatos, paginas = paginasBoas()) => ambiente(t, { motor: motorFake({ rodadas: [{ candidatos }, { candidatos: [] }] }), paginas });

test('[ENTREGA-a] 3 validados pelo motor -> 3 na Approval Queue -> CONCLUIDO', async (t) => {
  const env = novoEnv(t, tresBons());
  const { fim, lote, porNome } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [3, 3, 0]);
  assert.equal(fim.candidatesValidated, 3);
  for (const nome of ['Clínica Alfa', 'Clínica Beta', 'Clínica Gama']) assert.equal(porNome[nome].entrega.naFila, true, nome);
  assert.equal(lote.resultados.filter((r) => r.naFila).length, 3, 'a fila real tem exatamente os 3');
  assert.equal(fim.telemetria.limitReached, null);
});

test('[ENTREGA-b] 3 validados pelo motor -> 2 na Approval Queue -> PARCIAL (o terceiro é retido pelo pipeline como DNC)', async (t) => {
  const env = novoEnv(t, tresBons());
  await marcarDnc(env, ['alfa']);
  const { fim, lote, porNome } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.PARCIAL, 'CONCLUIDO nunca depende só do veredito do motor');
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [3, 2, 1]);
  assert.equal(fim.candidatesValidated, 3, 'continuam 3 validados pelo motor');
  assert.equal(porNome['Clínica Alfa'].resultado, CANDIDATE_RESULT.VALIDADO, 'o validado retido NÃO é descartado: segue nos resultados');
  assert.deepEqual(porNome['Clínica Alfa'].entrega, { naFila: false, estadoOperacional: 'DNC', motivo: 'DNC' }, 'com o estado REAL do pipeline');
  assert.equal(porNome['Clínica Beta'].entrega.naFila, true);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.SEM_CANDIDATOS_NOVOS, 'a reposição tentou e o motor não trouxe candidatos novos');
  assert.equal(lote.resultados.filter((r) => r.naFila).length, 2);
});

test('[ENTREGA-c] 3 validados pelo motor -> 0 na Approval Queue -> PARCIAL (e não ERRO: o job funcionou)', async (t) => {
  const env = novoEnv(t, tresBons());
  await marcarDnc(env, ['alfa', 'beta', 'gama']);
  const { fim, lote, porNome } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.error, null, 'ERRO é só falha operacional do job');
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [3, 0, 3]);
  assert.equal(fim.candidatesValidated, 3);
  for (const nome of ['Clínica Alfa', 'Clínica Beta', 'Clínica Gama']) {
    assert.equal(porNome[nome].resultado, CANDIDATE_RESULT.VALIDADO, nome);
    assert.deepEqual([porNome[nome].entrega.naFila, porNome[nome].entrega.estadoOperacional], [false, 'DNC'], nome);
  }
  assert.equal(lote.resultados.filter((r) => r.naFila).length, 0);
  assert.equal((await env.crmService.listRecords(admin(), {})).length, 3, 'só os 3 registros que já existiam (os DNC): nada promovido');
});

test('[ENTREGA-d] lead VALIDADO pelo motor que termina DADOS_INSUFICIENTES NÃO conta para a meta; duplicado também não', async (t) => {
  // a Delta é comprovada por um diretório, mas sem site nem canal o pipeline a retém como DADOS_INSUFICIENTES
  const delta = candidato('Clínica Delta', 'delta', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] });
  const env = novoEnv(t, [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), delta], { ...paginasBoas(), [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_DELTA }) });
  const { fim, porNome } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [3, 2, 1]);
  assert.equal(porNome['Clínica Delta'].resultado, CANDIDATE_RESULT.VALIDADO);
  assert.deepEqual(porNome['Clínica Delta'].entrega, { naFila: false, estadoOperacional: 'DADOS_INSUFICIENTES', motivo: 'DADOS_INSUFICIENTES' });

  // duplicado do CRM (mesmo site, PROSPECT): também fora da fila
  const dup = novoEnv(t, tresBons());
  await dup.crmService.createRecord(admin(), { empresa: 'Gama Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('gama') });
  const r = await rodar(dup);
  assert.equal(r.fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual([r.porNome['Clínica Gama'].entrega.naFila, r.porNome['Clínica Gama'].entrega.estadoOperacional], [false, 'DUPLICADO']);
  assert.equal(r.fim.lote.naFila, 2);
});

test('[ENTREGA-e] lead VALIDADO que ENTRA na Approval Queue conta para a meta — e conta UMA única vez', async (t) => {
  const env = novoEnv(t, [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Alfa', 'alfa'), ...tresBons().slice(1)]);
  const { fim, lote } = await rodar(env, 3);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(fim.lote.naFila, 3, 'o repetido (mesmo nome e site) não foi contado duas vezes');
  assert.equal(new Set(lote.prospectIds).size, lote.prospectIds.length, 'cada lead entrou na fila uma só vez');
  assert.equal(fim.lote.naFila, lote.prospectIds.length);
  assert.deepEqual(env.ingestoes, [3]);

  const um = novoEnv(t, [candidato('Clínica Alfa', 'alfa')]);
  const r = await rodar(um, 1);
  assert.equal(r.fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(r.fim.lote.naFila, 1);
  assert.deepEqual(r.porNome['Clínica Alfa'].entrega, { naFila: true, estadoOperacional: 'AGUARDANDO_REVISAO' });
});

test('[ENTREGA-f] regressão: a conclusão usa o resultado REAL do pipeline — nunca o veredito do motor; o pipeline, a fila, o CRM e os estados continuam como eram', async (t) => {
  // um Brief Service que "ingere" mas devolve uma fila vazia: o job NÃO pode concluir só porque o motor validou 3
  const vazio = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }),
    paginas: paginasBoas(),
    briefService: (real) => ({ getBrief: real.getBrief, markResearching: real.markResearching, ingestReplacementFindings: async () => ({}), ingestFindings: async () => ({ brief: {}, lote: { loteId: 'lote:00000000-0000-4000-8000-000000000000', contagens: { validos: 0 }, prospectIds: [], resultados: [] }, excluidosPermanentemente: 0 }) }),
  });
  const a = await rodar(vazio, 3, { lerLote: false });
  assert.equal(a.fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual([a.fim.candidatesValidated, a.fim.lote.naFila], [3, 0]);
  // uma resposta sem lote algum: também não é entrega
  const semLote = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }),
    paginas: paginasBoas(),
    briefService: (real) => ({ getBrief: real.getBrief, markResearching: real.markResearching, ingestReplacementFindings: async () => ({}), ingestFindings: async () => ({}) }),
  });
  const b = await rodar(semLote, 3, { lerLote: false });
  assert.equal(b.fim.status, JOB_STATUS.PARCIAL);
  assert.equal(b.fim.lote.naFila, 0);

  // o pipeline real: DNC, duplicado e fila seguem decidindo; nada é promovido ao CRM; a ingestão é uma só
  const env = novoEnv(t, tresBons());
  await marcarDnc(env, ['alfa']);
  await env.crmService.createRecord(admin(), { empresa: 'Beta Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('beta') });
  const { fim, lote } = await rodar(env);
  const estados = Object.fromEntries(lote.resultados.map((r) => [r.empresa, r.estadoOperacional]));
  assert.deepEqual([estados['Clínica Alfa'], estados['Clínica Beta']], ['DNC', 'DUPLICADO']);
  assert.deepEqual(lote.resultados.filter((r) => r.naFila).map((r) => r.empresa), ['Clínica Gama']);
  assert.equal(fim.lote.naFila, 1);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual(env.ingestoes, [3]);
  assert.equal((await env.crmService.listRecords(admin(), {})).length, 2, 'nenhuma promoção automática');
  assert.deepEqual(fim.lote.contagens.quantidadeDesejada, 3);
});
