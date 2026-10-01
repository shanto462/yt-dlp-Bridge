// Checks the extension and writes a clean copy plus a zip to dist/.
// Usage: npm run build:extension
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const out = path.join(dist, 'extension');

const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const zip = path.join(dist, `yt-dlp-bridge-extension-${manifest.version}.zip`);

// Every file the manifest points to must exist.
const referenced = [
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  manifest.action.default_popup,
  manifest.options_ui.page,
  manifest.background.service_worker,
];
const missing = referenced.filter((f) => !fs.existsSync(path.join(src, f)));
if (missing.length) throw new Error(`Missing files: ${missing.join(', ')}`);

// Every script must parse (they are ES modules).
const scripts = fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.js'));
for (const f of scripts) execFileSync(process.execPath, ['--check', path.join(src, f)]);

fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
fs.cpSync(src, out, { recursive: true, filter: (p) => path.basename(p) !== '.DS_Store' });
execFileSync('zip', ['-qrX', zip, '.'], { cwd: out });

console.log(`Checked ${referenced.length} manifest files and ${scripts.length} scripts.`);
console.log(`Folder: ${out}`);
console.log(`Zip:    ${zip}`);
