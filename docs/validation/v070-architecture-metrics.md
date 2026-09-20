# Architecture metrics, v0.7 continuity programme

Base `31381ad6`, head `7ae4064d`, 76 commits.

## Measurements

| Metric | Base | Head | Change |
| --- | --- | --- | --- |
| Files under `src/` (.ts) | 842 | 867 | +25 |
| Files under `src/render/` | 228 | 250 | +22 |
| Dependency cycles | 0 | 0 | none |
| `Viewer.ts` lines | 6222 | 6215 | −7 |
| `Viewer.ts` runtime fan-out | 77 | 77 | none |
| `Viewer.ts` import statements | 104 | 104 | none |
| `main.ts` runtime fan-out | 112 | 112 | none |
| Cross-directory runtime edges | 20 | 20 | none |
| Eager entry chunk | 803 KiB | 805 KiB | +2 KiB |
| `Viewer` lazy chunk | 725 KiB | 726 KiB | +1 KiB |
| `lazDecode` chunk | 614 KiB | 614 KiB | none |
| `eptLaszipWorker` chunk | 349 KiB | 350 KiB | +1 KiB |
| `copcWorker` chunk | 335 KiB | 335 KiB | none |
| Registered unreachable modules | 36 | 54 | +18 |

File counts come from `git ls-tree` at each revision, so both ends are counted
the same way. Cycles and fan-out come from `lint:module-graph`. Chunk sizes come
from `check-bundle-budget` after a live build at each end, the base one in a
throwaway worktree.

## No new renderer monolith

The render subsystem gained 22 files while `Viewer.ts` lost seven lines and
gained no imports. The work went into new modules rather than into the existing
one, which is what the constraint asks for and is the reverse of what a feature
of this size usually does to a renderer.

`Viewer.ts` remains far above its 2000-line goal at 6215.

The shrink-only ratchet holds it there, and this programme moved it the right
way by a small amount.

## Zero cycles

Zero at both ends, measured rather than assumed. `lint:module-graph` computes
strongly connected components of the static value graph on every gate run, 866
files were scanned at head, and a cycle appearing anywhere in that graph fails
the gate rather than being reported. The continuity modules import each other
freely and import upward into `adaptiveDpr` and `streamingLodSize`, so the
count staying at zero is a result rather than a formality: a subsystem of 19
files with shared vocabulary is where a cycle would ordinarily appear.

## Twenty-five modules for two kilobytes

The eager entry grew 2 KiB while the tree gained 25 files, because 18 of the 19
files under `src/render/continuity/` are unreachable from `main.ts` and the
bundler drops them. The 19th, `historyBudget`, is reached only by the debug
overlay. What did land in the eager chunk is the coverage-sizing wiring and the
class-semantics work, which are reachable by design.

The entry chunk was already at 803 KiB of its 812 KiB ceiling at the base, with
the budget script warning at 700. That pressure predates this programme. The
margin went from 9 KiB to 7 KiB, and the next eager feature will need a recorded
raise or a lazy seam whether or not it is related to this work.

## A measurement trap worth recording

`npm run build` and `npm run build:live` produce different bundles. On the same
head tree the plain build reports a 355 KiB entry and the live build 805 KiB,
and the budget is enforced against the live one. Comparing a base plain build
against a head live build would have shown a 450 KiB regression that does not
exist. Both ends here are live builds.

The gate itself runs a plain build after its live one, so the `dist/` left on
disk after a gate is not the artifact the budget measured. Reading chunk sizes
from a stale `dist/` gives the plain-build numbers.
