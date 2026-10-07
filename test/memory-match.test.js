'use strict';

/*
 * Test suite for memory-match — run with:
 *
 *   node --test
 *
 * Coverage:
 *   - deck building: exact symbol multiset, permutation validity, validation
 *     errors, determinism per seed and order variety across seeds (sweep all
 *     sizes x many seeds)
 *   - the rules engine: flip order, ignored flips of every kind, moves
 *     counting, match/mismatch resolution, win detection, full-game solve
 *     sweep via the known deck, seeded random-play fuzz with invariants
 *   - formatTime edge cases
 *   - the page: inline scripts compile in a DOM-less sandbox, every element
 *     the script looks up exists, no external resources
 *   - UI wiring driven through a fake DOM: card flips, mismatch scheduling
 *     and resolution, stale-reply discard on new game, size switching, the
 *     timer lifecycle, and a full win with best-score tracking
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractInlineScripts(source) {
  const scripts = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(source)) !== null) {
    const openTag = match[0].slice(0, match[0].indexOf('>'));
    if (/\bsrc\s*=/i.test(openTag)) continue;
    scripts.push(match[1]);
  }
  return scripts;
}

const inlineScripts = extractInlineScripts(HTML);

// Load the page's inline script into a DOM-less sandbox: it must parse
// cleanly and define its API without touching a browser environment.
const sandbox = { console };
vm.createContext(sandbox);
for (const src of inlineScripts) {
  new vm.Script(src, { filename: 'index.html#inline' }).runInContext(sandbox);
}
const { MemoryMatch, MemoryMatchUI } = sandbox;

// -------------------------------------------------------- test-side helpers --

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isRangeError = (err) => err && err.name === 'RangeError';

// Sandbox arrays -> plain host arrays of primitives (cross-realm safe).
function deckOf(game) {
  return Array.from(game.getState().deck, (s) => String(s));
}

function countsOf(deck) {
  const counts = new Map();
  for (const s of deck) counts.set(s, (counts.get(s) || 0) + 1);
  return counts;
}

function findPartner(deck, i) {
  for (let j = 0; j < deck.length; j++) {
    if (j !== i && deck[j] === deck[i]) return j;
  }
  return -1;
}

function pickDistinctPair(deck) {
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      if (deck[i] !== deck[j]) return [i, j];
    }
  }
  return [-1, -1];
}

function stateKey(game) {
  const st = game.getState();
  return [
    st.moves,
    st.matched,
    st.won ? 'w' : '-',
    st.busy ? 'b' : '-',
    Array.from(st.faceUp).join(','),
    Array.from(st.revealed, (v) => (v ? '1' : '0')).join('')
  ].join('|');
}

// Solve a game perfectly by consulting the deck (the oracle knows every
// card). Returns the number of moves used.
function solveGame(game) {
  const deck = deckOf(game);
  const done = new Set();
  for (let i = 0; i < deck.length; i++) {
    if (done.has(i)) continue;
    const j = findPartner(deck, i);
    assert.notEqual(j, -1, `card ${i} must have a partner`);
    const first = game.flip(i);
    assert.equal(first.state, 'flip', `first flip of pair (${i}, ${j})`);
    assert.equal(String(first.symbol), deck[i]);
    const second = game.flip(j);
    assert.equal(second.state, 'match', `pair (${i}, ${j}) must match`);
    done.add(i);
    done.add(j);
  }
  return done.size / 2;
}

// --------------------------------------------------------------- page load --

test('index.html contains inline scripts that compile', () => {
  assert.ok(inlineScripts.length >= 1, 'expected at least one inline script');
  for (const src of inlineScripts) {
    assert.doesNotThrow(() => new vm.Script(src, { filename: 'index.html#inline' }));
  }
});

test('inline script defines the core and UI APIs with no DOM present', () => {
  assert.equal(typeof MemoryMatch, 'object');
  assert.equal(typeof MemoryMatch.buildDeck, 'function');
  assert.equal(typeof MemoryMatch.createGame, 'function');
  assert.equal(typeof MemoryMatch.formatTime, 'function');
  assert.equal(typeof MemoryMatch.mulberry32, 'function');
  assert.equal(MemoryMatch.SIZES.small.pairs, 6);
  assert.equal(MemoryMatch.SIZES.medium.pairs, 8);
  assert.equal(MemoryMatch.SIZES.large.pairs, 12);
  assert.equal(typeof MemoryMatchUI, 'object');
  assert.equal(typeof MemoryMatchUI.initUI, 'function');
});

test('every element the script looks up exists in the page', () => {
  const ids = new Set();
  for (const src of inlineScripts) {
    for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(m[1]);
  }
  assert.ok(ids.size >= 4, 'expected the UI to look up several elements');
  for (const id of ids) {
    assert.ok(HTML.includes('id="' + id + '"'), `missing #${id} in index.html`);
  }
});

test('the page is self-contained: no external scripts or URLs', () => {
  assert.ok(!/<script[^>]*\bsrc\s*=/i.test(HTML), 'no <script src=...> expected');
  assert.ok(!/https?:\/\//i.test(HTML), 'no external URLs expected');
});

// ------------------------------------------------------------- deck builder --

test('deck has exactly two of each symbol for every size and seed', () => {
  for (let pairs = 1; pairs <= MemoryMatch.SYMBOLS.length; pairs++) {
    for (let seed = 0; seed < 10; seed++) {
      const deck = Array.from(MemoryMatch.buildDeck(pairs, seed), (s) => String(s));
      assert.equal(deck.length, pairs * 2, `pairs ${pairs}, seed ${seed}: length`);
      const counts = countsOf(deck);
      assert.equal(counts.size, pairs, `pairs ${pairs}, seed ${seed}: distinct symbols`);
      for (const [symbol, count] of counts) {
        assert.equal(count, 2, `pairs ${pairs}, seed ${seed}: symbol ${symbol}`);
      }
      const pool = new Set(Array.from(MemoryMatch.SYMBOLS.slice(0, pairs), (s) => String(s)));
      for (const s of deck) assert.ok(pool.has(s), `unexpected symbol ${s}`);
    }
  }
});

test('deck building is deterministic per seed and varies across seeds', () => {
  const a = Array.from(MemoryMatch.buildDeck(8, 1234), (s) => String(s));
  const b = Array.from(MemoryMatch.buildDeck(8, 1234), (s) => String(s));
  assert.deepEqual(a, b, 'same seed must reproduce the same deck');

  const orderings = new Set();
  for (let seed = 0; seed < 20; seed++) {
    orderings.add(Array.from(MemoryMatch.buildDeck(8, seed), (s) => String(s)).join(''));
  }
  assert.ok(orderings.size >= 10, `expected varied shuffles, got ${orderings.size}`);

  const unseeded = MemoryMatch.buildDeck(6);
  assert.equal(unseeded.length, 12, 'unseeded decks still build');
});

test('deck building validates its arguments', () => {
  for (const bad of [0, -1, 13, 1.5, '6', null, undefined, NaN]) {
    assert.throws(() => MemoryMatch.buildDeck(bad, 1), isRangeError, `pairs=${String(bad)}`);
  }
  assert.throws(() => MemoryMatch.buildDeck(6, 'x'), isRangeError);
  assert.throws(() => MemoryMatch.buildDeck(6, {}), isRangeError);
  assert.doesNotThrow(() => MemoryMatch.buildDeck(6, undefined));
  assert.doesNotThrow(() => MemoryMatch.buildDeck(6, () => 0.5));
});

// ------------------------------------------------------------------ engine --

test('a fresh game starts unrevealed with nothing flipped', () => {
  for (const pairs of [1, 6, 8, 12]) {
    const game = MemoryMatch.createGame({ pairs, seed: 7 });
    const st = game.getState();
    assert.equal(st.pairs, pairs);
    assert.equal(st.deck.length, pairs * 2);
    assert.equal(st.moves, 0);
    assert.equal(st.matched, 0);
    assert.equal(st.won, false);
    assert.equal(st.busy, false);
    assert.equal(st.pending, null);
    assert.equal(st.faceUp.length, 0);
    assert.ok(Array.from(st.revealed).every((v) => v === false));
  }
});

test('first flip reveals a card without counting a move', () => {
  const game = MemoryMatch.createGame({ pairs: 6, seed: 3 });
  const deck = deckOf(game);
  const res = game.flip(4);
  assert.equal(res.state, 'flip');
  assert.equal(res.index, 4);
  assert.equal(String(res.symbol), deck[4]);
  const st = game.getState();
  assert.deepEqual(Array.from(st.faceUp), [4]);
  assert.equal(st.moves, 0);
  assert.equal(st.busy, false);
});

test('invalid indices and repeat clicks are ignored without mutating state', () => {
  const game = MemoryMatch.createGame({ pairs: 6, seed: 5 });
  const n = deckOf(game).length;
  for (const bad of [-1, n, 1.5, '3', null, undefined, NaN]) {
    const before = stateKey(game);
    const res = game.flip(bad);
    assert.equal(res.state, 'ignored', `flip(${String(bad)})`);
    assert.equal(res.reason, 'bad-index', `flip(${String(bad)}) reason`);
    assert.equal(stateKey(game), before, 'rejected flips must not mutate');
  }

  game.flip(2);
  const afterFirst = stateKey(game);
  const again = game.flip(2);
  assert.equal(again.state, 'ignored');
  assert.equal(again.reason, 'up');
  assert.equal(stateKey(game), afterFirst, 're-clicking the same card must not mutate');
});

test('flipping a matched card is ignored', () => {
  const game = MemoryMatch.createGame({ pairs: 6, seed: 11 });
  const deck = deckOf(game);
  const res = game.flip(0);
  assert.equal(res.state, 'flip');
  game.flip(findPartner(deck, 0));
  const afterMatch = stateKey(game);
  const again = game.flip(0);
  assert.equal(again.state, 'ignored');
  assert.equal(again.reason, 'revealed');
  assert.equal(stateKey(game), afterMatch);
});

test('matching a pair keeps both cards revealed and counts one move', () => {
  const game = MemoryMatch.createGame({ pairs: 6, seed: 9 });
  const deck = deckOf(game);
  game.flip(1);
  const second = findPartner(deck, 1);
  const res = game.flip(second);
  assert.equal(res.state, 'match');
  assert.equal(res.a, 1);
  assert.equal(res.b, second);
  assert.equal(String(res.symbol), deck[1]);
  assert.equal(res.moves, 1);
  assert.equal(res.won, false);
  const st = game.getState();
  assert.equal(st.moves, 1);
  assert.equal(st.matched, 1);
  assert.equal(st.revealed[1], true);
  assert.equal(st.revealed[second], true);
  assert.equal(st.faceUp.length, 0);
  assert.equal(st.busy, false);
});

test('a mismatch parks the game until resolveMismatch is called', () => {
  const game = MemoryMatch.createGame({ pairs: 6, seed: 13 });
  const deck = deckOf(game);
  const [i, j] = pickDistinctPair(deck);
  const third = [0, 1, 2, 3, 4, 5, 6, 7].find((k) => k !== i && k !== j);

  game.flip(i);
  const res = game.flip(j);
  assert.equal(res.state, 'mismatch');
  assert.equal(res.a, i);
  assert.equal(res.b, j);
  assert.equal(res.moves, 1);

  let st = game.getState();
  assert.equal(st.busy, true);
  assert.deepEqual(Array.from(st.faceUp), [i, j]);
  assert.equal(st.matched, 0);

  const blocked = game.flip(third);
  assert.equal(blocked.state, 'ignored');
  assert.equal(blocked.reason, 'busy');

  const pair = game.resolveMismatch();
  assert.deepEqual(JSON.parse(JSON.stringify(pair)), { a: i, b: j });
  st = game.getState();
  assert.equal(st.busy, false);
  assert.equal(st.pending, null);
  assert.equal(st.faceUp.length, 0);
  assert.equal(st.revealed[i], false, 'mismatched cards go back face down');

  const refly = game.flip(i);
  assert.equal(refly.state, 'flip', 'the same card can be flipped again after resolve');
});

test('resolveMismatch is a no-op when nothing is pending', () => {
  const game = MemoryMatch.createGame({ pairs: 6, seed: 17 });
  assert.equal(game.resolveMismatch(), null);
  const deck = deckOf(game);
  game.flip(0);
  game.flip(findPartner(deck, 0));
  assert.equal(game.resolveMismatch(), null, 'a match never needs resolving');
});

test('a one-pair game can be won in a single move', () => {
  const game = MemoryMatch.createGame({ pairs: 1, seed: 2 });
  game.flip(0);
  const res = game.flip(1);
  assert.equal(res.state, 'match');
  assert.equal(res.won, true);
  assert.equal(res.moves, 1);
  const st = game.getState();
  assert.equal(st.won, true);
  assert.equal(st.matched, 1);
});

test('when the last pair is found the game locks', () => {
  const game = MemoryMatch.createGame({ pairs: 6, seed: 21 });
  solveGame(game);
  const st = game.getState();
  assert.equal(st.won, true);
  assert.equal(st.matched, 6);
  assert.equal(st.moves, 6);
  assert.equal(st.busy, false);
  assert.ok(Array.from(st.revealed).every((v) => v === true));

  const before = stateKey(game);
  const res = game.flip(0);
  assert.equal(res.state, 'ignored');
  assert.equal(res.reason, 'won');
  assert.equal(game.resolveMismatch(), null);
  assert.equal(stateKey(game), before, 'a finished game is frozen');
});

test('oracle solve sweep: every size x seed wins in exactly `pairs` moves', () => {
  for (let pairs = 1; pairs <= MemoryMatch.SYMBOLS.length; pairs++) {
    for (let seed = 0; seed < 10; seed++) {
      const game = MemoryMatch.createGame({ pairs, seed });
      const used = solveGame(game);
      assert.equal(used, pairs, `pairs ${pairs}, seed ${seed}: moves`);
      const st = game.getState();
      assert.equal(st.won, true, `pairs ${pairs}, seed ${seed}: won`);
      assert.equal(st.moves, pairs, `pairs ${pairs}, seed ${seed}: move count`);
      assert.equal(st.matched, pairs, `pairs ${pairs}, seed ${seed}: matched`);
      assert.equal(st.busy, false);
      assert.ok(Array.from(st.revealed).every((v) => v === true));
    }
  }
});

test('seeded random play keeps every invariant (40 seeds)', () => {
  for (let seed = 0; seed < 40; seed++) {
    const pairs = 1 + (seed % MemoryMatch.SYMBOLS.length);
    const game = MemoryMatch.createGame({ pairs, seed: seed * 97 + 5 });
    const deck = deckOf(game);
    const rng = mulberry32(seed * 31 + 1);
    const n = deck.length;
    let attempts = 0;
    let steps = 0;

    while (!game.getState().won) {
      steps += 1;
      assert.ok(steps < 4000, `seed ${seed}: game must finish in bounded steps`);
      const st = game.getState();

      if (st.busy) {
        // Any valid flip while a mismatch is pending must be ignored.
        const a = st.pending.a;
        const b = st.pending.b;
        const other = deck.findIndex((_, k) => k !== a && k !== b);
        if (other !== -1) {
          const res = game.flip(other);
          assert.equal(res.state, 'ignored', `seed ${seed}: no flips while busy`);
          assert.equal(res.reason, 'busy', `seed ${seed}: busy reason`);
        }
        const pair = game.resolveMismatch();
        assert.ok(pair, `seed ${seed}: busy implies a pending pair`);
        assert.notEqual(deck[pair.a], deck[pair.b], 'a mismatch pair must differ');
      } else if (st.faceUp.length === 1 && rng() < 0.5) {
        // Perfect memory: finish the pair whose partner is known.
        const up = st.faceUp[0];
        const res = game.flip(findPartner(deck, up));
        assert.equal(res.state, 'match', `seed ${seed}: known partner must match`);
        assert.equal(String(res.symbol), deck[up]);
        attempts += 1;
        assert.equal(res.moves, attempts);
      } else {
        // Flip a random card that is neither revealed nor face-up.
        const open = [];
        for (let i = 0; i < n; i++) {
          if (!st.revealed[i] && st.faceUp.indexOf(i) === -1) open.push(i);
        }
        assert.ok(open.length >= 1, `seed ${seed}: something is always flippable`);
        const pick = open[Math.floor(rng() * open.length)];
        const res = game.flip(pick);
        if (res.state === 'flip') {
          assert.equal(res.index, pick);
          assert.equal(String(res.symbol), deck[pick]);
        } else if (res.state === 'match') {
          attempts += 1;
          assert.equal(res.moves, attempts);
          assert.equal(String(res.symbol), deck[res.a]);
          assert.equal(deck[res.a], deck[res.b], 'match must be a real pair');
        } else if (res.state === 'mismatch') {
          attempts += 1;
          assert.equal(res.moves, attempts);
          assert.notEqual(deck[res.a], deck[res.b], 'mismatch must differ');
        } else {
          assert.fail(`seed ${seed}: unexpected flip result ${JSON.stringify(res)}`);
        }
      }

      const after = game.getState();
      assert.equal(after.moves, attempts, `seed ${seed}: moves tracked`);
      assert.equal(after.busy, after.faceUp.length === 2, `seed ${seed}: busy iff two face-up`);
      const revealedCount = Array.from(after.revealed).filter(Boolean).length;
      assert.equal(revealedCount % 2, 0, `seed ${seed}: revealed cards come in pairs`);
      assert.equal(after.matched * 2, revealedCount, `seed ${seed}: matched bookkeeping`);
    }

    const final = game.getState();
    assert.equal(final.matched, pairs, `seed ${seed}: all pairs found`);
    assert.equal(final.moves, attempts, `seed ${seed}: total move count`);
  }
});

// ---------------------------------------------------------------- time fmt --

test('formatTime renders floors, pads seconds and handles bad input', () => {
  assert.equal(MemoryMatch.formatTime(0), '0:00');
  assert.equal(MemoryMatch.formatTime(1), '0:00');
  assert.equal(MemoryMatch.formatTime(999), '0:00');
  assert.equal(MemoryMatch.formatTime(1000), '0:01');
  assert.equal(MemoryMatch.formatTime(59000), '0:59');
  assert.equal(MemoryMatch.formatTime(60000), '1:00');
  assert.equal(MemoryMatch.formatTime(61000), '1:01');
  assert.equal(MemoryMatch.formatTime(599000), '9:59');
  assert.equal(MemoryMatch.formatTime(600000), '10:00');
  assert.equal(MemoryMatch.formatTime(3599000), '59:59');
  assert.equal(MemoryMatch.formatTime(3600000), '60:00');
  assert.equal(MemoryMatch.formatTime(-5), '0:00');
  assert.equal(MemoryMatch.formatTime(NaN), '0:00');
  assert.equal(MemoryMatch.formatTime(Infinity), '0:00');
});

// -------------------------------------------------------------- fake DOM ----

function makeElement(extra) {
  const listeners = {};
  const children = [];
  const el = {
    tagName: 'DIV',
    type: '',
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    attributes: {},
    children,
    style: {
      props: {},
      setProperty(name, value) { this.props[name] = String(value); }
    },
    get firstChild() {
      return children.length ? children[0] : null;
    },
    addEventListener(type, cb) {
      (listeners[type] = listeners[type] || []).push(cb);
    },
    dispatch(type, event) {
      const ev = Object.assign({ target: el, preventDefault() {} }, event || {});
      for (const cb of (listeners[type] || []).slice()) cb(ev);
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i !== -1) children.splice(i, 1);
      return child;
    }
  };
  Object.assign(el, extra || {});
  return el;
}

function setupUI(overrides = {}) {
  let clock = 10000;
  const els = {
    board: makeElement(),
    moves: makeElement(),
    pairs: makeElement(),
    time: makeElement(),
    best: makeElement(),
    size: makeElement({ value: 'medium' }),
    status: makeElement(),
    'new-game': makeElement()
  };
  const doc = {
    getElementById(id) {
      return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null;
    },
    createElement(tag) {
      return makeElement({ tagName: String(tag).toUpperCase() });
    }
  };
  const scheduled = [];
  const ui = MemoryMatchUI.initUI(doc, Object.assign({
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
    now: () => clock,
    seedFn: () => 1234
  }, overrides));
  return {
    ui,
    els,
    scheduled,
    doc,
    advance(ms) { clock += ms; },
    game() { return ui.getGame(); },
    cards() { return Array.from(ui.getCards()); },
    deck() { return deckOf(ui.getGame()); },
    batches(n = 1) {
      for (let i = 0; i < n; i++) {
        const batch = scheduled.splice(0);
        for (const entry of batch) entry.fn();
      }
    },
    queueLen() { return scheduled.length; }
  };
}

function cardClass(cards, i) {
  return cards[i].className.split(' ').filter(Boolean);
}

// -------------------------------------------------------------- UI wiring --

test('UI boots into a medium game with the board built and stats reset', () => {
  const h = setupUI();
  const cards = h.cards();
  assert.equal(cards.length, 16, 'medium = 4x4 = 16 cards');
  for (const card of cards) assert.equal(card.className, 'card');
  assert.equal(h.els.board.children.length, 16, 'all cards are in the DOM');
  assert.equal(h.els.board.style.props['--cols'], '4');
  assert.equal(h.ui.getSizeKey(), 'medium');
  assert.equal(h.game().getState().pairs, 8);
  assert.equal(h.els.moves.textContent, '0');
  assert.equal(h.els.pairs.textContent, '0/8');
  assert.equal(h.els.time.textContent, '0:00');
  assert.equal(h.els.best.textContent, '—');
  assert.equal(h.els.status.textContent, 'Flip two cards to find a pair');
  assert.equal(cards[0].getAttribute('aria-label'), 'Card 1, face down');
});

test('clicking a card reveals it, starts the timer, and schedules ticks', () => {
  const h = setupUI();
  const cards = h.cards();
  const deck = h.deck();
  cards[0].dispatch('click');
  assert.deepEqual(cardClass(cards, 0), ['card', 'up']);
  assert.equal(cards[0].textContent, deck[0]);
  assert.equal(h.els.status.textContent, 'Pick a second card');
  assert.equal(h.els.moves.textContent, '0', 'a single flip is not a move');
  assert.equal(h.queueLen(), 1, 'one timer tick is scheduled');
  assert.equal(h.scheduled[0].ms, MemoryMatch.TICK_MS);
  assert.equal(cards[0].getAttribute('aria-label'), 'Card 1, showing ' + deck[0]);

  // Re-clicking the same card is ignored.
  const before = h.queueLen();
  cards[0].dispatch('click');
  assert.deepEqual(cardClass(cards, 0), ['card', 'up']);
  assert.equal(h.queueLen(), before, 'no extra work for an ignored click');
});

test('matching two cards keeps them up and counts a move', () => {
  const h = setupUI();
  const cards = h.cards();
  const deck = h.deck();
  const partner = findPartner(deck, 0);
  cards[0].dispatch('click');
  cards[partner].dispatch('click');
  assert.deepEqual(cardClass(cards, 0), ['card', 'matched']);
  assert.deepEqual(cardClass(cards, partner), ['card', 'matched']);
  assert.equal(cards[0].disabled, true);
  assert.equal(cards[partner].disabled, true);
  assert.equal(h.els.moves.textContent, '1');
  assert.equal(h.els.pairs.textContent, '1/8');
  assert.equal(h.els.status.textContent, 'Find the matching pairs');
  assert.equal(h.queueLen(), 1, 'only the timer tick remains scheduled');
  assert.equal(cards[0].getAttribute('aria-label'), 'Card 1, matched ' + deck[0]);
});

test('a mismatch flips back on schedule and blocks clicks while busy', () => {
  const h = setupUI();
  const cards = h.cards();
  const deck = h.deck();
  const [i, j] = pickDistinctPair(deck);
  const third = cards.findIndex((_, k) => k !== i && k !== j);

  cards[i].dispatch('click');
  cards[j].dispatch('click');
  assert.deepEqual(cardClass(cards, i), ['card', 'up']);
  assert.deepEqual(cardClass(cards, j), ['card', 'up']);
  assert.equal(h.els.moves.textContent, '1');
  assert.equal(h.els.status.textContent, 'No match — flipping back…');
  assert.equal(h.queueLen(), 2, 'timer tick + resolve');
  const resolveEntry = h.scheduled.find((entry) => entry.ms === MemoryMatch.MISMATCH_MS);
  assert.ok(resolveEntry, 'the resolve is scheduled with the mismatch delay');

  cards[third].dispatch('click');
  assert.deepEqual(cardClass(cards, third), ['card'], 'third click is ignored while busy');
  assert.equal(h.els.status.textContent, 'No match — flipping back…');

  h.batches(1);
  assert.deepEqual(cardClass(cards, i), ['card'], 'cards flip back after resolve');
  assert.deepEqual(cardClass(cards, j), ['card']);
  assert.equal(h.els.status.textContent, 'Find the matching pairs');

  cards[i].dispatch('click');
  assert.deepEqual(cardClass(cards, i), ['card', 'up'], 'the same card can be played again');
});

test('New game discards a pending mismatch resolve from the old board', () => {
  const h = setupUI();
  const cards0 = h.cards();
  const deck = h.deck();
  const [i, j] = pickDistinctPair(deck);
  cards0[i].dispatch('click');
  cards0[j].dispatch('click');
  assert.equal(h.queueLen(), 2, 'tick + pending resolve');

  h.els['new-game'].dispatch('click');
  const cards1 = h.cards();
  assert.equal(cards1.length, 16);
  assert.equal(h.els.moves.textContent, '0');
  assert.ok(cards1.every((card) => card.className === 'card'), 'fresh board');
  assert.equal(h.game().getState().busy, false);

  // Now play a card on the new board, then let the stale resolve fire.
  cards1[2].dispatch('click');
  assert.deepEqual(cardClass(cards1, 2), ['card', 'up']);
  h.batches(3);
  assert.deepEqual(cardClass(cards1, 2), ['card', 'up'], 'stale callbacks must not touch the new game');
  assert.equal(h.els.moves.textContent, '0');
  assert.equal(h.els.status.textContent, 'Pick a second card');
});

test('switching size rebuilds the board with the right columns', () => {
  const h = setupUI();
  h.els.size.dispatch('change', { target: { value: 'small' } });
  assert.equal(h.ui.getSizeKey(), 'small');
  assert.equal(h.cards().length, 12);
  assert.equal(h.els.board.children.length, 12);
  assert.equal(h.els.board.style.props['--cols'], '4');
  assert.equal(h.els.pairs.textContent, '0/6');
  assert.equal(h.game().getState().pairs, 6);

  h.els.size.dispatch('change', { target: { value: 'large' } });
  assert.equal(h.ui.getSizeKey(), 'large');
  assert.equal(h.cards().length, 24);
  assert.equal(h.els.board.style.props['--cols'], '6');
  assert.equal(h.els.pairs.textContent, '0/12');
  const counts = countsOf(h.deck());
  assert.equal(counts.size, 12, 'large boards use all twelve symbols');
  for (const count of counts.values()) assert.equal(count, 2);

  h.els.size.dispatch('change', { target: { value: 'nonsense' } });
  assert.equal(h.ui.getSizeKey(), 'large', 'an unknown size keeps the current board size');
});

test('the timer starts on the first flip, ticks, and freezes on a win', () => {
  const h = setupUI();
  assert.equal(h.ui.getElapsedMs(), 0);
  h.advance(61000);
  assert.equal(h.els.time.textContent, '0:00', 'the clock does not run before the first flip');

  const cards = h.cards();
  const deck = h.deck();
  cards[0].dispatch('click');
  h.advance(61000);
  h.batches(1);
  assert.equal(h.els.time.textContent, '1:01', 'ticks show elapsed time');
  assert.equal(h.queueLen(), 1, 'the next tick is queued');

  // Complete the first pair, then solve every remaining pair.
  cards[findPartner(deck, 0)].dispatch('click');
  for (let i = 0; i < deck.length; i++) {
    if (cards[i].disabled) continue;
    const j = findPartner(deck, i);
    cards[i].dispatch('click');
    cards[j].dispatch('click');
  }
  assert.equal(h.game().getState().won, true);

  const wonTime = h.els.time.textContent;
  h.advance(120000);
  h.batches(3);
  assert.equal(h.els.time.textContent, wonTime, 'the clock stops at the win');
  assert.equal(h.queueLen(), 0, 'no more ticks are scheduled after a win');
});

test('a full win through clicks updates status, best score, and locks the board', () => {
  const h = setupUI();
  const cards = h.cards();
  const deck = h.deck();

  for (let i = 0; i < deck.length; i++) {
    if (cards[i].disabled) continue;
    const j = findPartner(deck, i);
    cards[i].dispatch('click');
    cards[j].dispatch('click');
  }

  assert.equal(h.game().getState().won, true);
  assert.ok(cards.every((card) => card.className.includes('matched')));
  assert.equal(h.els.pairs.textContent, '8/8');
  assert.equal(h.els.moves.textContent, '8');
  assert.equal(h.els.status.textContent, 'You win — 8 moves, 0:00 (new best)');
  assert.equal(h.els.best.textContent, '8 moves · 0:00');

  const before = h.els.moves.textContent;
  cards[0].dispatch('click');
  assert.equal(h.els.moves.textContent, before, 'clicks after the win are ignored');

  // A second, worse game must not dethrone the best score.
  h.els['new-game'].dispatch('click');
  const cards2 = h.cards();
  const [i, j] = pickDistinctPair(deck);
  cards2[i].dispatch('click');
  cards2[j].dispatch('click');
  h.batches(1); // resolve the deliberate mismatch
  for (let a = 0; a < deck.length; a++) {
    if (cards2[a].disabled) continue;
    const b = findPartner(deck, a);
    cards2[a].dispatch('click');
    cards2[b].dispatch('click');
  }
  assert.equal(h.game().getState().won, true);
  assert.equal(h.els.moves.textContent, '9');
  assert.equal(h.els.status.textContent, 'You win — 9 moves, 0:00');
  assert.equal(h.els.best.textContent, '8 moves · 0:00', 'best score survives a worse game');
});

test('best scores are tracked per board size', () => {
  const h = setupUI();
  h.els.size.dispatch('change', { target: { value: 'small' } });
  const cards = h.cards();
  const deck = h.deck();
  for (let i = 0; i < deck.length; i++) {
    if (cards[i].disabled) continue;
    const j = findPartner(deck, i);
    cards[i].dispatch('click');
    cards[j].dispatch('click');
  }
  assert.equal(h.els.best.textContent, '6 moves · 0:00');

  h.els.size.dispatch('change', { target: { value: 'medium' } });
  assert.equal(h.els.best.textContent, '—', 'medium has no best score yet');
  h.els.size.dispatch('change', { target: { value: 'small' } });
  assert.equal(h.els.best.textContent, '6 moves · 0:00', 'the small best score is remembered');
});
