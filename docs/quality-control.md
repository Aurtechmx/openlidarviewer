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

# 5. Live-deploy build (only when shipping a deploy)
npm run build:live           # ~10 s  — runs the live source-transform plugin
```

Total wall-clock budget: **under one minute** for the full pre-deploy
gate. If any single step exceeds 2× its expected time, investigate
before shipping.

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

`npm test` runs the full Vitest suite — 84 test files, 974 passing
tests, 18 deliberately skipped contract tests. The skipped tests
pin the shape of the in-progress analysis seam; they are NOT
failures.

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

## Agentic skills — when to apply each

The session's debugging discipline relies on the following skills.
Each is invoked at a specific gate; do NOT skip them.

### `/engineering:code-review`

**Apply after every implementation change before integrating.** Six-
dimension scan — security, performance, correctness, maintainability,
test coverage, style. Returns a verdict (Approve / Request changes /
Needs discussion).

The skill caught the v0.3.6 release-blocker where every Scan
Acceptance PDF embedded the literal string "deferred to v0.3.7 /
v0.4.0" — a roadmap leak into customer-facing output.

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

### `/anthropic-skills:verification-before-completion`

**Apply before ANY claim of success.** Evidence before assertions
always. Run the verification commands; confirm the output.

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

- [ ] All five gates above are green
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

1. Every gate passes on a clean checkout
2. Every documented chunk emits
3. Shell stays under 200 KB pre-gzip
4. Every customer-facing artifact (PDFs, exports, UI strings) has
   been scanned for roadmap leaks
5. Both archive types build cleanly with correct permissions
6. The session's task list is fully closed

When all six conditions hold, the release is shippable. The signoff
happens by tagging the commit and pushing both zips through the
release-publishing workflow.

If any condition is uncertain, the answer is **don't ship**.
Run the gate again. Investigate. Apply the relevant agentic skill.
Bring the gate to green or open a tracking issue for the gap before
shipping.
