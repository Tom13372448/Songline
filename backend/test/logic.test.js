const test = require('node:test');
const assert = require('node:assert');
const {
  titleMatches, artistMatches, cleanTitle, slotFits, earliestYear, judgePlacement,
} = require('../game-logic');

test('Title: typos and suffixes are tolerated', () => {
  assert.ok(titleMatches('bohemian rapsody', 'Bohemian Rhapsody - Remastered 2011'));
  assert.ok(titleMatches('bohemain rhapsodie', 'Bohemian Rhapsody'));
  assert.ok(titleMatches('Uptown funk', 'Uptown Funk (feat. Bruno Mars)'));
  assert.ok(titleMatches('westerlnd', 'Westerland'));
  assert.ok(titleMatches('helo', 'Hello'));
});

test('Title: partial and wrong answers do not count', () => {
  assert.ok(!titleMatches('bohemian', 'Bohemian Rhapsody'));
  assert.ok(!titleMatches('a', 'Bohemian Rhapsody'));
  assert.ok(!titleMatches('hallo', 'Help!'));
  assert.ok(!titleMatches('', 'Help!'));
});

test('Artist: articles, umlauts, & and multiple artists', () => {
  assert.ok(artistMatches('qeen', [{ name: 'Queen' }]));
  assert.ok(artistMatches('ärzte', [{ name: 'Die Ärzte' }]));
  assert.ok(artistMatches('simon and garfunkel', [{ name: 'Simon & Garfunkel' }]));
  assert.ok(artistMatches('bruno mars', [{ name: 'Mark Ronson' }, { name: 'Bruno Mars' }]));
  assert.ok(!artistMatches('abba', [{ name: 'Queen' }]));
  assert.ok(!artistMatches('u3', [{ name: 'U2' }]), 'short names must match exactly');
});

test('cleanTitle removes remaster/edit/feat.', () => {
  assert.strictEqual(cleanTitle('Song (Remastered 2011) - Radio Edit'), 'Song');
  assert.strictEqual(cleanTitle('Song feat. X'), 'Song');
});

test('slotFits: edges, middle and equal years', () => {
  const tl = [{ year: 1990 }, { year: 1970 }]; // unsorted
  assert.ok(slotFits(tl, 0, 1960));
  assert.ok(slotFits(tl, 1, 1980));
  assert.ok(slotFits(tl, 2, 2000));
  assert.ok(!slotFits(tl, 0, 1980));
  assert.ok(slotFits(tl, 0, 1970) && slotFits(tl, 1, 1970), 'equal year before or after');
  assert.ok(!slotFits(tl, 3, 2000) && !slotFits(tl, null, 2000));
});

test('earliestYear: remaster year is replaced by the original', () => {
  const artist = { id: 'queen', name: 'Queen' };
  const track = { name: 'Bohemian Rhapsody - Remastered 2011', artists: [artist], album: { release_date: '2011-01-01' } };
  const candidates = [
    { name: 'Bohemian Rhapsody', artists: [artist], album: { release_date: '1975-10-31' } },
    { name: 'Bohemian Rhapsody - Live', artists: [artist], album: { release_date: '1986' } },
    { name: 'Bohemian Rhapsody', artists: [{ id: 'cover' }], album: { release_date: '1960' } }, // cover version doesn't count
    { name: 'Another One Bites The Dust', artists: [artist], album: { release_date: '1970' } },
  ];
  assert.strictEqual(earliestYear(track, candidates), 1975);
  assert.strictEqual(earliestYear(track, []), 2011);
});

test('judgePlacement: variants original / pro / expert', () => {
  const track = { name: 'Westerland', artists: [{ name: 'Die Ärzte' }], year: 1988 };
  const timeline = [{ year: 1980 }, { year: 2000 }];
  const base = { timeline, slotIndex: 1, track };

  const orig = judgePlacement({ ...base, variant: 'original', guessTitle: 'westerland', guessArtist: 'ärzte' });
  assert.ok(orig.correct && orig.earnsToken);
  assert.ok(judgePlacement({ ...base, variant: 'original' }).correct, 'names optional');

  const proNoNames = judgePlacement({ ...base, variant: 'pro', guessTitle: 'westerland' });
  assert.ok(!proNoNames.correct && proNoNames.reason === 'names');
  assert.ok(judgePlacement({ ...base, variant: 'pro', guessTitle: 'westerland', guessArtist: 'die ärzte' }).correct);

  const names = { guessTitle: 'westerland', guessArtist: 'die ärzte' };
  const expWrongYear = judgePlacement({ ...base, ...names, variant: 'expert', guessYear: '1987' });
  assert.ok(!expWrongYear.correct && expWrongYear.reason === 'year');
  assert.ok(judgePlacement({ ...base, ...names, variant: 'expert', guessYear: '1988' }).correct);
  assert.ok(!judgePlacement({ ...base, ...names, variant: 'pro', slotIndex: 0 }).correct, 'wrong slot');
});
