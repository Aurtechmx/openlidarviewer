# OpenLiDARViewer v0.5.3

A patch release on the v0.5 line. In progress.

Still browser-native and local-first. Nothing is uploaded.

## Align two clouds before comparing them

The planar alignment core that shipped in v0.5.2 is now wired into change
detection. Before two epochs are compared, one cloud can be coarse-aligned onto
the other with a reported residual, and a fit the alignment cannot trust is
refused rather than applied. This keeps a change comparison from reading
registration error as real movement.

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
