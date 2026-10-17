'use strict';

// PostgREST FALSO das entidades COMERCIAIS (Funis, Etapas, Cards, Movimentos, Negociações e o histórico delas) — USO SOMENTE EM TESTES (src/ nunca importa este arquivo). Fase D1.1.
// Não é um arquivo de teste (sem *.test.js). Nunca toca a rede: é um `fetchImpl` que entende só o que os adapters usam e EMULA, em JavaScript, as garantias do banco que a migration
// 20261019090000_crm_negotiations.sql (e as duas de Funis, pré-requisitos) prometem:
//   - as tabelas e as COLUNAS de cada uma (corpo com coluna inexistente -> 400, PGRST204, como o PostgREST), NOT NULL, os CHECKs que importam e as chaves estrangeiras (cliente e serviço
//     precisam existir em `referencias`, como as FKs de crm_records e crm_services);
//   - o índice único PARCIAL dos cards avulsos ativos (409, 23505, "crm_funnel_cards_active_unique_idx"), os gatilhos de integridade (a etapa é do funil do card; funil, registro e
//     negociação de um card nunca mudam; o funil de uma etapa nunca muda) e o histórico IMUTÁVEL (UPDATE/DELETE em movimentos e eventos -> P0001);
//   - as funções RPC: commit_crm_negotiation_change, commit_crm_funnel_card_change, reorder_crm_funnel_stages, delete_crm_funnel_if_empty e delete_crm_funnel_stage_if_empty — cada uma
//     ATÔMICA (um instantâneo das tabelas é restaurado se qualquer passo falhar) e com as MESMAS verificações do SQL (concorrência otimista, transições, histórico que só cresce, etc.);
//   - GET: filtros `col=eq.x` / `col=is.null`, `order`, `limit`/`offset`, o TETO de linhas por resposta (db-max-rows, padrão 1000), `Prefer: count=exact` com o total em Content-Range e o 206
//     quando parcial; o formato de timestamptz do Postgres ("...123000+00:00").
// `aoResponder(n, req, api)` (opcional) pode devolver uma resposta pronta para a n-ésima requisição (falhas, corpos inválidos); `falhar(nome)` faz a PRÓXIMA chamada àquela RPC/tabela falhar.
// Registra cada requisição em `chamadas` (método, caminho, query, Prefer, corpo). Todos os dados são fictícios.

const PERIODICITIES = { MENSAL: 1, TRIMESTRAL: 3, SEMESTRAL: 6, ANUAL: 12 };
const ENVIAVEIS = {
  crm_funnels: ['id', 'nome', 'descricao', 'finalidade', 'ativo', 'ordem', 'config', 'criado_em', 'updated_at'],
  crm_funnel_stages: ['id', 'funnel_id', 'nome', 'ordem', 'ativo', 'config', 'criado_em', 'updated_at'],
  crm_funnel_cards: ['id', 'funnel_id', 'stage_id', 'crm_record_id', 'negotiation_id', 'perdido_em', 'motivo_perdido', 'criado_em', 'updated_at', 'removed_at'],
  crm_funnel_card_moves: ['card_id', 'stage_from', 'stage_to', 'moved_by_user_id', 'moved_by_name', 'moved_by_role', 'moved_at', 'motivo'],
};
const TABELAS_LIDAS = ['crm_funnels', 'crm_funnel_stages', 'crm_funnel_cards', 'crm_funnel_card_moves', 'crm_negotiations', 'crm_negotiation_events'];

class ErroBanco extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const p0001 = (mensagem) => new ErroBanco(400, 'P0001', mensagem);
const cheque = (nome) => new ErroBanco(400, '23514', `new row for relation violates check constraint "${nome}"`);
const naoNulo = (coluna) => new ErroBanco(400, '23502', `null value in column "${coluna}" violates not-null constraint`);
const fk = (nome) => new ErroBanco(409, '23503', `insert or update violates foreign key constraint "${nome}"`);

const clone = (valor) => (valor === undefined ? valor : structuredClone(valor));
const naoVazio = (texto) => typeof texto === 'string' && texto.trim() !== '';
const noPostgres = (iso) => (typeof iso === 'string' ? iso.replace(/\.(\d{3})Z$/, '.$1000+00:00') : iso);
const ms = (valor) => (valor === null || valor === undefined ? null : new Date(valor).getTime());

function resposta(status, corpo, cabecalhos = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (nome) => cabecalhos[String(nome).toLowerCase()] ?? null }, text: async () => (corpo === undefined ? '' : typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) };
}

function criarPostgrestComercial({ maxRows = 1000, bigintComoTexto = false, referencias = 'estritas', inicio = '2026-10-19T12:00:00.000Z', aoResponder } = {}) {
  const t = { crm_funnels: new Map(), crm_funnel_stages: new Map(), crm_funnel_cards: new Map(), crm_funnel_card_moves: [], crm_negotiations: new Map(), crm_negotiation_events: [] };
  const clientes = new Map(); // crm_records: id -> { status }
  const servicos = new Map(); // crm_services: id -> { ativo, permite_pagamento_unico, permite_pagamento_recorrente, periodicidades }
  let identidade = 0;
  let relogio = new Date(inicio).getTime();
  const agora = () => new Date((relogio += 1000)).toISOString();
  const chamadas = [];
  const falhas = new Map();
  const falhasSempre = new Map();
  const ESTADO = () => ({ t: { crm_funnels: new Map(t.crm_funnels), crm_funnel_stages: new Map(t.crm_funnel_stages), crm_funnel_cards: new Map(t.crm_funnel_cards), crm_funnel_card_moves: [...t.crm_funnel_card_moves], crm_negotiations: new Map(t.crm_negotiations), crm_negotiation_events: [...t.crm_negotiation_events] }, identidade });
  const RESTAURAR = (s) => {
    for (const nome of Object.keys(s.t)) t[nome] = s.t[nome];
    identidade = s.identidade;
  };

  // ------------------------------------------------------------------ regras do banco (as mesmas da migration)
  function conferirCliente(id) {
    if (referencias === 'estritas' && !clientes.has(id)) throw fk('crm_funnel_cards_crm_record_id_fkey');
  }
  function integridadeCard(novo, antigo) {
    if (antigo && (novo.funnel_id !== antigo.funnel_id || novo.crm_record_id !== antigo.crm_record_id || (novo.negotiation_id ?? null) !== (antigo.negotiation_id ?? null))) {
      throw p0001('crm_funnel_cards_integrity: o funil, o registro do CRM e a negociação de um card nunca mudam');
    }
    const etapa = t.crm_funnel_stages.get(novo.stage_id);
    if (!etapa || etapa.funnel_id !== novo.funnel_id) throw p0001(`crm_funnel_cards_integrity: a etapa ${novo.stage_id} não pertence ao funil ${novo.funnel_id}`);
  }
  function unicoAvulso(novo) {
    if (novo.removed_at !== null || novo.negotiation_id !== null) return;
    for (const c of t.crm_funnel_cards.values()) {
      if (c.id !== novo.id && c.funnel_id === novo.funnel_id && c.crm_record_id === novo.crm_record_id && c.removed_at === null && c.negotiation_id === null) {
        throw new ErroBanco(409, '23505', 'duplicate key value violates unique constraint "crm_funnel_cards_active_unique_idx"');
      }
    }
  }
  function validarFunil(linha) {
    if (!/^funnel:[0-9a-f-]{36}$/.test(linha.id)) throw cheque('crm_funnels_id_check');
    if (!naoVazio(linha.nome)) throw cheque('crm_funnels_nome_check');
    if (linha.descricao !== null && !naoVazio(linha.descricao)) throw cheque('crm_funnels_descricao_check');
    if (linha.finalidade !== null && !naoVazio(linha.finalidade)) throw cheque('crm_funnels_finalidade_check');
  }
  function validarEtapa(linha) {
    if (!/^stage:[0-9a-f-]{36}$/.test(linha.id)) throw cheque('crm_funnel_stages_id_check');
    if (!naoVazio(linha.nome)) throw cheque('crm_funnel_stages_nome_check');
    if (!t.crm_funnels.has(linha.funnel_id)) throw fk('crm_funnel_stages_funnel_id_fkey');
  }
  function validarCard(linha) {
    if (!/^card:[0-9a-f-]{36}$/.test(linha.id)) throw cheque('crm_funnel_cards_id_check');
    if (!t.crm_funnels.has(linha.funnel_id)) throw fk('crm_funnel_cards_funnel_id_fkey');
    conferirCliente(linha.crm_record_id);
  }
  function inserirMovimento(m) {
    if (!naoVazio(m.moved_by_user_id)) throw naoNulo('moved_by_user_id');
    if (!naoVazio(m.moved_by_name)) throw naoNulo('moved_by_name');
    if (!naoVazio(m.moved_by_role)) throw naoNulo('moved_by_role');
    if (!t.crm_funnel_cards.has(m.card_id)) throw fk('crm_funnel_card_moves_card_id_fkey');
    if (m.stage_from !== null && !t.crm_funnel_stages.has(m.stage_from)) throw fk('crm_funnel_card_moves_stage_from_fkey');
    if (!t.crm_funnel_stages.has(m.stage_to)) throw fk('crm_funnel_card_moves_stage_to_fkey');
    if (m.motivo !== null && !naoVazio(m.motivo)) throw cheque('crm_funnel_card_moves_motivo_check');
    t.crm_funnel_card_moves.push({ id: ++identidade, card_id: m.card_id, stage_from: m.stage_from, stage_to: m.stage_to, moved_by_user_id: m.moved_by_user_id, moved_by_name: m.moved_by_name, moved_by_role: m.moved_by_role, moved_at: m.moved_at ?? agora(), motivo: m.motivo });
  }

  // ------------------------------------------------------------------ as funções RPC
  const unico = (valor) => (valor === undefined ? null : valor);
  function servicoPermite(servicoId, forma, periodicidade, exigirAtivo) {
    const s = servicos.get(servicoId);
    if (!s && referencias === 'livres') return; // sem o catálogo no banco falso: a conferência do serviço fica com o domínio
    if (!s) throw p0001('crm_negotiation_service_not_found');
    if (exigirAtivo && s.ativo !== true) throw p0001('crm_negotiation_service_inactive');
    if (forma === 'UNICO' && s.permite_pagamento_unico !== true) throw p0001('crm_negotiation_service_forbids_payment');
    if (forma === 'RECORRENTE' && (s.permite_pagamento_recorrente !== true || !s.periodicidades.includes(periodicidade))) throw p0001('crm_negotiation_service_forbids_payment');
  }
  function validarNegociacao(n) {
    if (!/^negotiation:[0-9a-f-]{36}$/.test(n.id)) throw cheque('crm_negotiations_id_check');
    if (!Number.isInteger(n.prazo_meses) || n.prazo_meses < 1 || n.prazo_meses > 120) throw cheque('crm_negotiations_prazo_meses_check');
    if (!['UNICO', 'RECORRENTE'].includes(n.forma_pagamento)) throw cheque('crm_negotiations_forma_pagamento_check');
    if (n.periodicidade !== null && !(n.periodicidade in PERIODICITIES)) throw cheque('crm_negotiations_periodicidade_check');
    if (!Number.isInteger(n.valor_centavos) || n.valor_centavos < 1 || n.valor_centavos > 100000000000) throw cheque('crm_negotiations_valor_centavos_check');
    if (!['ABERTA', 'GANHA', 'PERDIDA'].includes(n.situacao)) throw cheque('crm_negotiations_situacao_check');
    const pagamentoOk = (n.forma_pagamento === 'UNICO' && n.periodicidade === null) || (n.forma_pagamento === 'RECORRENTE' && n.periodicidade !== null && n.prazo_meses % PERIODICITIES[n.periodicidade] === 0);
    if (!pagamentoOk) throw cheque('crm_negotiations_pagamento_coerente');
    const situacaoOk = (n.situacao === 'ABERTA' && n.motivo_perda === null && n.fechado_em === null) || (n.situacao === 'GANHA' && n.motivo_perda === null && n.fechado_em !== null)
      || (n.situacao === 'PERDIDA' && naoVazio(n.motivo_perda) && n.fechado_em !== null);
    if (!situacaoOk) throw cheque('crm_negotiations_situacao_coerente');
    for (const coluna of ['responsavel_user_id', 'responsavel_nome', 'created_by_user_id', 'created_by_name', 'updated_by_user_id', 'updated_by_name']) if (!naoVazio(n[coluna])) throw naoNulo(coluna);
  }
  function linhaNegociacao(p) {
    return {
      id: p.id, crm_record_id: p.crmRecordId, funnel_id: p.funnelId, card_id: p.cardId, service_id: p.serviceId, servico_nome: unico(p.servicoNome), responsavel_user_id: p.responsavelUserId,
      responsavel_nome: p.responsavelNome, prazo_meses: p.prazoMeses, forma_pagamento: p.formaPagamento, periodicidade: unico(p.periodicidade), valor_centavos: p.valorCentavos,
      previsao_fechamento: unico(p.previsaoFechamento), situacao: p.situacao, motivo_perda: unico(p.motivoPerda), fechado_em: unico(p.fechadoEm), created_at: p.criadoEm, updated_at: p.atualizadoEm,
      created_by_user_id: p.criadoPorUserId, created_by_name: p.criadoPorNome, updated_by_user_id: p.atualizadoPorUserId, updated_by_name: p.atualizadoPorNome,
    };
  }
  function eventoLinha(negociacaoId, seq, e) {
    if (!['CRIADA', 'ATUALIZADA', 'ETAPA', 'GANHA', 'PERDIDA', 'REABERTA'].includes(e.tipo)) throw cheque('crm_negotiation_events_tipo_check');
    if (!naoVazio(e.porUserId) || !naoVazio(e.porNome)) throw naoNulo('por_user_id');
    return { id: ++identidade, negotiation_id: negociacaoId, seq, tipo: e.tipo, em: e.em, por_user_id: e.porUserId, por_nome: e.porNome, detalhe: e.detalhe === undefined ? null : e.detalhe };
  }
  function consistenciaCard(n) {
    const c = t.crm_funnel_cards.get(n.card_id);
    if (!c || c.negotiation_id !== n.id || c.funnel_id !== n.funnel_id || c.crm_record_id !== n.crm_record_id) throw p0001(`crm_negotiations_card_consistency: o card ${n.card_id} não corresponde à negociação ${n.id}`);
  }

  function commitNegociacao(a) {
    const { p_mode: modo, p_negotiation: pn, p_card: pc, p_card_move: pm, p_expected_updated_at: esperado } = a;
    if (!['create', 'update'].includes(modo)) throw new ErroBanco(400, '22023', 'commit_crm_negotiation_change: modo inválido');
    if (!pn || typeof pn !== 'object' || !pn.id) throw new ErroBanco(400, '22023', 'commit_crm_negotiation_change: negociação inválida');
    if (!Array.isArray(pn.eventos) || pn.eventos.length === 0) throw p0001('crm_negotiation_history: a negociação não traz o histórico obrigatório');
    if ((pc === null) !== (pm === null)) throw new ErroBanco(400, '22023', 'commit_crm_negotiation_change: o card e o movimento do card vêm juntos');
    const dado = linhaNegociacao(pn);
    if (modo === 'create') {
      if (pc === null) throw new ErroBanco(400, '22023', 'commit_crm_negotiation_change: criar exige o card e o primeiro movimento');
      if (pn.situacao !== 'ABERTA' || pn.eventos.length !== 1 || pn.eventos[0].tipo !== 'CRIADA') throw p0001('crm_negotiation_history: uma negociação nasce ABERTA com o histórico [CRIADA]');
      if (pc.negotiationId !== pn.id || pc.id !== pn.cardId || pc.funnelId !== pn.funnelId || pc.crmRecordId !== pn.crmRecordId || pm.cardId !== pc.id || pm.stageTo !== pc.stageId || (pm.stageFrom ?? null) !== null) {
        throw p0001('crm_negotiation_immutable: o card não corresponde à negociação');
      }
      const cliente = clientes.get(pn.crmRecordId) || (referencias === 'livres' ? { status: 'PROSPECT' } : null);
      if (!cliente || cliente.status === 'DO_NOT_CONTACT') throw p0001('crm_negotiation_client_blocked');
      const funil = t.crm_funnels.get(pn.funnelId);
      if (!funil || funil.ativo !== true) throw p0001('crm_negotiation_funnel_inactive');
      const etapa = t.crm_funnel_stages.get(pc.stageId);
      if (!etapa || etapa.funnel_id !== pn.funnelId || etapa.ativo !== true) throw p0001('crm_negotiation_stage_invalid');
      servicoPermite(pn.serviceId, pn.formaPagamento, unico(pn.periodicidade), true);
      const card = { id: pc.id, funnel_id: pc.funnelId, stage_id: pc.stageId, crm_record_id: pc.crmRecordId, negotiation_id: pn.id, perdido_em: null, motivo_perdido: null, criado_em: pc.criadoEm, updated_at: pc.updatedAt, removed_at: null };
      integridadeCard(card, null);
      validarCard(card);
      if (t.crm_funnel_cards.has(card.id)) throw new ErroBanco(409, '23505', 'duplicate key value violates unique constraint "crm_funnel_cards_pkey"');
      t.crm_funnel_cards.set(card.id, card);
      inserirMovimento({ card_id: pm.cardId, stage_from: null, stage_to: pm.stageTo, moved_by_user_id: pm.movedBy && pm.movedBy.userId, moved_by_name: pm.movedBy && pm.movedBy.name, moved_by_role: pm.movedBy && pm.movedBy.role, motivo: pm.motivo || null, moved_at: pm.movedAt });
      validarNegociacao(dado);
      if (referencias === 'estritas' && !servicos.has(dado.service_id)) throw fk('crm_negotiations_service_id_fkey');
      if (t.crm_negotiations.has(dado.id)) throw new ErroBanco(409, '23505', 'duplicate key value violates unique constraint "crm_negotiations_pkey"');
      for (const outra of t.crm_negotiations.values()) if (outra.card_id === dado.card_id) throw new ErroBanco(409, '23505', 'duplicate key value violates unique constraint "crm_negotiations_card_id_key"');
      t.crm_negotiations.set(dado.id, dado);
      pn.eventos.forEach((e, i) => t.crm_negotiation_events.push(eventoLinha(dado.id, i, e)));
      consistenciaCard(dado);
      return;
    }
    const atual = t.crm_negotiations.get(pn.id);
    if (!atual) throw p0001('crm_negotiation_not_found');
    if (esperado === null || esperado === undefined || ms(atual.updated_at) !== ms(esperado)) throw p0001('crm_negotiation_conflict');
    if (atual.crm_record_id !== dado.crm_record_id || atual.funnel_id !== dado.funnel_id || atual.card_id !== dado.card_id || atual.created_by_user_id !== dado.created_by_user_id || ms(atual.created_at) !== ms(dado.created_at)) {
      throw p0001('crm_negotiation_immutable: cliente, funil, card e autoria da criação nunca mudam');
    }
    if (atual.situacao !== 'ABERTA' && dado.situacao !== 'ABERTA') throw p0001('crm_negotiation_closed');
    if (pc !== null && (atual.situacao !== 'ABERTA' || dado.situacao !== 'ABERTA')) throw p0001('crm_negotiation_closed');
    if (dado.service_id !== atual.service_id || dado.forma_pagamento !== atual.forma_pagamento || dado.periodicidade !== atual.periodicidade) servicoPermite(dado.service_id, dado.forma_pagamento, dado.periodicidade, dado.service_id !== atual.service_id);
    const gravados = t.crm_negotiation_events.filter((e) => e.negotiation_id === pn.id).sort((x, y) => x.seq - y.seq);
    if (pn.eventos.length < gravados.length) throw p0001('crm_negotiation_history: o histórico não pode encolher');
    gravados.forEach((linha, i) => {
      const e = pn.eventos[i];
      if (linha.tipo !== e.tipo || linha.por_user_id !== e.porUserId || linha.por_nome !== e.porNome || ms(linha.em) !== ms(e.em) || JSON.stringify(linha.detalhe) !== JSON.stringify(e.detalhe === undefined ? null : e.detalhe)) {
        throw p0001('crm_negotiation_history: um evento já gravado não pode mudar');
      }
    });
    if (pn.eventos.length === gravados.length) throw p0001('crm_negotiation_history: toda alteração acrescenta um evento ao histórico');
    if (pc !== null) {
      const card = t.crm_funnel_cards.get(atual.card_id);
      if (!card || card.negotiation_id !== pn.id || card.removed_at !== null || pc.id !== atual.card_id || pm.cardId !== atual.card_id || (pm.stageFrom ?? null) !== card.stage_id || pm.stageTo !== pc.stageId || pc.stageId === card.stage_id) {
        throw p0001('crm_negotiation_stage_invalid: o card não confere com a mudança de etapa');
      }
      const etapa = t.crm_funnel_stages.get(pc.stageId);
      if (!etapa || etapa.funnel_id !== atual.funnel_id || etapa.ativo !== true) throw p0001('crm_negotiation_stage_invalid');
      const novo = { ...card, stage_id: pc.stageId, updated_at: agora() };
      integridadeCard(novo, card);
      t.crm_funnel_cards.set(card.id, novo);
      inserirMovimento({ card_id: card.id, stage_from: card.stage_id, stage_to: pm.stageTo, moved_by_user_id: pm.movedBy && pm.movedBy.userId, moved_by_name: pm.movedBy && pm.movedBy.name, moved_by_role: pm.movedBy && pm.movedBy.role, motivo: pm.motivo || null, moved_at: pm.movedAt });
    }
    const novoRegistro = { ...atual, service_id: dado.service_id, servico_nome: dado.servico_nome, prazo_meses: dado.prazo_meses, forma_pagamento: dado.forma_pagamento, periodicidade: dado.periodicidade, valor_centavos: dado.valor_centavos,
      previsao_fechamento: dado.previsao_fechamento, situacao: dado.situacao, motivo_perda: dado.motivo_perda, fechado_em: dado.fechado_em, updated_at: dado.updated_at, updated_by_user_id: dado.updated_by_user_id, updated_by_name: dado.updated_by_name };
    validarNegociacao(novoRegistro);
    if (referencias === 'estritas' && !servicos.has(novoRegistro.service_id)) throw fk('crm_negotiations_service_id_fkey');
    t.crm_negotiations.set(pn.id, novoRegistro);
    for (let i = gravados.length; i < pn.eventos.length; i += 1) t.crm_negotiation_events.push(eventoLinha(pn.id, i, pn.eventos[i]));
    consistenciaCard(novoRegistro);
  }

  function commitCard(a) {
    const { p_card: pc, p_card_move: pm, p_expected_stage_id: esperada } = a;
    if (!pc || !pm || typeof pc !== 'object' || typeof pm !== 'object') throw new ErroBanco(400, '22023', 'commit_crm_funnel_card_change: card e movimento são obrigatórios');
    if (pm.cardId !== pc.id || pm.stageTo !== pc.stageId) throw new ErroBanco(400, '22023', 'commit_crm_funnel_card_change: o movimento não corresponde ao card');
    if (esperada === null || esperada === undefined) {
      if ((pm.stageFrom ?? null) !== null || (pc.negotiationId ?? null) !== null) throw new ErroBanco(400, '22023', 'commit_crm_funnel_card_change: um card avulso novo não tem etapa anterior nem negociação');
      const card = { id: pc.id, funnel_id: pc.funnelId, stage_id: pc.stageId, crm_record_id: pc.crmRecordId, negotiation_id: null, perdido_em: null, motivo_perdido: null, criado_em: pc.criadoEm, updated_at: pc.updatedAt, removed_at: null };
      integridadeCard(card, null);
      validarCard(card);
      unicoAvulso(card);
      if (t.crm_funnel_cards.has(card.id)) throw new ErroBanco(409, '23505', 'duplicate key value violates unique constraint "crm_funnel_cards_pkey"');
      t.crm_funnel_cards.set(card.id, card);
    } else {
      const card = t.crm_funnel_cards.get(pc.id);
      if (!card || card.negotiation_id !== null || card.removed_at !== null || card.stage_id !== esperada || (pm.stageFrom ?? null) !== esperada || card.funnel_id !== pc.funnelId) throw p0001('crm_funnel_card_conflict');
      const novo = { ...card, stage_id: pc.stageId, updated_at: agora() };
      integridadeCard(novo, card);
      t.crm_funnel_cards.set(card.id, novo);
    }
    inserirMovimento({ card_id: pm.cardId, stage_from: pm.stageFrom ?? null, stage_to: pm.stageTo, moved_by_user_id: pm.movedBy && pm.movedBy.userId, moved_by_name: pm.movedBy && pm.movedBy.name, moved_by_role: pm.movedBy && pm.movedBy.role, motivo: pm.motivo || null, moved_at: pm.movedAt });
  }

  function reordenar(a) {
    const funil = a.p_funnel_id;
    const ids = a.p_ordered_ids;
    if (!funil || !Array.isArray(ids)) throw new ErroBanco(400, '22023', 'reorder_crm_funnel_stages: funil e lista são obrigatórios');
    if (!t.crm_funnels.has(funil)) throw p0001('reorder_crm_funnel_stages: funil inexistente');
    const daqui = [...t.crm_funnel_stages.values()].filter((e) => e.funnel_id === funil);
    if (ids.length !== daqui.length || new Set(ids).size !== daqui.length || ids.some((id) => !daqui.some((e) => e.id === id))) throw p0001('reorder_crm_funnel_stages: a lista não confere com as etapas do funil');
    ids.forEach((id, i) => t.crm_funnel_stages.set(id, { ...t.crm_funnel_stages.get(id), ordem: i, updated_at: agora() }));
  }
  function excluirFunil(a) {
    const id = a.p_funnel_id;
    if ([...t.crm_funnel_cards.values()].some((c) => c.funnel_id === id)) throw p0001(`delete_crm_funnel_if_empty: funil ${id} possui cards vinculados`);
    for (const e of [...t.crm_funnel_stages.values()]) if (e.funnel_id === id) t.crm_funnel_stages.delete(e.id);
    t.crm_funnels.delete(id);
  }
  function excluirEtapa(a) {
    const id = a.p_stage_id;
    if ([...t.crm_funnel_cards.values()].some((c) => c.stage_id === id)) throw p0001(`delete_crm_funnel_stage_if_empty: etapa ${id} possui cards vinculados`);
    t.crm_funnel_stages.delete(id);
  }
  const RPCS = { commit_crm_negotiation_change: commitNegociacao, commit_crm_funnel_card_change: commitCard, reorder_crm_funnel_stages: reordenar, delete_crm_funnel_if_empty: excluirFunil, delete_crm_funnel_stage_if_empty: excluirEtapa };

  // ------------------------------------------------------------------ o HTTP
  const saidaLinha = (tabela, linha) => {
    const base = { ...linha };
    for (const campo of ['criado_em', 'updated_at', 'created_at', 'removed_at', 'moved_at', 'fechado_em', 'em', 'perdido_em']) if (campo in base) base[campo] = noPostgres(base[campo]);
    if (tabela === 'crm_negotiations' && bigintComoTexto) base.valor_centavos = String(base.valor_centavos);
    return base;
  };
  const linhasDe = (tabela) => (Array.isArray(t[tabela]) ? t[tabela] : [...t[tabela].values()]);
  function filtrar(linhas, query) {
    let r = linhas;
    for (const [chave, valor] of Object.entries(query)) {
      if (['select', 'order', 'limit', 'offset'].includes(chave)) continue;
      if (valor === 'is.null') r = r.filter((l) => l[chave] === null || l[chave] === undefined);
      else if (valor.startsWith('eq.')) r = r.filter((l) => String(l[chave]) === valor.slice(3));
      else throw new ErroBanco(400, 'PGRST100', 'filtro não suportado pelo falso');
    }
    return r;
  }
  function ordenar(linhas, ordem) {
    if (!ordem) return linhas;
    const chaves = ordem.split(',').map((parte) => { const [c, d] = parte.split('.'); return { c, d: d === 'desc' ? -1 : 1 }; });
    return [...linhas].sort((a, b) => { for (const { c, d } of chaves) { if (a[c] < b[c]) return -1 * d; if (a[c] > b[c]) return 1 * d; } return 0; });
  }
  function colunasConhecidas(tabela, corpo) {
    for (const coluna of Object.keys(corpo)) if (!ENVIAVEIS[tabela].includes(coluna)) throw new ErroBanco(400, 'PGRST204', `Could not find the '${coluna}' column of '${tabela}' in the schema cache`);
  }
  function upsert(tabela, corpo) {
    colunasConhecidas(tabela, corpo);
    const existente = t[tabela].get(corpo.id);
    if (tabela === 'crm_funnels') {
      const linha = { descricao: null, finalidade: null, ativo: true, ordem: 0, config: {}, criado_em: agora(), ...(existente || {}), ...corpo, updated_at: agora() };
      if (!naoVazio(linha.nome)) throw cheque('crm_funnels_nome_check');
      validarFunil(linha);
      t.crm_funnels.set(linha.id, linha);
    } else if (tabela === 'crm_funnel_stages') {
      if (existente && corpo.funnel_id !== undefined && corpo.funnel_id !== existente.funnel_id) throw p0001('crm_funnel_stages_integrity: o funil de uma etapa nunca muda');
      const linha = { ordem: 0, ativo: true, config: {}, criado_em: agora(), ...(existente || {}), ...corpo, updated_at: agora() };
      validarEtapa(linha);
      t.crm_funnel_stages.set(linha.id, linha);
    } else {
      const linha = { negotiation_id: null, perdido_em: null, motivo_perdido: null, removed_at: null, criado_em: agora(), ...(existente || {}), ...corpo, updated_at: agora() };
      integridadeCard(linha, existente || null);
      validarCard(linha);
      unicoAvulso(linha);
      t.crm_funnel_cards.set(linha.id, linha);
    }
  }

  async function tratar(url, init) {
    const u = new URL(String(url));
    const metodo = init.method;
    const query = Object.fromEntries(u.searchParams);
    const prefer = (init.headers && init.headers.Prefer) ?? null;
    const corpo = init.body === undefined ? undefined : JSON.parse(init.body);
    const requisicao = { metodo, caminho: u.pathname, query, prefer, corpo };
    chamadas.push(requisicao);
    const pronta = aoResponder ? aoResponder(chamadas.length, requisicao, api) : null;
    if (pronta) return pronta;
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(u.pathname);
    const tabelaNome = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
    const alvo = rpc ? rpc[1] : tabelaNome ? tabelaNome[1] : null;
    for (const mapa of [falhas, falhasSempre]) {
      if (alvo && mapa.has(alvo)) {
        const falha = mapa.get(alvo);
        if (mapa === falhas) falhas.delete(alvo);
        return typeof falha === 'function' ? falha(requisicao) : falha;
      }
    }
    const instantaneo = ESTADO();
    try {
      if (rpc) {
        if (!RPCS[rpc[1]]) return resposta(404, { code: 'PGRST202', message: 'Could not find the function' });
        RPCS[rpc[1]](corpo || {});
        return resposta(204, undefined);
      }
      if (!tabelaNome || !TABELAS_LIDAS.includes(tabelaNome[1])) return resposta(404, { code: 'PGRST205', message: `Could not find the table '${alvo}' in the schema cache` });
      const tabela = tabelaNome[1];
      if (metodo === 'GET') {
        let linhas = ordenar(filtrar(linhasDe(tabela), query), query.order);
        const deslocamento = Number(query.offset || 0);
        const pedido = 'limit' in query ? Number(query.limit) : Infinity;
        const fatia = linhas.slice(deslocamento, deslocamento + Math.min(pedido, maxRows));
        const contar = /count=exact/.test(prefer || '');
        const total = contar ? String(linhas.length) : '*';
        const faixa = fatia.length ? `${deslocamento}-${deslocamento + fatia.length - 1}/${total}` : `*/${total}`;
        const parcial = contar && deslocamento + fatia.length < linhas.length;
        const saida = fatia.map((l) => saidaLinha(tabela, l));
        const so = query.select && query.select !== '*' ? query.select.split(',') : null;
        return resposta(parcial ? 206 : 200, so ? saida.map((l) => Object.fromEntries(so.map((c) => [c, l[c]]))) : saida, { 'content-range': faixa });
      }
      if (metodo === 'POST' && ['crm_funnels', 'crm_funnel_stages', 'crm_funnel_cards'].includes(tabela)) {
        for (const linha of corpo) upsert(tabela, linha);
        return resposta(201, undefined);
      }
      if (metodo === 'POST' && tabela === 'crm_funnel_card_moves') {
        for (const linha of corpo) {
          colunasConhecidas(tabela, linha);
          inserirMovimento({ stage_from: null, motivo: null, ...linha });
        }
        return resposta(201, undefined);
      }
      if (metodo === 'PATCH' && tabela === 'crm_funnel_cards') {
        const alvos = filtrar(linhasDe(tabela), query);
        colunasConhecidas(tabela, corpo);
        for (const card of alvos) {
          const novo = { ...card, ...corpo, updated_at: agora() };
          integridadeCard(novo, card);
          t.crm_funnel_cards.set(card.id, novo);
        }
        return resposta(204, undefined);
      }
      if (['PATCH', 'DELETE'].includes(metodo) && ['crm_funnel_card_moves', 'crm_negotiation_events'].includes(tabela)) throw p0001(`${tabela} é um histórico imutável: ${metodo === 'PATCH' ? 'UPDATE' : 'DELETE'} não é permitido`);
      return resposta(405, { code: 'PGRST117', message: 'método não suportado pelo falso' });
    } catch (erro) {
      RESTAURAR(instantaneo);
      if (erro instanceof ErroBanco) return resposta(erro.status, { code: erro.code, message: erro.message, details: erro.details, hint: null });
      throw erro;
    }
  }

  const api = {
    chamadas,
    tabelas: t,
    fetchImpl: tratar,
    // as referências que o banco real teria (as FKs de crm_records e crm_services)
    registrarCliente: (id, status = 'PROSPECT') => clientes.set(id, { status }),
    mudarStatusCliente: (id, status) => clientes.set(id, { ...clientes.get(id), status }),
    registrarServico: (id, dados = {}) => servicos.set(id, { ativo: true, permite_pagamento_unico: true, permite_pagamento_recorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'], ...dados }),
    mudarServico: (id, dados) => servicos.set(id, { ...servicos.get(id), ...dados }),
    // a PRÓXIMA chamada àquela tabela/RPC falha com `resposta` (ou o que a função devolver); `falharSempre` não se esgota
    falhar: (nome, falha) => falhas.set(nome, falha),
    falharSempre: (nome, falha) => falhasSempre.set(nome, falha),
    deixarDeFalhar: () => { falhas.clear(); falhasSempre.clear(); },
    escritas: () => chamadas.filter((c) => c.metodo !== 'GET'),
    rpcs: (nome) => chamadas.filter((c) => c.caminho === `/rest/v1/rpc/${nome}`),
    instantaneo: ESTADO,
    restaurar: RESTAURAR,
    avancarRelogio: (milissegundos) => { relogio += milissegundos; },
  };
  return api;
}

module.exports = { criarPostgrestComercial, resposta, noPostgres };
