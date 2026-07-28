# OpenLiDARViewer v0.5.8

An architectural and scientific-provenance hardening release. v0.5.8 begins a
staged cleanup that ties every output to the exact build that produced it and
stops the viewer from asserting units it does not actually know. OpenLiDARViewer
stays browser-native and local-first: your files never leave the device, and no
account is required.

## Build identity on every artifact

A release version answers "which release" but not "which build". Two builds of
the same version — a clean tag against a dirty working tree, yesterday against
today, the readable source build against the deployed one — are different
artifacts, and provenance that records only the version cannot tell them apart.

v0.5.8 resolves one build identity at build time: version, git commit, a
dirty-tree flag, build time, Node version and channel. Every terrain export now
stamps it into both the text and JSON provenance, and the report PDF records it
in its creator metadata. When git is unavailable the commit reads `unknown`
rather than a fabricated hash, and the build time honours `SOURCE_DATE_EPOCH` so
a reproducible build can pin it.

## Coordinates in the unit they are actually in

The Inspector's picked-point card labelled every projected coordinate, and every
local or unknown-CRS coordinate, with a metre suffix. A US-survey-foot survey
therefore read its eastings as metres, and an ungeoreferenced scan asserted
metres it never knew — which directly contradicted the card's own "shown in
source units only" note.

The axis units now follow the CRS's own linear unit: metres show " m", foot-based
CRSs show " ft", and an unknown unit shows no suffix rather than claiming metres.

## Method registry

The viewer now keeps a single catalogue of the scientific methods it runs, each
with a stable `id@version`. Provenance and reports can name the exact algorithm
and revision behind a number, so a figure can be traced to the method that
produced it and to the paper that specifies it.

## Under the hood

- A CI layer-boundary check fails the build if a science or core module
  (`terrain`, `validation`, `analysis`, `science`) imports the UI layer or
  three.js, keeping those modules pure and worker-safe.
- The staged cleanup program and its current state are recorded in
  `docs/architecture/v0.5.8-cleanup-plan.md`.

Full history is in [CHANGELOG.md](CHANGELOG.md).
