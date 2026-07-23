#!/usr/bin/env bash
# gate.sh — the one command that decides whether this tree is releasable.
#
# The release documents are checked against a "GATE EXIT: 0" line. Until now
# nothing printed it: it was typed by hand around `npm run test:release`, so
# the check that guarded every published figure was a human retyping a number
# that no process had produced. A pipe into `tee` was enough to lose the real
# status, because a pipeline reports its LAST command.
#
# Two modes, selected by OLV_GATE_MODE:
#
#   development (default)  Runs the static gate and regenerates the COMMITTED
#                          development evidence, docs/validation/test-evidence.json.
#
#   release                Runs EVERY mandatory release stage into ONE log:
#                          static gate, deterministic e2e, docs build,
#                          production audit, fixture checksums, coverage,
#                          mutation. Writes the authoritative record to
#                          release/test-evidence-v<version>.json and touches
#                          no tracked file. That last property is the point:
#                          the exact-tag workflow packages this same checkout
#                          immediately afterwards, and packaging refuses a
#                          dirty tree. A gate that modified the committed
#                          evidence would fail the very gate it feeds.
#
# Each stage appends a machine-readable `GATE STAGE <name> EXIT: <code>`
# marker. Release evidence is built FROM those markers, so a stage that never
# ran leaves no marker and the record refuses to exist. `gateExit: 0` can no
# longer mean "the static gate passed and nothing else was checked".
set -o pipefail

MODE="${OLV_GATE_MODE:-development}"
LOG="${OLV_GATE_LOG:-release/gate.log}"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

VERSION="$(node -p "require('./package.json').version")"
OVERALL=0

# Run one stage: stream its output to the console AND the log, then append the
# exit marker. PIPESTATUS[0] is the stage's real status; a bare `$?` after the
# tee would always read 0.
run_stage() {
  stage_name="$1"; shift
  echo "──── GATE STAGE ${stage_name} ────" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  stage_code=${PIPESTATUS[0]}
  echo "GATE STAGE ${stage_name} EXIT: ${stage_code}" | tee -a "$LOG"
  if [ "$stage_code" -ne 0 ]; then OVERALL=$stage_code; fi
}

fixture_checksums() {
  (cd tests/fixtures/reference/slope && shasum -a 256 -c SHA256SUMS)
}

production_audit() {
  npm audit --omit=dev --audit-level=high
  audit_code=$?
  # The JSON report is a release artifact; the human-readable run above is the
  # pass/fail signal.
  npm audit --omit=dev --json > release/production-audit.json 2>/dev/null || true
  return $audit_code
}

run_stage staticGate npm run test:release

if [ "$MODE" = "release" ]; then
  if [ "$OVERALL" -eq 0 ]; then
    run_stage e2e npm run test:e2e
    run_stage docsBuild npm run docs:build
    run_stage productionAudit production_audit
    run_stage fixtureChecksums fixture_checksums
    run_stage coverage npm run coverage -- --reporter=dot
    run_stage mutation npm run mutation
  else
    echo "staticGate failed; the remaining release stages were not run." | tee -a "$LOG"
  fi
fi

echo "" | tee -a "$LOG"
echo "GATE EXIT: ${OVERALL}" | tee -a "$LOG"

if [ "$OVERALL" -ne 0 ]; then
  echo "Gate failed — evidence NOT regenerated; the figures still describe the last passing run." >&2
  exit "$OVERALL"
fi

if [ "$MODE" = "release" ]; then
  # The docsBuild stage re-renders docs-site/validation/claim-register.generated.md,
  # a tracked file. The render is deterministic and a drift test inside
  # staticGate asserts the committed copy already byte-equals it, so the tree
  # stays clean in practice. "In practice" is not an invariant, so assert it:
  # a future nondeterministic render fails HERE, in the same run that caused
  # it, for local runs and CI alike.
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -n "$(git status --porcelain)" ]; then
      echo "Release gate refused: the run left the working tree dirty:" >&2
      git status --porcelain >&2
      echo "A release gate must leave the checkout byte-identical; packaging would reject it anyway." >&2
      exit 1
    fi
  fi
  node scripts/collect-evidence.mjs \
    --mode release \
    --gate-log "$LOG" \
    --gate-exit 0 \
    --output "release/test-evidence-v${VERSION}.json" || exit 1
  echo "Release evidence written to release/test-evidence-v${VERSION}.json; the tracked tree is byte-identical."
else
  node scripts/collect-evidence.mjs "$LOG" 0 || exit 1
  echo "Evidence regenerated from this run."
fi
