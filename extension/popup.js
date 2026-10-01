import {
  loadSettings, saveSettings, label,
  AUDIO_FORMATS, AUDIO_QUALITIES, VIDEO_QUALITIES, VIDEO_CONTAINERS, NO_QUALITY_FORMATS,
} from './lib/settings.js';
import { describeUrl } from './lib/detect.js';
import { api, getStatus, pair, sendDownload } from './lib/api.js';

const $ = (id) => document.getElementById(id);
const ICONS = {
  cancel: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>',
  retry: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 10a5.5 5.5 0 1 1-1.8-4.1"/><path d="M15.5 3.5v3.2h-3.2"/></svg>',
  folder: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2h6.6a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
};
const FINISHED = ['done', 'partial', 'error', 'canceled'];

let settings;
let tab = null;
let info = describeUrl('');
let scope = 'single';
let status = { state: 'checking' };
const jobEls = new Map();

init();

async function init() {
  settings = await loadSettings();
  fill($('audioFormat'), AUDIO_FORMATS);
  // Short names fit the narrow popup; the settings page shows the full ones.
  fill($('audioQuality'), AUDIO_QUALITIES.map(([v, text]) => [v, text.replace(/ \(.*\)/, '')]));
  fill($('videoQuality'), VIDEO_QUALITIES);
  fill($('videoContainer'), VIDEO_CONTAINERS.map(([v]) => [v, v.toUpperCase()]));

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('link').value = tab && /^https?:/.test(tab.url || '') ? tab.url : '';

  bindEvents();
  renderSettings();
  updateTarget(true);
  refreshStatus();
  refreshJobs();
  setInterval(refreshJobs, 1000);
}

function fill(select, options) {
  select.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
}

function bindEvents() {
  $('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('link').addEventListener('input', () => updateTarget(true));
  for (const r of document.querySelectorAll('input[name=scope]')) {
    r.addEventListener('change', () => {
      scope = r.value;
      updateTarget(false);
    });
  }
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.addEventListener('change', () => update({ mode: r.value }));
  }
  for (const id of ['audioFormat', 'audioQuality', 'videoQuality', 'videoContainer']) {
    $(id).addEventListener('change', () => update({ [id]: $(id).value }));
  }
  for (const id of ['embedThumbnail', 'embedMetadata', 'overwrite']) {
    $(id).addEventListener('change', () => update({ [id]: $(id).checked }));
  }
  $('changeFolder').addEventListener('click', chooseFolder);
  $('download').addEventListener('click', startDownload);
  $('clearJobs').addEventListener('click', async () => {
    await api('/jobs/clear').catch(() => {});
    refreshJobs();
  });
}

async function update(patch) {
  settings = await saveSettings(patch);
  renderSettings();
  updateTarget(false);
}

function renderSettings() {
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === settings.mode;
  for (const id of ['audioFormat', 'audioQuality', 'videoQuality', 'videoContainer']) $(id).value = settings[id];
  $('embedThumbnail').checked = settings.embedThumbnail;
  $('embedMetadata').checked = settings.embedMetadata;
  $('overwrite').checked = settings.overwrite;
  $('audioRow').hidden = settings.mode !== 'audio';
  $('videoRow').hidden = settings.mode !== 'video';
  $('audioQuality').disabled = NO_QUALITY_FORMATS.includes(settings.audioFormat);
  $('folderPath').textContent = `‎${settings.outputDir}‎`;
  $('folderPath').title = settings.outputDir;
}

function updateTarget(resetScope) {
  const url = $('link').value.trim();
  info = describeUrl(url);
  const isTab = tab && url === tab.url;
  // Show the tab title for the current page; a pasted link has no title yet.
  $('pageTitle').textContent = isTab && tab.title ? tab.title : '';
  $('pageTitle').hidden = !(isTab && tab.title);
  $('kind').textContent = info.label;
  $('kind').classList.toggle('off', !info.ok);
  $('site').textContent = info.ok && info.site ? info.site : '';
  $('note').textContent = info.note;
  $('note').hidden = !info.note;

  if (resetScope || (scope === 'single' && !info.canSingle) || (scope === 'playlist' && !info.canPlaylist)) {
    scope = info.defaultScope;
  }
  $('singleLabel').textContent = info.singleLabel;
  $('playlistLabel').textContent = info.playlistLabel;
  for (const r of document.querySelectorAll('input[name=scope]')) {
    r.checked = r.value === scope;
    r.disabled = r.value === 'single' ? !info.canSingle : !info.canPlaylist;
  }
  $('scopeGroup').hidden = !info.ok;
  $('itemsRow').hidden = scope !== 'playlist';

  const btn = $('download');
  btn.disabled = !info.ok;
  btn.textContent = info.ok ? downloadLabel() : 'Nothing to download';
}

function downloadLabel() {
  const s = settings;
  const what = s.mode === 'audio'
    ? (s.audioFormat === 'best' ? 'original audio' : label(AUDIO_FORMATS, s.audioFormat).replace(/ \(.*/, ''))
    : `${s.videoQuality === 'best' ? 'best' : `${s.videoQuality}p`} ${s.videoContainer.toUpperCase()}`;
  if (scope !== 'playlist') return `Download as ${what}`;
  const noun = info.kind === 'channel' ? 'all' : /album/i.test(info.playlistLabel) ? 'album' : 'playlist';
  return `Download ${noun} as ${what}`;
}

function setFeedback(text, kind = '') {
  $('feedback').textContent = text;
  $('feedback').className = `feedback small ${kind}`;
}

async function chooseFolder() {
  try {
    const res = await api('/pick-folder', { body: { defaultPath: settings.outputDir }, timeout: 0 });
    if (res.path) await update({ outputDir: res.path });
  } catch (err) {
    setFeedback(err.code === 'offline' ? 'Start the yt-dlp Bridge app to choose a folder.' : err.message, 'err');
  }
}

async function startDownload() {
  const btn = $('download');
  btn.disabled = true;
  setFeedback('Sending to yt-dlp…');
  try {
    const url = $('link').value.trim();
    const title = tab && url === tab.url ? tab.title : '';
    const playlistItems = scope === 'playlist' ? $('playlistItems').value.trim() : '';
    await sendDownload({ url, scope, title, playlistItems });
    setFeedback('Started. You can close this popup; the download keeps going.', 'ok');
    chrome.runtime.sendMessage({ type: 'watch-downloads' }).catch(() => {});
    refreshJobs();
  } catch (err) {
    setFeedback(err.message, 'err');
    if (err.code === 'offline' || err.code === 'not_approved') refreshStatus();
  } finally {
    btn.disabled = !info.ok;
  }
}

// ---------- connection status ----------

async function refreshStatus() {
  status = await getStatus(settings.port);
  const dot = $('statusDot');
  const text = {
    ok: 'Ready',
    offline: 'App not running',
    not_approved: 'Not allowed yet',
    no_ytdlp: 'yt-dlp missing',
  }[status.state];
  dot.className = `dot ${status.state === 'ok' ? 'ok' : status.state === 'not_approved' ? 'warn' : 'err'}`;
  $('statusText').textContent = text;
  $('status').title = status.message;

  const banner = $('banner');
  const action = $('bannerAction');
  action.hidden = true;
  banner.className = 'callout err';
  banner.hidden = status.state === 'ok' && Boolean(status.data.ffmpeg.path);
  if (status.state === 'offline') {
    $('bannerText').textContent = status.message;
    action.hidden = false;
    action.textContent = 'Setup help';
    action.onclick = () => chrome.runtime.openOptionsPage();
  } else if (status.state === 'not_approved') {
    banner.className = 'callout warn';
    $('bannerText').textContent = 'The yt-dlp Bridge app has not allowed this extension yet.';
    action.hidden = false;
    action.textContent = 'Ask the app for access';
    action.onclick = async () => {
      action.disabled = true;
      await pair(settings.port).catch((err) => setFeedback(err.message, 'err'));
      action.disabled = false;
      refreshStatus();
    };
  } else if (status.state === 'no_ytdlp') {
    $('bannerText').textContent = 'yt-dlp was not found on this Mac. Install it with "brew install yt-dlp", then choose yt-dlp → Check Again in the menu bar app.';
  } else if (status.state === 'ok' && !status.data.ffmpeg.path) {
    banner.className = 'callout warn';
    $('bannerText').textContent = 'ffmpeg was not found. Converting to MP3 and adding cover art need it: brew install ffmpeg';
  }
}

// ---------- downloads list ----------

async function refreshJobs() {
  let jobs;
  try {
    ({ jobs } = await api('/jobs/list', { timeout: 2500 }));
  } catch {
    $('jobsSection').hidden = true;
    return;
  }
  if (status.state === 'offline') refreshStatus();
  renderJobs(jobs.slice(0, 20));
  $('clearJobs').hidden = !jobs.some((j) => FINISHED.includes(j.status));
}

function renderJobs(jobs) {
  const list = $('jobs');
  $('jobsSection').hidden = !jobs.length;
  const ids = new Set(jobs.map((j) => j.id));
  for (const [id, el] of jobEls) {
    if (!ids.has(id)) {
      el.remove();
      jobEls.delete(id);
    }
  }
  jobs.forEach((job, i) => {
    let el = jobEls.get(job.id);
    if (!el) {
      el = createJobEl(job.id);
      jobEls.set(job.id, el);
    }
    updateJobEl(el, job);
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
}

function iconButton(name, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = ICONS[name];
  b.addEventListener('click', onClick);
  return b;
}

function createJobEl(id) {
  const li = document.createElement('li');
  li.className = 'job';
  const top = document.createElement('div');
  top.className = 'job-top';
  const title = document.createElement('div');
  title.className = 'job-title';
  const actions = document.createElement('div');
  actions.className = 'job-actions';
  const post = (action) => () => api(`/jobs/${id}/${action}`).then(refreshJobs).catch(() => {});
  li.buttons = {
    reveal: iconButton('folder', 'Show in Finder', post('reveal')),
    retry: iconButton('retry', 'Retry', post('retry')),
    cancel: iconButton('cancel', 'Cancel', post('cancel')),
  };
  actions.append(li.buttons.reveal, li.buttons.retry, li.buttons.cancel);
  top.append(title, actions);
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.append(document.createElement('span'));
  const meta = document.createElement('div');
  meta.className = 'job-meta';
  li.append(top, bar, meta);
  li.parts = { title, bar, meta };
  return li;
}

function updateJobEl(el, job) {
  const { title, bar, meta } = el.parts;
  const finished = FINISHED.includes(job.status);
  title.textContent = job.title;
  title.title = job.currentTitle && job.currentTitle !== job.title ? `Now: ${job.currentTitle}` : job.url;
  el.buttons.cancel.hidden = finished;
  el.buttons.retry.hidden = !['error', 'partial', 'canceled'].includes(job.status);
  el.buttons.reveal.hidden = !(job.files.length || job.status === 'running');

  bar.hidden = finished;
  const busy = job.status === 'queued' || job.phase === 'starting' || job.phase === 'processing';
  bar.classList.toggle('indeterminate', busy && job.progress === 0);
  bar.firstChild.style.width = `${Math.round(job.progress * 100)}%`;

  const counter = job.itemCount > 1 ? `${Math.min(job.itemIndex || 1, job.itemCount)} of ${job.itemCount}` : '';
  let text = '';
  let kind = '';
  if (job.status === 'queued') text = 'Waiting for a free slot…';
  else if (job.phase === 'canceling') text = 'Stopping…';
  else if (job.status === 'running' && job.phase === 'starting') text = 'Starting yt-dlp…';
  else if (job.status === 'running' && job.phase === 'processing') text = join('Converting and tagging…', counter);
  else if (job.status === 'running') {
    text = join(`${Math.round(job.progress * 100)}%`, speed(job.speed), eta(job.eta), counter);
  } else if (job.status === 'done') {
    kind = 'ok';
    const n = job.files.length;
    if (n === 1 && job.existing && !job.replaced) {
      text = 'Already downloaded. Kept the existing file.';
    } else {
      text = join(
        n > 1 ? `Saved ${n} files` : 'Saved',
        job.replaced ? `replaced ${job.replaced > 1 ? `${job.replaced} existing files` : 'existing file'}` : '',
        n > 1 && job.existing ? `${job.existing} already existed` : '',
        job.skipped ? `${job.skipped} skipped (in archive)` : '',
      );
    }
  } else if (job.status === 'partial') {
    kind = 'warn';
    text = `Saved ${job.files.length}, failed ${job.errors.length || 'some'}. ${job.errors.at(-1)?.message || job.error}`;
  } else if (job.status === 'error') {
    kind = 'err';
    text = job.error;
  } else if (job.status === 'canceled') {
    text = 'Canceled';
  }
  meta.textContent = text;
  meta.className = `job-meta ${kind}`;
}

const join = (...parts) => parts.filter(Boolean).join(' · ');

function speed(bps) {
  if (!bps) return '';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let v = bps;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function eta(s) {
  if (s == null || !Number.isFinite(s)) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec} left` : `${m}:${sec} left`;
}
