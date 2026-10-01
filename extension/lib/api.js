// Talks to the yt-dlp Bridge menu bar app on 127.0.0.1.

import { loadSettings, downloadOptions } from './settings.js';

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const OFFLINE_MESSAGE = 'The yt-dlp Bridge app is not running. Open it from your Applications folder; it lives in the menu bar.';

// Always POST: Chrome only sends the extension's Origin header on POST, and
// the app uses that header to know which extension is calling.
export async function api(path, { body, port, timeout = 8000 } = {}) {
  const p = port || (await loadSettings()).port;
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${p}/api${path}`, {
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Pairing and the folder picker wait for the user, so they pass timeout: 0.
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
  } catch {
    throw new BridgeError('offline', OFFLINE_MESSAGE);
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new BridgeError('offline', `Port ${p} answered, but it is not the yt-dlp Bridge app.`);
  if (!res.ok) throw new BridgeError(data.error || `http_${res.status}`, data.message || `Request failed (${res.status}).`);
  return data;
}

// Returns { state, message, data } where state is one of:
// ok | offline | not_approved | no_ytdlp
export async function getStatus(port) {
  try {
    const data = await api('/status', { port, timeout: 2500 });
    if (data.app !== 'ytdlp-bridge') {
      return { state: 'offline', message: 'Another program is using this port.', data: null };
    }
    if (data.approved === false) {
      return { state: 'not_approved', message: 'Allow this extension in the yt-dlp Bridge app.', data };
    }
    if (!data.ytdlp || !data.ytdlp.path) {
      return { state: 'no_ytdlp', message: 'yt-dlp was not found. Install it with: brew install yt-dlp', data };
    }
    return { state: 'ok', message: `Connected · yt-dlp ${data.ytdlp.version || ''}`.trim(), data };
  } catch (err) {
    return { state: 'offline', message: err.message, data: null };
  }
}

export async function pair(port) {
  return api('/pair', { port, timeout: 0 });
}

export async function sendDownload({ url, scope, title = '', playlistItems = '' }) {
  const settings = await loadSettings();
  const body = { url, scope, title, playlistItems, options: downloadOptions(settings) };
  // The first call may show an approval dialog in the app, so allow time for it.
  return api('/jobs', { body, port: settings.port, timeout: 0 });
}
