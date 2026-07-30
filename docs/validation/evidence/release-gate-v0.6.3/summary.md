# Release-validation run at 300cfbf

Status: **all five gates exited 0**

Every command below ran in a clean clone of the repository checked out at
300cfbf82a65aaa9f352c4d782d571ef02fee4cd, in the order shown, on 2026-07-30.
Each exit code is the real status of the command it belongs to, written to a
file by the runner before anything else read the output, so no pipe stands
between the command and its recorded result. Nothing was retried. Nothing was
fixed mid-run, because a fix would make this record describe a tree that did not
exist when the run started.

## What ran

| # | Command | Exit | Duration | Counts |
| --- | --- | --- | --- | --- |
| 1 | `npm ci --no-audit --no-fund` | 0 | 5 s | 523 packages added |
| 2 | `npx tsc --noEmit` | 0 | 2 s | no output |
| 3 | `npm run -s test:release` | 0 | 199 s | 7,242 passed, 24 skipped |
| 4 | `npx playwright test tests/e2e/ --project=deterministic` | 0 | 72 s | 161 passed, 4 skipped, 0 failed, 0 flaky |
| 5 | `npm run -s build` | 0 | 2 s | dist emitted |

Wall clock for the five gates: 280 s. Durations are whole seconds from the
runner's own clock and include process startup.

## Environment

| Field | Value |
| --- | --- |
| Commit | 300cfbf82a65aaa9f352c4d782d571ef02fee4cd |
| Version in package.json | 0.6.3 |
| Node | v26.0.0 |
| npm | 11.12.1 |
| OS | macOS 26.5.2, build 25F84 |
| Kernel | Darwin 25.5.0 |
| Architecture | arm64 |
| Python | 3.11.15 (the lint that checks the declared version runs it) |
| Playwright browsers | chromium-1234 and chromium_headless_shell-1234, from the machine-level browser cache |
| package-lock.json sha256 | e35dbf8ed968bab60a86b8c01a584f9e04bd5beaabc63ff0120e0b4aaef1f2f5 |
| Date | 2026-07-30 UTC |

`engines.node` is `>=22` and this run used 26, with a lockfile hash matching the
one recorded in `docs/validation/test-evidence.json`, so the dependency tree is
the same one the earlier figures were measured against.

## Vitest, by bucket

Read from the `GATE TALLY` lines the bucket runner prints, not from the human
summary.

| Bucket | Passed | Skipped | Vitest processes |
| --- | --- | --- | --- |
| unit | 4,282 | 24 | 3 |
| export | 623 | 0 | 1 |
| terrain | 1,339 | 0 | 2 |
| ui | 453 | 0 | 1 |
| slow | 545 | 0 | 2 |
| total | 7,242 | 24 | 9 |

## Bundle budget, live build

| Chunk | Size | Ceiling |
| --- | --- | --- |
| index | 667 KiB | 720 KiB |
| vendor-three-webgpu | 982 KiB | 1100 KiB |
| vendor-pdf | 410 KiB | 512 KiB |

## Every skipped test

A skipped test is not a passed test. All 28 are listed with the condition that
skipped them. Twenty-three are vitest skips, one is a vitest todo marker, and
four are Playwright skips.

### Missing local fixture, not in the repository (8)

| Test | Why |
| --- | --- |
| `tests/e57.test.ts`: parseE57, bunnyFloat.e57 fixture (local only): finds the single "bunny" scan | `tests/bunnyFloat.e57` is not redistributed and is not on this machine. `describe.skipIf(!hasBunny)` |
| `tests/e57.test.ts`: same block: reads the prototype, three Float coordinates plus an Integer flag | same |
| `tests/e57.test.ts`: same block: decodes the first Float coordinates correctly | same |
| `tests/e57.test.ts`: same block: decodes the bit-packed invalid-state column as 0/1 values | same |
| `tests/e2e/streaming.spec.ts`: autzen COPC fixture: opens a real COPC file and streams it progressively | the autzen COPC file is not on disk |
| `tests/e2e/streaming.spec.ts`: autzen COPC fixture: inspects a per-point readout on a streaming COPC node | same |
| `tests/e2e/streaming.spec.ts`: autzen COPC fixture: closes a streaming COPC scan back to the empty state | same |
| `tests/e2e/streamingCaveat.spec.ts`: streaming-resident caveat caption: placing a Profile measurement on a streaming cloud surfaces the resident-only caveat | same |

These eight are the only tests in the battery whose execution depends on a file
a stranger's clone does not have, and every one of them names that dependency in
its own title or describe block.

### Ran elsewhere in the same gate, skipped in this invocation (12)

`tests/chunkIsolation.test.ts` and `tests/orbitSmoke.test.ts` assert against a
fresh `dist/` and gate themselves on `BUILD_CONTRACT=1`. The gate runs them with
that variable set, in `npm run test:build`, before the buckets; when the unit
bucket picks the same files up again the variable is absent and they skip. So
these assertions did execute in gate 3, and skipped on a second encounter.

| Test | Why |
| --- | --- |
| `tests/chunkIsolation.test.ts`: every required chunk is emitted by name | `BUILD_CONTRACT` unset for this invocation |
| `tests/chunkIsolation.test.ts`: vendor-three-webgpu is the only chunk over the 500 KB warning threshold | same |
| `tests/chunkIsolation.test.ts`: the startup shell does not inline pdf-lib, laz-perf, WebGPU renderer, or TSL runtime | same |
| `tests/chunkIsolation.test.ts`: every app-owned chunk except vendor-three-webgpu is under the warning threshold | same |
| `tests/orbitSmoke.test.ts`: Viewer chunk references three.js OrbitControls | same |
| `tests/orbitSmoke.test.ts`: damping factor 0.07 is inlined in the shipped chunk | same |
| `tests/orbitSmoke.test.ts`: rotate speed 0.95 is inlined in the shipped chunk | same |
| `tests/orbitSmoke.test.ts`: OrbitControls start + end event listeners are wired (settle window) | same |
| `tests/orbitSmoke.test.ts`: public orbit-pivot APIs survive tree-shaking | same |
| `tests/orbitSmoke.test.ts`: soft-clamp + streaming-refinement lerp factors ship in the chunk | same |
| `tests/orbitSmoke.test.ts`: settle window 280 ms ships in the chunk | same |
| `tests/orbitSmoke.test.ts`: `dist/` not present, run `npm run build` first | a todo marker, not a test. It is the placeholder that reports why the block is inert |

### Opt-in benchmark entry points (8)

Each is a benchmark suite the release gate deliberately does not run, guarded by
`test.runIf` on its own environment variable. The companion assertion that the
suite stays inert without that variable did run and did pass in every case.

| Test | Why |
| --- | --- |
| `tests/benchmark/comparePlatforms.test.ts`: compare the recorded platform legs and publish the result | `BENCHMARK_COMPARE=1` not set |
| `tests/benchmark/runBackends.test.ts`: record the CPU reference leg and whatever backend this host could actually run | `BENCHMARK_BACKENDS=1` not set |
| `tests/benchmark/forcedGc.test.ts`: global.gc is a function in this worker when forced GC was requested | forced GC not requested |
| `tests/benchmark/runTier.test.ts`: runs the requested tier and writes it out | `BENCHMARK_TIER`, `BENCHMARK_TIER_OUT` and `BENCHMARK_TIER_CONFIG` not set |
| `tests/benchmark/runSuites.test.ts`: run the requested suites and write the result tree | `BENCHMARK_SUITES` named no suite |
| `tests/benchmark/runPortable.test.ts`: record this platform as a leg of the cross-platform comparison | `BENCHMARK_PORTABLE=1` not set |
| `tests/benchmark/verifyResults.test.ts`: the published result tree is internally consistent | `BENCHMARK_VERIFY=1` not set |
| `tests/benchmark/verifyResults.test.ts`: every archived result set is internally consistent | `BENCHMARK_VERIFY_ARCHIVES=1` not set |

## What the clean clone showed

`git status --porcelain` in the clone after all five gates printed nothing. With
`--ignored` it lists seven paths, every one of them an output the run produced
and the repository already ignores: `benchmark-results/`, `dist/`,
`node_modules/`, `release/`, `test-results/`,
`validation/reachability/ledger/` and `validation/reachability/summary.json`.

Nothing in the battery needed a file that was untracked, ignored, or present
only on a developer machine, with the eight fixture-gated tests above as the
stated exception. Those do not fail without their fixture; they skip, and they
say so.

One reachability path is recorded as unwitnessed: `terrain-derivatives-device`.
Node has no GPU adapter, so the device path is not reached from a Node run. The
gate reports it as unwitnessed rather than counting it, which is the honest
column.

## Two figures that differ from the tracked evidence file

Recorded here because they differ, not because either is wrong.

`docs/validation/test-evidence.json` reports 6,787 passed and 24 skipped, and a
live entry chunk of 664 KiB. This run reports 7,242 passed, 24 skipped, and 667
KiB. That file states its own scope: `releaseChannel` is `development`,
`releaseAuthoritative` is `false` and `tag` is `null`, so it does not claim to
be the release figure. The authoritative counts come from the gate run at the
tagged commit, which does not exist yet.

The commit that file names, 7acd4708adadf8be50d9542f6c17148d0acc1c8b, is not an
ancestor of 300cfbf. It is a commit from a working branch, so a reader cannot
reach it by walking back from the tree under test. Anything quoting 6,787 as the
v0.6.3 test count is quoting a different tree.

## Scope

One machine, one architecture, one Node version, one commit, one run.

What it establishes is that the battery passes from a clean checkout on
darwin-arm64 with Node 26, and nothing beyond that: not other platforms, not
other Node versions, and not the tagged commit, which does not exist yet.
