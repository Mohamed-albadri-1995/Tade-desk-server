/**
 * Check Library + Condition Evaluator
 *
 * Three flavours of checks fill a trade card:
 *
 *   1. MANDATORY   — extracted from the indicator script's debug() output.
 *                    Cannot be edited; changes require updating the script.
 *                    Always aligned on a fire (that's what "fire" means).
 *
 *   2. DEFAULT     — user-managed library. Every setup auto-inherits ALL
 *                    default checks. Editing a default in the library
 *                    propagates to every setup (they aren't stored per
 *                    setup, they're computed at fire time from the library).
 *
 *   3. ADDITIONAL  — user-managed library. Per-setup, the user picks
 *                    which additional checks to attach. Stored as
 *                    (setup_id, check_id) rows.
 *
 * Condition grammar (JSON):
 *
 *   Comparisons (return true/false):
 *     { "op": "gt|ge|lt|le|eq|ne", "left": …, "right": … }
 *     { "op": "in",                "left": …, "list": [ … ] }
 *
 *   Combinators:
 *     { "op": "and|or", "operands": [ …, … ] }
 *     { "op": "not",    "operand":  … }
 *
 *   Value nodes (used as `left` / `right` / `operands`):
 *     { "field":   "ema9"           }  ← indicator context
 *     { "ctx":     "secBias"        }  ← scanner context field (from r0)
 *     { "literal": 100              }
 *     { "slope":   "ema9", "bars": 5 } ← slope of series over last N bars
 *     { "history": "vwap", "barsAgo": 5 } ← value N bars ago
 *     { "expr":    "add|sub|mul|div|min|max|abs|neg|pct_change|avg|weighted_avg", ... }
 *
 *   Expression forms (all return numbers):
 *     { "expr": "add|sub|mul|div|min|max", "operands": [a, b, ...] }
 *     { "expr": "abs|neg",                 "operand":  a }
 *     { "expr": "pct_change", "series": "vwap", "bars": 5 }
 *         → (value_now − value_5_bars_ago) / value_5_bars_ago
 *     { "expr": "avg",  "series": "close", "bars": 5 }
 *         → simple average of the series over the last N bars
 *     { "expr": "weighted_avg", "series": "close", "bars": 5, "weights": [1,2,3,4,5] }
 *         → weighted average; weights.length must equal bars, oldest first
 *
 * Available field names (indicators): close, open, high, low, volume,
 *   vwap, ema9, ema13, ema20, ema50, sma5, sma20, pmHigh, pmLow,
 *   prevClose, rvol, atr, dayHigh, dayLow.
 *
 * Available ctx names (scanner): regime, regimeLabel, longTerm, midTerm,
 *   shortTerm, secBias, secScore, secHot, sector, industry, themes,
 *   broadResolved, _score, screenerKeys, inShortlist.
 *
 * Example — "VWAP up-slope, custom equation":
 *     Custom slope = (vwap now − vwap 5 bars ago) / vwap now × 100
 *     Fires when it exceeds 0.05 % :
 *     {
 *       "op": "gt",
 *       "left": {
 *         "expr": "mul",
 *         "operands": [
 *           { "expr": "div",
 *             "operands": [
 *               { "expr": "sub", "operands": [
 *                   { "field": "vwap" },
 *                   { "history": "vwap", "barsAgo": 5 }
 *               ]},
 *               { "field": "vwap" }
 *             ]
 *           },
 *           { "literal": 100 }
 *         ]
 *       },
 *       "right": { "literal": 0.05 }
 *     }
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS check_library (
    id TEXT PRIMARY KEY,
    check_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('default', 'additional')),
    section TEXT,
    description TEXT,
    condition TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS setup_check_assignments (
    setup_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (setup_id, check_id)
  );

  CREATE INDEX IF NOT EXISTS check_library_category_idx ON check_library(category, enabled);
`);

// Version column bumps whenever the underlying condition JSON is edited so
// the grading engine can partition learning history and stop mixing
// old-logic evaluations with new-logic ones.
try { db.exec('ALTER TABLE check_library ADD COLUMN version_id INTEGER NOT NULL DEFAULT 1'); } catch { /* already exists */ }

// Direction column lets a check declare which signal side it applies to.
//   'both'  — evaluated on every fire regardless of direction (rvol, sector hot)
//   'long'  — bullish alignment; skipped on short signals (EMA9 > VWAP)
//   'short' — bearish alignment; skipped on long signals (EMA9 < VWAP)
// Skipped checks don't count against the grade — they're simply absent from
// the trade card, matching the behavior a user would expect from a filter
// that "doesn't apply here."
try { db.exec("ALTER TABLE check_library ADD COLUMN direction TEXT NOT NULL DEFAULT 'both'"); } catch { /* already exists */ }

// Paired-variation columns let a single check_library row express BOTH
// sides of a mirror pair. Resolver semantics at fire time:
//   direction='both'  AND condition_long/short set → engine picks the
//     variation matching signal.direction (paired mode).
//   direction='both'  AND neither set → `condition` applies both ways
//     (symmetric mode: rvol > 5 means the same for long and short).
//   direction='long'|'short' → `condition` used for the matching side,
//     the other side skipped entirely (one-sided mode).
// Grading learns per-concept (one library row) rather than per-variation,
// so a "9 EMA vs VWAP alignment" delta expectancy aggregates data from
// both long fires (where ema9>vwap was checked) and short fires (where
// ema9<vwap was checked). The trade card records which variation
// resolved via a `variation` field so you can still inspect the raw
// value that was measured.
try { db.exec("ALTER TABLE check_library ADD COLUMN condition_long TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE check_library ADD COLUMN condition_short TEXT"); } catch { /* already exists */ }

// ─── Seeds ───────────────────────────────────────────────────────────────────
// A small handful of common conditions so the library isn't empty on
// first run. These are TYPICAL defaults for the ma13bounce style setup;
// the user can edit / delete / recategorise them freely.

const SEED_CHECKS = [
  {
    check_key: 'ema9_above_vwap',
    label:     '9 EMA above VWAP',
    category:  'default',
    section:   'trend',
    direction: 'long',
    description: 'Short-term trend confirms with VWAP — bullish alignment for long signals.',
    condition: { op: 'gt', left: { field: 'ema9' }, right: { field: 'vwap' } },
  },
  {
    check_key: 'ema9_below_vwap',
    label:     '9 EMA below VWAP',
    category:  'default',
    section:   'trend',
    direction: 'short',
    description: 'Short-term trend confirms bearish for short signals.',
    condition: { op: 'lt', left: { field: 'ema9' }, right: { field: 'vwap' } },
  },
  {
    check_key: 'ema_stack_bullish',
    label:     'EMA stack bullish (9 > 20)',
    category:  'default',
    section:   'trend',
    direction: 'long',
    description: 'Fast EMAs stacked in the long direction.',
    condition: { op: 'gt', left: { field: 'ema9' }, right: { field: 'ema20' } },
  },
  {
    check_key: 'ema_stack_bearish',
    label:     'EMA stack bearish (9 < 20)',
    category:  'default',
    section:   'trend',
    direction: 'short',
    description: 'Fast EMAs stacked in the short direction.',
    condition: { op: 'lt', left: { field: 'ema9' }, right: { field: 'ema20' } },
  },
  {
    check_key: 'rvol_above_2',
    label:     'RVOL > 2×',
    category:  'default',
    section:   'volume',
    direction: 'both',
    description: 'Current-minute volume is at least 2× the 10-day baseline. Applies both directions.',
    condition: { op: 'gt', left: { field: 'rvol' }, right: { literal: 2 } },
  },
  {
    check_key: 'ema13_sloping_up',
    label:     '13 EMA sloping up',
    category:  'additional',
    section:   'momentum',
    direction: 'long',
    description: 'EMA13 has a positive slope over the last 5 bars.',
    condition: { op: 'gt', left: { slope: 'ema13', bars: 5 }, right: { literal: 0 } },
  },
  {
    check_key: 'ema13_sloping_down',
    label:     '13 EMA sloping down',
    category:  'additional',
    section:   'momentum',
    direction: 'short',
    description: 'EMA13 has a negative slope over the last 5 bars.',
    condition: { op: 'lt', left: { slope: 'ema13', bars: 5 }, right: { literal: 0 } },
  },
  {
    check_key: 'vwap_sloping_up',
    label:     'VWAP sloping up',
    category:  'additional',
    section:   'momentum',
    direction: 'long',
    description: 'VWAP has a positive slope over the last 5 bars.',
    condition: { op: 'gt', left: { slope: 'vwap', bars: 5 }, right: { literal: 0 } },
  },
  {
    check_key: 'vwap_sloping_down',
    label:     'VWAP sloping down',
    category:  'additional',
    section:   'momentum',
    direction: 'short',
    description: 'VWAP has a negative slope over the last 5 bars.',
    condition: { op: 'lt', left: { slope: 'vwap', bars: 5 }, right: { literal: 0 } },
  },
  {
    check_key: 'sector_bullish',
    label:     'Sector bias BULLISH',
    category:  'additional',
    section:   'context',
    direction: 'long',
    description: 'Scanner-side sector bias is BULLISH at signal time.',
    condition: { op: 'eq', left: { ctx: 'secBias' }, right: { literal: 'BULLISH' } },
  },
  {
    check_key: 'sector_bearish',
    label:     'Sector bias BEARISH',
    category:  'additional',
    section:   'context',
    direction: 'short',
    description: 'Scanner-side sector bias is BEARISH at signal time.',
    condition: { op: 'eq', left: { ctx: 'secBias' }, right: { literal: 'BEARISH' } },
  },
  {
    check_key: 'sec_hot',
    label:     'Sector hot',
    category:  'additional',
    section:   'context',
    direction: 'both',
    description: 'Scanner marks the sector as hot. Applies both directions — hot volume is meaningful for either.',
    condition: { op: 'eq', left: { ctx: 'secHot' }, right: { literal: true } },
  },
  {
    check_key: 'score_at_entry_70',
    label:     'Scanner score ≥ 70 at entry',
    category:  'additional',
    section:   'context',
    direction: 'both',
    description: 'Scanner _score at the moment of signal fire is ≥ 70. Direction-neutral quality gate.',
    condition: { op: 'ge', left: { ctx: '_score' }, right: { literal: 70 } },
  },

  // ── Batch 1 · L3 / vwapBounce opt-in additions ───────────────────────────
  // Each references a field vwapBounce publishes in signal.meta at fire time.
  // Wire these to a setup that uses the vwapBounce engine and they'll grade
  // A+/A/B/C over time based on how much each improves expectancy.

  {
    check_key: 'l3_slope_strong',
    label:     'L3 · slope score ≥ 5 (strong trend)',
    category:  'additional',
    section:   'momentum',
    direction: 'long',
    description: 'VWAP is climbing quickly enough that the L3 slope counter has moved ≥ 5 steps since the last VWAP cross. Filters out setups on flat/sideways days.',
    condition: { op: 'ge', left: { field: 'slope_score' }, right: { literal: 5 } },
  },
  {
    check_key: 'l3_slope_very_strong',
    label:     'L3 · slope score ≥ 10 (very strong trend)',
    category:  'additional',
    section:   'momentum',
    direction: 'long',
    description: 'Trend so persistent the slope counter passed 10. Selects the strongest trending sessions only.',
    condition: { op: 'ge', left: { field: 'slope_score' }, right: { literal: 10 } },
  },
  {
    check_key: 'l3_all_three_vwaps_touched',
    label:     'L3 · pullback touched all three VWAPs',
    category:  'additional',
    section:   'setup-quality',
    direction: 'long',
    description: 'Prev bar wick tagged the daily VWAP, 2-day VWAP, AND LL AVWAP simultaneously — a stacked confluence pullback, not just a random VWAP kiss.',
    condition: {
      op: 'and',
      operands: [
        { op: 'eq', left: { field: 'touchedDv' }, right: { literal: true } },
        { op: 'eq', left: { field: 'touchedV2' }, right: { literal: true } },
        { op: 'eq', left: { field: 'touchedAv' }, right: { literal: true } },
      ],
    },
  },
  {
    check_key: 'l3_deep_wick_bounce',
    label:     'L3 · lower wick ≥ 40% of range',
    category:  'additional',
    section:   'setup-quality',
    direction: 'long',
    description: 'Prev candle rejected the low aggressively (wick ≥ 40% of range). The default vwapBounce mandatory only requires 15% — this filters for the most emphatic bounces.',
    condition: { op: 'ge', left: { field: 'prevLwickPct' }, right: { literal: 40 } },
  },
  {
    check_key: 'l3_strict_bias',
    label:     'L3 · strict bias (all 4 above)',
    category:  'additional',
    section:   'trend',
    direction: 'long',
    description: 'Close is above daily VWAP AND 2-day VWAP AND LL AVWAP AND BB EMA. Full L3 strict-bias filter; needs multi-day historical cache warm.',
    condition: {
      op: 'and',
      operands: [
        { op: 'gt', left: { field: 'close' }, right: { field: 'daily_vwap' } },
        { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_2day' } },
        { op: 'gt', left: { field: 'close' }, right: { field: 'll_avwap' } },
        { op: 'gt', left: { field: 'close' }, right: { field: 'bb_ema' } },
      ],
    },
  },
  {
    check_key: 'l3_room_to_bb_upper',
    label:     'L3 · ≥ $1.00 headroom to BB upper',
    category:  'additional',
    section:   'setup-quality',
    direction: 'long',
    description: 'Distance from entry (close) to BB upper is at least $1.00. Filters fires where the trade is already extended toward the band and would run out of room before hitting target.',
    condition: {
      op: 'ge',
      left:  { expr: 'sub', operands: [{ field: 'bb_upper' }, { field: 'close' }] },
      right: { literal: 1.00 },
    },
  },
  {
    check_key: 'l3_vwap_stack_bullish',
    label:     'L3 · VWAP stack aligned bullish',
    category:  'additional',
    section:   'trend',
    direction: 'long',
    description: 'daily VWAP > 2-day VWAP AND 2-day VWAP > LL AVWAP — all three anchors stacked upward, confirming a coherent trend rather than a chop bounce.',
    condition: {
      op: 'and',
      operands: [
        { op: 'gt', left: { field: 'daily_vwap' }, right: { field: 'vwap_2day' } },
        { op: 'gt', left: { field: 'vwap_2day' }, right: { field: 'll_avwap' } },
      ],
    },
  },

  // ── Batch 2 · BBZ / smaTouchBounce opt-in additions ─────────────────────
  // Reference fields smaTouchBounce publishes in signal.meta at fire time:
  // daily_vwap, vwap_stdev, bb_mid, bb_up, bb_lo, sma9, sma13, sma20,
  // atr14, maHit ('SMA9'|'SMA13'|'SMA20'), zonePct.

  {
    check_key: 'bbz_touched_sma20',
    label:     'BBZ · touched SMA20 (deepest bounce)',
    category:  'additional',
    section:   'setup-quality',
    direction: 'both',
    description: 'The MA that got tagged was SMA20 rather than 9 or 13. Longest lookback = deepest pullback into the trend — typically higher expectancy than shallower 9/13 taps.',
    condition: { op: 'eq', left: { field: 'maHit' }, right: { literal: 'SMA20' } },
  },
  {
    check_key: 'bbz_touched_sma9_or_13',
    label:     'BBZ · touched SMA9 or SMA13 (shallow bounce)',
    category:  'additional',
    section:   'setup-quality',
    direction: 'both',
    description: 'MA touched was the shorter SMA9 or SMA13. Faster bounce, usually a lower-conviction setup — grade this against SMA20 fires to see if it earns its own multiplier.',
    condition: {
      op: 'or',
      operands: [
        { op: 'eq', left: { field: 'maHit' }, right: { literal: 'SMA9' } },
        { op: 'eq', left: { field: 'maHit' }, right: { literal: 'SMA13' } },
      ],
    },
  },
  {
    check_key: 'bbz_clean_zone',
    label:     'BBZ · zone quality < 3% (very clean)',
    category:  'additional',
    section:   'setup-quality',
    direction: 'both',
    description: 'The zone-body % over the lookback window was < 3% (vs the 7% Pine default). Setup ran with almost no time in the wrong zone — the highest-quality lead-up.',
    condition: { op: 'lt', left: { field: 'zonePct' }, right: { literal: 3 } },
  },
  {
    check_key: 'bbz_strong_body',
    label:     'BBZ · body ≥ 0.5 × ATR (large candle)',
    category:  'additional',
    section:   'candle-quality',
    direction: 'both',
    description: 'Signal-bar body was ≥ 0.5 × ATR14 (vs the 0.2 × Pine mandatory). Filters for emphatic bounce/reject candles rather than marginal ones.',
    condition: {
      op: 'ge',
      left:  { expr: 'abs', operand: { expr: 'sub', operands: [{ field: 'close' }, { field: 'open' }] } },
      right: { expr: 'mul', operands: [{ field: 'atr14' }, { literal: 0.5 }] },
    },
  },
  {
    check_key: 'bbz_far_from_vwap',
    label:     'BBZ · close ≥ 1.5σ beyond VWAP',
    category:  'additional',
    section:   'setup-quality',
    direction: 'both',
    description: 'Close is at least 1.5 stdev outside daily VWAP (vs the Pine 0.8σ mandatory). Confirms the σ-band gate fired with real conviction, not marginally.',
    condition: {
      op: 'ge',
      left:  { expr: 'abs', operand: { expr: 'sub', operands: [{ field: 'close' }, { field: 'daily_vwap' }] } },
      right: { expr: 'mul', operands: [{ field: 'vwap_stdev' }, { literal: 1.5 }] },
    },
  },
  {
    check_key: 'bbz_sma_stack_bullish',
    label:     'BBZ · SMA stack bullish (9 > 13 > 20)',
    category:  'additional',
    section:   'trend',
    direction: 'long',
    description: 'SMA9 > SMA13 > SMA20 at fire time — the moving averages are stacked in trend order, confirming a bullish structure for longs.',
    condition: {
      op: 'and',
      operands: [
        { op: 'gt', left: { field: 'sma9' },  right: { field: 'sma13' } },
        { op: 'gt', left: { field: 'sma13' }, right: { field: 'sma20' } },
      ],
    },
  },
  {
    check_key: 'bbz_sma_stack_bearish',
    label:     'BBZ · SMA stack bearish (9 < 13 < 20)',
    category:  'additional',
    section:   'trend',
    direction: 'short',
    description: 'SMA9 < SMA13 < SMA20 at fire time — MAs stacked in short direction, confirming a bearish structure.',
    condition: {
      op: 'and',
      operands: [
        { op: 'lt', left: { field: 'sma9' },  right: { field: 'sma13' } },
        { op: 'lt', left: { field: 'sma13' }, right: { field: 'sma20' } },
      ],
    },
  },

  // ── Batch 3 · Cross-setup market-context filters ────────────────────────
  // Not tied to any indicator engine. Reference scanner ctx (broad/mid/long-
  // term biases, sector, _score) and rvol so they layer on top of any setup.
  // Useful as DEFAULT tier candidates too — user can promote them via the
  // Checks tab if they should auto-apply to every setup.

  {
    check_key: 'rvol_above_5',
    label:     'RVOL > 5× (very hot)',
    category:  'additional',
    section:   'volume',
    direction: 'both',
    description: 'Current-minute relative volume is 5× or more the 10-day baseline. Filters for genuinely unusual volume, not just above-average.',
    condition: { op: 'gt', left: { field: 'rvol' }, right: { literal: 5 } },
  },
  {
    check_key: 'rvol_above_10',
    label:     'RVOL > 10× (extreme)',
    category:  'additional',
    section:   'volume',
    direction: 'both',
    description: 'RVOL is 10× baseline — the kind of print that usually implies a real news catalyst or breakout.',
    condition: { op: 'gt', left: { field: 'rvol' }, right: { literal: 10 } },
  },
  {
    check_key: 'sector_bullish_and_hot',
    label:     'Sector bullish AND hot',
    category:  'additional',
    section:   'context',
    direction: 'long',
    description: 'Scanner sector bias is BULLISH AND the sector is currently hot. Both conditions catch stocks riding a broader move, not just isolated pops.',
    condition: {
      op: 'and',
      operands: [
        { op: 'eq', left: { ctx: 'secBias' }, right: { literal: 'BULLISH' } },
        { op: 'eq', left: { ctx: 'secHot' }, right: { literal: true } },
      ],
    },
  },
  {
    check_key: 'sector_not_bearish',
    label:     'Sector NOT bearish (safety filter)',
    category:  'additional',
    section:   'context',
    direction: 'long',
    description: 'Skips longs when the sector is actively bearish. Cheap safety filter that blocks countertrend trades.',
    condition: {
      op: 'not',
      operand: { op: 'eq', left: { ctx: 'secBias' }, right: { literal: 'BEARISH' } },
    },
  },
  {
    check_key: 'short_and_mid_bullish',
    label:     'Short + mid-term both bullish',
    category:  'additional',
    section:   'trend',
    direction: 'long',
    description: 'Scanner-side shortTerm AND midTerm biases both say BULLISH. Confirms multi-timeframe alignment before pulling the trigger.',
    condition: {
      op: 'and',
      operands: [
        { op: 'eq', left: { ctx: 'shortTerm' }, right: { literal: 'BULLISH' } },
        { op: 'eq', left: { ctx: 'midTerm' },   right: { literal: 'BULLISH' } },
      ],
    },
  },
  {
    check_key: 'score_at_entry_85',
    label:     'Scanner score ≥ 85 (top tier)',
    category:  'additional',
    section:   'context',
    direction: 'both',
    description: 'Higher bar than the default score_at_entry_70. Filters for the scanner\'s top-scoring names only.',
    condition: { op: 'ge', left: { ctx: '_score' }, right: { literal: 85 } },
  },

  // ── Batch B · Short counterparts for the bullish-only market filters ────
  {
    check_key: 'sector_bearish_and_hot',
    label:     'Sector bearish AND hot',
    category:  'additional',
    section:   'context',
    direction: 'short',
    description: 'Sector bias BEARISH AND the sector is hot. Confirms a short is with the sector move, not fighting it.',
    condition: {
      op: 'and',
      operands: [
        { op: 'eq', left: { ctx: 'secBias' }, right: { literal: 'BEARISH' } },
        { op: 'eq', left: { ctx: 'secHot' }, right: { literal: true } },
      ],
    },
  },
  {
    check_key: 'sector_not_bullish',
    label:     'Sector NOT bullish (safety filter)',
    category:  'additional',
    section:   'context',
    direction: 'short',
    description: 'Skips shorts when the sector is actively bullish. Cheap safety filter that blocks countertrend shorts.',
    condition: {
      op: 'not',
      operand: { op: 'eq', left: { ctx: 'secBias' }, right: { literal: 'BULLISH' } },
    },
  },
  {
    check_key: 'short_and_mid_bearish',
    label:     'Short + mid-term both bearish',
    category:  'additional',
    section:   'trend',
    direction: 'short',
    description: 'shortTerm AND midTerm biases both BEARISH. Multi-timeframe alignment for shorts.',
    condition: {
      op: 'and',
      operands: [
        { op: 'eq', left: { ctx: 'shortTerm' }, right: { literal: 'BEARISH' } },
        { op: 'eq', left: { ctx: 'midTerm' },   right: { literal: 'BEARISH' } },
      ],
    },
  },

  // ── Batch 4 · Multi-day / multi-week / premarket levels ─────────────────
  // These reference fields materialised by dailyLevels.computeLevels() at
  // fire time, so every setup can use them regardless of which indicator
  // engine fired. Formulas mirror the L3 / VWAP Cluster / H-L Pine scripts.

  {
    check_key: 'above_5day_ma',
    label:     '5-Day MA · price above',
    category:  'additional',
    section:   'trend',
    direction: 'both',
    description: 'Close is above the 1950-bar SMA (5 trading days on 1m). Mirrors the VWAP Cluster "Above 5D MA" extra nuance.',
    condition:       { op: 'gt', left: { field: 'close' }, right: { field: 'ma5day' } },
    condition_long:  { op: 'gt', left: { field: 'close' }, right: { field: 'ma5day' } },
    condition_short: { op: 'lt', left: { field: 'close' }, right: { field: 'ma5day' } },
  },
  {
    check_key: '5day_ma_rising',
    label:     '5-Day MA · rising',
    category:  'additional',
    section:   'trend',
    direction: 'both',
    description: 'Positive/negative slope over the last 60 bars — mirrors the Cluster "5D MA Rising / Falling" extra.',
    condition:       { op: 'gt', left: { field: 'ma5day_slope' }, right: { literal: 0 } },
    condition_long:  { op: 'gt', left: { field: 'ma5day_slope' }, right: { literal: 0 } },
    condition_short: { op: 'lt', left: { field: 'ma5day_slope' }, right: { literal: 0 } },
  },
  {
    check_key: 'above_2day_vwap',
    label:     '2-Day VWAP · price above',
    category:  'additional',
    section:   'trend',
    direction: 'both',
    description: 'Close vs 2-day anchored VWAP. Long variant: above. Short variant: below.',
    condition:       { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_2day' } },
    condition_long:  { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_2day' } },
    condition_short: { op: 'lt', left: { field: 'close' }, right: { field: 'vwap_2day' } },
  },
  {
    check_key: 'above_week_vwap',
    label:     'Weekly VWAP · price above',
    category:  'additional',
    section:   'trend',
    direction: 'both',
    description: 'Close vs current-week VWAP. Paired: long checks above, short checks below.',
    condition:       { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_week' } },
    condition_long:  { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_week' } },
    condition_short: { op: 'lt', left: { field: 'close' }, right: { field: 'vwap_week' } },
  },
  {
    check_key: 'above_month_vwap',
    label:     'Monthly VWAP · price above',
    category:  'additional',
    section:   'trend',
    direction: 'both',
    description: 'Close vs current-month VWAP. Longest-horizon anchor available; paired long/short.',
    condition:       { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_month' } },
    condition_long:  { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_month' } },
    condition_short: { op: 'lt', left: { field: 'close' }, right: { field: 'vwap_month' } },
  },
  {
    check_key: 'above_prev_day_high',
    label:     'Prior day high · broken',
    category:  'additional',
    section:   'levels',
    direction: 'long',
    description: 'Close above yesterday\'s regular-session high. Continuation/breakout confirmation for longs.',
    condition: { op: 'gt', left: { field: 'close' }, right: { field: 'prev_day_high' } },
  },
  {
    check_key: 'below_prev_day_low',
    label:     'Prior day low · broken',
    category:  'additional',
    section:   'levels',
    direction: 'short',
    description: 'Close below yesterday\'s regular-session low. Breakdown confirmation for shorts.',
    condition: { op: 'lt', left: { field: 'close' }, right: { field: 'prev_day_low' } },
  },
  {
    check_key: 'above_premarket_high',
    label:     'Premarket high · broken',
    category:  'additional',
    section:   'levels',
    direction: 'long',
    description: 'Close above today\'s premarket (04:00–09:29 ET) high. Fresh breakout confirmation.',
    condition: { op: 'gt', left: { field: 'close' }, right: { field: 'premarket_high' } },
  },
  {
    check_key: 'below_premarket_low',
    label:     'Premarket low · broken',
    category:  'additional',
    section:   'levels',
    direction: 'short',
    description: 'Close below today\'s premarket low. Breakdown confirmation for shorts.',
    condition: { op: 'lt', left: { field: 'close' }, right: { field: 'premarket_low' } },
  },
  {
    check_key: 'above_week_high',
    label:     'Weekly high · broken',
    category:  'additional',
    section:   'levels',
    direction: 'long',
    description: 'Close above the current week\'s prior high — swing-level breakout.',
    condition: { op: 'gt', left: { field: 'close' }, right: { field: 'week_high' } },
  },
  {
    check_key: 'below_week_low',
    label:     'Weekly low · broken',
    category:  'additional',
    section:   'levels',
    direction: 'short',
    description: 'Close below the current week\'s prior low — swing-level breakdown.',
    condition: { op: 'lt', left: { field: 'close' }, right: { field: 'week_low' } },
  },
  {
    check_key: 'above_month_high',
    label:     'Monthly high · broken',
    category:  'additional',
    section:   'levels',
    direction: 'long',
    description: 'Close above the current month\'s prior high — highest-horizon breakout signal.',
    condition: { op: 'gt', left: { field: 'close' }, right: { field: 'month_high' } },
  },
  {
    check_key: 'below_month_low',
    label:     'Monthly low · broken',
    category:  'additional',
    section:   'levels',
    direction: 'short',
    description: 'Close below the current month\'s prior low — highest-horizon breakdown.',
    condition: { op: 'lt', left: { field: 'close' }, right: { field: 'month_low' } },
  },

  // ── Batch 5 · Compound "high-confluence" filters ────────────────────────
  // Layered ANDs of Batch 4 levels + Batch 3 market context, matched to
  // the kinds of setups you actually run. Each of these is a much stricter
  // gate than any single check — expected to hit less often but with
  // meaningfully higher expectancy when it does. Grading learns from the
  // outcomes just like the singletons.

  {
    check_key: 'long_hi_confluence_5d_and_sector',
    label:     'Confluence · 5D MA rising + above 5D MA + sector bullish',
    category:  'additional',
    section:   'confluence',
    direction: 'long',
    description: 'Triple-filter for longs: 5-day MA slope positive, close above 5D MA, and scanner sector bias BULLISH.',
    condition: {
      op: 'and',
      operands: [
        { op: 'gt', left: { field: 'ma5day_slope' }, right: { literal: 0 } },
        { op: 'gt', left: { field: 'close' },        right: { field: 'ma5day' } },
        { op: 'eq', left: { ctx: 'secBias' },        right: { literal: 'BULLISH' } },
      ],
    },
  },
  {
    check_key: 'short_hi_confluence_5d_and_sector',
    label:     'Confluence · 5D MA falling + below 5D MA + sector bearish',
    category:  'additional',
    section:   'confluence',
    direction: 'short',
    description: 'Mirror of the long confluence for shorts: 5-day MA sloping down, close below 5D MA, sector bias BEARISH.',
    condition: {
      op: 'and',
      operands: [
        { op: 'lt', left: { field: 'ma5day_slope' }, right: { literal: 0 } },
        { op: 'lt', left: { field: 'close' },        right: { field: 'ma5day' } },
        { op: 'eq', left: { ctx: 'secBias' },        right: { literal: 'BEARISH' } },
      ],
    },
  },
  {
    check_key: 'long_breakout_stack',
    label:     'Confluence · above premarket + prior-day highs',
    category:  'additional',
    section:   'confluence',
    direction: 'long',
    description: 'Close cleared BOTH today\'s premarket high AND yesterday\'s regular-session high. Classic continuation breakout.',
    condition: {
      op: 'and',
      operands: [
        { op: 'gt', left: { field: 'close' }, right: { field: 'premarket_high' } },
        { op: 'gt', left: { field: 'close' }, right: { field: 'prev_day_high' } },
      ],
    },
  },
  {
    check_key: 'short_breakdown_stack',
    label:     'Confluence · below premarket + prior-day lows',
    category:  'additional',
    section:   'confluence',
    direction: 'short',
    description: 'Close broke BOTH today\'s premarket low AND yesterday\'s regular-session low.',
    condition: {
      op: 'and',
      operands: [
        { op: 'lt', left: { field: 'close' }, right: { field: 'premarket_low' } },
        { op: 'lt', left: { field: 'close' }, right: { field: 'prev_day_low' } },
      ],
    },
  },
  {
    check_key: 'long_multi_vwap_stack',
    label:     'Confluence · above 1D + 2D + week VWAPs',
    category:  'additional',
    section:   'confluence',
    direction: 'long',
    description: 'All three timeframe VWAPs aligned bullish — daily, 2-day and weekly anchors below price.',
    condition: {
      op: 'and',
      operands: [
        { op: 'gt', left: { field: 'close' }, right: { field: 'daily_vwap' } },
        { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_2day' } },
        { op: 'gt', left: { field: 'close' }, right: { field: 'vwap_week' } },
      ],
    },
  },
  {
    check_key: 'short_multi_vwap_stack',
    label:     'Confluence · below 1D + 2D + week VWAPs',
    category:  'additional',
    section:   'confluence',
    direction: 'short',
    description: 'All three timeframe VWAPs aligned bearish.',
    condition: {
      op: 'and',
      operands: [
        { op: 'lt', left: { field: 'close' }, right: { field: 'daily_vwap' } },
        { op: 'lt', left: { field: 'close' }, right: { field: 'vwap_2day' } },
        { op: 'lt', left: { field: 'close' }, right: { field: 'vwap_week' } },
      ],
    },
  },
];

function seedDefaults() {
  // Idempotent per check_key so subsequent batches of Pine-imported
  // conditions can be added without wiping user edits or forcing a
  // manual re-seed. Existing keys INSERT nothing; new ones INSERT.
  const now = Date.now();
  const existing = new Set(db.prepare('SELECT check_key FROM check_library').all().map(r => r.check_key));
  const stmt = db.prepare(`
    INSERT INTO check_library
      (id, check_key, label, category, section, description, condition, condition_long, condition_short, enabled, created_at, updated_at, version_id, direction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)
  `);
  const txn = db.transaction(() => {
    for (const c of SEED_CHECKS) {
      if (existing.has(c.check_key)) continue;
      stmt.run(
        uuidv4(), c.check_key, c.label, c.category, c.section, c.description,
        JSON.stringify(c.condition),
        c.condition_long  ? JSON.stringify(c.condition_long)  : null,
        c.condition_short ? JSON.stringify(c.condition_short) : null,
        now, now, c.direction || 'both',
      );
    }
  });
  txn();

  // One-time backfill: existing rows that were seeded BEFORE the direction
  // column existed all default to 'both'. That's technically safe but wrong
  // for anything with an intrinsic direction ('ema9 > vwap' isn't 'both' —
  // it's a bullish alignment check). Push each seed's declared direction
  // into the DB for rows that STILL have the default. User edits (an
  // explicit UI change to 'both' or a custom direction) are preserved as
  // long as they're not the raw default AND their condition matches the
  // seed value — a simple heuristic: only touch rows whose current
  // direction is the default 'both' AND the seed says otherwise. Once
  // moved off 'both', the row is considered user-touched.
  const dirUpdate = db.prepare("UPDATE check_library SET direction = ? WHERE check_key = ? AND direction = 'both'");
  const backfill = db.transaction(() => {
    for (const c of SEED_CHECKS) {
      const dir = c.direction || 'both';
      if (dir === 'both') continue;
      dirUpdate.run(dir, c.check_key);
    }
  });
  backfill();

  // One-time repair: earlier Batch 3 seeds shipped with `children` instead
  // of `operands` for and/or combinators. The evaluator only reads
  // `operands`, so those DB rows were saved but silently non-functional AND
  // couldn't be re-saved from the editor (validator rejected them). Rewrite
  // any surviving row so the JSON matches the grammar. Safe to run every
  // boot — a no-op once the payload is clean.
  // Arithmetic nodes belong in the `expr` slot (a value kind), not `op`
  // (which is reserved for the comparison / combinator layer). Earlier
  // seeds got this wrong so we detect the shape and rewrite it.
  const EXPR_OPS_REPAIR = new Set(['add','sub','mul','div','min','max','abs','neg','pct_change','avg','weighted_avg']);
  const repairNode = (node) => {
    if (!node || typeof node !== 'object') return node;
    // `children` → `operands` for and/or
    if (Array.isArray(node.children) && !node.operands) {
      node.operands = node.children;
      delete node.children;
    }
    // Arithmetic op leaked into the `op` slot → move to `expr`.
    if (typeof node.op === 'string' && EXPR_OPS_REPAIR.has(node.op) && !node.expr) {
      node.expr = node.op;
      delete node.op;
    }
    // `not` with operands array → single `operand`.
    if (node.op === 'not' && Array.isArray(node.operands) && !node.operand) {
      node.operand = node.operands[0];
      delete node.operands;
    }
    // Unary arithmetic (`abs`/`neg`) stored with `operands` array →
    // singular `operand`, per the grammar.
    if ((node.expr === 'abs' || node.expr === 'neg') && Array.isArray(node.operands) && !node.operand) {
      node.operand = node.operands[0];
      delete node.operands;
    }
    if (Array.isArray(node.operands)) node.operands = node.operands.map(repairNode);
    if (node.operand) node.operand = repairNode(node.operand);
    if (node.left)    node.left    = repairNode(node.left);
    if (node.right)   node.right   = repairNode(node.right);
    return node;
  };
  const fixStmt = db.prepare('UPDATE check_library SET condition = ?, condition_long = ?, condition_short = ? WHERE id = ?');
  const repair = db.transaction(() => {
    // Broad LIKE-net catches anything worth revisiting; the per-row payload
    // is only rewritten if repairNode actually changed something. Explicit
    // OR list beats a slow LIKE '%op%' scan and keeps the migration cheap.
    const netLikes = [
      "condition LIKE '%\"children\"%'",
      "condition_long LIKE '%\"children\"%'",
      "condition_short LIKE '%\"children\"%'",
      "condition LIKE '%\"op\":\"abs\"%'",
      "condition LIKE '%\"op\":\"sub\"%'",
      "condition LIKE '%\"op\":\"mul\"%'",
      "condition LIKE '%\"op\":\"add\"%'",
      "condition LIKE '%\"op\":\"div\"%'",
      "condition LIKE '%\"op\":\"neg\"%'",
      "condition LIKE '%\"op\":\"min\"%'",
      "condition LIKE '%\"op\":\"max\"%'",
      "(condition LIKE '%\"not\"%' AND condition LIKE '%\"operands\"%')",
    ];
    const rows = db.prepare(`SELECT id, condition, condition_long, condition_short FROM check_library WHERE ${netLikes.join(' OR ')}`).all();
    for (const r of rows) {
      const patch = (raw) => {
        if (!raw) return raw;
        try { return JSON.stringify(repairNode(JSON.parse(raw))); } catch { return raw; }
      };
      fixStmt.run(patch(r.condition), patch(r.condition_long), patch(r.condition_short), r.id);
    }
    if (rows.length) console.log(`[Checks] repaired ${rows.length} rows (children→operands / not shape)`);
  });
  repair();
}
seedDefaults();

// ─── Library CRUD ────────────────────────────────────────────────────────────

function _row(r) {
  if (!r) return null;
  return {
    id:              r.id,
    key:             r.check_key,
    label:           r.label,
    category:        r.category,
    section:         r.section,
    description:     r.description,
    condition:       safeParse(r.condition, {}),
    condition_long:  r.condition_long  ? safeParse(r.condition_long,  null) : null,
    condition_short: r.condition_short ? safeParse(r.condition_short, null) : null,
    enabled:         r.enabled === 1,
    direction:       r.direction || 'both',
    versionId:       r.version_id || 1,
    createdAt:       r.created_at,
    updatedAt:       r.updated_at,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function listChecks(opts = {}) {
  const params = [];
  let where = '1=1';
  if (opts.category)   { where += ' AND category = ?'; params.push(opts.category); }
  if (opts.enabledOnly){ where += ' AND enabled = 1'; }
  return db.prepare(`SELECT * FROM check_library WHERE ${where} ORDER BY section, label`).all(...params).map(_row);
}

function getCheck(id) {
  return _row(db.prepare('SELECT * FROM check_library WHERE id = ?').get(id));
}

function createCheck({ check_key, label, category, section = null, description = null, condition, condition_long = null, condition_short = null, enabled = true, direction = 'both' }) {
  if (!check_key) throw new Error('check_key required');
  if (!label)     throw new Error('label required');
  if (!['default', 'additional'].includes(category)) throw new Error("category must be 'default' or 'additional'");
  if (!['both', 'long', 'short'].includes(direction)) throw new Error("direction must be 'both', 'long', or 'short'");
  if (!condition || typeof condition !== 'object') throw new Error('condition (JSON object) required');
  const validation = validateCondition(condition);
  if (!validation.ok) throw new Error(`condition invalid: ${validation.error}`);
  if (condition_long)  { const v = validateCondition(condition_long);  if (!v.ok) throw new Error(`condition_long invalid: ${v.error}`); }
  if (condition_short) { const v = validateCondition(condition_short); if (!v.ok) throw new Error(`condition_short invalid: ${v.error}`); }
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`
    INSERT INTO check_library
      (id, check_key, label, category, section, description, condition, condition_long, condition_short, enabled, created_at, updated_at, direction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, check_key, label, category, section, description,
    JSON.stringify(condition),
    condition_long  ? JSON.stringify(condition_long)  : null,
    condition_short ? JSON.stringify(condition_short) : null,
    enabled ? 1 : 0, now, now, direction,
  );
  return getCheck(id);
}

function updateCheck(id, patch) {
  const cur = db.prepare('SELECT * FROM check_library WHERE id = ?').get(id);
  if (!cur) return null;
  const nextConditionLong  = patch.condition_long  !== undefined ? (patch.condition_long  ? JSON.stringify(patch.condition_long)  : null) : cur.condition_long;
  const nextConditionShort = patch.condition_short !== undefined ? (patch.condition_short ? JSON.stringify(patch.condition_short) : null) : cur.condition_short;
  const next = {
    check_key:       patch.check_key   ?? cur.check_key,
    label:           patch.label       ?? cur.label,
    category:        patch.category    ?? cur.category,
    section:         patch.section     !== undefined ? patch.section : cur.section,
    description:     patch.description !== undefined ? patch.description : cur.description,
    condition:       patch.condition   != null ? JSON.stringify(patch.condition) : cur.condition,
    condition_long:  nextConditionLong,
    condition_short: nextConditionShort,
    enabled:         patch.enabled     != null ? (patch.enabled ? 1 : 0) : cur.enabled,
    direction:       patch.direction   ?? cur.direction ?? 'both',
  };
  if (!['default', 'additional'].includes(next.category)) throw new Error("category must be 'default' or 'additional'");
  if (!['both', 'long', 'short'].includes(next.direction)) throw new Error("direction must be 'both', 'long', or 'short'");
  if (patch.condition != null) {
    const v = validateCondition(patch.condition);
    if (!v.ok) throw new Error(`condition invalid: ${v.error}`);
  }
  if (patch.condition_long)  { const v = validateCondition(patch.condition_long);  if (!v.ok) throw new Error(`condition_long invalid: ${v.error}`); }
  if (patch.condition_short) { const v = validateCondition(patch.condition_short); if (!v.ok) throw new Error(`condition_short invalid: ${v.error}`); }
  // Only condition JSON changes affect what's MEASURED. Any of the three
  // condition slots changing bumps the version.
  const conditionChanged = next.condition !== cur.condition
    || next.condition_long !== cur.condition_long
    || next.condition_short !== cur.condition_short;
  const nextVersion = conditionChanged ? (cur.version_id || 1) + 1 : (cur.version_id || 1);
  db.prepare(`
    UPDATE check_library
       SET check_key=?, label=?, category=?, section=?, description=?, condition=?, condition_long=?, condition_short=?, enabled=?, updated_at=?, version_id=?, direction=?
     WHERE id=?
  `).run(
    next.check_key, next.label, next.category, next.section, next.description,
    next.condition, next.condition_long, next.condition_short,
    next.enabled, Date.now(), nextVersion, next.direction, id,
  );
  return getCheck(id);
}

function removeCheck(id) {
  // Cascade: also drop any per-setup assignments of this check.
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM setup_check_assignments WHERE check_id = ?').run(id);
    db.prepare('DELETE FROM check_library WHERE id = ?').run(id);
  });
  txn();
}

// ─── Setup ↔ additional-check assignments ────────────────────────────────────

function assignmentsForSetup(setupId) {
  return db.prepare(`
    SELECT cl.*
      FROM setup_check_assignments a
      JOIN check_library cl ON cl.id = a.check_id
     WHERE a.setup_id = ?
     ORDER BY cl.section, cl.label
  `).all(setupId).map(_row);
}

function setAssignmentsForSetup(setupId, checkIds) {
  const now = Date.now();
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM setup_check_assignments WHERE setup_id = ?').run(setupId);
    const ins = db.prepare('INSERT INTO setup_check_assignments (setup_id, check_id, created_at) VALUES (?, ?, ?)');
    for (const cid of checkIds) ins.run(setupId, cid, now);
  });
  txn();
  return assignmentsForSetup(setupId);
}

// ─── Condition validation + evaluation ───────────────────────────────────────

const COMPARISON_OPS = new Set(['gt', 'ge', 'lt', 'le', 'eq', 'ne', 'in']);
const COMBINATOR_OPS = new Set(['and', 'or', 'not']);
const VALUE_KINDS    = new Set(['field', 'ctx', 'literal', 'slope', 'history', 'expr']);
const EXPR_OPS       = new Set(['add', 'sub', 'mul', 'div', 'min', 'max', 'abs', 'neg', 'pct_change', 'avg', 'weighted_avg']);

function validateCondition(node, path = '$') {
  if (!node || typeof node !== 'object') return { ok: false, error: `${path}: expected object` };
  if (node.op) {
    if (COMBINATOR_OPS.has(node.op)) {
      if (node.op === 'not') {
        if (!node.operand) return { ok: false, error: `${path}.not.operand missing` };
        return validateCondition(node.operand, `${path}.operand`);
      }
      if (!Array.isArray(node.operands) || node.operands.length < 1) {
        return { ok: false, error: `${path}.${node.op}.operands must be a non-empty array` };
      }
      for (let i = 0; i < node.operands.length; i++) {
        const v = validateCondition(node.operands[i], `${path}.operands[${i}]`);
        if (!v.ok) return v;
      }
      return { ok: true };
    }
    if (COMPARISON_OPS.has(node.op)) {
      if (!node.left) return { ok: false, error: `${path}.left required` };
      const l = validateValue(node.left, `${path}.left`);
      if (!l.ok) return l;
      if (node.op === 'in') {
        if (!Array.isArray(node.list)) return { ok: false, error: `${path}.list must be an array for 'in'` };
      } else {
        if (!node.right) return { ok: false, error: `${path}.right required` };
        const r = validateValue(node.right, `${path}.right`);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    return { ok: false, error: `${path}.op '${node.op}' not recognised` };
  }
  // Legacy shorthand: a bare value node counts as truthy-check
  return validateValue(node, path);
}

function validateValue(node, path) {
  if (!node || typeof node !== 'object') return { ok: false, error: `${path}: expected object` };
  const kinds = Object.keys(node).filter(k => VALUE_KINDS.has(k));
  if (kinds.length === 0) return { ok: false, error: `${path}: must have one of ${[...VALUE_KINDS].join('/')}` };
  if (node.slope && node.bars == null)       return { ok: false, error: `${path}.slope requires 'bars' (int ≥ 2)` };
  if ('history' in node && node.barsAgo == null) return { ok: false, error: `${path}.history requires 'barsAgo' (int ≥ 0)` };
  if ('expr' in node) {
    if (!EXPR_OPS.has(node.expr)) return { ok: false, error: `${path}.expr must be one of: ${[...EXPR_OPS].join(', ')}` };
    if (['abs', 'neg'].includes(node.expr)) {
      if (!node.operand) return { ok: false, error: `${path}.${node.expr} requires 'operand'` };
      return validateValue(node.operand, `${path}.operand`);
    }
    if (['pct_change', 'avg', 'weighted_avg'].includes(node.expr)) {
      if (!node.series || typeof node.series !== 'string') return { ok: false, error: `${path}.${node.expr} requires string 'series'` };
      if (!Number.isFinite(Number(node.bars)) || node.bars < 1) return { ok: false, error: `${path}.${node.expr} requires 'bars' ≥ 1` };
      if (node.expr === 'weighted_avg') {
        if (!Array.isArray(node.weights) || node.weights.length !== Number(node.bars)) {
          return { ok: false, error: `${path}.weighted_avg 'weights' must be an array of length 'bars'` };
        }
      }
      return { ok: true };
    }
    // Binary/nary ops
    if (!Array.isArray(node.operands) || node.operands.length < 1) {
      return { ok: false, error: `${path}.${node.expr}.operands must be a non-empty array` };
    }
    for (let i = 0; i < node.operands.length; i++) {
      const v = validateValue(node.operands[i], `${path}.operands[${i}]`);
      if (!v.ok) return v;
    }
  }
  return { ok: true };
}

// ── Runtime helpers ──

/**
 * Build an indicator snapshot for the CURRENT (latest) bar in the buffer.
 * Called by the router at fire time.
 */
function buildIndicatorContext(bars, extras = {}) {
  const last = bars?.[bars.length - 1] || {};
  const ind = {
    close:  last.c,
    open:   last.o,
    high:   last.h,
    low:    last.l,
    volume: last.v,
  };
  // Optional inputs the caller can enrich with values already computed by
  // the indicator engine (so we don't recompute EMAs here).
  if (extras && typeof extras === 'object') {
    Object.assign(ind, extras);
  }
  return { bars, ind };
}

function fieldValue(ctx, name) {
  return ctx.ind?.[name] ?? null;
}

function ctxValue(ctx, name) {
  return ctx.scanner?.[name] ?? null;
}

function slopeValue(ctx, seriesName, barCount) {
  // Slope = (last value - value N-1 bars ago) / (bar count - 1).
  // For an EMA-style series we don't keep history per bar, so we
  // approximate slope by resampling: use a rolling window of the last
  // barCount bar closes IF the series name is a raw price field, and use
  // a stored history array if the indicator engine provided one.
  const series = ctx.history?.[seriesName];
  if (Array.isArray(series) && series.length >= barCount) {
    const a = series[series.length - barCount];
    const b = series[series.length - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return (b - a) / (barCount - 1);
  }
  // Fallback for raw bar fields (close, open, high, low, volume, vwap)
  const bars = ctx.bars || [];
  if (bars.length < barCount) return null;
  const at = i => {
    const bar = bars[bars.length - barCount + i];
    if (!bar) return null;
    if (seriesName === 'close')  return bar.c;
    if (seriesName === 'open')   return bar.o;
    if (seriesName === 'high')   return bar.h;
    if (seriesName === 'low')    return bar.l;
    if (seriesName === 'volume') return bar.v;
    return null;
  };
  const first = at(0);
  const lastV = at(barCount - 1);
  if (first == null || lastV == null) return null;
  return (lastV - first) / (barCount - 1);
}

/**
 * Returns the value of `seriesName` at `barsAgo` bars back (0 = current bar).
 *
 * Prefers a per-series history array supplied by the indicator engine
 * (ctx.history[seriesName]) because indicator values like EMA/VWAP aren't
 * on the raw bars. Falls back to raw OHLCV fields for bar-level series.
 */
function historyValue(ctx, seriesName, barsAgo) {
  const idx = Math.max(0, Math.floor(barsAgo));
  const series = ctx.history?.[seriesName];
  if (Array.isArray(series) && series.length > idx) {
    return series[series.length - 1 - idx];
  }
  const bars = ctx.bars || [];
  if (!bars.length || idx >= bars.length) return null;
  const bar = bars[bars.length - 1 - idx];
  if (!bar) return null;
  switch (seriesName) {
    case 'close':  return bar.c;
    case 'open':   return bar.o;
    case 'high':   return bar.h;
    case 'low':    return bar.l;
    case 'volume': return bar.v;
    default:       return null;
  }
}

function evalExpr(op, node, ctx) {
  const val = n => Number(resolveValue(n, ctx));
  switch (op) {
    case 'add': {
      const nums = (node.operands || []).map(val);
      if (nums.some(n => !Number.isFinite(n))) return null;
      return nums.reduce((a, b) => a + b, 0);
    }
    case 'sub': {
      const nums = (node.operands || []).map(val);
      if (nums.length === 0 || nums.some(n => !Number.isFinite(n))) return null;
      return nums.slice(1).reduce((a, b) => a - b, nums[0]);
    }
    case 'mul': {
      const nums = (node.operands || []).map(val);
      if (nums.some(n => !Number.isFinite(n))) return null;
      return nums.reduce((a, b) => a * b, 1);
    }
    case 'div': {
      const nums = (node.operands || []).map(val);
      if (nums.length === 0 || nums.some(n => !Number.isFinite(n))) return null;
      let acc = nums[0];
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] === 0) return null;
        acc /= nums[i];
      }
      return acc;
    }
    case 'min': {
      const nums = (node.operands || []).map(val).filter(Number.isFinite);
      return nums.length ? Math.min(...nums) : null;
    }
    case 'max': {
      const nums = (node.operands || []).map(val).filter(Number.isFinite);
      return nums.length ? Math.max(...nums) : null;
    }
    case 'abs': {
      const v = val(node.operand);
      return Number.isFinite(v) ? Math.abs(v) : null;
    }
    case 'neg': {
      const v = val(node.operand);
      return Number.isFinite(v) ? -v : null;
    }
    case 'pct_change': {
      const bars = Math.max(1, Number(node.bars) | 0);
      const now  = historyValue(ctx, node.series, 0);
      const then = historyValue(ctx, node.series, bars);
      if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return null;
      return (now - then) / then;
    }
    case 'avg': {
      const bars = Math.max(1, Number(node.bars) | 0);
      let sum = 0;
      for (let i = 0; i < bars; i++) {
        const v = historyValue(ctx, node.series, i);
        if (!Number.isFinite(v)) return null;
        sum += v;
      }
      return sum / bars;
    }
    case 'weighted_avg': {
      const bars = Math.max(1, Number(node.bars) | 0);
      const weights = node.weights;
      if (!Array.isArray(weights) || weights.length !== bars) return null;
      let sum = 0, wsum = 0;
      for (let i = 0; i < bars; i++) {
        // weights are oldest-first, so weights[0] pairs with the oldest bar.
        const v = historyValue(ctx, node.series, bars - 1 - i);
        if (!Number.isFinite(v)) return null;
        sum  += v * Number(weights[i]);
        wsum += Number(weights[i]);
      }
      return wsum > 0 ? sum / wsum : null;
    }
  }
  return null;
}

function resolveValue(node, ctx) {
  if (!node || typeof node !== 'object') return null;
  if ('field'   in node) return fieldValue(ctx, node.field);
  if ('ctx'     in node) return ctxValue(ctx, node.ctx);
  if ('literal' in node) return node.literal;
  if ('slope'   in node) return slopeValue(ctx, node.slope, Math.max(2, node.bars | 0));
  if ('history' in node) return historyValue(ctx, node.history, node.barsAgo | 0);
  if ('expr'    in node) return evalExpr(node.expr, node, ctx);
  return null;
}

function formatVal(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return Math.abs(v) < 1000 ? v.toFixed(2) : String(Math.round(v));
  if (Array.isArray(v)) return v.join('|');
  return String(v);
}

function compareOnce(op, l, r) {
  if (l == null || r == null) return null;
  const nl = typeof l === 'number' ? l : Number(l);
  const nr = typeof r === 'number' ? r : Number(r);
  const bothNumeric = Number.isFinite(nl) && Number.isFinite(nr);
  switch (op) {
    case 'gt': return bothNumeric ? nl >  nr : null;
    case 'ge': return bothNumeric ? nl >= nr : null;
    case 'lt': return bothNumeric ? nl <  nr : null;
    case 'le': return bothNumeric ? nl <= nr : null;
    case 'eq': return bothNumeric ? nl === nr : String(l) === String(r);
    case 'ne': return bothNumeric ? nl !== nr : String(l) !== String(r);
    default:   return null;
  }
}

function evaluateCondition(node, ctx) {
  if (!node || typeof node !== 'object') return { aligned: null, value: null };
  if (COMBINATOR_OPS.has(node.op)) {
    if (node.op === 'not') {
      const inner = evaluateCondition(node.operand, ctx);
      return { aligned: inner.aligned == null ? null : !inner.aligned, value: inner.value };
    }
    const results = node.operands.map(o => evaluateCondition(o, ctx));
    const align = node.op === 'and'
      ? results.every(r => r.aligned === true)
      : results.some(r => r.aligned === true);
    const anyNull = results.some(r => r.aligned == null);
    return {
      aligned: anyNull && !align ? null : align,
      value: results.map(r => r.value).filter(Boolean).join(' · '),
    };
  }
  if (COMPARISON_OPS.has(node.op)) {
    const left = resolveValue(node.left, ctx);
    if (node.op === 'in') {
      const list = node.list || [];
      const aligned = list.map(String).includes(String(left));
      return { aligned, value: `${formatVal(left)} ∈ {${list.map(formatVal).join(', ')}}` };
    }
    const right = resolveValue(node.right, ctx);
    const aligned = compareOnce(node.op, left, right);
    return { aligned, value: `${formatVal(left)} ${node.op} ${formatVal(right)}` };
  }
  return { aligned: null, value: null };
}

// ─── Fire-time collection ────────────────────────────────────────────────────

/**
 * Evaluate every check that applies to this fire and return the arrays
 * the Router will hand to the Grading engine.
 *
 *   mandatoryChecks   ← from the indicator's debug() output
 *   defaultChecks     ← every enabled library entry with category='default'
 *   additionalChecks  ← library entries assigned to this setup
 *
 * All three arrays share the same shape:
 *   { key, label, section?, value, aligned }
 */
function collectChecksForFire({ indicatorEngine, bars, pmHigh, setupId, indicatorExtras = {}, scannerContext = {}, historySeries = {}, engineCtx = {}, direction = null }) {
  const ctx = buildIndicatorContext(bars, indicatorExtras);
  ctx.scanner = scannerContext;
  ctx.history = historySeries;

  // Direction filter: a check with direction='long' shouldn't evaluate on a
  // short signal (and vice versa). 'both' always applies. Missing direction
  // == 'both' for back-compat with rows written before the column existed.
  const dirMatches = (checkDir) => {
    const d = checkDir || 'both';
    if (d === 'both') return true;
    if (!direction) return true;   // called without a direction; play it safe and include all
    return d === String(direction).toLowerCase();
  };

  // Mandatory — reuse the engine's debug() so the fired conditions are
  // recorded on the card without re-implementing them.
  const mandatoryChecks = [];
  if (indicatorEngine && typeof indicatorEngine.debug === 'function') {
    let dbg = null;
    try { dbg = indicatorEngine.debug(bars, pmHigh, engineCtx); } catch { /* ignore */ }
    if (dbg && Array.isArray(dbg.conditions)) {
      for (const c of dbg.conditions) {
        mandatoryChecks.push({
          key:      c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
          label:    c.name,
          section:  'mandatory',
          value:    c.note ?? null,
          aligned:  c.pass == null ? null : Boolean(c.pass),
        });
      }
    }
  }

  // Resolver: pick which condition slot to evaluate.
  //   direction='both' + variation set for the signal's side → paired mode
  //   direction='both' + no variations                        → symmetric
  //   direction='long'|'short'                                → one-sided
  // The chosen slot is what actually gets tested. `variation` records which
  // slot was used so grading can still show the raw value and the trade
  // card can distinguish "ema9>vwap fired" from "ema9<vwap fired" even
  // though they belong to the same library concept.
  const side = direction ? String(direction).toLowerCase() : null;
  const chooseCondition = (row) => {
    const rowDir = row.direction || 'both';
    if (rowDir === 'both' && side === 'long' && row.condition_long) {
      return { cond: row.condition_long, variation: 'long' };
    }
    if (rowDir === 'both' && side === 'short' && row.condition_short) {
      return { cond: row.condition_short, variation: 'short' };
    }
    if (rowDir === 'long')  return { cond: row.condition, variation: 'long' };
    if (rowDir === 'short') return { cond: row.condition, variation: 'short' };
    return { cond: row.condition, variation: 'symmetric' };
  };

  const evaluate = (row) => {
    const { cond, variation } = chooseCondition(row);
    const r = evaluateCondition(cond, ctx);
    return {
      libraryId: row.id,
      key:       row.key,
      label:     row.label,
      section:   row.section || null,
      value:     r.value,
      aligned:   r.aligned,
      versionId: row.versionId || 1,
      variation,
    };
  };

  const defaultChecks    = listChecks({ category: 'default', enabledOnly: true })
    .filter(r => dirMatches(r.direction))
    .map(evaluate);
  const additionalChecks = setupId
    ? assignmentsForSetup(setupId).filter(r => r.enabled && dirMatches(r.direction)).map(evaluate)
    : [];

  return { mandatoryChecks, defaultChecks, additionalChecks };
}

/**
 * Preview a condition against a caller-supplied context.
 *
 * `ctx` shape:
 *   {
 *     ind:      { close, ema9, vwap, ... },
 *     scanner:  { secBias, sector, ... },
 *     bars:     [ { c, o, h, l, v }, ... ],
 *     history:  { ema13: [...], vwap: [...] }
 *   }
 *
 * All fields optional. Returns { aligned, value, resolved } where
 * `resolved` is a small trace of the left/right sides for debugging.
 */
function testCondition(condition, ctx = {}) {
  const validation = validateCondition(condition);
  if (!validation.ok) return { ok: false, error: validation.error };
  const filledCtx = {
    bars:    ctx.bars    || [],
    ind:     ctx.ind     || {},
    scanner: ctx.scanner || {},
    history: ctx.history || {},
  };
  const result = evaluateCondition(condition, filledCtx);
  return { ok: true, aligned: result.aligned, value: result.value };
}

module.exports = {
  // Library
  listChecks,
  getCheck,
  createCheck,
  updateCheck,
  removeCheck,
  // Assignments
  assignmentsForSetup,
  setAssignmentsForSetup,
  // Evaluator
  validateCondition,
  evaluateCondition,
  buildIndicatorContext,
  collectChecksForFire,
  testCondition,
};
