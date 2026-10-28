// Pure game logic without network/socket dependencies – used by server.js and tested in test/.

// Lowercase, no accents/punctuation, "&" = "and", no leading article
function normalize(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(the|die|der|das) /, '');
}

// "Song (Remastered 2011) - Radio Edit feat. X" → "Song"
function cleanTitle(title) {
  return (title || '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[([].*?[)\]]/g, '')
    .replace(/\s(feat|ft|with)\.?\s.*$/i, '')
    .trim() || title;
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Typos allowed: about 1 error per 4 characters, very short names must match exactly
function fuzzyEqual(guess, actual) {
  const g = normalize(guess);
  const a = normalize(actual);
  if (!g || !a) return false;
  if (g === a || g.replace(/ /g, '') === a.replace(/ /g, '')) return true;
  if (a.length <= 3) return false;
  return levenshtein(g, a) <= Math.floor(a.length / 4);
}

function titleMatches(guess, title) {
  return fuzzyEqual(guess, title) || fuzzyEqual(guess, cleanTitle(title));
}

// A single artist is enough, all of them together work too
function artistMatches(guess, artists) {
  const names = (artists || []).map(a => a.name);
  return names.some(n => fuzzyEqual(guess, n)) || fuzzyEqual(guess, names.join(' '));
}

function albumYear(track) {
  return parseInt(track?.album?.release_date?.split('-')[0]) || null;
}

// The corrected year (see earliestYear) takes precedence over the album year
function trackYear(track) {
  return track?.year || albumYear(track);
}

function timelineCard(track, extra = {}) {
  return { year: trackYear(track), name: track.name, artist: track.artists?.map(a => a.name).join(', ') || '–', id: track.id, ...extra };
}

// Does a song from this year fit this slot? Equal years may go before or after.
function slotFits(timeline, slotIndex, year) {
  const tl = [...timeline].sort((a, b) => a.year - b.year);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > tl.length) return false;
  return (slotIndex === 0 || tl[slotIndex - 1].year <= year)
      && (slotIndex === tl.length || tl[slotIndex].year >= year);
}

// Remasters, best-of and anniversary albums often report a much later year.
// Take the earliest year among search hits of the same song (same title, same main artist).
function earliestYear(track, candidates) {
  const own = albumYear(track);
  const artistId = track.artists?.[0]?.id;
  const title = normalize(cleanTitle(track.name));
  const years = (candidates || [])
    .filter(c => c && normalize(cleanTitle(c.name)) === title
      && (c.artists || []).some(a => a.id === artistId))
    .map(albumYear)
    .filter(y => y && y >= 1900);
  if (own) years.push(own);
  return years.length ? Math.min(...years) : null;
}

// Judges a placement in classic mode (variants: original / pro / expert)
function judgePlacement({ variant, timeline, slotIndex, track, guessTitle, guessArtist, guessYear }) {
  const year = trackYear(track);
  const placed = slotFits(timeline, slotIndex, year);
  const named = titleMatches(guessTitle, track.name) && artistMatches(guessArtist, track.artists);
  const yearOk = parseInt(guessYear) === year;
  let correct = placed;
  let reason = null;
  if (placed && variant !== 'original' && !named) { correct = false; reason = 'names'; }
  else if (placed && variant === 'expert' && !yearOk) { correct = false; reason = 'year'; }
  return { correct, placed, named, yearOk, reason, earnsToken: variant === 'original' && named };
}

module.exports = {
  normalize, cleanTitle, levenshtein, fuzzyEqual, titleMatches, artistMatches,
  albumYear, trackYear, timelineCard, slotFits, earliestYear, judgePlacement,
};
