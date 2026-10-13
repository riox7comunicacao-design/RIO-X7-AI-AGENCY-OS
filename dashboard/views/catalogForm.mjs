// O FORMULÁRIO de um item de catálogo (CRM 5.0, Fase 2B-2): criar ou editar um Serviço, um Nicho ou uma Origem dos Leads, dentro do painel lateral da tela do catálogo.
//
// O QUE ELE FAZ: monta os campos REAIS do contrato do servidor (nome e descrição em todos; categoria, preço de referência, tipo de cobrança e recorrência nos serviços; cor nos nichos; canal nas
// origens), guarda o que foi digitado, diz se há alteração não salva (isDirty — o gerenciador de camadas usa isso no ESC/X/fundo) e, ao salvar, entrega ao dono da tela o corpo da requisição.
// Só o que muda vai na edição. Os erros do servidor aparecem junto do campo certo e o que foi digitado NUNCA é apagado por uma falha.
//
// O QUE ELE NÃO FAZ: regra de negócio. Nome único (mesmo desativado), nome em uso pelo CRM, coerência de cobrança e limites são do servidor (que sempre tem a palavra final); aqui só há as
// conferências que poupam uma ida ao servidor à toa (nome preenchido, preço em reais, nicho novo com cor). Sucesso só existe depois que a API confirma: quem mostra "salvo" é o dono da tela.
//
// Todo texto entra por dom.mjs (textContent); nenhum estilo inline. A cor de um nicho vem da paleta aprovada (catalog-colors.mjs) e é aplicada por CLASSE de CSS.

import { h, fill } from '../dom.mjs';
import { formatDateTime, textOf } from '../format.mjs';
import { formField } from '../ui/components.mjs';
import { colorPicker } from '../ui/colorPicker.mjs';
import { NICHE_COLOR_OPTIONS, colorClassOf, colorNameOf } from '../catalog-colors.mjs';
import { BILLING_OPTIONS, CHANNEL_OPTIONS, LIMITS, MESSAGES, RECURRENCE_OPTIONS, buildCreateBody, buildPatchBody, catalogErrorInfo, changedFields, emptyFormValues, formValuesFromItem } from '../catalog-model.mjs';

// Os textos de cada catálogo (o que a pessoa lê nos campos).
const FORM_TEXT = Object.freeze({
  servicos: Object.freeze({
    singular: 'serviço',
    nameLabel: 'Nome do serviço',
    namePlaceholder: 'Ex.: Gestão de redes sociais',
    nameHelp: 'Como o serviço aparece nas listas. Não pode repetir o nome de outro serviço, mesmo desativado.',
    descriptionHelp: 'Opcional. O que está incluído neste serviço (até 500 caracteres).',
  }),
  nichos: Object.freeze({
    singular: 'nicho',
    nameLabel: 'Nome do nicho',
    namePlaceholder: 'Ex.: Clínicas de estética',
    nameHelp: 'O nome do nicho sempre aparece junto da cor. Não pode repetir o nome de outro nicho, mesmo desativado.',
    descriptionHelp: 'Opcional. Uma explicação curta sobre este nicho (até 500 caracteres).',
  }),
  origens: Object.freeze({
    singular: 'origem',
    nameLabel: 'Nome da origem',
    namePlaceholder: 'Ex.: Indicação de cliente',
    nameHelp: 'De onde o lead chegou. Não pode repetir o nome de outra origem, mesmo desativada. Cadastrar uma origem não ativa nenhuma integração.',
    descriptionHelp: 'Opcional. Como esta origem deve ser entendida pela equipe (até 500 caracteres).',
  }),
});

const NO_COLOR_MESSAGE = 'Escolha uma das 20 cores para identificar o nicho.';

// catalog: 'servicos' | 'nichos' | 'origens'. mode: 'create' | 'edit'. item: o item atual (edição). onSubmit(body) -> Promise: o dono da tela grava, confirma e fecha o painel; se rejeitar,
// o formulário mostra o erro e continua aberto. onBusy(bool): o dono avisa o gerenciador de camadas (um painel salvando não fecha por ESC/X). onCancel(): fecha pelo caminho normal (pergunta antes
// se houver alteração).
//
// DISPONIBILIDADE: quando o servidor confirma que os cadastros estão indisponíveis (503), a tela dona chama setAvailability({ unavailable: true }): o formulário mostra o aviso (com o que foi
// digitado mantido), DESABILITA o Salvar e não envia nada — nem por Enter. "Verificar novamente" (onRecheck) pede à tela dona que tente carregar de novo. Uma falha de REDE não é isso: o Salvar
// continua habilitado e a pessoa pode tentar de novo.
export function createCatalogForm({ document, catalog, mode, item = null, onSubmit, onBusy = () => {}, onCancel = () => {}, onUnavailable = () => {}, onRecheck = () => {} }) {
  const text = FORM_TEXT[catalog];
  const initial = mode === 'edit' ? formValuesFromItem(catalog, item) : emptyFormValues(catalog);
  const idOf = (field) => `catalog-field-${field}`;
  let busy = false;
  let unavailable = false;
  let checking = false;
  let nameLocked = false;
  let baseline = initial; // o ponto de partida da PROTEÇÃO (não o do envio): descartar de propósito o reajusta ao que está na tela

  const controls = {}; // campo -> { setError, setHidden, element, control, read(), put(v), focus() }

  function textInput(field, { maxlength, placeholder = '', inputmode = null }) {
    const input = h(document, 'input', { id: idOf(field), type: 'text', maxlength: String(maxlength), autocomplete: 'off', ...(placeholder ? { placeholder } : {}), ...(inputmode ? { inputmode } : {}), value: initial[field] || '' });
    input.value = initial[field] || '';
    return input;
  }
  function selectInput(field, emptyLabel, options) {
    const select = h(document, 'select', { id: idOf(field) }, h(document, 'option', { value: '', text: emptyLabel }), ...options.map((entry) => h(document, 'option', { value: entry.value, text: entry.label })));
    select.value = initial[field] || '';
    return select;
  }
  function register(field, spec) {
    const wrapper = formField(document, { id: idOf(field), label: spec.label, control: spec.control, help: spec.help || '', required: Boolean(spec.required) });
    controls[field] = { ...wrapper, read: () => String(spec.control.value || ''), put: (value) => { spec.control.value = value; }, focus: () => spec.control.focus() };
    return controls[field];
  }

  // --- os campos (a ordem é a da tela) ---
  register('nome', { label: text.nameLabel, control: textInput('nome', { maxlength: LIMITS.NOME, placeholder: text.namePlaceholder }), help: text.nameHelp, required: true });
  const descriptionControl = h(document, 'textarea', { id: idOf('descricao'), rows: '3', maxlength: String(LIMITS.DESCRICAO) });
  descriptionControl.value = initial.descricao || '';
  register('descricao', { label: 'Descrição', control: descriptionControl, help: text.descriptionHelp });

  const previewNote = h(document, 'p', { className: 'muted preview-note', 'aria-live': 'polite' });
  let picker = null;
  let previewCard = null;
  let previewChip = null;
  let previewName = null;

  if (catalog === 'servicos') {
    register('categoria', { label: 'Categoria', control: textInput('categoria', { maxlength: LIMITS.CATEGORIA, placeholder: 'Ex.: Marketing digital' }), help: 'Opcional. Agrupa serviços parecidos.' });
    register('precoReferencia', {
      label: 'Preço de referência (R$)',
      control: textInput('precoReferencia', { maxlength: 18, placeholder: '0,00', inputmode: 'decimal' }),
      help: 'Opcional e apenas informativo: não altera propostas nem negociações. Use o formato brasileiro, como 1.500,00.',
    });
    register('tipoCobranca', { label: 'Tipo de cobrança', control: selectInput('tipoCobranca', 'Não informado', BILLING_OPTIONS), help: 'Opcional. Pagamento único ou cobrança recorrente.' });
    register('recorrencia', { label: 'Recorrência', control: selectInput('recorrencia', 'Escolha a recorrência', RECURRENCE_OPTIONS), help: 'De quanto em quanto tempo a cobrança se repete.', required: true });
  } else if (catalog === 'nichos') {
    picker = colorPicker(document, {
      id: 'catalog-field-cor',
      label: 'Cor do nicho',
      options: NICHE_COLOR_OPTIONS,
      value: initial.cor || '',
      required: mode === 'create',
      help: mode === 'create' ? 'Escolha uma das 20 cores. Ela identifica o nicho nos cartões e nas listas.' : 'Escolha outra cor para trocar a atual. Ela identifica o nicho nos cartões e nas listas.',
      onChange: () => {
        picker.setError(null);
        paintPreview();
      },
    });
    controls.cor = { element: picker.element, setError: (message) => picker.setError(message), setHidden: (value) => { picker.element.hidden = Boolean(value); }, read: () => picker.value, put: (value) => picker.setValue(value), focus: () => picker.focus() };
    previewName = h(document, 'span', { className: 'preview-nicho-name' });
    previewChip = h(document, 'span', { className: 'nicho-chip' }, previewName);
    previewCard = h(
      document,
      'div',
      { className: 'preview-card' },
      h(document, 'span', { className: 'preview-line muted', text: 'Cartão de negociação (só a aparência)' }),
      h(document, 'strong', { className: 'preview-title', text: 'Nome da empresa' }),
      previewChip
    );
  } else {
    register('canal', { label: 'Canal', control: selectInput('canal', 'Não classificado', CHANNEL_OPTIONS), help: 'Opcional. Como esta origem chega até a agência.' });
  }

  // --- a recorrência só existe para a cobrança recorrente ---
  function syncRecurrence() {
    if (catalog !== 'servicos') return;
    const recurrent = controls.tipoCobranca.read() === 'RECORRENTE';
    controls.recorrencia.setHidden(!recurrent);
    if (!recurrent) {
      controls.recorrencia.put('');
      controls.recorrencia.setError(null);
    }
  }

  function paintPreview() {
    if (!previewCard) return;
    const chave = picker ? picker.value : '';
    previewCard.className = `preview-card ${colorClassOf(chave)}`.trim();
    previewChip.className = `nicho-chip ${colorClassOf(chave)}`.trim();
    const name = controls.nome.read().replace(/\s+/g, ' ').trim();
    previewName.textContent = name !== '' ? name : 'Nome do nicho';
    previewCard.setAttribute('data-color', chave);
    previewNote.textContent = chave !== '' ? `Cor escolhida: ${colorNameOf(chave)}.` : 'Nenhuma cor escolhida ainda.';
  }

  // --- mensagens do formulário ---
  const messageRegion = h(document, 'div', { className: 'form-messages' });
  const availabilityRegion = h(document, 'div', { className: 'form-availability' });
  const usageRegion = h(document, 'div', { className: 'form-usage' });
  function setMessage(kind, content) {
    fill(messageRegion, content ? h(document, 'p', { className: `message ${kind}`, role: kind === 'error' ? 'alert' : 'status', text: content }) : null);
  }

  function clearErrors() {
    for (const field of Object.keys(controls)) controls[field].setError(null);
    setMessage('error', null);
  }

  // Mostra os erros de campo e leva o foco ao primeiro campo com erro (na ordem da tela).
  function showFieldErrors(errors) {
    let first = null;
    for (const field of Object.keys(controls)) {
      if (Object.prototype.hasOwnProperty.call(errors, field)) {
        controls[field].setError(errors[field]);
        if (first === null) first = field;
      }
    }
    if (first !== null) controls[first].focus();
    return first;
  }

  // --- o ponto de partida e a alteração não salva ---
  function values() {
    const out = { ...emptyFormValues(catalog) };
    for (const field of Object.keys(out)) if (controls[field]) out[field] = controls[field].read();
    return out;
  }
  const isDirty = () => changedFields(catalog, baseline, values()).length > 0;

  // --- salvar ---
  const saveButton = h(document, 'button', { type: 'button', className: 'btn primary', 'data-action': 'save', text: 'Salvar', onclick: () => submit() });
  const cancelButton = h(document, 'button', { type: 'button', className: 'btn secondary', 'data-action': 'cancel', text: 'Cancelar', onclick: () => onCancel() });

  // o Salvar só fica habilitado se não há envio em andamento e a indisponibilidade NÃO está confirmada
  const refreshSave = () => {
    saveButton.disabled = busy || unavailable;
  };

  function paintAvailability() {
    const kept = mode === 'create' || isDirty() ? MESSAGES.draftKept : '';
    fill(
      availabilityRegion,
      unavailable
        ? h(
            document,
            'div',
            { className: 'catalog-unavailable' },
            h(document, 'p', { className: 'message error', role: 'alert', text: `${MESSAGES.unavailable} ${MESSAGES.writesPaused} ${kept}`.trim() }),
            h(document, 'button', { type: 'button', className: 'btn secondary', 'data-action': 'recheck', disabled: checking, text: checking ? 'Verificando…' : 'Verificar novamente', onclick: () => onRecheck() })
          )
        : null
    );
  }

  function setAvailability({ unavailable: value, checking: isChecking = false } = {}) {
    unavailable = Boolean(value);
    checking = Boolean(isChecking);
    if (unavailable) setMessage('error', null); // o aviso de indisponibilidade tem o seu lugar; não repete o erro da tentativa
    paintAvailability();
    refreshSave();
  }

  function setBusy(value) {
    busy = Boolean(value);
    refreshSave();
    cancelButton.disabled = busy;
    saveButton.textContent = busy ? 'Salvando…' : 'Salvar';
    for (const field of Object.keys(controls)) {
      const control = controls[field].control;
      if (control) control.disabled = busy || (field === 'nome' && nameLocked);
    }
    if (picker) picker.setDisabled(busy);
    element.setAttribute('aria-busy', busy ? 'true' : 'false');
    onBusy(busy);
  }

  async function submit() {
    if (busy) return;
    // indisponibilidade confirmada: NADA é enviado (nem por Enter); o aviso já está na tela
    if (unavailable) {
      paintAvailability();
      return;
    }
    clearErrors();
    const current = values();
    let prepared;
    if (mode === 'create') {
      prepared = buildCreateBody(catalog, current);
      if (catalog === 'nichos' && current.cor === '') {
        prepared.errors.cor = NO_COLOR_MESSAGE;
        prepared.ok = false;
      }
    } else {
      prepared = buildPatchBody(catalog, initial, current);
      if (prepared.ok && prepared.empty) {
        setMessage('info', MESSAGES.nothingToChange);
        return;
      }
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
      const info = catalogErrorInfo(error);
      if (info === null) return; // a sessão acabou: o fluxo de login cuida
      if (info.kind === 'unavailable') {
        // confirmado pelo servidor: avisa a tela dona (que pausa as gravações) e mantém o rascunho
        setAvailability({ unavailable: true });
        onUnavailable(info);
        return;
      }
      showError(info);
    }
  }

  // Mostra um erro do servidor: o texto geral e, perto dos campos, as mensagens de cada um. O que foi digitado fica.
  function showError(info) {
    const first = showFieldErrors(info.fields || {});
    setMessage('error', info.message);
    if (first === null) saveButton.focus();
  }

  const requiredNote = h(document, 'p', { className: 'muted required-note', text: 'Os campos marcados com * são obrigatórios.' });
  const auditLine = mode === 'edit' && item ? auditNode() : null;

  function auditNode() {
    const created = formatDateTime(item.criadoEm);
    const updated = formatDateTime(item.atualizadoEm);
    const parts = [];
    if (created) parts.push(`Criado em ${created}${textOf(item.criadoPorNome) ? ` por ${textOf(item.criadoPorNome)}` : ''}.`);
    if (updated) parts.push(`Última alteração em ${updated}${textOf(item.atualizadoPorNome) ? ` por ${textOf(item.atualizadoPorNome)}` : ''}.`);
    return parts.length > 0 ? h(document, 'p', { className: 'muted audit-line', text: parts.join(' ') }) : null;
  }

  const inactiveNotice = mode === 'edit' && item && item.ativo !== true ? h(document, 'p', { className: 'message info', role: 'status', text: `Este ${text.singular} está desativado e não aparece nas listas de escolha. Para voltar a usá-lo, reative-o na lista.` }) : null;

  const element = h(
    document,
    'form',
    { className: 'catalog-form', id: `catalog-form-${catalog}`, novalidate: 'novalidate', 'aria-label': mode === 'edit' ? `Editar ${text.singular}` : `Novo ${text.singular}`, onsubmit: (event) => event.preventDefault() },
    messageRegion,
    availabilityRegion,
    inactiveNotice,
    requiredNote,
    controls.nome.element,
    usageRegion,
    controls.descricao.element,
    ...(catalog === 'servicos' ? [controls.categoria.element, controls.precoReferencia.element, controls.tipoCobranca.element, controls.recorrencia.element] : []),
    ...(catalog === 'nichos' ? [controls.cor.element, h(document, 'div', { className: 'niche-preview' }, h(document, 'p', { className: 'field-label', text: 'Prévia' }), previewCard, previewNote)] : []),
    ...(catalog === 'origens' ? [controls.canal.element] : []),
    auditLine
  );

  // Enter num campo de uma linha salva (num texto de várias linhas ou numa lista, não); o botão Salvar continua sendo o caminho explícito.
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.defaultPrevented) return;
    const target = event.target;
    if (target && target.localName === 'input') {
      event.preventDefault();
      submit();
    }
  });
  controls.tipoCobranca && controls.tipoCobranca.control.addEventListener('change', () => syncRecurrence());
  if (previewCard) controls.nome.control.addEventListener('input', () => paintPreview());
  syncRecurrence();
  paintPreview();

  // Quanto o CRM já usa este item (só na edição, depois de o servidor responder): em uso, o nome não pode mudar nesta fase — a tela explica e trava o campo.
  function setUsage(count) {
    if (mode !== 'edit') return;
    if (Number.isInteger(count) && count > 0) {
      nameLocked = true;
      controls.nome.put(initial.nome);
      controls.nome.control.readOnly = true;
      controls.nome.control.setAttribute('readonly', 'readonly');
      fill(usageRegion, h(document, 'p', { className: 'message info usage-note', role: 'status', text: `Este ${text.singular} é usado em ${count} ${count === 1 ? 'registro' : 'registros'} do CRM. Por isso o nome não pode ser alterado nesta fase; as demais informações podem ser editadas.` }));
      paintPreview();
    } else {
      fill(usageRegion);
    }
  }

  return {
    element,
    footer: h(document, 'div', { className: 'drawer-actions catalog-form-actions' }, cancelButton, saveButton),
    isDirty,
    // A alteração foi descartada de propósito (ou já foi salva): o que está na tela deixa de contar como "alteração não salva". Se a pessoa continuar digitando, a proteção volta a valer.
    // O corpo de um envio continua sendo calculado contra o item ORIGINAL, não contra este ponto.
    discard() {
      baseline = values();
    },
    get busy() {
      return busy;
    },
    setBusy,
    setAvailability,
    get unavailable() {
      return unavailable;
    },
    setUsage,
    showError,
    values,
    submit,
    focusFirst: () => controls.nome.focus(),
    initialFocus: () => controls.nome.control,
    colorPicker: picker,
    control: (field) => (controls[field] ? controls[field].control || null : null),
    saveButton,
    cancelButton,
  };
}
