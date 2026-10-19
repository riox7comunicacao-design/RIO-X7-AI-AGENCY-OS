// As TELAS com contratos por PRAZO INDETERMINADO (dashboard/views/negotiationForm.mjs, funnels.mjs e commercialDashboard.mjs — CRM 5.0, Fase D3, decisão 0032): o formulário Nova negociação e Editar (o caso real:
// de 12 meses para prazo indeterminado, aviso prévio de 30 dias), a prévia do contrato, o cartão do Kanban, os totais da coluna, os detalhes, o histórico e o Dashboard Comercial. DOM de teste e API falsa em memória:
// nenhum navegador, nenhuma rede, nenhum dado real. O que mais importa: o TCV indeterminado nunca aparece como zero nem como uma estimativa, e nada muda antes de o servidor confirmar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const N = require('../helpers/negotiationHarness');
const { ADMIN, servico, negociacao, apiNegocios, abrirQuadro, abrirPainel, colunaDe, cartaoDe, tituloDe, botaoDaTela, textoDaTela, modal, formulario, doModal, campo, erroDoCampo, botao, clicar, digitar, escolher } = N;

const NBSP = String.fromCharCode(160);
const limpo = (texto) => texto.replace(/\s+/g, ' ').split(NBSP).join(' ');
const semLixo = (texto) => assert.doesNotMatch(texto, /\bnull\b|\bundefined\b|\[object Object\]|\bNaN\b/, 'a tela nunca mostra null, undefined, [object Object] ou NaN');
const TRAFEGO = (extras = {}) => servico(1, 'Gestão de Tráfego Pago', { permitePagamentoUnico: false, permitePagamentoRecorrente: true, periodicidades: ['MENSAL', 'TRIMESTRAL'], ...extras });
// o contrato como foi salvo pelo usuário: 12 meses, mensal, R$ 1.350,00 (TCV R$ 16.200,00)
const salvoComDozeMeses = () => negociacao(1, { valorNegociado: 1350, servicoNome: 'Gestão de Tráfego Pago' });
const indeterminada = (n, extras = {}) => negociacao(n, { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30, valorNegociado: 1350, servicoNome: 'Gestão de Tráfego Pago', ...extras });

async function abrirNova(extras = {}) {
  const api = await apiNegocios({ services: [TRAFEGO()], ...extras });
  const s = await abrirQuadro({ api });
  await clicar(s, botaoDaTela(s, 'new'));
  return { api, s };
}
const textoDoForm = (s) => limpo(formulario(s).textContent);
const abrirEdicao = async (s, cardId) => {
  await clicar(s, tituloDe(s, cardId));
  await clicar(s, doModal(s, 'detail-edit'));
};

test('[UI-D3-1] O FORMULÁRIO oferece, nesta ordem, Prazo indeterminado, 3, 6, 12 meses e Outro prazo definido; o padrão continua 12 meses; o aviso prévio só aparece no indeterminado e o campo "outro prazo" só no "outro"', async () => {
  const { s } = await abrirNova();
  const grupo = s.browser.by.id(s.browser.root, 'negotiation-field-prazo');
  assert.equal(grupo.localName, 'fieldset');
  assert.equal(s.browser.by.tag(grupo, 'legend')[0].textContent, 'Duração do contrato');
  const rotulos = s.browser.findAll(grupo, (el) => el.localName === 'label' && el.getAttribute('for') && /^negotiation-field-prazo-/.test(el.getAttribute('for'))).map((el) => el.textContent);
  assert.deepEqual(rotulos, ['Prazo indeterminado', '3 meses', '6 meses', '12 meses', 'Outro prazo definido']);
  assert.equal(campo(s, 'prazo-12').checked, true, 'o padrão de sempre');
  assert.equal(campo(s, 'prazo-indeterminado').checked, false);
  assert.equal(s.browser.by.id(s.browser.root, 'negotiation-field-avisoPrevioDias').parentNode.hidden, true, 'sem aviso prévio num prazo definido');
  await clicar(s, campo(s, 'prazo-indeterminado'));
  assert.equal(campo(s, 'avisoPrevioDias').parentNode.hidden, false);
  assert.equal(campo(s, 'prazo-12').checked, false, 'escolher uma opção desmarca a outra');
  const aviso = campo(s, 'avisoPrevioDias');
  assert.equal(s.browser.by.label(formulario(s), 'Aviso prévio para cancelamento (dias)'), aviso, 'o campo tem rótulo');
  assert.match(textoDoForm(s), /Não é a duração do contrato, nem um período mínimo, nem uma cobrança adicional\./);
  await clicar(s, campo(s, 'prazo-outro'));
  assert.equal(campo(s, 'avisoPrevioDias').parentNode.hidden, true, 'voltar a um prazo definido esconde o aviso');
  semLixo(textoDoForm(s));
});

test('[UI-D3-2] CRIAR o contrato real pela tela: indeterminado + mensal + R$ 1.350,00 + aviso 30 — a prévia mostra MRR e TCV "Indeterminado"; o corpo enviado NÃO leva prazo; o cartão e o total da coluna mostram MRR e "TCV indeterminado", nunca R$ 16.200,00', async () => {
  const { api, s } = await abrirNova();
  escolher(s, campo(s, 'crmRecordId'), 'crm:1');
  escolher(s, campo(s, 'serviceId'), 'service:1');
  await clicar(s, campo(s, 'formaPagamento-recorrente'));
  escolher(s, campo(s, 'periodicidade'), 'MENSAL');
  digitar(s, campo(s, 'valorNegociado'), '1.350,00');
  await clicar(s, campo(s, 'prazo-indeterminado'));
  digitar(s, campo(s, 'avisoPrevioDias'), '30');
  const previa = limpo(s.browser.by.id(s.browser.root, 'negotiation-preview').textContent);
  assert.match(previa, /MRR \(receita recorrente mensal\)R\$ 1\.350,00/);
  assert.match(previa, /TCV \(valor total do contrato\)Indeterminado \(contrato sem prazo final\)/);
  assert.match(previa, /Cobrança de R\$ 1\.350,00 todo mês, por prazo indeterminado \(sem número fixo de cobranças\)/);
  assert.match(previa, /Aviso prévio de cancelamento30 dias \(condição do contrato: não é duração, período mínimo nem cobrança\)/);
  assert.doesNotMatch(previa, /16\.200|12 meses|R\$ 0,00/);
  semLixo(previa);
  assert.ok(previa.indexOf('MRR') < previa.indexOf('TCV'), 'o MRR vem em destaque, antes do TCV');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.equal(formulario(s), null);
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'criar'), [['criar', { crmRecordId: 'crm:1', funnelId: 'funnel:1', serviceId: 'service:1', duracao: 'INDETERMINADA', avisoPrevioDias: 30, formaPagamento: 'RECORRENTE', periodicidade: 'MENSAL', valorNegociado: 1350 }]]);
  const coluna = limpo(colunaDe(s, 'stage:1').textContent);
  assert.match(coluna, /Pagamento recorrente \(mensal\) · Prazo indeterminado/);
  assert.match(coluna, /MRR R\$ 1\.350,00 · TCV indeterminado/);
  assert.match(coluna, /Em negociação: R\$ 0,00 \(TCV conhecido\) · MRR R\$ 1\.350,00 · 1 contrato com TCV indeterminado/);
  assert.doesNotMatch(coluna, /16\.200|TCV R\$ 0,00/);
  semLixo(coluna);
});

test('[UI-D3-3] VALIDAÇÃO na tela, antes de enviar: indeterminado com pagamento único, aviso fora de 1–365 ou não numérico — mensagem no campo certo, nada enviado; corrigido, envia', async () => {
  const { api, s } = await abrirNova({ services: [TRAFEGO({ permitePagamentoUnico: true })] });
  escolher(s, campo(s, 'crmRecordId'), 'crm:1');
  escolher(s, campo(s, 'serviceId'), 'service:1');
  digitar(s, campo(s, 'valorNegociado'), '1.350,00');
  await clicar(s, campo(s, 'prazo-indeterminado'));
  await clicar(s, campo(s, 'formaPagamento-unico'));
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(erroDoCampo(s, 'prazoMeses').textContent, /prazo indeterminado só vale para o pagamento recorrente/i);
  assert.equal(api.quantas('criar'), 0);
  assert.match(limpo(s.browser.by.id(s.browser.root, 'negotiation-preview').textContent), /prazo indeterminado só vale para o pagamento recorrente/i, 'a prévia avisa antes de salvar');
  await clicar(s, campo(s, 'formaPagamento-recorrente'));
  escolher(s, campo(s, 'periodicidade'), 'MENSAL');
  for (const ruim of ['0', '366', 'abc', '3,5']) {
    digitar(s, campo(s, 'avisoPrevioDias'), ruim);
    await clicar(s, botao(s, 'Salvar', formulario(s)));
    assert.match(erroDoCampo(s, 'avisoPrevioDias').textContent, /aviso prévio em dias, um número inteiro de 1 a 365/, ruim);
    assert.equal(api.quantas('criar'), 0, ruim);
  }
  digitar(s, campo(s, 'avisoPrevioDias'), '30');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.equal(api.quantas('criar'), 1);
  assert.equal(formulario(s), null);
});

test('[UI-D3-4] CORRIGIR o contrato real pela interface (Editar): abre com 12 meses; escolher Prazo indeterminado e aviso 30 envia SÓ { duracao, prazoMeses: null, avisoPrevioDias } — o card e o valor ficam; o cartão passa a MRR + TCV indeterminado e o TCV de R$ 16.200,00 some', async () => {
  const api = await apiNegocios({ services: [TRAFEGO()], negotiations: [await salvoComDozeMeses()] });
  const s = await abrirQuadro({ api });
  assert.match(limpo(colunaDe(s, 'stage:1').textContent), /TCV R\$ 16\.200,00/, 'antes: o TCV fictício de 12 meses');
  await abrirEdicao(s, 'card:1');
  assert.equal(campo(s, 'prazo-12').checked, true);
  assert.equal(campo(s, 'valorNegociado').value, '1.350,00');
  // sem mudar nada: nada é enviado
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.match(textoDoForm(s), /Nenhuma alteração foi feita\./);
  assert.equal(api.quantas('atualizar'), 0);
  await clicar(s, campo(s, 'prazo-indeterminado'));
  digitar(s, campo(s, 'avisoPrevioDias'), '30');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar'), [['atualizar', 'negotiation:1', { duracao: 'INDETERMINADA', prazoMeses: null, avisoPrevioDias: 30 }]]);
  assert.equal(formulario(s), null);
  const coluna = limpo(colunaDe(s, 'stage:1').textContent);
  assert.match(coluna, /Pagamento recorrente \(mensal\) · Prazo indeterminado/);
  assert.match(coluna, /MRR R\$ 1\.350,00 · TCV indeterminado/);
  assert.doesNotMatch(coluna, /16\.200/);
  assert.equal(cartaoDe(s, 'card:1') !== null, true, 'o card é o mesmo (nenhum card novo foi criado)');
  assert.equal(api.quantas('criar'), 0);
});

test('[UI-D3-5] os DETALHES do contrato indeterminado: "Prazo indeterminado", aviso prévio de cancelamento, MRR em destaque e TCV "Indeterminado", cronograma sem número de cobranças — e o HISTÓRICO mostra a correção com de/para legíveis', async () => {
  const api = await apiNegocios({ services: [TRAFEGO()], negotiations: [await salvoComDozeMeses()] });
  const s = await abrirQuadro({ api });
  await abrirEdicao(s, 'card:1');
  await clicar(s, campo(s, 'prazo-indeterminado'));
  digitar(s, campo(s, 'avisoPrevioDias'), '30');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  await clicar(s, tituloDe(s, 'card:1'));
  const detalhes = limpo(modal(s).textContent);
  assert.match(detalhes, /Prazo do contratoPrazo indeterminado/);
  assert.match(detalhes, /Aviso prévio de cancelamento30 dias \(condição do contrato: não é duração, período mínimo nem cobrança adicional\)/);
  assert.match(detalhes, /MRR \(receita recorrente mensal\)R\$ 1\.350,00/);
  assert.match(detalhes, /TCV \(valor total do contrato\)Indeterminado \(contrato sem prazo final\)/);
  assert.match(detalhes, /CronogramaCobrança de R\$ 1\.350,00 todo mês, por prazo indeterminado/);
  assert.ok(detalhes.indexOf('MRR (receita') < detalhes.indexOf('TCV (valor total'), 'o MRR vem em destaque, antes do TCV');
  assert.doesNotMatch(detalhes, /16\.200|12 meses/);
  // o histórico (a API falsa do quadro registra o evento sem o "de"; o de/para REAL é provado nos testes do domínio, da API e do modelo)
  assert.match(detalhes, /Atualizada — Duração do contrato: .*Prazo indeterminado.*Aviso prévio: .*30 dias\./);
  semLixo(detalhes);
});

test('[UI-D3-6] EDITAR um contrato JÁ indeterminado: abre com o Prazo indeterminado marcado e o aviso preenchido; mudar só o aviso envia só o aviso; voltar para 12 meses leva os três campos e o aviso some; um contrato definido segue editando só o prazo', async () => {
  const api = await apiNegocios({ services: [TRAFEGO()], negotiations: [await indeterminada(1)] });
  const s = await abrirQuadro({ api });
  await abrirEdicao(s, 'card:1');
  assert.equal(campo(s, 'prazo-indeterminado').checked, true);
  assert.equal(campo(s, 'avisoPrevioDias').value, '30');
  assert.equal(campo(s, 'avisoPrevioDias').parentNode.hidden, false);
  digitar(s, campo(s, 'avisoPrevioDias'), '45');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[0], ['atualizar', 'negotiation:1', { avisoPrevioDias: 45 }]);
  await abrirEdicao(s, 'card:1');
  assert.equal(campo(s, 'avisoPrevioDias').value, '45');
  await clicar(s, campo(s, 'prazo-12'));
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[1], ['atualizar', 'negotiation:1', { duracao: 'DEFINIDA', prazoMeses: 12, avisoPrevioDias: null }]);
  assert.match(limpo(colunaDe(s, 'stage:1').textContent), /TCV R\$ 16\.200,00/, 'definido de novo: o TCV volta a ser calculado');
  await abrirEdicao(s, 'card:1');
  await clicar(s, campo(s, 'prazo-outro'));
  digitar(s, campo(s, 'prazoMeses'), '24');
  await clicar(s, botao(s, 'Salvar', formulario(s)));
  assert.deepEqual(api.chamadas.filter(([n]) => n === 'atualizar')[2], ['atualizar', 'negotiation:1', { prazoMeses: 24 }], 'só o prazo, sem a duração');
});

test('[UI-D3-7] o RASCUNHO não se perde ao trocar entre as opções: o aviso digitado volta quando a pessoa escolhe de novo o prazo indeterminado, e o prazo de "outro" também', async () => {
  const { s } = await abrirNova();
  await clicar(s, campo(s, 'prazo-outro'));
  digitar(s, campo(s, 'prazoMeses'), '18');
  await clicar(s, campo(s, 'prazo-indeterminado'));
  digitar(s, campo(s, 'avisoPrevioDias'), '30');
  await clicar(s, campo(s, 'prazo-6'));
  await clicar(s, campo(s, 'prazo-indeterminado'));
  assert.equal(campo(s, 'avisoPrevioDias').value, '30');
  await clicar(s, campo(s, 'prazo-outro'));
  assert.equal(campo(s, 'prazoMeses').value, '18');
});

test('[UI-D3-8] o QUADRO com contratos misturados: o total da coluna é o TCV CONHECIDO, o MRR e a contagem de indeterminados aparecem; a trimestral indeterminada mostra o equivalente mensal; coluna só de definidos não muda de texto', async () => {
  const api = await apiNegocios({ services: [TRAFEGO()], negotiations: [await negociacao(1, { valorNegociado: 1350 }), await indeterminada(2), await indeterminada(3, { periodicidade: 'TRIMESTRAL', avisoPrevioDias: null }), await negociacao(4, { stageId: 'stage:2', stageNome: 'Proposta', formaPagamento: 'UNICO', periodicidade: null, prazoMeses: 6, valorNegociado: 8000 })] });
  const s = await abrirQuadro({ api });
  const contato = limpo(colunaDe(s, 'stage:1').textContent);
  assert.match(contato, /Em negociação: R\$ 16\.200,00 \(TCV conhecido\) · MRR R\$ 2\.700,00 · 2 contratos com TCV indeterminado/);
  assert.match(limpo(cartaoDe(s, 'card:3').textContent), /Equivalente mensal R\$ 450,00 · TCV indeterminado/);
  assert.match(limpo(cartaoDe(s, 'card:3').textContent), /Pagamento recorrente \(trimestral\) · Prazo indeterminado/);
  assert.match(limpo(cartaoDe(s, 'card:1').textContent), /TCV R\$ 16\.200,00/);
  assert.match(limpo(colunaDe(s, 'stage:2').textContent), /Em negociação: R\$ 8\.000,00 \(TCV\)$|Em negociação: R\$ 8\.000,00 \(TCV\)Clínica/, 'sem indeterminados o texto é o de sempre');
  semLixo(textoDaTela(s));
});

test('[UI-D3-9] o DASHBOARD COMERCIAL: com indeterminados o total é o "TCV conhecido" e a nota diz quantos ficaram de fora; o MRR deles entra; só-definidos mantém o rótulo de sempre; a tabela por etapa mostra a contagem — nunca zero de enfeite', async () => {
  const api = await apiNegocios({ negotiations: [await negociacao(1, { valorNegociado: 1350 }), await indeterminada(2), await indeterminada(3, { periodicidade: 'TRIMESTRAL' })] });
  const s = await abrirPainel({ api });
  const grupo = limpo(s.browser.find(s.screen, (el) => el.localName === 'section' && el.getAttribute('data-group') === 'abertas').textContent);
  assert.match(grupo, /TCV conhecido \(contratos com prazo definido\)R\$ 16\.200,00/);
  assert.match(grupo, /2 contratos por prazo indeterminado não entram neste total: o TCV deles é indeterminado \(não é zero nem uma estimativa\)\./);
  assert.match(grupo, /MRR \(receita recorrente mensal\)R\$ 2\.700,00/);
  assert.match(grupo, /Equivalente mensal \(outras recorrências\)R\$ 450,00/);
  const tabela = limpo(s.browser.by.tag(s.screen, 'table')[0].textContent);
  assert.match(tabela, /R\$ 16\.200,00 \(\+ 2 com TCV indeterminado; MRR R\$ 2\.700,00\)/);
  semLixo(limpo(s.screen.textContent));
  // só definidos: o rótulo e o texto de sempre
  const so = await abrirPainel({ api: await apiNegocios({ negotiations: [await negociacao(1)] }) });
  const g2 = limpo(so.browser.find(so.screen, (el) => el.localName === 'section' && el.getAttribute('data-group') === 'abertas').textContent);
  assert.match(g2, /TCV \(valor total dos contratos\)R\$ 18\.000,00/);
  assert.doesNotMatch(g2, /indeterminado/);
  // só indeterminados: o TCV conhecido é zero E a nota explica (a tela nunca mostra "R$ 0,00" sozinho)
  const ind = await abrirPainel({ api: await apiNegocios({ negotiations: [await indeterminada(1)] }) });
  const g3 = limpo(ind.browser.find(ind.screen, (el) => el.localName === 'section' && el.getAttribute('data-group') === 'abertas').textContent);
  assert.match(g3, /TCV conhecido \(contratos com prazo definido\)R\$ 0,00/);
  assert.match(g3, /1 contrato por prazo indeterminado não entra neste total/);
  assert.match(g3, /MRR \(receita recorrente mensal\)R\$ 1\.350,00/);
});

test('[UI-D3-10] PERMISSÕES: quem só LÊ vê o contrato indeterminado (MRR, TCV "Indeterminado", aviso) e não tem Editar; a responsividade do formulário (campos em coluna única, rótulos, sem estilo inline) está no CSS', async () => {
  const api = await apiNegocios({ negotiations: [await indeterminada(1)] });
  const s = await abrirQuadro({ api, permissions: N.LEITOR });
  await clicar(s, tituloDe(s, 'card:1'));
  const detalhes = limpo(modal(s).textContent);
  assert.match(detalhes, /Prazo indeterminado/);
  assert.match(detalhes, /Aviso prévio de cancelamento30 dias/);
  assert.equal(doModal(s, 'detail-edit'), null);
  assert.equal(botaoDaTela(s, 'new'), null);
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'styles.css'), 'utf8');
  assert.match(css, /\.negotiation-form \.negotiation-notice \{[^}]*border-left/);
  assert.match(css, /\.negotiation-form \.negotiation-notice\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.funnel-card-value \{[^}]*overflow-wrap: anywhere;/);
  const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'views', 'negotiationForm.mjs'), 'utf8');
  assert.doesNotMatch(codigo.split('\n').filter((linha) => !linha.trim().startsWith('//')).join('\n'), /\.style\b|innerHTML|setAttribute\('style'/);
});
