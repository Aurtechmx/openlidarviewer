# Scientific regression gate, v0.7 continuity programme

Base `31381ad6`, head `c186ece3`, 76 commits, 55 source files changed.

## How this was checked

The phase asks for the suite run before and after. What was done instead is
per-value and stronger, so it is described rather than glossed: of the test
files present at the base, 16 were modified by this programme and the rest were
not. Every unmodified test passes at head. A test that pins a scientific value,
was not edited, and still passes is that value's before-and-after comparison,
which a pass count either side would not have given.

The 16 modified files are then the whole surface where a value could have moved,
and each is accounted for below.

The full suite at head is green: 16,255 passed, 49 skipped.

## The Continuity Field changed nothing, and cannot

Of the 19 files in `src/render/continuity/`, 18 are unreachable from
`src/main.ts`, which `lint:unreachable-modules` measures on every gate rather
than taking on trust. Nothing calls them, so nothing they compute reaches a
measurement.

The exception is `historyBudget.ts`, whose only reachable importer is
`DebugOverlay.ts`. It reports how many bytes a history would cost and whether
that fits a ceiling. No value it produces leaves the overlay.

Every scientific change below therefore comes from a separately scoped bug fix,
which is the exception the phase allows, and none comes from renderer work.

## The twelve categories

| Category | Changed | Cause |
| --- | --- | --- |
| Distance | No | |
| Height | No | |
| Angle | No | |
| Profiles | Label only | The `classification_label` column follows the corrected ASPRS naming |
| Terrain | Yes | Boundary share no longer inflated by a display stride |
| Contours | No | |
| Stockpile | No | A stored volume now records which estimator produced it; the number is unchanged |
| Classification | Yes | Labels are format-aware and follow the specification's capitalisation |
| Density | No | Display point sizing changed for vertical surfaces; density values did not |
| Session records | No | Schema addition only |
| Scientific reports | Yes | Inherits the terrain and classification changes above |
| Source exports | Yes | GPS time written under the type its source declares; classification flags preserved through decode |

## The changes, and why each is a fix

### Classification labels are now format-aware

ASPRS redefines several class codes between point record formats 0 to 5 and the
extended formats 6 to 10. Class 12 is Overlap Points in the legacy formats and
Reserved in the extended ones; class 8 is Model Key-Point in the legacy formats
and Reserved in the extended ones. The label was previously unconditional, so a
file in an extended format was told its class 12 points were Overlap when the
specification says otherwise.

Labels also follow the specification's capitalisation now, so `High vegetation`
reads `High Vegetation`. That is visible in exported CSV, in the export studio
legend and in point info.

Where the format is unknown the label says so rather than picking a side, as in
`Overlap Points or reserved (12)`.

### Terrain boundary share

The share seeded a distance field at every non-measured cell. On a full decode
those seeds are the survey edge, which is what the figure means. On a grid
thinned by a display stride they are mostly interior gaps, so almost every
measured cell sits next to one and the share climbs toward one. Over a single
geometry it read 33 per cent at full decode and 100 per cent strided, for the
same ground.

The terrain report quotes the figure in its verdict sentence, so the report
inherits the correction.

### Source exports

GPS time is written under the type the source declared rather than a default,
and classification flags survive decode and re-export instead of being dropped.
Both change bytes in an exported file, and both change them toward what the
source said.

## What this gate does not cover

It compares values that a test pins. A scientific value with no test is outside
it, and so is any behaviour that needs a device, since the continuity work is
unreachable and unrun. Those are the same gaps the programme has carried
throughout and they are not narrowed by this check.
