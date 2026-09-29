// Composição do REPOSITÓRIO do CRM por REPOSITORY_MODE (etapa 2.3, decisão 0024; caminho Supabase real e cache
// por configuração implementados na etapa 3H) — sobre a composição REAL de produção (src/server/index.js
// createServer), com arquivos temporários. Prova:
//   - REPOSITORY_MODE=file (o padrão) funciona e NÃO exige SUPABASE_SERVICE_ROLE_KEY;
//   - REPOSITORY_MODE=supabase, com configuração SINTÉTICA válida, sobe/constrói de verdade (nunca faz uma
//     chamada de rede na CONSTRUÇÃO — só list()/getById()/save() tocariam a rede, e nenhum teste aqui os chama);
//   - configuração ausente falha citando a variável — nunca cai para "file" em silêncio;
//   - um REPOSITORY_MODE desconhecido também é recusado, nunca tratado como "file";
//   - a instância do repositório é COMPARTILHADA entre o CRM Service direto, a promoção e a prospecção (modo
//     file) — provado tanto por igualdade de objeto (unitário) quanto por uma corrida real entre duas rotas;
//   - o repositório Supabase também tem instância ÚNICA por CONFIGURAÇÃO, nunca por caminho de arquivo.
//
// SOMENTE dados sintéticos (example.test) e credenciais FAKE (nunca reais); tudo em diretório temporário; NENHUMA
// chamada de rede real em nenhum teste (a autenticação usa o adapter REAL do Supabase contra um fetch falso, só
// na borda, como em todo o resto da suíte de servidor; os testes de modo supabase desta etapa nunca invocam
// list()/getById()/save() — só a construção, que é preguiçosa por desenho).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createServer } = require('../../src/server/index');
const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { sharedFileCrmRepository } = require('../../src/services/crmFileService');
const { createConfiguredCrmRepository, createConfiguredCrmService, readRepositoryMode, sharedSupabaseCrmRepository, REPOSITORY_MODE } = require('../../src/services/crmRepositoryFactory');
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
test('[COMPOSE-2] REPOSITORY_MODE=supabase, com configuração válida (SINTÉTICA — SUPABASE_URL/SERVICE_ROLE_KEY de teste, NUNCA reais), sobe o servidor com sucesso e NÃO cria data/crm.json (etapa 3H: a composição real agora existe) — NENHUMA rota é chamada aqui, então nenhum fetch acontece', async (t) => {
  const a = ambienteDeProducao(t, { env: { REPOSITORY_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'service-role-de-teste-nao-real' } });
  const { server, app } = createServer(a.env);
  assert.ok(app, 'o servidor sobe com sucesso em modo supabase, com configuração válida');
  server.close();
  assert.equal(fs.existsSync(a.crmArquivo), false, 'em modo supabase, nada escreve em data/crm.json — nenhum arquivo local é tocado');
});

test('[COMPOSE-2b] REPOSITORY_MODE=supabase SEM SUPABASE_SERVICE_ROLE_KEY é recusado citando a variável ausente — nunca cai para "file" em silêncio (nada é gravado)', async (t) => {
  const a = ambienteDeProducao(t, { env: { REPOSITORY_MODE: 'supabase' } });
  assert.throws(() => createServer(a.env), /SUPABASE_SERVICE_ROLE_KEY não está configurada/);
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

// Config Supabase SINTÉTICA para os testes de fábrica — nunca real, nunca usada para uma chamada de rede (nenhum
// destes testes invoca list()/getById()/save(): só a CONSTRUÇÃO é exercitada, que é preguiçosa por desenho —
// ver o cabeçalho de crmRepositoryFactory.js/crmSupabaseRepository.js).
const ENV_SUPABASE_VALIDO = Object.freeze({ REPOSITORY_MODE: 'supabase', SUPABASE_URL: 'https://projeto-de-teste.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-de-teste-nao-real' });

test('[FACTORY-2] createConfiguredCrmRepository: modo file devolve um repositório que satisfaz a porta; modo supabase, com configuração válida (sintética), TAMBÉM devolve um repositório que satisfaz a porta, sem tocar a rede; configuração ausente falha citando a variável; sem filePath (modo file) lança', () => {
  const { assertValidRepository } = require('../../src/crm/crmRepositoryPort');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-factory-'));
  const filePath = path.join(dir, 'crm.json');
  try {
    const repoArquivo = createConfiguredCrmRepository({ env: {}, filePath });
    assertValidRepository(repoArquivo);
    assert.throws(() => createConfiguredCrmRepository({ env: {}, filePath: undefined }), /exige \{ filePath \}/);

    const repoSupabase = createConfiguredCrmRepository({ env: ENV_SUPABASE_VALIDO, filePath });
    assertValidRepository(repoSupabase);
    assert.notEqual(repoSupabase, repoArquivo, 'modos diferentes nunca compartilham o mesmo objeto');

    assert.throws(
      () => createConfiguredCrmRepository({ env: { REPOSITORY_MODE: 'supabase', SUPABASE_URL: ENV_SUPABASE_VALIDO.SUPABASE_URL }, filePath }),
      /SUPABASE_SERVICE_ROLE_KEY não está configurada/,
      'sem a service_role, falha claro — nunca cai para file'
    );
    assert.throws(
      () => createConfiguredCrmRepository({ env: { REPOSITORY_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'x' }, filePath }),
      /SUPABASE_URL não está configurada/,
      'sem a URL, falha claro — nunca cai para file'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('[FACTORY-3] createConfiguredCrmService: modo file devolve um CRM Service funcional (createRecord/listRecords reais); modo supabase, com configuração válida (sintética), devolve um CRM Service com a MESMA forma, sem tocar a rede (nenhuma operação é chamada); configuração ausente falha antes de tocar o disco', async () => {
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

    // Modo supabase: só a CONSTRUÇÃO é exercitada (nunca createRecord/listRecords aqui) — provar que o Service sai
    // com a forma certa é suficiente para provar a composição; chamar uma operação de verdade faria um fetch real.
    const servicoSupabase = createConfiguredCrmService({ env: ENV_SUPABASE_VALIDO, authorizeOperation: authorizeCrmOperation, filePath: path.join(dir, 'nunca-usado.json') });
    for (const metodo of ['createRecord', 'getRecord', 'listRecords', 'updateRecord', 'moveStatus', 'markDoNotContact', 'getHistory']) {
      assert.equal(typeof servicoSupabase[metodo], 'function', metodo);
    }
    assert.equal(fs.existsSync(path.join(dir, 'nunca-usado.json')), false, 'modo supabase nunca cria o arquivo local');

    assert.throws(
      () => createConfiguredCrmService({ env: { REPOSITORY_MODE: 'supabase' }, authorizeOperation: authorizeCrmOperation, filePath: path.join(dir, 'outro.json') }),
      /SUPABASE_URL não está configurada/
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

test('[FACTORY-5] sharedSupabaseCrmRepository (etapa 3H): a MESMA configuração (url + service_role) devolve o MESMO objeto; url OU chave diferentes nunca compartilham; createSupabaseCrmRepository() chamado direto continua sem cache — só a composição reaproveita, o mesmo padrão de sharedFileCrmRepository', () => {
  const config1 = { url: 'https://projeto-a.supabase.co', serviceRoleKey: 'chave-de-teste-a' };
  const config1DeNovo = { url: 'https://projeto-a.supabase.co', serviceRoleKey: 'chave-de-teste-a' }; // objeto NOVO, mesmos valores
  const configUrlDiferente = { url: 'https://projeto-b.supabase.co', serviceRoleKey: 'chave-de-teste-a' };
  const configChaveDiferente = { url: 'https://projeto-a.supabase.co', serviceRoleKey: 'chave-de-teste-outra' };

  const repo1 = sharedSupabaseCrmRepository(config1);
  const repo1DeNovo = sharedSupabaseCrmRepository(config1DeNovo);
  assert.equal(repo1, repo1DeNovo, 'mesma url + mesma chave (mesmo VALOR, objeto de config diferente) -> MESMO repositório');

  const repoUrlDiferente = sharedSupabaseCrmRepository(configUrlDiferente);
  assert.notEqual(repoUrlDiferente, repo1, 'url diferente nunca compartilha, mesmo com a mesma chave');

  const repoChaveDiferente = sharedSupabaseCrmRepository(configChaveDiferente);
  assert.notEqual(repoChaveDiferente, repo1, 'chave diferente nunca compartilha, mesmo com a mesma url (ex.: credencial girada, ou dois projetos por engano)');

  const { createSupabaseCrmRepository } = require('../../src/crm-adapters/crmSupabaseRepository');
  assert.notEqual(createSupabaseCrmRepository(config1), repo1, 'createSupabaseCrmRepository() chamado direto (fora da composição) continua sem cache, como sempre');
  assert.ok(Object.isFrozen(repo1), 'o adapter continua Object.freeze()d — o cache não abre mão disso');
});

test('[FACTORY-6] o segredo nunca aparece em nenhum erro produzido pela fábrica (configuração ausente/inválida), e o cache nunca devolve nada além do repositório (list/getById/save/delete) — nunca a configuração', () => {
  const CHAVE_SECRETA = 'nao-e-um-segredo-real-mas-nunca-deveria-vazar-8f3a9c2d';
  // Só a URL falta: a chave já foi passada, e mesmo assim não deveria aparecer na mensagem (URL é checada primeiro).
  assert.throws(
    () => createConfiguredCrmRepository({ env: { REPOSITORY_MODE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: CHAVE_SECRETA }, filePath: undefined }),
    (erro) => {
      assert.match(erro.message, /SUPABASE_URL não está configurada/);
      assert.doesNotMatch(erro.message, new RegExp(CHAVE_SECRETA));
      return true;
    }
  );
  // O cache em si não expõe nenhuma API para listar chaves ou inspecionar a config guardada — a única forma de
  // "olhar" é chamar sharedSupabaseCrmRepository de novo, e o retorno é sempre só o repositório (list/getById/
  // save/delete), nunca a configuração usada para criá-lo.
  const repo = sharedSupabaseCrmRepository({ url: 'https://projeto-c.supabase.co', serviceRoleKey: CHAVE_SECRETA });
  assert.deepEqual(Object.keys(repo).sort(), ['delete', 'getById', 'list', 'save']);
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
  // dossierPath explicitamente temporários — e um crmService construído (etapa 3F: a fábrica de arquivo não
  // constrói mais o seu próprio CRM Service, exige um já pronto) sobre o MESMO crmPath da composição de produção,
  // que já cai no mesmo cache de sharedFileCrmRepository (crmFileService.js) usado por createServer().
  const { authorizeCrmOperation, authorizeProposerForLeadApproval, ROLE, USER_STATUS, defineUser } = require('../../src/auth');
  const { createAuthorizationContext } = require('../helpers/authFixtures');
  const { createFileBackedCrmService } = require('../../src/services/crmFileService');
  const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');

  const a = ambienteDeProducao(t);
  const { app } = createServer(a.env);
  const chamar = chamador(app, a.tokenFor);
  const criado = await chamar(BRENO, 'POST', '/api/crm', { empresa: 'Já No CRM Teste', site: 'ja-no-crm.example.test' });
  assert.equal(criado.status, 201);

  const admin = createAuthorizationContext(defineUser({ userId: 'user-compose', authUserId: 'auth-compose', name: 'Composição', email: 'composicao-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }));
  const crmServiceDaProspeccao = createFileBackedCrmService({ authorizeOperation: authorizeCrmOperation, filePath: a.crmArquivo }); // MESMO caminho que createConfiguredCrmService usou em createServer() -> mesmo cache
  const prospectingService = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath: a.queuePath,
    crmService: crmServiceDaProspeccao,
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

// ===========================================================================
// Composição centralizada, por INJEÇÃO (etapa 3F, corrige o BLOCKER 1 da etapa 3E): antes,
// crmIntegrationFileService.js e prospectingFileService.js recebiam um { crmPath } e montavam CADA UM o seu
// próprio CRM Service por trás (createFileBackedCrmService), reaproveitando o repositório só por causa do cache
// de crmFileService.js — mas nunca consultavam REPOSITORY_MODE. Se o bloqueio de "supabase" caísse no futuro sem
// mais nada, os dois continuariam, em silêncio, no arquivo local. Agora as duas fábricas só aceitam um
// `crmService` JÁ PRONTO — nunca um caminho — e é isso que os dois testes abaixo provam.
// ===========================================================================
const { analyzeSource } = require('../helpers/staticImports');

test('[COMPOSE-ARCH-1] crmIntegrationFileService.js e prospectingFileService.js NÃO importam mais crmFileService nem crmRepositoryFactory — por CONSTRUÇÃO, nenhuma das duas fábricas de arquivo tem como montar um segundo CRM Service: só recebem um `crmService` já pronto, injetado por quem compõe', () => {
  const raiz = path.join(__dirname, '..', '..');
  for (const arquivo of ['src/services/crmIntegrationFileService.js', 'src/services/prospectingFileService.js']) {
    const analise = analyzeSource(fs.readFileSync(path.join(raiz, arquivo), 'utf8'), arquivo);
    assert.deepEqual(analise.issues, [], arquivo);
    for (const ref of analise.refs) {
      assert.doesNotMatch(ref.specifier, /crmFileService|crmRepositoryFactory/, `${arquivo} não deveria mais construir o CRM Service por conta própria (importou ${ref.specifier})`);
    }
  }
});

test('[COMPOSE-6] a injeção é por IDENTIDADE, nunca por caminho: um crmService FAKE (sem nenhum arquivo por trás — as duas fábricas nem aceitam mais um crmPath) passado a createFileBackedProspectingService dirige o comportamento REAL da prospecção — prova direta de que a fábrica de arquivo nunca reconstrói um CRM Service próprio', async (t) => {
  const { authorizeProposerForLeadApproval, authorizeCrmOperation, ROLE, USER_STATUS, defineUser } = require('../../src/auth');
  const { createAuthorizationContext } = require('../helpers/authFixtures');
  const { createFileBackedProspectingService } = require('../../src/services/prospectingFileService');

  // Um crmService FAKE, inteiramente em memória: já "vê" um registro com o site abaixo — nenhum adapter de
  // arquivo/Supabase por trás, nenhum caminho possível de configurar (a fábrica não aceita mais isso).
  const REGISTRO_FAKE = { id: 'crm:fake0000-0000-4000-8000-000000000000', empresa: 'Fake', site: 'fake-identidade.example.test', historico: [{ timestamp: '2026-01-01T00:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: null, motivo: null }] };
  const crmServiceFake = Object.freeze({
    listRecords: async () => [REGISTRO_FAKE],
    getRecord: async (ctx, id) => (id === REGISTRO_FAKE.id ? REGISTRO_FAKE : null),
    createRecord: async () => {
      throw new Error('CRM: nunca deveria ser chamado por este teste');
    },
  });

  const { filePath: queuePath } = novaFila(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-compose6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prospectingService = createFileBackedProspectingService({
    authorizeProposer: authorizeProposerForLeadApproval,
    authorizeOperation: authorizeCrmOperation,
    queuePath,
    crmService: crmServiceFake,
    batchPath: path.join(dir, 'lotes.json'),
    dossierPath: path.join(dir, 'dossies.json'),
  });

  const admin = createAuthorizationContext(defineUser({ userId: 'user-compose6', authUserId: 'auth-compose6', name: 'Composição 6', email: 'composicao6-teste@example.test', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE }));
  const submissao = await prospectingService.submitProspecting(admin, {
    briefing: { nicho: 'Psicologia', quantidadeDesejada: 1, regiao: 'Petrópolis/RJ' },
    rawFindings: [
      {
        empresa: 'Mesmo Site Do Fake',
        cidade: 'Petrópolis',
        estado: 'RJ',
        nicho: 'Psicologia',
        campos: { site: [{ valor: REGISTRO_FAKE.site, fonte: 'Fonte de teste', tipoFonte: 'OFICIAL' }] },
        fontes: [`https://${REGISTRO_FAKE.site}`],
      },
    ],
  });
  // Só o crmService FAKE conhece este registro (nenhum arquivo real existe com este site) — a prospecção só pode
  // ter detectado a duplicidade porque usou EXATAMENTE o objeto injetado, nunca um CRM reconstruído à parte.
  assert.equal(submissao.contagens.duplicados, 1, 'a duplicidade só existe no crmService FAKE injetado — prova de identidade, não de caminho compartilhado');
  assert.deepEqual(submissao.prospectIds, []);
});
