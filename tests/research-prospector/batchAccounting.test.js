// Contabilidade de lote (src/research-prospector/batchAccounting.js): função pura e determinística.
//
// O que estes testes provam: "encontrado" não é "válido"; pedir N é buscar N VÁLIDOS; o que passa disso é reserva; o que falta é
// a diferença; DNC, duplicados, insuficientes, rejeitados e expirados nunca contam; nada depende da ordem nem de qualquer coisa
// que o candidato declare além do estado operacional; estados desconhecidos lançam (falha fechada); e não existe score, ranking
// nem temperatura.

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBatchAccounting, BATCH_BUCKET, MAX_DESIRED } = require('../../src/research-prospector/batchAccounting');
const { OPERATIONAL_STATE } = require('../../src/research-prospector/discovery');
const { QUEUE_STATE } = require('../../src/research-prospector/approvalQueue');

const S = OPERATIONAL_STATE;
const cand = (...estados) => estados.map((estadoOperacional) => ({ estadoOperacional }));
const repetir = (estado, n) => Array.from({ length: n }, () => ({ estadoOperacional: estado }));
const contar = (quantidadeDesejada, candidatos) => computeBatchAccounting({ quantidadeDesejada, candidatos });

test('[LOTE-1] zero candidatos: nada encontrado, nada válido, e falta a quantidade inteira', () => {
  assert.deepEqual(contar(100, []), {
    quantidadeDesejada: 100,
    encontrados: 0,
    validos: 0,
    aguardandoRevisao: 0,
    dadosInsuficientes: 0,
    possiveisDuplicados: 0,
    duplicados: 0,
    dnc: 0,
    rejeitados: 0,
    expirados: 0,
    principal: 0,
    reserva: 0,
    falta: 100,
    metaAtingida: false,
  });
});

test('[LOTE-2] menos válidos que o pedido: o principal é o que há, a reserva é zero e falta a diferença', () => {
  const resultado = contar(100, repetir(S.VALIDADO_PARA_REVISAO, 37));
  assert.equal(resultado.validos, 37);
  assert.equal(resultado.principal, 37);
  assert.equal(resultado.reserva, 0);
  assert.equal(resultado.falta, 63);
  assert.equal(resultado.metaAtingida, false);
});

test('[LOTE-3] exatamente a quantidade pedida: principal completo, nada de reserva, nada falta', () => {
  const resultado = contar(100, repetir(S.VALIDADO_PARA_REVISAO, 100));
  assert.deepEqual([resultado.principal, resultado.reserva, resultado.falta, resultado.metaAtingida], [100, 0, 0, true]);
});

test('[LOTE-4] acima da quantidade: o principal fica em 100 e o que passa é RESERVA (para substituir duplicados, inválidos e rejeitados)', () => {
  const resultado = contar(100, repetir(S.VALIDADO_PARA_REVISAO, 112));
  assert.deepEqual([resultado.validos, resultado.principal, resultado.reserva, resultado.falta, resultado.metaAtingida], [112, 100, 12, 0, true]);
});

test('[LOTE-5] encontrado NÃO é válido: DNC, duplicados, possíveis duplicados, dados insuficientes, aguardando revisão, rejeitados e expirados nunca contam para a quantidade', () => {
  const candidatos = [
    ...repetir(S.DNC, 3),
    ...repetir(S.DUPLICADO, 4),
    ...repetir(S.POSSIVEL_DUPLICADO, 2),
    ...repetir(S.DADOS_INSUFICIENTES, 5),
    ...repetir(S.AGUARDANDO_REVISAO, 6),
    ...repetir(QUEUE_STATE.REJEITADO, 7),
    ...repetir(QUEUE_STATE.EXPIRADO, 1),
  ];
  const resultado = contar(10, candidatos);
  assert.deepEqual(
    { ...resultado },
    {
      quantidadeDesejada: 10,
      encontrados: 28,
      validos: 0,
      aguardandoRevisao: 6,
      dadosInsuficientes: 5,
      possiveisDuplicados: 2,
      duplicados: 4,
      dnc: 3,
      rejeitados: 7,
      expirados: 1,
      principal: 0,
      reserva: 0,
      falta: 10,
      metaAtingida: false,
    }
  );
});

test('[LOTE-6] combinação de estados: só VALIDADO_PARA_REVISAO e APROVADO_PARA_CRM (já aprovado por um humano) contam; os totais fecham (a soma das categorias é sempre o encontrado)', () => {
  const candidatos = [
    ...repetir(S.VALIDADO_PARA_REVISAO, 8),
    ...repetir(QUEUE_STATE.APROVADO_PARA_CRM, 4),
    ...repetir(S.AGUARDANDO_REVISAO, 3),
    ...repetir(S.DNC, 2),
    ...repetir(S.DUPLICADO, 2),
    ...repetir(S.POSSIVEL_DUPLICADO, 1),
    ...repetir(S.DADOS_INSUFICIENTES, 2),
    ...repetir(QUEUE_STATE.REJEITADO, 3),
  ];
  const r = contar(10, candidatos);
  assert.equal(r.encontrados, 25);
  assert.equal(r.validos, 12);
  assert.equal(r.principal, 10);
  assert.equal(r.reserva, 2);
  assert.equal(r.falta, 0);
  const soma = r.validos + r.aguardandoRevisao + r.dadosInsuficientes + r.possiveisDuplicados + r.duplicados + r.dnc + r.rejeitados + r.expirados;
  assert.equal(soma, r.encontrados, 'nada some e nada é contado duas vezes');
  assert.equal(r.principal + r.reserva, r.validos);
});

test('[LOTE-7] sem quantidade pedida (ausente ou null): não há meta — nada falta, nada é reserva, e o principal é o que é válido', () => {
  for (const q of [undefined, null]) {
    const r = contar(q, [...repetir(S.VALIDADO_PARA_REVISAO, 3), ...repetir(S.DNC, 1)]);
    assert.deepEqual([r.quantidadeDesejada, r.principal, r.reserva, r.falta, r.metaAtingida, r.validos, r.encontrados], [null, 3, 0, null, null, 3, 4]);
  }
  assert.equal(computeBatchAccounting({ candidatos: [] }).falta, null);
});

test('[LOTE-8] quantidade desejada inválida lança: zero, negativo, fracionário, texto, NaN, Infinity, objeto e acima do máximo (nunca é "consertada")', () => {
  for (const q of [0, -1, 1.5, '100', NaN, Infinity, -Infinity, {}, [], true, MAX_DESIRED + 1]) {
    assert.throws(() => contar(q, []), /quantidadeDesejada/, String(q));
  }
  assert.equal(contar(1, []).falta, 1);
  assert.equal(contar(MAX_DESIRED, []).falta, MAX_DESIRED);
});

test('[LOTE-9] falha fechada: candidatos que não são lista, itens que não são objeto, sem estado ou com estado desconhecido LANÇAM — nunca contam como válidos nem somem', () => {
  for (const c of [undefined, null, {}, 'x', 5]) assert.throws(() => contar(10, c), /lista/);
  assert.throws(() => computeBatchAccounting(), /lista/);
  for (const item of [null, undefined, 'VALIDADO_PARA_REVISAO', 5, [], {}, { estado: 'VALIDADO_PARA_REVISAO' }, { estadoOperacional: undefined }, { estadoOperacional: null }, { estadoOperacional: 5 }, { estadoOperacional: 'valido' }, { estadoOperacional: 'VALIDADO' }, { estadoOperacional: 'validado_para_revisao' }, { estadoOperacional: ' VALIDADO_PARA_REVISAO' }, { estadoOperacional: 'constructor' }, { estadoOperacional: '__proto__' }, { estadoOperacional: 'toString' }]) {
    assert.throws(() => contar(10, [...cand(S.VALIDADO_PARA_REVISAO), item]), /posição 1/, JSON.stringify(item));
  }
});

test('[LOTE-10] só o estado operacional conta: o candidato não consegue se declarar válido (valido, aprovado, score, temperatura, ranking e qualquer outra propriedade são ignorados)', () => {
  const r = contar(5, [
    { estadoOperacional: S.DNC, valido: true, aprovado: true, score: 100, temperatura: 'QUENTE', ranking: 1, statusIdentidade: { status: 'VALIDADA' } },
    { estadoOperacional: S.DADOS_INSUFICIENTES, estadoOperacionalDiscovery: S.VALIDADO_PARA_REVISAO },
    { estadoOperacional: S.VALIDADO_PARA_REVISAO, doNotContact: true },
  ]);
  assert.deepEqual([r.validos, r.dnc, r.dadosInsuficientes], [1, 1, 1]);
});

test('[LOTE-11] determinística e pura: a ordem dos candidatos não muda nada, a entrada não é alterada, o resultado é sempre novo e não há score, ranking nem temperatura', () => {
  const candidatos = [...repetir(S.VALIDADO_PARA_REVISAO, 4), ...repetir(S.DNC, 2), ...repetir(S.DUPLICADO, 1), ...repetir(S.AGUARDANDO_REVISAO, 3)];
  const copia = JSON.stringify(candidatos);
  const a = contar(3, candidatos);
  const b = contar(3, [...candidatos].reverse());
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(candidatos), copia);
  assert.notEqual(contar(3, candidatos), a);
  assert.deepEqual(contar(3, candidatos), a, 'as mesmas entradas dão sempre o mesmo resultado');
  for (const proibida of ['score', 'ranking', 'temperatura', 'melhor', 'nota', 'prioridade', 'ordem', 'indices', 'candidatos']) assert.equal(proibida in a, false, proibida);
  assert.deepEqual(Object.keys(a).sort(), ['aguardandoRevisao', 'dadosInsuficientes', 'dnc', 'duplicados', 'encontrados', 'expirados', 'falta', 'metaAtingida', 'possiveisDuplicados', 'principal', 'quantidadeDesejada', 'rejeitados', 'reserva', 'validos']);
});

test('[LOTE-12] o vocabulário é o que já existe: cada estado do discovery e da fila que importa está mapeado; o de outro lote (uma categoria nova) exige decidir aqui', () => {
  assert.deepEqual(Object.keys(BATCH_BUCKET).sort(), [...Object.values(S), QUEUE_STATE.APROVADO_PARA_CRM, QUEUE_STATE.REJEITADO, QUEUE_STATE.EXPIRADO].sort());
  for (const estado of Object.values(QUEUE_STATE)) assert.equal(typeof BATCH_BUCKET[estado], 'string', `estado da fila ${estado} sem categoria`);
  assert.equal(BATCH_BUCKET[S.VALIDADO_PARA_REVISAO], 'validos');
  assert.equal(BATCH_BUCKET[QUEUE_STATE.APROVADO_PARA_CRM], 'validos');
  for (const bloqueado of [S.DNC, S.DUPLICADO, S.POSSIVEL_DUPLICADO, S.DADOS_INSUFICIENTES, S.AGUARDANDO_REVISAO, QUEUE_STATE.REJEITADO, QUEUE_STATE.EXPIRADO]) {
    assert.notEqual(BATCH_BUCKET[bloqueado], 'validos', `${bloqueado} nunca é válido`);
  }
});

test('[LOTE-13] o módulo é puro: sem filesystem, rede, processo nem autorização', () => {
  const fs = require('node:fs');
  const codigo = fs.readFileSync(require.resolve('../../src/research-prospector/batchAccounting.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const proibido of [/require\((['"])(node:)?(fs|http|https|net|child_process|path)\1\)/, /\bfetch\(/, /process\./, /Date\b/, /Math\.random/]) assert.doesNotMatch(codigo, proibido, String(proibido));
});
