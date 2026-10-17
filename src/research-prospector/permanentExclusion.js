// Exclusões Permanentes de Prospecção (Workbench, Etapa 2) — domínio PURO: normalização de nome/cidade/estado
// para comparação, o critério de correspondência (nome + contexto geográfico, ou domínio) e a validação da
// entrada do formulário administrativo. Nenhuma persistência, nenhuma rede.
//
// EXEMPLO OBRIGATÓRIO (o próprio comando desta etapa): "FORÇA DIGITAL", "força digital" e "Força Digital" têm de
// ser reconhecidas como a MESMA empresa. Normalização CONSERVADORA — só maiúsculas/minúsculas, acentuação, espaços
// e pontuação — NUNCA fuzzy matching (duas empresas com nomes parecidos, mas diferentes, nunca colapsam na mesma
// chave).
//
// CRITÉRIO DE EXCLUSÃO (seção 4 do comando): uma correspondência de NOME só bloqueia quando o contexto geográfico
// da exclusão (se preenchido) também bate com o do finding — e um finding SEM geografia conhecida, contra uma
// exclusão QUE especifica geografia, é AMBÍGUO e NUNCA bloqueia sozinho (a regra explícita: "se houver
// ambiguidade, não bloquear automaticamente"). Domínio é um critério INDEPENDENTE: quando a exclusão tem um
// domínio cadastrado e ele bate com o site do finding, bloqueia mesmo que o nome varie.

const { stripAccents, normalizeDomain } = require('./normalize');

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const LIMITS = Object.freeze({ EMPRESA: 200, CIDADE: 120, ESTADO: 60, PAIS: 60, DOMINIO: 200, MOTIVO: 1000 });
const DEFAULT_PAIS = 'Brasil';

// "FORÇA DIGITAL" / "força digital" / "Força Digital" -> "forca digital". Minúsculas, sem acento, só letras/
// dígitos/espaços (pontuação vira espaço), espaços colapsados e aparados. Reutiliza stripAccents (o MESMO usado
// pela deduplicação de prospects, normalize.js) — nunca uma segunda implementação de normalização de texto.
function normalizeCompanyName(value) {
  if (typeof value !== 'string') return null;
  let normalized = stripAccents(value.toLowerCase());
  normalized = normalized.replace(/[^a-z0-9\s]/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

// A mesma normalização serve para cidade/estado (só comparação, nunca fuzzy).
const normalizeLocation = normalizeCompanyName;

const isText = (value) => typeof value === 'string';
function checkText(value, max, { required = false } = {}) {
  if (value === undefined || value === null) return required ? { error: 'CAMPO_OBRIGATORIO' } : { value: undefined };
  if (!isText(value)) return { error: 'VALOR_INVALIDO' };
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return { error: 'CAMPO_OBRIGATORIO' };
  if (trimmed.length > max) return { error: 'TAMANHO_EXCESSIVO' };
  return { value: trimmed.length === 0 ? undefined : trimmed };
}

const CREATE_KEYS = Object.freeze(['empresa', 'cidade', 'estado', 'pais', 'dominio', 'motivo']);
const UPDATE_KEYS = Object.freeze(['empresa', 'cidade', 'estado', 'pais', 'dominio', 'motivo']);

// Valida a entrada do formulário "Nova exclusão" / "Editar exclusão". `partial`: true para update (nenhum campo é
// obrigatório em si — só os que vierem são validados; `empresa`/`motivo` continuam obrigatórios na CRIAÇÃO).
function validateExclusionInput(raw, { partial = false } = {}) {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ path: '', code: 'NAO_E_OBJETO' }] };
  const allowed = partial ? UPDATE_KEYS : CREATE_KEYS;
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  const errors = unknown.map((key) => ({ path: key, code: 'CAMPO_DESCONHECIDO' }));
  const value = {};

  const empresa = checkText(raw.empresa, LIMITS.EMPRESA, { required: !partial });
  if (empresa.error) errors.push({ path: 'empresa', code: empresa.error });
  else if (empresa.value !== undefined) value.empresa = empresa.value;

  const motivo = checkText(raw.motivo, LIMITS.MOTIVO, { required: !partial });
  if (motivo.error) errors.push({ path: 'motivo', code: motivo.error });
  else if (motivo.value !== undefined) value.motivo = motivo.value;

  for (const [key, max] of [['cidade', LIMITS.CIDADE], ['estado', LIMITS.ESTADO], ['pais', LIMITS.PAIS], ['dominio', LIMITS.DOMINIO]]) {
    if (!hasOwn(raw, key)) continue;
    const checked = checkText(raw[key], max);
    if (checked.error) errors.push({ path: key, code: checked.error });
    else value[key] = checked.value ?? null; // string vazia/ausente vira null explícito (nunca omitido, nunca "undefined")
  }

  if (errors.length > 0) return { ok: false, errors };
  if (!partial && !hasOwn(value, 'pais')) value.pais = DEFAULT_PAIS;
  if (value.empresa !== undefined) value.empresaNomeNormalizado = normalizeCompanyName(value.empresa);
  return { ok: true, value };
}

// Como UMA exclusão se relaciona com UM candidato (Fase 2B-3.2B — a promoção para o CRM precisa distinguir o que a ingestão
// sempre tratou como um `false` só):
//   CORRESPONDENCIA_CONFIRMADA — o domínio bate, ou o nome bate e todo o contexto geográfico que a exclusão especifica bate.
//   AMBIGUA                    — o nome bate, nenhuma informação geográfica do candidato CONTRADIZ a exclusão, mas o candidato não
//                                traz a que a exclusão exige: não dá para confirmar nem descartar que é a mesma empresa.
//   SEM_CORRESPONDENCIA        — inativa, nome diferente ou algum dado geográfico do candidato CONTRADIZ a exclusão.
const EXCLUSION_MATCH = Object.freeze({
  CORRESPONDENCIA_CONFIRMADA: 'CORRESPONDENCIA_CONFIRMADA',
  AMBIGUA: 'AMBIGUA',
  SEM_CORRESPONDENCIA: 'SEM_CORRESPONDENCIA',
});

// O veredito de uma VERIFICAÇÃO (um candidato contra a lista inteira): os três acima mais DADOS_INSUFICIENTES — o candidato não tem um
// nome verificável, então a lista nem é consultada. Uma consulta que FALHA ou vem incompleta não é um veredito: é um erro.
const EXCLUSION_VERDICT = Object.freeze({ ...EXCLUSION_MATCH, DADOS_INSUFICIENTES: 'DADOS_INSUFICIENTES' });

// Uma restrição geográfica da exclusão contra o dado do candidato: 'IGUAL' | 'DIFERENTE' | 'DESCONHECIDO'. Uma restrição da
// exclusão que nem normaliza para um texto utilizável não pode ser conferida: DESCONHECIDO (nunca "diferente" em silêncio).
function compareLocation(exclusionValue, findingValue) {
  const wanted = normalizeLocation(exclusionValue);
  if (!wanted) return 'DESCONHECIDO';
  const actual = normalizeLocation(findingValue);
  if (!actual) return 'DESCONHECIDO';
  return actual === wanted ? 'IGUAL' : 'DIFERENTE';
}

// O critério de correspondência (seção 4), com o resultado em TRÊS valores. `exclusion`: { ativo, empresaNomeNormalizado, cidade,
// estado, dominio }. `finding`: um achado bruto ou o candidato à promoção — usa só empresa/cidade/estado/site, nunca inventa nem
// consulta rede. Os identificadores são os de sempre (nome, cidade, estado e domínio): nada de telefone, Instagram ou e-mail.
function classifyExclusionMatch(finding, exclusion) {
  if (!isPlainObject(finding) || !isPlainObject(exclusion) || exclusion.ativo !== true) return EXCLUSION_MATCH.SEM_CORRESPONDENCIA;

  // Domínio: critério independente do nome — quando a exclusão tem domínio cadastrado E o finding tem site, e os
  // dois normalizam para o MESMO host, bloqueia.
  if (exclusion.dominio) {
    const exclusionDomain = normalizeDomain(exclusion.dominio);
    const findingDomain = normalizeDomain(finding.site);
    if (exclusionDomain && findingDomain && exclusionDomain === findingDomain) return EXCLUSION_MATCH.CORRESPONDENCIA_CONFIRMADA;
  }

  const exclusionName = exclusion.empresaNomeNormalizado || normalizeCompanyName(exclusion.empresa);
  const findingName = normalizeCompanyName(finding.empresa);
  if (!exclusionName || !findingName || exclusionName !== findingName) return EXCLUSION_MATCH.SEM_CORRESPONDENCIA;

  // Contexto geográfico: só exigido quando a EXCLUSÃO o especifica. Um dado que CONTRADIZ a exclusão a descarta; a ausência do
  // dado que ela exige deixa a identidade AMBÍGUA — a ingestão continua não bloqueando por isso (matchesExclusion abaixo), mas a
  // promoção para o CRM não pode tratá-la como "sem correspondência".
  const checks = [];
  if (exclusion.cidade) checks.push(compareLocation(exclusion.cidade, finding.cidade));
  if (exclusion.estado) checks.push(compareLocation(exclusion.estado, finding.estado));
  if (checks.includes('DIFERENTE')) return EXCLUSION_MATCH.SEM_CORRESPONDENCIA;
  if (checks.includes('DESCONHECIDO')) return EXCLUSION_MATCH.AMBIGUA;
  return EXCLUSION_MATCH.CORRESPONDENCIA_CONFIRMADA;
}

// O critério que a INGESTÃO usa, inalterado: só uma correspondência CONFIRMADA bloqueia; a ambiguidade nunca bloqueia sozinha ali.
function matchesExclusion(finding, exclusion) {
  return classifyExclusionMatch(finding, exclusion) === EXCLUSION_MATCH.CORRESPONDENCIA_CONFIRMADA;
}

// O candidato tem o mínimo para ser verificado? A comparação com uma exclusão parte do NOME (toda exclusão tem nome): sem um nome que
// normalize para um texto utilizável não há como dizer se é, ou não, uma empresa excluída.
function hasVerifiableIdentity(finding) {
  return isPlainObject(finding) && normalizeCompanyName(finding.empresa) !== null;
}

module.exports = { LIMITS, DEFAULT_PAIS, EXCLUSION_MATCH, EXCLUSION_VERDICT, normalizeCompanyName, validateExclusionInput, classifyExclusionMatch, matchesExclusion, hasVerifiableIdentity, CREATE_KEYS };
