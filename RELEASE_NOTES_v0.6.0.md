# OpenLiDARViewer v0.6.0

The stable v0.6 release. Its defining change is underneath the surface:
spatial operations are now deterministic, explicit, and non-destructive —
source geometry is immutable by proof, placement is Float64 data about a
layer rather than a rewrite of it, and every measurement and export explains
its own context. The release process, the claims, and the limitations are
all governed by version-controlled policy and checked by lints rather than
trusted to prose.

OpenLiDARViewer remains browser-native and local-first: local files stay on
the user's device, and no account is required.

## Source geometry is immutable, by proof

The in-place Float32 rebase — the one mechanism that could rewrite a loaded
scan's positions — is gone. Mounting a layer into the shared project frame
is now a Float64 placement held beside the data: the mesh is placed by it,
picking drops the ray into the layer's own frame and lifts the hit back,
and camera bounds fold it before merging. Mount and unmount are exact
inverses because nothing is ever re-quantised.

`tests/sourceGeometryImmutable.test.ts` is the proof, not a promise: it pins
the entire `PointCloud` method surface, calls every member, and shows the
position buffer byte-identical. A future writer has to add itself to the
pinned list to compile — and then fails the hash.

Multi-layer mounting itself remains disabled, exactly as in the alphas: the
placement architecture is the prerequisite, and browser verification of
two-layer placement (plus the estimator fold it depends on) is the recorded
gate for ever enabling it.

## Measurements and layers explain themselves

Every displayed measurement now carries a context line: verified when the
shared datum resolved over a proven layer set, approximate with its reason
(unresolved datum, unproven combined context, unknown vertical reference),
or unavailable with its reason. The wording is contract-tested: no
producible label can contain accuracy language.

Every layer gets a health card under the Layers list — CRS and its source,
units, vertical datum, compatibility with its consequence spelled out,
frame offset, and mount precision — plus a readable compatibility report
for the loaded set. The card is fed from the same pass that feeds the
combined estimators, so the two can never disagree about a layer's state.

## Exports state their scope

A point-cloud export of a streaming scan writes the resident set — and now
says so in the file itself: `SUBSET: <held> of <declared> points the source
declared — streamed resident set at display resolution, not the whole
scan`. The same channel that already disclosed display-sample caps and load
strides. A capped local file, a strided load, and a streamed resident set
are all indistinguishable from complete exports without these lines; with
them, no written file can imply completeness it does not have.

## Corrupt COPC input fails with words, not stack traces

Every corrupt-input class — truncated headers, malformed COPC metadata,
hierarchy ranges past end-of-file, absurd entry values, corrupted LAZ
chunks, empty input — refuses with a structured, human-readable error,
pinned by fixture tests over synthesized buffers. Two were real fixes:
past-end-of-file hierarchy ranges were silently clamped by the range
source, and a corrupted chunk let the decompressor's raw abort value cross
the worker boundary verbatim. The honest gap is recorded in the tests: a
chunk that decodes to plausible garbage is undetectable without checksums,
which the LAZ format does not carry; the finite-positions backstop catches
the non-finite subset.

A complete COPC guide — what it is, how the streaming works, what a server
must provide, what a streamed export contains — is at `docs/copc.md`.

## Claims, stability, and language are now policy

`CLAIMS_AND_LIMITATIONS.md` is the canonical source for what this project
claims and what it does not: the vocabulary (validated, verified,
agreement, the E0–E6 evidence ladder), the words never used as claims, and
the rule that a claim changes only through a versioned evidence change.
`STABILITY_POLICY.md` defines what this stable version freezes — session
format, measurement semantics, export shapes, format support — and how
frozen things change. `lint:claims-language` runs in the gate and fails the
build on marketing superlatives.

The scientific evidence is unchanged from alpha.3 and stated the same way:
one E4 claim (`SLOPE-RASTER` agrees with GDAL 3.13.1 and the closed-form
gradient within the preregistered 0.5° tolerance on the analytic fixture),
every other terrain product at internal self-consistency, no field
validation, no survey-grade claim.

## The launch surface

The splash was rebuilt as an instrument panel during this cycle: a one-line
positioning eyebrow, a solid headline, the precise privacy sentence (local
files stay on this device; remote datasets stream only when selected), a
machine-derived format line with COPC and EPT named as streaming
capabilities, a compact non-interactive workflow rail, and a tour that is
offered, never imposed. The supported-format count is generated from the
sniffer's own registry and pinned by test — the hand-typed line it replaced
had already drifted.

## Verification state, plainly

- Full release gate green at the tagged commit: typecheck, twelve lints,
  every test bucket, production audit, fixture checksums, coverage,
  mutation. Totals are in the attached evidence file; cite that, not the
  repo copy.
- Deterministic e2e suite green (161 checks; 4 skip without an optional
  fixture).
- The browser matrix (Windows Chrome, macOS Chrome, Safari, Firefox, one
  mobile device) has not yet been recorded on physical devices for this
  release; the frozen benchmark protocol in `docs/benchmarks.md` likewise
  awaits its first recorded run. Both are stated here rather than implied —
  they are the two open verification items, and they do not change what the
  suites above establish.

## Compatibility

Designed for Chromium-based browsers (Chrome, Edge) with WebGPU, falling
back to WebGL 2 in Firefox and Safari. Automated suites cover the WebGL
paths; the physical-device browser matrix for this release remains
unrecorded, as stated above. Reads LAS, LAZ, E57, PLY, OBJ, GLB/GLTF, XYZ, PCD, PTX,
and PTS, and streams COPC and EPT. Sessions and workflows from the v0.6
alphas open unchanged.

## Deploy

Static files. GitHub Pages, Netlify, any CDN or conventional host.

## Verify this release

```bash
shasum -a 256 -c SHA256SUMS
npm run release:verify -- --dir <downloaded-assets>
```

The asset set and hash chain are documented in
`docs/release/RELEASE_ASSETS.md`.

## Citing

Metadata in `CITATION.cff` and `.zenodo.json`.

* Version: 0.6.0
* Release date: 2026-07-23
* License: MIT

Live demo: [lidar.aurtech.mx](https://lidar.aurtech.mx/)  
GitHub: [Aurtechmx/openlidarviewer](https://github.com/Aurtechmx/openlidarviewer)

Open source · Local-first · Browser-native
