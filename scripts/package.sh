#!/usr/bin/env bash
#
# package.sh — build and package OpenLiDARViewer for release.
#
# Produces two archives with WEB-SAFE file modes baked in (644 files,
# 755 directories) so that when the deploy bundle is extracted onto a web
# host, the server process (a different user — www-data / nginx / etc.) can
# read every asset and traverse every directory. Packaging ad-hoc with `zip`
# preserves the source tree's restrictive 600/700 modes, which serve as
# 403s once deployed; this script normalises them every time.
#
# Usage:
#   scripts/package.sh [OUT_DIR] [--source-only]
#
#   OUT_DIR  Where the .zip files are written. Defaults to ./release.
#
# Archives:
#   openlidarviewer-vX.Y.Z-deploy-<ts>-root.zip   dist/ contents at zip root
#   openlidarviewer-vX.Y.Z-source-<ts>.zip        source tree (no node_modules/dist/.git)
#
# Notes:
#   - The zip is assembled in a temp dir and copied into OUT_DIR, because
#     some mounted filesystems reject zip's in-place rewrite.
#   - Modes are normalised on a COPY of the tree; your working tree is
#     untouched.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# `--source-only` is stripped here, before the positional OUT_DIR is read —
# otherwise the flag was taken as the output directory and mkdir choked on it.
SOURCE_ONLY=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--source-only" ]; then SOURCE_ONLY=1; else ARGS+=("$arg"); fi
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

OUT_DIR="${1:-$ROOT/release}"
mkdir -p "$OUT_DIR"

VERSION="$(node -p "require('./package.json').version")"
TS="$(date +%Y%m%d-%H%M)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fail loudly on a truncated / corrupt archive rather than shipping it. A zip
# that lacks its end-of-central-directory record (e.g. the writing process was
# interrupted) passes `cp` but is unusable to the recipient — this gate makes
# packaging exit non-zero, and removes the bad file so it can't be mistaken for
# a good artifact.
verify_zip() {
  local f="$1"
  if ! unzip -tqq "$f" >/dev/null 2>&1; then
    echo "✗ Archive failed integrity check (truncated/corrupt): $f" >&2
    rm -f "$f"
    exit 1
  fi
  echo "  ✓ verified $(basename "$f")"
}

# ── Scholarly source archive first, and independent of the site build ─────
#
# The source archive comes from `git archive HEAD` and needs no build output at
# all, but it used to be sequenced BEHIND the obfuscated bundle — so a build
# that wedged in the obfuscator (observed: one attempt still "transforming"
# after ten minutes, the next finishing in fifteen seconds) blocked an archive
# that never depended on it. A citable source deposit should not be hostage to
# how the hosted site is minified.
#
# `--source-only` produces just that archive, for a Zenodo/archival cut.
if [ "$SOURCE_ONLY" = "1" ]; then
  echo "→ Source-only packaging: skipping the live/obfuscated build."
else
  echo "→ Building production (live) bundle…"
  npm run build:live
fi

if [ "$SOURCE_ONLY" != "1" ]; then
  # Guard against silent bundle growth before we ship the artifact.
  echo "→ Checking bundle budget…"
  node "$ROOT/scripts/check-bundle-budget.mjs"

  # ── Deploy archive: dist contents at the zip root, web-safe modes ────────
  echo "→ Normalising deploy modes (644 files / 755 dirs)…"
  cp -R dist "$TMP/deploy"
  find "$TMP/deploy" -type d -exec chmod 755 {} +
  find "$TMP/deploy" -type f -exec chmod 644 {} +

  DEPLOY="openlidarviewer-v${VERSION}-deploy-${TS}-root.zip"
  ( cd "$TMP/deploy" && zip -rqX "$TMP/$DEPLOY" . )
  cp "$TMP/$DEPLOY" "$OUT_DIR/$DEPLOY"
  verify_zip "$OUT_DIR/$DEPLOY"
fi

# ── Source archive: working tree minus build/vcs/deps, web-safe modes ──────
# The source archive extracts into ONE clean top-level folder
# (openlidarviewer-vX.Y.Z/) rather than spraying files into the CWD.
echo "→ Assembling source archive…"
SRC_PREFIX="openlidarviewer-v${VERSION}"
mkdir -p "$TMP/source/$SRC_PREFIX"
# Use git to enumerate tracked files when available; fall back to rsync.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git archive --format=tar --prefix="$SRC_PREFIX/" HEAD | tar -x -C "$TMP/source"
else
  # No git: enumerate with rsync. Exclude build/vcs/deps AND any generated
  # test/coverage output that a prior local run may have produced — otherwise a
  # source archive built after an E2E run would ship Playwright traces / coverage.
  rsync -a \
        --exclude node_modules --exclude dist --exclude .git \
        --exclude 'release' --exclude '*.log' \
        --exclude 'test-results' --exclude 'playwright-report' \
        --exclude 'coverage' --exclude '.tmp' --exclude '.cache' \
        --exclude '.stryker-tmp' --exclude 'stryker.log' \
        --exclude '.nyc_output' --exclude '.vitest' \
        --exclude '.DS_Store' \
        ./ "$TMP/source/$SRC_PREFIX/"
fi
find "$TMP/source" -type d -exec chmod 755 {} +
find "$TMP/source" -type f -exec chmod 644 {} +

# ── Internal-material guard ────────────────────────────────────────────────
# The archive must carry what the release IS, not the reasoning about whether
# to ship it. `.gitattributes` export-ignore is what actually excludes these,
# but export-ignore fails silently: add a file that matches no rule, or mistype
# a pattern, and it ships with nothing to say so. Three readiness reports for
# three different versions reached a published archive that way.
#
# So this asserts the OUTCOME over the assembled tree rather than trusting the
# rules. A new internal document is caught the first time it is packaged.
INTERNAL_PATTERNS='READINESS_REPORT|/_audit/|-plan\.md$|HANDOFF|ROADMAP-INTERNAL|_PRIVATE|GITHUB-PUBLISH-CHECKLIST'
LEAKED="$(cd "$TMP/source" && find . -type f | sed 's|^\./||' | grep -E "$INTERNAL_PATTERNS" || true)"
if [ -n "$LEAKED" ]; then
  echo "✗ internal material in the source archive:" >&2
  echo "$LEAKED" | sed 's/^/    /' >&2
  echo "  Add an export-ignore rule in .gitattributes, or move the file under docs/_audit/." >&2
  exit 1
fi

# Superseded per-release reports: the archive should not accumulate evidence
# documents for versions this is not. Checked by comparing against the version
# being packaged rather than by listing old ones, so it stays true next release.
STALE="$(cd "$TMP/source" && ls 2>/dev/null \
  | grep -E '^(VALIDATION_REPORT|REPRODUCIBILITY)_v' \
  | grep -v -- "_v${VERSION}\.md$" \
  | grep -v '^VALIDATION_REPORT_v0\.5\.9\.md$' || true)"
if [ -n "$STALE" ]; then
  echo "✗ superseded release reports in the source archive:" >&2
  echo "$STALE" | sed 's/^/    /' >&2
  echo "  Add an export-ignore rule, or if a report is inherited evidence the" >&2
  echo "  current release depends on, allow it explicitly in this check." >&2
  exit 1
fi
echo "  ✓ archive carries no internal or superseded release material"

SOURCE="openlidarviewer-v${VERSION}-source-${TS}.zip"
( cd "$TMP/source" && zip -rqX "$TMP/$SOURCE" . )
cp "$TMP/$SOURCE" "$OUT_DIR/$SOURCE"
verify_zip "$OUT_DIR/$SOURCE"

# ── Release provenance: checksums + a frozen manifest tying tag↔zip↔hash ────
# So a reviewer can verify integrity, and the release record pins exactly which
# commit + environment produced these artifacts.
echo "→ Writing checksums + release manifest…"
# Tri-state git provenance: "no git" is NOT the same as "dirty". A source-archive
# build (no .git) reports gitAvailable:false with null commit/dirty, rather than
# falsely claiming a dirty working tree.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_AVAILABLE=true
  COMMIT="\"$(git rev-parse HEAD)\""
  # --untracked-files=all, because `git diff` sees only TRACKED changes. The
  # deploy bundle is built from the working tree while the source archive comes
  # from `git archive HEAD`, so an untracked file could ship in the deployment,
  # be absent from the scholarly source, and still report dirtyWorkingTree:false.
  if [ -z "$(git status --porcelain --untracked-files=all 2>/dev/null)" ]; then DIRTY=false; else DIRTY=true; fi
  SOURCE_KIND="git-checkout"
else
  GIT_AVAILABLE=false
  COMMIT=null
  DIRTY=null
  SOURCE_KIND="source-archive"
fi
# ── Release-integrity gate ────────────────────────────────────────────────
#
# A published archive makes three claims a reader cannot check for themselves:
# that it was built from a clean tree, that the tests described in its evidence
# describe THIS code, and that the commit named is the one tagged. Each was
# previously left to whoever ran the command.
#
# Enforced only when OLV_RELEASE_GATE=1 — a development cut should not need a
# tag — so the strict path is the one deliberately taken for a real release.
if [ "${OLV_RELEASE_GATE:-0}" = "1" ]; then
  fail=0
  if [ "$DIRTY" != "false" ]; then
    echo "✗ release gate: working tree is not clean (tracked or untracked changes)." >&2
    fail=1
  fi
  EV="$ROOT/docs/validation/test-evidence.json"
  if [ ! -f "$EV" ]; then
    echo "✗ release gate: $EV is missing; run npm run evidence." >&2
    fail=1
  else
    EV_COMMIT="$(node -e "process.stdout.write(require('$EV').commit||'')" 2>/dev/null || echo '')"
    HEAD_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo '')"
    # Exact equality is impossible by construction: evidence is collected FROM
    # a commit, and committing the evidence file necessarily moves HEAD past
    # it. What must hold is that nothing which could change a test result
    # changed in between — so the diff is allowed to contain the evidence file
    # and the documents that quote it, and nothing else.
    if [ "$EV_COMMIT" != "$HEAD_COMMIT" ]; then
      DRIFT="$(git diff --name-only "$EV_COMMIT" "$HEAD_COMMIT" 2>/dev/null \
        | grep -vE '^(docs/validation/test-evidence\.json|(REPRODUCIBILITY|VALIDATION_REPORT|READINESS_REPORT|KNOWN_LIMITATIONS)_v[0-9].*\.md)$' || true)"
      if [ -n "$DRIFT" ]; then
        echo "✗ release gate: code changed after the evidence was collected (${EV_COMMIT:0:7} → ${HEAD_COMMIT:0:7}):" >&2
        echo "$DRIFT" | sed 's/^/    /' >&2
        echo "  The published figures would describe different code than the archive. Re-run npm run evidence." >&2
        fail=1
      fi
    fi
  fi
  if ! git describe --exact-match --tags HEAD >/dev/null 2>&1; then
    echo "✗ release gate: HEAD is not tagged. Tag the release commit before packaging." >&2
    fail=1
  fi
  [ "$fail" = "0" ] || { echo "Release gate failed. Unset OLV_RELEASE_GATE for a development cut." >&2; exit 1; }
  echo "→ Release gate: clean tree, evidence matches HEAD, HEAD is tagged."
fi

NODE_V="$(node -v 2>/dev/null || echo unknown)"
(
  cd "$OUT_DIR"
  SOURCE_SHA="$(shasum -a 256 "$SOURCE" | cut -d' ' -f1)"
  if [ "$SOURCE_ONLY" = "1" ]; then
    # A source-only cut states plainly that no deploy artifact exists, rather
    # than leaving an empty field a reader could mistake for one.
    shasum -a 256 "$SOURCE" > SHA256SUMS
    DEPLOY_ENTRY='null'
  else
    shasum -a 256 "$DEPLOY" "$SOURCE" > SHA256SUMS
    DEPLOY_SHA="$(shasum -a 256 "$DEPLOY" | cut -d' ' -f1)"
    DEPLOY_ENTRY="{ \"file\": \"${DEPLOY}\", \"sha256\": \"${DEPLOY_SHA}\" }"
  fi
  cat > "release-manifest-v${VERSION}.json" <<JSON
{
  "project": "openlidarviewer",
  "version": "${VERSION}",
  "sourceKind": "${SOURCE_KIND}",
  "gitAvailable": ${GIT_AVAILABLE},
  "gitCommit": ${COMMIT},
  "dirtyWorkingTree": ${DIRTY},
  "nodeVersion": "${NODE_V}",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "packagedArtifacts": $([ "$SOURCE_ONLY" = "1" ] && echo '"source-only"' || echo '"deploy+source"'),
  "artifacts": {
    "deploy": ${DEPLOY_ENTRY},
    "source": { "file": "${SOURCE}", "sha256": "${SOURCE_SHA}" }
  }
}
JSON
)

echo
echo "✓ Packaged v${VERSION}:"
[ "$SOURCE_ONLY" = "1" ] || echo "    $OUT_DIR/$DEPLOY"
echo "    $OUT_DIR/$SOURCE"
echo "    $OUT_DIR/SHA256SUMS"
echo "    $OUT_DIR/release-manifest-v${VERSION}.json"
