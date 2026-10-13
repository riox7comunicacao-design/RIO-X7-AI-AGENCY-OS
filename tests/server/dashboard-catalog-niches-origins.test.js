// As telas de NICHOS E CORES e de ORIGENS DOS LEADS (CRM 5.0, Fase 2B-2): o seletor de 20 cores com prévia, a cor obrigatória em nicho novo (e o nicho legado sem cor tratado com segurança), o
// canal real das origens e a garantia de que nenhuma integração é ativada. DOM de teste e API falsa: nenhum navegador, nenhuma rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');

const { NICHE_COLORS, LEAD_CHANNELS } = require('../../src/crm/catalogConstants');
const H = require('../helpers/catalogHarness');
const { nicho, origem, apiFalsa, abrir, gaveta, confirmacao, botao, campo, erroDoCampo, linhas, linhaDe, nomes, acao, avisos, texto, hash, clicar, digitar, salvar, emFoco, erroApi } = H;

const mesmo = (a, b, mensagem) => assert.ok(a === b, mensagem || 'deveria ser o mesmo elemento');
const grupo = (s) => s.browser.find(gaveta(s), (el) => el.getAttribute('role') === 'radiogroup');
const radios = (s) => s.browser.findAll(grupo(s), (el) => el.getAttribute('role') === 'radio');
const radio = (s, chave) => radios(s).find((el) => el.getAttribute('data-color') === chave);
const previa = (s) => s.browser.find(gaveta(s), (el) => /\bpreview-card\b/.test(el.className));
const chipDaPrevia = (s) => s.browser.find(previa(s), (el) => /\bnicho-chip\b/.test(el.className));
const marcada = (s) => radios(s).filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.getAttribute('data-color'));
const classeDaLinha = (s, id) => linhaDe(s, id).className.split(/\s+/);
const chipDaLinha = (s, id) => s.browser.find(linhaDe(s, id), (el) => /\bnicho-chip\b/.test(el.className));
const NICHOS = () => [nicho(1, { nome: 'Clínicas de estética', cor: 'rosa' }), nicho(2, { nome: 'Odontologia', cor: 'ciano', descricao: 'Consultórios' }), nicho(3, { nome: 'Legado sem cor', cor: null }), nicho(4, { nome: 'Arquivado', cor: 'verde', ativo: false })];

// ---------------------------------------------------------------------------------------------------------------------------------------------
// NICHOS E CORES
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CATNIC-1] A LISTA de Nichos e Cores: o NOME sempre visível, a cor só por classe de CSS (borda esquerda + chip com o nome da cor); nicho legado sem cor ou com chave inválida fica NEUTRO e honesto', async () => {
  const api = apiFalsa({ nichos: [...NICHOS(), nicho(5, { nome: 'Chave estranha', cor: 'hotpink' })] });
  const s = await abrir({ catalogo: 'nichos', api });
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Nichos e Cores');
  assert.match(texto(s), /O nome do nicho aparece sempre junto da cor\./);
  assert.ok(botao(s, 'Novo Nicho'));
  assert.deepEqual(nomes(s), ['Clínicas de estética', 'Odontologia', 'Legado sem cor', 'Arquivado', 'Chave estranha'], 'o nome está sempre à vista');
  assert.match(texto(s), /5 nichos/);
  assert.deepEqual(api.chamadas, [['listar', 'nichos', { todos: true }]]);

  assert.ok(classeDaLinha(s, 'niche:1').includes('is-niche') && classeDaLinha(s, 'niche:1').includes('cor-rosa'), 'a linha ganha a classe da cor (a borda esquerda vem do CSS)');
  assert.equal(chipDaLinha(s, 'niche:1').textContent, 'Rosa', 'e o chip diz o nome da cor em texto');
  assert.ok(/\bcor-rosa\b/.test(chipDaLinha(s, 'niche:1').className));
  assert.ok(classeDaLinha(s, 'niche:2').includes('cor-ciano'));
  assert.equal(chipDaLinha(s, 'niche:2').textContent, 'Ciano');
  assert.match(linhaDe(s, 'niche:2').textContent, /Consultórios/);

  // legado sem cor: neutro, sem classe de cor, com a explicação em texto
  assert.ok(!classeDaLinha(s, 'niche:3').some((c) => c.startsWith('cor-')), 'nenhuma classe de cor');
  assert.ok(classeDaLinha(s, 'niche:3').includes('is-niche'));
  assert.equal(chipDaLinha(s, 'niche:3').textContent, 'Sem cor definida');
  assert.ok(!/\bcor-/.test(chipDaLinha(s, 'niche:3').className));
  // uma chave fora da paleta nunca vira classe (o servidor não a aceita, mas a tela não confia)
  assert.ok(!classeDaLinha(s, 'niche:5').some((c) => c.startsWith('cor-')));
  assert.equal(chipDaLinha(s, 'niche:5').textContent, 'Sem cor definida');
  // inativo continua com a sua cor, mas aparece como inativo
  assert.ok(classeDaLinha(s, 'niche:4').includes('is-inactive') && classeDaLinha(s, 'niche:4').includes('cor-verde'));
  assert.match(linhaDe(s, 'niche:4').textContent, /Inativo/);

  // segurança: nenhum estilo inline na tela e só classes da paleta aprovada
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.hasAttribute('style')).length, 0);
  const aprovadas = new Set(NICHE_COLORS.map((c) => `cor-${c.chave}`));
  for (const el of s.browser.findAll(s.browser.root, (e) => /\bcor-/.test(e.className))) for (const c of el.className.split(/\s+/).filter((x) => x.startsWith('cor-'))) assert.ok(aprovadas.has(c), c);
});

test('[CATNIC-2] CRIAR nicho: o seletor mostra EXATAMENTE as 20 cores (amostra, nome, estado) SEM opção "sem cor"; a prévia do cartão acompanha o nome e a cor escolhida', async () => {
  const s = await abrir({ catalogo: 'nichos', api: apiFalsa({ nichos: NICHOS() }) });
  await clicar(s, botao(s, 'Novo Nicho'));
  assert.equal(hash(s), '#/crm/configuracoes/nichos/novo');
  assert.equal(s.browser.find(gaveta(s), (el) => el.className === 'overlay-title').textContent, 'Novo nicho');
  assert.equal(radios(s).length, 20, 'exatamente 20 opções');
  assert.deepEqual(radios(s).map((r) => r.getAttribute('data-color')), NICHE_COLORS.map((c) => c.chave));
  assert.deepEqual(marcada(s), [], 'nada escolhido ao começar: a cor é uma decisão da pessoa');
  assert.equal(s.browser.findAll(gaveta(s), (el) => /sem cor|nenhuma cor|remover cor/i.test(el.textContent) && el.localName === 'button').length, 0, 'não há opção "Sem cor" (nem botão de limpar)');
  for (const r of radios(s)) {
    assert.ok(s.browser.find(r, (el) => el.className === 'swatch-name').textContent.length > 0, 'cada opção traz o nome da cor');
    assert.ok(s.browser.find(r, (el) => el.className === 'swatch-dot'), 'e a amostra');
  }
  assert.equal(grupo(s).getAttribute('aria-required'), 'true');
  assert.equal(s.browser.by.label(gaveta(s), 'Nome do nicho'), campo(s, 'nome'));
  assert.equal(campo(s, 'nome').getAttribute('maxlength'), '80');
  assert.equal(campo(s, 'descricao').getAttribute('maxlength'), '500');
  assert.equal(s.browser.findAll(gaveta(s), (el) => ['input', 'select', 'textarea'].includes(el.localName)).length, 2, 'só nome e descrição, além do seletor de cores');

  // a prévia: neutra no começo, depois acompanha
  assert.ok(previa(s));
  assert.ok(!/\bcor-/.test(previa(s).className), 'sem cor escolhida a prévia fica neutra');
  assert.equal(s.browser.find(previa(s), (el) => el.className === 'preview-nicho-name').textContent, 'Nome do nicho');
  assert.match(gaveta(s).textContent, /Nenhuma cor escolhida ainda\./);
  digitar(s, campo(s, 'nome'), '  Psicologia   clínica ');
  assert.equal(s.browser.find(previa(s), (el) => el.className === 'preview-nicho-name').textContent, 'Psicologia clínica', 'o nome aparece na prévia, já limpo');
  await clicar(s, radio(s, 'violeta'));
  assert.ok(/\bcor-violeta\b/.test(previa(s).className), 'a borda esquerda do cartão ganha a classe da cor escolhida');
  assert.ok(/\bcor-violeta\b/.test(chipDaPrevia(s).className));
  assert.equal(previa(s).getAttribute('data-color'), 'violeta');
  assert.match(gaveta(s).textContent, /Cor escolhida: Violeta\./);
  await clicar(s, radio(s, 'laranja'));
  assert.ok(/\bcor-laranja\b/.test(previa(s).className) && !/\bcor-violeta\b/.test(previa(s).className), 'trocar a cor troca a classe');
  assert.deepEqual(marcada(s), ['laranja']);
  assert.equal(s.browser.findAll(gaveta(s), (el) => el.hasAttribute('style')).length, 0, 'nenhum estilo inline');
});

test('[CATNIC-3] CRIAR nicho EXIGE uma das 20 cores: sem escolha o erro aparece junto do seletor e nada é enviado; com a escolha vai SÓ a chave aprovada', async () => {
  const api = apiFalsa({ nichos: NICHOS() });
  const s = await abrir({ catalogo: 'nichos', api });
  await clicar(s, botao(s, 'Novo Nicho'));
  digitar(s, campo(s, 'nome'), 'Advocacia');
  await salvar(s);
  assert.equal(api.escritas().length, 0, 'sem cor nada é enviado');
  assert.equal(s.browser.by.id(s.browser.root, 'catalog-field-cor-error').textContent, 'Escolha uma das 20 cores para identificar o nicho.');
  assert.equal(grupo(s).getAttribute('aria-invalid'), 'true');
  mesmo(emFoco(s), radios(s)[0], 'o foco vai ao seletor (à primeira cor, a entrada do teclado)');

  await clicar(s, radio(s, 'esmeralda'));
  assert.equal(s.browser.by.id(s.browser.root, 'catalog-field-cor-error').hidden, true, 'escolher limpa o erro');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar'), [['criar', 'nichos', { nome: 'Advocacia', cor: 'esmeralda' }]], 'a CHAVE, não um valor de cor');
  assert.equal(gaveta(s), null);
  assert.deepEqual(avisos(s), ['Nicho criado.']);
  assert.ok(classeDaLinha(s, 'niche:novo-4').includes('cor-esmeralda'));
  assert.equal(chipDaLinha(s, 'niche:novo-4').textContent, 'Esmeralda');
  assert.deepEqual(nomes(s).at(-1), 'Advocacia');
  assert.equal(JSON.stringify(api.chamadas).includes('#'), false, 'nenhum valor de cor viaja');
});

test('[CATNIC-4] TECLADO no seletor: Tab entra no grupo, as setas escolhem (e a prévia acompanha), a escolha conta como alteração e o ESC pergunta antes de descartar', async () => {
  const s = await abrir({ catalogo: 'nichos', api: apiFalsa({ nichos: NICHOS() }) });
  await clicar(s, botao(s, 'Novo Nicho'));
  radios(s)[0].focus();
  s.browser.press('ArrowRight');
  assert.deepEqual(marcada(s), ['vermelho']);
  s.browser.press('ArrowRight');
  s.browser.press('ArrowRight');
  assert.deepEqual(marcada(s), ['ambar']);
  assert.ok(/\bcor-ambar\b/.test(previa(s).className));
  mesmo(emFoco(s), radio(s, 'ambar'));
  s.browser.press('End');
  assert.deepEqual(marcada(s), ['ardosia']);
  s.browser.press(' ');
  assert.deepEqual(marcada(s), ['ardosia']);
  // só a cor foi escolhida (o nome está vazio): isso já é alteração não salva
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.ok(confirmacao(s), 'escolher uma cor conta como alteração');
  await clicar(s, botao(s, 'Continuar editando', confirmacao(s)));
  assert.deepEqual(marcada(s), ['ardosia']);
  s.browser.press('Escape');
  await s.browser.flush(4);
  await clicar(s, botao(s, 'Descartar alterações', confirmacao(s)));
  assert.equal(gaveta(s), null);
});

test('[CATNIC-5] EDITAR nicho: a cor atual vem marcada; trocar a cor envia SÓ a nova chave; o nicho LEGADO sem cor abre sem escolha e pode ser salvo sem inventar uma cor', async () => {
  const api = apiFalsa({ nichos: NICHOS() });
  const s = await abrir({ catalogo: 'nichos', api });
  await clicar(s, acao(s, 'niche:2', 'edit'));
  assert.deepEqual(marcada(s), ['ciano']);
  assert.ok(/\bcor-ciano\b/.test(previa(s).className));
  assert.match(gaveta(s).textContent, /Escolha outra cor para trocar a atual/);
  assert.equal(grupo(s).getAttribute('aria-required'), null, 'na edição a cor não é exigida de novo');
  await salvar(s);
  assert.match(gaveta(s).textContent, /Nenhuma alteração foi feita\./);
  await clicar(s, radio(s, 'celeste'));
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar'), [['atualizar', 'nichos', 'niche:2', { cor: 'celeste' }]]);
  assert.ok(classeDaLinha(s, 'niche:2').includes('cor-celeste') && !classeDaLinha(s, 'niche:2').includes('cor-ciano'));
  assert.equal(chipDaLinha(s, 'niche:2').textContent, 'Celeste');

  // legado sem cor
  await clicar(s, acao(s, 'niche:3', 'edit'));
  assert.deepEqual(marcada(s), [], 'nenhuma cor marcada: o legado fica como está');
  assert.ok(!/\bcor-/.test(previa(s).className), 'prévia neutra');
  assert.match(gaveta(s).textContent, /Nenhuma cor escolhida ainda\./);
  digitar(s, campo(s, 'descricao'), 'Agora com descrição');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[1], ['atualizar', 'nichos', 'niche:3', { descricao: 'Agora com descrição' }], 'a cor não é inventada nem forçada');
  assert.ok(!classeDaLinha(s, 'niche:3').some((c) => c.startsWith('cor-')));
  // e o mesmo legado pode receber uma cor
  await clicar(s, acao(s, 'niche:3', 'edit'));
  await clicar(s, radio(s, 'marrom'));
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[2], ['atualizar', 'nichos', 'niche:3', { cor: 'marrom' }]);
  assert.ok(classeDaLinha(s, 'niche:3').includes('cor-marrom'));
});

test('[CATNIC-6] NICHOS: o servidor continua a autoridade (cor recusada, nome duplicado), e ativar, desativar e reordenar usam os textos de nicho', async () => {
  const api = apiFalsa({ nichos: [nicho(1), nicho(2), nicho(3)] });
  const s = await abrir({ catalogo: 'nichos', api });
  await clicar(s, botao(s, 'Novo Nicho'));
  digitar(s, campo(s, 'nome'), 'Teste');
  await clicar(s, radio(s, 'azul'));
  api.mem.falhas.criar = await erroApi(400, 'CRM_CATALOG_INVALID_INPUT', [{ path: 'cor', code: 'VALOR_INVALIDO' }]);
  await salvar(s);
  assert.equal(s.browser.by.id(s.browser.root, 'catalog-field-cor-error').textContent, 'Escolha uma das opções da lista para a cor.');
  mesmo(emFoco(s), radio(s, 'azul'), 'o foco vai ao seletor, na cor escolhida');
  assert.deepEqual(marcada(s), ['azul'], 'a escolha continua');
  api.mem.falhas.criar = await erroApi(409, 'CRM_CATALOG_DUPLICATE_NAME');
  await salvar(s);
  assert.match(erroDoCampo(s, 'nome').textContent, /Já existe um item com este nome, mesmo desativado/);
  await clicar(s, botao(s, 'Cancelar', gaveta(s)));
  await clicar(s, botao(s, 'Descartar alterações', confirmacao(s)));
  assert.equal(api.mem.nichos.length, 3);

  await clicar(s, acao(s, 'niche:2', 'toggle'));
  assert.equal(s.browser.find(confirmacao(s), (el) => el.className === 'overlay-title').textContent, 'Desativar nicho?');
  assert.match(confirmacao(s).textContent, /Nada é apagado: o que já usa este nicho continua como está/);
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  assert.deepEqual(avisos(s), ['Nicho desativado.']);
  assert.match(linhaDe(s, 'niche:2').textContent, /Inativo/);
  assert.ok(classeDaLinha(s, 'niche:2').includes('cor-azul'), 'desativar não apaga a cor');
  await clicar(s, acao(s, 'niche:2', 'toggle'));
  assert.ok(avisos(s).includes('Nicho reativado.'));
  await clicar(s, acao(s, 'niche:1', 'down'));
  assert.deepEqual(nomes(s), ['Nicho 2', 'Nicho 1', 'Nicho 3']);
  assert.ok(avisos(s).includes('Ordem dos nichos atualizada.'));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ORIGENS DOS LEADS
// ---------------------------------------------------------------------------------------------------------------------------------------------

const ORIGENS = () => [origem(1, { nome: 'Indicação de cliente', canal: 'INDICACAO', descricao: 'Boca a boca' }), origem(2, { nome: 'Anúncio do Instagram', canal: 'ANUNCIO_PAGO' }), origem(3, { nome: 'Legado sem canal', canal: null }), origem(4, { nome: 'Antiga', canal: 'OUTRO', ativo: false })];

test('[CATORI-1] A LISTA de Origens dos Leads: nome, situação e o CANAL pelo rótulo em português; origem legada sem canal diz "Canal não classificado"; a descrição avisa que nenhuma integração é ativada', async () => {
  const api = apiFalsa({ origens: ORIGENS() });
  const s = await abrir({ catalogo: 'origens', api });
  assert.equal(s.browser.by.tag(s.browser.root, 'h2')[0].textContent, 'Origens dos Leads');
  assert.match(texto(s), /este cadastro apenas organiza as origens: não ativa nenhuma integração com WhatsApp, Meta Ads, Google Ads ou IA\./i);
  assert.ok(botao(s, 'Nova Origem'));
  assert.deepEqual(nomes(s), ['Indicação de cliente', 'Anúncio do Instagram', 'Legado sem canal', 'Antiga']);
  assert.match(texto(s), /4 origens/);
  assert.match(linhaDe(s, 'origin:1').textContent, /Indicação/);
  assert.match(linhaDe(s, 'origin:1').textContent, /Boca a boca/);
  assert.match(linhaDe(s, 'origin:2').textContent, /Anúncio pago/);
  assert.match(linhaDe(s, 'origin:3').textContent, /Canal não classificado/);
  assert.match(linhaDe(s, 'origin:4').textContent, /Outro/);
  assert.match(linhaDe(s, 'origin:4').textContent, /Inativo/);
  assert.deepEqual(api.chamadas, [['listar', 'origens', { todos: true }]]);
  assert.doesNotMatch(texto(s), /\bnull\b|\bundefined\b/);
});

test('[CATORI-2] CRIAR e EDITAR origem: o canal usa a taxonomia REAL do backend (6 canais + "Não classificado"); é opcional; só o que mudou vai na edição', async () => {
  const api = apiFalsa({ origens: ORIGENS() });
  const s = await abrir({ catalogo: 'origens', api });
  await clicar(s, botao(s, 'Nova Origem'));
  assert.equal(hash(s), '#/crm/configuracoes/origens/novo');
  assert.equal(s.browser.find(gaveta(s), (el) => el.className === 'overlay-title').textContent, 'Nova origem');
  assert.equal(s.browser.findAll(gaveta(s), (el) => ['input', 'select', 'textarea'].includes(el.localName)).length, 3, 'nome, descrição e canal — nada além do contrato');
  assert.deepEqual([...campo(s, 'canal').childNodes].map((o) => o.value), ['', ...LEAD_CHANNELS], 'a taxonomia do backend, na mesma ordem');
  assert.deepEqual([...campo(s, 'canal').childNodes].map((o) => o.textContent), ['Não classificado', 'Prospecção ativa', 'Anúncio pago', 'Indicação', 'Orgânico', 'Parceria', 'Outro']);
  assert.match(gaveta(s).textContent, /Cadastrar uma origem não ativa nenhuma integração\./);

  await salvar(s);
  assert.equal(erroDoCampo(s, 'nome').textContent, 'Informe o nome.');
  assert.equal(api.escritas().length, 0);
  digitar(s, campo(s, 'nome'), 'Evento presencial');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar')[0], ['criar', 'origens', { nome: 'Evento presencial' }], 'o canal é opcional: nada é inventado');
  assert.deepEqual(avisos(s), ['Origem criada.']);

  await clicar(s, botao(s, 'Nova Origem'));
  digitar(s, campo(s, 'nome'), 'Parceria com agência');
  s.browser.choose(campo(s, 'canal'), 'PARCERIA');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar')[1].slice(1), ['origens', { nome: 'Parceria com agência', canal: 'PARCERIA' }]);

  await clicar(s, acao(s, 'origin:3', 'edit'));
  assert.equal(campo(s, 'canal').value, '');
  s.browser.choose(campo(s, 'canal'), 'ORGANICO');
  await salvar(s);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar'), [['atualizar', 'origens', 'origin:3', { canal: 'ORGANICO' }]]);
  assert.match(linhaDe(s, 'origin:3').textContent, /Orgânico/);
  assert.deepEqual(api.mem.origens.find((o) => o.id === 'origin:1'), ORIGENS()[0], 'as outras origens não foram tocadas');
});

test('[CATORI-3] NENHUMA INTEGRAÇÃO: a tela só fala com a API dos catálogos (qualquer outra chamada seria um defeito) e não oferece conexão com WhatsApp, Meta Ads, Google Ads ou IA', async () => {
  const api = apiFalsa({ origens: ORIGENS() });
  // um "api" que explode ao acessar qualquer método que não seja de catálogo
  const permitidos = new Set(['listCatalog', 'getCatalogItem', 'createCatalogItem', 'updateCatalogItem', 'activateCatalogItem', 'deactivateCatalogItem', 'reorderCatalog']);
  const guardado = new Proxy(api, {
    get(alvo, nome) {
      if (typeof nome === 'string' && !permitidos.has(nome) && !['chamadas', 'mem', 'pausar', 'quantas', 'escritas'].includes(nome) && !['then', 'toJSON'].includes(nome)) throw new Error(`a tela chamou ${nome}, que não é do catálogo`);
      return alvo[nome];
    },
  });
  const s = await abrir({ catalogo: 'origens', api: guardado });
  await clicar(s, botao(s, 'Nova Origem'));
  digitar(s, campo(s, 'nome'), 'Qualquer');
  await salvar(s);
  await clicar(s, acao(s, 'origin:1', 'toggle'));
  await clicar(s, botao(s, 'Desativar', confirmacao(s)));
  await clicar(s, acao(s, 'origin:2', 'down'));
  const rotulos = s.browser.by.tag(s.browser.root, 'button').map((b) => b.textContent);
  for (const rotulo of rotulos) assert.doesNotMatch(rotulo, /conectar|integrar|sincronizar|importar|whatsapp|meta ads|google ads|\bia\b/i, rotulo);
  assert.deepEqual([...new Set(api.chamadas.map(([n]) => n))].sort(), ['criar', 'desativar', 'listar', 'reordenar']);
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.localName === 'a' && /^https?:/i.test(el.getAttribute('href') || '')).length, 0, 'nenhum link externo');
  assert.deepEqual(avisos(s).length > 0, true);
  assert.ok(avisos(s).some((a) => /Ordem das origens atualizada\./.test(a)));
});
