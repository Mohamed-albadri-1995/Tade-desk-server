/*
 * WHICH LEGS ARE ACTUALLY PROVEN, and which have simply never been tested.
 *
 * WHY THIS EXISTS. A test signal was sent from the Algo tab and came back
 * clean, and the honest reading of that was: one leg of seven is green and the
 * other six are unknown. `Test 1 share` posts one AAPL share to ONE named
 * account through its TEST hook. It proves that hook is valid and the account
 * is connected. It runs no scanner, reads no card list, asks qp nothing, sizes
 * nothing, resolves no routing — and its ledger row is written with
 * `date: null`, so `broker.reconciled(date)` filters it out and neither
 * `/api/broker/confirm` nor the journal can ever see it.
 *
 * THE ONE RULE THIS FILE IS BUILT ON:
 *
 *     UNTESTED IS NOT PASSED.
 *
 * A leg comes back `ok: true` (proven), `ok: false` (proven broken), or
 * `ok: null` — could not be told. `null` never renders green and never counts
 * toward the headline. Every failure this desk has had in the last week was a
 * silence being read as a pass: a scan that never ran, a stage that was never
 * invoked, a decision taken on a bar fifteen minutes old, a `confirmed()` that
 * nothing called. Each of those looked exactly like "fine".
 *
 * NOTHING HERE PLACES AN ORDER. It is read-only and safe to run mid-session
 * with both accounts armed — that is the whole point of a preflight.
 *
 * NO CREDENTIAL LEAVES THIS PROCESS. Hooks and keys are reported as present or
 * absent, never echoed. `broker.publicSettings()` already masks them and
 * deletes the secret; this file reads only the booleans beside them.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');

/*
 * HOW LATE A FEED MAY BE. The same two minutes the runner and the session log
 * already use — see runner.FEED_LAG_WARN_MIN. Three constants that disagreed
 * would mean a run that warns, a day that does not, and a preflight that says
 * a third thing.
 */
const LAG_BAD_MIN = 2;

/*
 * FEEDS WHOSE FREE TIER IS DELAYED. Not a blocklist — a name here is a warning
 * on a ONE-MINUTE setup, because a decision taken on a bar fifteen minutes old
 * is not the decision the backtest measured. `yahoo` is the default in both
 * `qpClient.decide` and `catalog`, so it is what a setup gets by not choosing.
 */
const DELAYED_FEEDS = new Set(['yahoo']);

/** How long a card list may go unrefreshed before it is not "today's list". */
const CARDS_STALE_MIN = 30;

const leg = (id, title, ok, note, detail = undefined) =>
  ({ id, title, ok, note, ...(detail === undefined ? {} : { detail }) });

/** Minutes since a timestamp, or null when there is none. */
function minsSince(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.round((Date.now() - n) / 60000));
}

/* ── 1. the cards ────────────────────────────────────────────────────────── */
/*
 * A setup cannot trade a name its tool has not found. On 2026-09-03 the card
 * list sat at seven names all morning and the two signals that eventually
 * appeared were for names added at 10:00 — both refused, correctly, as fired
 * on bars from before the desk knew they existed.
 */
async function legCards(setups, { fetchJson, toolsFile } = {}) {
  const owners = new Set();
  for (const s of setups) for (const t of (s.tools || [])) owners.add(t);
  if (!owners.size) {
    return leg('cards', 'Cards on the list', null,
      'no enabled setup names a tool, so there is no card list to check');
  }
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(toolsFile || path.join(ROOT, 'tools.config.json'), 'utf8'));
  } catch (err) {
    return leg('cards', 'Cards on the list', null,
      `could not read the tool registry: ${err.message}`);
  }
  const wanted = (reg.tools || []).filter(t => owners.has(t.id));
  const detail = [];
  for (const t of wanted) {
    let st = null;
    try {
      st = await fetchJson(`http://127.0.0.1:${t.port}/api/scan/status`);
    } catch (err) {
      detail.push({ tool: t.id, ok: null, note: `did not answer: ${err.message}` });
      continue;
    }
    const age = minsSince(st && st.lastRun);
    // PAUSED IS A CHOICE, NOT A FAULT — and it is still a reason nothing trades.
    if (st && st.paused) {
      detail.push({ tool: t.id, ok: false, cards: st.lastRowCount || 0,
                    note: `the tool is PAUSED${st.pausedReason ? ` — ${st.pausedReason}` : ''}` });
    } else if (st && st.error) {
      detail.push({ tool: t.id, ok: false, cards: st.lastRowCount || 0,
                    note: `the last scan failed: ${st.error}` });
    } else if (age === null) {
      detail.push({ tool: t.id, ok: null, cards: null,
                    note: 'has never completed a scan since it started' });
    } else if (!st.lastRowCount) {
      detail.push({ tool: t.id, ok: false, cards: 0, ageMin: age,
                    note: 'the last scan produced no cards at all' });
    } else if (age > CARDS_STALE_MIN) {
      detail.push({ tool: t.id, ok: false, cards: st.lastRowCount, ageMin: age,
                    note: `the card list is ${age} minutes old` });
    } else {
      detail.push({ tool: t.id, ok: true, cards: st.lastRowCount, ageMin: age,
                    note: `${st.lastRowCount} cards, ${age} min old` });
    }
  }
  return leg('cards', 'Cards on the list', verdict(detail),
    summarise(detail, 'tool'), detail);
}

/* ── 2. the feed ─────────────────────────────────────────────────────────── */
/*
 * The failure that looks exactly like a quiet market. A delayed feed does not
 * fail — qp reads whatever bars exist and answers about those, so the desk asks
 * about the 09:41 bar, is answered about 09:26, and says "nothing qualified".
 */
function legFeed(setups, summary) {
  const detail = [];
  for (const s of setups) {
    const g = summary[s.id];
    const feed = s.liveFeed || 'yahoo';
    const delayed = DELAYED_FEEDS.has(String(feed).toLowerCase());
    const lag = g && typeof g.lagMaxMin === 'number' ? g.lagMaxMin : null;
    if (lag !== null && lag >= LAG_BAD_MIN) {
      detail.push({ setup: s.id, ok: false, feed, lagMaxMin: lag, lagBars: g.lagBars,
        note: `'${feed}' ran up to ${lag} min behind on ${g.lagBars} of ${g.runs} `
          + 'runs — any signal found on those bars is refused as stale' });
    } else if (delayed) {
      // MEASURED BEATS ARGUED. If today has runs and none lagged, say so —
      // but a delayed source on a 1-minute setup is still worth naming.
      detail.push({ setup: s.id, ok: lag === null ? null : false, feed,
        lagMaxMin: lag,
        note: lag === null
          ? `set to '${feed}', whose free data is ~15 min delayed, and no run `
            + 'today has measured the lag yet'
          : `set to '${feed}', whose free data is ~15 min delayed` });
    } else if (lag === null) {
      detail.push({ setup: s.id, ok: null, feed,
        note: `on '${feed}', but no run today has measured the lag yet` });
    } else {
      detail.push({ setup: s.id, ok: true, feed, lagMaxMin: lag,
        note: `'${feed}', worst lag ${lag} min` });
    }
  }
  return leg('feed', 'The feed is current', verdict(detail),
    summarise(detail, 'setup'), detail);
}

/* ── 3. the decision ─────────────────────────────────────────────────────── */
function legDecision(setups, summary) {
  const detail = [];
  for (const s of setups) {
    const r = s.readiness || {};
    const g = summary[s.id];
    if (s.enabled === false) {
      detail.push({ setup: s.id, ok: false, note: 'switched off' });
    } else if (!s.autoTrade) {
      detail.push({ setup: s.id, ok: false,
        note: 'not on auto — it alerts and places no order' });
    } else if (r.orderOk === false) {
      detail.push({ setup: s.id, ok: false, blocking: r.orderBlocking || [],
        note: `cannot place an order: ${(r.orderBlocking || []).join('; ') || 'reason not given'}` });
    } else if (!g || !g.runs) {
      // NOT A FAILURE OF THE SETUP. Outside its window it is correct for it not
      // to have run, and this cannot tell the two apart — so it says so.
      detail.push({ setup: s.id, ok: null,
        note: 'has not been asked today — correct outside its window, a fault inside it' });
    } else if (g.failed) {
      detail.push({ setup: s.id, ok: false, runs: g.runs, failed: g.failed,
        note: `${g.failed} of ${g.runs} runs FAILED${g.problems && g.problems.length
          ? ` — ${g.problems[0]}` : ''}` });
    } else {
      detail.push({ setup: s.id, ok: true, runs: g.runs, lastBar: g.lastBar,
        note: `asked on ${g.runs} bars, last ${g.lastBar}` });
    }
  }
  return leg('decision', 'The setup can decide and order', verdict(detail),
    summarise(detail, 'setup'), detail);
}

/* ── 4. the routing ──────────────────────────────────────────────────────── */
/*
 * NAMES ONLY. `autoRoute().cfgs` holds each destination's own Alpaca key and
 * secret — the same reason the runner separates them before writing a log.
 */
function legRouting(setups, broker) {
  const detail = [];
  for (const s of setups) {
    let route;
    try {
      route = broker.autoRoute(s.id);
    } catch (err) {
      detail.push({ setup: s.id, ok: null, note: `could not resolve: ${err.message}` });
      continue;
    }
    const to = (route.cfgs || []).map(c => c.destinationName || c.destinationId);
    if (to.length) {
      detail.push({ setup: s.id, ok: true, to, note: `goes to ${to.join(', ')}` });
    } else {
      detail.push({ setup: s.id, ok: false, to: [],
        note: route.error || 'no account takes this setup' });
    }
  }
  return leg('routing', 'An account takes the order', verdict(detail),
    summarise(detail, 'setup'), detail);
}

/* ── 5. the hooks ────────────────────────────────────────────────────────── */
/*
 * THE LIVE HOOK IS THE ONE THAT MATTERS, and it is not the one the Test button
 * uses. `broker.test()` prefers `cfg.testWebhookUrl`, so a green test says
 * nothing about the hook real orders travel through. The only evidence that
 * the live hook works is an order having gone through it.
 */
function legHooks(broker) {
  const dests = (broker.publicSettings().destinations || []);
  if (!dests.length) {
    return leg('hooks', 'The broker hooks', false, 'no broker account is configured');
  }
  let liveSent = [];
  try {
    liveSent = broker.orders().filter(o => o.hook === 'live' && o.sent);
  } catch { liveSent = []; }
  const detail = dests.map((d) => {
    const mine = liveSent.filter(o => (o.destination || null) === d.id);
    if (!d.enabled) {
      return { account: d.name || d.id, ok: false, note: 'switched off' };
    }
    if (!d.hasWebhook) {
      return { account: d.name || d.id, ok: false, note: 'has no live hook URL' };
    }
    if (!mine.length) {
      return { account: d.name || d.id, ok: null, hasTestWebhook: !!d.hasTestWebhook,
        note: d.hasTestWebhook
          ? 'live hook is set but has never carried an order — the Test button '
            + 'uses the TEST hook, so it has not proven this one'
          : 'live hook is set but has never carried an order' };
    }
    const last = mine.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    return { account: d.name || d.id, ok: true, orders: mine.length,
      note: `live hook has carried ${mine.length} order(s), last `
        + `${new Date(last.at).toISOString().slice(0, 16).replace('T', ' ')}` };
  });
  return leg('hooks', 'The live hook works', verdict(detail),
    summarise(detail, 'account'), detail);
}

/* ── 6. the feedback ─────────────────────────────────────────────────────── */
/*
 * "The desk sent it" and "the broker took it" are different facts, and for a
 * fortnight nothing on this desk asked the second question — `confirmed()` was
 * written, correct, and called by nothing.
 */
async function legFeedback(day, broker, reconcile) {
  const hasUrl = !!safe(() => broker.callbackUrl('https://example'), null);
  let all = [];
  try { all = broker.orders(); } catch { all = []; }
  const callbacks = all.filter(o => o.kind === 'callback');
  const real = all.filter(o => o.kind !== 'callback' && o.kind !== 'intent' && o.date);
  const testsOnly = !real.length && all.some(o => o.source === 'manual test');

  if (!hasUrl) {
    return leg('feedback', 'The broker says what happened', false,
      'no callback URL is configured — SignalStack cannot tell this desk what '
      + 'became of an order, so the ledger records intentions and calls them '
      + 'outcomes');
  }
  if (!callbacks.length) {
    return leg('feedback', 'The broker says what happened', null,
      testsOnly
        ? 'no callback has ever arrived. `Test 1 share` CANNOT prove this leg — '
          + 'its ledger row is written dateless, so confirm and the journal '
          + 'never see it, and no callback is matched to it either'
        : 'the callback URL is set but no callback has ever arrived — paste it '
          + 'into SignalStack\'s "Call webhook" box if you have not');
  }
  let confirm = null;
  try { confirm = await reconcile.confirmed(day); } catch (err) {
    return leg('feedback', 'The broker says what happened', null,
      `callbacks have arrived before, but today could not be checked: ${err.message}`);
  }
  const rows = (confirm && confirm.rows) || [];
  const newest = callbacks.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const when = new Date(newest.at).toISOString().slice(0, 10);
  if (!rows.length) {
    return leg('feedback', 'The broker says what happened', true,
      `working — ${callbacks.length} callback(s) received, last ${when}. `
      + 'Nothing was sent today, so there is nothing to confirm.');
  }
  const unconfirmed = rows.filter(r => !r.confirmed && !r.confirmedBy);
  return leg('feedback', 'The broker says what happened',
    unconfirmed.length ? false : true,
    unconfirmed.length
      ? `${unconfirmed.length} of ${rows.length} of today's orders have no word `
        + 'back from anyone — sent, and never heard from again'
      : `all ${rows.length} of today's orders were confirmed`,
    { callbacks: callbacks.length, lastCallback: when,
      today: rows.length, unconfirmed: unconfirmed.length });
}

/* ── 7. the journal ──────────────────────────────────────────────────────── */
function legJournal(reconcile) {
  let scope;
  try { scope = reconcile.credentialScope(); } catch (err) {
    return leg('journal', 'The journal sees every account', null,
      `could not be read: ${err.message}`);
  }
  if (!scope.ids.length) {
    return leg('journal', 'The journal sees every account', null,
      'no Alpaca account is configured, so there are no fills to read');
  }
  if (scope.blind.length) {
    // The reason is already written for a person — reusing it beats writing a
    // second sentence about the same fact that can drift from the first.
    return leg('journal', 'The journal sees every account', false, scope.reason,
      { accounts: scope.ids, readable: scope.readable, blind: scope.blind });
  }
  return leg('journal', 'The journal sees every account', true,
    `reads all ${scope.ids.length}: ${scope.readable.join(', ')}`,
    { accounts: scope.ids, readable: scope.readable, blind: [] });
}

/* ── the report ──────────────────────────────────────────────────────────── */

/*
 * A GROUP IS AS GOOD AS ITS WORST MEMBER, and "could not tell" outranks a
 * pass. One account that cannot be read makes the leg not-proven even when
 * the other one is perfect — which is exactly the reading the desk needs.
 */
function verdict(detail) {
  if (!detail.length) return null;
  if (detail.some(d => d.ok === false)) return false;
  if (detail.some(d => d.ok === null)) return null;
  return true;
}

function summarise(detail, kind) {
  if (!detail.length) return `no ${kind} to check`;
  const bad = detail.filter(d => d.ok === false);
  const unknown = detail.filter(d => d.ok === null);
  if (bad.length) return bad.map(d => `${d[kind]}: ${d.note}`).join(' · ');
  if (unknown.length) return unknown.map(d => `${d[kind]}: ${d.note}`).join(' · ');
  return detail.map(d => `${d[kind]}: ${d.note}`).join(' · ');
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** A bounded GET returning parsed JSON. Never hangs the report. */
async function defaultFetchJson(url, timeoutMs = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Every leg between "the scanner finds a stock" and "the journal shows the
 * fill". Read-only; places nothing.
 *
 * ONE LEG THROWING MUST NOT TAKE THE REPORT DOWN — the same `allSettled` shape
 * `runDue` uses, and for the same reason: this is the thing you open BECAUSE
 * something is wrong, and a report that fails when the day is bad is a report
 * that is never there when it is needed.
 */
async function check({ day, deps = {} } = {}) {
  const broker = deps.broker || require('../broker/signalstack');
  const reconcile = deps.reconcile || require('../broker/reconcile');
  const catalog = deps.catalog || require('../setups/catalog');
  const sessionLog = deps.sessionLog || require('../setups/sessionLog');
  const fetchJson = deps.fetchJson || defaultFetchJson;
  const toolsFile = deps.toolsFile;
  const date = day || require('../utils/time').toETDate(Date.now());

  let setups = [];
  let setupsError = null;
  try {
    setups = (await catalog.list()).filter(s => s.enabled !== false);
  } catch (err) { setupsError = err.message; }

  const summary = safe(() => sessionLog.summaryOf(date), {}) || {};

  const named = [
    ['cards', () => legCards(setups, { fetchJson, toolsFile })],
    ['feed', () => legFeed(setups, summary)],
    ['decision', () => legDecision(setups, summary)],
    ['routing', () => legRouting(setups, broker)],
    ['hooks', () => legHooks(broker)],
    ['feedback', () => legFeedback(date, broker, reconcile)],
    ['journal', () => legJournal(reconcile)],
  ];

  const settled = await Promise.allSettled(named.map(([, fn]) => fn()));
  const legs = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const id = named[i][0];
    // A LEG THAT THREW IS UNKNOWN, NEVER FAILED. "Broken" is a claim about the
    // desk; "I could not find out" is a claim about this check, and reporting
    // the second as the first sends you looking in the wrong place.
    return leg(id, id, null,
      `this check could not run: ${(r.reason && r.reason.message) || r.reason}`);
  });

  if (setupsError) {
    legs.unshift(leg('setups', 'The setup list', null,
      `qp could not be asked which setups exist: ${setupsError} — every leg `
      + 'below that depends on the list is reporting on nothing'));
  }

  return {
    ok: true,
    date,
    at: Date.now(),
    legs,
    // COUNTED APART, ALWAYS. A headline that folded `untested` into either of
    // the other two would be the exact mistake this file exists to prevent.
    passed: legs.filter(l => l.ok === true).length,
    failed: legs.filter(l => l.ok === false).length,
    untested: legs.filter(l => l.ok === null).length,
    note: 'Read-only. This places no order and proves nothing it did not check '
      + '— a leg marked "not tested" is not a leg that passed.',
  };
}

module.exports = {
  check,
  // Exported to be tested one at a time. A leg that is only reachable through
  // the whole report is a leg whose failure mode is only ever seen alongside
  // six others.
  legCards, legFeed, legDecision, legRouting, legHooks, legFeedback, legJournal,
  verdict, LAG_BAD_MIN, DELAYED_FEEDS, CARDS_STALE_MIN,
};
