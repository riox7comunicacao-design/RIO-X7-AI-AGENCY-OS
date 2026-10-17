// Negotiation Service — a fronteira de APLICAÇÃO das NEGOCIAÇÕES (CRM 5.0, Fase D1, decisão 0028). Mesmo desenho de funnelService.js e catalogService.js: o domínio
// (src/crm/negotiationDomain.js) continua dono das regras; o Service SÓ autoriza, confere a forma da entrada, busca o SERVIÇO do catálogo e projeta a saída.
//
// AUTORIZAÇÃO — uma só ponte, a do CRM (`authorizeCrmOperation`), com as permissões que já existem (nenhuma nova):
//   READ:CRM     ler negociações, o quadro e os indicadores (ADMIN e COMMERCIAL_CLOSER);
//   PROPOSE:CRM  criar, editar, mudar de etapa, ganhar e perder (ADMIN e COMMERCIAL_CLOSER — a mesma ação comercial de mexer num card);
//   WRITE:CRM    REABRIR uma negociação fechada (só ADMIN): desfazer um fechamento é uma decisão mais séria que o fechamento.
// A interface só MOSTRA ou esconde controles: quem decide é este Service, em toda chamada.
//
// O QUE ESTE SERVICE NUNCA FAZ: gravar o serviço do catálogo (só o LÊ, com o MESMO contexto de quem chamou, para saber o que ele permite), ler ou gravar os campos legados do CRM, calcular
// valor recebido, ou confiar num campo de identidade vindo do cliente (o responsável e quem alterou vêm SEMPRE do contexto autenticado; o corpo nunca os define).
//
// PROJEÇÃO PÚBLICA: campos escolhidos um a um (nada de "devolver o objeto inteiro"), enriquecidos só com o NOME do cliente (via CRM Service, que já autoriza e sanitiza).

const negotiationDomainDefault = require('../crm/negotiationDomain');
const { assertValidNegotiationRepository } = require('../crm/negotiationRepositoryPort');
const { assertValidFunnelRepository } = require('../crm/funnelRepositoryPort');
const funnelDomain = require('../crm/funnelDomain');
const { PERMISSION } = require('../auth');

const READ_CRM = PERMISSION.READ_CRM;
const PROPOSE_CRM = PERMISSION.PROPOSE_CRM;
const WRITE_CRM = PERMISSION.WRITE_CRM;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const DOMAIN_FUNCTIONS = Object.freeze(['getNegotiation', 'listNegotiations', 'createNegotiation', 'updateNegotiation', 'moveNegotiation', 'winNegotiation', 'loseNegotiation', 'reopenNegotiation', 'summarizeNegotiations']);
const LIST_FILTERS = Object.freeze(['funnelId', 'situacao', 'crmRecordId']);
const MOVE_KEYS = Object.freeze(['stageId', 'reason']);
const LOSE_KEYS = Object.freeze(['motivo']);
const CARD_CRM_FIELDS = Object.freeze(['empresa', 'contato', 'status', 'responsavel', 'ultimaInteracao', 'proximaAcao']);

function onlyKnown(input, allowed, label) {
  if (!isPlainObject(input)) throw new Error(`Negociação: ${label} deve ser um objeto simples`);
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Negociação: ${label} tem campos desconhecidos: ${unknown.join(', ')}`);
  return input;
}

// O que o domínio precisa saber do SERVIÇO: só o que decide a negociação (nunca o preço de referência).
function serviceFacts(item) {
  if (!item || typeof item !== 'object') return null;
  return { id: item.id, nome: item.nome, ativo: item.ativo === true, permitePagamentoUnico: item.permitePagamentoUnico === true, permitePagamentoRecorrente: item.permitePagamentoRecorrente === true, periodicidades: Array.isArray(item.periodicidades) ? [...item.periodicidades] : [] };
}

// A projeção PÚBLICA de uma negociação (campos escolhidos um a um).
function toPublicNegotiation(view, cliente) {
  return {
    id: view.id,
    crmRecordId: view.crmRecordId,
    cliente: cliente ? { empresa: cliente.empresa ?? null } : null,
    funnelId: view.funnelId,
    funnelNome: view.funnelNome ?? null,
    cardId: view.cardId,
    stageId: view.stageId ?? null,
    stageNome: view.stageNome ?? null,
    serviceId: view.serviceId,
    servicoNome: view.servicoNome ?? null,
    responsavelUserId: view.responsavelUserId,
    responsavelNome: view.responsavelNome,
    prazoMeses: view.prazoMeses,
    formaPagamento: view.formaPagamento,
    periodicidade: view.periodicidade ?? null,
    valorNegociado: view.valorNegociado,
    previsaoFechamento: view.previsaoFechamento ?? null,
    situacao: view.situacao,
    motivoPerda: view.motivoPerda ?? null,
    fechadoEm: view.fechadoEm ?? null,
    criadoEm: view.criadoEm,
    atualizadoEm: view.atualizadoEm,
    criadoPorNome: view.criadoPorNome ?? null,
    atualizadoPorNome: view.atualizadoPorNome ?? null,
    financeiro: view.financeiro ? { tcv: view.financeiro.tcv, mrr: view.financeiro.mrr, equivalenteMensal: view.financeiro.equivalenteMensal, cronograma: { ...view.financeiro.cronograma } } : null,
    eventos: Array.isArray(view.eventos) ? view.eventos.map((item) => structuredClone(item)) : [],
  };
}

function createNegotiationService(dependencies) {
  const { negotiation = negotiationDomainDefault, authorizeCrmOperation, repository, funnelRepository, crmRepository, crmService, catalogService } = dependencies || {};
  if (typeof authorizeCrmOperation !== 'function') throw new Error('createNegotiationService exige { authorizeCrmOperation } (função): sem autorizador injetado o Service não existe');
  if (repository === undefined || repository === null) throw new Error('createNegotiationService exige { repository } (a porta de persistência de negociações)');
  assertValidNegotiationRepository(repository);
  if (funnelRepository === undefined || funnelRepository === null) throw new Error('createNegotiationService exige { funnelRepository } (a porta de funis: o card vive nela)');
  assertValidFunnelRepository(funnelRepository);
  if (!crmRepository || typeof crmRepository.getById !== 'function') throw new Error('createNegotiationService exige { crmRepository } (com getById): uma negociação tem de ter um cliente real');
  if (!crmService || typeof crmService.getRecord !== 'function') throw new Error('createNegotiationService exige { crmService } (com getRecord): o nome do cliente vem do CRM');
  if (!catalogService || typeof catalogService.get !== 'function') throw new Error('createNegotiationService exige { catalogService } (com get): o serviço negociado vem do catálogo');
  if (typeof negotiation !== 'object' || negotiation === null) throw new Error('createNegotiationService: a dependência negotiation deve ser o domínio de Negociações');
  for (const name of DOMAIN_FUNCTIONS) if (typeof negotiation[name] !== 'function') throw new Error(`createNegotiationService: a dependência negotiation não tem a função ${name}()`);

  const deps = Object.freeze({ repository, funnelRepository, crmRepository });
  const authorize = (context, permission) => authorizeCrmOperation(context, permission);

  // o NOME do cliente, lido pelo MESMO contexto (se não pudesse ler o CRM, já teria sido recusado antes)
  async function clientsOf(context, items) {
    const wanted = [...new Set(items.map((item) => item.crmRecordId))];
    const found = new Map();
    await Promise.all(wanted.map(async (id) => found.set(id, await crmService.getRecord(context, id).catch(() => null))));
    return found;
  }
  async function publicList(context, views) {
    const clients = await clientsOf(context, views);
    return views.map((view) => toPublicNegotiation(view, clients.get(view.crmRecordId)));
  }

  // O serviço do catálogo (só leitura). Item inexistente -> null (o domínio explica); qualquer outra falha do catálogo sobe como está (a API a traduz).
  async function lookupService(context, serviceId) {
    if (typeof serviceId !== 'string' || serviceId.trim() === '') return null;
    try {
      const item = await catalogService.get(context, 'servicos', serviceId);
      return serviceFacts(item);
    } catch (error) {
      if (error && error.code === 'CRM_CATALOG_NOT_FOUND') return null;
      throw error;
    }
  }

  async function list(context, filters = {}) {
    authorize(context, READ_CRM);
    const picked = {};
    for (const key of Object.keys(onlyKnown(filters, LIST_FILTERS, 'os filtros'))) picked[key] = filters[key];
    return publicList(context, await negotiation.listNegotiations(deps, picked));
  }

  async function get(context, id) {
    authorize(context, READ_CRM);
    const view = await negotiation.getNegotiation(deps, id);
    return view === null ? null : (await publicList(context, [view]))[0];
  }

  async function create(context, input) {
    const operator = authorize(context, PROPOSE_CRM);
    const serviceId = isPlainObject(input) ? input.serviceId : undefined;
    const view = await negotiation.createNegotiation(deps, input, await lookupService(context, serviceId), operator);
    return (await publicList(context, [view]))[0];
  }

  async function update(context, id, patch) {
    const operator = authorize(context, PROPOSE_CRM);
    if (!isPlainObject(patch)) throw new Error('Negociação: o corpo da edição deve ser um objeto simples');
    // o serviço do estado RESULTANTE: o novo (se o pedido o troca) ou o atual
    const current = hasOwn(patch, 'serviceId') ? null : await negotiation.getNegotiation(deps, id);
    const serviceId = hasOwn(patch, 'serviceId') ? patch.serviceId : current ? current.serviceId : undefined;
    const view = await negotiation.updateNegotiation(deps, id, patch, await lookupService(context, serviceId), operator);
    return (await publicList(context, [view]))[0];
  }

  async function move(context, id, options) {
    const operator = authorize(context, PROPOSE_CRM);
    const picked = onlyKnown(options, MOVE_KEYS, 'o pedido de mudança de etapa');
    if (!hasOwn(picked, 'stageId')) throw new Error('Negociação: mudar de etapa exige "stageId"');
    const view = await negotiation.moveNegotiation(deps, id, picked.stageId, operator, { motivo: hasOwn(picked, 'reason') ? picked.reason : undefined });
    return (await publicList(context, [view]))[0];
  }

  async function win(context, id) {
    const operator = authorize(context, PROPOSE_CRM);
    return (await publicList(context, [await negotiation.winNegotiation(deps, id, operator)]))[0];
  }

  async function lose(context, id, options) {
    const operator = authorize(context, PROPOSE_CRM);
    const picked = onlyKnown(options, LOSE_KEYS, 'o pedido de perda');
    return (await publicList(context, [await negotiation.loseNegotiation(deps, id, picked.motivo, operator)]))[0];
  }

  async function reopen(context, id) {
    const operator = authorize(context, WRITE_CRM);
    return (await publicList(context, [await negotiation.reopenNegotiation(deps, id, operator)]))[0];
  }

  // Os INDICADORES: sempre calculados AQUI, no servidor, sobre o que está gravado (a tela só mostra; nenhum número é fictício nem calculado no navegador).
  async function summary(context) {
    authorize(context, READ_CRM);
    return negotiation.summarizeNegotiations(await negotiation.listNegotiations(deps));
  }

  // O QUADRO (Kanban): os funis (só id/nome/situação), as etapas do funil escolhido e os cards ATIVOS dele — os de NEGOCIAÇÃO com a projeção da negociação, os avulsos (de antes)
  // com a projeção do cliente — e os TOTAIS por etapa (só negociações ABERTAS entram em quantidade e valor em jogo). Leitura com READ:CRM: o time inteiro vê o quadro; ADMINISTRAR a
  // estrutura (criar funil e etapa) continua sendo MANAGE:FUNNELS.
  async function board(context, funnelId) {
    authorize(context, READ_CRM);
    const funnels = (await funnelDomain.listFunnels(funnelRepository)).map((funnel) => ({ id: funnel.id, nome: funnel.nome, ativo: funnel.ativo !== false, ordem: funnel.ordem ?? 0 }));
    const chosen = funnelId !== undefined && funnelId !== null && funnelId !== '' ? funnels.find((funnel) => funnel.id === funnelId) : funnels.find((funnel) => funnel.ativo) || funnels[0];
    if (!chosen) return { funnels, funnelId: null, stages: [], cards: [], totais: [] };
    const stages = (await funnelDomain.listStages(funnelRepository, chosen.id)).map((stage) => ({ id: stage.id, nome: stage.nome, ordem: stage.ordem ?? 0, ativo: stage.ativo !== false }));
    const cards = await funnelDomain.listCardsByFunnel(funnelRepository, chosen.id);
    const views = new Map((await negotiation.listNegotiations(deps, { funnelId: chosen.id })).map((view) => [view.id, view]));
    const clients = await clientsOf(context, cards);
    const items = cards.map((card) => {
      const record = clients.get(card.crmRecordId);
      const crm = record ? CARD_CRM_FIELDS.reduce((out, field) => ({ ...out, [field]: hasOwn(record, field) ? record[field] : null }), {}) : null;
      const view = card.negotiationId ? views.get(card.negotiationId) : null;
      return {
        id: card.id,
        funnelId: card.funnelId,
        stageId: card.stageId,
        crmRecordId: card.crmRecordId,
        negotiationId: card.negotiationId ?? null,
        criadoEm: card.criadoEm,
        updatedAt: card.updatedAt,
        crm,
        negociacao: view ? toPublicNegotiation(view, record) : null,
      };
    });
    const totais = stages.map((stage) => {
      const inStage = items.filter((item) => item.stageId === stage.id);
      const open = inStage.filter((item) => item.negociacao && item.negociacao.situacao === 'ABERTA');
      const tcv = open.reduce((sum, item) => sum + (item.negociacao.financeiro ? Math.round(item.negociacao.financeiro.tcv * 100) : 0), 0);
      return { stageId: stage.id, cards: inStage.length, negociacoesAbertas: open.length, tcvEmJogo: tcv / 100 };
    });
    return { funnels, funnelId: chosen.id, stages, cards: items, totais };
  }

  return Object.freeze({ list, get, create, update, move, win, lose, reopen, summary, board });
}

module.exports = { createNegotiationService, toPublicNegotiation };
