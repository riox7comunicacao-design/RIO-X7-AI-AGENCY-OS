// rawFinding V2 (src/research-prospector/rawFindingV2.js) — o achado V1 + o bloco opcional `dossie` (decisão 0020).
// O achado é validado pelo rawFindingSchema (inalterado); o bloco, pelo buildDossier (o único validador de fatos, fontes, sinais e análises).
// Tudo fictício (example.test), sem rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateRawFindingsV2, validateDossieBlock, LIMITS: V2, ERROR: V2_ERROR } = require('../../src/research-prospector/rawFindingV2');
const { validateRawFindings, LIMITS, ERROR } = require('../../src/research-prospector/rawFindingSchema');
const { MOTIVO } = require('../../src/research-prospector/signalSchema');
const { analyzeSource, toPosix } = require('../helpers/staticImports');

const NOW = new Date('2026-09-25T15:00:00.000Z');
const DATA = '2026-09-24';
const ev = (valor, extras = {}) => ({ valor, fonte: 'Fonte de teste', tipoFonte: 'OFICIAL', url: 'https://fonte.example.test/p', dataConsulta: DATA, ...extras });
const fonte = (extras = {}) => ({ url: 'https://instagram.example.test/clinica', tipo: 'OFICIAL', observadoEm: DATA, ...extras });
const fato = (campo, valor, extras = {}) => ({ campo, valor, status: 'DADO', fonte: fonte(), observadoEm: DATA, ...extras });
const naoVerificado = (campo, extras = {}) => ({ campo, valor: null, status: 'NAO_VERIFICADO', observadoEm: DATA, ...extras });
const achado = (dossie, extras = {}) => ({
  empresa: 'Clínica Teste',
  campos: { site: [ev('https://clinica.example.test')], instagram: [ev('https://instagram.example.test/clinica')] },
  ...(dossie === undefined ? {} : { dossie }),
  ...extras,
});
const validar = (lista) => validateRawFindingsV2(lista, { now: NOW });
const um = (a) => validar([a]);
const codigos = (r) => (r.items[0].errors || []).map((e) => `${e.path}:${e.code}`);
const analise = (extras = {}) => ({ tipo: 'ATIVIDADE_SOCIAL', texto: 'Última postagem observada há 4 dias.', baseadoEm: [{ sinal: 'INSTAGRAM_ATIVIDADE' }], status: 'ANALISE', ...extras });
const postagens = () => fato('instagram.postagensObservadas', ['2026-09-01', '2026-09-10', '2026-09-20']);

test('[V2-1] sem o bloco `dossie` o resultado é IDÊNTICO ao do V1 (compatível): mesmo valor, sem chave nova; null e undefined valem como ausente', () => {
  const v1 = validateRawFindings([achado()], { now: NOW });
  const v2 = validar([achado()]);
  assert.deepEqual(v2, v1);
  assert.equal('dossie' in v2.validos[0], false);
  for (const ausente of [null, undefined]) {
    const r = um(achado(ausente));
    assert.equal(r.ok, true);
    assert.equal('dossie' in r.validos[0], false);
  }
  const vazio = um(achado({}));
  assert.deepEqual(vazio.validos[0].dossie, { fatos: [], analises: [] });
});

test('[V2-2] bloco válido: observações do Instagram + CTA + anúncios + análise baseada num sinal derivado; o valor traz cópias validadas e o resto do achado é o do V1', () => {
  const bloco = { fatos: [postagens(), fato('instagram.cta', 'Agende pelo link da bio'), fato('anuncios.meta', 'NAO_ENCONTRADO_NA_VERIFICACAO', { fonte: fonte({ url: 'https://biblioteca.example.test/meta' }) }), naoVerificado('anuncios.google', { motivo: MOTIVO.BLOQUEADO })], analises: [analise(), analise({ status: 'HIPOTESE', texto: 'Pode haver oportunidade em agendamento (não confirmada).', baseadoEm: [{ fato: 'instagram.cta' }] })] };
  const r = um(achado(bloco));
  assert.equal(r.ok, true, JSON.stringify(r.items[0].errors));
  assert.deepEqual(r.validos[0].dossie, bloco);
  assert.notEqual(r.validos[0].dossie.fatos[0], bloco.fatos[0], 'cópia, não referência');
  bloco.fatos[0].valor.length = 0;
  assert.equal(r.validos[0].dossie.fatos[0].valor.length, 3);
  const semBloco = { ...r.validos[0] };
  delete semBloco.dossie;
  assert.deepEqual(semBloco, validateRawFindings([achado()], { now: NOW }).validos[0]);
});

test('[V2-3] a identidade vem de `campos`: fato de identidade/presença no bloco (`*.url`, `whatsapp.publico`) é recusado — nunca duas fontes de verdade', () => {
  for (const [campo, valor] of [['instagram.url', 'https://instagram.example.test/x'], ['site.url', 'https://outro.example.test'], ['facebook.url', 'https://facebook.example.test/x'], ['linkedin.url', 'https://l.example.test/x'], ['youtube.url', 'https://y.example.test/x'], ['googlePerfil.url', 'https://g.example.test/x'], ['whatsapp.publico', true]]) {
    assert.deepEqual(codigos(um(achado({ fatos: [fato(campo, valor)] }))), ['dossie.fatos[0].campo:CAMPO_DE_IDENTIDADE'], campo);
    assert.deepEqual(codigos(um(achado({ fatos: [naoVerificado(campo)] }))), ['dossie.fatos[0].campo:CAMPO_DE_IDENTIDADE'], `${campo} NAO_VERIFICADO`);
  }
  assert.equal(V2_ERROR.CAMPO_DE_IDENTIDADE, 'CAMPO_DE_IDENTIDADE');
});

test('[V2-4] observação de um canal exige o canal em `campos`; anúncios não exigem canal', () => {
  const semInstagram = { empresa: 'X Teste', campos: { site: [ev('https://x.example.test')] } };
  assert.deepEqual(codigos(um({ ...semInstagram, dossie: { fatos: [fato('instagram.cta', 'Agende')] } })), ['dossie.fatos[0].campo:OBSERVACAO_SEM_CANAL']);
  assert.deepEqual(codigos(um({ ...semInstagram, dossie: { fatos: [postagens()] } })), ['dossie.fatos[0].campo:OBSERVACAO_SEM_CANAL']);
  assert.deepEqual(codigos(um({ ...semInstagram, dossie: { fatos: [fato('instagram.ultimaPostagemEm', '2026-09-20')] } })), ['dossie.fatos[0].campo:OBSERVACAO_SEM_CANAL']);
  const semSite = { empresa: 'X Teste', campos: { instagram: [ev('@x_teste')] } };
  for (const campo of ['site.ctaWhatsapp', 'site.ctaAgendamento', 'site.formularioContato']) assert.deepEqual(codigos(um({ ...semSite, dossie: { fatos: [fato(campo, true)] } })), ['dossie.fatos[0].campo:OBSERVACAO_SEM_CANAL'], campo);
  assert.equal(um({ empresa: 'X Teste', dossie: { fatos: [fato('anuncios.meta', 'IDENTIFICADO'), fato('anuncios.google', 'IDENTIFICADO')] } }).ok, true);
  assert.equal(um({ ...semSite, dossie: { fatos: [fato('instagram.cta', 'Agende')] } }).ok, true);
  assert.deepEqual(codigos(um({ empresa: 'X Teste', campos: { instagram: [] }, dossie: { fatos: [fato('instagram.cta', 'Agende')] } })), ['dossie.fatos[0].campo:OBSERVACAO_SEM_CANAL'], 'canal vazio não conta');
});

test('[V2-5] estrutura do bloco: só { fatos, analises }; objeto simples; listas de dado puro; getter, Symbol, protótipo e chaves perigosas recusados sem executar nada', () => {
  assert.deepEqual(codigos(um(achado({ fatos: [], score: 1 }))), ['dossie.score:CAMPO_DESCONHECIDO']);
  assert.deepEqual(codigos(um(achado({ sinais: [] }))), ['dossie.sinais:CAMPO_DESCONHECIDO']);
  assert.deepEqual(codigos(um(achado({ dossierId: 'dossie:x' }))), ['dossie.dossierId:CAMPO_DESCONHECIDO']);
  assert.deepEqual(codigos(um(achado({ loteId: 'lote:x' }))), ['dossie.loteId:CAMPO_DESCONHECIDO']);
  for (const ruim of ['texto', 5, true, []]) assert.deepEqual(codigos(um(achado(ruim))), ['dossie:NAO_E_OBJETO'], JSON.stringify(ruim));
  assert.deepEqual(codigos(um(achado({ fatos: {} }))), ['dossie.fatos:NAO_E_LISTA']);
  assert.deepEqual(codigos(um(achado({ analises: 'x' }))), ['dossie.analises:NAO_E_LISTA']);
  const lacuna = [];
  lacuna[1] = fato('anuncios.meta', 'IDENTIFICADO');
  assert.deepEqual(codigos(um(achado({ fatos: lacuna }))), ['dossie.fatos:ESTRUTURA_INVALIDA']);
  let executou = false;
  const comGetter = {};
  Object.defineProperty(comGetter, 'fatos', { enumerable: true, get() { executou = true; return []; } });
  assert.deepEqual(codigos(um(achado(comGetter))), ['dossie:ESTRUTURA_INVALIDA']);
  assert.equal(executou, false);
  assert.deepEqual(codigos(um(achado({ [Symbol('s')]: 1 }))), ['dossie:ESTRUTURA_INVALIDA']);
  class Bloco {}
  assert.deepEqual(codigos(um(achado(new Bloco()))), ['dossie:NAO_E_OBJETO']);
  const hostil = JSON.parse('{"fatos":[],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const r = um(achado(hostil));
  assert.equal(r.ok, false);
  assert.equal({}.polluted, undefined);
  let fundo = { x: 1 };
  for (let i = 0; i < 50000; i += 1) fundo = { fatos: [fundo] };
  assert.deepEqual(codigos(um(achado(fundo))), ['dossie:PROFUNDIDADE_EXCESSIVA']);
  // campo desconhecido: é o buildDossier que recusa (nunca vira erro de identidade)
  assert.deepEqual(codigos(um(achado({ fatos: [fato('cpf', '123')] }))), ['dossie.fatos[0].campo:VALOR_INVALIDO']);
  assert.deepEqual(codigos(um(achado({ fatos: [fato('__proto__', '1')] }))), ['dossie.fatos[0].campo:VALOR_INVALIDO']);
});

test('[V2-6] NENHUM truncamento: cada limite aceita o teto e recusa um acima, com código estável e sem devolver o conteúdo', () => {
  assert.deepEqual([V2.FATOS, V2.ANALISES, LIMITS.EVIDENCIAS_POR_CAMPO, LIMITS.ACHADOS_POR_LOTE], [25, 10, 5, 150]);
  const cinco = (campo, valor) => Array.from({ length: 5 }, () => fato(campo, valor));
  const vinteECinco = [...cinco('instagram.cta', 'Agende'), ...cinco('site.ctaWhatsapp', true), ...cinco('site.ctaAgendamento', true), ...cinco('site.formularioContato', true), ...cinco('anuncios.meta', 'IDENTIFICADO')];
  assert.equal(vinteECinco.length, 25);
  assert.equal(um(achado({ fatos: vinteECinco })).ok, true);
  assert.deepEqual(codigos(um(achado({ fatos: [...vinteECinco, fato('anuncios.google', 'IDENTIFICADO')] }))), ['dossie.fatos:FATOS_EXCESSIVOS']);
  assert.deepEqual(codigos(um(achado({ fatos: [...cinco('anuncios.google', 'IDENTIFICADO'), fato('anuncios.google', 'IDENTIFICADO')] }))), ['dossie.fatos[5]:FATOS_DO_CAMPO_EXCESSIVOS']);
  const dezAnalises = Array.from({ length: 10 }, () => analise({ baseadoEm: [{ fato: 'instagram.cta' }] }));
  assert.equal(um(achado({ fatos: [fato('instagram.cta', 'Agende')], analises: dezAnalises })).ok, true);
  assert.deepEqual(codigos(um(achado({ fatos: [fato('instagram.cta', 'Agende')], analises: [...dezAnalises, dezAnalises[0]] }))), ['dossie.analises:ANALISES_EXCESSIVAS']);
  const trinta = Array.from({ length: 30 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
  assert.equal(um(achado({ fatos: [fato('instagram.postagensObservadas', trinta)] })).ok, true);
  assert.deepEqual(codigos(um(achado({ fatos: [fato('instagram.postagensObservadas', [...trinta, '2026-09-01'])] }))), ['dossie.fatos[0].valor:TAMANHO_EXCESSIVO']);
  const evidencias = (n) => Array.from({ length: n }, (_, i) => ev(`https://s${i}.example.test`));
  assert.equal(um({ empresa: 'X Teste', campos: { site: evidencias(5) } }).ok, true);
  assert.deepEqual(codigos(um({ empresa: 'X Teste', campos: { site: evidencias(6) } })), ['campos.site:EVIDENCIAS_EXCESSIVAS']);
  assert.deepEqual(codigos(um(achado({ fatos: [fato('instagram.cta', 'x'.repeat(201))] }))), ['dossie.fatos[0].valor:TEXTO_LONGO']);
  const segredo = 'SEGREDO-NAO-REPETIR';
  const r = um(achado({ fatos: [fato('instagram.cta', segredo.repeat(50))], analises: [analise({ texto: `${segredo} garantia de resultado` })] }));
  assert.equal(JSON.stringify(r.items[0].errors).includes('SEGREDO'), false);
  for (const erro of r.items[0].errors) assert.deepEqual(Object.keys(erro).sort(), ['code', 'message', 'path']);
});

test('[V2-7] lote: até 150 achados (o 151º é recusado por inteiro, LOTE_EXCESSIVO); um achado ruim é reportado com o seu índice; o tudo-ou-nada é de quem chama', () => {
  const lote = (n) => Array.from({ length: n }, (_, i) => ({ empresa: `Empresa ${i}` }));
  assert.equal(validar(lote(150)).ok, true);
  assert.equal(validar(lote(151)).errors[0].code, ERROR.LOTE_EXCESSIVO);
  const misto = validar([achado(), achado({ fatos: [fato('site.url', 'https://x.example.test')] }), achado()]);
  assert.deepEqual(misto.items.map((i) => i.ok), [true, false, true]);
  assert.equal(misto.ok, false);
  assert.equal(misto.validos.length, 2);
  assert.equal(validar('x').errors[0].code, ERROR.NAO_E_LISTA);
  assert.equal(validar([null]).items[0].errors[0].code, ERROR.NAO_E_OBJETO);
  const buraco = [];
  buraco[1] = achado();
  assert.equal(validar(buraco).ok, false);
  // achado inválido no V1: só os erros do V1 (o bloco nem é olhado)
  assert.deepEqual(codigos(um({ empresa: 5, dossie: { fatos: [fato('site.url', 'https://x.example.test')] } })), ['empresa:TIPO_INVALIDO']);
  // o esquema V1 continua valendo: chaves de decisão e de controle continuam recusadas
  for (const chave of ['status', 'estadoOperacional', 'prospectId', 'loteId', 'dossierId', 'score']) assert.deepEqual(codigos(um(achado({}, { [chave]: 'x' }))), [`${chave}:CAMPO_DESCONHECIDO`], chave);
});

test('[V2-8] `motivo`: vocabulário fechado, só em fato NAO_VERIFICADO; DADO com motivo, motivo desconhecido e tipo errado são recusados', () => {
  assert.deepEqual(Object.keys(MOTIVO), ['SITE_FORA_DO_AR', 'PERFIL_PRIVADO', 'BLOQUEADO', 'SEM_RESULTADO', 'PAGINA_REMOVIDA', 'DESATUALIZADA', 'NAO_CONSULTADO']);
  for (const motivo of Object.values(MOTIVO)) {
    const r = um(achado({ fatos: [naoVerificado('instagram.ultimaPostagemEm', { motivo })] }));
    assert.equal(r.ok, true, motivo);
    assert.equal(r.validos[0].dossie.fatos[0].motivo, motivo);
  }
  assert.equal(um(achado({ fatos: [naoVerificado('instagram.cta')] })).ok, true, 'o motivo é opcional');
  assert.deepEqual(codigos(um(achado({ fatos: [fato('instagram.cta', 'Agende', { motivo: MOTIVO.BLOQUEADO })] }))), ['dossie.fatos[0].motivo:MOTIVO_EM_FATO_DADO']);
  assert.deepEqual(codigos(um(achado({ fatos: [naoVerificado('instagram.cta', { motivo: 'PRIVADO' })] }))), ['dossie.fatos[0].motivo:VALOR_INVALIDO']);
  assert.deepEqual(codigos(um(achado({ fatos: [naoVerificado('instagram.cta', { motivo: 5 })] }))), ['dossie.fatos[0].motivo:TIPO_INVALIDO']);
  assert.equal(um(achado({ fatos: [naoVerificado('instagram.cta', { motivo: '__proto__' })] })).ok, false);
  assert.equal(um(achado({ fatos: [naoVerificado('instagram.cta', { motivo: null })] })).ok, true, 'null vale como ausente');
});

test('[V2-9] análises: só ANALISE | HIPOTESE, sempre com `baseadoEm`; ANALISE sem base DADO, DADO como status, referência inexistente e texto de promessa/urgência/"não anuncia" são recusados; pode se apoiar em fatos derivados de `campos`', () => {
  const base = { fatos: [fato('instagram.cta', 'Agende')] };
  const com = (extras) => codigos(um(achado({ ...base, analises: [analise({ baseadoEm: [{ fato: 'instagram.cta' }], ...extras })] })));
  assert.deepEqual(com({}), []);
  assert.deepEqual(com({ status: 'DADO' }), ['dossie.analises[0].status:STATUS_INVALIDO']);
  assert.deepEqual(com({ baseadoEm: [] }), ['dossie.analises[0].baseadoEm:ANALISE_SEM_BASE']);
  assert.deepEqual(com({ baseadoEm: [{ fato: 'anuncios.meta' }] }), ['dossie.analises[0].baseadoEm[0]:REFERENCIA_INVALIDA']);
  for (const texto of ['Resultado garantido.', 'É urgente agir.', 'Não anuncia no Meta.']) assert.deepEqual(com({ texto }), ['dossie.analises[0].texto:TEXTO_PROIBIDO'], texto);
  const soNaoVerificado = um(achado({ fatos: [naoVerificado('instagram.cta', { motivo: MOTIVO.SEM_RESULTADO })], analises: [analise({ baseadoEm: [{ fato: 'instagram.cta' }] })] }));
  assert.deepEqual(codigos(soNaoVerificado), ['dossie.analises[0].status:ANALISE_SEM_EVIDENCIA']);
  assert.equal(um(achado({ fatos: [naoVerificado('instagram.cta')], analises: [analise({ status: 'HIPOTESE', baseadoEm: [{ fato: 'instagram.cta' }] })] })).ok, true);
  // fato derivado de `campos` (a presença do site) serve de base, sem estar no bloco
  assert.equal(um(achado({ analises: [analise({ tipo: 'PRESENCA_DIGITAL', baseadoEm: [{ fato: 'site.url' }, { sinal: 'SITE_EXISTENTE' }] })] })).ok, true);
  assert.equal(um(achado({ analises: [analise({ baseadoEm: [{ fato: 'facebook.url' }] })] })).ok, false, 'canal não informado em campos não existe como base');
});

test('[V2-10] coerência do Instagram e das datas: postagem depois da observação e última postagem incoerente são recusadas (com o caminho do bloco); data futura recusada', () => {
  assert.deepEqual(codigos(um(achado({ fatos: [fato('instagram.ultimaPostagemEm', '2026-09-24', { observadoEm: '2026-09-24' }), fato('instagram.postagensObservadas', ['2026-09-01', '2026-09-20'])] }))), ['dossie.fatos.instagram.ultimaPostagemEm:POSTAGENS_INCONSISTENTES']);
  assert.deepEqual(codigos(um(achado({ fatos: [fato('instagram.ultimaPostagemEm', '2026-09-25', { observadoEm: '2026-09-24' })] }))), ['dossie.fatos.instagram.ultimaPostagemEm:POSTAGEM_APOS_OBSERVACAO']);
  assert.equal(um(achado({ fatos: [fato('instagram.ultimaPostagemEm', '2026-09-20', { observadoEm: '2027-01-01', fonte: fonte({ observadoEm: '2027-01-01' }) })] })).ok, false);
  assert.deepEqual(codigos(um(achado({ fatos: [fato('instagram.cta', 'Agende', { fonte: fonte({ observadoEm: '2026-09-20' }) })] }))), ['dossie.fatos[0].fonte.observadoEm:DATA_DIVERGENTE']);
  assert.deepEqual(codigos(um(achado({ fatos: [fato('instagram.cta', 'Agende', { fonte: fonte({ url: 'http://x.example.test' }) })] }))), ['dossie.fatos[0].fonte.url:PROTOCOLO_PROIBIDO']);
});

test('[V2-11] arquitetura: o rawFindingSchema NÃO importa o dossiê, os sinais nem o V2 (sem dependência circular); o V2 só importa irmãos e é puro', () => {
  const raiz = path.join(__dirname, '..', '..');
  const ler = (nome) => fs.readFileSync(path.join(raiz, 'src', 'research-prospector', nome), 'utf8');
  assert.doesNotMatch(ler('rawFindingSchema.js'), /require\('\.\/(signalSchema|dossier|dossierFromFinding|rawFindingV2)'\)/);
  assert.doesNotMatch(ler('signalSchema.js'), /require\('\.\/(dossier|dossierFromFinding|rawFindingV2)'\)/);
  assert.doesNotMatch(ler('dossier.js'), /require\('\.\/(dossierFromFinding|rawFindingV2)'\)/);
  const arquivo = path.join(raiz, 'src', 'research-prospector', 'rawFindingV2.js');
  const codigo = fs.readFileSync(arquivo, 'utf8');
  const analiseEstatica = analyzeSource(codigo, toPosix(path.relative(raiz, arquivo)));
  assert.deepEqual(analiseEstatica.issues, []);
  assert.deepEqual(analiseEstatica.refs.map((r) => r.specifier).sort(), ['./dossier', './dossierFromFinding', './rawFindingSchema', './signalSchema']);
  assert.doesNotMatch(codigo.replace(/\/\/.*$/gm, ''), /node:|fetch\(|process\.|Date\.now|require\('\.\.\//);
  assert.equal(typeof validateDossieBlock, 'function');
});
