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

The filter works for static clouds and streaming COPC/EPT nodes, driven by an
on-screen control in the Inspector.

## Intensity filter

Hide points outside a chosen intensity window, in the file's raw intensity
units. It uses the same GPU approach as the elevation filter: points outside the
window collapse to zero size, so the filtered view adds no draw work. The
control seeds from the cloud's own intensity range and stays hidden for scans
that carry no intensity channel.

## Streaming point-cloud export

Export the streamed-in (resident) points of a COPC or EPT scan to LAS, LAZ, or
XYZ at display resolution. While the whole cloud is still streaming, the export
is flagged as a reduced view so it is never mistaken for the full survey.

## Compatibility and scope

Everything from v0.5.5 is unchanged. The elevation filter is additive and off by
default; the unfiltered scene renders exactly as before.

## Deploy

Static files. Host on GitHub Pages, Netlify, a static CDN, or any conventional
web host.
