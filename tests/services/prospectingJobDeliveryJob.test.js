// Implementação 2.2.1 — a métrica de ENTREGA POR JOB: `naFila` conta só o lead que ESTE job entregou à Approval Queue. O pipeline marca `naFila` também para um prospect
// que JÁ estava na fila (`jaExistiaNaFila`, de outro job; ainda aguardando, já aprovado ou já rejeitado): isso segue verdadeiro e auditável, mas NÃO é uma nova entrega do job.
// Peças REAIS e FAKES: ver tests/helpers/jobFixtures.js (nenhuma rede, nenhum `claude`).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const { JOB_STATUS } = require('../../src/research-prospector/prospectingJob');
const { admin } = require('../helpers/promotionFixtures');
const { siteDe, paginaBoa, paginaTerceiro, candidato, motorFake, ambiente, iniciar, paginasBoas } = require('../helpers/jobFixtures');

const DIRETORIO = 'https://www.guiamais.com.br/petropolis-rj/clinica-eps';
const TEXTO_EPS = 'Clínica Eps — clínica de estética e harmonização facial. Rua das Flores, 10 - Petrópolis - RJ';

const alfa = () => candidato('Clínica Alfa', 'alfa');
const beta = () => candidato('Clínica Beta', 'beta');
const gama = () => candidato('Clínica Gama', 'gama');

// Um motor cujas rodadas podem ser trocadas entre um job e outro (o mesmo ambiente, a mesma fila, vários jobs).
function motorTrocavel() {
  const ref = { atual: motorFake({ rodadas: [] }) };
  return { ref, discover: (pedido) => ref.atual.discover(pedido) };
}
const rodadas = (...lista) => motorFake({ rodadas: lista.map((candidatos) => ({ candidatos })) });

async function rodarJob(env, motor, motorDoJob, quantidade) {
  motor.ref.atual = motorDoJob;
  const { job } = await iniciar(env, { quantidade });
  const fim = await env.servico.waitFor(job.id);
  return { fim, porNome: Object.fromEntries(fim.candidatos.map((c) => [c.nome, c])) };
}

const filaDe = (env) => createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: path.join(env.dir, 'approval-queue.json') });
const idsDoLote = (env, fim) => env.prospectingService.getBatch(admin(), fim.lote.loteId).prospectIds;
const novoEnv = (t, motor, paginas = paginasBoas()) => ambiente(t, { motor, paginas });

// o job A entrega a Alfa à fila; devolve o prospectId dela
async function entregarAlfaAntes(env, motor) {
  const { fim } = await rodarJob(env, motor, rodadas([alfa()], []), 1);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  return idsDoLote(env, fim)[0];
}

test('[DELIVERY-JOB-1] lead NOVO que entra na Approval Queue: conta para naFila e para delivered, e pode levar o job a CONCLUIDO', async (t) => {
  const motor = motorTrocavel();
  const env = novoEnv(t, motor);
  const { fim, porNome } = await rodarJob(env, motor, rodadas([alfa()], []), 1);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual([fim.lote.naFila, fim.leadsNaFila, fim.lote.validadosPeloMotor, fim.lote.foraDaFila, fim.lote.jaEstavamNaFila], [1, 1, 1, 0, 0]);
  assert.deepEqual(porNome['Clínica Alfa'].entrega, { naFila: true, estadoOperacional: 'AGUARDANDO_REVISAO' });
  assert.equal('jaExistiaNaFila' in porNome['Clínica Alfa'].entrega, false);
});

test('[DELIVERY-JOB-2] lead que JÁ estava na fila antes do job: jaExistiaNaFila continua auditável, mas NÃO conta para naFila, NÃO incrementa delivered e NÃO leva sozinho a CONCLUIDO', async (t) => {
  const motor = motorTrocavel();
  const env = novoEnv(t, motor);
  const idAntigo = await entregarAlfaAntes(env, motor);

  const { fim, porNome } = await rodarJob(env, motor, rodadas([alfa()], []), 1);
  assert.equal(fim.status, JOB_STATUS.PARCIAL, 'o job B não entregou nada de novo');
  assert.deepEqual([fim.lote.naFila, fim.leadsNaFila], [0, 0]);
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.foraDaFila, fim.lote.jaEstavamNaFila], [1, 1, 1]);
  assert.deepEqual(porNome['Clínica Alfa'].entrega, { naFila: false, jaExistiaNaFila: true, estadoOperacional: 'AGUARDANDO_REVISAO' }, 'a informação do pipeline não foi apagada');
  assert.equal(porNome['Clínica Alfa'].resultado, 'VALIDADO', 'o validado continua nos resultados');
  // o pipeline segue dizendo a verdade: o lote dele marca o prospect como naFila + jaExistiaNaFila (a semântica da deduplicação não mudou)
  const lote = env.prospectingService.getBatch(admin(), fim.lote.loteId);
  assert.deepEqual(lote.resultados.map((r) => [r.naFila, r.jaExistiaNaFila]), [[true, true]]);
  assert.deepEqual(lote.prospectIds, [idAntigo], 'o prospectId é o mesmo da fila: nada novo foi criado');
  assert.equal(fim.telemetria.limitReached, 'SEM_CANDIDATOS_NOVOS');
});

test('[DELIVERY-JOB-3] lead antigo na fila + 1 lead novo, meta 1: o antigo não conta, o novo conta, e o CONCLUIDO é só por causa do novo', async (t) => {
  const motor = motorTrocavel();
  const env = novoEnv(t, motor);
  await entregarAlfaAntes(env, motor);
  const antes = env.ingestoes.length;
  const { fim, porNome } = await rodarJob(env, motor, rodadas([alfa(), beta()]), 1);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(fim.lote.naFila, 1);
  assert.equal(porNome['Clínica Alfa'].entrega.naFila, false);
  assert.equal(porNome['Clínica Alfa'].entrega.jaExistiaNaFila, true);
  assert.equal(porNome['Clínica Beta'].entrega.naFila, true);
  assert.deepEqual(env.ingestoes.slice(antes), [1, 1], 'a Alfa (antiga) foi a 1ª ingestão e não bastou; a Beta fechou a meta');
  assert.equal(fim.lote.jaEstavamNaFila, 1);
});

test('[DELIVERY-JOB-4] lead já existente e já REJEITADO na fila: não conta como entrega do job (a decisão anterior nunca é sobrescrita)', async (t) => {
  const motor = motorTrocavel();
  const env = novoEnv(t, motor);
  const id = await entregarAlfaAntes(env, motor);
  filaDe(env).rejectProspect(admin(), id, { reason: 'sem fit' });

  const { fim, porNome } = await rodarJob(env, motor, rodadas([alfa()], []), 1);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.lote.naFila, 0);
  assert.equal(porNome['Clínica Alfa'].entrega.jaExistiaNaFila, true);
  const lote = env.prospectingService.getBatch(admin(), fim.lote.loteId);
  assert.equal(lote.resultados[0].estadoFila, 'REJEITADO', 'continua rejeitada: a fila não foi sobrescrita');
});

test('[DELIVERY-JOB-5] lead já existente e já APROVADO na fila: não conta como entrega do job, e nada é promovido ao CRM', async (t) => {
  const motor = motorTrocavel();
  const env = novoEnv(t, motor);
  const id = await entregarAlfaAntes(env, motor);
  filaDe(env).approveProspect(admin(), id, { reason: 'ok' });

  const { fim, porNome } = await rodarJob(env, motor, rodadas([alfa()], []), 1);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.lote.naFila, 0);
  assert.equal(porNome['Clínica Alfa'].entrega.jaExistiaNaFila, true);
  const lote = env.prospectingService.getBatch(admin(), fim.lote.loteId);
  assert.equal(lote.resultados[0].estadoFila, 'APROVADO_PARA_CRM');
  assert.equal((await env.crmService.listRecords(admin(), {})).length, 0, 'a aprovação não promove sozinha');
});

test('[DELIVERY-JOB-6] REPOSIÇÃO: o 1º lote encontra um lead já existente, a reposição encontra um novo — só o novo conta para a meta', async (t) => {
  const motor = motorTrocavel();
  const env = novoEnv(t, motor);
  await entregarAlfaAntes(env, motor);
  const antes = env.ingestoes.length;
  const { fim, porNome } = await rodarJob(env, motor, rodadas([alfa(), beta()], [gama()]), 2);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(fim.lote.naFila, 2, 'Beta (1ª rodada) + Gama (reposição); a Alfa antiga não conta');
  assert.deepEqual(env.ingestoes.slice(antes), [2, 1]);
  assert.deepEqual([porNome['Clínica Alfa'].entrega.naFila, porNome['Clínica Beta'].entrega.naFila, porNome['Clínica Gama'].entrega.naFila], [false, true, true]);
  assert.deepEqual([fim.telemetria.ciclosReposicao, fim.telemetria.reposicoesNecessarias, fim.telemetria.reposicoesRealizadas], [1, 1, 1]);
  assert.equal(fim.lote.jaEstavamNaFila, 1);
});

test('[DELIVERY-JOB-7] prospectIds agregado sem duplicatas: o conjunto do job tem só entregas deste job, mesmo quando os lotes do pipeline repetem um prospect já existente', async (t) => {
  const motor = motorTrocavel();
  const env = novoEnv(t, motor);
  const idAntigo = await entregarAlfaAntes(env, motor);
  const { fim } = await rodarJob(env, motor, rodadas([alfa(), beta()], [gama()]), 2);
  const idsDoPipeline = fim.lote.lotes.flatMap((loteId) => env.prospectingService.getBatch(admin(), loteId).prospectIds);
  assert.ok(idsDoPipeline.includes(idAntigo), 'o pipeline continua dizendo que a Alfa antiga está na fila (semântica da deduplicação intacta)');
  assert.equal(new Set(idsDoPipeline).size, idsDoPipeline.length, 'nenhum prospectId repetido entre os lotes do job');
  assert.equal(fim.lote.naFila, idsDoPipeline.length - 1, 'o job conta as entregas dele: o antigo sai da conta');
});

test('[DELIVERY-JOB-8] regressão da 2.1: lead NOVO conta (inclusive sem site); DNC e DUPLICADO não contam; foraDaFila segue auditável', async (t) => {
  const motor = motorTrocavel();
  const paginas = { ...paginasBoas(), [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_EPS }), [siteDe('zeta')]: paginaBoa('Clínica Zeta', 'zeta') };
  const env = novoEnv(t, motor, paginas);
  const registro = (await env.crmService.createRecord(admin(), { empresa: 'Beta antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('beta') })).record;
  await env.crmService.markDoNotContact(admin(), registro.id, { reason: 'pediu para não ser contatado' }); // Beta = DNC
  await env.crmService.createRecord(admin(), { empresa: 'Delta antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('delta') }); // Delta = DUPLICADO
  const eps = candidato('Clínica Eps', 'eps', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] }); // Eps = sem site: entra normalmente
  const { fim, porNome } = await rodarJob(env, motor, rodadas([gama(), beta(), candidato('Clínica Delta', 'delta'), eps], []), 4);

  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [4, 2, 2]);
  assert.equal(porNome['Clínica Gama'].entrega.naFila, true);
  assert.deepEqual([porNome['Clínica Beta'].entrega.naFila, porNome['Clínica Beta'].entrega.estadoOperacional], [false, 'DNC']);
  assert.deepEqual([porNome['Clínica Delta'].entrega.naFila, porNome['Clínica Delta'].entrega.estadoOperacional], [false, 'DUPLICADO']);
  assert.equal(porNome['Clínica Eps'].entrega.naFila, true, 'a ausência de site não retém o lead');
  for (const nome of ['Clínica Beta', 'Clínica Delta']) assert.equal('jaExistiaNaFila' in porNome[nome].entrega, false, `${nome} não "já estava na fila": foi retido pelo pipeline`);
  assert.equal(fim.lote.jaEstavamNaFila, 0);
});
