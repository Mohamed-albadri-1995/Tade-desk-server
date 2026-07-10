# qp × trading tool — integration contract

Audience: the session/AI building the trading tool's `market_data`
adapter (repo `Tade-desk-server`, branch `claude/implement-reo887`).
Every code block below was **executed and verified** against this
library before being written here. Implement from this document alone.

## The two golden rules

1. **Do not re-implement any math.** Every indicator call routes to
   `qp.REGISTRY[key].fn` — the exact function the user eyeball-verified
   against TradingView in the compare tool.
2. **Expose only approved primitives to sandboxed scripts.** The filter
   is `qp.approved_primitives()` (§3). Unapproved primitives exist in
   the registry but must not be reachable from user scripts.

---

## 1. Building `Bars` from your list of plain OHLCV dicts

Your format: `{'timestamp': ISO string, 'open', 'high', 'low', 'close',
'volume'}` per 1-minute bar. Exact converter:

```python
import pandas as pd
import qp

def bars_from_dicts(rows):
    """rows: list of {'timestamp': ISO str, 'open','high','low','close','volume'}
    → qp.Bars (validated, tz-aware UTC, sorted, de-duplicated)."""
    df = pd.DataFrame(rows)
    ts = pd.to_datetime(df['timestamp'], utc=True, format='ISO8601')
    df = (df.drop(columns=['timestamp'])
            .set_index(ts)
            .sort_index()
            [['open', 'high', 'low', 'close', 'volume']]
            .astype(float))
    df = df[~df.index.duplicated(keep='last')]
    return qp.Bars.from_frame(df)
```

Timestamp rules — **this matters for correctness**:

- Your ISO strings must represent an unambiguous instant: either UTC
  (`2026-07-06T13:30:00Z` / `+00:00`) or carrying an offset
  (`2026-07-06T09:30:00-04:00`). `utc=True` handles both.
- If (and only if) your feed stores **naive ET wall-clock strings**
  (`2026-07-06T09:30:00`, no offset), you must localize instead:
  ```python
  ts = (pd.to_datetime(df['timestamp'], format='ISO8601')
          .dt.tz_localize('America/New_York').dt.tz_convert('UTC'))
  ```
  Do not guess — check one real row from your cache. A wrong timezone
  silently shifts every session boundary (VWAP resets, RTH filters,
  level rollovers) by 4-5 hours.
- `Bars.from_frame` raises `ValueError` on missing columns, naive
  timestamps, or an unsorted index — treat that as a bug in the feed,
  not something to catch-and-ignore.

Performance: construction is O(n) and cheap; cache the `Bars` per
(stock, poll-cycle) and reuse it for every primitive call in that cycle
rather than rebuilding per call.

## 2. The primitive contract (params, returns, warm-up, latest value)

The **full per-primitive catalog** — every name, description, parameter
with type/default/limits, input kind, output shape, and current approval
status — is in **[`docs/CATALOG.md`](docs/CATALOG.md)**, auto-generated
from the registry so it cannot drift. Don't hardcode from it though;
introspect at runtime (§3) because approvals grow weekly.

Universal rules (hold for all 60 primitives, present and future):

**Inputs.** `meta.inputs` is either:
- `('source',)` — call `fn(array_1d, **params)`. Use `bars.close`,
  `bars.high`, `bars.low`, `bars.open`, `bars.volume` (numpy views on
  the Bars), or any derived array (e.g. `(bars.high + bars.low) / 2`).
- `('bars',)` — call `fn(bars_obj, **params)` with the `qp.Bars` itself.

**Params.** `meta.params` is a tuple of `Param(name, kind, default,
min, max, description)` with `kind ∈ {'int','float','str','bool'}`.
Every param has a working default — calling with no overrides is always
valid. Validate script-supplied params against `kind`/`min`/`max`
before calling; the primitive itself only does light coercion.

**Returns.** `meta.outputs` tells you the shape *before* calling:
- `('value',)` → returns one `np.ndarray` of floats, **same length as
  the input bars, index-aligned** (element *i* is the value at bar *i*).
- anything else (e.g. `('middle','upper','lower')`) → returns
  `dict[str, np.ndarray]`, each array bar-aligned, keys as declared.
  The one variable case: `levels.dynamic_sr` returns keys
  `sr1..sr{max_levels}` (declared outputs reflect the default of 6).

**NaN / warm-up policy.** NaN is the universal "no value at this bar":
rolling warm-up (first `length-1` bars of an SMA), session gaps
(session-VWAP outside 09:30-16:00 ET), pre-anchor bars (anchored
VWAPs), levels that don't exist yet (prev-day high during day 1 of the
window). NaN in the middle or at the end of a series is **normal, not
an error**. Never replace NaN with 0.

**"Value as of the latest bar."** `arr[-1]` is the value at the most
recent bar — but it can legitimately be NaN (e.g. session VWAP queried
premarket). Use this NaN-aware accessor:

```python
import numpy as np

def latest(arr):
    """Last non-NaN value, or None if the series never produced one."""
    a = np.asarray(arr, dtype=float)
    idx = np.where(~np.isnan(a))[0]
    return float(a[idx[-1]]) if len(idx) else None
```

Decide per use-case whether "latest non-NaN" (levels, most indicators)
or "strictly the current bar, None if NaN" (session-gated values) is
right; for the latter use
`None if np.isnan(arr[-1]) else float(arr[-1])`.

**Scalar vs array — the decision your bridge MUST make.** Every
primitive returns the **full history array**. But the two script styles
you'll receive use the result differently:

```python
# Style A — "latest value" scripts (scalar-expecting):
rsi = market_data.rsi(stock, length=14)
return rsi > 55                       # ← expects rsi to be ONE number

# Style B — cross-bar scripts (array-expecting, the v11 analysis example):
sma_fast = market_data.sma(stock, 9)
if sma_fast[-1] > sma_slow[-1] and sma_fast[-2] <= sma_slow[-2]:
```

If your bridge returns the raw array, Style A **crashes** —
`np.ndarray > 55` is an array, and `if array:` raises
`ValueError: truth value of an array ... is ambiguous`. If it returns a
scalar, Style B can't index `[-1]`/`[-2]`.

**Recommended bridge: return the latest scalar by default, expose the
array via a `.series` namespace.** This makes Style A scripts (the
common case for a live watch — "is RSI above 55 right now?") work as
written, and Style B scripts use `market_data.series.sma(stock, 9)[-1]`.
Both are shown in the reference bridge in §3. Pick a convention and
document it for whoever writes setup scripts — do not leave it implicit,
it's the #1 thing that will silently break scripts.

**Lookback requirements.** Feed enough history for the primitive to
warm up: at least `length` bars for rolling indicators; **≥ 300 bars**
for `levels.dynamic_sr`; ~5 RTH days of 1-minute bars (≈1950) for
`ma.pine_5day`; the previous period inside the window for
`prev_day_*`/`prev_week_open`/floor pivots. The v11 default
`ohlcv_lookback_bars = 5000` 1-minute bars (~2 weeks RTH) covers
everything except `prev_month_open`/`prev_year_open`/`yearly_open`,
which need correspondingly longer windows to return values.

**Sessions.** Primitives with an `rth_only` param default to `True`
(matches standard TV equities charts). `levels.pm_high/low` and
`overnight_high/low` require extended-hours bars in the feed to return
values. All primitives work on any timeframe including your 1-minute
bars; daily+ frames are auto-detected and handled.

## 3. Listing approved primitives programmatically

```python
import qp

approved = qp.approved_primitives()   # dict[key, PrimitiveMeta] — the ✅ slice only

for key, meta in approved.items():
    # meta.key      'ma.sma'                (registry key)
    # meta.name     'sma'                   (short name → market_data.sma)
    # meta.group    'ma'
    # meta.inputs   ('source',) or ('bars',)
    # meta.outputs  ('value',) or dict keys
    # meta.params   tuple of Param(name, kind, default, min, max, description)
    # meta.fn       the callable itself
    ...
```

Notes:

- Short `name`s are **guaranteed globally unique** (enforced at import
  time) precisely so you can flatten them into `market_data.<name>()`
  methods without collision.
- Approvals load from `quant-platform/approvals/approvals.json` when
  `qp` is imported. If the file changes while your process runs (user
  approves something new and pulls), call `qp.registry.refresh_approvals()`
  or restart — approvals only ever *grow*, so a stale view is safe,
  just smaller.
- Full records (who/when/sha/notes): `qp.get_approval('ma.sma')` →
  dict or `None`; `qp.is_approved('ma.sma')` → bool.

Reference bridge (adapt freely — the contract is the registry, not this
snippet). Returns **latest scalars** on the main object and the **full
arrays** under `market_data.series`, resolving the scalar-vs-array issue
from §2. Multi-output primitives (bb, floor, dynamic_sr…) return a dict
of latest scalars (or a dict of arrays under `.series`).

```python
import numpy as np

def _latest(x):
    if isinstance(x, dict):
        return {k: _latest(v) for k, v in x.items()}
    a = np.asarray(x, dtype=float)
    idx = np.where(~np.isnan(a))[0]
    return float(a[idx[-1]]) if len(idx) else None

class _Series:
    """market_data.series.<name>(...) → full np.ndarray (or dict of them)."""
    def __init__(self, get_bars):
        self._get_bars = get_bars
        for key, meta in qp.approved_primitives().items():
            setattr(self, meta.name, self._bind(meta))
    def _bind(self, meta):
        if meta.inputs == ('bars',):
            return lambda stock, **p: meta.fn(self._get_bars(stock), **p)
        return lambda stock, source='close', **p: \
            meta.fn(getattr(self._get_bars(stock), source), **p)

class MarketData:
    def __init__(self, get_bars):          # get_bars(stock) -> qp.Bars
        self._get_bars = get_bars
        self.series = _Series(get_bars)    # array access for cross-bar logic
        for key, meta in qp.approved_primitives().items():
            setattr(self, meta.name, self._bind(meta))
    def _bind(self, meta):
        if meta.inputs == ('bars',):
            return lambda stock, **p: _latest(meta.fn(self._get_bars(stock), **p))
        return lambda stock, source='close', **p: \
            _latest(meta.fn(getattr(self._get_bars(stock), source), **p))

    # plus the tool's own non-qp methods per v11 §8:
    def get_current_price(self, stock): ...   # float
    def get_ohlcv(self, stock, lookback): ... # list[dict]
```

With this, the received example scripts run unchanged:
`market_data.rsi(stock, length=14) > 55` → `float > 55` → `bool` ✓;
`market_data.ema(stock, length=9) > market_data.ema(stock, length=20)`
→ `bool` ✓; `market_data.day_open(stock)` → `float` ✓.

## 4. Import path & the `qp` name collision

The trading tool currently has a **placeholder package also named `qp`**
at the repo root. Two packages with one name cannot coexist on
`sys.path` — whichever comes first silently wins, and the placeholder's
math is unverified.

**Recommended (do this): delete the placeholder.** The verified library
is the only `qp`. When the branches merge, keep `quant-platform/qp/`,
remove the root-level `qp/`. This is the architecture's core invariant —
one source of truth.

**Import wiring** (works before and after the placeholder is removed —
the `insert(0, ...)` guarantees the verified library wins):

```python
import sys
from pathlib import Path

# from a module at the repo root; adjust parents[] to your file's depth
QP_ROOT = Path(__file__).resolve().parent / 'quant-platform'
sys.path.insert(0, str(QP_ROOT))

import qp

# Guard: fail loudly if the wrong package was picked up
assert hasattr(qp, 'approved_primitives'), (
    'Wrong qp package imported — remove the placeholder qp/ from the repo root')
```

Rules: do the `sys.path.insert` **before the first `import qp` anywhere
in the process**, and never `pip install` anything named `qp`. Do NOT
copy `quant-platform/qp` into the trading tool — a copy drifts from
what the user verified.

## 5. Dependencies

- **Python ≥ 3.9** (runs in production on 3.9 / Amazon Linux 2023;
  developed and tested on 3.11).
- **pandas ≥ 2.0** (tested on 2.x and 3.0 — the code is
  resolution-independent, no nanosecond assumptions).
- **numpy ≥ 1.24** (tested up to 2.4).
- `pyarrow` is **not** needed by the library — only by the compare
  tool's parquet cache. Your adapter needs exactly: `pandas`, `numpy`.
- No network, no filesystem writes, no threads inside primitives: every
  `fn` is a pure function of its inputs (plus one read of
  `approvals.json` at import). Safe to call from async code; for very
  hot paths note the session-based primitives iterate bars in Python,
  so budget ~1-10 ms per call on 5000 bars.

## 6. Complete runnable example (verified output below)

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'quant-platform'))
import qp

import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone


def bars_from_dicts(rows):
    df = pd.DataFrame(rows)
    ts = pd.to_datetime(df['timestamp'], utc=True, format='ISO8601')
    df = (df.drop(columns=['timestamp'])
            .set_index(ts)
            .sort_index()
            [['open', 'high', 'low', 'close', 'volume']]
            .astype(float))
    df = df[~df.index.duplicated(keep='last')]
    return qp.Bars.from_frame(df)


def latest(arr):
    a = np.asarray(arr, dtype=float)
    idx = np.where(~np.isnan(a))[0]
    return float(a[idx[-1]]) if len(idx) else None


# 100 synthetic 1-minute bars starting 09:30 ET (13:30 UTC), your dict shape
rng = np.random.default_rng(7)
t0 = datetime(2026, 7, 6, 13, 30, tzinfo=timezone.utc)
rows, price = [], 100.0
for i in range(100):
    price += rng.normal(0, 0.05)
    rows.append({
        'timestamp': (t0 + timedelta(minutes=i)).isoformat(),
        'open':   round(price, 2),
        'high':   round(price + 0.10, 2),
        'low':    round(price - 0.10, 2),
        'close':  round(price + rng.normal(0, 0.02), 2),
        'volume': int(rng.uniform(500, 5000)),
    })

bars = bars_from_dicts(rows)

sma9  = qp.REGISTRY['ma.sma'].fn(bars.close, length=9)      # source-input
atr14 = qp.REGISTRY['volatility.atr'].fn(bars, length=14)   # bars-input

print(f'bars={len(bars)}  sma9={latest(sma9):.4f}  atr14={latest(atr14):.4f}')
```

Verified output (seed 7, byte-for-byte from a real run):

```
bars=100  sma9=98.6578  atr14=0.2018
```

## 7. Stability promises

**Stable — build on these, they will not change:**

- `qp.REGISTRY` mapping and key format `group.name`; existing keys are
  never renamed or removed.
- `PrimitiveMeta` fields: `key, name, group, description, params,
  inputs, outputs, fn` (new fields may be *added*).
- `Param` fields: `name, kind, default, min, max, description`.
- `qp.approved_primitives()`, `qp.is_approved()`, `qp.get_approval()`,
  `qp.Bars.from_frame()`, `bars.open/high/low/close/volume/timestamps`,
  `len(bars)`.
- Return conventions of §2 (bar-aligned arrays, dict-of-arrays per
  `outputs`, NaN semantics).
- `approvals/approvals.json` schema:
  `{key: {approved_by, approved_at, git_sha, notes}}`.
- Global uniqueness of short names.

**May still change while verification is in progress:**

- The **internal math of 🚧 unapproved primitives** — if the user finds
  a mismatch during verification, the implementation gets fixed. This is
  exactly why the sandbox must expose approved-only: ✅ primitives only
  change if the user re-verifies and re-approves.
- New primitives will be added (registry grows; your dynamic bridge
  picks them up automatically once approved).
- New **optional** params (with defaults) may be added to existing
  primitives — calls written today keep working.
- Description texts, the compare tool's UI and its HTTP endpoints —
  the trading tool must not depend on the compare server at runtime;
  import the library directly.

---

## 8. MIGRATION — install qp into the trading tool & replace the old copy

**Status at handoff (2026-07): verification stage COMPLETE.** The user
verified the primitives against TradingView in the compare tool;
`approvals/approvals.json` is the authoritative gate. This section is
the instruction sheet for the trading-tool builder.

### 8.0 Who is who (ports & branches — read this first)

| App | Branch | Port | Stack |
|---|---|---|---|
| Screener (sides A–H) | `claude/read-j5hgnf` | **3000** | Node.js |
| Screener's ML scoring helper | `claude/read-j5hgnf` (`src/scoring/server.py`) | 3001 | Python/Flask — internal to the screener; **nothing to do with qp** |
| qp compare tool (verification UI) | `claude/read-j5hgnf` (`quant-platform/`) | 8765 | Python |
| **Trading tool** | **`claude/implement-reo887`** | **8000** | **Python / FastAPI** (`uvicorn main:app`) |

The verified library lives on the screener branch at
`quant-platform/` (`qp/` package + `approvals/approvals.json`). The
trading tool branch carries a **stale placeholder `qp/` at its repo
root** (old draft: momentum/trend/price/volume modules, no approvals
gate, math NOT TradingView-verified) — that placeholder is what this
migration removes.

### 8.1 Good news: the trading tool is already wired

`app/qp_loader.py` on the trading-tool branch already implements §4
correctly: it searches `QP_PATH` env var → `<repo root>/quant-platform`
→ `~/Tade-desk-server/quant-platform`, purges the placeholder `qp`
modules, imports the verified package, and verifies it exposes
`approved_primitives`. **The only missing piece is the `quant-platform/`
folder itself.**

### 8.2 The migration (run on branch `claude/implement-reo887`)

```sh
git fetch origin claude/read-j5hgnf
# 1. bring the verified library (qp + approvals + compare tool) across
git checkout origin/claude/read-j5hgnf -- quant-platform
# 2. delete the stale placeholder draft — verified library only
git rm -r qp
# 3. deps (pandas/numpy; pyarrow only needed by the compare tool)
pip install -r quant-platform/requirements.txt
git commit -m "replace placeholder qp with verified quant-platform library"
```

Then **harden `app/qp_loader.py`**: with the placeholder gone, the
"fall back to built-in placeholder primitives" branch must become a
**hard failure** (`raise RuntimeError('verified qp library not found')`)
— unverified math must never silently run.

Restart (`uvicorn main:app --host 0.0.0.0 --port 8000`) and check the
boot log for:

```
VERIFIED qp library loaded from .../quant-platform — NN approved primitives
```

Alternative (no vendoring): if the trading tool and the screener
checkout share a machine, set `QP_PATH=~/Tade-desk-server/quant-platform`
in `.env` — the loader already supports it. Vendoring via git (above) is
preferred: the branch pins its own library version.

### 8.3 Replace ANY other indicator math — sweep

The one rule: **no market math exists outside `qp/primitives/`.**

1. `grep -rn "def sma\|def ema\|def vwap\|def rsi\|def atr" app/` —
   any indicator function outside quant-platform gets deleted and
   replaced with a qp call through the loader.
2. References to the old placeholder's key names / module layout
   (`momentum.*`, `trend.*`, `price.*`, `volume.*`) must be remapped to
   the verified registry keys (`ma.*`, `vwap.*`, `levels.*`,
   `volatility.*`, `osc.*`, … — see `docs/CATALOG.md`).
3. Only `qp.approved_primitives()` may be exposed to setup scripts as
   `market_data.<short_name>()` (§3). Unapproved keys → error, never a
   number.

**Fixed-timeframe primitives** (`compute_tf` set — `volatility.atr_daily`
needs 1d bars, `ma.pine_5day` needs 1m bars): feed them bars OF THAT
timeframe (with warm-up history, ~3× the length), then hold the last
value onto your working timeframe. The compare server's `_one_overlay()`
is the reference implementation of this mapping.

### 8.4 Acceptance checks for the migration

1. Boot log says `VERIFIED qp library loaded … N approved primitives`
   and `N` matches `approvals/approvals.json`.
2. Same bars → `qp.REGISTRY['ma.sma'].fn(close, length=9)` in the tool
   and `sma(9)` in the compare tool → identical values.
3. The 8.3 grep sweep comes back clean; root `qp/` no longer exists.
4. Requesting an unapproved primitive raises — no silent numbers.

### 8.5 Update flow after handoff

The compare tool stays alive for future work: new primitive → verify →
approve → on the trading branch re-run
`git checkout origin/claude/read-j5hgnf -- quant-platform` + commit +
restart. If a verified primitive's math is ever edited, its approval is
stale — the user re-verifies and re-approves; the trading tool picks it
up on the next sync. Nothing else to coordinate.

---

*Questions or mismatches: report the primitive key, the exact params,
and observed-vs-expected values in the qp session. The library's
verification loop (compare tool → fix → re-approve) handles the rest.*
