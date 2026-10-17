// Cálculo financeiro comercial de uma negociação (src/crm/negotiationFinance.js — CRM 5.0, Fase D1): TCV, MRR e equivalente mensal, determinísticos, em centavos inteiros, com a regra
// explícita de que o prazo tem de ser múltiplo da periodicidade. Puro: nenhum relógio, arquivo ou rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const { BILLING, PERIODICITIES, MONTHS_PER_PERIOD, LIMITS, toCents, toReais, computeFinance } = require('../../src/crm/negotiationFinance');

const calc = (forma, periodicidade, prazoMeses, valorNegociado) => computeFinance({ formaPagamento: forma, periodicidade, prazoMeses, valorNegociado });

test('[NEGFIN-1] as constantes: duas formas de pagamento, as quatro periodicidades com seus meses, os limites do prazo e do valor', () => {
  assert.deepEqual({ ...BILLING }, { UNICO: 'UNICO', RECORRENTE: 'RECORRENTE' });
  assert.deepEqual([...PERIODICITIES], ['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL']);
  assert.deepEqual({ ...MONTHS_PER_PERIOD }, { MENSAL: 1, TRIMESTRAL: 3, SEMESTRAL: 6, ANUAL: 12 });
  assert.deepEqual({ ...LIMITS }, { PRAZO_MINIMO: 1, PRAZO_MAXIMO: 120, VALOR_MAXIMO_CENTAVOS: 100_000_000_000 });
  for (const objeto of [BILLING, MONTHS_PER_PERIOD, LIMITS]) assert.equal(Object.isFrozen(objeto), true);
});

test('[NEGFIN-2] dinheiro: reais viram centavos INTEIROS (sem erro de ponto flutuante); mais de duas casas, zero, negativo, texto e acima do teto são recusados — nunca arredondados em silêncio', () => {
  assert.equal(toCents(1500), 150000);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.1 + 0.2), 30, '0,1 + 0,2 vira 0,30 e não 0,30000000000000004');
  assert.equal(toCents(0.01), 1);
  assert.equal(toCents(1_000_000_000), 100_000_000_000);
  for (const ruim of [0, -1, -0.01, 10.005, 1 / 3, 1_000_000_000.01, NaN, Infinity, '100', null, undefined, {}, true]) assert.equal(toCents(ruim), null, String(ruim));
  assert.equal(toReais(150000), 1500);
  assert.equal(toReais(null), null);
});

test('[NEGFIN-3] PAGAMENTO ÚNICO: o valor negociado é o valor TOTAL do contrato (TCV); não há MRR nem equivalente mensal; uma única cobrança; o prazo vale por si só', () => {
  const r = calc('UNICO', null, 12, 6000);
  assert.deepEqual([r.ok, r.tcv, r.mrr, r.equivalenteMensal], [true, 6000, null, null]);
  assert.deepEqual({ ...r.cronograma }, { cobrancas: 1, valorPorCobranca: 6000, mesesEntreCobrancas: null });
  // o prazo é independente: qualquer prazo vale no pagamento único
  for (const prazo of [1, 2, 7, 11, 13, 120]) assert.equal(calc('UNICO', null, prazo, 6000).tcv, 6000, `prazo ${prazo}`);
  // periodicidade num pagamento único é recusada (não é ignorada em silêncio)
  assert.deepEqual(calc('UNICO', 'MENSAL', 12, 6000), { ok: false, code: 'PERIODICIDADE_NAO_PERMITIDA' });
});

test('[NEGFIN-4] RECORRENTE MENSAL: o valor é o de CADA cobrança; TCV = valor × prazo; MRR = o valor da cobrança; o equivalente mensal é igual ao MRR', () => {
  const r = calc('RECORRENTE', 'MENSAL', 12, 1500);
  assert.deepEqual([r.ok, r.tcv, r.mrr, r.equivalenteMensal], [true, 18000, 1500, 1500]);
  assert.deepEqual({ ...r.cronograma }, { cobrancas: 12, valorPorCobranca: 1500, mesesEntreCobrancas: 1 });
  assert.equal(calc('RECORRENTE', 'MENSAL', 3, 1500).tcv, 4500);
  assert.equal(calc('RECORRENTE', 'MENSAL', 1, 99.99).tcv, 99.99);
});

test('[NEGFIN-5] RECORRENTE TRIMESTRAL, SEMESTRAL e ANUAL: o TCV é valor × (prazo ÷ meses do período); o MRR NÃO existe (é null); o equivalente mensal é valor ÷ meses do período, distinto do caixa', () => {
  let r = calc('RECORRENTE', 'TRIMESTRAL', 12, 3000);
  assert.deepEqual([r.tcv, r.mrr, r.equivalenteMensal], [12000, null, 1000]);
  assert.deepEqual({ ...r.cronograma }, { cobrancas: 4, valorPorCobranca: 3000, mesesEntreCobrancas: 3 });
  r = calc('RECORRENTE', 'SEMESTRAL', 12, 6000);
  assert.deepEqual([r.tcv, r.mrr, r.equivalenteMensal], [12000, null, 1000]);
  assert.equal(r.cronograma.cobrancas, 2);
  r = calc('RECORRENTE', 'ANUAL', 12, 12000);
  assert.deepEqual([r.tcv, r.mrr, r.equivalenteMensal], [12000, null, 1000]);
  assert.equal(r.cronograma.cobrancas, 1);
  r = calc('RECORRENTE', 'ANUAL', 24, 12000);
  assert.deepEqual([r.tcv, r.cronograma.cobrancas], [24000, 2], 'prazo de 24 meses com cobrança anual = 2 cobranças');
  r = calc('RECORRENTE', 'TRIMESTRAL', 6, 3000);
  assert.deepEqual([r.tcv, r.cronograma.cobrancas], [6000, 2]);
});

test('[NEGFIN-6] REGRA EXPLÍCITA: prazo que NÃO é múltiplo da periodicidade é BLOQUEADO — nunca dividido em silêncio nem arredondado para uma cobrança cheia', () => {
  for (const [periodicidade, prazos] of [['TRIMESTRAL', [1, 2, 4, 5, 7, 8, 10, 11]], ['SEMESTRAL', [1, 3, 5, 7, 9, 10, 11]], ['ANUAL', [1, 3, 6, 11, 13, 18, 25]]]) {
    for (const prazo of prazos) assert.deepEqual(calc('RECORRENTE', periodicidade, prazo, 1000), { ok: false, code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' }, `${periodicidade} em ${prazo} meses`);
  }
  // a mensal fecha com qualquer prazo inteiro
  for (const prazo of [1, 5, 7, 11, 13, 100]) assert.equal(calc('RECORRENTE', 'MENSAL', prazo, 1000).ok, true);
});

test('[NEGFIN-7] ARREDONDAMENTO: só o equivalente mensal é arredondado (uma vez, meio centavo sobe); o TCV é sempre exato em centavos', () => {
  let r = calc('RECORRENTE', 'TRIMESTRAL', 3, 100); // 100 ÷ 3 = 33,333… -> 33,33
  assert.deepEqual([r.equivalenteMensal, r.tcv], [33.33, 100]);
  r = calc('RECORRENTE', 'TRIMESTRAL', 3, 100.01); // 100,01 ÷ 3 = 33,3366… -> 33,34
  assert.deepEqual([r.equivalenteMensal, r.tcv], [33.34, 100.01]);
  r = calc('RECORRENTE', 'SEMESTRAL', 6, 0.03); // 3 centavos ÷ 6 = 0,5 centavo -> sobe para 1
  assert.equal(r.equivalenteMensal, 0.01);
  r = calc('RECORRENTE', 'SEMESTRAL', 6, 0.02); // 2 centavos ÷ 6 = 0,33 -> 0
  assert.equal(r.equivalenteMensal, 0);
  r = calc('RECORRENTE', 'ANUAL', 12, 1000.01); // 100001 ÷ 12 = 8333,41 -> 83,33
  assert.equal(r.equivalenteMensal, 83.33);
  // o TCV de uma recorrência com muitos centavos continua exato
  assert.equal(calc('RECORRENTE', 'MENSAL', 12, 0.1 + 0.2).tcv, 3.6);
  assert.equal(calc('RECORRENTE', 'MENSAL', 120, 999999999.99).tcv, 119999999998.8);
});

test('[NEGFIN-8] PARIDADE EXAUSTIVA com um cálculo independente (BigInt): todos os prazos de 1 a 120, as quatro periodicidades e vários valores — TCV, equivalente mensal, MRR e bloqueio', () => {
  const valores = [0.01, 0.03, 0.99, 1, 33.33, 100, 100.01, 999.99, 1500, 12345.67, 999999999.99];
  let conferidos = 0;
  for (const valor of valores) {
    const centavos = BigInt(Math.round(valor * 100));
    for (const periodicidade of PERIODICITIES) {
      const meses = BigInt(MONTHS_PER_PERIOD[periodicidade]);
      for (let prazo = 1; prazo <= 120; prazo += 1) {
        const r = calc('RECORRENTE', periodicidade, prazo, valor);
        const p = BigInt(prazo);
        if (p % meses !== 0n) {
          assert.deepEqual(r, { ok: false, code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' }, `${valor} ${periodicidade} ${prazo}`);
        } else {
          const cobrancas = p / meses;
          assert.equal(BigInt(r.cronograma.cobrancas), cobrancas);
          assert.equal(BigInt(r.tcvCentavos), centavos * cobrancas, `TCV ${valor} ${periodicidade} ${prazo}`);
          assert.equal(BigInt(r.equivalenteMensalCentavos), (2n * centavos + meses) / (2n * meses), `equivalente ${valor} ${periodicidade} ${prazo}`); // piso inteiro de (2c + m) / 2m = arredondamento meio-para-cima
          assert.equal(r.mrrCentavos, periodicidade === 'MENSAL' ? Number(centavos) : null);
          assert.equal(r.tcv, r.tcvCentavos / 100);
        }
        conferidos += 1;
      }
    }
  }
  assert.equal(conferidos, 11 * 4 * 120);
});

test('[NEGFIN-9] ENTRADAS INVÁLIDAS: valor, prazo, forma e periodicidade fora do contrato são recusados com um código — o cálculo nunca lança por dado de negócio', () => {
  assert.deepEqual(calc('UNICO', null, 12, 0), { ok: false, code: 'VALOR_INVALIDO' });
  assert.deepEqual(calc('UNICO', null, 12, -5), { ok: false, code: 'VALOR_INVALIDO' });
  assert.deepEqual(calc('UNICO', null, 12, '100'), { ok: false, code: 'VALOR_INVALIDO' });
  assert.deepEqual(calc('UNICO', null, 12, 10.005), { ok: false, code: 'VALOR_INVALIDO' });
  assert.deepEqual(calc('UNICO', null, 0, 100), { ok: false, code: 'PRAZO_INVALIDO' });
  assert.deepEqual(calc('UNICO', null, 121, 100), { ok: false, code: 'PRAZO_INVALIDO' });
  assert.deepEqual(calc('UNICO', null, 6.5, 100), { ok: false, code: 'PRAZO_INVALIDO' });
  assert.deepEqual(calc('UNICO', null, '12', 100), { ok: false, code: 'PRAZO_INVALIDO' });
  assert.deepEqual(calc('PARCELADO', null, 12, 100), { ok: false, code: 'FORMA_PAGAMENTO_INVALIDA' });
  assert.deepEqual(calc(undefined, null, 12, 100), { ok: false, code: 'FORMA_PAGAMENTO_INVALIDA' });
  assert.deepEqual(calc('RECORRENTE', null, 12, 100), { ok: false, code: 'PERIODICIDADE_OBRIGATORIA' });
  assert.deepEqual(calc('RECORRENTE', 'QUINZENAL', 12, 100), { ok: false, code: 'PERIODICIDADE_INVALIDA' });
  assert.deepEqual(calc('RECORRENTE', 'mensal', 12, 100), { ok: false, code: 'PERIODICIDADE_INVALIDA' });
  assert.deepEqual(computeFinance(), { ok: false, code: 'VALOR_INVALIDO' });
  assert.deepEqual(computeFinance(null), { ok: false, code: 'VALOR_INVALIDO' });
});

test('[NEGFIN-10] o resultado é um valor SEPARADO do preço de referência e do valor legado do CRM: o cálculo só lê os quatro campos da negociação e devolve um objeto novo a cada chamada', () => {
  const entrada = Object.freeze({ formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', prazoMeses: 6, valorNegociado: 100, precoReferencia: 9999, valorProposta: 8888, valorTotal: 7777 });
  const a = computeFinance(entrada);
  const b = computeFinance(entrada);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'objetos novos');
  assert.equal(a.tcv, 600, 'o preço de referência e os valores legados nunca entram na conta');
  assert.equal(Object.keys(a).some((chave) => /recebido|pago|caixa/i.test(chave)), false, 'nada que sugira valor recebido');
  assert.equal(Object.isFrozen(a.cronograma), true);
});
