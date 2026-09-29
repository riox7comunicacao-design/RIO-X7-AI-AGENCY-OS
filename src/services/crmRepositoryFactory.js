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
//     deveria saber que o outro existe; ver R16, que proíbe o inverso). Por isso este arquivo — e só ele, em
//     src/services/ — pode importar src/crm-adapters/ (etapa 3H): decidir ENTRE adapters é exatamente a
//     responsabilidade de uma fábrica de composição, nunca de src/server/ nem dos outros arquivos de
//     src/services/ (crmFileService.js/crmIntegrationFileService.js/prospectingFileService.js continuam sem
//     conhecer o Supabase — tests/crm-adapters/architecture.test.js [CRMADP-ARQ-4] vigia isso).
// Mesmo lugar, mesmo raciocínio de crmFileService.js/crmIntegrationFileService.js/prospectingFileService.js.
//
// REPOSITORY_MODE (etapa 2.3; caminho Supabase real implementado na etapa 3H):
//   ausente ou "file"    -> o adapter de arquivo de sempre (crmFileService.js), SEM NENHUMA mudança de
//                           comportamento para quem não configurou nada. NÃO exige SUPABASE_SERVICE_ROLE_KEY —
//                           essa variável não tem nada a ver com este modo.
//   "supabase"           -> monta createSupabaseCrmRepository() de verdade, com a configuração lida de `env`
//                           (readSupabaseCrmConfig, de src/crm-adapters/crmSupabaseConfig.js — exige AS DUAS
//                           variáveis, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY; lança citando só o NOME da que
//                           faltar, nunca um valor). Se a configuração estiver ausente ou inválida, a fábrica
//                           FALHA — nunca cai para "file" em silêncio (seria o fallback silencioso explicitamente
//                           proibido). D-CONCURRENCY-PORT, `on_conflict` explícito e proteção multi-processo
//                           continuam FORA do escopo desta etapa (docs/decisions/0024, seção 11/12) — a auditoria
//                           da etapa 3G concluiu que nenhum dos três é um BLOCKER para uma primeira ativação de
//                           processo único; nenhum foi implementado aqui.
//   qualquer outro valor -> erro claro (nunca tratado como "file" por padrão silencioso).
//
// NENHUMA chamada de rede acontece SÓ POR CONFIGURAR — "file" só monta o adapter de arquivo (preguiçoso — só lê/
// escreve quando uma operação roda); "supabase" monta um repositório que também só fala com a rede quando
// list()/getById()/save() forem chamados (o mesmo desenho preguiçoso do adapter Supabase — ver
// crmSupabaseRepository.js). Nada aqui ou em createSupabaseCrmRepository() chama a rede na hora de CRIAR o
// repositório — só um `fetch` de verdade, feito por uma OPERAÇÃO, tocaria a rede.
//
// INSTÂNCIA ÚNICA (decisão 0023 — a serialização de escrita em crmDomain.js é por OBJETO repositório): no modo
// "file", resolvida via crmFileService.js (sharedFileCrmRepository, por caminho — decisão 2.3). No modo
// "supabase", resolvida por sharedSupabaseCrmRepository() abaixo (etapa 3H, por configuração — mesmo padrão,
// mesmo motivo): sem isso, createConfiguredCrmService() (para o CRM direto) e as fábricas de arquivo de promoção/
// prospecção — que hoje recebem o `crmService` PRONTO, injetado por quem compõe (etapa 3F) — continuariam
// seguras entre si (compartilham o MESMO objeto por injeção), mas duas chamadas SEPARADAS a
// createConfiguredCrmRepository()/createConfiguredCrmService() para a MESMA configuração Supabase (ex.: um script
// futuro, um teste, uma segunda composição) criariam dois repositórios INDEPENDENTES — reabrindo exatamente o
// risco que a etapa 2.3/3F já corrigiu para o arquivo, mas agora do lado do Supabase.

const crypto = require('node:crypto');

const { sharedFileCrmRepository } = require('./crmFileService');
const { createCrmService } = require('./crmService');
const { createSupabaseCrmRepository } = require('../crm-adapters/crmSupabaseRepository');
const { readSupabaseCrmConfig } = require('../crm-adapters/crmSupabaseConfig');

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

// CACHE do repositório Supabase, por CONFIGURAÇÃO (etapa 3H — mesmo papel de sharedFileCrmRepository, que cacheia
// por CAMINHO). Chaveado por `url` (não é segredo) + um HASH SHA-256 de `serviceRoleKey` — nunca a chave em texto
// puro: mesmo que este Map aparecesse inteiro num dump de memória, num log de depuração ou num `console.log`
// acidental de suas chaves, a service_role original não seria recuperável a partir daqui (SHA-256 não é
// reversível). O hash só serve para DISTINGUIR configurações — duas chamadas com a MESMA url e a MESMA chave
// caem na mesma entrada; url igual com chave DIFERENTE (ex.: girar a credencial, ou dois projetos por engano)
// nunca compartilha o repositório de outra configuração. `createSupabaseCrmRepository()` em si não ganhou
// nenhum estado mutável nem deixou de ser `Object.freeze()`d — o cache é só um `Map` NESTE módulo, por fora do
// adapter, exatamente como sharedFileCrmRepository já faz para o arquivo.
const supabaseRepositoriesByConfig = new Map();
function supabaseConfigCacheKey(config) {
  const hashDaChave = crypto.createHash('sha256').update(config.serviceRoleKey).digest('hex');
  return `${config.url}\u0000${hashDaChave}`;
}
function sharedSupabaseCrmRepository(config) {
  const chave = supabaseConfigCacheKey(config);
  let repository = supabaseRepositoriesByConfig.get(chave);
  if (!repository) {
    repository = createSupabaseCrmRepository({ url: config.url, serviceRoleKey: config.serviceRoleKey });
    supabaseRepositoriesByConfig.set(chave, repository);
  }
  return repository;
}

// { env } (padrão process.env): de onde ler REPOSITORY_MODE (e, no modo supabase, SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY). { filePath }: obrigatório SÓ no modo "file" (o caminho é escolhido por quem compõe,
// nunca por um padrão escondido — mesmo princípio de crmFileService.js). Devolve o REPOSITÓRIO puro (list/getById/
// save) — mesma porta de src/crm/crmRepositoryPort.js, em QUALQUER modo (o Port não muda — regra desta etapa).
function createConfiguredCrmRepository({ env = process.env, filePath } = {}) {
  const modo = readRepositoryMode(env);
  if (modo === REPOSITORY_MODE.SUPABASE) {
    // readSupabaseCrmConfig lança um erro claro citando só o NOME da variável ausente (SUPABASE_URL ou
    // SUPABASE_SERVICE_ROLE_KEY) — nunca um valor, nunca uma mensagem genérica. Sem fallback: se a configuração
    // faltar ou for inválida, a fábrica FALHA aqui, antes de qualquer tentativa de montar o repositório.
    const config = readSupabaseCrmConfig(env);
    return sharedSupabaseCrmRepository(config);
  }
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('createConfiguredCrmRepository (REPOSITORY_MODE=file) exige { filePath } (texto não vazio): o caminho é escolhido por quem compõe.');
  }
  return sharedFileCrmRepository(filePath);
}

// Como acima, mas devolve o CRM Service já autorizado (o que src/server/index.js precisa). Reaproveita
// createConfiguredCrmRepository() para a escolha de modo (nunca duplica a lógica de seleção) — só acrescenta a
// camada de autorização por cima, com createCrmService (a MESMA usada pelo modo file, via crmFileService.js;
// aqui chamada diretamente para que os dois modos passem pelo mesmo caminho de composição).
// hasActiveFunnelCards (opcional, Etapa "Funis 2 — correção final"): repassada intacta — ver o cabeçalho de
// crmService.js. Vale nos dois modos (file e supabase): é uma checagem de APLICAÇÃO, antes do repositório, e não
// depende de qual adapter o CRM usa.
function createConfiguredCrmService({ env = process.env, authorizeOperation, filePath, hasActiveFunnelCards } = {}) {
  const repository = createConfiguredCrmRepository({ env, filePath });
  return createCrmService({ authorizeOperation, repository, hasActiveFunnelCards });
}

module.exports = { REPOSITORY_MODE, readRepositoryMode, createConfiguredCrmRepository, createConfiguredCrmService, sharedSupabaseCrmRepository };
