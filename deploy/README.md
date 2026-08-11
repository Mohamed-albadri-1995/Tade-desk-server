# Trade Desk — systemd deployment

Runs the whole stack as systemd services so it **auto-starts on boot** and
**auto-restarts on crash** (no more `nohup` dying on reboot or an OOM taking
everything down).

## The stack

| Unit | Port | What | Source |
|------|------|------|--------|
| `trade-scorer.service`   | 3001 | Flask live scorer     | `src/scoring/server.py` |
| `trade-screener.service` | 3000 | Node/Express screener | `src/index.js` |
| `qp-chart.service`       | 8765 | FastAPI chart + nav   | `quant-platform/chart` |
| `trade-desk.service`     | 8000 | FastAPI trading tool  | *its own clone / branch* |
| `trade-desk-stack.target`| —    | groups all four       | — |

Connections: chart → screener (3000), screener → scorer (3001),
trading tool → screener (3000).

## Install (one time)

From the shell where the services already work (so their API keys are in the
environment — the screener/scorer have no dotenv, and systemd can't see shell
exports):

```sh
cd ~/Tade-desk-server
bash deploy/install-stack.sh
```

This snapshots the exported keys into `~/trade-desk.env`, writes the three
in-repo units + the group target, hands the ports over from any manual
instances, and enables everything.

Then install the trading tool's own unit once, from its clone:

```sh
cd ~/tade-desk-server && bash deploy/install-service.sh
```

## Manage

```sh
sudo systemctl restart trade-desk-stack.target        # bounce the whole stack
systemctl status trade-scorer trade-screener qp-chart trade-desk
sudo systemctl restart qp-chart                       # after a chart git pull
tail -f ~/screener.log ~/scorer.log ~/chart.log
```

## Notes

- **Keys:** if a chart feed shows `no key`, add `KEY=value` lines to
  `~/trade-desk.env` and `sudo systemctl restart trade-screener qp-chart`.
- **Small host:** each unit has a `MemoryHigh` soft cap so one service is
  throttled to swap before it can starve the others. Pair with a 2 GB swapfile.
- **pm2:** if you previously ran anything under pm2, `pm2 delete all && pm2 kill`
  so it doesn't fight systemd for the ports.
