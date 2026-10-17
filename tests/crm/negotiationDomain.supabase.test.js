// A MESMA suíte do domínio de Negociações (negotiationDomain.test.js), agora com os adapters REAIS do Supabase falando com o PostgREST FALSO (Fase D1.1, decisão 0029). O modo vem da variável
// abaixo, definida ANTES de carregar a suíte original — cada arquivo de teste roda no seu processo, então um modo não vaza para o outro. Nenhuma rede; dados fictícios.

process.env.NEG_TEST_STORAGE = 'supabase';
require('./negotiationDomain.test.js');
