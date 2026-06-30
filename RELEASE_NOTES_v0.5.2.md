# OpenLiDARViewer v0.5.2

A polish release on the v0.5 line: a stronger integrity digest, a fuller
earthwork report, version-aware exports, and a lighter, better-guarded build.
Still browser-native and local-first. Nothing is uploaded.

## A stronger integrity digest

The integrity report now hashes its contents with SHA-256 by default, a
cryptographic-strength content digest computed synchronously so the report stays
deterministic and verifiable. It is still an integrity digest, not a
secret-keyed signature: it proves the figures were not altered after the fact, it
does not prove who produced them. A reader can still verify an older report by
naming its algorithm, which the file carries.

## The volume report shows the whole earthwork

A volume measurement in the report now reads its net as the headline with the cut
and fill, the footprint area, the confidence tier, and any streaming-resident
caveat alongside, rather than the fill alone. The whole earthwork, with its own
honesty, travels in the file.

## Exports know which build wrote them

The integrity report and the saved session both stamp the app version that
produced them. Re-open a session written by an earlier build and a short notice
says the current build may grade or label the scan differently, so you can
re-save and pick up later corrections. A file with no stamp reads as an earlier
version.

## Lighter and better guarded

- **Lighter startup.** The workflow-recorder settings popup now loads on first
  open instead of riding in the startup bundle, trimming the shipped index chunk
  and shaving a little off first paint.
- **A build guard against a deploy-only failure.** A new check fails the build if
  a raw dynamic `import('./…')` reappears in the entry module, where the
  production obfuscator could scramble the path into a 404 that only shows up on
  the deployed site. It runs in CI and the release gate.
- **A release-sync guard.** A new check keeps the version, the lockfile, the
  README, the changelog, and these notes from drifting apart.
- **An on-canvas compass** (opt-in, `?viewcube=1`) shows which way the camera
  faces and snaps to a standard view on click; its animation pauses while the
  tab is hidden.

## Foundations

Two tested cores ship in source ahead of the interface that will use them, the
project's usual pattern:

- **Planar cloud alignment** — a coarse rigid fit of one cloud onto another with
  a reported residual that refuses a fit it cannot trust, the honest prerequisite
  for aligning two epochs before a change comparison.
- **Export-staleness helper** — compares a stamped producing version against the
  running one; now wired into the session re-open notice above.

## Fixes

- **More detail on capable desktops** carries over: the keyboard help and the
  navigation docs now list the command palette, the `?` sheet, undo, the
  right-click menu, and hold-Space, sourced from the live key bindings.

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
