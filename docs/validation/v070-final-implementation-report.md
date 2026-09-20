# Continuity Field: final implementation report

Read the measured sections as measured and the rest as absent. Where a figure
was not taken, the row says so rather than carrying an estimate.

## Renderer identity

| | |
| --- | --- |
| Version | 0.7.0-alpha.1 |
| Commit | `13605af8` on `release/v0.7.0-program` |
| Backend support | WebGPU and WebGL 2, with one measured difference in the history depth surface |
| Continuity Field status | Present, disabled, unreachable at runtime. It has never drawn a frame |

## Streaming culling

Written and unwired. `nodeFrustumCulling.ts` has no importer and
`continuityNodeCulling` has no consumer, so resident, visible and submitted
node counts are unchanged from the shipping scheduler and no GPU time was
measured before or after.

## GPU attribute packing

Unimplemented. The flag is false in all four of its occurrences.

Current upload, which is the "old" column a packing step would improve on:

| Attribute | Components | Bytes |
| --- | --- | --- |
| `aPos` | 3 × f32 | 12 |
| `aColor` | 3 × f32 | 12 |
| `aClass` | 1 × f32 | 4 |
| `aIntensity` | 1 × f32 | 4 |

Thirty-two bytes per point with both optional channels, twenty-four without.
No new figure, no savings, no upload-time delta. Semantic parity is the one
part with a result: classification survives the float attribute exactly to
2^24, which a test pins.

## Coverage sizing

The one capability that ships wired.

| | |
| --- | --- |
| Static strategy | Per-point size from a local density grid, keyed on the cloud's two widest axes |
| Streaming strategy | Per-node scale from the resolution a node was recorded at, relative to the root |
| Facade behaviour | Keying on the widest two axes rather than x and y. On a 20 m by 12 m facade the earlier x/y grid put every point on a clamp |
| Terrain behaviour | Unchanged. Density values are not affected; only display size is |
| Overdraw change | Not measured directly. Mean frame energy on a streamed source rose from 69.75 to 82.08 with density sizing selected, returning to exactly 69.75 on switching back. Read from a live session with no artifact retained, so not reproducible from this repository |

## Temporal accumulation

| | |
| --- | --- |
| Phase count | 4 by default, from 2, 4 or 8. Powers of two, so a phase selects with a mask and the partition arithmetic is exact |
| Deterministic partition | A function of point identity and node seed with no frame number in it, reusing the existing `fadeHashUnit` rather than adding a second hash |
| Settle time | Not measured. Convergence is counted in frames, and how long a frame takes is a property of a device none of this ran on |
| History invalidation | Any epoch change returns the state to idle and the sweep restarts at phase 0. Converged is terminal while the epoch holds |
| GPU cost | Not measured |

## Micro-gap closure

| | |
| --- | --- |
| Radius | One pixel. Four cardinal neighbours, no diagonals |
| Depth threshold | A ratio in log2 units, 0.02, admitting depths within about 1.4 per cent. A starting value, not a measured one |
| Final coverage gain | On the corpus's sparse plane, 64 direct pixels became 176 drawn of 225. See the note below |
| Edge leakage | Zero across the corpus. The silhouette seam stays empty and a hole two or more pixels wide fills nothing |
| Unsupported reconstruction rate | Zero. Every fill takes a depth one of its own direct neighbours had |

The coverage figure needs its caveat stated rather than buried. That fixture
samples every other pixel on both axes, which is far sparser than any real
splat size produces, so its reconstructed share works out at 63.6 per cent of
drawn pixels and would fail the 20 per cent ceiling the census defines. The
share is a property of the fixture rather than a result about scans.

## Evidence Lens

| | |
| --- | --- |
| Raw view | Hard-edged. Reconstruction stops at the outer edge of the feather, not at the radius |
| Picking parity | Structural. A fill decision carries a depth and a support kind and no identity, so nothing can resolve one to a point |
| Measurement parity | Structural, by the same property, and held by the authority guards rather than by the lens |
| Touch and keyboard | Both work. A source that does not report a position continuously pins the lens where the viewer put it, and a keyboard lens opens at the viewport centre |

## Browsers

No matrix exists for Chromium, Firefox and WebKit. One Chromium instance was
probed for capability and the result is in `validation/renderer-capability/`:
on an Apple M3 Max it reports a WebGPU adapter, and a WebGL 2 context whose
`EXT_color_buffer_float` is present and whose R32F framebuffer reports complete.
Both reach the `full` rung on that machine. A capable laptop is the case the
tier ladder is least needed for, so this narrows nothing about weak devices.

One backend fact was measured on both: the history depth surface is renderable
unconditionally as `r32float` on WebGPU and needs `EXT_color_buffer_float` on
WebGL 2, where its absence makes the framebuffer incomplete rather than slow.
The tier ladder absorbs that by dropping to the rung that keeps no history.
Coverage sizing rendering under WebGL 2 has no device evidence.

## Mobile

No device or emulation was tested. Touch-first hardware is capped at coverage
sizing, which reconstructs nothing and keeps no history, and the cap lifts only
on measured frame evidence for a device class somebody benchmarked. Memory
behaviour and fallback behaviour are pure-tested and unobserved.

## Scientific parity

Zero unintended changes, which is the expected result. Four categories moved
and every one traces to a separately scoped bug fix rather than to renderer
work.

| Category | Change |
| --- | --- |
| Measurement, terrain geometry, contours, stockpile | None |
| Classification | Labels are format-aware, since ASPRS redefines classes 8 and 12 between the legacy and extended point formats |
| Terrain boundary share | No longer counts a display stride's interior gaps as survey edge: 33 per cent full decode against 100 per cent strided, same ground |
| Exports | GPS time written under the type its source declares; classification flags survive decode |

## Performance

No golden camera case was measured. Baseline, moving and converged GPU
milliseconds, framebuffer megabytes, final coverage, temporal variance and
settle time are all absent for the same reason: the field has never rendered.

The record format for these figures exists and is enforced. A benchmark that
omits any corpus scene is refused, so the eventual numbers cannot be taken from
the flattering scenes only.

## Architecture

| Metric | Base `31381ad6` | Head `13605af8` |
| --- | --- | --- |
| Files under `src/` | 842 | 867 |
| Dependency cycles | 0 | 0 |
| `Viewer.ts` lines | 6222 | 6215 |
| `Viewer.ts` runtime fan-out | 77 | 77 |
| Continuity subsystem | absent | 19 files, 2513 lines |
| Subsystem external fan-out | absent | 5 modules |
| Eager bundle | 803 KiB | 806 KiB |

The subsystem reaches outside itself five times: `numeric`, `adaptiveDpr`,
`refinementPhase`, `fadeDither` and `streamingBudget`. Each is an existing
signal it consumes rather than a parallel one it built.

## Limitations

A roof ridge closes on depth alone. Two slopes either side of a fold are nearly
equidistant from the camera, so depth cannot tell the fold from a gap. Normals
refuse the fill where a file supplies them, and LAS never does.

Six thresholds are shapes rather than calibrations, each saying so where it is
defined: the depth tolerance, the reconstruction share ceiling, the
coverage-need spacing, the minimum coverage factor, the phase count and the
history byte ceiling.

Coverage sizing has no WebGL 2 render evidence.

The export capture guard is written and unwired. Every Studio exporter renders
to the live canvas and four raster modes encode geometry in their pixel values,
so this has to be wired before the first capability that can reconstruct.

The corpus is synthetic, and its limit is worth stating precisely rather than
as a disclaimer. It exercises the rules a shader would mirror, so it catches a
rule that would produce a defect however faithfully it were drawn, which is the
cheaper half of the problem and the half findable without a device. It cannot
catch the other half. A shader that departs from a correct rule, a driver that
rounds a depth comparison differently, a framebuffer format that behaves unlike
its specification: none of those are visible to a test that never reaches a
GPU. Two of the corpus assertions were also vacuous when first written and
passed for reasons unrelated to their claims, which is the failure mode this
kind of testing invites and the reason each rule here was probed by breaking
it.

Nothing here has run on a phone, a tablet, or any browser with a GPU adapter.

## Final verdict

**CONTINUITY FIELD NOT READY FOR v0.7**

No blocker was reproduced, and the instruction for this verdict is to list only
the reproduced ones, so the list is empty. That is not the same as passing.

Nothing was reproduced because nothing ran. Fourteen conditions were examined:
seven are held shut by a named test or cannot occur at all, five wait on
hardware that was never available here, one is an ordering constraint on the
first wiring, and one is a gap in evidence. A feature that has never drawn a
frame cannot be released as stable on the strength of its unit tests, however
many of them pass, and 16,293 passing tests are a statement about rules rather
than about a picture. The five conditions Phase 56 sets for making the field a
default are the same five that are unmeasured, so the verdict follows from the
programme's own gate rather than from a judgement about quality.
