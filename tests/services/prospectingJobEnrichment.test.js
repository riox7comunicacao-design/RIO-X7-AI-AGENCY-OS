'use strict';

// Implementação 3.0.2 — a prospecção automática é Descoberta -> Validação -> Ingestão -> Approval Queue: SEM enriquecimento aprofundado via Claude. O job só grava o perfil que o CÓDIGO extraiu das
// páginas consultadas; o aprofundamento é sob demanda (leadEnrichment.test.js). Peças REAIS: Brief Service, caminho oficial de ingestão, Approval Queue, perfil comercial. FAKES: motores e leitura de página.

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const { admin, closer } = require('../helpers/promotionFixtures');
const { JOB_STATUS } = require('../../src/research-prospector/prospectingJob');
const { esperaAteAbortar, paginaBoa, candidato, motorFake, ambiente, iniciar, siteDe, tresBons, paginasBoas, erroDe } = require('../helpers/jobFixtures');

const paginaRica = (nome, slug) => ({
  ...paginaBoa(nome, slug, { links: ['tel:+552422223333', `https://wa.me/5524988887777`, 'mailto:contato@clinica.com.br', 'https://www.instagram.com/clinicaalfa/'] }),
  texto: `${nome}\nClínica de estética e harmonização facial\nRua das Flores, 10 - Centro, Petrópolis - RJ, CEP 25600-000\nProprietária: Ana Souza Lima\nTelefone (24) 2222-3333`,
});

const enriquecimentoFake = (respostas, { falha = false } = {}) => {
  const chamadas = [];
  return {
    chamadas,
    enrich: async (pedido) => {
      chamadas.push(pedido);
      if (falha) return { ok: false, code: 'TIMEOUT' };
      return { ok: true, resultados: respostas(pedido), custoUsd: 0.05, webSearchRequests: 3 };
    },
  };
};

test('[AUTO-1] o job NÃO chama o motor de enriquecimento (mesmo se existir um injetado) e grava, para cada lead ENTREGUE, o perfil que o CÓDIGO extraiu das páginas já lidas: contatos, endereço, responsável com cargo explícito, redes, fontes', async (t) => {
  const paginas = { ...paginasBoas(), [siteDe('alfa')]: paginaRica('Clínica Alfa', 'alfa') };
  const motor = enriquecimentoFake(() => assert.fail('o motor de enriquecimento NÃO pode ser chamado pela prospecção automática'));
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }), paginas, enriquecimento: motor });
  const { job } = await iniciar(env);
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(motor.chamadas.length, 0);
  const perfis = env.perfis.list();
  assert.equal(perfis.length, 3);
  const alfa = perfis.find((p) => p.empresa === 'Clínica Alfa');
  assert.equal(alfa.responsavel.nome, 'Ana Souza Lima');
  assert.equal(alfa.endereco.cep, '25600-000');
  assert.equal(alfa.endereco.cidade, 'Petrópolis');
  assert.deepEqual(alfa.telefones.map((x) => x.numero), ['+552422223333']);
  assert.deepEqual(alfa.whatsapps.map((x) => x.numero), ['+5524988887777']);
  assert.deepEqual(alfa.emails.map((x) => x.email), ['contato@clinica.com.br']);
  assert.equal(alfa.siteOficial.status, 'ENCONTRADO');
  assert.deepEqual([alfa.presencaDigital.instagram.url, alfa.presencaDigital.instagram.confirmacao], ['https://www.instagram.com/clinicaalfa', 'CONFIRMADO']);
  assert.ok(alfa.fontesDescoberta.length > 0 && alfa.fontesValidacao.length > 0, 'fontes de descoberta e de validação');
  assert.deepEqual([alfa.contexto.cidade, alfa.contexto.uf, alfa.contexto.nicho], ['Petrópolis', 'RJ', 'Clínicas de estética']);
  // o aprofundamento fica PENDENTE e sob demanda: nada foi pesquisado por IA
  assert.equal(alfa.enriquecimento.status, 'NAO_EXECUTADO');
  assert.equal(alfa.enriquecimento.motivo, 'SOB_DEMANDA');
  assert.ok(['trafegoPago', 'atividadeRecente'].every((c) => alfa.enriquecimento.camposPendentes.includes(c)));
  assert.equal(alfa.enriquecimento.camposPendentes.includes('responsavel'), false, 'o que o código achou não é pendente');
  assert.equal(alfa.trafegoPago.meta.status, 'NAO_VERIFICADO');
  assert.equal(alfa.atividadeRecente.janelas.ultimos7Dias, 'NAO_VERIFICADO');
  // custo e tempo: nenhuma etapa de enriquecimento
  assert.deepEqual([fim.telemetria.enriquecimento.chamadas, fim.telemetria.enriquecimentoMs, fim.telemetria.custoUsd], [0, 0, 0]);
  const fila = createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: path.join(env.dir, 'approval-queue.json') }).listQueue(admin());
  assert.equal(fila.length, 3);
  for (const item of fila) assert.ok(env.perfis.getById(item.prospectId), item.prospectId);
});

test('[AUTO-2] a ausência de contato/rede/site NÃO rejeita: lead cuja identidade, nicho e localização estão comprovados entra na fila com o perfil mínimo', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }), paginas: paginasBoas() });
  const { job } = await iniciar(env);
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  for (const perfil of env.perfis.list()) {
    assert.deepEqual([perfil.telefones, perfil.whatsapps, perfil.emails], [[], [], []]);
    assert.equal(perfil.responsavel.status, 'NAO_ENCONTRADO');
    assert.equal(perfil.enriquecimento.status, 'NAO_EXECUTADO');
  }
});

test('[AUTO-3] só os validados e ENTREGUES ganham perfil: candidato não validado e lead retido pelo pipeline não geram perfil', async (t) => {
  const candidatos = [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Sem Prova', 'semprova'), candidato('Clínica Gama', 'gama')];
  const paginas = { ...paginasBoas(), [siteDe('semprova')]: paginaBoa('Clínica Sem Prova', 'semprova', { sem: ['localizacao'] }) };
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos }, { candidatos: [] }] }), paginas });
  const { job } = await iniciar(env, { quantidade: 2 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual(env.perfis.list().map((p) => p.empresa).sort(), ['Clínica Alfa', 'Clínica Gama']);
});

test('[AUTO-4] lead SEM site e sem rede social: VALIDADO, entra na Approval Queue com perfil mínimo (site NAO_ENCONTRADO, nunca "não possui"); a notícia/diretório fica em outras presenças e não gera contato', async (t) => {
  const noticia = 'https://portal.example.test/noticia-delta';
  const { paginaTerceiro } = require('../helpers/jobFixtures');
  const paginas = { ...paginasBoas(), [noticia]: paginaTerceiro(noticia, { texto: 'Clínica Delta, clínica de estética e harmonização facial em Petrópolis - RJ, inaugurou novo espaço. Fale conosco: (24) 99999-0000.' }) };
  const delta = { nome: 'Clínica Delta', siteOficial: null, fontesDescoberta: [{ url: noticia, tipo: 'NOTICIA_OU_TERCEIRO' }], presencaDigital: {} };
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: [delta] }, { candidatos: [] }] }), paginas });
  const { job } = await iniciar(env, { quantidade: 1 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.candidatos[0].resultado, 'VALIDADO');
  assert.equal(fim.candidatos[0].siteOficial.status, 'NAO_ENCONTRADO');
  assert.deepEqual([fim.lote.validadosPeloMotor, fim.lote.naFila], [1, 1]);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  const perfil = env.perfis.list()[0];
  assert.equal(perfil.siteOficial.status, 'NAO_ENCONTRADO');
  assert.deepEqual([perfil.telefones, perfil.whatsapps, perfil.emails], [[], [], []], 'contatos só do site oficial: nunca de uma notícia');
  assert.equal(perfil.outrasPresencas.some((o) => o.url === noticia), true);
  assert.equal(perfil.enriquecimento.camposPendentes.includes('siteOficial'), true, 'o site pendente pode ser buscado sob demanda');
});

test('[REDO-1] REFAZER PROSPECÇÃO: job novo, brief novo com o mesmo briefing; o job anterior fica intacto; só job terminado; o que já está na fila não volta como entrega', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }, { candidatos: tresBons() }, { candidatos: [] }, { candidatos: [] }] }), paginas: paginasBoas() });
  const { brief, job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  const antes = JSON.stringify(env.jobs.getById(job.id));

  const novo = await env.servico.redoJob(admin(), job.id);
  assert.notEqual(novo.id, job.id);
  assert.notEqual(novo.briefId, brief.id, 'um brief NOVO');
  assert.equal(novo.refeitoDe, job.id);
  assert.equal(novo.limits.maxCandidates, fim.limits.maxCandidates);
  const novoBrief = await env.briefService.getBrief(admin(), novo.briefId);
  assert.deepEqual([novoBrief.nicho, novoBrief.quantidade, novoBrief.cidades], [brief.nicho, brief.quantidade, brief.cidades]);
  const refeito = await env.servico.waitFor(novo.id);
  assert.equal(JSON.stringify(env.jobs.getById(job.id)), antes, 'o job anterior (histórico) não foi tocado');
  // os 3 já estavam na fila: nenhuma entrega NOVA, e a fila continua com 3 itens (sem duplicar)
  assert.equal(refeito.resumo.naApprovalQueue, 0);
  assert.equal(refeito.resumo.jaExistentes, 3);
  assert.notEqual(refeito.status, JOB_STATUS.CONCLUIDO, 'sem entrega nova a meta não foi atingida');
  assert.equal(env.jobs.list().length, 2);
});

test('[REDO-2] refazer é recusado para job ativo ou inexistente; quem não propõe não refaz', async (t) => {
  const { espera, liberar } = esperaAteAbortar();
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }], espera }), paginas: paginasBoas() });
  const { job } = await iniciar(env);
  const ativo = await erroDe(() => env.servico.redoJob(admin(), job.id));
  assert.equal(ativo.code, 'JOB_INVALID_STATE');
  assert.equal((await erroDe(() => env.servico.redoJob(admin(), 'JOB-20261007-099'))).code, 'JOB_NOT_FOUND');
  assert.ok(await erroDe(() => env.servico.redoJob(closer(), job.id)));
  liberar();
  await env.servico.waitFor(job.id);
});

test('[RESUMO-1] o resumo do job é padronizado e sem dupla contagem: solicitados, processados, validados, na fila, já existentes, retidos, reposições, tempo e custo', async (t) => {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons(), telemetria: { custoUsd: 0.2, webSearchRequests: 2 } }] }), paginas: paginasBoas() });
  const { job } = await iniciar(env, { quantidade: 3 });
  const fim = await env.servico.waitFor(job.id);
  assert.deepEqual(Object.keys(fim.resumo).sort(), ['candidatosProcessados', 'custoUsd', 'dadosInsuficientes', 'descobertaSegundos', 'descobertos', 'dnc', 'duplicados', 'enriquecidos', 'enriquecimentoSegundos', 'ingestaoSegundos', 'jaExistentes', 'limiteDeCandidatos', 'naApprovalQueue', 'naoValidados', 'novos', 'repetidos', 'repetidosDnc', 'repetidosDuplicados', 'repetidosNaFila', 'repetidosNoJob', 'reposicoes', 'solicitados', 'tempoMs', 'totalSegundos', 'validacaoSegundos', 'validados']);
  assert.deepEqual([fim.resumo.solicitados, fim.resumo.candidatosProcessados, fim.resumo.validados, fim.resumo.naApprovalQueue, fim.resumo.jaExistentes, fim.resumo.limiteDeCandidatos], [3, 3, 3, 3, 0, 50]);
  assert.equal(fim.resumo.custoUsd, 0.2);
  assert.deepEqual(fim.lote.prospectIds.length, 3);
  assert.equal(new Set(fim.lote.prospectIds).size, 3, 'cada prospectId uma única vez');
});

test('[FULL-1] FLUXO COMPLETO: prospecção -> validação -> enriquecimento -> Approval Queue -> reprovação -> Leads Reprovados -> reaprovação -> Approval Queue -> aprovação -> promoção -> CRM (com perfil preservado)', async (t) => {
  const { criarServicos, closer } = require('../helpers/promotionFixtures');
  const { createLeadReconsiderationService } = require('../../src/services/leadReconsiderationService');
  const motor = enriquecimentoFake((pedido) => pedido.leads.map((lead) => ({ nome: lead.nome })));
  const paginas = { ...paginasBoas(), [siteDe('alfa')]: paginaRica('Clínica Alfa', 'alfa') };
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos: tresBons() }] }), paginas, enriquecimento: motor });
  const { job } = await iniciar(env);
  const fim = await env.servico.waitFor(job.id);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(fim.resumo.naApprovalQueue, 3);

  const queuePath = path.join(env.dir, 'approval-queue.json');
  const { fila, integracao } = criarServicos(queuePath, path.join(env.dir, 'crm.json'));
  const recon = createLeadReconsiderationService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath, crmService: env.crmService, profileRepository: env.perfis });
  const alfaId = fim.lote.prospectIds.find((id) => env.perfis.getById(id).empresa === 'Clínica Alfa');

  fila.rejectProspect(closer(), alfaId, { reason: 'Sem fit agora' });
  const reprovados = recon.listReprovados(admin(), { filtro: 'REPROVADOS' });
  assert.equal(reprovados.length, 1);
  assert.equal(reprovados[0].jobOrigem, job.id, 'o job de origem acompanha o lead');
  assert.equal(reprovados[0].perfil.responsavel.nome, 'Ana Souza Lima', 'o perfil enriquecido continua disponível');

  const volta = await recon.reconsiderLead(admin(), alfaId, { reason: 'Reavaliado' });
  assert.equal(volta.estado, 'AGUARDANDO_REVISAO');
  assert.equal(env.perfis.getById(alfaId).endereco.cep, '25600-000', 'nenhuma pesquisa nova: o perfil é o mesmo');
  assert.equal(env.paginasChamadas.filter((url) => url === siteDe('alfa')).length, 1, 'a página do lead só foi lida UMA vez (na validação)');

  fila.approveProspect(closer(), alfaId, { reason: 'Aprovado' });
  assert.equal((await env.crmService.listRecords(admin())).length, 0, 'aprovar não cria CRM');
  await integracao.promoteProspect(admin(), alfaId);
  await integracao.promoteProspect(admin(), alfaId);
  const registros = await env.crmService.listRecords(admin());
  assert.equal(registros.length, 1, 'promover duas vezes não duplica');
});
