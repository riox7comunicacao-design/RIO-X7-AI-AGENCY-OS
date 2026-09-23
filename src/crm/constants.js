// Constantes do domínio de CRM (decisão 0012 — docs/decisions/0012-crm-operational-source-of-truth.md).
//
// Os 13 status são os mesmos confirmados no schema real do CRM no Notion antes desta decisão
// (PROJECT_CONTEXT.md, "Status real do campo Status") — só o formato do identificador muda
// (maiúsculas com underscore, para ser um valor de código válido; o rótulo com espaço fica só
// para exibição, quando necessário). Nenhum status foi inventado, nenhum foi removido.
const CRM_STATUS = Object.freeze({
  PROSPECT: 'PROSPECT',
  RESEARCH: 'RESEARCH',
  QUALIFIED_PROSPECT: 'QUALIFIED_PROSPECT',
  CONTACTED: 'CONTACTED',
  RESPONDED: 'RESPONDED',
  QUALIFICATION: 'QUALIFICATION',
  MEETING_SCHEDULED: 'MEETING_SCHEDULED',
  MEETING_COMPLETED: 'MEETING_COMPLETED',
  PROPOSAL: 'PROPOSAL',
  NEGOTIATION: 'NEGOTIATION',
  WON: 'WON',
  LOST: 'LOST',
  DO_NOT_CONTACT: 'DO_NOT_CONTACT',
});

// Rótulo de exibição — só para a camada de apresentação (um futuro Dashboard). O identificador
// interno (CRM_STATUS) nunca muda; isto aqui é a tradução amigável pedida na decisão 0012.
const CRM_STATUS_LABEL = Object.freeze({
  [CRM_STATUS.PROSPECT]: 'Prospect',
  [CRM_STATUS.RESEARCH]: 'Research',
  [CRM_STATUS.QUALIFIED_PROSPECT]: 'Qualified Prospect',
  [CRM_STATUS.CONTACTED]: 'Contacted',
  [CRM_STATUS.RESPONDED]: 'Responded',
  [CRM_STATUS.QUALIFICATION]: 'Qualification',
  [CRM_STATUS.MEETING_SCHEDULED]: 'Meeting Scheduled',
  [CRM_STATUS.MEETING_COMPLETED]: 'Meeting Completed',
  [CRM_STATUS.PROPOSAL]: 'Proposal',
  [CRM_STATUS.NEGOTIATION]: 'Negotiation',
  [CRM_STATUS.WON]: 'Won',
  [CRM_STATUS.LOST]: 'Lost',
  [CRM_STATUS.DO_NOT_CONTACT]: 'Do Not Contact',
});

// Os 10 status "de funil": um registro nesses status pode ir livremente para qualquer outro
// (inclusive voltar — um Dashboard/Kanban humano precisa poder corrigir um arraste errado ou
// reabrir um lead esfriado, do mesmo jeito que o Kanban do Notion já permite hoje), ou fechar
// como WON/LOST, ou ser bloqueado como DO_NOT_CONTACT a qualquer momento.
const PIPELINE_STATUSES = Object.freeze([
  CRM_STATUS.PROSPECT,
  CRM_STATUS.RESEARCH,
  CRM_STATUS.QUALIFIED_PROSPECT,
  CRM_STATUS.CONTACTED,
  CRM_STATUS.RESPONDED,
  CRM_STATUS.QUALIFICATION,
  CRM_STATUS.MEETING_SCHEDULED,
  CRM_STATUS.MEETING_COMPLETED,
  CRM_STATUS.PROPOSAL,
  CRM_STATUS.NEGOTIATION,
]);

// Máquina de estados (mesmo mecanismo de approvalQueue.js: um mapa de -> destinos permitidos;
// qualquer status sem entrada aqui é terminal, sem nenhuma transição de saída).
//
//   - os 10 status de funil: podem ir para qualquer OUTRO status de funil, ou fechar (WON/LOST),
//     ou ser bloqueado (DO_NOT_CONTACT);
//   - WON e LOST: só podem ir para DO_NOT_CONTACT (alguém que já fechou, ganhou ou perdeu, pode
//     ainda pedir para nunca mais ser contatado) — nunca voltam sozinhos ao funil;
//   - DO_NOT_CONTACT: TERMINAL. Nenhuma transição de saída — nunca reaberto automaticamente,
//     nunca contornado trocando de status (mesmo princípio já usado para o estado DNC da
//     Approval Queue, e para checkDoNotContact em research-prospector).
//
// Isto é uma decisão de design desta etapa (CRM-DOMAIN), não uma regra de negócio já documentada
// em outro lugar — registrada explicitamente no relatório da etapa para revisão.
const ALLOWED_TRANSITIONS = Object.freeze(
  Object.fromEntries([
    ...PIPELINE_STATUSES.map((from) => [
      from,
      Object.freeze([...PIPELINE_STATUSES.filter((to) => to !== from), CRM_STATUS.WON, CRM_STATUS.LOST, CRM_STATUS.DO_NOT_CONTACT]),
    ]),
    [CRM_STATUS.WON, Object.freeze([CRM_STATUS.DO_NOT_CONTACT])],
    [CRM_STATUS.LOST, Object.freeze([CRM_STATUS.DO_NOT_CONTACT])],
  ])
);

// Mesmo vocabulário ACTOR já usado em approvalQueue.js: quem originou a transição.
const ACTOR = Object.freeze({ HUMAN: 'HUMAN', SYSTEM: 'SYSTEM' });

// Campos do registro de CRM que um chamador pode ESCREVER (criar/atualizar). A lista vem
// diretamente dos campos já aprovados para o CRM V1 — nenhum campo novo foi inventado aqui.
// `id`, `status` e `historico` NUNCA entram por aqui: `id` é gerado pelo domínio, `status` só
// muda por moveStatus()/markDoNotContact() (para sempre gerar histórico e respeitar a máquina de
// estados), e `historico` é só de leitura (o domínio o gerencia inteiramente).
const CRM_WRITABLE_FIELDS = Object.freeze([
  'empresa',
  'contato',
  'cargo',
  'telefone',
  'whatsapp',
  'email',
  'site',
  'instagram',
  'facebook',
  'googlePerfil',
  'cidade',
  'estado',
  'nicho',
  'origem',
  'temperatura',
  'servicoPotencial',
  'problemaIdentificado',
  'raioXDeNicho',
  'raioXPersonalizado',
  'statusDoDiagnostico',
  'linkDoRaioX',
  'dataDaAnalise',
  'dataDaReuniao',
  'linkDoMeet',
  'proximaAcao',
  'dataDaProximaAcao',
  'responsavel',
  'ultimaInteracao',
  'valorProposta',
  'valorTotal',
  'observacoes',
]);

// Campos só de leitura, gerenciados pelo próprio domínio (nunca aceitos como entrada de escrita).
const CRM_MANAGED_FIELDS = Object.freeze(['id', 'status', 'dataDeEntrada', 'historico']);

module.exports = {
  CRM_STATUS,
  CRM_STATUS_LABEL,
  PIPELINE_STATUSES,
  ALLOWED_TRANSITIONS,
  ACTOR,
  CRM_WRITABLE_FIELDS,
  CRM_MANAGED_FIELDS,
};
