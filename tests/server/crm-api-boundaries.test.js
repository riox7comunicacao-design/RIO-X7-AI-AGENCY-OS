// Fronteiras arquiteturais da API do CRM (decisão 0015).
//
//   Dashboard -> HTTP -> API (src/server) -> CRM Service (src/services) -> CRM Domain (src/crm) -> porta -> adapter
//
// tests/auth/architecture-boundaries.test.js já barra, no grafo inteiro, que qualquer coisa fora de src/services importe
// src/crm (R12), que o servidor importe research-prospector (R10) e que o Dashboard importe src/ (R11). Estes testes
// travam o que é específico da API do CRM, no mesmo estilo de CRM-SVC-7: a lista de importações de cada arquivo é FECHADA
// (uma importação nova exige mudar este teste — de propósito), e a API não contém nenhuma peça de autorização nem de
// regra do domínio: quem autoriza é só o CRM Service.
//
// A prova de comportamento — a API entrega ao Service o AuthorizationContext emitido, sem decidir nada antes — está em
// tests/server/crm-api.test.js ([CRM-API-34]).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyzeSource } = require('../helpers/staticImports');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function analisar(rel) {
  return analyzeSource(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), rel);
}

const identificadoresDe = (analise) => new Set(analise.tokens.filter((token) => token.type === 'id').map((token) => token.value));
const textosDe = (analise) => analise.tokens.filter((token) => token.type === 'str' || token.type === 'tpl').map((token) => token.value);

test('[CRM-API-ARCH-1] o adaptador HTTP (app.js) só importa o barrel de src/auth e o servidor de estáticos: nunca src/services, nunca src/crm, nunca um adapter', () => {
  const analise = analisar('src/server/app.js');
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(analise.refs.map((ref) => ref.specifier).sort(), ['../auth', './static']);
});

test('[CRM-API-ARCH-2] o adaptador HTTP não tem NENHUMA peça de autorização do CRM nem regra do domínio: não conhece permissões, roles, statuses, campos, deduplicação, DNC, adapters nem a fábrica do Service', () => {
  const analise = analisar('src/server/app.js');
  const identificadores = identificadoresDe(analise);
  for (const proibido of [
    'hasPermission',
    'requirePermission',
    'PERMISSION',
    'ROLE',
    'ROLE_PERMISSION_TEMPLATE',
    'authorizeCrmOperation',
    'authorizeReviewerForApprovalQueue',
    'createCrmService',
    'createFileBackedCrmService',
    'createJsonFileCrmRepository',
    'createInMemoryCrmRepository',
    'CRM_STATUS',
    'PIPELINE_STATUSES',
    'ALLOWED_TRANSITIONS',
    'CRM_WRITABLE_FIELDS',
    'CRM_MANAGED_FIELDS',
    'checkDuplicate',
    'checkDoNotContact',
    'assertValidRepository',
  ]) {
    assert.equal(identificadores.has(proibido), false, `a API não pode usar ${proibido}: essa decisão é do Service/domínio`);
  }
  const textos = textosDe(analise).join('\n');
  for (const proibido of ['READ:CRM', 'WRITE:CRM', 'ANALYZE:CRM', 'PROPOSE:CRM', 'MANAGE:USERS', 'COMMERCIAL_CLOSER', 'DO_NOT_CONTACT', 'QUALIFIED_PROSPECT', 'MEETING_SCHEDULED']) {
    assert.ok(!textos.includes(proibido), `a API não pode conter o literal "${proibido}"`);
  }
  for (const literal of ['ADMIN', 'SYSTEM', 'PROSPECT', 'WON', 'LOST']) {
    assert.ok(!textosDe(analise).includes(literal), `a API não pode conter o literal exato "${literal}"`);
  }
});

test('[CRM-API-ARCH-3] a raiz de composição só chama a fábrica de src/services e passa um CAMINHO: nenhum adapter, nenhum Service construído à mão, nenhum domínio', () => {
  const analise = analisar('src/server/index.js');
  assert.deepEqual(analise.issues, []);
  assert.deepEqual(
    analise.refs.map((ref) => ref.specifier).sort(),
    ['../auth', '../services/approvalQueueService', '../services/crmFileService', '../services/crmIntegrationFileService', './app', 'node:fs', 'node:http', 'node:path']
  );
  const identificadores = identificadoresDe(analise);
  for (const proibido of ['createCrmService', 'createJsonFileCrmRepository', 'createInMemoryCrmRepository', 'assertValidRepository', 'crmDomain']) {
    assert.equal(identificadores.has(proibido), false, `a composição não pode usar ${proibido}`);
  }
  assert.equal(identificadores.has('createFileBackedCrmService'), true);
  assert.equal(identificadores.has('authorizeCrmOperation'), true, 'o autorizador real é injetado pela composição');
});

test('[CRM-API-ARCH-4] a composição injeta o autorizador de src/auth e o caminho do arquivo — e o app recebe o Service pronto (não há um segundo caminho até o domínio)', () => {
  const codigo = fs.readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf8');
  assert.match(codigo, /createFileBackedCrmService\(\{\s*authorizeOperation: authorizeCrmOperation,\s*filePath: resolveFile\(env\.RIO_X7_CRM_PATH, DEFAULT_CRM_FILE\),?\s*\}\)/);
  assert.match(codigo, /createApp\(\{[^}]*\bcrmService,/);
  assert.match(codigo, /createApp\(\{[^}]*\bcrmIntegrationService,/);
});
