'use strict';
// Local HTTP API used by the browser extension. Listens on 127.0.0.1 only.
//
// Who may call it:
//  - The Host header must be 127.0.0.1 or localhost (blocks DNS rebinding).
//  - Web pages are always rejected: their Origin is never chrome-extension://.
//  - Each extension ID must be approved once (see auth.requestApproval).
//  - Chrome sends Origin from extensions only on POST, so every call that
//    needs to know the caller is a POST. GET /status is anonymous (for curl).

const http = require('node:http');
const { ValidationError, normalizeJob, buildArgs, formatCommand } = require('./options');
const { toPublic } = require('./queue');

const BODY_LIMIT = 64 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'too_large', 'Request body is too large.'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'bad_json', 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

// deps:
//   port, queue, appVersion
//   getTools()                 -> result of ytdlp.probe()
//   auth.isApproved(id)        -> boolean
//   auth.requestApproval(id)   -> Promise<boolean> (asks the user)
//   actions.pickFolder(defaultPath) -> Promise<string|null>
//   actions.openFolder(path)   -> Promise<void>
//   actions.reveal(job)        -> void
function createApiServer(deps) {
  const { port, queue, auth, actions, getTools, appVersion } = deps;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function statusPayload(extensionId) {
    const tools = getTools();
    return {
      app: 'ytdlp-bridge',
      version: appVersion,
      approved: extensionId ? auth.isApproved(extensionId) : null,
      ytdlp: tools.ytdlp,
      ffmpeg: tools.ffmpeg,
      jsRuntime: tools.jsRuntime,
      concurrency: queue.concurrency,
      active: queue.activeCount(),
    };
  }

  async function requireApproved(extensionId) {
    if (!extensionId) throw new HttpError(403, 'forbidden', 'Only the yt-dlp Bridge browser extension can do this.');
    if (auth.isApproved(extensionId)) return;
    const ok = await auth.requestApproval(extensionId);
    if (!ok) throw new HttpError(403, 'not_approved', 'This extension was not allowed in the yt-dlp Bridge app.');
  }

  function findJob(id) {
    const job = queue.get(id);
    if (!job) throw new HttpError(404, 'not_found', 'Download not found.');
    return job;
  }

  async function route(req, extensionId) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    if (parts[0] !== 'api') throw new HttpError(404, 'not_found', 'Not found.');
    const key = `${req.method} /${parts.slice(1).join('/')}`;

    // Status is readable without approval so the extension can show setup help.
    if (key === 'GET /status' || key === 'POST /status') return statusPayload(extensionId);

    if (key === 'POST /pair') {
      await requireApproved(extensionId);
      return statusPayload(extensionId);
    }

    await requireApproved(extensionId);

    if (key === 'POST /jobs/list') return { jobs: queue.list() };

    if (key === 'POST /jobs') {
      const spec = normalizeJob(await readJson(req));
      return { job: toPublic(queue.add(spec)) };
    }

    if (key === 'POST /preview') {
      const spec = normalizeJob(await readJson(req));
      const binary = getTools().ytdlp.path || 'yt-dlp';
      const args = buildArgs(spec);
      return { args, command: formatCommand(binary, args) };
    }

    if (key === 'POST /jobs/clear') {
      queue.clearFinished();
      return { jobs: queue.list() };
    }

    if (req.method === 'POST' && parts[1] === 'jobs' && parts.length === 4) {
      const job = findJob(parts[2]);
      if (parts[3] === 'log') return { log: job.log, command: job.command };
      if (parts[3] === 'cancel') return { job: toPublic(queue.cancel(job.id)) };
      if (parts[3] === 'retry') return { job: toPublic(queue.retry(job.id)) };
      if (parts[3] === 'reveal') {
        actions.reveal(job);
        return { ok: true };
      }
    }

    if (key === 'POST /pick-folder') {
      const body = await readJson(req);
      const picked = await actions.pickFolder(typeof body.defaultPath === 'string' ? body.defaultPath : '');
      return picked ? { path: picked } : { canceled: true };
    }

    if (key === 'POST /open-folder') {
      const body = await readJson(req);
      await actions.openFolder(typeof body.path === 'string' ? body.path : '');
      return { ok: true };
    }

    throw new HttpError(404, 'not_found', 'Not found.');
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const match = origin ? EXTENSION_ORIGIN.exec(origin) : null;
    const corsOrigin = match ? origin : null;

    if (!allowedHosts.has(req.headers.host || '')) {
      return send(res, 403, { error: 'bad_host', message: 'Requests must use 127.0.0.1.' });
    }
    if (origin && !match) {
      return send(res, 403, { error: 'forbidden', message: 'Web pages cannot use this API.' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': corsOrigin || 'null',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    try {
      const data = await route(req, match ? match[1] : null);
      send(res, 200, data, corsOrigin);
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: 'invalid', message: err.message }, corsOrigin);
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message }, corsOrigin);
      console.error(err);
      send(res, 500, { error: 'internal', message: err.message || 'Unexpected error.' }, corsOrigin);
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

module.exports = { createApiServer, EXTENSION_ORIGIN };
