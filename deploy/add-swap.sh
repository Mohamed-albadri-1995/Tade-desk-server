#!/usr/bin/env bash
#
# A 2 GB swapfile, once, idempotently.
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. deploy/README.md has always said the
# systemd units' MemoryHigh caps should be "paired with a 2 GB swapfile", and
# nothing ever created one. MemoryHigh is a SOFT cap: it throttles a service
# into swap rather than killing it, so with no swap to throttle into it does
# very little and the kernel reaches for the OOM killer instead.
#
# On 2026-09-04 the box stopped answering SSH — no banner, no timeout, nothing.
# That is what an OOM kill looks like from outside when what it takes is sshd,
# and the only way back in is a reboot from the AWS console.
#
# THE ARITHMETIC, on the t3.micro this runs on: 912 MiB total, against nine
# tools at ~55-80 MB, nine scorers at ~10-90 MB, an alerts desk at ~72, a
# journal at ~8, and a qp-chart unit allowed 600. It does not fit. Swap does not
# make it fit either — it makes the overflow SLOW instead of FATAL, which is the
# difference between a sluggish morning and a box you are locked out of.
#
# NOT RUN BY THE DEPLOY. Writing a 2 GB file to the root volume and editing
# /etc/fstab is not something a deploy should do to a machine behind your back.
# The deploy checks and says; this does it when you decide to.
#
# Usage:  bash deploy/add-swap.sh [size]      # size defaults to 2G
set -euo pipefail

SIZE="${1:-2G}"
FILE=/swapfile

have=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
if [ "$have" -gt 1024 ]; then
  echo "Swap is already on ($((have / 1024)) MB):"
  swapon --show
  echo
  echo "Nothing to do. Re-run with a size only if you want to REPLACE it, after"
  echo "'sudo swapoff $FILE && sudo rm $FILE'."
  exit 0
fi

if [ -e "$FILE" ]; then
  # PRESENT BUT NOT ON. A half-finished previous run, or a reboot that lost the
  # fstab line. Turning it on is right; recreating it would destroy a file
  # something else may be using.
  echo "$FILE exists but is not in use — switching it on rather than rewriting it."
else
  echo "Creating $SIZE at $FILE…"
  # fallocate first; on some filesystems it produces a file swapon refuses, and
  # dd is the slow answer that always works.
  if ! sudo fallocate -l "$SIZE" "$FILE" 2>/dev/null; then
    echo "  fallocate not available here — writing with dd, this takes a minute."
    sudo dd if=/dev/zero of="$FILE" bs=1M count=$(( ${SIZE%G} * 1024 )) status=none
  fi
  # 0600, because a swapfile holds whatever was in memory — including keys.
  sudo chmod 600 "$FILE"
  sudo mkswap "$FILE" >/dev/null
fi

sudo swapon "$FILE"

# ACROSS REBOOTS. A swapfile that vanishes on the next boot is a fix that lasts
# until the first thing that would have needed it.
if ! grep -q "^$FILE " /etc/fstab; then
  echo "$FILE none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
  echo "Added to /etc/fstab so it survives a reboot."
fi

# SWAPPINESS. The default of 60 swaps eagerly, which on a box whose working set
# genuinely fits would cost latency for nothing. 10 keeps everything in RAM
# until it is actually short — swap as a safety net, not as a habit.
if [ "$(cat /proc/sys/vm/swappiness)" -gt 10 ]; then
  sudo sysctl -w vm.swappiness=10 >/dev/null
  if ! grep -q '^vm.swappiness' /etc/sysctl.conf 2>/dev/null; then
    echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
  fi
  echo "Set vm.swappiness=10 — swap as a safety net, not as a habit."
fi

echo
free -h
echo
echo "Done. This does not create memory: it makes running out of it slow"
echo "instead of fatal. If the desk is routinely deep in swap, the answer is a"
echo "bigger instance or fewer tools running at once — not more swap."
