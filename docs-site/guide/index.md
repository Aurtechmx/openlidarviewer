---
title: Quickstart
---

# Quickstart

OpenLiDARViewer opens LiDAR and point-cloud datasets straight in the browser: no install and no account. Local files are read and rendered on your own machine and are not uploaded.

## Try it in 10 seconds

Open [app.openlidarviewer.org](https://app.openlidarviewer.org/), then drag a `.las`, `.laz`, or `.copc.laz` file onto the page, or enter a remote COPC, `ept.json`, or 3D Tiles `tileset.json` URL in the Open from URL field. You're navigating the cloud in your browser, and a local file never leaves your device.

From there, the [User guide](./user-guide) walks through opening a scan, finding your way around, measuring, analysing terrain, comparing two scans, and sharing your work: assuming no GIS background.

## Run it locally

The viewer is a static site; a local checkout needs Node `^22.18.0` or `>=24.11.0` (the `engines` field in `package.json`):

```bash
git clone https://github.com/aurtechmx/openlidarviewer.git
cd openlidarviewer
npm install
npm run dev
```

Open the local URL it prints, then drop a scan onto the page or press "Launch a sample", which streams the swissSURFACE3D sample (83.8 MB) over the network. To build for static hosting (GitHub Pages, Netlify, or any CDN: it is just files):

```bash
npm run build
npm run preview
```

## Something not working?

A file that refuses to open, a warning that looks wrong, one screen that confused you: all of it is worth writing down. Email what you found (a short description, and a screenshot if it helps) to <info@aurtech.mx>.

## Where next

- [Navigation](./navigation): Orbit, Walk, Fly, and Pan, with the full key reference
- [Measurement & analysis](./measurement-analysis): the nine measurement tools, annotations, inspection, and exports
- [Terrain intelligence](./terrain-intelligence): the confidence-aware DTM / contour pipeline
- [Streaming](./streaming): COPC and EPT datasets far larger than browser memory
- [Supported formats](/formats/): what opens, and what is refused
