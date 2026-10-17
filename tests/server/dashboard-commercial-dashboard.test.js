// O DASHBOARD COMERCIAL (dashboard/views/commercialDashboard.mjs — CRM 5.0, Fase D1): indicadores REAIS das negociações, calculados no servidor. DOM de teste e API falsa em memória.
// O que mais importa aqui: a tela nunca soma nem inventa — cada número vem do resumo do servidor; sem dados, ela diz o que falta; valor recebido não aparece; TCV, MRR e equivalente mensal não se misturam.

const test = require('node:test');
const assert = require('node:assert/strict');

const N = require('../helpers/negotiationHarness');
const { ADMIN, LEITOR, negociacao, erroApi, apiNegocios, abrirPainel } = N;

const NBSP = String.fromCharCode(160);
const semLixo = (texto) => assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
const texto = (s) => s.screen.textContent.replace(/\s+/g, ' ').split(NBSP).join(' ');
const grupo = (s, id) => s.browser.find(s.screen, (el) => el.localName === 'section' && el.getAttribute('data-group') === id);
const stat = (s, id) => s.browser.find(s.screen, (el) => el.getAttribute('data-stat') === id);
const valorDe = (s, id) => (stat(s, id) ? stat(s, id).textContent.replace(/\s+/g, ' ').split(NBSP).join(' ') : null);
const refresh = (s) => s.browser.find(s.screen, (el) => el.localName === 'button' && el.getAttribute('data-action') === 'refresh');

// duas abertas (uma recorrente mensal de 1.500 x 12 = 18.000 e uma única de 8.000), uma trimestral ganha (3.000 x 12 meses = 12.000) e uma perdida (única de 5.000)
async function carteira() {
  return [
    await negociacao(1),
    await negociacao(2, { stageId: 'stage:2', stageNome: 'Proposta', formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 8000, prazoMeses: 6 }),
    await negociacao(3, { situacao: 'GANHA', stageId: 'stage:3', stageNome: 'Fechamento', formaPagamento: 'RECORRENTE', periodicidade: 'TRIMESTRAL', valorNegociado: 3000, prazoMeses: 12 }),
    await negociacao(4, { situacao: 'PERDIDA', formaPagamento: 'UNICO', periodicidade: null, valorNegociado: 5000, prazoMeses: 3, motivoPerda: 'Preço' }),
  ];
}

test('[CDASH-1] OS INDICADORES vêm do resumo do SERVIDOR (uma só leitura GET): em negociação, contratado e perdido separados, TCV e MRR sem se misturar, e a conversão só com negociações fechadas', async () => {
  const api = await apiNegocios({ negotiations: await carteira() });
  const s = await abrirPainel({ api });
  assert.deepEqual(api.chamadas, [['resumo']], 'uma única leitura; nada além disso');
  assert.match(texto(s), /Dashboard Comercial/);
  // em negociação (abertas): TCV 18.000 + 8.000 = 26.000; MRR só da recorrência mensal = 1.500
  assert.equal(valorDe(s, 'abertas-qtd'), 'Negociações2');
  assert.match(valorDe(s, 'abertas-tcv'), /R\$ 26\.000,00/);
  assert.match(valorDe(s, 'abertas-tcv'), /TCV \(valor total dos contratos\)/);
  assert.match(valorDe(s, 'mrr') || '', /MRR/);
  assert.match(grupo(s, 'abertas').textContent.replace(/\s+/g, ' ').split(NBSP).join(' '), /MRR \(receita recorrente mensal\)R\$ 1\.500,00/);
  assert.doesNotMatch(grupo(s, 'abertas').textContent, /Equivalente mensal/, 'sem recorrências não mensais abertas, não há equivalente');
  // contratado (ganhas): a trimestral NÃO entra no MRR; aparece como equivalente mensal (12.000 / 12 = 1.000), só para comparar
  const ganhas = grupo(s, 'ganhas').textContent.replace(/\s+/g, ' ').split(NBSP).join(' ');
  assert.match(ganhas, /Contratado/);
  assert.match(ganhas, /TCV \(valor total dos contratos\)R\$ 12\.000,00/);
  assert.match(ganhas, /MRR \(receita recorrente mensal\)R\$ 0,00/);
  assert.match(ganhas, /Equivalente mensal \(outras recorrências\)R\$ 1\.000,00/);
  assert.match(ganhas, /não é o que entra no caixa/);
  assert.match(ganhas, /Não é valor recebido\./);
  // perdidas e a conversão: 1 ganha de 2 fechadas = 50,0%
  const perdidas = grupo(s, 'perdidas').textContent.replace(/\s+/g, ' ').split(NBSP).join(' ');
  assert.match(perdidas, /TCV \(valor total dos contratos\)R\$ 5\.000,00/);
  assert.match(valorDe(s, 'conversao'), /Taxa de conversão50,0%/);
  assert.match(valorDe(s, 'conversao'), /1 ganha de 2 fechadas \(ganhas \+ perdidas\)\./);
  // por etapa: só as abertas, com a quantidade e o TCV em jogo
  const linhas = s.browser.findAll(s.screen, (el) => el.localName === 'tr').slice(1).map((tr) => tr.textContent.replace(/\s+/g, ' ').split(NBSP).join(' '));
  assert.deepEqual(linhas, ['Funil 1Contato1R$ 18.000,00', 'Funil 1Proposta1R$ 8.000,00']);
  // valor recebido NÃO existe aqui
  assert.match(texto(s), /O valor recebido não aparece aqui: ele virá dos pagamentos, em outra etapa do sistema\./);
  assert.doesNotMatch(texto(s), /Valor recebido:|Recebido:/);
  assert.equal(api.escritas().length, 0);
  assert.equal(s.browser.findAll(s.screen, (el) => el.hasAttribute('style')).length, 0, 'nenhum estilo inline');
  semLixo(texto(s));
});

test('[CDASH-2] SEM DADOS a tela diz o que falta: sem negociações, estado vazio com o caminho; sem fechadas, "Sem dados" na conversão (nunca 0%); negociação sem condições completas é avisada, não escondida', async () => {
  const vazio = await abrirPainel({ api: await apiNegocios({ negotiations: [] }) });
  assert.match(texto(vazio), /Ainda não há negociações\./);
  assert.match(texto(vazio), /Os indicadores aparecem assim que a primeira negociação for aberta em Funis de Vendas\./);
  assert.equal(vazio.browser.find(vazio.screen, (el) => el.localName === 'a' && el.getAttribute('href') === '#/funis').textContent, 'Abrir Funis de Vendas');
  assert.equal(stat(vazio, 'abertas-qtd'), null, 'nenhum zero de enfeite');

  const soAbertas = await abrirPainel({ api: await apiNegocios({ negotiations: [await negociacao(1)] }) });
  assert.match(valorDe(soAbertas, 'conversao'), /Taxa de conversãoSem dados/);
  assert.match(valorDe(soAbertas, 'conversao'), /Aparece depois da primeira negociação ganha ou perdida\./);
  assert.doesNotMatch(valorDe(soAbertas, 'conversao'), /0,0%|0%/);

  const nenhumaAberta = await abrirPainel({ api: await apiNegocios({ negotiations: [await negociacao(3, { situacao: 'GANHA' })] }) });
  assert.match(texto(nenhumaAberta), /Nenhuma negociação aberta no momento\./);
  assert.equal(nenhumaAberta.browser.findAll(nenhumaAberta.screen, (el) => el.localName === 'table').length, 0);

  const incompleta = await negociacao(5);
  incompleta.financeiro = null;
  const comAviso = await abrirPainel({ api: await apiNegocios({ negotiations: [await negociacao(1), incompleta] }) });
  assert.match(texto(comAviso), /1 negociação ficou fora dos valores por não ter as condições de pagamento completas\./);
});

test('[CDASH-3] ERROS: a primeira falha mostra o erro com "Tentar novamente"; atualizar com falha mantém os números na tela e só avisa; sem permissão a tela nem chama a API', async () => {
  const api = await apiNegocios({ negotiations: await carteira() });
  api.mem.falhas.resumo = await erroApi(500, 'INTERNAL');
  const s = await abrirPainel({ api });
  assert.match(texto(s), /Não foi possível carregar os indicadores agora\. Tente novamente\./);
  assert.equal(stat(s, 'abertas-qtd'), null);
  s.browser.click(s.browser.find(s.screen, (el) => el.localName === 'button' && el.getAttribute('data-action') === 'retry'));
  await s.browser.flush(10);
  assert.equal(valorDe(s, 'abertas-qtd'), 'Negociações2');
  // atualizar com a rede caída: os números ficam
  api.mem.falhas.resumo = await erroApi(0, 'NETWORK');
  s.browser.click(refresh(s));
  await s.browser.flush(10);
  assert.equal(valorDe(s, 'abertas-qtd'), 'Negociações2', 'os números anteriores continuam na tela');
  assert.match(texto(s), /Sem conexão com o servidor/);
  // atualizar com sucesso lê de novo (e o aviso some)
  api.mem.negotiations.push(await negociacao(9, { stageId: 'stage:2', stageNome: 'Proposta' }));
  s.browser.click(refresh(s));
  await s.browser.flush(10);
  assert.equal(valorDe(s, 'abertas-qtd'), 'Negociações3');
  assert.doesNotMatch(texto(s), /Sem conexão com o servidor/);
  // 403 e 404
  const proibido = await apiNegocios();
  proibido.mem.falhas.resumo = await erroApi(403, 'FORBIDDEN');
  assert.match(texto(await abrirPainel({ api: proibido })), /Sua conta não tem permissão para ver o Dashboard Comercial\./);
  const antigo = await apiNegocios();
  antigo.mem.falhas.resumo = await erroApi(404, 'NOT_FOUND');
  assert.match(texto(await abrirPainel({ api: antigo })), /não está disponível neste servidor/);
  // sem READ:CRM: nada é chamado
  const semLeitura = await apiNegocios();
  const bloqueada = await abrirPainel({ api: semLeitura, permissions: { canReadCrm: false } });
  assert.match(texto(bloqueada), /Sua conta não tem permissão para ver o Dashboard Comercial\./);
  assert.deepEqual(semLeitura.chamadas, []);
  // uma resposta fora do formato não vira tela quebrada
  const estranha = await apiNegocios();
  estranha.negotiationSummary = async () => ({ resumo: { total: 3 } });
  assert.match(texto(await abrirPainel({ api: estranha })), /Não foi possível carregar os indicadores agora\./);
});

test('[CDASH-4] QUEM SÓ LÊ (READ:CRM) vê os mesmos indicadores; nomes vindos dos dados nunca viram marcação; sair da tela limpa a página', async () => {
  const perigosa = await negociacao(1, { funnelNome: '<img src=x onerror=alert(1)>', stageNome: '<b>Etapa</b>' });
  const s = await abrirPainel({ api: await apiNegocios({ negotiations: [perigosa] }), permissions: LEITOR });
  assert.equal(valorDe(s, 'abertas-qtd'), 'Negociações1');
  assert.equal(s.browser.findAll(s.screen, (el) => ['img', 'b', 'script'].includes(el.localName)).length, 0);
  assert.match(texto(s), /<img src=x onerror=alert\(1\)>/);
  s.view.destroy();
  assert.equal(s.screen.childNodes.length, 0);
  // destruída, uma resposta tardia não escreve na página
  const tardia = await apiNegocios({ negotiations: [await negociacao(1)] });
  const pausa = tardia.pausar('resumo');
  const t = await abrirPainel({ api: tardia, carregar: false });
  const carga = t.view.load();
  t.view.destroy();
  pausa.liberar();
  await carga;
  await t.browser.flush(6);
  assert.equal(t.screen.childNodes.length, 0, 'a resposta tardia não reabre a tela');
});
