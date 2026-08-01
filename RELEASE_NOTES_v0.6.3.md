# OpenLiDARViewer v0.6.3

v0.6.3 is a correction and platform-parity release. It fixes eleven defects, most of them invisible on macOS and load-bearing on Windows, and lands the first half of a streaming-performance change that stays off until browser evidence supports enabling it. The measured figures in this document come from the release-mode gate run at the tagged commit.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required.

## Corrected calculations and declarations

- the LAS load-memory estimate accounts for colour, so a colour-bearing point format no longer under-reports by three bytes per point and admits a budget the device cannot hold;
- three preset fields that declared a setting the renderer never applied are separated from the ones it does;
- the preset colour mode is applied per cloud, and skipped where the cloud lacks the data that mode needs;
- the E57 core-namespace test is anchored to its host, so a vendor namespace containing the string no longer reads as core and drops its declared extension fields;
- three release gates escape every regular-expression metacharacter in a version, not only the dot, across five call sites;
- three markdown writers escape the backslash before the pipe;
- classification count maps are null-prototype.

## Windows behaviour

Each of these was inert on macOS, which is why none surfaced earlier. macOS
draws overlay scrollbars: no layout width, hidden until they scroll, never
dragged. Windows draws a classic one that occupies fifteen pixels and is meant
to be dragged, so a rule that costs nothing on one platform is load-bearing on
the other. The fixes are scoped by measuring what the platform actually draws
rather than by reading the user agent, since the setting is user-changeable on
both.

- the left rail's scrollbar can be grabbed: the column is the scroll container and carried `pointer-events: none`, which also made its scrollbar untargetable;
- seven scrollable surfaces reserve a stable gutter, so crossing the overflow threshold no longer shifts content sideways by the scrollbar width; the command palette re-renders on every keystroke and moved on each one;
- Ctrl and the wheel zoom the page again. The canvas cancelled every wheel event and fills the window, leaving no way to enlarge the interface. A macOS trackpad pinch arrives as a wheel with the same flag and no key held, so it still drives the camera;
- the rail breakpoints meet at 767 and 768. At exactly 768 the desktop panels mounted with their collapse handles hidden;
- shortcut chips read `Ctrl+Shift+U` rather than Apple's glyphs;
- panel scrollbars follow the theme, on platforms that draw a scrollbar to theme;
- the debug overlay's scrollbar is reachable.

## Accessibility

- Windows High Contrast is supported. Twenty-six panels separated from the 3D view through a translucent fill and a blur, neither of which composites in that mode, and four controls signalled their state through background colour alone, so on and off rendered identically.

## Streaming

- decoded and resident are separate node states. Decode completion marked a node resident and built its mesh in the same turn, so several decodes landing together built several meshes in one frame, and the point budget throttled against decode progress rather than against what the viewer had drawn;
- the upload queue gained payload cleanup and a per-frame byte and node budget. A time budget alone cannot bound the next frame, because the real buffer upload is deferred to render.

Routing commits through the queue is off by default. It changes when a node counts as resident and when its mesh is built, and the release criteria ask for WebGPU and forced-WebGL2 measurements first. Absent the option, behaviour is unchanged from v0.6.2.

## Validation infrastructure

- the three mutations that survived the full gate at v0.6.2 are closed: the contour saddle equality boundary, removal of `summary.html` from the required benchmark artifacts, and omission of a document that shipped Markdown still references;
- mutation testing moved out of the tag-time gate into a scheduled workflow. The release record cites the result, states the commit it was measured at, and is refused outright when no result exists or the cited score sits below the break threshold. The current campaign scores 96.81 over 188 mutants against the numeric core, up from 87.23 at v0.6.2. Forty-six of the 182 detected mutants were killed by timeout rather than by an assertion, which is weaker evidence than a test failing on a wrong value, so the composition is published alongside the score;
- a frame-performance record with a fixed comparison rule. A missing measurement is recorded as absent rather than as zero, and runs from different machines, browsers or backends are refused rather than pooled;
- a gate asserting the upload queue is still reachable from the streaming path. It was written, tested and left unconnected for a full release, and no test could catch that;
- per-scene ground-classification metrics (precision, recall, specificity, F1 and MCC) measured against a PDAL reference on five synthetic scenes, with recall and MCC guarded against a frozen baseline in the release gate. The numbers show what the 82% pooled agreement hid: recall is low, 73.9% pooled and 0.99% on the low-outlier scene, so the filter errs by rejecting ground PDAL keeps rather than by inventing it. The reported figure is the raw comparison;
- a `validate:scientific` command that runs every existing verifier in one pass, records the commit and the tool versions it ran against, and writes JSON, CSV and Markdown. It reimplements no check and promotes no claim;
- the analytic-terrain oracle covers a paraboloid, a ridge, a step edge and a no-data boundary, checking the terrain derivatives against values worked out by hand rather than against another program.

## Repository and provenance

- release archives and the SBOM carry signed build provenance, verifiable with `gh attestation verify`;
- commits and tags are signed;
- `main` and the `v*` tags are protected, with no bypass;
- `codemeta.json` and expanded Zenodo relations declare the reference implementation and the fixture corpus in a form a machine can read;
- the repository is submitted to Software Heritage;
- coverage is reported per pull request.

## Known limitations

The complete list is in `KNOWN_LIMITATIONS_v0.6.3.md`. Carried forward from v0.6.2, and unchanged by this release:

- in-memory LAS reconstruction is less precise than the source file at very large local extents;
- LAS 1.2 masks classification values above 31;
- contour geometry crossing the antimeridian is not split at ±180°;
- opening a remote streaming source replaces the one already open;
- multi-layer mounting remains disabled;
- cross-system reprojection is not provided.

New in this release:

- the Windows fixes are reasoned from the platform's scrollbar and input behaviour and verified against a browser forced into that configuration. They are not yet confirmed on Windows itself;
- High Contrast support is verified as present in the stylesheet, not as it appears in a real High Contrast session;
- queue-metered streaming commits are implemented and tested but not enabled, and carry no performance claim.

## Compatibility

Unchanged from v0.6.2. Modern Chromium browsers use WebGPU, with WebGL 2 fallback in Firefox and Safari, and existing sessions remain compatible.

- a preset selected in v0.6.2 applies the same visual settings, and the three it silently ignored are now declared as not applied;
- session files are unaffected.

## Verifying this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
gh attestation verify <archive> --repo Aurtechmx/openlidarviewer
```

The verified asset set is listed in `release-manifest-v0.6.3.json`. The two GitHub-generated Source code archives are not part of it.

## Citing

Citation metadata is provided in `CITATION.cff`, `.zenodo.json` and `codemeta.json`.

ORCID: [0009-0007-3147-323X](https://orcid.org/0009-0007-3147-323X)

- Version: 0.6.3
- License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)
Full changelog: [v0.6.2...v0.6.3](https://github.com/Aurtechmx/openlidarviewer/compare/v0.6.2...v0.6.3)
