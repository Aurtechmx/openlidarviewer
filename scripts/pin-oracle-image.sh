#!/usr/bin/env bash
# pin-oracle-image.sh — build the pinned oracle image, run the slope protocol
# inside it, and record the image digest in validation/oracles/oracle-pins.json.
#
# Every committed reference run records `containerPinning: "not-executed"`,
# because none was produced inside the image. This is the procedure that
# changes that for one protocol, and it is written down rather than typed
# because the digest it records has to be the digest of the image the run
# actually used, and the run has to be the one the record names.
#
# What it does, in order:
#   1. refuses to run without a reachable Docker daemon, and without a clean
#      working tree (the record it writes must describe a committed tree);
#   2. builds validation/oracles/Dockerfile for linux/amd64 (under emulation on
#      an arm64 host) as olv-oracles:1, with BUILT_AT set to today's date so the
#      image states when it was built without reading a clock;
#   3. reads the image's content digest (`docker image inspect {{.Id}}`);
#   4. extracts `git archive HEAD` into release/oracle-pin/<date>/tree and mounts
#      THAT at /repo, so the slope protocol writes its rasters and
#      reference-runs.json into a scratch copy and never over the committed
#      references (the image does not reproduce them byte for byte; see
#      validation/oracles/README.md);
#   5. runs `node scripts/run-gdaldem-reference.mjs` in the container, which
#      covers the slope protocol PROTO-RASTER-HORN-GDAL-ANALYTIC-DEM (gdaldem
#      slope, Horn) together with aspect, hillshade and TPI, writing the
#      environment record first through the image entrypoint;
#   6. copies the environment record and the reference-runs.json into
#      validation/oracles/runs/<date>-slope-reference-runs.json, and compares
#      the slope raster the image produced with the committed one, printing the
#      number of differing cells and the largest absolute difference;
#   7. writes containerPinning in validation/oracles/oracle-pins.json:
#        status "recorded", imageDigest, imageTag, recordedOn, runReference;
#   8. runs `npm run verify:oracle-versions`, which refuses a recorded digest
#      whose run reference does not exist or did not run inside the image.
#
# Disk: the conda lock is 284 MB of downloads (oracle-pins.json
# condaDownloadBytes), which unpacks to roughly 1 GB of installed packages; with
# the base image and the build layers expect about 1.5 GB for the image and up
# to 2 GB in total during the build. The slope run itself writes a few MB.
# Time: the build is network-bound and takes minutes; the run takes seconds.
#
# After it finishes, review the diff and commit:
#   validation/oracles/oracle-pins.json
#   validation/oracles/runs/<date>-slope-reference-runs.json
# Nothing under tests/fixtures/reference or validation/cross-implementation is
# modified: adopting the image for a leg means re-running that leg's reference
# and updating the digest its record carries, which is a separate decision.
#
# Usage:
#   bash scripts/pin-oracle-image.sh            build, run, record
#   OLV_ORACLE_IMAGE_TAG=olv-oracles:1 bash scripts/pin-oracle-image.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
export GIT_CEILING_DIRECTORIES="$(cd "$ROOT/.." && pwd -P)${GIT_CEILING_DIRECTORIES:+:$GIT_CEILING_DIRECTORIES}"

TAG="${OLV_ORACLE_IMAGE_TAG:-olv-oracles:1}"
TODAY="$(date -u +%F)"
SCRATCH="$ROOT/release/oracle-pin/$TODAY"
RUNS_DIR="$ROOT/validation/oracles/runs"
RUN_RECORD_REL="validation/oracles/runs/${TODAY}-slope-reference-runs.json"
PINS="$ROOT/validation/oracles/oracle-pins.json"

if ! docker info >/dev/null 2>&1; then
  echo "pin-oracle-image: the Docker daemon is not reachable; start it and run this again." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "pin-oracle-image: the working tree is not clean; the record must describe a committed tree." >&2
  git status --porcelain >&2
  exit 1
fi
COMMIT="$(git rev-parse HEAD)"

echo "── 1/5 build ${TAG} (linux/amd64)"
docker build --platform=linux/amd64 --build-arg "BUILT_AT=${TODAY}" -t "${TAG}" validation/oracles

IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "${TAG}")"
echo "image digest ${IMAGE_DIGEST}"

echo "── 2/5 extract the committed tree for the container to write into"
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/tree"
git archive --format=tar HEAD | tar -x -C "$SCRATCH/tree"

echo "── 3/5 run the slope protocol inside the image"
docker run --rm --platform=linux/amd64 \
  -v "$SCRATCH/tree":/repo -w /repo \
  -e OLV_ORACLE_ENV_OUT=/repo/oracle-environment.json \
  "${TAG}" node scripts/run-gdaldem-reference.mjs

echo "── 4/5 record the run"
mkdir -p "$RUNS_DIR"
node - "$SCRATCH/tree" "$ROOT/$RUN_RECORD_REL" "$IMAGE_DIGEST" "$TAG" "$COMMIT" "$TODAY" <<'EOF'
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const [tree, out, imageDigest, imageTag, commit, recordedOn] = process.argv.slice(2);
// The recorder wraps its fields as { generatedBy, environment }.
const environment = JSON.parse(readFileSync(resolve(tree, 'oracle-environment.json'), 'utf8')).environment;
const runs = JSON.parse(readFileSync(resolve(tree, 'validation/cross-implementation/raster-matrix/reference-runs.json'), 'utf8'));
if (environment.containerPinning !== 'executed') {
  console.error(`the environment record says containerPinning ${environment.containerPinning}; the run was not inside the image`);
  process.exit(1);
}
const record = {
  schemaVersion: 1,
  purpose: 'The slope protocol PROTO-RASTER-HORN-GDAL-ANALYTIC-DEM run inside the pinned oracle image, recorded by scripts/pin-oracle-image.sh. The rasters it produced were written to a scratch copy of the tree and are not committed; this record is what oracle-pins.json containerPinning.runReference names.',
  protocolId: 'PROTO-RASTER-HORN-GDAL-ANALYTIC-DEM',
  recordedOn,
  sourceCommit: commit,
  imageTag,
  imageDigest,
  environment,
  referenceRuns: runs,
};
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
console.log(`wrote ${out}`);
EOF

echo "── compare the image's slope raster with the committed one"
node - "$SCRATCH/tree" "$ROOT" <<'EOF'
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const [tree, root] = process.argv.slice(2);
const rel = 'validation/cross-implementation/raster-matrix/gdal';
const dir = resolve(tree, rel);
const grid = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^[a-z_]+\s/i.test(l) && l.trim() !== '').join(' ').trim().split(/\s+/).map(Number);
const { readdirSync } = require('node:fs');
for (const name of readdirSync(dir).filter((n) => /slope/.test(n) && n.endsWith('.asc'))) {
  const committed = resolve(root, rel, name);
  if (!existsSync(committed)) { console.log(`${name}: no committed counterpart`); continue; }
  const a = grid(resolve(dir, name));
  const b = grid(committed);
  let differing = 0; let maxAbs = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    differing++; maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i]));
  }
  console.log(`${name}: ${a.length} cells, ${differing} differ from the committed raster, max abs difference ${maxAbs}`);
}
EOF

echo "── 5/5 write containerPinning into oracle-pins.json"
node - "$PINS" "$IMAGE_DIGEST" "$TAG" "$RUN_RECORD_REL" "$TODAY" <<'EOF'
const { readFileSync, writeFileSync } = require('node:fs');
const [pinsPath, imageDigest, imageTag, runReference, recordedOn] = process.argv.slice(2);
const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
pins.containerPinning = {
  ...pins.containerPinning,
  status: 'recorded',
  imageDigest,
  imageTag,
  recordedOn,
  runReference,
};
writeFileSync(pinsPath, `${JSON.stringify(pins, null, 2)}\n`);
console.log(`oracle-pins.json containerPinning: recorded ${imageDigest} (${runReference})`);
EOF

npm run verify:oracle-versions
echo "Review and commit: validation/oracles/oracle-pins.json and ${RUN_RECORD_REL}."
