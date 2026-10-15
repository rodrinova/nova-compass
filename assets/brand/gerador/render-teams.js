// Gera os fundos de reunião do Teams a partir de gerador.html: node render-teams.js
// Sai em PNG para ../teams; depois converter para JPG (qualidade 90) e gerar a miniatura (-thumb, 960 px).
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
(async () => { const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
 const pg = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
 await pg.goto('file://' + __dirname + '/gerador.html');
 for (const mode of ['dark']) {   // a marca usa só a versão escura
   await pg.evaluate(([mode]) => window.renderTeams(mode, 1920, 1080), [mode]);
   await (await pg.$('#c')).screenshot({ path: `${__dirname}/../teams/teams-${mode}.png` });
 }
 await b.close(); })();
