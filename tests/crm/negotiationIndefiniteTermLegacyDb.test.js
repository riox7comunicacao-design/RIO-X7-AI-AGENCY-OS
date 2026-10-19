// Compatibilidade do código NOVO com o banco SEM a migration D3 (20261021090000): o PostgREST falso em `schemaD3: false` tem a tabela como a D1.1 a criou (sem `duracao_tipo` e `aviso_previo_dias`, com
// `prazo_meses` NOT NULL). O que se promete: contratos de prazo definido continuam sendo lidos, criados e editados; um contrato por prazo INDETERMINADO é RECUSADO pelo banco antigo (erro de armazenamento,
// nada gravado) — nunca gravado errado. Só faz sentido no modo Supabase. Dados fictícios; nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/crm/negotiationDomain');
const { NEGOTIATION_ERROR } = domain;
const funnelDomain = require('../../src/crm/funnelDomain');
const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { criarArmazenamento } = require('../helpers/commercialStorage');

const OP = Object.freeze({ userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' });
const T0 = new Date('2026-10-19T12:00:00.000Z');
const T1 = new Date('2026-10-19T13:00:00.000Z');
const clock = (date) => ({ now: () => date });
const TRAFEGO = Object.freeze({ id: 'service:00000000-0000-4000-8000-0000000000b1', nome: 'Gestão de Tráfego Pago', ativo: true, permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] });

async function ambiente(schemaD3) {
  const armazenamento = criarArmazenamento({ modo: 'supabase', fakeOptions: { schemaD3 } });
  const crmRepository = createInMemoryCrmRepository();
  const funil = await funnelDomain.createFunnel(armazenamento.funnelRepository, { nome: 'Vendas' });
  await funnelDomain.createStage(armazenamento.funnelRepository, funil.id, { nome: 'Contato' });
  const cliente = (await crmDomain.createRecord(crmRepository, { empresa: 'Cliente Teste' })).record;
  return { deps: { repository: armazenamento.negotiationRepository, funnelRepository: armazenamento.funnelRepository, crmRepository }, funil, cliente, db: armazenamento.db };
}
const corpo = (e, extras = {}) => ({ crmRecordId: e.cliente.id, funnelId: e.funil.id, serviceId: TRAFEGO.id, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1350, ...extras });

test('[NEG-D3-LEG-1] banco SEM a D3: o contrato de prazo DEFINIDO é criado, lido e editado como sempre — e é lido como DEFINIDO, sem aviso prévio, sem nenhuma coluna nova', async () => {
  const e = await ambiente(false);
  const n = await domain.createNegotiation(e.deps, corpo(e, { prazoMeses: 12 }), TRAFEGO, OP, clock(T0));
  assert.deepEqual([n.duracao, n.prazoMeses, n.avisoPrevioDias, n.financeiro.tcv, n.financeiro.mrr], ['DEFINIDA', 12, null, 16200, 1350]);
  const linha = [...e.db.tabelas.crm_negotiations.values()][0];
  assert.equal('duracao_tipo' in linha, false, 'o banco antigo não tem a coluna e nada foi gravado nela');
  assert.equal('aviso_previo_dias' in linha, false);
  const lida = await domain.getNegotiation(e.deps, n.id);
  assert.deepEqual([lida.duracao, lida.avisoPrevioDias, lida.prazoMeses], ['DEFINIDA', null, 12]);
  const editada = await domain.updateNegotiation(e.deps, n.id, { prazoMeses: 24 }, TRAFEGO, OP, clock(T1));
  assert.deepEqual([editada.prazoMeses, editada.financeiro.tcv, editada.duracao], [24, 32400, 'DEFINIDA']);
});

test('[NEG-D3-LEG-2] banco SEM a D3: criar um contrato por prazo INDETERMINADO é RECUSADO (falha de armazenamento, mensagem fixa) e NADA é gravado — nem negociação, nem evento, nem card', async () => {
  const e = await ambiente(false);
  let erro;
  try {
    await domain.createNegotiation(e.deps, corpo(e, { duracao: 'INDETERMINADA', avisoPrevioDias: 30 }), TRAFEGO, OP, clock(T0));
  } catch (falha) {
    erro = falha;
  }
  assert.ok(erro, 'esperava falha');
  assert.equal(erro.name, 'NegotiationError');
  assert.equal(erro.code, NEGOTIATION_ERROR.PERSISTENCE);
  assert.equal(e.db.tabelas.crm_negotiations.size, 0);
  assert.equal(e.db.tabelas.crm_negotiation_events.length, 0);
  assert.deepEqual(await domain.listNegotiations(e.deps), []);
  assert.doesNotMatch(String(erro.message), /prazo_meses|not-null|constraint/i, 'a mensagem ao cliente nunca mostra o detalhe do banco');
});

test('[NEG-D3-LEG-3] banco SEM a D3: corrigir um contrato existente para prazo indeterminado é recusado e o contrato, o histórico e o TCV ficam exatamente como estavam', async () => {
  const e = await ambiente(false);
  const n = await domain.createNegotiation(e.deps, corpo(e, { prazoMeses: 12 }), TRAFEGO, OP, clock(T0));
  const antes = await domain.getNegotiation(e.deps, n.id);
  let erro;
  try {
    await domain.updateNegotiation(e.deps, n.id, { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 }, TRAFEGO, OP, clock(T1));
  } catch (falha) {
    erro = falha;
  }
  assert.ok(erro);
  assert.equal(erro.code, NEGOTIATION_ERROR.PERSISTENCE);
  assert.deepEqual(await domain.getNegotiation(e.deps, n.id), antes, 'nada mudou: o histórico não ganhou evento e o TCV continua o de antes');
});

test('[NEG-D3-LEG-4] banco COM a D3: as mesmas operações funcionam e o banco guarda as duas colunas (a prova do contraste com o banco antigo)', async () => {
  const e = await ambiente(true);
  const n = await domain.createNegotiation(e.deps, corpo(e, { duracao: 'INDETERMINADA', avisoPrevioDias: 30 }), TRAFEGO, OP, clock(T0));
  const linha = [...e.db.tabelas.crm_negotiations.values()][0];
  assert.deepEqual([linha.duracao_tipo, linha.prazo_meses, linha.aviso_previo_dias, linha.valor_centavos], ['INDETERMINADA', null, 30, 135000]);
  assert.equal(n.financeiro.tcv, null);
});
