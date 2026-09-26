// FRONTEIRA DE PROVENIÊNCIA (etapa 2.2) — dados de uma fonte de DISCOVERY nunca podem virar evidência de RESEARCH.
//
// NÃO existe camada de Discovery hoje, e estes testes não a simulam nem propõem API: protegem a FRONTEIRA que existe agora, de modo que
// qualquer módulo novo (inclusive o futuro Discovery, onde quer que seja colocado) esbarre aqui e force uma decisão consciente:
//   1. só os importadores atuais podem usar candidate.js, pipeline.js, discovery.js e o index.js do domínio (createCandidate marca
//      "presente = VALIDADO"; discovery.js decide o status das evidências; nenhum dado de fonte pode passar por aí);
//   2. o pipeline legado (runPipeline) não é caminho de produção: nada em src/services/ nem src/server/ o usa;
//   3. o VOCABULÁRIO de achado/evidência (campos, fonte, tipoFonte, observacoesBrutas, dossie) só existe nos módulos que o possuem —
//      um módulo novo que produza ou leia essa estrutura falha aqui (é como a "saída de Discovery com formato de rawFinding" é barrada);
//   4. dado mantido em contexto separado não aparece em campos / fontes / observacoesBrutas / dossie (comportamento atual).
// Para liberar um novo importador ou dono de vocabulário é preciso EDITAR as listas abaixo — de propósito, em revisão.
// Limite conhecido: a análise é estática (tokens); um nome montado em tempo de execução ("cam" + "pos") escaparia, e a estrutura do
// achado/evidência que NÃO usa esses nomes não é reconhecida. tipoFonte = OFICIAL autodeclarado continua sendo débito separado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listSourceFiles, analyzeSource, resolveSpecifier, toPosix } = require('../helpers/staticImports');
const { createResearcher } = require('../../src/research-prospector/researcher');
const { runDiscoveryPipeline } = require('../../src/research-prospector/discovery');
const { validateRawFinding, ERROR } = require('../../src/research-prospector/rawFindingSchema');
const { factsFromFinding } = require('../../src/research-prospector/dossierFromFinding');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RP = 'src/research-prospector';

// Quem PODE importar cada módulo protegido (o estado atual, verificado na auditoria de proveniência).
const IMPORTADORES_PERMITIDOS = Object.freeze({
  [`${RP}/candidate`]: [`${RP}/discovery.js`, `${RP}/index.js`, `${RP}/pipeline.js`],
  [`${RP}/pipeline`]: [`${RP}/index.js`],
  [`${RP}/discovery`]: [`${RP}/batchAccounting.js`, `${RP}/index.js`, `${RP}/rawFindingSchema.js`, 'src/services/crmIntegrationService.js', 'src/services/prospectingService.js'],
  [`${RP}/index`]: [],
});

// Quem PODE conter cada palavra do vocabulário de achado/evidência (como identificador ou texto literal).
const DONOS_DO_VOCABULARIO = Object.freeze({
  tipoFonte: [`${RP}/discovery.js`, `${RP}/dossierFromFinding.js`, `${RP}/rawFindingSchema.js`, `${RP}/researcher.js`],
  observacoesBrutas: [`${RP}/discovery.js`, `${RP}/rawFindingSchema.js`],
  dossie: [`${RP}/rawFindingV2.js`, `${RP}/researcher.js`, 'src/services/prospectingService.js'],
  campos: [`${RP}/discovery.js`, `${RP}/dossierFromFinding.js`, `${RP}/rawFindingSchema.js`, `${RP}/rawFindingV2.js`, `${RP}/researcher.js`],
  fonte: [`${RP}/discovery.js`, `${RP}/dossier.js`, `${RP}/dossierFromFinding.js`, `${RP}/rawFindingSchema.js`, `${RP}/researcher.js`, `${RP}/signalSchema.js`],
});

// Camadas onde o pipeline legado nunca pode aparecer.
const CAMADAS_DE_PRODUCAO = ['src/services/', 'src/server/'];

function loadSrc(root) {
  return listSourceFiles(path.join(root, 'src')).map((file) => {
    const rel = toPosix(path.relative(root, file));
    const analysis = analyzeSource(fs.readFileSync(file, 'utf8'), rel);
    return { rel, ...analysis, refs: analysis.refs.map((ref) => ({ ...ref, resolution: resolveSpecifier(file, ref.specifier, root) })) };
  });
}

// "src/research-prospector" (importar o diretório) é o index.js; a extensão é ignorada.
const normalizeTarget = (targetRel) => {
  const value = targetRel.replace(/\.(?:c|m)?js$/i, '');
  return value === RP ? `${RP}/index` : value;
};

function importersOf(modules, target) {
  return modules
    .filter((mod) => mod.refs.some((ref) => ref.resolution.kind === 'relative' && normalizeTarget(ref.resolution.targetRel) === target))
    .map((mod) => mod.rel)
    .sort();
}

function importerViolations(modules) {
  const out = [];
  for (const [target, allowed] of Object.entries(IMPORTADORES_PERMITIDOS)) {
    for (const rel of importersOf(modules, target)) if (!allowed.includes(rel)) out.push({ rule: 'IMPORTADOR', file: rel, target });
  }
  return out;
}

function vocabularyViolations(modules) {
  const out = [];
  for (const [word, owners] of Object.entries(DONOS_DO_VOCABULARIO)) {
    for (const mod of modules) {
      if (owners.includes(mod.rel)) continue;
      if (mod.tokens.some((token) => (token.type === 'id' || token.type === 'str') && token.value === word)) out.push({ rule: 'VOCABULARIO', file: mod.rel, word });
    }
  }
  return out;
}

function legacyPipelineViolations(modules) {
  const out = [];
  for (const mod of modules) {
    if (!CAMADAS_DE_PRODUCAO.some((prefix) => mod.rel.startsWith(prefix))) continue;
    if (mod.tokens.some((token) => token.type === 'id' && token.value === 'runPipeline')) out.push({ rule: 'RUNPIPELINE', file: mod.rel, detail: 'usa o identificador runPipeline' });
    for (const ref of mod.refs) {
      if (ref.resolution.kind !== 'relative') continue;
      const target = normalizeTarget(ref.resolution.targetRel);
      if (target === `${RP}/pipeline` || target === `${RP}/index`) out.push({ rule: 'RUNPIPELINE', file: mod.rel, detail: `importa ${target}` });
    }
  }
  return out;
}

const fmt = (violations) => violations.map((v) => `${v.rule}: ${v.file}${v.target ? ` importa ${v.target}` : ''}${v.word ? ` usa "${v.word}"` : ''}${v.detail ? ` (${v.detail})` : ''}`).join('\n');
const SRC = loadSrc(REPO_ROOT);

// ---------------------------------------------------------------------------------------------------------------------------------
test('[FRO-1] só os importadores atuais usam candidate.js, pipeline.js, discovery.js e o index.js do domínio (um Discovery futuro não pode)', () => {
  const violations = importerViolations(SRC);
  assert.deepEqual(violations, [], `importador novo de módulo protegido — decisão arquitetural necessária:\n${fmt(violations)}`);
  // o mapa não ficou obsoleto: cada módulo protegido existe
  for (const target of Object.keys(IMPORTADORES_PERMITIDOS)) assert.ok(fs.existsSync(path.join(REPO_ROOT, `${target}.js`)), `${target}.js`);
});

test('[FRO-2] o pipeline legado runPipeline não é caminho de produção: nada em src/services/ nem src/server/ o usa ou importa pipeline.js / o index do domínio', () => {
  const violations = legacyPipelineViolations(SRC);
  assert.deepEqual(violations, [], fmt(violations));
  // e a produção usa, de fato, o pipeline de discovery (a âncora do teste: se este import sumir, o teste acima não estaria olhando o lugar certo)
  const service = SRC.find((mod) => mod.rel === 'src/services/prospectingService.js');
  assert.ok(service && importersOf(SRC, `${RP}/discovery`).includes(service.rel));
  assert.ok(service.tokens.some((token) => token.type === 'id' && token.value === 'runDiscoveryPipeline'));
});

test('[FRO-3] o vocabulário de achado/evidência (campos, fonte, tipoFonte, observacoesBrutas, dossie) só existe nos módulos que o possuem', () => {
  const violations = vocabularyViolations(SRC);
  assert.deepEqual(violations, [], `módulo novo com a estrutura de rawFinding/evidência — Discovery não pode produzir isto:\n${fmt(violations)}`);
});

test('[FRO-4] os detectores de fronteira funcionam: um módulo novo que importa o pipeline/candidate/discovery/index e usa o vocabulário é pego (árvore temporária)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-fronteira-'));
  try {
    const write = (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    };
    for (const name of ['candidate', 'pipeline', 'discovery', 'index']) write(`${RP}/${name}.js`, 'module.exports = {};\n');
    write('src/algo-novo/usa.js', "const a = require('../research-prospector/candidate');\nconst b = require('../research-prospector/pipeline');\nconst c = require('../research-prospector/discovery.js');\nconst d = require('../research-prospector');\nmodule.exports = { a, b, c, d };\n");
    write('src/algo-novo/forma.js', "module.exports = { campos: { telefone: [{ valor: '1', fonte: 'x', tipoFonte: 'OFICIAL' }] }, observacoesBrutas: 'x', dossie: {} };\n");
    write('src/services/legado.js', "const { runPipeline } = require('../research-prospector/pipeline');\nrunPipeline({});\n");
    write('src/services/limpo.js', "const x = require('../research-prospector/rawFindingV2');\nmodule.exports = x;\n");
    const modules = loadSrc(root);

    const importers = importerViolations(modules);
    assert.deepEqual(importers.map((v) => `${v.file} -> ${v.target}`).sort(), [
      `src/algo-novo/usa.js -> ${RP}/candidate`,
      `src/algo-novo/usa.js -> ${RP}/discovery`,
      `src/algo-novo/usa.js -> ${RP}/index`,
      `src/algo-novo/usa.js -> ${RP}/pipeline`,
      `src/services/legado.js -> ${RP}/pipeline`,
    ]);
    const vocab = vocabularyViolations(modules);
    assert.deepEqual([...new Set(vocab.filter((v) => v.file === 'src/algo-novo/forma.js').map((v) => v.word))].sort(), ['campos', 'dossie', 'fonte', 'observacoesBrutas', 'tipoFonte']);
    assert.ok(!vocab.some((v) => v.file === 'src/services/limpo.js'));
    const legacy = legacyPipelineViolations(modules);
    assert.deepEqual([...new Set(legacy.map((v) => v.file))], ['src/services/legado.js']);
    assert.ok(legacy.some((v) => v.detail === 'usa o identificador runPipeline') && legacy.some((v) => v.detail === `importa ${RP}/pipeline`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Contexto externo mantido SEPARADO: nada dele aparece por conta própria no achado. (Constantes de teste: sem catálogo, sem adaptador.)
const CONTEXTO_EXTERNO = Object.freeze({ nome: 'Marca Externa Zeta', telefone: '21988880001', site: 'https://catalogo-externo.example.test/zeta', origem: 'FONTE-EXTERNA-ZETA' });
const MARCAS = [CONTEXTO_EXTERNO.nome, CONTEXTO_EXTERNO.telefone, CONTEXTO_EXTERNO.site, CONTEXTO_EXTERNO.origem, 'catalogo-externo'];
const contemMarca = (value) => MARCAS.filter((marca) => JSON.stringify(value).includes(marca));

const SITE = 'https://alfa-teste.example.test/';
const BUSCA = 'https://busca.example.test/resultados';
const portas = (chamadas) => ({
  search: async (arg) => {
    chamadas.push(arg);
    return { ok: true, resultados: [{ nome: 'Clínica Alfa Teste', url: SITE, tipoResultado: 'SITE', fonteUrl: BUSCA, cidade: 'Petrópolis', estado: 'RJ' }] };
  },
  fetchPage: async () => ({ ok: true, urlFinal: SITE, links: [{ href: 'tel:+552433331111' }], temFormularioContato: false }),
});

test('[FRO-5] contexto externo separado NÃO aparece em campos / fontes / observacoesBrutas / dossie do achado do Researcher (nem nas portas)', async () => {
  const chamadas = [];
  const researcher = createResearcher(portas(chamadas), { now: () => new Date('2026-09-25T15:00:00.000Z') });
  // o contexto viaja "ao lado" do briefing (chave desconhecida) e em variáveis do teste: o Researcher só lê as chaves que conhece
  const saida = await researcher.research({ nicho: 'Psicologia', quantidadeDesejada: 1, regiao: 'Petrópolis/RJ', contextoExterno: CONTEXTO_EXTERNO });
  assert.equal(saida.ok, true, JSON.stringify(saida.erro));
  assert.ok(saida.achados.length >= 1);
  for (const achado of saida.achados) {
    assert.ok(achado.campos && Object.keys(achado.campos).length > 0, 'o achado tem evidências de Research (a âncora do teste)');
    for (const parte of ['campos', 'fontes', 'observacoesBrutas', 'dossie']) assert.deepEqual(contemMarca(achado[parte] === undefined ? null : achado[parte]), [], `achado.${parte}`);
    assert.deepEqual(contemMarca(achado), [], 'o achado inteiro');
  }
  assert.deepEqual(contemMarca(chamadas), [], 'a porta de busca também não recebe o contexto');
  assert.deepEqual(contemMarca(saida.relatorio), [], 'nem o relatório');
});

test('[FRO-6] o achado válido não aceita o contexto por chave nova (o schema o recusa) e o pipeline de discovery e o dossiê IGNORAM uma chave estranha', () => {
  const base = { empresa: 'Clínica Alfa Teste', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', campos: { site: [{ valor: SITE, fonte: 'Site oficial', tipoFonte: 'OFICIAL', url: SITE, dataConsulta: '2026-09-25' }] } };
  // 1) pela porta de entrada (schema): a chave nova é recusada, não repassada
  for (const chave of ['contextoExterno', 'discoveryRef', 'origemExterna']) {
    const resultado = validateRawFinding({ ...base, [chave]: CONTEXTO_EXTERNO }, { now: new Date('2026-09-25T15:00:00.000Z') });
    assert.equal(resultado.ok, false, chave);
    assert.ok(resultado.errors.some((e) => e.code === ERROR.CAMPO_DESCONHECIDO && e.path === chave), chave);
  }
  // 2) se uma chave estranha chegasse às funções de domínio (sem o schema), a saída NÃO a carrega
  const comContexto = { ...base, contextoExterno: CONTEXTO_EXTERNO };
  const { resultados } = runDiscoveryPipeline({ briefing: { nicho: 'Psicologia', quantidadeDesejada: 1 }, rawFindings: [comContexto], crmRecords: [] });
  assert.equal(resultados.length, 1);
  assert.deepEqual(contemMarca(resultados[0]), [], 'saída do discovery');
  assert.deepEqual(contemMarca(factsFromFinding(comContexto, '2026-09-25')), [], 'fatos do dossiê');
  // 3) e o resultado é idêntico ao do mesmo achado SEM o contexto: ele não muda status nem valor de nenhum campo
  const semContexto = runDiscoveryPipeline({ briefing: { nicho: 'Psicologia', quantidadeDesejada: 1 }, rawFindings: [base], crmRecords: [] }).resultados[0];
  assert.deepEqual(resultados[0], semContexto);
});
