# v0.7 wiring baseline

The observed state of the tree before any wiring change, and what it says about
the hypotheses the wiring plan carries.

This is the document that plan calls `V070_WIRING_AUDIT.md`. It is named for
what it records rather than for its role, because `.gitignore` excludes every
`*audit*.md` in this repository alongside workplans and whitepapers, as a class
of internal working document that does not ship. The content here is
measurement and belongs with its siblings in this directory, so it takes a name
that lets it ship instead of a name that hides it.

## Build identity

| | |
| --- | --- |
| Version | 0.7.0-alpha.1 |
| Source archive | `openlidarviewer-v0.7.0-alpha.1-source-20260920-0000.zip` |
| Archive SHA-256 | `a39230ffa9cfb37de4c970005203603178cb1bed8bcc90831394ff796484f118` |
| Archive evidence commit | `6ce80c797d3adc87404067d074c3457d1f908086` |
| Working tree at audit | `3be654a8c919f7c03bed494c53c693e658e5d7fb` |

Two corrections to the stated baseline.

The archive digest matches exactly, so the archive is the one being described.
Its evidence commit is not the one stated: the plan says `6502aad2`, and
`docs/validation/test-evidence.json` inside the archive says `6ce80c79`. The
difference is one commit, the docs-only validation pass that followed the
final report, and the gate figures the plan quotes belong to the archive
either way.

The working tree has since moved past the archive by one commit, which added a
backend capability probe and the first real-device measurement. Anything below
describes the tree, not the archive, where the two differ.

## Measured state

| Metric | Value |
| --- | --- |
| Modules under `src/` | 867 (866 scanned by the graph lint) |
| Cycles | 0 |
| Reachable from `main.ts` | 814 |
| Registered unreachable | 53 (39 staged, 13 validation-only, 1 reference-only) |
| Unreachable counting runtime edges only | 142 |
| Disposal registry | 26 resources across 2 tables, each naming owner, lifetime and trigger |
| `Viewer.ts` | 6215 lines, runtime fan-out 77 |
| `main.ts` | 4977 lines, runtime fan-out 112 |
| Eager entry chunk | 806 KiB of an 812 KiB ceiling |
| `Viewer` lazy chunk | 726 KiB |
| Gate | 16,303 passed, 49 skipped |

## Hypotheses, checked

| Hypothesis | Verdict |
| --- | --- |
| ~866 modules, 0 cycles | Holds. 866 scanned, 0 cycles |
| 814 reachable, 52 registered unreachable | Reachable holds; unreachable is 53, the probe added after the archive |
| Disposal registry ~26 resources | Holds exactly |
| Continuity subsystem pure, no GPU benchmark records | Half stale. No benchmark record exists, and a device capability record now does |
| Six Continuity URL flags parse, not production-wired | Holds. They appear only in `devFlags.ts` and `metricsJson.ts` |
| Generic mesh path sets `frustumCulled = false` | Holds, at `Viewer.ts:1614` |
| Frame-count streaming cadence of 6 | Holds, `STREAMING_TICK_INTERVAL = 6` at `renderLoop.ts:34` |
| Metered commit wired but opt-in | Holds. Reached from `streamingAttach.ts`, selected by a flag whose default is the historical immediate path |
| Resident stickiness wired but opt-in | Holds. `devFlags.ts` records it OFF by default |
| DTM Scientific Artifact Passport live | Holds, in `terrain/export/demPackage.ts` |
| Withheld semantics preserved, not consistently excluded | Holds. `lasSemantics.ts` decodes the bit; no processing path filters on it |
| No authoritative renderer device-generation source | Holds. `deviceGeneration` appears only inside the continuity subsystem, which nothing calls |
| Export and display isolation unresolved | Holds, and it is the sharpest item. Every Studio exporter renders to the live canvas, four raster modes encode geometry in their pixel values, and the guard that would suspend reconstruction exists unwired |

## What this changes about the plan

Nothing in the plan is invalidated.

Two items move.

The device capability question the plan defers is already answered for one
machine. `validation/renderer-capability/device-capability-20260920.json`
records an Apple M3 Max under Chromium reaching the `full` rung on both
backends, with `EXT_color_buffer_float` present, an R32F framebuffer reporting
complete, and all three WebGPU history surfaces created and destroyed. Each was
exercised rather than queried, so the result records what the device did. It
describes capability, it is one machine,
and it is the machine class the tier ladder is least needed for, so it narrows
nothing about a weak Android or an older integrated GPU.

Phase C9, export isolation, is marked mandatory before default-on Continuity
and should be treated as mandatory before the first capability that can
reconstruct, which is earlier. Wiring it afterwards means some number of height
maps and depth maps carry invented elevations in the interval, and those files
outlive the interval.
