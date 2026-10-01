'use strict';
// Finds yt-dlp and ffmpeg, runs yt-dlp for a job, and turns its output into
// job state (progress, current item, finished files, errors).

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { MARK, buildArgs } = require('./options');

const execFileP = promisify(execFile);
const LOG_LIMIT = 400;

const home = os.homedir();
// Apps started from Finder get a minimal PATH, so Homebrew, pipx and the JS
// runtimes yt-dlp needs for YouTube (deno, node, bun) would be missing.
const COMMON_DIRS = [
  '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin',
  `${home}/.local/bin`, `${home}/bin`, `${home}/.deno/bin`, `${home}/.bun/bin`,
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];

// Reads PATH from the user's login shell. An interactive zsh ignores SIGTERM,
// and its startup files can block (for example on a macOS permission prompt),
// so run it in its own process group and SIGKILL the group on timeout.
function shellPath(flags, timeoutMs) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    let out = '';
    let child;
    try {
      child = spawn(shell, [flags, 'printf "@@PATH@@%s@@PATH@@" "$PATH"'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch {
      return resolve([]);
    }
    const finish = () => {
      clearTimeout(timer);
      const m = out.match(/@@PATH@@(.*?)@@PATH@@/s);
      resolve(m ? m[1].split(':') : []);
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      finish();
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', finish);
    child.on('close', finish);
  });
}

async function loginShellPath() {
  const interactive = await shellPath('-ilc', 3000);
  return interactive.length ? interactive : shellPath('-lc', 3000);
}

async function buildEnv() {
  const dirs = [...(await loginShellPath()), ...COMMON_DIRS, ...(process.env.PATH || '').split(':')];
  const PATH = [...new Set(dirs.filter((d) => d && path.isAbsolute(d)))].join(':');
  return { ...process.env, PATH, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findInPath(name, envPath) {
  for (const dir of envPath.split(':')) {
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

async function version(binary, args, env) {
  try {
    const { stdout } = await execFileP(binary, args, { env, timeout: 15000 });
    return stdout.split('\n')[0].trim();
  } catch {
    return null;
  }
}

// Returns everything needed to run jobs. `ytdlpPath` is an optional override.
async function probe({ ytdlpPath } = {}) {
  const env = await buildEnv();
  const ytdlp = ytdlpPath && isExecutable(ytdlpPath) ? ytdlpPath : findInPath('yt-dlp', env.PATH);
  const ffmpeg = findInPath('ffmpeg', env.PATH);
  const jsRuntime = ['deno', 'node', 'bun'].map((n) => findInPath(n, env.PATH)).find(Boolean) || null;
  const [ytdlpVersion, ffmpegVersion] = await Promise.all([
    ytdlp ? version(ytdlp, ['--version'], env) : null,
    ffmpeg ? version(ffmpeg, ['-version'], env) : null,
  ]);
  return {
    env,
    ytdlp: { path: ytdlp, version: ytdlpVersion },
    ffmpeg: { path: ffmpeg, version: ffmpegVersion && ffmpegVersion.replace(/^ffmpeg version (\S+).*/, '$1') },
    jsRuntime,
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pushLog(job, line) {
  job.log.push(line);
  if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT);
}

// Updates `job` from one line of yt-dlp output.
function applyLine(job, line) {
  if (line.startsWith(MARK.progress)) {
    const p = parseJson(line.slice(MARK.progress.length));
    if (!p) return;
    const total = p.total_bytes || p.total_bytes_estimate;
    let frac = null;
    if (total && p.downloaded_bytes != null) frac = p.downloaded_bytes / total;
    else if (p.fragment_count && p.fragment_index != null) frac = p.fragment_index / p.fragment_count;
    if (p.status === 'finished') frac = 1;
    if (frac != null) job.partProgress = Math.max(0, Math.min(1, frac));
    job.speed = typeof p.speed === 'number' ? p.speed : null;
    job.eta = typeof p.eta === 'number' ? p.eta : null;
    job.phase = 'downloading';
    return;
  }
  if (line.startsWith(MARK.item)) {
    const info = parseJson(line.slice(MARK.item.length));
    if (!info) return;
    job.currentTitle = info.title || info.id || job.currentTitle;
    if (job.scope === 'single' && info.title) job.title = info.title;
    if (info.playlist_title && job.scope === 'playlist') job.playlistTitle = info.playlist_title;
    if (info.n_entries && job.scope === 'playlist') job.itemCount = info.n_entries;
    return;
  }
  if (line.startsWith(MARK.file)) {
    const file = parseJson(line.slice(MARK.file.length));
    if (typeof file === 'string' && !job.files.includes(file)) job.files.push(file);
    job.phase = 'processing';
    return;
  }

  pushLog(job, line);
  let m;
  if ((m = line.match(/^\[download\] Downloading item (\d+) of (\d+)/))) {
    job.itemIndex = Number(m[1]);
    job.itemCount = Number(m[2]);
    job.partProgress = 0;
    job.partIndex = 0;
  } else if ((m = line.match(/^\[download\] Downloading playlist: (.+)$/))) {
    job.playlistTitle = m[1].trim();
  } else if ((m = line.match(/Downloading (\d+) items of (\d+)/))) {
    job.itemCount = Number(m[1]);
  } else if ((m = line.match(/^\[info\] .*: Downloading \d+ format\(s\): (\S+)/))) {
    job.parts = m[1].split('+').length;
    job.partIndex = 0;
    job.partProgress = 0;
  } else if (/^\[download\] Destination: /.test(line)) {
    job.partIndex = Math.min((job.partIndex || 0) + 1, job.parts || 1);
    job.partProgress = 0;
  } else if (/has already been recorded in the archive/.test(line)) {
    job.skipped += 1;
  } else if (/^\[download\] .+ has already been downloaded$/.test(line)) {
    job.existing += 1;
  } else if (line.startsWith('Deleting existing file ')) {
    job.replaced += 1;
  } else if (line.startsWith('ERROR:')) {
    job.errors.push({ item: job.currentTitle || '', message: line.slice(6).trim() });
  } else if (/^\[(ExtractAudio|Merger|EmbedThumbnail|Metadata|FixupM\w+|ThumbnailsConvertor|VideoConvertor|VideoRemuxer|SponsorBlock|ModifyChapters|EmbedSubtitle|FFmpeg\w*)\]/.test(line)) {
    job.phase = 'processing';
  }
}

// Progress of the whole job from 0 to 1.
function jobProgress(job) {
  if (job.status === 'done' || job.status === 'partial') return 1;
  const parts = job.parts || 1;
  const done = Math.max(0, (job.partIndex || 1) - 1);
  const item = Math.min(1, (done + (job.partProgress || 0)) / parts);
  if (!job.itemCount) return item;
  return Math.min(1, (Math.max(0, (job.itemIndex || 1) - 1) + item) / job.itemCount);
}

function splitLines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r\n|\n|\r/);
    buf = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line);
  });
  stream.on('end', () => {
    if (buf.trim()) onLine(buf);
    buf = '';
  });
}

// Starts yt-dlp for `job`. Returns { done: Promise<{code, signal}>, kill() }.
function runJob(job, { tools, onChange }) {
  if (!tools.ytdlp.path) {
    const err = new Error('yt-dlp was not found. Install it with "brew install yt-dlp", then choose "Check yt-dlp again" in the menu bar.');
    return { done: Promise.reject(err), kill() {} };
  }
  const args = buildArgs(job);
  job.command = [tools.ytdlp.path, ...args];
  pushLog(job, `$ ${job.command.join(' ')}`);

  // detached: yt-dlp and the ffmpeg processes it starts share one process
  // group, so cancel can stop all of them.
  const child = spawn(tools.ytdlp.path, args, { env: tools.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const onLine = (line) => {
    applyLine(job, line);
    onChange();
  };
  splitLines(child.stdout, onLine);
  splitLines(child.stderr, onLine);

  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  let killTimer = null;
  const signalGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  done.finally(() => clearTimeout(killTimer)).catch(() => {});

  return {
    done,
    kill() {
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 5000);
    },
  };
}

module.exports = { probe, buildEnv, findInPath, applyLine, jobProgress, runJob, splitLines };
