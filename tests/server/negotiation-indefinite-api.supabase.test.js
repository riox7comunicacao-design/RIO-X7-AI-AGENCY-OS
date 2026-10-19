// O MESMO conjunto de negotiation-indefinite-api.test.js com os adapters do Supabase sobre o PostgREST FALSO (D3 aplicada). Nenhuma rede; dados fictícios.

process.env.NEG_TEST_STORAGE = 'supabase';
require('./negotiation-indefinite-api.test.js');
