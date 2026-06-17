# OpenLiDARViewer v0.4.7

An accessibility and workflow release on top of a correctness-and-honesty pass —
still browser-native, local-first, nothing uploaded.

## Highlights

- **Colourblind-safe classification palette** — a toggle in the Classes panel
  recolours the classes with an Okabe-Ito categorical palette so ground,
  vegetation, buildings, and water stay distinguishable under the common
  colour-vision deficiencies. The class label and count stay on every row, so
  colour is never the only cue.
- **Annotation grouping** — the Annotations panel and the PDF report open with a
  one-line summary of the notes: totals, the per-category breakdown (notes /
  info / warnings / issues), and how many areas they fall across, so a dense set
  reads at a glance.
- **Workflow recorder returns** — record a sequence of camera moves and tool
  actions and replay it on the same scan. A settings popup tunes the file format
  (readable / compact), the save destination (download or a native save-as
  dialog), the start/stop shortcut, replay speed (0.5× / 1× / 2× / instant), a
  pre-record countdown, which action families are captured, and loop replay. It
  records actions only — never scan data — so a recipient needs the same scan
  open to replay it.
- **Honesty cue on the Dataset Intelligence card** — a quiet coloured dot marks
  each row's qualitative tier; terrain complexity stays neutral (it is
  descriptive, not a quality), and a missing signal is muted to match the `—`.

## Correctness & honesty fixes

- Empty files are rejected with a clear message instead of opening a blank,
  unframable scene.
- Reprojection never ships non-finite coordinates — a transform outside the
  target projection's valid area fails honestly and leaves the source untouched.
- NAD83 against the WGS84-coincident datum family is flagged as an identity
  shift (~1–2 m), alongside the existing NAD27 and GDA94↔GDA2020 caveats.
- A measured area reads the same in the PDF report as on screen.
- Unknown point density shows `—` rather than a fabricated "Sparse".
- Streaming sources close their reader on detach; the colour-recompute timer is
  cleared on teardown.

## Under the hood

- The unit test suite is split into four coverage-complete buckets
  (`test:unit` / `test:terrain` / `test:ui` / `test:slow`) that always union to
  the whole suite, so it can run in parallel.

Measurement and the floor-plan preview are for visual inspection and research,
not survey-grade use. Treat any output as survey-grade only after validating it
against survey-grade data and procedures.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root.
