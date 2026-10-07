// Domínio do job de prospecção (prospectingJob.js) e o repositório de jobs (jobRepository.js) — funções puras e persistência local.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const job = require('../../src/research-prospector/prospectingJob');
const { createInMemoryJobRepository, createJsonFileJobRepository, assertValidJobRepository } = require('../../src/research-prospector/jobRepository');

test('[JOBDOM-1] o vocabulário de estados é o pedido, e ativo/terminal particionam os estados', () => {
  assert.deepEqual(Object.keys(job.JOB_STATUS), ['CRIADO', 'EXECUTANDO', 'CANCELAMENTO_SOLICITADO', 'CANCELADO', 'CONCLUIDO', 'PARCIAL', 'ERRO']);
  for (const status of Object.values(job.JOB_STATUS)) assert.notEqual(job.isActive(status), job.isTerminal(status), status);
  assert.deepEqual(job.ACTIVE_STATUSES, ['CRIADO', 'EXECUTANDO', 'CANCELAMENTO_SOLICITADO']);
  assert.ok(Object.isFrozen(job.JOB_STATUS) && Object.isFrozen(job.LIMITS));
});

test('[JOBDOM-2] limite de candidatos = quantidade x 2, no máximo 40 (e nunca menos de 1); sobrescritas nunca passam de 40', () => {
  assert.deepEqual([1, 2, 3, 10, 19, 20, 21, 100, 300].map((q) => job.computeCandidateLimit(q)), [2, 4, 6, 20, 38, 40, 40, 40, 40]);
  assert.equal(job.computeCandidateLimit(30, { absoluteMax: 1000 }), 40, 'o teto absoluto não é sobrescrevível para cima');
  assert.equal(job.computeCandidateLimit(30, { absoluteMax: 7 }), 7);
  assert.equal(job.computeCandidateLimit(3, { multiplier: 3 }), 9);
  for (const ruim of [0, -1, 1.5, '3', null, undefined, NaN]) assert.throws(() => job.computeCandidateLimit(ruim), /quantidade/);
});

test('[JOBDOM-3] id do job: JOB-AAAAMMDD-NNN, com a sequência do dia', () => {
  assert.equal(job.buildJobId(new Date('2026-10-06T23:59:00Z'), 7), 'JOB-20261006-007');
  assert.match(job.buildJobId(new Date('2026-01-02T00:00:00Z'), 123), job.JOB_ID_PATTERN);
  assert.doesNotMatch('JOB-1-1', job.JOB_ID_PATTERN);
});

const aspectos = (statuses) => ({ empresa: statuses[0], nicho: statuses[1], localizacao: statuses[2] });
const saida = (achados, relatorio = {}, verificacao) => ({ ok: true, achados, relatorio: { resultadosInvalidos: 0, causas: {}, falhas: {}, verificacoes: verificacao === undefined ? [] : [verificacao], ...relatorio } });
const lidaOk = (statuses) => ({ paginaOficial: true, ...aspectos(statuses) });

test('[JOBDOM-4] classifyResearch: VALIDADO só com a página oficial lida e os TRÊS vereditos VALIDADO; qualquer falta é NAO_VERIFICADO (nunca "incompatível")', () => {
  const bom = job.classifyResearch(saida([{ empresa: 'Clínica X' }], {}, lidaOk(['VALIDADO', 'VALIDADO', 'VALIDADO'])));
  assert.deepEqual([bom.resultado, bom.motivo], [job.CANDIDATE_RESULT.VALIDADO, null]);
  assert.deepEqual(bom.achado, { empresa: 'Clínica X' });
  for (const [statuses, faltando] of [[['VALIDADO', 'VALIDADO', 'NAO_VERIFICADO'], ['localizacao']], [['NAO_VERIFICADO', 'VALIDADO', 'VALIDADO'], ['empresa']], [['VALIDADO', 'NAO_VERIFICADO', 'NAO_VERIFICADO'], ['nicho', 'localizacao']], [['VALIDADO', 'VALIDADO', 'qualquer'], ['localizacao']]]) {
    const r = job.classifyResearch(saida([{ empresa: 'X' }], {}, lidaOk(statuses)));
    assert.deepEqual([r.resultado, r.motivo, r.faltando], [job.CANDIDATE_RESULT.NAO_VERIFICADO, job.CANDIDATE_REASON.EVIDENCIA_INCOMPLETA, faltando]);
    assert.equal('achado' in r, false);
  }
  // a página oficial não abriu: NAO_VERIFICADO com a causa técnica da primeira falha
  const semPagina = job.classifyResearch(saida([{ empresa: 'X' }], { causas: { TLS: 1, ROBOTS_BLOQUEIA: 2 } }, { paginaOficial: false }));
  assert.deepEqual([semPagina.resultado, semPagina.motivo, semPagina.causa], [job.CANDIDATE_RESULT.NAO_VERIFICADO, job.CANDIDATE_REASON.PAGINA_INACESSIVEL, 'TLS']);
  // sem veredito nenhum (porta sem texto) ou veredito malformado: nunca validado
  assert.equal(job.classifyResearch(saida([{ empresa: 'X' }])).resultado, job.CANDIDATE_RESULT.NAO_VERIFICADO);
  assert.equal(job.classifyResearch(saida([{ empresa: 'X' }], {}, 'lixo')).resultado, job.CANDIDATE_RESULT.NAO_VERIFICADO);
});

test('[JOBDOM-5] classifyResearch: sem achado, URL inválida = DESCARTADO; resposta do Researcher malformada = NAO_VERIFICADO; nunca lança', () => {
  assert.deepEqual(job.classifyResearch(saida([], { resultadosInvalidos: 1 })), { resultado: job.CANDIDATE_RESULT.DESCARTADO, motivo: job.CANDIDATE_REASON.URL_INVALIDA });
  assert.equal(job.classifyResearch(saida([], { causas: { DNS: 1 } })).causa, 'DNS');
  for (const lixo of [null, undefined, 5, 'x', {}, { ok: false }, { ok: true, achados: 'x', relatorio: {} }, { ok: true, achados: [], relatorio: null }]) {
    const r = job.classifyResearch(lixo);
    assert.deepEqual([r.resultado, r.motivo], [job.CANDIDATE_RESULT.NAO_VERIFICADO, job.CANDIDATE_REASON.VALIDACAO_FALHOU]);
  }
});

test('[JOBREPO-1] repositório em memória: list/getById/save com cópias independentes; id inseguro e objeto inválido recusados', () => {
  const repo = createInMemoryJobRepository([{ id: 'JOB-20261006-001', status: 'CRIADO' }]);
  assertValidJobRepository(repo);
  const lido = repo.getById('JOB-20261006-001');
  lido.status = 'MUDOU';
  assert.equal(repo.getById('JOB-20261006-001').status, 'CRIADO', 'cópia independente');
  repo.save({ id: 'JOB-20261006-002', status: 'ERRO' });
  assert.equal(repo.list().length, 2);
  assert.equal(repo.getById('nao-existe'), null);
  assert.equal(repo.getById(5), null);
  for (const ruim of [null, 'x', [], {}, { id: '' }, { id: '__proto__' }, { id: 'constructor' }]) assert.throws(() => repo.save(ruim), /Job de prospecção/);
  assert.throws(() => assertValidJobRepository({ list() {} }), /getById/);
});

test('[JOBREPO-2] repositório de ARQUIVO: sobrevive a um "refresh" (novo repositório sobre o mesmo arquivo), grava de forma atômica e recusa arquivo corrompido', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivo = path.join(dir, 'sub', 'jobs.json');
  const a = createJsonFileJobRepository(arquivo);
  assert.deepEqual(a.list(), [], 'sem arquivo = lista vazia (nada é criado só de ler)');
  assert.equal(fs.existsSync(arquivo), false);
  a.save({ id: 'JOB-20261006-001', status: 'EXECUTANDO', progress: 40 });
  a.save({ id: 'JOB-20261006-001', status: 'CONCLUIDO', progress: 100 });
  const b = createJsonFileJobRepository(arquivo);
  assert.deepEqual(b.getById('JOB-20261006-001'), { id: 'JOB-20261006-001', status: 'CONCLUIDO', progress: 100 });
  assert.deepEqual(fs.readdirSync(path.dirname(arquivo)), ['jobs.json'], 'nenhum temporário sobra');
  fs.writeFileSync(arquivo, '{ quebrado');
  assert.throws(() => b.list(), /corrompido/);
  fs.writeFileSync(arquivo, '[]');
  assert.throws(() => b.list(), /estrutura inválida/);
  assert.throws(() => createJsonFileJobRepository(''), /filePath/);
});

test('[JOBREPO-3] o caminho padrão é seguro: data/prospecting-jobs.json, dentro do repositório e ignorado pelo Git; criar o repositório com o padrão não cria arquivo', () => {
  const { DEFAULT_JOB_PATH } = require('../../src/research-prospector/jobRepository');
  const raiz = path.join(__dirname, '..', '..');
  assert.equal(path.relative(raiz, DEFAULT_JOB_PATH).split(path.sep).join('/'), 'data/prospecting-jobs.json');
  assert.match(fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8'), /^data\/\*\.json$/m);
});
