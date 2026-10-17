// A DEPENDÊNCIA OBRIGATÓRIA da promoção para o CRM: como o CRM Integration Service verifica as Exclusões Permanentes (Fase 2B-3.2B,
// decisão 0016). Só existem DUAS formas válidas — e não existe a terceira, "não informei nada":
//
//   ENFORCED              — a verificação é feita de verdade, pelo Service de Exclusões Permanentes (Supabase em produção, memória nos
//                           testes): createEnforcedPermanentExclusionGuard(exclusionService).
//   FILE_MODE_UNVERIFIED  — o MARCADOR de que este modo NÃO TEM o serviço operacional de Exclusões Permanentes. Em REPOSITORY_MODE=file
//                           a funcionalidade não existe (decisão do proprietário: nunca um arquivo local — ver
//                           prospectingExclusionRepositoryFactory.js). Não é uma consulta válida que não achou nada: é a declaração, por
//                           quem compõe, de que a consulta NÃO EXISTE aqui. Uma promoção feita neste modo NÃO comprova que a empresa não
//                           esteja excluída, e o servidor avisa isso na inicialização.
//
// Omitir a dependência é um erro na criação do CRM Integration Service (nunca "sem exclusões"). O marcador só nasce de
// createConfiguredPermanentExclusionGuard (prospectingExclusionRepositoryFactory.js), que o recusa em REPOSITORY_MODE=supabase; não existe
// variável de ambiente nem opção que o ligue em produção. O CRM manual (cadastro feito por uma pessoa) não passa por aqui.

const GUARD_MODE = Object.freeze({ ENFORCED: 'ENFORCED', FILE_MODE_UNVERIFIED: 'FILE_MODE_UNVERIFIED' });

const FILE_MODE_UNVERIFIED = Object.freeze({ mode: GUARD_MODE.FILE_MODE_UNVERIFIED });

// O aviso da inicialização do servidor (e o texto que a documentação repete).
const FILE_MODE_WARNING =
  'Atenção: neste modo (REPOSITORY_MODE=file) o servidor NÃO verifica as Exclusões Permanentes na promoção para o CRM — a funcionalidade só existe com REPOSITORY_MODE=supabase. Uma promoção feita agora não comprova que a empresa não esteja excluída.';

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// exclusionService: o Prospecting Permanent Exclusion Service, com verifyCandidate(). A função fica capturada aqui.
function createEnforcedPermanentExclusionGuard(exclusionService) {
  if (!isPlainObject(exclusionService) || typeof exclusionService.verifyCandidate !== 'function') {
    throw new Error('Exclusões Permanentes: a verificação da promoção exige um serviço com verifyCandidate()');
  }
  const { verifyCandidate } = exclusionService;
  return Object.freeze({ mode: GUARD_MODE.ENFORCED, verify: (candidate) => verifyCandidate(candidate) });
}

// Só o marcador exportado (a MESMA referência) ou uma guarda ENFORCED com verify() valem; qualquer outra coisa — undefined, null, {},
// { mode: 'FILE_MODE_UNVERIFIED' } copiado à mão — não vale.
function isPermanentExclusionGuard(value) {
  if (value === FILE_MODE_UNVERIFIED) return true;
  return isPlainObject(value) && value.mode === GUARD_MODE.ENFORCED && typeof value.verify === 'function';
}

module.exports = { GUARD_MODE, FILE_MODE_UNVERIFIED, FILE_MODE_WARNING, createEnforcedPermanentExclusionGuard, isPermanentExclusionGuard };
