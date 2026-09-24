// O Dashboard de VERDADE falando com a CRM-API de VERDADE: o painel (dashboard/main.mjs e as telas), sobre o DOM de teste, faz
// as requisições HTTP que faria no navegador — e cada uma cai no app REAL do servidor (src/server/app.js), que autentica
// pelo fluxo real (Bearer -> adapter do Supabase, com o Supabase falso só na borda de rede -> AuthorizationContext), chama o
// CRM Service real, o domínio real e o arquivo real (em diretório temporário).
//
// É o teste que impede o Dashboard e a API de se afastarem: se a API mudar um contrato, um campo, uma mensagem ou uma regra
// (status permitidos, duplicidade, DO_NOT_CONTACT), a interface falha aqui. O que NÃO é real: o navegador (um DOM de teste),
// o SDK do Supabase do navegador (um falso, com o token que o servidor de teste reconhece) e a rede (sem socket).
//
// Nenhuma credencial real: usuários, e-mails e telefones são fictícios (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const crm = require('../../src/crm');
const { createBrowser } = require('../helpers/fakeDom');
const { montarAmbiente, BRENO, RAFAEL, EX_COLABORADOR } = require('./testEnv');

const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const CONFIG = { supabaseUrl: 'https://exemplo.supabase.co', supabaseAnonKey: 'chave-anon-de-teste-nao-real' };
const nbsp = (text) => text.split(String.fromCharCode(160)).join(' ');

// Sobe o painel como `usuario`, com o CRM real sobre um arquivo temporário.
async function subir(t, { usuario = BRENO, hash = '', usuarios = [BRENO, RAFAEL], sementes = [], token } = {}) {
  const env = montarAmbiente(t, { usuarios, crm: true });
  const repositorio = createJsonFileCrmRepository(env.crmFilePath);
  const semeados = sementes.map((campos) => crm.createRecord(repositorio, campos, { actor: 'HUMAN', reviewedBy: { userId: 'user-semente', name: 'Semente', role: 'ADMIN' }, motivo: 'semente do teste' }).record);

  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, bridgeFetch } = await loadFixtures();
  const browser = createBrowser({ hash });
  const bridge = bridgeFetch(env.app);
  const fetchImpl = async (path, init) => (path === '/config.json' ? new Response(JSON.stringify(CONFIG), { status: 200 }) : bridge(path, init));
  fetchImpl.calls = bridge.calls;
  fetchImpl.responses = bridge.responses;
  const accessToken = token || env.tokenFor(usuario.userId);
  const sdk = createFakeSdk({ session: { access_token: accessToken, refresh_token: 'refresh-de-teste-nao-real', user: { id: usuario.authUserId } } });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation: browserNavigation(browser.window) });
  await browser.flush();
  return { env, browser, sdk, fetchImpl, repositorio, semeados, accessToken, usuario };
}

const textoDaTela = (browser) => {
  const texto = browser.root.textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
  return texto;
};

const ALFA = Object.freeze({ empresa: 'Clínica Alfa Teste', site: 'alfa.example.test', telefone: '24 90000-0001', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia' });
const BETA = Object.freeze({ empresa: 'Clínica Beta Teste', site: 'beta.example.test', telefone: '21 90000-0002', cidade: 'Niterói', estado: 'RJ', nicho: 'Odontologia' });

async function preencher(t, valores) {
  const { FIELD_GROUPS } = await import('../../dashboard/crm-model.mjs');
  const campos = FIELD_GROUPS.flatMap((grupo) => grupo.fields);
  for (const [chave, valor] of Object.entries(valores)) {
    const campo = campos.find((entry) => entry.key === chave);
    const rotulo = campo.required ? `${campo.label} (obrigatório)` : campo.label;
    const controle = t.browser.by.label(t.browser.root, rotulo);
    assert.ok(controle, `campo "${rotulo}" não encontrado`);
    t.browser.type(controle, valor);
  }
}

const clicar = async (t, texto) => {
  const botao = t.browser.by.button(t.browser.root, texto);
  assert.ok(botao, `botão "${texto}" não encontrado`);
  t.browser.click(botao);
  await t.browser.flush();
};

const gravados = (t) => createJsonFileCrmRepository(t.env.crmFilePath).list();
const doArquivo = (t, id) => createJsonFileCrmRepository(t.env.crmFilePath).getById(id);
const sohAdministrador = (usuario) => ({ userId: usuario.userId, name: usuario.name, role: usuario.role });

// ===========================================================================
// ADMIN: o ciclo inteiro pela interface, contra a API real
// ===========================================================================
test('[DASH-FULL-1] ADMIN pela interface, contra a API REAL: criar -> editar -> mudar status -> marcar "Não contatar" — cada passo chega ao arquivo do CRM com a identidade do TOKEN (nunca a da tela) e a ficha mostra o que o servidor devolveu', async (t) => {
  const s = await subir(t, { hash: '#/crm/novo' });
  await preencher(s, { empresa: 'Clínica Nova Teste', site: 'nova.example.test', telefone: '24 90000-0003', cidade: 'Petrópolis', valorProposta: '1500,50', responsavel: 'Rafael' });
  s.browser.choose(s.browser.by.label(s.browser.root, 'Status inicial'), 'QUALIFIED_PROSPECT');
  s.browser.type(s.browser.by.label(s.browser.root, 'Motivo da entrada (opcional)'), 'Indicação de cliente');
  await clicar(s, 'Criar registro');

  // criou, gravou e abriu a ficha do registro
  const [criado] = gravados(s);
  assert.equal(gravados(s).length, 1);
  assert.equal(criado.empresa, 'Clínica Nova Teste');
  assert.equal(criado.valorProposta, 1500.5, 'o valor digitado com vírgula chegou como número');
  assert.equal(criado.status, 'QUALIFIED_PROSPECT');
  assert.deepEqual(criado.historico[0].reviewedBy, sohAdministrador(BRENO), 'a auditoria é a do token');
  assert.equal(criado.historico[0].actor, 'HUMAN');
  assert.equal(criado.historico[0].motivo, 'Indicação de cliente');
  assert.equal(s.browser.window.location.hash, `#/crm/registro/${encodeURIComponent(criado.id)}`);
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Clínica Nova Teste');
  assert.match(textoDaTela(s.browser), /Registro criado\./);

  // editar
  await clicar(s, 'Editar');
  s.browser.type(s.browser.by.label(s.browser.root, 'Cidade'), 'Teresópolis');
  s.browser.type(s.browser.by.label(s.browser.root, 'Valor da proposta'), '2000');
  await clicar(s, 'Salvar alterações');
  assert.match(textoDaTela(s.browser), /Alterações salvas\./);
  const editado = doArquivo(s, criado.id);
  assert.equal(editado.cidade, 'Teresópolis');
  assert.equal(editado.valorProposta, 2000);
  assert.equal(editado.empresa, 'Clínica Nova Teste', 'o que não foi tocado ficou como estava');
  assert.equal(editado.historico.length, 1, 'editar campos não cria evento de histórico (limite documentado)');

  // mudar status
  await clicar(s, 'Mudar status');
  s.browser.choose(s.browser.by.label(s.browser.root, 'Novo status'), 'CONTACTED');
  s.browser.type(s.browser.by.label(s.browser.root, 'Motivo (opcional)'), 'Primeiro contato feito');
  await clicar(s, 'Confirmar mudança');
  assert.match(textoDaTela(s.browser), /Status alterado para Contacted\./);
  const movido = doArquivo(s, criado.id);
  assert.equal(movido.status, 'CONTACTED');
  assert.deepEqual(movido.historico.at(-1).reviewedBy, sohAdministrador(BRENO));
  assert.equal(movido.historico.at(-1).motivo, 'Primeiro contato feito');
  const itensDoHistorico = s.browser.by.tag(s.browser.by.cls(s.browser.root, 'timeline')[0], 'li').map((li) => li.textContent);
  assert.equal(itensDoHistorico.length, 2);
  assert.match(itensDoHistorico[0], /Qualified Prospect → Contacted/);
  assert.match(itensDoHistorico[0], /Breno Bento \(Administrador\)/);

  // marcar "Não contatar"
  await clicar(s, 'Marcar como Não contatar');
  await clicar(s, 'Confirmar: marcar como Não contatar');
  assert.match(textoDaTela(s.browser), /Confirme que você entende que a ação é terminal/, 'sem a confirmação nada acontece');
  assert.equal(doArquivo(s, criado.id).status, 'CONTACTED');
  s.browser.check(s.browser.by.label(s.browser.root, 'Entendo que esta ação é terminal e não pode ser desfeita.'));
  s.browser.type(s.browser.by.label(s.browser.root, 'Motivo (opcional)'), 'Pediu para não ser contatado');
  await clicar(s, 'Confirmar: marcar como Não contatar');
  assert.equal(doArquivo(s, criado.id).status, 'DO_NOT_CONTACT');
  assert.match(textoDaTela(s.browser), /bloqueado como "Não contatar"/);
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar']) assert.equal(s.browser.by.button(s.browser.root, botao), null, `${botao} saiu`);
});

test('[DASH-FULL-2] as regras do domínio chegam à tela pela API real: transição proibida (409 INVALID_TRANSITION), identidade duplicada (409 DUPLICATE_RECORD) e identidade BLOQUEADA (409 DNC_BLOCKED) mostram a frase certa, sem gravar nada', async (t) => {
  const s = await subir(t, { sementes: [ALFA, BETA] });
  const [alfa, beta] = s.semeados;
  crm.markDoNotContact(s.repositorio, beta.id, { actor: 'HUMAN', reviewedBy: { userId: 'user-semente', name: 'Semente', role: 'ADMIN' }, motivo: 'semente' });
  crm.moveStatus(s.repositorio, alfa.id, 'WON', { actor: 'HUMAN', reviewedBy: { userId: 'user-semente', name: 'Semente', role: 'ADMIN' }, motivo: 'semente' });

  // WON -> PROSPECT: o domínio recusa (só WON -> DO_NOT_CONTACT)
  s.browser.window.location.hash = `#/crm/registro/${encodeURIComponent(alfa.id)}`;
  await s.browser.flush();
  await clicar(s, 'Mudar status');
  s.browser.choose(s.browser.by.label(s.browser.root, 'Novo status'), 'PROSPECT');
  await clicar(s, 'Confirmar mudança');
  assert.match(textoDaTela(s.browser), /Esta mudança de status não é permitida a partir do status atual\./);
  assert.equal(doArquivo(s, alfa.id).status, 'WON');

  // criar com o site de um registro ativo: duplicidade; com o site de um bloqueado: DNC
  const antes = gravados(s).length;
  s.browser.window.location.hash = '#/crm/novo';
  await s.browser.flush();
  await preencher(s, { empresa: 'Outra Empresa', site: ALFA.site });
  await clicar(s, 'Criar registro');
  assert.match(textoDaTela(s.browser), /Já existe um registro com esta identidade \(mesmo site, telefone ou Instagram\)/);
  await preencher(s, { site: BETA.site });
  await clicar(s, 'Criar registro');
  assert.match(textoDaTela(s.browser), /Esta identidade está bloqueada como "Não contatar"/);
  assert.equal(gravados(s).length, antes, 'nada foi gravado');
  assert.equal(s.browser.by.label(s.browser.root, 'Empresa (obrigatório)').value, 'Outra Empresa', 'o formulário continua preenchido');

  // editar um registro bloqueado por baixo: a API recusa com RECORD_LOCKED e a ficha recarrega mostrando o bloqueio
  s.browser.window.location.hash = `#/crm/registro/${encodeURIComponent(alfa.id)}`;
  await s.browser.flush();
  await clicar(s, 'Editar');
  crm.markDoNotContact(s.repositorio, alfa.id, { actor: 'HUMAN', reviewedBy: { userId: 'user-outro', name: 'Outro', role: 'ADMIN' }, motivo: 'por baixo' });
  s.browser.type(s.browser.by.label(s.browser.root, 'Cidade'), 'Outra cidade');
  await clicar(s, 'Salvar alterações');
  assert.match(textoDaTela(s.browser), /bloqueado como "Não contatar"/);
  assert.equal(doArquivo(s, alfa.id).cidade, ALFA.cidade, 'a edição foi recusada');
  assert.equal(s.browser.by.button(s.browser.root, 'Editar'), null);
});

test('[DASH-FULL-3] CONTRATO: os 31 campos do formulário, todos preenchidos, são aceitos pela API real e voltam iguais na ficha — o modelo do Dashboard e o domínio não divergem', async (t) => {
  const { FIELD_GROUPS, EDITABLE_FIELDS } = await import('../../dashboard/crm-model.mjs');
  const s = await subir(t, { hash: '#/crm/novo' });
  const valores = {};
  for (const campo of EDITABLE_FIELDS) {
    valores[campo.key] =
      campo.kind === 'number' ? '1500.5' : campo.kind === 'date' ? '2026-10-05' : campo.kind === 'email' ? 'contato@completo.example.test' : campo.kind === 'tel' ? '24 90000-0009' : campo.kind === 'url' ? `https://completo.example.test/${campo.key}` : `valor de ${campo.key}`;
  }
  valores.whatsapp = '24 90000-0010'; // outro número: o domínio compara cada número
  await preencher(s, valores);
  await clicar(s, 'Criar registro');

  assert.equal(gravados(s).length, 1, 'a API real aceitou os 31 campos');
  const [gravado] = gravados(s);
  for (const campo of EDITABLE_FIELDS) {
    const esperado = campo.kind === 'number' ? 1500.5 : valores[campo.key];
    assert.equal(gravado[campo.key], esperado, `${campo.key} gravado`);
  }
  // e a ficha mostra os 31 (todos os blocos, cada campo com o valor que o servidor devolveu)
  const texto = textoDaTela(s.browser);
  assert.ok(texto.includes('valor de nicho') && texto.includes('valor de observacoes') && texto.includes('valor de problemaIdentificado'));
  assert.equal(nbsp(texto).includes('R$ 1.500,50'), true);
  assert.equal(s.browser.by.tag(s.browser.root, 'h3').map((h3) => h3.textContent).filter((titulo) => FIELD_GROUPS.some((grupo) => grupo.title === titulo)).length, FIELD_GROUPS.length);
});

test('[DASH-FULL-4] tudo o que a interface enviou ao servidor tem só campos do registro, status, motivo e id; nunca userId, authUserId, role, permissions, actor ou reviewedBy — e o servidor nunca devolveu authUserId, e-mail de login nem token', async (t) => {
  const s = await subir(t, { hash: '#/crm/novo', sementes: [ALFA] });
  await preencher(s, { empresa: 'Auditada Ltda', cidade: 'Niterói' });
  await clicar(s, 'Criar registro');
  await clicar(s, 'Editar');
  s.browser.type(s.browser.by.label(s.browser.root, 'Nicho'), 'Psicologia');
  await clicar(s, 'Salvar alterações');
  await clicar(s, 'Mudar status');
  s.browser.choose(s.browser.by.label(s.browser.root, 'Novo status'), 'RESPONDED');
  await clicar(s, 'Confirmar mudança');
  await clicar(s, 'Marcar como Não contatar');
  s.browser.check(s.browser.by.label(s.browser.root, 'Entendo que esta ação é terminal e não pode ser desfeita.'));
  await clicar(s, 'Confirmar: marcar como Não contatar');

  const { WRITABLE_KEYS } = await import('../../dashboard/crm-model.mjs');
  const escritas = s.fetchImpl.calls.filter((chamada) => chamada.method !== 'GET');
  assert.equal(escritas.length, 4);
  for (const chamada of escritas) {
    for (const chave of Object.keys(chamada.body)) assert.ok([...WRITABLE_KEYS, 'status', 'reason', 'to'].includes(chave), `${chamada.method} ${chamada.path}: chave inesperada ${chave}`);
    assert.deepEqual(Object.keys(chamada.headers).sort(), ['accept', 'authorization', 'content-type']);
    assert.equal(chamada.headers.authorization, `Bearer ${s.accessToken}`);
  }
  const corpos = JSON.stringify(escritas.map((chamada) => chamada.body));
  for (const proibido of ['userId', 'authUserId', 'role', 'permissions', 'actor', 'reviewedBy', BRENO.userId, BRENO.authUserId, BRENO.email]) assert.ok(!corpos.includes(proibido), `"${proibido}" não pode ser enviado`);

  const respostas = s.fetchImpl.responses.map((resposta) => resposta.text).join('\n');
  for (const proibido of [BRENO.authUserId, BRENO.email, s.accessToken]) assert.ok(!respostas.includes(proibido), `o servidor não pode devolver "${proibido}"`);
  const naTela = s.browser.root.textContent + s.browser.document.title;
  for (const proibido of [BRENO.authUserId, BRENO.email, s.accessToken]) assert.ok(!naTela.includes(proibido), `"${proibido}" não pode aparecer na interface`);
});

// ===========================================================================
// COMMERCIAL_CLOSER: lê, não escreve — e o servidor também recusa
// ===========================================================================
test('[DASH-FULL-5] COMMERCIAL_CLOSER pela interface: lista, busca, filtra e abre a ficha (a API real deixa ler), sem nenhum botão de escrita; e, se a tela fosse forçada a escrever, a API real responde 403 e nada é gravado', async (t) => {
  const s = await subir(t, { usuario: RAFAEL, sementes: [ALFA, BETA], hash: '#/crm' });
  assert.match(textoDaTela(s.browser), /Clínica Alfa Teste/);
  assert.match(textoDaTela(s.browser), /Clínica Beta Teste/);
  assert.equal(s.browser.by.link(s.browser.root, 'Novo registro'), null);
  s.browser.type(s.browser.by.label(s.browser.root, 'Buscar'), 'beta');
  assert.deepEqual(s.browser.by.tag(s.browser.by.tag(s.browser.root, 'tbody')[0], 'tr').map((tr) => tr.children[0].textContent), ['Clínica Beta Teste']);
  s.browser.type(s.browser.by.label(s.browser.root, 'Buscar'), '');
  s.browser.choose(s.browser.by.label(s.browser.root, 'Nicho'), 'Odontologia');
  assert.equal(s.browser.by.tag(s.browser.by.tag(s.browser.root, 'tbody')[0], 'tr').length, 1);
  s.browser.click(s.browser.by.button(s.browser.root, 'Limpar filtros'));

  s.browser.click(s.browser.by.link(s.browser.root, 'Clínica Alfa Teste'));
  await s.browser.flush();
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Clínica Alfa Teste');
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar']) assert.equal(s.browser.by.button(s.browser.root, botao), null, botao);
  assert.equal(s.fetchImpl.calls.filter((chamada) => chamada.method !== 'GET').length, 0);

  // A tela é forçada a mostrar os botões (como se as permissões locais estivessem adulteradas): o SERVIDOR recusa.
  const antes = JSON.stringify(gravados(s));
  const { createCrmView } = await import('../../dashboard/views/crm.mjs');
  const { createApiClient } = await import('../../dashboard/api.mjs');
  const browserForcado = createBrowser();
  const api = createApiClient({ getAccessToken: async () => s.accessToken, refreshAccessToken: async () => null, onSessionLost() {}, fetchImpl: s.fetchImpl });
  const view = createCrmView({ document: browserForcado.document, root: browserForcado.root, api, permissions: { canReadCrm: true, canWriteCrm: true }, navigate() {} });
  view.show({ name: 'crm-record', id: s.semeados[0].id });
  await browserForcado.flush();
  browserForcado.click(browserForcado.by.button(browserForcado.root, 'Editar'));
  browserForcado.type(browserForcado.by.label(browserForcado.root, 'Cidade'), 'Cidade Forjada');
  browserForcado.click(browserForcado.by.button(browserForcado.root, 'Salvar alterações'));
  await browserForcado.flush();
  assert.match(browserForcado.root.textContent, /Sua conta não tem permissão para esta ação\./);
  browserForcado.click(browserForcado.by.button(browserForcado.root, 'Cancelar'));
  browserForcado.click(browserForcado.by.button(browserForcado.root, 'Marcar como Não contatar'));
  browserForcado.check(browserForcado.by.label(browserForcado.root, 'Entendo que esta ação é terminal e não pode ser desfeita.'));
  browserForcado.click(browserForcado.by.button(browserForcado.root, 'Confirmar: marcar como Não contatar'));
  await browserForcado.flush();
  assert.match(browserForcado.root.textContent, /Sua conta não tem permissão para esta ação\./);
  const recusas = s.fetchImpl.responses.filter((resposta) => resposta.method !== 'GET');
  assert.equal(recusas.length, 2);
  assert.ok(recusas.every((resposta) => resposta.status === 403), 'a API real recusou as duas escritas do closer');
  assert.equal(JSON.stringify(gravados(s)), antes, 'nada foi gravado');
});

// ===========================================================================
// SESSÃO e CONTA
// ===========================================================================
test('[DASH-FULL-6] token que o servidor não reconhece (expirado): a API real responde 401, a renovação devolve o mesmo token, e o painel volta ao login com o aviso — sem dado na tela', async (t) => {
  const s = await subir(t, { token: 'token-expirado-de-teste-nao-real', sementes: [ALFA], hash: '#/crm' });
  assert.ok(s.browser.by.label(s.browser.root, 'E-mail'), 'voltou ao login');
  assert.match(textoDaTela(s.browser), /Sua sessão expirou\. Entre novamente\./);
  assert.doesNotMatch(textoDaTela(s.browser), /Clínica Alfa/);
  assert.ok(s.fetchImpl.responses.every((resposta) => resposta.status === 401));
  assert.deepEqual(s.sdk.calls.signOut, [{ scope: 'local' }]);
});

test('[DASH-FULL-7] usuário INATIVO: a API real responde 403 em /api/me e o painel mostra "sem acesso", sem menu e sem nenhuma chamada ao CRM', async (t) => {
  const s = await subir(t, { usuario: EX_COLABORADOR, usuarios: [BRENO, EX_COLABORADOR], sementes: [ALFA], hash: '#/crm' });
  assert.match(textoDaTela(s.browser), /Esta conta não possui acesso a esta área\./);
  assert.equal(s.browser.by.tag(s.browser.root, 'nav').length, 0);
  assert.doesNotMatch(textoDaTela(s.browser), /Clínica Alfa/);
  assert.deepEqual(s.fetchImpl.calls.map((chamada) => chamada.path), ['/api/me']);
});

test('[DASH-FULL-8] logout depois de usar o CRM: a página do login não guarda nenhum dado de CRM, e um novo painel aberto com outro usuário não enxerga a tela do anterior', async (t) => {
  const s = await subir(t, { sementes: [ALFA, BETA], hash: '#/crm' });
  assert.match(textoDaTela(s.browser), /Clínica Alfa Teste/);
  s.browser.click(s.browser.by.link(s.browser.root, 'Clínica Alfa Teste'));
  await s.browser.flush();
  assert.match(textoDaTela(s.browser), /Histórico/);
  await clicar(s, 'Sair');
  const texto = textoDaTela(s.browser);
  for (const dado of ['Clínica Alfa', 'Clínica Beta', 'alfa.example.test', 'Petrópolis', 'Histórico', BRENO.name]) assert.ok(!texto.includes(dado), `"${dado}" sobrou depois do logout`);
  assert.ok(s.browser.by.label(s.browser.root, 'E-mail'));
});
