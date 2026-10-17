// O adapter Supabase de NEGOCIAÇÕES (src/crm-adapters/crmSupabaseNegotiationRepository.js — Fase D1.1, decisão 0029) contra o PostgREST FALSO (tests/helpers/fakePostgrestCommercial.js), que emula as regras
// da migration 20261019090000_crm_negotiations.sql. O que importa: a gravação da negociação, do histórico e do card é UMA transação (nada pela metade), o histórico só cresce, a concorrência é otimista,
// o dinheiro é centavos exatos, as regras do banco (cliente, funil, etapa, serviço, situação) valem mesmo fora do domínio e a leitura é completa ou erro. Nenhuma rede; dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSupabaseNegotiationRepository, NEGOTIATION_REPOSITORY_ERROR, COMMIT_RPC } = require('../../src/crm-adapters/crmSupabaseNegotiationRepository');
const { createSupabaseFunnelRepository } = require('../../src/crm-adapters/crmSupabaseFunnelRepository');
const { NEGOTIATION_REPOSITORY_ERROR: PORT_ERRORS, REQUIRED_NEGOTIATION_REPOSITORY_METHODS, OPTIONAL_NEGOTIATION_REPOSITORY_METHODS, assertValidNegotiationRepository } = require('../../src/crm/negotiationRepositoryPort');
const { toCents } = require('../../src/crm/negotiationFinance');
const { criarPostgrestComercial, resposta } = require('../helpers/fakePostgrestCommercial');

const URL = 'https://exemplo-teste.supabase.co';
const CHAVE = 'chave-de-servico-falsa-so-para-teste';
const uid = (prefixo, n) => `${prefixo}:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const F = (n) => uid('funnel', n);
const E = (n) => uid('stage', n);
const C = (n) => uid('card', n);
const R = (n) => uid('crm', n);
const N = (n) => uid('negotiation', n);
const S = (n) => uid('service', n);
const T = '2026-10-19T12:00:00.000Z';
const T1 = '2026-10-19T13:00:00.000Z';
const T2 = '2026-10-19T14:00:00.000Z';
const QUEM = Object.freeze({ userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' });

async function montar({ referencias = 'estritas', ...opcoes } = {}) {
  const db = criarPostgrestComercial({ referencias, ...opcoes });
  const funis = createSupabaseFunnelRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: db.fetchImpl });
  const repo = createSupabaseNegotiationRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: db.fetchImpl });
  await funis.saveFunnel({ id: F(1), nome: 'Vendas', descricao: null, finalidade: null, ativo: true, ordem: 0, config: {}, criadoEm: T });
  for (const [n, nome] of [[1, 'Contato'], [2, 'Proposta'], [3, 'Fechamento']]) await funis.saveStage({ id: E(n), funnelId: F(1), nome, ordem: n - 1, ativo: true, config: {}, criadoEm: T });
  for (let n = 1; n <= 3; n += 1) db.registrarCliente(R(n));
  db.registrarServico(S(1));
  db.registrarServico(S(2), { permite_pagamento_recorrente: false, periodicidades: [] });
  return { db, repo, funis };
}
const evento = (tipo, em, detalhe) => ({ tipo, em, porUserId: QUEM.userId, porNome: QUEM.name, ...(detalhe === undefined ? {} : { detalhe }) });
const negociacao = (n = 1, extras = {}) => ({
  id: N(n), crmRecordId: R(1), funnelId: F(1), cardId: C(n), serviceId: S(1), servicoNome: 'Gestão de redes', responsavelUserId: QUEM.userId, responsavelNome: QUEM.name, prazoMeses: 12,
  formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, previsaoFechamento: null, situacao: 'ABERTA', motivoPerda: null, fechadoEm: null, criadoEm: T, atualizadoEm: T,
  criadoPorUserId: QUEM.userId, criadoPorNome: QUEM.name, atualizadoPorUserId: QUEM.userId, atualizadoPorNome: QUEM.name, eventos: [evento('CRIADA', T, { etapaId: E(1) })], ...extras,
});
const card = (n = 1, etapa = E(1), cliente = R(1)) => ({ id: C(n), funnelId: F(1), stageId: etapa, crmRecordId: cliente, negotiationId: N(n), criadoEm: T, updatedAt: T });
const movimento = (n, de, para, em = T) => ({ cardId: C(n), stageFrom: de, stageTo: para, movedBy: QUEM, motivo: null, movedAt: em });
const criar = (m, n = 1, extras = {}) => m.repo.commit({ mode: 'create', negotiation: negociacao(n, extras), card: card(n, E(1), (extras.crmRecordId ?? R(1))), cardMove: movimento(n, null, E(1)) });
const mudar = (m, atual, alteracoes, novoEvento, opcoes = {}) => m.repo.commit({
  mode: 'update',
  negotiation: { ...atual, ...alteracoes, atualizadoEm: T1, eventos: [...atual.eventos, ...(novoEvento ? [novoEvento] : [])] },
  expectedUpdatedAt: atual.atualizadoEm,
  ...opcoes,
});
const rejeita = (codigo) => (erro) => erro.code === codigo;
const vazio = (db) => [db.tabelas.crm_negotiations.size, db.tabelas.crm_negotiation_events.length, db.tabelas.crm_funnel_cards.size, db.tabelas.crm_funnel_card_moves.length].every((n) => n === 0);

test('[SBNEG-1] A PORTA: list/getById/save + commit opcional; os códigos de erro são IDÊNTICOS aos da porta (cópia vigiada); configuração exige as duas variáveis e nenhuma rede acontece só por criar', () => {
  const repo = createSupabaseNegotiationRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: async () => { throw new Error('nenhuma rede ao criar'); } });
  assert.doesNotThrow(() => assertValidNegotiationRepository(repo));
  for (const metodo of [...REQUIRED_NEGOTIATION_REPOSITORY_METHODS, ...OPTIONAL_NEGOTIATION_REPOSITORY_METHODS]) assert.equal(typeof repo[metodo], 'function', metodo);
  assert.deepEqual({ ...NEGOTIATION_REPOSITORY_ERROR }, { ...PORT_ERRORS });
  assert.equal(Object.isFrozen(repo), true);
  assert.throws(() => createSupabaseNegotiationRepository({ env: { SUPABASE_SERVICE_ROLE_KEY: 'k' }, fetchImpl: async () => {} }), /SUPABASE_URL/);
  assert.throws(() => createSupabaseNegotiationRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: 5 }), /fetchImpl deve ser uma função/);
  assert.throws(() => assertValidNegotiationRepository({ ...repo, commit: 'x' }), /commit deve ser uma função/);
});

test('[SBNEG-2] CRIAR é UMA chamada transacional: o card, o primeiro movimento do card, a negociação e o histórico entram juntos; o valor vai em CENTAVOS inteiros; TCV/MRR/valorProposta nunca são enviados; ler devolve exatamente o que foi gravado', async () => {
  const m = await montar();
  await criar(m, 1, { valorNegociado: 1500.5, previsaoFechamento: '2026-12-31' });
  assert.equal(m.db.rpcs(COMMIT_RPC).length, 1);
  const corpo = m.db.rpcs(COMMIT_RPC)[0].corpo;
  assert.deepEqual(Object.keys(corpo).sort(), ['p_card', 'p_card_move', 'p_expected_updated_at', 'p_mode', 'p_negotiation']);
  assert.equal(corpo.p_negotiation.valorCentavos, 150050);
  assert.equal(corpo.p_negotiation.valorNegociado, undefined, 'o valor em reais não vai ao banco');
  const texto = JSON.stringify(corpo);
  for (const proibido of ['tcv', 'mrr', 'equivalente', 'valorProposta', 'valorTotal', 'financeiro', 'valorRecebido', CHAVE]) assert.equal(texto.toLowerCase().includes(proibido.toLowerCase()), false, proibido);
  assert.equal(corpo.p_expected_updated_at, null);
  assert.deepEqual([m.db.tabelas.crm_negotiations.size, m.db.tabelas.crm_negotiation_events.length, m.db.tabelas.crm_funnel_cards.size, m.db.tabelas.crm_funnel_card_moves.length], [1, 1, 1, 1]);
  assert.equal(m.db.tabelas.crm_funnel_cards.get(C(1)).negotiation_id, N(1), 'o card sabe a que negociação pertence');
  const lida = await m.repo.getById(N(1));
  assert.deepEqual(lida, negociacao(1, { valorNegociado: 1500.5, previsaoFechamento: '2026-12-31' }));
  assert.deepEqual(await m.repo.list(), [lida]);
  assert.equal(await m.repo.getById(N(9)), null);
});

test('[SBNEG-3] ATUALIZAR: o histórico CRESCE (só os eventos novos entram), a mudança de etapa move o card e registra o movimento NA MESMA transação, a concorrência é otimista (conflito -> código, nada muda) e uma negociação inexistente é NOT_FOUND', async () => {
  const m = await montar();
  await criar(m, 1);
  const a = await m.repo.getById(N(1));
  await mudar(m, a, { valorNegociado: 1800 }, evento('ATUALIZADA', T1, { alteracoes: [{ campo: 'valorNegociado', de: 1500, para: 1800 }] }));
  const b = await m.repo.getById(N(1));
  assert.deepEqual([b.valorNegociado, b.eventos.map((e) => e.tipo), b.atualizadoEm], [1800, ['CRIADA', 'ATUALIZADA'], T1]);
  // mudar de etapa: o card, o movimento e o evento juntos
  await m.repo.commit({
    mode: 'update',
    negotiation: { ...b, atualizadoEm: T2, eventos: [...b.eventos, evento('ETAPA', T2, { deEtapaId: E(1), paraEtapaId: E(2) })] },
    expectedUpdatedAt: b.atualizadoEm,
    card: card(1, E(2)),
    cardMove: movimento(1, E(1), E(2), T2),
  });
  assert.equal(m.db.tabelas.crm_funnel_cards.get(C(1)).stage_id, E(2));
  assert.deepEqual(m.db.tabelas.crm_funnel_card_moves.map((x) => [x.stage_from, x.stage_to]), [[null, E(1)], [E(1), E(2)]]);
  assert.deepEqual((await m.repo.getById(N(1))).eventos.map((e) => e.tipo), ['CRIADA', 'ATUALIZADA', 'ETAPA']);
  // concorrência: outra pessoa leu `a` (versão antiga) e tenta gravar por cima
  const antes = JSON.stringify([...m.db.tabelas.crm_negotiations.values()]);
  await assert.rejects(() => mudar(m, a, { valorNegociado: 9999 }, evento('ATUALIZADA', T2)), rejeita(NEGOTIATION_REPOSITORY_ERROR.CONFLICT));
  assert.equal(JSON.stringify([...m.db.tabelas.crm_negotiations.values()]), antes, 'o conflito não mudou nada');
  assert.equal(m.db.tabelas.crm_negotiation_events.length, 3);
  // inexistente
  await assert.rejects(() => m.repo.commit({ mode: 'update', negotiation: negociacao(9), expectedUpdatedAt: T }), rejeita(NEGOTIATION_REPOSITORY_ERROR.NOT_FOUND));
});

test('[SBNEG-4] O HISTÓRICO É IMUTÁVEL E OBRIGATÓRIO: uma gravação sem evento novo, com o histórico encolhido ou com um evento antigo alterado é recusada (REJECTED) e nada muda; o banco recusa UPDATE/DELETE diretos nos eventos', async () => {
  const m = await montar();
  await criar(m, 1);
  const a = await m.repo.getById(N(1));
  const ate = { ...a, valorNegociado: 2000, atualizadoEm: T1 };
  const tentativas = [
    { ...ate }, // nenhum evento novo
    { ...ate, eventos: [] }, // histórico vazio
    { ...ate, eventos: [{ ...a.eventos[0], porNome: 'Outra Pessoa' }, evento('ATUALIZADA', T1)] }, // evento antigo alterado
    { ...ate, eventos: [{ ...a.eventos[0], detalhe: { etapaId: 'forjada' } }, evento('ATUALIZADA', T1)] },
    { ...ate, eventos: [evento('ATUALIZADA', T1)] }, // o antigo sumiu e o novo ocupa a posição dele
  ];
  for (const negotiation of tentativas) {
    await assert.rejects(() => m.repo.commit({ mode: 'update', negotiation, expectedUpdatedAt: a.atualizadoEm }), (e) => e.code === NEGOTIATION_REPOSITORY_ERROR.REJECTED || /histórico obrigatório/.test(e.message), JSON.stringify(negotiation.eventos).slice(0, 60));
  }
  assert.deepEqual(await m.repo.getById(N(1)), a, 'nenhuma tentativa alterou a negociação nem o histórico');
  for (const metodo of ['PATCH', 'DELETE']) {
    const r = await m.db.fetchImpl(`${URL}/rest/v1/crm_negotiation_events?negotiation_id=eq.${N(1)}`, { method: metodo, headers: {}, body: metodo === 'PATCH' ? JSON.stringify({ tipo: 'GANHA' }) : undefined });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(await r.text()).message, /histórico imutável/);
  }
  assert.equal(m.db.tabelas.crm_negotiation_events.length, 1);
});

test('[SBNEG-5] SITUAÇÃO NO BANCO: ganhar e perder (com motivo) a partir de ABERTA; fechada não edita nem muda de etapa (CLOSED); reabrir volta a ABERTA; as restrições de coerência (perdida sem motivo, aberta com fechadoEm) são recusadas; cliente, funil e card nunca mudam', async () => {
  const m = await montar();
  await criar(m, 1);
  const a = await m.repo.getById(N(1));
  await assert.rejects(() => mudar(m, a, { situacao: 'PERDIDA', fechadoEm: T1, motivoPerda: null }, evento('PERDIDA', T1, {})), /recusou a operação/, 'perdida exige motivo');
  await assert.rejects(() => mudar(m, a, { situacao: 'ABERTA', fechadoEm: T1 }, evento('ATUALIZADA', T1)), /recusou a operação/, 'aberta não tem fechadoEm');
  for (const alteracao of [{ crmRecordId: R(2) }, { funnelId: F(1), cardId: C(5) }, { criadoPorUserId: 'outro' }]) {
    await assert.rejects(() => mudar(m, a, alteracao, evento('ATUALIZADA', T1)), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED));
  }
  await mudar(m, a, { situacao: 'PERDIDA', fechadoEm: T1, motivoPerda: 'Sem orçamento' }, evento('PERDIDA', T1, { motivo: 'Sem orçamento' }));
  const perdida = await m.repo.getById(N(1));
  assert.deepEqual([perdida.situacao, perdida.motivoPerda, perdida.fechadoEm], ['PERDIDA', 'Sem orçamento', T1]);
  // fechada: editar ou mover de etapa é recusado com CLOSED
  await assert.rejects(() => mudar(m, { ...perdida, atualizadoEm: T1 }, { valorNegociado: 5 }, evento('ATUALIZADA', T2)), rejeita(NEGOTIATION_REPOSITORY_ERROR.CLOSED));
  await assert.rejects(() => m.repo.commit({ mode: 'update', negotiation: { ...perdida, atualizadoEm: T2, eventos: [...perdida.eventos, evento('ETAPA', T2)] }, expectedUpdatedAt: perdida.atualizadoEm, card: card(1, E(2)), cardMove: movimento(1, E(1), E(2), T2) }), rejeita(NEGOTIATION_REPOSITORY_ERROR.CLOSED));
  assert.equal(m.db.tabelas.crm_funnel_cards.get(C(1)).stage_id, E(1), 'o card não saiu da etapa');
  // reabrir: volta a ABERTA, com o histórico acumulado
  await mudar(m, perdida, { situacao: 'ABERTA', fechadoEm: null, motivoPerda: null, atualizadoEm: T2 }, evento('REABERTA', T2, { de: 'PERDIDA' }));
  const reaberta = await m.repo.getById(N(1));
  assert.deepEqual([reaberta.situacao, reaberta.motivoPerda, reaberta.fechadoEm, reaberta.eventos.map((e) => e.tipo)], ['ABERTA', null, null, ['CRIADA', 'PERDIDA', 'REABERTA']]);
  // ganhar
  await mudar(m, reaberta, { situacao: 'GANHA', fechadoEm: T2 }, evento('GANHA', T2));
  assert.equal((await m.repo.getById(N(1))).situacao, 'GANHA');
});

test('[SBNEG-6] ATOMICIDADE REAL: se qualquer parte da transação falha, NADA fica — criar com um evento inválido não deixa card, movimento nem negociação; mudar de etapa com um evento inválido não move o card nem grava o movimento', async () => {
  const m = await montar();
  await assert.rejects(() => m.repo.commit({ mode: 'create', negotiation: negociacao(1, { eventos: [{ ...evento('CRIADA', T), tipo: 'INVENTADO' }] }), card: card(1), cardMove: movimento(1, null, E(1)) }), /recusou a operação/);
  assert.equal(vazio(m.db), true, 'nem card, nem movimento, nem negociação');
  await criar(m, 1);
  const a = await m.repo.getById(N(1));
  const instantaneo = JSON.stringify([[...m.db.tabelas.crm_funnel_cards.values()], m.db.tabelas.crm_funnel_card_moves, [...m.db.tabelas.crm_negotiations.values()], m.db.tabelas.crm_negotiation_events]);
  await assert.rejects(() => m.repo.commit({ mode: 'update', negotiation: { ...a, atualizadoEm: T1, eventos: [...a.eventos, { ...evento('ETAPA', T1), tipo: 'INVENTADO' }] }, expectedUpdatedAt: a.atualizadoEm, card: card(1, E(2)), cardMove: movimento(1, E(1), E(2), T1) }), /recusou a operação/);
  assert.equal(JSON.stringify([[...m.db.tabelas.crm_funnel_cards.values()], m.db.tabelas.crm_funnel_card_moves, [...m.db.tabelas.crm_negotiations.values()], m.db.tabelas.crm_negotiation_events]), instantaneo, 'o card voltou ao que era e nenhum movimento ficou');
  // uma falha do servidor (5xx) no meio: o adapter sobe o erro SEM code e sem vazar a mensagem; nada foi gravado
  m.db.falhar(COMMIT_RPC, resposta(500, { code: 'XX000', message: 'segredo-do-banco' }));
  await assert.rejects(() => mudar(m, a, { valorNegociado: 1 }, evento('ATUALIZADA', T1)), (e) => e.code === undefined && !/segredo-do-banco/.test(e.message) && /HTTP 500/.test(e.message));
  assert.deepEqual(await m.repo.getById(N(1)), a);
});

test('[SBNEG-7] AS REGRAS DO BANCO VALEM MESMO FORA DO DOMÍNIO (defesa em profundidade): cliente "Não Contatar", funil inativo, etapa inativa, serviço inativo ou que não permite a forma/periodicidade, e cliente ou serviço inexistentes recusam a criação — e nada fica', async () => {
  const m = await montar();
  m.db.mudarStatusCliente(R(2), 'DO_NOT_CONTACT');
  await assert.rejects(() => criar(m, 1, { crmRecordId: R(2) }), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED));
  await assert.rejects(() => criar(m, 2, { crmRecordId: R(99) }), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED));
  m.db.mudarServico(S(1), { ativo: false });
  await assert.rejects(() => criar(m, 3), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED));
  m.db.mudarServico(S(1), { ativo: true });
  await assert.rejects(() => criar(m, 4, { serviceId: S(2) }), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED), 'recorrente num serviço só único');
  await assert.rejects(() => criar(m, 5, { formaPagamento: 'RECORRENTE', periodicidade: 'ANUAL' }), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED), 'periodicidade que o serviço não aceita');
  await assert.rejects(() => criar(m, 6, { serviceId: S(77) }), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED));
  await assert.rejects(() => criar(m, 7, { prazoMeses: 10, periodicidade: 'TRIMESTRAL' }), /recusou a operação/, 'prazo que não fecha com a periodicidade (CHECK)');
  await assert.rejects(() => criar(m, 8, { formaPagamento: 'UNICO', periodicidade: 'MENSAL' }), /recusou a operação/, 'único com periodicidade (CHECK)');
  assert.equal(vazio(m.db), true);
  await m.funis.saveFunnel({ id: F(1), nome: 'Vendas', descricao: null, finalidade: null, ativo: false, ordem: 0, config: {}, criadoEm: T });
  await assert.rejects(() => criar(m, 9), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED), 'funil inativo');
  await m.funis.saveFunnel({ id: F(1), nome: 'Vendas', descricao: null, finalidade: null, ativo: true, ordem: 0, config: {}, criadoEm: T });
  await m.funis.saveStage({ id: E(1), funnelId: F(1), nome: 'Contato', ordem: 0, ativo: false, config: {}, criadoEm: T });
  await assert.rejects(() => criar(m, 10), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED), 'etapa inicial inativa');
  assert.equal(vazio(m.db), true);
  await m.funis.saveStage({ id: E(1), funnelId: F(1), nome: 'Contato', ordem: 0, ativo: true, config: {}, criadoEm: T });
  await criar(m, 11);
  // depois de criada, mudar o preço NÃO reconfere o serviço (que pode ter mudado de regras): só a troca de serviço/forma/periodicidade reconfere
  m.db.mudarServico(S(1), { ativo: false, permite_pagamento_recorrente: false, periodicidades: [] });
  const a = await m.repo.getById(N(11));
  await mudar(m, a, { valorNegociado: 1700 }, evento('ATUALIZADA', T1));
  assert.equal((await m.repo.getById(N(11))).valorNegociado, 1700);
  const atualizada = await m.repo.getById(N(11));
  await assert.rejects(() => mudar(m, atualizada, { periodicidade: 'TRIMESTRAL' }, evento('ATUALIZADA', T2)), rejeita(NEGOTIATION_REPOSITORY_ERROR.REJECTED));
});

test('[SBNEG-8] DINHEIRO EM CENTAVOS: valores exatos viram inteiros; mais de duas casas, zero, negativo, NaN, texto e acima do teto são RECUSADOS antes de enviar (nunca arredondados em silêncio); a leitura recusa centavos inválidos; a conta é a MESMA do domínio', async () => {
  const m = await montar();
  const aceitos = [0.01, 0.1 + 0.2, 1500, 1500.5, 99999999.99, 1000000000];
  for (const [i, valor] of aceitos.entries()) {
    await m.repo.commit({ mode: 'create', negotiation: negociacao(20 + i, { valorNegociado: valor, formaPagamento: 'UNICO', periodicidade: null, prazoMeses: 6 }), card: card(20 + i, E(1), R(1)), cardMove: movimento(20 + i, null, E(1)) });
    const gravado = m.db.tabelas.crm_negotiations.get(N(20 + i)).valor_centavos;
    assert.equal(gravado, toCents(valor), `${valor} -> ${gravado} centavos, como no domínio`);
    assert.equal(Number.isInteger(gravado), true);
  }
  const antes = m.db.escritas().length;
  for (const invalido of [12.345, 0, -5, NaN, Infinity, '1500', null, 1000000001, 0.001]) {
    await assert.rejects(() => m.repo.commit({ mode: 'create', negotiation: negociacao(50, { valorNegociado: invalido }), card: card(50), cardMove: movimento(50, null, E(1)) }), /valorNegociado/, String(invalido));
  }
  assert.equal(m.db.escritas().length, antes, 'nada foi enviado');
  // a leitura: BIGINT pode vir como texto; centavos inválidos numa linha são erro, nunca um valor inventado
  const texto = await montar({ bigintComoTexto: true });
  await criar(texto, 1, { valorNegociado: 1234.56 });
  assert.equal((await texto.repo.getById(N(1))).valorNegociado, 1234.56);
  for (const ruim of [0, 1.5, 'abc', -3, 100000000001, null]) {
    texto.db.tabelas.crm_negotiations.get(N(1)).valor_centavos = ruim;
    await assert.rejects(() => texto.repo.getById(N(1)), /centavos inválido/, String(ruim));
  }
});

test('[SBNEG-9] LEITURA COMPLETA: mais negociações que o teto do servidor vêm TODAS (paginação); histórico com buraco, negociação sem histórico, total que muda e respostas fora do formato são ERRO; falha de leitura nunca vira "não há negociações"', async () => {
  const m = await montar({ maxRows: 150 });
  for (let n = 100; n < 100 + 1203; n += 1) {
    m.db.tabelas.crm_negotiations.set(N(n), { id: N(n), crm_record_id: R(1), funnel_id: F(1), card_id: C(n), service_id: S(1), servico_nome: 'S', responsavel_user_id: 'u', responsavel_nome: 'U', prazo_meses: 12, forma_pagamento: 'RECORRENTE', periodicidade: 'MENSAL', valor_centavos: 150000,
      previsao_fechamento: null, situacao: 'ABERTA', motivo_perda: null, fechado_em: null, created_at: T, updated_at: T, created_by_user_id: 'u', created_by_name: 'U', updated_by_user_id: 'u', updated_by_name: 'U' });
    m.db.tabelas.crm_negotiation_events.push({ id: n, negotiation_id: N(n), seq: 0, tipo: 'CRIADA', em: T, por_user_id: 'u', por_nome: 'U', detalhe: null });
  }
  const todas = await m.repo.list();
  assert.equal(todas.length, 1203);
  assert.equal(new Set(todas.map((x) => x.id)).size, 1203);
  assert.ok(m.db.chamadas.filter((c) => c.caminho === '/rest/v1/crm_negotiations').length > 8, 'várias páginas');
  // um evento de uma negociação que não está na lista (criada no meio da leitura) é ignorado
  m.db.tabelas.crm_negotiation_events.push({ id: 9999, negotiation_id: N(99999), seq: 0, tipo: 'CRIADA', em: T, por_user_id: 'u', por_nome: 'U', detalhe: null });
  assert.equal((await m.repo.list()).length, 1203);
  // buraco no histórico
  m.db.tabelas.crm_negotiation_events.push({ id: 10000, negotiation_id: N(100), seq: 5, tipo: 'ATUALIZADA', em: T, por_user_id: 'u', por_nome: 'U', detalhe: null });
  await assert.rejects(() => m.repo.list(), /histórico de uma negociação está incompleto/);
  await assert.rejects(() => m.repo.getById(N(100)), /histórico de uma negociação está incompleto/);
  m.db.tabelas.crm_negotiation_events.pop();
  // negociação sem histórico
  m.db.tabelas.crm_negotiation_events.splice(m.db.tabelas.crm_negotiation_events.findIndex((e) => e.negotiation_id === N(101)), 1);
  await assert.rejects(() => m.repo.list(), /sem o histórico obrigatório/);
  // total que muda no meio, corpo que não é lista, falha de leitura: tudo erro
  const quebrado = await montar({ aoResponder: (n, req) => (req.caminho === '/rest/v1/crm_negotiations' ? resposta(503, 'fora') : null) });
  await assert.rejects(() => quebrado.repo.list(), /HTTP 503/);
  const naoLista = await montar({ aoResponder: (n, req) => (req.caminho === '/rest/v1/crm_negotiations' ? resposta(200, { x: 1 }, { 'content-range': '0-0/1' }) : null) });
  await assert.rejects(() => naoLista.repo.list(), /não é uma lista/);
  const semTotal = await montar({ aoResponder: (n, req) => (req.caminho === '/rest/v1/crm_negotiation_events' ? resposta(200, [], {}) : null) });
  await assert.rejects(() => semTotal.repo.list(), /total não pôde ser confirmado/);
  const idsRepetidos = await montar({ aoResponder: (n, req) => (req.caminho === '/rest/v1/crm_negotiations' ? resposta(200, [{ id: N(1) }, { id: N(1) }], { 'content-range': '0-1/2' }) : null) });
  await assert.rejects(() => idsRepetidos.repo.list(), /apareceu duas vezes/);
  const mudou = await montar({ maxRows: 1 });
  await criar(mudou, 1);
  await criar(mudou, 2, { crmRecordId: R(2) });
  let leituras = 0;
  const original = mudou.db.fetchImpl;
  const comMudanca = createSupabaseNegotiationRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: async (url, init) => { if (/crm_negotiations\?/.test(String(url)) && ++leituras === 2) mudou.db.tabelas.crm_negotiations.delete(N(2)); return original(url, init); } });
  await assert.rejects(() => comMudanca.list(), /não puderam ser lidos por completo/);
});

test('[SBNEG-10] commit() e save(): parâmetros inválidos são erro de programação ANTES de enviar (modo, concorrência esperada, card e movimento juntos, papel de quem moveu, histórico presente); save() só atualiza uma negociação que existe', async () => {
  const m = await montar();
  const antes = m.db.escritas().length;
  await assert.rejects(() => m.repo.commit({ mode: 'upsert', negotiation: negociacao(1) }), /mode "create" ou "update"/);
  await assert.rejects(() => m.repo.commit({ mode: 'update', negotiation: negociacao(1) }), /expectedUpdatedAt/);
  await assert.rejects(() => m.repo.commit({ mode: 'create', negotiation: negociacao(1), card: card(1), cardMove: null }), /vêm juntos/);
  await assert.rejects(() => m.repo.commit({ mode: 'create', negotiation: negociacao(1), card: card(1), cardMove: { ...movimento(1, null, E(1)), movedBy: { userId: 'u', name: 'n' } } }), /nunca anônimo/);
  await assert.rejects(() => m.repo.commit({ mode: 'create', negotiation: negociacao(1, { eventos: [] }), card: card(1), cardMove: movimento(1, null, E(1)) }), /histórico obrigatório/);
  await assert.rejects(() => m.repo.commit({ mode: 'create', negotiation: negociacao(1, { eventos: [{ tipo: 'CRIADA' }] }), card: card(1), cardMove: movimento(1, null, E(1)) }), /evento de histórico inválido/);
  await assert.rejects(() => m.repo.commit({ mode: 'create', negotiation: { ...negociacao(1), id: '__proto__' }, card: card(1), cardMove: movimento(1, null, E(1)) }), /id não permitido/);
  await assert.rejects(() => m.repo.getById(''), /id deve ser um texto/);
  assert.equal(m.db.escritas().length, antes, 'nada foi enviado');
  await assert.rejects(() => m.repo.save(negociacao(1)), /save\(\) não cria negociação/);
  await criar(m, 1);
  const a = await m.repo.getById(N(1));
  await m.repo.save({ ...a, valorNegociado: 3000, atualizadoEm: T1, eventos: [...a.eventos, evento('ATUALIZADA', T1)] });
  assert.equal((await m.repo.getById(N(1))).valorNegociado, 3000);
});

test('[SBNEG-11] SEGREDO E ERROS: erros desconhecidos saem sem `code` e citam só o status; a chave vai só no cabeçalho; uma rede que cai não vaza a mensagem do erro', async () => {
  const m = await montar();
  await criar(m, 1);
  for (const chamada of m.db.chamadas) assert.equal(JSON.stringify(chamada.corpo ?? null).includes(CHAVE), false);
  const semRede = createSupabaseNegotiationRepository({ url: URL, serviceRoleKey: CHAVE, fetchImpl: async () => { throw Object.assign(new Error('host-interno-segredo'), { name: 'TypeError' }); } });
  await assert.rejects(() => semRede.list(), (e) => /falha de rede/.test(e.message) && !/host-interno-segredo/.test(e.message));
  await assert.rejects(() => semRede.commit({ mode: 'create', negotiation: negociacao(1), card: card(1), cardMove: movimento(1, null, E(1)) }), (e) => /falha de rede/.test(e.message) && !/host-interno-segredo/.test(e.message));
});
