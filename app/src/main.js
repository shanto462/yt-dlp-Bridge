'use strict';
// Menu bar app: owns the tray icon, native dialogs and notifications, and
// wires them to the local API server and the yt-dlp job queue.

const { app, Tray, Menu, dialog, shell, Notification, nativeImage, clipboard } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, BUNDLED_EXTENSION_ID } = require('./config');
const { JobQueue, FINISHED } = require('./queue');
const { createApiServer } = require('./server');
const { probe, runJob, findInPath } = require('./ytdlp');
const { expandHome } = require('./options');

const APP_NAME = 'yt-dlp Bridge';
const BUNDLE_EXT = /\.(app|bundle|framework|plugin|kext|prefpane|workflow|action|appex|xpc|saver|qlgenerator|mdimporter)\/?$/i;

let tray = null;
let config = null;
let queue = null;
let api = null;
let tools = { env: process.env, ytdlp: { path: null, version: null }, ffmpeg: { path: null, version: null }, jsRuntime: null };
let serverError = '';
let updating = false;
let lastOutputDir = '';
let menuTimer = null;
const deniedThisSession = new Set();
const pendingApprovals = new Map();

// A custom data folder (used by tests) also gets its own single-instance lock,
// so a test copy can run next to the installed app.
if (process.env.YTDLP_BRIDGE_HOME) app.setPath('userData', process.env.YTDLP_BRIDGE_HOME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => tray && tray.popUpContextMenu());
  app.on('window-all-closed', () => { /* menu bar app: keep running */ });
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox(APP_NAME, `Could not start: ${err.stack || err.message}`);
    app.exit(1);
  });
}

async function start() {
  app.setName(APP_NAME);
  if (app.dock) app.dock.hide();
  config = loadConfig(app.getPath('userData'));

  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Starting…', enabled: false }]));

  tools = await probe({ ytdlpPath: config.data.ytdlpPath });

  queue = new JobQueue({
    concurrency: config.data.concurrency,
    run: (job, onChange) => {
      lastOutputDir = job.options.outputDir;
      return runJob(job, { tools, onChange });
    },
  });
  queue.on('change', scheduleMenu);
  queue.on('finished', notifyFinished);
  // yt-dlp runs in its own process group, so stop it when the app goes away.
  app.on('will-quit', () => {
    for (const j of queue.list()) queue.cancel(j.id);
  });

  api = createApiServer({
    port: config.data.port,
    queue,
    appVersion: app.getVersion(),
    getTools: () => tools,
    auth: { isApproved, requestApproval },
    actions: { pickFolder, openFolder, reveal },
  });
  try {
    await api.listen();
  } catch (err) {
    serverError = err.code === 'EADDRINUSE'
      ? `Port ${config.data.port} is busy. Is another copy running?`
      : `Server error: ${err.message}`;
  }
  buildMenu();
}

// ---------- extension approval ----------

function isApproved(id) {
  return config.data.approvedExtensions.includes(id);
}

function requestApproval(id) {
  if (isApproved(id)) return Promise.resolve(true);
  if (deniedThisSession.has(id)) return Promise.resolve(false);
  if (pendingApprovals.has(id)) return pendingApprovals.get(id);
  const ask = (async () => {
    app.focus({ steal: true });
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Allow', 'Don’t Allow'],
      defaultId: 1,
      cancelId: 1,
      message: 'Allow a browser extension to use yt-dlp Bridge?',
      detail: `Extension ID:\n${id}\n\nIt will be able to start yt-dlp downloads on this Mac. Allow it only if this ID matches the one shown in the extension’s settings page.`,
    });
    if (response === 0) {
      config.data.approvedExtensions.push(id);
      config.save();
      buildMenu();
      return true;
    }
    deniedThisSession.add(id);
    return false;
  })().finally(() => pendingApprovals.delete(id));
  pendingApprovals.set(id, ask);
  return ask;
}

// ---------- actions used by the API ----------

async function pickFolder(defaultPath) {
  app.focus({ steal: true });
  const dir = defaultPath ? expandHome(defaultPath) : app.getPath('downloads');
  const result = await dialog.showOpenDialog({
    title: 'Choose where to save downloads',
    buttonLabel: 'Choose',
    defaultPath: fs.existsSync(dir) ? dir : app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
}

async function openFolder(raw) {
  const dir = path.normalize(expandHome(raw.trim()));
  if (!raw.trim() || !path.isAbsolute(dir)) throw new Error('Folder must be a full path.');
  if (BUNDLE_EXT.test(dir)) throw new Error('That path is an app or bundle, not a folder.');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.statSync(dir).isDirectory()) throw new Error('That path is not a folder.');
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
}

function reveal(job) {
  const file = [...job.files].reverse().find((f) => fs.existsSync(f));
  if (file) return shell.showItemInFolder(file);
  if (fs.existsSync(job.options.outputDir)) return shell.openPath(job.options.outputDir);
  return undefined;
}

// ---------- notifications ----------

function notifyFinished(job) {
  scheduleMenu();
  if (!job.options.notify || job.status === 'canceled' || !Notification.isSupported()) return;
  const name = (job.scope === 'playlist' && job.playlistTitle) || job.title || job.url;
  const count = job.files.length > 1 ? ` (${job.files.length} files)` : '';
  const text = {
    done: ['Download finished', `${name}${count}`],
    partial: ['Finished with errors', `${name}${count}\n${job.error}`],
    error: ['Download failed', `${name}\n${job.error}`],
  }[job.status];
  const n = new Notification({ title: text[0], body: text[1].slice(0, 250) });
  n.on('click', () => reveal(job));
  n.show();
}

// ---------- menu ----------

function scheduleMenu() {
  if (menuTimer) return;
  menuTimer = setTimeout(() => {
    menuTimer = null;
    buildMenu();
  }, 500);
}

function short(text, max = 48) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function jobLabel(j) {
  const counter = j.itemCount > 1 ? ` (${Math.min(j.itemIndex || 1, j.itemCount)}/${j.itemCount})` : '';
  if (j.status === 'queued') return `Queued  ${short(j.title)}`;
  if (j.status === 'running') {
    const state = j.phase === 'processing' ? 'Converting' : `${Math.round(j.progress * 100)}%`;
    return `${state}  ${short(j.title)}${counter}`;
  }
  const mark = { done: '✓', partial: '⚠︎', error: '✕', canceled: '–' }[j.status];
  return `${mark}  ${short(j.title)}`;
}

function jobSubmenu(j) {
  const job = queue.get(j.id);
  const items = [];
  if (!FINISHED.has(j.status)) items.push({ label: 'Cancel', click: () => queue.cancel(j.id) });
  items.push({ label: j.files.length ? 'Show in Finder' : 'Open Folder', click: () => reveal(job) });
  if (['error', 'partial', 'canceled'].includes(j.status)) items.push({ label: 'Retry', click: () => queue.retry(j.id) });
  if (j.error) items.push({ label: 'Copy Error', click: () => clipboard.writeText(j.error) });
  items.push({ label: 'Copy Log', click: () => clipboard.writeText(job.log.join('\n')) });
  items.push({ label: 'Copy Link', click: () => clipboard.writeText(j.url) });
  return items;
}

function buildMenu() {
  if (!tray) return;
  const jobs = queue ? queue.list() : [];
  const active = jobs.filter((j) => !FINISHED.has(j.status));
  const finished = jobs.filter((j) => FINISHED.has(j.status)).slice(0, 10);
  const running = active.filter((j) => j.status === 'running');

  if (running.length) {
    const pct = Math.round((running.reduce((s, j) => s + j.progress, 0) / running.length) * 100);
    tray.setTitle(active.length > 1 ? ` ${active.length} · ${pct}%` : ` ${pct}%`, { fontType: 'monospacedDigit' });
  } else {
    tray.setTitle('');
  }

  const t = [];
  t.push({ label: serverError || `Listening on 127.0.0.1:${config.data.port}`, enabled: false });
  if (tools.ytdlp.path) {
    t.push({ label: `yt-dlp ${tools.ytdlp.version || '(unknown version)'}`, enabled: false });
  } else {
    t.push({ label: 'yt-dlp not found. Install with: brew install yt-dlp', click: () => shell.openExternal('https://github.com/yt-dlp/yt-dlp/wiki/Installation') });
  }
  if (!tools.ffmpeg.path) t.push({ label: 'ffmpeg not found (needed for MP3 and cover art)', enabled: false });
  t.push({ type: 'separator' });

  if (!jobs.length) t.push({ label: 'No downloads yet', enabled: false });
  for (const j of [...active, ...finished]) t.push({ label: jobLabel(j), submenu: jobSubmenu(j) });
  if (finished.length) t.push({ label: 'Clear Finished', click: () => queue.clearFinished() });
  if (lastOutputDir) t.push({ label: 'Open Last Download Folder', click: () => shell.openPath(lastOutputDir) });
  t.push({ type: 'separator' });

  t.push({
    label: 'Downloads at Once',
    submenu: [1, 2, 3, 4].map((n) => ({
      label: String(n),
      type: 'radio',
      checked: queue && queue.concurrency === n,
      click: () => {
        queue.setConcurrency(n);
        config.data.concurrency = n;
        config.save();
      },
    })),
  });
  t.push({
    label: 'yt-dlp',
    submenu: [
      { label: tools.ytdlp.path || 'Not found', enabled: false },
      { label: updating ? 'Updating…' : 'Update yt-dlp', enabled: !updating && Boolean(tools.ytdlp.path), click: updateYtdlp },
      { label: 'Check Again', click: recheckTools },
      { label: 'Choose yt-dlp File…', click: chooseYtdlp },
      ...(config.data.ytdlpPath ? [{ label: 'Use Auto-Detected yt-dlp', click: () => setYtdlpPath('') }] : []),
    ],
  });
  t.push({
    label: 'Allowed Extensions',
    submenu: config.data.approvedExtensions.map((id) => ({
      label: id === BUNDLED_EXTENSION_ID ? `${id} (bundled)` : id,
      submenu: [{
        label: 'Remove',
        click: () => {
          config.data.approvedExtensions = config.data.approvedExtensions.filter((x) => x !== id);
          config.save();
          buildMenu();
        },
      }],
    })),
  });
  if (app.isPackaged) {
    t.push({
      label: 'Open at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    });
  }
  t.push({ type: 'separator' });
  t.push({ label: `Quit ${APP_NAME}`, click: quit });
  tray.setContextMenu(Menu.buildFromTemplate(t));
}

// ---------- yt-dlp management ----------

async function recheckTools() {
  tools = await probe({ ytdlpPath: config.data.ytdlpPath });
  buildMenu();
}

async function setYtdlpPath(p) {
  config.data.ytdlpPath = p;
  config.save();
  await recheckTools();
}

async function chooseYtdlp() {
  app.focus({ steal: true });
  const result = await dialog.showOpenDialog({ title: 'Choose the yt-dlp program', properties: ['openFile', 'showHiddenFiles'] });
  if (!result.canceled) await setYtdlpPath(result.filePaths[0]);
}

// Homebrew and pipx installs refuse `yt-dlp -U`, so use their own upgrade.
function updateCommand(binary) {
  const real = fs.realpathSync(binary);
  if (real.includes('/Cellar/')) {
    return [path.join(real.split('/Cellar/')[0], 'bin', 'brew'), ['upgrade', 'yt-dlp']];
  }
  if (real.includes('/pipx/')) {
    const pipx = findInPath('pipx', tools.env.PATH);
    if (pipx) return [pipx, ['upgrade', 'yt-dlp']];
  }
  return [binary, ['-U']];
}

function updateYtdlp() {
  const [cmd, args] = updateCommand(tools.ytdlp.path);
  updating = true;
  buildMenu();
  execFile(cmd, args, { env: tools.env, timeout: 10 * 60 * 1000 }, async (err, stdout, stderr) => {
    updating = false;
    const before = tools.ytdlp.version;
    await recheckTools();
    const output = `${stdout}\n${stderr}`.trim().split('\n').slice(-12).join('\n');
    app.focus({ steal: true });
    dialog.showMessageBox({
      type: err ? 'warning' : 'info',
      message: err ? 'yt-dlp update failed' : `yt-dlp ${before === tools.ytdlp.version ? 'is up to date' : 'was updated'} (${tools.ytdlp.version})`,
      detail: `${cmd} ${args.join(' ')}\n\n${output}`,
    });
  });
}

async function quit() {
  const active = queue ? queue.activeCount() : 0;
  if (active) {
    app.focus({ steal: true });
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Stop ${active} download${active > 1 ? 's' : ''} and quit?`,
    });
    if (response !== 0) return;
    for (const j of queue.list()) queue.cancel(j.id);
  }
  if (api) await api.close();
  app.exit(0);
}
