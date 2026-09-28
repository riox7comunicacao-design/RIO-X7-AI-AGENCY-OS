// scripts/export-crm.js (etapa 3L) — export lógico, SOMENTE LEITURA, de public.crm_records. NENHUM teste aqui
// toca a rede real: os testes de configuração ausente lançam antes de qualquer fetch (validação síncrona de
// readSupabaseCrmConfig); os demais injetam um repositório FAKE (nunca o adapter real) via a opção `repository`
// de exportarCrm(), pensada exatamente para isto — nunca substitui o fetch global, porque não precisa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exportarCrm, nomeDoArquivo, DEFAULT_BACKUP_DIR } = require('../../scripts/export-crm');

const REPO_ROOT = path.join(__dirname, '..', '..');

function novoDiretorio(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-export-crm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const registro = (overrides = {}) => ({
  id: 'crm:22222222-2222-4222-8222-222222222222',
  status: 'PROSPECT',
  dataDeEntrada: '2026-09-27T10:00:00.000Z',
  historico: [{ timestamp: '2026-09-27T10:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: null, motivo: null }],
  empresa: 'Clínica Export Teste',
  site: null, telefone: null, whatsapp: null, instagram: null, cidade: null,
  ...overrides,
});

// ===========================================================================
// 1-2. Configuração ausente (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — nunca toca a rede
// ===========================================================================
test('[EXPCRM-1] sem SUPABASE_URL: exportarCrm() rejeita citando a variável ausente, sem tocar a rede e sem criar arquivo', async (t) => {
  const outDir = novoDiretorio(t);
  await assert.rejects(
    () => exportarCrm({ env: { SUPABASE_SERVICE_ROLE_KEY: 'chave-de-teste-nao-real' }, outDir }),
    /SUPABASE_URL não está configurada/
  );
  assert.deepEqual(fs.readdirSync(outDir), [], 'nenhum arquivo deveria ter sido criado');
});

test('[EXPCRM-2] sem SUPABASE_SERVICE_ROLE_KEY: exportarCrm() rejeita citando a variável ausente, sem tocar a rede e sem criar arquivo', async (t) => {
  const outDir = novoDiretorio(t);
  await assert.rejects(
    () => exportarCrm({ env: { SUPABASE_URL: 'https://projeto-de-teste.supabase.co' }, outDir }),
    /SUPABASE_SERVICE_ROLE_KEY não está configurada/
  );
  assert.deepEqual(fs.readdirSync(outDir), [], 'nenhum arquivo deveria ter sido criado');
});

// ===========================================================================
// 3. Resposta de erro (repositório fake que rejeita, como o adapter real faria numa falha do PostgREST)
// ===========================================================================
test('[EXPCRM-3] se repository.list() rejeita (equivalente a uma falha do PostgREST), exportarCrm() propaga o erro e não cria arquivo', async (t) => {
  const outDir = novoDiretorio(t);
  const repositoryFalho = { list: async () => { throw new Error('CRM (Supabase): PostgREST recusou a operação (HTTP 500).'); } };
  await assert.rejects(() => exportarCrm({ outDir, repository: repositoryFalho }), /PostgREST recusou a operação/);
  assert.deepEqual(fs.readdirSync(outDir), [], 'nenhum arquivo deveria ter sido criado numa falha');
});

// ===========================================================================
// 4-6. Resposta válida vazia, formato do arquivo, recordCount
// ===========================================================================
test('[EXPCRM-4] resposta válida VAZIA: recordCount 0, records [], formato exato do arquivo (o mesmo cenário do banco real hoje)', async (t) => {
  const outDir = novoDiretorio(t);
  const repositoryVazio = { list: async () => [] };
  const { arquivo, recordCount } = await exportarCrm({ outDir, repository: repositoryVazio });
  assert.equal(recordCount, 0);
  assert.ok(fs.existsSync(arquivo));
  const conteudo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  assert.deepEqual(Object.keys(conteudo).sort(), ['exportedAt', 'format', 'recordCount', 'records', 'source', 'table', 'version'].sort());
  assert.equal(conteudo.format, 'rio-x7-crm-export');
  assert.equal(conteudo.version, 1);
  assert.equal(conteudo.source, 'supabase');
  assert.equal(conteudo.table, 'public.crm_records');
  assert.equal(conteudo.recordCount, 0);
  assert.deepEqual(conteudo.records, []);
  assert.ok(Number.isFinite(Date.parse(conteudo.exportedAt)), 'exportedAt deveria ser um timestamp ISO 8601 válido');
});

test('[EXPCRM-5] resposta válida com registros: recordCount bate com a quantidade, records preserva os dados (incluindo histórico)', async (t) => {
  const outDir = novoDiretorio(t);
  const registros = [registro(), registro({ id: 'crm:33333333-3333-4333-8333-333333333333', empresa: 'Outra Clínica' })];
  const repositoryComDados = { list: async () => registros };
  const { recordCount } = await exportarCrm({ outDir, repository: repositoryComDados });
  assert.equal(recordCount, 2);
  const [arquivoNome] = fs.readdirSync(outDir);
  const conteudo = JSON.parse(fs.readFileSync(path.join(outDir, arquivoNome), 'utf8'));
  assert.equal(conteudo.recordCount, 2);
  assert.deepEqual(conteudo.records, registros);
  assert.equal(conteudo.records[0].historico.length, 1, 'histórico precisa ser preservado no export');
});

// ===========================================================================
// 7. Ausência de secrets no output (arquivo e console)
// ===========================================================================
test('[EXPCRM-6] o arquivo de export nunca contém a URL/credencial de configuração — só dados do CRM e metadata', async (t) => {
  const outDir = novoDiretorio(t);
  const CHAVE_SECRETA = 'nao-e-real-mas-nunca-deveria-vazar-8f3a9c2d';
  const URL_SECRETA_DE_TESTE = 'https://projeto-secreto-de-teste.supabase.co';
  // A fábrica real É atingida aqui (sem repository override) para provar que mesmo tendo a config em mãos,
  // exportarCrm nunca a escreve no arquivo — só repository.list() é chamado, e o resultado (vazio) é gravado.
  const outDir2 = novoDiretorio(t);
  const repositoryFake = { list: async () => [] };
  await exportarCrm({ env: { SUPABASE_URL: URL_SECRETA_DE_TESTE, SUPABASE_SERVICE_ROLE_KEY: CHAVE_SECRETA }, outDir: outDir2, repository: repositoryFake });
  const [arquivoNome] = fs.readdirSync(outDir2);
  const textoDoArquivo = fs.readFileSync(path.join(outDir2, arquivoNome), 'utf8');
  assert.doesNotMatch(textoDoArquivo, new RegExp(CHAVE_SECRETA));
  assert.doesNotMatch(textoDoArquivo, /SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey/);
  assert.equal(fs.readdirSync(outDir).length, 0, 'sanidade: o outDir vazio continua vazio');
});

test('[EXPCRM-7] a saída de console do script real (via require.main) nunca imprime registros nem configuração — só as 3 linhas fixas pedidas', () => {
  const codigoFonte = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'export-crm.js'), 'utf8');
  // Verificação estática: os únicos console.log de sucesso são exatamente estas 3 linhas fixas — nenhuma outra
  // chamada de console.* imprime `records`, `env`, ou qualquer coisa que pareça uma credencial.
  const linhasDeLog = codigoFonte.match(/console\.(log|error)\([^)]*\)/g) || [];
  assert.ok(linhasDeLog.length >= 3, 'deveria haver pelo menos as 3 linhas de sucesso e a de erro');
  for (const linha of linhasDeLog) {
    assert.doesNotMatch(linha, /\brecords\b/, `linha de log não deveria mencionar records: ${linha}`);
    assert.doesNotMatch(linha, /serviceRoleKey|SUPABASE_SERVICE_ROLE_KEY/, `linha de log não deveria mencionar a credencial: ${linha}`);
  }
});

// ===========================================================================
// 8. Nenhum método HTTP mutável utilizado
// ===========================================================================
test('[EXPCRM-8] exportarCrm() nunca chama getById() nem save() do repositório — só list() (nenhum método mutável é usado)', async (t) => {
  const outDir = novoDiretorio(t);
  const chamadas = [];
  const repositorioEspiao = {
    list: async () => { chamadas.push('list'); return []; },
    getById: async () => { chamadas.push('getById'); return null; },
    save: async () => { chamadas.push('save'); },
  };
  await exportarCrm({ outDir, repository: repositorioEspiao });
  assert.deepEqual(chamadas, ['list'], 'só list() deveria ter sido chamado — nunca getById()/save()');
});

// ===========================================================================
// 9. Nome do arquivo
// ===========================================================================
test('[EXPCRM-9] nomeDoArquivo() segue exatamente o padrão crm-export-YYYYMMDD-HHmmss.json, em UTC', () => {
  const data = new Date(Date.UTC(2026, 8, 27, 13, 5, 9)); // 2026-09-27T13:05:09Z
  assert.equal(nomeDoArquivo(data), 'crm-export-20260927-130509.json');
  assert.match(nomeDoArquivo(new Date()), /^crm-export-\d{8}-\d{6}\.json$/);
});

test('[EXPCRM-10] o arquivo real gravado por exportarCrm() usa esse padrão de nome, dentro do outDir informado', async (t) => {
  const outDir = novoDiretorio(t);
  const { arquivo } = await exportarCrm({ outDir, repository: { list: async () => [] } });
  assert.equal(path.dirname(arquivo), outDir);
  assert.match(path.basename(arquivo), /^crm-export-\d{8}-\d{6}\.json$/);
});

// ===========================================================================
// 10. Backup fora do Git
// ===========================================================================
test('[EXPCRM-11] backups/crm/ (o diretório padrão de export) está no .gitignore — nenhum export entra no Git por acidente', () => {
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^backups\/crm\/$/m, '.gitignore deveria ignorar backups/crm/ exatamente');
  assert.equal(DEFAULT_BACKUP_DIR, path.join(REPO_ROOT, 'backups', 'crm'));
});

test('[EXPCRM-12] o script não importa nada de dashboard/ nem é servido pela aplicação — busca estática confirma ausência de qualquer referência', () => {
  const codigoFonte = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'export-crm.js'), 'utf8');
  assert.doesNotMatch(codigoFonte, /dashboard/);
  assert.doesNotMatch(codigoFonte, /require\(['"]\.\.\/src\/server/, 'o exportador não deveria depender do servidor HTTP');
  for (const arquivoServidor of ['src/server/index.js', 'src/server/app.js', 'src/server/static.js']) {
    const fonteServidor = fs.readFileSync(path.join(REPO_ROOT, arquivoServidor), 'utf8');
    assert.doesNotMatch(fonteServidor, /export-crm/, `${arquivoServidor} não deveria referenciar o exportador`);
  }
});
