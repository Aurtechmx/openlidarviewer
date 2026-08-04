# OpenLiDARViewer v0.6.4 — working draft

**Status: in development.** This document tracks every change on `main` since the
`v0.6.3` release tag. The version has **not** been bumped: the formal release —
version bump, regenerated validation/reproducibility/limitations evidence, and
prose release notes — happens once the hardening tracked in the last section is
complete and CI is green. This draft is the running record of what v0.6.4 is.

The prose below is a working list, not the final release copy.

---

## Merged since v0.6.3

### CRS and units — fail-closed hardening

The largest theme: a unit-safety program that refuses to state a metric figure
when the CRS unit is not confirmed, and routes the display tier through one
`SpatialContext` model.

- #217 fail closed on footprint area (m²) for an unknown-unit CRS
- #218 fail closed on unknown CRS unit in streaming scan-report extents
- #219 fail closed on unknown projected linear unit in epoch cut/fill
- #220 disclose unverified units in the space/scan report
- #223 fail closed on unknown projected linear unit in epoch alignment residual/shift
- #224 fail closed on unconfirmed unit in the full-cloud grade
- #225 disclose unverified units in the stockpile volume figures
- #226 fail closed on unknown CRS unit in the static scan report
- #227 fail closed on unknown CRS unit in the scan fitness scorecard
- #229 explicit height value type; datum-honest inspector Z label
- #232 DRY the linear-unit-known gate; fail closed on a missing CRS in epoch compare
- #234 thread the height vertical-reference through the measure gate and scan report
- #235 cross-implementation CRS reference fixtures (PROJ/pyproj) — P1 #9
- #236 a single SpatialContext model, its cross-product matrix, and consumer inventory
- #241 route the display-tier consumers through SpatialContext
- #246 refuse a session that redefines a scan's CRS/axis/unit on restore
- #247 replace regex WKT field extraction with an AST parser
- #248 carry transform provenance on every reproject result
- #250 audit frame boundaries; correct stale rebase docs; pin world-coord invariance
- #255 refresh the coordinate-integrity roadmap status

### Multi-scan project-frame mount

- #238 activate the multi-scan project-frame mount, with browser evidence
- #233 non-mutating on-ramp for the Float64 project frame
- #240 route the CPU elevation filter through each cloud's own origin
- #245 prove multi-scan acceptance: no move on sibling add/remove
- #254 fix the inspector world coordinate for a non-anchor mounted layer
- #210 fold layer placement into the terrain, profile, volume and lasso estimators
- #207 per-cloud elevation filtering, stages A+B

> Note: this feature is being reverted to disabled in v0.6.4 pending the
> per-layer frame fixes tracked below — see "Hardening in progress".

### Viewer de-monolithing

- #251 extract streaming session assembly behind a StreamingHost
- #252 extract generateReportPdf + exportGeoContext to reportExport
- #244 extract handleRemoteEpt + openStreamingCopc to openStreaming
- #242 extract handleFile to openScan
- #230 extract importSession to sessionIo
- #228 extract the render-loop body to renderLoop behind a host
- #222 extract Viewer.snapshot to render/snapshot
- #221 extract toClassBuffer to render/class/classBuffer
- #209 extract buildActionRegistry to app/actionDefinitions
- #208 extract colour-legend/range reads to colorLegend

### PDF and map sheet

- #206 numbered annotation markers + description table on the Map Sheet PDF
- #259 PDF accessibility metadata on the five remaining emitters
- #264 include annotations on the map sheet by default when the scan has them

### Classification

- #266 emit the classifier worker chunk in the obfuscated build (fixes the
  auto-classify page-reload: the worker was never registered in the obfuscator
  exclude / chunk-pin lists, so its chunk 404'd and stale-chunk recovery
  reloaded the app)

### Security, hygiene and OSPS

- #253 OSPS security-policy docs; reword R&D-stage to actively maintained
- #256 bundle-budget ceilings for the heavy capability chunks
- #257 harden the workflowRecorder download handler against a teardown race
- #213 signed-URL secret scan + shipped-file cleanup
- #211 remove the test-report feature; harden dataset and privacy claims
- #212 remove unwired dead code (3D-tiles decode, SSAO, photoreal, context view)
- #237 correct over-claims (drop SSAO, fix 3D-Tiles wording, dataset count 14→12)
- #185 make an acquired dataset's recorded hash checkable
- #204 wire the Stryker Dashboard so the core mutation score gets a badge

### Navigation, dependencies and test infrastructure

- #205 navigation preferences: invert orbit X/Y with presets
- #214 replace the non-redistributable bunny E57 fixture with a synthetic E57
- #216 raise the mutation job timeout
- #231 fix a stale battery unit-test reference
- #239 streaming fast-navigation measurement harness (measurement-only)
- #243 fix the flaky mapSheetPdf byte-identity test (fixed generatedAt)
- #178 / #179 / #183 dependency bumps (download-artifact, upload-artifact, action-gh-release)

---

## v0.6.4 hardening — status

`[x]` merged to main · `[~]` implemented on a branch, pending merge · `[ ]` queued.

### Landed on main
- [x] Classifier worker chunk emitted in the obfuscated build — fixes the
  auto-classify page-reload (#266)
- [x] Archive self-verification no longer requires network (#267)
- [x] Fail closed on unknown units at four surfaces: PDF footprint, COPC
  spacing, Dataset Intelligence volume, session-summary schema comment (#268)
- [x] Revert `MULTI_LAYER_MOUNT_ENABLED` to `false` + release-truth mount-flag
  guard so flag and truth docs can't disagree (#269)
- [x] Lasso reclassify / clip placement-aware, with a direct-placement unit test
  — P0 (#270)
- [x] Annotation `worldPosition` populated on create; report labels the frame;
  `layerId`/`crs` round-trip — P1 (#271)
- [x] Streaming replacement made transactional — gate F4 (#272)
- [x] Return-number cue: multi-return ⇒ vegetation, not building (#263)
- [x] Quick wins: export-drops-class-edits disclosure (#258), annotation panel
  grouping (#260), colour-mode recommendation (#261), profile-station hover (#262)

### Implemented on a branch, pending merge (currently in the test build)
- [~] Auto-classify button + loading state (#265)
- [~] Keep the natural colour after auto-classify — don't force the class palette
  (matches a pre-classified scan; class-hide still filters)
- [~] Contour Studio purpose picker declutter — compact pills, descriptions on hover
- [~] Building support-gate: a tall smooth not-green candidate needs firmer
  ground support (0.66) to be Building; below it → Unclassified, killing
  scan-edge false roofs
- [~] Purpose-aware map-sheet PDF: each purpose renders a deliverable line, a
  "This deliverable" settings box, and a validation appendix when required

### P0 still open — the mount re-enable gate
- [ ] Multi-layer session frame model: `projectOrigin`, per-layer
  `{sourceOrigin, sourceToProject, fingerprint}`, `layerId` on measurements +
  annotations, explicit frame/CRS metadata, `SESSION_VERSION` bump; fix
  `exportGeoContext()` to return the project origin (it returns the active
  cloud's, so work saved over a non-anchor layer reloads displaced — same defect
  taints measurement GeoJSON/CSV export). Unreachable in production while the
  mount is disabled; landing this is what lets the mount turn back on.

### Tests + deferred
- [ ] Multi-layer session round-trip regression (two layers, work on the
  non-anchor, export, reopen alone, every point returns to the same world coord)
- [ ] Mounted-layer lasso/clip 2 km-displacement browser regression (the fix
  shipped with a unit test; the e2e is still queued)
- [ ] Synthetic low-support building test for the support gate
- [ ] Hillshade / hypsometric-tint raster on the purpose PDF (currently
  documented in the settings box, not drawn)

### Re-enable the mount
- [ ] After the frame model + regression tests land, flip
  `MULTI_LAYER_MOUNT_ENABLED` back to `true` and un-skip the two-scan-mount e2e.

### Release (last)
- [ ] Bump 0.6.3 → 0.6.4, regenerate validation / reproducibility / limitations
  evidence, and finalize these notes — after everything above is merged and CI
  is green.
