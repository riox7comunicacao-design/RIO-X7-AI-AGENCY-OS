// Ponto único dos componentes globais do Dashboard (UX 4.0): camadas (modal/drawer/confirmação), notificações, componentes visuais e
// atualização de dados. Uma tela recebe `ui` por parâmetro (main.mjs cria um por sessão); sem ele, a tela cria o seu (testes).
//
//   const ui = createUi({ document, host, getInertTargets });   // host: onde as camadas e os avisos são desenhados
//   ui.overlays.openDrawer({...}) / ui.overlays.openConfirm({...}) / ui.toasts.success('...')

import { createOverlayManager } from './overlays.mjs';
import { createToaster } from './toasts.mjs';

export { createOverlayManager, focusableIn } from './overlays.mjs';
export { createToaster } from './toasts.mjs';
export { createDataBus, createPoller } from './dataBus.mjs';
export { createRoutedDrawer } from './routedDrawer.mjs';
export { statusBadge, emptyState, loadingState, skeleton, pageHeader, kvList, section, searchField, selectField, pagination, createTabs, formField } from './components.mjs';

export function createUi({ document, host, getInertTargets = () => [], schedule }) {
  const overlays = createOverlayManager({ document, host, getInertTargets });
  const toasts = createToaster({ document, host, ...(schedule ? { schedule } : {}) });
  return {
    overlays,
    toasts,
    destroy() {
      overlays.destroy();
      toasts.destroy();
    },
  };
}
