// All download settings live here, in chrome.storage.local. They are sent to
// the menu bar app with every download. Keep keys in sync with
// app/src/options.js (a test in app/test checks this).

export const DEFAULT_PORT = 41769;

export const DEFAULTS = {
  mode: 'audio',
  audioFormat: 'mp3',
  audioQuality: '0',
  videoQuality: '1080',
  videoContainer: 'mp4',
  embedThumbnail: true,
  squareThumbnail: true,
  writeThumbnail: false,
  embedMetadata: true,
  embedChapters: true,
  embedSubs: false,
  subLangs: 'en.*',
  parseArtistTitle: false,
  playlistAsAlbum: true,
  outputDir: '~/Downloads',
  filenameTemplate: '%(title)s.%(ext)s',
  playlistTemplate: '%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s',
  overwrite: true,
  useArchive: false,
  restrictFilenames: false,
  cookiesFromBrowser: '',
  sponsorBlock: false,
  rateLimit: '',
  useYtdlpConfig: false,
  notify: true,
};

// Extension-only settings (not sent as download options).
export const LOCAL_DEFAULTS = { port: DEFAULT_PORT };

export const AUDIO_FORMATS = [
  ['mp3', 'MP3'],
  ['m4a', 'M4A (AAC)'],
  ['opus', 'Opus'],
  ['flac', 'FLAC (lossless)'],
  ['alac', 'ALAC (Apple lossless)'],
  ['wav', 'WAV'],
  ['aac', 'AAC'],
  ['vorbis', 'Ogg Vorbis'],
  ['best', 'Original (no conversion)'],
];
// Quality does not apply to these: they are lossless or not re-encoded.
export const NO_QUALITY_FORMATS = ['flac', 'alac', 'wav', 'best'];

export const AUDIO_QUALITIES = [
  ['0', 'Best (VBR ~245 kbps)'],
  ['2', 'High (VBR ~190 kbps)'],
  ['5', 'Medium (VBR ~130 kbps)'],
  ['320K', '320 kbps'],
  ['256K', '256 kbps'],
  ['192K', '192 kbps'],
  ['128K', '128 kbps'],
];

export const VIDEO_QUALITIES = [
  ['best', 'Best available'],
  ['2160', '4K (2160p)'],
  ['1440', '1440p'],
  ['1080', '1080p'],
  ['720', '720p'],
  ['480', '480p'],
  ['360', '360p'],
];

export const VIDEO_CONTAINERS = [
  ['mp4', 'MP4 (plays everywhere)'],
  ['mkv', 'MKV (keeps any codec)'],
];

export const COOKIE_BROWSERS = [
  ['', 'Off'],
  ['chrome', 'Chrome'],
  ['brave', 'Brave'],
  ['edge', 'Edge'],
  ['chromium', 'Chromium'],
  ['opera', 'Opera'],
  ['vivaldi', 'Vivaldi'],
  ['firefox', 'Firefox'],
  ['safari', 'Safari'],
];

export const FILENAME_PRESETS = [
  ['%(title)s.%(ext)s', 'Title'],
  ['%(artist,uploader)s - %(track,title)s.%(ext)s', 'Artist - Title'],
  ['%(uploader)s/%(title)s.%(ext)s', 'Channel folder / Title'],
  ['%(upload_date>%Y-%m-%d)s - %(title)s.%(ext)s', 'Upload date - Title'],
  ['%(title)s [%(id)s].%(ext)s', 'Title [video ID]'],
];

export const PLAYLIST_PRESETS = [
  ['%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s', 'Playlist folder / 001 - Title'],
  ['%(playlist_title)s/%(title)s.%(ext)s', 'Playlist folder / Title'],
  ['%(playlist_title)s/%(artist,uploader)s - %(track,title)s.%(ext)s', 'Playlist folder / Artist - Title'],
  ['%(playlist_index)03d - %(title)s.%(ext)s', 'No folder / 001 - Title'],
  ['%(title)s.%(ext)s', 'No folder / Title'],
];

export const label = (list, value) => (list.find(([v]) => v === value) || [value, value])[1];

export async function loadSettings() {
  const { settings = {}, local = {} } = await chrome.storage.local.get(['settings', 'local']);
  return { ...DEFAULTS, ...pick(settings, DEFAULTS), ...LOCAL_DEFAULTS, ...pick(local, LOCAL_DEFAULTS) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: pick(next, DEFAULTS), local: pick(next, LOCAL_DEFAULTS) });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.remove(['settings', 'local']);
  return loadSettings();
}

// The download options sent to the app.
export function downloadOptions(settings) {
  return pick(settings, DEFAULTS);
}

// Short summary such as "MP3 · best" or "1080p MP4".
export function formatSummary(s) {
  if (s.mode === 'video') {
    const q = s.videoQuality === 'best' ? 'Best' : label(VIDEO_QUALITIES, s.videoQuality).replace(/ \(.*/, '');
    return `${q} ${s.videoContainer.toUpperCase()}`;
  }
  const fmt = s.audioFormat === 'best' ? 'Original audio' : label(AUDIO_FORMATS, s.audioFormat).replace(/ \(.*/, '');
  if (NO_QUALITY_FORMATS.includes(s.audioFormat)) return fmt;
  return `${fmt} ${label(AUDIO_QUALITIES, s.audioQuality).replace(/ \(.*/, '').toLowerCase()}`;
}

function pick(obj, shape) {
  const out = {};
  for (const key of Object.keys(shape)) if (key in obj && typeof obj[key] === typeof shape[key]) out[key] = obj[key];
  return out;
}
