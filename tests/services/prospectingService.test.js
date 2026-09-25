// Prospecting Service V1 (src/services/prospectingService.js): ingestão controlada.
//
// Peças REAIS: contextos de autorização emitidos pelo emissor interno, as duas pontes reais (PROPOSE e CRM), o CRM real (domínio + adapter
// de arquivo, criado e movido para DO_NOT_CONTACT pelo próprio CRM), o discovery, a Approval Queue de arquivo, o repositório de lotes de
// arquivo e o Approval Queue Service (para provar que um humano ainda aprova depois). Só o relógio e o id do lote são fixados. Tudo em
// diretório temporário, dados fictícios (example.test), nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crm = require('../../src/crm');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { authorizeProposerForLeadApproval, authorizeReviewerForApprovalQueue, authorizeCrmOperation, PERMISSION } = require('../../src/auth');
const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');
const { createProspectingService, ProspectingError, PROSPECTING_ERROR, BRIEFING_LIMITS } = require('../../src/services/prospectingService');
const { createApprovalQueueService } = require('../../src/services/approvalQueueService');
const { createJsonFileBatchRepository, createInMemoryBatchRepository } = require('../../src/research-prospector/batchRepository');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { LIMITS } = require('../../src/research-prospector/rawFindingSchema');
const queueDomain = require('../../src/research-prospector/approvalQueue');
const { admin, closer, inativo, ADMIN_USER } = require('../helpers/promotionFixtures');

const OPERADOR = { actor: 'HUMAN', reviewedBy: { userId: 'user-teste', name: 'Teste', role: 'ADMIN' }, motivo: 'teste' };
const AGORA = new Date('2026-09-25T15:00:00.000Z');

// ---------------------------------------------------------------------------------------------------------------------------------
// Ambiente
// ---------------------------------------------------------------------------------------------------------------------------------
function ambiente(t, opcoes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospecting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, 'approval-queue.json');
  const crmPath = path.join(dir, 'crm.json');
  const batchPath = path.join(dir, 'prospecting-batches.json');
  const repositorioCrm = createJsonFileCrmRepository(crmPath);
  for (const { campos, dnc } of opcoes.crm || []) {
    const { record } = crm.createRecord(repositorioCrm, campos, OPERADOR);
    if (dnc) crm.markDoNotContact(repositorioCrm, record.id, OPERADOR);
  }
  let contador = 0;
  const portas = { authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, ...(opcoes.portas || {}) };
  const criar = () =>
    createProspectingService({
      ...portas,
      crmService: createFileBackedCrmService({ authorizeOperation: portas.authorizeOperation, filePath: crmPath }),
      batchRepository: opcoes.batchRepository || createJsonFileBatchRepository(batchPath),
      queuePath,
      now: () => AGORA,
      newId: opcoes.newId || (() => `lote:00000000-0000-4000-8000-${String((contador += 1)).padStart(12, '0')}`),
    });
  return {
    dir,
    queuePath,
    crmPath,
    batchPath,
    servico: criar(),
    reabrir: criar,
    fila: () => (fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : { items: {} }),
    filaExiste: () => fs.existsSync(queuePath),
    lotesExistem: () => fs.existsSync(batchPath),
    lotes: () => (fs.existsSync(batchPath) ? JSON.parse(fs.readFileSync(batchPath, 'utf8')) : {}),
    textoCrm: () => (fs.existsSync(crmPath) ? fs.readFileSync(crmPath, 'utf8') : ''),
    serviceDaFila: () => createApprovalQueueService({ authorizeReviewer: authorizeReviewerForApprovalQueue, queuePath }),
  };
}

const evidencia = (valor, tipoFonte = 'OFICIAL') => ({ valor, fonte: 'Fonte de teste', tipoFonte });

// Um achado VÁLIDO. `nivel`: 'completo' (identidade + dados suficientes), 'parcial' (uma âncora oficial só) ou 'fraco' (só fonte secundária).
function achado(nome, slug, nivel = 'completo', extras = {}) {
  const campos = {
    completo: {
      site: [evidencia(`${slug}.example.test`)],
      instagram: [evidencia(`@${slug.replace(/-/g, '_')}`)],
      telefone: [evidencia('(24) 98765-1000')],
    },
    parcial: { site: [evidencia(`${slug}.example.test`)] },
    fraco: { site: [evidencia(`${slug}.example.test`, 'SECUNDARIA')] },
  }[nivel];
  return { empresa: nome, tipo: 'clínica', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos, fontes: [`https://${slug}.example.test`], ...extras };
}

const briefing = (extras = {}) => ({ nicho: 'Psicologia', quantidadeDesejada: 3, regiao: 'Petrópolis/RJ', tipo: 'clínica', exclusoes: [], observacoes: 'lote de teste', ...extras });
const submissao = (achados, extras = {}) => ({ briefing: briefing(extras.briefing), rawFindings: achados });

function semEfeitos(env, ctx) {
  const antesCrm = env.textoCrm();
  return {
    conferir(mensagem = '') {
      assert.equal(env.filaExiste(), false, `${mensagem}: a fila não foi criada`);
      assert.equal(env.lotesExistem(), false, `${mensagem}: nenhum lote foi gravado`);
      assert.equal(env.textoCrm(), antesCrm, `${mensagem}: o CRM não mudou`);
    },
  };
}

const codigoDe = (fn) => {
  try {
    fn();
  } catch (erro) {
    return erro.code;
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Autorização
// ---------------------------------------------------------------------------------------------------------------------------------
test('[PSV-1] o ADMIN (com PROPOSE:LEAD_APPROVAL e READ:CRM) submete; o autor do lote vem SÓ do contexto autorizado, com a identidade mínima (nunca permissions, authUserId ou token)', (t) => {
  const env = ambiente(t);
  const relatorio = env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')]));
  assert.deepEqual(relatorio.criadoPor, { userId: ADMIN_USER.userId, name: ADMIN_USER.name, role: 'ADMIN' });
  assert.equal(relatorio.criadoEm, AGORA.toISOString());
  const texto = JSON.stringify(relatorio);
  for (const proibido of ['authUserId', 'auth-admin-promo', 'permissions', 'PROPOSE:', 'APPROVE:', 'WRITE:CRM', 'access_token', 'email']) assert.equal(texto.includes(proibido), false, proibido);
});

test('[PSV-2] o COMMERCIAL_CLOSER (sem PROPOSE:LEAD_APPROVAL) é recusado antes de qualquer coisa: nada é lido, criado, gravado ou alterado — em todas as operações', (t) => {
  const env = ambiente(t, { crm: [{ campos: { empresa: 'Registro Existente', site: 'existente.example.test' } }] });
  const efeitos = semEfeitos(env);
  assert.throws(() => env.servico.submitProspecting(closer(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')])), /acesso negado|permiss/i);
  assert.throws(() => env.servico.submitProspecting(closer(), { userId: 'x' }), /acesso negado|permiss/i, 'nem a validação da submissão é revelada a quem não está autorizado');
  assert.throws(() => env.servico.getBatch(closer(), 'lote:00000000-0000-4000-8000-000000000001'), /acesso negado|permiss/i);
  assert.throws(() => env.servico.listBatches(closer()), /acesso negado|permiss/i);
  efeitos.conferir('closer');
});

test('[PSV-3] usuário inativo e contexto forjado (objeto comum, mesmo com a forma perfeita) são recusados', (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  assert.throws(() => env.servico.submitProspecting(inativo(), submissao([achado('X Teste', 'x-teste')])), /inativo|acesso negado/i);
  const forjado = { userId: ADMIN_USER.userId, name: 'Falso', role: 'ADMIN', permissions: ['PROPOSE:LEAD_APPROVAL', 'READ:CRM', 'APPROVE:LEAD_APPROVAL', 'WRITE:CRM'], status: 'ACTIVE' };
  assert.throws(() => env.servico.submitProspecting(forjado, submissao([achado('X Teste', 'x-teste')])));
  assert.throws(() => env.servico.submitProspecting(undefined, submissao([])));
  assert.throws(() => env.servico.submitProspecting(null, submissao([])));
  efeitos.conferir('inativo/forjado');
});

test('[PSV-4] as duas portas são pedidas com EXATAMENTE as permissões certas (PROPOSE:LEAD_APPROVAL e READ:CRM), nesta ordem, e nenhuma de aprovação ou escrita', (t) => {
  const pedidos = [];
  const env = ambiente(t, {
    portas: {
      authorizeProposer: (contexto, permissao) => (pedidos.push(['proposta', permissao]), authorizeProposerForLeadApproval(contexto, permissao)),
      authorizeOperation: (contexto, permissao) => (pedidos.push(['crm', permissao]), authorizeCrmOperation(contexto, permissao)),
    },
  });
  env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')]));
  assert.deepEqual(pedidos.slice(0, 2), [['proposta', 'PROPOSE:LEAD_APPROVAL'], ['crm', 'READ:CRM']]);
  for (const [, permissao] of pedidos) assert.ok(['PROPOSE:LEAD_APPROVAL', 'READ:CRM'].includes(permissao), `permissão inesperada: ${permissao}`);
  assert.equal(PERMISSION.PROPOSE_LEAD_APPROVAL, 'PROPOSE:LEAD_APPROVAL');
});

test('[PSV-5] sem READ:CRM a submissão é recusada ANTES de validar qualquer dado e sem tocar em nada (mesmo com PROPOSE)', (t) => {
  const env = ambiente(t, {
    portas: {
      authorizeOperation: (contexto, permissao) => {
        if (permissao === 'READ:CRM') throw new Error('acesso negado: permissão READ:CRM ausente');
        return authorizeCrmOperation(contexto, permissao);
      },
    },
  });
  const efeitos = semEfeitos(env);
  assert.throws(() => env.servico.submitProspecting(admin(), { lixo: true }), /acesso negado/, 'a recusa de autorização vem antes da validação da submissão');
  assert.throws(() => env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')])), /acesso negado/);
  efeitos.conferir('sem READ:CRM');
});

test('[PSV-6] um autorizador defeituoso falha fechado: false, undefined, texto, identidade com campos a mais, role SYSTEM e Promise são recusas', (t) => {
  const maus = [() => false, () => undefined, () => 'ok', () => ({ userId: 'u', name: 'n', role: 'ADMIN', permissions: [] }), () => ({ userId: 'u', name: 'n', role: 'SYSTEM' }), () => ({ userId: '', name: 'n', role: 'ADMIN' }), () => Promise.resolve({ userId: 'u', name: 'n', role: 'ADMIN' })];
  for (const mau of maus) {
    const env = ambiente(t, { portas: { authorizeProposer: mau } });
    assert.throws(() => env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')])), /autorização recusada/);
    assert.equal(env.filaExiste(), false);
    assert.equal(env.lotesExistem(), false);
  }
  for (const mau of maus) {
    const env = ambiente(t, { portas: { authorizeOperation: mau } });
    assert.throws(() => env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')])), /autorização recusada/);
    assert.equal(env.lotesExistem(), false);
  }
});

test('[PSV-7] a criação exige tudo: portas, CRM Service com listRecords, repositório de lotes válido, dependências da fila e relógio; a fábrica de arquivo exige o caminho do CRM', (t) => {
  const env = ambiente(t);
  const base = { authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmService: { listRecords() {} }, batchRepository: createInMemoryBatchRepository(), queuePath: env.queuePath };
  assert.doesNotThrow(() => createProspectingService(base));
  assert.throws(() => createProspectingService(), /authorizeProposer/);
  assert.throws(() => createProspectingService({ ...base, authorizeProposer: undefined }), /authorizeProposer/);
  assert.throws(() => createProspectingService({ ...base, authorizeOperation: 'x' }), /authorizeOperation/);
  assert.throws(() => createProspectingService({ ...base, crmService: {} }), /listRecords/);
  assert.throws(() => createProspectingService({ ...base, crmService: null }), /listRecords/);
  assert.throws(() => createProspectingService({ ...base, batchRepository: {} }), /repositório de lotes/);
  assert.throws(() => createProspectingService({ ...base, batchRepository: undefined }), /repositório de lotes/);
  assert.throws(() => createProspectingService({ ...base, queuePath: '' }), /queuePath/);
  assert.throws(() => createProspectingService({ ...base, approvalQueue: {} }), /approvalQueue/);
  assert.throws(() => createProspectingService({ ...base, now: 5 }), /now e newId/);
  assert.throws(() => createFileBackedProspectingService({ authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation }), /crmPath/);
  assert.throws(() => createFileBackedProspectingService({ authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmPath: env.crmPath, batchPath: '' }), /batchPath/);
  const servico = createFileBackedProspectingService({ authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmPath: env.crmPath, queuePath: env.queuePath, batchPath: env.batchPath });
  assert.deepEqual(Object.keys(servico).sort(), ['getBatch', 'listBatches', 'submitProspecting'], 'nenhuma operação de aprovação, rejeição, promoção ou escrita no CRM');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Spoofing e o que o payload NÃO controla
// ---------------------------------------------------------------------------------------------------------------------------------
test('[PSV-8] a submissão aceita exatamente { briefing, rawFindings }: userId, role, permissions, actor, reviewedBy, approvalId, status, loteId, criadoPor, criadoEm, contagens e qualquer outra chave são recusados — e nada é gravado', (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  const intrusos = ['userId', 'role', 'permissions', 'actor', 'reviewedBy', 'approvalId', 'status', 'estado', 'loteId', 'criadoPor', 'criadoEm', 'contagens', 'validos', 'prospectIds', 'quantidadeDesejada', 'queuePath', 'batchPath', 'crmPath', 'arquivo', 'authUserId'];
  for (const chave of intrusos) {
    assert.throws(() => env.servico.submitProspecting(admin(), { ...submissao([achado('X Teste', 'x-teste')]), [chave]: 'valor-forjado' }), (e) => e instanceof ProspectingError && e.code === PROSPECTING_ERROR.INVALID_INPUT && e.details.errors.some((item) => item.code === 'CAMPO_DESCONHECIDO'));
  }
  for (const ruim of [null, undefined, 'texto', 5, [], () => {}]) assert.equal(codigoDe(() => env.servico.submitProspecting(admin(), ruim)), PROSPECTING_ERROR.INVALID_INPUT);
  assert.equal(codigoDe(() => env.servico.submitProspecting(admin(), { briefing: briefing() })), PROSPECTING_ERROR.INVALID_INPUT, 'falta rawFindings');
  assert.equal(codigoDe(() => env.servico.submitProspecting(admin(), { rawFindings: [] })), PROSPECTING_ERROR.INVALID_INPUT, 'falta o briefing');
  efeitos.conferir('spoofing');
});

test('[PSV-9] o briefing também só aceita as chaves conhecidas (nicho, quantidadeDesejada, regiao, tipo, exclusoes, observacoes); identidade, decisão e caminho nunca entram', (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  for (const chave of ['userId', 'role', 'permissions', 'actor', 'reviewedBy', 'status', 'loteId', 'criadoPor', 'queuePath', 'doNotContact']) {
    const erro = (() => {
      try {
        env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')], { briefing: { [chave]: 'forjado' } }));
      } catch (e) {
        return e;
      }
    })();
    assert.equal(erro.code, PROSPECTING_ERROR.BRIEFING_INVALID, chave);
    assert.ok(erro.details.errors.some((item) => item.path === `briefing.${chave}` && item.code === 'CAMPO_DESCONHECIDO'), chave);
  }
  efeitos.conferir('briefing forjado');
});

test('[PSV-10] o achado não controla o estado: status, confianca, statusIdentidade, estadoOperacional, doNotContact, statusDNC, prospectId, reviewedBy, aprovado... são recusados (tudo ou nada), e nada é gravado', (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  for (const chave of ['status', 'confianca', 'statusIdentidade', 'statusDados', 'statusDuplicidade', 'statusDNC', 'estadoOperacional', 'doNotContact', 'prospectId', 'reviewedBy', 'aprovado', 'valido', 'score', 'loteId']) {
    const erro = (() => {
      try {
        env.servico.submitProspecting(admin(), submissao([achado('Bom Teste', 'bom-teste'), { ...achado('Forjado Teste', 'forjado-teste'), [chave]: 'VALIDADO' }]));
      } catch (e) {
        return e;
      }
    })();
    assert.equal(erro.code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID, chave);
    assert.deepEqual(erro.details.errors.map((item) => `${item.path}:${item.code}`), [`rawFindings[1].${chave}:CAMPO_DESCONHECIDO`]);
  }
  efeitos.conferir('achado forjado');
});

test('[PSV-11] o lote é DERIVADO: criadoPor, criadoEm, loteId, status e contagens são do serviço, e o relatório não traz nada que o cliente possa ter escolhido', (t) => {
  const env = ambiente(t);
  const relatorio = env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste'), achado('Clínica Beta Teste', 'beta-teste')]));
  assert.match(relatorio.loteId, /^lote:00000000-0000-4000-8000-0000000000\d\d$/);
  assert.equal(relatorio.criadoEm, AGORA.toISOString());
  assert.equal(relatorio.criadoPor.userId, ADMIN_USER.userId);
  assert.equal(relatorio.status, 'EM_ANDAMENTO');
  assert.equal(relatorio.contagens.encontrados, 2);
  assert.equal(relatorio.contagens.validos, 2);
  assert.equal(relatorio.contagens.falta, 1);
  const gravado = env.lotes()[relatorio.loteId];
  assert.deepEqual(gravado, relatorio, 'o que foi gravado é exatamente o que foi devolvido');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------------------------------------------------------------
const erroDoBriefing = (env, extrasBriefing) => {
  try {
    env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')], { briefing: extrasBriefing }));
  } catch (e) {
    return e;
  }
  return null;
};

test('[PSV-12] briefing válido: com todos os campos e só com nicho e quantidade', (t) => {
  const env = ambiente(t);
  assert.equal(env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')])).briefing.regiao, 'Petrópolis/RJ');
  const minimo = env.servico.submitProspecting(admin(), { briefing: { nicho: '  Estética  ', quantidadeDesejada: 100 }, rawFindings: [] });
  assert.deepEqual(minimo.briefing, { nicho: 'Estética', quantidadeDesejada: 100 });
  assert.equal(minimo.contagens.falta, 100);
});

test('[PSV-13] nicho ausente, vazio, com tipo errado ou grande demais é recusado', (t) => {
  const env = ambiente(t);
  const sem = (() => { try { env.servico.submitProspecting(admin(), { briefing: { quantidadeDesejada: 5 }, rawFindings: [] }); } catch (e) { return e; } })();
  assert.equal(sem.code, PROSPECTING_ERROR.BRIEFING_INVALID);
  assert.deepEqual(sem.details.errors.map((e) => `${e.path}:${e.code}`), ['briefing.nicho:CAMPO_OBRIGATORIO']);
  for (const nicho of ['', '   ', 5, [], {}, true, 'x'.repeat(BRIEFING_LIMITS.NICHO + 1), 'com\u0000controle', 'com\u202Edireção']) {
    assert.equal(erroDoBriefing(env, { nicho }).code, PROSPECTING_ERROR.BRIEFING_INVALID, JSON.stringify(nicho));
  }
  assert.equal(erroDoBriefing(env, { nicho: 'x'.repeat(BRIEFING_LIMITS.NICHO) }), null);
});

test('[PSV-14] quantidade desejada: só inteiro positivo dentro do limite; ausente, zero, negativa, fracionária, texto, NaN, Infinity e acima do limite são recusados', (t) => {
  const env = ambiente(t);
  const sem = (() => { try { env.servico.submitProspecting(admin(), { briefing: { nicho: 'X Nicho' }, rawFindings: [] }); } catch (e) { return e; } })();
  assert.deepEqual(sem.details.errors.map((e) => `${e.path}:${e.code}`), ['briefing.quantidadeDesejada:CAMPO_OBRIGATORIO']);
  for (const quantidadeDesejada of [0, -1, 1.5, '10', NaN, Infinity, -Infinity, {}, [], true, BRIEFING_LIMITS.QUANTIDADE_MAX + 1, 100000]) {
    assert.equal(erroDoBriefing(env, { quantidadeDesejada }).code, PROSPECTING_ERROR.BRIEFING_INVALID, String(quantidadeDesejada));
  }
  assert.equal(erroDoBriefing(env, { quantidadeDesejada: 1 }), null);
  assert.equal(erroDoBriefing(env, { quantidadeDesejada: BRIEFING_LIMITS.QUANTIDADE_MAX }), null);
});

test('[PSV-15] região, tipo e observações: texto com limite; exclusões: lista limitada de textos de 3 a 120 caracteres (uma exclusão curta demais excluiria quase tudo)', (t) => {
  const env = ambiente(t);
  for (const chave of ['regiao', 'tipo']) {
    for (const valor of [5, [], {}, 'x'.repeat(121), '   ', 'a\u0007b']) assert.equal(erroDoBriefing(env, { [chave]: valor }).code, PROSPECTING_ERROR.BRIEFING_INVALID, `${chave} ${JSON.stringify(valor)}`);
    assert.equal(erroDoBriefing(env, { [chave]: 'x'.repeat(120) }), null);
  }
  assert.equal(erroDoBriefing(env, { observacoes: 'x'.repeat(BRIEFING_LIMITS.OBSERVACOES + 1) }).code, PROSPECTING_ERROR.BRIEFING_INVALID);
  assert.equal(erroDoBriefing(env, { observacoes: 'linha 1\nlinha 2' }), null);
  for (const exclusoes of ['Agência', {}, 5, [5], ['ab'], ['   '], ['x'.repeat(121)], [null], Array.from({ length: BRIEFING_LIMITS.EXCLUSOES + 1 }, (_, i) => `Exclusão ${i}`)]) {
    assert.equal(erroDoBriefing(env, { exclusoes }).code, PROSPECTING_ERROR.BRIEFING_INVALID, JSON.stringify(exclusoes).slice(0, 40));
  }
  assert.equal(erroDoBriefing(env, { exclusoes: ['Agência Alfa Digital', 'abc'] }), null);
  assert.equal(erroDoBriefing(env, { exclusoes: Array.from({ length: BRIEFING_LIMITS.EXCLUSOES }, (_, i) => `Exclusão ${i}`) }), null);
});

test('[PSV-16] um briefing inválido não expõe o valor recebido: o erro só tem caminho e código', (t) => {
  const env = ambiente(t);
  const erro = erroDoBriefing(env, { nicho: 'SEGREDO-<script>' + 'x'.repeat(200), quantidadeDesejada: 'SEGREDO2' });
  const texto = JSON.stringify({ message: erro.message, details: erro.details });
  assert.equal(texto.includes('SEGREDO'), false);
  assert.equal(texto.includes('script'), false);
  assert.equal(erro.stack === undefined, false, 'é um Error normal, mas a mensagem e os detalhes nunca carregam stack');
  assert.equal(JSON.stringify(erro.details).includes('at '), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Raw findings
// ---------------------------------------------------------------------------------------------------------------------------------
const erroDosAchados = (env, achados, briefingExtra) => {
  try {
    env.servico.submitProspecting(admin(), { briefing: briefing(briefingExtra), rawFindings: achados });
  } catch (e) {
    return e;
  }
  return null;
};

test('[PSV-17] achados válidos passam pelo esquema; um achado inválido recusa a submissão INTEIRA (tudo ou nada) com o caminho exato, e nada é gravado', (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  const erro = erroDosAchados(env, [achado('Bom Teste', 'bom-teste'), { tipo: 'sem empresa' }, achado('Outro Bom', 'outro-bom')]);
  assert.equal(erro.code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID);
  assert.deepEqual(erro.details.errors.map((e) => `${e.path}:${e.code}`), ['rawFindings[1].empresa:CAMPO_OBRIGATORIO']);
  efeitos.conferir('achado inválido');
});

test('[PSV-18] URL inválida ou de protocolo perigoso, conteúdo acima do limite, estrutura profunda e lote grande demais: recusados, sem repetir o valor', (t) => {
  const env = ambiente(t);
  const efeitos = semEfeitos(env);
  const casos = {
    'javascript:': achado('A Teste', 'a-teste', 'completo', { fontes: ['javascript:alert(1)'] }),
    'http:': achado('A Teste', 'a-teste', 'completo', { fontes: ['http://a-teste.example.test'] }),
    'ftp': achado('A Teste', 'a-teste', 'completo', { campos: { site: [{ ...evidencia('a.example.test'), url: 'ftp://a.example.test' }] } }),
    'file': achado('A Teste', 'a-teste', 'completo', { fontes: [{ url: 'file:///C:/Windows/win.ini' }] }),
    'IP': achado('A Teste', 'a-teste', 'completo', { fontes: ['https://10.0.0.1/x'] }),
    'texto gigante': achado('x'.repeat(5000), 'a-teste'),
    'observação gigante': achado('A Teste', 'a-teste', 'completo', { observacoesBrutas: 'x'.repeat(100000) }),
    'profundo': (() => { let fundo = 'x'; for (let i = 0; i < 50; i += 1) fundo = { a: fundo }; return { empresa: 'A Teste', campos: fundo }; })(),
  };
  for (const [nome, item] of Object.entries(casos)) {
    const erro = erroDosAchados(env, [item]);
    assert.equal(erro.code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID, nome);
    const texto = JSON.stringify(erro.details);
    assert.equal(texto.includes('alert(1)'), false, nome);
    assert.equal(texto.includes('win.ini'), false, nome);
  }
  const demais = Array.from({ length: LIMITS.ACHADOS_POR_LOTE + 1 }, (_, i) => achado(`Empresa ${i}`, `empresa-${i}`));
  const excesso = erroDosAchados(env, demais);
  assert.equal(excesso.code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID);
  assert.deepEqual(excesso.details.errors.map((e) => e.code), ['LOTE_EXCESSIVO']);
  for (const naoLista of [null, undefined, {}, 'x', 5]) assert.equal(erroDosAchados(env, naoLista).code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID);
  efeitos.conferir('achados perigosos');
});

test('[PSV-19] uma lista vazia de achados é uma submissão válida: um lote sem candidatos (falta a quantidade inteira) fica registrado', (t) => {
  const env = ambiente(t);
  const relatorio = env.servico.submitProspecting(admin(), submissao([]));
  assert.equal(relatorio.contagens.encontrados, 0);
  assert.equal(relatorio.contagens.falta, 3);
  assert.equal(relatorio.status, 'EM_ANDAMENTO');
  assert.deepEqual(relatorio.prospectIds, []);
  assert.equal(env.filaExiste(), false, 'sem candidatos elegíveis a fila nem é gravada');
  assert.ok(env.lotes()[relatorio.loteId]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Pipeline: DNC, duplicidade, insuficiência
// ---------------------------------------------------------------------------------------------------------------------------------
test('[PSV-20] os cinco tipos de candidato, juntos: válido e aguardando revisão entram; DNC do CRM, duplicado e dados insuficientes NÃO entram na fila (e a contabilidade os conta certo)', (t) => {
  const env = ambiente(t, {
    crm: [
      { campos: { empresa: 'Bloqueada Teste', site: 'bloqueada.example.test', telefone: '24 90000-1111' }, dnc: true },
      { campos: { empresa: 'Cliente Existente', site: 'existente.example.test' } },
    ],
  });
  const relatorio = env.servico.submitProspecting(
    admin(),
    submissao(
      [
        achado('Clínica Válida', 'valida-teste', 'completo'),
        achado('Clínica Parcial', 'parcial-teste', 'parcial'),
        achado('Nome Diferente Um', 'bloqueada', 'parcial'),
        achado('Nome Diferente Dois', 'existente', 'completo'),
        achado('Clínica Fraca', 'fraca-teste', 'fraco'),
      ],
      { briefing: { quantidadeDesejada: 10 } }
    )
  );
  const estado = Object.fromEntries(relatorio.resultados.map((r) => [r.empresa, [r.estadoOperacional, r.motivo, r.naFila]]));
  assert.deepEqual(estado['Clínica Válida'], ['VALIDADO_PARA_REVISAO', null, true]);
  assert.deepEqual(estado['Clínica Parcial'], ['AGUARDANDO_REVISAO', null, true]);
  assert.deepEqual(estado['Nome Diferente Um'], ['DNC', 'DNC', false]);
  assert.deepEqual(estado['Nome Diferente Dois'], ['DUPLICADO', 'DUPLICADO', false]);
  assert.deepEqual(estado['Clínica Fraca'], ['DADOS_INSUFICIENTES', 'DADOS_INSUFICIENTES', false]);

  const c = relatorio.contagens;
  assert.deepEqual([c.encontrados, c.validos, c.aguardandoRevisao, c.dnc, c.duplicados, c.dadosInsuficientes, c.possiveisDuplicados, c.rejeitados], [5, 1, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual([c.principal, c.reserva, c.falta, c.metaAtingida], [1, 0, 9, false]);
  assert.equal(relatorio.prospectIds.length, 2);
  assert.deepEqual(Object.keys(env.fila().items).sort(), [...relatorio.prospectIds].sort(), 'na fila só os dois elegíveis');
  const nomesNaFila = Object.values(env.fila().items).map((item) => item.empresa).sort();
  assert.deepEqual(nomesNaFila, ['Clínica Parcial', 'Clínica Válida']);
});

test('[PSV-21] DNC de verdade pelo CRM real: o registro em DO_NOT_CONTACT bloqueia por site, telefone, WhatsApp (mesmo guardado no campo "errado") e Instagram — e NUNCA chega à fila', (t) => {
  const env = ambiente(t, {
    crm: [{ campos: { empresa: 'Bloqueada Um', site: 'bloqueada-um.example.test', telefone: '24 90000-3333', whatsapp: '24 90000-4444', instagram: '@bloqueada_um', cidade: 'Niterói' }, dnc: true }],
  });
  const tentativas = [
    achado('Por Site', 'bloqueada-um', 'parcial'),
    achado('Por Telefone', 'por-telefone', 'parcial', { campos: { site: [evidencia('site-um.example.test')], telefone: [evidencia('(24) 90000-3333')] } }),
    achado('Por WhatsApp no campo telefone', 'por-whatsapp', 'parcial', { campos: { site: [evidencia('site-dois.example.test')], telefone: [evidencia('24900004444')] } }),
    achado('Por WhatsApp', 'por-whatsapp-2', 'parcial', { campos: { site: [evidencia('site-tres.example.test')], whatsapp: [evidencia('+55 24 90000-4444')] } }),
    achado('Por Instagram', 'por-instagram', 'parcial', { campos: { site: [evidencia('site-quatro.example.test')], instagram: [evidencia('@bloqueada_um')] } }),
  ];
  const relatorio = env.servico.submitProspecting(admin(), submissao(tentativas, { briefing: { quantidadeDesejada: 5 } }));
  for (const resultado of relatorio.resultados) {
    assert.equal(resultado.estadoOperacional, 'DNC', resultado.empresa);
    assert.equal(resultado.naFila, false, resultado.empresa);
  }
  assert.equal(relatorio.contagens.dnc, 5);
  assert.equal(relatorio.contagens.validos, 0);
  assert.deepEqual(relatorio.prospectIds, []);
  assert.equal(env.filaExiste(), false, 'nenhum item de DNC entra na fila');
});

test('[PSV-22] um registro do CRM em PROSPECT (não DNC) com a mesma identidade é DUPLICADO — não DNC — e também não entra; nome+cidade sozinho é POSSÍVEL duplicado e ENTRA para um humano ver', (t) => {
  const env = ambiente(t, {
    crm: [
      { campos: { empresa: 'Cliente Normal', telefone: '24 90000-5555', cidade: 'Petrópolis' } },
      { campos: { empresa: 'Clínica Mesmo Nome', cidade: 'Petrópolis' } },
    ],
  });
  const relatorio = env.servico.submitProspecting(
    admin(),
    submissao([
      achado('Outro Nome Qualquer', 'outro-nome', 'parcial', { campos: { telefone: [evidencia('24900005555')] } }),
      achado('Clínica Mesmo Nome', 'mesmo-nome-novo-site', 'parcial'),
    ])
  );
  const porNome = Object.fromEntries(relatorio.resultados.map((r) => [r.empresa, r]));
  assert.equal(porNome['Outro Nome Qualquer'].estadoOperacional, 'DUPLICADO');
  assert.deepEqual(porNome['Outro Nome Qualquer'].criterios, ['telefone']);
  assert.equal(porNome['Outro Nome Qualquer'].naFila, false);
  assert.equal(porNome['Clínica Mesmo Nome'].estadoOperacional, 'POSSIVEL_DUPLICADO');
  assert.equal(porNome['Clínica Mesmo Nome'].naFila, true, 'possível duplicidade exige olhar humano: entra, sinalizada');
  assert.equal(relatorio.contagens.possiveisDuplicados, 1);
  assert.equal(relatorio.contagens.duplicados, 1);
  assert.equal(relatorio.contagens.validos, 0, 'possível duplicado não conta como válido');
  const item = Object.values(env.fila().items)[0];
  assert.equal(item.discoverySnapshot.statusDuplicidade, 'POSSIVEL_DUPLICADO');
  assert.equal(item.estado, 'AGUARDANDO_REVISAO');
  assert.equal(JSON.stringify(relatorio).includes('crm:'), false, 'o relatório não traz o id do registro do CRM');
});

test('[PSV-23] o CRM ilegível (arquivo corrompido) recusa a submissão inteira — sem CRM o DNC não pode ser verificado — sem repetir o texto do erro, e sem gravar nada', (t) => {
  const env = ambiente(t);
  fs.writeFileSync(env.crmPath, '{ isto não é json');
  const erro = (() => { try { env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')])); } catch (e) { return e; } })();
  assert.equal(erro.code, PROSPECTING_ERROR.CRM_INVALID);
  assert.equal(JSON.stringify({ m: erro.message, d: erro.details }).includes(env.crmPath), false);
  assert.equal(env.filaExiste(), false);
  assert.equal(env.lotesExistem(), false);
});

test('[PSV-24] um registro do CRM que o adaptador não sabe interpretar recusa a submissão (falha fechada, nunca "ignorar e seguir sem DNC")', (t) => {
  const env = ambiente(t);
  const servico = createProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    crmService: { listRecords: () => [{ empresa: 'Ok', status: 'PROSPECT' }, null] },
    batchRepository: createInMemoryBatchRepository(),
    queuePath: env.queuePath,
  });
  assert.equal(codigoDe(() => servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')]))), PROSPECTING_ERROR.CRM_INVALID);
  assert.equal(env.filaExiste(), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------------------------------------------------------------
test('[PSV-25] o candidato elegível entra na fila JÁ existente, como AGUARDANDO_REVISAO, com a semântica atual: SYSTEM, sem reviewedBy, sem aprovação, sem estado novo', (t) => {
  const env = ambiente(t);
  const relatorio = env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste'), achado('Clínica Beta Teste', 'beta-teste', 'parcial')]));
  const itens = Object.values(env.fila().items);
  assert.equal(itens.length, 2);
  for (const item of itens) {
    assert.equal(item.estado, 'AGUARDANDO_REVISAO');
    assert.equal(item.historico.length, 1);
    assert.equal(item.historico[0].actor, 'SYSTEM');
    assert.equal(item.historico[0].to, 'AGUARDANDO_REVISAO');
    assert.equal('reviewedBy' in item.historico[0], false, 'ninguém aprovou');
    assert.equal('promocao' in item, false);
    assert.equal('loteId' in item, false, 'o lote não entra no schema dos itens da fila');
    assert.equal(JSON.stringify(item).includes('lote:'), false);
    assert.deepEqual(Object.keys(item).sort(), ['criadoEm', 'discoverySnapshot', 'empresa', 'estado', 'historico', 'lastSeenAt', 'prospectId']);
  }
  assert.deepEqual(Object.keys(env.fila().items).sort(), [...relatorio.prospectIds].sort());
  assert.deepEqual(Object.keys(queueDomain.QUEUE_STATE).sort(), ['AGUARDANDO_REVISAO', 'APROVADO_PARA_CRM', 'DADOS_INSUFICIENTES', 'DNC', 'DUPLICADO', 'EXPIRADO', 'REJEITADO'], 'nenhum estado novo');
});

test('[PSV-26] nenhuma aprovação automática — e o humano continua aprovando depois, pelo Approval Queue Service (o ADMIN aprova o que o Prospector propôs)', (t) => {
  const env = ambiente(t);
  const relatorio = env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')]));
  const [id] = relatorio.prospectIds;
  const fila = env.serviceDaFila();
  assert.equal(fila.listQueue(admin(), { estado: 'APROVADO_PARA_CRM' }).length, 0);
  assert.equal(fila.listQueue(admin(), { estado: 'AGUARDANDO_REVISAO' }).length, 1);
  const aprovado = fila.approveProspect(closer(), id, { reason: 'Bom fit' });
  assert.equal(aprovado.estado, 'APROVADO_PARA_CRM');
  assert.equal(aprovado.historico.at(-1).actor, 'HUMAN');
  assert.equal(aprovado.historico.at(-1).reviewedBy.role, 'COMMERCIAL_CLOSER', 'quem aprovou é o humano que aprovou, nunca quem propôs');
});

test('[PSV-27] a permissão de PROPOSE não aprova: o serviço não oferece nenhum caminho de aprovação e a ponte de aprovação nunca é usada por ele', (t) => {
  const env = ambiente(t);
  const pedidos = [];
  const espiao = createProspectingService({
    authorizeProposer: (c, p) => (pedidos.push(p), authorizeProposerForLeadApproval(c, p)),
    authorizeOperation: authorizeCrmOperation,
    crmService: createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: env.crmPath }),
    batchRepository: createInMemoryBatchRepository(),
    queuePath: env.queuePath,
  });
  espiao.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')]));
  assert.ok(pedidos.length > 0 && pedidos.every((p) => p === 'PROPOSE:LEAD_APPROVAL'));
  assert.equal(Object.keys(espiao).some((nome) => /approve|reject|promot|aprov|rejeit|promov/i.test(nome)), false);
  assert.deepEqual(Object.keys(queueDomain.createApprovalProposalActions({ authorizeProposer: () => ({ userId: 'u', name: 'n', role: 'ADMIN' }) })), ['proposeProspect']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Lote: contagens, reserva, falta, persistência, isolamento
// ---------------------------------------------------------------------------------------------------------------------------------
const nAchados = (n, prefixo = 'v') => Array.from({ length: n }, (_, i) => achado(`Clínica ${prefixo}${i} Teste`, `${prefixo}${i}-teste`, 'completo'));

test('[PSV-28] falta: menos válidos que o pedido — o lote fica EM_ANDAMENTO com a falta exata', (t) => {
  const env = ambiente(t);
  const r = env.servico.submitProspecting(admin(), submissao(nAchados(2), { briefing: { quantidadeDesejada: 5 } }));
  assert.deepEqual([r.contagens.validos, r.contagens.principal, r.contagens.reserva, r.contagens.falta, r.contagens.metaAtingida, r.status], [2, 2, 0, 3, false, 'EM_ANDAMENTO']);
});

test('[PSV-29] exatamente a quantidade e acima dela: META_ATINGIDA; o que passa do pedido é RESERVA — e todos os válidos entram na fila (a reserva também fica disponível para revisão)', (t) => {
  const env = ambiente(t);
  const exato = env.servico.submitProspecting(admin(), submissao(nAchados(3, 'e'), { briefing: { quantidadeDesejada: 3 } }));
  assert.deepEqual([exato.contagens.principal, exato.contagens.reserva, exato.contagens.falta, exato.status], [3, 0, 0, 'META_ATINGIDA']);
  const acima = env.servico.submitProspecting(admin(), submissao(nAchados(5, 'a'), { briefing: { quantidadeDesejada: 3 } }));
  assert.deepEqual([acima.contagens.validos, acima.contagens.principal, acima.contagens.reserva, acima.contagens.falta, acima.status], [5, 3, 2, 0, 'META_ATINGIDA']);
  assert.equal(acima.prospectIds.length, 5);
  assert.equal(Object.keys(env.fila().items).length, 8);
});

test('[PSV-30] "encontrado" não é "válido": encontrados 6, válidos só os que têm identidade e dados suficientes, sem score, ranking ou temperatura no lote', (t) => {
  const env = ambiente(t, { crm: [{ campos: { empresa: 'Bloqueada', site: 'bloq.example.test' }, dnc: true }] });
  const r = env.servico.submitProspecting(
    admin(),
    submissao([achado('V1 Teste', 'v1-teste'), achado('V2 Teste', 'v2-teste'), achado('P1 Teste', 'p1-teste', 'parcial'), achado('F1 Teste', 'f1-teste', 'fraco'), achado('Bloqueada Nome', 'bloq', 'parcial'), achado('F2 Teste', 'f2-teste', 'fraco')], { briefing: { quantidadeDesejada: 4 } })
  );
  const c = r.contagens;
  assert.deepEqual([c.encontrados, c.validos, c.aguardandoRevisao, c.dadosInsuficientes, c.dnc, c.falta], [6, 2, 1, 2, 1, 2]);
  const texto = JSON.stringify(r);
  for (const proibido of ['score', 'ranking', 'temperatura', 'melhor']) assert.equal(texto.includes(proibido), false, proibido);
});

test('[PSV-31] persistência e releitura: o lote é gravado no arquivo próprio, sobrevive a um serviço novo sobre o mesmo arquivo (reabertura) e getBatch/listBatches devolvem cópias iguais', (t) => {
  const env = ambiente(t);
  const r1 = env.servico.submitProspecting(admin(), submissao(nAchados(2, 'p')));
  assert.ok(fs.existsSync(env.batchPath));
  assert.equal(path.basename(env.batchPath), 'prospecting-batches.json');
  const reaberto = env.reabrir();
  assert.deepEqual(reaberto.getBatch(admin(), r1.loteId), r1);
  const r2 = reaberto.submitProspecting(admin(), submissao(nAchados(1, 'q')));
  assert.deepEqual(reaberto.listBatches(admin()).map((l) => l.loteId).sort(), [r1.loteId, r2.loteId].sort());
  // cópias: alterar o que foi devolvido não muda o que está guardado
  const lido = reaberto.getBatch(admin(), r1.loteId);
  lido.contagens.validos = 999;
  lido.criadoPor.role = 'FORJADO';
  assert.equal(reaberto.getBatch(admin(), r1.loteId).contagens.validos, 2);
  assert.equal(reaberto.getBatch(admin(), r1.loteId).criadoPor.role, 'ADMIN');
});

test('[PSV-32] isolamento entre lotes: cada submissão é um lote com o seu id, o seu briefing, as suas contagens e os seus prospects; um lote não altera o outro', (t) => {
  const env = ambiente(t);
  const a = env.servico.submitProspecting(admin(), submissao(nAchados(2, 'a'), { briefing: { nicho: 'Psicologia', quantidadeDesejada: 2 } }));
  const antesDeA = JSON.stringify(env.lotes()[a.loteId]);
  const b = env.servico.submitProspecting(admin(), submissao(nAchados(3, 'b'), { briefing: { nicho: 'Estética', quantidadeDesejada: 10 } }));
  assert.notEqual(a.loteId, b.loteId);
  assert.equal(JSON.stringify(env.lotes()[a.loteId]), antesDeA, 'gravar o lote B não mexeu no lote A');
  assert.equal(a.briefing.nicho, 'Psicologia');
  assert.equal(b.briefing.nicho, 'Estética');
  assert.deepEqual(a.prospectIds.filter((id) => b.prospectIds.includes(id)), [], 'prospects diferentes, nenhum em comum');
  assert.deepEqual([a.contagens.validos, b.contagens.validos, a.contagens.falta, b.contagens.falta], [2, 3, 0, 7]);
  assert.equal(env.servico.listBatches(admin()).length, 2);
});

test('[PSV-33] getBatch: id fora do formato (inclusive __proto__, caminho, vazio) é entrada inválida; lote inexistente é NOT_FOUND; nunca lança outra coisa', (t) => {
  const env = ambiente(t);
  for (const ruim of ['', '__proto__', 'constructor', '../../etc/passwd', 'lote:x', 'lote:00000000-0000-4000-8000-00000000000Z', 5, null, undefined, {}, ['lote:00000000-0000-4000-8000-000000000001']]) {
    assert.equal(codigoDe(() => env.servico.getBatch(admin(), ruim)), PROSPECTING_ERROR.INVALID_INPUT, JSON.stringify(ruim));
  }
  assert.equal(codigoDe(() => env.servico.getBatch(admin(), 'lote:00000000-0000-4000-8000-000000000099')), PROSPECTING_ERROR.NOT_FOUND);
  assert.deepEqual(env.servico.listBatches(admin()), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Idempotência
// ---------------------------------------------------------------------------------------------------------------------------------
test('[PSV-34] o mesmo candidato repetido na mesma submissão (mesmo id estável, mesmo com outra grafia do site) conta UMA vez e entra UMA vez', (t) => {
  const env = ambiente(t);
  const r = env.servico.submitProspecting(
    admin(),
    submissao([achado('Clínica Alfa', 'alfa-teste'), achado('Clínica Alfa (repetida)', 'alfa-teste'), achado('Clínica Alfa Site', 'alfa-teste', 'completo', { campos: { site: [evidencia('https://www.ALFA-TESTE.example.test/')] } })])
  );
  assert.equal(r.contagens.encontrados, 1);
  assert.equal(r.repetidosNaSubmissao, 2);
  assert.equal(r.prospectIds.length, 1);
  assert.equal(Object.keys(env.fila().items).length, 1);
  assert.deepEqual(r.resultados.map((x) => x.motivo), [null, 'REPETIDO_NA_SUBMISSAO', 'REPETIDO_NA_SUBMISSAO']);
  assert.equal(r.resultados.filter((x) => x.naFila).length, 1);
});

test('[PSV-35] a mesma submissão repetida: a fila NÃO duplica o item (regra existente de reentrada), o histórico registra o redescobrimento, e um novo lote é registrado', (t) => {
  const env = ambiente(t);
  const envio = () => env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')]));
  const primeiro = envio();
  const segundo = envio();
  assert.notEqual(primeiro.loteId, segundo.loteId);
  assert.equal(segundo.prospectIds[0], primeiro.prospectIds[0]);
  assert.equal(segundo.jaExistiamNaFila, 1);
  assert.equal(segundo.adicionadosNaFila, 0);
  assert.equal(segundo.resultados[0].jaExistiaNaFila, true);
  const itens = Object.values(env.fila().items);
  assert.equal(itens.length, 1, 'nenhuma duplicação na fila');
  assert.equal(itens[0].estado, 'AGUARDANDO_REVISAO');
  assert.match(itens[0].historico.at(-1).motivo, /Redescoberto/);
});

test('[PSV-36] uma decisão humana nunca é sobrescrita: depois de APROVADO, reenviar o candidato mantém APROVADO_PARA_CRM (conta como válido) — e depois de REJEITADO, mantém REJEITADO (conta como rejeitado)', (t) => {
  const env = ambiente(t);
  const primeiro = env.servico.submitProspecting(admin(), submissao([achado('Clínica Aprovada', 'aprovada-teste'), achado('Clínica Rejeitada', 'rejeitada-teste')]));
  const fila = env.serviceDaFila();
  const [idAprovada, idRejeitada] = primeiro.resultados.map((r) => r.prospectId);
  fila.approveProspect(closer(), idAprovada, {});
  fila.rejectProspect(closer(), idRejeitada, { reason: 'Sem fit' });
  const segundo = env.servico.submitProspecting(admin(), submissao([achado('Clínica Aprovada', 'aprovada-teste'), achado('Clínica Rejeitada', 'rejeitada-teste')], { briefing: { quantidadeDesejada: 2 } }));
  const porNome = Object.fromEntries(segundo.resultados.map((r) => [r.empresa, r]));
  assert.equal(porNome['Clínica Aprovada'].estadoFila, 'APROVADO_PARA_CRM');
  assert.equal(porNome['Clínica Rejeitada'].estadoFila, 'REJEITADO');
  assert.deepEqual([segundo.contagens.validos, segundo.contagens.rejeitados, segundo.contagens.falta], [1, 1, 1]);
  assert.equal(env.fila().items[idAprovada].estado, 'APROVADO_PARA_CRM');
  assert.equal(env.fila().items[idRejeitada].estado, 'REJEITADO');
});

test('[PSV-37] exclusões do briefing: um achado excluído não é candidato (não entra na contagem nem na fila) e o lote registra quantos foram excluídos', (t) => {
  const env = ambiente(t);
  const r = env.servico.submitProspecting(admin(), submissao([achado('Agência Alfa Digital Petrópolis', 'agencia-alfa'), achado('Clínica Boa Teste', 'boa-teste')], { briefing: { exclusoes: ['Agência Alfa Digital'] } }));
  assert.equal(r.excluidosPeloBriefing, 1);
  assert.equal(r.contagens.encontrados, 1);
  assert.deepEqual(r.resultados.map((x) => x.empresa), ['Clínica Boa Teste']);
  assert.equal(Object.keys(env.fila().items).length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Persistência e conflito
// ---------------------------------------------------------------------------------------------------------------------------------
test('[PSV-38] fila ilegível: erro de persistência estável, nenhum lote gravado, sem repetir o texto do erro nem o caminho', (t) => {
  const env = ambiente(t);
  fs.writeFileSync(env.queuePath, '{ corrompido');
  const erro = (() => { try { env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')])); } catch (e) { return e; } })();
  assert.equal(erro.code, PROSPECTING_ERROR.PERSISTENCE);
  assert.equal(JSON.stringify({ m: erro.message, d: erro.details }).includes(env.queuePath), false);
  assert.equal(env.lotesExistem(), false);
});

test('[PSV-39] falha ao gravar o lote DEPOIS de a fila ser gravada: erro de persistência que diz quais prospects entraram; repetir a submissão é seguro (a fila não duplica)', (t) => {
  const falho = { list: () => [], getById: () => null, add: () => { throw new Error('disco cheio em C:\\segredo\\lotes.json'); } };
  const env = ambiente(t, { batchRepository: falho });
  const erro = (() => { try { env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')])); } catch (e) { return e; } })();
  assert.equal(erro.code, PROSPECTING_ERROR.PERSISTENCE);
  assert.equal(erro.details.prospectIds.length, 1);
  assert.equal(JSON.stringify({ m: erro.message, d: erro.details }).includes('segredo'), false);
  assert.equal(Object.keys(env.fila().items).length, 1);
  assert.throws(() => env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')])), (e) => e.code === PROSPECTING_ERROR.PERSISTENCE);
  assert.equal(Object.keys(env.fila().items).length, 1, 'repetir não duplica');
});

test('[PSV-40] conflito: um loteId que já existe nunca é sobrescrito — erro de conflito estável e o lote original intacto', (t) => {
  const env = ambiente(t, { newId: () => 'lote:11111111-1111-4111-8111-111111111111' });
  const primeiro = env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')]));
  const antes = JSON.stringify(env.lotes());
  const erro = (() => { try { env.servico.submitProspecting(admin(), submissao([achado('Clínica Beta Teste', 'beta-teste')])); } catch (e) { return e; } })();
  assert.equal(erro.code, PROSPECTING_ERROR.CONFLICT);
  assert.equal(JSON.stringify(env.lotes()), antes);
  assert.equal(env.lotes()[primeiro.loteId].resultados[0].empresa, 'Clínica Alfa Teste');
});

test('[PSV-41] um id de lote gerado fora do formato nunca é gravado (falha estável, nada de lote com id perigoso)', (t) => {
  for (const id of ['__proto__', 'lote:x', '', 5, null]) {
    const env = ambiente(t, { newId: () => id });
    assert.equal(codigoDe(() => env.servico.submitProspecting(admin(), submissao([achado('X Teste', 'x-teste')]))), PROSPECTING_ERROR.PERSISTENCE, String(id));
    assert.equal(env.lotesExistem(), false);
    assert.equal(env.filaExiste(), false, 'nada é gravado antes de o id do lote ser válido');
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Segurança e erros
// ---------------------------------------------------------------------------------------------------------------------------------
test('[PSV-42] os erros do serviço são ProspectingError com código estável e mensagem fixa em português — nunca stack, valor recebido, caminho ou dado do achado', (t) => {
  const env = ambiente(t);
  const codigos = [];
  const tentar = (fn) => { try { fn(); } catch (e) { codigos.push(e); } };
  tentar(() => env.servico.submitProspecting(admin(), null));
  tentar(() => env.servico.submitProspecting(admin(), { briefing: { nicho: 'SEGREDO' }, rawFindings: [] }));
  tentar(() => env.servico.submitProspecting(admin(), submissao([{ empresa: 'SEGREDO', fontes: ['javascript:SEGREDO'] }])));
  tentar(() => env.servico.getBatch(admin(), 'lote:00000000-0000-4000-8000-000000000099'));
  assert.deepEqual(codigos.map((e) => e.code), ['PROSPECTING_INVALID_INPUT', 'PROSPECTING_BRIEFING_INVALID', 'PROSPECTING_RAW_FINDINGS_INVALID', 'PROSPECTING_NOT_FOUND']);
  for (const erro of codigos) {
    assert.ok(erro instanceof ProspectingError);
    assert.match(erro.message, /^Prospecção: /);
    assert.equal(erro.message.includes('SEGREDO'), false);
    assert.equal(JSON.stringify(erro.details || {}).includes('SEGREDO'), false);
    assert.equal(/\bat \w+.*\(|node_modules|\.js:\d+/.test(erro.message + JSON.stringify(erro.details || {})), false, 'sem stack nem caminhos');
  }
  assert.deepEqual(Object.values(PROSPECTING_ERROR).sort(), ['PROSPECTING_BRIEFING_INVALID', 'PROSPECTING_CANDIDATE_INVALID', 'PROSPECTING_CONFLICT', 'PROSPECTING_CRM_INVALID', 'PROSPECTING_INVALID_INPUT', 'PROSPECTING_NOT_FOUND', 'PROSPECTING_PERSISTENCE', 'PROSPECTING_RAW_FINDINGS_INVALID']);
});

test('[PSV-43] nada do achado é executado nem vira caminho: HTML e JavaScript ficam como texto inerte na fila, e um achado com caminho de arquivo é recusado', (t) => {
  const env = ambiente(t);
  const r = env.servico.submitProspecting(admin(), submissao([achado('Clínica <img src=x onerror=alert(1)> Teste', 'xss-teste', 'completo', { observacoesBrutas: '<script>alert(1)</script>' })]));
  const item = Object.values(env.fila().items)[0];
  assert.equal(item.empresa, 'Clínica <img src=x onerror=alert(1)> Teste', 'guardado como texto (quem exibe usa textContent)');
  assert.equal(r.prospectIds.length, 1);
  for (const chave of ['arquivo', 'caminho', 'path', 'file', 'queuePath']) {
    assert.equal(erroDosAchados(env, [{ ...achado('Y Teste', 'y-teste'), [chave]: 'C:/Windows/win.ini' }]).code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID, chave);
  }
});

test('[PSV-44] o serviço não faz rede, não usa IA, não escreve no CRM e não cria rota: o código só importa o que precisa e o CRM não muda em nenhuma submissão', (t) => {
  const env = ambiente(t, { crm: [{ campos: { empresa: 'Registro Existente', site: 'existente.example.test' } }] });
  const antes = env.textoCrm();
  env.servico.submitProspecting(admin(), submissao(nAchados(3)));
  env.servico.submitProspecting(admin(), submissao([achado('Nome Diferente', 'existente', 'parcial')]));
  assert.equal(env.textoCrm(), antes, 'o CRM não foi tocado');
  const codigo = fs.readFileSync(require.resolve('../../src/services/prospectingService.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const proibido of [/require\((['"])(node:)?(http|https|net|dns|child_process|fs)\1\)/, /\bfetch\(/, /XMLHttpRequest/, /\beval\(/, /new Function/, /process\.env/, /createRecord|updateRecord|moveStatus|markDoNotContact/, /approveProspect|rejectProspect|recordPromotion/, /authorizeReviewer/, /APPROVE_LEAD_APPROVAL/, /WRITE_CRM/]) {
    assert.doesNotMatch(codigo, proibido, String(proibido));
  }
});

test('[PSV-45] uma recusa de autorização no meio do processamento (o domínio reautoriza cada proposta) passa INTACTA — nunca vira um erro de candidato — e nada é gravado', (t) => {
  let chamadas = 0;
  const env = ambiente(t, {
    portas: {
      authorizeProposer: (contexto, permissao) => {
        chamadas += 1;
        if (chamadas > 1) throw new Error('acesso negado: PROPOSE:LEAD_APPROVAL revogada');
        return authorizeProposerForLeadApproval(contexto, permissao);
      },
    },
  });
  const erro = (() => { try { env.servico.submitProspecting(admin(), submissao([achado('Clínica Alfa Teste', 'alfa-teste')])); } catch (e) { return e; } })();
  assert.ok(erro);
  assert.equal(erro instanceof ProspectingError, false, 'não é um erro de candidato');
  assert.match(erro.message, /^acesso negado/);
  assert.equal(env.filaExiste(), false);
  assert.equal(env.lotesExistem(), false);
});
