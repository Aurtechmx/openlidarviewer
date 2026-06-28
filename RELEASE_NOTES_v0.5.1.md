# OpenLiDARViewer v0.5.1

A point release that deepens the honesty moat and sharpens day-to-day handling.
Every new number still carries its own uncertainty and caveat, and nothing is
uploaded — the scan stays on your device.

## Measure with an auditable band

Stockpile and earthworks volumes drawn with the lasso now report a ± confidence
band that states its own uncertainty: a sampling-error term and a systematic
base-plane term (a single horizontal base under sloped ground biases every
thickness the same way) combined in quadrature, with a show-the-math breakdown
and plain caveats. When the loaded cloud was automatically reduced to fit your
device, the volume says so — the inside points are a representative sample of a
denser survey, and the band already widens to match.

## Edit the classification, honestly

A class picker and a lasso-reclassify tool let you correct a derived
classification by hand, with real multi-step undo and redo. Edits mutate the
live class channel, so they round-trip straight into a LAS export — and each
edit invalidates stale analysis, so the next Analyse recomputes against the
classes you actually see rather than serving a grade that no longer matches.

## Hand over something verifiable

Placed measurements export as a tamper-evident signed report: the findings,
dataset provenance, and classification edit-epoch are folded into a verifiable
signature. Alter any figure and verification breaks. Two-epoch change detection
now also reports a volume-change ± band and whether the net change exceeds its
own error, so noise is never presented as a confident gain or loss.

## Smoother to drive

- **Undo reaches every edit.** Ctrl/Cmd+Z (Shift+Z or Ctrl+Y to redo) now undoes
  whichever history you touched last — annotations or classification — instead
  of only annotations.
- **Hold Space to re-orient.** While a tool is active, hold Space to rotate, pan,
  and zoom without leaving the tool, then release to resume.
- **Right-click menu** on the scan: focus the pivot on the point under the
  cursor, frame the scan, or snap to a standard view.
- **Accurate keyboard help**, and **more detail on capable desktops** — high-end
  machines keep more of a dense survey resident before automatic reduction.

## Fixes

- **Reliable downloads.** Every export now funnels through one helper that
  releases the temporary blob URL only after the download has had a moment to
  start, fixing cancelled PDF / DEM / batch-ZIP / signed-report downloads on
  Safari, iOS, and for large generated files.
- **Imported render state is range-checked.** A point size or field-of-view read
  from a saved session is clamped to a sane range, so a corrupted session file
  can't load the viewer into an unusable display.
- **Stockpile base-plane honesty.** Base uncertainty models the systematic
  mis-fit of a flat base under sloped ground, not just point scatter.

The confidence figures and quality grades describe the delivered data; they are
not a survey-grade certification. Treat terrain products, exports, and epoch
comparisons as deliverable-ready only when the assessment reads **Good**, and
validate against ground control where survey-grade accuracy is required.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root, along with `.htaccess` and
`_headers` for host-side security headers.
