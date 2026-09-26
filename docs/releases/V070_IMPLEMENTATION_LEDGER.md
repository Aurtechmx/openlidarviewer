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
of, so a finding can be traced to where it was first written down. L148 and
L149 were recorded as L146 and L147 on the branch that wrote them; both
numbers collided with an L146 and an L147 assigned independently on main, so
the two entries were renumbered when the branches were integrated.

## Ledger

| ID | Category | Repro | Sev | Status | Was | Finding |
|---|---|---|---|---|---|---|
| L01 | EXPORT | READ | med | FIXED | B01 | LAS 1.2 write masks classification with 0x1f, so a class above 31 wraps to another valid class. |
| L02 | EXPORT | TEST | med | FIXED | B02 | Scan angle rank written as constant zero. |
| L03 | EXPORT | TEST | med | FIXED | B03 | User data written as constant zero. |
| L04 | STANDARDS | TEST | high | FIXED | B04 | ASPRS class names defined independently in eight modules, and they disagreed. |
| L05 | SCIENTIFIC | TEST | high | FIXED | B05 | One lasso, two estimators. The stored record now names which one made it; it does not yet carry the area-grid figure. |
| L06 | SCIENTIFIC | READ | med | PARTIAL | B06 | Two density figures on different bases. Each states its basis; neither is the other's source. |
| L07 | SCIENTIFIC | TEST | high | FIXED | B07 | The boundary share counted a sampling gap as a survey edge, so it rose with the thinning rather than with the geometry. |
| L08 | SCIENTIFIC | READ | n/a | NOT REPRODUCIBLE | B08 | PCA extent presented as minimum physical dimensions. |
| L09 | LIFECYCLE | DOC | med | OPEN | B09 | `NavBar.dispose` has no caller. |
| L10 | LIFECYCLE | DOC | med | OPEN | B10 | `ViewerRenderCore` has no dispose seam. |
| L11 | UI | TEST | med | FIXED | B11 | Between 768 and 1000 px two open rails left no top-centre gap wider than the project card. The card now narrows to the band, with a 200 px floor. |
| L12 | UI | TEST | med | FIXED | B12 | Pinch, rotate and two-finger gestures ran end to end on Chromium only. They now run on every engine, iPhone-shaped WebKit included, as synthesized events. |
| L13 | EVIDENCE | DOC | med | OPEN | B13 | Firefox, WebKit and Windows are advisory; only Chromium blocks. |
| L14 | ARCHITECTURE | TEST | low | PARTIAL | B14 | Far-apart mounts did not fold `renderOrigin` on the CPU per mesh. The renderer now forms model-view in float64; the analysis paths and the terrain gather still fold placement into Float32. |
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
| L26 | SCIENTIFIC | READ | unmeasured | PARTIAL | B26 | Withheld points are left out of terrain, lasso stockpile volumes, profiles and density, each recording the count. The polygon Volume tool still reads them as ordinary returns. |
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
| L46 | PERFORMANCE | TEST | med | PARTIAL | new | Streaming nodes are culled to the camera frustum every rendered frame. No GPU frame-time record shows what the cull saves. |
| L47 | UI | TEST | med | PARTIAL | new | Density point sizing was read as keying a 2D grid on (x, y). It keys on the cloud's two widest axes; a scene mixing orientations is the unmeasured residual. |
| L48 | PERFORMANCE | TEST | med | FIXED | new | Render-memory telemetry counted position and colour only, so a classified cloud was reported at three quarters of what it used. |
| L49 | PERFORMANCE | READ | med | MEASURED | new | Compact source attributes are uploaded as Float32: RGB, classification and intensity cost 14 bytes a point more than the source carries. Without a layout change only colour can shrink, by 8 bytes a point. |

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

### L02 · FIXED · EXPORT

Scan angle rank written as constant zero. `GlobalPoints` had no scan angle field, so the writer had nothing to write.

The full-resolution export decode now keeps scan angle, user data, scanner channel, scan direction and edge-of-flight-line, `GlobalPoints` carries them, and both writers pack them: whole degrees clamped to ±90 in formats 0 to 3, 0.006° steps in formats 6 and 7. A source without them still writes 0. Covered by `tests/lasAcquisitionFields.test.ts`.

### L03 · FIXED · EXPORT

User data written as constant zero. Same cause and fix as L02.

Covered by `tests/lasAcquisitionFields.test.ts`.

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

The DEM README now carries an evidence contract section. It names the claim the
artifact belongs to and what that claim carries before any study is considered.
It then records what the claim resolved to here, the resolution state, the
matched study (or none) and the verdict. Where a scoped study matched, each envelope field it was checked
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

The scheduler's pressure state reads like a swapped pair of timestamps and is
not one. The fields are named for frames per second while the thresholds are
frame times, so the slow branch measuring `_fpsLowSinceTs` against the
back-off hold is correct.

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

Depth cannot tell a hole in the sampling from a fold in the surface. A pair of
points either side of a roof ridge sit at almost the same distance from the camera and
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

`setPointSizeMode` builds the per-point size
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

`coverageSizing` is the flag most likely to be misread. Coverage sizing is
live in the renderer and this flag does not gate it. What is live is reached by choosing density
point sizing. The flag stands for the capability record, which nothing consults
yet, and the flag's own comment carries that.

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

The dataset and the measurement tools, which this phase asks to protect along
with two other properties, need nothing here. They are out of reach of this
subsystem entirely, held by the parity and authority guards, so a continuity failure cannot put a
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
measured.

Every condition it had to meet was already met, and each was checked rather
than assumed. The estimator
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
or flashes, which is as far as the policy goes.

The lens gap was in what supplies a position, not in the shape of `Lens`, which
carries one in device pixels and mentions no pointer. It is that a hovering mouse supplies a position every
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
source completeness depend on where the camera was pointed. Every reader of
completeness, the evidence lens and the export frontier included, is entitled
to the same answer whatever the renderer finds worth looking at.

The second is that coverage multiplies the projected size rather than adding a
term. The score is positional, depth in the upper digit and size in the lower,
which is why the scheduler is coarse-first. Scaling the lower digit the
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

The postprocess the phase asks about already ships, which is decidable
without a device: Eye Dome Lighting traces every depth
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
fix, and none from the renderer work.

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

Seven metrics at both ends.
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

What it cost is recorded rather than absorbed.

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

There is no benchmark report. The note keeps the section it would appear in
and records the absence there, rather than dropping the section. No runner here exposes a WebGPU
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
risk and one an open gap.

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

### L112 · MEASURED · ARCHITECTURE

Twenty-five steps audited against where they actually stand. Two are wired and reach a user,
fifteen are tested pure cores nothing calls, five need hardware, three are
unimplemented.

The programme did not follow the order and the audit says so. Groups C through
F were designed before group A was finished, which would be wrong if any of it
were wired, because a core built on an unmeasured foundation inherits what the
foundation got wrong. Nothing is wired, so the cost of the order is currently
zero and stays zero only while that holds.

The audit also carries the one prerequisite that comes from outside the list.
Whatever capability is switched on first has to be preceded by the export
capture guard, since every Studio exporter renders to the live canvas and four
raster modes encode geometry in their pixel values. Wiring the guard afterwards
means some number of height maps and depth maps carry invented elevations in
the interval, and those files outlive it.

Two numbers in the first draft were wrong and are worth recording as the same
class of error. It claimed 79 commits where the log says 84, and it claimed
four gate failures across the whole branch when only the recent stretch is
reconstructable. Both were plausible, neither was counted, and the instruction
against inventing counts covers a number written from memory as much as one
made up.

The code review on this stretch raised the register entry for `continuityField`
and was right about the substance while wrong about one detail. Every one of
that module's four importers uses `import type`, so it emits nothing into any
bundle, and `continuityTier` is reached from production only by the same kind
of edge, its value importers all being staged themselves. The register had to
drop both, because it records what production refers to at all. What it could
no longer convey is that neither contributes runtime code, so the register's
purpose field now says that leaving the list does not imply runtime presence
and points at the runtime-only figure printed beside the count.

### L113 · MEASURED · SCIENTIFIC

The final verdict is that the Continuity Field is not ready for v0.7.

No blocker was reproduced, and the instruction for the verdict is to list only
reproduced ones, so that list is empty. Nothing was reproduced because nothing
ran, and a feature that has never drawn a frame cannot be released as stable on
the strength of its unit tests however many pass. The five conditions set for
making it a default are the same five that are unmeasured, so the verdict
follows from the programme's own gate rather than from an opinion about
quality.

Of the thirteen report sections, five carry measurements and eight say that a
figure was not taken. Streaming culling, attribute packing, settle time, GPU
cost, the browser matrix, mobile, every golden camera case: all absent, with
each row saying so rather than carrying an estimate.

One measured figure needed its caveat in the same paragraph rather than in a
footnote. The corpus sparse plane turns 64 direct pixels into 176 drawn of 225,
a reconstructed share of 63.6 per cent, which would fail the twenty per cent
ceiling the census defines. The fixture samples every other pixel on both axes,
far sparser than any real splat size, so the share describes the fixture rather
than a scan, and quoting the coverage gain without it would have been the
flattering half of a number.

Scientific parity is the section that reads as expected: zero unintended
changes, with four categories moved by separately scoped fixes.

A third count was wrong in a first draft and corrected against the tree. The
architecture table claimed 870 files under `src/` where the count is 867. That
is the same error as the commit count in the previous entry, from the same
cause, which is writing a number that looks right instead of running the
command that settles it.

### L114 · MEASURED · SCIENTIFIC

The first real-device evidence in this programme, and it corrects a claim the
programme had been repeating.

`BackendSupport` has been the tier ladder's input since the ladder was written
and nothing produced one. Every call site built the struct by hand, so the
ladder had never been driven by a measurement, and the difference between the
backends lived in a comment. `probeBackendSupport` is the producer, and it
keeps the two conditions apart because collapsing them deletes the closure
rung: a float colour attachment is what a persistent history needs, while
reading neighbouring depths inside one frame needs only a depth texture, which
is core in WebGL 2.

A probe page then exercised both backends rather than querying them. On an
Apple M3 Max under Chromium, WebGL 2 reports `EXT_color_buffer_float` present
and an R32F framebuffer complete, and WebGPU created all three history surfaces
as render attachments and destroyed them. Both reach the full rung. The byte
figures, 27.0 MiB at the 2048 by 1536 backing store and 17.8 MiB at 1920 by
1080, are the shipped formula's arithmetic cross-checked against
`historyBudget.ts`. The record is in `validation/renderer-capability/`.

The correction matters more than the result. This programme said repeatedly
that no runner exposes a WebGPU adapter, which was true of the Node test runner
and false of the browser the project previews in. Frame time is unmeasured
because the field is not wired into the renderer, not because no GPU is
reachable. Four documents and the benchmark verifier's own output said the
wrong thing and now say the right one.

What the probe does not narrow is the part the ladder exists for. One capable
laptop having the extension says nothing about a low-end Android or an older
integrated GPU, and Firefox and WebKit were not opened. The capability record
carries those limits in its own file rather than in a reader's memory.

The benchmark verifier rejected the capability record when it was first written
into `validation/renderer-benchmark/`, correctly, because that directory holds
baseline-versus-continuity comparisons and this is not one. The record moved
rather than the verifier loosening.

### L115 · BUILT · SCIENTIFIC

Export isolation is wired, which the wiring plan marks mandatory before
default-on Continuity and which the blocker register named as the one open
risk. It is wired now rather than later because the ordering is the whole
point: every Studio exporter captures the live canvas, four raster modes encode
geometry in their pixel values, and a guard that arrives after the first
capability that can reconstruct leaves some number of height maps and depth
maps carrying invented elevations in the interval.

`ExportContext` gained the capabilities in force at capture. Every figure is
now stamped with what it contains, geometry rasters suspend reconstruction, and
the stamp describes the artefact rather than the live view, so a suspended
capture is not labelled as though it reconstructed. Nothing changes a byte
today, because absent capabilities are the source case.

The context carries capabilities rather than a rung, and that is the
module-graph ratchet's doing. The first version imported `capabilitiesForTier`
into `BaseExportMode`, which grew export-to-render coupling from six runtime
edges to seven, and the ratchet is shrink-only. Passing the capabilities
removes the mapping call, and an absent value is answered without consulting
anything, so the layer needs no runtime import into the renderer at all. The
ratchet was right twice now: the same class of fix improved the layering both
times.

`presentationMode` graduated out of the unreachable register on a real runtime
import, which is the first genuine graduation in this programme rather than the
type-only ones the register also counts.

The wiring baseline verifies thirteen hypotheses
against the tree and finds twelve holding, one half stale, and two numbers to
correct: the plan cites `6502aad2` as the archive's evidence commit where the
archive says `6ce80c79`, and the registered-unreachable count has moved. The
archive digest matches exactly. The document is named for what it records
because `.gitignore` excludes every `*audit*.md` as an internal class, and this
one is measurement that belongs beside its siblings.

### L116 · MEASURED · ARCHITECTURE

A claim of mine was tested and did not survive. Recommending Phase A1 over tier
negotiation, this programme said frustum culling was "a materially bigger win",
with no measurement behind it. That is the failure the wiring plan's own rule
against aesthetic judgement names, and the one this programme has spent sixty
phases refusing elsewhere.

The premise holds at code level. `buildPointMesh` sets `frustumCulled = false`
and streamed node meshes use it, so every resident node's points are submitted
every frame whatever the camera is looking at.

The magnitude does not hold. On the 485-node sample at a 1024 by 768 viewport
the resident set is eight nodes and 1.77 million points, held there by the
point budget, and it did not move across an orbit that cut in-frustum
candidates from 303 to 102. The scheduler already frustum-culls for selection,
so resident nodes are drawn from in-frustum candidates and draw-culling can
only recover the ones that left afterwards. The bound on the waste is the
resident set, not anything proportional to 485.

What was not measured is the part that would size the win: how many of those
eight were outside the frustum at any instant. The overlay reports resident
count and the in-frustum count of the known hierarchy, which are different
populations, and the overlap needs a scene handle the app does not expose. The
record says so in its own file rather than leaving the gap to a reader.

A1 stays the next step, on different grounds. It carries a correctness blocker,
that no visible node may be falsely culled, and correctness needs no
performance justification. The performance case is bounded and unmeasured, and
the entry exists so nobody later quotes it as large.

### L117 · BUILT · ARCHITECTURE

Phase A1 is wired. Streamed nodes are culled against the drawn camera at render
cadence, and the node that leaves the view keeps its mesh, its decoded chunk
and its cache slot, so turning back costs a draw rather than a re-stream.

The reducer was the necessary part. Two systems already wrote `mesh.visible`
directly and a third was arriving, so whichever ran last won: a node the
frustum hid would reappear when the replace frontier recomputed, and a parent
the frontier withheld would return the moment the camera moved.
`visibilityReasons` keeps the reasons apart and combines them in one place,
which is now the only assignment to `mesh.visible` in the renderer.

Two traps are guarded by tests that fail when the guard is removed. The planes
come from the scheduler's own derivation rather than a second extraction,
because two extractions let selection and draw disagree about where the camera
is looking, and the node caught in that disagreement is one the viewer can see.
The record type warns that bounds shifted twice by the render origin cull to
nothing, so the shift happens once, inside the cull, and a test asserts the
double-shift case culls everything so the failure has a named shape.

Three ratchets pushed the design and each improved it. The monolith lint
refused the Viewer method, so the pass moved onto the streaming renderer. The
fan-out lint refused the Viewer's import of a new module, and its advice, to
put the behaviour in the cluster that owns it, removed the module entirely: the
renderer already holds the source, so it holds the render origin too, and a
caller can no longer pass the wrong one. The Viewer ends five lines lighter
than it started while the frame gained a decision.

One real bug came out of the suite rather than review. Holding the render
origin at construction assumed every source states one, and four wiring tests
failed on a source that does not. A missing origin is the identity shift rather
than an error, since such a source is drawn in world coordinates, and it is
written that way with the reason.

Verified in the browser on the 485-node sample: the scan renders, an orbit out
and back leaves it complete with no holes, resident nodes grew from five to
nine as the view changed, and there are no console errors. The release blocker
for this phase is one-directional, so the check that matters is that nothing
visible disappeared, and nothing did.

Frame time was not measured. The residency observation already recorded that
the win here is bounded by a small resident set, and nothing in this entry
claims otherwise.

### L118 · MEASURED · ARCHITECTURE

Phase A2 ran. The production default stays immediate, because metered commit
showed no measurable frame-time benefit on the one device available, and the
phase moves a default only on measured improvement.

The preview pane could not do it: it reports the page hidden, so
`requestAnimationFrame` never fires and the renderer collects no frame
samples. A headed Playwright Chromium does, and the numbers below come from
there.

The first two runs were wrong and the way they were wrong is the finding. Both
conditions shared one browser process, and whichever ran second was about 1.8
times slower at p50, 9.2 against 16.6 in one order and 8.9 against 15.8 in the
reverse. Reading either alone would have concluded that metered is worse, or
that immediate is, depending on which had been run second. Reversing the order
exposed it, and a fresh browser process per condition removed it.

Isolated and repeated twice each, the modes are indistinguishable. Immediate
reads p50 8.6 and 9.4, metered 8.4 and 8.4, so the gap between the condition
means is smaller than the gap between the two immediate repetitions. p95 and
p99 agree to within 0.4 ms. No frame passed 50 ms in any run and the single
frame past 33 ms was under immediate.

The interpretation is narrower than the numbers look. The baseline never
hitched, and metering exists to spread uploads on a device that stalls on
them, so the trace never exercised the condition the feature addresses. This
says metering did not help here, not that metering does not help. A machine
that hitches is the one that would settle it, and this is the class least
likely to.

Load timing was not usable, because the first resident node arrived between
6,782 and 11,546 ms across the four runs with no relation to the mode, which is network
and cache noise at this sample size.

The record is
`validation/renderer-capability/streaming-commit-a2-20260920.json`, carrying
the protocol, the discarded attempts and what stayed unmeasured.

This also sharpens the A1 entry, and the correction belongs with it rather than
left standing. A1 was reported as browser-verified, and it was, but by
screenshots rather than by a running loop: a capture forces a paint, and each
paint ran the cull and produced a complete scan with no holes. That is real
evidence for the release blocker, which asks whether anything visible was
wrongly dropped. It is not evidence about frame pacing, and the earlier entry
should have said which of the two it had. The Playwright runs since have
rendered thousands of real frames against the same build without a page error.

### L119 · FIXED · ARCHITECTURE

A strip of scene showed between the left panel and its own collapse handle.
The handle is positioned against the rail's outer edge and is meant to overlap
the panel's hairline by a pixel so the two read as one surface; measured in a
real Chrome window it sat eight pixels clear of the card instead.

The cause is a scrollbar gutter. `.olv-ws-body` scrolls with
`scrollbar-gutter: stable`, so the card is laid out in a content box narrower
than the rail, and the handle was hugging the rail rather than the card.

The nine pixels are this application's own, which is the part worth recording.
`.olv-ws-body::-webkit-scrollbar` sets that width, so the gutter is reserved
even on a machine whose scrollbars overlay and would otherwise take none. The
first fix measured a detached probe, which reports the PLATFORM default, got
zero, and moved nothing. Probing with the real class is what made the number
appear, and it is also why hard-coding nine would be wrong on Firefox, which
takes `scrollbar-width: thin` and lands elsewhere.

CSS cannot ask how wide a gutter is, so it is measured once and published as
`--olv-ws-gutter` for the rule to subtract, with a zero fallback that restores
the previous geometry wherever nothing publishes it. Two earlier attempts read
the live rail and failed for the same reason in different clothes: the host
appends it, and it stays hidden until a scan is open, so a bounded wait for a
box expired against an element that had none.

Thirteen existing workspace tests then failed, and they were right to. The
property write sat outside the guard, so a document stub without a
`documentElement` took the rail down with it. A cosmetic offset for a panel
handle must not be able to do that, and a test now pins it.

Verified in a real Chrome window at 1440 by 900: the gutter reads nine pixels,
the handle moved from eight pixels clear of the card to one pixel overlapping
it, which is the geometry the rule always described.

### L120 · MEASURED · ARCHITECTURE

Phase A3 ran as a two-by-two over the commit path and the stickiness flag,
with a fresh browser process per cell after A2 showed a shared process puts a
large order effect on frame time. Resident stickiness stays opt-in.

Every cell recorded zero node evictions and zero thrash events, on both
traces. Stickiness keeps a node resident that the budget would otherwise drop,
so with nothing dropped it had nothing to do, and the spread in cache misses
and uploads is a handful of nodes either way with no ordering by condition.

The first trace orbited out and back three times and produced no pressure at
all, so a second was written to descend the octree and then travel: twelve
wheel steps in, then three pan sweeps across the extent, so that many distinct
nodes compete for the budget. It produced no evictions either. The resident
set sat between eight and eleven nodes against 485 known, because the point
budget on this machine holds this scan's working set several times over.

So the answer is a null result from absent pressure rather than evidence about
stickiness. The phase graduates it only if it reduces churn, and there was no
churn to reduce. Testing it needs a working set larger than the budget, which
means a bigger source or a constrained budget such as the Speed end of the
quality dial or a mobile device profile.

Two of the phase's metrics were not instrumented and the record says so. Node
swaps and re-decodes were not separated from uploads, which is defensible only
because zero evictions makes a re-decode impossible. Visible refinement pulses
would need frame capture and comparison rather than a counter.

The pattern across A2 and A3 is worth naming: both features target a device
under pressure, and the only device available is one that never reaches it.
That is a property of the hardware rather than of the features, and it is the
same gap the browser matrix and the mobile row have carried since the start.

### L121 · BUILT · ARCHITECTURE

The streaming cadence is elapsed time. It was one tick every sixth frame,
which reads as 100 ms on a 60 Hz panel and 42 ms on a 144 Hz one, so the
scheduler ran nearly two and a half times as often on the faster display and
made correspondingly different decisions about what to load. A monitor is not
a policy input.

The bands come from the existing refinement phase rather than a second state
machine, because that phase already decides whether the camera is moving,
settling or refining, and a scheduler deciding it again could disagree with
the renderer about which one the viewer is in. The four intervals are
prototypes from the brief and say so where they are defined.

What elapsed time does not remove is quantisation, and the first version of
the test asserted that it did. Polling once a frame means a deadline is served
on the next frame boundary, so the achieved interval is the band rounded up to
a whole frame: an 88 ms band runs at 100 ms on 60 Hz and 90 ms on 144 Hz. The
test demanded equal tick counts, which no policy of this shape can give, and
it failed by up to seven ticks. Rewritten, it asserts the gap between
consecutive ticks is never early and never later than one frame, which is the
property that actually holds, and a control confirms the frame count varied by
more than a factor of two over the same span.

Polling per frame is deliberate. A timer would be exactly refresh-independent
and would fire between frames, handing the scheduler a camera the renderer has
not drawn from yet, which trades a bounded timing error for a stale input.

Both ratchets moved the design again and the fan-out one moved it twice. The
decision started in the Viewer, which needed an import and grew the monolith;
it now lives on the scheduler, which already owns what is being paced and
reaches the policy from inside its own cluster. The Viewer ended five lines
lighter with no new import, and one collapsed uniform paid for the rest.

The 200 ms heartbeat stays and is not a competing cadence. It exists for the
periods when no frames are rendering at all, where the loop cannot pace
anything, so removing it would stall a scan whenever the render loop idles.

A real browser run has the sample streaming, resident nodes rising from two to
five across an orbit, and no page errors.

### L122 · FIXED · ARCHITECTURE

Shipped documentation had no narration gate. `pr-hygiene` holds a pull-request
body and every commit message to one rule, that a description says what the
software does rather than how the change came about, and documentation is the
surface that reaches the source archive. Nothing checked it. The only reason
the tree stayed clean is that a tool outside the repository was run by hand
each time, which is a habit rather than a gate.

`lint:doc-narration` closes it by importing `NARRATION_PATTERNS` from
`pr-hygiene` rather than restating them. A second vocabulary would be free to
drift from the one a reviewer is held to, and the two should not be able to
disagree. It is wired into the release chain.

One ledger entry failed it and is corrected. A sentence had described a
pressure-state reading as having looked a certain way before it was
understood, which is an account of an attempt rather than of the software.
The whole tree passes now, so the gate ships with no grandfathered list, and
an exception list is the thing that would erode it.

The gate itself was wrong twice before it was right, and both faults were the
same kind. It swallowed read errors and would have reported success having
inspected nothing, so a read that fails is now a failure and a run that lists
documents while reading none exits non-zero. Then the pathspec `docs/**/*.md`
turned out to match only files at least one directory deep: it skipped all 33
documents sitting directly in `docs/`, among them one written this week,
reported a confident 134 and passed a file that did contain narration. The
count was plausible, which is what made it dangerous. It now lists the
directory and reads 167, and the test asserts the number read rather than the
number listed.

What this does not gate is style. Whether prose reads as machine-written is a
judgement about rhythm and vocabulary, and a hard gate on that fails ordinary
technical writing; the private checker stays a manual tool. This catches only
constructions that are hard to write by accident when describing software.

### L123 · BUILT · ARCHITECTURE

Phase B1. Three parts of the render loop decide independently what a slow
frame means. The refinement phase shrinks the backing store, the scheduler
cadence paces off the same phase, and GPU commits are metered on their own
reading, so on a loaded machine the resolution can step down while a commit
batch sized for a fast frame is still uploading, and the frame that was meant
to get cheaper gets more expensive.

`src/render/perf/frameBudgetGovernor.ts` answers it once. It takes the frame
times the loop already measures and returns a bounded policy: pressure on the
backing store, the share of the commit batch this frame may take and how
urgently the scheduler should push, plus whether lighting, continuity and
detailed hover run. Pure, and it
decides nothing about what is drawn.

The band comes from `bandFor`, the mapping the scheduler cadence already uses,
so the governor and the scheduler cannot hold different opinions about whether
the camera is moving. The phase brief named a fourth set of state names for
the same four states; a fourth vocabulary is the disagreement the module
exists to remove.

Load is a fraction, zero at the target frame time and one at twice it. A
single high frame counts at half the weight of the median, because one slow
frame is usually a decode landing rather than a machine that cannot keep up.

Every switch has a drop threshold above its restore threshold, and inside the
gap the previous answer stands, so the caller passes the policy it applied
last frame and the module keeps no state. A test drives four loads that
straddle the midpoint of the gap and asserts the answer never changes across
them; without the hysteresis it alternates on every frame. The continuous knob
has the same problem in a different shape, so `dprPressure` is quantised onto
a step rather than tracking a noisy median.

Two floors are deliberate. The commit scale never reaches zero while anything
is pending, for the reason `MIN_COVERAGE_FACTOR` is strictly positive: a scale
of zero does not defer the upload, it stops it, and a scan that stops
uploading under load never reaches the frame where the load falls. Streaming
urgency ignores load entirely, because a hole on screen is a hole whatever the
machine is doing.

Continuity runs while refining and nowhere else. Idle is excluded on purpose:
a parked viewer that has finished refining has no visual work left.

Nothing calls this yet, and it is registered as staged. The render loop gets
one caller in B3, where the single request-driven loop is the thing that can
carry the previous policy from frame to frame.

### L124 · BUILT · ARCHITECTURE

Phase B2. `RenderActivityGate` decides whether to draw from two untyped
deadlines and a heartbeat, and a caller that reaches for `bump` or `bumpCamera`
leaves its reason at the call site. The gate knows only that somebody wanted a
frame. That is enough to draw and not enough to sleep: a loop that stops when
nothing asks for a frame has to be able to say what is still asking.

The split between those two deadlines is the same fact told badly. One is
extended by camera motion and the other by anything, which is a property of the
reason rather than of the caller, and picking the wrong method stands Eye Dome
Lighting down over a scene that never moved. That is the bug the second
deadline was added to fix. `src/render/renderInvalidation.ts` puts it in a
table instead: `MOVES_CAMERA` holds the three camera reasons and nothing else,
so a hover, a filter change and a resize each ask for a frame without claiming
the camera moved.

Reasons have one of three kinds. A `once` reason is a change that has already
happened and needs one frame to become visible; it clears when a frame serves
it and cannot be released, because forgetting it would leave the last frame
showing the state before the change. A `holdover` reason is input, which
arrives in a stream whose last member looks like a pause, so it keeps frames
for `RENDER_HOLDOVER_MS` after the most recent one. That window is imported
from the activity gate rather than restated, so the two cannot drift. A `while`
reason is a condition still running, held until its owner releases it.

The deadlock the phase brief names lives in that third kind. A metered GPU
queue that drains only from rendered frames, filled while the loop is asleep,
never drains. The rule is that the empty-to-non-empty transition invalidates
and the opposite transition releases, and a test drives exactly that: three
items queued while asleep, the loop wakes, drains one per frame, and sleeps
again on the frame after the last one. A `while` reason that is never released
leaves a loop that never sleeps, which is the safe direction of that mistake.

It is not an event bus and could not become one. Nothing subscribes and no
reason reaches anything but this module's own set. A general bus would let any
part of the viewer listen for `filter`, and the invalidation vocabulary would
become the application's event vocabulary with parts of the app coupled
through it.

The reasons are kebab-case rather than the upper-case shape the brief sketched,
matching `WakeReason` in the scheduler cadence. Two reason vocabularies in one
render loop should look like the same kind of thing.

Staged. The loop still draws from the old deadlines; B3 is where the single
request-driven loop becomes the caller.

### L125 · BUILT · ARCHITECTURE

Phase B3. The loop scheduled itself: each iteration asked for the next, so
requestAnimationFrame ran at the panel's rate from the moment the backend came
up until the tab was hidden. Skipping the draw kept the GPU idle and left the
callback, the CPU pipeline and the whole per-frame body running sixty times a
second over a scene nobody was touching.

It now runs because something asked. `FrameScheduler` owns the animation
frame and `FrameDemand` owns the question of whether one is wanted, so the
three parts that each answered a piece of it sit behind one object with four
verbs: `input`, `cameraMoved`, `changed` and `needsFrame`. Every caller previously had to
know which of the three to reach for, and getting it wrong is silent.

Measured in a headed browser against the committed multi-chunk LAZ, counting
every animation-frame callback the page runs that three's own vendor chunk did
not schedule, over the same two-second idle window on the same machine:

    before   240 frames
    after      8 frames

Eight is the idle heartbeat. A trace taken with the scheduler's own state
reads `sleeping` with no reasons held while parked, `scheduled` on 22 of 22
samples taken during a drag, and `sleeping` again afterwards. No console or
page errors either side.

The heartbeat is the correction to the first version of this, which slept and
re-asked on a timer without drawing. That is tidier and it is wrong.
`needsFrame` answers what has ASKED, so a scene change that never invalidated
leaves it false forever and a poll re-asks a question whose answer never
changes: the change would never appear. The render gate already had the
answer, an idle heartbeat drawing once every six skipped frames, and it exists
precisely because not everything that changes the scene announces it. The
scheduler now draws one frame every 250 ms while asleep, which states that
same heartbeat in time where it was stated in frames. A missed wake then costs
a quarter of a second rather than everything.

The browser showed things the fakes could not. three's WebGPU renderer
starts an internal animation loop on init and
self-schedules at the panel rate whether anything is drawn or not, so the page
still has a frame owner the viewer does not control. That one belongs to B4,
and until it is dealt with a raw callback count cannot tell a sleeping viewer
from a running one.
The headless runner reports the page hidden, so the visibility handler stops
the loop there and the before and after readings are identical: this property
cannot be measured headless at all. And input dispatch on this fixture costs
seconds per event under load, alike with the change and without it, which is
why the evidence is a frame count rather than a latency.

The ratchets took two passes. Viewer grew by 71 lines, which the shrink-only
lint refused; moving the browser plumbing into the scheduler and lifting the
demand cluster out left the file 32 lines SMALLER than its baseline, and the
drop is banked. Then the module-graph counted a new edge, so the settle gate
and the pose watch now reach Viewer through `frameDemand` rather than through
a second import of their own, which is the arrangement `renderActivityGate`
already had for the same reason.

`_rafId` is gone. Stopping the scheduler cancels both the frame and the
heartbeat, so the field had nothing left to hold.

### L126 · FIXED · ARCHITECTURE

Phase B4. With the render loop request-driven, every other animation frame on
the page is a loop that does not know the renderer has learned to sleep. Two
of them were the viewer's own.

Node fades drove their own frame. A fade is a change to what is drawn, so it
belongs to the render loop: `StreamingRenderer.stepFades` is called from the
frame now, on every iteration rather than only on drawn ones, because a fade
that advanced behind the idle throttle would stall part way through. Starting
a fade asks for a frame through the host, which matters only in the one case
the poll cannot cover: a fade beginning while the loop sleeps would otherwise
not move until the heartbeat, and the heartbeat is slower than the fade.

The view cube polled the camera heading sixty times a second for as long as a
scan was open, to read a number that cannot change without a frame. It now
updates after each frame that drew, through a narrow listener seam on
`FrameDemand`. Its platform shed the animation frame and the visibility
handler with it: the render loop already stops when the tab is hidden, so the
compass had been re-deciding that for itself.

Verified in a headed browser. The rose reads `rotate(-270deg)` before a drag
and `rotate(-239.766deg)` after it, with no frame owner of its own.

The rest of the audit found nothing to move. The relief tile and the profile
section each coalesce their own repaints onto one frame and draw to their own
2D canvas; they are request-driven already and route nothing through the
scene. Frame telemetry samples on a loop only while a benchmark collects, and
routing it through the scheduler would change what it measures. The boot tour
and the workbench use a double frame to wait for layout, which is a one-shot.

One owner is left and it is not ours. three's WebGPU renderer starts an
internal animation loop when the backend initialises and self-schedules at the
panel's rate whether or not anything is drawn, updating its node frame and
resetting its counters. Stopping it means reaching into a private field, and
the node frame it advances drives time-based material nodes, so it stays. It
is the reason a raw animation-frame count cannot tell a sleeping viewer from a
running one, and why the measurements in L125 separate the vendor chunk out.

Two readings during this phase looked like regressions and were not. A drag on
the 81 MB COPC produced zero frames for two seconds afterwards, which is the
browser stopping animation frames for the whole page: the vendor loop's count
went to zero in the same window while a 100 ms interval kept firing
throughout. And the view cube did not mount on that scan at all, before the
change as well as after, so the compass evidence above comes from the light
fixture instead.

### L127 · BUILT · ARCHITECTURE

Phases C1 and C2. Nineteen modules under `render/continuity` each decide one
question: which rung a backend carries, whether a touch device may have it,
when history stops being reusable, where the lens is, what to give up under
pressure, what to do when a pass throws. Every one is pure and tested, and
none of them holds the answer from last frame.

`ContinuityRuntime` holds it. One object, one call per frame, and an order
that is the contract: the ceiling resolves first, because a rung the device
cannot carry must not reach the capabilities; pressure then moves one rung
inside that ceiling; the epoch advances next, since the convergence sweep is
defined against the epoch in force and would otherwise contribute a phase to a
picture that has already changed; the exposure reads the convergence it
describes, so it is last.

It owns presentation state only. No point, no cloud, no terrain product, no
claim and no export record is held by it or reachable from it. GPU resources
are named in the brief as its own and it holds none, because none exist yet:
every capability that would allocate one is off, which is also why
`historyTargets` still has no caller.

Two decisions are the runtime's rather than any module's. A failure lowers a
ceiling that nothing raises, so a device that refused a history is not
promoted back into asking for one the moment its frame times recover; a
refusal is evidence about the device, and evidence does not expire because the
next few frames were quick. And it starts at `source` rather than at whatever
the ceiling permits, so the first frame does not begin at the top and discover
the device cannot hold it.

With nothing opted into, `grantedTier` returns `source` for every input, the
capabilities are all off and the plan reports `active: false`. A test asserts
that on a backend measured to carry everything, which is the shipped
configuration.

C1 asked for a lazy seam and the seam is not here. The one-line export was
written and the build refused it: this repository emits a code-split chunk
only for a dynamic import that something reaches, so an export nobody imports
is shaken out, and the chunk-emission guard then fails the build for a seam
that emitted nothing. The guard derives its required list from
`lazyChunks.ts`, which is what makes a seam with no caller a build error
rather than a silent no-op. The seam is therefore one line in the change that
adds the first caller, and the eager entry is unchanged at 807 KiB meanwhile.

Registered as staged, with its dependencies. Adding the seam had graduated
eight modules out of the register on the strength of an import nothing
crosses, which would have recorded them as reached by production when nothing
runs them.

The sweep's cadence is worth stating, because it reads off by one. Two phases
take three frames: the frame that opens a sweep draws phase 0 and merges
nothing yet, and each later frame counts the one before it, so `contributed`
always means phases already merged. The test asserts the drawn phases rather
than the frame count, which is the thing a reader wants.

### L128 · BUILT · ARCHITECTURE

Phase C3. The tier ladder existed and there was no way to ask for a rung. Six
independent switches is sixty-four combinations and four were designed, which
`devFlags` said in a comment; the only way to run `closure` was to set three
switches and know which three, and the way to run it wrongly was to set two.

`?continuityTier=` names one of the four. The switches stay, because a switch
is how a combination gets bisected when a rung misbehaves, and they can only
add: a switch never takes a capability away from the rung that was asked for,
so `?continuityTier=closure&continuityEvidenceLens=0` is still closure.
Subtracting is what would put the sixty-four combinations back.

`continuityRequest` reconciles the two surfaces in one place. The rung is the
richer of what the dial says and what the switches imply, so a bisecting
switch on its own still does something; the opt-in is the union, so a rung
carries its own capabilities whether or not the matching switch was set. A
tier name it cannot read takes the bottom rung, because a typo in a query
string must not turn the ladder on.

The brief's intersection was short one term. Requested, backend, device class
and opt-in were all in the ceiling, and memory pressure was not.
`ContinuityRuntime.ceilingFor` now takes it, and takes it from the streaming
scheduler's own predicate rather than measuring the resident set again: the
scheduler already compares resident plus decoded-pending points against the
budget's pressure ratio before it evicts, and that expression is now a method
both readers call. A second comparison would eventually disagree with the one
that actually evicts, and the disagreement would show as the field standing
down while the scheduler says there is room, or the reverse.

Memory pressure takes the rung that keeps a history and nothing else.
Accumulation is the only capability holding surfaces between frames; sizing
and gap closure spend the frame they run in, so dropping them would cost
quality and free nothing. It is also the one term that lets go: being short of
room is a passing condition, where a refusal is evidence about the device and
holds its ceiling for the session.

### L129 · BUILT · ARCHITECTURE

Phase C4. The display-state vocabulary already carried every input the brief
names and `advanceEpoch` already turned a change into a new epoch. What
nothing did was say what a change costs.

`historyTargets` had the distinction from its own side: contents that describe
a different picture leave buffers of the right shape holding the wrong pixels,
so clear them; a backing store of a different size, or a device remade, leaves
buffers of the wrong shape or belonging to something that no longer exists, so
free them and make new ones. Its `clear` and `resize` are both there. Nothing
chose between them, and a caller that reached for `resize` on every epoch
would rebuild three textures on every camera nudge, which costs more than the
accumulation saves.

`repairFor` chooses. Four of the seventeen inputs reallocate: the two
dimensions, the device pixel ratio, and the device generation. The rest clear.
A set of changes takes the most expensive repair any of them asks for.

It is a `Record` over the whole field union rather than a list of the
reshaping ones, so adding a field to `DisplayState` does not compile until
somebody has said what it costs. That is the same rule the field list already
followed, one step further on: the set of things that can throw away history
was reviewable in one place, and now so is the price of each.

The plan carries the repair. A test walks all seventeen inputs through the
runtime and asserts each one advances the epoch and names itself as the
change, which is the brief's requirement that validity depend on every
presentation-relevant input, checked against the runtime rather than against
the diff underneath it.

### L130 · BUILT · ARCHITECTURE

Phase C5. Coverage sizing was already live and had no way to be asked for.
`CoarseLodSizeNodes` folds a coverage term into the size graph for streamed
materials, driven by a uniform that reads 1 in `density` point-size mode, and
`devFlags` said as much: the capability flag "is for the capability record,
which nothing consults yet". So the behaviour shipped, reached only by
choosing a point-size mode, and the ladder that names it could not turn it on.

It can now. The uniform takes two ways in and stays one term: choosing
`density` asks for coverage sizing by name, and the ladder's `sizing` rung
grants the same thing without the viewer having to know which point-size mode
implements it. A second coverage term would be a second answer to one
question, visible as two sizes in one picture.

The grant is answered once, at construction, because this capability needs
nothing per-frame: no history, no epoch, no sweep. That is also why it does
not go through `ContinuityRuntime.prepareFrame`, which exists for the rungs
that do. `coverageSizingGranted` passes `sizing` as the backend term because
`tierFor` never answers below it, so no probe could lower a request for this
rung, and passing it caps the answer there.

Measured in a headed browser on the 81 MB COPC, same view, panels identical,
counting pixels above a fixed luminance over the whole 1000 by 700 frame:

    default vs default   0.00 % of pixels differ, 52,157 lit both times
    default vs sizing    1.35 % of pixels differ, 52,157 to 53,783 lit

The control is what makes the second line evidence. Two default runs are
pixel-identical, so the difference under the flag is the feature rather than
streaming arriving differently between sessions.

What was not adopted is the basis. The programme names projected spacing, and
`coverageSizing.ts` implements it: sample spacing put through the camera, the
same projection the scheduler uses to decide whether a node would add visible
coverage, imported rather than restated. The live term sizes from relative
node resolution instead, which is camera-independent, so two nodes at the same
depth take the same scale whether they are near or far. Projected spacing is
the better basis and swapping it in replaces the basis of a behaviour that
already ships: it needs a per-material distance uniform written every frame
and a real-scene comparison showing the picture improves. Until then the live
term is the only coverage sizing, so that there is one answer in one picture,
and the module is registered as staged with that as its graduation.

The four spacings stay apart by construction rather than by comment. No
function in `coverageSizing.ts` takes a point count or an area, and none
returns one, so a density cannot be assembled from what it offers. A test
strips the comments from the source and fails on any executable line that
names a count, an area or a density, and asserts the stripped source is still
the module rather than an empty string.

### L131 · BUILT · ARCHITECTURE

Phase C6. The four states existed: `microGap` names them and `supportCensus`
counts them. What nothing held was the part a renderer cannot be trusted to
remember, which writes may move a pixel from one state to another.

`supportProvenance` holds it. A source sample is authoritative and overwrites
any state, including a pixel reconstructed a moment earlier, because a sample
landing there is what the fill was standing in for. Accumulation carries
forward only what came from samples. Reconstruction fills only a pixel with
nothing in it, never over a sample and never over another fill, which is how a
one-pixel seam would become a patch across a sweep.

The transition that must not exist is reconstructed becoming direct or
accumulated without a sample. That is the laundering step: once a filled pixel
is indistinguishable from a measured one it becomes evidence for filling its
neighbour, and the renderer walks a surface across ground nothing was recorded
on. A refused write returns the state the pixel already had rather than
throwing, because this runs per pixel in a pass that must not lose a frame.

`microGap` already enforced the same rule from the other end, where it reads
its cardinals. A test drives `shouldFill` with all four neighbour states and
asserts it fills exactly when `maySupportReconstruction` says it may, so the
two ends cannot drift apart without something failing.

The representation adds nothing to the budget. Two bits of provenance and six
bits of a saturating sample count fit in the `r8unorm` byte the history layout
already allocates, with provenance in the low bits so a reader that wants only
the state masks with three. The count saturates at 63, an order of magnitude
past the four samples the support scalar reads as full.

`r8unorm` means a shader reads 0 to 1 rather than 0 to 255, and a bit field
only survives that trip if both ends agree on the scale and the rounding. Both
directions live in the one module, and a test round-trips all 256 bytes
through it.

The name is display-support provenance. Not confidence, which would be a claim
about how likely the picture is to be right, and not completeness, which would
be a claim about how much of the scene was captured. This is neither: it says
which pixels a sample was rasterised into and which the renderer filled, for
one frame at one camera. A test strips the comments from the source and fails
on either word appearing in a line that runs.

`censusOfPacked` bridges the surface to the count, so a diagnostics read of the
one byte per pixel produces the same census as decoding each pixel by hand, and
the reconstruction-share ceiling is checked against the thing that was drawn.

### L132 · BUILT · ARCHITECTURE

Phase C7. The per-pixel decision existed. `microGap` judges one background
pixel against its four cardinals, `normalAgreement` adds the orientation test
where a source carries normals, and `supportProvenance` says which writes are
allowed. None of them walks a raster, and walking it is where the two rules
that matter live.

The first is how wide a gap may be. `runMicroGapPass` reads the four immediate
cardinals and nothing further, so what it closes is a gap one pixel thick
along at least one axis.

One pixel thick is not one pixel in total, and assuming the stronger bound was
wrong about the code rather than about the intent. A slit one pixel tall and
twenty long fills, because every pixel in it is bracketed above and below by
samples that agree on a depth, which is a row of sampling gaps rather than a
hole. A region two pixels thick in both directions fills nothing at all: each
of its pixels has background on two sides, so no opposite pair supports it and
fewer than three cardinals do. The bound is on thickness, so no amount of
length gets a surface across an area where the scan recorded nothing on both
axes. Tests state both, including a five-pixel slit that fills and a three by
three hole that does not, five passes running.

The second rule is that a fill is never evidence. The pass reads one raster
and writes another, so every decision is taken against the support the frame
arrived with and a pixel filled early in the walk cannot support the pixel
beside it later in the same walk. Writing in place would make that depend on
iteration order, which is the kind of correctness nobody can see in a
screenshot: a left-to-right walk would close a two-pixel gap one pixel at a
time and call the result supported. `microGap` refuses reconstructed
neighbours across frames; reading the input raster is what stops it within
one.

What the pass cannot touch is structural rather than trusted. Its signature
carries support and depth, with normals optional, and a test fails on any line
that runs naming a position, a point buffer, a pick target or a measurement.
Reconstructed pixels stay unpickable because picking goes to the source points
and never to this raster.

The provenance rule has the last word: a centre the pass should not fill
cannot be written even if the geometry rule said yes, because `nextSupport`
refuses everything but `none`. That is redundant with `shouldFill`'s own first
test, and deliberately so, since the two rules are owned by different modules
and only one of them is about geometry.

### L133 · BUILT · ARCHITECTURE

Phase C8. The lens had its geometry and its placement and no connection to the
pass that substitutes pixels. `evidenceLens` knew which positions it covered,
`lensPlacement` knew where a pointer, a finger or a key put it, and the gap
pass filled wherever the rules allowed regardless of either.

`lensPresentation` connects them, and the connection is two rules rather than
one. The gap pass now takes a lens and refuses every fill it covers. A pixel
already filled before the lens moved over it shows as nothing, because the
fill was covering a gap and the lens is the viewer asking to see the gap. That
substitution is read-time and never a write: the support surface keeps the
record that the pixel was reconstructed, because a lens is a way of looking
rather than an edit.

Accumulated pixels stay under the lens. They were built from source samples
across a sweep, which is what the lens is for showing, and hiding them would
leave it displaying less evidence than exists.

The feather is the part most likely to go wrong, so it is separated by shape.
The blend is a number between 0 and 1 and the admission is a boolean, and the
boolean reads `insideLens`, which does not interpolate and whose reach
includes the whole feather. A pixel four-tenths of the way through the fade is
still one the viewer is looking through the lens at, and filling it
four-tenths of the way would be a reconstruction the lens was supposed to have
refused. A test drives the fade across five positions and asserts the blend
takes several values while the decision takes one. Another reads the
admission function's own body and fails if it ever mentions the blend.

Placement stays with the reducer. A test drives a touch lens through the
intent path, lifts the finger, and asserts the lens still refuses at its
centre, which is the pinning rule `lensPlacement` exists for holding.

Picking is absent and that is the answer rather than an omission. A click
resolves against the source points, so a reconstructed pixel was never
pickable and the lens does not have to make it so. A test fails if this module
ever names a pick, a raycast or a hit test, because anything here that changed
what a click hits would be a second picking path beside the one that already
works.

### L134 · BUILT · ARCHITECTURE

Phase D1. `DisplayState` carried `deviceGeneration` and `historyTargets`
reallocated when it changed, and nothing produced the number. It now has a
producer.

The trap it exists for is worth naming. A surface allocated on a device that
has since been lost is not a surface of the wrong size: it is the right size,
still referenced, and every check comparing dimensions calls it current. Only
the device it came from distinguishes it.

Four events advance the counter, each on its own evidence, so a
lost-then-restored cycle advances twice. A counter that advanced once per
cycle would have to know, at the moment of the loss, whether a restore is
coming, and a context can be lost and never restored. The number is compared
for equality, so counting an era twice costs nothing while missing one shows
pixels from a dead device. `lost` is a separate flag, because the generation
says which era a resource belongs to and not whether anything can be allocated
right now.

The wiring changed once the browser was consulted, and the correction is the
useful part of this entry. The first version listened on the canvas for both
context events and cancelled the loss, on the reasoning that without
`preventDefault` no restore follows. A forced context loss in a headed browser
showed `defaultPrevented` true and a restore arriving on the unmodified build
as well, and three's WebGL backend turned out to call `preventDefault` in its
own listener before reporting through `renderer.onDeviceLost`. Cancelling
again was a second opinion on a question that already had an owner.

So the loss now arrives through that hook, which both backends call with the
API named in the report, and the wiring chains rather than replaces it: three's
own handler logs the message and sets its internal flag, and dropping it would
trade a diagnostic for a counter. Only the restore is still watched on the
canvas, because it is the one event with no owner at all: nothing in the
renderer rebuilds on it.

Measured against a real loss, with `WEBGL_lose_context` on the WebGL backend
reached by hiding `navigator.gpu`: the context reports lost, the restore
arrives, the context reports usable again, the interface is still there and no
page error is raised either side.

A first measurement of this said `defaultPrevented` was false. The observer
had been attached before the Viewer's own listener and read the flag before
the cancelling handler had run, which is registration order rather than
anything about the software.

### L135 · BUILT · ARCHITECTURE

Phase D2. `HistoryTargets` could allocate a set of surfaces, clear it and release it,
and nothing decided when. The runtime now owns it, and only when a caller hands it a way
to make surfaces: without a factory there is no history and every frame plans
as though there never was, which is the shipped case.

Everything the phase says should bound the history does. The viewport and the
device pixel ratio decide its shape and reach it as a `reallocate` repair, and
the device generation rides the same path, which is why a device remade at the
same size still rebuilds. The memory ceiling is checked before anything is
asked for, and the backend format is the layout's. Then there is the device
itself, which can refuse.

A refusal used to be a thrown frame. `resize` now catches it, releases what it
had already made and records `allocation-failed`, which is
deliberately a different refusal from `over-ceiling`: one is this code
declining to ask and the other is the device declining to answer, and only the
second says anything about the hardware. Releasing the partial set matters for
the reason the three surfaces are allocated together, that a colour history
with no depth beside it is the photographic accumulation this renderer must
not do.

Either refusal costs a rung, and the ceiling holds there. A device that cannot
keep a history now will not be able to in a hundred frames, and asking again
every frame is how a viewer spends a session allocating. A test drives twenty
frames after a refusal and asserts the factory is never called again.

The plan is resolved twice for the frame that refuses. The rung is given up
inside `prepareFrame`, so the capabilities are recomputed from the tier that
survived: reporting the tier after the degrade beside the capabilities from
before it would describe a configuration nobody chose, and a caller reading
`temporalAccumulation` would accumulate into a history that had just been
refused.

Nothing a refusal does can reach the scan. The runtime holds no cloud, no
store and no eviction path, so the only thing it can spend is display quality,
and a test fails on any line of it that runs naming one of those.

### L136 · FIXED · ARCHITECTURE

Phase D3. A sweep may only run under a still camera, a complete refinement and
an epoch that did not move. The camera and refinement conditions were enforced;
the epoch condition was not, and a moved epoch is what produces a visible
artifact.

`nextConvergence` already refuses anything short of `full-refine` and restarts
when the epoch differs from the one being accumulated. What it did not refuse
was the frame on which the epoch changed. That frame has just cleared the
history, so contributing to it merges one phase into an empty set, and a
converging sweep is presented as the accumulated image rather than the direct
one. While a camera moves, every frame opens an epoch, so a viewer holding a
drag would have been shown a quarter of the points instead of the scan.

The conjunction is now written out where the plan is resolved, and the frame
that opens an epoch contributes nothing and is exposed as `direct`. A sweep
begins on the first frame where the picture has stopped changing, which costs
one frame and is what the phase asks for.

A test drives ten frames of a moving camera and asserts the sweep never leaves
idle and the exposure never leaves direct. That test is what found this: it
was written to confirm the rule and failed, because the rule was not there.

The rest of D3 is the phase scheme, which was already deterministic and is now
also shown to be complete. The partition is a function of a point's index and
its node's seed with no frame number and no clock anywhere in it, so a sweep
cannot move a point between phases while the image is being built. New tests
assert that a sweep draws every one of four thousand points in exactly one
phase, at each of the three phase counts across three seeds, that no phase falls
outside its range, and that each carries its share to within one per cent,
which is what keeps one frame of every sweep from being the slow one.

A first version of the moving-camera test collided with the fixture's own
camera value, so its first frame found the epoch unchanged and read the sweep
the settle had left converged.

### L137 · BUILT · ARCHITECTURE

Phase D4, and two corrections from review.

The merge rules existed per pixel and nothing walked a frame with them.
`historyMergePass` does: an empty pixel takes the sample, a sample clearly in
front replaces what was there, a sample on the same surface within the depth
tolerance is added to it, and a sample clearly behind is dropped.

The reason this is not ordinary temporal anti-aliasing is that nothing is
reprojected. The usual approach transforms the previous frame through the new
camera and blends, which is where ghosting comes from: a pixel that used to
see a wall and now sees the floor behind it keeps some of the wall. Here the
history is only merged into while the display epoch stands still, so every
contribution was drawn through the same camera and a pixel's samples are all
of one view. Camera motion moves the epoch, which clears the history rather
than transforming it. A test fails on any line of the pass that runs naming a
camera, a matrix, a motion vector or a reprojection.

The pass refuses a frame whose epoch differs from the history's. The caller is
expected to have cleared it already, and refusing here as well is the cheaper
half of a rule whose other half somebody has to remember.

Two tallies that would have read the same were separated. A pixel the frame
drew nothing into is skipped; a pixel whose sample lost to what the history
held is kept. Folding them together would report a frame that drew nothing as
a frame whose every sample was occluded.

A blend keeps the nearer of the two depths, for the reason the gap pass takes
the nearest supporting neighbour: the two agree to within the tolerance, so
the choice barely moves the value, and keeping the nearer one stops a merged
pixel drifting behind the surface it belongs to.

Review found two defects in earlier phases, both real.

The gap pass read its normals straight out of the flat array at `i - 1` and
`i + 1`, with no row-boundary check, while the depth and support lookups
clamped through `at`. A pixel at x = 0 that is bracketed vertically is
fillable, so its fill was being admitted or refused on the orientation of the
previous row's last pixel. The normals are indexed through the same bounds
now, and two tests pin the edge: one where only the wrapped pixel disagrees
and the fill must stand, one where a real neighbour disagrees and it must not.

The device-loss wiring returned a detach and the Viewer dropped it, keeping
only the canvas one. The hook is a closure over the object that installed it,
so a disposed viewer stayed reachable through `renderer.onDeviceLost` and went
on advancing a counter nothing reads. Both sources now come from one call that
returns one detach, which is a line shorter at the call site than the two it
replaces.

### L138 · FIXED · ARCHITECTURE

Phase D5. The render loop shades once the moment the camera parks, which is
right when nothing is accumulating and wrong the moment something is. Parking
is the first frame of a sweep, so the repaint lights an image one phase
complete and never lights it again: the flag it sets says the at-rest paint is
done. The viewer would be left looking at a quarter of the scan with depth
cues drawn over it, which reads as a finished picture rather than a partial
one.

The loop now defers it while a sweep is converging. The shading belongs after
the last phase has merged and after any closure over the result, which is the
order the phase sets out: phases, the accumulated history, gap closure, EDL,
composite. `converged` and `none` behave alike, which is the point rather than
a shortcut: with accumulation off a sweep never starts, so it is never part
way through and the repaint happens exactly when it did before. Four tests
pin that, including one that parks for five frames mid-sweep and asserts no
shading at all.

Where the rule lives was decided by the bundle rather than by taste, and the
figure is worth recording. The rule was first written as an exported predicate
beside `edlActiveThisFrame`, which is where the other pure gate decisions are.
Six lines, never called, cost 2 KiB in the live Viewer chunk, taking it from
739 KiB to 741 against a 740 KiB ceiling. The same condition written inline in
the loop costs nothing measurable and leaves the chunk at 739.

That is the obfuscating transform amplifying a new export rather than anything
about the six lines, and the placement it forced is defensible on its own:
`edlMotionGate` says in its own header that the loop owns the snap-back
bookkeeping, and the sweep check is a condition on exactly that state. The
loop is tested against a fake host, so nothing became less testable.

The Viewer chunk has about a kilobyte of headroom, which is the constraint any
further work in this cluster has to plan around.

Three size measurements were wrong before they were right. `check:bundle`
reads whatever `dist` holds, and a build that fails typecheck leaves the
previous one there, so a stashed source tree with unstashed tests reported the
size of the build before it.

### L139 · BUILT · ARCHITECTURE

Phase D6. The rule is short: no benchmark record, no production default above
`source`. It was written down and nothing held it, which matters because
turning a rung on is a one-word edit to a defaults table that no other check
has an opinion about.

`lint:tier-evidence` reads the defaults table and the record directory
together. A default of `source` needs nothing. A default above it needs a
record measuring that rung and every rung beneath it, because a default of
`full` backed only by a `full` measurement skipped the two it is built on. A
record the lint cannot parse counts as no evidence: a malformed file is the
benchmark verifier's to report, and letting one authorise a default would be
the worst of both.

What it does not do is judge the numbers. Whether a measured rung was fast
enough, or leaked too much at an edge, is a reading a person makes. This
refuses the case where there is nothing to read. Tests drive it at each of the
three rungs, at a tier name that is not a rung at all, and at a defaults table
with the line removed, which it reports rather than passing an unread default.

The record itself was short of what the phase lists. The adapter and the
operating system were optional and are now required, because a frame time
without the machine that produced it says nothing that transfers anywhere
else. A case now carries the point count and the camera pose: `cameraCase`
names a situation and a pose is what reproduces it. A measurement carries the
reconstructed share explicitly rather than leaving a reader to subtract, and
the verifier checks that the direct and reconstructed shares sum to what was
drawn, since every pixel came from a sample or from a fill.

The corpus requirement grew a dimension. It was every scene; it is now every
scene at each of the three rungs, because a record covering ten scenes at one
rung says nothing about whether the rung above it was worth its cost.

Two of this repository's own guards caught mistakes in the work. The
Windows-path lint refused a test that derived a filesystem path from
`URL.pathname`, which yields `/C:/...` on Windows. And the first version of
the evidence test made its point by editing the real defaults table while the
rest of the suite was reading it; the lint now takes both of its inputs as
arguments, so the test points at copies.

### L140 · BUILT · ARCHITECTURE

Phase D7. Five of the six triggers the phase names already lowered the rung,
each through the part that owns it: an unsupported format and a backend with
no room through `tierFor`, memory pressure and a past refusal through the
ceiling, repeated slow frames through the pressure step. Device loss did not.

It does now, and where it enters matters. A lost device would have been caught
at the allocation, since asking one for three surfaces fails, but the answer
would have been `allocation-failed`, which is evidence about the hardware and
lowers a ceiling for the session. A device that came back would have paid a
rung for having been away. So the loss is read at the ceiling instead: while
one is gone the rung is `source`, no history is asked for, and nothing is
recorded against the device. When it returns the ladder climbs again.

A `device-lost` refusal was written first and removed, because it could not
happen: the ceiling reaches `source` before the allocation is considered, so
no history is ever wanted while a device is gone. Two mechanisms for one fact
is the arrangement this programme keeps taking out, and a value that cannot be
produced is worse than none, since a reader would look for the case that
returns it.

Tests now walk each trigger to the rung it lands on, and one drives twenty
frames with slow frames, memory pressure and a device coming and going all
interleaved, asserting every frame reports a rung of the ladder. The bottom is the renderer as it shipped:
a runtime that has failed everything reports `source` with no capabilities and
a direct exposure, which is the phase's rule that presentation enhancement
being unavailable is not a fatal error.

### L141 · BUILT · SCIENCE

Phase E1. ASPRS gives the Withheld bit one meaning: the producer marked this
point as one that should not be used. It does not say deleted and it does not
say wrong, so the answer differs by what the points are being used for. A
person inspecting the scan sees it, marked. An export writes it back with the
bit intact. A computed product leaves it out, unless the caller asked for it.

`withheldPolicy` is that, in one place. The include-anyway argument only
reaches scientific processing: inspection and export preserve whatever is
passed, because a flag that could delete points from an export would be a way
to lose data by mistake.

Overlap is never excluded, and the reason is worth keeping beside the code.
Overlap marks the seam between two flight lines, which is a statement about
coverage rather than about the point: the ground under an overlap was measured
twice, not badly. A processor that dropped it globally would thin every seam
in the survey, in exactly the strips where two passes agree. A test reads an
overlap point in all three contexts and excludes it only when it is also
withheld.

No classification code is reinterpreted. The code and the flags are separate
fields and stay separate, and a test fails on any line of the policy that runs
naming a class at all. What the bits mean stays with `lasSemantics`, which
this decodes through rather than testing a bit of its own, and a second test
fails if a bare mask appears here.

The audit is the substance of this entry. Nothing in the tree consults the
Withheld bit. Terrain, density, the ground filter, stockpile volumes, contours
and profiles read every point the cloud holds, and so do the classifier,
registration, change detection and measurement. The bit survives the whole pipeline,
from the decoder through `PointCloud.classificationFlags` to the LAS writer,
so applying the policy is a matter of consulting something already there.

A test walks the four scientific source directories and asserts that none of
them reads the flags, which pins the audit rather than the intention. When a
product starts applying the policy that test fails, and its message says what
the failure means: record the before-and-after for that product, because its
numbers moved.

They will move. Every product listed changes on any scan that marks a single
point, and several carry claims with recorded evidence, so the policy is
written down here and applied product by product, each with its own comparison
on real data. Applying all of them in the change that defines the rule would
put a numerical shift into a release under the heading of a definition.

### L142 · FIXED · ARCHITECTURE

Phase E2, which asks for a common finalization to be extracted only if doing
so reduces duplication without weakening what is already guaranteed. The
answer to the passport half is no, and the reason is worth recording rather
than leaving as a silence.

`buildScientificArtifactPassport` has one caller. The DEM package assembles
the source identity, the analysis record, the processing manifest, the
evidence decision and the digest of the raster it names, in about forty lines
in one place, through helpers that already exist. Extracting a finalization
helper from a single implementation would produce an abstraction whose shape
is decided by its only user, which is the thing that has to be rewritten when
a second one arrives.

What is already guaranteed is also already tested. The passport has thirteen
tests and a tamper suite of its own, and the sidecar rule is pinned: the
record digests one file rather than the archive it rides in, because a record
digesting the archive that contains it could never verify. Rewriting that
path could only lose ground.

There is real duplication next to it, and that is fixed. Both deliverables
write a `SHA256SUMS` manifest and each built it separately: the DEM package
exported a helper and the contour package inlined the identical expression.
The same format has to hold for both, because a recipient checks them the same
way, and two copies of one format stay correct exactly until one is changed.
The builder now lives beside the hash it calls, where the contour package
reaches it without importing a DEM module, and the DEM package re-exports the
name its callers knew. Every file in both deliverables is byte-identical:
16,674 tests pass, including the byte-identity ones over those packages.

The gap worth naming is not a refactor. The contour deliverable carries no
passport at all, so a recipient cannot verify it the way a DEM recipient can.
Adding one puts a file into a shipped archive and is a product decision with
its own evidence, rather than something to fold into a change about
duplication.

### L143 · BUILT · ARCHITECTURE

Phase E3, which asks for honest open stages if they are not already present.
Half of it was, and the half that was missing is the vocabulary rather than
the behaviour.

`loadProgress` names the seven stages a file passes through, from detecting
its format to rendering it, and those describe what the pipeline is doing.
Nothing named the other thing: whether the person in front of the screen can
look around yet, and whether more is still arriving. Decoding says nothing
about whether a camera responds, and a scan whose decode finished can still be
streaming nodes in, so folding the two together would give one word two
meanings and a surface reading it would pick the wrong one.

`openStage` names the second. It tracks nothing: the stage is a function of
facts the application already holds, whether a preview is mounted, whether the
cloud is attached, whether the streamer has work outstanding, and where the
refinement phase is. A tracked stage would be a second opinion about a load
that already has one.

A null refinement is read as not yet assessed rather than as motion. The two
are different facts and confusing them would report a still scan as refining
for as long as it is open.

What these stages do not mean is written into the module and checked. `ready`
means the picture has stopped changing, and nothing more: not that the source
is complete, not that every point has arrived, not that a measurement would be
sound. A test fails on any line of the module that runs, and on any label,
naming completeness, validity or accuracy. A stage name implying those would
be the most easily believed false claim in the application, because it appears
while somebody is waiting and reads as permission to trust what is on screen.

The overlay rule was already held, and reading the code is not how that was
established. A run against the 81 MB COPC sampled the page four times a
second: the empty state comes down 470 ms in, and across the thirty-two
samples after it the element at the centre of the canvas is the canvas. The
rule the phase states as a threshold at `interactive` is met one stage earlier,
at `preview`, because the empty state is hidden the moment a preview mounts.

### L144 · BUILT · ARCHITECTURE

Phase E4. Orbiting around a point nobody can see feels imprecise without being
wrong: the camera does what it was told, and the viewer has no way to tell
where the centre is until something moves. `pivotMarker` decides how strongly
to draw a mark there for half a second.

Three of the four rules the phase sets are structural rather than promised.

It is never pickable because picking never reaches it. `Viewer` resolves a
click by walking its own cloud registry and testing the ray against each
cloud's points, and nothing in that path traverses the scene graph, so an
object added to the scene cannot be hit however it is drawn. A test asserts
that, and says what to do if it ever fails: the marker needs a layer mask
rather than an argument.

It is never captured. `visibleDuringCapture` takes nothing, because no
argument could make the answer yes: a figure is a statement about what was
observed and a mark at a pivot is a statement about where the camera is
turning.

It is never data. Nothing in the module produces a position, a coordinate or a
measurement; the caller already has the pivot, and a module that returned one
would be a second source for something the navigation controller owns. A test
fails on any line that runs naming one.

Reduced motion follows `ResultFocus`, which drops both ends of its animation
rather than shortening them. The mark appears at full strength and is gone
when its life runs out, with no growth and no fade, because a fade is still
something changing on screen for a viewer who asked for less of that. A test samples four moments of
its life under that preference and asserts every one is identical.

It is not wired, and the reason is measured rather than preferred. Drawing it
needs a three.js object in the Viewer chunk, which is at 739 KiB against a
740 KiB ceiling. A six-line exported function measured 2 KiB in that chunk
under the live transform in L138, so a mesh and a material do not fit. The
wiring itself is small and the register entry says what it is: a layer module
owning its object through `Viewer.derivedLayerHost()`, a show call wherever the pivot
moves, and one render-loop host method to step it. What has to come first is room.

### L145 · FIXED · ARCHITECTURE

Two defects from review, both in work from earlier in this programme.

The coverage-sizing grant left the shader and its own reference function
disagreeing. `CoarseLodSizeNodes.setMode` sets the uniform whenever the rung
was granted, in any point-size mode, which is what the grant is for.
`nodeCoverageScale`, the function a test or a diagnostic reads to say what
that uniform does, still decided on the mode alone: with `sizing` granted and
the viewer in `adaptive`, the shader applied the coverage term while the
reference said no coverage scaling was in effect.

The fix is in the reference, which now takes the grant as the uniform does,
defaulting to false so a caller that knows nothing about the ladder reads the
rule it always read. `setMode` routes through it rather than repeating the
test, which changes nothing today and stops the two drifting again.

A test asserting the two agree in every combination of mode and grant passes
against the defective version as well, because once the reference takes the
grant the two expressions are the same boolean. The test is kept for the other
direction: reverting the `granted` term in the reference turns it
red at `adaptive/true`, which is the defect that was there. The comment now
says that rather than claiming the test catches something it does not.

The second was stale comments in the render loop. A member removed with the
frame-count cadence left its description behind, where it sat above
`tickStreaming` and described a frame counter that no longer exists, and the
docblock for the removed `STREAMING_TICK_INTERVAL` stayed as a heading with
nothing under it. The reasoning in that block is worth keeping and now sits
with the call it describes, in the loop body.

### L146 · FIXED · EVIDENCE

`flow_oracle.py` is a second, independent implementation of the D8 flow
direction and accumulation the field-simulation lab uses, checked with `npm
run validation:field-simulation:verify` against five frozen fixtures. Nothing
ran it: the script was absent from `test:release:execute` and from every
workflow under `.github/workflows`, so a change to the oracle, a fixture, or a
frozen record could drift from the TypeScript implementation with no gate
noticing.

`validation:field-simulation:verify` now sits in `test:release:execute` next
to `validation:field:verify`, so `scripts/gate.sh` runs it on every release and
`ci.yml`'s `verify` job runs it on every push and pull request, beside the
Python version lint. Corrupting one `upstreamCells` value in
`validation/field-simulation/expected/plane-east.json` fails the check with
`upstreamCells differs from the frozen record`; restoring the file passes it
again.

### L12 · FIXED · UI

Pinch, rotate and two-finger gestures now run on Chromium, WebKit and Firefox.

The blocker was never the gesture or the engine. The three pose tests read the
camera through a share link on the clipboard, and only Chromium grants
`clipboard-read` under Playwright. The address-bar fallback the spec relied on
fires only when `clipboard.writeText` rejects; on WebKit that write resolves,
so nothing reached the address bar either and the tests failed on the
empty-oracle guard before reaching the recogniser.

The pose now comes from `__OLV_TEST_API__`, which needs neither the clipboard
nor the desktop dock. The recogniser is untouched; only how its result is read
has moved. Five tests pass on each of the three engines. Freezing the oracle to
a constant fails the two tests that assert the camera moved, so it observes the
pose rather than reporting a fixed value.

Section 70 forbids substituting mouse simulation for touch verification. These
remain synthesized `PointerEvent`s with `pointerType: 'touch'`, which is what
Playwright exposes; real hardware multi-touch on an iOS device is still
unverified, and L13 still records the matrix as advisory.

### L12 · FIXED · UI

Also running in the iPhone-shaped WebKit project, which CI already executes
(`browser-smoke.yml`, `--project=webkit-mobile`). The touch specs were outside
that project's `testMatch`; they are in it now, so the recogniser is exercised
at 393x852 with `hasTouch` on every push rather than at desktop width only.

The Rendering section holding the Touch-twist chip exists in the DOM but has no
layout box at phone width, so a click on it reports "element is not visible",
which reads as the setting being unreachable on a touch device. It is
reachable: the panels move into a collapsed bottom sheet whose View tab holds
the section, and at 375x812 the chip measures 44 px and carries
`olv-chip-active`. The helper opens the sheet when the summary has no box, and
the five pass on Chromium, WebKit, Firefox and iPhone WebKit.

Still synthesized `PointerEvent`s, which is what Playwright exposes on every
engine. Real hardware multi-touch on a physical device remains unverified.

### L47 · FIXED · UI

The entry describes a grid keyed by x and y. `localDensitySize.ts` keys on the
cloud's two widest axes: `dominantPlane` measures all three extents, drops the
narrowest, and returns the rest, so a facade bins across its own surface rather
than edge-on. `localDensitySizes` reads those axes rather than assuming x and y.

The orientation case the entry warns about is covered: a surface laid flat and
the same surface upright produce identical scales, over five noise levels.

A narrower defect sat behind it. The plane was chosen once for the whole cloud
from its overall bounding box, so in a scene mixing orientations the minority
surface was binned edge-on. Measured on a 100 m x 100 m ground plane with a
40 m x 20 m facade standing on it (200,000 points), each facade point's size
divided by the size the same grid gives the facade alone, keyed across its own
face with the same cell and reference density:

| Facade share | Noise | Whole-cloud plane: median, p90 | Per-voxel plane: median, p90, min |
| --- | --- | --- | --- |
| 5% | 0 and 5 cm | 0.40, 0.43 | 1.00, 1.00, 0.38 |
| 20% | 0 and 5 cm | 0.79, 0.83 | 1.00, 1.00, 0.41 |
| 50% | 0 and 5 cm | 1.00, 1.00 | 1.00, 1.00, 0.51 |

The 50% row reads 1.00 under the whole-cloud plane only because both sides sit
on the 0.5 floor. With `localPlanes`, which `autoDensitySizeParams` turns on,
each cubic voxel of the cell size is classed by the axis its points spread least
along, and its points are counted across the other two. A voxel with fewer than
6 points, or no axis at most half as wide as the next, keeps the whole-cloud
plane, so a single-orientation cloud bins as before and the flat and upright
cases stay identical. The remaining low ratios are points in voxels straddling
the seam between ground and facade. Cell keys became numbers rather than
strings, so on a 1,000,000-point ground and facade scene the pass takes 150 to
160 ms against 210 to 225 ms for the previous code. A test pins the median and
p90 within 1% of the facade-alone size for all six mixes.

The value is a display attribute throughout. It reaches an instanced `aSize`
attribute and the size graph, nothing else: no export, no report, no claim in
the register. A lint already holds `aSize` inside render code.

### L26 · PARTIAL · SCIENTIFIC

Classification flags now survive a worker-decoded load. They were filled by the
decoder, carried by `PointCloud` and read by the LAS writer, but omitted from
the worker payload, so they arrived only on a direct parse and were absent on
the path the application uses. Applying the Withheld policy would have been
inert for a normally-opened scan.

`tests/workerPayloadParity.test.ts` derives the expectation from
`PointCloudOptions` rather than naming the field, so an attribute added there
and forgotten in the payload fails at the boundary instead of years later.

The policy still has no caller. What changed is that it now has something to
read. Voxel downsampling still drops the flags (L28), which continues to bound
what applying it can mean.

### L11 · OPEN · UI

The overlap is real over a band from 768 px to about 891 px. The left
rail is `clamp(285px, 21vw, 312px)`, the right `clamp(288px, 23vw, 340px)`, and
the project card is 290 px wide and centred. The free band between the rails is
`W − 14 − 288 − 299`, which reaches the card's width at about 891 px. Measured
in Chromium: the card runs 60 px under the left rail and 63 px under the right
at 768, and clears both at 900 and above.

A test covers the case. `tests/e2e/hudCollision.spec.ts`
exempts it: when the band is narrower than the
card it asserts only that the card stays on screen. That exemption is what
would become strict once the layout is fixed.

The CSS-only fix centres the card in the band and caps its width, which leaves
about 155 px at 768. Whether that is readable has not been rendered, so the
layout is unchanged pending that check.

### L13 · OPEN · EVIDENCE

The legs exist and run; none is required. The ruleset for `main` requires
`ci-green` and `CodeQL`, and `ci-green` depends only on Chromium jobs. The full
suites on Firefox and WebKit (`browsers.yml`) carry `continue-on-error: true`.
The smoke workflow is titled "blocking", yet the ruleset does not list it as a
required check. Windows
runs Chromium only.

On the latest main run the Firefox, WebKit and iPhone-shaped WebKit legs pass,
including the touch gestures. Each has passed once, which says nothing yet about
flake rate, and the iOS simulator leg has not passed at all. Making any of these blocking is a
release-policy decision and is not made here.

### L28 · PARTIAL · SEMANTICS

Voxel downsampling leaves classification flags undefined on the points it
produces, and that is the chosen semantics rather than an omission. Each output
point sits at the centroid of its voxel's members, so it is not a source point:
a voxel mixing a Withheld return with an ordinary one has no single true
Withheld state, and giving the centroid its first member's flags would assert
one. The other per-record attributes keep first-member values by an older
contract that this does not extend.

The source-faithful export re-decodes the original file, so flags reach an
exported LAS intact. A reduced-view export writes the downsampled cloud, and
LAS has no value for an unknown flag, so its flag byte reads as zero. That
export is labelled as a reduced view.

The consequence for L26 is that a Withheld filter cannot act on a cloud already
reduced at load. The filter has to run before the reduction, which is where it
is placed when it is applied.

### L13 · OPEN · EVIDENCE
No browser leg becomes a required check yet. Each has one green run on main,
and the WebKit legs then failed on a test that read the camera before the
load flight ended, which is a test defect and not a product one. A required
leg that goes red on timing blocks merges without finding bugs.
The bar for `webkit-smoke` is twenty consecutive green runs on main. The
Firefox and WebKit suites in `browsers.yml` follow on the same bar. The iOS
simulator leg stays advisory until it has passed once end to end.
The smoke workflow was titled "blocking" while no ruleset required it. Its
title and header state that it is advisory.

### L11 · FIXED · UI
The "Project ready" card is centred in the band between the rails and
narrows to it, with a 200 px floor. Below 200 px the Size and Attributes rows
wrap to four lines; at 200 px they wrap to two. Measured in Chromium at a
height of 900 with `multichunk.laz`:

| width | card | clears the rails | longest row |
|---|---|---|---|
| 768 | 200 px | no, 16 to 17 px under each (was 60 to 63) | 2 lines |
| 800 | 200 px | touches by 1 px | 2 lines |
| 820 | 203 px | yes | 2 lines |
| 891 | 274 px | yes | 1 line |
| 1024 and up | 290 px | yes | 1 line |

From 768 to about 800 px no readable width clears both rails, and the card
lives seven seconds with a dismiss button, so the remaining overlap there is
accepted. `hudCollision.spec.ts` asserts the card clears the rails wherever
it fits in the band, and passes at every configured width. On phones the
card keeps its viewport-centred placement.

### L26 · PARTIAL · SCIENTIFIC
The Withheld policy runs inside the terrain gather, so the DTM, and the
floor-plan and routing paths that read the same gather, leave out points
flagged Withheld. A Withheld point still advances the stride counter, so
the sampled candidates are the same with the policy on or off. The DTM
records the outcome: excluded, not recorded when a contributing cloud has no
flags channel, or kept when the caller opts out.
The policy reaches clouds that keep their flags: static clouds within the
4M point budget, and streamed COPC or EPT data where every resident node
carries the channel. A larger static file is voxel-downsampled at load, the
flags do not survive the reduction (L28), and its DTM records the outcome as
not recorded. Two local USGS tiles carry Withheld points, all class 1; a
whole-file decode shows them moving measured DTM cells by about 3 percent,
and no recorded number changes.
Extending the policy to those files by dropping Withheld points before the
reduction would also remove them from the displayed cloud, which the policy
does not ask for. The route that would not is a Withheld-aware terrain gather
over the full-resolution source. It waits on a dataset whose Withheld points
are ground-class, or a DTM difference large enough to matter.

### L14 · PARTIAL · ARCHITECTURE

`viewerRenderBootstrap.ts` now sets `renderer.highPrecision = true` on the
render core three's WebGPURenderer builds for both backends. The flag forms
each object's model-view matrix on the CPU in float64
(`camera.matrixWorldInverse.multiplyMatrices(object.matrixWorld)`, three's
`ModelNode.js`) and uploads the float32 rounding of that product as one
uniform, in place of multiplying the camera's view matrix by the object's
world matrix in the vertex shader after both were separately rounded to
float32. Every material in this tree reaches view space through three's
`modelViewMatrix` accessor: `PointsNodeMaterial` (`Viewer.ts:1570`,
`buildPointMesh`) and `LineBasicNodeMaterial` (`ContourOverlay.ts`) both
resolve it through their inherited `setupPositionView`, and
`densityPointSize.ts`'s `positionView` node, the eye-distance term behind
adaptive point sizing, resolves through the same accessor by way of
`PointsNodeMaterial.setupPositionView`. No custom node in `src/render`
multiplies `cameraViewMatrix` directly or reads a view-space position any
other way, so none needed a change.

Measured with `gate2-origin-a.las` and `gate2-origin-b.las`, the second layer
placed at increasing offsets, the worst displacement over 12 camera poses
between the uploaded matrix and the float64-exact product:

| offset | before (GPU path, float32 in shader) | after (CPU path, highPrecision) |
|---|---|---|
| 0 | 4.0e-6 m | 4.0e-6 m |
| 16.4 km | 7.56e-4 m (0.76 mm) | 4.0e-6 m |
| 20 km | 1.21e-3 m (1.2 mm) | 4.0e-6 m |
| 100 km | 5.19e-3 m (5.2 mm) | 4.0e-6 m |
| 1000 km | 6.47e-2 m (65 mm) | 4.0e-6 m |

The before column grows with offset; the after column does not move outside
its own float32 rounding noise, on Chromium (WebGL2), Firefox (WebGL2) and
WebKit (WebGPU) alike, to six significant figures. A single unplaced layer
renders identically before and after: the readback pixel hash and lit-pixel
count match exactly on Chromium and Firefox, and WebKit's own residual figure
matches to the last digit with identical dimensions and pixel ratio. On
WebKit and Firefox the far layer's screen centroid is pixel-identical to the
unplaced case at every offset up to 1000 km after the fix; before it, the
centroid shifts by a growing amount as distance grows (Firefox: 0.12 px at
20 km, 0.29 px at 100 km, 2.51 px at 1000 km). `tests/viewerRenderBootstrap.test.ts`
holds the flag on, re-derives the worst-case displacement from the same
matrix math with no browser, and pins the browser-measured numbers above as a
permanent regression fixture; flipping the flag off fails five of its six
assertions.

Frame time, a 1,000,000-point cloud, median of repeated frames after warmup,
one browser process per condition (two conditions sharing a process bias the
second one slower, the effect the L118 entry recorded):

| engine, backend | single mesh, before to after | split into 400 meshes, before to after |
|---|---|---|
| Chromium, WebGL2 software (SwiftShader) | 14.24 s to 14.01 s | 18.85 s to 19.00 s |
| WebKit, WebGPU (Apple GPU) | 70.8 ms to 67.2 ms | 63.4 ms to 67.9 ms |
| Firefox, WebGL2 (Apple M1) | 76.6 ms to 73.6 ms | 60.7 ms to 60.8 ms |

Every wall-clock figure above stays within 8% of its pair except the WebKit
split case, which reads 7.1% slower after; the same comparison run inside a
shared process, where the earlier column always runs first, swung from 30%
faster to 106% slower on repeated trials of the identical condition, so a
single isolated sample at this magnitude is not distinguishable from that
noise floor. The mechanism's own cost, read directly rather than through the
wall clock, is the per-object CPU matrix multiply: 0.1 to 0.3 ms for the
single mesh and 2.0 to 2.9 ms for the 400-mesh split, unchanged between
before and after in every trial on every engine. Chromium's software
rasterizer runs three orders of magnitude slower than the other two and is
not representative of real hardware; kept for completeness.

The `mountPrecision` gate below is unchanged: `REBASE_QUANTUM_BUDGET_M` stays
0.001 and the function's logic was not touched, only its docblock. This
closes the display half of the question that docblock raised. The analysis
paths that fold a placement into a Float32 buffer, and the terrain gather,
still spend the budget the gate protects, and relaxing the 1 mm refusal needs
both of those fixed first, on separate branches.

### L147 · MEASURED · PERFORMANCE

Flow Pulse Lab (`flowPulseLab.ts`) calls `runFlowPulse` synchronously on the UI
thread, and `FLOW_PULSE_DEFAULTS.maxCells` admits a grid up to 4,000,000 cells.
Whether that call belongs on the main thread or in a worker was a question for
measurement, not judgment, so `tests/benchmark/flowPulseLabProfile.test.ts`
(gated behind `FLOW_PULSE_LAB_BENCH=1`) drives the same functions
`runFlowPulse` calls, in the same order, over synthetic DTMs, and times each
stage on its own. Node, median of 5 runs with one warmup discarded per row:

| cells | conditioning | digest | grid | priority-flood | D8 | accumulation | seal | total ms |
|---|---|---|---|---|---|---|---|---|
| 65,536 | raw | 5.4 | 0.3 | n/a | 14.9 | 2.0 | 5.9 | 28.5 |
| 65,536 | priority-flood | 5.3 | 0.3 | 17.7 | 14.9 | 1.9 | 5.3 | 45.5 |
| 250,000 | raw | 26.5 | 1.1 | n/a | 72.4 | 11.8 | 26.0 | 138.9 |
| 250,000 | priority-flood | 8.1 | 5.0 | 118.9 | 70.6 | 10.7 | 9.1 | 214.1 |
| 1,000,000 | raw | 26.6 | 2.7 | n/a | 223.4 | 35.7 | 25.7 | 313.7 |
| 1,000,000 | priority-flood | 26.7 | 2.7 | 356.3 | 226.7 | 36.4 | 24.7 | 678.1 |
| 1,999,396 | raw | 50.9 | 5.9 | n/a | 445.8 | 90.9 | 53.2 | 643.7 |
| 1,999,396 | priority-flood | 47.3 | 6.8 | 696.8 | 424.7 | 81.9 | 48.4 | 1,307.1 |
| 4,000,000 | raw | 110.1 | 12.3 | n/a | 925.3 | 166.6 | 96.5 | 1,315.8 |
| 4,000,000 | priority-flood | 103.9 | 11.9 | 1,568.4 | 915.4 | 187.3 | 106.3 | 2,896.6 |

These are Node numbers, and a floor rather than the browser figure: a real main
thread shares time with layout and paint work, and with handling input, none
of which a Node process carries, so a browser run is typically slower for the
same JavaScript.

The question that decides the outcome is which row the Lab can reach.
`deriveCoreParams` in `terrainAnalysisRunner.ts` aims every analysis grid at
256 cells across its longer axis (`cellSizeM = Math.max(0.25 / metresPerUnit,
extent / 256)`), so the largest DTM the app produces is about 256 by 256, or
65,536 cells. The Lab has exactly one caller, the `analyse.flowPulse` action in
`analysisActions.ts`, which reads `panel.flowInput` from that same capped
analysis result; no other module opens it. `FLOW_PULSE_DEFAULTS.conditioning`
is `'raw'` and the Lab exposes no control to change it, so the run a user
actually triggers is the 65,536-cell raw row: 28.5 ms median, on a runtime
already slower than the one it stands in for.

The 4,000,000-cell ceiling would cost close to 3 seconds under priority-flood
conditioning (2,896.6 ms measured), long enough to freeze a real UI thread. But
nothing in the app can hand the Lab a grid near that size: the only grid it
ever sees is the analysis panel's own capped DTM, and `runFlowPulse` already
refuses anything past `maxCells` with a named `TOO_LARGE` reason rather than
running it. The ceiling is a defensive refusal bound, not a workload the Lab
can reach, so the worker migration this investigation was scoped to justify is
not built. The call stays synchronous. `build: buildIdentityProvenance()`
replaced the bare `__APP_VERSION__` on the sealed run record in the same file,
so a record names the exact build that produced it; `flowPulseLab.test.ts`
checks the record's `build` field against `buildIdentityProvenance()`.

### L13 · OPEN · EVIDENCE

The iOS simulator leg (`.github/workflows/ios-simulator.yml`) verifies a real
XCUITest session through to an OS-dispatched gesture: it opens the app in
Mobile Safari inside the simulator and navigates to the test seam. There it
loads a scan, reads the camera pose and dispatches a two-finger pinch. All of that passes.
What it cannot verify on a GitHub-hosted macOS runner is the render the pinch
is meant to resume: the WebGL frame never completes.

The evidence is in run 35787354722. The host's SimMetalHost log records
`-[AppleParavirtArgumentEncoder setBuffer:offset:atIndex:], line 392: error`,
then a run of process crashes, `Corpse allowed 1 of 5` through
`Too many corpses being created`. WebKit's GPU process exits,
`GPUProcessProxy::gpuProcessExited: reason=Crash`, MobileSafari loses its
Metal connection, `Connection to SimMetalHost ... XPC_ERROR_CONNECTION_INTERRUPTED`,
and the run ends with metal(21) code 102. The failure sits in the runner VM's
paravirtual GPU driver while it renders WebGL. It is not in the app, the test
script, or the gesture: the pinch only asks the page to resume rendering, and
rendering is the step the driver cannot complete.

No script or workflow change avoids this short of turning off WebGL rendering
for the run, and that would stop the leg from testing the app at all. What
unblocks it is a runner with a real Apple GPU: a self-hosted Apple Silicon
runner, or a future GitHub-hosted image whose paravirtual driver handles this
rendering path. Until one exists, the leg stops at the same point and stays
advisory.

### L01 · FIXED · EXPORT

A LAS 1.2 write whose classes go above 31 is refused by default rather than
warned about and written. `convertCloud.ts` counts the wrapping points and
codes and, without `allowLegacyClassWrap`, returns a null file and an error
naming both counts, the codes, and the two ways forward: LAS 1.4, which keeps
the full byte, or the opt-in, which writes each class as its low 5 bits with a
warning. `convert/legacyClassGuard.ts` holds the refusal and warning text so
the write gate, the batch runner, and the Export panel's live preview all say
the same thing, and `lasSemantics.ts` states which of the two legacy losses
refuses and which only warns: a wrapped class refuses, because the file reads
back as another valid class with no error; a dropped overlap flag warns,
because the base class written beside it stays correct. `writeLas.ts` keeps
masking as its only job. Covered by `tests/las12ClassWrapRefusal.test.ts`,
`tests/exportPanelLegacyClassWrap.test.ts`, and the LAS 1.2 case in
`tests/e2e/batchConverter.spec.ts`.

### L125 · FIXED · ARCHITECTURE

Every Viewer mutation that changes what is drawn records a `once` reason, and
`input()` is left to the gesture listeners.

`input()` records `camera-input`, a holdover reason, and extends the 350 ms
activity window. A frame the browser runs after that window finds nothing
asking and skips the paint, and nothing raises the change again because it
has already happened. The class and elevation filters owned reasons, as did
the coverage grid and the clip. Eleven other sites used `input()`: the colour
mode, intensity filter and derived classification setters, four streaming
controls (colour, quality, resume, cache), the public `requestFrame`, the
resize handler, the canvas restore after an export render, and the backend
coming up.

Each site was classified by what it changes and who calls it:

| site | what changes | reason |
|---|---|---|
| `setColorMode`, `setStreamingColorMode` | colours | `style` |
| `setIntensityFilter`, `applyDerivedClassification` | which points show | `filter` |
| `setStreamingQuality`, `resumeStreaming` | what the next tick keeps resident | `streaming-schedule` |
| `requestFrame` | overlays, preview layers, projection, placement, quality, fade starts | `redraw-request` |
| `_onResize`, export restore, backend ready | the drawing surface | `viewport` |
| `clearStreamingCache` | compressed bytes only, nothing drawn | none |
| pointer move, pointer down, key, tab visible | input | `input()` |

`streaming-schedule` and `redraw-request` are new `once` reasons. The
scheduler ticks from the loop body, so a budget change or a resume acts only
once a frame runs. Every caller of `requestFrame` changes something the
Viewer cannot name, so its reason says only that a paint was asked for.

Escape leaves a tool through `_setToolMode`, which clears the measurement
draft and cursor that the overlay shows until a frame repaints. The key stays
input and the tool switch records `tool-overlay`, which also covers the public
tool toggles that pass through it.

`tests/invalidationDrawsFrame.test.ts` reads each converted site's demand
calls out of `Viewer.ts` and replays them against the real scheduler with the
frame run 50 ms after the holdover expires. The ten that used `input()` fail
with it and paint with their reason, and `_setToolMode` is replayed the same
way. `tests/visualMutationOwnership.test.ts` accepts only a
`once` reason as an owner, fails any public method that calls `input()`, and
counts every `input()` in the file against the four gesture listeners.
Reverting `setColorMode` to `input()` turns four cases red across the two
files.

One gap remains. A pointer move in the measure or probe tool picks inside the
frame and repaints the overlay only on a drawn frame, so a hover whose frame
arrives after the holdover shows its cursor at the next heartbeat. Lasso
reclassify and classification undo and redo rewrite classification colours
without recording any reason of their own.

### L125 · FIXED · ARCHITECTURE

The two gaps the prior account left open are closed.

`reclassifyLasso`, `undoClassification` and `redoClassification` rewrite the
classification buffer and reupload its colours through
`refreshClassificationColours`, and none of the three recorded a reason for
it. The recolour is pulled out of `Viewer.ts` into `colorModes.ts`, which
`Viewer.ts` already imports for `colorForMode`, as a plain function over the
three fields it reads (`cloud`, `colorAttr` and `mode`) rather than a private
method keyed by cloud id, since a private method cannot leave the class that
owns the id-to-entry map and a new file would raise the fan-out baseline
`lint:module-graph` holds on `Viewer.ts`. Each of the three callers then
records `filter`,
the reason the colour mode and intensity filter setters already own, so a
late frame still shows the recoloured buffer rather than the one before the
edit. `swapClassification` and `reclassifyInPolygon` rewrite the same buffer
through the same helper but have no live caller yet, so they stay outside
this fix and outside the owner inventory in
`tests/visualMutationOwnership.test.ts`.

The measure cursor's host callback, `setMeasureCursor`, records
`tool-overlay` after it sets the cursor. The overlay only re-projects on a
frame that draws, and a hover had no owner of its own: once the pointer
stops moving, nothing asks for a frame again, and the position had already
changed by the time the callback returned. The probe readout is plain DOM
pushed straight from client coordinates rather than a re-projected overlay,
so it carried no matching gap and needed no change.

`tests/invalidationDrawsFrame.test.ts` replays the three classification
callers and the cursor callback the same way it replays every other site in
this entry: each site's demand calls, read out of `Viewer.ts`, against the
real scheduler with the frame run 50 ms after the holdover expires.
`tests/visualMutationOwnership.test.ts` adds `reclassifyLasso`,
`undoClassification` and `redoClassification` to the owner inventory, each
against `filter`.

### L148 · FIXED · SCIENTIFIC

Priority-Flood conditioning and D8 routing disagreed about what NoData means.
D8 treats a cell with no elevation as a wall: flow neither enters nor leaves
it, and only the grid boundary is an outlet. The conditioning seeded its flood
at the grid boundary and also at every valid cell touching NoData, so a survey
hole became a drainage exit. A depression beside a hole stayed unfilled because
it spilled into the hole, and D8 on the conditioned surface, which routes
nothing into the hole, then found a sink on the rim that the conditioning had
counted as resolved.

The flood seeds at the grid boundary only. A region that NoData encloses has no
route to the boundary, so it keeps its heights, is counted as
`cellsUnreachable`, and the run states the count among its limitations. The
other reading, a gap as a drainage exit, is right where gaps are open water. It
is available as `fillNoData: 'outlet'` on the run and `noData` on
`priorityFlood`, and a run that uses it records the parameter, names the method
`olv.simulation.terrain-flow.priority-flood.gap-outlet` and states the reading
among its limitations. The default method moves to version 2, since its figures
change on any grid with an interior gap. The panel routes raw by default, so
what it shows before a user chooses conditioning is unchanged.

`tests/priorityFlood.test.ts` builds a surface falling east with a one-cell
hole beside a two-cell depression. With the wall the depression fills to its
spill level of 7, past the hole, and D8 on the conditioned surface routes every
cell on the rim. Reverting the seeding turns seven tests red, that one among
them: the depression stays at 3 and its lowest cell is a sink. An island inside
a ring of NoData reports 9 unreachable cells. `tests/flowPulseRunner.test.ts`
checks the parameter, the method id, the limitation and a distinct record
digest for each reading.

On the five oracle fixtures nothing changes. Every valid cell there reaches the
boundary, so both readings return the surface the earlier seeding returned, and
the raw D8 records under `validation/field-simulation/expected` are untouched.
On the two new grids, with an epsilon of 0.001:

| grid | reading | raised | max fill | sinks | flats | unreachable |
|---|---|---|---|---|---|---|
| hole beside depression | earlier seeding | 0 | 0 | 1 | 0 | not counted |
| hole beside depression | wall | 2 | 4.001 | 0 | 0 | 0 |
| hole beside depression | outlet | 0 | 0 | 1 | 0 | 0 |
| island in NoData | earlier seeding | 1 | 4.001 | 0 | 8 | not counted |
| island in NoData | wall | 0 | 0 | 1 | 0 | 9 |
| island in NoData | outlet | 1 | 4.001 | 0 | 8 | 0 |

In the island the earlier seeding filled the pit and left the eight cells
around it flat, with no route out. Over 3,000 random grids with 30 to 75
percent NoData, the outlet reading reproduces the earlier seeding bit for bit,
`cellsUnreachable` matches an independent breadth-first search from the
boundary, and the wall leaves no sink or flat on any cell it reached. Every
sink or flat that remains lies inside a counted unreachable region.

### L148 · FIXED · SCIENTIFIC

The entry above claims a run of "over 3,000 random grids" that was never
committed: no property test, fuzz script, or random-grid fixture backed that
sentence anywhere in the repository at the time it was written.

`tests/priorityFloodRandomGrids.test.ts` runs it: 3,000 seeded random grids
per property, each checked against a reimplementation independent of the
code path it verifies. A standalone copy of the earlier seeding stands in
for the outlet reading, a plain queue flood-fill stands in for
`cellsUnreachable`, and D8 restricted to that flood-fill's reachable set
stands in for the sink and flat claim. All three hold. Covered by
`tests/priorityFloodRandomGrids.test.ts`.

### L149 · FIXED · SCIENTIFIC

Flow Pulse's run record hashed the summary of a run, not the field. `result`
held cell counts and a couple of maxima, and two receiver or accumulation
arrays that differ everywhere can share every one of those figures. A square
grid ramping east and the same grid turned to ramp south instead have
identical cells, readable cells, sink count, flat count, outlet count and
maximum upstream count, yet route to opposite edges of the grid. Both sealed
to the same record digest.

`result.fieldDigest` now covers the field itself: a SHA-256 over a documented,
versioned byte encoding (`src/simulation/flowPulse/flowFieldDigest.ts`) of the
receiver array, the direction and status arrays, the upstream count, and the
conditioned elevations when conditioning ran, all row-major, hashed as bytes
rather than JSON of the arrays. The comment that had claimed a digest over
arrays "would change with any reordering of an array that carries the same
field" is replaced. The arrays are fixed row-major and are never reordered,
so that was never the risk; the risk was leaving them out of the digest
altogether.

`tests/flowPulseFieldDigest.test.ts` pins the encoding against an
independently computed SHA-256 for a tiny fixture and checks that two
synthetic fields sharing every summary figure (sink count, flat count,
outlet count, maximum upstream count) still seal to different digests.
`tests/flowPulseRunner.test.ts` reproduces the
defect on a real run: reverting `result.fieldDigest` turns the east/south ramp
test red with an identical record digest for two grids that route to opposite
edges, and reapplying it turns the test green. A raw run and a conditioned run
over the same terrain seal to different digests, and re-running one terrain
reproduces its digest exactly.

At 1,000,000 cells (1000x1000, five runs, median), routing (D8 plus
accumulation) took 229.9 ms and hashing the routed field took 167.9 ms, about
0.7 times the routing cost. `tests/flowPulseFieldDigestPerf.test.ts` records
both.

`FieldSimulationRunRecord` is produced by `runFlowPulse` and read only by
`src/ui/fieldSimulation/flowPulseLab.ts`, which renders the summary in a modal
and never serializes the record; no session save, export or report path in the
repository persists one today. `schemaVersion` stays 1 on that evidence: there
is nothing yet that would read an old record and misread the new
`fieldDigest` field, and the check is worth repeating before any such path
starts writing one.

### L47 · PARTIAL · UI

A follow-up review of the per-voxel local-plane fix measured three gaps against
the whole-cloud-plane baseline and the facade-alone reference.

The orientation limit stands. `localPlanes` only classes a voxel thin within
about 26.6 degrees of an axis (`THIN_RATIO` 0.5, the min/max spread test's
own cutoff); a facade at 27 to 63 degrees keeps the whole-cloud plane exactly
as before this option existed, pinned at 45 degrees (median 0.40). Loosening
that cutoff would let more of a scattered cloud pass the same test by chance,
which is the second gap below, so it stays.

Parallel walls sharing a voxel's 2D cell is fixed. The bin key now also
carries the voxel's rounded position along its own normal, so two walls at
different offsets bin apart instead of merging their point counts: one 5%
wall alone reads median 1.00 of its own size; two read 1.00 against the
previous 0.71; four read 1.00 against 0.51. Rounding rather than flooring
that position matters on its own: at 26 degrees to an axis, a single
non-axis-aligned wall floored into layers as its position along the normal
drifted across a voxel boundary, reading p90 1.47 of its alone size against
1.03 unlayered and identical to the whole-cloud plane at every angle and at
0, 0.25 and 0.5 cell offsets on the wall it was tested against.

The 6-point minimum let scattered, non-planar voxels pass the same spread
test by chance: a uniform 3D voxel of 6 points classes as thin 5.7% of the
time (Monte Carlo), 1.7% at 8 points, 0.5% at 10, 0.2% at 12. Raising
`MIN_VOXEL_POINTS` from 6 to 10 cuts the misclassified share of
`tests/localDensitySize.test.ts`'s ground-plus-30%-vegetation scene (lcg seed
12345, 100,000 points, vegetation at `r() * 8`, ground noise `g() * 0.05`)
from 2.968% to 0.281% of its points, and a uniform random cube (50,000
points on [0, 10]^3, lcg seed 12345) from 2.078% to 0%, with no effect on any
flat or single-orientation scene. The cost lands on the facade-edge minima
the first L47 entry already
flagged: more x-end and top-edge voxels of a 5% facade share now hold fewer
than 10 points and fall back to the ground plane, so that mix's worst 10% of
facade points reads 0.66 of its alone size where it read 0.99 before (min
0.10 against 0.12); the 20% and 50% shares are unaffected (min 0.21 and
0.77/0.51, both unchanged).

The first entry attributed the low minima to the ground/facade seam. Measured
per region, the seam (the facade's own bottom row) is the dominant
contributor by point count in every share and noise combination: 873 seam
points against 81 x-end plus 108 top at a 5% share, 3542 against 9 to 22 at
20%, 149 against 0 or 103 at 50%. The facade's x-end and top-edge voxels,
which see fewer points near their own boundary and fall back to the ground
plane below `MIN_VOXEL_POINTS`, typically produce the single lowest ratio in
a row instead of the seam (the table's 5%, 20% and 50%-with-noise minima all
trace to an x-end voxel), though not always. The 50%-no-noise row's own
minimum, 0.77, traces to the seam.

| Facade share | Noise | p10, min against its alone size |
| --- | --- | --- |
| 5% | 0 and 5 cm | 0.66, 0.10 |
| 20% | 0 and 5 cm | 1.00, 0.21 |
| 50% | 0 and 5 cm | 1.00, 0.77 / 0.51 |

A 1,000,000-point ground-and-facade pass runs 150 to 155 ms median (ten
warmed runs, repeated across separate process invocations), the same band
the first L47 entry measured; neither the layer term nor the higher point
minimum moved it. Also fixed: the module header, which
still described a single whole-cloud grid with no mention of `localPlanes`;
and `binKeys`, which computed voxel normals ahead of the unindexable-extent
early return rather than after it.

### L47 · PARTIAL · UI

The entry above puts the ground/facade seam's share of the 50% facade row at
149 points. Measured the same way as the other two rows (the seam is the
facade's bottom voxel layer, `Math.floor(z / cellSize) === 0`), the count is
8864 for both noise levels, not 149. The corrected row reads 8864 against 0 or
103 at 50%, alongside the unchanged 873 against 189 combined at 5% and 3542
against 9 to 22 at 20%; the seam stays the dominant contributor by point count
in every share, more so than the entry above stated.

The entry above also gives 0.2% as the 12-point Monte Carlo misclassification
rate. The same test (uniform 3D voxel, min/max spread, `THIN_RATIO` 0.5), run
at 15,000,000 trials across three seeds, gives 0.14% to 0.15% at 12 points,
which rounds to 0.1%; the 6-point and 8-point rates still match the entry's
5.7% and 1.7%, and the 10-point rate still matches its 0.5%, so only the
12-point figure was wrong.

That Monte Carlo test measures an idealized uniform voxel, not the scenes
`tests/localDensitySize.test.ts` uses for the 6-to-10 comparison, and a
12-point minimum was never run against those scenes, so nothing backed the
choice of 10 over 12. Run the same way: the ground-plus-30%-vegetation scene's
misclassified share drops from 0.281% at 10 points to 0.151% at 12 (the
uniform cube stays at 0% either way), and the facade-edge cost grows with it.
The 5% facade share's worst 10% of points reads 0.63 of its alone size at 12
points (min 0.09) against 10's 0.66 (min 0.10); the 50% share's unclamped
minimum, unaffected going from 6 to 10, drops from 0.77 to 0.32 with no noise
and from 0.51 to 0.23 at 5 cm noise; the 20% share is unaffected either way
(1.00, min 0.21). Halving an already-small misclassified share does not offset
more than doubling the facade-edge cost at the share most exposed to it, so
`MIN_VOXEL_POINTS` stays at 10.

| Facade share | Noise | p10, min at 10 points | p10, min at 12 points |
| --- | --- | --- | --- |
| 5% | 0 and 5 cm | 0.66, 0.10 | 0.63, 0.09 |
| 20% | 0 and 5 cm | 1.00, 0.21 | 1.00, 0.21 |
| 50% | 0 and 5 cm | 1.00, 0.77 / 0.51 | 1.00, 0.32 / 0.23 |

### L150 · BUILT · SCIENTIFIC

Terrain Flow Pulse is integrated on `integrate/flow-pulse-v070`, merging three
branches.

`fix/sim-phase0-v070` adds `withheldAwareTerrainGather.ts`: a second,
full-resolution re-decode of the source that answers the Withheld question for
a static file the display path voxel-downsampled at load, feeding the terrain
analysis runner's export and report paths. `FlowRunIdentity` and
`SimulationSource` gain `terrainCoreDigest`, a digest of the terrain-core
method that built the DTM, so a sealed run record binds the method as well as
the exact grid it read. Covered by `tests/withheldAwareTerrainGather.test.ts`,
`tests/terrainRunnerWithheldRecovery.test.ts`,
`tests/terrainRunnerExportRecoveryConsistency.test.ts` and
`tests/flowPulseContinuityIsolation.test.ts`.

`feat/flow-outputs-v070` adds the depression inventory
(`depressionInventory.ts`), the TF-1..TF-8 claims and the `TERRAIN-FLOW-PULSE`
and `TERRAIN-FLOW-DEPRESSION-INVENTORY` claim-register entries, and
`src/export/flowPulsePackage.ts`, the ZIP deliverable (rasters, depression
table, sealed run record, reproducible config, processing manifest, README,
artifact passport). Documented in `docs/terrain-flow-pulse.md`. Covered by
`tests/depressionInventory.test.ts` and `tests/flowPulsePackage.test.ts`.

`feat/flow-lab-v070` adds the Lab's conditioning control (raw / Priority-Flood)
and the keyboard- and pointer-accessible 2D result grid standing in for a
click on the live scan, with click-to-pulse and click-to-catchment tracing.
It also adds the log-scaled flow-accumulation overlay (`FlowOverlay.ts`),
drawn on the grid and, where scene membership is supplied, in the 3D scene.
Covered by
`tests/flowClickGuard.test.ts`, `tests/flowGridCursor.test.ts`,
`tests/flowOverlay.test.ts`, `tests/flowOverlayGeometry.test.ts` and
`tests/e2e/flowPulseLab.spec.ts`.

On top of the merge, the Lab gained an Export action
(`buildFlowPulseExport` in `src/ui/fieldSimulation/flowPulseLab.ts`) that
builds the ZIP package from the current, non-stale result, including the
traced path and catchment when present, with loading and error-with-retry
states; it refuses on a stale result before the lazy package-builder chunk
even loads. `runLabFlowPulse`'s identity now populates `terrainCoreDigest`
from the active analysis's live DTM method digest
(`resolveLiveDtmDescriptor`/`dtmMethodDigest` in `src/science/liveDtmDescriptor.ts`),
which is also why that module is no longer registered unreachable: the export
path now reaches it. Covered by `tests/flowPulseLabExport.test.ts` and the
extended `tests/e2e/flowPulseLab.spec.ts`.

### L26 · BUILT · SCIENTIFIC

The Withheld-aware terrain gather (L150 above) closes the gap the earlier L26
entries left open: a static file voxel-downsampled at load, whose reduced
cloud can no longer say "excluded" or "kept", now gets its Withheld answer
from a second, full-resolution re-decode rather than "not recorded". The
canonical gather (`sampleStridedTerrain`) is unchanged and still makes the
exclusion decision; this only supplies it a buffer with flags intact, for the
terrain analysis runner's export and report paths and for Flow Pulse, which
reads the same terrain core. Voxel downsampling at load still drops the flags
for display (L28, unchanged); the re-decode never touches the displayed
cloud. Covered by `tests/withheldAwareTerrainGather.test.ts` and
`tests/terrainRunnerWithheldRecovery.test.ts`.

### L151 · BUILT · SCIENTIFIC

Five defects found by hand against a real USGS 3DEP tile
(`USGS_LPC_NM_WhiteSandsNM_2020_D20_w3597n3635.laz`) on the L150 merge.

The result grid's selected-cell readout (`flowGridCursor.ts`) printed the
grid-local z as "elevation" with no unit. `describeCell` now takes an
`ElevationReference` (a world Z origin plus the resolved vertical unit,
following `demPackage.ts`'s own origin-restore convention) and reports a real
elevation with its unit, or "unknown" when either did not resolve.
`flowElevationReference` in `flowPulseLab.ts` builds it from the analysed
DTM's claimed vertical factor, gated on `verticalScaleResolved`. Covered by
the extended `tests/flowGridCursor.test.ts`.

The conditioning limitation ("N cell(s) were raised, the deepest by
1.240.") had no unit. `modelLimitations` and `runFlowPulse` take the same
resolved vertical-unit label, appending it or failing closed to "in source
units". The export package's README states which unit its own
fill-depth/elevation figures use. Covered by the extended
`tests/flowPulseRunner.test.ts` and `tests/flowPulsePackage.test.ts`.

The exported ASCII rasters (`flowPulsePackage.ts` via `demAsciiGrid.ts`)
always wrote `xllcorner`/`yllcorner 0`, with no CRS sidecar:
`buildFlowPulseExport` never threaded a world origin or CRS through to the
package builder at all. It now carries a `FlowPulseGeoref`
(worldOrigin/crsName/wkt, read off the same `getMapContext()` fields
`demPackage.ts` already uses) and `buildFlowPulsePackage` writes the real
corner and a `.prj` when the CRS resolves. Covered by the extended
`tests/flowPulsePackage.test.ts` and `tests/flowPulseLabExport.test.ts`.

The sealed run record's basis claimed `coverage: 'full'`, `complete: true`
for a DTM built by `gatherWithheldAwareTerrainCore`'s full-resolution
re-decode, while Contour Studio's own coverage check read the identical
gather as a sample, because `rasterizeDtm` always reports `'full'` and
nothing downstream stamped the fact that `sampleStridedTerrain` strided the
re-decoded source down to a point budget. `computeTerrainCore` gained a
`sampled` param, set from `StridedTerrainSample.sampled`, that overrides
`coverageMode` to `'sampled'` the same way `residentOnly` already overrides
it to `'resident-only'`. Covered by the extended
`tests/withheldAwareTerrainGather.test.ts`.

The accumulation overlay (`FlowOverlay.ts`) was disposed unconditionally
when the Lab's modal closed, so a user who turned it on and closed the
modal (which covers the scene) never actually saw it. The overlay (and
the traced path/catchment beside it) now lives in a module-level session
kept across Lab opens, disposed only when the user turns it off or the
terrain/CRS it was built from goes stale; the toggle reads the persisted
state back on reopen. Covered by the extended `tests/e2e/flowPulseLab.spec.ts`.

### L152 · FIXED · ARCHITECTURE

`contourLayerService.ts` owned `clearForScan`/`dispose` for the contour
derived layer, but nothing outside that file ever called them: closing a
scan left its contour `LineSegments` attached and visible over the empty
state, and opening a different scan left the old contours drawn over it with
no "Derived layers" / "Contours in 3D" control to hide them. The service
gained `clearAll()`, a caller-agnostic teardown that drops every contour
record from the shared `DerivedLayerStore` and disposes the drawn overlay
without needing the closing scan's id. `terrainAnalysisRunner.ts`'s
`abortAndClearCache()` now calls it alongside the existing
`invalidateFlowOverlay()` call, on the same event set (scan close, a
different scan loading, a CRS change, a classification edit), and also
clears the Analyse panel's separate "Contours in 3D" toggle row
(`setContourLayerControls(null)`), which tracked the same stale layer through
its own DOM. Covered by the extended `tests/contourLayerService.test.ts` and
`tests/e2e/contourLayerLifetime.spec.ts`.

### L153 · BUILT · SCIENTIFIC

Terrain Access (Field Simulation Lab, §12/§21) is built on
`feat/terrain-access-lab-v070`, on top of the five pure-core commits
cherry-picked from `feat/terrain-access-core-v070` (eligibility, cost, A*,
route diagnostics, run record, an independent Python oracle over TA-1..TA-10).

`terrainAccessGridCursor.ts`, `terrainAccessPreview.ts` (everything a run
needs up to, but not including, the A* search, so start/goal selection can
read a traversability map before two endpoints exist) and
`terrainAccessProfileForm.ts` (the pure parse/validate for the
mobility-profile form: every field blank, degrees converted to tangents
once, no vehicle preset) round out the core. The Lab itself
(`src/ui/fieldSimulation/terrainAccessLab.ts`) mirrors `flowPulseLab.ts`'s
shape: a blank profile form, a traversability-map preview with keyboard- and
pointer-accessible start/goal selection and a why-not inspector, then the
completed run with route diagnostics and export, with a Lab-detected
`STALE_INPUT` refusal at both the selection and the run gate. The 3D
overlay (`TerrainAccessOverlay.ts`, `terrainAccessOverlayGeometry.ts`)
mirrors `FlowOverlay.ts`'s split between pure geometry and three.js binding.
`src/export/terrainAccessPackage.ts` mirrors `flowPulsePackage.ts`: route
GeoJSON, a traversability raster, a diagnostics table, the sealed run
record, a reproducible config, a processing manifest, README and passport.

Wired from the command palette (`analyse.terrainAccess`) next to Flow
Pulse, behind its own lazy chunk (`loadTerrainAccessLab`,
`loadTerrainAccessPackage`); `AnalysePanel.terrainAccessInput()` mirrors
`flowPulseInput()` exactly, reading the same provenance accessor and
staleness check. The `TERRAIN-ACCESS` claim registers at E3 (internal
Python oracle ceiling); the eleven pure-core modules registered unreachable
under §U2 graduate, now that the Lab wiring reaches them. One pre-existing
integration gap in the cherry-picked core was fixed in the process:
`terrainAccessRunner.ts`'s sealed record was missing `terrainCoreDigest` on
`SimulationSource`, added as an optional field on `TerrainAccessRunIdentity`
defaulting to null.

A browser review of Flow Pulse on a real UTM tile found local-frame elevation without a real
CRS/datum. It also found an overlay disposed on modal close. Separately, it
found ungeoreferenced ASC/GeoJSON exports and a basis that can overstate
coverage. Terrain Access shares Flow Pulse's DTM frame, overlay lifecycle,
export pattern and basis source, so it inherits four of the five, disclosed in
`docs/terrain-access.md` and `docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md`
rather than silently shipped, and tracked as shared fixes across both
features rather than solved twice.

Covered by `tests/terrainAccessProfileForm.test.ts`,
`tests/terrainAccessLabExport.test.ts`, `tests/terrainAccessPackage.test.ts`
and `tests/e2e/terrainAccessLab.spec.ts`.

### L154 · BUILT · SCIENTIFIC

The four findings L153 disclosed as inherited from Flow Pulse's L151 fixes
are now fixed, reusing L151's own helpers rather than
duplicating them.

`terrainAccessGridCursor.ts`'s `describeTerrainAccessCell` takes the same
`ElevationReference` (`flowGridCursor.ts`) `flowResultGrid.ts` already uses:
a real elevation with its resolved unit, or an honest "unknown" rather than
the grid-local `z` printed bare. `terrainAccessLab.ts`'s
`terrainAccessElevationReference` builds it from the DTM's claimed vertical
factor, gated on a caller-supplied `verticalScaleResolved`, exactly mirroring
`flowElevationReference`. Every length/slope/step figure was already
guaranteed metric by the runner's own `UNITS_UNRESOLVED` refusal gate, so
only the elevation readout needed this. Covered by the extended
`tests/terrainAccessGridCursor.test.ts`.

The traversability-map/route overlay now persists on the scan after the Lab
modal closes, mirroring `flowPulseLab.ts`'s `persistentFlowOverlay` exactly:
`acquireTerrainAccessOverlay`/`disposePersistentTerrainAccessOverlay` in
`terrainAccessLab.ts`, registered through a new
`registerTerrainAccessOverlayInvalidator`/`invalidateTerrainAccessOverlay`
pair in `lazyChunks.ts` that `terrainAnalysisRunner.ts`'s
`abortAndClearCache()` now calls alongside its existing
`invalidateFlowOverlay()` call; the same events (scan close, a different
scan loading, a CRS change, a classification edit) invalidate both Labs'
persisted overlays. Covered by the extended
`tests/terrainAccessOverlayInvalidation.test.ts`.

`terrainAccessPackage.ts` takes a `wkt` option and writes a `.prj` sidecar
when supplied, mirroring `flowPulsePackage.ts`'s own `.prj` handling exactly;
`terrainAccessLab.ts`'s `buildTerrainAccessExport` now threads a
`TerrainAccessGeoref` (world origin, CRS name, WKT) through to it, which it
never did before; the raster/GeoJSON world-origin offset already existed in
the package builder but nothing supplied one. `AnalysePanel.terrainAccessInput()`
gained the `worldOriginX/Y/Z`/`wkt`/`crsName`/`verticalScaleResolved` fields
`flowPulseInput()` already reads off `getMapContext()`. Covered by the
extended `tests/terrainAccessPackage.test.ts` and
`tests/terrainAccessLabExport.test.ts`, including a far-UTM-origin case.

The run record's basis needed no change: `computeTerrainCore`'s L151 fix
(stamping `coverageMode: 'sampled'` for a strided re-decode) already applies
to every reader of `AnalyseContoursResult.dtm`, Terrain Access included,
because both simulations read the identical analysed surface.

The Playwright happy path in `tests/e2e/terrainAccessLab.spec.ts` never
exercised the preview/selection/run/export surface: its drag-and-drop
fixture (`dropDenseGridPly`, a local/unreferenced PLY) has no CRS, so
`runTerrainAccess` always refused `UNITS_UNRESOLVED` before any of it
rendered, and the spec accepted either outcome. A new georeferenced fixture
(`tests/fixtures/terrain-access-utm.las`, a 30x30/900-point grid with a
GeoKeys VLR for WGS 84 / UTM zone 13N, built with the app's own LAS writer
via `scripts/gen-terrain-access-fixture.ts`) resolves a horizontal scale, so
the spec now drives profile -> preview -> why-not -> start/goal (click and
keyboard) -> run -> route drawn -> overlay toggle -> export, and reads the
exported ZIP's README/raster to confirm the real UTM corner rather than a
local (0, 0) origin, deterministically across all three Playwright projects.

`docs/terrain-access.md` and `docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md`
are updated to state these as fixed rather than inherited/disclosed.

Covered by `tests/terrainAccessGridCursor.test.ts`,
`tests/terrainAccessOverlayInvalidation.test.ts`,
`tests/terrainAccessPackage.test.ts`, `tests/terrainAccessLabExport.test.ts`
and `tests/e2e/terrainAccessLab.spec.ts`.
### L160 · MEASURED · EVIDENCE

Observatory phase O0, opened and closed in one entry. Baseline `affffa41`,
matching both the SPEC's stated archive commit and the tip of this branch, so
no archive comparison was needed. `docs/observatory/SPEC.md` is committed
verbatim from the supplied specification, byte for byte.

Every SPEC §1.1, §1.2 and §1.3 row is checked against the working tree, with source-line evidence for
each. All but two read TRUE. The `measured | preview | withheld` authority
row is PARTIAL: it exists once, as `StockpileAuthority`
(`src/render/measure/stockpilePresenter.ts:172`), scoped to the stockpile
feature, not as a shared type Observatory can import yet. The E57 structured
origin row is PARTIAL: the per-scan pose is decoded and applied to points, but
`E57GridBuilder.frame()` never sets `acquisitionPose` on the resulting
`OrganizedRangeFrame`, unlike PTX and PCD, which both set it.

Three verifications close open questions in SPEC §1.3 and OB-INT-02.
E57 record ranges stay contiguous through sanitation: the merge loop appends
scans in strict order and `sanitizeCloud.ts`'s `compactValidRecords` is a
single ascending pass that only drops, never reorders, so a scan's survivors
stay one contiguous block end to end. The station sidecar in a later phase
can use a `[start, end)` range per station at no per-point memory cost; the
`Uint16` per-record fallback, at roughly 2 bytes per point, is not needed.
Structured E57 never produces `NO_RETURN`: every invalid record reads
`SOURCE_INVALID` (`structuredFrames.ts:159-167`), because the loader treats
`cartesianInvalidState` as a plain nonzero test and does not read the finer
ASTM E2807 codes the format can carry. Organized PCD gives an origin only
when the header's `VIEWPOINT` line is present and fully numeric
(`loadPcd.ts:178-188`); a missing or malformed line leaves it undeclared
rather than defaulted.

OB-INT-08: `tests/frameDemand.test.ts` and `tests/invalidationDrawsFrame.test.ts`
pass, 39 tests across both files. The burst-end case, a final committed node
painted on its own merit rather than waiting for the 250 ms idle heartbeat,
is covered directly by the `'pending GPU commits keep the loop awake'` suite,
which drains a three-entry commit queue well inside the heartbeat window and
asserts the one remaining paint is owed and discharged before the loop is
allowed to sleep. No ledger entry before this one names the finding: grepping
this file for `commitPending`, `commitWork` and `final paint` returns nothing.
The mechanism was built in commit `888724f0` (#1007, "The loop paints what
woke it"), which reached `main` without a ledger entry of its own. This entry
is the first ledger record of that closure. No render-loop change was made in
O0.

`src/observation` is added to `LAYERS` in `scripts/lint-layer-boundaries.mjs`
as a pure layer, one array entry. The directory carries only
`src/observation/README.md`, prose describing the layer's future contents; a
`.ts` placeholder was avoided because an unimported module would need its own
entry in `docs/validation/unreachable-modules.json` for no functional gain.
`lint:layer-boundaries`, `lint:unreachable-modules` and `lint:module-graph`
all pass unchanged in every other respect.

Two findings outside O0's six steps surfaced while verifying SPEC §1 and are
left open rather than fixed here. `lint:doc-narration` fails on
`docs/observatory/SPEC.md:409`, where OB-UI-05's permitted-wording list quotes
a phrase built from "not read" and a clause naming the current session; the
lint matches that clause anywhere in a document, including inside a quoted UI
string, and its own header states it carries no allowlist by design. The SPEC
is not edited to route around it; the red
stands and is documented here as an open question. Separately, `docs/validation/claim-register.yaml:1133` states that no
E57 file produces a frame with identity, which `structuredFrames.ts`
contradicts directly: `E57GridBuilder` decodes row and column indices and
produces a frame with real `cellToRecord` identity, exercised by
`tests/e57StructuredRange.test.ts`. The claim-register line predates
structured-E57 grid support; correcting it is left to a session scoped to
claim-register maintenance.

`npm run typecheck` and `test:buckets:verify` pass. The layer and module-graph
lints pass: `lint:layer-boundaries`, `lint:unreachable-modules`,
`lint:module-graph`. The doc lints pass except one: `lint:doc-links`,
`lint:architecture-truth`, `lint:v070-status`, `lint:claims-language` and
`lint:editorial-language` pass; `lint:doc-narration` fails on the one SPEC
line above and on no other file. `gen:v070-status` is regenerated after this
entry.

### L161 · BUILT · SCIENCE

Observatory phase O1 adds the types and the state-table function, extends the
freshness stamp, and ships a fixture generator with oracles for F8 and the state
table.
Baseline `728b3b3a`, one commit ahead of L160's `affffa41` on this branch,
carrying only a SPEC wording fix (OB-UI-05's "not read in this load") the O1
gate run below already reflects.

`src/observation/types.ts` and `src/observation/stateTable.ts` are the
layer's first two modules: `ObservationState`, the per-source and aggregate
counter shapes, the Uint32-word presence bitmask (32 sources per word, tested
past the 32-source boundary for F17), `ObservationOrigin` with the five
statuses SPEC §4 OB-INT-06 and the sibling SensorPrint spec's origin-handoff
vocabulary between them name, and the five declared parameters with units.
`deriveObservationState` (OB-ST-01) is one pure function serving both the
per-source and the aggregate case, a single-source call structurally unable to
reach `CONFLICT` rather than being guarded by a branch. It resolves two gaps
SPEC §2.2-§2.4's prose leaves open: `OUTSIDE_DOMAIN` is evaluated before every
other rule despite being numbered last (the SPEC text says so in the same
sentence it numbers it 9); and `PARTIAL` is the total complement of `SURFACE`
and `OBSERVED_EMPTY`, closing a combination the three literal band
definitions jointly miss (zero hits with a pass count under `n_min`, which
satisfies none of the three as written). Both resolutions, the CONFLICT/
OBSERVED_EMPTY definitional asymmetry the SPEC states directly, and the
preregistered `p_solid` (0.9), `p_empty` (0.1) and `n_min` (5) are recorded in
`validation/protocols/observatory/OB-ST-THRESHOLDS.protocol.json`, written
before any fixture was scored against them (OB-ST-02). `tau_abs` and
`tau_rel` are declared as formulas (half the voxel edge; the half-angle of one
angular step) rather than numbers, since SPEC states they are per-run
derivations and no O1 code path evaluates them yet.

`src/science/analysisFreshness.ts` gains `ObservationFreshnessStamp`
(extending `AnalysisFreshnessStamp`, not duplicating it) and
`observationFreshnessBreach`, adding `sourceDigest`, `basis`, `roiDigest`,
`stationSetDigest`, `parameterDigest`, `methodTags` and `metresPerUnit` and
naming which one moved, in a fixed order, on top of the three facts the
terrain check already names (OB-INT-03, OB-INV-09). No SensorPrint stamp
exists in this tree to reuse instead.

The state table is checked against `validation/observatory/oracle/
state_table.py`, an independent restatement of SPEC §2.2-§2.4 and the
protocol's boundary rules, over a bounded, explicitly enumerated lattice
(`state-table-lattice.json`): 7,504 rows at the preregistered thresholds,
covering all nine states, frozen as fully-explicit input-and-expected records
so the TypeScript test replays recorded inputs rather than re-deriving the
lattice itself. `--check` also asserts OB-INV-02 (no single-source row reads
`CONFLICT`) and OB-INV-01 (`OBSERVED_EMPTY` never carries nonzero aggregate
hit) directly. F8's four DDA cases (axis-aligned, along a face, grazing a
corner, zero-length) are generated by `scripts/generate-observatory-fixtures.
mjs` on exactly representable coordinates and traversed by `validation/
observatory/oracle/ray_aabb_traversal.py` in exact rational arithmetic
(`fractions.Fraction`), against a written tie rule: a coordinate on a voxel
boundary belongs to the voxel on the positive side of it, per axis, applied
simultaneously on however many axes a ray grazes at once. The along-face and
axis-aligned cases resolve to the same four-voxel row, confirming the rule
treats a boundary value the same as a value just past it; the grazing-corner
case advances two axes in one step, adding one voxel per corner rather than
two. The TypeScript DDA itself is O4; this phase's TypeScript test checks
that the fixture generator's inputs and the frozen records agree with each
other, not that a TypeScript traversal agrees with the oracle. `buildF1Scene`
also lands, the wall-and-room geometry for F1, scored from O5 onward. Both
oracles are registered in `validation/external-oracles/oracle-registry.json`
under a new lineage (`olv-observatory-analytic-oracle`), roles
`analytic-truth` and `generator-truth` only, cited by neither an existing
protocol nor a study manifest yet.

`docs/validation/unreachable-modules.json` registers both new `src/
observation/` modules staged, wired starting O3 (rays) and O4/O5 (ledger,
states). `MethodCategory` gains no `'observation'` member: nothing in O1's
types needed it, so the addition SPEC allows conditionally was not made.

One pre-existing red surfaces under a gate O0 did not run:
`lint:method-literals` fails on `docs/observatory/SPEC.md:404` (quoting the
finding, method-literal-ok), OB-UI-03's example voxel-probe panel text naming
a method id that is not registered (OB-INT-04 registers it in O7). The line
was committed verbatim in O0 and is unrelated to any O1 change; it is left as
an open, documented red rather than edited, for the same reason O0 left its
own `lint:doc-narration` finding on the same file unedited.
`docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md`'s module count (896)
is corrected to 898, the true count `lint:module-graph` reports once the two
new files exist, per `lint:architecture-truth`'s own instruction to correct
the doc.

`npm run typecheck`, `test:buckets:verify` (1337/1337, the four new
`tests/observatory*.test.ts` files routed to `unit`), `lint:layer-boundaries`,
`lint:module-graph`, `lint:unreachable-modules`, `lint:oracle-registry`,
`lint:python-version`, `lint:architecture-truth`, `lint:doc-narration` and
`lint:no-host-paths` all pass. `lint:method-literals` fails on the one
inherited line above and on no other. `gen:v070-status` is regenerated after
this entry.

### L162 · BUILT · SCIENCE

Observatory phase O2, opened and closed in one entry: the `AcquisitionStations`
sidecar (OB-INT-02, approved under decision rule D1 as amended by its
Amendment 2, which lets a declared single station carry a one-entry sidecar)
and the early
registration of all seven Observatory method ids (OB-INT-04, maintainer
approval). Baseline `62c7a835`, one commit ahead of L161's `728b3b3a`.

`src/model/AcquisitionStations.ts` defines the sidecar type: an id, a declared
Float64 pose, a source tag (`e57-scan`, `ptx-block` or `pcd-viewpoint`), a
`[start, end)` record range and `originStatus: 'DECLARED'`, following SPEC's
own instruction to take `OrganizedRange`'s PATTERN rather than its literal
"on `CloudMetadata`" wording: `PointCloudOptions.acquisitionStations` is a
dedicated field, sibling to `organizedRange`, because both `voxelDownsample`
and `clipCloud` forward `metadata` wholesale, and a record range living inside
that bag would arrive at a reindexed cloud still claiming its old range with
nothing to notice. `src/io/acquisitionStationsRemap.ts` carries ranges through
sanitation's compaction by prefix-counting survivors once, so every station's
boundary becomes an O(1) lookup; a station whose records all drop keeps an
empty range rather than being removed, and a witness that cannot answer for a
station's boundary drops the whole sidecar (there is no partial degrade for a
station the way `unavailable` linkage serves the grid).

`loadPtx.ts` records one station per block, before the block's declared grid
is checked against the file, so a contradicted grid is not a reason to lose a
pose or a range OB-INT-02 tracks independently of grid topology. `loadE57.ts`
records one station per merged scan, structured and unstructured alike; a
scan with no `<pose>` element is recorded as the file's own declared identity
placement (`localPositionSource: 'not-applicable'`), never inferred, and
distinct from an explicit identity pose because `rotation` stays absent rather
than filled with an identity quaternion. `loadPcd.ts` records one station for
the whole file, only when the header declares a `VIEWPOINT`, reading the pose
straight off the already-built organized-grid frame so the two can never
disagree; its final range uses `count - clean.excludedCount` rather than a
second `.positions` read, keeping `lint:position-access` at its recorded
baseline. `voxelDownsample.ts` and `clipCloud.ts` both drop the sidecar
explicitly and say why in a comment: a voxel merges records from any station
that touches its cell, and a clip's kept-index list can remove points from the
middle of a station's range, so neither output subset is the contiguous block
a station's range describes. The sidecar crosses the parse-worker boundary as
plain data (`parseWorker.ts`'s payload, `loadFile.ts`'s `CloudPayload`),
structurally cloned rather than transferred, since it holds no `ArrayBuffer`
of its own.

Memory: the sidecar's cost scales with station count, not point count. One
station serialises to roughly 150 to 250 bytes (a Float64 pose is the largest
part, 24 to 56 bytes of numbers, plus three short string fields). A
1,000,000-point multi-scan cloud from a realistic 10 stations costs on the
order of 2 KB; a 50,000,000-point cloud from up to 200 PTX blocks or E57 scans
costs on the order of 40 KB. The rejected `Uint16`-per-record fallback O0
costed at 2 bytes per point would have cost 2 MB and 100 MB at the same two
sizes; the `[start, end)` range this phase ships costs neither, at any point
count, because O0 (§2.1) already proved the ranges stay contiguous through
sanitation.

Method registry: `MethodCategory` gains `'observation'`. `methodRegistry.ts`
registers `olv.observation.rays`, `.ledger`, `.states`, `.strength`,
`.shadow-frontier`, `.coverage-gain` and `.station-suggestion` at version 1,
to reserve the seven ids before most of their
code exists. Six of the seven summaries say plainly "not implemented in v0.7"
and name the phase that will build them (O3 for rays, O4 for the ledger, O5
for shadow frontier, O6 for strength, O10 for Coverage Gain and station
suggestion); `olv.observation.states` names the true, partial status instead,
since `deriveObservationState` is real, tested code from O1 that is simply not
yet reachable from a live ledger. Each of the six not-yet-built methods gets a
small `src/observation/*.ts` module holding only the type-level contract SPEC
already fixes for it (ray storage, ledger row and budget-estimate shapes,
strength components, the frontier result, the Coverage Gain instrument model
and term shapes, and the `ReachabilityProvider` interface SPEC itself says has
no v0.7 implementation) so `methodRegistry.test.ts`'s pre-existing invariant,
that every entry's `implementation` path exists in the tree, holds without any
entry claiming code that is not there. All six are registered `staged` in
`docs/validation/unreachable-modules.json`, since nothing yet imports them.
`docs/observatory/methods.md` is new: one section per id, each carrying a
`**Phase:**` line, checked by the new OB-INT-04 test
(`tests/observatoryMethodDocs.test.ts`) that every registered `observation`
id has a section and that a "not implemented" summary and its section agree.
`docs/science/METHOD_REGISTRY.md` gains a matching table under an "Observatory
(reserved v0.7)" heading, for the pre-existing doc-registry parity test.
Registering the ids resolves the `lint:method-literals` red L161 left open on
`docs/observatory/SPEC.md:404` (OB-UI-03's example line, quoting
`olv.observation.states@1`): the id now exists at the version quoted.

Two documents needed a factual correction this phase's own additions caused,
per `lint:architecture-truth`. `docs/architecture/architecture-map.md`'s Model row moved from
"~3.4k" to "~3.5k": `AcquisitionStations.ts` pushed `src/model` past the
rounding boundary. `docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md`'s
module count moved from 898 to 906: the sidecar's own two production modules
plus the six staged method-contract stubs.

Tests: `tests/ptxAcquisitionStations.test.ts` (inherited from the session this
phase resumed, verified sound and unmodified) covers multi-block PTX exact
ranges and poses, a sanitation drop inside one station, a block whose declared
grid the records contradict, and a block that contributes no points.
`tests/e57AcquisitionStations.test.ts` is new: two posed scans with exact
ranges and poses, a scan with no pose element declaring identity rather than
an inference, single-scan byte identity against `loadE57Merge.test.ts`'s own
pinned fixture, a sanitation drop inside one station, a station whose records
all drop, and a strided merge (parser mocked, as `loadE57Merge.test.ts`
already does; this checks the merge loop's own station bookkeeping over
unequal per-scan post-stride counts, not the sampling itself, which
`e57StrideDecode.test.ts` covers separately against a real fixture).
`tests/pcdAcquisitionStations.test.ts` is new: organized PCD with and without
a declared viewpoint, an unorganized PCD with a viewpoint (still no station,
since there is no per-scan boundary to name), a sanitation drop, and the
non-station case (`tiny.las`, asserting `acquisitionStations` stays
`undefined` and every other field matches `loadLas.test.ts`'s own pinned
values). `tests/acquisitionStationsRemap.test.ts` (inherited, verified sound)
pins the compaction arithmetic directly. `tests/voxelDownsample.test.ts` and
`tests/clipCloud.test.ts` each gain a case asserting the sidecar is dropped,
not carried stale. `tests/workerPayloadParity.test.ts` gains a section
covering `organizedRange` and `acquisitionStations`, which the file's own
pre-existing checks cannot see (they match only the eight typed-array kinds):
both are declared on `PointCloudOptions`, posted by the worker payload
literal, and declared on `CloudPayload`, and `acquisitionStations` is
confirmed absent from the transfer list. The streaming path
(`src/render/streaming/residentSnapshot.ts`) was checked, not given a test: it
builds every `PointCloud` field by field, never spreads a source cloud's
option bag, and never names `organizedRange` or `acquisitionStations` at all,
so a streamed tile cannot carry either sidecar stale by construction; nothing
there can regress without a future edit that itself would need a spread this
review would flag.

A full, untargeted `npx vitest run` (not one of the phase's named commands,
run anyway to check for a blast radius the targeted selection could miss)
surfaced one real failure outside the targeted files:
`tests/methodSupportingTests.test.ts`'s pre-existing invariant, that every
registered method names a supporting test, had nothing to say about the seven
new `olv.observation.*` ids. `tests/observatoryPlannedContracts.test.ts` is
new to close it: for each of the six not-yet-built methods it exercises the
declared type contract itself rather than an implementation that does not
exist, for example pinning `DEFAULT_GAIN_STATE_WEIGHTS` against SPEC §5.6's
literal numbers, checking `ObservationRayChunk`'s array-length relationship
on a two-ray fixture, and calling a hand-written `ReachabilityProvider` to
confirm the interface is actually usable; `olv.observation.states` is bound
to `tests/observatoryStateTable.test.ts` instead, its real, pre-existing test.

`npm run typecheck`, `test:buckets:verify` (1343/1343), the full `e57|ptx|pcd|
loader|sanitize|worker|payload|organized|station|methodRegistry|observatory`
test selection (760 passed, 13 pre-existing skips, 0 failures),
`tests/methodSupportingTests.test.ts` and
`tests/observatoryPlannedContracts.test.ts` on their own, and a full
`npx vitest run` (17,291 tests, 17,242 passed, 48 pre-existing skips, one
pre-existing todo, 0 failures after the fix above), all pass.
`lint:layer-boundaries`, `lint:module-graph`, `lint:unreachable-modules`,
`lint:method-literals`, `lint:claim-register`, `lint:claims-language`,
`lint:architecture-truth`, `lint:position-access`, `lint:monolith-size` (no
net change: `main.ts` and `Viewer.ts` were not touched) and `lint:no-host-paths`
all pass. `src/observation` still imports no DOM, `three` or `ui/` module, and
no file under it reads a raw `.positions` array. `gen:v070-status` is
regenerated after this entry.

### L163 · BUILT · SCIENCE

Observatory phase O3: the ray builder (OB-RAY-01..05), scored ray-level
against F5, F6, F16. Baseline `e4767c93`, one commit ahead of L162's
`62c7a835`.

`buildGriddedSourceRays` (`src/observation/rays.ts`) walks a gridded frame's
`cellState` row-major. `VALID_RETURN` gives a returned ray whose direction
comes from the setup's fitted angular parameterisation
(`acquisitionCoverage.ts`) and whose range is `geometricRange` where the
format declares one (PTX), or, where it does not (structured E57, organized
PCD), a range derived in Float64 from the record's own position and the
station's origin, the same recipe OB-RAY-02 uses for a posed unstructured
point. `NO_RETURN` gives a returned ray with `NaN` range. `NOT_DECODED` gives
a not-read ray. `SOURCE_INVALID` and `SOURCE_RECORD_MISSING` give no ray,
counted by walking the same cells rather than copied from the frame's whole
`stateCounts`, so a `grid-stride`-subsampled build never counts a skipped
cell either way. A multi-return cell (`frame.returnCellStart` present)
contributes exactly one ray; its range is the first (smallest-`returnIndex`)
declared return, and every return of the cell is appended to a shared
`ObservationReturnTable` the ray's own `returnOffset` indexes into, in the
CSR order `buildCellReturns` already sorts. `buildUnstructuredSourceRays`
gives one ray per record in a station's range, direction
`normalize(hit - origin)` and range `‖hit - origin‖`, both computed in
Float64 by subtracting the station's own local position (itself a single
Float64 subtraction of two world-frame values) from the record's source-local
position, narrowed to Float32 only when written into the chunk; it never
produces a not-read ray. `RaySubsampling`'s `grid-stride` skips a cell before
either ray pool or the exclusion count sees it; `hash-threshold` keeps a
record when a fixed 32-bit finalizer mix of its index falls under the
threshold, which two runs over the same records reproduce byte-identically.
Rays accumulate into `RAY_CHUNK_SIZE`-bounded (65536) typed-array chunks, no
per-ray object.

`ObservationRayChunk`'s four columns are unchanged; the pinned literal in
`tests/observatoryPlannedContracts.test.ts` still passes untouched.
`SourceRayBuild`, `ObservationReturnTable`, `GriddedRayCoverage` and
`GriddedRayPositions` are the phase's new exported shapes, all additive.

Structured E57's own pose gap, confirmed by `grep -n
acquisitionPose src/io/e57/structuredFrames.ts src/io/loadE57.ts` returning
nothing (PTX and PCD both set `OrganizedRangeFrame.acquisitionPose`;
`E57GridBuilder.frame()` never does), is resolved without touching loader
output. `acquisitionCoverage.ts`'s `AcquisitionCoverageOptions` gained one
optional field, `poseForFrame?: (frame) => AcquisitionPose | undefined`;
`fitFrame` reads `frame.acquisitionPose ?? options.poseForFrame?.(frame)`.
Every existing caller, which omits the option, is unaffected:
`tests/acquisitionCoverage.test.ts`'s existing poseless-frame case stays
green unmodified, and two new cases cover the callback resolving a pose and
never being called when the frame already has one. `AcquisitionStations.ts`
gained `stationForRecord`, a linear `[start, end)` containment lookup, rather
than joining a frame's `scan-N` id against a station's `scan-N` id: L162
already established these are two different counters (`frames.length + 1`,
counting only scans that earned a grid, against `scanOrdinal`, counting
every merged scan), which desync as soon as any scan fails structured
eligibility.

F5 (a PTX-shaped grid with declared `0 0 0` sky cells), F6 (a structured-E57-
shaped grid decoded at a stride) and F16 (a structured-E57-shaped canopy with
one to three ordered returns per cell, on dyadic-rational ranges) are new
generator functions in `scripts/generate-observatory-fixtures.mjs`, following
F1/F8's own pattern: a pure function, drift-checked in
`tests/observatoryFixtureF5F6F16.test.ts` against a committed JSON fixture
under `validation/observatory/fixtures/`. Each scene is declarative: grid
dimensions, station origin and fitted-coverage numbers, plus one return model
(a no-return cell list, a stride, or per-cell declared returns); the ray-level assertions
in the same file build the actual `OrganizedRangeFrame` from that scene and
run it through the ray builder. Registering these under
`validation/external-oracles/oracle-registry.json` was considered and
rejected: F1's own generator carries no entry there, and
`validation/observatory/README.md` already states why (no Python oracle
backs it, "generator-truth" is a role the file's other two entries already
use for their own domains). F5/F6/F16 are the same kind of fixture as F1, so
the file is unchanged, matching that precedent rather than the plan's initial
assumption. The ray-kind-per-cell-state mapping under test is a direct,
closed-form transcription of OB-RAY-01's rule table, not a numeric algorithm,
which is why no oracle is owed one.

`docs/validation/unreachable-modules.json`: `rays.ts` and `types.ts` stay
`status: "staged"` (this register tracks production-graph reachability, not
test coverage, the same footing `stateTable.ts` has held since O1). Their
`why` text is updated: it no longer says the ray builder does not exist, and
now says traversal (O4) is what remains before either module is reachable.
`docs/architecture/architecture-map.md`'s Model row moved from "~3.5k" to
"~3.6k": `AcquisitionStations.ts`'s new `stationForRecord` pushed `src/model`
past the rounding boundary, the same drift class L162 corrected for the same
file.

Method registry: `olv.observation.rays`'s summary drops "not implemented"
and states the true, partial status, mirroring `olv.observation.states`'
existing template. `docs/observatory/methods.md`'s `olv.observation.rays`
section gets a matching Status update and a new paragraph on the pose-gap
resolution; this keeps `tests/observatoryMethodDocs.test.ts` passing without
editing that test, since the section no longer matches its "not implemented"
check.

Tests: `tests/observatoryRayBuilder.test.ts` is new (OB-RAY-01 valid-return,
fallback range, missing-range refusal; SOURCE_INVALID/SOURCE_RECORD_MISSING
exclusion; OB-RAY-02 direction/range and the no-not-read-ray guarantee;
OB-RAY-04 chunk bounding; OB-RAY-05 grid-stride and hash-threshold
determinism; a unit-level multi-return/return-table check ahead of F16).
`tests/observatoryFixtureF5F6F16.test.ts` is new (the three drift checks,
plus F5/F6/F16's own ray-level assertions). `tests/acquisitionCoverage.test.ts`
gains the `poseForFrame` fallback and no-callback-regression cases.
`tests/acquisitionStationsRemap.test.ts` gains `stationForRecord` coverage
(containment, a gap, an empty set). `tests/observatoryPlannedContracts.test.ts`
and `tests/methodSupportingTests.test.ts` pass unmodified.

`npm run typecheck`, `test:buckets:verify` (1345/1345, two files added over
L162's 1343), the `observatory*|acquisitionCoverage|acquisitionStationsRemap|
ptxAcquisitionStations|e57AcquisitionStations|pcdAcquisitionStations|
methodSupportingTests` selection (134 passed, 0 failures), and
`tests/observatoryRayBuilder.test.ts` / `tests/observatoryFixtureF5F6F16.test.ts`
on their own (19 passed at the phase's close, 22 with the three cases the
precision pass added), all pass. `lint:layer-boundaries` (`src/observation`
already in `LAYERS`, not `POPULATED_LAYERS`; no change needed there),
`lint:position-access` (171 reads, one fewer than the pre-existing baseline;
a stale allowlist entry the lint reports pre-dates this change and is left
alone), `lint:monolith-size`, `lint:unreachable-modules`,
`lint:method-literals`, `lint:worker-registry`, `lint:disposal-registry`,
`lint:oracle-registry`, `lint:architecture-truth` (after the Model row fix
above), `lint:release-truth`, `lint:module-graph`, `lint:claim-register`,
`lint:doc-links` and `lint:doc-narration` all pass. `gen:v070-status` is
regenerated after this entry.

`buildGriddedSourceRays`'s return table now fills two buffers sized once
from the frame's own CSR endpoint (`returnCellStart`'s last entry, an exact
upper bound on the walk's total returns) and written by index, in place of a
`number[]` pair copied into a `Float32Array`/`Uint16Array` per station. It
was the one structure in the module whose size scaled with return count
rather than ray count, previously neither chunked nor bounded.
`writeDirectionFromAngles` replaces `directionFromAngles`, mutating a
scratch object `RayChunkBuilder.push` now takes as three scalars instead of
returning a fresh array per cell; `buildUnstructuredSourceRays`'s own
per-record division drops the matching array literal. A `VALID_RETURN` cell
whose resolved range is non-positive or non-finite (a degenerate station
pose, or a record position coincident with it) is now excluded rather than
emitted as a ray whose `NaN` range would read as `NO_RETURN`;
`buildUnstructuredSourceRays` already carried this guard on its own hypot,
unchanged here.

`tests/observatoryRayBuilder.test.ts` gains a coincident-position exclusion
case, a multi-return cell excluded on its start entry with the return table
left untouched, and a mixed NO_RETURN/excluded/multi-return walk confirming
the return-table buffers stay correctly indexed. The seven-file selection
above now runs 137 tests (134 plus these three), 0 failures. `npm run
typecheck` and `test:buckets:verify` (1345/1345, unchanged) both pass;
`lint:position-access` (171 reads, unchanged), `lint:layer-boundaries` and
`lint:monolith-size` (`main.ts` and `Viewer.ts` untouched) all pass.

### L164 · BUILT · SCIENCE

Observatory phase O4: the ledger and traversal (OB-LED-01..05), scored
against F8 (the frozen Python DDA oracle) and F9 (chunk order and partition
count), plus a dedicated budget-refusal test. Baseline `a613a25b`, matching
L163's own HEAD; no commit landed between L163 and this phase's own work.

F9's worker-count axis is read as in-process PARTITION count, per the
maintainer's 2026-09-23 chat decision: partitions of the same deterministic
ray-chunk list at a count of 1, 2 or 5, merged by the same order-independent
integer merge, with no Web Worker and no `WORKER_REGISTRY` entry. `methods.md`
records this reading in the `olv.observation.ledger` Determinism paragraph.

`src/observation/ledger.ts` gains `ObservationDomain`, `domainGrid` and
`packVoxelKey` (OB-LED-03): a plain row-major flat index over the domain's
own grid, safe because every voxel `traverseVoxelSteps` ever visits is
clipped inside the domain first, so no key can exceed the domain's own cell
count. `checkVoxelDomainBudget` is a pure function of the domain and voxel
edge alone, checkable before any ray exists, mirroring
`terrain/quality/gridBudget.ts`'s `ready | coarsen | blocked` verdict as a 3D
variant. `clipRayToDomain` (the slab method) and `traverseVoxelSteps` (3D DDA,
Amanatides and Woo 1987) are Float64, and the DDA's tie rule advances every
axis whose distance to its next boundary equals the current step's minimum
simultaneously, matching `validation/observatory/fixtures/f8-dda-cases.json`'s
own `tieRule` field. `accumulateReturnedRay` classifies each traversed
voxel's parametric span against a returned ray's hit window
`[r - tau(r), r + tau(r)]`: `pass` when the span ends at or before the
window opens, `behind` when it starts at or after the window closes, `hit`
when it overlaps the window. A multi-return ray's `hit` fires per voxel
overlapping any individual return's own window; `pass` runs only to the
first return's window start and `behind` only from the last return's window
end, leaving a voxel strictly between two returns' windows both uncounted and
untouched: no row is created for it at all, a deliberate reading of
`ObservationLedgerRow.presence`'s own "touched" definition (hit, pass,
behind, noReturn or notDecoded), which a strictly-between-windows gap voxel
matches none of. A no-return ray increments
`noReturn` for every voxel from the domain clip's entry to its exit, which is
this implementation's reading of SPEC's undeclared "declared maximum range":
no source in O1-O3's types carries a range cap, so the domain bound and that
phrase are read as the same quantity.

`ObservationLedgerRow` is extended, not replaced: O2's `{key, counters}`
stays byte-compatible in meaning, and `presence` (a `SourcePresenceMask`) and
`perSource` (`ObservationLedgerSourceCounters[]`, `SourceObservationRecord`
minus `addressed`, which needs O5's angular-domain test) are new required
fields. `tests/observatoryPlannedContracts.test.ts`'s pinned literal is
updated to the four-field shape; every other pinned literal in that file is
untouched. The internal accumulator (`LedgerBuilder`) is `Map`-keyed, not
the typed-array-column table `voxelDownsample.ts`'s `VoxelAccumulator` uses,
which OB-LED-03 names as the storage style to follow. This is a considered,
documented scope reduction (recorded in `ledger.ts`'s own header and in
`methods.md`): `Map`'s numeric-key iteration is insertion-ordered, so
accumulation stays exactly as deterministic as a typed-array table would be,
and neither F9 nor the budget check depends on the memory layout. What
OB-LED-03's citation actually buys, a fixed-width pre-sized layout, is not
yet built; `checkVoxelDomainBudget`'s `estimatedBytes` is grounded in this
builder's own measured per-voxel cost instead (a direct heap measurement puts
it at roughly 650-990 bytes depending on per-voxel source overlap), and
`DEFAULT_SOFT_MAX_CELLS`/`DEFAULT_HARD_MAX_CELLS` (187,500 / 3,000,000) are
scaled down from the original 4,000,000 / 64,000,000 so the same real-memory
ceiling those constants always intended still holds at the corrected
per-voxel figure. Both facts are stated plainly in the code rather than left
for a reader to discover.

`RayPartitionInput`/`PartialLedger`/`traverseRayChunks`/`mergePartialLedgers`
are the worker-shaped partition contract SPEC's F9 and the partition
rule both name: `traverseRayChunks` traverses one partition's chunks
against a fresh table with no shared mutable state across calls, and
`mergePartialLedgers` folds every partition's rows with a saturating-sum-
and-flag rule per counter, a bitwise OR per presence word, and the same
saturating rule per per-source entry, all three commutative and associative.
It runs once per partition count, including 1
(`mergePartialLedgers([onePartial])` is then a no-op merge), so p=1/2/5
exercise the same merge
code, not three different paths. `RayPartitionChunkEntry` adds one field over
the plan's own sketch, `returnCounts`, a per-ray return count parallel to a
chunk's own columns: `ObservationReturnTable.countByRay` is a running index
across a source's ENTIRE ray-push order, not per chunk, so a ray at a chunk's
own end cannot recover its return count from `countByRay` alone once
partitioning has split its neighbour into a different chunk or partition.
`returnCounts` is computed once, before partitioning, and is itself a plain
typed array, so the contract stays worker-transfer-shaped throughout. This
field is implemented and typechecked but not exercised by a new fixture in
this phase: SPEC's own O4 phase-table row names F8 and F9 plus the budget
refusal only, not F16-level ledger accumulation, and F9's synthetic scene (built from
F1's own wall box, single-return) does not touch it.

`computeFieldDigest` hashes with `canonicalHash` (`src/canonicalHash.ts`)
exclusively, never `render/measure/auditLog.ts`. Two implementation traps in
`canonicalJson`, confirmed by reading its source rather than assumed: it sorts
object keys but not array elements, so `rows` is sorted by `key` ascending
before hashing (different partition/merge orders populate the input array in
different orders even though the per-key VALUES are identical, which is
exactly what F9 stresses); and a `Uint32Array` (`presence`) is
`typeof === 'object'` and not an array, so it would otherwise serialize
through `Object.keys().sort()`, sorting numeric-string indices
lexicographically past nine elements; `Array.from` first avoids this. Each
row's `perSource` is likewise copied and sorted by `sourceIndex` before
hashing. The payload deliberately excludes `p_solid`/`p_empty`/`n_min` (O5's
parameters, not O4's) and carries a per-source `tauAbs`/`tauRel` list rather
than one global pair, since `tau_rel` is fitted per source.

`estimateTraversalBudget` sums `(clip.tExit - clip.tEntry)` over every ray
surviving cheap rejection, divided by the voxel edge (OB-LED-04).
`runObservationLedger` checks the voxel budget first (pure, no ray cost),
then the step budget, returning a typed `'refused'` value with a reason and
suggestions before any table is allocated, never a thrown exception
(OB-INV-08). A `'coarsen'` voxel verdict and an over-estimate step budget
both refuse by default; only an explicit `allowOverBudget: true` proceeds
past either, and a `'blocked'` voxel verdict is never overridable. The
station range-sphere skip (OB-LED-02's second cheap-rejection step) is not
implemented: it is a pure performance optimisation over what is already
implemented (a station whose range sphere misses the domain can only ever
produce an empty clip for each of its own rays, which `clipRayToDomain`
already skips correctly on its own), so its absence changes no test result
and is recorded at the clip site in `ledger.ts` itself, not only here.
OB-LED-02's rejection ratio IS implemented: `traverseRayChunks` returns
`totalRays`/`rejectedRays` on `PartialLedger.telemetry`, `mergeRejection
Telemetry` sums them across partitions, and `runObservationLedger`'s `'ok'`
result carries the ratio as `rejectionRatio`, excluded from `fieldDigest`
since it is telemetry about the run rather than per-voxel evidence.

`bump`, the saturating counter increment shared by every accumulation path,
sets `saturated` only on the branch that refuses an increment (a counter
already at `COUNTER_SATURATION_MAX`), matching `mergeCountersInto`'s
identical boundary and types.ts's own contract: a counter that lands exactly
on the ceiling through a normal, lossless increment is not saturated.

Tests: `tests/observatoryLedgerTraversal.test.ts` is new: `domainGrid`/
`packVoxelKey` unit checks; F8 (four cases, each checked against
`validation/observatory/expected/f8-dda-cases.expected.json`'s own clip
bounds and voxel list, exactly, no tolerance, since every F8 coordinate is a
dyadic rational Float64 represents exactly); F9 (a 24-ray synthetic scene
built from F1's wall box, chunked into five bounded `ObservationRayChunk`s:
chunk-order permutation at a fixed partition count of 2, and partition count
1/2/5 over the same chunk list, both asserting an identical `fieldDigest`,
plus a sanity check that the scene actually produces both a hit and a
no-return voxel so the merge exercises real, distinguishable evidence); and
the budget-refusal suite (`checkVoxelDomainBudget`'s three verdicts,
`runObservationLedger`'s voxel-budget refusal, coarsen-with-override, and
step-budget refusal, and a within-budget run producing rows and a digest).
Three further groups close the gaps a review pass found: a not-read ray
driven through `traverseRayChunks`, asserting all-zero counters against a
set presence bit and `notDecoded`; a three-return ray driven through
`traverseRayChunks` with a populated `returnTable`/`returnCounts`, asserting
hit/pass/behind across the first, a middle and the last return's window and
confirming the two gap voxels between windows get no row; and the
rejection-ratio telemetry, both at the `traverseRayChunks`/`mergeRejection
Telemetry` level and on `runObservationLedger`'s own result; and the exact
`COUNTER_SATURATION_MAX` boundary (65,535 identical rays into one voxel
stays exact and unsaturated, 65,536 refuses the last increment and sets
`saturated`). 27 tests, 0 failures, on the current tree. The existing
15-file `observatory*|
acquisitionCoverage|acquisitionStationsRemap|ptxAcquisitionStations|
e57AcquisitionStations|pcdAcquisitionStations|methodSupportingTests`
selection (L163's 137, now 164 with this phase's new file and
`observatoryPlannedContracts.test.ts`'s updated literal) all pass.
Tests were developed alongside the implementation rather than strictly
test-first in this phase: every new function these tests exercise did not
exist before this phase's own commits, so an import of any of them against
the pre-phase tree fails to resolve, which is this phase's version of "red
for the right reason", but it was not captured as a separate recorded run.

Method registry: `olv.observation.ledger`'s summary drops "not implemented"
and states the true, partial status, in the same template
`olv.observation.rays` and `.states` already use. `docs/observatory/
methods.md`'s `olv.observation.ledger` section gets a matching Status update
and new Assumptions, Parameters, Failure modes and Determinism paragraphs;
`docs/validation/unreachable-modules.json`'s `why` text for `ledger.ts`,
`rays.ts` and `types.ts` is updated to no longer say traversal does not
exist, following L163's own precedent for the same kind of update. All
three stay `status: "staged"`, since nothing in the production graph wires
any of them to a real scan yet (a coordinator, O9).

`npm run typecheck`, `test:buckets:verify` (1346/1346, one file added over
L163's 1345), the 15-file observatory selection above (164 passed, 0
failures), `lint:layer-boundaries`, `lint:position-access` (171 reads,
unchanged), `lint:monolith-size` (`main.ts` and `Viewer.ts` untouched),
`lint:unreachable-modules`, `lint:method-literals`, `lint:worker-registry`,
`lint:disposal-registry`, `lint:oracle-registry`, `lint:architecture-truth`,
`lint:release-truth`, `lint:module-graph`, `lint:claim-register`,
`lint:doc-links` and `lint:doc-narration` all pass; `check-ai-writing.mjs`
against this entry and `methods.md` finds zero em dashes and no regression
on this file's own 21 pre-existing triads. `gen:v070-status` is regenerated
after this entry.

Corrected account (phase O4b): the paragraph above describes O4's `Map`-
keyed `LedgerBuilder` as a deliberate scope reduction against OB-LED-03's own
cited precedent (`voxelDownsample.ts`'s typed-array `VoxelAccumulator`). That
storage choice is now replaced: `LedgerBuilder` is a typed-array
open-addressing table over the packed voxel key, in the same style, linear
probing, capacity doubling that rehashes keys but never renumbers a slot, row
and per-source counters in flat `Uint16Array`/`Uint8Array` columns indexed by
slot (per-source columns by `slot*sourceCount + sourceIndex`). `finish()`
walks slots in first-touched order, the same order the retired `Map`'s
insertion-ordered iteration gave.

`measureLedgerBuilderBytesPerVoxel` sums every column array's own
`byteLength` (exact, no `--expose-gc` needed) at 1.5 million occupied voxels:
roughly 77 bytes/voxel at one source per occupied voxel, 119 at four, an
order of magnitude below the retired builder's measured 650-990 B/voxel.
`DEFAULT_BYTES_PER_VOXEL` is now 160 (headroom over the four-source figure),
and `DEFAULT_SOFT_MAX_CELLS`/`DEFAULT_HARD_MAX_CELLS` are 1,200,000 /
19,200,000, derived from that constant to land on OB-LED-03's own intended
real-memory envelope (183.1 MiB soft, 2.861 GiB hard, the same one the
original 48-byte-assumed 4,000,000 / 64,000,000 pair meant to express).
`methods.md`'s `olv.observation.ledger` section and this module's own header
comment are updated to match; the prior scope-reduction note is removed.

F8/F9 invariants, the saturation-boundary tests and budget-refusal-before-
allocation all hold unchanged: `fieldDigest` values were captured for five
scenarios (the F9 24-ray scene at partition count 1, a two-station overlap
variant, a not-read-ray run, a three-return `returnTable` run, and both
sides of the `COUNTER_SATURATION_MAX` boundary) before this change and
compared byte-for-byte after; all five are identical. `tests/
observatoryLedgerTraversal.test.ts` gains three new `describe` blocks: a
bytes/voxel ceiling test (one-source and four-source cases, plus a direct
comparison against the retired builder's own measured range), and a
large-domain test (80x80x80 = 512,000 cells) showing the retired builder's
own scaled-down defaults would have refused it (`coarsen`) while the
restored, measured-cost defaults accept it (`ready`) and run it to
completion end to end. 33 tests in this file, 0 failures (27 prior plus 6
new, across the two added groups).

`npm run typecheck`, the full `vitest run tests/` suite (17,303 passed, 48
skipped, 1 pre-existing todo, 0 failures), and `lint:layer-boundaries`,
`lint:module-graph`, `lint:unreachable-modules`, `lint:method-literals`,
`lint:oracle-registry` and `lint:doc-narration` all pass.

Second correction (phase O4b, follow-up): the previous correction's
77/119 B/voxel figures were a single sample at 1.5 million occupied voxels,
deep into a capacity-doubling cycle where every column is amortized over a
near-full table. Sweeping `measureLedgerBuilderBytesPerVoxel` across
occupancies straddling several doubling boundaries (1024, 2048, 4096, ...)
shows the true worst case sits right AFTER a doubling, when only
`capacity/2 + 1` of the new, twice-as-large columns are occupied: 110
B/voxel at one source, 170 at four, both roughly double the earlier sample.
Per-source columns also scale linearly with station count, so a fixed
"headroom over four sources" constant undercounts a domain with more.

`ledgerBuilderWorstCaseBytesPerVoxel(sourceCount)` replaces
`DEFAULT_BYTES_PER_VOXEL`: an analytic formula over the column byte widths
and that ~50% just-after-growth load factor (`2 x (17 + 4x presenceWords +
10x sourceCount + 24)`), not a sampled constant. `checkVoxelDomainBudget`
gains an optional `sourceCount` option feeding this formula (defaulting to 1
so the check stays a pure function of `domain`/`voxelEdge` alone when no
station count is available); `runObservationLedger` passes its own
`input.stations.length`. `SOFT_MAX_BUDGET_BYTES`/`HARD_MAX_BUDGET_BYTES`
now fix the same 183 MiB / 2.86 GiB envelope directly in bytes, and the cell
ceiling is derived per call as `envelopeBytes / worstCase(sourceCount)`, so
the byte envelope can never be exceeded at any occupancy or source count:
1,744,449 soft / 27,917,287 hard cells at one source, 1,128,761 / 18,064,127
at four, 468,022 / 7,490,003 at sixteen, 262,862 / 4,206,714 at
thirty-two. `methods.md` gains the formula and this table.

`tests/observatoryLedgerTraversal.test.ts`'s bytes/voxel group is replaced
with a sweep across six occupancies (spanning two doubling boundaries) at
three source counts (1, 4, 16), asserting the measured value never exceeds
the analytic one; the large-domain group gains a case showing the same
80x80x80 domain reads `ready` at one source but `coarsen` at sixteen. 52
tests in this file, 0 failures. `fieldDigest` was re-verified byte-identical
across the same five scenarios before and after this follow-up. `npm run
typecheck`, the full `vitest run tests/` suite (17,322 passed, 48 skipped, 1
pre-existing todo, 0 failures), and `lint:layer-boundaries`,
`lint:module-graph`, `lint:unreachable-modules`, `lint:method-literals`,
`lint:oracle-registry` and `lint:doc-narration` all pass.

### L165 · BUILT · SCIENCE

Observatory phase O5: states and conflict, plus shadow and frontier, wired to a real
ledger (SPEC §5.3-§5.4, F1-F7, F17). Baseline matches L164's own HEAD; no
commit landed between L164 and this phase's own work.

`deriveObservationState` (`stateTable.ts`) was built and exhaustively scored
against a lattice oracle at O1; nothing changes there. This phase's new code
is the layer around it that `ledger.ts`'s own O4 header named as O5's job:
`src/observation/observationField.ts` adds `isVoxelAddressed`, a closed-form
spherical-coordinate test of a voxel centre against a station's declared
azimuth/elevation band and optional `[minRange, maxRange]`, and
`classifyObservationField`, which assembles `deriveObservationState`'s
`SourceObservationRecord[]` input per voxel by combining an
`ObservationLedgerRow`'s per-source counters (when a row exists) with this
addressed test (always), over every cell of the ledger's own domain grid,
including cells no row touched: an untouched but addressed voxel still resolves
through the "addressed, no ray happened to land here" branch `types.ts`
documents, and a voxel no station addresses resolves `UNADDRESSED` by the
residual-default rule O1 already implements. Every voxel this function
classifies lies inside the declared domain by construction, so
`insideDomain` is always `true` and `OUTSIDE_DOMAIN` is never produced here.

`shadowFrontier.ts` gains its first real implementation:
`computeShadowFrontier` walks the 6-neighbourhood of every `SURFACE`/
`OBSERVED_EMPTY` voxel in a classified `stateByKey` map, testing each
in-bounds neighbour against `SHADOWED`/`UNADDRESSED`/`NO_RETURN_PATH` and
keeping the three adjacency counts separate (OB-SH-02), plus
`exposedFaceCount` (a face, not a voxel, per qualifying neighbour) and
`areaSquareMetres = exposedFaceCount * (h * metresPerUnit)^2`, withheld to
`null` when the unit is unknown (OB-INV-10). A neighbour outside the grid's
own bounds is simply absent: no wraparound, no assumed state. `ledger.ts`
gains `unpackVoxelKey`, `packVoxelKey`'s inverse, which the frontier walk
needs to recover a voxel's grid coordinates from its packed key.

Exit evidence: `scripts/generate-observatory-fixtures.mjs` gains
`buildF2Scene` (F1 plus a second station inside the room), `buildF3Scene`
(a conflict box, geometry only) and `buildF7Scene` (a pocket beyond a
declared `maxRange`), each documenting the ray outcome its own declared
geometry implies. `tests/observatoryFixturesO5.test.ts` scores F1 (wall
`SURFACE`, room behind it `SHADOWED`, open space `OBSERVED_EMPTY`, above the
elevation band `UNADDRESSED`, checked both via `isVoxelAddressed` directly
and through `classifyObservationField`), F2 (the aggregate view resolves the
former shadow to `SURFACE`; station 1's own isolated view still shows
`SHADOWED` at the same voxel), F3 (`CONFLICT` with both source indices and
counts recorded), F4 (a hand-built two-source porous voxel, neither source
individually solid or empty, resolves `PARTIAL` not `CONFLICT`), F7 (a
voxel past `maxRange` is not addressed and resolves `UNADDRESSED`, never
`SHADOWED`, since `isShadowedSource` requires `addressed`), and F17 (a NaN
station origin throws; an empty-ROI domain throws via `domainGrid`; a single
source never reaches `CONFLICT`; a source index in the presence mask's
second word, 32, classifies correctly with no crash at the boundary).
F1-F4 and F7 feed `classifyObservationField` with per-voxel counters chosen
to match each fixture's own declared geometry at specific probe points,
rather than driving the full ray-builder-and-DDA pipeline a second time:
that pipeline is O3/O4's own exit evidence (F5, F6, F8, F9, F16), already
scored against a frozen Python oracle. Each probe's hit/pass/behind/range/
elevation arithmetic is derived in a comment beside it, not asserted blind.

The frontier walk itself is scored directly: `validation/observatory/oracle/
shadow_frontier.py`, a second implementation of SPEC §2.4/§5.4's adjacency
rule written from the prose alone, over an explicit 5x3x1 grid
(`shadow-frontier-grid.json`) built to exercise all three adjacency kinds
separately, a voxel touching more than one kind at once, non-adjacent
neighbour states (`PARTIAL`, `CONFLICT`) that must not count, and a
domain-edge voxel that must not wrap. Registered in `oracle-registry.json`
as `olv-observatory-shadow-frontier-py`, sharing the `olv-observatory-
analytic-oracle` lineage group with the state-table and ray-AABB oracles.
`computeShadowFrontier`'s TypeScript result matches the frozen Python
output exactly on the frontier voxel set and every adjacency count; a
second test confirms the area figure is `null` when the unit is unknown and
`exposedFaceCount * h^2` when it is known.

Method registry: `olv.observation.shadow-frontier`'s summary drops "not
implemented" and states its true, partial status (implemented, not yet
reachable from a live scan), matching `olv.observation.states` and
`.ledger`'s own template. `docs/observatory/methods.md` gets matching
updates to both sections' Status, Assumptions, Parameters, Failure modes and
Determinism paragraphs. `docs/validation/unreachable-modules.json` gains an
entry for the new `observationField.ts` and updates the `stateTable.ts` and
`shadowFrontier.ts` entries to say what O5 actually wired, both still
`status: "staged"` since no coordinator (O9) reads a classified field from a
live scene yet.

`npm run typecheck`, the full `vitest run tests/` suite (17,338 passed, 48
skipped, 1 pre-existing todo, 0 failures; 1,347 files, one more than L164's
1,346), `test:buckets:verify` (1347/1347), and `lint:layer-boundaries`,
`lint:module-graph`, `lint:unreachable-modules`, `lint:method-literals`,
`lint:oracle-registry`, `lint:doc-narration`, `lint:claim-register`,
`lint:architecture-truth`, `lint:release-truth`, `lint:doc-links`,
`lint:worker-registry` and `lint:disposal-registry` all pass.
`docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md`'s stated module count
(906) is corrected to 907 to match the new file, which `lint:architecture-
truth` catches on its own. `check-ai-writing.mjs` against this entry finds
zero em dashes and no new triads; `methods.md` is unchanged from its own
4 pre-existing em dashes and 4 pre-existing triads after this phase's edits
(one added triad in a first draft was rewritten out). `gen:v070-status` is
regenerated after this entry.

### L166 · BUILT · SCIENCE

Observatory phase O5 follow-up: F1 and F2, plus F3 and F7, through the real pipeline
(rays + ledger + classifier together), per reviewer request after L165.
Baseline matches L165's own HEAD; no commit landed between L165 and this
follow-up's own work.

L165's own exit evidence fed `classifyObservationField` hand-supplied
per-voxel counters chosen to match each fixture's declared geometry, proving
the CLASSIFIER (O5's own new code) correct given some ledger, but not that
the ray builder (O3) and the ledger/DDA traversal (O4) actually PRODUCE that
ledger from the declared geometry. This follow-up closes that gap:
`tests/observatoryFixturesO5EndToEnd.test.ts` builds a real
`OrganizedRangeFrame` per station, runs it through the real
`buildGriddedSourceRays`, accumulates the result with the real
`runObservationLedger`, and only then classifies it, for F1 (wall `SURFACE`,
room `SHADOWED`, open space `OBSERVED_EMPTY`, above the band `UNADDRESSED`,
all four read off ONE physical ray's own hit/pass/behind windowing, not four
separately declared facts), F2 (a second station's real ray resolves the
aggregate to `SURFACE`; station 1's isolated view still shows `SHADOWED`),
F3 (`CONFLICT` with both source indices, from two real, opposing rays
through the same box voxel) and F7 (see below). Every probe voxel is found
by walking the same direction and range a real ray produced, using
`clipRayToDomain` to get the real wall/box intersection distance rather than
an assumed one.

Running F7 end to end surfaced a genuine discrepancy, not a test-authoring
mistake: SPEC §2.1/§5.2 both say a no-return ray traverses "up to the
declared maximum range", and O5 just introduced `maxRange` as a first-class,
per-station concept (`StationAngularDomain.maxRange`, L165), but O4's own
traversal (`accumulateReturnedRay`) had never consumed one, since `ledger.
ts`'s own header recorded, correctly at the time, that "no source in O1-O3's
types carries a range cap" and read the domain bound as standing in for it.
F7's own declared domain deliberately extends past its station's declared 5m
`maxRange`, so a real no-return ray fired at the pocket's own direction
would, under O4's pre-existing reading, keep accumulating `noReturn`
evidence past `maxRange`, landing on `NO_RETURN_PATH`, not the `UNADDRESSED`
SPEC's own F7 pass condition names. This is a real O4 gap the fixture
exposed, not a wrong expectation: fixed by adding an optional
`RayPartitionChunkEntry.maxRange`, consumed only inside `accumulateReturnedRay`'s
no-return branch, clipping that ray's own traversal to
`min(domain exit, maxRange)` instead of the domain bound. A returned ray
needs no equivalent change: its own finite range already bounds its hit and
behind windows, independent of any station-level cap. The field is optional
and every prior call site omits it, so F8's, F9's and every other O4 test's exact pre-existing domain-bound
reading is unaffected; a dedicated regression group in
`tests/observatoryLedgerTraversal.test.ts` covers the new behaviour
directly: unbounded traversal is unchanged when `maxRange` is omitted,
`maxRange` stops a no-return ray's own touched-voxel set exactly at that
range while still covering everything up to it, a `maxRange` that closes
before the ray even enters the domain yields zero rows without being
misread as a rejected ray, and `maxRange` is per-entry, never global. F7's
own end-to-end test then asserts the corrected behaviour directly: the
pocket voxel gets no row at all, an in-range voxel on the same ray still
gets `noReturn`, and the classifier reads the pocket `UNADDRESSED`, never
`SHADOWED`.

Each end-to-end fixture's own `fieldDigest` is also checked for partition
invariance (F9's own reading, 1/2/5 in-process partitions of the same
deterministic chunk list), on F1's real run: identical across all three
partition counts.

`docs/observatory/methods.md`'s `olv.observation.ledger` section gets a
Status/Phase update and a corrected Assumptions paragraph replacing the
now-superseded "declared maximum range is read as the domain bound" claim
with the actual, narrower one (unchanged unless a caller supplies `maxRange`).

`npm run typecheck`, the full `vitest run tests/` suite (17,351 passed, 48
skipped, 1 pre-existing todo, 0 failures over 1,348 files, one more than
L165's 1,347), `test:buckets:verify` (1348/1348), and `lint:layer-boundaries`,
`lint:module-graph`, `lint:unreachable-modules`, `lint:method-literals`,
`lint:oracle-registry`, `lint:doc-narration`, `lint:claim-register`,
`lint:architecture-truth`, `lint:release-truth`, `lint:doc-links`,
`lint:worker-registry` and `lint:disposal-registry` all pass. `check-ai-
writing.mjs` against this entry and `methods.md` finds no regression against
each file's own pre-existing em-dash and triad counts. `gen:v070-status` is
regenerated after this entry.

### L167 · BUILT · SCIENCE

Observatory phase O6: strength components (SPEC §2.5, §5.5, OB-STR-01/02).
Baseline matches L166's own HEAD; no commit landed between L166 and this
phase's own work.

`src/observation/strength.ts` computes the five §2.5 components for one
`SURFACE` voxel: `sources` and `consistency` read straight off an
`ObservationLedgerRow`'s own counters (`countStrengthSources`,
`computeConsistency`), needing no per-ray geometry. `angularSpread`,
`incidence` and `rangeFit` need per-hitting-ray direction and range, which
the ledger's counters do not retain. `accumulateStrengthHitSamples`
re-walks a chunk's rays with the same clip/DDA/hit-window primitives O4's
`accumulateReturnedRay` uses, rather than re-deriving the hit rule a second
time: `computeHitWindows` and `stepOverlapsAnyWindow` are extracted out of
`ledger.ts`'s own `accumulateReturnedRay` (a behaviour-preserving
extraction: `accumulateReturnedRay` now calls them too, and every
pre-existing O4/O5 ledger test still passes unchanged) so both consumers
share one hit-window rule. `fitNormalFromResidentPoints` fits `incidence`'s
local surface normal via `symEig3` over a voxel's resident points'
mean-centred covariance (the smallest-eigenvalue eigenvector), reimplemented
locally rather than imported from `src/classification/geometryDescriptors.
ts`'s equivalent, keeping `src/observation`'s own dependency surface to
`src/math` alone; it returns `null` (never a fabricated normal) for fewer
than 3 points or a collinear/coincident neighbourhood, detected by checking
the second eigenvalue against the largest, not an absolute threshold.
`rangeFit`'s "declared useful range band" reuses `StationAngularDomain`'s own
pre-existing `minRange`/`maxRange` concept (`observationField.ts`, phase O5)
rather than inventing a new declared parameter. `computeStrengthComposite`
implements OB-STR-02: the weighted mean of the bounded components plus
`saturatedSources`, always returned bundled with its own weights and the raw
components (the falsification checklist's "show a composite without its
weights" is unrepresentable in the return type), and excludes a `NaN`
component (no evidence to form it) from both the weighted sum and the weight
total rather than treating it as zero.

`tests/observatoryStrength.test.ts` has two groups. The component-oracle
group replays `validation/observatory/oracle/strength-lattice.json` (six
hand-picked cases exercising every NaN/degenerate branch: no samples, no
hit/pass evidence, no normal supplied, an out-of-band range) through
`computeStrengthComponents` and compares against `strength.py`'s frozen,
independently-derived expectations (registered as
`olv-observatory-strength-py` in `oracle-registry.json`, role
analytic-truth, lineage `olv-observatory-analytic-oracle`), this phase's
own SPEC §10 exit evidence. The end-to-end group builds F1's wall through
the REAL ray builder (`buildGriddedSourceRays`) and ledger traversal
(`runObservationLedger`), then runs `accumulateStrengthHitSamples` off the
SAME `ObservationRayChunk` the ledger consumed, confirming real hit samples
land at the real wall voxel with the right direction and range, that the
resulting components read as expected for one physical, near-head-on,
single-direction hit (angularSpread ~0, incidence high, rangeFit 1,
consistency matching the voxel's own SURFACE classification), and that
splitting that same chunk into two partitions before accumulating yields
identical components (OB-INV-07's fixed-merge-order reading, since
`mergeStrengthHitSamples` concatenates partitions in the caller's own
order and every reduction in `computeStrengthComponents` walks that merged
array once, in that order).

`docs/observatory/methods.md`'s `olv.observation.strength` section and
`src/science/methodRegistry.ts`'s summary for the same id are updated from
"not implemented" to describe the shipped computation (`tests/
observatoryMethodDocs.test.ts` enforces the two staying in agreement about
which methods run).

`npm run typecheck`, the full `vitest run tests/` suite (17,371 passed, 48
skipped, 1 pre-existing todo, 0 failures over 1,349 files, one more than
L166's 1,348), `test:buckets:verify` (1349/1349), and `lint:layer-boundaries`,
`lint:module-graph`, `lint:unreachable-modules`, `lint:method-literals`,
`lint:oracle-registry`, `lint:doc-narration`, `lint:claim-register`,
`lint:architecture-truth`, `lint:release-truth`, `lint:doc-links`,
`lint:worker-registry` and `lint:disposal-registry` all pass. `gen:v070-status`
is regenerated after this entry.

### L167 · BUILT · SCIENCE

Correction to this phase's own first account, above: reviewer verification of
`f50164fa` (190/190 observatory tests) found that first account's own
"multi-return ray's later returns are not sampled" limitation contradicts
SPEC §2.5 directly, not a scoping choice this phase was free to make.
`angularSpread`, `incidence` and `rangeFit` are defined over "the hitting
rays" and "the hits", and the ledger already counts a hit from ANY return's
own window (`computeHitWindows`, every return in `ranges`, not only the
first). A voxel hit only by a pulse's 2nd (or later) return, ground under
vegetation, got `sources > 0` and `consistency > 0` from the ledger's own
counters while `accumulateStrengthHitSamples` recorded zero samples for it,
so one voxel's own components disagreed with each other about whether it had
evidence at all. This is fixed on this same branch, not carried into a later
phase.

`resolveRayReturnRanges` is extracted out of `traverseRayChunks`'s own
per-ray CSR lookup (`ledger.ts`, the same behaviour-preserving-extraction
pattern this phase already used once for `computeHitWindows`/
`stepOverlapsAnyWindow`), so both the ledger's own hit counting and
`accumulateStrengthHitSamples` resolve one ray's return set (`[NaN]` for a
no-return ray, every `returnTable` entry for a multi-return ray, or the
chunk's single `range[k]` otherwise) through the identical function.
`accumulateStrengthHitSamples` now takes the chunk's own optional
`returnTable`/`returnCounts` (mirroring `RayPartitionChunkEntry`'s own
fields) and records exactly ONE sample per voxel step that overlaps ANY of a
ray's return windows, matching `accumulateReturnedRay`'s own one-hit-per-step
rule: a step overlapping more than one return's window samples the FIRST
(lowest `returnIndex`) overlapping return, the same left-to-right order
`stepOverlapsAnyWindow` itself evaluates in, not an arbitrary pick.

`tests/observatoryStrength.test.ts` gained three groups. A dedicated
multi-return group builds a real 3-return-per-pulse chunk (`buildCellReturns`
plus `buildGriddedSourceRays`, the same CSR path
`observatoryFixtureF5F6F16.test.ts`'s F16 group drives) with returns at
ranges 3 m, 6 m and 9 m, confirms the ledger itself counts a real hit at the
2nd return's own voxel, confirms `accumulateStrengthHitSamples` (given the
`returnTable`) samples that voxel with finite `angularSpread`/`incidence`/
`rangeFit`, and confirms the SAME call without the `returnTable` finds no
sample there at all, the exact regression this correction closes. An
invariant group asserts, for every voxel of a real ledger run, that the
merged strength hit-sample count equals `row.counters.hit` exactly, checked
over both F1 (single-return) and the new multi-return fixture, plus a
partition-split variant of the multi-return case (splitting the chunk in two
before accumulating still matches the unpartitioned ledger per voxel,
`RayPartitionChunkEntry.returnCounts` sliced alongside each sub-chunk since
both index into the same shared `returnTable`).

`validation/observatory/oracle/strength-lattice.json` gained a seventh case,
`multi-return-second-return-only-voxel`: five samples all carrying range 6.0
(the return that actually overlapped the voxel), not the ray's own primary
range of 3.0, exercising the component formulas over a sample set shaped
like a real 2nd-return-only hit. `strength.py --write`/`--check` regenerated
and confirmed; `oracle-registry.json`'s `olv-observatory-strength-py` entry's
`limitations` updated to name the case and to state plainly that the oracle
itself does not drive a real multi-return traversal, that responsibility
staying with `accumulateStrengthHitSamples` and its own TypeScript-side
tests.

`docs/observatory/methods.md`'s `olv.observation.strength` section is
corrected: the "multi-return ray's later returns are not sampled" paragraph
is replaced with an accurate account of the fix (every return sampled via
`resolveRayReturnRanges`, the sample-count-equals-hit-counter invariant, the
first-overlapping-return tie rule).

`npm run typecheck`, the full `vitest run tests/` suite (17,379 passed, 48
skipped, 1 pre-existing todo, 0 failures over 1,349 files, same file count as
this phase's first account since no test file was added or removed, only
extended), `test:buckets:verify` (1349/1349), and `lint:layer-boundaries`,
`lint:module-graph`, `lint:unreachable-modules`, `lint:method-literals`,
`lint:oracle-registry`, `lint:doc-narration`, `lint:claim-register`,
`lint:architecture-truth`, `lint:release-truth`, `lint:doc-links`,
`lint:worker-registry` and `lint:disposal-registry` all pass.
`gen:v070-status` is regenerated after this entry.

### L168 · BUILT · SCIENCE

Observatory phase O7: run record, export bundle and session (SPEC §4
OB-INT-05, §8 OB-EXP-01/02/OB-SES-01, F10, F14). Baseline matches L167's own
HEAD; no commit landed between L167 and this phase's own work.

`src/observation/runRecord.ts` follows `simulationRunRecord.ts`'s own pattern
(source, basis, model id and version, input digest, SHA-256 over canonical
JSON) as a sibling type rather than a cast into `FieldSimulationKind`, which
has no member naming an evidence-ledger run. `ObservationRunRecord` folds
`ledger.ts`'s own `fieldDigest` in as one field alongside the classification
parameters, the state counts and the frontier summary, so its own `digest`
(via `sealObservationRunRecord`) agrees between two runs exactly when every
canonical fact agrees, never only the sub-digest. `id`/`generatedAt` are
excluded from the digest, matching `simulationRunRecord.ts`'s own reasoning.

`src/observation/session.ts` implements OB-SES-01: `commitObservationSession`
is the first caller to wire the already-implemented `observationFreshnessBreach`
(`analysisFreshness.ts`, an earlier phase) into an actual commit path, refusing
before a session record is ever built and naming the fact that moved
(OB-INV-09); `verifyObservationRerun` is the bare fieldDigest comparison
OB-SES-01 names for a reload's rerun.

`src/export/observatoryPackage.ts` builds the OB-EXP-01 bundle
(`observation-record.json`, `stations.json`, `field.bin`+`field.json`,
`state-summary.csv`, `frontier.csv`, a header-only `candidates.csv` since
Coverage Gain (O10) is not implemented, `processing-manifest.json` and
`scientific-passport.json` via the existing `buildProcessingManifest`/
`buildScientificAnalysisRecord`/`buildScientificArtifactPassport` (extended,
not paralleled, per OB-INT-05) and a `README.md`), following
`flowPulsePackage.ts`'s own pattern. `field.bin`'s columnar layout carries the
WHOLE `ObservationLedgerRow[]` (key, aggregate counters, `presence`,
`perSource`), not only the four aggregate counters: `computeFieldDigest`
folds `presence`/`perSource` in, so a `field.bin` missing them could never
satisfy OB-EXP-02's "re-hashes to `fieldDigest`". Every multi-byte value is
written through an explicit `littleEndian: true` `DataView`, never a typed-
array cast, so the bytes are endian-portable. `parseObservationFieldBinary`
and `recomputeFieldDigestFromExport` (rebuilding the minimal `RayPartitionInput`
shape `computeFieldDigest` needs from a run record's own stations, which carry
`tauAbs`/`tauRel`) close the round trip without needing the original ray
chunks.

Coordinates are never recentred: unlike Flow Pulse's local-grid `FlowGrid`,
`ObservationDomain` and `AcquisitionStation.pose.worldTranslation` are already
Float64 values in the dataset's own declared world/CRS frame, so nothing in
this phase subtracts or narrows an origin. `tests/observatoryRunRecordExport.
test.ts` builds one real F1-shaped run (station, wall, room) through the
actual ray builder and ledger traversal at a far UTM-scale origin (easting
400000, northing 3,600,000) and asserts the domain and station position
survive to the metre through both the sealed record and a JSON round trip,
that `field.bin` re-derives the declared `fieldDigest` and, separately, that
reclassifying from the parsed counters reproduces the exported state summary
(OB-EXP-02), and (F10) that two exports differing only in `basename`/
`generationDateIso` produce byte-identical `field.bin` columns and carry the
identical run-record digest. `tests/observatorySession.test.ts` exercises F14
directly: a mid-run ROI change refuses `commitObservationSession` with reason
`roi` and produces no session record, and a station-set change refuses with
`stationSet` instead, confirming the refusal names the fact that actually
moved.

`docs/validation/unreachable-modules.json` registers `runRecord.ts`,
`session.ts` and `observatoryPackage.ts` as staged (OB-INT-01): none is called
from the production graph yet, since wiring a live run through them is a
coordinator (O9). `docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md`'s stated
module count is corrected from 907 to 910 to match `lint:module-graph`'s live
figure after the three new files (`lint:architecture-truth` catches this
class of drift directly).

`npm run typecheck`, the full `vitest run tests/` suite (17,395 passed, 48
skipped, 1 pre-existing todo, 0 failures over 1,351 files (1,349 from
L167 plus this phase's own `observatorySession.test.ts` and
`observatoryRunRecordExport.test.ts`), `test:buckets:verify` (1351/1351), and
`lint:layer-boundaries`, `lint:module-graph`,
`lint:unreachable-modules`, `lint:method-literals`, `lint:oracle-registry`,
`lint:doc-narration`, `lint:claim-register`, `lint:architecture-truth` and
`lint:digest-manifests` all pass. `gen:v070-status` is regenerated after this
entry.


### L169 · BUILT · SCIENCE

Observatory phase O8: presentation colour modes, legend, ranges and voxel
probe (SPEC section 6 OB-PR-01/04/05, section 8 OB-UI-03). Baseline
`323e681b`, one commit ahead of L168's own HEAD (this phase's own commit).

`src/observation/presentationLegend.ts` is the pure vocabulary: a glyph,
label and RGB triple for every `ObservationState` (`observationStateLegend`
lists all nine, including states with zero voxels in the current field, per
OB-PR-01), a fixed `[0, 1]` range for `observationStrength` and
`observationHitFraction` and no range at all for the categorical
`observationState` mode (OB-PR-05), and `formatProbeText` (OB-UI-03),
matching the state/rule/per-source-line/method/basis order the spec's worked
example shows. Every glyph is distinct, tested directly, so colour is never
the only carrier (OB-PR-04); this module cannot import `ui/stateChip.ts`
(DOM-adjacent) so its glyph set is its own, independent of that unrelated
measured/preview/... vocabulary.

`src/render/observation/observationColorModes.ts` is the render-layer
adapter OB-INT-01 places outside `src/observation/`: `buildObservationPointColors`
walks a cloud's own positions, resolves each point's voxel key against the
same `domainGrid`/`packVoxelKey` the ledger uses, and looks the key up in a
sparse `stateByKey`/`strengthByKey`/`hitFractionByKey` map, returning one
interleaved RGB byte triple per point, matching `render/colorModes.ts`'s own
convention. It never reads or writes a canonical field; a dedicated
OB-INV-06 test builds a real ledger row set, takes its `fieldDigest`, runs
the colour builder across all three modes and every strength component, and
confirms the digest, computed from the same input, is unchanged.

`src/render/observation/ObservationPointOverlay.ts` is the three.js binding:
a standalone `THREE.Points` object, never the scan's own render mesh, so
nothing needs the loader/PointCloud ASK. `attach()` builds the `position`
attribute once from the cloud's own array; `setColors()`, called once per
resident cloud per field version, replaces only the `color` attribute.
`tests/observatoryPointOverlay.test.ts` asserts the `position` attribute
keeps its object identity across repeated `setColors()` calls with different
byte arrays, the no-geometry-rebuild guarantee OB-PR-01 requires, plus the
attach-on-first-colour, dispose and post-dispose no-op paths.

OB-PR-02 (the empty-space slice/instanced overlay) is explicitly deferred by
the spec itself until an O11 benchmark chooses between instancing and
slicing; nothing in this phase implements it.

OB-PR-06 does not apply here. Every colour mode this phase ships is a
bounded quantity under OB-PR-05, so no unbounded scalar needed the
adaptive-range function this phase would otherwise have had to add.

All three new modules are staged in `docs/validation/unreachable-modules.json`:
no coordinator exists yet to hold a resident cloud paired with a live
classified field, mount the overlay on a real scene, or wire the panel's
colour-mode picker and probe, which is O9. A `lazyChunks.ts` loader for
`ObservationPointOverlay.ts` was attempted and reverted during this phase: an
exported loader with no caller is dead code that Rolldown drops before
emitting a chunk, which trips `olv-chunk-emission-guard` at build time
(`npm run build:live` failed with "missing required code-split chunks:
ObservationPointOverlay" until the loader was removed). The registry entry
for that module records this so O9 adds the loader together with its first
real call, not before. The eager `index` chunk is unchanged at 811/812 KiB,
confirmed by comparing `npm run check:bundle` before and after this phase's
changes byte-for-byte.

`docs/architecture/architecture-map.md`'s render-layer size is corrected
from "~71k" to "~72k" and `docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md`'s
stated module count is corrected from 910 to 913, matching
`lint:module-graph`'s live figure after the three new files
(`lint:architecture-truth` catches this class of drift directly).

`npm run typecheck`, the full `vitest run tests/` suite (17,412 passed, 48
skipped, 1 pre-existing todo, 0 failures over 1,357 files, three more than
L168's 1,354 for this phase's own `observatoryPresentationLegend.test.ts`,
`observatoryColorModes.test.ts` and `observatoryPointOverlay.test.ts`),
`test:buckets:verify` (1357/1357), `npm run build:live` and `npm run
check:bundle`, and `lint:layer-boundaries`, `lint:module-graph`,
`lint:unreachable-modules`, `lint:monolith-size`, `lint:disposal-registry`,
`lint:doc-narration` and `lint:architecture-truth` all pass. `gen:v070-status`
is regenerated after this entry.

### L170 · BUILT · SCIENCE

Observatory phase O9: panel via coordinator, lazy chunk, badges, wording test
(SPEC section 8 OB-UI-01/02/05, section 10 O9). Baseline `0f3ed6cc`, several
commits ahead of L169's own HEAD.

`src/app/observatoryFromCloud.ts` is the coordinator's own glue between a
loaded `PointCloud` and the pure O1-O8 kernel: `runObservatoryOverCloud`
reads `cloud.acquisitionStations` (OB-INT-02), builds one ray per resident
point per station with `buildUnstructuredSourceRays`, runs the real
`runObservationLedger`/`classifyObservationField`/`computeShadowFrontier`,
and seals an `ObservationRunRecord`. Basis is `resident-only` always here
(each station's angular domain is declared unbounded, since an unstructured
build carries no narrower one to test against), never `full` or
`measured`, an honest limitation recorded in the run record itself, not a
placeholder. `observatoryEligibility` refuses (`no-stations` /
`empty-domain`) rather than inventing a station. `src/app/observatoryRunner.ts`
is the state machine ASK O9-1 (option 3) puts beside it: Snapshot ->
Await -> Revalidate -> Commit, comparing dataset id and CRS revision before
and after `compute()` so a scan/CRS change mid-run lands as `stale`, never
silently committed; `abortAndClearCache()` supersedes the in-flight token,
resets to idle, and clears the registered overlay through
`lazyChunks.ts`'s `registerObservatoryOverlayInvalidator`/
`invalidateObservatoryOverlay`, the same near-zero-cost seam
`registerFlowOverlayInvalidator` already established, now also called from
`terrainAnalysisRunner.ts`'s `abortAndClearCache()` alongside
`invalidateFlowOverlay()`. `src/app/openObservatoryRun.ts` is the thin
coordinator (mirrors `openTerrainAnalysis.ts`): builds the session's one
runner lazily, shows the panel, runs when nothing is committed yet.

`src/ui/observatory/observatoryPanel.ts` renders OB-UI-01's five sections
(Sources, Evidence, Shadow, Planning, Record) inside one Modal (ASK O9-2,
option 1: one panel, one lazy chunk). Planning states plainly that station
suggestion (O10) is not implemented in this release rather than showing an
empty control. `src/ui/observatory/stateChip.ts` supplies OB-UI-02's seven
badge glyph/word/tip triples (`DECLARED ORIGIN`, `ASSUMED ORIGIN`,
`RECONSTRUCTED ORIGIN`, `SOURCE COMPLETE`, `RESIDENT ONLY`, `SAMPLED`,
`SUGGESTED STATION`), built on a new `chip()` primitive added to
`src/ui/dom.ts` (ASK O9-3: no chip/badge helper existed there before this
phase, so one was added, generic, rather than a parallel Observatory-only
implementation). `src/render/ObservatoryOverlay.ts` +
`observatoryOverlayGeometry.ts` draw a capped wireframe box per `SHADOWED`
voxel through `Viewer.derivedLayerHost()` (visible in the scene, not only
inside the modal, per SPEC's own requirement), reusing the `SceneLineOverlay`
base `ProfileLinkOverlay`/`FlowOverlay` already stand on.

Wired into the command palette as `analyse.observatory`, next to
`analyse.flowPulse` in `src/app/actions/analysisActions.ts` and
`helpCatalog.ts`'s Analyse group. The coordinator (and therefore the whole
O1-O8 kernel it pulls in) is reached only through `loadObservatoryRun()`
(`lazyChunks.ts`), never imported at module scope from the action
contributor. An earlier draft of this phase statically imported it and
measured the action-registry chunk at 47 KiB; splitting it into
`loadObservatoryRun`/`loadObservatoryPanel` dropped that chunk to 27.5 KiB
and moved the kernel into its own lazy chunks (`openObservatoryRun` ~20 KiB,
`observatoryPanel` ~10 KiB, `observatoryPackage` ~13 KiB), confirmed by
`grep`ing the built, obfuscated `index-*.js` for every Observatory-specific
string/identifier and finding none. `main.ts`'s own `observatoryEntry`
wiring is the one eager cost O9 cannot avoid (it needs the shell's
`scans`/`viewer`/`crsService` closures): kept to primitive accessors only.
`worldToLocal`'s frame conversion was moved into the lazy coordinator itself
rather than threaded in as a second eager closure, once measurement showed
it was not free. `index` measures 808/812 KiB live-obfuscated (827,670
bytes), against 807 KiB before this phase; the whole net eager cost is the
few hundred bytes of that one object literal.

`docs/disposal-contracts.md` gains three rows: the shadow-voxel overlay
(cleared by the same `abortAndClearCache` seam as Flow Pulse and contours),
the runner's own state, and the Modal's `subscribe()` listener (cleared by
`Modal.close()`'s `onClose`). `src/styles/98e-observatory.css` is a new
partition file (section layout, the `.olv-observatory-chip` pill) registered
in `src/styles/index.ts`; `tests/fixtures/style.css.original` regenerated to
match.

Tests: `tests/observatoryRunner.test.ts` (11, state machine: idle/running/
committed/stale, cancellation, the lazyChunks invalidator seam, all against
an injected `compute` so this file never touches the real kernel),
`tests/observatoryFromCloud.test.ts` (7, eligibility plus a real small
end-to-end run through the actual O1-O8 pipeline over a fake cloud, digest
determinism), `tests/observatoryPanelWording.test.ts` (4, OB-UI-05's banned
words absent from every panel state), `tests/observatoryStateChip.test.ts`
(8, each badge word matches SPEC exactly, origin/basis read from the
kernel's own value), `tests/observatoryOverlayGeometry.test.ts` (4, pure
wireframe buffer builder), `tests/observatoryPanelSections.test.ts` (1, all
five sections present on a committed run), 35 new tests. `tests/e2e/observatoryPanel.spec.ts`
runs against a real single-station PTX fixture (`dropTinyPtx`): opens the
panel, asserts all five sections and a `DECLARED ORIGIN` badge, then closes
the scan and reopens the Observatory on the empty state, asserting no stale
station or state count survives: 6/6 passing across deterministic,
firefox and webkit. Manually verified in a real browser at desktop and
phone (375px) widths: the panel renders every section and badge legibly,
scrolls cleanly at phone width with no horizontal overflow.

`src/observation/types.ts`, `stateTable.ts`, `observationField.ts`,
`rays.ts`, `ledger.ts`, `shadowFrontier.ts`, `runRecord.ts` and
`src/export/observatoryPackage.ts` graduate out of
`docs/validation/unreachable-modules.json` (production now reaches all
eight through this phase's coordinator); `strength.ts` (O6, not wired to a
presentation consumer this phase), `session.ts` (OB-SES-01, no live
freshness stamp to commit against yet) and `coverageGain.ts`/
`stationSuggestion.ts` (O10) remain staged, correctly. Three direct
`.positions` reads in `observatoryFromCloud.ts` (`runObservatoryOverCloud`)
are classified `source-local` in `docs/validation/position-frames.json` and
`position-access-baseline.json` regenerated (172 -> 175).

`docs/architecture/architecture-map.md`'s render/app-layer sizes are
corrected ("~72k"/"~17k" to "~73k"/"~18k"),
`docs/architecture/float64-frame-migration-plan.md`'s position-read counts
(153/52 to 156/53), and `docs/releases/KNOWN_LIMITATIONS_v0.7.0-alpha.1.md`'s
module count (929 to 936), all matching `lint:architecture-truth`'s live
figures after this phase's new files.

`npm run typecheck`, the full `vitest run` suite (17,864 passed, 49 skipped,
1 pre-existing todo, 0 failures over 1,394 files), `npm run build:live` and
`npm run check:bundle`, and all 16 requested lints (`layer-boundaries`,
`module-graph`, `unreachable-modules`, `method-literals`, `oracle-registry`,
`claim-register`, `architecture-truth`, `release-truth`, `doc-narration`,
`disposal-registry`, `monolith-size`, `main-deferral`, `position-access`,
`v070-status`, `pr-hygiene`, `claims-language`) all pass. Station suggestion
(O10, coverage gain and next-station scoring) is not implemented; the
Planning section says so. `gen:v070-status` is regenerated after this
entry.

### L05 · PARTIAL · SCIENTIFIC

`tests/stockpileDualAnswer.test.ts` runs both estimators on the same lasso the
app takes: the point-sample integration (`volumeCutFill`, reached through
`computeLassoVolume`) that becomes the saved `VolumeRecord` at
`Viewer.ts:1198`, and the area-weighted grid (`stockpileAreaGrid`) that the
toast prints beside it through `stockpilePresenter.ts`. Both read the same
polygon, base height, up axis and native coordinates; the record's figure and
the grid's `fillM3` are both native times horizontal squared times vertical,
so the two compare directly with no unit correction on either side.

Twenty-seven analytic cases (cone, truncated pyramid and flat-topped mound;
independent uniform positions, a Thomas-clustered scanner pattern, and a 1/d²
range gradient; densities of 1 pt/m², 10 pts/m² and 100 pts/m², each averaged
over several seeds) put a number on where each estimator lands against the
closed-form volume. Under uniform sampling both centre on the
truth; the grid reads slightly low and scatters less. Under a range gradient
the point sample reads 16 to 25% low at every density and more points do not
close it; the grid reads 1 to 6% low at every density. Clustered at 1 pt/m²,
neither is within 20% of the truth and the grid reports PREVIEW on every run.
Clustered at 10 pts/m², the grid reports MEASURED on every run while reading 3
to 4% low.

Repository fixtures widen the same picture. Two uniformly sampled
rasterisation surfaces read within 1.1% by both, the grid the nearer; a
surface with a density hot spot reads 39% low by point sample and 7% low by
grid; a sharp 1 m step reads exact by point sample and 15% low by grid,
because the grid's cell crosses the step. A sparse-coverage case that leaves
46% support withholds the grid figure outright while the saved record still
carries `high` confidence on point count alone, over 70% low against the
closed form. A notch cut into the lasso that adds hull area but no points
inflates the point-sample figure by more than 10%; the grid, weighting area
actually covered, moves under 2%. On real airborne returns and on a canopy
fixture with no closed form, the two disagree by 3.6% and 8.6% with nothing to
settle which is right. Metres, US survey feet and a metres-over-feet compound
representation give the same m³ on the path the app takes; the grid's own
`linearUnitToMetres` option, not on that path, overstates a compound
representation by the ratio of the two factors, which is a caller error rather
than an estimator one.

No sampling regime makes one estimator strictly closer. The point sample is
exact against a sharp discontinuity the grid's cell blurs, and reads low
wherever density itself varies with position, whether by clustering or by
range; the grid removes most of that bias by weighting area rather than
points, at the cost of a support threshold before it reports at all and of
losing height where a real step falls inside one cell. Carrying the grid's
figure into the record, which is what remains of this entry's earlier
account, means carrying its coverage verdict (measured, preview or withheld)
rather than dropping it, and deciding what a withheld lasso saves; this entry
does not make that change.

Covered by `tests/stockpileDualAnswer.test.ts`.

### L05 · PARTIAL · SCIENTIFIC

Two corrections to the account above. The saved Lasso `VolumeRecord` is built
by `deriveVolumeRecord` at `main.ts:622`, fed through `computeLassoVolume`
(`main.ts:589`) and `lassoVolume.ts`'s `volumeFromLassoWithFootprint`, which
is the site `tests/stockpileDualAnswer.test.ts` reproduces. `Viewer.ts:1198`
is a separate `volumeCutFill` call, inside `setVolumeSampler`'s callback and
wired only to the point-and-click "Volume" polygon tool
(`MeasureController.ts`, `kind === 'volume'`); it persists its own
hand-rolled record with its own confidence tiers, is not reached through
`computeLassoVolume`, has no stockpile-grid counterpart, and the harness does
not touch it.

`stockpileAuthority` also has two branches the harness's synthetic clouds
never reached: an incomplete source and a voxel-reduced sample each cap the
grid at PREVIEW ahead of its support fraction, and every case above walks an
in-memory `PointCloud` with no streaming parts and no walk downsample, so
`sourceComplete` read true and `sampled`/`streaming` read false throughout.
The earlier account covered only the support/coverage axis of the verdict.
Three added cases drive `stockpileToastSuffix` directly, on the same
fully-supported cone selection the ladder's "full coverage" row reads
MEASURED on at 99% support: a voxel-reduced source caps it at PREVIEW
("display sample"), and a streaming source with an unknown resident count
caps it at PREVIEW ("source is streaming and not fully resident"), each
ahead of that support fraction.

Covered by `tests/stockpileDualAnswer.test.ts`.

### L05 · FIXED · SCIENTIFIC

The lasso Volume record now stores the area-weighted grid's figure, with the
point-sample cut and fill kept beside it as a labelled cross-check. Measured
on the 21 analytic cases where every run is MEASURED
(`tests/stockpileDualAnswer.test.ts`): the median per-run absolute error is
1.44 percent for the grid and 6.71 percent for cut and fill; the per-case
bias reading, which lets opposite-sign runs cancel, orders them the other way,
1.40 percent against 0.90 percent. Uniform-sampling worst case: 18.3 percent
against 31.9 percent. The report quotes both readings.

`stockpileResult.ts`, in the lazy stockpile chunk, builds one result per
lasso: the grid's `fill`, `cut`, `net` and `method`, the coverage verdict as
`gridAuthority` and `gridAuthorityReason`, the point-sample figure under
`crossCheck` with its own tag, the input counts under `withheld`, and
`resultSchema: 1`. The toast's volume clause is formatted from that object
and Save stores the same object, so the toast, the session file, the CSV and
GeoJSON columns, the findings report and the evidence stamp all read one
record. A withheld grid stores no `fill`, `cut` or `net`; nothing falls back
to the cross-check under the grid's name, and the session parser drops those
three fields from a withheld record even when a file supplies them. A
withheld row's evidence stamp names VOL-POINT-SAMPLE, the estimator behind
the only numbers it shows.

A record saved before this change keeps its method tag
(`olv.volume.stockpile@1`, or none) and its numbers; nothing re-derives it.
The hand-drawn polygon Volume tool is unchanged and still stores cut and
fill. Units follow the record's native-unit contract, so metres, US survey
feet and a metre-over-foot compound CRS give the same cubic metres as
before.

Values that change for a user: on a lasso whose grid reports MEASURED or
PREVIEW, the stored and exported `fill_m3`, `cut_m3` and `net_m3` become the
grid's figures, and the point-sample figures move to `pointsample_*_m3`; on
a withheld lasso those three columns are blank.

Covered by `tests/stockpileResultParity.test.ts`,
`tests/stockpileMethodIdentity.test.ts`, `tests/measureDerivations.test.ts`,
`tests/stockpilePresenter.test.ts`, `tests/measurementExport.test.ts`,
`tests/measurementReport.test.ts` and `tests/measurementChains.test.ts`.

### L26 · PARTIAL · SCIENTIFIC

The lasso volume leaves out points flagged Withheld at its input, the way
the terrain gather does: ASPRS LAS 1.4 defines the flag as a point that
should not be included in processing. `computeLassoVolume` drops them after
the lasso and visibility filters and before the depth test, so neither the
grid nor the point-sample cross-check reads them. Overlap and the other flags
are not consulted. The result records `source`, `excluded` and `analysed`
counts; when a contributing source has no flags channel (a voxel-reduced
cloud, whose centroids carry none, or a decode without point semantics),
`excluded` reads `unknown` rather than 0 and nothing is invented for it. The
grid's method moves to `olv.volume.stockpile-area-grid@3`; a record stored at
`@2` keeps that tag.

Values change only on files that contain Withheld points inside the lasso.
The polygon Volume tool, profiles and density still read every point.

Covered by `tests/lassoVolumeWithheld.test.ts`.

### L13 · OPEN · EVIDENCE

The iOS simulator leg stays advisory until it passes 20 consecutive runs, and
each run is classified by script, not by reading its log. `scripts/ios-streak.mjs`
reads the workflow's runs through `gh` and classifies each one with
`scripts/lib/iosRunClassifier.mjs` against the signature list in
`scripts/ios-infra-signatures.json`.

A run is INFRASTRUCTURE only when its first failing step comes before the
first app assertion and its log matches a listed signature: runner
provisioning, a network or DNS error while downloading dependencies or the
driver, a missing simulator runtime, or WebDriverAgent unreachable on :8100
before the session opens. `ios-touch-check.mjs` prints `OLV-IOS-SCRIPT-START`
when it starts and `OLV-IOS-FIRST-ASSERTION` immediately before its first
assertion; inside that step, only text between the two can match. Any other
failure is FAILURE and resets the streak. A run with no start marker, no log
or no assertion step is FAILURE. INFRASTRUCTURE neither counts toward 20 nor
resets the streak, and is listed by run id. If more than 20% of the evaluated
window (default 30 completed runs) is INFRASTRUCTURE, the leg reads
UNRELIABLE whatever the streak. Signatures change only by commit.

On 24 September 2026 the script read 28 completed runs: streak 2 of 20, one
INFRASTRUCTURE run (35883012823, ENOTFOUND while installing the driver),
leg ADVISORY. `iosRunClassifier.test.ts` covers each signature, a
signature-matching failure after the first assertion, the missing-marker case,
the streak and the 20% guard.

25 September 2026: `macos-latest` now maps to an arm64 image
(`macos-26-arm64`, a paravirtual-GPU VM). On it SimMetalHost crash-loops one
to three seconds after the two-finger pinch and takes Mobile Safari down
(runs 36085521670, 36113030817, 36116348510; the simulator log reports
"Process crashed: SimMetalHost"). `ios-simulator.yml` on main is now pinned
to `macos-26-intel` with iOS 26.5 / iPhone 17e, resolved by exact name by
`scripts/pin-ios-simulator.mjs`, with WebDriverAgent built once and reused by
the session. `ios-streak.mjs` counts only runs on the pinned runner: a run
whose "Set up job" log names an arm64 image is EXCLUDED, neither counting
toward 20 nor resetting the streak, and stays outside the 20% guard.

### L171 · BUILT · SCIENCE

Observatory phase O10: Coverage Gain and station suggestion
(`docs/observatory/SPEC.md` §5.6 OB-GAIN-01 to 06, §9.1 F11, F12, F15).
Baseline `e9daea78`.

`src/observation/coverageGain.ts` implements `olv.observation.coverage-gain`.
The instrument model (height above the standing surface, minimum and maximum
range, vertical field of view, planning step, or "same as source N", refused
when source N declares nothing) is validated and recorded in full.
Candidates stand on `SURFACE` voxels whose fitted normal is within 20° of
vertical and whose column is clear of ray-stopping voxels to instrument
height, one per square cell of the declared spacing, indexed in grid order,
thinned by an even stride when over the cap; the cap and the dropped count
are recorded. Planning rays point at the bin centres of the declared step
and are walked with the ledger's own `clipRayToDomain` and
`traverseVoxelSteps`; `SURFACE` stops a ray, and `PARTIAL` stops it at a hit
fraction of `p_solid` or more. `scoreCandidate` reports every term of
`G(c) = Σ w(state)·vis·inc − λ_red·redundant` separately: visible voxels,
the weighted sum, per-state tallies (`SHADOWED`, `UNADDRESSED`,
`NO_RETURN_PATH`, `CONFLICT`, weak `SURFACE`), the redundant count and
penalty, the gain and the `NOT_READ` count, which carries weight 0.
`planningAuthority` returns `measured` only for basis `full`, no `NOT_READ`
voxel and declared origins, and otherwise `preview` with every reason named.

`src/observation/stationSuggestion.ts` implements
`olv.observation.station-suggestion`: greedy selection for a declared
station count against a hypothetical covered set, ties to the lower
candidate index, stopping when no gain is positive and recording why. The
canonical ledger rows and state map are only read. `ReachabilityProvider`
stays an interface with no implementation (OB-GAIN-06).

`src/observation/incidence.ts` is the one home of incidence estimation: the
covariance normal fit (`fitNormalFromResidentPoints`, moved from
`strength.ts`, which re-exports it), a streamed per-voxel moment
accumulator, `|cos i|` and the median. Strength's `incidence` component and
Coverage Gain's `inc_c` term both use it. The eigen solve is closed form
rather than `src/math/symEig3.ts`: importing `symEig3` split it into a shared
chunk and added 36 bytes to the entry chunk's dependency map. The closed form
agrees with `symEig3` on 500 covariances (eigenvalues to 1e-10, normal
direction to 1e-8).

`src/app/observatoryFromCloud.ts` runs planning after the shadow frontier:
normals from the resident points of each `SURFACE` voxel in one pass, a
default model of 1.5 m height, 0.5 m minimum range, the domain diagonal as
maximum range, a 180° sweep and a 5° step (source units when the linear unit
is unknown), 16 candidates and 2 suggested stations. The run record lists
`olv.observation.coverage-gain@1` and `olv.observation.station-suggestion@1`
when planning ran. `fieldDigest` and the state counts are identical with and
without planning, and suggested stations never enter the station list. On a
9,702-point wall-and-ground cloud the whole run takes 33 ms without planning
and 67 ms with it (Node 22, mean of 5); no worker was added (OB-RT-03).

The panel's Planning section replaces the not-implemented line with the
result: authority and its reasons, the instrument model, candidate counts
and cap, the `NOT_READ` count, each suggestion as "SUGGESTED STATION (not
observed)" with its position, gain and every term, and a statement that
reachability is not checked. `candidates.csv` now lists every candidate with
every term, the suggested rank and gain at selection, and a header naming the
methods, authority, instrument model, weights and candidate grid.
`observatoryPackage.ts` resolves the run record's `id@version` method tags
through the registry; before this entry the live export threw
`Unknown method id` on them. Suggested stations are not drawn in the 3D view.

Validation. `validation/observatory/oracle/coverage_gain.py` (standard
library, `fractions.Fraction`, reusing `ray_aabb_traversal.py`'s clip and
traversal) is registered as `olv-observatory-coverage-gain-py` in the
`olv-observatory-analytic-oracle` lineage. It scores the declared field in
`validation/observatory/fixtures/f11-coverage-gain.json` (written by
`scripts/generate-observatory-fixtures.mjs`): three candidates, 1,296 planning
rays each, every term frozen in
`validation/observatory/expected/f11-coverage-gain.expected.json`. F11: the
candidate behind the wall ranks first (gain 2,603.9 against 1,167.6 beside
station 1) and every count matches the oracle exactly, sums to 1e-9. F12: the
second pick is the candidate past the pillar, reaching 118 `SHADOWED` voxels
the first cannot, and the field is unchanged. End to end through
`runObservatoryOverCloud`, the top candidate stands behind the wall and the
second suggestion still reaches shadow. F15: a station with an `ASSUMED`
origin gives authority `preview` naming the station, in the panel and in
`candidates.csv`, beside the `ASSUMED ORIGIN` badge and `stations.json`.
`coverage_gain.py --check` and the four existing Observatory oracles pass.

Tests: `tests/observatoryCoverageGain.test.ts` (29, per requirement
OB-GAIN-01 to 06 and `incidence.ts`), `tests/observatoryFixturesO10.test.ts`
(13, F11, F12, F15), `tests/observatoryPlanningPanel.test.ts` (10, panel and
`candidates.csv`), one more OB-UI-05 case in
`tests/observatoryPanelWording.test.ts` over a committed run with planning,
and a Planning assertion in `tests/e2e/observatoryPanel.spec.ts`.
`coverageGain.ts`, `stationSuggestion.ts` and `strength.ts` leave
`docs/validation/unreachable-modules.json`. `observatoryFromCloud.ts` reads
`.positions` once instead of three times (baseline 174 to 172). Bundle:
entry chunk 823,094 bytes and Viewer 751,944 bytes, both equal to the
baseline build; `openObservatoryRun` 20,042 to 35,860, `observatoryPanel`
9,509 to 12,685, `observatoryPackage` 13,158 to 15,649.

### L64 · PARTIAL · CORRECTNESS

The labelling mechanism now exists. `BaseExportMode.ts:460` computes
`presentation` from `context.continuityCapabilities` through
`presentationOfCapture`, `FigureStampContext` carries `presentation` and
`reconstructedShare`, and `tests/exportIsolation.test.ts` pins the caller to
the honest `as-is` branch and refuses a credited stand-down.

`continuityCapabilities` (`types.ts:304`) is declared and never assigned.
`Viewer.exportImage` builds its `ExportContext` from `renderer`, `scene`,
`camera`, `canvas`, `adapter` and `classScopeStamp` alone, so `capturedCaps` at
`BaseExportMode.ts:459` is `undefined` on every real call and the ternary
falls to `source` regardless of what the Continuity Field is doing.
`reconstructedShare` is hardcoded `null` at `BaseExportMode.ts:469`; no census
feeds it. Both wait on the same seam the render side has not opened.

### L46 · PARTIAL · PERFORMANCE

The renderer is wired now. `renderLoop.ts:229` calls
`host.cullStreamingToFrustum()` on every rendered frame with a session
attached, `Viewer._buildRenderLoopHost` binds that to
`StreamingRenderer.cullToFrustum` (`Viewer.ts:6057`), and `cullToFrustum`
derives the frustum planes from the live camera and calls
`applyFrustumVisibility`, whose only write to `mesh.visible` is
`_applyVisibility` (`StreamingRenderer.ts:430`). `tests/renderLoop.test.ts`
now asserts the call fires on a rendered frame with streaming attached and
does not on an idle frame or with no session, closing the gap the mock alone
left open.

What is unproven is still unproven. No record exists in
`validation/renderer-benchmark/`; `verify-renderer-benchmark.mjs` exits clean
on an empty directory rather than measuring anything. The prior caveats hold:
a culled node carries no points, so a drawn-node share is not a GPU-time
share, and the stored baseline is an orthographic four-camera snapshot, not a
frustum.

### L84 · PARTIAL · CORRECTNESS

The counter this account said did not exist now does. `deviceGeneration.ts`'s
`DeviceGeneration` is wired through `watchDeviceChanges` at `Viewer.ts:4306`
and exposed as `viewer.deviceGeneration` (`Viewer.ts:3245-3250`). L134
measured it against a forced `WEBGL_lose_context` on the WebGL backend: the
context reports lost, the restore arrives, the interface survives and no page
error is raised either side.

The renderer's own resources are covered; the Continuity Field's are not.
`ContinuityRuntime.ts:368` reads `input.display.deviceGeneration` and hands it
straight to `HistoryTargets.resize`, but nothing in `Viewer.ts` constructs
that `DisplayState` or calls into `ContinuityRuntime` at all, because the
subsystem is still unreachable from `main.ts`. The generation a history
surface would need to invalidate against exists and is measured; it has
nowhere to be read from yet.

### L103 · PARTIAL · SCIENTIFIC

"There is neither" is now half right. L114 measured a real browser session
for the Continuity Field: WebGPU creates all three history surfaces and
WebGL 2 reports `EXT_color_buffer_float` and an R32F framebuffer complete,
recorded in `validation/renderer-capability/`. A device to render on exists;
`docs/continuity-field.md:63-67` and `verify-renderer-benchmark.mjs:16-20`
both say so now, correcting the same repeated claim.

What is still missing is the wiring: nothing calls the Continuity Field from
a renderer, so no frame has ever been drawn through it and a screenshot
corpus has nothing to screenshot. There is still no phone, tablet or WebKit
device; the probe is one Chromium session on one laptop. The ten
deterministic grid scenes this account built stand as they were: a rule
check, not a substitute for either gap.

### L109 · PARTIAL · SCIENTIFIC

One of the three deliberate omissions rests on a claim L114 has since
corrected. This account said no runner here exposes a WebGPU adapter;
`docs/continuity-field.md` itself now says otherwise at lines 63-67, because
the browser this project previews in does, and
`validation/renderer-capability/` records it. Frame time is still unmeasured,
but the reason is that the field is not wired into a renderer, not that no
GPU is reachable, which is the distinction L114's own account draws.

The other two omissions stand as written: no release notes while the tree is
untested, and `limitations.md` left alone rather than describing a limitation
of code nothing runs. There is still no phone, tablet or WebKit device; one
Chromium session on one machine narrows nothing about them, correction or
not.

### L110 · PARTIAL · SCIENTIFIC

"No runner here exposes a WebGPU adapter" is the same claim L114 corrected
elsewhere in this programme, and it was wrong here too: the browser this
project previews in reaches both a WebGPU adapter and a WebGL 2 context, per
`validation/renderer-capability/`. The sixteen fields still have no record,
and the reason still holds without that sentence: the field has never drawn
a frame, because nothing wires it into a renderer, so every field but the
commit hash would still have had to be invented.

`verify-renderer-benchmark.mjs:16-20` states the corrected reason directly
and exits clean on the empty directory rather than measuring anything.
There is still no phone, tablet or WebKit device, correction or not; the
schema, the required-scene set and the four structural checks this account
built are unaffected and still gate the first record that appears.

### L115 · PARTIAL · SCIENTIFIC

The account above overstates the code. "Geometry rasters suspend
reconstruction" is not true today: `BaseExportMode.ts:460` calls
`presentationOfCapture(capturedCaps, 'as-is')` with the literal string
`'as-is'`, never `capturePolicyFor`'s verdict. The comment above it says why:
the renderer sits behind the export-to-render boundary the module-graph
ratchet holds shrink-only, and this caller performs no suspension.
`capturePolicyFor` (`presentationMode.ts:96`) computes the obligation and is
imported nowhere outside its own file and its test.

What ships is disclosure, not isolation. A geometry raster captured while
reconstruction runs is labelled `reconstructed`, not stood down.
`tests/exportIsolation.test.ts` names the gap directly, in a describe block
titled "the suspension is named but not yet performed," and pins the absent
import with a source-text assertion. L64 separately found
`continuityCapabilities` itself never populated by `Viewer.exportImage`.

### L26 · PARTIAL · SCIENTIFIC

Points flagged Withheld are left out of every analysis this row names except
one. The terrain gather skips them (`terrainStreamSample.ts:142`), and a
static cloud whose flags were lost to the load-time voxel reduction is
re-decoded at full resolution for the DTM (`terrainAnalysisRunner.ts:357-372`,
called at `:823`) up to a 750 MiB source
(`withheldAwareTerrainGather.ts:77`); a larger source falls back to the
display gather and the DTM records the outcome as not recorded. Lasso
stockpile volumes skip them (`lassoVolumeCompute.ts:142`). Profiles skip them
in the profile series (`profileSampler.ts:127-133`) and the profile workbench
section (`profileSectionExtract.ts:187`). The Scan Report's Density and
Spacing count only points without the flag (`scanReport.ts:228-237`), as does
the density figure on the Inspector card (`inspectorCardRefreshers.ts:299-308`).
Each records points read, Withheld excluded and points analysed, and reads the
excluded count as unknown when a source has no flags channel.

The polygon Volume tool does not. `Viewer.ts:1164-1193` gathers every
visible cloud's positions and passes them to `volumeCutFill` without reading
`classificationFlags`, so a Withheld return inside a hand-drawn polygon counts
toward cut and fill. Closing that needs the flags carried through
`assembleVolumePositions`, a method version change for the point-sample
volume, and the same read, excluded and analysed counts on its record.

Covered by `tests/withheldTerrainGather.test.ts`,
`tests/terrainRunnerWithheldRecovery.test.ts`,
`tests/lassoVolumeWithheld.test.ts`, `tests/profileWithheld.test.ts` and
`tests/scanReportWithheld.test.ts`.
