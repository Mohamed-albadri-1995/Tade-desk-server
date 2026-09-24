/*
 * DOES THE LIVE DESK DO WHAT THE BACKTEST TESTED?
 *
 * The desk was built to reproduce a backtest, and after two weeks of live
 * trading it had not. Three settings differed, in three separate files, and
 * nothing anywhere compared them — so each was invisible on its own and the
 * only symptom was a P&L that did not match.
 *
 * The differences are not exotic. They are ordinary configuration:
 *
 *   THE DECISION BAR. The one that cost the most and hid the best. A setup's
 *   window pins the ENTRY minute, so on a one-minute window the FILL MODEL
 *   decides which bar the conditions are read on:
 *
 *       'next_open' / 'desk'   entry at the 09:35 OPEN,  decided on 09:34
 *       'close'                entry at the 09:35 CLOSE, decided on 09:35
 *
 *   Both are legitimate and both satisfy a 935 window. They are also a
 *   different bar's close, VWAP and ATR — so they produce DIFFERENT SIGNALS,
 *   not merely different prices. The live desk runs 'close'; every backtest of
 *   the 09:35 setup has been run on 'next_open'.
 *
 *   RISK SIZING. Live risks a flat dollar (riskPerTrade). The backtest offered
 *   only a percentage of equity until recently, and a percentage COMPOUNDS.
 *
 *   THE POSITION CAP. Live sends maxPositionPct; a backtest run without one is
 *   a different book — the first tight stop takes the balance and the rest of
 *   the day is skipped for lack of capital, in arrival order.
 *
 *   THE RANKING. Metric and count, which decide WHICH of the day's signals get
 *   taken at all.
 *
 * This module states both sides of each and says whether they agree. It reads
 * the desk's own configuration and the qp strategy as qp reports it; it
 * invents nothing and defaults nothing, because a default here would be a
 * fourth place for the two sides to differ.
 *
 * A check that cannot be made is reported as UNKNOWN, never as a match.
 */

const prefs = require('./prefs');
const risk = require('./risk');
const { liveFeedFor } = require('./feeds');

/** '09:35' from qp's integer HHMM. Null stays null — absent is not midnight. */
function hhmm(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const h = Math.floor(v / 100);
  const m = v % 100;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** hhmm string ± minutes, as a string. */
function shift(time, mins) {
  if (!time) return null;
  const [h, m] = String(time).split(':').map(Number);
  const t = h * 60 + m + mins;
  if (!Number.isFinite(t) || t < 0 || t >= 24 * 60) return null;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/*
 * WHICH BAR'S CONDITIONS A FILL MODEL READS, given the entry window.
 *
 * The window pins the FILL bar (chart/strategy.py, pinned by logic_audit31).
 * So under a model that fills at the next bar's open, the signal bar is the
 * one BEFORE the window; under 'close' the signal bar IS the window bar.
 *
 * Only meaningful for a CLOCK setup — window_start === window_end. Where the
 * window is a range the entry may fire on any bar inside it and there is no
 * single decision bar to compare, which is reported rather than guessed.
 */
function decisionBar(windowStart, windowEnd, fill) {
  const at = hhmm(windowStart);
  const until = hhmm(windowEnd);
  if (!at) return { bar: null, why: 'the strategy has no entry window' };
  if (until && until !== at) {
    return { bar: null, why: `a ${at}–${until} window fires on any bar inside it` };
  }
  if (fill === 'close') return { bar: at, why: `fill 'close' decides on the ${at} bar` };
  // 'live' belongs with the next-open models, not with 'close'. It measures
  // every level from the decision bar's close exactly as 'desk' does; the only
  // difference is that it does not need the fill bar to exist yet, which is
  // what lets the desk take the backtest's decision in real time.
  if (fill === 'next_open' || fill === 'desk' || fill === 'live') {
    const prev = shift(at, -1);
    return { bar: prev, why: `fill '${fill}' fills at the ${at} open, so it decides on ${prev}` };
  }
  return { bar: null, why: `unknown fill model ${JSON.stringify(fill)}` };
}

/** {T11: 'T8', …} from tools.config.json's `splitFrom`. Empty if unreadable. */
function splitSources() {
  try {
    const reg = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'tools.config.json'), 'utf8'));
    const out = {};
    for (const t of reg.tools || []) if (t.splitFrom) out[t.id] = t.splitFrom;
    return out;
  } catch { return {}; }
}

/** One comparison: what live does, what the backtest did, and whether they agree. */
function row(what, live, backtest, note) {
  const known = live !== null && live !== undefined
    && backtest !== null && backtest !== undefined;
  return {
    what,
    live: live === null || live === undefined ? null : live,
    backtest: backtest === null || backtest === undefined ? null : backtest,
    // UNKNOWN is its own answer. Reporting an un-made comparison as a match is
    // how the first three divergences survived two weeks of looking at them.
    status: !known ? 'unknown' : (String(live) === String(backtest) ? 'match' : 'differ'),
    note: note || null,
  };
}

/**
 * Compare one live setup against the spec of a backtest that was run on it.
 *
 * @param setup     from the catalogue: { id, name, decisionTime, windowEnd, fill }
 * @param spec      the stored `spec` of the backtest being compared against
 * @param strategy  the qp strategy, for its risk block (window_start/_end)
 * @returns { setup, rows, differs, unknown }
 */
function compare({ setup, spec, strategy } = {}) {
  const s = setup || {};
  const bt = spec || {};
  const st = strategy || {};
  const r = (st.risk || {});
  const live = risk.settings();
  const p = prefs.settingsFor(s.id) || {};

  // The desk's fill model, which is 'live' unless a preference says otherwise
  // — the same default runner.js applies when it calls qp.
  const liveFill = p.fill || s.fill || 'live';
  const btFill = bt.fill || null;

  const wStart = r.window_start !== undefined ? r.window_start : null;
  const wEnd = r.window_end !== undefined ? r.window_end : null;
  const liveBar = decisionBar(wStart, wEnd, liveFill);
  const btBar = btFill ? decisionBar(wStart, wEnd, btFill) : { bar: null, why: 'the backtest spec names no fill model' };

  const rows = [];
  const NEXT_OPEN = new Set(['next_open', 'desk', 'live']);
  /*
   * A RANGE WINDOW (Test: 09:30–11:30) has no single decision bar, so both
   * sides used to print "—" and the row read NOT COMPARED forever. What CAN be
   * compared is which bars the window decides on: the fill models that enter
   * at the next open decide one bar earlier than 'close', across the whole
   * window. Same family, same bars.
   */
  const family = f => (f === 'close' ? 'decides on the entry bar'
    : (NEXT_OPEN.has(f) ? 'decides on the bar before' : null));
  const at0 = hhmm(wStart);
  const until0 = hhmm(wEnd);
  if (at0 && until0 && at0 !== until0) {
    liveBar.bar = family(liveFill) ? `any bar ${at0}–${until0}, ${family(liveFill)}` : null;
    btBar.bar = btFill && family(btFill) ? `any bar ${at0}–${until0}, ${family(btFill)}` : null;
  }

  /*
   * FIRST, because it is the one that changes which SIGNALS EXIST. Everything
   * below only changes what a signal is worth; this changes whether it happens.
   */
  rows.push(row('decision bar', liveBar.bar, btBar.bar,
    `${liveBar.why} · backtest: ${btBar.why}`));
  /*
   * 'live' and 'desk' are the SAME DECISION. They read the same bar, measure
   * the stop and the target from the same close, and rank on the same number;
   * they differ only in the entry PRICE they report, and only because one is a
   * plan and the other is a measurement taken afterwards. Calling that a
   * difference would leave a correctly aligned desk permanently red, which is
   * how a checker gets ignored.
   */
  const sameDecision = (a, b) => a === b || (NEXT_OPEN.has(a) && NEXT_OPEN.has(b));
  const fillRow = row('fill model', liveFill, btFill,
    "'live' and 'desk'/'next_open' take the same decision from the same bar — "
    + "'close' books the signal bar's own close, a price no order can reach");
  if (fillRow.status === 'differ' && sameDecision(liveFill, btFill)) {
    fillRow.status = 'match';
  }
  rows.push(fillRow);

  // RANKING — which of the day's signals are taken at all.
  const btRank = bt.rank_per_day || null;
  // Absent on BOTH sides is a known setting — no ranking, take all — and it
  // must read as a match rather than as "?" on every setup that does not rank.
  rows.push(row('rank metric', p.rankMetric || 'none', (btRank && btRank.metric) || 'none'));
  rows.push(row('rank top N', p.topN || 'all', (btRank && btRank.top_n) || 'all'));

  // SIZING — how big each one is, and how many the balance can carry.
  const btRiskUsd = bt.risk_usd || null;
  const btRiskPct = bt.risk_pct || null;
  /*
   * RESOLVED ACROSS THE LEVELS, not read off the account.
   *
   * riskPerTrade, riskPct and maxPositionPct all exist on BOTH the account and
   * the setup, and the setup wins. Comparing the account figure alone reported
   * a match on a setup that was sized by an override — which is the same class
   * of invisible difference this whole file exists to catch, one layer down.
   */
  const eff = risk.resolve(live, p);
  const liveRiskUsd = eff.riskPerTrade;
  const liveRiskPct = eff.riskPct;
  /*
   * THE DESK NEVER COMPOUNDS. A percentage live is taken of the account size
   * SET on the desk (risk.js: accountSize × riskPct), not of the broker's
   * balance — so 0.5% of 100,000 is $500 on every trade, exactly like a flat
   * $500. It was reported as "% of equity vs fixed $ — DIFFERS" on 09:35,
   * which was a naming difference, not a sizing one.
   *
   * What CAN differ is the BACKTEST compounding: run at a percentage it sizes
   * each trade on the equity it has banked by then. So the model row asks
   * one question — does the backtest compound — and the dollars are compared
   * as dollars whenever the backtest was flat too.
   */
  const liveUsd = liveRiskUsd
    || (liveRiskPct && eff.accountSize ? Math.round(eff.accountSize * liveRiskPct) / 100 : null);
  const modelRow = row('risk model',
    eff.riskRule === 'fixed_usd' ? 'fixed $'
      : (eff.riskRule === 'pct_of_equity' ? '% of the set account size — flat' : null),
    btRiskUsd ? 'fixed $' : (btRiskPct ? '% of equity' : null),
    'a percentage COMPOUNDS in the backtest and does not on the desk — they '
    + 'agree on trade one and drift as the run banks P&L');
  // Flat backtest: the same sizing, whichever way the desk's figure was typed.
  // Both percentages: the known, accepted drift adopt() sets up — kept as a
  // match with the note, or every adopted setup would be red forever. A flat
  // desk against a compounding backtest is a real difference.
  if (modelRow.live && modelRow.backtest) {
    modelRow.status = (btRiskUsd || (liveRiskPct && btRiskPct)) ? 'match' : 'differ';
  }
  rows.push(modelRow);
  // Compared in the unit the run was configured in, so a percentage is not
  // silently turned into a dollar figure that then reads as a mismatch —
  // EXCEPT that a flat backtest is compared in dollars, because the desk is
  // flat whichever way its figure was typed.
  const pctNote = liveRiskPct && eff.accountSize
    ? ` · ${liveRiskPct}% of the set account size ${eff.accountSize}` : '';
  rows.push(btRiskUsd
    ? row('risk per trade', liveUsd ? `$${liveUsd}` : null, `$${btRiskUsd}`,
      `set at ${eff.sources.risk} level${pctNote}`)
    : row('risk per trade',
      liveRiskUsd ? `$${liveRiskUsd}` : (liveRiskPct ? `${liveRiskPct}%` : null),
      btRiskPct ? `${btRiskPct}%` : null,
      `set at ${eff.sources.risk} level`));
  rows.push(row('account size', live.accountSize || null, bt.account_equity || null));
  // 100 live means NO cap, which is what an absent cap means in the backtest,
  // so the two must compare equal rather than as 100 against nothing.
  // Spelled 'none' on both sides, so "no cap here, no cap there" is a MATCH.
  // As null it read "NOT COMPARED" on every uncapped setup — a permanent
  // amber line about two settings that agree.
  const liveCap = (!eff.maxPositionPct || eff.maxPositionPct === 100) ? 'none'
    : eff.maxPositionPct;
  const btCap = bt.max_position_pct || 'none';
  rows.push(row('max position %', liveCap, btCap,
    'absent on either side means NO cap — the first tight stop can take the '
    + 'balance and the rest of the day is skipped for lack of capital'));

  /*
   * HOW MANY TRADES A DAY. Live caps with maxTradesPerDay; the backtest caps
   * with the strategy's own max_entries_per_day unless the run overrode it.
   * These are the same rule kept in two places, which is how they drift.
   *
   * NOTE the two are not the same UNIT when a setup runs a long book and a
   * short book: qp's cap is per STRATEGY per symbol, the desk's is across the
   * whole day. Reported side by side rather than declared equal.
   */
  /*
   * HOW MANY TRADES A DAY CAN ACTUALLY HAPPEN — not two caps with the same
   * name. The run's `max_entries_per_day` and the strategy's are PER SYMBOL
   * (strategy.evaluate runs one symbol at a time), and the engine applies
   * them on both sides alike. The only whole-day limit a backtest has is its
   * ranking's top N. Live has that AND the desk's own daily budget, so live
   * takes the smaller of the two — and a budget below top N is a live-only
   * restriction the backtest never had.
   */
  const liveTop = p.topN || null;
  const liveDay = p.maxTradesPerDay && (!liveTop || p.maxTradesPerDay < liveTop)
    ? p.maxTradesPerDay : (liveTop || 'all');
  rows.push(row('trades per day (most)', liveDay,
    (btRank && btRank.top_n) || 'all',
    "live: the smaller of top N and the desk's daily budget · backtest: its "
    + 'top N. The per-symbol cap is the strategy\'s and applies on both sides'));

  // THE UNIVERSE the signals are drawn from.
  const btUni = bt.universe || {};
  /*
   * 'T2:R1' IS THE T2 CARD LIST. A backtest reads the tool's R1 register — the
   * morning photo of the same cards the desk decides on — and spells it with
   * the register. Any OTHER register is a different list and stays a
   * difference.
   */
  const btTools = btUni.kind === 'tools'
    ? (btUni.tools || []).map(t => String(t).replace(/:R1$/, '')).sort().join(',') || null
    : (btUni.kind === 'register' ? btUni.register : btUni.kind) || null;
  const uniRow = row('universe', (s.tools || []).slice().sort().join(',') || null, btTools,
    'which cards the signals come from — a different list is a different set of stocks');
  /*
   * A TOOL THAT CONTINUES ANOTHER. T8 was split into T10 (breakout) and T11
   * (pullback), and T10 produced nothing in its weeks of running — so a run on
   * T8's registers IS T11's list, and every backtest of Test from before the
   * split read as a different universe. tools.config.json records the split
   * (`splitFrom`), and that is what is read here, not a guess.
   */
  if (uniRow.status === 'differ') {
    const split = splitSources();
    const liveAsSource = (s.tools || []).map(t => split[t] || t).sort().join(',');
    if (liveAsSource && liveAsSource === btTools) {
      uniRow.status = 'match';
      uniRow.note = `${(s.tools || []).join(',')} was split from ${btTools} `
        + '(tools.config.json) — the same screener, continued';
    }
  }
  rows.push(uniRow);
  rows.push(row('timeframe', p.tf || s.tf || '1m', bt.tf || null));
  /*
   * THE FEED, AND WHEN A DIFFERENCE IS NOT A DIVERGENCE.
   *
   * A backtest is run on polygon because polygon is the only feed here with
   * years of history; a live decision cannot be, because the free plan is a
   * day behind and allows five requests a minute. So an adopted setup will
   * ALWAYS read differently from the run that produced it, and reporting that
   * as a divergence would leave every correctly configured setup permanently
   * red — the same trap the fill-model row above sidesteps.
   *
   * What actually has to hold is that both feeds report the SAME TAPE. polygon
   * and yahoo are both consolidated — the whole market — and measured against
   * each other on one morning they agree on VWAP to within 0.06%
   * (tools/data/yahoo.py:22). hybrid_yahoo is the two of them joined, so it is
   * consolidated on both sides of its seam.
   *
   * alpaca is NOT, and that is the entire point of drawing the line here
   * rather than waving the row through: its free tier is IEX, a few percent of
   * the volume, so a strategy backtested on alpaca and run live on yahoo is
   * measuring one VWAP and trading another. That stays a divergence.
   */
  const CONSOLIDATED = new Set(['polygon', 'yahoo', 'hybrid_yahoo']);
  /*
   * THE FEED THAT DECIDES, NOT THE ONE ON FILE — and they are not the same on
   * this desk right now.
   *
   * `OR + VWAP 09:35` still carries `feed: polygon` in setup-prefs.json, left
   * there by the 08-31 adopt. The desk substitutes yahoo for it on every run.
   * Reading the stored preference here printed "live polygon · backtest
   * polygon · MATCH" — a parity report certifying agreement about a feed
   * nothing was using, which is precisely the failure this file was written to
   * end. The catalog has already resolved it (`liveFeed`); when a bare setup
   * is passed in, the preference is resolved the same way rather than trusted.
   */
  const resolved = liveFeedFor(p.feed || s.chosenFeed || s.feed || null);
  const liveFeed = s.liveFeed || resolved.feed || null;
  const feedRow = row('feed', liveFeed, bt.feed || null,
    (resolved.substituted || (s.chosenFeed && s.chosenFeed !== liveFeed)
      ? `the setup is set to '${s.chosenFeed || p.feed}', which cannot decide a `
        + `live bar, so it decides on '${liveFeed}'. `
      : '')
    + 'a backtest runs on polygon for the history and a live decision cannot — '
    + 'what has to match is the TAPE, and polygon and yahoo are both '
    + 'consolidated (VWAP within 0.06%). alpaca is IEX only');
  if (feedRow.status === 'differ'
      && CONSOLIDATED.has(String(liveFeed).toLowerCase())
      && CONSOLIDATED.has(String(bt.feed).toLowerCase())) {
    feedRow.status = 'match';
  }
  rows.push(feedRow);
  /*
   * WHICH BARS ARE IN THE FRAME. Not cosmetic: a rolling indicator's window
   * differs between them, so the same strategy reads a different ATR at 09:35
   * under 'all' than under 'regular' — and a setup whose entry window opens at
   * 09:30 decides from the 09:29 bar, which 'regular' does not contain at all.
   */
  rows.push(row('view', p.view || s.view || 'all', bt.view || 'all',
    "'regular' drops the pre-market bars, which changes every rolling "
    + "indicator's warm-up and removes the 09:29 decision bar entirely"));

  /*
   * A SETUP OVERRIDING THE ACCOUNT IS THE DESIGN, not a fault — every adopted
   * setup does it, and flagging it would leave a correctly configured desk
   * permanently red. What IS a fault is ONE level naming two risk rules at
   * once, which no precedence can settle.
   */
  if (eff.conflicts.length) {
    rows.push({ what: 'setting conflict', live: eff.conflicts.join(' · '),
                backtest: null, status: 'differ',
                note: 'ONE level names two risk rules at once. A percentage and '
                  + 'a flat dollar are different sizing strategies, and half of '
                  + 'each is neither' });
  }

  const differs = rows.filter(x => x.status === 'differ');
  const unknown = rows.filter(x => x.status === 'unknown');
  return { setup: s.id || s.name || null, rows, differs, unknown };
}

/** A short human summary — the lines that are wrong, worst first. */
function summarise(result) {
  const out = [];
  if (!result || !result.rows) return out;
  // The decision bar leads whenever it differs: every other line describes a
  // trade, and this one describes whether the trade is the same trade.
  const order = { 'decision bar': 0, 'fill model': 1 };
  const bad = [...result.differs].sort(
    (a, b) => (order[a.what] ?? 9) - (order[b.what] ?? 9));
  for (const d of bad) {
    out.push(`${d.what}: live ${d.live} · backtest ${d.backtest}`
      + (d.note ? ` — ${d.note}` : ''));
  }
  for (const u of result.unknown) {
    out.push(`${u.what}: NOT COMPARED (live ${u.live === null ? 'unset' : u.live}`
      + `, backtest ${u.backtest === null ? 'unset' : u.backtest})`);
  }
  return out;
}

/*
 * ── ADOPT: MAKE THE DESK RUN THE BACKTEST THAT WON ───────────────────────
 *
 * THE WORKFLOW THIS SERVES. You try combinations in qp — caps, risk rules,
 * rank metrics, fill models — until one is clearly best. That run is then the
 * specification, and the desk has to be set to it. Doing that by hand across
 * two config files, in a different vocabulary, is where the three original
 * divergences came from.
 *
 * So the winning run states the settings and this translates them, once.
 *
 * Direction matters and it is one-way: BACKTEST -> DESK. The comparison in
 * compare() answers "do these agree"; this answers "make them agree, on the
 * backtest's terms". Nothing here ever edits a backtest.
 *
 * Returns the two patches and the reasons, WITHOUT writing. The caller decides
 * whether to apply them, because this changes what a live account does with
 * real money and that must never be a side effect of running a check.
 */
function planAdopt({ setup, spec, strategy } = {}) {
  const s = setup || {};
  const bt = spec || {};
  const cur = risk.settings();
  const curPrefs = prefs.settingsFor(s.id) || {};
  const changes = [];
  const note = (what, from, to, why) => {
    if (String(from ?? '') === String(to ?? '')) return;
    changes.push({ what, from: from ?? null, to: to ?? null, why: why || null });
  };

  /*
   * THE ACCOUNT GETS ONE THING: THE BALANCE.
   *
   * Everything else this run specifies is written at the SETUP level, and that
   * is the whole design. The account is shared by every setup on the desk, so a
   * risk rule written there is not this strategy's setting — it is the desk's.
   * Adopt a winner for `Test` next week at $300 flat and it would silently
   * resize 09:35's trades, which nobody asked for and nothing would report.
   *
   * The account size is different: there is ONE balance, and every setup is
   * sized against the same money. It stays account-wide because it genuinely
   * is, and it is the only line here that carries that warning.
   */
  const account = {};
  if (bt.account_equity) account.accountSize = bt.account_equity;
  note('account size', cur.accountSize, account.accountSize,
    'ACCOUNT-WIDE — there is one balance, and every setup is sized against it');

  /* THE SETUP — everything that belongs to this strategy alone. */
  const rank = bt.rank_per_day || null;
  const setupPatch = {
    rankMetric: (rank && rank.metric) || null,
    rankDirection: (rank && rank.direction) || null,
    topN: (rank && rank.top_n) || null,
    tf: bt.tf || null,
    /*
     * THE FEED IS TRANSLATED, NOT COPIED — the same rule as the fill model
     * below, and the reason this desk stopped firing.
     *
     * On 2026-08-27 `OR + VWAP 09:35` had NO feed preference, decided on
     * yahoo, and fired: three shorts at 09:36:15, one of them filled. A
     * backtest was adopted on 08-31, and a backtest is run on polygon because
     * polygon is the only feed here with years of history. `bt.feed` was
     * copied straight onto the live setup — and polygon is a day behind on the
     * free plan and allows five requests a minute, so from 09-01 every morning
     * timed out and printed "MISSED THE 09:35 WINDOW". Nothing had broken. A
     * setting right for one job had been copied onto the other.
     *
     * feeds.js already knows which feeds cannot decide a live bar, so the
     * question is asked there rather than answered again here.
     */
    // A backtest that named no feed still names none — writing the default in
    // here would turn "nobody chose" into "somebody chose", which is a
    // different fact and the one the card reports.
    feed: bt.feed ? liveFeedFor(bt.feed).feed : null,
    view: bt.view || 'all',
    /*
     * THE FILL MODEL IS TRANSLATED, NOT COPIED. A backtest runs 'desk' or
     * 'next_open'; neither can be evaluated in real time, because both report
     * the entry as a bar that has not printed. Their live twin is 'live' — the
     * same decision from the same bar with the same levels. Copying the
     * backtest's own name here would stop the desk firing altogether.
     */
    fill: (bt.fill === 'desk' || bt.fill === 'next_open' || !bt.fill) ? 'live' : bt.fill,
    maxTradesPerDay: (bt.rules && bt.rules.max_entries_per_day) || null,
    /*
     * THE MONEY RULES, WRITTEN HERE RATHER THAN ON THE ACCOUNT.
     *
     * This is the setting that belongs to THIS strategy, because it is what
     * THIS strategy's winning backtest specified. Written at the setup level it
     * cannot be disturbed by adopting a winner for another strategy, and it
     * beats the account by the precedence in risk.resolve().
     *
     * Exactly ONE risk rule is written and the other is explicitly nulled —
     * null deletes the key — so the setup can never end up naming both, which
     * is the one case resolve() has to call ambiguous.
     *
     * A cap absent in the backtest means NO cap, which the desk spells as 100.
     * Writing 100 rather than clearing the key matters: clearing it would fall
     * through to whatever the account happens to say, and the run said none.
     */
    riskPerTrade: bt.risk_usd || null,
    riskPct: bt.risk_usd ? null : (bt.risk_pct || null),
    maxPositionPct: bt.max_position_pct || 100,
  };

  // Named as this setup's own, because that is what they are — and so a
  // reader can see they will not move when another strategy is adopted.
  note('risk per trade ($)', curPrefs.riskPerTrade, setupPatch.riskPerTrade,
    "this setup's own");
  note('risk per trade (%)', curPrefs.riskPct, setupPatch.riskPct,
    "this setup's own. The backtest COMPOUNDS this; the desk sizes on the "
    + 'configured account size, so the two match on trade one and drift as the '
    + 'run banks P&L');
  note('max position %', curPrefs.maxPositionPct, setupPatch.maxPositionPct,
    "this setup's own. 100 means NO cap, which is what the run had");
  note('rank metric', curPrefs.rankMetric, setupPatch.rankMetric);
  note('rank top N', curPrefs.topN, setupPatch.topN);
  note('timeframe', curPrefs.tf, setupPatch.tf);
  note('feed', curPrefs.feed, setupPatch.feed,
    bt.feed && setupPatch.feed !== bt.feed
      ? `the backtest ran on '${bt.feed}', which cannot decide a live bar — `
        + `'${setupPatch.feed}' is its live twin. Numbers measured on '${bt.feed}' `
        + 'are not guaranteed to repeat on it; re-run the backtest there to check'
      : null);
  note('view', curPrefs.view || 'all', setupPatch.view);
  note('fill model', curPrefs.fill || 'live', setupPatch.fill,
    bt.fill && setupPatch.fill !== bt.fill
      ? `the backtest ran '${bt.fill}', whose live twin is '${setupPatch.fill}'` : null);
  note('max entries / day', curPrefs.maxTradesPerDay, setupPatch.maxTradesPerDay);

  /*
   * WHAT IT REFUSES TO CARRY. The universe is the setup's TOOL assignment, and
   * that is a decision about which screener feeds it — made in qp, on the
   * strategy itself. A backtest run against a different register is a question
   * about the strategy, not a setting to copy onto the desk behind your back.
   */
  const refused = [];
  const btTools = ((bt.universe || {}).tools || []);
  if (btTools.length && String(btTools.sort()) !== String((s.tools || []).slice().sort())) {
    refused.push(`the backtest ran on ${btTools.join(', ')} and this setup belongs `
      + `to ${(s.tools || []).join(', ') || 'no tool'} — change the strategy's tools `
      + 'in qp if that is what you mean');
  }

  return { setup: s.id || null, account, setupPatch, changes, refused };
}

/** Apply a plan. Separate from building it, so nothing writes by accident. */
function applyAdopt(plan) {
  if (!plan) throw new Error('no plan to apply');
  // The account first: a setup patch that referenced a risk rule the account
  // did not have yet would be saved against the old one.
  risk.save(plan.account);
  prefs.saveSettings(plan.setup, plan.setupPatch);
  return { account: risk.settings(), setup: prefs.settingsFor(plan.setup) };
}

module.exports = { compare, summarise, decisionBar, hhmm, shift, row,
                   planAdopt, applyAdopt };
