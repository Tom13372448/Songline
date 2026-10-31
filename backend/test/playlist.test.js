// Playlist loading against a fake Spotify API (February 2026 format: /items, "item" field, 403 for foreign playlists)
const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const { io: connect } = require('socket.io-client');

const requested = [];
const page = (n, offset) => Array.from({ length: n }, (_, i) => ({
  item: { id: `t${offset + i}`, type: 'track', name: `Song ${offset + i}`, artists: [{ id: `a${offset + i}`, name: 'X' }], album: { release_date: '1990' } },
}));
axios.get = async (url, opts = {}) => {
  requested.push(url);
  const fail = status => Object.assign(new Error(String(status)), { response: { status } });
  if (url.includes('/playlists/foreign/')) throw fail(403);
  if (url.includes('/playlists/missing/')) throw fail(404);
  if (url.endsWith('/playlists/own/items')) {
    assert.strictEqual(opts.params.limit, 50);
    return { data: { items: page(50, 0), next: 'https://api.spotify.com/v1/playlists/own/items?offset=50&limit=50' } };
  }
  if (url.includes('/playlists/own/items?offset=50')) return { data: { items: [...page(9, 50), { track: { id: 'old', type: 'track', name: 'Old field' } }], next: null } };
  if (url.includes('/search')) return { data: { tracks: { items: [] } } };
  throw fail(500);
};

const { start, server, lobbies } = require('../server');
let url;
test.before(async () => { await start(0); url = `http://localhost:${server.address().port}`; });
test.after(() => {
  for (const l of lobbies.values()) { clearTimeout(l.turn?.timer); l.players.forEach(p => clearTimeout(p.removeTimer)); }
  server.close();
  setTimeout(() => process.exit(0), 100).unref();
});
const wait = (s, ev) => new Promise(r => s.once(ev, r));

async function startWith(playlistId) {
  const s = connect(url, { forceNew: true, reconnection: false });
  await wait(s, 'connect');
  s.emit('lobby:create', { playerName: 'Host', playerKey: 'k-' + playlistId });
  const { code } = await wait(s, 'lobby:created');
  const upd = wait(s, 'lobby:updated');
  s.emit('lobby:settings', { code, gameMode: 'classic', sourceType: 'playlist', sourceTab: 'playlist', playlistId, winCards: 10 });
  await upd;
  s.emit('game:start', { code, token: 'x' });
  return { s, code };
}

test('Own playlist: all pages via /items, "item" and legacy "track" both read', async () => {
  const { s, code } = await startWith('own');
  await wait(s, 'game:started');
  assert.strictEqual(lobbies.get(code).playlistTracks.length, 60);
  assert.ok(requested.some(u => u.endsWith('/playlists/own/items')));
  assert.ok(!requested.some(u => u.includes('/tracks')), 'old /tracks endpoint must not be used');
  s.disconnect();
});

test('Foreign playlist (403) and missing playlist (404) give clear errors', async () => {
  const a = await startWith('foreign');
  assert.strictEqual((await wait(a.s, 'lobby:error')).key, 'err.playlistForbidden');
  const b = await startWith('missing');
  assert.strictEqual((await wait(b.s, 'lobby:error')).key, 'err.playlistNotFound');
  a.s.disconnect(); b.s.disconnect();
});
