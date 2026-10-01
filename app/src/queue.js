'use strict';
// In-memory download queue. Runs up to `concurrency` yt-dlp processes at once.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { jobProgress } = require('./ytdlp');

const FINISHED = new Set(['done', 'partial', 'error', 'canceled']);
const MAX_FINISHED = 100;

function freshState() {
  return {
    status: 'queued',
    phase: 'waiting',
    error: '',
    errors: [],
    files: [],
    skipped: 0,
    existing: 0,
    replaced: 0,
    currentTitle: '',
    playlistTitle: '',
    itemIndex: 0,
    itemCount: 0,
    parts: 1,
    partIndex: 0,
    partProgress: 0,
    speed: null,
    eta: null,
    log: [],
    command: null,
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
  };
}

class JobQueue extends EventEmitter {
  // run(job, onChange) must return { done: Promise<{code, signal}>, kill() }.
  constructor({ run, concurrency = 2 }) {
    super();
    this.run = run;
    this.concurrency = concurrency;
    this.jobs = new Map();
    this.handles = new Map();
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, Math.min(8, Number(n) || 1));
    this.pump();
  }

  add(spec) {
    const job = { id: crypto.randomUUID(), ...spec, createdAt: Date.now(), ...freshState() };
    this.jobs.set(job.id, job);
    this.trimHistory();
    this.changed(job);
    this.pump();
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job || FINISHED.has(job.status)) return job;
    job.cancelRequested = true;
    const handle = this.handles.get(id);
    if (handle) {
      job.phase = 'canceling';
      handle.kill();
    } else {
      this.finish(job, 'canceled');
    }
    this.changed(job);
    return job;
  }

  retry(id) {
    const job = this.get(id);
    if (!job || !FINISHED.has(job.status)) return job;
    Object.assign(job, freshState());
    this.changed(job);
    this.pump();
    return job;
  }

  clearFinished() {
    for (const [id, job] of this.jobs) if (FINISHED.has(job.status)) this.jobs.delete(id);
    this.emit('change', null);
  }

  activeCount() {
    let n = 0;
    for (const job of this.jobs.values()) if (!FINISHED.has(job.status)) n += 1;
    return n;
  }

  list() {
    return [...this.jobs.values()].reverse().map(toPublic);
  }

  pump() {
    let running = this.handles.size;
    for (const job of this.jobs.values()) {
      if (running >= this.concurrency) break;
      if (job.status !== 'queued') continue;
      running += 1;
      this.start(job);
    }
  }

  start(job) {
    job.status = 'running';
    job.phase = 'starting';
    job.startedAt = Date.now();
    this.changed(job);
    let handle;
    try {
      handle = this.run(job, () => this.changed(job));
    } catch (err) {
      handle = { done: Promise.reject(err), kill() {} };
    }
    this.handles.set(job.id, handle);
    handle.done.then(
      ({ code }) => this.settle(job, code),
      (err) => {
        job.error = err.message;
        this.finish(job, 'error');
      },
    ).finally(() => {
      this.handles.delete(job.id);
      this.changed(job);
      this.pump();
    });
  }

  settle(job, code) {
    if (job.cancelRequested) return this.finish(job, 'canceled');
    const lastError = job.errors.length ? job.errors[job.errors.length - 1].message : '';
    if (code === 0 && !job.errors.length) return this.finish(job, 'done');
    if (job.files.length || job.skipped) {
      job.error = `${job.errors.length || 'Some'} item(s) failed. Last error: ${lastError || `exit code ${code}`}`;
      return this.finish(job, 'partial');
    }
    if (code === 0) return this.finish(job, 'done');
    job.error = lastError || `yt-dlp stopped with exit code ${code}.`;
    return this.finish(job, 'error');
  }

  finish(job, status) {
    job.status = status;
    job.phase = status;
    job.finishedAt = Date.now();
    job.speed = null;
    job.eta = null;
    this.emit('finished', job);
  }

  trimHistory() {
    const finished = [...this.jobs.values()].filter((j) => FINISHED.has(j.status));
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) this.jobs.delete(job.id);
  }

  changed(job) {
    this.emit('change', job);
  }
}

function toPublic(job) {
  return {
    id: job.id,
    url: job.url,
    scope: job.scope,
    mode: job.options.mode,
    outputDir: job.options.outputDir,
    title: (job.scope === 'playlist' && job.playlistTitle) || job.title || job.currentTitle || job.url,
    playlistTitle: job.playlistTitle,
    currentTitle: job.currentTitle,
    status: job.status,
    phase: job.phase,
    progress: jobProgress(job),
    itemIndex: job.itemIndex,
    itemCount: job.itemCount,
    speed: job.speed,
    eta: job.eta,
    files: job.files,
    skipped: job.skipped,
    existing: job.existing,
    replaced: job.replaced,
    errors: job.errors.slice(-20),
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

module.exports = { JobQueue, toPublic, FINISHED };
