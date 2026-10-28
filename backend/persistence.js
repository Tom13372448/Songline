// Stores lobbies as JSON so running games survive a server restart.
// Only active when DATA_DIR is set (/app/data in the Docker setup).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR;
const FILE = DATA_DIR && path.join(DATA_DIR, 'lobbies.json');
const DEBOUNCE_MS = 1500;

let timer = null;

function serialize(lobby, units) {
  const { turn, usedTrackIds, players, teams, ...rest } = lobby;
  return {
    ...rest,
    usedTrackIds: [...usedTrackIds],
    players: players.map(({ removeTimer, ...p }) => p),
    teams,
    turn: turn && {
      phase: turn.phase,
      slotIndex: turn.slotIndex,
      tokenEarned: turn.tokenEarned,
      judgement: turn.judgement || null,
      // Store references to units/players as indexes
      challenges: turn.challenges.map(c => ({ unit: units.indexOf(c.unit), by: players.indexOf(c.by), slotIndex: c.slotIndex })),
      passed: [...turn.passed].map(u => units.indexOf(u)),
    },
  };
}

function deserialize(data, unitList) {
  const lobby = {
    ...data,
    usedTrackIds: new Set(data.usedTrackIds),
    players: data.players.map(p => ({ ...p, connected: false })),
    turn: null,
  };
  if (data.turn) {
    const units = unitList(lobby);
    lobby.turn = {
      ...data.turn,
      challenges: data.turn.challenges
        .map(c => ({ unit: units[c.unit], by: lobby.players[c.by], slotIndex: c.slotIndex }))
        .filter(c => c.unit && c.by),
      passed: new Set(data.turn.passed.map(i => units[i]).filter(Boolean)),
    };
  }
  return lobby;
}

function save(lobbies, unitList) {
  const data = [...lobbies.values()].map(l => serialize(l, unitList(l)));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);
}

let unitListFn = null;

// Several changes in quick succession are combined into one write
function schedule(lobbies) {
  if (!FILE || !unitListFn) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { save(lobbies, unitListFn); } catch (e) { console.error('Saving lobbies failed:', e.message); }
  }, DEBOUNCE_MS);
}

function load(unitList) {
  unitListFn = unitList;
  if (!FILE || !fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).map(d => deserialize(d, unitList));
  } catch (e) {
    console.error('Saved lobbies could not be loaded:', e.message);
    return [];
  }
}

module.exports = { schedule, load, serialize, deserialize };
