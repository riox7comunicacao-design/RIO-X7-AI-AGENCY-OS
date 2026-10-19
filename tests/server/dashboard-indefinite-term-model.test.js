// O MODELO das Negociações no Dashboard com contratos por PRAZO INDETERMINADO (dashboard/negotiation-model.mjs — CRM 5.0, Fase D3, decisão 0032): a prévia (paridade com o servidor), os corpos de criar e de
// editar (inclusive o PATCH da correção do contrato real), as mensagens, o histórico e os textos. Funções puras: nenhum DOM, rede nem dado real.

const test = require('node:test');
const assert = require('node:assert/strict');

const finance = require('../../src/crm/negotiationFinance');

const loadModel = () => import('../../dashboard/negotiation-model.mjs');
const TRAFEGO = Object.freeze({ permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'] });
const SITE = Object.freeze({ permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] });

test('[DASH-D3-1] PARIDADE da prévia com o cálculo do servidor em TODAS as combinações — duração (implícita, definida, indeterminada), forma, periodicidade, prazo e valor: mesmo ok/erro, mesmo TCV (inclusive null), MRR, equivalente mensal e cronograma', async () => {
  const m = await loadModel();
  const duracoes = [undefined, 'DEFINIDA', 'INDETERMINADA', 'ETERNA'];
  const formas = ['UNICO', 'RECORRENTE', 'OUTRA'];
  const periodicidades = [null, 'MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL', 'QUINZENAL'];
  const prazos = [null, undefined, 0, 1, 3, 10, 12, 24, 120, 121];
  const valores = [1350, 100.01, 0, -3, 1.005];
  let comparadas = 0;
  for (const duracao of duracoes) for (const formaPagamento of formas) for (const periodicidade of periodicidades) for (const prazoMeses of prazos) for (const valorNegociado of valores) {
    const entrada = { ...(duracao === undefined ? {} : { duracao }), formaPagamento, periodicidade, prazoMeses, valorNegociado };
    const servidor = finance.computeFinance(entrada);
    const tela = m.previewFinance(entrada);
    assert.equal(tela.ok, servidor.ok, JSON.stringify(entrada));
    comparadas += 1;
    if (!servidor.ok) {
      assert.equal(tela.code, servidor.code, JSON.stringify(entrada));
      continue;
    }
    assert.deepEqual([tela.tcv, tela.tcvIndeterminado, tela.mrr, tela.equivalenteMensal, tela.duracao], [servidor.tcv, servidor.tcvIndeterminado, servidor.mrr, servidor.equivalenteMensal, servidor.duracao], JSON.stringify(entrada));
    assert.deepEqual({ ...tela.cronograma }, { ...servidor.cronograma }, JSON.stringify(entrada));
  }
  assert.ok(comparadas > 1000);
});

test('[DASH-D3-2] os TEXTOS: "Prazo indeterminado", o aviso em dias, o TCV "Indeterminado" (nunca R$ 0,00), o cronograma sem número de cobranças e as condições do cartão', async () => {
  const m = await loadModel();
  const indef = { duracao: 'INDETERMINADA', prazoMeses: null, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL' };
  const antiga = { prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL' };
  assert.equal(m.durationText(indef), 'Prazo indeterminado');
  assert.equal(m.durationText(antiga), '12 meses', 'sem `duracao` (anterior à D3) vale como definida');
  assert.equal(m.durationText({ duracao: 'DEFINIDA', prazoMeses: 1 }), '1 mês');
  assert.equal(m.conditionsText(indef), 'Pagamento recorrente (mensal) · Prazo indeterminado');
  assert.equal(m.conditionsText(antiga), 'Pagamento recorrente (mensal) · 12 meses');
  assert.deepEqual([m.noticeText(30), m.noticeText(1), m.noticeText(null), m.noticeText('30')], ['30 dias', '1 dia', '', '']);
  assert.equal(m.tcvText({ tcv: null, tcvIndeterminado: true }), 'Indeterminado');
  assert.match(m.tcvText({ tcv: 16200, tcvIndeterminado: false }), /16\.200,00/);
  assert.equal(m.tcvText(null), '');
  assert.equal(m.tcvText({ tcv: null }), '', 'sem a marca de indeterminado e sem número, nada é inventado');
  const cronograma = m.previewFinance({ duracao: 'INDETERMINADA', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: null, valorNegociado: 1350 }).cronograma;
  const texto = m.scheduleText(cronograma).split(String.fromCharCode(160)).join(' ');
  assert.equal(texto, 'Cobrança de R$ 1.350,00 todo mês, por prazo indeterminado (sem número fixo de cobranças)');
  assert.match(m.scheduleText({ cobrancas: null, valorPorCobranca: 450, mesesEntreCobrancas: 3 }), /a cada 3 meses, por prazo indeterminado/);
  assert.equal(m.durationLabel('INDETERMINADA'), 'Prazo indeterminado');
  assert.equal(m.durationLabel('DEFINIDA'), 'Prazo definido');
  assert.equal(m.durationLabel('X'), '');
});

test('[DASH-D3-3] O CORPO DE CRIAR: o prazo indeterminado envia a duração e o aviso (e NÃO envia prazo); o definido segue idêntico ao de sempre (sem `duracao`, sem aviso); aviso em branco = sem aviso', async () => {
  const m = await loadModel();
  const base = { ...m.emptyFormValues('funnel:1'), crmRecordId: 'crm:1', serviceId: 'service:1', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: '1.350,00' };
  const real = m.buildCreateBody({ ...base, duracao: 'INDETERMINADA', prazoMeses: '', avisoPrevioDias: '30' }, { service: TRAFEGO });
  assert.equal(real.ok, true);
  assert.deepEqual(real.body, { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', duracao: 'INDETERMINADA', avisoPrevioDias: 30, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1350 });
  assert.equal('prazoMeses' in real.body, false);
  const semAviso = m.buildCreateBody({ ...base, duracao: 'INDETERMINADA', prazoMeses: '', avisoPrevioDias: '  ' }, { service: TRAFEGO });
  assert.equal(semAviso.ok, true);
  assert.equal('avisoPrevioDias' in semAviso.body, false);
  // um "12" que sobrou no campo de prazo NÃO vai junto de um contrato indeterminado
  assert.equal('prazoMeses' in m.buildCreateBody({ ...base, duracao: 'INDETERMINADA', prazoMeses: '12', avisoPrevioDias: '' }, { service: TRAFEGO }).body, false);
  // o definido: como sempre
  const definido = m.buildCreateBody({ ...base, prazoMeses: '12', avisoPrevioDias: '30' }, { service: TRAFEGO });
  assert.equal(definido.ok, true);
  assert.deepEqual(definido.body, { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1350 }, 'um aviso digitado e esquecido não vai com prazo definido');
});

test('[DASH-D3-4] VALIDAÇÕES do formulário antes de enviar: indeterminado com pagamento único, aviso fora de 1–365 ou não numérico, forma que o serviço não permite — por campo, em português', async () => {
  const m = await loadModel();
  const base = { ...m.emptyFormValues('funnel:1'), crmRecordId: 'crm:1', serviceId: 'service:1', duracao: 'INDETERMINADA', prazoMeses: '', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: '1.350,00', avisoPrevioDias: '30' };
  const unico = m.buildCreateBody({ ...base, formaPagamento: 'UNICO', periodicidade: '' }, { service: { ...TRAFEGO, permitePagamentoUnico: true } });
  assert.equal(unico.ok, false);
  assert.match(unico.errors.duracao, /prazo indeterminado só vale para o pagamento recorrente/i);
  for (const aviso of ['0', '366', '1000', 'abc', '3,5', '-2', '12345']) {
    const r = m.buildCreateBody({ ...base, avisoPrevioDias: aviso }, { service: TRAFEGO });
    assert.equal(r.ok, false, aviso);
    assert.match(r.errors.avisoPrevioDias, /aviso prévio em dias, um número inteiro de 1 a 365/, aviso);
  }
  assert.equal(m.buildCreateBody({ ...base, avisoPrevioDias: '365' }, { service: TRAFEGO }).ok, true);
  assert.equal(m.buildCreateBody({ ...base, avisoPrevioDias: '1' }, { service: TRAFEGO }).ok, true);
  const servico = m.buildCreateBody(base, { service: SITE });
  assert.equal(servico.ok, false);
  assert.match(servico.errors.formaPagamento, /não permite esta forma de pagamento/);
  assert.deepEqual([m.parseNotice('').value, m.parseNotice(' 30 ').value, m.parseNotice('30').ok, m.parseNotice('0').ok], [null, 30, true, false]);
});

test('[DASH-D3-5] O CORPO DA CORREÇÃO DO CONTRATO REAL (editar): de 12 meses para prazo indeterminado com aviso de 30 dias envia exatamente { duracao, prazoMeses: null, avisoPrevioDias } — o valor, a forma de pagamento e a periodicidade NÃO vão', async () => {
  const m = await loadModel();
  const atual = { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1350, previsaoFechamento: null };
  const inicial = m.formValuesFromNegotiation(atual);
  assert.deepEqual([inicial.duracao, inicial.prazoMeses, inicial.avisoPrevioDias], ['DEFINIDA', '12', '']);
  const r = m.buildPatchBody(inicial, { ...inicial, duracao: 'INDETERMINADA', prazoMeses: '', avisoPrevioDias: '30' }, { service: TRAFEGO });
  assert.equal(r.ok, true);
  assert.equal(r.empty, false);
  assert.deepEqual(r.body, { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 });
  // sem aviso prévio: a duração leva os três campos mesmo assim (o aviso vai explicitamente nulo)
  assert.deepEqual(m.buildPatchBody(inicial, { ...inicial, duracao: 'INDETERMINADA', prazoMeses: '' }, { service: TRAFEGO }).body, { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: null });
  const indefSemAviso = m.formValuesFromNegotiation({ ...atual, duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: null });
  assert.deepEqual(m.buildPatchBody(indefSemAviso, { ...indefSemAviso, duracao: 'DEFINIDA', prazoMeses: '12' }, { service: TRAFEGO }).body, { duracao: 'DEFINIDA', prazoMeses: 12, avisoPrevioDias: null });
  // abrir e salvar sem mudar nada: vazio
  assert.equal(m.buildPatchBody(inicial, { ...inicial }, { service: TRAFEGO }).empty, true);
  // já indeterminado: só o aviso muda
  const indef = m.formValuesFromNegotiation({ ...atual, duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 });
  assert.deepEqual([indef.duracao, indef.prazoMeses, indef.avisoPrevioDias], ['INDETERMINADA', '', '30']);
  assert.equal(m.buildPatchBody(indef, { ...indef }, { service: TRAFEGO }).empty, true);
  assert.deepEqual(m.buildPatchBody(indef, { ...indef, avisoPrevioDias: '45' }, { service: TRAFEGO }).body, { avisoPrevioDias: 45 });
  assert.deepEqual(m.buildPatchBody(indef, { ...indef, avisoPrevioDias: '' }, { service: TRAFEGO }).body, { avisoPrevioDias: null }, 'apagar o aviso envia null');
  // voltar para definido leva os três campos (o aviso sai)
  assert.deepEqual(m.buildPatchBody(indef, { ...indef, duracao: 'DEFINIDA', prazoMeses: '12', avisoPrevioDias: '30' }, { service: TRAFEGO }).body, { duracao: 'DEFINIDA', prazoMeses: 12, avisoPrevioDias: null });
  // voltar para definido sem prazo: erro no campo do prazo, nada enviado
  const semPrazo = m.buildPatchBody(indef, { ...indef, duracao: 'DEFINIDA', prazoMeses: '' }, { service: TRAFEGO });
  assert.equal(semPrazo.ok, false);
  assert.match(semPrazo.errors.prazoMeses, /Informe o prazo do contrato, em meses/);
  // pagamento único num contrato que vira indeterminado: recusado
  const unico = m.buildPatchBody(inicial, { ...inicial, duracao: 'INDETERMINADA', prazoMeses: '', formaPagamento: 'UNICO', periodicidade: '' }, { service: { ...TRAFEGO, permitePagamentoUnico: true } });
  assert.equal(unico.ok, false);
  assert.ok(unico.errors.duracao);
  // um contrato definido continua editando o prazo como sempre: só o prazo vai, sem `duracao`
  assert.deepEqual(m.buildPatchBody(inicial, { ...inicial, prazoMeses: '24' }, { service: TRAFEGO }).body, { prazoMeses: 24 });
});

test('[DASH-D3-6] as MENSAGENS novas (pt-BR, sem inglês, null ou undefined) e a tradução do erro da API para os campos da tela', async () => {
  const m = await loadModel();
  const codigos = [['duracao', 'DURACAO_INDETERMINADA_EXIGE_RECORRENCIA'], ['prazoMeses', 'PRAZO_PROIBIDO_NO_INDETERMINADO'], ['avisoPrevioDias', 'AVISO_PREVIO_INVALIDO'], ['avisoPrevioDias', 'AVISO_PREVIO_NAO_PERMITIDO'], ['duracao', 'VALOR_INVALIDO'], ['duracao', 'OBRIGATORIO']];
  for (const [path, code] of codigos) {
    const texto = m.fieldMessage(path, code);
    assert.ok(texto.length > 10, `${path}/${code}`);
    assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object|\b(error|invalid|required)\b/i, texto);
  }
  const { ApiError } = await import('../../dashboard/api.mjs');
  const info = m.negotiationErrorInfo(new ApiError(400, 'NEGOTIATION_INVALID_INPUT', '', [{ path: 'avisoPrevioDias', code: 'AVISO_PREVIO_INVALIDO' }, { path: 'duracao', code: 'DURACAO_INDETERMINADA_EXIGE_RECORRENCIA' }, { path: 'tcv', code: 'CAMPO_DESCONHECIDO' }]));
  assert.equal(info.kind, 'validation');
  assert.deepEqual(Object.keys(info.fields).sort(), ['avisoPrevioDias', 'duracao'], 'só os campos conhecidos da tela');
  assert.match(info.fields.avisoPrevioDias, /1 a 365/);
});

test('[DASH-D3-7] o HISTÓRICO em frases: a correção do prazo aparece com de/para legíveis (prazo definido -> indeterminado, 12 meses -> sem prazo, sem aviso -> 30 dias) e um valor inesperado nunca vira texto cru', async () => {
  const m = await loadModel();
  const texto = m.eventText({ tipo: 'ATUALIZADA', em: '2026-10-19T12:00:00.000Z', porUserId: 'u', porNome: 'Breno', detalhe: { alteracoes: [{ campo: 'prazoMeses', de: 12, para: null }, { campo: 'duracao', de: 'DEFINIDA', para: 'INDETERMINADA' }, { campo: 'avisoPrevioDias', de: null, para: 30 }] } });
  assert.equal(texto, 'Atualizada — Prazo: de 12 meses para sem prazo (indeterminado); Duração do contrato: de Prazo definido para Prazo indeterminado; Aviso prévio: de sem aviso prévio para 30 dias.');
  assert.match(m.eventText({ tipo: 'ATUALIZADA', detalhe: { alteracoes: [{ campo: 'avisoPrevioDias', de: 30, para: 45 }] } }), /Aviso prévio: de 30 dias para 45 dias/);
  assert.doesNotMatch(m.eventText({ tipo: 'ATUALIZADA', detalhe: { alteracoes: [{ campo: 'duracao', de: 'XYZ', para: {} }] } }), /XYZ|\[object|undefined|null/);
});

test('[DASH-D3-8] os campos graváveis do navegador incluem a duração e o aviso (a API do Dashboard recusa o que não está na lista), e o cliente de API deixa passar o corpo do contrato indeterminado', async () => {
  const m = await loadModel();
  assert.ok(m.WRITABLE_CREATE_FIELDS.includes('duracao') && m.WRITABLE_CREATE_FIELDS.includes('avisoPrevioDias'));
  assert.ok(m.WRITABLE_EDIT_FIELDS.includes('duracao') && m.WRITABLE_EDIT_FIELDS.includes('avisoPrevioDias'));
  const { createApiClient } = await import('../../dashboard/api.mjs');
  const enviados = [];
  const api = createApiClient({ getAccessToken: async () => 'token-de-teste-nao-real', refreshAccessToken: async () => null, onSessionLost: () => {}, fetchImpl: async (path, init) => { enviados.push([init.method, path, JSON.parse(init.body)]); return new Response('{"item":{}}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  await api.createNegotiation({ crmRecordId: 'crm:1', funnelId: 'f', serviceId: 's', duracao: 'INDETERMINADA', avisoPrevioDias: 30, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1350 });
  await api.updateNegotiation('negotiation:1', { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 });
  assert.deepEqual(enviados.map(([metodo, caminho]) => [metodo, caminho]), [['POST', '/api/negotiations'], ['PATCH', '/api/negotiations/negotiation%3A1']]);
  assert.deepEqual(enviados[1][2], { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 });
  await assert.rejects(() => api.updateNegotiation('negotiation:1', { tcv: null }), /campo não permitido/);
  await assert.rejects(() => api.createNegotiation({ crmRecordId: 'c', funnelId: 'f', serviceId: 's', mrr: 1 }), /campo não permitido/);
});
