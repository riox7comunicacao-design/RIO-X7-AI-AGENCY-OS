// O adapter Supabase de FUNIS, ETAPAS e CARDS (src/crm-adapters/crmSupabaseFunnelRepository.js — Fase D1.1, decisão 0029) contra o PostgREST FALSO (tests/helpers/fakePostgrestCommercial.js, que emula as
// regras da migration). O que importa: o mapeamento, a leitura COMPLETA (nunca uma lista parcial nem "vazia" por falha), as gravações atômicas, o escopo seguro do arquivamento, as contagens que guardam
// exclusões, a classificação dos erros e que nenhum segredo vaza. Nenhuma rede; dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSupabaseFunnelRepository, FUNNEL_REPOSITORY_ERROR, TABLES, RPC } = require('../../src/crm-adapters/crmSupabaseFunnelRepository');
const { FUNNEL_REPOSITORY_ERROR: PORT_ERRORS, REQUIRED_FUNNEL_REPOSITORY_METHODS, OPTIONAL_FUNNEL_REPOSITORY_METHODS, assertValidFunnelRepository } = require('../../src/crm/funnelRepositoryPort');
const { criarPostgrestComercial, resposta } = require('../helpers/fakePostgrestCommercial');

const URL = 'https://exemplo-teste.supabase.co';
const CHAVE = 'chave-de-servico-falsa-so-para-teste';
const uid = (prefixo, n) => `${prefixo}:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const F = (n) => uid('funnel', n);
const E = (n) => uid('stage', n);
const C = (n) => uid('card', n);
const R = (n) => uid('crm', n);
const T = '2026-10-19T12:00:00.000Z';
const QUEM = Object.freeze({ userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' });

function montar({ referencias = 'estritas', ...opcoes } = {}) {
  const db = criarPostgrestComercial({ referencias, ...opcoes });
  const repo = createSupabaseFunnelRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: db.fetchImpl });
  return { db, repo };
}
async function comEstrutura(extras = {}) {
  const m = montar(extras);
  await m.repo.saveFunnel({ id: F(1), nome: 'Vendas', descricao: null, finalidade: null, ativo: true, ordem: 0, config: {}, criadoEm: T });
  for (const [n, nome] of [[1, 'Contato'], [2, 'Proposta'], [3, 'Fechamento']]) await m.repo.saveStage({ id: E(n), funnelId: F(1), nome, ordem: n - 1, ativo: true, config: {}, criadoEm: T });
  m.db.registrarCliente(R(1));
  m.db.registrarCliente(R(2));
  return m;
}
const cardAvulso = (n, extras = {}) => ({ id: C(n), funnelId: F(1), stageId: E(1), crmRecordId: R(n), removedAt: null, criadoEm: T, updatedAt: T, ...extras });
const mover = (cardId, de, para, extras = {}) => ({ cardId, stageFrom: de, stageTo: para, movedBy: QUEM, motivo: null, movedAt: T, ...extras });

test('[SBFUN-1] A PORTA: o adapter cumpre os 18 métodos obrigatórios e oferece as 3 operações opcionais atômicas; os códigos de erro são IDÊNTICOS aos da porta (cópia vigiada)', () => {
  const { repo } = montar();
  assert.doesNotThrow(() => assertValidFunnelRepository(repo));
  for (const metodo of REQUIRED_FUNNEL_REPOSITORY_METHODS) assert.equal(typeof repo[metodo], 'function', metodo);
  for (const metodo of OPTIONAL_FUNNEL_REPOSITORY_METHODS) assert.equal(typeof repo[metodo], 'function', metodo);
  assert.deepEqual({ ...FUNNEL_REPOSITORY_ERROR }, { ...PORT_ERRORS });
  assert.equal(Object.isFrozen(repo), true);
  assert.throws(() => assertValidFunnelRepository({ ...repo, commitCardChange: 'não é função' }), /commitCardChange deve ser uma função/);
});

test('[SBFUN-2] CONFIGURAÇÃO: o adapter exige as duas variáveis (e cita só o NOME da que falta); fetchImpl inválido é erro; nenhuma rede só por criar', () => {
  assert.throws(() => createSupabaseFunnelRepository({ env: { SUPABASE_URL: 'https://x.supabase.co' }, fetchImpl: async () => {} }), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => createSupabaseFunnelRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: 'x' }), /fetchImpl deve ser uma função/);
  let chamadas = 0;
  createSupabaseFunnelRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: async () => { chamadas += 1; } });
  assert.equal(chamadas, 0);
});

test('[SBFUN-3] FUNIS e ETAPAS: gravar (upsert de UMA linha), ler de volta com o mapeamento do domínio, ordem por `ordem`, getById nulo quando não existe; o funil de uma etapa nunca muda (gatilho)', async () => {
  const { repo, db } = await comEstrutura();
  const funis = await repo.listFunnels();
  assert.deepEqual(funis.map((f) => [f.id, f.nome, f.descricao, f.finalidade, f.ativo, f.ordem, f.config, f.criadoEm]), [[F(1), 'Vendas', null, null, true, 0, {}, T]]);
  assert.deepEqual((await repo.listStages(F(1))).map((e) => [e.nome, e.ordem, e.funnelId]), [['Contato', 0, F(1)], ['Proposta', 1, F(1)], ['Fechamento', 2, F(1)]]);
  await repo.saveStage({ id: E(2), funnelId: F(1), nome: 'Proposta enviada', ordem: 1, ativo: false, config: {}, criadoEm: T });
  assert.deepEqual([(await repo.getStage(E(2))).nome, (await repo.getStage(E(2))).ativo], ['Proposta enviada', false]);
  assert.equal(await repo.getFunnel(F(9)), null);
  assert.equal(await repo.getStage(E(9)), null);
  // gravar uma etapa de OUTRO funil por cima da mesma etapa é recusado pelo banco (nenhuma escrita cruzada)
  await repo.saveFunnel({ id: F(2), nome: 'Pós-venda', descricao: 'Texto', finalidade: null, ativo: true, ordem: 1, config: {}, criadoEm: T });
  await assert.rejects(() => repo.saveStage({ id: E(2), funnelId: F(2), nome: 'Roubada', ordem: 0, ativo: true, config: {}, criadoEm: T }), /recusou a operação/);
  assert.equal((await repo.getStage(E(2))).funnelId, F(1));
  // o PostgREST só recebe colunas conhecidas e as chamadas são upserts de uma linha
  const gravacoes = db.escritas().filter((c) => c.caminho === '/rest/v1/crm_funnel_stages');
  assert.ok(gravacoes.every((c) => c.metodo === 'POST' && Array.isArray(c.corpo) && c.corpo.length === 1 && /merge-duplicates/.test(c.prefer)));
});

test('[SBFUN-4] LEITURA COMPLETA: com mais linhas que o teto do servidor a leitura é paginada e traz TUDO; um total que muda, uma faixa que não confere, um Content-Range ausente ou um corpo que não é lista são ERRO — nunca uma lista parcial nem vazia', async () => {
  const { repo, db } = await comEstrutura({ maxRows: 120 });
  for (let n = 100; n < 100 + 1300; n += 1) db.tabelas.crm_funnel_cards.set(C(n), { id: C(n), funnel_id: F(1), stage_id: E(1), crm_record_id: R(n), negotiation_id: null, perdido_em: null, motivo_perdido: null, criado_em: T, updated_at: T, removed_at: n % 10 === 0 ? T : null });
  const ativos = await repo.listCardsByFunnel(F(1));
  assert.equal(ativos.length, 1170, '1300 cards, 130 arquivados: só os ativos, TODOS (paginado em fatias menores que o teto)');
  assert.equal(new Set(ativos.map((c) => c.id)).size, 1170);
  assert.ok(db.chamadas.filter((c) => c.caminho === '/rest/v1/crm_funnel_cards').length > 5, 'várias páginas');
  // o servidor devolve menos do que prometeu no total (corte silencioso): erro
  const cortado = montar({ aoResponder: (n, req) => (req.caminho === '/rest/v1/crm_funnels' ? resposta(200, [{ id: F(1), nome: 'A', ativo: true, ordem: 0 }], { 'content-range': '0-0/5' }) : null) });
  await assert.rejects(() => cortado.repo.listFunnels(), /não puderam ser lidos por completo/);
  for (const [corpo, cabecalho, motivo] of [
    [{ erro: 'x' }, '0-0/1', /não é uma lista/],
    [[{ id: F(1), nome: 'A' }], undefined, /total não pôde ser confirmado/],
    [[{ id: F(1), nome: 'A' }], '0-0/*', /total não pôde ser confirmado/],
    [[{ id: F(1), nome: 'A' }, { id: F(1), nome: 'B' }], '0-1/2', /apareceu duas vezes/],
    [[{ nome: 'sem id' }], '0-0/1', /formato inesperado/],
    [[{ id: F(1), nome: 'A' }], '5-5/1', /faixa devolvida/],
  ]) {
    const m = montar({ aoResponder: (n, req) => (req.caminho === '/rest/v1/crm_funnels' ? resposta(200, corpo, cabecalho === undefined ? {} : { 'content-range': cabecalho }) : null) });
    await assert.rejects(() => m.repo.listFunnels(), motivo, JSON.stringify(corpo).slice(0, 40));
  }
  // uma falha de leitura (5xx, rede) NUNCA vira lista vazia
  const quebrado = montar({ aoResponder: () => resposta(503, 'indisponível') });
  await assert.rejects(() => quebrado.repo.listFunnels(), /HTTP 503/);
  await assert.rejects(() => quebrado.repo.listCardsByFunnel(F(1)), /HTTP 503/);
  const semRede = createSupabaseFunnelRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: async () => { throw Object.assign(new Error('socket-segredo-interno'), { name: 'TypeError' }); } });
  await assert.rejects(() => semRede.listFunnels(), (e) => /falha de rede/.test(e.message) && !/socket-segredo-interno/.test(e.message));
});

test('[SBFUN-5] CARDS AVULSOS: criar e mover são UMA transação (card + histórico); o histórico volta com quem moveu (com o papel); a unicidade "um card ativo por cliente e funil" vale só entre avulsos e vira o código FUNNEL_CARD_DUPLICATE', async () => {
  const { repo, db } = await comEstrutura();
  await repo.commitCardChange({ card: cardAvulso(1), move: mover(C(1), null, E(1), { motivo: 'entrou' }), expectedStageId: null });
  assert.equal(db.rpcs(RPC.card).length, 1, 'uma única chamada transacional');
  assert.deepEqual((await repo.getCard(C(1))), { id: C(1), funnelId: F(1), stageId: E(1), crmRecordId: R(1), removedAt: null, criadoEm: T, updatedAt: (await repo.getCard(C(1))).updatedAt });
  assert.equal((await repo.getCard(C(1))).negotiationId, undefined, 'um card avulso não tem negotiationId');
  assert.deepEqual(await repo.listCardMoves(C(1)), [{ cardId: C(1), stageFrom: null, stageTo: E(1), movedBy: QUEM, motivo: 'entrou', movedAt: T }]);
  await repo.commitCardChange({ card: cardAvulso(1, { stageId: E(2) }), move: mover(C(1), E(1), E(2)), expectedStageId: E(1) });
  assert.equal((await repo.getCard(C(1))).stageId, E(2));
  assert.equal((await repo.listCardMoves(C(1))).length, 2);
  // concorrência: quem leu o card na etapa antiga e tenta mover recebe o CONFLITO (e nada muda)
  await assert.rejects(() => repo.commitCardChange({ card: cardAvulso(1, { stageId: E(3) }), move: mover(C(1), E(1), E(3)), expectedStageId: E(1) }), (e) => e.code === FUNNEL_REPOSITORY_ERROR.CONFLICT);
  assert.equal((await repo.getCard(C(1))).stageId, E(2));
  assert.equal((await repo.listCardMoves(C(1))).length, 2);
  // duplicado: o mesmo cliente no mesmo funil
  await assert.rejects(() => repo.commitCardChange({ card: cardAvulso(2, { crmRecordId: R(1) }), move: mover(C(2), null, E(1)), expectedStageId: null }), (e) => e.code === FUNNEL_REPOSITORY_ERROR.DUPLICATE_CARD);
  assert.equal(db.tabelas.crm_funnel_cards.has(C(2)), false, 'o card duplicado não ficou, nem o movimento dele');
  assert.equal(db.tabelas.crm_funnel_card_moves.filter((m) => m.card_id === C(2)).length, 0);
  // etapa de OUTRO funil: recusada pelo gatilho de integridade, com o código da regra
  await repo.saveFunnel({ id: F(2), nome: 'Outro', descricao: null, finalidade: null, ativo: true, ordem: 1, config: {}, criadoEm: T });
  await repo.saveStage({ id: E(9), funnelId: F(2), nome: 'De outro funil', ordem: 0, ativo: true, config: {}, criadoEm: T });
  await assert.rejects(() => repo.commitCardChange({ card: cardAvulso(3, { stageId: E(9) }), move: mover(C(3), null, E(9)), expectedStageId: null }), (e) => e.code === FUNNEL_REPOSITORY_ERROR.STAGE_MISMATCH);
});

test('[SBFUN-6] O HISTÓRICO É OBRIGATÓRIO E NUNCA ANÔNIMO: sem quem moveu (userId, name e role) o adapter RECUSA antes de enviar; falha no meio da transação não deixa o card nem o movimento; o histórico não se altera nem se apaga', async () => {
  const { repo, db } = await comEstrutura();
  const enviadasAntes = db.escritas().length;
  for (const movedBy of [null, { userId: 'u', name: 'n' }, { userId: ' ', name: 'n', role: 'ADMIN' }, { userId: 'u', name: '', role: 'ADMIN' }]) {
    await assert.rejects(() => repo.commitCardChange({ card: cardAvulso(1), move: mover(C(1), null, E(1), { movedBy }), expectedStageId: null }), /nunca anônimo/);
    await assert.rejects(() => repo.saveCardMove(mover(C(1), null, E(1), { movedBy })), /nunca anônimo/);
  }
  assert.equal(db.escritas().length, enviadasAntes, 'nada foi enviado');
  // cliente que não existe (FK): a transação inteira é revertida — nem o card, nem o movimento
  await assert.rejects(() => repo.commitCardChange({ card: cardAvulso(5, { crmRecordId: R(77) }), move: mover(C(5), null, E(1)), expectedStageId: null }), /recusou a operação/);
  assert.deepEqual([db.tabelas.crm_funnel_cards.size, db.tabelas.crm_funnel_card_moves.length], [0, 0]);
  // o histórico é imutável: o banco recusa UPDATE e DELETE direto
  await repo.commitCardChange({ card: cardAvulso(1), move: mover(C(1), null, E(1)), expectedStageId: null });
  for (const metodo of ['PATCH', 'DELETE']) {
    const r = await db.fetchImpl(`${URL}/rest/v1/crm_funnel_card_moves?card_id=eq.${C(1)}`, { method: metodo, headers: {}, body: metodo === 'PATCH' ? JSON.stringify({ motivo: 'adulterado' }) : undefined });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(await r.text()).message, /histórico imutável/);
  }
  assert.equal((await repo.listCardMoves(C(1))).length, 1);
});

test('[SBFUN-7] ARQUIVAR: só um card ATIVO e SEM negociação é arquivado (o card de uma negociação nunca); a linha e o histórico continuam; o card arquivado deixa o quadro mas continua guardando a exclusão do funil, da etapa e do cliente', async () => {
  const { repo, db } = await comEstrutura();
  await repo.commitCardChange({ card: cardAvulso(1), move: mover(C(1), null, E(1)), expectedStageId: null });
  db.tabelas.crm_funnel_cards.set(C(7), { ...db.tabelas.crm_funnel_cards.get(C(1)), id: C(7), crm_record_id: R(2), negotiation_id: 'negotiation:x' }); // simula um card de negociação
  await repo.archiveCard(C(7));
  assert.equal((await repo.getCard(C(7))).removedAt, null, 'o card de negociação não foi arquivado por aqui');
  const alvo = db.chamadas.filter((c) => c.metodo === 'PATCH').at(-1).query;
  assert.deepEqual([alvo.id, alvo.removed_at, alvo.negotiation_id], [`eq.${C(7)}`, 'is.null', 'is.null'], 'o PATCH leva o escopo seguro');
  await repo.archiveCard(C(1));
  assert.notEqual((await repo.getCard(C(1))).removedAt, null);
  assert.deepEqual((await repo.listCardsByFunnel(F(1))).map((c) => c.id), [C(7)], 'o arquivado saiu do quadro');
  assert.equal((await repo.listCardMoves(C(1))).length, 1, 'o histórico continua');
  // as guardas de exclusão contam TAMBÉM os arquivados (o banco os mantém ligados ao funil, à etapa e ao cliente)
  assert.equal(await repo.countCardsByFunnel(F(1)), 2);
  assert.equal(await repo.countCardsByStage(E(1)), 2);
  assert.equal(await repo.countActiveCardsByCrmRecord(R(1)), 1, 'o cliente com card arquivado continua protegido da exclusão');
  assert.equal(await repo.countActiveCardsByCrmRecord(R(2)), 1);
  assert.equal(await repo.countActiveCardsByCrmRecord(R(3)), 0);
  // a busca do card avulso ignora os de negociação e os arquivados
  assert.equal(await repo.getCardByFunnelAndRecord(F(1), R(1)), null);
  assert.equal(await repo.getCardByFunnelAndRecord(F(1), R(2)), null, 'o card de negociação não conta como o "card avulso" do cliente');
  // a contagem nunca vira 0 por engano: se o total não pode ser confirmado, erro
  const cego = montar({ aoResponder: () => resposta(200, [], {}) });
  await assert.rejects(() => cego.repo.countCardsByFunnel(F(1)), /total não pôde ser confirmado/);
});

test('[SBFUN-8] ETAPAS: reordenar é UMA transação (todas as posições ou nenhuma; a lista tem de ser exatamente as etapas do funil); excluir etapa e funil vão pelas funções com guarda (nunca DELETE solto), atômicas e recusadas com cards', async () => {
  const { repo, db } = await comEstrutura();
  await repo.reorderStages(F(1), [E(3), E(1), E(2)]);
  assert.deepEqual((await repo.listStages(F(1))).map((e) => e.nome), ['Fechamento', 'Contato', 'Proposta']);
  assert.equal(db.rpcs(RPC.reorder).length, 1);
  for (const lista of [[E(1), E(2)], [E(1), E(1), E(2)], [E(1), E(2), E(9)], []]) {
    await assert.rejects(() => repo.reorderStages(F(1), lista), /recusou a operação/);
  }
  assert.deepEqual((await repo.listStages(F(1))).map((e) => e.nome), ['Fechamento', 'Contato', 'Proposta'], 'a recusa não mudou nenhuma posição');
  await assert.rejects(() => repo.reorderStages(F(1), 'não é lista'), /lista de ids/);
  // excluir com card: recusado com o código da guarda; sem card: sai (a etapa; o funil leva as suas etapas)
  await repo.commitCardChange({ card: cardAvulso(1), move: mover(C(1), null, E(1)), expectedStageId: null });
  await assert.rejects(() => repo.deleteStage(E(1)), (e) => e.code === FUNNEL_REPOSITORY_ERROR.STAGE_HAS_CARDS);
  await assert.rejects(() => repo.deleteFunnelCascade(F(1)), (e) => e.code === FUNNEL_REPOSITORY_ERROR.FUNNEL_HAS_CARDS);
  assert.equal((await repo.listStages(F(1))).length, 3, 'a recusa não apagou nada (atômica)');
  await repo.deleteStage(E(2));
  assert.equal((await repo.listStages(F(1))).length, 2);
  await repo.saveFunnel({ id: F(2), nome: 'Vazio', descricao: null, finalidade: null, ativo: true, ordem: 1, config: {}, criadoEm: T });
  await repo.saveStage({ id: E(8), funnelId: F(2), nome: 'Única', ordem: 0, ativo: true, config: {}, criadoEm: T });
  await repo.deleteFunnelCascade(F(2));
  assert.equal(await repo.getFunnel(F(2)), null);
  assert.equal(await repo.getStage(E(8)), null, 'a etapa saiu junto, na mesma transação');
  // nenhuma exclusão usou um DELETE direto
  assert.equal(db.chamadas.filter((c) => c.metodo === 'DELETE').length, 0);
});

test('[SBFUN-9] ERROS e SEGREDOS: erros desconhecidos saem SEM `code`; a mensagem cita só o status (nunca o corpo do PostgREST); a chave de serviço vai só no cabeçalho; ids perigosos e vazios são recusados antes de enviar', async () => {
  const quebrado = montar({ aoResponder: (n, req) => (req.metodo === 'POST' ? resposta(500, { code: 'XX000', message: 'detalhe-secreto-do-banco com dados do cliente' }) : null) });
  await assert.rejects(() => quebrado.repo.saveFunnel({ id: F(1), nome: 'A', ativo: true, ordem: 0 }), (e) => e.code === undefined && /HTTP 500/.test(e.message) && !/detalhe-secreto|dados do cliente/.test(e.message) && !e.message.includes(CHAVE));
  const { repo, db } = await comEstrutura();
  await repo.listFunnels();
  for (const chamada of db.chamadas) assert.equal(JSON.stringify(chamada.corpo ?? null).includes(CHAVE), false, 'a chave nunca vai no corpo');
  for (const id of ['', '__proto__', 'constructor', undefined, 5]) {
    await assert.rejects(() => repo.getFunnel(id), /id de funil/);
    await assert.rejects(() => repo.getCard(id), /id de card/);
  }
  assert.equal(TABLES.cards, 'crm_funnel_cards');
});
