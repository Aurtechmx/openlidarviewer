# Documentation index

`docs/` holds 166 files. This page is a curated route through them, not a
complete listing. It points at the documents a reader usually wants first, and
at the directories that hold the bulk collections (release records, validation
evidence, audit reports) rather than naming every file inside them. Where a
group ends in a directory link, that directory is the authority and this page is
only the doorway to it. Nothing here is generated, so a new document appears in
the listing before it appears in this index.

If you cannot find something below, the directory listing is still the full picture.

## Start here

| Document | What it covers |
| --- | --- |
| [USER_GUIDE.md](USER_GUIDE.md) | Opening a scan in a browser tab, with no install and no upload. |
| [usage.md](usage.md) | Open, navigate, measure, annotate, inspect, export. |
| [supported-formats.md](supported-formats.md) | What loads today, and what is only planned. |
| [limitations.md](limitations.md) | Where the viewer stops and a GIS or survey package begins. |
| [screenshots.md](screenshots.md) | The reference images used across the docs and the README. |

## Formats and loading

| Document | What it covers |
| --- | --- |
| [copc.md](copc.md) | Cloud Optimized Point Cloud: the format, the server requirements, the viewer's behaviour. |
| [streaming.md](streaming.md) | The shared COPC and EPT pipeline, eviction, pressure adaptation. |
| [public-lidar-catalog.md](public-lidar-catalog.md) | The vetted dataset picker in the empty state. |
| [credits.md](credits.md) | Where the sample datasets come from and under which licences. |

## Navigation and rendering

| Document | What it covers |
| --- | --- |
| [navigation.md](navigation.md) | The game-like camera model, and why a point cloud is explored rather than panned. |
| [DESIGN_NOTES.md](DESIGN_NOTES.md) | Each interface decision tied to the need it serves and the cost it accepts. |
| [mobile-browser-support.md](mobile-browser-support.md) | What works on phones and tablets, and what degrades. |

## Measurement and analysis

| Document | What it covers |
| --- | --- |
| [analysis-architecture.md](analysis-architecture.md) | How the analysis stack is layered, and what each layer is allowed to assume. |
| [coordinate-precision.md](coordinate-precision.md) | The precision contract on georeferenced scans, audited against real data. |
| [science/METHOD_REGISTRY.md](science/METHOD_REGISTRY.md) | Every analytical method, with its definition and its reference. |
| [architecture/project-spatial-frame.md](architecture/project-spatial-frame.md) | The authoritative frame that measurements are expressed in. |

## Terrain

| Document | What it covers |
| --- | --- |
| [terrain-intelligence.md](terrain-intelligence.md) | The confidence-aware DTM and contour pipeline under `src/terrain/`. |
| [contour-studio.md](contour-studio.md) | Turning an analysed scan into a contour deliverable, and the honesty model behind it. |
| [acquisition-grid.md](acquisition-grid.md) | The scanner grid kept beside the cloud, what each cell state means, and when the link between them is broken. |
| [validation/terrain-validation-matrix.md](validation/terrain-validation-matrix.md) | Which terrain products are validated, against what, to what tolerance. |

## Performance and limits

| Document | What it covers |
| --- | --- |
| [performance.md](performance.md) | What governs frame rate, and how the viewer adapts when a device runs short. |
| [benchmarks.md](benchmarks.md) | Field measurements from opening real scans. Not a formal benchmark suite. |
| [bundle-budget.md](bundle-budget.md) | The shipped bundle size, and the audit that set the target. |
| [architecture/heavy-cloud-native.md](architecture/heavy-cloud-native.md) | How very large clouds are handled without loading them whole. |
| [project/CLAIMS_AND_LIMITATIONS.md](project/CLAIMS_AND_LIMITATIONS.md) | The claims the project makes, and the ones it deliberately does not. |
| [releases/KNOWN_LIMITATIONS_v0.6.8.md](releases/KNOWN_LIMITATIONS_v0.6.8.md) | Known limitations as of the current release. |

## Scientific validation and evidence

The whole collection lives in [validation/](validation/), and these are the entry points.

| Document | What it covers |
| --- | --- |
| [validation/EVIDENCE_MODEL.md](validation/EVIDENCE_MODEL.md) | The E1 to E5 evidence ladder, and what a promotion requires. |
| [validation/EVIDENCE_UI.md](validation/EVIDENCE_UI.md) | How evidence level reaches the person reading a result on screen. |
| [validation/METHOD_VERSIONS.md](validation/METHOD_VERSIONS.md) | Version history for each method, so an old figure stays attributable. |
| [validation/THREATS_TO_VALIDITY.md](validation/THREATS_TO_VALIDITY.md) | Where the validation could be wrong, stated before anyone else states it. |
| [validation/cross-implementation.md](validation/cross-implementation.md) | Agreement against independent implementations such as PDAL and GDAL. |
| [validation/cross-platform-reproducibility.md](validation/cross-platform-reproducibility.md) | Whether the same input gives the same number on a different machine. |
| [validation/claim-register.yaml](validation/claim-register.yaml) | The machine-readable register that the prose gates check against. |
| [validation/defect-records.md](validation/defect-records.md) | Defects found by validation, kept rather than quietly fixed. |

## Architecture and contributing

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The high-level map: one file per format, one file per concern. |
| [developer-manual.md](developer-manual.md) | Building, testing, extending, shipping. The full reference. |
| [architecture/architecture-map.md](architecture/architecture-map.md) | Module-by-module layout with the boundaries that lint enforces. |
| [architecture/float64-transform.md](architecture/float64-transform.md) | The Float64 placement architecture, and why Float32 was not enough. |
| [disposal-contracts.md](disposal-contracts.md) | Who owns a GPU buffer or a worker, and who is obliged to release it. |
| [threat-model.md](threat-model.md) | The attack surface of a viewer with no server and no account. |
| [project/DEPENDENCIES.md](project/DEPENDENCIES.md) | Every runtime dependency, with the reason it is present. |
| [project/STABILITY_POLICY.md](project/STABILITY_POLICY.md) | What may change between versions, and what may not. |
| [project/SUPPORT.md](project/SUPPORT.md) | Where to ask, and what to include when you do. |
| [collaboration/RESEARCH_COLLABORATION.md](collaboration/RESEARCH_COLLABORATION.md) | Working with the project on research. |
| [project/AI_ASSISTANCE.md](project/AI_ASSISTANCE.md) | How AI assistance is used here, and how it is disclosed. |
| [AUTHORS.md](AUTHORS.md) | Who maintains the project. |
| [research-notes.md](research-notes.md) | The question the project started from, and what has come of it. |

## Release records

Every version keeps four documents: release notes, validation report,
reproducibility record, known limitations. All 57 sit in
[releases/](releases/). The current set is linked below. Older readiness and
audit reports are kept in an internal audit directory that stays in the
repository and out of the released archive, so they are not linked here.

| Document | What it covers |
| --- | --- |
| [releases/RELEASE_NOTES_v0.6.8.md](releases/RELEASE_NOTES_v0.6.8.md) | What changed in the current release. |
| [releases/VALIDATION_REPORT_v0.6.8.md](releases/VALIDATION_REPORT_v0.6.8.md) | The evidence standing behind that release. |
| [releases/REPRODUCIBILITY_v0.6.8.md](releases/REPRODUCIBILITY_v0.6.8.md) | How to rebuild the release and reproduce its figures. |
| [release/RELEASE_ASSETS.md](release/RELEASE_ASSETS.md) | What ships with a release, and how each asset is produced. |
| [release/ERRATUM_v0.6.2.md](release/ERRATUM_v0.6.2.md) | A correction to a published release, kept in the open. |

The release checklist, which lists the steps a release goes through before it is
tagged, is an internal process document. It stays in the repository and is not
part of the released archive.

## Historical plans

Five planning documents describe work scoped under older versions: the gate 2
per-cloud filter plan (v0.5.6), two v0.5.7 plans covering the release scope and
the object and E57 capture lens, the v0.5.8 cleanup plan, and the Float64 frame
migration plan superseded during v0.6 development. All five are superseded and
none of them is current documentation. They are internal engineering notes,
kept in the repository and in history, and left out of the released archive, so
this index describes them rather than linking to them.
