// Ferramentas dos testes do QUADRO de Negociações e das telas de funis (CRM 5.0, Fase D1): uma API falsa em memória (erros e pausas injetáveis, e o registro de tudo o que foi pedido), a montagem da tela
// sobre o DOM de teste e consultas ao que a pessoa vê. Nenhum navegador, nenhuma rede, nenhum dado real, nenhum arquivo — tudo em memória. A API falsa imita o CONTRATO do servidor (o mesmo formato do quadro
// e da negociação pública); a conta financeira usa o modelo do Dashboard, que tem teste de paridade com o servidor.

const { createBrowser } = require('./fakeDom');

const loadFunnels = () => import('../../dashboard/views/funnels.mjs');
const loadUi = () => import('../../dashboard/ui/index.mjs');
const loadApi = () => import('../../dashboard/api.mjs');
const loadModel = () => import('../../dashboard/negotiation-model.mjs');
const loadAdmin = () => import('../../dashboard/views/funnelAdmin.mjs');
const loadDashboard = () => import('../../dashboard/views/commercialDashboard.mjs');

const ADMIN = Object.freeze({ canReadCrm: true, canProposeCrm: true, canWriteCrm: true, canManageFunnels: true, canManageCrmCatalogs: true });
const CLOSER = Object.freeze({ canReadCrm: true, canProposeCrm: true, canWriteCrm: false, canManageFunnels: false, canManageCrmCatalogs: false });
const LEITOR = Object.freeze({ canReadCrm: true, canProposeCrm: false, canWriteCrm: false, canManageFunnels: false, canManageCrmCatalogs: false });

const clone = (valor) => JSON.parse(JSON.stringify(valor));
const T = '2026-10-18T12:00:00.000Z';

const funil = (n, extras = {}) => ({ id: `funnel:${n}`, nome: `Funil ${n}`, ativo: true, ordem: n - 1, ...extras });
const etapa = (n, funnelId, nome, extras = {}) => ({ id: `stage:${n}`, funnelId, nome, ordem: n - 1, ativo: true, ...extras });
const cliente = (n, empresa, extras = {}) => ({ id: `crm:${n}`, empresa, status: 'PROSPECT', ...extras });
const servico = (n, nome, extras = {}) => ({ id: `service:${n}`, nome, ativo: true, ordem: n - 1, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'], precoReferencia: 1500, ...extras });

// Uma negociação PÚBLICA (o formato que o servidor devolve). O financeiro é calculado como o servidor calcularia.
async function negociacao(n, extras = {}) {
  const { previewFinance } = await loadModel();
  const base = { id: `negotiation:${n}`, crmRecordId: 'crm:1', cliente: { empresa: 'Clínica Alfa' }, funnelId: 'funnel:1', funnelNome: 'Funil 1', cardId: `card:${n}`, stageId: 'stage:1', stageNome: 'Contato', serviceId: 'service:1', servicoNome: 'Gestão de redes', responsavelUserId: 'user-breno', responsavelNome: 'Breno Bento', prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, previsaoFechamento: null, situacao: 'ABERTA', motivoPerda: null, fechadoEm: null, criadoEm: T, atualizadoEm: T, criadoPorNome: 'Breno Bento', atualizadoPorNome: 'Breno Bento', eventos: [{ tipo: 'CRIADA', em: T, porUserId: 'user-breno', porNome: 'Breno Bento', detalhe: { etapaId: 'stage:1' } }] };
  const item = { ...base, ...extras };
  item.duracao = item.duracao ?? 'DEFINIDA';
  item.avisoPrevioDias = item.avisoPrevioDias ?? null;
  const finance = previewFinance({ duracao: item.duracao, formaPagamento: item.formaPagamento, periodicidade: item.periodicidade, prazoMeses: item.prazoMeses ?? null, valorNegociado: item.valorNegociado });
  item.financeiro = finance.ok ? { tcv: finance.tcv, tcvIndeterminado: finance.tcvIndeterminado, mrr: finance.mrr, equivalenteMensal: finance.equivalenteMensal, cronograma: { ...finance.cronograma } } : null;
  return item;
}

async function erroApi(status, code = '', details = []) {
  const { ApiError } = await loadApi();
  return new ApiError(status, code, '', details);
}

// API falsa. `mem.falhas.<operacao>` faz a PRÓXIMA chamada daquela operação falhar (`mem.sempre` falha sempre); `pausar('criar')` segura a operação até `liberar()`.
// Operações: quadro, clientes, servicos, criar, atualizar, mover, ganhar, perder, reabrir, arquivar, historico.
async function apiNegocios({ funnels = [funil(1)], stages = null, clients = [cliente(1, 'Clínica Alfa'), cliente(2, 'Clínica Beta')], services = [servico(1, 'Gestão de redes'), servico(2, 'Site', { permitePagamentoRecorrente: false, periodicidades: [] })], negotiations = [], legacyCards = [] } = {}) {
  const chamadas = [];
  const etapasPadrao = stages || [etapa(1, 'funnel:1', 'Contato'), etapa(2, 'funnel:1', 'Proposta'), etapa(3, 'funnel:1', 'Fechamento')];
  const mem = { funnels: clone(funnels), stages: clone(etapasPadrao), clients: clone(clients), services: clone(services), negotiations: clone(negotiations), legacyCards: clone(legacyCards), falhas: {}, sempre: {}, pausas: {}, proximo: 100 };
  const passar = async (operacao) => {
    const pausa = mem.pausas[operacao];
    if (pausa) await pausa.promessa;
    const falha = mem.sempre[operacao] || mem.falhas[operacao];
    if (falha) {
      if (!mem.sempre[operacao]) delete mem.falhas[operacao];
      throw typeof falha === 'function' ? falha() : falha;
    }
  };
  const achar = (id) => mem.negotiations.find((item) => item.id === id);
  const naoAchou = async () => erroApi(404, 'NEGOTIATION_NOT_FOUND');
  const { previewFinance } = await loadModel();
  const comFinanceiro = (item) => {
    item.duracao = item.duracao ?? 'DEFINIDA';
  item.avisoPrevioDias = item.avisoPrevioDias ?? null;
  const finance = previewFinance({ duracao: item.duracao, formaPagamento: item.formaPagamento, periodicidade: item.periodicidade, prazoMeses: item.prazoMeses ?? null, valorNegociado: item.valorNegociado });
    item.financeiro = finance.ok ? { tcv: finance.tcv, tcvIndeterminado: finance.tcvIndeterminado, mrr: finance.mrr, equivalenteMensal: finance.equivalenteMensal, cronograma: { ...finance.cronograma } } : null;
    return item;
  };
  const stageOf = (id) => mem.stages.find((entry) => entry.id === id);
  const evento = (tipo, detalhe) => ({ tipo, em: '2026-10-18T14:00:00.000Z', porUserId: 'user-breno', porNome: 'Breno Bento', ...(detalhe ? { detalhe } : {}) });

  function quadro(funnelId) {
    const escolhido = funnelId ? mem.funnels.find((f) => f.id === funnelId) : mem.funnels.find((f) => f.ativo) || mem.funnels[0];
    if (!escolhido) return { funnels: clone(mem.funnels), funnelId: null, stages: [], cards: [], totais: [] };
    const etapas = mem.stages.filter((entry) => entry.funnelId === escolhido.id).sort((a, b) => a.ordem - b.ordem);
    const cards = [
      ...mem.negotiations.filter((n) => n.funnelId === escolhido.id).map((n) => ({ id: n.cardId, funnelId: n.funnelId, stageId: n.stageId, crmRecordId: n.crmRecordId, negotiationId: n.id, criadoEm: n.criadoEm, updatedAt: n.atualizadoEm, crm: { empresa: n.cliente ? n.cliente.empresa : null }, negociacao: clone(n) })),
      ...mem.legacyCards.filter((card) => card.funnelId === escolhido.id).map((card) => ({ ...clone(card), negotiationId: null, negociacao: null })),
    ];
    const totais = etapas.map((entry) => {
      const naEtapa = cards.filter((card) => card.stageId === entry.id);
      const abertas = naEtapa.filter((card) => card.negociacao && card.negociacao.situacao === 'ABERTA');
      return { stageId: entry.id, cards: naEtapa.length, negociacoesAbertas: abertas.length, tcvEmJogo: abertas.reduce((soma, card) => soma + (card.negociacao.financeiro && typeof card.negociacao.financeiro.tcv === 'number' ? Math.round(card.negociacao.financeiro.tcv * 100) : 0), 0) / 100, tcvIndeterminadas: abertas.filter((card) => card.negociacao.financeiro && card.negociacao.financeiro.tcvIndeterminado === true).length, mrrEmJogo: abertas.reduce((soma, card) => soma + (card.negociacao.financeiro && typeof card.negociacao.financeiro.mrr === 'number' ? Math.round(card.negociacao.financeiro.mrr * 100) : 0), 0) / 100 };
    });
    return { funnels: clone(mem.funnels), funnelId: escolhido.id, stages: clone(etapas), cards, totais };
  }

  const api = {
    chamadas,
    mem,
    pausar(operacao) {
      let liberar;
      const promessa = new Promise((resolve) => {
        liberar = resolve;
      });
      mem.pausas[operacao] = { promessa };
      return { liberar: () => { delete mem.pausas[operacao]; liberar(); } };
    },
    quantas: (nome) => chamadas.filter(([n]) => n === nome).length,
    escritas: () => chamadas.filter(([n]) => ['criar', 'atualizar', 'mover', 'ganhar', 'perder', 'reabrir', 'arquivar'].includes(n)),
    funnelBoard: async (funnelId) => {
      chamadas.push(['quadro', funnelId ?? null]);
      await passar('quadro');
      return { quadro: quadro(funnelId) };
    },
    listCrm: async () => {
      chamadas.push(['clientes']);
      await passar('clientes');
      return { items: clone(mem.clients) };
    },
    listCatalog: async (catalogo) => {
      chamadas.push(['servicos', catalogo]);
      await passar('servicos');
      return { items: clone(mem.services) };
    },
    createNegotiation: async (corpo) => {
      chamadas.push(['criar', clone(corpo)]);
      await passar('criar');
      const cli = mem.clients.find((c) => c.id === corpo.crmRecordId);
      const srv = mem.services.find((s) => s.id === corpo.serviceId);
      const primeira = mem.stages.filter((entry) => entry.funnelId === corpo.funnelId).sort((a, b) => a.ordem - b.ordem)[0];
      mem.proximo += 1;
      const item = comFinanceiro({
        ...(await negociacao(mem.proximo)),
        id: `negotiation:${mem.proximo}`,
        cardId: `card:${mem.proximo}`,
        crmRecordId: corpo.crmRecordId,
        cliente: { empresa: cli ? cli.empresa : null },
        funnelId: corpo.funnelId,
        stageId: primeira.id,
        stageNome: primeira.nome,
        serviceId: corpo.serviceId,
        servicoNome: srv ? srv.nome : null,
        duracao: corpo.duracao ?? 'DEFINIDA',
        prazoMeses: corpo.prazoMeses ?? null,
        avisoPrevioDias: corpo.avisoPrevioDias ?? null,
        formaPagamento: corpo.formaPagamento,
        periodicidade: corpo.periodicidade ?? null,
        valorNegociado: corpo.valorNegociado,
        previsaoFechamento: corpo.previsaoFechamento ?? null,
      });
      mem.negotiations.push(item);
      return { item: clone(item) };
    },
    updateNegotiation: async (id, patch) => {
      chamadas.push(['atualizar', id, clone(patch)]);
      await passar('atualizar');
      const item = achar(id);
      if (!item) throw await naoAchou();
      if (item.situacao !== 'ABERTA') throw await erroApi(409, 'NEGOTIATION_CLOSED');
      Object.assign(item, patch);
      if (item.duracao === 'INDETERMINADA' && !Object.prototype.hasOwnProperty.call(patch, 'prazoMeses')) item.prazoMeses = null;
      if (item.duracao !== 'INDETERMINADA' && !Object.prototype.hasOwnProperty.call(patch, 'avisoPrevioDias')) item.avisoPrevioDias = null;
      if (patch.serviceId) item.servicoNome = (mem.services.find((s) => s.id === patch.serviceId) || {}).nome ?? item.servicoNome;
      comFinanceiro(item);
      item.eventos.push(evento('ATUALIZADA', { alteracoes: Object.keys(patch).map((campo) => ({ campo, de: null, para: patch[campo] })) }));
      return { item: clone(item) };
    },
    moveNegotiation: async (id, stageId, reason) => {
      chamadas.push(['mover', id, stageId, reason ?? null]);
      await passar('mover');
      const item = achar(id);
      if (!item) throw await naoAchou();
      if (item.situacao !== 'ABERTA') throw await erroApi(409, 'NEGOTIATION_CLOSED');
      const destino = stageOf(stageId);
      if (!destino || destino.funnelId !== item.funnelId) throw await erroApi(400, 'NEGOTIATION_INVALID_INPUT', [{ path: 'stageId', code: 'ETAPA_DE_OUTRO_FUNIL' }]);
      item.eventos.push(evento('ETAPA', { deEtapaId: item.stageId, deEtapaNome: item.stageNome, paraEtapaId: destino.id, paraEtapaNome: destino.nome }));
      item.stageId = destino.id;
      item.stageNome = destino.nome;
      return { item: clone(item) };
    },
    winNegotiation: async (id) => {
      chamadas.push(['ganhar', id]);
      await passar('ganhar');
      const item = achar(id);
      if (!item) throw await naoAchou();
      if (item.situacao !== 'ABERTA') throw await erroApi(409, 'NEGOTIATION_INVALID_STATE');
      Object.assign(item, { situacao: 'GANHA', fechadoEm: '2026-10-18T14:00:00.000Z' });
      item.eventos.push(evento('GANHA'));
      return { item: clone(item) };
    },
    loseNegotiation: async (id, motivo) => {
      chamadas.push(['perder', id, motivo]);
      await passar('perder');
      const item = achar(id);
      if (!item) throw await naoAchou();
      if (item.situacao !== 'ABERTA') throw await erroApi(409, 'NEGOTIATION_INVALID_STATE');
      Object.assign(item, { situacao: 'PERDIDA', motivoPerda: motivo, fechadoEm: '2026-10-18T14:00:00.000Z' });
      item.eventos.push(evento('PERDIDA', { motivo }));
      return { item: clone(item) };
    },
    reopenNegotiation: async (id) => {
      chamadas.push(['reabrir', id]);
      await passar('reabrir');
      const item = achar(id);
      if (!item) throw await naoAchou();
      if (item.situacao === 'ABERTA') throw await erroApi(409, 'NEGOTIATION_INVALID_STATE');
      const de = item.situacao;
      Object.assign(item, { situacao: 'ABERTA', motivoPerda: null, fechadoEm: null });
      item.eventos.push(evento('REABERTA', { de }));
      return { item: clone(item) };
    },
    deleteFunnelCard: async (id) => {
      chamadas.push(['arquivar', id]);
      await passar('arquivar');
      mem.legacyCards = mem.legacyCards.filter((card) => card.id !== id);
      return { deleted: true, id };
    },
    getFunnelCardHistory: async (id) => {
      chamadas.push(['historico', id]);
      await passar('historico');
      return { historico: [{ cardId: id, stageFrom: null, stageTo: 'stage:1', movedBy: { name: 'Breno Bento' }, motivo: null, movedAt: T }] };
    },
    // ---- a estrutura: funis e etapas (MANAGE:FUNNELS) ----
    listFunnels: async () => {
      chamadas.push(['funis']);
      await passar('funis');
      return { items: clone(mem.funnels) };
    },
    listFunnelStages: async (funnelId) => {
      chamadas.push(['etapas', funnelId]);
      await passar('etapas');
      return { items: clone(mem.stages.filter((entry) => entry.funnelId === funnelId).sort((a, b) => a.ordem - b.ordem)) };
    },
    createFunnel: async (corpo) => {
      chamadas.push(['criarFunil', clone(corpo)]);
      await passar('criarFunil');
      mem.proximo += 1;
      const item = { id: `funnel:${mem.proximo}`, nome: corpo.nome, descricao: corpo.descricao ?? null, finalidade: corpo.finalidade ?? null, ativo: true, ordem: mem.funnels.length };
      mem.funnels.push(item);
      return { item: clone(item) };
    },
    updateFunnel: async (id, patch) => {
      chamadas.push(['editarFunil', id, clone(patch)]);
      await passar('editarFunil');
      const item = mem.funnels.find((entry) => entry.id === id);
      if (!item) throw await erroApi(404, 'NOT_FOUND');
      Object.assign(item, patch);
      return { item: clone(item) };
    },
    deleteFunnel: async (id) => {
      chamadas.push(['excluirFunil', id]);
      await passar('excluirFunil');
      const temCards = mem.negotiations.some((n) => n.funnelId === id) || mem.legacyCards.some((card) => card.funnelId === id);
      if (temCards) throw await erroApi(409, 'FUNNEL_HAS_CARDS');
      mem.funnels = mem.funnels.filter((entry) => entry.id !== id);
      mem.stages = mem.stages.filter((entry) => entry.funnelId !== id);
      return { deleted: true, id };
    },
    createFunnelStage: async (funnelId, corpo) => {
      chamadas.push(['criarEtapa', funnelId, clone(corpo)]);
      await passar('criarEtapa');
      mem.proximo += 1;
      const item = { id: `stage:${mem.proximo}`, funnelId, nome: corpo.nome, ordem: mem.stages.filter((entry) => entry.funnelId === funnelId).length, ativo: true };
      mem.stages.push(item);
      return { item: clone(item) };
    },
    updateFunnelStage: async (id, patch) => {
      chamadas.push(['editarEtapa', id, clone(patch)]);
      await passar('editarEtapa');
      const item = stageOf(id);
      if (!item) throw await erroApi(404, 'NOT_FOUND');
      Object.assign(item, patch);
      return { item: clone(item) };
    },
    deleteFunnelStage: async (id) => {
      chamadas.push(['excluirEtapa', id]);
      await passar('excluirEtapa');
      const temCards = mem.negotiations.some((n) => n.stageId === id) || mem.legacyCards.some((card) => card.stageId === id);
      if (temCards) throw await erroApi(409, 'STAGE_HAS_CARDS');
      mem.stages = mem.stages.filter((entry) => entry.id !== id);
      return { deleted: true, id };
    },
    reorderFunnelStages: async (funnelId, ids) => {
      chamadas.push(['reordenar', funnelId, [...ids]]);
      await passar('reordenar');
      ids.forEach((id, ordem) => {
        const item = stageOf(id);
        if (item) item.ordem = ordem;
      });
      return { items: clone(mem.stages.filter((entry) => entry.funnelId === funnelId).sort((a, b) => a.ordem - b.ordem)) };
    },
    // ---- o resumo (Dashboard Comercial): a mesma conta do servidor, em centavos ----
    negotiationSummary: async () => {
      chamadas.push(['resumo']);
      await passar('resumo');
      return { resumo: resumoDe(mem.negotiations) };
    },
  };
  return api;
}

const centavos = (valor) => Math.round(valor * 100);
function resumoDe(negociacoes) {
  const balde = () => ({ quantidade: 0, tcv: 0, indeterminado: 0, mrr: 0, outras: 0, semCalculo: 0 });
  const baldes = { ABERTA: balde(), GANHA: balde(), PERDIDA: balde() };
  const porEtapa = new Map();
  for (const n of negociacoes) {
    const b = baldes[n.situacao];
    if (!b) continue;
    b.quantidade += 1;
    if (n.financeiro) {
      if (typeof n.financeiro.tcv === 'number') b.tcv += centavos(n.financeiro.tcv);
      else b.indeterminado += 1;
      if (n.financeiro.mrr !== null && n.financeiro.mrr !== undefined) b.mrr += centavos(n.financeiro.mrr);
      else if (n.financeiro.equivalenteMensal !== null && n.financeiro.equivalenteMensal !== undefined) b.outras += centavos(n.financeiro.equivalenteMensal);
    } else b.semCalculo += 1;
    if (n.situacao === 'ABERTA') {
      const chave = `${n.funnelId}|${n.stageId}`;
      const linha = porEtapa.get(chave) || { funnelId: n.funnelId, funnelNome: n.funnelNome, stageId: n.stageId, stageNome: n.stageNome, quantidade: 0, tcv: 0, tcvIndeterminadas: 0, mrrCentavos: 0 };
      linha.quantidade += 1;
      if (n.financeiro && typeof n.financeiro.tcv === 'number') linha.tcv += centavos(n.financeiro.tcv);
      else if (n.financeiro) linha.tcvIndeterminadas += 1;
      if (n.financeiro && typeof n.financeiro.mrr === 'number') linha.mrrCentavos += centavos(n.financeiro.mrr);
      porEtapa.set(chave, linha);
    }
  }
  const forma = (b) => ({ quantidade: b.quantidade, tcv: b.tcv / 100, tcvIndeterminado: b.indeterminado, mrr: b.mrr / 100, equivalenteMensalOutrasRecorrencias: b.outras / 100, receitaMensalEquivalenteTotal: (b.mrr + b.outras) / 100, semCalculo: b.semCalculo });
  const ganhas = baldes.GANHA.quantidade;
  const perdidas = baldes.PERDIDA.quantidade;
  return { abertas: forma(baldes.ABERTA), ganhas: forma(baldes.GANHA), perdidas: forma(baldes.PERDIDA), conversao: { fechadas: ganhas + perdidas, ganhas, perdidas, taxa: ganhas + perdidas > 0 ? ganhas / (ganhas + perdidas) : null }, porEtapa: [...porEtapa.values()].map((l) => ({ ...l, tcv: l.tcv / 100, mrr: l.mrrCentavos / 100 })), total: negociacoes.length };
}

// Monta a tela do quadro sobre o DOM de teste, com a camada de modais e avisos REAL do Dashboard.
async function abrirQuadro({ api, permissions = ADMIN, carregar = true, navigation = null } = {}) {
  const { createFunnelsView } = await loadFunnels();
  const { createUi } = await loadUi();
  const browser = createBrowser({ hash: '#/funis' });
  browser.document.body.append(browser.root);
  const screen = browser.document.createElement('div');
  const host = browser.document.createElement('div');
  host.className = 'overlay-host';
  browser.root.append(screen, host);
  const ui = createUi({ document: browser.document, host, getInertTargets: () => [screen] });
  const navegacoes = [];
  const view = createFunnelsView({ document: browser.document, root: screen, api, permissions, navigate: (hash) => navegacoes.push(hash), navigation, ui });
  const s = { browser, view, api, ui, screen, navegacoes };
  if (carregar) {
    await view.load();
    await browser.flush(8);
  }
  return s;
}

// Monta uma tela qualquer (a Gestão de Funis e Etapas, o Dashboard Comercial) sobre o DOM de teste, com a camada de modais e avisos REAL.
async function montarTela(criar, { api, permissions = ADMIN, carregar = true, hash = '#/' } = {}) {
  const { createUi } = await loadUi();
  const browser = createBrowser({ hash });
  browser.document.body.append(browser.root);
  const screen = browser.document.createElement('div');
  const host = browser.document.createElement('div');
  host.className = 'overlay-host';
  browser.root.append(screen, host);
  const ui = createUi({ document: browser.document, host, getInertTargets: () => [screen] });
  const view = await criar({ document: browser.document, root: screen, api, permissions, ui });
  const s = { browser, view, api, ui, screen };
  if (carregar) {
    await view.load();
    await browser.flush(10);
  }
  return s;
}
const abrirAdmin = async (opcoes) => montarTela(async (deps) => (await loadAdmin()).createFunnelAdminView(deps), opcoes);
const abrirPainel = async (opcoes) => montarTela(async (deps) => (await loadDashboard()).createCommercialDashboardView(deps), opcoes);

// --- o que a pessoa vê ----------------------------------------------------------------------------------------------------------------------------
const quadroEl = (s) => s.browser.by.id(s.screen, 'funnel-board');
const colunas = (s) => s.browser.by.cls(s.screen, 'funnel-column');
const colunaDe = (s, stageId) => s.browser.find(s.screen, (el) => el.localName === 'section' && el.getAttribute('data-stage') === stageId);
const cartoes = (s) => s.browser.by.cls(s.screen, 'funnel-card');
const cartaoDe = (s, cardId) => s.browser.find(s.screen, (el) => /\bfunnel-card\b/.test(el.className) && el.getAttribute('data-id') === cardId);
const tituloDe = (s, cardId) => s.browser.find(s.screen, (el) => el.localName === 'button' && el.getAttribute('data-card') === cardId && el.getAttribute('data-action') === 'open');
const botaoDaTela = (s, acao) => s.browser.find(s.screen, (el) => el.localName === 'button' && el.getAttribute('data-action') === acao);
const moverDe = (s, cardId) => s.browser.find(cartaoDe(s, cardId) || s.screen, (el) => el.localName === 'select' && el.getAttribute('data-action') === 'move');
const textoDaTela = (s) => s.screen.textContent.replace(/\s+/g, ' ');
const modal = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bmodal\b/.test(el.className) && /\bsize-md\b/.test(el.className));
const confirmacao = (s) => s.browser.find(s.browser.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bmodal\b/.test(el.className) && /\bsize-sm\b/.test(el.className));
const formulario = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bdrawer\b/.test(el.className));
const doModal = (s, acao) => s.browser.find(modal(s), (el) => el.localName === 'button' && el.getAttribute('data-action') === acao);
const campo = (s, nome) => s.browser.by.id(s.browser.root, `negotiation-field-${nome}`);
const erroDoCampo = (s, nome) => s.browser.by.id(s.browser.root, `negotiation-field-${nome}-error`);
const botao = (s, texto, escopo) => s.browser.by.button(escopo || s.browser.root, texto);
const avisos = (s) => s.browser.findAll(s.browser.root, (el) => el.className === 'toast-message').map((el) => el.textContent);
const camadas = (s) => s.browser.findAll(s.browser.root, (el) => /\boverlay\b/.test(el.className) && el.hasAttribute('data-overlay'));
const clicar = async (s, el) => {
  s.browser.click(el);
  await s.browser.flush(10);
};
const digitar = (s, el, valor) => s.browser.type(el, valor);
const marcar = (s, el, marcado = true) => s.browser.check(el, marcado);
const escolher = (s, el, valor) => s.browser.choose(el, valor);

module.exports = { ADMIN, CLOSER, LEITOR, T, clone, funil, etapa, cliente, servico, negociacao, erroApi, apiNegocios, abrirQuadro, abrirAdmin, abrirPainel, montarTela, resumoDe, quadroEl, colunas, colunaDe, cartoes, cartaoDe, tituloDe, botaoDaTela, moverDe, textoDaTela, modal, confirmacao, formulario, doModal, campo, erroDoCampo, botao, avisos, camadas, clicar, digitar, marcar, escolher };
