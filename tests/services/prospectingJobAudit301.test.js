'use strict';

// Auditoria final da 3.0.1: (1) os contadores distinguem fila, CRM, DNC e duplicidade sem dupla contagem; (2) uma falha na leitura do CRM não contorna as barreiras; (3) o limite de 30
// turnos preserva os dados parciais e SINALIZA a incompletude; (4) duas rodadas seguidas só de repetidos encerram sem apagar o que já foi entregue; (5) a lista enviada ao motor é compacta
// e sem dados pessoais. Peças REAIS (fila, CRM, pipeline, perfil); FAKES: motores e leitura de página. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { JOB_STATUS, STOP_REASON, ERROR_CODE } = require('../../src/research-prospector/prospectingJob');
const { buildPrompt: promptDeDescoberta } = require('../../src/prospecting-adapters/claudeDiscoveryEngine');
const { createClaudeEnrichmentEngine } = require('../../src/prospecting-adapters/claudeEnrichmentEngine');
const { createKnownLeadIdentities } = require('../../src/services/knownLeadIdentities');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { admin } = require('../helpers/promotionFixtures');
const { siteDe, paginaBoa, candidato, motorFake, ambiente, iniciar, paginasBoas, tresBons } = require('../helpers/jobFixtures');

const filaDe = (env) => createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: path.join(env.dir, 'approval-queue.json') }).listQueue(admin());
const paginas = () => ({ ...paginasBoas(), [siteDe('delta')]: paginaBoa('Clínica Delta', 'delta'), [siteDe('epsilon')]: paginaBoa('Clínica Epsilon', 'epsilon'), [siteDe('zeta')]: paginaBoa('Clínica Zeta', 'zeta') });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1) contadores
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[AUD-1] os contadores distinguem FILA, CRM (duplicado) e DNC já na pré-filtragem, cada lead UMA vez, sem apagar a classificação de segurança', async (t) => {
  const motor = motorFake({ rodadas: [{ candidatos: tresBons() }, { candidatos: [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Delta', 'delta'), candidato('Clínica Epsilon', 'epsilon'), candidato('Clínica Alfa', 'alfa'), candidato('Clínica Zeta', 'zeta')] }] });
  const env = ambiente(t, { motor, paginas: paginas(), conhecidos: true });
  const { job: primeiro } = await iniciar(env, { quantidade: 3 });
  await env.servico.waitFor(primeiro.id);
  await env.crmService.createRecord(admin(), { empresa: 'Delta Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('delta') }); // duplicado do CRM
  const bloqueada = (await env.crmService.createRecord(admin(), { empresa: 'Epsilon Bloqueada', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('epsilon') })).record;
  await env.crmService.markDoNotContact(admin(), bloqueada.id, { reason: 'pediu para sair' }); // DNC

  const { job } = await iniciar(env, { quantidade: 1 });
  const fim = await env.servico.waitFor(job.id);
  const r = fim.resumo;
  assert.deepEqual([r.jaExistentes, r.duplicados, r.dnc], [1, 1, 1], 'Alfa = já na fila; Delta = duplicado do CRM; Epsilon = DNC — cada um no seu contador');
  assert.deepEqual([r.repetidosNaFila, r.repetidosDuplicados, r.repetidosDnc, r.repetidosNoJob], [1, 1, 1, 0]);
  assert.equal(fim.telemetria.candidatosRepetidos, 4, '4 devoluções repetidas do motor (a Alfa voltou duas vezes)...');
  assert.equal(r.jaExistentes + r.duplicados + r.dnc, 3, '...que são 3 leads distintos: o mesmo lead não é contado duas vezes');
  assert.deepEqual([r.naApprovalQueue, r.validados], [1, 1], 'só a Zeta é entrega nova');
  assert.equal(fim.telemetria.jaEstavamNaFila, 0, 'os filtrados nunca chegaram ao pipeline');
  // nenhum deles foi lido nem validado
  for (const slug of ['alfa', 'delta', 'epsilon']) assert.equal(env.paginasChamadas.filter((url) => url === siteDe(slug)).length, slug === 'alfa' ? 1 : 0, slug);
  assert.equal(filaDe(env).length, 4);
});

test('[AUD-2] um item da Approval Queue em DNC/DUPLICADO e o mesmo lead na fila E no CRM: vale a categoria MAIS RESTRITIVA (dnc > duplicado > fila)', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }), paginas: paginas(), conhecidos: true });
  const { job } = await iniciar(env, { quantidade: 3 });
  await env.servico.waitFor(job.id);
  const bloqueada = (await env.crmService.createRecord(admin(), { empresa: 'Alfa no CRM', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('alfa') })).record;
  await env.crmService.markDoNotContact(admin(), bloqueada.id, { reason: 'x' });
  const lido = await createKnownLeadIdentities({ queuePath: path.join(env.dir, 'approval-queue.json'), crmService: env.crmService })(admin(), { cidade: 'Petrópolis' });
  const categorias = Object.fromEntries(lido.identidades.filter((i) => i.dominio).map((i) => [i.dominio, i.categoria]));
  assert.equal(categorias['alfa.com.br'], 'dnc', 'na fila (fila) + no CRM bloqueado (dnc) = dnc');
  assert.equal(categorias['beta.com.br'], 'fila');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2) falha na leitura do CRM
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[AUD-3] se a lista de conhecidos não puder ler o CRM, o filtro de economia só deixa de filtrar — o DNC e o duplicado do CRM continuam barrados pelo PIPELINE', async (t) => {
  let env;
  const provedor = (context, consulta) => createKnownLeadIdentities({ queuePath: path.join(env.dir, 'approval-queue.json'), crmService: { listRecords: async () => { throw new Error('CRM ilegível'); } } })(context, consulta);
  env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), candidato('Clínica Gama', 'gama')] }, { candidatos: [] }] }), paginas: paginas(), conhecidos: provedor });
  const bloqueada = (await env.crmService.createRecord(admin(), { empresa: 'Alfa Bloqueada', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('alfa') })).record;
  await env.crmService.markDoNotContact(admin(), bloqueada.id, { reason: 'x' });
  await env.crmService.createRecord(admin(), { empresa: 'Beta Antiga', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('beta') });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.telemetria.conhecidos.indisponivel, true, 'o job registra que o filtro não funcionou');
  const porNome = Object.fromEntries(fim.candidatos.map((c) => [c.nome, c.entrega]));
  assert.deepEqual([porNome['Clínica Alfa'].naFila, porNome['Clínica Alfa'].estadoOperacional], [false, 'DNC'], 'o DNC chegou ao pipeline e foi barrado');
  assert.deepEqual([porNome['Clínica Beta'].naFila, porNome['Clínica Beta'].estadoOperacional], [false, 'DUPLICADO']);
  assert.equal(porNome['Clínica Gama'].naFila, true);
  assert.deepEqual([fim.resumo.dnc, fim.resumo.duplicados, fim.resumo.naApprovalQueue], [1, 1, 1]);
  assert.equal(filaDe(env).some((i) => i.empresa === 'Clínica Alfa' && i.estado === 'AGUARDANDO_REVISAO'), false);
});

test('[AUD-4] CRM realmente ilegível (arquivo corrompido): o filtro segue sem ele e o PIPELINE falha FECHADO — ERRO de ingestão, nada entregue, nada promovido', async (t) => {
  const motor = motorFake({ rodadas: [{ candidatos: tresBons() }] });
  const env = ambiente(t, { motor, paginas: paginas(), conhecidos: true });
  fs.writeFileSync(path.join(env.dir, 'crm.json'), '{ isto não é json');
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.telemetria.conhecidos.indisponivel, true);
  assert.equal(fim.status, JOB_STATUS.ERRO);
  assert.equal(fim.error.code, ERROR_CODE.INGESTION_FAILED);
  assert.equal(filaDe(env).length, 0, 'nada entrou na fila sem poder checar DNC/duplicidade');
  assert.equal(fim.leadsNaFila, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3) limite de turnos
// ---------------------------------------------------------------------------------------------------------------------------------------------

// AUD-5/6/7 (limite de turnos: parcial preservado, incompletude sinalizada, FALHOU com pendências) migraram para tests/services/leadEnrichment.test.js (DEM-2, DEM-6): desde a 3.0.2 o
// enriquecimento é sob demanda e não faz parte do job.

// o executor: como o Claude Code informa o limite de turnos
function spawnFake(saida, codigo = 0) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.pid = 1;
    child.kill = () => {};
    child.stdin = { on() {}, end() { setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(saida))); child.emit('close', codigo); }); } };
    return child;
  };
}
const bloco = (leads) => `\`\`\`json\n${JSON.stringify({ leads })}\n\`\`\``;
const LEAD = [{ nome: 'Clínica Beta', cidade: 'Petrópolis' }];

test('[AUD-8] o executor trata error_max_turns como desfecho esperado: o parcial volta com limiteDeTurnos (mesmo com saída != 0); sem parcial, MAX_TURNS; fora disso os erros de sempre', async () => {
  const comParcial = { is_error: true, subtype: 'error_max_turns', num_turns: 30, result: bloco([{ nome: 'Clínica Beta', emails: [{ email: 'a@b.com', origem: 'https://beta.com.br/' }] }]), total_cost_usd: 0.2 };
  for (const codigo of [0, 1]) {
    const r = await createClaudeEnrichmentEngine({ spawn: spawnFake(comParcial, codigo), platform: 'linux' }).enrich({ leads: LEAD });
    assert.equal(r.ok, true, `código ${codigo}`);
    assert.equal(r.limiteDeTurnos, true);
    assert.deepEqual(r.resultados[0].emails, [{ email: 'a@b.com', origem: 'https://beta.com.br/' }], 'o parcial é preservado');
    assert.equal(r.custoUsd, 0.2);
  }
  const semParcial = await createClaudeEnrichmentEngine({ spawn: spawnFake({ is_error: true, subtype: 'error_max_turns', num_turns: 30 }, 1), platform: 'linux' }).enrich({ leads: LEAD });
  assert.deepEqual([semParcial.ok, semParcial.code, semParcial.limiteDeTurnos], [false, 'MAX_TURNS', true]);
  const normal = await createClaudeEnrichmentEngine({ spawn: spawnFake({ is_error: false, num_turns: 5, result: bloco([{ nome: 'Clínica Beta' }]) }), platform: 'linux' }).enrich({ leads: LEAD });
  assert.deepEqual([normal.ok, 'limiteDeTurnos' in normal], [true, false]);
  const noLimite = await createClaudeEnrichmentEngine({ spawn: spawnFake({ is_error: false, num_turns: 8, result: bloco([{ nome: 'Clínica Beta' }]) }), platform: 'linux' }).enrich({ leads: LEAD });
  // num_turns >= --max-turns NÃO é limite (o Claude Code conta de outro jeito): um término normal só ganha o aviso `proximoDoLimite`; o limite é o subtype error_max_turns
  assert.deepEqual([noLimite.ok, 'limiteDeTurnos' in noLimite, noLimite.proximoDoLimite], [true, false, true], '8 turnos = 6 + 2 x 1 lead: terminou normalmente');
  assert.deepEqual(await createClaudeEnrichmentEngine({ spawn: spawnFake({ is_error: true, result: 'x' }, 0), platform: 'linux' }).enrich({ leads: LEAD }), { ok: false, code: 'AGENT_ERROR' });
  assert.deepEqual(await createClaudeEnrichmentEngine({ spawn: spawnFake({ is_error: false, result: 'x' }, 2), platform: 'linux' }).enrich({ leads: LEAD }), { ok: false, code: 'EXIT_NONZERO' });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4) duas rodadas seguidas só de repetidos
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[AUD-9] duas rodadas SEGUIDAS só de repetidos encerram a execução (PARCIAL, SEM_CANDIDATOS_NOVOS) sem apagar o que já foi entregue, validado ou descoberto', async (t) => {
  const alfa = () => candidato('Clínica Alfa', 'alfa');
  const motor = motorFake({ rodadas: [{ candidatos: [alfa()] }, { candidatos: [alfa()] }, { candidatos: [alfa()] }, { candidatos: [candidato('Clínica Beta', 'beta')] }] });
  const env = ambiente(t, { motor, paginas: paginas(), conhecidos: true });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(motor.pedidos.length, 3, 'a 4ª chamada (que traria a Beta) nunca acontece');
  assert.equal(fim.status, JOB_STATUS.PARCIAL);
  assert.equal(fim.telemetria.limitReached, STOP_REASON.SEM_CANDIDATOS_NOVOS);
  assert.deepEqual([fim.lote.naFila, fim.lote.validadosPeloMotor, fim.leadsNaFila], [1, 1, 1], 'o que foi entregue antes continua no resultado');
  assert.equal(fim.candidatos.length, 1);
  assert.equal(fim.candidatos[0].entrega.naFila, true);
  assert.equal(filaDe(env).length, 1, 'e continua na Approval Queue');
  assert.equal(fim.telemetria.conhecidos.rodadasSoRepetidos, 2);
});

test('[AUD-10] rodadas de repetidos NÃO seguidas não encerram: repetido, novo, repetido, novo... (a contagem recomeça a cada rodada com candidato novo)', async (t) => {
  const c = (n, s) => candidato(n, s);
  const motor = motorFake({ rodadas: [{ candidatos: [c('Clínica Alfa', 'alfa')] }, { candidatos: [c('Clínica Alfa', 'alfa')] }, { candidatos: [c('Clínica Beta', 'beta')] }, { candidatos: [c('Clínica Beta', 'beta')] }, { candidatos: [c('Clínica Gama', 'gama')] }] });
  const env = ambiente(t, { motor, paginas: paginas(), conhecidos: true });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(motor.pedidos.length, 5);
  assert.deepEqual([fim.resumo.naApprovalQueue, fim.telemetria.candidatosRepetidos], [3, 2]);
  assert.equal(fim.telemetria.conhecidos.rodadasSoRepetidos, 2, 'duas rodadas só de repetidos, mas NÃO seguidas');
  assert.equal(fim.telemetria.conhecidos.repetidos, 0, 'repetidos do próprio job (não da fila/CRM)');
  assert.equal(fim.resumo.repetidosNoJob, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 5) compacta e sem dados pessoais
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[AUD-11] a lista enviada ao motor tem SÓ nome, cidade/UF, domínio e Instagram: nenhum telefone, e-mail, WhatsApp, endereço, categoria de segurança, responsável nem texto', async (t) => {
  const motor = motorFake({ rodadas: [{ candidatos: [candidato('Clínica Delta', 'delta')] }] });
  const env = ambiente(t, { motor, paginas: paginas(), conhecidos: true });
  const registro = (await env.crmService.createRecord(admin(), { empresa: 'Clínica Sigilosa', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Estética', site: siteDe('sigilosa'), instagram: '@sigilosa', telefone: '(24) 97777-6655', email: 'privado@sigilosa.com.br' })).record;
  await env.crmService.markDoNotContact(admin(), registro.id, { reason: 'pediu para sair' });
  const { job } = await iniciar(env, { quantidade: 1 });
  await env.servico.waitFor(job.id);
  const lista = motor.pedidos[0].conhecidos;
  const sigilosa = lista.find((i) => i.nome === 'Clínica Sigilosa');
  assert.deepEqual(sigilosa, { nome: 'Clínica Sigilosa', cidade: 'Petrópolis', uf: 'RJ', dominio: 'sigilosa.com.br', instagram: 'sigilosa' });
  const serializado = JSON.stringify(motor.pedidos[0]);
  for (const proibido of ['97777', 'privado@', 'categoria', 'dnc', 'DO_NOT_CONTACT', 'pediu para sair']) assert.equal(serializado.includes(proibido), false, proibido);
  const prompt = promptDeDescoberta({ nicho: 'Estética', cidade: 'Petrópolis', limit: 6, conhecidos: lista });
  for (const proibido of ['97777', 'privado@', 'DO_NOT_CONTACT']) assert.equal(prompt.includes(proibido), false, proibido);
  assert.match(prompt, /Clínica Sigilosa \| sigilosa\.com\.br \| @sigilosa/);
  assert.ok(Math.max(...lista.map((i) => JSON.stringify(i).length)) < 200, 'cada identidade é curta');
});

test('[AUD-12] o executor distingue LIMITE DE USO do Claude de um erro qualquer (para a tela dizer "limite de uso atingido")', async () => {
  const motor = (saida, codigo) => createClaudeEnrichmentEngine({ spawn: spawnFake(saida, codigo), platform: 'linux' }).enrich({ leads: LEAD });
  for (const texto of ['Claude AI usage limit reached|1760000000', 'You have hit your usage limit', 'rate limit exceeded', 'quota exceeded']) {
    assert.deepEqual(await motor({ is_error: true, result: texto }, 1), { ok: false, code: 'USAGE_LIMIT' }, texto);
    assert.deepEqual(await motor({ is_error: true, result: texto }, 0), { ok: false, code: 'USAGE_LIMIT' }, texto);
  }
  assert.deepEqual(await motor({ is_error: true, result: 'algum outro erro' }, 1), { ok: false, code: 'EXIT_NONZERO' });
  assert.deepEqual(await motor({ is_error: true, result: 'algum outro erro' }, 0), { ok: false, code: 'AGENT_ERROR' });
});
