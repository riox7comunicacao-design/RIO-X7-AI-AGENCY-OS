// A COMPOSIÇÃO do job de prospecção em src/server/index.js (createServer — Fase 2): as rotas existem e são protegidas, o arquivo é o de
// RIO_X7_PROSPECTING_JOBS_PATH, e um job que ficou ativo quando o servidor caiu é marcado como INTERROMPIDO na subida (nunca finge ter concluído).
// Só a borda de rede do Supabase é falsa; nenhum `claude`, nenhuma pesquisa. Nenhum teste aqui lê ou escreve o data/ real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createServer } = require('../../src/server');
const { FAKE_ENV, fakeAccessToken, installFakeSupabaseAuth, supabaseUserBody } = require('../helpers/authFixtures');
const { BRENO, RAFAEL } = require('./testEnv');

function requisicao({ method = 'GET', url, token }) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  return req;
}

test('[JOB-COMP-1] createServer liga o job: rotas protegidas (401/403/200), o arquivo de RIO_X7_PROSPECTING_JOBS_PATH e a recuperação de um job deixado ativo por um processo que morreu', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-composition-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usersFile = path.join(dir, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify([BRENO, RAFAEL]));
  const tokens = { breno: fakeAccessToken('job-comp-breno'), rafael: fakeAccessToken('job-comp-rafael') };
  installFakeSupabaseAuth(t, {
    [tokens.breno]: supabaseUserBody({ authUserId: BRENO.authUserId, email: BRENO.email }),
    [tokens.rafael]: supabaseUserBody({ authUserId: RAFAEL.authUserId, email: RAFAEL.email }),
  });
  const jobsFile = path.join(dir, 'jobs.json');
  // um job que o processo anterior (já morto) deixou EXECUTANDO — um PID que não existe
  fs.writeFileSync(jobsFile, JSON.stringify({ 'JOB-20261006-001': { id: 'JOB-20261006-001', briefId: 'PROS-20261006-001', status: 'EXECUTANDO', createdAt: '2026-10-06T12:00:00.000Z', startedAt: '2026-10-06T12:00:01.000Z', finishedAt: null, processId: 2147483646, ingestionStarted: false, progress: 40, currentStep: 'VALIDANDO', candidatos: [], achadosValidados: [{ empresa: 'X' }] } }));
  const env = {
    ...FAKE_ENV,
    RIO_X7_USERS_FILE: usersFile,
    RIO_X7_QUEUE_PATH: path.join(dir, 'approval-queue.json'),
    RIO_X7_CRM_PATH: path.join(dir, 'crm.json'),
    RIO_X7_FUNNELS_PATH: path.join(dir, 'funnels.json'),
    RIO_X7_PROSPECTING_BRIEFS_PATH: path.join(dir, 'briefs.json'),
    RIO_X7_PROSPECTING_JOBS_PATH: jobsFile,
  };
  const { app } = createServer(env, { log: () => {} });

  const recuperado = JSON.parse(fs.readFileSync(jobsFile, 'utf8'))['JOB-20261006-001'];
  assert.equal(recuperado.status, 'ERRO');
  assert.equal(recuperado.error.code, 'JOB_INTERRUPTED');
  assert.ok(recuperado.finishedAt);
  assert.deepEqual(recuperado.achadosValidados, [], 'os achados internos não sobram');

  const chamar = async (opcoes) => {
    const r = await app.handle(requisicao(opcoes));
    return { status: r.status, json: () => JSON.parse(r.body) };
  };
  assert.equal((await chamar({ url: '/api/prospecting/jobs' })).status, 401, 'a rota existe (não é 404) e exige token');
  assert.equal((await chamar({ url: '/api/prospecting/jobs', token: tokens.rafael })).status, 403, 'COMMERCIAL_CLOSER não tem PROPOSE:LEAD_APPROVAL');
  const lista = await chamar({ url: '/api/prospecting/jobs', token: tokens.breno });
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.json().items.map((job) => [job.id, job.status]), [['JOB-20261006-001', 'ERRO']]);
  const status = await chamar({ url: '/api/prospecting/jobs/JOB-20261006-001/status', token: tokens.breno });
  assert.equal(status.json().item.error.code, 'JOB_INTERRUPTED');
});

test('[JOB-COMP-2] o ambiente do servidor não vaza para o motor: a composição entrega ao motor `env` e o motor repassa só a lista mínima (sem Supabase, CRM nem chave de API)', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server', 'index.js'), 'utf8');
  assert.match(codigo, /createFileBackedProspectingJobService\(\{[\s\S]*?\benv,[\s\S]*?\}\)/);
  assert.match(codigo, /prospectingJobService\.recoverInterruptedJobs\(\)/);
  assert.match(codigo, /createApp\(\{[^}]*\bprospectingJobService,/);
});
