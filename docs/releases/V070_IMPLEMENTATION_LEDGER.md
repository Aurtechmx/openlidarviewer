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
| L05 | SCIENTIFIC | TEST | high | PARTIAL | B05 | One lasso, two estimators. The stored record now names which one made it; it does not yet carry the area-grid figure. |
| L06 | SCIENTIFIC | READ | med | PARTIAL | B06 | Two density figures on different bases. Each states its basis; neither is the other's source. |
| L07 | SCIENTIFIC | TEST | high | FIXED | B07 | The boundary share counted a sampling gap as a survey edge, so it rose with the thinning rather than with the geometry. |
| L08 | SCIENTIFIC | READ | n/a | NOT REPRODUCIBLE | B08 | PCA extent presented as minimum physical dimensions. |
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
| L30 | ARCHITECTURE | TEST | med | FIXED | new | Three version parsers could not read a prerelease, so the release machinery had never been exercised against one. |
| L31 | SESSION | TEST | med | FIXED | new | A lazy chunk awaited after the restore was committed reported a restored session as a failed import. |
| L32 | LIFECYCLE | READ | n/a | NOT REPRODUCIBLE | new | Ad hoc cancellation flags as a class. |
| L33 | STANDARDS | TEST | high | FIXED | new | An unknown record format still asserted the extended reading for codes 13 to 22. |
| L34 | LOADER | TEST | high | FIXED | new | A record shorter than its format requires was decoded, reading fields from the following record. |
| L35 | LOADER | READ | n/a | NOT REPRODUCIBLE | new | A truncated LAS presented as complete. |
| L36 | STANDARDS | READ | n/a | NOT REPRODUCIBLE | new | LAS 1.5 routed through 1.4 logic. |
| L37 | SEMANTICS | TEST | high | FIXED | new | GPS time was exported under a time interpretation the source never declared. |

## Totals

- DEFERRED: 3
- FIXED: 9
- NOT REPRODUCIBLE: 8
- OPEN: 13
- PARTIAL: 4
- SUPERSEDED: 1
- total: 37

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
rule.

A router test asserted the old behaviour while its comment described the new
one: it read that a failed load "tidies any half-open stream", and the scenario
it ran was a static file that opened no stream at all. That assertion is now
the rule the comment states, with a second case covering a streaming open that
does fail mid-flight. Covered by `tests/openScanAttachSequence.test.ts` and
`tests/openScan.test.ts`.

### L30 · FIXED · ARCHITECTURE

Moving the development identity to a prerelease exposed three version parsers
that could not read one. Two in `tests/dependenciesDocSync.test.ts` matched with
a pattern that stops at the hyphen, the same defect `lint-release-sync` records
having fixed for itself and never propagated. The third, in
`verify-archive-portability.mjs`, allowed a prerelease but let the identifier
run on into the file extension, so `v0.7.0-alpha.1.json` read as a version that
disagreed with the archive.

None of them could fail while the version was plain, which is why a release
line that had cut alphas before still carried them. Covered by the archive
portability check and the dependency document sync tests.

### L31 · FIXED · SESSION

Session restore commits bookmarks, the view state and the measurements, and
then awaits a lazy chunk to compute one disclosure line. The step is explicitly
allowed to produce nothing: the comment above it reads that an absent, legacy or
tampered manifest still restores every measurement. A dynamic import can reject
for reasons that have nothing to do with the manifest, and that rejection
reached the outer catch, which reported "Could not import the session" over a
session that was already restored.

The disclosure now degrades on its own rather than failing the restore around
it. Verified red-green: with the guard removed the test sees the error reported,
and with it in place the restore reports success. Covered by
`tests/sessionIo.test.ts`.

### L32 · NOT REPRODUCIBLE · LIFECYCLE

Section 7 asks for an operation-lifetime primitive to replace ad hoc
cancellation flags. Five such flags exist. Three are `let disposed = false`
inside dispose closures, which is idempotent-disposal bookkeeping rather than
operation cancellation, and is the concern `DisposableGroup` now carries. The
other two are genuine but isolated, and sixteen modules already cancel through
an `AbortController`.

The premise as stated is not reproduced, so no primitive was built. Section 57's
cancellation-ownership question is separate and stays open.

### L33 · FIXED · STANDARDS

The first pass at unknown-format naming handled four codes, the ones where the
two tables swap a name for a reservation. The tables disagree more widely than
that: legacy reserves everything from 13 to 31, while the extended table names
13 through 22. A source that declared no record format therefore read code 19
as Overhead Structure, which asserts extended semantics the file had not
declared.

Ambiguity is now derived from the two tables rather than from a hand-written
list, so a code either table names alone reports both readings. One case
settles itself: the legacy classification field is five bits, so a code above 31
cannot have come from a legacy record and the extended reading is the only one
available.

The export legend reads "Bridge Deck or reserved (17)" where it has no format
to work from. Passing the format at that call site gives the exact name, and
that wiring is open. Covered by `tests/lasClassificationSemantics.test.ts`.

### L34 · FIXED · LOADER

The header read the declared point record length straight out of the file and
used it. Nothing compared it against the format the same header declared.

A record shorter than its format requires is not a record missing a field at the
end. Every field is addressed by a fixed offset from the record start, so a
short record puts the classification, the return bits and the point source id
inside the following record, and they decode into plausible values belonging to
a different point. The file is now refused before a point is decoded, naming the
format and both lengths. A longer record stays legal and carries Extra Bytes.

The minimums are the ASPRS LAS Specification 1.4 R15 figures for all eleven
formats, read from Tables 7 and 10 to 21 rather than derived by adding field
sizes.

A test in `tests/benchmark/failureRecovery.test.ts` had pinned the weaker
behaviour and named its cause exactly: the message described the symptom, an
empty file, rather than the cause, because the record length was never validated
in `parseLasHeader`, so a reader was told the file was empty when it was
structurally corrupt. That pin now asserts the diagnosis it said was lost.
Covered by `tests/lasVersionPdrfMatrix.test.ts` and that file.

### L35 · NOT REPRODUCIBLE · LOADER

Section 26 asks that a truncated LAS not be silently clamped to the records
present and presented as complete. The decoder does clamp, to avoid reading past
the buffer and throwing an opaque range error partway through, but the result is
not presented as complete: the cloud keeps the declared count from the header
beside the count the decoder produced, and the Health Check compares them and
reports a mismatch on a full decode as a warning, distinguishing it from a
display-sample cap.

What differs from section 26 is the policy, not the honesty. Refusing outright
would stop a partially written file being inspected at all, which is a product
decision rather than a correctness one.

### L36 · NOT REPRODUCIBLE · STANDARDS

Section 27 asks that LAS 1.5 not be routed through 1.4 logic and called
conforming support. The header parser already recognises 1.5 and refuses it,
with the R00 restrictions recorded beside the refusal. The honest boundary
section 27 asks for is the one in place.

### L37 · FIXED · SEMANTICS

The LAS header declares in Global Encoding bit 0 which of two quantities the
gpsTime field holds: Adjusted Standard GPS Time when set, GPS Week Time when
clear. They are not interchangeable, and one read as the other is wrong by
years.

`parseLasHeader` had no offset for Global Encoding and never read the bit. The
writer did know about it, and declared Adjusted Standard for everything it
wrote, on the stated reasoning that every modern source uses that convention. So
a genuine GPS Week Time file came back out carrying its original numbers under a
declaration that changed what they meant, with nothing in the application able
to report which it had been.

The header reads the bit now, the cloud carries it, and an export declares what
its source declared. A source that declared nothing, which includes every format
that is not LAS, keeps the writer's modern default rather than acquiring a claim
it never made. The field is reserved before LAS 1.2, so a set bit there is
reported as no declaration rather than as Adjusted Standard. Covered by
`tests/lasGpsTimeType.test.ts`.

### L07 · FIXED · SCIENTIFIC

"Measured cells near the data boundary" is meant to say how much of the surface
sits at the edge of what was surveyed. It seeded a distance field at every cell
that was not measured and counted measured cells within a threshold of one.

On a full decode those seeds are the survey edge. On a grid thinned by a display
stride they are mostly interior gaps, so nearly every measured cell is beside
one. Held to one geometry and varying only the thinning, the share read 33 per
cent at full decode and 100 per cent strided: the number described the sampling,
not the terrain. The report quotes this share in its verdict sentence.

The coverage vocabulary already separated the two cases. A cell with no
reachable data is outside the survey; an interpolated cell was filled from the
measured cells around it and is inside it. The field now seeds only from cells
with no data, and the distance travels through the surveyed region rather than
through measured cells alone, so neither the seeds nor the distances depend on
how densely the surface was sampled.

Classified under section 80 as a bug fix rather than a scientific change: the
metric now measures what its label says. No registered method computes it, and
no frozen validation record pins it, so no evidence applicability moves.
Covered by `tests/terrainBoundaryStrideInvariant.test.ts`.

### L08 · NOT REPRODUCIBLE · SCIENTIFIC

Section 34 asks that a principal-axis extent not be presented as minimum
physical object dimensions. The panel presents it as what it is. The oriented
row reads "tight box from the object's own principal axes", and the headline
figure is labelled unvalidated with a hint that names the failure mode: the box
is fitted by principal axes, which drift toward the diagonal on flat or
symmetric point sets, so it is an unvalidated estimate rather than a measured
extent.

The overstatement on an elongated footprint is real and inherited, but it is
disclosed rather than presented as a measurement. A convex hull into a
minimum-area rectangle would be a new capability, not a correction to a false
claim, and section 67 would want it checked against an independent
implementation before it replaced anything.

### L06 · PARTIAL · SCIENTIFIC

Section 32 asks for one density result carrying an explicit basis. Two figures
are computed independently: Analyse reads the resident gather, and the Scan
Report divides the declared count by the sampled footprint. They differ by
roughly the stride factor.

What section 105 forbids is a hidden or inconsistent basis, and the basis is
neither. On a strided load the report's row says in the value itself that it is
the declared count over the display-sample footprint. The gap is that two
surfaces compute the same quantity separately rather than presenting one record,
which is architecture rather than a truth defect, and it is what a canonical
density result would close.

### L05 · PARTIAL · SCIENTIFIC

One call site answers a lasso twice. `Viewer` builds the persisted
`VolumeRecord` from the point-sample integration and, on the same line, calls
`stockpileToastSuffix` for the area-weighted grid the toast shows. The two do
not agree, and the stored record carried no method, so a session, a report or a
CSV held a figure that could not say which estimator produced it. The registry
already names both and states that a v1 figure does not carry the v2 meaning.

The record names its estimator now, as `id@version`, and the tag survives a
session round trip. A record written before the field carries none, and that
absence is preserved rather than filled in: reading it as the current estimator
would give a historical figure a meaning it was never computed under, which is
what section 11.1 forbids.

What remains is the rest of section 11: the stored record still holds the
point-sample numbers. Moving it to the area-grid figure changes an exported
value, so it needs the section 80 classification, the unit handling between the
grid's metres and the record's native units, and the coverage verdict carried
with it rather than dropped. Covered by `tests/stockpileMethodIdentity.test.ts`.
