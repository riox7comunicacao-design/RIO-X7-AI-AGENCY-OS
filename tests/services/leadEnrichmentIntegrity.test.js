'use strict';

// Correção de CONFIABILIDADE 3.0.2 (runner, atividade recente e responsável comercial). Peças REAIS: a fila, o autorizador, o perfil comercial e o runner (com `spawn` FALSO: nenhum `claude` real);
// FAKES: o motor de enriquecimento e a leitura de página. Nenhuma rede.
//
//   1. RUNNER: o contrato de resposta do Claude Code instalado — `success` (com `result`) x `error_max_turns` (com `errors`, SEM `result`). O limite só vale por subtype/terminal_reason, nunca por num_turns.
//   2. ATIVIDADE RECENTE: sem canal oficial CONFIRMADO o campo fica BLOQUEADO_POR_PRE_REQUISITO (nada é pedido ao motor) e desbloqueia sozinho quando um canal é confirmado.
//   3. RESPONSÁVEL: nome + cargo (+ cidade) não bastam — a página de terceiro precisa identificar a EMPRESA; sem isso, PENDENTE_DE_CONFIRMACAO (na leitura e nas novas pesquisas), sem apagar nada.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { authorizeReviewerForApprovalQueue } = require('../../src/auth');
const { createLeadEnrichmentService } = require('../../src/services/leadEnrichmentService');
const { createInMemoryLeadProfileRepository } = require('../../src/research-prospector/leadProfileRepository');
const { createClaudeEnrichmentEngine, buildPrompt } = require('../../src/prospecting-adapters/claudeEnrichmentEngine');
const commercial = require('../../src/research-prospector/commercialProfile');
const digital = require('../../src/research-prospector/digitalPresence');
const { novoAmbiente, achado, admin } = require('../helpers/promotionFixtures');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. RUNNER
// ---------------------------------------------------------------------------------------------------------------------------------------------

function spawnFake(resposta, codigo = 0) {
  const chamadas = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.pid = 1;
    child.kill = () => {};
    const chamada = { command, args, options, stdin: '' };
    chamadas.push(chamada);
    child.stdin = { on() {}, end(texto) { chamada.stdin = String(texto); setImmediate(() => { child.stdout.emit('data', Buffer.from(resposta)); child.emit('close', codigo); }); } };
    return child;
  };
  return { spawn, chamadas };
}
const LEAD = { nome: 'Clínica Alfa', cidade: 'Petrópolis', uf: 'RJ', site: null, canais: {}, precisa: ['emails'] };
const json = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const PARCIAL = { leads: [{ nome: 'Clínica Alfa', emails: [{ email: 'a@alfa.com.br', origem: 'https://alfa.com.br/contato' }] }] };
const rodarRunner = async (saida, codigo = 0) => {
  const fake = spawnFake(JSON.stringify(saida), codigo);
  const motor = createClaudeEnrichmentEngine({ spawn: fake.spawn, platform: 'linux' });
  return { resultado: await motor.enrich({ leads: [LEAD] }), fake };
};

test('[INT-RUN-1] `success` com num_turns >= --max-turns NÃO é limite: a resposta válida é preservada, o desfecho (subtype, terminal_reason, tempo de API) é registrado e só há o aviso `proximoDoLimite`', async () => {
  const { resultado, fake } = await rodarRunner({ type: 'result', subtype: 'success', is_error: false, result: json(PARCIAL), num_turns: 10, duration_api_ms: 55000, total_cost_usd: 0.15, terminal_reason: 'completed', modelUsage: { m: { webSearchRequests: 1 } } });
  assert.equal(fake.chamadas[0].args[fake.chamadas[0].args.indexOf('--max-turns') + 1], '8', 'o limite do pedido NÃO foi alterado (6 + 2 por lead)');
  assert.equal(resultado.ok, true);
  assert.equal('limiteDeTurnos' in resultado, false, 'término normal nunca é limite');
  assert.deepEqual([resultado.proximoDoLimite, resultado.subtype, resultado.terminalReason, resultado.tempoApiMs, resultado.turnos, resultado.custoUsd, resultado.webSearchRequests], [true, 'success', 'completed', 55000, 10, 0.15, 1]);
  assert.deepEqual(resultado.resultados.map((r) => r.nome), ['Clínica Alfa']);
  assert.equal(resultado.resultados[0].emails.length, 1);
});

test('[INT-RUN-2] `error_max_turns` (is_error, `errors`, SEM `result`) é o limite REAL: MAX_TURNS com a telemetria que o motor informou; com código de saída != 0 também', async () => {
  const saida = { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (8)'], num_turns: 9, duration_api_ms: 41000, total_cost_usd: 0.11, terminal_reason: 'max_turns', modelUsage: { m: { webSearchRequests: 2 } } };
  for (const codigo of [0, 1]) {
    const { resultado } = await rodarRunner(saida, codigo);
    assert.deepEqual(resultado, { ok: false, code: 'MAX_TURNS', limiteDeTurnos: true, subtype: 'error_max_turns', terminalReason: 'max_turns', tempoApiMs: 41000, custoUsd: 0.11, turnos: 9, webSearchRequests: 2 }, `código de saída ${codigo}`);
  }
  // só terminal_reason (sem subtype reconhecido) também é limite
  const { resultado } = await rodarRunner({ type: 'result', is_error: true, errors: [], terminal_reason: 'max_turns', num_turns: 3 }, 1);
  assert.deepEqual([resultado.ok, resultado.code, resultado.limiteDeTurnos], [false, 'MAX_TURNS', true]);
});

test('[INT-RUN-3] resposta PARCIAL válida num limite real (uma versão que traga texto): é preservada e validada pelo parse, marcada como limite — o que não passa no parse não vira resultado', async () => {
  const base = { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, total_cost_usd: 0.1, terminal_reason: 'max_turns' };
  const { resultado } = await rodarRunner({ ...base, result: json(PARCIAL) });
  assert.deepEqual([resultado.ok, resultado.limiteDeTurnos, resultado.subtype], [true, true, 'error_max_turns']);
  assert.equal(resultado.resultados[0].emails.length, 1);
  const lixo = await rodarRunner({ ...base, result: 'texto qualquer sem JSON' });
  assert.deepEqual([lixo.resultado.ok, lixo.resultado.code, lixo.resultado.limiteDeTurnos], [false, 'MAX_TURNS', true], 'nada é inventado a partir de um texto inutilizável');
});

test('[INT-RUN-4] resposta INCOMPLETA ou MALFORMADA: saída inválida, is_error de outro tipo e campos ausentes — códigos estáveis, telemetria só do que existe (nada inventado)', async () => {
  // success cujo `result` não é utilizável: OUTPUT_INVALID, mas o custo/turnos que o motor cobrou ficam
  const invalida = await rodarRunner({ type: 'result', subtype: 'success', is_error: false, result: 'sem json', num_turns: 4, total_cost_usd: 0.05, duration_api_ms: 9000 });
  assert.deepEqual(invalida.resultado, { ok: false, code: 'OUTPUT_INVALID', subtype: 'success', tempoApiMs: 9000, custoUsd: 0.05, turnos: 4 });
  // erro de execução (outro subtype): AGENT_ERROR — mesmo com num_turns >= maxTurns NÃO é limite
  const erro = await rodarRunner({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['x'], num_turns: 20, duration_api_ms: 1 });
  assert.deepEqual([erro.resultado.ok, erro.resultado.code, 'limiteDeTurnos' in erro.resultado, erro.resultado.subtype], [false, 'AGENT_ERROR', false, 'error_during_execution']);
  // sem nenhum campo de telemetria: nada aparece (nem zero, nem null inventado)
  const nua = await rodarRunner({ is_error: false, result: json(PARCIAL) });
  assert.equal(nua.resultado.ok, true);
  for (const campo of ['subtype', 'terminalReason', 'tempoApiMs', 'turnos', 'custoUsd', 'webSearchRequests', 'proximoDoLimite', 'limiteDeTurnos']) assert.equal(campo in nua.resultado, false, campo);
  // valores inválidos são ignorados
  const estranha = await rodarRunner({ is_error: false, result: json(PARCIAL), subtype: 'Success!!', terminal_reason: 7, duration_api_ms: -5, num_turns: 'dez' });
  for (const campo of ['subtype', 'terminalReason', 'tempoApiMs', 'turnos']) assert.equal(campo in estranha.resultado, false, campo);
  const naoJson = await rodarRunner('isto não é um objeto');
  assert.deepEqual(naoJson.resultado, { ok: false, code: 'OUTPUT_INVALID' });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// fixtures do serviço
// ---------------------------------------------------------------------------------------------------------------------------------------------

const HOJE = '2026-10-08';
const SITE = 'https://clinicaalfa.com.br/';
const INSTA = 'https://www.instagram.com/clinicaalfa';
const ENCHIMENTO = ' Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
const pagina = (url, texto) => ({ ok: true, urlFinal: url, texto: `${texto}${ENCHIMENTO}`, links: [] });

// a Empresa Exemplo Alfa em miniatura: SEM site oficial, telefone/endereço por fontes de terceiros, Instagram/Facebook só SUGERIDOS (não confirmados), empresa em Petrópolis
function perfilSemCanal(extras = {}) {
  const base = commercial.buildCommercialProfile({ empresa: 'Empresa Exemplo Alfa Centro Estético', siteOficial: { status: 'NAO_ENCONTRADO', url: null }, pages: [], fontesValidacao: [{ url: 'https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa', tipo: 'NOTICIA_OU_TERCEIRO' }], fontesDescoberta: [{ url: 'https://www.instagram.com/empresaexemploalfa/', tipo: 'REDE_SOCIAL' }, { url: 'https://www.facebook.com/EmpresaExemploAlfa/', tipo: 'REDE_SOCIAL' }], today: HOJE });
  const presenca = { ...base.presencaDigital, instagram: { status: 'ENCONTRADO', url: 'https://www.instagram.com/empresaexemploalfa', confirmacao: 'NAO_CONFIRMADO', regra: 'sugerido_pelo_enriquecimento' } };
  return { ...base, presencaDigital: presenca, telefones: [{ numero: '+552422220001', origem: 'https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa', celular: false }], endereco: { status: 'ENCONTRADO', rua: 'Rua Exemplo, 100 - Loja 1', cidade: 'Petrópolis', estado: 'RJ', cep: '12345-678', origem: 'https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa' }, contexto: { cidade: 'Petrópolis', uf: 'RJ', nicho: 'Clínicas de estética' }, enriquecimento: { status: 'NAO_EXECUTADO', camposPendentes: [], limiteDeTurnos: false, motivo: 'SOB_DEMANDA' }, ...extras };
}
const motorFake = (resposta) => {
  const chamadas = [];
  return { chamadas, enrich: async (pedido) => { chamadas.push(pedido); return typeof resposta === 'function' ? resposta(pedido, chamadas.length) : resposta; } };
};
const NOME = 'Empresa Exemplo Alfa Centro Estético';
const resultado = (extras, telemetria = {}) => ({ ok: true, ...telemetria, resultados: [{ nome: NOME, ...extras }] });

function montar(t, { motor, paginas = {}, perfil = perfilSemCanal(), entradas, opcoes = {} } = {}) {
  const env = novoAmbiente(t, entradas || { alfa: { finding: achado(NOME, 'empresa-exemplo-alfa') } });
  const perfis = createInMemoryLeadProfileRepository();
  const id = env.ids.alfa;
  if (perfil) perfis.save(id, perfil);
  const lidas = [];
  let relogio = Date.parse(`${HOJE}T12:00:00.000Z`);
  const servico = createLeadEnrichmentService({
    authorizeReviewer: authorizeReviewerForApprovalQueue,
    queuePath: env.queuePath,
    profileRepository: perfis,
    enrichmentEngine: motor,
    createFetchPage: () => async (url) => { lidas.push(url); return paginas[url] || { ok: false, falha: 'FORA_DO_AR', causa: 'DNS' }; },
    now: () => new Date((relogio += 400)),
    ...opcoes,
  });
  return { env, perfis, servico, id, lidas };
}
const rodar = async (x) => {
  await x.servico.start(admin(), x.id);
  await x.servico.waitFor(x.id);
};
const estado = (x) => x.servico.getStatus(admin(), x.id);
const perfilDe = (x) => x.perfis.getById(x.id);
const ultima = (x) => perfilDe(x).enriquecimento.ultimaExecucao;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1b. o serviço diante do desfecho do runner
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[INT-RUN-5] resposta `success` no limite de turnos NÃO perde a verificação complementar: as fontes citadas são lidas e documentam o campo; o registro traz subtype, tempo de API e o encerramento CONCLUIDA', async (t) => {
  const FONTE = 'https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa';
  const x = montar(t, {
    paginas: { [FONTE]: pagina(FONTE, 'Empresa Exemplo Alfa Centro Estético em Petrópolis. Contato, atendimento e e-mail: fale conosco.') },
    motor: motorFake(resultado({ consultas: { emails: [FONTE] } }, { subtype: 'success', terminalReason: 'completed', tempoApiMs: 55000, turnos: 10, proximoDoLimite: true, custoUsd: 0.15, webSearchRequests: 1 })),
  });
  await rodar(x);
  const r = ultima(x);
  assert.deepEqual([r.subtype, r.terminalReason, r.tempoApiMs, r.turnos, r.encerramento, r.proximoDoLimite], ['success', 'completed', 55000, 10, 'CONCLUIDA', true]);
  assert.equal(r.verificacao.leituras, 1, 'a verificação rodou apesar de turnos >= limite');
  assert.equal(perfilDe(x).enriquecimento.limiteDeTurnos, false);
  assert.deepEqual([estado(x).resolucao.emails.status, estado(x).resolucao.emails.tentativas[0].pertinencia], ['NAO_ENCONTRADO_COM_VERIFICACAO', 'PERTINENTE']);
});

test('[INT-RUN-6] limite REAL (error_max_turns): os campos não conferidos ficam LIMITE_DE_TURNOS e nenhuma leitura é feita; telemetria ausente fica null (não inventada); o registro antigo sem subtype é mostrado como "limite não confirmado" sem ser alterado', async (t) => {
  const real = montar(t, { motor: motorFake({ ok: false, code: 'MAX_TURNS', limiteDeTurnos: true, subtype: 'error_max_turns', terminalReason: 'max_turns', tempoApiMs: 41000, turnos: 9 }) });
  await rodar(real);
  assert.deepEqual([ultima(real).subtype, ultima(real).encerramento, ultima(real).tempoApiMs], ['error_max_turns', 'LIMITE_DE_TURNOS', 41000]);
  assert.equal(real.lidas.length, 0);
  assert.equal(estado(real).resolucao.emails.motivo, 'LIMITE_DE_TURNOS');

  const nua = montar(t, { motor: motorFake(resultado({})) });
  await rodar(nua);
  assert.deepEqual([ultima(nua).subtype, ultima(nua).terminalReason, ultima(nua).tempoApiMs], [null, null, null]);
  assert.equal('proximoDoLimite' in ultima(nua), false);

  // o registro real da Empresa Exemplo Alfa (execução 3): LIMITE_DE_TURNOS gravado pela heurística, sem subtype
  const gravado = { iniciadoEm: '2026-10-09T02:05:42.434Z', concluidoEm: '2026-10-09T02:06:43.267Z', duracaoMs: 60829, custoUsd: 0.1525258, turnos: 10, webSearchRequests: 1, camposSolicitados: ['responsavel', 'emails', 'atividadeRecente'], camposObtidos: ['responsavel'], resultado: 'INCOMPLETO', motivo: 'MAX_TURNS', encerramento: 'LIMITE_DE_TURNOS', resultadosPorCampo: {}, fontes: [], fontesNovas: [] };
  const antigo = montar(t, { motor: motorFake(resultado({})), perfil: perfilSemCanal({ enriquecimento: { status: 'INCOMPLETO', motivo: 'MAX_TURNS', limiteDeTurnos: true, camposPendentes: ['emails'], camposNaoEncontrados: [], resolucao: {}, ultimaExecucao: gravado, execucoes: [gravado] } }) });
  const antes = JSON.stringify(perfilDe(antigo));
  assert.equal(estado(antigo).ultimaExecucao.limiteNaoConfirmado, true);
  assert.equal(JSON.stringify(perfilDe(antigo)), antes, 'ler não altera o registro histórico');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. ATIVIDADE RECENTE
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[INT-ATV-1] sem canal oficial CONFIRMADO: atividade recente fica BLOQUEADO_POR_PRE_REQUISITO — não é pedida ao motor, não gasta turno, não é "inexistente" nem "resolvida"; os links sugeridos ficam como estão', async (t) => {
  const x = montar(t, { motor: motorFake(resultado({ atividadeRecente: { canal: 'instagram', url: `${INSTA}/p/1`, data: '2026-10-05' } })) });
  const antes = estado(x);
  assert.deepEqual(antes.camposBloqueados, ['atividadeRecente']);
  assert.equal(antes.camposPendentes.includes('atividadeRecente'), false, 'não é pesquisável agora');
  assert.deepEqual([antes.resolucao.atividadeRecente.status, antes.resolucao.atividadeRecente.motivo, antes.resolucao.atividadeRecente.requer], ['NAO_VERIFICADO', 'BLOQUEADO_POR_PRE_REQUISITO', 'CANAL_OFICIAL_CONFIRMADO']);
  assert.match(antes.bloqueios[0].mensagem, /exige um canal oficial confirmado/);

  await rodar(x);
  const s = estado(x);
  assert.equal(s.resolucao.atividadeRecente.status, 'NAO_VERIFICADO');
  assert.notEqual(s.resolucao.atividadeRecente.status, 'NAO_ENCONTRADO_COM_VERIFICACAO', 'nunca "inexistente"');
  assert.equal(s.camposNaoEncontrados.includes('atividadeRecente'), false);
  assert.equal(s.status, 'INCOMPLETO');
  assert.equal(s.pesquisaCompleta, false, 'bloqueado não é completo');
  assert.equal(perfilDe(x).atividadeRecente.ultimaPostagem, null, 'a resposta do motor sobre atividade foi ignorada');
  assert.equal(perfilDe(x).enriquecimento.ultimaExecucao.resultadosPorCampo.atividadeRecente.bloqueio, 'BLOQUEADO_POR_PRE_REQUISITO');
  // sugestões continuam sugestões: nada foi removido nem promovido a confirmado
  assert.deepEqual([perfilDe(x).presencaDigital.instagram.url, perfilDe(x).presencaDigital.instagram.confirmacao], ['https://www.instagram.com/empresaexemploalfa', 'NAO_CONFIRMADO']);
});

test('[INT-ATV-2] o motor não é chamado para atividade recente bloqueada: o pedido não a lista, o prompt não a descreve; só bloqueada = "nada a pesquisar agora" sem custo', async (t) => {
  const motor = motorFake(resultado({}));
  const x = montar(t, { motor });
  await rodar(x);
  assert.equal(motor.chamadas[0].leads[0].precisa.includes('atividadeRecente'), false);
  assert.equal(/atividadeRecente/.test(buildPrompt(motor.chamadas[0].leads)), false);

  // tudo o mais resolvido (site oficial, responsável com vínculo, contatos, canais SUGERIDOS, anúncios consultados): sobra só o bloqueio — nada a pesquisar, nenhuma chamada, nenhum custo
  const todos = {};
  for (const canal of ['instagram', 'facebook', 'googleMeuNegocio', 'linkedin', 'youtube', 'tiktok']) todos[canal] = { status: 'ENCONTRADO', url: `https://example.com.br/${canal}`, confirmacao: 'NAO_CONFIRMADO' };
  const quieto = motorFake(resultado({}));
  const resolvido = montar(t, {
    motor: quieto,
    perfil: perfilSemCanal({
      siteOficial: { status: 'ENCONTRADO', url: SITE },
      responsavel: { status: 'ENCONTRADO', nome: 'Ana', cargo: 'Dona', origem: `${SITE}sobre`, confianca: 'ALTA' },
      emails: [{ email: 'c@empresaexemploalfa.com.br', origem: SITE }],
      whatsapps: [{ numero: '+5524988887777', origem: SITE }],
      presencaDigital: { ...perfilSemCanal().presencaDigital, ...todos },
      trafegoPago: { meta: { status: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', origem: { url: 'https://www.facebook.com/ads/library/?q=a' } }, google: { status: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', origem: { url: 'https://adstransparency.google.com/?q=a' } }, tiktok: { status: 'NENHUMA_EVIDENCIA_PUBLICA_ENCONTRADA', origem: { url: 'https://library.tiktok.com/ads?q=a' } } },
    }),
  });
  const mostrado = estado(resolvido);
  assert.deepEqual([mostrado.camposPendentes, mostrado.camposBloqueados, mostrado.podeCompletar, mostrado.pesquisaCompleta], [[], ['atividadeRecente'], false, false]);
  const inicio = await resolvido.servico.start(admin(), resolvido.id);
  assert.match(inicio.mensagem, /Nada a pesquisar agora\. A atividade recente exige um canal oficial confirmado/);
  assert.equal(quieto.chamadas.length, 0, 'nenhuma chamada ao motor');
});

test('[INT-ATV-3] CONFIRMAÇÃO POSTERIOR do canal desbloqueia: a atividade volta a ser pesquisável, entra no pedido e o bloqueio gravado antes deixa de valer', async (t) => {
  const motor = motorFake(resultado({}));
  const x = montar(t, { motor });
  await rodar(x); // 1ª: bloqueada
  assert.equal(estado(x).resolucao.atividadeRecente.motivo, 'BLOQUEADO_POR_PRE_REQUISITO');
  // um humano/processo confirma o Instagram (aqui: o perfil passa a ter o canal CONFIRMADO)
  const p = perfilDe(x);
  x.perfis.save(x.id, { ...p, presencaDigital: { ...p.presencaDigital, instagram: { status: 'ENCONTRADO', url: 'https://www.instagram.com/empresaexemploalfa', confirmacao: 'CONFIRMADO', regra: 'link_no_site_oficial' } } });
  const depois = estado(x);
  assert.deepEqual(depois.camposBloqueados, []);
  assert.equal(depois.camposPendentes.includes('atividadeRecente'), true);
  assert.equal(depois.resolucao.atividadeRecente.motivo, 'NAO_PESQUISADO', 'o bloqueio antigo não vale mais');
  assert.equal(depois.podeCompletar, true);
  await rodar(x);
  assert.equal(motor.chamadas[1].leads[0].precisa.includes('atividadeRecente'), true, 'agora entra no pedido');
  assert.deepEqual(motor.chamadas[1].leads[0].canais, { instagram: 'https://www.instagram.com/empresaexemploalfa' });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. RESPONSÁVEL COMERCIAL
// ---------------------------------------------------------------------------------------------------------------------------------------------

const AGREGADOR = 'https://agregador-exemplo.com.br/empresas/11111111000100';
const claim = { nome: 'Pessoa Teste Alfa', cargo: 'Sócio-Administrador', origem: AGREGADOR };

test('[INT-RESP-1] fonte de OUTRA empresa e HOMÔNIMO: nome + cargo + cidade iguais NÃO bastam — o responsável fica PENDENTE_DE_CONFIRMACAO (nunca confirmado) e a razão fica registrada', async (t) => {
  const outra = montar(t, { paginas: { [AGREGADOR]: pagina(AGREGADOR, 'Clínica Beta Estética Ltda, Petrópolis. Pessoa Teste Alfa, Sócio-Administrador. Telefone (24) 2222-0001.') }, motor: motorFake(resultado({ responsavel: claim })) });
  await rodar(outra);
  const a = perfilDe(outra).responsavel;
  assert.deepEqual([a.status, a.vinculo.demonstrado, a.vinculo.motivo, a.confianca], ['PENDENTE_DE_CONFIRMACAO', false, 'EMPRESA_NAO_CITADA_NA_PAGINA', 'BAIXA'], 'a página é de outra empresa (mesmo trazendo o telefone)');
  assert.equal(estado(outra).resolucao.responsavel.status, 'NAO_VERIFICADO');
  assert.equal(estado(outra).resolucao.responsavel.motivo, 'VINCULO_COM_A_EMPRESA_NAO_COMPROVADO');
  assert.deepEqual(ultima(outra).camposDescartados, [{ campo: 'responsavel', motivo: 'VINCULO_COM_A_EMPRESA_NAO_COMPROVADO' }]);

  // homônimo: a página cita uma empresa com o MESMO nome, na mesma cidade, com o mesmo sócio — mas nenhum identificador que o perfil já tinha por outra fonte
  const homonimo = montar(t, { paginas: { [AGREGADOR]: pagina(AGREGADOR, 'Empresa Exemplo Alfa Centro Estético, Petrópolis - RJ. Pessoa Teste Alfa, Sócio-Administrador. CNPJ 11.111.111/0001-00. Telefone (24) 3333-0000.') }, motor: motorFake(resultado({ responsavel: claim })) });
  await rodar(homonimo);
  assert.deepEqual([perfilDe(homonimo).responsavel.status, perfilDe(homonimo).responsavel.vinculo.motivo], ['PENDENTE_DE_CONFIRMACAO', 'SEM_IDENTIFICADOR_DA_EMPRESA_NA_PAGINA']);
  assert.equal(estado(homonimo).camposPendentes.includes('responsavel'), true, 'segue pesquisável');
});

test('[INT-RESP-2] vínculo COMPROVADO: a empresa citada MAIS um identificador que o perfil já tinha (telefone, CEP, e-mail, domínio, canal) — ou a página do site oficial — vira ENCONTRADO com a prova registrada; um CNPJ da página NUNCA é associado à empresa', async (t) => {
  const porTelefone = montar(t, { paginas: { [AGREGADOR]: pagina(AGREGADOR, 'Empresa Exemplo Alfa Centro Estético. Pessoa Teste Alfa, Sócio-Administrador. CNPJ 11.111.111/0001-00. Tel (24) 2222-0001.') }, motor: motorFake(resultado({ responsavel: claim })) });
  await rodar(porTelefone);
  const r = perfilDe(porTelefone).responsavel;
  assert.deepEqual([r.status, r.vinculo.demonstrado, r.vinculo.regra, r.vinculo.evidencia], ['ENCONTRADO', true, 'IDENTIFICADOR_NA_PAGINA', ['telefone']]);
  assert.equal(estado(porTelefone).resolucao.responsavel.status, 'ENCONTRADO');
  const gravado = JSON.stringify(perfilDe(porTelefone)).split(AGREGADOR).join('<url-da-fonte>'); // a URL da fonte é só a fonte; o que não pode existir é o CNPJ como dado da empresa
  assert.equal(/11\.?111\.?111|identidadeEmpresa|"cnpj"/i.test(gravado), false, 'o CNPJ da página não é gravado nem associado à empresa');

  const porCep = montar(t, { paginas: { [AGREGADOR]: pagina(AGREGADOR, 'Empresa Exemplo Alfa Centro Estético, CEP 12345-678. Pessoa Teste Alfa, Sócio-Administrador.') }, motor: motorFake(resultado({ responsavel: claim })) });
  await rodar(porCep);
  assert.deepEqual(perfilDe(porCep).responsavel.vinculo.evidencia, ['cep']);

  // CNPJ só vale se JÁ estiver associado à empresa por comprovação independente (o código nunca grava isso por conta própria)
  const sem = commercial.assessResponsibleLink({ page: pagina(AGREGADOR, 'Empresa Exemplo Alfa Centro Estético. CNPJ 11.111.111/0001-00.'), url: AGREGADOR, profile: perfilSemCanal({ telefones: [] }), company: NOME });
  assert.deepEqual([sem.demonstrado, sem.motivo], [false, 'SEM_IDENTIFICADOR_DA_EMPRESA_NA_PAGINA']);
  const com = commercial.assessResponsibleLink({ page: pagina(AGREGADOR, 'Empresa Exemplo Alfa Centro Estético. CNPJ 11.111.111/0001-00.'), url: AGREGADOR, profile: perfilSemCanal({ telefones: [], identidadeEmpresa: { cnpj: '11111111000100', comprovacao: 'certidao anexada por um humano' } }), company: NOME });
  assert.deepEqual([com.demonstrado, com.evidencia], [true, ['cnpj_associado']]);

  // a página do SITE OFICIAL confirmado vale por si
  const oficial = montar(t, { perfil: perfilSemCanal({ siteOficial: { status: 'ENCONTRADO', url: SITE } }), paginas: { [`${SITE}equipe`]: pagina(`${SITE}equipe`, 'Equipe. Pessoa Teste Alfa, Sócio-Administrador.') }, motor: motorFake(resultado({ responsavel: { ...claim, origem: `${SITE}equipe` } })) });
  await rodar(oficial);
  assert.deepEqual([perfilDe(oficial).responsavel.status, perfilDe(oficial).responsavel.vinculo.regra], ['ENCONTRADO', 'SITE_OFICIAL']);
});

test('[INT-RESP-3] dado JÁ gravado com comprovação insuficiente (o responsável da Empresa Exemplo Alfa): não é apagado nem regravado, é MOSTRADO como PENDENTE_DE_CONFIRMACAO e volta a ser pesquisável; uma nova fonte com vínculo o substitui e o anterior fica no histórico', async (t) => {
  const gravado = { status: 'ENCONTRADO', nome: 'Pessoa Teste Alfa', cargo: 'Sócio-Administrador', origem: AGREGADOR, confianca: 'MEDIA' };
  const motor = motorFake((pedido, n) => (n === 1 ? resultado({ responsavel: claim }) : resultado({ responsavel: { nome: 'Pessoa Teste Alfa', cargo: 'Sócio-Administrador', origem: 'https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa' } })));
  const x = montar(t, {
    perfil: perfilSemCanal({ responsavel: gravado }),
    paginas: { [AGREGADOR]: pagina(AGREGADOR, 'Empresa Exemplo Alfa Centro Estético. Pessoa Teste Alfa, Sócio-Administrador.'), 'https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa': pagina('https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa', 'Empresa Exemplo Alfa Centro Estético, Rua Exemplo. Responsável: Pessoa Teste Alfa, Sócio-Administrador. Tel (24) 2222-0001.') },
    motor,
  });
  const emDisco = JSON.stringify(perfilDe(x));
  // a leitura
  assert.equal(commercial.responsibleLinkState(perfilDe(x)), 'NAO_DEMONSTRADO');
  const mostrado = commercial.presentProfile(perfilDe(x)).responsavel;
  assert.deepEqual([mostrado.status, mostrado.statusRegistrado, mostrado.nome, mostrado.vinculo.demonstrado], ['PENDENTE_DE_CONFIRMACAO', 'ENCONTRADO', 'Pessoa Teste Alfa', false]);
  const e = estado(x);
  assert.deepEqual([e.resolucao.responsavel.status, e.resolucao.responsavel.motivo], ['NAO_VERIFICADO', 'PENDENTE_DE_CONFIRMACAO']);
  assert.equal(e.camposPendentes.includes('responsavel'), true);
  assert.equal(JSON.stringify(perfilDe(x)), emDisco, 'ler não regrava nada');

  // a 1ª tentativa traz a MESMA fonte sem vínculo: o gravado fica como está (nada é substituído por algo igualmente fraco)
  await rodar(x);
  assert.deepEqual([perfilDe(x).responsavel.status, perfilDe(x).responsavel.origem], ['ENCONTRADO', AGREGADOR]);
  assert.equal(perfilDe(x).responsaveisAnteriores, undefined);
  // a 2ª traz uma fonte que cita a empresa E o telefone do perfil: substitui, e o anterior é preservado
  await rodar(x);
  const novo = perfilDe(x);
  assert.deepEqual([novo.responsavel.status, novo.responsavel.vinculo.demonstrado, novo.responsavel.origem], ['ENCONTRADO', true, 'https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa']);
  assert.deepEqual(novo.responsaveisAnteriores.map((r) => [r.origem, r.nome]), [[AGREGADOR, 'Pessoa Teste Alfa']], 'a evidência histórica não foi apagada');
  assert.equal(commercial.responsibleLinkState(novo), 'DEMONSTRADO');
  assert.equal(commercial.presentProfile(novo).responsavel.status, 'ENCONTRADO');
});

test('[INT-RESP-4] responsável do SITE OFICIAL e responsável com vínculo gravado seguem confirmados na leitura (sem pendência falsa); o prompt exige que a página identifique ESTA empresa', async (t) => {
  const oficial = perfilSemCanal({ siteOficial: { status: 'ENCONTRADO', url: SITE }, responsavel: { status: 'ENCONTRADO', nome: 'Ana', cargo: 'Dona', origem: `${SITE}sobre`, confianca: 'ALTA' } });
  assert.equal(commercial.responsibleLinkState(oficial), 'DEMONSTRADO');
  assert.equal(commercial.presentProfile(oficial), oficial);
  assert.equal(commercial.enrichmentNeeds(oficial).includes('responsavel'), false);
  const comVinculo = perfilSemCanal({ responsavel: { status: 'ENCONTRADO', nome: 'Ana', cargo: 'Dona', origem: AGREGADOR, confianca: 'MEDIA', vinculo: { demonstrado: true, regra: 'IDENTIFICADOR_NA_PAGINA', evidencia: ['telefone'] } } });
  assert.equal(commercial.enrichmentNeeds(comVinculo).includes('responsavel'), false);
  const prompt = buildPrompt([{ nome: NOME, cidade: 'Petrópolis', uf: 'RJ', precisa: ['responsavel'] }]);
  assert.match(prompt, /identifique ESTA empresa/);
  assert.match(prompt, /Nome, cargo e cidade iguais NÃO bastam/);
  assert.ok(t.name !== undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4. EFICIÊNCIA DO PEDIDO
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('[INT-EFI-1] pedido ao motor: redes sociais NÃO confirmadas viram `pistas` (nunca `fontes`), o prompt manda evitar buscas repetidas e não abrir redes/login, e o limite de turnos NÃO foi aumentado', async (t) => {
  const motor = motorFake(resultado({}));
  const x = montar(t, { motor });
  await rodar(x);
  const [lead] = motor.chamadas[0].leads;
  assert.deepEqual(lead.fontes, ['https://diretorio-exemplo.com.br/empresa/empresa-exemplo-alfa'], 'só páginas não sociais em fontes');
  assert.deepEqual(lead.pistas, ['https://www.instagram.com/empresaexemploalfa/', 'https://www.facebook.com/EmpresaExemploAlfa/']);
  const prompt = buildPrompt(motor.chamadas[0].leads);
  assert.match(prompt, /pistas \(perfis NÃO confirmados\): https:\/\/www\.instagram\.com\/empresaexemploalfa\//);
  assert.match(prompt, /EFICIÊNCIA: no máximo 1 busca \(WebSearch\) por campo e 3 páginas abertas/);
  assert.match(prompt, /NUNCA abra Instagram, Facebook, LinkedIn nem páginas de login/);
  assert.match(prompt, /nunca evidência oficial nem fonte de dado/);

  // perfil CONFIRMADO segue em `canais` e não duplica nas pistas
  const confirmado = perfilSemCanal();
  confirmado.presencaDigital.instagram = { status: 'ENCONTRADO', url: 'https://www.instagram.com/empresaexemploalfa', confirmacao: 'CONFIRMADO', regra: 'link_no_site_oficial' };
  const motor2 = motorFake(resultado({}));
  const y = montar(t, { motor: motor2, perfil: confirmado });
  await rodar(y);
  assert.deepEqual(motor2.chamadas[0].leads[0].canais, { instagram: 'https://www.instagram.com/empresaexemploalfa' });
  assert.deepEqual(motor2.chamadas[0].leads[0].pistas, ['https://www.facebook.com/EmpresaExemploAlfa/'], 'o perfil confirmado não é repetido como pista');
});

test('[INT-EFI-2] Approval Queue, DNC e histórico: a pesquisa não altera a fila; lead em DNC continua bloqueado; a ausência de resultado nunca vira pesquisa completa', async (t) => {
  const x = montar(t, { motor: motorFake(resultado({})) });
  const fila = x.env.textoDaFila();
  await rodar(x);
  assert.equal(x.env.textoDaFila(), fila);
  assert.notEqual(estado(x).status, 'COMPLETO');
  assert.equal(estado(x).pesquisaCompleta, false);

  const dnc = montar(t, { motor: motorFake(resultado({})), entradas: { alfa: { finding: achado(NOME, 'empresa-exemplo-alfa'), crmRecords: [{ empresa: NOME, site: 'https://empresa-exemplo-alfa.example.test', doNotContact: true }] } } });
  assert.equal(dnc.env.itemDaFila('alfa').estado, 'DNC');
  assert.deepEqual([estado(dnc).bloqueio, estado(dnc).podeCompletar], ['DNC', false]);
});

test('[INT-RUN-7] a mensagem de um limite NÃO confirmado pelo motor é cautelosa (registro antigo, sem subtype), sem alterar o que está gravado', async (t) => {
  const gravado = { iniciadoEm: '2026-10-09T02:05:42.434Z', concluidoEm: '2026-10-09T02:06:43.267Z', duracaoMs: 60829, turnos: 10, camposSolicitados: ['emails'], resultado: 'INCOMPLETO', motivo: 'MAX_TURNS', encerramento: 'LIMITE_DE_TURNOS', resultadosPorCampo: {}, fontes: [], fontesNovas: [] };
  const x = montar(t, { motor: motorFake(resultado({})), perfil: perfilSemCanal({ enriquecimento: { status: 'INCOMPLETO', motivo: 'MAX_TURNS', mensagem: 'A pesquisa atingiu o limite de turnos do motor antes de terminar. Os campos pendentes podem ser tentados de novo.', limiteDeTurnos: true, camposPendentes: ['emails'], camposNaoEncontrados: [], resolucao: {}, ultimaExecucao: gravado, execucoes: [gravado] } }) });
  const antes = JSON.stringify(perfilDe(x));
  assert.match(estado(x).mensagem, /registrado por contagem, sem confirmação do motor/);
  assert.equal(JSON.stringify(perfilDe(x)), antes);
});
