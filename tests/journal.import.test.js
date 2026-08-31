/*
 * Alpaca's fills, paired back into trades a journal can hold.
 *
 * WHY IT WAS NEEDED. The journal's only ways in were a pasted CSV and typing,
 * so a day the desk traded automatically produced no journal entry at all. The
 * page said it out loud without meaning to: "Alpaca — connected · 3 name(s)
 * filled on 2026-08-19" sitting directly above "0 trades".
 *
 * A FILL IS NOT A TRADE, and that is the whole difficulty. Alpaca reports
 * prints — `sell_short 270 WULF @ 15.26`, `sell_short 271 @ 15.25`, `buy 270 @
 * 14.64` — and a journal row is a round trip with one entry, one exit and a
 * result. The join between them is the running position, and every case below
 * is a way that join can be got wrong in a manner nobody would notice:
 *
 *   the wrong entry price      a 541-share short filled in two prints entered
 *                              at NEITHER of them. First-print or last-print
 *                              pricing gives a journal whose P&L disagrees with
 *                              the account, which makes it worthless.
 *   a reversal as one trade    direction changing halfway through, and a result
 *                              that means nothing.
 *   a half exit as a result    a fragment that reads like a closed trade.
 *   the open trade dropped     a day looks quiet while a position is running.
 */

const { tradesFrom } = require('../src/broker/journalTrades');

/** One Alpaca fill, as src/alpaca/account.js hands it over. */
let seq = 0;
const fill = (over = {}) => ({
  id: `f${seq += 1}`, symbol: 'WULF', side: 'buy', qty: 100, price: 10,
  at: '2026-08-19T13:36:00Z', type: 'fill', ...over,
});
beforeEach(() => { seq = 0; });

/* 13:36Z is 09:36 in New York — inside the session, on the 19th. */
const at = hhmmss => `2026-08-19T${hhmmss}Z`;

// ── the simple round trip ──────────────────────────────────────────────────

describe('one entry, one exit', () => {
  const simple = () => tradesFrom([
    fill({ side: 'buy', qty: 100, price: 10, at: at('13:36:00') }),
    fill({ side: 'sell', qty: 100, price: 11, at: at('15:00:00') }),
  ]);

  test('becomes one closed trade', () => {
    const t = simple();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ ticker: 'WULF', direction: 'Long', shares: 100,
                                 entryPrice: 10, exitPrice: 11, status: 'closed' });
  });

  /* The date and the times are NEW YORK's — a session belongs to a date there. */
  test('the date and times are in New York, not UTC', () => {
    const t = simple()[0];
    expect(t.date).toBe('2026-08-19');
    expect(t.entryTime).toBe('09:36:00');
    expect(t.exitTime).toBe('11:00:00');
  });

  test('a short is recorded as one, and read the right way round', () => {
    const t = tradesFrom([
      fill({ side: 'sell_short', qty: 50, price: 20, at: at('13:36:00') }),
      fill({ side: 'buy', qty: 50, price: 18, at: at('14:00:00') }),
    ])[0];
    expect(t.direction).toBe('Short');
    expect(t.entryPrice).toBe(20);
    expect(t.exitPrice).toBe(18);
  });
});

// ── the arithmetic that decides whether the journal is worth anything ──────

describe('the price', () => {
  /*
   * WEIGHTED, never the first print and never the last. This is the WULF trade:
   * 541 shares short in two prints. It entered at neither 15.26 nor 15.25.
   */
  test('several entry prints average by size', () => {
    const t = tradesFrom([
      fill({ side: 'sell_short', qty: 270, price: 15.26, at: at('13:36:00') }),
      fill({ side: 'sell_short', qty: 271, price: 15.25, at: at('13:36:02') }),
      fill({ side: 'buy', qty: 541, price: 14.60, at: at('15:00:00') }),
    ])[0];
    expect(t.shares).toBe(541);
    // (270×15.26 + 271×15.25) / 541
    expect(t.entryPrice).toBeCloseTo(15.255, 3);
  });

  /* A scale-out exits at none of its legs either. */
  test('a scale-out exit averages by size', () => {
    const t = tradesFrom([
      fill({ side: 'sell_short', qty: 100, price: 20, at: at('13:36:00') }),
      fill({ side: 'buy', qty: 50, price: 18, at: at('14:00:00') }),
      fill({ side: 'buy', qty: 50, price: 16, at: at('14:30:00') }),
    ])[0];
    expect(t.status).toBe('closed');
    expect(t.exitPrice).toBe(17);
    expect(t.exitTime).toBe('10:30:00');       // the LAST exit closed it
  });

  test('the entry time is the FIRST print, not the largest', () => {
    const t = tradesFrom([
      fill({ side: 'buy', qty: 1, price: 10, at: at('13:36:00') }),
      fill({ side: 'buy', qty: 999, price: 10, at: at('13:40:00') }),
      fill({ side: 'sell', qty: 1000, price: 11, at: at('15:00:00') }),
    ])[0];
    expect(t.entryTime).toBe('09:36:00');
  });
});

// ── what is not a result ───────────────────────────────────────────────────

describe('a position that is still on', () => {
  /*
   * A trade taken this morning and still open at noon is REAL and the journal
   * should show it. Leaving it out until it closes is how a day looks quiet
   * while it is not.
   */
  test('is included, as open, with no exit', () => {
    const t = tradesFrom([fill({ side: 'sell_short', qty: 541, price: 15.26 })]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: 'open', exitPrice: null, exitTime: null });
  });

  /*
   * A HALF-CLOSED POSITION HAS NO RESULT. Its exit price is a fragment that
   * reads like one, and a journal row carrying it would report a finished trade
   * that is still running.
   */
  test('half closed is still open, and carries no exit price', () => {
    const t = tradesFrom([
      fill({ side: 'sell_short', qty: 541, price: 15.26, at: at('13:36:00') }),
      fill({ side: 'buy', qty: 270, price: 14.64, at: at('14:30:00') }),
    ])[0];
    expect(t.status).toBe('open');
    expect(t.exitPrice).toBeNull();
    expect(t.shares).toBe(541);
  });
});

// ── the ways one trade is really two ───────────────────────────────────────

describe('more than one trade in a name', () => {
  test('flat in between is two separate trades', () => {
    const t = tradesFrom([
      fill({ side: 'buy', qty: 100, price: 10, at: at('13:36:00') }),
      fill({ side: 'sell', qty: 100, price: 11, at: at('14:00:00') }),
      fill({ side: 'buy', qty: 100, price: 12, at: at('15:00:00') }),
      fill({ side: 'sell', qty: 100, price: 13, at: at('16:00:00') }),
    ]);
    expect(t).toHaveLength(2);
    expect(t.map(x => x.entryPrice)).toEqual([10, 12]);
  });

  /*
   * A REVERSAL IS TWO TRADES. One fill big enough to flatten a short AND open a
   * long is split at the flat point. Treating it as one produces a trade whose
   * direction changed halfway through and whose P&L is meaningless.
   */
  test('a fill that flips the position is split at flat', () => {
    const t = tradesFrom([
      fill({ side: 'sell_short', qty: 100, price: 20, at: at('13:36:00') }),
      fill({ side: 'buy', qty: 150, price: 18, at: at('14:00:00') }),
      fill({ side: 'sell', qty: 50, price: 19, at: at('15:00:00') }),
    ]);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ direction: 'Short', shares: 100,
                                 entryPrice: 20, exitPrice: 18, status: 'closed' });
    expect(t[1]).toMatchObject({ direction: 'Long', shares: 50,
                                 entryPrice: 18, exitPrice: 19, status: 'closed' });
  });

  test('two names are two trades, never merged', () => {
    const t = tradesFrom([
      fill({ symbol: 'WULF', side: 'buy', qty: 10, price: 10, at: at('13:36:00') }),
      fill({ symbol: 'EYPT', side: 'buy', qty: 20, price: 5, at: at('13:37:00') }),
    ]);
    expect(t.map(x => x.ticker).sort()).toEqual(['EYPT', 'WULF']);
  });
});

// ── robustness, because activities come back paged ─────────────────────────

describe('what it tolerates', () => {
  /*
   * Activities are PAGED, and a page boundary is not a chronology. Fills
   * arriving out of order must not invent a reversal.
   */
  test('fills out of order are sorted before pairing', () => {
    const t = tradesFrom([
      fill({ side: 'sell', qty: 100, price: 11, at: at('15:00:00') }),
      fill({ side: 'buy', qty: 100, price: 10, at: at('13:36:00') }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ direction: 'Long', entryPrice: 10, exitPrice: 11 });
  });

  test('a zero-quantity or unpriced row is ignored, not counted', () => {
    const t = tradesFrom([
      fill({ side: 'buy', qty: 0, price: 10 }),
      fill({ side: 'buy', qty: 100, price: 0 }),
    ]);
    expect(t).toEqual([]);
  });

  test('nothing in is nothing out', () => {
    expect(tradesFrom([])).toEqual([]);
    expect(tradesFrom()).toEqual([]);
  });

  test('the lower-cased symbol from the wire comes back upper-cased', () => {
    expect(tradesFrom([fill({ symbol: 'wulf', qty: 1 })])[0].ticker).toBe('WULF');
  });
});

// ── importing the same day twice ───────────────────────────────────────────

describe('the id it imports under', () => {
  /*
   * A DAY IS IMPORTED TWICE AS A MATTER OF COURSE — once while it is running,
   * once after the bell — so a stable id is not a nicety. Without it the second
   * import is a second copy of every trade.
   */
  test('is derived from the trade\'s first fill, so it never moves', () => {
    const rows = [
      fill({ id: 'FILL1', side: 'buy', qty: 100, price: 10, at: at('13:36:00') }),
      fill({ id: 'FILL2', side: 'sell', qty: 100, price: 11, at: at('15:00:00') }),
    ];
    expect(tradesFrom(rows)[0].extId).toBe('alpaca:FILL1');
    // Same fills, asked again — and the same id.
    expect(tradesFrom(rows)[0].extId).toBe('alpaca:FILL1');
  });

  /* Re-running a day that has since closed keeps the id and gains the exit. */
  test('an open trade keeps its id when the exit arrives', () => {
    const entry = fill({ id: 'FILL1', side: 'buy', qty: 100, price: 10, at: at('13:36:00') });
    const open = tradesFrom([entry])[0];
    const shut = tradesFrom([entry,
      fill({ id: 'FILL2', side: 'sell', qty: 100, price: 11, at: at('15:00:00') })])[0];
    expect(open.extId).toBe(shut.extId);
    expect(open.status).toBe('open');
    expect(shut.status).toBe('closed');
  });

  test('two trades in one name get different ids', () => {
    const t = tradesFrom([
      fill({ id: 'A', side: 'buy', qty: 10, price: 10, at: at('13:36:00') }),
      fill({ id: 'B', side: 'sell', qty: 10, price: 11, at: at('14:00:00') }),
      fill({ id: 'C', side: 'buy', qty: 10, price: 12, at: at('15:00:00') }),
    ]);
    expect(t[0].extId).not.toBe(t[1].extId);
  });

  test('every row says it came from the broker, not from a person', () => {
    expect(tradesFrom([fill({ qty: 1 })])[0].source).toBe('alpaca');
  });
});

// ── the two ends that carry it ─────────────────────────────────────────────

describe('the endpoint', () => {
  const fs = require('fs');
  const path = require('path');
  const SERVER = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'alerts', 'server.js'), 'utf8');
  const at2 = SERVER.indexOf("app.get('/api/broker/journal-trades'");
  /*
   * THE WHOLE HANDLER, bounded by the route that follows it.
   *
   * This was a fixed 2,200-character slice, which is a test that fails when a
   * comment is added — and it did: the setup-tagging assertion below started
   * failing because the code it looks for had moved past the window, not
   * because it had gone. A window measured in characters is a window that
   * expires.
   */
  const next2 = SERVER.indexOf("\napp.", at2 + 1);
  const body = SERVER.slice(at2, next2 > at2 ? next2 : SERVER.length);

  test('exists, and answers for a window of days', () => {
    expect(at2).toBeGreaterThan(-1);
    expect(body).toMatch(/Number\(req\.query\.days\)/);
  });

  /* Bounded. Activities are paged and a year of them is not a page. */
  test('the window is capped', () => {
    expect(body).toMatch(/Math\.min\(90/);
  });

  /* The pre-market counts — an order placed at 09:29 is that day's trade. */
  test('the window starts before the open', () => {
    expect(body).toMatch(/T04:00:00-04:00/);
  });

  /*
   * The setup is joined on here rather than left for a person to remember a
   * week later — it is what per-setup expectancy is computed from.
   */
  test('it tags each trade with the setup that took it', () => {
    expect(body).toMatch(/broker\.setupBySymbol\(t\.date\)/);
    expect(body).toMatch(/if \(g && !g\.ambiguous\)/);
  });

  test('a failure is ok:false, not a 500', () => {
    expect(body).toMatch(/res\.json\(\{ ok: false, error: err\.message \}\)/);
    expect(body).not.toMatch(/status\(5\d\d\)/);
  });
});

describe('the journal end', () => {
  const fs = require('fs');
  const path = require('path');
  const SH = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'journal-tool.sh'), 'utf8');

  /*
   * NOT the journal's own POST /trades. That route mints its own uuid and
   * hardcodes source='manual' — so importing a day twice would make a second
   * copy of every trade, and every imported row would claim to be typed by
   * hand.
   */
  test('imports under the desk\'s id, so a re-import is not a second copy', () => {
    expect(SH).toMatch(/app\.post\('\/api\/journal\/import-alpaca'/);
    expect(SH).toMatch(/ON CONFLICT\(id\) DO UPDATE SET/);
  });

  test('and marks the source as the broker, not as manual', () => {
    expect(SH).toMatch(/'alpaca',0,\?\)/);
  });

  /*
   * THE UPDATE IT EXISTS FOR: imported at 11:00 while running, imported again
   * after the bell with its exit.
   */
  test('an open trade gains its exit on the second import', () => {
    expect(SH).toMatch(/exit_price=excluded\.exit_price/);
    expect(SH).toMatch(/status=excluded\.status/);
  });

  /* A closed trade is never rewritten — by then a person may have annotated it. */
  test('a trade already final is left alone', () => {
    expect(SH).toMatch(/if \(was && was\.status === 'closed'\) \{ skipped \+= 1; continue; \}/);
  });

  test('a setup a person chose is never blanked', () => {
    expect(SH).toMatch(/setup_id=COALESCE\(journal_trades\.setup_id, excluded\.setup_id\)/);
  });
});

describe('the page', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'journal', 'patch.js'), 'utf8');

  test('has a button, with a window to choose', () => {
    expect(SRC).toMatch(/Import from Alpaca/);
    expect(SRC).toMatch(/last 90 days/);
  });

  test('it asks the desk, then hands the result to the journal', () => {
    expect(SRC).toMatch(/api\/broker\/journal-trades\?days=/);
    expect(SRC).toMatch(/\/api\/journal\/import-alpaca/);
  });

  /* A new row is invisible until the journal reloads its own array. */
  test('the list is reloaded afterwards, or the import looks like it failed', () => {
    expect(SRC).toMatch(/if \(typeof window\.loadAll === 'function'\) window\.loadAll\(\)/);
  });

  test('an empty window says so rather than reporting an import of nothing', () => {
    expect(SRC).toMatch(/no Alpaca trades in that window/);
  });

  /*
   * THE LINK THAT WENT NOWHERE. The header's "← Dashboard" is href="/", which
   * on this port is the journal itself — a link to the page you are already on.
   */
  test('the dashboard link points at the landing page, on its own port', () => {
    expect(SRC).toMatch(/LANDING_PORT = 3000/);
    expect(SRC).toMatch(/a\[href="\/"\]/);
    expect(SRC).toMatch(/← Trade Desk/);
  });

  test('and it is only rewritten once', () => {
    expect(SRC).toMatch(/if \(!a \|\| a\.dataset\.jnlFixed\) return;/);
  });
});
