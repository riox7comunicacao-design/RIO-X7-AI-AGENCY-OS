// A API de Negociações e do quadro (rotas /api/negotiations... e /api/funnel-board de src/server/app.js — CRM 5.0, Fase D1, decisão 0028): a camada HTTP FINA sobre o Negotiation Service.
// Peças REAIS: o app, a autenticação (com o Supabase falso na borda), o Negotiation Service, o CRM, os Funis e o Catálogo, em ARQUIVOS TEMPORÁRIOS próprios. Dados fictícios; nenhum data/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}
async function chamar(env, usuario, { method = 'GET', url, body, contentType = 'application/json' } = {}) {
  const headers = {};
  if (usuario) headers.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if (body !== undefined && contentType !== null) headers['content-type'] = contentType;
  const response = await env.app.handle(makeRequest({ method, url, headers, body }));
  return { status: response.status, headers: response.headers, text: response.body, json: () => JSON.parse(response.body) };
}

// O MESMO conjunto roda nos dois modos (Fase D1.1): negotiation-api.test.js (arquivo) e negotiation-api.supabase.test.js (adapters do Supabase sobre o PostgREST falso).
const MODO = process.env.NEG_TEST_STORAGE === 'supabase' ? 'supabase' : 'arquivo';
async function ambiente(t) {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, funnels: true, crmCatalogs: true, negotiations: true, commercialStorage: MODO });
  const funil = (await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Vendas' } })).json().item;
  const etapas = [];
  for (const nome of ['Contato', 'Proposta', 'Fechamento']) etapas.push((await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${encodeURIComponent(funil.id)}/stages`, body: { nome } })).json().item);
  const cliente = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { empresa: 'Clínica Teste' } })).json().item;
  const servico = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm-catalogs/servicos', body: { nome: 'Gestão de redes', precoReferencia: 1500, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] } })).json().item;
  const corpo = (extras = {}) => ({ crmRecordId: cliente.id, funnelId: funil.id, serviceId: servico.id, prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, ...extras });
  return { env, funil, etapas, cliente, servico, corpo };
}
const criar = async (a, usuario = BRENO, extras = {}) => (await chamar(a.env, usuario, { method: 'POST', url: '/api/negotiations', body: a.corpo(extras) })).json().item;
const rota = (id, sufixo = '') => `/api/negotiations/${encodeURIComponent(id)}${sufixo}`;

test('[NEG-API-1] SEM AUTORIZAÇÃO -> 401 em toda rota; sem o Negotiation Service as rotas NÃO existem (404); método errado -> 405', async (t) => {
  const a = await ambiente(t);
  for (const [method, url] of [['GET', '/api/negotiations'], ['POST', '/api/negotiations'], ['GET', '/api/negotiations/summary'], ['GET', '/api/funnel-board'], ['GET', '/api/negotiations/x'], ['PATCH', '/api/negotiations/x'], ['POST', '/api/negotiations/x/move'], ['POST', '/api/negotiations/x/win'], ['POST', '/api/negotiations/x/lose'], ['POST', '/api/negotiations/x/reopen']]) {
    assert.equal((await chamar(a.env, null, { method, url, body: method === 'GET' ? undefined : {} })).status, 401, `${method} ${url}`);
  }
  assert.equal((await chamar(a.env, BRENO, { method: 'PUT', url: '/api/negotiations', body: {} })).status, 405);
  assert.equal((await chamar(a.env, BRENO, { method: 'DELETE', url: rota('negotiation:x') })).status, 405, 'não existe exclusão de negociação');
  assert.equal((await chamar(a.env, BRENO, { method: 'GET', url: '/api/negotiations/x/win' })).status, 405);
  const semServico = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  assert.equal((await chamar(semServico, BRENO, { url: '/api/negotiations' })).status, 404);
  assert.equal((await chamar(semServico, BRENO, { url: '/api/funnel-board' })).status, 404);
});

test('[NEG-API-2] FLUXO COMPLETO como ADMIN: criar (201, com o card no funil), listar, ler, editar (parcial), mudar de etapa, quadro, indicadores, ganhar — e o arquivo vive no diretório temporário', async (t) => {
  const a = await ambiente(t);
  const criada = await chamar(a.env, BRENO, { method: 'POST', url: '/api/negotiations', body: a.corpo() });
  assert.equal(criada.status, 201);
  const n = criada.json().item;
  assert.match(n.id, /^negotiation:/);
  assert.deepEqual([n.situacao, n.stageNome, n.servicoNome, n.responsavelNome, n.cliente], ['ABERTA', 'Contato', 'Gestão de redes', 'Breno Bento', { empresa: 'Clínica Teste' }]);
  assert.deepEqual(n.financeiro.tcv, 18000);
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations' })).json().items.length, 1);
  assert.equal((await chamar(a.env, BRENO, { url: rota(n.id) })).json().item.id, n.id);
  const editada = await chamar(a.env, BRENO, { method: 'PATCH', url: rota(n.id), body: { valorNegociado: 2000, previsaoFechamento: '2026-12-31' } });
  assert.deepEqual([editada.status, editada.json().item.valorNegociado, editada.json().item.prazoMeses, editada.json().item.eventos.length], [200, 2000, 12, 2]);
  const movida = await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/move'), body: { stageId: a.etapas[1].id, reason: 'Pediu proposta' } });
  assert.deepEqual([movida.status, movida.json().item.stageNome], [200, 'Proposta']);
  const quadro = (await chamar(a.env, BRENO, { url: '/api/funnel-board' })).json().quadro;
  assert.deepEqual([quadro.funnelId, quadro.stages.map((e) => e.nome), quadro.cards.length], [a.funil.id, ['Contato', 'Proposta', 'Fechamento'], 1]);
  assert.deepEqual(quadro.totais.map((x) => [x.cards, x.negociacoesAbertas, x.tcvEmJogo]), [[0, 0, 0], [1, 1, 24000], [0, 0, 0]]);
  const ganha = await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/win'), body: {} });
  assert.deepEqual([ganha.status, ganha.json().item.situacao], [200, 'GANHA']);
  const resumo = (await chamar(a.env, BRENO, { url: '/api/negotiations/summary' })).json().resumo;
  assert.deepEqual([resumo.ganhas.quantidade, resumo.ganhas.tcv, resumo.ganhas.mrr, resumo.abertas.quantidade, resumo.conversao.taxa], [1, 24000, 2000, 0, 1]);
  if (MODO === 'supabase') {
    // o armazenamento é o banco (falso): a negociação, o histórico (criada, atualizada, etapa, ganha) e os movimentos do card; nenhum arquivo é criado
    assert.equal(a.env.commercialDb.tabelas.crm_negotiations.size, 1);
    assert.deepEqual(a.env.commercialDb.tabelas.crm_negotiation_events.map((e) => e.tipo), ['CRIADA', 'ATUALIZADA', 'ETAPA', 'GANHA']);
    assert.equal(a.env.commercialDb.tabelas.crm_funnel_card_moves.length, 2);
    assert.equal(fs.existsSync(a.env.negotiationFilePath), false, 'nenhum arquivo de negociações no modo supabase');
    return;
  }
  // o armazenamento é o arquivo temporário (nunca data/)
  assert.equal(path.resolve(a.env.negotiationFilePath).startsWith(path.resolve(require('node:os').tmpdir())), true);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(a.env.negotiationFilePath, 'utf8')).negotiations).length, 1);
});

test('[NEG-API-3] COMMERCIAL_CLOSER trabalha na negociação (ler, criar, editar, mover, ganhar, perder e ver o quadro e os indicadores), NÃO reabre (403) e continua sem acesso à estrutura dos funis (403)', async (t) => {
  const a = await ambiente(t);
  const n = await criar(a, RAFAEL);
  assert.equal(n.responsavelNome, 'Rafael Closer', 'o responsável é o do token');
  assert.equal((await chamar(a.env, RAFAEL, { url: '/api/negotiations' })).status, 200);
  assert.equal((await chamar(a.env, RAFAEL, { url: '/api/funnel-board' })).status, 200, 'o quadro é de leitura (READ:CRM): o time inteiro o vê');
  assert.equal((await chamar(a.env, RAFAEL, { url: '/api/negotiations/summary' })).status, 200);
  assert.equal((await chamar(a.env, RAFAEL, { method: 'PATCH', url: rota(n.id), body: { valorNegociado: 1800 } })).status, 200);
  assert.equal((await chamar(a.env, RAFAEL, { method: 'POST', url: rota(n.id, '/move'), body: { stageId: a.etapas[1].id } })).status, 200);
  assert.equal((await chamar(a.env, RAFAEL, { method: 'POST', url: rota(n.id, '/lose'), body: { motivo: 'Sem orçamento' } })).status, 200);
  const reabrir = await chamar(a.env, RAFAEL, { method: 'POST', url: rota(n.id, '/reopen'), body: {} });
  assert.equal(reabrir.status, 403);
  assert.equal((await chamar(a.env, BRENO, { url: rota(n.id) })).json().item.situacao, 'PERDIDA', 'a recusa não mudou nada');
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/reopen'), body: {} })).json().item.situacao, 'ABERTA');
  assert.equal((await chamar(a.env, RAFAEL, { url: '/api/funnels' })).status, 403, 'a estrutura dos funis segue só do ADMIN (MANAGE:FUNNELS)');
  assert.equal((await chamar(a.env, RAFAEL, { method: 'POST', url: '/api/funnels', body: { nome: 'x' } })).status, 403);
});

test('[NEG-API-4] VALIDAÇÃO: 400 com CAMINHO e CÓDIGO (nunca o valor recusado); o responsável e a situação NÃO se definem pelo corpo; nada é gravado', async (t) => {
  const a = await ambiente(t);
  const casos = [
    [{ valorNegociado: 0 }, [{ path: 'valorNegociado', code: 'VALOR_INVALIDO' }]],
    [{ valorNegociado: '1500' }, [{ path: 'valorNegociado', code: 'TIPO_INVALIDO' }]],
    [{ prazoMeses: 10, periodicidade: 'TRIMESTRAL' }, [{ path: 'prazoMeses', code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' }]],
    [{ periodicidade: 'ANUAL' }, [{ path: 'periodicidade', code: 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO' }]],
    [{ crmRecordId: 'crm:nao-existe' }, [{ path: 'crmRecordId', code: 'CLIENTE_NAO_ENCONTRADO' }]],
    [{ funnelId: 'funnel:nao-existe' }, [{ path: 'funnelId', code: 'FUNIL_NAO_ENCONTRADO' }]],
    [{ serviceId: 'service:00000000-0000-4000-8000-0000000000ff' }, [{ path: 'serviceId', code: 'SERVICO_NAO_ENCONTRADO' }]],
    [{ responsavelUserId: 'user-forjado' }, [{ path: 'responsavelUserId', code: 'CAMPO_NAO_EDITAVEL' }]],
    [{ situacao: 'GANHA' }, [{ path: 'situacao', code: 'CAMPO_NAO_EDITAVEL' }]],
    [{ valorProposta: 5 }, [{ path: 'valorProposta', code: 'CAMPO_DESCONHECIDO' }]],
  ];
  for (const [extras, esperado] of casos) {
    const r = await chamar(a.env, BRENO, { method: 'POST', url: '/api/negotiations', body: a.corpo(extras) });
    assert.equal(r.status, 400, JSON.stringify(extras));
    assert.deepEqual(r.json().error, { code: 'NEGOTIATION_INVALID_INPUT', message: 'Os dados da negociação são inválidos.', details: esperado });
    assert.doesNotMatch(r.text, /forjado|1500|nao-existe/, 'o valor recusado nunca volta na resposta');
  }
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations' })).json().items.length, 0);
  assert.equal((await chamar(a.env, BRENO, { url: `/api/funnels/${encodeURIComponent(a.funil.id)}/cards` })).json().items.length, 0, 'nenhum card');
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: '/api/negotiations', body: '{ quebrado', contentType: 'application/json' })).status, 400);
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: '/api/negotiations', body: a.corpo(), contentType: 'text/plain' })).status, 415);
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: '/api/negotiations', body: [] })).status, 400);
});

test('[NEG-API-5] RECUSAS DE ESTADO E DE ROTA: inexistente é 404; editar/mover fechada é 409; ganhar duas vezes é 409; perda sem motivo é 400; corpo com campo extra em win/reopen/move/lose é 400; query desconhecida é 400', async (t) => {
  const a = await ambiente(t);
  const n = await criar(a);
  assert.equal((await chamar(a.env, BRENO, { url: rota('negotiation:nao-existe') })).status, 404);
  assert.equal((await chamar(a.env, BRENO, { method: 'PATCH', url: rota('negotiation:nao-existe'), body: { valorNegociado: 1 } })).json().error.code, 'NEGOTIATION_NOT_FOUND');
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/win'), body: { userId: 'x' } })).status, 400);
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/move'), body: { stageId: a.etapas[1].id, userId: 'x' } })).status, 400);
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/lose'), body: { motivo: 'x', permissions: ['*'] } })).status, 400);
  const semMotivo = await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/lose'), body: {} });
  assert.deepEqual([semMotivo.status, semMotivo.json().error.details], [400, [{ path: 'motivo', code: 'TIPO_INVALIDO' }]]);
  assert.deepEqual((await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/lose'), body: { motivo: '  ' } })).json().error.details, [{ path: 'motivo', code: 'OBRIGATORIO' }]);
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/win'), body: {} })).status, 200);
  const segunda = await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/win'), body: {} });
  assert.deepEqual([segunda.status, segunda.json().error.code], [409, 'NEGOTIATION_INVALID_STATE']);
  const fechada = await chamar(a.env, BRENO, { method: 'PATCH', url: rota(n.id), body: { valorNegociado: 1 } });
  assert.deepEqual([fechada.status, fechada.json().error.code], [409, 'NEGOTIATION_CLOSED']);
  assert.equal((await chamar(a.env, BRENO, { method: 'POST', url: rota(n.id, '/move'), body: { stageId: a.etapas[1].id } })).status, 409);
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations?foo=1' })).status, 400);
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations?situacao=ABERTA&situacao=GANHA' })).status, 400);
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations/summary?x=1' })).status, 400);
  assert.equal((await chamar(a.env, BRENO, { url: '/api/funnel-board?foo=1' })).status, 400);
  assert.equal((await chamar(a.env, BRENO, { url: `${rota(n.id)}?x=1` })).status, 400);
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations?situacao=GANHA' })).json().items.length, 1);
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations?situacao=ABERTA' })).json().items.length, 0);
  assert.equal((await chamar(a.env, BRENO, { url: '/api/negotiations/%E0%A4%A' })).status, 400, 'identificador malformado');
});

test('[NEG-API-6] O CARD DE UMA NEGOCIAÇÃO não se move nem se arquiva pelas rotas de CARD AVULSO (409): só pelas da negociação; o funil e a etapa continuam protegidos', async (t) => {
  const a = await ambiente(t);
  const n = await criar(a);
  const mover = await chamar(a.env, BRENO, { method: 'PATCH', url: `/api/funnel-cards/${encodeURIComponent(n.cardId)}`, body: { stageId: a.etapas[1].id } });
  assert.deepEqual([mover.status, mover.json().error.code], [409, 'FUNNEL_CARD_HAS_NEGOTIATION']);
  const arquivar = await chamar(a.env, BRENO, { method: 'DELETE', url: `/api/funnel-cards/${encodeURIComponent(n.cardId)}` });
  assert.deepEqual([arquivar.status, arquivar.json().error.code], [409, 'FUNNEL_CARD_HAS_NEGOTIATION']);
  assert.equal((await chamar(a.env, BRENO, { url: rota(n.id) })).json().item.stageNome, 'Contato');
  const card = (await chamar(a.env, BRENO, { url: `/api/funnel-cards/${encodeURIComponent(n.cardId)}` })).json().item;
  assert.equal(card.negotiationId, n.id, 'a projeção do card informa a negociação');
  assert.equal((await chamar(a.env, BRENO, { method: 'DELETE', url: `/api/funnel-stages/${encodeURIComponent(a.etapas[0].id)}` })).status, 409);
  assert.equal((await chamar(a.env, BRENO, { method: 'DELETE', url: `/api/funnels/${encodeURIComponent(a.funil.id)}` })).status, 409);
  // o cliente (registro do CRM) com negociação ativa não pode ser excluído (o card ativo o protege)
  const excluir = await chamar(a.env, BRENO, { method: 'DELETE', url: `/api/crm/${encodeURIComponent(a.cliente.id)}`, body: { reason: 'teste' } });
  assert.equal(excluir.status, 409);
  assert.equal(excluir.json().error.code, 'CRM_HAS_ACTIVE_FUNNEL_CARDS');
  // o histórico do card registra a entrada
  const historico = (await chamar(a.env, BRENO, { url: `/api/funnel-cards/${encodeURIComponent(n.cardId)}/history` })).json().historico;
  assert.equal(historico.length, 1);
});

test('[NEG-API-7] FALHAS: uma falha do armazenamento vira 503 de mensagem FIXA (sem vazar a causa); um erro inesperado é 500 sem detalhe; tudo sem tocar em outros dados', async (t) => {
  const base = montarAmbiente(t, { usuarios: [BRENO], crm: true });
  const quebrado = (erro) => ({ list: async () => { throw erro; }, get: async () => { throw erro; }, create: async () => { throw erro; }, update: async () => { throw erro; }, move: async () => { throw erro; }, win: async () => { throw erro; }, lose: async () => { throw erro; }, reopen: async () => { throw erro; }, summary: async () => { throw erro; }, board: async () => { throw erro; } });
  const persistencia = Object.assign(new Error('disco cheio: segredo-do-armazenamento'), { code: 'NEGOTIATION_PERSISTENCE' });
  const env503 = montarAmbiente(t, { usuarios: [BRENO], crm: true, negotiationService: quebrado(persistencia) });
  for (const [method, url, body] of [['GET', '/api/negotiations'], ['GET', '/api/negotiations/summary'], ['GET', '/api/funnel-board'], ['POST', '/api/negotiations', { x: 1 }], ['GET', '/api/negotiations/n1'], ['POST', '/api/negotiations/n1/win', {}]]) {
    const r = await chamar(env503, BRENO, { method, url, body });
    assert.equal(r.status, 503, `${method} ${url}`);
    assert.deepEqual(r.json().error, { code: 'NEGOTIATION_PERSISTENCE', message: 'Não foi possível ler ou gravar as negociações agora. Tente novamente em instantes.' });
    assert.doesNotMatch(r.text, /segredo|disco/);
  }
  const env500 = montarAmbiente(t, { usuarios: [BRENO], crm: true, negotiationService: quebrado(new Error('bug-interno-segredo')) });
  const r500 = await chamar(env500, BRENO, { url: '/api/negotiations' });
  assert.equal(r500.status, 500);
  assert.doesNotMatch(r500.text, /bug-interno|segredo/);
  void base;
  assert.throws(() => montarAmbiente(t, { usuarios: [BRENO], crm: true, negotiationService: { list() {} } }), /exige \{ negotiationService \} com/);
});
