// Linking preset packs to the host's own copies (fake Spotify API)
const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const { matchCopies, normName } = require('../pack-links');

test('normName ignores "Hitster", copy suffixes, case and punctuation', () => {
  assert.strictEqual(normName('HITSTER – Rock (Kopie)'), 'rock');
  assert.strictEqual(normName('Hitster Schlager-Party'), 'schlager party');
  assert.strictEqual(normName('Battle of the Generations (vor 1985)'), 'battle of the generations vor 1985');
});

test('matchCopies needs the full name and uses each playlist once', () => {
  const packs = [{ id: 'rock', names: ['Rock'] }, { id: 'rock2', names: ['Rock'] }, { id: 'xmas', names: ['Christmas', 'HITSTER Christmas Edition'] }];
  const mine = [{ id: 'p1', name: 'Rock Classics' }, { id: 'p2', name: 'Hitster Rock' }, { id: 'p3', name: 'Hitster Christmas Edition' }];
  const r = matchCopies(packs, mine);
  assert.strictEqual(r.rock.id, 'p2');
  assert.strictEqual(r.rock2, undefined);
  assert.strictEqual(r.xmas.id, 'p3');
});

const fail = status => Object.assign(new Error(String(status)), { response: { status } });
axios.get = async (url) => {
  if (url.endsWith('/v1/me')) return { data: { id: 'me' } };
  if (url.endsWith('/v1/me/playlists')) return { data: { next: null, items: [
    { id: 'myrock', name: 'HITSTER Rock', owner: { id: 'me' }, images: [], items: { total: 300 } },
    { id: 'foreign', name: 'Christmas', owner: { id: 'other' }, images: [], items: { total: 50 } },
  ] } };
  const m = url.match(/\/playlists\/([^/?]+)$/);
  if (m) return { data: { name: m[1] === 'myrock' ? 'HITSTER Rock' : 'Original ' + m[1], images: [{ url: 'cover-' + m[1] }], items: { total: 99 } } };
  throw fail(500);
};

const { start, server } = require('../server');
let url;
test.before(async () => { await start(0); url = `http://localhost:${server.address().port}`; });
test.after(() => { server.close(); setTimeout(() => process.exit(0), 100).unref(); });

test('loading the packs links own copies automatically, packs then play the copy', async () => {
  const { packs } = await (await fetch(`${url}/api/preset-packs?token=t`)).json();
  const rock = packs.find(p => p.id === 'rock');
  assert.strictEqual(rock.playlistId, 'myrock');
  assert.strictEqual(rock.originalId, '4oYTRg0JI48jucsJOLily1');
  assert.ok(rock.linked);
  assert.strictEqual(rock.cover, 'cover-4oYTRg0JI48jucsJOLily1');
  const xmas = packs.find(p => p.id === 'christmas');
  assert.strictEqual(xmas.linked, undefined);
  assert.strictEqual(xmas.playlistId, xmas.originalId);
});

test('manual unlink and rejecting foreign playlists', async () => {
  const post = body => fetch(`${url}/api/pack-links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 't', ...body }) });
  assert.strictEqual((await post({ packId: 'christmas', playlistId: 'foreign' })).status, 404);
  assert.strictEqual((await post({ packId: 'nope', playlistId: null })).status, 400);
  assert.strictEqual((await post({ packId: 'rock', playlistId: null })).status, 200);
  const { packs } = await (await fetch(`${url}/api/preset-packs?token=t`)).json();
  assert.strictEqual(packs.find(p => p.id === 'rock').linked, undefined); // stays unlinked, no auto re-link
});
