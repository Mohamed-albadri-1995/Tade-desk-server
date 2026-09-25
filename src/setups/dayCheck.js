/*
 * THE DAILY CHECK — today's backtest against what live actually did.
 *
 * Asked 2026-09-25: "a tab on Algo that runs every day exactly after the
 * market close, backtests just today and compares it with what happened live.
 * The backtest must match the live settings and use the live feed. For each
 * enabled setup: which trades the backtest takes vs live, and for each trade
 * entry price and time, quantity, every leg's exit price and time, final P&L.
 * A method to find mismatches and solve them."
 *
 * THE TWO SIDES
 *
 *   backtest   qp's real engine for one day (POST /api/backtest/day), with the
 *              spec the desk hands the backtest form (backtestSpec.specFor)
 *              plus: the setup's LIVE feed and view, this account's "Size vs
 *              standard", no costs (so a price difference is the execution,
 *              visible, not buried in a model), and a universe of the tools'
 *              R1 register PLUS every name live evaluated today.
 *
 *   live       the desk's own ledger (what was decided and sent, leg by leg,
 *              and every close it sent with its reason), and — for an Alpaca
 *              account — Alpaca's orders: the real fills, which bracket child
 *              closed each leg (the target or the stop) and every market close.
 *              Trade The Pool has no fill feed: its side is the ledger only.
 *
 * READING, NEVER SENDING. Nothing here places or changes an order.
 *
 * WHY A TRADE IS ON ONE SIDE ONLY is answered from the session log: whether
 * the setup ran on that bar, whether the name was on the card list, whether it
 * was picked and then dropped (stale, already alerted) or refused by the
 * broker. "Live evaluated it and found nothing" is its own answer — the bars
 * live saw that minute were not the bars the backtest reads now.
 */

const fs = require('fs');
const path = require('path');
const { toETDate } = require('../utils/time');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const OUT_DIR = process.env.DAYCHECK_DIR || path.join(DIR, 'history');

/** When it runs: after the 16:00 close, once Yahoo's last bars are final. */
const RUN_AT = '16:10';
const RETRY_UNTIL = '18:00';
const RETRY_EVERY_MIN = 15;

// ── small helpers ─────────────────────────────────────────────────────────

const round = (n, dp = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
const num = (v) => (v === null || v === undefined || v === '' ? null
  : (Number.isFinite(Number(v)) ? Number(v) : null));

function etClock(at, seconds = false) {
  if (at === null || at === undefined || at === '') return null;
  const ms = typeof at === 'number' ? (at < 1e12 ? at * 1000 : at) : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  }).format(new Date(ms));
}
function toMs(at) {
  if (at === null || at === undefined || at === '') return null;
  if (typeof at === 'number') return at < 1e12 ? at * 1000 : at;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}
function mins(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const sideOf = (s) => (/short|sell/i.test(String(s || '')) ? 'short' : 'long');

/** What closed the rest of a backtest trade, in words a trader uses. */
function btExitKind(reason) {
  const r = String(reason || '');
  if (/^T\d|^TP$/.test(r)) return 'target';
  if (r === 'SL') return 'stop';
  if (r === 'trail') return 'trailing stop';
  if (r === 'exit') return 'exit rule';
  if (r === 'eod') return '15:50 close';
  if (r === 'open') return 'still open';
  return r || 'unknown';
}

/**
 * A close the desk SENT, named by the reason it was sent — the words
 * manager.closeVerdict and the flattener write on the ledger row — so it can
 * be set against the backtest's own exit reason.
 */
function closeKind(why) {
  const w = String(why || '');
  if (/end of session|15:50|flatten/i.test(w)) return '15:50 close';
  if (/exit rule/i.test(w)) return 'exit rule';
  if (/trailing stop/i.test(w)) return 'trailing stop';
  if (/stop was hit/i.test(w)) return 'stop';
  if (/last target/i.test(w)) return 'target';
  return w ? 'close' : 'close (no reason on the ledger)';
}

/** The same exit, whichever side says it. A market close with no reason
 *  matches any close-type exit — it is the manager's, reason unrecorded. */
function sameExit(bk, lk) {
  if (!bk || !lk) return false;
  const parts = String(lk).split(' + ');
  return parts.every(p => p === bk || (p.startsWith('close') && bk !== 'target'));
}

// ── the backtest side ─────────────────────────────────────────────────────

/**
 * One backtest trade, split into the legs live would have sent.
 *
 * Split with the broker's own splitLegs, on the backtest's share count and the
 * exit plan qp attached (decide.exit_plan — the one live builds its bracket
 * from), so leg N here is leg N of the live order. A leg the backtest banked
 * exits at its target; every other share leaves with the trade's final exit.
 */
function backtestTrade(t, splitLegs) {
  const c = t.ctx || {};
  const side = sideOf(t.side);
  const sgn = side === 'long' ? 1 : -1;
  const shares = Math.floor(Number(c.acct_shares) || 0);
  const entry = num(t.entry);
  const plan = t.plan || null;
  const split = plan && shares > 0 && splitLegs
    ? splitLegs(shares, plan) : { parts: shares > 0 ? [{ quantity: shares, target: null, runner: true }] : [] };
  const banked = (t.legs || []).map(l => ({ ...l, used: false }));
  const final = { kind: btExitKind(t.reason), price: num(t.exit), at: etClock(t.exit_ts) };
  const legs = (split.parts || []).map((p) => {
    let hit = null;
    if (p.target) {
      let best = null;
      for (const b of banked) {
        if (b.used) continue;
        const d = Math.abs(Number(b.price) - p.target) / p.target;
        if (d < 0.01 && (!best || d < best.d)) best = { b, d };
      }
      if (best) { best.b.used = true; hit = best.b; }
    }
    const exit = hit
      ? { kind: 'target', price: num(hit.price), at: etClock(hit.exit_ts) }
      : { ...final };
    const pnl = exit.price !== null && entry !== null ? sgn * (exit.price - entry) * p.quantity : null;
    return { qty: p.quantity, target: p.target || null, runner: !!p.runner, exit,
             pnl: round(pnl, 2) };
  });
  const pnl = legs.every(l => l.pnl !== null) ? round(legs.reduce((n, l) => n + l.pnl, 0), 2) : null;
  return {
    symbol: String(t.symbol).toUpperCase(),
    side,
    decisionBar: c.signal_ts ? etClock(c.signal_ts) : etClock(Number(t.entry_ts) - 60),
    decisionPrice: num(c.signal_px),
    entry: { price: entry, at: etClock(t.entry_ts), qty: shares },
    stop: num(t.stop),
    legs,
    exit: final,
    pnl,
    notOnRegister: !!c._extra,
    note: c.acct_note || null,
    // SIGNALLED AND NOT TAKEN: sized to no shares — no borrow, no money left,
    // a stop too wide for one share. The backtest did not trade it either.
    skipped: shares < 1 ? (c.acct_note || 'sized to 0 shares') : null,
  };
}

// ── the live side ─────────────────────────────────────────────────────────

const NOT_ENTRY = new Set(['flatten', 'callback', 'fill', 'intent']);

/** The day's entry rows for one setup — sent or refused — per (account, name). */
function ledgerEntries(rows, setupId) {
  const out = new Map();
  for (const o of rows) {
    if (NOT_ENTRY.has(o.kind) || String(o.setupId || '') !== String(setupId)) continue;
    if (!o.symbol) continue;
    const key = `${o.destination || '-'}|${String(o.symbol).toUpperCase()}`;
    const was = out.get(key);
    // A sent row beats a refusal, and the earliest sent row is the entry.
    if (was && was.sent && (!o.sent || (o.at || 0) >= (was.at || 0))) continue;
    out.set(key, o);
  }
  return out;
}

/** The closes this desk SENT for a name in one account, with their reasons. */
function ledgerCloses(rows, symbol, dest) {
  return rows.filter(o => o.kind === 'flatten'
    && String(o.symbol || '').toUpperCase() === symbol
    && (o.destination || null) === (dest || null))
    .map(o => ({ at: o.at, source: o.source || null, sent: !!o.sent,
                 error: o.sent ? null : (o.error || o.skipped || null) }));
}

/** What the ledger alone says about a live trade — all TTP ever has. */
function liveFromLedger(o, closes) {
  const legs = Array.isArray(o.legs) && o.legs.length
    ? o.legs.filter(l => l.sent !== false).map(l => ({ qty: num(l.quantity), target: num(l.target) }))
    : [{ qty: num(o.quantity), target: num(o.target) }];
  const firstClose = closes.find(c => c.sent);
  return {
    symbol: String(o.symbol).toUpperCase(),
    side: sideOf(o.signal),
    decisionBar: o.decisionBar || null,
    decisionPrice: num(o.price),
    sentAt: etClock(o.at, true),
    entry: { price: null, at: null, qty: num(o.quantity), planned: num(o.price) },
    stop: num(o.stop),
    legs: legs.map(l => ({ ...l, runner: !l.target,
      exit: firstClose
        ? { kind: 'close sent', price: null, at: etClock(firstClose.at, true),
            why: firstClose.source }
        : { kind: 'unknown', price: null, at: null } })),
    pnl: null,
    reduced: o.reduced || null,
    source: 'ledger',
  };
}

/**
 * The real trade, from Alpaca's orders for one account.
 *
 * Entry: every entry-side order for the name, filled. Each is one leg of the
 * scale-out (the desk sends a bracket per leg), in the order sent. A leg's
 * exit is its bracket child that filled — a limit is the TARGET, a stop the
 * STOP — or, when neither did, the market close the desk sent (manager or the
 * 15:50 flatten), named from the ledger's own close row.
 */
function liveFromAlpaca(o, orders, closes) {
  const symbol = String(o.symbol).toUpperCase();
  const side = sideOf(o.signal);
  const entrySide = side === 'long' ? 'buy' : 'sell';
  const mine = (orders || []).filter(x => x.symbol === symbol);
  const parents = mine.filter(x => x.side === entrySide && x.filledQty > 0)
    .sort((a, b) => (toMs(a.submittedAt) || 0) - (toMs(b.submittedAt) || 0));
  if (!parents.length) return null;
  const closers = mine.filter(x => x.side !== entrySide && x.filledQty > 0)
    .sort((a, b) => (toMs(a.filledAt) || 0) - (toMs(b.filledAt) || 0));
  const labelFor = (at) => {
    const ms = toMs(at);
    let best = null;
    for (const c of closes) {
      const d = Math.abs((c.at || 0) - ms);
      if (d < 180000 && (!best || d < best.d)) best = { c, d };
    }
    return best ? best.c.source : null;
  };

  const eQty = parents.reduce((n, p) => n + p.filledQty, 0);
  const eCost = parents.reduce((n, p) => n + p.filledQty * p.filledAvg, 0);
  const firstFill = parents.map(p => toMs(p.filledAt)).filter(Boolean).sort((a, b) => a - b)[0];

  // Closes the desk sent, shared out to legs whose bracket did not close them.
  const pool = closers.map(c => ({ left: c.filledQty, price: c.filledAvg, at: c.filledAt,
                                   why: labelFor(c.filledAt) }));
  const takeClose = (qty) => {
    const got = [];
    let need = qty;
    for (const c of pool) {
      if (need <= 0) break;
      if (c.left <= 0) continue;
      const q = Math.min(need, c.left);
      c.left -= q; need -= q;
      got.push({ qty: q, price: c.price, at: c.at, why: c.why });
    }
    return got;
  };

  const legs = parents.map((p) => {
    const kids = (p.legs || []).filter(k => k.filledQty > 0);
    const target = (p.legs || []).find(k => k.type === 'limit');
    const parts = kids.map(k => ({
      qty: k.filledQty, price: k.filledAvg, at: k.filledAt,
      kind: k.type === 'limit' ? 'target' : (/stop/.test(k.type) ? 'stop' : k.type),
    }));
    const closed = parts.reduce((n, k) => n + k.qty, 0);
    for (const c of takeClose(p.filledQty - closed)) {
      parts.push({ ...c, kind: closeKind(c.why) });
    }
    const q = parts.reduce((n, k) => n + k.qty, 0);
    const px = q ? parts.reduce((n, k) => n + k.qty * k.price, 0) / q : null;
    const last = parts.map(k => toMs(k.at)).filter(Boolean).sort((a, b) => b - a)[0];
    const sgn = side === 'long' ? 1 : -1;
    return {
      qty: p.filledQty,
      target: target ? num(target.limitPrice) : null,
      runner: !target,
      entryPrice: num(p.filledAvg),
      exit: parts.length
        ? { kind: [...new Set(parts.map(k => k.kind))].join(' + '), price: round(px),
            at: etClock(last, true), why: parts.map(k => k.why).find(Boolean) || null,
            qty: q }
        : { kind: 'still open', price: null, at: null },
      pnl: q ? round(sgn * (px - p.filledAvg) * q, 2) : null,
    };
  });

  // Every fill on the name, bracket children included — they are nested under
  // their parent, and leaving them out reads a closed trade as still open.
  const all = mine.flatMap(x => [x, ...(x.legs || [])]).filter(x => x.filledQty > 0);
  const sells = all.filter(x => x.side === 'sell').reduce((n, x) => n + x.filledQty * x.filledAvg, 0);
  const buys = all.filter(x => x.side === 'buy').reduce((n, x) => n + x.filledQty * x.filledAvg, 0);
  const net = all.reduce((n, x) => n + (x.side === 'buy' ? 1 : -1) * x.filledQty, 0);
  return {
    symbol,
    side,
    decisionBar: o.decisionBar || null,
    decisionPrice: num(o.price),
    sentAt: etClock(o.at, true),
    entry: { price: round(eCost / eQty), at: etClock(firstFill, true), qty: eQty,
             planned: num(o.price) },
    stop: num(o.stop),
    legs,
    pnl: net === 0 ? round(sells - buys, 2) : null,
    openQty: net === 0 ? 0 : Math.abs(net),
    reduced: o.reduced || null,
    source: 'alpaca',
  };
}

// ── comparing ─────────────────────────────────────────────────────────────

/**
 * Field by field, each with a verdict: 'ok', 'warn' (a price or a minute off,
 * the cost of executing), 'bad' (a different trade — side, bar, size, or how a
 * leg ended).
 */
function compare(bt, live) {
  const rows = [];
  const add = (field, b, l, level, note = null) => rows.push({ field, bt: b, live: l, level, note });
  const px = (a, b, tolPct) => {
    if (a === null || b === null) return 'na';
    return Math.abs(a - b) <= Math.max(0.01, Math.abs(a) * tolPct) ? 'ok' : 'warn';
  };

  add('side', bt.side, live.side, bt.side === live.side ? 'ok' : 'bad');
  const dm = (mins(live.decisionBar) ?? NaN) - (mins(bt.decisionBar) ?? NaN);
  add('decision bar', bt.decisionBar, live.decisionBar,
    Number.isNaN(dm) ? 'na' : (dm === 0 ? 'ok' : 'bad'),
    Number.isNaN(dm) || dm === 0 ? null : `live decided ${Math.abs(dm)} min ${dm > 0 ? 'later' : 'earlier'}`);
  const dpx = px(bt.decisionPrice, live.decisionPrice, 0.001);
  add('decision price', bt.decisionPrice, live.decisionPrice, dpx,
    dpx === 'warn' ? 'the close of the decision bar — the two read different bars' : null);
  add('stop', bt.stop, live.stop, px(bt.stop, live.stop, 0.0005));
  add('quantity', bt.entry.qty, live.entry.qty,
    bt.entry.qty === live.entry.qty ? 'ok' : 'bad');
  if (live.entry.price !== null) {
    const slip = bt.entry.price !== null ? round((live.entry.price - bt.entry.price) * (bt.side === 'long' ? 1 : -1), 4) : null;
    add('entry price', bt.entry.price, live.entry.price, px(bt.entry.price, live.entry.price, 0.002),
      slip === null ? null : `${slip > 0 ? 'worse' : 'better'} by $${Math.abs(slip)} a share`);
  } else {
    add('entry price', bt.entry.price, live.entry.planned, 'na', 'no fill feed — the decided price, not a fill');
  }
  add('entry time', bt.entry.at, live.entry.at || live.sentAt,
    live.entry.at ? ((mins(live.entry.at) - mins(bt.entry.at)) <= 1 ? 'ok' : 'warn') : 'na');

  const n = Math.max(bt.legs.length, live.legs.length);
  const legs = [];
  for (let i = 0; i < n; i += 1) {
    const b = bt.legs[i] || null;
    const l = live.legs[i] || null;
    const L = [];
    const ad = (field, bv, lv, level, note = null) => L.push({ field, bt: bv, live: lv, level, note });
    ad('quantity', b && b.qty, l && l.qty, b && l && b.qty === l.qty ? 'ok' : 'bad');
    ad('target', b && b.target, l && l.target,
      !b || !l ? 'bad' : ((b.target === null && l.target === null) ? 'ok' : px(b.target, l.target, 0.0005)));
    const bk = b && b.exit.kind;
    const lk = l && l.exit.kind;
    const sameKind = sameExit(bk, lk);
    ad('how it ended', bk, lk, !b || !l || lk === 'unknown' ? 'na' : (sameKind ? 'ok' : 'bad'),
      l && l.exit.why ? `live: ${l.exit.why}` : null);
    ad('exit price', b && b.exit.price, l && l.exit.price,
      b && l ? px(b.exit.price, l.exit.price, 0.002) : 'na');
    ad('exit time', b && b.exit.at, l && l.exit.at,
      b && l && b.exit.at && l.exit.at
        ? (Math.abs(mins(l.exit.at) - mins(b.exit.at)) <= 1 ? 'ok' : 'warn') : 'na');
    ad('P&L', b && b.pnl, l && l.pnl, 'info');
    legs.push({ n: i + 1, runner: !!((b && b.runner) || (l && l.runner)), rows: L });
  }

  const pnlDiff = bt.pnl !== null && live.pnl !== null ? round(live.pnl - bt.pnl, 2) : null;
  add('P&L', bt.pnl, live.pnl,
    pnlDiff === null ? 'na'
      : (Math.abs(pnlDiff) <= Math.max(5, Math.abs(bt.pnl) * 0.1) ? 'ok' : 'warn'),
    pnlDiff === null ? null : `live ${pnlDiff >= 0 ? '+' : ''}${pnlDiff} vs the backtest`);
  const worst = [...rows, ...legs.flatMap(g => g.rows)]
    .reduce((w, r) => (r.level === 'bad' ? 'bad' : (r.level === 'warn' && w !== 'bad' ? 'warn' : w)), 'ok');
  return { rows, legs, worst, pnlDiff };
}

// ── the cause of each difference ────────────────────────────────────────
/*
 * EVERY DIFFERENCE GETS A CAUSE, because "they differ" is not something that
 * can be fixed and each cause has its own fix:
 *
 *   DATA       the bars live read were not the final bars (latency, a bar
 *              Yahoo was still finishing) — the settle delay, the feed
 *   EXECUTION  the fill: the price the order got against the model's
 *   KNOCK-ON   a consequence of an earlier difference — less money left
 *              because another trade was still open, or had closed early
 *   BROKER     the broker said no where the backtest said yes (a borrow)
 *   UNIVERSE   the stock was not on live's card list at that minute
 *   SYSTEM     the setup did not run, or a run failed
 *   LOGIC      the decision itself differs — a bug to fix
 *
 * DATA is only ever claimed when the logic check passed: the live decision,
 * replayed on the final bars, took exactly the backtest's trades — so the
 * same logic on the bars live read is what produced the difference.
 */
function causesOf(item, logicOk) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  const data = logicOk ? 'DATA' : 'LOGIC';
  if (item.status === 'both' && item.cmp) {
    const row = f => item.cmp.rows.find(r => r.field === f) || {};
    const b = item.bt;
    const l = item.live;
    const n4 = v => (v === null || v === undefined ? '—' : String(Math.round(Number(v) * 10000) / 10000));
    // EXACT, not within a tolerance: the size divides by the distance to the
    // stop, so a stop 0.3 cents away is 54 shares on MGNI (2026-09-25).
    const same = (x, y) => x == null || y == null || Math.abs(Number(x) - Number(y)) < 1e-6;
    const priceOff = !same(b.decisionPrice, l.decisionPrice);
    const stopOff = !same(b.stop, l.stop);
    if (row('side').level === 'bad') add(data, 'a different side fired on the bars live read');
    if (row('decision bar').level === 'bad') {
      add(data, `the signal came on ${l.decisionBar} in the bars live read, on `
        + `${b.decisionBar} in the final bars`);
    }
    if (priceOff) {
      add('DATA', `live read the ${b.decisionBar} bar before it was final: close `
        + `${n4(l.decisionPrice)} live, ${n4(b.decisionPrice)} final`
        + (stopOff ? `; the stop with it: ${n4(l.stop)} live, ${n4(b.stop)} final` : ''));
    } else if (stopOff) {
      add(data, `the stop's level came from bars that changed after live read them: `
        + `${n4(l.stop)} live, ${n4(b.stop)} final`);
    }
    if (b.entry.qty !== l.entry.qty) {
      const rpsB = Math.abs(Number(b.decisionPrice) - Number(b.stop));
      const rpsL = Math.abs(Number(l.decisionPrice) - Number(l.stop));
      // What live's count would be if the risk per share were the only
      // difference: the backtest's count scaled by the two distances.
      const expected = rpsL > 0 ? b.entry.qty * (rpsB / rpsL) : null;
      const explained = expected !== null
        && Math.abs(l.entry.qty - expected) <= Math.max(2, expected * 0.02);
      if ((priceOff || stopOff) && explained) {
        add(data, `the size follows the risk per share: ${n4(rpsL)} live, ${n4(rpsB)} final `
          + `→ ${l.entry.qty} and ${b.entry.qty} shares`);
      } else if (l.reduced) {
        add('KNOCK-ON', `live's order was cut to the money left: ${l.reduced}`);
      } else if (b.note) {
        add('KNOCK-ON', `the backtest's size was cut: ${b.note}`);
      } else if (!priceOff && !stopOff && !l.reduced) {
        add('LOGIC', `the same price and stop sized differently: ${l.entry.qty} live, ${b.entry.qty} backtest`);
      } else {
        add('KNOCK-ON', `the money left differed — an earlier trade was still open on one side `
          + `and not the other (${l.entry.qty} live, ${b.entry.qty} backtest)`);
      }
    }
    const ep = row('entry price');
    if (ep.level === 'warn') add('EXECUTION', `the entry filled ${ep.note || 'away from the model'}`);

    // The legs, their causes grouped: "every leg: …" rather than three lines.
    const perLeg = new Map();
    const note = (kind, text, name) => {
      const k = `${kind}|${text}`;
      if (!perLeg.has(k)) perLeg.set(k, { kind, text, names: [] });
      perLeg.get(k).names.push(name);
    };
    const legs = item.cmp.legs || [];
    legs.forEach((g) => {
      const r = f => g.rows.find(x => x.field === f) || {};
      const name = g.runner ? 'the runner' : `leg ${g.n}`;
      const lLeg = (l.legs || [])[g.n - 1] || {};
      const how = r('how it ended');
      if (how.level === 'bad') {
        note(data, `ended by ${how.live} live and by ${how.bt} in the backtest — `
          + 'the exit was judged on the bars live read', name);
        return;
      }
      const px = r('exit price');
      if (r('exit time').level === 'warn') {
        // A different MINUTE is the cause; the price is its consequence.
        note(data, `left at ${r('exit time').live} live, ${r('exit time').bt} in the backtest`
          + (px.level === 'warn' ? ` (${n4(px.live)} against ${n4(px.bt)})` : '')
          + ((lLeg.exit || {}).why ? ' — the manager judged it on the bars live read'
            : ' — the level was reached at a different minute in the bars live read'), name);
        return;
      }
      // Measured whatever the display tolerance: on 2,880 shares four cents
      // is $115, which is not a rounding.
      if (/stop/.test(String(how.live)) && l.stop != null && !(lLeg.exit || {}).why
          && px.live != null && px.bt != null) {
        // THE BROKER'S STOP. Each side is measured from its OWN level: how far
        // past it the fill landed is the execution (the model also fills past
        // it, at the open, when a bar gaps through — MGNI 23.98 under 24.04).
        // Where the level itself sat is the data, said once above.
        const sgn = b.side === 'short' ? -1 : 1;
        const liveSlip = Math.max(0, sgn * (Number(l.stop) - Number(px.live)));
        const btSlip = Math.max(0, sgn * (Number(b.stop) - Number(px.bt)));
        if (Math.abs(liveSlip - btSlip) > 0.01) {
          note('EXECUTION', `the stop filled ${n4(liveSlip)} past its level live (${n4(px.live)} `
            + `against ${n4(l.stop)}), ${n4(btSlip)} in the model`, name);
        }
        return;
      }
      if (px.level !== 'warn') return;
      if ((lLeg.exit || {}).why) {
        note('EXECUTION', `closed at market by the manager at ${n4(px.live)}; the model's exit `
          + `was ${n4(px.bt)}`, name);
        return;
      }
      note('EXECUTION', `filled at ${n4(px.live)} against the model's ${n4(px.bt)}`, name);
    });
    for (const v of perLeg.values()) {
      const who = v.names.length === legs.length && legs.length > 1 ? 'every leg'
        : v.names.join(', ');
      add(v.kind, `${who}: ${v.text}`);
    }
    return out;
  }
  for (const w of item.why || []) {
    const t = String(w);
    if (/^open the chart/i.test(t)) continue;       // advice, not a cause
    let kind = 'LOGIC';
    if (/not shortable|cannot be sold short|borrow|refused|not sent/i.test(t)) kind = 'BROKER';
    else if (/limit of \d+ position|already used/i.test(t)) kind = 'KNOCK-ON';
    else if (/not on the card list|never evaluated/i.test(t)) kind = 'UNIVERSE';
    else if (/never ran|did not run|run failed/i.test(t)) kind = 'SYSTEM';
    else if (/stale|feed was late|found no signal|bars live|RANKED OUT|revised|chart:/i.test(t)) kind = data;
    else if (/signalled it too and did not take it|signalled, not taken/i.test(t)) kind = 'KNOCK-ON';
    else if (/found no trade on/i.test(t)) kind = data;
    add(kind, t);
  }
  return out;
}

// ── why a trade is on one side only ───────────────────────────────────────

/** Why live has no trade the backtest took, from the day's own records. */
function whyNotLive(symbol, bar, runs, refusals) {
  const out = [];
  for (const r of refusals) {
    out.push(`the order was not sent to ${r.destination || 'the account'}: `
      + `${r.error || r.skipped || 'refused'}`);
  }
  if (out.length) return out;
  const real = runs.filter(r => !r.dryRun && !r.rehearsal);
  if (!real.length) return ['the setup never ran today — check the tool that owns it on Health'];
  const at = real.filter(r => r.bar === bar);
  if (!at.length) {
    return [`the setup did not run on the ${bar} bar (it ran on `
      + `${[...new Set(real.map(r => r.bar))].slice(0, 6).join(', ')}${real.length > 6 ? ', …' : ''})`];
  }
  for (const r of at) {
    if (r.ok === false) { out.push(`the ${bar} run failed: ${r.error || 'no reason'}`); continue; }
    const picked = (r.picks || []).find(p => p.ticker === symbol);
    if (picked) {
      const refused = (picked.orders || []).filter(o => !o.sent);
      out.push(refused.length
        ? `picked at ${bar} and not ordered: ${refused.map(o => o.skipped || o.error || 'refused').join('; ')}`
        : `picked at ${bar}; no order row was found in the ledger`);
      continue;
    }
    const named = (list) => (list || []).some(x => x === symbol || String(x).startsWith(`${symbol}@`));
    if (named((r.dropped || {}).rankedOut)) {
      const took = (r.picks || []).map(p => p.ticker).filter(Boolean);
      out.push(`signalled at ${bar} and was RANKED OUT — live took the top `
        + `${(r.rank && r.rank.topN) || took.length}${took.length ? ` (${took.join(', ')})` : ''}; `
        + 'the backtest ranked it higher, so the two ranked on different numbers');
      continue;
    }
    if (named((r.dropped || {}).stale)) {
      out.push(`found on an older bar than ${bar} and dropped as stale — the feed was late`
        + (r.feed && r.feed.lagMin ? ` (${r.feed.lagMin} min behind)` : ''));
      continue;
    }
    if (named((r.dropped || {}).latched)) {
      out.push(`already alerted today — the once-per-name latch`);
      continue;
    }
    if (Array.isArray(r.symbols)) {
      if (!r.symbols.includes(symbol)) {
        const first = real.find(x => Array.isArray(x.symbols) && x.symbols.includes(symbol));
        out.push(`not on the card list at ${bar}${first ? ` (first evaluated at ${first.bar})`
          : ' (never evaluated live today)'}`);
      } else {
        out.push(`evaluated live at ${bar} and qp found no signal — the bars live read that `
          + 'minute are not the bars the backtest reads now (a late or revised feed)'
          + (r.feed && r.feed.lagMin ? `; the feed was ${r.feed.lagMin} min behind` : ''));
      }
    } else {
      out.push(`the ${bar} run did not pick it (the log from before 2026-09-25 does not `
        + 'list which names were asked)');
    }
  }
  return out.length ? out : ['no record explains it'];
}

/** Why the backtest has no trade live took. */
function whyNotBacktest(symbol, btSummary, btError) {
  if (btError) return [`the backtest did not run: ${btError}`];
  const out = [`the backtest found no trade on ${symbol} today`];
  const dc = ((btSummary || {}).coverage || {}).desk_caps;
  if (dc && (dc.dropped_day_cap || dc.dropped_same_stock)) {
    out.push(`its desk limits dropped ${dc.dropped_day_cap || 0} trade(s) for the day cap `
      + `and ${dc.dropped_same_stock || 0} re-entries`);
  }
  out.push('open the chart: if the signal is there, the live bars at that minute were '
    + 'different from the bars now (revised feed); if not, live acted on a signal the '
    + 'strategy does not give');
  return out;
}

// ── the whole day ─────────────────────────────────────────────────────────

/**
 * Build the day's report. Every dependency can be handed in, so the matching
 * is tested on fixtures rather than on a live box.
 */
async function build(date = toETDate(Date.now()), deps = {}) {
  const catalog = deps.catalog || require('./catalog');
  const prefs = deps.prefs || require('./prefs');
  const broker = deps.broker || require('../broker/signalstack');
  const qp = deps.qp || require('./qpClient');
  const sessionLog = deps.sessionLog || require('./sessionLog');
  const risk = deps.risk || require('./risk');
  const specFor = deps.specFor || require('./backtestSpec').specFor;
  const alpacaOrders = deps.alpacaOrders || defaultAlpacaOrders;

  const started = Date.now();
  const ledger = broker.orders(date);
  const setups = (await catalog.list()).filter(s => prefs.isEnabled(s.id));
  const account = risk.settings();
  const ordersCache = new Map();
  const ordersFor = async (dest) => {
    if (!ordersCache.has(dest.destinationId)) {
      ordersCache.set(dest.destinationId, await alpacaOrders(dest, date));
    }
    return ordersCache.get(dest.destinationId);
  };

  const report = { ok: true, date, ranAt: started, setups: [] };
  for (const setup of setups) {
    const entries = ledgerEntries(ledger, setup.id);
    const runs = sessionLog.runsOn(date, setup.id) || [];
    const evaluated = [...new Set(runs.flatMap(r => r.symbols || []))];
    const tradedLive = [...new Set([...entries.values()].map(o => String(o.symbol).toUpperCase()))];

    // The accounts: every one this setup sends to, and any that holds an
    // order of it today (a setting changed since the morning).
    const cfgs = broker.accountsFor(setup.id) || [];
    const destIds = new Set(cfgs.map(c => c.destinationId));
    for (const o of entries.values()) {
      if (o.destination && !destIds.has(o.destination)) {
        const c = broker.destinationCfg(o.destination);
        if (c) { cfgs.push(c); destIds.add(o.destination); }
      }
    }

    const base = specFor(setup, account);
    const universe = base.universe
      ? { ...base.universe, extra_symbols: [...new Set([...evaluated, ...tradedLive])] }
      : { kind: 'symbols', symbols: [...new Set([...evaluated, ...tradedLive])] };
    const settings = {
      feed: setup.feed || 'yahoo', view: setup.view || 'all', tf: base.tf, fill: base.fill,
      riskUsd: base.risk_usd || null, riskPct: base.risk_pct || null,
      accountSize: base.account_equity, maxPositionPct: base.max_position_pct || null,
      rank: base.rank_per_day, rules: base.rules,
    };
    const out = { id: setup.id, name: setup.name, settings, accounts: [], trades: [],
                  evaluated: evaluated.length, runs: runs.length };

    const noSymbols = universe.kind === 'symbols' && !universe.symbols.length;
    const btByRatio = new Map();
    const backtestAt = async (ratio) => {
      if (noSymbols) return { ok: false, error: 'no tools and no names evaluated live — nothing to backtest' };
      if (btByRatio.has(ratio)) return btByRatio.get(ratio);
      const spec = {
        ...base,
        name: `daily check ${setup.name} ${date}`,
        strategy_ids: setup.strategyIds || [],
        start: date, end: date,
        feed: settings.feed, view: settings.view,
        size_ratio: ratio,
        cost_bps: 0, fee_per_share: 0, fee_min: 0,
        check_shortable: true, scan_gate: true,
        target_r: setup.targetR || 2.0,
        universe,
        // The logic check, once per setup: the live decision replayed on
        // these same final bars (chart/replay.py).
        replay_live: btByRatio.size === 0,
        // The fill the live MANAGER runs with — the setup's, as manager.js
        // sends it — for the exit half of the replay.
        live_fill: setup.fill || 'live',
      };
      let r;
      try { r = { ok: true, ...(await qp.backtestDay(spec)) }; }
      catch (err) { r = { ok: false, error: err.message }; }
      btByRatio.set(ratio, r);
      return r;
    };

    if (!cfgs.length) {
      // No account: still worth knowing what the backtest took.
      cfgs.push({ destinationId: null, destinationName: 'no account', ratio: 1, dialect: null });
    }

    const bySymbol = new Map();
    for (const cfg of cfgs) {
      const ratio = risk.ratioOf(cfg);
      const bt = await backtestAt(ratio);
      const acct = { id: cfg.destinationId, name: cfg.destinationName || cfg.destinationId,
                     dialect: cfg.dialect || null, ratio,
                     backtest: bt.ok ? { trades: (bt.trades || []).length,
                                         coverage: (bt.summary || {}).coverage || null }
                       : { error: bt.error } };
      let alp = null;
      if (cfg.dialect === 'alpaca' && cfg.destinationId) {
        alp = await ordersFor(cfg);
        acct.fills = alp && alp.ok ? 'alpaca' : `not read: ${(alp && alp.error) || 'no keys'}`;
      } else {
        acct.fills = cfg.destinationId ? 'none — this broker has no fill feed; the ledger only' : null;
      }
      out.accounts.push(acct);

      const btTrades = bt.ok ? (bt.trades || []).map(t => backtestTrade(t, broker.splitLegs)) : [];
      const liveTrades = [];
      for (const o of entries.values()) {
        if ((o.destination || null) !== (cfg.destinationId || null)) continue;
        const sym = String(o.symbol).toUpperCase();
        if (!o.sent) continue;
        const closes = ledgerCloses(ledger, sym, o.destination || null);
        const real = alp && alp.ok ? liveFromAlpaca(o, alp.orders, closes) : null;
        liveTrades.push(real || liveFromLedger(o, closes));
      }
      const refusedHere = [...entries.values()].filter(o => !o.sent
        && (o.destination || null) === (cfg.destinationId || null));

      const syms = new Set([...btTrades.map(t => t.symbol), ...liveTrades.map(t => t.symbol)]);
      for (const sym of syms) {
        const found = btTrades.find(t => t.symbol === sym) || null;
        const skipped = found && found.skipped ? found : null;
        const b = skipped ? null : found;
        const l = liveTrades.find(t => t.symbol === sym) || null;
        if (!bySymbol.has(sym)) {
          bySymbol.set(sym, { symbol: sym, side: (found || l).side, accounts: [] });
        }
        const row = bySymbol.get(sym);
        const status = b && l ? 'both' : (b ? 'backtest only'
          : (l ? 'live only' : 'skipped by both'));
        const item = { account: acct.name, status, bt: b, live: l };
        if (skipped) item.btSkipped = skipped.skipped;
        if (b && l) item.cmp = compare(b, l);
        else if (!b && !l) {
          // Neither traded it. The same outcome — said with both reasons.
          item.why = [`backtest: signalled, not taken — ${skipped.skipped}`,
            ...whyNotLive(sym, skipped.decisionBar, runs,
              refusedHere.filter(o => String(o.symbol).toUpperCase() === sym))
              .map(w => `live: ${w}`)];
        } else if (b) {
          item.why = whyNotLive(sym, b.decisionBar, runs,
            refusedHere.filter(o => String(o.symbol).toUpperCase() === sym));
        } else {
          item.why = skipped
            ? [`the backtest signalled it too and did not take it: ${skipped.skipped}`]
            : whyNotBacktest(sym, bt.summary, bt.ok ? null : bt.error);
        }
        row.accounts.push(item);
      }
    }

    out.trades = [...bySymbol.values()].map((r) => {
      const statuses = new Set(r.accounts.map(a => a.status));
      const worst = r.accounts.some(a => a.status === 'backtest only' || a.status === 'live only') ? 'bad'
        : r.accounts.reduce((w, a) => (a.cmp && a.cmp.worst === 'bad' ? 'bad'
          : (a.cmp && a.cmp.worst === 'warn' && w !== 'bad' ? 'warn' : w)), 'ok');
      const first = r.accounts[0] || {};
      return { ...r, status: statuses.size === 1 ? [...statuses][0] : 'mixed', worst,
               decisionBar: (first.bt || first.live || {}).decisionBar || null };
    }).sort((a, b) => (mins(a.decisionBar) || 0) - (mins(b.decisionBar) || 0));

    const withReplay = [...btByRatio.values()].find(r => r && r.replay);
    const rep = withReplay ? withReplay.replay : null;
    out.logic = rep ? {
      identical: rep.error ? null : !!rep.identical,
      error: rep.error || null,
      compared: rep.compared || 0,
      minutes: rep.minutes || 0,
      symbols: rep.symbols || 0,
      mismatches: rep.mismatches || [],
      // AFTER THE ENTRY: the live manager replayed on the same bars for every
      // trade — target legs banked, and the close, on the backtest's bar and
      // for its reason (chart/replay.py replay_exits).
      exits: rep.exits ? {
        identical: !!rep.exits.identical,
        compared: rep.exits.compared || 0,
        legsCompared: rep.exits.legs_compared || 0,
        mismatches: rep.exits.mismatches || [],
      } : null,
    } : null;
    const logicOk = !!(out.logic && out.logic.identical
      && (!out.logic.exits || out.logic.exits.identical));
    for (const t of out.trades) {
      for (const a of t.accounts) a.causes = causesOf(a, logicOk);
      t.causes = [...new Set(t.accounts.flatMap(a => a.causes.map(c => c.kind)))];
    }
    const kinds = {};
    for (const t of out.trades) for (const k of t.causes) kinds[k] = (kinds[k] || 0) + 1;
    out.verdict = {
      logicIdentical: out.logic ? out.logic.identical : null,
      exitsIdentical: out.logic && out.logic.exits ? out.logic.exits.identical : null,
      causes: kinds,
      // THE QUESTION ASKED: is every difference latency or the fill?
      onlyDataAndExecution: logicOk
        && !Object.keys(kinds).some(k => !['DATA', 'EXECUTION', 'KNOCK-ON'].includes(k)),
    };

    const sum = (pick) => {
      const vals = out.trades.flatMap(t => t.accounts.map(pick)).filter(v => v !== null && v !== undefined);
      return vals.length ? round(vals.reduce((n, v) => n + v, 0), 2) : null;
    };
    out.totals = {
      backtest: out.trades.filter(t => t.accounts.some(a => a.bt)).length,
      live: out.trades.filter(t => t.accounts.some(a => a.live)).length,
      both: out.trades.filter(t => t.status === 'both').length,
      backtestOnly: out.trades.filter(t => t.status === 'backtest only').length,
      liveOnly: out.trades.filter(t => t.status === 'live only').length,
      skippedBoth: out.trades.filter(t => t.status === 'skipped by both').length,
      // On both sides and not the same: a one-sided trade is counted above.
      mismatched: out.trades.filter(t => t.status === 'both' && t.worst !== 'ok').length,
      pnlBacktest: sum(a => (a.bt ? a.bt.pnl : null)),
      pnlLive: sum(a => (a.live ? a.live.pnl : null)),
    };
    report.setups.push(out);
  }
  report.tookMs = Date.now() - started;
  // RUN BEFORE THE CLOSE: trades still open have no exit yet, on either side,
  // and the numbers are not the day's. Said on the page, not left to be read.
  const nowAt = deps.now || Date.now();
  report.partial = date === toETDate(nowAt) && (mins(etHHMM(nowAt)) || 0) < 16 * 60;
  return report;
}

/** Alpaca's orders for one account, from 04:00 New York that day. */
async function defaultAlpacaOrders(cfg, date) {
  try {
    const reconcile = require('../broker/reconcile');
    const alpaca = require('../alpaca/account');
    const { creds, error } = reconcile.credsForDest(cfg.destinationId);
    if (error) return { ok: false, error };
    const { etOffsetForDate } = require('../utils/time');
    const off = typeof etOffsetForDate === 'function' ? etOffsetForDate(date) : '-04:00';
    const after = new Date(`${date}T04:00:00${off}`).toISOString();
    const r = await alpaca.orders({ after, account: creds });
    // `after` has no end: a day checked later must not read the days after it.
    if (r.ok) r.orders = (r.orders || []).filter(o => toETDate(Date.parse(o.submittedAt)) === date);
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── storing and scheduling ────────────────────────────────────────────────

function fileFor(date) { return path.join(OUT_DIR, `daycheck-${date}.json`); }

function read(date) {
  try { return JSON.parse(fs.readFileSync(fileFor(date), 'utf8')); } catch { return null; }
}

function save(report) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(fileFor(report.date), JSON.stringify(report));
}

/** The dates that have a report, newest first. */
function dates() {
  try {
    return fs.readdirSync(OUT_DIR)
      .map(f => /^daycheck-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)).filter(Boolean)
      .map(m => m[1]).sort().reverse();
  } catch { return []; }
}

let running = null;
/** Run and store. One at a time; a second caller gets the same promise. */
function run(date = toETDate(Date.now()), deps = {}) {
  if (running) return running;
  running = (async () => {
    let report;
    try { report = await build(date, deps); }
    catch (err) { report = { ok: false, date, ranAt: Date.now(), error: err.message, setups: [] }; }
    try { save(report); } catch (err) { report.saveError = err.message; }
    return report;
  })().finally(() => { running = null; });
  return running;
}

function etHHMM(at = Date.now()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit' }).format(new Date(at));
}
function etWeekday(at = Date.now()) {
  return !['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US',
    { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(at)));
}

/**
 * Is this minute one to run on? At 16:10 on a weekday with no report yet, and
 * again every 15 minutes until 18:00 while the day's report is a failure.
 */
function due(at = Date.now(), existing = undefined) {
  if (!etWeekday(at)) return false;
  const now = mins(etHHMM(at));
  if (now < mins(RUN_AT) || now > mins(RETRY_UNTIL)) return false;
  const have = existing === undefined ? read(toETDate(at)) : existing;
  if (!have) return true;
  if (have.ok) return false;
  return (now - mins(RUN_AT)) % RETRY_EVERY_MIN === 0;
}

function start({ intervalMs = 60000 } = {}) {
  const t = setInterval(() => {
    if (running || !due()) return;
    run().then(r => console.log(`[DayCheck] ${r.date}: ${r.ok ? 'done' : `failed — ${r.error}`}`))
      .catch(err => console.error('[DayCheck]', err.message));
  }, intervalMs);
  t.unref?.();
  return { stop() { clearInterval(t); } };
}

function isRunning() { return !!running; }

module.exports = {
  build, run, read, isRunning, save, dates, due, start, RUN_AT,
  backtestTrade, liveFromAlpaca, liveFromLedger, ledgerEntries, ledgerCloses,
  compare, whyNotLive, whyNotBacktest, btExitKind, closeKind, sameExit, causesOf,
};
