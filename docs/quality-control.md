# Quality Control Checklist

This is the runbook the project uses to decide a release candidate is
ready to ship. It codifies the gates, the order they run in, and the
agentic skills applied at each one. Run the whole battery against
every release. A single red gate blocks the ship.

The whole battery completes in roughly **40 seconds** on a warm
checkout. There is no excuse to skip it.

---

## Quick Run — the full battery

Run from the repo root in one shot. The gates are ordered cheapest
first so the slowest one (build) only fires when everything else
is green.

```bash
# 1. Static analysis
npm run typecheck            # ~5 s   — tsc --noEmit, zero errors required
npm run lint:main-deferral   # <0.1 s — main.ts deferred-load discipline

# 2. Unit + integration tests
npm test                     # ~12 s  — full vitest run, 974+ tests must pass

# 3. Production build (also runs typecheck again)
npm run build                # ~7 s   — Vite build + chunk-emission guard

# 4. Smoke gate (when Playwright is configured)
npm run test:smoke           # ~10 s  — startup smoke spec, zero console errors

# 5. End-to-end full suite (MANDATORY before exporting a deployable)
npm run test:e2e             # ~90 s  — Playwright chromium, every .spec.ts
                             #          under tests/e2e/ — full user flows
                             #          (drop → render → measure → export →
                             #          stream → benchmark). MUST be green
                             #          before zipping a release.

# 6. Live-deploy build (only when shipping a deploy)
npm run build:live           # ~10 s  — runs the live source-transform plugin
```

Total wall-clock budget: **under three minutes** for the full
pre-deploy gate. The e2e suite is the long pole. If any single step
exceeds 2× its expected time, investigate before shipping.

---

## Gate 1 — Static analysis

| Tool | What it catches |
|---|---|
| `npm run typecheck` | Type errors, unused imports, dead `void`-typed bindings. Must report ZERO errors. |
| `npm run lint:main-deferral` | Top-level `viewer.*` dereferences in `src/main.ts` that would break startup. |
| `scripts/lint-main-deferral.mjs` (CI gate) | The same check, blocking. |

**Skills to apply on a red typecheck:**

- `/engineering:debug` to isolate the error path
- `/systematic-debugging` (Phase 1 — Root Cause Investigation) when
  the error is symptomatic of a deeper architectural issue

**Skills to apply on a red main-deferral lint:**

- Read the file the lint flagged. The remediation is always: wrap the
  top-level statement in `void viewerLoaded.then(() => { … })`. The
  lint message tells you which line.

---

## Gate 2 — Unit + integration tests

`npm test` runs the full Vitest suite — 92 test files, 1,177 passing
tests, 18 deliberately skipped contract tests. The skipped tests
pin the shape of the in-progress analysis seam; they are NOT
failures.

### Slow-sandbox workaround

The whole suite completes in ~15 seconds on a warm checkout. If you
are running in a constrained sandbox (Cowork, CodeSandbox idle, a
container with hard CPU caps) and hit a per-command timeout before
the run completes, the heaviest single test is `parseBuffer.test.ts`
(~820 ms — dominated by the first-time dynamic import of the LAZ
decoder chunk). To shed the heaviest LAS / LAZ decode tests without
losing coverage of the modules touched by this release, run:

```bash
npx vitest run --exclude tests/parseBuffer.test.ts \
               --exclude tests/streamingStress*.test.ts \
               --exclude tests/torture.test.ts
```

This trims roughly 1.2 s off the run while still exercising the v0.3.6
deltas (orbit feel, soft-clamp math, production-build smoke, PC STAC
client, share-state UTM round-trip, mobile UI). The excluded files
remain part of the full battery — re-run them in a non-constrained
environment before shipping.

A single-shot release-blocker check that runs only the v0.3.6 deltas:

```bash
npx vitest run tests/orbitFeel.test.ts tests/orbitCenter.test.ts \
               tests/orbitSmoke.test.ts tests/planetaryComputer.test.ts \
               tests/shareState.test.ts
```

Completes in under 1 second locally.

| Suite | Files | Tests | Typical time |
|---|---|---|---|
| Curated catalog + experimental scaffolding (curatedLocations + dormant geocode/3DEP) | 4 | ~65 | <1 s |
| Report engine (templates + composer + sanitiser) | 4 | 88 | ~2 s |
| Streaming + scheduler + benchmark | 8 | ~80 | ~1 s |
| EPT (detect / transport / hierarchy / decode) | 6 | 77 | ~1 s |
| COPC (decode / hierarchy / pickup) | ~12 | ~120 | ~1 s |
| Diagnostics (provenance, usage counters) | 2 | 35 | <1 s |
| All other (UI helpers, format sniffers, math) | ~49 | ~537 | ~6 s |

**Skills to apply on a red unit test:**

- `/systematic-debugging` for any test failure — the iron law is "no
  fixes without root cause investigation first."
- `/engineering:debug` to isolate the failing assertion.
- For a NEW test that's failing on first run, use
  `superpowers:test-driven-development` to confirm the test is
  exercising what it claims.

**When you've fixed a real bug, ALWAYS add a regression test that
would have caught it.** Every red gate in this session ended with a
new pinned test.

---

## Gate 3 — Performance discipline

The codebase ships several performance gates that run as part of the
unit suite — there is no separate "perf test" command because the
perf invariants are encoded in regular tests.

| Invariant | Pinned by |
|---|---|
| Streaming sample buffers cap at `SAMPLE_BUFFER_MAX` (600) | `tests/streamingBenchmark.test.ts` |
| Eviction-history map sweeps stale entries past 512 size | `tests/streamingBenchmark.test.ts` |
| Recent-N tick stats return the most recent samples after ring overflow | `tests/streamingBenchmark.test.ts` |
| 50-cycle Viewer-recreate doesn't accumulate listeners | `tests/torture.test.ts` |
| 100-cycle session round-trip doesn't grow memory | `tests/torture.test.ts` |
| Benchmark output discloses budget-capped loads as "X of Y (Z%)" | `tests/benchmark.test.ts` |

Run the perf-oriented subset in isolation when investigating a
specific regression:

```bash
npx vitest run tests/torture.test.ts tests/streamingBenchmark.test.ts \
               tests/benchmark.test.ts tests/streamingFade.test.ts \
               tests/streamingProfile.test.ts tests/tierAdaptation.test.ts
```

Typical: 6 files, 62 tests, ~1 second.

### Loading-time profile (manual)

For real load-time investigation, open the live site with
`?benchmark=1` and check the console for the structured benchmark
block. It prints:

- `time to first render` — the headline number
- `points rendered X of Y (Z%)` — discloses budget-capped loads
- per-stage breakdown: sniff / fileRead / transfer / parse / decode /
  gpuUpload / firstRender

For streaming sessions, the benchmark also reports `peakResidentPoints`,
`time to coarse stable`, `cacheHits / Misses / Evictions`, and
`thrash events`.

---

## Gate 4 — Production build

```bash
npm run build
```

The build:
1. Re-runs `tsc --noEmit` (double-gate against type drift)
2. Runs Vite with the `olv-chunk-emission-guard` plugin, which
   **fails the build** if any of the documented code-split chunks
   (Viewer, report, three.webgpu) ends up missing or merged into
   the shell.
3. Emits `dist/assets/index-*.js` (the initial shell) plus the
   lazy chunks.

### Shell-size budget

The first-paint shell must stay **under 200 KB pre-gzip**. Current:
~128 KB / ~41 KB gzip. Check after every change:

```bash
ls -la dist/assets/index-*.js
```

If a single change pushes the shell past 200 KB, **roll back and
investigate**. Most "shell creep" comes from accidentally importing a
heavy module through a barrel — see the v0.3.6 incident in
`src/ui/Inspector.ts` where importing `REPORT_TEMPLATES` from the
`'../report'` barrel pulled the whole pdf-lib chain into the shell.
The fix is always to import from the specific subpath.

### Lazy-chunk verification

After every build, verify the expected lazy chunks exist:

```bash
ls dist/assets/ | grep -E "Viewer|report|three\.webgpu|loadLas"
```

You should see:
- `Viewer-*.js` — three.js scene + render pipeline
- `report-*.js` — pdf-lib + report engine
- `three.webgpu-*.js` — three.js WebGPU backend
- `loadLas-*.js` — laz-perf static-LAS loader
- `copcWorker-*.js` — COPC decode worker

If ANY of these is missing, the chunk-emission guard already failed —
the build aborted. If they're all present, the lazy boundary held.

---

## Gate 5 — Smoke gate

`tests/e2e/smoke.spec.ts` loads `/` and `/?debug=1` against the
production build and asserts zero `pageerror` and zero
`console.error` events during the first 3 seconds.

```bash
npm run test:smoke
```

This catches startup regressions that pass unit tests but break the
real page. The v0.3.4 startup regression — top-level `viewer.*`
dereferences in `main.ts` that threw on first render — was the
inspiration for this gate.

---

## Gate 6 — End-to-end full suite

`tests/e2e/*.spec.ts` covers the actual user flows: drop a file, see
the cloud render, open the Scan Report, switch nav modes, run a
benchmark, stream a COPC, place a measurement, export a session.
These are the tests a user would notice failing.

```bash
npm run test:e2e
```

Run this **before exporting a deployable version, packaging zips, or
presenting a release candidate** — not just before merging. The full
suite covers the load → render → validate path no unit test can
exercise on its own. Each spec drops a real fixture file through a
synthesised `DataTransfer`, so the empty-state DOM, the drop handler,
the worker pipeline, and the renderer all run end-to-end.

Five spec files participate:

- `viewer.spec.ts` — empty state, drop-to-render, embed mode, nav
  modes, share-link round-trip, debug + benchmark overlays
- `measure.spec.ts` — measurement toolbar, kind picker, units toggle,
  session export
- `rendering.spec.ts` — Eye Dome Lighting, point-size mode,
  antialiasing chip
- `streaming.spec.ts` — COPC streaming chunk emission + (when the
  Autzen fixture is on disk) per-point inspection on a streaming node
- `smoke.spec.ts` — startup zero-error gate (also Gate 5)

The v0.3.6 release uncovered four regressions only this gate could
catch:

1. The `.olv-report-row` rows still exist after the load completes,
   but the `<details>` wrapping them is collapsed by default since the
   Inspector first-view-density pass — a test that asserts
   `.toBeVisible()` will fail under the new UX.
2. The benchmark overlay prints **`time to first render`**; a stale
   `time to render` assertion never matches.
3. The empty-state sample buttons (`Drone survey`, `Phone scan`)
   were removed in favour of a streaming-only demo card; text-based
   Playwright selectors timed out silently. The fix is to use
   `tests/e2e/helpers.ts::dropTinyPly(page)` instead.
4. Canvas-click paths under the WebGL 2 fallback (no WebGPU on
   headless Linux CI runners) need a denser-than-`tiny.ply` fixture or
   a programmatic measure-placement seam — otherwise the picker's 4°
   angular tolerance misses every centre-of-canvas click.

**Skills to apply when adding or fixing e2e tests:**

- `/generating-end-to-end-tests` — generate new specs for new user
  flows. **Apply whenever a release adds a user-visible feature**
  (a new tool, a new format, a new dialog, a new keyboard shortcut)
  so the regression is pinned before it ships.
- `/engineering:debug` — when a previously-green spec turns red,
  reproduce against the production build (`npm run preview` + the
  failing test in isolation) before changing the test or the code.

**Stability rules for new e2e specs:**

- Drop fixtures, do not click sample buttons. Empty-state copy
  changes every release; fixtures don't. Use `dropTinyPly(page)` /
  `dropTinyLas(page)` / `dropDenseGridPly(page)` from `helpers.ts`.
- Assert on count, not visibility, when the target lives inside a
  collapsible `<details>`. The Inspector collapses 8 sections by
  default; `expect.poll(() => page.locator(sel).count()).toBeGreaterThan(0)`
  is the durable contract.
- Match overlay text by stable substrings (`'first render'`, not
  `'time to first render'`) so a one-word copy change doesn't break
  the assertion.
- Mark UNTESTABLE-IN-CI flows with `test.fixme(...)` and a comment
  pointing at the unit-test coverage that takes its place. **Never
  delete a regression test silently.**

---

## Agentic skills — when to apply each

The session's debugging discipline relies on the following skills.
Each is invoked at a specific gate; do NOT skip them.

### `/engineering:code-review`

**Apply after every implementation change before integrating.** Six-
dimension scan — security, performance, correctness, maintainability,
test coverage, style. Returns a verdict (Approve / Request changes /
Needs discussion).

The skill caught a v0.3.6 release-blocker where every Scan
Acceptance PDF embedded a literal placeholder string — a roadmap
leak into customer-facing output.

### `/engineering:debug`

**Apply on every red gate.** Four-phase debug protocol: reproduce →
isolate → diagnose → fix. The iron law is "no fixes without root
cause investigation first."

The skill caught the latent USGS provider bug where TNM API string-
encoded bbox fields were silently dropped, and the EPT zstandard
dataset that paid the full hierarchy round-trip before failing
per-tile.

### `/systematic-debugging`

**Apply on architectural or multi-component issues.** Same four
phases as `/engineering:debug` but with explicit instrumentation at
each component boundary. Specifically catches issues where 3+ fixes
have failed and the architecture itself is wrong.

### `/layout-grid` + `/scientific-visualization`

**Apply to any visual output that ships.** Together they cover:

- 12-column print grid with documented gutters + margins
- Sentence case labels, units in parens
- Colorblind-safe palettes (Okabe-Ito) for categorical encoding
- Redundant encoding — never rely on colour alone for QA semantics
- Vector format (PDF/SVG) over raster
- Statistical rigor — error bars, n, significance markers

The skills together caught the Scan Acceptance pass/fail status
relying on red/green colour alone. The fix: add a redundant
**P** / **F** letter inside the status dot so the encoding survives
grayscale printing and colorblind viewing.

### `/verification-before-completion`

**Apply before ANY claim of success.** Evidence before assertions
always. Run the verification commands; confirm the output.

### `/generating-end-to-end-tests`

**Apply before presenting a deployable version or exporting an app
zip.** Generates Playwright specs for new or changed user flows so
the regression is pinned before the release leaves the workstation.
Use it whenever:

- A new user-visible feature lands (a tool, a format, a dialog, a
  shortcut) and no e2e spec covers it yet.
- An empty-state, drop-handler, or inspector contract changes shape
  and the existing specs reference the old DOM.
- A v0.X.Y CI run goes red on a spec written months ago and the
  spec's contract no longer matches the app.

The skill caught the four v0.3.6 e2e regressions described in
**Gate 6**: collapsed Scan-Report rows breaking visibility
assertions, the renamed benchmark `time to first render` line, the
removal of the empty-state sample buttons, and the
sparse-tiny-fixture canvas-click misses under the WebGL 2 fallback.
Each was a real user-facing regression masked by green unit tests.

---

## Validation skills — when to apply each

For any change that touches user-supplied or third-party data, apply
the matching validation skill.

### `data:validate-data`

**Apply when reviewing a data-quality claim before publishing.**
Methodology, accuracy, and bias checks. The skill caught that the
benchmark output was misleading about budget-capped loads because it
showed only the rendered point count, not the source count.

### `data:explore-data`

**Apply on every new data source connection.** Profile the data's
shape, null rates, distributions before depending on it. The skill
informed the USGS catalog defensive parsing where TNM Products
encodes bbox values inconsistently.

### `data:statistical-analysis`

**Apply when the Scan Acceptance template's cloud-sampled rows
land (future release).** GRADE evidence grading, distribution checks,
outlier detection for the density / void-map / NPS / RMSE metrics.

---

## Release wrap checklist

Before zipping a deploy or pushing to GitHub:

- [ ] All six gates above are green (incl. **Gate 6 — full e2e
      suite**; apply `/generating-end-to-end-tests` to pin any
      uncovered new flow before the export goes out)
- [ ] `CHANGELOG.md` has a v$VERSION entry with `### Added`,
      `### Improved`, `### Fixed`, `### Tests + verification`, and
      `### Documentation` sections
- [ ] `README.md` "What's in this release" lists every new
      user-visible feature
- [ ] Source-comment leak scan returns zero hits:
      ```bash
      grep -rEn "v0\.X\.Y|deferred to v" src/
      ```
- [ ] User-facing PDF / image output scanned for roadmap strings
- [ ] Build artifacts staged with `chmod 644` files / `chmod 755` dirs:
      ```bash
      find dist -type f -exec chmod 644 {} \;
      find dist -type d -exec chmod 755 {} \;
      ```
- [ ] Both archive types built and verified:
  - [ ] `dist.zip` (production deploy artifact, ~1.2 MB)
  - [ ] `src.zip` (publishable repo, ~4.5 MB, excludes
        `node_modules`, `dist`, `.git`, `coverage`, `*.log`, `.env*`,
        `*.key`, `*.pem`, `_*.mjs`, `verify-*.mjs`)
- [ ] Verify zip perms via `unzip -Z` — all files `-rw-r--r--`, all
      dirs `drwxr-xr-x`
- [ ] No secret-looking files in either zip:
      ```bash
      unzip -Z1 *.zip | grep -iE "\.(env|key|pem|p12)$|secret"
      ```

---

## Deliverable: approved deployable state

A release reaches **approved deployable state** when:

1. Every gate passes on a clean checkout — **including the full e2e
   suite (Gate 6)**, not just unit tests + smoke
2. Every documented chunk emits
3. Shell stays under 200 KB pre-gzip
4. Every customer-facing artifact (PDFs, exports, UI strings) has
   been scanned for roadmap leaks
5. Both archive types build cleanly with correct permissions
6. Any new user-visible feature in the release has at least one
   pinned e2e spec (apply `/generating-end-to-end-tests` if it
   doesn't)
7. The session's task list is fully closed

When all seven conditions hold, the release is shippable. The signoff
happens by tagging the commit and pushing both zips through the
release-publishing workflow.

If any condition is uncertain, the answer is **don't ship**.
Run the gate again. Investigate. Apply the relevant agentic skill.
Bring the gate to green or open a tracking issue for the gap before
shipping.
