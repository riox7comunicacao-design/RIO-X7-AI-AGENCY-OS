// Cálculo financeiro dos contratos por PRAZO INDETERMINADO (src/crm/negotiationFinance.js — CRM 5.0, Fase D3, decisão 0032) e a compatibilidade com os contratos de duração definida. Funções puras:
// nenhum relógio, rede, arquivo nem dado real.

const test = require('node:test');
const assert = require('node:assert/strict');

const { BILLING, DURATION, PERIODICITIES, MONTHS_PER_PERIOD, LIMITS, computeFinance } = require('../../src/crm/negotiationFinance');

const indeterminado = (extras = {}) => computeFinance({ duracao: 'INDETERMINADA', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: null, valorNegociado: 1350, ...extras });
const definido = (extras = {}) => computeFinance({ formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: 12, valorNegociado: 1350, ...extras });

test('[NEGFIN-D3-1] o contrato REAL (recorrente mensal, R$ 1.350,00, prazo indeterminado): MRR R$ 1.350,00, TCV INDETERMINADO (null — nunca zero nem 12 meses), sem número de cobranças', () => {
  const r = indeterminado();
  assert.equal(r.ok, true);
  assert.deepEqual([r.duracao, r.prazoMeses, r.mrr, r.mrrCentavos, r.equivalenteMensal], ['INDETERMINADA', null, 1350, 135000, 1350]);
  assert.equal(r.tcv, null, 'TCV indeterminado é null');
  assert.equal(r.tcvCentavos, null);
  assert.equal(r.tcvIndeterminado, true);
  assert.notEqual(r.tcv, 0, 'nunca zero (um contrato de valor zero)');
  assert.notEqual(r.tcv, 16200, 'nunca o 12 meses estimado em silêncio');
  assert.deepEqual({ ...r.cronograma }, { cobrancas: null, valorPorCobranca: 1350, mesesEntreCobrancas: 1 }, 'sem quantidade total de parcelas inventada');
});

test('[NEGFIN-D3-2] prazo indeterminado em TODAS as periodicidades: TCV sempre indeterminado; o MRR só na mensal; o equivalente mensal (arredondado uma vez, meio centavo sobe) nas demais', () => {
  const esperado = { MENSAL: [1350, 1350], TRIMESTRAL: [null, 450], SEMESTRAL: [null, 225], ANUAL: [null, 112.5] };
  for (const periodicidade of PERIODICITIES) {
    const r = indeterminado({ periodicidade });
    assert.equal(r.ok, true, periodicidade);
    assert.equal(r.tcv, null, `${periodicidade}: TCV indeterminado`);
    assert.equal(r.tcvIndeterminado, true);
    assert.deepEqual([r.mrr, r.equivalenteMensal], esperado[periodicidade], periodicidade);
    assert.equal(r.cronograma.cobrancas, null);
    assert.equal(r.cronograma.mesesEntreCobrancas, MONTHS_PER_PERIOD[periodicidade]);
  }
  // meio centavo sobe (ex.: R$ 100,01 por trimestre = 33,3366… -> 33,34; R$ 0,10 por trimestre = 3,33…)
  assert.equal(indeterminado({ periodicidade: 'TRIMESTRAL', valorNegociado: 100.01 }).equivalenteMensal, 33.34);
  assert.equal(indeterminado({ periodicidade: 'ANUAL', valorNegociado: 0.01 }).equivalenteMensalCentavos, 0, 'um centavo por ano: o equivalente mensal arredonda para zero centavos (é só uma métrica de comparação)');
});

test('[NEGFIN-D3-3] o aviso prévio NÃO entra em conta nenhuma: o resultado é o mesmo com ou sem ele (ele nem é entrada do cálculo)', () => {
  const sem = indeterminado();
  const com = computeFinance({ duracao: 'INDETERMINADA', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: null, valorNegociado: 1350, avisoPrevioDias: 30 });
  assert.deepEqual(com, sem);
  assert.equal(JSON.stringify(com).includes('aviso'), false);
});

test('[NEGFIN-D3-4] REGRAS do prazo indeterminado: só recorrente; sem prazo em meses; periodicidade obrigatória e válida; valor válido', () => {
  assert.deepEqual(indeterminado({ formaPagamento: 'UNICO', periodicidade: null }), { ok: false, code: 'DURACAO_INDETERMINADA_EXIGE_RECORRENCIA' });
  assert.deepEqual(indeterminado({ formaPagamento: 'OUTRA' }), { ok: false, code: 'FORMA_PAGAMENTO_INVALIDA' });
  assert.deepEqual(indeterminado({ prazoMeses: 12 }), { ok: false, code: 'PRAZO_PROIBIDO_NO_INDETERMINADO' });
  assert.deepEqual(indeterminado({ prazoMeses: 0 }), { ok: false, code: 'PRAZO_PROIBIDO_NO_INDETERMINADO' }, 'nem zero: indeterminado não tem prazo');
  assert.deepEqual(indeterminado({ periodicidade: null }), { ok: false, code: 'PERIODICIDADE_OBRIGATORIA' });
  assert.deepEqual(indeterminado({ periodicidade: 'QUINZENAL' }), { ok: false, code: 'PERIODICIDADE_INVALIDA' });
  for (const valorNegociado of [0, -1, 1350.005, Number.NaN, '1350', null]) assert.deepEqual(indeterminado({ valorNegociado }), { ok: false, code: 'VALOR_INVALIDO' }, String(valorNegociado));
  assert.deepEqual(computeFinance({ duracao: 'PERPETUA', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: null, valorNegociado: 1 }), { ok: false, code: 'DURACAO_INVALIDA' });
});

test('[NEGFIN-D3-5] COMPATIBILIDADE: sem `duracao` o contrato é de duração DEFINIDA e o cálculo é o de sempre — TCV = valor × cobranças, em todas as periodicidades e no pagamento único', () => {
  const casos = [
    [{ formaPagamento: 'UNICO', periodicidade: null, prazoMeses: 6, valorNegociado: 5000 }, { tcv: 5000, mrr: null, cobrancas: 1 }],
    [{ formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: 12, valorNegociado: 1350 }, { tcv: 16200, mrr: 1350, cobrancas: 12 }],
    [{ formaPagamento: 'RECORRENTE', periodicidade: 'TRIMESTRAL', prazoMeses: 12, valorNegociado: 1350 }, { tcv: 5400, mrr: null, cobrancas: 4 }],
    [{ formaPagamento: 'RECORRENTE', periodicidade: 'SEMESTRAL', prazoMeses: 24, valorNegociado: 1350 }, { tcv: 5400, mrr: null, cobrancas: 4 }],
    [{ formaPagamento: 'RECORRENTE', periodicidade: 'ANUAL', prazoMeses: 36, valorNegociado: 1350 }, { tcv: 4050, mrr: null, cobrancas: 3 }],
  ];
  for (const [entrada, esperado] of casos) {
    const implicito = computeFinance(entrada);
    const explicito = computeFinance({ ...entrada, duracao: 'DEFINIDA' });
    assert.deepEqual(explicito, implicito, 'DEFINIDA explícita = implícita');
    assert.equal(implicito.ok, true);
    assert.deepEqual([implicito.tcv, implicito.mrr, implicito.cronograma.cobrancas, implicito.tcvIndeterminado, implicito.duracao], [esperado.tcv, esperado.mrr, esperado.cobrancas, false, 'DEFINIDA']);
  }
});

test('[NEGFIN-D3-6] as regras do prazo DEFINIDO continuam: prazo obrigatório (1 a 120), múltiplo da periodicidade, único sem periodicidade — e o prazo ausente NÃO vira indeterminado em silêncio', () => {
  assert.deepEqual(definido({ prazoMeses: null }), { ok: false, code: 'PRAZO_INVALIDO' }, 'duração definida sem prazo é erro (indeterminado é uma escolha explícita)');
  assert.deepEqual(definido({ prazoMeses: undefined }), { ok: false, code: 'PRAZO_INVALIDO' });
  assert.deepEqual(definido({ prazoMeses: 0 }), { ok: false, code: 'PRAZO_INVALIDO' });
  assert.deepEqual(definido({ prazoMeses: LIMITS.PRAZO_MAXIMO + 1 }), { ok: false, code: 'PRAZO_INVALIDO' });
  assert.deepEqual(definido({ periodicidade: 'TRIMESTRAL', prazoMeses: 10 }), { ok: false, code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' });
  assert.deepEqual(computeFinance({ formaPagamento: 'UNICO', periodicidade: 'MENSAL', prazoMeses: 12, valorNegociado: 1 }), { ok: false, code: 'PERIODICIDADE_NAO_PERMITIDA' });
  assert.equal(DURATION.DEFINIDA, 'DEFINIDA');
  assert.equal(DURATION.INDETERMINADA, 'INDETERMINADA');
  assert.equal(BILLING.RECORRENTE, 'RECORRENTE');
});

test('[NEGFIN-D3-7] o TCV de um contrato definido NUNCA é null e o de um indeterminado NUNCA é um número — para toda combinação (a representação é inequívoca)', () => {
  for (const periodicidade of PERIODICITIES) {
    for (const prazoMeses of [12, 24, 36, 60, 120]) {
      const d = computeFinance({ formaPagamento: 'RECORRENTE', periodicidade, prazoMeses, valorNegociado: 123.45 });
      if (d.ok) assert.equal(typeof d.tcv, 'number', `${periodicidade}/${prazoMeses}`);
    }
    assert.equal(indeterminado({ periodicidade, valorNegociado: 123.45 }).tcv, null);
  }
});

test('[NEGFIN-D3-8] os CÓDIGOS de erro novos cabem no que a API devolve ao navegador (só A–Z e _, até 40 caracteres: um código maior viraria "INVALIDO" e a tela perderia a mensagem certa)', () => {
  const codigos = [
    indeterminado({ formaPagamento: 'UNICO' }).code,
    indeterminado({ prazoMeses: 12 }).code,
    computeFinance({ duracao: 'X', formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: null, valorNegociado: 1 }).code,
    'AVISO_PREVIO_INVALIDO',
    'AVISO_PREVIO_NAO_PERMITIDO',
  ];
  for (const codigo of codigos) assert.match(codigo, /^[A-Z_]{1,40}$/, codigo);
});
