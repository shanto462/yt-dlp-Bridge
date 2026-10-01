import {
  loadSettings, saveSettings, resetSettings, downloadOptions,
  AUDIO_FORMATS, AUDIO_QUALITIES, VIDEO_QUALITIES, VIDEO_CONTAINERS, COOKIE_BROWSERS,
  FILENAME_PRESETS, PLAYLIST_PRESETS, NO_QUALITY_FORMATS,
} from './lib/settings.js';
import { api, getStatus, pair } from './lib/api.js';

const $ = (id) => document.getElementById(id);
const CUSTOM = '__custom';
const SAMPLE_URLS = {
  single: 'https://www.youtube.com/watch?v=VIDEO_ID',
  playlist: 'https://www.youtube.com/playlist?list=PLAYLIST_ID',
};
const TEMPLATES = [
  { select: 'filenamePreset', input: 'filenameTemplate', presets: FILENAME_PRESETS },
  { select: 'playlistPreset', input: 'playlistTemplate', presets: PLAYLIST_PRESETS },
];

let settings;
let previewTimer = null;
let savedTimer = null;

init();

async function init() {
  fill('audioFormat', AUDIO_FORMATS);
  fill('audioQuality', AUDIO_QUALITIES);
  fill('videoQuality', VIDEO_QUALITIES);
  fill('videoContainer', VIDEO_CONTAINERS);
  fill('cookiesFromBrowser', COOKIE_BROWSERS);
  for (const t of TEMPLATES) fill(t.select, [...t.presets, [CUSTOM, 'Custom…']]);
  $('extId').textContent = chrome.runtime.id;

  settings = await loadSettings();
  render();
  bind();
  refreshConnection();
  schedulePreview(0);
}

function fill(id, options) {
  $(id).replaceChildren(...options.map(([value, text]) => new Option(text, value)));
}

function controls() {
  return document.querySelectorAll('[data-key]');
}

function render() {
  for (const el of controls()) {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else el.value = v;
  }
  for (const t of TEMPLATES) {
    const known = t.presets.some(([v]) => v === settings[t.input]);
    $(t.select).value = known ? settings[t.input] : CUSTOM;
    $(t.input).hidden = known;
  }
  renderDependencies();
}

// Grey out options that do nothing with the current choices.
function renderDependencies() {
  const setEnabled = (key, on) => {
    const el = document.querySelector(`[data-key="${key}"]`);
    el.disabled = !on;
    el.closest('.check')?.classList.toggle('disabled', !on);
  };
  $('audioQuality').disabled = NO_QUALITY_FORMATS.includes(settings.audioFormat);
  setEnabled('squareThumbnail', settings.embedThumbnail || settings.writeThumbnail);
  setEnabled('parseArtistTitle', settings.embedMetadata);
  setEnabled('playlistAsAlbum', settings.embedMetadata);
  $('subLangsField').hidden = !settings.embedSubs;
  setEnabled('useArchive', !settings.overwrite);
  $('archiveHint').hidden = !settings.overwrite;
}

function readControl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return Number(el.value);
  return el.value.trim();
}

function bind() {
  for (const el of controls()) {
    const isText = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number' || !el.type || el.type === 'url');
    let timer = null;
    el.addEventListener(isText ? 'input' : 'change', () => {
      clearTimeout(timer);
      timer = setTimeout(() => save({ [el.dataset.key]: readControl(el) }), isText ? 500 : 0);
    });
  }
  for (const t of TEMPLATES) {
    $(t.select).addEventListener('change', () => {
      const v = $(t.select).value;
      if (v === CUSTOM) {
        $(t.input).hidden = false;
        $(t.input).focus();
      } else {
        $(t.input).hidden = true;
        save({ [t.input]: v });
      }
    });
  }
  for (const r of document.querySelectorAll('input[name=previewScope]')) r.addEventListener('change', () => schedulePreview(0));

  $('recheck').addEventListener('click', refreshConnection);
  $('pairBtn').addEventListener('click', async () => {
    $('pairBtn').disabled = true;
    try {
      await pair(settings.port);
    } catch (err) {
      $('connDetail').textContent = err.message;
    }
    $('pairBtn').disabled = false;
    refreshConnection();
  });
  $('chooseFolder').addEventListener('click', async () => {
    try {
      const res = await api('/pick-folder', { body: { defaultPath: settings.outputDir }, timeout: 0 });
      if (res.path) {
        $('outputDir').value = res.path;
        save({ outputDir: res.path });
      }
    } catch (err) {
      flash(err.code === 'offline' ? 'Start the app to choose a folder' : err.message, true);
    }
  });
  $('openFolder').addEventListener('click', async () => {
    try {
      await api('/open-folder', { body: { path: settings.outputDir } });
    } catch (err) {
      flash(err.code === 'offline' ? 'Start the app to open the folder' : err.message, true);
    }
  });
  $('copyPreview').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('preview').textContent);
    flash('Copied');
  });
  $('reset').addEventListener('click', async () => {
    if (!confirm('Reset all yt-dlp Bridge settings to their defaults?')) return;
    settings = await resetSettings();
    render();
    flash('Settings reset');
    schedulePreview(0);
  });
}

async function save(patch) {
  if ('port' in patch && !(patch.port >= 1024 && patch.port <= 65535)) {
    flash('Port must be between 1024 and 65535', true);
    return;
  }
  settings = await saveSettings(patch);
  renderDependencies();
  flash('Saved');
  schedulePreview(150);
  if ('port' in patch) refreshConnection();
}

function flash(text, isError = false) {
  const el = $('saved');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), isError ? 4000 : 1400);
}

// ---------- connection ----------

async function refreshConnection() {
  $('connTitle').textContent = 'Checking…';
  const status = await getStatus(settings.port);
  const d = status.data;
  const dot = { ok: 'ok', not_approved: 'warn' }[status.state] || 'err';
  $('connDot').className = `dot ${dot}`;
  $('connTitle').textContent = {
    ok: 'Connected to the yt-dlp Bridge app',
    offline: 'The yt-dlp Bridge app is not running',
    not_approved: 'The app has not allowed this extension yet',
    no_ytdlp: 'Connected, but yt-dlp is missing',
  }[status.state];
  $('connDetail').textContent = d
    ? `App ${d.version} on 127.0.0.1:${settings.port} · ${d.active} active download${d.active === 1 ? '' : 's'}`
    : `Looked on 127.0.0.1:${settings.port}.`;
  $('setupHelp').hidden = status.state !== 'offline';
  $('pairBtn').hidden = status.state !== 'not_approved';
  $('facts').hidden = !d;
  if (d) {
    $('factYtdlp').textContent = d.ytdlp.path ? `${d.ytdlp.version} · ${d.ytdlp.path}` : 'Not found. Install with: brew install yt-dlp';
    $('factFfmpeg').textContent = d.ffmpeg.path ? `${d.ffmpeg.version} · ${d.ffmpeg.path}` : 'Not found. MP3 conversion and cover art need it: brew install ffmpeg';
    $('factJs').textContent = d.jsRuntime || 'Not found. YouTube needs one: brew install deno';
  }
  schedulePreview(0);
}

// ---------- preview ----------

function schedulePreview(delay) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, delay);
}

async function renderPreview() {
  const scope = document.querySelector('input[name=previewScope]:checked').value;
  const box = $('preview');
  try {
    const res = await api('/preview', {
      body: { url: SAMPLE_URLS[scope], scope, playlistItems: '', options: downloadOptions(settings) },
      timeout: 3000,
    });
    box.textContent = res.command;
    box.classList.remove('err');
  } catch (err) {
    box.textContent = err.code === 'offline' ? 'Start the yt-dlp Bridge app to see the command.' : err.message;
    box.classList.toggle('err', err.code !== 'offline');
  }
}
