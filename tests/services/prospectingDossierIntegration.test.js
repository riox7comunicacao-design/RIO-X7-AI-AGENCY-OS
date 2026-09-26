// Integração do DOSSIÊ ao Prospecting Service (decisão 0019): rawFindings -> discovery -> dossiê -> fila -> lote, dentro do submitProspecting.
//
// Peças REAIS: contextos de autorização do emissor interno, as duas pontes reais, o CRM real (arquivo), o discovery, a fila de arquivo,
// os repositórios de lote e de dossiê de arquivo. Só o relógio e os ids são fixados; falhas de persistência são injetadas por
// repositórios/fila que lançam. Tudo em diretório temporário, dados fictícios (example.test), nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crm = require('../../src/crm');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { authorizeProposerForLeadApproval, authorizeCrmOperation } = require('../../src/auth');
const { createProspectingService, ProspectingError, PROSPECTING_ERROR } = require('../../src/services/prospectingService');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createJsonFileBatchRepository } = require('../../src/research-prospector/batchRepository');
const { createJsonFileDossierRepository } = require('../../src/research-prospector/dossierRepository');
const { computeBatchAccounting } = require('../../src/research-prospector/batchAccounting');
const queueDomain = require('../../src/research-prospector/approvalQueue');
const { admin, closer } = require('../helpers/promotionFixtures');

const OPERADOR = { actor: 'HUMAN', reviewedBy: { userId: 'user-teste', name: 'Teste', role: 'ADMIN' }, motivo: 'teste' };
const AGORA = new Date('2026-09-25T15:00:00.000Z');
const DATA = '2026-09-24';

function ambiente(t, opcoes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivos = { queue: path.join(dir, 'approval-queue.json'), crm: path.join(dir, 'crm.json'), batch: path.join(dir, 'prospecting-batches.json'), dossier: path.join(dir, 'prospecting-dossiers.json') };
  const repositorioCrm = createJsonFileCrmRepository(arquivos.crm);
  for (const { campos, dnc } of opcoes.crm || []) {
    const { record } = crm.createRecord(repositorioCrm, campos, OPERADOR);
    if (dnc) crm.markDoNotContact(repositorioCrm, record.id, OPERADOR);
  }
  const ordem = [];
  const chamadasCrm = [];
  const crmReal = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: arquivos.crm });
  const crmService = { listRecords: (...args) => (chamadasCrm.push('listRecords'), crmReal.listRecords(...args)) };
  const batchReal = createJsonFileBatchRepository(arquivos.batch);
  const dossierReal = createJsonFileDossierRepository(arquivos.dossier);
  const batchRepository = opcoes.batchRepository || { ...batchReal, add: (lote) => (ordem.push('lote'), batchReal.add(lote)) };
  const dossierRepository = opcoes.dossierRepository || { ...dossierReal, save: (d) => (ordem.push('dossie'), dossierReal.save(d)) };
  const approvalQueue = opcoes.approvalQueue || { ...queueDomain, saveQueueToDisk: (q, p) => (ordem.push('fila'), queueDomain.saveQueueToDisk(q, p)) };
  let lotes = 0;
  let dossies = 0;
  const criar = () =>
    createProspectingService({
      authorizeProposer: authorizeProposerForLeadApproval,
      authorizeOperation: authorizeCrmOperation,
      crmService,
      batchRepository,
      dossierRepository,
      approvalQueue,
      queuePath: arquivos.queue,
      now: () => AGORA,
      newId: () => `lote:00000000-0000-4000-8000-${String((lotes += 1)).padStart(12, '0')}`,
      newDossierId: () => `dossie:00000000-0000-4000-8000-${String((dossies += 1)).padStart(12, '0')}`,
    });
  const ler = (arquivo) => (fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : null);
  return {
    dir,
    arquivos,
    ordem,
    chamadasCrm,
    servico: criar(),
    fila: () => ler(arquivos.queue) || { items: {} },
    lotes: () => ler(arquivos.batch) || {},
    dossies: () => ler(arquivos.dossier) || {},
    crmTexto: () => (fs.existsSync(arquivos.crm) ? fs.readFileSync(arquivos.crm, 'utf8') : ''),
    existe: (arquivo) => fs.existsSync(arquivos[arquivo]),
  };
}

const ev = (valor, slug, tipoFonte = 'OFICIAL') => ({ valor, fonte: 'Fonte de teste', tipoFonte, url: `https://fonte.example.test/${slug}`, dataConsulta: DATA });
const achadoRico = (nome, slug, extras = {}) => ({
  empresa: nome,
  tipo: 'clínica',
  cidade: 'Petrópolis',
  estado: 'RJ',
  nicho: 'Psicologia',
  campos: {
    site: [ev(`https://${slug}.example.test`, slug)],
    instagram: [ev(`https://instagram.example.test/${slug}`, slug)],
    whatsapp: [ev('(24) 98765-1000', slug)],
    telefone: [ev('(24) 98765-1000', slug)],
  },
  fontes: [`https://${slug}.example.test`],
  ...extras,
});
const evSimples = (valor, tipoFonte = 'OFICIAL') => ({ valor, fonte: 'Fonte de teste', tipoFonte });
const achadoSimples = (nome, slug, nivel = 'completo') => ({
  empresa: nome,
  tipo: 'clínica',
  cidade: 'Petrópolis',
  estado: 'RJ',
  nicho: 'Psicologia',
  campos: { completo: { site: [evSimples(`${slug}.example.test`)], instagram: [evSimples(`@${slug.replace(/-/g, '_')}`)], telefone: [evSimples('(24) 98765-1000')] }, parcial: { site: [evSimples(`${slug}.example.test`)] }, fraco: { site: [evSimples(`${slug}.example.test`, 'SECUNDARIA')] } }[nivel],
  fontes: [`https://${slug}.example.test`],
});
const briefing = (extras = {}) => ({ nicho: 'Psicologia', quantidadeDesejada: 3, regiao: 'Petrópolis/RJ', tipo: 'clínica', exclusoes: [], ...extras });
const submissao = (achados, extras = {}) => ({ briefing: briefing(extras), rawFindings: achados });
const erroDe = (fn) => {
  try {
    fn();
  } catch (erro) {
    return erro;
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------------------------
test('[PDI-1] uma submissão válida cria o lote e o dossiê; o dossiê carrega o loteId e o prospectId do candidato; a associação é só por identificadores', (t) => {
  const env = ambiente(t);
  const r = env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
  assert.equal(r.loteId, 'lote:00000000-0000-4000-8000-000000000001');
  assert.deepEqual(Object.keys(env.lotes()), [r.loteId]);
  assert.deepEqual(r.dossierIds, ['dossie:00000000-0000-4000-8000-000000000001']);
  const dossie = env.dossies()[r.dossierIds[0]];
  assert.equal(dossie.loteId, r.loteId);
  assert.equal(dossie.prospectId, r.prospectIds[0]);
  assert.equal(dossie.dossierId, r.dossierIds[0]);
  assert.equal(r.resultados[0].dossierId, r.dossierIds[0]);
  assert.equal(env.lotes()[r.loteId].dossierIds[0], r.dossierIds[0]);
  // a fila não sabe do lote nem do dossiê: nenhum campo novo e nenhum id no item
  const item = env.fila().items[r.prospectIds[0]];
  const texto = JSON.stringify(item);
  for (const proibido of ['loteId', 'dossierId', 'dossie:', 'lote:', 'fatos', 'sinais']) assert.equal(texto.includes(proibido), false, proibido);
  // o dossiê não guarda dado de contato/identidade do prospect
  for (const campo of ['empresa', 'telefone', 'site', 'instagram', 'cidade', 'score', 'temperatura', 'ranking', 'prioridade', 'estado', 'status']) assert.equal(campo in dossie, false, campo);
});

test('[PDI-2] os sinais são derivados pelo dossiê a partir dos fatos traduzidos do achado (fonte https + data => DADO; sem isso => NAO_VERIFICADO); nada de Instagram-atividade, CTA ou anúncios', (t) => {
  const env = ambiente(t);
  const r = env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
  const dossie = env.dossies()[r.dossierIds[0]];
  const sinais = Object.fromEntries(dossie.sinais.map((s) => [s.tipo, s]));
  assert.deepEqual(Object.keys(sinais).sort(), ['INSTAGRAM_EXISTENTE', 'SITE_EXISTENTE', 'WHATSAPP_PUBLICO']);
  assert.deepEqual([sinais.SITE_EXISTENTE.status, sinais.SITE_EXISTENTE.valor, sinais.SITE_EXISTENTE.evidencias], ['DADO', 'PRESENTE', ['fato:site.url']]);
  assert.equal(dossie.dataDaPesquisa, DATA);
  assert.deepEqual(dossie.analises, []);
  assert.equal(dossie.fontes.length, 1, 'a mesma fonte não repete');
  assert.equal(dossie.criadoEm, AGORA.toISOString());
  assert.deepEqual(dossie.fatos.map((f) => f.status), ['DADO', 'DADO', 'DADO']);
  assert.equal(dossie.fatos[0].fonte.tipo, 'OFICIAL');
  assert.equal(dossie.fatos[0].fonte.url, 'https://fonte.example.test/alfa-teste');

  // sem url/data na evidência (ou valor que não é URL, como @usuario): NAO_VERIFICADO — nunca uma url ou data inventada
  const env2 = ambiente(t);
  const r2 = env2.servico.submitProspecting(admin(), submissao([achadoSimples('Clínica Beta Teste', 'beta-teste')]));
  const d2 = env2.dossies()[r2.dossierIds[0]];
  const porCampo = Object.fromEntries(d2.fatos.map((f) => [f.campo, f]));
  assert.deepEqual([porCampo['site.url'].status, porCampo['site.url'].valor, porCampo['site.url'].fonte], ['NAO_VERIFICADO', null, null]);
  assert.equal(porCampo['instagram.url'].status, 'NAO_VERIFICADO');
  assert.equal(d2.sinais.every((s) => s.status === 'NAO_VERIFICADO' && s.valor === null), true);
  assert.equal('telefone' in porCampo, false);
});

test('[PDI-3] a fila recebe SÓ elegíveis; DNC, duplicado e dados insuficientes não entram na fila NEM ganham dossiê (ficam só no relatório do lote); possível duplicidade mantém o comportamento existente (entra, com dossiê)', (t) => {
  const env = ambiente(t, {
    crm: [
      { campos: { empresa: 'Bloqueada Teste', site: 'bloqueada.example.test', telefone: '24 90000-1111' }, dnc: true },
      { campos: { empresa: 'Cliente Existente', site: 'existente.example.test' } },
      { campos: { empresa: 'Clínica Mesmo Nome', cidade: 'Petrópolis' } },
    ],
  });
  const r = env.servico.submitProspecting(
    admin(),
    submissao(
      [
        achadoRico('Clínica Válida', 'valida-teste'),
        achadoRico('Nome Diferente Um', 'bloqueada'),
        achadoRico('Nome Diferente Dois', 'existente'),
        achadoSimples('Clínica Fraca', 'fraca-teste', 'fraco'),
        achadoRico('Clínica Mesmo Nome', 'mesmo-nome-novo-site'),
      ],
      { quantidadeDesejada: 10 }
    )
  );
  const porNome = Object.fromEntries(r.resultados.map((x) => [x.empresa, x]));
  assert.deepEqual(porNome['Nome Diferente Um'].estadoOperacional, 'DNC');
  assert.deepEqual(porNome['Nome Diferente Dois'].estadoOperacional, 'DUPLICADO');
  assert.deepEqual(porNome['Clínica Fraca'].estadoOperacional, 'DADOS_INSUFICIENTES');
  assert.equal(porNome['Clínica Mesmo Nome'].estadoOperacional, 'POSSIVEL_DUPLICADO');
  for (const nome of ['Nome Diferente Um', 'Nome Diferente Dois', 'Clínica Fraca']) {
    assert.deepEqual([porNome[nome].naFila, porNome[nome].dossierId], [false, null], nome);
    assert.ok(porNome[nome].motivo, `${nome}: o motivo fica no relatório do lote`);
  }
  for (const nome of ['Clínica Válida', 'Clínica Mesmo Nome']) assert.deepEqual([porNome[nome].naFila, typeof porNome[nome].dossierId], [true, 'string'], nome);
  assert.deepEqual(Object.keys(env.fila().items).sort(), [...r.prospectIds].sort());
  assert.equal(Object.keys(env.fila().items).length, 2);
  assert.deepEqual(Object.values(env.dossies()).map((d) => d.prospectId).sort(), [...r.prospectIds].sort(), 'um dossiê por candidato elegível, nenhum por bloqueado');
  assert.equal(r.dossierIds.length, 2);
  assert.equal(JSON.stringify(env.dossies()).includes('bloqueada'), false, 'nada do candidato DNC foi guardado');
});

test('[PDI-4] a aprovação e a promoção NÃO ocorrem: os itens ficam AGUARDANDO_REVISAO, sem reviewedBy nem decisão, e o CRM não recebe nenhuma escrita (só listRecords é usado)', (t) => {
  const env = ambiente(t, { crm: [{ campos: { empresa: 'Cliente Existente', site: 'existente.example.test' } }] });
  const crmAntes = env.crmTexto();
  env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste')]));
  const itens = Object.values(env.fila().items);
  assert.equal(itens.length, 2);
  for (const item of itens) {
    assert.equal(item.estado, 'AGUARDANDO_REVISAO');
    assert.equal(item.reviewedBy ?? null, null);
    assert.notEqual(item.estado, 'APROVADO_PARA_CRM');
    assert.notEqual(item.estado, 'REJEITADO');
  }
  assert.equal(env.crmTexto(), crmAntes, 'o arquivo do CRM não mudou');
  assert.deepEqual([...new Set(env.chamadasCrm)], ['listRecords']);
  const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'prospectingService.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const proibido of [/approveProspect|promoteProspect|rejectProspect/, /createRecord|updateRecord|moveStatus|markDoNotContact|writeRecord/, /crmBridge|authorizeReviewer|approvalBridge/]) assert.doesNotMatch(codigo, proibido);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'research-prospector', 'dossierFromFinding.js'), 'utf8').replace(/\/\/.*$/gm, ''), /require\('\.\.\/crm|src\/crm|fs|fetch/);
});

test('[PDI-5] as contagens usam o batchAccounting existente (o lote traz exatamente o que a função pura calcula), e só os estados do modelo contam como válidos', (t) => {
  const env = ambiente(t, { crm: [{ campos: { empresa: 'Bloqueada Teste', site: 'bloqueada.example.test' }, dnc: true }] });
  const r = env.servico.submitProspecting(admin(), submissao([achadoRico('A Teste', 'a-teste'), achadoRico('B Teste', 'b-teste'), achadoRico('C Teste', 'c-teste'), achadoRico('D Teste', 'd-teste'), achadoRico('Nome Diferente', 'bloqueada')], { quantidadeDesejada: 3 }));
  const esperado = computeBatchAccounting({ quantidadeDesejada: 3, candidatos: r.resultados.map((x) => ({ estadoOperacional: x.estadoLote })) });
  assert.deepEqual(r.contagens, esperado);
  assert.deepEqual([r.contagens.validos, r.contagens.principal, r.contagens.reserva, r.contagens.dnc, r.contagens.metaAtingida], [4, 3, 1, 1, true]);
  assert.equal(r.status, 'META_ATINGIDA');
  for (const proibido of ['score', 'ranking', 'temperatura', 'prioridade']) assert.equal(JSON.stringify(r).toLowerCase().includes(proibido), false, proibido);
});

test('[PDI-6] a segunda submissão é um NOVO lote com novos dossiês (a fila não duplica o item); o cliente nunca escolhe loteId nem dossierId (submissão, briefing e achado)', (t) => {
  const env = ambiente(t);
  const sub = submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]);
  const a = env.servico.submitProspecting(admin(), sub);
  const b = env.servico.submitProspecting(admin(), sub);
  assert.notEqual(a.loteId, b.loteId);
  assert.notEqual(a.dossierIds[0], b.dossierIds[0]);
  assert.equal(Object.keys(env.fila().items).length, 1, 'a fila não duplica');
  assert.equal(Object.keys(env.dossies()).length, 2);
  assert.deepEqual(Object.values(env.dossies()).map((d) => d.loteId).sort(), [a.loteId, b.loteId].sort());
  assert.equal(Object.keys(env.lotes()).length, 2);

  const limpo = ambiente(t);
  for (const chave of ['loteId', 'dossierId', 'dossierIds', 'dossiers', 'fatos', 'sinais']) {
    const antes = JSON.stringify([limpo.lotes(), limpo.dossies()]);
    assert.equal(erroDe(() => limpo.servico.submitProspecting(admin(), { ...sub, [chave]: 'lote:11111111-1111-4111-8111-111111111111' })).code, PROSPECTING_ERROR.INVALID_INPUT, chave);
    assert.equal(erroDe(() => limpo.servico.submitProspecting(admin(), { ...sub, briefing: { ...sub.briefing, [chave]: 'x' } })).code, PROSPECTING_ERROR.BRIEFING_INVALID, `briefing.${chave}`);
    assert.equal(erroDe(() => limpo.servico.submitProspecting(admin(), { ...sub, rawFindings: [{ ...sub.rawFindings[0], [chave]: 'x' }] })).code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID, `achado.${chave}`);
    assert.equal(JSON.stringify([limpo.lotes(), limpo.dossies()]), antes);
  }
  assert.equal(limpo.existe('dossier'), false);
  assert.equal(limpo.existe('batch'), false);
  assert.equal(limpo.existe('queue'), false);
});

test('[PDI-7] a ordem de gravação é DOSSIÊS -> FILA -> LOTE (o lote é o registro final); um candidato repetido na mesma execução tem UM só dossiê', (t) => {
  const env = ambiente(t);
  const r = env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste'), achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
  assert.deepEqual(env.ordem, ['dossie', 'dossie', 'fila', 'lote']);
  assert.equal(r.dossierIds.length, 2);
  assert.equal(r.repetidosNaSubmissao, 1);
  const repetido = r.resultados.filter((x) => x.motivo === 'REPETIDO_NA_SUBMISSAO');
  assert.equal(repetido.length, 1);
  assert.equal(repetido[0].dossierId, null);
  assert.equal(new Set(Object.values(env.dossies()).map((d) => d.prospectId)).size, 2);
});

test('[PDI-8] falha ao gravar o DOSSIÊ: erro estável só com identificadores; nada foi apagado; a fila e o lote não foram gravados; repetir é um novo lote', (t) => {
  let chamadas = 0;
  const base = createInMemoryDossiers();
  const dossierRepository = { ...base, save: (d) => { chamadas += 1; if (chamadas === 2) throw new Error('C:\\segredo\\caminho.json EACCES'); return base.save(d); } };
  const env = ambiente(t, { dossierRepository });
  const erro = erroDe(() => env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste')])));
  assert.equal(erro instanceof ProspectingError, true);
  assert.equal(erro.code, PROSPECTING_ERROR.PERSISTENCE);
  assert.deepEqual(erro.details, { loteId: 'lote:00000000-0000-4000-8000-000000000001', dossierIds: ['dossie:00000000-0000-4000-8000-000000000001'] });
  semVazamento(erro);
  assert.equal(env.existe('queue'), false);
  assert.equal(env.existe('batch'), false);
  assert.equal(base.list().length, 1, 'o dossiê já gravado NÃO foi apagado');
  chamadas = 5; // a próxima tentativa funciona: novo lote, novos ids, sem conflito nem duplicata
  const r = env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste')]));
  assert.equal(r.loteId, 'lote:00000000-0000-4000-8000-000000000002');
  assert.equal(base.list().length, 3, 'o órfão continua lá (sem lote), e os 2 novos pertencem ao novo lote');
  assert.equal(base.list().filter((d) => d.loteId === r.loteId).length, 2);
  assert.equal(Object.keys(env.lotes()).length, 1, 'só o lote da segunda execução existe: o órfão é detectável (dossiê sem lote)');
});

test('[PDI-9] falha ao gravar a FILA (depois dos dossiês): erro estável com loteId e dossierIds; os dossiês ficam (órfãos, sem lote); o lote não é gravado', (t) => {
  const approvalQueue = { ...queueDomain, saveQueueToDisk: () => { throw new Error('/etc/segredo EIO'); } };
  const env = ambiente(t, { approvalQueue });
  const erro = erroDe(() => env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')])));
  assert.equal(erro.code, PROSPECTING_ERROR.PERSISTENCE);
  assert.deepEqual(erro.details, { loteId: 'lote:00000000-0000-4000-8000-000000000001', dossierIds: ['dossie:00000000-0000-4000-8000-000000000001'] });
  semVazamento(erro);
  assert.equal(Object.keys(env.dossies()).length, 1);
  assert.equal(env.existe('batch'), false);
  assert.equal(env.existe('queue'), false);
});

test('[PDI-10] falha ao gravar o LOTE (depois de dossiês e fila): erro estável com loteId, dossierIds e prospectIds; dossiês e fila ficam; repetir é seguro (a fila não duplica) e um lote de conflito continua CONFLICT', (t) => {
  const falhar = { ...createJsonFileBatchRepository(path.join(os.tmpdir(), 'nao-usado.json')), add() { throw new Error('C:\\x\\y.json ENOSPC'); } };
  const env = ambiente(t, { batchRepository: falhar });
  const erro = erroDe(() => env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')])));
  assert.equal(erro.code, PROSPECTING_ERROR.PERSISTENCE);
  assert.equal(erro.details.loteId, 'lote:00000000-0000-4000-8000-000000000001');
  assert.equal(erro.details.dossierIds.length, 1);
  assert.equal(erro.details.prospectIds.length, 1);
  semVazamento(erro);
  assert.equal(Object.keys(env.dossies()).length, 1);
  assert.equal(Object.keys(env.fila().items).length, 1);

  const conflito = ambiente(t, { batchRepository: { ...falhar, add() { const e = new Error('x'); e.code = 'BATCH_CONFLICT'; throw e; } } });
  assert.equal(erroDe(() => conflito.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]))).code, PROSPECTING_ERROR.CONFLICT);
});

test('[PDI-11] nada é gravado quando a validação falha ANTES das gravações (briefing, achados, CRM ilegível, id de lote inválido): nem dossiê, nem fila, nem lote', (t) => {
  const env = ambiente(t);
  fs.writeFileSync(env.arquivos.crm, '{ corrompido');
  const nada = () => ['queue', 'batch', 'dossier'].every((a) => !env.existe(a));
  assert.equal(erroDe(() => env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]))).code, PROSPECTING_ERROR.CRM_INVALID);
  assert.equal(nada(), true);
  const outro = ambiente(t);
  assert.equal(erroDe(() => outro.servico.submitProspecting(admin(), { briefing: {}, rawFindings: [] })).code, PROSPECTING_ERROR.BRIEFING_INVALID);
  assert.equal(erroDe(() => outro.servico.submitProspecting(admin(), submissao([{ empresa: 'X', campos: 5 }]))).code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID);
  assert.equal(['queue', 'batch', 'dossier'].every((a) => !outro.existe(a)), true);
  const ruim = createProspectingService({ authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmService: { listRecords: () => [] }, batchRepository: createJsonFileBatchRepository(path.join(outro.dir, 'b.json')), dossierRepository: createJsonFileDossierRepository(path.join(outro.dir, 'd.json')), queuePath: outro.arquivos.queue, now: () => AGORA, newId: () => 'lote:invalido' });
  assert.equal(erroDe(() => ruim.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]))).code, PROSPECTING_ERROR.PERSISTENCE);
  assert.equal(['queue', 'b', 'd'].some((n) => fs.existsSync(path.join(outro.dir, n === 'queue' ? 'approval-queue.json' : `${n}.json`))), false);
});

test('[PDI-12] a autorização vem ANTES de qualquer acesso ao CRM, aos dossiês, à fila ou ao lote: o CLOSER é recusado sem tocar em nada; o ADMIN é autorizado', (t) => {
  const env = ambiente(t);
  const sub = submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]);
  const erro = erroDe(() => env.servico.submitProspecting(closer(), sub));
  assert.match(erro.message, /PROPOSE|autoriza|permiss/i);
  assert.equal(erro instanceof ProspectingError, false, 'a recusa de autorização passa intacta, nunca vira erro de candidato');
  assert.deepEqual(env.chamadasCrm, [], 'o CRM nem foi lido');
  assert.equal(['queue', 'batch', 'dossier'].every((a) => !env.existe(a)), true);
  assert.deepEqual(env.ordem, []);
  assert.equal(erroDe(() => env.servico.submitProspecting({ userId: 'forjado', role: 'ADMIN' }, sub)) !== null, true);
  assert.equal(env.servico.submitProspecting(admin(), sub).status, 'EM_ANDAMENTO');
  assert.deepEqual([...new Set(env.chamadasCrm)], ['listRecords']);
});

test('[PDI-13] integração física: lote, dossiês, fila e CRM coerentes entre si nos arquivos; sem dado sensível; os arquivos operacionais reais do projeto não são tocados', (t) => {
  const raiz = path.join(__dirname, '..', '..', 'data');
  const antes = ['prospecting-batches.json', 'prospecting-dossiers.json', 'approval-queue.json', 'crm.json'].map((n) => [n, fs.existsSync(path.join(raiz, n)) ? fs.statSync(path.join(raiz, n)).mtimeMs : null]);
  const env = ambiente(t, {
    crm: [
      { campos: { empresa: 'Bloqueada Teste', site: 'bloqueada.example.test' }, dnc: true },
      { campos: { empresa: 'Cliente Existente', site: 'existente.example.test' } },
    ],
  });
  const r = env.servico.submitProspecting(
    admin(),
    submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste'), achadoRico('Nome Diferente Um', 'bloqueada'), achadoRico('Nome Diferente Dois', 'existente'), achadoSimples('Clínica Fraca', 'fraca-teste', 'fraco')], { quantidadeDesejada: 2 })
  );
  const lotes = JSON.parse(fs.readFileSync(env.arquivos.batch, 'utf8'));
  const dossies = JSON.parse(fs.readFileSync(env.arquivos.dossier, 'utf8'));
  const fila = JSON.parse(fs.readFileSync(env.arquivos.queue, 'utf8'));
  const lote = lotes[r.loteId];
  assert.deepEqual(Object.keys(lotes), [r.loteId]);
  assert.deepEqual(Object.keys(dossies).sort(), [...lote.dossierIds].sort());
  assert.deepEqual(Object.keys(fila.items).sort(), [...lote.prospectIds].sort());
  for (const dossie of Object.values(dossies)) {
    assert.equal(dossie.loteId, r.loteId);
    assert.ok(lote.prospectIds.includes(dossie.prospectId), 'o dossiê aponta para um prospect que está no lote e na fila');
    assert.ok(fila.items[dossie.prospectId]);
    assert.ok(dossie.sinais.length > 0 && dossie.fatos.length > 0);
  }
  for (const entrada of lote.resultados) {
    assert.equal(entrada.naFila, Object.hasOwn(fila.items, entrada.prospectId));
    assert.equal(entrada.dossierId !== null, entrada.naFila);
    if (entrada.dossierId) assert.equal(dossies[entrada.dossierId].prospectId, entrada.prospectId);
  }
  assert.deepEqual([lote.contagens.encontrados, lote.contagens.validos, lote.contagens.dnc, lote.contagens.duplicados, lote.contagens.dadosInsuficientes, lote.contagens.principal, lote.contagens.reserva, lote.contagens.metaAtingida], [5, 2, 1, 1, 1, 2, 0, true]);
  const tudo = JSON.stringify([lotes, dossies, fila]);
  for (const proibido of ['authUserId', 'access_token', 'C:\\', '/tmp', 'stack', 'permissions']) assert.equal(tudo.includes(proibido), false, proibido);
  const depois = ['prospecting-batches.json', 'prospecting-dossiers.json', 'approval-queue.json', 'crm.json'].map((n) => [n, fs.existsSync(path.join(raiz, n)) ? fs.statSync(path.join(raiz, n)).mtimeMs : null]);
  assert.deepEqual(depois, antes, 'os arquivos operacionais reais não foram tocados');
  // limpeza: o diretório temporário é removido ao fim (t.after) — nada dos dados de teste fica em data/
});

function createInMemoryDossiers() {
  const { createInMemoryDossierRepository } = require('../../src/research-prospector/dossierRepository');
  return createInMemoryDossierRepository();
}
function semVazamento(erro) {
  const texto = JSON.stringify({ message: erro.message, details: erro.details, code: erro.code, name: erro.name });
  for (const proibido of ['segredo', 'EACCES', 'EIO', 'ENOSPC', 'C:\\', '/etc', '.json', 'at ']) assert.equal(texto.includes(proibido), false, proibido);
  assert.equal(Object.keys(erro).sort().every((k) => ['name', 'code', 'details'].includes(k)), true);
}

test('[PDI-14] cada dossiê traz os fatos do SEU achado (nunca de outro); um id de dossiê inválido é recusado antes de gravar; elegível sem fatos derivados não ganha dossiê', (t) => {
  const env = ambiente(t);
  const r = env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste')]));
  for (const dossie of Object.values(env.dossies())) {
    const empresa = env.fila().items[dossie.prospectId].empresa;
    const slug = empresa.includes('Alfa') ? 'alfa-teste' : 'beta-teste';
    assert.equal(dossie.fatos.find((f) => f.campo === 'site.url').valor, `https://${slug}.example.test`, empresa);
  }
  assert.equal(r.dossierIds.length, 2);

  const ruim = ambiente(t);
  const servico = createProspectingService({ authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmService: { listRecords: () => [] }, batchRepository: createJsonFileBatchRepository(ruim.arquivos.batch), dossierRepository: createJsonFileDossierRepository(ruim.arquivos.dossier), queuePath: ruim.arquivos.queue, now: () => AGORA, newDossierId: () => 'dossie:invalido' });
  assert.equal(erroDe(() => servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]))).code, PROSPECTING_ERROR.CANDIDATE_INVALID);
  assert.equal(['queue', 'batch', 'dossier'].every((a) => !ruim.existe(a)), true);

  const semFatos = ambiente(t);
  const achado = { empresa: 'Só Telefone Teste', tipo: 'clínica', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos: { telefone: [{ valor: '(24) 98765-2222', fonte: 'F', tipoFonte: 'OFICIAL' }] }, fontes: [] };
  const s = semFatos.servico.submitProspecting(admin(), submissao([achado]));
  assert.equal(s.resultados[0].naFila, true);
  assert.equal(s.resultados[0].dossierId, null);
  assert.deepEqual(s.dossierIds, []);
  assert.equal(semFatos.existe('dossier'), false);
});

test('[PDI-15] a criação exige o repositório de dossiês; a fábrica de arquivo grava no dossierPath escolhido por quem compõe e recusa um dossierPath inválido', (t) => {
  const env = ambiente(t);
  const base = { authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmService: { listRecords: () => [] }, batchRepository: createJsonFileBatchRepository(env.arquivos.batch), queuePath: env.arquivos.queue };
  assert.throws(() => createProspectingService(base), /repositório de dossiês/);
  assert.throws(() => createProspectingService({ ...base, dossierRepository: {} }), /repositório de dossiês/);
  assert.throws(() => createProspectingService({ ...base, dossierRepository: createJsonFileDossierRepository(env.arquivos.dossier), newDossierId: 5 }), /newDossierId/);
  const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');
  const comum = { authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, queuePath: env.arquivos.queue, crmPath: env.arquivos.crm, batchPath: env.arquivos.batch };
  for (const ruimPath of ['', '  ', 5, {}]) assert.throws(() => createFileBackedProspectingService({ ...comum, dossierPath: ruimPath }), /dossierPath/);
  const servico = createFileBackedProspectingService({ ...comum, dossierPath: env.arquivos.dossier });
  const r = servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
  assert.deepEqual(Object.keys(env.dossies()), r.dossierIds);
});
