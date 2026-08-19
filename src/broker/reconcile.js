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
  for (const p of out.positions) {
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
    })),
  };
}

module.exports = { compare, flatSymbols, fillsFor, alpacaDestinations };
