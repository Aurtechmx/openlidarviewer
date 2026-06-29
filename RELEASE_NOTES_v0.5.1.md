# OpenLiDARViewer v0.5.1

Auditable volume, classification editing, and integrity reports.

A point release on the v0.5 line. It improves how the viewer reports
uncertainty and tidies up everyday handling. Nothing is uploaded. Your scan
stays on your device.

Runs client-side on WebGPU, with a WebGL 2 fallback.

## Volume with a confidence band

Stockpile and earthworks volumes drawn with the lasso now show a ± band. The
band combines two errors: point sampling, and a systematic base-plane term (one
flat base under sloped ground biases every thickness the same way). You can open
the math behind it. If the viewer reduced the cloud to fit your device, the
volume says so, and the band widens to match.

## Edit the classification

A class picker and a lasso-reclassify tool let you fix a derived classification
by hand, with multi-step undo and redo. Edits change the live class channel, so
they go straight into a LAS export. Each edit also clears stale analysis, so the
next Analyse run uses the classes you see, not an old grade.

## A report you can verify

Placed measurements export as an integrity report. The findings, dataset
provenance, and classification edit-epoch hash into a content digest, and the
file names which digest it used. Change a number without recomputing the digest
and verification fails. This catches accidental edits. It is not a cryptographic
signature. Two-epoch change detection now reports a volume-change ± band and
whether the net change clears its own error, so noise never reads as a real gain
or loss.

## Easier to drive

Undo now reaches every edit. Ctrl/Cmd+Z (Shift+Z or Ctrl+Y to redo) undoes
whichever history you touched last, annotations or classification, not just
annotations.

Hold Space to re-orient. While a tool is active, hold Space to rotate, pan, and
zoom, then release to go back to the tool.

Right-click the scan to focus the pivot on the point under the cursor, frame the
scan, or jump to a standard view.

The keyboard help is now accurate, and capable desktops keep more of a dense
survey loaded before the viewer reduces it.

## Fixes

Downloads are reliable again. Every export releases its temporary blob URL only
after the download starts. This fixes cancelled PDF, DEM, batch-ZIP, and
integrity-report downloads on Safari, iOS, and for large files.

Imported render state is range-checked. A point size or field of view read from
a saved session is clamped, so a corrupted session can't break the display.

Stockpile base uncertainty now models the flat-base mis-fit under sloped ground,
not just point scatter.

## About the grades

The confidence figures and quality grades describe the data you loaded. They are
not a survey-grade certification. Treat terrain products, exports, and epoch
comparisons as deliverable only when the assessment reads Good, and validate
against ground control where survey accuracy matters.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files. Host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files, 755 directories) and carries
`index.html` plus `assets/` at the archive root, along with `.htaccess` and
`_headers` for host-side security headers.
