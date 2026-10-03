import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.52.0';

// Set these to your Supabase Project URL and publishable key. Never use a service_role/secret key.
const SUPABASE_URL = '';
const SUPABASE_PUBLISHABLE_KEY = '';

const app = document.querySelector('#app');
const connectionStatus = document.querySelector('#connection-status');
const connectionLabel = document.querySelector('#connection-label');
const toastRoot = document.querySelector('#toast-root');
const hasConfig = /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL) && SUPABASE_PUBLISHABLE_KEY.length > 20;
const supabase = hasConfig ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
}) : null;

const state = {
  userId: null,
  roomId: localStorage.getItem('di-room-id'),
  room: null,
  players: [],
  history: [],
  revealedSecrets: [],
  channel: null,
  refreshTimer: null,
  heartbeatTimer: null,
  timerInterval: null,
  resolvingTurn: null,
  serverOffsetMs: 0,
  busy: false
};

const LENGTHS = [2, 3, 4, 5, 6];
const TIMER_OPTIONS = [10, 15, 20, 30, 45, 60, 75, 90];

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type ? `toast--${type}` : ''}`;
  toast.textContent = message;
  toastRoot.append(toast);
  window.setTimeout(() => toast.remove(), 4300);
}

function setConnection(label, kind = '') {
  connectionLabel.textContent = label;
  connectionStatus.classList.toggle('is-connected', kind === 'connected');
  connectionStatus.classList.toggle('is-error', kind === 'error');
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function validDigits(value, length) {
  return new RegExp(`^[0-9]{${length}}$`).test(value) && new Set(value).size === value.length;
}

function timerOptions(selected = null) {
  const options = [`<option value="none" ${selected === null ? 'selected' : ''}>No timer · free play</option>`];
  for (const seconds of TIMER_OPTIONS) {
    options.push(`<option value="${seconds}" ${Number(selected) === seconds ? 'selected' : ''}>${seconds} seconds</option>`);
  }
  return options.join('');
}

function lengthOptions(selected = 4) {
  return LENGTHS.map((length) => `<option value="${length}" ${Number(selected) === length ? 'selected' : ''}>${length} digits</option>`).join('');
}

function setRoomState(snapshot) {
  const safeSnapshot = snapshot?.state || snapshot;
  if (!safeSnapshot?.room) return;
  const previousState = JSON.stringify({ room: state.room, players: state.players, history: state.history, secrets: state.revealedSecrets, you: state.userId });
  state.room = safeSnapshot.room;
  state.players = Array.isArray(safeSnapshot.players) ? safeSnapshot.players : [];
  state.history = Array.isArray(safeSnapshot.history) ? safeSnapshot.history : [];
  state.revealedSecrets = Array.isArray(safeSnapshot.revealed_secrets) ? safeSnapshot.revealed_secrets : [];
  state.userId = safeSnapshot.you || state.userId;
  if (safeSnapshot.server_now) state.serverOffsetMs = Date.now() - new Date(safeSnapshot.server_now).getTime();
  state.roomId = state.room.id;
  localStorage.setItem('di-room-id', state.room.id);
  setConnection(state.room.status === 'paused' ? 'Reconnect grace' : 'Room connected', 'connected');
  const nextState = JSON.stringify({ room: state.room, players: state.players, history: state.history, secrets: state.revealedSecrets, you: state.userId });
  if (previousState !== nextState) render();
  updateTimerDisplay();
}

function errorMessage(error) {
  const text = error?.message || error?.details || 'Something went wrong. Please try again.';
  if (/anonymous|sign.?in/i.test(text)) return 'Guest sign-in failed. Check that Anonymous Sign-Ins are enabled in Supabase Auth.';
  if (/duplicate|unique/i.test(text)) return 'That name is already being used in this room. Choose another.';
  if (/not a member|membership/i.test(text)) return 'This guest session is not a member of that room. Rejoin using the room code.';
  return text;
}

async function ensureGuest() {
  if (!supabase) throw new Error('Supabase is not configured yet. Add the Project URL and publishable key at the top of script.js.');
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  let user = sessionData.session?.user;
  if (!user) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    user = data.user;
  }
  state.userId = user.id;
  return user.id;
}

async function rpc(name, params, applyState = true) {
  if (!supabase) throw new Error('Live multiplayer is not configured. Follow the Supabase setup in README.md.');
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw error;
  if (data?.ok === false) {
    if (applyState && data.state?.room) setRoomState(data.state);
    throw new Error(data.message || data.reason || 'The action could not be completed.');
  }
  if (applyState && data?.room) setRoomState(data);
  else if (applyState && data?.state?.room) setRoomState(data.state);
  return data;
}

async function loadRoom() {
  if (!supabase || !state.roomId) return false;
  await ensureGuest();
  const { data, error } = await supabase.rpc('get_room_state', { p_room_id: state.roomId });
  if (error) throw error;
  if (!data?.room) throw new Error('That room is no longer available. Return home and create or join another room.');
  setRoomState(data);
  return true;
}

function subscribeRoom() {
  if (!supabase || !state.roomId) return;
  if (state.channel) supabase.removeChannel(state.channel);
  const roomId = state.roomId;
  const refresh = () => {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      if (roomId === state.roomId) loadRoom().catch((error) => showToast(errorMessage(error), 'error'));
    }, 140);
  };
  state.channel = supabase.channel(`game-room-${roomId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'guesses', filter: `room_id=eq.${roomId}` }, refresh)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') loadRoom().catch((error) => showToast(errorMessage(error), 'error'));
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnection('Reconnecting…', 'error');
    });
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    rpc('room_heartbeat', { p_room_id: roomId }, false).catch(() => setConnection('Connection interrupted', 'error'));
  }, 8000);
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimerDisplay, 250);
}

function clearRoom() {
  if (state.channel && supabase) supabase.removeChannel(state.channel);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  if (state.timerInterval) clearInterval(state.timerInterval);
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.channel = null;
  state.roomId = null;
  state.room = null;
  state.players = [];
  state.history = [];
  state.revealedSecrets = [];
  state.resolvingTurn = null;
  localStorage.removeItem('di-room-id');
  render();
  setConnection(hasConfig ? 'Supabase ready' : 'Preview mode', hasConfig ? 'connected' : '');
}

function renderHome() {
  const configNotice = hasConfig ? '' : `
    <aside class="setup-notice" role="status">
      <span class="notice-icon" aria-hidden="true">i</span>
      <div><strong>Preview only — connect Supabase to play live</strong>
        Add your Supabase Project URL and publishable key to the two constants at the top of <code>script.js</code>, then follow README.md. This preview never simulates secure online multiplayer.</div>
    </aside>`;
  app.innerHTML = `
    <section class="hero" aria-labelledby="hero-title">
      <div>
        <p class="eyebrow">A social deduction game</p>
        <h1 id="hero-title">Read the <span>counts.</span></h1>
        <p class="hero-copy">A secret number. A room full of theories. You only get the counts—never the digits behind them.</p>
      </div>
      <div class="hero-art" aria-label="Four abstract digit cells">
        <span class="hero-stamp">NO<br>FREE<br>HINTS</span>
        <div class="number-cell">0</div><div class="number-cell">1</div><div class="number-cell">2</div><div class="number-cell">3</div>
        <div class="art-caption"><strong>DEAD &amp; INJURED</strong><span>DEDUCE THE REST</span></div>
      </div>
    </section>
    ${configNotice}
    <div class="section-heading"><div><p class="eyebrow">Choose your table</p><h2>How do you want to play?</h2></div><p>2–6 digits · leading zeroes allowed</p></div>
    <section class="action-grid" aria-label="Create or join a game">
      <article class="panel action-panel">
        <p class="panel-kicker">01 / Host a room</p><h3>Set the secret rules.</h3>
        <p class="panel-copy">Choose a mode, a number length, and whether turns have a timer.</p>
        <form id="create-form" class="form-stack">
          <div class="field"><label for="create-name">Your name</label><input id="create-name" name="name" maxlength="20" autocomplete="nickname" placeholder="e.g. Quddus" required></div>
          <div class="field"><label for="create-mode">Game mode</label><select id="create-mode" name="mode"><option value="quizmaster">Multiplayer Quizmaster · 3–6 players</option><option value="duel">1v1 · two players</option></select></div>
          <div class="form-row">
            <div class="field"><label for="create-length">Number length</label><select id="create-length" name="length">${lengthOptions(4)}</select></div>
            <div class="field"><label for="create-timer">Time per turn</label><select id="create-timer" name="timer">${timerOptions(30)}</select></div>
          </div>
          <button class="btn btn-primary btn-block" type="submit"><span class="btn-label-icon">+</span> Create game room</button>
          <p class="error-inline" id="create-error" aria-live="polite"></p>
        </form>
      </article>
      <article class="panel action-panel">
        <p class="panel-kicker">02 / Join a room</p><h3>Your friends are waiting.</h3>
        <p class="panel-copy">Enter the short room code shared by the host. Reconnect from the same browser to keep your guest identity.</p>
        <form id="join-form" class="form-stack">
          <div class="field"><label for="join-name">Your name</label><input id="join-name" name="name" maxlength="20" autocomplete="nickname" placeholder="e.g. Tobi" required></div>
          <div class="field"><label for="join-code">Room code</label><input id="join-code" name="code" maxlength="8" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABC234" required></div>
          <button class="btn btn-secondary btn-block" type="submit"><span class="btn-label-icon">↗</span> Join game room</button>
          <p class="error-inline" id="join-error" aria-live="polite"></p>
        </form>
      </article>
    </section>
    <section class="rules-strip" aria-label="How scoring works">
      <div class="rule-cell"><strong><span class="count-chip count-chip--dead">D</span> Dead</strong><span>Right digit, right place.</span></div>
      <div class="rule-cell"><strong><span class="count-chip count-chip--injured">I</span> Injured</strong><span>Right digit, different place.</span></div>
      <div class="rule-cell"><strong>Only the counts</strong><span>No hints about which digits matched.</span></div>
    </section>
  `;
  document.querySelector('#create-form')?.addEventListener('submit', createRoom);
  document.querySelector('#join-form')?.addEventListener('submit', joinRoom);
  document.querySelector('#join-code')?.addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
}

function renderPlayers() {
  const room = state.room;
  return state.players.map((player) => {
    const isHost = player.user_id === room.host_id;
    const isTurn = player.user_id === room.current_player_id && room.status === 'in_progress';
    const badges = [
      isHost ? '<span class="player-badge">HOST</span>' : '',
      isTurn ? '<span class="player-badge">TURN</span>' : '',
      player.status === 'eliminated' ? '<span class="player-badge player-badge--out">ELIMINATED</span>' : '',
      !player.is_online ? '<span class="player-badge player-badge--offline">OFFLINE</span>' : '',
      room.mode === 'duel' && player.secret_submitted ? '<span class="player-badge">SECRET SET</span>' : ''
    ].filter(Boolean).join(' ');
    const kick = room.status === 'lobby' && room.host_id === state.userId && player.user_id !== state.userId
      ? `<button class="btn btn-quiet" data-action="kick" data-user="${escapeHTML(player.user_id)}" aria-label="Remove ${escapeHTML(player.display_name)} from room">Remove</button>` : '';
    return `<div class="player-row"><span class="avatar" aria-hidden="true">${escapeHTML(player.display_name.slice(0, 1).toUpperCase())}</span><div class="player-info"><div class="player-name">${escapeHTML(player.display_name)}</div><div class="player-meta">${badges || '<span>IN ROOM</span>'}</div></div>${kick}</div>`;
  }).join('') || '<p class="note">No players have joined yet.</p>';
}

function renderLobby() {
  const room = state.room;
  const isHost = room.host_id === state.userId;
  const minPlayers = room.mode === 'duel' ? 2 : 3;
  const count = state.players.filter((player) => player.status === 'active').length;
  const ready = count >= minPlayers;
  const settings = `<div class="setting-pills"><span class="pill"><b>${room.mode === 'duel' ? '1v1' : 'QUIZMASTER'}</b></span><span class="pill"><b>${room.number_length}</b> DIGITS</span><span class="pill"><b>${room.turn_seconds ? `${room.turn_seconds}s` : 'FREE PLAY'}</b></span></div>`;
  let setupPanel = '';
  if (room.mode === 'duel') {
    const mine = state.players.find((player) => player.user_id === state.userId);
    setupPanel = mine?.secret_submitted
      ? '<div class="waiting-note">Your secret is locked in. It stays private. Waiting for the other player to submit theirs.</div>'
      : `<form id="secret-form" class="form-stack"><div class="field"><label for="secret-value">Your private ${room.number_length}-digit secret</label><input id="secret-value" class="digit-input" name="secret" type="text" inputmode="numeric" maxlength="${room.number_length}" autocomplete="off" pattern="[0-9]{${room.number_length}}" placeholder="${'·'.repeat(room.number_length)}" required><span class="field-hint">Digits must be unique. Leading zeroes are allowed. Your opponent will never see this number.</span></div><button class="btn btn-primary" type="submit">Lock in my secret</button><p class="error-inline" id="secret-error" aria-live="polite"></p></form>`;
  } else {
    setupPanel = `<p class="note">The Quizmaster will generate and keep one secret number on the server. It will not be sent to players.</p>${isHost ? `<button class="btn btn-primary btn-block" data-action="start-game" ${ready ? '' : 'disabled'}>Start Quizmaster game</button>` : '<div class="waiting-note">Waiting for the host to start the game.</div>'}<p class="error-inline" id="lobby-error" aria-live="polite"></p>`;
  }
  app.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">Room lobby · ${room.mode === 'duel' ? '1v1' : 'Multiplayer Quizmaster'}</p><h1>Gather the players.</h1><p class="page-subtitle">${room.mode === 'duel' ? 'Both players set a private number before the first turn.' : 'The Quizmaster keeps the target hidden. The lobby order is randomized at start.'}</p></div><div class="screen-actions"><span class="room-code" id="room-code">${escapeHTML(room.code)} <button class="btn btn-quiet" data-action="copy-code" aria-label="Copy room code">Copy</button></span></div></div>
    <div class="room-layout">
      <section class="panel panel-pad"><h2 class="panel-title">Game setup <small>${isHost ? 'HOST CONTROLS' : 'WAITING FOR HOST'}</small></h2>${settings}<div class="section-heading"><h2>Players <span class="mono">${count}/${room.mode === 'duel' ? '2' : '6'}</span></h2><p>${ready ? 'Minimum players reached' : `Waiting for ${Math.max(0, minPlayers - count)} more player${minPlayers - count === 1 ? '' : 's'}`}</p></div><div class="player-list">${renderPlayers()}</div><div class="host-tools"><p>${isHost ? 'Share the room code with your friends.' : `Hosted by ${escapeHTML(state.players.find((player) => player.user_id === room.host_id)?.display_name || 'a player')}.`}</p>${isHost ? `<button class="btn btn-danger" data-action="close-room">Close room</button>` : '<span class="pill">LOBBY</span>'}</div></section>
      <aside class="panel panel-pad"><h2 class="panel-title">${room.mode === 'duel' ? 'Private setup' : 'Ready to start'} <small>${room.mode === 'duel' ? 'YOUR SECRET' : 'QUIZMASTER'}</small></h2>${setupPanel}</aside>
    </div>
    <div class="screen-actions" style="margin-top:16px"><button class="btn btn-quiet" data-action="home">Return to home</button></div>
  `;
  document.querySelector('#secret-form')?.addEventListener('submit', submitSecret);
}

function renderHistory() {
  const room = state.room;
  const multiplayer = room.mode === 'quizmaster';
  const headings = multiplayer
    ? '<th scope="col">#</th><th scope="col">Player</th><th scope="col">Guess</th><th scope="col">Dead</th><th scope="col">Injured</th>'
    : '<th scope="col">#</th><th scope="col">Your guess</th><th scope="col">Dead</th><th scope="col">Injured</th>';
  const rows = state.history.length ? state.history.map((entry) => {
    const owner = state.players.find((player) => player.user_id === entry.player_id)?.display_name || 'Player';
    return `<tr><td class="mono">${escapeHTML(entry.turn_number)}</td>${multiplayer ? `<td class="td-player">${escapeHTML(owner)}</td>` : ''}<td class="td-number">${escapeHTML(entry.guess)}</td><td><span class="count-chip count-chip--dead">${escapeHTML(entry.dead)}</span></td><td><span class="count-chip count-chip--injured">${escapeHTML(entry.injured)}</span></td></tr>`;
  }).join('') : `<tr><td class="empty-row" colspan="${multiplayer ? 5 : 4}">No guesses yet. The table is waiting for its first theory.</td></tr>`;
  return `<section class="panel table-card"><div class="panel-pad"><h2 class="panel-title">${multiplayer ? 'Shared deduction history' : 'Your private deduction history'} <small>${state.history.length} ${state.history.length === 1 ? 'GUESS' : 'GUESSES'}</small></h2></div><div class="table-scroll"><table class="guess-table"><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderOrder() {
  const room = state.room;
  const order = Array.isArray(room.turn_order) ? room.turn_order : [];
  const list = order.map((userId, index) => {
    const player = state.players.find((item) => item.user_id === userId);
    if (!player) return '';
    const current = userId === room.current_player_id;
    const out = player.status === 'eliminated';
    return `<div class="order-item ${current ? 'is-current' : ''} ${out ? 'is-out' : ''}"><span class="order-index">${index + 1}</span><span>${escapeHTML(player.display_name)}${current ? ' · NOW' : ''}</span></div>`;
  }).join('');
  return list || '<p class="note">Turn order appears when the game starts.</p>';
}

function renderGame() {
  const room = state.room;
  const currentPlayer = state.players.find((player) => player.user_id === room.current_player_id);
  const me = state.players.find((player) => player.user_id === state.userId);
  const yourTurn = room.current_player_id === state.userId && me?.status === 'active' && room.status === 'in_progress';
  const paused = room.status === 'paused';
  const offline = me?.status === 'eliminated';
  const waitingTitle = paused ? 'Reconnect pause' : offline ? 'You are out' : yourTurn ? 'Your turn.' : `${currentPlayer?.display_name || 'A player'} is guessing.`;
  const turnHint = paused ? 'The room is allowing a short reconnection window.' : offline ? 'You can still follow the shared room state.' : yourTurn ? 'Enter a theory. Only the counts come back.' : 'Watch the table, compare the counts, and plan your next move.';
  const canGuess = yourTurn && !paused;
  const guessPanel = offline ? `<section class="panel action-card"><h2>Eliminated</h2><p class="action-desc">Your game is over, but you can still follow the room.</p></section>` : `
    <section class="panel action-card"><p class="panel-kicker">Normal turn</p><h2>${canGuess ? 'Make your guess.' : 'Hold your theory.'}</h2><p class="action-desc">${canGuess ? `Enter exactly ${room.number_length} unique digits. Only Dead and Injured totals will be shown.` : 'Only the player whose turn it is can submit a normal guess.'}</p>
      <form id="guess-form" class="form-stack"><div class="field"><label for="guess-value">${room.number_length}-digit guess</label><input id="guess-value" class="digit-input" name="guess" type="text" inputmode="numeric" maxlength="${room.number_length}" autocomplete="off" pattern="[0-9]{${room.number_length}}" placeholder="${'·'.repeat(room.number_length)}" ${canGuess ? 'required' : 'disabled'}></div><button class="btn btn-primary btn-block" type="submit" ${canGuess ? '' : 'disabled'}>Submit normal guess</button><p class="error-inline" id="guess-error" aria-live="polite"></p></form>
    </section>`;
  const canSteal = room.mode === 'quizmaster' && !yourTurn && me?.status === 'active' && room.status === 'in_progress';
  const stealPanel = room.mode === 'quizmaster' && !offline ? `<section class="panel action-card action-card--steal"><p class="panel-kicker">Out-of-turn · Quizmaster only</p><h2>Risk an instant win.</h2><p class="action-desc">A correct answer wins immediately. A wrong answer eliminates you. Your candidate is never added to the shared table.</p><form id="steal-form" class="form-stack"><div class="field"><label for="steal-value">Your ${room.number_length}-digit answer</label><input id="steal-value" class="digit-input digit-input--steal" name="guess" type="text" inputmode="numeric" maxlength="${room.number_length}" autocomplete="off" pattern="[0-9]{${room.number_length}}" placeholder="${'·'.repeat(room.number_length)}" ${canSteal ? 'required' : 'disabled'}></div><button class="btn btn-danger btn-block" type="submit" ${canSteal ? '' : 'disabled'}>⚡ Try instant win</button><p class="error-inline" id="steal-error" aria-live="polite"></p><p class="risk-note"><span aria-hidden="true">!</span><span>Check your digits before submitting. A wrong attempt is final.</span></p></form></section>` : '';
  const roster = `<div class="player-list">${renderPlayers()}</div>`;
  app.innerHTML = `
    <div class="page-head"><div><p class="eyebrow">${room.mode === 'duel' ? '1v1 duel' : 'Quizmaster room'} · turn ${escapeHTML(room.turn_number || 1)}</p><h1>${escapeHTML(waitingTitle)}</h1><p class="page-subtitle">${escapeHTML(turnHint)}</p></div><span class="room-code">${escapeHTML(room.code)}</span></div>
    <div class="game-meta"><span class="pill"><b>${room.number_length}</b> DIGITS</span><span class="pill"><b>${room.mode === 'duel' ? '1v1' : 'QUIZMASTER'}</b></span><span class="pill"><b>${room.turn_seconds ? `${room.turn_seconds}s / TURN` : 'FREE PLAY'}</b></span></div>
    <div class="game-grid"><div>
      <section class="panel turn-card"><div class="turn-top"><div><p class="turn-label">${paused ? 'RECONNECT WINDOW' : yourTurn ? 'CURRENT PLAYER' : 'CURRENT TURN'}</p><h2 class="turn-name">${escapeHTML(currentPlayer?.display_name || (paused ? 'Waiting for players' : '—'))}</h2><p class="turn-detail">${yourTurn ? 'Make it count.' : 'The deduction continues.'}</p></div><div class="timer-box" id="timer-box"><div class="timer-value" id="timer-value">${room.turn_seconds ? '—' : '∞'}</div><div class="timer-caption" id="timer-caption">${room.turn_seconds ? 'SECONDS' : 'FREE PLAY'}</div></div></div><div class="turn-progress" aria-hidden="true"><span id="timer-progress"></span></div></section>
      ${guessPanel}${stealPanel}${renderHistory()}
    </div><aside class="side-stack"><section class="panel"><h2 class="panel-title">Players <small>${state.players.filter((player) => player.status === 'active').length} ACTIVE</small></h2>${roster}</section><section class="panel"><h2 class="panel-title">Turn order <small>RANDOMIZED</small></h2><div class="order-list">${renderOrder()}</div><div class="setting-pills"><span class="pill">ROOM <b>${escapeHTML(room.code)}</b></span></div><button class="btn btn-quiet btn-block" data-action="copy-code">Copy room code</button></section></aside></div>
    <div class="screen-actions" style="margin-top:16px"><button class="btn btn-quiet" data-action="home">Return to home</button></div>
  `;
  document.querySelector('#guess-form')?.addEventListener('submit', submitGuess);
  document.querySelector('#steal-form')?.addEventListener('submit', submitInstantWin);
}

function renderGameOver() {
  const room = state.room;
  const winner = state.players.find((player) => player.user_id === room.winner_id);
  const draw = !winner;
  const secretBoxes = state.revealedSecrets.map((item) => {
    const player = state.players.find((entry) => entry.user_id === item.owner_id);
    const label = item.kind === 'quizmaster' ? 'QUIZMASTER SECRET' : `${player?.display_name || 'PLAYER'}’S SECRET`;
    return `<span title="${escapeHTML(label)}">${escapeHTML(item.secret_value)}</span>`;
  }).join('');
  const host = room.host_id === state.userId;
  const rematch = host ? `<form id="rematch-form" class="rematch-form form-stack"><p class="panel-kicker">Same room · fresh match</p><div class="form-row"><div class="field"><label for="rematch-length">Number length</label><select id="rematch-length" name="length">${lengthOptions(room.number_length)}</select></div><div class="field"><label for="rematch-timer">Time per turn</label><select id="rematch-timer" name="timer">${timerOptions(room.turn_seconds)}</select></div></div><button class="btn btn-primary btn-block" type="submit">Set up a rematch</button><p class="error-inline" id="rematch-error" aria-live="polite"></p></form>` : '<p class="note">Waiting for the host to start a rematch or create a new room.</p>';
  app.innerHTML = `<section class="panel game-over"><span class="win-seal" aria-hidden="true">${draw ? '—' : '✓'}</span><p class="eyebrow" style="justify-content:center">${room.status === 'closed' ? 'ROOM CLOSED' : 'GAME OVER'}</p><h1>${draw ? 'No winner this time.' : `${escapeHTML(winner.display_name)} wins.`}</h1><p>${room.win_type === 'instant' ? 'The instant-win call landed.' : room.win_type === 'all_eliminated' ? 'Everyone was eliminated before solving the number.' : room.win_type === 'normal' ? 'A perfect deduction.' : 'The room has ended.'}</p><div class="secret-reveal" aria-label="Revealed secret number">${secretBoxes || '<span>Secret unavailable</span>'}</div><p class="note">The secret is revealed after the game. Private 1v1 guess histories remain private.</p><div class="game-over-actions"><button class="btn btn-secondary" data-action="home">Return home</button></div>${rematch}</section>`;
  document.querySelector('#rematch-form')?.addEventListener('submit', startRematch);
}

function render() {
  if (!state.room) { renderHome(); return; }
  if (state.room.status === 'lobby') { renderLobby(); return; }
  if (state.room.status === 'completed' || state.room.status === 'closed') { renderGameOver(); return; }
  renderGame();
}

async function runForm(form, errorId, callback) {
  const errorNode = errorId ? document.getElementById(errorId) : null;
  if (errorNode) errorNode.textContent = '';
  const button = form.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = 'Please wait…'; }
  try {
    await callback(new FormData(form));
  } catch (error) {
    const message = errorMessage(error);
    if (errorNode) errorNode.textContent = message;
    else showToast(message, 'error');
  } finally {
    if (button?.isConnected) { button.disabled = false; button.textContent = button.dataset.originalText || 'Submit'; }
  }
}

async function createRoom(event) {
  event.preventDefault();
  await runForm(event.currentTarget, 'create-error', async (formData) => {
    const name = normalizeName(formData.get('name'));
    if (!name || name.length > 20) throw new Error('Enter a name between 1 and 20 characters.');
    const rawTimer = formData.get('timer');
    await ensureGuest();
    const result = await rpc('create_room', {
      p_display_name: name,
      p_mode: formData.get('mode'),
      p_number_length: Number(formData.get('length')),
      p_turn_seconds: rawTimer === 'none' ? null : Number(rawTimer)
    });
    const snapshot = result?.room ? result : result?.state;
    if (snapshot?.room) setRoomState(snapshot);
    subscribeRoom();
  });
}

async function joinRoom(event) {
  event.preventDefault();
  await runForm(event.currentTarget, 'join-error', async (formData) => {
    const name = normalizeName(formData.get('name'));
    const code = String(formData.get('code') || '').trim().toUpperCase();
    if (!name || name.length > 20) throw new Error('Enter a name between 1 and 20 characters.');
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Room codes are six letters or numbers.');
    await ensureGuest();
    const result = await rpc('join_room', { p_room_code: code, p_display_name: name });
    const snapshot = result?.room ? result : result?.state;
    if (snapshot?.room) setRoomState(snapshot);
    subscribeRoom();
  });
}

async function submitSecret(event) {
  event.preventDefault();
  await runForm(event.currentTarget, 'secret-error', async (formData) => {
    const secret = String(formData.get('secret') || '');
    if (!validDigits(secret, state.room.number_length)) throw new Error(`Use exactly ${state.room.number_length} different digits. Leading zeroes are valid.`);
    await rpc('submit_duel_secret', { p_room_id: state.room.id, p_secret: secret });
    showToast('Your secret was stored privately.', 'success');
  });
}

async function submitGuess(event) {
  event.preventDefault();
  await runForm(event.currentTarget, 'guess-error', async (formData) => {
    const guess = String(formData.get('guess') || '');
    if (!validDigits(guess, state.room.number_length)) throw new Error(`Use exactly ${state.room.number_length} different digits.`);
    await rpc('submit_guess', { p_room_id: state.room.id, p_guess: guess, p_expected_turn_number: state.room.turn_number });
    showToast('Guess recorded. Only the counts are shown.', 'success');
  });
}

async function submitInstantWin(event) {
  event.preventDefault();
  await runForm(event.currentTarget, 'steal-error', async (formData) => {
    const guess = String(formData.get('guess') || '');
    if (!validDigits(guess, state.room.number_length)) throw new Error(`Use exactly ${state.room.number_length} different digits.`);
    const result = await rpc('try_instant_win', { p_room_id: state.room.id, p_guess: guess });
    if (result?.outcome === 'winner') showToast('Correct. You win the game.', 'success');
    else showToast('Wrong answer. You have been eliminated.', 'error');
  });
}

async function startRematch(event) {
  event.preventDefault();
  await runForm(event.currentTarget, 'rematch-error', async (formData) => {
    const rawTimer = formData.get('timer');
    await rpc('rematch_room', {
      p_room_id: state.room.id,
      p_number_length: Number(formData.get('length')),
      p_turn_seconds: rawTimer === 'none' ? null : Number(rawTimer)
    });
    showToast('Fresh match set up. Waiting for players to prepare.', 'success');
  });
}

async function handleAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'home') {
      if (state.room && supabase) await rpc('leave_room', { p_room_id: state.room.id }, false).catch(() => {});
      if (state.channel && supabase) await supabase.removeChannel(state.channel);
      clearRoom();
    } else if (action === 'copy-code') {
      await navigator.clipboard.writeText(state.room.code);
      showToast('Room code copied.', 'success');
    } else if (action === 'start-game') {
      button.disabled = true;
      await rpc('start_quizmaster_room', { p_room_id: state.room.id });
      showToast('The secret is set. First turn is live.', 'success');
    } else if (action === 'close-room') {
      if (!window.confirm('Close this lobby? Players will no longer be able to join.')) return;
      await rpc('close_room', { p_room_id: state.room.id });
    } else if (action === 'kick') {
      await rpc('kick_player', { p_room_id: state.room.id, p_target_user_id: button.dataset.user });
    }
  } catch (error) {
    showToast(errorMessage(error), 'error');
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

app.addEventListener('click', handleAction);

function updateTimerDisplay() {
  const room = state.room;
  if (!room) return;
  const value = document.querySelector('#timer-value');
  const caption = document.querySelector('#timer-caption');
  const box = document.querySelector('#timer-box');
  const progress = document.querySelector('#timer-progress');
  if (!value || !caption || !box) return;
  if (room.status === 'paused') {
    value.textContent = room.reconnect_deadline ? `${Math.max(0, Math.ceil((new Date(room.reconnect_deadline).getTime() - (Date.now() - state.serverOffsetMs)) / 1000))}` : '…';
    caption.textContent = 'RECONNECT';
    box.classList.remove('is-low');
    if (progress) progress.style.transform = 'scaleX(.2)';
    return;
  }
  if (!room.turn_seconds) {
    value.textContent = '∞';
    caption.textContent = 'FREE PLAY';
    box.classList.remove('is-low');
    if (progress) progress.style.transform = 'scaleX(1)';
    return;
  }
  if (!room.turn_deadline) {
    value.textContent = '—';
    caption.textContent = 'SECONDS';
    box.classList.remove('is-low');
    return;
  }
  const remaining = Math.max(0, (new Date(room.turn_deadline).getTime() - (Date.now() - state.serverOffsetMs)) / 1000);
  const rounded = Math.ceil(remaining);
  value.textContent = String(rounded);
  caption.textContent = rounded === 1 ? 'SECOND' : 'SECONDS';
  box.classList.toggle('is-low', rounded <= 5);
  if (progress) progress.style.transform = `scaleX(${Math.max(0, Math.min(1, remaining / room.turn_seconds))})`;
  if (remaining <= 0) {
    const key = `${room.id}:${room.turn_number}`;
    if (state.resolvingTurn !== key) {
      state.resolvingTurn = key;
      rpc('resolve_timeout', { p_room_id: room.id, p_expected_turn_number: room.turn_number })
        .catch((error) => showToast(errorMessage(error), 'error'))
        .finally(() => { if (state.resolvingTurn === key) state.resolvingTurn = null; });
    }
  }
}

async function boot() {
  if (!hasConfig) {
    setConnection('Preview mode');
    render();
    return;
  }
  setConnection('Supabase ready', 'connected');
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    state.userId = data.session?.user?.id || null;
    if (state.roomId && state.userId) {
      await loadRoom();
      subscribeRoom();
      return;
    }
  } catch (error) {
    localStorage.removeItem('di-room-id');
    state.roomId = null;
    setConnection('Supabase ready', 'connected');
    showToast(errorMessage(error), 'error');
  }
  render();
}

window.addEventListener('online', () => {
  if (state.roomId) loadRoom().then(subscribeRoom).catch(() => setConnection('Reconnecting…', 'error'));
});

boot();
