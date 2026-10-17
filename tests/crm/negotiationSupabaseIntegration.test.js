// O DOMÍNIO de Negociações e de Funis sobre os adapters REAIS do Supabase, num PostgREST falso que aplica as regras do BANCO em modo ESTRITO (chaves estrangeiras, cliente e serviço conferidos no banco) — Fase D1.1,
// decisão 0029. É aqui que se prova o que só vale no modo Supabase: cada operação é UMA requisição transacional (nada de POSTs soltos), uma falha no meio não deixa NADA pela metade, a concorrência entre dois
// processos é detectada (nunca sobrescreve em silêncio), as regras do banco valem mesmo quando o domínio já conferiu antes, os cards antigos convivem com os de negociação, e a leitura nunca vira "vazio" por falha.
// Nenhuma rede; dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/crm/negotiationDomain');
const { NEGOTIATION_ERROR } = domain;
const funnelDomain = require('../../src/crm/funnelDomain');
const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { createSupabaseFunnelRepository } = require('../../src/crm-adapters/crmSupabaseFunnelRepository');
const { createSupabaseNegotiationRepository } = require('../../src/crm-adapters/crmSupabaseNegotiationRepository');
const { criarPostgrestComercial, resposta } = require('../helpers/fakePostgrestCommercial');
const { URL_FALSA, CHAVE_FALSA } = require('../helpers/commercialStorage');

const OP = Object.freeze({ userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' });
const OP2 = Object.freeze({ userId: 'user-closer', name: 'Closer Teste', role: 'COMMERCIAL_CLOSER' });
const T0 = new Date('2026-10-19T12:00:00.000Z');
const T1 = new Date('2026-10-19T13:00:00.000Z');
const T2 = new Date('2026-10-19T14:00:00.000Z');
const clock = (date) => ({ now: () => date });
const SERVICO = Object.freeze({ id: 'service:00000000-0000-4000-8000-000000000001', nome: 'Gestão de redes', ativo: true, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] });
const SO_UNICO = Object.freeze({ ...SERVICO, id: 'service:00000000-0000-4000-8000-000000000002', nome: 'Site', permitePagamentoRecorrente: false, periodicidades: [] });

function adaptadores(db) {
  return {
    funnelRepository: createSupabaseFunnelRepository({ url: URL_FALSA, serviceRoleKey: CHAVE_FALSA, fetchImpl: db.fetchImpl }),
    repository: createSupabaseNegotiationRepository({ url: URL_FALSA, serviceRoleKey: CHAVE_FALSA, fetchImpl: db.fetchImpl }),
  };
}
// Modo ESTRITO: o banco falso confere cliente e serviço como as FKs e as regras do SQL (por isso os registramos nele, como existiriam no banco).
async function ambiente(opcoes = {}) {
  const db = criarPostgrestComercial({ referencias: 'estritas', ...opcoes });
  const { funnelRepository, repository } = adaptadores(db);
  const crmRepository = createInMemoryCrmRepository();
  const funil = await funnelDomain.createFunnel(funnelRepository, { nome: 'Vendas' });
  const etapas = [];
  for (const nome of ['Contato', 'Proposta', 'Fechamento']) etapas.push(await funnelDomain.createStage(funnelRepository, funil.id, { nome }));
  const cliente = (await crmDomain.createRecord(crmRepository, { empresa: 'Clínica Teste' })).record;
  const outroCliente = (await crmDomain.createRecord(crmRepository, { empresa: 'Outra Clínica' })).record;
  db.registrarCliente(cliente.id);
  db.registrarCliente(outroCliente.id);
  for (const s of [SERVICO, SO_UNICO]) db.registrarServico(s.id, { ativo: s.ativo, permite_pagamento_unico: s.permitePagamentoUnico, permite_pagamento_recorrente: s.permitePagamentoRecorrente, periodicidades: [...s.periodicidades] });
  return { db, deps: { repository, funnelRepository, crmRepository }, funil, etapas, cliente, outroCliente };
}
const base = (e, extras = {}) => ({ crmRecordId: e.cliente.id, funnelId: e.funil.id, serviceId: SERVICO.id, prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, ...extras });
const criar = (e, extras = {}, servico = SERVICO, op = OP, tempo = T0) => domain.createNegotiation(e.deps, base(e, extras), servico, op, clock(tempo));
const erro = async (tarefa) => {
  try {
    await tarefa();
  } catch (e) {
    return e;
  }
  throw new Error('esperava uma falha e não houve');
};
const gravacoes = (db, desde = 0) => db.escritas().slice(desde);

test('[NEGSB-1] CADA OPERAÇÃO É UMA ÚNICA REQUISIÇÃO TRANSACIONAL: criar, editar, mover, ganhar, perder e reabrir gravam negociação + histórico (+ card e movimento) numa chamada só — nenhum POST solto para o card, o movimento ou o evento', async () => {
  const e = await ambiente();
  let marco = db0(e);
  const n = await criar(e);
  assert.deepEqual(gravacoes(e.db, marco).map((c) => c.caminho), ['/rest/v1/rpc/commit_crm_negotiation_change'], 'criar: uma chamada');
  marco = db0(e);
  await domain.updateNegotiation(e.deps, n.id, { valorNegociado: 1700 }, SERVICO, OP, clock(T1));
  assert.deepEqual(gravacoes(e.db, marco).map((c) => c.caminho), ['/rest/v1/rpc/commit_crm_negotiation_change'], 'editar: uma chamada');
  marco = db0(e);
  await domain.moveNegotiation(e.deps, n.id, e.etapas[1].id, OP, clock(T1));
  assert.deepEqual(gravacoes(e.db, marco).map((c) => c.caminho), ['/rest/v1/rpc/commit_crm_negotiation_change'], 'mover: o card, o movimento e o evento numa chamada só');
  assert.deepEqual(e.db.tabelas.crm_funnel_card_moves.map((m) => [m.stage_from, m.stage_to, m.moved_by_role]), [[null, e.etapas[0].id, 'ADMIN'], [e.etapas[0].id, e.etapas[1].id, 'ADMIN']]);
  marco = db0(e);
  await domain.loseNegotiation(e.deps, n.id, 'Sem orçamento', OP2, clock(T1));
  await domain.reopenNegotiation(e.deps, n.id, OP, clock(T2));
  await domain.winNegotiation(e.deps, n.id, OP, clock(T2));
  assert.deepEqual(gravacoes(e.db, marco).map((c) => c.caminho), Array(3).fill('/rest/v1/rpc/commit_crm_negotiation_change'));
  assert.deepEqual(e.db.tabelas.crm_negotiation_events.map((x) => x.tipo), ['CRIADA', 'ATUALIZADA', 'ETAPA', 'PERDIDA', 'REABERTA', 'GANHA']);
  assert.deepEqual(e.db.tabelas.crm_negotiation_events.map((x) => x.seq), [0, 1, 2, 3, 4, 5]);
  const final = await domain.getNegotiation(e.deps, n.id);
  assert.deepEqual([final.situacao, final.stageNome, final.valorNegociado, final.eventos.length], ['GANHA', 'Proposta', 1700, 6]);
});
const db0 = (e) => e.db.escritas().length;

test('[NEGSB-2] FALHA NO MEIO = NADA GRAVADO: se a transação falha ao criar, mover ou fechar, a negociação, o histórico e o card ficam EXATAMENTE como estavam; o domínio devolve erro de persistência (o Dashboard nunca vê sucesso) e a mensagem não vaza o banco', async () => {
  const e = await ambiente();
  const n = await criar(e);
  const instantaneo = () => JSON.stringify([[...e.db.tabelas.crm_funnel_cards.values()], e.db.tabelas.crm_funnel_card_moves, [...e.db.tabelas.crm_negotiations.values()], e.db.tabelas.crm_negotiation_events]);
  const antes = instantaneo();
  const tarefas = [
    () => criar(e, { valorNegociado: 999 }),
    () => domain.updateNegotiation(e.deps, n.id, { valorNegociado: 2000 }, SERVICO, OP, clock(T1)),
    () => domain.moveNegotiation(e.deps, n.id, e.etapas[2].id, OP, clock(T1)),
    () => domain.winNegotiation(e.deps, n.id, OP, clock(T1)),
    () => domain.loseNegotiation(e.deps, n.id, 'Preço', OP, clock(T1)),
  ];
  for (const tarefa of tarefas) {
    e.db.falhar('commit_crm_negotiation_change', resposta(500, { code: 'XX000', message: 'segredo-do-banco com dados' }));
    const falhou = await erro(tarefa);
    assert.equal(falhou.code, NEGOTIATION_ERROR.PERSISTENCE);
    assert.doesNotMatch(falhou.message, /segredo-do-banco|dados/);
  }
  assert.equal(instantaneo(), antes, 'nada mudou');
  // uma falha DENTRO da função do banco (um evento recusado) desfaz o card e o movimento também
  const quebrar = { ...e.deps, repository: { ...e.deps.repository, list: e.deps.repository.list, getById: e.deps.repository.getById, save: e.deps.repository.save, commit: (pedido) => e.deps.repository.commit({ ...pedido, negotiation: { ...pedido.negotiation, eventos: pedido.negotiation.eventos.map((ev, i, todos) => (i === todos.length - 1 ? { ...ev, tipo: 'INVENTADO' } : ev)) } }) } };
  const interno = await erro(() => domain.moveNegotiation(quebrar, n.id, e.etapas[1].id, OP, clock(T1)));
  assert.equal(interno.code, NEGOTIATION_ERROR.PERSISTENCE);
  assert.equal(instantaneo(), antes, 'o card NÃO se moveu e nenhum movimento ficou');
  assert.equal((await domain.getNegotiation(e.deps, n.id)).stageNome, 'Contato');
});

test('[NEGSB-3] CONCORRÊNCIA ENTRE PROCESSOS: duas instâncias do servidor leem a mesma negociação; a segunda gravação é RECUSADA com NEGOTIATION_CONFLICT (nunca sobrescreve em silêncio) e o estado é o da primeira; depois de reler, a segunda consegue; dentro de um processo as escritas continuam serializadas', async () => {
  const e = await ambiente();
  const n = await criar(e);
  const outroProcesso = { ...adaptadores(e.db), crmRepository: e.deps.crmRepository };
  // as duas LEEM antes de qualquer escrita
  const lidaA = await domain.getNegotiation(e.deps, n.id);
  const lidaB = await domain.getNegotiation(outroProcesso, n.id);
  assert.equal(lidaA.atualizadoEm, lidaB.atualizadoEm);
  // a escrita do processo B acontece NO MEIO da escrita do A: o A leu antes, o B grava, e só então o A grava
  let b;
  const original = e.db.fetchImpl;
  let disparou = false;
  const adaptadorA = createSupabaseNegotiationRepository({
    url: URL_FALSA,
    serviceRoleKey: CHAVE_FALSA,
    fetchImpl: async (url, init) => {
      if (!disparou && /rpc\/commit_crm_negotiation_change/.test(String(url))) {
        disparou = true;
        b = await domain.updateNegotiation(outroProcesso, n.id, { valorNegociado: 2222 }, SERVICO, OP2, clock(T1));
      }
      return original(url, init);
    },
  });
  const comA = { ...e.deps, repository: adaptadorA };
  const conflito = await erro(() => domain.updateNegotiation(comA, n.id, { valorNegociado: 3333 }, SERVICO, OP, clock(T2)));
  assert.equal(conflito.code, NEGOTIATION_ERROR.CONFLICT);
  assert.match(conflito.message, /alterada por outra pessoa/);
  assert.equal((await domain.getNegotiation(e.deps, n.id)).valorNegociado, 2222, 'o valor é o da primeira gravação');
  assert.equal(e.db.tabelas.crm_negotiation_events.length, 2, 'o conflito não deixou evento');
  // reler e tentar de novo funciona
  const refeita = await domain.updateNegotiation(comA, n.id, { valorNegociado: 3333 }, SERVICO, OP, clock(T2));
  assert.equal(refeita.valorNegociado, 3333);
  assert.deepEqual(refeita.eventos.map((x) => x.tipo), ['CRIADA', 'ATUALIZADA', 'ATUALIZADA']);
  assert.equal(b.valorNegociado, 2222);
  // dentro do mesmo processo: dois pedidos simultâneos nunca perdem um ao outro (serializados)
  const [x, y] = await Promise.all([domain.updateNegotiation(e.deps, n.id, { prazoMeses: 24 }, SERVICO, OP, clock(T2)), domain.updateNegotiation(e.deps, n.id, { previsaoFechamento: '2026-12-31' }, SERVICO, OP2, clock(T2))]);
  const final = await domain.getNegotiation(e.deps, n.id);
  assert.deepEqual([final.prazoMeses, final.previsaoFechamento, x.id === y.id], [24, '2026-12-31', true]);
});

test('[NEGSB-4] O BANCO TEM A ÚLTIMA PALAVRA (corridas): o domínio confere o cliente, a etapa e o serviço antes, mas se eles mudarem ENTRE a conferência e a gravação o banco recusa — cliente que virou "Não Contatar", etapa que foi desativada, serviço desativado; nada fica e o erro é de estado (409), não de armazenamento', async () => {
  const e = await ambiente();
  const comGancho = (gatilho) => {
    const original = e.db.fetchImpl;
    let feito = false;
    return { ...e.deps, repository: createSupabaseNegotiationRepository({ url: URL_FALSA, serviceRoleKey: CHAVE_FALSA, fetchImpl: async (url, init) => { if (!feito && /rpc\/commit_crm_negotiation_change/.test(String(url))) { feito = true; await gatilho(); } return original(url, init); } }) };
  };
  // 1) o cliente vira Não Contatar depois da conferência do domínio
  const dnc = comGancho(async () => e.db.mudarStatusCliente(e.cliente.id, 'DO_NOT_CONTACT'));
  const a = await erro(() => domain.createNegotiation(dnc, base(e), SERVICO, OP, clock(T0)));
  assert.equal(a.code, NEGOTIATION_ERROR.INVALID_STATE);
  e.db.mudarStatusCliente(e.cliente.id, 'PROSPECT');
  // 2) o serviço é desativado
  const sv = comGancho(async () => e.db.mudarServico(SERVICO.id, { ativo: false }));
  assert.equal((await erro(() => domain.createNegotiation(sv, base(e), SERVICO, OP, clock(T0)))).code, NEGOTIATION_ERROR.INVALID_STATE);
  e.db.mudarServico(SERVICO.id, { ativo: true });
  // 3) o serviço deixa de permitir a forma de pagamento
  const forma = comGancho(async () => e.db.mudarServico(SERVICO.id, { permite_pagamento_recorrente: false, periodicidades: [] }));
  assert.equal((await erro(() => domain.createNegotiation(forma, base(e), SERVICO, OP, clock(T0)))).code, NEGOTIATION_ERROR.INVALID_STATE);
  e.db.mudarServico(SERVICO.id, { permite_pagamento_recorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] });
  assert.equal(e.db.tabelas.crm_negotiations.size, 0);
  assert.equal(e.db.tabelas.crm_funnel_cards.size, 0, 'nenhuma recusa deixou card');
  // 4) a etapa de destino é desativada depois da conferência do domínio
  const n = await criar(e);
  const etapa = comGancho(async () => funnelDomain.updateStage(e.deps.funnelRepository, e.etapas[1].id, { ativo: false }));
  assert.equal((await erro(() => domain.moveNegotiation(etapa, n.id, e.etapas[1].id, OP, clock(T1)))).code, NEGOTIATION_ERROR.INVALID_STATE);
  assert.equal((await domain.getNegotiation(e.deps, n.id)).stageNome, 'Contato', 'o card não saiu da etapa');
  assert.equal(e.db.tabelas.crm_funnel_card_moves.length, 1);
});

test('[NEGSB-5] CARDS ANTIGOS CONVIVEM: o card avulso (sem negociação) cria e move em UMA requisição (com histórico), a regra "um por cliente e funil" vale só entre avulsos e vira FUNNEL_CARD_DUPLICATE, um cliente tem várias negociações no mesmo funil ao lado do card avulso, e o quadro lê os dois', async () => {
  const e = await ambiente();
  const marco = db0(e);
  const avulso = await funnelDomain.createCard(e.deps.funnelRepository, e.deps.crmRepository, { funnelId: e.funil.id, crmRecordId: e.cliente.id }, { reviewedBy: OP, motivo: 'veio antes' });
  assert.deepEqual(gravacoes(e.db, marco).map((c) => c.caminho), ['/rest/v1/rpc/commit_crm_funnel_card_change'], 'criar o card avulso: uma chamada com o card e o histórico');
  const duplicado = await erro(() => funnelDomain.createCard(e.deps.funnelRepository, e.deps.crmRepository, { funnelId: e.funil.id, crmRecordId: e.cliente.id }, { reviewedBy: OP }));
  assert.equal(duplicado.code, 'FUNNEL_CARD_DUPLICATE');
  const a = await criar(e);
  const b = await criar(e, { serviceId: SO_UNICO.id, formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 5000 }, SO_UNICO);
  assert.notEqual(a.cardId, b.cardId);
  const cards = await funnelDomain.listCardsByFunnel(e.deps.funnelRepository, e.funil.id);
  assert.deepEqual(cards.map((c) => [c.id === avulso.id, c.negotiationId ?? null]).sort(), [[false, a.id], [false, b.id], [true, null]].sort());
  // mover o avulso: uma chamada, com o histórico; o card de negociação não se move por aqui
  const antes = db0(e);
  await funnelDomain.moveCard(e.deps.funnelRepository, avulso.id, e.etapas[1].id, { reviewedBy: OP2 });
  assert.deepEqual(gravacoes(e.db, antes).map((c) => c.caminho), ['/rest/v1/rpc/commit_crm_funnel_card_change']);
  assert.deepEqual((await funnelDomain.getCardHistory(e.deps.funnelRepository, avulso.id)).map((m) => [m.stageFrom, m.stageTo, m.movedBy.role]), [[null, e.etapas[0].id, 'ADMIN'], [e.etapas[0].id, e.etapas[1].id, 'COMMERCIAL_CLOSER']]);
  await assert.rejects(() => funnelDomain.moveCard(e.deps.funnelRepository, a.cardId, e.etapas[1].id, { reviewedBy: OP }), (x) => x.code === 'FUNNEL_CARD_HAS_NEGOTIATION');
  await assert.rejects(() => funnelDomain.deleteCard(e.deps.funnelRepository, a.cardId), (x) => x.code === 'FUNNEL_CARD_HAS_NEGOTIATION');
  // mover o avulso por uma leitura velha (outra pessoa já o moveu): conflito, nada muda
  const velho = await funnelDomain.getCard(e.deps.funnelRepository, avulso.id);
  await funnelDomain.moveCard(e.deps.funnelRepository, avulso.id, e.etapas[2].id, { reviewedBy: OP });
  const emConflito = await erro(() => e.deps.funnelRepository.commitCardChange({ card: { ...velho, stageId: e.etapas[1].id }, move: { cardId: avulso.id, stageFrom: velho.stageId, stageTo: e.etapas[1].id, movedBy: OP, motivo: null, movedAt: T2.toISOString() }, expectedStageId: velho.stageId }));
  assert.equal(emConflito.code, 'FUNNEL_REPOSITORY_CONFLICT');
  assert.equal((await funnelDomain.getCard(e.deps.funnelRepository, avulso.id)).stageId, e.etapas[2].id);
  // arquivar o avulso: o cliente continua protegido da exclusão (o banco manteria a FK), e o funil e a etapa também
  await funnelDomain.deleteCard(e.deps.funnelRepository, avulso.id);
  assert.equal((await funnelDomain.listCardsByFunnel(e.deps.funnelRepository, e.funil.id)).length, 2);
  assert.equal(await e.deps.funnelRepository.countActiveCardsByCrmRecord(e.cliente.id), 3, 'o card arquivado também conta (o histórico fica ligado ao cliente)');
});

test('[NEGSB-6] ESTRUTURA ATÔMICA: reordenar etapas é uma chamada (e uma lista errada não muda nada); excluir funil leva as etapas na mesma transação; funil e etapa com card — mesmo ARQUIVADO — nunca são excluídos; funil vazio sai inteiro', async () => {
  const e = await ambiente();
  const marco = db0(e);
  await funnelDomain.reorderStages(e.deps.funnelRepository, e.funil.id, [e.etapas[2].id, e.etapas[0].id, e.etapas[1].id]);
  assert.deepEqual(gravacoes(e.db, marco).map((c) => c.caminho), ['/rest/v1/rpc/reorder_crm_funnel_stages']);
  assert.deepEqual((await funnelDomain.listStages(e.deps.funnelRepository, e.funil.id)).map((s) => s.nome), ['Fechamento', 'Contato', 'Proposta']);
  await assert.rejects(() => funnelDomain.reorderStages(e.deps.funnelRepository, e.funil.id, [e.etapas[0].id]), /exatamente as etapas/);
  assert.deepEqual((await funnelDomain.listStages(e.deps.funnelRepository, e.funil.id)).map((s) => s.nome), ['Fechamento', 'Contato', 'Proposta'], 'a recusa não mexeu em nada');
  // falha do banco no meio da reordenação: nenhuma posição muda
  e.db.falhar('reorder_crm_funnel_stages', resposta(500, { message: 'x' }));
  await assert.rejects(() => funnelDomain.reorderStages(e.deps.funnelRepository, e.funil.id, e.etapas.map((s) => s.id)), /HTTP 500/);
  assert.deepEqual((await funnelDomain.listStages(e.deps.funnelRepository, e.funil.id)).map((s) => s.nome), ['Fechamento', 'Contato', 'Proposta']);
  // com card (de negociação ou arquivado) nada se exclui
  const n = await criar(e);
  await assert.rejects(() => funnelDomain.deleteFunnel(e.deps.funnelRepository, e.funil.id), (x) => x.code === 'FUNNEL_HAS_CARDS');
  // depois de reordenar, a PRIMEIRA etapa é "Fechamento" (etapas[2]): é nela que os cards novos entram
  await assert.rejects(() => funnelDomain.deleteStage(e.deps.funnelRepository, e.etapas[2].id), (x) => x.code === 'STAGE_HAS_CARDS');
  const avulso = await funnelDomain.createCard(e.deps.funnelRepository, e.deps.crmRepository, { funnelId: e.funil.id, crmRecordId: e.outroCliente.id }, { reviewedBy: OP });
  await funnelDomain.deleteCard(e.deps.funnelRepository, avulso.id); // arquivado
  assert.equal(await e.deps.funnelRepository.countCardsByStage(e.etapas[2].id), 2);
  assert.equal(n.id.startsWith('negotiation:'), true);
  // um funil vazio sai inteiro, numa transação, sem nenhum DELETE solto
  const vazio = await funnelDomain.createFunnel(e.deps.funnelRepository, { nome: 'Vazio' });
  await funnelDomain.createStage(e.deps.funnelRepository, vazio.id, { nome: 'Única' });
  const antes = db0(e);
  await funnelDomain.deleteFunnel(e.deps.funnelRepository, vazio.id);
  assert.deepEqual(gravacoes(e.db, antes).map((c) => c.caminho), ['/rest/v1/rpc/delete_crm_funnel_if_empty']);
  assert.equal(await e.deps.funnelRepository.getFunnel(vazio.id), null);
  assert.equal(e.db.chamadas.filter((c) => c.metodo === 'DELETE').length, 0);
});

test('[NEGSB-7] LEITURA NUNCA VIRA "VAZIO": se o banco não responde, listar, ler uma negociação e o quadro FALHAM (persistência) — não mostram "nenhuma negociação"; e uma tabela que ainda não existe (migration não aplicada) também é erro, não lista vazia', async () => {
  const e = await ambiente();
  await criar(e);
  e.db.falharSempre('crm_negotiations', resposta(503, 'fora do ar'));
  for (const tarefa of [() => domain.listNegotiations(e.deps), () => domain.getNegotiation(e.deps, 'negotiation:00000000-0000-4000-8000-000000000009'), async () => domain.summarizeNegotiations(await domain.listNegotiations(e.deps))]) {
    const falhou = await erro(tarefa);
    assert.ok(falhou, 'falhou');
  }
  assert.equal((await erro(() => domain.listNegotiations(e.deps))).code, NEGOTIATION_ERROR.PERSISTENCE);
  e.db.deixarDeFalhar();
  assert.equal((await domain.listNegotiations(e.deps)).length, 1);
  // a tabela ausente (PGRST205): erro de armazenamento, nunca vazio
  const semMigration = await ambiente({ aoResponder: (n, req) => (/crm_negotiations|crm_negotiation_events|commit_crm_negotiation_change/.test(req.caminho) ? resposta(404, { code: 'PGRST205', message: "Could not find the table 'public.crm_negotiations' in the schema cache" }) : null) });
  assert.equal((await erro(() => domain.listNegotiations(semMigration.deps))).code, NEGOTIATION_ERROR.PERSISTENCE);
  assert.equal((await erro(() => criar(semMigration))).code, NEGOTIATION_ERROR.PERSISTENCE);
});

test('[NEGSB-8] FINANCEIRO E IDENTIDADE DO SERVIÇO NO BANCO: o contrato volta idêntico (prazo independente da periodicidade; TCV, MRR e equivalente mensal derivados em centavos exatos); o serviço pode mudar de nome, preço e modalidades DEPOIS sem tocar a negociação (a foto do nome e o histórico ficam); trocar o preço da negociação é uma edição parcial', async () => {
  const e = await ambiente();
  const mensal = await criar(e, { prazoMeses: 18, valorNegociado: 1234.56 });
  const trimestral = await criar(e, { crmRecordId: e.outroCliente.id, periodicidade: 'TRIMESTRAL', prazoMeses: 12, valorNegociado: 3000 });
  const unico = await criar(e, { serviceId: SO_UNICO.id, formaPagamento: 'UNICO', periodicidade: null, prazoMeses: 6, valorNegociado: 5000.99 }, SO_UNICO);
  assert.deepEqual([mensal.financeiro.tcv, mensal.financeiro.mrr, mensal.financeiro.equivalenteMensal], [22222.08, 1234.56, 1234.56]);
  assert.deepEqual([trimestral.financeiro.tcv, trimestral.financeiro.mrr, trimestral.financeiro.equivalenteMensal], [12000, null, 1000]);
  assert.deepEqual([unico.financeiro.tcv, unico.financeiro.mrr, unico.financeiro.equivalenteMensal, unico.financeiro.cronograma.cobrancas], [5000.99, null, null, 1]);
  const resumo = domain.summarizeNegotiations(await domain.listNegotiations(e.deps));
  assert.deepEqual([resumo.abertas.quantidade, resumo.abertas.tcv, resumo.abertas.mrr, resumo.abertas.equivalenteMensalOutrasRecorrencias], [3, 39223.07, 1234.56, 1000], 'indicadores a partir do repositório, em centavos exatos');
  // o serviço muda DEPOIS (renomeado, desativado, sem recorrência): a negociação e o histórico continuam, o preço dela edita normalmente
  e.db.mudarServico(SERVICO.id, { ativo: false, permite_pagamento_recorrente: false, periodicidades: [] });
  const lida = await domain.getNegotiation(e.deps, mensal.id);
  assert.deepEqual([lida.servicoNome, lida.serviceId, lida.formaPagamento, lida.periodicidade], ['Gestão de redes', SERVICO.id, 'RECORRENTE', 'MENSAL']);
  const editada = await domain.updateNegotiation(e.deps, mensal.id, { valorNegociado: 1300 }, { ...SERVICO, nome: 'Gestão de redes (renomeado)', ativo: false, permitePagamentoRecorrente: false, periodicidades: [] }, OP, clock(T1));
  assert.deepEqual([editada.valorNegociado, editada.servicoNome, editada.prazoMeses], [1300, 'Gestão de redes', 18], 'o nome fotografado não muda por editar o preço');
  // valorProposta/valorTotal legados nunca entram: o objeto gravado não os tem
  assert.equal(JSON.stringify([...e.db.tabelas.crm_negotiations.values()]).includes('valor_proposta'), false);
  assert.equal(e.db.tabelas.crm_negotiations.get(mensal.id).valor_centavos, 130000);
});

test('[NEGSB-9] RESUMO e QUADRO COM MUITAS NEGOCIAÇÕES: a leitura completa pagina (mais de 1.000 negociações) e os indicadores batem com a soma exata; nenhuma linha some por causa do teto do servidor', async () => {
  const e = await ambiente({ maxRows: 400 });
  for (let i = 0; i < 1100; i += 1) {
    const id = `negotiation:00000000-0000-4000-8000-${String(100000 + i).padStart(12, '0')}`;
    const cardId = `card:00000000-0000-4000-8000-${String(100000 + i).padStart(12, '0')}`;
    e.db.tabelas.crm_funnel_cards.set(cardId, { id: cardId, funnel_id: e.funil.id, stage_id: e.etapas[0].id, crm_record_id: e.cliente.id, negotiation_id: id, perdido_em: null, motivo_perdido: null, criado_em: '2026-10-19T12:00:00.000Z', updated_at: '2026-10-19T12:00:00.000Z', removed_at: null });
    e.db.tabelas.crm_negotiations.set(id, { id, crm_record_id: e.cliente.id, funnel_id: e.funil.id, card_id: cardId, service_id: SERVICO.id, servico_nome: 'S', responsavel_user_id: 'u', responsavel_nome: 'U', prazo_meses: 12, forma_pagamento: 'RECORRENTE', periodicidade: 'MENSAL', valor_centavos: 10000,
      previsao_fechamento: null, situacao: i % 4 === 0 ? 'GANHA' : 'ABERTA', motivo_perda: null, fechado_em: i % 4 === 0 ? '2026-10-19T13:00:00.000Z' : null, created_at: '2026-10-19T12:00:00.000Z', updated_at: '2026-10-19T12:00:00.000Z',
      created_by_user_id: 'u', created_by_name: 'U', updated_by_user_id: 'u', updated_by_name: 'U' });
    e.db.tabelas.crm_negotiation_events.push({ id: 100000 + i, negotiation_id: id, seq: 0, tipo: 'CRIADA', em: '2026-10-19T12:00:00.000Z', por_user_id: 'u', por_nome: 'U', detalhe: null });
  }
  const todas = await domain.listNegotiations(e.deps);
  assert.equal(todas.length, 1100);
  const resumo = domain.summarizeNegotiations(todas);
  assert.deepEqual([resumo.total, resumo.ganhas.quantidade, resumo.abertas.quantidade], [1100, 275, 825]);
  assert.deepEqual([resumo.abertas.tcv, resumo.abertas.mrr, resumo.ganhas.tcv], [825 * 1200, 825 * 100, 275 * 1200]);
  assert.equal((await domain.listNegotiations(e.deps, { situacao: 'GANHA' })).length, 275);
});
