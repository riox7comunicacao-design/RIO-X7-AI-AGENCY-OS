// NEGOCIAÇÕES de clientes PESSOA FÍSICA e JURÍDICA (CRM 5.0, Fase D2): o domínio de Negociações com clientes que NÃO têm `empresa` (PF), vários negócios do mesmo cliente, o vínculo pelo ID estável quando o
// cadastro do cliente é revisado, e a garantia de que nada dos campos financeiros legados (valorProposta/valorTotal) é copiado ou alterado. Roda nos DOIS armazenamentos (arquivo/memória e adapters do
// Supabase sobre o PostgREST falso): negotiationPerson.test.js e negotiationPerson.supabase.test.js. Dados fictícios; nenhuma rede, nenhum arquivo de data/.

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/crm/negotiationDomain');
const { NEGOTIATION_ERROR, SITUATION } = domain;
const funnelDomain = require('../../src/crm/funnelDomain');
const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { criarArmazenamento } = require('../helpers/commercialStorage');

const OP = Object.freeze({ userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' });
const T0 = new Date('2026-10-18T12:00:00.000Z');
const clock = (date) => ({ now: () => date });
const AUDIT = Object.freeze({ actor: 'HUMAN', reviewedBy: OP, motivo: null });
const SERVICO = Object.freeze({ id: 'service:00000000-0000-4000-8000-000000000001', nome: 'Gestão de redes', ativo: true, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] });
const SO_UNICO = Object.freeze({ ...SERVICO, id: 'service:00000000-0000-4000-8000-000000000002', nome: 'Site', permitePagamentoRecorrente: false, periodicidades: [] });

async function ambiente() {
  const armazenamento = criarArmazenamento();
  const funnelRepository = armazenamento.funnelRepository;
  const crmRepository = createInMemoryCrmRepository();
  const funil = await funnelDomain.createFunnel(funnelRepository, { nome: 'Inbound' });
  const etapa = await funnelDomain.createStage(funnelRepository, funil.id, { nome: 'Contato' });
  const pf = (await crmDomain.createRecord(crmRepository, { tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', cpf: '529.982.247-25', valorProposta: 777, valorTotal: 9999 }, AUDIT)).record;
  const pj = (await crmDomain.createRecord(crmRepository, { tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cnpj: '11.222.333/0001-81' }, AUDIT)).record;
  return { deps: { repository: armazenamento.negotiationRepository, funnelRepository, crmRepository }, funil, etapa, pf, pj };
}
const corpo = (e, cliente, extras = {}) => ({ crmRecordId: cliente.id, funnelId: e.funil.id, serviceId: SERVICO.id, prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, ...extras });
const criar = (e, cliente, extras = {}, servico = SERVICO) => domain.createNegotiation(e.deps, corpo(e, cliente, extras), servico, OP, clock(T0));

test('[NEG-PERSON-1] uma Pessoa FÍSICA (sem `empresa`) recebe negociação: o card nasce vinculado ao ID estável do cliente, na primeira etapa, e nada no domínio de Negociações depende de empresa', async () => {
  const e = await ambiente();
  assert.equal(e.pf.empresa, null);
  const n = await criar(e, e.pf);
  assert.equal(n.crmRecordId, e.pf.id);
  assert.equal(n.situacao, SITUATION.OPEN);
  const card = await e.deps.funnelRepository.getCard(n.cardId);
  assert.deepEqual([card.negotiationId, card.crmRecordId, card.stageId], [n.id, e.pf.id, e.etapa.id]);
  assert.equal((await e.deps.repository.getById(n.id)).id, n.id);
});

test('[NEG-PERSON-2] cliente PF e cliente PJ no mesmo funil: cada um com a sua negociação e o seu card; a lista por cliente devolve só as dele', async () => {
  const e = await ambiente();
  const doPf = await criar(e, e.pf);
  const doPj = await criar(e, e.pj, { valorNegociado: 3000 });
  assert.notEqual(doPf.cardId, doPj.cardId);
  const listaPf = await domain.listNegotiations(e.deps, { crmRecordId: e.pf.id });
  const listaPj = await domain.listNegotiations(e.deps, { crmRecordId: e.pj.id });
  assert.deepEqual(listaPf.map((n) => n.id), [doPf.id]);
  assert.deepEqual(listaPj.map((n) => n.id), [doPj.id]);
});

test('[NEG-PERSON-3] UM CLIENTE PF, VÁRIAS NEGOCIAÇÕES (serviços e formas de pagamento diferentes, no mesmo funil): todas abertas, cada uma com card e histórico próprios', async () => {
  const e = await ambiente();
  const a = await criar(e, e.pf);
  const b = await criar(e, e.pf, { serviceId: SO_UNICO.id, formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 5000 }, SO_UNICO);
  const c = await criar(e, e.pf, { valorNegociado: 2500 });
  assert.equal(new Set([a.cardId, b.cardId, c.cardId]).size, 3, 'três cards, um por negociação');
  const lista = await domain.listNegotiations(e.deps, { crmRecordId: e.pf.id });
  assert.equal(lista.length, 3);
  assert.deepEqual(lista.map((n) => n.situacao), [SITUATION.OPEN, SITUATION.OPEN, SITUATION.OPEN]);
  assert.deepEqual(lista.map((n) => n.eventos.length), [1, 1, 1]);
  assert.deepEqual(lista.map((n) => n.valorNegociado).sort((x, y) => x - y), [1500, 2500, 5000]);
});

test('[NEG-PERSON-4] NADA dos campos legados é copiado nem alterado: valorProposta e valorTotal do cadastro (777 e 9999) não entram na negociação, e o registro do cliente fica idêntico depois de abrir e fechar negócios', async () => {
  const e = await ambiente();
  const antes = JSON.stringify(await e.deps.crmRepository.getById(e.pf.id));
  const n = await criar(e, e.pf);
  const ganha = await domain.winNegotiation(e.deps, n.id, OP, clock(T0));
  assert.equal(ganha.situacao, SITUATION.WON);
  for (const campo of ['valorProposta', 'valorTotal']) assert.equal(Object.prototype.hasOwnProperty.call(n, campo), false, `${campo} não existe na negociação`);
  assert.equal(JSON.stringify(n).includes('9999'), false);
  assert.notEqual(n.valorNegociado, 777);
  assert.equal(JSON.stringify(await e.deps.crmRepository.getById(e.pf.id)), antes, 'o registro do cliente ficou idêntico');
});

test('[NEG-PERSON-5] a REVISÃO do cadastro do cliente (definir/trocar o tipo, completar o nome) não rompe o vínculo: a negociação segue apontando para o MESMO ID estável', async () => {
  const e = await ambiente();
  const n = await criar(e, e.pj);
  const revisado = await crmDomain.updateRecord(e.deps.crmRepository, e.pj.id, { tipoPessoa: 'PJ', contato: 'Ana Lima' });
  assert.equal(revisado.id, e.pj.id);
  const depois = await domain.getNegotiation(e.deps, n.id);
  assert.equal(depois.crmRecordId, e.pj.id);
  const cliente = await e.deps.crmRepository.getById(depois.crmRecordId);
  assert.equal(cliente.empresa, 'Clínica Aurora');
});

test('[NEG-PERSON-6] cliente BLOQUEADO (Não Contatar) — PF ou PJ — não recebe negociação nova (CLIENTE_NAO_CONTATAR), e um cliente que não existe também é recusado', async () => {
  const e = await ambiente();
  await crmDomain.markDoNotContact(e.deps.crmRepository, e.pf.id, AUDIT);
  let erro = null;
  try {
    await criar(e, e.pf);
  } catch (x) {
    erro = x;
  }
  assert.ok(erro && erro.name === 'NegotiationError', 'recusada');
  assert.equal(erro.code, NEGOTIATION_ERROR.INVALID_INPUT);
  assert.ok((erro.details.errors || []).some((item) => item.path === 'crmRecordId' && item.code === 'CLIENTE_NAO_CONTATAR'));
  let inexistente = null;
  try {
    await criar(e, { id: 'crm:00000000-0000-4000-8000-00000000ffff' });
  } catch (x) {
    inexistente = x;
  }
  assert.ok(inexistente && inexistente.name === 'NegotiationError');
  assert.equal((await domain.listNegotiations(e.deps, { crmRecordId: e.pf.id })).length, 0, 'nada foi criado');
});
