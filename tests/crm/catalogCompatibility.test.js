// COMPATIBILIDADE e NÃO INTERFERÊNCIA dos catálogos do CRM (CRM 5.0, Fase 2B-1 — decisões D3 e "não alterar o que existe"): provas ESTÁTICAS e de
// comportamento de que Serviços, Nichos e Origens não tocam o CRM legado, a promoção, a prospecção nem a Fila de Aprovação; que o preço de
// referência nunca vira valor de proposta; e que as migrations anteriores continuam byte a byte como estavam. Sem rede, sem banco, sem dados reais.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (relativo) => fs.readFileSync(path.join(ROOT, relativo), 'utf8');
const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const arvore = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entrada) => {
    const relativo = `${dir}/${entrada.name}`.replace(/\\/g, '/');
    return entrada.isDirectory() ? arvore(relativo) : [relativo];
  });

// Os identificadores que só os catálogos usam (palavras soltas como "catalog" existem em outros módulos, com outro sentido).
const MARCAS_DE_CATALOGO = /catalogDomain|catalogService|catalogRepository|catalogBridge|catalogUsage|catalogConstants|crmCatalogService|crm-catalogs|crm_services|crm_niches|crm_lead_origins|precoReferencia|preco_referencia|NICHE_COLORS|CATALOG_KEYS|CATALOG_DEFINITIONS|MANAGE_CRM_CATALOGS|authorizeCatalogOperation|createCatalogService/;

// Tudo o que já existia e NÃO pode conhecer os catálogos: o CRM (domínio, serviço, adapters, fábrica), Funis, a promoção, a prospecção, a
// Fila de Aprovação e a pesquisa.
const MODULOS_LEGADOS = [
  ...arvore('src/crm').filter((f) => !/\/catalog[A-Za-z]*\.js$/.test(f)),
  ...arvore('src/crm-adapters').filter((f) => !/crmSupabaseCatalogRepository\.js$/.test(f) && !/index\.js$/.test(f)),
  ...arvore('src/research-prospector'),
  ...arvore('src/research-adapters'),
  ...arvore('src/prospecting-adapters'),
  ...arvore('src/services').filter((f) => !/\/catalog[A-Za-z]*\.js$/.test(f)),
  'src/auth/crmBridge.js', 'src/auth/funnelBridge.js', 'src/auth/approvalQueueBridge.js', 'src/auth/leadProposalBridge.js', 'src/auth/prospectingExclusionBridge.js',
];

test('[CATCOMPAT-1] NENHUM módulo legado conhece os catálogos: CRM, Funis, promoção, prospecção, Fila de Aprovação e pesquisa não os importam nem os citam no código', () => {
  assert.ok(MODULOS_LEGADOS.length > 60, 'a lista cobre o sistema todo');
  const achados = [];
  for (const arquivo of MODULOS_LEGADOS) {
    if (!arquivo.endsWith('.js')) continue;
    const codigo = semComentarios(read(arquivo));
    const marca = MARCAS_DE_CATALOGO.exec(codigo);
    if (marca) achados.push(`${arquivo}: ${marca[0]}`);
  }
  assert.deepEqual(achados, []);
  // o barrel do domínio do CRM também não exporta nada dos catálogos
  assert.doesNotMatch(read('src/crm/index.js'), /catalog/i);
});

test('[CATCOMPAT-2] só o SERVIDOR (rotas e composição) e as fábricas ligam os catálogos ao resto: quem importa os módulos de catálogo é uma lista fechada', () => {
  const importadores = [];
  for (const arquivo of [...arvore('src'), ...arvore('scripts')].filter((f) => f.endsWith('.js'))) {
    if (/\/catalog[A-Za-z]*\.js$/.test(arquivo) || /crmSupabaseCatalogRepository\.js$/.test(arquivo)) continue;
    const codigo = semComentarios(read(arquivo));
    if (/require\('[^']*catalog[A-Za-z]*'\)|require\('[^']*crmSupabaseCatalogRepository'\)/.test(codigo)) importadores.push(arquivo);
  }
  assert.deepEqual(importadores.sort(), ['src/auth/index.js', 'src/crm-adapters/index.js', 'src/server/index.js'], 'quem importa módulos de catálogo');
});

test('[CATCOMPAT-3] o PREÇO DE REFERÊNCIA nunca vira o valor de uma proposta: só quatro módulos o conhecem, e eles não citam valorProposta nem valorTotal em código; nada do CRM, da promoção ou do Dashboard o usa', () => {
  const comPreco = [...arvore('src'), ...arvore('dashboard'), ...arvore('scripts')]
    .filter((f) => /\.(js|mjs)$/.test(f))
    .filter((f) => /precoReferencia|preco_referencia/.test(semComentarios(read(f))));
  assert.deepEqual(comPreco.sort(), ['src/crm-adapters/crmSupabaseCatalogRepository.js', 'src/crm/catalogConstants.js', 'src/crm/catalogDomain.js', 'src/crm/catalogRepositoryPort.js']);
  for (const arquivo of arvore('src').filter((f) => /\/catalog[A-Za-z]*\.js$/.test(f) || /crmSupabaseCatalogRepository\.js$/.test(f))) {
    assert.doesNotMatch(semComentarios(read(arquivo)), /valorProposta|valorTotal|valor_proposta|valor_total/, `${arquivo}: o preço de referência não alimenta valores de proposta`);
  }
  // a migration também não relaciona os dois
  assert.doesNotMatch(read('supabase/migrations/20261012090000_crm_catalogs.sql').replace(/--[^\n]*/g, ''), /valor_proposta|valor_total/);
});

test('[CATCOMPAT-4] o mapeamento da PROMOÇÃO (Fila -> CRM) segue copiando o texto livre: `nicho` e `origem` ainda vêm do snapshot como estão, sem canonicalização, sem consulta a catálogo', () => {
  const { mapProspectToCrmFields, DIRECT_FIELDS } = require('../../src/services/prospectToCrmFields');
  assert.deepEqual(DIRECT_FIELDS.find(([crm]) => crm === 'nicho'), ['nicho', 'nicho']);
  assert.deepEqual(DIRECT_FIELDS.find(([crm]) => crm === 'origem'), ['origem', 'origem']);
  const campos = mapProspectToCrmFields({ empresa: 'Clínica Bella', discoverySnapshot: { nicho: 'Clinica de EStética', cidade: 'Petrópolis' } });
  assert.equal(campos.nicho, 'Clinica de EStética', 'o texto digitado passa exatamente como veio');
  assert.equal(campos.empresa, 'Clínica Bella');
  assert.equal('origem' in campos, false, 'a fila não carrega `origem`: nada é inventado');
});

test('[CATCOMPAT-5] o CRM legado aceita e devolve exatamente o texto livre em nicho, origem e servicoPotencial (o domínio não os valida contra nada), e os campos do registro não ganharam nenhum identificador de catálogo', async () => {
  const { createRecord, updateRecord, getRecord } = require('../../src/crm/crmDomain');
  const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
  const { CRM_WRITABLE_FIELDS } = require('../../src/crm/constants');
  const repo = createInMemoryCrmRepository();
  const { record } = await createRecord(repo, { empresa: 'Empresa Livre', nicho: 'Clinica de EStética', origem: 'Boca a boca', servicoPotencial: 'Qualquer coisa' });
  assert.equal(record.nicho, 'Clinica de EStética');
  assert.equal(record.origem, 'Boca a boca');
  assert.equal(record.servicoPotencial, 'Qualquer coisa');
  const editado = await updateRecord(repo, record.id, { nicho: 'outro texto', origem: null });
  assert.equal(editado.nicho, 'outro texto');
  assert.equal(editado.origem, null);
  assert.deepEqual(Object.keys(await getRecord(repo, record.id)).sort(), [...CRM_WRITABLE_FIELDS, 'id', 'status', 'dataDeEntrada', 'historico'].sort(), 'nenhum campo a mais');
  await assert.rejects(() => createRecord(repo, { empresa: 'X', nichoId: 'niche:1' }), /campos desconhecidos/, 'um identificador de catálogo NÃO é aceito no registro nesta fase');
  await assert.rejects(() => createRecord(repo, { empresa: 'Y', servicoId: 'service:1', origemId: 'origin:1' }), /campos desconhecidos/);
});

test('[CATCOMPAT-6] as 5 migrations ANTERIORES continuam byte a byte (fim de linha normalizado) como estavam — a Fase 2B-1 não alterou crm_records nem nenhuma tabela existente; mudar uma delas exige uma migration nova', () => {
  const esperado = {
    '20260927120000_crm_initial_schema.sql': 'd08c4eb0bc64f198b4c5e18ebd6b323cb741e79c3063f7215b2b0ee59631ad22',
    '20260928090000_crm_delete_audit.sql': 'ada7ed2234c4527f1961a36307e58af9e07876f6e6375189eedc0fec6676982b',
    '20260928220000_crm_funnels.sql': 'd126715e8a71f31c75189644bbdb415ba55ae578e7541ece60f1a8df08074712',
    '20260929100000_crm_funnel_cards_funis2.sql': 'efbf7c3c07a115fafee28cae7f95d675e7795ef31514b3e3282bc90657c87f5b',
    '20260930090000_prospecting_permanent_exclusions.sql': 'f5ce7a919c65bc7bc013306a1790bff30e4e33fe419086806a979df60ead600c',
  };
  const existentes = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((n) => n.endsWith('.sql')).sort();
  assert.deepEqual(existentes, [...Object.keys(esperado), '20261012090000_crm_catalogs.sql'], 'só a dos catálogos foi acrescentada');
  for (const [arquivo, hash] of Object.entries(esperado)) {
    const conteudo = read(`supabase/migrations/${arquivo}`).replace(/\r\n/g, '\n');
    assert.equal(crypto.createHash('sha256').update(conteudo).digest('hex'), hash, `${arquivo} foi alterada`);
  }
});

test('[CATCOMPAT-7] os módulos de catálogo não conhecem caminhos de dados reais: nenhum "data/", nenhum arquivo do CRM, da fila ou de prospecção — o caminho do arquivo local só é escolhido pela composição (src/server/index.js), em data/crm-catalogs.json, que só nasce quando um ADMIN cria o primeiro item', () => {
  const modulos = arvore('src').filter((f) => /\/catalog[A-Za-z]*\.js$/.test(f) || /crmSupabaseCatalogRepository\.js$/.test(f));
  assert.ok(modulos.length >= 8);
  for (const arquivo of modulos) {
    const codigo = semComentarios(read(arquivo));
    assert.doesNotMatch(codigo, /['"`][^'"`]*\bdata[\\/]/, `${arquivo}: nenhum caminho data/`);
    assert.doesNotMatch(codigo, /\.json['"`]/, `${arquivo}: nenhum nome de arquivo .json embutido`);
    assert.doesNotMatch(codigo, /crm\.json|approval-queue|prospecting-|funnels\.json|users\.json/, arquivo);
  }
  const composicao = semComentarios(read('src/server/index.js'));
  assert.match(composicao, /path\.join\(ROOT, 'data', 'crm-catalogs\.json'\)/);
  assert.match(read('.gitignore'), /data\/\*\.json|^data\//m, 'data/*.json segue fora do Git');
});

test('[CATCOMPAT-8] os catálogos NÃO criam registros, clientes, leads nem negociações e não iniciam prospecção: nenhum módulo de catálogo importa o CRM, a fila, a pesquisa ou o Claude', () => {
  const PROIBIDO = /crmDomain|crmService|crmRepository|crmIntegration|approval|prospect|research|claude|discovery|leadEnrichment/i;
  for (const arquivo of arvore('src').filter((f) => /\/catalog[A-Za-z]*\.js$/.test(f) || /crmSupabaseCatalogRepository\.js$/.test(f))) {
    const codigo = semComentarios(read(arquivo));
    const requires = [...codigo.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    for (const alvo of requires) {
      // a ÚNICA exceção: a fábrica dos catálogos reaproveita a leitura de REPOSITORY_MODE da fábrica do CRM (uma só variável para a mesma decisão)
      if (arquivo === 'src/services/catalogRepositoryFactory.js' && alvo === './crmRepositoryFactory') continue;
      assert.doesNotMatch(alvo, PROIBIDO, `${arquivo} importa ${alvo}`);
    }
    // só o adapter Supabase fala com a rede (por um fetch injetável); nenhum processo externo em lugar nenhum
    assert.doesNotMatch(codigo, /child_process|\bspawn\(|\bexec\(|https?:\/\//, `${arquivo}: nenhum processo externo`);
    if (!/crmSupabaseCatalogRepository\.js$/.test(arquivo)) assert.doesNotMatch(codigo, /\bfetch\b/, `${arquivo}: só o adapter Supabase usa fetch`);
  }
  // e dessa fábrica sai SÓ a leitura do modo — nunca o Service, o repositório nem o domínio do CRM
  const fabrica = semComentarios(read('src/services/catalogRepositoryFactory.js'));
  assert.match(fabrica, /const \{ readRepositoryMode, REPOSITORY_MODE \} = require\('\.\/crmRepositoryFactory'\);/);
  assert.equal((fabrica.match(/crmRepositoryFactory/g) || []).length, 1);
  assert.doesNotMatch(fabrica, /createConfiguredCrm|sharedFileCrmRepository|createCrmService/);
  // o contador de uso recebe o repositório do CRM por INJEÇÃO: não importa nada do CRM
  const uso = semComentarios(read('src/services/catalogUsage.js'));
  assert.deepEqual([...uso.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['../crm/catalogConstants', '../crm/catalogDomain']);
});
