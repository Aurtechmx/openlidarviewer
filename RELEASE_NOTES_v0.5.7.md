# OpenLiDARViewer v0.5.7

An object, E57, and evidence-honesty release. v0.5.7 teaches the viewer to read a
scan for what it is — a compact object, an interior, or a local-frame
terrestrial/handheld capture — and to stop applying airborne-survey and terrain
framing where it does not belong. It also replaces the old single "Production"
status with a documented evidence ladder, so every scientific claim states how
strongly it is supported. OpenLiDARViewer stays browser-native and local-first:
your files never leave the device, and no account is required.

## The capture lens

The viewer already computed two things about a scan: its shape (object,
interior, or terrain) and its display profile (a georeferenced survey, a
terrestrial scan, a handheld capture, or a mesh). v0.5.7 composes them into one
"capture lens" that the classifier, the reports, and the panels all read from.

It keeps two facets separate on purpose. "Not terrain" means contour, coverage,
and slope framing do not apply — an object or an interior. "Local frame" means
there is no geodetic CRS to show — a bare terrestrial, handheld, or mesh scan.
A terrestrial scan of a hillside is terrain-shaped but local-frame, so it keeps
its contours while its coordinate section is suppressed; an object keeps its CRS
suppression without losing shape context. Collapsing the two into one flag would
lose one or the other, so the lens carries both.

## Shape-aware capture-type classification

The capture-type classifier used point density as a fallback signal, and dense
object scans could resemble an airborne survey by that measure alone. A compact
object or interior can now never be asserted as drone, aerial, or spaceborne from
density: airborne capture is ruled out by the geometry, and the verdict is
demoted to an honest "ground-based scan — capture method not determined" rather
than a fabricated one. Direct evidence — a generating-software or sensor string,
or the file's own declaration — still wins over the heuristic, exactly as before.

## Declared-by-the-file provenance

When a scan carries a recognised display profile or an `olv:` provenance block
(the metadata namespace used by the research E57 samples), the Inspector surfaces
what the file itself declares: the capture app, the sensor, and a one-line
profile headline. Every value sits under an explicit "Declared by the file — not
verified" qualifier and is shown verbatim. Nothing on this card is inferred, and
when the file declares it is not survey grade, the card says so.

The glTF `asset.generator` stamp (Polycam, Scaniverse, RealityKit, and similar)
and a texture/material presence flag are now read on load and feed the display
profile, so a textured handheld capture is recognised as a capture rather than a
bare CAD mesh.

## Quieter panels for non-survey scans

The Coordinate-system section now hides for local-frame scans, where the only
thing it could show is a "CRS unknown" row that reads as a defect rather than a
fact. The georeferenced-survey path is unchanged.

## An explicit evidence model

The validation matrix used a single "Production" status that conflated "the code
works" with "the science is validated". v0.5.7 replaces it with an evidence
ladder, E0 through E6, and a machine-readable claim register
(`docs/validation/claim-register.yaml`). Each product records its current
evidence level, the level it must reach before it may be exported as a validated
(non-exploratory) result, and the approved and prohibited claims for it.

The load-bearing boundary is E3 to E4: everything at or below E3 is verified only
against our own code or our own synthetic data. Independent evidence begins at
E4, field-grade validity at E5. Nothing in the register is at E4 or above yet,
and the documentation states that plainly rather than implying otherwise. The
supporting docs (`EVIDENCE_MODEL.md`, `EVIDENCE_UI.md`) and the corrected terrain
matrix scope the ground filter (an SMRF-core progressive-morphological subset),
the confidence and NVA/VVA-style figures, the QL wording, and the CRS handling to
exactly what the evidence supports.

## Fixes

The lazy display-profile wiring now handles a chunk-load or derivation failure
quietly instead of surfacing an unhandled promise rejection; the card is additive
and simply does not appear if its module fails to load.

## Compatibility and scope

Everything from v0.5.6 is unchanged for a georeferenced survey. The capture lens,
the declared-provenance card, and the panel suppressions are additive and only
change what a non-survey scan shows; a survey scene renders and reports exactly
as it did before. The evidence model is documentation and an internal gate — it
does not remove any existing caveat, only makes the support level explicit.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional
web host.

## Citing this release

Cite OpenLiDARViewer with the metadata in `CITATION.cff` (version 0.5.7, MIT
licence, released 2026-07-05). When the tagged release is archived on Zenodo,
cite the version DOI Zenodo assigns to that snapshot.
