'use strict';

// Fase 2B-3.2B — a CLASSIFICAÇÃO de identidade das Exclusões Permanentes (src/research-prospector/permanentExclusion.js): a função pura que a
// promoção para o CRM usa para separar CORRESPONDENCIA_CONFIRMADA, AMBIGUA e SEM_CORRESPONDENCIA — e a prova de que o critério que a INGESTÃO
// usa (matchesExclusion) continua EXATAMENTE o de antes. Só dados fictícios; nenhum arquivo, nenhuma rede.

const test = require('node:test');
const assert = require('node:assert/strict');

const { EXCLUSION_MATCH, EXCLUSION_VERDICT, normalizeCompanyName, classifyExclusionMatch, matchesExclusion, hasVerifiableIdentity } = require('../../src/research-prospector/permanentExclusion');
const { normalizeDomain, stripAccents } = require('../../src/research-prospector/normalize');

const { CORRESPONDENCIA_CONFIRMADA, AMBIGUA, SEM_CORRESPONDENCIA } = EXCLUSION_MATCH;

const exclusao = (extra = {}) => {
  const empresa = extra.empresa || 'Clínica Exemplo Alfa';
  return { id: 'x1', ativo: true, empresa, empresaNomeNormalizado: normalizeCompanyName(empresa), cidade: null, estado: null, pais: 'Brasil', dominio: null, motivo: 'motivo fictício', ...extra };
};

// A regra de ingestão ANTES da 2B-3.2B (cópia literal do que estava em permanentExclusion.js no commit 5d6b147): a referência da paridade.
const normalizeLocation = normalizeCompanyName;
function matchesExclusionAntiga(finding, exclusion) {
  const isPlainObject = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  if (!isPlainObject(finding) || !isPlainObject(exclusion) || exclusion.ativo !== true) return false;
  if (exclusion.dominio) {
    const exclusionDomain = normalizeDomain(exclusion.dominio);
    const findingDomain = normalizeDomain(finding.site);
    if (exclusionDomain && findingDomain && exclusionDomain === findingDomain) return true;
  }
  const exclusionName = exclusion.empresaNomeNormalizado || normalizeCompanyName(exclusion.empresa);
  const findingName = normalizeCompanyName(finding.empresa);
  if (!exclusionName || !findingName || exclusionName !== findingName) return false;
  if (exclusion.cidade) {
    const findingCidade = normalizeLocation(finding.cidade);
    if (!findingCidade || findingCidade !== normalizeLocation(exclusion.cidade)) return false;
  }
  if (exclusion.estado) {
    const findingEstado = normalizeLocation(finding.estado);
    if (!findingEstado || findingEstado !== normalizeLocation(exclusion.estado)) return false;
  }
  return true;
}

test('[EXCL-CLS-1] sem geografia na exclusão, o NOME sozinho confirma — com maiúsculas, acento e pontuação diferentes', () => {
  for (const nome of ['Clínica Exemplo Alfa', 'CLINICA EXEMPLO ALFA', 'clínica exemplo alfa!', '  Clínica   Exemplo-Alfa ']) {
    assert.equal(classifyExclusionMatch({ empresa: nome }, exclusao()), CORRESPONDENCIA_CONFIRMADA, nome);
  }
});

test('[EXCL-CLS-2] nome + cidade + estado: confirma só quando TODA a geografia que a exclusão especifica bate', () => {
  const comGeo = exclusao({ cidade: 'Petrópolis', estado: 'RJ' });
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: 'PETROPOLIS', estado: 'rj' }, comGeo), CORRESPONDENCIA_CONFIRMADA);
  const soCidade = exclusao({ cidade: 'Petrópolis' });
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: 'Petrópolis' }, soCidade), CORRESPONDENCIA_CONFIRMADA, 'o estado do candidato não é exigido se a exclusão não o especifica');
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: 'Petrópolis', estado: 'SP' }, soCidade), CORRESPONDENCIA_CONFIRMADA, '...nem comparado');
});

test('[EXCL-CLS-3] DOMÍNIO: critério independente do nome — o site do candidato, em qualquer forma da URL, confirma mesmo com outro nome', () => {
  const porDominio = exclusao({ empresa: 'Nome Antigo Ltda', dominio: 'alfa-exemplo.example.test' });
  for (const site of ['alfa-exemplo.example.test', 'https://www.alfa-exemplo.example.test/contato?x=1', 'HTTP://ALFA-EXEMPLO.EXAMPLE.TEST']) {
    assert.equal(classifyExclusionMatch({ empresa: 'Outro Nome Qualquer', site }, porDominio), CORRESPONDENCIA_CONFIRMADA, site);
  }
  assert.equal(classifyExclusionMatch({ empresa: 'Outro Nome Qualquer', site: 'https://outro.example.test' }, porDominio), SEM_CORRESPONDENCIA);
  assert.equal(classifyExclusionMatch({ empresa: 'Outro Nome Qualquer' }, porDominio), SEM_CORRESPONDENCIA, 'sem site e com outro nome: nada a comparar');
  assert.equal(classifyExclusionMatch({ empresa: 'Outro Nome Qualquer', site: 'subdominio.alfa-exemplo.example.test' }, porDominio), SEM_CORRESPONDENCIA, 'um subdomínio NÃO é o mesmo host (nada fuzzy)');
});

test('[EXCL-CLS-4] nome PARECIDO não é correspondência: nunca fuzzy (sufixo, prefixo, letra trocada, plural)', () => {
  for (const nome of ['Clínica Exemplo Alfa Plus', 'Exemplo Alfa', 'Clínica Exemplo Alfas', 'Clinica Exemplo Alva', 'Alfa']) {
    assert.equal(classifyExclusionMatch({ empresa: nome }, exclusao()), SEM_CORRESPONDENCIA, nome);
  }
});

test('[EXCL-CLS-5] AMBÍGUA: o nome bate, nada da geografia do candidato contradiz a exclusão, mas falta a que ela exige', () => {
  const comGeo = exclusao({ cidade: 'Petrópolis', estado: 'RJ' });
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa' }, comGeo), AMBIGUA, 'sem nenhuma geografia');
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', estado: 'RJ' }, comGeo), AMBIGUA, 'falta a cidade');
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: 'Petrópolis' }, comGeo), AMBIGUA, 'falta o estado');
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: '', estado: null }, comGeo), AMBIGUA, 'vazio e null contam como ausentes');
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: '!!!' }, exclusao({ cidade: 'Petrópolis' })), AMBIGUA, 'um dado que não normaliza para nada não é um dado');
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: 'Petrópolis' }, exclusao({ cidade: '!!!' })), AMBIGUA, 'uma restrição da exclusão que não dá para conferir também não é "diferente"');
});

test('[EXCL-CLS-6] um dado geográfico que CONTRADIZ a exclusão a descarta — mesmo faltando outro (contradição confirmada vence a ambiguidade)', () => {
  const comGeo = exclusao({ cidade: 'Petrópolis', estado: 'RJ' });
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: 'Niterói', estado: 'RJ' }, comGeo), SEM_CORRESPONDENCIA);
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: 'Petrópolis', estado: 'SP' }, comGeo), SEM_CORRESPONDENCIA);
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', cidade: 'Niterói' }, comGeo), SEM_CORRESPONDENCIA, 'cidade diferente e estado ausente: é outra cidade');
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa', estado: 'SP' }, comGeo), SEM_CORRESPONDENCIA, 'estado diferente e cidade ausente: é outro estado');
});

test('[EXCL-CLS-7] exclusão INATIVA, entradas que não são objetos simples e nome ausente: SEM_CORRESPONDENCIA (nunca lança)', () => {
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa' }, exclusao({ ativo: false })), SEM_CORRESPONDENCIA);
  assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa' }, exclusao({ ativo: 'true' })), SEM_CORRESPONDENCIA, 'só o booleano true ativa');
  for (const invalido of [null, undefined, 'texto', 42, [], () => {}]) {
    assert.equal(classifyExclusionMatch(invalido, exclusao()), SEM_CORRESPONDENCIA, String(invalido));
    assert.equal(classifyExclusionMatch({ empresa: 'Clínica Exemplo Alfa' }, invalido), SEM_CORRESPONDENCIA, String(invalido));
  }
  assert.equal(classifyExclusionMatch({ cidade: 'Petrópolis' }, exclusao()), SEM_CORRESPONDENCIA);
  assert.equal(classifyExclusionMatch({ empresa: '!!!' }, exclusao()), SEM_CORRESPONDENCIA);
});

test('[EXCL-CLS-8] só os identificadores SUPORTADOS contam: telefone, WhatsApp, Instagram e e-mail do candidato nunca casam', () => {
  const candidato = { empresa: 'Outra Empresa', telefone: '(24) 90000-0001', whatsapp: '+55 24 90000-0001', instagram: '@clinica_exemplo_alfa', email: 'contato@clinica-exemplo-alfa.example.test' };
  assert.equal(classifyExclusionMatch(candidato, exclusao({ dominio: 'clinica-exemplo-alfa.example.test' })), SEM_CORRESPONDENCIA, 'o domínio do e-mail não é o site');
  assert.equal(classifyExclusionMatch(candidato, exclusao({ empresa: 'Clínica Exemplo Alfa' })), SEM_CORRESPONDENCIA);
});

test('[EXCL-CLS-9] PARIDADE COM A INGESTÃO: matchesExclusion devolve, em ~10 mil combinações, exatamente o que devolvia antes da classificação existir', () => {
  const exclusoes = [];
  for (const empresa of ['Força Digital', 'Alfa']) {
    for (const cidade of [null, 'Petrópolis', '!!!']) {
      for (const estado of [null, 'RJ', 'Rio de Janeiro']) {
        for (const dominio of [null, 'alfa.example.test']) {
          for (const ativo of [true, false, 'sim']) exclusoes.push(exclusao({ empresa, cidade, estado, dominio, ativo }));
        }
      }
    }
  }
  const achados = [];
  for (const empresa of ['FORÇA DIGITAL', 'Força Digital Plus', 'alfa', '!!!', undefined]) {
    for (const cidade of [undefined, '', 'Petrópolis', 'petropolis', 'Niterói', '!!!']) {
      for (const estado of [undefined, 'RJ', 'sp', 'Rio de Janeiro']) {
        for (const site of [undefined, 'https://www.alfa.example.test/x', 'outro.example.test']) achados.push({ empresa, cidade, estado, site });
      }
    }
  }
  let comparados = 0;
  let ambiguos = 0;
  for (const e of exclusoes) {
    for (const a of achados) {
      comparados += 1;
      assert.equal(matchesExclusion(a, e), matchesExclusionAntiga(a, e), JSON.stringify([a, e.empresa, e.cidade, e.estado, e.dominio, e.ativo]));
      if (classifyExclusionMatch(a, e) === AMBIGUA) ambiguos += 1;
    }
  }
  assert.ok(comparados >= 10000, `${comparados} combinações`);
  assert.ok(ambiguos > 0, 'a grade realmente cobre casos ambíguos (que a ingestão nunca bloqueou)');
});

test('[EXCL-CLS-10] a ingestão NÃO bloqueia por ambiguidade (regra preservada) — só a classificação da promoção a enxerga', () => {
  const comGeo = exclusao({ cidade: 'Petrópolis', estado: 'RJ' });
  const achado = { empresa: 'Clínica Exemplo Alfa' };
  assert.equal(classifyExclusionMatch(achado, comGeo), AMBIGUA);
  assert.equal(matchesExclusion(achado, comGeo), false);
});

test('[EXCL-CLS-11] hasVerifiableIdentity: só um NOME que normaliza para um texto utilizável permite verificar; domínio sozinho não basta', () => {
  assert.equal(hasVerifiableIdentity({ empresa: 'Clínica Exemplo Alfa' }), true);
  assert.equal(hasVerifiableIdentity({ empresa: 'A' }), true);
  for (const invalido of [{ empresa: '!!!' }, { empresa: '   ' }, { empresa: '' }, { empresa: 42 }, { site: 'alfa.example.test' }, {}, null, undefined, 'texto', []]) {
    assert.equal(hasVerifiableIdentity(invalido), false, JSON.stringify(invalido));
  }
});

test('[EXCL-CLS-12] os vereditos: os três da classificação mais DADOS_INSUFICIENTES — e a consulta que falha NÃO é um veredito', () => {
  assert.deepEqual(Object.keys(EXCLUSION_MATCH), ['CORRESPONDENCIA_CONFIRMADA', 'AMBIGUA', 'SEM_CORRESPONDENCIA']);
  assert.deepEqual(Object.keys(EXCLUSION_VERDICT), ['CORRESPONDENCIA_CONFIRMADA', 'AMBIGUA', 'SEM_CORRESPONDENCIA', 'DADOS_INSUFICIENTES']);
  assert.equal(Object.isFrozen(EXCLUSION_MATCH) && Object.isFrozen(EXCLUSION_VERDICT), true);
  assert.equal(stripAccents('Força'), 'Forca', 'a normalização é a mesma de sempre (não há segunda implementação)');
});
