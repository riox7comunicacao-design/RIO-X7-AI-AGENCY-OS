// A MESMA suíte da API de clientes PF/PJ (crm-person-api.test.js), agora com os adapters REAIS do Supabase para Funis e Negociações falando com o PostgREST FALSO (decisão 0029). O modo vem da variável abaixo,
// definida ANTES de carregar a suíte original — cada arquivo de teste roda no seu processo. Nenhuma rede; dados fictícios.

process.env.NEG_TEST_STORAGE = 'supabase';
require('./crm-person-api.test.js');
