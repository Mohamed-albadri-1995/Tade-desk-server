# qp — verified primitives library + compare tool

**The one rule:** no market math exists anywhere except `qp/primitives/`.
Every function there is `@primitive`-decorated into one registry. Every
consumer — the compare tool, the trading tool's `market_data`, backtests,
user scripts — reaches the *same* function through the *same* registry.
What you verified against TradingView is what runs in production. Always.

```
┌─────────────────┐     ┌──────────────────────┐
│  compare tool    │     │  trading tool         │
│  (verify+approve)│     │  (market_data bridge) │
└───────┬─────────┘     └──────────┬───────────┘
        │      both call           │
        ▼                          ▼
   qp.REGISTRY['ma.sma'].fn(...)   ← ONE implementation
        ▲
   approvals/approvals.json        ← the gate: what's ✅ verified
```

## Repo layout

```
quant-platform/
├── qp/
│   ├── __init__.py        exports: REGISTRY, Bars, Param, PrimitiveMeta,
│   │                      approved_primitives, is_approved, get_approval
│   ├── registry.py        @primitive decorator + registry + approvals I/O
│   └── primitives/
│       ├── _session.py    shared RTH/premarket/daily-frame helpers (not a primitive)
│       ├── bars.py        Bars — validated OHLCV container
│       ├── ma.py          sma, ema, wma, rma, vwma, hma, pine_5day
│       ├── vwap.py        session, n_day, weekly, monthly, anchored,
│       │                  today_hh/ll, week_hh/ll, swing_hh/ll, gap,
│       │                  last_hour_hh/ll, stdev_bands
│       ├── volatility.py  true_range, atr, stdev, bb, bb_ema
│       ├── oscillators.py rsi
│       ├── extremes.py    highest, lowest
│       ├── levels.py      prev-day/PM/overnight/weekly/monthly/monday/yearly
│       ├── dynamic_sr.py  dynamic support/resistance engine
│       ├── structure.py   pivot_high, pivot_low
│       ├── pivots.py      floor pivots {P,R1..R3,S1..S3}
│       └── candle.py      body, upper_wick, lower_wick, bar_range
├── approvals/approvals.json   git-tracked verification records
├── tools/
│   ├── compare_server.py      the verification web UI
│   ├── gen_catalog.py         regenerates docs/CATALOG.md from the registry
│   └── data/alpaca.py         bar loader (IEX feed, parquet cache)
├── docs/
│   └── CATALOG.md             full primitive catalog (auto-generated)
├── INTEGRATION.md             ← for the trading-tool builder: exact API contract
├── README.md                  this file
└── requirements.txt           pandas, numpy, pyarrow
```

## Running the compare tool (EC2 runbook)

```sh
cd ~/Tade-desk-server/quant-platform
git pull origin claude/read-j5hgnf                  # update code

# kill any previous server on 8765
kill $(ss -ltnp | grep 8765 | awk -F'pid=' '{print $2}' | awk -F',' '{print $1}') 2>/dev/null

export APCA_API_KEY_ID="PK..."                      # Alpaca paper keys
export APCA_API_SECRET_KEY="..."

nohup python3 tools/compare_server.py --host 0.0.0.0 --port 8765 > qp.log 2>&1 &
sleep 3 && curl -s http://127.0.0.1:8765/api/health
# → {"ok": true, "primitives": 60}
```

Open `http://<public-ip>:8765` in a browser. Requires port 8765 open in
the EC2 security group.

### HTTP endpoints

```
GET  /                            the page
GET  /api/health                  {"ok": true, "primitives": N}
GET  /api/primitives              registry + approval status + outputs shape
GET  /api/data?symbol=&tf=&days=&key=&params=&source=
POST /api/approve                 {key, approved_by, notes}
GET  /static/lightweight-charts.js   self-hosted chart library
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| Page loads but looks stale | Hard refresh: **Ctrl+Shift+R** |
| Orange banner in left panel | Chart library issue — the banner says exactly what; dropdown + Approve still work |
| `/api/data` returns 500 "APCA_API_KEY_ID…" | Export the Alpaca keys, restart the server (exports only apply to processes started after them) |
| Empty response / connection refused | Server died — rerun the `nohup` line; check `tail qp.log` |
| Boot log says "chart lib will use CDN fallback" | Server couldn't download the chart lib; browser will try CDNs directly |

## The verification workflow

1. Pick a primitive in the dropdown (🚧 = draft, ✅ = approved).
2. Set symbol / TF / days / source / params → **Compute**.
3. Compare the left chart against TradingView on the right (matching TV
   study auto-attaches where one exists). Check shape + hover 2-3 bars
   for numeric agreement.
4. Match → **Approve as verified** (writes `approvals/approvals.json`).
   Mismatch → don't approve; report the primitive, the settings, and
   what differs.
5. End of session, back up approvals:
   ```sh
   cd ~/Tade-desk-server && git add quant-platform/approvals/approvals.json \
     && git commit -m "approvals batch" && git push origin claude/read-j5hgnf
   ```

An approval records who, when, the git SHA of the code approved, and
notes. Re-approving overwrites (e.g. after a bug fix — re-verify, then
re-approve so the record points at the fixed code).

## Adding a primitive

1. Pick a group file under `qp/primitives/` (or create a new `.py` —
   auto-discovered, no wiring).
2. Write the function + decorator:

   ```python
   from qp.registry import primitive, Param

   @primitive(
       name='my_thing',                # globally unique short name
       group='ma',
       description='What it computes. Which Pine call it matches.',
       params=(Param('length', 'int', default=9, min=1),),
       inputs=('source',),             # or ('bars',)
       # outputs=('a', 'b') if it returns a dict of arrays
   )
   def my_thing(source, length: int):
       ...  # return np.ndarray aligned to input, NaN for warm-up
   ```

3. Restart the compare server → the primitive appears with 🚧.
4. Verify → approve → `python3 tools/gen_catalog.py` → commit.

Contract rules the decorator enforces: unique `group.name` key AND
globally unique short `name` (the trading tool flattens names into
`market_data.<name>()`).

## Consuming the library

```python
import qp

# direct call
values = qp.REGISTRY['ma.sma'].fn(close_array, length=9)

# bars-input primitives take the validated container
vwap = qp.REGISTRY['vwap.session'].fn(qp.Bars.from_frame(df))

# ONLY the verified slice — what the trading tool must use
for key, meta in qp.approved_primitives().items():
    print(key, meta.params, meta.outputs)
```

**Building the trading tool / an adapter?** Read **`INTEGRATION.md`** —
it contains the exact, code-tested contract: building `Bars` from plain
bar dicts, the parameter/return conventions, warm-up policy, import-path
guidance, dependencies, and a runnable end-to-end example.

## Documented deviations from the source Pine scripts

Each deviation exists for a stated reason; everything else matches
bar-for-bar:

1. **VWAPs default to `rth_only=True`** — matches a standard TV equities
   chart (whose data excludes extended hours). Set `rth_only=False` for
   extended-hours accumulation.
2. **`vwap.n_day` block phase** — Pine counts days from its loaded chart
   history, which is arbitrary; qp counts from the fetched window. Phase
   may differ by a day vs TV; the math within blocks is identical.
3. **`last_hour_*` bounded to < 16:00 ET** — the raw Pine (`hour >=
   start`) leaks into after-hours on extended charts; qp implements the
   intent (the last trading hour).
4. **`pivots.floor` defaults to `session='rth'`** — TV daily bars for
   stocks exclude extended hours, so this matches what TV draws;
   `'eth'` gives the Pine's literal full-day behaviour (futures).
5. **Before a VWAP's first anchor qp shows NaN** — Pine shows an
   accumulate-from-history-start line there, which depends on how many
   bars happen to be loaded. qp deliberately shows nothing.
6. **Weekly/monthly/yearly levels are RTH-only** — matches TV's
   weekly/monthly equity bars; `weekly_open` is Monday 09:30, not the
   04:00 premarket print.
7. **Daily charts:** session filters treat each daily bar as the RTH
   aggregate, so levels/pivots/session-VWAPs work on 1d frames.

## Docs index

- `docs/CATALOG.md` — every primitive: description, inputs, outputs,
  params, approval status. Auto-generated; regenerate with
  `python3 tools/gen_catalog.py`.
- `INTEGRATION.md` — the trading-tool integration contract.
