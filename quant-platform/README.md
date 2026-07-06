# qp — verified primitives library

**One rule:** no math outside `qp/primitives/`. Every function in there is
`@primitive`-decorated. Every downstream caller (compare tool, trading
tool's `market_data`, backtests, user scripts) reaches the same function
through the same registry. What you verify in the compare tool is what
runs in production.

## Layout

```
qp/
  __init__.py          exports primitive, REGISTRY, get_approval, is_approved
  registry.py          the decorator + REGISTRY + approvals reader/writer
  primitives/
    __init__.py        auto-imports every primitives module
    bars.py            Bars dataclass — the one OHLCV container
    ma.py              seed: ma.sma
    # add more here: ema.py, vwap.py, atr.py, ...
approvals/
  approvals.json       git-tracked map of approved primitives
tools/
  compare_server.py    the compare UI — chart vs TradingView vs primitive
  data/
    alpaca.py          bar loader (IEX feed, parquet-cached)
```

## Adding a primitive

1. Pick a group (`ma`, `vwap`, `volatility`, `session`, …). Groups become
   the picker's optgroups in the compare tool.
2. Open the group's file under `qp/primitives/` (create it if new). New
   files are auto-discovered — no wiring in `__init__.py`.
3. Write the function and decorate it. Example:

   ```python
   from qp.registry import primitive, Param

   @primitive(
       name='ema',
       group='ma',
       description='Exponential MA. Matches TradingView ta.ema(source, length).',
       params=(Param('length', 'int', default=9, min=1),),
       inputs=('source',),
   )
   def ema(source, length: int):
       import pandas as pd
       return pd.Series(source).ewm(span=length, adjust=False).mean().to_numpy()
   ```

4. `inputs` is either `('source',)` (any of `close/open/high/low/hl2/hlc3/ohlc4`)
   or `('bars',)` (a full OHLCV DataFrame with tz-aware index).
5. Save. Refresh the compare UI. The primitive shows up with a 🚧 badge.

## Verifying + approving

1. Start the compare tool:

   ```sh
   pip install -r requirements.txt
   export APCA_API_KEY_ID=... APCA_API_SECRET_KEY=...   # paper key is fine
   python3 tools/compare_server.py --host 127.0.0.1 --port 8765
   ```

2. Open `http://127.0.0.1:8765`. Left panel = lightweight-charts driven by
   your primitive. Right panel = TradingView widget for the same symbol/TF.
3. Pick symbol, timeframe, days, primitive, source, tweak params, hit
   **Compute**. Eyeball match against TradingView's built-in overlay of the
   same indicator (add it in the TV widget on the right).
4. When it matches bar-for-bar, click **Approve as verified**. This writes
   an entry to `approvals/approvals.json`:

   ```json
   {
     "ma.sma": {
       "approved_by":  "mo",
       "approved_at":  "2026-07-05T15:30:00+00:00",
       "git_sha":      "abcdef1",
       "notes":        "matches TV ta.sma(close,9) on SPY 5m 2026-07-02"
     }
   }
   ```

5. Commit the JSON change. An approval is a promise to future callers.

## HTTP endpoints (compare server)

```
GET  /                    the page
GET  /api/health          {"ok": true, "primitives": N}
GET  /api/primitives      registry + approval status
GET  /api/data?symbol=... bars + overlay values for the selected primitive
POST /api/approve         save an approval entry ({key, approved_by, notes})
```

## Consuming primitives

**From Python:**

```python
import qp

sma_fn = qp.REGISTRY['ma.sma'].fn
values = sma_fn(close_array, length=9)   # numpy array, NaN warmup

# Bars primitives take a validated OHLCV container
vwap = qp.REGISTRY['vwap.session'].fn(qp.Bars.from_frame(df))
```

## Trading tool integration (v11 Bridge Pattern)

Per the v11 spec §8 and the integration analysis §A, the trading tool
exposes qp to its sandboxed setup + condition scripts through a
`market_data` object. The sandbox never imports qp directly — it only sees
the methods the bridge attaches:

```python
# trading_tool/market_data.py — for reference; belongs in the trading tool
import qp

class MarketData:
    def __init__(self, bar_cache):
        self._cache = bar_cache
        # v11 §8: only approved primitives are exposed to scripts.
        for key, meta in qp.approved_primitives().items():
            method_name = meta.name          # e.g. 'sma', 'session'
            fn = meta.fn
            inputs = meta.inputs             # ('source',) or ('bars',)
            def _bind(fn=fn, inputs=inputs):
                if inputs == ('source',):
                    def call(stock, source='close', **params):
                        arr = self._cache[stock][source].values
                        return fn(arr, **params)
                    return call
                if inputs == ('bars',):
                    def call(stock, **params):
                        df = self._cache[stock]
                        return fn(qp.Bars.from_frame(df), **params)
                    return call
                raise ValueError(f'unknown inputs {inputs!r}')
            setattr(self, method_name, _bind())
```

Then a sandboxed setup script (v11 §8 `SetupIndicator` interface) writes:

```python
class SetupIndicator:
    def check_signal(self, stock, timestamp, market_data):
        sma_fast = market_data.sma(stock, length=9)
        sma_slow = market_data.sma(stock, length=21)
        if sma_fast[-1] > sma_slow[-1] and sma_fast[-2] <= sma_slow[-2]:
            return 'long'
        return None
```

**What qp guarantees the trading tool:**

- `qp.REGISTRY[key].fn` — the callable, always identical to what the
  compare tool plotted when you approved it.
- `qp.REGISTRY[key].params` — tuple of `Param` records so the trading tool
  can validate script inputs before firing.
- `qp.REGISTRY[key].inputs` — `('source',)` or `('bars',)` so the bridge
  knows what to feed the callable.
- `qp.approved_primitives()` — filtered view; v11 §8 rule that no
  unapproved indicator reaches a live script.
- `qp.Bars.from_frame(df)` — the validated OHLCV container primitives
  with `inputs=('bars',)` expect.

## Design notes

- **No side effects at import.** `qp/__init__.py` imports the primitives
  module for the decorator side effect. That's it — no I/O, no network.
- **Bars are tz-aware, monotonic, OHLCV.** `Bars.from_frame` enforces it.
- **The compare tool is the ONLY doorway to approvals.** Editing
  `approvals.json` by hand works but skips the eyeball step — please don't.
- **Alpaca IEX bars.** Free tier, deterministic, parquet-cached under
  `~/.qp-cache/`. If you need better fills for backtest, swap in a
  different loader under `tools/data/` — the compare tool's URL doesn't
  change.
