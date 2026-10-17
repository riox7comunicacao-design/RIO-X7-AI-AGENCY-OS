// A fábrica das entidades COMERCIAIS por REPOSITORY_MODE (src/services/commercialRepositoryFactory.js — Fase D1.1, decisão 0029): "supabase" usa SÓ os adapters do Supabase (nunca um fallback para o arquivo),
// "file" usa os adapters de arquivo (só desenvolvimento isolado e testes), as duas entidades do mesmo modo saem da MESMA decisão e nenhuma rede ou tabela nasce só por configurar. O guarda de rede hermético
// derruba qualquer tentativa de falar com a rede real. Nenhum dado real; nenhuma credencial real (valores de teste).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const factory = require('../../src/services/commercialRepositoryFactory');
const { createFileBackedFunnelService } = require('../../src/services/funnelFileService');
const { createFileBackedNegotiationService } = require('../../src/services/negotiationFileService');

const SUPABASE = Object.freeze({ REPOSITORY_MODE: 'supabase', SUPABASE_URL: 'https://exemplo-teste.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'chave-de-servico-falsa-so-para-teste' });
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-factory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const autorizadorQualquer = () => ({ userId: 'user-teste', name: 'Teste', role: 'ADMIN' });
const dependenciasDeServico = { authorizeCrmOperation: autorizadorQualquer, crmRepository: { getById: async () => null }, crmService: { getRecord: async () => null }, catalogService: { get: async () => null } };

test('[COMFAC-1] MODO ARQUIVO (padrão e "file"): os adapters de arquivo, nos caminhos escolhidos por quem compõe; sem o caminho a fábrica FALHA (nenhum padrão escondido); a mesma instância por caminho; nenhum arquivo nasce só por configurar', (t) => {
  const dir = tmp(t);
  const funis = path.join(dir, 'funnels.json');
  const negociacoes = path.join(dir, 'negotiations.json');
  for (const env of [{}, { REPOSITORY_MODE: 'file' }, { REPOSITORY_MODE: ' file ' }, { REPOSITORY_MODE: '' }]) {
    const f = factory.createConfiguredFunnelRepository({ env, funnelsFilePath: funis });
    const n = factory.createConfiguredNegotiationRepository({ env, negotiationsFilePath: negociacoes });
    assert.equal(typeof f.listCardsByFunnel, 'function');
    assert.equal(f.commitCardChange, undefined, 'o adapter de arquivo não tem as operações atômicas do banco');
    assert.equal(n.commit, undefined);
    assert.equal(f, factory.createConfiguredFunnelRepository({ env, funnelsFilePath: funis }), 'instância única por caminho');
    assert.equal(n, factory.createConfiguredNegotiationRepository({ env, negotiationsFilePath: negociacoes }));
  }
  assert.throws(() => factory.createConfiguredFunnelRepository({ env: {} }), /exige \{ funnelsFilePath \}/);
  assert.throws(() => factory.createConfiguredNegotiationRepository({ env: {}, negotiationsFilePath: '   ' }), /exige \{ negotiationsFilePath \}/);
  assert.equal(fs.existsSync(funis) || fs.existsSync(negociacoes), false, 'nenhum arquivo foi criado');
  assert.notEqual(factory.createConfiguredFunnelRepository({ env: {}, funnelsFilePath: path.join(dir, 'outro.json') }), factory.createConfiguredFunnelRepository({ env: {}, funnelsFilePath: funis }));
});

test('[COMFAC-2] MODO SUPABASE: os adapters do Supabase para AS DUAS entidades, da mesma configuração (nunca funil num armazenamento e negociação em outro), a mesma instância por configuração, nenhuma rede só por configurar e NENHUM arquivo usado ou criado — mesmo com caminhos informados', (t) => {
  const dir = tmp(t);
  const funis = path.join(dir, 'funnels.json');
  const negociacoes = path.join(dir, 'negotiations.json');
  const f = factory.createConfiguredFunnelRepository({ env: SUPABASE, funnelsFilePath: funis });
  const n = factory.createConfiguredNegotiationRepository({ env: SUPABASE, negotiationsFilePath: negociacoes });
  assert.equal(typeof f.commitCardChange, 'function', 'tem as operações atômicas do banco');
  assert.equal(typeof n.commit, 'function');
  assert.equal(f, factory.createConfiguredFunnelRepository({ env: SUPABASE }), 'sem caminho de arquivo: nada é exigido');
  assert.equal(n, factory.createConfiguredNegotiationRepository({ env: SUPABASE }));
  assert.notEqual(f, factory.createConfiguredFunnelRepository({ env: { ...SUPABASE, SUPABASE_SERVICE_ROLE_KEY: 'outra-chave-falsa-so-para-teste' } }), 'outra chave = outra instância');
  assert.equal(fs.existsSync(funis) || fs.existsSync(negociacoes), false, 'nenhum arquivo foi criado nem seria usado');
  // as duas vêm do mesmo par de configuração
  const servico = factory.createConfiguredNegotiationService({ env: SUPABASE, ...dependenciasDeServico });
  assert.deepEqual(Object.keys(servico).sort(), ['board', 'create', 'get', 'list', 'lose', 'move', 'reopen', 'summary', 'update', 'win']);
  const servicoFunis = factory.createConfiguredFunnelService({ env: SUPABASE, authorizeOperation: autorizadorQualquer, authorizeCrmOperation: autorizadorQualquer, crmRepository: { getById: async () => null }, crmService: { getRecord: async () => null } });
  assert.equal(typeof servicoFunis.listFunnels, 'function');
});

test('[COMFAC-3] SEM FALLBACK SILENCIOSO: em "supabase" a configuração incompleta ou inválida FALHA citando só o NOME da variável (nunca um valor), e nunca cai para o arquivo; um modo desconhecido é erro claro; a chave nunca aparece no erro', (t) => {
  const dir = tmp(t);
  const comArquivo = { funnelsFilePath: path.join(dir, 'funnels.json'), negotiationsFilePath: path.join(dir, 'negotiations.json') };
  for (const [env, mensagem] of [
    [{ REPOSITORY_MODE: 'supabase' }, /SUPABASE_URL não está configurada/],
    [{ REPOSITORY_MODE: 'supabase', SUPABASE_URL: 'https://x.supabase.co' }, /SUPABASE_SERVICE_ROLE_KEY não está configurada/],
    [{ REPOSITORY_MODE: 'supabase', SUPABASE_URL: 'http://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }, /deve ser https/],
    [{ REPOSITORY_MODE: 'supabase', SUPABASE_URL: 'não é url', SUPABASE_SERVICE_ROLE_KEY: 'k' }, /não é uma URL válida/],
  ]) {
    for (const criar of [() => factory.createConfiguredFunnelRepository({ env, ...comArquivo }), () => factory.createConfiguredNegotiationRepository({ env, ...comArquivo }), () => factory.createConfiguredActiveFunnelCardsChecker({ env, ...comArquivo })]) {
      assert.throws(criar, (erro) => mensagem.test(erro.message) && !/chave-de-servico/.test(erro.message));
    }
  }
  assert.throws(() => factory.createConfiguredFunnelRepository({ env: { REPOSITORY_MODE: 'postgres' }, ...comArquivo }), /REPOSITORY_MODE inválido: "postgres"/);
  assert.equal(fs.readdirSync(dir).length, 0, 'nenhum arquivo apareceu (nenhum fallback)');
});

test('[COMFAC-4] O CHECADOR DE CARDS que protege a exclusão de um cliente é uma FUNÇÃO só (nunca o repositório) e segue o MESMO modo; os Services montados pela fábrica seguem o modo e as autorizações injetadas', async (t) => {
  const dir = tmp(t);
  const contar = factory.createConfiguredActiveFunnelCardsChecker({ env: {}, funnelsFilePath: path.join(dir, 'funnels.json') });
  assert.equal(typeof contar, 'function');
  assert.equal(await contar('crm:qualquer'), 0);
  const supabase = factory.createConfiguredActiveFunnelCardsChecker({ env: SUPABASE });
  assert.equal(typeof supabase, 'function');
  assert.equal(supabase.length, 1);
  // em modo arquivo a composição por fábrica equivale à composição por arquivo de antes (mesmas 10 operações / mesmas operações de funil)
  const porFabrica = factory.createConfiguredNegotiationService({ env: {}, funnelsFilePath: path.join(dir, 'f.json'), negotiationsFilePath: path.join(dir, 'n.json'), ...dependenciasDeServico });
  const porArquivo = createFileBackedNegotiationService({ authorizeCrmOperation: autorizadorQualquer, filePath: path.join(dir, 'n2.json'), funnelsFilePath: path.join(dir, 'f2.json'), crmRepository: { getById: async () => null }, crmService: { getRecord: async () => null }, catalogService: { get: async () => null } });
  assert.deepEqual(Object.keys(porFabrica).sort(), Object.keys(porArquivo).sort());
  const funisPorFabrica = factory.createConfiguredFunnelService({ env: {}, funnelsFilePath: path.join(dir, 'f3.json'), authorizeOperation: autorizadorQualquer, authorizeCrmOperation: autorizadorQualquer, crmRepository: { getById: async () => null }, crmService: { getRecord: async () => null } });
  const funisPorArquivo = createFileBackedFunnelService({ authorizeOperation: autorizadorQualquer, authorizeCrmOperation: autorizadorQualquer, filePath: path.join(dir, 'f4.json'), crmRepository: { getById: async () => null }, crmService: { getRecord: async () => null } });
  assert.deepEqual(Object.keys(funisPorFabrica).sort(), Object.keys(funisPorArquivo).sort());
});

test('[COMFAC-5] A COMPOSIÇÃO REAL (src/server/index.js) não tem caminho de arquivo escondido: funis e negociações só entram pela fábrica comercial, e o modo "supabase" nunca consulta os caminhos de arquivo', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server', 'index.js'), 'utf8');
  assert.match(index, /createConfiguredFunnelService\(\{\s*env,/);
  assert.match(index, /createConfiguredNegotiationService\(\{\s*env,/);
  assert.match(index, /createConfiguredActiveFunnelCardsChecker\(\{ env, funnelsFilePath \}\)/);
  assert.doesNotMatch(index, /createFileBacked(Funnel|Negotiation)Service|createJsonFile(Funnel|Negotiation)Repository/);
  const fabrica = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'commercialRepositoryFactory.js'), 'utf8');
  // no ramo "supabase" (o retorno antecipado) nenhum caminho de arquivo é lido: a exigência do caminho só vem DEPOIS dele, nas duas entidades
  assert.match(fabrica, /SUPABASE\) return sharedSupabasePair\(env\)\.funnelRepository;\n\s*const key = requireFilePath\(funnelsFilePath, 'funnelsFilePath'\);/);
  assert.match(fabrica, /SUPABASE\) return sharedSupabasePair\(env\)\.negotiationRepository;\n\s*const key = requireFilePath\(negotiationsFilePath, 'negotiationsFilePath'\);/);
});
