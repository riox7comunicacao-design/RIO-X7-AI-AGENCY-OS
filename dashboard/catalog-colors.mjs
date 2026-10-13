// A PALETA FIXA de 20 cores dos nichos (CRM 5.0, Fase 2B-2) — o que o Dashboard sabe sobre ela: a CHAVE que o servidor guarda, o NOME que a pessoa lê e a CLASSE de CSS que aplica a cor.
//
// A fonte da verdade da paleta é o servidor (src/crm/catalogConstants.js#NICHE_COLORS): ele só aceita estas 20 chaves. O navegador nunca importa src/ (regra R11); por isso esta lista é uma
// CÓPIA ESTÁTICA, e tests/server/dashboard-catalog-ui-colors.test.js a compara com a do servidor (chave, nome e ordem) e com as classes `.cor-<chave>` de styles.css. Se uma divergir, o teste falha.
//
// NENHUM VALOR DE COR vive aqui, e nenhuma classe é montada por concatenação: cada entrada traz a sua classe escrita por extenso. Os tons (fundo, texto e ponto) ficam só em styles.css
// (CSP `style-src 'self'`, regra DASH-GUARD-8: nenhum estilo inline). O banco e a API guardam só a chave ("azul"); uma chave desconhecida ou ausente não tem classe de cor — cai no tom neutro.

const color = (chave, nome, className) => Object.freeze({ chave, nome, className });

export const NICHE_COLOR_OPTIONS = Object.freeze([
  color('vermelho', 'Vermelho', 'cor-vermelho'),
  color('laranja', 'Laranja', 'cor-laranja'),
  color('ambar', 'Âmbar', 'cor-ambar'),
  color('amarelo', 'Amarelo', 'cor-amarelo'),
  color('lima', 'Lima', 'cor-lima'),
  color('verde', 'Verde', 'cor-verde'),
  color('esmeralda', 'Esmeralda', 'cor-esmeralda'),
  color('turquesa', 'Turquesa', 'cor-turquesa'),
  color('ciano', 'Ciano', 'cor-ciano'),
  color('celeste', 'Celeste', 'cor-celeste'),
  color('azul', 'Azul', 'cor-azul'),
  color('indigo', 'Índigo', 'cor-indigo'),
  color('violeta', 'Violeta', 'cor-violeta'),
  color('roxo', 'Roxo', 'cor-roxo'),
  color('orquidea', 'Orquídea', 'cor-orquidea'),
  color('magenta', 'Magenta', 'cor-magenta'),
  color('rosa', 'Rosa', 'cor-rosa'),
  color('carmim', 'Carmim', 'cor-carmim'),
  color('marrom', 'Marrom', 'cor-marrom'),
  color('ardosia', 'Ardósia', 'cor-ardosia'),
]);

export const NICHE_COLOR_KEYS = Object.freeze(NICHE_COLOR_OPTIONS.map((option) => option.chave));

const BY_KEY = new Map(NICHE_COLOR_OPTIONS.map((option) => [option.chave, option]));

// A cor aprovada de uma chave, ou null (chave desconhecida, vazia ou de outro tipo).
export function colorOption(chave) {
  return typeof chave === 'string' && BY_KEY.has(chave) ? BY_KEY.get(chave) : null;
}

// A classe de CSS da cor ('' quando a chave não é uma das 20: o chip fica no tom neutro).
export function colorClassOf(chave) {
  const option = colorOption(chave);
  return option ? option.className : '';
}

// O nome da cor para a pessoa ('' quando não há cor).
export function colorNameOf(chave) {
  const option = colorOption(chave);
  return option ? option.nome : '';
}
