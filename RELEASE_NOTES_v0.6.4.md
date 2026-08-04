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

## Hardening in progress (verified backlog)

Each item below was verified against the code before listing. `[~]` = in
progress this cycle, `[ ]` = queued.

### Interim safety
- [~] Revert `MULTI_LAYER_MOUNT_ENABLED` to `false` until the per-layer frame
  model lands. The mount shipped enabled (#238) but has the P0 coordinate bugs
  below; reverting makes them unreachable and makes the truth docs accurate.

### P0 — coordinate integrity
- [ ] Multi-layer session frame model: `projectOrigin`, per-layer
  `{sourceOrigin, sourceToProject, fingerprint}`, `layerId` on every
  measurement + annotation, explicit frame/CRS metadata, `SESSION_VERSION`
  bump. `exportGeoContext()` returns the active cloud's origin, not the project
  origin — work saved over a non-anchor layer reloads displaced. Same defect
  taints measurement GeoJSON/CSV export.
- [ ] Lasso reclassify / clip placement-awareness: `reclassifyLasso` and
  `clipKeptCount` run the CPU projection/predicate on raw source-local
  positions with no `sourceToProject` fold, so a destructive edit hits the
  wrong points of a mounted layer.

### P1
- [ ] Populate annotation `worldPosition` on create (retain the picked layer,
  compute via `worldXYZ`, store `layerId` + frame/CRS) so reports print survey
  coordinates, not render-local.

### Credibility — unit fail-closed (in flight)
- [~] PDF footprint: fail closed on unknown units (discriminated union; omit
  m / pts·m² / density grading, show source units + a warning)
- [~] COPC spacing: unit-aware formatting instead of unconditional ` m`
- [~] Dataset Intelligence volume: only grade density when horizontal + vertical
  units are confirmed
- [~] Session summary: correct the "metres" schema comment to source-unit extents

### Integrity and hygiene (in flight)
- [~] Release-truth lint: add a mount-flag guard so the flag and the truth docs
  cannot disagree
- [~] Archive self-verification: stop auto-running the network dataset
  acquisition; keep the offline hash verifier

### Robustness
- [ ] Streaming replacement transactional (gate F4): move the teardown past
  source validation so a malformed remote COPC can't blank the current scene

### Tests to add
- [ ] Multi-layer session round-trip (two layers, place work on the non-anchor,
  export, reopen alone, verify every point returns to the same world coordinate)
- [ ] Mounted-layer lasso/clip regression (edited layer displaced 2 km, select
  visible points on the non-anchor layer, verify only those change)

### Release
- [ ] Version bump + regenerate validation/reproducibility/limitations evidence
  + finalize these notes (after the above land and CI is green)
