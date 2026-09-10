# Scene mode: appearance controls move out of the right rail

Date: 2026-09-10
Status: design approved, not implemented
Target: v0.6.9. Not v0.6.8: it moves panels between modes and touches the mobile
sheet while a release tag is pending.

## The problem, as reported

Measuring, and not knowing whether the metres are real.

Beside it, a second complaint: the Work mode holds three thin panels while other
surfaces carry far more than they can present. The right rail (`Scan
Intelligence`) is always visible and holds twelve sections.

## What is already there

The first problem is not an absence. `src/render/measure/measurementTrust.ts`
computes a per-measurement grade, caps it at yellow when the linear scale is
unresolved, and refuses outright (red) on a geographic frame or a compound
vertical-unit mismatch. `src/ui/MeasurePanel.ts` renders that grade as a
coloured dot beside the value and a context line under it.

The predicate behind it is correct. `measure.crsKnown` reads as "a CRS exists",
which would wrongly pass a projected CRS with no UNIT clause, but `src/main.ts`
feeds it `ctx.linearUnitKnown`. The name is wrong; the value is not.

So the panel already knows and already says so. Three presentation faults stop
it landing.

1. The number outranks the warning. `12.43 m` is an explicit claim in the
   row's strongest typography; beside it sits a six-pixel dot. The label is what
   gets copied into a report.
2. The reason is hover-only. The sentence explaining the caution lives in a
   `title` attribute: unreachable by keyboard, unreachable by touch, unseen by
   anyone reading rather than pointing. `src/ui/ProcessStudioPanel.ts` states
   that principle in a comment and this panel breaks it.
3. The unit toggle offers a false choice. Metric ↔ Imperial stays live on a
   scan with no resolved scale, and converting a nominal 12.43 into 40.78 ft
   asserts a metre-to-foot relationship the frame never established.

## Decisions

### The figure carries its own unit

When the linear scale is unresolved, a length reads `12.43 units`, an area
`86.10 units²`, a volume `units³`, the vocabulary `src/units/units.ts` already
uses. No new wording. The terrain panel, the measurement CSV columns and the
map sheet already answer this way; the measurement panel is the surface that
still does not.

No panel-level caveat strip. It would restate in prose a verdict the row already
carries, and a caveat above a number loses to the number.

### The reason moves into the visible context line

`MeasurePanel` already renders a context line under each measurement. The trust
reason goes there. The dot, its grade and its tooltip stay exactly as they are;
this adds a visible channel rather than replacing the existing one.

### The unit-system toggle is disabled while nothing is verified

Disabled, with the reason on the control. The setting itself is untouched, so
resolving a CRS restores the user's previous choice.

### Work is renamed Scene, and gains the appearance controls

Five sections leave the right rail: Colour by, Elevation filter, Intensity
filter, Visuals Studio, Rendering. They describe how the scan is being looked
at, not what it is. The rail keeps seven: Dataset Intelligence, Detail,
Provenance, Coordinate system, Scan report, Saved views, Session stats. Every
one of them is then a fact about the data.

The mode id stays `work`. `WORKSPACE_MODE_KEY` in
`src/ui/workspace/DesktopWorkspace.ts` persists mode ids, so changing the id
resets the saved mode for every existing user. Only the label changes.

## How it is built

The seam exists. `Inspector.workspaceDataElements()` hands live nodes to the
workspace, which re-parents them; the Inspector keeps updating the same nodes.
Layers and Layer Health already travel this way. This extends the returned set
and the `WorkspacePanels` contract in `src/ui/workspace/DesktopWorkspace.ts`;
`layoutDesktop` mounts the five into the `work` host.

Two constraints the implementation has to honour.

*Every moved section needs a surface.* A section styled for the Inspector has
no background of its own. Moved to the rail it becomes a top-level child and
reads over the point cloud, the Layers defect fixed in `561d8054`. One rule
covering the moved sections, not five copies of it.

*Mobile keeps the Inspector whole.* `src/main.ts` appends the entire Inspector
into the mobile sheet's `view` slot, and Layers already has a return path there.
The five sections need the same, or they disappear on a phone.

## Testing

- The five sections mount into the `work` host on desktop, and reach the mobile
  sheet on the mobile path. Mirrors the existing workspace mount tests.
- Every section moved into the rail computes an opaque background there and
  stays transparent inside the Inspector.
- A length on a frame with no resolved linear unit reads `units`, and on a
  resolved metre frame reads `m`. Driven through the live predicate the panel
  actually receives, not a hand-set flag.
- The reason text is present in the rendered context line, not only in a `title`.
- The unit-system toggle is disabled on an unresolved frame and enabled on a
  resolved one, with the stored preference unchanged across both.
- The persisted mode id is still `work` after the rename.

## Risks

- A saved mode reads `work` while the tab says Scene. Accepted: the id is
  internal and the alternative resets every user's saved mode.
- The rail is emptier than some users expect. The seven remaining sections
  are the ones a reader consults about the data; the five that move are the ones
  used while shaping a view, next to the tools that use them.
- Five re-parented sections is five chances to repeat the surface bug. The
  test above is the guard.

## Out of scope

Rearranging Data, Analyse or Output. Changing what any moved section does. Any
change to the trust grade, its thresholds or its wording. Adding a fifth mode.
