// O modelo das Negociações no Dashboard (dashboard/negotiation-model.mjs — CRM 5.0, Fase D1): vocabulário, a prévia financeira (PARIDADE EXAUSTIVA com o servidor), os corpos de criar e editar
// (editar leva SÓ o que mudou), as mensagens por campo, a tradução dos erros da API e o texto do histórico. Funções puras: nenhum DOM, nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const server = require('../../src/crm/negotiationFinance');
const domain = require('../../src/crm/negotiationDomain');

const loadModel = () => import('../../dashboard/negotiation-model.mjs');
const loadI18n = () => import('../../dashboard/i18n/pt-BR.mjs');
const loadApi = () => import('../../dashboard/api.mjs');

const SERVICO = Object.freeze({ permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'] });
const norm = (texto) => texto.split(String.fromCharCode(160)).join(' '); // o formatador de moeda usa espaço inseparável depois do R$
const VALORES = { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', prazoMeses: '12', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: '1.500,00', previsaoFechamento: '' };

test('[NEGMODEL-1] O CONTRATO: formas, periodicidades, presets, limites e situações do Dashboard são IDÊNTICOS aos do servidor', async () => {
  const m = await loadModel();
  assert.deepEqual(m.PAYMENT_OPTIONS.map((o) => o.value), Object.values(server.BILLING));
  assert.deepEqual(m.PERIODICITY_OPTIONS.map((o) => o.value), [...server.PERIODICITIES]);
  assert.deepEqual({ ...m.MONTHS_PER_PERIOD }, { ...server.MONTHS_PER_PERIOD });
  assert.deepEqual([m.LIMITS.PRAZO_MINIMO, m.LIMITS.PRAZO_MAXIMO], [server.LIMITS.PRAZO_MINIMO, server.LIMITS.PRAZO_MAXIMO]);
  assert.deepEqual([m.LIMITS.MOTIVO_PERDA], [domain.LIMIT.MOTIVO_PERDA]);
  assert.deepEqual({ ...m.SITUATIONS }, { OPEN: domain.SITUATION.OPEN, WON: domain.SITUATION.WON, LOST: domain.SITUATION.LOST });
  assert.deepEqual([...m.TERM_PRESETS], [3, 6, 12]);
  assert.deepEqual([...m.WRITABLE_EDIT_FIELDS], [...domain.EDITABLE_FIELDS].filter((campo) => campo !== 'periodicidade').concat('periodicidade').sort((a, b) => m.WRITABLE_EDIT_FIELDS.indexOf(a) - m.WRITABLE_EDIT_FIELDS.indexOf(b)));
  for (const lista of [m.PAYMENT_OPTIONS, m.PERIODICITY_OPTIONS]) for (const o of lista) assert.ok(o.label.length > 0 && o.label !== o.value, `${o.value} tem rótulo em português`);
  assert.deepEqual([m.paymentLabel('UNICO'), m.paymentLabel('RECORRENTE'), m.paymentLabel('x')], ['Pagamento único', 'Pagamento recorrente', '']);
  assert.deepEqual([m.situationLabel('ABERTA'), m.situationLabel('GANHA'), m.situationLabel('PERDIDA'), m.situationLabel('x')], ['Aberta', 'Ganha', 'Perdida', '']);
  assert.deepEqual([m.situationTone('ABERTA'), m.situationTone('GANHA'), m.situationTone('PERDIDA')], ['info', 'ok', 'bad']);
  assert.equal(m.paymentText({ formaPagamento: 'RECORRENTE', periodicidade: 'TRIMESTRAL' }), 'Pagamento recorrente (trimestral)');
  assert.equal(m.paymentText({ formaPagamento: 'UNICO', periodicidade: null }), 'Pagamento único');
  assert.equal(m.conditionsText({ formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: 12 }), 'Pagamento recorrente (mensal) · 12 meses');
  assert.deepEqual([m.termText(1), m.termText(6), m.termText('x')], ['1 mês', '6 meses', '']);
});

test('[NEGMODEL-2] PARIDADE EXAUSTIVA da prévia financeira com src/crm/negotiationFinance.js: todas as formas, periodicidades (válidas e inválidas), prazos de 0 a 125 e valores (válidos e inválidos) dão o MESMO resultado', async () => {
  const m = await loadModel();
  const formas = ['UNICO', 'RECORRENTE', 'PARCELADO', undefined];
  const periodicidades = [null, undefined, 'MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL', 'QUINZENAL', 'mensal'];
  const prazos = [...Array.from({ length: 126 }, (_, i) => i), 6.5, -1, '12', null];
  const valores = [0.01, 0.03, 100, 100.01, 1500, 33.33, 999999999.99, 1000000000, 0, -5, 10.005, '100', null, NaN];
  let conferidos = 0;
  for (const formaPagamento of formas) {
    for (const periodicidade of periodicidades) {
      for (const prazoMeses of prazos) {
        for (const valorNegociado of valores) {
          const entrada = { formaPagamento, periodicidade, prazoMeses, valorNegociado };
          const esperado = server.computeFinance(entrada);
          const obtido = m.previewFinance(entrada);
          assert.equal(obtido.ok, esperado.ok, JSON.stringify(entrada));
          if (!esperado.ok) assert.equal(obtido.code, esperado.code, JSON.stringify(entrada));
          else assert.deepEqual([obtido.tcv, obtido.mrr, obtido.equivalenteMensal, { ...obtido.cronograma }], [esperado.tcv, esperado.mrr, esperado.equivalenteMensal, { ...esperado.cronograma }], JSON.stringify(entrada));
          conferidos += 1;
        }
      }
    }
  }
  assert.equal(conferidos, 4 * 8 * 130 * 14);
  assert.deepEqual(m.previewFinance(), { ok: false, code: 'VALOR_INVALIDO' });
});

test('[NEGMODEL-3] O CRONOGRAMA em palavras: quantas cobranças, de quanto e de quanto em quanto tempo — a regra explícita fica à vista antes de salvar', async () => {
  const m = await loadModel();
  assert.equal(norm(m.scheduleText(m.previewFinance({ formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: 12, valorNegociado: 1500 }).cronograma)), '12 cobranças de R$ 1.500,00, todo mês');
  assert.equal(norm(m.scheduleText(m.previewFinance({ formaPagamento: 'RECORRENTE', periodicidade: 'TRIMESTRAL', prazoMeses: 12, valorNegociado: 3000 }).cronograma)), '4 cobranças de R$ 3.000,00, a cada 3 meses');
  assert.equal(norm(m.scheduleText(m.previewFinance({ formaPagamento: 'RECORRENTE', periodicidade: 'ANUAL', prazoMeses: 12, valorNegociado: 12000 }).cronograma)), '1 cobrança de R$ 12.000,00, a cada 12 meses');
  assert.equal(norm(m.scheduleText(m.previewFinance({ formaPagamento: 'UNICO', prazoMeses: 6, valorNegociado: 8000 }).cronograma)), '1 cobrança de R$ 8.000,00');
  assert.equal(norm(m.scheduleText(null)), '');
});

test('[NEGMODEL-4] CRIAR: leva todos os campos obrigatórios com o valor em número e o prazo em inteiro; a periodicidade só no recorrente; confere o serviço escolhido; nada de prazo que não fecha', async () => {
  const m = await loadModel();
  const r = m.buildCreateBody(VALORES, { service: SERVICO });
  assert.deepEqual(r, { ok: true, body: { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500 }, errors: {} });
  const unico = m.buildCreateBody({ ...VALORES, formaPagamento: 'UNICO', periodicidade: 'MENSAL', previsaoFechamento: '2026-12-31' }, { service: SERVICO });
  assert.deepEqual(unico.body, { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', prazoMeses: 12, formaPagamento: 'UNICO', valorNegociado: 1500, previsaoFechamento: '2026-12-31' }, 'único: a periodicidade que sobrou no formulário NÃO vai');
  // obrigatórios
  const vazio = m.buildCreateBody(m.emptyFormValues('funnel:9'), { service: null });
  assert.equal(vazio.ok, false);
  assert.deepEqual(Object.keys(vazio.errors).sort(), ['crmRecordId', 'formaPagamento', 'serviceId', 'valorNegociado']);
  assert.equal(vazio.errors.crmRecordId, 'Escolha o cliente.');
  assert.equal(vazio.errors.valorNegociado, 'Informe o valor negociado.');
  // valor e prazo inválidos
  assert.match(m.buildCreateBody({ ...VALORES, valorNegociado: '12,345' }).errors.valorNegociado, /duas casas/);
  assert.match(m.buildCreateBody({ ...VALORES, valorNegociado: 'dez' }).errors.valorNegociado, /reais/);
  assert.match(m.buildCreateBody({ ...VALORES, valorNegociado: '0' }).errors.valorNegociado, /maior que zero/);
  assert.match(m.buildCreateBody({ ...VALORES, prazoMeses: '0' }).errors.prazoMeses, /de 1 a 120/);
  assert.match(m.buildCreateBody({ ...VALORES, prazoMeses: '121' }).errors.prazoMeses, /de 1 a 120/);
  assert.match(m.buildCreateBody({ ...VALORES, prazoMeses: '6,5' }).errors.prazoMeses, /de 1 a 120/);
  assert.equal(m.buildCreateBody({ ...VALORES, prazoMeses: '' }).errors.prazoMeses, 'Informe o prazo do contrato, em meses.');
  // a regra explícita: o prazo tem de fechar com a periodicidade
  const naoFecha = m.buildCreateBody({ ...VALORES, formaPagamento: 'RECORRENTE', periodicidade: 'TRIMESTRAL', prazoMeses: '10' }, { service: SERVICO });
  assert.equal(naoFecha.ok, false);
  assert.match(naoFecha.errors.prazoMeses, /múltiplo da periodicidade/);
  assert.equal(m.buildCreateBody({ ...VALORES, periodicidade: '' }, { service: SERVICO }).errors.periodicidade, 'Escolha a periodicidade da cobrança recorrente.');
  // o serviço escolhido manda no que se pode escolher
  const soUnico = { permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] };
  assert.equal(m.buildCreateBody(VALORES, { service: soUnico }).errors.formaPagamento, 'O serviço escolhido não permite esta forma de pagamento.');
  assert.equal(m.buildCreateBody({ ...VALORES, periodicidade: 'ANUAL', prazoMeses: '12' }, { service: SERVICO }).errors.periodicidade, 'O serviço escolhido não permite esta periodicidade.');
  assert.match(m.buildCreateBody(VALORES, { service: { permitePagamentoUnico: false, permitePagamentoRecorrente: false, periodicidades: [] } }).errors.serviceId, /ainda não tem as formas de pagamento informadas/);
  // nunca um campo fora do contrato
  for (const campo of Object.keys(r.body)) assert.ok(m.WRITABLE_CREATE_FIELDS.includes(campo), campo);
});

test('[NEGMODEL-5] EDITAR: vai SÓ o que mudou; sem mudança nada é enviado; espaços e formato do dinheiro não contam; mudar a forma ou a periodicidade leva as duas juntas; nunca reenvia o que não mudou', async () => {
  const m = await loadModel();
  const item = { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', prazoMeses: 12, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, previsaoFechamento: null };
  const inicial = m.formValuesFromNegotiation(item);
  assert.deepEqual(inicial, { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', duracao: 'DEFINIDA', prazoMeses: '12', avisoPrevioDias: '', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: '1.500,00', previsaoFechamento: '' });
  assert.equal(m.buildPatchBody(inicial, { ...inicial }, { service: SERVICO }).empty, true);
  assert.equal(m.buildPatchBody(inicial, { ...inicial, valorNegociado: '1500' }, { service: SERVICO }).empty, true, '1500 e 1.500,00 são o mesmo valor');
  assert.equal(m.buildPatchBody(inicial, { ...inicial, valorNegociado: ' 1.500,00 ' }, { service: SERVICO }).empty, true);
  const valor = m.buildPatchBody(inicial, { ...inicial, valorNegociado: '2.000,50' }, { service: SERVICO });
  assert.deepEqual([valor.ok, valor.body, valor.empty], [true, { valorNegociado: 2000.5 }, false], 'só o valor: a forma de pagamento não vai');
  const prazoEData = m.buildPatchBody(inicial, { ...inicial, prazoMeses: '24', previsaoFechamento: '2026-12-01' }, { service: SERVICO });
  assert.deepEqual(prazoEData.body, { prazoMeses: 24, previsaoFechamento: '2026-12-01' });
  const limparData = m.buildPatchBody({ ...inicial, previsaoFechamento: '2026-12-01' }, { ...inicial, previsaoFechamento: '' }, { service: SERVICO });
  assert.deepEqual(limparData.body, { previsaoFechamento: null }, 'limpar vira null');
  const periodicidade = m.buildPatchBody(inicial, { ...inicial, periodicidade: 'TRIMESTRAL' }, { service: SERVICO });
  assert.deepEqual(periodicidade.body, { formaPagamento: 'RECORRENTE', periodicidade: 'TRIMESTRAL' }, 'as duas juntas');
  const paraUnico = m.buildPatchBody(inicial, { ...inicial, formaPagamento: 'UNICO', periodicidade: '', prazoMeses: '10' }, { service: SERVICO });
  assert.deepEqual(paraUnico.body, { prazoMeses: 10, formaPagamento: 'UNICO', periodicidade: null });
  assert.equal(paraUnico.ok, true);
  // recusas antes de qualquer requisição
  assert.match(m.buildPatchBody(inicial, { ...inicial, valorNegociado: '12,345' }, { service: SERVICO }).errors.valorNegociado, /duas casas/);
  assert.match(m.buildPatchBody(inicial, { ...inicial, periodicidade: 'SEMESTRAL', prazoMeses: '12' }, { service: SERVICO }).errors.periodicidade, /não permite esta periodicidade/);
  assert.match(m.buildPatchBody(inicial, { ...inicial, periodicidade: 'TRIMESTRAL', prazoMeses: '10' }, { service: SERVICO }).errors.prazoMeses, /múltiplo/);
  // editar só o valor NUNCA reconfere o que o serviço permite hoje (o servidor também não): um serviço que mudou de regras não trava a edição de um preço
  const servicoMudou = { permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] };
  assert.equal(m.buildPatchBody(inicial, { ...inicial, valorNegociado: '1.600,00' }, { service: servicoMudou }).ok, true);
  // nunca um campo fora do contrato de edição (o cliente e o funil não se editam)
  for (const campo of Object.keys(m.buildPatchBody(inicial, { ...inicial, serviceId: 'service:2', prazoMeses: '6', valorNegociado: '1', previsaoFechamento: '2026-01-01', formaPagamento: 'UNICO', periodicidade: '' }, { service: SERVICO }).body)) assert.ok(m.WRITABLE_EDIT_FIELDS.includes(campo), campo);
});

test('[NEGMODEL-6] ERROS da API viram mensagens em português, por campo quando possível, e NUNCA repetem o valor digitado; cada situação tem o seu tipo', async () => {
  const m = await loadModel();
  const { ApiError } = await loadApi();
  const validacao = m.negotiationErrorInfo(new ApiError(400, 'NEGOTIATION_INVALID_INPUT', 'x', [{ path: 'valorNegociado', code: 'VALOR_INVALIDO' }, { path: 'prazoMeses', code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' }, { path: 'serviceId', code: 'SERVICO_INATIVO' }, { path: 'crmRecordId', code: 'CLIENTE_NAO_ENCONTRADO' }, { path: 'valorProposta', code: 'CAMPO_DESCONHECIDO' }, { path: '', code: 'TIPO_INVALIDO' }]));
  assert.equal(validacao.kind, 'validation');
  assert.deepEqual(Object.keys(validacao.fields).sort(), ['crmRecordId', 'prazoMeses', 'serviceId', 'valorNegociado'], 'um caminho desconhecido nunca vira campo');
  assert.match(validacao.fields.valorNegociado, /maior que zero/);
  assert.match(validacao.fields.prazoMeses, /múltiplo da periodicidade/);
  assert.equal(validacao.fields.serviceId, 'Este serviço está desativado e não aceita negociações novas.');
  assert.equal(m.negotiationErrorInfo(new ApiError(400, 'NEGOTIATION_INVALID_INPUT', '', [{ path: '', code: 'NADA_A_ALTERAR' }])).message, 'Nenhuma alteração foi feita.');
  assert.equal(m.negotiationErrorInfo(new ApiError(409, 'NEGOTIATION_CLOSED', '')).kind, 'closed');
  assert.deepEqual(m.negotiationErrorInfo(new ApiError(409, 'NEGOTIATION_CONFLICT', '')), { kind: 'conflict', message: m.MESSAGES.conflict, fields: {} }, 'outra pessoa gravou antes (concorrência do banco)');
  assert.match(m.MESSAGES.conflict, /alterada por outra pessoa/);
  assert.equal(m.negotiationErrorInfo(new ApiError(409, 'NEGOTIATION_INVALID_STATE', '')).kind, 'invalid-state');
  assert.equal(m.negotiationErrorInfo(new ApiError(409, 'FUNNEL_CARD_HAS_NEGOTIATION', '')).kind, 'invalid-state');
  assert.equal(m.negotiationErrorInfo(new ApiError(404, 'NEGOTIATION_NOT_FOUND', '')).kind, 'not-found');
  assert.equal(m.negotiationErrorInfo(new ApiError(403, 'FORBIDDEN', '')).kind, 'forbidden');
  assert.equal(m.negotiationErrorInfo(new ApiError(0, 'NETWORK', '')).kind, 'network');
  assert.equal(m.negotiationErrorInfo(new ApiError(503, 'NEGOTIATION_PERSISTENCE', '')).kind, 'unavailable');
  assert.equal(m.negotiationErrorInfo(new ApiError(401, 'UNAUTHENTICATED', '')), null, '401: o fluxo de login cuida');
  const interno = m.negotiationErrorInfo(new ApiError(500, 'INTERNAL', 'segredo-do-servidor'));
  assert.equal(interno.message, m.MESSAGES.generic, 'um erro desconhecido nunca repete o texto do servidor');
  assert.equal(m.negotiationErrorInfo(new Error('qualquer')).kind, 'other');
  assert.equal(m.negotiationErrorInfo(null).kind, 'other');
});

test('[NEGMODEL-7] O HISTÓRICO em frases: criada, atualizada (com de/para legíveis), mudou de etapa, ganha, perdida (com o motivo) e reaberta — e um valor inesperado nunca vira texto cru ou "undefined"', async () => {
  const m = await loadModel();
  assert.equal(m.eventText({ tipo: 'CRIADA' }), 'Negociação criada.');
  assert.equal(norm(m.eventText({ tipo: 'ATUALIZADA', detalhe: { alteracoes: [{ campo: 'valorNegociado', de: 1500, para: 2000 }, { campo: 'prazoMeses', de: 12, para: 6 }, { campo: 'periodicidade', de: 'MENSAL', para: null }] } })), 'Atualizada — Valor negociado: de R$ 1.500,00 para R$ 2.000,00; Prazo: de 12 meses para 6 meses; Periodicidade: de Mensal para vazio.');
  assert.equal(m.eventText({ tipo: 'ATUALIZADA', detalhe: { alteracoes: [{ campo: 'serviceId', de: 'a', para: 'b' }] } }), 'Atualizada — Serviço: trocado.', 'o id do serviço nunca aparece');
  assert.equal(m.eventText({ tipo: 'ETAPA', detalhe: { deEtapaNome: 'Contato', paraEtapaNome: 'Proposta', motivo: 'Pediu proposta' } }), 'Mudou de etapa: Contato → Proposta. Motivo: Pediu proposta');
  assert.equal(m.eventText({ tipo: 'ETAPA', detalhe: {} }), 'Mudou de etapa: etapa anterior → nova etapa.');
  assert.equal(m.eventText({ tipo: 'GANHA' }), 'Marcada como ganha.');
  assert.equal(m.eventText({ tipo: 'PERDIDA', detalhe: { motivo: 'Sem orçamento' } }), 'Marcada como perdida. Motivo: Sem orçamento');
  assert.equal(m.eventText({ tipo: 'REABERTA', detalhe: { de: 'PERDIDA' } }), 'Reaberta (estava perdida).');
  assert.equal(m.eventText({ tipo: 'REABERTA' }), 'Reaberta.');
  assert.equal(m.eventText({ tipo: 'ALGO' }), 'Evento registrado.');
  assert.equal(m.eventText(null), 'Evento registrado.');
  assert.equal(norm(m.eventText({ tipo: 'ATUALIZADA', detalhe: { alteracoes: [{ campo: 'formaPagamento', de: 'X', para: 'UNICO' }] } })), 'Atualizada — Forma de pagamento: de valor inválido para Pagamento único.');
});

test('[NEGMODEL-8] VOCABULÁRIO: nenhum texto do modelo contém um termo em inglês proibido, "null" ou "undefined"', async () => {
  const m = await loadModel();
  const { findForbiddenTerm } = await loadI18n();
  const textos = [...Object.values(m.MESSAGES), ...m.PAYMENT_OPTIONS.map((o) => o.label), ...m.PERIODICITY_OPTIONS.map((o) => o.label), m.situationLabel('ABERTA'), m.situationLabel('GANHA'), m.situationLabel('PERDIDA')];
  const codigos = ['OBRIGATORIO', 'CLIENTE_NAO_ENCONTRADO', 'FUNIL_NAO_ENCONTRADO', 'FUNIL_INATIVO', 'FUNIL_SEM_ETAPAS', 'SERVICO_NAO_ENCONTRADO', 'SERVICO_INATIVO', 'SERVICO_SEM_MODALIDADE', 'FORMA_NAO_PERMITIDA_PELO_SERVICO', 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO', 'PERIODICIDADE_OBRIGATORIA', 'PERIODICIDADE_NAO_PERMITIDA', 'PERIODICIDADE_INVALIDA', 'FORMA_PAGAMENTO_INVALIDA', 'PRAZO_INVALIDO', 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE', 'VALOR_INVALIDO', 'NEGATIVO', 'MAIS_DE_DUAS_CASAS', 'FORMATO_INVALIDO', 'VALOR_FORA_DO_LIMITE', 'DATA_INVALIDA', 'MUITO_LONGO', 'CARACTERE_INVALIDO', 'ETAPA_DE_OUTRO_FUNIL', 'ETAPA_DESATIVADA', 'ETAPA_NAO_ENCONTRADA', 'TIPO_INVALIDO', 'ID_INVALIDO', 'DESCONHECIDO'];
  for (const campo of ['crmRecordId', 'funnelId', 'serviceId', 'prazoMeses', 'formaPagamento', 'periodicidade', 'valorNegociado', 'previsaoFechamento', 'motivo', 'stageId', 'qualquer']) for (const codigo of codigos) textos.push(m.fieldMessage(campo, codigo));
  for (const texto of textos) {
    assert.equal(findForbiddenTerm(texto), null, texto);
    assert.doesNotMatch(texto, /\b(undefined|null|NaN|\[object)\b/, texto);
    assert.ok(texto.length > 0);
  }
});

test('[NEGMODEL-9] O QUE O SERVIÇO PERMITE é conferido ANTES de enviar (o servidor repete): único num serviço só recorrente, recorrente num serviço só único, periodicidade fora da lista e serviço sem forma de pagamento', async () => {
  const m = await loadModel();
  const soRecorrente = { permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] };
  const soUnico = { permitePagamentoUnico: true, permitePagamentoRecorrente: false, periodicidades: [] };
  const semForma = { permitePagamentoUnico: false, permitePagamentoRecorrente: false, periodicidades: [] };
  const unico = { ...VALORES, formaPagamento: 'UNICO', periodicidade: '', prazoMeses: '6', valorNegociado: '5.000,00' };
  assert.deepEqual(Object.keys(m.buildCreateBody(unico, { service: soUnico }).errors), [], 'o único num serviço que permite único passa');
  const formaProibida = m.fieldMessage('formaPagamento', 'FORMA_NAO_PERMITIDA_PELO_SERVICO');
  assert.match(formaProibida, /não permite esta forma de pagamento/);
  assert.equal(m.buildCreateBody(unico, { service: soRecorrente }).errors.formaPagamento, formaProibida);
  assert.equal(m.buildCreateBody(VALORES, { service: soUnico }).errors.formaPagamento, formaProibida);
  assert.equal(m.buildCreateBody({ ...VALORES, periodicidade: 'TRIMESTRAL' }, { service: soRecorrente }).errors.periodicidade, m.fieldMessage('periodicidade', 'PERIODICIDADE_NAO_PERMITIDA_PELO_SERVICO'));
  assert.equal(m.buildCreateBody(VALORES, { service: semForma }).errors.serviceId, m.fieldMessage('serviceId', 'SERVICO_SEM_MODALIDADE'));
  assert.equal(m.buildCreateBody(VALORES, { service: soRecorrente }).ok, true);
  // e na edição: trocar a forma de pagamento confere o serviço; editar só o valor não reconfere (o servidor decide)
  const inicial = m.formValuesFromNegotiation({ crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', prazoMeses: 6, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1500, previsaoFechamento: null });
  assert.equal(m.buildPatchBody(inicial, { ...inicial, formaPagamento: 'UNICO', periodicidade: '' }, { service: soRecorrente }).errors.formaPagamento, formaProibida);
  assert.equal(m.buildPatchBody(inicial, { ...inicial, valorNegociado: '1.600,00' }, { service: semForma }).ok, true);
});
