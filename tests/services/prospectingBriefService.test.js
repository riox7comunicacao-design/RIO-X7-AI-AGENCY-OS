// Prospecting Brief Service (Etapa "Prospecção 1" — Workbench): src/services/prospectingBriefService.js.
//
// Peças REAIS: contextos emitidos, a ponte real de PROPOSE:LEAD_APPROVAL, o repositório de brief em memória. O
// Prospecting Service é um DOUBLE na maioria dos testes (só para provar exatamente o que este módulo delega a ele,
// sem repetir a cobertura de tests/services/prospectingService.test.js) — um teste de ponta a ponta usa o Service
// REAL para provar a integração completa.

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeProposerForLeadApproval, authorizeCrmOperation } = require('../../src/auth');
const { createProspectingBriefService, ProspectingBriefError } = require('../../src/services/prospectingBriefService');
const { createInMemoryBriefRepository } = require('../../src/research-prospector/briefRepository');
const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { admin, closer, inativo } = require('../helpers/promotionFixtures');

const AGORA = new Date('2026-09-29T12:00:00.000Z');

const briefInput = (extra = {}) => ({ nicho: 'Clínicas de estética', nivelGeografico: 'CIDADE', cidades: 'Petrópolis, Teresópolis', quantidade: 50, ...extra });

// Um double do Prospecting Service: registra as chamadas e devolve um relatório fixo (ou lança, se `falha` for dada).
function prospectingDouble({ falha, resultado } = {}) {
  const chamadas = [];
  return {
    chamadas,
    submitProspecting: async (context, submissao) => {
      chamadas.push(submissao);
      if (falha) throw falha;
      return resultado || { loteId: 'lote:00000000-0000-4000-8000-000000000000', contagens: { encontrados: 1, validos: 1 } };
    },
    listBatches: async () => [],
    getBatch: async () => null,
  };
}

function criarServico({ prospectingService = prospectingDouble(), repository = createInMemoryBriefRepository(), ...extras } = {}) {
  return createProspectingBriefService({ authorizeProposer: authorizeProposerForLeadApproval, prospectingService, repository, now: () => AGORA, ...extras });
}

async function erroDe(fn) {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que a função lançasse, e ela não lançou');
}

test('[BRIEF-SVC-1] o Service expõe exatamente as 8 operações do Workbench, congelado', () => {
  const servico = criarServico();
  assert.deepEqual(Object.keys(servico).sort(), ['cancelBrief', 'createBrief', 'generateResearchPackage', 'getBrief', 'ingestFindings', 'listBriefs', 'markConcluded', 'markReadyForResearch']);
  assert.ok(Object.isFrozen(servico));
});

test('[BRIEF-SVC-2] dependências obrigatórias: sem authorizeProposer, sem prospectingService.submitProspecting, sem repositório válido, ou sem researchProvider.generateBriefPackage o Service não existe', async () => {
  const repo = createInMemoryBriefRepository();
  const prospecting = prospectingDouble();
  assert.match((await erroDe(() => createProspectingBriefService({ prospectingService: prospecting, repository: repo }))).message, /authorizeProposer/);
  assert.match((await erroDe(() => createProspectingBriefService({ authorizeProposer: authorizeProposerForLeadApproval, repository: repo }))).message, /prospectingService/);
  assert.match((await erroDe(() => createProspectingBriefService({ authorizeProposer: authorizeProposerForLeadApproval, prospectingService: {}, repository: repo }))).message, /prospectingService/);
  assert.match((await erroDe(() => createProspectingBriefService({ authorizeProposer: authorizeProposerForLeadApproval, prospectingService: prospecting }))).message, /repositório inválido|repository/);
  assert.match(
    (await erroDe(() => createProspectingBriefService({ authorizeProposer: authorizeProposerForLeadApproval, prospectingService: prospecting, repository: repo, researchProvider: {} }))).message,
    /researchProvider/
  );
  assert.match(
    (await erroDe(() => createProspectingBriefService({ authorizeProposer: authorizeProposerForLeadApproval, prospectingService: prospecting, repository: repo, checkPermanentExclusion: 'nao-e-funcao' }))).message,
    /checkPermanentExclusion/
  );
  assert.ok(criarServico(), 'com tudo certo, o Service existe');
});

test('[BRIEF-SVC-3] createBrief (ADMIN): grava com id PROS-YYYYMMDD-NNN, status RASCUNHO, e criadoPor vem SÓ do autorizador', async () => {
  const servico = criarServico();
  const brief = await servico.createBrief(admin(), briefInput());
  assert.match(brief.id, /^PROS-20260929-\d{3}$/);
  assert.equal(brief.status, 'RASCUNHO');
  assert.equal(brief.criadoPor.role, 'ADMIN');
  assert.equal(brief.nicho, 'Clínicas de estética');
  assert.deepEqual(brief.cidades, ['Petrópolis', 'Teresópolis']);
  assert.equal(brief.loteRealId, null);
  assert.equal(brief.pacotePesquisa, null);
});

test('[BRIEF-SVC-4] COMMERCIAL_CLOSER (sem PROPOSE:LEAD_APPROVAL) é recusado em toda operação — nada é gravado', async () => {
  const repo = createInMemoryBriefRepository();
  const servico = criarServico({ repository: repo });
  const erro = await erroDe(() => servico.createBrief(closer(), briefInput()));
  assert.match(erro.message, /acesso negado/);
  assert.deepEqual(repo.list(), []);
  const inativoErro = await erroDe(() => servico.createBrief(inativo(), briefInput()));
  assert.match(inativoErro.message, /usuário inativo/);
});

test('[BRIEF-SVC-5] a sequência do dia incrementa (001, 002, 003...) — nunca reaproveita, mesmo com o relógio fixo', async () => {
  const servico = criarServico();
  const b1 = await servico.createBrief(admin(), briefInput());
  const b2 = await servico.createBrief(admin(), briefInput({ nicho: 'Odontologia' }));
  assert.equal(b1.id, 'PROS-20260929-001');
  assert.equal(b2.id, 'PROS-20260929-002');
});

test('[BRIEF-SVC-6] createBrief com entrada inválida recusa ANTES de gravar, com os erros (caminho + código)', async () => {
  const repo = createInMemoryBriefRepository();
  const servico = criarServico({ repository: repo });
  const erro = await erroDe(() => servico.createBrief(admin(), { nicho: '' }));
  assert.equal(erro.code, 'BRIEF_INVALID_INPUT');
  assert.ok(Array.isArray(erro.details.errors) && erro.details.errors.length > 0);
  assert.deepEqual(repo.list(), []);
});

test('[BRIEF-SVC-7] markReadyForResearch: RASCUNHO -> PRONTO_PARA_PESQUISA; de qualquer outro estado é recusado (BRIEF_INVALID_STATE)', async () => {
  const servico = criarServico();
  const brief = await servico.createBrief(admin(), briefInput());
  const pronto = await servico.markReadyForResearch(admin(), brief.id);
  assert.equal(pronto.status, 'PRONTO_PARA_PESQUISA');
  const erro = await erroDe(() => servico.markReadyForResearch(admin(), brief.id));
  assert.equal(erro.code, 'BRIEF_INVALID_STATE');
});

test('[BRIEF-SVC-8] generateResearchPackage: chama o ResearchProvider com o brief, grava o pacote, e o status vira PESQUISANDO; é IDEMPOTENTE (pode gerar de novo em PESQUISANDO)', async () => {
  const chamadas = [];
  const provider = { generateBriefPackage: (brief) => (chamadas.push(brief.id), { objetivo: 'x', nicho: brief.nicho }) };
  const servico = criarServico({ researchProvider: provider });
  const brief = await servico.createBrief(admin(), briefInput());
  await servico.markReadyForResearch(admin(), brief.id);
  const pesquisando = await servico.generateResearchPackage(admin(), brief.id);
  assert.equal(pesquisando.status, 'PESQUISANDO');
  assert.deepEqual(pesquisando.pacotePesquisa, { objetivo: 'x', nicho: 'Clínicas de estética' });
  await servico.generateResearchPackage(admin(), brief.id); // de novo, sem lançar
  assert.equal(chamadas.length, 2);
});

test('[BRIEF-SVC-9] generateResearchPackage em RASCUNHO é recusado (BRIEF_INVALID_STATE) — nenhum pacote é gerado', async () => {
  let chamado = false;
  const servico = criarServico({ researchProvider: { generateBriefPackage: () => ((chamado = true), {}) } });
  const brief = await servico.createBrief(admin(), briefInput());
  const erro = await erroDe(() => servico.generateResearchPackage(admin(), brief.id));
  assert.equal(erro.code, 'BRIEF_INVALID_STATE');
  assert.equal(chamado, false);
});

test('[BRIEF-SVC-10] ingestFindings: chama prospectingService.submitProspecting com o briefing DERIVADO (regiao = resumo da geografia, tipo = subnicho) e os rawFindings recebidos; em sucesso, o brief vira AGUARDANDO_REVISAO com loteRealId/contagens', async () => {
  const prospecting = prospectingDouble({ resultado: { loteId: 'lote:aaaa', contagens: { encontrados: 2, validos: 2 } } });
  const servico = criarServico({ prospectingService: prospecting });
  const brief = await servico.createBrief(admin(), briefInput({ subnicho: 'Harmonização facial', observacoes: 'obj' }));
  await servico.markReadyForResearch(admin(), brief.id);
  await servico.generateResearchPackage(admin(), brief.id);

  const achados = [{ empresa: 'Clínica X' }];
  const resultado = await servico.ingestFindings(admin(), brief.id, achados);

  assert.equal(prospecting.chamadas.length, 1);
  assert.deepEqual(prospecting.chamadas[0], {
    briefing: { nicho: 'Clínicas de estética', quantidadeDesejada: 50, regiao: 'Cidade: Petrópolis, Teresópolis', tipo: 'Harmonização facial', observacoes: 'obj' },
    rawFindings: achados,
  });
  assert.equal(resultado.brief.status, 'AGUARDANDO_REVISAO');
  assert.equal(resultado.brief.loteRealId, 'lote:aaaa');
  assert.deepEqual(resultado.brief.contagens, { encontrados: 2, validos: 2 });
  assert.equal(resultado.lote.loteId, 'lote:aaaa');
});

test('[BRIEF-SVC-11] um erro do Prospecting Service (validação, CRM indisponível, o que for) passa INTACTO, e o brief NÃO muda de estado', async () => {
  const falha = Object.assign(new Error('Prospecção: os achados da pesquisa são inválidos; nada foi processado.'), { code: 'PROSPECTING_RAW_FINDINGS_INVALID' });
  const servico = criarServico({ prospectingService: prospectingDouble({ falha }) });
  const brief = await servico.createBrief(admin(), briefInput());
  await servico.markReadyForResearch(admin(), brief.id);
  await servico.generateResearchPackage(admin(), brief.id);
  const erro = await erroDe(() => servico.ingestFindings(admin(), brief.id, [{}]));
  assert.equal(erro.code, 'PROSPECTING_RAW_FINDINGS_INVALID');
  const depois = await servico.getBrief(admin(), brief.id);
  assert.equal(depois.status, 'PESQUISANDO', 'o brief continua PESQUISANDO — nada foi marcado como concluído por engano');
});

test('[BRIEF-SVC-12] ingestFindings exige o brief em PESQUISANDO — RASCUNHO e PRONTO_PARA_PESQUISA são recusados SEM chamar o Prospecting Service', async () => {
  const prospecting = prospectingDouble();
  const servico = criarServico({ prospectingService: prospecting });
  const rascunho = await servico.createBrief(admin(), briefInput());
  const erro1 = await erroDe(() => servico.ingestFindings(admin(), rascunho.id, []));
  assert.equal(erro1.code, 'BRIEF_INVALID_STATE');
  const pronto = await servico.markReadyForResearch(admin(), rascunho.id);
  const erro2 = await erroDe(() => servico.ingestFindings(admin(), pronto.id, []));
  assert.equal(erro2.code, 'BRIEF_INVALID_STATE');
  assert.equal(prospecting.chamadas.length, 0);
});

test('[BRIEF-SVC-13] EXCLUSÃO PERMANENTE (seção 8): sem checker (o padrão), nada é excluído; com checker, os findings marcados NUNCA chegam ao Prospecting Service e contam em excluidosPermanentemente', async () => {
  const prospecting = prospectingDouble();
  const achados = [{ empresa: 'Força Digital' }, { empresa: 'Clínica Normal' }];

  const semChecker = criarServico({ prospectingService: prospecting });
  const brief1 = await semChecker.createBrief(admin(), briefInput());
  await semChecker.markReadyForResearch(admin(), brief1.id);
  await semChecker.generateResearchPackage(admin(), brief1.id);
  const r1 = await semChecker.ingestFindings(admin(), brief1.id, achados);
  assert.equal(r1.excluidosPermanentemente, 0);
  assert.deepEqual(prospecting.chamadas[0].rawFindings, achados);

  const prospecting2 = prospectingDouble();
  const comChecker = criarServico({ prospectingService: prospecting2, checkPermanentExclusion: (finding) => finding.empresa === 'Força Digital' });
  const brief2 = await comChecker.createBrief(admin(), briefInput());
  await comChecker.markReadyForResearch(admin(), brief2.id);
  await comChecker.generateResearchPackage(admin(), brief2.id);
  const r2 = await comChecker.ingestFindings(admin(), brief2.id, achados);
  assert.equal(r2.excluidosPermanentemente, 1);
  assert.deepEqual(
    prospecting2.chamadas[0].rawFindings.map((f) => f.empresa),
    ['Clínica Normal']
  );
});

test('[BRIEF-SVC-14] cancelBrief: cancela de RASCUNHO, PRONTO_PARA_PESQUISA, PESQUISANDO ou AGUARDANDO_REVISAO; de CONCLUIDO/CANCELADO é recusado', async () => {
  const servico = criarServico();
  const brief = await servico.createBrief(admin(), briefInput());
  const cancelado = await servico.cancelBrief(admin(), brief.id);
  assert.equal(cancelado.status, 'CANCELADO');
  const erro = await erroDe(() => servico.cancelBrief(admin(), brief.id));
  assert.equal(erro.code, 'BRIEF_INVALID_STATE');
});

test('[BRIEF-SVC-15] markConcluded: só a partir de AGUARDANDO_REVISAO', async () => {
  const servico = criarServico();
  const brief = await servico.createBrief(admin(), briefInput());
  const erro = await erroDe(() => servico.markConcluded(admin(), brief.id));
  assert.equal(erro.code, 'BRIEF_INVALID_STATE');
});

test('[BRIEF-SVC-16] listBriefs/getBrief exigem autorização; getBrief recusa um id malformado (BRIEF_INVALID_INPUT) e um id inexistente (BRIEF_NOT_FOUND)', async () => {
  const servico = criarServico();
  await servico.createBrief(admin(), briefInput());
  assert.equal((await servico.listBriefs(admin())).length, 1);
  assert.match((await erroDe(() => servico.listBriefs(closer()))).message, /acesso negado/);
  const invalido = await erroDe(() => servico.getBrief(admin(), 'lote:00000000-0000-4000-8000-000000000000'));
  assert.equal(invalido.code, 'BRIEF_INVALID_INPUT');
  const inexistente = await erroDe(() => servico.getBrief(admin(), 'PROS-20260929-999'));
  assert.equal(inexistente.code, 'BRIEF_NOT_FOUND');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Ponta a ponta com o Prospecting Service REAL (dedup, DNC e criação de lote de verdade)
// ---------------------------------------------------------------------------------------------------------------------------------
test('[BRIEF-SVC-17] PONTA A PONTA (Prospecting Service REAL): ingestFindings cria o LOTE de verdade, com o achado na Approval Queue; ingerir de novo no MESMO brief é recusado (nunca dois lotes para o mesmo brief)', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-svc-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const crmPath = path.join(dir, 'crm.json');
  const crmService = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: crmPath });
  const prospectingService = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath: path.join(dir, 'approval-queue.json'),
    crmService,
    batchPath: path.join(dir, 'prospecting-batches.json'),
    dossierPath: path.join(dir, 'prospecting-dossiers.json'),
  });
  const servico = createProspectingBriefService({
    authorizeProposer: authorizeProposerForLeadApproval,
    prospectingService,
    repository: createInMemoryBriefRepository(),
    now: () => AGORA,
  });

  const brief = await servico.createBrief(admin(), briefInput());
  await servico.markReadyForResearch(admin(), brief.id);
  await servico.generateResearchPackage(admin(), brief.id);
  const achado = {
    empresa: 'Clínica Ponta A Ponta',
    tipo: 'clínica',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: { site: [{ valor: 'ponta-a-ponta.example.test', fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }] },
    fontes: ['https://ponta-a-ponta.example.test'],
  };
  const resultado = await servico.ingestFindings(admin(), brief.id, [achado]);
  assert.match(resultado.brief.loteRealId, /^lote:/);
  assert.equal(resultado.lote.prospectIds.length, 1);

  const lotes = prospectingService.listBatches(admin());
  assert.equal(lotes.length, 1);
  assert.equal(lotes[0].loteId, resultado.brief.loteRealId);

  // O brief já está AGUARDANDO_REVISAO — ingerir de novo é recusado (nunca dois lotes para o mesmo brief).
  const erro = await erroDe(() => servico.ingestFindings(admin(), brief.id, [achado]));
  assert.equal(erro.code, 'BRIEF_INVALID_STATE');
  assert.equal(prospectingService.listBatches(admin()).length, 1, 'nenhum lote extra foi criado');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// EXCLUSÕES PERMANENTES (Etapa 2) — ponta a ponta com o Prospecting Exclusion Service e o Prospecting Service REAIS:
// "Força Digital" nunca entra na fila, nunca vira lead prospectável, nunca chega perto de CRM/Card.
// ---------------------------------------------------------------------------------------------------------------------------------
test('[BRIEF-SVC-18] EXCLUSÃO PERMANENTE PONTA A PONTA (Prospecting Exclusion Service + Prospecting Service REAIS): "Força Digital" nunca entra na Approval Queue — logo, nunca pode ser promovida ao CRM nem virar Card; a empresa normal ao lado entra normalmente', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createProspectingExclusionService } = require('../../src/services/prospectingExclusionService');
  const { createInMemoryPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');
  const { authorizeProspectingExclusionOperation } = require('../../src/auth');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-svc-exclusion-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const crmPath = path.join(dir, 'crm.json');
  const crmService = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: crmPath });
  const queuePath = path.join(dir, 'approval-queue.json');
  const prospectingService = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath,
    crmService,
    batchPath: path.join(dir, 'prospecting-batches.json'),
    dossierPath: path.join(dir, 'prospecting-dossiers.json'),
  });

  const exclusionService = createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: createInMemoryPermanentExclusionRepository(), now: () => AGORA });
  await exclusionService.create(admin(), { empresa: 'Força Digital', motivo: 'Exclusão permanente de prospecção', cidade: 'Petrópolis', estado: 'RJ' });

  const servico = createProspectingBriefService({
    authorizeProposer: authorizeProposerForLeadApproval,
    prospectingService,
    repository: createInMemoryBriefRepository(),
    now: () => AGORA,
    checkPermanentExclusion: (finding) => exclusionService.isExcluded(finding),
  });

  const brief = await servico.createBrief(admin(), briefInput());
  await servico.markReadyForResearch(admin(), brief.id);
  await servico.generateResearchPackage(admin(), brief.id);

  const achadoExcluido = {
    empresa: 'Força Digital',
    tipo: 'agência',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Marketing',
    campos: { site: [{ valor: 'forca-digital-exemplo.example.test', fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }] },
    fontes: ['https://forca-digital-exemplo.example.test'],
  };
  const achadoNormal = {
    empresa: 'Clínica Normal Teste',
    tipo: 'clínica',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: { site: [{ valor: 'clinica-normal-teste.example.test', fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }] },
    fontes: ['https://clinica-normal-teste.example.test'],
  };

  const resultado = await servico.ingestFindings(admin(), brief.id, [achadoExcluido, achadoNormal]);

  // Preservado (nunca apagado em silêncio): a informação de que "Força Digital" foi bloqueada continua no brief.
  assert.equal(resultado.excluidosPermanentemente, 1);
  assert.deepEqual(resultado.bloqueiosPermanentes, [{ empresa: 'Força Digital', motivo: 'Exclusão permanente de prospecção' }]);

  // O LOTE real (Prospecting Service) só recebeu o achado normal — "Força Digital" nunca chegou ao discovery, à
  // fila nem ao lote: nunca foi "pesquisada para contato", nunca é um lead prospectável.
  const lote = prospectingService.getBatch(admin(), resultado.brief.loteRealId);
  assert.equal(lote.resultados.length, 1);
  assert.equal(lote.resultados[0].empresa, 'Clínica Normal Teste');
  assert.ok(!JSON.stringify(lote).includes('Força Digital'), 'nenhum traço de "Força Digital" chega ao lote real');

  // Consequência estrutural: sem entrada na fila, não há prospect para promover ao CRM nem Card para criar — as
  // duas ações downstream (crmIntegrationService/funnelService) nunca têm um id para agir, então nunca acontecem.
  assert.equal((await crmService.listRecords(admin(), {})).length, 0, 'nada foi promovido ao CRM ainda (a aprovação humana continua sendo o próximo passo, só para o achado normal)');
});
