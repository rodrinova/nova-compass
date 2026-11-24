// Gera o ícone NOVA (N ameixa com brilho, fundo preto) a partir de gerador.html: node render-icons.js
// Sai para ../linkedin/logo-n-escuro.png (LinkedIn, 800) e ../../icons/ (app instalada, separador do browser).
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const LI = __dirname + '/../linkedin/', IC = __dirname + '/../../icons/';
const OUT = [
  [LI + 'logo-n-escuro.png', 800, {}],
  [IC + 'icon-512.png', 512, {}],
  [IC + 'icon-192.png', 192, { grainAmt: .6 }],
  [IC + 'apple-touch-icon.png', 180, { grainAmt: .6 }],
  [IC + 'icon-maskable-512.png', 512, { nh: .34 }],   // Android recorta em círculo: um pouco mais pequeno
  [IC + 'favicon-32.png', 32, { nh: .62, light: 1, grainAmt: 0, ink: '#7A5286' }],   // no separador o N precisa de ler-se
];
(async () => {
  const b = await chromium.launch();
  const pg = await (await b.newContext({ viewport: { width: 800, height: 800 } })).newPage();
  await pg.goto('file://' + __dirname + '/gerador.html');
  for (const [file, w, opt] of OUT) {
    await pg.setViewportSize({ width: Math.max(w, 64), height: Math.max(w, 64) });
    await pg.evaluate(([w, opt]) => window.renderIcon(w, opt), [w, opt]);
    await (await pg.$('#c')).screenshot({ path: file });
    console.log('ok', file.replace(__dirname + '/', ''), w);
  }
  await b.close();
})();
