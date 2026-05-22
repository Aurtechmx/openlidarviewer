# Mobile Browser Support

## Overview

OpenLiDARViewer supports mobile-friendly viewing and file loading for compatible point-cloud and 3D scan files. You can open and inspect those files from phones and tablets, directly in a mobile browser.

## Supported Mobile Browsers

- Safari browser on iPhone devices
- Chrome browser on iPhone devices (note that browsers on iOS use Apple's WebKit engine)
- Chrome browser on Android devices
- Modern mobile browsers where WebGL 2 is available

WebGPU availability varies by browser and device. OpenLiDARViewer uses WebGPU when present and falls back to WebGL 2 otherwise.

## Opening Files on iPhone Devices

To open a scan on an iPhone:

1. Save a compatible file to device storage or iCloud Drive.
2. Open OpenLiDARViewer in a mobile browser.
3. Tap "Open scan from device."
4. Select the file in the native file picker.
5. Wait for parsing and rendering to finish.

## Recommended Mobile Scan Workflow

OpenLiDARViewer can open compatible exports from mobile scanning apps. Useful formats include:

- GLTF / GLB for mobile mesh workflows
- PLY when point-cloud export is available
- OBJ as a common mesh format
- XYZ / CSV for raw point-coordinate workflows
- LAS / LAZ, which are more common in drone and professional LiDAR workflows

Several iPhone LiDAR scanning apps — such as Polycam, Scaniverse, or 3D Scanner App — can export scans in formats OpenLiDARViewer reads, including GLTF/GLB, OBJ, and PLY. Export formats, free-tier availability, and pricing differ between apps and can change over time, so check each app's current help documentation before relying on a particular export. Some formats may require a paid plan.

OpenLiDARViewer is not affiliated with, endorsed by, or sponsored by Apple or any third-party scanning app, including those named above. Third-party product names are used only for descriptive compatibility and workflow documentation.

## Touch Navigation

- Drag with one finger to rotate.
- Pinch to zoom.
- Drag with two fingers to pan.
- Double tap to focus on a point where supported.

## Mobile Measurement

To measure on mobile, tap two points to measure the distance between them. Use the Clear and Done controls to remove a measurement or exit the tool.

Measurements are intended for visual inspection and documentation workflows unless validated against survey-grade data and procedures.

## Mobile Performance Tips

- Start with smaller GLTF / GLB / PLY files.
- Use Mobile Safe or Balanced detail.
- Close other browser tabs.
- Use modern phones and tablets when possible.
- Very large LAS/LAZ datasets are better handled on desktop.

## Limitations

- Browser memory limits can affect what loads.
- Large files may fail to load or feel slow.
- WebGPU support varies by browser and device.
- Available file formats depend on implementation status.
- Measurements are not survey-grade by default.

## Manual QA Checklist

- [ ] Safari browser on iPhone loads the app
- [ ] Chrome browser on iPhone loads the app
- [ ] Chrome browser on Android loads the app
- [ ] The open-file button works on phone
- [ ] The native file picker opens on phone
- [ ] A compatible GLTF/GLB test file loads
- [ ] A compatible PLY test file loads
- [ ] Scan Intelligence is hidden before loading
- [ ] Scan Intelligence appears only after a scan loads
- [ ] Scan Intelligence does not cover the whole screen by default
- [ ] The keyboard navigation HUD is hidden on phone
- [ ] A touch hint appears instead of keyboard controls
- [ ] Pinch zoom works
- [ ] One-finger rotate works
- [ ] Two-finger pan works
- [ ] The measurement button is usable on phone
- [ ] Tap-to-measure works or explains the limitation gracefully
- [ ] The top bar does not overlap the notch/safe area
- [ ] Bottom controls remain usable
- [ ] Landscape orientation does not break the layout
- [ ] The desktop layout remains unchanged
