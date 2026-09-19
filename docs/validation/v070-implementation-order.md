# Implementation order, where each step stands

Twenty-five steps in seven groups. Status at `34758e7c`, after 84 commits on
`release/v0.7.0-program`.

## The short version

Two steps are wired into the product and reach a user.

Fifteen exist as tested pure cores that nothing calls, five need hardware this
project does not have, and three are unimplemented. Counting a pure core as
progress is a judgement worth stating rather than assuming: each one is a
decision with its reasoning and its tests, and none of them draws a pixel. A
reader who wants the number that describes what a user gets should read the
first line and stop.

That distribution is the programme's real shape, and it is not the order below.
Groups C through F were designed before group A was finished, which would be
the wrong order if any of it were wired, since a core built on an unmeasured
foundation inherits whatever the foundation got wrong. None of it is wired, so
what exists is a set of decisions with their reasoning and their tests,
waiting for a device to justify switching any of them on, and the order they
were written in costs nothing as long as that stays true.

One thing the tables cannot show is why so many rows say the same words. A pure
core with no caller is the furthest this programme could honestly go on the
hardware available to it. Every capability here is gated on a measurement, the
measurements need a WebGPU adapter or a phone, and neither exists on any runner
this work had access to. Writing the core anyway was a choice about where to
stop rather than an accident of scheduling, and the alternative was to wire
something on a guess and find out later which guess was wrong. The register of
unreachable modules records each one with what would make it reachable, so the
stopping point is written down per module rather than implied by this summary.

## A. Low-risk performance foundation

| Step | Status |
| --- | --- |
| 1. Renderer baseline harness | Absent for frame time. `streamingBenchmark` measures streaming and is wired; nothing measures a frame under the field, because no runner has an adapter |
| 2. Real streamed-node frustum culling | Written and tested, no importer. The capability flag has no consumer either |
| 3. Accurate GPU memory accounting | Wired. `attributeBreakdown` and the history estimate both report in the debug overlay from real device-pixel dimensions |
| 4. Packed GPU attributes | Unimplemented. The flag exists and is false in all four of its occurrences |

## B. Source presentation quality

| Step | Status |
| --- | --- |
| 5. Coverage-aware point sizing | Shipped and wired. Measured on a streamed source: mean frame energy 69.75 to 82.08 on selecting density sizing, returning to exactly 69.75 on switching back |
| 6. Point-kernel re-benchmark | Not run. Needs a device |

## C. Continuity core

| Step | Status |
| --- | --- |
| 7. Display epoch | Pure core, tested, unwired |
| 8. Stable temporal phases | Pure core, tested, unwired. The partition is a function of point identity with no frame number in it |
| 9. Parked-camera phase scheduler | Pure core, tested, unwired. Converged is terminal for as long as the epoch holds |
| 10. Depth-locked accumulation | Pure core, tested, unwired. Categorical colour never blends |

## D. Visual reconstruction

| Step | Status |
| --- | --- |
| 11. Depth-coherent micro-gap closure | Pure core, tested against the scene corpus, unwired |
| 12. EDL integration | Not started. EDL ships and already traces every depth discontinuity; nothing connects the two |
| 13. Continuity support tracking | Pure core, tested, unwired |

## E. Signature interaction

| Step | Status |
| --- | --- |
| 14. Evidence Lens | Pure core, tested, unwired. Placement works from touch and keyboard as well as a pointer |
| 15. Raw-point picking parity | Held structurally and tested. A fill decision carries no identity, so there is nothing for a picker to resolve |

## F. Platform hardening

| Step | Status |
| --- | --- |
| 16. WebGPU and WebGL 2 parity | Measured for the history depth surface and absorbed by the tier ladder. Coverage sizing has no WebGL 2 render evidence |
| 17. Streaming refinement integration | Pure core, unwired. Convergence consumes the existing refinement phase rather than deciding again |
| 18. Mobile and device-tier fallback | Pure core, tested, unwired. Touch-first is capped at coverage sizing |
| 19. Lifecycle and device-loss recovery | Pure core, tested, unwired. History surfaces are keyed on a device generation |

## G. Proof

| Step | Status |
| --- | --- |
| 20. Benchmark corpus | Schema and verifier built and wired into the release chain. Zero records |
| 21. Quality metrics | Built. Support census, reconstructed share, and a ten-scene corpus covering the five defect classes |
| 22. Scientific regression | Done. Four of twelve categories moved, each from a separately scoped bug fix, none from renderer work |
| 23. Browser matrix | Not run. No phone, tablet or WebKit device, and no adapter on any runner here |
| 24. Documentation | Done |
| 25. Final release gate | The blocker register is written and the gate runs green. The release decision is not this programme's to take |

## On the instruction not to accumulate one giant diff

Eighty-four commits, each gated before it was pushed, with the literal gate
exit read rather than the wrapper's, because the two have disagreed in this
repository. Gate failures were fixed before the push rather than after it, and
the ones in the recent stretch were a module-graph edge that grew, two stale
size cells in the architecture map, and a reachability register that had to
lose two entries. No count is given for the whole branch, since the earlier
stretch is not reconstructable from the log. Three probe builds ran in
throwaway worktrees and the working tree was checked clean afterwards, so no
measurement scaffolding reached a commit.

## What the order says to do next

The sequence assumes wiring follows design, and nothing has been wired since
coverage sizing.

Whatever is switched on first carries one prerequisite from outside this list:
the export capture guard. Every Studio exporter renders to the live canvas and
four raster modes encode geometry in their pixel values, so the guard that
suspends reconstruction for those four belongs before the first capability
that can reconstruct rather than after it. Wiring it afterwards means some
number of height maps and depth maps carry invented elevations in the interval,
and those files outlive the interval.
