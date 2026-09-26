// FLUXO COMERCIAL do CRM — o funil de vendas inteiro e os campos de acompanhamento, pela API real e pela interface (Dashboard sobre
// a API real). Complementa os testes por rota e por tela: aqui o que se prova é o CAMINHO COMPLETO que um comercial percorre,
//
//   PROSPECT -> CONTACTED -> RESPONDED -> QUALIFICATION -> MEETING_SCHEDULED -> MEETING_COMPLETED -> PROPOSAL -> NEGOTIATION -> WON | LOST
//
// com histórico, autor (sempre o do token), motivo, DNC no meio e depois do funil, e os campos Responsável, Próxima ação, Data da próxima
// ação, Última interação, Data da reunião, Link do Meet e Observações — que precisam sobreviver a "atualizar a página" (um painel novo
// sobre o mesmo arquivo). Nenhuma regra de negócio nova: a máquina de estados é a do domínio (src/crm/constants.js), só é exercitada.
//
// Só dados sintéticos (example.test); CRM e fila em diretório temporário removido no fim; nenhum navegador, credencial ou rede reais.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { createJsonFileCrmRepository } = require('../../src/crm/crmRepository');
const { CRM_STATUS, CRM_STATUS_LABEL, ALLOWED_TRANSITIONS } = require('../../src/crm/constants');
const { createBrowser } = require('../helpers/fakeDom');
const { FAKE_ENV } = require('../helpers/authFixtures');
const { montarAmbiente, BRENO, RAFAEL } = require('./testEnv');

const CONFIG = { supabaseUrl: FAKE_ENV.SUPABASE_URL, supabaseAnonKey: FAKE_ENV.SUPABASE_ANON_KEY };
const loadFixtures = () => import('../helpers/dashboardFixtures.mjs');
const enc = encodeURIComponent;

const FUNIL = ['PROSPECT', 'CONTACTED', 'RESPONDED', 'QUALIFICATION', 'MEETING_SCHEDULED', 'MEETING_COMPLETED', 'PROPOSAL', 'NEGOTIATION'];
const FUNIL_COMPLETO = [...FUNIL, 'WON'];

function ambiente(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx7-fluxo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = montarAmbiente(t, { usuarios: [BRENO, RAFAEL], crm: true, crmFilePath: path.join(dir, 'crm.json'), queue: { filePath: path.join(dir, 'approval-queue.json'), ids: {} } });
  const chamar = async (usuario, method, url, body) => {
    const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.headers = { authorization: `Bearer ${env.tokenFor(usuario.userId)}` };
    if (body !== undefined) req.headers['content-type'] = 'application/json';
    const resposta = await env.app.handle(req);
    return { status: resposta.status, json: JSON.parse(resposta.body) };
  };
  const lidos = () => createJsonFileCrmRepository(env.crmFilePath).list();
  return { env, dir, chamar, lidos };
}

async function novoLead(a, campos = {}) {
  const r = await a.chamar(BRENO, 'POST', '/api/crm', { empresa: 'Clínica Funil Teste', site: 'funil.example.test', telefone: '24 90000-7001', cidade: 'Petrópolis', estado: 'RJ', nicho: 'Psicologia', ...campos });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.item.id;
}

// ===========================================================================
// API: o funil inteiro
// ===========================================================================
test('[FLUXO-1] funil completo pela API (PROSPECT -> ... -> WON): cada passo é aceito, entra no histórico com autor do token e motivo, e o registro termina em WON', async (t) => {
  const a = ambiente(t);
  const id = await novoLead(a);
  for (let i = 1; i < FUNIL_COMPLETO.length; i += 1) {
    const r = await a.chamar(BRENO, 'POST', `/api/crm/${enc(id)}/status`, { to: FUNIL_COMPLETO[i], reason: `Passo ${i} (teste)` });
    assert.deepEqual([r.status, r.json.item.status], [200, FUNIL_COMPLETO[i]], `${FUNIL_COMPLETO[i - 1]} -> ${FUNIL_COMPLETO[i]}`);
  }
  const { json } = await a.chamar(BRENO, 'GET', `/api/crm/${enc(id)}/history`);
  assert.deepEqual(json.historico.map((h) => h.to), FUNIL_COMPLETO, 'a ordem do histórico é a do funil');
  assert.deepEqual(json.historico.map((h) => h.from), [null, ...FUNIL_COMPLETO.slice(0, -1)]);
  json.historico.forEach((h, i) => {
    assert.equal(h.actor, 'HUMAN');
    assert.equal(h.reviewedBy.userId, BRENO.userId, 'o autor é o dono do token');
    assert.equal(h.motivo, i === 0 ? null : `Passo ${i} (teste)`);
  });
  const timestamps = json.historico.map((h) => h.timestamp);
  assert.deepEqual([...timestamps].sort(), timestamps, 'os eventos estão em ordem cronológica');
  assert.equal(a.lidos()[0].status, 'WON');
});

test('[FLUXO-2] o funil aceita voltar e pular etapas; WON e LOST só vão para DO_NOT_CONTACT; DO_NOT_CONTACT não sai — e nenhuma recusa deixa rastro no histórico', async (t) => {
  const a = ambiente(t);
  const mover = (id, to) => a.chamar(BRENO, 'POST', `/api/crm/${enc(id)}/status`, { to, reason: 'teste' });
  const historico = async (id) => (await a.chamar(BRENO, 'GET', `/api/crm/${enc(id)}/history`)).json.historico.length;

  const meio = await novoLead(a, { empresa: 'Lead Meio Teste', site: 'meio.example.test', telefone: '24 90000-7002' });
  assert.equal((await mover(meio, 'NEGOTIATION')).status, 200, 'pular etapas do funil');
  assert.equal((await mover(meio, 'RESPONDED')).status, 200, 'voltar no funil (corrigir um arraste)');
  assert.equal((await mover(meio, 'LOST')).status, 200);
  const antes = await historico(meio);
  for (const to of [...FUNIL, 'WON']) assert.deepEqual([(await mover(meio, to)).status, to], [409, to], `LOST não volta para ${to}`);
  assert.equal(await historico(meio), antes, 'as recusas não criaram evento');
  assert.equal((await mover(meio, 'DO_NOT_CONTACT')).status, 200, 'LOST -> DNC é permitido');

  const ganho = await novoLead(a, { empresa: 'Lead Ganho Teste', site: 'ganho.example.test', telefone: '24 90000-7003' });
  assert.equal((await mover(ganho, 'WON')).status, 200);
  for (const to of [...FUNIL, 'LOST']) assert.equal((await mover(ganho, to)).status, 409, `WON não vai para ${to}`);
  assert.equal((await mover(ganho, 'DO_NOT_CONTACT')).status, 200, 'WON -> DNC é permitido');

  const bloqueado = a.lidos().find((r) => r.id === meio);
  assert.equal(bloqueado.status, 'DO_NOT_CONTACT');
  for (const to of Object.values(CRM_STATUS)) assert.equal((await mover(meio, to)).status, 409, `DNC é terminal: ${to}`);
  assert.equal((await a.chamar(BRENO, 'PATCH', `/api/crm/${enc(meio)}`, { nicho: 'x' })).json.error.code, 'RECORD_LOCKED');

  // a tabela de transições do domínio é exatamente o que a API aplicou (nenhuma exceção escondida)
  assert.deepEqual(ALLOWED_TRANSITIONS.WON, ['DO_NOT_CONTACT']);
  assert.deepEqual(ALLOWED_TRANSITIONS.LOST, ['DO_NOT_CONTACT']);
  assert.equal(Object.hasOwn(ALLOWED_TRANSITIONS, 'DO_NOT_CONTACT'), false);
});

test('[FLUXO-3] DNC no meio do funil: de qualquer etapa o lead pode ser bloqueado, e a identidade dele passa a barrar um novo cadastro (site, telefone) mesmo com outro nome', async (t) => {
  const a = ambiente(t);
  for (const [i, etapa] of FUNIL.slice(1).entries()) {
    const id = await novoLead(a, { empresa: `Lead ${etapa} Teste`, site: `etapa${i}.example.test`, telefone: `24 90000-71${String(i).padStart(2, '0')}` });
    assert.equal((await a.chamar(BRENO, 'POST', `/api/crm/${enc(id)}/status`, { to: etapa })).status, 200);
    const dnc = await a.chamar(BRENO, 'POST', `/api/crm/${enc(id)}/dnc`, { reason: 'Pediu para sair (teste)' });
    assert.deepEqual([dnc.status, dnc.json.item.status], [200, 'DO_NOT_CONTACT'], `DNC a partir de ${etapa}`);
    const historico = (await a.chamar(BRENO, 'GET', `/api/crm/${enc(id)}/history`)).json.historico;
    assert.deepEqual([historico.at(-1).from, historico.at(-1).to, historico.at(-1).motivo], [etapa, 'DO_NOT_CONTACT', 'Pediu para sair (teste)']);
    const recadastro = await a.chamar(BRENO, 'POST', '/api/crm', { empresa: 'Outro Nome Teste', site: `etapa${i}.example.test` });
    assert.deepEqual([recadastro.status, recadastro.json.error.code], [409, 'DNC_BLOCKED'], `o site de ${etapa} continua bloqueado`);
  }
});

// ===========================================================================
// Dashboard: o funil pela interface
// ===========================================================================
async function subirPainel(env, usuario, hash = '') {
  const { startDashboard } = await import('../../dashboard/main.mjs');
  const { browserNavigation } = await import('../../dashboard/router.mjs');
  const { createFakeSdk, bridgeFetch } = await loadFixtures();
  const browser = createBrowser({ hash });
  const bridge = bridgeFetch(env.app);
  const fetchImpl = async (caminho, init) => (caminho === '/config.json' ? new Response(JSON.stringify(CONFIG), { status: 200 }) : bridge(caminho, init));
  fetchImpl.calls = bridge.calls;
  const sdk = createFakeSdk({ session: { access_token: env.tokenFor(usuario.userId), refresh_token: 'refresh-de-teste-nao-real', user: { id: usuario.authUserId } } });
  await startDashboard({ document: browser.document, root: browser.root, fetchImpl, sdk, navigation: browserNavigation(browser.window) });
  await browser.flush(12);
  return { browser, fetchImpl };
}
const tela = (painel) => {
  const texto = painel.browser.root.textContent.replace(/\s+/g, ' ');
  assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
  return texto;
};
const clicar = async (s, texto) => {
  const botao = s.browser.by.button(s.browser.root, texto);
  assert.ok(botao, `botão "${texto}" não encontrado`);
  s.browser.click(botao);
  await s.browser.flush(12);
};
const irPara = async (s, hash) => {
  s.browser.window.location.hash = hash;
  await s.browser.flush(12);
};
const linhasDoHistorico = (s) => s.browser.by.tag(s.browser.by.cls(s.browser.root, 'timeline')[0], 'li').map((li) => li.textContent.replace(/\s+/g, ' '));

test('[FLUXO-4] funil completo pela interface: cada "Mudar status" aparece na ficha, no histórico (com motivo e autor), na lista filtrada e na Visão Geral; o lead termina em Won', async (t) => {
  const a = ambiente(t);
  const id = await novoLead(a);
  const s = await subirPainel(a.env, BRENO, `#/crm/registro/${enc(id)}`);
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Clínica Funil Teste');

  for (let i = 1; i < FUNIL_COMPLETO.length; i += 1) {
    const para = FUNIL_COMPLETO[i];
    await clicar(s, 'Mudar status');
    s.browser.choose(s.browser.by.label(s.browser.root, 'Novo status'), para);
    s.browser.type(s.browser.by.label(s.browser.root, 'Motivo (opcional)'), `Motivo do passo ${i}`);
    await clicar(s, 'Confirmar mudança');
    assert.match(tela(s), new RegExp(`Status alterado para ${CRM_STATUS_LABEL[para]}\\.`), para);
    const itens = linhasDoHistorico(s);
    assert.equal(itens.length, i + 1, 'um evento novo por passo');
    assert.match(itens[0], new RegExp(`^${CRM_STATUS_LABEL[FUNIL_COMPLETO[i - 1]]} → ${CRM_STATUS_LABEL[para]}`), 'o mais recente primeiro');
    assert.match(itens[0], new RegExp(`Motivo do passo ${i}`));
    assert.match(itens[0], /Breno Bento \(Administrador\)/);
  }
  assert.equal(a.lidos()[0].status, 'WON');

  // a lista (um painel novo = "atualizar a página"): filtro por status encontra o lead
  const lista = await subirPainel(a.env, BRENO, '#/crm');
  lista.browser.choose(lista.browser.by.label(lista.browser.root, 'Status'), 'WON');
  assert.match(tela(lista), /Clínica Funil Teste/);
  lista.browser.choose(lista.browser.by.label(lista.browser.root, 'Status'), 'PROSPECT');
  assert.match(tela(lista), /Nenhum registro encontrado/);

  // a Visão Geral acompanha: 1 registro, em Ganho
  const geral = await subirPainel(a.env, BRENO, '#/');
  assert.match(tela(geral), /Leads no CRM\s*1/);
  const contagem = Object.fromEntries(geral.browser.by.cls(geral.browser.root, 'pipeline-row').map((li) => [geral.browser.by.cls(li, 'badge')[0].textContent, geral.browser.by.cls(li, 'pipeline-count')[0].textContent]));
  assert.equal(contagem.Ganho, '1');
  assert.equal(Object.entries(contagem).filter(([, n]) => n !== '0').length, 1, 'nenhum outro status tem registro');
});

test('[FLUXO-5] pela interface: um lead Won ou Lost não pode voltar ao funil — o servidor recusa com a frase própria da tela, e nada entra no histórico; "Não contatar" continua possível', async (t) => {
  const a = ambiente(t);
  const id = await novoLead(a);
  assert.equal((await a.chamar(BRENO, 'POST', `/api/crm/${enc(id)}/status`, { to: 'LOST', reason: 'Sem interesse (teste)' })).status, 200);
  const s = await subirPainel(a.env, BRENO, `#/crm/registro/${enc(id)}`);
  const antes = linhasDoHistorico(s).length;
  await clicar(s, 'Mudar status');
  s.browser.choose(s.browser.by.label(s.browser.root, 'Novo status'), 'PROSPECT');
  await clicar(s, 'Confirmar mudança');
  assert.match(tela(s), /Esta mudança de status não é permitida a partir do status atual./);
  assert.equal(a.lidos()[0].status, 'LOST');
  assert.equal(a.lidos()[0].historico.length, antes, 'a recusa não criou evento');
  // o caminho que sobra é o do DNC, com aviso e confirmação
  assert.ok(s.browser.by.button(s.browser.root, 'Marcar como Não contatar'));
});

test('[FLUXO-6] COMMERCIAL_CLOSER pela interface: percorre a ficha e o histórico de um lead no meio do funil, mas nenhuma escrita é oferecida — e a API recusa a mudança de status com 403', async (t) => {
  const a = ambiente(t);
  const id = await novoLead(a);
  await a.chamar(BRENO, 'POST', `/api/crm/${enc(id)}/status`, { to: 'QUALIFICATION', reason: 'Conversa boa (teste)' });
  const s = await subirPainel(a.env, RAFAEL, `#/crm/registro/${enc(id)}`);
  assert.match(tela(s), /Qualification/);
  assert.match(linhasDoHistorico(s)[0], /Conversa boa \(teste\)/);
  for (const botao of ['Editar', 'Mudar status', 'Marcar como Não contatar']) assert.equal(s.browser.by.button(s.browser.root, botao), null, botao);
  const antes = fs.readFileSync(a.env.crmFilePath, 'utf8');
  const r = await a.chamar(RAFAEL, 'POST', `/api/crm/${enc(id)}/status`, { to: 'PROPOSAL' });
  assert.deepEqual([r.status, r.json.error.code], [403, 'FORBIDDEN']);
  assert.equal(fs.readFileSync(a.env.crmFilePath, 'utf8'), antes);
});

// ===========================================================================
// Campos de acompanhamento: Responsável, Próxima ação, datas, Meet, Observações
// ===========================================================================
const CAMPOS = Object.freeze({
  responsavel: 'Rafael',
  proximaAcao: 'Ligar para confirmar a reunião',
  dataDaProximaAcao: '2026-10-03',
  ultimaInteracao: '2026-09-25',
  dataDaReuniao: '2026-10-07',
  linkDoMeet: 'https://meet.example.test/abc-defg-hij',
  observacoes: 'Prefere contato pela manhã.\nDecisora: a própria psicóloga.',
});

async function preencher(s, valores) {
  const { FIELD_GROUPS } = await import('../../dashboard/crm-model.mjs');
  const campos = FIELD_GROUPS.flatMap((grupo) => grupo.fields);
  for (const [chave, valor] of Object.entries(valores)) {
    const campo = campos.find((entry) => entry.key === chave);
    const controle = s.browser.by.label(s.browser.root, campo.required ? `${campo.label} (obrigatório)` : campo.label);
    assert.ok(controle, `campo "${campo.label}" não encontrado`);
    s.browser.type(controle, valor);
  }
}

test('[FLUXO-7] campos de acompanhamento: criados pela interface, gravados, exibidos na ficha (datas em dd/mm/aaaa, sem deslocar o dia), na lista, e iguais depois de "atualizar a página"', async (t) => {
  const a = ambiente(t);
  const s = await subirPainel(a.env, BRENO, '#/crm/novo');
  await preencher(s, { empresa: 'Clínica Acompanhamento Teste', site: 'acomp.example.test', telefone: '24 90000-7010', ...CAMPOS });
  await clicar(s, 'Criar registro');
  assert.match(tela(s), /Registro criado\./);
  const [gravado] = a.lidos();
  for (const [campo, valor] of Object.entries(CAMPOS)) assert.equal(gravado[campo], valor, `${campo} gravado`);

  const conferirFicha = (painel) => {
    const texto = tela(painel);
    assert.match(texto, /Rafael/);
    assert.match(texto, /Ligar para confirmar a reunião/);
    assert.match(texto, /03\/10\/2026/, 'data da próxima ação sem deslocar o dia');
    assert.match(texto, /25\/09\/2026/, 'última interação');
    assert.match(texto, /07\/10\/2026/, 'data da reunião');
    assert.match(texto, /Prefere contato pela manhã\./);
    assert.match(texto, /Decisora: a própria psicóloga\./, 'a segunda linha das observações não se perde');
    const link = painel.browser.by.link(painel.browser.root, CAMPOS.linkDoMeet);
    assert.ok(link, 'o link do Meet é um link');
    assert.equal(link.href, CAMPOS.linkDoMeet);
  };
  conferirFicha(s);

  // atualizar a página: um painel novo sobre o mesmo arquivo
  const id = gravado.id;
  conferirFicha(await subirPainel(a.env, BRENO, `#/crm/registro/${enc(id)}`));

  // a lista mostra responsável, próxima ação e a data dela, e o filtro por responsável acha o lead
  const lista = await subirPainel(a.env, BRENO, '#/crm');
  const textoLista = tela(lista);
  assert.match(textoLista, /Rafael/);
  assert.match(textoLista, /Ligar para confirmar a reunião/);
  assert.match(textoLista, /03\/10\/2026/);
  lista.browser.choose(lista.browser.by.label(lista.browser.root, 'Responsável'), 'Rafael');
  assert.match(tela(lista), /Clínica Acompanhamento Teste/);
});

test('[FLUXO-8] editar a próxima ação e o responsável: o novo valor persiste e aparece depois de atualizar; limpar um campo (texto vazio) o remove; e editar campos NÃO mexe no status nem no histórico', async (t) => {
  const a = ambiente(t);
  const id = await novoLead(a, CAMPOS);
  await a.chamar(BRENO, 'POST', `/api/crm/${enc(id)}/status`, { to: 'MEETING_SCHEDULED', reason: 'Reunião marcada (teste)' });
  const s = await subirPainel(a.env, BRENO, `#/crm/registro/${enc(id)}`);
  const eventos = linhasDoHistorico(s).length;
  await clicar(s, 'Editar');
  await preencher(s, { proximaAcao: 'Enviar a proposta', dataDaProximaAcao: '2026-10-09', responsavel: 'Breno' });
  s.browser.type(s.browser.by.label(s.browser.root, 'Link do Meet'), '');
  await clicar(s, 'Salvar alterações');
  assert.match(tela(s), /Alterações salvas\./);

  const gravado = a.lidos()[0];
  assert.equal(gravado.proximaAcao, 'Enviar a proposta');
  assert.equal(gravado.dataDaProximaAcao, '2026-10-09');
  assert.equal(gravado.responsavel, 'Breno');
  assert.equal(gravado.linkDoMeet, null, 'campo limpo vira vazio');
  assert.equal(gravado.observacoes, CAMPOS.observacoes, 'o que não foi tocado ficou');
  assert.equal(gravado.status, 'MEETING_SCHEDULED');
  assert.equal(gravado.historico.length, eventos, 'editar campos não cria evento de status');

  const depois = await subirPainel(a.env, BRENO, `#/crm/registro/${enc(id)}`);
  const texto = tela(depois);
  assert.match(texto, /Enviar a proposta/);
  assert.match(texto, /09\/10\/2026/);
  assert.doesNotMatch(texto, /Ligar para confirmar a reunião/);
  assert.equal(depois.browser.by.link(depois.browser.root, CAMPOS.linkDoMeet), null, 'o link removido não aparece mais');
});
