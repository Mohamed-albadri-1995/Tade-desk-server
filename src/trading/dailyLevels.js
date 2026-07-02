/**
 * Multi-day / multi-week / premarket derived levels
 *
 * The indicator engines (vwapBounce, smaTouchBounce) each publish their own
 * per-bar computations — daily VWAP, BB bands, SMAs — but the check
 * library needs access to a broader set of levels that don't belong to
 * any single engine: 5-day MA, 2-day / weekly / monthly VWAPs, week and
 * month H/L, prior-day H/L, premarket H/L.
 *
 * This module takes the already-merged bar buffer (historicalCache
 * warmup + today's live bars from barPoller) and materialises those
 * levels once per fire, so every setup can reference them via check
 * conditions without each engine having to duplicate the math.
 *
 * Formulas mirror the Pine scripts:
 *   • ma5day     — SMA of the last 1950 1-min closes (5 × 390 bars)
 *   • vwap_2day  — cumulative VWAP over the last 2 calendar trading days
 *   • vwap_week  — cumulative VWAP over the current ISO week
 *   • vwap_month — cumulative VWAP over the current calendar month
 *   • week_high/low, month_high/low, prev_day_high/low — H/L extremes
 *     computed per window
 *   • premarket_high/low — H/L for bars whose ET clock time is 04:00–09:29
 *   • ma5day_slope — slope of ma5day between current and 60 bars ago
 *     (positive = rising, per the L3 "5D MA rising" filter concept)
 *
 * Missing history returns nulls — the check evaluator already treats
 * null inputs as "indeterminate" so a level that isn't warm yet just
 * shows up as "—" on the trade card instead of skewing grading.
 */

const { toETDate, toETHour } = require('../utils/time');

// Fast ET-hour + minute extraction. Avoiding Date.prototype.toLocaleTimeString
// per bar because it's the hot path.
function _etHourMinute(ts) {
  // Simple: pull from toETTime by using a Date shifted for ET; fallback for
  // preview environments where TZ isn't ideal.
  const dt = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(dt);
  const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  return { h, m };
}

function _isoWeek(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-${Math.ceil((((d - yearStart) / 86400000) + 1) / 7)}`;
}

function _monthKey(dateISO) {
  return dateISO.slice(0, 7);
}

/**
 * Compute derived levels from a bar buffer.
 * `bars` — chronological array of { t (ISO), o, h, l, c, v }
 * Returns an object suitable to be merged into indicatorExtras.
 */
function computeLevels(bars) {
  const out = {
    ma5day:            null,
    ma5day_slope:      null,
    vwap_2day:         null,
    vwap_week:         null,
    vwap_month:        null,
    week_high:         null,
    week_low:          null,
    month_high:        null,
    month_low:         null,
    prev_day_high:     null,
    prev_day_low:      null,
    premarket_high:    null,
    premarket_low:     null,
  };
  if (!Array.isArray(bars) || bars.length === 0) return out;
  const last = bars[bars.length - 1];
  const lastTs = new Date(last.t).getTime();
  const todayET = toETDate(lastTs);
  const weekKey = _isoWeek(lastTs);
  const monthKey = _monthKey(todayET);

  // 5-day MA — 1950 bars of 1-min closes. Skip pre-market bars in the
  // window so the number matches TradingView's regular-session-only
  // request.security() result on a 1m chart.
  const closes = [];
  for (let i = bars.length - 1; i >= 0 && closes.length < 1950; i--) {
    const b = bars[i];
    if (!Number.isFinite(b?.c)) continue;
    closes.push(b.c);
  }
  if (closes.length === 1950) {
    out.ma5day = closes.reduce((a, b) => a + b, 0) / 1950;
  }

  // 5-day MA slope — recompute the same SMA 60 bars back and diff.
  if (bars.length >= 1950 + 60) {
    const older = [];
    const endIdx = bars.length - 60;
    for (let i = endIdx - 1; i >= 0 && older.length < 1950; i--) {
      const b = bars[i];
      if (!Number.isFinite(b?.c)) continue;
      older.push(b.c);
    }
    if (older.length === 1950) {
      const oldMa = older.reduce((a, b) => a + b, 0) / 1950;
      if (Number.isFinite(out.ma5day)) out.ma5day_slope = out.ma5day - oldMa;
    }
  }

  // Anchored VWAPs — 2-day, week, month. We walk from end to start,
  // accumulating price × volume until the anchor changes.
  let sumPv2 = 0, sumV2 = 0, days2 = 0, lastSeenDate = null;
  let sumPvW = 0, sumVW = 0;
  let sumPvM = 0, sumVM = 0;
  let weekHi = -Infinity, weekLo = Infinity;
  let monthHi = -Infinity, monthLo = Infinity;
  let prevDayHi = -Infinity, prevDayLo = Infinity;
  let prevDayKey = null;
  let pmHi = -Infinity, pmLo = Infinity;

  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (!b || !Number.isFinite(b.c) || !Number.isFinite(b.v)) continue;
    const ts = new Date(b.t).getTime();
    const dateET = toETDate(ts);
    const hlc3 = (b.h + b.l + b.c) / 3;

    // 2-day accumulator: reset counter when date changes; stop after 2 days
    if (dateET !== lastSeenDate) {
      lastSeenDate = dateET;
      days2 += 1;
    }
    if (days2 <= 2) {
      sumPv2 += hlc3 * b.v;
      sumV2  += b.v;
    }

    // Week / month accumulators — only include bars matching the current
    // week/month key.
    if (_isoWeek(ts) === weekKey) {
      sumPvW += hlc3 * b.v;
      sumVW  += b.v;
      if (b.h > weekHi) weekHi = b.h;
      if (b.l < weekLo) weekLo = b.l;
    }
    if (_monthKey(dateET) === monthKey) {
      sumPvM += hlc3 * b.v;
      sumVM  += b.v;
      if (b.h > monthHi) monthHi = b.h;
      if (b.l < monthLo) monthLo = b.l;
    }

    // Prior-day H/L: take the first non-today date encountered while walking
    // backward and stay in it until it changes.
    if (dateET !== todayET) {
      if (prevDayKey === null) prevDayKey = dateET;
      if (dateET === prevDayKey) {
        if (b.h > prevDayHi) prevDayHi = b.h;
        if (b.l < prevDayLo) prevDayLo = b.l;
      }
    }

    // Premarket H/L for TODAY: ET 04:00–09:29.
    if (dateET === todayET) {
      const { h, m } = _etHourMinute(ts);
      const isPremarket = (h < 9) || (h === 9 && m < 30);
      if (isPremarket) {
        if (b.h > pmHi) pmHi = b.h;
        if (b.l < pmLo) pmLo = b.l;
      }
    }
  }

  if (sumV2 > 0) out.vwap_2day  = sumPv2 / sumV2;
  if (sumVW > 0) out.vwap_week  = sumPvW / sumVW;
  if (sumVM > 0) out.vwap_month = sumPvM / sumVM;
  if (weekHi   !== -Infinity) out.week_high      = weekHi;
  if (weekLo   !==  Infinity) out.week_low       = weekLo;
  if (monthHi  !== -Infinity) out.month_high     = monthHi;
  if (monthLo  !==  Infinity) out.month_low      = monthLo;
  if (prevDayHi !== -Infinity) out.prev_day_high = prevDayHi;
  if (prevDayLo !==  Infinity) out.prev_day_low  = prevDayLo;
  if (pmHi     !== -Infinity) out.premarket_high = pmHi;
  if (pmLo     !==  Infinity) out.premarket_low  = pmLo;

  return out;
}

module.exports = { computeLevels };
