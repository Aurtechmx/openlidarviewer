# v0.4.9

This release is mostly about telling the truth in the numbers. Open a big survey
and the viewer used to show you the point count and density of the slice it
loaded for display, not the whole file, so a dense scan could read two or three
times sparser than it really was. That is fixed everywhere now. There is also a
redesigned Analyse panel and a noticeably smaller download.

## The Analyse panel leads with a verdict

The panel opens with one plain-language verdict and a six-row scorecard: location
and height, coverage, ground detail, vertical accuracy, classification, and
integrity. Every row carries an icon and a shape (a check, a dash, or a warning
triangle), so you can read it without relying on colour. The USGS quality-level
badge only appears when the scan earns it. The old panel repeated the same
figures in three places; now each fact lives in one spot.

## The numbers describe the file, not the loaded sample

Large clouds get thinned for rendering. The Scan Report, the inspection PDF, the
provenance density, and the Layers chip now report the file's real point count
and density, and a "Loaded" line tells you how much is actually held in memory.
A few related cleanups came with it:

- Dense drone surveys read as drone-mounted LiDAR instead of terrestrial laser scans.
- A georeferenced scan with no vertical datum now says "elevation datum not declared" rather than "heights are relative." The heights are real; the datum just is not stated.
- A classification field with nothing actually classified reads "Present, unclassified" instead of a bare "Yes."

## Fixes

- The point cloud no longer collapses into a square when you zoom the browser out.
- Contour GeoJSON exports carry elevation in the Z coordinate.
- Vertical units are read from the file and converted to metres before grading.

## A smaller download

The brand artwork is lighter by about a megabyte, so the viewer paints faster on
first load.

---

Still browser-native and local-first. Your files are read and rendered on your
own machine, with nothing sent anywhere. Quality grades describe the delivered
data; treat terrain products as ready for handoff only when the assessment reads
Good, and check against ground control where survey-grade accuracy matters.

The full per-change list is in [CHANGELOG.md](./CHANGELOG.md).
