// Renders the extension icons, the app icon and the menu bar icon from SVG.
// Usage: npm run icons
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const glyph = (color, width) => `
  <path d="M64 30v46M43 56l21 21 21-21" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M38 96h52" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;

const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ff5d4f"/><stop offset="1" stop-color="#d4213d"/></linearGradient></defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g)"/>${glyph('#fff', 12)}</svg>`;

// macOS app icons keep a transparent margin around an 824px body (of 1024).
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ff5d4f"/><stop offset="1" stop-color="#d4213d"/></linearGradient></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>
  <g transform="translate(160 160) scale(5.5)">${glyph('#fff', 10)}</g></svg>`;

const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${glyph('#000', 13)}</svg>`;

const jobs = [
  ...[16, 32, 48, 128].map((s) => [badge, s, `extension/icons/icon${s}.png`]),
  [appIcon, 1024, 'app/build/icon.png'],
  [tray, 16, 'app/assets/trayTemplate.png'],
  [tray, 32, 'app/assets/trayTemplate@2x.png'],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [svg, size, out] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: path.join(root, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', out);
}
await browser.close();
