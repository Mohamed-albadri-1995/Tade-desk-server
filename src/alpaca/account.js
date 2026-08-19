/*
 * Asking Alpaca what is actually there.
 *
 * WHY THIS EXISTS, and why it corrects something written down as a limit.
 *
 * docs/EXECUTION-PLAN.md says, under what SignalStack cannot do:
 *
 *     There is no position query. Nothing can be asked "what do I hold". This
 *     is the single most consequential limit in the whole list.
 *
 * True of SignalStack, and wrong as a statement about the desk. SignalStack is
 * a one-way bridge, but the ACCOUNT behind it is an Alpaca account, and Alpaca
 * answers all three of the questions the ledger can only guess at:
 *
 *     what do I hold right now          GET /v2/positions
 *     what happened to that order       GET /v2/orders
 *     what did it actually fill at      GET /v2/account/activities/FILL
 *
 * The credentials are already here — the borrow check uses them. Nothing new
 * had to be granted; the question had simply never been asked.
 *
 * WHAT IT CHANGES. Three things that were previously derived and are now known:
 *
 *   the ledger OVER-REPORTS what is open, deliberately, because it is "what we
 *   sent minus what we closed" and cannot see a stop that filled. Over-closing
 *   is safe for the flatten and wrong for everything else — a manager acting on
 *   it sends a close for a position that ended an hour ago, and pays for it.
 *
 *   an order marked `sent` is SignalStack's acceptance, not the broker's. Both
 *   live rejections so far arrived by email hours later. Alpaca knows within
 *   seconds.
 *
 *   the fill price was never compared to the price the decision used, so the
 *   cost of the minute between them was unknown rather than small.
 *
 * WHAT IT DOES NOT COVER, and this matters: TTP5k is a Trade The Pool account
 * behind TraderEvolution. None of this sees it. Every answer here is about the
 * ALPACA side only and says so, because a reconciliation that silently covered
 * one of two accounts would be worse than none.
 */

const { getAccountBaseUrl, authHeaders } = require('./client');

/**
 * One GET against the trading API.
 *
 * Never throws for the caller's benefit: every one of these runs on a timer or
 * inside a report, and an exception there stops something more important than
 * the answer. `{ ok: false, error }` is the failure, and it is distinguishable
 * from an empty account — which is the distinction that matters most, because
 * "no positions" and "could not ask" look identical and mean opposite things.
 */
async function get(path, { timeoutMs = 10000 } = {}) {
  let headers;
  try {
    headers = authHeaders();
  } catch (err) {
    return { ok: false, error: `no Alpaca credentials: ${err.message}` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${getAccountBaseUrl()}${path}`,
      { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `Alpaca ${path} ${res.status}: ${text.slice(0, 200)}` };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, error: `Alpaca ${path} returned something that is not JSON` };
    }
  } catch (err) {
    return { ok: false, error: `Alpaca ${path}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * WHAT IS ACTUALLY HELD, right now.
 *
 * The one the ledger cannot answer. A position closed by its own stop leaves no
 * trace on this side — SignalStack does not report it and the ledger only knows
 * what was sent — so `openSymbols()` has always over-reported by design.
 *
 * `qty` is signed the way Alpaca signs it: negative for a short. Kept signed,
 * because "how much and which way" is one fact and splitting it into two is how
 * a short gets closed by buying more of it.
 */
async function positions({ timeoutMs = 10000 } = {}) {
  const r = await get('/v2/positions', { timeoutMs });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data) ? r.data : [];
  return {
    ok: true,
    positions: rows.map(p => ({
      symbol: String(p.symbol || '').toUpperCase(),
      qty: Number(p.qty),
      side: Number(p.qty) < 0 ? 'short' : 'long',
      avgEntry: Number(p.avg_entry_price),
      marketValue: Number(p.market_value),
      unrealised: Number(p.unrealized_pl),
      current: Number(p.current_price),
    })),
  };
}

/**
 * Every order Alpaca has for a window, with what became of it.
 *
 * `nested` asks Alpaca to hang a bracket's stop and target legs under their
 * parent rather than returning them flat. A scale-out here is several brackets,
 * so flat is a list where nothing says which stop belongs to which lot.
 */
async function orders({ after = null, status = 'all', limit = 500,
                        nested = true, timeoutMs = 15000 } = {}) {
  const q = new URLSearchParams({ status, limit: String(limit),
                                  direction: 'asc', nested: String(!!nested) });
  if (after) q.set('after', after);
  const r = await get(`/v2/orders?${q}`, { timeoutMs });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data) ? r.data : [];
  return { ok: true, orders: rows.map(flatten) };
}

function flatten(o) {
  const filled = Number(o.filled_qty);
  return {
    id: o.id,
    clientId: o.client_order_id,
    symbol: String(o.symbol || '').toUpperCase(),
    side: o.side,
    type: o.type,
    qty: Number(o.qty),
    filledQty: Number.isFinite(filled) ? filled : 0,
    // The only price that is a fact. `limit_price` is what was asked for.
    filledAvg: o.filled_avg_price == null ? null : Number(o.filled_avg_price),
    limitPrice: o.limit_price == null ? null : Number(o.limit_price),
    stopPrice: o.stop_price == null ? null : Number(o.stop_price),
    status: o.status,
    submittedAt: o.submitted_at,
    filledAt: o.filled_at,
    canceledAt: o.canceled_at,
    orderClass: o.order_class,
    legs: Array.isArray(o.legs) ? o.legs.map(flatten) : [],
  };
}

/**
 * The fills, as the account statement records them.
 *
 * Separate from `orders` because an order is an intention with a status and a
 * fill is money that moved. For a journal it is the fills that matter: one
 * order can fill in several prints at several prices, and the average on the
 * order hides that.
 */
const FILL_PAGE = 100;          // Alpaca's maximum; 500 is a 422, not a truncation
const FILL_PAGES_MAX = 20;      // 2,000 fills in a day is already absurd

async function fills({ after = null, timeoutMs = 15000 } = {}) {
  /*
   * PAGED, at Alpaca's limit rather than at a number that looked generous.
   *
   * Asking for 500 does not return 100 — it returns
   *
   *     422 {"code":40010001,"message":"tried to set the page size to 500,
   *          but the maximum is 100"}
   *
   * so the whole day came back as an error rather than as a first page. Which
   * is the better failure of the two, and was still a failure.
   *
   * One day CAN exceed a page: a three-leg scale-out in two accounts is six
   * orders, each able to fill in several prints. So it follows `page_token`,
   * which for activities is the id of the last row received, and stops when a
   * page comes back short. Bounded, because an endpoint that never returns a
   * short page would otherwise loop forever.
   */
  const rows = [];
  let token = null;
  for (let page = 0; page < FILL_PAGES_MAX; page += 1) {
    const q = new URLSearchParams({ page_size: String(FILL_PAGE) });
    if (after) q.set('after', after);
    if (token) q.set('page_token', token);
    const r = await get(`/v2/account/activities/FILL?${q}`, { timeoutMs });
    // A failure mid-way is reported, not silently returned as a partial day —
    // half a day's fills look exactly like a quiet day.
    if (!r.ok) return r;
    const got = Array.isArray(r.data) ? r.data : [];
    rows.push(...got);
    if (got.length < FILL_PAGE) break;
    token = got[got.length - 1].id;
    if (!token) break;
  }
  return {
    ok: true,
    fills: rows.map(f => ({
      id: f.id,
      orderId: f.order_id,
      symbol: String(f.symbol || '').toUpperCase(),
      side: f.side,                        // buy | sell | sell_short
      qty: Number(f.qty),
      price: Number(f.price),
      at: f.transaction_time,
      type: f.type,                        // fill | partial_fill
    })),
  };
}

/** Buying power and equity, as the broker counts them rather than as we do. */
async function account({ timeoutMs = 10000 } = {}) {
  const r = await get('/v2/account', { timeoutMs });
  if (!r.ok) return r;
  const a = r.data || {};
  return {
    ok: true,
    account: {
      equity: Number(a.equity),
      cash: Number(a.cash),
      buyingPower: Number(a.buying_power),
      daytradeCount: Number(a.daytrade_count),
      // The two that silently stop everything, and neither is visible from
      // this side otherwise: an account can be blocked without a single order
      // being rejected until one is sent.
      tradingBlocked: !!a.trading_blocked,
      accountBlocked: !!a.account_blocked,
      patternDayTrader: !!a.pattern_day_trader,
      status: a.status,
    },
  };
}

module.exports = { positions, orders, fills, account, get };
