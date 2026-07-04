# OpenLiDARViewer v0.5.6

A point-filtering release. v0.5.6 connects the staged point-filter work to the
live renderer, starting with an elevation filter.

OpenLiDARViewer stays browser-native and local-first. Local files never leave
the device, and no account is required.

## Elevation filter

Hide points outside a chosen height window. The window is given in world units
and converted to each cloud's local space along its up-axis, so the same control
works for Z-up surveys (LAS, LAZ, E57) and Y-up phone scans. Points outside the
window collapse to zero size on the GPU: the filtered view adds no draw work, and
clearing the filter restores the scene exactly.

This update wires the filter for static clouds. Streaming COPC nodes and an
on-screen control are next in the 0.5.6 line.

## Compatibility and scope

Everything from v0.5.5 is unchanged. The elevation filter is additive and off by
default; the unfiltered scene renders exactly as before.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional
web host.
