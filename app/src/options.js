'use strict';
// Validates the settings sent by the extension and turns them into yt-dlp
// arguments. The extension never sends raw arguments: every value here is
// checked against a fixed list or a strict pattern, and the process is
// spawned without a shell.

const os = require('node:os');
const path = require('node:path');

const CHOICES = {
  mode: ['audio', 'video'],
  audioFormat: ['mp3', 'm4a', 'opus', 'flac', 'wav', 'alac', 'aac', 'vorbis', 'best'],
  audioQuality: ['0', '2', '5', '320K', '256K', '192K', '128K'],
  videoQuality: ['best', '2160', '1440', '1080', '720', '480', '360'],
  videoContainer: ['mp4', 'mkv'],
  cookiesFromBrowser: ['', 'chrome', 'brave', 'edge', 'firefox', 'safari', 'chromium', 'opera', 'vivaldi'],
};

const BOOLEANS = [
  'embedThumbnail', 'squareThumbnail', 'writeThumbnail', 'embedMetadata', 'embedChapters',
  'embedSubs', 'parseArtistTitle', 'playlistAsAlbum', 'useArchive', 'restrictFilenames',
  'sponsorBlock', 'useYtdlpConfig', 'notify', 'overwrite',
];

const DEFAULTS = {
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

const SCOPES = ['single', 'playlist'];
const ARCHIVE_FILE = '.yt-dlp-archive.txt';

// Lines starting with these markers are machine-readable output from the
// --progress-template and --print templates below.
const MARK = { progress: '@@YTB:P ', item: '@@YTB:T ', file: '@@YTB:F ' };
const SQUARE_CROP = `ThumbnailsConvertor:-vf crop="'min(iw,ih)':'min(iw,ih)'"`;
const SPONSORBLOCK_CATEGORIES = 'sponsor,selfpromo,interaction,music_offtopic';

class ValidationError extends Error {}

function fail(message) {
  throw new ValidationError(message);
}

function expandHome(p) {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function checkOutputDir(value) {
  if (typeof value !== 'string' || !value.trim()) fail('Choose a save folder.');
  const dir = expandHome(value.trim());
  if (!path.isAbsolute(dir)) fail('Save folder must be a full path, like /Users/you/Music.');
  if (/[\0\r\n]/.test(dir)) fail('Save folder contains invalid characters.');
  return path.normalize(dir);
}

function checkTemplate(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is empty.`);
  const t = value.trim();
  if (t.length > 300) fail(`${label} is too long.`);
  if (/[\0\r\n]/.test(t)) fail(`${label} contains invalid characters.`);
  if (t.startsWith('/') || t.startsWith('~')) fail(`${label} must be relative to the save folder.`);
  if (t.split(/[\\/]/).includes('..')) fail(`${label} cannot contain "..".`);
  if (!t.includes('%(ext)s')) fail(`${label} must end with .%(ext)s so files get the right extension.`);
  return t;
}

function checkPattern(value, pattern, label, max = 100) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') fail(`${label} is invalid.`);
  const v = value.replace(/\s+/g, '');
  if (v.length > max || !pattern.test(v)) fail(`${label} is invalid.`);
  return v;
}

function normalizeOptions(input = {}) {
  if (typeof input !== 'object' || Array.isArray(input)) fail('Options must be an object.');
  const merged = { ...DEFAULTS, ...input };
  const out = {};
  for (const [key, allowed] of Object.entries(CHOICES)) {
    const v = merged[key];
    if (!allowed.includes(v)) fail(`Unsupported value for ${key}: ${JSON.stringify(v)}`);
    out[key] = v;
  }
  for (const key of BOOLEANS) {
    if (typeof merged[key] !== 'boolean') fail(`${key} must be true or false.`);
    out[key] = merged[key];
  }
  out.outputDir = checkOutputDir(merged.outputDir);
  out.filenameTemplate = checkTemplate(merged.filenameTemplate, 'File name template');
  out.playlistTemplate = checkTemplate(merged.playlistTemplate, 'Playlist file name template');
  out.subLangs = checkPattern(merged.subLangs, /^[\w.*,-]+$/, 'Subtitle languages') || 'en.*';
  out.rateLimit = checkPattern(merged.rateLimit, /^\d+(\.\d+)?[KMG]?$/i, 'Speed limit', 12);
  return out;
}

function checkUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) fail('Link is missing or too long.');
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    fail('That is not a valid link.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('Only http and https links can be downloaded.');
  return u.toString();
}

function normalizeJob(body) {
  if (!body || typeof body !== 'object') fail('Request body must be JSON.');
  const url = checkUrl(body.url);
  const scope = body.scope ?? 'single';
  if (!SCOPES.includes(scope)) fail(`Unsupported scope: ${JSON.stringify(scope)}`);
  const options = normalizeOptions(body.options);
  const playlistItems = scope === 'playlist'
    ? checkPattern(body.playlistItems, /^[\d,:-]+$/, 'Playlist items')
    : '';
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '';
  return { url, scope, options, playlistItems, title };
}

function buildArgs(job) {
  const o = job.options;
  const audio = o.mode === 'audio';
  const playlist = job.scope === 'playlist';
  const a = [];

  if (!o.useYtdlpConfig) a.push('--ignore-config');
  a.push('--newline', '--progress', '--no-quiet', '--color', 'never', '--no-mtime');
  a.push('--retries', '10', '--fragment-retries', '10');
  a.push('--progress-template',
    `download:${MARK.progress}%(progress.{downloaded_bytes,total_bytes,total_bytes_estimate,speed,eta,status,fragment_index,fragment_count})j`);
  a.push('--print', `before_dl:${MARK.item}%(.{id,title,playlist_index,n_entries,playlist_title})j`);
  a.push('--print', `after_move:${MARK.file}%(filepath)j`);

  a.push(playlist ? '--yes-playlist' : '--no-playlist');
  if (playlist && job.playlistItems) a.push('-I', job.playlistItems);

  if (audio) {
    a.push('-f', 'bestaudio/best', '-x');
    if (o.audioFormat !== 'best') a.push('--audio-format', o.audioFormat);
    a.push('--audio-quality', o.audioQuality);
  } else {
    a.push('-f', 'bv*+ba/b');
    // Resolution first, then prefer H.264/AAC in MP4 so files play everywhere.
    const sort = [];
    if (o.videoQuality !== 'best') sort.push(`res:${o.videoQuality}`);
    if (o.videoContainer === 'mp4') sort.push('vcodec:h264', 'acodec:aac');
    if (sort.length) a.push('-S', sort.join(','));
    a.push('--merge-output-format', o.videoContainer);
    if (o.embedSubs) a.push('--write-subs', '--embed-subs', '--sub-langs', o.subLangs);
  }

  if (o.embedThumbnail || o.writeThumbnail) {
    if (o.embedThumbnail) a.push('--embed-thumbnail');
    if (o.writeThumbnail) a.push('--write-thumbnail');
    a.push('--convert-thumbnails', 'jpg');
    if (audio && o.squareThumbnail) a.push('--ppa', SQUARE_CROP);
  }

  if (o.embedMetadata) {
    a.push('--embed-metadata');
    if (!o.embedChapters) a.push('--no-embed-chapters');
    if (o.parseArtistTitle) a.push('--parse-metadata', 'title:%(artist)s - %(title)s');
    if (playlist && o.playlistAsAlbum) {
      a.push('--parse-metadata', '%(album,playlist_title)s:%(album)s');
      a.push('--parse-metadata', '%(track_number,playlist_index)s:%(track_number)s');
    }
  } else if (o.embedChapters) {
    a.push('--embed-chapters');
  }

  if (o.sponsorBlock) a.push('--sponsorblock-remove', SPONSORBLOCK_CATEGORIES);
  if (o.cookiesFromBrowser) a.push('--cookies-from-browser', o.cookiesFromBrowser);
  if (o.rateLimit) a.push('-r', o.rateLimit);
  if (o.restrictFilenames) a.push('--restrict-filenames');
  // Delete and download again when the file exists. yt-dlp checks the archive
  // before this, so the archive is not used while overwriting.
  if (o.overwrite) a.push('--force-overwrites');
  else if (playlist && o.useArchive) a.push('--download-archive', path.join(o.outputDir, ARCHIVE_FILE));

  a.push('-P', o.outputDir);
  a.push('-o', playlist ? o.playlistTemplate : o.filenameTemplate);
  a.push('--', job.url);
  return a;
}

// Quote args for display only (the command preview). Never used to run anything.
function formatCommand(binary, args) {
  const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [binary, ...args].map(q).join(' ');
}

module.exports = {
  CHOICES, BOOLEANS, DEFAULTS, SCOPES, MARK, ARCHIVE_FILE,
  ValidationError, normalizeOptions, normalizeJob, buildArgs, formatCommand, expandHome,
};
