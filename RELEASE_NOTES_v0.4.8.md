# OpenLiDARViewer v0.4.8

A focused classification release: scans that ship without a usable classification
can now derive one, colour helps separate trees from structures, and the result
tells you how much to trust it. Still browser-native, local-first, nothing
uploaded.

## Highlights

- **Classify unclassified scans that carried an empty class channel** — a file
  whose every point is ASPRS 0 ("Created, never classified") or 1
  ("Unclassified") is functionally unclassified, even though it technically
  carries a classification field. Those scans — raw photogrammetry exports, many
  drone clouds — are now eligible for **Classify (derive)**, where before the
  action treated the empty channel as "already classified" and declined. Clouds
  with no classification at all still classify as before.
- **RGB-assisted vegetation** — when a scan carries colour, Classify now folds a
  vegetation-greenness cue (normalised Excess-Green) into the geometry: a tall,
  locally-smooth patch that reads strongly green is treated as canopy rather than
  a building. This is the cue that matters on photogrammetry, where the surface
  is noisy and shape alone confuses tree crowns with roofs. Colour only breaks
  the tree-vs-structure tie; it never invents vegetation on the ground, and a
  scan without colour classifies exactly as before.
- **Confidence on the derived classification** — every run now reports an overall
  confidence and per-class confidence, surfaced in the Classes legend caption and
  the result toast, so a derived classification reads as "trust this a lot" or
  "rough visual aid" rather than landing unqualified. Confidence drops on sparse,
  void-ridden, or coarse-grid scans — exactly when a heuristic is least reliable.
- **Void-honest heights** — the classifier fabricates a bare-earth surface inside
  data gaps to keep the math finite, but it no longer pretends that surface is
  real: a tall point whose height rests mostly on hole-filled void is left
  **Unclassified** rather than guessed, and the run raises a plain warning naming
  the gap. You never get a confident class invented over empty space.

## Honesty

- A scan that already carries a real producer classification (any ASPRS class ≥
  2) is **left untouched** — Classify never overwrites a surveyor's classes. The
  derived result stays tagged "derived (heuristic)" with its method and a
  "validate before relying on it" caveat, and the provenance line now records
  when the RGB cue was used.

## Under the hood

- The classifier gained a "classify the gaps" capability — derive only the
  unclassified points of a partially-classified cloud while preserving every
  producer class — with full unit coverage. It is not yet wired to a user action
  (so producer-classified scans are never silently modified); a deliberate
  "fill unclassified points" surface will follow.
- `npm run test:release` runs the full browser-independent gate in one command:
  typecheck, the main-deferral lint, the production build, the bundle-budget
  check, the bucket partition check, and all four test buckets.

Derived classification is a geometry-and-colour heuristic for visual inspection
and research, not a survey-grade or producer classification. Treat any output as
survey-grade only after validating it against survey-grade data and procedures.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root.
