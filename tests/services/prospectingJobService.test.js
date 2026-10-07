// Prospecting Job Service (Fase 2 — "INICIAR PROSPECÇÃO"): src/services/prospectingJobService.js.
//
// Peças REAIS: contextos emitidos, a ponte real de PROPOSE:LEAD_APPROVAL, o Brief Service, o Prospecting Service (caminho oficial de ingestão:
// exclusões -> deduplicação -> DNC -> Approval Queue), o CRM Service e o Researcher com a verificação por código — tudo em diretório temporário.
// FAKES: só o motor externo (o `claude -p`) e a leitura de página (a rede). Nenhuma pesquisa real, nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { authorizeProposerForLeadApproval, authorizeCrmOperation } = require('../../src/auth');
const { createProspectingJobService, ProspectingJobError } = require('../../src/services/prospectingJobService');
const { createProspectingBriefService } = require('../../src/services/prospectingBriefService');
const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createInMemoryBriefRepository } = require('../../src/research-prospector/briefRepository');
const { createInMemoryJobRepository } = require('../../src/research-prospector/jobRepository');
const { JOB_STATUS, JOB_STEP, CANDIDATE_RESULT, CANDIDATE_REASON, ERROR_CODE } = require('../../src/research-prospector/prospectingJob');
const { admin, closer } = require('../helpers/promotionFixtures');

const AGORA = new Date('2026-10-06T12:00:00.000Z');
const MARCADOR = 'MARCADOR-DE-TEXTO-DA-PAGINA-NAO-PERSISTIR';

const briefInput = (extra = {}) => ({ nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis/RJ', quantidade: 3, ...extra });
const siteDe = (slug) => `https://${slug}.example.test/`;

// A página de uma empresa que SE COMPROVA (nome, nicho e cidade no texto); `sem` tira uma das evidências.
function paginaBoa(nome, slug, { sem = [] } = {}) {
  const linhas = [nome, `${MARCADOR} ${slug}`];
  if (!sem.includes('nicho')) linhas.push('Clínica de estética e harmonização facial');
  if (!sem.includes('localizacao')) linhas.push('Rua das Flores, 10 - Petrópolis - RJ');
  return { ok: true, urlFinal: siteDe(slug), links: [], temFormularioContato: false, texto: sem.includes('empresa') ? linhas.slice(1).join('\n') : linhas.join('\n') };
}

const candidato = (nome, slug) => ({ nome, url: siteDe(slug), fonteUrl: 'https://busca.example.test/r', cidadeUf: 'Petrópolis/RJ' });

// Motor de descoberta FAKE: devolve as rodadas na ordem; registra cada pedido; `espera` segura a resposta até ser liberada ou abortada.
function motorFake({ rodadas = [], falha, espera } = {}) {
  const pedidos = [];
  return {
    pedidos,
    discover: async (pedido) => {
      pedidos.push(pedido);
      if (espera) {
        const abortado = await espera(pedido);
        if (abortado) return { ok: false, code: 'ABORTED' };
      }
      if (falha) return { ok: false, code: falha };
      const rodada = rodadas[pedidos.length - 1] || { candidatos: [] };
      return { ok: true, candidatos: rodada.candidatos.slice(0, pedido.limit), invalidos: 0, ...(rodada.telemetria || {}) };
    },
  };
}

// Espera que só termina quando o pedido é ABORTADO (devolve true) ou liberada (devolve false).
function esperaAteAbortar() {
  let liberar;
  const liberada = new Promise((resolve) => {
    liberar = resolve;
  });
  const espera = (pedido) =>
    new Promise((resolve) => {
      if (pedido.signal.aborted) return resolve(true);
      pedido.signal.addEventListener('abort', () => resolve(true), { once: true });
      liberada.then(() => resolve(false));
      return undefined;
    });
  return { espera, liberar };
}

function ambiente(t, { motor, paginas = {}, fetchPage: fetchPageProprio, exclusao, limits, briefService: briefServiceProprio, repository, now, crmSetup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const crmService = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: path.join(dir, 'crm.json') });
  const prospectingService = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath: path.join(dir, 'approval-queue.json'),
    crmService,
    batchPath: path.join(dir, 'prospecting-batches.json'),
    dossierPath: path.join(dir, 'prospecting-dossiers.json'),
  });
  const briefRepo = createInMemoryBriefRepository();
  const briefService = createProspectingBriefService({ authorizeProposer: authorizeProposerForLeadApproval, prospectingService, repository: briefRepo, now: () => AGORA, checkPermanentExclusion: exclusao });
  const paginasChamadas = [];
  const fetchPage = fetchPageProprio || (async (url) => {
    paginasChamadas.push(url);
    return paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' };
  });
  const jobs = repository || createInMemoryJobRepository();
  // o Brief Service real é congelado: o espião é um invólucro que registra o tamanho de CADA ingestão e repassa ao real
  const ingestoes = [];
  const espiao = {
    getBrief: briefService.getBrief,
    generateResearchPackage: briefService.generateResearchPackage,
    ingestFindings: async (...args) => {
      ingestoes.push(args[2].length);
      return briefService.ingestFindings(...args);
    },
  };
  const servico = createProspectingJobService({
    authorizeProposer: authorizeProposerForLeadApproval,
    briefService: briefServiceProprio ? briefServiceProprio(briefService) : espiao,
    repository: jobs,
    discoveryEngine: motor || motorFake(),
    createFetchPage: () => fetchPage,
    checkPermanentExclusion: exclusao,
    now: now || (() => new Date()),
    limits,
  });
  return { dir, crmService, prospectingService, briefService, briefRepo, jobs, servico, paginasChamadas, fetchPage, ingestoes };
}

async function briefPronto(env, input = {}) {
  const brief = await env.briefService.createBrief(admin(), briefInput(input));
  await env.briefService.markReadyForResearch(admin(), brief.id);
  return brief;
}

async function iniciar(env, input) {
  const brief = await briefPronto(env, input);
  const job = await env.servico.startJob(admin(), { briefId: brief.id });
  return { brief, job };
}

async function erroDe(fn) {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que lançasse, e não lançou');
}

const tresBons = () => [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), candidato('Clínica Gama', 'gama')];
const paginasBoas = () => ({ [siteDe('alfa')]: paginaBoa('Clínica Alfa', 'alfa'), [siteDe('beta')]: paginaBoa('Clínica Beta', 'beta'), [siteDe('gama')]: paginaBoa('Clínica Gama', 'gama'), [siteDe('delta')]: paginaBoa('Clínica Delta', 'delta') });

// ---------------------------------------------------------------------------------------------------------------------------------

test('[JOB-1] criação e início: o job nasce EXECUTANDO e devolve o id NA HORA; o brief vai a PESQUISANDO; o status é consultável e o job termina CONCLUIDO', async (t) => {
  const { espera, liberar } = esperaAteAbortar();
  const motor = motorFake({ rodadas: [{ candidatos: tresBons() }], espera });
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { brief, job } = await iniciar(env);

  assert.match(job.id, /^JOB-\d{8}-\d{3}$/);
  assert.deepEqual([job.briefId, job.status, job.requestedQuantity, job.cancelRequested, job.ingestionStarted, job.error], [brief.id, JOB_STATUS.EXECUTANDO, 3, false, false, null]);
  assert.ok(job.createdAt && job.startedAt && job.finishedAt === null);
  assert.equal((await env.briefService.getBrief(admin(), brief.id)).status, 'PESQUISANDO');
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

test('[JOB-2] validações da entrada: só { briefId }; brief inexistente; brief em RASCUNHO recusado; quem não tem PROPOSE:LEAD_APPROVAL não inicia', async (t) => {
  const env = ambiente(t);
  assert.equal((await erroDe(() => env.servico.startJob(admin(), {}))).code, 'JOB_INVALID_INPUT');
  assert.equal((await erroDe(() => env.servico.startJob(admin(), { briefId: 'PROS-20261006-001', extra: 1 }))).code, 'JOB_INVALID_INPUT');
  assert.equal((await erroDe(() => env.servico.startJob(admin(), { briefId: 'PROS-20261006-009' }))).code, 'BRIEF_NOT_FOUND');
  const rascunho = await env.briefService.createBrief(admin(), briefInput());
  const erro = await erroDe(() => env.servico.startJob(admin(), { briefId: rascunho.id }));
  assert.equal(erro.code, 'JOB_INVALID_STATE');
  assert.match(erro.message, /PRONTO_PARA_PESQUISA/);
  const pronto = await briefPronto(env);
  await erroDe(() => env.servico.startJob(closer(), { briefId: pronto.id })); // COMMERCIAL_CLOSER não tem PROPOSE:LEAD_APPROVAL
  assert.equal(env.jobs.list().length, 0, 'nenhum job foi criado nos casos recusados');
  assert.equal((await env.briefService.getBrief(admin(), pronto.id)).status, 'PRONTO_PARA_PESQUISA', 'e o brief continua intacto');
});

test('[JOB-3] limite de candidatos = quantidade x 2, no máximo ABSOLUTO de 40 — o motor nunca é pedido além disso, mesmo com limite sobrescrito', async (t) => {
  for (const [quantidade, esperado] of [[1, 2], [3, 6], [10, 20], [20, 40], [25, 40], [300, 40]]) {
    const motor = motorFake({ rodadas: [{ candidatos: [] }] });
    const env = ambiente(t, { motor });
    const { job } = await iniciar(env, { quantidade });
    await env.servico.waitFor(job.id);
    assert.equal(motor.pedidos[0].limit, esperado, `quantidade ${quantidade}`);
    assert.equal(env.jobs.getById(job.id).limits.maxCandidates, esperado);
  }
  // um limite sobrescrito acima de 40 é cortado em 40
  const motor = motorFake({ rodadas: [{ candidatos: [] }] });
  const env = ambiente(t, { motor, limits: { candidatesAbsoluteMax: 500 } });
  const { job } = await iniciar(env, { quantidade: 300 });
  await env.servico.waitFor(job.id);
  assert.equal(motor.pedidos[0].limit, 40);
});

test('[JOB-4] um motor que devolve candidatos DEMAIS é cortado no limite: nunca se examina mais do que quantidade x 2', async (t) => {
  const muitos = Array.from({ length: 30 }, (_, i) => candidato(`Clínica N${i}`, `n${i}`));
  const motor = motorFake({ rodadas: [{ candidatos: muitos }] });
  const motorGuloso = { pedidos: motor.pedidos, discover: async (pedido) => ({ ok: true, candidatos: muitos, invalidos: 0 }) };
  const env = ambiente(t, { motor: motorGuloso });
  const { job } = await iniciar(env, { quantidade: 2 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.candidatesDiscovered, 4);
  assert.equal(env.paginasChamadas.length, 4);
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

  // caminho oficial: o brief foi a AGUARDANDO_REVISAO com o lote real; os itens estão na fila para um HUMANO decidir; o CRM está vazio
  const depois = await env.briefService.getBrief(admin(), brief.id);
  assert.equal(depois.status, 'AGUARDANDO_REVISAO');
  const lote = env.prospectingService.getBatch(admin(), depois.loteRealId);
  assert.equal(lote.resultados.length, 3);
  assert.deepEqual([...new Set(lote.resultados.map((r) => r.estadoFila))], ['AGUARDANDO_REVISAO']);
  assert.equal((await env.crmService.listRecords(admin(), {})).length, 0, 'NENHUMA promoção automática ao CRM');
});

test('[JOB-6] PARCIAL: só 2 de 3 comprovados -> ingere SÓ os 2, nunca completa com candidato fraco; os não validados ficam NAO_VERIFICADO com o motivo e a causa técnica', async (t) => {
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
  assert.deepEqual([fim.candidatesDiscovered, fim.candidatesValidated, fim.candidatesRejected, fim.candidatesUnverified, fim.candidatesDiscarded], [5, 2, 3, 3, 0]);
  const porNome = Object.fromEntries(fim.candidatos.map((c) => [c.nome, c]));
  assert.equal(porNome['Clínica Fora'].resultado, CANDIDATE_RESULT.NAO_VERIFICADO);
  assert.equal(porNome['Clínica Fora'].motivo, CANDIDATE_REASON.PAGINA_INACESSIVEL);
  assert.equal(porNome['Clínica Fora'].causa, 'DNS', 'a causa técnica é preservada (nunca "empresa inexistente")');
  assert.deepEqual([porNome['Clínica Sem Nicho'].motivo, porNome['Clínica Sem Nicho'].faltando], [CANDIDATE_REASON.EVIDENCIA_INCOMPLETA, ['nicho']]);
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
  assert.match(recusa.message, /PRONTO_PARA_PESQUISA \(está em PESQUISANDO\)/);
  assert.equal(env.jobs.list().length, 1, 'nenhum segundo job foi criado');
  assert.deepEqual(env.ingestoes, [], 'e nada foi ingerido');
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
    briefService: (real) => ({ getBrief: real.getBrief, generateResearchPackage: real.generateResearchPackage, ingestFindings: async () => { throw new Error('C:\\segredo\\x falhou'); } }),
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
      generateResearchPackage: real.generateResearchPackage,
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

test('[JOB-15] ciclos: faltando válidos, um 2º ciclo pede mais candidatos (com os nomes já vistos); o máximo de ciclos é respeitado e a ingestão é UMA só', async (t) => {
  const rodadas = [{ candidatos: [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Fora', 'fora')] }, { candidatos: [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), candidato('Clínica Gama', 'gama')] }];
  const motor = motorFake({ rodadas });
  const env = ambiente(t, { motor, paginas: paginasBoas() });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(motor.pedidos.length, 2);
  assert.deepEqual(motor.pedidos[1].excluir, ['Clínica Alfa', 'Clínica Fora'], 'o 2º ciclo recebe só os NOMES já vistos');
  assert.equal(fim.cycles, 2);
  assert.equal(fim.candidatesDiscovered, 4, 'o repetido (mesmo nome e site) não conta duas vezes');
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual(env.ingestoes, [3], 'a ingestão é UMA só, mesmo com dois ciclos');

  const um = motorFake({ rodadas });
  const limitado = ambiente(t, { motor: um, paginas: paginasBoas(), limits: { maxCycles: 1 } });
  const { job: curto } = await iniciar(limitado, { quantidade: 3 });
  const fim2 = await limitado.servico.waitFor(curto.id);
  assert.equal(um.pedidos.length, 1, 'o limite de ciclos é respeitado');
  assert.equal(fim2.status, JOB_STATUS.PARCIAL);
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
  assert.equal(fim.telemetria.limitReached, 'TEMPO');
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

  const falha = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: [candidato('Clínica Alfa', 'alfa')] }] }), paginas: paginasBoas(), exclusao: async () => { throw new Error('banco fora'); } });
  const { job: segundo } = await iniciar(falha, { quantidade: 1 });
  const fim2 = await falha.servico.waitFor(segundo.id);
  assert.equal(fim2.candidatos[0].resultado, CANDIDATE_RESULT.NAO_VERIFICADO);
  assert.equal(fim2.candidatos[0].motivo, CANDIDATE_REASON.EXCLUSAO_NAO_CONSULTADA);
  assert.equal(falha.paginasChamadas.length, 0);
});

test('[JOB-18] DNC, duplicidade e exclusão no CAMINHO OFICIAL: o DNC e o duplicado do CRM não entram na fila, e nada é promovido', async (t) => {
  const env = ambiente(t, {
    motor: motorFake({ rodadas: [{ candidatos: [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), candidato('Clínica Gama', 'gama')] }] }),
    paginas: paginasBoas(),
  });
  // o CRM real já tem a Alfa em DO_NOT_CONTACT e a Beta como PROSPECT (mesmo site)
  const alfa = (await env.crmService.createRecord(admin(), { empresa: 'Alfa Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('alfa') })).record;
  await env.crmService.markDoNotContact(admin(), alfa.id, { reason: 'pediu para não ser contatado' });
  await env.crmService.createRecord(admin(), { empresa: 'Beta Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('beta') });

  const { brief, job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO, 'as 3 foram validadas pela página; o pipeline oficial decide o resto');
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

test('[JOB-20] persistência mínima: nenhum texto de página, prompt nem achado sobra no arquivo do job depois que ele termina; só contadores, resumos e a telemetria agregada', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons(), telemetria: { custoUsd: 0.2, webSearchRequests: 2 } }] }), paginas: paginasBoas() });
  const { job } = await iniciar(env);
  await env.servico.waitFor(job.id);
  const bruto = JSON.stringify(env.jobs.getById(job.id));
  assert.equal(bruto.includes(MARCADOR), false, 'o texto da página nunca é persistido');
  assert.doesNotMatch(bruto, /prompt|Responda APENAS|achadosValidados":\[\{/i);
  assert.deepEqual(env.jobs.getById(job.id).achadosValidados, []);
  assert.deepEqual(Object.keys(env.jobs.getById(job.id).candidatos[0]).sort(), ['nome', 'resultado', 'url']);
  assert.deepEqual(Object.keys(env.jobs.getById(job.id).telemetria).sort(), ['custoUsd', 'discoveryMs', 'discoveryRuns', 'limitReached', 'validationMs', 'webSearchRequests']);
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

test('[JOB-22] dependências obrigatórias: sem autorizador, brief service, repositório, motor ou leitor de página o Service não nasce; limites inválidos também', () => {
  const base = { authorizeProposer: authorizeProposerForLeadApproval, briefService: { getBrief() {}, generateResearchPackage() {}, ingestFindings() {} }, repository: createInMemoryJobRepository(), discoveryEngine: { discover() {} }, createFetchPage: () => () => {} };
  assert.ok(createProspectingJobService(base));
  for (const faltando of ['authorizeProposer', 'briefService', 'repository', 'discoveryEngine', 'createFetchPage']) {
    assert.throws(() => createProspectingJobService({ ...base, [faltando]: undefined }), undefined, faltando);
  }
  assert.throws(() => createProspectingJobService({ ...base, briefService: { getBrief() {} } }), /generateResearchPackage|ingestFindings/);
  assert.throws(() => createProspectingJobService({ ...base, checkPermanentExclusion: 'x' }), /checkPermanentExclusion/);
  assert.throws(() => createProspectingJobService({ ...base, limits: { maxCycles: 0 } }), /maxCycles/);
  assert.ok(Object.isFrozen(createProspectingJobService(base)));
  assert.ok(new ProspectingJobError('JOB_NOT_FOUND', 'x') instanceof Error);
});
