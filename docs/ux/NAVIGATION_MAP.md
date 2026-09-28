# Navigation map

Phase C0 of the [community wayfinding specification](COMMUNITY_SPEC.md). This
file records every navigation surface of the viewer as it is on main, how each
one is entered and left, the names it goes by, the actions that appear on more
than one surface, and the surfaces with no visible, labelled way back. It also
holds the panel pressure inventory, the strip provider check (CE-STRIP-00) and
the journey baseline.

Nothing in this file changes behaviour. Later phases change the surfaces and
update the map.

Paths are relative to `src/`. Line numbers are as of the commit that adds this
file.

## 1. How routing works

- A route is `{ mode, page }`; a null page is the mode's home
  (`app/workspace/workspaceRouter.ts:30`). Each mode remembers its page under
  `olv.workspace.left.page`. There is no URL or history entry.
- A page shows a task header, `<nav aria-label="Task">`, holding Back
  (`.olv-ws-back`) and the page title (`.olv-ws-task-title`,
  `aria-current="page"`). Back reads `← <parent>` with the accessible name
  `Back to <parent>` (`workspaceRouter.ts:172`).
- Back goes to the parent page, or else to the mode home. Focus then moves to
  the first enabled button of the home, not to the row that opened the page
  (`workspaceRouter.ts:150`).
- Forward navigation from the rail moves focus to the page title
  (`workspaceRouter.ts:153`, `createRailIntent` at 210).
- No rail surface handles Escape. The global Escape binding cancels a lasso or
  a measurement in progress and shows "Back to navigation."
  (`ui/keyBindings.ts:395`).
- The phone sheet shows the same mode hosts, re-parented into its slots
  (`app/workspace/workspaceShell.ts:248`), so phone pages carry the same task
  header.

## 2. Surfaces

In the tables below, **Back** names a visible, labelled control that leaves the
surface, **Esc** says whether Escape leaves it, and **Focus** says where focus
goes on leaving.

### 2.1 Left rail modes and pages

| Surface | Entered by | Back | Esc | Focus on leaving | Visible names |
| --- | --- | --- | --- | --- | --- |
| Data home | Rail tab **Data** | Home, none needed | No | n/a | Tab "Data" |
| Classes page | Data home row **Classes** | `← Data` | No | First home button | Page "Classes", panel "Classes" |
| Tools home | Rail tab **Tools** | Home | No | n/a | Tab "Tools", head "Tools" |
| Measure page | Dock **Measure**, launcher row, `M`, palette "Measure" | `← Tools` | Escape cancels a capture only | First home button | Page "Measure", panel "Measurements" |
| Annotate page | Dock **Annotate**, launcher row, `A`, palette | `← Tools` | No | First home button | Page "Annotate", panel "Annotations" |
| Clip page | Launcher row, palette "Clip box" | `← Tools` | No | First home button | Page "Clip box", panel "Clip box" |
| Analyse home | Rail tab **Analyse**, dock **Analyse** | Home | No | n/a | Tab "Analyse" |
| Terrain page | Home row **Terrain**, remedy "Prepare terrain" | `← Analyse` | No | First home button | Page "Terrain", panel "Analyse" |
| Contours page | Terrain link "Create contours" or "Contours", home child row | `← Terrain` | No | First home button | Page "Contours" |
| Objects page | Home row | `← Analyse` | No | First home button | Page "Objects & Space", panel "Object scan" |
| Features page | Home row | `← Analyse` | No | First home button | Page "Feature candidates" |
| Range page | Home row | `← Analyse` | No | First home button | Page "Range frames" |
| Export home | Rail tab **Export**, results shelf **Export** | Home | No | n/a | Tab "Export", panel "Export / Convert" |

Leaving a tool page also happens when the tool is toggled off: the router
falls back to the home because the page requires its panel
(`workspaceRouter.ts:110`).

The rail collapse grabber reads "Hide panel" or "Show panel"
(`ui/panelChrome.ts:230`). The right rail grabber reads the same, so the two
cannot be told apart by name.

### 2.2 Persistent chrome

| Surface | What it holds | Exit |
| --- | --- | --- |
| Top bar (`ui/Stage.ts:298`) | Wordmark, "Private · on your device", full screen, Credits, Guide, Performance settings, GitHub, theme toggle | Persistent. The Performance settings popover closes on Escape and returns focus (`ui/qualityControl.ts:111`) |
| Dock (`ui/toolDock.ts`) | Frame, Snapshot, Measure, Inspect, Probe, Annotate, Analyse, Copy view link, Commands, Help, More (`•••`), Close | Persistent. More is a popover with `aria-expanded` |
| NavBar (`ui/NavBar.ts`) | Orbit, Walk, Fly, Pan; frame button (no text, named "Frame the whole scan"); Top, Iso, Oblique, Planar; six standard views; Ortho; Plan | Persistent. Its help panel "Navigation" has `×` "Hide navigation panel" and the `H` key |
| Right rail (`ui/Inspector.ts`) | Panel titled "Scan Intelligence" | Grabber "Hide panel". No Escape |
| Results shelf (`app/results/resultsShelf.ts`) | Toggle "Results · N", rows with Focus and Export | Escape collapses it and focuses the toggle (`:195`) |

The top bar has no back-to-centre control. The comment at
`ui/headerControls.ts:4` still describes one.

### 2.3 Labs

All three open through `openModal` (`ui/Modal.ts`), from their Analyse home
row, the palette, or a results shelf **Focus** (`app/results/resultsShelfMount.ts:42`).

| Lab | Modal title | Palette title | Back | Esc | Focus on leaving |
| --- | --- | --- | --- | --- | --- |
| Flow Pulse | "Field Simulation Lab: Flow Pulse" | "Flow Pulse (Field Simulation Lab)" | `×`, named "Close dialog" | Yes | The opener |
| Terrain Access | "Field Simulation Lab: Terrain Access" | "Terrain Access (Field Simulation Lab)" | `×`, named "Close dialog" | Yes | The opener |
| Observatory | "Observatory" | "Observatory (observation evidence)" | `×`, named "Close dialog" | Yes | The opener |

A backdrop click also closes each lab. The modal hides the rail and most of
the scan.

### 2.4 Workspaces

| Surface | Entered by | Back | Esc | Focus on leaving | Visible names |
| --- | --- | --- | --- | --- | --- |
| Contour Studio | Contours page launcher "Create Contour Deliverable"; palette "Create contours" | None of its own; the page's `← Terrain` | No | First home button | Region "Contour Studio", launcher head "Terrain Products" |
| Profile Workbench | **Expand** on a profile row, desktop only | "Collapse" and "Close" ("Close the profile workbench") | From inside: first press collapses, second closes | Not restored | Region named after the measurement |
| Range Workbench | Range page launcher "Open Range Frame Workbench" | None of its own; the page's `← Analyse` | No | First home button | Launcher "Structured Data", region "Range frame workbench" |
| ResultFocus | **Expand** on a result (the phone's substitute for the Profile Workbench) | `×`, named "Close dialog" | Yes | The opener | Title is the measurement name |

### 2.5 Transient surfaces

| Surface | Entered by | Back | Esc | Focus on leaving |
| --- | --- | --- | --- | --- |
| Command palette (`ui/CommandPalette.ts`) | Dock **Commands**, Ctrl or Cmd+K | None. Footer text "Esc close" only | Yes, and backdrop click | The opener |
| Help overlay (`ui/HelpOverlay.ts`) | Dock **Help**, toast "Learn why". No key | "Close", named "Close help" | Yes | The opener |
| Keyboard shortcuts (`ui/ShortcutSheet.ts`) | `?`, palette "Show keyboard shortcuts" | `×`, named "Close shortcuts" | Yes | The opener |
| Context menu (`main.ts:760`) | Right click on the scene | Menu items only | Yes | The opener |

### 2.6 Phone (390×844)

The phone layout applies at a width up to 767 px, or a height up to 500 px
with a coarse pointer (`ui/isMobileDevice.ts:35`). The rail is hidden and the
bottom sheet (`ui/MobileSheet.ts`) shows the four modes plus **View**, which
holds the right rail content and has the title "How the scan is drawn: colour,
point size, rendering, visuals." (`:75`).

| Detent | Height | How it is reached |
| --- | --- | --- |
| peek | The sheet head, about 56 px | Default. Starting a tool lowers the sheet to peek (`workspaceShell.ts:326`) |
| half | 50% of the window | Revealing a result (`workspaceShell.ts:345`) |
| full | 88% of the window | Tapping a tab from peek; tapping the head or handle toggles peek and full |

- The handle is a button named "Collapse panel" or "Expand panel". A drag
  snaps to the nearest detent. The sheet has no Escape and no Close, and it
  stays while a scan is open.
- Inside the sheet: every mode home and page, the View tab, the results shelf
  (at the top of the Data tab), Contour Studio and the Range and Feature
  workbenches.
- Over the sheet: every modal (labs, Observatory, ResultFocus, Dataset Story),
  Help, the palette, the shortcut sheet and the context menu. Modals are
  centred cards 460 px wide at most, with no phone full-screen rule.
- The Profile Workbench is not offered on the phone; Expand opens ResultFocus.
- The right rail's own `×` is hidden inside the sheet. View is left by
  another tab or by lowering the sheet.
- The dock's More popover holds Snapshot, Analyse, Copy view link, Help and
  Probe on the phone. Probe is hidden on the phone.

## 3. Names in use

| Thing | Names on screen |
| --- | --- |
| Right rail | "Scan Intelligence" (`ui/Inspector.ts:1023`), "Inspector" (tour, `ui/onboarding/tourSteps.ts:85`), "In the Inspector" (Data home row), "View" (phone tab), "Scan Info" (phone button) |
| Export mode | Tab "Export", panel "Export / Convert" |
| Terrain page | Page "Terrain", panel head "Analyse" |
| Measure page | Page "Measure", panel "Measurements" |
| Objects page | Page "Objects & Space", panel "Object scan" |
| Rail grabbers | Both "Hide panel" / "Show panel" |
| Top view | Palette "Top view" is the `camera.top` preset; context menu "Top view" is the axis-aligned standard view |

## 4. Duplicates

Every action reachable from more than one persistent surface (dock, NavBar,
top bar, rails, launcher, palette, Help, context menu, keyboard). The decided
treatment for every row (CE-NAME-02, CE-ASK-02) is the same: **every copy
takes the registry label, and no control is removed.** A row with no registry
descriptor gets one in C1 before its copies are relabelled.

The list has 25 rows.

| # | Action (registry id and title) | Surfaces and current labels |
| --- | --- | --- |
| 1 | `camera.frame-all` "Frame all" | Dock "Frame" (`ui/toolDock.ts:109`); NavBar, no text, named "Frame the whole scan" (`ui/NavBar.ts:333`); palette "Frame all"; context menu "Frame scan"; key `R`; Help row "Frame all" |
| 2 | `tool.measure` "Measure" | Dock "Measure"; launcher "Measure"; palette; key `M`; Help |
| 3 | `tool.inspect` "Inspect point" | Dock "Inspect"; launcher and palette "Inspect point"; key `I` |
| 4 | `tool.annotate` "Annotate" | Dock "Annotate"; launcher; palette; key `A` |
| 5 | `tool.clip` "Clip box" | Launcher "Clip box"; palette; Help |
| 6 | `tool.snapshot` "Save a snapshot" | Dock "Snapshot"; palette "Save a snapshot"; Help |
| 7 | `tool.share` "Copy view link" | Dock "Copy view link"; palette |
| 8 | Analyse mode (dock `tool.analyse`, no registry title) | Dock "Analyse" (toggles the panel and switches mode); rail tab "Analyse"; phone tab "Analyse". Decided: the dock copy opens the Analyse home |
| 9 | `analyse.run` "Run terrain analysis" | Analyse home button; Terrain page button; palette |
| 10 | `analyse.contours` "Create contours" | Terrain link "Create contours" or "Contours"; home child row "Contours"; launcher "Create Contour Deliverable"; palette |
| 11 | `analyse.flowPulse` | Home row "Flow Pulse"; palette "Flow Pulse (Field Simulation Lab)"; shelf Focus |
| 12 | `analyse.terrainAccess` | Home row "Terrain Access"; palette "Terrain Access (Field Simulation Lab)"; shelf Focus |
| 13 | `analyse.observatory` | Home row "Observatory"; palette "Observatory (observation evidence)"; shelf Focus |
| 14 | Command palette (no registry id) | Dock "Commands"; Ctrl or Cmd+K |
| 15 | `help.shortcuts` "Show keyboard shortcuts" | Key `?`; palette |
| 16 | `camera.top`, `camera.iso`, `camera.oblique`, `camera.planar` "<Name> view" | NavBar "Top", "Iso", "Oblique", "Planar"; palette; keys `T`, `O`, `P`; context menu "Oblique view" |
| 17 | `camera.view-*` "<Side> view (axis aligned)" | NavBar Views chips; palette; context menu "Top view", "Front view" |
| 18 | `camera.orthographic` "Orthographic projection" | NavBar "Ortho"; palette |
| 19 | `camera.plan-view` "Plan view" | NavBar "Plan"; palette |
| 20 | `view.save-state` "Save view state" | Right rail "+ Save current view"; key `V`; palette |
| 21 | `nav.reset` "Reset navigation to defaults" | Right rail "Reset to defaults"; palette |
| 22 | Theme, "<Theme> theme" | Top bar theme toggle; palette |
| 23 | Open a scan (no registry id) | Data home "Open scan"; empty state open button; right rail "+ Add dataset" |
| 24 | Close a scan (no registry id) | Dock "Close"; layer row `×` with "Close this scan?" |
| 25 | Session export (no registry id) | Measure panel "Export" (`.olvsession`); Export mode |

The dock's Probe (`tool.probe`) has no registry descriptor, so the Tools
launcher skips it (`ui/toolLauncher.ts:115`). It is reachable from the dock
only and is not a duplicate.

### Labels after C1

C1 applied CE-NAME-01 to the rows above. The name table is
`ui/actionNames.ts`, keyed by id in `ui/actionDescriptors.ts`. The registry
descriptors, the canvas menu, the Data home and the Measure panel read it; the
dock, the NavBar and the empty state write the names out and tests hold them to
it. Actions
with a control but no palette entry (rows 8, 14, 23, 24 and 25, plus Probe and
Help) have a descriptor in `SURFACE_DESCRIPTORS` in `ui/actionDescriptors.ts`. No control was removed.

| Action | Name | Changed copies |
| --- | --- | --- |
| `camera.frame-all` | Frame all | Dock "Frame" (the dock button now runs `camera.frame-all`); NavBar name "Frame the whole scan"; canvas menu "Frame scan" |
| `tool.inspect` | Inspect | Palette and launcher "Inspect point" |
| `tool.snapshot` | Save a snapshot | Dock "Snapshot" |
| `camera.top` and the other presets | Top view, Iso view, Oblique view, Planar view | NavBar names "Top camera view (T)" and so on; the chips still show the first word |
| `camera.view-*` | Top view (axis aligned) and so on | NavBar names "Top standard view" and so on; canvas menu "Top view", "Front view" |
| `camera.orthographic` | Orthographic projection | NavBar name "Toggle orthographic projection"; the chip shows "Ortho" |
| `camera.plan-view` | Plan view | NavBar name "Toggle plan view"; the chip shows "Plan" |
| `scan.open` | Open scan | Empty state "Open scan from device" |
| `session.export` | Export session | Measure panel "Export" |

A chip that shows a shorter form shows the start of the name, and its
accessible name is the full name.

## 5. Dead ends

A dead end is a surface with no visible, labelled way back (CE-EXIT-03).

| # | Viewport | Surface | Why |
| --- | --- | --- | --- |
| D1 | Desktop | Command palette | No close control. The only cue is the footer text "Esc close" |
| D2 | Desktop | Any rail page with the rail collapsed | Back sits in the hidden rail. The grabber reads "Show panel" and names no destination |
| P1 | Phone | Command palette | As D1 |
| P2 | Phone | A tool page with the sheet at peek | Starting a tool lowers the sheet to peek, which hides the task header and its Back. The handle reads "Expand panel" |

The desktop has 2 dead ends and the phone has 2.

Weak exits, labelled but outside the convention in CE-EXIT-01 and CE-EXIT-02:

- Router pages have Back but no Escape, and Back does not return focus to
  the opener.
- Contour Studio, the Range Workbench and Feature candidates have no exit of
  their own; the page's Back leaves them.
- Labs and ResultFocus leave through a bare `×` named "Close dialog", which
  does not name a destination.
- The Profile Workbench does not restore focus when it closes.
- The phone View tab hides the right rail's `×`.
- The Help overlay has no key to open it.

## 6. Panel pressure inventory

Each visible element is assigned one surface role from
[PRINCIPLES.md](PRINCIPLES.md#surface-roles). Codes: **LR** left rail,
**CTX** context tool panel, **VP** viewport, **RS** right side, **SS** status
strip, **WS** workspace page, **MOD** modal, **TT** tooltip. No status strip
exists yet, so every SS element currently lives somewhere else.

### 6.1 Left rail

| Where | Element | Role |
| --- | --- | --- |
| Frame | Mode tabs, task header, collapse grabber | LR |
| Data home | Layers list, "+ Add dataset", "+ New group", layer rows | LR |
| Data home | Layer CRS mismatch and excluded notes (`ui/Inspector.ts:1643`) | SS |
| Data home | Change detection: "Compare elevation", "Download difference (.asc)" (`ui/Inspector.ts:1683`) | CTX |
| Data home | Rows "Classes", "Source and metadata", "Layer Health" | LR (the last two link to SS facts in the right rail) |
| Classes | Show all, solo and hide per class | CTX |
| Classes | Derived, streaming and sample caveats | SS |
| Classes | "Colourblind-safe colours" (`ui/ClassLegendPanel.ts:246`) | RS |
| Tools home | Tool rows, "Placed so far" | LR |
| Measure | List, chain, profile chart, vertical stretch, sampler, summary, stations, clear | CTX |
| Measure | Geographic CRS notice, streaming and datum caveats | SS |
| Measure | Profile CSV and PDF export | CTX |
| Measure | Session "Export" and "Open" (`ui/MeasurePanel.ts:401`) | CTX, a copy of Export mode |
| Annotate | Sort, search, list, Edit, Clear all | CTX |
| Clip | Enable, Inside or Outside, axis limits, Fit to scan, readout | CTX |
| Analyse home | Rows with status and reason, remedies | LR |
| Analyse home | Inline "Run terrain analysis" | CTX |
| Analyse home | Lab rows | LR, opening MOD |
| Terrain | Verdict, Why?, run, status, fitness rows, method | CTX |
| Terrain | Dataset Story, evidence details, surface model stats, all metrics | WS |
| Terrain | Not-survey-grade footer | SS |
| Contours | Launcher, derived layers | CTX |
| Contours | "Contours in 3D": Show, Index emphasis, Opacity, Lift (`ui/AnalysePanel.ts:1310`) | RS |
| Contours | Deliverable: contours, DEM, intelligence report | CTX |
| Contours | Report metadata dialog | MOD |
| Objects | Override, planes, space measures, Report PDF, floor plan | CTX |
| Objects | Capture quality | SS |
| Features, Range | Launchers | CTX; the Range Workbench is WS |
| Export home | Format, compression, classification, CRS choice, summary, Export, products, images, report | CTX |
| Export home | Export health, no-CRS note | SS |
| Results shelf | Toggle, grouped rows, Focus, Export | LR |
| Results shelf | "Showing … from other layer" note | SS |

### 6.2 Right rail

| Element | Role |
| --- | --- |
| Title "Scan Intelligence", grabber | RS |
| Dataset Intelligence card | SS |
| Layers (phone only; on desktop it moved to Data) | LR |
| Layer Health card | SS |
| Color by, colour trim, elevation scale | RS |
| Elevation filter, intensity filter | CTX |
| Visuals Studio, Rendering | RS |
| Navigation group inside Rendering: invert, preset, "Reset to defaults" | CTX (input behaviour, not drawing) |
| Detail | SS |
| Provenance, with the capture type override | SS (the override is CTX) |
| Coordinate system, with the CRS override | SS (the override is CTX) |
| Scan report | SS |
| Saved views | VP |
| Session stats | SS |

### 6.3 Lab panels

| Lab | Element | Role |
| --- | --- | --- |
| All three | The modal frame | MOD, holding a whole workspace |
| Flow Pulse | Surface choice, click action, retry, "Export package (ZIP)" | CTX |
| Flow Pulse | Result grid, selection | WS |
| Flow Pulse | "Show flow accumulation", legend | RS |
| Flow Pulse | Story card, Limitations | SS |
| Terrain Access | Profile form, "Run Terrain Access", latest route, export | CTX |
| Terrain Access | Grid, inspector, selection | WS |
| Terrain Access | "Show traversability map" | RS |
| Terrain Access | Story, Limitations | SS |
| Observatory | Run, Sources, Evidence, Planning, Record and export | CTX |
| Observatory | 3D marker key | VP |
| Observatory | Shadow and its slice level | RS |

### 6.4 Mixed responsibilities

- **Right rail.** Of about fourteen blocks, four are drawing settings (Color
  by, Visuals Studio, Rendering, trim). The rest are status facts (Dataset
  Intelligence, Layer Health, Detail, Provenance, Coordinate system, Scan
  report, Session stats), task controls (two filters, two overrides,
  navigation preferences) and saved views.
- **Data home layers.** A task selection list that also holds change
  detection, an analysis with its own download.
- **Rendering section.** Holds navigation preferences, which change input,
  not drawing.
- **Measure page.** Holds session file export and open, which belong to
  Export.
- **Analyse pages.** Contours holds drawing settings ("Contours in 3D") and
  exports that repeat Export mode; Terrain packs workspace-page evidence into
  the rail.
- **Classes page.** Holds a drawing setting (colourblind-safe colours).
- **Data home rows.** "Source and metadata" and "Layer Health" are status facts
  shown only as links to the right rail.
- **Analyse home.** A task selection list with an inline run.
- **Labs.** Each is a workspace presented as a modal, with drawing toggles
  inside it.
- **Export home.** Holds status facts (export health, no-CRS note) and a CRS
  choice that repeats the right rail override.

Repeated elements, besides the actions in section 4: CRS facts (right rail,
Data home row, Export choice, coordinate readout, per-panel notices); Layer
Health (right rail card, Data home row); report PDFs (Export mode, Contours
deliverable, Objects page); the not-survey-grade and streaming caveats, stated
inline in five places with no single home.

## 7. Strip providers (CE-STRIP-00)

| Item | Canonical provider | State |
| --- | --- | --- |
| Dataset name | None. `ScanService.activeCloud()?.name` covers static scans only; streaming uses `viewer.streamingCloud.name`; `Inspector.sourceSummary()` derives it in the presentation layer | Missing |
| Horizontal CRS and unit | `CrsService.current()` and `.context()` (`geo/CrsService.ts:243`, `:263`), `SpatialContext` fields `crsName`, `epsg`, `linearUnit`, `linearUnitKnown` | Exists |
| Vertical reference | Same provider: `SpatialContext.verticalReference`, `verticalDatum`, `verticalEpsg`; labels from `geo/height.ts` | Exists. `main.ts:1561` re-derives `datumKnown` from raw metadata |
| Layer basis | `classifyCoverage` (`terrain/datasetIntelligence.ts:578`) is pure, but the live value is held by the right rail's Dataset Intelligence card | Partial: no app-level owner |
| Processing | Per-runner state only (Observatory runner phase, `resultSignals` lab runs, the streaming coordinator); the terrain runner has no public phase getter | Missing |
| Review and blocked count, worst glyph | Per-analysis statuses from `analysisRows` (`process/analysisStatus.ts:129`); no count or worst-state aggregate | Partial |

Dataset name, processing, and the review and blocked count each need a
provider before C4. Layer basis needs its owner moved out of the right
rail card. None of this may grow `main.ts` or derive values in the
presentation layer (CE-STRIP-00).

A second glyph collision exists besides `blocked` and `withheld` in
`ui/stateChip.ts:43`: the three reconstructed-origin states in
`ui/observatory/stateChip.ts:30` share one glyph and one word. C1 gives
`withheld` its own glyph (⊖) and colour token, and the three reconstructed
confidences a disc filled by three quarters, a half and a quarter (◕ ◑ ◔);
the word stays the same.

## 8. Journey baseline

The recorder is `tests/e2e/ceJourneys.spec.ts` with its bookkeeping in
`tests/e2e/journeyMetrics.ts` (unit test `tests/journeyMetrics.test.ts`). It
drives each journey through visible controls on the deterministic project and
counts clicks, surface switches, Back and Escape presses, key presses, form
fields and revisits. A surface is the active mode, its page, and any open
modal, workspace or palette. Clicks and surface switches are the primary
metrics and repeat exactly between runs. Time to the success signal depends
on the machine and is informational.

Record the baseline with:

```sh
OLV_CE_METRICS=docs/ux/metrics/ce-c0.json npx playwright test tests/e2e/ceJourneys.spec.ts --project=deterministic --workers=1
```

Results are in [metrics/ce-c0.json](metrics/ce-c0.json).

| Journey | Viewport | Clicks | Switches | Back | Esc | Other input | Success signal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| J1 first measurement | 1440×900 | 4 | 2 | 0 | 0 | none | Distance row reads "1.0000 m" |
| J2 measurement to export | 1440×900 | 2 | 1 | 0 | 0 | none | `.olvsession` download |
| J3 lab and back | 1440×900 | 5 | 5 | 1 | 0 | none | Observatory counts, then the Measure page |
| J4 recover orientation | 1440×900 | 3 | 2 | 2 | 0 | none | Analyse home, after reopening the rail |
| J5 trust check | 1440×900 | 0 | 0 | 0 | 0 | none | Layer Health reads "Vertical datum not established" |
| J6 phone J1 | 390×844 | 5 | 2 | 0 | 0 | none | As J1 |
| J6 phone J3 | 390×844 | 5 | 5 | 1 | 0 | none | As J3 |
| J7 Flow Pulse | 1440×900 | 5 | 4 | 1 | 0 | none | Story card names D8 routing |
| J7 Terrain Access | 1440×900 | 10 | 4 | 1 | 0 | 6 fields, 3 keys | Run card names the screening |
| J7 Observatory | 1440×900 | 2 | 2 | 0 | 0 | none | Evidence state counts |

What the baseline shows:

- J1 on the phone costs one more click than on the desktop: starting Measure
  lowers the sheet to peek, and the value is hidden until the sheet is raised.
- J3 needs the lab's `×` to leave, and returning to Measure goes through the
  Tools home, so it revisits a surface.
- J4 reads no location outside the rail with the rail collapsed and a
  workspace open, and needs three rail interactions (open the rail, Back
  twice). It does not yet meet the C2 condition of succeeding without the
  rail.
- J5 succeeds with no clicks on this fixture because the right rail is open by
  default and the Layer Health card states the missing datum in text. The
  card sits under the title "Scan Intelligence".
- J7: both Field Simulation labs start blocked on this fixture. The user
  follows "Prepare terrain", runs Terrain, and goes back before the lab row
  opens, which is one revisit each.

The recorded journeys touch the right rail once (J5) and none of its drawing
sections, so they give no task frequency for the section order in CE-VIEW-04.

## 9. Review screenshots

`tests/e2e/workspaceScreens.spec.ts` writes the review screenshots and
`layout.json` at six viewports when `OLV_UX_SHOTS` names a folder. They are not
committed.
