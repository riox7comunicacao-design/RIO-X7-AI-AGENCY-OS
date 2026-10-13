// Seletor visual de cor (CRM 5.0, Fase 2B-2): a paleta fixa de 20 cores dos nichos como um GRUPO DE OPÇÕES acessível (role="radiogroup" com 20 role="radio").
//
//   - cada opção mostra a AMOSTRA da cor, o NOME em texto (a cor nunca é a única informação) e, na escolhida, a marca de selecionada;
//   - o estado selecionado também vai para o leitor de tela (aria-checked) e a escolha é única;
//   - TECLADO: Tab entra no grupo (na opção escolhida, ou na primeira se nenhuma foi); as setas, Home e End movem a escolha e o foco; Espaço e Enter escolhem;
//   - SEM ESTILO INLINE e sem cor montada em código: a aparência de cada opção vem da classe `cor-<chave>` de styles.css (CSP style-src 'self'; DASH-GUARD-8). Este componente só
//     recebe as opções ({ chave, nome, className }) — quem decide quais são é catalog-colors.mjs;
//   - só a CHAVE aprovada é lida e devolvida; o componente não tem opção "sem cor" (a paleta é exatamente a que o servidor aceita).

import { h } from '../dom.mjs';

// id: prefixo dos ids (o rótulo e o erro). options: [{ chave, nome, className }]. value: a chave escolhida ('' = nenhuma). onChange(chave) quando a pessoa escolhe.
export function colorPicker(document, { id, label, options, value = '', required = false, help = '', onChange = () => {} } = {}) {
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  let current = options.some((option) => option.chave === value) ? value : '';
  const buttons = new Map();

  const helpEl = help ? h(document, 'p', { className: 'field-help muted', id: helpId, text: help }) : null;
  const errorEl = h(document, 'p', { className: 'field-error', id: errorId, role: 'alert', hidden: true });
  const labelEl = h(document, 'p', { className: required ? 'field-label required' : 'field-label', id: labelId, text: label });

  function paint() {
    // o ponto de entrada do teclado: a opção escolhida ou, sem escolha, a primeira
    const entry = current !== '' ? current : options[0].chave;
    for (const option of options) {
      const button = buttons.get(option.chave);
      const selected = option.chave === current;
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.setAttribute('tabindex', option.chave === entry ? '0' : '-1');
      button.className = `color-swatch ${option.className}${selected ? ' selected' : ''}`;
    }
  }

  function choose(chave, { focus = false } = {}) {
    if (!buttons.has(chave)) return;
    const changed = chave !== current;
    current = chave;
    paint();
    if (focus) buttons.get(chave).focus();
    if (changed) onChange(chave);
  }

  function onKey(event) {
    const order = options.map((option) => option.chave);
    const at = current !== '' ? order.indexOf(current) : -1;
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = order[at < 0 ? 0 : (at + 1) % order.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = order[at < 0 ? order.length - 1 : (at - 1 + order.length) % order.length];
    else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order[order.length - 1];
    if (next === null) return;
    event.preventDefault();
    choose(next, { focus: true });
  }

  const grid = h(document, 'div', { className: 'color-grid', role: 'radiogroup', 'aria-labelledby': labelId, 'aria-describedby': [helpEl ? helpId : '', errorId].filter(Boolean).join(' '), ...(required ? { 'aria-required': 'true' } : {}), onkeydown: onKey });
  for (const option of options) {
    const button = h(
      document,
      'button',
      { type: 'button', role: 'radio', className: `color-swatch ${option.className}`, 'data-color': option.chave, 'aria-checked': 'false', tabindex: '-1', onclick: () => choose(option.chave) },
      h(document, 'span', { className: 'swatch-dot', 'aria-hidden': 'true' }),
      h(document, 'span', { className: 'swatch-name', text: option.nome }),
      h(document, 'span', { className: 'swatch-check', 'aria-hidden': 'true', text: '✓' })
    );
    buttons.set(option.chave, button);
    grid.append(button);
  }
  paint();

  const element = h(document, 'div', { className: 'field color-field form-field' }, labelEl, helpEl, grid, errorEl);

  return {
    element,
    group: grid,
    get value() {
      return current;
    },
    setValue(chave) {
      current = options.some((option) => option.chave === chave) ? chave : '';
      paint();
    },
    setError(text) {
      errorEl.textContent = text || '';
      errorEl.hidden = !text;
      if (text) grid.setAttribute('aria-invalid', 'true');
      else grid.removeAttribute('aria-invalid');
    },
    setDisabled(value) {
      for (const button of buttons.values()) button.disabled = Boolean(value);
    },
    // o foco vai para a opção escolhida (ou a primeira)
    focus() {
      const target = buttons.get(current !== '' ? current : options[0].chave);
      if (target) target.focus();
    },
    swatch: (chave) => buttons.get(chave) || null,
  };
}
