// "Esqueci minha senha?" e a redefinição pelo link do e-mail (dashboard/passwordRecovery.mjs + main.mjs + router.mjs), sobre o DOM de teste e um SDK do Supabase FALSO.
//
// Causa do defeito que isto cobre: o painel criava o SDK com detectSessionInUrl: false e é roteado por #, então o link do e-mail
// (…/#access_token=…&type=recovery) nunca era lido — caía no login. Não havia também nenhum "Esqueci minha senha?".
//
// Nenhum e-mail é enviado, nenhuma credencial é real: todo e-mail, senha e token abaixo são placeholders óbvios que só existem no SDK falso.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authConstants = require('../../src/auth/constants');
const { createBrowser, findAll, makeEvent } = require('../helpers/fakeDom');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const ROOT = path.join(__dirname, '..', '..');

const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const ME_ADMIN = { userId: 'user-breno', name: 'Breno', role: 'ADMIN', permissions: [...authConstants.getRolePermissions('ADMIN')], status: 'ACTIVE' };
const EMAIL = 'pessoa-de-teste@example.test';
const SENHA_NOVA = 'NovaSenha2026';
const TOKEN = 'TOKEN-DE-ACESSO-DE-TESTE-NAO-REAL';
const REFRESH = 'TOKEN-DE-RENOVACAO-DE-TESTE-NAO-REAL';
const LINK_OK = `#access_token=${TOKEN}&expires_in=3600&refresh_token=${REFRESH}&token_type=bearer&type=recovery`;
const LINK_VENCIDO = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

async function iniciar({ session = null, hash = '', search = '', routes = {}, sdkOptions = {}, clock } = {}) {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, scriptedFetch, FAKE_SESSION } = await loadFixtures();
  const browser = createBrowser({ hash, search });
  const sdk = createFakeSdk({ session: session === true ? FAKE_SESSION : session, ...sdkOptions });
  const fetchImpl = scriptedFetch({ 'GET /config.json': CONFIG, ...routes });
  const navigation = browserNavigation(browser.window);
  const options = { document: browser.document, root: browser.root, fetchImpl, sdk, navigation };
  if (clock) options.clock = clock;
  await startDashboard(options);
  await browser.flush();
  return { browser, sdk, fetchImpl, navigation };
}

const texto = (browser) => {
  const t = browser.root.textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(t, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
  return t;
};
const chamadasDeApi = (fetchImpl) => fetchImpl.calls.filter((chamada) => chamada.path.startsWith('/api/'));
// tudo o que a pessoa (ou um script) consegue ler na página: textos e valores de atributos
const tudoQueEstaNaPagina = (browser) => {
  const partes = [browser.root.textContent];
  for (const element of findAll(browser.root, () => true)) {
    for (const valor of element.attributes.values()) partes.push(valor);
    if (typeof element.value === 'string') partes.push(element.value);
  }
  partes.push(browser.window.location.hash, browser.window.location.search);
  return partes.join('\n');
};
// só o aviso da tela (as mensagens), sem o texto de apoio do cabeçalho
const aviso = (browser) => browser.by.cls(browser.root, 'message').map((e) => e.textContent).join(' ');
const botao = (browser, rotulo) => browser.by.button(browser.root, rotulo);
const campo = (browser, rotulo) => browser.by.label(browser.root, rotulo);

async function pedirLink(t, email = EMAIL) {
  t.browser.type(campo(t.browser, 'E-mail'), email);
  t.browser.click(botao(t.browser, 'Enviar link de recuperação'));
  await t.browser.flush();
}
async function preencherNovaSenha(t, senha, confirmacao = senha) {
  t.browser.type(campo(t.browser, 'Nova senha'), senha);
  t.browser.type(campo(t.browser, 'Confirmar nova senha'), confirmacao);
  t.browser.click(botao(t.browser, 'Definir nova senha'));
  await t.browser.flush();
}

// ===========================================================================
// 1. O botão na tela de login
// ===========================================================================
test('[RECOV-1] a tela de login mostra "Esqueci minha senha?" logo abaixo do campo Senha, entre o campo e o botão Entrar', async () => {
  const t = await iniciar();
  const link = botao(t.browser, 'Esqueci minha senha?');
  assert.ok(link, 'o botão existe e é visível na tela de login');
  assert.equal(link.type, 'button', 'não envia o formulário de login');
  const ordem = findAll(t.browser.root, (e) => ['input', 'button'].includes(e.localName)).map((e) => e.id || e.textContent);
  assert.deepEqual(ordem, ['login-email', 'login-password', 'Esqueci minha senha?', 'Entrar'], 'e-mail, senha, o link, e só então Entrar');
  assert.deepEqual(chamadasDeApi(t.fetchImpl), []);
});

test('[RECOV-2] clicar abre "Recuperar acesso" (e-mail, "Enviar link de recuperação", "Voltar ao login"), leva o e-mail digitado e "Voltar ao login" devolve o login que ainda funciona', async () => {
  const t = await iniciar({ routes: { 'GET /api/me': ME_ADMIN } });
  t.browser.type(campo(t.browser, 'E-mail'), EMAIL);
  t.browser.click(botao(t.browser, 'Esqueci minha senha?'));
  await t.browser.flush();
  assert.match(texto(t.browser), /Recuperar acesso/);
  assert.equal(campo(t.browser, 'E-mail').value, EMAIL, 'o e-mail já digitado vem junto');
  assert.ok(botao(t.browser, 'Enviar link de recuperação'));
  assert.ok(botao(t.browser, 'Voltar ao login'));
  assert.equal(t.browser.by.tag(t.browser.root, 'nav').length, 0, 'nenhuma tela do painel');
  assert.equal(t.sdk.calls.resetPassword.length, 0, 'abrir a tela não envia nada');

  t.browser.click(botao(t.browser, 'Voltar ao login'));
  await t.browser.flush();
  assert.ok(campo(t.browser, 'Senha'), 'voltou ao login');
  // o login normal continua funcionando
  t.browser.type(campo(t.browser, 'E-mail'), EMAIL);
  t.browser.type(campo(t.browser, 'Senha'), 'senha-de-teste-nao-real');
  t.browser.click(botao(t.browser, 'Entrar'));
  await t.browser.flush();
  assert.equal(t.sdk.calls.signIn.length, 1);
  assert.ok(t.browser.by.tag(t.browser.root, 'nav').length > 0, 'o painel abriu');
});

// ===========================================================================
// 2. Pedir o link
// ===========================================================================
test('[RECOV-3] o pedido chama resetPasswordForEmail com a raiz do painel (sem # nem ?) como redirecionamento e mostra "Verifique seu e-mail" sem revelar se o e-mail existe', async () => {
  const t = await iniciar();
  t.browser.click(botao(t.browser, 'Esqueci minha senha?'));
  await t.browser.flush();
  await pedirLink(t);
  assert.deepEqual(t.sdk.calls.resetPassword, [{ email: EMAIL, options: { redirectTo: 'http://localhost:3000/' } }]);
  const tela = texto(t.browser);
  assert.match(tela, /Verifique seu e-mail/);
  assert.match(tela, /Se existir uma conta com esse e-mail/);
  assert.doesNotMatch(tela, /não encontrad|não cadastrad|não existe|inexistente/i, 'nunca diz que o e-mail não existe');
  assert.ok(botao(t.browser, 'Voltar ao login'));
});

test('[RECOV-4] e-mail vazio ou malformado não chama a API; falha de envio mostra erro (não "Verifique seu e-mail"); excesso de pedidos tem texto próprio', async () => {
  const t = await iniciar();
  t.browser.click(botao(t.browser, 'Esqueci minha senha?'));
  await t.browser.flush();
  t.browser.click(botao(t.browser, 'Enviar link de recuperação'));
  await t.browser.flush();
  assert.match(aviso(t.browser), /Informe o e-mail da sua conta\./);
  assert.equal(t.sdk.calls.resetPassword.length, 0, 'e-mail vazio não chega ao SDK');
  await pedirLink(t, 'sem-arroba');
  assert.match(aviso(t.browser), /Informe um e-mail válido\./);
  assert.equal(t.sdk.calls.resetPassword.length, 0);

  const falha = await iniciar({ sdkOptions: { resetError: Object.assign(new Error('x'), { status: 500 }) } });
  falha.browser.click(botao(falha.browser, 'Esqueci minha senha?'));
  await falha.browser.flush();
  await pedirLink(falha);
  assert.match(texto(falha.browser), /Não foi possível enviar agora/);
  assert.doesNotMatch(texto(falha.browser), /Verifique seu e-mail/);
  assert.equal(botao(falha.browser, 'Enviar link de recuperação').disabled, false, 'pode tentar de novo (a falha não gasta o intervalo)');

  const limite = await iniciar({ sdkOptions: { resetError: Object.assign(new Error('x'), { status: 429, code: 'over_email_send_rate_limit' }) } });
  limite.browser.click(botao(limite.browser, 'Esqueci minha senha?'));
  await limite.browser.flush();
  await pedirLink(limite);
  assert.match(texto(limite.browser), /Muitos pedidos em pouco tempo/);
});

test('[RECOV-5] envios repetidos são evitados: um clique em andamento bloqueia o seguinte, e um novo pedido só passa depois de 1 minuto', async () => {
  let agora = 1_000_000;
  let liberar;
  const portao = new Promise((resolve) => {
    liberar = resolve;
  });
  const t = await iniciar({ clock: () => agora, sdkOptions: { resetGate: portao } });
  t.browser.click(botao(t.browser, 'Esqueci minha senha?'));
  await t.browser.flush();
  t.browser.type(campo(t.browser, 'E-mail'), EMAIL);
  const enviar = botao(t.browser, 'Enviar link de recuperação');
  t.browser.click(enviar);
  t.browser.click(enviar); // o segundo clique chega com a primeira resposta ainda pendente
  // e também o envio do formulário por outro caminho (Enter no campo), que não passa pelo botão desabilitado
  const formulario = t.browser.by.tag(t.browser.root, 'form')[0];
  formulario.dispatchEvent(makeEvent('submit'));
  formulario.dispatchEvent(makeEvent('submit'));
  await t.browser.flush();
  assert.equal(t.sdk.calls.resetPassword.length, 1, 'só um envio em andamento');
  assert.equal(enviar.disabled, true, 'o botão fica desabilitado enquanto envia');
  liberar();
  await t.browser.flush();
  assert.match(texto(t.browser), /Verifique seu e-mail/);

  // pedir outro: dentro do intervalo não chama a API
  t.browser.click(botao(t.browser, 'Pedir outro link'));
  await t.browser.flush();
  t.browser.click(botao(t.browser, 'Enviar link de recuperação'));
  await t.browser.flush();
  assert.equal(t.sdk.calls.resetPassword.length, 1);
  assert.match(texto(t.browser), /Já enviamos um link há instantes/);
  // passado o minuto, passa
  agora += 61 * 1000;
  t.browser.click(botao(t.browser, 'Enviar link de recuperação'));
  await t.browser.flush();
  assert.equal(t.sdk.calls.resetPassword.length, 2);
});

// ===========================================================================
// 3. O link do e-mail
// ===========================================================================
test('[RECOV-6] o link do e-mail (#access_token…&type=recovery) cria a sessão de recuperação, limpa o endereço e mostra "Definir nova senha" — não o login, nem o painel', async () => {
  const t = await iniciar({ hash: LINK_OK, routes: { 'GET /api/me': ME_ADMIN } });
  assert.deepEqual(t.sdk.calls.setSession, [{ access_token: TOKEN, refresh_token: REFRESH }]);
  const tela = texto(t.browser);
  assert.match(tela, /Definir nova senha/);
  assert.ok(campo(t.browser, 'Nova senha'));
  assert.ok(campo(t.browser, 'Confirmar nova senha'));
  assert.equal(campo(t.browser, 'Nova senha').type, 'password');
  assert.equal(campo(t.browser, 'Nova senha').getAttribute('autocomplete'), 'new-password');
  assert.equal(campo(t.browser, 'E-mail'), null, 'não é a tela de login');
  assert.equal(t.browser.by.tag(t.browser.root, 'nav').length, 0, 'o painel não abriu');
  assert.deepEqual(chamadasDeApi(t.fetchImpl), [], 'nenhuma chamada de API com a sessão de recuperação');
  assert.equal(t.browser.window.location.hash, '#/redefinir-senha', 'o estado de recuperação é reconhecível no endereço');
  assert.equal(t.browser.window.location.search, '');
  const pagina = tudoQueEstaNaPagina(t.browser);
  assert.ok(!pagina.includes(TOKEN) && !pagina.includes(REFRESH), 'o token não está no endereço nem na página');
});

test('[RECOV-7] um SIGNED_IN comum (e um PASSWORD_RECOVERY repetido) não descarta o estado de recuperação nem apaga o que a pessoa já digitou', async () => {
  const t = await iniciar({ hash: LINK_OK, routes: { 'GET /api/me': ME_ADMIN } });
  t.browser.type(campo(t.browser, 'Nova senha'), 'Parcial1');
  t.sdk.emit('SIGNED_IN');
  t.sdk.emit('PASSWORD_RECOVERY');
  t.sdk.emit('TOKEN_REFRESHED');
  await t.browser.flush();
  assert.match(texto(t.browser), /Definir nova senha/);
  assert.equal(campo(t.browser, 'Nova senha').value, 'Parcial1', 'o formulário não foi refeito');
  assert.equal(t.browser.by.tag(t.browser.root, 'nav').length, 0);
  assert.deepEqual(chamadasDeApi(t.fetchImpl), []);
});

test('[RECOV-8] validação: campos vazios, curta demais, sem letra ou sem número e confirmação diferente — nada é enviado ao SDK', async () => {
  const t = await iniciar({ hash: LINK_OK });
  await preencherNovaSenha(t, '', '');
  assert.match(texto(t.browser), /Informe a nova senha e a confirmação\./);
  await preencherNovaSenha(t, 'Ab1', 'Ab1');
  assert.match(texto(t.browser), /pelo menos 8 caracteres/);
  await preencherNovaSenha(t, 'somenteletras', 'somenteletras');
  assert.match(texto(t.browser), /letras e números/);
  await preencherNovaSenha(t, '1234567890', '1234567890');
  assert.match(texto(t.browser), /letras e números/);
  await preencherNovaSenha(t, SENHA_NOVA, `${SENHA_NOVA}x`);
  assert.match(texto(t.browser), /A confirmação não é igual à nova senha\./);
  assert.deepEqual(t.sdk.calls.updateUser, [], 'nenhuma troca foi pedida');
  assert.doesNotMatch(texto(t.browser), /Senha alterada com sucesso/);
});

test('[RECOV-9] senha válida: updateUser({ password }) e o sucesso só aparece depois da resposta; a sessão de recuperação é encerrada e "Voltar ao login" leva ao login', async () => {
  const t = await iniciar({ hash: LINK_OK, routes: { 'GET /api/me': ME_ADMIN } });
  await preencherNovaSenha(t, SENHA_NOVA);
  assert.deepEqual(t.sdk.calls.updateUser, [{ password: SENHA_NOVA }], 'só a senha nova — nunca a antiga, nunca o e-mail');
  assert.match(texto(t.browser), /Senha alterada com sucesso/);
  assert.deepEqual(t.sdk.calls.signOut, [{ scope: 'local' }], 'a sessão de recuperação não fica aberta neste navegador');
  assert.doesNotMatch(texto(t.browser), /Definir nova senha/);
  assert.ok(!tudoQueEstaNaPagina(t.browser).includes(SENHA_NOVA), 'a senha não fica na página');
  assert.deepEqual(chamadasDeApi(t.fetchImpl), []);
  t.browser.click(botao(t.browser, 'Voltar ao login'));
  await t.browser.flush();
  assert.ok(campo(t.browser, 'Senha'), 'login');
  assert.equal(t.sdk.calls.signIn.length, 0);
});

test('[RECOV-10] updateUser com falha NÃO mostra sucesso: erro genérico, senha igual à atual, senha fraca e resposta sem usuário', async () => {
  const casos = [
    [{ updateUserError: Object.assign(new Error('x'), { status: 500 }) }, /Não foi possível salvar a nova senha agora/],
    [{ updateUserError: Object.assign(new Error('x'), { status: 422, code: 'same_password' }) }, /diferente da senha atual/],
    [{ updateUserError: Object.assign(new Error('x'), { status: 422, code: 'weak_password' }) }, /considerada fraca/],
    [{ updateUserResult: { data: { user: null }, error: null } }, /Não foi possível salvar a nova senha agora/],
  ];
  for (const [sdkOptions, esperado] of casos) {
    const t = await iniciar({ hash: LINK_OK, sdkOptions });
    await preencherNovaSenha(t, SENHA_NOVA);
    assert.equal(t.sdk.calls.updateUser.length, 1);
    assert.match(texto(t.browser), esperado);
    assert.doesNotMatch(texto(t.browser), /Senha alterada com sucesso/);
    assert.ok(!texto(t.browser).includes(SENHA_NOVA), 'a senha digitada nunca aparece nos textos da tela');
    assert.deepEqual(t.sdk.calls.signOut, [], 'sem sucesso, a sessão de recuperação continua para a pessoa tentar de novo');
    assert.equal(botao(t.browser, 'Definir nova senha').disabled, false, 'pode tentar de novo');
  }
  // o SDK lançando uma exceção (rede fora) também não vira sucesso
  const lancou = await iniciar({ hash: LINK_OK, sdkOptions: { updateUserThrows: new Error('rede fora do ar') } });
  await preencherNovaSenha(lancou, SENHA_NOVA);
  assert.match(texto(lancou.browser), /Não foi possível salvar a nova senha agora/);
  assert.doesNotMatch(texto(lancou.browser), /Senha alterada com sucesso/);
  assert.doesNotMatch(texto(lancou.browser), /rede fora do ar/, 'a mensagem técnica não vai para a tela');
});

test('[RECOV-11] a sessão de recuperação que venceu enquanto a pessoa digitava leva a "Recuperar acesso" com a opção de pedir um novo link', async () => {
  const t = await iniciar({ hash: LINK_OK });
  t.sdk.setSession(null); // a sessão sumiu
  await preencherNovaSenha(t, SENHA_NOVA);
  const tela = texto(t.browser);
  assert.match(tela, /Recuperar acesso/);
  assert.match(tela, /expirou, é inválido ou já foi usado/);
  assert.doesNotMatch(tela, /Senha alterada com sucesso/);
  assert.ok(botao(t.browser, 'Enviar link de recuperação'));
});

test('[RECOV-12] link vencido, inválido ou já usado (#error=…otp_expired): endereço limpo, nenhuma sessão criada, aviso claro e novo pedido possível', async () => {
  const t = await iniciar({ hash: LINK_VENCIDO, routes: { 'GET /api/me': ME_ADMIN } });
  assert.equal(t.sdk.calls.setSession.length + t.sdk.calls.verifyOtp.length + t.sdk.calls.exchange.length, 0);
  const tela = texto(t.browser);
  assert.match(tela, /Recuperar acesso/);
  assert.match(tela, /Este link de recuperação expirou, é inválido ou já foi usado\. Peça um novo link abaixo\./);
  assert.equal(t.browser.window.location.hash, '', 'o endereço foi limpo');
  assert.ok(!tudoQueEstaNaPagina(t.browser).includes('otp_expired'));
  assert.deepEqual(chamadasDeApi(t.fetchImpl), []);
  await pedirLink(t);
  assert.equal(t.sdk.calls.resetPassword.length, 1);
  assert.match(texto(t.browser), /Verifique seu e-mail/);
});

test('[RECOV-13] tokens que o SDK recusa (reutilizados/expirados) ou sem refresh_token caem no mesmo aviso, sem entrar no painel', async () => {
  const recusado = await iniciar({ hash: LINK_OK, sdkOptions: { setSessionError: Object.assign(new Error('x'), { status: 401, code: 'bad_jwt' }) } });
  assert.match(texto(recusado.browser), /expirou, é inválido ou já foi usado/);
  assert.equal(recusado.browser.by.tag(recusado.browser.root, 'nav').length, 0);
  assert.equal(recusado.browser.window.location.hash, '#/redefinir-senha', 'o endereço foi trocado por um estado sem token');
  assert.ok(!tudoQueEstaNaPagina(recusado.browser).includes(TOKEN));

  const semRefresh = await iniciar({ hash: `#access_token=${TOKEN}&type=recovery` });
  assert.equal(semRefresh.sdk.calls.setSession.length, 0);
  assert.match(texto(semRefresh.browser), /expirou, é inválido ou já foi usado/);
  assert.ok(!tudoQueEstaNaPagina(semRefresh.browser).includes(TOKEN));
});

test('[RECOV-14] modelo de e-mail com token_hash (?token_hash=…&type=recovery) usa verifyOtp; o PASSWORD_RECOVERY do SDK mostra UM formulário; a query é limpa', async () => {
  const t = await iniciar({ search: '?token_hash=HASH-DE-TESTE-NAO-REAL&type=recovery' });
  assert.deepEqual(t.sdk.calls.verifyOtp, [{ token_hash: 'HASH-DE-TESTE-NAO-REAL', type: 'recovery' }]);
  assert.match(texto(t.browser), /Definir nova senha/);
  assert.equal(t.browser.by.tag(t.browser.root, 'form').length, 1);
  assert.equal(t.browser.window.location.search, '', 'a query com o token saiu do endereço');
  assert.ok(!tudoQueEstaNaPagina(t.browser).includes('HASH-DE-TESTE-NAO-REAL'));

  const recusado = await iniciar({ search: '?token_hash=HASH-DE-TESTE-NAO-REAL&type=recovery', sdkOptions: { verifyOtpError: Object.assign(new Error('x'), { status: 403, code: 'otp_expired' }) } });
  assert.match(texto(recusado.browser), /expirou, é inválido ou já foi usado/);
});

test('[RECOV-15] fluxo PKCE (?code=…): troca o código pela sessão de recuperação; recusado, cai no aviso', async () => {
  const t = await iniciar({ search: '?code=CODIGO-DE-TESTE-NAO-REAL' });
  assert.deepEqual(t.sdk.calls.exchange, ['CODIGO-DE-TESTE-NAO-REAL']);
  assert.match(texto(t.browser), /Definir nova senha/);
  assert.equal(t.browser.window.location.search, '');
  const recusado = await iniciar({ search: '?code=CODIGO-DE-TESTE-NAO-REAL', sdkOptions: { exchangeError: Object.assign(new Error('x'), { status: 400 }) } });
  assert.match(texto(recusado.browser), /expirou, é inválido ou já foi usado/);
});

test('[RECOV-16] atualizar a página em #/redefinir-senha: com sessão continua "Definir nova senha"; sem sessão, o link já não vale', async () => {
  const { FAKE_RECOVERY_SESSION } = await loadFixtures();
  const comSessao = await iniciar({ hash: '#/redefinir-senha', session: FAKE_RECOVERY_SESSION, routes: { 'GET /api/me': ME_ADMIN } });
  assert.match(texto(comSessao.browser), /Definir nova senha/);
  assert.deepEqual(chamadasDeApi(comSessao.fetchImpl), [], 'não abre o painel');
  const semSessao = await iniciar({ hash: '#/redefinir-senha' });
  assert.match(texto(semSessao.browser), /Recuperar acesso/);
  assert.match(texto(semSessao.browser), /expirou, é inválido ou já foi usado/);
});

test('[RECOV-17] quem já está com o painel aberto e clica no link: a sessão de recuperação assume e o painel dá lugar ao "Definir nova senha"', async () => {
  const t = await iniciar({ session: true, hash: LINK_OK, routes: { 'GET /api/me': ME_ADMIN } });
  assert.match(texto(t.browser), /Definir nova senha/);
  assert.equal(t.browser.by.tag(t.browser.root, 'nav').length, 0);
  assert.deepEqual(chamadasDeApi(t.fetchImpl), []);
});

// ===========================================================================
// 4. O que NÃO muda
// ===========================================================================
test('[RECOV-18] o que não é recuperação segue como era: hash de rota e links de outro tipo (cadastro, convite) não acionam nada; o SDK mantém detectSessionInUrl: false', async () => {
  for (const hash of ['', '#/crm', '#/funis', `#access_token=${TOKEN}&refresh_token=${REFRESH}&type=signup`]) {
    const t = await iniciar({ hash });
    assert.ok(campo(t.browser, 'Senha'), `login em "${hash.slice(0, 20)}"`);
    assert.equal(t.sdk.calls.setSession.length + t.sdk.calls.verifyOtp.length + t.sdk.calls.exchange.length + t.sdk.calls.updateUser.length + t.sdk.calls.resetPassword.length, 0);
    assert.equal(t.sdk.calls.createClient.options.auth.detectSessionInUrl, false);
  }
  const comSessao = await iniciar({ session: true, hash: '#/crm', routes: { 'GET /api/me': ME_ADMIN, 'GET /api/crm': { items: [] } } });
  assert.ok(comSessao.browser.by.tag(comSessao.browser.root, 'nav').length > 0, 'quem tem sessão continua entrando no painel');
});

test('[RECOV-19] um SIGNED_OUT (por exemplo, o logout em outra aba) não troca a tela de nova senha pelo login', async () => {
  const t = await iniciar({ hash: LINK_OK });
  t.sdk.emit('SIGNED_OUT');
  await t.browser.flush();
  assert.match(texto(t.browser), /Definir nova senha/, 'o SIGNED_OUT não troca a tela de recuperação pelo login');
});

// ===========================================================================
// 5. Segurança, texto e código
// ===========================================================================
test('[RECOV-20] o código da recuperação não registra nada (console), não guarda token/senha no navegador, não usa HTML dinâmico e não fala com o banco', () => {
  const codigo = fs.readFileSync(path.join(ROOT, 'dashboard', 'passwordRecovery.mjs'), 'utf8');
  const semComentarios = codigo.split('\n').filter((linha) => !linha.trim().startsWith('//')).join('\n');
  for (const proibido of [/console\./, /localStorage|sessionStorage|document\.cookie|indexedDB/, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, /supabase\.co|\/rest\/v1|\bfetch\(|XMLHttpRequest/, /alert\(/]) {
    assert.doesNotMatch(semComentarios, proibido, String(proibido));
  }
  assert.doesNotMatch(semComentarios, /signInWithPassword|auth\.admin|service_role|getUser\(/, 'não cria outro sistema de autenticação');
  const main = fs.readFileSync(path.join(ROOT, 'dashboard', 'main.mjs'), 'utf8');
  assert.doesNotMatch(main.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'), /console\./);
});

test('[RECOV-21] todos os textos pedidos estão em português do Brasil', async () => {
  const { RECOVERY_TEXT, RESET_HASH } = await import('../../dashboard/passwordRecovery.mjs');
  assert.equal(RECOVERY_TEXT.forgotLink, 'Esqueci minha senha?');
  assert.equal(RECOVERY_TEXT.forgotTitle, 'Recuperar acesso');
  assert.equal(RECOVERY_TEXT.send, 'Enviar link de recuperação');
  assert.equal(RECOVERY_TEXT.sentTitle, 'Verifique seu e-mail');
  assert.equal(RECOVERY_TEXT.newTitle, 'Definir nova senha');
  assert.equal(RECOVERY_TEXT.confirmPassword, 'Confirmar nova senha');
  assert.equal(RECOVERY_TEXT.doneTitle, 'Senha alterada com sucesso');
  assert.equal(RECOVERY_TEXT.back, 'Voltar ao login');
  assert.equal(RESET_HASH, '#/redefinir-senha');
});

test('[RECOV-22] parseAuthRedirect: tabela de endereços (tokens, token_hash, code, erros e o que deve ser ignorado)', async () => {
  const { parseAuthRedirect } = await import('../../dashboard/passwordRecovery.mjs');
  assert.deepEqual(parseAuthRedirect({}), { kind: 'none' });
  assert.deepEqual(parseAuthRedirect({ hash: '#/crm?a=1', search: '' }), { kind: 'none' });
  assert.deepEqual(parseAuthRedirect({ hash: LINK_OK }), { kind: 'tokens', accessToken: TOKEN, refreshToken: REFRESH });
  assert.deepEqual(parseAuthRedirect({ hash: `#access_token=${TOKEN}&type=recovery` }), { kind: 'tokens', accessToken: TOKEN, refreshToken: '' });
  assert.deepEqual(parseAuthRedirect({ hash: `#access_token=${TOKEN}&refresh_token=${REFRESH}&type=magiclink` }), { kind: 'none' });
  assert.deepEqual(parseAuthRedirect({ hash: LINK_VENCIDO }), { kind: 'error' });
  assert.deepEqual(parseAuthRedirect({ search: '?error=access_denied&error_code=otp_expired' }), { kind: 'error' });
  assert.deepEqual(parseAuthRedirect({ search: '?token_hash=H&type=recovery' }), { kind: 'tokenHash', tokenHash: 'H' });
  assert.deepEqual(parseAuthRedirect({ search: '?token_hash=H&type=signup' }), { kind: 'none' });
  assert.deepEqual(parseAuthRedirect({ search: '?code=C' }), { kind: 'code', code: 'C' });
  assert.deepEqual(parseAuthRedirect({ hash: '#/redefinir-senha' }), { kind: 'none' });
});

test('[RECOV-23] validateNewPassword: a regra da nova senha', async () => {
  const { validateNewPassword } = await import('../../dashboard/passwordRecovery.mjs');
  assert.equal(validateNewPassword('Senha1234', 'Senha1234'), null);
  assert.equal(validateNewPassword('  Senha 1 ', '  Senha 1 '), null, 'espaços fazem parte da senha: nada é cortado');
  assert.match(validateNewPassword('', ''), /Informe/);
  assert.match(validateNewPassword('Ab1', 'Ab1'), /8 caracteres/);
  assert.match(validateNewPassword('abcdefghij', 'abcdefghij'), /letras e números/);
  assert.match(validateNewPassword('1234567890', '1234567890'), /letras e números/);
  assert.match(validateNewPassword('Senha1234', 'senha1234'), /confirmação/);
});

test('[RECOV-24] router: url() lê o endereço e scrub() troca a entrada atual por <caminho><hash> sem ?, sem criar entrada e sem avisar', async () => {
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const browser = createBrowser({ hash: `#access_token=${TOKEN}&type=recovery`, search: '?code=C' });
  const navigation = browserNavigation(browser.window);
  assert.deepEqual(navigation.url(), { origin: 'http://localhost:3000', pathname: '/', search: '?code=C', hash: `#access_token=${TOKEN}&type=recovery` });
  let avisos = 0;
  const parar = navigation.subscribe(() => {
    avisos += 1;
  });
  const entradas = browser.window.history.length;
  navigation.scrub('#/redefinir-senha');
  await browser.flush();
  assert.equal(browser.window.location.hash, '#/redefinir-senha');
  assert.equal(browser.window.location.search, '');
  assert.equal(browser.window.history.length, entradas, 'nenhuma entrada nova');
  assert.equal(avisos, 0);
  navigation.scrub('');
  assert.equal(browser.window.location.hash, '');
  parar();
});

test('[RECOV-25] layout: o formulário cabe em celular (viewport, largura máxima, regra @media) e o index.html continua com o viewport', () => {
  const css = fs.readFileSync(path.join(ROOT, 'dashboard', 'styles.css'), 'utf8');
  assert.match(css, /\.login \{[^}]*width: 100%;[^}]*max-width: 400px/);
  assert.match(css, /@media \(max-width: 480px\) \{ \.login \{ padding: 24px 18px; \} \}/);
  assert.match(css, /\.login-links/);
  assert.match(css, /\.recovery-form \.btn\.primary \{ width: 100%; \}/);
  const html = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});
