'use strict';

// Fase 2B-3.2B — a GUARDA das Exclusões Permanentes da promoção (src/services/permanentExclusionGuard.js) e a sua composição por modo
// (src/services/prospectingExclusionRepositoryFactory.js#createConfiguredPermanentExclusionGuard).
//
// D1 (modo arquivo): o modo arquivo não tem o serviço operacional — isso é REPRESENTADO por um marcador explícito, nunca por uma consulta
// que "não achou nada" nem por uma dependência opcional esquecida; e o marcador NUNCA vale em REPOSITORY_MODE=supabase. Não há fallback de
// Supabase para arquivo. Sem rede, sem Supabase real, sem arquivo do projeto.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GUARD_MODE, FILE_MODE_UNVERIFIED, FILE_MODE_WARNING, createEnforcedPermanentExclusionGuard, isPermanentExclusionGuard } = require('../../src/services/permanentExclusionGuard');
const { createConfiguredPermanentExclusionGuard, createConfiguredProspectingExclusionService } = require('../../src/services/prospectingExclusionRepositoryFactory');
const { createProspectingExclusionService } = require('../../src/services/prospectingExclusionService');
const { createInMemoryPermanentExclusionRepository } = require('../../src/research-prospector/permanentExclusionRepository');
const { authorizeProspectingExclusionOperation } = require('../../src/auth');

const ENV_SUPABASE = Object.freeze({ REPOSITORY_MODE: 'supabase', SUPABASE_URL: 'https://projeto-de-teste.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-de-teste-nao-real' });
const servicoEmMemoria = () => createProspectingExclusionService({ authorizeOperation: authorizeProspectingExclusionOperation, repository: createInMemoryPermanentExclusionRepository() });

test('[EXCL-GUARD-1] o marcador do modo arquivo é UM objeto congelado e só ele vale — cópias à mão, null, undefined, objetos soltos e vazios não são uma guarda', () => {
  assert.equal(Object.isFrozen(FILE_MODE_UNVERIFIED), true);
  assert.deepEqual(FILE_MODE_UNVERIFIED, { mode: 'FILE_MODE_UNVERIFIED' });
  assert.equal(isPermanentExclusionGuard(FILE_MODE_UNVERIFIED), true);
  for (const invalida of [undefined, null, {}, [], 'sim', 42, true, { mode: 'FILE_MODE_UNVERIFIED' }, { mode: 'ENFORCED' }, { mode: 'ENFORCED', verify: 'não é função' }, { verify: () => {} }]) {
    assert.equal(isPermanentExclusionGuard(invalida), false, JSON.stringify(invalida));
  }
  assert.equal(isPermanentExclusionGuard({ mode: GUARD_MODE.ENFORCED, verify: () => ({}) }), true, 'uma guarda ENFORCED com verify() vale (é o que os testes usam como dublê)');
});

test('[EXCL-GUARD-2] a guarda ENFORCED exige um serviço com verifyCandidate(), captura a função e entrega o veredito do serviço', async () => {
  for (const invalido of [undefined, null, {}, { verifyCandidate: 'x' }, 'texto']) {
    assert.throws(() => createEnforcedPermanentExclusionGuard(invalido), /exige um serviço com verifyCandidate\(\)/);
  }
  const chamadas = [];
  const servico = { verifyCandidate: async (candidato) => { chamadas.push(candidato); return { resultado: 'SEM_CORRESPONDENCIA', exclusaoIds: [] }; } };
  const guarda = createEnforcedPermanentExclusionGuard(servico);
  assert.equal(Object.isFrozen(guarda), true);
  assert.equal(guarda.mode, 'ENFORCED');
  servico.verifyCandidate = async () => { throw new Error('trocado depois'); };
  assert.deepEqual(await guarda.verify({ empresa: 'X' }), { resultado: 'SEM_CORRESPONDENCIA', exclusaoIds: [] }, 'trocar a função depois da criação não muda a guarda');
  assert.deepEqual(chamadas, [{ empresa: 'X' }]);
});

test('[EXCL-GUARD-3] MODO ARQUIVO (REPOSITORY_MODE ausente, vazio ou "file") sem o serviço: o marcador explícito — a MESMA referência', () => {
  for (const env of [{}, { REPOSITORY_MODE: '' }, { REPOSITORY_MODE: '   ' }, { REPOSITORY_MODE: 'file' }, { REPOSITORY_MODE: ' file ' }]) {
    assert.equal(createConfiguredPermanentExclusionGuard({ env, exclusionService: undefined }), FILE_MODE_UNVERIFIED, JSON.stringify(env));
    assert.equal(createConfiguredPermanentExclusionGuard({ env, exclusionService: null }), FILE_MODE_UNVERIFIED, JSON.stringify(env));
  }
});

test('[EXCL-GUARD-4] MODO SUPABASE sem o serviço: ERRO na composição — o marcador do modo arquivo NUNCA é usado em silêncio, e não há fallback para arquivo', () => {
  assert.throws(() => createConfiguredPermanentExclusionGuard({ env: ENV_SUPABASE, exclusionService: undefined }), /REPOSITORY_MODE=supabase exige o serviço de Exclusões Permanentes ligado à promoção/);
  assert.throws(() => createConfiguredPermanentExclusionGuard({ env: ENV_SUPABASE, exclusionService: null }), /marcador do modo arquivo não é permitido/);
  // nenhuma variável de ambiente ou opção contorna isso
  for (const extra of [{ SKIP_EXCLUSIONS: '1' }, { RIO_X7_SKIP_EXCLUSION_CHECK: 'true' }, { DISABLE_PERMANENT_EXCLUSIONS: '1' }, { PERMANENT_EXCLUSIONS: 'off' }]) {
    assert.throws(() => createConfiguredPermanentExclusionGuard({ env: { ...ENV_SUPABASE, ...extra } }), /exige o serviço/, JSON.stringify(extra));
  }
  assert.throws(() => createConfiguredPermanentExclusionGuard({ env: ENV_SUPABASE, exclusionService: undefined, permitirModoArquivo: true }), /exige o serviço/, 'nem uma opção');
});

test('[EXCL-GUARD-5] com o serviço, a guarda é ENFORCED em qualquer modo — inclusive o Supabase configurado de verdade (sem rede na construção)', () => {
  const emMemoria = createConfiguredPermanentExclusionGuard({ env: {}, exclusionService: servicoEmMemoria() });
  assert.equal(emMemoria.mode, 'ENFORCED');
  assert.notEqual(emMemoria, FILE_MODE_UNVERIFIED);
  const servicoSupabase = createConfiguredProspectingExclusionService({ env: ENV_SUPABASE, authorizeOperation: authorizeProspectingExclusionOperation });
  assert.ok(servicoSupabase, 'em REPOSITORY_MODE=supabase a fábrica devolve o serviço');
  const supabase = createConfiguredPermanentExclusionGuard({ env: ENV_SUPABASE, exclusionService: servicoSupabase });
  assert.equal(supabase.mode, 'ENFORCED');
  assert.equal(createConfiguredProspectingExclusionService({ env: {}, authorizeOperation: authorizeProspectingExclusionOperation }), undefined, 'o modo arquivo continua SEM serviço (nenhum terceiro adapter)');
});

test('[EXCL-GUARD-6] um REPOSITORY_MODE inválido também falha na composição da guarda — nunca é tratado como arquivo', () => {
  for (const modo of ['postgres', 'sqlite', 'FILE ', 'Supabase']) {
    assert.throws(() => createConfiguredPermanentExclusionGuard({ env: { REPOSITORY_MODE: modo } }), /REPOSITORY_MODE inválido/, modo);
  }
});

test('[EXCL-GUARD-7] o aviso do modo arquivo diz o que importa: o servidor não verifica as exclusões e a promoção não comprova a ausência delas', () => {
  assert.match(FILE_MODE_WARNING, /REPOSITORY_MODE=file/);
  assert.match(FILE_MODE_WARNING, /NÃO verifica as Exclusões Permanentes na promoção/);
  assert.match(FILE_MODE_WARNING, /não comprova que a empresa não esteja excluída/);
  assert.match(FILE_MODE_WARNING, /REPOSITORY_MODE=supabase/);
});

test('[EXCL-GUARD-8] o marcador só nasce na fábrica de composição: nenhum outro arquivo de src/ o referencia, e nenhuma chave de ambiente o liga', () => {
  const raiz = path.join(__dirname, '..', '..', 'src');
  const arquivos = [];
  (function varrer(dir) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const caminho = path.join(dir, entrada.name);
      if (entrada.isDirectory()) varrer(caminho);
      else if (/\.(js|mjs)$/.test(entrada.name)) arquivos.push(caminho);
    }
  })(raiz);
  const comMarcador = arquivos.filter((a) => /FILE_MODE_UNVERIFIED/.test(fs.readFileSync(a, 'utf8'))).map((a) => path.relative(raiz, a).split(path.sep).join('/')).sort();
  assert.deepEqual(comMarcador, ['services/crmIntegrationService.js', 'services/permanentExclusionGuard.js', 'services/prospectingExclusionRepositoryFactory.js']);
  for (const arquivo of arquivos) {
    const texto = fs.readFileSync(arquivo, 'utf8');
    assert.doesNotMatch(texto, /(?:SKIP|IGNORE|DISABLE|BYPASS)[_A-Z]*EXCLUS|EXCLUS[_A-Z]*(?:SKIP|IGNORE|DISABLE|BYPASS)/, `${path.basename(arquivo)}: nenhuma chave para ignorar a verificação`);
  }
});
