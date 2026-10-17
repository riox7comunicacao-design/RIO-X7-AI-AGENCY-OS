// Constantes dos CATÁLOGOS do CRM (src/crm/catalogConstants.js — CRM 5.0, Fase 2B-1): as três definições, os limites, as listas fechadas e a
// PALETA FIXA de 20 cores — com o contraste (WCAG) e a distância entre as cores RECALCULADOS aqui, a partir dos valores hex, sem confiar
// em nenhum número escrito em comentário. E a guarda de COMPATIBILIDADE: os 31 campos do CRM legado seguem exatamente como eram.

const test = require('node:test');
const assert = require('node:assert/strict');

const constants = require('../../src/crm/catalogConstants');
const { CATALOG, CATALOG_KEYS, CATALOG_DEFINITIONS, COMMON_ITEM_FIELDS, LIMITS, BILLING_TYPES, RECURRENCES, PAYMENT_MODALITY_FIELDS, LEAD_CHANNELS, NICHE_COLORS, NICHE_COLOR_KEYS, CATALOG_ERROR } = constants;
const { CRM_WRITABLE_FIELDS, CRM_MANAGED_FIELDS } = require('../../src/crm/constants');

// ---- as contas de cor (WCAG 2.x e CIELAB), independentes do código de produção ----------------------------------------------------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [claro, escuro] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (claro + 0.05) / (escuro + 0.05);
};
const lab = (hex) => {
  const [r, g, b] = rgb(hex).map(linear);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

test('[CATCONST-1] os três catálogos: chaves, prefixos de id, tabelas e o campo legado que cada um vai substituir — tudo congelado', () => {
  assert.deepEqual(CATALOG, { SERVICOS: 'servicos', NICHOS: 'nichos', ORIGENS: 'origens' });
  assert.deepEqual([...CATALOG_KEYS], ['servicos', 'nichos', 'origens']);
  assert.deepEqual(
    Object.fromEntries(CATALOG_KEYS.map((key) => [key, [CATALOG_DEFINITIONS[key].idPrefix, CATALOG_DEFINITIONS[key].table, CATALOG_DEFINITIONS[key].legacyField]])),
    { servicos: ['service', 'crm_services', 'servicoPotencial'], nichos: ['niche', 'crm_niches', 'nicho'], origens: ['origin', 'crm_lead_origins', 'origem'] }
  );
  // Fase C1: as modalidades de pagamento são os campos gravados; tipoCobranca/recorrencia viraram LEGADO (lidos, nunca gravados)
  assert.deepEqual(CATALOG_DEFINITIONS.servicos.specificFields, ['categoria', 'precoReferencia', 'permitePagamentoUnico', 'permitePagamentoRecorrente', 'periodicidades']);
  assert.deepEqual(CATALOG_DEFINITIONS.servicos.legacyFields, ['tipoCobranca', 'recorrencia']);
  assert.deepEqual([...PAYMENT_MODALITY_FIELDS], ['permitePagamentoUnico', 'permitePagamentoRecorrente', 'periodicidades']);
  assert.equal(CATALOG_DEFINITIONS.servicos.specificFields.some((campo) => CATALOG_DEFINITIONS.servicos.legacyFields.includes(campo)), false, 'um campo legado nunca é gravável');
  assert.equal(CATALOG_DEFINITIONS.nichos.legacyFields, undefined);
  assert.equal(CATALOG_DEFINITIONS.origens.legacyFields, undefined);
  assert.deepEqual(CATALOG_DEFINITIONS.nichos.specificFields, ['cor']);
  assert.deepEqual(CATALOG_DEFINITIONS.origens.specificFields, ['canal']);
  for (const objeto of [CATALOG, CATALOG_KEYS, CATALOG_DEFINITIONS, COMMON_ITEM_FIELDS, LIMITS, BILLING_TYPES, RECURRENCES, PAYMENT_MODALITY_FIELDS, LEAD_CHANNELS, NICHE_COLORS, NICHE_COLOR_KEYS, CATALOG_ERROR]) {
    assert.equal(Object.isFrozen(objeto), true);
  }
  assert.equal(Object.isFrozen(CATALOG_DEFINITIONS.servicos.legacyFields), true);
  for (const key of CATALOG_KEYS) {
    assert.equal(Object.isFrozen(CATALOG_DEFINITIONS[key]), true);
    assert.equal(Object.isFrozen(CATALOG_DEFINITIONS[key].specificFields), true);
  }
  assert.equal(new Set(CATALOG_KEYS.map((key) => CATALOG_DEFINITIONS[key].idPrefix)).size, 3, 'prefixos de id distintos');
});

test('[CATCONST-2] COMPATIBILIDADE COM O CRM LEGADO (decisão D3): os 31 campos do registro seguem EXATAMENTE como eram, e os campos legados dos catálogos continuam TEXTO LIVRE entre eles', () => {
  assert.deepEqual(
    [...CRM_WRITABLE_FIELDS],
    [
      'empresa', 'contato', 'cargo', 'telefone', 'whatsapp', 'email', 'site', 'instagram', 'facebook', 'googlePerfil', 'cidade', 'estado', 'nicho', 'origem', 'temperatura',
      'servicoPotencial', 'problemaIdentificado', 'raioXDeNicho', 'raioXPersonalizado', 'statusDoDiagnostico', 'linkDoRaioX', 'dataDaAnalise', 'dataDaReuniao', 'linkDoMeet',
      'proximaAcao', 'dataDaProximaAcao', 'responsavel', 'ultimaInteracao', 'valorProposta', 'valorTotal', 'observacoes',
    ]
  );
  assert.equal(CRM_WRITABLE_FIELDS.length, 31);
  assert.deepEqual([...CRM_MANAGED_FIELDS], ['id', 'status', 'dataDeEntrada', 'historico']);
  for (const key of CATALOG_KEYS) assert.ok(CRM_WRITABLE_FIELDS.includes(CATALOG_DEFINITIONS[key].legacyField), `${key}: o campo legado existe no registro`);
  // nenhum campo novo de catálogo entrou no registro (nada de nicheId, serviceId, originId)
  for (const campo of CRM_WRITABLE_FIELDS) assert.doesNotMatch(campo, /Id$/);
});

test('[CATCONST-3] limites e listas fechadas: nome 80, descrição 500, categoria 60; cobrança, recorrência e canais; os códigos de erro têm um prefixo próprio', () => {
  assert.deepEqual({ ...LIMITS }, { NOME: 80, DESCRICAO: 500, CATEGORIA: 60, PRECO_REFERENCIA_MAXIMO: 1_000_000_000 });
  assert.deepEqual([...BILLING_TYPES], ['UNICA', 'RECORRENTE']);
  assert.deepEqual([...RECURRENCES], ['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL']);
  assert.deepEqual([...LEAD_CHANNELS], ['PROSPECCAO_ATIVA', 'ANUNCIO_PAGO', 'INDICACAO', 'ORGANICO', 'PARCERIA', 'OUTRO']);
  for (const lista of [BILLING_TYPES, RECURRENCES, LEAD_CHANNELS]) {
    assert.equal(new Set(lista).size, lista.length);
    for (const valor of lista) assert.match(valor, /^[A-Z_]+$/);
  }
  assert.deepEqual(Object.values(CATALOG_ERROR).sort(), ['CRM_CATALOG_DUPLICATE_NAME', 'CRM_CATALOG_INVALID_INPUT', 'CRM_CATALOG_NAME_IN_USE', 'CRM_CATALOG_NOT_FOUND', 'CRM_CATALOG_PERSISTENCE']);
});

test('[CATCONST-4] PALETA: exatamente 20 cores, chaves únicas e estáveis, nomes em português únicos, tons em hex, tudo congelado', () => {
  assert.equal(NICHE_COLORS.length, 20);
  assert.deepEqual(
    [...NICHE_COLOR_KEYS],
    ['vermelho', 'laranja', 'ambar', 'amarelo', 'lima', 'verde', 'esmeralda', 'turquesa', 'ciano', 'celeste', 'azul', 'indigo', 'violeta', 'roxo', 'orquidea', 'magenta', 'rosa', 'carmim', 'marrom', 'ardosia']
  );
  assert.equal(new Set(NICHE_COLOR_KEYS).size, 20);
  assert.equal(new Set(NICHE_COLORS.map((cor) => cor.nome)).size, 20, 'nomes de exibição únicos');
  for (const cor of NICHE_COLORS) {
    assert.deepEqual(Object.keys(cor), ['chave', 'nome', 'fundo', 'texto', 'ponto']);
    assert.match(cor.chave, /^[a-z]+$/, 'chave: só letras minúsculas sem acento (vira nome de classe e valor do banco)');
    assert.ok(cor.nome.trim().length >= 3, `${cor.chave}: identificação textual`);
    for (const tom of ['fundo', 'texto', 'ponto']) assert.match(cor[tom], /^#[0-9a-f]{6}$/, `${cor.chave}.${tom}`);
    assert.equal(Object.isFrozen(cor), true);
  }
  // as chaves não colidem com nada que o CSS já use como nome de classe (.cor-<chave> é exclusivo da paleta)
  assert.equal(new Set(NICHE_COLORS.map((cor) => `${cor.fundo}/${cor.texto}/${cor.ponto}`)).size, 20, 'nenhum conjunto de tons repetido');
});

test('[CATCONST-5] CONTRASTE (WCAG) recalculado: texto sobre o fundo >= 7:1 (AAA); o ponto >= 3:1 sobre o fundo do chip E sobre o branco (WCAG 1.4.11)', () => {
  for (const cor of NICHE_COLORS) {
    assert.ok(contrast(cor.texto, cor.fundo) >= 7, `${cor.chave}: texto×fundo ${contrast(cor.texto, cor.fundo).toFixed(2)}`);
    assert.ok(contrast(cor.ponto, cor.fundo) >= 3, `${cor.chave}: ponto×fundo ${contrast(cor.ponto, cor.fundo).toFixed(2)}`);
    assert.ok(contrast(cor.ponto, '#ffffff') >= 3, `${cor.chave}: ponto×branco ${contrast(cor.ponto, '#ffffff').toFixed(2)}`);
    assert.ok(contrast(cor.fundo, '#ffffff') <= 1.3, `${cor.chave}: o fundo é uma tinta CLARA (quase branca: ${contrast(cor.fundo, '#ffffff').toFixed(2)}:1 contra o branco)`);
  }
  assert.ok(Math.min(...NICHE_COLORS.map((cor) => contrast(cor.texto, cor.fundo))) >= 7.0);
});

test('[CATCONST-6] DISTINÇÃO: os pontos de quaisquer duas cores ficam a ΔE (CIELAB) >= 25 — nenhum par parece a mesma cor; e ainda assim o nome vem sempre em texto', () => {
  let menor = Infinity;
  let par = '';
  for (let i = 0; i < NICHE_COLORS.length; i++) {
    for (let j = i + 1; j < NICHE_COLORS.length; j++) {
      const distancia = deltaE(NICHE_COLORS[i].ponto, NICHE_COLORS[j].ponto);
      if (distancia < menor) {
        menor = distancia;
        par = `${NICHE_COLORS[i].chave}~${NICHE_COLORS[j].chave}`;
      }
    }
  }
  assert.ok(menor >= 25, `par mais parecido: ${par} (ΔE ${menor.toFixed(1)})`);
  // os fundos também se distinguem entre si pelo menos um pouco (tintas claras são naturalmente próximas)
  let menorFundo = Infinity;
  for (let i = 0; i < NICHE_COLORS.length; i++) for (let j = i + 1; j < NICHE_COLORS.length; j++) menorFundo = Math.min(menorFundo, deltaE(NICHE_COLORS[i].fundo, NICHE_COLORS[j].fundo));
  assert.ok(menorFundo > 0.5, 'nenhum par de fundos idêntico');
});
