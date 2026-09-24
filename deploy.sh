#!/bin/bash
# RETIRED. This was the single-tool deploy of 2026-08: it ran `pm2 delete all`,
# checked out claude/catalyst-assigning-algorithm-c78g7y and started processes
# named `trade-desk` and `scorer` that no longer exist. Run today, it would have
# deleted every tool, the Algo desk and qp from pm2 and deployed an old branch.
#
# Three places still told you to run it (README.md, scripts/set-alpaca-keys.js,
# a pipeline error message). They point at the real one now.
echo "deploy.sh is retired — it would delete every pm2 process and deploy an old branch."
echo
echo "Use:   ./deploy-tools.sh          (see deploy/README.md)"
exit 1
