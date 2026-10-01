'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { normalizeJob, buildArgs, DEFAULTS, ValidationError } = require('../src/options');

const job = (over = {}, options = {}) => normalizeJob({
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  scope: 'single',
  ...over,
  options: { outputDir: '/tmp/out', ...options },
});

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('default audio job matches the sample mp3 command', () => {
  const args = buildArgs(job());
  for (const flag of ['-x', '--embed-thumbnail', '--embed-metadata', '--no-playlist', '--ignore-config']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(valueAfter(args, '-f'), 'bestaudio/best');
  assert.equal(valueAfter(args, '--audio-format'), 'mp3');
  assert.equal(valueAfter(args, '--audio-quality'), '0');
  assert.equal(valueAfter(args, '-P'), '/tmp/out');
  assert.equal(valueAfter(args, '-o'), DEFAULTS.filenameTemplate);
  assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
  assert.ok(args.includes('--ppa'), 'square cover crop');
});

test('replace existing files is on by default', () => {
  const args = buildArgs(job());
  assert.ok(args.includes('--force-overwrites'));
  assert.ok(!buildArgs(job({}, { overwrite: false })).includes('--force-overwrites'));
});

test('playlist job uses playlist template, items, archive and album tags', () => {
  const args = buildArgs(job({ scope: 'playlist', playlistItems: '1-10, 15' }, { overwrite: false, useArchive: true }));
  assert.ok(args.includes('--yes-playlist'));
  assert.ok(!args.includes('--no-playlist'));
  assert.equal(valueAfter(args, '-I'), '1-10,15');
  assert.equal(valueAfter(args, '-o'), DEFAULTS.playlistTemplate);
  assert.equal(valueAfter(args, '--download-archive'), path.join('/tmp/out', '.yt-dlp-archive.txt'));
  assert.ok(args.includes('%(album,playlist_title)s:%(album)s'));
});

test('video job sorts by resolution and merges to the chosen container', () => {
  const args = buildArgs(job({}, { mode: 'video', videoQuality: '720', videoContainer: 'mp4', embedSubs: true }));
  assert.equal(valueAfter(args, '-f'), 'bv*+ba/b');
  assert.equal(valueAfter(args, '-S'), 'res:720,vcodec:h264,acodec:aac');
  assert.equal(valueAfter(args, '--merge-output-format'), 'mp4');
  assert.ok(args.includes('--embed-subs'));
  assert.ok(!args.includes('-x'));
  assert.ok(!args.includes('--ppa'), 'no square crop for video');
});

test('turning options off removes their flags', () => {
  const args = buildArgs(job({}, { embedThumbnail: false, embedMetadata: false, embedChapters: false, audioFormat: 'best' }));
  for (const flag of ['--embed-thumbnail', '--embed-metadata', '--convert-thumbnails', '--audio-format', '--embed-chapters']) {
    assert.ok(!args.includes(flag), flag);
  }
});

test('home folder shorthand is expanded', () => {
  assert.equal(job({}, { outputDir: '~/Music' }).options.outputDir, path.join(os.homedir(), 'Music'));
});

test('rejects unsafe or invalid input', () => {
  const bad = [
    [{ url: 'file:///etc/passwd' }, {}],
    [{ url: 'javascript:alert(1)' }, {}],
    [{ scope: 'everything' }, {}],
    [{}, { audioFormat: 'exe' }],
    [{}, { outputDir: 'relative/dir' }],
    [{}, { filenameTemplate: '../../evil.%(ext)s' }],
    [{}, { filenameTemplate: '/etc/%(title)s.%(ext)s' }],
    [{}, { filenameTemplate: '%(title)s' }],
    [{}, { rateLimit: '1M --exec rm' }],
    [{}, { cookiesFromBrowser: 'chrome --exec x' }],
    [{}, { embedThumbnail: 'yes' }],
    [{ scope: 'playlist', playlistItems: '1;rm -rf' }, {}],
  ];
  for (const [over, options] of bad) {
    assert.throws(() => job(over, options), ValidationError, JSON.stringify({ over, options }));
  }
});

test('unknown option keys are ignored, never passed through', () => {
  const args = buildArgs(job({}, { exec: 'touch /tmp/pwned', extraArgs: ['--exec', 'x'] }));
  assert.ok(!args.includes('--exec'));
});

test('archive is not used while replacing files, since yt-dlp would skip them first', () => {
  const args = buildArgs(job({ scope: 'playlist' }, { overwrite: true, useArchive: true }));
  assert.ok(args.includes('--force-overwrites'));
  assert.ok(!args.includes('--download-archive'));
});

test('extension and app agree on every download option and default', async () => {
  const ext = await import('../../extension/lib/settings.js');
  assert.deepEqual(ext.DEFAULTS, DEFAULTS);
  const { CHOICES } = require('../src/options');
  const lists = { audioFormat: ext.AUDIO_FORMATS, audioQuality: ext.AUDIO_QUALITIES, videoQuality: ext.VIDEO_QUALITIES, videoContainer: ext.VIDEO_CONTAINERS, cookiesFromBrowser: ext.COOKIE_BROWSERS };
  for (const [key, list] of Object.entries(lists)) assert.deepEqual(list.map(([v]) => v).sort(), [...CHOICES[key]].sort(), key);
  for (const [t] of [...ext.FILENAME_PRESETS, ...ext.PLAYLIST_PRESETS]) assert.doesNotThrow(() => job({}, { filenameTemplate: t }), t);
});
