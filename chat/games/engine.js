// ============================================================
// chat/games/engine.js — creation, RTDB sync, actions, win logic
// ============================================================
import { ref, push, get, set, update, runTransaction } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { db } from '../../js/firebase-config.js';
import { GAME_META, pick } from './helpers.js?v=5';
import {
  mathRound, countEmojiRound, jumbledRound, triviaRound, ROUNDS_PER_GAME,
} from './data.js?v=6';

let _getThreadId = () => null;
export const setThreadGetter = (fn) => { _getThreadId = fn; };
// Host-input providers (wired by index.js — e.g. the Hangman setup modal)
let _hostInputs = {};
export const setHostInputs = (h) => { _hostInputs = { ..._hostInputs, ...h }; };
const tid = () => _getThreadId();
const me = () => getAuth().currentUser?.uid;
const gRef = (mid) => ref(db, `chatMessages/${tid()}/${mid}/game`);

// ── Config bank loaders (posts-side JSON, cached) ──
let _flags = null, _riddles = null, _elements = null, _emojiBank = null, _trivia = null, _jumbled = null;
const loadFlags = async () => {
  if (_flags) return _flags;
  try { const r = await fetch('../config/flags.json?v=1'); _flags = await r.json(); } catch (_) { _flags = []; }
  return _flags;
};
const loadRiddles = async () => {
  if (_riddles) return _riddles;
  try {
    const r = await fetch('../config/emoji_riddles.json?v=1');
    const cats = await r.json();
    _riddles = Object.values(cats || {}).flat();
  } catch (_) { _riddles = []; }
  return _riddles;
};
const loadElements = async () => {
  if (_elements) return _elements;
  try { const r = await fetch('../config/elements.json?v=1'); _elements = await r.json(); } catch (_) { _elements = []; }
  return Array.isArray(_elements) ? _elements : [];
};
// "🍎 Apple Name" strings → { c: '🍎', n: 'Apple Name' }
const loadEmojiBank = async () => {
  if (_emojiBank) return _emojiBank;
  let list = [];
  try { const r = await fetch('../config/emojis.json?v=1'); list = await r.json(); } catch (_) { list = []; }
  _emojiBank = (Array.isArray(list) ? list : [])
    .map((s) => { const i = String(s).indexOf(' '); return i > 0 ? { c: s.slice(0, i), n: s.slice(i + 1).trim() } : null; })
    .filter(Boolean);
  return _emojiBank;
};
const loadTrivia = async () => {
  if (_trivia) return _trivia;
  try { const r = await fetch('../config/trivia.json?v=1'); _trivia = await r.json(); } catch (_) { _trivia = []; }
  return Array.isArray(_trivia) ? _trivia : [];
};
const loadJumbledWords = async () => {
  if (_jumbled) return _jumbled;
  try { const r = await fetch('../config/jumbled.json?v=1'); _jumbled = await r.json(); } catch (_) { _jumbled = []; }
  return Array.isArray(_jumbled) ? _jumbled : [];
};

/** Ask the host for text via prompt(). Returns trimmed string or null when cancelled. */
const ask = (msg, def) => {
  const v = window.prompt(msg, def || '');
  return v === null ? null : v.trim();
};

// ── Build the initial game object per type ──
const buildGame = async (type) => {
  const base = { type, hostId: me(), createdAt: Date.now(), status: 'active', winner: null };
  switch (GAME_META[type]?.family) {
    case 'board':
      return { ...base,
        status: 'waiting',                       // waiting for opponent to join
        players: { [me()]: type === 'connect4' ? 'R' : 'X' },
        turn: null,
        board: Array(type === 'connect4' ? 42 : 9).fill(''),
        lastMove: null,
      };
    case 'hangman': {                            // cloned from Hangout Posts: host picks the word (setup modal)
      let setup = null;
      if (_hostInputs.hangman) setup = await _hostInputs.hangman();
      else {
        const raw = ask('🔤 Hangman\nEnter the secret word (letters & spaces only):');
        if (raw === null) throw new Error('cancelled');
        setup = { word: raw, clues: '' };
      }
      if (!setup || !setup.word) throw new Error('cancelled');
      const word = String(setup.word).toUpperCase().replace(/\s+/g, ' ').trim();
      if (!/^[A-Z ]{2,30}$/.test(word)) throw new Error('Word must be 2-30 letters.');
      const distinct = [...new Set(word.replace(/ /g, '').split(''))];
      const cluesRaw = String(setup.clues || '').toUpperCase();
      let clues = [...new Set((cluesRaw.match(/[A-Z]/g) || []))].filter((L) => distinct.includes(L));
      if (clues.length >= distinct.length) clues = clues.slice(0, Math.max(0, distinct.length - 1));
      // Fixed allowance cloned from Hangout Posts: 2 wrong letter guesses
      // AND 2 wrong whole-word guesses per player.
      const maxFails = 2;
      return { ...base,
        word,
        guessed: Object.fromEntries(clues.map((L) => [L, 'hit'])),
        wrongLetters: [],
        letterFails: {},                         // per-player wrong-letter count
        wordFails: {},                           // per-player wrong-word-guess count
        maxFails,
      };
    }
    case 'gibberish': {                          // host supplies the phrase + answer (setup modal)
      let setup = null;
      if (_hostInputs.gibberish) setup = await _hostInputs.gibberish();
      else {
        const p = ask('🗣️ Gibberish\nEnter your nonsense phrase (e.g. "Hue Can Knot Paws"):');
        if (p === null) throw new Error('cancelled');
        const a = ask('Great!\nNow enter the correct answer for that phrase:');
        if (a === null) throw new Error('cancelled');
        setup = { phrase: p, answer: a };
      }
      if (!setup || !setup.phrase || !setup.answer) throw new Error('cancelled');
      return { ...base, rounds: [{ q: setup.phrase, a: [setup.answer] }], revealed: 0, scores: {}, solved: {} };
    }
    case 'mine':
      return { ...base, status: 'active' };      // one big MINE button — first tap wins
    case 'quiz': {
      const rounds = [];
      for (let i = 0; i < ROUNDS_PER_GAME; i++) {
        if (type === 'trivia') { const t = triviaRound(await loadTrivia()); if (t) rounds.push({ q: t.q, a: t.a, choices: t.choices }); }
        else if (type === 'math') { const m = mathRound(i); rounds.push({ q: m.q, a: [m.a] }); }
        else if (type === 'jumbled') { const j = jumbledRound(await loadJumbledWords()); rounds.push({ q: j.q, a: [j.a] }); }
        else if (type === 'countemoji') { const d = countEmojiRound(); rounds.push({ grid: d.grid, emoji: d.emoji, a: [d.a] }); }
        else if (type === 'flags') { const f = pick(await loadFlags()); rounds.push({ code: f.code, a: [f.name] }); }
        else if (type === 'emojiriddle') { const er = pick(await loadRiddles()); rounds.push({ emojis: er.emojis, a: [er.answer] }); }
        else if (type === 'guessemoji' || type === 'bringmeemoji') {
          // Race-to-5 emoji games cloned from Hangout Posts:
          // guessemoji → show the CHAR, guess its name · bringmeemoji → show the NAME, send the char
          const bank = await loadEmojiBank();
          const item = pick(bank.length ? bank : [{ c: '🍎', n: 'Red Apple' }]);
          if (type === 'guessemoji') rounds.push({ emojis: item.c, a: [item.n] });
          else rounds.push({ q: `Send me this emoji: ${item.n}`, char: item.c, a: [item.n] });
        }
        else if (type === 'periodic') {
          // Periodic Table of Elements — random mix of name & symbol rounds
          const els = await loadElements();
          const el = els.length ? pick(els) : { number: 1, symbol: 'H', name: 'Hydrogen' };
          if (Math.random() < 0.5) rounds.push({ q: `${el.symbol} · Atomic #${el.number} — which element?`, a: [el.name] });
          else rounds.push({ q: `${el.name} · Atomic #${el.number} — chemical symbol?`, a: [el.symbol] });
        }
      }
      return { ...base, rounds, revealed: 0, scores: {}, solved: {} };
    }
    default:
      return base;
  }
};
// ── Push the game message into the thread ──
export const createGame = async (type) => {
  const threadId = tid();
  if (!threadId || !me()) return;
  const meta = GAME_META[type];
  if (!meta) return;
  let game;
  try { game = await buildGame(type); } catch (e) { console.warn('[ChatGames] build failed:', e); return; }
  const text = `${meta.icon} ${meta.name}`;
  await push(ref(db, `chatMessages/${threadId}`), {
    senderId: me(), timestamp: Date.now(), text, isGame: true, game,
  });
};

// ── Board helpers ──
const TTT_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const tttWinner = (b) => {
  for (const [a, c, d] of TTT_LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? 'draw' : null;
};
const C4_MARKS = ['R', 'Y', 'G'];
const c4Winner = (b) => {
  const at = (r, c) => (r >= 0 && r < 6 && c >= 0 && c < 7 ? b[r * 7 + c] : '');
  for (const s of C4_MARKS) {
    for (let r = 5; r >= 0; r--) for (let c = 0; c < 7; c++) {
      if (at(r, c) !== s) continue;
      if (s === at(r, c+1) && s === at(r, c+2) && s === at(r, c+3)) return s;
      if (s === at(r-1, c) && s === at(r-2, c) && s === at(r-3, c)) return s;
      if (s === at(r-1, c+1) && s === at(r-2, c+2) && s === at(r-3, c+3)) return s;
      if (s === at(r-1, c-1) && s === at(r-2, c-2) && s === at(r-3, c-3)) return s;
    }
  }
  return b.every(Boolean) ? 'draw' : null;
};

// ============================================================
// ACTIONS (wired to window.ChatGames by index.js)
// ============================================================

/** Board games: players join → game goes active when the table is full.
 *  Connect 4 seats up to THREE players (🔴 host, then 🟡, then 🟢); Tic-Tac-Toe stays 2. */
export const joinGame = async (mid) => {
  const uid = me(); if (!uid) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'waiting') return g;
    if (!g.players || g.players[uid]) return g; // already started / already in
    const need = g.type === 'connect4' ? 3 : 2;
    if (Object.keys(g.players).length >= need) return g;
    const marks = g.type === 'connect4' ? ['Y', 'G'] : ['O'];
    g.players[uid] = marks[Object.keys(g.players).length - 1] || marks[marks.length - 1];
    if (Object.keys(g.players).length >= need) { g.status = 'active'; g.turn = g.hostId; }
    return g;
  });
};

/** Tic-Tac-Toe cell click / Connect-4 column click. */
export const playMove = async (mid, idx) => {
  const uid = me(); if (!uid) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'active' || g.turn !== uid) return g;
    const board = [...(g.board || [])];
    let changed = false;
    if (g.type === 'tictactoe') {
      if (!board[idx]) { board[idx] = g.players[uid] || 'X'; changed = true; }
    } else if (g.type === 'connect4') {
      const col = Number(idx);
      for (let r = 5; r >= 0; r--) {
        if (!board[r * 7 + col]) { board[r * 7 + col] = g.players[uid] || 'R'; changed = true; break; }
      }
    }
    if (!changed) return g;
    g.board = board;
    const w = g.type === 'tictactoe' ? tttWinner(board) : c4Winner(board);
    if (w === 'draw') { g.status = 'done'; g.winner = 'draw'; }
    else if (w) {
      g.status = 'done';
      g.winnerMark = w;
      g.winner = Object.keys(g.players || {}).find((u) => g.players[u] === w) || null;
    } else {
      // Rotate to the next player in join order (supports 2 or 3 players)
      const order = Object.keys(g.players || {});
      const i = order.indexOf(uid);
      g.turn = order.length ? order[(i + 1) % order.length] : null;
    }
    return g;
  });
};

/** Hangman letter guess — cloned from Hangout Posts rules:
 *  shared board reveal · 2 wrong letters per player max, then letters lock for them.
 *  Host cannot guess their own game. */
export const guessLetter = async (mid, rawLetter) => {
  const uid = me(); if (!uid) return;
  const L = String(rawLetter || '').toUpperCase().slice(0, 1);
  if (!/^[A-Z]$/.test(L)) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'active' || !g.word) return g;
    if (uid === g.hostId) return g;                   // hosts can't play their own game
    g.letterFails = g.letterFails || {};
    g.wordFails = g.wordFails || {};
    const lettersLocked = (g.letterFails[uid] || 0) >= (g.maxFails || 2)
      && (g.wordFails[uid] || 0) >= (g.maxFails || 2);
    if (lettersLocked || (g.letterFails[uid] || 0) >= (g.maxFails || 2)) return g;
    g.guessed = g.guessed || {};
    g.wrongLetters = g.wrongLetters || [];
    if (g.guessed[L] || g.wrongLetters.includes(L)) return g;   // already revealed / tried
    if (g.word.includes(L)) {
      g.guessed[L] = 'hit';
      const allFound = [...g.word].every((ch) => ch === ' ' || g.guessed[ch]);
      if (allFound) { g.status = 'done'; g.winner = uid; }
    } else {
      g.wrongLetters.push(L);
      g.letterFails[uid] = (g.letterFails[uid] || 0) + 1;
    }
    return g;
  });
};

/** Hangman whole-word guess — wrong guesses cost one of the player's 2 word tries. */
export const guessWord = async (mid, value) => {
  const uid = me(); if (!uid) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'active' || !g.word) return g;
    if (uid === g.hostId) return g;
    g.wordFails = g.wordFails || {};
    if ((g.wordFails[uid] || 0) >= (g.maxFails || 2)) return g;
    const w = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (w === g.word) { g.status = 'done'; g.winner = uid; return g; }
    g.wordFails[uid] = (g.wordFails[uid] || 0) + 1;
    return g;
  });
};

/** First to Mine — one atomic tap, first player wins. Host tapping gets 'host' back. */
export const mineNow = async (mid) => {
  const uid = me(); if (!uid) return 'signed-out';
  let result = 'late';
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'active') return g;
    if (uid === g.hostId) { result = 'host'; return g; } // hosts can't win their own game
    g.status = 'done';
    g.winner = uid;
    result = 'won';
    return g;
  });
  return result;
};

/** Quiz-style answer submit. First correct per round scores; auto-advances rounds. */
export const submitGuess = async (mid, value) => {
  const uid = me(); if (!uid || value == null) return;
  const snap = await get(gRef(mid));
  const g = snap.val();
  if (!g || g.status !== 'active' || !Array.isArray(g.rounds)) return;
  const idx = Number(g.revealed || 0);
  const round = g.rounds[idx];
  if (!round) return;
  // Trivia-style lockout: a player who already clicked a wrong choice can't answer this round
  if (round.choices && Number((g.attempts || {})[idx]?.[uid])) return;

  // Bring-Me-Emoji rounds are matched on the pasted emoji CHARACTER itself
  // (text normalization would strip emojis), with the name as fallback.
  let ok = false;
  if (round.char) {
    ok = String(value ?? '').includes(round.char);
  }
  if (!ok) {
    const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ').trim();
    const guess = norm(value);
    ok = (Array.isArray(round.a) ? round.a : [round.a])
      .some((a) => { const t = norm(a); return guess && (guess === t || guess.replace(/^(a|an|the) /, '') === t.replace(/^(a|an|the) /, '')); });
  }
  if (!ok) {
    // Wrong choice click → record the miss so this player is locked out of the current round
    if (round.choices) {
      await runTransaction(
        ref(db, `chatMessages/${tid()}/${mid}/game/attempts/${idx}/${uid}`),
        (cur) => (cur ? undefined : true),
      ).catch(() => {});
    }
    return;                                           // wrong answers stay silent (no spam writes)
  }

  // Claim this round atomically — only the first correct solver scores.
  const claim = await runTransaction(ref(db, `chatMessages/${tid()}/${mid}/game/solved/${idx}`), (cur) => (cur ? undefined : uid));
  if (!claim.committed) return;

  await runTransaction(gRef(mid), (gg) => {
    if (!gg || gg.status !== 'active') return gg;
    // Respect the wrong-choice lockout — a locked-out player can't score this round
    if ((gg.attempts || {})[idx]?.[uid]) return gg;
    gg.scores = gg.scores || {};
    gg.scores[uid] = (gg.scores[uid] || 0) + 1;
    gg.revealed = idx + 1;
    if (gg.revealed >= gg.rounds.length) {
      gg.status = 'done';
      const entries = Object.entries(gg.scores);
      if (entries.length) {
        const top = Math.max(...entries.map(([, v]) => v));
        const tops = entries.filter(([, v]) => v === top).map(([u]) => u);
        gg.winner = tops.length === 1 ? tops[0] : 'tie';
        gg.finalScores = Object.fromEntries(entries);
      } else gg.winner = null;
    }
    return gg;
  });
};

/** Host abort/close. */
export const closeGame = async (mid) => {
  if (me()) await update(gRef(mid), { status: 'closed' });
};

