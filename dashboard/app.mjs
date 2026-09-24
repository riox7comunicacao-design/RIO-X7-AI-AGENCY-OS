// Dashboard Rio X7 AI Agency OS — o ponto de entrada do navegador.
//
// Este arquivo só liga o painel (main.mjs) ao navegador de verdade: o document, o fetch, o SDK do Supabase (o bundle local,
// /lib/supabase.js — nenhum CDN) e a navegação por # (router.mjs). É a ÚNICA parte do Dashboard que toca nesses globais;
// todo o resto recebe o que precisa por parâmetro (e por isso os testes rodam o painel num DOM de teste).
//
// Este arquivo não importa nada de src/: o navegador só conversa com o servidor por HTTP.

import { startDashboard } from './main.mjs';
import { browserNavigation } from './router.mjs';

startDashboard({
  document,
  root: document.getElementById('app'),
  fetchImpl: (...args) => globalThis.fetch(...args),
  sdk: globalThis.supabase,
  navigation: browserNavigation(globalThis),
});
