#!/bin/bash
set -e

# Deploy all three tools. Each is a full copy of the screener with its own
# database, screeners, registers, shortlist, model and training history —
# nothing is shared, so one tool cannot affect another.
#
#   ./deploy-tools.sh            deploy every tool
#   ./deploy-tools.sh T2         deploy just one
#   BRANCH=some/branch ./deploy-tools.sh

BRANCH="${BRANCH:-claude/multi-tool-screeners}"
ONLY="${1:-}"
ROOT=~/Tade-desk-server

echo "=== Trade Desk — multi-tool deploy ==="
echo "Branch: $BRANCH"
[ -n "$ONLY" ] && echo "Only:   $ONLY"

cd "$ROOT"

# WHAT THIS SCRIPT LOOKED LIKE BEFORE IT PULLED ITSELF.
#
# THE TRAP, walked into on the deploy that shipped the qp check below: this
# script pulls the repo, and the repo contains this script. `git reset --hard`
# replaces the FILE, but bash is part-way through reading the OLD one through an
# open handle — so it finishes the run with the old code and the change appears
# to have done nothing. The qp check simply never printed, and the natural
# reading of that is "it is broken", not "it is not there yet".
#
# A deploy script that only takes effect on the NEXT deploy is a trap with no
# floor: every fix to it is silently one run late, including a fix to this.
SELF="$ROOT/$(basename "${BASH_SOURCE[0]}")"
SELF_BEFORE=$(md5sum "$SELF" 2>/dev/null | cut -d' ' -f1)

echo
echo "[1/6] Pulling latest code..."
git fetch origin "$BRANCH"

# This repository holds more than the screener — quant-platform/ is a separate
# tool living in the same tree. `git reset --hard` does not know that: it
# rewrites EVERY tracked file to match the branch, so deploying the screener
# from a branch whose quant-platform is older silently reverts that tool.
#
# That is not hypothetical; it is what this guard was written for. Check before
# destroying anything, and say exactly what would be lost.
NEIGHBOURS="quant-platform"
for dir in $NEIGHBOURS; do
  [ -e "$dir" ] || continue

  # Only what `git reset --hard` would actually destroy: tracked files that
  # differ from the index or HEAD. Untracked files ("??") survive a hard reset
  # untouched, so stopping for a stray log file would be a false alarm — and a
  # guard that cries wolf is one that gets worked around.
  dirty=$(git status --porcelain -- "$dir" | grep -v '^??' || true)
  if [ -n "$dirty" ]; then
    echo
    echo "  STOPPED: you have uncommitted changes in $dir/ that this deploy would destroy:"
    echo "$dirty" | sed 's/^/     /'
    echo
    echo "  Commit or stash them first:  git add $dir && git commit -m 'wip'"
    exit 1
  fi

  behind=$(git log --oneline "origin/$BRANCH..HEAD" -- "$dir" 2>/dev/null)
  if [ -n "$behind" ]; then
    echo
    echo "  STOPPED: $dir/ here is AHEAD of origin/$BRANCH. Resetting would lose:"
    echo "$behind" | sed 's/^/     /'
    echo
    echo "  Push those commits, or merge them into $BRANCH, before deploying."
    exit 1
  fi
done

# Remember where the neighbours were, so a change to them can be reported.
declare -A BEFORE
for dir in $NEIGHBOURS; do
  [ -e "$dir" ] && BEFORE[$dir]=$(git log -1 --format='%h' -- "$dir" 2>/dev/null)
done

git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "  now at: $(git log --oneline -1)"

# ── and if THIS script was one of the files that changed, start again ───────
#
# See the note at the top. Re-exec rather than carry on, so the deploy that
# lands a change to the deploy is the deploy that runs it.
#
# Guarded against looping: the second run finds the file unchanged by its own
# pull and falls straight through. The env var is belt to that brace — a
# repository that somehow never settles would otherwise re-exec for ever, in a
# script whose job is restarting a live desk.
SELF_AFTER=$(md5sum "$SELF" 2>/dev/null | cut -d' ' -f1)
if [ -n "$SELF_BEFORE" ] && [ "$SELF_AFTER" != "$SELF_BEFORE" ] \
   && [ -z "${DEPLOY_REEXECED:-}" ]; then
  echo
  echo "  this script changed in the pull — restarting it so the NEW one runs"
  echo "  (bash had the old file open; without this the change lands next time)"
  echo
  export DEPLOY_REEXECED=1
  exec bash "$SELF" "$@"
fi

# THE REGISTRY IS READ AFTER THE PULL, and it used to be read before it.
#
# tools.config.json is the single list of what to start: id, name, port and
# scorer port. Reading it first meant every deploy launched the tools described
# by the PREVIOUS deploy — so a rename showed the old name, and a port or a new
# tool would have started the wrong set entirely while the code on disk was
# current. It looked exactly like a deploy that had not taken.
#
# ONLY WHAT IS ENABLED, and the flags travel with the tool.
#
# `enabled: false` means the deploy does not start it. Before this the only
# ways to run fewer tools were `--only` — which is per-deploy AND skips the
# alerts app — or deleting the registry entry, which loses its ports, its
# capture times and the reasoning written beside them. So a routine
# `./deploy-tools.sh` silently brought all nine back, which on a 912 MB box is
# how you end up locked out of your own machine.
#
# ABSENT MEANS ON, for enabled and scorer both: an entry written before these
# flags existed behaves exactly as it always did.
mapfile -t TOOLS < <(node -e "
  const t = require('./tools.config.json').tools;
  t.filter(x => x.enabled !== false)
   .forEach(x => console.log([x.id, x.name, x.port, x.scorerPort,
                              x.scorer === false ? 'noscorer' : 'scorer'].join('|')));
")
mapfile -t OFF < <(node -e "
  const t = require('./tools.config.json').tools;
  t.filter(x => x.enabled === false)
   .forEach(x => console.log(x.id + (x.archive ? ' (archived, still readable)'
                                               : ' (stopped)')));
")
# EVERY tool, enabled or not — what the STOP phase works from. Stopping is
# about what exists on the box; starting is about what is wanted. See the note
# at [4/6]: reading one list for both left a disabled tool running for ever,
# holding the port its own archive needed.
mapfile -t ALL_TOOLS < <(node -e "
  const t = require('./tools.config.json').tools;
  t.forEach(x => console.log([x.id, x.name, x.port, x.scorerPort,
                              x.scorer === false ? 'noscorer' : 'scorer'].join('|')));
")
if [ ${#TOOLS[@]} -eq 0 ]; then
  echo "No ENABLED tools in tools.config.json — every entry is enabled:false."
  echo "That is almost certainly not what you meant; nothing would scan."
  exit 1
fi
echo "  tools: ${#TOOLS[@]} enabled"
# NAMED, NOT JUST COUNTED. "6 enabled" leaves you counting on your fingers to
# work out which three are missing, on the morning you are wondering why a
# register is empty.
if [ ${#OFF[@]} -gt 0 ]; then
  echo "  not started: ${OFF[*]}"
fi

# A neighbour whose files moved is now stale ON DISK while its process still
# runs the old code from memory. Everything looks fine until the next restart or
# reboot quietly loads different code — so say so at the moment it happens,
# rather than leaving it to be discovered later.
for dir in $NEIGHBOURS; do
  [ -e "$dir" ] || continue
  after=$(git log -1 --format='%h' -- "$dir" 2>/dev/null)
  echo "  $dir/ at: $(git log -1 --format='%h %s' -- "$dir")"
  if [ -n "${BEFORE[$dir]}" ] && [ "${BEFORE[$dir]}" != "$after" ]; then
    echo
    echo "  NOTE: $dir/ changed on disk (${BEFORE[$dir]} → $after)."
    echo "        Its running process still holds the OLD code in memory. Step"
    echo "        [6b/6] below restarts qp through pm2 — never through systemd."
    echo
  fi
done

echo
echo "[2/6] Dependencies..."
npm install --silent

# Python dependencies go in a virtualenv belonging to this project, NOT into the
# shared user environment.
#
# `pip3 install -r requirements.txt` writes to the site-packages every Python
# program on this box shares. requirements.txt asks for pandas, numpy,
# scikit-learn and flask with ">=" bounds, so pip is free to move those versions
# to satisfy this project — and anything else on the machine that depended on
# the versions that were there silently gets different ones. That is a deploy of
# the screener changing an unrelated tool underneath it.
#
# The virtualenv is created with --system-site-packages, which matters on a box
# this size. Without it, pip downloads and installs its own pandas, numpy and
# scikit-learn — around 150MB of wheels, and minutes of thrashing on a machine
# with under a gigabyte of RAM. With it, packages already present are visible
# and count as satisfied, so a deploy usually installs nothing at all.
#
# It still fixes the bug: pip can READ the shared packages but every install it
# does goes into .venv, so a screener deploy can no longer change the versions
# another program on this machine depends on.
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
if [ ! -x "$PY" ]; then
  echo "  creating Python virtualenv at .venv (reusing packages already installed)"
  python3 -m venv --system-site-packages "$VENV" 2>/dev/null || true
fi
if [ -x "$PY" ]; then
  echo "  checking Python packages (nothing to download if they are already present)…"
  "$PY" -m pip install -r src/scoring/requirements.txt --quiet --disable-pip-version-check
  echo "  python: $("$PY" --version 2>&1) — installs isolated to .venv"
else
  echo "  WARNING: could not create a virtualenv — falling back to the shared"
  echo "           Python environment. This can change package versions for"
  echo "           other programs on this machine. Install python3-venv to fix."
  PY=python3
  pip3 install -r src/scoring/requirements.txt --quiet
fi

echo
echo "[3/6] Clearing anything holding the tool ports..."
# A leftover systemd unit competing with PM2 once caused every retrain to be
# answered by a stale process while PM2's scorer crash-looped.
for unit in trade-scorer trade-screener trade-desk; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}.service"; then
    sudo systemctl stop "$unit" 2>/dev/null || true
    sudo systemctl disable "$unit" 2>/dev/null || true
  fi
done

echo
echo "[4/6] Stopping existing PM2 processes..."
#
# EVERY TOOL IN THE REGISTRY, NOT JUST THE ENABLED ONES.
#
# This iterated `TOOLS`, which is now filtered to what will be STARTED — so
# the first deploy after disabling a tool skipped it here and left it running
# for ever. Seen immediately, on the deploy that shipped the flag:
#
#     saving pm2 process list (journal, tool-T8, tool-T1, tool-T2, …)
#
# tool-T8 had been disabled and was still up. Worse than untidy: T8 is also
# ARCHIVED, and the archive wants T8's own port — so the live process held
# :3070 and the archive could not bind it. The result would have been a tool
# that was supposed to be off, serving live pages, while the archive that was
# supposed to replace it silently served nothing.
#
# Stopping is about what EXISTS; starting is about what is wanted. Reading one
# list for both is what made a disabled tool immortal.
#
# THE ARCHIVE GOES FIRST, and it has to be pm2 DELETE rather than a kill.
#
# It listens on several ports at once, so the port sweep below would kill it —
# and pm2 would immediately restart it, mid-deploy, onto ports the tools are
# about to claim. Removing it from pm2 first means the sweep finds nothing to
# resurrect.
if [ -z "$ONLY" ]; then pm2 delete archive 2>/dev/null || true; fi
for entry in "${ALL_TOOLS[@]}"; do
  IFS='|' read -r id name port sport scoreflag <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  pm2 delete "tool-${id}" 2>/dev/null || true
  pm2 delete "scorer-${id}" 2>/dev/null || true
  # Free the port, but only from OUR processes. This loop used to kill whatever
  # held the port, no questions asked — so anything else on this machine that
  # happened to listen on 3000–3081 was killed by a screener deploy. A port
  # number is not proof of ownership.
  for p in "$port" "$sport"; do
    for pid in $(lsof -t -i:"$p" 2>/dev/null); do
      cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo '')
      cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo '')
      case "$cmd$cwd" in
        *"$ROOT"*) kill -9 "$pid" 2>/dev/null || true ;;
        *) echo "  NOT killing pid $pid on port $p — it is not ours:"
           echo "     ${cmd:0:100}" ;;
      esac
    done
  done
done
# T1 kept the original process names before tools existed.
if [ -z "$ONLY" ] || [ "$ONLY" = "T1" ]; then
  pm2 delete trade-desk 2>/dev/null || true
  pm2 delete scorer 2>/dev/null || true
fi

# The alerts app is deleted here for the same reason the tools are: pm2 start on
# a name it already has refuses with "Script already launched", which every
# deploy has printed at the end and which is easy to read as a harmless notice.
# It is not harmless — it means the alerts process kept running the code it was
# started with while everything around it was replaced. It is a single process
# and not part of the per-tool loop above, so it needs its own line.
if [ -z "$ONLY" ]; then
  pm2 delete alerts 2>/dev/null || true
fi

echo
echo "[5/6] Starting tools..."

# ── A CEILING PER PROCESS, AND WHY THESE NUMBERS ──────────────────────────
#
# Eighteen pm2 processes ran with no memory limit at all. On 2026-09-04 the box
# stopped answering SSH entirely — no banner, no timeout, nothing — which is
# what an out-of-memory kill looks like from outside when the thing it takes is
# sshd or enough of userspace that a login cannot complete.
#
# THE ARITHMETIC. This is a t3.micro: 912 MiB, total. From the last healthy
# `pm2 list`: nine tools at ~55-80 MB, nine scorers at ~10-90 MB, alerts ~72,
# journal ~8. That is ~730 MB of pm2 alone, beside a qp-chart unit allowed 600
# and an OS wanting ~150. It does not fit, and it has not fitted for a while —
# it survived by luck and by processes being smaller than their peak.
#
# WHAT A CEILING BUYS. Not more memory. It converts a BOX-WIDE failure into ONE
# process restarting: the kernel's OOM killer picks its victim by its own score
# and can take sshd, systemd-journald or the alerts desk, and you find out by
# being locked out. pm2 restarting one leaky tool is a blip nobody notices.
#
# Set well above each process's working size and well below what would starve
# its neighbours: a limit that trips in normal use is a restart loop, which is
# worse than no limit. Override per box with the env vars if yours differs.
TOOL_MAX_MEM="${TOOL_MAX_MEM:-140M}"      # most tools sit at ~50-65
# ── AND THE CEILING THAT TRIPPED IS THE FAILURE THIS BLOCK WARNS ABOUT ─────
#
# 2026-09-16, `pm2 list`:
#
#     | 240 | tool-T2  | fork | 292 | online | 103.4mb |
#     | 242 | tool-T7  | fork |  87 | online |  51.8mb |
#     | everything else       |   0 | online |         |
#
# 292 restarts in one morning, against 0 for every other tool, and no stack
# trace anywhere — `pm2 logs tool-T2 --err` holds sixty lines of "[TV Scanner]
# No screeners are due to run right now" and nothing else. Because a
# --max-memory-restart kill is not a crash: pm2 stops the process and starts a
# new one, and neither writes a line.
#
# "tools sit at ~60" was true of the tools measured. It is not true of T2,
# which was already resident at 103 MB and peaks over the 140 as it scans. So
# the cap tripped in ORDINARY USE, which is the exact thing four lines up says
# must not happen: "a limit that trips in normal use is a restart loop, which
# is worse than no limit."
#
# AND IT COST A TRADING DAY. A setup's decision is scheduled inside the tool
# that owns it, and the 09:35 OR+VWAP setup is owned by T2. At 09:34 T2 was
# restarting, so the decision was never taken — no cards ranked, no orders, and
# no line in the session log, because the process that writes the line was the
# one that died.
#
# ONE NUMBER FOR ALL TOOLS WAS THE MISTAKE. They are not the same size: T2 runs
# the TV scanner over 39 tickers with its own model, T6 polls a handful. A cap
# high enough for the biggest is no cap at all for the smallest, and a cap
# right for the smallest is a restart loop for the biggest. Per tool, then —
# overridable one at a time with TOOL_MAX_MEM_T2=220M.
#
# THE HEADROOM IS AFFORDABLE. The arithmetic above assumed nine tools AND nine
# scorers; the box now runs six tools, no scorers, plus alerts, archive and
# journal — ~520 MB total on 2026-09-16, not ~730. Giving T2 80 MB more stays
# well inside what the swapfile below already covers.
tool_max_mem() {                          # tool_max_mem <TOOL_ID>
  local var="TOOL_MAX_MEM_$1"
  if [ -n "${!var:-}" ]; then echo "${!var}"; return; fi
  case "$1" in
    # 2026-09-24, ~pm2.log: "Process 346 restarted because it exceeds
    # --max-memory-restart value (current_memory=174428160
    # max_memory_limit=146800640)" — every 30 s, 52 times. T1 is resident at
    # 173–185 MB doing nothing unusual: it serves the landing page and the
    # screener suite beside its own scan. 140 was under its floor.
    T1) echo "280M" ;;
    # Measured at 103 MB resident while scanning, so 140 was under its peak.
    T2) echo "240M" ;;
    # 87 restarts on the same morning at 51.8 MB — nowhere near 140 when it was
    # looked at, but it is the only other tool restarting at all, so it gets
    # room too rather than another morning of guessing.
    T7) echo "180M" ;;
    *)  echo "$TOOL_MAX_MEM" ;;
  esac
}
SCORER_MAX_MEM="${SCORER_MAX_MEM:-180M}"  # scorers reach ~90 while training
ALERTS_MAX_MEM="${ALERTS_MAX_MEM:-180M}"  # alerts sits at ~72
# The archive holds several SQLite handles open and does nothing else. It has
# no scanner, no scheduler and no model, so it should never approach this —
# if it trips, something is reading far more than a register at a time.
ARCHIVE_MAX_MEM="${ARCHIVE_MAX_MEM:-120M}"

# ── SWAP, WHICH THE MEMORY CAPS ASSUME ────────────────────────────────────
#
# deploy/README.md says of the systemd units' MemoryHigh caps: "Pair with a 2 GB
# swapfile." MemoryHigh is a SOFT cap — it throttles a service to swap rather
# than killing it — so with no swap to throttle into it does almost nothing and
# the kernel goes to the OOM killer instead. The pairing is not advice, it is
# how the caps work.
#
# Checked and SAID, never created here: adding swap writes a file to the root
# volume and edits /etc/fstab, which is not something a deploy should do to a
# machine behind your back. `deploy/add-swap.sh` does it in one step when you
# decide to.
# ONLY WHERE IT ACTUALLY APPLIES. A 16 GB box with no swap is fine, and a
# warning that fires on a machine it is not true of is a warning people learn to
# scroll past — which costs it the one morning it matters. 2 GB is the line: the
# stack's own ceilings above come to roughly 1.5 GB with qp beside them.
_mem_mb=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 99999)
_swap_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$_mem_mb" -lt 2048 ] && [ "$_swap_kb" -lt 1024 ]; then
  echo
  echo "  !! NO SWAP on a ${_mem_mb}MB box, and this stack does not fit in it."
  echo "     The memory caps assume swap to throttle into; without it the kernel"
  echo "     OOM-kills instead, and what it picks may be sshd — which is a box"
  echo "     you cannot log in to fix. Run:  bash deploy/add-swap.sh"
  echo
fi
mkdir -p data
for entry in "${TOOLS[@]}"; do
  IFS='|' read -r id name port sport scoreflag <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue

  # T1 keeps the original paths so its existing history is picked up untouched.
  if [ "$id" = "T1" ]; then
    db="$ROOT/data/tradedesk.db"; out="$ROOT/src/scoring/outputs"; tmp="$ROOT/tmp"
  else
    lc=$(echo "$id" | tr 'A-Z' 'a-z')
    db="$ROOT/data/${lc}.db"; out="$ROOT/src/scoring/outputs-${lc}"; tmp="$ROOT/tmp-${lc}"
  fi
  mkdir -p "$out" "$tmp"

  # THE SCORER IS OPTIONAL, AND ITS ABSENCE IS NOT A FAILURE.
  #
  # Side E is already a soft stage: a missing scorer leaves `_score: null` on
  # every card, with a note on the scan report saying which. So switching them
  # off degrades by design rather than by luck — but it is not free, and the
  # cost is stated where it is paid: nothing can rank or filter on _score any
  # more, including a setup using the `reg_score` metric.
  if [ "$scoreflag" = "noscorer" ]; then
    echo "  ${id} (${name}) — app :${port}  (no scorer: _score will be null)"
  else
    echo "  ${id} (${name}) — app :${port}  scorer :${sport}"
    pm2 start src/scoring/server.py --name "scorer-${id}" --interpreter "$PY" \
      --time --max-memory-restart "$SCORER_MAX_MEM" \
      -- --output "$out" --port "$sport" >/dev/null
  fi

  # ── --time: A LOG LINE WITH NO DATE ON IT ANSWERS NOTHING ───────────────
  #
  # 2026-09-16, tool-T2 restarted once and `pm2 logs tool-T2 --err` was asked
  # why. It returned sixty identical lines with no timestamps on any of them —
  # so there was no way to tell whether they came from before the restart,
  # after it, or from the previous week. The pm2 log FILE persists across
  # restarts and deploys; `--lines 60` is the tail of an accumulated file, not
  # a window on the last hour, and without a date the difference is invisible.
  #
  # The question that matters about this desk is always "what happened at
  # 09:34", and an undated line cannot be part of the answer. pm2 stamps every
  # line when started with --time. The journal was already started this way;
  # the tools — the processes that own the trading decisions — were not.
  TOOL_ID="$id" TOOL_NAME="$name" PORT="$port" \
  DB_PATH="$db" MODEL_OUTPUT_ROOT="$out" TMP_DIR="$tmp" \
  SCORER_URL="http://127.0.0.1:${sport}" \
    pm2 start src/index.js --name "tool-${id}" --update-env --time \
    --max-memory-restart "$(tool_max_mem "$id")" >/dev/null
done

# ── THE ARCHIVE ────────────────────────────────────────────────────────────
#
# A stopped tool serves NOTHING, and qp reads every tool over HTTP —
# chart/screener.py builds its source URLs from this same registry and calls
# /api/warehouse/*. So stopping T3, T4, T5, T8 and T9 would take every chart,
# print and backtest of their history with them.
#
# One read-only process answers for all of them, on their own ports, with the
# same API. qp cannot tell the difference and needs no change. ~45 MB once,
# against ~290 MB for five tools and their scorers.
if [ -z "$ONLY" ]; then
  ARCHIVED=$(node -e "
    const t = require('./tools.config.json').tools;
    process.stdout.write(t.filter(x => x.archive).map(x => x.id).join(','));
  ")
  if [ -n "$ARCHIVED" ]; then
    echo "  ARCHIVE — read-only registers for ${ARCHIVED//,/ }"
    pm2 delete archive 2>/dev/null || true
    pm2 start src/archive/server.js --name "archive" --update-env --time \
      --max-memory-restart "$ARCHIVE_MAX_MEM" >/dev/null
  fi
fi

# The alerts service. One process, not nine: the rules and the fires are shared
# files, and it does not evaluate anything — the screeners already do that on
# their own scans, holding the cards the rules compare. A tenth process
# re-fetching the same data would be a second opinion on what "crossed" means.
# Skipped entirely when deploying one tool: --only T2 should not restart the
# alerts app, and starting it while it is already running is what produced the
# "Script already launched" line on every single-tool deploy.
if [ -z "$ONLY" ]; then
  ALERTS_PORT=$(node -e "const a=require('./tools.config.json').apps.find(x=>x.id==='ALERTS');process.stdout.write(String(a?a.port:3090))")
  echo "  ALERTS — app :${ALERTS_PORT}"
  ALERTS_PORT="$ALERTS_PORT" pm2 start src/alerts/server.js --name "alerts" \
    --update-env --time --max-memory-restart "$ALERTS_MAX_MEM" >/dev/null
fi
# pm2 save rewrites the startup list from whatever is running RIGHT NOW, so a
# process that happened to be stopped at this moment would be dropped from it
# and would not come back after a reboot. Say what is being saved.
echo
echo "  saving pm2 process list ($(pm2 jlist 2>/dev/null | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    try{const j=JSON.parse(s);console.log(j.map(p=>p.name).join(', '))}catch{console.log('?')}
  });" 2>/dev/null || echo '?'))"
pm2 save >/dev/null

echo
echo "[6/6] Health checks..."

# Poll rather than sleep-and-hope. Every scorer imports pandas and sklearn at
# startup, which takes a couple of seconds on its own; seven of them booting at
# once contend for CPU and take considerably longer. A single check after a flat
# five seconds reported FAIL for scorers that were fine moments later — and
# always for the first tools in the list, because those are checked while the
# contention is at its worst. Waiting for all of them before reporting anything
# means the verdict describes the deploy rather than the order of the loop.
wait_up() {  # wait_up <url> <attempts>
  local url="$1" tries="${2:-20}"
  for _ in $(seq 1 "$tries"); do
    curl -s --max-time 3 "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Counted from what was actually STARTED. Waiting for two processes per tool
# when half of them have no scorer would spend the whole timeout on a port
# nothing is listening to, and then print a row of dots that means nothing.
_expect=0
for entry in "${TOOLS[@]}"; do
  IFS='|' read -r id name port sport scoreflag <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  _expect=$(( _expect + 1 ))
  [ "$scoreflag" = "noscorer" ] || _expect=$(( _expect + 1 ))
done
printf "  waiting for %s process(es) to come up" "$_expect"
for entry in "${TOOLS[@]}"; do
  IFS='|' read -r id name port sport scoreflag <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  wait_up "http://localhost:${port}/health" >/dev/null 2>&1 || true
  [ "$scoreflag" = "noscorer" ] \
    || wait_up "http://127.0.0.1:${sport}/health" >/dev/null 2>&1 || true
  printf "."
done
echo

for entry in "${TOOLS[@]}"; do
  IFS='|' read -r id name port sport scoreflag <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  printf "  %-3s %-32s app: " "$id" "$name"
  curl -s --max-time 4 "http://localhost:${port}/health" >/dev/null 2>&1 && printf "OK   " || printf "FAIL "
  # OFF IS NOT FAIL. A scorer nobody started reporting "FAIL" is the same
  # confusion this whole week has been about — a deliberate absence rendered
  # as a fault, on the line you read to decide whether the deploy worked.
  if [ "$scoreflag" = "noscorer" ]; then
    echo "scorer: off (by config)"
  else
    printf "scorer: "
    curl -s --max-time 4 "http://127.0.0.1:${sport}/health" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(('ready' if d.get('ready') else 'not trained')
          + ', buckets=' + str(d.get('n_buckets'))
          + (', WARNING outdated code' if d.get('code_stale') else ''))
except Exception:
    print('FAIL')
" 2>/dev/null || echo "FAIL"
  fi
done

# The archive, checked on one of the ports it claims to answer for. A process
# that is "online" in pm2 and serving nothing is the failure mode worth
# catching here, since qp will not complain — it will just find no data.
if [ -z "$ONLY" ] && [ -n "${ARCHIVED:-}" ]; then
  _first=${ARCHIVED%%,*}
  _aport=$(node -e "
    const t = require('./tools.config.json').tools.find(x => x.id === '$_first');
    process.stdout.write(String(t ? t.port : ''));
  ")
  printf "  ARCHIVE %-32s " "(${ARCHIVED//,/ })"
  if [ -n "$_aport" ] && curl -s --max-time 4 \
       "http://127.0.0.1:${_aport}/api/warehouse/available-dates" >/dev/null 2>&1; then
    echo "serving on :${_aport} and the rest"
  else
    echo "NOT ANSWERING on :${_aport} — qp will find no history for these"
  fi
fi

# ── qp, which this deploy does not own but the desk depends on ─────────────
#
# THE OUTAGE THIS EXISTS TO PREVENT. The chart platform runs as a SYSTEMD
# service, not under pm2, so nothing above restarts it. When the position
# manager was added, its endpoint — /api/strategy/manage — shipped inside
# quant-platform/ and the running qp never picked it up. Every pass got a 404
# for an hour, with a real short open and nothing evaluating its exit rule.
#
# There WAS a warning here already, printed when quant-platform/ changed in the
# pull. It is not enough, and the reason is worth stating: it fires on the
# deploy that introduces the change, and is silent on every deploy afterwards —
# so a note that was missed once is missed for good, while the desk stays
# broken. A warning about an event cannot detect a STATE.
#
# So this asks qp what it is actually running. /api/health returns the short SHA
# resolved at ITS startup; if that is not this checkout's HEAD, the process is
# holding older code whatever the pull did, and it is restarted rather than
# mentioned. Never fatal: qp not being installed is a normal way to run the
# screeners, and a failure here must not fail a deploy that otherwise worked.
echo
echo "[6a/6] qp feed keys..."
# The desk holds the Alpaca pair once; qp reads it from quant-platform/.env.
# Copied here on every deploy so the two can never disagree, and never printed.
# Exit 3 means .env changed and qp must restart to see it.
QP_FORCE_RESTART=""
if [ -d quant-platform ]; then
  # `|| SYNC_RC=$?` and not `; SYNC_RC=$?`: this script runs under `set -e`,
  # and a bare non-zero exit ENDS THE DEPLOY. The first run of this step did
  # exactly that — it wrote the keys, exited 3 to ask for a restart, and the
  # deploy stopped dead before [6b/6], so qp kept running without them. An
  # exit code that is a message must be read, not obeyed.
  SYNC_RC=0
  node scripts/sync-qp-env.js || SYNC_RC=$?
  if [ "$SYNC_RC" = "3" ]; then QP_FORCE_RESTART=1; fi
fi

echo "[6b/6] Chart platform (qp)..."
if [ -d quant-platform ]; then
  QP_PORT="${QP_PORT:-8765}"
  WANT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  # Through pm2 ONLY. This block used to restart qp through systemd's
  # qp-chart unit, the one whose second copy of qp caused 113,854 restarts on 2026-09-23.
  # See deploy/qp-restart.sh.
  QP_PORT="$QP_PORT" bash deploy/qp-restart.sh "$WANT" "$QP_FORCE_RESTART" || true
fi

# ── WHICH FEEDS ANSWERED, WHICH IS NOT WHICH FEEDS HAVE A KEY ─────────────
#
# This used to read /api/health, whose `feeds` block is `_feed_status()` — an
# inventory of CREDENTIALS. Its own docstring says why that is not enough: "A
# key being PRESENT is not evidence that the plan behind it includes the data
# being asked for." So the deploy printed
#
#     feeds: alpaca ok · polygon ok · yahoo ok
#
# every single day while the desk's Alpaca key was being refused outright:
#
#     Alpaca asset MMED 401: {"message": "unauthorized."}
#
# A 401 is not a plan limit — the credential was not accepted at all — and the
# deploy minutes earlier had called it ok. A field that says the same thing
# whatever happened, in the one line anybody reads to decide whether the
# morning is safe to trade. It is also why the short-borrow check never ran
# once, which is how MMED reached the wire on 2026-09-15 as an order the broker
# could not fill.
#
# AND IT RAN ONLY WHEN qp WAS RESTARTED. The check lived inside the "qp was
# stale, restarted it, it came back" branch, so on every deploy where qp was
# already current it printed nothing at all — the exact fault stated thirty
# lines above it about the staleness warning itself: "A warning about an event
# cannot detect a STATE." It is its own step now and runs whenever qp answers.
if [ -d quant-platform ]; then
  echo
  echo "[6c/6] Feeds — fetched, not inventoried..."
  # /api/feedcheck FETCHES from each loader and judges what came back, reusing
  # datacheck's own check_feed rather than growing a second opinion about what
  # a working feed looks like. Two definitions of "ok" is how this started.
  # The timeout is generous because it is real network work, one small daily
  # bar request per feed.
  curl -s --max-time 60 "http://127.0.0.1:${QP_PORT:-8765}/api/feedcheck" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        let j;try{j=JSON.parse(s)}catch{
          // NOT 'ok'. A check that could not run is its own answer, and the
          // one thing it must never be reported as is a pass.
          console.log('  COULD NOT CHECK — no answer from qp on :${QP_PORT:-8765}');
          console.log('  Nothing here says the feeds are bad. It says nobody asked.');
          return}
        const f=j.feeds||[];
        if(!f.length){console.log('  COULD NOT CHECK — qp listed no feeds');return}
        console.log('  '+f.map(x=>x.feed+' '+(x.ok?'ANSWERED':'FAILED')
          +(x.ms!=null?' ('+x.ms+'ms)':'')).join(' · '));
        for(const x of f){ if(x.ok) continue;
          console.log('    '+x.feed+': '+(x.detail||'no reason given'));
          if(x.fix)console.log('      fix: '+x.fix); }
        // THE CONSEQUENCE, NOT JUST THE STATUS. A feed being down is a fact; a
        // setup deciding on a different feed than it was tested on is what it
        // costs, and that is the sentence worth reading at 04:00.
        if(!f.some(x=>x.feed==='alpaca'&&x.ok))
          console.log('    a setup set to alpaca will decide on whatever it falls back to');
      });" 2>/dev/null || echo "  COULD NOT CHECK — the request itself failed"
fi

# ── WHAT HAS BEEN BOUNCING, WHICH NOTHING WAS SAYING ──────────────────────
#
# A restart count is the only trace a --max-memory-restart kill leaves. It
# writes no stack trace, no exit line, nothing to either pm2 log — so tool-T2
# restarting 292 times on 2026-09-16 was visible ONLY as a number in a column
# of `pm2 list` that nobody has a reason to read on a day that looks normal.
# It cost the 09:35 setup its entire trading day.
#
# A deploy is exactly when this is worth saying: it is the one moment somebody
# is already watching the output. The count is read AFTER the restarts above,
# so a freshly started process reads 0 and only a process that has been bouncing
# since — or that pm2 kept across the deploy — shows a number.
#
# NOT FATAL. A tool that restarts is still serving, and a deploy that failed
# over a counter would be a worse tool than one that says so and carries on.
echo
echo "[6d/6] Restart counts..."
pm2 jlist 2>/dev/null | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    let j;try{j=JSON.parse(s)}catch{console.log('  could not read pm2');return}
    // THE THRESHOLD IS LOW ON PURPOSE. Restarting twice in a session is not
    // normal for a process that is meant to run from 04:00 to 20:00, and a
    // number that only speaks at 50 would have said nothing for the first two
    // hundred of T2's.
    const bad=j.filter(p=>((p.pm2_env||{}).restart_time||0)>=3)
               .sort((a,b)=>(b.pm2_env.restart_time)-(a.pm2_env.restart_time));
    if(!bad.length){console.log('  nothing has restarted more than twice');return}
    for(const p of bad){
      const mb=Math.round(((p.monit||{}).memory||0)/1048576);
      const cap=(p.pm2_env||{}).max_memory_restart;
      const capmb=cap?Math.round(cap/1048576):null;
      console.log('  '+p.name+' — '+p.pm2_env.restart_time+' restarts, now '+mb+' MB'
        +(capmb?' of a '+capmb+' MB ceiling':' with no ceiling'));
    }
    // A RESTART LOOP AND A CRASH LOOP NEED DIFFERENT LOOKING-AT, and the
    // memory against the ceiling is what separates them.
    console.log('  A tool that restarts at its decision minute takes that');
    console.log('  setup\'s whole day with it. If the MB is near the ceiling');
    console.log('  raise it (TOOL_MAX_MEM_<ID>); if it is not, read:');
    console.log('    pm2 logs <name> --err --lines 200 --nostream');
  });" 2>/dev/null || echo "  could not read pm2"

echo
IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo localhost)
echo "Landing page: http://${IP}:3000/"
echo "=== Done ==="
