# OpenLiDARViewer v0.6.1

v0.6.1 is a patch release. It fixes four defects found by auditing the v0.6.0 archive after publication, three of which produced wrong or missing information in a file a reader had no way to question. Behaviour is otherwise unchanged from v0.6.0. OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Corrected exports and declarations

- the LAS 1.4 writer treated the WKT record and the GeoKey record as alternatives, so a scan carrying a NAVD88 height in US survey feet came out declaring no vertical datum and no vertical unit, and a reader takes those feet for metres;
- LAS 1.4 permits both records, so the vertical GeoKeys are now written alongside the WKT, with the WKT remaining the only authority on the horizontal frame and no empty GeoKey record written when there is nothing to add;
- contour GeoJSON labelled every elevation as metres while the value is in the source vertical unit, so a compound reference system with feet above a metre grid shipped a 100 ft contour described as 100 m;
- the GeoJSON label is now derived from the resolved vertical factor, and a factor that cannot be resolved reads as unknown rather than defaulting to metre.

## Corrected failure handling

- an unterminated CDATA section, comment or processing instruction sent the E57 XML parser back over the same bytes indefinitely;
- that parser runs inside the shared, gated parse worker, so the worker spun, the load never settled, and the gate admitting the next file was released in a block that never ran, hanging every subsequent load in the session until the page was reloaded;
- each unterminated construct now fails with a structured error;
- the EPT laszip decoder was the one streaming path without the finite-position backstop its two siblings apply, so a header carrying an extreme but structurally valid scale could overflow to infinite coordinates and reach the renderer as a blank cloud with no error reported;
- that decoder now refuses such a node with the same structured error the COPC and EPT binary decoders raise.

## Runtime verification

The recorded gate completed with 6,182 passing tests and 16 skipped, and the deterministic end-to-end suite with 161 passing checks and 4 skipped. Published totals are read from the attached evidence file rather than entered by hand. A passing suite confirms the implementation meets its specifications; it does not validate scientific correctness.

The scientific evidence is unchanged from v0.6.0. One E4 claim is registered: SLOPE-RASTER agrees with GDAL 3.13.1 and the closed-form gradient within the preregistered 0.5 degree tolerance on the analytic fixture. Every other terrain product remains at internal self-consistency, with no field validation and no survey-grade claim.

## Also in this release

- the repository gains internal scaffolding for a benchmark framework under `benchmarks/`, with no runnable entry point and no benchmark suite yet;
- nothing in the application changes because of it.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.1.md`. Five audit findings are recorded there as open:

- the contour deliverable's GeoTIFF omits the vertical-units key that the standalone DEM package writes;
- the asynchronous terrain-derivative path takes no vertical-unit factor, unreachable today but would produce a wrong slope if that path were adopted;
- the geodesic void fill mixes horizontal source units with vertical metres on geographic grids;
- the unused hillshade convenience wrappers assume square cells and metric heights;
- the RFC 7946 contour writer can place an elevation in the third ordinate where the standard requires metres.

Everything disclosed for v0.6.0 still applies, including the two monoliths, multi-layer mounting remaining disabled, the absence of cross-system reprojection, and the E3 evidence ceiling on every terrain product except the registered slope claim.

## Compatibility

Unchanged from v0.6.0. Modern Chromium browsers with WebGPU, falling back to WebGL 2 in Firefox and Safari, and sessions and exports from v0.6.0 are unaffected.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
```

The asset set and hash chain are documented in `docs/release/RELEASE_ASSETS.md`.

## Citing

Metadata is in `CITATION.cff` and `.zenodo.json`. The author declares no competing interests; development is self-funded by Aurtech.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.1
- Release date: 2026-07-25
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.0...v0.6.1](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.0...v0.6.1)
