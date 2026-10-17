'use strict';

// O ARMAZENAMENTO das entidades comerciais (Funis, Etapas, Cards, Negociações) nos DOIS MODOS, para os mesmos testes rodarem nos dois (CRM 5.0, Fase D1.1, decisão 0029):
//   - modo "arquivo" (padrão): os repositórios em MEMÓRIA do projeto (o mesmo contrato do adaptador de arquivo) — só desenvolvimento isolado e testes;
//   - modo "supabase": os adapters REAIS de src/crm-adapters/ falando com o PostgREST FALSO (tests/helpers/fakePostgrestCommercial.js), que emula as regras da migration.
// O modo vem da variável NEG_TEST_STORAGE=supabase, que o arquivo `*.supabase.test.js` de cada suíte define ANTES de carregar a suíte original (cada arquivo de teste roda no seu processo).
// Dados fictícios; nenhuma rede; nenhum arquivo de data/.

const { createInMemoryFunnelRepository } = require('../../src/crm/funnelRepository');
const { createInMemoryNegotiationRepository } = require('../../src/crm/negotiationRepository');
const { createSupabaseFunnelRepository } = require('../../src/crm-adapters/crmSupabaseFunnelRepository');
const { createSupabaseNegotiationRepository } = require('../../src/crm-adapters/crmSupabaseNegotiationRepository');
const { criarPostgrestComercial } = require('./fakePostgrestCommercial');

const MODO = process.env.NEG_TEST_STORAGE === 'supabase' ? 'supabase' : 'arquivo';
const URL_FALSA = 'https://exemplo-teste.supabase.co';
const CHAVE_FALSA = 'chave-de-servico-falsa-so-para-teste';

// { referencias }: 'livres' (padrão; o banco falso não confere cliente/serviço — a conferência fica com o domínio) ou 'estritas' (as FKs e as regras de cliente/serviço do SQL valem).
function criarArmazenamento({ modo = MODO, referencias = 'livres', fakeOptions = {} } = {}) {
  if (modo === 'supabase') {
    const db = criarPostgrestComercial({ referencias, ...fakeOptions });
    const funnelRepository = createSupabaseFunnelRepository({ url: URL_FALSA, serviceRoleKey: CHAVE_FALSA, fetchImpl: db.fetchImpl });
    const negotiationRepository = createSupabaseNegotiationRepository({ url: URL_FALSA, serviceRoleKey: CHAVE_FALSA, fetchImpl: db.fetchImpl });
    return { modo, db, funnelRepository, negotiationRepository };
  }
  return { modo, db: null, funnelRepository: createInMemoryFunnelRepository(), negotiationRepository: createInMemoryNegotiationRepository() };
}

module.exports = { MODO, criarArmazenamento, URL_FALSA, CHAVE_FALSA };
