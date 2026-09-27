// Fronteira CRM / CRM-adapters (decisão 0024, etapa 2.1) — o MESMO par já existente para
// research-prospector/research-adapters (decisão 0022). Mesmo padrão de
// tests/research-adapters/adapters-units.test.js ([ARQ-1]/[ARQ-2]): checagem estrutural direta, por leitura de
// arquivo, complementar às regras genéricas R15/R16 do motor em tests/auth/architecture-boundaries.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyzeSource, toPosix } = require('../helpers/staticImports');

const RAIZ = path.join(__dirname, '..', '..');
const DOMINIO = path.join(RAIZ, 'src', 'crm');
const ADAPTERS = path.join(RAIZ, 'src', 'crm-adapters');

test('[CRMADP-ARQ-1] o domínio (src/crm) NÃO importa src/crm-adapters em nenhum arquivo (comentários podem CITAR a regra em prosa — o que conta é o import de verdade, via analyzeSource)', () => {
  for (const nome of fs.readdirSync(DOMINIO)) {
    const arquivo = path.join(DOMINIO, nome);
    const analise = analyzeSource(fs.readFileSync(arquivo, 'utf8'), toPosix(path.relative(RAIZ, arquivo)));
    for (const ref of analise.refs) assert.doesNotMatch(ref.specifier, /crm-adapters/, `src/crm/${nome} importa ${ref.specifier}`);
  }
});

test('[CRMADP-ARQ-2] src/crm-adapters/ só importa módulos irmãos e node: builtins — NUNCA src/crm/ (R12 já reserva o domínio a src/services/; o adapter guarda sua própria cópia do que precisa, em vez de abrir exceção), nem src/auth, src/services, src/server, dashboard ou tests; sem dependência nova', () => {
  const permitidoIndex = /^\.\/(crmSupabaseConfig|crmSupabaseRepository|crmSupabaseMapping)$/;
  const permitidoIrmao = /^\.\/(crmSupabaseConfig|crmSupabaseMapping)$/;
  for (const nome of fs.readdirSync(ADAPTERS)) {
    const arquivo = path.join(ADAPTERS, nome);
    const analise = analyzeSource(fs.readFileSync(arquivo, 'utf8'), toPosix(path.relative(RAIZ, arquivo)));
    assert.deepEqual(analise.issues, [], nome);
    // O que conta é o IMPORT de verdade (analise.refs) — comentários em prosa podem citar "src/auth",
    // "src/crm" etc. ao explicar a regra, sem que isso seja uma violação (por isso não fazemos grep no texto cru).
    for (const ref of analise.refs) {
      assert.match(ref.specifier, nome === 'index.js' ? permitidoIndex : permitidoIrmao, `${nome} importa ${ref.specifier}`);
      assert.doesNotMatch(ref.specifier, /\.\.\/crm\//, `${nome}: R12 reserva src/crm/ a src/services/ — o adapter não deveria precisar importar de lá`);
    }
  }
  const pacote = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pacote.dependencies), ['@supabase/supabase-js'], 'nenhuma dependência nova');
  assert.equal(pacote.devDependencies, undefined);
});

test('[CRMADP-ARQ-3] a lista própria de campos do adapter (crmSupabaseMapping.js) é IDÊNTICA a CRM_WRITABLE_FIELDS do domínio — o teste (fora de src/, onde R12 não vale) é quem garante que as duas cópias nunca divergem', () => {
  const { CRM_WRITABLE_FIELDS } = require('../../src/crm/constants');
  const { FIELD_COLUMNS } = require('../../src/crm-adapters/crmSupabaseMapping');
  assert.deepEqual(Object.keys(FIELD_COLUMNS), CRM_WRITABLE_FIELDS);
});

test('[CRMADP-ARQ-4] nada de produção (server, services) usa src/crm-adapters/ ainda — a composição real continua só com o arquivo local (comentários podem CITAR "crm-adapters" em prosa; o que conta é um import/uso de verdade)', () => {
  for (const arquivo of ['src/server/index.js', 'src/server/app.js', 'src/server/static.js', 'src/services/crmFileService.js', 'src/services/crmIntegrationFileService.js', 'src/services/prospectingFileService.js', 'src/services/crmRepositoryFactory.js']) {
    const semComentarios = fs.readFileSync(path.join(RAIZ, arquivo), 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(semComentarios, /crm-adapters/, arquivo);
  }
});
