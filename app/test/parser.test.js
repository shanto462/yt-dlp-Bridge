'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLine, jobProgress } = require('../src/ytdlp');

const blank = (scope = 'single') => ({
  scope, status: 'running', title: '', files: [], errors: [], log: [], skipped: 0, existing: 0, replaced: 0,
  itemIndex: 0, itemCount: 0, parts: 1, partIndex: 0, partProgress: 0,
});

test('single video: video + audio parts make one smooth progress bar', () => {
  const job = blank();
  applyLine(job, '[info] abc: Downloading 2 format(s): 137+140');
  applyLine(job, '@@YTB:T {"id": "abc", "title": "My Video"}');
  applyLine(job, '[download] Destination: /x/My Video.f137.mp4');
  applyLine(job, '@@YTB:P {"downloaded_bytes": 50, "total_bytes": 100, "speed": 10, "eta": 5, "status": "downloading"}');
  assert.equal(job.title, 'My Video');
  assert.equal(jobProgress(job), 0.25);
  applyLine(job, '@@YTB:P {"downloaded_bytes": 100, "total_bytes": 100, "status": "finished"}');
  applyLine(job, '[download] Destination: /x/My Video.f140.m4a');
  applyLine(job, '@@YTB:P {"downloaded_bytes": 10, "total_bytes_estimate": 20, "status": "downloading"}');
  assert.equal(jobProgress(job), 0.75);
  applyLine(job, '[Merger] Merging formats into "/x/My Video.mp4"');
  applyLine(job, '@@YTB:F "/x/My Video.mp4"');
  assert.deepEqual(job.files, ['/x/My Video.mp4']);
  assert.equal(job.phase, 'processing');
});

test('playlist: item counter, archive skips and per-item errors', () => {
  const job = blank('playlist');
  applyLine(job, '[download] Downloading playlist: Road Trip');
  applyLine(job, '[youtube:tab] Playlist Road Trip: Downloading 4 items of 40');
  applyLine(job, '[download] Downloading item 1 of 4');
  applyLine(job, '[download] abc: has already been recorded in the archive');
  applyLine(job, '[download] Downloading item 3 of 4');
  applyLine(job, '@@YTB:T {"id": "c", "title": "Song C", "playlist_index": 3, "n_entries": 4, "playlist_title": "Road Trip"}');
  applyLine(job, '[download] Destination: /x/c.webm');
  applyLine(job, '@@YTB:P {"downloaded_bytes": 1, "total_bytes": 2, "status": "downloading"}');
  applyLine(job, 'ERROR: [youtube] c: Video unavailable');
  assert.equal(job.playlistTitle, 'Road Trip');
  assert.equal(job.itemCount, 4);
  assert.equal(job.itemIndex, 3);
  assert.equal(job.skipped, 1);
  assert.equal(jobProgress(job), 2.5 / 4);
  assert.deepEqual(job.errors, [{ item: 'Song C', message: '[youtube] c: Video unavailable' }]);
});

test('HLS downloads without sizes use fragment counts; bad JSON is ignored', () => {
  const job = blank();
  applyLine(job, '@@YTB:P {"fragment_index": 3, "fragment_count": 12, "status": "downloading"}');
  assert.equal(job.partProgress, 0.25);
  applyLine(job, '@@YTB:P {not json');
  applyLine(job, '@@YTB:F not json');
  assert.equal(job.partProgress, 0.25);
  assert.deepEqual(job.files, []);
});

test('counts files that were replaced or already existed', () => {
  const job = { ...blank(), existing: 0, replaced: 0 };
  applyLine(job, 'Deleting existing file /x/Song.mp3');
  applyLine(job, '[download] /x/Other.mp3 has already been downloaded');
  assert.equal(job.replaced, 1);
  assert.equal(job.existing, 1);
});
