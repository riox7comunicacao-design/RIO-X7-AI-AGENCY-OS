// A MESMA suíte do Funnel Service (funnelService.test.js) com o adapter REAL do Supabase falando com o PostgREST FALSO (Fase D1.1, decisão 0029). O modo vem da variável abaixo, definida ANTES de carregar a suíte
// original — cada arquivo de teste roda no seu processo. Nenhuma rede; dados fictícios.

process.env.NEG_TEST_STORAGE = 'supabase';
require('./funnelService.test.js');
