'use strict';
// Runs the real API server and queue against a fake yt-dlp script.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { JobQueue } = require('../src/queue');
const { createApiServer } = require('../src/server');
const { runJob } = require('../src/ytdlp');

const PORT = 41890;
const GOOD = 'chrome-extension://kdnempddaodnginhpkpilbagmmimkkbg';
const OTHER = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const FAKE = path.join(__dirname, 'fixtures', 'fake-yt-dlp.js');

function request(method, urlPath, { origin, host = `127.0.0.1:${PORT}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: host };
    if (origin) headers.Origin = origin;
    if (data) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

const jobBody = (over = {}) => ({
  url: 'https://www.youtube.com/playlist?list=PLtest',
  scope: 'playlist',
  title: 'Tab title',
  options: { outputDir: '/tmp/ytb-test-out' },
  ...over,
});

let api;
let approvals = [];
const approved = new Set([GOOD.slice('chrome-extension://'.length)]);
const tools = { env: process.env, ytdlp: { path: FAKE, version: 'fake' }, ffmpeg: { path: null }, jsRuntime: null };
const queue = new JobQueue({ run: (job, onChange) => runJob(job, { tools, onChange }), concurrency: 1 });

test.before(async () => {
  api = createApiServer({
    port: PORT,
    queue,
    appVersion: 'test',
    getTools: () => tools,
    auth: {
      isApproved: (id) => approved.has(id),
      requestApproval: async (id) => { approvals.push(id); return false; },
    },
    actions: { pickFolder: async () => '/picked', openFolder: async () => {}, reveal: () => {} },
  });
  await api.listen();
});
test.after(() => api.close());

test('status is open, but reports approval per extension', async () => {
  const good = await request('GET', '/api/status', { origin: GOOD });
  assert.equal(good.status, 200);
  assert.equal(good.json.app, 'ytdlp-bridge');
  assert.equal(good.json.approved, true);
  assert.equal(good.headers['access-control-allow-origin'], GOOD);
  const anonymous = await request('GET', '/api/status');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.json.approved, null);
  const other = await request('GET', '/api/status', { origin: OTHER });
  assert.equal(other.json.approved, false);
});

test('web pages, other hosts and unapproved extensions are rejected', async () => {
  const before = queue.list().length;
  const web = await request('POST', '/api/jobs', { origin: 'https://evil.example', body: jobBody() });
  assert.equal(web.status, 403);
  const nullOrigin = await request('POST', '/api/jobs', { origin: 'null', body: jobBody() });
  assert.equal(nullOrigin.status, 403);
  const rebinding = await request('POST', '/api/jobs', { origin: GOOD, host: 'evil.example:41890', body: jobBody() });
  assert.equal(rebinding.status, 403);
  const noOrigin = await request('POST', '/api/jobs', { body: jobBody() });
  assert.equal(noOrigin.status, 403);
  const anonymousList = await request('POST', '/api/jobs/list');
  assert.equal(anonymousList.status, 403, 'job list needs an approved extension');
  approvals = [];
  const unapproved = await request('POST', '/api/jobs', { origin: OTHER, body: jobBody() });
  assert.equal(unapproved.status, 403);
  assert.equal(unapproved.json.error, 'not_approved');
  assert.deepEqual(approvals, ['abcdefghijklmnopabcdefghijklmnop'], 'user was asked once');
  assert.equal(queue.list().length, before, 'no job was created');
});

test('invalid options return a readable 400', async () => {
  const res = await request('POST', '/api/jobs', { origin: GOOD, body: jobBody({ options: { outputDir: 'nope' } }) });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /full path/);
});

test('preview returns the exact command without running it', async () => {
  const res = await request('POST', '/api/preview', { origin: GOOD, body: jobBody({ scope: 'single' }) });
  assert.equal(res.status, 200);
  assert.ok(res.json.args.includes('--no-playlist'));
  assert.match(res.json.command, /^\S*fake-yt-dlp\.js .*--audio-format mp3/);
});

test('a playlist job runs, tracks progress and ends as partial when one item fails', async () => {
  const res = await request('POST', '/api/jobs', { origin: GOOD, body: jobBody() });
  assert.equal(res.status, 200);
  const id = res.json.job.id;
  const job = await until(async () => {
    const { json } = await request('POST', '/api/jobs/list', { origin: GOOD });
    const j = json.jobs.find((x) => x.id === id);
    return ['done', 'partial', 'error'].includes(j.status) && j;
  });
  assert.equal(job.status, 'partial');
  assert.equal(job.title, 'Test List');
  assert.deepEqual(job.files, ['/tmp/x/001 - First song.mp3']);
  assert.equal(job.itemCount, 2);
  assert.match(job.error, /403/);
  assert.equal(job.progress, 1);

  const log = await request('POST', `/api/jobs/${id}/log`, { origin: GOOD });
  const argsLine = log.json.log.find((l) => l.startsWith('ARGS '));
  const args = JSON.parse(argsLine.slice(5));
  assert.ok(args.includes('--yes-playlist'));
  assert.equal(args[args.length - 1], 'https://www.youtube.com/playlist?list=PLtest');
});

test('cancel stops a running yt-dlp process', async () => {
  process.env.FAKE_MODE = 'hang';
  try {
    const res = await request('POST', '/api/jobs', { origin: GOOD, body: jobBody() });
    const id = res.json.job.id;
    await until(() => queue.get(id).status === 'running' && queue.get(id).log.length > 1);
    const cancel = await request('POST', `/api/jobs/${id}/cancel`, { origin: GOOD });
    assert.equal(cancel.status, 200);
    await until(() => queue.get(id).status === 'canceled');
  } finally {
    delete process.env.FAKE_MODE;
  }
});

test('clear removes finished jobs; unknown routes and jobs are 404', async () => {
  const cleared = await request('POST', '/api/jobs/clear', { origin: GOOD });
  assert.deepEqual(cleared.json.jobs, []);
  assert.equal((await request('POST', '/api/jobs/nope/cancel', { origin: GOOD })).status, 404);
  assert.equal((await request('GET', '/api/whatever', { origin: GOOD })).status, 404);
});
