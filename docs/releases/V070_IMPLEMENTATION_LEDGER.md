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

