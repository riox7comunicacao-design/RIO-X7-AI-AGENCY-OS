// O ÚNICO ponto por onde texto dinâmico entra no DOM do Dashboard.
//
// Os dados de um prospect vêm de pesquisa na web (e, no futuro, de IA): são NÃO CONFIÁVEIS. Por isso o Dashboard
// nunca monta HTML com eles: todo texto entra por `textContent`, todo atributo por `setAttribute` com um nome
// escolhido pelo código, e nenhum manipulador de evento é um texto. Nada aqui usa innerHTML, outerHTML,
// insertAdjacentHTML, document.write, eval ou o construtor Function — e um teste vigia isso em todo dashboard/.
//
// h(document, 'a', { text: 'rótulo', href: 'https://…', onclick: função }, filho1, filho2)
//   text       -> textContent (nunca HTML)
//   className  -> a propriedade className
//   disabled / hidden -> propriedades booleanas
//   onXxx      -> addEventListener('xxx', função) — só função; um texto é recusado
//   qualquer outro nome -> setAttribute(nome, String(valor))
// Recusados: style e srcdoc (nunca são necessários; o CSP também os barra) e qualquer on* que não seja função.
// Os filhos são elementos (null/undefined/false são ignorados). fill(container, ...filhos) faz o mesmo ao TROCAR os filhos.

export function h(document, tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'text') {
      element.textContent = String(value);
    } else if (name === 'className') {
      element.className = String(value);
    } else if (name === 'disabled' || name === 'hidden') {
      element[name] = Boolean(value);
    } else if (name.startsWith('on')) {
      if (typeof value !== 'function') throw new Error(`h(): ${name} deve ser uma função`);
      element.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (name === 'style' || name === 'srcdoc') {
      throw new Error(`h(): o atributo ${name} não é permitido`);
    } else {
      element.setAttribute(name, String(value));
    }
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

// Troca os filhos de um contêiner, ignorando null/undefined/false. O `replaceChildren` do navegador transforma um argumento
// que não é um nó em TEXTO (replaceChildren(null) escreve "null" na tela); por isso todo desenho dinâmico das telas passa por
// aqui — o mesmo critério que h() já aplica aos filhos de um elemento.
export function fill(container, ...children) {
  container.replaceChildren(...children.filter((child) => child !== null && child !== undefined && child !== false));
}
