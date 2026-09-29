// Adaptador HTTP do Dashboard — a ÚNICA porta de entrada do navegador para o Approval Queue Service e o CRM Service.
//
//   navegador (dashboard/) -> HTTP /api/* -> ESTE MÓDULO -> Auth -> AuthorizationContext -> Approval Queue Service | CRM Service
//
// O navegador só fala HTTP. Este módulo não decide regra de negócio nem de permissão: ele autentica quem chama,
// monta o AuthorizationContext pelo fluxo já existente de src/auth, valida a FORMA da requisição, chama o Service
// e traduz o resultado (ou o erro) em HTTP. Quem autoriza é o Service — na fila, e de novo o domínio; no CRM o Service
// é a ÚNICA camada de autorização (decisão 0014), e por isso este módulo nunca chega ao domínio do CRM (regra R12):
// recebe o Service pronto, por injeção, e só chama os métodos dele.
//
// ROTAS (só estas; qualquer outra rota de /api é 404):
//   GET  /api/me                        a projeção segura do usuário autenticado
//   GET  /api/approvals[?estado=]       a fila (por padrão, AGUARDANDO_REVISAO)
//   POST /api/approvals/:id/approve     corpo { reason? }
//   POST /api/approvals/:id/reject      corpo { reason }   (motivo obrigatório)
// CRM (decisão 0015) — só existem quando o CRM Service é injetado; sem ele, /api/crm... é 404:
//   GET   /api/crm                      os registros                                    -> 200 { items }
//   POST  /api/crm                      cria; corpo = campos do registro + { status?, reason? } -> 201 { item, duplicidade }
//   GET   /api/crm/:id                  um registro                                     -> 200 { item }
//   PATCH /api/crm/:id                  edita campos; corpo = só os campos a mudar      -> 200 { item }
//   GET   /api/crm/:id/history          o histórico do registro                         -> 200 { historico }
//   POST  /api/crm/:id/status           muda o status; corpo { to, reason? }            -> 200 { item }
//   POST  /api/crm/:id/dnc              marca DO_NOT_CONTACT; corpo { reason? }         -> 200 { item }
//   DELETE /api/crm/:id                 exclusão ADMINISTRATIVA e IRREVERSÍVEL (decisão 0025); corpo { reason }
//                                        (motivo OBRIGATÓRIO; só DELETE:CRM, hoje só ADMIN)  -> 200 { deleted: true, id }
// Funis (reestruturação Prospecção/CRM/Funis, Etapa "Funis 1") — só existem quando o Funnel Service é injetado;
// sem ele, /api/funnels... e /api/funnel-stages/:id são 404. Requer MANAGE:FUNNELS (hoje só ADMIN):
//   GET    /api/funnels                       os funis, em ordem                              -> 200 { items }
//   POST   /api/funnels                       cria; corpo { nome, descricao?, finalidade?, config? } -> 201 { item }
//   POST   /api/funnels/reorder                corpo { orderedIds: [...] }                     -> 200 { items }
//   GET    /api/funnels/:id                    um funil                                        -> 200 { item }
//   PATCH  /api/funnels/:id                    edita; corpo = só os campos a mudar              -> 200 { item }
//   DELETE /api/funnels/:id                    recusa se houver cards vinculados (409)          -> 200 { deleted: true, id }
//   POST   /api/funnels/:id/copy               corpo { nome? }; NUNCA copia cards/histórico     -> 201 { item }
//   GET    /api/funnels/:id/stages             as etapas do funil, em ordem                     -> 200 { items }
//   POST   /api/funnels/:id/stages             cria; corpo { nome, ativo?, config? }             -> 201 { item }
//   POST   /api/funnels/:id/stages/reorder     corpo { orderedIds: [...] }                       -> 200 { items }
//   PATCH  /api/funnel-stages/:id              edita; corpo = só os campos a mudar               -> 200 { item }
//   DELETE /api/funnel-stages/:id              recusa se houver cards vinculados (409)           -> 200 { deleted: true, id }
// Card (Etapa "Funis 2" — a posição comercial de um registro do CRM dentro de um funil). Ler exige READ:CRM;
// criar/mover exige PROPOSE:CRM (ADMIN e COMMERCIAL_CLOSER); arquivar exige WRITE:CRM (só ADMIN):
//   GET    /api/funnels/:id/cards              os cards ATIVOS do funil, enriquecidos com dados do CRM -> 200 { items }
//   POST   /api/funnels/:id/cards              corpo { crmRecordId, reason? }                    -> 201 { item }
//   GET    /api/funnel-cards/:id               um card                                           -> 200 { item }
//   PATCH  /api/funnel-cards/:id               move; corpo { stageId, reason? }                  -> 200 { item }
//   GET    /api/funnel-cards/:id/history       histórico de movimentação (append-only)            -> 200 { historico }
//   DELETE /api/funnel-cards/:id               ARQUIVA (nunca apaga; nunca afeta o CRM Record)     -> 200 { deleted: true, id }
// Não há filtro nem busca (além do funil) nesta etapa: o Service não os tem, e a API não inventa operação.
// Tudo fora de /api é arquivo estático (ver static.js).
//
// PIPELINE de toda rota de /api, sempre nesta ordem:
//   1. rota e método existem?                        (404 / 405)
//   2. Authorization: Bearer <access token>          (401 sem token)
//   3. verifyAccessToken(token)                      (401 recusado; 503 se o Supabase não responde)
//   4. resolveAuthorizationContext(userStore, id)    (403 se não há USER para o authUserId)
//   5. usuário ATIVO                                 (403 se inativo)
//   6. a requisição: query, Content-Type, tamanho e JSON estritos      (400 / 413 / 415)
//   7. Service                                       (403 sem a permissão; 404; 409; 400)
// Nada do que vem do navegador — corpo, query, cabeçalho — participa da identidade ou da permissão: NENHUMA rota
// lê userId, role, permissions, reviewedBy ou authUserId de lugar nenhum, e um campo desconhecido no corpo é 400.
// O reviewedBy gravado na fila vem do contexto, que vem do token.
//
// CRM: o corpo de POST/PATCH /api/crm é o REGISTRO (campos). Este módulo não conhece os nomes dos campos — só o domínio
// os conhece, e ele é inalcançável daqui (R12): o corpo vai ao Service, que o entrega ao domínio, e o domínio recusa (400)
// qualquer nome desconhecido, inclusive userId, role, permissions, reviewedBy, actor e authUserId. Nas rotas de ação
// (status, dnc) as chaves permitidas são fixas aqui (`to`, `reason`) e qualquer outra é 400 sem chegar ao Service. O
// Service autoriza ANTES de validar: sem WRITE:CRM a resposta é 403 mesmo com um corpo forjado. Só propriedades PRÓPRIAS
// do corpo contam, e o que vai ao Service nunca é lido do protótipo (um Object.prototype poluído não escolhe nada).
//
// LEITURA (provisório, decisão D6): as leituras usam a mesma autorização das ações — a que o Service aplica hoje.
// Isso NÃO define a permissão definitiva de leitura da fila; será revisto antes de existir um usuário só-leitura.
//
// ERROS (decisão D5): os erros do Service, do domínio e do auth são traduzidos AQUI, e o Service não foi alterado
// para isso. Como esses erros são texto (não têm código), a tradução compara o início da mensagem — e isso é
// travado por um teste de contrato que produz cada erro real. Toda resposta de erro tem mensagem FIXA em português:
// nunca a mensagem, a stack ou a causa do erro original. Qualquer coisa que não seja reconhecida é 500 genérico.
//
// SEGURANÇA DO TOKEN: o access token nunca é gravado em log, nunca entra em resposta e nunca é repetido em erro. O
// log registra só método, rota (com :id no lugar do prospect), status e userId; uma mensagem de erro que
// eventualmente contenha o token é limpa antes de ser registrada.
//
// Este arquivo não lê ambiente, disco nem rede na importação: quem o compõe é src/server/index.js.

const {
  resolveAuthorizationContext,
  requireActiveUser,
  SupabaseAdapterError,
  CONNECTIVITY_ERROR,
  UserResolutionError,
  USER_NOT_FOUND,
} = require('../auth');
const { createStaticHandler } = require('./static');

const MAX_BODY_BYTES = 16 * 1024;
// A ÚNICA rota com corpo maior: a submissão de prospecção (até 150 achados brutos, decisão 0020). O limite geral acima NÃO mudou; este vale só
// para POST /api/prospecting/submit e é conferido ANTES de ler o corpo (Content-Length) e durante a leitura (o corpo nunca é
// processado acima dele). Os limites estruturais do rawFindingSchema continuam valendo por dentro.
const MAX_PROSPECTING_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_TARGET_LENGTH = 4096;
const DEFAULT_AUTH_TIMEOUT_MS = 10000;

// O estado padrão da listagem. Duplica de propósito QUEUE_STATE.AGUARDANDO_REVISAO do domínio (este módulo não
// importa o domínio); um teste vigia que os dois não divirjam.
const DEFAULT_ESTADO = 'AGUARDANDO_REVISAO';

// As operações do CRM Service que a API usa (o contrato de src/services/crmService.js). Verificadas na criação do app.
const CRM_OPERATIONS = Object.freeze(['listRecords', 'getRecord', 'getHistory', 'createRecord', 'updateRecord', 'moveStatus', 'markDoNotContact', 'deleteRecord']);
// Funis configuráveis (reestruturação Prospecção/CRM/Funis) — as 18 operações do Funnel Service (12 de
// funil/etapa da Etapa "Funis 1", 6 de card da Etapa "Funis 2").
const FUNNEL_OPERATIONS = Object.freeze([
  'listFunnels', 'getFunnel', 'createFunnel', 'updateFunnel', 'deleteFunnel', 'copyFunnel', 'reorderFunnels',
  'listStages', 'createStage', 'updateStage', 'deleteStage', 'reorderStages',
  'listCardsByFunnel', 'getCard', 'getCardHistory', 'createCard', 'moveCard', 'deleteCard',
]);

// A operação da promoção Approval Queue → CRM (src/services/crmIntegrationService.js) que a API usa. Verificada na criação.
const PROMOTION_OPERATION = 'promoteProspect';

// A operação OBRIGATÓRIA do Prospecting Service (src/services/prospectingService.js). Verificada na criação.
const PROSPECTING_OPERATION = 'submitProspecting';
// listBatches/getBatch (já existiam no Service, sem rota HTTP até agora): OPCIONAIS — um double de teste com só
// submitProspecting continua válido (nenhuma rota nova quebra os testes existentes de prospecting-api.test.js);
// a composição REAL (createFileBackedProspectingService) sempre tem as três.
const PROSPECTING_BATCH_OPERATIONS = Object.freeze(['listBatches', 'getBatch']);
// As operações do Prospecting Brief Service (Workbench, Etapa "Prospecção 1") que a API usa.
const PROSPECTING_BRIEF_OPERATIONS = Object.freeze(['createBrief', 'listBriefs', 'getBrief', 'markReadyForResearch', 'generateResearchPackage', 'ingestFindings', 'cancelBrief', 'markConcluded']);

const NO_ACCESS_MESSAGE = 'Esta conta não possui acesso a esta área.';

// O catálogo de respostas de erro: status + mensagem fixa.
const CATALOG = Object.freeze({
  UNAUTHENTICATED: [401, 'Sessão ausente, inválida ou expirada. Entre novamente.'],
  NO_ACCESS: [403, NO_ACCESS_MESSAGE],
  INACTIVE: [403, NO_ACCESS_MESSAGE],
  FORBIDDEN: [403, NO_ACCESS_MESSAGE],
  ROUTE_NOT_FOUND: [404, 'Rota não encontrada.'],
  NOT_FOUND: [404, 'Item não encontrado.'],
  METHOD_NOT_ALLOWED: [405, 'Método não permitido.'],
  ALREADY_DECIDED: [409, 'Este item já foi decidido.'],
  // CRM (decisão 0015): conflitos com o estado do registro ou com outros registros. Mensagens FIXAS — nunca o id do
  // outro registro nem o critério que casou (o dado de um registro não sai na recusa de outro).
  DUPLICATE_RECORD: [409, 'Já existe um registro com esta identidade.'],
  DNC_BLOCKED: [409, 'Esta identidade está bloqueada como "não contatar".'],
  RECORD_LOCKED: [409, 'Este registro está bloqueado como "não contatar" e não pode ser alterado.'],
  INVALID_TRANSITION: [409, 'Esta mudança de status não é permitida.'],
  // Integridade CRM ↔ Card (Etapa "Funis 2 — correção final"), por `code` estável do CRM Service (crmService.js) —
  // nunca por mensagem: quais Cards/Funis estão vinculados a este registro não é dito (mesmo padrão de
  // FUNNEL_HAS_CARDS/STAGE_HAS_CARDS abaixo).
  CRM_HAS_ACTIVE_FUNNEL_CARDS: [409, 'Este registro não pode ser excluído enquanto possuir Cards ativos em funis. Arquive os Cards primeiro.'],
  // Promoção Approval Queue → CRM (decisão 0016), por `code` estável do serviço. Mensagens FIXAS: nunca o id do registro
  // existente, o critério que casou nem o texto do serviço.
  PROMOTION_NOT_APPROVED: [409, 'Este prospect não está aprovado para o CRM.'],
  PROMOTION_APPROVAL_MISSING: [409, 'A aprovação deste prospect não está registrada. A promoção foi bloqueada.'],
  PROMOTION_BLOCKED_DNC: [409, 'Promoção bloqueada: existe uma restrição de contato para este prospect.'],
  PROMOTION_BLOCKED_DUPLICATE: [409, 'Este prospect parece já existir no CRM. A promoção foi bloqueada para não duplicar o registro.'],
  PROMOTION_INSUFFICIENT_DATA: [409, 'Os dados deste prospect não são suficientes para entrar no CRM.'],
  PROMOTION_INCONSISTENT: [409, 'O estado deste prospect está inconsistente entre a fila e o CRM. Nada foi alterado; peça uma revisão.'],
  PROMOTION_PARTIAL: [409, 'A promoção foi concluída só em parte. Tente promover de novo.'],
  // Prospecting Service V1, por `code` estável do serviço. Mensagens FIXAS: nunca o valor recusado, o texto do serviço, um
  // caminho, um id de prospect ou o texto do erro de armazenamento. A recusa de AUTORIZAÇÃO não passa por aqui (é 403 pelos
  // caminhos de sempre).
  PROSPECTING_INVALID_INPUT: [400, 'Submissão inválida: envie exatamente { briefing, rawFindings }.'],
  PROSPECTING_BRIEFING_INVALID: [400, 'O briefing é inválido.'],
  PROSPECTING_RAW_FINDINGS_INVALID: [400, 'Os achados da pesquisa são inválidos; nada foi processado.'],
  PROSPECTING_CANDIDATE_INVALID: [422, 'Um candidato não pôde ser processado; nada foi gravado.'],
  PROSPECTING_CONFLICT: [409, 'Conflito ao registrar o lote. Tente novamente.'],
  PROSPECTING_NOT_FOUND: [404, 'Lote não encontrado.'],
  PROSPECTING_CRM_INVALID: [503, 'Não foi possível ler o CRM agora; nada foi processado.'],
  PROSPECTING_PERSISTENCE: [503, 'Não foi possível ler ou gravar os dados locais agora. Tente novamente em instantes.'],
  // Workbench de Prospecção (Etapa "Prospecção 1"), por `code` estável do Prospecting Brief Service
  // (prospectingBriefService.js) — nunca por mensagem.
  BRIEF_INVALID_INPUT: [400, 'O brief é inválido.'],
  BRIEF_NOT_FOUND: [404, 'Brief não encontrado.'],
  BRIEF_INVALID_STATE: [409, 'Esta ação não é permitida no estado atual do brief.'],
  BRIEF_PERSISTENCE: [503, 'Não foi possível ler ou gravar os briefs agora. Tente novamente em instantes.'],
  // Funis configuráveis (Etapa "Funis 1"), por `code` estável do domínio (funnelDomain.js) — nunca por mensagem:
  // quais funis/etapas foram vinculados a um card não é dito (o card ainda nem existe nesta etapa).
  FUNNEL_HAS_CARDS: [409, 'Este funil possui cards vinculados e não pode ser excluído.'],
  STAGE_HAS_CARDS: [409, 'Esta etapa possui cards vinculados e não pode ser excluída.'],
  // Card (Etapa "Funis 2").
  FUNNEL_CARD_DUPLICATE: [409, 'Este registro já tem um card ativo neste funil.'],
  FUNNEL_STAGE_MISMATCH: [400, 'A etapa informada não pertence a este funil.'],
  FUNNEL_HAS_NO_STAGES: [409, 'Este funil ainda não tem nenhuma etapa.'],
  PAYLOAD_TOO_LARGE: [413, 'Requisição grande demais.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Envie o corpo como application/json.'],
  INVALID_REQUEST: [400, 'Requisição inválida.'],
  AUTH_UNAVAILABLE: [503, 'Não foi possível verificar a sessão agora. Tente novamente em instantes.'],
  INTERNAL: [500, 'Erro interno. Tente novamente em instantes.'],
});

// Um erro DESTE módulo: um código do catálogo, um detalhe (só para INVALID_REQUEST, de um conjunto fixo) e
// cabeçalhos extras (Allow, Connection).
class HttpError extends Error {
  constructor(code, detail, headers) {
    super(code);
    this.name = 'HttpError';
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

// As mensagens EXISTENTES do Service, do domínio e do auth, reconhecidas pelo começo do texto (D5). O que não
// está aqui é INTERNAL. O teste de contrato (tests/server) produz cada uma destas com os módulos reais.
const KNOWN_MESSAGES = Object.freeze([
  [/^usuário inativo/, 'INACTIVE'],
  [/^acesso negado/, 'FORBIDDEN'],
  [/^prospect não encontrado na fila/, 'NOT_FOUND'],
  [/^transição não permitida/, 'ALREADY_DECIDED'],
  [/^rejeição exige um motivo/, 'INVALID_REQUEST', 'Informe o motivo da rejeição.'],
  [/^reason deve ser um texto/, 'INVALID_REQUEST', 'O motivo deve ser um texto.'],
  [/^opções não reconhecidas/, 'INVALID_REQUEST', 'Campos não permitidos na requisição.'],
  [/^as opções devem ser um objeto/, 'INVALID_REQUEST', 'Campos não permitidos na requisição.'],
  [/^estado desconhecido/, 'INVALID_REQUEST', 'Estado inválido.'],
  [/^prospectId deve ser um texto não vazio/, 'INVALID_REQUEST', 'Identificador inválido.'],
  // CRM (decisão 0015). As mensagens do CRM Service e do domínio do CRM têm o prefixo "CRM: ", que as distingue das da
  // fila; só entram aqui as que uma requisição HTTP consegue produzir — o resto (repositório defeituoso, registro
  // corrompido, autorizador defeituoso, opções que este módulo nunca envia) é bug ou falha de armazenamento: 500.
  // A ordem importa só entre padrões que possam casar a mesma mensagem, e estes não casam.
  // (etapa 3F) Um erro que vem do REPOSITÓRIO (não do domínio) nunca chega até aqui por mensagem: um erro do
  // adapter de arquivo (ex.: "CRM: arquivo de dados corrompido") continua sem nenhum destes prefixos específicos,
  // caindo no INTERNAL genérico como sempre; um erro do adapter Supabase é classificado ANTES, por CRM_REPOSITORY_CODES
  // acima (contrato comum entre adapters, nunca por uma mensagem "CRM (Supabase): ..." — essas nunca deveriam casar
  // aqui, de propósito, porque o prefixo é literalmente diferente).
  [/^CRM: registro não encontrado/, 'NOT_FOUND'],
  [/^CRM: não é possível (?:criar — identidade já bloqueada|atualizar — a nova identidade coincide com a de um registro bloqueado)/, 'DNC_BLOCKED'],
  [/^CRM: não é possível (?:criar — já existe um registro|atualizar — a nova identidade coincide com a de outro registro)/, 'DUPLICATE_RECORD'],
  [/^CRM: registro bloqueado \(DO_NOT_CONTACT\) não pode ser atualizado/, 'RECORD_LOCKED'],
  [/^CRM: transição não permitida/, 'INVALID_TRANSITION'],
  [/^CRM: id deve ser um texto não vazio/, 'INVALID_REQUEST', 'Identificador inválido.'],
  [/^CRM: (?:createRecord|updateRecord) (?:não aceita campos gerenciados|tem campos desconhecidos)/, 'INVALID_REQUEST', 'Campos não permitidos na requisição.'],
  [/^CRM: (?:createRecord|updateRecord) — campo "/, 'INVALID_REQUEST', 'Valor inválido em um dos campos.'],
  [/^CRM: createRecord exige "empresa"/, 'INVALID_REQUEST', 'Informe a empresa.'],
  [/^CRM: updateRecord não pode deixar "empresa" vazia/, 'INVALID_REQUEST', 'A empresa não pode ficar vazia.'],
  [/^CRM: status desconhecido/, 'INVALID_REQUEST', 'Status inválido.'],
  [/^CRM: status deve ser um texto/, 'INVALID_REQUEST', 'Status inválido.'],
  [/^CRM: o status de destino deve ser um texto/, 'INVALID_REQUEST', 'Status inválido.'],
  [/^CRM: reason deve ser um texto/, 'INVALID_REQUEST', 'O motivo deve ser um texto.'],
  // Exclusão administrativa (decisão 0025) — a ÚNICA operação do CRM onde reason é OBRIGATÓRIO (deleteRecord ->
  // Service.readReason com { required: true }); todas as demais acima aceitam reason ausente.
  [/^CRM: reason é obrigatório para excluir um registro/, 'INVALID_REQUEST', 'Informe o motivo da exclusão.'],
  // Funis configuráveis (Etapa "Funis 1"). O prefixo "Funil: " distingue estas mensagens das do CRM/fila; só as
  // que uma requisição HTTP consegue produzir entram aqui (repositório/composição inválidos são bug: 500).
  [/^Funil: (?:funil|etapa|card) não encontrad[oa]/, 'NOT_FOUND'],
  [/^Funil: registro do CRM não encontrado/, 'NOT_FOUND'],
  [/^Funil: id de (?:funil|etapa|card) deve ser um texto não vazio/, 'INVALID_REQUEST', 'Identificador inválido.'],
  [/^Funil: (?:criar|editar) (?:um funil|uma etapa) exige "nome"/, 'INVALID_REQUEST', 'Informe o nome.'],
  [/^Funil: reordenar/, 'INVALID_REQUEST', 'Lista de reordenação inválida.'],
  [/^Funil: a lista de reordenação/, 'INVALID_REQUEST', 'Lista de reordenação inválida.'],
  [/^Funil: .* deve ser um objeto simples/, 'INVALID_REQUEST', 'Campos não permitidos na requisição.'],
  [/^Funil: .* tem campos desconhecidos/, 'INVALID_REQUEST', 'Campos não permitidos na requisição.'],
  // Card (Etapa "Funis 2").
  [/^Funil: criar um card exige "crmRecordId"/, 'INVALID_REQUEST', 'Informe o registro do CRM.'],
  [/^Funil: mover um card exige "stageId"/, 'INVALID_REQUEST', 'Informe a etapa de destino.'],
  [/^Funil: (?:reason|motivo) deve ser um texto/, 'INVALID_REQUEST', 'O motivo deve ser um texto.'],
]);

// Os `code` do serviço de promoção que a API reconhece. PROMOTION_INVALID_INPUT e PROMOTION_PROSPECT_NOT_FOUND viram os
// mesmos 400/404 das demais rotas; um teste vigia que esta lista não divirja de PROMOTION_ERROR.
const PROMOTION_CODES = Object.freeze({
  PROMOTION_INVALID_INPUT: 'INVALID_REQUEST',
  PROMOTION_PROSPECT_NOT_FOUND: 'NOT_FOUND',
  PROMOTION_NOT_APPROVED: 'PROMOTION_NOT_APPROVED',
  PROMOTION_APPROVAL_MISSING: 'PROMOTION_APPROVAL_MISSING',
  PROMOTION_BLOCKED_DNC: 'PROMOTION_BLOCKED_DNC',
  PROMOTION_BLOCKED_DUPLICATE: 'PROMOTION_BLOCKED_DUPLICATE',
  PROMOTION_INSUFFICIENT_DATA: 'PROMOTION_INSUFFICIENT_DATA',
  PROMOTION_INCONSISTENT: 'PROMOTION_INCONSISTENT',
  PROMOTION_PARTIAL: 'PROMOTION_PARTIAL',
});

// Os `code` do domínio de Funis (funnelDomain.js) que a API reconhece — mapeamento identidade (o `code` do erro já
// é o nome do CATALOG), separado só para seguir o mesmo padrão de PROMOTION_CODES/CRM_REPOSITORY_CODES: nunca
// `instanceof` de uma classe de outro módulo.
const FUNNEL_CODES = Object.freeze({
  FUNNEL_HAS_CARDS: 'FUNNEL_HAS_CARDS',
  STAGE_HAS_CARDS: 'STAGE_HAS_CARDS',
  // Etapa "Funis 2" (card).
  FUNNEL_CARD_DUPLICATE: 'FUNNEL_CARD_DUPLICATE',
  FUNNEL_STAGE_MISMATCH: 'FUNNEL_STAGE_MISMATCH',
  FUNNEL_HAS_NO_STAGES: 'FUNNEL_HAS_NO_STAGES',
});

// O `code` do CRM Service (crmService.js) que a API reconhece — mesmo mapeamento identidade de FUNNEL_CODES acima,
// só que para o CRM (Etapa "Funis 2 — correção final de integridade CRM ↔ Card").
const CRM_CODES = Object.freeze({
  CRM_HAS_ACTIVE_FUNNEL_CARDS: 'CRM_HAS_ACTIVE_FUNNEL_CARDS',
});

// O `code` do Prospecting Brief Service (prospectingBriefService.js) que a API reconhece — mesmo mapeamento
// identidade de CRM_CODES/FUNNEL_CODES acima (Etapa "Prospecção 1").
const BRIEF_CODES = Object.freeze({
  BRIEF_INVALID_INPUT: 'BRIEF_INVALID_INPUT',
  BRIEF_NOT_FOUND: 'BRIEF_NOT_FOUND',
  BRIEF_INVALID_STATE: 'BRIEF_INVALID_STATE',
  BRIEF_PERSISTENCE: 'BRIEF_PERSISTENCE',
});

// Os `code` que um adapter de REPOSITÓRIO do CRM pode anexar a um erro (contrato comum entre adapters, etapa 3F —
// corrige o BLOCKER 2 da etapa 3E). app.js NUNCA importa src/crm-adapters/ nem src/crm/ (R12/R16, e a lista de
// imports fechada de [CRM-API-ARCH-1]: só `../auth`/`./static`) — por isso o reconhecimento é por STRING, igual a
// PROMOTION_CODES/PROSPECTING_CODES acima, nunca por `instanceof` de uma classe de outro módulo. Hoje só
// src/crm-adapters/crmSupabaseRepository.js usa este contrato (CRM_REPOSITORY_ERROR, exportado de lá — um teste
// vigia que esta lista não diverge); o adapter de ARQUIVO nunca anexa `code` a um erro, então nada aqui muda o
// comportamento dele — os erros do arquivo continuam caindo só pelas mensagens "CRM: ..." de sempre (KNOWN_MESSAGES
// abaixo). Qualquer erro do adapter Supabase SEM um destes dois códigos (rede fora, tabela ausente, permissão, um
// 5xx do Postgres) continua caindo no INTERNAL genérico — de propósito: não há como classificar essas causas sem
// arriscar enganar quem chama.
const CRM_REPOSITORY_CODES = Object.freeze({
  CRM_REPOSITORY_INVALID_REQUEST: 'INVALID_REQUEST',
  CRM_REPOSITORY_CONFLICT: 'DUPLICATE_RECORD',
});

// Os `code` do Prospecting Service que a API reconhece (o próprio código do serviço vira o código HTTP; o catálogo acima traz a
// mensagem fixa e o status). Um teste vigia que esta lista não diverge de PROSPECTING_ERROR.
const PROSPECTING_CODES = Object.freeze([
  'PROSPECTING_INVALID_INPUT',
  'PROSPECTING_BRIEFING_INVALID',
  'PROSPECTING_RAW_FINDINGS_INVALID',
  'PROSPECTING_CANDIDATE_INVALID',
  'PROSPECTING_CONFLICT',
  'PROSPECTING_NOT_FOUND',
  'PROSPECTING_CRM_INVALID',
  'PROSPECTING_PERSISTENCE',
]);

// Os detalhes de uma recusa de validação: só CAMINHO (formado por chaves conhecidas e índices) e CÓDIGO — nunca o valor recusado.
// Mesmo assim cada campo é reconferido aqui (forma e tamanho), no máximo 50 itens.
function safeDetails(details) {
  if (!details || typeof details !== 'object' || !Array.isArray(details.errors)) return undefined;
  const list = [];
  for (const item of details.errors.slice(0, 50)) {
    const path = item && typeof item.path === 'string' && /^[A-Za-z0-9_.[\]?]{0,120}$/.test(item.path) ? item.path : '';
    const itemCode = item && typeof item.code === 'string' && /^[A-Z_]{1,40}$/.test(item.code) ? item.code : 'INVALIDO';
    list.push({ path, code: itemCode });
  }
  return list;
}

// Dicas para o LOG de erros internos conhecidos — sem repetir a mensagem original, que pode trazer trechos de
// dados (um JSON de fila corrompido cita um pedaço do conteúdo).
const INTERNAL_HINTS = Object.freeze([
  [/^arquivo de fila corrompido/, 'a fila em disco está corrompida ou ilegível (confira RIO_X7_QUEUE_PATH e o arquivo)'],
  [/^CRM: arquivo de dados corrompido/, 'o arquivo do CRM em disco está corrompido ou ilegível (confira RIO_X7_CRM_PATH e o arquivo)'],
]);

// Traduz QUALQUER erro em { status, code, message, headers }. Nunca lança.
function mapErrorToHttp(error) {
  let code = 'INTERNAL';
  let detail;
  let headers;
  let details;
  if (error instanceof HttpError) {
    code = error.code;
    detail = error.detail;
    headers = error.headers;
  } else if (error instanceof SupabaseAdapterError) {
    code = error.category === CONNECTIVITY_ERROR.AUTH ? 'UNAUTHENTICATED' : 'AUTH_UNAVAILABLE';
  } else if (error instanceof UserResolutionError) {
    code = error.code === USER_NOT_FOUND ? 'NO_ACCESS' : 'INTERNAL';
  } else if (error && typeof error === 'object' && typeof error.code === 'string' && PROSPECTING_CODES.includes(error.code)) {
    code = error.code;
    // só as recusas de VALIDAÇÃO (400) levam caminho e código; nenhum outro erro carrega detalhe
    if (CATALOG[code][0] === 400) details = safeDetails(error.details);
  } else if (error && typeof error === 'object' && Object.prototype.hasOwnProperty.call(PROMOTION_CODES, error.code)) {
    code = PROMOTION_CODES[error.code];
    if (code === 'INVALID_REQUEST') detail = 'Identificador inválido.';
  } else if (error && typeof error === 'object' && Object.prototype.hasOwnProperty.call(CRM_REPOSITORY_CODES, error.code)) {
    code = CRM_REPOSITORY_CODES[error.code];
  } else if (error && typeof error === 'object' && Object.prototype.hasOwnProperty.call(FUNNEL_CODES, error.code)) {
    code = FUNNEL_CODES[error.code];
  } else if (error && typeof error === 'object' && Object.prototype.hasOwnProperty.call(CRM_CODES, error.code)) {
    code = CRM_CODES[error.code];
  } else if (error && typeof error === 'object' && Object.prototype.hasOwnProperty.call(BRIEF_CODES, error.code)) {
    code = BRIEF_CODES[error.code];
    if (CATALOG[code][0] === 400) details = safeDetails(error.details);
  } else {
    const message = error && typeof error.message === 'string' ? error.message : '';
    const known = KNOWN_MESSAGES.find(([pattern]) => pattern.test(message));
    if (known) {
      code = known[1];
      detail = known[2];
    }
  }
  const [status, message] = CATALOG[code] || CATALOG.INTERNAL;
  const failure = { status, code, message: code === 'INVALID_REQUEST' && detail ? detail : message, headers };
  if (details !== undefined) failure.details = details;
  return failure;
}

function respond(status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(body)),
      ...headers,
    },
    body,
  };
}

function errorResponse(failure) {
  const error = { code: failure.code, message: failure.message };
  if (failure.details !== undefined) error.details = failure.details;
  return respond(failure.status, { error }, failure.headers);
}

// Remove o token de um texto (defesa em profundidade: o adapter já o limpa das suas mensagens).
function scrub(text, token) {
  const value = String(text == null ? '' : text);
  return token ? value.split(token).join('[token omitido]') : value;
}

// O que vai para o log quando um erro é inesperado: a dica conhecida, ou classe + mensagem curta e sem o token.
function describeError(error, token) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  const hint = INTERNAL_HINTS.find(([pattern]) => pattern.test(message));
  if (hint) return hint[1];
  const name = error && typeof error.name === 'string' ? error.name : 'Error';
  return `${name}: ${scrub(message, token).slice(0, 200)}`;
}

function bearerToken(header) {
  if (typeof header !== 'string') throw new HttpError('UNAUTHENTICATED');
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) throw new HttpError('UNAUTHENTICATED');
  return match[1];
}

// Uma verificação de token que não responde vira 503 (falha fechada), nunca uma requisição pendurada.
function withTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new HttpError('AUTH_UNAVAILABLE')), milliseconds);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function collectBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (done, value) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      done(value);
    };
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        settle(reject, new HttpError('PAYLOAD_TOO_LARGE', undefined, { Connection: 'close' }));
        return;
      }
      chunks.push(buffer);
    }
    req.on('data', onData);
    req.once('end', () => settle(resolve, Buffer.concat(chunks)));
    req.once('error', (error) => settle(reject, error));
    req.once('close', () => settle(reject, new HttpError('INVALID_REQUEST', 'Requisição interrompida.')));
  });
}

// Content-Type application/json obrigatório, tamanho limitado, JSON estrito: o corpo é um OBJETO.
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError('UNSUPPORTED_MEDIA_TYPE');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError('PAYLOAD_TOO_LARGE', undefined, { Connection: 'close' });
  }
  const text = (await collectBody(req, limit)).toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError('INVALID_REQUEST', 'JSON inválido.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError('INVALID_REQUEST', 'O corpo deve ser um objeto JSON.');
  }
  return value;
}

// O único campo aceito nas decisões é `reason`. Qualquer outro — userId, role, permissions, reviewedBy,
// authUserId... — é recusado, e nunca chega ao Service.
function readReason(body, { required }) {
  if (Object.keys(body).some((key) => key !== 'reason')) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
  if (body.reason !== undefined && typeof body.reason !== 'string') throw new HttpError('INVALID_REQUEST', 'O motivo deve ser um texto.');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (required && reason.length === 0) throw new HttpError('INVALID_REQUEST', 'Informe o motivo da rejeição.');
  return reason.length > 0 ? reason : undefined;
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// O corpo de uma rota de AÇÃO do CRM (status, dnc): só as chaves listadas. Qualquer outra — userId, role, permissions,
// reviewedBy, actor, authUserId... — é 400 e nunca chega ao Service. Devolve um objeto SEM protótipo só com as chaves que o
// corpo tem como propriedade PRÓPRIA (nada herdado conta), com os valores como vieram: tipo e conteúdo são do Service.
function readActionBody(body, allowedKeys) {
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
  const picked = Object.create(null);
  for (const key of allowedKeys) {
    if (hasOwn(body, key)) picked[key] = body[key];
  }
  return picked;
}

// Separa o corpo de POST /api/crm em CAMPOS do registro e OPÇÕES do Service. `status` (o status inicial) e `reason` (o
// motivo da entrada) são as únicas opções de createRecord; todo o resto é campo, e quem sabe quais campos existem é o
// domínio, que recusa os desconhecidos. Os campos vão para um objeto SEM protótipo: uma chave "__proto__" do JSON vira
// uma propriedade comum (que o domínio recusa), nunca troca o protótipo de nada.
function splitCreateBody(body) {
  const fields = Object.create(null);
  const options = {};
  for (const key of Object.keys(body)) {
    if (key === 'status' || key === 'reason') options[key] = body[key];
    else fields[key] = body[key];
  }
  return { fields, options };
}

function parseTarget(req) {
  const target = req.url;
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.includes('\\') || target.length > MAX_TARGET_LENGTH) {
    throw new HttpError('INVALID_REQUEST');
  }
  try {
    return new URL(target, 'http://localhost');
  } catch {
    throw new HttpError('INVALID_REQUEST');
  }
}

// `crm`: as rotas do CRM só existem quando o CRM Service foi injetado; sem ele, /api/crm... é uma rota desconhecida (404).
function matchRoute(pathname, { crm, promotion, prospecting, prospectingBatchReads, prospectingBrief, funnels }) {
  if (pathname === '/api/me') return { name: 'me', label: '/api/me', methods: ['GET'] };
  if (pathname === '/api/approvals') return { name: 'list', label: '/api/approvals', methods: ['GET'] };
  if (prospecting && pathname === '/api/prospecting/submit') return { name: 'prospecting-submit', label: '/api/prospecting/submit', methods: ['POST'] };
  // Leitura de LOTES (já existente no Service — listBatches/getBatch — só nunca tinha rota HTTP): usada pelo
  // Workbench para mostrar a tabela de achados de um brief já ingerido (brief.loteRealId). OPCIONAL: só existe
  // quando o prospectingService injetado tem os dois métodos (a composição real sempre tem).
  if (prospectingBatchReads && pathname === '/api/prospecting/batches') return { name: 'prospecting-batches', label: '/api/prospecting/batches', methods: ['GET'] };
  const batchItem = prospectingBatchReads ? /^\/api\/prospecting\/batches\/([^/]+)$/.exec(pathname) : null;
  if (batchItem) return { name: 'prospecting-batch-item', label: '/api/prospecting/batches/:id', methods: ['GET'], rawId: batchItem[1] };
  // Workbench de Prospecção (Etapa "Prospecção 1") — só existe quando o Prospecting Brief Service foi injetado.
  // Ordem: os caminhos com ação (/ready, /package, /findings, /cancel, /conclude) são checados ANTES do :id
  // genérico, mesmo cuidado já usado nas rotas de Funil.
  if (prospectingBrief) {
    if (pathname === '/api/prospecting/briefs') return { family: 'prospecting-brief', name: 'brief-collection', label: '/api/prospecting/briefs', methods: ['GET', 'POST'] };
    const action = /^\/api\/prospecting\/briefs\/([^/]+)\/(ready|package|findings|cancel|conclude)$/.exec(pathname);
    if (action) return { family: 'prospecting-brief', name: `brief-${action[2]}`, label: `/api/prospecting/briefs/:id/${action[2]}`, methods: ['POST'], rawId: action[1] };
    const item = /^\/api\/prospecting\/briefs\/([^/]+)$/.exec(pathname);
    if (item) return { family: 'prospecting-brief', name: 'brief-item', label: '/api/prospecting/briefs/:id', methods: ['GET'], rawId: item[1] };
  }
  if (promotion) {
    const promote = /^\/api\/approvals\/([^/]+)\/promote$/.exec(pathname);
    if (promote) return { name: 'promote', label: '/api/approvals/:id/promote', methods: ['POST'], rawId: promote[1] };
  }
  const decision = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (decision) return { name: decision[2], label: `/api/approvals/:id/${decision[2]}`, methods: ['POST'], rawId: decision[1] };
  if (crm) {
    if (pathname === '/api/crm') return { family: 'crm', name: 'crm-collection', label: '/api/crm', methods: ['GET', 'POST'] };
    const item = /^\/api\/crm\/([^/]+)(?:\/(history|status|dnc))?$/.exec(pathname);
    if (item) {
      const [, rawId, action] = item;
      if (action === undefined) return { family: 'crm', name: 'crm-item', label: '/api/crm/:id', methods: ['GET', 'PATCH', 'DELETE'], rawId };
      if (action === 'history') return { family: 'crm', name: 'crm-history', label: '/api/crm/:id/history', methods: ['GET'], rawId };
      return { family: 'crm', name: `crm-${action}`, label: `/api/crm/:id/${action}`, methods: ['POST'], rawId };
    }
  }
  // Funis configuráveis (reestruturação Prospecção/CRM/Funis, Etapa "Funis 1"). A ordem importa: os caminhos mais
  // específicos ("reorder") são checados ANTES do padrão genérico de :id, senão "reorder" seria lido como um id.
  if (funnels) {
    if (pathname === '/api/funnels/reorder') return { family: 'funnel', name: 'funnel-reorder', label: '/api/funnels/reorder', methods: ['POST'] };
    if (pathname === '/api/funnels') return { family: 'funnel', name: 'funnel-collection', label: '/api/funnels', methods: ['GET', 'POST'] };
    const stageReorder = /^\/api\/funnels\/([^/]+)\/stages\/reorder$/.exec(pathname);
    if (stageReorder) return { family: 'funnel', name: 'funnel-stage-reorder', label: '/api/funnels/:id/stages/reorder', methods: ['POST'], rawId: stageReorder[1] };
    const stages = /^\/api\/funnels\/([^/]+)\/stages$/.exec(pathname);
    if (stages) return { family: 'funnel', name: 'funnel-stages', label: '/api/funnels/:id/stages', methods: ['GET', 'POST'], rawId: stages[1] };
    const copy = /^\/api\/funnels\/([^/]+)\/copy$/.exec(pathname);
    if (copy) return { family: 'funnel', name: 'funnel-copy', label: '/api/funnels/:id/copy', methods: ['POST'], rawId: copy[1] };
    // Card (Etapa "Funis 2"): /api/funnels/:id/cards (listar/criar) e /api/funnel-cards/:id (ler/mover/arquivar) —
    // mesmo padrão de nomeação de /api/funnel-stages/:id (uma coleção "achatada", fora de /api/funnels/:id/...).
    const cards = /^\/api\/funnels\/([^/]+)\/cards$/.exec(pathname);
    if (cards) return { family: 'funnel', name: 'funnel-cards', label: '/api/funnels/:id/cards', methods: ['GET', 'POST'], rawId: cards[1] };
    const item = /^\/api\/funnels\/([^/]+)$/.exec(pathname);
    if (item) return { family: 'funnel', name: 'funnel-item', label: '/api/funnels/:id', methods: ['GET', 'PATCH', 'DELETE'], rawId: item[1] };
    const stageItem = /^\/api\/funnel-stages\/([^/]+)$/.exec(pathname);
    if (stageItem) return { family: 'funnel', name: 'funnel-stage-item', label: '/api/funnel-stages/:id', methods: ['PATCH', 'DELETE'], rawId: stageItem[1] };
    const cardHistory = /^\/api\/funnel-cards\/([^/]+)\/history$/.exec(pathname);
    if (cardHistory) return { family: 'funnel', name: 'funnel-card-history', label: '/api/funnel-cards/:id/history', methods: ['GET'], rawId: cardHistory[1] };
    const cardItem = /^\/api\/funnel-cards\/([^/]+)$/.exec(pathname);
    if (cardItem) return { family: 'funnel', name: 'funnel-card-item', label: '/api/funnel-cards/:id', methods: ['GET', 'PATCH', 'DELETE'], rawId: cardItem[1] };
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) return { name: 'unknown', label: '/api/*', methods: [] };
  return null;
}

function decodeId(rawId) {
  try {
    return decodeURIComponent(rawId);
  } catch {
    throw new HttpError('INVALID_REQUEST', 'Identificador inválido.');
  }
}

// Sem nenhuma query, salvo as chaves permitidas (e cada uma uma única vez).
function readQuery(url, allowedKeys) {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !allowedKeys.includes(key))) throw new HttpError('INVALID_REQUEST', 'Parâmetros não permitidos.');
  for (const key of allowedKeys) {
    if (url.searchParams.getAll(key).length > 1) throw new HttpError('INVALID_REQUEST', 'Parâmetros não permitidos.');
  }
  return url.searchParams;
}

function projectIdentity(context) {
  return {
    userId: context.userId,
    name: context.name,
    role: context.role,
    permissions: [...context.permissions],
    status: context.status,
  };
}

function contentSecurityPolicy(connectOrigin) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${connectOrigin}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`createApp exige { ${name} } (função)`);
}

// verifyAccessToken: async (token) -> VerifiedIdentity (o adapter de src/auth).
// userStore: o store de USERs (findByAuthUserId).
// approvalQueueService: o Approval Queue Service (listQueue, approveProspect, rejectProspect).
// crmService: o CRM Service (as 8 operações de CRM_OPERATIONS) — OPCIONAL: sem ele as rotas /api/crm não existem (404).
//   Presente, é validado por inteiro na criação (falha fechada); `null` não é "ausente", é erro.
// crmIntegrationService: a promoção Approval Queue → CRM (promoteProspect) — OPCIONAL: sem ele a rota de promoção não existe (404).
// prospectingService: o Prospecting Service (submitProspecting) — OPCIONAL: sem ele a rota de submissão não existe (404).
// publicConfig: { supabaseUrl, supabaseAnonKey } — os valores PÚBLICOS que o navegador recebe.
// staticRoot / staticFiles: os arquivos do Dashboard (ver static.js).
// log: (texto) => void. authTimeoutMs: quanto esperar pela verificação do token.
function createApp(dependencies) {
  const {
    verifyAccessToken,
    userStore,
    approvalQueueService,
    crmService,
    crmIntegrationService,
    prospectingService,
    prospectingBriefService,
    funnelService,
    publicConfig,
    staticRoot,
    staticFiles,
    log = () => {},
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  } = dependencies || {};
  requireFunction(verifyAccessToken, 'verifyAccessToken');
  requireFunction(log, 'log');
  if (!userStore || typeof userStore.findByAuthUserId !== 'function') throw new Error('createApp exige { userStore } (com findByAuthUserId)');
  for (const operation of ['listQueue', 'approveProspect', 'rejectProspect']) {
    if (!approvalQueueService || typeof approvalQueueService[operation] !== 'function') {
      throw new Error(`createApp exige { approvalQueueService } com ${operation}()`);
    }
  }
  if (crmService !== undefined) {
    for (const operation of CRM_OPERATIONS) {
      if (!crmService || typeof crmService[operation] !== 'function') throw new Error(`createApp exige { crmService } com ${operation}()`);
    }
  }
  if (crmIntegrationService !== undefined && (!crmIntegrationService || typeof crmIntegrationService[PROMOTION_OPERATION] !== 'function')) {
    throw new Error(`createApp exige { crmIntegrationService } com ${PROMOTION_OPERATION}()`);
  }
  if (prospectingService !== undefined && (!prospectingService || typeof prospectingService[PROSPECTING_OPERATION] !== 'function')) {
    throw new Error(`createApp exige { prospectingService } com ${PROSPECTING_OPERATION}()`);
  }
  const prospectingHasBatchReads = prospectingService !== undefined && PROSPECTING_BATCH_OPERATIONS.every((operation) => typeof prospectingService[operation] === 'function');
  if (prospectingBriefService !== undefined) {
    for (const operation of PROSPECTING_BRIEF_OPERATIONS) {
      if (!prospectingBriefService || typeof prospectingBriefService[operation] !== 'function') {
        throw new Error(`createApp exige { prospectingBriefService } com ${operation}()`);
      }
    }
  }
  if (funnelService !== undefined) {
    for (const operation of FUNNEL_OPERATIONS) {
      if (!funnelService || typeof funnelService[operation] !== 'function') throw new Error(`createApp exige { funnelService } com ${operation}()`);
    }
  }
  if (!publicConfig || typeof publicConfig.supabaseUrl !== 'string' || typeof publicConfig.supabaseAnonKey !== 'string') {
    throw new Error('createApp exige { publicConfig: { supabaseUrl, supabaseAnonKey } }');
  }
  let connectOrigin;
  try {
    connectOrigin = new URL(publicConfig.supabaseUrl).origin;
  } catch {
    throw new Error('createApp: publicConfig.supabaseUrl não é uma URL válida');
  }
  const csp = contentSecurityPolicy(connectOrigin);
  // O que o navegador recebe em /config.json: EXATAMENTE estes dois valores públicos, nomeados um a um.
  const staticHandler = createStaticHandler({
    root: staticRoot,
    files: staticFiles,
    config: { supabaseUrl: publicConfig.supabaseUrl, supabaseAnonKey: publicConfig.supabaseAnonKey },
  });

  // Autentica e devolve o contexto. Só o servidor decide: o token é a única coisa do cliente que conta.
  async function authenticate(req, trace) {
    const token = bearerToken(req.headers.authorization);
    trace.token = token;
    const identity = await withTimeout(verifyAccessToken(token), authTimeoutMs);
    const context = resolveAuthorizationContext(userStore, identity);
    requireActiveUser(context);
    trace.userId = context.userId;
    return context;
  }

  async function serveStatic(req, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError('METHOD_NOT_ALLOWED', undefined, { Allow: 'GET, HEAD' });
    return staticHandler.serve(url.pathname);
  }

  // As rotas do CRM (decisão 0015). Cada uma só traduz HTTP <-> uma chamada ao CRM Service, com o AuthorizationContext
  // que veio do token; a permissão (READ:CRM / WRITE:CRM), as regras do domínio e a identidade gravada no histórico são
  // do Service. Nada aqui importa o domínio, nem decide autorização, nem lê identidade do navegador.
  async function dispatchCrm(req, url, route, context) {
    readQuery(url, []); // sem filtros nem busca: o Service não os tem
    if (route.name === 'crm-collection') {
      if (req.method === 'GET') return respond(200, { items: await crmService.listRecords(context) });
      const { fields, options } = splitCreateBody(await readJsonBody(req));
      const created = await crmService.createRecord(context, fields, options);
      return respond(201, { item: created.record, duplicidade: created.duplicidade });
    }

    const id = decodeId(route.rawId);
    if (route.name === 'crm-history') return respond(200, { historico: await crmService.getHistory(context, id) });
    if (route.name === 'crm-item') {
      if (req.method === 'GET') {
        const item = await crmService.getRecord(context, id);
        if (item === null) throw new HttpError('NOT_FOUND');
        return respond(200, { item });
      }
      if (req.method === 'DELETE') {
        // Exclusão ADMINISTRATIVA e IRREVERSÍVEL (decisão 0025). O corpo aceita só `reason` (mesmo formato/limite de
        // crm-status/crm-dnc, via readActionBody) — nenhum outro campo (role, permissions, userId, actor, reviewedBy...)
        // chega ao Service: quem decide se DELETE:CRM está presente é sempre o AuthorizationContext desta requisição,
        // nunca o corpo. O motivo ser OBRIGATÓRIO é responsabilidade do Service (deleteRecord -> readReason com
        // { required: true }); aqui não repetimos essa checagem para não ter duas mensagens divergentes para o mesmo
        // caso — um motivo ausente/vazio cai em CRM: reason é obrigatório..., traduzido por KNOWN_MESSAGES abaixo.
        const picked = readActionBody(await readJsonBody(req), ['reason']);
        const options = hasOwn(picked, 'reason') ? { reason: picked.reason } : {};
        const deleted = await crmService.deleteRecord(context, id, options);
        return respond(200, { deleted: true, id: deleted.id });
      }
      return respond(200, { item: await crmService.updateRecord(context, id, await readJsonBody(req)) });
    }
    if (route.name === 'crm-status') {
      const picked = readActionBody(await readJsonBody(req), ['to', 'reason']);
      const options = hasOwn(picked, 'reason') ? { reason: picked.reason } : {};
      return respond(200, { item: await crmService.moveStatus(context, id, picked.to, options) });
    }
    if (route.name === 'crm-dnc') {
      return respond(200, { item: await crmService.markDoNotContact(context, id, readActionBody(await readJsonBody(req), ['reason'])) });
    }
    // Inalcançável: matchRoute só produz as cinco rotas acima. Existe para que uma rota nova, ainda sem tratamento aqui,
    // nunca caia por omissão numa operação de escrita (marcar DO_NOT_CONTACT).
    throw new HttpError('ROUTE_NOT_FOUND');
  }

  // Funis configuráveis (reestruturação Prospecção/CRM/Funis, Etapa "Funis 1"): cada rota só traduz HTTP <-> uma
  // chamada ao Funnel Service, com o AuthorizationContext do token. A permissão (MANAGE:FUNNELS) é do Service.
  async function dispatchFunnel(req, url, route, context) {
    readQuery(url, []);
    if (route.name === 'funnel-reorder') {
      const body = await readJsonBody(req);
      const picked = readActionBody(body, ['orderedIds']);
      return respond(200, { items: await funnelService.reorderFunnels(context, picked.orderedIds) });
    }
    if (route.name === 'funnel-collection') {
      if (req.method === 'GET') return respond(200, { items: await funnelService.listFunnels(context) });
      return respond(201, { item: await funnelService.createFunnel(context, await readJsonBody(req)) });
    }

    const id = decodeId(route.rawId);
    if (route.name === 'funnel-copy') {
      return respond(201, { item: await funnelService.copyFunnel(context, id, await readJsonBody(req)) });
    }
    if (route.name === 'funnel-stage-reorder') {
      const picked = readActionBody(await readJsonBody(req), ['orderedIds']);
      return respond(200, { items: await funnelService.reorderStages(context, id, picked.orderedIds) });
    }
    if (route.name === 'funnel-stages') {
      if (req.method === 'GET') return respond(200, { items: await funnelService.listStages(context, id) });
      return respond(201, { item: await funnelService.createStage(context, id, await readJsonBody(req)) });
    }
    if (route.name === 'funnel-cards') {
      // Card (Etapa "Funis 2"). GET: os cards ATIVOS deste funil, já enriquecidos com a projeção do CRM. POST: cria
      // um card vinculando um registro do CRM (`crmRecordId`) a este funil, na etapa de menor ordem — corpo
      // { crmRecordId, reason? }; nenhum outro campo (funnelId/stageId/userId/role/permissions...) é aceito.
      if (req.method === 'GET') return respond(200, { items: await funnelService.listCardsByFunnel(context, id) });
      return respond(201, { item: await funnelService.createCard(context, id, await readJsonBody(req)) });
    }
    if (route.name === 'funnel-item') {
      if (req.method === 'GET') {
        const item = await funnelService.getFunnel(context, id);
        if (item === null) throw new HttpError('NOT_FOUND');
        return respond(200, { item });
      }
      if (req.method === 'DELETE') {
        // Sem corpo: nada decide a exclusão de um funil além do id na URL e da autorização do CONTEXTO.
        const deleted = await funnelService.deleteFunnel(context, id);
        return respond(200, { deleted: true, id: deleted.id });
      }
      return respond(200, { item: await funnelService.updateFunnel(context, id, await readJsonBody(req)) });
    }
    if (route.name === 'funnel-stage-item') {
      if (req.method === 'DELETE') {
        const deleted = await funnelService.deleteStage(context, id);
        return respond(200, { deleted: true, id: deleted.id });
      }
      return respond(200, { item: await funnelService.updateStage(context, id, await readJsonBody(req)) });
    }
    if (route.name === 'funnel-card-history') {
      return respond(200, { historico: await funnelService.getCardHistory(context, id) });
    }
    if (route.name === 'funnel-card-item') {
      if (req.method === 'GET') {
        const item = await funnelService.getCard(context, id);
        if (item === null) throw new HttpError('NOT_FOUND');
        return respond(200, { item });
      }
      if (req.method === 'DELETE') {
        // Arquiva (nunca apaga fisicamente — ver funnelDomain.js). Sem corpo: nada decide isso além do id na URL
        // e da autorização do CONTEXTO (WRITE:CRM, hoje só ADMIN).
        const deleted = await funnelService.deleteCard(context, id);
        return respond(200, { deleted: true, id: deleted.id });
      }
      // Mover: corpo { stageId, reason? } — nenhum outro campo decide a movimentação.
      const picked = readActionBody(await readJsonBody(req), ['stageId', 'reason']);
      return respond(200, { item: await funnelService.moveCard(context, id, picked) });
    }
    throw new HttpError('ROUTE_NOT_FOUND');
  }

  // Workbench de Prospecção (Etapa "Prospecção 1"): cada rota só traduz HTTP <-> uma chamada ao Prospecting Brief
  // Service — a autorização (PROPOSE:LEAD_APPROVAL), a validação do brief e as regras de estado são do Service.
  async function dispatchProspectingBrief(req, url, route, context) {
    readQuery(url, []);
    if (route.name === 'brief-collection') {
      if (req.method === 'GET') return respond(200, { items: await prospectingBriefService.listBriefs(context) });
      return respond(201, { item: await prospectingBriefService.createBrief(context, await readJsonBody(req)) });
    }
    const id = decodeId(route.rawId);
    if (route.name === 'brief-item') return respond(200, { item: await prospectingBriefService.getBrief(context, id) });
    if (route.name === 'brief-ready') {
      if (Object.keys(await readJsonBody(req)).length > 0) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
      return respond(200, { item: await prospectingBriefService.markReadyForResearch(context, id) });
    }
    if (route.name === 'brief-package') {
      if (Object.keys(await readJsonBody(req)).length > 0) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
      return respond(200, { item: await prospectingBriefService.generateResearchPackage(context, id) });
    }
    if (route.name === 'brief-findings') {
      // Corpo { rawFindings }: exatamente o contrato já existente de achados brutos (rawFindingV2.js) — o Service
      // repassa ao Prospecting Service real, que valida tudo (nada é reimplementado aqui).
      const body = await readJsonBody(req, MAX_PROSPECTING_BODY_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'rawFindings')) {
        throw new HttpError('INVALID_REQUEST', 'Envie exatamente { rawFindings }.');
      }
      return respond(200, await prospectingBriefService.ingestFindings(context, id, body.rawFindings));
    }
    if (route.name === 'brief-cancel') {
      if (Object.keys(await readJsonBody(req)).length > 0) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
      return respond(200, { item: await prospectingBriefService.cancelBrief(context, id) });
    }
    if (route.name === 'brief-conclude') {
      if (Object.keys(await readJsonBody(req)).length > 0) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
      return respond(200, { item: await prospectingBriefService.markConcluded(context, id) });
    }
    throw new HttpError('ROUTE_NOT_FOUND');
  }

  async function dispatch(req, trace) {
    const url = parseTarget(req);
    const route = matchRoute(url.pathname, {
      crm: crmService !== undefined,
      promotion: crmIntegrationService !== undefined,
      prospecting: prospectingService !== undefined,
      prospectingBatchReads: prospectingHasBatchReads,
      prospectingBrief: prospectingBriefService !== undefined,
      funnels: funnelService !== undefined,
    });
    if (route === null) {
      trace.label = 'static';
      return serveStatic(req, url);
    }
    trace.label = route.label;
    if (route.name === 'unknown') throw new HttpError('ROUTE_NOT_FOUND');
    if (!route.methods.includes(req.method)) throw new HttpError('METHOD_NOT_ALLOWED', undefined, { Allow: route.methods.join(', ') });

    const context = await authenticate(req, trace);

    if (route.family === 'crm') return dispatchCrm(req, url, route, context);
    if (route.family === 'funnel') return dispatchFunnel(req, url, route, context);
    if (route.family === 'prospecting-brief') return dispatchProspectingBrief(req, url, route, context);

    if (route.name === 'prospecting-submit') {
      // Só transporte: sem query, corpo JSON (objeto) de até 4 MiB, e o objeto INTEIRO vai ao serviço — que decide (autoriza
      // PROPOSE e READ do CRM, aceita exatamente { briefing, rawFindings } e deriva autor, lote, datas e contagens). O autor é o
      // `context` desta requisição (a identidade verificada), nunca algo do corpo. O relatório do serviço sai como está.
      readQuery(url, []);
      const submission = await readJsonBody(req, MAX_PROSPECTING_BODY_BYTES);
      return respond(201, await prospectingService.submitProspecting(context, submission));
    }
    if (route.name === 'prospecting-batches') {
      readQuery(url, []);
      return respond(200, { items: await prospectingService.listBatches(context) });
    }
    if (route.name === 'prospecting-batch-item') {
      readQuery(url, []);
      return respond(200, { item: await prospectingService.getBatch(context, decodeId(route.rawId)) });
    }

    if (route.name === 'me') {
      readQuery(url, []);
      return respond(200, projectIdentity(context));
    }
    if (route.name === 'list') {
      const query = readQuery(url, ['estado']);
      const estado = query.has('estado') ? query.get('estado') : DEFAULT_ESTADO;
      return respond(200, { estado, items: approvalQueueService.listQueue(context, { estado }) });
    }

    readQuery(url, []);
    const id = decodeId(route.rawId);
    if (route.name === 'promote') {
      // A ÚNICA entrada é o id do prospect (na URL). O corpo tem de ser {}: nada que decide a promoção vem do cliente —
      // nem estado, nem approvalId, nem actor, nem userId, nem role, nem permissions.
      if (Object.keys(await readJsonBody(req)).length > 0) throw new HttpError('INVALID_REQUEST', 'Campos não permitidos na requisição.');
      const promoted = await crmIntegrationService.promoteProspect(context, id);
      // Resultado SEGURO: só o desfecho, os dois ids e se há sinal de duplicidade (o registro inteiro e a outra
      // identidade não saem daqui).
      return respond(200, {
        outcome: promoted.outcome,
        prospectId: promoted.prospectId,
        crmRecordId: promoted.crmRecordId,
        possivelDuplicidade: promoted.possivelDuplicidade !== null && promoted.possivelDuplicidade !== undefined,
      });
    }
    const reason = readReason(await readJsonBody(req), { required: route.name === 'reject' });
    const options = reason === undefined ? {} : { reason };
    const item =
      route.name === 'approve'
        ? approvalQueueService.approveProspect(context, id, options)
        : approvalQueueService.rejectProspect(context, id, options);
    return respond(200, { item });
  }

  // Toda resposta — de API, de arquivo ou de erro — sai com os cabeçalhos de segurança e o CSP.
  function finalize(response) {
    const headers = { ...response.headers, ...SECURITY_HEADERS, 'Content-Security-Policy': csp };
    if (response.body !== undefined && headers['Content-Length'] === undefined) headers['Content-Length'] = String(Buffer.byteLength(response.body));
    return { ...response, headers };
  }

  // Devolve { status, headers, body }. Nunca lança.
  async function handle(req) {
    const trace = { label: 'request', userId: null, token: null };
    let response;
    try {
      response = await dispatch(req, trace);
    } catch (error) {
      const failure = mapErrorToHttp(error);
      if (failure.status >= 500) log(`erro ${failure.status} em ${req.method} ${trace.label}: ${describeError(error, trace.token)}`);
      response = errorResponse(failure);
    }
    if (trace.label !== 'static') {
      log(`${req.method} ${trace.label} ${response.status}${trace.userId ? ` user=${trace.userId}` : ''}`);
    }
    return finalize(response);
  }

  async function listener(req, res) {
    let response;
    try {
      response = await handle(req);
    } catch (error) {
      response = finalize(errorResponse(mapErrorToHttp(error)));
    }
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  }

  return { handle, listener };
}

module.exports = { createApp, mapErrorToHttp, DEFAULT_ESTADO, MAX_BODY_BYTES, MAX_PROSPECTING_BODY_BYTES };
