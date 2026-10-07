# memory-match

Classic Memory Match for the browser: flip two cards at a time and find every
matching pair. Three board sizes, a move counter, a live timer, and a
per-size best score — all in a single self-contained `index.html`.

No build step, no dependencies, no server. Open it in any modern browser.

## Features

- Three board sizes: Small (4×3), Medium (4×4), Large (6×4)
- Flip two cards per move — matches stay face-up, misses flip back
- Move counter, live timer, and a best score remembered per board size
- Seeded, reproducible shuffles under the hood — every game is a fresh seed
- Keyboard-friendly: cards are real buttons with accessible labels

## Run

Open `index.html` in any modern browser. That is the whole game.

## Tests

```
node --test
```

The suite covers the deck builder (exact symbol multiset, deterministic
seeding, order variety across seeds, all sizes), the rules engine (flip
order, every ignored-flip kind, move counting, match/mismatch resolution,
win detection and game locking, a full solve sweep across all sizes ×
seeds, and a seeded random-play fuzz that re-checks every invariant each
step), time formatting, and the page wiring through a fake DOM (card
clicks, deferred mismatch flip-back with stale-reply discard on new game,
size switching, the timer lifecycle, and full wins with best-score
tracking).

## License

MIT
