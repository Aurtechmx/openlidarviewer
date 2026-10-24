# Navigation

OpenLiDARViewer has a game-like navigation system, so a point cloud can be explored like a 3D environment rather than a GIS layer.

## Modes

Switch with the Orbit | Walk | Fly | Pan control at the bottom centre, or with the number keys. Frame all sits beside it.

| Mode | Best for |
|---|---|
| Orbit (`1`) | Inspecting an object, structure, or area from the outside |
| Walk (`2`) | Interiors, buildings, corridors, rooms, street-level scans |
| Fly (`3`) | Drone LiDAR, terrain, forests, large facilities, wide-area scans |
| Pan (`4` or `G`) | Sliding the view across a scan: the hand tool grabs the scene and drags it 1:1 |

Orbit is the default. Drag to rotate, right-drag to pan, scroll to zoom, and double-click a point to focus on it. Pan is the hand tool: the cursor becomes an open hand, a primary drag grabs the whole scene and the grabbed point stays under the pointer for the entire drag; scrolling still zooms, and one-finger touch drags pan too. Walk is first-person: WASD moves on the horizontal plane so you keep your height, and Space and C change height when you want to. Fly is free 6-DOF flight, where WASD follows the look direction so you go wherever you point.

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
| 1 / 2 / 3 / 4 | Orbit / Walk / Fly / Pan mode |
| G | Toggle the Pan (hand) tool from any mode |
| H | Show or hide the navigation panel |
| Arrow keys | Turn the view in Orbit, and move like W A S D in Walk and Fly |
| Middle-drag | Temporary grab: pan the view in any mode, release to continue |
| Double-click | Fly to the clicked point |

## Tools, panels, and shortcuts

Beyond movement, a small set of global keys reach the tools and panels. Press `?` at any time for the in-app shortcut sheet, which is generated from the live key bindings and always matches the build you are running.

| Input | Action |
|---|---|
| `?` | Open the searchable keyboard-shortcut sheet |
| Cmd-K / Ctrl-K | Open the command palette: every tool, mode, theme, and export |
| `M` | Measure tool |
| `I` | Inspect tool |
| `A` | Annotate tool |
| `V` | Save the current camera view |
| `B` | Show or hide the reference plane |
| `L` | Lasso volume tool |
| `T` / `O` / `P` | Camera presets: Top, Oblique, Planar |
| Ctrl/Cmd-Z | Undo the last edit (annotation or classification) |
| Ctrl/Cmd-Shift-Z, Ctrl/Cmd-Y | Redo |
| Delete / Backspace | Remove the selected annotation |
| Hold Space (while a tool is active) | Temporarily hand the mouse back to camera navigation: rotate, pan, and zoom, then release to resume the tool |
| Right-click the scan | Context menu: focus the pivot on the point under the cursor, frame the scan, or jump to a standard view |

Bare-key shortcuts are ignored while you are typing in a text field, so naming a measurement or an annotation never also fires a tool.

## Views and projection

The Navigation button in the navigation bar (or `H`) opens a panel with the key legend and the Camera and Views rows. More, beside Frame all, holds the axis views.

- Camera presets: Top, Iso, Oblique and Planar jump the camera to a named pose. Iso has no key.
- Axis views, under More: Top, Bottom, Front, Back, Left and Right look straight at one face of the scan, fitted to the visible bounds with a margin at each screen edge. More opens only when you click it, and the command palette lists the same six views.
- Ortho switches between perspective and a flat orthographic projection. Measurements use the 3D points either way. Scroll zoom in an orthographic view keeps the point under the cursor fixed.
- Plan looks straight down in parallel projection with the hand tool on the drag. Turning it off puts back the projection and navigation mode you had. Plan switches on once the camera has landed top-down. Choosing another mode, view or preset before it lands cancels the entry. If the camera cannot reach top-down, Plan turns off and says "Plan view did not finish. Try Plan again." Scroll zoom is ignored while the camera is moving into the view.

## View cube

The view cube sits in the top-right corner of the scan and turns with the camera. Each of its six faces, twelve edges and eight corners turns the camera to look from that direction, around the current pivot and at the current distance, so a click never resets the zoom. A face also sets Plan view the way the axis-view buttons do, and an edge or corner turns Plan view off. Home, below the cube, frames the scan like Frame all.

On a Z-up scan with a known coordinate system, the side faces read N, E, S and W. N is grid north, the direction of the map's Y axis, which is not true north. A scan with a local or unknown coordinate system gets Front, Back, Left and Right instead.

From the keyboard, Tab enters the cube as one stop. The arrow keys move through all 26 views in a fixed order, Home and End jump to the first and last, and Enter or Space turns the camera. A view too thin to click at the current angle still takes focus: the cube outlines it and shows its name beside it.

The cube is on once a scan opens. On a phone-width screen it starts off. Toggle compass in the command palette, or `?viewcube=1` and `?viewcube=0` in the address, switches it.

## Focus mode

Focus in the header, or Focus Mode in the command palette, closes both side rails and hides the header links so the scan has the window. The navigation bar, the view cube, the dock and the state strip stay. Exit focus or Esc brings each rail back as it was. Phones do not offer Focus mode.

## Mouse-look (pointer lock)

In Walk and Fly modes, click the scan to capture the cursor. The mouse then steers the view like a first-person game. A "click to look around" prompt stays up until the cursor is captured. Press `Esc` to release it, and the cursor returns so you can use the panels again.

## Speed

Movement speed scales with the size of the loaded scan, so the controls feel right whether the dataset is a small room or a kilometre-wide survey. A speed slider in the navigation bar tunes it further, and Shift sprints.

## Smooth camera

The Frame button and double-click focus glide the camera with an eased transition instead of snapping. Movement is delta-time based and frame-rate independent, so it feels the same on a 30 fps or 144 fps display.

## Up axis

Navigation respects the scan's natural up axis: LAS and LAZ surveys are Z-up, as are E57 and XYZ, and phone-scan formats are Y-up. "Up" stays up and the horizon stays level.
