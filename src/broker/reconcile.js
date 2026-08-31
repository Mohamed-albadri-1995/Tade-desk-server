/*
 * What we believe, against what the broker says.
 *
 * The ledger is a record of INTENTIONS: every order this side attempted, and
 * what SignalStack replied. It cannot see anything the broker did afterwards —
 * a stop that filled, a target that filled, an order accepted and then dropped.
 * So "what do I hold" has always been derived as *what we sent minus what we
 * closed*, which over-reports on purpose: over-closing is safe for the 15:50
 * flatten and wrong for everything else.
 *
 * Alpaca will simply say. That makes four questions answerable that were
 * previously guesses, and each has a different cost when it is guessed wrong:
 *
 *   WE THINK OPEN, ALPACA SAYS FLAT      the stop or a target already filled.
 *                                        Every close sent for it is a wasted
 *                                        per-order fee, and the manager may
 *                                        "exit" a trade that ended an hour ago.
 *
 *   ALPACA HOLDS IT, WE DO NOT KNOW      the dangerous one. Nothing on this
 *                                        side will flatten it at 15:50, because
 *                                        the flatten only closes what the
 *                                        ledger says was opened. That is an
 *                                        overnight position in an account that
 *                                        may not hold one.
 *
 *   THE QUANTITY DISAGREES               a leg did not fill, or filled partly.
 *                                        The position is not the tested shape.
 *
 *   SENT, AND ALPACA HAS NO RECORD       SignalStack accepted it and the broker
 *                                        never got it. The alert said the trade
 *                                        was on.
 *
 * ONE ACCOUNT ONLY, and it has to be said everywhere: TTP5k is a Trade The Pool
 * account behind TraderEvolution and none of this can see it. A reconciliation
 * that silently covered half a desk would be worse than none, so every answer
 * names its scope.
 */

const alpaca = require('../alpaca/account');
const broker = require('./signalstack');

/** Which configured destinations are Alpaca — the only ones this can verify. */
function alpacaDestinations() {
  return broker.destinations()
    .filter(d => d.dialect === 'alpaca')
    .map(d => d.id);
}

/*
 * ONE SET OF CREDENTIALS, HOWEVER MANY ALPACA ACCOUNTS ARE CONFIGURED.
 *
 * `alpacaDestinations()` returns a LIST, which reads as though a second Alpaca
 * account would simply be covered too. It would not. `alpaca/client.js`
 * resolves credentials with
 *
 *     SELECT config FROM trading_brokers WHERE type='alpaca' AND enabled=1
 *      ORDER BY is_default DESC, created_at ASC LIMIT 1
 *
 * — ONE key pair, the default profile. Every position, every fill and every
 * account read therefore answers for exactly one account, and nothing in the
 * answer says which one.
 *
 * WHAT THAT WOULD DO IF IT WENT UNGUARDED, and it is worse than a gap:
 *
 *   RECONCILIATION would compare account A's positions against orders sent to
 *   A and to B together. Every B position would land in 'unknown-position' —
 *   the loudest finding there is — and every real one would be buried under
 *   the noise, which is how a reconciliation stops being read.
 *
 *   CONFIRMATION would match B's orders to A's fills. Same symbol, same side,
 *   the same few seconds: the match would succeed and the fill price would be
 *   another account's. That is not a missing number, it is a confident wrong
 *   one, and `slip` — the whole measurement this feeds — would be built on it.
 *
 * So a second Alpaca account makes these answers UNAVAILABLE rather than
 * wrong, until credentials are resolved per destination. Silence here is a
 * feature request; a wrong fill price is a corrupted record.
 */
function credentialScope() {
  const ids = alpacaDestinations();
  if (ids.length <= 1) return { ids, ambiguous: false, reason: null };
  return {
    ids,
    ambiguous: true,
    reason: `${ids.length} Alpaca accounts are configured (${ids.join(', ')}) and `
      + 'this desk holds ONE set of Alpaca credentials — every read answers for '
      + 'one of them and nothing here can say which. Positions and fills cannot '
      + 'be attributed to an account until credentials are stored per destination.',
  };
}

/**
 * The two views, side by side, with the disagreements named.
 *
 * Never throws and never pretends. When Alpaca cannot be reached the answer is
 * `reachable: false` with the reason — NOT an empty position list, which would
 * read as "you hold nothing" and is the single most dangerous thing this could
 * get wrong.
 */
async function compare(date, { timeoutMs = 10000 } = {}) {
  const verifiable = alpacaDestinations();
  const out = {
    ok: true,
    reachable: false,
    scope: verifiable,
    unverifiable: broker.destinations()
      .filter(d => d.dialect !== 'alpaca').map(d => d.id),
    positions: [],
    findings: [],
  };

  const scope = credentialScope();
  if (scope.ambiguous) {
    out.ambiguous = true;
    out.findings.push({ level: 'error', kind: 'ambiguous-account', detail: scope.reason });
  }

  const [pos, acct] = await Promise.all([
    alpaca.positions({ timeoutMs }),
    alpaca.account({ timeoutMs }),
  ]);

  if (!pos.ok) {
    out.error = pos.error;
    out.findings.push({
      level: 'warn', kind: 'unreachable',
      detail: `could not ask Alpaca what is open (${pos.error}) — everything below `
        + 'is what THIS SIDE believes, unverified',
    });
    return out;
  }
  out.reachable = true;
  out.positions = pos.positions;

  if (acct.ok) {
    out.account = acct.account;
    /*
     * A blocked account fails every order, one at a time, with a different
     * message each time. Asked once, it is a single line at the top.
     */
    if (acct.account.tradingBlocked || acct.account.accountBlocked) {
      out.findings.push({
        level: 'error', kind: 'blocked',
        detail: 'ALPACA HAS BLOCKED THIS ACCOUNT — every order today will be '
          + `refused (status ${acct.account.status})`,
      });
    }
  }

  // ── what this side believes ──────────────────────────────────────────────
  const rows = broker.orders(date);
  const closedHere = new Set();
  const believed = new Map();               // SYMBOL -> { setupId, dests:Set, qty }
  for (const o of rows) {
    if (o.kind === 'callback') continue;
    const sym = String(o.symbol || '').toUpperCase();
    if (!sym) continue;
    if (o.kind === 'flatten') { if (o.sent) closedHere.add(sym); continue; }
    if (!o.sent) continue;
    const was = believed.get(sym) || { setupId: o.setupId || null, dests: new Set(), qty: 0 };
    was.dests.add(o.destination);
    // Signed, so a short's believed size is comparable with Alpaca's.
    was.qty += (String(o.action || '').toLowerCase() === 'sell' ? -1 : 1)
      * (Number(o.quantity) || 0);
    believed.set(sym, was);
  }

  const held = new Map(out.positions.map(p => [p.symbol, p]));

  // ── believed open, and Alpaca's answer ───────────────────────────────────
  for (const [sym, b] of believed) {
    if (closedHere.has(sym)) continue;                 // we already flattened it
    const onlyAlpaca = [...b.dests].every(d => verifiable.includes(d));
    const p = held.get(sym);

    if (!p && onlyAlpaca) {
      out.findings.push({
        level: 'info', kind: 'already-closed', symbol: sym, setupId: b.setupId,
        detail: `${sym}: this side still thinks it is open; Alpaca is FLAT. A stop `
          + 'or a target filled. Nothing more needs closing.',
      });
      continue;
    }
    if (!p) continue;                                   // held elsewhere; cannot verify

    /*
     * Compared as a MAGNITUDE against the Alpaca share of what was sent. The
     * ledger's total spans every account, so a straight comparison would report
     * a mismatch on every two-account signal — which is the reconciliation
     * crying wolf, exactly what makes one stop being read.
     */
    const alpacaOnly = [...b.dests].filter(d => verifiable.includes(d));
    if (alpacaOnly.length === b.dests.size && Math.abs(p.qty) !== Math.abs(b.qty)) {
      out.findings.push({
        level: 'warn', kind: 'qty', symbol: sym, setupId: b.setupId,
        detail: `${sym}: Alpaca holds ${p.qty}, this side sent ${b.qty}. A leg did not `
          + 'fill, filled partly, or one has already been taken out.',
      });
    }
  }

  // ── held at Alpaca and unknown here — the dangerous direction ────────────
  //
  // Skipped entirely when the account is ambiguous. With two Alpaca accounts
  // and one key pair, every position in the OTHER account arrives here as
  // 'ALPACA HOLDS n AND THIS SIDE DOES NOT KNOW IT' — the loudest line the
  // reconciliation has, fired on positions that are perfectly well known. The
  // real one would then be indistinguishable from the noise, which is worse
  // than not asking. The ambiguity itself is already reported above.
  for (const p of (out.ambiguous ? [] : out.positions)) {
    if (believed.has(p.symbol) && !closedHere.has(p.symbol)) continue;
    out.findings.push({
      level: 'error', kind: 'unknown-position', symbol: p.symbol,
      detail: `${p.symbol}: ALPACA HOLDS ${p.qty} AND THIS SIDE DOES NOT KNOW IT. `
        + (closedHere.has(p.symbol)
            ? 'It was closed here and is still on — the close did not take. '
            : 'Nothing here opened it. ')
        + 'The 15:50 flatten only closes what this side opened, so this one will '
        + 'go OVERNIGHT unless you close it yourself.',
    });
  }

  return out;
}

/**
 * Positions that survived their own session.
 *
 * THE HOLE THIS EXISTS TO CLOSE, found by opening the Alpaca app and seeing two
 * names that should not have been there.
 *
 * The 15:50 flatten reads `openSymbols(today)`, and the ledger is keyed by day.
 * So a position that is not closed on the day it was opened — because the alerts
 * process was down at 15:50, because the desk was disarmed, because the close
 * was refused — is invisible to every flatten that follows. The next morning
 * `openSymbols` is asked about a new date, finds nothing, and closes nothing.
 * Nothing anywhere ever looks at it again. It is not "missed once"; it is
 * missed for good.
 *
 * So this asks the only party that actually knows. For each name ALPACA IS
 * HOLDING RIGHT NOW, it walks the WHOLE ledger — every day, not today's — and
 * finds the last entry and the last close this desk sent for it:
 *
 *   an entry with no close after it, dated before today   CARRIED OVER. This
 *                                                         desk opened it and
 *                                                         never closed it.
 *
 *   an entry with no close after it, dated today          normal: still running.
 *
 *   no entry at all                                       NOT OURS. Opened by
 *                                                         hand, or before this
 *                                                         ledger existed.
 *
 * The last distinction is the one that decides what may be done automatically.
 * A carried-over position is this desk's own mess and closing it is finishing a
 * job it started. A position it never opened may be a trade taken by hand for
 * reasons no algorithm here knows, and closing that would be the worst thing in
 * this file. It is reported, loudly, and left alone.
 */
async function carriedOver(today, { timeoutMs = 10000 } = {}) {
  const r = await alpaca.positions({ timeoutMs });
  if (!r.ok) return { ok: false, error: r.error };

  const holding = r.positions.filter(p => p.qty !== 0);
  if (!holding.length) return { ok: true, carried: [], foreign: [], running: [] };

  /*
   * The last thing this desk did to each name, over the whole ledger. Not
   * per-day: the entire point is the days nobody looked at.
   */
  const lastOpen = new Map();      // SYMBOL -> the most recent sent entry row
  const lastClose = new Map();     // SYMBOL -> the most recent sent flatten row
  for (const o of broker.orders()) {
    if (o.kind === 'callback' || o.kind === 'intent') continue;
    const sym = String(o.symbol || '').toUpperCase();
    if (!sym || !o.sent) continue;
    const into = o.kind === 'flatten' ? lastClose : lastOpen;
    const was = into.get(sym);
    if (!was || (o.at || 0) > (was.at || 0)) into.set(sym, o);
  }

  const out = { ok: true, carried: [], foreign: [], running: [] };
  for (const p of holding) {
    const open = lastOpen.get(p.symbol);
    const shut = lastClose.get(p.symbol);

    if (!open) {
      out.foreign.push({ ...p, why: 'nothing in this ledger ever opened it' });
      continue;
    }
    // A close AFTER the last entry means the desk did its part; whatever is
    // there now was opened by something else, or the close did not take.
    if (shut && (shut.at || 0) > (open.at || 0)) {
      out.foreign.push({ ...p, openedOn: open.date, closedOn: shut.date,
        why: 'this desk closed it and it is still on — the close did not take' });
      continue;
    }
    const row = {
      ...p,
      openedOn: open.date,
      setupId: open.setupId || null,
      // Which account to send the close to. Alpaca destinations only: this
      // whole function is built on an Alpaca position query and says so.
      destinations: [...new Set(broker.orders(open.date)
        .filter(o => o.sent && o.kind !== 'flatten' && o.kind !== 'callback'
                  && String(o.symbol || '').toUpperCase() === p.symbol)
        .map(o => o.destination))].filter(d => alpacaDestinations().includes(d)),
    };
    if (open.date === today) out.running.push(row);
    else out.carried.push(row);
  }
  return out;
}

/**
 * Which symbols Alpaca is definitely flat in — for a caller about to send a
 * close it does not need to send.
 *
 * `null` when the question could not be asked. NOT an empty set: "Alpaca says
 * you are flat in nothing" and "Alpaca did not answer" are opposite instructions
 * and a caller that cannot tell them apart will eventually act on the wrong one.
 */
async function flatSymbols({ timeoutMs = 8000 } = {}) {
  const r = await alpaca.positions({ timeoutMs });
  if (!r.ok) return null;
  return new Set(r.positions.filter(p => p.qty !== 0).map(p => p.symbol));
}

/**
 * The day's fills, grouped per symbol, for a journal.
 *
 * The ledger records what was ASKED for at the price the decision used. This is
 * what the account actually paid, print by print — the two differ by the minute
 * between the decision bar's close and the market order, and by whatever the
 * spread took. A journal built on the first is a record of intentions.
 */
async function fillsFor(date, { timeoutMs = 15000 } = {}) {
  // Alpaca wants an instant; the desk thinks in New York sessions. 04:00 ET
  // covers the pre-market so nothing placed early is missed.
  const after = new Date(`${date}T04:00:00-04:00`).toISOString();
  const r = await alpaca.fills({ after, timeoutMs });
  if (!r.ok) return { ok: false, error: r.error };

  const by = new Map();
  for (const f of r.fills) {
    const g = by.get(f.symbol) || { symbol: f.symbol, fills: [], bought: 0, sold: 0,
                                    cost: 0, proceeds: 0 };
    g.fills.push(f);
    if (String(f.side).startsWith('buy')) { g.bought += f.qty; g.cost += f.qty * f.price; }
    else { g.sold += f.qty; g.proceeds += f.qty * f.price; }
    by.set(f.symbol, g);
  }

  return {
    ok: true,
    symbols: [...by.values()].map(g => ({
      ...g,
      avgBuy: g.bought ? Math.round((g.cost / g.bought) * 10000) / 10000 : null,
      avgSell: g.sold ? Math.round((g.proceeds / g.sold) * 10000) / 10000 : null,
      // Only meaningful once the position is round-tripped; a half-closed name
      // has a number here that is not a result yet, so it says which it is.
      closed: g.bought === g.sold && g.bought > 0,
      realised: (g.bought === g.sold && g.bought > 0)
        ? Math.round((g.proceeds - g.cost) * 100) / 100 : null,
      /*
       * ONE SIDE ONLY MEANS THE WINDOW, NOT THE TRADE.
       *
       * A position opened yesterday and closed today shows here as sells with
       * no buys, and the report called it "STILL OPEN — no result yet" — the
       * exact opposite of what happened. EYPT and VIK both read that way on
       * 2026-08-19 while Alpaca held neither.
       *
       * The fills cannot say what the entry cost, because the entry is outside
       * the window asked for. That is a limit of the QUESTION and it is now
       * reported as one rather than as a fact about the position.
       */
      halfWindow: (g.bought === 0) !== (g.sold === 0),
    })),
  };
}

/*
 * WHAT IS ACTUALLY HELD, RIGHT NOW — cached, because a page polls.
 *
 * `broker.openSymbols(date)` answers from the LEDGER: what was sent, minus what
 * was closed. It cannot see a stop or a target that filled at the broker, so it
 * over-reports by design — safe for the 15:50 flatten, which would rather send
 * a close for a position that is already flat than miss one, and wrong for
 * anything that puts a number on a screen.
 *
 * That is the fault behind "the dashboard shows committed dollars and Open
 * always shows a dash": the two come from different places and only one of them
 * has ever been checked against the account.
 *
 * CACHED for a few seconds because the alerts page polls this route. Without a
 * cache every open tab would put its own request rate on the broker, and the
 * answer does not change between two polls a second apart.
 *
 * NEVER THROWS, and never answers an empty list when it does not know. "You
 * hold nothing" and "I could not ask" have to be different answers — reporting
 * the first when the second is true is the single most dangerous thing here.
 */
let _heldCache = { at: 0, value: null };

async function heldNow({ maxAgeMs = 8000, timeoutMs = 6000 } = {}) {
  const now = Date.now();
  if (_heldCache.value && (now - _heldCache.at) < maxAgeMs) return _heldCache.value;

  if (!alpacaDestinations().length) {
    return { ok: true, verifiable: false, reason: 'no Alpaca account configured',
             positions: null };
  }
  const scope = credentialScope();
  if (scope.ambiguous) {
    return { ok: false, verifiable: false, reason: scope.reason, positions: null };
  }

  let r;
  try {
    r = await alpaca.positions({ timeoutMs });
  } catch (err) {
    return { ok: false, verifiable: true, reason: err.message, positions: null };
  }
  if (!r.ok) return { ok: false, verifiable: true, reason: r.error, positions: null };

  const value = {
    ok: true,
    verifiable: true,
    at: now,
    positions: r.positions
      .filter(p => p.qty !== 0)
      .map(p => ({ symbol: p.symbol, qty: p.qty })),
  };
  _heldCache = { at: now, value };
  return value;
}

/**
 * The day's orders with the fill price joined back on — from the broker, since
 * SignalStack's callback is a live-account feature and this desk is on paper.
 *
 * Always returns the rows. A day report that printed nothing because Alpaca was
 * unreachable would be a worse failure than one that prints the orders and says
 * the fill prices are missing, so `ok:false` carries the unenriched rows with it.
 */
async function confirmed(date, { timeoutMs = 15000 } = {}) {
  const rows = broker.reconciled(date);
  // Nothing to ask about, or nothing Alpaca could answer for. Not an error:
  // a TTP-only desk is correctly reported as simply having no fill record here.
  if (!rows.length || !alpacaDestinations().length) {
    return { ok: true, rows, verifiable: false };
  }
  // Two Alpaca accounts, one key pair: a match would succeed and be another
  // account's fill. See credentialScope().
  const scope = credentialScope();
  if (scope.ambiguous) {
    return { ok: false, error: scope.reason, rows, verifiable: false, ambiguous: true };
  }
  const after = new Date(`${date}T04:00:00-04:00`).toISOString();
  let r;
  try {
    r = await alpaca.fills({ after, timeoutMs });
  } catch (err) {
    return { ok: false, error: err.message, rows, verifiable: true };
  }
  if (!r.ok) return { ok: false, error: r.error, rows, verifiable: true };
  return { ok: true, rows: broker.confirmFromFills(rows, r.fills), verifiable: true };
}

module.exports = {
  compare, carriedOver, flatSymbols, fillsFor, confirmed, heldNow,
  alpacaDestinations, credentialScope,
};
