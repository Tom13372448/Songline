// TV/projector view (/?tv=CODE): a game-show stage for a big screen – welcome screen with QR code,
// the active player's timeline, SONGLINE! countdown ring, reveal, leaderboard and podium.
let tvLobby = null;
let tvSlot = null;       // slot currently chosen by the active player
let tvVerdict = null;    // last reveal or { ended: winner }
let tvWaitingForSong = false;
let tvCountdown = null;
let tvChallengeTotal = 20000; // length of the SONGLINE! round (measured when it starts)
let tvFlashCardId = null;
const tvKnownPlayers = new Set();

const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

function startTv(code) {
  document.body.classList.add('tv-mode');
  showScreen('tv');
  const url = `${location.origin}/?join=${code}`;
  const qr = `/api/qr?text=${encodeURIComponent(url)}`;
  document.getElementById('tv-qr').src = qr;
  document.getElementById('tvx-qr-small').src = qr;
  document.getElementById('tv-code').textContent = code;
  document.getElementById('tvx-code-small').textContent = code;
  document.getElementById('tv-url').textContent = `${location.host}/?join=${code}`;
  document.getElementById('tvx-url-small').textContent = location.host;
  document.getElementById('tv-status').textContent = L('tvv.connecting');
  show('tvx-game', false);
  show('tvx-end', false);

  socket.onAny((event, payload) => {
    if (event === 'lobby:error') { document.getElementById('tv-status').textContent = serverText(payload); return; }
    if (event === 'game:slot-selected') { tvSlot = payload.slotIndex; renderTv(); return; }
    if (event === 'lobby:closed') { location.href = '/tv'; return; } // back to the pairing code
    if (event === 'game:back-to-lobby') { tvVerdict = null; renderTv(); return; }
    const lobby = event === 'lobby:updated' ? payload : payload?.lobby;
    if (!lobby) return;
    const wasChallenge = tvLobby?.turn?.phase === 'challenge';
    tvLobby = lobby;
    if (['game:track', 'game:needs-track', 'game:started'].includes(event)) {
      tvVerdict = null;
      tvSlot = null;
      tvFlashCardId = null;
      tvWaitingForSong = event === 'game:needs-track';
    }
    if (event === 'game:challenge' && !wasChallenge && lobby.turn?.deadline) {
      tvChallengeTotal = Math.max(5000, lobby.turn.deadline - Date.now());
    }
    if (event === 'game:verdict') {
      tvVerdict = payload;
      tvFlashCardId = payload.correct || payload.stolenBy ? payload.track.id : null;
    }
    if (event === 'game:card-bought') tvFlashCardId = payload.card.id;
    if (event === 'game:ended') { tvVerdict = { ended: payload.winner }; Effects.confetti(320); }
    renderTv();
  });
}

function show(id, visible) {
  document.getElementById(id).style.display = visible ? '' : 'none';
}

function initial(name) {
  return esc((un(name) || '?').replace(/^Team /, '')[0].toUpperCase());
}

function renderTv() {
  const l = tvLobby;
  if (!l) return;
  const ended = !!tvVerdict?.ended;
  const playing = l.status === 'playing' && !ended;
  show('tvx-lobby', !playing && !ended);
  show('tvx-game', playing);
  show('tvx-end', ended);
  clearInterval(tvCountdown);
  if (ended) renderTvEnd(l);
  else if (playing) renderTvGame(l);
  else renderTvLobby(l);
}

// ── Welcome screen ────────────────────────────────────────────────
function renderTvLobby(l) {
  document.getElementById('tv-status').textContent = L(l.players.length ? 'tvv.waitingStart' : 'tvv.empty');
  const color = p => l.units.find(u => u.id === p.team)?.color;
  document.getElementById('tvx-chips').innerHTML = l.players.map(p => {
    const isNew = !tvKnownPlayers.has(p.id);
    tvKnownPlayers.add(p.id);
    return `<div class="tvx-chip ${isNew ? 'new' : ''}" style="${color(p) ? `--team:${color(p)}` : ''}">
      <span class="tvx-chip-avatar">${initial(p.name)}</span>${esc(p.name)}
    </div>`;
  }).join('');
}

// ── Game stage ────────────────────────────────────────────────────
function renderTvGame(l) {
  const cur = l.units.find(u => u.id === l.currentUnitId);
  const classic = l.gameMode === 'classic';
  document.getElementById('tvx-round').textContent = L('tvv.round', { round: l.round });
  document.getElementById('tvx-mode').textContent = L('tvv.mode.' + l.gameMode) + (classic && l.variant !== 'original' ? ` · ${L('variant.' + l.variant)}` : '');
  document.getElementById('tvx-game').classList.toggle('paused', !!l.paused);
  document.getElementById('tvx-game').classList.toggle('guess', !classic);

  // Whose turn
  document.getElementById('tvx-turn').innerHTML = cur ? `
    <div class="tvx-avatar" style="${cur.color ? `--team:${cur.color}` : ''}">${initial(cur.name)}</div>
    <div class="tvx-turn-text">
      <div class="tvx-section-label">${L('tvv.turnLabel')}</div>
      <div class="tvx-turn-name">${esc(un(cur.name))}</div>
      ${l.teamMode ? `<div class="tvx-turn-members">${esc(cur.memberNames.join(' · '))}</div>` : ''}
    </div>` : '';

  renderTvState(l, cur);

  // Active timeline (classic only)
  show('tvx-timeline-wrap', classic && !!cur);
  if (classic && cur) {
    document.getElementById('tvx-timeline-label').textContent = L('tvv.timelineOf', { name: un(cur.name) });
    document.getElementById('tvx-timeline').innerHTML = tvTimeline(l, cur);
  }

  renderTvRanks(l);
}

function renderTvState(l, cur) {
  const el = document.getElementById('tvx-state');
  const v = tvVerdict;
  if (v) {
    const t = v.track;
    const who = esc(un(v.currentPlayerName));
    const good = v.correct || v.stolenBy;
    const result = v.stolenBy ? L('tvv.stolen', { name: esc(un(v.stolenBy)) })
      : v.correct ? L('tvv.correct', { name: who })
      : v.reason ? L('tvv.almost', { name: who })
      : v.gaveUp ? L('tvv.gaveUp', { name: who })
      : L('tvv.wrong', { name: who });
    const cover = t.album?.images?.[0]?.url;
    el.innerHTML = `
      <div class="tvx-reveal">
        ${cover ? `<img class="tvx-cover" src="${esc(cover)}" alt="">` : '<div class="tvx-cover tvx-cover-ph">🎵</div>'}
        <div class="tvx-reveal-info">
          <div class="tvx-reveal-year">${esc(getTrackYear(t) || '????')}</div>
          <div class="tvx-reveal-title">${esc(t.name)}</div>
          <div class="tvx-reveal-artist">${esc(t.artists?.map(a => a.name).join(', '))}</div>
          <div class="tvx-result ${good ? 'good' : 'bad'}">${result}</div>
        </div>
      </div>`;
    return;
  }

  if (l.turn?.phase === 'challenge' && cur) {
    const calls = l.turn.challenges.length;
    el.innerHTML = `
      <div class="tvx-challenge">
        <div class="tvx-ring">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle class="tvx-ring-bg" cx="60" cy="60" r="54"/>
            <circle class="tvx-ring-fg" id="tvx-ring-fg" cx="60" cy="60" r="54"
              stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="0"/>
          </svg>
          <span id="tv-countdown"></span>
        </div>
        <div>
          <div class="tvx-challenge-title">${L('tvv.songlineTitle')}</div>
          <div class="tvx-challenge-sub">${L('tvv.songlineSub', { name: esc(un(cur.name)) })}</div>
          ${calls ? `<div class="tvx-challenge-calls">📣 ${L('tvv.called', { n: calls })}</div>` : ''}
        </div>
      </div>`;
    if (l.turn.deadline && !l.paused) {
      const tick = () => {
        const left = Math.max(0, l.turn.deadline - Date.now());
        const count = document.getElementById('tv-countdown');
        const ring = document.getElementById('tvx-ring-fg');
        if (count) count.textContent = Math.ceil(left / 1000);
        if (ring) ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - left / tvChallengeTotal);
      };
      tick();
      tvCountdown = setInterval(tick, 200);
    }
    return;
  }

  if (tvWaitingForSong) {
    el.innerHTML = `<div class="tvx-playing"><div class="tvx-vinyl idle"></div>
      <div><div class="tvx-playing-title">${L('tvv.hostPicking')}</div></div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="tvx-playing">
      <div class="tvx-vinyl"></div>
      <div>
        <div class="tvx-playing-title">${L('tvv.nowPlaying')}</div>
        <div class="tvx-playing-sub">${L('tvv.listen')}</div>
        <div class="menu-eq tvx-eq-small" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </div>`;
}

function tvTimeline(lobby, unit) {
  const tl = [...unit.timeline].sort((a, b) => a.year - b.year);
  const turn = lobby.turn;
  const showMarkers = !tvVerdict;
  const placed = turn?.phase === 'challenge' ? turn.slotIndex : tvSlot;
  const marker = i => {
    if (!showMarkers) return '';
    const items = [];
    if (placed === i) items.push(`<div class="tvx-marker">👉 ${esc(un(unit.name))}</div>`);
    if (turn?.phase === 'challenge') {
      turn.challenges.filter(c => c.slotIndex === i)
        .forEach(c => items.push(`<div class="tvx-marker hot">📣 ${esc(un(c.name))}</div>`));
    }
    return items.join('');
  };
  let html = '';
  for (let i = 0; i <= tl.length; i++) {
    html += marker(i);
    if (i < tl.length) {
      const c = tl[i];
      html += `<div class="tvx-card ${c.id && c.id === tvFlashCardId ? 'pop' : ''}">
        <div class="tvx-card-year">${c.year}</div>
        <div class="tvx-card-title">${esc(c.name)}</div>
        <div class="tvx-card-artist">${esc(c.artist)}</div>
        ${c.start ? '<div class="tvx-card-star">★</div>' : ''}
      </div>`;
    }
  }
  return html || `<div class="tv-empty">${L('tvv.noCards')}</div>`;
}

function renderTvRanks(l) {
  const classic = l.gameMode === 'classic';
  const units = [...playingUnits(l)].sort((a, b) => b.score - a.score);
  document.getElementById('tvx-ranks').innerHTML = units.map((u, i) => {
    const pct = Math.min(100, (u.score / Math.max(1, l.winCards)) * 100);
    const away = !u.memberIds.length;
    return `<li class="tvx-rank ${u.id === l.currentUnitId ? 'current' : ''} ${away || !u.connected ? 'dim' : ''}" style="${u.color ? `--team:${u.color}` : ''}">
      <span class="tvx-rank-no">${i + 1}</span>
      <span class="tvx-rank-avatar">${initial(u.name)}</span>
      <div class="tvx-rank-main">
        <div class="tvx-rank-name">${esc(un(u.name))}${away ? ' ⏸' : !u.connected ? ' 💤' : ''}</div>
        <div class="tvx-progress"><i style="width:${pct}%"></i></div>
        <div class="tvx-rank-meta">${L(classic ? 'tvv.cardsShort' : 'tvv.pointsShort', { n: u.score, win: l.winCards })}${classic ? ` · ${u.tokens} 🪙` : ''}</div>
      </div>
      <span class="tvx-rank-score">${u.score}</span>
    </li>`;
  }).join('');
}

// ── Game over: podium ─────────────────────────────────────────────
function renderTvEnd(l) {
  const w = tvVerdict.ended;
  const ranked = [...playingUnits(l)].sort((a, b) => b.score - a.score).slice(0, 3);
  const podium = [ranked[1], ranked[0], ranked[2]]; // 2nd – 1st – 3rd
  const places = [2, 1, 3];
  document.getElementById('tvx-end').innerHTML = `
    <div class="tvx-trophy">🏆</div>
    <div class="tvx-winner">${esc(un(w.name))}</div>
    <div class="tvx-winner-sub">${l.teamMode && w.members?.length ? esc(w.members.join(' · ')) + ' – ' : ''}${L('tvv.winnerSub')}</div>
    <div class="tvx-podium">
      ${podium.map((u, i) => u ? `
        <div class="tvx-podium-place p${places[i]}" style="${u.color ? `--team:${u.color}` : ''}">
          <span class="tvx-rank-avatar">${initial(u.name)}</span>
          <div class="tvx-podium-name">${esc(un(u.name))}</div>
          <div class="tvx-podium-block"><span>${places[i]}</span><small>${u.score}</small></div>
        </div>` : '<div></div>').join('')}
    </div>`;
}

onLangChange(() => { if (state.tv) renderTv(); });
