# OpenLiDARViewer v0.6.5

v0.6.5 hardens the remote-streaming path, moves contours to independent cross-implementation evidence, and lays the first piece of the Process Studio architecture. It carries no change to how a scan looks or measures; the work is in reliability, evidence, and internal structure. The measured figures in this document come from the release-mode gate run at the tagged commit.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Remote streaming, hardened

- signed remote EPT URLs are scrubbed from transport error messages. A SAS or presigned dataset carries its credential in the URL query, and four error paths interpolated the raw URL into text the streaming panel shows; every one now routes through the display sanitiser, so a working bearer token can no longer reach a screenshot or a support ticket;
- every remote range read is bounded in bytes and in time. A host answering a small range request with a body far larger than asked for is refused mid-stream rather than read into memory first, and a body that arrives and then goes quiet is bounded by an idle and a whole-body clock rather than hanging the load;
- the remote object's identity is pinned across a load. A COPC or EPT session is many range reads over seconds to minutes, so a file re-uploaded partway through would splice two versions into one decode. The object's validators and total size are pinned at probe time and re-checked on every read, sending `If-Match` where the server offers a strong validator; a changed validator, a changed size, or a failed precondition fails the read with a distinct, non-retryable code instead of a silent mismatch;
- a streaming scan now carries a stable shell id, so the export and terrain scan-identity guards catch a streaming-to-streaming swap that the previous null id read as the same scan.

## Contours reach cross-implementation evidence

Contours move from E3 to `E4_CROSS_IMPLEMENTATION_VALIDATED`. Our marching-squares isolines are compared against GDAL's `gdal_contour` on a frozen analytic tilted plane, where linear interpolation is exact so the tolerance measures agreement rather than interpolation noise. The two implementations agree within 0.05 m across every compared vertex, with a maximum separation of 2.9×10⁻⁵ m, and each also sits on the analytic level. The comparison, its command, tool version, and checksums are recorded in a freeze-verified study manifest whose tolerance was registered a month before the reference was generated. The map-sheet export now routes as a validated export, where validated means the product meets its required evidence level; survey-grade contours remain a prohibited claim.

## Process architecture

- a Process Studio capability evaluator answers one question from a plain-data description of the loaded scan: what can this dataset safely produce? Each product reads `ready`, `review`, or `blocked` with a stable reason code, and the model is the single source of product eligibility so the UI and the exporters read one verdict rather than each deciding for itself;
- the evaluator fails closed. An unconfirmed linear unit blocks the metric products, a missing or differing vertical reference between two scans blocks cross-epoch height math, and resident-only streaming coverage cannot back a full-dataset product. It is pure data with no DOM or rendering dependency, so it runs the same on the main thread or in a worker.

## Documentation, corrected

Several statements were brought back in line with what ships: the README described opening multiple scans as layers, which reads as the disabled multi-layer mount, and now states the two-epoch compare that actually ships; `docs/limitations.md` called all point-data editing out of scope while classification editing ships, and now scopes out only general-purpose geometry editing; and the streaming source, once described as a future seam, is described as shipped on its own path.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.5.md`. Carried forward from v0.6.4 and unchanged by this release: multi-layer mounting remains disabled behind its flag; a large class of terrain and measurement products still fail closed on an unconfirmed unit rather than guess; there is no cross-CRS reprojection into a common viewer frame; and the residual streaming flicker at the point-budget boundary is unchanged.

## Compatibility

Unchanged from v0.6.4. Modern Chromium browsers use WebGPU, with WebGL 2 fallback in Firefox and Safari, and existing sessions remain compatible. Session files are unaffected.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive> --repo Aurtechmx/openlidarviewer
```

The verified asset set is listed in `release-manifest-v0.6.5.json`. The two GitHub-generated Source code archives are not part of it.

## Citing

Citation metadata is provided in `CITATION.cff`, `.zenodo.json` and `codemeta.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.5
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.4...v0.6.5](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.4...v0.6.5)
