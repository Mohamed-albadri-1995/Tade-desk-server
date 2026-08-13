# Backlog

Raised, not built. Newest last. Each item is the same four headings so it can
be picked up without re-deriving the problem.

| # | Item | Kind |
|---|------|------|
| 1 | [Setups that fire on an action, not at a time](#1--setups-that-fire-on-an-action-not-at-a-time) | scheduling |
| 2 | [The alert card is unorganised](#2--the-alert-card-is-unorganised) | design |
| 3 | [The setup card is a wall of sentences](#3--the-setup-card-is-a-wall-of-sentences) | design |

---

## 1 · Setups that fire on an action, not at a time

### Asked
A setup that decides when something *happens* — a level breaks, price crosses
VWAP — not at a fixed minute. And then the page must refresh far more often,
because there is no known minute to watch.

### Collides with
- **Every setup is a clock.** qp carries `risk.window_start` (HHMM);
  `catalog.hhmm()` makes it `decisionTime`; a strategy without one is not a
  setup at all.
- **The scheduler fires once**, one minute after the decision bar
  (`minutesBefore(now, 1)`) — because the 09:35 bar closes at 09:36:00. One cron
  minute per setup.
- **The page polls fast only around known minutes**, driven by `DECISIONS`.
  Nothing to key on without a fixed time.
- **The lag diagnostic assumes one bar.** `feedLag()` measures publication
  against *the close of the decision bar*.

### Would change
- **qp first.** A watch setup is a window (`from`–`to`) plus a condition, not a
  `window_start`. Inventing it on this side would put the live rule out of step
  with the backtest.
- **Scheduler** → a watch loop, every bar through the window. Cost is one qp
  `decide` per tool per bar.
- **Dedupe** → a per-(setup, ticker, session) latch. True for ten bars must fire
  once.
- **Poll cadence** → a third state: *armed and the window is open* → fast for the
  whole window.
- **Lag** → measured against the bar that triggered, which the fire must carry.
- **Not affected:** sizing, the standard account, ratios, modes. This is a
  scheduling change, not a money change.

### Open question
Closed bars only, or intrabar? Closed matches the backtest. Intrabar is faster
and cannot be backtested the same way. That choice decides most of the rest.

---

## 2 · The alert card is unorganised

### Asked
The information on a fired alert is right; it is thrown at the screen rather
than arranged. (Screenshot: SHORT ZTG, OR + VWAP 09:35.)

### What is wrong with it

- **Everything is said twice.** `entry 9.94 stop 10.25 target 9.31 shares 80`
  appears in the sentence *and* again in the key-value run underneath.
- **A paragraph is doing a table's job.** "SHORT 80 ZTG — now ~9.94, stop 10.25
  (VWAP, fixed), target 9.31 · risk 3.13% · 3.13% from VWAP · NOTE: …" is one
  run-on line carrying four different kinds of thing.
- **The warning is buried mid-sentence.** "the stop trails an indicator — it
  will NOT follow, manage it yourself" is the most consequential line on the
  card and it is inside a clause.
- **Nine key-value pairs wrap arbitrarily**, so `lag -31s EARLY` ends up sitting
  beside the `review order…` button.
- **The action is inline with the data** and reads as another field.
- **No hierarchy at all.** Four questions are mixed together:
  what do I do · where are the levels · how much · is anything wrong.

### Would change
Four zones, in the order they are asked, and each fact appearing **once**:

1. **Do** — `SHORT · ZTG · 80 shares`, largest thing on the card.
2. **Levels** — ENTRY / STOP / TARGET as three fixed columns, monospace, not
   prose. Risk per share and R beneath them.
3. **Money** — position value, risk $, and the per-account share counts.
4. **Wrong?** — the trailing-stop note and the caution, as their own block, in
   the warning colour. Not a clause.
5. **Actions** — a row of their own, separated from data.
6. **Diagnostics** — extension, feed, lag, exit shape: folded behind `? why`,
   because they are read after the fact, not at 09:36.

`describePick()` in `src/setups/runner.js` builds the sentence and
`histNumbers()` in `alerts.html` builds the key-value run — the duplication is
between those two, and one of them has to stop carrying levels.

### Watch out
The `detail` string is what a **push notification** shows on a locked phone,
where there is no card and no zones — so it must stay a readable sentence even
after the card stops rendering it as one. Two audiences, one field.

---

## 3 · The setup card is a wall of sentences

### Asked
> "I get scared when I see all the sentences."

(Screenshot: Setups tab, `T2 09:35 OR + VWAP`.)

### What is wrong with it

- **The same warning, twice, once per side.** "short: leg 1 stop follows an
  indicator…" and "long: leg 1 stop follows an indicator…" are the identical
  sentence. Same again for the runner. Four lines carrying two facts.
- **The bullets and the meta line say the same thing.** "Ranked by
  vwap_extension, top 6" is a bullet *and* is in the `extra scan 09:33 · feed:
  yahoo · ranked by vwap_extension, top 6 · max 6 order(s)/day` run underneath.
- **ORDERS is a sentence where it should be a state.** "alert only — no broker
  account runs it (add it to one under Settings → Broker accounts)" is a status
  plus an instruction plus a location, in one line, in grey.
- **Every warning is full-width prose in one colour**, so four of them read as a
  paragraph rather than as four items.
- **Nothing is folded.** The card is at its longest on the day you know the
  setup best.

### Would change

- **Deduplicate by side.** If long and short produce the same warning, print it
  once, unlabelled. Only prefix `short:` / `long:` when they actually differ —
  which is the case worth seeing.
- **One fact, one place.** The bullets describe *the strategy* (what it is); the
  meta line describes *this deployment* (when it scans, which feed, how many).
  Ranking belongs to the deployment. Levels came out of the alert-card sentence
  for the same reason.
- **ORDERS becomes a chip, not a sentence** — `ALERT ONLY` in the off colour,
  with the fix behind `? why`.
- **Warnings become a list**, one line each, icon aligned, capped at two visible
  with "+2 more".
- **Fold the description.** The three bullets are what the setup *is* — read
  once, when it is set up. Behind `? what this setup does`.

### Shared root cause with item 2
Both cards have the same two faults, and they are worth fixing together because
the fix is one decision:

1. **Prose is used where a table belongs.** A sentence forces the reader to
   parse; a column lets them look.
2. **Facts appear more than once**, because two functions each decided to be
   helpful — `describePick()` and `histNumbers()` on the alert card,
   `describe[]` and `st-meta` on the setup card.

Rule to apply to both: **every fact appears exactly once, in the zone that owns
it, and prose is reserved for the parts that are genuinely sentences** (a
warning, a caution). Everything else is a label and a value.
