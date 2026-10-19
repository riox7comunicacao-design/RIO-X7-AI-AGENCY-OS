// O MESMO conjunto de negotiationIndefiniteTerm.test.js, agora com os adapters REAIS do Supabase falando com o PostgREST FALSO (com a D3 aplicada). O modo vem da variável abaixo, definida ANTES de carregar a suíte
// original — cada arquivo de teste roda no seu processo. Nenhuma rede; dados fictícios.

process.env.NEG_TEST_STORAGE = 'supabase';
require('./negotiationIndefiniteTerm.test.js');
