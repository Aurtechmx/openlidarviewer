# Navigation

OpenLiDARViewer has a game-like navigation system, so a point cloud can be explored like a 3D environment rather than a GIS layer.

## Modes

Switch with the bottom-centre control or the number keys.

| Mode | Best for |
|---|---|
| Orbit (`1`) | Inspecting an object, structure, or area from the outside |
| Walk (`2`) | Interiors, buildings, corridors, rooms, street-level scans |
| Fly (`3`) | Drone LiDAR, terrain, forests, large facilities, wide-area scans |

Orbit is the default. Drag to rotate, right-drag to pan, scroll to zoom, and double-click a point to focus on it. Walk is first-person: WASD moves on the horizontal plane so you keep your height, and Space and C change height when you want to. Fly is free 6-DOF flight, where WASD follows the look direction so you go wherever you point.

## Controls

| Input | Action |
|---|---|
| W / A / S / D | Move through the scan |
| Mouse | Look around |
| Shift | Move faster (sprint) |
| Space | Move up |
| C / Ctrl | Move down |
| Esc | Release the cursor |
| R | Reset / re-frame the view |
| F | Focus on the point under the cursor |
| 1 / 2 / 3 | Orbit / Walk / Fly mode |
| Double-click | Fly to the clicked point |

## Mouse-look (pointer lock)

In Walk and Fly modes, click the scan to capture the cursor. The mouse then steers the view like a first-person game. A "click to look around" prompt stays up until the cursor is captured. Press `Esc` to release it, and the cursor returns so you can use the panels again.

## Speed

Movement speed scales with the size of the loaded scan, so the controls feel right whether the dataset is a small room or a kilometre-wide survey. A speed slider in the navigation bar tunes it further, and Shift sprints.

## Smooth camera

The Frame button and double-click focus glide the camera with an eased transition instead of snapping. Movement is delta-time based and frame-rate independent, so it feels the same on a 30 fps or 144 fps display.

## Up axis

Navigation respects the scan's natural up axis: Z-up for LAS, LAZ, E57, and XYZ surveys, and Y-up for phone-scan formats. "Up" stays up and the horizon stays level.
