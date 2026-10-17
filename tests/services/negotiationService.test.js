// Negotiation Service (src/services/negotiationService.js — CRM 5.0, Fase D1, decisão 0028): a autorização, o serviço do catálogo, a projeção pública, o quadro e os indicadores. Peças REAIS:
// contextos emitidos pelo emissor interno, a ponte real do CRM, o Catalog Service real (repositório em memória), o CRM Service real, o domínio de Negociações e o de Funis.
// Dados fictícios; nenhuma rede, nenhum arquivo de data/.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNegotiationService } = require('../../src/services/negotiationService');
const { createCatalogService } = require('../../src/services/catalogService');
const { createCrmService } = require('../../src/services/crmService');
const { createInMemoryCatalogRepository } = require('../../src/crm/catalogRepository');
const { createInMemoryCrmRepository } = require('../../src/crm/crmRepository');
const { criarArmazenamento, MODO } = require('../helpers/commercialStorage');
const funnelDomain = require('../../src/crm/funnelDomain');
const crmDomain = require('../../src/crm/crmDomain');
const { ROLE, USER_STATUS, defineUser, authorizeCrmOperation, authorizeCatalogOperation } = require('../../src/auth');
const { createAuthorizationContext } = require('../helpers/authFixtures');

const ADMIN_USER = { userId: 'user-admin-neg', authUserId: 'auth-admin-neg', name: 'Admin Negociação', email: 'admin-neg@example.test', role: ROLE.ADMIN };
const CLOSER_USER = { userId: 'user-closer-neg', authUserId: 'auth-closer-neg', name: 'Closer Negociação', email: 'closer-neg@example.test', role: ROLE.COMMERCIAL_CLOSER };
const usuario = (base, overrides = {}) => defineUser({ ...base, status: USER_STATUS.ACTIVE, ...overrides });
const admin = () => createAuthorizationContext(usuario(ADMIN_USER));
const closer = () => createAuthorizationContext(usuario(CLOSER_USER));
const inativo = () => createAuthorizationContext(usuario(CLOSER_USER, { status: USER_STATUS.INACTIVE }));

async function erroDe(fn) {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  return null;
}

// O MESMO conjunto roda nos dois modos (Fase D1.1): negotiationService.test.js (memória) e negotiationService.supabase.test.js (adapters do Supabase sobre o PostgREST falso).
async function montar() {
  const armazenamento = criarArmazenamento();
  const funnelRepository = armazenamento.funnelRepository;
  const crmRepository = createInMemoryCrmRepository();
  const catalogRepository = createInMemoryCatalogRepository();
  const repository = armazenamento.negotiationRepository;
  const crmService = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: crmRepository });
  const catalogService = createCatalogService({ authorizeOperation: authorizeCatalogOperation, repository: catalogRepository, countUsage: async () => 0 });
  const service = createNegotiationService({ authorizeCrmOperation, repository, funnelRepository, crmRepository, crmService, catalogService });
  const funil = await funnelDomain.createFunnel(funnelRepository, { nome: 'Vendas' });
  const etapas = [];
  for (const nome of ['Contato', 'Proposta', 'Fechamento']) etapas.push(await funnelDomain.createStage(funnelRepository, funil.id, { nome }));
  const cliente = (await crmDomain.createRecord(crmRepository, { empresa: 'Clínica Teste' })).record;
  const ambos = await catalogService.create(admin(), 'servicos', { nome: 'Gestão de redes', precoReferencia: 1500, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] });
  const soUnico = await catalogService.create(admin(), 'servicos', { nome: 'Site', precoReferencia: 4800, permitePagamentoUnico: true });
  return { service, catalogService, funnelRepository, crmRepository, repository, funil, etapas, cliente, ambos, soUnico };
}
const corpo = (m, extras = {}) => ({ crmRecordId: m.cliente.id, funnelId: m.funil.id, serviceId: m.ambos.id, prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, ...extras });

test('[NEG-SVC-1] o Service expõe exatamente as 10 operações, congelado — nenhuma de exclusão', async () => {
  const m = await montar();
  assert.deepEqual(Object.keys(m.service).sort(), ['board', 'create', 'get', 'list', 'lose', 'move', 'reopen', 'summary', 'update', 'win']);
  assert.equal(Object.isFrozen(m.service), true);
  assert.equal(Object.keys(m.service).some((nome) => /delete|remove|destroy|archive/i.test(nome)), false);
});

test('[NEG-SVC-2] dependências obrigatórias: sem autorizador, repositórios, CRM, catálogo ou domínio completo o Service NÃO existe', async () => {
  const m = await montar();
  const base = { authorizeCrmOperation, repository: m.repository, funnelRepository: m.funnelRepository, crmRepository: m.crmRepository, crmService: { getRecord() {} }, catalogService: m.catalogService };
  assert.ok(createNegotiationService(base));
  assert.throws(() => createNegotiationService(undefined), /exige \{ authorizeCrmOperation \}/);
  assert.throws(() => createNegotiationService({ ...base, authorizeCrmOperation: 'função' }), /exige \{ authorizeCrmOperation \}/);
  assert.throws(() => createNegotiationService({ ...base, repository: undefined }), /exige \{ repository \}/);
  assert.throws(() => createNegotiationService({ ...base, repository: { list() {} } }), /repositório inválido/);
  assert.throws(() => createNegotiationService({ ...base, funnelRepository: undefined }), /exige \{ funnelRepository \}/);
  assert.throws(() => createNegotiationService({ ...base, funnelRepository: {} }), /repositório inválido/);
  assert.throws(() => createNegotiationService({ ...base, crmRepository: {} }), /exige \{ crmRepository \}/);
  assert.throws(() => createNegotiationService({ ...base, crmService: {} }), /exige \{ crmService \}/);
  assert.throws(() => createNegotiationService({ ...base, catalogService: {} }), /exige \{ catalogService \}/);
  assert.throws(() => createNegotiationService({ ...base, negotiation: null }), /dependência negotiation/);
  assert.throws(() => createNegotiationService({ ...base, negotiation: {} }), /não tem a função/);
});

test('[NEG-SVC-3] PERMISSÕES: ler = READ:CRM; criar, editar, mover, ganhar e perder = PROPOSE:CRM (ADMIN e COMMERCIAL_CLOSER); REABRIR = WRITE:CRM (só ADMIN); usuário inativo e contexto falso recusados em tudo', async () => {
  const m = await montar();
  const n = await m.service.create(closer(), corpo(m));
  // o closer faz o trabalho comercial
  assert.equal((await m.service.get(closer(), n.id)).id, n.id);
  assert.equal((await m.service.list(closer())).length, 1);
  assert.equal((await m.service.update(closer(), n.id, { valorNegociado: 1600 })).valorNegociado, 1600);
  assert.equal((await m.service.move(closer(), n.id, { stageId: m.etapas[1].id })).stageNome, 'Proposta');
  assert.equal((await m.service.board(closer())).funnelId, m.funil.id);
  assert.equal((await m.service.summary(closer())).total, 1);
  const perdida = await m.service.lose(closer(), n.id, { motivo: 'Sem orçamento' });
  assert.equal(perdida.situacao, 'PERDIDA');
  // reabrir: só o ADMIN
  const recusa = await erroDe(() => m.service.reopen(closer(), n.id));
  assert.ok(recusa && /WRITE:CRM/.test(recusa.message), 'o closer não reabre');
  assert.equal((await m.service.get(admin(), n.id)).situacao, 'PERDIDA', 'a recusa não mudou nada');
  assert.equal((await m.service.reopen(admin(), n.id)).situacao, 'ABERTA');
  assert.equal((await m.service.win(admin(), n.id)).situacao, 'GANHA');
  // inativo e contexto que não foi emitido: recusados em TODA operação
  const operacoes = [
    (c) => m.service.list(c), (c) => m.service.get(c, n.id), (c) => m.service.create(c, corpo(m)), (c) => m.service.update(c, n.id, { valorNegociado: 1 }),
    (c) => m.service.move(c, n.id, { stageId: m.etapas[0].id }), (c) => m.service.win(c, n.id), (c) => m.service.lose(c, n.id, { motivo: 'x' }), (c) => m.service.reopen(c, n.id), (c) => m.service.summary(c), (c) => m.service.board(c),
  ];
  for (const contexto of [inativo(), { userId: 'x', permissions: ['READ:CRM', 'PROPOSE:CRM', 'WRITE:CRM'] }, null, undefined]) {
    for (const operacao of operacoes) assert.ok(await erroDe(() => operacao(contexto)), 'recusado');
  }
  assert.equal((await m.service.list(admin())).length, 1, 'nenhuma recusa criou ou mudou algo');
});

test('[NEG-SVC-4] CRIAR: o responsável e quem alterou vêm do CONTEXTO (o corpo nunca os define), o serviço vem do catálogo, a projeção pública tem os campos escolhidos e o cliente aparece pelo NOME', async () => {
  const m = await montar();
  const n = await m.service.create(closer(), corpo(m));
  assert.deepEqual([n.responsavelUserId, n.responsavelNome, n.criadoPorNome, n.atualizadoPorNome], ['user-closer-neg', 'Closer Negociação', 'Closer Negociação', 'Closer Negociação']);
  assert.deepEqual([n.servicoNome, n.cliente], ['Gestão de redes', { empresa: 'Clínica Teste' }]);
  assert.deepEqual(Object.keys(n).sort(), ['atualizadoEm', 'atualizadoPorNome', 'cardId', 'cliente', 'criadoEm', 'criadoPorNome', 'crmRecordId', 'eventos', 'fechadoEm', 'financeiro', 'formaPagamento', 'funnelId', 'funnelNome', 'id', 'motivoPerda', 'periodicidade', 'prazoMeses', 'previsaoFechamento', 'responsavelNome', 'responsavelUserId', 'serviceId', 'servicoNome', 'situacao', 'stageId', 'stageNome', 'valorNegociado']);
  assert.deepEqual(n.financeiro, { tcv: 18000, mrr: 1500, equivalenteMensal: 1500, cronograma: { cobrancas: 12, valorPorCobranca: 1500, mesesEntreCobrancas: 1 } });
  assert.equal(JSON.stringify(n).includes('Centavos'), false, 'nada de campo interno em centavos');
  // identidade no corpo é recusada (nunca definida pelo cliente): responsável, quem alterou, situação, id
  for (const campo of ['responsavelUserId', 'responsavelNome', 'atualizadoPorUserId', 'situacao', 'id', 'cardId']) {
    const erro = await erroDe(() => m.service.create(admin(), corpo(m, { [campo]: 'forjado' })));
    assert.equal(erro.code, 'NEGOTIATION_INVALID_INPUT');
    assert.equal(erro.details.errors.some((e) => e.path === campo), true, campo);
  }
  assert.equal((await m.service.list(admin())).length, 1);
});

test('[NEG-SVC-5] O SERVIÇO VEM DO CATÁLOGO, SÓ PARA LEITURA: inexistente, inativo e legado sem forma de pagamento são recusados com o código certo; o catálogo (preço e modalidades) nunca muda', async () => {
  const m = await montar();
  // só o que a negociação poderia (indevidamente) mexer: preço de referência, modalidades, nome e situação (a auditoria muda quando o ADMIN desativa/ativa neste teste)
  const essencial = async () => JSON.stringify((await m.catalogService.list(admin(), 'servicos', { incluirInativos: true })).map((i) => [i.id, i.nome, i.precoReferencia, i.permitePagamentoUnico, i.permitePagamentoRecorrente, i.periodicidades, i.tipoCobranca, i.recorrencia, i.ativo]));
  const antes = await essencial();
  let erro = await erroDe(() => m.service.create(admin(), corpo(m, { serviceId: 'service:00000000-0000-4000-8000-0000000000ff' })));
  assert.deepEqual(erro.details.errors, [{ path: 'serviceId', code: 'SERVICO_NAO_ENCONTRADO' }]);
  erro = await erroDe(() => m.service.create(admin(), corpo(m, { serviceId: 'texto-qualquer' })));
  assert.deepEqual(erro.details.errors, [{ path: 'serviceId', code: 'SERVICO_NAO_ENCONTRADO' }]);
  erro = await erroDe(() => m.service.create(admin(), corpo(m, { serviceId: m.soUnico.id })));
  assert.deepEqual(erro.details.errors, [{ path: 'formaPagamento', code: 'FORMA_NAO_PERMITIDA_PELO_SERVICO' }], 'a escolha respeita o que o serviço permite');
  await m.catalogService.deactivate(admin(), 'servicos', m.ambos.id);
  erro = await erroDe(() => m.service.create(admin(), corpo(m)));
  assert.deepEqual(erro.details.errors, [{ path: 'serviceId', code: 'SERVICO_INATIVO' }]);
  await m.catalogService.activate(admin(), 'servicos', m.ambos.id);
  const legado = { id: 'service:00000000-0000-4000-8000-0000000000aa', nome: 'Antigo', nomeNormalizado: 'antigo', descricao: null, ativo: true, ordem: 9, categoria: null, precoReferencia: 100, tipoCobranca: 'UNICA', recorrencia: null, criadoEm: '2026-01-01T00:00:00.000Z', atualizadoEm: '2026-01-01T00:00:00.000Z', criadoPorUserId: null, criadoPorNome: null, atualizadoPorUserId: null, atualizadoPorNome: null };
  const catalogRepositoryComLegado = createInMemoryCatalogRepository();
  await catalogRepositoryComLegado.insert('servicos', legado);
  const comLegado = createNegotiationService({ authorizeCrmOperation, repository: m.repository, funnelRepository: m.funnelRepository, crmRepository: m.crmRepository, crmService: createCrmService({ authorizeOperation: authorizeCrmOperation, repository: m.crmRepository }), catalogService: createCatalogService({ authorizeOperation: authorizeCatalogOperation, repository: catalogRepositoryComLegado, countUsage: async () => 0 }) });
  erro = await erroDe(() => comLegado.create(admin(), corpo(m, { serviceId: legado.id })));
  assert.deepEqual(erro.details.errors, [{ path: 'serviceId', code: 'SERVICO_SEM_MODALIDADE' }], 'um serviço antigo sem forma de pagamento não se negocia até o ADMIN completar — nada é presumido do tipo antigo');
  // criar e editar negociações nunca grava o catálogo
  const n = await m.service.create(admin(), corpo(m));
  await m.service.update(admin(), n.id, { valorNegociado: 99 });
  assert.equal(await essencial(), antes, 'o catálogo ficou idêntico (preço de referência e modalidades)');
});

test('[NEG-SVC-6] EDITAR resolve o serviço do estado RESULTANTE: sem serviceId no pedido vale o atual; com serviceId, o novo — e o prazo/valor editados não relêem o catálogo à toa', async () => {
  const m = await montar();
  const n = await m.service.create(admin(), corpo(m));
  const editado = await m.service.update(admin(), n.id, { periodicidade: 'TRIMESTRAL', prazoMeses: 12, valorNegociado: 3000 });
  assert.deepEqual([editado.periodicidade, editado.financeiro.tcv, editado.financeiro.mrr, editado.financeiro.equivalenteMensal], ['TRIMESTRAL', 12000, null, 1000]);
  const erro = await erroDe(() => m.service.update(admin(), n.id, { periodicidade: 'ANUAL', prazoMeses: 12 }));
  assert.deepEqual(erro.details.errors, [{ path: 'periodicidade', code: 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO' }], 'o serviço só permite mensal e trimestral');
  const trocado = await m.service.update(admin(), n.id, { serviceId: m.soUnico.id, formaPagamento: 'UNICO', valorNegociado: 5000 });
  assert.deepEqual([trocado.servicoNome, trocado.formaPagamento, trocado.periodicidade, trocado.financeiro.tcv], ['Site', 'UNICO', null, 5000]);
  assert.equal((await erroDe(() => m.service.update(admin(), 'negotiation:nao-existe', { valorNegociado: 1 }))).code, 'NEGOTIATION_NOT_FOUND');
  assert.ok(await erroDe(() => m.service.update(admin(), n.id, 'texto')));
});

test('[NEG-SVC-7] ENTRADAS DE APLICAÇÃO: chaves desconhecidas em filtros, mudança de etapa e perda são recusadas (nunca role/permissions/userId no corpo); mover exige stageId', async () => {
  const m = await montar();
  const n = await m.service.create(admin(), corpo(m));
  assert.ok(await erroDe(() => m.service.list(admin(), { funnelId: m.funil.id, role: 'ADMIN' })));
  assert.ok(await erroDe(() => m.service.list(admin(), 'texto')));
  assert.ok(await erroDe(() => m.service.move(admin(), n.id, { stageId: m.etapas[1].id, userId: 'forjado' })));
  assert.match((await erroDe(() => m.service.move(admin(), n.id, {}))).message, /exige "stageId"/);
  assert.ok(await erroDe(() => m.service.lose(admin(), n.id, { motivo: 'x', permissions: ['*'] })));
  assert.equal((await m.service.get(admin(), n.id)).stageNome, 'Contato', 'nada se moveu');
  const filtrada = await m.service.list(admin(), { situacao: 'ABERTA', funnelId: m.funil.id, crmRecordId: m.cliente.id });
  assert.equal(filtrada.length, 1);
  assert.deepEqual(await m.service.list(admin(), { situacao: 'GANHA' }), []);
  assert.equal(await m.service.get(admin(), 'negotiation:nao-existe'), null);
});

test('[NEG-SVC-8] O QUADRO: funis (só id/nome/situação), as etapas do funil escolhido, os cards (de negociação com a projeção da negociação; avulsos com a do cliente) e os totais por etapa — só as ABERTAS entram no valor em jogo', async () => {
  const m = await montar();
  const outroCliente = (await crmDomain.createRecord(m.crmRepository, { empresa: 'Outra Clínica' })).record;
  const a = await m.service.create(admin(), corpo(m, { valorNegociado: 1500 }));
  const b = await m.service.create(admin(), corpo(m, { formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 7000 }));
  const c = await m.service.create(admin(), corpo(m, { crmRecordId: outroCliente.id, valorNegociado: 100 }));
  await m.service.move(admin(), b.id, { stageId: m.etapas[1].id });
  await m.service.win(admin(), c.id);
  await funnelDomain.createCard(m.funnelRepository, m.crmRepository, { funnelId: m.funil.id, crmRecordId: outroCliente.id }, { reviewedBy: { userId: 'user-admin-neg', name: 'Admin Negociação', role: 'ADMIN' } }); // um card AVULSO, de antes
  const quadro = await m.service.board(closer());
  assert.deepEqual(quadro.funnels, [{ id: m.funil.id, nome: 'Vendas', ativo: true, ordem: 0 }]);
  assert.equal(quadro.funnelId, m.funil.id);
  assert.deepEqual(quadro.stages.map((e) => e.nome), ['Contato', 'Proposta', 'Fechamento']);
  assert.equal(quadro.cards.length, 4);
  const doA = quadro.cards.find((card) => card.negotiationId === a.id);
  assert.deepEqual([doA.negociacao.valorNegociado, doA.negociacao.cliente, doA.crm.empresa], [1500, { empresa: 'Clínica Teste' }, 'Clínica Teste']);
  const avulso = quadro.cards.find((card) => card.negotiationId === null);
  assert.deepEqual([avulso.negociacao, avulso.crm.empresa], [null, 'Outra Clínica']);
  const totais = Object.fromEntries(quadro.totais.map((t) => [t.stageId, t]));
  assert.deepEqual(totais[m.etapas[0].id], { stageId: m.etapas[0].id, cards: 3, negociacoesAbertas: 1, tcvEmJogo: 18000 }, 'Contato: a, o ganho de c e o avulso; só a é aberta (TCV 12 × 1500)');
  assert.deepEqual(totais[m.etapas[1].id], { stageId: m.etapas[1].id, cards: 1, negociacoesAbertas: 1, tcvEmJogo: 7000 });
  assert.deepEqual(totais[m.etapas[2].id], { stageId: m.etapas[2].id, cards: 0, negociacoesAbertas: 0, tcvEmJogo: 0 });
  // funil escolhido por id; id desconhecido = nenhum funil (nunca outro); sem nenhum funil = quadro vazio, sem inventar
  assert.equal((await m.service.board(admin(), m.funil.id)).cards.length, 4);
  assert.deepEqual(await m.service.board(admin(), 'funnel:nao-existe'), { funnels: quadro.funnels, funnelId: null, stages: [], cards: [], totais: [] });
  const vazio = await montar();
  await funnelDomain.deleteFunnel(vazio.funnelRepository, vazio.funil.id); // sem cards: o funil e as suas etapas saem
  assert.deepEqual(await vazio.service.board(admin()), { funnels: [], funnelId: null, stages: [], cards: [], totais: [] });
});

test('[NEG-SVC-9] O QUADRO escolhe, sem funil pedido, o primeiro funil ATIVO; cartões de um cliente apagado do CRM aparecem sem nome (nunca inventado) e não derrubam o quadro', async () => {
  const m = await montar();
  await funnelDomain.updateFunnel(m.funnelRepository, m.funil.id, { ativo: false });
  const segundo = await funnelDomain.createFunnel(m.funnelRepository, { nome: 'Renovação' });
  await funnelDomain.createStage(m.funnelRepository, segundo.id, { nome: 'Aviso' });
  assert.equal((await m.service.board(admin())).funnelId, segundo.id, 'o primeiro ATIVO');
  assert.equal((await m.service.board(admin(), m.funil.id)).funnelId, m.funil.id, 'o inativo ainda pode ser pedido por id (leitura)');
  await funnelDomain.updateFunnel(m.funnelRepository, m.funil.id, { ativo: true });
  const n = await m.service.create(admin(), corpo(m));
  await m.crmRepository.delete(m.cliente.id); // o registro some do CRM depois (a decisão 0025 permite excluir)
  const noOriginal = await m.service.board(admin());
  assert.equal(noOriginal.funnelId, m.funil.id, 'reativado, é de novo o primeiro ativo');
  const item = noOriginal.cards.find((x) => x.negotiationId === n.id);
  assert.deepEqual([item.crm, item.negociacao.cliente], [null, null]);
  assert.equal((await m.service.get(admin(), n.id)).cliente, null);
});

test('[NEG-SVC-10] INDICADORES: calculados no servidor sobre o que está gravado; o Service não os guarda nem os inventa — vazio é tudo zero e taxa nula', async () => {
  const m = await montar();
  assert.deepEqual((await m.service.summary(admin())).conversao, { fechadas: 0, ganhas: 0, perdidas: 0, taxa: null });
  const a = await m.service.create(admin(), corpo(m));
  const b = await m.service.create(admin(), corpo(m, { valorNegociado: 2000 }));
  await m.service.win(admin(), a.id);
  const resumo = await m.service.summary(closer());
  assert.deepEqual([resumo.total, resumo.ganhas.quantidade, resumo.ganhas.tcv, resumo.ganhas.mrr, resumo.abertas.quantidade, resumo.abertas.tcv], [2, 1, 18000, 1500, 1, 24000]);
  assert.deepEqual(resumo.conversao, { fechadas: 1, ganhas: 1, perdidas: 0, taxa: 1 });
  void b;
});

test('[NEG-SVC-11] FALHAS: uma falha do catálogo (armazenamento) sobe com o código do catálogo; uma falha do armazenamento de negociações vira erro de persistência de mensagem fixa; nada fica gravado', async () => {
  const m = await montar();
  const catalogoQuebrado = { get: async () => { throw Object.assign(new Error('segredo-do-catalogo'), { code: 'CRM_CATALOG_PERSISTENCE' }); } };
  const comCatalogoQuebrado = createNegotiationService({ authorizeCrmOperation, repository: m.repository, funnelRepository: m.funnelRepository, crmRepository: m.crmRepository, crmService: createCrmService({ authorizeOperation: authorizeCrmOperation, repository: m.crmRepository }), catalogService: catalogoQuebrado });
  assert.equal((await erroDe(() => comCatalogoQuebrado.create(admin(), corpo(m)))).code, 'CRM_CATALOG_PERSISTENCE');
  const repoQuebrado = { list: () => { throw new Error('segredo-da-leitura'); }, getById: () => { throw new Error('segredo-da-leitura'); }, save: () => { throw new Error('segredo-da-escrita'); }, ...(MODO === 'supabase' ? { commit: () => { throw new Error('segredo-da-escrita'); } } : {}) };
  const comRepoQuebrado = createNegotiationService({ authorizeCrmOperation, repository: repoQuebrado, funnelRepository: m.funnelRepository, crmRepository: m.crmRepository, crmService: createCrmService({ authorizeOperation: authorizeCrmOperation, repository: m.crmRepository }), catalogService: m.catalogService });
  for (const tarefa of [() => comRepoQuebrado.list(admin()), () => comRepoQuebrado.get(admin(), 'negotiation:x'), () => comRepoQuebrado.create(admin(), corpo(m)), () => comRepoQuebrado.summary(admin())]) {
    const erro = await erroDe(tarefa);
    assert.equal(erro.code, 'NEGOTIATION_PERSISTENCE');
    assert.doesNotMatch(erro.message, /segredo/);
  }
  assert.equal((await m.funnelRepository.listCardsByFunnel(m.funil.id)).length, 0, 'o card da tentativa que falhou foi arquivado');
});

test('[NEG-SVC-12] A PERMISSÃO EXATA de cada operação: ler pede READ:CRM; criar, editar, mover, ganhar e perder pedem PROPOSE:CRM; reabrir pede WRITE:CRM — o Service nunca pede menos (um perfil futuro só de leitura não escreve)', async () => {
  const m = await montar();
  const pedidos = [];
  const registrador = (contexto, permissao) => {
    pedidos.push(permissao);
    return authorizeCrmOperation(contexto, permissao);
  };
  const crmService = createCrmService({ authorizeOperation: authorizeCrmOperation, repository: m.crmRepository });
  const service = createNegotiationService({ authorizeCrmOperation: registrador, repository: m.repository, funnelRepository: m.funnelRepository, crmRepository: m.crmRepository, crmService, catalogService: m.catalogService });
  const pedida = async (operacao) => {
    pedidos.length = 0;
    await operacao();
    return [...new Set(pedidos)];
  };
  let n;
  assert.deepEqual(await pedida(async () => { n = await service.create(admin(), corpo(m)); }), ['PROPOSE:CRM']);
  assert.deepEqual(await pedida(() => service.update(admin(), n.id, { valorNegociado: 1700 })), ['PROPOSE:CRM']);
  assert.deepEqual(await pedida(() => service.move(admin(), n.id, { stageId: m.etapas[1].id })), ['PROPOSE:CRM']);
  assert.deepEqual(await pedida(() => service.lose(admin(), n.id, { motivo: 'Sem orçamento' })), ['PROPOSE:CRM']);
  assert.deepEqual(await pedida(() => service.reopen(admin(), n.id)), ['WRITE:CRM']);
  assert.deepEqual(await pedida(() => service.win(admin(), n.id)), ['PROPOSE:CRM']);
  for (const [nome, operacao] of [['list', () => service.list(admin())], ['get', () => service.get(admin(), n.id)], ['board', () => service.board(admin())], ['summary', () => service.summary(admin())]]) {
    assert.deepEqual(await pedida(operacao), ['READ:CRM'], nome);
  }
});
