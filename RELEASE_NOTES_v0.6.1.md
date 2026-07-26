# OpenLiDARViewer v0.6.1

v0.6.1 is a patch release. It fixes four defects found by auditing the v0.6.0 archive after publication, three of which produced wrong or missing information in a file a reader had no way to question. Behaviour is otherwise unchanged from v0.6.0.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Exported heights now state their real unit

Two export paths described elevations in a unit they were not in.

The LAS 1.4 writer treated the WKT record and the GeoKey record as alternatives. The WKT it produces describes the horizontal frame only, while the vertical datum and the vertical unit live in the GeoKeys, so writing one meant discarding the other. A scan carrying a NAVD88 height in US survey feet came out of the converter declaring no vertical datum and no vertical unit at all, and a reader takes those feet for metres. LAS 1.4 permits both records, so the vertical GeoKeys are now written alongside the WKT. The WKT remains the only authority on the horizontal frame, and no empty GeoKey record is written when there is no vertical information to add.

Contour GeoJSON labelled every elevation as metres. The value is in the source vertical unit, so a compound reference system with feet above a metre grid shipped a 100 ft contour described as 100 m. The label is now derived from the resolved vertical factor, and a factor that cannot be resolved reads as unknown rather than defaulting to metre.

## A truncated E57 file no longer hangs the session

An unterminated CDATA section, comment or processing instruction sent the E57 XML parser back over the same bytes indefinitely. Because that parser runs inside the shared, gated parse worker, the effect reached past the file that caused it: the worker spun, the load never settled, and the gate that admits the next file was released in a block that never ran, so every subsequent load in the session hung as well. Only reloading the page recovered. Each unterminated construct now fails with a structured error.

## Streaming refuses impossible coordinates consistently

The EPT laszip decoder was the one streaming path without the finite-position backstop its two siblings apply. A header carrying an extreme but structurally valid scale could overflow to infinite coordinates, which reached the renderer as a blank cloud with no error reported. It now refuses such a node with the same structured error the COPC and EPT binary decoders raise.

## Runtime verification

The recorded gate completed with 6,182 passing tests and 16 skipped, and the deterministic end-to-end suite with 161 passing checks and 4 skipped. Published totals are read from the attached evidence file rather than entered by hand. A passing suite confirms the implementation meets its specifications; it does not validate scientific correctness.

The scientific evidence is unchanged from v0.6.0. One E4 claim is registered: SLOPE-RASTER agrees with GDAL 3.13.1 and the closed-form gradient within the preregistered 0.5 degree tolerance on the analytic fixture. Every other terrain product remains at internal self-consistency, with no field validation and no survey-grade claim.

## Also in this release

The repository gains internal scaffolding for a benchmark framework under `benchmarks/`. It has no runnable entry point and no benchmark suite yet, and nothing in the application changes because of it.

## Known limitations

`KNOWN_LIMITATIONS_v0.6.1.md` carries the full list. Five audit findings are recorded there as open: the contour deliverable's GeoTIFF omits the vertical-units key that the standalone DEM package writes; the asynchronous terrain-derivative path takes no vertical-unit factor, which is unreachable today but would produce a wrong slope if that path were adopted; the geodesic void fill mixes horizontal source units with vertical metres on geographic grids; the unused hillshade convenience wrappers assume square cells and metric heights; and the RFC 7946 contour writer can place an elevation in the third ordinate where the standard requires metres.

Everything disclosed for v0.6.0 still applies, including the two monoliths, multi-layer mounting remaining disabled, the absence of cross-system reprojection, and the E3 evidence ceiling on every terrain product except the registered slope claim.

## Compatibility

Unchanged from v0.6.0. Modern Chromium browsers with WebGPU, falling back to WebGL 2 in Firefox and Safari. Sessions and exports from v0.6.0 are unaffected.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
```

The asset set and hash chain are documented in `docs/release/RELEASE_ASSETS.md`.

## Citing

Metadata is in `CITATION.cff` and `.zenodo.json`
(ORCID [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)). The author
declares no competing interests; development is self-funded by Aurtech.

* Version: 0.6.1
* Release date: 2026-07-25
* License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)  
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
