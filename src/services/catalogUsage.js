// O CONTADOR DE USO dos catálogos pelo CRM LEGADO (CRM 5.0, Fase 2B-1, decisão 0026) — a função `countUsage` que o Catalog Service
// recebe por injeção (src/services/catalogService.js).
//
//   createCrmCatalogUsageCounter({ crmRepository }) -> async (catalogo, item) => número de registros do CRM que usam o item
//
// POR QUE EXISTE: nesta fase os campos `nicho`, `origem` e `servicoPotencial` do registro do CRM continuam TEXTO e guardam o NOME do
// item. O Catalog Service recusa renomear um item que algum registro usa, e para saber isso precisa contar. Um registro "usa" um item
// quando o texto do campo, NORMALIZADO (a mesma normalização do nome — minúsculas, sem acento, sem pontuação), é igual ao nome
// normalizado do item: "Estética", "estetica" e " ESTÉTICA " são o mesmo uso.
//
// LIMITES (de propósito): só LÊ o repositório BRUTO do CRM (list) e devolve só um NÚMERO — nenhum dado de registro sai daqui, e nada é
// gravado. Não passa pelo CRM Service (não há um usuário a autorizar: é uma verificação interna do sistema, como `hasActiveFunnelCards`).
// O repositório é o MESMO que o CRM usa (a composição o passa de createConfiguredCrmRepository), então vale para arquivo e Supabase.

const { CATALOG_DEFINITIONS } = require('../crm/catalogConstants');
const { normalizeCatalogName } = require('../crm/catalogDomain');

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function createCrmCatalogUsageCounter({ crmRepository } = {}) {
  if (!crmRepository || typeof crmRepository.list !== 'function') {
    throw new Error('createCrmCatalogUsageCounter exige { crmRepository } (com list)');
  }
  return async function countUsage(catalogKey, item) {
    if (typeof catalogKey !== 'string' || !hasOwn(CATALOG_DEFINITIONS, catalogKey)) throw new Error(`catálogo desconhecido: ${String(catalogKey)}`);
    const field = CATALOG_DEFINITIONS[catalogKey].legacyField;
    const target = item && typeof item.nomeNormalizado === 'string' && item.nomeNormalizado !== '' ? item.nomeNormalizado : normalizeCatalogName(item && item.nome);
    if (target === '') return 0;
    const records = await crmRepository.list();
    if (!Array.isArray(records)) throw new Error('o repositório do CRM devolveu uma lista inválida');
    let count = 0;
    for (const record of records) {
      const value = record && typeof record === 'object' && hasOwn(record, field) ? record[field] : null;
      if (typeof value === 'string' && normalizeCatalogName(value) === target) count += 1;
    }
    return count;
  };
}

module.exports = { createCrmCatalogUsageCounter };
