// Ponto de entrada da HOSPEDAGEM (Hostinger Web Apps: "arquivo de entrada" = server.js). Não contém lógica: só carrega o servidor e chama main(), que lê TUDO do ambiente do painel
// (RIO_X7_DEPLOYMENT_MODE, HOST, PORT, SUPABASE_*, REPOSITORY_MODE, RIO_X7_USERS_JSON, RIO_X7_PUBLIC_URL...) — veja docs/operations/web-hostinger.md.
//
// Não inicia nada duplicado: `node src/server/index.js` (npm start, uso local) e este arquivo chegam ao MESMO main(), que sobe um único servidor por processo. Nenhuma rotina de teste, de
// preparação de dados ou de migração roda aqui.

const { main } = require('./src/server/index');

main();
