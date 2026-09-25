// O MAPEAMENTO de um prospect da Approval Queue para os campos do CRM (etapa CRM-INTEGRATION, decisão 0016).
//
// Só funções PURAS: nada aqui toca a fila, o CRM, o disco ou a rede, e nada aqui decide se um prospect PODE ser
// promovido (isso é do crmIntegrationService.js, da fila e do domínio do CRM). Recebe o item da fila (uma cópia) e
// devolve o objeto de CAMPOS que o CRM Service aceita em createRecord — só chaves de CRM_WRITABLE_FIELDS, só textos.
//
// REGRAS (a tabela completa está em docs/decisions/0016-crm-integration.md):
//   1. NUNCA se copia cegamente. Cada campo do CRM vem de UMA origem nomeada abaixo; o que não está na tabela não passa.
//   2. NUNCA se inventa valor: campo ausente, vazio ou que não seja texto é OMITIDO (o domínio o grava como null).
//   3. Só propriedades PRÓPRIAS são lidas: uma propriedade herdada do protótipo (Object.prototype poluído) nunca vira
//      campo do CRM.
//   4. O que a fila tem e o CRM NÃO tem campo próprio (LinkedIn, YouTube, endereço, tipo, data da pesquisa, fontes
//      consultadas, observações da pesquisa e a HIPÓTESE de oportunidade) vai para `observacoes`, como linhas
//      ROTULADAS — nada some, e nada é apresentado como o que não é: a hipótese continua marcada "HIPOTESE — ..." (a
//      fila já a guarda assim) e NUNCA vai para `problemaIdentificado`, que afirmaria um problema como fato (Regra 2
//      do RULES.md: hipótese não é fato).
//   5. O que é metadado de REVISÃO da fila (statusIdentidade, statusDados, statusDuplicidade, matchedOn, statusDNC,
//      estadoOperacionalDiscovery) NÃO é copiado: não é dado do lead, e a duplicidade/DNC são decididas pelo domínio
//      do CRM, com as regras dele, na hora da criação — nenhuma regra paralela aqui.
//   6. O que o CRM tem e a fila NÃO tem (contato, cargo, Google Perfil, temperatura, serviço, valores, datas...)
//      simplesmente não é preenchido. `googlePerfil` existe na pesquisa, mas a fila não o guarda no snapshot
//      (limite registrado em 0016, não corrigido aqui).
//   7. `empresa` é a única obrigatória do CRM. Se a fila não a tiver, o campo não existe no resultado e quem chama
//      trata como DADOS_INSUFICIENTES — nada é fabricado.

const MAX_NOTES_LENGTH = 4000; // o mesmo limite de texto longo do formulário do Dashboard
const MAX_SOURCES = 10;
const MAX_SOURCE_LENGTH = 300;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const own = (object, key) => (isPlainObject(object) && hasOwn(object, key) ? object[key] : undefined);

// Um texto útil: texto não vazio (sem espaços nas pontas); qualquer outra coisa não é um valor.
const textOrUndefined = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);

// campo do CRM <- campo do snapshot da fila (só os que têm equivalente direto)
const DIRECT_FIELDS = Object.freeze([
  ['cidade', 'cidade'],
  ['estado', 'estadoUf'],
  ['nicho', 'nicho'],
  ['origem', 'origem'],
  ['site', 'site'],
  ['instagram', 'instagram'],
  ['facebook', 'facebook'],
  ['telefone', 'telefone'],
  ['whatsapp', 'whatsapp'],
  ['email', 'email'],
]);

// As linhas rotuladas de `observacoes`, na ordem em que aparecem.
const NOTE_LINES = Object.freeze([
  ['Observações da pesquisa', 'observacoes'],
  ['Hipótese de oportunidade', 'hipoteseDeOportunidade'],
  ['Tipo', 'tipo'],
  ['LinkedIn', 'linkedin'],
  ['YouTube', 'youtube'],
  ['Endereço', 'endereco'],
  ['Pesquisado em', 'dataDaPesquisa'],
]);

function buildNotes(snapshot) {
  const lines = [];
  for (const [label, key] of NOTE_LINES) {
    const value = textOrUndefined(own(snapshot, key));
    if (value !== undefined) lines.push(`${label}: ${value}`);
  }
  const sources = own(snapshot, 'fontes');
  if (Array.isArray(sources)) {
    const shown = sources
      .map(textOrUndefined)
      .filter((source) => source !== undefined)
      .slice(0, MAX_SOURCES)
      .map((source) => (source.length > MAX_SOURCE_LENGTH ? `${source.slice(0, MAX_SOURCE_LENGTH - 1)}…` : source));
    if (shown.length > 0) lines.push(`Fontes consultadas: ${shown.join('; ')}`);
  }
  if (lines.length === 0) return undefined;
  const notes = lines.join('\n');
  return notes.length > MAX_NOTES_LENGTH ? `${notes.slice(0, MAX_NOTES_LENGTH - 1)}…` : notes;
}

// prospect: o item da fila (uma cópia, como o Approval Queue Service o devolve). Devolve os campos do CRM.
function mapProspectToCrmFields(prospect) {
  const snapshot = own(prospect, 'discoverySnapshot');
  const fields = {};

  // A empresa vem do próprio item (o que a fila lista e o humano revisou); o snapshot é só o reserva.
  const empresa = textOrUndefined(own(prospect, 'empresa')) || textOrUndefined(own(snapshot, 'empresa'));
  if (empresa !== undefined) fields.empresa = empresa;

  for (const [crmField, queueField] of DIRECT_FIELDS) {
    const value = textOrUndefined(own(snapshot, queueField));
    if (value !== undefined) fields[crmField] = value;
  }

  const notes = buildNotes(snapshot);
  if (notes !== undefined) fields.observacoes = notes;
  return fields;
}

module.exports = { mapProspectToCrmFields, DIRECT_FIELDS, NOTE_LINES, MAX_NOTES_LENGTH };
