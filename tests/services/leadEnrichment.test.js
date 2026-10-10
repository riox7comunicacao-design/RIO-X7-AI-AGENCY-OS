'use strict';

// Implementação 3.0.2 — COMPLETAR PESQUISA: o enriquecimento comercial SOB DEMANDA, de UM lead, só dos campos pendentes. Peças REAIS: a Approval Queue em arquivo temporário, o autorizador,
// o perfil comercial e a mescla; FAKES: o motor de enriquecimento (o `claude -p`) e a leitura de página. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadEnrichmentService, ENRICH_ERROR } = require('../../src/services/leadEnrichmentService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const { buildPrompt, parseEnrichment } = require('../../src/prospecting-adapters/claudeEnrichmentEngine');
const commercial = require('../../src/research-prospector/commercialProfile');
const digital = require('../../src/research-prospector/digitalPresence');
const { novoAmbiente, achado, admin, inativo } = require('../helpers/promotionFixtures');

const HOJE = '2026-10-08';
const SITE = 'https://clinicaalfa.com.br/';
const ORIGEM = 'https://clinicaalfa.com.br/contato';
const INSTAGRAM = 'https://www.instagram.com/clinicaalfa/';

// o perfil que a prospecção automática já gravou: site, WhatsApp, telefone, endereço, responsável e Instagram vieram do CÓDIGO (página oficial); o resto está pendente
function perfilAutomatico(extras = {}) {
  const base = commercial.buildCommercialProfile({
    empresa: 'Clínica Alfa',
    siteOficial: { status: 'ENCONTRADO', url: SITE },
    presencaDigital: digital.buildPresence({ officialLinks: ['https://www.instagram.com/clinicaalfa', 'https://wa.me/5524988887777'] }),
    pages: [{ origem: SITE, oficial: true, texto: 'Clínica Alfa\nRua das Flores, 10 - Centro, Petrópolis - RJ, CEP 25600-000\nProprietária: Ana Souza Lima\nTel (24) 2222-3333', links: [{ href: 'https://wa.me/5524988887777' }, { href: 'https://www.instagram.com/clinicaalfa' }] }],
    fontesDescoberta: [{ url: 'https://www.guiamais.com.br/clinica-alfa', tipo: 'DIRETORIO' }],
    fontesValidacao: [{ url: SITE, tipo: 'OFICIAL' }],
    today: HOJE,
  });
  return { ...base, contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' }, enriquecimento: { status: 'NAO_EXECUTADO', camposPendentes: commercial.enrichmentNeeds(base), limiteDeTurnos: false, motivo: 'SOB_DEMANDA' }, jobId: 'JOB-20261008-001', ...extras };
}
// um perfil sem nada além do nome (a empresa foi validada por uma página de terceiro)
const perfilVazio = () => ({ ...commercial.buildCommercialProfile({ empresa: 'Clínica Alfa', siteOficial: { status: 'NAO_ENCONTRADO', url: null }, pages: [], today: HOJE }), contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' } });

function motorFake(resposta) {
  const chamadas = [];
  let liberar = () => {};
  const portao = new Promise((resolve) => { liberar = resolve; });
  return {
    chamadas,
    liberar: () => liberar(),
    enrich: async (pedido) => {
      chamadas.push(pedido);
      if (typeof resposta === 'function') return resposta(pedido, chamadas.length, portao);
      return resposta;
    },
  };
}
const resultado = (extras) => ({ ok: true, resultados: [{ nome: 'Clínica Alfa', ...extras }] });

function montar(t, { motor, paginas = {}, perfil = perfilAutomatico(), semPerfil = false, relogio } = {}) {
  const env = novoAmbiente(t, { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') } });
  const perfis = createInMemoryLeadProfileRepository();
  const id = env.ids.alfa;
  if (!semPerfil) perfis.save(id, perfil);
  const servico = createLeadEnrichmentService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    profileRepository: perfis,
    ...(motor ? { enrichmentEngine: motor } : {}),
    createFetchPage: () => async (url) => paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' },
    now: relogio || (() => new Date(`${HOJE}T12:00:00.000Z`)),
  });
  return { env, perfis, servico, id };
}
// a fonte que o motor diz ter consultado e que o CÓDIGO consegue ler (confirma a verificação)
const PAGINA_LIDA = 'https://clinicaalfa.com.br/sobre';
const paginasLidas = (extra = {}) => ({ [PAGINA_LIDA]: { ok: true, texto: 'Clínica Alfa. Sobre nós: nossa equipe e profissionais. Fale conosco e atendimento por e-mail. Endereço e localização. Siga nossas redes sociais no Instagram. Blog, novidades e eventos.', urlFinal: PAGINA_LIDA }, ...extra });
const relogioQueAnda = (passo = 400) => {
  let t = Date.parse(`${HOJE}T12:00:00.000Z`);
  return () => new Date((t += passo));
};
const erroDe = async (fn) => {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que lançasse');
};
const perfilDe = (x) => x.perfis.getById(x.id);
const iniciarEEsperar = async (x) => {
  const iniciado = await x.servico.start(admin(), x.id);
  await x.servico.waitFor(x.id);
  return iniciado;
};

test('[DEM-1] COMPLETAR PESQUISA: responde na hora (EM_ANDAMENTO), pesquisa SÓ o que falta, registra fontes, data, duração, custo e resultado, e termina COMPLETO só com TODOS os campos resolvidos', async (t) => {
  const tudo = { emails: [{ email: 'contato@clinicaalfa.com.br', origem: ORIGEM }], trafegoPago: { meta: { resultado: 'EVIDENCIA_ENCONTRADA', url: 'https://www.facebook.com/ads/library/?id=1', data: '2026-10-01' }, google: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://adstransparency.google.com/?q=alfa' }, tiktok: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://library.tiktok.com/ads?q=alfa' } }, consultas: { presencaDigital: [PAGINA_LIDA], atividadeRecente: [PAGINA_LIDA] } };
  const motor = motorFake(resultado(tudo));
  const x = montar(t, { paginas: paginasLidas(), motor: Object.assign(motor, { enrich: async (pedido) => { motor.chamadas.push(pedido); return { ...resultado(tudo), custoUsd: 0.12, webSearchRequests: 4, turnos: 7 }; } }), relogio: relogioQueAnda() });
  const iniciado = await iniciarEEsperar(x);
  assert.equal(iniciado.status, 'EM_ANDAMENTO');
  assert.ok(iniciado.iniciadoEm && iniciado.camposSolicitados.length > 0);

  // o pedido: só o lead selecionado e só o que falta; nada do que o código já confirmou; nenhum texto de página
  assert.equal(motor.chamadas.length, 1);
  const [pedido] = motor.chamadas;
  assert.equal(pedido.leads.length, 1);
  const [lead] = pedido.leads;
  assert.deepEqual(Object.keys(lead).sort(), ['canais', 'cidade', 'fontes', 'nome', 'precisa', 'site', 'uf']);
  for (const confirmado of ['siteOficial', 'responsavel', 'endereco', 'telefones', 'whatsapps']) assert.equal(lead.precisa.includes(confirmado), false, `${confirmado} já está confirmado: não se pesquisa de novo`);
  assert.deepEqual(lead.precisa, ['emails', 'presencaDigital', 'trafegoPago', 'atividadeRecente']);
  assert.equal(JSON.stringify(pedido).includes('Rua das Flores'), false, 'nenhum texto de página vai ao motor');
  assert.ok(lead.fontes.length <= 3);
  assert.deepEqual(lead.canais, { instagram: 'https://www.instagram.com/clinicaalfa', whatsapp: 'https://wa.me/5524988887777' }, 'só os perfis JÁ confirmados');

  const status = x.servico.getStatus(admin(), x.id);
  assert.equal(status.status, 'COMPLETO');
  assert.deepEqual(status.camposPendentes, [], 'todos resolvidos: achados ou verificados com fonte lida pelo código');
  assert.deepEqual(status.camposNaoEncontrados, ['presencaDigital', 'atividadeRecente'], 'não achados, MAS com a verificação documentada');
  assert.equal(status.podeCompletar, false, 'tudo resolvido: não se repete a mesma pesquisa');

  const exec = status.ultimaExecucao;
  assert.equal(exec.resultado, 'COMPLETO');
  assert.ok(exec.iniciadoEm && exec.concluidoEm && exec.duracaoMs > 0, 'data de início/fim e duração');
  assert.deepEqual([exec.custoUsd, exec.webSearchRequests, exec.turnos], [0.12, 4, 7], 'custo informado pelo motor');
  assert.deepEqual(exec.camposObtidos, ['emails', 'trafegoPago']);
  assert.ok(exec.fontes.includes(ORIGEM) && exec.fontes.includes('https://www.facebook.com/ads/library/?id=1'), 'as fontes ficam registradas');
  assert.ok(exec.fontesNovas.includes(ORIGEM) && !exec.fontesNovas.includes(SITE), 'fontes NOVAS desta execução, separadas das acumuladas');
  assert.equal(status.custoUsd, 0.12);

  const perfil = perfilDe(x);
  assert.deepEqual(perfil.emails.map((e) => e.email), ['contato@clinicaalfa.com.br']);
  assert.equal(perfil.trafegoPago.meta.status, 'EVIDENCIA_ENCONTRADA');
  assert.equal(perfil.trafegoPago.google.status, 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', '"nenhuma evidência" é registrada com a URL da consulta, nunca como "não anuncia"');
  assert.equal(perfil.responsavel.nome, 'Ana Souza Lima', 'o confirmado antes foi preservado');
  assert.equal(perfil.telefones.length, 1);
});

test('[DEM-2] nova tentativa SÓ dos campos ainda pendentes: o limite de turnos deixa pendências, a 2ª execução pede apenas elas, e depois de tudo resolvido nada é repetido', async (t) => {
  const ads = { meta: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://www.facebook.com/ads/library/?q=alfa' }, google: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://adstransparency.google.com/?q=alfa' }, tiktok: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://library.tiktok.com/ads?q=alfa' } };
  const motor = motorFake((pedido, n) => (n === 1 ? { ...resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }] }), limiteDeTurnos: true } : resultado({ trafegoPago: ads, consultas: { presencaDigital: [PAGINA_LIDA], atividadeRecente: [PAGINA_LIDA] } })));
  const x = montar(t, { motor, paginas: paginasLidas() });
  await iniciarEEsperar(x);
  const primeiro = x.servico.getStatus(admin(), x.id);
  assert.equal(primeiro.status, 'INCOMPLETO');
  assert.equal(primeiro.limiteDeTurnos, true);
  assert.deepEqual(primeiro.camposPendentes, ['presencaDigital', 'trafegoPago', 'atividadeRecente']);
  assert.equal(primeiro.podeCompletar, true, 'dá para tentar de novo');
  assert.deepEqual(perfilDe(x).emails.map((e) => e.email), ['a@clinicaalfa.com.br'], 'o parcial foi preservado');

  await iniciarEEsperar(x);
  assert.deepEqual(motor.chamadas[1].leads[0].precisa, ['presencaDigital', 'trafegoPago', 'atividadeRecente'], 'a 2ª tentativa pede SÓ o que ficou pendente (não os e-mails)');
  const segundo = x.servico.getStatus(admin(), x.id);
  assert.equal(segundo.status, 'COMPLETO');
  assert.equal(perfilDe(x).trafegoPago.google.status, 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA');
  assert.match(perfilDe(x).trafegoPago.google.observacao, /NÃO significa/);
  assert.equal(perfilDe(x).enriquecimento.execucoes.length, 2, 'o histórico das execuções fica registrado');

  const terceiro = await x.servico.start(admin(), x.id);
  assert.equal(motor.chamadas.length, 2, 'tudo resolvido: nenhuma chamada nova');
  assert.match(terceiro.mensagem, /Nada a pesquisar/);
});

test('[DEM-3] uma execução por lead por vez; o estado (etapa, tempo decorrido) é consultável durante a pesquisa e a leitura do perfil não é bloqueada', async (t) => {
  const motor = motorFake((pedido, n, portao) => portao.then(() => resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }] })));
  const x = montar(t, { motor, relogio: relogioQueAnda(1000) });
  await x.servico.start(admin(), x.id);
  const repetido = await erroDe(() => x.servico.start(admin(), x.id));
  assert.equal(repetido.code, ENRICH_ERROR.ALREADY_RUNNING);
  assert.equal(motor.chamadas.length, 1, 'a 2ª tentativa NÃO disparou outra pesquisa');

  const andando = x.servico.getStatus(admin(), x.id);
  assert.equal(andando.status, 'EM_ANDAMENTO');
  assert.ok(['PREPARANDO', 'PESQUISANDO'].includes(andando.etapa));
  assert.ok(andando.elapsedMs > 0, 'tempo decorrido');
  assert.equal(andando.podeCompletar, false);
  assert.equal(perfilDe(x).responsavel.nome, 'Ana Souza Lima', 'o perfil continua legível durante a pesquisa');
  assert.equal(perfilDe(x).enriquecimento.status, 'EM_ANDAMENTO');

  motor.liberar();
  await x.servico.waitFor(x.id);
  assert.equal(x.servico.getStatus(admin(), x.id).status, 'INCOMPLETO', 'sem verificação documentada dos outros campos a pesquisa NÃO está completa');
  assert.deepEqual(perfilDe(x).emails.map((e) => e.email), ['a@clinicaalfa.com.br']);
});

test('[DEM-4] a mescla preserva o confirmado e não duplica: e-mails/telefones iguais viram um, o canal CONFIRMADO não é trocado, sugestão nunca vira CONFIRMADA, evidência antiga de anúncio não é rebaixada, campo NÃO pedido é ignorado', async (t) => {
  const perfil = perfilAutomatico({ trafegoPago: { meta: { status: 'EVIDENCIA_ENCONTRADA', origem: { url: 'https://www.facebook.com/ads/library/?id=antigo' }, data: '2026-09-01', observacao: 'antiga' }, google: { status: 'NAO_VERIFICADO', observacao: 'Não verificado nesta pesquisa.' }, tiktok: { status: 'NAO_VERIFICADO', observacao: 'Não verificado nesta pesquisa.' } } });
  perfil.enriquecimento.camposPendentes = commercial.enrichmentNeeds(perfil);
  const motor = motorFake(resultado({
    emails: [{ email: 'Contato@ClinicaAlfa.com.br', origem: ORIGEM }, { email: 'contato@clinicaalfa.com.br', origem: ORIGEM }, { email: 'sem-origem@x.com' }],
    telefones: [{ numero: '(24) 2222-9999', origem: ORIGEM }], // NÃO pedido (já havia telefone): ignorado
    presencaDigital: { instagram: 'https://www.instagram.com/outro_perfil', facebook: 'https://www.facebook.com/clinicaalfa', linkedin: 'https://exemplo.com/nao-e-linkedin' },
    trafegoPago: { meta: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://www.facebook.com/ads/library/?q=alfa' }, google: { resultado: 'EVIDENCIA_ENCONTRADA', url: 'https://adstransparency.google.com/advertiser/AR1', data: '2026-10-02' } },
  }));
  const x = montar(t, { motor, perfil });
  await iniciarEEsperar(x);
  const p = perfilDe(x);
  assert.deepEqual(p.emails.map((e) => e.email), ['contato@clinicaalfa.com.br'], 'sem duplicar e sem e-mail sem origem');
  assert.deepEqual(p.telefones.map((e) => e.numero), ['+552422223333'], 'o campo não pedido foi ignorado');
  assert.deepEqual([p.presencaDigital.instagram.url, p.presencaDigital.instagram.confirmacao], ['https://www.instagram.com/clinicaalfa', 'CONFIRMADO'], 'o canal confirmado por vínculo público não é trocado');
  assert.deepEqual([p.presencaDigital.facebook.status, p.presencaDigital.facebook.confirmacao, p.presencaDigital.facebook.regra], ['ENCONTRADO', 'NAO_CONFIRMADO', 'sugerido_pelo_enriquecimento'], 'URL sugerida NÃO é canal confirmado');
  assert.notEqual(p.presencaDigital.linkedin.status, 'ENCONTRADO', 'URL que não é do canal é descartada');
  assert.equal(p.trafegoPago.meta.status, 'EVIDENCIA_ENCONTRADA', 'a evidência antiga não é rebaixada para "nenhuma"');
  assert.equal(p.trafegoPago.meta.origem.url, 'https://www.facebook.com/ads/library/?id=antigo');
  assert.equal(p.trafegoPago.google.status, 'EVIDENCIA_ENCONTRADA');
  assert.equal(new Set(p.fontesEnriquecimento.map((f) => f.url)).size, p.fontesEnriquecimento.length, 'fontes sem repetição');
});

test('[DEM-5] responsável só com a página citada contendo nome E cargo; site sugerido só vale se a página o vincular à empresa — e então os contatos, o endereço e os perfis DELE entram por código', async (t) => {
  const paginas = {
    [SITE]: { ok: true, urlFinal: SITE, links: [{ href: 'https://wa.me/5524988887777' }, { href: 'https://www.instagram.com/clinicaalfa' }, { href: 'mailto:contato@clinicaalfa.com.br' }], texto: 'Clínica Alfa\nClínica de estética e harmonização facial\nRua das Flores, 10 - Petrópolis - RJ, CEP 25600-000\nTel (24) 2222-3333', identidade: 'Clínica Alfa | Clínica de estética' },
    [INSTAGRAM]: { ok: true, urlFinal: INSTAGRAM, links: [], texto: 'Clínica Alfa — Fundador: Pedro Alves', identidade: 'Clínica Alfa' },
  };
  const motor = motorFake((pedido) => resultado({ siteOficial: { url: 'https://clinicaalfa.com.br' }, responsavel: { nome: 'Pedro Alves', cargo: 'Fundador', origem: INSTAGRAM }, atividadeRecente: { canal: 'instagram', url: 'https://www.instagram.com/p/abc/', data: '2026-10-01' } }));
  const x = montar(t, { motor, paginas, perfil: perfilVazio() });
  await iniciarEEsperar(x);
  const [lead] = motor.chamadas[0].leads;
  assert.ok(lead.precisa.includes('siteOficial') && lead.precisa.includes('responsavel'));
  assert.equal(lead.site, null);
  const p = perfilDe(x);
  assert.deepEqual([p.siteOficial.status, p.siteOficial.url], ['ENCONTRADO', SITE]);
  assert.deepEqual(p.telefones.map((e) => e.numero), ['+552422223333'], 'contato extraído por CÓDIGO do site verificado');
  assert.deepEqual(p.whatsapps.map((e) => e.numero), ['+5524988887777']);
  assert.equal(p.endereco.cep, '25600-000');
  assert.deepEqual([p.presencaDigital.instagram.url, p.presencaDigital.instagram.confirmacao], ['https://www.instagram.com/clinicaalfa', 'CONFIRMADO'], 'perfil ligado por link no site oficial verificado');
  // nome + cargo + a empresa citada NÃO bastam: sem um identificador da empresa que o perfil já tivesse, o responsável fica PENDENTE_DE_CONFIRMACAO (nunca confirmado)
  assert.deepEqual([p.responsavel.status, p.responsavel.nome, p.responsavel.cargo, p.responsavel.confianca, p.responsavel.vinculo.demonstrado], ['PENDENTE_DE_CONFIRMACAO', 'Pedro Alves', 'Fundador', 'BAIXA', false]);
  assert.equal(p.atividadeRecente.ultimaPostagem, null, 'a atividade só vale em canal JÁ confirmado ANTES (o Instagram só foi confirmado nesta execução)');

  // sem prova: o site não vincula à empresa, o responsável não aparece na página citada
  const paginasFracas = { [SITE]: { ok: true, urlFinal: SITE, links: [], texto: 'Notícias de Petrópolis', identidade: 'Portal' }, [INSTAGRAM]: { ok: true, urlFinal: INSTAGRAM, links: [], texto: 'Clínica Alfa — sem nomes' } };
  const y = montar(t, { motor: motorFake((pedido) => resultado({ siteOficial: { url: 'https://clinicaalfa.com.br' }, responsavel: { nome: 'Pedro Alves', cargo: 'Fundador', origem: INSTAGRAM } })), paginas: paginasFracas, perfil: perfilVazio() });
  await iniciarEEsperar(y);
  const q = perfilDe(y);
  assert.equal(q.siteOficial.status, 'NAO_ENCONTRADO', 'site não verificado não entra');
  assert.equal(q.responsavel.status, 'NAO_ENCONTRADO', 'responsável sem prova não entra (nunca inferido)');
  const z = montar(t, { motor: motorFake(resultado({ siteOficial: { url: 'https://www.facebook.com/clinicaalfa' } })), perfil: perfilVazio() });
  await iniciarEEsperar(z);
  assert.equal(perfilDe(z).siteOficial.status, 'NAO_ENCONTRADO', 'rede social/diretório nunca vira "site oficial"');
});

test('[DEM-6] Claude indisponível, limite de uso, tempo, limite de turnos, erro: FALHOU com mensagem clara, o perfil intacto, os campos pendentes registrados e nova tentativa liberada', async (t) => {
  const casos = [
    [{ ok: false, code: 'SPAWN_FAILED' }, /não está disponível/, false],
    [{ ok: false, code: 'USAGE_LIMIT' }, /limite de uso do Claude/, false],
    [{ ok: false, code: 'TIMEOUT' }, /tempo limite/, false],
    [{ ok: false, code: 'MAX_TURNS', limiteDeTurnos: true }, /limite de turnos/, true],
    [{ ok: false, code: 'AGENT_ERROR' }, /devolveu um erro/, false],
  ];
  for (const [resposta, mensagem, limite] of casos) {
    const x = montar(t, { motor: motorFake(resposta) });
    const antes = JSON.stringify({ ...perfilDe(x), enriquecimento: undefined });
    await iniciarEEsperar(x);
    const status = x.servico.getStatus(admin(), x.id);
    assert.equal(status.status, 'FALHOU', resposta.code);
    assert.equal(status.motivo, resposta.code);
    assert.match(status.mensagem, mensagem);
    assert.equal(status.limiteDeTurnos, limite, resposta.code);
    assert.deepEqual(status.camposPendentes, ['emails', 'presencaDigital', 'trafegoPago', 'atividadeRecente']);
    assert.equal(status.podeCompletar, true, 'nova tentativa liberada');
    assert.equal(JSON.stringify({ ...perfilDe(x), enriquecimento: undefined }), antes, `${resposta.code}: nada confirmado foi alterado`);
    assert.equal(status.ultimaExecucao.resultado, 'FALHOU');
  }
  const quebrado = montar(t, { motor: { enrich: async () => { throw new Error('boom'); } } });
  await iniciarEEsperar(quebrado);
  assert.equal(quebrado.servico.getStatus(admin(), quebrado.id).motivo, 'ERRO_INTERNO');
  const semResposta = montar(t, { motor: motorFake({ ok: true, resultados: [] }) });
  await iniciarEEsperar(semResposta);
  const s = semResposta.servico.getStatus(admin(), semResposta.id);
  assert.deepEqual([s.status, s.motivo], ['INCOMPLETO', 'SEM_RESPOSTA_PARA_O_LEAD']);
});

test('[DEM-7] sem motor (Claude indisponível) o botão não pode: start responde ENRICH_UNAVAILABLE e o estado diz que não está disponível', async (t) => {
  const x = montar(t, {});
  const erro = await erroDe(() => x.servico.start(admin(), x.id));
  assert.equal(erro.code, ENRICH_ERROR.UNAVAILABLE);
  const status = x.servico.getStatus(admin(), x.id);
  assert.deepEqual([status.status, status.disponivel, status.podeCompletar], ['NAO_EXECUTADO', false, false]);
});

test('[DEM-8] NÃO altera a Approval Queue: o arquivo da fila fica byte a byte igual; sem permissão nada é lido; lead inexistente e id inválido são recusados', async (t) => {
  const motor = motorFake(resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }] }));
  const x = montar(t, { motor });
  const antes = x.env.textoDaFila();
  await iniciarEEsperar(x);
  assert.equal(x.env.textoDaFila(), antes, 'estado, decisão e histórico do item intactos');
  assert.equal(x.env.itemDaFila('alfa').estado, 'AGUARDANDO_REVISAO');

  assert.ok(await erroDe(() => x.servico.start(inativo(), x.id)), 'usuário inativo');
  assert.ok(await erroDe(() => Promise.resolve().then(() => x.servico.getStatus(inativo(), x.id))));
  assert.equal(motor.chamadas.length, 1, 'e nenhuma pesquisa foi disparada pelo recusado');
  assert.equal((await erroDe(() => x.servico.start(admin(), 'nao-existe'))).code, ENRICH_ERROR.NOT_FOUND);
  assert.equal((await erroDe(() => x.servico.start(admin(), ''))).code, ENRICH_ERROR.INVALID_INPUT);
});

test('[DEM-9] lead SEM perfil (veio de uma pesquisa manual): o perfil-base nasce do snapshot da fila (sem inventar nada) e a pesquisa roda normalmente', async (t) => {
  const motor = motorFake(resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: 'https://clinica-alfa.example.test/contato' }] }));
  const x = montar(t, { motor, semPerfil: true });
  assert.equal(perfilDe(x), null);
  await iniciarEEsperar(x);
  const p = perfilDe(x);
  assert.equal(p.empresa, 'Clínica Alfa');
  assert.deepEqual(p.contexto, { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínica de Psicologia' });
  assert.equal(p.siteOficial.status, 'ENCONTRADO', 'o site do snapshot já estava na fila');
  assert.equal(p.emails.length, 1);
  assert.equal(x.servico.getStatus(admin(), x.id).status, 'INCOMPLETO', 'só e-mails foram achados; o resto segue NAO_VERIFICADO');
});

test('[DEM-10] uma pesquisa que ficou "em andamento" no arquivo mas não roda neste processo (servidor reiniciado) aparece como FALHOU/INTERROMPIDO e pode ser retomada; e nada pendente não chama o motor', async (t) => {
  const perfil = perfilAutomatico();
  perfil.enriquecimento = { status: 'EM_ANDAMENTO', camposSolicitados: ['emails', 'trafegoPago'], camposPendentes: ['emails', 'trafegoPago'], iniciadoEm: `${HOJE}T11:00:00.000Z` };
  const motor = motorFake(resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }] }));
  const x = montar(t, { motor, perfil });
  const status = x.servico.getStatus(admin(), x.id);
  assert.deepEqual([status.status, status.motivo, status.podeCompletar], ['FALHOU', 'INTERROMPIDO', true]);
  assert.match(status.mensagem, /interrompida/);
  assert.deepEqual(status.camposPendentes, ['emails', 'trafegoPago']);
  await iniciarEEsperar(x);
  assert.deepEqual(motor.chamadas[0].leads[0].precisa, ['emails', 'trafegoPago'], 'retoma só o que estava pendente');

  // tudo o que falta com a verificação DOCUMENTADA (resultado por campo): nada a pesquisar, o motor não é chamado
  const base = perfilAutomatico();
  const documentados = Object.fromEntries(commercial.enrichmentNeeds(base).map((campo) => [campo, { status: 'NAO_ENCONTRADO_COM_VERIFICACAO', resolvido: true, fontes: [PAGINA_LIDA], execucao: `${HOJE}T10:00:00.000Z` }]));
  const motorQuieto = motorFake(resultado({}));
  const completo = montar(t, { motor: motorQuieto, perfil: perfilAutomatico({ enriquecimento: { status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: Object.keys(documentados), limiteDeTurnos: false, resolucao: documentados } }) });
  const r = await completo.servico.start(admin(), completo.id);
  assert.equal(completo.servico.getStatus(admin(), completo.id).status, 'COMPLETO');
  assert.equal(motorQuieto.chamadas.length, 0);
  assert.match(r.mensagem, /Nada a pesquisar/);
});

test('[DEM-11] o prompt do motor pede SÓ os campos listados em PROCURAR e exige JSON compacto, sem prosa; a saída é limitada aos campos conhecidos (inclusive siteOficial)', () => {
  const prompt = buildPrompt([{ nome: 'Clínica Alfa', cidade: 'Petrópolis', uf: 'RJ', site: SITE, canais: {}, fontes: [SITE], precisa: ['emails', 'trafegoPago'] }]);
  assert.match(prompt, /PROCURAR: emails\[\{email,origem\}\], trafegoPago\{/);
  assert.equal(/PROCURAR:[^\n]*responsavel\{/.test(prompt), false, 'o responsável não foi pedido');
  assert.match(prompt, /JSON compacto, sem explicações, sem resumo, sem justificativas/);
  const lido = parseEnrichment('{"leads":[{"nome":"X","siteOficial":{"url":"https://x.com.br"},"explicacao":"longa","resumo":"x","emails":[{"email":"a@b.com","origem":"https://x.com.br/"}]}]}', ['X']);
  assert.deepEqual(Object.keys(lido.resultados[0]).sort(), ['emails', 'nome', 'siteOficial']);
});

test('[DEM-12] o estado do enriquecimento fica visível ao perfil: NAO_EXECUTADO antes, INCOMPLETO/COMPLETO/FALHOU depois, com a última execução e o histórico (no máximo 10)', async (t) => {
  const motor = motorFake((pedido, n) => ({ ok: false, code: 'TIMEOUT' }));
  const x = montar(t, { motor });
  assert.equal(x.servico.getStatus(admin(), x.id).status, 'NAO_EXECUTADO');
  for (let i = 0; i < 12; i += 1) await iniciarEEsperar(x);
  const info = perfilDe(x).enriquecimento;
  assert.equal(info.status, 'FALHOU');
  assert.equal(info.execucoes.length, 10, 'o histórico guarda as 10 últimas');
  assert.equal(info.ultimaExecucao.motivo, 'TIMEOUT');
  assert.equal(fs.existsSync(x.env.queuePath), true);
});
