// Domínio de NEGOCIAÇÕES (src/crm/negotiationDomain.js — CRM 5.0, Fase D1, decisão 0028): criar, editar (PATCH parcial), mudar de etapa, ganhar, perder, reabrir e os indicadores, sobre
// repositórios em MEMÓRIA e o CRM/Funis reais do projeto. Dados fictícios; nenhuma rede, nenhum arquivo de data/.

const test = require('node:test');
const assert = require('node:assert/strict');

const domain = require('../../src/crm/negotiationDomain');
const { NEGOTIATION_ERROR, SITUATION, EVENT } = domain;
const funnelDomain = require('../../src/crm/funnelDomain');
const crmDomain = require('../../src/crm/crmDomain');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { criarArmazenamento, MODO } = require('../helpers/commercialStorage');
const { resposta } = require('../helpers/fakePostgrestCommercial');

const OP = Object.freeze({ userId: 'user-admin', name: 'Admin Teste', role: 'ADMIN' }); // como a ponte do CRM entrega: com o papel (o histórico do card o registra)
const OP2 = Object.freeze({ userId: 'user-closer', name: 'Closer Teste', role: 'COMMERCIAL_CLOSER' });
const T0 = new Date('2026-10-18T12:00:00.000Z');
const T1 = new Date('2026-10-18T13:30:00.000Z');
const clock = (date) => ({ now: () => date });

// O serviço do catálogo, como o Service o entrega ao domínio.
const SERVICO = Object.freeze({ id: 'service:00000000-0000-4000-8000-000000000001', nome: 'Gestão de redes', ativo: true, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] });
const SO_UNICO = Object.freeze({ ...SERVICO, id: 'service:00000000-0000-4000-8000-000000000002', nome: 'Site', permitePagamentoRecorrente: false, periodicidades: [] });
const SO_RECORRENTE = Object.freeze({ ...SERVICO, id: 'service:00000000-0000-4000-8000-000000000003', nome: 'Tráfego', permitePagamentoUnico: false, periodicidades: ['MENSAL'] });
const LEGADO = Object.freeze({ ...SERVICO, id: 'service:00000000-0000-4000-8000-000000000004', nome: 'Antigo', permitePagamentoUnico: false, permitePagamentoRecorrente: false, periodicidades: [] });

// O MESMO conjunto de testes roda nos dois modos de armazenamento (Fase D1.1): `negotiationDomain.test.js` no modo "arquivo" (memória) e `negotiationDomain.supabase.test.js` com os adapters reais do
// Supabase falando com o PostgREST falso. Onde o comportamento é o mesmo, o teste é o mesmo; as diferenças deliberadas aparecem como `if (MODO === 'supabase')`.
async function ambiente() {
  const armazenamento = criarArmazenamento();
  const funnelRepository = armazenamento.funnelRepository;
  const crmRepository = createInMemoryCrmRepository();
  const repository = armazenamento.negotiationRepository;
  const funil = await funnelDomain.createFunnel(funnelRepository, { nome: 'Vendas' });
  const etapas = [];
  for (const nome of ['Contato', 'Proposta', 'Fechamento']) etapas.push(await funnelDomain.createStage(funnelRepository, funil.id, { nome }));
  const cliente = (await crmDomain.createRecord(crmRepository, { empresa: 'Clínica Teste' })).record;
  const outroCliente = (await crmDomain.createRecord(crmRepository, { empresa: 'Outra Clínica' })).record;
  return { deps: { repository, funnelRepository, crmRepository }, funil, etapas, cliente, outroCliente, db: armazenamento.db };
}
const base = (e, extras = {}) => ({ crmRecordId: e.cliente.id, funnelId: e.funil.id, serviceId: SERVICO.id, prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, ...extras });
const criar = (e, extras = {}, servico = SERVICO, op = OP, tempo = T0) => domain.createNegotiation(e.deps, base(e, extras), servico, op, clock(tempo));
const errosDe = async (tarefa) => {
  try {
    await tarefa();
  } catch (erro) {
    assert.equal(erro.name, 'NegotiationError');
    return erro;
  }
  throw new Error('esperava uma falha e não houve');
};
const listaDe = (erro) => (erro.details && erro.details.errors) || [];

test('[NEG-DOM-1] CRIAR: nasce ABERTA, com o card na PRIMEIRA etapa do funil, o responsável de quem criou, a foto do nome do serviço, o histórico com a criação e as finanças calculadas', async () => {
  const e = await ambiente();
  const n = await criar(e);
  assert.match(n.id, /^negotiation:[0-9a-f-]{36}$/);
  assert.deepEqual([n.situacao, n.crmRecordId, n.funnelId, n.serviceId, n.servicoNome], [SITUATION.OPEN, e.cliente.id, e.funil.id, SERVICO.id, 'Gestão de redes']);
  assert.deepEqual([n.prazoMeses, n.formaPagamento, n.periodicidade, n.valorNegociado, n.previsaoFechamento], [12, 'RECORRENTE', 'MENSAL', 1500, null]);
  assert.deepEqual([n.responsavelUserId, n.responsavelNome, n.criadoPorUserId, n.atualizadoPorUserId], ['user-admin', 'Admin Teste', 'user-admin', 'user-admin']);
  assert.deepEqual([n.criadoEm, n.atualizadoEm, n.fechadoEm, n.motivoPerda], ['2026-10-18T12:00:00.000Z', '2026-10-18T12:00:00.000Z', null, null]);
  assert.equal(n.stageId, e.etapas[0].id, 'a etapa vive no card: a primeira etapa do funil');
  assert.deepEqual([n.stageNome, n.funnelNome], ['Contato', 'Vendas']);
  assert.deepEqual(n.financeiro.tcv, 18000);
  assert.deepEqual([n.financeiro.mrr, n.financeiro.equivalenteMensal], [1500, 1500]);
  assert.equal(n.eventos.length, 1);
  assert.deepEqual([n.eventos[0].tipo, n.eventos[0].porUserId, n.eventos[0].em], [EVENT.CREATED, 'user-admin', '2026-10-18T12:00:00.000Z']);
  // o card existe, vinculado a esta negociação e ao cliente
  const card = await e.deps.funnelRepository.getCard(n.cardId);
  assert.deepEqual([card.negotiationId, card.crmRecordId, card.funnelId, card.stageId], [n.id, e.cliente.id, e.funil.id, e.etapas[0].id]);
  // gravada de verdade
  assert.equal((await e.deps.repository.getById(n.id)).id, n.id);
});

test('[NEG-DOM-2] UM CLIENTE, VÁRIAS NEGOCIAÇÕES: o mesmo cliente tem duas negociações no MESMO funil (cada uma com o seu card); a regra de "um card por cliente e funil" continua valendo só para os cards avulsos', async () => {
  const e = await ambiente();
  const a = await criar(e);
  const b = await criar(e, { serviceId: SO_UNICO.id, formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 5000 }, SO_UNICO);
  assert.notEqual(a.cardId, b.cardId);
  assert.equal((await domain.listNegotiations(e.deps, { crmRecordId: e.cliente.id })).length, 2);
  assert.equal(await e.deps.funnelRepository.countActiveCardsByCrmRecord(e.cliente.id), 2, 'o cliente tem 2 cards ativos (o CRM não o exclui enquanto houver card ativo)');
  // um card avulso (sem negociação) do MESMO cliente no MESMO funil continua possível: a regra de unicidade ignora os cards de negociação
  const avulso = await funnelDomain.createCard(e.deps.funnelRepository, e.deps.crmRepository, { funnelId: e.funil.id, crmRecordId: e.cliente.id }, { reviewedBy: OP });
  assert.equal(avulso.negotiationId, undefined);
  await assert.rejects(() => funnelDomain.createCard(e.deps.funnelRepository, e.deps.crmRepository, { funnelId: e.funil.id, crmRecordId: e.cliente.id }), (erro) => erro.code === 'FUNNEL_CARD_DUPLICATE');
});

test('[NEG-DOM-3] A ESCOLHA É DA NEGOCIAÇÃO, DENTRO DO QUE O SERVIÇO PERMITE: único só se o serviço permite; recorrente só se permite, e a periodicidade tem de estar entre as permitidas', async () => {
  const e = await ambiente();
  // serviço só-único: recorrente é recusado
  let erro = await errosDe(() => criar(e, { serviceId: SO_UNICO.id }, SO_UNICO));
  assert.deepEqual(listaDe(erro), [{ path: 'formaPagamento', code: 'FORMA_NAO_PERMITIDA_PELO_SERVICO' }]);
  // serviço só-recorrente: único é recusado
  erro = await errosDe(() => criar(e, { serviceId: SO_RECORRENTE.id, formaPagamento: 'UNICO', periodicidade: null }, SO_RECORRENTE));
  assert.deepEqual(listaDe(erro), [{ path: 'formaPagamento', code: 'FORMA_NAO_PERMITIDA_PELO_SERVICO' }]);
  // periodicidade fora das permitidas (o serviço só permite mensal e trimestral)
  erro = await errosDe(() => criar(e, { periodicidade: 'ANUAL', prazoMeses: 12 }));
  assert.deepEqual(listaDe(erro), [{ path: 'periodicidade', code: 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO' }]);
  // as permitidas passam; o MESMO serviço aceita único OU recorrente: a escolha é da negociação
  assert.equal((await criar(e, { periodicidade: 'TRIMESTRAL', prazoMeses: 12 })).periodicidade, 'TRIMESTRAL');
  assert.equal((await criar(e, { formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 9000 })).formaPagamento, 'UNICO');
  // serviço LEGADO sem nenhuma forma de pagamento: não se negocia até o ADMIN completar o catálogo (nada é presumido)
  erro = await errosDe(() => criar(e, { serviceId: LEGADO.id }, LEGADO));
  assert.deepEqual(listaDe(erro), [{ path: 'serviceId', code: 'SERVICO_SEM_MODALIDADE' }]);
  // serviço inativo: não se abre uma negociação nova
  erro = await errosDe(() => criar(e, {}, { ...SERVICO, ativo: false }));
  assert.deepEqual(listaDe(erro), [{ path: 'serviceId', code: 'SERVICO_INATIVO' }]);
  // o serviço entregue tem de ser o do pedido
  erro = await errosDe(() => criar(e, { serviceId: 'service:outro' }, SERVICO));
  assert.deepEqual(listaDe(erro), [{ path: 'serviceId', code: 'SERVICO_NAO_ENCONTRADO' }]);
});

test('[NEG-DOM-4] PRAZO x PERIODICIDADE: o prazo é independente, mas numa recorrência tem de ser múltiplo da periodicidade — a combinação que não fecha é BLOQUEADA, com o erro no prazo; no pagamento único qualquer prazo vale', async () => {
  const e = await ambiente();
  const erro = await errosDe(() => criar(e, { periodicidade: 'TRIMESTRAL', prazoMeses: 10 }));
  assert.deepEqual(listaDe(erro), [{ path: 'prazoMeses', code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' }]);
  assert.equal((await criar(e, { formaPagamento: 'UNICO', periodicidade: null, prazoMeses: 10, valorNegociado: 1000 })).financeiro.tcv, 1000);
  // presets 3, 6 e 12 e um prazo personalizado
  for (const prazo of [3, 6, 12, 18, 24]) assert.equal((await criar(e, { periodicidade: 'TRIMESTRAL', prazoMeses: prazo })).prazoMeses, prazo);
  assert.equal((await criar(e, { prazoMeses: 7, periodicidade: 'MENSAL' })).financeiro.tcv, 10500, 'mensal fecha com qualquer prazo');
});

test('[NEG-DOM-5] VALIDAÇÃO DA ENTRADA: obrigatórios, tipos, valor, prazo, data e campos desconhecidos ou de sistema — cada erro com o CAMINHO e o CÓDIGO, e nada é gravado', async () => {
  const e = await ambiente();
  const semNada = await errosDe(() => domain.createNegotiation(e.deps, {}, SERVICO, OP));
  assert.deepEqual(listaDe(semNada).map((x) => `${x.path}:${x.code}`).sort(), ['crmRecordId:OBRIGATORIO', 'formaPagamento:OBRIGATORIO', 'funnelId:OBRIGATORIO', 'prazoMeses:OBRIGATORIO', 'serviceId:OBRIGATORIO', 'valorNegociado:OBRIGATORIO']);
  const casos = [
    [{ valorNegociado: 0 }, [{ path: 'valorNegociado', code: 'VALOR_INVALIDO' }]],
    [{ valorNegociado: -5 }, [{ path: 'valorNegociado', code: 'VALOR_INVALIDO' }]],
    [{ valorNegociado: 10.005 }, [{ path: 'valorNegociado', code: 'VALOR_INVALIDO' }]],
    [{ valorNegociado: '1500' }, [{ path: 'valorNegociado', code: 'TIPO_INVALIDO' }]],
    [{ prazoMeses: 0 }, [{ path: 'prazoMeses', code: 'PRAZO_INVALIDO' }]],
    [{ prazoMeses: 121 }, [{ path: 'prazoMeses', code: 'PRAZO_INVALIDO' }]],
    [{ prazoMeses: 6.5 }, [{ path: 'prazoMeses', code: 'VALOR_INVALIDO' }]],
    [{ prazoMeses: '12' }, [{ path: 'prazoMeses', code: 'TIPO_INVALIDO' }]],
    [{ formaPagamento: 'PARCELADO' }, [{ path: 'formaPagamento', code: 'VALOR_INVALIDO' }]],
    [{ periodicidade: 'QUINZENAL' }, [{ path: 'periodicidade', code: 'VALOR_INVALIDO' }]],
    [{ periodicidade: null }, [{ path: 'periodicidade', code: 'PERIODICIDADE_OBRIGATORIA' }]],
    [{ formaPagamento: 'UNICO', periodicidade: 'MENSAL' }, [{ path: 'periodicidade', code: 'PERIODICIDADE_NAO_PERMITIDA' }]],
    [{ previsaoFechamento: '31/12/2026' }, [{ path: 'previsaoFechamento', code: 'DATA_INVALIDA' }]],
    [{ previsaoFechamento: '2026-02-30' }, [{ path: 'previsaoFechamento', code: 'DATA_INVALIDA' }]],
    [{ id: 'negotiation:x' }, [{ path: 'id', code: 'CAMPO_NAO_EDITAVEL' }]],
    [{ situacao: 'GANHA' }, [{ path: 'situacao', code: 'CAMPO_NAO_EDITAVEL' }]],
    [{ responsavelUserId: 'user-x' }, [{ path: 'responsavelUserId', code: 'CAMPO_NAO_EDITAVEL' }]],
    [{ tcv: 1 }, [{ path: 'tcv', code: 'CAMPO_DESCONHECIDO' }]],
    [{ valorProposta: 10, valorTotal: 20 }, [{ path: 'valorProposta', code: 'CAMPO_DESCONHECIDO' }, { path: 'valorTotal', code: 'CAMPO_DESCONHECIDO' }]],
  ];
  for (const [extras, esperado] of casos) {
    const erro = await errosDe(() => criar(e, extras));
    assert.equal(erro.code, NEGOTIATION_ERROR.INVALID_INPUT);
    assert.deepEqual(listaDe(erro), esperado, JSON.stringify(extras));
  }
  assert.equal((await errosDe(() => domain.createNegotiation(e.deps, 'texto', SERVICO, OP))).code, NEGOTIATION_ERROR.INVALID_INPUT);
  assert.equal((await e.deps.repository.list()).length, 0, 'nenhuma recusa gravou algo');
  assert.equal((await e.deps.funnelRepository.listCardsByFunnel(e.funil.id)).length, 0, 'nem um card');
});

test('[NEG-DOM-6] REFERÊNCIAS: o cliente (registro do CRM) e o funil têm de existir e o funil estar ativo; um funil sem etapa ativa não aceita negociação — e nada fica pela metade', async () => {
  const e = await ambiente();
  let erro = await errosDe(() => criar(e, { crmRecordId: 'crm:nao-existe' }));
  assert.deepEqual(listaDe(erro), [{ path: 'crmRecordId', code: 'CLIENTE_NAO_ENCONTRADO' }]);
  erro = await errosDe(() => criar(e, { funnelId: 'funnel:nao-existe' }));
  assert.deepEqual(listaDe(erro), [{ path: 'funnelId', code: 'FUNIL_NAO_ENCONTRADO' }]);
  await funnelDomain.updateFunnel(e.deps.funnelRepository, e.funil.id, { ativo: false });
  erro = await errosDe(() => criar(e));
  assert.deepEqual(listaDe(erro), [{ path: 'funnelId', code: 'FUNIL_INATIVO' }]);
  await funnelDomain.updateFunnel(e.deps.funnelRepository, e.funil.id, { ativo: true });
  // sem nenhuma etapa ATIVA
  for (const etapa of e.etapas) await funnelDomain.updateStage(e.deps.funnelRepository, etapa.id, { ativo: false });
  erro = await errosDe(() => criar(e));
  assert.deepEqual(listaDe(erro), [{ path: 'funnelId', code: 'FUNIL_SEM_ETAPAS' }]);
  assert.equal((await e.deps.repository.list()).length, 0);
  assert.equal((await e.deps.funnelRepository.listCardsByFunnel(e.funil.id)).length, 0);
  // com a primeira etapa desativada, a negociação entra na primeira ATIVA
  await funnelDomain.updateStage(e.deps.funnelRepository, e.etapas[1].id, { ativo: true });
  assert.equal((await criar(e)).stageId, e.etapas[1].id);
});

test('[NEG-DOM-7] FALHA AO GRAVAR: se a negociação não for gravada, o card criado é ARQUIVADO (nunca sobra um card órfão visível) e o erro é de persistência, sem vazar a causa', async () => {
  const e = await ambiente();
  if (MODO === 'supabase') {
    // no banco a criação é UMA transação: se a função recusa, NADA fica — nem card, nem negociação, nem evento (não há o que arquivar)
    e.db.falhar('commit_crm_negotiation_change', resposta(500, { message: 'disco cheio: segredo-do-armazenamento' }));
    const falhou = await errosDe(() => domain.createNegotiation(e.deps, base(e), SERVICO, OP));
    assert.equal(falhou.code, NEGOTIATION_ERROR.PERSISTENCE);
    assert.doesNotMatch(falhou.message, /segredo-do-armazenamento|disco/);
    assert.doesNotMatch(falhou.cause.message, /segredo-do-armazenamento|disco/, 'nem a causa carrega a mensagem do banco');
    assert.deepEqual([e.db.tabelas.crm_funnel_cards.size, e.db.tabelas.crm_negotiations.size, e.db.tabelas.crm_negotiation_events.length, e.db.tabelas.crm_funnel_card_moves.length], [0, 0, 0, 0], 'nada foi gravado');
    return;
  }
  const quebrado = { list: () => [], getById: () => null, save: () => { throw new Error('disco cheio: segredo-do-armazenamento'); } };
  const erro = await errosDe(() => domain.createNegotiation({ ...e.deps, repository: quebrado }, base(e), SERVICO, OP));
  assert.equal(erro.code, NEGOTIATION_ERROR.PERSISTENCE);
  assert.doesNotMatch(erro.message, /segredo-do-armazenamento|disco/);
  assert.match(erro.cause.message, /disco cheio/, 'a causa fica só em cause');
  assert.equal((await e.deps.funnelRepository.listCardsByFunnel(e.funil.id)).length, 0, 'o card foi arquivado');
});

test('[NEG-DOM-8] EDITAR é PARCIAL: só o enviado muda; o que não foi enviado é preservado; o resultado é validado como um todo; sem mudança real nada é gravado; o histórico guarda campo, de e para', async () => {
  const e = await ambiente();
  const n = await criar(e);
  const caro = await domain.updateNegotiation(e.deps, n.id, { valorNegociado: 2000 }, SERVICO, OP2, clock(T1));
  assert.deepEqual([caro.valorNegociado, caro.prazoMeses, caro.formaPagamento, caro.periodicidade, caro.serviceId], [2000, 12, 'RECORRENTE', 'MENSAL', SERVICO.id], 'o resto foi preservado');
  assert.deepEqual([caro.atualizadoEm, caro.atualizadoPorUserId, caro.criadoEm, caro.criadoPorUserId, caro.responsavelUserId], ['2026-10-18T13:30:00.000Z', 'user-closer', '2026-10-18T12:00:00.000Z', 'user-admin', 'user-admin']);
  assert.equal(caro.financeiro.tcv, 24000);
  assert.equal(caro.eventos.length, 2);
  assert.deepEqual(caro.eventos[1], { tipo: EVENT.UPDATED, em: '2026-10-18T13:30:00.000Z', porUserId: 'user-closer', porNome: 'Closer Teste', detalhe: { alteracoes: [{ campo: 'valorNegociado', de: 1500, para: 2000 }] } });
  // sem mudança real: nada é gravado (nem a data, nem o histórico)
  const igual = await domain.updateNegotiation(e.deps, n.id, { valorNegociado: 2000, prazoMeses: 12 }, SERVICO, OP, clock(new Date('2027-01-01T00:00:00.000Z')));
  assert.equal(igual.atualizadoEm, '2026-10-18T13:30:00.000Z');
  assert.equal(igual.eventos.length, 2);
  // trocar para pagamento único limpa a periodicidade (sem deixar uma antiga); o prazo deixa de ter de ser múltiplo de algo
  const unico = await domain.updateNegotiation(e.deps, n.id, { formaPagamento: 'UNICO', prazoMeses: 10, valorNegociado: 9000 }, SERVICO, OP, clock(T1));
  assert.deepEqual([unico.formaPagamento, unico.periodicidade, unico.prazoMeses, unico.financeiro.tcv, unico.financeiro.mrr], ['UNICO', null, 10, 9000, null]);
  // voltar para recorrente SEM periodicidade é recusado (e nada muda)
  const recusa = await errosDe(() => domain.updateNegotiation(e.deps, n.id, { formaPagamento: 'RECORRENTE', prazoMeses: 12 }, SERVICO, OP));
  assert.deepEqual(listaDe(recusa), [{ path: 'periodicidade', code: 'PERIODICIDADE_OBRIGATORIA' }]);
  assert.equal((await domain.getNegotiation(e.deps, n.id)).formaPagamento, 'UNICO');
  // um prazo que não fecha com a periodicidade já existente
  const prazo = await errosDe(() => domain.updateNegotiation(e.deps, n.id, { formaPagamento: 'RECORRENTE', periodicidade: 'SEMESTRAL', prazoMeses: 10 }, { ...SERVICO, periodicidades: ['SEMESTRAL'] }, OP));
  assert.deepEqual(listaDe(prazo), [{ path: 'prazoMeses', code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' }]);
});

test('[NEG-DOM-9] TROCAR O SERVIÇO: valida a escolha contra o NOVO serviço, atualiza a foto do nome e nunca mexe no serviço; editar o preço de uma negociação cujo serviço mudou de regras depois NÃO é barrado', async () => {
  const e = await ambiente();
  const n = await criar(e);
  const emUnico = await errosDe(() => domain.updateNegotiation(e.deps, n.id, { serviceId: SO_UNICO.id }, SO_UNICO, OP));
  assert.deepEqual(listaDe(emUnico), [{ path: 'formaPagamento', code: 'FORMA_NAO_PERMITIDA_PELO_SERVICO' }], 'a negociação é recorrente e o novo serviço só aceita único');
  const trocado = await domain.updateNegotiation(e.deps, n.id, { serviceId: SO_UNICO.id, formaPagamento: 'UNICO', valorNegociado: 7000 }, SO_UNICO, OP, clock(T1));
  assert.deepEqual([trocado.serviceId, trocado.servicoNome, trocado.formaPagamento, trocado.periodicidade], [SO_UNICO.id, 'Site', 'UNICO', null]);
  assert.equal(trocado.eventos.at(-1).detalhe.alteracoes.some((c) => c.campo === 'serviceId'), true);
  // o serviço novo não pode estar inativo; o antigo, depois de inativado ou de mudar as regras, não impede editar só o preço
  assert.deepEqual(listaDe(await errosDe(() => domain.updateNegotiation(e.deps, n.id, { serviceId: SERVICO.id }, { ...SERVICO, ativo: false }, OP))), [{ path: 'serviceId', code: 'SERVICO_INATIVO' }]);
  const m = await criar(e);
  const so = await domain.updateNegotiation(e.deps, m.id, { valorNegociado: 1600 }, { ...SERVICO, ativo: false, permitePagamentoRecorrente: false, periodicidades: [] }, OP, clock(T1));
  assert.equal(so.valorNegociado, 1600, 'só o preço mudou: o que o serviço permite hoje não é reavaliado');
  assert.equal(so.formaPagamento, 'RECORRENTE');
});

test('[NEG-DOM-10] CAMPOS DE SISTEMA, REFERÊNCIAS E VAZIO NA EDIÇÃO: cliente, funil, card, situação, responsável, histórico e datas não se editam; um corpo vazio é erro; uma negociação inexistente é "não encontrada"', async () => {
  const e = await ambiente();
  const n = await criar(e);
  for (const campo of ['crmRecordId', 'funnelId', 'cardId', 'situacao', 'motivoPerda', 'fechadoEm', 'criadoEm', 'atualizadoEm', 'responsavelUserId', 'responsavelNome', 'servicoNome', 'eventos', 'stageId', 'id']) {
    const erro = await errosDe(() => domain.updateNegotiation(e.deps, n.id, { [campo]: 'x' }, SERVICO, OP));
    assert.deepEqual(listaDe(erro), [{ path: campo, code: 'CAMPO_NAO_EDITAVEL' }], campo);
  }
  assert.deepEqual(listaDe(await errosDe(() => domain.updateNegotiation(e.deps, n.id, {}, SERVICO, OP))), [{ path: '', code: 'NADA_A_ALTERAR' }]);
  assert.equal((await errosDe(() => domain.updateNegotiation(e.deps, 'negotiation:nao-existe', { valorNegociado: 1 }, SERVICO, OP))).code, NEGOTIATION_ERROR.NOT_FOUND);
  assert.equal(await domain.getNegotiation(e.deps, 'negotiation:nao-existe'), null);
  assert.equal((await errosDe(() => domain.getNegotiation(e.deps, ''))).code, NEGOTIATION_ERROR.INVALID_INPUT);
  assert.deepEqual((await domain.getNegotiation(e.deps, n.id)).eventos.length, 1, 'nada disso gravou');
});

test('[NEG-DOM-11] MUDAR DE ETAPA: move o card (com o histórico do card), registra o evento com os NOMES das etapas, é idempotente na mesma etapa e recusa etapa de outro funil, desativada ou inexistente', async () => {
  const e = await ambiente();
  const n = await criar(e);
  const movida = await domain.moveNegotiation(e.deps, n.id, e.etapas[1].id, OP2, { motivo: 'Cliente pediu proposta', ...clock(T1) });
  assert.deepEqual([movida.stageId, movida.stageNome], [e.etapas[1].id, 'Proposta']);
  assert.deepEqual(movida.eventos.at(-1).detalhe, { deEtapaId: e.etapas[0].id, deEtapaNome: 'Contato', paraEtapaId: e.etapas[1].id, paraEtapaNome: 'Proposta', motivo: 'Cliente pediu proposta' });
  assert.equal(movida.eventos.at(-1).tipo, EVENT.MOVED);
  const historicoDoCard = await funnelDomain.getCardHistory(e.deps.funnelRepository, n.cardId);
  assert.deepEqual(historicoDoCard.map((m) => [m.stageFrom, m.stageTo]), [[null, e.etapas[0].id], [e.etapas[0].id, e.etapas[1].id]], 'o histórico do card também registra');
  // idempotente
  const igual = await domain.moveNegotiation(e.deps, n.id, e.etapas[1].id, OP2, clock(T1));
  assert.equal(igual.eventos.length, movida.eventos.length);
  // outro funil
  const outroFunil = await funnelDomain.createFunnel(e.deps.funnelRepository, { nome: 'Outro' });
  const etapaFora = await funnelDomain.createStage(e.deps.funnelRepository, outroFunil.id, { nome: 'Fora' });
  assert.deepEqual(listaDe(await errosDe(() => domain.moveNegotiation(e.deps, n.id, etapaFora.id, OP))), [{ path: 'stageId', code: 'ETAPA_DE_OUTRO_FUNIL' }]);
  // desativada e inexistente
  await funnelDomain.updateStage(e.deps.funnelRepository, e.etapas[2].id, { ativo: false });
  assert.deepEqual(listaDe(await errosDe(() => domain.moveNegotiation(e.deps, n.id, e.etapas[2].id, OP))), [{ path: 'stageId', code: 'ETAPA_DESATIVADA' }]);
  assert.deepEqual(listaDe(await errosDe(() => domain.moveNegotiation(e.deps, n.id, 'stage:nao-existe', OP))), [{ path: 'stageId', code: 'ETAPA_NAO_ENCONTRADA' }]);
  assert.deepEqual(listaDe(await errosDe(() => domain.moveNegotiation(e.deps, n.id, '', OP))), [{ path: 'stageId', code: 'ID_INVALIDO' }]);
  assert.deepEqual(listaDe(await errosDe(() => domain.moveNegotiation(e.deps, n.id, e.etapas[0].id, OP, { motivo: '   ' }))), [{ path: 'motivo', code: 'OBRIGATORIO' }]);
  assert.equal((await domain.getNegotiation(e.deps, n.id)).stageId, e.etapas[1].id, 'as recusas não moveram nada');
});

test('[NEG-DOM-12] O CARD DE UMA NEGOCIAÇÃO só se move e só se arquiva pelas operações da NEGOCIAÇÃO: as funções de card avulso as recusam (a negociação nunca fica sem card nem fora das regras de situação)', async () => {
  const e = await ambiente();
  const n = await criar(e);
  await assert.rejects(() => funnelDomain.moveCard(e.deps.funnelRepository, n.cardId, e.etapas[1].id), (erro) => erro.code === 'FUNNEL_CARD_HAS_NEGOTIATION');
  await assert.rejects(() => funnelDomain.deleteCard(e.deps.funnelRepository, n.cardId), (erro) => erro.code === 'FUNNEL_CARD_HAS_NEGOTIATION');
  assert.equal((await e.deps.funnelRepository.getCard(n.cardId)).stageId, e.etapas[0].id);
  assert.equal((await e.deps.funnelRepository.getCard(n.cardId)).removedAt, null);
  // e a negociação não move o card de OUTRA coisa: um card avulso não é "de negociação"
  const avulso = await funnelDomain.createCard(e.deps.funnelRepository, e.deps.crmRepository, { funnelId: e.funil.id, crmRecordId: e.outroCliente.id }, { reviewedBy: OP });
  await assert.rejects(() => funnelDomain.moveNegotiationCard(e.deps.funnelRepository, avulso.id, e.etapas[1].id), /não é de uma negociação/);
  // o funil e a etapa continuam protegidos (há card ativo)
  await assert.rejects(() => funnelDomain.deleteStage(e.deps.funnelRepository, e.etapas[0].id), (erro) => erro.code === 'STAGE_HAS_CARDS');
  await assert.rejects(() => funnelDomain.deleteFunnel(e.deps.funnelRepository, e.funil.id), (erro) => erro.code === 'FUNNEL_HAS_CARDS');
});

test('[NEG-DOM-13] SITUAÇÃO: ABERTA -> GANHA ou PERDIDA (a perda exige o motivo); fechada não se edita nem muda de etapa; ganhar/perder só de ABERTA; reabrir volta a ABERTA e o histórico guarda tudo; GANHA não é "dinheiro recebido"', async () => {
  const e = await ambiente();
  const a = await criar(e);
  const ganha = await domain.winNegotiation(e.deps, a.id, OP2, clock(T1));
  assert.deepEqual([ganha.situacao, ganha.fechadoEm, ganha.motivoPerda], [SITUACAO_GANHA(), '2026-10-18T13:30:00.000Z', null]);
  assert.equal(ganha.eventos.at(-1).tipo, EVENT.WON);
  assert.equal(Object.keys(ganha).some((chave) => /recebid|pago|caixa/i.test(chave)), false, 'nenhum campo de valor recebido');
  assert.equal((await errosDe(() => domain.updateNegotiation(e.deps, a.id, { valorNegociado: 1 }, SERVICO, OP))).code, NEGOTIATION_ERROR.CLOSED);
  assert.equal((await errosDe(() => domain.moveNegotiation(e.deps, a.id, e.etapas[1].id, OP))).code, NEGOTIATION_ERROR.CLOSED);
  assert.equal((await errosDe(() => domain.winNegotiation(e.deps, a.id, OP))).code, NEGOTIATION_ERROR.INVALID_STATE);
  assert.equal((await errosDe(() => domain.loseNegotiation(e.deps, a.id, 'Preço', OP))).code, NEGOTIATION_ERROR.INVALID_STATE);

  const b = await criar(e);
  assert.deepEqual(listaDe(await errosDe(() => domain.loseNegotiation(e.deps, b.id, '', OP))), [{ path: 'motivo', code: 'OBRIGATORIO' }]);
  assert.deepEqual(listaDe(await errosDe(() => domain.loseNegotiation(e.deps, b.id, 'x'.repeat(301), OP))), [{ path: 'motivo', code: 'MUITO_LONGO' }]);
  assert.deepEqual(listaDe(await errosDe(() => domain.loseNegotiation(e.deps, b.id, 42, OP))), [{ path: 'motivo', code: 'TIPO_INVALIDO' }]);
  const perdida = await domain.loseNegotiation(e.deps, b.id, '  Escolheu   outra agência ', OP2, clock(T1));
  assert.deepEqual([perdida.situacao, perdida.motivoPerda, perdida.fechadoEm], ['PERDIDA', 'Escolheu outra agência', '2026-10-18T13:30:00.000Z']);
  assert.deepEqual(perdida.eventos.at(-1).detalhe, { motivo: 'Escolheu outra agência' });

  const reaberta = await domain.reopenNegotiation(e.deps, b.id, OP, clock(new Date('2026-10-19T09:00:00.000Z')));
  assert.deepEqual([reaberta.situacao, reaberta.motivoPerda, reaberta.fechadoEm, reaberta.stageId], ['ABERTA', null, null, e.etapas[0].id]);
  assert.deepEqual(reaberta.eventos.map((x) => x.tipo), [EVENT.CREATED, EVENT.LOST, EVENT.REOPENED]);
  assert.equal(reaberta.eventos.at(-1).detalhe.de, 'PERDIDA');
  assert.equal((await errosDe(() => domain.reopenNegotiation(e.deps, b.id, OP))).code, NEGOTIATION_ERROR.INVALID_STATE, 'reabrir uma aberta é recusado');
  assert.equal((await domain.updateNegotiation(e.deps, b.id, { valorNegociado: 1700 }, SERVICO, OP)).valorNegociado, 1700, 'reaberta, volta a ser editável');
});
function SITUACAO_GANHA() {
  return SITUATION.WON;
}

test('[NEG-DOM-14] LISTAR: da mais recente para a mais antiga, com filtros por funil, situação e cliente; cada item traz a etapa e as finanças; uma lista só de leitura não grava nada', async () => {
  const e = await ambiente();
  const a = await criar(e, {}, SERVICO, OP, new Date('2026-10-18T10:00:00.000Z'));
  const b = await criar(e, { crmRecordId: e.outroCliente.id }, SERVICO, OP, new Date('2026-10-18T11:00:00.000Z'));
  const c = await criar(e, { formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 800 }, SERVICO, OP, new Date('2026-10-18T12:00:00.000Z'));
  await domain.winNegotiation(e.deps, a.id, OP);
  assert.deepEqual((await domain.listNegotiations(e.deps)).map((n) => n.id), [c.id, b.id, a.id]);
  assert.deepEqual((await domain.listNegotiations(e.deps, { situacao: 'GANHA' })).map((n) => n.id), [a.id]);
  assert.deepEqual((await domain.listNegotiations(e.deps, { crmRecordId: e.outroCliente.id })).map((n) => n.id), [b.id]);
  assert.deepEqual((await domain.listNegotiations(e.deps, { funnelId: 'funnel:outro' })), []);
  const [primeira] = await domain.listNegotiations(e.deps);
  assert.deepEqual([primeira.stageNome, primeira.financeiro.tcv], ['Contato', 800]);
  const antes = JSON.stringify(await e.deps.repository.list());
  await domain.listNegotiations(e.deps);
  assert.equal(JSON.stringify(await e.deps.repository.list()), antes);
});

test('[NEG-DOM-15] CONCORRÊNCIA: edições simultâneas da MESMA negociação não se perdem (as escritas de um repositório rodam uma por vez)', async () => {
  const e = await ambiente();
  const n = await criar(e);
  await Promise.all([
    domain.updateNegotiation(e.deps, n.id, { valorNegociado: 1600 }, SERVICO, OP),
    domain.updateNegotiation(e.deps, n.id, { prazoMeses: 6 }, SERVICO, OP),
    domain.updateNegotiation(e.deps, n.id, { previsaoFechamento: '2026-12-01' }, SERVICO, OP),
    domain.moveNegotiation(e.deps, n.id, e.etapas[1].id, OP),
  ]);
  const final = await domain.getNegotiation(e.deps, n.id);
  assert.deepEqual([final.valorNegociado, final.prazoMeses, final.previsaoFechamento, final.stageId], [1600, 6, '2026-12-01', e.etapas[1].id]);
  assert.equal(final.eventos.length, 5, 'criada + 3 edições + 1 movimentação, todas registradas');
  // 25 criações simultâneas: 25 negociações e 25 cards
  const muitas = await Promise.all(Array.from({ length: 25 }, () => criar(e)));
  assert.equal(new Set(muitas.map((x) => x.id)).size, 25);
  assert.equal((await e.deps.funnelRepository.listCardsByFunnel(e.funil.id)).length, 26);
});

test('[NEG-DOM-16] INDICADORES: abertas, ganhas e perdidas separadas; TCV, MRR (só mensais) e equivalente mensal das demais recorrências distintos; conversão só com negociações fechadas; abertas por etapa; tudo exato em centavos', async () => {
  const e = await ambiente();
  const m1 = await criar(e, { valorNegociado: 1000.1 }); // mensal 12x: TCV 12001,20; MRR 1000,10
  const t1 = await criar(e, { periodicidade: 'TRIMESTRAL', prazoMeses: 12, valorNegociado: 3000 }); // TCV 12000; equivalente 1000
  const u1 = await criar(e, { formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 5000 });
  const m2 = await criar(e, { valorNegociado: 500 });
  const t2 = await criar(e, { valorNegociado: 700 });
  await domain.moveNegotiation(e.deps, t1.id, e.etapas[1].id, OP);
  await domain.winNegotiation(e.deps, m1.id, OP);
  await domain.winNegotiation(e.deps, t1.id, OP);
  await domain.loseNegotiation(e.deps, m2.id, 'Preço', OP);
  const resumo = domain.summarizeNegotiations(await domain.listNegotiations(e.deps));
  assert.equal(resumo.total, 5);
  assert.deepEqual(resumo.ganhas, { quantidade: 2, tcv: 24001.2, mrr: 1000.1, equivalenteMensalOutrasRecorrencias: 1000, receitaMensalEquivalenteTotal: 2000.1, semCalculo: 0 });
  assert.deepEqual(resumo.abertas, { quantidade: 2, tcv: 13400, mrr: 700, equivalenteMensalOutrasRecorrencias: 0, receitaMensalEquivalenteTotal: 700, semCalculo: 0 });
  assert.deepEqual(resumo.perdidas, { quantidade: 1, tcv: 6000, mrr: 500, equivalenteMensalOutrasRecorrencias: 0, receitaMensalEquivalenteTotal: 500, semCalculo: 0 });
  assert.deepEqual(resumo.conversao, { fechadas: 3, ganhas: 2, perdidas: 1, taxa: 2 / 3 });
  assert.deepEqual(resumo.porEtapa.map((l) => [l.stageNome, l.quantidade, l.tcv]).sort(), [['Contato', 2, 13400]]);
  void u1; void t2;
  // sem nenhuma fechada não há taxa (nunca "0%" de mentira); sem negociações, tudo zero e nada inventado
  const vazio = domain.summarizeNegotiations([]);
  assert.deepEqual([vazio.total, vazio.conversao.taxa, vazio.abertas.quantidade, vazio.ganhas.tcv, vazio.porEtapa], [0, null, 0, 0, []]);
  assert.equal(domain.summarizeNegotiations(null).total, 0);
  assert.equal(domain.summarizeNegotiations(await domain.listNegotiations(e.deps, { situacao: 'ABERTA' })).conversao.taxa, null);
});

test('[NEG-DOM-17] ISOLAMENTO: nenhuma operação lê ou grava os campos legados do CRM (valorProposta, valorTotal) nem o preço ou as modalidades do serviço; o cliente não é alterado', async () => {
  const e = await ambiente();
  await crmDomain.updateRecord(e.deps.crmRepository, e.cliente.id, { valorProposta: 1234.56, valorTotal: 9999.99 });
  const antes = JSON.stringify(await e.deps.crmRepository.getById(e.cliente.id));
  const servico = Object.freeze({ ...SERVICO, precoReferencia: 123456, periodicidades: Object.freeze([...SERVICO.periodicidades]) });
  const n = await domain.createNegotiation(e.deps, base(e, { valorNegociado: 321 }), servico, OP);
  await domain.updateNegotiation(e.deps, n.id, { valorNegociado: 322 }, servico, OP);
  await domain.moveNegotiation(e.deps, n.id, e.etapas[1].id, OP);
  await domain.winNegotiation(e.deps, n.id, OP);
  assert.equal(JSON.stringify(await e.deps.crmRepository.getById(e.cliente.id)), antes, 'o registro do CRM (com os 31 campos legados) ficou idêntico');
  const gravada = JSON.stringify(await e.deps.repository.getById(n.id));
  assert.doesNotMatch(gravada, /123456|valorProposta|valorTotal|1234.56|9999.99|precoReferencia/, 'nada do legado nem do preço de referência entrou na negociação');
  assert.equal(Object.isFrozen(servico), true);
});

test('[NEG-DOM-18] DEPENDÊNCIAS E OPERADOR: repositório inválido ou operador sem { userId, name } é erro de programação (nada é gravado); uma falha de armazenamento na leitura vira erro de persistência de mensagem fixa', async () => {
  const e = await ambiente();
  await assert.rejects(() => domain.createNegotiation({ ...e.deps, repository: {} }, base(e), SERVICO, OP), /repositório inválido/);
  await assert.rejects(() => domain.createNegotiation({ ...e.deps, funnelRepository: {} }, base(e), SERVICO, OP), /repositório inválido/);
  await assert.rejects(() => domain.createNegotiation({ ...e.deps, crmRepository: {} }, base(e), SERVICO, OP), /crmRepository inválido/);
  for (const operador of [undefined, null, {}, { userId: 'u' }, { name: 'N' }, { userId: ' ', name: 'N' }, 'texto']) {
    await assert.rejects(() => domain.createNegotiation(e.deps, base(e), SERVICO, operador), /operador inválido/);
  }
  assert.equal((await e.deps.repository.list()).length, 0);
  const lento = { list: () => { throw new Error('segredo-de-leitura'); }, getById: () => { throw new Error('segredo-de-leitura'); }, save: () => {} };
  for (const tarefa of [() => domain.listNegotiations({ ...e.deps, repository: lento }), () => domain.getNegotiation({ ...e.deps, repository: lento }, 'negotiation:x')]) {
    const erro = await errosDe(tarefa);
    assert.equal(erro.code, NEGOTIATION_ERROR.PERSISTENCE);
    assert.doesNotMatch(erro.message, /segredo-de-leitura/);
  }
});

test('[NEG-DOM-19] NÃO CONTATAR: um cliente marcado como "Não Contatar" (estado terminal do CRM) não ganha negociação nova — a recusa é no cliente, e nada é gravado', async () => {
  const e = await ambiente();
  await crmDomain.markDoNotContact(e.deps.crmRepository, e.cliente.id, { reason: 'Pediu para não ser contatado' });
  const erro = await errosDe(() => criar(e));
  assert.deepEqual(listaDe(erro), [{ path: 'crmRecordId', code: 'CLIENTE_NAO_CONTATAR' }]);
  assert.equal((await e.deps.repository.list()).length, 0);
  assert.equal((await e.deps.funnelRepository.listCardsByFunnel(e.funil.id)).length, 0);
  // outro cliente (sem o bloqueio) segue normal
  assert.equal((await criar(e, { crmRecordId: e.outroCliente.id })).crmRecordId, e.outroCliente.id);
});
