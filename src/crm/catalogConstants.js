// Constantes dos CATÁLOGOS do CRM — Serviços, Nichos e Origens dos Leads (CRM 5.0, Fase 2B-1, decisão 0026 —
// docs/decisions/0026-crm-catalogs.md).
//
// Um catálogo é uma LISTA CONTROLADA, administrada por quem tem MANAGE:CRM_CATALOGS (só ADMIN) e consultada por quem tem
// READ:CRM. Cada item tem um IDENTIFICADOR ESTÁVEL (`service:<uuid>`, `niche:<uuid>`, `origin:<uuid>`), independente do nome: o
// nome pode (no futuro) mudar sem que as referências por id se percam. Esta fase NÃO liga os catálogos ao CRM: os campos
// `nicho`, `origem` e `servicoPotencial` do registro continuam texto livre (estrutura legada, os 31 campos de CRM_WRITABLE_FIELDS
// intocados) — a ligação por identificador é de uma fase posterior (Clientes e Negociações).
//
// "ORIGEM DO LEAD" NÃO É A "ORIGEM" DA PROSPECÇÃO: na pesquisa, `origem` quase sempre é a URL pública de onde um dado foi visto (a
// fonte). A origem COMERCIAL do lead (por onde ele chegou: indicação, anúncio, prospecção ativa...) é outra coisa, e por isso o
// código chama o catálogo de `leadOrigin`/`crm_lead_origins`.
//
// SÓ constantes e dados puros: nada aqui toca disco, rede, autorização ou DOM.

// As chaves PÚBLICAS dos três catálogos — o segmento da URL (/api/crm-catalogs/<chave>) e o nome do grupo no JSON.
const CATALOG = Object.freeze({
  SERVICOS: 'servicos',
  NICHOS: 'nichos',
  ORIGENS: 'origens',
});
const CATALOG_KEYS = Object.freeze([CATALOG.SERVICOS, CATALOG.NICHOS, CATALOG.ORIGENS]);

// Os campos que TODO item de catálogo tem, na ordem em que são projetados.
const COMMON_ITEM_FIELDS = Object.freeze([
  'id',
  'nome',
  'nomeNormalizado',
  'descricao',
  'ativo',
  'ordem',
  'criadoEm',
  'atualizadoEm',
  'criadoPorUserId',
  'criadoPorNome',
  'atualizadoPorUserId',
  'atualizadoPorNome',
]);

// O que muda de um catálogo para outro. `table` é o nome REAL da tabela (migration 20261012090000_crm_catalogs.sql); `legacyField`
// é o campo de TEXTO livre do registro do CRM que este catálogo vai, no futuro, substituir (hoje só serve para contar o uso).
// `specificFields` são os campos GRAVÁVEIS próprios do catálogo (além de `nome` e `descricao`). `legacyFields` (só serviços) são colunas LEGADAS que
// continuam sendo LIDAS e devolvidas, mas NUNCA mais gravadas (Fase C1): ver o comentário de PAYMENT_MODALITY_FIELDS.
const CATALOG_DEFINITIONS = Object.freeze({
  [CATALOG.SERVICOS]: Object.freeze({
    key: CATALOG.SERVICOS,
    idPrefix: 'service',
    table: 'crm_services',
    legacyField: 'servicoPotencial',
    specificFields: Object.freeze(['categoria', 'precoReferencia', 'permitePagamentoUnico', 'permitePagamentoRecorrente', 'periodicidades']),
    legacyFields: Object.freeze(['tipoCobranca', 'recorrencia']),
  }),
  [CATALOG.NICHOS]: Object.freeze({
    key: CATALOG.NICHOS,
    idPrefix: 'niche',
    table: 'crm_niches',
    legacyField: 'nicho',
    specificFields: Object.freeze(['cor']),
  }),
  [CATALOG.ORIGENS]: Object.freeze({
    key: CATALOG.ORIGENS,
    idPrefix: 'origin',
    table: 'crm_lead_origins',
    legacyField: 'origem',
    specificFields: Object.freeze(['canal']),
  }),
});

// Limites de tamanho (o banco repete os mesmos números em CHECK).
const LIMITS = Object.freeze({
  NOME: 80,
  DESCRICAO: 500,
  CATEGORIA: 60,
  // Preço de referência: no máximo 2 casas decimais (a coluna é NUMERIC(15,2) — um valor com mais casas seria ARREDONDADO em
  // silêncio pelo Postgres, então o domínio o recusa) e até 1 bilhão (um teto de sanidade, não uma regra de negócio).
  PRECO_REFERENCIA_MAXIMO: 1_000_000_000,
});

// SERVIÇOS — MODALIDADES DE PAGAMENTO (Fase C1, decisão 0027). UM MESMO serviço pode oferecer, ao mesmo tempo, o pagamento ÚNICO (pelo valor
// total do contrato) e o pagamento RECORRENTE (em uma ou mais periodicidades). Três campos gravam isso:
//   permitePagamentoUnico       booleano;
//   permitePagamentoRecorrente  booleano;
//   periodicidades              lista (sem repetição) de RECURRENCES; não vazia SE E SÓ SE o pagamento recorrente é permitido.
// Um cadastro NOVO exige ao menos uma modalidade; um serviço LEGADO (criado antes da Fase C1) pode continuar sem nenhuma — o sistema nunca a
// infere — e o ADMIN a completa na edição. Uma edição nunca apaga modalidades que não foram enviadas. As regras estão em catalogDomain.js e,
// de novo, em CHECKs da tabela (migration 20261018090000).
// O PRAZO CONTRATADO, o TCV, o MRR e o valor recebido NÃO pertencem ao serviço: são da negociação (fase futura; decisão 0027).
// O que era a cobrança de UMA modalidade só (BILLING_TYPES e a recorrência única) é LEGADO: continua nas colunas `tipo_cobranca` e
// `recorrencia`, que a API ainda DEVOLVE (somente leitura) e nunca mais grava; BILLING_TYPES fica só para conferir o CHECK antigo do banco.
const BILLING_TYPES = Object.freeze(['UNICA', 'RECORRENTE']);
const RECURRENCES = Object.freeze(['MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL']);
const PAYMENT_MODALITY_FIELDS = Object.freeze(['permitePagamentoUnico', 'permitePagamentoRecorrente', 'periodicidades']);

// ORIGENS — o CANAL de aquisição. Uma classificação MÍNIMA e extensível por decisão do proprietário (acrescentar um valor aqui exige
// também ajustar o CHECK da tabela, numa migration nova). Nenhuma integração externa existe nesta fase.
const LEAD_CHANNELS = Object.freeze(['PROSPECCAO_ATIVA', 'ANUNCIO_PAGO', 'INDICACAO', 'ORGANICO', 'PARCERIA', 'OUTRO']);

// NICHOS — a PALETA FIXA de 20 cores. O banco e a API guardam só a CHAVE (`azul`), nunca um valor de cor: a interface a transforma
// numa classe de CSS (`.cor-azul`, em dashboard/styles.css), o que mantém o Content-Security-Policy `style-src 'self'` e a regra
// DASH-GUARD-8 (nenhum estilo inline). Cada cor tem três tons, escolhidos para o chip do nicho (sempre com o NOME em texto — a
// cor nunca é a única informação):
//   fundo  tinta clara do chip;
//   texto  tom escuro sobre o fundo, contraste >= 7:1 (WCAG AAA para texto normal);
//   ponto  cor de destaque (a bolinha ao lado do nome), contraste >= 3:1 sobre o fundo e sobre o branco (WCAG 1.4.11).
// `nome` é a identificação textual acessível, em português. tests/crm/catalogConstants.test.js recalcula os contrastes e a distância
// entre os pontos (todos os pares a ΔE >= 20), e confere que o CSS do Dashboard e a migration usam exatamente estas chaves e tons.
const NICHE_COLORS = Object.freeze(
  [
    ['vermelho', 'Vermelho', '#fde4e3', '#8f2119', '#d91f12'],
    ['laranja', 'Laranja', '#fdece3', '#7e3c16', '#aa470e'],
    ['ambar', 'Âmbar', '#fdf3e3', '#6c4c13', '#c18010'],
    ['amarelo', 'Amarelo', '#fdf8e3', '#5f5211', '#7c6a0e'],
    ['lima', 'Lima', '#f5fde3', '#455b10', '#719c0d'],
    ['verde', 'Verde', '#e4fde3', '#135f11', '#12a50d'],
    ['esmeralda', 'Esmeralda', '#e3fdf0', '#115f38', '#0da057'],
    ['turquesa', 'Turquesa', '#e3fdf9', '#115f55', '#049f8a'],
    ['ciano', 'Ciano', '#e3f9fd', '#125964', '#0e99af'],
    ['celeste', 'Celeste', '#e3f2fd', '#16547e', '#0e6baa'],
    ['azul', 'Azul', '#e3ecfd', '#1a4793', '#125bd9'],
    ['indigo', 'Índigo', '#e3e4fd', '#1a2293', '#12197d'],
    ['violeta', 'Violeta', '#eae3fd', '#3a1a93', '#4712d9'],
    ['roxo', 'Roxo', '#f2e3fd', '#631a93', '#6b0eaa'],
    ['orquidea', 'Orquídea', '#fae3fd', '#7f188b', '#c512d9'],
    ['magenta', 'Magenta', '#fde3f7', '#8b1870', '#aa0e85'],
    ['rosa', 'Rosa', '#fde3ee', '#8f194c', '#d91268'],
    ['carmim', 'Carmim', '#fde3e7', '#931a2e', '#aa0e28'],
    ['marrom', 'Marrom', '#f7efe9', '#68482c', '#b37c4d'],
    ['ardosia', 'Ardósia', '#edeff2', '#404f64', '#3c4653'],
  ].map(([chave, nome, fundo, texto, ponto]) => Object.freeze({ chave, nome, fundo, texto, ponto }))
);
const NICHE_COLOR_KEYS = Object.freeze(NICHE_COLORS.map((color) => color.chave));

// Os `code` de erro que o domínio e o Service anexam (a API os reconhece por STRING — app.js nunca importa src/crm).
const CATALOG_ERROR = Object.freeze({
  INVALID_INPUT: 'CRM_CATALOG_INVALID_INPUT',
  NOT_FOUND: 'CRM_CATALOG_NOT_FOUND',
  DUPLICATE_NAME: 'CRM_CATALOG_DUPLICATE_NAME',
  NAME_IN_USE: 'CRM_CATALOG_NAME_IN_USE',
  PERSISTENCE: 'CRM_CATALOG_PERSISTENCE',
});

module.exports = {
  CATALOG,
  CATALOG_KEYS,
  CATALOG_DEFINITIONS,
  COMMON_ITEM_FIELDS,
  LIMITS,
  BILLING_TYPES,
  RECURRENCES,
  PAYMENT_MODALITY_FIELDS,
  LEAD_CHANNELS,
  NICHE_COLORS,
  NICHE_COLOR_KEYS,
  CATALOG_ERROR,
};
