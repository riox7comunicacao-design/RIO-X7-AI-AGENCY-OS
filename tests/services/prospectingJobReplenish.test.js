// Implementação 2.2 — REPOSIÇÃO ADAPTATIVA: quando parte dos candidatos não chega à Approval Queue, o job descobre candidatos NOVOS para tentar completar a meta
// (lote.naFila >= quantidade), pela MESMA cadeia de ingestão, dentro dos limites GLOBAIS (6 ciclos, 40 candidatos, 15 minutos). Peças REAIS e FAKES: ver
// tests/helpers/jobFixtures.js (nenhuma rede, nenhum `claude`).

const test = require('node:test');
const assert = require('node:assert/strict');

const { JOB_STATUS, CANDIDATE_RESULT, STOP_REASON } = require('../../src/research-prospector/prospectingJob');
const { admin } = require('../helpers/promotionFixtures');
const { AGORA, siteDe, paginaBoa, paginaTerceiro, candidato, motorFake, ambiente, iniciar, tresBons, paginasBoas } = require('../helpers/jobFixtures');

const DIRETORIO = 'https://www.guiamais.com.br/petropolis-rj/clinica-eps';
const TEXTO_EPS = 'Clínica Eps — clínica de estética e harmonização facial. Rua das Flores, 10 - Petrópolis - RJ';

const delta = () => candidato('Clínica Delta', 'delta');
const unicos = (prefixo, quantidade, inicio = 0) => Array.from({ length: quantidade }, (_, i) => candidato(`Clínica ${prefixo}${inicio + i}`, `${prefixo.toLowerCase()}${inicio + i}`));

async function marcarDnc(env, slugs) {
  for (const slug of slugs) {
    const registro = (await env.crmService.createRecord(admin(), { empresa: `${slug} antiga`, cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe(slug) })).record;
    await env.crmService.markDoNotContact(admin(), registro.id, { reason: 'pediu para não ser contatado' });
  }
}

const rodadasDe = (...rodadas) => motorFake({ rodadas: rodadas.map((candidatos) => ({ candidatos })) });
const codigos = (fim) => fim.telemetria.eventos.map((e) => e.codigo);

async function rodar(env, quantidade = 3) {
  const { brief, job } = await iniciar(env, { quantidade });
  const fim = await env.servico.waitFor(job.id);
  return { brief, fim, porNome: Object.fromEntries(fim.candidatos.map((c) => [c.nome, c])) };
}

test('[REPLENISH-1] meta 3; a 1ª rodada entrega 2 na fila; a reposição entrega 1 -> CONCLUIDO (pela MESMA cadeia, com a entrega medida de novo)', async (t) => {
  const motor = rodadasDe(tresBons(), [delta()]);
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  await marcarDnc(env, ['alfa']);
  const { brief, fim } = await rodar(env);

  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [4, 3, 1]);
  assert.equal(fim.leadsNaFila, 3);
  assert.deepEqual(env.ingestoes, [3, 1], 'a 1ª ingestão e a de reposição');
  assert.deepEqual(motor.pedidos.map((p) => p.limit), [9, 6], 'faltam 1 -> clamp(1 x 3, 6, 12) = 6');
  assert.deepEqual([fim.telemetria.ciclosExecutados, fim.telemetria.ciclosReposicao, fim.telemetria.reposicoesNecessarias, fim.telemetria.reposicoesRealizadas], [2, 1, 1, 1]);
  assert.deepEqual(codigos(fim), ['REPOSICAO_INICIADA', 'REPOSICAO_CONCLUIDA', 'META_ATINGIDA']);
  assert.equal(fim.telemetria.limitReached, null);
  assert.equal(fim.lote.lotes.length, 2);
  // o brief: a 1ª ingestão o levou a AGUARDANDO_REVISAO; o lote da reposição só foi ACRESCENTADO
  const depois = await env.briefService.getBrief(admin(), brief.id);
  assert.equal(depois.status, 'AGUARDANDO_REVISAO');
  assert.equal(depois.loteRealId, fim.lote.lotes[0]);
  assert.deepEqual(depois.lotesAdicionais, [fim.lote.lotes[1]]);
  assert.equal((await env.crmService.listRecords(admin(), {})).length, 1, 'só o registro DNC que já existia: nada promovido');
});

test('[REPLENISH-2] meta 3; a 1ª rodada entrega 2; a reposição entrega 0 (o novo candidato também é DNC) -> PARCIAL', async (t) => {
  const motor = rodadasDe(tresBons(), [delta()], []);
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  await marcarDnc(env, ['alfa', 'delta']);
  const { fim, porNome } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [4, 2, 2]);
  assert.deepEqual(porNome['Clínica Delta'].entrega, { naFila: false, estadoOperacional: 'DNC', motivo: 'DNC' });
  assert.equal(porNome['Clínica Delta'].resultado, CANDIDATE_RESULT.VALIDADO, 'o validado retido continua nos resultados');
  assert.equal(fim.telemetria.limitReached, STOP_REASON.SEM_CANDIDATOS_NOVOS);
  assert.equal(fim.telemetria.reposicoesNecessarias, 2);
});

test('[REPLENISH-3] a reposição só encontra um candidato JÁ CONHECIDO -> nenhum candidato novo -> PARCIAL, sem reprocessar e sem repetir a chamada', async (t) => {
  const motor = rodadasDe(tresBons(), [candidato('Clínica Alfa', 'alfa')], unicos('Z', 5));
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  await marcarDnc(env, ['alfa']);
  const { fim } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(motor.pedidos.length, 2, 'a rodada sem candidatos novos encerra: nenhuma 3ª chamada idêntica');
  assert.deepEqual(env.ingestoes, [3], 'nada voltou à ingestão');
  assert.equal(env.paginasChamadas.filter((url) => url === siteDe('alfa')).length, 1, 'a Alfa (DNC, conhecida) não foi lida de novo');
  assert.deepEqual([fim.telemetria.candidatosNovos, fim.telemetria.candidatosRepetidos, fim.telemetria.candidatosDescobertos], [3, 1, 4]);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.SEM_CANDIDATOS_NOVOS);
  assert.ok(codigos(fim).includes('REPOSICAO_SEM_CANDIDATOS_NOVOS'));
  assert.equal(codigos(fim).includes('META_ATINGIDA'), false);
  assert.equal(fim.candidatesDiscovered, 3, 'o conhecido não virou um 4º candidato');
});

test('[REPLENISH-4] a reposição devolve 3 candidatos: 2 conhecidos e 1 novo -> só o novo é processado', async (t) => {
  const motor = rodadasDe(tresBons(), [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), delta()]);
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  await marcarDnc(env, ['alfa']);
  const { fim } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual(env.ingestoes, [3, 1], 'só a Delta foi para a reposição');
  assert.deepEqual([fim.telemetria.candidatosNovos, fim.telemetria.candidatosRepetidos], [4, 2]);
  for (const slug of ['alfa', 'beta', 'gama', 'delta']) assert.equal(env.paginasChamadas.filter((url) => url === siteDe(slug)).length, 1, `${slug} lida uma única vez`);
  assert.equal(fim.candidatesDiscovered, 4);
});

test('[REPLENISH-5] a meta é atingida antes do próximo ciclo: nenhuma nova descoberta é feita', async (t) => {
  const motor = rodadasDe(tresBons(), [delta()]);
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { fim } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(motor.pedidos.length, 1);
  assert.deepEqual(env.ingestoes, [3]);
  assert.deepEqual([fim.telemetria.ciclosReposicao, fim.telemetria.reposicoesNecessarias, fim.telemetria.reposicoesRealizadas], [0, 0, 0]);
  assert.deepEqual(codigos(fim), ['META_ATINGIDA']);
});

test('[REPLENISH-6] o job chega a 50 candidatos sem atingir a meta: PARCIAL, e nenhum candidato 51 é processado (o último ciclo só pede o que cabe)', async (t) => {
  let n = 0;
  const motor = motorFake({ porPedido: (indice, pedido) => (indice === 1 ? { candidatos: [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), ...unicos('Q', 10)] } : { candidatos: unicos('R', 80).slice(n, (n += pedido.limit)) }) });
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { fim } = await rodar(env, 10);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual(motor.pedidos.map((p) => p.limit), [12, 12, 12, 12, 2], 'faltam 8 -> clamp(24, 6, 12) = 12; o último cabe 2');
  assert.equal(fim.candidatesDiscovered, 50);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.CANDIDATOS);
  assert.equal(env.paginasChamadas.filter((url) => /^https:\/\/[a-z0-9]+\.com\.br\/$/.test(url)).length, 50, 'exatamente 50 sites lidos: o 51º nunca existiu');
  assert.equal(fim.lote.naFila, 2);
});

test('[REPLENISH-7] o job chega ao SEXTO ciclo sem atingir a meta: PARCIAL, e nenhum sétimo ciclo (os 6 ciclos são TOTAIS: busca inicial + reposição)', async (t) => {
  let n = 0;
  const motor = motorFake({ porPedido: (indice, pedido) => (indice === 1 ? { candidatos: [candidato('Clínica Alfa', 'alfa'), ...unicos('S', 2)] } : { candidatos: unicos('T', 80).slice(n, (n += pedido.limit)) }) });
  const env = ambiente(t, { motor, paginas: paginasBoas(), limits: { batchMin: 3, batchMax: 3 } });
  const { fim } = await rodar(env, 3);
  assert.equal(motor.pedidos.length, 6);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.CICLOS);
  assert.deepEqual([fim.telemetria.ciclosExecutados, fim.telemetria.ciclosReposicao], [6, 5], '6 ciclos no TOTAL; 5 deles depois da 1ª ingestão');
  assert.equal(fim.lote.naFila, 1);
});

test('[REPLENISH-8] limite de TEMPO: PARCIAL, e nenhuma nova descoberta depois do limite', async (t) => {
  let agora = AGORA.getTime();
  const rodadas = [tresBons(), [delta()], unicos('U', 6)];
  const motor = motorFake({ porPedido: (indice) => { agora += 6_000; return { candidatos: rodadas[indice - 1] || [] }; } });
  const env = ambiente(t, { motor, paginas: paginasBoas(), now: () => new Date(agora), limits: { maxDurationMs: 10_000 } });
  await marcarDnc(env, ['alfa', 'delta']);
  const { fim } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(motor.pedidos.length, 2, 'o 3º ciclo não começa: o tempo acabou');
  assert.equal(fim.telemetria.limitReached, STOP_REASON.TEMPO);
  assert.equal(fim.lote.naFila, 2);
});

test('[REPLENISH-9] cancelamento DURANTE a reposição: não inicia nova rodada; o que já foi entregue à fila continua entregue e no resultado do job', async (t) => {
  let servico;
  let jobId;
  const rodadas = [tresBons(), [delta()], unicos('V', 6)];
  const motor = motorFake({ porPedido: (indice) => { if (indice === 2) servico.cancelJob(admin(), jobId); return { candidatos: rodadas[indice - 1] || [] }; } });
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  await marcarDnc(env, ['alfa']);
  servico = env.servico;
  const { brief, job } = await iniciar(env, { quantidade: 3 });
  jobId = job.id;
  const fim = await servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CANCELADO);
  assert.equal(motor.pedidos.length, 2, 'nenhuma nova rodada depois do pedido');
  assert.deepEqual(env.ingestoes, [3], 'a reposição pedida não chegou a ingerir');
  assert.deepEqual([fim.lote.naFila, fim.lote.validadosPeloMotor], [2, 3], 'o já entregue permanece');
  assert.equal((await env.briefService.getBrief(admin(), brief.id)).status, 'AGUARDANDO_REVISAO');
});

test('[REPLENISH-10] DNC / DUPLICADO numa rodada de reposição não contam;  os candidatos novos que sobraram continuam sendo processados', async (t) => {
  const zeta = candidato('Clínica Zeta', 'zeta');
  const motor = rodadasDe(tresBons(), [delta(), zeta], []);
  const paginas = { ...paginasBoas(), [siteDe('zeta')]: paginaBoa('Clínica Zeta', 'zeta'), [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_EPS }) };
  const env = ambiente(t, { motor, paginas });
  await marcarDnc(env, ['alfa']);
  await env.crmService.createRecord(admin(), { empresa: 'Delta Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('delta') }); // a Delta é DUPLICADO
  const { fim, porNome } = await rodar(env);

  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(fim.lote.naFila, 3, 'só Beta, Gama e Zeta chegaram à fila');
  assert.deepEqual([porNome['Clínica Delta'].entrega.naFila, porNome['Clínica Delta'].entrega.estadoOperacional], [false, 'DUPLICADO']);
  assert.equal(porNome['Clínica Zeta'].entrega.naFila, true);
  assert.deepEqual(env.ingestoes, [3, 1, 1], 'cada rodada comprova só o que ainda falta; os que sobraram ficam no backlog e são processados em seguida');
  assert.equal(motor.pedidos.length, 2, 'o backlog foi esgotado ANTES de uma nova descoberta, e a meta fechou sem uma 3ª');
  assert.deepEqual(porNome['Clínica Alfa'].entrega, { naFila: false, estadoOperacional: 'DNC', motivo: 'DNC' });
});

test('[REPLENISH-11] um candidato repetido entre ciclos não é reprocessado nem duplicado: cada lead entra na fila UMA vez (prospectIds únicos entre todos os lotes do job)', async (t) => {
  const motor = rodadasDe(tresBons(), [candidato('Clínica Beta', 'beta'), candidato('Clínica Gama', 'gama'), delta()]);
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  await marcarDnc(env, ['alfa']);
  const { fim } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  const ids = fim.lote.lotes.flatMap((loteId) => env.prospectingService.getBatch(admin(), loteId).prospectIds);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, ids.length, 'nenhum prospectId repetido entre os lotes');
  assert.equal(fim.lote.naFila, new Set(ids).size);
  assert.equal(env.paginasChamadas.filter((url) => url === siteDe('beta')).length, 1, 'a Beta não voltou à validação');
  assert.deepEqual(fim.telemetria.candidatosRepetidos, 2);
  assert.deepEqual(env.ingestoes, [3, 1]);
});

test('[REPLENISH-11b] a identidade é determinística: o MESMO site, o MESMO nome na mesma cidade (com acento ou caixa diferentes) e o domínio confirmado já conhecido contam como conhecidos', async (t) => {
  const motor = rodadasDe([candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta')], [candidato('CLINICA ALFA', 'outro-site-qualquer'), candidato('Outro Nome', 'beta'), candidato('Outro Nome 2', 'alfa'), delta()]);
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { fim } = await rodar(env, 3);
  assert.equal(fim.candidatesDiscovered, 3, 'só a Delta é nova: mesmo nome sem acento, mesmo domínio com outro nome e o domínio já confirmado são conhecidos');
  assert.equal(fim.telemetria.candidatosRepetidos, 3);
});

test('[REPLENISH-12] regressão da 2.1: sem reposição necessária nada muda; com a meta por atingir e sem candidatos novos, o resultado é o da 2.1 (PARCIAL com validadosPeloMotor/naFila/foraDaFila)', async (t) => {
  const completo = ambiente(t, { motor: rodadasDe(tresBons()), paginas: paginasBoas() });
  const a = await rodar(completo);
  assert.equal(a.fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual([a.fim.lote.validadosPeloMotor, a.fim.lote.naFila, a.fim.lote.foraDaFila], [3, 3, 0]);
  assert.deepEqual(completo.ingestoes, [3]);

  const retido = ambiente(t, { motor: rodadasDe(tresBons(), []), paginas: paginasBoas() });
  await marcarDnc(retido, ['alfa']);
  const b = await rodar(retido);
  assert.equal(b.fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual([b.fim.lote.validadosPeloMotor, b.fim.lote.naFila, b.fim.lote.foraDaFila], [3, 2, 1]);
  assert.equal(b.fim.candidatesValidated, 3);
  assert.equal(b.fim.telemetria.limitReached, STOP_REASON.SEM_CANDIDATOS_NOVOS);
  assert.equal(b.fim.telemetria.reposicoesRealizadas, 0, 'a reposição foi tentada, mas não produziu nada');
  assert.equal(b.porNome['Clínica Alfa'].entrega.estadoOperacional, 'DNC');
  assert.equal(b.porNome['Clínica Alfa'].resultado, CANDIDATE_RESULT.VALIDADO);
  assert.equal(b.fim.error, null);
});

test('[REPLENISH-13] uma falha na ingestão de REPOSIÇÃO é ERRO operacional, mas o que já foi entregue permanece registrado no resultado do job', async (t) => {
  const env = ambiente(t, {
    motor: rodadasDe(tresBons(), [delta()]),
    paginas: paginasBoas(),
    briefService: (real) => ({ getBrief: real.getBrief, markResearching: real.markResearching, ingestFindings: real.ingestFindings, ingestReplacementFindings: async () => { throw new Error('banco fora'); } }),
  });
  await marcarDnc(env, ['alfa']);
  const { fim } = await rodar(env);
  assert.equal(fim.status, JOB_STATUS.ERRO);
  assert.equal(fim.error.code, 'INGESTION_FAILED');
  assert.equal(JSON.stringify(fim).includes('banco fora'), false);
  assert.deepEqual([fim.lote.naFila, fim.lote.validadosPeloMotor], [2, 3], 'a 1ª rodada continua entregue e registrada');
  assert.equal(fim.ingestionStarted, false);
});
