'use strict';

// Correção de OBSERVABILIDADE 3.0.2: para cada campo pesquisado, as URLs que o motor CITOU, as que o código TENTOU ler, o resultado de cada leitura (OK ou a categoria da falha), a pertinência e o motivo
// de o campo ficar NAO_VERIFICADO — sem conteúdo de página, sem credencial, sem mensagem de erro. Segurança das fontes (Instagram/Facebook/agregadores só valem com evidência textual de vínculo;
// login, bloqueio e telas genéricas nunca comprovam ausência), exceções do leitor, mensagem corrigida e compatibilidade com o histórico. Peças REAIS: fila, autorizador, perfil; FAKES: motor e leitor.

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadEnrichmentService, ENRICH_MESSAGES } = require('../../src/services/leadEnrichmentService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const resolution = require('../../src/research-prospector/enrichmentResolution');
const commercial = require('../../src/research-prospector/commercialProfile');
const digital = require('../../src/research-prospector/digitalPresence');
const { novoAmbiente, achado, admin } = require('../helpers/promotionFixtures');

const HOJE = '2026-10-08';
const SITE = 'https://clinicaalfa.com.br/';
const INSTA = 'https://www.instagram.com/clinicaalfa/';
const FACE = 'https://www.facebook.com/clinicaalfa';
const LINKTREE = 'https://linktr.ee/clinicaalfa';
const DIRETORIO = 'https://www.benditoguia.com.br/empresa/clinica-alfa';
const ENCHIMENTO = ' Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
const pagina = (url, texto) => ({ ok: true, urlFinal: url, texto: `${texto}${ENCHIMENTO}`, links: [] });
const falha = (falhaExterna, causa) => ({ ok: false, falha: falhaExterna, causa });

function perfilAutomatico(extras = {}) {
  const base = commercial.buildCommercialProfile({
    empresa: 'Clínica Alfa',
    siteOficial: { status: 'ENCONTRADO', url: SITE },
    presencaDigital: digital.buildPresence({ officialLinks: ['https://wa.me/5524988887777', 'https://www.instagram.com/clinicaalfa'] }),
    pages: [{ origem: SITE, oficial: true, texto: 'Clínica Alfa\nRua das Flores, 10 - Centro, Petrópolis - RJ, CEP 25600-000\nProprietária: Ana Souza Lima\nTel (24) 2222-3333', links: [{ href: 'https://wa.me/5524988887777' }] }],
    fontesDescoberta: [{ url: INSTA, tipo: 'REDE_SOCIAL' }, { url: FACE, tipo: 'REDE_SOCIAL' }, { url: DIRETORIO, tipo: 'NOTICIA_OU_TERCEIRO' }],
    fontesValidacao: [{ url: SITE, tipo: 'OFICIAL' }],
    today: HOJE,
  });
  return { ...base, contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' }, enriquecimento: { status: 'NAO_EXECUTADO', camposPendentes: commercial.enrichmentNeeds(base), limiteDeTurnos: false, motivo: 'SOB_DEMANDA' }, jobId: 'JOB-20261008-001', ...extras };
}

const motorFake = (resposta) => {
  const chamadas = [];
  return { chamadas, enrich: async (pedido) => { chamadas.push(pedido); return resposta; } };
};
const resultado = (extras) => ({ ok: true, resultados: [{ nome: 'Clínica Alfa', ...extras }] });

// o leitor FAKE: devolve a página, a falha estruturada do leitor público ou LANÇA (`{ lanca }`)
function montar(t, { motor, paginas = {}, perfil = perfilAutomatico(), opcoes = {} } = {}) {
  const env = novoAmbiente(t, { alfa: { finding: achado('Clínica Alfa', 'clinica-alfa') } });
  const perfis = createInMemoryLeadProfileRepository();
  const id = env.ids.alfa;
  if (perfil) perfis.save(id, perfil);
  let relogio = Date.parse(`${HOJE}T12:00:00.000Z`);
  const servico = createLeadEnrichmentService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    profileRepository: perfis,
    enrichmentEngine: motor,
    createFetchPage: () => async (url) => {
      const p = paginas[url];
      if (p && p.lanca) throw new Error(p.lanca);
      return p || falha('FORA_DO_AR', 'DNS');
    },
    now: () => new Date((relogio += 400)),
    ...opcoes,
  });
  return { env, perfis, servico, id };
}
const rodar = async (x) => {
  await x.servico.start(admin(), x.id);
  await x.servico.waitFor(x.id);
};
const estado = (x) => x.servico.getStatus(admin(), x.id);
const ultima = (x) => x.perfis.getById(x.id).enriquecimento.ultimaExecucao;

test('[OBS-1] URL citada e lida com sucesso: o campo registra a citação, a tentativa (leitura OK + pertinência) e a fonte que sustentou a ausência — sem o conteúdo da página', async (t) => {
  const x = montar(t, {
    paginas: { [DIRETORIO]: pagina(DIRETORIO, 'Clínica Alfa em Petrópolis. Contato, atendimento e e-mail.') },
    motor: motorFake(resultado({ consultas: { emails: [DIRETORIO] } })),
  });
  await rodar(x);
  const e = estado(x).resolucao.emails;
  assert.deepEqual([e.status, e.resolvido, e.fontes], ['NAO_ENCONTRADO_COM_VERIFICACAO', true, [DIRETORIO]]);
  assert.deepEqual(e.citadas, [DIRETORIO]);
  assert.deepEqual(e.tentativas, [{ url: DIRETORIO, leitura: 'OK', pertinencia: 'PERTINENTE', testes: { nome: 'PASSOU', marcador: 'PASSOU', conteudo: 'PASSOU', suficiencia: 'SUFICIENTE' } }]);
  const persistido = JSON.stringify(x.perfis.getById(x.id));
  assert.equal(persistido.includes('Lorem ipsum') || persistido.includes('Contato, atendimento'), false, 'o conteúdo da página NÃO é armazenado');
  assert.deepEqual(ultima(x).resultadosPorCampo.emails.tentativas, e.tentativas, 'a mesma evidência fica no registro da execução');
});

test('[OBS-2] FALHAS DE LEITURA com categoria própria: robots.txt, login, HTTP 403, timeout e erro de rede — o campo fica NAO_VERIFICADO e a tentativa diz qual foi a categoria (e a causa técnica, em código fixo)', async (t) => {
  const casos = [
    ['ROBOTS', falha('ROBOTS', 'ROBOTS_BLOQUEIA'), 'ROBOTS_BLOQUEIA'],
    ['LOGIN', falha('LOGIN', 'MURO_DE_LOGIN'), 'MURO_DE_LOGIN'],
    ['HTTP_403', falha('BLOQUEADO', 'HTTP_403'), undefined],
    ['TIMEOUT', falha('TEMPO_ESGOTADO', 'TIMEOUT'), undefined],
    ['FORA_DO_AR', falha('FORA_DO_AR', 'DNS'), 'DNS'],
    ['REMOVIDA', falha('REMOVIDA', 'HTTP_404'), 'HTTP_404'],
    ['CAPTCHA', falha('CAPTCHA', 'DESAFIO'), 'DESAFIO'],
  ];
  for (const [categoria, retorno, causa] of casos) {
    const x = montar(t, { paginas: { [INSTA]: retorno }, motor: motorFake(resultado({ consultas: { atividadeRecente: [INSTA] } })) });
    await rodar(x);
    const a = estado(x).resolucao.atividadeRecente;
    assert.deepEqual([a.status, a.motivo], ['NAO_VERIFICADO', 'FONTES_NAO_CONFIRMADAS'], categoria);
    assert.deepEqual(a.tentativas, [{ url: INSTA, leitura: categoria, ...(causa ? { causa } : {}) }], categoria);
    assert.deepEqual(a.citadas, [INSTA]);
    assert.deepEqual(estado(x).camposNaoEncontrados, [], `${categoria}: falha de leitura nunca documenta ausência`);
  }
});

test('[OBS-3] EXCEÇÃO do leitor: registrada como EXCECAO_NA_LEITURA, sem a mensagem do erro (que pode ter dados sensíveis) nem no perfil nem na resposta; a execução termina normalmente', async (t) => {
  const x = montar(t, { paginas: { [INSTA]: { lanca: 'ECONNRESET token=SEGREDO123 senha=abc' } }, motor: motorFake(resultado({ consultas: { atividadeRecente: [INSTA], emails: [DIRETORIO] } })) });
  await rodar(x);
  const s = estado(x);
  assert.equal(s.status, 'INCOMPLETO', 'a exceção não derruba a pesquisa');
  assert.deepEqual(s.resolucao.atividadeRecente.tentativas, [{ url: INSTA, leitura: 'EXCECAO_NA_LEITURA' }]);
  assert.equal(s.resolucao.atividadeRecente.motivo, 'FONTES_NAO_CONFIRMADAS');
  for (const texto of [JSON.stringify(x.perfis.getById(x.id)), JSON.stringify(s)]) {
    assert.equal(/SEGREDO123|senha=abc|ECONNRESET/.test(texto), false, 'a mensagem do erro não vaza');
  }
  assert.deepEqual(resolution.readOutcome({ ok: false, falha: 'EXCECAO_NA_LEITURA', causa: 'EXCECAO_NA_LEITURA' }), { leitura: 'EXCECAO_NA_LEITURA' });
});

test('[OBS-4] SEGURANÇA DAS FONTES: Instagram, Facebook e agregadores de links não valem só porque a URL consta no perfil — exigem a EMPRESA citada no texto; login, bloqueio e tela genérica nunca comprovam ausência', async (t) => {
  const GENERICA = 'https://www.facebook.com/';
  const x = montar(t, {
    paginas: {
      [INSTA]: pagina(INSTA, 'Instagram. Fotos e vídeos de amigos. Contato e e-mail de suporte do aplicativo.'),
      [FACE]: pagina(FACE, 'Entrar no Facebook. Faça login para continuar. Cadastre-se. Contato e e-mail.'),
      [LINKTREE]: pagina(LINKTREE, 'Meus links. Fale conosco, contato e e-mail.'),
      [GENERICA]: { ok: true, urlFinal: GENERICA, texto: 'Facebook' },
    },
    motor: motorFake(resultado({ consultas: { emails: [INSTA], presencaDigital: [FACE], atividadeRecente: [LINKTREE], endereco: [GENERICA] } })),
  });
  await rodar(x);
  const r = estado(x).resolucao;
  assert.deepEqual([r.emails.motivo, r.emails.tentativas[0].pertinencia], ['FONTE_NAO_PERTINENTE_A_EMPRESA', 'FONTE_NAO_PERTINENTE_A_EMPRESA'], 'URL conhecida do perfil sem a empresa no texto não vale');
  assert.deepEqual([r.presencaDigital.motivo, r.presencaDigital.tentativas[0].pertinencia], ['PAGINA_DE_LOGIN_OU_BLOQUEIO', 'PAGINA_DE_LOGIN_OU_BLOQUEIO'], 'tela de login');
  assert.equal(r.atividadeRecente.motivo, 'FONTE_NAO_PERTINENTE_A_EMPRESA', 'agregador de links sem a empresa no texto');
  assert.deepEqual(r.endereco, { status: 'ENCONTRADO', resolvido: true }, 'endereço já confirmado: nem entra na pesquisa (a fonte citada para ele é ignorada)');
  assert.equal(estado(x).camposNaoEncontrados.length, 0);
  assert.equal(estado(x).status, 'INCOMPLETO');

  // tela genérica quase vazia
  const vazia = montar(t, { paginas: { [INSTA]: { ok: true, urlFinal: INSTA, texto: 'Instagram' } }, motor: motorFake(resultado({ consultas: { emails: [INSTA] } })) });
  await rodar(vazia);
  assert.equal(estado(vazia).resolucao.emails.motivo, 'PAGINA_SEM_CONTEUDO');

  // a mesma rede social COM a empresa citada e o lugar do campo: aí sim é pertinente (o vínculo vem do TEXTO)
  const vinculada = montar(t, { paginas: { [FACE]: pagina(FACE, 'Clínica Alfa — página oficial. Contato, atendimento e e-mail: fale conosco.') }, motor: motorFake(resultado({ consultas: { emails: [FACE] } })) });
  await rodar(vinculada);
  assert.deepEqual([estado(vinculada).resolucao.emails.status, estado(vinculada).resolucao.emails.tentativas[0].pertinencia], ['NAO_ENCONTRADO_COM_VERIFICACAO', 'PERTINENTE']);

  // o mesmo vale direto no avaliador (puro)
  const ctx = { company: 'Clínica Alfa', officialOrigin: 'https://clinicaalfa.com.br', knownUrls: [INSTA] };
  assert.equal(resolution.assessSource('emails', pagina(INSTA, 'Instagram. Contato e e-mail.'), INSTA, ctx).motivo, 'FONTE_NAO_PERTINENTE_A_EMPRESA');
  assert.equal(resolution.assessSource('atividadeRecente', pagina(INSTA, 'Clínica Alfa. Blog e novidades.'), INSTA, ctx).ok, true);
});

test('[OBS-5] AUSÊNCIA DE URLs: sem fonte citada não há tentativa nem leitura — NAO_VERIFICADO/OMITIDO_SEM_CONSULTA; URLs inseguras ou com credencial são descartadas; consultas e tokens saem da URL registrada', async (t) => {
  const sem = montar(t, { motor: motorFake(resultado({})) });
  await rodar(sem);
  const e = estado(sem).resolucao.emails;
  assert.deepEqual([e.status, e.motivo, e.citadas, e.tentativas], ['NAO_VERIFICADO', 'OMITIDO_SEM_CONSULTA', undefined, undefined]);

  const suja = montar(t, { paginas: { [`${DIRETORIO}?utm=1&token=SEGREDO123#x`]: pagina(DIRETORIO, 'Clínica Alfa. Contato e e-mail.') }, motor: motorFake(resultado({ consultas: { emails: [`${DIRETORIO}?utm=1&token=SEGREDO123#x`, 'http://inseguro.com.br/x', 'https://user:senha@dir.com.br/x'] } })) });
  await rodar(suja);
  const s = estado(suja).resolucao.emails;
  assert.deepEqual(s.citadas, [DIRETORIO], 'só https sem credencial, reduzida a origem + caminho');
  assert.equal(JSON.stringify(suja.perfis.getById(suja.id)).includes('SEGREDO123'), false);
  assert.equal(JSON.stringify(suja.perfis.getById(suja.id)).includes('senha'), false);
  assert.equal(resolution.safeSourceUrl('https://a.com.br/x?y=1'), 'https://a.com.br/x');
  assert.equal(resolution.safeSourceUrl('http://a.com.br/x'), null);
});

test('[OBS-6] as tentativas respeitam os limites de leitura: o que o orçamento cortou aparece como NAO_TENTADA/LIMITE_DE_LEITURAS e o que passa de 2 fontes por campo fica só nas citadas', async (t) => {
  const x = montar(t, {
    paginas: { [INSTA]: pagina(INSTA, 'Instagram.'), [FACE]: pagina(FACE, 'Facebook.'), [DIRETORIO]: pagina(DIRETORIO, 'Clínica Alfa. Contato e e-mail.') },
    motor: motorFake(resultado({ consultas: { emails: [INSTA, FACE, DIRETORIO], atividadeRecente: [DIRETORIO] } })),
    opcoes: { maxVerificationReads: 1 },
  });
  await rodar(x);
  const r = estado(x).resolucao;
  assert.deepEqual(r.emails.citadas, [INSTA, FACE, DIRETORIO], 'as três foram citadas');
  assert.deepEqual(r.emails.tentativas.map((a) => [a.url, a.leitura]), [[INSTA, 'OK'], [FACE, 'NAO_TENTADA']], 'só 2 por campo e 1 leitura de orçamento: a segunda não foi tentada');
  assert.equal(r.emails.tentativas[1].causa, 'LIMITE_DE_LEITURAS');
  assert.equal(ultima(x).verificacao.leituras, 1);
});

test('[OBS-7] a mensagem corrompida foi corrigida: nenhuma mensagem do serviço traz "resolucao"; um registro histórico com o texto antigo é EXIBIDO corrigido sem ser reescrito', async (t) => {
  for (const texto of Object.values(ENRICH_MESSAGES)) assert.equal(/resolucao/i.test(texto), false, texto);
  assert.match(ENRICH_MESSAGES.VERIFICACAO_INSUFICIENTE, /verificação de alguns campos: eles continuam NÃO VERIFICADOS/);

  const corrompida = 'A pesquisa terminou sem documentar a verificação de alguns resolucao: eles continuam NÃO VERIFICADOS e podem ser pesquisados de novo.';
  const x = montar(t, { motor: motorFake(resultado({})), perfil: perfilAutomatico({ enriquecimento: { status: 'INCOMPLETO', motivo: 'VERIFICACAO_INSUFICIENTE', mensagem: corrompida, camposPendentes: ['emails'], camposNaoEncontrados: [], limiteDeTurnos: false } }) });
  const antes = JSON.stringify(x.perfis.getById(x.id));
  assert.equal(estado(x).mensagem, ENRICH_MESSAGES.VERIFICACAO_INSUFICIENTE, 'exibida corrigida');
  assert.equal(JSON.stringify(x.perfis.getById(x.id)), antes, 'o registro histórico não foi reescrito');

  await rodar(x);
  assert.equal(x.perfis.getById(x.id).enriquecimento.mensagem.includes('resolucao'), false, 'uma nova execução grava o texto correto');
});

test('[OBS-8] COMPATIBILIDADE e PRESERVAÇÃO: o histórico antigo e o resultado por campo sem as novas evidências continuam legíveis; lixo nas evidências é descartado; dados comerciais, fila e DNC ficam intactos; nada começa sozinho', async (t) => {
  const antigo = { iniciadoEm: '2026-10-09T01:51:41.359Z', concluidoEm: '2026-10-09T01:52:19.882Z', duracaoMs: 38519, custoUsd: 0.0976208, turnos: 6, ferramentas: { webSearch: 0, webFetch: 'NAO_MEDIDO' }, camposSolicitados: ['emails'], camposRetornados: [], camposDescartados: [], camposObtidos: [], camposPendentes: ['emails'], resultadosPorCampo: { emails: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'FONTES_NAO_CONFIRMADAS' } }, resultado: 'INCOMPLETO', motivo: 'VERIFICACAO_INSUFICIENTE', encerramento: 'CONCLUIDA', verificacao: { leituras: 3, limite: 4, encerramento: 'FONTES_ESGOTADAS' }, fontes: [], fontesNovas: [] };
  const motor = motorFake(resultado({ consultas: { emails: [DIRETORIO] } }));
  const x = montar(t, {
    motor,
    paginas: { [DIRETORIO]: pagina(DIRETORIO, 'Clínica Alfa. Contato e e-mail.') },
    perfil: perfilAutomatico({
      enriquecimento: {
        status: 'INCOMPLETO', motivo: 'VERIFICACAO_INSUFICIENTE', camposPendentes: ['emails'], camposNaoEncontrados: [], limiteDeTurnos: false,
        resolucao: { emails: { status: 'NAO_VERIFICADO', resolvido: false, motivo: 'FONTES_NAO_CONFIRMADAS', execucao: antigo.iniciadoEm, tentativas: [{ url: INSTA, leitura: 'ERRO', conteudo: '<html>página bruta</html>' }, { url: 'x', leitura: 'minúsculo' }], citadas: [INSTA, 5], html: '<b>x</b>' } },
        ultimaExecucao: antigo, execucoes: [antigo],
      },
    }),
  });
  const fila = x.env.textoDaFila();
  const comercial = () => JSON.stringify({ ...x.perfis.getById(x.id), enriquecimento: undefined, dataEnriquecimento: undefined }); // a data do enriquecimento é a única marca que uma execução acrescenta
  const dados = comercial();
  const lido = estado(x).resolucao.emails;
  assert.deepEqual(lido.tentativas, [{ url: INSTA, leitura: 'ERRO' }], 'só os campos conhecidos; conteúdo bruto e códigos inválidos são descartados');
  assert.deepEqual(lido.citadas, [INSTA]);
  assert.equal('html' in lido, false);
  assert.equal(motor.chamadas.length, 0, 'ler o estado não pesquisa');

  await rodar(x);
  const info = x.perfis.getById(x.id).enriquecimento;
  assert.deepEqual(info.execucoes[0], antigo, 'a execução histórica não é reescrita');
  assert.equal(info.execucoes.length, 2);
  assert.equal(estado(x).resolucao.emails.status, 'NAO_ENCONTRADO_COM_VERIFICACAO');
  assert.equal(estado(x).status, 'INCOMPLETO', 'os demais campos pedidos seguem sem verificação');
  assert.equal(comercial(), dados, 'responsável, telefones, endereço, site e fontes não mudaram');
  assert.equal(x.env.textoDaFila(), fila, 'Approval Queue intacta');
});
