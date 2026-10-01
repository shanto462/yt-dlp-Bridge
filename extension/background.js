// Service worker: right-click menu, keyboard shortcut, and the toolbar badge
// that shows download progress.

import { loadSettings, saveSettings, formatSummary } from './lib/settings.js';
import { describeUrl, resolveScope } from './lib/detect.js';
import { api, sendDownload } from './lib/api.js';

const CONTEXTS = ['page', 'link', 'video', 'audio'];

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await buildMenus();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  buildMenus();
  watchDownloads();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) buildMenus();
});

async function buildMenus() {
  const s = await loadSettings();
  await chrome.contextMenus.removeAll();
  const add = (props) => chrome.contextMenus.create({ contexts: CONTEXTS, ...props });
  add({ id: 'root', title: 'yt-dlp Bridge' });
  add({ id: 'single', parentId: 'root', title: 'Download' });
  add({ id: 'playlist', parentId: 'root', title: 'Download whole playlist' });
  add({ id: 'sep1', parentId: 'root', type: 'separator' });
  add({ id: 'mode-audio', parentId: 'root', type: 'radio', checked: s.mode === 'audio', title: `Audio: ${formatSummary({ ...s, mode: 'audio' })}` });
  add({ id: 'mode-video', parentId: 'root', type: 'radio', checked: s.mode === 'video', title: `Video: ${formatSummary({ ...s, mode: 'video' })}` });
  add({ id: 'sep2', parentId: 'root', type: 'separator' });
  add({ id: 'settings', parentId: 'root', title: 'Settings…' });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'mode-audio' || info.menuItemId === 'mode-video') {
    await saveSettings({ mode: info.menuItemId.slice(5) });
    return;
  }
  if (info.menuItemId === 'settings') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === 'single' || info.menuItemId === 'playlist') {
    // A right-clicked link wins over the page. <video>/<audio> sources are
    // usually blob: URLs, so fall back to the page for those.
    const url = info.linkUrl || info.pageUrl;
    const title = url === tab?.url ? tab.title : '';
    await download(url, title, info.menuItemId);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'download-current' || !tab) return;
  await download(tab.url, tab.title, null);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'watch-downloads') watchDownloads();
});

async function download(url, title, wantedScope) {
  const info = describeUrl(url);
  if (!info.ok) {
    notify('Nothing to download here', info.note);
    return;
  }
  const scope = resolveScope(info, wantedScope || info.defaultScope);
  try {
    await sendDownload({ url, scope, title });
    flashBadge('✓');
    watchDownloads();
  } catch (err) {
    flashBadge('!');
    notify('Download not started', err.message);
  }
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: message || '' });
}

async function flashBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#d33a3a' : '#1e9e57' });
  await chrome.action.setBadgeText({ text });
}

// Polls the app while downloads are active and shows progress on the badge.
// Each extension API call keeps the service worker alive, so this runs until
// all downloads finish.
let watching = false;
async function watchDownloads() {
  if (watching) return;
  watching = true;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      let jobs;
      try {
        ({ jobs } = await api('/jobs/list', { timeout: 3000 }));
      } catch {
        break;
      }
      const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
      if (!active.length) break;
      const running = active.filter((j) => j.status === 'running');
      const pct = running.length ? Math.round((running.reduce((s, j) => s + j.progress, 0) / running.length) * 100) : 0;
      await chrome.action.setBadgeBackgroundColor({ color: '#dc2f3f' });
      await chrome.action.setBadgeText({ text: active.length > 1 ? `${active.length}` : `${pct}%` });
      await chrome.action.setTitle({ title: `yt-dlp Bridge: ${active.length} active download${active.length > 1 ? 's' : ''}` });
    }
  } finally {
    watching = false;
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'yt-dlp Bridge' });
  }
}
