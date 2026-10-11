// O IDIOMA da interface (CRM 5.0, Fase 2A): português do Brasil simples. Estes testes varrem TODOS os textos do Dashboard atrás dos termos em inglês que o proprietário mandou traduzir
// (Approval Queue, Pipeline, Prospect, DNC, Won/Lost e companhia, Kanban, Drawer, Modal, Workbench, Job, Closer...) e conferem o catálogo central (dashboard/i18n/pt-BR.mjs).
//
// PERMITIDOS em inglês (por decisão do proprietário): LEAD, Dashboard, MQL, Status, Follow-up, os nomes próprios (WhatsApp, Google Meet, Meta Ads, Google Ads, CRM...), Raio-X e Briefing.
// NUNCA traduzidos (compatibilidade): identificadores técnicos, valores guardados, rotas, permissões, contratos de API e nomes de função. Por isso um texto que é CÓDIGO (PROSPECT, DNC,
// APPROVE:LEAD_APPROVAL...) não conta — mas um texto com um desses termos no meio de uma frase conta.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { analyzeSource, listSourceFiles, toPosix } = require('../helpers/staticImports');
const { DASHBOARD_ROOT } = require('./testEnv');

const loadCatalog = () => import('../../dashboard/i18n/pt-BR.mjs');

const FILES = listSourceFiles(DASHBOARD_ROOT).filter((file) => file.endsWith('.mjs'));
const rel = (file) => toPosix(path.relative(DASHBOARD_ROOT, file));
const STRINGS = FILES.map((file) => ({ nome: rel(file), strings: analyzeSource(fs.readFileSync(file, 'utf8'), rel(file)).strings.map((entry) => entry.value) }));

// um texto que é CÓDIGO (valor guardado, rota, permissão, chave de objeto): tudo em maiúsculas/dígitos/_ : ou sem espaço e sem letra inicial maiúscula seguida de minúscula
// (inclui listas de classes CSS: "drawer-actions edit-footer", "pipeline-bar tone-")
const isCode = (texto) => /^[A-Z0-9_:./-]+$/.test(texto) || /^[a-z][a-zA-Z0-9_.:/#?=&%{}$-]*$/.test(texto) || /^[a-z][a-z0-9_-]*( [a-z0-9_-]*)+$/.test(texto);

test('[VOCAB-1] nenhum texto da interface tem os termos em inglês que foram traduzidos (Approval Queue, Pipeline, Kanban, Drawer, Modal, Prospect, DNC, Workbench, Job, Closer, os rótulos em inglês dos status...)', async () => {
  const { FORBIDDEN_UI_TERMS } = await loadCatalog();
  const achados = [];
  for (const { nome, strings } of STRINGS) {
    for (const texto of strings) {
      if (isCode(texto)) continue;
      for (const { pattern, use } of FORBIDDEN_UI_TERMS) if (pattern.test(texto)) achados.push(`${nome}: "${texto.slice(0, 80)}" → use ${use}`);
    }
  }
  assert.deepEqual(achados, []);
});

test('[VOCAB-2] o catálogo cobre os 13 status (nenhum em inglês, nenhum repetido), os papéis, o glossário e cada rota tem título; e as palavras permitidas em inglês estão registradas', async () => {
  const { STATUS_LABELS, ROLE_LABELS, TERMS, PAGE_TITLES, ALLOWED_ENGLISH, FORBIDDEN_UI_TERMS, findForbiddenTerm } = await loadCatalog();
  const { CRM_STATUSES } = await import('../../dashboard/crm-model.mjs');
  assert.deepEqual(Object.keys(STATUS_LABELS), CRM_STATUSES.map((status) => status.value), 'os identificadores guardados continuam os mesmos, na ordem do funil');
  assert.equal(new Set(Object.values(STATUS_LABELS)).size, 13, 'nenhum rótulo repetido');
  for (const rotulo of Object.values(STATUS_LABELS)) assert.equal(findForbiddenTerm(rotulo), null, rotulo);
  assert.deepEqual(ROLE_LABELS, { ADMIN: 'Administrador', COMMERCIAL_CLOSER: 'Vendedor' });
  assert.equal(TERMS.approvalQueue, 'Fila de Aprovação');
  assert.equal(TERMS.doNotContact, 'Não Contatar');
  assert.equal(TERMS.salesFunnel, 'Funil de Vendas');
  assert.equal(TERMS.leadInProspecting, 'Lead em Prospecção');
  assert.equal(TERMS.kickoffMeeting, 'Reunião de Início');
  assert.equal(TERMS.comingSoon, 'EM DESENVOLVIMENTO');
  for (const permitido of ['LEAD', 'Dashboard', 'MQL', 'Status', 'Follow-up', 'WhatsApp', 'Google Meet', 'Meta Ads', 'Google Ads', 'CRM', 'Raio-X', 'Briefing']) assert.ok(ALLOWED_ENGLISH.includes(permitido), permitido);
  for (const titulo of Object.values(PAGE_TITLES)) assert.equal(findForbiddenTerm(titulo), null, titulo);
  assert.ok(FORBIDDEN_UI_TERMS.length >= 10);
  // nenhuma palavra permitida é barrada
  for (const permitido of ALLOWED_ENGLISH) assert.equal(findForbiddenTerm(permitido), null, `"${permitido}" é permitido`);
});

test('[VOCAB-3] findForbiddenTerm barra o que deve e deixa passar o que é permitido (sem substituição cega: "Prospecção" não é "Prospect")', async () => {
  const { findForbiddenTerm } = await loadCatalog();
  for (const ruim of ['Approval Queue', 'Pipeline comercial', 'Kanban de funis', 'Prospects aprovados', 'Lead em DNC', 'Do Not Contact', 'Won', 'Proposal', 'Workbench de Prospecção', 'Link do Meet', 'Closer comercial', 'Veja o Job']) assert.ok(findForbiddenTerm(ruim), ruim);
  for (const boa of ['Fila de Aprovação', 'Funil de Vendas', 'Quadro de Negociações', 'Lead em Prospecção', 'Prospecção', 'Nova Prospecção', 'Não Contatar', 'Fechada', 'Link do Google Meet', 'Vendedor', 'Dashboard Comercial', 'Follow-up atrasado', 'MQL', 'Briefing salvo', 'Raio-X de nicho', 'WhatsApp', 'Meta Ads e Google Ads', 'Status do diagnóstico']) assert.equal(findForbiddenTerm(boa), null, boa);
});

test('[VOCAB-4] texto GUARDADO não é alterado: só a exibição traduz "Approval Queue" e "prospect" do histórico (o backend segue gravando como sempre); qualquer outra coisa aparece como veio', async () => {
  const { localizeStoredText } = await loadCatalog();
  const guardado = 'Promovido da Approval Queue (prospect "id:alfa"; aprovado por Breno em 2026-10-11T14:27:10.128Z)';
  assert.equal(localizeStoredText(guardado), 'Promovido da Fila de Aprovação (lead "id:alfa"; aprovado por Breno em 2026-10-11T14:27:10.128Z)');
  assert.equal(guardado.includes('Approval Queue'), true, 'a string original não foi tocada');
  assert.equal(localizeStoredText('Pediu para não ser contatado'), 'Pediu para não ser contatado');
  assert.equal(localizeStoredText(undefined), '');
  assert.equal(localizeStoredText({}), '');

  const { describeHistory } = await import('../../dashboard/crm-model.mjs');
  const entradas = [{ timestamp: '2026-09-10T12:00:00.000Z', from: null, to: 'PROSPECT', actor: 'SYSTEM', reviewedBy: null, motivo: guardado }];
  assert.match(describeHistory(entradas)[0].reason, /^Promovido da Fila de Aprovação \(lead "id:alfa"/);
  assert.equal(entradas[0].motivo, guardado, 'o histórico recebido não é alterado');
});

test('[VOCAB-5] os valores GUARDADOS e os contratos seguem em inglês/código: nenhum identificador de status, de estado da fila, de permissão ou de rota foi traduzido', async () => {
  const { CRM_STATUSES, PERMISSIONS } = await import('../../dashboard/crm-model.mjs');
  assert.deepEqual(CRM_STATUSES.map((status) => status.value), ['PROSPECT', 'RESEARCH', 'QUALIFIED_PROSPECT', 'CONTACTED', 'RESPONDED', 'QUALIFICATION', 'MEETING_SCHEDULED', 'MEETING_COMPLETED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST', 'DO_NOT_CONTACT']);
  assert.equal(PERMISSIONS.READ_CRM, 'READ:CRM');
  assert.equal(PERMISSIONS.DELETE_CRM, 'DELETE:CRM');
  const { buildHash } = await import('../../dashboard/router.mjs');
  assert.equal(buildHash({ name: 'approvals' }), '#/aprovacoes', 'as rotas antigas não mudaram');
  assert.equal(buildHash({ name: 'crm-record', id: 'crm:a' }), '#/crm/registro/crm%3Aa');
  // o domínio (backend) não foi tocado
  const domain = require('../../src/crm/constants');
  assert.equal(domain.CRM_STATUS_LABEL.WON, 'Won', 'o backend segue com os seus nomes; só o Dashboard os traduz');
});
