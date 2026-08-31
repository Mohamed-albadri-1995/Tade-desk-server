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
 * WHICH ALPACA ACCOUNTS CAN BE READ, AND WHICH CANNOT BE TOLD APART.
 *
 * THE FAILURE THIS GUARDS, which is worse than a gap. Confirmation matches an
 * order to a fill by symbol, side and time. Two accounts running the same desk
 * see the same symbols in the same seconds, so account B's order matches
 * account A's fill and takes A's price — not a missing number, a confident
 * wrong one, in the record that measures execution.
 *
 * Each Alpaca destination may now carry its own key pair, and one that does is
 * readable on its own terms: its fills are ITS fills, and attribution is a
 * fact rather than an assumption.
 *
 * A destination with NO keys of its own falls back to the desk-wide pair. That
 * is exactly right while it is the only Alpaca account on the desk, and
 * unanswerable the moment there is a second — the shared pair points at one
 * account and nothing says which. So those are refused, BY NAME, and the ones
 * that do have keys are unaffected.
 *
 * Silence about an account is a feature request. A wrong fill price is a
 * corrupted record.
 */
function alpacaDests() {
  return broker.destinations().filter(d => d.dialect === 'alpaca');
}

function credentialScope() {
  const dests = alpacaDests();
  const ids = dests.map(d => d.id);
  const own = dests.filter(d => d.alpacaKeyId && d.alpacaSecret);
  const shared = dests.filter(d => !(d.alpacaKeyId && d.alpacaSecret));

  // Readable: everything with its own keys, plus a lone keyless account, which
  // the desk-wide pair unambiguously IS.
  const readable = own.map(d => d.id);
  if (shared.length && ids.length === 1) readable.push(shared[0].id);

  const blind = ids.filter(id => !readable.includes(id));
  return {
    ids,
    readable,
    blind,
    ambiguous: blind.length > 0,
    reason: blind.length
      ? `${blind.join(', ')} ${blind.length > 1 ? 'have no Alpaca key pairs of '
          + 'their own' : 'has no Alpaca key pair of its own'}, and `
        + `${ids.length} Alpaca accounts are configured — this desk holds ONE set `
        + 'of Alpaca credentials beside them, which answers for one account and '
        + 'nothing here can say which. Give each account its own API key and '
        + 'secret on the Settings tab, or its positions and fills cannot be '
        + 'attributed to it.'
      : null,
  };
}

/**
 * The credentials to read ONE destination with, or the reason there are none.
 *
 * Never guesses. A destination that cannot be identified comes back with a
 * reason, and every caller reports that instead of reading some other account
 * and labelling the answer with this one's name.
 */
function credsForDest(dest) {
  const d = typeof dest === 'string'
    ? alpacaDests().find(x => x.id === dest) : dest;
  if (!d) return { creds: null, error: 'no such Alpaca account' };
  const own = alpaca.credsOf(d);
  if (own) return { creds: own, error: null };
  const scope = credentialScope();
  if (scope.readable.includes(d.id)) return { creds: null, error: null };  // desk-wide
  return { creds: null, error: scope.reason };
}

/**
 * The two views, side by side, with the disagreements named.
 *
 * Never throws and never pretends. When Alpaca cannot be reached the answer is
 * `reachable: false` with the reason — NOT an empty position list, which would
 * read as "you hold nothing" and is the single most dangerous thing this could
 * get wrong.
 */
/*
 * ── THE RECONCILIATION, ONE ACCOUNT AT A TIME ────────────────────────────
 *
 * What this report answers: "does what the desk THINKS it holds match what the
 * broker actually holds", and the dangerous direction is a position the broker
 * has that the desk does not know about — the 15:50 flatten only closes what
 * this side opened, so an unknown one goes overnight.
 *
 * WHY IT HAD TO BECOME ACCOUNT-AWARE. Every map in here is keyed by SYMBOL.
 * With two accounts that is not a key: the same name held in both collides, and
 * the ledger's total for it spans both accounts. Reading one account's
 * positions against both accounts' orders reports the OTHER account's holdings
 * as "ALPACA HOLDS n AND THIS SIDE DOES NOT KNOW IT" — the loudest line here,
 * fired on positions that are perfectly well known. A reconciliation that cries
 * wolf is one that stops being read, and the real finding is then invisible.
 *
 * So the whole comparison runs PER ACCOUNT: that account's positions, read with
 * its own keys, against the orders sent to that account only. Findings carry
 * the account they belong to. An account that cannot be identified is reported
 * and skipped, never merged into another's.
 */
function believedFor(date, destId) {
  const rows = broker.orders(date);
  const closedHere = new Set();
  const believed = new Map();               // SYMBOL -> { setupId, dests:Set, qty }
  for (const o of rows) {
    if (o.kind === 'callback') continue;
    // THIS ACCOUNT'S ORDERS ONLY. Without this the believed quantity is the sum
    // across accounts and every two-account signal reports a mismatch.
    if ((o.destination || null) !== destId) continue;
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
  return { believed, closedHere };
}

/** One account's positions against one account's orders. */
function findingsFor(date, destId, positions) {
  const findings = [];
  const { believed, closedHere } = believedFor(date, destId);
  const held = new Map(positions.map(p => [p.symbol, p]));

  for (const [sym, b] of believed) {
    if (closedHere.has(sym)) continue;                 // we already flattened it
    const p = held.get(sym);
    if (!p) {
      findings.push({
        level: 'info', kind: 'already-closed', symbol: sym, setupId: b.setupId,
        account: destId,
        detail: `${sym}: this side still thinks it is open in ${destId}; Alpaca is `
          + 'FLAT. A stop or a target filled. Nothing more needs closing.',
      });
      continue;
    }
    /*
     * Compared as a MAGNITUDE. Both sides are now scoped to one account, so a
     * difference here is a real one: a leg did not fill, filled partly, or one
     * has already been taken out.
     */
    if (Math.abs(p.qty) !== Math.abs(b.qty)) {
      findings.push({
        level: 'warn', kind: 'qty', symbol: sym, setupId: b.setupId, account: destId,
        detail: `${sym}: ${destId} holds ${p.qty}, this side sent ${b.qty} there. A leg `
          + 'did not fill, filled partly, or one has already been taken out.',
      });
    }
  }

  // ── held at the broker and unknown here — the dangerous direction ────────
  for (const p of positions) {
    if (believed.has(p.symbol) && !closedHere.has(p.symbol)) continue;
    findings.push({
      level: 'error', kind: 'unknown-position', symbol: p.symbol, account: destId,
      detail: `${p.symbol}: ${destId} HOLDS ${p.qty} AND THIS SIDE DOES NOT KNOW IT. `
        + (closedHere.has(p.symbol)
            ? 'It was closed here and is still on — the close did not take. '
            : 'Nothing here opened it. ')
        + 'The 15:50 flatten only closes what this side opened, so this one will '
        + 'go OVERNIGHT unless you close it yourself.',
    });
  }
  return findings;
}

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
  if (scope.blind.length) {
    out.ambiguous = true;
    out.findings.push({ level: 'error', kind: 'ambiguous-account', detail: scope.reason });
  }

  const dests = alpacaDests().filter(d => scope.readable.includes(d.id));
  if (!dests.length) {
    out.error = scope.reason || 'no readable Alpaca account';
    return out;
  }

  for (const d of dests) {
    const { creds } = credsForDest(d);
    const [pos, acct] = await Promise.all([
      alpaca.positions({ timeoutMs, account: creds }),
      alpaca.account({ timeoutMs, account: creds }),
    ]);

    if (!pos.ok) {
      /*
       * ONE UNREACHABLE ACCOUNT DOES NOT BLANK THE REPORT. It used to return
       * early, so a single timeout hid every finding about every other account
       * — and "nothing found" is the answer that gets a position left open.
       */
      out.findings.push({
        level: 'warn', kind: 'unreachable', account: d.id,
        detail: `could not ask ${d.id} what is open (${pos.error}) — its orders below `
          + 'are what THIS SIDE believes, unverified',
      });
      out.ok = false;
      continue;
    }
    out.reachable = true;
    const positions = pos.positions.map(p => ({ ...p, account: d.id }));
    out.positions.push(...positions);

    if (acct.ok) {
      // Per account, because a block is a property of the account and one
      // blocked account does not say anything about another.
      out.accounts = out.accounts || {};
      out.accounts[d.id] = acct.account;
      if (acct.account.tradingBlocked || acct.account.accountBlocked) {
        out.findings.push({
          level: 'error', kind: 'blocked', account: d.id,
          detail: `ALPACA HAS BLOCKED ${d.id} — every order to it today will be `
            + `refused (status ${acct.account.status})`,
        });
      }
    }

    out.findings.push(...findingsFor(date, d.id, positions));
  }

  /*
   * ORDERS SENT TO AN ACCOUNT THAT CANNOT BE READ. Reported once rather than
   * silently absent: those rows are unverified, and a report that simply did
   * not mention them reads as a clean account.
   */
  for (const id of scope.blind) {
    const { believed } = believedFor(date, id);
    if (believed.size) {
      out.findings.push({
        level: 'warn', kind: 'unverified-account', account: id,
        detail: `${believed.size} name(s) were sent to ${id}, which has no keys of `
          + 'its own — nothing here can check what it actually holds.',
      });
    }
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
  /*
   * EVERY READABLE ACCOUNT, EACH WITH ITS OWN KEYS, and the answer says which
   * position came from where.
   *
   * A pooled total would be worse than useless here: two accounts holding 100
   * WULF each is not one position of 200, and flattening against a merged
   * number closes the wrong quantity in both. So a position carries the
   * account that holds it, and two accounts holding the same name are two rows.
   *
   * An account that cannot be identified is REPORTED, never silently dropped —
   * a shorter list reads as "you hold less", which is the direction that gets
   * a position left open overnight.
   */
  const scope = credentialScope();
  const dests = alpacaDests().filter(d => scope.readable.includes(d.id));
  const positions = [];
  const problems = scope.blind.length ? [scope.reason] : [];
  let anyOk = false;

  for (const d of dests) {
    const { creds } = credsForDest(d);
    let r;
    try {
      r = await alpaca.positions({ timeoutMs, account: creds });
    } catch (err) { problems.push(`${d.id}: ${err.message}`); continue; }
    if (!r.ok) { problems.push(`${d.id}: ${r.error}`); continue; }
    anyOk = true;
    for (const p of r.positions) {
      if (p.qty === 0) continue;
      positions.push({ symbol: p.symbol, qty: p.qty, account: d.id });
    }
  }

  if (!anyOk) {
    return { ok: false, verifiable: dests.length > 0,
             reason: problems.join(' · ') || 'no readable Alpaca account',
             positions: null };
  }

  const value = {
    ok: problems.length === 0,
    verifiable: true,
    at: now,
    positions,
    // Which accounts this answer actually covers. Without it a partial answer
    // and a complete one look the same, and the difference is a position
    // nobody knows they are holding.
    scope: dests.map(d => d.id),
    ...(problems.length ? { reason: problems.join(' · ') } : {}),
  };
  // A PARTIAL ANSWER IS NOT CACHED. Caching it would keep an account invisible
  // for the whole cache window after its keys were fixed.
  if (!problems.length) _heldCache = { at: now, value };
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
  /*
   * ONE ACCOUNT AT A TIME, EACH AGAINST ITS OWN FILLS.
   *
   * This is the whole safety property. Confirmation matches by symbol, side and
   * time; pooling two accounts' fills and matching every row against the pool
   * would confirm account B's order with account A's print, at A's price, and
   * the match would look perfect. So the rows are split by the destination that
   * placed them and each group is confirmed only against fills fetched with
   * THAT account's credentials.
   *
   * A destination that cannot be identified is left UNCONFIRMED and named. Its
   * rows still come back — a day report that printed nothing because one
   * account was unreadable would be a worse failure than one that prints the
   * orders and says which prices are missing.
   */
  const after = new Date(`${date}T04:00:00-04:00`).toISOString();
  const byDest = new Map();
  for (const row of rows) {
    const id = row.destination || null;
    if (!byDest.has(id)) byDest.set(id, []);
    byDest.get(id).push(row);
  }

  const out = [];
  const errors = [];
  let anyVerified = false;
  // Kept as its own flag rather than inferred from the message: "could not be
  // told apart" is a configuration problem with a fix, and "Alpaca timed out"
  // is weather. A caller that has to tell them apart by reading prose will one
  // day read it wrongly.
  let ambiguous = false;
  const alpacaIds = new Set(alpacaDests().map(d => d.id));

  for (const [id, group] of byDest) {
    // Not an Alpaca account — TTP has no fill feed, so these are correctly
    // returned untouched rather than reported as a failure.
    if (id !== null && !alpacaIds.has(id)) { out.push(...group); continue; }
    /*
     * A row with NO destination predates destinations, or was placed before
     * one was named. It can only be attributed when there is exactly one
     * Alpaca account to attribute it to.
     */
    const target = id !== null ? id
      : (alpacaIds.size === 1 ? [...alpacaIds][0] : null);
    if (target === null) {
      out.push(...group);
      errors.push('some orders carry no account, and there is more than one '
        + 'Alpaca account — those cannot be confirmed');
      ambiguous = true;
      continue;
    }
    const { creds, error } = credsForDest(target);
    if (error) {
      out.push(...group); errors.push(error); ambiguous = true; continue;
    }
    let r;
    try {
      r = await alpaca.fills({ after, timeoutMs, account: creds });
    } catch (err) {
      out.push(...group); errors.push(`${target}: ${err.message}`); continue;
    }
    if (!r.ok) { out.push(...group); errors.push(`${target}: ${r.error}`); continue; }
    out.push(...broker.confirmFromFills(group, r.fills));
    anyVerified = true;
  }

  return {
    ok: errors.length === 0,
    error: errors.length ? errors.join(' · ') : undefined,
    rows: out,
    verifiable: anyVerified,
    ...(ambiguous ? { ambiguous: true } : {}),
    // Named so a partly-confirmed day is legible: some prices are real and
    // some are missing, and which is which matters more than the total.
    unconfirmed: errors.length ? errors : undefined,
  };
}

module.exports = {
  compare, carriedOver, flatSymbols, fillsFor, confirmed, heldNow,
  alpacaDestinations, credentialScope,
  // Exported so the journal import can fetch each account's fills with that
  // account's keys rather than reimplementing the credential rule.
  credsForDest,
};
