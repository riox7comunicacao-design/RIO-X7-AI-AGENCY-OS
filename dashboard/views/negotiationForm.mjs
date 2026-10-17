// O formulário de NEGOCIAÇÃO (CRM 5.0, Fase D1, decisão 0028): "Nova negociação" e "Editar negociação", no mesmo modal centralizado dos cadastros. Só monta os campos REAIS do contrato do servidor:
// cliente, funil, serviço, prazo (3, 6, 12 meses ou outro), forma de pagamento (único ou recorrente, só as que o SERVIÇO permite), periodicidade (só as que o serviço permite), valor negociado e a
// previsão de fechamento. Mostra uma PRÉVIA do resultado (TCV, MRR / equivalente mensal e o cronograma) com a MESMA conta do servidor — nunca gravada pelo navegador.
//
// O QUE NÃO FAZ: regra de negócio. O servidor repete tudo (cliente real, serviço permitido, prazo x periodicidade, situação) e tem a palavra final; o responsável e a situação NUNCA são campos. Editar
// leva SÓ o que mudou. Nenhum sucesso é mostrado antes de a API confirmar: o dono do formulário (a tela do funil) grava, atualiza o quadro e fecha. Todo texto entra por dom.mjs (textContent).

import { h } from '../dom.mjs';
import { formField } from '../ui/index.mjs';
import { formatMoney } from '../crm-model.mjs';
import { parseMoney } from '../catalog-model.mjs';
import { PAYMENT_OPTIONS, PERIODICITY_OPTIONS, TERM_PRESETS, MESSAGES, buildCreateBody, buildPatchBody, emptyFormValues, formValuesFromNegotiation, negotiationErrorInfo, previewFinance, scheduleText, fieldMessage, parseTerm } from '../negotiation-model.mjs';
import { textOf } from '../format.mjs';

const idOf = (field) => `negotiation-field-${field}`;
const FIELD_ORDER = Object.freeze(['crmRecordId', 'funnelId', 'serviceId', 'prazoMeses', 'formaPagamento', 'periodicidade', 'valorNegociado', 'previsaoFechamento']);

// document. mode: 'create' | 'edit'. negotiation: a negociação atual (edição). funnels: [{ id, nome, ativo }]. funnelId: o funil já escolhido no quadro. clients: [{ id, empresa }]. services: os itens do catálogo
// (ativos) com as modalidades. onSubmit(body): Promise (o dono grava; se rejeitar, o erro aparece AQUI e o formulário continua aberto). onCancel(): fecha pelo caminho normal.
export function createNegotiationForm({ document, mode, negotiation = null, funnels = [], funnelId = '', clients = [], services = [], onSubmit, onBusy = () => {}, onCancel = () => {} }) {
  const initial = mode === 'edit' ? formValuesFromNegotiation(negotiation) : emptyFormValues(funnelId);
  let baseline = { ...initial };
  let busy = false;
  const el = (tag, props, ...children) => h(document, tag, props, ...children);

  // ---- o catálogo de serviços que o formulário conhece (+ o serviço atual da negociação, mesmo se foi desativado depois) ----
  const knownServices = services.filter((item) => item && typeof item.id === 'string');
  const factsOf = (serviceId) => {
    const item = knownServices.find((entry) => entry.id === serviceId);
    if (!item) return null; // um serviço que o formulário não conhece (ex.: desativado depois): só o servidor confere o que ele permite
    return { permitePagamentoUnico: item.permitePagamentoUnico === true, permitePagamentoRecorrente: item.permitePagamentoRecorrente === true, periodicidades: Array.isArray(item.periodicidades) ? item.periodicidades : [] };
  };

  // ---- controles ----
  const select = (field, emptyLabel, options) => {
    const control = el('select', { id: idOf(field) }, el('option', { value: '', text: emptyLabel }), ...options.map((entry) => el('option', { value: entry.value, text: entry.label })));
    control.value = initial[field] || '';
    return control;
  };
  const clientOptions = clients.map((client) => ({ value: client.id, label: textOf(client.empresa) || 'Sem nome' }));
  if (mode === 'edit' && negotiation && !clientOptions.some((entry) => entry.value === negotiation.crmRecordId)) clientOptions.push({ value: negotiation.crmRecordId, label: textOf(negotiation.cliente && negotiation.cliente.empresa) || 'Cliente' });
  const funnelOptions = funnels.filter((funnel) => funnel.ativo !== false).map((funnel) => ({ value: funnel.id, label: funnel.nome }));
  const serviceOptions = knownServices.map((item) => ({ value: item.id, label: item.nome }));
  if (mode === 'edit' && negotiation && !serviceOptions.some((entry) => entry.value === negotiation.serviceId)) serviceOptions.push({ value: negotiation.serviceId, label: `${textOf(negotiation.servicoNome) || 'Serviço'} (desativado)` });

  const controls = {}; // campo -> { setError, setHidden, element, control, focus() }
  const clientControl = select('crmRecordId', 'Escolha o cliente', clientOptions);
  const funnelControl = select('funnelId', 'Escolha o funil', funnelOptions);
  const serviceControl = select('serviceId', 'Escolha o serviço', serviceOptions);
  const periodicityControl = el('select', { id: idOf('periodicidade') }, el('option', { value: '', text: 'Escolha a periodicidade' }), ...PERIODICITY_OPTIONS.map((entry) => el('option', { value: entry.value, text: entry.label })));
  periodicityControl.value = initial.periodicidade || '';
  const valueControl = el('input', { id: idOf('valorNegociado'), type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', maxlength: '20' });
  valueControl.value = initial.valorNegociado;
  const dateControl = el('input', { id: idOf('previsaoFechamento'), type: 'date' });
  dateControl.value = initial.previsaoFechamento;

  function register(field, spec) {
    const wrapper = formField(document, { id: idOf(field), label: spec.label, control: spec.control, help: spec.help || '', required: Boolean(spec.required) });
    controls[field] = { ...wrapper, focus: () => spec.control.focus() };
    return controls[field];
  }
  register('crmRecordId', { label: 'Cliente', control: clientControl, required: true, help: mode === 'edit' ? 'O cliente não muda depois que a negociação é criada.' : 'O cliente é um registro do CRM. Um cliente pode ter várias negociações.' });
  register('funnelId', { label: 'Funil', control: funnelControl, required: true, help: mode === 'edit' ? 'O funil não muda depois que a negociação é criada. Para mudar de etapa, use o quadro.' : 'A negociação entra na primeira etapa ativa do funil.' });
  register('serviceId', { label: 'Serviço', control: serviceControl, required: true, help: 'O serviço define as formas de pagamento e as periodicidades que podem ser negociadas. Nada no serviço é alterado.' });
  register('periodicidade', { label: 'Periodicidade da cobrança', control: periodicityControl, required: true });
  register('valorNegociado', { label: 'Valor negociado (R$)', control: valueControl, required: true, help: 'Em reais, no formato brasileiro, como 1.500,00.' });
  register('previsaoFechamento', { label: 'Previsão de fechamento', control: dateControl, help: 'Opcional.' });
  if (mode === 'edit') {
    clientControl.disabled = true;
    funnelControl.disabled = true;
  }

  // ---- forma de pagamento (rádio) ----
  const paymentError = el('p', { className: 'field-error', id: `${idOf('formaPagamento')}-error`, role: 'alert', hidden: true });
  const paymentRows = PAYMENT_OPTIONS.map((entry) => {
    const input = el('input', { id: `${idOf('formaPagamento')}-${entry.value.toLowerCase()}`, type: 'radio', name: 'negociacao-forma-pagamento', value: entry.value });
    input.checked = initial.formaPagamento === entry.value;
    return { value: entry.value, input, element: el('div', { className: 'modality-option' }, input, el('label', { for: input.getAttribute('id'), text: entry.label })) };
  });
  const paymentHelp = el('p', { className: 'field-help muted', id: `${idOf('formaPagamento')}-help`, text: '' });
  const paymentGroup = el('fieldset', { className: 'modality-group negotiation-payment', id: idOf('formaPagamento'), 'aria-describedby': `${idOf('formaPagamento')}-help ${idOf('formaPagamento')}-error` }, el('legend', { className: 'required', text: 'Forma de pagamento negociada' }), paymentHelp, ...paymentRows.map((row) => row.element), paymentError);
  controls.formaPagamento = { element: paymentGroup, setError: (message) => { paymentError.textContent = message || ''; paymentError.hidden = !message; }, setHidden: () => {}, focus: () => (paymentRows.find((row) => row.input.checked) || paymentRows[0]).input.focus() };

  // ---- prazo (3, 6, 12 ou outro) ----
  const termError = el('p', { className: 'field-error', id: `${idOf('prazoMeses')}-error`, role: 'alert', hidden: true });
  const isPreset = (text) => TERM_PRESETS.some((preset) => String(preset) === text);
  const initialOther = initial.prazoMeses !== '' && !isPreset(initial.prazoMeses);
  const termRows = [...TERM_PRESETS.map((preset) => ({ value: String(preset), label: `${preset} meses` })), { value: 'outro', label: 'Outro prazo' }].map((entry) => {
    const input = el('input', { id: `negotiation-field-prazo-${entry.value}`, type: 'radio', name: 'negociacao-prazo', value: entry.value });
    input.checked = entry.value === 'outro' ? initialOther : initial.prazoMeses === entry.value;
    return { value: entry.value, input, element: el('div', { className: 'modality-option' }, input, el('label', { for: input.getAttribute('id'), text: entry.label })) };
  });
  const termInput = el('input', { id: idOf('prazoMeses'), type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '3', placeholder: 'Meses (1 a 120)', 'aria-label': 'Prazo em meses' });
  termInput.value = initialOther ? initial.prazoMeses : '';
  const termInputWrap = el('div', { className: 'negotiation-term-other' }, termInput);
  const termGroup = el('fieldset', { className: 'modality-group negotiation-term', id: 'negotiation-field-prazo', 'aria-describedby': `${idOf('prazoMeses')}-error` }, el('legend', { className: 'required', text: 'Prazo do contrato' }), el('p', { className: 'field-help muted', text: 'Por quanto tempo o contrato vale. É independente da periodicidade da cobrança.' }), ...termRows.map((row) => row.element), termInputWrap, termError);
  controls.prazoMeses = { element: termGroup, setError: (message) => { termError.textContent = message || ''; termError.hidden = !message; }, setHidden: () => {}, focus: () => (termRows.find((row) => row.input.checked) || termRows[2]).input.focus() };
  const termValue = () => {
    const chosen = termRows.find((row) => row.input.checked);
    if (!chosen) return '';
    return chosen.value === 'outro' ? String(termInput.value || '') : chosen.value;
  };

  // ---- a prévia ----
  const preview = el('div', { className: 'negotiation-preview', id: 'negotiation-preview', role: 'status', 'aria-live': 'polite' });

  function currentValues() {
    return {
      crmRecordId: String(clientControl.value || ''),
      funnelId: String(funnelControl.value || ''),
      serviceId: String(serviceControl.value || ''),
      prazoMeses: termValue(),
      formaPagamento: (paymentRows.find((row) => row.input.checked) || { value: '' }).value,
      periodicidade: String(periodicityControl.value || ''),
      valorNegociado: String(valueControl.value || ''),
      previsaoFechamento: String(dateControl.value || ''),
    };
  }

  // O que o SERVIÇO permite: desabilita as formas que ele não permite, e limita as periodicidades. Nada é escolhido sozinho.
  function syncService() {
    const facts = factsOf(String(serviceControl.value || ''));
    for (const row of paymentRows) {
      const allowed = !facts || (row.value === 'UNICO' ? facts.permitePagamentoUnico : facts.permitePagamentoRecorrente) || (!facts.permitePagamentoUnico && !facts.permitePagamentoRecorrente);
      row.input.disabled = busy || !allowed;
      if (!allowed && row.input.checked) row.input.checked = false;
    }
    const wanted = facts ? facts.periodicidades : null;
    for (const option of periodicityControl.childNodes) {
      if (option.localName !== 'option' || option.getAttribute('value') === '') continue;
      option.hidden = wanted !== null && !wanted.includes(option.getAttribute('value'));
      option.disabled = option.hidden;
    }
    if (wanted !== null && periodicityControl.value !== '' && !wanted.includes(periodicityControl.value)) periodicityControl.value = '';
    if (!facts) paymentHelp.textContent = 'Escolha o serviço para ver as formas de pagamento que ele permite.';
    else if (!facts.permitePagamentoUnico && !facts.permitePagamentoRecorrente) paymentHelp.textContent = 'Este serviço ainda não tem as formas de pagamento informadas. Peça a um administrador para completar o cadastro do serviço.';
    else paymentHelp.textContent = `O serviço permite: ${[facts.permitePagamentoUnico ? 'pagamento único' : null, facts.permitePagamentoRecorrente ? `pagamento recorrente (${facts.periodicidades.map((value) => (PERIODICITY_OPTIONS.find((entry) => entry.value === value) || { label: value }).label.toLowerCase()).join(', ')})` : null].filter(Boolean).join(' e ')}.`;
  }

  function syncPayment() {
    const values = currentValues();
    controls.periodicidade.setHidden(values.formaPagamento !== 'RECORRENTE');
    if (values.formaPagamento !== 'RECORRENTE') periodicityControl.value = '';
    const help = values.formaPagamento === 'UNICO' ? 'Valor TOTAL do contrato (uma cobrança só). Use o formato brasileiro, como 1.500,00.' : values.formaPagamento === 'RECORRENTE' ? 'Valor de CADA cobrança (a cada período). O total do contrato é calculado abaixo. Use o formato brasileiro, como 1.500,00.' : 'Em reais, no formato brasileiro, como 1.500,00. Escolha a forma de pagamento para ver o que o valor significa.';
    valueHelp.textContent = help;
  }
  // o parágrafo de ajuda do campo de valor (o texto muda com a forma de pagamento escolhida)
  const valueHelp = findHelp(controls.valorNegociado.element);
  function findHelp(root) {
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      for (const child of node.childNodes || []) {
        if (child.nodeType !== 1) continue;
        if (child.getAttribute && child.getAttribute('id') === `${idOf('valorNegociado')}-help`) return child;
        stack.push(child);
      }
    }
    return null;
  }

  function paintPreview() {
    const values = currentValues();
    const money = parseMoney(values.valorNegociado);
    const term = parseTerm(values.prazoMeses);
    const ready = values.formaPagamento !== '' && money.ok && money.value !== null && term.ok;
    const children = [];
    if (!ready) {
      children.push(el('p', { className: 'muted', text: 'Preencha a forma de pagamento, o prazo e o valor para ver o total do contrato (TCV) e o cronograma.' }));
    } else {
      const finance = previewFinance({ formaPagamento: values.formaPagamento, periodicidade: values.formaPagamento === 'RECORRENTE' ? values.periodicidade || null : null, prazoMeses: term.value, valorNegociado: money.value });
      if (!finance.ok) {
        children.push(el('p', { className: 'message warn', text: fieldMessage(finance.code === 'PRAZO_NAO_MULTIPLO_DA_PERIODICIDADE' || finance.code === 'PRAZO_INVALIDO' ? 'prazoMeses' : finance.code === 'VALOR_INVALIDO' ? 'valorNegociado' : 'periodicidade', finance.code) }));
      } else {
        children.push(
          el('p', { className: 'negotiation-preview-title', text: 'Prévia do contrato (nada é salvo por aqui)' }),
          el('dl', { className: 'fields negotiation-preview-fields' },
            el('dt', { text: 'TCV (valor total do contrato)' }), el('dd', { text: formatMoney(finance.tcv) }),
            ...(finance.mrr !== null ? [el('dt', { text: 'MRR (receita recorrente mensal)' }), el('dd', { text: formatMoney(finance.mrr) })] : []),
            ...(finance.equivalenteMensal !== null && finance.mrr === null ? [el('dt', { text: 'Equivalente mensal' }), el('dd', { text: `${formatMoney(finance.equivalenteMensal)} (comparação; não é o que entra no caixa)` })] : []),
            el('dt', { text: 'Cronograma' }), el('dd', { text: scheduleText(finance.cronograma) })
          )
        );
      }
    }
    preview.replaceChildren(...children);
  }

  // ---- mensagens e erros ----
  const messageRegion = el('div', { className: 'form-messages' });
  function setMessage(kind, text) {
    messageRegion.replaceChildren(...(text ? [el('p', { className: `message ${kind === 'warning' ? 'warn' : kind}`, role: kind === 'error' ? 'alert' : 'status', text })] : []));
  }
  function clearErrors() {
    for (const field of FIELD_ORDER) if (controls[field]) controls[field].setError(null);
    setMessage('info', null);
  }
  // mostra os erros por campo; devolve o primeiro campo (na ordem da tela) para o foco
  function showFieldErrors(errors) {
    let first = null;
    for (const field of FIELD_ORDER) {
      if (!controls[field] || !Object.prototype.hasOwnProperty.call(errors, field)) continue;
      controls[field].setError(errors[field]);
      if (first === null) first = field;
    }
    if (first !== null) controls[first].focus();
    return first;
  }

  // ---- reações ----
  function onAnyChange() {
    syncPayment();
    paintPreview();
  }
  serviceControl.addEventListener('change', () => {
    controls.serviceId.setError(null);
    syncService();
    controls.formaPagamento.setError(null);
    controls.periodicidade.setError(null);
    onAnyChange();
  });
  clientControl.addEventListener('change', () => controls.crmRecordId.setError(null));
  funnelControl.addEventListener('change', () => controls.funnelId.setError(null));
  for (const row of paymentRows) row.input.addEventListener('change', () => { controls.formaPagamento.setError(null); controls.periodicidade.setError(null); onAnyChange(); });
  for (const row of termRows) {
    row.input.addEventListener('change', () => {
      const chosen = termRows.find((entry) => entry.input.checked);
      termInputWrap.hidden = !chosen || chosen.value !== 'outro';
      controls.prazoMeses.setError(null);
      if (!termInputWrap.hidden) termInput.focus();
      onAnyChange();
    });
  }
  termInput.addEventListener('input', () => { controls.prazoMeses.setError(null); onAnyChange(); });
  periodicityControl.addEventListener('change', () => { controls.periodicidade.setError(null); onAnyChange(); });
  valueControl.addEventListener('input', () => { controls.valorNegociado.setError(null); onAnyChange(); });
  dateControl.addEventListener('change', () => controls.previsaoFechamento.setError(null));

  // ---- salvar ----
  const saveButton = el('button', { type: 'button', className: 'btn primary', 'data-action': 'save', text: 'Salvar', onclick: () => submit() });
  const cancelButton = el('button', { type: 'button', className: 'btn secondary', 'data-action': 'cancel', text: 'Cancelar', onclick: () => onCancel() });
  function setBusy(value) {
    busy = Boolean(value);
    saveButton.disabled = busy;
    cancelButton.disabled = busy;
    saveButton.textContent = busy ? 'Salvando…' : 'Salvar';
    for (const control of [clientControl, funnelControl, serviceControl, periodicityControl, valueControl, dateControl, termInput, ...paymentRows.map((row) => row.input), ...termRows.map((row) => row.input)]) {
      if (mode === 'edit' && (control === clientControl || control === funnelControl)) continue;
      control.disabled = busy;
    }
    if (!busy) syncService();
    element.setAttribute('aria-busy', busy ? 'true' : 'false');
    onBusy(busy);
  }

  async function submit() {
    if (busy) return;
    clearErrors();
    const values = currentValues();
    const facts = factsOf(values.serviceId);
    const prepared = mode === 'create' ? buildCreateBody(values, { service: facts }) : buildPatchBody(initial, values, { service: facts });
    if (mode === 'edit' && prepared.ok && prepared.empty) {
      setMessage('info', 'Nenhuma alteração foi feita.');
      return;
    }
    if (!prepared.ok) {
      showFieldErrors(prepared.errors);
      setMessage('error', MESSAGES.validation);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(prepared.body);
    } catch (error) {
      setBusy(false);
      const info = negotiationErrorInfo(error);
      if (info === null) return; // a sessão acabou: o fluxo de login cuida
      const first = showFieldErrors(info.fields || {});
      setMessage('error', info.message);
      if (first === null) saveButton.focus();
    }
  }

  // ---- montagem ----
  const element = el(
    'form',
    { className: 'catalog-form negotiation-form', novalidate: 'novalidate', onsubmit: (event) => { event.preventDefault(); submit(); } },
    messageRegion,
    el('p', { className: 'muted required-note', text: 'Os campos marcados com * são obrigatórios.' }),
    controls.crmRecordId.element,
    controls.funnelId.element,
    controls.serviceId.element,
    paymentGroup,
    controls.periodicidade.element,
    termGroup,
    controls.valorNegociado.element,
    preview,
    controls.previsaoFechamento.element
  );
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.defaultPrevented) return;
    const target = event.target;
    if (target && target.localName === 'input' && target.type !== 'radio') {
      event.preventDefault();
      submit();
    }
  });
  const chosenTerm = termRows.find((row) => row.input.checked);
  termInputWrap.hidden = !chosenTerm || chosenTerm.value !== 'outro';
  syncService();
  syncPayment();
  paintPreview();

  return {
    element,
    footer: el('div', { className: 'drawer-actions catalog-form-actions' }, cancelButton, saveButton),
    isDirty: () => JSON.stringify(currentValues()) !== JSON.stringify(baseline),
    discard() {
      baseline = currentValues();
    },
    initialFocus: () => (mode === 'edit' ? serviceControl : clientControl),
    setBusy,
    get busy() {
      return busy;
    },
    values: currentValues,
  };
}
