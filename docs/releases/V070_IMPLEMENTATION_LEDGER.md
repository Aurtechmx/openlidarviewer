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
| L16 | EVIDENCE | TEST | n/a | FIXED | B16 | The passport shipped and nothing reached it. A DEM package now emits one beside its bare-earth raster. |
| L17 | EVIDENCE | TEST | n/a | FIXED | B17 | The evidence inspector shipped and nothing reached it. The DEM README now explains the decision. |
| L18 | EVIDENCE | TEST | n/a | FIXED | B18 | `dtmProductDigest` shipped and nothing reached it. The DEM package now records the surface it emits. |
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
| L38 | STANDARDS | TEST | med | FIXED | new | Nothing guarded the standards statements this release corrected. |
| L39 | STANDARDS | READ | n/a | FIXED | new | No register recorded which standards the application reads or when its text was last checked. |
| L40 | ARCHITECTURE | READ | n/a | NOT REPRODUCIBLE | new | AnalysePanel mixing analysis execution with presentation. It orchestrates exports, and those already snapshot their inputs. |
| L41 | ARCHITECTURE | READ | n/a | FIXED | new | Nineteen staged modules reviewed for graduation, staging or removal. |
| L42 | UI | READ | n/a | DEFERRED | new | Browser matrix, mobile and responsive verification need real engines. |
| L43 | STATE | TEST | high | FIXED | new | The streaming tidy-up predicted the attach with a flag, so a throw from the heavy bridge still closed an unrelated scan. |
| L44 | LIFECYCLE | TEST | med | FIXED | new | NavBar disposed its teardown group before clearing its timer, and the group rethrows. |
| L45 | ARCHITECTURE | TEST | high | FIXED | new | The standards lint skipped any directory whose path contained 'dist' and all of `docs/release`. |
| L46 | PERFORMANCE | TEST | med | PARTIAL | new | Streaming node meshes disable frustum culling. The decision and its baseline exist; the renderer is not yet wired to them. |
| L47 | UI | READ | med | OPEN | new | Density point sizing keys a 2D grid on (x, y), so it is not orientation invariant. |
| L48 | PERFORMANCE | TEST | med | FIXED | new | Render-memory telemetry counted position and colour only, so a classified cloud was reported at three quarters of what it used. |
| L49 | PERFORMANCE | READ | med | OPEN | new | Compact source attributes are uploaded as Float32: RGB, classification and intensity cost 14 bytes a point more than the source carries. |

## Totals

- DEFERRED: 4
- FIXED: 19
- NOT REPRODUCIBLE: 9
- OPEN: 12
- PARTIAL: 5
- SUPERSEDED: 1
- total: 49

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

### L38 · FIXED · STANDARDS

Every classification statement corrected this release was corrected by hand, and
nothing stopped the next edit putting it back. `lint:standards-truth` refuses
six statements that contradict the specification: class 12 named Overlap for the
extended formats, classes 19 to 22 or 23 to 63 called user-defined, an accuracy
figure described only as 95 per cent confidence, an ISO crosswalk described as
certification, and CityGML level-of-detail vocabulary in an application that
holds no CityGML objects.

Historical release documents are exempt. A document describing what a past
release said is a record of that release, and correcting it would make it
describe something that did not happen.

The first version failed on a correct sentence of its own changelog: "23 to 63
are reserved, and only 64 and above are user definable" matched because the
user-definable range appears downstream of the reserved one. A lint that cries
wolf gets switched off, so the rules exempt a line that says the range is
reserved or named. Twelve tests inject each refusal and each correct wording.
Covered by `tests/standardsTruthLint.test.ts`.

### L39 · FIXED · STANDARDS

`docs/standards/standards-sources.yaml` records the two specifications the
application actually reads, the edition, the date the text was last read, the
sections that were read, and the modules that encode an interpretation of each.
No standard is reproduced.

The LAS 1.5 entry is there for the refusal rather than for decoding: the parser
recognises the version and declines it instead of reading it through the 1.4
layout, and that decision rests on the 1.5 text as much as a decode would.

### L18 · FIXED · EVIDENCE

`dtmProductDigest` was implemented, tested and unreachable. Its register entry
named a precondition rather than a plan: `canonicalize()` had to refuse
non-finite numbers first, because `JSON.stringify` renders NaN and both
infinities as null, so distinct invalid states would have hashed identically.
That was fixed earlier and verified here before anything was wired.

The DEM package now digests the surface it ships and prints it in the README
beside the grid it describes. Two packages carrying the same heights and
coverage states share the value; a changed cell, coverage state, grid geometry
or CRS code moves it. Where the evidence resolution supplied a method digest the
two are bound, so the pair is what the value proves equal.

Section 48's vocabulary is kept: this is the DERIVED-PRODUCT digest, taken over
what the deliverable emits. It is not the source-file digest and not the
analysis-input digest, and the README says which one it is.

The digest lands in the lazy export chunk, so the eager shell is unchanged at
805 KiB. Covered by `tests/demPackageReadme.test.ts`, including that the value
moves when a cell does.

### L16 · FIXED · EVIDENCE

The Scientific Artifact Passport was implemented, tested and unreachable. Its
register entry listed integration conditions rather than missing behaviour: an
export path that emits it beside its artifact, a lazy load so the eager shell
does not carry it, and a record citing its digests.

A DEM package now writes `<basename>-dtm.tif.olv-passport.json` beside the
raster. The artifact is one file rather than the package: a record digesting the
archive it travels inside could never verify, because adding it changes what it
measured.

Its inputs are the ones the export already derives. The analysis record and the
processing manifest come from the same provenance object the README is stamped
from, so the passport cannot describe a different run than the document beside
it. The source digest is recorded where the loader verified one and left null
otherwise, which the passport reports as unavailable rather than as an absent
field that might have held a value.

It is called a tamper-evident provenance record. A recipient who rehashes the
raster can tell whether the file they hold is the one this analysis produced.
Nothing here proves who produced it, and a test asserts the document claims no
signature. The eager shell is unchanged at 805 KiB. Covered by
`tests/demPackageReadme.test.ts`.

### L17 · FIXED · EVIDENCE

The evidence boundary inspector was implemented, tested and unreachable. Its
register entry asked for a provenance or report surface that renders the
field-by-field breakdown and calls it from the application graph.

The DEM README now carries an evidence contract section: the claim the artifact
belongs to, what that claim carries before any study is considered, what it
resolved to here, the resolution state, the matched study or none, and the
verdict. Where a scoped study matched, each envelope field it was checked
against is listed with its status.

Section 49's condition is that the view must not implement its own
applicability logic, and it does not: `buildEvidenceContractView` resolves
through `resolveEvidence`, the same resolver the provenance block is stamped
from. A test asserts the two agree, so the section cannot contradict the
decision it describes. Covered by `tests/demPackageReadme.test.ts`.

### L40 · NOT REPRODUCIBLE · ARCHITECTURE

Section 58 asks that AnalysePanel separate running an analysis from presenting
it, and names operation execution among the things it should not own. The panel
runs no analyses. Every await in it loads an export writer: the DEM package, the
contour deliverable, the terrain report, the map sheet. What it orchestrates is
export, not computation, so the coordinator that section describes has no
operation to coordinate.

Section 92's snapshot is already there. Each export captures the result, the map
context, the basename and the evidence permit before the writer chunk loads, and
a comment on the first of them says why: so the raster and its sidecars describe
the scan the result came from. The bytes are built from one coherent capture.

What is missing is the revalidation section 92 asks for after the expensive work.
Its consequence is narrow: because every input was captured together, a file
written after the active dataset changed is internally consistent and describes
the dataset it was started for. It arrives unexpectedly rather than wrongly, so
section 104's mixed revisions do not reproduce here.

The module is 2,911 lines with a fan-out of 23 and is worth splitting on its own
merits. It is not split here, because section 97 rejects an extraction that moves
lines while the new module imports the same dependencies and owns the same
state, and no reproduced defect points at a seam.

### L41 · FIXED · ARCHITECTURE

Section 89 asks that every staged module be graduated, kept staged with a
reason, or removed. Three graduated this cycle through the DEM export path: the
DTM product digest, the artifact passport and the evidence boundary inspector.
Each had a register entry naming integration conditions rather than missing
behaviour, and each condition was met rather than waived.

Nineteen remain staged. Six are the registration stack, which section 90 keeps
whole: a half-wired alignment tool is worse than none, and the workflow it needs
is not built. The rest carry their own graduation conditions in the register,
and the register is enforced, so none of them is unclassified code.

### L42 · DEFERRED · UI

Section 70 forbids substituting mouse simulation for touch verification, and
section 101 wants a recorded matrix of engine versions with pass, skip and fail
counts. That evidence comes from running the suite on real engines, which the
CI matrix does on push and a local session cannot. Recording a matrix from here
would be inventing it.

### L43 · FIXED · STATE

The first fix for L29 set a flag before the heavy bridge ran and cleared it on
the returns that meant the file was not routed out of core. A throw from inside
the bridge reached neither, so the flag stayed set and the failure path closed
whatever streaming scan was on screen. That is the defect L29 was about,
re-entering through the path L29 did not cover.

The tidy-up observes instead of predicting. It records whether a streaming scan
was already on screen when the open began, and on failure closes one only if a
scan is there now that was not there then. A flag has to anticipate every exit;
a comparison of before and after does not.

The test that covered the mid-flight case was passing for the wrong reason: its
fake rejected without attaching anything, so there was nothing to tidy and the
assertion could not tell the two situations apart. It attaches before it
rejects now, and the router harness returns one stable viewer rather than a
fresh object per call, which is what let the earlier version pass. Covered by
`tests/openScan.test.ts`.

### L44 · FIXED · LIFECYCLE

`NavBar.dispose` ran its teardown group and then cleared its hint timer. The
group runs every teardown and rethrows the first error one raised, so a listener
detach that threw left the timer armed on a disposed nav bar.

The timer is cleared first. The group's rethrow is the contract, not a defect:
it reports a failure without stranding the teardowns that follow it, and an
owner with its own cleanup orders around it. Covered by
`tests/disposableGroup.test.ts`.

### L45 · FIXED · ARCHITECTURE

The directory skip in `lint-standards-truth.mjs` was an unanchored alternation,
`node_modules|\.git|dist|release$`. Only the last branch was anchored, so `dist`
matched any path containing those four letters and `release$` matched
`docs/release`, whose two documents were never scanned. CodeQL reported it as a
missing regular-expression anchor on the pull request.

A lint that stops reading files prints the same clean line as one that read them
all, which is the failure this repository's other guards are written to avoid.
The skip matches whole path segments now, and the packaged output is excluded by
its path from the repository root rather than by a substring. The scanned count
moved from 925 to 927, which is the two documents. Covered by
`tests/standardsTruthLint.test.ts`.

### L46 · OPEN · PERFORMANCE

`Viewer.buildPointMesh` sets `frustumCulled = false`, and `StreamingRenderer`
builds every resident COPC node through that same function. A node held warm in
the streaming cache is therefore submitted for drawing whether or not it is in
front of the camera.

Residency and visibility are separate decisions, and the streaming scheduler
already knows each node's bounds. The change is bounded but not free: bounds
have to be correct under render-origin shifts and large coordinates, and a false
negative would hide visible data, so it needs the culling tests before the flag.

### L47 · OPEN · UI

`localDensitySize.ts` hashes points into a 2D voxel grid keyed by x and y. On a
vertical facade or a terrestrial scan the points of one surface collapse into
few cells, so the surface reads as dense and its points are sized down, which is
the opposite of what the mode is for.

Sizing from projected sample spacing rather than plan-view density would be
orientation independent. It is a display attribute either way and touches no
measurement.

### L46 · PARTIAL · PERFORMANCE

`Viewer.buildPointMesh` sets `frustumCulled = false`, and `StreamingRenderer`
builds every resident COPC node through it, so a node held warm in the cache is
submitted for drawing whether or not the camera contains it. Residency and
visibility are one decision where they should be two.

`nodeFrustumCulling.ts` makes the decision from the node's own bounds. It is
pure arithmetic with no three.js, so the part that can be got wrong silently is
testable without a renderer: eleven tests cover a node inside, outside on each
of six sides, straddling a plane, enclosing the camera, touching a plane
exactly, and a survey-coordinate node that is culled by its raw bounds and drawn
by its render-frame ones. The arithmetic errs toward drawing, because a false
positive costs a draw call and a false negative hides what the user is looking
at.

`docs/validation/streaming-cull-baseline.json` measures what the current
behaviour costs over four stored cameras: an overview draws all 84 resident
nodes, a half-panned view 68, a corner view 24, a narrow view 12.

The record states what those figures do not support, because a share of nodes
reads like a share of work and is not the same quantity. A node costs what its
points cost and these nodes carry none, so the drawn share is not a GPU saving.
The scene is three uniform grids over one area held resident at once, where a
scheduler would hold a level-of-detail selection, so a real drawn share is
likely higher than this one. The stored views are axis-aligned boxes, which is
an orthographic camera; a perspective frustum has slanted sides and would
contain a different set.

The renderer is not wired to it. That step changes what is drawn, and the
evidence for it is GPU frame time on a real device, which this runtime cannot
take. The baseline says so rather than recording a zero. The module is staged
with that as its graduation condition.

### L48 · FIXED · PERFORMANCE

The GPU figure was one constant, `BYTES_PER_STREAMING_POINT = 24`, documented
as an instanced position and an instanced colour. The mesh builder uploads more
than that: a classified cloud binds `aClass` and one carrying intensity binds
`aIntensity`, both Float32 per point. A cloud with either was reported at 28 of
its bytes as 24, and a cloud with both at 32 as 24, which is three quarters.

A fixed number cannot follow a layout that varies per cloud, so
`pointAttributeLayout.ts` describes the layout and the figure is derived from
it. The constant is still there for the budget arithmetic, which reasons about
a point's minimum, but it now reads from the layout rather than restating it,
and `estimateGpuBytes` takes the channels a cloud actually uploads.

The breakdown sums to the total by construction, so a readout showing where the
bytes went cannot disagree with the figure beside it.

The capability alone did not change the readout. Both callers still passed
nothing and so still took the floor, leaving the figure exactly as wrong as
before. `StreamingRenderer` now reports which channels its
resident meshes uploaded, read from the decoded chunks rather than from a flag,
and the two callers ask for it. A caller that cannot name the channels still
gets the floor, which is the honest answer for one that does not know. Covered
by `tests/renderMemoryAccounting.test.ts`.

### L49 · MEASURED · PERFORMANCE

The same reading shows what the uploads cost against what the source carries. A
colour is three bytes in the file and twelve in the buffer, a classification one
byte and four, an intensity two bytes and four. That is fourteen bytes a point
of expansion, against a 32-byte point.

Packing them back to their source widths is a real saving and a real risk:
classification codes have to survive as exact integers, colour has to keep its
transfer function, and both backends have to agree. Measuring it first is why
the accounting above came first.

Two of the three packings save nothing as the renderer is built. Each attribute
is uploaded as its own instanced buffer, and WebGPU requires a vertex buffer's
stride to be a multiple of four bytes, so a one-byte classification and a
two-byte intensity cannot occupy less than four. Narrowing either leaves the
buffer the size it already was. Only colour crosses a stride boundary: three
bytes pad to four, against the twelve it takes now.

The saving available without changing the layout is therefore eight bytes a
point, all of it colour, and colour is the attribute carrying the sRGB transfer
function. Taking it means the piecewise EOTF that `colorEncode.ts` holds as one
seam has to run in the shader instead, matching the 256-entry table exactly. The
rest of the expansion is reachable only by interleaving the four attributes into
one buffer, which reaches twenty bytes a point against thirty-two.

Against the desktop budgets, in the 1024-based units the overlay prints: 76.3 MB
at 2.5M resident points today, 57.2 MB with colour packed, 47.7 MB interleaved.
At the 8M setting, 244.1 MB, 183.1 MB and 152.6 MB.

Neither change is made here. No attribute in the tree is anything but Float32,
and `Viewer.ts` records one case where the two backends did not agree about a GPU
primitive: the point size WebGPU locked to a single pixel, which the quad sprite
exists to work around. Settling it needs a parity measurement on both backends on
real devices, against the 256 values of the sRGB table. The browser evidence this
release carries is Chromium-blocking with the other engines advisory.

### L50 · FIXED · CORRECTNESS

A third caller of `estimateGpuBytes`, the one building the renderer stats inside
`Viewer`, still passed no channels and so still took the floor, while its comment
said it used the streaming layout's own per-point cost. It reported a classified
cloud carrying intensity at 24 bytes a point instead of 32. The channel set was
already in scope a line above it.

### L51 · FIXED · CORRECTNESS

The `density` point-size mode hashed points into a grid keyed on x and y. A
near-vertical surface has almost no extent on one of those two, so a facade
collapsed into a sliver of cells and every point left the clamp at one end.

Measured on a 20 m by 12 m wall sampled 300 by 300, sweeping how much depth the
surface carries. The severe case is a cloud cropped to a flat surface, where the
only depth is scanner range noise: at 5 to 10 mm of depth extent, which is a half
millimetre to a millimetre of sigma across ninety thousand samples, every point
sat on the 0.5 floor. A mathematically flat plane put every point on the 2.0 cap
instead. Both draw the whole scan at one size, and the floor case renders the
surface thinner than a fixed size would have.

The error fades as the surface gains relief. Masonry roughness at 50 mm sized
every point at 0.647, undersized but off the clamps, and a facade carrying window
reveals or balconies, 0.3 m of depth and beyond, already sat within 5 percent of
nominal. What this corrects is the cropped plane and the near-planar patch, not
every terrestrial scan.

The grid now keys on the cloud's widest two axes. The same sampled surface laid
flat and stood upright now produces the same scale for every point to six
decimal places, so a surface is sized by how it was sampled rather than by how it
happens to be turned. Terrain still resolves to x and y: the existing assertions
passed unedited, apart from one that compares the whole returned object, which
now carries the axis pair.

Density sizing stays a display multiplier on `aSize`. Its one caller builds that
attribute, and no analytical density reads it.

### L52 · PARTIAL · ARCHITECTURE

The Continuity Field reuses work between frames, so it needs one answer to
whether the previous frame's work still describes the same picture. That is the
display epoch, and it is the first piece of the subsystem because every other
capability depends on it.

`src/render/continuity/continuityField.ts` holds it. The module is pure and
imports no three.js, the way `refinementPhase.ts` keeps its maths out of the
Viewer. A camera matrix or a clip volume arrives already reduced to a string by
whoever owns it, so the core stays testable in Node.

History must not survive a change that alters what a pixel means, and must not
be discarded by a change that does not. The second is the easier one to get
wrong, so the inputs are a fixed record of seventeen fields rather than an open
bag. Adding a field makes it invalidating and leaving one out makes it
irrelevant, which puts everything that can throw away history in one reviewable
place and leaves a panel opening structurally unable to reach it. A test covers
each of the seventeen.

Each epoch carries the state that opened it, so the caller cannot hand back a
previous state that disagrees with the key and get a diff against something that
was never in force. Epoch numbers are monotonic, so returning to an earlier
display state opens a new epoch rather than reviving the old one and a buffer
carrying a stale number stays recognisable. Field values are length-prefixed before joining, so a camera
of `a|b` beside an empty projection cannot spell the same key as a camera of `a`
beside a projection of `b`.

All six capabilities are off. Nothing constructs a `DisplayState` yet, so the
module is registered staged, and it graduates when a capability turns on and the
render loop gates a reused frame on `advanceEpoch`. Nothing the subsystem
produces may reach picking, measurement, terrain, export or claim evidence.

### L53 · FIXED · CORRECTNESS

The streaming-cull baseline asked whether its record existed and then read it.
Two answers about one file, which can disagree, and CodeQL reported it against
the branch. The read now stands alone and absence comes from the read itself. A
missing file is the only case treated as no previous record: a corrupt or
unreadable one throws, because overwriting a baseline the gate compares against
would hide the difference the record exists to report. Verified by removing the
file and rerunning, which rebuilt it whole.

### L54 · FIXED · ARCHITECTURE

The display epoch invalidates on every change the programme names, and the test
that walked the fields could not prove it. It iterated whatever `DisplayState`
contained, so deleting a field would have shrunk the set it checked and still
passed.

The sixteen named triggers are now pinned to fields by name, and the two sets
are compared both ways. Dropping a trigger fails, and so does adding a field
that invalidates without being named. Deleting the EDL field from the state
fails two assertions rather than quietly reducing the count, which is how the
guard was checked.

Nothing else was needed for the epoch itself. The record built for the core
already covers all sixteen, with a viewport resize reaching both the width and
the height, so this phase closed a hole in the proof rather than adding a
mechanism.

### L55 · PARTIAL · ARCHITECTURE

Drawing a subset of points per frame and accumulating them needs a partition
that holds still. A point that moved between subsets while the image was being
built would appear and disappear, so the phase is a function of the point's
identity and nothing else, with no frame number in it.

No new hash was written. `fadeHashUnit` already spreads instance indices over
the unit interval by a golden-ratio sequence, is already tested in Node, and is
already mirrored exactly in the size graph, so the shader and the CPU agree on
it today. A second hash would have been a second thing to keep in step. The seed
shifts that sequence by whole steps, so two nodes stop agreeing about which of
their points are in phase zero merely because both number from zero.

The first version clamped the top of the range against a hash near one rounding
up to the phase count, which would name a phase no frame draws and drop the
point from the image. Removing the clamp broke no test, which is the reason to
look rather than to leave it: scaling a double by a power of two shifts its
exponent and rounds nothing, so a hash below one stays below the count and the
floor cannot reach it. The clamp could not fire. It is gone, the reason is
written down, and a test pins it at the largest hash below one. That reasoning
holds only because the count is a power of two, which is all the type admits.

Registered staged. It graduates when accumulation turns on and the size graph
folds the phase in as its own node. It cannot ride on the fade dither:
`endNodeDissolve` drops that fold once a node settles, which is exactly when
accumulation matters.

### L56 · PARTIAL · PERFORMANCE

Most of what this phase asks for is already running. The backing store drops to
0.85 of full resolution while the camera moves, the streaming scheduler takes
half its node budget, and the scheduler carries its own frame-time pressure
term. History is already dropped on camera movement, because the camera is one
of the display inputs and moving it opens a new epoch.

That last point is also why the remaining idea does not pay what it appears to.
Every frame of a movement is a new epoch, so drawing a subset of phases while
moving accumulates nothing. It is decimation, and it costs coverage in the frame
being looked at, on top of two reductions already applied to the same frames.
The three multiply.

So the shipped default draws every phase and changes nothing. A caller that
wants to trade coverage for frame time asks for it, and a smaller default
belongs here once a real device has been measured.

The compensation for a subset is bounded rather than exact. Samples on a surface
spread over two dimensions, so drawing a fraction of them widens their mean
separation by the inverse square root of that fraction, and scaling the footprint
by the same amount restores the area covered. That is the upper bound, not the
default: a point wide enough to cover its neighbours' ground is wide enough to
cover a real hole in the data.

A count that was not a finite number produced an empty set rather than a clamped
one, because a comparison against NaN is false and both clamps passed it through.
That is a blank frame arriving by the route the clamp appeared to cover. It is
caught before the clamp now, and removing the guard fails three assertions.

### L57 · PARTIAL · ARCHITECTURE

A parked camera contributes one temporal phase per frame until every phase has
been drawn once, and then stops. The stopping is the part worth having: once
every phase has contributed there is nothing left to add, and a renderer that
kept issuing accumulation work would spend a GPU on an image that cannot change.

Convergence is reported the frame after the last phase is drawn, which is not an
off-by-one waiting to be tidied. On the final drawing frame a phase is still
owed, so a schedule that called itself converged there would report nothing to
draw and that phase would never reach the image. A test holds the machine
unconverged for as long as a phase is outstanding, and a second one checks that
the set of phases drawn before it reports converged is the whole set.

Motion returns the sweep to idle rather than pausing it, because the frames
already contributed were drawn against a camera that has since moved. An epoch
change restarts it even with the camera still: a colour mode or a filter changes
what a pixel means without anyone touching the camera.

Counted in frames, not milliseconds. How long a sweep takes is a property of the
device, and a wall-clock figure written here would describe hardware this module
never sees.

### L58 · PARTIAL · CORRECTNESS

Accumulating a point cloud by colour alone would average a foreground sample
with the background showing between its neighbours, inventing a surface in the
gap. So the history carries depth, and a sample joins what is already at a pixel
only when the two lie on the same surface. Otherwise the nearer one takes it.

Depth is compared as a ratio rather than a difference. A tolerance in world
units is far too loose beside the camera and far too tight across a valley, so
one number cannot serve both ends of a scene. Comparing logarithms makes the
tolerance proportional, which is what a cloud spanning metres to kilometres
needs, and a test fixes the same fractional gap as compatible from five
centimetres out to a million metres.

Two guards earn their place. A depth of zero or less has no logarithm, and
letting one reach `log2` yields a difference of infinity or NaN; since NaN fails
every comparison the answer would come back "not the same surface" for a reason
unrelated to the surfaces. And an empty pixel is decided by its weight, not its
depth, so a buffer cleared to a stale depth cannot make the first sample lose to
nothing.

The tolerance is a starting value. The figure that survives near geometry and
distant terrain has to come from a real scene, so nothing here claims it is
measured.

### L59 · PARTIAL · CORRECTNESS

Drawing a cloud as sprites leaves single-pixel holes across a surface that is
continuous in the data, and closing them reads as a surface rather than a screen
door. One pixel further out is the same operation applied to a gap that is not a
sampling artefact but the absence of data, presented as though something had
been measured there. Four rules hold the two apart.

A pixel already carrying a sample is never touched, so this pass blurs nothing
measured.

A gap closes only when neighbours on opposite sides agree, left with right or
above with below, or when three of the four cardinals do. A single neighbour, or
two adjacent ones, is a corner or an edge; nothing spans the pixel.

Supporting neighbours must lie on one surface, judged by the depth rule the
accumulation pass already uses rather than a second one written for this. The
comparison is pairwise, because a chain of individually close neighbours can
otherwise span any depth at all and weld two surfaces that never touch.

A reconstructed pixel is never evidence for another reconstruction. Without that
each pass seeds the next and a fill creeps outward across sparse geometry, a
pixel per frame, until a hole has become a surface. Support traces back to a
sample in every case, and removing the rule fails two assertions rather than
quietly widening what the pass will do.

Refusals are typed rather than a bare false, so a pixel left alone can say
whether it was occupied, unsupported or sitting on a discontinuity. The fill
depth is the nearest supporting neighbour: they already agree within tolerance,
so it barely moves the value, and the nearest keeps a filled pixel from sitting
behind the surface it belongs to.

### L60 · MEASURED · ARCHITECTURE

The programme asks for the EDL ordering to be settled experimentally. Two of the
arrangements are settled before any experiment runs, because they are wrong
rather than merely worse.

EDL ahead of accumulation would shade each partial image and then accumulate
what it shaded, so the result carries shading computed from several different
partial depth buffers and corresponds to no single depth image. EDL ahead of gap
closure would read the seams between splats as depth discontinuities and trace
them, which is the hole artefact the programme asks to remove. Samples, then
accumulation, then closure, then EDL. What a device would settle is how much the
difference is worth, not which way round it goes.

There is one EDL implementation, pure in `edl.ts` and mirrored in the size graph,
so nothing here adds a second.

The useful finding is a collision rather than an order. `edlMotionGate` runs EDL
only while the camera is parked, and the Viewer forces exactly one repaint the
moment motion stops. That moment is the first frame of a convergence sweep, so
EDL would shade an image one phase complete and never run again. Nothing is
broken while accumulation is off, so this is recorded against the convergence
module's graduation rather than patched now.

### L61 · PARTIAL · CORRECTNESS

The field draws pixels no point was recorded at. The lens is how that gets
checked: under it nothing is substituted, so what remains is coverage the data
paid for.

The edge is a decision, not a decoration. A lens that faded reconstruction in
across its rim would leave a ring of partly invented pixels, and a viewer holding
it over a doubtful patch is often reading that exact band, so the instrument
would be least trustworthy where it is most used. Coverage softens how the two
renderings blend; it never softens whether a pixel may be invented. That decision
is hard and reaches the outer edge of the feather rather than the radius, which
errs toward showing less than the field would. Tying it to the soft value instead
fails three assertions.

Nothing in the module takes or returns a coordinate anything could measure with,
so the rule that picking is unchanged whether the lens is open or shut holds by
construction rather than by comment.

### L62 · PARTIAL · CORRECTNESS

The claim that the field closes seams and never paints across unrecorded ground
is countable. Tally drawn pixels by where the colour came from, and a test fails
on the share rather than on somebody reading a screenshot.

The denominator is the decision. Measured against the whole frame the same
reconstruction shrinks by pulling the camera back until most of the image is
background, which is the one direction this number must not be easy to move.
Against drawn pixels it answers what is being asked: of the surface in view, how
much was not measured. A frame that drew nothing reports no share rather than a
clean one, so an empty view cannot pass as a good result.

The ceiling is a starting value. Closing single-pixel seams touches a small
minority of drawn pixels and a fifth of the visible surface is well past a seam,
but the figure that belongs there comes from real scenes at several densities.

### L63 · FIXED · CORRECTNESS

Parity between the current renderer and the field was asked for as a comparison
of measured values with the field off and on. That comparison passes today for
the uninteresting reason that the field is off, and would keep passing until
somebody wired reconstruction into a coordinate.

The guarantee holds for a better reason, which a test can hold to. Nothing on
the measurement path reads a rendered pixel: an inspected point is resolved from
the stored positions, and the only readbacks in the tree are the terrain compute
reading its own buffers and the exporters capturing the picture. A reconstructed
pixel therefore cannot become a coordinate whatever the renderer does. The test
asserts exactly that, and putting a readback into `InspectTool` fails it by name.

The first version swept the whole tree against an allowlist and flagged three
image compositions, one of which was not a call at all: the matcher took
`composeClassScopeBannerOntoBlob(` for a `toBlob(` because the name contains it.
A guard that flags every legitimate canvas in the app gets widened until it means
nothing, so it is scoped to the modules that turn a pointer into a coordinate,
and a case pins the matcher against that identifier.

### L64 · OPEN · CORRECTNESS

The exporters are the leak this phase found. `BaseExportMode` captures the live
on-screen canvas with no offscreen pass, and six raster exporters go through it:
depth, contour, normal, intensity, height, orthographic RGB. With
reconstruction on, a height or depth raster would carry invented geometry, and
those files are offered for machine learning datasets and geometry review.

Nothing in `FigureStampContext` would record it. The stamp carries the reference
system, the colour mode, the palette, the camera and the clip, so a raster
containing reconstructed pixels would be indistinguishable from one that does
not.

Nothing is wrong today, because the field is off and no pixel is reconstructed.
The constraint is recorded against the reconstruction module's graduation so it
is read before the field is enabled: either a capture turns the field off, or
the stamp declares the reconstruction.

### L65 · PARTIAL · PERFORMANCE

Three surfaces persist between frames: the colour built so far, the depth it was
built at, and each pixel's support. Asking for a 32-bit float for all three is
the easy path and costs twenty-four bytes a pixel against nine.

Measured at device-pixel sizes, since the ratio is already in that figure and a
CSS size understates the allocation fourfold. At 1080p the conservative layout
takes 17.8 MB against 47.5. At 1440p, 31.6 against 84.4. At 4K, 71.2 against
189.8. At 4K with a doubled ratio, 284.8 against 759.4.

The case most easily missed is the tablet. A 2388 by 1668 panel at a doubled
ratio is 15.9 million device pixels, more than a 4K monitor's 8.3 million, so it
costs 136.8 MB conservatively and 364.7 at full float. That is the device least
able to survive the second figure, reached by reasoning about panel names rather
than pixels.

Eight bits a channel carries the colour, and that follows from the sweep being
four phases rather than hundreds. Rounding compounds across an accumulation, so
a photographic one needs the headroom; this one takes a handful of contributions
per pixel and stays under what an 8-bit display resolves. If the phase count ever
grew into the hundreds this is the choice to revisit.

Depth is the one that cannot be economised. The merge rule compares depths as a
ratio across a scene spanning metres to kilometres, and a half float carries
about three decimal digits, so it would collapse the distinctions that rule
exists to draw.

Above the ceiling the field declines and leaves source rendering in place. 4K at
a doubled ratio passes it even at nine bytes a pixel, which is the right
outcome: no history is a worse picture, a history that will not fit is a lost
context.

A ratio change already invalidates, because the ratio is one of the display
inputs and moving it opens an epoch.

### L66 · PARTIAL · ARCHITECTURE

Falling back has one rule worth enforcing: a lower rung may do less than the one
above it, never something else. A ladder that swapped a capability as it
descended would change what a viewer is looking at rather than simplify it, and
two machines would then disagree about the picture for reasons neither could
see. Each rung's capabilities are a subset of the rung above and a test walks
the ladder to check it, so the property is held rather than described.

The lens is not a rung. Reconstruction puts pixels on screen no point was
recorded at, and the lens is the only way to see which, so it arrives with
reconstruction and cannot be traded for performance. Dropping it from the
closure rung, which is the obvious economy, fails an assertion. A tier that
invented geometry and offered no way to check would be worse than the tier below
it doing less.

Culling and attribute packing appear on no rung. They change how much work is
done rather than what is drawn, so they are gated on their own evidence instead
of riding a visual ladder.

What a backend supports is reported by whoever asked the device. The programme
forbids brand lists, and a model string says nothing dependable about a driver.
The bottom rung is the renderer as it ships, because none of this is worth
failing a viewer over.

### L67 · PARTIAL · PERFORMANCE

The renderer already adapts to frame time. The streaming scheduler concedes
budget after two seconds slower than 45 frames a second and takes it back after
five seconds faster than 55, and that band was tuned.

So this phase adds a mapping rather than a second controller. Two loops reading
one frame time through their own numbers would both give ground for a single
stutter, correcting twice for one problem, then recover together and oscillate
in step, which is the tier hunting the programme asks to avoid arriving through
the fix for it.

The band now has one definition. It moved to `streamingBudget.ts`, which both
consumers already import, and the scheduler reads it from there instead of
holding its own copies. The scheduler's forty-seven assertions pass unedited,
so the values did not move.

Conceding quickly and recovering slowly is the whole mechanism, and it is
covered rather than described: collapsing the two holds into one fails two
assertions, including a device that alternates a qualifying slow spell with a
nearly qualifying fast one, which walks down to source rendering instead of
sitting on a rung it cannot hold.

Capability and performance stay separate questions. The ceiling is what a
backend can carry and does not move with frame rate, so a tier above it is
clamped whatever the frames are doing, and a device is never promoted into
something its backend cannot run by going fast. Ground is given one rung at a
time, so a single bad second does not cost every capability.

A reading of the scheduler's pressure state looked at first like a swapped pair
of timestamps. It is not: the fields are named for frames per second while the
thresholds are frame times, so the slow branch measuring `_fpsLowSinceTs`
against the back-off hold is correct.

### L68 · DEFERRED · PERFORMANCE

Choosing the phase count per scene is held, on the programme's own terms: it
asks that no adaptive logic be added until fixed behaviour is validated, and
fixed behaviour has never run. Accumulation appears enabled in one tier
definition and is selected nowhere, so no sweep has happened on any device.

Picking a phase count now would tune against nothing and
bake a guess into the one part of this that a measurement can settle cheaply
once a sweep exists. It waits for that.

### L69 · PARTIAL · CORRECTNESS

How well a pixel is backed by nearby samples, and whether that is enough to
fill it.

The name carries weight here. This viewer already reports confidence about
measured things in the measure panel, the analyse panel, the findings list, the
object panel and the contour workspace, and those numbers say how well something
was surveyed. This one says how safe a pixel is to draw. Sharing the word would
put the two beside each other in one interface reading as the same kind of
claim, so the module says support throughout and a test strips the comments and
fails on the other word.

The parts combine by their weakest rather than their average. A pixel bracketed
by many samples that disagree about depth is on an edge, and one with perfect
depth agreement and almost nothing under it is a guess; a mean lets either be
carried by the other into a fill. A thousand samples and a complete sweep still
do not rescue a pixel whose neighbours disagree, and averaging instead fails
four assertions.

An input that is not a number scores nothing rather than everything. A count of
NaN means the caller does not know, and not knowing must never arrive as
permission to invent.

The threshold errs high. Refusing costs a visible gap and allowing wrongly costs
a surface that was never there, so it sits well above half. That figure and the
sample count are starting values; what belongs there comes from real scenes at
several densities.

### L70 · DEFERRED · PERFORMANCE

Re-measuring the point kernel waits on its own opening condition: it asks that
the radius be re-benchmarked once continuity reconstruction exists, and nothing
reconstructs. Its comparisons are also a device's to make. Cost on the GPU,
silhouette sharpness, shimmer between frames and leakage at an edge are all
properties of a rendered image, and none can be settled from arithmetic.

### L71 · PARTIAL · CORRECTNESS

Depth cannot tell a hole in the sampling from a fold in the surface. Two points
either side of a roof ridge sit at almost the same distance from the camera and
pass the depth test comfortably, so filling between them lays a flat patch
across the ridge. Where normals exist they settle it, because the two sides face
different ways.

Normals only ever refuse. They cannot turn a refusal into a fill, so every fill
still has to satisfy depth and support on its own and adding a normals channel
to a dataset can only make the renderer more careful with it. A case walks a set
of configurations and holds that property for each.

Agreement is checked between every pair rather than along the sequence. Normals
stepping from nought to fifty-eight degrees in two hops each agree with the next
under a thirty degree threshold while the outer two are nearly sixty apart, a
curve being walked across in steps, and comparing in order glues the whole fan
together. Doing it that way fails an assertion.

Opposite directions are not agreement. A flipped normal describes the surface
seen from the other side, and welding those is the fold this exists to catch.

A cloud with no normals is the ordinary case rather than a degraded one. Most
survey formats carry none and the field has to work without them, so absence is
silence: treating it as objection fails three assertions. A normal that is
present and unusable refuses instead, because the channel claimed to know and
did not, which is how a support score of NaN scores nothing.

Nothing here computes a normal. Fitting one to a neighbourhood mid-frame would
invent the quantity being used to check an invention.

### L72 · FIXED · UI

Choosing density point sizing on a streamed scan did nothing. The chip lit, the
mode was set, and the sizing stayed exactly what adaptive produced.

Three things made that so. `setPointSizeMode` builds the per-point size
attribute for the static clouds only, a streamed material carries no such
attribute so `pointSizeBaseNode` degrades it to the plain adaptive node, and the
one spacing-aware term a streamed node does have is multiplied by a phase gain
that reaches zero at `full-refine`. A settled streaming view had no sizing from
spacing at all.

A streamed node has no points of its own to count, but it does know the spacing
its source recorded, which is what the programme asked to use. So the fold that
already carries a node's relative resolution now carries a second term that does
not fade, and `nodeCoverageScale` is its arithmetic. A frontier mixes nodes from
several depths, and without this the coarse ones read as speckle beside the fine
ones however long the camera sits still.

It applies in density mode alone, so adaptive and fixed are untouched and the
only behaviour that moves is a mode that previously did nothing. Its bound is a
separate constant from the compensation bound. The two start equal and mean
different things, and tuning one for its own reason must not move the other.

Phase-gating the new term, which is the defect being fixed, fails five
assertions.

An existing case counted the uniforms the fold allocates. It now expects the
second shared one and also checks that a third material adds one uniform and no
further shared ones, since a per-draw uniform here would rebuild the pipeline on
every write.

This is the first capability in the continuity work to reach a rendered frame.
The rest remain staged.

### L73 · FIXED · PERFORMANCE

The convergence schedule began the moment the camera stopped, which is not the
moment the picture stops changing. Parking enters the first of three refinement
phases, and the scheduler is still admitting nodes through all of them, at three
quarters of its budget and then nine tenths.

Every node that arrives changes the visible frontier, and the frontier is one of
the display inputs, so it opens an epoch and the sweep starts again. Correctness
was never at stake, because that is the epoch doing its job. The cost was: a
sweep would restart for as long as refinement continued and never finish, and
every frame it contributed was thrown away. That is the waste the terminal
converged state exists to prevent, reached from the other end.

It now takes the refinement phase the scheduler already publishes instead of a
bare moving flag, and waits for the last one. Starting earlier buys nothing,
because the epoch will discard it. Beginning at park, which is what it did, fails
four assertions.

Nothing else in this phase needed writing. Improving node coverage and favouring
the centre of the view are what the scheduler's selection factor and focus
strength already do, and a continuity layer repeating them would be the second
scheduler the programme forbids.

### L74 · FIXED · SCIENTIFIC

A reconstructed view can be beautiful while the source stays incomplete. The
field decides which pixels came from samples, which were carried between frames
and which were filled in, and none of that says whether the points that exist
are all the points there will be.

The separation already held. A stockpile figure caps at preview when the source
is not proven complete, and the function that decides it says so plainly:
footprint support is geometric and tells you nothing about whether the cells
were filled by every point there is. The reduced-view test reads resident count
against source count, which is a fact about points rather than pixels.

What was missing is anything stopping that from eroding once a sweep can report
itself converged, because the words for these ideas sit close together. So the
separation is now structural: the code that decides what a figure may be called
cannot import the code that decides how a frame was drawn, and the reverse holds
too. Letting a convergence check into the authority module fails the first
assertion.

The behaviour is pinned beside the structure. An incomplete source caps at
preview however good the footprint, a refused coverage stays withheld whatever
the source, and a display sample caps the figure as well, since deciding to draw
fewer points is a presentation choice and not a property of the ground. Removing
the incomplete-source cap fails the behavioural assertion rather than only the
import one.

### L75 · PARTIAL · PERFORMANCE

Most of what this phase asks for was already on the developer overlay: resident
and visible nodes, the queue, resident points, frame time, the longest task, the
effective ratio, and the per-attribute upload bytes this cycle added. The
metrics that are missing are missing because the thing they would measure does
not run. There is no temporal phase to report while nothing accumulates, no
convergence to show progress on, no reconstructed share while nothing is filled
in, and no settle time until a sweep exists to settle.

One of them can be answered now, and it is the one worth having early: what a
continuity history would cost on this device, in this window, and whether it
would fit. That is decision-relevant before anything is switched on rather than
after, because on a high-ratio panel it is the figure that settles whether the
feature is possible at all.

The overlay takes it from the backing store in device pixels rather than the CSS
size, which understates a doubled ratio fourfold, so `FrameStats` now carries the
store's dimensions. Adding those took lines from a file that may only shrink, so
five accessors collapsed to pay for them and the baseline was re-banked.

`historyBudget` has left the unreachable register. The overlay reaches it, the
lint said so before this entry was written, and the register describes what the
application does not pass through. It is the second thing in this programme to
graduate, after coverage sizing, and the first of the continuity modules.

### L76 · FIXED · CORRECTNESS

The Windows leg failed on a test written in this cycle. It read a source file
through `new URL(..., import.meta.url).pathname`, which on that platform returns
`/D:/a/...`; Node resolved the leading slash against the current drive and opened
`D:\D:\a\...`, which does not exist.

It is wrong in a way that hides. On a POSIX machine `.pathname` returns exactly
what `fileURLToPath` returns, so the test passed here and on the blocking leg,
and only the advisory Windows job could see it. The same mistake was in two more
tests from this cycle, one of them already pushed, neither of which had run on
that leg yet. All three now use `fileURLToPath`, which is what the rest of the
suite already uses.

Fixing three instances leaves the fourth to be written, so the class is guarded:
no file in the unit bucket may derive a filesystem path from `URL.pathname`. The
bucket is the set the Windows leg runs, the guard runs everywhere including
machines that cannot reproduce the failure, and putting the bug back names the
file that carries it. The guard is excluded from its own sweep, because the case
that checks the matcher holds the bad pattern as a string.

### L77 · PARTIAL · EVIDENCE

Metrics for judging whether the field helped or only looked like it did. They
take buffers rather than a canvas, so a case builds a frame by hand and the
answer is the same on every machine. A metric that needed a device would be
unrunnable exactly where it is most useful, which is a test that fails when
reconstruction starts reaching further than it should.

Edge leakage is the one that earns its place. It counts filled pixels whose
drawn neighbours disagree about depth, which is a patch laid across a ridge or a
wall against the ground behind it, and it judges that by the same depth rule the
renderer uses rather than a second one written for measuring.

The programme asks that one figure not be improved while another is ignored, so
the tension is built rather than noted. Filling more raises what a frame covers
and can raise leakage at the same time, and a case shows a single fill doing
both: coverage of measured pixels falls, leakage goes from nothing to complete.
Either figure read alone rewards what the other exists to catch.

Shares answer nothing rather than zero when there is nothing to divide by. A
frame that reconstructed nothing has no leakage rate, and reporting zero would
read as a clean result.

These live under the test tree rather than in the shipped source, so they are
used by the cases that define them instead of waiting to be wired.

### L78 · FIXED · EVIDENCE

The stored cull baseline named its cameras and never defined them. A reader
holding the record could see that a view drew twenty-four of eighty-four nodes
and had no way to rebuild the view, because the geometry lived only in the test
that wrote it. A corpus that cannot be reproduced from its own artifact is not
serving the purpose a corpus has.

Each case now publishes its projection, half extents and depth range beside its
result, and the planes are derived from those same numbers, so the published
definition cannot describe a different view from the one measured.

What this is remains narrow, and the record already said so before this entry:
the views are axis-aligned boxes, which is an orthographic camera, over a
synthetic scene of three uniform grids. A corpus of the kind the programme
describes needs cameras bound to real datasets and a renderer that can execute
one and produce a frame. Neither exists here yet, and writing definitions
against datasets that have not been rendered would be filling a schema rather
than recording evidence.

### L79 · FIXED · EXPORT

A DEM package defaulted its generation time twice when the caller gave none,
once for the README and once for the passport. Two readings of the clock a
millisecond apart put different times in the two files, so a rebuild from the
same inputs produced different bytes and neither file looked wrong on its own.
It is the defect the PDF builders already carry a note about, in a second place.

The package now reads the clock once and both files take that value.

The test counts readings rather than comparing stamps. Comparing would pass
whenever both readings landed inside the same millisecond, which is most of the
time on a fast machine and none of the time on a loaded one, so the case would
have been a flake that reported the bug as fixed. A second case holds that a
supplied time reads no clock at all.

Two earlier attempts at that test were wrong and are worth recording. Scanning
the archive for timestamps caught the build identity, which carries its own fixed
time and is not a generation stamp. Narrowing the scan to generation stamps then
found none, because the entries are deflated and only an uncompressed fragment
had been visible. The property is about how many times the clock is read, so
that is what the test measures.

### L80 · PARTIAL · ARCHITECTURE

The history's render targets, and who owns them.

Three surfaces or none. A colour history with no depth beside it is the
photographic accumulation this renderer must not do, so they are allocated and
freed together and a partial set is never held.

The distinction worth having is between the two ways a history goes wrong. A
changed display state leaves the buffers the right shape with stale pixels, so
they are cleared and the next sweep writes over them. A changed backing store
leaves them the wrong shape, so they are freed and remade. Treating an epoch
change as a resize would rebuild three textures on every camera nudge and cost
more than the accumulation saves; making that mistake fails an assertion.

A resize frees before it allocates. Holding both sets at once is the moment a
device is most likely to refuse the second, and allocating first fails three
assertions rather than merely using more memory for an instant.

Above the ceiling nothing is allocated and the caller is told which refusal it
was. That is the failure path working: a worse picture beats a lost context. The
same viewport that fits conservatively is refused under the full-float layout,
which is the choice made when the layout was costed.

What the cases cover is how a set is allocated, how it is replaced, and how it is freed, through a
factory that stands in for the device. What they do not cover, and what nothing
here should be read as establishing, is whether a real backend accepts these
formats or samples them correctly. That needs a device on both backends, and
until it has one this is a lifetime with no surfaces in it.

The three surfaces are in the disposal register with an owner, a lifetime and a
trigger, because a GPU resource without those is the defect that register exists
to prevent.

### L81 · PARTIAL · EVIDENCE

The comparison a capability has to survive, written now because now is the only
time it can be written honestly. A rule composed after the measurements is a
rule composed to fit them, and the programme's own line is that a feature does
not graduate because it is visually interesting.

So the rule refuses rather than weighs. A candidate that improves everything
graduates by itself, and one that makes anything worse is refused with the
regression named, because whether a trade is worth taking is a judgement a
person makes with the cost in front of them. Letting a majority of improvements
carry one regression fails two assertions.

A hole is not a pass. Most of these figures need a device, and a comparison
missing one is undecided rather than clean, which is the same reasoning that
gives an empty frame no reconstruction share instead of a share of zero.
Undecided also outranks refusal, so a candidate is never turned down for a
number nobody took. Treating a hole as measured fails three assertions.

The columns are fixed in the source rather than assembled per run, so a later
comparison cannot quietly drop the one it did badly on.

Run against what this release can produce, every metric is unmeasured and the
verdict is undecided. That is the honest standing of the continuity work: no
capability has earned graduation, and none has been refused either, because the
measurements that would decide need a device and a reconstruction pass that
writes per-pixel support. A case asserts exactly that state, so the day it stops
being true will show up as a failure rather than as a memory.

### L82 · PARTIAL · ARCHITECTURE

Six switches for bisecting the continuity work, in the module that already
holds the others and already states the rule they follow: a flag with no
consumer changes nothing. All six are staged and parse-only, and the metrics
export lists them where it lists the other staged controllers, so none can be
read as active.

They default off, for the reason pooled decoding does. A default nobody has
measured on a device is the mistake the multi-layer mount already made once, and
that note was already in this file before these were added.

Six switches is sixty-four combinations, and claiming they all work would be a
promise nobody has kept. The supported set is the tier ladder, which is four
configurations, each a subset of the one above; the rest are for bisecting a
problem rather than for running the viewer. A case holds the arithmetic of that
gap so the claim cannot quietly widen.

The first version used the wrong parse helper. This module reads an absent flag
as on, which is right for a path that already shipped and wrong for every one of
these, so an empty query would have turned all six on while the defaults record
said they were off. Two sources of truth disagreeing about what the viewer is
doing is worse than either answer. The opt-in helper the other off-by-default
flags use fixes it, and putting one flag back on the wrong helper fails two
assertions.

`coverageSizing` needs saying plainly: coverage sizing is live in the renderer
and this flag does not gate it. What is live is reached by choosing density
point sizing. The flag stands for the capability record, which nothing consults
yet, and the module says so where someone would look.

Two existing cases enumerate every flag and its default, so adding these made
them fail until each new default was declared. That is the case working. One of
them was called "all seven flags" and is now called what it does.

### L83 · PARTIAL · ARCHITECTURE

Every way the field can fail has one right answer, which is to do less of it. A
target that will not allocate, a pass that throws, a backend that refuses a
format all mean the same thing to someone looking at the screen: the picture
should be simpler and the application should still be there.

So nothing rethrows, and a failure gives up one rung rather than everything. A
device that cannot hold a history may still close gaps, and dropping the lot on
the first refusal would surrender capabilities that were never implicated.
Repeated failures reach source rendering and stop, because there is nothing
below the renderer that already worked.

The guarantee is narrower than it sounds and worth stating exactly. It is that a
continuity failure does not reach the render loop as an exception. It is not
that the picture is unaffected, which would be false, and not that the failure
is quiet, which would be worse: the outcome names what failed so a diagnostics
surface can report it.

The case that earns its place is a reporter that throws while recording a
failure. That turns a degraded frame into a broken one, which is this module's
own purpose defeated through its own handler, so the report is wrapped too and
letting it escape fails an assertion. A pass may also throw something that is
not an Error, so the cases throw a string, a number, an object, null and
undefined.

A pass returning zero, false or an empty string is a result rather than a
failure, and is returned as one.

Two of the four things this phase asks to protect need nothing here. The dataset
and the measurement tools are out of reach of this subsystem entirely, held by
the parity and authority guards, so a continuity failure cannot put a
measurement wrong however it fails.

### L84 · PARTIAL · CORRECTNESS

The history surfaces would have survived the device they were made on.

`resize` took a size and returned early when it matched, which is what lets a
render loop call it every frame. A device lost and remade at the same window
size gives the same size, so the call was a no-op and every surface stayed,
belonging to something that no longer existed. Surfaces from a dead device are
not a smaller problem than surfaces of the wrong shape. They are the one the
caller cannot see, and the programme names this exact case.

The call now takes the device generation too and remakes everything when it
moves, whatever the size says. Deciding on size alone fails two assertions.

The rest of this phase has no foundation to build on, and that is the finding
rather than an excuse. Nothing in the renderer detects a lost device or a lost
context: there is no handler, no generation counter, and no recovery for the
field to participate in. The generation this now accepts has no source, so it is
a parameter waiting for one.

Building that handler is not a continuity change. It belongs to the renderer's
own lifecycle, it has to be proven against a device that can actually be lost,
and a recovery path written against a device nobody dropped is a guess with a
test around it.

### L85 · FIXED · ARCHITECTURE

The Viewer half of this was already right and is measurable: it is 6,215 lines,
fewer than the 6,222 it carried when this work started, while fifteen continuity
modules were written. Across the whole programme it gained one line to forward a
size mode and two fields on its stats record, and accessor collapses paid for
both. It orchestrates and implements none of the rules.

The filing was wrong. Two modules sat in `render/continuity` and thirteen in
`render/streaming`, which happened by habit rather than by decision: the first
one belonged beside the fade dither it reuses, and the next twelve were filed
next to it without the question being asked again. Someone looking for the
subsystem found two files and had to already know where the rest were, which for
modules nothing has wired yet is most of what they are worth.

All fifteen are in `render/continuity` now, and the couplings that survive the
move are the two that were real. `temporalPhase` reaches for the fade dither
because reusing that hash rather than writing a second one was the point, and
`continuityPressure` reaches for the streaming budget because the frame-time band
has one definition and the scheduler owns it. Everything else imports only its
neighbours or nothing at all, which is what made the move mechanical.

Nothing else moved with them. The metrics and the acceptance rule stay under the
test tree, because they are used by the cases that define them rather than
waiting to be wired, and the register only describes what ships.

267 cases across seventeen files pass, no path anywhere still names the old
location, and the six architecture guards agree.

### L86 · FIXED · PERFORMANCE

The size graph already varies. Five folds enter it conditionally, for the class
mask, the elevation and intensity filters, a node's dissolve dither and its
coarse-LOD multiplier, and three size modes sit on top: ninety-six possible
shapes. Six capabilities each adding a fold of their own would be six thousand.

The obvious way to avoid that is to fold everything always and let an identity
value make an inactive capability free. This renderer has already tried it. The
note in `_applySizeMode` records what happened: an inactive filter still folded
its mask into every carrier mesh, which compiled attribute reads for position
and intensity into essentially every scan's vertex shader, and that was the
regression behind scans opening with nothing rendered. Conditional folding is
the fix that shipped, and it is why the shape count is what it is.

So a capability rides an existing fold as a uniform and the condition deciding
whether anything folds at all never learns about it. Coverage sizing is written
that way already: the mode selects a uniform value, the test in `has` is the one
it always was, and switching modes writes a number rather than building a
pipeline. Letting the capability into that test fails two assertions, and a run
of mode changes makes no new uniform.

What this phase asks to measure, the compile and startup cost of the shapes that
do exist, needs a device. Nothing here establishes it.

### L87 · FIXED · SCIENTIFIC

Coverage sizing derives a number per point from a cloud's own positions and
hands it to the GPU. It describes how the cloud is drawn rather than what was
measured, and three things had to be true about it.

All three already were, and each was checked rather than assumed. The estimator
reads positions and writes only its own output array. The attribute appears in
no session and no model. It exists in two places, written onto the geometry and
read by the size node, and disposing the material on cloud removal is what
invalidates it.

What was missing is anything keeping it that way. A session that saved it, or an
export that wrote it beside the returns, would put a presentation figure in a
file a reader takes for data, and it would be indistinguishable from a
measurement because it is a float per point. The surfaces that write a session
or a point file now may not name a render-only attribute, and naming one there
fails by file.

The first probe of that guard passed when it should not have. It inserted the
offending line at the first newline, which is inside the file's leading comment,
and the guard strips comments before it looks. The guard was right and the probe
was wrong, which is the more usual way round than it feels at the time.

### L88 · NOT REPRODUCIBLE · PERFORMANCE

History churning through a progressive decode does not arise, because the chunks
do not grow the cloud. They grow a separate preview layer, which is disposed the
moment the real cloud is added, so the dataset changes once at that commit
rather than on every chunk. There is nothing to batch.

Accumulating over the preview would be wrong for a second reason beyond the
churn: it is a deliberately reduced stand-in, sized to what the device can draw
rather than to what the file holds, and a history built over it would be a
history of a placeholder. A sweep belongs after the commit, which is the same
answer refinement got, for the same reason.

Preview authority is independent of all of this and stays so. A figure caps at
preview while the source is not proven complete, held by the guard that keeps
the authority surface and the continuity modules from importing each other.

### L89 · PARTIAL · ARCHITECTURE

Refining nodes were never going to churn a history away, for the reason parked
convergence already gave: a sweep runs only at full refinement, so while nodes
arrive there is no accumulation to discard. The narrower rules this phase
suggests, ignoring arrivals outside the view and arrivals that change no visible
support, are the optimisation it says to leave until correctness is settled.

What needed fixing was an ambiguity of mine. The frontier field carried one line
of description, and what an integrator puts there decides whether it is useful
or ruinous: every resident node id moves the epoch whenever anything lands
anywhere, a frontier depth misses a child replacing its parent in the middle of
the view. It now says to use the ids of the nodes actually drawn, which
invalidates more often than it must and never less, and says why that is
affordable rather than leaving the reader to find the connection.

### L90 · PARTIAL · SCIENTIFIC

The lens cannot alter what is resident, and that is structural rather than
observed: the module imports nothing at all, so it cannot reach a scheduler to
ask for a node.

The harder requirement is what it implies. Under the lens every remaining pixel
is one a sample paid for, which on a streamed scan is true and still misleading:
the samples present are the ones that have loaded, not the ones the file holds.
A viewer holding the lens over a thin patch cannot tell sparse ground from
absent data, and those are opposite conclusions with the same appearance. The
lens now carries the qualifier a measurement carries, and takes completeness as
a fact rather than working it out, because that question already has an owner.

### L91 · FIXED · SCIENTIFIC

Accumulation would have averaged classification colours. Two samples on one
surface with different classes are depth-compatible, the merge blended, and the
result is a colour between two classes, which reads as a class the data does not
contain.

The colour modes already refuse this in the other direction, and say so: the
categorical ids stay categorical, point source id gets no ramp, because painting
unordered ids on a sequential ramp invents an ordering the data does not have.
Averaging two class colours across frames is the same invention arriving through
time, so the merge now takes the semantics and never blends a label.

The nearer sample wins and an exact tie keeps what is there. Determinism is the
point of the tie rather than tidiness: without it a surface carrying two classes
alternates between them frame after frame, which is the sparkle the stable
temporal partition exists to prevent, returning through colour. Letting
categorical blend fails three assertions, and a caller that says nothing still
gets the continuous behaviour it had.

### L92 · MEASURED · ARCHITECTURE

The history formats were chosen by arithmetic and are now measured on a device.
Both backends accept all three, so the layout is not a guess any more.

WebGPU, on an Apple metal-3 adapter, created all three
textures and takes the depth surface as a render attachment without conditions.
Three surfaces at 1080p allocated 17.8 MB, which is the figure the cost table
already carried.

WebGL2, through ANGLE on the same machine, reported every one of the three
framebuffer-complete, with eight colour attachments available against the three
this needs. The depth surface is the exception worth recording: it is an `R32F`
colour attachment there, renderable only where `EXT_color_buffer_float` is
present, and that extension is not core WebGL2. Without it the framebuffer is
incomplete rather than slow.

So the two backends differ, in the way the tier ladder exists to absorb, and
this is the first divergence in this programme that was measured rather than
inferred from the point-size precedent. The capability flag now says what a
caller on WebGL2 has to ask before answering yes, and a device that refuses the
extension takes the rung that keeps no history rather than failing to draw.

Coverage sizing was also confirmed on a real streamed source, fifteen point
seven million points over four hundred and eighty-five nodes: mean frame energy
rose from 69.75 to 82.08 when density sizing was selected and returned to
exactly 69.75 on switching back. Before this cycle that selection changed
nothing on a streamed scan. The exact return is the second result, since a
switch that rebuilt the pipeline rather than writing a uniform would not land on
the same number.

What remains untested is that same sizing rendering under WebGL2. The formats
are there and the fold is backend-neutral in principle, which is the kind of
claim this programme keeps refusing to make, so it stays open.


### L93 · FIXED · ARCHITECTURE

Two signatures took an argument and threw it away. `activePhases` accepted a
refinement phase, indexed `PHASES_DRAWN_WHILE` with it, then discarded the
result; `sourceRenderingAvailable` accepted an outcome it never read. Both now
take only what they use. `PHASES_DRAWN_WHILE` stays as the record of which
phases draw under which refinement, with a comment saying nothing looks it up.

Both clamp sites now call `clamp01` from `src/numeric.ts` under a local finite
guard. Calling it bare would have been wrong: the shared clamp propagates NaN,
and these two return zero for a degenerate input on purpose, so a sample with no
usable geometry contributes nothing instead of counting as full support. Passing
the bare clamp through fails the support test, which is how the difference was
confirmed rather than assumed.

Three findings from the same audit were left alone and are recorded here as
open rather than fixed. The fourteen-module continuity island needs integration
and a device to graduate, not an edit. Six thresholds are unmeasured because the
field data that would set them does not exist yet. Coverage sizing has no
WebGL2 render-parity evidence, which is the same gap L92 closes with.

### L94 · BUILT · SCIENTIFIC

Every Studio export renders to the live on-screen canvas and encodes what is
there, which is the property that makes a screenshot a screenshot. It is also
the property that lets a reconstructed pixel into a file somebody reads back as
data. Four of the seven raster modes encode geometry in their pixel values: a
height map's grey level is an elevation, a depth map's a range, a normal map's
channels an orientation, a contour raster's lines the same elevations again.

So the phase has two answers rather than one. Appearance rasters are captured
as they stand and carry a label. Geometry rasters suspend gap closure for the
duration of the capture, and the figure records the mode it was captured in
rather than the mode the screen was showing. That last part follows the rule
the colour mode already sets, where an export that forces elevation records
elevation because that is the artefact's truth. Labelling a suspended capture
by what the live view had been doing would be a warning that is wrong, and a
warning that is wrong the first time is ignored the tenth.

The line between invented and measured is the one the support vocabulary
already draws. Accumulated pixels compose source samples across frames of one
epoch and trace back to measurements; reconstructed pixels are borrowed from
neighbours and trace back to no sample of their own. Only micro-gap fill
invents, so only micro-gap fill triggers the refusal, and accumulation with
everything else switched on still reports no reconstruction.

The share is emitted only when a census counted it. Capabilities say what the
renderer was permitted to do; the census says what it did, and a percentage
derived from the permission would be a number nobody counted. A frame that drew
nothing yields no share either, and a value that is not finite or falls outside
zero to one is refused rather than printed. The mode itself is always stated,
including 'source', because a reader who finds the key missing on some figures
cannot tell an unstamped file from a plainly rendered one.

The share arrives already computed. Reaching into `supportCensus` to tally it
here would have grown the export-to-render coupling the module-graph ratchet
holds shrink-only, and the ratchet was right: a figure's metadata needs a
number, not a framebuffer. One definition of the share stays in the census,
including its decision to exclude background from the denominator, where a
second copy on the export side would have been free to drift.

Point-cloud data exports are untouched. They are written from the authoritative
points rather than the framebuffer, so no screen-space pass can reach them.

Staged, not wired. With no capability able to be on, every call returns as-is
and source today, and a branch no input can vary is not an integration.

### L95 · BUILT · ARCHITECTURE

Convergence contributes one phase per frame, so presenting the history as it
builds fills the image in over several frames, and on a sparse scan it pulses:
each phase lands in a different subset of pixels. That is refinement rather than
movement, but a viewer who asked their system for less motion did not ask to be
shown the difference.

Under reduced motion the accumulation still runs and the exposure of it does
not. The direct rendering holds for the whole sweep and the accumulated result
replaces it once, at convergence. Reading the preference as "turn accumulation
off" would have been cheaper and a worse deal, since it answers a request about
motion by taking away image quality. Both viewers reach the same final image on
the same frame and one of them watched it arrive; a test drives a whole sweep
and counts exactly one transition.

What stops one transition becoming a flicker is a property convergence already
has. A sweep needs a fully refined view, so an epoch change during it returns
the state to idle, where the direct rendering is what is shown anyway. Reaching
the swap twice quickly takes a viewer who parks, moves, then parks again, where
the image changing is what they just asked for. One transition remains, and it
is a surface becoming less grainy rather than anything that translates, scales
or flashes. That is the limit of what the policy claims.

The lens gap was not in its shape. `Lens` carries a position in device pixels
and mentions no pointer. It is that a hovering mouse supplies a position every
frame and nothing else does: a touch ends when the finger lifts, a keyboard has
no position at all. So a source that reports continuously is tracked and a
source that does not is pinned, and a release closes a pointer lens while
leaving a touch one where the viewer put it. Closing on touchend would have been
hover-only behaviour under another name, with a touch viewer unable to look
anywhere while holding the lens over the patch they doubt.

A keyboard lens opens at the viewport centre rather than the origin, because the
top-left corner is off the scan in most views and a lens revealing nothing reads
as a feature that does not work. Nudges clamp to the viewport for the same
reason, and an arrow key does not open a closed lens, which would put one on
screen for a viewer who was scrolling.

Both take the fact rather than deriving it, as the lens already takes source
completeness. Worth recording that the preference itself has three separate
`matchMedia` readers in the tree (`ResultFocus`, `profileWorkbenchStage` and
`NavController`) and no shared helper. Consolidating them touches reachable
code for no behaviour change, so it is noted here rather than done inside a
phase about something else.

Both staged. Neither capability can be switched on, so exposure has no history
to present and placement has no lens to move.

### L96 · PARTIAL · ARCHITECTURE

The benchmark this phase asks for was not run. There is no iPhone-class WebKit
runner here, no Android device and no tablet, so the frame budget on those
classes is unmeasured and nothing in this entry reports otherwise.

That absence decides the policy rather than blocking it. A touch-first device is
capped at coverage sizing, the rung that reconstructs nothing and keeps no
history, and the cap lifts only on evidence naming a higher sustained rung for a
device class somebody measured. No such record exists, so a phone gets coverage
sizing under every combination of backend inputs, which a test asserts by
enumerating all eight rather than by checking the one path. Lifting the cap
because the memory arithmetic works would be answering a frame-budget question
with a memory-budget answer.

The coordination the phase asks for turned out to be a real collision. Applying
a pixel ratio reallocates the drawing buffer, which is why the adaptive ratio
rate-limits its reductions, and the history keeps three surfaces sized to that
same backing store. Sizing the history from the ratio in force would reallocate
all three on every motion episode, and it would do it at the worst moment: the
ratio snaps back to full the instant the camera parks, and parking is when a
sweep starts. The history would be thrown away on the frame it was about to be
used.

So the history is sized from the parked ratio and ignores the reductions, which
costs nothing. Reductions happen only while the camera moves, and a moving
camera has no sweep, because convergence needs a fully refined view. The reduced
frames are the ones nothing was going to be written from.

The bound under a high ratio is solved, not picked. The budget ceiling already
exists and the cost is backing-store area times bytes per pixel, so the largest
ratio that fits is the square root of one over the other. It is quantised down
onto the same grid the adaptive ratio snaps to, so the two never ask for backing
stores a quarter-step apart, and down rather than to nearest because a ratio
that rounds up does not fit.

What the bound must not do is lower the render ratio. The history enhances the
picture; degrading the picture to afford the enhancement has that backwards. The
history takes a ratio at or below the render one, and where the legibility floor
will not fit it reports no history at all, which the ladder already absorbs.

Touch-first comes from the existing pointer query, which asks whether the
pointer is coarse and hoverless. A user-agent string says nothing reliable about
a GPU and the programme forbids brand lists.

Staged. No capability can be switched on, so there is no history to size and no
tier to cap.

### L97 · BUILT · ARCHITECTURE

The suggested degradation order drops micro-gap closure before accumulation.
Under memory pressure that is the wrong way round, and the reason is checkable
rather than a matter of taste. One thing in the subsystem holds memory between
frames: the three history surfaces. Closing gaps reads neighbouring depths
within a frame and allocates nothing that persists, so giving it up first leaves
the pressure exactly where it was while the picture is already worse.

Shortening the sweep frees nothing either. The history is one set of surfaces
rather than one per phase, so the count changes how many frames a convergence
takes and not how large anything is. Both steps reduce work, which makes them
relief for a device that cannot hold a frame rate, so they lead the frame ladder
in the suggested order while the memory ladder frees the surfaces first. Each
step declares what it releases and a test reads the ordering off those
declarations instead of off a literal.

A rung can be spent rather than taken, which the tier ladder has no way to say.
Lowering the history ratio is relief until the ratio reaches the legibility
floor, and after that the request has to move to the next rung. Returning the
same rung would hand a caller a step that changes nothing and invite a loop; the
drain test asserts every step returns a different state and that both ladders
terminate.

`PhaseCount` is 2, 4 or 8 rather than any integer, so a step down halves. The
first version subtracted one and a cast hid that seven is not a value the
partition accepts. The powers of two are what make its arithmetic exact, and a
relief step is not where to give that up.

Dropping accumulation also returns the ratio and the count to their minima.
Both describe a history that no longer exists, and leaving them where pressure
had driven them would hand a later re-enable two numbers chosen under duress.

The dataset cannot become a source of relief. Nothing in the state names a scan,
a node or a buffer of coordinates: it holds display capabilities, a ratio and a
count, and a test reads the keys rather than trusting the sentence. Node culling
and packed attributes survive every drain for the same reason, since they
describe how the data is carried rather than how it looks.

Detection is taken as a fact. There is no portable pressure signal in a browser,
`navigator.deviceMemory` is a static hint rather than a reading, and the one
event this subsystem can trust is an allocation that did not succeed, which
`continuityFailure` already names.

Staged. No capability can be switched on, so there is no history to shrink.

### L98 · REFUSED · ARCHITECTURE

Two conditions gate this phase and neither is met. A benchmark of simple GPU
phase rejection needs an adapter this runner does not have, so the cost of the
thing being replaced has never been read. The phase also states its own test,
that the work is worth doing only if vertex cost stays material after fragment
savings, and that quantity is unmeasured too. No optimisation was built.

The feasibility question is answerable without a device, and the answer changes
what the eventual benchmark has to beat. It is written up in
`docs/architecture/temporal-block-buffers.md`.

Two findings carry it. A contiguous range cannot be taken as a phase: the phase
is a hash of the point index and the hash exists to scatter, so reading blocks
off the existing order makes a phase mean whatever the file's order is. Survey
LAS is near acquisition order, so phase 0 becomes a swath rather than a sprinkle
and an accumulation fills the image in as moving stripes, which is the pulsing
the reduced-motion phase exists to prevent arriving through the layout instead of
the schedule. A block layout therefore has to permute physically and keep the
scatter.

The second is the one that costs. `buildPointMesh` wraps the caller's positions
array directly, with no copy, so the instance index and the source point index
are the same number by construction, and inspect picking, `patchView` and the
profile builder all read source arrays at that index. Permuting in place moves
every one of those reads onto the wrong point. Colour, classification and
intensity are already copied into fresh arrays at mesh build, so permuting those
is free; positions and an inverse map are not, at twelve and four bytes a point.

On the one streamed cloud measured here, 15.7 million points, that is
251,200,000 bytes or about 240 MiB against a 256 MiB history ceiling. An
optimisation aimed at vertex invocations would cost roughly what the whole
accumulation history is allowed to hold, on a cloud where the history wants the
same budget. That is the comparison the benchmark has to clear, and it was not
visible until the shared and derived buffers were told apart.

### L99 · BUILT · ARCHITECTURE

Projected size answers how much of the screen a node occupies. The scheduler
ranks on it, and it is not the same question as how much of the screen a node
would improve: two nodes can subtend the same angle while one leaves visible
holes between its samples and the other is already finer than a pixel, where a
fetch, a decode and a buffer change nothing a viewer can see.

Spacing separates them and COPC nodes already carry it, root spacing halved once
per level. Projected through the camera it gives the distance between
neighbouring samples in pixels, and one pixel is where a node stops adding
anything visible. That bound is a property of the display rather than a tuning
choice. The upper bound, four pixels for full need, is a starting value and says
so in the same words the reconstruction ceiling uses.

Two guarantees carry the design. The factor is strictly positive, so coverage
reorders and never excludes: zero is the score that means not a candidate this
tick, and a node that is never a candidate never arrives, which would make
source completeness depend on where the camera was pointed. Everything that
reads completeness, from the evidence lens to the export frontier, is entitled
to the same answer whatever the renderer finds worth looking at.

The second is that coverage multiplies the projected size rather than adding a
term. The score is positional, depth in the upper digit and size in the lower,
and that is what makes the scheduler coarse-first. Scaling the lower digit the
way the focus bias already does keeps the two composable and leaves the deeper
node behind the shallower one however much better its coverage, which a test
checks at the extremes rather than at a typical pair.

An unknown spacing counts as full need rather than none. A node whose spacing
cannot be projected has not been shown to be redundant, and the other reading
would quietly deprioritise every node of a source that does not report spacing.

Staged. The scheduler's score is unchanged, because wiring this alters which
nodes arrive first on every streamed scan, and that wants a measurement instead
of a merge.

### L100 · REFUSED · ARCHITECTURE

The phase gates itself on micro-gap closure being stable. Closure has never run,
being one of the capabilities that cannot be switched on, so it has no behaviour
on a device to be stable or otherwise. The phase also calls itself optional and
says not to delay the core set for it. Nothing was built. The reasoning is in
`docs/architecture/edge-aware-kernel.md`.

Two things are decidable without a device. The first is that the postprocess the
phase asks about already ships: Eye Dome Lighting traces every depth
discontinuity in screen space by sampling neighbouring depths at a pixel radius,
which is the quantity an edge-aware kernel wants. A per-point screen-space edge
test would compute a second time what the renderer already produces each frame.

The second shapes every option. A kernel's size is decided in the vertex stage
and the EDL response is a function of the completed depth buffer, so the signal
exists one stage too late to be read by the thing that needs it. A depth prepass
and a second point draw does exactly what the phase describes and draws every
point twice, which spends the budget the temporal block investigation was opened
to save. Sharpening in the postprocess alone is cheap and leaves the splat
covering the same pixels, so it shades a fringe instead of preventing one.

The third option is the interesting one and it has a limit worth writing down
before someone builds it. The density grid behind `localDensitySizes` already
visits every point and already feeds the size graph at vertex time, so a
per-cell measure of depth disagreement would arrive exactly where the decision
is made at no screen-space cost. It would also be view-independent, so it
describes the edge of a roof or the boundary of a canopy and says nothing about
a near object crossing a far one, which is the case a viewer is most likely to
notice. The cheap design does not do the job and the one that does costs a
second draw.

The predicate itself is not missing. `depthCompatible` is written and already
shared by the merge, by closure and by the support rules. What is missing is a place to
evaluate it before rasterisation.

### L101 · REFUSED · SCIENTIFIC

Of the two gates, one is half open and the other is shut. Normals do exist: the
cloud type carries an optional array and E57, PCD and `.pnts` tiles populate it,
while the renderer records at the point of use that LAS never does, so the
formats carrying orientation are the minority ones. No benchmark exists, so
nothing was built. The reasoning is in `docs/architecture/oriented-footprints.md`.

Normals reach the renderer only as colour. `colorByNormal` returns RGB bytes and
they travel through the same colour attribute as every other mode, and inspect
reads the array for point info. `buildPointMesh` takes positions, colours,
classification and intensity, so there is no normal attribute and nothing in the
size graph could read one. An oriented footprint needs a fifth per-point
channel, four to twelve bytes depending on the encoding.

The part that matters more than the cost is that this would invert a stance the
programme already took. `normalAgreement` decides what a normal may do here and
the rule is that normals only ever refuse: they can stop a fill across a roof
ridge and can never turn a refusal into a fill, so a normals channel can only
make the renderer more careful with a dataset. Orienting a footprint is the
opposite use, where a wrong normal draws a wrong shape and a bad orientation
channel produces a worse picture than none at all.

That argues for a mode a viewer switches on rather than a quality applied
whenever a normals array is noticed, with the provenance recording that it was
on. The same module also settles the phase's other constraint more strictly than
it was asked: the rule is not merely that the app must not depend on generated
normals, it is that normals are never computed at all, because fitting one
mid-frame would invent the thing being used to check an invention.

An oriented disc remains the footprint of one sample. It interpolates nothing,
infers no surface between points and leaves the sample count identical, so it is
a display mode and the word reconstruction belongs nowhere near it, the evidence
register included.

### L102 · BUILT · SCIENTIFIC

Of the twenty-one named tests, eighteen already existed under the behaviours
they name, several from earlier phases of this programme and one,
`streamingFrustumCulling`, under that exact filename since before it. Adding
files to match names already covered would have inflated a count without
covering anything, so three were written and one was refused.

`renderAttributePacking` has nothing to test. `packedAttributes` appears four
times in the tree, all of them a flag set to false; no packing exists, so a test
would assert the absence of a feature rather than its behaviour.

`coverageSizingOrthographic` was genuinely missing and turned out to be a
property rather than a case. The scale takes no camera: it is a function of the
resolution a node was recorded at relative to the root, and the renderer draws
with size attenuation off, so the figure is in device pixels and acquires no
projection dependency downstream. The test varies four camera states and pins
one scale, which reads the independence off the signature instead of trusting
it.

`reconstructedPixelsNotPickable` was the important gap. Every module carries a
sentence saying nothing derived from a reconstructed pixel may reach picking,
measurement or evidence, and no test read that sentence. The structural fact
behind it is that a fill decision carries a depth and a support kind and no
identity at all, so there is nothing for a picker to resolve; the test reads the
keys rather than trusting the comment.

The third test was wrong before it was right, and the correction is the finding.
It asserted that a wide hole does not creep shut across repeated passes, and it
passed. Tracing the pass showed why: on a five-by-five hole the first pass fills
zero pixels. A rim pixel has neighbours on one side only, so the opposite-pair
rule refuses it as unsupported, and the fixed point is reached before creeping
could begin. The assertions were true for a reason unrelated to what they
claimed, which is the same failure mode as a gate that passes vacuously.

Rewritten, they assert the behaviour that is actually there: nothing fills in a
hole three or more pixels wide, every cell survives, and the refusal reason at
the rim is unsupported rather than discontinuity. A one-pixel seam still closes,
which is what the pass exists for. Weakening the opposite-pair rule to any two
neighbours now fails two of them, where the original version noticed nothing.

The rule that a reconstructed pixel is never evidence is a second line behind a
first that already holds in this geometry, so it is asserted directly rather
than through a hole that never reaches it.

### L103 · PARTIAL · SCIENTIFIC

A screenshot corpus needs the field wired into a renderer and a device to
render on, and there is neither. What the five defect classes need is narrower
and available now: a frame with known depths, known support and known labels,
run through the same pure rules a shader would mirror. Ten scenes were built as
deterministic grids, one per case the phase names, with no randomness anywhere,
so a failure names a rule instead of a driver.

This is not the screenshots and does not replace them. A rule can be right
while a shader mirroring it is wrong, and only a device shows that. What it
catches is a rule that would produce the defect however faithfully it were
drawn, which is the cheaper half and the half that is findable today.

The corpus immediately found something the assertions had been hiding. The roof
ridge fills. Two slopes either side of a fold sit at nearly the same distance
from the camera, pass the depth test comfortably, and closure lays a patch
across the fold. That is the exact limitation `normalAgreement` was written
for, and says so in its own header, so the corpus now records both halves:
depth alone closes the ridge, and normals refuse it.

Three of the first assertions were vacuous and passed for reasons unrelated to
what they claimed. One compared a value against itself through a ternary
identical on both branches. Two sat behind conditions that were never true, so
they asserted nothing while reading as coverage. Rewritten, they check that
every fill takes a depth some direct neighbour actually had, that a steeply
receding facade is never interpolated across, and that the near and far bands
of a three-order-of-magnitude scene are never one surface.

Probing found one more gap. Replacing the nearest-neighbour fill depth with
their mean changed nothing, because every scene had supporting neighbours at
identical depths, where the two rules agree. The roof was symmetric. Making its
slopes unequal, which is also what a roof is like, gives the scene a case where
nearest and mean differ, and the substitution now fails two assertions. Three
separate probes bite: widening the depth tolerance, averaging the fill depth,
and letting disagreeing normals permit a fill.

### L104 · MEASURED · SCIENTIFIC

The expected answer was no scientific change. The measured answer is that four
of the twelve categories moved, every one of them from a separately scoped bug
fix, and none from the renderer work. The report is
`docs/validation/v070-scientific-regression.md`.

Running the suite at both ends would have compared pass counts. What was done
instead compares values: of the test files present at the base, sixteen were
modified by this programme and the rest were not, and every unmodified test
passes at head. A test that pins a scientific value, was never edited and still
passes is that value's own before-and-after, so the sixteen modified files are
the entire surface where a number could have moved.

The Continuity Field contributed nothing and could not have. Eighteen of the
nineteen files under `src/render/continuity/` are unreachable from `main.ts`,
which the unreachable-modules lint measures on every gate rather than taking on
trust. The nineteenth is `historyBudget`, whose only reachable importer is the
debug overlay, where it reports what a history would cost and nothing else.

Classification moved because ASPRS redefines codes between the legacy point
formats and the extended ones. Class 12 is Overlap Points in formats 0 to 5 and
Reserved in 6 to 10; class 8 is Model Key-Point in the first and Reserved in the
second. The label was unconditional before, so a file in an extended format was
told its class 12 points were Overlap when the specification says otherwise.
Capitalisation now follows the specification too, which is why an exported CSV
reads High Vegetation. Profiles, the export legend, point info and the reports
all inherit it.

Terrain moved because the boundary share seeded a distance field at every
non-measured cell. Those seeds are the survey edge on a full decode and mostly
interior gaps on a grid thinned by a display stride, so the share climbed toward
one for the same ground: 33 per cent full, 100 per cent strided. The terrain
report quotes it in its verdict sentence.

Source exports moved toward what the file said, with GPS time written under the
type its source declared and classification flags surviving decode.

Worth recording that one commit, `4793b246`, carried a renderer change and a
package-date fix together. Both are correct and the mixture made this
attribution harder than it needed to be.

### L105 · MEASURED · ARCHITECTURE

Seven metrics at both ends, in `docs/validation/v070-architecture-metrics.md`.
The two the phase sets as conditions both hold: cycles stayed at zero, and no
new renderer monolith appeared.

The second is the one worth reading closely. The render subsystem gained 22
files while `Viewer.ts` lost seven lines and gained no imports, so the work went
into new modules instead of the existing one. A feature of this size usually
does the opposite to a renderer. `Viewer.ts` is still at 6215 lines against a
2000-line goal, and the shrink-only ratchet is what keeps that number from
drifting back up.

Zero cycles is a result rather than a formality here, because 19 files that
import each other and reach upward into `adaptiveDpr` and `streamingLodSize` are
exactly where one would appear.

Twenty-five new modules cost two kilobytes of eager bundle, since 18 of the 19
continuity files are unreachable and the bundler drops them. What did land is
the coverage-sizing wiring and the class-semantics work, both reachable by
design. The entry chunk was already at 803 of its 812 KiB ceiling at the base,
warning since 700, so the pressure predates this programme and the margin is now
seven kilobytes.

A measurement trap is recorded with the numbers. `npm run build` and
`npm run build:live` produce different bundles: on the same head tree the plain
build reports a 355 KiB entry and the live build 805 KiB, and the budget is
enforced against the live one. The first base measurement taken here was a plain
build, which against a live head figure would have shown a 450 KiB regression
that does not exist. The gate also runs a plain build after its live one, so the
`dist/` left on disk afterwards is not the artifact the budget measured, and
reading sizes from it gives the wrong pair.

### L106 · MEASURED · ARCHITECTURE

The estimate was wrong and the measurement is the entry. Four modules decide
which rung a device can carry, they are eight kilobytes of source, and the
subsystem is 29 per cent code rather than documentation, so three or four
kilobytes minified looked like the answer. Importing them eagerly measures nine
and fails the 812 KiB ceiling at 814. The whole subsystem eager measures 835.
Figures and method are in `docs/architecture/continuity-bundle-strategy.md`.

Two of the nine are not the modules. `mobilePolicy` imports two numeric
constants from `adaptiveDpr`, a runtime import of a module that otherwise lives
in the lazy Viewer chunk, so importing the decision half hoists `adaptiveDpr`
out of that chunk and into the shell. The hoist shows on both sides: the entry
gains while Viewer falls from 726 to 724, and removing the import puts Viewer
back at 726 and the entry at 812. That is exactly the ceiling, which the budget
script passes and the budget's own rule calls measuring noise rather than creep.

So the seam is not between decision and passes. It is around all of it, and the
reason it can be is that the field ships disabled: a device that cannot carry it
renders as it does today, so there is no rung to choose before the first frame.
That is what separates this from the Speed to Quality control, which the budget
records as unavoidably eager because a weak device must have its degraded
display settings on frame one. This one decides whether to add something to a
renderer that is already correct.

The `adaptiveDpr` import stays. The history ratio is quantised onto the same
grid the adaptive ratio snaps to, and copying two constants to dodge a hoist
would trade a shared definition for a bundling convenience. On the lazy side the
hoist does not occur.

All three builds ran in a throwaway worktree and the working tree was verified
clean afterwards, so no probe reached a commit.

### L107 · BUILT · ARCHITECTURE

The Continuity Field gets no control of its own. It becomes one more field on
the Speed to Quality dial, which already exists to be the single understandable
display knob and already maps one position onto the streaming preset, the pixel
ratio ceiling, Eye Dome Lighting and antialiasing. A second quality control
beside it would be the knob pile this phase forbids, and the rung name carries
a whole configuration, so a viewer never meets a phase count, a gap radius or a
history epsilon.

The table runs source, source, sizing, closure, full across the five stops.
Everything up to the midpoint stays on a rung that invents no pixel, so the
shipping default cannot put reconstruction on screen. The dial's existing
monotonicity proof was extended to cover the rung, and swapping two stops now
fails three assertions.

What the dial resolves is a request, never a grant. The measured backend
support and the touch-first ceiling both cap it and the viewer takes the lower,
which is the arrangement the pixel-ratio ceiling already has with the device's
own ratio. A phone reads the same rung as a desktop at the Quality end, and
that is correct rather than a gap: the cap lives in `mobilePolicy`.

Two things this cost, both recorded rather than absorbed.

The register lost two entries. `qualityPolicy` takes `ContinuityTier` as a
type-only import, and the reachability lint counts type edges on purpose,
because it is a register of modules nothing in production refers to at all. So
`continuityTier` and `continuityField` graduated honestly. Declaring the four
names locally would have dodged it and duplicated a union, which this programme
has refused elsewhere for the same reason. The runtime-only figure, which is
what the scientific-regression argument rests on, is 142 unreachable against 52
counting type edges, so the subsystem is still absent at runtime.

The eager entry went from 805 to 806 KiB. The type import contributes nothing,
being erased; the kilobyte is the five string literals, the rank table and the
field itself, which are real data in a reachable module. Margin is now six
kilobytes of the ceiling the base already sat near.

### L108 · FIXED · SCIENTIFIC

The previous entry introduced a latent default and this one closes it. Putting
the rung on the quality dial gave a capable WebGPU desktop on Auto a resolved
tier of `closure`, and closure asks for gap filling. Nothing consumed the field
yet, so no frame changed, but the policy stated a default that this phase
forbids and whoever wired it would have inherited it. That is how a default
ships by accident.

The five conditions are all outstanding. The browser matrix has not run, mobile
is unbenchmarked, performance is unmeasured, edge leakage is controlled only
against synthetic frames, and raw-point parity has no device evidence.

The flag half was already in place: six continuity flags, every one opt-in and
defaulting to false. What was missing was the composition, so nothing turned a
request plus a capability plus a ceiling into one answer, and a caller applying
two of the three caps and forgetting the third would have been correct-looking
code. `grantedTier` takes all three and the opt-in, which is one call rather
than three a caller has to remember.

A rung is granted whole or not at all. Enabling the half of `full` that happens
to be flagged on would run a configuration nobody chose and nobody measured,
which is worse than running the rung below it.

The proof enumerates rather than samples. Six devices by 101 positions by all
eight backend support combinations, with nothing opted in, and every one
returns `source`. Removing the opt-in cap fails it, and so does permitting a
partly opted-in rung.

### L109 · PARTIAL · SCIENTIFIC

Seven documentation items were asked for and one document was written,
`docs/continuity-field.md`, covering all seven with the architecture notes from
earlier phases linked rather than restated.

Three of the seven were held back deliberately and the reasons are worth
recording, because each is a way this could have gone wrong.

No release notes were written and the version was not touched. Release notes
are a release artifact, releases here are user-driven, and adding a document
that clears `lint:release-truth` before anybody has tested the tree would turn
a real red into a green by writing prose. The red stands.

`docs/limitations.md` was left alone. Adding a continuity entry would describe
a limitation of something no shipped build runs, which reads as a feature
users have and a caveat about it, and the doc exists for the opposite purpose.

There is no benchmark report, and the note says so in the section where one
would be rather than omitting the section. No runner here exposes a WebGPU
adapter and there is no phone, tablet or WebKit device, so frame time under the
field has never been measured anywhere. The two figures that do exist, the
streamed coverage-sizing run and the bundle measurements, are quoted with the
statement that neither describes the field drawing a frame.

The language requirement is met and checked. Presentation reconstruction is
defined once, the sentence that it is never new measured geometry appears
beside the definition, and the structural reason is named: a fill decision
carries a depth and a support kind and no identity, which a test reads off the
keys rather than trusting.

The browser table and the memory section carry measurements rather than
expectations. `r32float` renderable unconditionally on WebGPU and needing
`EXT_color_buffer_float` on WebGL 2 was measured on both backends this
programme, and the coverage-sizing render under WebGL 2 is listed as having no
device evidence rather than as backend-neutral.

### L110 · PARTIAL · SCIENTIFIC

Sixteen measured fields were asked for and none exists. No runner here exposes
a WebGPU adapter, there is no phone, tablet or WebKit device, and the field has
never drawn a frame anywhere, so every field but the commit hash would have had
to be invented. No record was written.

What was written is the record's shape, a verifier for it, and the property
that makes the shape worth having before there is a record. A benchmark of a
display feature is trivially favourable when whoever runs it picks the scenes,
and the scenes that flatter gap closure are the flat dense ones. So the corpus
is the required set: `verify:renderer-benchmark` refuses a record that omits
any scene, and vegetation, the silhouette edge, the roof ridge and the near or
far range are named in that set rather than left to whoever writes the record.

Four more checks are the kind a schema cannot express. A baseline that is not
the source mode is not a baseline. Two sides both in source mode are the same
run reported twice. A source render reconstructs nothing, so a source row
claiming edge leakage is a mislabelled measurement. Continuity covering less
than the baseline is not a continuity result. Each has a test that builds a
record designed to break it.

The scene list is duplicated in the verifier because a script that gates a
release must not import a test fixture. The duplication is held closed by a
test that reads both and compares them, which is the arrangement the
`REQUIRED_SCENES` comment states.

With no records present the verifier exits 0 and says why. An absent
measurement is the state this programme is in rather than a validation
failure, and a gate that went red for it would be disabled rather than
satisfied. It is wired into the release chain now, so it is live on the day a
record appears instead of being remembered then.

### L111 · MEASURED · SCIENTIFIC

Fourteen blockers, none reproduced, and the register says which kind of "not
reproduced" each one is, because a subsystem that never runs reproduces nothing
and a bare status would be true of all fourteen while meaning nothing. Seven
are held by a named test or cannot occur, five wait on hardware, one is an open
risk and one an open gap. The register is
`docs/validation/v070-release-blockers.md`.

The open risk is the sharpest thing this phase found, and it is an ordering
constraint rather than a defect. Every Studio exporter renders to the live
canvas, four of the seven raster modes encode geometry in their pixel values,
and the guard that suspends reconstruction for exactly those four exists and is
not wired. Nothing can fire today because nothing reconstructs. It fires on the
day the field is switched on if that wiring has not happened first.

Two blockers were checked rather than assumed. Classification codes reach the
GPU as a float attribute rather than an integer one, so exactness is a real
question: every value to two to the twenty-fourth survives the round trip, and
a test now pins it, because the risk is a future change of attribute type
rather than IEEE 754. Frustum culling cannot hide a node because
`nodeFrustumCulling.ts` has no importer and its flag has no consumer.

The closure row needed a qualifier rather than a yes. Strong edges hold, with
the corpus keeping a silhouette seam empty and filling nothing in a hole two or
more pixels wide. A roof ridge closes, since two slopes either side of a fold
are nearly equidistant from the camera, and that is recorded as the documented
weak-edge limitation the blocker does not name rather than folded into a pass.

Telemetry reports honestly and carries one inaccuracy that predates this work.
The overlay reads the real backing-store dimensions and flags an over-ceiling
estimate. The shared byte formatter divides by 1024 and labels the result MB,
so every byte figure in the application reads about 4.9 per cent below the unit
it claims. It understates rather than hides, and correcting it is a repo-wide
change to shipped text.
