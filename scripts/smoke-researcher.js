// SMOKE TEST REAL, CONTROLADO e DESCARTÁVEL do Researcher V1 (decisão 0022) — NÃO faz parte do `npm test` e NÃO é determinístico.
//
//   adaptador real (busca pública + páginas públicas) -> Researcher -> rawFinding V2 -> conferência
//
// Este é o ÚNICO ponto do projeto que acessa a internet de verdade. Só roda com a confirmação explícita:
//
//   RIO_X7_SMOKE=1 node scripts/smoke-researcher.js            (ou:  RIO_X7_SMOKE=1 npm run smoke:researcher)
//
// Dois estágios pequenos e controlados, sobre uma instituição PÚBLICA (nunca uma empresa-prospect), com orçamento curto de requisições:
//   A) a BUSCA real (Nominatim) — mostra o que o adaptador faz com a fonte pública, INCLUSIVE quando o robots.txt dela não permite (respeitado, nunca forçado);
//   B) o Researcher com o `fetchPage` REAL sobre UMA página pública declarada pelo operador (entrada controlada e fixa, não um resultado de busca).
// Não usa CRM, não cria lote, não chama o submitProspecting, não usa a fila, não escreve NADA em disco (nem em data/*.json): o resultado
// só é impresso no terminal e some. Nenhuma credencial, login, cookie, proxy ou contorno de qualquer controle existe no adaptador.
// Se a internet ou a fonte não estiverem disponíveis, o script DIZ ISSO — nunca inventa resultado.

const { createResearchPorts } = require('../src/research-adapters');
const { createResearcher } = require('../src/research-prospector/researcher');
const { validateRawFindingsV2 } = require('../src/research-prospector/rawFindingV2');

const BRIEFING = Object.freeze({ nicho: process.env.RIO_X7_SMOKE_NICHO || 'Museu Imperial', regiao: process.env.RIO_X7_SMOKE_REGIAO || 'Petrópolis', quantidadeDesejada: 1 });
const FIXED = Object.freeze({ nome: process.env.RIO_X7_SMOKE_NOME || 'IANA', url: process.env.RIO_X7_SMOKE_URL || 'https://www.iana.org/' });

const isHttps = (url) => typeof url === 'string' && url.startsWith('https://');

function novasPortas() {
  return createResearchPorts({ userAgent: 'RioX7ResearcherV1/1.0 (smoke test controlado; somente dados publicos)', minIntervalMs: 1000, maxRequests: 12, timeoutMs: 10000, maxBytes: 1024 * 1024 });
}
const resumo = (estatisticas) => `requisições: ${estatisticas.requisicoes} (robots.txt: ${estatisticas.robotsConsultados}) | redirecionamentos: ${estatisticas.redirecionamentos} | falhas tratadas: ${JSON.stringify(estatisticas.falhas)} | eventos: ${estatisticas.eventos.map((e) => `${e.codigo}${e.host ? `@${e.host}` : ''}`).join(', ') || '(nenhum)'}`;

async function estagioA() {
  console.log('--- ESTÁGIO A: busca real (Nominatim) -> Researcher ---');
  const ports = novasPortas();
  const saida = await createResearcher(ports, { now: () => new Date(), maxDurationMs: 90 * 1000 }).research(BRIEFING);
  console.log(`briefing: ${JSON.stringify(BRIEFING)}`);
  console.log(resumo(ports.estatisticas()));
  if (!saida.ok) console.log(`resultado: ${saida.erro.code} — a fonte pública pode estar indisponível ou não permitir acesso automatizado (robots.txt); nada foi forçado nem inventado`);
  else console.log(`resultado: ${saida.achados.length} achado(s); relatório ${JSON.stringify(saida.relatorio)}`);
  return saida;
}

// Confere um resultado do Researcher: V2 válido, https, data de hoje, tipo de fonte; imprime as evidências. Devolve a lista de problemas.
function conferir(saida) {
  const problemas = [];
  const hoje = new Date().toISOString().slice(0, 10);
  const validacao = validateRawFindingsV2(saida.achados, { now: new Date() });
  if (!validacao.ok) problemas.push('a saída NÃO é rawFinding V2 válido');
  for (const achado of saida.achados) {
    console.log(`\n— ${achado.empresa} (${[achado.cidade, achado.estado].filter(Boolean).join('/') || 's/ cidade'}) | dataDaPesquisa ${achado.dataDaPesquisa}`);
    if (achado.dataDaPesquisa !== hoje) problemas.push('dataDaPesquisa diferente de hoje');
    for (const [campo, evidencias] of Object.entries(achado.campos)) {
      for (const e of evidencias) {
        console.log(`  evidência ${campo}: ${e.valor}  [${e.tipoFonte}]  fonte: ${e.url}  em ${e.dataConsulta}`);
        if (!isHttps(e.url)) problemas.push(`fonte não https em ${campo}`);
        if (e.dataConsulta !== hoje) problemas.push(`data da evidência de ${campo} diferente de hoje`);
        if (!['OFICIAL', 'SECUNDARIA'].includes(e.tipoFonte)) problemas.push(`tipoFonte inválido em ${campo}`);
      }
    }
    for (const f of (achado.dossie && achado.dossie.fatos) || []) {
      console.log(`  fato ${f.campo}: ${f.status}${f.valor === null ? '' : ` = ${JSON.stringify(f.valor)}`}${f.motivo ? ` (motivo ${f.motivo})` : ''}${f.fonte ? `  fonte: ${f.fonte.url}` : ''}`);
      if (f.fonte && !isHttps(f.fonte.url)) problemas.push(`fonte de fato não https em ${f.campo}`);
    }
    for (const url of achado.fontes || []) if (!isHttps(url)) problemas.push('fonte listada não https');
  }
  console.log(`validação rawFinding V2: ${validacao.ok ? 'OK' : 'FALHOU'}`);
  return problemas;
}

async function estagioB() {
  console.log('\n--- ESTÁGIO B: fetchPage real sobre UMA página pública declarada pelo operador -> Researcher ---');
  const ports = novasPortas();
  const candidato = { ok: true, resultados: [{ nome: FIXED.nome, url: FIXED.url, tipoResultado: 'SITE', fonteUrl: FIXED.url }] };
  const researcher = createResearcher({ search: async () => candidato, fetchPage: ports.fetchPage }, { now: () => new Date(), maxDurationMs: 60 * 1000 });
  const saida = await researcher.research({ nicho: 'Instituição pública (smoke test)', quantidadeDesejada: 1 });
  console.log(`entrada controlada: ${FIXED.nome} — ${FIXED.url} (declarada pelo operador; não é resultado de busca)`);
  console.log(resumo(ports.estatisticas()));
  if (!saida.ok) {
    console.log(`resultado: ${saida.erro.code}`);
    return [];
  }
  console.log(`relatório: ${JSON.stringify(saida.relatorio)}`);
  return conferir(saida);
}

async function main() {
  if (process.env.RIO_X7_SMOKE !== '1') {
    console.log('Smoke test real NÃO executado: defina RIO_X7_SMOKE=1 para autorizar duas consultas públicas controladas (nenhum dado é gravado).');
    return 0;
  }
  console.log('=== SMOKE TEST REAL — Researcher V1 (nada é gravado) ===');
  await estagioA();
  const problemas = await estagioB();
  console.log(`\ninvariantes: ${problemas.length === 0 ? 'OK' : problemas.join('; ')}`);
  return problemas.length === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, () => { console.error('smoke test: erro inesperado'); process.exitCode = 2; });
