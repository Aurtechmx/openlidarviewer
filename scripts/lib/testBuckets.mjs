/**
 * testBuckets.mjs — which bucket a test file runs in.
 *
 * The rule lived inside `scripts/test-bucket.mjs`, whose module body is a CLI:
 * importing it ran the command and exited the process. So a test that needed
 * the classification asked for it by SPAWNING that script with `--list` and
 * parsing stdout, and the answer then depended on the environment the spawn ran
 * in. A CI shard read back a list naming no terrain file, and the caller
 * concluded that no bucket claimed a record's producer.
 *
 * The rule lives here so both the command and a test can import it. A function
 * cannot disagree with itself the way two readings of a subprocess can.
 *
 * Pure: no IO, no process, no exit.
 */

// Heavy decode / large-data / integration — the genuinely slow files. LAS/LAZ
// and buffer/worker decode tests spin up a WASM decoder and are the ones that
// get starved (and time out) under the parallel `unit` bucket, so they belong
// here where the runner caps parallelism and raises the timeout.
// Two rules, not one pattern. The first list matches a file name's opening
// word, the second matches anywhere in it. Written as a single regex the `^`
// bound to the first alternative only, which reads as a mistake whether or not
// it is one, and both scanners flag it as one.
const SLOW_PREFIX = /^(?:torture|benchmark|parse|loadLas|loadLaz|laszip)/i;
const SLOW_ANYWHERE =
  /integration|streaming|copc|ept|laz|octree|voxelDownsample|convertRoundTrip|convertBatch|moduleApi|preload|wasm|decode|packaging/i;
const isSlow = (name) => SLOW_PREFIX.test(name) || SLOW_ANYWHERE.test(name);
// The terrain-analysis pipeline.
const TERRAIN = /^(analyse|analysis|contour|cell|ground|dem|hillshade|slope|calibrat|confidence|coverage|crs|datum|evidence|interval|civilProfile|profile|surface|quality|terrain|raster|gpuDeriv|scatter|aspect|canopy|dsm|dtm|seam|provenance|metricVersion|score|assessment|readiness|whyNot|recommend)/i;
// The interface layer.
const UI = /(panel|mobile|dock|toolbar|nav|button|sheet|inspector|theme|onboarding|tour|command|chip|legend|banner|overlayUi|visualsStudio|measureIcons|measureController|measureRail|fullscreen|standardViews|cameraPresets|annotation|export(Panel|Layout|Ui)|classScope|classVisibility|classLegend|colorMode|colorChip|colorProvenance)/i;
// The export / report / measurement-document layer — carved out of the old
// `unit` catch-all so neither bucket grows large enough to stall a single
// Vitest process in CI. Checked AFTER UI, so an export *panel* stays in `ui`.
const EXPORT = /(^export|exporter|^measurement|^report|^verify|^audit|^stockpile|^sessionFindings|^kml|^gzip|^zip|^scanReport|^spaceReport|^floorPlanExport|^download)/i;

/**
 * Bucket a single test-file name. `unit` is the catch-all.
 *
 * Exported so a test can ask the question directly. It used to be asked by
 * spawning this script with `--list` and parsing stdout, which made the answer
 * depend on the environment the spawn ran in: a CI shard read back a list that
 * did not name the terrain files, and the caller concluded no bucket claimed
 * them. Importing the rule cannot disagree with the rule.
 */
export function bucketOf(name) {
  // A nested directory routes explicitly, before any regex gets a look in.
  const slash = name.indexOf('/');
  if (slash > 0) {
    const routed = NESTED_TEST_DIRS[name.slice(0, slash)];
    if (routed) return routed;
  }
  if (isSlow(name)) return 'slow';
  if (TERRAIN.test(name)) return 'terrain';
  if (UI.test(name)) return 'ui';
  if (EXPORT.test(name)) return 'export';
  return 'unit';
}

export const BUCKETS = ['unit', 'export', 'terrain', 'ui', 'slow'];

// Test subdirectories that hold UNIT tests, and the bucket each one routes to.
// tests/e2e/ is deliberately absent — those are Playwright specs. Two reasons
// this map exists rather than letting the regexes above classify a nested path:
//   - without the enumeration, a file added under tests/benchmark/ would belong
//     to no bucket at all, so the release gate would run every bucket green
//     while never executing it;
//   - without the explicit bucket, `tests/benchmark/*` matched `slow` only
//     because SLOW_PREFIX starts with `benchmark` (written for the old
//     top-level benchmark.test.ts). Those files run in ~50 ms and belong in
//     `unit`; routing them by accident would also change silently the next time
//     a bucket regex is edited.
export const NESTED_TEST_DIRS = { benchmark: 'unit' };

function allTestFiles() {
  const top = readdirSync(TESTS_DIR).filter((f) => /\.(test|spec)\.ts$/.test(f));
  const nested = Object.keys(NESTED_TEST_DIRS).flatMap((dir) => {
    let entries;
    try {
      entries = readdirSync(join(TESTS_DIR, dir));
    } catch {
      return []; // the directory may legitimately not exist yet
    }
    return entries.filter((f) => /\.(test|spec)\.ts$/.test(f)).map((f) => `${dir}/${f}`);
  });
  return [...top, ...nested];
}

