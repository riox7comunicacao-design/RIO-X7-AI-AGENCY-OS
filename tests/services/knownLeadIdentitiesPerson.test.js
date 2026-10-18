// Prospecção x clientes PF/PJ (CRM 5.0, Fase D2): a lista de identidades JÁ CONHECIDAS que a descoberta recebe (src/services/knownLeadIdentities.js) continua só com EMPRESAS e canais públicos. O nome completo de uma
// PESSOA FÍSICA (cliente do CRM) nunca é entregue ao motor de descoberta — que fala com uma IA externa —, e uma PF sem site nem Instagram simplesmente não entra. Os registros antigos e as PJ seguem como sempre.
// Sem rede, sem arquivo de data/, dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createKnownLeadIdentities } = require('../../src/services/knownLeadIdentities');

const base = (extras) => ({ id: 'crm:x', status: 'PROSPECT', empresa: null, nomeCompleto: null, tipoPessoa: null, cidade: null, site: null, instagram: null, estado: null, ...extras });

function carregador(registros) {
  const crmService = { listRecords: async () => registros };
  return createKnownLeadIdentities({ queuePath: 'fila-de-teste.json', crmService, approvalQueue: { loadQueueFromDisk: () => ({ items: {} }) } });
}

test('[KNOWN-PERSON-1] empresas (PJ e registro antigo) entram pelo nome; uma PF só entra pelos canais PÚBLICOS (site/Instagram) e NUNCA pelo nome completo', async () => {
  const registros = [
    base({ id: 'crm:antigo', empresa: 'Estúdio Dias', cidade: 'Niterói' }),
    base({ id: 'crm:pj', tipoPessoa: 'PJ', empresa: 'Clínica Aurora', cidade: 'Petrópolis' }),
    base({ id: 'crm:pf-com-site', tipoPessoa: 'PF', nomeCompleto: 'Maria Souza', site: 'https://maria-souza.example.test', cidade: 'Niterói' }),
    base({ id: 'crm:pf-sem-canal', tipoPessoa: 'PF', nomeCompleto: 'João Pereira' }),
  ];
  const { identidades, crm } = await carregador(registros)({ userId: 'u' }, {});
  const texto = JSON.stringify(identidades);
  assert.ok(texto.includes('Estúdio Dias'));
  assert.ok(texto.includes('Clínica Aurora'));
  assert.equal(texto.includes('Maria Souza'), false, 'o nome completo da PF não vai ao motor de descoberta');
  assert.equal(texto.includes('João Pereira'), false);
  const doSite = identidades.find((identidade) => identidade.dominio === 'maria-souza.example.test');
  assert.ok(doSite, 'o site público da PF ainda conta (evita redescobrir o mesmo canal)');
  assert.equal(doSite.nome, '', 'sem nome');
  assert.equal(crm, 3, 'a PF sem nenhum canal público não gera identidade');
  assert.equal(identidades.length, 3);
});
