#!/usr/bin/env bash
# gate.sh — the one command that decides whether this tree is releasable.
#
# The release documents are checked against a "GATE EXIT: 0" line. Until now
# nothing printed it: it was typed by hand around `npm run test:release`, so
# the check that guarded every published figure was a human retyping a number
# that no process had produced. A pipe into `tee` was enough to lose the real
# status, because a pipeline reports its LAST command.
#
# So: run the gate, keep the log, print the true exit, and regenerate the
# evidence from that run. Exit non-zero if any part of it failed.
set -o pipefail
LOG="${OLV_GATE_LOG:-release/gate.log}"
mkdir -p "$(dirname "$LOG")"

npm run test:release 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}

echo ""
echo "GATE EXIT: ${STATUS}"

if [ "$STATUS" -ne 0 ]; then
  echo "Gate failed — evidence NOT regenerated; the figures still describe the last passing run." >&2
  exit "$STATUS"
fi

node scripts/collect-evidence.mjs "$LOG" 0 || exit 1
echo "Evidence regenerated from this run."
