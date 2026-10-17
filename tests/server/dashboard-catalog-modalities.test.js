// A interface das MODALIDADES DE PAGAMENTO dos Serviços (CRM 5.0, Fase C1 — decisão 0027): como a lista mostra as formas de pagamento de um serviço, como o grupo de caixas
// de seleção se comporta (foco, teclado, ocupado, acessibilidade, erro), a variante do serviço LEGADO sem informação e a responsividade (CSS). DOM de teste e API falsa em memória:
// nenhum navegador, nenhuma rede, nenhum dado real. As jornadas de criar/editar de ponta a ponta estão em dashboard-catalog-screens.test.js (CATSCR-5 a 9) e, sobre o servidor real,
// em dashboard-catalog-fullstack.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../helpers/catalogHarness');
const { servico, apiFalsa, abrir, gaveta, botao, campo, erroDoCampo, linhas, linhaDe, acao, avisos, texto, clicar, digitar, marcar, salvar, emFoco } = H;
const { focusables } = require('../helpers/fakeDom');

const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const CSS_SEM_COMENTARIOS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const mesmo = (a, b, mensagem) => assert.ok(a === b, mensagem || 'deveria ser o mesmo elemento');

const TODAS = ['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'];
const SERVICOS = () => [
  servico(1, { nome: 'Só único', permitePagamentoUnico: true }),
  servico(2, { nome: 'Só recorrente', permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['MENSAL'] }),
  servico(3, { nome: 'Os dois, tudo', permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: TODAS }),
  servico(4, { nome: 'Legado sem informação', permitePagamentoUnico: false, tipoCobranca: 'RECORRENTE', recorrencia: 'MENSAL' }),
  servico(5, { nome: 'Dois periodos', permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['SEMESTRAL', 'ANUAL'] }),
];

test('[CATMODUI-1] A LISTA mostra TODAS as formas de pagamento de um serviço numa só linha (o serviço não se repete); o legado sem informação diz isso, em vez de inventar uma modalidade', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: SERVICOS() }) });
  assert.equal(linhas(s).length, 5, 'um serviço, uma linha — mesmo com várias modalidades');
  assert.match(linhaDe(s, 'service:1').textContent, /Pagamento único(?! \+)/);
  assert.match(linhaDe(s, 'service:2').textContent, /Pagamento recorrente \(mensal\)/);
  assert.doesNotMatch(linhaDe(s, 'service:2').textContent, /Pagamento único/);
  assert.match(linhaDe(s, 'service:3').textContent, /Pagamento único \+ Pagamento recorrente \(mensal, trimestral, semestral, anual\)/);
  assert.match(linhaDe(s, 'service:5').textContent, /Pagamento recorrente \(semestral, anual\)/);
  assert.match(linhaDe(s, 'service:4').textContent, /Modalidades de pagamento não informadas/);
  assert.doesNotMatch(linhaDe(s, 'service:4').textContent, /recorrente|mensal|único/i, 'o tipo antigo (legado) não vira modalidade na tela');
  assert.doesNotMatch(texto(s), /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/);
  // as periodicidades aparecem sempre na ordem canônica, mesmo que o servidor as devolva embaralhadas
  const embaralhado = await abrir({ api: apiFalsa({ servicos: [servico(1, { nome: 'Bagunça', permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['ANUAL', 'MENSAL', 'SEMESTRAL'] })] }) });
  assert.match(linhaDe(embaralhado, 'service:1').textContent, /Pagamento recorrente \(mensal, semestral, anual\)/);
  // valores inesperados (lixo vindo de fora) nunca viram texto na tela
  const lixo = await abrir({ api: apiFalsa({ servicos: [servico(1, { nome: 'Lixo', permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['QUINZENAL', 'MENSAL', 7, null] })] }) });
  assert.match(linhaDe(lixo, 'service:1').textContent, /Pagamento recorrente \(mensal\)/);
  assert.doesNotMatch(linhaDe(lixo, 'service:1').textContent, /QUINZENAL|quinzenal|7/);
});

test('[CATMODUI-2] O GRUPO de formas de pagamento: duas caixas e, só com o recorrente marcado, as quatro periodicidades; tudo com rótulo, agrupado e alcançável pelo teclado na ordem da tela', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: SERVICOS() }) });
  await clicar(s, botao(s, 'Novo Serviço'));
  const g = gaveta(s);
  const grupo = campo(s, 'modalidades');
  assert.equal(grupo.localName, 'fieldset');
  const legenda = s.browser.find(grupo, (el) => el.localName === 'legend');
  assert.equal(legenda.textContent, 'Formas de pagamento permitidas');
  assert.match(grupo.getAttribute('aria-describedby'), /catalog-field-modalidades-help/);
  assert.match(grupo.getAttribute('aria-describedby'), /catalog-field-modalidades-error/);
  assert.match(g.textContent, /Quem escolhe entre elas, o prazo e o valor é cada negociação com o cliente; isto só define o que o serviço permite\./, 'a tela diz de quem são o prazo e o valor');
  // rótulos reais ligados às caixas (clicar no texto é o mesmo que clicar na caixa)
  for (const [nome, rotulo] of [['permitePagamentoUnico', 'Permitir pagamento único'], ['permitePagamentoRecorrente', 'Permitir pagamento recorrente'], ['periodicidades-mensal', 'Mensal'], ['periodicidades-trimestral', 'Trimestral'], ['periodicidades-semestral', 'Semestral'], ['periodicidades-anual', 'Anual']]) {
    mesmo(s.browser.by.label(g, rotulo), campo(s, nome), rotulo);
    assert.equal(campo(s, nome).type, 'checkbox', nome);
  }
  // as periodicidades escondidas não entram no teclado; com o recorrente marcado, entram — logo depois dele
  const ordem = () => focusables(g).map((el) => el.getAttribute('id'));
  assert.deepEqual(ordem().filter((id) => /permite|periodicidades/.test(id || '')), ['catalog-field-permitePagamentoUnico', 'catalog-field-permitePagamentoRecorrente']);
  marcar(s, 'permitePagamentoRecorrente');
  assert.deepEqual(ordem().filter((id) => /permite|periodicidades/.test(id || '')), ['catalog-field-permitePagamentoUnico', 'catalog-field-permitePagamentoRecorrente', 'catalog-field-periodicidades-mensal', 'catalog-field-periodicidades-trimestral', 'catalog-field-periodicidades-semestral', 'catalog-field-periodicidades-anual']);
  // espaço/clique marca e desmarca; teclado: o Enter dentro do formulário não salva por engano uma caixa sem nome
  marcar(s, 'periodicidades-semestral');
  assert.equal(campo(s, 'periodicidades-semestral').checked, true);
  marcar(s, 'periodicidades-semestral', false);
  assert.equal(campo(s, 'periodicidades-semestral').checked, false);
  // desmarcar o recorrente esconde e LIMPA (nunca sobra periodicidade sem recorrente)
  marcar(s, 'periodicidades-anual');
  marcar(s, 'permitePagamentoRecorrente', false);
  assert.equal(campo(s, 'periodicidades').hidden, true);
  assert.deepEqual(TODAS.map((v) => campo(s, `periodicidades-${v.toLowerCase()}`).checked), [false, false, false, false]);
  marcar(s, 'permitePagamentoRecorrente');
  assert.deepEqual(TODAS.map((v) => campo(s, `periodicidades-${v.toLowerCase()}`).checked), [false, false, false, false], 'marcar de novo começa sem periodicidade escolhida');
});

test('[CATMODUI-3] OCUPADO: enquanto salva, todas as caixas ficam desabilitadas; uma falha as libera e mantém exatamente o que estava marcado', async () => {
  const api = apiFalsa({ servicos: SERVICOS() });
  const s = await abrir({ api });
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Pacote');
  marcar(s, 'permitePagamentoUnico');
  marcar(s, 'permitePagamentoRecorrente');
  marcar(s, 'periodicidades-mensal');
  marcar(s, 'periodicidades-anual');
  const pausa = api.pausar('criar');
  s.browser.click(botao(s, 'Salvar', gaveta(s)));
  await s.browser.flush(4);
  for (const nome of ['permitePagamentoUnico', 'permitePagamentoRecorrente', ...TODAS.map((v) => `periodicidades-${v.toLowerCase()}`)]) assert.equal(campo(s, nome).disabled, true, `${nome} desabilitada enquanto salva`);
  assert.equal(api.quantas('criar'), 1);
  api.mem.falhas.criar = await H.erroApi(500, 'INTERNAL');
  pausa.liberar();
  await s.browser.flush(8);
  for (const nome of ['permitePagamentoUnico', 'permitePagamentoRecorrente', ...TODAS.map((v) => `periodicidades-${v.toLowerCase()}`)]) assert.equal(campo(s, nome).disabled, false, `${nome} liberada após a falha`);
  assert.deepEqual(['permitePagamentoUnico', 'permitePagamentoRecorrente'].map((n) => campo(s, n).checked), [true, true]);
  assert.deepEqual(TODAS.map((v) => campo(s, `periodicidades-${v.toLowerCase()}`).checked), [true, false, false, true], 'nada que foi marcado se perdeu');
  assert.deepEqual(avisos(s), []);
});

test('[CATMODUI-4] O ERRO do grupo é anunciado (role alert), fica junto do grupo, leva o foco para a primeira caixa e some ao marcar uma forma; o de periodicidade fica junto da lista', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: SERVICOS() }) });
  await clicar(s, botao(s, 'Novo Serviço'));
  digitar(s, campo(s, 'nome'), 'Sem forma');
  await salvar(s);
  const erro = erroDoCampo(s, 'modalidades');
  assert.equal(erro.hidden, false);
  assert.equal(erro.getAttribute('role'), 'alert');
  assert.equal(erro.textContent, 'Marque pelo menos uma forma de pagamento: único, recorrente ou os dois.');
  mesmo(emFoco(s), campo(s, 'permitePagamentoUnico'), 'o foco vai ao começo do grupo com problema');
  marcar(s, 'permitePagamentoUnico');
  assert.equal(erroDoCampo(s, 'modalidades').hidden, true, 'marcar o pagamento único também limpa o erro do grupo');
  marcar(s, 'permitePagamentoUnico', false);
  marcar(s, 'permitePagamentoRecorrente');
  assert.equal(erroDoCampo(s, 'modalidades').hidden, true, 'marcar uma forma limpa o erro do grupo');
  await salvar(s);
  const erroP = erroDoCampo(s, 'periodicidades');
  assert.equal(erroP.hidden, false);
  assert.equal(erroP.getAttribute('role'), 'alert');
  assert.match(campo(s, 'periodicidades').getAttribute('aria-describedby'), /catalog-field-periodicidades-error/);
  mesmo(emFoco(s), campo(s, 'periodicidades-mensal'), 'o foco vai à primeira periodicidade');
  marcar(s, 'periodicidades-trimestral');
  assert.equal(erroDoCampo(s, 'periodicidades').hidden, true, 'escolher uma periodicidade limpa o erro');
});

test('[CATMODUI-5] EDITAR: o serviço com modalidades abre com elas marcadas; o LEGADO sem informação abre desmarcado, com a explicação de que nada é preenchido sozinho, sem asterisco de obrigatório e sem nenhum campo antigo', async () => {
  const api = apiFalsa({ servicos: SERVICOS() });
  const s = await abrir({ api });
  await clicar(s, acao(s, 'service:3', 'edit'));
  assert.deepEqual(['permitePagamentoUnico', 'permitePagamentoRecorrente'].map((n) => campo(s, n).checked), [true, true]);
  assert.deepEqual(TODAS.map((v) => campo(s, `periodicidades-${v.toLowerCase()}`).checked), [true, true, true, true]);
  assert.doesNotMatch(gaveta(s).textContent, /ainda não tem as formas de pagamento/);
  await clicar(s, botao(s, 'Cancelar', gaveta(s)));

  await clicar(s, acao(s, 'service:4', 'edit'));
  assert.deepEqual(['permitePagamentoUnico', 'permitePagamentoRecorrente'].map((n) => campo(s, n).checked), [false, false], 'o RECORRENTE/MENSAL antigo NÃO vira modalidade');
  assert.equal(campo(s, 'periodicidades').hidden, true);
  assert.match(gaveta(s).textContent, /Este serviço ainda não tem as formas de pagamento informadas\. Marque as que valem para ele: uma ou as duas\. Nada é preenchido automaticamente\./);
  assert.doesNotMatch(s.browser.find(campo(s, 'modalidades'), (el) => el.localName === 'legend').className, /\brequired\b/, 'na edição de um legado a escolha não é obrigatória');
  assert.equal(campo(s, 'tipoCobranca'), null);
  assert.equal(campo(s, 'recorrencia'), null);
  // abrir e salvar sem mexer não envia nada nem obriga a escolher
  await salvar(s);
  assert.match(gaveta(s).textContent, /Nenhuma alteração foi feita\./);
  assert.equal(api.escritas().length, 0);
  // completar: só marcar uma forma e salvar — vão as três juntas
  marcar(s, 'permitePagamentoRecorrente');
  marcar(s, 'periodicidades-trimestral');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[0].slice(2), ['service:4', { permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['TRIMESTRAL'] }]);
  assert.match(linhaDe(s, 'service:4').textContent, /Pagamento recorrente \(trimestral\)/);
  assert.equal(gaveta(s), null);
});

test('[CATMODUI-6] RESPONSIVIDADE e TEMA (CSS): o grupo é uma grade que encolhe (min-width 0, sem largura fixa), a lista de periodicidades recua sob o recorrente e some com [hidden]; os textos longos quebram; a linha da lista quebra; o rodapé do painel ocupa a largura no celular', () => {
  const regra = (seletor) => {
    const achada = [...CSS_SEM_COMENTARIOS.matchAll(/^([^{}\n@][^{}]*)\{([^}]*)\}/gm)].filter((m) => m[1].split(',').map((x) => x.trim()).includes(seletor));
    assert.ok(achada.length > 0, `regra ${seletor}`);
    return achada.map((m) => m[2]).join(' ');
  };
  const grupo = regra('.catalog-form .modality-group');
  assert.match(grupo, /display:\s*grid/);
  assert.match(grupo, /min-width:\s*0/);
  const periodicidades = regra('.catalog-form .modality-periodicities');
  assert.match(periodicidades, /display:\s*grid/);
  assert.match(periodicidades, /min-width:\s*0/);
  assert.match(regra('.catalog-form .modality-periodicities[hidden]'), /display:\s*none/);
  assert.match(regra('.catalog-form .modality-option'), /display:\s*flex/);
  for (const seletor of ['.catalog-form .modality-group', '.catalog-form .modality-periodicities', '.catalog-form .modality-option']) {
    assert.doesNotMatch(regra(seletor), /(?:^|[\s;])(?:width|min-width|max-width):\s*(?!0\b)\d+px/, `${seletor}: nenhuma largura fixa que estoure um painel estreito`);
  }
  // as cores vêm de variáveis do tema (nada de cor fixa nas regras novas)
  const novas = [grupo, periodicidades, regra('.catalog-form .modality-group > legend.required::after'), regra('.catalog-form .modality-option')].join(' ');
  assert.doesNotMatch(novas, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  // a linha da lista e o texto longo (todas as modalidades + periodicidades) quebram em vez de estourar
  assert.match(regra('.catalog-row'), /flex-wrap:\s*wrap/);
  assert.match(regra('.catalog-meta'), /overflow-wrap:\s*anywhere/);
  assert.match(regra('.catalog-row-main'), /min-width:\s*0/);
  // o rótulo da caixa quebra e a caixa não encolhe
  assert.match(regra('.catalog-form .modality-option label'), /overflow-wrap:\s*anywhere/);
  assert.match(regra('.catalog-form .modality-option input'), /flex:\s*none/);
  // no celular os botões do painel ocupam a largura
  const celular = /@media \(max-width: 760px\) \{\n  \.catalog-row-actions \{[\s\S]*?\.catalog-form-actions \.btn \{ flex: 1 1 100%; \}\n\}/.exec(CSS);
  assert.ok(celular, 'a regra de celular dos cadastros continua');
});
