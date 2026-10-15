// Gera a placa do logótipo da assinatura de email a partir de gerador.html: node render-email.js
// 450 × 150 (3× os 150 × 50 a que aparece no email); depois arredondar os cantos (8 px no email) e guardar em PNG.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
(async () => { const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
 const pg = await (await b.newContext({ viewport: { width: 450, height: 150 } })).newPage();
 await pg.goto('file://' + __dirname + '/gerador.html');
 await pg.evaluate(() => window.renderPlate(450, 150));
 await (await pg.$('#c')).screenshot({ path: `${__dirname}/../email/assinatura-logo-claro.png` });
 await b.close(); })();
