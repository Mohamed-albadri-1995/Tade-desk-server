#!/usr/bin/env node
/*
 * Which feeds can serve the setup, and can any of them do it LIVE?
 *
 *   node scripts/check-feeds.js            today
 *   node scripts/check-feeds.js 2026-08-06 a past session
 *
 * The T2 setup needs 1-minute bars for 09:30–09:59 of the CURRENT day, at
 * 10:00. That is a harder requirement than it looks, and each feed fails it
 * differently:
 *
 *   Polygon  the feed the reference numbers were built on, so its VWAP is the
 *            one the setup was designed around — but the free plan serves
 *            end-of-day aggregates, and its rate limit cannot carry a universe
 *            of forty names in one pass.
 *   Yahoo    answers immediately and covers a whole morning, but its volume
 *            does not agree with Polygon's, and extension — the thing that
 *            decides which two names are traded — is computed from volume.
 *   Alpaca   one request for every ticker at once, but the free tier is IEX,
 *            a few percent of the tape, so its VWAP is furthest off.
 *
 * This asks all three the same question and prints what each says, so the
 * choice is made on evidence rather than on what a pricing page implies.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { toETDate, toETTime } = require(path.join(ROOT, 'src', 'utils', 'time'));

/*
 * Default to the last weekday, not to today.
 *
 * Run on a Saturday, every feed correctly returns nothing, and a report that
 * says "no bars" next to "cannot serve the 10:00 decision live" reads as three
 * broken feeds. It is a closed market. The weekend is the most likely time to
 * be sitting down to check this, so the default has to survive it.
 *
 * Weekends only. Holidays are not handled — an empty result on a holiday still
 * looks like a failure, which is why the day is always printed.
 */
function lastWeekday(ts = Date.now()) {
  const d = new Date(ts);
  for (let i = 0; i < 7; i++) {
    const day = new Date(d.getTime() - i * 86400000);
    const name = day.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
    if (name !== 'Sat' && name !== 'Sun') return toETDate(day.getTime());
  }
  return toETDate(ts);
}

const TODAY = toETDate(Date.now());
const ASKED = process.argv[2] || null;
const DATE = ASKED || lastWeekday();
const DOW = new Date(`${DATE}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long' });
const IS_WEEKEND = DOW === 'Saturday' || DOW === 'Sunday';
const PROBE_TICKERS = ['AAPL', 'MSFT'];

const yahoo = require(path.join(ROOT, 'src', 'yahoo', 'client'));
const alpaca = require(path.join(ROOT, 'src', 'alpaca', 'client'));
const polygon = require(path.join(ROOT, 'src', 'polygon', 'client'));

function summarise(bars) {
  const morning = (bars || []).filter(b => b.etTime >= '09:30' && b.etTime <= '09:59');
  if (!morning.length) return { bars: 0 };
  const vol = morning.reduce((a, b) => a + (Number(b.v) || 0), 0);
  let pv = 0, v = 0;
  for (const b of morning) {
    const typical = (Number(b.h) + Number(b.l) + Number(b.c)) / 3;
    const bv = Number(b.v) || 0;
    pv += typical * bv; v += bv;
  }
  return {
    bars: morning.length,
    first: morning[0].etTime,
    last: morning[morning.length - 1].etTime,
    has0959: morning.some(b => b.etTime === '09:59'),
    volume: vol,
    // The number the whole thing turns on. Printed so two feeds can be
    // compared directly instead of through their effect on a trade list.
    vwap: v ? pv / v : null,
  };
}

(async () => {
  console.log(`date ${DATE} (${DOW}) · now ${toETTime(Date.now())} ET`);
  if (!ASKED && DATE !== TODAY) {
    console.log(`(${TODAY} is a weekend — checking the last trading day instead)`);
  }
  if (IS_WEEKEND) {
    console.log('\n!! That is a weekend. Every feed will correctly return nothing,');
    console.log('   which says nothing about whether they work. Pass a weekday.');
  }
  console.log(`\nasking each feed for ${PROBE_TICKERS.join(', ')} 09:30–09:59\n`);

  const results = {};

  for (const [name, fn, note] of [
    ['polygon', () => polygon.hasKey()
      ? polygon.fetchIntradayBars(PROBE_TICKERS, DATE)
      : Promise.reject(new Error(
        'no key — looked in settings, data/keys.json, POLYGON_API_KEY '
        + 'and quant-platform/.env')),
      'the feed the spec was built on'],
    ['yahoo', () => yahoo.fetchIntradayBars(PROBE_TICKERS, DATE), 'consolidated, fast'],
    ['alpaca', () => alpaca.fetchIntradayBars(PROBE_TICKERS, DATE),
      `feed=${(() => { try { return alpaca.getFeed(); } catch { return '?'; } })()}`],
  ]) {
    process.stdout.write(`${name.padEnd(8)} (${note})\n`);
    try {
      const got = await fn();
      results[name] = {};
      for (const t of PROBE_TICKERS) {
        const s = summarise(got[t]);
        results[name][t] = s;
        console.log(`  ${t.padEnd(5)} ${s.bars ? `${String(s.bars).padStart(3)} bars  `
          + `${s.first}–${s.last}  0959:${s.has0959 ? 'yes' : 'NO '}  `
          + `vol ${(s.volume / 1e6).toFixed(2)}M  vwap ${s.vwap?.toFixed(4)}`
          : 'no bars'}`);
      }
    } catch (err) {
      console.log(`  unavailable — ${err.message}`);
    }
    console.log();
  }

  // The comparison that matters: how far apart are two feeds on the same name?
  const feeds = Object.keys(results).filter(f => results[f][PROBE_TICKERS[0]]?.vwap);
  if (feeds.length > 1) {
    console.log('VWAP disagreement between feeds (same bars, same formula):');
    for (const t of PROBE_TICKERS) {
      const vals = feeds.map(f => [f, results[f][t]?.vwap]).filter(([, v]) => v);
      if (vals.length < 2) continue;
      const base = vals[0][1];
      console.log(`  ${t}: ` + vals.map(([f, v]) =>
        `${f} ${v.toFixed(4)}${f === vals[0][0] ? '' : ` (${((v / base - 1) * 100).toFixed(3)}%)`}`
      ).join('  ·  '));
    }
    console.log('\nExtension is computed from VWAP and decides which two names are traded,');
    console.log('so a disagreement here is a disagreement about the trade list.');
  }

  console.log();
  if (IS_WEEKEND) {
    console.log('Nothing above means anything — the market was shut. Re-run on a weekday,');
    console.log('or pass one:  node scripts/check-feeds.js ' + lastWeekday());
  } else if (DATE === TODAY) {
    console.log('This was TODAY, so it is the real test: a feed that reaches 09:59 here');
    console.log('can serve the 10:00 decision live. One that does not, cannot — whatever');
    console.log('it manages for past dates.');
  } else {
    console.log(`This was ${DATE}, a past session, so it only shows which feeds hold`);
    console.log('history. Whether one can serve the 10:00 decision LIVE is a different');
    console.log('question, and only a run during market hours answers it.');
  }
})();
