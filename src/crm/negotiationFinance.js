// Cálculo FINANCEIRO COMERCIAL de uma negociação (CRM 5.0, Fase D1, decisão 0028) — funções PURAS e determinísticas: nada de relógio, de arredondamento escondido ou de dado externo.
//
// O QUE SE CALCULA (e o que NÃO se calcula):
//   TCV  (valor total do contrato): o que o cliente se compromete a pagar no prazo todo — mesmo que seja em parcelas.
//   MRR  (receita recorrente mensal): só existe para a recorrência MENSAL — é o valor de cada cobrança mensal.
//   EQUIVALENTE MENSAL: para uma recorrência trimestral, semestral ou anual, quanto cada mês "vale" (valor da cobrança ÷ meses do período). É uma
//     métrica de COMPARAÇÃO — distinta do que entra no caixa (uma cobrança anual entra inteira de uma vez). Para a mensal, é igual ao MRR.
//   VALOR RECEBIDO: NÃO é calculado aqui, nunca. Um contrato ganho NÃO significa dinheiro recebido: isso virá de eventos de pagamento (fase futura).
//
// SIGNIFICADO DO VALOR NEGOCIADO (explícito, para ninguém interpretar de dois jeitos):
//   - pagamento ÚNICO:      `valorNegociado` é o valor TOTAL do contrato (uma cobrança só) — TCV = valorNegociado.
//   - pagamento RECORRENTE: `valorNegociado` é o valor de CADA cobrança (a cada período) — TCV = valorNegociado × número de cobranças.
//
// PRAZO x PERIODICIDADE são independentes: o prazo (meses) diz por quanto tempo o contrato vale; a periodicidade diz de quanto em quanto tempo se cobra.
// REGRA EXPLÍCITA DE CRONOGRAMA (a única que esta fase define): numa recorrência, o prazo TEM de ser múltiplo dos meses da periodicidade — o número de cobranças é
// prazo ÷ meses do período, sempre inteiro. Um prazo que não fecha com a periodicidade (ex.: 10 meses cobrados a cada 3) NÃO é dividido em silêncio nem arredondado
// para "uma cobrança completa a mais ou a menos": a combinação é BLOQUEADA (`PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE`) até existir uma regra de cronograma aprovada.
//
// DURAÇÃO DO CONTRATO (Fase D3): o contrato tem duração DEFINIDA (o prazo em meses, como sempre) ou INDETERMINADA (sem data final: recorrente, renovado até alguém cancelar). Num contrato INDETERMINADO NÃO existe prazo nem número
// de cobranças: o TCV (valor total) NÃO É DETERMINADO — fica `null` (nunca zero, que seria um contrato de valor zero, e nunca um "12 meses" estimado em silêncio) e `tcvIndeterminado` é `true`. O MRR (mensal) e o equivalente
// mensal continuam valendo: dependem só do valor de cada cobrança e da periodicidade. O AVISO PRÉVIO de cancelamento (em dias) é uma condição do contrato e NÃO entra em conta nenhuma: não é duração, nem período mínimo,
// nem cobrança adicional.
//
// DINHEIRO: tudo é calculado em CENTAVOS INTEIROS (sem ponto flutuante) e só vira reais na borda. A única divisão é a do equivalente mensal, arredondada
// UMA vez, para o centavo mais próximo (meio centavo sobe) — o arredondamento é do equivalente mensal, nunca do TCV (que é exato).

const BILLING = Object.freeze({ UNICO: 'UNICO', RECORRENTE: 'RECORRENTE' });
const PERIODICITIES = Object.freeze(['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL']);
const MONTHS_PER_PERIOD = Object.freeze({ MENSAL: 1, TRIMESTRAL: 3, SEMESTRAL: 6, ANUAL: 12 });
const DURATION = Object.freeze({ DEFINIDA: 'DEFINIDA', INDETERMINADA: 'INDETERMINADA' });
const LIMITS = Object.freeze({ PRAZO_MINIMO: 1, PRAZO_MAXIMO: 120, AVISO_PREVIO_MINIMO: 1, AVISO_PREVIO_MAXIMO: 365, VALOR_MAXIMO_CENTAVOS: 100_000_000_000 }); // 1 bilhão de reais

// reais (número) -> centavos inteiros, ou null se não for um valor em reais válido (finito, > 0, até 2 casas, até o teto).
function toCents(reais) {
  if (typeof reais !== 'number' || !Number.isFinite(reais) || reais <= 0) return null;
  const cents = Math.round(reais * 100);
  if (Math.abs(reais * 100 - cents) > 1e-6) return null; // mais de duas casas: nunca se arredonda em silêncio
  if (cents < 1 || cents > LIMITS.VALOR_MAXIMO_CENTAVOS) return null;
  return cents;
}

const toReais = (cents) => (cents === null || cents === undefined ? null : cents / 100);

// Meio centavo sobe (aritmética inteira: sem erro de ponto flutuante).
const divideRoundHalfUp = (numerator, denominator) => Math.floor((2 * numerator + denominator) / (2 * denominator));

// Calcula as métricas de UMA negociação. Entrada: { duracao ('DEFINIDA' por padrão), formaPagamento, periodicidade, prazoMeses (null quando INDETERMINADA), valorNegociado (reais) }.
// Saída: { ok: true, ... } com tudo em reais e em centavos, ou { ok: false, code } — nunca lança por dado de negócio.
function computeFinance(input) {
  const { duracao = DURATION.DEFINIDA, formaPagamento, periodicidade = null, prazoMeses, valorNegociado } = input || {};
  const cents = toCents(valorNegociado);
  if (cents === null) return { ok: false, code: 'VALOR_INVALIDO' };
  if (duracao === DURATION.INDETERMINADA) return computeIndefinite({ formaPagamento, periodicidade, prazoMeses, cents });
  if (duracao !== DURATION.DEFINIDA) return { ok: false, code: 'DURACAO_INVALIDA' };
  if (!Number.isInteger(prazoMeses) || prazoMeses < LIMITS.PRAZO_MINIMO || prazoMeses > LIMITS.PRAZO_MAXIMO) return { ok: false, code: 'PRAZO_INVALIDO' };
  if (formaPagamento === BILLING.UNICO) {
    if (periodicidade !== null && periodicidade !== undefined) return { ok: false, code: 'PERIODICIDADE_NAO_PERMITIDA' };
    return build({ formaPagamento, periodicidade: null, prazoMeses, cobrancas: 1, valorPorCobrancaCents: cents, tcvCents: cents, mrrCents: null, equivalenteMensalCents: null });
  }
  if (formaPagamento === BILLING.RECORRENTE) {
    if (periodicidade === null || periodicidade === undefined) return { ok: false, code: 'PERIODICIDADE_OBRIGATORIA' };
    if (!PERIODICITIES.includes(periodicidade)) return { ok: false, code: 'PERIODICIDADE_INVALIDA' };
    const months = MONTHS_PER_PERIOD[periodicidade];
    if (prazoMeses % months !== 0) return { ok: false, code: 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' };
    const cobrancas = prazoMeses / months;
    const equivalente = months === 1 ? cents : divideRoundHalfUp(cents, months);
    return build({ formaPagamento, periodicidade, prazoMeses, cobrancas, valorPorCobrancaCents: cents, tcvCents: cents * cobrancas, mrrCents: periodicidade === 'MENSAL' ? cents : null, equivalenteMensalCents: equivalente });
  }
  return { ok: false, code: 'FORMA_PAGAMENTO_INVALIDA' };
}

// Contrato por PRAZO INDETERMINADO: só recorrente, sem prazo, sem número de cobranças e sem TCV (null). Nada é estimado.
function computeIndefinite({ formaPagamento, periodicidade, prazoMeses, cents }) {
  if (prazoMeses !== null && prazoMeses !== undefined) return { ok: false, code: 'PRAZO_PROIBIDO_NO_INDETERMINADO' };
  if (formaPagamento === BILLING.UNICO) return { ok: false, code: 'DURACAO_INDETERMINADA_EXIGE_RECORRENCIA' };
  if (formaPagamento !== BILLING.RECORRENTE) return { ok: false, code: 'FORMA_PAGAMENTO_INVALIDA' };
  if (periodicidade === null || periodicidade === undefined) return { ok: false, code: 'PERIODICIDADE_OBRIGATORIA' };
  if (!PERIODICITIES.includes(periodicidade)) return { ok: false, code: 'PERIODICIDADE_INVALIDA' };
  const months = MONTHS_PER_PERIOD[periodicidade];
  const equivalente = months === 1 ? cents : divideRoundHalfUp(cents, months);
  return build({ duracao: DURATION.INDETERMINADA, formaPagamento, periodicidade, prazoMeses: null, cobrancas: null, valorPorCobrancaCents: cents, tcvCents: null, mrrCents: periodicidade === 'MENSAL' ? cents : null, equivalenteMensalCents: equivalente });
}

function build({ duracao = DURATION.DEFINIDA, formaPagamento, periodicidade, prazoMeses, cobrancas, valorPorCobrancaCents, tcvCents, mrrCents, equivalenteMensalCents }) {
  return {
    ok: true,
    duracao,
    formaPagamento,
    periodicidade,
    prazoMeses,
    // o cronograma EXPLÍCITO: quantas cobranças, de quanto e de quantos em quantos meses (sem datas: não há data de início nesta fase)
    cronograma: Object.freeze({ cobrancas, valorPorCobranca: toReais(valorPorCobrancaCents), mesesEntreCobrancas: periodicidade === null ? null : MONTHS_PER_PERIOD[periodicidade] }),
    tcv: toReais(tcvCents),
    tcvIndeterminado: tcvCents === null,
    mrr: toReais(mrrCents),
    equivalenteMensal: toReais(equivalenteMensalCents),
    tcvCentavos: tcvCents,
    mrrCentavos: mrrCents,
    equivalenteMensalCentavos: equivalenteMensalCents,
  };
}

module.exports = { BILLING, DURATION, PERIODICITIES, MONTHS_PER_PERIOD, LIMITS, toCents, toReais, computeFinance };
