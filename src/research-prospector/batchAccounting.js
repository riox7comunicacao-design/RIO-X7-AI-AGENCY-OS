// Contabilidade de um LOTE de prospecção — função pura, determinística, sem filesystem, sem rede, sem autorização.
//
// Dado o que o usuário pediu (`quantidadeDesejada`) e o estado operacional de cada candidato encontrado, diz quantos há em
// cada situação, quantos contam para a quantidade pedida (o lote PRINCIPAL), quantos sobram (a RESERVA, para substituir
// duplicados, inválidos ou rejeitados) e quanto FALTA.
//
// REGRA CENTRAL: "encontrado" NÃO é "válido". Só conta para a quantidade pedida quem já tem identidade VALIDADA e dados
// SUFICIENTES e nenhum bloqueio (VALIDADO_PARA_REVISAO), ou quem um humano já aprovou (APROVADO_PARA_CRM). Quem aguarda
// revisão com dados parciais, quem tem dados insuficientes, possível duplicidade, duplicidade, DNC, rejeição ou expiração NÃO
// conta. Pedir 100 é buscar 100 VÁLIDOS; o que passar disso é reserva.
//
// O QUE ESTA FUNÇÃO NÃO É: não aprova nada (aprovação é humana e fica na fila), não calcula score, nota, ranking, temperatura
// nem "melhor lead", e não ordena candidatos: só conta. A única coisa que ela lê de cada candidato é `estadoOperacional`; qualquer
// outra propriedade (inclusive uma que se declare "válida") é ignorada. Um estado que ela não conhece LANÇA (falha fechada):
// nunca é contado como válido nem some da conta.

const { OPERATIONAL_STATE } = require('./discovery');
const { QUEUE_STATE } = require('./approvalQueue');

const MAX_DESIRED = 100000;

// O vocabulário aceito é o que já existe: os estados operacionais do discovery e os estados da fila que uma decisão humana ou o
// tempo produzem. Nenhum termo novo.
const BATCH_BUCKET = Object.freeze({
  [OPERATIONAL_STATE.VALIDADO_PARA_REVISAO]: 'validos',
  [QUEUE_STATE.APROVADO_PARA_CRM]: 'validos',
  [OPERATIONAL_STATE.AGUARDANDO_REVISAO]: 'aguardandoRevisao',
  [OPERATIONAL_STATE.DADOS_INSUFICIENTES]: 'dadosInsuficientes',
  [OPERATIONAL_STATE.POSSIVEL_DUPLICADO]: 'possiveisDuplicados',
  [OPERATIONAL_STATE.DUPLICADO]: 'duplicados',
  [OPERATIONAL_STATE.DNC]: 'dnc',
  [QUEUE_STATE.REJEITADO]: 'rejeitados',
  [QUEUE_STATE.EXPIRADO]: 'expirados',
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDesired(quantidadeDesejada) {
  if (quantidadeDesejada === undefined || quantidadeDesejada === null) return null;
  if (typeof quantidadeDesejada !== 'number' || !Number.isInteger(quantidadeDesejada) || quantidadeDesejada < 1 || quantidadeDesejada > MAX_DESIRED) {
    throw new Error(`quantidadeDesejada deve ser um número inteiro entre 1 e ${MAX_DESIRED}`);
  }
  return quantidadeDesejada;
}

// candidatos: [{ estadoOperacional }]. quantidadeDesejada: inteiro >= 1, ou ausente (sem meta: nada "falta", nada é reserva).
function computeBatchAccounting({ quantidadeDesejada, candidatos } = {}) {
  const desejada = readDesired(quantidadeDesejada);
  if (!Array.isArray(candidatos)) throw new Error('candidatos deve ser uma lista');

  const counts = {
    validos: 0,
    aguardandoRevisao: 0,
    dadosInsuficientes: 0,
    possiveisDuplicados: 0,
    duplicados: 0,
    dnc: 0,
    rejeitados: 0,
    expirados: 0,
  };
  candidatos.forEach((candidato, index) => {
    if (!isPlainObject(candidato) || !hasOwn(candidato, 'estadoOperacional')) {
      throw new Error(`candidato inválido na posição ${index}: esperava um objeto com estadoOperacional`);
    }
    const estado = candidato.estadoOperacional;
    if (typeof estado !== 'string' || !hasOwn(BATCH_BUCKET, estado)) {
      throw new Error(`candidato inválido na posição ${index}: estadoOperacional desconhecido`);
    }
    counts[BATCH_BUCKET[estado]] += 1;
  });

  const validos = counts.validos;
  return {
    quantidadeDesejada: desejada,
    encontrados: candidatos.length,
    ...counts,
    principal: desejada === null ? validos : Math.min(validos, desejada),
    reserva: desejada === null ? 0 : Math.max(0, validos - desejada),
    falta: desejada === null ? null : Math.max(0, desejada - validos),
    metaAtingida: desejada === null ? null : validos >= desejada,
  };
}

module.exports = { BATCH_BUCKET, MAX_DESIRED, computeBatchAccounting };
