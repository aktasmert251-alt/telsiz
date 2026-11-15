/* icon.svg'den PNG simgeleri üretir. Playwright gerektirir:
   node tools/make-icons.js <playwright modül yolu> */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.argv[2] || 'playwright');

const dir = path.join(__dirname, '..', 'app', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect[^>]*\/>/, '');
// Tam kare zemin + güvenli alana küçültülmüş işaret (maskable ve iOS için)
const full = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1B1A16"/>'
  + '<g transform="translate(256 256) scale(.78) translate(-256 -256)">' + inner + '</g></svg>';

(async () => {
  const browser = await chromium.launch();
  const shot = async (markup, size, name, transparent) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>' + markup);
    await page.screenshot({ path: path.join(dir, name), omitBackground: transparent });
    await page.close();
  };
  await shot(svg, 192, 'icon-192.png', true);
  await shot(svg, 512, 'icon-512.png', true);
  await shot(full, 512, 'icon-maskable-512.png', false);
  await shot(full, 180, 'apple-touch-icon.png', false);
  await browser.close();
  console.log('Simgeler üretildi.');
})();
