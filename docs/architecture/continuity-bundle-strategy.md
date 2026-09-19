# Continuity Field bundle strategy

Measured on `8631e6dc` with the live build, in a throwaway worktree. The eager
entry chunk has a 812 KiB ceiling and the budget script warns from 700.

## What each arrangement costs

| Arrangement | Entry chunk | Against the ceiling |
| --- | --- | --- |
| Today, nothing imported | 805 KiB | 7 KiB under |
| Decision modules eager, as written | 814 KiB | over |
| Decision modules eager, without the `adaptiveDpr` import | 812 KiB | exactly at it |
| Whole subsystem eager | 835 KiB | 23 KiB over |
| Whole subsystem lazy | 805 KiB | 7 KiB under |

The decision modules are `continuityField`, `continuityTier`, `historyBudget`
and `mobilePolicy`: the four that answer which rung a device can carry, before
any pass runs.

## The estimate was wrong, which is why it was measured

Those four are 8 KB of source, and 29 per cent of the subsystem's source is
code rather than documentation, so the expectation was three or four kilobytes
minified. The measurement is nine, and it fails the ceiling.

Two kilobytes of the nine are not the modules at all. `mobilePolicy` imports
two numeric constants from `adaptiveDpr`, which is a runtime import of a module
that otherwise lives in the lazy `Viewer` chunk. Importing the decision half
eagerly therefore hoists `adaptiveDpr` and its own imports out of that chunk and
into the shell, which is visible on both sides of the measurement: the entry
gains and `Viewer` drops from 726 to 724. Removing the import puts `Viewer` back
at 726 and the entry at 812.

The remaining seven kilobytes are the four modules, which is the whole margin.

## Everything is lazy, including the tier decision

The reason this is available is that the Continuity Field ships disabled. A
device that cannot carry the field renders exactly as it does today, so there is
no rung to choose before the first frame, and nothing to load before it either.

That distinguishes it from the Speed to Quality control, which the bundle budget
records as unavoidably eager: a weak device has to get its degraded display
settings on the first frame rather than on the first click, because those
settings change how the baseline renderer draws. The field only decides whether
to add something on top of a renderer that is already correct.

So the whole subsystem, decision half included, loads on first enable. Warming
it during an idle period after startup is then a scheduling question rather than
a bundling one, and it is what the phase suggests. The seam already exists:
`lazyChunks.ts` holds every dynamic import in one module that the live source
transform excludes, because that transform rewrites string literals and a
rewritten specifier stops Vite emitting the chunk at all. A continuity loader
belongs there beside `loadViewer`, not at its call site.

The `adaptiveDpr` import stays. It exists because the history ratio is quantised
onto the same grid the adaptive ratio snaps to, and duplicating two constants to
avoid a hoist would trade a real shared definition for a bundling convenience.
On the lazy side of the seam the hoist does not happen.

## What this does not answer

Startup time was not measured, only startup payload. A chunk that does not load
cannot slow a start, so the payload figure settles the phase's constraint about
not trading application start for parked rendering, but it says nothing about
what the field costs once a viewer turns it on.
