// A API de Negociações com contratos por PRAZO INDETERMINADO (rotas /api/negotiations... e /api/funnel-board — CRM 5.0, Fase D3, decisão 0032): criar, validar, editar o contrato real, o quadro e os indicadores
// com TCV indeterminado, e o RBAC. Peças REAIS: o app, a autenticação (Supabase falso na borda), o Negotiation Service, o CRM, os Funis e o Catálogo, em ARQUIVOS TEMPORÁRIOS (ou no PostgREST falso,
// no modo supabase: negotiation-indefinite-api.supabase.test.js). Dados fictícios; nenhum data/.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return req;
}
async function chamar(env, usuario, { method = 'GET', url, body } = {}) {
  const headers = {};
  if (usuario) headers.Authorization = `Bearer ${env.tokenFor(usuario.userId)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await env.app.handle(makeRequest({ method, url, headers, body }));
  return { status: response.status, text: response.body, json: () => JSON.parse(response.body) };
}

const MODO = process.env.NEG_TEST_STORAGE === 'supabase' ? 'supabase' : 'arquivo';
async function ambiente(t) {
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, funnels: true, crmCatalogs: true, negotiations: true, commercialStorage: MODO });
  const funil = (await chamar(env, BRENO, { method: 'POST', url: '/api/funnels', body: { nome: 'Vendas' } })).json().item;
  const etapas = [];
  for (const nome of ['Contato', 'Proposta']) etapas.push((await chamar(env, BRENO, { method: 'POST', url: `/api/funnels/${encodeURIComponent(funil.id)}/stages`, body: { nome } })).json().item);
  const cliente = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm', body: { tipoPessoa: 'PF', nomeCompleto: 'Cliente Pessoa Física' } })).json().item;
  const servico = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm-catalogs/servicos', body: { nome: 'Gestão de Tráfego Pago', precoReferencia: 1350, permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] } })).json().item;
  const unico = (await chamar(env, BRENO, { method: 'POST', url: '/api/crm-catalogs/servicos', body: { nome: 'Logotipo', precoReferencia: 800, permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] } })).json().item;
  const corpo = (extras = {}) => ({ crmRecordId: cliente.id, funnelId: funil.id, serviceId: servico.id, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1350, ...extras });
  return { env, funil, etapas, cliente, servico, unico, corpo };
}
const rota = (id, sufixo = '') => `/api/negotiations/${encodeURIComponent(id)}${sufixo}`;
const criar = (a, usuario = BRENO, extras = {}) => chamar(a.env, usuario, { method: 'POST', url: '/api/negotiations', body: a.corpo(extras) });

test('[NEG-D3-API-1] POST de um contrato por prazo INDETERMINADO (o caso real): 201, sem prazo, aviso prévio 30, MRR R$ 1.350,00 e TCV indeterminado — também para o COMMERCIAL_CLOSER — e a leitura devolve o mesmo', async (t) => {
  const a = await ambiente(t);
  for (const usuario of [BRENO, RAFAEL]) {
    const resposta = await criar(a, usuario, { duracao: 'INDETERMINADA', avisoPrevioDias: 30 });
    assert.equal(resposta.status, 201, usuario.nome);
    const n = resposta.json().item;
    assert.deepEqual([n.duracao, n.prazoMeses, n.avisoPrevioDias, n.formaPagamento, n.periodicidade, n.valorNegociado, n.situacao], ['INDETERMINADA', null, 30, 'RECORRENTE', 'MENSAL', 1350, 'ABERTA']);
    assert.deepEqual([n.financeiro.tcv, n.financeiro.tcvIndeterminado, n.financeiro.mrr, n.financeiro.cronograma.cobrancas], [null, true, 1350, null]);
    const lida = (await chamar(a.env, usuario, { url: rota(n.id) })).json().item;
    assert.deepEqual([lida.duracao, lida.prazoMeses, lida.avisoPrevioDias, lida.financeiro.tcv], ['INDETERMINADA', null, 30, null]);
    assert.equal(n.responsavelNome, usuario.name, 'o responsável é o do token');
  }
  const lista = (await chamar(a.env, BRENO, { url: '/api/negotiations' })).json().items;
  assert.equal(lista.length, 2);
  for (const item of lista) assert.equal(item.financeiro.tcvIndeterminado, true);
});

test('[NEG-D3-API-2] VALIDAÇÃO na borda: pagamento único, prazo junto de indeterminado, aviso fora de 1–365 / de outro tipo, aviso num contrato definido, duração desconhecida e campos que o cliente não pode mandar (tcv, mrr) -> 400 com o caminho e o código do campo, nada gravado', async (t) => {
  const a = await ambiente(t);
  const recusa = async (extras, path, code, servicoId) => {
    const r = await chamar(a.env, BRENO, { method: 'POST', url: '/api/negotiations', body: a.corpo({ ...(servicoId ? { serviceId: servicoId } : {}), ...extras }) });
    assert.equal(r.status, 400, JSON.stringify(extras));
    const detalhes = r.json().error.details || [];
    assert.ok(detalhes.some((d) => d.path === path && d.code === code), `${JSON.stringify(extras)} -> ${JSON.stringify(detalhes)}`);
    assert.doesNotMatch(r.text, /1350/, 'nunca devolve o valor recusado');
  };
  await recusa({ duracao: 'INDETERMINADA', formaPagamento: 'UNICO', periodicidade: null }, 'formaPagamento', 'FORMA_NAO_PERMITIDA_PELO_SERVICO'); // o serviço do caso não permite único
  await recusa({ duracao: 'INDETERMINADA', formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 800 }, 'duracao', 'DURACAO_INDETERMINADA_EXIGE_RECORRENCIA', a.unico.id);
  await recusa({ duracao: 'INDETERMINADA', prazoMeses: 12 }, 'prazoMeses', 'PRAZO_PROIBIDO_NO_INDETERMINADO');
  await recusa({ duracao: 'INDETERMINADA', avisoPrevioDias: 0 }, 'avisoPrevioDias', 'AVISO_PREVIO_INVALIDO');
  await recusa({ duracao: 'INDETERMINADA', avisoPrevioDias: 366 }, 'avisoPrevioDias', 'AVISO_PREVIO_INVALIDO');
  await recusa({ duracao: 'INDETERMINADA', avisoPrevioDias: '30' }, 'avisoPrevioDias', 'TIPO_INVALIDO');
  await recusa({ prazoMeses: 12, avisoPrevioDias: 30 }, 'avisoPrevioDias', 'AVISO_PREVIO_NAO_PERMITIDO');
  await recusa({}, 'prazoMeses', 'OBRIGATORIO');
  await recusa({ duracao: 'PERPETUA' }, 'duracao', 'VALOR_INVALIDO');
  await recusa({ duracao: 'INDETERMINADA', tcv: null }, 'tcv', 'CAMPO_DESCONHECIDO');
  await recusa({ duracao: 'INDETERMINADA', mrr: 1350 }, 'mrr', 'CAMPO_DESCONHECIDO');
  await recusa({ duracao: 'INDETERMINADA', tcvIndeterminado: true }, 'tcvIndeterminado', 'CAMPO_DESCONHECIDO');
  assert.deepEqual((await chamar(a.env, BRENO, { url: '/api/negotiations' })).json().items, []);
});

test('[NEG-D3-API-3] O PROCEDIMENTO da correção do contrato real pela API (o que a interface envia): PATCH { duracao, prazoMeses: null, avisoPrevioDias: 30 } mantém o ID e o histórico, grava o evento de auditoria, tira o TCV de R$ 16.200,00 e o quadro e os indicadores acompanham', async (t) => {
  const a = await ambiente(t);
  // como foi salva: 12 meses (TCV R$ 16.200,00)
  const original = (await criar(a, BRENO, { prazoMeses: 12 })).json().item;
  assert.equal(original.financeiro.tcv, 16200);
  await chamar(a.env, BRENO, { method: 'POST', url: rota(original.id, '/move'), body: { stageId: a.etapas[1].id } });
  let quadro = (await chamar(a.env, BRENO, { url: '/api/funnel-board' })).json().quadro;
  assert.deepEqual(quadro.totais.map((x) => [x.negociacoesAbertas, x.tcvEmJogo]), [[0, 0], [1, 16200]], 'antes: o TCV incorreto aparece no quadro');
  const antes = (await chamar(a.env, BRENO, { url: rota(original.id) })).json().item;

  const corrigida = await chamar(a.env, BRENO, { method: 'PATCH', url: rota(original.id), body: { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 } });
  assert.equal(corrigida.status, 200);
  const n = corrigida.json().item;
  assert.equal(n.id, original.id);
  assert.equal(n.cardId, original.cardId);
  assert.deepEqual([n.duracao, n.prazoMeses, n.avisoPrevioDias, n.valorNegociado, n.formaPagamento, n.periodicidade, n.situacao, n.stageNome], ['INDETERMINADA', null, 30, 1350, 'RECORRENTE', 'MENSAL', 'ABERTA', 'Proposta']);
  assert.deepEqual([n.financeiro.mrr, n.financeiro.tcv, n.financeiro.tcvIndeterminado], [1350, null, true]);
  assert.deepEqual(n.eventos.slice(0, antes.eventos.length), antes.eventos, 'o histórico anterior está intacto');
  const evento = n.eventos.at(-1);
  assert.deepEqual([evento.tipo, evento.porNome], ['ATUALIZADA', 'Breno Bento']);
  assert.deepEqual(Object.fromEntries(evento.detalhe.alteracoes.map((x) => [x.campo, [x.de, x.para]])), { prazoMeses: [12, null], duracao: ['DEFINIDA', 'INDETERMINADA'], avisoPrevioDias: [null, 30] });

  quadro = (await chamar(a.env, BRENO, { url: '/api/funnel-board' })).json().quadro;
  assert.deepEqual(quadro.totais.map((x) => [x.negociacoesAbertas, x.tcvEmJogo, x.tcvIndeterminadas, x.mrrEmJogo]), [[0, 0, 0, 0], [1, 0, 1, 1350]], 'depois: o TCV conhecido sai, o MRR e a contagem de indeterminados entram');
  const card = quadro.cards.find((c) => c.negotiationId === original.id);
  assert.deepEqual([card.negociacao.duracao, card.negociacao.financeiro.tcv, card.negociacao.financeiro.mrr], ['INDETERMINADA', null, 1350]);
  const resumo = (await chamar(a.env, BRENO, { url: '/api/negotiations/summary' })).json().resumo;
  assert.deepEqual([resumo.abertas.quantidade, resumo.abertas.tcv, resumo.abertas.tcvIndeterminado, resumo.abertas.mrr], [1, 0, 1, 1350]);
  assert.deepEqual(resumo.porEtapa.map((l) => [l.stageNome, l.tcv, l.tcvIndeterminadas, l.mrr]), [['Proposta', 0, 1, 1350]]);
  // o COMMERCIAL_CLOSER também pode (PROPOSE:CRM) e um PATCH repetido não grava de novo
  const repetida = await chamar(a.env, RAFAEL, { method: 'PATCH', url: rota(original.id), body: { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 } });
  assert.equal(repetida.status, 200);
  assert.equal(repetida.json().item.eventos.length, n.eventos.length, 'sem mudança real, nada novo no histórico');
});

test('[NEG-D3-API-4] QUADRO e INDICADORES com contratos misturados (definido, indeterminado mensal, indeterminado trimestral): o TCV é o CONHECIDO, os indeterminados vão à parte e nenhum número é NaN, zero de mentira ou estimativa', async (t) => {
  const a = await ambiente(t);
  await criar(a, BRENO, { prazoMeses: 12 }); // 16.200 / MRR 1.350
  await criar(a, BRENO, { duracao: 'INDETERMINADA', avisoPrevioDias: 30 }); // MRR 1.350
  await criar(a, BRENO, { duracao: 'INDETERMINADA', periodicidade: 'TRIMESTRAL' }); // equivalente 450
  const quadro = (await chamar(a.env, BRENO, { url: '/api/funnel-board' })).json().quadro;
  assert.deepEqual([quadro.totais[0].negociacoesAbertas, quadro.totais[0].tcvEmJogo, quadro.totais[0].tcvIndeterminadas, quadro.totais[0].mrrEmJogo], [3, 16200, 2, 2700]);
  const resumo = (await chamar(a.env, BRENO, { url: '/api/negotiations/summary' })).json().resumo;
  assert.deepEqual([resumo.abertas.quantidade, resumo.abertas.tcv, resumo.abertas.tcvIndeterminado, resumo.abertas.mrr, resumo.abertas.equivalenteMensalOutrasRecorrencias, resumo.abertas.semCalculo], [3, 16200, 2, 2700, 450, 0]);
  const texto = JSON.stringify({ quadro, resumo });
  assert.doesNotMatch(texto, /NaN|Infinity|undefined/);
  for (const item of quadro.cards) assert.equal(item.negociacao.financeiro === null, false, 'todo contrato tem finanças calculáveis');
});

test('[NEG-D3-API-5] sem sessão -> 401 em criar e editar com os campos novos; e o corpo continua só aceitando o contrato (o responsável e a situação nunca vêm do cliente)', async (t) => {
  const a = await ambiente(t);
  assert.equal((await chamar(a.env, null, { method: 'POST', url: '/api/negotiations', body: a.corpo({ duracao: 'INDETERMINADA' }) })).status, 401);
  const n = (await criar(a, BRENO, { duracao: 'INDETERMINADA', avisoPrevioDias: 30 })).json().item;
  assert.equal((await chamar(a.env, null, { method: 'PATCH', url: rota(n.id), body: { avisoPrevioDias: 60 } })).status, 401);
  const r = await chamar(a.env, RAFAEL, { method: 'PATCH', url: rota(n.id), body: { avisoPrevioDias: 60, responsavelUserId: 'user-x', situacao: 'GANHA' } });
  assert.equal(r.status, 400);
  const detalhes = r.json().error.details.map((d) => d.code);
  assert.ok(detalhes.includes('CAMPO_NAO_EDITAVEL'));
  assert.equal((await chamar(a.env, BRENO, { url: rota(n.id) })).json().item.avisoPrevioDias, 30, 'nada foi gravado');
  assert.equal(MODO === 'supabase' || MODO === 'arquivo', true);
});
