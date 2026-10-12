// Gera os fundos de ecrã NOVA (Brandbook) a partir de gerador.html: node render.js [desenhos] [tamanhos]
// Sai em PNG para ../fundos; depois converter para JPG (qualidade 90) e gerar as miniaturas (-thumb 640×360, -thumb-phone 240 px de largura).
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const SIZES = { '4k': [3840, 2160], '1080p': [1920, 1080], 'ipad': [2732, 2732], 'iphone': [1320, 2868] };
const only = process.argv[2] ? process.argv[2].split(',') : null, sizes = process.argv[3] ? process.argv[3].split(',') : Object.keys(SIZES);
(async () => { const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
 const ctx = await b.newContext({ viewport: { width: 800, height: 600 } }); const pg = await ctx.newPage();
 await pg.goto('file://' + __dirname + '/gerador.html');
 for (const d of (only || ['essencial', 'monograma', 'topografia', 'luz'])) for (const mode of ['light', 'dark']) for (const s of sizes) {
   const [w, h] = SIZES[s];
   await pg.setViewportSize({ width: w, height: h });
   await pg.evaluate(([d, mode, w, h]) => window.render(d, mode, w, h), [d, mode, w, h]);
   await (await pg.$('#c')).screenshot({ path: `${__dirname}/../fundos/${d}-${mode}-${s}.png` });
 }
 await b.close(); })();
