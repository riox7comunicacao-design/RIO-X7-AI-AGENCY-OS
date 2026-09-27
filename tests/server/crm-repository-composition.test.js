// Composição do REPOSITÓRIO do CRM por REPOSITORY_MODE (etapa 2.3, decisão 0024) — sobre a composição REAL de
// produção (src/server/index.js createServer), com arquivos temporários. Prova:
//   - REPOSITORY_MODE=file (o padrão) funciona e NÃO exige SUPABASE_SERVICE_ROLE_KEY;
//   - REPOSITORY_MODE=supabase é recusado SEMPRE (nunca cai para "file" em silêncio), mesmo com
//     SUPABASE_SERVICE_ROLE_KEY presente e "válida";
//   - um REPOSITORY_MODE desconhecido também é recusado, nunca tratado como "file";
//   - a instância do repositório é COMPARTILHADA entre o CRM Service direto, a promoção e a prospecção —
//     provado tanto por igualdade de objeto (unitário) quanto por uma corrida real entre duas rotas.
//
// SOMENTE dados sintéticos (example.test); tudo em diretório temporário; NENHUMA chamada de rede (a autenticação
// usa o adapter REAL do Supabase contra um fetch falso, só na borda, como em todo o resto da suíte de servidor).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createServer } = require('../../src/server/index');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { sharedFileCrmRepository } = require('../../src/services/crmFileService');
const { createConfiguredCrmRepository, createConfiguredCrmService, readRepositoryMode, REPOSITORY_MODE } = require('../../src/services/crmRepositoryFactory');
const { FAKE_ENV, fakeAccessToken, installFakeSupabaseAuth, supabaseUserBody } = require('../helpers/authFixtures');
const { novaFila, BRENO, RAFAEL } = require('./testEnv');

const enc = encodeURIComponent;
// Só para a checagem defensiva de [COMPOSE-5] (nunca tocar data/ de verdade) — não é usado para nenhuma escrita.
const REPO_ROOT_DATA = path.join(__dirname, '..', '..', 'data');
const DATA_BATCHES_EXISTIA_ANTES = fs.existsSync(path.join(REPO_ROOT_DATA, 'prospecting-batches.json'));

function requisicao({ method, url, token, body }) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = {};
  if (token) req.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) req.headers['content-type'] = 'application/json';
  return req;
}
const chamador = (app, tokenDe) => async (usuario, method, url, body) => {
  const resposta = await app.handle(requisicao({ method, url, token: usuario ? tokenDe(usuario) : undefined, body }));
  let json = null;
  try {
    json = JSON.parse(resposta.body);
  } catch {
    // sem corpo JSON
  }
  return { status: resposta.status, json };
};

// Monta o ambiente de produção real (createServer) sobre arquivos temporários, com N usuários fictícios.
function ambienteDeProducao(t, { env: envExtra = {}, usuarios = [BRENO, RAFAEL] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-compose-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const usersFile = path.join(dir, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify(usuarios.map(({ userId, authUserId, name, email, role, status }) => ({ userId, authUserId, name, email, role, status }))));
  const tokens = {};
  const corpos = {};
  usuarios.forEach((u, i) => {
    tokens[u.userId] = fakeAccessToken(`compose-${i}`);
    corpos[tokens[u.userId]] = supabaseUserBody({ authUserId: u.authUserId, email: u.email });
  });
  installFakeSupabaseAuth(t, corpos);
  const crmArquivo = path.join(dir, 'crm.json');
  const queuePath = path.join(dir, 'approval-queue.json');
  const env = { ...FAKE_ENV, RIO_X7_USERS_FILE: usersFile, RIO_X7_QUEUE_PATH: queuePath, RIO_X7_CRM_PATH: crmArquivo, ...envExtra };
  return { dir, env, crmArquivo, queuePath, tokenFor: (u) => tokens[u.userId] };
}

// ===========================================================================
// REPOSITORY_MODE=file (o padrão)
// ===========================================================================
test('[COMPOSE-1] REPOSITORY_MODE ausente (o padrão, "file") funciona exatamente como antes, e NÃO exige SUPABASE_SERVICE_ROLE_KEY', async (t) => {
  const a = ambienteDeProducao(t);
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in a.env, false, 'sanidade: o ambiente de teste não tem essa variável');
  const { app, usersCount } = createServer(a.env);
  assert.equal(usersCount, 2);
  const chamar = chamador(app, a.tokenFor);
  const criado = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Clínica Modo Arquivo Teste', site: 'modo-arquivo.example.test' });
  assert.equal(criado.status, 201);
  assert.equal(fs.existsSync(a.crmArquivo), true, 'o arquivo local foi usado, como sempre');
  const lida = await chamar(BRENO, 'GET', `/api/crm/${enc(criado.json.item.id)}`);
  assert.equal(lida.json.item.empresa, 'Clínica Modo Arquivo Teste');
});

test('[COMPOSE-1b] REPOSITORY_MODE="file" explícito é idêntico a omitir a variável', async (t) => {
  const a = ambienteDeProducao(t, { env: { REPOSITORY_MODE: 'file' } });
  const { app } = createServer(a.env);
  const r = await chamador(app, a.tokenFor)(BRENO, 'GET', '/api/crm');
  assert.deepEqual([r.status, r.json], [200, { items: [] }]);
});

// ===========================================================================
// REPOSITORY_MODE=supabase — bloqueado, sempre, sem fallback
// ===========================================================================
test('[COMPOSE-2] REPOSITORY_MODE=supabase é recusado de forma explícita SEMPRE — mesmo com SUPABASE_SERVICE_ROLE_KEY presente e "válida" — e NUNCA cai para "file" em silêncio (nada é gravado)', async (t) => {
  const a = ambienteDeProducao(t, { env: { REPOSITORY_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'service-role-de-teste-nao-real' } });
  assert.throws(() => createServer(a.env), /REPOSITORY_MODE=supabase ainda não está habilitado/);
  assert.equal(fs.existsSync(a.crmArquivo), false, 'nenhum arquivo foi criado — não houve fallback silencioso para "file"');
});

test('[COMPOSE-2b] REPOSITORY_MODE=supabase sem NENHUMA configuração de Supabase extra também é recusado com a MESMA mensagem (o bloqueio não depende de configuração — é incondicional nesta versão)', async (t) => {
  const a = ambienteDeProducao(t, { env: { REPOSITORY_MODE: 'supabase' } });
  assert.throws(() => createServer(a.env), /REPOSITORY_MODE=supabase ainda não está habilitado/);
  assert.equal(fs.existsSync(a.crmArquivo), false);
});

test('[COMPOSE-3] REPOSITORY_MODE com um valor desconhecido é recusado citando o valor — nunca tratado como "file" por padrão silencioso', async (t) => {
  const a = ambienteDeProducao(t, { env: { REPOSITORY_MODE: 'sqlite' } });
  assert.throws(() => createServer(a.env), /REPOSITORY_MODE inválido: "sqlite"/);
  assert.equal(fs.existsSync(a.crmArquivo), false);
});

// ===========================================================================
// Fábrica isolada (sem subir o servidor): as mesmas garantias, unitárias
// ===========================================================================
test('[FACTORY-1] readRepositoryMode: ausente/vazio -> "file"; valores válidos passam; qualquer outro valor lança citando-o', () => {
  assert.equal(readRepositoryMode({}), REPOSITORY_MODE.FILE);
  assert.equal(readRepositoryMode({ REPOSITORY_MODE: '' }), REPOSITORY_MODE.FILE);
  assert.equal(readRepositoryMode({ REPOSITORY_MODE: '  ' }), REPOSITORY_MODE.FILE);
  assert.equal(readRepositoryMode({ REPOSITORY_MODE: 'file' }), REPOSITORY_MODE.FILE);
  assert.equal(readRepositoryMode({ REPOSITORY_MODE: 'supabase' }), REPOSITORY_MODE.SUPABASE);
  assert.throws(() => readRepositoryMode({ REPOSITORY_MODE: 'postgres' }), /REPOSITORY_MODE inválido: "postgres"/);
});

test('[FACTORY-2] createConfiguredCrmRepository: modo file devolve um repositório que satisfaz a porta; modo supabase lança sempre; sem filePath (modo file) lança', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-factory-'));
  const filePath = path.join(dir, 'crm.json');
  try {
    const repo = createConfiguredCrmRepository({ env: {}, filePath });
    assert.equal(typeof repo.list, 'function');
    assert.equal(typeof repo.getById, 'function');
    assert.equal(typeof repo.save, 'function');
    assert.throws(() => createConfiguredCrmRepository({ env: {}, filePath: undefined }), /exige \{ filePath \}/);
    assert.throws(
      () => createConfiguredCrmRepository({ env: { REPOSITORY_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'x' }, filePath }),
      /REPOSITORY_MODE=supabase ainda não está habilitado/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('[FACTORY-3] createConfiguredCrmService: modo file devolve um CRM Service funcional (createRecord/listRecords reais); modo supabase lança antes de tocar o disco', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-factory-svc-'));
  const filePath = path.join(dir, 'crm.json');
  try {
    const { authorizeCrmOperation, ROLE, USER_STATUS, defineUser } = require('../../src/auth');
    const { createAuthorizationContext } = require('../helpers/authFixtures');
    const admin = createAuthorizationContext(defineUser({ userId: 'u1', authUserId: 'a1', name: 'Um', email: 'um-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }));
    const servico = createConfiguredCrmService({ env: {}, authorizeOperation: authorizeCrmOperation, filePath });
    const { record } = await servico.createRecord(admin, { empresa: 'Fábrica Teste' });
    assert.equal((await servico.listRecords(admin)).length, 1);
    assert.equal(record.empresa, 'Fábrica Teste');

    assert.throws(
      () => createConfiguredCrmService({ env: { REPOSITORY_MODE: 'supabase' }, authorizeOperation: authorizeCrmOperation, filePath: path.join(dir, 'outro.json') }),
      /REPOSITORY_MODE=supabase ainda não está habilitado/
    );
    assert.equal(fs.existsSync(path.join(dir, 'outro.json')), false, 'nada foi tocado antes de lançar');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Instância única — prova direta (identidade de objeto) e prova comportamental (corrida real)
// ===========================================================================
test('[FACTORY-4] createConfiguredCrmRepository (modo file) e sharedFileCrmRepository (crmFileService.js) devolvem O MESMO OBJETO para o mesmo caminho — a fábrica de modo não cria um repositório paralelo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-factory-same-'));
  const filePath = path.join(dir, 'crm.json');
  try {
    const viaFactory = createConfiguredCrmRepository({ env: {}, filePath });
    const viaSharedDireto = sharedFileCrmRepository(filePath);
    assert.equal(viaFactory, viaSharedDireto, 'mesma referência de objeto');
    // e chamar createJsonFileCrmRepository DIRETO (fora da composição) continua devolvendo uma instância PRÓPRIA,
    // como sempre (ver tests/crm/crmDomain.test.js [CRM-JSON-*] e tests/services/crmService.test.js [CRM-SVC-45]
    // — a independência do adapter de baixo nível não muda; só a CAMADA DE COMPOSIÇÃO passou a reaproveitar).
    assert.notEqual(createJsonFileCrmRepository(filePath), viaFactory, 'o adapter de baixo nível continua sem cache — só a composição (crmFileService.js) reaproveita');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('[COMPOSE-4] as três composições diferentes (rota direta do CRM, promoção, prospecção) sobre o servidor de produção REAL continuam corretas com uma corrida entre duas delas — nenhuma duplicata, nenhuma escrita perdida', async (t) => {
  const fila = novaFila(t); // alfa (site consultorio-alfa.example.test), beta, e uma DNC — em diretório temporário
  const a = ambienteDeProducao(t);
  const { app } = createServer({ ...a.env, RIO_X7_QUEUE_PATH: fila.filePath });
  const chamar = chamador(app, a.tokenFor);

  assert.equal((await chamar(BRENO, 'POST', `/api/approvals/${enc(fila.ids.alfa)}/approve`, {})).status, 200);

  // Duas requisições DE VERDADE, ao mesmo tempo, pela mesma identidade (site): uma promove o prospect aprovado
  // (crmIntegrationService), a outra cria DIRETO pelo crmService do topo (createConfiguredCrmService). Este teste
  // prova que o RESULTADO continua correto end-to-end pela composição real; a prova DECISIVA de que o
  // compartilhamento de repositório é o que garante isso — reproduzida 30 vezes, e confirmada por mutação (sem o
  // cache de crmFileService.js, o mesmo cenário cria DUAS cópias em 30 de 30 tentativas) — está em
  // tests/services/crmFileService.test.js ([CRM-FILE-8]): a camada HTTP/autenticação entre as duas chamadas aqui
  // introduz variação de tempo suficiente para que a janela de corrida nem sempre seja alcançada neste nível.
  const [promocao, direto] = await Promise.all([
    chamar(BRENO, 'POST', `/api/approvals/${enc(fila.ids.alfa)}/promote`, {}),
    chamar(BRENO, 'POST', '/api/crm', { empresa: 'Corrida Direta Teste', site: 'consultorio-alfa.example.test' }),
  ]);

  const resultados = [promocao, direto];
  const sucessos = resultados.filter((r) => r.status === 200 || r.status === 201);
  const recusas = resultados.filter((r) => r.status === 409);
  assert.equal(sucessos.length, 1, `exatamente um dos dois deveria ter sido aceito: ${JSON.stringify(resultados.map((r) => r.status))}`);
  assert.equal(recusas.length, 1, 'o outro é recusado por duplicidade — nunca os dois aceitos, nunca os dois recusados');

  const registros = createJsonFileCrmRepository(a.crmArquivo).list();
  const comEssaIdentidade = registros.filter((r) => r.site === 'consultorio-alfa.example.test');
  assert.equal(comEssaIdentidade.length, 1, 'exatamente UM registro no arquivo com essa identidade — nenhuma duplicata, nenhuma escrita perdida');
  assert.equal(comEssaIdentidade[0].historico.length, 1, 'histórico intacto (não foi sobrescrito por uma escrita concorrente)');
});

test('[COMPOSE-5] a leitura da PROSPECÇÃO (DNC/duplicidade na submissão) também enxerga o que a rota direta do CRM gravou — mesma instância, mesmo arquivo, visível de imediato', async (t) => {
  // NÃO usa /api/prospecting/submit por HTTP: essa rota, em src/server/index.js, ainda não aceita um caminho de
  // lote/dossiê configurável (limite pré-existente, fora do escopo desta etapa — ver docs/decisions/0023) e usaria
  // o PADRÃO REAL do adapter (data/prospecting-batches.json/prospecting-dossiers.json), gravando fora do
  // diretório temporário deste teste. Para provar a MESMA garantia (a prospecção compartilha o repositório do CRM
  // com a rota direta) sem tocar data/, chama createFileBackedProspectingService() DIRETO, com batchPath/
  // dossierPath explicitamente temporários — e o MESMO crmPath da composição de produção, que já cai no mesmo
  // cache de sharedFileCrmRepository (crmFileService.js) usado por createServer().
  const { authorizeCrmOperation, authorizeProposerForLeadApproval, ROLE, USER_STATUS, defineUser } = require('../../src/auth');
  const { createAuthorizationContext } = require('../helpers/authFixtures');
  const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');

  const a = ambienteDeProducao(t);
  const { app } = createServer(a.env);
  const chamar = chamador(app, a.tokenFor);
  const criado = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Já No CRM Teste', site: 'ja-no-crm.example.test' });
  assert.equal(criado.status, 201);

  const admin = createAuthorizationContext(defineUser({ userId: 'user-compose', authUserId: 'auth-compose', name: 'Composição', email: 'composicao-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }));
  const prospectingService = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath: a.queuePath,
    crmPath: a.crmArquivo, // MESMO caminho que createConfiguredCrmService usou em createServer() -> mesmo cache
    batchPath: path.join(a.dir, 'lotes-teste.json'),
    dossierPath: path.join(a.dir, 'dossies-teste.json'),
  });

  const submissao = await prospectingService.submitProspecting(admin, {
    briefing: { nicho: 'Psicologia', quantidadeDesejada: 1, regiao: 'Petrópolis/RJ' },
    rawFindings: [
      {
        empresa: 'Mesmo Site De Novo',
        cidade: 'Petrópolis',
        estado: 'RJ',
        nicho: 'Psicologia',
        campos: { site: [{ valor: 'ja-no-crm.example.test', fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }] },
        fontes: ['https://ja-no-crm.example.test'],
      },
    ],
  });
  assert.equal(submissao.contagens.duplicados, 1, 'a prospecção, sobre o MESMO repositório (mesmo crmPath), já viu o registro recém-criado pela rota direta do CRM');
  assert.deepEqual(submissao.prospectIds, []);
  // este teste nunca deveria tocar o data/ real do projeto — só os caminhos temporários explícitos acima.
  assert.equal(fs.existsSync(path.join(REPO_ROOT_DATA, 'prospecting-batches.json')), DATA_BATCHES_EXISTIA_ANTES, 'este teste não deveria criar nem alterar data/prospecting-batches.json');
});
