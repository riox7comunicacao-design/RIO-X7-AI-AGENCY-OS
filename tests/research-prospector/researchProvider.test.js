// researchProvider.js (Etapa "Prospecção 1"): o contrato ResearchProvider e o provider MANUAL (sem rede, sem IA,
// sem chave de API) — só monta o pacote estruturado que um humano leva ao Claude/Web.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createManualBriefPackageProvider, FINDING_FIELDS, CONFIANCA_VALUES } = require('../../src/research-prospector/researchProvider');
const { validateBriefInput } = require('../../src/research-prospector/prospectingBrief');

const briefCidade = () => validateBriefInput({ nicho: 'Clínicas de estética', subnicho: 'Harmonização facial', nivelGeografico: 'CIDADE', cidades: 'Petrópolis, Teresópolis', quantidade: 50, observacoes: 'Achar potencial para tráfego pago' }).value;

test('[RESEARCH-PROVIDER-1] o provider manual devolve { name, generateBriefPackage() }; nunca faz rede (é síncrono e determinístico para o mesmo brief)', async () => {
  const provider = createManualBriefPackageProvider();
  assert.equal(provider.name, 'manual-claude-web');
  assert.equal(typeof provider.generateBriefPackage, 'function');
  const pacote1 = await provider.generateBriefPackage(briefCidade());
  const pacote2 = await provider.generateBriefPackage(briefCidade());
  assert.deepEqual(pacote1, pacote2);
});

test('[RESEARCH-PROVIDER-2] o pacote preserva fielmente nicho, subnicho, geografia e quantidade do brief — nunca inventa nem troca valores', async () => {
  const provider = createManualBriefPackageProvider();
  const pacote = await provider.generateBriefPackage(briefCidade());
  assert.equal(pacote.nicho, 'Clínicas de estética');
  assert.equal(pacote.subnicho, 'Harmonização facial');
  assert.deepEqual(pacote.localizacao.cidades, ['Petrópolis', 'Teresópolis']);
  assert.equal(pacote.localizacao.resumo, 'Cidade: Petrópolis, Teresópolis');
  assert.equal(pacote.quantidadeDesejada, 50);
  assert.equal(pacote.objetivo, 'Achar potencial para tráfego pago');
});

test('[RESEARCH-PROVIDER-3] sem observações, o objetivo é derivado do nicho — nunca um texto vazio nem inventado sobre a empresa', async () => {
  const brief = validateBriefInput({ nicho: 'Odontologia', nivelGeografico: 'ESTADO', estados: 'RJ', quantidade: 10 }).value;
  const pacote = await createManualBriefPackageProvider().generateBriefPackage(brief);
  assert.match(pacote.objetivo, /Odontologia/);
});

test('[RESEARCH-PROVIDER-4] as regras de dados são explícitas: nunca inventar, e "não encontrei anúncios" nunca vira "não anuncia" (NAO_VERIFICADO, nunca uma afirmação)', async () => {
  const pacote = await createManualBriefPackageProvider().generateBriefPackage(briefCidade());
  const regras = pacote.regrasDeDados.join(' ');
  assert.match(regras, /Nunca invente/);
  assert.match(regras, /NAO_VERIFICADO/);
  assert.match(regras, /nunca significa/i);
});

test('[RESEARCH-PROVIDER-5] o formato esperado repete EXATAMENTE os nomes de campo do finding (o mesmo vocabulário do rawFinding) e os valores de confiança', async () => {
  const pacote = await createManualBriefPackageProvider().generateBriefPackage(briefCidade());
  assert.deepEqual(pacote.formatoEsperado.nomesDosCampos, FINDING_FIELDS);
  assert.deepEqual(pacote.regrasDeConfianca.valores, CONFIANCA_VALUES);
  for (const campo of ['empresa', 'telefone', 'whatsapp', 'decisor_nome', 'confianca', 'fontes']) assert.ok(FINDING_FIELDS.includes(campo), campo);
});

test('[RESEARCH-PROVIDER-6] inclui a regra de exclusão permanente (ex.: "Força Digital") em texto — nunca uma lista real de exclusões (isso não existe ainda no projeto)', async () => {
  const pacote = await createManualBriefPackageProvider().generateBriefPackage(briefCidade());
  assert.ok(pacote.regrasDeExclusao.some((regra) => /exclusão permanente/i.test(regra)));
});
