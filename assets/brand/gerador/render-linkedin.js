// Gera as imagens do LinkedIn (Brandbook) a partir de gerador.html: node render-linkedin.js [caminho do CSS da Inter]
// Sai em PNG para ../linkedin; depois converter para JPG (qualidade 92) e gerar as miniaturas.
// A Inter tem de estar disponível como @font-face (ex.: CSS com a fonte embutida) para a frase sair na letra da marca.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const OUT = __dirname + '/../linkedin/';
const SIZES = { cover: [4200, 700], life: [2256, 752], personal: [1584, 396] };
(async () => { const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
 const pg = await (await b.newContext({ viewport: { width: 800, height: 600 } })).newPage();
 await pg.goto('file://' + __dirname + '/gerador.html');
 if (process.argv[2]) await pg.addStyleTag({ path: process.argv[2] });
 for (const kind of (process.argv[3] ? process.argv[3].split(',') : Object.keys(SIZES))) for (const d of (process.argv[4] ? process.argv[4].split(',') : ['assinatura'])) for (const mode of ['light', 'dark']) {
   const [w, h] = SIZES[kind];
   await pg.setViewportSize({ width: w, height: h });
   await pg.evaluate(([k, d, mode, w, h]) => window.renderLI(k, d, mode, w, h), [kind, d, mode, w, h]);
   await (await pg.$('#c')).screenshot({ path: `${OUT}${kind}-${d}-${mode}.png` });
 }
 for (const k of ['palavra', 'n']) for (const bg of ['claro', 'ameixa']) {
   await pg.setViewportSize({ width: 800, height: 800 });
   await pg.evaluate(([k, bg]) => window.renderLogo(k, bg, 800), [k, bg]);
   await (await pg.$('#c')).screenshot({ path: `${OUT}logo-${k}-${bg}.png` });
 }
 await b.close(); })();
