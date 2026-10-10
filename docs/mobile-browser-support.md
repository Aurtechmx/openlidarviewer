# Mobile browser support

## Overview

OpenLiDARViewer supports mobile-friendly viewing and file loading for compatible point-cloud and 3D scan files. You can open and inspect those files from phones and tablets, directly in a mobile browser.

## Supported mobile browsers

- Safari browser on iPhone devices
- Chrome browser on iPhone devices (note that browsers on iOS use Apple's WebKit engine)
- Chrome browser on Android devices
- Modern mobile browsers where WebGL 2 is available

WebGPU availability varies by browser and device. OpenLiDARViewer uses WebGPU when present and falls back to WebGL 2 otherwise.

## Opening files on iPhone devices

To open a scan on an iPhone:

1. Save a compatible file to device storage or iCloud Drive.
2. Open OpenLiDARViewer in a mobile browser.
3. Tap "Open scan."
4. Select the file in the native file picker.
5. Wait for parsing and rendering to finish.

## Recommended mobile scan workflow

OpenLiDARViewer can open compatible exports from mobile scanning apps. Useful formats include:

- GLTF / GLB for mobile mesh workflows
- PLY when point-cloud export is available
- OBJ as a common mesh format
- XYZ / CSV for raw point-coordinate workflows
- LAS / LAZ, which are more common in drone and professional LiDAR workflows

Several iPhone LiDAR scanning apps (such as Polycam, Scaniverse, or 3D Scanner App) can export scans in formats OpenLiDARViewer reads, including GLTF/GLB, OBJ, and PLY. Export formats, free-tier availability, and pricing differ between apps and can change over time, so check each app's current help documentation before relying on a particular export. Some formats may require a paid plan.

OpenLiDARViewer is not affiliated with, endorsed by, or sponsored by Apple or any third-party scanning app, including those named above. Third-party product names are used only for descriptive compatibility and workflow documentation.

## The phone layout

The panels sit in a bottom sheet with Data, Tools, Analyse, Export and View tabs. The dock keeps Frame all, Measure, Inspect, Annotate and Commands in view, and the ••• button holds Save a snapshot, Analyse, Copy view link, Help and Close scan. The live probe is a hover tool, so it is not offered on touch screens. A strip of state readouts shows the dataset, coordinate system, vertical reference and basis. On a scan reduced to a display sample, the strip offers Export all N points, which a phone refuses when the file is too large for its memory, and it gives the reason. A denser reload is not offered on a phone or tablet.

## Tablets

A tablet counts as a touch layout when it has a touch screen at least 768 px wide and 600 px tall, a coarse primary pointer and no hover. An iPad with a trackpad attached still counts. On such a tablet the controls outside the rails, dock and dialogs are 44 px targets, and panel close buttons and Frame all are 48 px. This covers the navigation card and its speed slider, the scan-state items, the empty state, the command palette, the shortcut sheet, the tour, the floating panels, the location bar buttons, the catalogue inputs, the View panel head, and checkbox labels in the rails, each of which is a 44 px box. The view cube grows to 144 px with 44 px circular buttons, a long label wraps instead of widening the button, and the cube moves to the right of the left rail while that rail is open. Mouse and phone layouts keep their sizes.

## Touch navigation

- Drag with one finger to rotate.
- Pinch to zoom.
- Drag with two fingers to pan.
- Double tap to focus on a point where supported.

## Mobile measurement

To measure on mobile, open the Measure tool, pick a kind from the toolbar and tap points on the scan. The kinds are the desktop ones: distance, polyline, area, height, angle, slope, profile, box and volume. Tap a placed point to drag it, and use the Clear and Done controls to remove measurements or exit the tool. The units toggle switches between metric and imperial.

While Measure or Inspect is active, a short instruction such as "Select the second point" appears beside the tool rail, up to two lines long. For Measure it sits to the right of the rail, and for Inspect, which has no rail, it sits below the Inspect bar. Screen readers are told each time the instruction changes. Desktop layouts do not change.

Measurements are intended for visual inspection and documentation workflows unless validated against survey-grade data and procedures.

## Mobile rendering

Eye Dome Lighting (the screen-space depth shading) is off by default on phones and on the WebGL 2 backend, so a scan opens at full speed on a weaker mobile GPU. It can still be switched on from the Rendering section of the View tab if your device handles it comfortably. Adaptive point sizing and round, antialiased points are on by default on mobile, the same as on desktop.

## Mobile performance tips

- Start with smaller GLTF / GLB / PLY files.
- Expect a large cloud to open as a display sample. A denser reload is not offered on a phone or tablet.
- Leave Eye Dome Lighting off on weaker devices; the depth cue costs a full-screen pass.
- Close other browser tabs.
- Use modern phones and tablets when possible.
- Very large LAS/LAZ datasets are better handled on desktop.

## Limitations

- Browser memory limits can affect what loads.
- Large files may fail to load or feel slow.
- WebGPU support varies by browser and device.
- Eye Dome Lighting is off by default on mobile; it can be enabled manually.
- Available file formats depend on implementation status.
- Measurements are not survey-grade by default.

## Manual QA checklist

- [ ] Safari browser on iPhone loads the app
- [ ] Chrome browser on iPhone loads the app
- [ ] Chrome browser on Android loads the app
- [ ] The open-file button works on phone
- [ ] The native file picker opens on phone
- [ ] A compatible GLTF/GLB test file loads
- [ ] A compatible PLY test file loads
- [ ] The bottom sheet is hidden before loading
- [ ] The bottom sheet appears only after a scan loads
- [ ] The bottom sheet does not cover the whole screen by default
- [ ] The keyboard navigation HUD is hidden on phone
- [ ] A touch hint appears instead of keyboard controls
- [ ] Pinch zoom works
- [ ] One-finger rotate works
- [ ] Two-finger pan works
- [ ] The measurement button is usable on phone
- [ ] Tap-to-measure works or explains the limitation gracefully
- [ ] The Rendering controls are reachable and usable on phone
- [ ] The top bar does not overlap the notch/safe area
- [ ] Bottom controls remain usable
- [ ] Landscape orientation does not break the layout
- [ ] The desktop layout remains unchanged
