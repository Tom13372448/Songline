// Plays complete rounds over real socket connections (without Spotify:
// music source "search songs", songs already carry their year).
const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { start, server, lobbies } = require('../server');
const { serialize, deserialize } = require('../persistence');

let url;
const sockets = [];

test.before(async () => {
  await start(0);
  url = `http://localhost:${server.address().port}`;
});

test.after(() => {
  sockets.forEach(s => s.disconnect());
  for (const l of lobbies.values()) {
    clearTimeout(l.turn?.timer);
    l.players.forEach(p => clearTimeout(p.removeTimer));
  }
  server.close();
  setTimeout(() => process.exit(0), 100).unref();
});

const wait = (s, ev) => new Promise(r => s.once(ev, r));
async function client() {
  const s = connect(url, { forceNew: true, reconnection: false });
  sockets.push(s);
  await wait(s, 'connect');
  return s;
}
const track = (id, year) => ({ id, name: `Song${id}`, artists: [{ name: `Artist${id}` }], album: { release_date: `${year}-01-01` }, year });
const unit = (lobby, name) => lobby.units.find(u => u.name === name);
const current = lobby => lobby.units.find(u => u.id === lobby.currentUnitId);

// Lobby with host + players, settings applied, game started
async function setupGame(names, settings = {}) {
  const [host, ...others] = await Promise.all(names.map(() => client()));
  host.emit('lobby:create', { playerName: names[0], playerKey: `k-${names[0]}` });
  const { code } = await wait(host, 'lobby:created');
  for (let i = 0; i < others.length; i++) {
    others[i].emit('lobby:join', { code, playerName: names[i + 1], playerKey: `k-${names[i + 1]}` });
    await wait(others[i], 'lobby:joined');
  }
  const updated = wait(host, 'lobby:updated');
  host.emit('lobby:settings', { code, gameMode: 'classic', sourceType: 'search', sourceTab: 'search', winCards: 10, ...settings });
  await updated;
  const needs = wait(host, 'game:needs-track');
  host.emit('game:start', { code, token: 'test' });
  await needs;
  return { code, host, others, all: [host, ...others] };
}

async function selectTrack(g, t) {
  const got = wait(g.host, 'game:track');
  g.host.emit('game:track-selected', { code: g.code, track: t });
  return (await got).lobby;
}

test('Classic original: token, pass, skip, no idea, SONGLINE!', async () => {
  const g = await setupGame(['Host', 'A', 'B']);
  const [a, b] = g.others;
  const { code, host } = g;

  // Turn 1: host places the song and names title + artist
  await selectTrack(g, track('1', 1990));
  let ch = wait(b, 'game:challenge');
  host.emit('game:confirm', { code, slotIndex: 0, guessTitle: 'song1', guessArtist: 'artist1' });
  assert.strictEqual((await ch).lobby.turn.phase, 'challenge');
  ch = wait(b, 'game:challenge');
  a.emit('game:pass', { code });
  await ch;
  let verdict = wait(b, 'game:verdict');
  b.emit('game:pass', { code });
  let v = await verdict;
  assert.ok(v.correct && v.tokenEarned);
  assert.deepStrictEqual([unit(v.lobby, 'Host').timeline.length, unit(v.lobby, 'Host').tokens], [1, 3]);

  // A double "next" must only take effect once
  let needs = wait(b, 'game:needs-track');
  b.emit('game:next', { code });
  b.emit('game:next', { code });
  assert.strictEqual(current((await needs).lobby).name, 'A');

  // Turn 2: A places, host reveals immediately
  await selectTrack(g, track('2', 1980));
  ch = wait(b, 'game:challenge');
  a.emit('game:confirm', { code, slotIndex: 0 });
  await ch;
  verdict = wait(b, 'game:verdict');
  host.emit('game:resolve', { code });
  assert.ok((await verdict).correct);
  needs = wait(b, 'game:needs-track');
  a.emit('game:next', { code });
  await needs;

  // Turn 3: B skips (1 token), then "no idea" – host steals
  const info = wait(b, 'game:info');
  needs = wait(b, 'game:needs-track');
  b.emit('game:skip', { code });
  assert.strictEqual((await info).key, 'info.skipToken');
  await needs;
  await selectTrack(g, track('3', 1970));
  ch = wait(b, 'game:challenge');
  b.emit('game:reveal', { code });
  await ch;
  ch = wait(b, 'game:challenge');
  host.emit('game:songline', { code, slotIndex: 0 });
  await ch;
  verdict = wait(b, 'game:verdict');
  a.emit('game:pass', { code });
  v = await verdict;
  assert.ok(v.gaveUp);
  assert.strictEqual(v.stolenBy, 'Host');
  assert.strictEqual(unit(v.lobby, 'B').tokens, 1);
  needs = wait(b, 'game:needs-track');
  b.emit('game:next', { code });
  await needs;

  // Turn 4: host misplaces 2000, A calls correctly, B wrongly – a taken slot is rejected
  await selectTrack(g, track('4', 2000));
  ch = wait(b, 'game:challenge');
  host.emit('game:confirm', { code, slotIndex: 0 });
  await ch;
  const err = wait(a, 'lobby:error');
  a.emit('game:songline', { code, slotIndex: 0 });
  assert.strictEqual((await err).key, 'err.slotTaken');
  ch = wait(b, 'game:challenge');
  a.emit('game:songline', { code, slotIndex: 2 });
  await ch;
  verdict = wait(b, 'game:verdict');
  b.emit('game:songline', { code, slotIndex: 1 });
  v = await verdict;
  assert.ok(!v.correct);
  assert.strictEqual(v.stolenBy, 'A');
  assert.deepStrictEqual(['Host', 'A', 'B'].map(n => unit(v.lobby, n).timeline.length), [2, 2, 0]);
});

test('Pro variant: correct slot without title/artist is not enough', async () => {
  const g = await setupGame(['P1', 'P2'], { variant: 'pro' });
  await selectTrack(g, track('10', 1999));
  // P2 has tokens → SONGLINE! round, P2 passes
  const ch = wait(g.host, 'game:challenge');
  g.host.emit('game:confirm', { code: g.code, slotIndex: 0, guessTitle: 'song10' });
  await ch;
  const verdict = wait(g.host, 'game:verdict');
  g.others[0].emit('game:pass', { code: g.code });
  const v = await verdict;
  assert.ok(!v.correct);
  assert.strictEqual(v.reason, 'names');
  assert.ok(!v.tokenEarned, 'no token for naming in pro');
});

test('Team mode: any team member plays, shared timeline & tokens', async () => {
  const g = await setupGame(['T1', 'T2', 'T3', 'T4'], { teamMode: true, teamCount: 2 });
  const lobby = await selectTrack(g, track('20', 1985));
  assert.strictEqual(lobby.units.length, 2);
  const cur = current(lobby);
  assert.strictEqual(cur.memberNames.length, 2);
  assert.deepStrictEqual(lobby.units.map(u => u.tokens), [2, 2]);

  // The second member of the active team places the song
  const byName = Object.fromEntries(g.all.map((s, i) => [['T1', 'T2', 'T3', 'T4'][i], s]));
  const actor = byName[cur.memberNames[1]];
  const other = lobby.units.find(u => u !== cur && u.id !== cur.id);
  const challenger = byName[other.memberNames[0]];
  const ch = wait(g.host, 'game:challenge');
  actor.emit('game:confirm', { code: g.code, slotIndex: 0 });
  await ch;
  const verdict = wait(g.host, 'game:verdict');
  challenger.emit('game:pass', { code: g.code }); // passing applies to the whole team
  const v = await verdict;
  assert.ok(v.correct);
  assert.strictEqual(v.lobby.units.find(u => u.id === cur.id).timeline.length, 1);

  const needs = wait(g.host, 'game:needs-track');
  actor.emit('game:next', { code: g.code });
  assert.strictEqual((await needs).lobby.currentUnitId, other.id);
});

test('Host gone → pause, actions blocked; host back → continue', async () => {
  const g = await setupGame(['H', 'X']);
  await selectTrack(g, track('30', 1977));
  const paused = wait(g.others[0], 'game:paused');
  g.host.disconnect();
  assert.strictEqual((await paused).paused, true);

  const host2 = await client();
  const resumed = wait(g.others[0], 'game:paused');
  host2.emit('lobby:rejoin', { code: g.code, playerKey: 'k-H' });
  const { lobby } = await wait(host2, 'lobby:rejoined');
  assert.strictEqual(lobby.hostId, host2.id);
  assert.strictEqual((await resumed).paused, false);
});

test('Late join: new player gets tokens and joins the turn order', async () => {
  const g = await setupGame(['L1', 'L2']);
  const late = await client();
  const info = wait(g.host, 'game:info');
  late.emit('lobby:join', { code: g.code, playerName: 'Spät', playerKey: 'k-late' });
  const { lobby } = await wait(late, 'lobby:joined');
  assert.strictEqual(lobby.status, 'playing');
  assert.strictEqual(unit(lobby, 'Spät').tokens, 2);
  assert.strictEqual((await info).key, 'info.joined');
});

test('Active player leaves the game → next player is up', async () => {
  const g = await setupGame(['M1', 'M2', 'M3']);
  const skipped = wait(g.host, 'game:needs-track');
  g.host.emit('game:skip', { code: g.code }); // host skips for free, M1 keeps the turn
  await skipped;
  await selectTrack(g, track('40', 2001));
  const needs = wait(g.others[1], 'game:needs-track');
  g.host.emit('lobby:leave', { code: g.code }); // host = active player → back to the lobby
  const back = await Promise.race([needs.then(() => 'next'), wait(g.others[1], 'game:back-to-lobby').then(() => 'lobby')]);
  assert.strictEqual(back, 'lobby', 'without the host the game ends');

  const g2 = await setupGame(['N1', 'N2', 'N3']);
  const turnChange = wait(g2.host, 'game:needs-track');
  g2.host.emit('game:skip', { code: g2.code });
  await turnChange;
  // N1 (host) has the turn; N2 doesn't – N2 leaves: game continues, N1 keeps the turn
  const upd = wait(g2.host, 'lobby:updated');
  g2.others[0].emit('lobby:leave', { code: g2.code });
  const l = await upd;
  assert.strictEqual(current(l).name, 'N1');
  assert.strictEqual(l.units.length, 2);
});

test('Save/load: lobby in a SONGLINE! round survives serialization', () => {
  const p1 = { id: 'a', key: 'ka', name: 'A', score: 1, timeline: [{ year: 1990 }], tokens: 1 };
  const p2 = { id: 'b', key: 'kb', name: 'B', score: 0, timeline: [], tokens: 2, removeTimer: setTimeout(() => {}, 0) };
  const lobby = {
    code: 'TEST', players: [p1, p2], teams: [], teamMode: false, usedTrackIds: new Set(['x']),
    turn: { phase: 'challenge', slotIndex: 0, tokenEarned: false, challenges: [{ unit: p2, by: p2, slotIndex: 1 }], passed: new Set([p1]), timer: 1 },
  };
  const json = JSON.parse(JSON.stringify(serialize(lobby, lobby.players)));
  const back = deserialize(json, l => l.players);
  assert.ok(back.usedTrackIds.has('x'));
  assert.strictEqual(back.turn.challenges[0].unit, back.players[1]);
  assert.ok(back.turn.passed.has(back.players[0]));
  assert.ok(back.players.every(p => p.connected === false));
  assert.ok(!('removeTimer' in back.players[1]));
});

test('Back to lobby & rejoin: score is kept, turn order skips players sitting out', async () => {
  const g = await setupGame(['S1', 'S2', 'S3']);
  const [s2, s3] = g.others;
  // S1 (active) wins a card
  await selectTrack(g, track('50', 1990));
  let ch = wait(s3, 'game:challenge');
  g.host.emit('game:confirm', { code: g.code, slotIndex: 0 });
  await ch;
  ch = wait(s3, 'game:challenge');
  s2.emit('game:pass', { code: g.code });
  await ch;
  let verdict = wait(s3, 'game:verdict');
  s3.emit('game:pass', { code: g.code });
  await verdict;
  let needs = wait(s3, 'game:needs-track');
  g.host.emit('game:next', { code: g.code });
  assert.strictEqual(current((await needs).lobby).name, 'S2');

  // S2 is active and goes to the lobby → S3 is up immediately
  needs = wait(s3, 'game:needs-track');
  s2.emit('game:sit-out', { code: g.code });
  const l = (await needs).lobby;
  assert.strictEqual(current(l).name, 'S3');
  assert.ok(l.players.find(p => p.name === 'S2').away);

  // S1 also goes to the lobby briefly: the card is kept
  const upd = wait(s3, 'lobby:updated');
  g.host.emit('game:sit-out', { code: g.code });
  await upd;
  const back = await new Promise(r => g.host.emit('game:sit-in', { code: g.code }, r));
  assert.ok(back.ok);
  assert.strictEqual(unit(back.lobby, 'S1').timeline.length, 1);
  assert.ok(!back.lobby.players.find(p => p.name === 'S1').away);
});

test('Close lobby: host only, everyone is notified, lobby is gone', async () => {
  const g = await setupGame(['C1', 'C2']);
  const guest = g.others[0];
  guest.emit('lobby:close', { code: g.code }); // guests may not
  await new Promise(r => setTimeout(r, 200));
  assert.ok(lobbies.has(g.code));

  const closed = wait(guest, 'lobby:closed');
  g.host.emit('lobby:close', { code: g.code });
  assert.strictEqual((await closed).code, g.code);
  assert.ok(!lobbies.has(g.code));
  const fail = wait(guest, 'lobby:rejoin-failed');
  guest.emit('lobby:rejoin', { code: g.code, playerKey: 'k-C2' });
  await fail;
});
