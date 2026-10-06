// Works out what a link points to (one video, a playlist, both, a channel...)
// so the UI can offer "This video" and/or "Whole playlist".

const result = (fields) => ({
  ok: true,
  canSingle: true,
  canPlaylist: false,
  defaultScope: 'single',
  singleLabel: 'This video',
  playlistLabel: 'Whole playlist',
  note: '',
  ...fields,
});

const unsupported = (note) => result({ ok: false, kind: 'none', label: 'Nothing to download', canSingle: false, note });

export function describeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return unsupported('Open a video or playlist, or paste a link.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return unsupported('Open a video or playlist, or paste a link.');
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') return youtubeVideo(u, 'YouTube');
  if (host === 'music.youtube.com') return youtube(u, parts, 'YouTube Music');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') return youtube(u, parts, 'YouTube');
  if (host === 'soundcloud.com') return soundcloud(parts);
  if (host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) return bandcamp(parts);
  if (host === 'vimeo.com' && ['showcase', 'channels', 'album'].includes(parts[0])) {
    return result({ site: 'Vimeo', kind: 'playlist', label: 'Vimeo collection', canSingle: false, canPlaylist: true, defaultScope: 'playlist' });
  }
  return result({
    site: host,
    kind: 'page',
    label: 'Web page',
    canPlaylist: true,
    singleLabel: 'This page',
    playlistLabel: 'As a playlist',
    note: 'yt-dlp supports over 1,800 sites. If this page has no video or audio, the download will fail.',
  });
}

function listNote(list) {
  if (list === 'WL' || list === 'LL' || list === 'LM') {
    return 'This is a private list. Turn on "Cookies from browser" in settings to download it.';
  }
  return '';
}

function youtubeVideo(u, site) {
  const list = u.searchParams.get('list');
  if (!list) return result({ site, kind: 'video', label: 'Video' });
  if (list.startsWith('RD')) {
    return result({
      site,
      kind: 'video-in-mix',
      label: 'Video in a Mix',
      canPlaylist: true,
      playlistLabel: 'Whole Mix',
      note: 'Mixes are made by YouTube and can be very long. Use "Items" to limit them, for example 1-25.',
    });
  }
  return result({ site, kind: 'video-in-playlist', label: 'Video in a playlist', canPlaylist: true, note: listNote(list) });
}

function youtube(u, parts, site) {
  const first = parts[0] || '';
  const list = u.searchParams.get('list');

  if (first === 'watch' && u.searchParams.get('v')) return youtubeVideo(u, site);
  if (['shorts', 'live', 'embed', 'v'].includes(first) && parts[1]) return youtubeVideo(u, site);
  if (first === 'playlist' && list) {
    const album = list.startsWith('OLAK5uy_');
    return result({
      site,
      kind: 'playlist',
      label: album ? 'Album' : 'Playlist',
      canSingle: false,
      canPlaylist: true,
      defaultScope: 'playlist',
      playlistLabel: album ? 'Whole album' : 'Whole playlist',
      note: listNote(list),
    });
  }
  if (first === 'browse' && /^(MPREb_|VL)/.test(parts[1] || '')) {
    return result({ site, kind: 'playlist', label: 'Album', canSingle: false, canPlaylist: true, defaultScope: 'playlist', playlistLabel: 'Whole album' });
  }
  if (first.startsWith('@') || ['channel', 'c', 'user'].includes(first)) {
    return result({
      site,
      kind: 'channel',
      label: 'Channel',
      canSingle: false,
      canPlaylist: true,
      defaultScope: 'playlist',
      playlistLabel: 'All videos',
      note: 'This downloads every video on the channel. Use "Items" to limit it, for example 1-20.',
    });
  }
  return unsupported(`Open a ${site} video, playlist or channel first.`);
}

function soundcloud(parts) {
  const site = 'SoundCloud';
  if (parts.length === 1) {
    return result({ site, kind: 'channel', label: 'Artist', canSingle: false, canPlaylist: true, defaultScope: 'playlist', playlistLabel: 'All tracks' });
  }
  if (parts[1] === 'sets' && parts[2]) {
    return result({ site, kind: 'playlist', label: 'Playlist', canSingle: false, canPlaylist: true, defaultScope: 'playlist' });
  }
  if (['likes', 'tracks', 'albums', 'reposts', 'popular-tracks'].includes(parts[1])) {
    return result({ site, kind: 'playlist', label: 'Track list', canSingle: false, canPlaylist: true, defaultScope: 'playlist', playlistLabel: 'All tracks' });
  }
  if (parts.length >= 2) return result({ site, kind: 'video', label: 'Track', singleLabel: 'This track' });
  return unsupported('Open a SoundCloud track or playlist first.');
}

function bandcamp(parts) {
  const site = 'Bandcamp';
  if (parts[0] === 'album') {
    return result({ site, kind: 'playlist', label: 'Album', canSingle: false, canPlaylist: true, defaultScope: 'playlist', playlistLabel: 'Whole album' });
  }
  if (parts[0] === 'track') return result({ site, kind: 'video', label: 'Track', singleLabel: 'This track' });
  return result({ site, kind: 'channel', label: 'Artist', canSingle: false, canPlaylist: true, defaultScope: 'playlist', playlistLabel: 'All releases' });
}

// Picks the scope to use when the caller asks for one the link cannot do.
export function resolveScope(info, wanted) {
  if (wanted === 'playlist' && info.canPlaylist) return 'playlist';
  if (wanted === 'single' && info.canSingle) return 'single';
  return info.defaultScope;
}
