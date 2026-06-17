# OpenLiDARViewer v0.4.8

A focused classification release: scans that ship without a usable classification
can now derive one, and colour helps separate trees from structures. Still
browser-native, local-first, nothing uploaded.

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

Derived classification is a geometry-and-colour heuristic for visual inspection
and research, not a survey-grade or producer classification. Treat any output as
survey-grade only after validating it against survey-grade data and procedures.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root.
