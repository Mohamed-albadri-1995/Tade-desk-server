/*
 * Can this name be SHORTED — and is it in trouble at the clearing house.
 *
 * WHY THE CARD NEEDS THIS. Backtest #354 made +$1,345.43 over twelve trades.
 * XE, a short, was +$1,408.60 of it. Live:
 *
 *     alpaca1: FAILED — asset "XE" cannot be sold short
 *
 * Without XE the run is -$63.17, so the whole result was one trade the broker
 * refuses to place. STKH and LBGJ went the same way on 2026-08-14, CAPR before
 * them. Most of what these screeners find is a small cap with no borrow, so for
 * a short book this is the common case rather than the edge one.
 *
 * The backtest can ask Alpaca at backtest time (quant-platform/tools/data/
 * borrow.py), but Alpaca keeps NO HISTORY: that is today's flag applied to a
 * past day. The register freezes a card per name per trading day, so writing
 * the flag onto the card is how a real, dated borrow history gets built — from
 * tomorrow, for exactly the universe this desk trades.
 *
 * TWO FIELDS THAT ANSWER TWO DIFFERENT QUESTIONS, and they are never merged.
 *
 *   shortable     Alpaca, per symbol. "Will my broker let me short this, now."
 *                 The operative fact: it is what refuses the order.
 *
 *   regSho        The Reg SHO threshold list, one file for the whole market,
 *                 per exchange, per day. A security lands on it after five
 *                 consecutive settlement days of significant fails-to-deliver.
 *                 It is a SYMPTOM of hard borrow, published by the exchange —
 *                 not a broker's permission, and not a substitute for one. A
 *                 name can be threshold-listed and still shortable at Alpaca,
 *                 and can be unshortable at Alpaca without ever appearing.
 *
 * So regSho is a warning that travels with the card; `shortable` is the thing
 * that stops an order. Collapsing them into one "can I short it" boolean would
 * be a number that is arithmetically fine about the wrong question.
 *
 * NOTHING HERE IS EVER A ZERO. Every value is true, false, or null, and null
 * means the question could not be asked — which is not the same as "no". The
 * live desk already makes that choice at order time (checkShortable warns and
 * sends) and the backtest makes it too; a card that recorded an unreachable
 * lookup as "not shortable" would retire a name from the short book on the
 * strength of a timeout.
 *
 * SOFT, like shortInterest beside it. Neither source may cost a scan.
 */

const https = require('https');

/*
 * PAPER BY DEFAULT, matching every other credential path on this desk: the
 * failure of guessing wrong that way is a query against a simulator, and the
 * other way it is a query against real money.
 */
const ALPACA_BASE = process.env.APCA_API_BASE_URL || 'https://paper-api.alpaca.markets';

/*
 * THE THRESHOLD LISTS. Each exchange publishes its own for each settlement
 * day; a security appears on the list of its listing market. Both are read,
 * because a register holds names from both and asking only one would report
 * every NYSE name as clean.
 *
 * The file name carries the DATE, so this is genuinely historical — unlike
 * Alpaca's flag. Asking for a date with no file (a weekend, a holiday, a day
 * not yet published) is a 404, which is recorded as "not published" rather
 * than as an empty market.
 */
const REGSHO = {
  nasdaq: (yyyymmdd) => `https://www.nasdaqtrader.com/dynamic/SymDir/regsho/nasdaqth${yyyymmdd}.txt`,
  nyse: (yyyymmdd) => `https://www.nyse.com/api/regulatory/threshold-securities/download?selectedDate=${yyyymmdd}`,
};

const TIMEOUT_MS = 8000;

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`)); });
    req.on('error', reject);
  });
}

/*
 * ONE ASK PER SYMBOL PER PROCESS. Borrow changes across days, not across the
 * seconds of one scan, and a register of 150 names must not become 150 requests
 * every time a stage re-runs. Cleared by `forget()` — and by a restart, which
 * is when a new day's answer is wanted anyway.
 */
const CACHE = new Map();

/** `{ shortable: true|false|null, easyToBorrow: bool|null, reason }`. */
async function shortable(ticker, { keyId, secret } = {}) {
  const sym = String(ticker || '').toUpperCase().trim();
  if (!sym) return { shortable: null, reason: 'no symbol' };
  if (CACHE.has(sym)) return { ...CACHE.get(sym) };

  const key = keyId || process.env.APCA_API_KEY_ID;
  const sec = secret || process.env.APCA_API_SECRET_KEY;
  if (!key || !sec) {
    // NOT CACHED. Credentials can arrive later in the life of a process, and
    // remembering "we had no keys once" would keep the answer null all day.
    return { shortable: null, reason: 'no Alpaca credentials here — borrow not checked' };
  }

  let res;
  try {
    res = await get(`${ALPACA_BASE}/v2/assets/${encodeURIComponent(sym)}`, {
      'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': sec,
    });
  } catch (err) {
    return { shortable: null, reason: `could not ask the broker: ${err.message}` };
  }

  /*
   * A 404 IS AN ANSWER, and the strongest one: a symbol the broker does not
   * list cannot be traded there at all, so it certainly cannot be shorted.
   * Every other non-200 is an unanswered question.
   */
  if (res.status === 404) {
    const out = { shortable: false, easyToBorrow: false,
                  reason: `${sym} is not an asset at this broker` };
    CACHE.set(sym, out);
    return { ...out };
  }
  if (res.status !== 200) {
    return { shortable: null, reason: `the broker answered ${res.status}` };
  }

  let a;
  try { a = JSON.parse(res.body); } catch {
    return { shortable: null, reason: 'the broker answered with something that is not JSON' };
  }
  const out = {
    shortable: a.shortable === true,
    easyToBorrow: a.easy_to_borrow === true,
    reason: a.shortable === true ? null : `${sym} cannot be sold short at this broker`,
  };
  CACHE.set(sym, out);
  return { ...out };
}

/*
 * THE THRESHOLD FILE IS A FIXED-WIDTH-ISH PIPE TABLE with a header row and a
 * trailing record count. Only the symbol column is wanted, so the parse is
 * deliberately forgiving about everything else — a vendor adding a column must
 * not empty the list.
 *
 * A FILE THAT PARSES TO NOTHING IS REPORTED, never returned as a clean market.
 * "No security is on the threshold list today" is a real and common answer, but
 * so is "the page moved and this is now an HTML error", and the two must not
 * look alike.
 */
function parseThreshold(text) {
  const out = new Set();
  let rows = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^symbol\b/i.test(line) || /^file creation time/i.test(line)) continue;
    const cell = line.split('|')[0].trim();
    // Tickers only: letters, dots and dashes. Skips the record-count footer and
    // any HTML that arrives where a table was expected.
    if (!/^[A-Z][A-Z.\-]{0,8}$/.test(cell)) continue;
    out.add(cell);
    rows += 1;
  }
  return { symbols: out, rows };
}

/** `YYYYMMDD` in ET — the settlement day these files are named for. */
function ymd(at = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
  return p.replace(/-/g, '');
}

/**
 * Every threshold-listed symbol for a settlement day, across both lists.
 *
 * Returns `{ symbols: Set, sources: {...}, ok }`. `ok` is false when NEITHER
 * list could be read — and then the caller must write null, not false, onto
 * every card. One list answering is enough to mark the names on it; the names
 * on the other are simply unknown, and that is said per source.
 */
async function thresholdList(day = ymd()) {
  const sources = {};
  const symbols = new Set();
  let any = false;

  for (const [name, url] of Object.entries(REGSHO)) {
    let res;
    try {
      res = await get(url(day), { 'User-Agent': 'Mozilla/5.0' });
    } catch (err) {
      sources[name] = { ok: false, reason: err.message };
      continue;
    }
    if (res.status === 404) {
      sources[name] = { ok: false, reason: 'not published for this day' };
      continue;
    }
    if (res.status !== 200) {
      sources[name] = { ok: false, reason: `answered ${res.status}` };
      continue;
    }
    const { symbols: got, rows } = parseThreshold(res.body);
    /*
     * A 200 THAT PARSES TO NOTHING is the case that would otherwise read as a
     * clean market. It is genuinely possible — the list can be short — but it
     * is also what an HTML error page looks like to this parser, so it is
     * recorded with the row count and treated as unanswered.
     */
    if (!rows) {
      sources[name] = { ok: false, reason: 'answered, but no symbol row could be read' };
      continue;
    }
    for (const s of got) symbols.add(s);
    sources[name] = { ok: true, rows };
    any = true;
  }
  return { ok: any, symbols, sources, day };
}

/**
 * Put both readings on every card that does not already carry them.
 *
 * `shortable` is per symbol and costs one request each; `regSho` is one file
 * for the whole market, so it is fetched once per scan however many names
 * there are — the same shape shortInterest uses for the FINRA file.
 */
async function fill(rows, { concurrency = 4, day = ymd() } = {}) {
  const cards = (rows || []).filter(r => r && r.stock && r.ticker);
  if (!cards.length) return { checked: 0, shortable: 0, regSho: 0, listed: 0 };

  const threshold = await thresholdList(day);
  let shortableFilled = 0;
  let listed = 0;

  const want = cards.filter(r => r.stock.shortable === undefined);
  for (let i = 0; i < want.length; i += concurrency) {
    const batch = want.slice(i, i + concurrency);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(async (row) => {
      const b = await shortable(row.ticker);
      row.stock.shortable = b.shortable;
      row.stock.easyToBorrow = b.easyToBorrow ?? null;
      if (b.reason) row.stock.borrowNote = b.reason;
      if (b.shortable !== null) shortableFilled += 1;
    }));
  }

  for (const row of cards) {
    /*
     * NULL WHEN NEITHER LIST ANSWERED. "This name is not on the threshold list"
     * and "nobody could read the threshold list" are opposite facts, and the
     * second must never be frozen onto a card as the first.
     */
    if (!threshold.ok) {
      row.stock.regSho = null;
      row.stock.regShoNote = Object.entries(threshold.sources)
        .map(([k, v]) => `${k}: ${v.reason}`).join('; ') || 'not read';
      continue;
    }
    row.stock.regSho = threshold.symbols.has(String(row.ticker).toUpperCase());
    row.stock.regShoDay = threshold.day;
    if (row.stock.regSho) listed += 1;
  }

  return {
    checked: cards.length,
    shortable: shortableFilled,
    regSho: threshold.ok ? cards.length : 0,
    listed,
    sources: threshold.sources,
  };
}

function forget() { CACHE.clear(); }

module.exports = { shortable, thresholdList, parseThreshold, fill, forget, ymd, REGSHO };
