/*
 * Does every data source this TOOL depends on return usable data?
 *
 * WHY IT IS SPLIT ACROSS TWO SERVICES. qp holds the bar feeds, the RS universe
 * and the shared model files; it can check those and this cannot. This tool
 * holds the TradingView scanner, the news sources and the industry map; qp has
 * never heard of any of them. So each side checks what it owns and this one
 * asks qp for its half, which is also a check in itself — if qp does not
 * answer, half the platform's data has no health report at all and that is
 * worth saying out loud rather than showing a short list.
 *
 * CONTENT, NOT STATUS. A scanner that answers 200 with zero rows, a news
 * source that has returned nothing for three weeks, an industry map with nine
 * symbols in it — every one of those renders as a normal page. Those are the
 * failures this is for, and each check therefore looks at what came back.
 */

const express = require('express');
const config = require('../config');

const router = express.Router();

const OK = (name, detail, extra) => ({ name, ok: true, severity: 'ok', detail, ...extra });
const WARN = (name, detail, extra) => ({ name, ok: true, severity: 'degraded', detail, ...extra });
const DOWN = (name, detail, extra) => ({ name, ok: false, severity: 'down', detail, ...extra });

/*
 * The TradingView scanner — this tool's primary feed, and the one every card
 * on the page is built from.
 *
 * A row count is the check. The scanner answering with an empty list is the
 * failure mode that looks exactly like a quiet market, and the difference
 * between "nothing matched" and "the source stopped answering" is the whole
 * question on a morning when the register is empty.
 */
async function checkScanner() {
  const t0 = Date.now();
  try {
    const { testScreener } = require('../sideA/tvScanner');
    // A filter nothing can fail: if this returns nothing, the source is the
    // problem and not the rules.
    const res = await testScreener({
      name: 'datacheck',
      filters: [{ left: 'close', operation: 'greater', right: 0 }],
      limit: 50,
    });
    const ms = Date.now() - t0;
    const n = res && res.count ? res.count : (res && res.rows ? res.rows.length : 0);
    if (!n) {
      return DOWN('tradingview scanner',
        'answered, but with zero rows for a filter nothing can fail — the '
        + 'source is not returning data', { ms });
    }
    const sample = (res.rows || [])[0];
    const price = sample && sample.stock && sample.stock.price;
    if (!price || !Number.isFinite(price) || price <= 0) {
      return DOWN('tradingview scanner',
        `${n} rows, but the first has no usable price — the columns changed`,
        { ms, rows: n });
    }
    return OK('tradingview scanner', `${n} rows, first is ${sample.ticker} at $${price}`,
      { ms, rows: n });
  } catch (err) {
    return DOWN('tradingview scanner', `fetch failed: ${String(err.message).slice(0, 160)}`,
      { ms: Date.now() - t0 });
  }
}

/*
 * News. Three sources behind one call, and the card already reports when one
 * of them is not answering — this asks the same question on purpose, against
 * a symbol that always has news, so "nothing found" means the source and not
 * the stock.
 */
async function checkNews() {
  const t0 = Date.now();
  try {
    const { fetchNewsForTicker } = require('../sideC/news');
    const { news } = await fetchNewsForTicker('AAPL', 'NASDAQ:AAPL');
    const ms = Date.now() - t0;
    const items = (news && news.items) || [];
    const sources = (news && news.sources) || {};
    // HERE is where a misconfigured source belongs — once, with the fix,
    // rather than on every card. See the note in src/sideC/news.js.
    const all = Object.entries(sources)
      .filter(([, v]) => v.status && v.status !== 'ok' && v.status !== 'not-needed');
    const config = all.filter(([, v]) => v.config).map(([k, v]) => `${k} (${v.status})`);
    const broken = all.map(([k, v]) => `${k}: ${v.detail || v.status}`);
    if (!items.length) {
      return DOWN('news sources',
        `no stories at all for AAPL — ${broken.length ? broken.join('; ') : 'every source returned empty'}`,
        { ms });
    }
    if (broken.length) {
      return WARN('news sources',
        `${items.length} stories, but ${broken.join('; ')}`, {
          ms,
          items: items.length,
          fix: config.length
            ? `${config.join(', ')} — the key is missing or rejected. Update it in `
              + 'data/keys.json next to the databases, or Settings > API Keys. '
              + 'The cards no longer warn about this; it is reported here instead.'
            : null,
        });
    }
    return OK('news sources', `${items.length} stories for AAPL`,
      { ms, items: items.length });
  } catch (err) {
    return DOWN('news sources',
      `failed: ${String(err.message).slice(0, 160)}`, { ms: Date.now() - t0 });
  }
}

/*
 * The industry map. THE SIZE IS THE CHECK, not its existence: group ranking
 * against nine symbols produces ranks that look exactly like real ones, and a
 * file that exists is not a file with a market in it.
 */
function checkIndustryMap() {
  try {
    const s = require('../sideA/industryMap').stats();
    if (!s.symbols) {
      return DOWN('industry map', 'empty — group ranks cannot be built until a scan runs', s);
    }
    if (s.symbols < 200 || s.industries < 20) {
      return WARN('industry map',
        `only ${s.symbols} symbols across ${s.industries} industries — group `
        + 'ranks will be thin until more scans have run', s);
    }
    return OK('industry map', `${s.symbols} symbols across ${s.industries} industries`, s);
  } catch (err) {
    return DOWN('industry map', String(err.message).slice(0, 160));
  }
}

/* The CANSLIM list, which is the one file every tool reads and only T8 writes. */
function checkCanslim() {
  try {
    const canslim = require('../sideA/canslim');
    const state = canslim.read();
    const n = Object.keys(state.members || {}).length;
    if (!n) return WARN('canslim list', 'no members yet — T8 writes this after its scan');
    return OK('canslim list', `${n} names`, { members: n });
  } catch (err) {
    return DOWN('canslim list', String(err.message).slice(0, 160));
  }
}

/*
 * THE TRADING ACCOUNTS — the Algo desk's destinations and the journal.
 *
 * WHY THIS IS SEPARATE FROM THE FEED CHECKS, and why it was missing.
 *
 * Market data and execution use DIFFERENT credentials by construction:
 *
 *   qp market data   APCA_API_KEY_ID / APCA_API_SECRET_KEY, from the
 *                    ENVIRONMENT (~/trade-desk.env, via systemd)
 *   Algo + journal   data/broker.json per destination, falling back to the
 *                    broker profile in the database. The Node side NEVER
 *                    reads the environment for Alpaca credentials
 *
 * So changing the market-data key cannot break trading. THE REVERSE IS THE
 * RISK, and it is the one that actually happened: regenerating a key on an
 * Alpaca account kills it EVERYWHERE it was used. The market-data check goes
 * red immediately and loudly — and the stored trading key for the same account
 * is dead too, silently, until an order 401s at the worst possible moment.
 *
 * That is the gap this closes. Every destination with its own keys is asked
 * who it is, and the desk-wide pair is asked as well.
 */
async function checkBrokerAccounts() {
  const out = [];
  let alpaca;
  let dests = [];
  try {
    alpaca = require('../alpaca/account');
    dests = require('../broker/signalstack').destinations();
  } catch (err) {
    return [DOWN('broker accounts', `could not load: ${String(err.message).slice(0, 140)}`)];
  }

  const ask = async (label, acct) => {
    const t0 = Date.now();
    try {
      const r = await alpaca.account({ account: acct, timeoutMs: 12000 });
      const ms = Date.now() - t0;
      if (!r.ok) {
        const msg = String(r.error || '').slice(0, 160);
        const rejected = /401|403|forbidden|unauthorized/i.test(msg);
        return DOWN(label, rejected
          ? 'the stored key was REJECTED — regenerated on the Alpaca side? '
            + 'The market-data key and this one are separate places, so both '
            + 'need updating'
          : `could not ask: ${msg}`,
          { ms, fix: rejected ? 'update this account\'s keys in the Algo tab '
              + '(Destinations), or Settings > API Keys for the desk-wide pair' : null });
      }
      const a = r.account || {};
      // WHICH account answered, not just that one did. Two names were once
      // reported open while the API answered with two different ones — either
      // alone is alarming, together they mean the keys on this box and the
      // screen being read are not the same account.
      return OK(label, `${a.number || a.id || 'connected'}`
        + `${a.status ? ` · ${a.status}` : ''}`
        + `${a.paper === false ? ' · LIVE' : ' · paper'}`, { ms });
    } catch (err) {
      return DOWN(label, String(err.message).slice(0, 160), { ms: Date.now() - t0 });
    }
  };

  const own = dests.filter(d => d.alpacaKeyId && d.alpacaSecret);
  for (const d of own) {
    out.push(await ask(`Algo account: ${d.name || d.id}`, alpaca.credsOf(d)));
  }
  // The desk-wide pair, which every destination without its own keys uses and
  // which the journal reads its fills through.
  const sharedUsers = dests.filter(d => !(d.alpacaKeyId && d.alpacaSecret));
  if (!own.length || sharedUsers.length) {
    out.push(await ask(
      `Alpaca desk-wide (journal${sharedUsers.length
        ? `, and ${sharedUsers.length} destination${sharedUsers.length === 1 ? '' : 's'}` : ''})`,
      null));
  }
  if (!out.length) {
    out.push(WARN('broker accounts', 'no Alpaca destinations configured — nothing to check'));
  }
  return out;
}

/* qp's half. Its absence is itself a finding: half the platform's data would
 * otherwise have no health report and the list would just look shorter. */
async function checkQp(symbol) {
  const t0 = Date.now();
  const qp = process.env.QP_URL || 'http://127.0.0.1:8765';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await fetch(`${qp}/api/datacheck?symbol=${encodeURIComponent(symbol)}`,
      { signal: ctl.signal });
    return { ok: true, ...(await r.json()), ms: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      unreachable: true,
      checks: [DOWN('qp (chart platform)',
        `not answering: ${String(err.message).slice(0, 120)} — the bar feeds, `
        + 'the RS universe and the market model all have NO health report',
        { ms: Date.now() - t0 })],
    };
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/datacheck — both halves, in one answer.
router.get('/', async (req, res) => {
  const symbol = String(req.query.symbol || 'SPY').toUpperCase();
  const t0 = Date.now();
  try {
    const [scanner, news, brokers, qp] = await Promise.all([
      checkScanner(), checkNews(), checkBrokerAccounts(), checkQp(symbol),
    ]);
    const mine = [scanner, news, ...brokers, checkIndustryMap(), checkCanslim()];
    const checks = [...mine, ...((qp && qp.checks) || [])];
    const down = checks.filter(c => c.severity === 'down');
    const degraded = checks.filter(c => c.severity === 'degraded');
    res.json({
      ok: !down.length,
      tool: config.toolId,
      symbol,
      ms: Date.now() - t0,
      total: checks.length,
      passed: checks.length - down.length - degraded.length,
      degraded: degraded.length,
      down: down.length,
      qpReachable: !(qp && qp.unreachable),
      checks,
      // The names, not a count: "3 failed" does not say which thing stopped.
      summary: down.length || degraded.length
        ? [...down, ...degraded].map(c => `${c.name}: ${c.detail}`).join(' · ')
        : 'every source returned usable data',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
