# OpenLiDARViewer v0.6.4

v0.6.4 sharpens classification, tightens the report and export surfaces around unknown coordinate units, and finishes the interface work started in v0.6.3. It adds a ground-support gate for building classification and records a synthetic evaluation of it, makes automatic classification return-number aware, and adds a standalone auto-classify control that keeps the scan's natural colour. It also lands a WebGL 2 fallback that fixes an iOS WebKit open crash. The measured figures in this document come from the release-mode gate run at the tagged commit.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Classification

- building classification now requires firmer ground support underneath a candidate roof, so scan-edge void artifacts no longer classify as buildings while real buildings whose ground is fully measured are kept. `docs/validation/building-support-gate-eval.md` records a synthetic evaluation of the gate;
- automatic classification reads the return number, so a multi-return point is treated as vegetation rather than as a single hard surface;
- a standalone Auto-classify button lives in the Edit-classes panel, so classification runs on demand rather than only on load;
- auto-classify keeps the scan's natural colour instead of forcing the class palette, so a run no longer overwrites an RGB display the user chose.

## Reports and export

- the Contour Studio purpose selection now threads into the map-sheet PDF, so the printed sheet reflects the purpose the contours were generated for;
- the Contour Studio purpose picker is compact, and each option's description appears on hover;
- four report and UI surfaces fail closed on an unknown CRS unit rather than presenting a length whose unit cannot be resolved;
- annotation `worldPosition` is populated and the report frame is labelled, so an exported annotation carries a resolved coordinate and the report states the frame it is in.

## Streaming

- remote COPC streaming replacement is transactional: opening a second remote source no longer leaves the previous session partly torn down if the swap does not complete (gate F4).

## Multi-layer mounting

- multi-layer mounting is disabled in v0.6.4 while the per-layer frame fixes land, and the flag is guarded so the state cannot drift on. Multiple layers still load and are analysed individually.

## Interface

- the mobile GUI is restyled to match the console layout the desktop uses;
- the README is decluttered and leads with a hero image;
- loose documents at the repository root moved into `docs/project` and `docs/releases`;
- the contour-readiness card renders its value on one line instead of stacking it into a vertical column.

## Compatibility

- WebGPU falls back to WebGL 2 when no adapter is present, which fixes an open crash on iOS WebKit;
- the classifier worker chunk is emitted in the obfuscated build, so on-demand classification loads on the shipped artifact;
- existing sessions remain compatible, and modern Chromium browsers use WebGPU with WebGL 2 fallback in Firefox and Safari.

## Discoverability

- `llms.txt` and `robots.txt` are added so automated readers can find the project's entry points.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.4.md`. Carried forward and unchanged by this release:

- in-memory LAS reconstruction is less precise than the source file at very large local extents;
- LAS 1.2 masks classification values above 31;
- contour geometry crossing the antimeridian is not split at ±180°;
- opening a remote streaming source replaces the one already open;
- multi-layer mounting is disabled;
- cross-system reprojection is not provided.

New in this release:

- the building ground-support gate is evaluated on a synthetic corpus only, where the scan-edge void has ground support of exactly 0.5. Behaviour on real airborne or photogrammetric clouds, on mixed support values, and on a real building at a genuine coverage edge is not measured, and the last case would lose real-building recall;
- the iOS WebKit fallback is verified against a browser forced onto WebGL 2, not against every affected iOS device;
- return-number-aware classification is a heuristic over return metadata, not a validated land-cover classifier.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive> --repo Aurtechmx/openlidarviewer
```

The verified asset set is listed in `release-manifest-v0.6.4.json`. The two GitHub-generated Source code archives are not part of it.

## Citing

Citation metadata is provided in `CITATION.cff`, `.zenodo.json` and `codemeta.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.4
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.3...v0.6.4](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.3...v0.6.4)
