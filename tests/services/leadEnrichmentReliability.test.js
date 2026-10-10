'use strict';

// Ajuste de CONFIABILIDADE 3.0.2: uma execução sem erro NÃO é, por si só, uma pesquisa completa. Cada campo pedido termina ENCONTRADO, NAO_ENCONTRADO_COM_VERIFICACAO (fonte consultada E lida pelo código)
// ou NAO_VERIFICADO; o status COMPLETO exige todos resolvidos; a auditoria registra o que foi pedido/retornado/descartado, fontes novas x acumuladas e ferramentas (NAO_MEDIDO quando não há medição);
// registros antigos são lidos como LEGADO sem reescrever o histórico; uma nova tentativa manual pesquisa só o que não está resolvido. Peças REAIS: Approval Queue em arquivo temporário, autorizador,
// perfil comercial, mescla; FAKES: o motor de enriquecimento e a leitura de página. Nenhuma rede, nenhum `claude`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadEnrichmentService, ENRICH_ERROR } = require('../../src/services/leadEnrichmentService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const { buildPrompt, parseEnrichment } = require('../../src/prospecting-adapters/claudeEnrichmentEngine');
const resolution = require('../../src/research-prospector/enrichmentResolution');
const commercial = require('../../src/research-prospector/commercialProfile');
const digital = require('../../src/research-prospector/digitalPresence');
const { novoAmbiente, achado, admin, closer, inativo } = require('../helpers/promotionFixtures');

const HOJE = '2026-10-08';
const SITE = 'https://clinicaalfa.com.br/';
const ORIGEM = 'https://clinicaalfa.com.br/contato';
const LIDA = 'https://clinicaalfa.com.br/sobre';
const LIDA_2 = 'https://clinicaalfa.com.br/equipe';
const INACESSIVEL = 'https://fora-do-ar.clinicaalfa.com.br/';
const ADS = {
  meta: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://www.facebook.com/ads/library/?q=alfa' },
  google: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://adstransparency.google.com/?q=alfa' },
  tiktok: { resultado: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', url: 'https://library.tiktok.com/ads?q=alfa' },
};

// o perfil que a prospecção automática gravou: faltam e-mails, presença digital (demais canais), tráfego pago e atividade recente
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
const perfilVazio = () => ({ ...commercial.buildCommercialProfile({ empresa: 'Clínica Alfa', siteOficial: { status: 'NAO_ENCONTRADO', url: null }, pages: [], today: HOJE }), contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' } });

// o registro que a execução ANTERIOR a este ajuste deixou para a Empresa Exemplo Alfa: COMPLETO, três campos "não encontrados", 21,5 s, 5 turnos, ~US$ 0,07 — sem o resultado por campo
const EXECUCAO_LEGADA = Object.freeze({
  iniciadoEm: '2026-10-09T01:09:39.465Z',
  concluidoEm: '2026-10-09T01:10:00.957Z',
  duracaoMs: 21492,
  custoUsd: 0.067777,
  webSearchRequests: 0,
  turnos: 5,
  camposSolicitados: ['emails', 'atividadeRecente'],
  camposObtidos: [],
  camposPendentes: [],
  resultado: 'COMPLETO',
  motivo: null,
  fontes: ['https://www.guiamais.com.br/clinica-alfa'],
});
const perfilLegadoCompleto = () => perfilAutomatico({
  enriquecimento: { status: 'COMPLETO', camposPendentes: [], camposNaoEncontrados: ['emails', 'atividadeRecente'], limiteDeTurnos: false, ultimaExecucao: { ...EXECUCAO_LEGADA }, execucoes: [{ ...EXECUCAO_LEGADA }] },
});

function motorFake(resposta) {
  const chamadas = [];
  let liberar = () => {};
  const portao = new Promise((resolve) => { liberar = resolve; });
  return { chamadas, liberar: () => liberar(), enrich: async (pedido) => { chamadas.push(pedido); return typeof resposta === 'function' ? resposta(pedido, chamadas.length, portao) : resposta; } };
}
const resultado = (extras, telemetria = {}) => ({ ok: true, ...telemetria, resultados: [{ nome: 'Clínica Alfa', ...extras }] });
const paginasLidas = (extra = {}) => ({ [LIDA]: { ok: true, urlFinal: LIDA, texto: 'Clínica Alfa. Sobre nós: nossa equipe e profissionais. Fale conosco e atendimento por e-mail. Endereço e localização. Siga nossas redes sociais no Instagram. Blog, novidades e eventos.' }, [LIDA_2]: { ok: true, urlFinal: LIDA_2, texto: 'Clínica Alfa. Sobre nós: nossa equipe e profissionais. Fale conosco e atendimento por e-mail. Endereço e localização. Siga nossas redes sociais no Instagram. Blog, novidades e eventos.' }, ...extra });

function montar(t, { motor, paginas = paginasLidas(), perfil = perfilAutomatico(), leitor = 'mapa', entradas, preparar } = {}) {
  const env = novoAmbiente(t, entradas || { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') } });
  if (preparar) preparar(env);
  const perfis = createInMemoryLeadProfileRepository();
  const id = env.ids.alfa;
  if (perfil) perfis.save(id, perfil);
  let relogio = Date.parse(`${HOJE}T12:00:00.000Z`);
  const servico = createLeadEnrichmentService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    profileRepository: perfis,
    ...(motor ? { enrichmentEngine: motor } : {}),
    ...(leitor === 'sem' ? {} : { createFetchPage: () => (leitor === 'quebrado' ? async () => { throw new Error('rede'); } : async (url) => paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' }) }),
    now: () => new Date((relogio += 400)),
  });
  return { env, perfis, servico, id };
}
const perfilDe = (x) => x.perfis.getById(x.id);
const rodar = async (x, ator = admin()) => {
  const iniciado = await x.servico.start(ator, x.id);
  await x.servico.waitFor(x.id);
  return iniciado;
};
const status = (x) => x.servico.getStatus(admin(), x.id);
const erroDe = async (fn) => {
  try {
    await fn();
  } catch (erro) {
    return erro;
  }
  throw new Error('esperava que lançasse');
};
const ultima = (x) => perfilDe(x).enriquecimento.ultimaExecucao;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. CLASSIFICAÇÃO POR CAMPO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CONF-1] resposta VAZIA do Claude: sem resposta para o lead, resposta só com o nome e valores vazios NÃO viram "não encontrado" — tudo NAO_VERIFICADO, nunca COMPLETO', async (t) => {
  const semLead = montar(t, { motor: motorFake({ ok: true, resultados: [] }) });
  await rodar(semLead);
  const a = status(semLead);
  assert.deepEqual([a.status, a.motivo, a.pesquisaCompleta, a.podeCompletar], ['INCOMPLETO', 'SEM_RESPOSTA_PARA_O_LEAD', false, true]);
  assert.deepEqual(a.camposPendentes, ['emails', 'presencaDigital', 'trafegoPago', 'atividadeRecente']);
  assert.deepEqual(a.camposNaoEncontrados, []);
  for (const campo of a.camposPendentes) assert.deepEqual([a.resolucao[campo].status, a.resolucao[campo].motivo], ['NAO_VERIFICADO', 'SEM_RESPOSTA_PARA_O_LEAD'], campo);
  assert.equal(a.ultimaExecucao.encerramento, 'SEM_RESPOSTA_PARA_O_LEAD');

  // o motor respondeu para o lead, mas só com o nome / com valores vazios: nada foi retornado, nada foi consultado, nada é "não encontrado"
  for (const corpo of [{}, { emails: [], presencaDigital: {}, trafegoPago: null, atividadeRecente: {}, consultas: {} }]) {
    const x = montar(t, { motor: motorFake(resultado(corpo)) });
    await rodar(x);
    const s = status(x);
    assert.deepEqual([s.status, s.motivo], ['INCOMPLETO', 'VERIFICACAO_INSUFICIENTE'], JSON.stringify(corpo));
    assert.deepEqual(s.camposNaoEncontrados, []);
    assert.deepEqual(ultima(x).camposRetornados, []);
    for (const campo of s.camposPendentes) assert.deepEqual([s.resolucao[campo].status, s.resolucao[campo].motivo], ['NAO_VERIFICADO', 'OMITIDO_SEM_CONSULTA'], campo);
    assert.equal(s.mensagem, 'A pesquisa terminou sem documentar a verificação de alguns campos: eles continuam NÃO VERIFICADOS e podem ser pesquisados de novo.');
  }
});

test('[CONF-2] CAMPO OMITIDO: sem consulta documentada, com fonte que o código não conseguiu ler, ou sem leitor de página — NAO_VERIFICADO com o motivo certo, nunca "não encontrado"', async (t) => {
  const omitido = montar(t, { motor: motorFake(resultado({ emails: [{ email: 'contato@clinicaalfa.com.br', origem: ORIGEM }] })) });
  await rodar(omitido);
  const a = status(omitido);
  assert.equal(a.resolucao.emails.status, 'ENCONTRADO');
  assert.deepEqual(['presencaDigital', 'trafegoPago', 'atividadeRecente'].map((c) => [a.resolucao[c].status, a.resolucao[c].motivo]), Array(3).fill(['NAO_VERIFICADO', 'OMITIDO_SEM_CONSULTA']));

  const naoLida = montar(t, { motor: motorFake(resultado({ consultas: { atividadeRecente: [INACESSIVEL] } })) });
  await rodar(naoLida);
  assert.deepEqual([status(naoLida).resolucao.atividadeRecente.status, status(naoLida).resolucao.atividadeRecente.motivo], ['NAO_VERIFICADO', 'FONTES_NAO_CONFIRMADAS']);

  const semLeitor = montar(t, { motor: motorFake(resultado({ consultas: { atividadeRecente: [LIDA] } })), leitor: 'sem' });
  await rodar(semLeitor);
  assert.deepEqual([status(semLeitor).resolucao.atividadeRecente.status, status(semLeitor).resolucao.atividadeRecente.motivo], ['NAO_VERIFICADO', 'SEM_LEITURA_DE_PAGINA']);
});

test('[CONF-3] CAMPO ENCONTRADO COM EVIDÊNCIA vira ENCONTRADO; o que o motor trouxe e a validação DESCARTOU fica registrado com o motivo e vira NAO_VERIFICADO (não "não encontrado")', async (t) => {
  const x = montar(t, {
    perfil: perfilVazio(),
    paginas: paginasLidas({ [LIDA_2]: { ok: true, urlFinal: LIDA_2, texto: 'Equipe da clínica, sem citar ninguém' } }),
    motor: motorFake(resultado({
      emails: [{ email: 'contato@clinicaalfa.com.br', origem: ORIGEM }],
      responsavel: { nome: 'Carlos Pereira', cargo: 'Diretor', origem: LIDA_2 }, // a página citada NÃO contém o nome: descartado
      telefones: [{ numero: '(24) 2222-3333', origem: ORIGEM }],
      atividadeRecente: { canal: 'instagram', url: 'https://www.instagram.com/clinicaalfa/p/1', data: '2026-10-01' }, // sem canal confirmado o campo nem é pedido: a resposta é ignorada
    })),
  });
  await rodar(x);
  const s = status(x);
  assert.equal(s.resolucao.emails.status, 'ENCONTRADO');
  assert.equal(s.resolucao.telefones.status, 'ENCONTRADO');
  assert.deepEqual([s.resolucao.responsavel.status, s.resolucao.responsavel.motivo], ['NAO_VERIFICADO', 'ORIGEM_NAO_CONFIRMA_NOME_E_CARGO']);
  assert.deepEqual([s.resolucao.atividadeRecente.status, s.resolucao.atividadeRecente.motivo, s.resolucao.atividadeRecente.bloqueio], ['NAO_VERIFICADO', 'BLOQUEADO_POR_PRE_REQUISITO', 'BLOQUEADO_POR_PRE_REQUISITO']);
  const registro = ultima(x);
  assert.deepEqual(registro.camposRetornados.sort(), ['emails', 'responsavel', 'telefones']);
  assert.deepEqual(registro.camposDescartados, [{ campo: 'responsavel', motivo: 'ORIGEM_NAO_CONFIRMA_NOME_E_CARGO' }]);
  assert.deepEqual(registro.camposObtidos.sort(), ['emails', 'telefones']);
  assert.equal(perfilDe(x).responsavel.status === 'ENCONTRADO', false, 'o que não passou na validação não entra no perfil');

  // a página do SITE OFICIAL confirmado com nome E cargo: o responsável é ENCONTRADO, com o vínculo demonstrado
  const ok = montar(t, { perfil: { ...perfilVazio(), siteOficial: { status: 'ENCONTRADO', url: SITE } }, paginas: paginasLidas({ [LIDA_2]: { ok: true, urlFinal: LIDA_2, texto: 'Carlos Pereira — Diretor da Clínica Alfa' } }), motor: motorFake(resultado({ responsavel: { nome: 'Carlos Pereira', cargo: 'Diretor', origem: LIDA_2 } })) });
  await rodar(ok);
  assert.equal(status(ok).resolucao.responsavel.status, 'ENCONTRADO');
  assert.equal(perfilDe(ok).responsavel.nome, 'Carlos Pereira');
  assert.deepEqual([perfilDe(ok).responsavel.vinculo.demonstrado, perfilDe(ok).responsavel.vinculo.regra], [true, 'SITE_OFICIAL']);
});

test('[CONF-4] AUSÊNCIA DOCUMENTADA: campo omitido COM fonte consultada que o código leu = NAO_ENCONTRADO_COM_VERIFICACAO (com as fontes); com tudo resolvido o status é COMPLETO — sem afirmar que não existe', async (t) => {
  const x = montar(t, { motor: motorFake(resultado({ trafegoPago: ADS, consultas: { emails: [LIDA, LIDA_2], presencaDigital: [LIDA], atividadeRecente: [LIDA_2, LIDA] } })) });
  await rodar(x);
  const s = status(x);
  assert.deepEqual([s.status, s.pesquisaCompleta, s.podeCompletar], ['COMPLETO', true, false]);
  assert.deepEqual(s.camposNaoEncontrados, ['emails', 'presencaDigital', 'trafegoPago', 'atividadeRecente']);
  assert.deepEqual(s.camposPendentes, []);
  assert.deepEqual(s.resolucao.emails.fontes, [LIDA], 'para na PRIMEIRA fonte pertinente: só ela fica registrada (LIDA_2 nem é lida)');
  assert.equal(s.resolucao.emails.status, 'NAO_ENCONTRADO_COM_VERIFICACAO');
  assert.deepEqual(s.resolucao.trafegoPago.fontes, [ADS.meta.url, ADS.google.url, ADS.tiktok.url], '"nenhuma evidência" tem a consulta como fonte');
  assert.equal(ultima(x).encerramento, 'CONCLUIDA');
  assert.equal(JSON.stringify(s).toLowerCase().includes('não existe'), false, 'nada afirma inexistência');
});

test('[CONF-5] AUSÊNCIA SEM EVIDÊNCIA: fontes citadas mas ilegíveis, ou a leitura quebrando, NÃO documentam nada — NAO_VERIFICADO; só o campo realmente documentado fica resolvido e o status segue INCOMPLETO', async (t) => {
  const x = montar(t, { motor: motorFake(resultado({ consultas: { emails: [LIDA], presencaDigital: [INACESSIVEL], atividadeRecente: [INACESSIVEL, 'http://inseguro.com.br/'] } })) });
  await rodar(x);
  const s = status(x);
  assert.equal(s.status, 'INCOMPLETO');
  assert.deepEqual(s.camposNaoEncontrados, ['emails']);
  assert.deepEqual(s.camposPendentes, ['presencaDigital', 'trafegoPago', 'atividadeRecente']);
  assert.equal(s.resolucao.presencaDigital.motivo, 'FONTES_NAO_CONFIRMADAS');
  assert.equal(s.resolucao.atividadeRecente.motivo, 'FONTES_NAO_CONFIRMADAS', 'http inseguro nem entra como fonte');
  assert.equal(s.resolucao.trafegoPago.motivo, 'OMITIDO_SEM_CONSULTA');

  const quebrado = montar(t, { motor: motorFake(resultado({ consultas: { emails: [LIDA] } })), leitor: 'quebrado' });
  await rodar(quebrado);
  const q = status(quebrado);
  assert.equal(q.status, 'INCOMPLETO', 'leitura de página que falha não derruba a pesquisa');
  assert.equal(q.resolucao.emails.status, 'NAO_VERIFICADO');
});

test('[CONF-6] LIMITE DE TURNOS: o cortado nunca é "não encontrado", mesmo com consultas declaradas; o já achado é guardado; o encerramento é LIMITE_DE_TURNOS', async (t) => {
  const x = montar(t, { motor: motorFake({ ...resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }], consultas: { atividadeRecente: [LIDA] } }), limiteDeTurnos: true, turnos: 12 }) });
  await rodar(x);
  const s = status(x);
  assert.deepEqual([s.status, s.motivo, s.limiteDeTurnos], ['INCOMPLETO', 'MAX_TURNS', true]);
  assert.equal(s.resolucao.emails.status, 'ENCONTRADO');
  assert.deepEqual([s.resolucao.atividadeRecente.status, s.resolucao.atividadeRecente.motivo], ['NAO_VERIFICADO', 'LIMITE_DE_TURNOS']);
  assert.deepEqual(s.camposNaoEncontrados, []);
  assert.equal(ultima(x).encerramento, 'LIMITE_DE_TURNOS');
  assert.deepEqual(perfilDe(x).emails.map((e) => e.email), ['a@clinicaalfa.com.br']);

  const semNada = montar(t, { motor: motorFake({ ok: false, code: 'MAX_TURNS', limiteDeTurnos: true, turnos: 12 }) });
  await rodar(semNada);
  const f = status(semNada);
  assert.deepEqual([f.status, f.motivo, f.limiteDeTurnos], ['FALHOU', 'MAX_TURNS', true]);
  for (const campo of f.camposPendentes) assert.equal(f.resolucao[campo].motivo, 'LIMITE_DE_TURNOS');
});

test('[CONF-7] FALHA PARCIAL e falhas totais: erro do motor, USAGE_LIMIT, exceção — todos os campos NAO_VERIFICADO com o motivo; nada confirmado é alterado; nova tentativa liberada', async (t) => {
  for (const resposta of [{ ok: false, code: 'USAGE_LIMIT' }, { ok: false, code: 'TIMEOUT' }, { ok: false, code: 'OUTPUT_INVALID' }]) {
    const x = montar(t, { motor: motorFake(resposta) });
    const antes = JSON.stringify({ ...perfilDe(x), enriquecimento: undefined });
    await rodar(x);
    const s = status(x);
    assert.deepEqual([s.status, s.motivo, s.podeCompletar], ['FALHOU', resposta.code, true]);
    for (const campo of s.camposPendentes) assert.deepEqual([s.resolucao[campo].status, s.resolucao[campo].motivo], ['NAO_VERIFICADO', resposta.code]);
    assert.equal(ultima(x).encerramento, resposta.code);
    assert.equal(JSON.stringify({ ...perfilDe(x), enriquecimento: undefined }), antes, 'nada confirmado foi alterado');
  }
  const quebrado = montar(t, { motor: { enrich: async () => { throw new Error('boom'); } } });
  await rodar(quebrado);
  assert.deepEqual([status(quebrado).status, status(quebrado).motivo], ['FALHOU', 'ERRO_INTERNO']);
});

test('[CONF-8] TRÁFEGO PAGO: "nenhuma evidência" nas TRÊS plataformas é ausência documentada; em só uma é parcial (sobra NAO_VERIFICADO); com evidência é ENCONTRADO — nunca "não anuncia"', async (t) => {
  const tres = montar(t, { motor: motorFake(resultado({ trafegoPago: ADS })) });
  await rodar(tres);
  assert.deepEqual([status(tres).resolucao.trafegoPago.status, status(tres).resolucao.trafegoPago.resolvido], ['NAO_ENCONTRADO_COM_VERIFICACAO', true]);
  assert.match(perfilDe(tres).trafegoPago.meta.observacao, /NÃO significa/);

  const so1 = montar(t, { motor: motorFake(resultado({ trafegoPago: { meta: ADS.meta } })) });
  await rodar(so1);
  const p = status(so1).resolucao.trafegoPago;
  assert.deepEqual([p.status, p.resolvido, p.parcial], ['NAO_ENCONTRADO_COM_VERIFICACAO', false, true]);
  assert.ok(status(so1).camposPendentes.includes('trafegoPago'));

  const evidencia = montar(t, { motor: motorFake(resultado({ trafegoPago: { ...ADS, meta: { resultado: 'EVIDENCIA_ENCONTRADA', url: 'https://www.facebook.com/ads/library/?id=1', data: '2026-10-01' } } })) });
  await rodar(evidencia);
  assert.equal(status(evidencia).resolucao.trafegoPago.status, 'ENCONTRADO');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. TELEMETRIA E AUDITORIA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CONF-9] cada execução registra: campos solicitados/retornados/descartados, fontes NOVAS x acumuladas, ferramentas (NAO_MEDIDO quando não há medição), tempo, turnos, custo, encerramento e o resultado de CADA campo — sem resposta bruta', async (t) => {
  const x = montar(t, { motor: motorFake(resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }], consultas: { atividadeRecente: [LIDA] } }, { custoUsd: 0.2, webSearchRequests: 3, turnos: 6 })) });
  await rodar(x);
  const r = ultima(x);
  assert.deepEqual(r.camposSolicitados, ['emails', 'presencaDigital', 'trafegoPago', 'atividadeRecente']);
  assert.deepEqual(r.camposRetornados, ['emails']);
  assert.deepEqual(r.camposDescartados, []);
  assert.deepEqual(r.ferramentas, { webSearch: 3, webFetch: 'NAO_MEDIDO' }, 'o WebFetch o executor não mede: NAO_MEDIDO, nunca zero inventado');
  assert.deepEqual([r.custoUsd, r.turnos, r.encerramento, r.resultado], [0.2, 6, 'CONCLUIDA', 'INCOMPLETO']);
  assert.ok(r.duracaoMs > 0 && r.iniciadoEm && r.concluidoEm);
  assert.deepEqual(Object.keys(r.resultadosPorCampo), r.camposSolicitados, 'um resultado por campo pedido');
  assert.equal(r.resultadosPorCampo.atividadeRecente.status, 'NAO_ENCONTRADO_COM_VERIFICACAO');
  assert.ok(r.fontesNovas.includes(ORIGEM), 'a origem do e-mail é fonte NOVA');
  assert.ok(r.fontes.includes(ORIGEM) && r.fontes.includes(SITE), 'as acumuladas incluem as novas E as que o perfil já tinha');
  assert.ok(r.fontes.length >= r.fontesNovas.length);
  assert.ok(JSON.stringify(r).length < 4000, 'registro compacto, sem resposta bruta');
  for (const proibido of ['resposta', 'raw', 'texto', 'prompt']) assert.equal(proibido in r, false, proibido);

  // sem telemetria do executor: tudo NAO_MEDIDO
  const sem = montar(t, { motor: motorFake(resultado({})) });
  await rodar(sem);
  assert.deepEqual(ultima(sem).ferramentas, { webSearch: 'NAO_MEDIDO', webFetch: 'NAO_MEDIDO' });
  assert.deepEqual([ultima(sem).custoUsd, ultima(sem).turnos], [null, null]);

  // a 2ª execução: as fontes novas são só o que ELA acrescentou
  const segunda = montar(t, { motor: motorFake((pedido, n) => resultado(n === 1 ? { emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }] } : { atividadeRecente: { canal: 'instagram', url: 'https://www.instagram.com/clinicaalfa/p/9', data: '2026-10-05' } })) });
  await rodar(segunda);
  const primeiraFontes = ultima(segunda).fontes;
  await rodar(segunda);
  const r2 = ultima(segunda);
  assert.deepEqual(r2.fontes.filter((f) => !primeiraFontes.includes(f)), r2.fontesNovas, 'novas = acumuladas menos as que já existiam');
  assert.equal(r2.fontesNovas.includes(ORIGEM), false);
});

test('[CONF-10] o resultado por campo fica no perfil e é a base das leituras seguintes; o histórico guarda cada execução com os dois resultados', async (t) => {
  const x = montar(t, { motor: motorFake(resultado({ consultas: { emails: [LIDA] } })) });
  await rodar(x);
  const info = perfilDe(x).enriquecimento;
  assert.equal(info.resolucao.emails.status, 'NAO_ENCONTRADO_COM_VERIFICACAO');
  assert.equal(info.resolucao.emails.execucao, info.ultimaExecucao.iniciadoEm);
  assert.deepEqual(info.execucoes.map((e) => e.resultado), ['INCOMPLETO']);
  assert.deepEqual(info.camposNaoEncontrados, ['emails']);
  assert.equal(Object.prototype.hasOwnProperty.call(info, 'legado'), false, 'perfil novo não ganha origem LEGADO');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. COMPATIBILIDADE COM PERFIS ANTIGOS (LEGADO)
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CONF-11] COMPLETO antigo (Empresa Exemplo Alfa) é lido como NÃO VERIFICADO/LEGADO SEM reescrever nada: o estado gravado, o histórico e os dados ficam idênticos; nenhuma execução é inventada', async (t) => {
  const x = montar(t, { motor: motorFake(resultado({})), perfil: perfilLegadoCompleto() });
  const gravadoAntes = JSON.stringify(perfilDe(x));
  const s = status(x);
  assert.equal(JSON.stringify(perfilDe(x)), gravadoAntes, 'ler o estado NÃO grava nada');
  assert.deepEqual([s.status, s.statusRegistrado, s.origem, s.pesquisaCompleta], ['INCOMPLETO', 'COMPLETO', 'LEGADO', false]);
  assert.deepEqual(s.camposPendentes, ['emails', 'atividadeRecente'], 'só os campos que aquele registro tinha pedido');
  assert.deepEqual(s.camposNaoEncontrados, [], 'sem verificação documentada não há "não encontrado"');
  assert.deepEqual(['emails', 'atividadeRecente'].map((c) => [s.resolucao[c].status, s.resolucao[c].origem]), Array(2).fill(['NAO_VERIFICADO', 'LEGADO']));
  assert.equal(s.resolucao.emails.motivo, 'EXECUCAO_ANTERIOR_SEM_VERIFICACAO_REGISTRADA');
  assert.equal(s.ultimaExecucao.origem, 'LEGADO');
  assert.deepEqual([s.ultimaExecucao.duracaoMs, s.ultimaExecucao.custoUsd, s.ultimaExecucao.turnos], [21492, 0.067777, 5], 'custo e duração reais preservados');
  assert.match(s.mensagem, /registrada como concluída, mas não guardou a verificação/);
  assert.equal(s.podeCompletar, true);
  assert.equal(x.perfis.getById(x.id).enriquecimento.status, 'COMPLETO', 'o registro gravado continua dizendo COMPLETO');
});

test('[CONF-12] NOVA TENTATIVA MANUAL após um COMPLETO sem resultado: pesquisa SÓ os campos não resolvidos, preserva o histórico real e a origem LEGADO, e não é automática', async (t) => {
  const motor = motorFake((pedido, n) => (n === 1 ? resultado({}) : resultado({ consultas: { emails: [LIDA], atividadeRecente: [LIDA_2] } })));
  const x = montar(t, { motor, perfil: perfilLegadoCompleto() });
  for (let i = 0; i < 3; i += 1) status(x);
  assert.equal(motor.chamadas.length, 0, 'ler o estado nunca inicia uma pesquisa');

  await rodar(x);
  assert.deepEqual(motor.chamadas[0].leads[0].precisa, ['emails', 'atividadeRecente'], 'só o que não estava resolvido (não presença digital nem tráfego pago, que aquele registro não tinha pedido)');
  const depois = perfilDe(x).enriquecimento;
  assert.equal(depois.status, 'INCOMPLETO', 'a nova tentativa também não documentou nada');
  assert.deepEqual(depois.execucoes.length, 2);
  assert.deepEqual(depois.execucoes[0], { ...EXECUCAO_LEGADA }, 'a execução real antiga está intacta (sem campos acrescentados, sem reescrita)');
  assert.deepEqual([depois.legado.origem, depois.legado.statusAnterior, depois.legado.camposNaoEncontradosAnterior, depois.legado.limiteDeTurnosAnterior], ['LEGADO', 'COMPLETO', ['emails', 'atividadeRecente'], false]);
  assert.equal(status(x).origem, 'LEGADO');

  // a 2ª tentativa, agora com fontes lidas: tudo resolvido -> COMPLETO verdadeiro
  await rodar(x);
  const fim = status(x);
  assert.deepEqual([fim.status, fim.pesquisaCompleta, fim.podeCompletar], ['COMPLETO', true, false]);
  assert.deepEqual(fim.camposNaoEncontrados, ['emails', 'atividadeRecente']);
  assert.equal(perfilDe(x).enriquecimento.execucoes.length, 3);
  assert.equal(perfilDe(x).enriquecimento.legado.statusAnterior, 'COMPLETO', 'a origem LEGADO continua preservada');
  assert.equal(motor.chamadas.length, 2);
  assert.equal((await rodar(x), motor.chamadas.length), 2, 'tudo resolvido: nenhuma chamada nova');
});

test('[CONF-13] PRESERVAÇÃO de dados confirmados: o que já estava confirmado não é pesquisado, reescrito nem rebaixado, mesmo que o motor devolva outra coisa; o parcial achado numa tentativa é mantido na seguinte', async (t) => {
  const motor = motorFake((pedido, n) => (n === 1
    ? resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }], responsavel: { nome: 'Outra Pessoa', cargo: 'Dona', origem: LIDA }, telefones: [{ numero: '(24) 3333-4444', origem: ORIGEM }], endereco: { rua: 'Rua Falsa, 1', origem: ORIGEM }, siteOficial: { url: 'https://outro-site.com.br' } })
    : resultado({ consultas: { presencaDigital: [LIDA], atividadeRecente: [LIDA] } })));
  const x = montar(t, { motor });
  const antes = perfilDe(x);
  await rodar(x);
  const p = perfilDe(x);
  for (const campo of ['responsavel', 'endereco', 'telefones', 'whatsapps', 'siteOficial']) assert.deepEqual(p[campo], antes[campo], `${campo} confirmado: intacto`);
  assert.equal(p.presencaDigital.instagram.confirmacao, 'CONFIRMADO');
  assert.deepEqual(p.emails.map((e) => e.email), ['a@clinicaalfa.com.br']);
  assert.deepEqual(motor.chamadas[0].leads[0].precisa, ['emails', 'presencaDigital', 'trafegoPago', 'atividadeRecente']);
  assert.deepEqual(ultima(x).camposRetornados, ['emails'], 'o que não foi pedido é ignorado (nem conta como retornado)');

  await rodar(x);
  assert.deepEqual(motor.chamadas[1].leads[0].precisa, ['presencaDigital', 'trafegoPago', 'atividadeRecente'], 'o e-mail achado não é pesquisado de novo');
  assert.deepEqual(perfilDe(x).emails.map((e) => e.email), ['a@clinicaalfa.com.br'], 'o parcial foi mantido');
});

test('[CONF-14] COMPATIBILIDADE com perfis 3.0.1 (job, INCOMPLETO por limite de turnos, sem contexto) e 3.0.2 (NAO_EXECUTADO / COMPLETO anterior ao ajuste): lidos sem erro, sem escrita, cada um com a interpretação certa', async (t) => {
  const v301 = perfilAutomatico({ enriquecimento: { status: 'INCOMPLETO', camposPendentes: ['emails', 'atividadeRecente'], limiteDeTurnos: true, camposNaoEncontrados: [] } });
  delete v301.contexto;
  const a = montar(t, { motor: motorFake(resultado({})), perfil: v301 });
  const gravadoA = JSON.stringify(perfilDe(a));
  const sa = status(a);
  assert.equal(JSON.stringify(perfilDe(a)), gravadoA);
  assert.deepEqual([sa.status, sa.limiteDeTurnos, sa.origem, sa.podeCompletar], ['INCOMPLETO', true, 'LEGADO', true]);
  assert.deepEqual(sa.camposPendentes, ['emails', 'atividadeRecente']);
  assert.deepEqual([sa.resolucao.emails.status, sa.resolucao.emails.motivo, sa.resolucao.emails.origem], ['NAO_VERIFICADO', 'LIMITE_DE_TURNOS', 'LEGADO']);
  await rodar(a);
  assert.deepEqual(perfilDe(a).contexto, { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínica de Psicologia' }, 'contexto inicializado do snapshot da fila');
  assert.equal(perfilDe(a).enriquecimento.legado.limiteDeTurnosAnterior, true);

  const v302 = montar(t, { motor: motorFake(resultado({})), perfil: perfilAutomatico() });
  const s302 = status(v302);
  assert.deepEqual([s302.status, s302.origem, s302.podeCompletar], ['NAO_EXECUTADO', null, true]);
  assert.equal(s302.resolucao.emails.motivo, 'NAO_PESQUISADO');
  assert.equal('legado' in perfilDe(v302).enriquecimento, false);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4. PERMISSÕES, CONCORRÊNCIA E SEGURANÇA
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CONF-15] PERMISSÕES e CONCORRÊNCIA: usuário inativo não vê nem inicia; uma pesquisa por vez no processo (outro lead = ENRICH_BUSY, o mesmo = ALREADY_RUNNING); nova tentativa só depois; sem motor não há nova tentativa', async (t) => {
  const motor = motorFake((pedido, n, portao) => portao.then(() => resultado({})));
  const x = montar(t, { motor, perfil: perfilLegadoCompleto(), entradas: { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') }, beta: { finding: achado('Clínica Beta', 'clinica-beta') } } });
  assert.ok(await erroDe(() => Promise.resolve().then(() => x.servico.getStatus(inativo(), x.id))));
  assert.ok(await erroDe(() => x.servico.start(inativo(), x.id)));
  assert.equal(motor.chamadas.length, 0);

  await x.servico.start(closer(), x.id); // o closer tem APPROVE:LEAD_APPROVAL
  assert.equal((await erroDe(() => x.servico.start(admin(), x.id))).code, ENRICH_ERROR.ALREADY_RUNNING);
  assert.equal((await erroDe(() => x.servico.start(admin(), x.env.ids.beta))).code, ENRICH_ERROR.BUSY);
  assert.equal(x.servico.getStatus(admin(), x.env.ids.beta).podeCompletar, false, 'durante a pesquisa de outro lead o botão fica bloqueado');
  assert.equal(motor.chamadas.length, 1);
  motor.liberar();
  await x.servico.waitFor(x.id);
  assert.equal(x.servico.getStatus(admin(), x.id).podeCompletar, true, 'terminou: dá para tentar de novo, manualmente');

  const semMotor = montar(t, { perfil: perfilLegadoCompleto() });
  assert.deepEqual([semMotor.servico.getStatus(admin(), semMotor.id).podeCompletar, semMotor.servico.getStatus(admin(), semMotor.id).disponivel], [false, false]);
  assert.equal((await erroDe(() => semMotor.servico.start(admin(), semMotor.id))).code, ENRICH_ERROR.UNAVAILABLE);
});

test('[CONF-16] SEGURANÇA: Approval Queue/CRM/DNC/estado comercial intactos; lead em DNC não é pesquisado nem num COMPLETO antigo; a pesquisa não toca na revisão de site; o Service não importa CRM nem grava a fila', async (t) => {
  const motor = motorFake(resultado({ emails: [{ email: 'a@clinicaalfa.com.br', origem: ORIGEM }] }));
  const x = montar(t, { motor, perfil: perfilLegadoCompleto() });
  const filaAntes = x.env.textoDaFila();
  const itemAntes = JSON.stringify(x.env.itemDaFila('alfa'));
  const site = { propostaSite: { status: 'PENDENTE', dominioAtual: SITE, dominioNovo: 'https://alfa-novo.com.br/' }, decisoesSite: [{ decisao: 'MANTIDA', usuario: { name: 'Breno' }, data: `${HOJE}T10:00:00.000Z` }], revisaoSite: { status: 'CONCLUIDA', ultimaRevisao: { resultado: 'PROPOSTA_PENDENTE' }, historico: [] } };
  x.perfis.save(x.id, { ...perfilDe(x), ...site });
  await rodar(x);
  assert.equal(x.env.textoDaFila(), filaAntes, 'Approval Queue byte a byte igual');
  assert.equal(JSON.stringify(x.env.itemDaFila('alfa')), itemAntes, 'estado, decisão e histórico do lead intactos');
  for (const campo of Object.keys(site)) assert.deepEqual(perfilDe(x)[campo], site[campo], `${campo}: a pesquisa não toca na revisão de site`);

  // a REVISÃO de site, por sua vez, não mexe no resultado por campo
  const camposAntes = JSON.stringify(perfilDe(x).enriquecimento.resolucao);
  const y = montar(t, { motor: motorFake({ ok: true, resultados: [{ nome: 'Clínica Alfa' }] }), perfil: perfilDe(x) });
  await y.servico.reviewSite(admin(), y.id);
  await y.servico.waitFor(y.id);
  assert.equal(JSON.stringify(perfilDe(y).enriquecimento.resolucao), camposAntes);

  const dnc = montar(t, { motor: motorFake(resultado({})), perfil: perfilLegadoCompleto(), entradas: { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa'), crmRecords: [{ empresa: 'Clínica Alfa', site: 'https://clinica-alfa.example.test', doNotContact: true }] } } });
  assert.equal(dnc.env.itemDaFila('alfa').estado, 'DNC');
  const sd = status(dnc);
  assert.deepEqual([sd.bloqueio, sd.podeCompletar], ['DNC', false]);
  assert.equal((await erroDe(() => dnc.servico.start(admin(), dnc.id))).code, ENRICH_ERROR.NOT_ALLOWED);

  const fonte = fs.readFileSync(path.join(__dirname, '../../src/services/leadEnrichmentService.js'), 'utf8');
  assert.equal(/require\([^)]*crm/i.test(fonte), false, 'o Service não importa o CRM');
  assert.equal(/saveQueue|decideProspect|writeFile|doNotContact\s*=/i.test(fonte), false, 'o Service não grava a Approval Queue nem altera DNC');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 5. MOTOR e MÓDULO DE RESOLUÇÃO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[CONF-17] o prompt do motor pede as CONSULTAS por campo não encontrado; a saída aceita só campos conhecidos, URLs https válidas, sem repetição, até 3 por campo — e continua compacta', () => {
  const prompt = buildPrompt([{ nome: 'Clínica Alfa', cidade: 'Petrópolis', uf: 'RJ', site: SITE, canais: {}, fontes: [SITE], precisa: ['emails', 'atividadeRecente'] }]);
  assert.match(prompt, /consultas: para CADA campo de PROCURAR que você NÃO encontrou/);
  assert.match(prompt, /não é tratado como inexistente|tratado como NÃO VERIFICADO, não como inexistente/);
  assert.match(prompt, /JSON compacto, sem explicações, sem resumo, sem justificativas/);
  const lido = parseEnrichment(JSON.stringify({ leads: [{ nome: 'X', consultas: { emails: ['https://a.com.br/1', 'https://a.com.br/1', 'http://inseguro.com.br/', 'https://b.com.br/2', 'https://c.com.br/3', 'https://d.com.br/4'], campoInventado: ['https://a.com.br/'], atividadeRecente: 'texto', responsavel: [] } }] }), ['X']);
  assert.deepEqual(lido.resultados[0].consultas, { emails: ['https://a.com.br/1', 'https://b.com.br/2', 'https://c.com.br/3'] });
  const semConsultas = parseEnrichment('{"leads":[{"nome":"X","emails":[{"email":"a@b.com","origem":"https://x.com.br/"}]}]}', ['X']);
  assert.equal('consultas' in semConsultas.resultados[0], false);
});

test('[CONF-18] módulo de resolução: isReturned, fieldStates (LEGADO só em registro anterior), legacyOrigin e toolCounts', () => {
  assert.deepEqual([null, undefined, '', '  ', [], {}, { a: null }, { a: { b: [] } }].map(resolution.isReturned), Array(8).fill(false));
  assert.deepEqual([0, 'x', [1], { a: 1 }, false].map(resolution.isReturned), [true, true, true, true, true]);
  assert.deepEqual(resolution.toolCounts(null), { webSearch: 'NAO_MEDIDO', webFetch: 'NAO_MEDIDO' });
  assert.deepEqual(resolution.toolCounts({ webSearchRequests: 0, webFetchRequests: 2 }), { webSearch: 0, webFetch: 2 });
  assert.equal(resolution.legacyOrigin({ status: 'NAO_EXECUTADO' }, 'x'), undefined);
  assert.equal(resolution.legacyOrigin({ status: 'COMPLETO', resolucao: {} }, 'x'), undefined, 'já tem resultado por campo');
  assert.equal(resolution.legacyOrigin({ status: 'COMPLETO' }, 'x').statusAnterior, 'COMPLETO');
  assert.deepEqual(resolution.legacyOrigin({ legado: { origem: 'LEGADO', statusAnterior: 'FALHOU' }, status: 'INCOMPLETO' }, 'x'), { origem: 'LEGADO', statusAnterior: 'FALHOU' }, 'a origem já preservada nunca é reescrita');
  const estados = resolution.fieldStates({ enriquecimento: { status: 'COMPLETO' } }, ['emails']);
  assert.deepEqual([estados.emails.status, estados.emails.origem, estados.siteOficial.status], ['NAO_VERIFICADO', 'LEGADO', 'ENCONTRADO']);
  const novo = resolution.fieldStates({ enriquecimento: { status: 'NAO_EXECUTADO' } }, ['emails']);
  assert.deepEqual([novo.emails.motivo, novo.emails.origem], ['NAO_PESQUISADO', undefined]);
});
