# Trade Desk — deployment

**pm2 supervises the desk. systemd runs the scheduled jobs. Nothing is
supervised by both.**

That last sentence is the whole point of this file, and getting it wrong cost
113,854 restarts — see *The two supervisors*, below.

## What runs, and who owns it

| Process | Port | What | Owner |
|---------|------|------|-------|
| `tool-T1` … `tool-T11` | 3000, 3010, 3050, 3060, 3120 | one screener each — `src/index.js` with `TOOL_ID` and its own `DB_PATH` | pm2 |
| `alerts`  | 3090 | the Algo desk — `src/alerts/server.js`. Setups, orders, the flatten | pm2 |
| `qp`      | 8765 | the chart and backtest platform — `quant-platform/chart` | pm2 |
| `journal` | 3100 | the journal — a separate app in `~/journal-app` | pm2 |
| `archive` | the stopped tools' ports | read-only registers for tools that no longer scan | pm2 |

T1 also serves the landing page and the screener suite, so stopping it takes
the front door with it.

`tools.config.json` is the registry every one of these reads — the ports above
come from it, not from this table. If the two disagree, that file is right.

## Day to day

```sh
cd ~/Tade-desk-server && git pull
pm2 restart alerts qp journal tool-T1 tool-T2 tool-T6 tool-T7 tool-T11
```

Add `archive` when `tools.config.json` changed. The journal is deployed by its
own script and only when that script changes:

```sh
bash deploy/journal-tool.sh
```

`desk.js` and `desk.css` are served `no-cache` by every process, so a pull is
enough — the browser asks rather than using what it has. See
`src/utils/sharedAssets.js`.

## qp

qp has a config file rather than a command line, because its guard rails
(`min_uptime`, `max_restarts`) do not exist as command-line flags — pm2 answers
``unknown option `--min-uptime` `` and starts nothing.

```sh
pm2 delete qp
pm2 start deploy/qp.config.js
pm2 save
```

After that `pm2 restart qp` is enough. It waits up to twenty seconds for port
8765 to come free — a restart hands over and the old process takes a moment to
let go — and refuses with a named reason if it does not.

## The two supervisors

**2026-09-23.** `pm2 describe qp` read `online`, `restarts 113854`,
`uptime 0s`, while `curl localhost:8765/api/health` returned 200. Both were
true, of two different processes.

```
LISTEN 0.0.0.0:8765   python3  pid=923310
ec2-user  923310  PPID 1  Sep21  /usr/bin/python3 -m chart.server --port 8765
qp-chart.service   enabled
```

PPID 1: **systemd** owned the one that was serving. pm2's copy could not bind,
exited, and was restarted — once a second, for two days. On a two-core box that
is roughly a full core spent relaunching Python: every decide timed on that box
was timed against it, including the ones the 09:35 budget was set from.

The desk had already been moved from systemd to pm2 — `trade-screener`,
`trade-scorer` and `trade-desk` are all `disabled`. `qp-chart` was missed, and
nothing noticed because pm2's definition of `online` is "I started it".

**The version of this file that was here until today told you to do the
opposite.** It described the systemd stack as current and ended with:

> **pm2:** if you previously ran anything under pm2, `pm2 delete all && pm2
> kill` so it doesn't fight systemd for the ports.

Following that on this box today would delete the nine processes that are the
desk. A stale runbook is not a document that is merely out of date; it is a
document that gives a confident wrong instruction to someone who has come to it
because something is already wrong.

If a port is ever contested again, the question is *who is the parent*:

```sh
sudo ss -ltnp | grep <port>       # the PID holding it
ps -ef | grep '[c]hart.server'    # PPID 1 = systemd, otherwise pm2
systemctl list-unit-files | grep -iE 'qp|chart|trade|screener'
```

## systemd — what is still there, and why

Retired. Left disabled rather than deleted so the units can be read:

```
trade-screener.service   disabled
trade-scorer.service     disabled
trade-desk.service       disabled
qp-chart.service         disabled     ← disabled 2026-09-23
trade-desk-stack.target  enabled, and its members are all disabled
```

Still in use, and not supervising anything pm2 supervises:

```
qp-backfill.service      one-shot backfills
qp-daily.service/.timer  the daily job
```

`deploy/install-stack.sh` writes the retired units. It is kept for the same
reason they are — it documents what they were — and running it would re-enable
the conflict this file exists to describe.

## Notes

- **Keys** live in files, not in the environment: `data/keys.json`,
  `data/broker.json`, `quant-platform/.env`, `~/trade-desk.env`. All gitignored.
- **Small host.** Two cores. It is enough, and it is only enough while nothing
  is spinning: one process in a restart loop is a measurable share of a
  decision that has to land inside the minute it decides for.
- **A restart count is a health metric.** Every process here should sit in
  single digits. Five figures beside `online` is a process that has never
  started, and it will not tell you so on its own.
