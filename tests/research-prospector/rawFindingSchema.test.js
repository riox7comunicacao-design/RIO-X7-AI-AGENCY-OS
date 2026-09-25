// Esquema validado dos raw findings (src/research-prospector/rawFindingSchema.js).
//
// Um achado bruto é DADO NÃO CONFIÁVEL (web, IA, pessoa). Estes testes provam que o validador só aceita o formato que o discovery
// consome, recusa tudo o mais SEM lançar, devolve uma cópia (nunca o objeto original), nunca repete o valor recusado no erro e
// nunca deixa passar protocolo perigoso, estrutura profunda, excesso de dados nem status/decisão vindos do próprio achado.
// Tudo fictício (example.test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateRawFinding, validateRawFindings, LIMITS, ERROR } = require('../../src/research-prospector/rawFindingSchema');
const { runDiscoveryPipeline, SOURCE_TYPE, EVIDENCE_FIELDS } = require('../../src/research-prospector/discovery');

const NOW = new Date('2026-09-25T15:00:00Z');
const validar = (raw) => validateRawFinding(raw, { now: NOW });
const codigos = (resultado) => resultado.errors.map((erro) => `${erro.path}:${erro.code}`);

const evidencia = (valor, extras = {}) => ({ valor, fonte: 'Site oficial', tipoFonte: SOURCE_TYPE.OFICIAL, ...extras });
function achado(extras = {}) {
  return {
    empresa: 'Clínica Exemplo Teste',
    tipo: 'clínica',
    cidade: 'Petrópolis',
    estado: 'RJ',
    nicho: 'Psicologia',
    campos: {
      site: [evidencia('exemplo.example.test', { url: 'https://exemplo.example.test/contato', dataConsulta: '2026-09-25' })],
      instagram: [evidencia('@exemplo_teste')],
      telefone: [evidencia('(24) 98765-1000')],
      email: [evidencia('contato@exemplo.example.test')],
    },
    fontes: ['https://exemplo.example.test', { fonte: 'Google Maps', url: 'https://maps.example.test/place/1', dataConsulta: '2026-09-25T10:30:00-03:00', campo: 'site', tipoFonte: SOURCE_TYPE.SECUNDARIA }, 'Consulta manual'],
    identidadeAmbigua: false,
    observacoesBrutas: 'Atende adultos.\nSem agendamento online.',
    hipoteseDeOportunidade: 'Sem agendamento online no site',
    dataDaPesquisa: '2026-09-25',
    ...extras,
  };
}

test('[RAW-1] um achado válido passa, vira uma CÓPIA (não o mesmo objeto) e o discovery real o consome com os mesmos estados de confiança', () => {
  const original = achado();
  const resultado = validar(original);
  assert.equal(resultado.ok, true, JSON.stringify(resultado.errors));
  assert.deepEqual(resultado.value, original);
  assert.notEqual(resultado.value, original);
  assert.notEqual(resultado.value.campos.site, original.campos.site);
  original.campos.site[0].valor = 'alterado.example.test';
  assert.equal(resultado.value.campos.site[0].valor, 'exemplo.example.test', 'a cópia não é afetada por mudanças no original');

  const { resultados } = runDiscoveryPipeline({ briefing: { nicho: 'Psicologia' }, rawFindings: [resultado.value], crmRecords: [], dataDaPesquisa: '2026-09-25' });
  assert.equal(resultados[0].statusCampos.site.status, 'VALIDADO', 'fonte oficial isolada: VALIDADO (calculado pelo discovery, não pelo achado)');
  assert.equal(resultados[0].statusCampos.facebook.status, 'NAO_VERIFICADO');
});

test('[RAW-2] só a empresa é obrigatória: um achado mínimo passa, e um campo opcional nulo é tratado como ausente', () => {
  assert.deepEqual(validar({ empresa: '  Só Nome Teste  ' }).value, { empresa: 'Só Nome Teste' });
  assert.deepEqual(validar({ empresa: 'X', tipo: null, campos: null, fontes: null, identidadeAmbigua: null, dataDaPesquisa: null }).value, { empresa: 'X' });
  assert.deepEqual(validar({ empresa: 'X', campos: {}, fontes: [] }).value, { empresa: 'X', campos: {}, fontes: [] });
});

test('[RAW-3] empresa ausente, vazia, só espaços ou de tipo errado: recusada; nada lança, nem com entrada que não é objeto', () => {
  assert.deepEqual(codigos(validar({})), ['empresa:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(validar({ empresa: null })), ['empresa:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(validar({ empresa: '   ' })), ['empresa:TEXTO_VAZIO']);
  for (const tipo of [42, true, [], {}, () => {}]) assert.deepEqual(codigos(validar({ empresa: tipo })), ['empresa:TIPO_INVALIDO']);
  for (const lixo of [null, undefined, 'texto', 42, [], () => {}, new Map(), new Date(), Symbol('x'), 10n]) {
    const resultado = validar(lixo);
    assert.equal(resultado.ok, false);
    assert.equal(resultado.errors[0].code, ERROR.NAO_E_OBJETO);
  }
});

test('[RAW-4] tipos errados nos campos simples: recusados um a um (número não vira texto, texto não vira booleano)', () => {
  const resultado = validar(achado({ tipo: 5, cidade: ['x'], estado: {}, nicho: true, observacoesBrutas: 12, hipoteseDeOportunidade: false, identidadeAmbigua: 'true' }));
  assert.deepEqual(codigos(resultado).sort(), ['cidade:TIPO_INVALIDO', 'estado:TIPO_INVALIDO', 'hipoteseDeOportunidade:TIPO_INVALIDO', 'identidadeAmbigua:TIPO_INVALIDO', 'nicho:TIPO_INVALIDO', 'observacoesBrutas:TIPO_INVALIDO', 'tipo:TIPO_INVALIDO']);
  assert.equal(validar(achado({ identidadeAmbigua: true })).value.identidadeAmbigua, true);
});

test('[RAW-5] campos desconhecidos são recusados — em especial qualquer status ou decisão que o próprio achado traga (o discovery é quem decide, pelas evidências)', () => {
  const intrusos = ['status', 'confianca', 'statusIdentidade', 'statusDados', 'statusDuplicidade', 'statusDNC', 'estadoOperacional', 'doNotContact', 'bloqueadoParaContato', 'statusValidacao', 'prospectId', 'aprovado', 'valido', 'score', 'temperatura', 'ranking', 'caminho', 'arquivo', 'file', 'path', 'url', 'html', 'script', 'userId', 'role', 'permissions'];
  for (const chave of intrusos) {
    const resultado = validar(achado({ [chave]: 'VALIDADO' }));
    assert.equal(resultado.ok, false, chave);
    assert.deepEqual(codigos(resultado), [`${chave}:CAMPO_DESCONHECIDO`]);
  }
  // dentro das evidências e das fontes também
  assert.deepEqual(codigos(validar(achado({ campos: { site: [evidencia('a.example.test', { status: 'VALIDADO' })] } }))), ['campos.site[0].status:CAMPO_DESCONHECIDO']);
  assert.deepEqual(codigos(validar(achado({ campos: { site: [evidencia('a.example.test', { confianca: 'VALIDADO' })] } }))), ['campos.site[0].confianca:CAMPO_DESCONHECIDO']);
  assert.deepEqual(codigos(validar(achado({ fontes: [{ fonte: 'X', arquivo: 'C:/segredo.txt' }] }))), ['fontes[0].arquivo:CAMPO_DESCONHECIDO']);
  // um campo de evidência que o discovery não conhece
  assert.deepEqual(codigos(validar(achado({ campos: { cpf: [evidencia('123')] } }))), ['campos.cpf:CAMPO_DESCONHECIDO']);
  // os campos aceitos são exatamente os do discovery
  for (const campo of EVIDENCE_FIELDS) assert.equal(validar(achado({ campos: { [campo]: [] } })).ok, true, campo);
});

test('[RAW-6] chaves hostis (__proto__, constructor, prototype) nunca contaminam nada e nunca são repetidas no erro', () => {
  const hostil = JSON.parse('{"empresa":"X","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const resultado = validar(hostil);
  assert.equal(resultado.ok, false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(codigos(resultado).sort(), ['__proto__:CAMPO_DESCONHECIDO'.replace('__proto__', '?'), 'constructor:CAMPO_DESCONHECIDO'].sort());
  const nasEvidencias = validar(achado({ campos: JSON.parse('{"__proto__":[{"valor":"x"}],"site":[]}') }));
  assert.equal(nasEvidencias.ok, false);
  assert.equal({}.valor, undefined);
  const paths = JSON.stringify(validar(JSON.parse('{"empresa":"X","chave-com-conteudo-<script>alert(1)</script>":1}')).errors);
  assert.equal(paths.includes('script'), false, 'o erro não repete conteúdo do achado');
});

test('[RAW-7] URLs: só https com domínio público — javascript:, data:, file:, http:, ftp:, //host, blob:, vbscript:, usuário/senha, porta, IP e host local são recusados (em evidência, em fonte e no valor de um campo de link)', () => {
  const perigosas = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/win.ini',
    'http://exemplo.example.test',
    'ftp://exemplo.example.test',
    'blob:https://exemplo.example.test/abc',
    'vbscript:msgbox(1)',
    '//exemplo.example.test/x',
    'https://usuario:senha@exemplo.example.test',
    'https://exemplo.example.test:8443/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://[::1]/x',
    'https://servidor.local/x',
    'https://semponto/x',
    'https://exemplo.example.test/com espaço',
    'https://',
    'https:exemplo',
  ];
  for (const url of perigosas) {
    assert.equal(validar(achado({ campos: { site: [evidencia('exemplo.example.test', { url })] } })).ok, false, `evidência.url ${url}`);
    assert.equal(validar(achado({ fontes: [url] })).ok, false, `fontes[] ${url}`);
    assert.equal(validar(achado({ fontes: [{ url }] })).ok, false, `fontes[].url ${url}`);
    assert.equal(validar(achado({ campos: { site: [evidencia(url)] } })).ok, false, `valor do site ${url}`);
    assert.equal(validar(achado({ campos: { facebook: [evidencia(url)] } })).ok, false, `valor do facebook ${url}`);
  }
  assert.equal(validar(achado({ fontes: ['javascript:alert(1)'] })).errors[0].code, ERROR.PROTOCOLO_PROIBIDO);
  assert.equal(validar(achado({ fontes: ['https://exemplo.example.test:8443/x'] })).errors[0].code, ERROR.URL_INVALIDA);
  assert.equal(validar(achado({ fontes: ['//exemplo.example.test/x'] })).errors[0].code, ERROR.PROTOCOLO_PROIBIDO, 'URL sem protocolo ("//host") é protocolo proibido, não só URL inválida');
  // as boas
  for (const url of ['https://exemplo.example.test', 'https://www.exemplo.example.test/pagina?x=1#topo', 'HTTPS://Exemplo.Example.Test/', 'https://xn--exemplo-9ta.example.test']) {
    assert.equal(validar(achado({ fontes: [url] })).ok, true, url);
  }
});

test('[RAW-8] os formatos por campo: telefone só com dígitos e pontuação de telefone (8 a 15 dígitos), e-mail com forma de e-mail, site/Instagram sem esquema só com caracteres seguros', () => {
  const ruim = (campo, valor) => assert.equal(validar(achado({ campos: { [campo]: [evidencia(valor)] } })).ok, false, `${campo}: ${valor}`);
  const bom = (campo, valor) => assert.equal(validar(achado({ campos: { [campo]: [evidencia(valor)] } })).ok, true, `${campo}: ${valor}`);
  for (const valor of ['abc', '123', '12345678901234567', '24 9876-5432 ramal 12', '<script>', '+55 (24) 98765-1000; DROP', '99999999999999999999']) ruim('telefone', valor);
  for (const valor of ['(24) 98765-1000', '24987651000', '+55 24 98765-1000', '2433221000']) { bom('telefone', valor); bom('whatsapp', valor); }
  for (const valor of ['sem-arroba', 'a@b', 'a b@c.com', '<x>@c.com', "a'b@c.com", `${'a'.repeat(250)}@c.com`]) ruim('email', valor);
  for (const valor of ['contato@exemplo.example.test', 'a.b+c@sub.exemplo.example.test']) bom('email', valor);
  for (const valor of ['tem espaço', 'com<tag>', 'a"b', "a'b", '../../etc/passwd ', 'x'.repeat(301), '-inicio-invalido']) ruim('site', valor);
  for (const valor of ['exemplo.example.test', 'exemplo.example.test/pagina', '@usuario_teste', 'usuario.teste', 'https://instagram.example.test/usuario']) { bom('site', valor); bom('instagram', valor); }
  bom('endereco', 'Rua de Teste, 10 — Petrópolis/RJ');
  ruim('endereco', 'x'.repeat(301));
});

test('[RAW-9] tipo de fonte: só os do domínio (OFICIAL, SECUNDARIA); obrigatório na evidência; outro valor, minúsculo ou de tipo errado é recusado', () => {
  for (const tipoFonte of ['oficial', 'PRIMARIA', 'VALIDADO', '', 5, null, {}]) {
    const resultado = validar(achado({ campos: { site: [{ valor: 'a.example.test', fonte: 'X', tipoFonte }] } }));
    assert.equal(resultado.ok, false, String(tipoFonte));
  }
  assert.deepEqual(codigos(validar(achado({ campos: { site: [{ valor: 'a.example.test', fonte: 'X' }] } }))), ['campos.site[0].tipoFonte:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(validar(achado({ campos: { site: [{ valor: 'a.example.test', tipoFonte: SOURCE_TYPE.OFICIAL }] } }))), ['campos.site[0].fonte:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(validar(achado({ campos: { site: [{ fonte: 'X', tipoFonte: SOURCE_TYPE.OFICIAL }] } }))), ['campos.site[0].valor:CAMPO_OBRIGATORIO']);
  assert.deepEqual(codigos(validar(achado({ fontes: [{ fonte: 'X', tipoFonte: 'qualquer' }] }))), ['fontes[0].tipoFonte:TIPO_FONTE_INVALIDO']);
  assert.deepEqual(codigos(validar(achado({ fontes: [{ fonte: 'X', campo: 'nao_existe' }] }))), ['fontes[0].campo:VALOR_INVALIDO']);
  assert.deepEqual(codigos(validar(achado({ fontes: [{ observacao: 'só observação' }] }))), ['fontes[0]:CAMPO_OBRIGATORIO'], 'uma fonte precisa de nome ou URL');
});

test('[RAW-10] textos acima do limite são recusados (empresa, campos curtos, observações, hipótese, valor, URL, nome da fonte, observação da fonte) — e exatamente no limite passa', () => {
  const limite = (max) => 'a'.repeat(max);
  assert.equal(validar(achado({ empresa: limite(LIMITS.EMPRESA) })).ok, true);
  assert.deepEqual(codigos(validar(achado({ empresa: limite(LIMITS.EMPRESA + 1) }))), ['empresa:TEXTO_LONGO']);
  for (const chave of ['tipo', 'cidade', 'estado', 'nicho']) {
    assert.equal(validar(achado({ [chave]: limite(LIMITS.TEXTO_CURTO) })).ok, true, chave);
    assert.deepEqual(codigos(validar(achado({ [chave]: limite(LIMITS.TEXTO_CURTO + 1) }))), [`${chave}:TEXTO_LONGO`]);
  }
  assert.equal(validar(achado({ observacoesBrutas: limite(LIMITS.OBSERVACOES) })).ok, true);
  assert.deepEqual(codigos(validar(achado({ observacoesBrutas: limite(LIMITS.OBSERVACOES + 1) }))), ['observacoesBrutas:TEXTO_LONGO']);
  assert.deepEqual(codigos(validar(achado({ hipoteseDeOportunidade: limite(LIMITS.HIPOTESE + 1) }))), ['hipoteseDeOportunidade:TEXTO_LONGO']);
  assert.equal(validar(achado({ campos: { endereco: [evidencia(limite(LIMITS.VALOR))] } })).ok, true);
  assert.deepEqual(codigos(validar(achado({ campos: { endereco: [evidencia(limite(LIMITS.VALOR + 1))] } }))), ['campos.endereco[0].valor:TEXTO_LONGO']);
  assert.deepEqual(codigos(validar(achado({ campos: { site: [evidencia('a.example.test', { fonte: limite(LIMITS.FONTE_NOME + 1) })] } }))), ['campos.site[0].fonte:TEXTO_LONGO']);
  assert.deepEqual(codigos(validar(achado({ campos: { site: [evidencia('a.example.test', { observacao: limite(LIMITS.OBSERVACAO_FONTE + 1) })] } }))), ['campos.site[0].observacao:TEXTO_LONGO']);
  assert.deepEqual(codigos(validar(achado({ fontes: ['x'.repeat(LIMITS.FONTE_NOME + 1)] }))), ['fontes[0]:TEXTO_LONGO']);
  const urlGigante = `https://exemplo.example.test/${'a'.repeat(LIMITS.URL)}`;
  assert.deepEqual(codigos(validar(achado({ fontes: [urlGigante] }))), ['fontes[0]:TEXTO_LONGO']);
  assert.equal(validar({ empresa: 'x'.repeat(5_000_000) }).errors[0].code, ERROR.TEXTO_LONGO, 'um texto gigante é recusado pelo tamanho, sem ser processado');
});

test('[RAW-11] caracteres de controle e de direção de texto (spoofing) são recusados; quebra de linha só nas observações', () => {
  for (const ruim of ['Clínica\u0000X', 'Clínica\u0007X', 'Clínica\u202EX', 'Clínica\u200BX', 'Clínica\uFEFFX', 'Clínica\nX', 'Clínica\tX']) {
    assert.equal(validar({ empresa: ruim }).ok, false, JSON.stringify(ruim));
  }
  assert.equal(validar({ empresa: 'X', observacoesBrutas: 'linha 1\nlinha 2\r\nlinha 3\ttab' }).ok, true);
  assert.equal(validar({ empresa: 'X', observacoesBrutas: 'com\u0000nulo' }).ok, false);
  assert.equal(validar({ empresa: 'X', observacoesBrutas: 'com\u202Edireção' }).ok, false);
  assert.equal(validar({ empresa: 'Clínica Ação — Petrópolis ✔' }).ok, true, 'acentos e símbolos comuns passam');
});

test('[RAW-12] excesso de evidências e de fontes: o limite passa, um acima é recusado', () => {
  const evidencias = (n) => Array.from({ length: n }, (_, i) => evidencia(`a${i}.example.test`));
  assert.equal(validar(achado({ campos: { site: evidencias(LIMITS.EVIDENCIAS_POR_CAMPO) } })).ok, true);
  assert.deepEqual(codigos(validar(achado({ campos: { site: evidencias(LIMITS.EVIDENCIAS_POR_CAMPO + 1) } }))), ['campos.site:EVIDENCIAS_EXCESSIVAS']);
  const fontes = (n) => Array.from({ length: n }, (_, i) => `Fonte ${i}`);
  assert.equal(validar(achado({ fontes: fontes(LIMITS.FONTES) })).ok, true);
  assert.deepEqual(codigos(validar(achado({ fontes: fontes(LIMITS.FONTES + 1) }))), ['fontes:FONTES_EXCESSIVAS']);
});

test('[RAW-13] estruturas inesperadas: lista onde deveria haver objeto e vice-versa, evidência que não é objeto, lista com lacunas, propriedade com getter, classe, Symbol — todos recusados sem lançar e sem executar nada', () => {
  assert.deepEqual(codigos(validar(achado({ campos: [] }))), ['campos:NAO_E_OBJETO']);
  assert.deepEqual(codigos(validar(achado({ campos: 'x' }))), ['campos:NAO_E_OBJETO']);
  assert.deepEqual(codigos(validar(achado({ fontes: {} }))), ['fontes:NAO_E_LISTA']);
  assert.deepEqual(codigos(validar(achado({ fontes: 'https://exemplo.example.test' }))), ['fontes:NAO_E_LISTA']);
  assert.deepEqual(codigos(validar(achado({ campos: { site: {} } }))), ['campos.site:NAO_E_LISTA']);
  assert.deepEqual(codigos(validar(achado({ campos: { site: 'exemplo.example.test' } }))), ['campos.site:NAO_E_LISTA']);
  for (const item of ['texto', 5, null, [], () => {}]) assert.equal(validar(achado({ campos: { site: [item] } })).ok, false);
  assert.equal(validar(achado({ fontes: [5] })).ok, false);
  assert.equal(validar(achado({ fontes: [null] })).ok, false);
  assert.equal(validar(achado({ fontes: [[]] })).ok, false);

  const lacunas = [];
  lacunas[2] = 'https://exemplo.example.test';
  assert.equal(validar(achado({ fontes: lacunas })).ok, false, 'lista com lacunas');
  const comExtra = ['https://exemplo.example.test'];
  comExtra.extra = 'x';
  assert.equal(validar(achado({ fontes: comExtra })).ok, false, 'lista com propriedade extra');

  let executou = false;
  const comGetter = { empresa: 'X' };
  Object.defineProperty(comGetter, 'tipo', { enumerable: true, get() { executou = true; return 'x'; } });
  assert.equal(validar(comGetter).ok, false);
  assert.equal(executou, false, 'um getter nunca é executado');
  const oculto = { empresa: 'X' };
  Object.defineProperty(oculto, 'escondido', { value: 1, enumerable: false });
  assert.equal(validar(oculto).ok, false, 'propriedade não enumerável');
  const comSimbolo = { empresa: 'X', [Symbol('s')]: 1 };
  assert.equal(validar(comSimbolo).errors[0].code, ERROR.ESTRUTURA_INVALIDA, 'chave Symbol');
  class Achado { constructor() { this.empresa = 'X'; } }
  assert.equal(validar(new Achado()).errors[0].code, ERROR.NAO_E_OBJETO, 'instância de classe');
  assert.equal(validar(achado({ campos: Object.assign(Object.create({ herdado: [] }), { site: [] }) })).ok, false, 'objeto com protótipo que não é o padrão');
  assert.equal(validar(achado({ campos: { site: [evidencia('a.example.test', { url: new URL('https://exemplo.example.test') })] } })).ok, false, 'um objeto URL não é texto');
});

test('[RAW-14] profundidade e tamanho: um achado profundamente aninhado, circular ou com nós demais é recusado ANTES de qualquer outra coisa, sem estourar a pilha', () => {
  let fundo = { empresa: 'X' };
  fundo.tipo = { a: { b: { c: { d: { e: { f: {} } } } } } };
  assert.equal(validar(fundo).errors[0].code, ERROR.PROFUNDIDADE_EXCESSIVA);

  const circular = { empresa: 'X' };
  circular.campos = circular;
  assert.equal(validar(circular).errors[0].code, ERROR.PROFUNDIDADE_EXCESSIVA);

  let aninhado = 'x';
  for (let i = 0; i < 200000; i += 1) aninhado = [aninhado];
  const resultado = validar({ empresa: 'X', fontes: aninhado });
  assert.equal(resultado.errors[0].code, ERROR.PROFUNDIDADE_EXCESSIVA, 'não estoura a pilha');

  const muitosNos = { empresa: 'X', fontes: Array.from({ length: LIMITS.MAX_NODES + 10 }, () => 'x') };
  assert.equal(validar(muitosNos).errors[0].code, ERROR.TAMANHO_EXCESSIVO);
  const muitasChaves = { empresa: 'X', campos: Object.fromEntries(Array.from({ length: LIMITS.MAX_NODES + 10 }, (_, i) => [`k${i}`, 1])) };
  assert.equal(validar(muitasChaves).errors[0].code, ERROR.TAMANHO_EXCESSIVO);
});

test('[RAW-15] datas: só ISO 8601 real (AAAA-MM-DD ou data e hora com fuso), a partir de 2000 e não futura; formatos brasileiros, datas impossíveis e tipos errados são recusados — na pesquisa e na consulta da fonte', () => {
  const ok = ['2026-09-25', '2026-09-26', '2026-09-25T18:00:00Z', '2026-09-25T10:30:15Z', '2026-09-25T10:30:15.123Z', '2026-09-25T10:30:00-03:00', '2000-01-01', '2024-02-29'];
  for (const data of ok) {
    assert.equal(validar(achado({ dataDaPesquisa: data })).ok, true, data);
  }
  const ruins = ['25/09/2026', '2026/09/25', '2026-9-25', '2026-13-01', '2026-02-30', '2025-02-29', '2026-09-31', '2026-09-25T25:00:00Z', '2026-09-25T10:60:00Z', '2026-09-25T10:30:60Z', '2026-09-25T10:30:00+25:00', '1999-12-31', '2026-09-27', '2027-01-01', '2026-09-25T10:30', '2026-09-26T20:00:00Z', 'ontem', '', '   ', '2026-09-25; DROP', '0000-00-00', '20260925'];
  for (const data of ruins) {
    assert.equal(validar(achado({ dataDaPesquisa: data })).ok, false, JSON.stringify(data));
    assert.equal(validar(achado({ fontes: [{ fonte: 'X', dataConsulta: data }] })).ok, false, `fonte ${JSON.stringify(data)}`);
    assert.equal(validar(achado({ campos: { site: [evidencia('a.example.test', { dataConsulta: data })] } })).ok, false, `evidência ${JSON.stringify(data)}`);
  }
  for (const tipo of [20260925, true, [], {}, new Date('2026-09-25')]) assert.equal(validar(achado({ dataDaPesquisa: tipo })).ok, false);
  assert.equal(validar(achado({ dataDaPesquisa: '2026-09-25' })).ok, true);
  assert.equal(validar(achado({ dataDaPesquisa: '2026-09-27' })).ok, false, 'depois de amanhã');
  assert.equal(validateRawFinding(achado({ dataDaPesquisa: '2026-09-27' }), { now: new Date('2026-09-28T00:00:00Z') }).ok, true, 'o "agora" é injetável');
});

test('[RAW-16] o erro nunca repete o valor recusado, e só descreve caminho (chaves conhecidas e índices), código e frase fixa', () => {
  const segredo = 'SEGREDO-NAO-REPETIR-<img src=x onerror=alert(1)>';
  const resultado = validar(achado({ empresa: segredo + '\u0000', fontes: [`javascript:${segredo}`], campos: { telefone: [evidencia(segredo)] }, [segredo]: 1 }));
  assert.equal(resultado.ok, false);
  const texto = JSON.stringify(resultado.errors);
  assert.equal(texto.includes('SEGREDO'), false);
  assert.equal(texto.includes('onerror'), false);
  for (const erro of resultado.errors) assert.deepEqual(Object.keys(erro).sort(), ['code', 'message', 'path']);
  assert.ok(resultado.errors.length <= LIMITS.MAX_ERRORS);
  const muitos = validar(achado({ fontes: Array.from({ length: LIMITS.FONTES }, () => 5) }));
  assert.equal(muitos.errors.length, LIMITS.MAX_ERRORS, 'a lista de erros também tem limite');
});

test('[RAW-17] o validador não faz nada além de validar: não altera a entrada, não usa rede, não lê arquivo e não interpreta HTML (um valor com HTML/JS fica como TEXTO inerte ou é recusado)', () => {
  const original = achado({ observacoesBrutas: '<script>alert(1)</script><b>x</b>' });
  const copia = JSON.stringify(original);
  const resultado = validar(original);
  assert.equal(JSON.stringify(original), copia, 'a entrada não é alterada');
  assert.equal(resultado.ok, true);
  assert.equal(resultado.value.observacoesBrutas, '<script>alert(1)</script><b>x</b>', 'texto inerte: quem exibe usa textContent');
  const fs = require('node:fs');
  const codigo = fs.readFileSync(require.resolve('../../src/research-prospector/rawFindingSchema.js'), 'utf8');
  for (const proibido of [/require\((['"])(fs|node:fs|http|https|node:http|node:https|net|dns|child_process|path)\1\)/, /\bfetch\(/, /\beval\(/, /new Function/, /XMLHttpRequest/, /process\.env/]) assert.doesNotMatch(codigo, proibido, String(proibido));
});

test('[RAW-18] um lote: cada achado é validado por si só (um ruim não derruba os bons); lote grande demais, ou que não é lista, é recusado inteiro', () => {
  const lote = validateRawFindings([achado(), { empresa: '' }, achado({ empresa: 'Segunda Teste' }), null, 'lixo'], { now: NOW });
  assert.equal(lote.ok, false);
  assert.deepEqual(lote.items.map((item) => item.ok), [true, false, true, false, false]);
  assert.deepEqual(lote.validos.map((valor) => valor.empresa), ['Clínica Exemplo Teste', 'Segunda Teste']);
  assert.deepEqual(lote.items.map((item) => item.index), [0, 1, 2, 3, 4]);
  assert.equal(validateRawFindings([], { now: NOW }).ok, true);
  assert.equal(validateRawFindings([achado()], { now: NOW }).ok, true);

  for (const naoLista of [null, undefined, {}, 'x', 5, new Set()]) assert.equal(validateRawFindings(naoLista).errors[0].code, ERROR.NAO_E_LISTA);
  const demais = Array.from({ length: LIMITS.ACHADOS_POR_LOTE + 1 }, () => ({ empresa: 'X' }));
  assert.equal(validateRawFindings(demais).errors[0].code, ERROR.LOTE_EXCESSIVO);
  assert.equal(validateRawFindings(demais.slice(0, LIMITS.ACHADOS_POR_LOTE), { now: NOW }).ok, true);
  const lacunas = [];
  lacunas[1] = achado();
  assert.equal(validateRawFindings(lacunas, { now: NOW }).items[0].ok, false, 'posição vazia de uma lista esparsa não vira achado válido');
});
