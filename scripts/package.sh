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
#   scripts/package.sh [OUT_DIR]
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

echo "→ Building production (live) bundle…"
npm run build:live

# Guard against silent bundle growth before we ship the artifact.
echo "→ Checking bundle budget…"
node "$ROOT/scripts/check-bundle-budget.mjs"

# ── Deploy archive: dist contents at the zip root, web-safe modes ──────────
echo "→ Normalising deploy modes (644 files / 755 dirs)…"
cp -R dist "$TMP/deploy"
find "$TMP/deploy" -type d -exec chmod 755 {} +
find "$TMP/deploy" -type f -exec chmod 644 {} +

DEPLOY="openlidarviewer-v${VERSION}-deploy-${TS}-root.zip"
( cd "$TMP/deploy" && zip -rqX "$TMP/$DEPLOY" . )
cp "$TMP/$DEPLOY" "$OUT_DIR/$DEPLOY"
verify_zip "$OUT_DIR/$DEPLOY"

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
  if git diff --quiet 2>/dev/null; then DIRTY=false; else DIRTY=true; fi
  SOURCE_KIND="git-checkout"
else
  GIT_AVAILABLE=false
  COMMIT=null
  DIRTY=null
  SOURCE_KIND="source-archive"
fi
NODE_V="$(node -v 2>/dev/null || echo unknown)"
(
  cd "$OUT_DIR"
  shasum -a 256 "$DEPLOY" "$SOURCE" > SHA256SUMS
  DEPLOY_SHA="$(shasum -a 256 "$DEPLOY" | cut -d' ' -f1)"
  SOURCE_SHA="$(shasum -a 256 "$SOURCE" | cut -d' ' -f1)"
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
  "artifacts": {
    "deploy": { "file": "${DEPLOY}", "sha256": "${DEPLOY_SHA}" },
    "source": { "file": "${SOURCE}", "sha256": "${SOURCE_SHA}" }
  }
}
JSON
)

echo
echo "✓ Packaged v${VERSION}:"
echo "    $OUT_DIR/$DEPLOY"
echo "    $OUT_DIR/$SOURCE"
echo "    $OUT_DIR/SHA256SUMS"
echo "    $OUT_DIR/release-manifest-v${VERSION}.json"
