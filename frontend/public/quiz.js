// Intro Quiz (single player): hear 1, 2, 3, 4, 5 seconds of a song, then the whole song – guess it as early as possible.
// Runs entirely in the browser with the player's Spotify token; progress is kept in localStorage.
// Reuses the song loading of Song Battle (battle.js).
const QUIZ_COUNTS = [5, 10, 20];
const QUIZ_STAGES = [1000, 2000, 3000, 4000, 5000, null]; // null = whole song
const QUIZ_POINTS = [6, 5, 4, 3, 2, 1];

let quiz = null;            // { count, tracks: [slim], index, stage, guesses: [[text…]], results: [stage|null], done }
let quizSeq = 0;            // cancels an older snippet when a new one starts
let quizTimer = null;
let quizSuggest = [];
let quizActive = -1;
let quizPick = null;        // suggestion the player picked: { id, title, artist }
let quizSearchTimer = null;

// ── Entry ─────────────────────────────────────────────────────────
function openQuiz() {
  if (!state.accessToken) {
    store.set('pendingQuiz', true);
    location.href = '/api/login';
    return;
  }
  initSpotifySDK();
  loadDevices();
  quiz = store.get('quiz');
  if (quiz && quiz.index >= quiz.tracks.length) { showQuizView('end'); renderQuizEnd(false); }
  else if (quiz) { showQuizView('play'); renderQuizRound(); }
  else { showQuizView('setup'); renderQuizSetup(); }
  showScreen('quiz');
}

function leaveQuiz() {
  stopQuizAudio();
  showScreen('menu');
}

function showQuizView(view) {
  ['setup', 'loading', 'play', 'end'].forEach(v =>
    document.getElementById('quiz-' + v).style.display = v === view ? '' : 'none');
}

// ── Setup ─────────────────────────────────────────────────────────
function renderQuizSetup() {
  const count = Number(store.get('quizCount')) || 10;
  document.querySelectorAll('.quiz-count').forEach(b => b.classList.toggle('active', Number(b.dataset.count) === count));
  const source = store.get('quizSource') || 'pack';
  document.querySelectorAll('.quiz-source').forEach(b => b.classList.toggle('active', b.dataset.source === source));
  document.getElementById('quiz-pack-wrap').style.display = source === 'pack' ? '' : 'none';
  document.getElementById('quiz-playlist-wrap').style.display = source === 'playlist' ? '' : 'none';
  if (source === 'pack' && !document.getElementById('quiz-pack').options.length) loadQuizPacks();
  renderDeviceSelects();
}

function setQuizCount(n) { store.set('quizCount', n); renderQuizSetup(); }
function setQuizSource(s) { store.set('quizSource', s); renderQuizSetup(); }

async function loadQuizPacks() {
  let packs = [];
  try {
    const res = await apiFetch(`/api/preset-packs?token=${state.accessToken}`);
    packs = ((await res.json()).packs || []).filter(p => !p.error);
  } catch (e) { /* empty list */ }
  document.getElementById('quiz-pack').innerHTML = packs
    .map(p => `<option value="${esc(p.playlistId)}">${esc(p.name)}${p.linked ? ' ✓' : ''}${p.trackCount ? ` (${p.trackCount})` : ''}</option>`).join('');
}

async function startQuiz() {
  const count = Number(store.get('quizCount')) || 10;
  const source = store.get('quizSource') || 'pack';
  let playlistId = null;
  if (source === 'pack') playlistId = document.getElementById('quiz-pack').value;
  if (source === 'playlist') {
    playlistId = extractPlaylistId(document.getElementById('quiz-playlist').value.trim());
    if (!playlistId) { showToast(L('t.enterPlaylist')); return; }
  }
  showQuizView('loading');
  const progress = n => {
    document.getElementById('quiz-loading-text').textContent = L('battle.loading', { n, size: count });
    document.getElementById('quiz-loading-bar').style.width = `${(n / count) * 100}%`;
  };
  progress(0);
  let tracks;
  try {
    tracks = playlistId ? await fetchPlaylistTracks(playlistId, count, progress) : await fetchRandomTracks(count, progress);
  } catch (e) {
    showToast(L(e.message === 'forbidden' ? 'err.playlistForbidden' : 'err.playlistLoad'));
    showQuizView('setup');
    return;
  }
  if (tracks.length < count) {
    showToast(L('battle.notEnough', { n: tracks.length, size: count }));
    showQuizView('setup');
    return;
  }
  quiz = { count, tracks, index: 0, stage: 0, guesses: [[]], results: [], done: false };
  saveQuiz();
  showQuizView('play');
  renderQuizRound();
}

function saveQuiz() { store.set('quiz', quiz); }
function quizTrack() { return quiz.tracks[quiz.index]; }
function quizScore() { return quiz.results.reduce((n, s) => n + (s === null ? 0 : QUIZ_POINTS[s]), 0); }

// ── Round ─────────────────────────────────────────────────────────
function stageLabel(i) { return QUIZ_STAGES[i] ? `${QUIZ_STAGES[i] / 1000}s` : '♪'; }

function renderQuizRound() {
  document.getElementById('quiz-pos').textContent = L('quiz.songOf', { i: quiz.index + 1, n: quiz.count });
  document.getElementById('quiz-score').textContent = L('quiz.points', { n: quizScore() });
  document.getElementById('quiz-progress').style.width = `${(quiz.index / quiz.count) * 100}%`;
  renderQuizStages();
  const guesses = quiz.guesses[quiz.index] || [];
  document.getElementById('quiz-guesses').innerHTML = guesses
    .map(g => `<li>${g ? `✗ ${esc(g)}` : `⏭ ${L('quiz.skipped')}`}</li>`).join('');
  const over = quiz.done;
  document.getElementById('quiz-ask').style.display = over ? 'none' : '';
  document.getElementById('quiz-reveal').style.display = over ? '' : 'none';
  if (over) { renderQuizReveal(); return; }
  const full = QUIZ_STAGES[quiz.stage] === null;
  document.getElementById('quiz-play-btn').innerHTML = full
    ? L('quiz.playFull')
    : L('quiz.playSec', { n: QUIZ_STAGES[quiz.stage] / 1000 });
  document.getElementById('quiz-skip').textContent = full
    ? L('quiz.giveUp')
    : L('quiz.skip', { n: QUIZ_STAGES[quiz.stage + 1] ? QUIZ_STAGES[quiz.stage + 1] / 1000 + 's' : '♪' });
  document.getElementById('quiz-input').value = '';
  quizPick = null;
  closeQuizSuggest();
}

function renderQuizStages() {
  const guesses = quiz.guesses[quiz.index] || [];
  const result = quiz.results[quiz.index];
  document.getElementById('quiz-stages').innerHTML = QUIZ_STAGES.map((ms, i) => {
    let cls = '';
    if (i < guesses.length) cls = guesses[i] ? 'wrong' : 'skipped';
    if (quiz.done && result === i) cls = 'right';
    if (!quiz.done && i === quiz.stage) cls = 'current';
    return `<div class="quiz-stage ${cls}" style="flex-grow:${ms ? ms / 1000 : 3}"><i></i><span>${stageLabel(i)}</span></div>`;
  }).join('');
}

// Plays the current snippet from the start of the song and stops it after exactly n seconds
async function playQuizSnippet() {
  if (!quiz || quiz.done) return;
  const seq = ++quizSeq;
  clearTimeout(quizTimer);
  const ms = QUIZ_STAGES[quiz.stage];
  const bar = document.querySelector('.quiz-stage.current i');
  if (bar) { bar.style.transition = 'none'; bar.style.width = '0'; }
  await pauseNow();
  await playTrack({ id: quizTrack().id }, { positionMs: 0 });
  if (ms === null || seq !== quizSeq) return;
  // Wait until the song really plays, so slow devices still get the full snippet
  const t0 = Date.now();
  let pos = 0;
  while (Date.now() - t0 < 6000) {
    const s = await getPlaybackState().catch(() => null);
    if (seq !== quizSeq) return;
    if (s && !s.paused && s.position > 0 && s.position < 3000) { pos = s.position; break; }
    await new Promise(r => setTimeout(r, usingBrowserPlayer() ? 40 : 250));
  }
  const left = Math.max(0, ms - pos);
  if (bar) {
    bar.style.width = `${(pos / ms) * 100}%`;
    requestAnimationFrame(() => { bar.style.transition = `width ${left}ms linear`; bar.style.width = '100%'; });
  }
  quizTimer = setTimeout(() => { if (seq === quizSeq) pauseNow(); }, left);
}

function stopQuizAudio() {
  quizSeq++;
  clearTimeout(quizTimer);
  stopAudio();
}

// ── Guessing ──────────────────────────────────────────────────────
// Same typo tolerance as the multiplayer modes (backend/game-logic.js)
function quizNorm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(the|die|der|das) /, '');
}
function quizCleanTitle(t) {
  return (t || '').replace(/\s+-\s+.*$/, '').replace(/[([].*?[)\]]/g, '').replace(/\s(feat|ft|with)\.?\s.*$/i, '').trim() || t;
}
function quizLev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function quizFuzzy(guess, actual) {
  const g = quizNorm(guess), a = quizNorm(actual);
  if (!g || !a) return false;
  if (g === a || g.replace(/ /g, '') === a.replace(/ /g, '')) return true;
  if (a.length <= 3) return false;
  return quizLev(g, a) <= Math.floor(a.length / 4);
}

// A picked suggestion must match title and artist, free text only the title
function quizCorrect(t) {
  if (quizPick && quizPick.id === t.id) return true;
  const title = quizPick ? quizPick.title : document.getElementById('quiz-input').value;
  const titleOk = quizFuzzy(title, t.name) || quizFuzzy(quizCleanTitle(title), quizCleanTitle(t.name));
  if (!titleOk || !quizPick) return titleOk;
  return t.artist.split(', ').some(a => quizPick.artist.split(', ').some(b => quizFuzzy(b, a)));
}

function submitQuizGuess() {
  if (!quiz || quiz.done) return;
  const text = quizPick ? `${quizPick.title} – ${quizPick.artist}` : document.getElementById('quiz-input').value.trim();
  if (!text) { document.getElementById('quiz-input').focus(); return; }
  if (quizCorrect(quizTrack())) finishQuizSong(quiz.stage);
  else {
    Effects.sound('wrong');
    nextQuizStage(text);
  }
}

function skipQuizStage() {
  if (!quiz || quiz.done) return;
  if (QUIZ_STAGES[quiz.stage] === null) { quiz.guesses[quiz.index].push(''); finishQuizSong(null); }
  else nextQuizStage('');
}

// Wrong or skipped: one more second (or the whole song at the end)
function nextQuizStage(guess) {
  quiz.guesses[quiz.index].push(guess);
  if (quiz.stage >= QUIZ_STAGES.length - 1) { finishQuizSong(null); return; }
  quiz.stage++;
  saveQuiz();
  renderQuizRound();
  playQuizSnippet();
}

function finishQuizSong(stage) {
  quiz.results[quiz.index] = stage;
  quiz.done = true;
  saveQuiz();
  quizSeq++;
  clearTimeout(quizTimer);
  renderQuizRound();
  if (stage !== null) { Effects.sound('correct'); if (stage <= 1) Effects.confetti(80); }
  else Effects.sound('wrong');
  // The solution plays on from the start
  playTrack({ id: quizTrack().id }, { positionMs: 0 });
}

function renderQuizReveal() {
  const t = quizTrack();
  const stage = quiz.results[quiz.index];
  document.getElementById('quiz-reveal').innerHTML = `
    <div class="quiz-verdict ${stage === null ? 'wrong' : 'right'}">
      ${stage === null ? L('quiz.missed') : L('quiz.gotIt', { s: stageLabel(stage), pts: QUIZ_POINTS[stage] })}
    </div>
    <div class="quiz-song">
      ${t.cover ? `<img src="${esc(t.cover)}" alt="">` : '<div class="quiz-song-ph">🎵</div>'}
      <div><b>${esc(quizCleanTitle(t.name))}</b><span>${esc(t.artist)}${t.year ? ` · ${esc(t.year)}` : ''}</span></div>
    </div>
    <button class="btn-primary" onclick="nextQuizSong()">${L(quiz.index + 1 >= quiz.count ? 'quiz.toResult' : 'quiz.next')}</button>`;
}

function nextQuizSong() {
  stopQuizAudio();
  quiz.index++;
  quiz.stage = 0;
  quiz.done = false;
  quiz.guesses.push([]);
  saveQuiz();
  if (quiz.index >= quiz.count) { showQuizView('end'); renderQuizEnd(true); return; }
  renderQuizRound();
  playQuizSnippet();
}

// ── Suggestions (Spotify search: title – artist) ──────────────────
function onQuizInput() {
  quizPick = null;
  clearTimeout(quizSearchTimer);
  const q = document.getElementById('quiz-input').value.trim();
  if (q.length < 2) { closeQuizSuggest(); return; }
  const seq = ++quizSuggestSeq;
  quizSearchTimer = setTimeout(async () => {
    const res = await spotifyApi(`/search?q=${encodeURIComponent(q)}&type=track&limit=10`).catch(() => null);
    if (!res?.ok || seq !== quizSuggestSeq) return;
    const seen = new Set();
    quizSuggest = ((await res.json()).tracks?.items || []).map(t => ({
      id: t.id, title: quizCleanTitle(t.name), artist: t.artists.map(a => a.name).join(', '),
    })).filter(s => { const k = quizNorm(s.title + '|' + s.artist); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
    quizActive = -1;
    renderQuizSuggest();
  }, 250);
}
let quizSuggestSeq = 0;

function renderQuizSuggest() {
  const list = document.getElementById('quiz-suggest');
  list.innerHTML = quizSuggest.map((s, i) =>
    `<div class="suggest-item${i === quizActive ? ' active' : ''}" data-i="${i}"><b>${esc(s.title)}</b> <small>${esc(s.artist)}</small></div>`).join('');
  list.style.display = quizSuggest.length ? 'block' : 'none';
}

function closeQuizSuggest() {
  quizSuggestSeq++;
  quizSuggest = [];
  quizActive = -1;
  const list = document.getElementById('quiz-suggest');
  if (list) list.style.display = 'none';
}

function pickQuizSuggest(i) {
  quizPick = quizSuggest[i];
  document.getElementById('quiz-input').value = `${quizPick.title} – ${quizPick.artist}`;
  closeQuizSuggest();
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('quiz-input');
  input.addEventListener('keydown', e => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && quizSuggest.length) {
      e.preventDefault();
      quizActive = (quizActive + (e.key === 'ArrowDown' ? 1 : -1) + quizSuggest.length) % quizSuggest.length;
      renderQuizSuggest();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (quizActive >= 0 && quizSuggest.length) pickQuizSuggest(quizActive);
      else { closeQuizSuggest(); submitQuizGuess(); }
    } else if (e.key === 'Escape') closeQuizSuggest();
  });
  input.addEventListener('blur', () => setTimeout(closeQuizSuggest, 150));
  // pointerdown instead of click so the field doesn't lose focus first
  document.getElementById('quiz-suggest').addEventListener('pointerdown', e => {
    const el = e.target.closest('.suggest-item');
    if (!el) return;
    e.preventDefault();
    pickQuizSuggest(+el.dataset.i);
  });
});

// ── Result ────────────────────────────────────────────────────────
function renderQuizEnd(fresh) {
  const score = quizScore();
  const max = quiz.count * QUIZ_POINTS[0];
  const solved = quiz.results.filter(s => s !== null).length;
  // One row of squares per song: grey = skipped, red = wrong, green = solved
  const rows = quiz.tracks.map((t, i) => {
    const s = quiz.results[i];
    const squares = QUIZ_STAGES.map((_, k) => {
      const g = quiz.guesses[i]?.[k];
      return `<i class="${s === k ? 'right' : g === undefined ? '' : g ? 'wrong' : 'skipped'}"></i>`;
    }).join('');
    return `<li><span class="quiz-squares">${squares}</span><b>${esc(quizCleanTitle(t.name))}</b> · ${esc(t.artist)}<em>${s === null ? '0' : '+' + QUIZ_POINTS[s]}</em></li>`;
  }).join('');
  document.getElementById('quiz-end-body').innerHTML = `
    <div class="quiz-total"><b>${score}</b><span>/ ${max} ${L('quiz.pointsShort')}</span></div>
    <p class="text-muted">${L('quiz.solved', { n: solved, total: quiz.count })}</p>
    <ol class="quiz-list">${rows}</ol>`;
  if (fresh) { Effects.sound('win'); if (score >= max / 2) Effects.confetti(200); }
}

function abortQuiz() {
  if (!confirm(L('quiz.confirmAbort'))) return;
  newQuiz();
}

function newQuiz() {
  stopQuizAudio();
  store.del('quiz');
  quiz = null;
  showQuizView('setup');
  renderQuizSetup();
}

onLangChange(() => {
  if (document.body.dataset.screen !== 'quiz') return;
  if (!quiz) renderQuizSetup();
  else if (quiz.index >= quiz.count) renderQuizEnd(false);
  else renderQuizRound(); // labels only, the snippet keeps playing
});
