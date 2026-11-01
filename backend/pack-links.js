// Links between preset play packs and the host's own copies of those playlists.
// Spotify Development Mode apps may only read songs of playlists the user owns (since
// February 2026), so a host copies a pack once in Spotify and Songline remembers the copy.
// Stored per Spotify user in DATA_DIR/pack-links.json (in memory only without DATA_DIR).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR;
const FILE = DATA_DIR && path.join(DATA_DIR, 'pack-links.json');

let links = null; // { [spotifyUserId]: { [packId]: { playlistId, name } | { ignored: true } } }

function all() {
  if (links) return links;
  links = {};
  if (FILE && fs.existsSync(FILE)) {
    try { links = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
    catch (e) { console.error('Pack links could not be loaded:', e.message); }
  }
  return links;
}

function save() {
  if (!FILE) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(links));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('Saving pack links failed:', e.message); }
}

function forUser(userId) {
  return all()[userId] || {};
}

function setLink(userId, packId, playlist) {
  const map = all();
  map[userId] = map[userId] || {};
  // Unlinking by hand is remembered, so the automatic search doesn't link the pack again
  map[userId][packId] = playlist ? { playlistId: playlist.id, name: playlist.name } : { ignored: true };
  save();
}

// "HITSTER – Rock (Kopie)" → "rock"
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/hitster/g, ' ')
    .replace(/\b(copy|kopie)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Finds the user's copy for each pack by name. packs: [{ id, names: [...] }],
// playlists: [{ id, name }]. Each playlist is used for at most one pack.
function matchCopies(packs, playlists) {
  const used = new Set();
  const result = {};
  for (const pack of packs) {
    const wanted = new Set(pack.names.map(normName).filter(Boolean));
    const hit = playlists.find(p => !used.has(p.id) && wanted.has(normName(p.name)));
    if (hit) { used.add(hit.id); result[pack.id] = hit; }
  }
  return result;
}

module.exports = { forUser, setLink, matchCopies, normName };
