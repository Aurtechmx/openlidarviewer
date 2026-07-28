# OpenLiDARViewer v0.5.3

A hardening patch on the v0.5 line: two survey epochs can now be aligned before
they are compared, the viewer installs and runs offline, and the evaluation
behind the uncertainty claims reproduces with one command — on top of seventeen
correctness fixes from two audit passes. Still browser-native and local-first.
Nothing is uploaded.

## Align two epochs before comparing them

The planar alignment core that shipped in v0.5.2 is now wired into change
detection. Before two epochs are compared, the after cloud is coarse-registered
onto the before cloud — yaw and horizontal shift only, because a real vertical
change is the signal and must be preserved — and the fit is reported: the
shift, the yaw, and the RMS residual appear in the compare result. A fit whose
residual exceeds the gate is refused and the clouds are compared as-is, so
alignment never invents a shift it cannot stand behind. The alignment reports
in true metres on any projected CRS, applies in double precision so a
georeferenced survey keeps its accuracy, and refuses geographic (degree) frames
outright rather than fitting in a space where the numbers mean nothing.

## Install it, run it offline

The viewer is now an installable PWA. A service worker caches the app shell, so
after the first visit it opens and runs with no network, and it can be
installed as a standalone app. The worker is local-first by construction: it
caches only the same-origin app shell and never touches a dataset request, so
opening a remote scan still goes straight to its source and nothing you load is
stored.

## A compass you can keep

The on-canvas compass from v0.5.2, previously reachable only through the
`?viewcube=1` URL flag, can now be toggled from the command palette ("Toggle
compass"), and the choice persists. It stays off by default so it never
overlaps the panel columns; `?viewcube=1` and `?viewcube=0` still force it.

## Reproduce the evaluation

`npm run repro` runs the real analysis cores over deterministic synthetic
fixtures with analytic ground truth and writes a metrics table plus reliability
figures: the epoch-registration vertical-bias result (horizontal-only
registration preserves a uniform vertical change while a full-3D fit absorbs
it), planar-alignment recovery, stockpile ±-band coverage against the nominal
0.68, and report-digest determinism. The coverage and bias checks also run as
unit tests in CI, so the uncertainty claims are tested rather than asserted.
`REVIEWER_QUICKSTART.md` gives the clone → test → repro → verify path.

## Fixes

Seventeen correctness fixes land in this release — nine terrain/profile
hardenings and eight fixes rated critical in a baseline audit of the v0.5 line.
The theme is the project's usual one: a number you are shown is either right or
refused with a reason.

Terrain and profiles:

- **Geographic (lat/lon) scans no longer collapse to a one-cell analysis
  grid** — the grid-cell floor is now unit-aware instead of treating 0.25° like
  0.25 m.
- **Slope, aspect, and hillshade on geographic grids use the true world
  latitude** for the cos φ correction everywhere (it was silently degrading to
  the equator), on both the CPU and GPU paths, with the GPU equivalence gate
  extended so a kernel that ignores the correction can never pass.
- **One percentile convention.** Every reported p95 now uses the same type-7
  quantile (the NumPy/R/Excel convention), so it is reproducible against
  standard tools.
- **Contours are correct on fine and degree-denominated grids** — the stitching
  tolerance scales with the grid cell, the coarse-interval check uses an exact
  level-crossing test, and saddle cells use the standard cell-average rule.
- **The ground-filter despike now fires on small cells** instead of silently
  keeping the lowest (blunder-included) return.
- **Vertical grade is signed** — a straight-down pair no longer reports an
  infinite climb.
- **The terrain worker clamps an oversized point count** instead of throwing
  and silently falling back to the slower path.
- **Measurements on a geographic (degree) CRS are refused with a clear
  reason**, not mislabelled in metres — pure-vertical heights and unit-free
  angles keep their ordinary grade.

Change detection, editing, sessions, and offline:

- **Applying epoch alignment no longer injects up to half a metre of
  round-off jitter** into a georeferenced survey; the transform is applied in
  double precision and the cloud keeps its origin.
- **Alignment refuses geographic (degree) frames** — a fit in lon/lat space
  could worsen registration while reporting success; reproject first.
- **Alignment reports metres on any projected CRS** — a 10 ft shift no longer
  reads "10.00 m".
- **Geographic epochs refuse cut/fill volumes** instead of printing degree
  areas as m³; the Δz statistics remain valid and are still reported.
- **Lasso reclassify can no longer edit points you cannot see** — points hidden
  by the clip box or a hidden class are excluded, matching the click-pick
  behaviour.
- **After a classification edit, the on-screen analysis says it is stale**
  ("results reflect the previous classification — re-run Analyse") instead of
  presenting the old result as current.
- **The clip box survives a session round-trip** — it is exported, restored
  without being clobbered by the reveal-time auto-frame, and reflected in the
  Clip panel.
- **Visiting another page can no longer poison the offline app shell** — the
  service worker refreshes the cached shell only from a clean scope-root
  navigation, never from a 404, a redirect tail, or a secondary page.

## Known limitations

- The confidence figures and quality grades describe the delivered data; they
  are not a survey-grade certification. Treat terrain products, exports, and
  epoch comparisons as deliverable-ready only when the assessment reads
  **Good**, and validate against ground control where survey-grade accuracy is
  required.
- On a geographic (degree) CRS, lengths, areas, grades, profiles, volumes, and
  epoch alignment are refused with a stated reason rather than guessed —
  reproject to a projected CRS to measure.
- Epoch alignment is a coarse registration (yaw + horizontal shift) by design;
  it is not a substitute for survey co-registration.
- Offline installation requires a production secure origin; the first visit
  needs the network.

## Verify this release

```bash
npm ci
npm test          # the full unit + integration suite
npm run repro     # writes benchmarks/out/metrics.md and the reliability figures
```

The release gate for this build ran the type check, the lint guards, both
builds, the bundle budget, and all five test buckets green — 4,022 tests
passed (30 skipped) across 352 test files. The figure step of `npm run repro`
needs Python + matplotlib; the metrics table is written without it.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files. Host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files, 755 directories) and carries
`index.html` plus `assets/` at the archive root, along with `.htaccess` and
`_headers` for host-side security headers.
