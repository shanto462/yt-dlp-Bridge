#!/usr/bin/env node
// Pretends to be yt-dlp downloading a 2-item playlist where item 2 fails.
// FAKE_MODE=hang keeps running until killed (for cancel tests).
const out = (s) => process.stdout.write(`${s}\n`);
const args = process.argv.slice(2);
out(`ARGS ${JSON.stringify(args)}`);
if (process.env.FAKE_MODE === 'hang') {
  out('[download] Downloading item 1 of 3');
  setInterval(() => {}, 1000);
} else {
  out('[download] Downloading playlist: Test List');
  out('[youtube:tab] Playlist Test List: Downloading 2 items of 9');
  out('[download] Downloading item 1 of 2');
  out('[info] aaa: Downloading 1 format(s): 251');
  out('@@YTB:T {"id": "aaa", "title": "First song", "playlist_index": 1, "n_entries": 2, "playlist_title": "Test List"}');
  out('[download] Destination: /tmp/x/001 - First song.webm');
  out('@@YTB:P {"downloaded_bytes": 50, "total_bytes": 100, "speed": 1000.5, "eta": 3, "status": "downloading"}');
  out('@@YTB:P {"downloaded_bytes": 100, "total_bytes": 100, "status": "finished"}');
  out('[ExtractAudio] Destination: /tmp/x/001 - First song.mp3');
  out('@@YTB:F "/tmp/x/001 - First song.mp3"');
  out('[download] Downloading item 2 of 2');
  out('@@YTB:T {"id": "bbb", "title": "Second song", "playlist_index": 2, "n_entries": 2}');
  process.stderr.write('ERROR: unable to download video data: HTTP Error 403: Forbidden\n');
  process.exitCode = 1;
}
