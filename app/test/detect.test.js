'use strict';
// Link detection in the extension (extension/lib/detect.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../extension/lib/detect.js');

test('bandcamp: only bandcamp.com and its subdomains count', async () => {
  const { describeUrl } = await load();
  assert.equal(describeUrl('https://artist.bandcamp.com/album/first-album').site, 'Bandcamp');
  assert.equal(describeUrl('https://artist.bandcamp.com/track/a-song').label, 'Track');
  assert.equal(describeUrl('https://bandcamp.com/album/x').site, 'Bandcamp');
  for (const url of ['https://notbandcamp.com/album/x', 'https://bandcamp.com.example.com/album/x']) {
    assert.notEqual(describeUrl(url).site, 'Bandcamp', url);
  }
});
