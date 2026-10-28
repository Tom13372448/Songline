// TV/projector view (/?tv=CODE): shows everyone whose turn it is, all timelines,
// the SONGLINE! round with countdown, the reveal – and a QR code to join.
let tvLobby = null;
let tvSlot = null;      // slot currently chosen by the active player
let tvVerdict = null;   // last reveal or { ended: winner }
let tvCountdown = null;

function startTv(code) {
  document.body.classList.add('tv-mode');
  showScreen('tv');
  const url = `${location.origin}/?join=${code}`;
  document.getElementById('tv-qr').src = `/api/qr?text=${encodeURIComponent(url)}`;
  document.getElementById('tv-code').textContent = code;
  document.getElementById('tv-url').textContent = `${location.host}/?join=${code}`;
  document.getElementById('tv-status').textContent = 'Verbinde…';

  socket.onAny((event, payload) => {
    if (event === 'lobby:error') { document.getElementById('tv-status').textContent = payload.message; return; }
    if (event === 'game:slot-selected') { tvSlot = payload.slotIndex; renderTv(); return; }
    if (event === 'lobby:closed') { location.href = '/tv'; return; } // back to the pairing code
    const lobby = event === 'lobby:updated' ? payload : payload?.lobby;
    if (!lobby) return;
    tvLobby = lobby;
    if (['game:track', 'game:needs-track', 'game:started'].includes(event)) { tvVerdict = null; tvSlot = null; }
    if (event === 'game:verdict') tvVerdict = payload;
    if (event === 'game:ended') { tvVerdict = { ended: payload.winner }; Effects.confetti(260); }
    renderTv();
  });
}

function tvTimeline(lobby, unit, isCurrent) {
  const tl = [...unit.timeline].sort((a, b) => a.year - b.year);
  const turn = lobby.turn;
  const showMarkers = isCurrent && lobby.status === 'playing' && !tvVerdict;
  const placed = turn?.phase === 'challenge' ? turn.slotIndex : tvSlot;
  const marker = i => {
    if (!showMarkers) return '';
    const items = [];
    if (placed === i) items.push(`<div class="tv-marker">👉 ${esc(unit.name)}</div>`);
    if (turn?.phase === 'challenge') {
      turn.challenges.filter(c => c.slotIndex === i)
        .forEach(c => items.push(`<div class="tv-marker hot">📣 ${esc(c.name)}</div>`));
    }
    return items.join('');
  };
  let html = '';
  for (let i = 0; i <= tl.length; i++) {
    html += marker(i);
    if (i < tl.length) {
      html += `<div class="tv-card">
        <div class="tv-card-year">${tl[i].start ? '⭐ ' : ''}${tl[i].year}</div>
        <div class="tv-card-title">${esc(tl[i].name)}</div>
        <div class="tv-card-artist">${esc(tl[i].artist)}</div>
      </div>`;
    }
  }
  return html || '<div class="tv-empty">Noch keine Karten</div>';
}

function renderTv() {
  const l = tvLobby;
  if (!l) return;
  const cur = l.units.find(u => u.id === l.currentUnitId);
  const classic = l.gameMode === 'classic';

  // status line
  let status;
  if (tvVerdict?.ended) status = `🏆 <b>${esc(tvVerdict.ended.name)}</b> gewinnt!`;
  else if (l.status !== 'playing') status = 'Scannt den QR-Code und spielt mit!';
  else if (l.paused) status = '⏸ Pause – warte auf den Host…';
  else if (l.turn?.phase === 'challenge') status = `<span class="tv-hot">SONGLINE!</span> Wer glaubt, ${esc(cur?.name)} liegt falsch? <span id="tv-countdown"></span>`;
  else status = `Dran: <b style="color:${cur?.color || 'var(--accent)'}">${esc(cur?.name || '–')}</b>`
    + (l.teamMode && cur ? ` <span class="tv-members">(${esc(cur.memberNames.join(', '))})</span>` : '');
  document.getElementById('tv-status').innerHTML = status;

  // reveal or "song playing"
  const reveal = document.getElementById('tv-reveal');
  const v = tvVerdict && !tvVerdict.ended ? tvVerdict : null;
  if (v) {
    const t = v.track;
    const result = v.stolenBy ? `📣 ${esc(v.stolenBy)} klaut die Karte!`
      : v.correct ? `🎉 ${esc(v.currentPlayerName)} liegt richtig!`
      : v.reason ? `😬 Fast, ${esc(v.currentPlayerName)}!`
      : v.gaveUp ? `🏳️ ${esc(v.currentPlayerName)} hatte keine Ahnung`
      : `💔 Leider falsch, ${esc(v.currentPlayerName)}`;
    reveal.innerHTML = `
      <div class="tv-reveal-card">
        ${t.album?.images?.[0]?.url ? `<img src="${esc(t.album.images[0].url)}" alt="">` : '<div class="tv-reveal-ph">🎵</div>'}
        <div>
          <div class="tv-reveal-year">${esc(getTrackYear(t) || '????')}</div>
          <div class="tv-reveal-title">${esc(t.name)}</div>
          <div class="tv-reveal-artist">${esc(t.artists?.map(a => a.name).join(', '))}</div>
          <div class="tv-reveal-result ${v.correct || v.stolenBy ? 'good' : 'bad'}">${result}</div>
        </div>
      </div>`;
  } else if (l.status === 'playing') {
    reveal.innerHTML = '<div class="tv-playing"><span class="tv-eq"><i></i><i></i><i></i><i></i></span> Song läuft…</div>';
  } else {
    reveal.innerHTML = '';
  }

  // units with timelines (classic) or scores (guess modes)
  const units = l.status === 'playing' || tvVerdict?.ended ? playingUnits(l) : l.units.filter(u => u.memberIds.length);
  document.getElementById('tv-units').innerHTML = units.map(u => {
    const isCurrent = l.status === 'playing' && u.id === l.currentUnitId;
    return `
      <div class="tv-unit ${isCurrent ? 'current' : ''}" style="${u.color ? `--team:${u.color}` : ''}">
        <div class="tv-unit-head">
          <span class="tv-unit-name">${esc(u.name)}${u.connected ? '' : ' 💤'}</span>
          ${l.teamMode ? `<span class="tv-members">${esc(u.memberNames.join(', '))}</span>` : ''}
          <span class="tv-unit-score">${u.score}${classic ? ' 🃏' : ' P'}${classic ? ` · ${u.tokens} 🪙` : ''}</span>
        </div>
        ${classic && (l.status === 'playing' || tvVerdict?.ended) ? `<div class="tv-timeline">${tvTimeline(l, u, isCurrent)}</div>` : ''}
      </div>`;
  }).join('') || '<div class="tv-empty">Noch niemand da – scannt den QR-Code!</div>';

  clearInterval(tvCountdown);
  if (l.turn?.phase === 'challenge' && l.turn.deadline) {
    const tick = () => {
      const el = document.getElementById('tv-countdown');
      if (el) el.textContent = `${Math.max(0, Math.ceil((l.turn.deadline - Date.now()) / 1000))}s`;
    };
    tick();
    tvCountdown = setInterval(tick, 500);
  }
}
