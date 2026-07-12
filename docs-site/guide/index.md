---
title: Quickstart
---

# Quickstart

OpenLiDARViewer opens LiDAR and point-cloud datasets straight in the browser — no install, no account, no upload. Files are read and rendered on your own machine.

## Try it in 10 seconds

Open **[lidar.aurtech.mx](https://lidar.aurtech.mx/)**, then drag a `.las`, `.laz`, or `.copc.laz` file (or paste a remote COPC / `ept.json` URL) onto the page. You're navigating the cloud in your browser, and the file never leaves your device.

From there, the **[User guide](./user-guide)** walks through opening a scan, finding your way around, measuring, analysing terrain, comparing two scans, and sharing your work — assuming no GIS background.

## Run it locally

The viewer is a static site; a local checkout needs only Node 22+:

```bash
git clone https://github.com/aurtechmx/openlidarviewer.git
cd openlidarviewer
npm install
npm run dev
```

Open the local URL it prints, then drop a scan onto the page or click a built-in sample. To build for static hosting (GitHub Pages, Netlify, or any CDN — it is just files):

```bash
npm run build
npm run preview
```

## Where next

- [Navigation](./navigation) — Orbit, Walk, Fly, and Pan, with the full key reference
- [Measurement & analysis](./measurement-analysis) — the seven measurement tools, annotations, inspection, and exports
- [Terrain intelligence](./terrain-intelligence) — the confidence-aware DTM / contour pipeline
- [Streaming](./streaming) — COPC and EPT datasets far larger than browser memory
- [Supported formats](/formats/) — what opens today, exactly, and what is planned
