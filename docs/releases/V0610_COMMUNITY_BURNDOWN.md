# v0.6.10 community burndown

Inherited defect and limitation register for the v0.6.10 stabilization cycle.

## Baseline

v0.6.9, tag `v0.6.9`, commit `c164e907f50ff49da7233385d92285c53dfb3b8d`.

Five commits sit on top of that tag. One records the version DOI and the rest
are dependency and CI work. None of them touch `src/`, so this cycle starts from
the behaviour of the tag itself.

## How to read this register

Each entry carries a Rule Zero class and a disposition.

Class A is a reproduced defect. B covers standards and scientific correctness,
C lifecycle and resource ownership, D compatibility. E is a small near-complete
capability. F is an expansion this cycle defers.

Disposition is one of FIXED, PARTIALLY FIXED, INTENTIONAL LIMITATION, DEFERRED
or NOT REPRODUCIBLE.

An audited entry gets its disposition when the work lands, not before. Until
then Status reads OPEN. An OPEN entry says nothing about how it will end.

Reproduction records how the entry was established. READ means confirmed
against the shipped source. DOC means carried from a published v0.6.9 document.
TEST means a failing test exists.

## Register

| ID | Source | Subsystem | Description | Class | Sev | Repro | Status | Disposition |
|---|---|---|---|---|---|---|---|---|
| B01 | READ `src/convert/writeLas.ts:478` | export | The LAS 1.2 write masks classification with `0x1f`, so a class above 31 wraps to another valid class. `convertCloud.ts:287` counts the affected points first and warns with the exact arithmetic, naming LAS 1.4 as the remedy, so the loss is reported rather than silent. Section 7 asks for refusal by default, which is the remaining gap. | B | med | READ | OPEN | |
| B02 | READ `writeLas.ts:479`, `globalPoints.ts:17` | model, export | Scan angle rank is written as a constant zero because `GlobalPoints` has no scan angle field. This is a model gap, not a writer defect. | B | med | READ | OPEN | |
| B03 | READ `writeLas.ts:480`, `globalPoints.ts:17` | model, export | User data is written as a constant zero because `GlobalPoints` has no user data field. Same cause as B02. | B | med | READ | OPEN | |
| B04 | READ, 8 modules | ui, export, render | ASPRS class names are defined independently in `main.ts`, `MeasurePanel.ts`, `Inspector.ts`, `panelChrome.ts`, `DesktopWorkspace.ts`, `pointInfo.ts`, `colorModes.ts` and `ExportLegendRenderer.ts`. There is no single semantics source. | B | high | READ | OPEN | |
| B05 | DOC limitations | measure, export | The canonical stockpile record is not integrated. The lasso toast reports the area-grid estimate while the session, report and CSV hold the point-sample record, so the two can disagree for one lasso. | E | high | DOC | OPEN | |
| B06 | DOC limitations | analyse, report | Analyse ground density derives from the resident gather and the Scan Report back-scales to the declared count. The two disagree by roughly the stride factor. | B | high | DOC | OPEN | |
| B07 | DOC limitations | terrain | Boundary share seeds its search from every non-measured cell, so on a sparse tile most of what it reports as boundary is stride gap. | B | high | DOC | OPEN | |
| B08 | DOC limitations | measure | The principal-component oriented bounding box overstates length on an elongated footprint. It is labelled unvalidated rather than presented as a measurement. | B | med | DOC | OPEN | |
| B09 | DOC limitations | render | `NavBar.dispose` has no caller. | C | med | DOC | OPEN | |
| B10 | DOC limitations | render | `ViewerRenderCore` has no dispose seam. | C | med | DOC | OPEN | |
| B11 | DOC limitations | ui | Between 768 and 1000 px two open rails leave no top-centre gap wider than the project card, so a card and a chip cannot both sit there. | D | med | DOC | OPEN | |
| B12 | DOC limitations | ci | Pinch, rotate and two-finger gestures run end to end on Chromium only. WebKit and Firefox skip those specs because the harness cannot grant the permission they read their result through. | D | med | DOC | OPEN | |
| B13 | DOC limitations | ci | Firefox, WebKit and Windows are advisory. Only Chromium blocks a release. | D | med | DOC | OPEN | |
| B14 | DOC limitations | render | For far-apart mounts the renderer does not fold `renderOrigin` out on the CPU per mesh, so the Float32 residual on the GPU is larger than it needs to be. The mount-precision gate refuses any placement past 1 mm. | B | low | DOC | OPEN | |
| B15 | DOC unreachable register | registration | The registration stack ships and no user path reaches it. The register lists 36 modules, 20 staged, 15 validation-only and 1 reference-only. | F | n/a | DOC | OPEN | |
| B16 | DOC unreachable register | provenance | `scientificArtifactPassport` ships and is unreachable. | E | n/a | DOC | OPEN | |
| B17 | DOC unreachable register | evidence | `evidenceBoundaryInspector` ships and is unreachable. | E | n/a | DOC | OPEN | |
| B18 | DOC unreachable register | terrain | `dtmProductDigest` ships and is unreachable. | E | n/a | DOC | OPEN | |
| B19 | DOC limitations | classify | The ground filter sits near an F1 of 0.5 on the mountain scenes and near 0.34 precision under dense canopy, against external reference labels. | B | known | DOC | OPEN | INTENTIONAL LIMITATION |
| B20 | DOC limitations | geo | No cross-CRS reprojection. Scans must share a reference system to be compared, and the viewer refuses rather than approximating. | B | known | DOC | OPEN | INTENTIONAL LIMITATION |
| B21 | READ | standards | No CityGML or LoD terminology appears anywhere in `src/` or `docs/`. The spec treats this as a defect to correct; there is nothing to correct. A lint is still justified to keep it that way. | B | n/a | READ | OPEN | NOT REPRODUCIBLE |
| B22 | READ | io | `lasDecodeShared.ts:46` and `eptLaszipDecode.ts:342` already select `0xff` for extended formats and `0x1f` for legacy. The decode side reads extended classes correctly. | B | n/a | READ | OPEN | NOT REPRODUCIBLE |
| B23 | READ, whole tree | io, model | Classification flags are never decoded. `synthetic`, `keyPoint` and `withheld` appear nowhere in `src/` outside the semantics module added this cycle. Sections 6 and 8 are therefore new capability across the decoders, the point model, the workers and the writers, not repair of an existing path. | F | high | READ | OPEN | |
| B24 | READ `writeLas14.ts:618` | export | The extended writer already writes the full 8-bit classification and its comment names the 5-bit clamp it avoids. No correction is needed on the extended path. | B | n/a | READ | OPEN | NOT REPRODUCIBLE |

| B25 | TEST `lint:evidence` | release | Adding any test while `package.json` still reads 0.6.9 turns the next gate red. The lint checks the published v0.6.9 release documents against the current evidence figures, and those documents correctly record what v0.6.9 ran. The unit bucket moved from 9,488 to 9,526 this cycle, so the three v0.6.9 documents now disagree with the tree. Neither editing them nor bumping the version is available: the first alters published release documentation and would state something false about v0.6.9, the second is gated on testing. | A | high | TEST | OPEN | |
| B26 | READ ASPRS Table 9 note 3 | io, terrain | The specification says the Withheld bit should generally be set on legacy Overlap Points, since they are culled during flight-line merging. OLV discards Withheld, so a conforming producer's excluded points enter terrain, density and stockpile as ordinary returns. This raises B23 from a missing capability to a data-integrity defect. | B | high | READ | OPEN | |

## Constraints carried into this cycle

These are not defects. They bound what the cycle may do.

The eager bundle measures about 803 KiB against an 812 KiB ceiling. New shell
work goes behind a lazy seam. The ceiling does not move for standards logic.

`src/main.ts` at 4,977 lines and `src/render/Viewer.ts` at 6,223 are shrink-only
under a lint. Fan-out is 112 for the shell, 77 for the renderer and 23 for the
Analyse panel.

The claim register holds 34 claims: 2 at E1, 6 at E2, 9 at E3 and 17 at E4.
Standards corrections do not promote any of them.

The ground filter is not to be tuned against its current benchmark numbers.

## Not yet audited

These areas have no register entry yet because reproduction has not been
attempted.

LAS version and PDRF matrix coverage. LAS 1.5 support scope. ASPRS 2024
accuracy terminology. Transactional dataset open. Cancellation. Range and
remote loading robustness. The parser fail-closed surface.

Each gets an entry once it is reproduced or cleared.
