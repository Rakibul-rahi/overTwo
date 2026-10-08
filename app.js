// ═══════════════════════════════════════════════════════════════
// THE LAST TWO — FULL APP LOGIC
// Rules implemented:
// - Rank order: 3 < 4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2
// - Starter of every game = player holding A♠
// - Session can start with: single / pair / triplet / four of a kind
// - First play fixes pattern for the session
// - Next plays must use same pattern and equal or higher rank
// - Players may stop any time in a session
// - Stopped players rejoin next session
// - Last valid player starts the next session
// - Game ends when only one player remains with cards
// - After first game: winner takes best card from last-place player,
//   then gives one chosen card back, before the next deal
//
// MULTIPLAYER MODEL
// - One browser per room is the "host" (whoever created the room).
//   The host runs the exact same game engine as local play — it is
//   the single source of truth.
// - Every other seat is a "thin client": it renders whatever state
//   the host publishes, and forwards its own clicks back to the host
//   through a shared Supabase row (rooms.data).
// - Local (single-device) play never touches the network at all —
//   ROOM.online stays false and every helper below becomes a no-op.
// - Every client tracks itself on the channel's presence set. If the
//   host's presence entry disappears (tab closed, crash, dead wifi),
//   the lowest-seat surviving human promotes itself to host after a
//   short grace period and keeps the game moving (see "PRESENCE, HOST
//   MIGRATION & RECONNECT" below).
// - Any seat (host or not) that refreshes or briefly drops rejoins its
//   same seat automatically via the room code saved in localStorage.
// ═══════════════════════════════════════════════════════════════

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♠', '♥', '♦', '♣'];
const RANK_ORDER = Object.fromEntries(RANKS.map((r, i) => [r, i]));
const IS_RED = { '♥': true, '♦': true, '♠': false, '♣': false };

const DEAL_MAP = {
  3: 16,
  4: 13,
  5: 8,
  6: 8
};

// suit order only for deterministic sorting
const SUIT_ORDER = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };

// Drop matching GIF files at these paths (relative to index.html) to replace
// the emoji on the end-screen headline — e.g. assets/winner.gif for the
// রাজা result. Any path that doesn't resolve to a real file just falls back
// to the emoji, so this is safe to leave as-is until you add real GIFs.
const TROPHY_GIFS = {
  winner: 'assets/winner.gif',
  loser: 'assets/loser.gif',
  neutral: 'assets/neutral.gif'
};

const BOT_NAMES = ['Ace Bot', 'Nova', 'Jax', 'Miso', 'Rook', 'Vega'];

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
let G = {};
let selectedCount = 4;
let onlineSelectedCount = 4;
let aiTimer = null;
let turnTimer = null;
let toastTimer = null;
let exchangeModalData = null;

const TURN_SECONDS = 30;
let lastPlaySignature = null;
let lastKnownCurrentPlayer = null;

// persists between games within a single match
let MATCH = {
  names: [],
  gameCount: 0,
  pendingExchange: null // { winnerIdx, loserIdx, freshHands, bestLoserCard }
};

// persists across the whole life of an online room (or stays inert for local play)
let ROOM = {
  online: false,
  isHost: true,
  myIdx: 0,
  code: null,
  seats: [],
  channel: null,
  hostClientId: null
};

function getClientId() {
  try {
    let id = localStorage.getItem('ltt_client_id');
    if (!id) {
      id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('ltt_client_id', id);
    }
    return id;
  } catch {
    return 'c_' + Math.random().toString(36).slice(2);
  }
}

const MY_CLIENT_ID = getClientId();

const AVATAR_EMOJIS = [
  '🐯', '🦊', '🐸', '🐵', '🐼', '🐨', '🦁', '🐮',
  '🐷', '🐰', '🦄', '🐙', '🐧', '🦉', '🐺', '🐻',
  '🐔', '🐗', '🦒', '🐳', '🐬', '🦋', '🐝', '🐢'
];

let createSelectedAvatar = AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)];
let joinSelectedAvatar = AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)];

let chatMessages = [];

// ═══════════════════════════════════════════════════════════════
// SETUP UI — MODE / LOCAL / ONLINE TABS
// ═══════════════════════════════════════════════════════════════
document.querySelectorAll('#mode-tabs .mode-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#mode-tabs .mode-tab').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const mode = btn.dataset.mode;
    document.getElementById('local-setup-card').style.display = mode === 'local' ? '' : 'none';
    document.getElementById('online-setup-card').style.display = mode === 'online' ? '' : 'none';
  });
});

document.querySelectorAll('#online-tabs .online-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#online-tabs .online-tab').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const tab = btn.dataset.onlineTab;
    document.getElementById('create-room-panel').style.display = tab === 'create' ? '' : 'none';
    document.getElementById('join-room-panel').style.display = tab === 'join' ? '' : 'none';
  });
});

document.querySelectorAll('.player-count-selector .count-btn').forEach(btn => {
  const isOnlineSelector = btn.closest('#online-count-selector');
  btn.addEventListener('click', () => {
    const group = isOnlineSelector ? '#online-count-selector' : '#player-names-container';
    if (isOnlineSelector) {
      onlineSelectedCount = Number(btn.dataset.count);
      document.querySelectorAll('#online-count-selector .count-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    } else {
      selectedCount = Number(btn.dataset.count);
      document.querySelectorAll('#local-setup-card .count-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      renderNameInputs();
    }
  });
});

function renderNameInputs() {
  const container = document.getElementById('player-names-container');
  if (!container) return;

  const oldValues = [];
  for (let i = 0; i < 6; i++) {
    const old = document.getElementById(`name-${i}`);
    oldValues[i] = old ? old.value.trim() : '';
  }

  container.innerHTML = '';

  for (let i = 0; i < selectedCount; i++) {
    const isYou = i === 0;
    const value = oldValues[i] || (isYou ? 'You' : `Player ${i + 1}`);

    const row = document.createElement('div');
    row.className = 'name-input-row';
    row.innerHTML = `
      <label>
        Player ${i + 1}${isYou ? ' <span class="you-badge">YOU</span>' : ''}
      </label>
      <input id="name-${i}" value="${escapeHtml(value)}" placeholder="Name">
    `;
    container.appendChild(row);
  }
}

document.getElementById('start-btn')?.addEventListener('click', () => {
  const names = [];
  for (let i = 0; i < selectedCount; i++) {
    const value = (document.getElementById(`name-${i}`)?.value || '').trim();
    names.push(value || (i === 0 ? 'You' : `Player ${i + 1}`));
  }

  MATCH.names = names;
  MATCH.gameCount = 0;
  MATCH.pendingExchange = null;

  startLocalGame();
});

document.getElementById('create-room-btn')?.addEventListener('click', () => {
  const name = (document.getElementById('create-name-input')?.value || '').trim() || 'Host';
  createRoom(name, onlineSelectedCount, createSelectedAvatar);
});

document.getElementById('join-room-btn')?.addEventListener('click', () => {
  const name = (document.getElementById('join-name-input')?.value || '').trim() || 'Player';
  const code = (document.getElementById('join-code-input')?.value || '').trim();
  if (!code) { showToast('Enter a room code.'); return; }
  joinRoom(name, code, joinSelectedAvatar);
});

document.getElementById('lobby-start-btn')?.addEventListener('click', hostStartGameClick);
document.getElementById('lobby-leave-btn')?.addEventListener('click', leaveRoom);

function renderAvatarPicker(containerId, selected, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.innerHTML = AVATAR_EMOJIS.map(emoji => `
    <div class="avatar-option ${emoji === selected ? 'selected' : ''}" data-emoji="${emoji}">${emoji}</div>
  `).join('');

  el.querySelectorAll('.avatar-option').forEach(opt => {
    opt.addEventListener('click', () => {
      onSelect(opt.dataset.emoji);
      renderAvatarPicker(containerId, opt.dataset.emoji, onSelect);
    });
  });
}

renderAvatarPicker('create-avatar-picker', createSelectedAvatar, (emoji) => { createSelectedAvatar = emoji; });
renderAvatarPicker('join-avatar-picker', joinSelectedAvatar, (emoji) => { joinSelectedAvatar = emoji; });

renderNameInputs();

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clearAITimer() {
  if (aiTimer) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  clearTurnTimer();
}

// ═══════════════════════════════════════════════════════════════
// SOUND EFFECTS — synthesized with the Web Audio API, no audio
// files to host. Browsers require a user gesture before audio can
// play; that's already satisfied by the buttons the player clicks
// to get into a game.
// ═══════════════════════════════════════════════════════════════
let audioCtx = null;

function getAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch {
    return null;
  }
}

function playTone(freq, duration, type, gainPeak, delay) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + (delay || 0);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(gainPeak || 0.15, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function playCardSound() {
  playTone(220, 0.08, 'square', 0.12, 0);
  playTone(140, 0.07, 'square', 0.09, 0.02);
}

function playYourTurnSound() {
  playTone(660, 0.12, 'sine', 0.16, 0);
  playTone(880, 0.16, 'sine', 0.16, 0.12);
}

function maybePlayYourTurnSound() {
  const myIdx = myIndex();
  const isMyTurnNow = !G.gameOver && G.currentPlayer === myIdx && !G.finished[myIdx] && !G.stopped[myIdx];
  if (isMyTurnNow && lastKnownCurrentPlayer !== G.currentPlayer) {
    playYourTurnSound();
  }
  lastKnownCurrentPlayer = G.currentPlayer;
}

// ═══════════════════════════════════════════════════════════════
// TURN TIMER RING — a lightweight tick loop that only ever updates
// the CSS variable driving whichever ring is currently marked
// .is-current, independent of the (much less frequent) full re-renders.
// ═══════════════════════════════════════════════════════════════
setInterval(() => {
  const ring = document.querySelector('.turn-ring.is-current');
  if (!ring || !G || !G.turnStartedAt || G.gameOver) return;
  const elapsed = (Date.now() - G.turnStartedAt) / 1000;
  const pct = Math.max(0, Math.min(100, 100 - (elapsed / TURN_SECONDS) * 100));
  ring.style.setProperty('--pct', pct.toFixed(1));
}, 150);

function clearTurnTimer() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
}

function cardKey(card) {
  return `${card.rank}${card.suit}`;
}

function compareCards(a, b) {
  const rankDiff = RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
  if (rankDiff !== 0) return rankDiff;
  return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
}

function sortHand(hand) {
  return [...hand].sort(compareCards);
}

function cloneCard(card) {
  return { rank: card.rank, suit: card.suit };
}

function sameCard(a, b) {
  return a.rank === b.rank && a.suit === b.suit;
}

function sameRankSet(cards) {
  return cards.length > 0 && cards.every(c => c.rank === cards[0].rank);
}

function getRankValue(cardOrRank) {
  return typeof cardOrRank === 'string' ? RANK_ORDER[cardOrRank] : RANK_ORDER[cardOrRank.rank];
}

function highestCard(hand) {
  if (!hand.length) return null;
  return [...hand].sort((a, b) => compareCards(b, a))[0];
}

function lowestCard(hand) {
  if (!hand.length) return null;
  return [...hand].sort(compareCards)[0];
}

function groupByRank(hand) {
  const map = {};
  for (const card of hand) {
    if (!map[card.rank]) map[card.rank] = [];
    map[card.rank].push(card);
  }
  for (const rank of Object.keys(map)) {
    map[rank] = sortHand(map[rank]);
  }
  return map;
}

// ── seat / network helpers ──
function isOnline() {
  return ROOM.online === true;
}

function amHost() {
  return !isOnline() || ROOM.isHost === true;
}

function myIndex() {
  return isOnline() ? ROOM.myIdx : 0;
}

function isBotSeat(idx) {
  return !!(G.seats && G.seats[idx] && G.seats[idx].isBot);
}

function avatarColor(name) {
  let hash = 0;
  const str = String(name || '?');
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 62%)`;
}

function avatarInitial(name) {
  return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

function getAvatarDisplay(seat) {
  if (!seat) return { content: '?', bg: avatarColor('?') };
  if (seat.isBot) return { content: '🤖', bg: avatarColor(seat.name) };
  if (seat.avatar) return { content: seat.avatar, bg: 'rgba(255,255,255,0.08)' };
  return { content: avatarInitial(seat.name), bg: avatarColor(seat.name) };
}

function activeInSession(playerIdx) {
  return !G.finished[playerIdx] && !G.stopped[playerIdx];
}

function playersStillHoldingCards() {
  const arr = [];
  for (let i = 0; i < G.playerCount; i++) {
    if (!G.finished[i]) arr.push(i);
  }
  return arr;
}

function nextAlivePlayer(fromIdx) {
  let idx = fromIdx;
  for (let i = 0; i < G.playerCount; i++) {
    idx = (idx + 1) % G.playerCount;
    if (!G.finished[idx]) return idx;
  }
  return fromIdx;
}

function removeCardsFromHand(playerIdx, cards) {
  for (const card of cards) {
    const pos = G.hands[playerIdx].findIndex(h => sameCard(h, card));
    if (pos >= 0) G.hands[playerIdx].splice(pos, 1);
  }
  G.hands[playerIdx] = sortHand(G.hands[playerIdx]);
}

function removeSpecificCardFromArray(arr, card) {
  const idx = arr.findIndex(c => sameCard(c, card));
  if (idx >= 0) arr.splice(idx, 1);
}

function canPlaySetAgainst(cards, pattern, lastPlayed) {
  if (!Array.isArray(cards) || cards.length === 0) return false;
  if (cards.length !== pattern) return false;
  if (!sameRankSet(cards)) return false;
  if (!lastPlayed || lastPlayed.length === 0) return true;

  const newRank = getRankValue(cards[0]);
  const lastRank = getRankValue(lastPlayed[0]);
  return newRank >= lastRank; // equal or higher as per your rule
}

function getAllPlayableSets(hand, pattern, lastPlayed) {
  const results = [];
  const groups = groupByRank(hand);

  if (pattern === 1) {
    for (const card of sortHand(hand)) {
      if (canPlaySetAgainst([card], 1, lastPlayed)) {
        results.push([card]);
      }
    }
    return results;
  }

  if (pattern >= 2 && pattern <= 4) {
    for (const rank of RANKS) {
      const group = groups[rank] || [];
      if (group.length >= pattern) {
        const set = group.slice(0, pattern);
        if (canPlaySetAgainst(set, pattern, lastPlayed)) {
          results.push(set);
        }
      }
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// DECK / DEAL
// ═══════════════════════════════════════════════════════════════
function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function deal(playerCount) {
  const cardsPerPlayer = DEAL_MAP[playerCount];
  const totalNeeded = cardsPerPlayer * playerCount;
  let deck = makeDeck();

  // Remove full ranks from lowest upward until divisible/needed
  while (deck.length > totalNeeded) {
    const removableRank = RANKS.find(rank => {
      const count = deck.filter(c => c.rank === rank).length;
      return count === 4 && rank !== 'A'; // keep A♠ rule safer
    });

    if (!removableRank) break;
    deck = deck.filter(c => c.rank !== removableRank);
  }

  deck = shuffle(deck);

  // Deal one card at a time in rotation, like a real dealer, rather than
  // handing out pre-sliced blocks of the shuffled deck.
  const rawHands = Array.from({ length: playerCount }, () => []);
  for (let i = 0; i < deck.length; i++) {
    rawHands[i % playerCount].push(deck[i]);
  }

  return rawHands.map(sortHand);
}

function findStarterFirstGame(hands) {
  for (let i = 0; i < hands.length; i++) {
    const hasASpade = hands[i].some(c => c.rank === 'A' && c.suit === '♠');
    if (hasASpade) return i;
  }
  return 0;
}

// 1st place scores (playerCount - 2), one less per rank down, last place
// always -1 no matter how many people are playing.
function pointsForRank(rankIndex, playerCount) {
  return (playerCount - 2) - rankIndex;
}

// ═══════════════════════════════════════════════════════════════
// GAME START (shared by local play, online host, and post-exchange)
// ═══════════════════════════════════════════════════════════════
function initGameState(hands, starterIdx, seats) {
  clearAITimer();

  const playerCount = seats.length;

  G = {
    names: seats.map(s => s.name),
    seats,
    playerCount,
    hands,
    currentPlayer: starterIdx,
    turnStartedAt: Date.now(),

    session: 1,
    pattern: null,           // null | 1 | 2 | 3
    lastPlayed: null,        // array of cards
    lastPlayedBy: null,

    stopped: new Array(playerCount).fill(false),
    finished: new Array(playerCount).fill(false),
    finishOrder: [],

    selectedCards: [],
    gameOver: false,
    winnerIdx: null,
    loserIdx: null
  };

  MATCH.gameCount += 1;
  lastPlaySignature = null;
  lastKnownCurrentPlayer = null;

  showScreen('game-screen');
  clearLog();
  addLog(`Game #${MATCH.gameCount} started.`);
  addLog(`<span class="log-player">${escapeHtml(G.names[starterIdx])}</span> starts this game.`);

  renderGame();
  advanceTurn();
}

function advanceTurn() {
  const seat = G.currentPlayer;
  if (isBotSeat(seat)) {
    if (amHost()) scheduleAI();
  } else if (seat === myIndex()) {
    renderTurnHint();
  }
  // otherwise it's another human's turn — nothing to do locally, wait for state push

  if (amHost()) scheduleTurnTimeout(seat);
}

// Host-enforced turn clock — whoever is up (bot, host, or a remote human)
// gets TURN_SECONDS before they're auto-stopped. Only the host schedules
// this, matching how only the host ever drives the game engine.
function scheduleTurnTimeout(seat) {
  clearTurnTimer();
  if (G.gameOver) return;

  turnTimer = setTimeout(() => {
    turnTimer = null;
    if (G.gameOver) return;
    if (G.currentPlayer !== seat) return;
    if (G.finished[seat] || G.stopped[seat]) return;
    stopPlayer(seat);
  }, TURN_SECONDS * 1000);
}

function startLocalGame() {
  if (ROOM.channel && hasSupabase()) {
    supabaseClient.removeChannel(ROOM.channel);
  }
  ROOM = { online: false, isHost: true, myIdx: 0, code: null, seats: [], channel: null, hostClientId: null };
  chatMessages = [];
  setChatVisible(false);

  const names = [...MATCH.names];
  const seats = names.map((n, i) => ({
    clientId: i === 0 ? MY_CLIENT_ID : `bot_${i}`,
    name: n,
    isBot: i !== 0
  }));

  MATCH.lastWinnerIdx = null;
  MATCH.lastLoserIdx = null;
  MATCH.loseStreak = new Array(names.length).fill(0);
  MATCH.scores = new Array(names.length).fill(0);

  const hands = deal(names.length);
  const starterIdx = findStarterFirstGame(hands);

  initGameState(hands, starterIdx, seats);
}

// ═══════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function renderGame() {
  renderInfoPills();
  renderOpponents();
  renderTable();
  renderPlayerHand();
  updateButtons();
  maybePlayYourTurnSound();
  pushRoomState();
}

function renderInfoPills() {
  const sessionPill = document.getElementById('session-pill');
  const patternPill = document.getElementById('pattern-pill');
  const turnPill = document.getElementById('turn-pill');

  if (sessionPill) sessionPill.textContent = `Session ${G.session}`;

  if (patternPill) {
    if (G.pattern === null) patternPill.textContent = 'No pattern';
    if (G.pattern === 1) patternPill.textContent = '♟ Singles';
    if (G.pattern === 2) patternPill.textContent = '⚡ Pairs';
    if (G.pattern === 3) patternPill.textContent = '🔥 Triplets';
    if (G.pattern === 4) patternPill.textContent = '💎 Quads';
  }

  if (turnPill) {
    turnPill.textContent = G.gameOver ? 'Game over' : `${G.names[G.currentPlayer]}'s turn`;
  }
}

// Seat positions around the oval rail, keyed by opponent count (2-5).
// "You" always sits at the bottom-center, so these only cover the rest.
const OPPONENT_LAYOUTS = {
  2: [{ top: '8%', left: '30%' }, { top: '8%', left: '70%' }],
  3: [{ top: '4%', left: '18%' }, { top: '0%', left: '50%' }, { top: '4%', left: '82%' }],
  4: [{ top: '50%', left: '12%' }, { top: '4%', left: '32%' }, { top: '4%', left: '68%' }, { top: '50%', left: '88%' }],
  5: [{ top: '55%', left: '12%' }, { top: '4%', left: '18%' }, { top: '0%', left: '50%' }, { top: '4%', left: '82%' }, { top: '55%', left: '88%' }]
};

function turnRingPercent(idx) {
  if (G.gameOver || G.currentPlayer !== idx || !G.turnStartedAt) return null;
  const elapsed = (Date.now() - G.turnStartedAt) / 1000;
  return Math.max(0, Math.min(100, 100 - (elapsed / TURN_SECONDS) * 100)).toFixed(1);
}

function getMatchBadgeInfo(idx) {
  if (MATCH.lastWinnerIdx === idx) {
    return { cls: '', content: '👑', title: "Last game's রাজা" };
  }
  if (MATCH.lastLoserIdx === idx) {
    const streak = (MATCH.loseStreak && MATCH.loseStreak[idx]) || 0;
    // Bananas keep stacking for every consecutive loss, capped so the
    // badge doesn't run off the avatar, until the streak breaks (they
    // stop being last place and it resets back to zero).
    const bananaCount = Math.min(Math.max(streak, 1), 5);
    const bananas = '🍌'.repeat(bananaCount) + (streak > 5 ? `×${streak}` : '');
    if (streak >= 3) {
      return { cls: 'cold-streak', content: `${bananas}🥶`, title: `On a ${streak}-game losing streak as প্রজা` };
    }
    return { cls: '', content: bananas, title: "Last game's প্রজা" };
  }
  return null;
}

function matchBadgeHtml(idx) {
  const info = getMatchBadgeInfo(idx);
  if (!info) return '';
  return `<div class="match-badge ${info.cls}" title="${escapeHtml(info.title)}">${info.content}</div>`;
}

function renderOpponents() {
  const area = document.getElementById('opponents-area');
  if (!area) return;

  area.innerHTML = '';

  const myIdx = myIndex();
  const order = [];
  for (let i = 1; i < G.playerCount; i++) {
    order.push((myIdx + i) % G.playerCount);
  }

  const layout = OPPONENT_LAYOUTS[order.length] || OPPONENT_LAYOUTS[5];

  order.forEach((i, slotIdx) => {
    const pos = layout[slotIdx] || { top: '8%', left: '50%' };
    const panel = document.createElement('div');
    panel.className = [
      'opponent-panel',
      G.currentPlayer === i ? 'is-turn' : '',
      G.stopped[i] ? 'stopped' : '',
      G.finished[i] ? 'finished' : ''
    ].filter(Boolean).join(' ');
    panel.style.top = pos.top;
    panel.style.left = pos.left;

    const cardCount = G.hands[i].length;
    const fanCount = Math.min(cardCount, 6);
    const av = getAvatarDisplay(G.seats[i]);
    const ringPct = turnRingPercent(i);

    panel.innerHTML = `
      ${G.currentPlayer === i ? '<div class="turn-indicator">Playing</div>' : ''}
      <div class="opp-name">
        <span class="avatar-wrap">
          <span class="turn-ring ${ringPct !== null ? 'is-current' : ''}" style="${ringPct !== null ? `--pct:${ringPct}` : ''}"></span>
          <span class="mini-avatar" style="background:${av.bg}">${av.content}</span>
          ${matchBadgeHtml(i)}
        </span>
        ${escapeHtml(G.names[i])}
      </div>
      <div class="opp-card-fan">${G.finished[i] ? '' : Array.from({ length: fanCount }).map(() => '<div class="fan-card"></div>').join('')}</div>
      <div class="opp-card-count">${cardCount}</div>
      <div class="opp-status">
        ${
          G.finished[i] ? '✓ Finished'
          : G.stopped[i] ? 'Stopped'
          : G.currentPlayer === i ? '<span class="thinking"><span></span><span></span><span></span></span>'
          : 'cards'
        }
      </div>
    `;

    area.appendChild(panel);
  });
}

function renderTable() {
  const display = document.getElementById('played-cards-display');
  const label = document.getElementById('table-label');
  if (!display || !label) return;

  if (!G.lastPlayed || G.lastPlayed.length === 0) {
    label.textContent = 'Waiting for first play';
    display.innerHTML = `<div class="table-message">No cards played yet</div>`;
    lastPlaySignature = null;
    return;
  }

  const sig = `${G.session}:${G.lastPlayedBy}:${G.lastPlayed.map(cardKey).join(',')}`;
  if (sig !== lastPlaySignature) {
    playCardSound();
  }
  lastPlaySignature = sig;

  label.textContent = `${G.names[G.lastPlayedBy]} played`;
  display.innerHTML = G.lastPlayed.map(renderMiniCard).join('');
}

function renderMiniCard(card) {
  const redClass = IS_RED[card.suit] ? 'red-card' : 'black-card';
  return `
    <div class="mini-card ${redClass}">
      <div class="card-corner card-corner-top">${card.rank}<br>${card.suit}</div>
      <div class="card-suit-center">${card.suit}</div>
      <div class="card-corner card-corner-bottom">${card.rank}<br>${card.suit}</div>
    </div>
  `;
}

function renderCard(card, selected, clickable, inModal = false, dull = false) {
  const redClass = IS_RED[card.suit] ? 'red-card' : 'black-card';
  const className = `${inModal ? 'card exchange-card' : 'card'} ${redClass} ${selected ? 'selected' : ''} ${dull ? 'card-dull' : ''}`.trim();

  if (clickable) {
    return `
      <div class="${className}" data-rank="${card.rank}" data-suit="${card.suit}">
        <div class="card-corner card-corner-top">${card.rank}<br>${card.suit}</div>
        <div class="card-suit-center">${card.suit}</div>
        <div class="card-corner card-corner-bottom">${card.rank}<br>${card.suit}</div>
      </div>
    `;
  }

  return `
    <div class="${className}">
      <div class="card-corner card-corner-top">${card.rank}<br>${card.suit}</div>
      <div class="card-suit-center">${card.suit}</div>
      <div class="card-corner card-corner-bottom">${card.rank}<br>${card.suit}</div>
    </div>
  `;
}

function renderPlayerHand() {
  const yourName = document.getElementById('your-name');
  const yourCardCount = document.getElementById('your-card-count');
  const yourAvatar = document.getElementById('your-avatar');
  const handEl = document.getElementById('player-hand');

  if (!yourName || !yourCardCount || !handEl) return;

  const myIdx = myIndex();
  const myTurn = G.currentPlayer === myIdx && !G.finished[myIdx] && !G.stopped[myIdx] && !G.gameOver;

  yourName.textContent = myTurn ? `${G.names[myIdx]} — Your Turn` : G.names[myIdx];
  yourCardCount.textContent = `${G.hands[myIdx].length} card${G.hands[myIdx].length === 1 ? '' : 's'}`;

  if (yourAvatar) {
    const av = getAvatarDisplay(G.seats[myIdx]);
    yourAvatar.textContent = av.content;
    yourAvatar.style.background = av.bg;
  }

  const yourRing = document.getElementById('your-turn-ring');
  if (yourRing) {
    const ringPct = turnRingPercent(myIdx);
    if (ringPct !== null) {
      yourRing.classList.add('is-current');
      yourRing.style.setProperty('--pct', ringPct);
    } else {
      yourRing.classList.remove('is-current');
    }
  }

  const yourBadge = document.getElementById('your-match-badge');
  if (yourBadge) {
    const info = getMatchBadgeInfo(myIdx);
    if (info) {
      yourBadge.className = `match-badge ${info.cls}`;
      yourBadge.title = info.title;
      yourBadge.textContent = info.content;
      yourBadge.style.display = '';
    } else {
      yourBadge.style.display = 'none';
    }
  }

  if (G.hands[myIdx].length === 0) {
    handEl.innerHTML = `<span style="color:var(--green);font-size:0.8rem;">All cards played! 🎉</span>`;
    renderTurnHint();
    return;
  }

  // Once a pattern is locked in for the session, dim whichever cards can't
  // currently form a legal response so the ones that can stand out —
  // e.g. after a pair is played, lone singles dull while any pair (or
  // higher pair) still in hand stays vibrant.
  let playableKeys = null;
  if (G.pattern !== null) {
    playableKeys = new Set();
    getAllPlayableSets(G.hands[myIdx], G.pattern, G.lastPlayed).forEach(set => {
      set.forEach(c => playableKeys.add(cardKey(c)));
    });
  }

  handEl.innerHTML = sortHand(G.hands[myIdx]).map(card => {
    const selected = G.selectedCards.some(c => sameCard(c, card));
    const dull = playableKeys !== null && !playableKeys.has(cardKey(card));
    return renderCard(card, selected, myTurn, false, dull);
  }).join('');

  if (myTurn) {
    handEl.querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => {
        toggleCard(el.dataset.rank, el.dataset.suit);
      });
    });
  }

  renderTurnHint();
}

function renderTurnHint() {
  const hint = document.getElementById('play-hint');
  if (!hint) return;

  const myIdx = myIndex();

  if (G.gameOver) {
    hint.textContent = 'Game finished.';
    return;
  }

  if (G.finished[myIdx]) {
    hint.textContent = 'You have finished your cards.';
    return;
  }

  if (G.stopped[myIdx]) {
    hint.textContent = 'You stopped in this session. Wait for the next session.';
    return;
  }

  if (G.currentPlayer !== myIdx) {
    hint.textContent = `Waiting for ${G.names[G.currentPlayer]}...`;
    return;
  }

  if (G.pattern === null) {
    hint.textContent = 'Start the session with 1 card, a pair, 3 of a kind, or 4 of a kind.';
    return;
  }

  const typeText = G.pattern === 1 ? 'single' : G.pattern === 2 ? 'pair' : G.pattern === 3 ? 'three of a kind' : 'four of a kind';
  const minRank = G.lastPlayed ? G.lastPlayed[0].rank : null;

  if (minRank) {
    hint.textContent = `Play a ${typeText} of ${minRank} or higher, or Stop.`;
  } else {
    hint.textContent = `Play a ${typeText}, or Stop.`;
  }
}

function updateButtons() {
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  if (!playBtn || !stopBtn) return;

  const myIdx = myIndex();
  const myTurn = G.currentPlayer === myIdx && !G.finished[myIdx] && !G.stopped[myIdx] && !G.gameOver;

  if (!myTurn) {
    playBtn.disabled = true;
    stopBtn.disabled = true;
    return;
  }

  stopBtn.disabled = false;

  const selected = [...G.selectedCards];
  let valid = false;

  if (selected.length > 0) {
    if (G.pattern === null) {
      valid = selected.length >= 1 && selected.length <= 4 && sameRankSet(selected);
    } else {
      valid = canPlaySetAgainst(selected, G.pattern, G.lastPlayed);
    }
  }

  playBtn.disabled = !valid;
}

// ═══════════════════════════════════════════════════════════════
// PLAYER ACTIONS
// ═══════════════════════════════════════════════════════════════
function toggleCard(rank, suit) {
  if (G.gameOver) return;
  const myIdx = myIndex();
  if (G.currentPlayer !== myIdx) return;
  if (G.finished[myIdx] || G.stopped[myIdx]) return;

  const card = { rank, suit };
  const idx = G.selectedCards.findIndex(c => sameCard(c, card));

  if (idx >= 0) {
    G.selectedCards.splice(idx, 1);
  } else {
    G.selectedCards.push(card);
    G.selectedCards = sortHand(G.selectedCards);
  }

  renderPlayerHand();
  updateButtons();
}

function playerPlay() {
  if (G.gameOver) return;
  const myIdx = myIndex();
  if (G.currentPlayer !== myIdx) return;
  if (G.finished[myIdx] || G.stopped[myIdx]) return;

  const selected = [...G.selectedCards];
  if (selected.length === 0) {
    showToast('Select card(s) first.');
    return;
  }

  if (G.pattern === null) {
    if (!(selected.length >= 1 && selected.length <= 4 && sameRankSet(selected))) {
      showToast('Start with 1, 2, 3, or 4 cards of the same rank.');
      return;
    }
  } else {
    if (!canPlaySetAgainst(selected, G.pattern, G.lastPlayed)) {
      showToast('Invalid play for this session.');
      return;
    }
  }

  commitPlay(selected);
}

function playerStop() {
  if (G.gameOver) return;
  const myIdx = myIndex();
  if (G.currentPlayer !== myIdx) return;
  if (G.finished[myIdx] || G.stopped[myIdx]) return;

  commitStop();
}

// make them global for inline HTML onclick
window.playerPlay = playerPlay;
window.playerStop = playerStop;

function commitPlay(cards) {
  if (amHost()) {
    if (G.pattern === null) G.pattern = cards.length;
    playCards(myIndex(), cards);
  } else {
    sendPendingMove({ seatIdx: myIndex(), type: 'play', cards });
    showToast('Move sent...');
  }
}

function commitStop() {
  if (amHost()) {
    stopPlayer(myIndex());
  } else {
    sendPendingMove({ seatIdx: myIndex(), type: 'stop' });
    showToast('Stop sent...');
  }
}

// ═══════════════════════════════════════════════════════════════
// CORE GAME LOGIC (host-only — non-host clients never call these)
// ═══════════════════════════════════════════════════════════════
function playCards(playerIdx, cards) {
  clearAITimer();

  const playedCards = sortHand(cards.map(cloneCard));

  removeCardsFromHand(playerIdx, playedCards);

  G.lastPlayed = playedCards;
  G.lastPlayedBy = playerIdx;
  G.selectedCards = [];

  addLog(
    `<span class="log-player">${escapeHtml(G.names[playerIdx])}</span> ` +
    `<span class="log-action">played ${playedCards.map(c => `${c.rank}${c.suit}`).join(' ')}</span>`
  );

  if (G.hands[playerIdx].length === 0 && !G.finished[playerIdx]) {
    G.finished[playerIdx] = true;
    G.finishOrder.push(playerIdx);

    addLog(
      `<span class="log-player">${escapeHtml(G.names[playerIdx])}</span> ` +
      `<span class="log-win">finished all cards!</span>`
    );
  }

  renderGame();

  // If only one player remains with cards, game ends
  const alive = playersStillHoldingCards();
  if (alive.length <= 1) {
    if (alive.length === 1 && !G.finishOrder.includes(alive[0])) {
      G.finishOrder.push(alive[0]);
    }
    endGame();
    return;
  }

  nextTurnAfterAction(playerIdx);
}

function stopPlayer(playerIdx) {
  clearAITimer();

  G.stopped[playerIdx] = true;
  G.selectedCards = [];

  addLog(
    `<span class="log-player">${escapeHtml(G.names[playerIdx])}</span> ` +
    `<span class="log-stop">stopped this session</span>`
  );

  renderGame();

  const active = [];
  for (let i = 0; i < G.playerCount; i++) {
    if (activeInSession(i)) active.push(i);
  }

  if (active.length === 0) {
    // everyone who still had cards stopped; last valid play wins session
    startNewSession(G.lastPlayedBy);
    return;
  }

  nextTurnAfterAction(playerIdx);
}

function nextTurnAfterAction(fromIdx) {
  let next = fromIdx;

  for (let i = 0; i < G.playerCount; i++) {
    next = (next + 1) % G.playerCount;
    if (!activeInSession(next)) continue;

    // A pattern is already locked in and this seat holds nothing that can
    // legally beat it — there's no decision for them to make, so skip them
    // outright instead of making everyone wait through their turn clock for
    // a forced Stop. Anyone who genuinely does have a choice still gets to
    // make it normally, below.
    if (G.pattern !== null && getAllPlayableSets(G.hands[next], G.pattern, G.lastPlayed).length === 0) {
      G.stopped[next] = true;
      addLog(`<span class="log-player">${escapeHtml(G.names[next])}</span> <span class="log-stop">has no valid play and is skipped</span>`);
      continue;
    }

    G.currentPlayer = next;
    G.turnStartedAt = Date.now();
    renderGame();
    advanceTurn();
    return;
  }

  // no one active -> new session
  startNewSession(G.lastPlayedBy);
}

function startNewSession(starterIdx) {
  clearAITimer();

  if (starterIdx === null || starterIdx === undefined || G.finished[starterIdx]) {
    starterIdx = nextAlivePlayer(starterIdx ?? 0);
  }

  addLog(
    `<span class="log-win">Session ${G.session} won by <span class="log-player">${escapeHtml(G.names[starterIdx])}</span>!</span>`
  );

  G.session += 1;
  G.pattern = null;
  G.lastPlayed = null;
  G.lastPlayedBy = null;
  G.selectedCards = [];
  G.stopped = G.stopped.map(() => false);
  G.currentPlayer = starterIdx;
  G.turnStartedAt = Date.now();

  addLog(`--- Session ${G.session} started. <span class="log-player">${escapeHtml(G.names[G.currentPlayer])}</span> to play first. ---`);

  renderGame();
  advanceTurn();
}

// ═══════════════════════════════════════════════════════════════
// AI
// ═══════════════════════════════════════════════════════════════
function scheduleAI() {
  clearAITimer();
  aiTimer = setTimeout(aiPlay, 700 + Math.random() * 500);
}

function aiPlay() {
  aiTimer = null;
  if (!amHost()) return;
  if (G.gameOver) return;

  const idx = G.currentPlayer;
  if (!isBotSeat(idx)) return;
  if (G.finished[idx] || G.stopped[idx]) return;

  const hand = G.hands[idx];
  let move = null;

  if (G.pattern === null) {
    move = chooseAIOpeningMove(hand);
  } else {
    move = chooseAIResponseMove(hand, G.pattern, G.lastPlayed);
  }

  if (move) {
    if (G.pattern === null) G.pattern = move.length;
    playCards(idx, move);
  } else {
    stopPlayer(idx);
  }
}

function chooseAIOpeningMove(hand) {
  const groups = groupByRank(hand);

  // Strategy:
  // 1) lowest single
  // 2) lowest pair if useful
  // 3) lowest triplet if useful
  // 4) lowest quad, rarely (it's a strong hand to spend early)
  // To keep game moving, AI slightly prefers singles.

  const allSingles = sortHand(hand).map(c => [c]);
  const allPairs = [];
  const allTrips = [];
  const allQuads = [];

  for (const rank of RANKS) {
    const group = groups[rank] || [];
    if (group.length >= 2) allPairs.push(group.slice(0, 2));
    if (group.length >= 3) allTrips.push(group.slice(0, 3));
    if (group.length >= 4) allQuads.push(group.slice(0, 4));
  }

  const randomChoice = Math.random();

  if (allPairs.length > 0 && randomChoice > 0.68) return allPairs[0];
  if (allTrips.length > 0 && randomChoice > 0.88) return allTrips[0];
  if (allQuads.length > 0 && randomChoice > 0.96) return allQuads[0];
  return allSingles[0] || null;
}

function chooseAIResponseMove(hand, pattern, lastPlayed) {
  const sets = getAllPlayableSets(hand, pattern, lastPlayed);
  if (sets.length === 0) return null;

  // choose the lowest valid move
  return sets.sort((a, b) => compareCards(a[0], b[0]))[0];
}

// ═══════════════════════════════════════════════════════════════
// GAME OVER + PLAY AGAIN + CARD EXCHANGE
// ═══════════════════════════════════════════════════════════════
function endGame() {
  clearAITimer();

  G.gameOver = true;

  // finishOrder already contains all but possibly the last remaining player
  const order = [...G.finishOrder];
  if (order.length < G.playerCount) {
    for (let i = 0; i < G.playerCount; i++) {
      if (!order.includes(i)) order.push(i);
    }
  }

  G.finishOrder = order;
  G.winnerIdx = order[0];
  G.loserIdx = order[order.length - 1];

  MATCH.lastWinnerIdx = G.winnerIdx;
  MATCH.lastLoserIdx = G.loserIdx;
  if (!MATCH.loseStreak) MATCH.loseStreak = new Array(G.playerCount).fill(0);
  for (let i = 0; i < G.playerCount; i++) {
    MATCH.loseStreak[i] = i === G.loserIdx ? (MATCH.loseStreak[i] || 0) + 1 : 0;
  }

  // Points: 1st place scores (playerCount - 2), one less per rank down,
  // last place always -1 regardless of how many are playing.
  if (!MATCH.scores) MATCH.scores = new Array(G.playerCount).fill(0);
  G.gamePoints = new Array(G.playerCount).fill(0);
  order.forEach((seatIdx, rankIndex) => {
    const points = pointsForRank(rankIndex, G.playerCount);
    G.gamePoints[seatIdx] = points;
    MATCH.scores[seatIdx] = (MATCH.scores[seatIdx] || 0) + points;
  });

  // Pre-deal the next game's hands now, so the "loser offers their best
  // card" step is fixed the instant the game ends, before anyone chooses.
  const freshHands = deal(G.playerCount);
  const bestLoserCard = highestCard(freshHands[G.loserIdx]);

  MATCH.pendingExchange = {
    winnerIdx: G.winnerIdx,
    loserIdx: G.loserIdx,
    freshHands,
    bestLoserCard
  };

  renderGame();
  renderEndScreen();
  showScreen('end-screen');
}

function renderScoreboardInto(elementId) {
  const el = document.getElementById(elementId);
  if (!el || !G || !G.names) return;

  const scores = MATCH.scores || new Array(G.playerCount).fill(0);
  const rows = G.names.map((name, idx) => ({ idx, name, total: scores[idx] || 0 }));
  rows.sort((a, b) => b.total - a.total);

  el.innerHTML = rows.map(row => `
    <div class="score-row">
      <div class="score-pname">${escapeHtml(row.name)}</div>
      <div class="score-total ${row.total > 0 ? 'positive' : row.total < 0 ? 'negative' : ''}">${row.total > 0 ? '+' : ''}${row.total}</div>
    </div>
  `).join('');
}

function openScoreboard() {
  renderScoreboardInto('scoreboard-table');
  document.getElementById('scoreboard-modal')?.classList.add('open');
}

function closeScoreboard() {
  document.getElementById('scoreboard-modal')?.classList.remove('open');
}

window.openScoreboard = openScoreboard;
window.closeScoreboard = closeScoreboard;

function openRules() {
  document.getElementById('rules-modal')?.classList.add('open');
}

function closeRules() {
  document.getElementById('rules-modal')?.classList.remove('open');
}

window.openRules = openRules;
window.closeRules = closeRules;

// Shows a GIF in the end-screen trophy slot if one loads successfully at
// `gifSrc`, otherwise falls back to the emoji — so an unset/missing GIF
// (the default, until real files are dropped into TROPHY_GIFS' paths)
// never shows as a broken image.
function setTrophyDisplay(gifSrc, emoji) {
  const img = document.getElementById('end-trophy-gif');
  const fallback = document.getElementById('end-trophy-emoji');
  if (!img || !fallback) return;

  fallback.textContent = emoji;

  if (!gifSrc) {
    img.hidden = true;
    fallback.hidden = false;
    return;
  }

  // Same result as last time (e.g. winning two games in a row) and we
  // already confirmed this file loads — show it straight away rather than
  // waiting on an onload that may not re-fire for an unchanged src.
  if (img.dataset.loadedSrc === gifSrc) {
    img.hidden = false;
    fallback.hidden = true;
    return;
  }

  img.hidden = true;
  fallback.hidden = false;
  img.onload = () => { img.dataset.loadedSrc = gifSrc; img.hidden = false; fallback.hidden = true; };
  img.onerror = () => { img.hidden = true; fallback.hidden = false; };
  img.src = gifSrc;
}

function renderEndScreen() {
  const winnerName = document.getElementById('winner-name');
  const rankings = document.getElementById('rankings');
  const exchangeInfo = document.getElementById('exchange-info');
  const playAgainBtn = document.getElementById('play-again-btn');
  const waitHint = document.getElementById('end-wait-hint');
  const winnerTitle = document.getElementById('winner-title');
  const endTrophy = document.getElementById('end-trophy');

  if (winnerName) winnerName.textContent = G.names[G.winnerIdx];

  // Headline is personal to whoever is looking at the screen — the winner
  // sees রাজা, the loser sees প্রজা, everyone in between just sees their rank.
  if (winnerTitle && endTrophy) {
    const my = myIndex();
    if (my === G.winnerIdx) {
      winnerTitle.textContent = 'রাজা!';
      setTrophyDisplay(TROPHY_GIFS.winner, '🏆');
    } else if (my === G.loserIdx) {
      winnerTitle.textContent = 'প্রজা';
      setTrophyDisplay(TROPHY_GIFS.loser, '🍌');
    } else {
      const rank = G.finishOrder.indexOf(my) + 1;
      winnerTitle.textContent = rank > 0 ? `#${rank} Place` : 'Game Over';
      setTrophyDisplay(TROPHY_GIFS.neutral, '🎲');
    }
  }

  if (rankings) {
    const html = G.finishOrder.map((pid, index) => {
      const points = G.gamePoints ? G.gamePoints[pid] : null;
      const pointsHtml = points !== null
        ? `<span class="score-delta ${points > 0 ? 'positive' : points < 0 ? 'negative' : ''}">${points > 0 ? '+' : ''}${points}</span>`
        : '';
      return `
        <div class="rank-row">
          <div class="rank-num">${index + 1}</div>
          <div class="rank-pname">${escapeHtml(G.names[pid])}</div>
          ${pointsHtml}
          <div>
            ${index === 0 ? '<span class="rank-badge winner-badge">রাজা</span>' : ''}
            ${index === G.finishOrder.length - 1 ? '<span class="rank-badge loser-badge">প্রজা</span>' : ''}
          </div>
        </div>
      `;
    }).join('');

    rankings.innerHTML = `<h3>Final Rankings</h3>${html}`;
  }

  renderScoreboardInto('end-scoreboard-table');

  if (exchangeInfo) {
    exchangeInfo.style.display = 'block';
    exchangeInfo.innerHTML = `
      <strong>Next game exchange rule:</strong><br>
      ${escapeHtml(G.names[G.winnerIdx])} will take the best card from ${escapeHtml(G.names[G.loserIdx])},
      then give one card back.
    `;
  }

  if (playAgainBtn && waitHint) {
    if (!isOnline()) {
      playAgainBtn.style.display = '';
      playAgainBtn.textContent = 'Play Again';
      waitHint.textContent = '';
    } else if (G.winnerIdx === myIndex()) {
      playAgainBtn.style.display = '';
      playAgainBtn.textContent = 'Choose Card & Continue';
      waitHint.textContent = '';
    } else {
      playAgainBtn.style.display = 'none';
      waitHint.textContent = `Waiting for ${G.names[G.winnerIdx]} to choose a card...`;
    }
  }
}

function playAgain() {
  const pe = MATCH.pendingExchange;
  if (!pe) {
    if (amHost()) startLocalGame();
    return;
  }

  if (pe.winnerIdx === myIndex()) {
    showExchangeModalForMe(pe);
  } else if (isBotSeat(pe.winnerIdx)) {
    if (amHost()) showExchangeModalForAIWinner(pe);
  } else {
    showToast(`Waiting for ${G.names[pe.winnerIdx]}...`);
  }
}

window.playAgain = playAgain;

// ═══════════════════════════════════════════════════════════════
// EXCHANGE MODAL
// ═══════════════════════════════════════════════════════════════
function showExchangeModalForMe(pe) {
  const modal = document.getElementById('exchange-modal');
  const title = document.getElementById('modal-title');
  const desc = document.getElementById('modal-desc');
  const cardsEl = document.getElementById('modal-cards');
  const confirmBtn = document.getElementById('modal-confirm');

  if (!modal || !title || !desc || !cardsEl || !confirmBtn) return;

  const { freshHands, winnerIdx, loserIdx, bestLoserCard } = pe;

  const simulatedWinnerHand = sortHand([
    ...freshHands[winnerIdx].map(cloneCard),
    ...(bestLoserCard ? [cloneCard(bestLoserCard)] : [])
  ]);

  exchangeModalData = {
    pe,
    selectedGiveCard: null
  };

  title.textContent = 'Choose a card to give back';
  desc.textContent =
    bestLoserCard
      ? `You will take ${bestLoserCard.rank}${bestLoserCard.suit} from ${G.names[loserIdx]}. Now choose one card from your new hand to give back.`
      : `Choose one card to give back.`;

  cardsEl.innerHTML = simulatedWinnerHand.map(card => renderCard(card, false, true, true)).join('');
  confirmBtn.disabled = true;

  cardsEl.querySelectorAll('.exchange-card').forEach(el => {
    el.addEventListener('click', () => {
      cardsEl.querySelectorAll('.exchange-card').forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');

      exchangeModalData.selectedGiveCard = {
        rank: el.dataset.rank,
        suit: el.dataset.suit
      };

      confirmBtn.disabled = false;
    });
  });

  modal.classList.add('open');
}

function showExchangeModalForAIWinner(pe) {
  const modal = document.getElementById('exchange-modal');
  const title = document.getElementById('modal-title');
  const desc = document.getElementById('modal-desc');
  const cardsEl = document.getElementById('modal-cards');
  const confirmBtn = document.getElementById('modal-confirm');

  if (!modal || !title || !desc || !cardsEl || !confirmBtn) return;

  const { freshHands, winnerIdx, loserIdx, bestLoserCard } = pe;

  const winnerAfterTaking = sortHand([
    ...freshHands[winnerIdx].map(cloneCard),
    ...(bestLoserCard ? [cloneCard(bestLoserCard)] : [])
  ]);

  const giveCard = lowestCard(winnerAfterTaking);

  exchangeModalData = {
    pe,
    selectedGiveCard: giveCard
  };

  // Only the two parties to the trade get to see which cards moved — a
  // third player (e.g. a host who is neither winner nor loser) just sees
  // that an exchange happened, not the cards involved.
  const iAmLoser = myIndex() === loserIdx;

  title.textContent = 'Card Exchange';
  desc.textContent = iAmLoser && bestLoserCard && giveCard
    ? `${G.names[winnerIdx]} takes ${bestLoserCard.rank}${bestLoserCard.suit} from you and gives back ${giveCard.rank}${giveCard.suit}.`
    : `${G.names[winnerIdx]} and ${G.names[loserIdx]} are exchanging cards...`;

  cardsEl.innerHTML = '';
  confirmBtn.disabled = false;

  modal.classList.add('open');
}

function confirmExchange() {
  const modal = document.getElementById('exchange-modal');
  if (!exchangeModalData) return;

  const { pe, selectedGiveCard } = exchangeModalData;

  if (!selectedGiveCard) {
    showToast('Choose a card first.');
    return;
  }

  if (amHost()) {
    applyExchangeAndStart(pe.freshHands, pe.winnerIdx, pe.loserIdx, pe.bestLoserCard, selectedGiveCard);
  } else {
    sendExchangeChoice(pe.winnerIdx, selectedGiveCard);
    showToast('Choice sent...');
  }

  exchangeModalData = null;
  modal?.classList.remove('open');
}

window.confirmExchange = confirmExchange;

function applyExchangeAndStart(freshHands, winnerIdx, loserIdx, bestLoserCard, giveCard) {
  const hands = freshHands.map(hand => sortHand(hand.map(cloneCard)));

  // winner takes best from loser
  if (bestLoserCard) {
    removeSpecificCardFromArray(hands[loserIdx], bestLoserCard);
    hands[winnerIdx].push(cloneCard(bestLoserCard));
    hands[winnerIdx] = sortHand(hands[winnerIdx]);
  }

  // winner gives selected card back
  removeSpecificCardFromArray(hands[winnerIdx], giveCard);
  hands[loserIdx].push(cloneCard(giveCard));
  hands[loserIdx] = sortHand(hands[loserIdx]);

  MATCH.pendingExchange = null;

  const starterIdx = findStarterFirstGame(hands);
  initGameState(hands, starterIdx, G.seats);
}

// ═══════════════════════════════════════════════════════════════
// LOG / TOAST
// ═══════════════════════════════════════════════════════════════
function clearLog() {
  const area = document.getElementById('log-area');
  if (area) area.innerHTML = '';
}

function addLog(html) {
  const area = document.getElementById('log-area');
  if (!area) return;

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = html;
  area.prepend(entry);

  while (area.children.length > 30) {
    area.removeChild(area.lastChild);
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add('show');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1800);
}

// ═══════════════════════════════════════════════════════════════
// NETWORKING — ROOMS TABLE (see supabase/migrations/)
// One row per room. `data` (jsonb) is the entire lobby/game state.
// Shape:
// {
//   status: 'lobby' | 'playing',
//   seats: [{clientId, name, isBot} | null, ...],
//   hostClientId,
//   playerCount,
//   match: { gameCount, pendingExchange },
//   game: <full G object>,
//   pendingMove: null | { seatIdx, type: 'play'|'stop', cards? },
//   pendingExchangeChoice: null | { winnerIdx, giveCard }
// }
// ═══════════════════════════════════════════════════════════════
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function hasSupabase() {
  return typeof supabaseClient !== 'undefined' && !!supabaseClient;
}

async function createRoom(name, playerCount, avatar) {
  if (!hasSupabase()) { showToast('Multiplayer is not configured.'); return; }

  G = {};
  const code = generateRoomCode();
  const seats = new Array(playerCount).fill(null);
  seats[0] = { clientId: MY_CLIENT_ID, name, isBot: false, avatar };

  const data = {
    status: 'lobby',
    seats,
    hostClientId: MY_CLIENT_ID,
    playerCount,
    match: { gameCount: 0, pendingExchange: null },
    game: null,
    pendingMove: null,
    pendingExchangeChoice: null
  };

  const { error } = await supabaseClient.from('rooms').insert({ code, data });
  if (error) {
    console.error(error);
    showToast('Could not create room. Check Supabase setup.');
    return;
  }

  ROOM = { online: true, isHost: true, myIdx: 0, code, seats, channel: null, myName: name, myAvatar: avatar, hostClientId: MY_CLIENT_ID };
  chatMessages = [];
  subscribeRoomChannel(code);
  saveRoomSession();
  showScreen('lobby-screen');
  renderLobby(data);
  setChatVisible(true);
}

async function joinRoom(name, code, avatar) {
  if (!hasSupabase()) { showToast('Multiplayer is not configured.'); return; }

  G = {};
  code = code.trim().toUpperCase();
  const { data: row, error } = await supabaseClient.from('rooms').select('*').eq('code', code).single();
  if (error || !row) {
    showToast('Room not found.');
    return;
  }

  const data = row.data;
  if (data.status !== 'lobby') {
    showToast('That game already started.');
    return;
  }

  const seatIdx = data.seats.findIndex(s => s === null);
  if (seatIdx === -1) {
    showToast('Room is full.');
    return;
  }

  data.seats[seatIdx] = { clientId: MY_CLIENT_ID, name, isBot: false, avatar };

  const { error: updateError } = await supabaseClient
    .from('rooms')
    .update({ data })
    .eq('code', code);

  if (updateError) {
    console.error(updateError);
    showToast('Could not join room, try again.');
    return;
  }

  ROOM = { online: true, isHost: false, myIdx: seatIdx, code, seats: data.seats, channel: null, myName: name, myAvatar: avatar, hostClientId: data.hostClientId };
  chatMessages = [];
  subscribeRoomChannel(code);
  saveRoomSession();
  showScreen('lobby-screen');
  renderLobby(data);
  setChatVisible(true);
}

function subscribeRoomChannel(code) {
  if (!hasSupabase()) return;
  if (ROOM.channel) {
    supabaseClient.removeChannel(ROOM.channel);
    ROOM.channel = null;
  }
  clearHostMigrationTimer();

  const channel = supabaseClient
    .channel('room-' + code, { config: { presence: { key: MY_CLIENT_ID } } })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${code}` }, (payload) => {
      onRoomRowChange(payload.new.data);
    })
    .on('broadcast', { event: 'chat' }, (payload) => {
      addChatMessage(payload.payload, false);
    })
    .on('presence', { event: 'sync' }, () => checkHostPresence(channel, code))
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') channel.track({ seatIdx: ROOM.myIdx });
    });

  ROOM.channel = channel;
}

function onRoomRowChange(data) {
  if (!ROOM.online) return;

  // Was this update the moment hosting duties landed on us — either the
  // outgoing host handing off voluntarily (leaveOnlineGame) or us having
  // just promoted ourselves (attemptHostPromotion, which sets ROOM.isHost
  // itself and won't hit this)? If so we must adopt data.game as ground
  // truth *before* flipping ROOM.isHost, otherwise the generic "host's own
  // state is authoritative, ignore incoming rows" branch below would throw
  // away the very state we were just handed.
  const iAmBeingPromoted = !!data.hostClientId && data.hostClientId === MY_CLIENT_ID && !ROOM.isHost;

  if (data.hostClientId) {
    if (ROOM.isHost && data.hostClientId !== MY_CLIENT_ID) {
      // We used to be host, but someone else already took over while we
      // were unreachable (see attemptHostPromotion) — stand down instead
      // of fighting them for authority over the room.
      ROOM.isHost = false;
      clearTurnTimer();
      clearAITimer();
      showToast('Another player is now hosting this room.');
    }
    ROOM.hostClientId = data.hostClientId;
  }

  // Lobby updates matter to everyone, host included — a joiner claiming a
  // seat has to show up on the host's screen without waiting for the host
  // to act. Re-rendering from a client's own echo is harmless (idempotent).
  if (data.status === 'lobby') {
    ROOM.seats = data.seats;
    renderLobby(data);
    if (iAmBeingPromoted) ROOM.isHost = true;
    return;
  }

  if (iAmBeingPromoted && data.status === 'playing' && data.game) {
    MATCH.gameCount = data.match.gameCount;
    MATCH.pendingExchange = data.match.pendingExchange;
    MATCH.lastWinnerIdx = data.match.lastWinnerIdx;
    MATCH.lastLoserIdx = data.match.lastLoserIdx;
    MATCH.loseStreak = data.match.loseStreak;
    MATCH.scores = data.match.scores;
    G = data.game;
    roomStateRev = typeof G.rev === 'number' ? G.rev : 0;
    ROOM.isHost = true;

    showScreen('game-screen');
    renderGame();
    if (G.gameOver) {
      renderEndScreen();
      showScreen('end-screen');
    } else {
      advanceTurn();
    }
    return;
  }

  if (amHost()) {
    if (data.pendingMove) { processPendingMove(data.pendingMove); return; }
    if (data.pendingExchangeChoice) { processPendingExchangeChoice(data.pendingExchangeChoice); return; }
    return; // host's own state is authoritative; nothing else to adopt
  }

  // non-host client
  if (data.status === 'playing' && data.game) {
    // Belt-and-suspenders against a delayed/duplicate delivery clobbering a
    // state we've already moved past — the host tags every push with an
    // increasing rev, so anything older than what we've already applied
    // is discarded rather than rendered.
    if (typeof data.game.rev === 'number' && typeof G.rev === 'number' && data.game.rev < G.rev) {
      return;
    }
    MATCH.gameCount = data.match.gameCount;
    MATCH.pendingExchange = data.match.pendingExchange;
    MATCH.lastWinnerIdx = data.match.lastWinnerIdx;
    MATCH.lastLoserIdx = data.match.lastLoserIdx;
    MATCH.loseStreak = data.match.loseStreak;
    MATCH.scores = data.match.scores;
    G = data.game;
    showScreen('game-screen');
    renderGame();
    if (G.gameOver) {
      renderEndScreen();
      showScreen('end-screen');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PRESENCE, HOST MIGRATION & RECONNECT
//
// The host's browser is the only thing driving the game (timers, AI) —
// if it disconnects, everyone else just sits there frozen. Every client
// tracks itself on the channel's presence set and watches for the host's
// id to vanish from it; after a short grace period (to ride out a blip
// rather than a real drop) the lowest-seat surviving human promotes
// itself to host and picks the game back up from the last synced state.
//
// Separately, MY_CLIENT_ID is persisted in localStorage, and so is the
// room code — so a refresh (or a phone that reopens the tab after
// losing wifi) can silently rejoin the same seat instead of bouncing
// back to the setup screen.
// ═══════════════════════════════════════════════════════════════
const HOST_MIGRATION_GRACE_MS = 8000;
let hostMigrationTimer = null;

function clearHostMigrationTimer() {
  if (hostMigrationTimer) {
    clearTimeout(hostMigrationTimer);
    hostMigrationTimer = null;
  }
}

function checkHostPresence(channel, code) {
  if (!ROOM.online || amHost()) { clearHostMigrationTimer(); return; }
  if (!ROOM.hostClientId) return;

  const presentIds = new Set(Object.keys(channel.presenceState()));
  if (presentIds.has(ROOM.hostClientId)) {
    clearHostMigrationTimer();
    return;
  }

  if (hostMigrationTimer) return; // already waiting out the grace period

  hostMigrationTimer = setTimeout(() => {
    hostMigrationTimer = null;
    attemptHostPromotion(code, new Set(Object.keys(channel.presenceState())));
  }, HOST_MIGRATION_GRACE_MS);
}

async function attemptHostPromotion(code, presentIds) {
  if (!hasSupabase() || !ROOM.online || amHost()) return;
  if (presentIds.has(ROOM.hostClientId)) return; // host came back before the grace period elapsed

  const seats = (G && G.seats) || ROOM.seats;
  if (!seats) return;

  // Only the lowest-indexed surviving human seat attempts the takeover,
  // so surviving clients don't race each other to promote themselves.
  const candidateIdx = seats.findIndex(s => s && !s.isBot && presentIds.has(s.clientId));
  if (candidateIdx === -1 || candidateIdx !== ROOM.myIdx) return;

  const staleHostId = ROOM.hostClientId;
  const { data: row, error } = await supabaseClient.from('rooms').select('data').eq('code', code).single();
  if (error || !row) return;
  if (row.data.hostClientId !== staleHostId) return; // someone already took over, or the host is back

  const newData = { ...row.data, hostClientId: MY_CLIENT_ID };
  // Give the in-progress turn a fresh clock — its original window may have
  // elapsed entirely while the room had no host to enforce it.
  if (newData.game && !newData.game.gameOver) {
    newData.game = { ...newData.game, turnStartedAt: Date.now() };
  }

  const { error: upErr } = await supabaseClient.from('rooms').update({ data: newData }).eq('code', code);
  if (upErr || !ROOM.online) return;

  ROOM.isHost = true;
  ROOM.hostClientId = MY_CLIENT_ID;
  if (newData.match) {
    MATCH.gameCount = newData.match.gameCount;
    MATCH.pendingExchange = newData.match.pendingExchange;
    MATCH.lastWinnerIdx = newData.match.lastWinnerIdx;
    MATCH.lastLoserIdx = newData.match.lastLoserIdx;
    MATCH.loseStreak = newData.match.loseStreak;
    MATCH.scores = newData.match.scores;
  }
  if (newData.game) G = newData.game;
  // Continue the rev counter from where the old host left off, so our
  // first push after taking over doesn't look "older" than what everyone
  // (including us, a second ago) already has synced.
  roomStateRev = (G && typeof G.rev === 'number') ? G.rev : 0;

  showToast("The host disconnected — you're now hosting.");
  if (G && G.playerCount) {
    renderGame();
    if (!G.gameOver) advanceTurn();
  }
}

function saveRoomSession() {
  try {
    if (ROOM.online && ROOM.code) localStorage.setItem('ltt_room_code', ROOM.code);
  } catch { /* private browsing / storage disabled — reconnect just won't be offered */ }
}

function clearRoomSession() {
  try { localStorage.removeItem('ltt_room_code'); } catch {}
}

async function attemptAutoRejoin() {
  if (!hasSupabase()) return;
  let code = null;
  try { code = localStorage.getItem('ltt_room_code'); } catch {}
  if (!code) return;

  const { data: row, error } = await supabaseClient.from('rooms').select('*').eq('code', code).single();
  if (error || !row) { clearRoomSession(); return; }

  const data = row.data;
  const seatIdx = (data.seats || []).findIndex(s => s && s.clientId === MY_CLIENT_ID);
  if (seatIdx === -1) { clearRoomSession(); return; }

  const mySeat = data.seats[seatIdx];
  ROOM = {
    online: true,
    isHost: data.hostClientId === MY_CLIENT_ID,
    myIdx: seatIdx,
    code,
    seats: data.seats,
    channel: null,
    myName: mySeat.name,
    myAvatar: mySeat.avatar,
    hostClientId: data.hostClientId
  };
  chatMessages = [];
  subscribeRoomChannel(code);
  setChatVisible(true);
  showToast('Reconnected to your room.');

  if (data.status === 'lobby') {
    showScreen('lobby-screen');
    renderLobby(data);
    return;
  }

  if (data.status === 'playing' && data.game) {
    MATCH.gameCount = data.match.gameCount;
    MATCH.pendingExchange = data.match.pendingExchange;
    MATCH.lastWinnerIdx = data.match.lastWinnerIdx;
    MATCH.lastLoserIdx = data.match.lastLoserIdx;
    MATCH.loseStreak = data.match.loseStreak;
    MATCH.scores = data.match.scores;
    G = data.game;
    showScreen('game-screen');
    renderGame();
    if (G.gameOver) {
      renderEndScreen();
      showScreen('end-screen');
    } else if (amHost()) {
      // Continue the rev counter from the synced row rather than restarting
      // at 0, so our next push isn't mistaken for a stale/older delivery.
      roomStateRev = typeof G.rev === 'number' ? G.rev : 0;
      // The driving loop (turn timer / AI scheduling) only ever lived in
      // memory, so a host who reloads has to explicitly restart it even
      // though the room row itself is still perfectly intact.
      G.turnStartedAt = Date.now();
      advanceTurn();
    }
  }
}

// A single game action (e.g. playing a card) can trigger several renderGame()
// calls in a row (play -> finish check -> turn advance), each wanting to push
// the latest state. Firing every one of those as its own concurrent HTTP
// request lets them race: a slower request for an *older* snapshot can land
// at the DB after a faster request for a *newer* one, silently overwriting it
// — the host moves on locally while everyone else's copy freezes on the
// stale row. To make that impossible, at most one push is ever in flight;
// anything that comes in while one is outstanding just marks "send again
// once this finishes," and that follow-up always reads G fresh rather than
// resending a captured snapshot.
let pushInFlight = false;
let pushPending = false;
let roomStateRev = 0;

function pushRoomState() {
  if (!isOnline() || !amHost() || !ROOM.code) return;

  if (pushInFlight) {
    pushPending = true;
    return;
  }

  pushInFlight = true;
  roomStateRev += 1;
  G.rev = roomStateRev;

  // Deep-clone so the payload is frozen at send time — G is otherwise a
  // live object, and if it mutates again before the request body is
  // serialized (this call is thenable, not immediately sent), the network
  // could end up carrying a different state than the one we intended here.
  const payload = {
    status: 'playing',
    seats: G.seats,
    hostClientId: MY_CLIENT_ID,
    playerCount: G.playerCount,
    match: JSON.parse(JSON.stringify({
      gameCount: MATCH.gameCount,
      pendingExchange: MATCH.pendingExchange,
      lastWinnerIdx: MATCH.lastWinnerIdx,
      lastLoserIdx: MATCH.lastLoserIdx,
      loseStreak: MATCH.loseStreak,
      scores: MATCH.scores
    })),
    game: JSON.parse(JSON.stringify(G)),
    pendingMove: null,
    pendingExchangeChoice: null
  };

  supabaseClient.from('rooms').update({ data: payload }).eq('code', ROOM.code)
    .then(({ error }) => {
      if (error) console.error('pushRoomState error', error);
      pushInFlight = false;
      if (pushPending) {
        pushPending = false;
        pushRoomState();
      }
    });
}

async function sendPendingMove(move) {
  if (!hasSupabase() || !ROOM.code) return;
  const { data: row, error } = await supabaseClient.from('rooms').select('data').eq('code', ROOM.code).single();
  if (error || !row) { showToast('Connection issue, try again.'); return; }
  const newData = { ...row.data, pendingMove: move };
  const { error: upErr } = await supabaseClient.from('rooms').update({ data: newData }).eq('code', ROOM.code);
  if (upErr) showToast('Could not send move.');
}

async function sendExchangeChoice(winnerIdx, giveCard) {
  if (!hasSupabase() || !ROOM.code) return;
  const { data: row, error } = await supabaseClient.from('rooms').select('data').eq('code', ROOM.code).single();
  if (error || !row) { showToast('Connection issue, try again.'); return; }
  const newData = { ...row.data, pendingExchangeChoice: { winnerIdx, giveCard } };
  await supabaseClient.from('rooms').update({ data: newData }).eq('code', ROOM.code);
}

function processPendingMove(move) {
  if (!G) return;

  // Leaving isn't a turn-based action — a player can walk away whenever
  // they like, not just on their own turn — so it's handled before the
  // "is it even your turn" gate below applies to everything else.
  if (move.type === 'leave') {
    applyPlayerLeft(move.seatIdx);
    return;
  }

  if (move.seatIdx !== G.currentPlayer) { pushRoomState(); return; }

  if (move.type === 'play') {
    const cards = move.cards || [];
    if (G.pattern === null) {
      if (!(cards.length >= 1 && cards.length <= 4 && sameRankSet(cards))) { pushRoomState(); return; }
      G.pattern = cards.length;
    } else if (!canPlaySetAgainst(cards, G.pattern, G.lastPlayed)) {
      pushRoomState();
      return;
    }
    playCards(move.seatIdx, cards);
  } else if (move.type === 'stop') {
    stopPlayer(move.seatIdx);
  } else {
    pushRoomState();
  }
}

// A seat that explicitly leaves mid-game is handed to a bot rather than
// removed — the engine already knows how to run bot seats through every
// remaining turn, session, and end-of-game calculation, so this avoids
// having to teach every alive/turn-order check about a third kind of seat.
function applyPlayerLeft(seatIdx) {
  if (!G.seats || !G.seats[seatIdx] || G.seats[seatIdx].isBot) { pushRoomState(); return; }

  G.seats[seatIdx].isBot = true;
  G.names[seatIdx] = `${G.names[seatIdx]} (left)`;

  addLog(`<span class="log-player">${escapeHtml(G.names[seatIdx])}</span> left the game — a bot is playing their hand.`);
  renderGame();

  // If it was their turn when they left, nudge the AI to act immediately
  // instead of waiting out their remaining turn clock.
  if (!G.gameOver && G.currentPlayer === seatIdx) scheduleAI();
}

function processPendingExchangeChoice(choice) {
  const pe = MATCH.pendingExchange;
  if (!pe || choice.winnerIdx !== pe.winnerIdx) { pushRoomState(); return; }
  applyExchangeAndStart(pe.freshHands, pe.winnerIdx, pe.loserIdx, pe.bestLoserCard, choice.giveCard);
}

// ── LOBBY ──
function renderLobby(data) {
  const codeEl = document.getElementById('lobby-room-code');
  const seatsEl = document.getElementById('lobby-seats');
  const startBtn = document.getElementById('lobby-start-btn');
  const hint = document.getElementById('lobby-hint');

  if (codeEl) codeEl.textContent = ROOM.code;

  const seats = data.seats;
  if (seatsEl) {
    seatsEl.innerHTML = seats.map((s, i) => {
      if (!s) {
        return `
          <div class="seat-row seat-empty">
            <div class="seat-label">Seat ${i + 1} — waiting...</div>
            ${amHost() ? `<button class="seat-bot-btn" data-seat="${i}">Fill with Bot</button>` : ''}
          </div>`;
      }

      const tags = [
        s.clientId === data.hostClientId ? 'Host' : null,
        s.clientId === MY_CLIENT_ID ? 'You' : null,
        s.isBot ? 'Bot' : null
      ].filter(Boolean).join(' · ');

      const av = getAvatarDisplay(s);

      return `
        <div class="seat-row ${s.isBot ? 'seat-bot' : 'seat-filled'}">
          <div class="seat-label">
            <span class="mini-avatar" style="width:22px;height:22px;font-size:0.9rem;background:${av.bg}">${av.content}</span>
            ${escapeHtml(s.name)}
          </div>
          <div class="seat-tag">${tags}</div>
        </div>`;
    }).join('');

    if (amHost()) {
      seatsEl.querySelectorAll('.seat-bot-btn').forEach(btn => {
        btn.addEventListener('click', () => fillSeatWithBot(Number(btn.dataset.seat)));
      });
    }
  }

  const allFilled = seats.every(s => s !== null);

  if (startBtn) {
    startBtn.style.display = amHost() ? '' : 'none';
    startBtn.disabled = !allFilled;
  }

  if (hint) {
    hint.textContent = amHost()
      ? (allFilled ? 'All seats filled — start when ready.' : 'Fill empty seats with players or bots.')
      : 'Waiting for host to start the game...';
  }
}

async function fillSeatWithBot(idx) {
  if (!hasSupabase() || !ROOM.code) return;
  const { data: row, error } = await supabaseClient.from('rooms').select('data').eq('code', ROOM.code).single();
  if (error || !row) return;

  const data = row.data;
  if (data.seats[idx]) return;

  data.seats[idx] = {
    clientId: `bot_${idx}_${Math.random().toString(36).slice(2, 6)}`,
    name: BOT_NAMES[idx % BOT_NAMES.length],
    isBot: true
  };

  const { error: updateError } = await supabaseClient.from('rooms').update({ data }).eq('code', ROOM.code);
  if (updateError) { showToast('Could not update room.'); return; }

  ROOM.seats = data.seats;
  renderLobby(data);
}

async function hostStartGameClick() {
  if (!amHost() || !ROOM.code) return;

  const { data: row, error } = await supabaseClient.from('rooms').select('data').eq('code', ROOM.code).single();
  if (error || !row) { showToast('Connection issue.'); return; }

  const data = row.data;
  if (!data.seats.every(s => s !== null)) { showToast('Fill all seats first.'); return; }

  MATCH = {
    names: data.seats.map(s => s.name),
    gameCount: 0,
    pendingExchange: null,
    lastWinnerIdx: null,
    lastLoserIdx: null,
    loseStreak: new Array(data.seats.length).fill(0),
    scores: new Array(data.seats.length).fill(0)
  };

  const hands = deal(data.seats.length);
  const starterIdx = findStarterFirstGame(hands);

  initGameState(hands, starterIdx, data.seats);
}

function leaveRoom() {
  if (ROOM.channel && hasSupabase()) {
    supabaseClient.removeChannel(ROOM.channel);
  }
  clearHostMigrationTimer();
  clearRoomSession();
  ROOM = { online: false, isHost: true, myIdx: 0, code: null, seats: [], channel: null, hostClientId: null };
  G = {};
  chatMessages = [];
  setChatVisible(false);
  showScreen('setup-screen');
}

// Reachable from the top bar mid-game or from the end screen. Anyone —
// host included — can walk away at any point; the rest of the table
// shouldn't be stuck because one person had to go.
async function leaveGame() {
  const inGame = isOnline() && G && G.playerCount && !G.gameOver;
  const msg = inGame
    ? "Leave the game? Your seat will be handed to a bot so the others can keep playing."
    : 'Leave and return to the setup screen?';
  if (!confirm(msg)) return;

  if (!isOnline()) {
    clearAITimer();
    clearTurnTimer();
    G = {};
    chatMessages = [];
    showScreen('setup-screen');
    return;
  }

  await leaveOnlineGame();
}
window.leaveGame = leaveGame;

async function leaveOnlineGame() {
  const myIdx = myIndex();
  const inGame = G && G.playerCount && !G.gameOver;

  if (!hasSupabase() || !ROOM.code) { leaveRoom(); return; }

  if (inGame && amHost()) {
    // Hand hosting off to another connected human before we vanish, so the
    // game keeps running instead of waiting out the presence-loss timeout.
    const presentIds = ROOM.channel ? new Set(Object.keys(ROOM.channel.presenceState())) : new Set();
    const nextHostIdx = G.seats.findIndex((s, i) => i !== myIdx && s && !s.isBot && presentIds.has(s.clientId));

    if (nextHostIdx === -1) {
      // No other human left in the room — nobody to hand it to, so just close it.
      await supabaseClient.from('rooms').delete().eq('code', ROOM.code);
    } else {
      G.seats[myIdx].isBot = true;
      G.names[myIdx] = `${G.names[myIdx]} (left)`;
      const payload = {
        status: 'playing',
        seats: G.seats,
        hostClientId: G.seats[nextHostIdx].clientId,
        playerCount: G.playerCount,
        match: {
          gameCount: MATCH.gameCount,
          pendingExchange: MATCH.pendingExchange,
          lastWinnerIdx: MATCH.lastWinnerIdx,
          lastLoserIdx: MATCH.lastLoserIdx,
          loseStreak: MATCH.loseStreak,
          scores: MATCH.scores
        },
        game: { ...G, turnStartedAt: Date.now(), rev: (G.rev || 0) + 1 },
        pendingMove: null,
        pendingExchangeChoice: null
      };
      await supabaseClient.from('rooms').update({ data: payload }).eq('code', ROOM.code);
    }
  } else if (inGame && !amHost()) {
    // Ask the host to take over our seat with a bot for the rest of the match.
    await sendPendingMove({ seatIdx: myIdx, type: 'leave' });
  } else if (amHost()) {
    // Host, but leaving from the lobby or after the game already ended —
    // nothing to hand off, just close the room down.
    await supabaseClient.from('rooms').delete().eq('code', ROOM.code);
  }

  leaveRoom();
}

// ═══════════════════════════════════════════════════════════════
// ROOM CHAT — live only (Realtime broadcast, no persistence). Any
// seat can send directly; it doesn't go through the host-authoritative
// game state at all, so it never touches game logic or the DB row.
// ═══════════════════════════════════════════════════════════════
function myChatIdentity() {
  const seat = G && G.seats ? G.seats[myIndex()] : null;
  if (seat) return { name: seat.name, avatar: getAvatarDisplay(seat) };
  return { name: ROOM.myName || 'You', avatar: getAvatarDisplay({ name: ROOM.myName, avatar: ROOM.myAvatar }) };
}

function setChatVisible(visible) {
  const widget = document.getElementById('chat-widget');
  if (!widget) return;
  widget.style.display = visible ? '' : 'none';
  if (!visible) {
    const panel = document.getElementById('chat-panel');
    if (panel) panel.style.display = 'none';
  }
}

function sendChatMessage(text) {
  text = text.trim();
  if (!text || !ROOM.channel) return;

  const who = myChatIdentity();
  const msg = { name: who.name, avatarContent: who.avatar.content, avatarBg: who.avatar.bg, text, ts: Date.now() };

  ROOM.channel.send({ type: 'broadcast', event: 'chat', payload: msg });
  addChatMessage(msg, true);
}

function addChatMessage(msg, isMine) {
  chatMessages.push(msg);
  if (chatMessages.length > 200) chatMessages.shift();
  renderChatMessages();

  const panel = document.getElementById('chat-panel');
  const isOpen = panel && panel.style.display !== 'none';
  if (!isMine && !isOpen) bumpChatBadge();
}

let unreadChatCount = 0;
function bumpChatBadge() {
  unreadChatCount += 1;
  const badge = document.getElementById('chat-badge');
  if (badge) {
    badge.textContent = String(unreadChatCount);
    badge.style.display = '';
  }
}

function clearChatBadge() {
  unreadChatCount = 0;
  const badge = document.getElementById('chat-badge');
  if (badge) badge.style.display = 'none';
}

function renderChatMessages() {
  const list = document.getElementById('chat-messages');
  if (!list) return;

  list.innerHTML = chatMessages.map(m => `
    <div class="chat-message">
      <span class="mini-avatar chat-avatar" style="width:20px;height:20px;font-size:0.7rem;background:${m.avatarBg}">${m.avatarContent}</span>
      <span><span class="chat-name">${escapeHtml(m.name)}:</span> ${escapeHtml(m.text)}</span>
    </div>
  `).join('') || `<div class="chat-message chat-system">No messages yet — say hello.</div>`;

  list.scrollTop = list.scrollHeight;
}

document.getElementById('chat-toggle-btn')?.addEventListener('click', () => {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? '' : 'none';
  if (opening) {
    clearChatBadge();
    renderChatMessages();
    document.getElementById('chat-input')?.focus();
  }
});

document.getElementById('chat-send-btn')?.addEventListener('click', () => {
  const input = document.getElementById('chat-input');
  if (!input) return;
  sendChatMessage(input.value);
  input.value = '';
});

document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('chat-send-btn')?.click();
  }
});

// If we were mid-room when the page last unloaded (refresh, lost wifi, tab
// crash), try to silently step back into the same seat instead of dumping
// the player back at the setup screen.
attemptAutoRejoin();
