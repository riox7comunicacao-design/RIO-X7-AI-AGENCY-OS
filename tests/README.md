# Filosofia de Testes

Cada módulo do projeto deve possuir, documentado explicitamente:

- **Objetivo** — o que o módulo deve fazer.
- **Teste** — como foi testado.
- **Resultado** — o que aconteceu no teste.
- **Falhas** — o que não funcionou.
- **Correções** — o que foi ajustado.
- **Limitações** — o que o módulo não cobre.
- **Status** — estado atual do módulo.

## Status possíveis

- **IMPLEMENTADO** — o código/documento existe, mas ainda não foi testado de ponta a ponta.
- **TESTADO E FUNCIONANDO** — houve execução real com evidência de que funciona conforme o objetivo.
- **AINDA NÃO TESTADO** — existe apenas como plano ou rascunho.

## Princípio

Nunca declarar um módulo como 100% funcionando sem evidência real de teste.

## Como rodar os testes

**Suíte comum — `npm test`.** Hermética: roda sem credenciais e **sem acesso externo**. Cada processo de teste carrega `tests/setup/hermetic.js` (`node --require`), que remove `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e `RIO_X7_TEST_ACCESS_TOKEN` do ambiente, **bloqueia** qualquer conexão, DNS ou processo `claude` fora do computador local (erro `ERR_TEST_NETWORK_BLOCKED`) e, se `NETGUARD_LOG` apontar para um arquivo, registra cada tentativa — um log vazio é a evidência de que nada tentou sair. O `npm test` **não carrega o `.env`**. `tests/scripts/hermetic-suite.test.js` prova tudo isso.

**Integração externa — `npm run test:integration`.** Os testes em `tests/integration/` falam com o Supabase Auth **real** (somente leitura) e **não** fazem parte do `npm test`. Só executam com autorização explícita e configuração própria: um `.env` com as credenciais do ambiente que você autoriza consultar **e** `RIO_X7_RUN_EXTERNAL_TESTS=1`; sem a variável, todos são **pulados** (nunca "passando" sem terem sido exercitados).

- PowerShell: `$env:RIO_X7_RUN_EXTERNAL_TESTS = '1'; npm run test:integration`
- Bash: `RIO_X7_RUN_EXTERNAL_TESTS=1 npm run test:integration`

Nenhum valor de URL, chave ou token é impresso; nada é escrito no Supabase. Teste novo que precisa de um serviço real vai para `tests/integration/` (com o mesmo portão `autorizado(t)`), nunca para a suíte comum.
