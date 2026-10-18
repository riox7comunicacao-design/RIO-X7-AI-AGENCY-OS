'use strict';

// PostgREST FALSO para a tabela crm_records — USO SOMENTE EM TESTES (src/ nunca importa este arquivo). Fase H3.2.
//
// Imita o que importa para a LEITURA da lista: ordem por `seq`, `limit`/`offset`, o TETO de linhas por resposta do servidor (db-max-rows, padrão 1000,
// que vale mesmo quando o pedido NÃO traz `limit`), `Prefer: count=exact` com o total no Content-Range e o 206 quando a resposta é parcial. Também
// aceita o upsert do save() e a leitura por id. Nenhuma rede, nenhum Supabase, nenhuma chave real; todos os dados são fictícios.
//
// `aoResponder(n, init, api)` (opcional) pode devolver uma resposta pronta para a n-ésima requisição (falhas, corpos inválidos, mudanças no meio da
// leitura); devolvendo `null`/`undefined` o servidor responde normalmente. `corpoFixo` responde SEMPRE o mesmo texto.

const { recordToRow } = require('../../src/crm-adapters/crmSupabaseMapping');

const idDe = (i) => `crm:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

const registro = (overrides = {}) => ({
  id: idDe(0), status: 'PROSPECT', dataDeEntrada: '2026-09-27T10:00:00.000Z',
  historico: [{ timestamp: '2026-09-27T10:00:00.000Z', from: null, to: 'PROSPECT', actor: 'HUMAN', reviewedBy: null, motivo: null }],
  empresa: 'Empresa Fictícia', contato: null, cargo: null, telefone: null, whatsapp: null, email: null, site: null, instagram: null, facebook: null,
  googlePerfil: null, cidade: null, estado: null, nicho: null, origem: null, temperatura: null, servicoPotencial: null, problemaIdentificado: null,
  raioXDeNicho: null, raioXPersonalizado: null, statusDoDiagnostico: null, linkDoRaioX: null, dataDaAnalise: null, dataDaReuniao: null, linkDoMeet: null,
  proximaAcao: null, dataDaProximaAcao: null, responsavel: null, ultimaInteracao: null, valorProposta: null, valorTotal: null, observacoes: null,
  tipoPessoa: null, nomeCompleto: null, cpf: null, cnpj: null,
  ...overrides,
});

// `n` registros de enchimento, cada um com identidade própria (nenhum coincide com outro nem com os candidatos dos testes).
const enchimento = (n, deslocamento = 0) =>
  Array.from({ length: n }, (_, i) => registro({ id: idDe(i + 1 + deslocamento), empresa: `Empresa Enchimento ${i + 1 + deslocamento}`, site: `enchimento-${i + 1 + deslocamento}.example.test` }));

function resposta(status, corpo, cabecalhos = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (nome) => cabecalhos[String(nome).toLowerCase()] ?? null },
    text: async () => (corpo === undefined ? '' : typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
  };
}

function postgrestCrm({ linhas = [], maxRows = 1000, corpoFixo, statusFixo, aoResponder } = {}) {
  const tabela = new Map();
  let seq = 0;
  for (const r of linhas) tabela.set(r.id, { ...recordToRow(r), seq: ++seq, version: 1, updated_at: '2026-10-01T00:00:00Z' });
  const chamadas = [];
  const api = {
    chamadas,
    tabela,
    // as linhas (formato do banco) na ordem de seq
    linhas: () => [...tabela.values()].sort((a, b) => a.seq - b.seq),
    fetchImpl: async (url, init) => {
      const u = new URL(String(url));
      chamadas.push({ metodo: init.method, caminho: u.pathname, query: Object.fromEntries(u.searchParams), prefer: (init.headers && init.headers.Prefer) ?? null, init });
      const pronta = aoResponder ? aoResponder(chamadas.length, init, api) : null;
      if (pronta) return pronta;
      if (corpoFixo !== undefined) return resposta(statusFixo ?? 200, corpoFixo);
      if (init.method === 'POST') {
        for (const row of JSON.parse(init.body)) tabela.set(row.id, { ...(tabela.get(row.id) || { seq: ++seq, version: 1, updated_at: 'x' }), ...row });
        return resposta(201, undefined);
      }
      let todas = api.linhas();
      const id = u.searchParams.get('id');
      if (id) todas = todas.filter((r) => r.id === id.replace(/^eq\./, ''));
      const offset = Number(u.searchParams.get('offset') || 0);
      const pedido = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : Infinity;
      const fatia = todas.slice(offset, offset + Math.min(pedido, maxRows));
      const contar = /count=exact/.test((init.headers && init.headers.Prefer) || '');
      const total = contar ? String(todas.length) : '*';
      const faixa = fatia.length ? `${offset}-${offset + fatia.length - 1}/${total}` : `*/${total}`;
      const parcial = contar && offset + fatia.length < todas.length;
      return resposta(parcial ? 206 : 200, fatia, { 'content-range': faixa });
    },
  };
  return api;
}

module.exports = { postgrestCrm, registro, enchimento, idDe, resposta };
