// O painel COMPLETAR PESQUISA depois do ajuste de CONFIABILIDADE 3.0.2: mostra, por campo, ENCONTRADO / NÃO ENCONTRADO APÓS VERIFICAÇÃO DOCUMENTADA / NÃO VERIFICADO (com o motivo); "Pesquisa incompleta";
// os campos que ainda podem ser pesquisados; um registro antigo (LEGADO) marcado Completo sem verificação; e a NOVA TENTATIVA manual com o custo e a duração da anterior mostrados ANTES da confirmação.
// API FAKE; nenhum servidor, nenhum Claude.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBrowser } = require('../helpers/fakeDom');

const ANTERIOR = { iniciadoEm: '2026-10-09T01:09:39.465Z', duracaoMs: 21492, custoUsd: 0.067777, turnos: 5, webSearchRequests: 0, resultado: 'COMPLETO', fontes: ['https://a.com.br/'] };

function montarApi(estado) {
  const chamadas = [];
  let atual = estado;
  return {
    chamadas,
    api: {
      getLeadResearchStatus: async () => ({ item: atual }),
      completeLeadResearch: async (id) => {
        chamadas.push(['completar', id]);
        atual = { status: 'EM_ANDAMENTO', etapa: 'PESQUISANDO', elapsedMs: 1000, camposSolicitados: ['emails', 'atividadeRecente'], podeCompletar: false };
        return { item: atual };
      },
      reviewLeadSite: async () => assert.fail('não revisa o site'),
      decideLeadSiteProposal: async () => assert.fail('não decide o site'),
    },
  };
}
async function abrir(estado, opcoes = {}) {
  const { createEnrichmentPanel } = await import('../../dashboard/views/leadEnrichmentPanel.mjs');
  const sim = montarApi(estado);
  const browser = createBrowser();
  const painel = createEnrichmentPanel({ document: browser.document, api: sim.api, prospectId: 'pid-1', schedule: () => () => {}, ...opcoes });
  browser.root.append(painel.element);
  await painel.load();
  await browser.flush();
  return { browser, sim, painel, texto: () => browser.root.textContent.replace(/\s+/g, ' ') };
}

const legadoCompleto = {
  status: 'INCOMPLETO',
  statusRegistrado: 'COMPLETO',
  origem: 'LEGADO',
  camposPendentes: ['responsavel', 'emails', 'atividadeRecente'],
  camposNaoEncontrados: [],
  resolucao: {
    responsavel: { status: 'NAO_VERIFICADO', resolvido: false, origem: 'LEGADO', motivo: 'EXECUCAO_ANTERIOR_SEM_VERIFICACAO_REGISTRADA' },
    emails: { status: 'NAO_VERIFICADO', resolvido: false, origem: 'LEGADO', motivo: 'EXECUCAO_ANTERIOR_SEM_VERIFICACAO_REGISTRADA' },
    atividadeRecente: { status: 'NAO_VERIFICADO', resolvido: false, origem: 'LEGADO', motivo: 'EXECUCAO_ANTERIOR_SEM_VERIFICACAO_REGISTRADA' },
    siteOficial: { status: 'ENCONTRADO', resolvido: true },
    endereco: { status: 'ENCONTRADO', resolvido: true },
    telefones: { status: 'ENCONTRADO', resolvido: true },
  },
  pesquisaCompleta: false,
  podeCompletar: true,
  disponivel: true,
  ultimaExecucao: { ...ANTERIOR, origem: 'LEGADO' },
};

test('[DASH-CONF-1] cada campo aparece com o seu resultado: Encontrado, Não encontrado após verificação documentada (com as fontes lidas), Não verificado (com o motivo) — e os campos que ainda podem ser pesquisados', async () => {
  const { browser, texto } = await abrir({
    status: 'INCOMPLETO',
    camposPendentes: ['presencaDigital', 'atividadeRecente'],
    camposNaoEncontrados: ['emails'],
    resolucao: {
      siteOficial: { status: 'ENCONTRADO', resolvido: true },
      responsavel: { status: 'ENCONTRADO', resolvido: true },
      emails: { status: 'NAO_ENCONTRADO_COM_VERIFICACAO', resolvido: true, fontes: ['https://a.com.br/sobre'] },
      presencaDigital: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'OMITIDO_SEM_CONSULTA' },
      atividadeRecente: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'LIMITE_DE_TURNOS' },
    },
    limiteDeTurnos: true,
    mensagem: 'A pesquisa atingiu o limite de turnos do motor antes de terminar.',
    podeCompletar: true,
    disponivel: true,
    ultimaExecucao: { iniciadoEm: '2026-10-08T12:00:00.000Z', duracaoMs: 48000, custoUsd: 0.12, turnos: 12, ferramentas: { webSearch: 3, webFetch: 'NAO_MEDIDO' }, encerramento: 'LIMITE_DE_TURNOS', fontesNovas: ['https://a.com.br/'], fontes: ['https://a.com.br/', 'https://b.com.br/'] },
  });
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Pesquisa incompleta');
  assert.match(browser.by.id(browser.root, 'enrich-found').textContent, /Encontrado: site oficial, responsável/);
  assert.match(browser.by.id(browser.root, 'enrich-notfound').textContent, /Não encontrado após verificação documentada: e-mails/);
  assert.match(browser.root.textContent, /não prova que a informação não exista/);
  assert.match(browser.by.id(browser.root, 'enrich-pending').textContent, /Campos que ainda podem ser pesquisados: presença digital, atividade recente/);
  const itens = browser.root.textContent.replace(/\s+/g, ' ');
  assert.match(itens, /e-mails: não encontrado após verificação · fontes lidas: https:\/\/a\.com\.br\/sobre/);
  assert.match(itens, /presença digital: não verificado — o motor não trouxe o campo nem documentou onde procurou/);
  assert.match(itens, /atividade recente: não verificado — a pesquisa foi cortada pelo limite de turnos/);
  assert.ok(browser.by.id(browser.root, 'enrich-incomplete'), 'aviso de Pesquisa incompleta');
  assert.match(texto(), /Limite de turnos do motor atingido/);
  assert.match(texto(), /encerramento: limite de turnos/);
  assert.match(texto(), /WebSearch: 3 · WebFetch: NÃO MEDIDO/);
  assert.doesNotMatch(texto(), /não existe|encontrado publicamente/i, 'nada definitivo sem prova');
});

test('[DASH-CONF-2] registro LEGADO marcado Completo sem verificação: aparece como Pesquisa incompleta, com o aviso LEGADO, custo/duração reais e NÃO MEDIDO; nada de "não encontrado"', async () => {
  const { browser, texto } = await abrir(legadoCompleto);
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Pesquisa incompleta');
  assert.match(browser.by.id(browser.root, 'enrich-legacy').textContent, /registrada como Completa.*não guardou a verificação.*LEGADO.*NÃO VERIFICADOS/);
  assert.match(texto(), /Campos que ainda podem ser pesquisados: responsável, e-mails, atividade recente/);
  assert.match(texto(), /responsável: não verificado — a pesquisa anterior não registrou a verificação \(registro LEGADO\)/);
  assert.equal(browser.by.id(browser.root, 'enrich-notfound'), null);
  assert.match(texto(), /duração 00:21/);
  assert.match(texto(), /custo informado pelo motor: US\$ 0\.07/);
  assert.match(texto(), /5 turno\(s\)/);
  assert.match(texto(), /registro LEGADO \(sem resultado por campo\)/);
  assert.match(texto(), /WebSearch: 0 · WebFetch: NÃO MEDIDO/);
  assert.doesNotMatch(texto(), /não existe|encontrado publicamente/i);
});

test('[DASH-CONF-3] NOVA TENTATIVA: o botão só abre a confirmação (custo e duração da anterior, campos a pesquisar); CANCELAR não chama nada; CONFIRMAR chama UMA vez; nunca automática', async () => {
  const { browser, sim, texto } = await abrir(legadoCompleto);
  const botao = browser.by.id(browser.root, 'enrich-run');
  assert.equal(botao.textContent, 'PESQUISAR CAMPOS NÃO VERIFICADOS');
  assert.equal(botao.disabled, false, 'permitido mesmo com o registro anterior COMPLETO');
  assert.equal(browser.by.id(browser.root, 'enrich-confirm'), null, 'nada de confirmação antes do clique');
  assert.deepEqual(sim.chamadas, [], 'abrir o painel não inicia pesquisa');

  browser.click(botao);
  await browser.flush(6);
  assert.deepEqual(sim.chamadas, [], 'o clique só pede a confirmação');
  assert.match(browser.by.id(browser.root, 'enrich-confirm-previous').textContent, /Tentativa anterior:.*duração 00:21.*custo informado pelo motor: US\$ 0\.07.*5 turno\(s\)/);
  assert.match(browser.by.id(browser.root, 'enrich-confirm-fields').textContent, /Será pesquisado somente: responsável, e-mails, atividade recente/);
  assert.equal(browser.by.id(browser.root, 'enrich-run').disabled, true, 'o botão original fica bloqueado durante a confirmação');

  browser.click(browser.by.id(browser.root, 'enrich-confirm-cancel'));
  await browser.flush(4);
  assert.equal(browser.by.id(browser.root, 'enrich-confirm'), null);
  assert.deepEqual(sim.chamadas, [], 'cancelar não pesquisa');

  browser.click(browser.by.id(browser.root, 'enrich-run'));
  await browser.flush(6);
  browser.click(browser.by.id(browser.root, 'enrich-confirm-run'));
  await browser.flush(8);
  assert.deepEqual(sim.chamadas, [['completar', 'pid-1']], 'uma única pesquisa, só depois da confirmação');
  assert.equal(browser.by.id(browser.root, 'enrich-status').textContent, 'Em andamento');
  assert.equal(browser.by.id(browser.root, 'enrich-confirm'), null);
  assert.equal(browser.by.id(browser.root, 'enrich-run').disabled, true);
  assert.match(texto(), /Pesquisando: e-mails, atividade recente/);
});

test('[DASH-CONF-4] a PRIMEIRA pesquisa não exige confirmação (não há tentativa anterior); tudo resolvido: o botão fica bloqueado e a tela diz que não há o que pesquisar de novo; sem permissão (canRun=false) não há botões', async () => {
  const primeira = await abrir({ status: 'NAO_EXECUTADO', camposPendentes: ['emails'], resolucao: { emails: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'NAO_PESQUISADO' } }, podeCompletar: true, disponivel: true });
  assert.equal(primeira.browser.by.id(primeira.browser.root, 'enrich-run').textContent, 'COMPLETAR PESQUISA');
  primeira.browser.click(primeira.browser.by.id(primeira.browser.root, 'enrich-run'));
  await primeira.browser.flush(8);
  assert.deepEqual(primeira.sim.chamadas, [['completar', 'pid-1']], 'sem tentativa anterior, inicia direto');

  const resolvido = await abrir({ status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: ['emails'], resolucao: { emails: { status: 'NAO_ENCONTRADO_COM_VERIFICACAO', resolvido: true, fontes: ['https://a.com.br/'] } }, pesquisaCompleta: true, podeCompletar: false, disponivel: true, ultimaExecucao: { ...ANTERIOR, ferramentas: { webSearch: 'NAO_MEDIDO', webFetch: 'NAO_MEDIDO' }, resultadosPorCampo: {} } });
  assert.equal(resolvido.browser.by.id(resolvido.browser.root, 'enrich-status').textContent, 'Completo');
  assert.equal(resolvido.browser.by.id(resolvido.browser.root, 'enrich-run').disabled, true);
  assert.match(resolvido.texto(), /Todos os campos estão resolvidos \(encontrados ou verificados\)/);
  assert.match(resolvido.texto(), /WebSearch: NÃO MEDIDO · WebFetch: NÃO MEDIDO/);

  const leitura = await abrir(legadoCompleto, { canRun: false });
  assert.equal(leitura.browser.by.id(leitura.browser.root, 'enrich-run'), null);
  assert.equal(leitura.browser.by.id(leitura.browser.root, 'enrich-confirm-run'), null);
  assert.match(leitura.texto(), /Pesquisa incompleta/, 'quem só lê vê a situação real');
});

test('[DASH-CONF-5] resposta de um servidor ANTERIOR (sem o resultado por campo): nada é afirmado como verificado — o que faltava aparece como NÃO VERIFICADO, nunca como "não encontrado"', async () => {
  const { browser, texto } = await abrir({ status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: ['responsavel', 'emails'], podeCompletar: false, disponivel: true });
  assert.equal(browser.by.id(browser.root, 'enrich-notfound'), null, 'sem `resolucao`, nada é "não encontrado após verificação"');
  assert.doesNotMatch(texto(), /Não encontrado após verificação|publicamente/);
});

test('[DASH-CONF-6] OBSERVABILIDADE: por campo, as fontes citadas pelo motor e cada tentativa (leitura OK ou a categoria da falha, pertinência), só URLs reduzidas e códigos; sem a palavra "resolucao" em nenhum texto', async () => {
  const { browser, texto } = await abrir({
    status: 'INCOMPLETO',
    mensagem: 'A pesquisa terminou sem documentar a verificação de alguns campos: eles continuam NÃO VERIFICADOS e podem ser pesquisados de novo.',
    camposPendentes: ['responsavel', 'emails', 'atividadeRecente'],
    camposNaoEncontrados: [],
    resolucao: {
      responsavel: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'FONTES_NAO_CONFIRMADAS', citadas: ['https://www.instagram.com/empresaexemploalfa'], tentativas: [{ url: 'https://www.instagram.com/empresaexemploalfa', leitura: 'ROBOTS', causa: 'ROBOTS_BLOQUEIA' }] },
      emails: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'FONTE_NAO_PERTINENTE_A_EMPRESA', citadas: ['https://www.facebook.com/EmpresaExemploAlfa'], tentativas: [{ url: 'https://www.facebook.com/EmpresaExemploAlfa', leitura: 'OK', pertinencia: 'FONTE_NAO_PERTINENTE_A_EMPRESA' }] },
      atividadeRecente: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'FONTES_NAO_CONFIRMADAS', citadas: ['https://linktr.ee/x', 'https://a.com.br/b'], tentativas: [{ url: 'https://linktr.ee/x', leitura: 'HTTP_403' }, { url: 'https://a.com.br/b', leitura: 'EXCECAO_NA_LEITURA' }, { url: 'https://c.com.br/d', leitura: 'NAO_TENTADA', causa: 'LIMITE_DE_LEITURAS' }] },
    },
    podeCompletar: true,
    disponivel: true,
  });
  const t = texto();
  assert.match(t, /responsável: não verificado — as fontes citadas pelo motor não puderam ser confirmadas · fontes citadas pelo motor: 1 · tentativas: www\.instagram\.com\/empresaexemploalfa → bloqueada pelo robots\.txt \[ROBOTS_BLOQUEIA\]/);
  assert.match(t, /e-mails: não verificado — a página lida não é da empresa.*tentativas: www\.facebook\.com\/EmpresaExemploAlfa → lida · a página lida não é da empresa/);
  assert.match(t, /linktr\.ee\/x → acesso negado \(403\); a\.com\.br\/b → exceção na leitura; c\.com\.br\/d → não tentada \(limite de leituras\)/);
  assert.doesNotMatch(t, /resolucao/i);
  assert.match(t, /verificação de alguns campos: eles continuam NÃO VERIFICADOS/);
});

test('[DASH-CONF-7] atividade recente BLOQUEADA aparece como bloqueio por pré-requisito (não como "não existe" nem como pesquisável); o limite de turnos sem confirmação do motor é dito com cautela; o responsável pendente tem rótulo próprio', async () => {
  const { browser, texto } = await abrir({
    status: 'INCOMPLETO',
    limiteDeTurnos: true,
    camposPendentes: ['emails', 'responsavel'],
    camposNaoEncontrados: [],
    camposBloqueados: ['atividadeRecente'],
    bloqueios: [{ campo: 'atividadeRecente', motivo: 'BLOQUEADO_POR_PRE_REQUISITO', requer: 'CANAL_OFICIAL_CONFIRMADO', mensagem: 'A atividade recente exige um canal oficial confirmado (Instagram, Facebook etc.). Confirme um canal para poder pesquisá-la; perfis apenas sugeridos não valem.' }],
    resolucao: {
      emails: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'LIMITE_DE_TURNOS' },
      responsavel: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'PENDENTE_DE_CONFIRMACAO' },
      atividadeRecente: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'BLOQUEADO_POR_PRE_REQUISITO', bloqueio: 'BLOQUEADO_POR_PRE_REQUISITO', requer: 'CANAL_OFICIAL_CONFIRMADO' },
    },
    podeCompletar: true,
    disponivel: true,
    ultimaExecucao: { iniciadoEm: '2026-10-09T02:05:42.434Z', duracaoMs: 60829, custoUsd: 0.15, turnos: 10, encerramento: 'LIMITE_DE_TURNOS', limiteNaoConfirmado: true, fontes: [], fontesNovas: [] },
  });
  assert.match(browser.by.id(browser.root, 'enrich-blocked-prereq').textContent, /atividade recente: bloqueado por pré-requisito\. A atividade recente exige um canal oficial confirmado/);
  assert.match(browser.by.id(browser.root, 'enrich-pending').textContent, /Campos que ainda podem ser pesquisados: e-mails, responsável$/, 'o bloqueado não é oferecido como pesquisável');
  assert.match(texto(), /atividade recente: não verificado — bloqueado: confirme um canal oficial/);
  assert.match(texto(), /responsável: não verificado — responsável encontrado, mas o vínculo da fonte com a empresa não está demonstrado \(pendente de confirmação\)/);
  assert.match(texto(), /Limite de turnos registrado por contagem \(o motor não confirmou o desfecho\): pode ter sido um término normal/);
  assert.doesNotMatch(texto(), /não existe|encontrado publicamente/i);
});
