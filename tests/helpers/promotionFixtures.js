'use strict';

// Peças de teste da promoção Approval Queue -> CRM (etapa CRM-INTEGRATION, decisão 0016) — USO SOMENTE EM TESTES
// (src/ nunca importa este arquivo). Só dados fictícios (example.test); nenhum arquivo do projeto é tocado: a fila e o
// CRM são arquivos TEMPORÁRIOS, removidos ao fim de cada teste.
//
// Tudo o que a produção usa é REAL aqui: o domínio da fila, o pipeline de descoberta que produz os prospects, os dois
// Services da fila, o CRM Service sobre o adapter de arquivo, o domínio do CRM e as pontes de autorização de src/auth,
// com AuthorizationContexts emitidos pelo emissor interno a partir de um USER definido.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queueDomain = require('../../src/research-prospector/approvalQueue');
const { runDiscoveryPipeline, SOURCE_TYPE } = require('../../src/research-prospector/discovery');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const { createApprovalPromotionService } = require('../../src/services/approvalPromotionService');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createCrmIntegrationService } = require('../../src/services/crmIntegrationService');
const { ROLE, USER_STATUS, defineUser, authorizeReviewerForApprovalQueue, authorizeCrmOperation } = require('../../src/auth');
const { createAuthorizationContext } = require('./authFixtures');

const ADMIN_USER = { userId: 'user-admin-promo', authUserId: 'auth-admin-promo', name: 'Administrador da Promoção', email: 'admin-promo@example.test', role: ROLE.ADMIN };
const CLOSER_USER = { userId: 'user-closer-promo', authUserId: 'auth-closer-promo', name: 'Closer da Promoção', email: 'closer-promo@example.test', role: ROLE.COMMERCIAL_CLOSER };

const usuario = (base, overrides = {}) => defineUser({ ...base, status: USER_STATUS.ACTIVE, ...overrides });
const admin = (overrides) => createAuthorizationContext(usuario(ADMIN_USER, overrides));
const closer = (overrides) => createAuthorizationContext(usuario(CLOSER_USER, overrides));
const inativo = (base = ADMIN_USER) => createAuthorizationContext(usuario(base, { status: USER_STATUS.INACTIVE }));

const OPERADOR_ADMIN = { userId: ADMIN_USER.userId, name: ADMIN_USER.name, role: ROLE.ADMIN };
const OPERADOR_CLOSER = { userId: CLOSER_USER.userId, name: CLOSER_USER.name, role: ROLE.COMMERCIAL_CLOSER };

const briefing = { nicho: 'Psicologia', regiao: 'Petrópolis/RJ', quantidadeDesejada: 10, exclusoes: [] };

const evidencia = (valor, tipoFonte = SOURCE_TYPE.OFICIAL) => ({ valor, fonte: 'Fonte de teste', tipoFonte });

// Um achado bruto RICO (todos os campos que a fila guarda), fictício. `extras` sobrescreve qualquer campo do achado;
// `campos` (dentro dele) troca as evidências.
function achado(empresa, slug, extras = {}) {
  const { campos, ...resto } = extras;
  return {
    empresa,
    tipo: 'CLINICA',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Clínica de Psicologia',
    campos: {
      site: [evidencia(`${slug}.example.test`)],
      instagram: [evidencia(`@${slug.replace(/-/g, '_')}`)],
      telefone: [evidencia('(24) 98765-1000')],
      whatsapp: [evidencia('+55 24 98765-2000')],
      email: [evidencia(`contato@${slug}.example.test`)],
      facebook: [evidencia(`https://facebook.example.test/${slug}`)],
      linkedin: [evidencia(`https://linkedin.example.test/company/${slug}`)],
      youtube: [evidencia(`https://youtube.example.test/@${slug}`)],
      endereco: [evidencia('Rua de Teste, 10 — Petrópolis/RJ')],
      ...campos,
    },
    fontes: [`https://${slug}.example.test`, 'Google Maps (consulta manual)'],
    observacoesBrutas: 'Atende adultos e adolescentes.',
    hipoteseDeOportunidade: 'Sem agendamento online no site',
    ...resto,
  };
}

function descoberta(rawFinding, crmRecords = []) {
  return runDiscoveryPipeline({ briefing, rawFindings: [rawFinding], crmRecords, dataDaPesquisa: '2026-09-20' }).resultados[0];
}

// Os Services de PRODUÇÃO sobre dois arquivos — chamar de novo com os mesmos caminhos é o equivalente a um processo novo
// (os Services não guardam estado: tudo está nos arquivos).
function criarServicos(queuePath, crmPath, opcoes = {}) {
  const fila = createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath });
  const promocao = createApprovalPromotionService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath });
  const crm = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: crmPath });
  const integracao = createCrmIntegrationService({
    approvalQueueService: opcoes.fila || fila,
    approvalPromotionService: opcoes.promocao || promocao,
    crmService: opcoes.crm || crm,
    authorizeOperation: authorizeCrmOperation,
  });
  return { fila, promocao, crm, integracao };
}

// Monta um ambiente: uma fila REAL em arquivo temporário com os prospects de `entradas` ({ chave: { finding, crmRecords? } }),
// um CRM REAL (arquivo temporário, vazio) e os Services de produção sobre eles. Todos os prospects entram
// AGUARDANDO_REVISAO (ou no estado de sistema que a descoberta decidir: DNC, DUPLICADO, DADOS_INSUFICIENTES).
function novoAmbiente(t, entradas = {}, opcoes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, 'approval-queue.json');
  const crmPath = path.join(dir, 'crm.json');

  const queue = queueDomain.createEmptyQueue();
  const ids = {};
  for (const [chave, entrada] of Object.entries(entradas)) {
    const item = queueDomain.addProspect(queue, descoberta(entrada.finding, entrada.crmRecords || []));
    ids[chave] = item.prospectId;
  }
  queueDomain.saveQueueToDisk(queue, queuePath);

  const { fila, promocao, crm, integracao } = criarServicos(queuePath, crmPath, opcoes);

  return {
    dir,
    queuePath,
    crmPath,
    ids,
    fila,
    promocao,
    crm,
    integracao,
    lerFila: () => JSON.parse(fs.readFileSync(queuePath, 'utf8')),
    lerCrm: () => (fs.existsSync(crmPath) ? JSON.parse(fs.readFileSync(crmPath, 'utf8')) : {}),
    textoDaFila: () => fs.readFileSync(queuePath, 'utf8'),
    textoDoCrm: () => (fs.existsSync(crmPath) ? fs.readFileSync(crmPath, 'utf8') : ''),
    itemDaFila: (chave) => JSON.parse(fs.readFileSync(queuePath, 'utf8')).items[ids[chave]],
    registrosDoCrm: () => Object.values(fs.existsSync(crmPath) ? JSON.parse(fs.readFileSync(crmPath, 'utf8')) : {}),
  };
}

// Aprova um prospect como HUMANO (o closer tem APPROVE:LEAD_APPROVAL), pelo Approval Queue Service.
const aprovar = (env, chave, contexto = closer(), motivo = 'Bom fit') => env.fila.approveProspect(contexto, env.ids[chave], { reason: motivo });

module.exports = {
  ADMIN_USER,
  CLOSER_USER,
  OPERADOR_ADMIN,
  OPERADOR_CLOSER,
  admin,
  closer,
  inativo,
  usuario,
  achado,
  evidencia,
  descoberta,
  novoAmbiente,
  criarServicos,
  aprovar,
  briefing,
};
