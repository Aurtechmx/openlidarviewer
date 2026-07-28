# OpenLiDARViewer v0.5.1

A point release on the v0.5 line: an auditable confidence band on lasso volumes,
hand editing of the classification, and a verifiable integrity report on export.
Still browser-native and local-first. Nothing is uploaded.

## Measure with an auditable band

Stockpile and earthworks volumes drawn with the lasso now report a ± confidence
band. The band combines two sources of error: the point sampling, and a
systematic base-plane term, since one flat base under sloped ground biases every
thickness the same way. The two are added in quadrature, with a show-the-math
breakdown and plain caveats. When the viewer reduced the cloud to fit your
device, the volume says so, and the band widens to match.

## Edit the classification

A class picker and a lasso-reclassify tool let you correct a derived
classification by hand, with multi-step undo and redo. Edits change the live
class channel, so they round-trip straight into a LAS export. Each edit also
clears stale analysis, so the next Analyse run grades the classes you see rather
than serving an old result that no longer matches.

## Hand over something verifiable

Placed measurements export as a tamper-evident integrity report. The findings,
the dataset provenance, and the classification edit-epoch hash into a content
digest, and the file names which digest it used. Change a figure without
recomputing the digest and verification fails, which catches an accidental or
casual edit. It is not a cryptographic signature. Two-epoch change detection now
reports a volume-change ± band and whether the net change clears its own error,
so noise never reads as a confident gain or loss.

## Easier to drive

- **Undo reaches every edit.** Ctrl/Cmd+Z (Shift+Z or Ctrl+Y to redo) undoes
  whichever history you touched last, annotations or classification, not just
  annotations.
- **Hold Space to re-orient.** While a tool is active, hold Space to rotate, pan,
  and zoom, then release to resume the tool.
- **Right-click menu on the scan.** Focus the pivot on the point under the
  cursor, frame the scan, or jump to a standard view.
- **Accurate keyboard help, and more detail on capable desktops.** High-end
  machines keep more of a dense survey loaded before the viewer reduces it.

## Fixes

- **Reliable downloads.** Every export now releases its temporary blob URL only
  after the download has started, fixing cancelled PDF, DEM, batch-ZIP, and
  integrity-report downloads on Safari, iOS, and for large generated files.
- **Imported render state is range-checked.** A point size or field of view read
  from a saved session is clamped to a sane range, so a corrupted session file
  cannot load the viewer into an unusable display.
- **Stockpile base-plane honesty.** Base uncertainty now models the systematic
  mis-fit of a flat base under sloped ground, not just point scatter.

The confidence figures and quality grades describe the delivered data; they are
not a survey-grade certification. Treat terrain products, exports, and epoch
comparisons as deliverable-ready only when the assessment reads **Good**, and
validate against ground control where survey-grade accuracy is required.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files. Host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files, 755 directories) and carries
`index.html` plus `assets/` at the archive root, along with `.htaccess` and
`_headers` for host-side security headers.
