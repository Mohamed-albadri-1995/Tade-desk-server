# qp — the view, not the function

Planned 2026-08-20. Nothing here changes a calculation, a strategy, or an
order. Four surfaces, the same two faults on all of them.

## The two faults

Both were diagnosed on the alerts page and the screeners page (fixed in
16672dd) by comparing them against the references the trader collected —
QuantConnect's live-deploy, backtest and optimizer pages, a TP/SL settings
card, and six TradingView overlays. Neither reference ever does either of
these:

1. **State is written as prose.** "Watching 41 symbols across 3 setups, last
   scan 09:34:02" is a sentence you have to parse. Every reference prints the
   same thing as labelled numbers you read at a glance.
2. **The answer sits below the explanation.** The warnings, the controls and
   the notes come first and the result is underneath. Every reference puts the
   result on top and folds the explanation away beneath it.

## The foundation already exists

`public/desk.css` holds the tokens, the one-meaning-per-colour language, the
`.card` and the `.strip` primitive. `quant-platform/chart/static/desk.css` is a
byte-for-byte copy, enforced by `tests/desk.shared.test.js`, so qp already has
the whole language. **No new CSS vocabulary is needed for any of this.**

## 1 — the chart header (`:8765/`)

*Now* — seven buttons of equal visual weight (`Compute`, `▶ Live`, `☰ Panel`,
`⋯ More`, `⚡ Strategy`, `🖨 Print R1`, `🔔 Alerts`), no hierarchy, and the only
state on screen is the build hash floating right.

*Becomes* — one primary action (`Compute`); symbol and timeframe grouped as the
input cluster; the remaining five collapse into the single `⋯` menu that
already exists. A `.strip` under the toolbar carries the state as numbers:
symbol · timeframe · feed · bars loaded · as-of · build.

## 2 — the strategy drawer, SL/TP row

*Now* — `SL [off▾][1.5]  TP [off▾][1.5]` inline, 52px inputs, and the risk the
settings actually produce is never shown. Reference: the dark TP/SL card.

*Becomes* — one card per leg (Stop / Target / Runner). Each carries its type,
its value, **and the level and R it produces, live**. A summary line above
them: `1 SL / 1 TP + runner (50%) — 2.00R`. Same sentence the desk already
prints for the setup, so the builder and the alert agree word for word.

## 3 — the backtest report (`/api/backtest/{id}/report`)

*Now* — warnings and coverage notes in prose above the numbers. Reference:
QuantConnect's backtest page.

*Becomes* — a `.strip` across the top: trades · win% · avg R · max drawdown ·
net · fill model. Equity curve beneath it. The existing `(fact, why)` fold is
kept exactly as it is but moves **below** the numbers as a row of chips. Trades
table last.

## 4 — the alerts panel (`/api/alerts/status`)

*Now* — a status string. Reference: QuantConnect's live-deploy page.

*Becomes* — the same six-cell `.strip` language the desk alerts page now uses:
watching · setups · last scan · signals today · errors · next decision. The two
pages then read identically, which is the point of having one design system.

## Not in scope

- The chart canvas itself. It is dense on purpose and the TradingView
  references are dense in the same way.
- The optimizer page. It does not exist yet.
- Anything behind the view: no strategy, no simulation, no order path.

## Order of work

3 first (the backtest report is the page read most often and is generated
server-side, so it is self-contained), then 4, then 1, then 2. 2 is last
because the drawer is the densest markup in the file and the R-preview needs a
number the client does not currently compute.
