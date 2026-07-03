# OpenLiDARViewer v0.5.5

A navigation, reporting, and validation release. v0.5.5 adds a Pan hand tool,
simplifies the PDF report set, corrects scan-health reporting for deliberately
sampled datasets, and adds reproducible performance diagnostics.

OpenLiDARViewer stays browser-native and local-first. Local files never leave
the device, and no account is required.

## Pan hand tool

A fourth navigation mode, Pan, lets you grab the scene and slide it across the
viewport. Activate it from the navigation control, or:

- `4` selects Pan;
- `G` toggles Pan on and off;
- middle-mouse drag pans temporarily from any other mode.

In Pan mode a primary mouse or pen drag moves the scene while the wheel keeps
zooming. One-finger touch dragging works too. Camera orientation and view scale
stay fixed during the drag. Pan mode is preserved in saved sessions and share
links.

## Simpler PDF report set

The overlapping report catalogue is now two documents:

- Survey Summary: a compact handover with the inspection summary, dataset
  information, concise provenance, measurements, and any supplied technical notes.
- Technical Report: the full record, adding detailed provenance, file-declared
  source metadata, annotations, and visuals.

Older report-template identifiers map to the nearest current template, so
existing sessions and integrations still open.

The Scan Acceptance template is gone. Its metadata-presence rows did not amount
to an acceptance test; acceptance reporting should return only when it is backed
by explicit, data-derived checks and user-defined criteria.

## More accurate scan-health reporting

The Health Check now separates three cases: a complete decode, a deliberate
display-sample cap, and a declared-versus-decoded count mismatch. A large LAS or
LAZ file loaded with an intentional sampling stride reads as sampled instead of
being flagged as having lost points.

The decoded count and the applied stride now cross the parsing-worker boundary
intact, so the interface reports the same loading state the decoder saw.

Smaller report fixes: classification coverage shows in the Classification row,
repeated analysis caveats are merged, and an empty cloud reports a verdict
instead of an unrelated point count.

## Reproducible performance diagnostics

The optional debug overlay now records frame-time percentiles (p50/p95/p99),
counts of frames over common frame-time thresholds, the longest observed
main-thread task where the browser supports it, the effective device-pixel
ratio, and rendering and streaming counters. The values copy out as JSON for
before-and-after comparisons.

A deterministic scheduler baseline is included for regression testing. These are
measurement tools; the release does not claim a general rendering or streaming
speedup without device-specific evidence.

## Compatibility and scope

Orbit, Walk, and Fly navigation are unchanged, as are the existing point-cloud
rendering modes and the local-first, static-host deployment model. Legacy
report-template identifiers fall back to supported templates.

## Known limitations

- Pan moves the camera; it does not move or edit point-cloud coordinates.
- Performance metrics depend on the browser, device, viewport, and dataset, and
  are not universal benchmarks.
- Reports summarize the available data and implemented analyses. They are not
  survey certification or independent validation.
- A deliberately sampled load stays a display sample, not a full in-memory copy
  of the source cloud.
- Gaussian-shaped point rendering and 3D Gaussian Splat scene loading are not in
  this release.

## Verify this release

```bash
npm ci
npm run test:release
```

To check the main v0.5.5 changes directly:

```bash
npx vitest run \
  tests/panMath.test.ts \
  tests/frameTelemetry.test.ts \
  tests/metricsJson.test.ts \
  tests/reportTemplateGoldens.test.ts \
  tests/healthCheck.test.ts \
  tests/scanReport.test.ts
```

See CHANGELOG.md for the implementation-level history.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional
web host.
