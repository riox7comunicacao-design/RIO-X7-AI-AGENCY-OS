// Campo de SELEÇÃO ASSISTIDA de um catálogo (CRM 5.0, Fase 2B-3.1) — usado pelos formulários Novo registro e Editar registro para Nicho, Origem e Serviço potencial.
//
//   [ lista de opções oficiais ]     quando o catálogo tem itens ativos
//   [ texto livre ]                  quando o catálogo está vazio, indisponível (503), falhou por rede ou ainda carrega — o CRM NUNCA fica bloqueado por causa do catálogo
//
// O VALOR É SEMPRE TEXTO. O registro continua guardando o NOME (os 31 campos e a API não mudam): escolher um item grava o nome oficial dele como texto; "Informar outro valor"
// (só para quem administra os catálogos) grava o texto digitado — sem criar item nenhum. O campo expõe um `control` com `value` (o texto de agora), `focus`, `setAttribute`,
// `removeAttribute` e `addEventListener`, então o formulário o trata como o campo de texto de sempre (ler, validar, comparar com o valor com que abriu, enviar só o que mudou).
//
// VALOR JÁ SALVO (legado): aparece EXATAMENTE como está, como uma opção própria e já escolhida — "fora do catálogo", "grafia diferente da oficial" (com a ação explícita
// "Usar a grafia oficial") ou "desativado" (só quando a API autorizada confirma). Nada é normalizado nem trocado sozinho: o texto só muda quando a pessoa escolhe outra coisa.
//
// RESPOSTA TARDIA: quando as opções chegam depois de a pessoa já ter digitado, o texto digitado vira o valor atual (opção "fora do catálogo"); nada é apagado nem escolhido por ela.
// E se a pessoa está com o foco no campo, a troca de texto livre para lista (ou a releitura das opções) espera ela sair do campo — o campo nunca muda debaixo das mãos.
//
// AVISO COMPARTILHADO (createCatalogNotice): quando os TRÊS catálogos falham pelo MESMO motivo (estrutura indisponível, falha de rede ou outro erro), os três campos não repetem o mesmo aviso: um só aviso,
// no início do formulário, diz que os campos seguem disponíveis para preenchimento manual e oferece "Verificar novamente" (uma leitura por catálogo). Quando falham só um ou dois, ou por motivos
// diferentes, cada campo mantém o seu aviso específico. Catálogo VAZIO nunca entra no aviso compartilhado (cada cadastro tem o seu atalho).
//
// SEGURANÇA: tudo entra no DOM por dom.mjs (textContent, setAttribute). Nenhum HTML, nenhum estilo inline.

import { h, fill } from '../dom.mjs';
import { CATALOG_KEYS, CATALOG_TITLES, STATUS, classifyValue } from '../crm-catalog-lookup.mjs';

export const OPTION_TEXT = Object.freeze({
  none: 'Nenhum (deixar em branco)',
  other: 'Informar outro valor',
});

// Os avisos de UM campo são curtos de propósito: um aviso comprido deixa a coluna do formulário mais alta que as vizinhas.
export const FIELD_TEXT = Object.freeze({
  outside: 'Fora do catálogo: valor mantido como está.',
  differentSpelling: (official) => `Grafia diferente da oficial ("${official}"). O valor só muda se você usar a grafia oficial.`,
  inactive: 'Desativado no cadastro: valor mantido, mas não oferecido para novas escolhas.',
  other: 'Valor só deste registro: não é criado no cadastro.',
  empty: 'Cadastro sem itens ativos: digite o valor livremente por enquanto.',
  unavailable: 'Opções oficiais indisponíveis neste ambiente. Digite o valor livremente; o registro é salvo normalmente.',
  network: 'Falha temporária de conexão ao carregar as opções. Digite o valor livremente; o registro é salvo normalmente.',
  error: 'Não foi possível carregar as opções agora. Digite o valor livremente; o registro é salvo normalmente.',
  currentValue: (value) => `Valor atual: "${value}"`,
  useOfficial: 'Usar a grafia oficial',
  retry: 'Tentar novamente',
  refresh: 'Atualizar opções',
  checking: 'Verificando as opções oficiais…',
  openCatalog: (title) => `Abrir o cadastro de ${title}`,
});

// O aviso COMPARTILHADO (os três catálogos falharam pelo mesmo motivo). `labels` são os nomes dos campos, na ordem do formulário.
export const NOTICE_TEXT = Object.freeze({
  [STATUS.UNAVAILABLE]: 'Os cadastros estão indisponíveis neste ambiente, então as opções oficiais não foram carregadas.',
  [STATUS.NETWORK]: 'Falha temporária de conexão ao carregar as opções oficiais.',
  [STATUS.ERROR]: 'Não foi possível carregar as opções oficiais agora.',
  manual: (labels) => `${labels} continuam disponíveis para preenchimento manual, e o registro pode ser salvo normalmente.`,
  checking: 'Verificando as opções oficiais…',
  recheck: 'Verificar novamente',
});

const FAILING = new Set([STATUS.UNAVAILABLE, STATUS.NETWORK, STATUS.ERROR]);
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
const ITEM_PREFIX = 'item:';
const joinLabels = (labels) => (labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`);

let noticeCount = 0;

// O aviso único do formulário. lookup: createCatalogLookup. labels: ['Nicho', 'Origem do Lead', 'Serviço potencial']. onRecovered(): chamado quando a pessoa acionou "Verificar novamente" com o foco
// no botão e o aviso saiu de cena (volta o foco para o primeiro campo). Devolve { element, shared(), checking(), onChange(fn), destroy() }; `shared()` é o motivo comum (unavailable | network | error) ou null.
export function createCatalogNotice(document, { lookup, labels, onRecovered = () => {} }) {
  noticeCount += 1;
  const element = h(document, 'div', { className: 'catalog-notice', id: `crm-catalog-notice-${noticeCount}`, role: 'status', hidden: true });
  const manual = NOTICE_TEXT.manual(joinLabels(labels));
  let checking = false;
  let disposed = false;
  const listeners = [];

  // O motivo COMUM aos três catálogos, ou null (qualquer outra combinação — um ou dois falhos, motivos diferentes, vazio, carregando — não é compartilhada).
  function sharedKind() {
    const statuses = CATALOG_KEYS.map((key) => lookup.peek(key).status);
    return FAILING.has(statuses[0]) && statuses.every((status) => status === statuses[0]) ? statuses[0] : null;
  }

  const notifyFields = () => {
    for (const listener of [...listeners]) listener();
  };

  function render() {
    const kind = sharedKind();
    if (!checking && kind === null) {
      fill(element);
      element.hidden = true;
      element.removeAttribute('data-kind');
      return;
    }
    fill(
      element,
      h(document, 'span', { className: 'catalog-notice-message', text: checking ? NOTICE_TEXT.checking : `${NOTICE_TEXT[kind]} ${manual}` }),
      h(document, 'button', { type: 'button', className: 'btn secondary small', text: NOTICE_TEXT.recheck, disabled: checking, onclick: recheck })
    );
    element.hidden = false;
    element.setAttribute('data-kind', checking ? 'checking' : kind);
  }

  // "Verificar novamente": UMA leitura por catálogo (as simultâneas viram uma só); nada do que foi digitado é tocado — os campos recebem o resultado pelas próprias assinaturas.
  async function recheck() {
    if (checking || disposed) return;
    const hadFocus = Boolean(document.activeElement) && element.contains(document.activeElement);
    checking = true;
    render();
    notifyFields();
    await Promise.all(CATALOG_KEYS.map((key) => lookup.ensure(key, { force: true })));
    checking = false;
    if (disposed) return;
    render();
    notifyFields();
    if (!hadFocus) return;
    const button = Array.from(element.children).find((child) => child.localName === 'button');
    if (!element.hidden && button) button.focus();
    else onRecovered();
  }

  const unsubscribers = CATALOG_KEYS.map((key) =>
    lookup.subscribe(key, () => {
      if (disposed) return;
      render();
      notifyFields();
    })
  );
  render();

  return {
    element,
    shared: sharedKind,
    checking: () => checking,
    onChange(listener) {
      listeners.push(listener);
    },
    destroy() {
      disposed = true;
      listeners.length = 0;
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}

// document: o do navegador (ou de teste). Opções:
//   id         o id do campo de TEXTO (o mesmo de sempre, ex.: crm-field-nicho); o da lista é `${id}-select`
//   name       o nome do campo do CRM (nicho, origem, servicoPotencial)
//   catalog    servicos | nichos | origens
//   value      o texto já salvo ('' num registro novo)
//   lookup     createCatalogLookup(...) (lookup.canManage decide se "Informar outro valor" existe)
//   label      o <label> do campo: o `for` acompanha o controle que está à mostra
//   listId     o <datalist> de sugestões do texto livre (os valores que o CRM já tem), se houver
//   maxLength  limite do texto livre (o mesmo do campo de sempre)
//   adminLink  o endereço do cadastro (só para quem administra) ou null
//   notice     o aviso compartilhado do formulário (createCatalogNotice) ou null: quando ele cobre a falha, o campo não repete o aviso
export function createCatalogField(document, { id, name, catalog, value = '', lookup, label = null, listId = null, maxLength = '500', adminLink = null, notice = null }) {
  const selectId = `${id}-select`;
  const noteId = `${id}-note`;
  const canOther = Boolean(lookup && lookup.canManage);
  const labelText = () => (label ? trimmed(label.textContent) : '');

  const textInput = h(document, 'input', { id, name, type: 'text', maxlength: maxLength, autocomplete: 'off', list: listId, value: typeof value === 'string' ? value : '' });
  const select = h(document, 'select', { id: selectId, className: 'catalog-field-select', hidden: true });
  const note = h(document, 'div', { className: 'catalog-field-note', id: noteId, 'aria-live': 'polite' });
  const element = h(document, 'div', { className: 'catalog-field', 'data-catalog': catalog }, select, textInput, note);
  for (const control of [select, textInput]) control.setAttribute('aria-describedby', [noteId, notice ? notice.element.id : '', `${id}-error`].filter(Boolean).join(' '));

  // --- estado -------------------------------------------------------------
  let view = 'text'; // o que está à mostra: 'text' (texto livre) ou 'select' (lista)
  let baseline = trimmed(value); // o texto "de antes": o salvo no registro (ou o digitado antes de as opções chegarem)
  let choice = { kind: 'none' }; // na lista: none | legacy | item { id, name } | other
  let latest = lookup.peek(catalog);
  let pendingApply = false;
  let retrying = false;
  let disposed = false;
  const external = []; // os ouvintes do formulário (para avisar uma mudança que a pessoa fez pela ação "Usar a grafia oficial")

  const isEditing = () => document.activeElement === textInput || document.activeElement === select;
  const primary = () => (view === 'select' ? select : textInput);

  // O texto de agora — o que o formulário lê, valida e envia.
  function currentText() {
    if (view === 'text') return String(textInput.value === undefined || textInput.value === null ? '' : textInput.value);
    if (choice.kind === 'none') return '';
    if (choice.kind === 'legacy') return baseline;
    if (choice.kind === 'item') return choice.name;
    return String(textInput.value === undefined || textInput.value === null ? '' : textInput.value); // other
  }

  const encode = (current) => (current.kind === 'item' ? `${ITEM_PREFIX}${current.id}` : current.kind);

  function initialChoice(text, items) {
    const found = classifyValue(text, items);
    if (found.kind === 'empty') return { kind: 'none' };
    if (found.kind === 'official') return { kind: 'item', id: found.item.id, name: found.item.nome };
    return { kind: 'legacy' };
  }

  // O que a pessoa tinha escolhido continua valendo depois de uma releitura das opções (nunca é trocado por outra coisa).
  function reconcileChoice(items) {
    if (choice.kind === 'item') {
      const still = items.find((item) => item.id === choice.id && item.ativo);
      if (still) choice = { kind: 'item', id: still.id, name: still.nome };
      else {
        // o item deixou de ser oferecido: o texto escolhido vira o valor atual (como um valor de antes), sem sumir
        baseline = choice.name;
        choice = { kind: 'legacy' };
      }
    } else if (choice.kind === 'legacy') {
      const found = classifyValue(baseline, items);
      if (found.kind === 'official') choice = { kind: 'item', id: found.item.id, name: found.item.nome };
    }
  }

  function legacyLabel(found) {
    if (found.kind === 'different-spelling') return `${baseline} — grafia diferente`;
    if (found.kind === 'inactive') return `${baseline} — desativado`;
    return `${baseline} — fora do catálogo`;
  }

  function paintSelect() {
    const found = classifyValue(baseline, latest.items);
    const options = [h(document, 'option', { value: 'none', text: OPTION_TEXT.none })];
    if (baseline !== '' && found.kind !== 'official') options.push(h(document, 'option', { value: 'legacy', text: legacyLabel(found) }));
    for (const item of latest.activeItems) options.push(h(document, 'option', { value: `${ITEM_PREFIX}${item.id}`, text: item.nome }));
    if (canOther) options.push(h(document, 'option', { value: 'other', text: OPTION_TEXT.other }));
    fill(select, ...options);
    select.value = encode(choice);
  }

  function actionButton(text, onclick, { disabled = false } = {}) {
    return h(document, 'button', { type: 'button', className: 'btn secondary small', text, onclick, disabled });
  }

  function paintNote() {
    const parts = [];
    const message = (text) => h(document, 'span', { className: 'catalog-field-message', text });
    if (view === 'select') {
      const found = classifyValue(baseline, latest.items);
      if (choice.kind === 'legacy') {
        // o <select> corta um texto longo: o valor atual aparece por inteiro no aviso
        const current = h(document, 'span', { className: 'catalog-field-value', text: FIELD_TEXT.currentValue(baseline) });
        if (found.kind === 'different-spelling') parts.push(message(FIELD_TEXT.differentSpelling(found.item.nome)), current, actionButton(FIELD_TEXT.useOfficial, useOfficial));
        else if (found.kind === 'inactive') parts.push(message(FIELD_TEXT.inactive), current);
        else parts.push(message(FIELD_TEXT.outside), current);
      } else if (choice.kind === 'other') {
        parts.push(message(FIELD_TEXT.other));
      }
    } else if (latest.status === STATUS.EMPTY) {
      parts.push(message(FIELD_TEXT.empty));
      if (adminLink) parts.push(h(document, 'a', { className: 'btn secondary small', href: adminLink, target: '_blank', rel: 'noopener noreferrer', text: FIELD_TEXT.openCatalog(CATALOG_TITLES[catalog]) }));
      parts.push(actionButton(FIELD_TEXT.refresh, retry, { disabled: retrying }));
    } else if (retrying && latest.status === STATUS.LOADING) {
      parts.push(message(FIELD_TEXT.checking));
    } else if (FAILING.has(latest.status)) {
      // os três catálogos falharam pelo mesmo motivo: quem fala é o aviso compartilhado do formulário, não cada campo
      if (!(notice && notice.shared() !== null)) {
        const text = latest.status === STATUS.UNAVAILABLE ? FIELD_TEXT.unavailable : latest.status === STATUS.NETWORK ? FIELD_TEXT.network : FIELD_TEXT.error;
        parts.push(message(text), actionButton(FIELD_TEXT.retry, retry, { disabled: retrying }));
      }
    }
    fill(note, ...parts);
    note.setAttribute('aria-busy', latest.status === STATUS.LOADING || retrying ? 'true' : 'false');
  }

  function paintVisibility() {
    select.hidden = view !== 'select';
    textInput.hidden = !(view === 'text' || choice.kind === 'other');
    if (view === 'select') textInput.setAttribute('aria-label', `${labelText()} (outro valor)`);
    else textInput.removeAttribute('aria-label');
    if (label) label.setAttribute('for', view === 'select' ? selectId : id);
    element.setAttribute('data-view', view);
    element.setAttribute('data-status', latest.status);
    element.setAttribute('data-choice', view === 'select' ? choice.kind : 'text');
  }

  function paint() {
    if (view === 'select') paintSelect();
    paintNote();
    paintVisibility();
  }

  // Uma escolha da pessoa: as opções não são refeitas (a lista em uso não pode piscar); só a escolha, o aviso e o texto livre.
  function paintChoice() {
    select.value = encode(choice);
    paintNote();
    paintVisibility();
  }

  // Aplica o estado do catálogo ao campo. `force`: ignora a regra de "não mexer enquanto a pessoa está no campo" (a primeira pintura e as ações dela).
  function applyState(state, { force = false } = {}) {
    if (disposed) return;
    latest = state;
    if (!force && isEditing()) {
      pendingApply = true;
      return;
    }
    pendingApply = false;
    const next = state.status === STATUS.READY ? 'select' : 'text';
    const text = currentText(); // o valor de agora, ANTES de mudar qualquer coisa
    if (next === 'select') {
      if (view === 'text') {
        baseline = trimmed(text);
        choice = initialChoice(baseline, state.items);
      } else {
        reconcileChoice(state.items);
      }
    } else if (view === 'select') {
      // as opções deixaram de existir (catálogo ficou vazio): o valor de agora vai para o texto livre, intacto
      textInput.value = text;
    }
    view = next;
    paint();
  }

  function flushPending() {
    if (pendingApply && !disposed) applyState(latest);
  }

  // O foco volta para onde a pessoa estava: o botão que ela acionou é refeito a cada pintura do aviso, então depois da releitura o foco vai para a lista (se ela apareceu) ou para o novo botão.
  function restoreFocusAfterRetry() {
    if (view === 'select') {
      select.focus();
      return;
    }
    const button = Array.from(note.children).find((child) => child.localName === 'button');
    if (button) button.focus();
    else textInput.focus();
  }

  async function retry() {
    if (retrying || disposed) return;
    const hadFocus = Boolean(document.activeElement) && note.contains(document.activeElement); // o foco estava no botão que a pessoa acionou
    retrying = true;
    paintNote();
    const state = await lookup.ensure(catalog, { force: true });
    retrying = false;
    if (disposed) return;
    applyState(state, { force: true });
    if (hadFocus) restoreFocusAfterRetry();
  }

  function emitChange() {
    for (const listener of [...external]) listener({ type: 'change', target: select });
  }

  function useOfficial() {
    const found = classifyValue(baseline, latest.items);
    if (found.kind !== 'different-spelling') return;
    choice = { kind: 'item', id: found.item.id, name: found.item.nome };
    paintChoice();
    select.focus();
    emitChange();
  }

  const onPick = (event) => {
    const picked = String(select.value || 'none');
    if (picked === 'none' || picked === 'legacy' || picked === 'other') choice = { kind: picked };
    else {
      const item = latest.activeItems.find((entry) => `${ITEM_PREFIX}${entry.id}` === picked);
      choice = item ? { kind: 'item', id: item.id, name: item.nome } : { kind: 'none' };
    }
    paintChoice();
    if (choice.kind === 'other' && event && event.type === 'change') textInput.focus(); // a escolha foi confirmada: o foco vai para o texto
  };
  // 'input' vem antes de 'change' num <select>: os dois atualizam a escolha ANTES de os ouvintes do formulário lerem o valor
  select.addEventListener('input', onPick);
  select.addEventListener('change', onPick);
  select.addEventListener('blur', flushPending);
  textInput.addEventListener('blur', flushPending);

  const control = {
    get value() {
      return currentText();
    },
    focus() {
      primary().focus();
    },
    setAttribute(name, attributeValue) {
      select.setAttribute(name, attributeValue);
      textInput.setAttribute(name, attributeValue);
    },
    removeAttribute(name) {
      select.removeAttribute(name);
      textInput.removeAttribute(name);
    },
    addEventListener(type, listener) {
      external.push(listener);
      select.addEventListener(type, listener);
      textInput.addEventListener(type, listener);
    },
  };

  // Primeira pintura (do cache, se houver) e assinatura das mudanças do catálogo; depois a leitura (uma só, mesmo com vários campos do mesmo catálogo).
  if (notice) notice.onChange(() => !disposed && paintNote()); // o aviso compartilhado entrou ou saiu de cena: este campo mostra ou cala o seu aviso próprio
  applyState(latest, { force: true });
  const unsubscribe = lookup.subscribe(catalog, (state) => applyState(state));
  lookup.ensure(catalog);

  return {
    element,
    control,
    state: () => ({ view, choice: choice.kind, baseline, status: latest.status, pending: pendingApply }),
    refreshNote: () => !disposed && paintNote(),
    destroy() {
      disposed = true;
      unsubscribe();
    },
  };
}
