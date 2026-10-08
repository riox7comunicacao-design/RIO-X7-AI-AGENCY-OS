'use strict';

// Regra de produto DEFINITIVA: empresa + nicho + localização comprovados = lead VALIDADO e entregue à Approval Queue; a ausência de site, rede social ou telefone NÃO gera
// DADOS_INSUFICIENTES. DADOS_INSUFICIENTES fica só para o que realmente falta comprovar (ou outra regra legítima do pipeline: DNC, duplicidade, conflito, ambiguidade).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const discovery = require('../../src/research-prospector/discovery');
const { JOB_STATUS, CANDIDATE_RESULT } = require('../../src/research-prospector/prospectingJob');
const { admin } = require('../helpers/promotionFixtures');
const { siteDe, paginaBoa, paginaTerceiro, candidato, motorFake, ambiente, iniciar, paginasBoas } = require('../helpers/jobFixtures');

const DIRETORIO = 'https://www.guiamais.com.br/petropolis-rj/clinica-xyz';
const TEXTO_XYZ = 'Clínica XYZ — clínica de estética e harmonização facial. Rua das Flores, 10 - Petrópolis - RJ';

async function rodar(t, candidatos, paginas, quantidade = 1) {
  const env = ambiente(t, { motor: motorFake({ rodadas: [{ candidatos }, { candidatos: [] }] }), paginas });
  const { job } = await iniciar(env, { quantidade });
  const fim = await env.servico.waitFor(job.id);
  const fila = createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath: path.join(env.dir, 'approval-queue.json') }).listQueue(admin());
  return { env, fim, fila };
}

test('[NOSITE-1] lead VALIDADO sem site -> Approval Queue em AGUARDANDO_REVISAO (nunca DADOS_INSUFICIENTES), com a marca de comprovação do job', async (t) => {
  const xyz = candidato('Clínica XYZ', 'xyz', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] });
  const { env, fim, fila } = await rodar(t, [xyz], { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_XYZ }) });
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.equal(fim.candidatos[0].resultado, CANDIDATE_RESULT.VALIDADO);
  assert.equal(fim.candidatos[0].siteOficial.status, 'NAO_ENCONTRADO');
  assert.equal(fila.length, 1);
  assert.equal(fila[0].estado, 'AGUARDANDO_REVISAO');
  assert.equal(fila[0].discoverySnapshot.statusIdentidade.status, 'VALIDADA');
  assert.equal(env.achadosIngeridos[0].comprovadoPorCodigo, true);
});

test('[NOSITE-2] sem site E sem rede social (nenhum canal): entra na fila e é enriquecido normalmente — não se exige site, Instagram, telefone nem outro canal', async (t) => {
  const xyz = candidato('Clínica XYZ', 'xyz', { siteOficial: null, presencaDigital: {}, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] });
  const { env, fim, fila } = await rodar(t, [xyz], { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto: TEXTO_XYZ }) });
  assert.deepEqual([fim.lote.naFila, fim.lote.foraDaFila], [1, 0]);
  assert.equal(fila[0].estado, 'AGUARDANDO_REVISAO');
  const perfil = env.perfis.getById(fila[0].prospectId);
  assert.equal(perfil.siteOficial.status, 'NAO_ENCONTRADO');
  assert.equal(perfil.trafegoPago.meta.status, 'NAO_VERIFICADO');
});

test('[NOSITE-3] sem comprovação de empresa/nicho/localização NÃO entra: a página de terceiro que não prova os três aspectos deixa o candidato NAO_VERIFICADO e nada é ingerido', async (t) => {
  for (const texto of ['Clínica XYZ está listada aqui.', 'Clínica XYZ — clínica de estética e harmonização facial.', 'Estética e harmonização facial em Petrópolis - RJ, atendimento de segunda a sexta.']) {
    const xyz = candidato('Clínica XYZ', 'xyz', { siteOficial: null, fontesDescoberta: [{ url: DIRETORIO, tipo: 'DIRETORIO' }] });
    const { env, fim, fila } = await rodar(t, [xyz], { [DIRETORIO]: paginaTerceiro(DIRETORIO, { texto }) });
    assert.equal(fim.candidatos[0].resultado, CANDIDATE_RESULT.NAO_VERIFICADO, texto);
    assert.deepEqual(env.ingestoes, [], texto);
    assert.equal(fila.length, 0, texto);
  }
});

test('[NOSITE-4] regressão: leads COM site comprovado seguem normalmente (fila, 3 de 3, enriquecimento)', async (t) => {
  const { fim, fila } = await rodar(t, [candidato('Clínica Alfa', 'alfa'), candidato('Clínica Beta', 'beta'), candidato('Clínica Gama', 'gama')], paginasBoas(), 3);
  assert.equal(fim.status, JOB_STATUS.CONCLUIDO);
  assert.deepEqual(fila.map((i) => i.estado), ['AGUARDANDO_REVISAO', 'AGUARDANDO_REVISAO', 'AGUARDANDO_REVISAO']);
  assert.equal(fim.resumo.naApprovalQueue, 3);
});

test('[NOSITE-5] o pipeline: a marca só vale com identidade sem ambiguidade nem conflito; sem a marca e sem âncora continua DADOS_INSUFICIENTES (manual); a marca NÃO supera DNC/duplicidade', () => {
  const base = { empresa: 'Clínica XYZ', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Clínica de estética', fontes: ['https://www.guiamais.com.br/x'] };
  const rodarPipeline = (finding, crm = []) => discovery.runDiscoveryPipeline({ briefing: { nicho: 'Clínica de estética', regiao: 'Petrópolis/RJ', quantidadeDesejada: 1 }, rawFindings: [finding], crmRecords: crm, dataDaPesquisa: '2026-10-07' }).resultados[0];
  assert.equal(rodarPipeline(base).estadoOperacional, 'DADOS_INSUFICIENTES', 'colagem manual sem âncora: regra antiga preservada');
  const comMarca = rodarPipeline({ ...base, comprovadoPorCodigo: true });
  assert.equal(comMarca.estadoOperacional, 'AGUARDANDO_REVISAO');
  assert.equal(comMarca.statusIdentidade.status, 'VALIDADA');
  assert.equal(rodarPipeline({ ...base, comprovadoPorCodigo: true, identidadeAmbigua: true }).estadoOperacional, 'DADOS_INSUFICIENTES', 'ambiguidade ainda barra');
  assert.equal(rodarPipeline({ ...base, comprovadoPorCodigo: true }, [{ empresa: 'Clínica XYZ', cidade: 'Petrópolis' }]).estadoOperacional, 'POSSIVEL_DUPLICADO', 'duplicidade ainda vem antes');
});
