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
2. Open the group's file under `qp/primitives/` (create it if new — then
   add one line to `qp/primitives/__init__.py`).
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

## Consuming primitives

**From Python:**

```python
import qp
from qp.registry import REGISTRY

sma_fn = REGISTRY['ma.sma'].fn
values = sma_fn(close_array, length=9)   # numpy array, NaN warmup
```

**From the trading tool (planned):** a Node → Python bridge exposes
`market_data.sma('SPY', '5m', 9)` and internally calls `REGISTRY['ma.sma'].fn`
on cached bars. The trading tool never re-implements the math — it always
routes through here.

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
