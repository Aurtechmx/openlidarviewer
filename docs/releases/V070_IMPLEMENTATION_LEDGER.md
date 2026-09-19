# v0.7.0 implementation ledger

Every defect and architecture item this release carries, with the evidence for
its status.

## Baseline

v0.6.9, tag `v0.6.9`, commit `c164e907f50ff49da7233385d92285c53dfb3b8d`. The
published v0.6.9 documents and evidence are unchanged and are not compared
against this tree.

## How to read it

`Repro` records how the entry was established. READ means confirmed against the
shipped source, DOC means carried from a published v0.6.9 document and not yet
reproduced here, TEST means a test exercises it.

An item reads FIXED only where a test or another reproducible proof exists, and
the test is named. Code changing is not sufficient.

Entries keep their original identifier from the register this ledger grew out
of, so a finding can be traced to where it was first written down.

## Ledger

| ID | Category | Repro | Sev | Status | Was | Finding |
|---|---|---|---|---|---|---|
| L01 | EXPORT | READ | med | PARTIAL | B01 | LAS 1.2 write masks classification with 0x1f, so a class above 31 wraps to another valid class. |
| L02 | EXPORT | READ | med | OPEN | B02 | Scan angle rank written as constant zero. |
| L03 | EXPORT | READ | med | OPEN | B03 | User data written as constant zero. |
| L04 | STANDARDS | TEST | high | FIXED | B04 | ASPRS class names defined independently in eight modules, and they disagreed. |
| L05 | SCIENTIFIC | DOC | high | OPEN | B05 | Canonical stockpile record not integrated: the toast and the exported record can disagree for one lasso. |
| L06 | SCIENTIFIC | DOC | high | OPEN | B06 | Analyse ground density and the Scan Report disagree by roughly the stride factor. |
| L07 | SCIENTIFIC | DOC | high | OPEN | B07 | Boundary share seeds from every non-measured cell, so stride gap reads as boundary. |
| L08 | SCIENTIFIC | DOC | med | OPEN | B08 | PCA oriented bounding box overstates length on an elongated footprint. |
| L09 | LIFECYCLE | DOC | med | OPEN | B09 | `NavBar.dispose` has no caller. |
| L10 | LIFECYCLE | DOC | med | OPEN | B10 | `ViewerRenderCore` has no dispose seam. |
| L11 | UI | DOC | med | OPEN | B11 | Between 768 and 1000 px two open rails leave no top-centre gap wider than the project card. |
| L12 | UI | DOC | med | OPEN | B12 | Pinch, rotate and two-finger gestures run end to end on Chromium only. |
| L13 | EVIDENCE | DOC | med | OPEN | B13 | Firefox, WebKit and Windows are advisory; only Chromium blocks. |
| L14 | ARCHITECTURE | DOC | low | OPEN | B14 | Far-apart mounts do not fold `renderOrigin` on the CPU per mesh. |
| L15 | ARCHITECTURE | DOC | n/a | DEFERRED | B15 | The registration stack ships and no user path reaches it. |
| L16 | EVIDENCE | DOC | n/a | OPEN | B16 | `scientificArtifactPassport` ships and is unreachable. |
| L17 | EVIDENCE | DOC | n/a | OPEN | B17 | `evidenceBoundaryInspector` ships and is unreachable. |
| L18 | EVIDENCE | DOC | n/a | OPEN | B18 | `dtmProductDigest` ships and is unreachable. |
| L19 | SCIENTIFIC | DOC | known | DEFERRED | B19 | Ground filter near F1 0.5 on mountain scenes, 0.34 precision under dense canopy. |
| L20 | SEMANTICS | DOC | known | DEFERRED | B20 | No cross-CRS reprojection; the viewer refuses rather than approximating. |
| L21 | STANDARDS | READ | n/a | NOT REPRODUCIBLE | B21 | CityGML LoD terminology misuse. |
| L22 | LOADER | READ | n/a | NOT REPRODUCIBLE | B22 | Extended classification masked as legacy on decode. |
| L23 | SEMANTICS | TEST | high | FIXED | B23 | Classification flags were never decoded anywhere in the tree. |
| L24 | EXPORT | READ | n/a | NOT REPRODUCIBLE | B24 | Extended writer suspected of clamping classification. |
| L25 | EVIDENCE | TEST | high | SUPERSEDED | B25 | Adding any test turned the gate red, because the evidence lint compared published v0.6.9 documents against a changed machine state. |
| L26 | SCIENTIFIC | READ | unmeasured | OPEN | B26 | Withheld points enter terrain, density and stockpile as ordinary returns. |
| L27 | EVIDENCE | TEST | n/a | NOT REPRODUCIBLE | B27 | Scoping the evidence figure check to untagged versions. |
| L28 | SEMANTICS | TEST | med | PARTIAL | B28 | Classification flags survived a load but not a derivation. |
| L29 | STATE | TEST | high | FIXED | new | A failed candidate open closed a streaming scan that belonged to the project, not to the candidate. |

## Totals

- DEFERRED: 3
- FIXED: 3
- NOT REPRODUCIBLE: 4
- OPEN: 16
- PARTIAL: 2
- SUPERSEDED: 1
- total: 29

## Detail

### L01 · PARTIAL · EXPORT

LAS 1.2 write masks classification with 0x1f, so a class above 31 wraps to another valid class. `convertCloud.ts:287` counts the affected points and warns with the exact arithmetic, naming LAS 1.4 as the remedy.

Section 17 asks for refusal by default on semantic conflict, not only a warning. The flags half is fixed; the class-wrap half is not. Covered by `tests/lasLossyConversion.test.ts`.

### L02 · OPEN · EXPORT

Scan angle rank written as constant zero. `GlobalPoints` has no scan angle field, so the writer has nothing to write.

Model gap, not a writer defect. Section 18 lists it for preservation. No test covers it yet.

### L03 · OPEN · EXPORT

User data written as constant zero. Same cause as L02.

Model gap. Section 28 requires an honest attribute table either way. No test covers it yet.

### L04 · FIXED · STANDARDS

ASPRS class names defined independently in eight modules, and they disagreed. `src/lasSemantics.ts` is the single source; `classificationLabel` and `asprsLabel` delegate to it.

Names keyed by point data record format, verified against LAS 1.4 R15 Tables 8, 9, 16 and 17. Covered by `tests/lasClassificationSemantics.test.ts`.

### L05 · OPEN · SCIENTIFIC

Canonical stockpile record not integrated: the toast and the exported record can disagree for one lasso. Unchanged from v0.6.9.

Section 11 requires one StockpileResult driving screen, Finding, session, report, CSV and provenance. No test covers it yet.

### L06 · OPEN · SCIENTIFIC

Analyse ground density and the Scan Report disagree by roughly the stride factor. Unchanged from v0.6.9.

Section 32 requires one density result carrying its basis. No test covers it yet.

### L07 · OPEN · SCIENTIFIC

Boundary share seeds from every non-measured cell, so stride gap reads as boundary. Unchanged from v0.6.9.

Section 33 requires separating observation boundary from sampling gap. No test covers it yet.

### L08 · OPEN · SCIENTIFIC

PCA oriented bounding box overstates length on an elongated footprint. Labelled unvalidated rather than presented as a measurement.

Section 34 requires convex hull into minimum-area rectangle for physical extent. No test covers it yet.

### L09 · OPEN · LIFECYCLE

`NavBar.dispose` has no caller. Still no caller. Its teardown array is now a `DisposableGroup`.

Section 53: a dispose method with no owner is a misleading contract. Covered by `tests/navBarDisposal.test.ts` covers the method, not its invocation.

### L10 · OPEN · LIFECYCLE

`ViewerRenderCore` has no dispose seam. Unchanged.

Section 52 requires an explicit viewer resource lifecycle. No test covers it yet.

### L11 · OPEN · UI

Between 768 and 1000 px two open rails leave no top-centre gap wider than the project card. Not reproduced in this cycle.

Section 71 requires a width sweep. Reproduce before changing layout. No test covers it yet.

### L12 · OPEN · UI

Pinch, rotate and two-finger gestures run end to end on Chromium only. Unchanged.

Section 70 forbids substituting mouse simulation for touch verification. No test covers it yet.

### L13 · OPEN · EVIDENCE

Firefox, WebKit and Windows are advisory; only Chromium blocks. Unchanged.

Section 72 wants a common blocking suite across the three engines. No test covers it yet.

### L14 · OPEN · ARCHITECTURE

Far-apart mounts do not fold `renderOrigin` on the CPU per mesh. Unchanged. The mount-precision gate refuses a placement past 1 mm.

Section 65. Precision refinement, not a correctness defect. Covered by mount precision gate.

### L15 · DEFERRED · ARCHITECTURE

The registration stack ships and no user path reaches it. Six modules staged in the unreachable register.

Section 90 requires the complete workflow before graduation. Half a workflow is worse than none. No test covers it yet.

### L16 · OPEN · EVIDENCE

`scientificArtifactPassport` ships and is unreachable. Staged, tested, no user path.

Section 47 makes it a graduation candidate with a deterministic sidecar. Covered by own tests only.

### L17 · OPEN · EVIDENCE

`evidenceBoundaryInspector` ships and is unreachable. Registered validation-only.

Section 49: read-only view over the canonical resolver, no second engine. Covered by own tests only.

### L18 · OPEN · EVIDENCE

`dtmProductDigest` ships and is unreachable. Staged.

Section 48 binds terrain product identity. Covered by own tests only.

### L19 · DEFERRED · SCIENTIFIC

Ground filter near F1 0.5 on mountain scenes, 0.34 precision under dense canopy. Unchanged, against external reference labels.

Section 81 forbids tuning to the benchmark. Documented rather than changed. Covered by register figures.

### L20 · DEFERRED · SEMANTICS

No cross-CRS reprojection; the viewer refuses rather than approximating. Unchanged.

Section 66 keeps the refusal until the whole chain is safe. Covered by refusal path.

### L21 · NOT REPRODUCIBLE · STANDARDS

CityGML LoD terminology misuse. No CityGML or LoD terminology exists anywhere in `src/` or `docs/`.

Nothing to correct. Section 46 still justifies a lint to keep it that way. No test covers it yet.

### L22 · NOT REPRODUCIBLE · LOADER

Extended classification masked as legacy on decode. `lasDecodeShared.ts` and `eptLaszipDecode.ts` already select 0xff for extended formats.

The decode side was correct before this cycle. Covered by `tests/lasDecodeFlags.test.ts`.

### L23 · FIXED · SEMANTICS

Classification flags were never decoded anywhere in the tree. Read from both layouts, normalised, carried on the model through the sanitizer, written by both writers.

ASPRS says a producer generally sets Withheld on culled overlap points, so the meaning was being discarded at decode. Covered by `tests/lasRoundTrip.test.ts`.

### L24 · NOT REPRODUCIBLE · EXPORT

Extended writer suspected of clamping classification. `writeLas14` already writes the full 8-bit class and its comment names the clamp it avoids.

No correction needed on the extended path. Covered by `tests/lasRoundTrip.test.ts`.

### L25 · SUPERSEDED · EVIDENCE

Adding any test turned the gate red, because the evidence lint compared published v0.6.9 documents against a changed machine state. Resolved by cutting a dated development alpha; the record now names v0.7.0-alpha.1.

Developing under a released version number was the root cause. Neither editing published documents nor holding the version was available. Covered by `lint:evidence`.

### L26 · OPEN · SCIENTIFIC

Withheld points enter terrain, density and stockpile as ordinary returns. Flags are now preserved but nothing consumes them.

Section 21 requires a default exclusion policy. The discard is verified in code; the consequence is not measured, because every LAS fixture here is synthetic with no flag set. No test covers it yet.

### L27 · NOT REPRODUCIBLE · EVIDENCE

Scoping the evidence figure check to untagged versions. Attempted and reverted.

The change made the release-doc path guard vacuous while the version stayed tagged, and that guard exists because the lint once read paths that did not exist. Covered by `tests/evidenceReleasePathLint.test.ts`.

### L28 · PARTIAL · SEMANTICS

Classification flags survived a load but not a derivation. Clipping carries them. Voxel downsampling does not.

Downsampling takes the first point in a voxel for every attribute; applying that to a safety flag would let one withheld point among nine lose its marking. Left undecided rather than guessed. EPT and COPC produce no flags, which reads as absent rather than false zeros. Covered by `tests/clipCloudFlags.test.ts`.

### L29 · FIXED · STATE

The failure path in `openScan` tidied a streaming scan on every error, with a
comment reading that a streaming open which failed mid-flight leaves no scan.
That catch covers every open on the path, so dropping an unparseable LAS while a
COPC or out-of-core scan was on screen closed the working scan for a candidate
that never arrived.

The tidy-up is now scoped to the open that was attaching a streaming scan. The
static attach already refused to clear the scene for a candidate that had not
parsed, and said so in its own comment; the error path did not follow the same
rule. Covered by `tests/openScanAttachSequence.test.ts`.
