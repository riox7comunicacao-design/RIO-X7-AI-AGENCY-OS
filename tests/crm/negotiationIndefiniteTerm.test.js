// Domínio de NEGOCIAÇÕES — contratos recorrentes por PRAZO INDETERMINADO (src/crm/negotiationDomain.js — CRM 5.0, Fase D3, decisão 0032): criar, validar, editar uma negociação existente (o caso REAL: de
// 12 meses para prazo indeterminado, com aviso prévio de 30 dias), os indicadores e a compatibilidade com os contratos de duração definida. O MESMO conjunto roda nos dois modos de armazenamento
// (arquivo em memória e adapters do Supabase sobre o PostgREST falso): negotiationIndefiniteTerm.test.js e negotiationIndefiniteTerm.supabase.test.js. Dados fictícios; nenhuma rede nem arquivo de data/.

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/crm/negotiationDomain');
const { NEGOTIATION_ERROR, SITUATION, EVENT } = domain;
const funnelDomain = require('../../src/crm/funnelDomain');
const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { criarArmazenamento, MODO } = require('../helpers/commercialStorage');

const OP = Object.freeze({ userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' });
const OP2 = Object.freeze({ userId: 'user-closer', name: 'Closer Teste', role: 'COMMERCIAL_CLOSER' });
const T0 = new Date('2026-10-19T12:00:00.000Z');
const T1 = new Date('2026-10-19T13:30:00.000Z');
const T2 = new Date('2026-10-19T14:45:00.000Z');
const clock = (date) => ({ now: () => date });

// "Gestão de Tráfego Pago": recorrente nas quatro periodicidades, sem pagamento único (o serviço do caso real)
const TRAFEGO = Object.freeze({ id: 'service:00000000-0000-4000-8000-0000000000a1', nome: 'Gestão de Tráfego Pago', ativo: true, permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'] });
const SITE = Object.freeze({ id: 'service:00000000-0000-4000-8000-0000000000a2', nome: 'Site', ativo: true, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] });
const SO_UNICO = Object.freeze({ id: 'service:00000000-0000-4000-8000-0000000000a3', nome: 'Logotipo', ativo: true, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] });

async function ambiente() {
  const armazenamento = criarArmazenamento();
  const funnelRepository = armazenamento.funnelRepository;
  const crmRepository = createInMemoryCrmRepository();
  const repository = armazenamento.negotiationRepository;
  const funil = await funnelDomain.createFunnel(funnelRepository, { nome: 'Vendas' });
  for (const nome of ['Contato', 'Proposta']) await funnelDomain.createStage(funnelRepository, funil.id, { nome });
  const cliente = (await crmDomain.createRecord(crmRepository, { empresa: 'Cliente Teste' })).record;
  return { deps: { repository, funnelRepository, crmRepository }, funil, cliente, armazenamento };
}
const base = (e, extras = {}) => ({ crmRecordId: e.cliente.id, funnelId: e.funil.id, serviceId: TRAFEGO.id, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1350, ...extras });
// o contrato REAL do caso: recorrente mensal, R$ 1.350,00, prazo indeterminado, aviso prévio de 30 dias
const indeterminado = (e, extras = {}, servico = TRAFEGO, op = OP, tempo = T0) => domain.createNegotiation(e.deps, base(e, { duracao: 'INDETERMINADA', avisoPrevioDias: 30, ...extras }), servico, op, clock(tempo));
// o contrato como era criado ANTES da D3 (sem `duracao`): 12 meses
const definido = (e, extras = {}, servico = TRAFEGO, op = OP, tempo = T0) => domain.createNegotiation(e.deps, base(e, { prazoMeses: 12, ...extras }), servico, op, clock(tempo));
const editar = (e, id, patch, servico = TRAFEGO, op = OP, tempo = T1) => domain.updateNegotiation(e.deps, id, patch, servico, op, clock(tempo));
const falha = async (tarefa) => {
  try {
    await tarefa();
  } catch (erro) {
    assert.equal(erro.name, 'NegotiationError');
    return erro;
  }
  throw new Error('esperava uma falha e não houve');
};
const erros = (erro) => (erro.details && erro.details.errors) || [];
const temErro = (erro, path, code) => erros(erro).some((item) => item.path === path && item.code === code);

test('[NEG-D3-1] CRIAR o contrato real: recorrente mensal de R$ 1.350,00 por prazo INDETERMINADO com aviso prévio de 30 dias — sem prazo, MRR R$ 1.350,00, TCV indeterminado (nunca R$ 16.200,00 nem zero)', async () => {
  const e = await ambiente();
  const n = await indeterminado(e);
  assert.match(n.id, /^negotiation:[0-9a-f-]{36}$/);
  assert.deepEqual([n.duracao, n.prazoMeses, n.avisoPrevioDias, n.formaPagamento, n.periodicidade, n.valorNegociado, n.situacao], ['INDETERMINADA', null, 30, 'RECORRENTE', 'MENSAL', 1350, SITUATION.OPEN]);
  assert.equal(n.financeiro.tcv, null);
  assert.equal(n.financeiro.tcvIndeterminado, true);
  assert.equal(n.financeiro.mrr, 1350);
  assert.equal(n.financeiro.cronograma.cobrancas, null, 'nenhuma quantidade de parcelas inventada');
  assert.deepEqual(n.eventos.map((x) => x.tipo), [EVENT.CREATED]);
  // lê de volta do armazenamento (arquivo ou banco): a mesma coisa
  const lida = await domain.getNegotiation(e.deps, n.id);
  assert.deepEqual([lida.duracao, lida.prazoMeses, lida.avisoPrevioDias, lida.financeiro.tcv, lida.financeiro.mrr], ['INDETERMINADA', null, 30, null, 1350]);
  assert.equal((await e.deps.funnelRepository.getCard(n.cardId)).negotiationId, n.id, 'o card do funil foi criado junto');
});

test('[NEG-D3-2] o AVISO PRÉVIO é opcional (null quando não informado) e nunca altera o contrato: o MRR e o TCV são os mesmos com 30 dias, com 365 ou sem aviso', async () => {
  const e = await ambiente();
  const sem = await domain.createNegotiation(e.deps, base(e, { duracao: 'INDETERMINADA' }), TRAFEGO, OP, clock(T0)); // o corpo nem traz o campo
  assert.equal(sem.avisoPrevioDias, null);
  const nulo = await indeterminado(e, { avisoPrevioDias: null });
  assert.equal(nulo.avisoPrevioDias, null);
  const maximo = await indeterminado(e, { avisoPrevioDias: 365 });
  const minimo = await indeterminado(e, { avisoPrevioDias: 1 });
  for (const n of [sem, nulo, maximo, minimo]) assert.deepEqual([n.financeiro.mrr, n.financeiro.tcv, n.valorNegociado, n.prazoMeses], [1350, null, 1350, null]);
  assert.deepEqual([maximo.avisoPrevioDias, minimo.avisoPrevioDias], [365, 1]);
});

test('[NEG-D3-3] prazo indeterminado em TODAS as periodicidades: TCV sempre indeterminado, MRR só na mensal e o equivalente mensal nas demais', async () => {
  const e = await ambiente();
  const esperado = { MENSAL: [1350, 1350], TRIMESTRAL: [null, 450], SEMESTRAL: [null, 225], ANUAL: [null, 112.5] };
  for (const [periodicidade, [mrr, equivalente]] of Object.entries(esperado)) {
    const n = await indeterminado(e, { periodicidade });
    assert.deepEqual([n.periodicidade, n.financeiro.tcv, n.financeiro.mrr, n.financeiro.equivalenteMensal, n.financeiro.tcvIndeterminado], [periodicidade, null, mrr, equivalente, true], periodicidade);
  }
});

test('[NEG-D3-4] VALIDAÇÕES da criação: pagamento único, prazo informado, aviso prévio fora de 1–365 ou não inteiro, aviso num prazo definido, prazo ausente no definido, duração desconhecida — cada uma com o erro certo no campo certo e NADA gravado', async () => {
  const e = await ambiente();
  const casos = [
    [{ duracao: 'INDETERMINADA', formaPagamento: 'UNICO', periodicidade: null }, SITE, 'duracao', 'DURACAO_INDETERMINADA_EXIGE_RECORRENCIA'],
    [{ duracao: 'INDETERMINADA', prazoMeses: 12 }, TRAFEGO, 'prazoMeses', 'PRAZO_PROIBIDO_NO_INDETERMINADO'],
    [{ duracao: 'INDETERMINADA', avisoPrevioDias: 0 }, TRAFEGO, 'avisoPrevioDias', 'AVISO_PREVIO_INVALIDO'],
    [{ duracao: 'INDETERMINADA', avisoPrevioDias: 366 }, TRAFEGO, 'avisoPrevioDias', 'AVISO_PREVIO_INVALIDO'],
    [{ duracao: 'INDETERMINADA', avisoPrevioDias: -5 }, TRAFEGO, 'avisoPrevioDias', 'AVISO_PREVIO_INVALIDO'],
    [{ duracao: 'INDETERMINADA', avisoPrevioDias: 30.5 }, TRAFEGO, 'avisoPrevioDias', 'VALOR_INVALIDO'],
    [{ duracao: 'INDETERMINADA', avisoPrevioDias: '30' }, TRAFEGO, 'avisoPrevioDias', 'TIPO_INVALIDO'],
    [{ duracao: 'DEFINIDA', prazoMeses: 12, avisoPrevioDias: 30 }, TRAFEGO, 'avisoPrevioDias', 'AVISO_PREVIO_NAO_PERMITIDO'],
    [{ prazoMeses: 12, avisoPrevioDias: 30 }, TRAFEGO, 'avisoPrevioDias', 'AVISO_PREVIO_NAO_PERMITIDO'],
    [{ duracao: 'DEFINIDA' }, TRAFEGO, 'prazoMeses', 'OBRIGATORIO'],
    [{}, TRAFEGO, 'prazoMeses', 'OBRIGATORIO'],
    [{ duracao: 'DEFINIDA', prazoMeses: null }, TRAFEGO, 'prazoMeses', 'PRAZO_INVALIDO'],
    [{ duracao: 'PERPETUA' }, TRAFEGO, 'duracao', 'VALOR_INVALIDO'],
    [{ duracao: 7 }, TRAFEGO, 'duracao', 'TIPO_INVALIDO'],
    [{ duracao: 'INDETERMINADA', periodicidade: null }, TRAFEGO, 'periodicidade', 'PERIODICIDADE_OBRIGATORIA'],
    [{ duracao: 'INDETERMINADA', periodicidade: 'ANUAL' }, SITE, 'periodicidade', 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO'],
    [{ duracao: 'INDETERMINADA', formaPagamento: 'RECORRENTE' }, SO_UNICO, 'formaPagamento', 'FORMA_NAO_PERMITIDA_PELO_SERVICO'],
  ];
  for (const [extras, servico, path, code] of casos) {
    const erro = await falha(() => domain.createNegotiation(e.deps, { ...base(e, { serviceId: servico.id }), ...extras }, servico, OP, clock(T0)));
    assert.equal(erro.code, NEGOTIATION_ERROR.INVALID_INPUT, JSON.stringify(extras));
    assert.ok(temErro(erro, path, code), `${JSON.stringify(extras)} -> esperava ${path}/${code}, veio ${JSON.stringify(erros(erro))}`);
  }
  assert.deepEqual(await domain.listNegotiations(e.deps), [], 'nenhuma tentativa recusada gravou algo');
});

test('[NEG-D3-5] COMPATIBILIDADE: sem `duracao` o contrato é DEFINIDO e tudo é como era — pagamento único, mensal, trimestral, semestral e anual com TCV = valor × cobranças e `avisoPrevioDias` nulo', async () => {
  const e = await ambiente();
  const casos = [
    [SITE, { serviceId: SITE.id, formaPagamento: 'UNICO', periodicidade: null, prazoMeses: 6, valorNegociado: 5000 }, [5000, null]],
    [TRAFEGO, { prazoMeses: 12, periodicidade: 'MENSAL' }, [16200, 1350]],
    [TRAFEGO, { prazoMeses: 12, periodicidade: 'TRIMESTRAL' }, [5400, null]],
    [TRAFEGO, { prazoMeses: 24, periodicidade: 'SEMESTRAL' }, [5400, null]],
    [TRAFEGO, { prazoMeses: 36, periodicidade: 'ANUAL' }, [4050, null]],
  ];
  for (const [servico, extras, [tcv, mrr]] of casos) {
    const n = await domain.createNegotiation(e.deps, base(e, extras), servico, OP, clock(T0));
    assert.deepEqual([n.duracao, n.avisoPrevioDias, n.financeiro.tcv, n.financeiro.mrr, n.financeiro.tcvIndeterminado], ['DEFINIDA', null, tcv, mrr, false], JSON.stringify(extras));
    assert.equal(Number.isInteger(n.prazoMeses), true);
  }
});

test('[NEG-D3-6] CORREÇÃO do contrato real por EDIÇÃO: o mesmo ID e o histórico preservados; a duração vira indeterminada, o aviso prévio 30 dias, o valor R$ 1.350,00 mensal fica, o MRR continua e o TCV fechado incorreto (R$ 16.200,00) some — com o evento de auditoria', async () => {
  const e = await ambiente();
  const original = await definido(e); // como foi salvo: 12 meses, TCV R$ 16.200,00
  assert.equal(original.financeiro.tcv, 16200);
  const movida = await domain.moveNegotiation(e.deps, original.id, (await funnelDomain.listStages(e.deps.funnelRepository, e.funil.id))[1].id, OP, clock(T1));
  const antes = await domain.getNegotiation(e.deps, original.id);
  const corrigida = await editar(e, original.id, { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 }, TRAFEGO, OP, T2);
  assert.equal(corrigida.id, original.id, 'o ID é preservado');
  assert.equal(corrigida.cardId, original.cardId, 'o card é o mesmo');
  assert.deepEqual([corrigida.duracao, corrigida.prazoMeses, corrigida.avisoPrevioDias, corrigida.formaPagamento, corrigida.periodicidade, corrigida.valorNegociado], ['INDETERMINADA', null, 30, 'RECORRENTE', 'MENSAL', 1350]);
  assert.deepEqual([corrigida.financeiro.mrr, corrigida.financeiro.tcv, corrigida.financeiro.tcvIndeterminado], [1350, null, true], 'MRR atualizado e o TCV fechado incorreto removido');
  assert.equal(corrigida.situacao, antes.situacao, 'a situação não muda');
  assert.equal(corrigida.stageId, movida.stageId, 'a etapa não muda: o card continua onde estava');
  assert.equal(corrigida.criadoEm, original.criadoEm);
  assert.equal(corrigida.atualizadoEm, T2.toISOString());
  assert.deepEqual([corrigida.atualizadoPorUserId, corrigida.criadoPorUserId], ['user-admin', 'user-admin']);
  // o histórico: tudo o que já havia, intacto, e UM evento novo com o de/para de cada campo
  assert.deepEqual(corrigida.eventos.slice(0, antes.eventos.length), antes.eventos, 'os eventos anteriores não mudaram');
  assert.equal(corrigida.eventos.length, antes.eventos.length + 1);
  const evento = corrigida.eventos.at(-1);
  assert.deepEqual([evento.tipo, evento.porUserId, evento.em], [EVENT.UPDATED, 'user-admin', T2.toISOString()]);
  const alteracoes = Object.fromEntries(evento.detalhe.alteracoes.map((a) => [a.campo, [a.de, a.para]]));
  assert.deepEqual(alteracoes, { prazoMeses: [12, null], duracao: ['DEFINIDA', 'INDETERMINADA'], avisoPrevioDias: [null, 30] }, 'o valor e a forma de pagamento não aparecem: não mudaram');
  // gravado de verdade
  const lida = await domain.getNegotiation(e.deps, original.id);
  assert.deepEqual([lida.duracao, lida.prazoMeses, lida.avisoPrevioDias, lida.financeiro.tcv, lida.eventos.length], ['INDETERMINADA', null, 30, null, antes.eventos.length + 1]);
});

test('[NEG-D3-7] a edição leva SÓ o necessário: passar para indeterminado sem enviar o prazo tira o prazo; mudar só o aviso registra só o aviso; voltar para definido exige o prazo e tira o aviso; um PATCH sem mudança não grava nada', async () => {
  const e = await ambiente();
  const n = await definido(e);
  // sem enviar o prazo: o prazo some sozinho (não pode sobrar "12 meses" num contrato indeterminado)
  const a = await editar(e, n.id, { duracao: 'INDETERMINADA' }, TRAFEGO, OP, T1);
  assert.deepEqual([a.duracao, a.prazoMeses, a.avisoPrevioDias, a.financeiro.tcv], ['INDETERMINADA', null, null, null]);
  assert.deepEqual(a.eventos.at(-1).detalhe.alteracoes.map((x) => x.campo).sort(), ['duracao', 'prazoMeses']);
  // só o aviso
  const b = await editar(e, n.id, { avisoPrevioDias: 45 }, TRAFEGO, OP, T2);
  assert.equal(b.avisoPrevioDias, 45);
  assert.deepEqual(b.eventos.at(-1).detalhe.alteracoes, [{ campo: 'avisoPrevioDias', de: null, para: 45 }]);
  // sem mudança real: nada é gravado, nem o histórico
  const igual = await editar(e, n.id, { avisoPrevioDias: 45, duracao: 'INDETERMINADA' }, TRAFEGO, OP, new Date('2026-10-19T16:00:00.000Z'));
  assert.equal(igual.eventos.length, b.eventos.length);
  assert.equal(igual.atualizadoEm, b.atualizadoEm);
  assert.ok(temErro(await falha(() => editar(e, n.id, {})), '', 'NADA_A_ALTERAR'));
  // voltar para definido: sem prazo é erro; com prazo, o aviso prévio sai
  assert.ok(temErro(await falha(() => editar(e, n.id, { duracao: 'DEFINIDA' })), 'prazoMeses', 'PRAZO_INVALIDO'));
  const c = await editar(e, n.id, { duracao: 'DEFINIDA', prazoMeses: 12 }, TRAFEGO, OP, new Date('2026-10-19T17:00:00.000Z'));
  assert.deepEqual([c.duracao, c.prazoMeses, c.avisoPrevioDias, c.financeiro.tcv], ['DEFINIDA', 12, null, 16200]);
  assert.deepEqual(Object.fromEntries(c.eventos.at(-1).detalhe.alteracoes.map((x) => [x.campo, [x.de, x.para]])), { duracao: ['INDETERMINADA', 'DEFINIDA'], prazoMeses: [null, 12], avisoPrevioDias: [45, null] });
});

test('[NEG-D3-8] VALIDAÇÕES da edição: aviso num prazo definido, prazo num indeterminado, pagamento único num indeterminado, aviso fora do intervalo — recusados sem gravar, com o histórico intacto', async () => {
  const e = await ambiente();
  const definida = await definido(e);
  const indef = await indeterminado(e);
  const antesD = await domain.getNegotiation(e.deps, definida.id);
  const antesI = await domain.getNegotiation(e.deps, indef.id);
  assert.ok(temErro(await falha(() => editar(e, definida.id, { avisoPrevioDias: 30 })), 'avisoPrevioDias', 'AVISO_PREVIO_NAO_PERMITIDO'));
  assert.ok(temErro(await falha(() => editar(e, indef.id, { prazoMeses: 12 })), 'prazoMeses', 'PRAZO_PROIBIDO_NO_INDETERMINADO'));
  assert.ok(temErro(await falha(() => editar(e, indef.id, { formaPagamento: 'UNICO' }, SITE)), 'duracao', 'DURACAO_INDETERMINADA_EXIGE_RECORRENCIA'));
  assert.ok(temErro(await falha(() => editar(e, indef.id, { avisoPrevioDias: 0 })), 'avisoPrevioDias', 'AVISO_PREVIO_INVALIDO'));
  assert.ok(temErro(await falha(() => editar(e, indef.id, { avisoPrevioDias: 400 })), 'avisoPrevioDias', 'AVISO_PREVIO_INVALIDO'));
  assert.ok(temErro(await falha(() => editar(e, indef.id, { duracao: 'ETERNA' })), 'duracao', 'VALOR_INVALIDO'));
  assert.ok(temErro(await falha(() => editar(e, indef.id, { periodicidade: null })), 'periodicidade', 'PERIODICIDADE_OBRIGATORIA'));
  assert.deepEqual(await domain.getNegotiation(e.deps, definida.id), antesD);
  assert.deepEqual(await domain.getNegotiation(e.deps, indef.id), antesI);
});

test('[NEG-D3-9] só uma negociação ABERTA se edita: ganha ou perdida recusa a correção do prazo (CLOSED); reaberta, volta a poder ser corrigida — e o histórico guarda tudo', async () => {
  const e = await ambiente();
  const n = await definido(e);
  await domain.winNegotiation(e.deps, n.id, OP, clock(T1));
  const erro = await falha(() => editar(e, n.id, { duracao: 'INDETERMINADA', avisoPrevioDias: 30 }, TRAFEGO, OP, T2));
  assert.equal(erro.code, NEGOTIATION_ERROR.CLOSED);
  assert.equal((await domain.getNegotiation(e.deps, n.id)).duracao, 'DEFINIDA', 'nada mudou');
  await domain.reopenNegotiation(e.deps, n.id, OP, clock(T2));
  const corrigida = await editar(e, n.id, { duracao: 'INDETERMINADA', avisoPrevioDias: 30 }, TRAFEGO, OP, new Date('2026-10-19T18:00:00.000Z'));
  assert.deepEqual([corrigida.situacao, corrigida.duracao, corrigida.financeiro.tcv], [SITUATION.OPEN, 'INDETERMINADA', null]);
  assert.deepEqual(corrigida.eventos.map((x) => x.tipo), [EVENT.CREATED, EVENT.WON, EVENT.REOPENED, EVENT.UPDATED]);
});

test('[NEG-D3-10] CONCORRÊNCIA: duas edições simultâneas (aviso prévio e valor) são serializadas — as duas valem, cada uma com o seu evento, nenhuma sobrescreve a outra', async () => {
  const e = await ambiente();
  const n = await indeterminado(e);
  const [a, b] = await Promise.all([editar(e, n.id, { avisoPrevioDias: 60 }, TRAFEGO, OP, T1), editar(e, n.id, { valorNegociado: 1400 }, TRAFEGO, OP2, T2)]);
  const final = await domain.getNegotiation(e.deps, n.id);
  assert.deepEqual([final.avisoPrevioDias, final.valorNegociado, final.duracao, final.prazoMeses, final.financeiro.mrr, final.financeiro.tcv], [60, 1400, 'INDETERMINADA', null, 1400, null]);
  assert.equal(final.eventos.length, 3);
  assert.deepEqual(final.eventos.slice(1).map((x) => x.detalhe.alteracoes.map((y) => y.campo)).sort(), [['avisoPrevioDias'], ['valorNegociado']]);
  assert.ok(a && b);
});

test('[NEG-D3-11] INDICADORES: o TCV indeterminado NÃO é somado como zero nem estimado — o TCV é o CONHECIDO, os indeterminados são contados à parte e o MRR deles entra; por etapa também', async () => {
  const e = await ambiente();
  await definido(e); // 16.200 (mensal 1.350)
  await domain.createNegotiation(e.deps, base(e, { serviceId: SITE.id, formaPagamento: 'UNICO', periodicidade: null, prazoMeses: 6, valorNegociado: 5000 }), SITE, OP, clock(T0)); // 5.000 único
  await indeterminado(e); // MRR 1.350, TCV indeterminado
  await indeterminado(e, { periodicidade: 'TRIMESTRAL', valorNegociado: 1350 }); // equivalente mensal 450, TCV indeterminado
  const resumo = domain.summarizeNegotiations(await domain.listNegotiations(e.deps));
  assert.equal(resumo.total, 4);
  assert.deepEqual([resumo.abertas.quantidade, resumo.abertas.tcv, resumo.abertas.tcvIndeterminado, resumo.abertas.mrr, resumo.abertas.equivalenteMensalOutrasRecorrencias, resumo.abertas.semCalculo], [4, 21200, 2, 2700, 450, 0]);
  assert.equal(resumo.abertas.receitaMensalEquivalenteTotal, 3150);
  const linha = resumo.porEtapa[0];
  assert.deepEqual([linha.quantidade, linha.tcv, linha.tcvIndeterminadas, linha.mrr], [4, 21200, 2, 2700]);
  // ganha: o indeterminado entra no MRR contratado e fica de fora do TCV
  const todas = await domain.listNegotiations(e.deps);
  const ind = todas.find((n) => n.duracao === 'INDETERMINADA' && n.periodicidade === 'MENSAL');
  await domain.winNegotiation(e.deps, ind.id, OP, clock(T1));
  const depois = domain.summarizeNegotiations(await domain.listNegotiations(e.deps));
  assert.deepEqual([depois.ganhas.quantidade, depois.ganhas.tcv, depois.ganhas.tcvIndeterminado, depois.ganhas.mrr], [1, 0, 1, 1350], 'TCV conhecido 0 aqui é "nenhum contrato com TCV conhecido" — a contagem de indeterminados mostra por quê');
  assert.deepEqual([depois.abertas.quantidade, depois.abertas.tcv, depois.abertas.tcvIndeterminado], [3, 21200, 1]);
  // só indeterminados: o TCV conhecido é 0 e o resumo diz que há indeterminados (a tela nunca mostra "0" sozinho)
  const e2 = await ambiente();
  await indeterminado(e2);
  const so = domain.summarizeNegotiations(await domain.listNegotiations(e2.deps));
  assert.deepEqual([so.abertas.tcv, so.abertas.tcvIndeterminado, so.abertas.mrr], [0, 1, 1350]);
  for (const bucket of [resumo.abertas, resumo.ganhas, so.abertas]) for (const valor of Object.values(bucket)) assert.equal(Number.isNaN(valor), false);
});

test('[NEG-D3-12] mudar de etapa, ganhar, perder e reabrir um contrato por prazo indeterminado funcionam como sempre (e preservam a duração, o aviso e o TCV indeterminado)', async () => {
  const e = await ambiente();
  const n = await indeterminado(e);
  const etapas = await funnelDomain.listStages(e.deps.funnelRepository, e.funil.id);
  const movida = await domain.moveNegotiation(e.deps, n.id, etapas[1].id, OP, clock(T1));
  assert.deepEqual([movida.stageNome, movida.duracao, movida.avisoPrevioDias, movida.financeiro.tcv], ['Proposta', 'INDETERMINADA', 30, null]);
  const perdida = await domain.loseNegotiation(e.deps, n.id, 'Sem orçamento', OP, clock(T2));
  assert.deepEqual([perdida.situacao, perdida.duracao, perdida.prazoMeses, perdida.financeiro.tcv], [SITUATION.LOST, 'INDETERMINADA', null, null]);
  const reaberta = await domain.reopenNegotiation(e.deps, n.id, OP, clock(new Date('2026-10-19T18:00:00.000Z')));
  assert.deepEqual([reaberta.situacao, reaberta.duracao, reaberta.prazoMeses, reaberta.avisoPrevioDias], [SITUATION.OPEN, 'INDETERMINADA', null, 30]);
  const ganha = await domain.winNegotiation(e.deps, n.id, OP, clock(new Date('2026-10-19T19:00:00.000Z')));
  assert.deepEqual([ganha.situacao, ganha.financeiro.mrr, ganha.financeiro.tcvIndeterminado], [SITUATION.WON, 1350, true]);
  assert.deepEqual(ganha.eventos.map((x) => x.tipo), [EVENT.CREATED, EVENT.MOVED, EVENT.LOST, EVENT.REOPENED, EVENT.WON]);
});

// Uma negociação gravada ANTES da D3 não tem `duracao` nem `avisoPrevioDias`: no arquivo isso é literal (o objeto antigo); no Supabase o banco antigo é coberto em negotiationIndefiniteTermLegacyDb.test.js.
test('[NEG-D3-13] uma negociação ANTERIOR à D3 (objeto sem `duracao` e sem `avisoPrevioDias`) vale como DEFINIDA em tudo: leitura, TCV, indicadores e a primeira edição (o evento mostra DEFINIDA -> INDETERMINADA, não "vazio")', { skip: MODO === 'supabase' }, async () => {
  const e = await ambiente();
  const n = await definido(e);
  const { duracao, avisoPrevioDias, ...antiga } = await e.deps.repository.getById(n.id);
  void duracao;
  void avisoPrevioDias;
  await e.deps.repository.save(antiga);
  assert.equal('duracao' in (await e.deps.repository.getById(n.id)), false, 'o armazenado é mesmo o formato antigo');
  const lida = await domain.getNegotiation(e.deps, n.id);
  assert.deepEqual([lida.duracao, lida.avisoPrevioDias, lida.prazoMeses, lida.financeiro.tcv, lida.financeiro.tcvIndeterminado], ['DEFINIDA', null, 12, 16200, false]);
  const resumo = domain.summarizeNegotiations(await domain.listNegotiations(e.deps));
  assert.deepEqual([resumo.abertas.tcv, resumo.abertas.tcvIndeterminado, resumo.abertas.mrr], [16200, 0, 1350]);
  const corrigida = await editar(e, n.id, { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 });
  assert.deepEqual(Object.fromEntries(corrigida.eventos.at(-1).detalhe.alteracoes.map((x) => [x.campo, [x.de, x.para]])), { prazoMeses: [12, null], duracao: ['DEFINIDA', 'INDETERMINADA'], avisoPrevioDias: [null, 30] });
});
