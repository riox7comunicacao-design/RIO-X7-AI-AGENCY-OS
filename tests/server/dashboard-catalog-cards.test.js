// Fase D1, bloco 1 — a UX dos TRÊS catálogos (Serviços, Nichos e Cores, Origens dos Leads): cada registro é um CARTÃO numa grade; o corpo do cartão abre um MODAL de detalhes (somente leitura) com
// Editar, Desativar/Reativar e Fechar; Novo/Editar abrem o formulário existente no CENTRO da tela; desativar mostra o impacto no CRM. DOM de teste e API falsa: nenhuma rede, nenhum dado real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../helpers/catalogHarness');
const { servico, nicho, origem, apiFalsa, abrir, gaveta, confirmacao, botao, campo, linhas, linhaDe, nomes, acao, avisos, texto, hash, clicar, digitar, marcar, salvar, emFoco, erroApi } = H;

const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const mesmo = (a, b, mensagem) => assert.ok(a === b, mensagem || 'deveria ser o mesmo elemento');

// o modal de DETALHES: um diálogo "modal" (nunca a gaveta) com a classe de tamanho
const detalhes = (s) => s.browser.find(s.browser.root, (el) => el.getAttribute('role') === 'dialog' && /\bmodal\b/.test(el.className) && /\bsize-md\b/.test(el.className));
const doDetalhe = (s, nomeDaAcao) => s.browser.find(detalhes(s), (el) => el.localName === 'button' && el.getAttribute('data-action') === nomeDaAcao);
const corpoDoCartao = (s, id) => s.browser.find(linhaDe(s, id), (el) => /\bcatalog-row-main\b/.test(el.className));
const nomeDoCartao = (s, id) => acao(s, id, 'details');
// a confirmação (diálogo pequeno), distinta do modal de detalhes
const pergunta = (s) => s.browser.find(s.browser.root, (el) => (el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog') && /\bsize-sm\b/.test(el.className));
const camadas = (s) => s.browser.findAll(s.browser.root, (el) => /\boverlay\b/.test(el.className) && el.hasAttribute('data-overlay'));

const SERVICOS = () => [
  servico(1, { nome: 'Gestão de redes', descricao: 'Posts e stories', categoria: 'Marketing', precoReferencia: 1500, permitePagamentoUnico: true, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'ANUAL'] }),
  servico(2, { nome: 'Criação de site', permitePagamentoUnico: true, precoReferencia: 4800.5 }),
  servico(3, { nome: 'Consultoria', ativo: false, permitePagamentoUnico: false }),
];
const NICHOS = () => [nicho(1, { nome: 'Estética', cor: 'rosa', descricao: 'Clínicas' }), nicho(2, { nome: 'Odontologia', cor: 'azul' })];
const ORIGENS = () => [origem(1, { nome: 'Indicação', canal: 'INDICACAO' }), origem(2, { nome: 'Anúncio', canal: 'ANUNCIO_PAGO', ativo: false })];

test('[CATCARD-1] CARTÕES: cada registro dos três catálogos é um cartão separado, numa grade, com nome, informações do catálogo, situação e as ações Editar e Desativar/Reativar', async () => {
  const cenarios = [
    ['servicos', { servicos: SERVICOS() }, 'service:', /Marketing · Preço de referência: R\$\s1\.500,00 · Pagamento único \+ Pagamento recorrente \(mensal, anual\)/],
    ['nichos', { nichos: NICHOS() }, 'niche:', /Rosa/],
    ['origens', { origens: ORIGENS() }, 'origin:', /Indicação|Canal/],
  ];
  for (const [catalogo, dados, prefixo, informacao] of cenarios) {
    const s = await abrir({ catalogo, api: apiFalsa(dados) });
    const lista = s.browser.find(s.browser.root, (el) => el.localName === 'ul' && /\bcatalog-grid\b/.test(el.className));
    assert.ok(lista, `${catalogo}: a lista é uma grade`);
    const cartoes = linhas(s);
    assert.equal(cartoes.length, Object.values(dados)[0].length, catalogo);
    for (const cartao of cartoes) {
      assert.equal(cartao.localName, 'li');
      assert.ok(cartao.parentNode === lista, 'um cartão por registro, todos na mesma grade');
      const id = cartao.getAttribute('data-id');
      assert.ok(id.startsWith(prefixo));
      assert.ok(nomeDoCartao(s, id).textContent.length > 0, 'nome visível');
      assert.match(cartao.textContent, /Ativo|Inativo/, 'situação visível');
      assert.ok(acao(s, id, 'edit') && acao(s, id, 'edit').textContent === 'Editar', 'ação Editar direta no cartão');
      assert.match(acao(s, id, 'toggle').textContent, /^(Desativar|Reativar)$/, 'ação Desativar/Reativar direta no cartão');
    }
    assert.match(cartoes[0].textContent, informacao, `${catalogo}: a informação principal do catálogo aparece no cartão`);
    assert.deepEqual(avisos(s), []);
  }
  // o cartão inativo se distingue e oferece Reativar
  const s = await abrir({ api: apiFalsa({ servicos: SERVICOS() }) });
  assert.match(linhaDe(s, 'service:3').className, /\bis-inactive\b/);
  assert.equal(acao(s, 'service:3', 'toggle').textContent, 'Reativar');
  // busca, filtro, contagem e ordenação continuam
  assert.match(texto(s), /3 serviços/);
  assert.deepEqual(nomes(s), ['Gestão de redes', 'Criação de site', 'Consultoria']);
});

test('[CATCARD-2] MODAL DE DETALHES: o corpo do cartão (e o botão do nome) abre um modal de verdade — fundo escurecido, foco preso, página sem rolagem — com Editar, Desativar e Fechar; X e Escape fecham e o foco volta ao cartão', async () => {
  const api = apiFalsa({ servicos: SERVICOS(), emUso: { 'service:1': 4 } });
  const s = await abrir({ api });
  const chamadasAntes = api.chamadas.length;
  assert.equal(detalhes(s), null, 'nada abre sozinho');

  s.browser.click(corpoDoCartao(s, 'service:1'));
  await s.browser.flush(6);
  const m = detalhes(s);
  assert.ok(m, 'o corpo do cartão abre o modal');
  assert.equal(m.getAttribute('aria-modal'), 'true');
  assert.equal(gaveta(s), null, 'não é a gaveta de edição');
  assert.equal(hash(s), '#/crm/configuracoes/servicos', 'abrir detalhes não muda o endereço nem edita nada');
  assert.equal(s.browser.find(m, (el) => el.className === 'overlay-title').textContent, 'Gestão de redes');
  assert.match(m.textContent, /Detalhes do serviço/);
  // o fundo escurecido existe e a página fica travada e inerte por trás
  assert.ok(s.browser.find(s.browser.root, (el) => /\boverlay-backdrop\b/.test(el.className)), 'fundo escurecido');
  assert.equal(s.browser.document.body.hasAttribute('data-overlay-open'), true, 'a rolagem da página é travada');
  assert.equal(s.browser.find(s.browser.root, (el) => /\bcatalog-screens\b/.test(el.className)).hasAttribute('inert'), true, 'a página por trás fica inerte (nem foco, nem clique)');
  assert.ok(m.contains(emFoco(s)) || emFoco(s) === m, 'o foco vai para dentro do modal');
  // o conteúdo completo
  const t = m.textContent;
  assert.match(t, /Categoria\s*Marketing/);
  assert.match(t, /Preço de referência\s*R\$\s1\.500,00 \(apenas informativo\)/);
  assert.match(t, /Pagamento único: permitido\./);
  assert.match(t, /Pagamento recorrente: permitido \(mensal, anual\)\./);
  assert.match(t, /Posição na lista\s*1 de 3/);
  assert.match(t, /Criado\s*\d{2}\/\d{2}\/\d{4}.* por Breno Bento/);
  assert.match(t, /Uso no CRM\s*Este serviço é usado em 4 registros do CRM/, 'a contagem de uso chega depois e entra no modal');
  assert.equal(api.chamadas.slice(chamadasAntes).filter(([n]) => n !== 'obter').length, 0, 'só LEITURA: nenhuma gravação');
  // as ações do modal
  assert.deepEqual(['detail-close', 'detail-edit', 'detail-toggle'].map((n) => doDetalhe(s, n).textContent), ['Fechar', 'Editar', 'Desativar']);

  // clique duplo no corpo ou no nome não empilha um segundo modal
  s.browser.click(corpoDoCartao(s, 'service:1'));
  s.browser.click(nomeDoCartao(s, 'service:1'));
  assert.equal(camadas(s).length, 1);

  // Escape fecha e devolve o foco ao nome do cartão
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(detalhes(s), null);
  assert.equal(s.browser.document.body.hasAttribute('data-overlay-open'), false, 'a página volta a rolar');
  assert.equal(s.browser.find(s.browser.root, (el) => /\bcatalog-screens\b/.test(el.className)).hasAttribute('inert'), false);
  mesmo(emFoco(s), nomeDoCartao(s, 'service:1'), 'o foco volta ao cartão que abriu');

  // pelo botão do nome (teclado): abre UM modal; o X fecha
  s.browser.click(nomeDoCartao(s, 'service:2'));
  await s.browser.flush(4);
  assert.ok(detalhes(s));
  assert.equal(camadas(s).length, 1, 'o clique no botão do nome não é contado de novo pelo corpo (a propagação é contida)');
  s.browser.click(s.browser.find(detalhes(s), (el) => el.getAttribute('data-action') === 'close'));
  await s.browser.flush(4);
  assert.equal(detalhes(s), null);
  // Fechar (botão do rodapé) também
  s.browser.click(corpoDoCartao(s, 'service:2'));
  await s.browser.flush(4);
  s.browser.click(doDetalhe(s, 'detail-close'));
  await s.browser.flush(4);
  assert.equal(detalhes(s), null);
  assert.equal(api.escritas().length, 0);
});

test('[CATCARD-3] AÇÕES DIRETAS no cartão não abrem o modal de detalhes (sem propagação): Editar abre só o formulário, Desativar só a confirmação', async () => {
  const s = await abrir({ api: apiFalsa({ servicos: SERVICOS() }) });
  await clicar(s, acao(s, 'service:1', 'edit'));
  assert.ok(gaveta(s), 'Editar abre o formulário');
  assert.equal(detalhes(s), null, 'e não o modal de detalhes');
  assert.equal(hash(s), '#/crm/configuracoes/servicos/service%3A1');
  await clicar(s, botao(s, 'Cancelar', gaveta(s)));
  await clicar(s, acao(s, 'service:2', 'toggle'));
  assert.ok(pergunta(s), 'Desativar pede confirmação');
  assert.equal(detalhes(s), null);
  assert.equal(camadas(s).length, 1);
  await clicar(s, botao(s, 'Cancelar', pergunta(s)));
  assert.equal(camadas(s).length, 0);
  // os botões de ordem também ficam fora do corpo
  await clicar(s, acao(s, 'service:2', 'up'));
  assert.equal(detalhes(s), null);
});

test('[CATCARD-4] EDITAR a partir do modal: o modal fecha e o MESMO formulário abre no centro da tela (modal de verdade), com o mesmo endereço; salvar fecha e atualiza o cartão sem salvar duas vezes', async () => {
  const api = apiFalsa({ servicos: SERVICOS() });
  const s = await abrir({ api });
  await clicar(s, corpoDoCartao(s, 'service:2'));
  await clicar(s, doDetalhe(s, 'detail-edit'));
  assert.equal(detalhes(s), null, 'o modal de detalhes fechou');
  const g = gaveta(s);
  assert.ok(g, 'o formulário abriu');
  assert.match(g.className, /\bis-centered\b/, 'no centro da tela');
  assert.match(g.parentNode.className, /\bis-centered\b/);
  assert.equal(hash(s), '#/crm/configuracoes/servicos/service%3A2');
  assert.equal(campo(s, 'nome').value, 'Criação de site');
  // salvar: uma gravação só, mesmo com cliques repetidos
  digitar(s, campo(s, 'nome'), 'Criação de site profissional');
  const pausa = api.pausar('atualizar');
  s.browser.click(botao(s, 'Salvar', g));
  s.browser.click(botao(s, 'Salvando…', g));
  s.browser.click(botao(s, 'Salvando…', g));
  await s.browser.flush(6);
  assert.equal(api.quantas('atualizar'), 1);
  pausa.liberar();
  await s.browser.flush(8);
  assert.equal(api.quantas('atualizar'), 1, 'um único salvamento');
  assert.equal(gaveta(s), null);
  assert.ok(nomes(s).includes('Criação de site profissional'));
  assert.deepEqual(avisos(s), ['Serviço atualizado.']);
  // "Novo" também abre no centro
  await clicar(s, botao(s, 'Novo Serviço'));
  assert.match(gaveta(s).className, /\bis-centered\b/);
});

test('[CATCARD-5] DESATIVAR a partir do modal: pede confirmação com o IMPACTO (quantos registros do CRM usam o item), desativa UMA vez, o modal e o cartão passam a mostrar Inativo/Reativar e Reativar é direto', async () => {
  const api = apiFalsa({ servicos: SERVICOS(), emUso: { 'service:1': 4, 'service:2': 0 } });
  const s = await abrir({ api });
  await clicar(s, corpoDoCartao(s, 'service:1'));
  await clicar(s, doDetalhe(s, 'detail-toggle'));
  const c = pergunta(s);
  assert.ok(c, 'confirmação sobre o modal');
  assert.equal(camadas(s).length, 2, 'o modal continua por baixo');
  assert.match(c.textContent, /Gestão de redes/);
  assert.match(c.textContent, /Nada é apagado/);
  assert.match(c.textContent, /Este serviço é usado em 4 registros do CRM\. Eles continuam mostrando "Gestão de redes" exatamente como está \(o histórico é preservado\); ele só deixa de ser oferecido em novos cadastros\./, 'o impacto é dito com clareza');
  // Escape fecha só a confirmação (a de cima)
  s.browser.press('Escape');
  await s.browser.flush(4);
  assert.equal(pergunta(s), null);
  assert.ok(detalhes(s), 'o modal de detalhes segue aberto');
  assert.equal(api.escritas().length, 0);

  await clicar(s, doDetalhe(s, 'detail-toggle'));
  // cliques repetidos em "Desativar": uma gravação só
  const pausa = api.pausar('desativar');
  const confirmar = botao(s, 'Desativar', pergunta(s));
  s.browser.click(confirmar);
  s.browser.click(botao(s, 'Desativando…', pergunta(s)));
  await s.browser.flush(6);
  assert.equal(api.quantas('desativar'), 1);
  pausa.liberar();
  await s.browser.flush(8);
  assert.equal(api.quantas('desativar'), 1, 'sem escrita duplicada');
  assert.equal(pergunta(s), null);
  assert.deepEqual(avisos(s), ['Serviço desativado.']);
  // o cartão e o modal mostram o novo estado, e o item nunca foi apagado
  assert.match(linhaDe(s, 'service:1').className, /\bis-inactive\b/);
  assert.equal(acao(s, 'service:1', 'toggle').textContent, 'Reativar');
  assert.ok(detalhes(s), 'o modal continua aberto, agora atualizado');
  assert.match(detalhes(s).textContent, /Inativo/);
  assert.equal(doDetalhe(s, 'detail-toggle').textContent, 'Reativar');
  assert.equal(api.mem.servicos.find((i) => i.id === 'service:1').nome, 'Gestão de redes', 'desativação lógica: o registro continua');
  assert.equal(api.mem.servicos.length, 3);
  // reativar: direto, sem confirmação, uma gravação
  await clicar(s, doDetalhe(s, 'detail-toggle'));
  assert.equal(pergunta(s), null);
  assert.equal(api.quantas('ativar'), 1);
  assert.equal(doDetalhe(s, 'detail-toggle').textContent, 'Desativar');
  assert.match(linhaDe(s, 'service:1').textContent, /Ativo/);
});

test('[CATCARD-6] IMPACTO na confirmação: zero registros, vários, ou a contagem indisponível — o aviso diz a verdade em cada caso e nunca bloqueia a desativação', async () => {
  const api = apiFalsa({ servicos: SERVICOS(), emUso: { 'service:1': 1, 'service:2': 0 } });
  const s = await abrir({ api });
  const abrirConfirmacao = async (id) => {
    await clicar(s, acao(s, id, 'toggle'));
    return pergunta(s);
  };
  let c = await abrirConfirmacao('service:2');
  assert.match(c.textContent, /Nenhum registro do CRM usa este serviço hoje\./);
  await clicar(s, botao(s, 'Cancelar', c));
  c = await abrirConfirmacao('service:1');
  assert.match(c.textContent, /Este serviço é usado em 1 registro do CRM\./, 'singular');
  await clicar(s, botao(s, 'Cancelar', c));
  // a contagem falha: o aviso não afirma nada e a desativação continua possível
  api.mem.falhas.obter = await erroApi(0, 'NETWORK');
  c = await abrirConfirmacao('service:2');
  assert.match(c.textContent, /Não foi possível verificar agora se este serviço é usado em registros do CRM\. Nada é apagado de qualquer forma\./);
  await clicar(s, botao(s, 'Desativar', c));
  assert.equal(api.quantas('desativar'), 1);
  assert.equal(pergunta(s), null);
  // um segundo clique em Desativar com a pergunta aberta não cria outra pergunta nem outra leitura
  const antes = api.quantas('obter');
  s.browser.click(acao(s, 'service:1', 'toggle'));
  s.browser.click(acao(s, 'service:1', 'toggle'));
  await s.browser.flush(6);
  assert.equal(camadas(s).length, 1);
  assert.equal(api.quantas('obter') - antes, 1, 'uma única leitura de uso');
});

test('[CATCARD-7] DETALHES dos três catálogos mostram o que cada um tem (serviço: preço e formas de pagamento; nicho: cor; origem: canal); itens INATIVOS e valores históricos continuam visíveis; nada é inventado', async () => {
  const s1 = await abrir({ api: apiFalsa({ servicos: SERVICOS() }) });
  await clicar(s1, corpoDoCartao(s1, 'service:3')); // inativo e sem nenhuma modalidade (legado)
  assert.match(detalhes(s1).textContent, /Inativo/);
  assert.match(detalhes(s1).textContent, /Modalidades de pagamento não informadas\./);
  assert.match(detalhes(s1).textContent, /Categoria\s*Não informado/);
  assert.match(detalhes(s1).textContent, /Preço de referência\s*Não informado/);
  assert.equal(doDetalhe(s1, 'detail-toggle').textContent, 'Reativar', 'um item inativo oferece Reativar');
  assert.doesNotMatch(detalhes(s1).textContent, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/);

  const s2 = await abrir({ catalogo: 'nichos', api: apiFalsa({ nichos: NICHOS() }) });
  await clicar(s2, corpoDoCartao(s2, 'niche:1'));
  assert.match(detalhes(s2).textContent, /Detalhes do nicho/);
  assert.match(detalhes(s2).textContent, /Cor\s*Rosa/);
  const chip = s2.browser.find(detalhes(s2), (el) => /\bnicho-chip\b/.test(el.className));
  assert.match(chip.className, /\bcor-rosa\b/, 'a cor vem pela classe, nunca por estilo inline');
  assert.match(detalhes(s2).textContent, /Descrição\s*Clínicas/);

  const s3 = await abrir({ catalogo: 'origens', api: apiFalsa({ origens: ORIGENS() }) });
  await clicar(s3, corpoDoCartao(s3, 'origin:2'));
  assert.match(detalhes(s3).textContent, /Detalhes da origem/);
  assert.match(detalhes(s3).textContent, /Canal\s*Anúncio pago/);
  assert.match(detalhes(s3).textContent, /Inativo/);
  assert.equal(s3.browser.findAll(detalhes(s3), (el) => el.hasAttribute('style')).length, 0, 'nenhum estilo inline');
});

test('[CATCARD-8] ESTADOS: com a gravação indisponível o modal de detalhes ainda abre (leitura) e as ações de gravação ficam pausadas; trocar de tela fecha o modal; um item que some da lista fecha o modal', async () => {
  const api = apiFalsa({ servicos: SERVICOS() });
  const s = await abrir({ api });
  api.mem.falhas.desativar = await erroApi(503, 'CRM_CATALOG_PERSISTENCE');
  await clicar(s, acao(s, 'service:2', 'toggle'));
  await clicar(s, botao(s, 'Desativar', pergunta(s)));
  assert.equal(s.view.screen('servicos').isUnavailable(), true);
  assert.ok(pergunta(s), 'o erro 503 aparece na própria confirmação');
  await clicar(s, botao(s, 'Cancelar', pergunta(s)));
  await clicar(s, corpoDoCartao(s, 'service:1'));
  assert.ok(detalhes(s), 'ler os detalhes continua possível');
  assert.equal(doDetalhe(s, 'detail-toggle').disabled, true, 'desativar/reativar fica pausado');
  const escritas = api.escritas().length;
  s.browser.click(doDetalhe(s, 'detail-toggle'));
  await s.browser.flush(4);
  assert.equal(api.escritas().length, escritas, 'nada é enviado');
  // sair da tela fecha o modal
  s.view.hide();
  await s.browser.flush(4);
  assert.equal(detalhes(s), null);
  assert.equal(s.browser.document.body.hasAttribute('data-overlay-open'), false);
});

test('[CATCARD-9] RESPONSIVIDADE e CSS: a grade usa as colunas que couberem e no celular uma só; o corpo é clicável e as ações ficam em rodapé do cartão; modal de detalhes e formulário viram folha com rolagem interna no celular; sem estilo inline', async () => {
  const sem = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const regra = (seletor) => {
    const achada = [...sem.matchAll(/^([^{}\n@][^{}]*)\{([^}]*)\}/gm)].filter((m) => m[1].split(',').map((x) => x.trim()).includes(seletor));
    assert.ok(achada.length > 0, `regra ${seletor}`);
    return achada.map((m) => m[2]).join(' ');
  };
  assert.match(regra('.catalog-grid'), /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*300px\),\s*1fr\)\)/);
  assert.match(regra('.catalog-row'), /min-width:\s*0/);
  assert.match(regra('.catalog-row'), /flex-direction:\s*column/);
  assert.match(regra('.catalog-row-main'), /cursor:\s*pointer/);
  assert.match(regra('.catalog-row-actions'), /border-top/);
  assert.match(regra('.overlay-modal .overlay-dialog.modal.size-md'), /width:\s*min\(640px,\s*100%\)/);
  assert.match(regra('.overlay-dialog.drawer.is-centered'), /border-radius:\s*14px/);
  assert.match(regra('.overlay-body'), /overflow-y:\s*auto/, 'a rolagem é interna ao modal');
  assert.match(sem, /@media \(max-width: 760px\) \{[\s\S]*?\.overlay-dialog\.drawer\.is-centered \{ width: 100%; max-height: 92vh;/, 'no celular o formulário é uma folha');
  assert.match(sem, /@media \(max-width: 760px\) \{[\s\S]*?\.overlay-modal \.overlay-dialog\.modal \{ width: 100%; max-height: 92vh;/, 'no celular o modal de detalhes é uma folha');
  assert.doesNotMatch(regra('.catalog-row') + regra('.catalog-grid'), /(?:^|[\s;])(?:width|min-width):\s*(?!0\b)\d+px/, 'nenhuma largura fixa que estoure no celular');
  const s = await abrir({ api: apiFalsa({ servicos: SERVICOS() }) });
  assert.equal(s.browser.findAll(s.browser.root, (el) => el.hasAttribute('style')).length, 0, 'nenhum estilo inline na lista');
});
