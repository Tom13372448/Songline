const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const {
  cleanTitle, trackYear, timelineCard, slotFits, earliestYear, judgePlacement, titleMatches, artistMatches,
} = require('./game-logic');
const persistence = require('./persistence');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3001/api/callback';

// ─── Preset play packs ────────────────────────────────────────────────────
// Fixed, curated playlists shown as cover cards in the lobby.
// playlistId = Spotify playlist ID (from the share link,
// e.g. https://open.spotify.com/playlist/<ID>). Adjust this list to your own
// playlists – name/cover/track count are fetched live from Spotify.
const PRESET_PACKS = [
  { id: 'hitster-classic', name: 'Classic', playlistId: '26zIHVncgI9HmHlgYWwnDi' },
  { id: 'hitster-summer_party', name: 'Summer Party', playlistId: '15hZ0ez6sHYhTeCCshxJTN' },
  { id: 'hitster-guilty_pleasures', name: 'Guilty Pleasures', playlistId: '2u0vgWYqU1TWVcDehJnZuN' },
  { id: 'hitster-schlager_party', name: 'Schlager Party', playlistId: '0USUpphpG4nAuz9IUudfl9' },
  { id: 'hitster-rock', name: 'Rock', playlistId: '4oYTRg0JI48jucsJOLily1' },
  { id: 'hitster-celebrations', name: 'Celebration', playlistId: '3QWNtOG8LrhClKhHqFRBHS' },
  { id: 'hitster-movie_&_tv_soundtracks', name: 'Movie & TV Soundtracks', playlistId: '2jlbmBYM1RLZrsyY67wuDQ' },
  { id: 'hitster-urban_&_hip-hop', name: 'Urban & Hip-Hop', playlistId: '5NDdlam4SRu2MOiv3xkXVK' },
  { id: 'hitster-bayern_1', name: 'Bayern 1', playlistId: '2zWVMuxHcoLgThgaBhDzmK' },
  { id: 'hitster-christmas', name: 'Christmas', playlistId: '7rBNYFYokNHxPRKaMD4jPp' },
  { id: 'hitster-bingo', name: 'Bingo', playlistId: '58y9xPPIRWd8tqlOaKoDOI' },
  { id: 'hitster-platinum', name: 'Platinum', playlistId: '6a0Z098RE1Bwrii6cuLDAE' },
  { id: 'hitster-botg_vor_1985', name: 'Battle of the Generations (vor 1985)', playlistId: '4d82lE9AYWwkMVjpjekmtM' },
  { id: 'hitster-botg_1985-2004', name: 'Battle of the Generations (1985-2004)', playlistId: '0Y6WOBfFl7RmRLdcdG996p' },
  { id: 'hitster-botg_2005-2025', name: 'Battle of the Generations (2005-2025)', playlistId: '66dl3xRm8t32zReWvxHIGp' },
  ];

// ─── Lobby Store ─────────────────────────────────────────────────────────────

const lobbies = new Map();
const tvCodes = new Map(); // TV code → socket of a TV waiting to be paired

// How long a player may be gone (screen off, page reload, flaky Wi-Fi) before being
// removed from the lobby. During a game we wait longer for the host.
const RECONNECT_GRACE_MS = 2 * 60 * 1000;
const HOST_GRACE_MS = 10 * 60 * 1000;

// Classic mode following the original rules
const START_TOKENS = 2;
const MAX_TOKENS = 5;
const BUY_CARD_COST = 3;
const CHALLENGE_MS = 20 * 1000; // time for the others to call "SONGLINE!"
const MAX_PLAYLIST_TRACKS = 1000;

const TEAMS = [
  { id: 'team-0', name: 'Team Lila', color: '#a855f7' },
  { id: 'team-1', name: 'Team Pink', color: '#ec4899' },
  { id: 'team-2', name: 'Team Blau', color: '#3b82f6' },
  { id: 'team-3', name: 'Team Grün', color: '#22c55e' },
];

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (lobbies.has(code));
  return code;
}

// ─── Units: players or teams ────────────────────────────────────────────────
// Without team mode every player is a unit, with team mode every team is.
// Timeline, tokens and score always belong to the unit.

function unitList(lobby) { return lobby.teamMode ? lobby.teams : lobby.players; }
function teamMembers(lobby, team) { return lobby.players.filter(p => p.team === team.id); }
function unitMembers(lobby, unit) { return lobby.teamMode ? teamMembers(lobby, unit) : [unit]; }
function unitOf(lobby, player) { return lobby.teamMode ? lobby.teams.find(t => t.id === player.team) : player; }
// Players who are not sitting out ("leave round" → back to the lobby)
function activeMembers(lobby, unit) { return unitMembers(lobby, unit).filter(p => !p.away); }
function unitPlayable(lobby, unit) { return activeMembers(lobby, unit).length > 0; }
function currentUnit(lobby) { return unitList(lobby)[lobby.currentIndex]; }
function unitConnected(lobby, unit) { return activeMembers(lobby, unit).some(p => p.connected !== false); }

function playerBySocket(lobby, socketId) { return lobby?.players.find(p => p.id === socketId); }

// May this socket act for the unit whose turn it is?
function actsForCurrent(lobby, socketId) {
  const player = playerBySocket(lobby, socketId);
  return !!player && !player.away && unitOf(lobby, player) === currentUnit(lobby);
}

function resetUnit(unit, tokens = 0) {
  unit.score = 0;
  unit.timeline = [];
  unit.tokens = tokens;
}

// Smallest team first – new players are spread evenly
function assignTeam(lobby, player) {
  const teams = lobby.teams.slice(0, lobby.teamCount);
  player.team = teams.reduce((a, b) => teamMembers(lobby, b).length < teamMembers(lobby, a).length ? b : a).id;
}

function setupTeams(lobby) {
  lobby.teams = TEAMS.slice(0, lobby.teamCount).map(t => ({ ...t, score: 0, timeline: [], tokens: 0 }));
  lobby.players.forEach(p => { p.team = null; });
  lobby.players.forEach(p => assignTeam(lobby, p));
}

function advanceTurn(lobby) {
  const list = unitList(lobby);
  if (!list.length) return;
  for (let k = 0; k < list.length; k++) {
    lobby.currentIndex = (lobby.currentIndex + 1) % list.length;
    if (lobby.currentIndex === 0) lobby.round++;
    if (unitPlayable(lobby, list[lobby.currentIndex])) return;
  }
}

// ─── Client view ────────────────────────────────────────────────────────────

function unitView(lobby, unit) {
  const members = activeMembers(lobby, unit);
  return {
    id: unit.id,
    name: unit.name,
    color: unit.color || null,
    score: unit.score || 0,
    timeline: unit.timeline || [],
    tokens: unit.tokens || 0,
    memberIds: members.map(p => p.id),
    memberNames: members.map(p => p.name),
    awayNames: unitMembers(lobby, unit).filter(p => p.away).map(p => p.name),
    connected: members.some(p => p.connected !== false),
  };
}

function lobbyView(lobby) {
  const t = lobby.turn;
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    gameMode: lobby.gameMode,
    variant: lobby.variant,
    teamMode: lobby.teamMode,
    teamCount: lobby.teamCount,
    sourceType: lobby.sourceType,
    sourceTab: lobby.sourceTab || 'search',
    presetId: lobby.presetId || null,
    playlistId: lobby.playlistId || null,
    playlistCover: lobby.playlistCover || null,
    playlistName: lobby.playlistName || null,
    winCards: lobby.winCards,
    players: lobby.players.map(p => ({ id: p.id, name: p.name, team: p.team || null, connected: p.connected !== false, away: !!p.away })),
    units: unitList(lobby).map(u => unitView(lobby, u)),
    currentUnitId: lobby.status === 'playing' ? currentUnit(lobby)?.id || null : null,
    status: lobby.status,
    paused: !!lobby.paused,
    round: lobby.round,
    currentTrack: lobby.currentTrack,
    turn: t && {
      phase: t.phase,
      slotIndex: t.slotIndex,
      deadline: lobby.paused ? null : t.deadline || null,
      challenges: t.challenges.map(c => ({ unitId: c.unit.id, name: c.unit.name, by: c.by.name, slotIndex: c.slotIndex })),
      passed: [...t.passed].map(u => u.id),
    },
  };
}

// Messages for players are sent as { key, params } and translated on each client (see frontend/public/i18n.js)
function broadcast(lobby, event, payload = {}) {
  io.to(lobby.code).emit(event, { ...payload, lobby: lobbyView(lobby) });
  persistence.schedule(lobbies);
}

function emitUpdate(lobby) {
  io.to(lobby.code).emit('lobby:updated', lobbyView(lobby));
  persistence.schedule(lobbies);
}

// ─── Songs & years ───────────────────────────────────────────────────────────

// Load all pages of a playlist (Spotify returns at most 100 per request)
async function fetchPlaylistTracks(playlistId, token) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;
  let params = { limit: 100, fields: 'items(track(id,name,artists(id,name),album(name,release_date,images))),next' };
  while (url && tracks.length < MAX_PLAYLIST_TRACKS) {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, params });
    tracks.push(...res.data.items.map(i => i.track).filter(t => t && t.id));
    url = res.data.next;
    params = undefined; // "next" already contains the parameters
  }
  return tracks;
}

const yearCache = new Map();

// Replaces the album year with the earliest release of the same song (remaster/best-of problem)
async function resolveYear(lobby, track) {
  if (!track || track.year) return track;
  if (yearCache.has(track.id)) { track.year = yearCache.get(track.id); return track; }
  try {
    const artist = track.artists?.[0]?.name || '';
    const r = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${lobby.token}` },
      params: { q: `track:${cleanTitle(track.name)} artist:${artist}`, type: 'track', limit: 10 },
      timeout: 4000,
    });
    track.year = earliestYear(track, r.data.tracks?.items);
  } catch (e) {
    if (e.response?.status === 401) io.to(lobby.hostId).emit('spotify:refresh-needed');
    track.year = trackYear(track);
  }
  if (track.year) yearCache.set(track.id, track.year);
  return track;
}

function takeRandomTrack(lobby) {
  const pool = lobby.playlistTracks.filter(t => !lobby.usedTrackIds.has(t.id) && trackYear(t));
  if (!pool.length) return null;
  const track = pool[Math.floor(Math.random() * pool.length)];
  lobby.usedTrackIds.add(track.id);
  return track;
}

async function drawCard(lobby) {
  const track = takeRandomTrack(lobby);
  return track && resolveYear(lobby, track);
}

// Classic: score = number of cards in the timeline (incl. start card)
function addCard(unit, track, extra) {
  unit.timeline.push(timelineCard(track, extra));
  unit.score = unit.timeline.length;
}

async function giveStartCard(lobby, unit) {
  const track = await drawCard(lobby);
  if (track) addCard(unit, track, { start: true });
}

// ─── Game flow ──────────────────────────────────────────────────────────────

function newTurn(lobby) {
  clearTimeout(lobby.turn?.timer);
  lobby.verdictPending = false;
  lobby.turn = { phase: 'placing', slotIndex: null, challenges: [], passed: new Set(), tokenEarned: false };
}

async function loadNextTrack(lobby) {
  newTurn(lobby);
  const seq = lobby.trackSeq = (lobby.trackSeq || 0) + 1;
  if (lobby.sourceType === 'playlist' && lobby.playlistTracks.length) {
    const track = takeRandomTrack(lobby);
    if (!track) {
      io.to(lobby.code).emit('game:error', { key: 'err.allPlayed' });
      return;
    }
    await resolveYear(lobby, track);
    if (seq !== lobby.trackSeq || lobby.status !== 'playing') return; // skipped/ended in the meantime
    lobby.currentTrack = track;
    broadcast(lobby, 'game:track', { track });
  } else {
    // host picks via search
    broadcast(lobby, 'game:needs-track');
  }
}

function emitVerdict(lobby, payload) {
  lobby.verdictPending = true;
  broadcast(lobby, 'game:verdict', payload);
}

function checkWinner(lobby) {
  const winner = unitList(lobby).find(u => u.score >= lobby.winCards);
  if (!winner) return false;
  clearTimeout(lobby.turn?.timer);
  lobby.status = 'waiting';
  broadcast(lobby, 'game:ended', { winner: { id: winner.id, name: winner.name, score: winner.score, members: unitMembers(lobby, winner).map(p => p.name) } });
  return true;
}

// Units that can still call "SONGLINE!"
function openChallengers(lobby) {
  const cur = currentUnit(lobby);
  const t = lobby.turn;
  return unitList(lobby).filter(u => u !== cur && unitConnected(lobby, u) && u.tokens > 0
    && !t.passed.has(u) && !t.challenges.some(c => c.unit === u));
}

function armChallengeTimer(lobby, ms) {
  const t = lobby.turn;
  clearTimeout(t.timer);
  t.deadline = Date.now() + ms;
  t.timer = setTimeout(() => resolveTurn(lobby), ms);
}

function startChallengePhase(lobby) {
  if (!openChallengers(lobby).length) return resolveTurn(lobby);
  lobby.turn.phase = 'challenge';
  armChallengeTimer(lobby, CHALLENGE_MS);
  broadcast(lobby, 'game:challenge');
}

function maybeFinishChallenge(lobby) {
  if (lobby.turn?.phase === 'challenge' && !lobby.paused && !openChallengers(lobby).length) resolveTurn(lobby);
}

// Reveal the card: correct → active unit gets it, otherwise a unit with a correct "SONGLINE!"
function resolveTurn(lobby) {
  const t = lobby.turn;
  if (!t || t.phase === 'resolved') return;
  clearTimeout(t.timer);
  t.phase = 'resolved';
  const cur = currentUnit(lobby);
  const track = lobby.currentTrack;
  const year = trackYear(track);
  const timeline = [...cur.timeline];
  const correct = t.judgement ? t.judgement.correct : false;
  let stealer = null;
  if (correct) {
    addCard(cur, track);
  } else {
    const hit = t.challenges.find(c => unitList(lobby).includes(c.unit) && slotFits(timeline, c.slotIndex, year));
    if (hit) { stealer = hit.unit; addCard(stealer, track); }
  }
  emitVerdict(lobby, {
    correct, gaveUp: t.slotIndex === null, track,
    currentPlayerName: cur.name,
    stolenBy: stealer?.name || null,
    tokenEarned: t.tokenEarned,
    reason: t.judgement?.reason || null,
  });
}

// ─── Pause while the host is gone during a game ──────────────────────────────

function pauseGame(lobby) {
  if (lobby.paused || lobby.status !== 'playing') return;
  lobby.paused = true;
  const t = lobby.turn;
  if (t?.phase === 'challenge') {
    clearTimeout(t.timer);
    t.remaining = Math.max(3000, (t.deadline || Date.now()) - Date.now());
  }
  broadcast(lobby, 'game:paused', { paused: true });
}

function resumeGame(lobby) {
  if (!lobby.paused) return;
  lobby.paused = false;
  const t = lobby.turn;
  if (t?.phase === 'challenge') armChallengeTimer(lobby, t.remaining || CHALLENGE_MS);
  broadcast(lobby, 'game:paused', { paused: false });
}

// Running game that currently accepts actions
function activeLobby(code) {
  const lobby = lobbies.get(code);
  return lobby && lobby.status === 'playing' && !lobby.paused ? lobby : null;
}

function backToLobby(lobby) {
  lobby.status = 'waiting';
  lobby.paused = false;
  clearTimeout(lobby.turn?.timer);
  lobby.turn = null;
  lobby.currentTrack = null;
  unitList(lobby).forEach(u => resetUnit(u));
  lobby.players.forEach(p => { p.away = false; });
}

function removePlayer(lobby, player) {
  const idx = lobby.players.indexOf(player);
  if (idx === -1) return;
  const wasHost = lobby.hostId === player.id;
  const unit = unitOf(lobby, player);
  const wasCurrent = lobby.status === 'playing' && unit === currentUnit(lobby);
  clearTimeout(player.removeTimer);
  lobby.players.splice(idx, 1);
  if (lobby.players.length === 0) { clearTimeout(lobby.turn?.timer); lobbies.delete(lobby.code); persistence.schedule(lobbies); return; }
  if (wasHost) {
    lobby.hostId = (lobby.players.find(p => p.connected !== false) || lobby.players[0]).id;
  }
  // Without teams the unit disappears with the player – adjust the index
  if (!lobby.teamMode && lobby.turn) {
    lobby.turn.passed.delete(player);
    lobby.turn.challenges = lobby.turn.challenges.filter(c => c.unit !== player);
  }
  if (!lobby.teamMode) {
    if (idx < lobby.currentIndex) lobby.currentIndex--;
    if (lobby.currentIndex >= lobby.players.length) lobby.currentIndex = 0;
  }
  emitUpdate(lobby);
  io.to(lobby.code).emit('player:left', { playerName: player.name });

  if (lobby.status !== 'playing') return;
  if (wasHost) {
    // Without the host there is no music – back to the lobby
    backToLobby(lobby);
    emitUpdate(lobby);
    io.to(lobby.code).emit('game:back-to-lobby');
    io.to(lobby.code).emit('game:error', { key: 'err.hostLeft' });
  } else if (wasCurrent && (!lobby.teamMode || !unitPlayable(lobby, unit))) {
    // Unit is empty – the next one gets a new song
    if (lobby.teamMode) advanceTurn(lobby);
    else if (lobby.currentIndex === 0) lobby.round++;
    loadNextTrack(lobby);
  } else {
    maybeFinishChallenge(lobby);
  }
}

function scheduleRemoval(lobby, player) {
  clearTimeout(player.removeTimer);
  const isHost = lobby.hostId === player.id;
  const ms = isHost && lobby.status === 'playing' ? HOST_GRACE_MS : RECONNECT_GRACE_MS;
  player.removeTimer = setTimeout(() => removePlayer(lobby, player), ms);
}

// New player (also mid-game)
async function addPlayer(lobby, socket, playerName, playerKey) {
  const player = { id: socket.id, key: playerKey, name: playerName, connected: true };
  resetUnit(player);
  lobby.players.push(player);
  if (lobby.teamMode) assignTeam(lobby, player);
  if (lobby.status === 'playing' && !lobby.teamMode && lobby.gameMode === 'classic') {
    player.tokens = START_TOKENS;
    if (lobby.sourceType === 'playlist') await giveStartCard(lobby, player);
  }
  return player;
}

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('lobby:create', ({ playerName, playerKey }) => {
    const code = generateCode();
    const lobby = {
      code,
      hostId: socket.id,
      gameMode: 'classic',
      variant: 'original',
      teamMode: false,
      teamCount: 2,
      teams: [],
      sourceType: 'search',
      sourceTab: 'preset',
      presetId: null,
      playlistId: null,
      playlistCover: null,
      playlistName: null,
      winCards: 10,
      players: [],
      status: 'waiting',
      currentIndex: 0,
      round: 1,
      currentTrack: null,
      usedTrackIds: new Set(),
      playlistTracks: [],
      turn: null,
      verdictPending: false,
      paused: false,
    };
    const player = { id: socket.id, key: playerKey, name: playerName, connected: true };
    resetUnit(player);
    lobby.players.push(player);
    lobbies.set(code, lobby);
    socket.join(code);
    socket.emit('lobby:created', { code, lobby: lobbyView(lobby) });
    persistence.schedule(lobbies);
  });

  socket.on('lobby:join', async ({ code, playerName, playerKey }) => {
    const upper = String(code || '').toUpperCase();
    const lobby = lobbies.get(upper);
    const name = String(playerName || '').trim().slice(0, 20);
    if (!lobby) { socket.emit('lobby:error', { key: 'err.lobbyNotFound' }); return; }
    if (!name) { socket.emit('lobby:error', { key: 'err.nameRequired' }); return; }
    if (lobby.players.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      socket.emit('lobby:error', { key: 'err.nameTaken' }); return;
    }
    await addPlayer(lobby, socket, name, playerKey);
    socket.join(upper);
    socket.emit('lobby:joined', { code: upper, lobby: lobbyView(lobby) });
    emitUpdate(lobby);
    if (lobby.status === 'playing') io.to(upper).emit('game:info', { key: 'info.joined', params: { name } });
  });

  // Reconnect after reload/connection loss/server restart: player keeps everything
  socket.on('lobby:rejoin', ({ code, playerKey }) => {
    const lobby = lobbies.get(code);
    const player = playerKey && lobby?.players.find(p => p.key === playerKey);
    if (!player) { socket.emit('lobby:rejoin-failed'); return; }
    clearTimeout(player.removeTimer);
    const oldId = player.id;
    player.id = socket.id;
    player.connected = true;
    const isHost = lobby.hostId === oldId;
    if (isHost) lobby.hostId = socket.id;
    socket.join(code);
    socket.emit('lobby:rejoined', { lobby: lobbyView(lobby) });
    emitUpdate(lobby);
    if (isHost) resumeGame(lobby);
  });

  // TV opens /tv and gets a code (like "Link with TV code" on YouTube)
  socket.on('tv:register', () => {
    let code;
    do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (tvCodes.has(code));
    tvCodes.set(code, socket.id);
    socket.data.tvCode = code;
    socket.emit('tv:code', { code });
  });

  // Player enters the TV code → TV shows this lobby's TV view
  socket.on('lobby:link-tv', ({ code, tvCode }, reply) => {
    const lobby = lobbies.get(code);
    const tvSocket = tvCodes.get(String(tvCode || '').trim());
    const ok = !!(lobby && playerBySocket(lobby, socket.id) && tvSocket);
    if (ok) {
      tvCodes.delete(String(tvCode).trim());
      io.to(tvSocket).emit('tv:linked', { code: lobby.code });
    }
    if (typeof reply === 'function') reply({ ok });
  });

  // TV/projector view: watches without playing
  socket.on('lobby:watch', ({ code }) => {
    const lobby = lobbies.get(String(code || '').toUpperCase());
    if (!lobby) { socket.emit('lobby:error', { key: 'err.lobbyNotFound' }); return; }
    socket.join(lobby.code);
    socket.emit('tv:state', { lobby: lobbyView(lobby) });
  });

  // "Leave round": player goes to the lobby, keeps score & timeline and can rejoin
  socket.on('game:sit-out', ({ code }) => {
    const lobby = lobbies.get(code);
    const player = playerBySocket(lobby, socket.id);
    if (!player || lobby.status !== 'playing' || player.away) return;
    const unit = unitOf(lobby, player);
    const wasCurrent = unit === currentUnit(lobby);
    player.away = true;
    emitUpdate(lobby);
    io.to(code).emit('game:info', { key: 'info.away', params: { name: player.name } });
    if (lobby.paused) return;
    if (wasCurrent && !unitPlayable(lobby, unit)) {
      advanceTurn(lobby);
      if (unitPlayable(lobby, currentUnit(lobby))) loadNextTrack(lobby);
    } else {
      maybeFinishChallenge(lobby);
    }
  });

  socket.on('game:sit-in', ({ code }, reply) => {
    const lobby = lobbies.get(code);
    const player = playerBySocket(lobby, socket.id);
    if (!player || lobby.status !== 'playing') return typeof reply === 'function' && reply({ ok: false });
    const nobodyPlaying = !unitList(lobby).some(u => unitPlayable(lobby, u));
    player.away = false;
    emitUpdate(lobby);
    io.to(code).emit('game:info', { key: 'info.back', params: { name: player.name } });
    if (typeof reply === 'function') reply({ ok: true, lobby: lobbyView(lobby) });
    // Everyone was sitting out → continue with the returning player
    if (nobodyPlaying && !lobby.paused) {
      lobby.currentIndex = unitList(lobby).indexOf(unitOf(lobby, player));
      loadNextTrack(lobby);
    }
  });

  // Host closes the lobby for everyone (also during a round)
  socket.on('lobby:close', ({ code }) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.hostId !== socket.id) return;
    clearTimeout(lobby.turn?.timer);
    lobby.players.forEach(p => clearTimeout(p.removeTimer));
    lobbies.delete(code);
    io.to(code).emit('lobby:closed', { code });
    io.in(code).socketsLeave(code);
    persistence.schedule(lobbies);
  });

  socket.on('lobby:leave', ({ code }) => {
    const lobby = lobbies.get(code);
    const player = playerBySocket(lobby, socket.id);
    if (!player) return;
    socket.leave(code);
    removePlayer(lobby, player);
  });

  socket.on('lobby:settings', ({ code, gameMode, variant, teamMode, teamCount, sourceType, sourceTab, playlistId, playlistCover, playlistName, presetId, winCards }) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.hostId !== socket.id || lobby.status !== 'waiting') return;
    lobby.gameMode = gameMode;
    lobby.variant = ['original', 'pro', 'expert'].includes(variant) ? variant : 'original';
    lobby.sourceType = sourceType;
    lobby.sourceTab = sourceTab || 'search';
    lobby.playlistId = playlistId || null;
    lobby.playlistCover = playlistCover || null;
    lobby.playlistName = playlistName || null;
    lobby.presetId = presetId || null;
    lobby.winCards = parseInt(winCards) || 10;
    const count = Math.min(4, Math.max(2, parseInt(teamCount) || 2));
    if (!!teamMode !== lobby.teamMode || count !== lobby.teamCount) {
      lobby.teamMode = !!teamMode;
      lobby.teamCount = count;
      if (lobby.teamMode) setupTeams(lobby);
      else lobby.players.forEach(p => { p.team = null; });
    }
    emitUpdate(lobby);
  });

  // Player switches team (lobby only)
  socket.on('lobby:team', ({ code, teamId }) => {
    const lobby = lobbies.get(code);
    const player = playerBySocket(lobby, socket.id);
    if (!player || !lobby.teamMode || lobby.status !== 'waiting') return;
    if (!lobby.teams.some(t => t.id === teamId)) return;
    player.team = teamId;
    emitUpdate(lobby);
  });

  socket.on('lobby:shuffle-teams', ({ code }) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.hostId !== socket.id || !lobby.teamMode || lobby.status !== 'waiting') return;
    const shuffled = [...lobby.players].sort(() => Math.random() - 0.5);
    shuffled.forEach((p, i) => { p.team = lobby.teams[i % lobby.teams.length].id; });
    emitUpdate(lobby);
  });

  socket.on('game:start', async ({ code, token, rematch }) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.hostId !== socket.id || lobby.status !== 'waiting') return;
    lobby.token = token;

    if (lobby.sourceType === 'playlist' && lobby.playlistId) {
      try {
        lobby.playlistTracks = await fetchPlaylistTracks(lobby.playlistId, token);
        if (!lobby.playlistTracks.length) {
          socket.emit('lobby:error', { key: 'err.emptyPlaylist' }); return;
        }
      } catch (e) {
        socket.emit('lobby:error', { key: 'err.playlistLoad' }); return;
      }
    }

    if (lobby.teamMode && !lobby.teams.some(t => teamMembers(lobby, t).length)) setupTeams(lobby);
    lobby.status = 'playing';
    lobby.paused = false;
    lobby.round = 1;
    lobby.players.forEach(p => { p.away = false; });
    // "Play again!": don't repeat played songs while the playlist has enough left
    const playedPlaylist = lobby.usedPlaylistId === lobby.playlistId;
    const remaining = lobby.playlistTracks.filter(t => !lobby.usedTrackIds.has(t.id)).length;
    if (!rematch || !playedPlaylist || remaining < 20) lobby.usedTrackIds = new Set();
    lobby.usedPlaylistId = lobby.playlistId;
    const classic = lobby.gameMode === 'classic';
    const units = unitList(lobby);
    units.forEach(u => resetUnit(u, classic ? START_TOKENS : 0));
    lobby.currentIndex = Math.max(0, units.findIndex(u => unitPlayable(lobby, u)));
    if (classic && lobby.sourceType === 'playlist') {
      for (const u of units.filter(u => unitPlayable(lobby, u))) await giveStartCard(lobby, u);
    }

    broadcast(lobby, 'game:started');
    loadNextTrack(lobby);
  });

  socket.on('game:track-selected', async ({ code, track }) => {
    const lobby = activeLobby(code);
    if (!lobby || lobby.hostId !== socket.id || !track?.id) return;
    // Classic with a playlist: the song must not be swapped manually
    if (lobby.gameMode === 'classic' && lobby.sourceType === 'playlist') return;
    newTurn(lobby);
    await resolveYear(lobby, track);
    lobby.currentTrack = track;
    lobby.usedTrackIds.add(track.id);
    broadcast(lobby, 'game:track', { track });
  });

  // Host sends the new token after a refresh (for suggestions & year correction)
  socket.on('lobby:token', ({ code, token }) => {
    const lobby = lobbies.get(code);
    if (lobby && lobby.hostId === socket.id && token) lobby.token = token;
  });

  // Title/artist suggestions while typing – via the host's Spotify token,
  // so players without a Spotify account get suggestions too
  socket.on('game:suggest', async ({ code, q, field }, reply) => {
    if (typeof reply !== 'function') return;
    const lobby = lobbies.get(code);
    const query = String(q || '').trim().slice(0, 60);
    if (!lobby?.token || query.length < 2 || !playerBySocket(lobby, socket.id)) return reply([]);
    const type = field === 'artist' ? 'artist' : 'track';
    try {
      const r = await axios.get('https://api.spotify.com/v1/search', {
        headers: { Authorization: `Bearer ${lobby.token}` },
        params: { q: query, type, limit: 10 },
      });
      const names = type === 'artist'
        ? r.data.artists.items.map(a => a.name)
        : r.data.tracks.items.map(t => cleanTitle(t.name));
      reply([...new Set(names)].slice(0, 6));
    } catch (e) {
      if (e.response?.status === 401) io.to(lobby.hostId).emit('spotify:refresh-needed');
      reply([]);
    }
  });

  socket.on('game:slot-select', ({ code, slotIndex }) => {
    const lobby = activeLobby(code);
    if (!lobby || !actsForCurrent(lobby, socket.id) || lobby.turn?.phase !== 'placing') return;
    io.to(code).emit('game:slot-selected', { slotIndex });
  });

  // Classic: place the song (Original: title + artist optional for a token; Pro/Expert: required)
  socket.on('game:confirm', ({ code, slotIndex, guessTitle, guessArtist, guessYear }) => {
    const lobby = activeLobby(code);
    if (!lobby || lobby.turn?.phase !== 'placing' || !actsForCurrent(lobby, socket.id)) return;
    const cur = currentUnit(lobby);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > cur.timeline.length) return;

    const track = lobby.currentTrack;
    if (!trackYear(track)) { socket.emit('lobby:error', { key: 'err.noYear' }); return; }

    const t = lobby.turn;
    t.slotIndex = slotIndex;
    t.judgement = judgePlacement({
      variant: lobby.variant, timeline: cur.timeline, slotIndex, track, guessTitle, guessArtist, guessYear,
    });
    if (t.judgement.earnsToken && cur.tokens < MAX_TOKENS) {
      cur.tokens++;
      t.tokenEarned = true;
    }
    startChallengePhase(lobby);
  });

  // Classic: another unit spends a token and puts the card in a different slot
  socket.on('game:songline', ({ code, slotIndex }) => {
    const lobby = activeLobby(code);
    const t = lobby?.turn;
    if (t?.phase !== 'challenge') return;
    const player = playerBySocket(lobby, socket.id);
    const unit = player && unitOf(lobby, player);
    if (!unit || !openChallengers(lobby).includes(unit)) return;
    const cur = currentUnit(lobby);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > cur.timeline.length) return;
    if (slotIndex === t.slotIndex || t.challenges.some(c => c.slotIndex === slotIndex)) {
      socket.emit('lobby:error', { key: 'err.slotTaken' }); return;
    }
    unit.tokens--;
    t.challenges.push({ unit, by: player, slotIndex });
    broadcast(lobby, 'game:challenge');
    maybeFinishChallenge(lobby);
  });

  socket.on('game:pass', ({ code }) => {
    const lobby = activeLobby(code);
    const player = playerBySocket(lobby, socket.id);
    if (lobby?.turn?.phase !== 'challenge' || !player) return;
    lobby.turn.passed.add(unitOf(lobby, player));
    broadcast(lobby, 'game:challenge');
    maybeFinishChallenge(lobby);
  });

  // Active unit or host reveals without waiting for the countdown
  socket.on('game:resolve', ({ code }) => {
    const lobby = activeLobby(code);
    if (lobby?.turn?.phase !== 'challenge') return;
    if (!actsForCurrent(lobby, socket.id) && lobby.hostId !== socket.id) return;
    resolveTurn(lobby);
  });

  // Classic: trade 3 tokens for a card placed correctly into the timeline
  socket.on('game:buy-card', async ({ code }) => {
    const lobby = activeLobby(code);
    if (!lobby || lobby.gameMode !== 'classic' || lobby.turn?.phase !== 'placing') return;
    if (!actsForCurrent(lobby, socket.id)) return;
    const cur = currentUnit(lobby);
    if (cur.tokens < BUY_CARD_COST) return;
    cur.tokens -= BUY_CARD_COST;
    const track = await drawCard(lobby);
    if (!track) { cur.tokens += BUY_CARD_COST; socket.emit('lobby:error', { key: 'err.deckEmpty' }); return; }
    addCard(cur, track);
    broadcast(lobby, 'game:card-bought', { playerName: cur.name, card: timelineCard(track) });
    checkWinner(lobby);
  });

  socket.on('game:guess', ({ code, guessTitle, guessArtist }) => {
    const lobby = activeLobby(code);
    if (!lobby || lobby.verdictPending || !actsForCurrent(lobby, socket.id)) return;
    const cur = currentUnit(lobby);
    const track = lobby.currentTrack;
    const titleOk = titleMatches(guessTitle, track.name);
    const correct = lobby.gameMode === 'guess-hard'
      ? titleOk && artistMatches(guessArtist, track.artists)
      : titleOk;
    if (correct) cur.score++;
    emitVerdict(lobby, { correct, gaveUp: false, track, currentPlayerName: cur.name });
  });

  socket.on('game:reveal', ({ code }) => {
    const lobby = activeLobby(code);
    if (!lobby || lobby.verdictPending || !actsForCurrent(lobby, socket.id)) return;

    if (lobby.gameMode === 'classic') {
      // "No idea": no slot of their own, the others may still call SONGLINE!
      if (lobby.turn?.phase !== 'placing') return;
      lobby.turn.slotIndex = null;
      lobby.turn.judgement = null;
      startChallengePhase(lobby);
      return;
    }
    emitVerdict(lobby, { correct: false, gaveUp: true, track: lobby.currentTrack, currentPlayerName: currentUnit(lobby).name });
  });

  socket.on('game:next', ({ code }) => {
    const lobby = activeLobby(code);
    if (!lobby || !lobby.verdictPending) return;
    lobby.verdictPending = false;
    if (checkWinner(lobby)) return;
    advanceTurn(lobby);
    loadNextTrack(lobby);
  });

  socket.on('game:skip', ({ code }) => {
    const lobby = activeLobby(code);
    if (!lobby) return;
    const cur = currentUnit(lobby);
    const mine = actsForCurrent(lobby, socket.id);
    if (lobby.hostId !== socket.id && !mine) return;

    if (lobby.gameMode === 'classic') {
      // Active unit pays 1 token for a new song; the host may skip for free (e.g. song unavailable)
      if (lobby.turn?.phase !== 'placing') return;
      if (mine) {
        if (cur.tokens < 1) { socket.emit('lobby:error', { key: 'err.needToken' }); return; }
        cur.tokens--;
        io.to(code).emit('game:info', { key: 'info.skipToken', params: { name: cur.name } });
      } else {
        io.to(code).emit('game:info', { key: 'info.hostSkipped' });
      }
      loadNextTrack(lobby);
      return;
    }
    advanceTurn(lobby);
    loadNextTrack(lobby);
  });

  socket.on('lobby:back', ({ code }) => {
    const lobby = lobbies.get(code);
    if (!lobby || lobby.hostId !== socket.id) return;
    backToLobby(lobby);
    emitUpdate(lobby);
    io.to(code).emit('game:back-to-lobby');
  });

  socket.on('disconnect', () => {
    if (socket.data.tvCode) tvCodes.delete(socket.data.tvCode);
    for (const lobby of lobbies.values()) {
      const player = playerBySocket(lobby, socket.id);
      if (!player) continue;
      player.connected = false;
      emitUpdate(lobby);
      if (lobby.hostId === player.id) pauseGame(lobby);
      else maybeFinishChallenge(lobby);
      scheduleRemoval(lobby, player);
    }
  });
});

// ─── Spotify OAuth ────────────────────────────────────────────────────────────

app.get('/api/login', (req, res) => {
  const scopes = ['streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state', 'user-read-playback-state'].join(' ');
  const params = new URLSearchParams({ response_type: 'code', client_id: SPOTIFY_CLIENT_ID, scope: scopes, redirect_uri: REDIRECT_URI });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/api/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token } = response.data;
    res.redirect(`/?access_token=${access_token}&refresh_token=${refresh_token}`);
  } catch (err) {
    console.error('Callback error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

app.post('/api/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token }),
      { headers: { Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

app.get('/api/search', async (req, res) => {
  const { q, token } = req.query;
  try {
    const response = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q, type: 'track', limit: 10 },
    });
    res.json(response.data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: 'Search failed' });
  }
});

// QR code (SVG) for the invite link
app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 300);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0f0c1d', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
  } catch (e) {
    res.status(500).end();
  }
});

// ─── Play packs (fixed playlists) ────────────────────────────────────────────

// Returns all preset play packs incl. cover, name & track count,
// fetched live from Spotify (name/cover may change there).
app.get('/api/preset-packs', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token fehlt' });
  try {
    const packs = await Promise.all(PRESET_PACKS.map(async (pack) => {
      try {
        const r = await axios.get(`https://api.spotify.com/v1/playlists/${pack.playlistId}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { fields: 'name,images,tracks.total' },
        });
        return {
          ...pack,
          spotifyName: pack.name,
          cover: r.data.images?.[0]?.url || null,
          trackCount: r.data.tracks?.total ?? null,
        };
      } catch (e) {
        return { ...pack, spotifyName: pack.name, cover: null, trackCount: null, error: true };
      }
    }));
    res.json({ packs });
  } catch (err) {
    res.status(500).json({ error: 'Play-Pakete konnten nicht geladen werden' });
  }
});

// Returns cover/name/track count for any (manually entered) playlist ID
app.get('/api/playlist-info', async (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) return res.status(400).json({ error: 'id oder token fehlt' });
  try {
    const r = await axios.get(`https://api.spotify.com/v1/playlists/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'name,images,tracks.total' },
    });
    res.json({
      id,
      name: r.data.name,
      cover: r.data.images?.[0]?.url || null,
      trackCount: r.data.tracks?.total ?? null,
    });
  } catch (err) {
    res.status(404).json({ error: 'Playlist nicht gefunden' });
  }
});

// ─── Serve Frontend ───────────────────────────────────────────────────────────

// Always revalidate HTML/JS/CSS so phones never mix an old app.js with a new index.html after an update
app.use(express.static(path.join(__dirname, '../frontend/public'), {
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

// Load saved lobbies after a restart: everyone counts as offline until they reconnect
function restoreLobbies() {
  for (const lobby of persistence.load(unitList)) {
    lobbies.set(lobby.code, lobby);
    if (lobby.status === 'playing') {
      lobby.paused = true;
      if (lobby.turn?.phase === 'challenge') lobby.turn.remaining = CHALLENGE_MS;
    }
    lobby.players.forEach(p => scheduleRemoval(lobby, p));
  }
  if (lobbies.size) console.log(`${lobbies.size} Lobby(s) wiederhergestellt`);
}

function start(port = process.env.PORT || 3001) {
  restoreLobbies();
  return new Promise(resolve => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`Songline backend running on port ${server.address().port}`);
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { app, server, io, lobbies, start };
