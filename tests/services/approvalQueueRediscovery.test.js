'use strict';

// Fase 2B-3.2A — a PROTEÇÃO DO SNAPSHOT DA FILA, provada pelos fluxos REAIS (decisão 0016): reenvio manual (Workbench), fluxo do job de prospecção,
// promoção para o CRM (idempotência e reconciliação), reaprovação de um lead reprovado e a tela de Leads Reprovados.
//
// O que se prova aqui, e não no teste do domínio: o que o humano aprovou é o que a promoção manda ao CRM, mesmo que a pesquisa volte com outros
// dados; uma pesquisa mais limpa nunca remove um DNC do snapshot (e, portanto, nunca reabre a promoção); a decisão humana continua à vista;
// as barreiras de deduplicação e de Exclusão Permanente continuam as mesmas.
//
// Peças REAIS: a fila (domínio e Services), o pipeline de descoberta, o Prospecting Service, o CRM Service sobre o adapter de arquivo, as pontes de
// autorização. Tudo em DIRETÓRIO TEMPORÁRIO (removido ao fim de cada teste), dados fictícios (example.test), nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queueDomain = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');
const { authorizeProposerForLeadApproval, authorizeReviewerForApprovalQueue, authorizeCrmOperation } = require('../../src/auth');
const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createLeadReconsiderationService } = require('../../src/services/leadReconsiderationService');
const { createCrmIntegrationService, PROMOTION_OUTCOME, PROMOTION_ERROR } = require('../../src/services/crmIntegrationService');
const { JOB_STATUS } = require('../../src/research-prospector/prospectingJob');
const { admin, closer, criarServicos } = require('../helpers/promotionFixtures');
const { siteDe, paginaBoa, candidato, motorFake, ambiente: ambienteDeJob, iniciar, paginasBoas } = require('../helpers/jobFixtures');

const { QUEUE_STATE, REDISCOVERY_HISTORY_TYPE } = queueDomain;
const SITE = 'clinica-demo.example.test';

const A = { cidade: 'Petrópolis', nicho: 'Psicologia', telefone: '(24) 90000-0001', instagram: '@clinica_demo_a', fonte: 'https://fonte-a.example.test/pagina' };
const B = { cidade: 'Niterói', nicho: 'Estética', telefone: '(21) 90000-0002', instagram: '@clinica_demo_b', fonte: 'https://fonte-b.example.test/outra' };

const ev = (valor) => ({ valor, fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' });
const achadoManual = (v) => ({
  empresa: 'Clínica Exemplo Demonstração',
  tipo: 'clínica',
  cidade: v.cidade,
  estado: 'RJ',
  nicho: v.nicho,
  campos: { site: [ev(SITE)], telefone: [ev(v.telefone)], instagram: [ev(v.instagram)] },
  fontes: [v.fonte],
});
const submissao = (v) => ({ briefing: { nicho: v.nicho, quantidadeDesejada: 3, regiao: `${v.cidade}/RJ`, tipo: 'clínica', exclusoes: [], observacoes: 'lote de teste' }, rawFindings: [achadoManual(v)] });
const clone = (valor) => JSON.parse(JSON.stringify(valor));

// Um ambiente: a fila e o CRM em arquivos temporários; o Prospecting Service (reenvio manual) e os Services da fila/promoção sobre os MESMOS arquivos.
function novoEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-rediscovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, 'approval-queue.json');
  const crmPath = path.join(dir, 'crm.json');
  const crmService = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: crmPath });
  const prospecting = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath,
    crmService,
    batchPath: path.join(dir, 'prospecting-batches.json'),
    dossierPath: path.join(dir, 'prospecting-dossiers.json'),
  });
  const { fila, promocao, integracao } = criarServicos(queuePath, crmPath);
  const lerFila = () => JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const env = {
    dir,
    queuePath,
    crmPath,
    crm: crmService,
    fila,
    promocao,
    integracao,
    lerFila,
    textoDaFila: () => fs.readFileSync(queuePath, 'utf8'),
    textoDoCrm: () => (fs.existsSync(crmPath) ? fs.readFileSync(crmPath, 'utf8') : ''),
    registrosDoCrm: () => Object.values(fs.existsSync(crmPath) ? JSON.parse(fs.readFileSync(crmPath, 'utf8')) : {}),
    submeter: (v) => prospecting.submitProspecting(admin(), submissao(v)),
    item: () => Object.values(lerFila().items)[0],
    // a redescoberta REAL do domínio sobre o arquivo (o mesmo caminho do INT-26): para o que o pipeline do reenvio manual não deixa chegar à fila
    redescobrirNoArquivo: (resultado) => {
      const fila_ = queueDomain.loadQueueFromDisk(queuePath);
      queueDomain.addProspect(fila_, resultado);
      queueDomain.saveQueueToDisk(fila_, queuePath);
    },
    reprovados: () => createLeadReconsiderationService({ authorizeReviewer: authorizeReviewerForApprovalQueue, crmService, queuePath }),
  };
  return env;
}

// O mesmo achado (o mesmo site) como resultado do pipeline, com crmRecords opcionais (para um DNC visto no CRM).
const resultadoDaPesquisa = (v, crmRecords = []) =>
  runDiscoveryPipeline({ briefing: { nicho: v.nicho, regiao: `${v.cidade}/RJ`, quantidadeDesejada: 3, exclusoes: [] }, rawFindings: [achadoManual(v)], crmRecords }).resultados[0];
const DNC_NO_CRM = [{ empresa: 'Registro bloqueado fictício', site: `https://${SITE}`, doNotContact: true }];

async function recusa(fn, codigo, mensagem) {
  await assert.rejects(fn, (erro) => {
    assert.equal(erro.code, codigo, `code esperado ${codigo}, veio ${erro.code}: ${erro.message}`);
    if (mensagem) assert.match(erro.message, mensagem);
    return true;
  });
}

const aprovarComoHumano = (env, id) => env.fila.approveProspect(closer(), id, { reason: 'Bom fit' });

// ---------------------------------------------------------------------------------------------------------------------------------
// Reenvio manual (Workbench) — a redescoberta de um aprovado e AINDA NÃO promovido
// ---------------------------------------------------------------------------------------------------------------------------------
test('[SNAPSHOT-1] reenvio MANUAL de um aprovado não promovido com dados diferentes: a promoção cria no CRM EXATAMENTE o que foi aprovado — nada da pesquisa nova vaza para o registro', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  aprovarComoHumano(env, id);
  const aprovado = clone(env.item());

  await env.submeter(B); // a nova pesquisa do mesmo lead (mesmo site), com outra cidade, nicho, telefone, Instagram e fonte

  const depois = env.item();
  assert.equal(depois.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.deepEqual(clone(depois.discoverySnapshot), aprovado.discoverySnapshot, 'o snapshot é o aprovado');
  const entrada = depois.historico.at(-1);
  assert.equal(entrada.tipo, REDISCOVERY_HISTORY_TYPE, 'a redescoberta foi registrada, de verdade');
  assert.deepEqual(entrada.redescoberta.camposDiferentes.sort(), ['cidade', 'fontes', 'instagram', 'nicho', 'telefone']);

  const resultado = await env.integracao.promoteProspect(admin(), id);
  assert.equal(resultado.outcome, PROMOTION_OUTCOME.CRIADO);
  const registro = env.registrosDoCrm()[0];
  assert.equal(registro.cidade, A.cidade);
  assert.equal(registro.nicho, A.nicho);
  assert.equal(registro.telefone, A.telefone);
  const crmTexto = env.textoDoCrm();
  for (const dadoNovo of [B.cidade, B.nicho, B.telefone, B.instagram, B.fonte]) assert.equal(crmTexto.includes(dadoNovo), false, `"${dadoNovo}" não foi para o CRM`);
  assert.ok(crmTexto.includes(A.fonte), 'a fonte aprovada continua nas observações do registro');
});

test('[SNAPSHOT-2] item em REVISÃO segue a regra de sempre pelo reenvio manual: o snapshot acompanha a pesquisa e é isso que o humano aprova e a promoção usa', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  await env.submeter(B);
  const id = env.item().prospectId;
  assert.equal(env.item().estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(env.item().discoverySnapshot.cidade, B.cidade);
  assert.equal(env.item().historico.at(-1).tipo, undefined, 'a entrada do item em revisão não ganhou formato novo');

  aprovarComoHumano(env, id);
  await env.integracao.promoteProspect(admin(), id);
  assert.equal(env.registrosDoCrm()[0].cidade, B.cidade, 'o humano aprovou o que estava na tela (B) e foi isso que entrou no CRM');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// DNC
// ---------------------------------------------------------------------------------------------------------------------------------
test('[SNAPSHOT-3] DNC visto depois da aprovação bloqueia a promoção (INT-26 preservado) — e uma pesquisa MAIS LIMPA, depois, NÃO reabre o caminho: o BLOQUEADO continua no snapshot', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  aprovarComoHumano(env, id);

  env.redescobrirNoArquivo(resultadoDaPesquisa(B, DNC_NO_CRM)); // a pesquisa viu o lead bloqueado
  assert.equal(env.item().discoverySnapshot.statusDNC, 'BLOQUEADO');
  assert.equal(env.item().discoverySnapshot.cidade, A.cidade, 'só o DNC foi atualizado, o resto do aprovado ficou');
  await recusa(async () => await env.integracao.promoteProspect(admin(), id), PROMOTION_ERROR.BLOCKED_DNC, /marcado como DO NOT CONTACT pela verificação de pesquisa/);

  // a pesquisa seguinte, pelo reenvio manual, vem limpa (o CRM não tem nenhuma restrição): o pipeline deixa entrar na fila
  const relatorio = await env.submeter(B);
  assert.ok(relatorio, 'o reenvio foi aceito');
  assert.equal(env.item().discoverySnapshot.statusDNC, 'BLOQUEADO', 'uma redescoberta nunca remove a restrição');
  await recusa(async () => await env.integracao.promoteProspect(admin(), id), PROMOTION_ERROR.BLOCKED_DNC, /marcado como DO NOT CONTACT pela verificação de pesquisa/);
  assert.equal(env.registrosDoCrm().length, 0, 'nada foi criado no CRM');
  assert.equal(env.item().promocao, undefined);
  assert.equal(env.item().historico.filter((e) => e.promocao && e.promocao.codigo === 'DNC').length, 2, 'as duas tentativas bloqueadas ficaram auditadas');
});

test('[SNAPSHOT-4] o DNC do CRM (a restrição de verdade) continua sendo checado ao vivo na promoção, independentemente do snapshot', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  aprovarComoHumano(env, id);
  const bloqueado = (await env.crm.createRecord(admin(), { empresa: 'Registro bloqueado', site: SITE })).record;
  await env.crm.markDoNotContact(admin(), bloqueado.id, { reason: 'pediu para não ser contatado' });
  await recusa(async () => await env.integracao.promoteProspect(admin(), id), PROMOTION_ERROR.BLOCKED_DNC, /já está bloqueada como DO_NOT_CONTACT no CRM/);
  assert.equal(env.registrosDoCrm().length, 1, 'só o registro bloqueado que já existia');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Promoção: idempotência, reconciliação e item já promovido
// ---------------------------------------------------------------------------------------------------------------------------------
test('[SNAPSHOT-5] já PROMOVIDO: uma redescoberta não altera o registro do CRM nem o resumo da fila, e promover de novo continua JA_PROMOVIDO sem gravar nada', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  aprovarComoHumano(env, id);
  await env.integracao.promoteProspect(admin(), id);
  const crmAntes = env.textoDoCrm();
  const promocaoAntes = clone(env.item().promocao);
  const snapshotAntes = clone(env.item().discoverySnapshot);

  env.redescobrirNoArquivo(resultadoDaPesquisa(B)); // o domínio recebe a redescoberta (o pipeline do reenvio manual a barraria como duplicada do CRM)

  assert.deepEqual(clone(env.item().promocao), promocaoAntes);
  assert.deepEqual(clone(env.item().discoverySnapshot), snapshotAntes);
  const repetida = await env.integracao.promoteProspect(admin(), id);
  assert.equal(repetida.outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
  assert.equal(env.textoDoCrm(), crmAntes, 'o CRM está byte a byte como estava');
  assert.equal(env.item().historico.filter((e) => e.motivo === 'Promovido para o CRM').length, 1);
});

test('[SNAPSHOT-6] depois de promovido, o reenvio manual é barrado pela deduplicação (já está no CRM) e a fila não é tocada', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  aprovarComoHumano(env, id);
  await env.integracao.promoteProspect(admin(), id);
  const filaAntes = env.textoDaFila();
  const crmAntes = env.textoDoCrm();
  await env.submeter(B);
  assert.equal(env.textoDaFila(), filaAntes, 'a deduplicação contra o CRM continua a primeira barreira');
  assert.equal(env.textoDoCrm(), crmAntes);
});

test('[SNAPSHOT-7] RECONCILIAÇÃO: a promoção falha DEPOIS de gravar no CRM; uma redescoberta chega no meio; a repetição reconcilia com o registro que já existe — sem criar outro, sem remapear', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  aprovarComoHumano(env, id);
  let falhas = 1;
  const promocaoQueFalha = {
    recordPromotion: (...args) => {
      if (falhas > 0) {
        falhas -= 1;
        throw new Error('falha de gravação da fila (simulada)');
      }
      return env.promocao.recordPromotion(...args);
    },
    recordPromotionBlocked: (...args) => env.promocao.recordPromotionBlocked(...args),
  };
  const servico = createCrmIntegrationService({ approvalQueueService: env.fila, approvalPromotionService: promocaoQueFalha, crmService: env.crm, authorizeOperation: authorizeCrmOperation });
  await recusa(async () => await servico.promoteProspect(admin(), id), PROMOTION_ERROR.PARTIAL);
  assert.equal(env.registrosDoCrm().length, 1);
  const crmAntes = env.textoDoCrm();

  env.redescobrirNoArquivo(resultadoDaPesquisa(B)); // chega no meio, com outros dados

  const reconciliado = await servico.promoteProspect(admin(), id);
  assert.equal(reconciliado.outcome, PROMOTION_OUTCOME.RECONCILIADO);
  assert.equal(env.textoDoCrm(), crmAntes, 'o registro do CRM não foi tocado');
  assert.equal(env.item().promocao.resultado, 'RECONCILIADO');
  assert.equal((await servico.promoteProspect(admin(), id)).outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
  assert.equal(env.registrosDoCrm().length, 1);
});

test('[SNAPSHOT-8] idempotência da promoção com a redescoberta ANTES: duas promoções seguidas criam UM registro, com os dados aprovados', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  aprovarComoHumano(env, id);
  await env.submeter(B);
  await env.submeter(B);
  const [primeira, segunda] = [await env.integracao.promoteProspect(admin(), id), await env.integracao.promoteProspect(admin(), id)];
  assert.deepEqual([primeira.outcome, segunda.outcome], [PROMOTION_OUTCOME.CRIADO, PROMOTION_OUTCOME.JA_PROMOVIDO]);
  assert.equal(env.registrosDoCrm().length, 1);
  assert.equal(env.registrosDoCrm()[0].telefone, A.telefone);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Rejeitado, Leads Reprovados e reconsideração humana
// ---------------------------------------------------------------------------------------------------------------------------------
test('[SNAPSHOT-9] rejeitado e reenviado: o conteúdo não é trocado em silêncio e a tela de Leads Reprovados continua mostrando a decisão HUMANA (quem, quando e por quê) — também com anotações antigas "Redescoberto — …"', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  env.fila.rejectProspect(closer(), id, { reason: 'sem fit — decisão humana' });
  const antes = env.reprovados().listReprovados(closer(), {})[0];
  assert.equal(antes.origemDaDecisao, 'HUMANO');

  await env.submeter(B);
  await env.submeter(B);

  const [depois] = env.reprovados().listReprovados(closer(), {});
  assert.equal(depois.origemDaDecisao, 'HUMANO', 'a decisão humana não foi trocada pela anotação do sistema');
  assert.deepEqual([depois.reprovadoPor, depois.reprovadoEm, depois.motivo], [antes.reprovadoPor, antes.reprovadoEm, antes.motivo]);
  assert.equal(depois.dadosComerciais.cidade, A.cidade, 'o conteúdo reprovado é o mostrado');
  assert.equal(depois.dadosComerciais.telefone, A.telefone);

  // um arquivo ANTIGO, com as anotações do formato anterior depois da rejeição
  const fila = env.lerFila();
  fila.items[id].historico.push({ timestamp: '2026-09-30T10:00:00.000Z', from: 'REJEITADO', to: 'REJEITADO', actor: 'SYSTEM', motivo: 'Redescoberto — estado já decidido/travado, nenhuma alteração automática' });
  fs.writeFileSync(env.queuePath, JSON.stringify(fila, null, 2), 'utf8');
  const [legado] = env.reprovados().listReprovados(closer(), {});
  assert.equal(legado.origemDaDecisao, 'HUMANO');
  assert.equal(legado.motivo, antes.motivo);
});

test('[SNAPSHOT-10] reconsideração humana: rejeitado -> reenviado -> reaprovado volta à revisão com o conteúdo que foi reprovado e a decisão original no histórico; um novo reenvio, em revisão, volta a acompanhar a pesquisa', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  env.fila.rejectProspect(closer(), id, { reason: 'sem fit' });
  await env.submeter(B);

  const visto = await env.reprovados().reconsiderLead(closer(), id, { reason: 'Mudou o contexto' });
  assert.equal(visto.estado, QUEUE_STATE.AGUARDANDO_REVISAO);
  assert.equal(visto.reaprovacoes, 1);
  assert.equal(visto.dadosComerciais.cidade, A.cidade);
  assert.ok(env.item().historico.some((e) => e.to === QUEUE_STATE.REJEITADO && e.reviewedBy && e.reviewedBy.userId === 'user-closer-promo'));
  assert.ok(env.item().historico.some((e) => e.tipo === 'REAPROVACAO'));

  await env.submeter(B);
  assert.equal(env.item().discoverySnapshot.cidade, B.cidade, 'em revisão de novo: a regra de sempre');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fluxo do job de prospecção
// ---------------------------------------------------------------------------------------------------------------------------------
function motorTrocavel() {
  const ref = { atual: motorFake({ rodadas: [] }) };
  return { ref, discover: (pedido) => ref.atual.discover(pedido) };
}
const rodadas = (...lista) => motorFake({ rodadas: lista.map((candidatos) => ({ candidatos })) });
async function rodarJob(env, motor, motorDoJob, quantidade) {
  motor.ref.atual = motorDoJob;
  const { job } = await iniciar(env, { quantidade });
  return await env.servico.waitFor(job.id);
}

test('[SNAPSHOT-11] FLUXO DO JOB: um aprovado que um 2º job redescobre (agora com canais que o 1º não tinha) mantém o snapshot aprovado; a promoção não leva os dados do 2º job; a redescoberta fica registrada', async (t) => {
  const motor = motorTrocavel();
  const paginas = paginasBoas();
  const env = ambienteDeJob(t, { motor, paginas });
  const queuePath = path.join(env.dir, 'approval-queue.json');
  const crmPath = path.join(env.dir, 'crm.json');
  const { fila, integracao } = criarServicos(queuePath, crmPath);
  const lerItem = () => Object.values(JSON.parse(fs.readFileSync(queuePath, 'utf8')).items)[0];

  const fim1 = await rodarJob(env, motor, rodadas([candidato('Clínica Alfa', 'alfa')], []), 1);
  assert.equal(fim1.status, JOB_STATUS.CONCLUIDO);
  const id = lerItem().prospectId;
  fila.approveProspect(admin(), id, { reason: 'ok' });
  const aprovado = clone(lerItem());
  assert.equal(aprovado.discoverySnapshot.instagram ?? null, null, 'pré-condição: o 1º job não achou Instagram');

  // o 2º job lê a mesma página, que agora publica o Instagram (e o WhatsApp)
  paginas[siteDe('alfa')] = paginaBoa('Clínica Alfa', 'alfa', { links: ['https://www.instagram.com/clinicaalfa', 'https://wa.me/5524987651000'] });
  const fim2 = await rodarJob(env, motor, rodadas([candidato('Clínica Alfa', 'alfa')], []), 1);
  assert.equal(fim2.lote.jaEstavamNaFila, 1, 'o job viu o lead que já estava na fila');
  assert.equal(fim2.lote.naFila, 0, 'e isso não conta como entrega');

  const depois = lerItem();
  assert.equal(depois.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  assert.deepEqual(clone(depois.discoverySnapshot), aprovado.discoverySnapshot);
  const entrada = depois.historico.at(-1);
  assert.equal(entrada.tipo, REDISCOVERY_HISTORY_TYPE);
  assert.ok(entrada.redescoberta.camposDiferentes.includes('instagram'), 'o histórico diz que o Instagram é novo — sem repeti-lo');
  assert.equal(JSON.stringify(entrada).includes('clinicaalfa'), false);

  await integracao.promoteProspect(admin(), id);
  const registro = Object.values(JSON.parse(fs.readFileSync(crmPath, 'utf8')))[0];
  assert.equal(registro.instagram || null, null, 'o registro criado no CRM é o aprovado, sem o canal do 2º job');
  assert.equal((await integracao.promoteProspect(admin(), id)).outcome, PROMOTION_OUTCOME.JA_PROMOVIDO);
});

test('[SNAPSHOT-12] FLUXO DO JOB + Exclusão Permanente: um lead excluído depois nem chega à fila — a fila não é tocada (nenhuma redescoberta registrada); a barreira é a mesma de antes', async (t) => {
  const motor = motorTrocavel();
  let excluir = false;
  const env = ambienteDeJob(t, { motor, paginas: paginasBoas(), exclusao: async (achado) => (excluir && achado.empresa === 'Clínica Alfa' ? { motivo: 'excluída permanentemente' } : false) });
  const queuePath = path.join(env.dir, 'approval-queue.json');
  const { fila } = criarServicos(queuePath, path.join(env.dir, 'crm.json'));

  await rodarJob(env, motor, rodadas([candidato('Clínica Alfa', 'alfa')], []), 1);
  fila.approveProspect(admin(), Object.keys(JSON.parse(fs.readFileSync(queuePath, 'utf8')).items)[0], { reason: 'ok' });
  const antes = fs.readFileSync(queuePath, 'utf8');

  excluir = true;
  const fim = await rodarJob(env, motor, rodadas([candidato('Clínica Alfa', 'alfa')], []), 1);
  assert.equal(fim.leadsNaFila, 0, 'nada foi entregue');
  assert.equal(fim.lote, null, 'nenhum achado chegou à ingestão (o lead excluído foi barrado antes)');
  assert.equal(fs.readFileSync(queuePath, 'utf8'), antes, 'a fila ficou idêntica: a exclusão barrou o lead antes de qualquer redescoberta');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Compatibilidade
// ---------------------------------------------------------------------------------------------------------------------------------
test('[SNAPSHOT-13] compatibilidade: os leitores existentes (Service da fila, histórico e a tela de Leads Reprovados) leem a fila com as entradas novas e as antigas juntas, sem erro e sem perder campos', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  aprovarComoHumano(env, id);
  const fila = env.lerFila();
  fila.items[id].historico.push({ timestamp: '2026-09-30T10:00:00.000Z', from: 'APROVADO_PARA_CRM', to: 'APROVADO_PARA_CRM', actor: 'SYSTEM', motivo: 'Redescoberto — estado já decidido/travado, nenhuma alteração automática' });
  fs.writeFileSync(env.queuePath, JSON.stringify(fila, null, 2), 'utf8');
  await env.submeter(B);
  env.redescobrirNoArquivo(resultadoDaPesquisa(B, DNC_NO_CRM));

  const lido = env.fila.getProspect(closer(), id);
  assert.equal(lido.estado, QUEUE_STATE.APROVADO_PARA_CRM);
  const historico = env.fila.getHistory(closer(), id);
  assert.equal(historico.length, lido.historico.length);
  assert.ok(historico.every((e) => typeof e.motivo === 'string' && 'timestamp' in e && 'from' in e && 'to' in e && 'actor' in e));
  assert.ok(historico.some((e) => e.tipo === REDISCOVERY_HISTORY_TYPE && e.redescoberta.dncAtualizado === true));
  assert.equal(env.fila.listQueue(closer()).length, 1);
});

test('[SNAPSHOT-14] uma NOVA rejeição humana depois de reconsiderar passa a ser a última decisão — mesmo com redescobertas antes e depois dela: quem, quando e o motivo são os da segunda rejeição', async (t) => {
  const env = novoEnv(t);
  await env.submeter(A);
  const id = env.item().prospectId;
  env.fila.rejectProspect(closer(), id, { reason: 'sem fit' });
  await env.submeter(B); // redescoberta do rejeitado
  await env.reprovados().reconsiderLead(closer(), id, { reason: 'Mudou o contexto' });
  await env.submeter(B); // item em revisão: segue a pesquisa
  env.fila.rejectProspect(admin(), id, { reason: 'continua sem fit' }); // segunda rejeição, por OUTRA pessoa
  await env.submeter(A);
  await env.submeter(A); // redescobertas depois da segunda rejeição

  const [visto] = env.reprovados().listReprovados(closer(), {});
  assert.equal(visto.origemDaDecisao, 'HUMANO');
  assert.equal(visto.motivo, 'continua sem fit');
  assert.equal(visto.reprovadoPor.userId, 'user-admin-promo');
  assert.equal(visto.reaprovacoes, 1);
  const rejeicoes = env.item().historico.filter((e) => e.to === QUEUE_STATE.REJEITADO && e.actor === 'HUMAN');
  assert.equal(rejeicoes.length, 2, 'as duas rejeições humanas estão no histórico');
  assert.equal(visto.reprovadoEm, rejeicoes[1].timestamp, 'a data é a da segunda rejeição');
  assert.equal(env.item().historico.at(-1).tipo, REDISCOVERY_HISTORY_TYPE, 'a última linha do histórico é a anotação, e não foi tomada por decisão');
});

test('[SNAPSHOT-15] uma anotação automática nunca vira decisão humana: um lead que o SISTEMA classificou como DNC continua "SISTEMA", com o motivo da classificação, depois de redescobertas', async (t) => {
  const env = novoEnv(t);
  env.redescobrirNoArquivo(resultadoDaPesquisa(A, DNC_NO_CRM)); // o item nasce no estado DNC, por classificação do sistema
  env.redescobrirNoArquivo(resultadoDaPesquisa(B));
  env.redescobrirNoArquivo(resultadoDaPesquisa(B));

  const [visto] = env.reprovados().listReprovados(closer(), { filtro: 'DNC' });
  assert.equal(env.item().estado, QUEUE_STATE.DNC);
  assert.equal(visto.origemDaDecisao, 'SISTEMA');
  assert.equal(visto.reprovadoPor, null, 'nenhum humano é apontado');
  assert.match(visto.motivo, /^DO NOT CONTACT confirmado pela verificação de CRM$/, 'o motivo é o da classificação, não o texto da redescoberta');
  assert.equal(env.item().historico.at(-1).actor, 'SYSTEM');
});
