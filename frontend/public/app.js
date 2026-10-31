// ════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════
let state = {
  accessToken: null,
  refreshToken: null,
  myId: null,
  myName: null,
  lobby: null,        // current lobby view from server
  selectedSlotIndex: null,
  challengeSlot: null,  // own SONGLINE! slot, not sent yet
  trackRevealed: false,
  tv: null,             // lobby code if this device shows the TV view
  tvPairing: false,     // TV waiting at /tv to be paired via code
  flashCardId: null,    // card that just entered a timeline (animation)
};
let challengeCountdown = null;

// Music source / play packs
let presetPacks = [];
let selectedSourceTab = 'preset'; // 'preset' | 'playlist' | 'search'
let selectedPresetId = null;
let customPlaylistPreview = null; // {id, name, cover, trackCount}
let customPlaylistDebounce;

const socket = io();
// Player events; the TV view (tv.js) listens on its own
const on = (event, fn) => socket.on(event, (...args) => { if (!state.tv) fn(...args); });

// localStorage may be missing or throw (private window, blocked data)
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('songline:' + k)); } catch(e) { return null; } },
  set(k, v) { try { localStorage.setItem('songline:' + k, JSON.stringify(v)); } catch(e) {} },
  del(k) { try { localStorage.removeItem('songline:' + k); } catch(e) {} },
};
const playerKey = store.get('playerKey') || (() => {
  const k = Math.random().toString(36).slice(2) + Date.now().toString(36);
  store.set('playerKey', k);
  return k;
})();

console.log('%cSONGLINE%c  crafted by Tom13372448', 'font: 700 22px sans-serif; color: #b77cff', 'color: #9d93b8');

let eqTaps = 0, eqTapTimer = null;
document.addEventListener('click', e => {
  if (!e.target.closest('#screen-menu .menu-eq')) return;
  clearTimeout(eqTapTimer);
  eqTapTimer = setTimeout(() => { eqTaps = 0; }, 1500);
  if (++eqTaps === 5) { eqTaps = 0; showToast('🎵 SONGLINE · crafted by Tom13372448'); Effects.confetti(80); }
});

function saveTokens() {
  store.set('spotify', { accessToken: state.accessToken, refreshToken: state.refreshToken });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let spotifyPlayer = null;
let playerDeviceId = null;
let audioProgressInterval = null;
let spotifySdkLoading = false;
let spotifyDevices = [];      // the host's Spotify Connect devices
let selectedDeviceId = store.get('deviceId');  // null = this browser (Web Playback SDK)
let wakeLock = null;
let volume = store.get('volume') ?? 80;   // 0–100, applies to browser player and Connect devices
let mutedVolume = null;                   // volume before muting
let fadeToken = 0;                        // cancels a running fade when a new song starts

socket.on('connect', () => {
  state.myId = socket.id;
  if (state.tvPairing) { socket.emit('tv:register'); return; }
  if (state.tv) { socket.emit('lobby:watch', { code: state.tv }); return; }
  // After a reload or connection loss, automatically return to the lobby
  const session = store.get('session');
  if (session?.code) socket.emit('lobby:rejoin', { code: session.code, playerKey });
});

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const at = params.get('access_token');
  const rt = params.get('refresh_token');

  const joinCode = params.get('join');
  const tvCode = params.get('tv');
  const saved = store.get('spotify');

  // TV without lobby code: show pairing code
  if (location.pathname === '/tv' && !tvCode) {
    state.tvPairing = true;
    document.body.classList.add('tv-mode');
    showScreen('tv-pair');
    if (socket.connected) socket.emit('tv:register');
    return;
  }

  if (tvCode) {
    state.tv = tvCode.toUpperCase();
    startTv(state.tv);
    if (socket.connected) socket.emit('lobby:watch', { code: state.tv });
    return;
  }

  if (at) {
    state.accessToken = at;
    state.refreshToken = rt;
    saveTokens();
  } else if (saved?.accessToken) {
    state.accessToken = saved.accessToken;
    state.refreshToken = saved.refreshToken;
  }
  if (at || joinCode) window.history.replaceState({}, '', '/');

  document.getElementById('home-name').value = store.get('name') || '';
  syncMenu();
  showScreen('menu');

  if (joinCode) {
    document.getElementById('lobby-code-input').value = joinCode.toUpperCase();
    toggleJoin(true);
    document.getElementById(store.get('name') ? 'lobby-code-input' : 'home-name').focus();
  } else if (at && store.get('pendingBattle')) {
    // Back from the Spotify login started via "Song Battle"
    store.del('pendingBattle');
    openBattle();
  } else if (at && store.get('pendingCreate')) {
    // Back from the Spotify login started via "host game"
    store.del('pendingCreate');
    if (!store.get('session')) createLobby();
  }
});

// ════════════════════════════════════════════════════════════════
// SOCKET EVENTS
// ════════════════════════════════════════════════════════════════
on('lobby:created', ({ code, lobby }) => {
  state.lobby = lobby;
  store.set('session', { code });
  state.myId = socket.id;
  if (state.accessToken) { initSpotifySDK(); loadDevices(); }
  showLobbyScreen(lobby);
});

on('lobby:joined', ({ code, lobby }) => {
  state.lobby = lobby;
  store.set('session', { code });
  state.myId = socket.id;
  if (lobby.status === 'playing') enterGame(lobby);
  else showLobbyScreen(lobby);
});

on('lobby:updated', (lobby) => {
  state.lobby = lobby;
  if (document.getElementById('screen-lobby').classList.contains('active')) {
    refreshLobby(lobby);
  } else if (document.getElementById('screen-game').classList.contains('active')) {
    renderScores(lobby);
    if (lobby.gameMode === 'classic') renderTimeline();
    updateActionButtons();
  }
});

on('lobby:rejoined', ({ lobby }) => {
  state.lobby = lobby;
  state.myId = socket.id;
  if (isHost() && state.accessToken) { initSpotifySDK(); loadDevices(); shareTokenWithLobby(); }
  if (lobby.status === 'playing' && amAway(lobby)) {
    showLobbyScreen(lobby);
  } else if (lobby.status === 'playing') {
    // Only rebuild if we are not in the game already (e.g. short Wi-Fi hiccup)
    if (!document.getElementById('screen-game').classList.contains('active')) {
      enterGame(lobby);
    } else {
      renderScores(lobby);
      syncPause();
    }
  } else if (!document.getElementById('screen-end').classList.contains('active')) {
    showLobbyScreen(lobby);
  }
});

on('lobby:rejoin-failed', () => {
  store.del('session');
  if (state.lobby) {
    state.lobby = null;
    showToast(L('t.lobbyGone'));
    showScreen('menu');
  }
});

on('lobby:error', msg => showToast(serverText(msg)));
on('player:left', ({ playerName }) => showToast(L('t.playerLeft', { name: playerName })));

on('game:started', ({ lobby }) => {
  state.lobby = lobby;
  state.selectedSlotIndex = null;
  state.trackRevealed = false;
  applyModeUI(lobby.gameMode);
  syncAudioPlaybackUI();
  showScreen('game');
});

// Players who went "back to lobby" get no game view – only the lobby is refreshed
function amAway(lobby = state.lobby) { return !!lobby?.players.find(p => p.id === state.myId)?.away; }
function handleWhileAway(lobby) {
  if (!amAway(lobby)) return false;
  state.lobby = lobby;
  if (document.getElementById('screen-lobby').classList.contains('active')) refreshLobby(lobby);
  return true;
}

on('game:track', ({ track, lobby }) => {
  if (handleWhileAway(lobby)) { if (isHost()) playTrack(track); return; }
  state.lobby = lobby;
  state.selectedSlotIndex = null;
  state.challengeSlot = null;
  state.trackRevealed = false;
  hideVerdict();
  renderGameState(lobby);
  if (isMyTurn()) notifyMyTurn();
  else Effects.sound('next');
  if (isHost()) playTrack(track);
  else clearInterval(audioProgressInterval);
});

on('game:needs-track', ({ lobby }) => {
  if (handleWhileAway(lobby)) { if (isHost()) { stopAudio(); openSearchModal(); } return; }
  state.lobby = lobby;
  hideVerdict();
  renderGameState(lobby);
  stopAudio();
  document.getElementById('track-hidden').style.display = 'block';
  document.getElementById('track-revealed').classList.remove('show');
  // Only host sees search modal
  if (isHost()) openSearchModal();
  else {
    document.getElementById('waiting-banner').style.display = 'block';
    document.getElementById('waiting-text').textContent = L('game.hostPicking');
  }
});

on('game:slot-selected', ({ slotIndex }) => {
  if (amAway()) return;
  state.selectedSlotIndex = slotIndex;
  renderTimeline();
  if (!isMyTurn()) {
    const cp = currentUnit();
    document.getElementById('game-hint').textContent = L('game.thinking', { name: un(cp?.name), slot: getSlotDescription(slotIndex) });
  }
  updateActionButtons();
});

on('game:verdict', ({ correct, gaveUp, track, currentPlayerName, stolenBy, tokenEarned, reason, lobby }) => {
  if (handleWhileAway(lobby)) { if (isHost()) stopAudio(true); return; }
  state.lobby = lobby;
  stopAudio(true);
  state.selectedSlotIndex = null;
  state.challengeSlot = null;
  state.flashCardId = correct || stolenBy ? track.id : null;
  renderScores(lobby);
  updateChallengeUI();
  updateActionButtons();
  if (lobby.gameMode === 'classic') renderTimeline();
  showVerdict(correct, gaveUp, track, currentPlayerName, stolenBy, tokenEarned, reason);
  Effects.sound(stolenBy ? 'songline' : correct ? 'correct' : 'wrong');
  if (correct && isMyTurn()) Effects.confetti(60);
});

on('game:challenge', ({ lobby }) => {
  if (handleWhileAway(lobby)) return;
  const wasOpen = state.lobby?.turn?.phase === 'challenge';
  state.lobby = lobby;
  const taken = lobby.turn.challenges.some(c => c.slotIndex === state.challengeSlot);
  if (taken || !canChallenge()) state.challengeSlot = null;
  renderScores(lobby);
  renderTimeline();
  updateActionButtons();
  updateChallengeUI();
  if (!wasOpen && canChallenge() && navigator.vibrate) navigator.vibrate(80);
  if (!wasOpen && canChallenge()) scrollToAction('challenge-panel');
  if (wasOpen && lobby.turn.challenges.length) Effects.sound('songline');
});

on('game:card-bought', ({ playerName, card, lobby }) => {
  if (handleWhileAway(lobby)) return;
  state.lobby = lobby;
  state.selectedSlotIndex = null;
  state.flashCardId = card.id;
  renderScores(lobby);
  renderTimeline();
  updateActionButtons();
  showToast(L('t.cardBought', { name: un(playerName), song: card.name, year: card.year }));
});

on('game:info', msg => showToast(serverText(msg)));

on('game:paused', ({ paused, lobby }) => {
  if (handleWhileAway(lobby)) return;
  state.lobby = lobby;
  syncPause();
  updateChallengeUI();
  if (!paused) showToast(L('pause.back'));
});
on('spotify:refresh-needed', () => refreshAccessToken());

on('game:ended', ({ winner, lobby }) => {
  state.lobby = lobby;
  hideVerdict();
  stopAudio(true);
  showEndScreen(winner, lobby);
  Effects.sound('win');
  Effects.confetti(220);
});

on('game:error', msg => showToast(serverText(msg)));

on('game:back-to-lobby', () => {
  hideVerdict();
  if (state.lobby) showLobbyScreen(state.lobby);
});

// ════════════════════════════════════════════════════════════════
// LOBBY
// ════════════════════════════════════════════════════════════════
function isHost() { return state.lobby && state.lobby.hostId === state.myId; }
// Unit = player or team (see server.js)
function currentUnit() { return state.lobby?.units.find(u => u.id === state.lobby.currentUnitId); }
function myUnit() { return state.lobby?.units.find(u => u.memberIds.includes(state.myId)); }
function isMyTurn() { return !!currentUnit()?.memberIds.includes(state.myId); }
function playingUnits(lobby = state.lobby) { return (lobby?.units || []).filter(u => u.memberIds.length || u.awayNames?.length); }

function enterGame(lobby) {
  applyModeUI(lobby.gameMode);
  syncAudioPlaybackUI();
  showScreen('game');
  renderGameState(lobby);
  syncPause();
}

function syncPause() {
  const paused = !!state.lobby?.paused && state.lobby.status === 'playing';
  document.getElementById('pause-overlay').classList.toggle('show', paused);
}

function createLobby() {
  const nameInput = document.getElementById('home-name');
  const name = nameInput.value.trim();
  if (!name) { showToast(L('t.enterName')); nameInput.focus(); return; }
  if (!state.accessToken) {
    // Go to Spotify first, the lobby is created automatically afterwards
    store.set('name', name);
    store.set('pendingCreate', true);
    location.href = '/api/login';
    return;
  }
  state.myName = name;
  store.set('name', name);
  socket.emit('lobby:create', { playerName: name, playerKey });
}

// Start menu: show host status
function syncMenu() {
  const loggedIn = !!state.accessToken;
  document.getElementById('spotify-status').style.display = loggedIn ? 'flex' : 'none';
  document.getElementById('host-sub').textContent = L(loggedIn ? 'menu.hostSubLoggedIn' : 'menu.hostSub');
  document.getElementById('menu-account').innerHTML = L(loggedIn ? 'menu.footerLoggedIn' : 'menu.footer');
}

function logoutSpotify() {
  state.accessToken = null;
  state.refreshToken = null;
  store.del('spotify');
  syncMenu();
  showToast(L('t.loggedOut'));
}

// Start menu: "Join" opens a small drawer with the code field
function toggleJoin(open) {
  const el = document.getElementById('menu-join');
  const show = open ?? !el.classList.contains('open');
  el.classList.toggle('open', show);
  if (show) setTimeout(() => document.getElementById('lobby-code-input').focus(), 150);
}

function openRules() { document.getElementById('rules-modal').classList.add('show'); }
function closeRules() { document.getElementById('rules-modal').classList.remove('show'); }

function joinLobby() {
  const name = document.getElementById('home-name').value.trim();
  const code = document.getElementById('lobby-code-input').value.trim().toUpperCase();
  if (!name) { showToast(L('t.enterName')); document.getElementById('home-name').focus(); return; }
  if (code.length !== 4) { showToast(L('t.enterCode')); return; }
  state.myName = name;
  store.set('name', name);
  socket.emit('lobby:join', { code, playerName: name, playerKey });
}

async function shareLobby() {
  if (!state.lobby) return;
  const url = `${location.origin}/?join=${state.lobby.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Songline', text: L('t.shareText', { code: state.lobby.code }), url }); return; }
    catch(e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast(L('t.linkCopied'));
  } catch(e) {
    showToast(url);
  }
}

function showQr() {
  if (!state.lobby) return;
  const url = `${location.origin}/?join=${state.lobby.code}`;
  document.getElementById('qr-img').src = `/api/qr?text=${encodeURIComponent(url)}`;
  document.getElementById('qr-code').textContent = state.lobby.code;
  document.getElementById('qr-modal').classList.add('show');
}

function closeQr() {
  document.getElementById('qr-modal').classList.remove('show');
}

function openTvView() {
  if (state.lobby) window.open(`/?tv=${state.lobby.code}`, '_blank');
}

function openTvDialog() {
  document.getElementById('tv-pair-url').textContent = `${location.host}/tv`;
  document.getElementById('tv-cast-option').style.display = window.PresentationRequest ? '' : 'none';
  document.getElementById('tv-modal').classList.add('show');
}

function closeTvDialog() {
  document.getElementById('tv-modal').classList.remove('show');
}

// Presentation API: Chrome shows its cast dialog (e.g. Chromecast) for the TV view
async function castTv() {
  if (!state.lobby) return;
  try {
    const request = new PresentationRequest([`${location.origin}/?tv=${state.lobby.code}`]);
    await request.start();
    closeTvDialog();
    showToast(L('t.casting'));
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'AbortError') return; // cancelled
    showToast(e.name === 'NotFoundError'
      ? L('t.castNoDevice')
      : L('t.castFailed'));
  }
}

function linkTv() {
  const tvCode = document.getElementById('tv-pair-input').value.trim();
  if (!/^\d{4}$/.test(tvCode)) { showToast(L('t.tvCodeFormat')); return; }
  socket.emit('lobby:link-tv', { code: state.lobby.code, tvCode }, ({ ok }) => {
    if (!ok) { showToast(L('t.tvCodeUnknown')); return; }
    document.getElementById('tv-pair-input').value = '';
    closeTvDialog();
    showToast(L('t.tvLinked'));
  });
}

socket.on('tv:code', ({ code }) => {
  document.getElementById('tv-pair-code').textContent = code;
});

socket.on('tv:linked', ({ code }) => {
  state.tvPairing = false;
  state.tv = code;
  window.history.replaceState({}, '', `/?tv=${code}`);
  startTv(code);
  socket.emit('lobby:watch', { code });
});

function leaveLobby() {
  if (state.lobby?.status === 'playing') {
    const msg = isHost() && state.lobby.players.length > 1
      ? L('t.confirmLeaveHost')
      : L('t.confirmLeave');
    if (!confirm(msg)) return;
  }
  stopAudio();
  if (state.lobby) socket.emit('lobby:leave', { code: state.lobby.code });
  store.del('session');
  state.lobby = null;
  hideVerdict();
  closeSearchModal();
  showScreen('menu');
}

function showLobbyScreen(lobby) {
  document.getElementById('lobby-code-display').textContent = lobby.code;
  refreshLobby(lobby);
  showScreen('lobby');
}

// Lobby content by status: settings only before the game, the "round running" banner during a round
function refreshLobby(lobby) {
  const host = isHost();
  const playing = lobby.status === 'playing';
  renderLobbyPlayers(lobby);
  syncLobbySettings(lobby);
  document.getElementById('lobby-settings').style.display = host && !playing ? 'block' : 'none';
  document.getElementById('lobby-guest-info').style.display = !host && !playing ? 'block' : 'none';
  document.getElementById('round-banner').style.display = playing ? 'flex' : 'none';
  document.getElementById('close-lobby-wrap').style.display = host ? 'block' : 'none';
  if (playing) {
    const cur = lobby.units.find(u => u.id === lobby.currentUnitId);
    const best = Math.max(0, ...lobby.units.map(u => u.score));
    document.getElementById('round-banner-sub').textContent =
      [L('lobby.bannerRound', { round: lobby.round }), cur && L('lobby.bannerTurn', { name: un(cur.name) }),
       lobby.paused && L('lobby.bannerPause'), L('lobby.bannerBest', { best, win: lobby.winCards })].filter(Boolean).join(' · ');
  }
}

// "Back to lobby" during a round: score & timeline are kept, rejoining is possible any time
function leaveRound() {
  if (!state.lobby) return;
  if (state.lobby.status !== 'playing') { showLobbyScreen(state.lobby); return; }
  if (!confirm(L('t.confirmToLobby'))) return;
  // The host keeps playing the music – only the view changes
  if (!isHost()) stopAudio();
  hideVerdict();
  socket.emit('game:sit-out', { code: state.lobby.code });
  showLobbyScreen(state.lobby);
}

function rejoinRound() {
  if (!state.lobby) return;
  socket.emit('game:sit-in', { code: state.lobby.code }, ({ ok, lobby }) => {
    if (!ok) { showToast(L('t.roundOver')); return; }
    state.lobby = lobby;
    enterGame(lobby);
  });
}

function closeLobby() {
  if (!state.lobby || !isHost()) return;
  const msg = state.lobby.status === 'playing'
    ? L('t.confirmCloseRunning')
    : L('t.confirmClose');
  if (!confirm(msg)) return;
  socket.emit('lobby:close', { code: state.lobby.code });
}

// Lobby was closed (by the host) → everyone back to the start menu
on('lobby:closed', () => {
  const wasHost = isHost();
  stopAudio();
  store.del('session');
  state.lobby = null;
  hideVerdict();
  closeSearchModal();
  closeQr();
  closeTvDialog();
  document.getElementById('pause-overlay').classList.remove('show');
  showScreen('menu');
  showToast(L(wasHost ? 't.lobbyClosed' : 't.lobbyClosedByHost'));
});

// "Play again!": same players, teams and settings – new round right away
function rematch() {
  if (!state.lobby || !isHost()) return;
  if (!state.accessToken) { showToast(L('t.hostNeedsSpotify')); return; }
  socket.emit('game:start', { code: state.lobby.code, token: state.accessToken, rematch: true });
}

function playerRow(lobby, p) {
  return `
    <div class="lobby-player-row">
      <div class="player-avatar">${esc(p.name[0].toUpperCase())}</div>
      <div class="player-name" style="flex:1${p.connected ? '' : ';opacity:0.45'}">${esc(p.name)}${p.connected ? '' : ' ' + L('lobby.offline')}</div>
      ${lobby.status === 'playing' ? `<span class="status-pill ${p.away ? 'away' : 'in'}">${L(p.away ? 'lobby.statusAway' : 'lobby.statusIn')}</span>` : ''}
      ${p.id === lobby.hostId ? `<span class="badge">${L('lobby.host')}</span>` : ''}
      ${p.id === state.myId ? `<span class="badge" style="background:var(--green);color:#000">${L('lobby.you')}</span>` : ''}
    </div>`;
}

function renderLobbyPlayers(lobby) {
  const el = document.getElementById('lobby-players-list');
  if (!lobby.teamMode) {
    el.innerHTML = lobby.players.map(p => playerRow(lobby, p)).join('');
    return;
  }
  // Team mode: players grouped by team, tapping a team switches to it
  el.innerHTML = lobby.units.map(team => {
    const members = lobby.players.filter(p => p.team === team.id);
    const mine = members.some(p => p.id === state.myId);
    return `
      <div class="team-block" style="--team:${team.color}">
        <div class="team-head" onclick="joinTeam('${team.id}')">
          <span class="team-dot"></span>
          <span class="team-name">${esc(un(team.name))}</span>
          <span class="team-join">${L(mine ? 'lobby.yourTeam' : 'lobby.joinTeam')}</span>
        </div>
        ${members.map(p => playerRow(lobby, p)).join('') || `<div class="team-empty">${L('lobby.nobody')}</div>`}
      </div>`;
  }).join('');
}

function joinTeam(teamId) {
  if (state.lobby) socket.emit('lobby:team', { code: state.lobby.code, teamId });
}

function shuffleTeams() {
  if (state.lobby) socket.emit('lobby:shuffle-teams', { code: state.lobby.code });
}


function syncVariant(variant) {
  document.querySelectorAll('.variant-tab').forEach(el => el.classList.toggle('active', el.dataset.variant === variant));
  document.getElementById('classic-rules').innerHTML = L(`variant.${['original', 'pro', 'expert'].includes(variant) ? variant : 'original'}Rules`);
}

function setVariant(variant) {
  syncVariant(variant);
  emitSettings();
}

function syncTeamControls(lobby) {
  document.getElementById('team-mode').checked = !!lobby.teamMode;
  document.getElementById('team-count').value = String(lobby.teamCount || 2);
  document.getElementById('team-options').style.display = lobby.teamMode ? 'flex' : 'none';
}

function syncModeHints(mode) {
  const classic = mode === 'classic';
  document.getElementById('classic-options').style.display = classic ? 'block' : 'none';
  document.getElementById('win-cards-label').textContent = L(classic ? 'win.cards' : 'win.points');
}

function syncLobbySettings(lobby) {
  syncModeHints(lobby.gameMode);
  syncVariant(lobby.variant || 'original');
  syncTeamControls(lobby);
  document.querySelectorAll('#lobby-settings .mode-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.mode === lobby.gameMode);
  });

  // The music source tab now comes explicitly from the server (no longer guessed)
  selectedSourceTab = lobby.sourceTab || 'search';
  if (lobby.presetId) selectedPresetId = lobby.presetId;
  document.querySelectorAll('.source-tab').forEach(el =>
    el.classList.toggle('active', el.dataset.source === selectedSourceTab));
  document.getElementById('source-preset-wrap').style.display = selectedSourceTab === 'preset' ? 'block' : 'none';
  document.getElementById('source-playlist-wrap').style.display = selectedSourceTab === 'playlist' ? 'block' : 'none';
  document.getElementById('source-search-wrap').style.display = selectedSourceTab === 'search' ? 'block' : 'none';

  if (selectedSourceTab === 'preset' && !presetPacks.length && state.accessToken) loadPresetPacks();
  renderPackGrid();
  updatePlaylistBanner(lobby);
}

function updatePlaylistBanner(lobby) {
  const banner = document.getElementById('selected-playlist-banner');
  if (lobby.sourceType === 'playlist' && lobby.playlistCover) {
    banner.style.display = 'flex';
    document.getElementById('selected-playlist-cover').src = lobby.playlistCover;
    document.getElementById('selected-playlist-name').textContent = lobby.playlistName || 'Playlist';
  } else {
    banner.style.display = 'none';
  }
}

function setLobbyMode(mode) {
  if (!state.lobby) return;
  document.querySelectorAll('#lobby-settings .mode-option').forEach(el =>
    el.classList.toggle('selected', el.dataset.mode === mode));
  syncModeHints(mode);
  emitSettings();
}

// ── Music source: tabs (play packs / own playlist / search) ───────────────
function setSourceTab(tab) {
  selectedSourceTab = tab;
  document.querySelectorAll('.source-tab').forEach(el => el.classList.toggle('active', el.dataset.source === tab));
  document.getElementById('source-preset-wrap').style.display = tab === 'preset' ? 'block' : 'none';
  document.getElementById('source-playlist-wrap').style.display = tab === 'playlist' ? 'block' : 'none';
  document.getElementById('source-search-wrap').style.display = tab === 'search' ? 'block' : 'none';
  if (tab === 'preset' && !presetPacks.length) loadPresetPacks();
  emitSettings();
}

async function loadPresetPacks() {
  if (!state.accessToken) return;
  try {
    const res = await apiFetch(`/api/preset-packs?token=${state.accessToken}`);
    const data = await res.json();
    presetPacks = data.packs || [];
    renderPackGrid();
  } catch(e) {
    document.getElementById('pack-grid').innerHTML =
      `<p class="text-muted" style="grid-column:1/-1;text-align:center;padding:12px">${L('source.packsFailed')}</p>`;
  }
}

function renderPackGrid() {
  const el = document.getElementById('pack-grid');
  if (!el) return;
  if (!presetPacks.length) return; // still loading / no token
  el.innerHTML = presetPacks.map(p => `
    <div class="pack-card ${selectedPresetId === p.id ? 'selected' : ''}" onclick="selectPack('${p.id}')">
      ${p.cover ? `<img class="pack-cover" src="${p.cover}" alt="">` : `<div class="pack-cover-placeholder">${p.icon || '🎵'}</div>`}
      <div class="pack-info">
        <div class="pack-name">${p.icon ? p.icon + ' ' : ''}${p.spotifyName || p.name}</div>
        <div class="pack-count">${p.trackCount != null ? L('source.songs', { n: p.trackCount }) : ''}</div>
      </div>
    </div>
  `).join('');
}

function selectPack(id) {
  selectedPresetId = id;
  renderPackGrid();
  emitSettings();
}

function onLobbySourceChange() {
  // Legacy no-op (kept for compatibility, no longer called)
}

function onCustomPlaylistInput() {
  clearTimeout(customPlaylistDebounce);
  const previewEl = document.getElementById('custom-playlist-preview');
  customPlaylistDebounce = setTimeout(async () => {
    const id = extractPlaylistId(document.getElementById('lobby-playlist-input').value.trim());
    if (!id || !state.accessToken) {
      customPlaylistPreview = null;
      previewEl.innerHTML = '';
      return;
    }
    previewEl.innerHTML = `<p class="text-muted" style="padding:8px 0">${L('source.loadingPlaylist')}</p>`;
    try {
      const res = await apiFetch(`/api/playlist-info?id=${id}&token=${state.accessToken}`);
      if (!res.ok) throw new Error('not found');
      const data = await res.json();
      customPlaylistPreview = { id, name: data.name, cover: data.cover, trackCount: data.trackCount };
      previewEl.innerHTML = `
        <div class="selected-playlist-banner" style="margin-top:10px;margin-bottom:0">
          ${data.cover ? `<img src="${data.cover}" alt="">` : ''}
          <div>
            <div class="spb-name">${data.name}</div>
            <div class="text-muted" style="font-size:0.75rem">${data.trackCount != null ? L('source.songs', { n: data.trackCount }) : ''}</div>
          </div>
        </div>`;
    } catch(e) {
      customPlaylistPreview = null;
      previewEl.innerHTML = `<p class="text-muted" style="padding:8px 0;color:var(--red)">${L('source.playlistNotFound')}</p>`;
    }
    emitSettings();
  }, 500);
}

function emitSettings() {
  if (!state.lobby) return;
  const mode = document.querySelector('#lobby-settings .mode-option.selected')?.dataset.mode || 'classic';
  const winCards = document.getElementById('lobby-win-cards').value;

  let sourceType, playlistId, playlistCover, playlistName, presetId;

  if (selectedSourceTab === 'preset') {
    const pack = presetPacks.find(p => p.id === selectedPresetId);
    sourceType = 'playlist';
    playlistId = pack ? pack.playlistId : null;
    playlistCover = pack ? pack.cover : null;
    playlistName = pack ? (pack.spotifyName || pack.name) : null;
    presetId = selectedPresetId;
  } else if (selectedSourceTab === 'playlist') {
    sourceType = 'playlist';
    playlistId = extractPlaylistId(document.getElementById('lobby-playlist-input').value.trim());
    playlistCover = customPlaylistPreview?.cover || null;
    playlistName = customPlaylistPreview?.name || null;
    presetId = null;
  } else {
    sourceType = 'search';
    playlistId = null;
    playlistCover = null;
    playlistName = null;
    presetId = null;
  }

  socket.emit('lobby:settings', {
    code: state.lobby.code, gameMode: mode,
    variant: document.querySelector('.variant-tab.active')?.dataset.variant || 'original',
    teamMode: document.getElementById('team-mode').checked,
    teamCount: document.getElementById('team-count').value,
    sourceType, sourceTab: selectedSourceTab, playlistId, playlistCover, playlistName, presetId,
    winCards,
  });
}

function startLobbyGame() {
  if (!state.lobby) return;
  if (!state.accessToken) {
    showToast(L('t.hostNeedsSpotifyStart'));
    return;
  }
  if (selectedSourceTab === 'preset' && !selectedPresetId) {
    showToast(L('t.choosePack')); return;
  }
  if (selectedSourceTab === 'playlist' && !document.getElementById('lobby-playlist-input').value.trim()) {
    showToast(L('t.enterPlaylist')); return;
  }
  emitSettings();
  setTimeout(() => {
    socket.emit('game:start', { code: state.lobby.code, token: state.accessToken });
  }, 100);
}

function extractPlaylistId(input) {
  const m = input.match(/playlist\/([a-zA-Z0-9]+)/);
  return m ? m[1] : (input.match(/^[a-zA-Z0-9]+$/) ? input : null);
}

// ════════════════════════════════════════════════════════════════
// SPOTIFY WEB PLAYBACK SDK
// ════════════════════════════════════════════════════════════════
function initSpotifySDK() {
  if (spotifyPlayer || spotifySdkLoading) return;
  spotifySdkLoading = true;
  const script = document.createElement('script');
  script.src = 'https://sdk.scdn.co/spotify-player.js';
  document.head.appendChild(script);

  window.onSpotifyWebPlaybackSDKReady = () => {
    spotifyPlayer = new Spotify.Player({
      name: 'Songline',
      getOAuthToken: cb => cb(state.accessToken),
      volume: volume / 100,
    });

    spotifyPlayer.addListener('ready', ({ device_id }) => {
      playerDeviceId = device_id;
      renderDeviceSelects();
    });

    spotifyPlayer.addListener('not_ready', () => {
      playerDeviceId = null;
      renderDeviceSelects();
    });

    spotifyPlayer.addListener('initialization_error', ({ message }) => {
      showToast(L('t.playerError', { msg: message }));
    });

    spotifyPlayer.addListener('authentication_error', () => {
      showToast(L('t.premiumRequired'));
    });

    spotifyPlayer.connect();
  };
}

function syncAudioPlaybackUI() {
  const host = isHost();
  document.getElementById('audio-player').style.display = host ? 'flex' : 'none';
  document.getElementById('audio-device-picker').style.display = host ? 'flex' : 'none';
  document.getElementById('volume-row').style.display = host ? 'flex' : 'none';
  syncVolumeUI();
  renderDeviceSelects();
  document.getElementById('audio-host-message').style.display = host ? 'none' : 'block';
  if (host) loadDevices();
  // No manual song swapping in classic mode (with "search songs" the search opens automatically anyway)
  const classic = state.lobby?.gameMode === 'classic';
  document.getElementById('manual-search-button').style.display = host && !classic ? '' : 'none';
}

// ════════════════════════════════════════════════════════════════
// SCREENS
// ════════════════════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  document.body.dataset.screen = id;
  if (id === 'lobby' || id === 'game') keepScreenOn();
}

// Keep the screen on during the game – otherwise the phone sleeps and the connection drops
async function keepScreenOn() {
  if (wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch(e) {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.lobby) keepScreenOn();
});

// ════════════════════════════════════════════════════════════════
// PHONE VS. DESKTOP
// ════════════════════════════════════════════════════════════════
// Touch devices with a small screen (and very narrow windows) get the mobile layout:
// vertical timeline, thumb action bar, compact scores – see body.mobile in styles.css
const mobileQuery = matchMedia('(pointer: coarse) and (max-width: 820px), (max-width: 600px)');
function isMobile() { return mobileQuery.matches; }
function syncDeviceClass() { document.body.classList.toggle('mobile', isMobile()); }
mobileQuery.addEventListener?.('change', syncDeviceClass);
syncDeviceClass(); // app.js runs at the end of <body>, so set it right away (no desktop flash on phones)

// On phones, bring the part that needs input into view
function scrollToAction(id) {
  if (!isMobile()) return;
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
}

function notifyMyTurn() {
  showToast(L(state.lobby?.teamMode ? 'game.yourTeamTurn' : 'game.yourTurn'));
  Effects.sound('turn');
  scrollToAction(state.lobby?.gameMode === 'classic' ? 'timeline-section' : 'guess-section');
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

// ════════════════════════════════════════════════════════════════
// GAME UI
// ════════════════════════════════════════════════════════════════
function applyModeUI(gameMode) {
  const isGuess = gameMode !== 'classic';
  document.getElementById('timeline-section').style.display = isGuess ? 'none' : 'block';
  document.getElementById('guess-section').style.display = isGuess ? 'block' : 'none';
  document.getElementById('guess-artist-wrap').style.display = gameMode === 'guess-hard' ? 'block' : 'none';
  document.getElementById('btn-guess').style.display = isGuess ? 'none' : 'block';
  document.getElementById('btn-reveal').textContent = L(isGuess ? 'game.giveUp' : 'game.noIdea');
  document.getElementById('skip-button').textContent = L(isGuess ? 'game.skipSong' : 'game.skip');
}

function renderGameState(lobby) {
  const cp = currentUnit();
  if (!cp) return;
  const myTurn = isMyTurn();

  const who = lobby.teamMode ? `${un(cp.name)} (${cp.memberNames.join(', ')})` : cp.name;
  document.getElementById('current-player-display').textContent = un(cp.name);
  document.getElementById('current-player-display').style.color = cp.color || '';
  document.getElementById('round-display').textContent = L('game.round', { round: lobby.round });
  document.getElementById('waiting-banner').style.display = myTurn ? 'none' : 'block';
  document.getElementById('waiting-text').textContent = L('game.waitingFor', { name: who });

  // Controls: only active on my turn
  document.getElementById('guess-section').style.display =
    (lobby.gameMode !== 'classic' && myTurn) ? 'block' : (lobby.gameMode !== 'classic' ? 'none' : 'none');
  if (lobby.gameMode !== 'classic') {
    document.getElementById('guess-section').style.display = myTurn ? 'block' : 'none';
  }
  updateActionButtons();
  document.getElementById('token-title').value = '';
  document.getElementById('token-artist').value = '';
  document.getElementById('token-year').value = '';
  syncTokenGuess(lobby.variant);
  document.getElementById('timeline-label').textContent = myTurn
    ? L(lobby.teamMode ? 'game.ourTimeline' : 'game.myTimeline')
    : L('game.timelineOf', { name: un(cp.name) });

  document.getElementById('track-hidden').style.display = 'block';
  document.getElementById('track-revealed').classList.remove('show');
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('time-label').textContent = '0:00';
  document.getElementById('play-btn').textContent = '▶';
  document.getElementById('guess-title').value = '';
  document.getElementById('guess-artist').value = '';

  const isGuess = lobby.gameMode !== 'classic';
  document.getElementById('game-hint').textContent = myTurn
    ? (isGuess
        ? L(lobby.gameMode === 'guess-hard' ? 'game.hintHard' : 'game.hintEasy')
        : L('game.hintPlace'))
    : L('game.waitFor', { name: un(cp.name) });

  renderScores(lobby);
  if (lobby.gameMode === 'classic') renderTimeline();
  updateChallengeUI();

  if (isGuess && myTurn) setTimeout(() => document.getElementById('guess-title').focus(), 300);
}

// opts.positionMs: start somewhere in the song (Song Battle snippets)
async function playTrack(track, opts = {}) {
  fadeToken++; // cancel a running fade of the previous song
  if (usingBrowserPlayer() && !playerDeviceId) {
    showToast(L('t.playerConnecting'));
    await new Promise(r => setTimeout(r, 2000));
    if (!playerDeviceId) { showToast(L('t.noPlayer')); return; }
  }
  const deviceId = activeDeviceId();
  try {
    const play = () => spotifyApi(`/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [`spotify:track:${track.id}`], position_ms: opts.positionMs || 0 }),
    });
    let response = await play();
    if (response.status === 404) {
      // Inactive Connect devices must be activated first
      await spotifyApi('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) });
      await new Promise(r => setTimeout(r, 800));
      response = await play();
    }
    if (!response.ok) {
      showToast(response.status === 403
        ? L('t.hostPremium')
        : response.status === 404
          ? L('t.deviceUnreachable')
          : L('t.playFailed'));
      return;
    }
    document.getElementById('play-btn').textContent = '⏸';
    applyVolume(volume);
    setupProgressPolling();
  } catch(e) {
    showToast(L('t.playFailed'));
  }
}

// ════════════════════════════════════════════════════════════════
// VOLUME & FADE-OUT
// ════════════════════════════════════════════════════════════════
let volumeDebounce = null;

// Sets the volume on the active device (browser player or Spotify Connect)
function applyVolume(v) {
  if (usingBrowserPlayer()) {
    return spotifyPlayer ? spotifyPlayer.setVolume(Math.max(0, v) / 100).catch(() => {}) : Promise.resolve();
  }
  if (!state.accessToken || !selectedDeviceId) return Promise.resolve();
  // Some devices (e.g. iPhone) don't allow remote volume control – ignore errors
  return spotifyApi(`/me/player/volume?volume_percent=${Math.round(v)}&device_id=${selectedDeviceId}`, { method: 'PUT' }).catch(() => {});
}

function setVolume(value) {
  volume = Number(value);
  mutedVolume = null;
  store.set('volume', volume);
  syncVolumeUI();
  // Don't call Connect devices on every slider movement
  clearTimeout(volumeDebounce);
  volumeDebounce = setTimeout(() => applyVolume(volume), usingBrowserPlayer() ? 0 : 200);
}

function toggleMute() {
  if (mutedVolume !== null) { setVolume(mutedVolume); return; }
  const before = volume;
  setVolume(0);
  mutedVolume = before || 80;
  syncVolumeUI();
}

function syncVolumeUI() {
  document.getElementById('volume').value = volume;
  document.getElementById('volume-value').textContent = volume;
  document.getElementById('volume-icon').textContent = volume === 0 ? '🔇' : volume < 40 ? '🔉' : '🔊';
  document.getElementById('volume').style.setProperty('--fill', `${volume}%`);
}

// Fade out, pause and restore the volume for the next song
async function fadeOutAndPause(ms = 1500) {
  const token = ++fadeToken;
  const s = await getPlaybackState().catch(() => null);
  if (s && !s.paused && volume > 0) {
    const steps = usingBrowserPlayer() ? 15 : 5; // Connect devices: few steps (API calls)
    for (let i = steps - 1; i >= 0; i--) {
      if (token !== fadeToken) return; // new song started
      await applyVolume(volume * i / steps);
      await new Promise(r => setTimeout(r, ms / steps));
    }
  }
  if (token !== fadeToken) return;
  await pauseNow();
  applyVolume(volume);
}

function pauseNow() {
  if (usingBrowserPlayer()) return spotifyPlayer ? spotifyPlayer.pause().catch(() => {}) : Promise.resolve();
  if (!state.accessToken || (state.lobby && !isHost())) return Promise.resolve();
  return spotifyApi(`/me/player/pause?device_id=${selectedDeviceId}`, { method: 'PUT' }).catch(() => {});
}

// ════════════════════════════════════════════════════════════════
// PLAYBACK DEVICE (Spotify Connect)
// ════════════════════════════════════════════════════════════════
async function spotifyApi(path, opts = {}) {
  const doFetch = () => fetch(`https://api.spotify.com/v1${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.accessToken}` },
  });
  let res = await doFetch();
  if (res.status === 401 && await refreshAccessToken()) res = await doFetch();
  return res;
}

async function refreshAccessToken() {
  if (!state.refreshToken) return false;
  try {
    const r = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.refreshToken }),
    });
    const d = await r.json();
    if (!d.access_token) return false;
    state.accessToken = d.access_token;
    if (d.refresh_token) state.refreshToken = d.refresh_token;
    saveTokens();
    shareTokenWithLobby();
    return true;
  } catch(e) {
    return false;
  }
}

// The server uses the host token for title/artist suggestions
function shareTokenWithLobby() {
  if (state.lobby && isHost() && state.accessToken) {
    socket.emit('lobby:token', { code: state.lobby.code, token: state.accessToken });
  }
}

function usingBrowserPlayer() { return !selectedDeviceId; }
function activeDeviceId() { return selectedDeviceId || playerDeviceId; }

let devicesLoading = false;

async function loadDevices() {
  if (!state.accessToken || devicesLoading) return;
  devicesLoading = true;
  renderDeviceSelects();
  const minSpin = new Promise(r => setTimeout(r, 600)); // keep the spin animation visible
  try {
    const res = await spotifyApi('/me/player/devices');
    if (!res.ok) throw new Error();
    const data = await res.json();
    // Don't list our own browser player twice
    spotifyDevices = (data.devices || []).filter(d => d.id && d.id !== playerDeviceId);
  } catch(e) {
    showToast(L('t.devicesFailed'));
  }
  await minSpin;
  devicesLoading = false;
  if (selectedDeviceId && !spotifyDevices.some(d => d.id === selectedDeviceId)) {
    showToast(L('t.deviceGone'));
    selectedDeviceId = null;
    store.del('deviceId');
  }
  renderDeviceSelects();
}

const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const DEVICE_ICONS = {
  Browser: svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>'),
  Smartphone: svg('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
  Tablet: svg('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/>'),
  Computer: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>'),
  Speaker: svg('<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/>'),
  TV: svg('<rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/>'),
  Other: svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>'),
};
DEVICE_ICONS.CastAudio = DEVICE_ICONS.AVR = DEVICE_ICONS.Speaker;
DEVICE_ICONS.CastVideo = DEVICE_ICONS.TV;
const ICON_REFRESH = svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>');
const ICON_CHECK = svg('<path d="M20 6 9 17l-5-5"/>');
const ICON_CHEVRON = svg('<path d="m6 9 6 6 6-6"/>');

function deviceEntries() {
  return [{ id: '', name: L('device.browser'), icon: DEVICE_ICONS.Browser, sub: L(playerDeviceId ? 'device.browserSub' : 'device.connecting'), live: false }]
    .concat(spotifyDevices.map(d => ({
      id: d.id,
      name: d.name,
      icon: DEVICE_ICONS[d.type] || DEVICE_ICONS.Other,
      sub: d.type && I18N.de['device.' + d.type] ? L('device.' + d.type) : d.type || 'Spotify Connect',
      live: d.is_active,
    })));
}

function renderDeviceSelects() {
  const entries = deviceEntries();
  const current = selectedDeviceId || '';
  const html = entries.map(e => `
    <button class="device-option ${e.id === current ? 'selected' : ''}" data-id="${esc(e.id)}" onclick="selectDevice(this.dataset.id)">
      <span class="device-icon">${e.icon}</span>
      <span class="device-text">
        <div class="device-name">${esc(e.name)}</div>
        <div class="device-sub">${e.live ? '<span class="device-live"></span>' : ''}${esc(e.sub)}${e.live ? ' · ' + L('device.active') : ''}</div>
      </span>
      <span class="device-check">${ICON_CHECK}</span>
    </button>`).join('');
  document.querySelectorAll('.device-list').forEach(el => { el.innerHTML = html; });
  document.querySelectorAll('.device-refresh').forEach(btn => {
    btn.innerHTML = ICON_REFRESH;
    btn.classList.toggle('spinning', devicesLoading);
  });

  const active = entries.find(e => e.id === current) || entries[0];
  const chip = document.getElementById('device-chip');
  chip.innerHTML = `<span class="device-icon">${active.icon}</span>
    <span class="device-chip-label">${L('device.playOn')}</span>
    <span class="device-chip-name">${esc(active.name)}</span>
    <span class="chevron">${ICON_CHEVRON}</span>`;
}

function toggleDevicePopover(force) {
  const pop = document.getElementById('device-popover');
  const open = force ?? !pop.classList.contains('show');
  pop.classList.toggle('show', open);
  document.getElementById('device-chip').classList.toggle('open', open);
  if (open) loadDevices();
}

document.addEventListener('click', e => {
  if (!e.target.closest('#audio-device-picker')) toggleDevicePopover(false);
});

async function selectDevice(id) {
  const previous = activeDeviceId();
  selectedDeviceId = id || null;
  store.set('deviceId', selectedDeviceId);
  renderDeviceSelects();
  toggleDevicePopover(false);
  const target = activeDeviceId();
  // If a song is playing, move playback to the new device right away
  if (state.lobby?.status === 'playing' && state.lobby.currentTrack && target && target !== previous) {
    await spotifyApi('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [target], play: true }) });
  }
}

// ════════════════════════════════════════════════════════════════
// PLAYBACK
// ════════════════════════════════════════════════════════════════
// Returns {position, duration, paused} – via the SDK in the browser,
// via the Web API on external devices
async function getPlaybackState() {
  if (usingBrowserPlayer()) {
    if (!spotifyPlayer) return null;
    const s = await spotifyPlayer.getCurrentState();
    return s && { position: s.position, duration: s.duration, paused: s.paused };
  }
  const res = await spotifyApi('/me/player');
  if (res.status !== 200) return null;
  const s = await res.json();
  if (!s.item) return null;
  return { position: s.progress_ms, duration: s.item.duration_ms, paused: !s.is_playing };
}

function setupProgressPolling() {
  clearInterval(audioProgressInterval);
  audioProgressInterval = setInterval(async () => {
    const s = await getPlaybackState().catch(() => null);
    if (!s) return;
    const pct = s.duration ? (s.position / s.duration) * 100 : 0;
    document.getElementById('progress-fill').style.width = pct + '%';
    const rem = Math.max(0, s.duration - s.position) / 1000;
    document.getElementById('time-label').textContent = fmtTime(rem);
    document.getElementById('play-btn').textContent = s.paused ? '▶' : '⏸';
  }, usingBrowserPlayer() ? 300 : 1000);
}

async function togglePlay() {
  if (usingBrowserPlayer()) {
    if (spotifyPlayer) spotifyPlayer.togglePlay();
    return;
  }
  const s = await getPlaybackState().catch(() => null);
  const action = s && !s.paused ? 'pause' : 'play';
  await spotifyApi(`/me/player/${action}?device_id=${selectedDeviceId}`, { method: 'PUT' });
  document.getElementById('play-btn').textContent = action === 'pause' ? '▶' : '⏸';
}

// fade = fade out gently (on reveal/game end), otherwise stop immediately
function stopAudio(fade = false) {
  clearInterval(audioProgressInterval);
  document.getElementById('play-btn').textContent = '▶';
  if (!state.accessToken || (state.lobby && !isHost())) return;
  if (fade) fadeOutAndPause();
  else { fadeToken++; pauseNow(); }
}

async function seekAudio(e) {
  const bar = document.getElementById('progress-bar');
  const rect = bar.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const s = await getPlaybackState().catch(() => null);
  if (!s) return;
  const position = Math.round(ratio * s.duration);
  if (usingBrowserPlayer()) spotifyPlayer.seek(position);
  else spotifyApi(`/me/player/seek?position_ms=${position}&device_id=${selectedDeviceId}`, { method: 'PUT' });
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

// ════════════════════════════════════════════════════════════════
// ACTIONS
// ════════════════════════════════════════════════════════════════
function updateActionButtons() {
  if (!state.lobby) return;
  const myTurn = isMyTurn();
  const isGuess = state.lobby.gameMode !== 'classic';
  const placing = isGuess || state.lobby.turn?.phase === 'placing';
  const tokens = currentUnit()?.tokens || 0;
  const canConfirm = myTurn && placing && state.selectedSlotIndex !== null && (!isGuess || state.trackRevealed);

  document.getElementById('action-row').style.display = myTurn && placing ? '' : 'none';
  document.getElementById('btn-reveal').disabled = !myTurn || !placing;
  document.getElementById('btn-guess').disabled = !canConfirm;
  document.getElementById('token-guess').style.display = !isGuess && myTurn && placing ? 'block' : 'none';

  // Classic: skipping costs the active player 1 token, the host may skip for free
  const skip = document.getElementById('skip-button');
  skip.style.display = (myTurn || isHost()) && placing ? '' : 'none';
  skip.disabled = !isGuess && myTurn && tokens < 1;
  if (!isGuess) skip.textContent = L(myTurn ? 'game.skipToken' : 'game.skipSong');

  const buy = document.getElementById('buy-button');
  buy.style.display = !isGuess && myTurn && placing && state.lobby.sourceType === 'playlist' ? '' : 'none';
  buy.disabled = tokens < 3;
}

// Give up: reveals the song, no point
function revealTrack() {
  if (!state.lobby || !isMyTurn()) return;
  socket.emit('game:reveal', { code: state.lobby.code });
}

function showTrackInfo(t) {
  document.getElementById('track-hidden').style.display = 'none';
  document.getElementById('track-revealed').classList.add('show');
  document.getElementById('track-title').textContent = t.name;
  document.getElementById('track-artist').textContent = t.artists?.map(a => a.name).join(', ') || '–';
  const year = getTrackYear(t);
  document.getElementById('track-year-reveal').textContent = year || '????';
  document.getElementById('track-album').textContent = t.album?.name || '';
  const img = document.getElementById('track-art');
  const ph = document.getElementById('track-art-placeholder');
  const artUrl = t.album?.images?.[0]?.url;
  if (artUrl) { img.src = artUrl; img.style.display = 'block'; ph.style.display = 'none'; }
  else { img.style.display = 'none'; ph.style.display = 'flex'; }
}

function getTrackYear(track) {
  if (track.year) return String(track.year);
  const d = track.album?.release_date;
  return d ? d.split('-')[0] : null;
}

// ════════════════════════════════════════════════════════════════
// GUESS MODE
// ════════════════════════════════════════════════════════════════
function submitGuess() {
  if (!state.lobby || !isMyTurn()) return;
  const guessTitle = document.getElementById('guess-title').value.trim();
  if (!guessTitle) { showToast(L('t.enterTitle')); return; }
  const guessArtist = document.getElementById('guess-artist').value.trim();
  if (state.lobby.gameMode === 'guess-hard' && !guessArtist) {
    showToast(L('t.enterArtist')); return;
  }
  socket.emit('game:guess', { code: state.lobby.code, guessTitle, guessArtist });
}

// ════════════════════════════════════════════════════════════════
// TIMELINE
// ════════════════════════════════════════════════════════════════
function renderTimeline() {
  const tl = [...(currentUnit()?.timeline || [])].sort((a, b) => a.year - b.year);
  const el = document.getElementById('timeline');

  // Slots: before each card + after last card
  const slots = tl.length + 1;
  let html = '';

  const turn = state.lobby?.turn;
  const inChallenge = turn?.phase === 'challenge';
  const activeSlot = inChallenge ? turn.slotIndex : state.selectedSlotIndex;

  for (let i = 0; i < slots; i++) {
    // Drop zone
    const challenge = inChallenge && turn.challenges.find(c => c.slotIndex === i);
    const classes = [
      i === activeSlot && 'selected',
      challenge && 'challenged',
      inChallenge && state.challengeSlot === i && 'challenge-pick',
    ].filter(Boolean).join(' ');
    const label = challenge ? `📣 ${esc(un(challenge.name))}`
      : inChallenge && i === activeSlot ? `👉 ${esc(un(currentUnit()?.name))}`
      : inChallenge && state.challengeSlot === i ? `📣 ${L('game.you')}`
      : slotLabel(tl, i);
    html += `
      <div class="timeline-slot">
        <div class="timeline-drop ${classes}" data-slot="${i}" onclick="selectSlot(${i})">
          <span class="drop-plus">${challenge || (inChallenge && i === activeSlot) ? '' : '+'}</span>
          <span class="drop-label">${label}</span>
        </div>
      </div>
    `;
    // Card after (if exists)
    if (i < tl.length) {
      html += `
        <div class="timeline-slot">
          <div class="connector"></div>
          <div class="timeline-card${tl[i].id && tl[i].id === state.flashCardId ? ' pop' : ''}">
            <span class="tc-year">${tl[i].start ? '⭐ ' : ''}${tl[i].year}</span>
            <span class="tc-title">${esc(tl[i].name)}</span>
            <span class="tc-artist">${esc(tl[i].artist)}</span>
          </div>
          <div class="connector"></div>
        </div>
      `;
    }
  }

  el.innerHTML = html;
}

function slotLabel(tl, i) {
  if (!tl.length) return L('game.slotHere');
  if (i === 0) return L('slot.before', { y: tl[0].year });
  if (i === tl.length) return L('slot.after', { y: tl[tl.length-1].year });
  return `${tl[i-1].year}–${tl[i].year}`;
}

function selectSlot(i) {
  const turn = state.lobby?.turn;
  if (turn?.phase === 'challenge') {
    if (!canChallenge()) return;
    if (i === turn.slotIndex || turn.challenges.some(c => c.slotIndex === i)) {
      showToast(L('t.slotTaken')); return;
    }
    state.challengeSlot = i;
    renderTimeline();
    updateChallengeUI();
    return;
  }
  if (!isMyTurn() || (state.lobby.gameMode === 'classic' && turn?.phase !== 'placing')) return;
  state.selectedSlotIndex = i;
  renderTimeline();
  updateActionButtons();
  socket.emit('game:slot-select', { code: state.lobby.code, slotIndex: i });
  document.getElementById('game-hint').textContent = L('game.slotChosen', { slot: getSlotDescription(i) });
}

function getSlotDescription(i) {
  const tl = [...(currentUnit()?.timeline || [])].sort((a, b) => a.year - b.year);
  return slotLabel(tl, i);
}

function confirmGuess() {
  if (!state.lobby || !isMyTurn() || state.selectedSlotIndex === null) return;
  const guessTitle = document.getElementById('token-title').value.trim();
  const guessArtist = document.getElementById('token-artist').value.trim();
  const guessYear = document.getElementById('token-year').value.trim();
  const variant = state.lobby.variant || 'original';
  if (variant !== 'original' && (!guessTitle || !guessArtist)) { showToast(L('t.enterTitleArtist')); return; }
  if (variant === 'expert' && !guessYear) { showToast(L('t.enterYear')); return; }

  socket.emit('game:confirm', { code: state.lobby.code, slotIndex: state.selectedSlotIndex, guessTitle, guessArtist, guessYear });
}

// Text & fields of the title/artist box depending on the variant
function syncTokenGuess(variant) {
  document.getElementById('token-hint').innerHTML = L(`token.${['original', 'pro', 'expert'].includes(variant) ? variant : 'original'}`);
  document.getElementById('token-year-wrap').style.display = variant === 'expert' ? '' : 'none';
}

// ════════════════════════════════════════════════════════════════
// SUGGESTIONS WHILE TYPING (title / artist)
// ════════════════════════════════════════════════════════════════
function attachSuggest(inputId, field) {
  const input = document.getElementById(inputId);
  input.setAttribute('autocomplete', 'off');
  const wrap = input.parentElement;
  wrap.style.position = 'relative';
  const list = document.createElement('div');
  list.className = 'suggest-list';
  wrap.appendChild(list);

  let items = [], active = -1, timer, seq = 0;
  const close = () => { items = []; active = -1; list.style.display = 'none'; };
  const render = () => {
    list.innerHTML = items.map((n, i) =>
      `<div class="suggest-item${i === active ? ' active' : ''}" data-i="${i}">${esc(n)}</div>`).join('');
    list.style.display = items.length ? 'block' : 'none';
  };
  const pick = i => { input.value = items[i]; close(); };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2 || !state.lobby) { close(); return; }
    const mySeq = ++seq;
    timer = setTimeout(() => {
      socket.emit('game:suggest', { code: state.lobby.code, q, field }, names => {
        // Discard outdated responses
        if (mySeq !== seq || document.activeElement !== input) return;
        items = names.filter(n => n.toLowerCase() !== q.toLowerCase());
        active = -1;
        render();
      });
    }, 250);
  });
  // pointerdown instead of click so the field doesn't lose focus first
  list.addEventListener('pointerdown', e => {
    const el = e.target.closest('.suggest-item');
    if (!el) return;
    e.preventDefault();
    pick(+el.dataset.i);
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
  // Capture phase: runs before the field's Enter handler (submit answer)
  wrap.addEventListener('keydown', e => {
    if (e.target !== input || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopPropagation();
      pick(active);
    } else if (e.key === 'Escape') {
      close();
    }
  }, true);
}

window.addEventListener('DOMContentLoaded', () => {
  attachSuggest('token-title', 'title');
  attachSuggest('token-artist', 'artist');
  attachSuggest('guess-title', 'title');
  attachSuggest('guess-artist', 'artist');
});

// ════════════════════════════════════════════════════════════════
// SONGLINE! ROUND & TOKENS (classic)
// ════════════════════════════════════════════════════════════════
function canChallenge() {
  const turn = state.lobby?.turn;
  const self = myUnit();
  return turn?.phase === 'challenge' && !state.lobby.paused && !!self && !isMyTurn() && self.tokens > 0
    && !turn.passed.includes(self.id) && !turn.challenges.some(c => c.unitId === self.id);
}

function updateChallengeUI() {
  const turn = state.lobby?.turn;
  const panel = document.getElementById('challenge-panel');
  clearInterval(challengeCountdown);
  if (turn?.phase !== 'challenge') { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const cp = currentUnit();
  const self = myUnit();
  const mine = turn.challenges.find(c => c.unitId === self?.id);
  let text;
  if (isMyTurn()) text = L('ch.active');
  else if (canChallenge()) text = L(turn.slotIndex === null ? 'ch.noIdea' : 'ch.wrong', { name: un(cp.name) });
  else if (mine) text = state.lobby.teamMode ? L('ch.teamCalled', { name: mine.by }) : L('ch.called');
  else if (!self?.tokens) text = L('ch.noTokens');
  else text = L('ch.wait');
  document.getElementById('challenge-text').textContent = text;

  const canCall = canChallenge();
  document.getElementById('btn-songline').style.display = canCall ? '' : 'none';
  document.getElementById('btn-songline').disabled = state.challengeSlot === null;
  document.getElementById('btn-pass').style.display = canCall ? '' : 'none';
  document.getElementById('btn-resolve').style.display = isMyTurn() || isHost() ? '' : 'none';

  const tick = () => {
    const left = Math.max(0, Math.ceil((turn.deadline - Date.now()) / 1000));
    document.getElementById('challenge-countdown').textContent = turn.deadline ? `${left}s` : '';
  };
  tick();
  challengeCountdown = setInterval(tick, 500);
}

function callSongline() {
  if (!canChallenge() || state.challengeSlot === null) return;
  socket.emit('game:songline', { code: state.lobby.code, slotIndex: state.challengeSlot });
}

function passChallenge() {
  if (state.lobby) socket.emit('game:pass', { code: state.lobby.code });
}

function resolveNow() {
  if (state.lobby) socket.emit('game:resolve', { code: state.lobby.code });
}

function buyCard() {
  if (!state.lobby || !isMyTurn()) return;
  if (!confirm(L('t.confirmBuy'))) return;
  socket.emit('game:buy-card', { code: state.lobby.code });
}

function showVerdict(correct, gaveUp, track, currentPlayerName, stolenBy, tokenEarned, reason) {
  showTrackInfo(track);
  document.getElementById('verdict-overlay').classList.add('show');

  const name = track.name;
  const artist = track.artists?.map(a => a.name).join(', ') || '';
  const year = getTrackYear(track);
  const yearStr = year ? ` (${year})` : '';
  const gameMode = state.lobby?.gameMode || 'classic';
  const classic = gameMode === 'classic';
  const vp = { song: name, artist, year: yearStr, yearPlain: year || '?' };
  document.getElementById('verdict-pts-label').textContent =
    L(classic ? 'v.card' : 'v.point') + (tokenEarned ? L('v.tokenEarned') : '');

  if (stolenBy) {
    document.getElementById('verdict-icon').textContent = '📣';
    document.getElementById('verdict-title').textContent = 'SONGLINE!';
    document.getElementById('verdict-title').className = 'verdict-title correct';
    document.getElementById('verdict-sub').textContent = L('v.stolen', { stealer: un(stolenBy), ...vp });
    document.getElementById('verdict-pts').textContent = L('v.stolenPts', { name: un(stolenBy) });
  } else if (gaveUp) {
    document.getElementById('verdict-icon').textContent = '🏳️';
    document.getElementById('verdict-title').textContent = L('v.gaveUpTitle');
    document.getElementById('verdict-title').className = 'verdict-title wrong';
    document.getElementById('verdict-sub').textContent = L('v.gaveUp', { name: un(currentPlayerName), ...vp });
    document.getElementById('verdict-pts').textContent = '±0';
  } else if (correct) {
    document.getElementById('verdict-icon').textContent = '🎉';
    document.getElementById('verdict-title').textContent = L('v.correctTitle');
    document.getElementById('verdict-title').className = 'verdict-title correct';
    document.getElementById('verdict-sub').textContent = L(gameMode === 'classic' ? 'v.correctClassic' : 'v.correctGuess', vp);
    document.getElementById('verdict-pts').textContent = '+1';
  } else if (reason) {
    document.getElementById('verdict-icon').textContent = '😬';
    document.getElementById('verdict-title').textContent = L('v.almostTitle');
    document.getElementById('verdict-title').className = 'verdict-title wrong';
    document.getElementById('verdict-sub').textContent = L(reason === 'year' ? 'v.almostYear' : 'v.almostNames', vp);
    document.getElementById('verdict-pts').textContent = '±0';
  } else {
    document.getElementById('verdict-icon').textContent = '💔';
    document.getElementById('verdict-title').textContent = L('v.wrongTitle');
    document.getElementById('verdict-title').className = 'verdict-title wrong';
    document.getElementById('verdict-sub').textContent = L(gameMode === 'classic' ? 'v.wrongClassic' : 'v.wrongGuess', vp);
    document.getElementById('verdict-pts').textContent = '±0';
  }
}

function hideVerdict() {
  document.getElementById('verdict-overlay').classList.remove('show');
}

function closeVerdict() {
  hideVerdict();
  if (state.lobby) socket.emit('game:next', { code: state.lobby.code });
}

function skipTrack() {
  stopAudio();
  if (state.lobby) socket.emit('game:skip', { code: state.lobby.code });
}

// ════════════════════════════════════════════════════════════════
// SCORES
// ════════════════════════════════════════════════════════════════
function scoreCard(u, { leader, mine, current, classic }) {
  const away = !u.memberIds.length;
  const style = [u.connected && !away ? '' : 'opacity:0.45', u.color ? `--team:${u.color}` : ''].filter(Boolean).join(';');
  return `
    <div class="score-card ${leader ? 'leader' : ''} ${current ? 'current' : ''} ${u.color ? 'team' : ''}" style="${style}">
      <div class="score-avatar">${esc(un(u.name).replace(/^Team /, '')[0].toUpperCase())}</div>
      <div class="score-name">${esc(un(u.name))}${mine ? ' ★' : ''}${away ? ' ⏸' : u.connected ? '' : ' 💤'}</div>
      ${u.color ? `<div class="score-members">${esc(u.memberNames.join(', '))}</div>` : ''}
      <div class="score-pts">${u.score}</div>
      ${classic ? `<div class="score-timeline-count">${L(u.timeline.length === 1 ? 'game.card' : 'game.cards', { n: u.timeline.length })} · ${u.tokens || 0} 🪙</div>` : ''}
    </div>`;
}

function renderScores(lobby = state.lobby) {
  const units = playingUnits(lobby);
  const maxScore = Math.max(0, ...units.map(u => u.score));
  const mine = myUnit();
  document.getElementById('scores-grid').innerHTML = units.map(u => scoreCard(u, {
    leader: u.score === maxScore && maxScore > 0,
    mine: u.id === mine?.id,
    current: u.id === lobby.currentUnitId,
    classic: lobby.gameMode === 'classic',
  })).join('');
}

// ════════════════════════════════════════════════════════════════
// END SCREEN
// ════════════════════════════════════════════════════════════════
function showEndScreen(winner, lobby) {
  state.lastWinner = winner;
  showScreen('end');
  document.getElementById('btn-rematch').style.display = isHost() ? 'block' : 'none';
  document.getElementById('rematch-hint').style.display = isHost() ? 'none' : 'block';
  const classic = lobby?.gameMode === 'classic';
  const one = winner.score === 1;
  const unitWord = L(classic ? (one ? 'end.unitCard' : 'end.unitCards') : (one ? 'end.unitPoint' : 'end.unitPoints'));
  document.getElementById('winner-name').textContent = un(winner.name);
  document.getElementById('winner-sub').textContent = lobby?.teamMode
    ? L('end.teamWon', { members: winner.members.join(', '), score: winner.score, unit: unitWord })
    : L('end.wonWith', { score: winner.score, unit: unitWord });
  const units = playingUnits(lobby);
  const maxScore = Math.max(0, ...units.map(u => u.score));
  document.getElementById('end-scores-grid').innerHTML = [...units]
    .sort((a, b) => b.score - a.score)
    .map(u => scoreCard(u, { leader: u.score === maxScore, classic }))
    .join('');
}

function resetGame() {
  stopAudio();
  document.getElementById('timeline-section').style.display = 'block';
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('btn-guess').style.display = 'block';
  document.getElementById('btn-reveal').textContent = L('game.noIdea');
  if (state.lobby && isHost()) {
    socket.emit('lobby:back', { code: state.lobby.code });
  } else if (state.lobby) {
    showLobbyScreen(state.lobby);
  } else {
    showScreen('menu');
  }
}

// ════════════════════════════════════════════════════════════════
// SEARCH MODAL
// ════════════════════════════════════════════════════════════════
function openSearchModal() {
  document.getElementById('search-modal').classList.add('show');
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  setTimeout(() => document.getElementById('search-input').focus(), 100);
}

function closeSearchModal() {
  document.getElementById('search-modal').classList.remove('show');
}

async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  document.getElementById('search-results').innerHTML = `<p class="text-muted" style="padding:12px;text-align:center">${L('search.searching')}</p>`;
  try {
    const res = await apiFetch(`/api/search?q=${encodeURIComponent(q)}&token=${state.accessToken}`);
    const data = await res.json();
    const tracks = data.tracks?.items || [];
    renderSearchResults(tracks);
  } catch(e) {
    document.getElementById('search-results').innerHTML = `<p class="text-muted" style="padding:12px;text-align:center">${L('search.failed')}</p>`;
  }
}

function renderSearchResults(tracks) {
  const el = document.getElementById('search-results');
  if (!tracks.length) {
    el.innerHTML = `<p class="text-muted" style="padding:12px;text-align:center">${L('search.none')}</p>`;
    return;
  }
  el.innerHTML = tracks.map(t => {
    const year = t.album?.release_date?.split('-')[0] || '?';
    const art = t.album?.images?.[2]?.url || '';
    return `
      <div class="search-result-item" onclick="selectSearchTrack(${JSON.stringify(t).replace(/"/g,'&quot;')})">
        ${art ? `<img class="search-thumb" src="${art}" alt="">` : '<div style="width:40px;height:40px;border-radius:4px;background:var(--surface);display:flex;align-items:center;justify-content:center">🎵</div>'}
        <div class="search-info">
          <div class="search-track">${t.name}</div>
          <div class="search-artist">${t.artists?.map(a=>a.name).join(', ')}</div>
        </div>
        <div class="search-year">${year}</div>
      </div>
    `;
  }).join('');
}

function selectSearchTrack(track) {
  closeSearchModal();
  if (state.lobby) socket.emit('game:track-selected', { code: state.lobby.code, track });
}

// ════════════════════════════════════════════════════════════════
// API HELPER
// ════════════════════════════════════════════════════════════════
async function apiFetch(url, opts = {}) {
  let res = await fetch(url, opts);
  if (res.status === 401 && await refreshAccessToken()) {
    res = await fetch(url.replace(/token=[^&]+/, `token=${state.accessToken}`), opts);
  }
  return res;
}

// ════════════════════════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════════════════════════
let toastTimeout;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  // Longer messages (e.g. explanations) stay a bit longer
  toastTimeout = setTimeout(() => t.classList.remove('show'), Math.max(3000, String(msg).length * 70));
}

// ════════════════════════════════════════════════════════════════
// LANGUAGE SWITCH
// ════════════════════════════════════════════════════════════════
// Updates labels of the current game screen without resetting selection or reveal state
function refreshGameTexts() {
  const lobby = state.lobby;
  const cp = currentUnit();
  if (!lobby || !cp) return;
  const myTurn = isMyTurn();
  applyModeUI(lobby.gameMode);
  const who = lobby.teamMode ? `${un(cp.name)} (${cp.memberNames.join(', ')})` : cp.name;
  document.getElementById('current-player-display').textContent = un(cp.name);
  document.getElementById('round-display').textContent = L('game.round', { round: lobby.round });
  document.getElementById('waiting-text').textContent = L('game.waitingFor', { name: who });
  document.getElementById('timeline-label').textContent = myTurn
    ? L(lobby.teamMode ? 'game.ourTimeline' : 'game.myTimeline')
    : L('game.timelineOf', { name: un(cp.name) });
  syncTokenGuess(lobby.variant);
  renderScores(lobby);
  if (lobby.gameMode === 'classic') renderTimeline();
  updateActionButtons();
  updateChallengeUI();
}

onLangChange(() => {
  syncMenu();
  renderDeviceSelects();
  if (!state.lobby || state.tv) return;
  const active = id => document.getElementById('screen-' + id).classList.contains('active');
  if (active('lobby')) refreshLobby(state.lobby);
  if (active('game')) refreshGameTexts();
  if (active('end') && state.lastWinner) showEndScreen(state.lastWinner, state.lobby);
});
