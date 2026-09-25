# Observatory methods

One section per `olv.observation.*` id in `src/science/methodRegistry.ts`
(OB-INT-04). These seven ids are registered early, ahead of most of their
code, to reserve their names and version
numbers before the phases that build them
(`validation/protocols/v070-decision-rules.md`). Each section states plainly
whether the method has an implementation behind it today and, when it does
not, which phase of `docs/observatory/SPEC.md` §10 will add one.
`tests/observatoryMethodDocs.test.ts` (OB-INT-04) checks that every registered
`observation`-category id has a section here with a Phase heading.

None of the not-yet-implemented sections below is a claim that the method
runs. `lint:claim-register`, `lint:claims-language` and
`lint:architecture-truth` govern what may be claimed elsewhere about
Observatory. This document exists to keep this file itself from drifting into
one.

## `olv.observation.rays`

#### Status

`buildGriddedSourceRays` and `buildUnstructuredSourceRays`
(`src/observation/rays.ts`) are implemented and tested against the F5, F6
and F16 ray-level fixtures (phase O3). Neither is yet reachable from a live
scene: nothing in the production graph builds an evidence ledger to traverse
their output with, which is traversal (O4).

#### Phase

O3 built the ray builder. O4 wires it to a live ledger.

Builds one ray per grid cell for a gridded source (PTX, structured E57,
organized PCD with an origin), direction from the source's fitted angular
parameterisation (`acquisitionCoverage.ts`). The fit is already anchored to
the station's own origin and its own observed azimuth/polar baseline, so no
separate rotation by the declared station pose (`AcquisitionStation.pose`,
OB-INT-02) is applied on top of it. A `VALID_RETURN` cell gives a returned ray
at its `geometricRange`, or, for a format that never declares one (structured
E57, organized PCD), a range derived in Float64 from the record's position
and the station's own origin, the same recipe OB-RAY-02 uses. A `NO_RETURN`
cell gives a returned ray with `NaN` range. A `NOT_DECODED` cell gives a
not-read ray, which is how a strided or streamed load's gaps reach the state
table as `NOT_READ` rather than as missing evidence (O4's job; O3 only builds
the ray). `SOURCE_INVALID` and `SOURCE_RECORD_MISSING` cells give no ray at
all, though both are still counted (OB-RAY-01). A posed unstructured E57
point instead gets one ray with direction `normalize(hit - origin)` and range
`||hit - origin||`, computed in Float64 in the station's own frame before any
recentring (SPEC §5.1 OB-RAY-02).

Structured E57's own pose gap (`E57GridBuilder.frame()` never sets
`OrganizedRangeFrame.acquisitionPose`, unlike PTX and PCD) is resolved without
touching loader output. `acquisitionCoverage.ts`'s `AcquisitionCoverageOptions`
gained an optional `poseForFrame` callback, and `AcquisitionStations.ts`
gained `stationForRecord`, a `[start, end)` record-range lookup, to back it.
This joins by record-range containment rather than by matching a frame's own
scan identifier against a station id, which desyncs from it (L162: the grid
builder counts only the scans that earned a grid, the station sidecar counts
every merged scan).

#### Assumptions

A multi-return pulse contributes one ray, not one per return: every return's
voxel increments `hit`, `pass` runs only to the first return, `behind` only
from the last (OB-RAY-03). Storage is structure-of-arrays in bounded chunks,
no per-ray JS object (OB-RAY-04). The declared shape is
`src/observation/rays.ts`'s `ObservationRayChunk`.

#### Parameters

None of its own. Consumes the station sidecar (OB-INT-02) and the source's
fitted angular parameterisation as given.

#### Failure modes

A degenerate input (NaN origin, zero-length ray) is refused or handled per
the documented rule (F17). An unstructured source produces no no-return
rays, and the field records that `NO_RETURN_PATH` is unavailable for it
(OB-RAY-02).

#### Determinism

Subsampling is declared, not incidental: every k-th row and column for
gridded sources, a hash threshold on record index for the rest, with `k` or
the threshold recorded (OB-RAY-05, `RaySubsampling` in `rays.ts`). A
subsampled field carries basis `sampled`.

## `olv.observation.ledger`

#### Status

The traversal and ledger accumulation (`src/observation/ledger.ts`) are
implemented and tested against F8, F9 and a dedicated budget-refusal test
(phase O4). Phase O5 adds an optional per-entry `RayPartitionChunkEntry.
maxRange`, bounding a no-return ray's own traversal (needed for F7's
unaddressed pocket; see this section's "declared maximum range" note below),
and `tests/observatoryFixturesO5EndToEnd.test.ts` drives real
`buildGriddedSourceRays` output through this traversal for F1, F2, F3 and
F7. Not yet reachable from a live scene: nothing in the production graph
wires `rays.ts`'s builders to this traversal on a real scan, which is a
coordinator (O9).

#### Phase

O4 built traversal and the ledger. O5 adds `maxRange` and consumes real
ledger output end to end for its own fixtures. O9 wires it to a live scene.

Traverses every built ray against a sparse voxel table by 3D DDA (Amanatides
and Woo, 1987), accumulating `hit`, `pass`, `behind` and `noReturn` per
voxel, per source and in aggregate (SPEC §5.2 OB-LED-01).

#### Assumptions

Cheap rejection runs before traversal: clip to the domain AABB, skip an
empty-after-clip ray (OB-LED-02). The range-sphere station skip is a proven
no-op performance optimisation (a station whose range sphere misses the
domain can only produce empty clips for every one of its rays) and is not
implemented in this phase, since it changes no counter; this is recorded at
the clip site in `ledger.ts` itself, not only here. OB-LED-02's rejection
ratio IS implemented: `traverseRayChunks` returns it on `PartialLedger.
telemetry` (total rays considered against rays a degenerate direction or an
empty clip discarded before any voxel step ran), `mergeRejectionTelemetry`
sums it across partitions, and `runObservationLedger`'s `'ok'` result exposes
it as `rejectionRatio`. The tie rule for a ray running exactly along a voxel
face is written down and tested with axis-aligned and grazing cases (F8,
scored directly against the frozen Python oracle this phase, on the
exact-rational fixture coordinates phase O1 wrote).

`τ(r) = tau_abs + tau_rel·r` is evaluated per source per ray at traversal
time, both formulas preregistered in
`validation/protocols/observatory/OB-ST-THRESHOLDS.protocol.json`. A voxel's
traversed parametric span classifies against a returned ray's hit window
`[r − τ(r), r + τ(r)]`: `pass` when the span ends at or before the window
opens, `behind` when it starts at or after the window closes, `hit` when it
overlaps the window at all. A multi-return ray's `hit` fires once per voxel
overlapping any individual return's own window; `pass` runs only up to the
FIRST return's window start and `behind` only from the LAST return's window
end (OB-RAY-03); a voxel's span strictly between two returns' windows gets no
counter AND no row at all, a deliberate reading: `ObservationLedgerRow.
presence`'s own doc comment defines "touched" as hit, pass, behind, noReturn
or notDecoded, and a gap voxel is none of those, unlike a not-read ray, which
always gets a presence-only row because `notDecoded` is on that list. SPEC's
"declared maximum range" (§5.2, twice) was read at O4 as the domain bound
itself, since no source declared a range cap anywhere in O1-O4's types. O5
corrects this for a station that DOES declare one (`maxRange` on
`ObservationFieldStation`/`StationAngularDomain`, needed for F7's own
scenario, a pocket squarely inside a station's angular band but beyond its
declared range): `RayPartitionChunkEntry.maxRange`, when supplied, clips a
no-return ray's own traversal to `min(domain exit, maxRange)` instead of the
domain bound, matching "a real instrument that never listens past its own
declared range" rather than the domain's own, usually larger, extent. A
returned ray needs no such clip: its own finite range already bounds its hit
and behind windows. The field is optional and additive: every entry before
F7 omits it, so F8's, F9's and every prior test's original domain-bound
reading is unaffected.

The voxel row's open-addressing table is accumulated by `LedgerBuilder`, a
typed-array-column table over the packed voxel key: the storage style
OB-LED-03 names as precedent, matching `voxelDownsample.ts`'s
`VoxelAccumulator`: linear probing, capacity doubling that rehashes keys but
never renumbers a slot, row and per-source counters held in flat
`Uint16Array`/`Uint8Array` columns indexed by slot (per-source columns by
`slot*sourceCount + sourceIndex`). `finish()` walks slots in first-touched
order, the same determinism a `Map`'s insertion-ordered iteration gave the
phase's original correctness pass.

`checkVoxelDomainBudget`'s `estimatedBytes` is grounded in this table's own
WORST-CASE cost, not a single favourable sample of it. Sampling
`measureLedgerBuilderBytesPerVoxel` at one occupancy (1.5 million) first gave
~77 B/voxel at one source per occupied voxel, ~119 at four, but that point
sits deep into a capacity-doubling cycle, where every column is amortized
over a near-full table. Sweeping occupancy across doubling boundaries shows
the true worst case sits right AFTER a doubling, when only `capacity/2 + 1`
of the new, twice-as-large columns are occupied: 110 B/voxel at one source,
170 at four. `ledgerBuilderWorstCaseBytesPerVoxel(sourceCount)` computes this
analytically from the column byte widths and that ~50% just-after-growth
load factor, not from a sample:

```
worstCase(sourceCount) = 2 x (
  17                                // row: 4x Uint16 (8B) + 1x Uint8 (rowSaturated) + 1x Float64 (keyBySlot, 8B)
  + 4 x presenceWords(sourceCount)  // row: Uint32 presence words
  + 10 x sourceCount                // per-source: 4x Uint16 (8B) + 2x Uint8 (srcSaturated, srcNotDecoded)
  + 24                              // probe table: (Float64 key 8B + Int32 slotIndex 4B) x 2 (table size = 2x capacity)
)
```

Still an order of magnitude below the retired `Map`-keyed builder's 650-990
B/voxel. `checkVoxelDomainBudget` uses this formula with the caller's own
`sourceCount` (`runObservationLedger` passes its run's own station count; an
explicit `bytesPerVoxel` override still wins), defaulting to 1 when no
station count is available so the check stays a pure function of `domain`
and `voxelEdge` alone in that case.

`SOFT_MAX_BUDGET_BYTES`/`HARD_MAX_BUDGET_BYTES` fix OB-LED-03's real-memory
envelope in BYTES (183 MiB soft, ~2.86 GiB hard, the same envelope the
original 48-byte-assumed 4,000,000 / 64,000,000 cell pair intended) and the
cell ceiling is DERIVED per call as `envelopeBytes / worstCase(sourceCount)`,
so the byte envelope can never be exceeded at any occupancy or source count.
Resulting cell ceilings at a few source counts:

| sourceCount | B/voxel (worst case) | soft cells | hard cells |
| ----------- | --------------------- | ---------- | ---------- |
| 1           | 110                    | 1,744,449  | 27,917,287 |
| 4           | 170                    | 1,128,761  | 18,064,127 |
| 16          | 410                    | 468,022    | 7,490,003  |
| 32          | 730                    | 262,862    | 4,206,714  |

A domain whose occupied voxels average well over the declared `sourceCount`
needs a caller-supplied `bytesPerVoxel`.

#### Parameters

The voxel edge `h` and a declared voxel memory budget (OB-LED-03,
`checkVoxelDomainBudget`, a pure function of the domain and `h` alone, so no
ray needs to exist to check it). A declared work-step budget checked against
the estimate, total clipped ray length divided by `h`, before any allocation
(OB-LED-04, `estimateTraversalBudget`).

#### Failure modes

`runObservationLedger` checks the voxel budget first, then the step budget,
either refusing before any table is allocated (`ObservationLedgerRunResult`'s
`'refused'` variant, never a thrown exception). A `'coarsen'` voxel verdict
or an over-estimate step budget both refuse by default; only an explicit
`allowOverBudget: true` proceeds past either, offering a coarser `h`, a
smaller ROI or subsampling. A `'blocked'` voxel verdict is never overridable.
The run never truncates silently.

#### Determinism

Counters are integers, so accumulation is commutative. Chunks are assigned to
a partition at whole-chunk granularity; `mergePartialLedgers` folds every
partition's rows with a saturating-sum-and-flag rule per counter, a bitwise
OR per presence word, and the same saturating rule per per-source entry. All
three combinators are commutative and associative, so the merged VALUES are independent of
fold order. `computeFieldDigest` then sorts rows by key and each row's
`perSource` by `sourceIndex` before hashing with `canonicalHash`
(`src/canonicalHash.ts`), since `canonicalJson` sorts object keys but not
array elements, and a raw `Uint32Array` would otherwise serialize through a
lexicographic key sort past nine elements. F9's worker-count axis is read as
IN-PROCESS PARTITION count (fixed on 2026-09-23): 1, 2 and 5
partitions of the same deterministic ray-chunk list, merged by this same
order-independent merge, give an identical `fieldDigest`. No Web Worker and
no `WORKER_REGISTRY` entry exist yet; `RayPartitionInput`/`PartialLedger` are
already worker-transfer-shaped (typed-array chunk columns, a `returnCounts`
column added for multi-return CSR addressing across a partition boundary), so
a real worker at O11 (OB-RT-03, gated on profiling) wraps
`traverseRayChunks` in `postMessage`/`onmessage` rather than rewriting it.
Cross-machine reproducibility (OB-INV-07's third axis) is satisfied by
construction (IEEE-754 deterministic float ops, integer saturating
counters, no `Math.random`, no object-iteration-order dependence after the
canonicalisation fixes above), rather than by a cross-host test, which this
phase does not run.

## `olv.observation.states`

#### Status

The pure per-voxel decision function (`deriveObservationState`,
`src/observation/stateTable.ts`) is implemented and tested against an
independent oracle over 7,504 preregistered lattice rows (phase O1,
`tests/observatoryStateTable.test.ts`). Phase O5 adds
`src/observation/observationField.ts`, which wires it to a real ledger:
`isVoxelAddressed` (a closed-form spherical-coordinate test against a
station's declared azimuth/elevation band and optional range window) and
`classifyObservationField` (assembling `deriveObservationState`'s
`SourceObservationRecord[]` input, per voxel, over the ledger's own
domain grid). Scored against F1 through F4, plus F7 and F17
(`tests/observatoryFixturesO5.test.ts`). It is not yet reachable from a live
scan: nothing in the production graph runs `runObservationLedger` against a
loaded scene and classifies the result, which is a coordinator (O9).

#### Phase

O1 built the function. O5 wires it to a real (fixture-scale) ledger. O9
wires it to a live scene.

Maps one voxel's per-source counters to one of nine states by the precedence
table SPEC §2.4 gives as the whole rule (`NOT_READ` first, then `CONFLICT`,
`SURFACE`, `PARTIAL`, `OBSERVED_EMPTY`, `SHADOWED`, `NO_RETURN_PATH`,
`UNADDRESSED`, `OUTSIDE_DOMAIN` last though numbered last in the table
itself).

#### Assumptions

`CONFLICT` requires two distinct sources at `f >= p_solid` and `f <= p_empty`
respectively (OB-INV-02). A single source can never reach it. `PARTIAL` is
the complement of `SURFACE` and `OBSERVED_EMPTY`, closing a combination the
three literal band definitions jointly miss (zero hits with a pass count
under `n_min`).

`isVoxelAddressed` (O5) reads a station's declared domain as a spherical
azimuth/elevation band plus an optional `[minRange, maxRange]`, evaluated
against the voxel centre in the station's own Float64 frame; it does not
consult `acquisitionCoverage`'s fitted per-cell parameterisation, since that
module's own output is not itself a closed test of "does this direction lie
inside the source's addressed domain" for an arbitrary point, only a per-cell
lookup. A voxel exactly at a station's own origin is treated as addressed by
definition (no azimuth/elevation is defined there). `classifyObservationField`
classifies every cell of the declared domain grid, not only the ledger's
touched rows, so `insideDomain` is always `true` for it; `OUTSIDE_DOMAIN` is
never produced by this phase's code, only by the exhaustive lattice test.

#### Parameters

`p_solid = 0.9`, `p_empty = 0.1`, `n_min = 5`, preregistered in
`validation/protocols/observatory/OB-ST-THRESHOLDS.protocol.json` before any
fixture was scored (OB-ST-02).

#### Failure modes

None at the function level. It is total over its declared input domain, and
the oracle-comparison test covers the domain exhaustively. `isVoxelAddressed`
throws on a non-finite range (a NaN or infinite station origin or voxel
centre), per F17.

#### Determinism

Pure function. No floating-point reduction order to fix.

## `olv.observation.strength`

#### Status

Implemented in v0.7 (phase O6): `strength.ts` computes all five §2.5
components and the OB-STR-02 composite. Not yet wired into a run record, the
panel or any presentation surface (O7/O9).

#### Phase

O6 (strength components).

Computes, per `SURFACE` voxel: `sources` (distinct sources with `hit > 0`,
read straight off an `ObservationLedgerRow`'s own `perSource`, no per-ray
geometry needed), `angularSpread` (one minus the norm of the mean unit ray
direction of the hitting rays), `incidence` (median `cos i` between hitting
rays and the local surface normal, from `symEig3` over the voxel's resident
points or source normals when present), `rangeFit` (fraction of hits inside
the declared useful range band, the same `minRange`/`maxRange` concept
`StationAngularDomain` already declares, `observationField.ts`), and
`consistency` (the hit fraction `f`, `row.counters.hit / (hit + pass)`)
(SPEC §2.5 OB-STR-01).

`angularSpread`, `incidence` and `rangeFit` need per-hitting-ray direction
and range, which the ledger's own counters do not retain (only counts).
`accumulateStrengthHitSamples` re-walks a chunk's rays with the SAME
clip/DDA/hit-window primitives O4's `accumulateReturnedRay` uses
(`clipRayToDomain`, `traverseVoxelSteps`, `computeHitWindows`/
`stepOverlapsAnyWindow`, extracted from `ledger.ts` in this phase for exactly
this reuse, a behaviour-preserving extraction, not a second, independently
derived hit rule) and records ONE sample per voxel step that overlaps ANY of
the ray's own return windows, mirroring `accumulateReturnedRay`'s own
one-hit-per-step rule exactly, over every declared return, not only the
ray's first one. A voxel hit only by a pulse's 2nd (or later) return, the
ground-under-vegetation case, is sampled correctly: `resolveRayReturnRanges`
(also extracted from `traverseRayChunks`'s own per-ray CSR lookup) resolves
every return in a multi-return ray via its `returnTable`/`returnCounts`, so
a voxel's strength-sample count always equals its ledger `hit` counter
(before saturation), for every voxel, not only ones hit by a ray's primary
return; `tests/observatoryStrength.test.ts` checks this invariant directly
over both a single-return (F1) and a real multi-return fixture. When a step
overlaps more than one return's window, the sample's own range is the
FIRST (lowest `returnIndex`) overlapping return, matching the same
left-to-right evaluation order `stepOverlapsAnyWindow` itself uses.
`incidence`'s normal, when fit from resident points, uses
`fitNormalFromResidentPoints`'s own local `symEig3` covariance fit (the
smallest-eigenvalue eigenvector), reimplemented locally in `strength.ts`
rather than imported from `src/classification/geometryDescriptors.ts`'s
equivalent, to keep `src/observation`'s own dependency surface to
`src/math` alone.

#### Assumptions

Every component is independently bounded to `[0, 1]`, except `sources`
itself (an unbounded integer before the saturating map) and any component
returned as `NaN` when there is no evidence to form it (no hitting-ray
sample at all, or `hit + pass = 0` for `consistency`, or no normal supplied
for `incidence`). `NaN` here means "not computable from present evidence",
never zero. `sources` enters through a declared saturating map; SPEC's own
worked example, `min(sources, 3) / 3`, is `SOURCES_SATURATION_CAP_EXAMPLE` /
`saturatedSources()` in `strength.ts`, overridable per caller and recorded
beside the composite's weights when it is. `computeStrengthComposite`
excludes a `NaN` component from both the weighted sum and the weight total,
so a partially-evidenced voxel still yields a mean over what is actually
known, not a mean that silently treats missing evidence as zero. A composite
index is only ever returned bundled with its own weights and the raw
components (OB-STR-02, falsification checklist §9.3's last item):
`computeStrengthComposite`'s return type makes a composite without them
unrepresentable.

#### Parameters

`StrengthCompositeWeights`, once declared by a caller. SPEC does not fix
them itself. `StrengthRangeBand.minRange`/`maxRange` (`rangeFit`'s declared
useful range band) likewise comes from the caller, typically a station's own
`StationAngularDomain` fields; either bound omitted means unbounded on that
side (`rangeFit = 1` for every hit). `sourcesSaturationCap` defaults to
`SOURCES_SATURATION_CAP_EXAMPLE` (3).

#### Failure modes

`saturatedSources` throws on a non-positive cap. `fitNormalFromResidentPoints`
returns `null` (not a fabricated normal) for fewer than 3 resident points, or
a collinear/coincident neighbourhood with no well-defined second eigenvalue
(checked relative to the largest eigenvalue, not an absolute threshold).
Every other function here is total: a voxel with no hitting-ray sample
yields `NaN` components rather than throwing or defaulting to zero.

#### Determinism

`accumulateStrengthHitSamples` returns a plain array per call, with no
shared mutable state; `mergeStrengthHitSamples` concatenates partitions' own
sample arrays in the caller's own order (ascending partition index, matching
F9's own reading), and `computeStrengthComponents`'s direction-sum and
median reductions walk that merged array once, in that fixed order, so
results are reproducible across chunk order and partition count for the same
underlying evidence (OB-INV-07), confirmed directly against a real,
partition-split F1 chunk in `tests/observatoryStrength.test.ts`.

## `olv.observation.shadow-frontier`

#### Status

`SHADOWED_s` (`behind_s > 0`, `hit_s = 0`, `pass_s = 0`, inside `s`'s
addressed angular domain) is `deriveObservationState`'s own rule, already
implemented and tested at O1/O5 (`olv.observation.states`, above). This
method's own new code is the frontier walk: `computeShadowFrontier`
(`src/observation/shadowFrontier.ts`), a 6-adjacency test over a classified
field's `stateByKey` map, scored against an independent Python oracle
(`validation/observatory/oracle/shadow_frontier.py`) over an explicit 5x3x1
grid built to exercise every adjacency kind separately and several
non-adjacent neighbour states (`tests/observatoryFixturesO5.test.ts`).

#### Phase

O5 (states, conflict, shadow, frontier).

Computes, for source `s`, `SHADOWED_s` voxels (`behind_s > 0`, `hit_s = 0`,
`pass_s = 0`, inside `s`'s addressed angular domain, SPEC §2.4), and the
shadow frontier: the set of `SURFACE` or `OBSERVED_EMPTY` voxels 6-adjacent
to a `SHADOWED`, `UNADDRESSED` or `NO_RETURN_PATH` voxel (OB-SH-01).

#### Assumptions

Computed on the aggregate field and on any isolated source: `computeShadowFrontier`
reads only whatever `stateByKey` map it is given, so "aggregate" vs.
"isolated to source s" is entirely a fact about which `classifyObservationField`
call produced that map, not something the frontier walk itself distinguishes.
A voxel shadowed from source A and seen by source B carries the aggregate
state that source B supplies. Isolating source A alone still shows A's own
shadow there. A neighbour outside the classified grid's own bounds is
treated as absent, never as wrapping to the opposite edge or as any assumed
state.

#### Parameters

None of its own beyond the ledger's voxel edge `h`, which sets the area
estimate `h` squared per exposed face (OB-SH-02, `areaSquareMetres` in
`shadowFrontier.ts`'s `ShadowFrontierResult`, withheld to `null` when the
linear unit is unknown, OB-INV-10). `exposedFaceCount` (a face, not a voxel,
per qualifying neighbour) is the quantity the area multiplies, not the
frontier voxel count itself, since one frontier voxel can be adjacent to more
than one qualifying neighbour.

#### Failure modes

None at the function level: it is a pure read over a caller-supplied map and
grid shape, with no invalid-input branch of its own beyond what `stateByKey`
and `grid` already constrain.

#### Determinism

Adjacency is a deterministic geometric rule; iteration order over the input
map does not affect the accumulated counts (each qualifying neighbour is
counted independently of visit order). F1 through F7 and F17 score the state
layer this frontier walk consumes; the frontier walk itself is scored
directly against the Python oracle above.

## `olv.observation.coverage-gain`

#### Status

Not implemented in v0.7.

#### Phase

O10 (Coverage Gain and station suggestion).

For a candidate station `c` on a user-declared instrument model, traverses
planning rays against the ledger and scores each one by the declared
per-state weights, the incidence term, and a redundancy penalty for
already-strong voxels revisited (SPEC §5.6 OB-GAIN-03). Named Coverage Gain
because it counts voxels a hypothetical station would newly address. It is
not an information-theoretic quantity and is never named as one.

#### Assumptions

The instrument model (height above a standing surface, minimum and maximum
range, vertical field of view, planning angular step, or "same as source N")
is user-declared and recorded in full. No manufacturer table is consulted
(OB-GAIN-01, `ObservationInstrumentModel` in `coverageGain.ts`). Candidates
are generated deterministically on a declared grid over `SURFACE` voxels
near-vertical and clear above to instrument height, capped, with ties broken
by candidate index (OB-GAIN-02).

#### Parameters

Per-state weights: `SHADOWED` 1.0, `UNADDRESSED` 1.0, `NO_RETURN_PATH` 0.25,
`CONFLICT` 0.5, weak `SURFACE` 0.5, others 0 (`DEFAULT_GAIN_STATE_WEIGHTS` in
`coverageGain.ts`). Also the redundancy weight, and the candidate-grid
spacing and cap.

#### Failure modes

Planning on a field with authority below `measured` is labelled preview.
`NOT_READ` voxels get weight 0, and the panel reports how many there were
(OB-GAIN-05).

#### Determinism

The candidate grid and tie-break rule are both fixed functions of their
inputs (F11: a candidate behind a wall outranks one beside the source, every
term matching the oracle).

## `olv.observation.station-suggestion`

#### Status

Not implemented in v0.7.

#### Phase

O10 (Coverage Gain and station suggestion).

Runs greedy sequential selection. After picking the best-scoring candidate,
its planned visibility is applied to a hypothetical copy of the ledger,
never the canonical one, and every remaining candidate's gain is
recomputed, repeated for a user-declared number of stations (SPEC §5.6
OB-GAIN-04).

#### Assumptions

Every suggested station is labelled "SUGGESTED STATION (not observed)"
everywhere it appears: panel, 3D view, exports, session files. It never
enters the evidence ledger (OB-INV-05). SPEC defines, for v0.7, only the
`ReachabilityProvider` interface (`reachable`, `unreachable` or `unknown`,
each with an evidence reference) with no implementation behind it
(OB-GAIN-06). `stationSuggestion.ts` transcribes that interface, and the
panel offers no "reachable" mode until a provider carrying recorded evidence
is registered.

#### Parameters

The declared station count for one greedy run. Otherwise inherits Coverage
Gain's parameters, since it scores candidates the same way.

#### Failure modes

Not yet applicable. The canonical ledger is asserted unchanged by the search
once F12 can be scored (O10).

#### Determinism

Given a fixed candidate order and a fixed ledger snapshot, the greedy order
is a deterministic function of both (F12: a second suggestion covers the
first's residual shadow, and the canonical ledger is unchanged).
