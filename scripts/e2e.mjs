// End-to-end check: real menu bar app + real extension in Chromium + real yt-dlp.
// Usage: npm run e2e        (needs network; downloads ~1 MB of audio)
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extDir = path.join(root, 'extension');
const PORT = 41899;
const EXPECTED_ID = 'kdnempddaodnginhpkpilbagmmimkkbg';
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", 19 s
const PLAYLIST = 'https://www.youtube.com/playlist?list=PL4Gr5tOAPttLOY9IrWVjJlv4CtkYI5cI_';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytb-e2e-'));
const outDir = path.join(tmp, 'out');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });

const log = (...a) => console.log('•', ...a);
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log('  ✓', what);
};

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function clearJobs(page) {
  await page.click('#clearJobs');
  await page.waitForFunction(() => !document.querySelector('#jobs .job'), null, { timeout: 5000 });
}

const electronBin = path.join(root, 'app', 'node_modules', '.bin', 'electron');
const appProc = spawn(electronBin, [path.join(root, 'app')], {
  env: { ...process.env, YTDLP_BRIDGE_HOME: path.join(tmp, 'home'), YTDLP_BRIDGE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
appProc.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));

let context;
try {
  log('starting menu bar app on port', PORT);
  const status = await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json(), 30000, 'app');
  check(status.app === 'ytdlp-bridge' && status.ytdlp.path, `app is up, found yt-dlp ${status.ytdlp.version} at ${status.ytdlp.path}`);
  check(Boolean(status.ffmpeg.path) && Boolean(status.jsRuntime), `app found ffmpeg and a JS runtime (${status.jsRuntime})`);

  log('loading extension in Chromium');
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check(extId === EXPECTED_ID, `extension ID is pinned (${extId})`);
  await sw.evaluate((port) => chrome.storage.local.set({ local: { port } }), PORT);
  const swFetch = await sw.evaluate((port) => fetch(`http://127.0.0.1:${port}/api/jobs/list`, { method: 'POST' }).then((r) => r.status), PORT);
  check(swFetch === 200, 'service worker can read the job list (approved by Origin)');

  // ----- settings page -----
  const options = await context.newPage();
  await options.setViewportSize({ width: 900, height: 1400 });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForFunction(() => document.getElementById('connTitle').textContent.startsWith('Connected'), null, { timeout: 10000 });
  check(true, 'settings page shows "Connected"');
  await options.fill('#outputDir', outDir);
  await options.waitForFunction((dir) => document.getElementById('preview').textContent.includes(dir), outDir, { timeout: 5000 });
  const preview = await options.textContent('#preview');
  check(preview.includes('--force-overwrites') && preview.includes('--audio-format mp3') && preview.includes('--embed-thumbnail'),
    'command preview reflects settings (mp3, cover art, replace existing)');
  await options.screenshot({ path: path.join(shots, 'settings.png'), fullPage: true });

  // ----- popup: single video -----
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('statusText').textContent === 'Ready', null, { timeout: 10000 });
  check(true, 'popup shows "Ready"');
  await popup.fill('#link', VIDEO);
  check((await popup.textContent('#kind')) === 'Video', 'popup detects a single video');
  check((await popup.textContent('#download')) === 'Download as MP3', 'button reads "Download as MP3"');
  await popup.click('#download');
  const doneMeta = async () => popup.evaluate(() => {
    const first = document.querySelector('#jobs .job .job-meta');
    return first && /^(Saved|Already|Saved \d)/.test(first.textContent) ? first.textContent : null;
  });
  const meta1 = await waitFor(doneMeta, 120000, 'single download');
  check(true, `single video finished: "${meta1}"`);
  await popup.screenshot({ path: path.join(shots, 'popup.png') });

  const mp3 = path.join(outDir, 'Me at the zoo.mp3');
  check(fs.existsSync(mp3), 'MP3 saved in the chosen folder');
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format_tags=title,artist', '-of', 'json', mp3], { encoding: 'utf8' });
  const info = JSON.parse(probe);
  const cover = info.streams.find((s) => s.codec_name === 'mjpeg');
  check(info.streams.some((s) => s.codec_name === 'mp3'), 'audio stream is MP3');
  check(cover && cover.width === cover.height, `cover art embedded and square (${cover?.width}x${cover?.height})`);
  check(info.format.tags.title === 'Me at the zoo' && Boolean(info.format.tags.artist), `tags embedded (title "${info.format.tags.title}", artist "${info.format.tags.artist}")`);

  // ----- replace existing -----
  const before = fs.statSync(mp3).mtimeMs;
  await clearJobs(popup);
  await popup.click('#download');
  const meta2 = await waitFor(doneMeta, 120000, 'second download');
  check(/replaced existing file/.test(meta2), `second run deletes and downloads again: "${meta2}"`);
  check(fs.statSync(mp3).mtimeMs > before, 'file on disk was rewritten');

  // ----- playlist -----
  await clearJobs(popup);
  await popup.fill('#link', PLAYLIST);
  check((await popup.textContent('#kind')) === 'Playlist', 'popup detects a playlist');
  check(await popup.isChecked('input[name=scope][value=playlist]'), 'scope defaults to "Whole playlist"');
  await popup.fill('#playlistItems', '1-2');
  check((await popup.textContent('#download')) === 'Download playlist as MP3', 'button reads "Download playlist as MP3"');
  await popup.click('#download');
  await waitFor(() => popup.evaluate(() => document.querySelector('#jobs .job-meta')?.textContent.includes('of 2')), 60000, 'playlist counter');
  check(true, 'playlist shows an item counter ("1 of 2")');
  await popup.screenshot({ path: path.join(shots, 'popup-playlist-running.png') });
  const job = await waitFor(async () => {
    const { jobs } = await sw.evaluate((port) => fetch(`http://127.0.0.1:${port}/api/jobs/list`, { method: 'POST' }).then((r) => r.json()), PORT);
    return ['done', 'partial', 'error'].includes(jobs[0].status) && jobs[0];
  }, 240000, 'playlist download');
  check(job.status !== 'error', `playlist finished with status "${job.status}", ${job.files.length} file(s)${job.error ? `; note: ${job.error}` : ''}`);
  const folder = path.join(outDir, fs.readdirSync(outDir).find((d) => fs.statSync(path.join(outDir, d)).isDirectory()));
  const files = fs.readdirSync(folder).filter((f) => f.endsWith('.mp3'));
  check(files.length >= 1 && files.every((f) => /^\d{3} - /.test(f)), `playlist folder "${path.basename(folder)}" holds numbered files: ${files.join(', ')}`);
  const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=album,track', '-of', 'json', path.join(folder, files[0])], { encoding: 'utf8' })).format.tags;
  check(Boolean(tags.album) && Boolean(tags.track), `playlist name became album tag ("${tags.album}", track ${tags.track})`);

  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.screenshot({ path: path.join(shots, 'popup-dark.png') });
  console.log('\nAll end-to-end checks passed. Screenshots in docs/screenshots/.');
} finally {
  if (context) await context.close();
  appProc.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}
