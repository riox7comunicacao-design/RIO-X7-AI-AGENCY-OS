// Prospecting Job Service (Fase 2 — "INICIAR PROSPECÇÃO"; motor comercial na Implementação 2): src/services/prospectingJobService.js.
// O ciclo de vida do job, a descoberta adaptativa, o cancelamento, a ingestão única e as fronteiras de segurança. As regras de LEAD (site oficial, presença
// digital, páginas de terceiros) estão em prospectingJobLeads.test.js. Peças REAIS e FAKES: ver tests/helpers/jobFixtures.js (nenhuma rede, nenhum `claude`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { authorizeProposerForLeadApproval } = require('../../src/auth');
const { createProspectingJobService, ProspectingJobError } = require('../../src/services/prospectingJobService');
const { createInMemoryJobRepository } = require('../../src/research-prospector/jobRepository');
const { JOB_STATUS, JOB_STEP, CANDIDATE_RESULT, CANDIDATE_REASON, ERROR_CODE, STOP_REASON } = require('../../src/research-prospector/prospectingJob');
const { admin, closer } = require('../helpers/promotionFixtures');
const { AGORA, MARCADOR, siteDe, paginaBoa, candidato, motorFake, esperaAteAbortar, ambiente, briefPronto, iniciar, erroDe, tresBons, paginasBoas } = require('../helpers/jobFixtures');

// ---------------------------------------------------------------------------------------------------------------------------------

test('[JOB-1] criação e início: o job nasce EXECUTANDO e devolve o id NA HORA; o brief vai a PESQUISANDO SEM pacote de pesquisa; o status é consultável e o job termina CONCLUIDO', async (t) => {
  const { espera, liberar } = esperaAteAbortar();
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }], espera }), paginas: paginasBoas() });
  const { brief, job } = await iniciar(env);

  assert.match(job.id, /^JOB-\d{8}-\d{3}$/);
  assert.deepEqual([job.briefId, job.status, job.requestedQuantity, job.cancelRequested, job.ingestionStarted, job.error], [brief.id, JOB_STATUS.EXECUTANDO, 3, false, false, null]);
  assert.ok(job.createdAt && job.startedAt && job.finishedAt === null);
  const depois = await env.briefService.getBrief(admin(), brief.id);
  assert.equal(depois.status, 'PESQUISANDO');
  assert.deepEqual([depois.pacotePesquisa, depois.pacoteGeradoEm], [null, null], 'o job automático NÃO gera nem depende do pacote de pesquisa manual');
  assert.deepEqual(env.pacotes, [], 'generateResearchPackage nunca é chamado pelo job');
  const andando = env.servico.getJob(admin(), job.id);
  assert.equal(andando.status, JOB_STATUS.EXECUTANDO);
  assert.equal(typeof andando.elapsedMs, 'number');
  assert.equal('achadosValidados' in andando, false, 'a visão pública nunca expõe os achados internos');

  liberar();
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual([fim.candidatesDiscovered, fim.candidatesValidated, fim.candidatesRejected, fim.progress, fim.currentStep], [3, 3, 0, 100, JOB_STEP.FINALIZADO]);
  assert.ok(fim.finishedAt);
  assert.match(fim.lote.loteId, /^lote:/);
  assert.equal(env.servico.listJobs(admin(), { briefId: brief.id }).length, 1);
});

test('[JOB-2] validações da entrada: só { briefId }; brief inexistente; brief em RASCUNHO e em PESQUISANDO recusados; quem não tem PROPOSE:LEAD_APPROVAL não inicia', async (t) => {
  const env = ambiente(t);
  assert.equal((await erroDe(() => env.servico.startJob(admin(), {}))).code, 'JOB_INVALID_INPUT');
  assert.equal((await erroDe(() => env.servico.startJob(admin(), { briefId: 'PROS-20261006-001', extra: 1 }))).code, 'JOB_INVALID_INPUT');
  assert.equal((await erroDe(() => env.servico.startJob(admin(), { briefId: 'PROS-20261006-009' }))).code, 'BRIEF_NOT_FOUND');
  const rascunho = await env.briefService.createBrief(admin(), { nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis/RJ', quantidade: 3 });
  const erro = await erroDe(() => env.servico.startJob(admin(), { briefId: rascunho.id }));
  assert.equal(erro.code, 'JOB_INVALID_STATE');
  assert.match(erro.message, /PRONTO_PARA_PESQUISA/);
  const pronto = await briefPronto(env);
  await erroDe(() => env.servico.startJob(closer(), { briefId: pronto.id })); // COMMERCIAL_CLOSER não tem PROPOSE:LEAD_APPROVAL
  assert.equal(env.jobs.list().length, 0, 'nenhum job foi criado nos casos recusados');
  assert.equal((await env.briefService.getBrief(admin(), pronto.id)).status, 'PRONTO_PARA_PESQUISA', 'e o brief continua intacto');

  // máquina de estados explícita: PRONTO_PARA_PESQUISA -> job. PESQUISANDO NUNCA inicia um novo job
  await env.briefService.markResearching(admin(), pronto.id);
  const emPesquisa = await erroDe(() => env.servico.startJob(admin(), { briefId: pronto.id }));
  assert.equal(emPesquisa.code, 'JOB_INVALID_STATE');
  assert.match(emPesquisa.message, /PRONTO_PARA_PESQUISA \(está em PESQUISANDO\)/);
  assert.equal(env.jobs.list().length, 0);
});

test('[JOB-3] DESCOBERTA ADAPTATIVA — o 1º ciclo pede clamp(faltam x 3, 6, 12) candidatos (3 -> 9; 10 -> 12), e o teto de candidatos é 40 qualquer que seja a quantidade pedida', async (t) => {
  for (const [quantidade, primeiroCiclo] of [[1, 6], [2, 6], [3, 9], [4, 12], [10, 12], [50, 12], [300, 12]]) {
    const motor = motorFake({ rodadas: [{ candidatos: [] }] });
    const env = ambiente(t, { motor });
    const { job } = await iniciar(env, { quantidade });
    await env.servico.waitFor(job.id);
    assert.equal(motor.pedidos[0].limit, primeiroCiclo, `quantidade ${quantidade}`);
    assert.equal(env.jobs.getById(job.id).limits.maxCandidates, 40, 'a quantidade pedida NÃO define o teto: é sempre 40');
    assert.equal(env.jobs.getById(job.id).limits.maxCycles, 6);
  }
  // um limite sobrescrito acima de 40 é cortado em 40
  const motor = motorFake({ rodadas: [{ candidatos: [] }] });
  const env = ambiente(t, { motor, limits: { candidatesAbsoluteMax: 500 } });
  const { job } = await iniciar(env, { quantidade: 300 });
  await env.servico.waitFor(job.id);
  assert.equal(env.jobs.getById(job.id).limits.maxCandidates, 40);
});

test('[JOB-4] um motor que devolve candidatos DEMAIS é cortado no tamanho do ciclo pedido: nunca se examina mais do que o ciclo pediu', async (t) => {
  const muitos = Array.from({ length: 30 }, (_, i) => candidato(`Clínica N${i}`, `n${i}`));
  const guloso = { pedidos: [], discover: async (pedido) => { guloso.pedidos.push(pedido); return { ok: true, candidatos: guloso.pedidos.length === 1 ? muitos : [], invalidos: 0 }; } };
  const env = ambiente(t, { motor: guloso });
  const { job } = await iniciar(env, { quantidade: 1 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(guloso.pedidos[0].limit, 6);
  assert.equal(fim.candidatesDiscovered, 6);
  assert.equal(env.paginasChamadas.filter((url) => url.endsWith('.com.br/')).length, 6, 'só os 6 pedidos foram lidos');
  assert.equal(fim.status, JOB_STATUS.PARCIAL, 'nenhum validou (as páginas não existem): nada é completado artificialmente');
});

test('[JOB-5] CONCLUIDO: a quantidade pedida validada; para de examinar quando atinge; UMA ingestão com exatamente a quantidade; nada vai ao CRM e a fila fica aguardando revisão', async (t) => {
  const motor = motorFake({ rodadas: [{ candidatos: [...tresBons(), candidato('Clínica Delta', 'delta')], telemetria: { custoUsd: 0.31, webSearchRequests: 3, turnos: 9 } }] });
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { brief, job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);

  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual(env.ingestoes, [3], 'UMA ingestão, com exatamente 3 achados');
  assert.equal(env.paginasChamadas.length, 3, 'a 4ª empresa nem foi lida: a quantidade já estava atingida');
  assert.deepEqual([fim.candidatesDiscovered, fim.candidatesValidated], [4, 3]);
  assert.equal(fim.candidatos.filter((c) => c.resultado === CANDIDATE_RESULT.VALIDADO).length, 3);
  assert.equal(fim.telemetria.custoUsd, 0.31);
  assert.equal(fim.telemetria.webSearchRequests, 3);
  assert.equal(fim.telemetria.limitReached, null, 'atingiu a quantidade: nenhum limite foi o motivo da parada');

  const depois = await env.briefService.getBrief(admin(), brief.id);
  assert.equal(depois.status, 'AGUARDANDO_REVISAO');
  const lote = env.prospectingService.getBatch(admin(), depois.loteRealId);
  assert.equal(lote.resultados.length, 3);
  assert.deepEqual([...new Set(lote.resultados.map((r) => r.estadoFila))], ['AGUARDANDO_REVISAO']);
  assert.equal((await env.crmService.listRecords(admin(), {})).length, 0, 'NENHUMA promoção automática ao CRM');
});

test('[JOB-6] PARCIAL: só 2 de 3 comprovados -> ingere SÓ os 2, nunca completa com candidato fraco; os não validados ficam NAO_VERIFICADO com o motivo, a causa técnica e o que faltou', async (t) => {
  const candidatos = [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Fora', 'fora'), candidato('Clínica Beta', 'beta'), candidato('Clínica Sem Nicho', 'semnicho'), candidato('Clínica Sem Cidade', 'semcidade')];
  const paginas = {
    [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa'),
    [siteDe('beta')]: paginaBoa('Clínica Beta', 'beta'),
    [siteDe('semnicho')]: paginaBoa('Clínica Sem Nicho', 'semnicho', { sem: ['nicho'] }),
    [siteDe('semcidade')]: paginaBoa('Clínica Sem Cidade', 'semcidade', { sem: ['localizacao'] }),
    // 'fora' não tem página: falha de DNS
  };
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos }, { candidatos: [] }] }), paginas });
  const { brief, job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);

  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.SEM_CANDIDATOS_NOVOS, 'o motor não trouxe mais ninguém: PARCIAL, nunca candidatos artificiais');
  assert.deepEqual([fim.candidatesDiscovered, fim.candidatesValidated, fim.candidatesRejected, fim.candidatesUnverified, fim.candidatesDiscarded], [5, 2, 3, 3, 0]);
  const porNome = Object.fromEntries(fim.candidatos.map((c) => [c.nome, c]));
  assert.equal(porNome['Clínica Fora'].resultado, CANDIDATE_RESULT.NAO_VERIFICADO);
  assert.equal(porNome['Clínica Fora'].motivo, CANDIDATE_REASON.PAGINA_INACESSIVEL);
  assert.equal(porNome['Clínica Fora'].causa, 'DNS', 'a causa técnica é preservada (nunca "empresa inexistente")');
  assert.deepEqual([porNome['Clínica Sem Nicho'].motivo, porNome['Clínica Sem Nicho'].faltando], [CANDIDATE_REASON.EVIDENCIA_INCOMPLETA, ['nicho']]);
  assert.deepEqual([porNome['Clínica Sem Nicho'].empresa, porNome['Clínica Sem Nicho'].nicho, porNome['Clínica Sem Nicho'].localizacao], ['VALIDADO', 'NAO_VERIFICADO', 'VALIDADO']);
  assert.deepEqual(porNome['Clínica Sem Cidade'].faltando, ['localizacao']);
  const lote = env.prospectingService.getBatch(admin(), (await env.briefService.getBrief(admin(), brief.id)).loteRealId);
  assert.equal(lote.resultados.length, 2, 'só os comprovados chegaram ao caminho oficial');
});

test('[JOB-7] PARCIAL sem nenhum válido: nada é ingerido, o brief continua PESQUISANDO e um NOVO job NÃO é aceito nesse estado (máquina de estados explícita)', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: [candidato('Clínica Fora', 'fora')] }, { candidatos: [] }] }) });
  const { brief, job } = await iniciar(env);
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.deepEqual(env.ingestoes, []);
  assert.equal(fim.lote, null);
  assert.equal((await env.briefService.getBrief(admin(), brief.id)).status, 'PESQUISANDO');
  const recusa = await erroDe(() => env.servico.startJob(admin(), { briefId: brief.id }));
  assert.equal(recusa.code, 'JOB_INVALID_STATE');
  assert.equal(env.jobs.list().length, 1, 'nenhum segundo job foi criado');
});

test('[JOB-8] ERRO: a descoberta que falha no primeiro ciclo termina ERRO com o código e sem ingestão; a falha da ingestão também é ERRO (nada promovido)', async (t) => {
  const env = ambiente(t, { motor: motorFake({ falha: 'TIMEOUT' }) });
  const { job } = await iniciar(env);
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.ERRO);
  assert.deepEqual([fim.error.code, fim.error.cause], [ERROR_CODE.DISCOVERY_FAILED, 'TIMEOUT']);
  assert.ok(fim.finishedAt);

  const quebrado = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }),
    paginas: paginasBoas(),
    briefService: (real) => ({ getBrief: real.getBrief, markResearching: real.markResearching, ingestFindings: async () => { throw new Error('C:\\segredo\\x falhou'); } }),
  });
  const { job: segundo } = await iniciar(quebrado);
  const fim2 = await quebrado.servico.waitFor(segundo.id);
  assert.equal(fim2.status, JOB_STATUS.ERRO);
  assert.equal(fim2.error.code, ERROR_CODE.INGESTION_FAILED);
  assert.equal(JSON.stringify(fim2).includes('segredo'), false, 'a mensagem do erro interno nunca vaza');
  assert.equal((await quebrado.crmService.listRecords(admin(), {})).length, 0);
});

test('[JOB-9] CANCELAR durante a descoberta: marca o pedido, aborta o motor, termina CANCELADO — sem validar, sem ingerir, e os achados internos somem', async (t) => {
  const { espera } = esperaAteAbortar();
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }], espera }), paginas: paginasBoas() });
  const { job } = await iniciar(env);
  const pedido = env.servico.cancelJob(admin(), job.id);
  assert.deepEqual([pedido.status, pedido.cancelRequested], [JOB_STATUS.CANCELAMENTO_SOLICITADO, true]);
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CANCELADO);
  assert.deepEqual([env.ingestoes.length, env.paginasChamadas.length], [0, 0], 'nenhuma validação nem ingestão depois do cancelamento');
  assert.deepEqual(env.jobs.getById(job.id).achadosValidados, []);
  assert.ok(fim.finishedAt);
});

test('[JOB-10] CANCELAR entre candidatos: a validação em andamento termina, a PRÓXIMA não começa e não há ingestão parcial — mesmo com válidos já encontrados', async (t) => {
  let servico;
  let jobId;
  const lidas = [];
  const env = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }),
    fetchPage: async (url) => {
      lidas.push(url);
      if (lidas.length === 1) servico.cancelJob(admin(), jobId); // o pedido chega no meio da primeira validação
      return paginasBoas()[url];
    },
  });
  servico = env.servico;
  const brief = await briefPronto(env);
  const job = await servico.startJob(admin(), { briefId: brief.id });
  jobId = job.id;
  const fim = await servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CANCELADO);
  assert.equal(lidas.length, 1, 'só a primeira empresa chegou a ser lida');
  assert.deepEqual(env.ingestoes, [], 'NENHUMA ingestão parcial (a primeira já era válida)');
  assert.equal((await env.briefService.getBrief(admin(), brief.id)).status, 'PESQUISANDO');
});

test('[JOB-11] a ingestão já começou: o cancelamento é RECUSADO e a ingestão termina normalmente, uma única vez', async (t) => {
  let liberarIngestao;
  const portao = new Promise((resolve) => {
    liberarIngestao = resolve;
  });
  let entrouNaIngestao;
  const entrou = new Promise((resolve) => {
    entrouNaIngestao = resolve;
  });
  let chamadas = 0;
  const env = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }),
    paginas: paginasBoas(),
    briefService: (real) => ({
      getBrief: real.getBrief,
      markResearching: real.markResearching,
      ingestFindings: async (...args) => {
        chamadas += 1;
        entrouNaIngestao();
        await portao;
        return real.ingestFindings(...args);
      },
    }),
  });
  const { job } = await iniciar(env);
  await entrou;
  assert.equal(env.servico.getJob(admin(), job.id).currentStep, JOB_STEP.INGERINDO);
  const recusa = await erroDe(() => env.servico.cancelJob(admin(), job.id));
  assert.equal(recusa.code, 'JOB_INVALID_STATE');
  assert.match(recusa.message, /ingestão/);
  liberarIngestao();
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(chamadas, 1);
});

test('[JOB-12] cancelar um job que já terminou (ou que não existe) é recusado com o código estável', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }), paginas: paginasBoas() });
  const { job } = await iniciar(env);
  await env.servico.waitFor(job.id);
  assert.equal((await erroDe(() => env.servico.cancelJob(admin(), job.id))).code, 'JOB_INVALID_STATE');
  assert.equal((await erroDe(() => env.servico.cancelJob(admin(), 'JOB-20261006-099'))).code, 'JOB_NOT_FOUND');
  assert.equal((await erroDe(() => env.servico.cancelJob(admin(), 'x'))).code, 'JOB_INVALID_INPUT');
  await erroDe(() => env.servico.cancelJob(closer(), job.id));
});

test('[JOB-13] uma prospecção por vez: com um job ativo, iniciar outro é recusado (JOB_ALREADY_RUNNING)', async (t) => {
  const { espera, liberar } = esperaAteAbortar();
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: [] }], espera }) });
  const { job } = await iniciar(env);
  const outroBrief = await briefPronto(env);
  assert.equal((await erroDe(() => env.servico.startJob(admin(), { briefId: outroBrief.id }))).code, 'JOB_ALREADY_RUNNING');
  liberar();
  await env.servico.waitFor(job.id);
  const livre = await env.servico.startJob(admin(), { briefId: outroBrief.id });
  assert.equal(livre.status, JOB_STATUS.EXECUTANDO);
  await env.servico.waitFor(livre.id);
});

test('[JOB-14] só brief de UMA cidade (a localização é comprovada pela página): várias cidades ou estado são recusados', async (t) => {
  const env = ambiente(t);
  const duas = await briefPronto(env, { cidades: 'Petrópolis, Teresópolis' });
  assert.equal((await erroDe(() => env.servico.startJob(admin(), { briefId: duas.id }))).code, 'JOB_BRIEF_UNSUPPORTED');
  const estado = await briefPronto(env, { nivelGeografico: 'ESTADO', cidades: undefined, estados: 'RJ' });
  assert.equal((await erroDe(() => env.servico.startJob(admin(), { briefId: estado.id }))).code, 'JOB_BRIEF_UNSUPPORTED');
  assert.equal(env.jobs.list().length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Descoberta adaptativa: ciclos, 40 candidatos, 6 ciclos, tempo, parada por sucesso/falta de candidatos

const unicos = (prefixo, quantidade) => Array.from({ length: quantidade }, (_, i) => candidato(`Clínica ${prefixo}${i}`, `${prefixo.toLowerCase()}${i}`));

test('[JOB-15] ciclos ADAPTATIVOS: o tamanho de cada ciclo é recalculado pelo que ainda falta (clamp(faltam x 3, 6, 12)); a lista de nomes já vistos vai junto; para ao atingir a quantidade; a ingestão é UMA só', async (t) => {
  const rodadas = [
    { candidatos: [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Fora', 'fora'), candidato('Clínica Fora2', 'fora2'), candidato('Clínica Fora3', 'fora3')] }, // 1 válido de 4
    { candidatos: [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), candidato('Clínica Fora4', 'fora4')] }, // +1 válido (o repetido não conta)
    { candidatos: [candidato('Clínica Gama', 'gama')] }, // o 3º válido
    { candidatos: [candidato('Clínica Delta', 'delta')] }, // nunca pedido: já atingiu
  ];
  const motor = motorFake({ rodadas });
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);

  assert.deepEqual(motor.pedidos.map((p) => p.limit), [9, 6, 6], 'faltam 3 -> 9; faltam 2 -> 6; faltam 1 -> 6 (o mínimo)');
  assert.deepEqual(motor.pedidos[1].excluir, ['Clínica Alfa', 'Clínica Fora', 'Clínica Fora2', 'Clínica Fora3'], 'o ciclo seguinte recebe só os NOMES já vistos');
  assert.equal(fim.cycles, 3);
  assert.equal(fim.candidatesDiscovered, 7, 'o repetido (mesmo nome e site) não conta duas vezes');
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(motor.pedidos.length, 3, 'parou ao atingir a quantidade: o 4º ciclo nunca foi pedido');
  assert.deepEqual(env.ingestoes, [3], 'a ingestão é UMA só, mesmo com vários ciclos');
});

test('[JOB-15b] o teto absoluto de 40 candidatos: o último ciclo só pede o que ainda cabe; a quantidade pedida NÃO define o teto; termina PARCIAL (CANDIDATOS) sem inventar ninguém', async (t) => {
  let n = 0;
  const motor = motorFake({ porPedido: (_, pedido) => ({ candidatos: unicos('Z', 80).slice(n, (n += pedido.limit)) }) });
  const env = ambiente(t, { motor });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.deepEqual(motor.pedidos.map((p) => p.limit), [9, 9, 9, 9, 4], '9 x 4 = 36; sobram 4 de 40');
  assert.equal(fim.candidatesDiscovered, 40);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.CANDIDATOS);
  assert.equal(fim.cycles, 5);

  let m = 0;
  const motor10 = motorFake({ porPedido: (_, pedido) => ({ candidatos: unicos('Y', 80).slice(m, (m += pedido.limit)) }) });
  const env10 = ambiente(t, { motor: motor10 });
  const { job: job10 } = await iniciar(env10, { quantidade: 10 });
  const fim10 = await env10.servico.waitFor(job10.id);
  assert.deepEqual(motor10.pedidos.map((p) => p.limit), [12, 12, 12, 4], '10 pedidos: clamp(30, 6, 12) = 12 por ciclo; o último cabe 4');
  assert.equal(fim10.candidatesDiscovered, 40);
});

test('[JOB-15c] no máximo 6 ciclos de descoberta (PARCIAL, CICLOS), mesmo que ainda caibam candidatos', async (t) => {
  let n = 0;
  const motor = motorFake({ porPedido: (_, pedido) => ({ candidatos: unicos('W', 80).slice(n, (n += pedido.limit)) }) });
  const env = ambiente(t, { motor, limits: { batchMin: 3, batchMax: 3 } });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(motor.pedidos.length, 6);
  assert.equal(fim.cycles, 6);
  assert.equal(fim.candidatesDiscovered, 18);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.CICLOS);
});

test('[JOB-15d] parada por falta de candidatos: um ciclo sem NENHUM candidato novo (só repetidos) encerra a descoberta — PARCIAL, e nada é inventado', async (t) => {
  const motor = motorFake({ rodadas: [{ candidatos: [candidato('Clínica Alfa', 'alfa')] }, { candidatos: [candidato('Clínica Alfa', 'alfa')] }, { candidatos: unicos('V', 5) }] });
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(motor.pedidos.length, 2, 'o 3º ciclo nunca é pedido: o 2º não trouxe ninguém novo');
  assert.equal(fim.candidatesDiscovered, 1);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.SEM_CANDIDATOS_NOVOS);
  assert.deepEqual(env.ingestoes, [1], 'o único comprovado foi ingerido (UMA vez)');
});

test('[JOB-15e] a falha da descoberta DEPOIS do 1º ciclo não derruba o job: segue com o que já tem (PARCIAL, DESCOBERTA)', async (t) => {
  const motor = { pedidos: [], discover: async (pedido) => { motor.pedidos.push(pedido); return motor.pedidos.length === 1 ? { ok: true, candidatos: [candidato('Clínica Alfa', 'alfa')], invalidos: 0 } : { ok: false, code: 'TIMEOUT' }; } };
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.DESCOBERTA);
  assert.equal(fim.candidatesValidated, 1);
});

test('[JOB-16] limite de TEMPO: passado o tempo máximo a execução para, ingere só o que já está validado e termina PARCIAL (nunca continua indefinidamente)', async (t) => {
  let agora = AGORA.getTime();
  const lidas = [];
  const env = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }),
    now: () => new Date(agora),
    limits: { maxDurationMs: 10_000 },
    fetchPage: async (url) => {
      lidas.push(url);
      agora += 6_000; // cada leitura "demora" 6 s
      return paginasBoas()[url];
    },
  });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.TEMPO);
  assert.equal(lidas.length, 2, 'a 3ª leitura não começou: o tempo acabou');
  assert.equal(fim.candidatesValidated, 2);
  assert.match(fim.lote.loteId, /^lote:/, 'o que já estava validado foi ingerido (uma vez)');
});

test('[JOB-17] exclusão permanente ANTES da validação: o candidato excluído é DESCARTADO sem nenhuma leitura de página; se a consulta falhar, NAO_VERIFICADO (nunca segue)', async (t) => {
  const consultados = [];
  const env = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: [candidato('Força Digital', 'forca'), ...tresBons()] }] }),
    paginas: { ...paginasBoas(), [siteDe('forca')]: paginaBoa('Força Digital', 'forca') },
    exclusao: async (finding) => {
      consultados.push(finding);
      return finding.empresa === 'Força Digital' ? { motivo: 'Exclusão permanente de prospecção' } : false;
    },
  });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  const forca = fim.candidatos.find((c) => c.nome === 'Força Digital');
  assert.deepEqual([forca.resultado, forca.motivo], [CANDIDATE_RESULT.DESCARTADO, CANDIDATE_REASON.EXCLUSAO_PERMANENTE]);
  assert.equal(env.paginasChamadas.includes(siteDe('forca')), false, 'a página de uma empresa excluída nunca é lida');
  assert.deepEqual(consultados[0], { empresa: 'Força Digital', cidade: 'Petrópolis', estado: 'RJ' });
  assert.equal(fim.candidatesDiscarded, 1);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);

  const falha = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: [candidato('Clínica Alfa', 'alfa')] }, { candidatos: [] }] }), paginas: paginasBoas(), exclusao: async () => { throw new Error('banco fora'); } });
  const { job: segundo } = await iniciar(falha, { quantidade: 1 });
  const fim2 = await falha.servico.waitFor(segundo.id);
  assert.equal(fim2.candidatos[0].resultado, CANDIDATE_RESULT.NAO_VERIFICADO);
  assert.equal(fim2.candidatos[0].motivo, CANDIDATE_REASON.EXCLUSAO_NAO_CONSULTADA);
  assert.equal(falha.paginasChamadas.length, 0);
});

test('[JOB-18] DNC, duplicidade e exclusão no CAMINHO OFICIAL: o DNC e o duplicado do CRM não entram na fila, e nada é promovido', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }), paginas: paginasBoas() });
  // o CRM real já tem a Alfa em DO_NOT_CONTACT e a Beta como PROSPECT (mesmo site)
  const alfa = (await env.crmService.createRecord(admin(), { empresa: 'Alfa Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('alfa') })).record;
  await env.crmService.markDoNotContact(admin(), alfa.id, { reason: 'pediu para não ser contatado' });
  await env.crmService.createRecord(admin(), { empresa: 'Beta Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('beta') });

  const { brief, job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.PARCIAL, 'as 3 foram validadas pela página, mas o pipeline oficial reteve 2 (DNC e duplicado): só 1 chegou à fila, e a meta é de leads NA FILA');
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila, fim.lote.foraDaFila], [3, 1, 2]);
  const lote = env.prospectingService.getBatch(admin(), (await env.briefService.getBrief(admin(), brief.id)).loteRealId);
  const estado = Object.fromEntries(lote.resultados.map((r) => [r.empresa, r.estadoOperacional]));
  assert.equal(estado['Clínica Alfa'], 'DNC');
  assert.equal(estado['Clínica Beta'], 'DUPLICADO');
  assert.notEqual(estado['Clínica Gama'], 'DNC');
  assert.deepEqual(lote.resultados.filter((r) => r.naFila).map((r) => r.empresa), ['Clínica Gama'], 'só a empresa limpa chegou à fila');
  assert.equal((await env.crmService.listRecords(admin(), {})).length, 2, 'o CRM só tem os dois registros que já existiam: nenhuma promoção automática');
});

test('[JOB-19] recuperação: depois de um "refresh" (outro Service sobre o mesmo repositório) o job terminado continua consultável; um job que ficou ativo é marcado ERRO/INTERROMPIDO — nunca finge ter concluído', async (t) => {
  const { espera, liberar } = esperaAteAbortar();
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }), paginas: paginasBoas() });
  const { job } = await iniciar(env);
  await env.servico.waitFor(job.id);

  const reaberto = createProspectingJobService({ authorizeProposer: authorizeProposerForLeadApproval, briefService: env.briefService, repository: env.jobs, discoveryEngine: motorFake({ espera }), createFetchPage: () => env.fetchPage });
  const lido = reaberto.getJob(admin(), job.id);
  assert.deepEqual([lido.status, lido.candidatesValidated, lido.lote.loteId], [JOB_STATUS.CONCLUIDO, 3, env.jobs.getById(job.id).lote.loteId]);

  // um job que o servidor deixou ativo ao cair
  const orfao = { ...env.jobs.getById(job.id), id: 'JOB-20261006-050', status: JOB_STATUS.EXECUTANDO, finishedAt: null, currentStep: JOB_STEP.VALIDANDO, ingestionStarted: false };
  const orfaoIngerindo = { ...orfao, id: 'JOB-20261006-051', status: JOB_STATUS.CANCELAMENTO_SOLICITADO, ingestionStarted: true };
  env.jobs.save(orfao);
  env.jobs.save(orfaoIngerindo);
  assert.equal(reaberto.recoverInterruptedJobs(), 2);
  for (const id of [orfao.id, orfaoIngerindo.id]) {
    const marcado = reaberto.getJob(admin(), id);
    assert.deepEqual([marcado.status, marcado.error.code, marcado.currentStep], [JOB_STATUS.ERRO, ERROR_CODE.INTERRUPTED, JOB_STEP.FINALIZADO]);
    assert.ok(marcado.finishedAt);
  }
  assert.match(reaberto.getJob(admin(), orfaoIngerindo.id).error.message, /ingestão/);
  assert.equal(reaberto.getJob(admin(), job.id).status, JOB_STATUS.CONCLUIDO, 'o job concluído não é tocado');
  assert.equal(reaberto.recoverInterruptedJobs(), 0, 'idempotente');
  liberar();
});

test('[JOB-19b] recuperação respeita o DONO: um job ativo de OUTRO processo ainda vivo não é tocado (a suíte de testes não estraga a prospecção real); o de um processo morto é marcado INTERROMPIDO', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }), paginas: paginasBoas() });
  const { job } = await iniciar(env);
  await env.servico.waitFor(job.id);
  const base = { ...env.jobs.getById(job.id), status: JOB_STATUS.EXECUTANDO, finishedAt: null, currentStep: JOB_STEP.VALIDANDO };
  env.jobs.save({ ...base, id: 'JOB-20261006-060', processId: 11111 });
  env.jobs.save({ ...base, id: 'JOB-20261006-061', processId: 22222 });
  env.jobs.save({ ...base, id: 'JOB-20261006-062', processId: undefined });
  const vivos = new Set([11111]);
  const outro = createProspectingJobService({ authorizeProposer: authorizeProposerForLeadApproval, briefService: env.briefService, repository: env.jobs, discoveryEngine: motorFake(), createFetchPage: () => env.fetchPage, processId: 99999, isProcessAlive: (pid) => vivos.has(pid) });
  assert.equal(outro.recoverInterruptedJobs(), 2);
  assert.equal(outro.getJob(admin(), 'JOB-20261006-060').status, JOB_STATUS.EXECUTANDO, 'o dono está vivo: não é nosso');
  assert.equal(outro.getJob(admin(), 'JOB-20261006-061').status, JOB_STATUS.ERRO, 'o dono morreu');
  assert.equal(outro.getJob(admin(), 'JOB-20261006-062').status, JOB_STATUS.ERRO, 'sem dono conhecido');
  assert.equal(env.jobs.getById(job.id).processId, process.pid, 'o job guarda o PID de quem o executa');
});

test('[JOB-20] persistência mínima: nenhum texto de página, prompt nem achado sobra no arquivo do job; só contadores, o resultado estruturado de cada candidato e a telemetria agregada', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons(), telemetria: { custoUsd: 0.2, webSearchRequests: 2 } }] }), paginas: paginasBoas() });
  const { job } = await iniciar(env);
  await env.servico.waitFor(job.id);
  const salvo = env.jobs.getById(job.id);
  const bruto = JSON.stringify(salvo);
  assert.equal(bruto.includes(MARCADOR), false, 'o texto da página nunca é persistido');
  assert.doesNotMatch(bruto, /prompt|Responda APENAS|achadosValidados":\[\{/i);
  assert.deepEqual(salvo.achadosValidados, []);
  assert.deepEqual(Object.keys(salvo.candidatos[0]).sort(), ['empresa', 'entrega', 'evidencias', 'fonteDaValidacao', 'fontesDescoberta', 'localizacao', 'nicho', 'nome', 'outrasPresencas', 'presencaDigital', 'resultado', 'siteOficial', 'url']);
  for (const aspecto of ['empresa', 'nicho', 'localizacao']) assert.ok(salvo.candidatos[0].evidencias[aspecto].trecho.length <= 80, 'evidência curta');
  assert.deepEqual(Object.keys(salvo.telemetria).sort(), ['custoUsd', 'discoveryMs', 'discoveryRuns', 'limitReached', 'validationMs', 'webSearchRequests']);
});

test('[JOB-21] segurança do motor: o pedido leva só o que o brief diz (nunca texto de página, contexto de usuário nem CRM) e o Service não entrega ao motor nenhuma porta do CRM', async (t) => {
  const motor = motorFake({ rodadas: [{ candidatos: tresBons() }] });
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { job } = await iniciar(env, { subnicho: 'Harmonização' });
  await env.servico.waitFor(job.id);
  const pedido = motor.pedidos[0];
  assert.deepEqual(Object.keys(pedido).sort(), ['cidade', 'excluir', 'limit', 'nicho', 'signal', 'subnicho', 'timeoutMs', 'uf']);
  assert.deepEqual([pedido.nicho, pedido.subnicho, pedido.cidade, pedido.uf], ['Clínicas de estética', 'Harmonização', 'Petrópolis', 'RJ']);
  assert.equal(JSON.stringify({ ...pedido, signal: undefined }).includes(MARCADOR), false);
  const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'prospectingJobService.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /crmService|createRecord|promoteProspect|approveProspect|crmIntegration/, 'o Service de job nunca toca o CRM nem a promoção');
});

test('[JOB-22] dependências obrigatórias: sem autorizador, brief service (com markResearching), repositório, motor ou leitor de página o Service não nasce; limites inválidos também', () => {
  const base = { authorizeProposer: authorizeProposerForLeadApproval, briefService: { getBrief() {}, markResearching() {}, ingestFindings() {} }, repository: createInMemoryJobRepository(), discoveryEngine: { discover() {} }, createFetchPage: () => () => {} };
  assert.ok(createProspectingJobService(base));
  for (const faltando of ['authorizeProposer', 'briefService', 'repository', 'discoveryEngine', 'createFetchPage']) {
    assert.throws(() => createProspectingJobService({ ...base, [faltando]: undefined }), undefined, faltando);
  }
  assert.throws(() => createProspectingJobService({ ...base, briefService: { getBrief() {}, ingestFindings() {} } }), /markResearching/);
  assert.throws(() => createProspectingJobService({ ...base, briefService: { getBrief() {}, markResearching() {} } }), /ingestFindings/);
  assert.throws(() => createProspectingJobService({ ...base, briefService: { getBrief() {}, generateResearchPackage() {}, ingestFindings() {} } }), /markResearching/, 'o pacote manual não substitui markResearching');
  assert.throws(() => createProspectingJobService({ ...base, checkPermanentExclusion: 'x' }), /checkPermanentExclusion/);
  assert.throws(() => createProspectingJobService({ ...base, limits: { maxCycles: 0 } }), /maxCycles/);
  assert.ok(Object.isFrozen(createProspectingJobService(base)));
  assert.ok(new ProspectingJobError('JOB_NOT_FOUND', 'x') instanceof Error);
});
