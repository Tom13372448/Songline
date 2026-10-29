// Song Battle (single player): 16/32/64 songs in a knockout bracket – you pick the winner of every duel.
// Runs entirely in the browser with the player's Spotify token; progress is kept in localStorage.
const BATTLE_SIZES = [16, 32, 64];
const SNIPPET_MS = 25000;       // length of each snippet in a duel
const SNIPPET_START_MS = 30000; // start snippets roughly where the song gets going

let battle = null;              // { size, tracks: {id: track}, rounds: [[id…]], picks: [[id…]], round, match }
let battleTimer = null;
let battlePlaying = null;       // 'a' | 'b' | null
let battlePacks = [];

// ── Entry ─────────────────────────────────────────────────────────
function openBattle() {
  if (!state.accessToken) {
    // Log in to Spotify first, the battle opens automatically afterwards
    store.set('pendingBattle', true);
    location.href = '/api/login';
    return;
  }
  initSpotifySDK();
  loadDevices();
  battle = store.get('battle');
  if (battle && !battleFinished()) { showBattleView('duel'); renderDuel(); }
  else if (battle && battleFinished()) { showBattleView('end'); renderBattleEnd(false); }
  else { battle = null; showBattleView('setup'); renderBattleSetup(); }
  showScreen('battle');
}

function leaveBattle() {
  stopBattleAudio();
  showScreen('menu');
}

function showBattleView(view) {
  ['setup', 'loading', 'duel', 'end'].forEach(v =>
    document.getElementById('battle-' + v).style.display = v === view ? '' : 'none');
}

// ── Setup ─────────────────────────────────────────────────────────
function renderBattleSetup() {
  const size = Number(store.get('battleSize')) || 16;
  document.querySelectorAll('.battle-size').forEach(b => b.classList.toggle('active', Number(b.dataset.size) === size));
  const source = store.get('battleSource') || 'random';
  document.querySelectorAll('.battle-source').forEach(b => b.classList.toggle('active', b.dataset.source === source));
  document.getElementById('battle-pack-wrap').style.display = source === 'pack' ? '' : 'none';
  document.getElementById('battle-playlist-wrap').style.display = source === 'playlist' ? '' : 'none';
  if (source === 'pack' && !battlePacks.length) loadBattlePacks();
  renderDeviceSelects();
}

function setBattleSize(size) { store.set('battleSize', size); renderBattleSetup(); }
function setBattleSource(source) { store.set('battleSource', source); renderBattleSetup(); }

async function loadBattlePacks() {
  try {
    const res = await apiFetch(`/api/preset-packs?token=${state.accessToken}`);
    battlePacks = ((await res.json()).packs || []).filter(p => !p.error);
  } catch (e) { battlePacks = []; }
  document.getElementById('battle-pack').innerHTML = battlePacks
    .map(p => `<option value="${esc(p.playlistId)}">${esc(p.name)}${p.trackCount ? ` (${p.trackCount})` : ''}</option>`).join('');
}

// ── Fetching songs ────────────────────────────────────────────────
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Keep only what the battle needs (also keeps localStorage small)
function slimTrack(t) {
  return {
    id: t.id,
    name: t.name,
    artist: t.artists?.map(a => a.name).join(', ') || '–',
    artistId: t.artists?.[0]?.id || t.artists?.[0]?.name,
    cover: t.album?.images?.[0]?.url || null,
    year: t.album?.release_date?.slice(0, 4) || '',
    duration: t.duration_ms || 0,
  };
}

// Random songs from all of Spotify: random 2-letter searches at random offsets,
// at most one song per artist, preferring well-known tracks when Spotify reports popularity
async function fetchRandomTracks(count, onProgress) {
  const found = new Map();
  const artists = new Set();
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const vowels = 'aeiou';
  let attempts = 0;
  while (found.size < count && attempts < count * 4) {
    const batch = Array.from({ length: 5 }, () => {
      attempts++;
      const q = letters[Math.floor(Math.random() * 26)] + vowels[Math.floor(Math.random() * 5)];
      const offset = Math.floor(Math.random() * 150);
      return spotifyApi(`/search?q=${encodeURIComponent(q)}&type=track&limit=10&offset=${offset}`)
        .then(r => (r.ok ? r.json() : null)).catch(() => null);
    });
    for (const data of await Promise.all(batch)) {
      const items = shuffle(data?.tracks?.items || []);
      const pick = items.find(t => t?.id && !found.has(t.id) && !artists.has(t.artists?.[0]?.id)
        && (t.popularity === undefined || t.popularity >= 45) && !t.is_local);
      if (pick && found.size < count) {
        found.set(pick.id, slimTrack(pick));
        artists.add(pick.artists?.[0]?.id);
      }
    }
    onProgress(found.size);
  }
  return [...found.values()];
}

// Random songs from a playlist (all pages), one per artist where possible
async function fetchPlaylistTracks(playlistId, count, onProgress) {
  const all = [];
  let url = `/playlists/${playlistId}/tracks?limit=100&fields=items(track(id,name,artists(id,name),album(images,release_date),duration_ms,is_local)),next`;
  while (url && all.length < 1000) {
    const res = await spotifyApi(url);
    if (!res.ok) break;
    const data = await res.json();
    all.push(...data.items.map(i => i.track).filter(t => t?.id && !t.is_local));
    url = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
    onProgress(Math.min(all.length, count));
  }
  const picked = [];
  const artists = new Set();
  for (const t of shuffle(all)) {
    if (picked.length >= count) break;
    if (artists.has(t.artists?.[0]?.id)) continue;
    artists.add(t.artists?.[0]?.id);
    picked.push(slimTrack(t));
  }
  // Fill up with repeated artists if the playlist has too few different ones
  for (const t of shuffle(all)) {
    if (picked.length >= count) break;
    if (!picked.some(p => p.id === t.id)) picked.push(slimTrack(t));
  }
  return picked;
}

async function startBattle() {
  const size = Number(store.get('battleSize')) || 16;
  const source = store.get('battleSource') || 'random';
  let playlistId = null;
  if (source === 'pack') playlistId = document.getElementById('battle-pack').value;
  if (source === 'playlist') {
    playlistId = extractPlaylistId(document.getElementById('battle-playlist').value.trim());
    if (!playlistId) { showToast(L('t.enterPlaylist')); return; }
  }
  showBattleView('loading');
  const progress = n => {
    document.getElementById('battle-loading-text').textContent = L('battle.loading', { n, size });
    document.getElementById('battle-loading-bar').style.width = `${(n / size) * 100}%`;
  };
  progress(0);
  const tracks = playlistId ? await fetchPlaylistTracks(playlistId, size, progress) : await fetchRandomTracks(size, progress);
  if (tracks.length < size) {
    showToast(L('battle.notEnough', { n: tracks.length, size }));
    showBattleView('setup');
    return;
  }
  battle = {
    size,
    tracks: Object.fromEntries(tracks.map(t => [t.id, t])),
    rounds: [shuffle(tracks.map(t => t.id))],
    picks: [[]],
    round: 0,
    match: 0,
  };
  saveBattle();
  showBattleView('duel');
  renderDuel();
}

function saveBattle() { store.set('battle', battle); }
function battleFinished() { return battle && battle.rounds[battle.rounds.length - 1].length === 1; }
function battleChampion() { return battle.tracks[battle.rounds[battle.rounds.length - 1][0]]; }

// ── Duel ──────────────────────────────────────────────────────────
function roundName(songsLeft) {
  const key = { 2: 'battle.final', 4: 'battle.semi', 8: 'battle.quarter', 16: 'battle.r16' }[songsLeft];
  return key ? L(key) : L('battle.roundOf', { n: songsLeft });
}

function currentPair() {
  const ids = battle.rounds[battle.round];
  return [battle.tracks[ids[battle.match * 2]], battle.tracks[ids[battle.match * 2 + 1]]];
}

function renderDuel() {
  const ids = battle.rounds[battle.round];
  const matches = ids.length / 2;
  const done = battle.rounds.slice(0, battle.round).reduce((n, r) => n + r.length / 2, 0) + battle.match;
  document.getElementById('battle-round').textContent = roundName(ids.length);
  document.getElementById('battle-match').textContent = L('battle.duelOf', { i: battle.match + 1, n: matches });
  document.getElementById('battle-progress').style.width = `${(done / (battle.size - 1)) * 100}%`;
  document.getElementById('battle-hint').textContent = L(isMobile() ? 'battle.hintMobile' : 'battle.hint');

  const [a, b] = currentPair();
  document.getElementById('battle-cards').innerHTML = [a, b].map((t, i) => {
    const side = i === 0 ? 'a' : 'b';
    return `
      <div class="battle-card" id="battle-card-${side}">
        <div class="battle-cover-wrap" onclick="playBattleSide('${side}')">
          ${t.cover ? `<img class="battle-cover" src="${esc(t.cover)}" alt="">` : '<div class="battle-cover battle-cover-ph">🎵</div>'}
          <div class="battle-play-overlay"><span class="battle-play-icon">▶</span><span class="tv-eq battle-eq"><i></i><i></i><i></i><i></i></span></div>
          <span class="battle-side-label">${side.toUpperCase()}</span>
        </div>
        <div class="battle-title">${esc(t.name)}</div>
        <div class="battle-artist">${esc(t.artist)}${t.year ? ` · ${esc(t.year)}` : ''}</div>
        <button class="btn-primary battle-pick" onclick="pickBattle('${side}')">${L('battle.pick')}</button>
      </div>
      ${i === 0 ? '<div class="battle-vs">VS</div>' : ''}`;
  }).join('');
  playDuelSequence();
}

// Plays A, then B; afterwards the player can replay either side any time
function playDuelSequence() {
  playBattleSide('a', () => playBattleSide('b'));
}

function playBattleSide(side, next) {
  clearTimeout(battleTimer);
  const t = currentPair()[side === 'a' ? 0 : 1];
  battlePlaying = side;
  document.querySelectorAll('.battle-card').forEach(c => c.classList.toggle('playing', c.id === 'battle-card-' + side));
  const start = t.duration > SNIPPET_START_MS + SNIPPET_MS ? SNIPPET_START_MS : 0;
  playTrack({ id: t.id }, { positionMs: start });
  battleTimer = setTimeout(() => {
    if (next) next();
    else { stopBattleAudio(true); }
  }, SNIPPET_MS);
}

function stopBattleAudio(fade = false) {
  clearTimeout(battleTimer);
  battlePlaying = null;
  document.querySelectorAll('.battle-card').forEach(c => c.classList.remove('playing'));
  stopAudio(fade);
}

function pickBattle(side) {
  if (!battle || battleFinished()) return;
  const [a, b] = currentPair();
  const winner = side === 'a' ? a : b;
  document.getElementById('battle-card-' + side)?.classList.add('won');
  document.getElementById('battle-card-' + (side === 'a' ? 'b' : 'a'))?.classList.add('lost');
  stopBattleAudio();
  battle.picks[battle.round].push(winner.id);
  battle.match++;
  if (battle.match >= battle.rounds[battle.round].length / 2) {
    battle.rounds.push(battle.picks[battle.round]);
    battle.picks.push([]);
    battle.round++;
    battle.match = 0;
  }
  saveBattle();
  Effects.sound('next');
  setTimeout(() => {
    if (battleFinished()) { showBattleView('end'); renderBattleEnd(true); }
    else renderDuel();
  }, 450);
}

// Keyboard on desktop: ←/1 = A, →/2 = B, A/B keys replay
document.addEventListener('keydown', e => {
  if (document.body.dataset.screen !== 'battle' || document.getElementById('battle-duel').offsetParent === null) return;
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'ArrowLeft' || e.key === '1') pickBattle('a');
  else if (e.key === 'ArrowRight' || e.key === '2') pickBattle('b');
  else if (e.key.toLowerCase() === 'a') playBattleSide('a');
  else if (e.key.toLowerCase() === 'b') playBattleSide('b');
});

// ── Bracket overview ──────────────────────────────────────────────
function openBracket() {
  const cols = battle.rounds.map((ids, r) => {
    const pairs = [];
    for (let i = 0; i < ids.length; i += 2) {
      const next = battle.rounds[r + 1] || battle.picks[r] || [];
      const cell = id => {
        if (!id) return '<div class="bracket-song empty">–</div>';
        const t = battle.tracks[id];
        const won = next.includes(id);
        const out = !won && next.includes(ids[i] === id ? ids[i + 1] : ids[i]);
        return `<div class="bracket-song ${won ? 'won' : ''} ${out ? 'out' : ''}">${esc(t.name)}<small>${esc(t.artist)}</small></div>`;
      };
      const isCurrent = r === battle.round && i / 2 === battle.match && !battleFinished();
      pairs.push(`<div class="bracket-pair ${isCurrent ? 'current' : ''}">${cell(ids[i])}${ids.length > 1 ? cell(ids[i + 1]) : ''}</div>`);
    }
    return `<div class="bracket-col"><div class="bracket-col-title">${ids.length > 1 ? roundName(ids.length) : '🏆'}</div>${pairs.join('')}</div>`;
  });
  document.getElementById('bracket-body').innerHTML = cols.join('');
  document.getElementById('bracket-modal').classList.add('show');
}

function closeBracket() { document.getElementById('bracket-modal').classList.remove('show'); }

function abortBattle() {
  if (!confirm(L('battle.confirmAbort'))) return;
  stopBattleAudio();
  store.del('battle');
  battle = null;
  showBattleView('setup');
  renderBattleSetup();
}

// ── Champion ──────────────────────────────────────────────────────
function renderBattleEnd(fresh) {
  const champ = battleChampion();
  // Songs the champion beat, round by round
  const path = battle.rounds.slice(0, -1).map((ids, r) => {
    const i = ids.indexOf(champ.id);
    const opp = battle.tracks[ids[i % 2 === 0 ? i + 1 : i - 1]];
    return `<li><span>${roundName(ids.length)}</span><b>${esc(opp.name)}</b> · ${esc(opp.artist)}</li>`;
  }).join('');
  document.getElementById('battle-end').querySelector('.battle-champion').innerHTML = `
    ${champ.cover ? `<img class="battle-champion-cover" src="${esc(champ.cover)}" alt="">` : '<div class="battle-champion-cover battle-cover-ph">🎵</div>'}
    <div class="battle-champion-info">
      <div class="battle-champion-label">🏆 ${L('battle.champion', { size: battle.size })}</div>
      <div class="battle-champion-title">${esc(champ.name)}</div>
      <div class="battle-champion-artist">${esc(champ.artist)}${champ.year ? ` · ${esc(champ.year)}` : ''}</div>
      <div class="battle-path-title">${L('battle.path')}</div>
      <ol class="battle-path">${path}</ol>
    </div>`;
  if (fresh) {
    Effects.sound('win');
    Effects.confetti(220);
    playTrack({ id: champ.id }); // the winner plays in full
  }
}

function playChampion() { playTrack({ id: battleChampion().id }); }

function newBattle() {
  stopBattleAudio();
  store.del('battle');
  battle = null;
  showBattleView('setup');
  renderBattleSetup();
}

onLangChange(() => {
  if (document.body.dataset.screen !== 'battle' || !battle) { if (document.body.dataset.screen === 'battle') renderBattleSetup(); return; }
  if (battleFinished()) renderBattleEnd(false);
  else {
    // Only update labels, don't restart the snippets
    const ids = battle.rounds[battle.round];
    document.getElementById('battle-round').textContent = roundName(ids.length);
    document.getElementById('battle-match').textContent = L('battle.duelOf', { i: battle.match + 1, n: ids.length / 2 });
    document.querySelectorAll('.battle-pick').forEach(b => { b.textContent = L('battle.pick'); });
    document.getElementById('battle-hint').textContent = L(isMobile() ? 'battle.hintMobile' : 'battle.hint');
  }
});
