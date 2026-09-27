// Fábrica do REPOSITÓRIO/Service do CRM POR MODO (REPOSITORY_MODE) — a peça de composição que a raiz
// (src/server/index.js) usa para decidir a persistência, sem nunca importar o domínio (src/crm) nem os adapters
// (src/crm-adapters) diretamente (regra R12: só src/services importa src/crm; nada em src/server pode).
//
//   src/server/index.js -> createConfiguredCrmService({ env, authorizeOperation, filePath }) -> o CRM Service pronto
//
// POR QUE FICA EM src/services/ (decisão da etapa 2.3, e não em src/server/ nem em src/crm-adapters/):
//   - é exatamente o mesmo papel que crmFileService.js já cumpre ("transformar uma CONFIGURAÇÃO num repositório/
//     Service pronto"), e esse papel já mora em src/services/ por decisão 0015;
//   - src/server/ nunca pode importar src/crm nem src/crm-adapters diretamente (R10/R12: só src/services pode) —
//     colocar esta fábrica em src/server/ exigiria abrir uma exceção nova nessas regras só para repetir o que
//     src/services/ já faz;
//   - src/crm-adapters/ é INFRAESTRUTURA de UM adapter (Supabase) — decidir ENTRE adapters (file vs. Supabase) é
//     uma decisão de COMPOSIÇÃO da aplicação, não responsabilidade de um adapter sobre o outro (um adapter nunca
//     deveria saber que o outro existe; ver R16, que proíbe o inverso).
// Mesmo lugar, mesmo raciocínio de crmFileService.js/crmIntegrationFileService.js/prospectingFileService.js.
//
// REPOSITORY_MODE (nova variável, etapa 2.3):
//   ausente ou "file"    -> o adapter de arquivo de sempre (crmFileService.js), SEM NENHUMA mudança de
//                           comportamento para quem não configurou nada. NÃO exige SUPABASE_SERVICE_ROLE_KEY —
//                           essa variável não tem nada a ver com este modo.
//   "supabase"           -> BLOQUEADO nesta etapa, SEMPRE — mesmo com SUPABASE_SERVICE_ROLE_KEY presente e
//                           válida. "Preparar a composição" (o pedido desta etapa) é diferente de "ativar": o
//                           adapter Supabase (src/crm-adapters/) já existe e já foi auditado (decisões 0024,
//                           etapas 2/2.1/2.2), mas ligá-lo de verdade depende de decisões ainda pendentes
//                           (D-CONCURRENCY-PORT, tradução de erro HTTP, on_conflict explícito — ver
//                           docs/decisions/0024, seção 11) que esta etapa NÃO resolve. O bloqueio é
//                           INCONDICIONAL: nunca cai para "file" em silêncio (seria o fallback silencioso
//                           explicitamente proibido) — SEMPRE lança, com uma mensagem que diz o motivo.
//   qualquer outro valor -> erro claro (nunca tratado como "file" por padrão silencioso).
//
// NENHUMA chamada de rede acontece aqui, em nenhum modo: "file" só monta o adapter de arquivo (preguiçoso — só
// lê/escreve quando uma operação roda); "supabase" nem chega a montar nada, porque lança antes.
//
// INSTÂNCIA ÚNICA (decisão 0023 — a serialização de escrita em crmDomain.js é por OBJETO repositório): o modo
// "file" é resolvido através de crmFileService.js, que reaproveita o MESMO objeto repositório por caminho
// (sharedFileCrmRepository) — então createConfiguredCrmService()/createConfiguredCrmRepository() aqui, e
// createFileBackedCrmService() chamado por crmIntegrationFileService.js/prospectingFileService.js, para o MESMO
// filePath, sempre apontam para o repositório IDÊNTICO. Ver crmFileService.js para o porquê disso ser seguro
// mesmo sem mudar o adapter de arquivo (que não tem estado: cada operação já relê o disco).

const { createFileBackedCrmService, sharedFileCrmRepository } = require('./crmFileService');

const REPOSITORY_MODE = Object.freeze({ FILE: 'file', SUPABASE: 'supabase' });
const VALID_MODES = Object.freeze(Object.values(REPOSITORY_MODE));

// Lê e valida REPOSITORY_MODE do ambiente. Nunca lança para um valor AUSENTE (o padrão é "file", o comportamento
// de sempre); lança para qualquer valor PRESENTE que não seja um modo válido — nunca trata um typo como "file".
function readRepositoryMode(env = process.env) {
  const raw = env && typeof env.REPOSITORY_MODE === 'string' ? env.REPOSITORY_MODE.trim() : '';
  if (raw === '') return REPOSITORY_MODE.FILE;
  if (!VALID_MODES.includes(raw)) {
    throw new Error(`REPOSITORY_MODE inválido: "${raw}" (use "${REPOSITORY_MODE.FILE}" ou "${REPOSITORY_MODE.SUPABASE}").`);
  }
  return raw;
}

function assertModeIsFile(mode) {
  if (mode === REPOSITORY_MODE.SUPABASE) {
    throw new Error(
      'REPOSITORY_MODE=supabase ainda não está habilitado nesta versão: o adapter Postgres/Supabase do CRM ' +
        '(pasta de adapters já auditada) existe, mas ligá-lo depende de decisões ainda pendentes ' +
        '(docs/decisions/0024-crm-postgres-schema.md, seção 11 — concorrência entre instâncias, tradução de erro ' +
        'HTTP, on_conflict explícito). Use REPOSITORY_MODE=file (o padrão) até uma etapa futura decidir e validar ' +
        'a ativação — não há atalho nem fallback automático para "file" quando "supabase" é pedido explicitamente.'
    );
  }
}

// { env } (padrão process.env): de onde ler REPOSITORY_MODE. { filePath }: obrigatório SÓ no modo "file" (o
// caminho é escolhido por quem compõe, nunca por um padrão escondido — mesmo princípio de crmFileService.js).
// Devolve o REPOSITÓRIO puro (list/getById/save) — mesma porta de src/crm/crmRepositoryPort.js.
function createConfiguredCrmRepository({ env = process.env, filePath } = {}) {
  assertModeIsFile(readRepositoryMode(env));
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createConfiguredCrmRepository (REPOSITORY_MODE=file) exige { filePath } (texto não vazio): o caminho é escolhido por quem compõe.');
  }
  return sharedFileCrmRepository(filePath);
}

// Como acima, mas devolve o CRM Service já autorizado (o que src/server/index.js precisa) — mesmo modo, mesma
// validação, mesmo repositório compartilhado por trás.
function createConfiguredCrmService({ env = process.env, authorizeOperation, filePath } = {}) {
  assertModeIsFile(readRepositoryMode(env));
  return createFileBackedCrmService({ authorizeOperation, filePath });
}

module.exports = { REPOSITORY_MODE, readRepositoryMode, createConfiguredCrmRepository, createConfiguredCrmService };
