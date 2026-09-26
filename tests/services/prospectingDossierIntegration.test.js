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

async function ambiente(t, opcoes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const arquivos = { queue: path.join(dir, 'approval-queue.json'), crm: path.join(dir, 'crm.json'), batch: path.join(dir, 'prospecting-batches.json'), dossier: path.join(dir, 'prospecting-dossiers.json') };
  const repositorioCrm = createJsonFileCrmRepository(arquivos.crm);
  for (const { campos, dnc } of opcoes.crm || []) {
    const { record } = await crm.createRecord(repositorioCrm, campos, OPERADOR);
    if (dnc) await crm.markDoNotContact(repositorioCrm, record.id, OPERADOR);
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
const erroDe = async (fn) => {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------------------------
test('[PDI-1] uma submissão válida cria o lote e o dossiê; o dossiê carrega o loteId e o prospectId do candidato; a associação é só por identificadores', async (t) => {
  const env = await ambiente(t);
  const r = await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
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

test('[PDI-2] os sinais são derivados pelo dossiê a partir dos fatos traduzidos do achado (fonte https + data => DADO; sem isso => NAO_VERIFICADO); nada de Instagram-atividade, CTA ou anúncios', async (t) => {
  const env = await ambiente(t);
  const r = await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
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
  const env2 = await ambiente(t);
  const r2 = await env2.servico.submitProspecting(admin(), submissao([achadoSimples('Clínica Beta Teste', 'beta-teste')]));
  const d2 = env2.dossies()[r2.dossierIds[0]];
  const porCampo = Object.fromEntries(d2.fatos.map((f) => [f.campo, f]));
  assert.deepEqual([porCampo['site.url'].status, porCampo['site.url'].valor, porCampo['site.url'].fonte], ['NAO_VERIFICADO', null, null]);
  assert.equal(porCampo['instagram.url'].status, 'NAO_VERIFICADO');
  assert.equal(d2.sinais.every((s) => s.status === 'NAO_VERIFICADO' && s.valor === null), true);
  assert.equal('telefone' in porCampo, false);
});

test('[PDI-3] a fila recebe SÓ elegíveis; DNC, duplicado e dados insuficientes não entram na fila NEM ganham dossiê (ficam só no relatório do lote); possível duplicidade mantém o comportamento existente (entra, com dossiê)', async (t) => {
  const env = await ambiente(t, {
    crm: [
      { campos: { empresa: 'Bloqueada Teste', site: 'bloqueada.example.test', telefone: '24 90000-1111' }, dnc: true },
      { campos: { empresa: 'Cliente Existente', site: 'existente.example.test' } },
      { campos: { empresa: 'Clínica Mesmo Nome', cidade: 'Petrópolis' } },
    ],
  });
  const r = await env.servico.submitProspecting(
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

test('[PDI-4] a aprovação e a promoção NÃO ocorrem: os itens ficam AGUARDANDO_REVISAO, sem reviewedBy nem decisão, e o CRM não recebe nenhuma escrita (só listRecords é usado)', async (t) => {
  const env = await ambiente(t, { crm: [{ campos: { empresa: 'Cliente Existente', site: 'existente.example.test' } }] });
  const crmAntes = env.crmTexto();
  await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste')]));
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

test('[PDI-5] as contagens usam o batchAccounting existente (o lote traz exatamente o que a função pura calcula), e só os estados do modelo contam como válidos', async (t) => {
  const env = await ambiente(t, { crm: [{ campos: { empresa: 'Bloqueada Teste', site: 'bloqueada.example.test' }, dnc: true }] });
  const r = await env.servico.submitProspecting(admin(), submissao([achadoRico('A Teste', 'a-teste'), achadoRico('B Teste', 'b-teste'), achadoRico('C Teste', 'c-teste'), achadoRico('D Teste', 'd-teste'), achadoRico('Nome Diferente', 'bloqueada')], { quantidadeDesejada: 3 }));
  const esperado = computeBatchAccounting({ quantidadeDesejada: 3, candidatos: r.resultados.map((x) => ({ estadoOperacional: x.estadoLote })) });
  assert.deepEqual(r.contagens, esperado);
  assert.deepEqual([r.contagens.validos, r.contagens.principal, r.contagens.reserva, r.contagens.dnc, r.contagens.metaAtingida], [4, 3, 1, 1, true]);
  assert.equal(r.status, 'META_ATINGIDA');
  for (const proibido of ['score', 'ranking', 'temperatura', 'prioridade']) assert.equal(JSON.stringify(r).toLowerCase().includes(proibido), false, proibido);
});

test('[PDI-6] a segunda submissão é um NOVO lote com novos dossiês (a fila não duplica o item); o cliente nunca escolhe loteId nem dossierId (submissão, briefing e achado)', async (t) => {
  const env = await ambiente(t);
  const sub = submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]);
  const a = await env.servico.submitProspecting(admin(), sub);
  const b = await env.servico.submitProspecting(admin(), sub);
  assert.notEqual(a.loteId, b.loteId);
  assert.notEqual(a.dossierIds[0], b.dossierIds[0]);
  assert.equal(Object.keys(env.fila().items).length, 1, 'a fila não duplica');
  assert.equal(Object.keys(env.dossies()).length, 2);
  assert.deepEqual(Object.values(env.dossies()).map((d) => d.loteId).sort(), [a.loteId, b.loteId].sort());
  assert.equal(Object.keys(env.lotes()).length, 2);

  const limpo = await ambiente(t);
  for (const chave of ['loteId', 'dossierId', 'dossierIds', 'dossiers', 'fatos', 'sinais']) {
    const antes = JSON.stringify([limpo.lotes(), limpo.dossies()]);
    assert.equal((await erroDe(async () => await limpo.servico.submitProspecting(admin(), { ...sub, [chave]: 'lote:11111111-1111-4111-8111-111111111111' }))).code, PROSPECTING_ERROR.INVALID_INPUT, chave);
    assert.equal((await erroDe(async () => await limpo.servico.submitProspecting(admin(), { ...sub, briefing: { ...sub.briefing, [chave]: 'x' } }))).code, PROSPECTING_ERROR.BRIEFING_INVALID, `briefing.${chave}`);
    assert.equal((await erroDe(async () => await limpo.servico.submitProspecting(admin(), { ...sub, rawFindings: [{ ...sub.rawFindings[0], [chave]: 'x' }] }))).code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID, `achado.${chave}`);
    assert.equal(JSON.stringify([limpo.lotes(), limpo.dossies()]), antes);
  }
  assert.equal(limpo.existe('dossier'), false);
  assert.equal(limpo.existe('batch'), false);
  assert.equal(limpo.existe('queue'), false);
});

test('[PDI-7] a ordem de gravação é DOSSIÊS -> FILA -> LOTE (o lote é o registro final); um candidato repetido na mesma execução tem UM só dossiê', async (t) => {
  const env = await ambiente(t);
  const r = await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste'), achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
  assert.deepEqual(env.ordem, ['dossie', 'dossie', 'fila', 'lote']);
  assert.equal(r.dossierIds.length, 2);
  assert.equal(r.repetidosNaSubmissao, 1);
  const repetido = r.resultados.filter((x) => x.motivo === 'REPETIDO_NA_SUBMISSAO');
  assert.equal(repetido.length, 1);
  assert.equal(repetido[0].dossierId, null);
  assert.equal(new Set(Object.values(env.dossies()).map((d) => d.prospectId)).size, 2);
});

test('[PDI-8] falha ao gravar o DOSSIÊ: erro estável só com identificadores; nada foi apagado; a fila e o lote não foram gravados; repetir é um novo lote', async (t) => {
  let chamadas = 0;
  const base = createInMemoryDossiers();
  const dossierRepository = { ...base, save: (d) => { chamadas += 1; if (chamadas === 2) throw new Error('C:\\segredo\\caminho.json EACCES'); return base.save(d); } };
  const env = await ambiente(t, { dossierRepository });
  const erro = await erroDe(async () => await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste')])));
  assert.equal(erro instanceof ProspectingError, true);
  assert.equal(erro.code, PROSPECTING_ERROR.PERSISTENCE);
  assert.deepEqual(erro.details, { loteId: 'lote:00000000-0000-4000-8000-000000000001', dossierIds: ['dossie:00000000-0000-4000-8000-000000000001'] });
  semVazamento(erro);
  assert.equal(env.existe('queue'), false);
  assert.equal(env.existe('batch'), false);
  assert.equal(base.list().length, 1, 'o dossiê já gravado NÃO foi apagado');
  chamadas = 5; // a próxima tentativa funciona: novo lote, novos ids, sem conflito nem duplicata
  const r = await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste')]));
  assert.equal(r.loteId, 'lote:00000000-0000-4000-8000-000000000002');
  assert.equal(base.list().length, 3, 'o órfão continua lá (sem lote), e os 2 novos pertencem ao novo lote');
  assert.equal(base.list().filter((d) => d.loteId === r.loteId).length, 2);
  assert.equal(Object.keys(env.lotes()).length, 1, 'só o lote da segunda execução existe: o órfão é detectável (dossiê sem lote)');
});

test('[PDI-9] falha ao gravar a FILA (depois dos dossiês): erro estável com loteId e dossierIds; os dossiês ficam (órfãos, sem lote); o lote não é gravado', async (t) => {
  const approvalQueue = { ...queueDomain, saveQueueToDisk: () => { throw new Error('/etc/segredo EIO'); } };
  const env = await ambiente(t, { approvalQueue });
  const erro = await erroDe(async () => await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')])));
  assert.equal(erro.code, PROSPECTING_ERROR.PERSISTENCE);
  assert.deepEqual(erro.details, { loteId: 'lote:00000000-0000-4000-8000-000000000001', dossierIds: ['dossie:00000000-0000-4000-8000-000000000001'] });
  semVazamento(erro);
  assert.equal(Object.keys(env.dossies()).length, 1);
  assert.equal(env.existe('batch'), false);
  assert.equal(env.existe('queue'), false);
});

test('[PDI-10] falha ao gravar o LOTE (depois de dossiês e fila): erro estável com loteId, dossierIds e prospectIds; dossiês e fila ficam; repetir é seguro (a fila não duplica) e um lote de conflito continua CONFLICT', async (t) => {
  const falhar = { ...createJsonFileBatchRepository(path.join(os.tmpdir(), 'nao-usado.json')), add() { throw new Error('C:\\x\\y.json ENOSPC'); } };
  const env = await ambiente(t, { batchRepository: falhar });
  const erro = await erroDe(async () => await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')])));
  assert.equal(erro.code, PROSPECTING_ERROR.PERSISTENCE);
  assert.equal(erro.details.loteId, 'lote:00000000-0000-4000-8000-000000000001');
  assert.equal(erro.details.dossierIds.length, 1);
  assert.equal(erro.details.prospectIds.length, 1);
  semVazamento(erro);
  assert.equal(Object.keys(env.dossies()).length, 1);
  assert.equal(Object.keys(env.fila().items).length, 1);

  const conflito = await ambiente(t, { batchRepository: { ...falhar, add() { const e = new Error('x'); e.code = 'BATCH_CONFLICT'; throw e; } } });
  assert.equal((await erroDe(async () => await conflito.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')])))).code, PROSPECTING_ERROR.CONFLICT);
});

test('[PDI-11] nada é gravado quando a validação falha ANTES das gravações (briefing, achados, CRM ilegível, id de lote inválido): nem dossiê, nem fila, nem lote', async (t) => {
  const env = await ambiente(t);
  fs.writeFileSync(env.arquivos.crm, '{ corrompido');
  const nada = () => ['queue', 'batch', 'dossier'].every((a) => !env.existe(a));
  assert.equal((await erroDe(async () => await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')])))).code, PROSPECTING_ERROR.CRM_INVALID);
  assert.equal(nada(), true);
  const outro = await ambiente(t);
  assert.equal((await erroDe(async () => await outro.servico.submitProspecting(admin(), { briefing: {}, rawFindings: [] }))).code, PROSPECTING_ERROR.BRIEFING_INVALID);
  assert.equal((await erroDe(async () => await outro.servico.submitProspecting(admin(), submissao([{ empresa: 'X', campos: 5 }])))).code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID);
  assert.equal(['queue', 'batch', 'dossier'].every((a) => !outro.existe(a)), true);
  const ruim = createProspectingService({ authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmService: { listRecords: () => [] }, batchRepository: createJsonFileBatchRepository(path.join(outro.dir, 'b.json')), dossierRepository: createJsonFileDossierRepository(path.join(outro.dir, 'd.json')), queuePath: outro.arquivos.queue, now: () => AGORA, newId: () => 'lote:invalido' });
  assert.equal((await erroDe(async () => await ruim.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')])))).code, PROSPECTING_ERROR.PERSISTENCE);
  assert.equal(['queue', 'b', 'd'].some((n) => fs.existsSync(path.join(outro.dir, n === 'queue' ? 'approval-queue.json' : `${n}.json`))), false);
});

test('[PDI-12] a autorização vem ANTES de qualquer acesso ao CRM, aos dossiês, à fila ou ao lote: o CLOSER é recusado sem tocar em nada; o ADMIN é autorizado', async (t) => {
  const env = await ambiente(t);
  const sub = submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]);
  const erro = await erroDe(async () => await env.servico.submitProspecting(closer(), sub));
  assert.match(erro.message, /PROPOSE|autoriza|permiss/i);
  assert.equal(erro instanceof ProspectingError, false, 'a recusa de autorização passa intacta, nunca vira erro de candidato');
  assert.deepEqual(env.chamadasCrm, [], 'o CRM nem foi lido');
  assert.equal(['queue', 'batch', 'dossier'].every((a) => !env.existe(a)), true);
  assert.deepEqual(env.ordem, []);
  assert.equal(await erroDe(async () => await env.servico.submitProspecting({ userId: 'forjado', role: 'ADMIN' }, sub)) !== null, true);
  assert.equal((await env.servico.submitProspecting(admin(), sub)).status, 'EM_ANDAMENTO');
  assert.deepEqual([...new Set(env.chamadasCrm)], ['listRecords']);
});

test('[PDI-13] integração física: lote, dossiês, fila e CRM coerentes entre si nos arquivos; sem dado sensível; os arquivos operacionais reais do projeto não são tocados', async (t) => {
  const raiz = path.join(__dirname, '..', '..', 'data');
  const antes = ['prospecting-batches.json', 'prospecting-dossiers.json', 'approval-queue.json', 'crm.json'].map((n) => [n, fs.existsSync(path.join(raiz, n)) ? fs.statSync(path.join(raiz, n)).mtimeMs : null]);
  const env = await ambiente(t, {
    crm: [
      { campos: { empresa: 'Bloqueada Teste', site: 'bloqueada.example.test' }, dnc: true },
      { campos: { empresa: 'Cliente Existente', site: 'existente.example.test' } },
    ],
  });
  const r = await env.servico.submitProspecting(
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

test('[PDI-14] cada dossiê traz os fatos do SEU achado (nunca de outro); um id de dossiê inválido é recusado antes de gravar; elegível sem fatos derivados não ganha dossiê', async (t) => {
  const env = await ambiente(t);
  const r = await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste'), achadoRico('Clínica Beta Teste', 'beta-teste')]));
  for (const dossie of Object.values(env.dossies())) {
    const empresa = env.fila().items[dossie.prospectId].empresa;
    const slug = empresa.includes('Alfa') ? 'alfa-teste' : 'beta-teste';
    assert.equal(dossie.fatos.find((f) => f.campo === 'site.url').valor, `https://${slug}.example.test`, empresa);
  }
  assert.equal(r.dossierIds.length, 2);

  const ruim = await ambiente(t);
  const servico = createProspectingService({ authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmService: { listRecords: () => [] }, batchRepository: createJsonFileBatchRepository(ruim.arquivos.batch), dossierRepository: createJsonFileDossierRepository(ruim.arquivos.dossier), queuePath: ruim.arquivos.queue, now: () => AGORA, newDossierId: () => 'dossie:invalido' });
  assert.equal((await erroDe(async () => await servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')])))).code, PROSPECTING_ERROR.CANDIDATE_INVALID);
  assert.equal(['queue', 'batch', 'dossier'].every((a) => !ruim.existe(a)), true);

  const semFatos = await ambiente(t);
  const achado = { empresa: 'Só Telefone Teste', tipo: 'clínica', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos: { telefone: [{ valor: '(24) 98765-2222', fonte: 'F', tipoFonte: 'OFICIAL' }] }, fontes: [] };
  const s = await semFatos.servico.submitProspecting(admin(), submissao([achado]));
  assert.equal(s.resultados[0].naFila, true);
  assert.equal(s.resultados[0].dossierId, null);
  assert.deepEqual(s.dossierIds, []);
  assert.equal(semFatos.existe('dossier'), false);
});

test('[PDI-15] a criação exige o repositório de dossiês; a fábrica de arquivo grava no dossierPath escolhido por quem compõe e recusa um dossierPath inválido', async (t) => {
  const env = await ambiente(t);
  const base = { authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, crmService: { listRecords: () => [] }, batchRepository: createJsonFileBatchRepository(env.arquivos.batch), queuePath: env.arquivos.queue };
  assert.throws(() => createProspectingService(base), /repositório de dossiês/);
  assert.throws(() => createProspectingService({ ...base, dossierRepository: {} }), /repositório de dossiês/);
  assert.throws(() => createProspectingService({ ...base, dossierRepository: createJsonFileDossierRepository(env.arquivos.dossier), newDossierId: 5 }), /newDossierId/);
  const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');
  const comum = { authorizeProposer: authorizeProposerForLeadApproval, authorizeOperation: authorizeCrmOperation, queuePath: env.arquivos.queue, crmPath: env.arquivos.crm, batchPath: env.arquivos.batch };
  for (const ruimPath of ['', '  ', 5, {}]) assert.throws(() => createFileBackedProspectingService({ ...comum, dossierPath: ruimPath }), /dossierPath/);
  const servico = createFileBackedProspectingService({ ...comum, dossierPath: env.arquivos.dossier });
  const r = await servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
  assert.deepEqual(Object.keys(env.dossies()), r.dossierIds);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// rawFinding V2 (decisão 0020): o bloco `dossie` dentro do achado
// ---------------------------------------------------------------------------------------------------------------------------------
const fonteObs = (extras = {}) => ({ url: 'https://instagram.example.test/perfil', tipo: 'OFICIAL', observadoEm: DATA, ...extras });
const fatoObs = (campo, valor, extras = {}) => ({ campo, valor, status: 'DADO', fonte: fonteObs(), observadoEm: DATA, ...extras });
const analiseObs = (extras = {}) => ({ tipo: 'ATIVIDADE_SOCIAL', texto: 'Última postagem observada há 4 dias, com chamada para agendar.', baseadoEm: [{ sinal: 'INSTAGRAM_ATIVIDADE' }], status: 'ANALISE', ...extras });
const blocoV2 = () => ({
  fatos: [fatoObs('instagram.postagensObservadas', ['2026-09-01', '2026-09-10', '2026-09-20']), fatoObs('instagram.cta', 'Agende pelo link da bio'), fatoObs('site.formularioContato', true, { fonte: fonteObs({ url: 'https://alfa-teste.example.test/contato' }) }), { campo: 'anuncios.meta', valor: null, status: 'NAO_VERIFICADO', observadoEm: DATA, motivo: 'BLOQUEADO' }],
  analises: [analiseObs(), analiseObs({ status: 'HIPOTESE', texto: 'Pode haver espaço para melhorar o agendamento (não confirmado).', baseadoEm: [{ fato: 'instagram.cta' }] })],
});

test('[PDI-16] o bloco `dossie` chega ao dossiê: observações do Instagram, CTA, formulário e anúncios viram fatos e sinais; as análises ficam separadas; nada disso entra na fila, no lote nem no discovery', async (t) => {
  const env = await ambiente(t);
  const com = achadoRico('Clínica Alfa Teste', 'alfa-teste', { dossie: blocoV2() });
  const r = await env.servico.submitProspecting(admin(), submissao([com]));
  const dossie = env.dossies()[r.dossierIds[0]];
  const sinais = Object.fromEntries(dossie.sinais.map((s) => [s.tipo, s]));
  assert.equal(sinais.INSTAGRAM_ATIVIDADE.status, 'DADO');
  assert.deepEqual([sinais.INSTAGRAM_ATIVIDADE.valor.diasDesdeUltimaPostagem, sinais.INSTAGRAM_ATIVIDADE.valor.postouNosUltimos15Dias, sinais.INSTAGRAM_ATIVIDADE.valor.cta], [4, true, 'Agende pelo link da bio']);
  assert.equal(sinais.INSTAGRAM_ATIVIDADE.valor.url, 'https://instagram.example.test/alfa-teste', 'a URL vem do fato de identidade derivado de campos, não do bloco');
  assert.deepEqual([sinais.FORMULARIO_CONTATO.status, sinais.ANUNCIO_META.status, sinais.ANUNCIO_META.valor], ['DADO', 'NAO_VERIFICADO', 'NAO_VERIFICAVEL']);
  assert.equal(dossie.fatos.find((f) => f.campo === 'anuncios.meta').motivo, 'BLOQUEADO');
  assert.deepEqual(dossie.analises.map((a) => [a.analiseId, a.status]), [['analise:001', 'ANALISE'], ['analise:002', 'HIPOTESE']]);
  assert.equal(dossie.fatos.some((f) => f.status === 'HIPOTESE' || f.status === 'ANALISE'), false, 'análise/hipótese nunca é fato');
  assert.equal(dossie.dataDaPesquisa, DATA);

  // o que o bloco NÃO alcança: fila, lote (relatório) e decisão do discovery
  const tudo = JSON.stringify([env.fila(), env.lotes()]);
  for (const proibido of ['Última postagem observada', 'Pode haver espaço', 'Agende pelo link', 'analise:', 'instagram.cta', 'problemaIdentificado', 'temperatura', 'score', 'urgência']) assert.equal(tudo.includes(proibido), false, proibido);
  const sem = await ambiente(t);
  const rSem = await sem.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste')]));
  assert.equal(r.resultados[0].estadoOperacional, rSem.resultados[0].estadoOperacional, 'o bloco não muda a decisão do discovery');
  assert.deepEqual(r.contagens, rSem.contagens, 'nem a contabilidade');
  assert.equal(JSON.stringify(env.fila().items[r.prospectIds[0]].discoverySnapshot), JSON.stringify(sem.fila().items[rSem.prospectIds[0]].discoverySnapshot));
});

test('[PDI-17] bloco inválido: a submissão INTEIRA é recusada (RAW_FINDINGS_INVALID, caminho e código, sem o conteúdo) antes de tocar em CRM, dossiês, fila ou lote — mesmo um achado bom junto', async (t) => {
  const env = await ambiente(t);
  const ruins = [
    [{ fatos: [fatoObs('instagram.url', 'https://instagram.example.test/x')] }, 'rawFindings[1].dossie.fatos[0].campo', 'CAMPO_DE_IDENTIDADE'],
    [{ fatos: [fatoObs('instagram.cta', 'Agende', { fonte: fonteObs({ url: 'http://x.example.test' }) })] }, 'rawFindings[1].dossie.fatos[0].fonte.url', 'PROTOCOLO_PROIBIDO'],
    [{ fatos: [fatoObs('instagram.cta', 'Agende')], analises: [analiseObs({ baseadoEm: [{ fato: 'instagram.cta' }], texto: 'Resultado garantido SEGREDO-X' })] }, 'rawFindings[1].dossie.analises[0].texto', 'TEXTO_PROIBIDO'],
    [{ fatos: [], analises: [analiseObs({ baseadoEm: [] })] }, 'rawFindings[1].dossie.analises[0].baseadoEm', 'ANALISE_SEM_BASE'],
    [{ sinais: [{ tipo: 'SCORE_ALTO' }] }, 'rawFindings[1].dossie.sinais', 'CAMPO_DESCONHECIDO'],
  ];
  for (const [bloco, caminho, codigo] of ruins) {
    const erro = await erroDe(async () => await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Boa', 'boa-teste'), achadoRico('Clínica Ruim', 'ruim-teste', { dossie: bloco })])));
    assert.equal(erro.code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID);
    assert.deepEqual(erro.details.errors.map((e) => [e.path, e.code]), [[caminho, codigo]]);
    assert.equal(JSON.stringify(erro.details).includes('SEGREDO'), false);
  }
  assert.deepEqual(env.chamadasCrm, [], 'nada foi lido no CRM');
  assert.equal(['queue', 'batch', 'dossier'].every((a) => !env.existe(a)), true);
});

test('[PDI-18] conflito de identidade é PRESERVADO como conflito (sinal NAO_VERIFICADO com as duas evidências), nunca resolvido em silêncio; o bloco não substitui a identidade', async (t) => {
  const env = await ambiente(t);
  const a = achadoRico('Clínica Alfa Teste', 'alfa-teste');
  a.campos.facebook = [ev('https://facebook.example.test/alfa-um', 'f1'), ev('https://facebook.example.test/alfa-dois', 'f2')];
  const r = await env.servico.submitProspecting(admin(), submissao([a]));
  const dossie = env.dossies()[r.dossierIds[0]];
  const sinal = dossie.sinais.find((s) => s.tipo === 'FACEBOOK_EXISTENTE');
  assert.deepEqual([sinal.status, sinal.valor, sinal.evidencias], ['NAO_VERIFICADO', null, ['fato:facebook.url', 'fato:facebook.url#2']]);
  assert.equal(dossie.fatos.filter((f) => f.campo === 'facebook.url').length, 2, 'os dois valores ficam, cada um com a sua fonte');
  const erro = await erroDe(async () => (await ambiente(t)).servico.submitProspecting(admin(), submissao([achadoRico('Clínica Alfa Teste', 'alfa-teste', { dossie: { fatos: [fatoObs('site.url', 'https://outro.example.test')] } })])));
  assert.equal(erro.code, PROSPECTING_ERROR.RAW_FINDINGS_INVALID);
});

test('[PDI-19] o bloco de um candidato bloqueado (DNC) é validado mas NÃO é guardado: sem dossiê para quem não entra na fila', async (t) => {
  const env = await ambiente(t, { crm: [{ campos: { empresa: 'Bloqueada Teste', site: 'bloqueada.example.test' }, dnc: true }] });
  const r = await env.servico.submitProspecting(admin(), submissao([achadoRico('Nome Diferente Um', 'bloqueada', { dossie: blocoV2() })]));
  assert.equal(r.resultados[0].estadoOperacional, 'DNC');
  assert.deepEqual([r.resultados[0].dossierId, r.dossierIds], [null, []]);
  assert.equal(env.existe('dossier'), false);
  assert.equal(JSON.stringify(env.lotes()).includes('Última postagem'), false);
});

test('[PDI-20] limite de submissão: 150 achados aceitos, 151 recusados por inteiro (LOTE_EXCESSIVO) sem gravar nada; cada dossiê V2 de uma submissão cheia é gravado sem truncar', async (t) => {
  const env = await ambiente(t);
  const achados = (n) => Array.from({ length: n }, (_, i) => achadoRico(`Clínica Número ${i} Teste`, `numero-${i}-teste`, { dossie: blocoV2() }));
  const r = await env.servico.submitProspecting(admin(), submissao(achados(150), { quantidadeDesejada: 100 }));
  assert.equal(r.contagens.encontrados, 150);
  assert.deepEqual([r.contagens.principal, r.contagens.reserva, r.contagens.metaAtingida], [100, 50, true]);
  assert.equal(r.dossierIds.length, 150);
  assert.equal(Object.values(env.dossies()).every((d) => d.analises.length === 2 && d.fatos.length === 7), true);
  const cheio = await ambiente(t);
  const erro = await erroDe(async () => await cheio.servico.submitProspecting(admin(), submissao(achados(151), { quantidadeDesejada: 100 })));
  assert.deepEqual(erro.details.errors.map((e) => e.code), ['LOTE_EXCESSIVO']);
  assert.equal(['queue', 'batch', 'dossier'].every((a) => !cheio.existe(a)), true);
});

test('[PDI-21] cada achado leva o SEU bloco: o dossiê de um candidato sem bloco não recebe as observações do outro', async (t) => {
  const env = await ambiente(t);
  const r = await env.servico.submitProspecting(admin(), submissao([achadoRico('Clínica Sem Bloco', 'sem-bloco-teste'), achadoRico('Clínica Com Bloco', 'com-bloco-teste', { dossie: blocoV2() })]));
  const porEmpresa = Object.fromEntries(r.resultados.map((x) => [x.empresa, env.dossies()[x.dossierId]]));
  assert.equal(porEmpresa['Clínica Sem Bloco'].fatos.some((f) => f.campo === 'instagram.cta'), false);
  assert.deepEqual(porEmpresa['Clínica Sem Bloco'].analises, []);
  assert.equal(porEmpresa['Clínica Com Bloco'].fatos.some((f) => f.campo === 'instagram.cta'), true);
  assert.equal(porEmpresa['Clínica Com Bloco'].analises.length, 2);
});
