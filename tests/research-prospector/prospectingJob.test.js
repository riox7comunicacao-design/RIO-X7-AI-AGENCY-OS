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

test('[JOBDOM-2] tamanho do ciclo de descoberta: clamp(faltam x 3, 6, 12), nunca além do que ainda cabe no teto absoluto de 50 (padrão, até 100); a quantidade pedida NÃO define o teto', () => {
  assert.equal(job.LIMITS.MAX_CANDIDATES, 50);
  assert.equal(job.LIMITS.MAX_CANDIDATES_CAP, 100);
  assert.equal(job.LIMITS.MAX_CYCLES, 6);
  assert.deepEqual([job.LIMITS.BATCH_MULTIPLIER, job.LIMITS.BATCH_MIN, job.LIMITS.BATCH_MAX], [3, 6, 12]);
  // 3 solicitados: o 1º ciclo é 9; 10 solicitados: 12 (o teto do ciclo)
  assert.equal(job.computeBatchSize(3, 0), 9);
  assert.equal(job.computeBatchSize(10, 0), 12);
  // adaptativo: o que falta manda (mínimo 6, máximo 12)
  assert.deepEqual([[3, 1], [3, 2], [3, 3], [10, 9], [10, 0], [100, 5], [1, 0], [1, 1]].map(([q, v]) => job.computeBatchSize(q, v)), [6, 6, 6, 6, 12, 12, 6, 6]);
  // o último ciclo só pede o que ainda cabe nos 50
  assert.deepEqual([46, 40, 49, 50].map((usados) => job.computeBatchSize(3, 0, {}, 50 - usados)), [4, 9, 1, 0]);
  assert.equal(job.computeBatchSize(300, 0, {}, 50), 12, 'a quantidade pedida não aumenta o ciclo além de 12');
  assert.equal(job.computeBatchSize(3, 0, { multiplier: 2, min: 3, max: 5 }), 5);
  for (const ruim of [0, -1, 1.5, '3', null, undefined, NaN]) assert.throws(() => job.computeBatchSize(ruim, 0), /quantidade/);
  for (const ruim of [-1, 1.5, '1', null]) assert.throws(() => job.computeBatchSize(3, ruim), /validated/);
});

test('[JOBDOM-3] id do job: JOB-AAAAMMDD-NNN, com a sequência do dia', () => {
  assert.equal(job.buildJobId(new Date('2026-10-06T23:59:00Z'), 7), 'JOB-20261006-007');
  assert.match(job.buildJobId(new Date('2026-01-02T00:00:00Z'), 123), job.JOB_ID_PATTERN);
  assert.doesNotMatch('JOB-1-1', job.JOB_ID_PATTERN);
});

const v = (status, evidencia = 'trecho', regra = 'nome') => ({ status, evidencia: status === 'VALIDADO' ? evidencia : null, regra: status === 'VALIDADO' ? regra : null });
const veredito = (e, n, l) => ({ empresa: v(e), nicho: v(n, 'estética', 'termo_nicho'), localizacao: v(l, 'Petrópolis', 'cidade') });
const lida = (url, tipo, e, n, l) => ({ origem: { url, tipo }, veredito: veredito(e, n, l) });
const caida = (url, tipo, causa) => ({ origem: { url, tipo }, falha: 'FORA_DO_AR', causa });
const V = 'VALIDADO';
const N = 'NAO_VERIFICADO';

test('[JOBDOM-4] decideLead: VALIDADO exige UMA página que comprove os TRÊS aspectos; o site oficial NÃO é requisito (a página pode ser de um diretório ou de uma matéria)', () => {
  const oficial = job.decideLead([lida('https://alfa.com.br/', 'OFICIAL', V, V, V)]);
  assert.deepEqual([oficial.resultado, oficial.motivo, oficial.fonteDaValidacao], [job.CANDIDATE_RESULT.VALIDADO, null, { url: 'https://alfa.com.br/', tipo: 'OFICIAL' }]);
  assert.deepEqual([oficial.empresa, oficial.nicho, oficial.localizacao], [V, V, V]);
  assert.deepEqual(oficial.evidencias.localizacao, { trecho: 'Petrópolis', regra: 'cidade' });
  const semSite = job.decideLead([lida('https://guiamais.com.br/x', 'DIRETORIO', V, V, V)]);
  assert.equal(semSite.resultado, job.CANDIDATE_RESULT.VALIDADO);
  assert.equal(semSite.fonteDaValidacao.tipo, 'DIRETORIO');
  const materia = job.decideLead([caida('https://alfa.com.br/', 'NOTICIA_OU_TERCEIRO', 'DNS'), lida('https://portal.com.br/m', 'NOTICIA_OU_TERCEIRO', V, V, V)]);
  assert.deepEqual([materia.resultado, materia.fonteDaValidacao.tipo], [job.CANDIDATE_RESULT.VALIDADO, 'NOTICIA_OU_TERCEIRO']);
});

test('[JOBDOM-4b] decideLead: os aspectos NUNCA são completados entre páginas diferentes; sem nicho ou sem localização = NAO_VERIFICADO, com o que faltou e o melhor estado parcial', () => {
  const duas = job.decideLead([lida('https://a.com.br/', 'OFICIAL', V, V, N), lida('https://b.com.br/', 'DIRETORIO', V, N, V)]);
  assert.equal(duas.resultado, job.CANDIDATE_RESULT.NAO_VERIFICADO, 'empresa+nicho numa página e empresa+cidade noutra NÃO somam');
  assert.equal(duas.motivo, job.CANDIDATE_REASON.EVIDENCIA_INCOMPLETA);
  assert.deepEqual([duas.empresa, duas.nicho, duas.localizacao, duas.faltando], [V, V, N, ['localizacao']], 'o melhor estado parcial (a 1ª das duas, que empata, fica)');
  for (const [estados, faltando] of [[[V, V, N], ['localizacao']], [[V, N, V], ['nicho']], [[N, V, V], ['empresa']], [[V, N, N], ['nicho', 'localizacao']]]) {
    const r = job.decideLead([lida('https://a.com.br/', 'OFICIAL', ...estados)]);
    assert.deepEqual([r.resultado, r.faltando], [job.CANDIDATE_RESULT.NAO_VERIFICADO, faltando]);
    assert.equal('fonteDaValidacao' in r, false);
  }
});

test('[JOBDOM-5] decideLead: sem página legível = NAO_VERIFICADO com a causa técnica (DNS, TLS...) — nunca "empresa inexistente"; sem nenhuma fonte = SEM_FONTE_VERIFICAVEL; entradas malformadas nunca lançam', () => {
  const dns = job.decideLead([caida('https://a.com.br/', 'NOTICIA_OU_TERCEIRO', 'DNS'), caida('https://b.com.br/', 'DIRETORIO', 'TLS')]);
  assert.deepEqual([dns.resultado, dns.motivo, dns.causa, dns.faltando], [job.CANDIDATE_RESULT.NAO_VERIFICADO, job.CANDIDATE_REASON.PAGINA_INACESSIVEL, 'DNS', ['empresa', 'nicho', 'localizacao']]);
  assert.doesNotMatch(JSON.stringify(dns), /inexistente|n[ãa]o existe/i);
  const nada = job.decideLead([]);
  assert.deepEqual([nada.resultado, nada.motivo], [job.CANDIDATE_RESULT.NAO_VERIFICADO, job.CANDIDATE_REASON.SEM_FONTE_VERIFICAVEL]);
  for (const lixo of [null, undefined, 5, 'x', {}, [null, 5, 'x'], [{ veredito: 'lixo' }], [{ origem: {}, veredito: null }]]) {
    const r = job.decideLead(lixo);
    assert.equal(r.resultado, job.CANDIDATE_RESULT.NAO_VERIFICADO);
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
