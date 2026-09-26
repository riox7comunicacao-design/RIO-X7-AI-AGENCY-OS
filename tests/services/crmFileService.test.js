// Testes de src/services/crmFileService.js (decisão 0015): o CRM Service sobre o adapter de ARQUIVO local — a peça que
// deixa a raiz de composição ligar o CRM passando só um CAMINHO, sem importar src/crm (regra R12).
//
// Ela não decide nada: o autorizador é injetado e só o CRM Service o chama; as regras são do domínio; o arquivo é o adapter
// de desenvolvimento. Estes testes provam isso, e que a fábrica falha fechada quando lhe falta algo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { authorizeCrmOperation, PERMISSION, defineUser, ROLE, USER_STATUS } = require('../../src/auth');
const { createFileBackedCrmService } = require('../../src/services/crmFileService');
const { createAuthorizationContext } = require('../helpers/authFixtures');
const { analyzeSource } = require('../helpers/staticImports');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OPERACOES = ['createRecord', 'getHistory', 'getRecord', 'listRecords', 'markDoNotContact', 'moveStatus', 'updateRecord'];

function novoDiretorio(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-file-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const contexto = (extras = {}) =>
  createAuthorizationContext(defineUser({ userId: 'u1', authUserId: 'a1', name: 'Um', email: 'um-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE, ...extras }));

const EMPRESA = { empresa: 'Clínica Teste', site: 'clinica.example.test', cidade: 'Petrópolis' };

test('[CRM-FILE-1] sem um caminho de arquivo (ausente, vazio, em branco ou de outro tipo) a fábrica falha fechada — não existe um padrão escondido', () => {
  const exigeCaminho = /^Error: createFileBackedCrmService exige \{ filePath \}/;
  for (const filePath of [undefined, null, '', '   ', 42, {}, ['crm.json']]) {
    assert.throws(() => createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath }), exigeCaminho, String(filePath));
  }
  assert.throws(() => createFileBackedCrmService(), exigeCaminho);
  assert.throws(() => createFileBackedCrmService({}), exigeCaminho);
});

test('[CRM-FILE-2] sem autorizador válido a fábrica falha fechada (quem valida é o próprio CRM Service): ausente, não-função e função async', (t) => {
  const filePath = path.join(novoDiretorio(t), 'crm.json');
  for (const authorizeOperation of [undefined, null, 'autorizar', {}]) {
    assert.throws(() => createFileBackedCrmService({ authorizeOperation, filePath }), /authorizeOperation/, String(authorizeOperation));
  }
  assert.throws(() => createFileBackedCrmService({ authorizeOperation: async () => ({}), filePath }), /síncrono/);
});

test('[CRM-FILE-3] devolve o Service completo e congelado — as 7 operações, e nada mais (nem o repositório)', (t) => {
  const service = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: path.join(novoDiretorio(t), 'crm.json') });
  assert.deepEqual(Object.keys(service).sort(), OPERACOES);
  assert.equal(Object.isFrozen(service), true);
  for (const operacao of OPERACOES) assert.equal(typeof service[operacao], 'function');
});

test('[CRM-FILE-4] compor NÃO toca no disco: o arquivo (e o diretório dele) só passam a existir na primeira escrita — uma leitura em arquivo ausente é uma lista vazia', async (t) => {
  const dir = path.join(novoDiretorio(t), 'ainda-nao-existe');
  const filePath = path.join(dir, 'crm.json');
  const service = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath });
  assert.equal(fs.existsSync(dir), false, 'compor não criou o diretório');
  assert.deepEqual(await service.listRecords(contexto()), []);
  assert.equal(fs.existsSync(dir), false, 'ler não criou nada');

  const { record } = await service.createRecord(contexto(), EMPRESA);
  assert.equal(fs.existsSync(filePath), true, 'a primeira escrita cria o arquivo');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(filePath, 'utf8'))), [record.id]);
});

test('[CRM-FILE-5] o autorizador INJETADO é quem decide: um autorizador que recusa impede toda operação e nada é gravado; um que aceita é chamado com o contexto e a permissão da operação (READ:CRM / WRITE:CRM)', async (t) => {
  const filePath = path.join(novoDiretorio(t), 'crm.json');
  const ctx = contexto();

  const recusa = createFileBackedCrmService({
    authorizeOperation: () => {
      throw new Error('acesso negado: recusado pelo autorizador injetado');
    },
    filePath,
  });
  await assert.rejects(async () => await recusa.createRecord(ctx, EMPRESA), /acesso negado/);
  await assert.rejects(async () => await recusa.listRecords(ctx), /acesso negado/);
  assert.equal(fs.existsSync(filePath), false, 'nada foi gravado');

  const chamadas = [];
  const aceita = createFileBackedCrmService({
    authorizeOperation: (contextoRecebido, permissao) => {
      chamadas.push({ contextoRecebido, permissao });
      return { userId: 'u9', name: 'Operador', role: 'ADMIN' };
    },
    filePath,
  });
  const { record } = await aceita.createRecord(ctx, EMPRESA);
  await aceita.listRecords(ctx);
  assert.deepEqual(chamadas.map((chamada) => chamada.permissao), [PERMISSION.WRITE_CRM, PERMISSION.READ_CRM]);
  assert.ok(chamadas.every((chamada) => chamada.contextoRecebido === ctx));
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8'))[record.id].historico[0].reviewedBy, { userId: 'u9', name: 'Operador', role: 'ADMIN' }, 'a identidade gravada é a que o autorizador devolveu');
});

test('[CRM-FILE-6] persistência real: outro Service sobre o MESMO arquivo lê o que o primeiro gravou, com o histórico e o bloqueio DNC; e um arquivo corrompido aparece como erro, nunca como "vazio"', async (t) => {
  const filePath = path.join(novoDiretorio(t), 'crm.json');
  const ctx = contexto();
  const primeiro = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath });
  const { record } = await primeiro.createRecord(ctx, EMPRESA);
  await primeiro.moveStatus(ctx, record.id, 'CONTACTED', { reason: 'primeiro contato' });
  await primeiro.markDoNotContact(ctx, record.id, { reason: 'pediu para sair' });

  const segundo = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath });
  const lido = await segundo.getRecord(ctx, record.id);
  assert.equal(lido.status, 'DO_NOT_CONTACT');
  assert.deepEqual(lido.historico.map((entrada) => entrada.to), ['PROSPECT', 'CONTACTED', 'DO_NOT_CONTACT']);
  await assert.rejects(async () => await segundo.createRecord(ctx, { empresa: 'Outro Nome', site: EMPRESA.site }), /identidade já bloqueada/);

  fs.writeFileSync(filePath, '{ "meio-de-um-json": ');
  await assert.rejects(async () => await segundo.listRecords(ctx), /^Error: CRM: arquivo de dados corrompido/);
  await assert.rejects(async () => await segundo.createRecord(ctx, { empresa: 'Nova' }), /arquivo de dados corrompido/);
});

test('[CRM-FILE-7] a fábrica só conhece o Service e o adapter de arquivo: a lista de importações é fechada e não há I/O, rede nem execução dinâmica no código', () => {
  const analise = analyzeSource(fs.readFileSync(path.join(REPO_ROOT, 'src/services/crmFileService.js'), 'utf8'), 'src/services/crmFileService.js');
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(analise.refs.map((ref) => ref.specifier).sort(), ['../crm/crmRepository', './crmService']);
  const identificadores = new Set(analise.tokens.filter((token) => token.type === 'id').map((token) => token.value));
  for (const proibido of ['readFileSync', 'writeFileSync', 'fs', 'http', 'fetch', 'process', 'eval', 'Function', 'createInMemoryCrmRepository', 'authorizeCrmOperation', 'PERMISSION', 'requirePermission']) {
    assert.equal(identificadores.has(proibido), false, `a fábrica não pode usar ${proibido}`);
  }
});
