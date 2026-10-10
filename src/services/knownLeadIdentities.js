// IDENTIDADES JÁ CONHECIDAS (Implementação 3.0.1 — eficiência da prospecção): a lista COMPACTA do que o sistema já tem — a Approval Queue (qualquer estado) e o CRM —
// para a descoberta NÃO gastar pesquisa reencontrando empresas que o pipeline ia descartar como repetidas de qualquer jeito.
//
//   loadKnownIdentities(context, { cidade, uf? }) -> { identidades: [{ nome, cidade?, uf?, dominio?, instagram? }], fila, crm, crmIndisponivel }
//
// Só identificadores compactos (nome, cidade/UF, domínio, Instagram): nunca perfil, página, texto longo nem dado de contato. Reutiliza os normalizadores de identidade que o
// pipeline já usa (normalize.js: domínio, Instagram, nome+cidade); não cria uma segunda definição de identidade. Filtra pela cidade da busca (uma empresa de outra cidade
// não é um "repetido" desta busca) e fica de fora o que não tem identificador nenhum.
//
// Isto é um FILTRO DE ECONOMIA, não uma barreira de segurança: a deduplicação determinística do pipeline (checkDuplicate/DNC/fila) continua sendo a autoridade final.
// CLASSIFICAÇÃO DE SEGURANÇA PRESERVADA: cada identidade leva uma `categoria` INTERNA (só para os contadores do job — nunca vai ao motor de descoberta): 'dnc' (contato bloqueado no CRM
// ou item da fila em DNC), 'duplicado' (já no CRM, ou item da fila em DUPLICADO) ou 'fila' (qualquer outro item da fila). O filtro de economia não apaga essa distinção.
//
// Se o CRM não puder ser lido, segue só com a fila (crmIndisponivel = true) — a segunda barreira ainda protege.

const approvalQueueDomain = require('../research-prospector/approvalQueue');
const { normalizeDomain, normalizeInstagram, stripAccents } = require('../research-prospector/normalize');
const { isDoNotContactRecord } = require('../research-prospector/crmAdapter');

const PRIORITY = Object.freeze({ dnc: 0, duplicado: 1, fila: 2 });
const MAX_IDENTITIES = 500; // teto de segurança da lista inteira (a descoberta usa só as primeiras, ver o motor)

const plain = (value) => stripAccents(String(value == null ? '' : value)).toLowerCase().replace(/\s+/g, ' ').trim();

function compact(record, categoria) {
  const nome = typeof record.empresa === 'string' ? record.empresa.trim().slice(0, 120) : '';
  const dominio = normalizeDomain(record.site) || null;
  const instagram = normalizeInstagram(record.instagram) || null;
  if (nome === '' && !dominio && !instagram) return null;
  const cidade = typeof record.cidade === 'string' && record.cidade.trim() !== '' ? record.cidade.trim().slice(0, 60) : null;
  const uf = typeof (record.estadoUf || record.estado) === 'string' ? String(record.estadoUf || record.estado).trim().slice(0, 2).toUpperCase() : null;
  return { nome, ...(cidade ? { cidade } : {}), ...(uf ? { uf } : {}), ...(dominio ? { dominio } : {}), ...(instagram ? { instagram } : {}), categoria };
}

// queuePath: o arquivo da Approval Queue (o mesmo que os Services usam). crmService: só listRecords() (que autoriza READ:CRM de novo).
function createKnownLeadIdentities({ queuePath, crmService, approvalQueue = approvalQueueDomain } = {}) {
  if (typeof queuePath !== 'string' || queuePath.trim() === '') throw new Error('createKnownLeadIdentities exige { queuePath } (texto não vazio)');
  if (!crmService || typeof crmService.listRecords !== 'function') throw new Error('createKnownLeadIdentities exige { crmService } com listRecords()');

  return async function loadKnownIdentities(context, { cidade } = {}) {
    const wanted = plain(cidade);
    const inCity = (identity) => wanted === '' || !identity.cidade || plain(identity.cidade) === wanted;
    const out = [];
    const seen = new Map();
    const push = (identity) => {
      if (identity === null || !inCity(identity)) return;
      const key = `${plain(identity.nome)}|${identity.dominio || ''}|${identity.instagram || ''}`;
      const before = seen.get(key);
      if (before) {
        // a mesma identidade na fila e no CRM: vale a categoria MAIS RESTRITIVA (dnc > duplicado > fila) — a segurança nunca é rebaixada pelo filtro de economia
        if (PRIORITY[identity.categoria] < PRIORITY[before.categoria]) before.categoria = identity.categoria;
        return;
      }
      seen.set(key, identity);
      out.push(identity);
    };

    let fila = 0;
    const queue = approvalQueue.loadQueueFromDisk(queuePath);
    const items = Object.values(queue.items || {}).reverse(); // os mais recentes primeiro
    for (const item of items) {
      const snapshot = item && item.discoverySnapshot ? item.discoverySnapshot : {};
      const categoria = item.estado === 'DNC' ? 'dnc' : item.estado === 'DUPLICADO' ? 'duplicado' : 'fila';
      const identity = compact({ empresa: item.empresa || snapshot.empresa, cidade: snapshot.cidade, estadoUf: snapshot.estadoUf, site: snapshot.site, instagram: snapshot.instagram }, categoria);
      if (identity !== null) fila += 1;
      push(identity);
    }

    let crm = 0;
    let crmIndisponivel = false;
    try {
      const records = await crmService.listRecords(context);
      for (const record of (Array.isArray(records) ? records : []).slice().reverse()) {
        const identity = compact(record || {}, record && isDoNotContactRecord(record) ? 'dnc' : 'duplicado');
        if (identity !== null) crm += 1;
        push(identity);
      }
    } catch {
      crmIndisponivel = true;
    }
    return { identidades: out.slice(0, MAX_IDENTITIES), fila, crm, crmIndisponivel };
  };
}

module.exports = { createKnownLeadIdentities, MAX_IDENTITIES };
