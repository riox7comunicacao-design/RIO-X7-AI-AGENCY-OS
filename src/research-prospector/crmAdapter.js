// Adaptador CRM -> checagens do Prospector.
//
// O PROBLEMA QUE ESTE MÓDULO FECHA: checkDoNotContact() (doNotContact.js) só considera um registro bloqueado quando ele tem
// `doNotContact === true`, mas o CRM real representa "Não contatar" por `status === 'DO_NOT_CONTACT'` e nunca grava esse
// booleano. Passar registros reais do CRM às checagens do Prospector, sem tradução, faria um DO NOT CONTACT do CRM ser IGNORADO em
// silêncio. Aqui o registro do CRM é traduzido para o formato que as checagens existentes entendem — e as checagens em si
// (checkDuplicate / checkDoNotContact) continuam sendo as MESMAS: nenhuma lógica de comparação ou de DNC é copiada.
//
// SEGUNDO PROBLEMA (o mesmo que o domínio do CRM já resolveu em crmDomain.identityViews): identityKeys() considera só UM
// número por registro (`telefone || whatsapp`). O mesmo número guardado no campo "errado" passaria despercebido — inclusive num
// DO NOT CONTACT ("trocar de canal" nunca pode contornar o bloqueio). Por isso cada número vira uma "visão" própria; as
// funções compartilhadas comparam cada visão. Vale para os dois lados: o registro do CRM e o candidato.
//
// FALHA FECHADA: o que este módulo não sabe interpretar (registro que não é um objeto) LANÇA, em vez de ser ignorado — ignorar
// um registro poderia esconder um DO NOT CONTACT. O campo `doNotContact` já existente continua sendo respeitado (só o valor
// booleano `true`); o status DO_NOT_CONTACT do CRM também. Qualquer um dos dois bloqueia.
//
// Módulo puro: sem filesystem, sem rede, sem autorização. Não importa src/crm (R12): o literal do status vem de fora e um
// teste vigia que ele não diverge de src/crm/constants.js.

// O status do CRM que significa "Não contatar". Duplica de propósito o literal de src/crm/constants (este domínio não
// importa o CRM); tests/research-prospector/crmAdapter.test.js compara os dois.
const CRM_DNC_STATUS = 'DO_NOT_CONTACT';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Só um texto (não vazio) vale como valor de identidade; qualquer outra coisa é "ausente" (nunca converte um número em texto).
const textOrNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

// Um registro (do CRM ou um candidato) -> as visões de identidade: uma por número de telefone/WhatsApp distinto (ou uma só,
// sem número). Só os campos de identidade entram: nada mais do registro chega às checagens.
function identityViews(record) {
  const base = {
    empresa: textOrNull(hasOwn(record, 'empresa') ? record.empresa : null),
    site: textOrNull(hasOwn(record, 'site') ? record.site : null),
    instagram: textOrNull(hasOwn(record, 'instagram') ? record.instagram : null),
    cidade: textOrNull(hasOwn(record, 'cidade') ? record.cidade : null),
  };
  const numeros = [...new Set([hasOwn(record, 'telefone') ? record.telefone : null, hasOwn(record, 'whatsapp') ? record.whatsapp : null].map(textOrNull).filter(Boolean))];
  if (numeros.length === 0) return [{ ...base, telefone: null, whatsapp: null }];
  return numeros.map((numero) => ({ ...base, telefone: numero, whatsapp: null }));
}

// O registro está bloqueado para contato? Só o status do CRM ou o booleano estrito `true` — nada de "truthy" ('false', 1...).
function isDoNotContactRecord(record) {
  return record.doNotContact === true || record.status === CRM_DNC_STATUS;
}

// A lista de registros do CRM -> a lista que checkDuplicate/checkDoNotContact entendem (uma entrada por visão, cada uma
// com `doNotContact` e `crmRecordId`). Nunca altera a entrada. Um item que não é objeto lança (falha fechada).
function toProspectorRecords(crmRecords) {
  if (!Array.isArray(crmRecords)) throw new Error('registros do CRM inválidos: esperava uma lista');
  const views = [];
  crmRecords.forEach((record, index) => {
    if (!isPlainObject(record)) throw new Error(`registro do CRM inválido na posição ${index}: esperava um objeto`);
    const doNotContact = isDoNotContactRecord(record);
    const crmRecordId = textOrNull(hasOwn(record, 'id') ? record.id : null);
    for (const view of identityViews(record)) views.push({ ...view, doNotContact, crmRecordId });
  });
  return views;
}

module.exports = { CRM_DNC_STATUS, identityViews, isDoNotContactRecord, toProspectorRecords };
