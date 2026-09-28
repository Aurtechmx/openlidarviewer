# Community wayfinding specification

Specification CE-1 for OpenLiDARViewer 0.7, the community edition. It makes the
interface easy to navigate without changing any scientific output.

The rules behind these requirements are in [PRINCIPLES.md](PRINCIPLES.md).
Work that the principles describe but this file does not name is left for later
editions (see [Direction for later editions](PRINCIPLES.md#direction-for-later-editions))
and is not started here.

**Shall** is mandatory and testable. Requirement IDs (`CE-…`) are how tests,
ledger entries and pull requests refer to this document.

## 0. The problem this release solves

People get lost in the viewer. Each cause below has a fix in this release.

| Cause | Effect on a user | Fix |
| --- | --- | --- |
| Location lives only in the left rail's tab and task header. With the rail collapsed, a lab open, or the phone sheet lowered, nothing on screen says where you are. | "Where am I, and how did I get here?" | Location bar (§3) |
| Many ways to move around, each with its own close or back convention: rail modes and pages, dock, top bar, right rail, NavBar, three modal labs, three workspaces (Contour Studio, Profile Workbench, Range Workbench), `ResultFocus`, command palette. | Every surface must be learned separately | One exit convention (§4) |
| Flow Pulse, Terrain Access and Observatory are long workflows opened as modals. The modal hides the scan and the rail. | Losing the scene and the way back | Labs become Analyse pages (§5) |
| The same action appears in several places with different strings. Frame is "Frame" in the dock, "Frame the whole scan" in the NavBar, and "Frame all" in the registry. Measure, Annotate and Analyse are in the dock, the rail and the launcher. | Unsure if two buttons do the same thing | One name per action (§6) |
| Each mode silently remembers its page, so clicking **Analyse** can land in the middle of Contours. | Arriving somewhere unexpected | Mode home with a Continue row (§7) |
| The right rail's visible title is **Scan Intelligence** and the tour calls it **Inspector**, but it holds view settings. The phone already calls the same content **View**. | Looking in the wrong place | Rename to View (§8) |
| Units, coordinate system, vertical reference and completeness are spread over several cards. | Unsure whether a number can be trusted | State strip (§9) |

Design intent, shared with [PRINCIPLES.md](PRINCIPLES.md#design-intent):

> At every moment the screen says where you are, how to get back, and what is
> true about the data. Every action has one name.

## 1. Scope rules

- **CE-SCOPE-01 No new runtime dependencies.** A development-only dependency
  (an accessibility audit) is allowed only as decided in §12 (CE-ASK-04).
- **CE-SCOPE-02 Preferences and test hooks keep working.** Persisted keys, DOM
  ids and `data-*` hooks keep working. Where one must change, a migration and a
  test ship with it (CE-ASK-03).
- **CE-SCOPE-03 Zero growth.** The initial chunk does not grow
  (`check:bundle`). `src/main.ts` and `src/render/Viewer.ts` do not grow.
  `Inspector.ts`, `AnalysePanel.ts` and `MeasurePanel.ts` may only shrink.
  Dynamic imports in modules under the live transform follow
  `lint:inline-imports` and go through `src/lazyChunks.ts`.
- **CE-SCOPE-04 No scientific change.** No computed value, threshold, method or
  export changes. Presentation reads canonical state and never derives it.
- **CE-SCOPE-05 Nothing later editions must tear out.**
  - The location bar reads the router.
  - The state strip reads one provider per item. A provider is a pure function
    of canonical state that returns `{ value, source, validity }`: the display
    value, where it came from, and a state from the existing state grammar.
    It computes nothing new.
  - No second selection mechanism is added.
- **CE-SCOPE-06 Every change is proved.** Every change has a test, and every
  workflow change has journey numbers before and after (§11.4).

Left for later editions: the object model, selection service and verb
registry; a selection-driven inspector; lenses, living results, ghost states,
linked views and Compare; a density preference; expanded undo.

## 2. Baseline (re-verified in C0)

| Piece | Where | Used for |
| --- | --- | --- |
| Route state `{ mode, page }`, per-mode page memory (`olv.workspace.left.page`), `back()` to parent or home, a task header with Back, no URL or history | `src/app/workspace/workspaceRouter.ts` | Location bar source; Continue row |
| Pages. Tools: `measure`, `annotate`, `clip`. Data: `classes`. Analyse: `terrain`, `contours` (parent `terrain`), `objects`, `features`, `range` | `workspaceShell.ts`, `analyseWorkspace.ts` | Location bar titles; palette Go to |
| Labs opened as modals, as stated in `analyseWorkspace.ts:10`: "Flow Pulse, Terrain Access and Observatory labs stay modals" | `ui/fieldSimulation/flowPulseLab.ts`, `terrainAccessLab.ts`, `ui/observatory/observatoryPanel.ts`, and `resultsShelf` `openInModal` | Labs to pages (§5) |
| Tool activation navigates the rail | `workspaceShell.openToolPage`, `resumeToolPage` | Already one route per tool |
| Action registry feeding launcher, palette and Help | `ui/actionRegistry.ts`, `toolLauncher.ts`, `HelpOverlay.ts` | One name per action (§6) |
| Frame: dock label "Frame" (`ui/toolDock.ts:109`), NavBar name "Frame the whole scan" (`ui/NavBar.ts:333`), registry title "Frame all" for `camera.frame-all` (`app/actions/cameraActions.ts:113`) | as listed | One name per action (§6) |
| Right rail title "Scan Intelligence" (`ui/Inspector.ts:1023`); tour step title "Inspector" (`ui/onboarding/tourSteps.ts:85`); phone tab "View" with title "How the scan is drawn: colour, point size, rendering, visuals." (`ui/MobileSheet.ts:75`) | as listed | Rename (§8) |
| State grammar, and the `blocked`/`withheld` glyph collision (same glyph, same colour alias); the three reconstructed-origin states in `ui/observatory/stateChip.ts` also share one glyph | `ui/stateChip.ts`, `ui/observatory/stateChip.ts`, `styles/01-tokens.css` | Strip (§9), glyph fix |
| Modal primitive with Escape, focus trap and restore; `ResultFocus` is built on it | `ui/Modal.ts`, `ui/ResultFocus.ts` | Exit convention |
| Polite announcements through `announcePolite` | `ui/politeAnnounce.ts` | CE-LOC-05 |
| Screenshot harness at six viewports (`OLV_UX_SHOTS`); 95 e2e specs, including `goldenJourney`, `workspaceJourneys`, `workspaceScreens`, `workspaceRouter`, `phoneWorkspace`, `flowPulseLab`, `terrainAccessLab`, `observatoryPanel`, `resultsShelf`, `commandPalette` | `tests/e2e/` | Proof |
| Colour literals outside `01-tokens.css`: 511 occurrences, 199 unique, in 35 files. Declarations with a px font size: 5 | `src/**/*.css` | Ratchet (§11.3) |
| `@fontsource-variable/inter` declared, never imported | `package.json`, `src/globals.d.ts` | Hygiene (CE-ASK-05) |

Counting method for the colour and font rows: every `.css` file under `src/`
except `01-tokens.css`, with `/* … */` comments removed. A colour literal is a
hex colour (`#` plus 3 to 8 hex digits) or an `rgb()`, `rgba()`, `hsl()` or
`hsla()` call; unique values are compared lowercased with whitespace removed.
A px font size is a `font` or `font-size` declaration containing a px length.
C0 re-counted both numbers and the e2e spec count on main and found them
unchanged. C1 re-baselines the colour and font numbers with the lint it adds.
The surfaces, duplicates and dead ends behind this table are in
[NAVIGATION_MAP.md](NAVIGATION_MAP.md).

The top bar has no back-to-centre control. The header comment in
`ui/headerControls.ts:4` still mentions one and is stale.

### Already merged

These pieces of the release are on main and are not rebuilt:

- Back on task pages (#1120).
- 24 and 44 CSS px pointer targets (#1121).
- One rail surface (#1127).

## 3. Location bar

- **CE-LOC-01 Placement.** A single line in the top bar's left cluster, after
  the product mark, shows the current location as crumbs, for example
  `Tools › Measure`, `Analyse › Terrain › Contours`, `Analyse › Observatory`,
  `Data`. When a workspace is open it is appended:
  `Analyse › Terrain › Contour Studio`. A modal decision leaves the bar
  unchanged.
- **CE-LOC-02 Single source.** Crumbs are derived only from router state and
  page titles, plus a registered name for each workspace. No surface sets crumb
  text directly.
- **CE-LOC-03 Always visible.** The bar is visible with the left rail
  collapsed, with a workspace open, on the phone as the heading of the sheet in
  every detent including peek, and in all three themes and forced colours.
- **CE-LOC-04 Navigable.** Every crumb except the last is a button that
  navigates to that level. The last crumb has `aria-current="location"`. Each
  crumb's accessible name reads its full path.
- **CE-LOC-05 Announced.** A route change announces the new location once
  through `announcePolite`.
- **CE-LOC-06 Palette Go to.** The command palette gains one entry per
  registered page and workspace (`Go to Measure`, `Go to Contours`), generated
  from the same page registry. An unavailable page (no scan, a blocked
  prerequisite) shows as disabled with its one-line reason.

## 4. One exit convention

- **CE-EXIT-01 Visible way back.** Every non-home surface shows, in the same
  position, a Back control that names its destination: `← Tools`,
  `← Terrain`, `← Back to scan`. This covers task pages, labs, workspaces and
  `ResultFocus`. Workspaces say `Close Contour Studio` rather than a bare
  `Close`.
- **CE-EXIT-02 Escape.** Escape cancels the innermost transient first: an open
  popover or menu, then an active tool capture (for example a measurement in
  progress), then the surface. Escape does not navigate while a text field has
  focus or a drag is in progress. Otherwise Escape performs the same action as
  Back, and focus returns to the control that opened the surface.
- **CE-EXIT-03 No dead ends.** A dead end is a surface with no visible,
  labelled way back. None are allowed. A test visits every route and workspace
  at desktop and phone sizes.
- **CE-EXIT-04 One transient surface.** Opening the palette, a result focus or
  a popover closes any other transient surface first.

`ResultFocus` already has Escape, focus trap and focus restore through `Modal`;
CE-EXIT-01 adds only its named Back label.

## 5. Labs become Analyse pages

This reverses the current choice, made with #1121, to reopen lab results in
modals. The reason is the surface rule in
[PRINCIPLES.md](PRINCIPLES.md#where-does-this-go): a surface people keep open while
looking at the point cloud is not a modal. The reversal is
decided (CE-ASK-07).

- **CE-LAB-01 Registration.** Flow Pulse, Terrain Access and Observatory are
  registered as Analyse router pages: `flow-pulse` and `terrain-access` with
  parent `terrain`, and `observatory` as a top-level page. Their existing lab
  components are re-parented into page shells, not rewritten, following the
  pattern `analyseWorkspace.ts` uses for Terrain.
- **CE-LAB-02 Scene stays visible.** The scene stays visible and navigable
  while a lab page is open. Any lab overlay draws in the viewport as it does
  today.
- **CE-LAB-03 Rows and results.** The Analyse home rows open the pages.
  `resultsShelf` routes these results to their pages instead of
  `openInModal`.
- **CE-LAB-04 Modals keep their job.** A short blocking question inside a lab
  stays a modal: a confirm, an irreversible action, a file choice.
- **CE-LAB-05 Tests migrate with the change.** `flowPulseLab.spec.ts`,
  `terrainAccessLab.spec.ts` and `observatoryPanel.spec.ts` open by route.
  Their scientific assertions are unchanged, byte for byte.
- **CE-LAB-06 Purpose line.** Each lab page opens with one sentence naming
  the question it answers, and one line naming what it needs (for example a
  scan with ground classified, a terrain run, or a chosen area).
- **CE-LAB-07 Readiness checklist.** Before the run control, the page lists
  each prerequisite with its state, met or missing. Each missing item has a
  button that takes the user to where it is fixed. While any item is missing,
  the run control is disabled and shows the reason beside it, in text, without
  hover (UX-D10 level 3).
- **CE-LAB-08 Numbered stages.** Each lab shows its workflow as 3 to 5
  numbered stages (for example Choose area, Set parameters, Run, Read result,
  Export), with the current stage marked as current in text and through
  `aria-current="step"`. Microcopy names only the next step (UX-D11).
- **CE-LAB-09 Reading the result.** After a run, a "How to read this" block
  of 2 to 4 lines beside the result names what the colours or markers mean
  and links to the method text. No scientific value changes.
- **CE-LAB-10 First-use example.** When a bundled fixture exists, each lab's
  empty state offers "Try it on the sample scan". Otherwise it names the one
  action that fills it (UX-D12).
- **CE-LAB-11 Labs stay lazy.** Lab code loads through `src/lazyChunks.ts`,
  never from the initial chunk. The Viewer chunk has about 1 KiB of headroom,
  so page shells add no static import of lab code.

## 6. One name per action

- **CE-NAME-01 Labels from the registry.** Dock, NavBar, top bar, launcher,
  palette, Help and context-menu labels for the same action come from the
  action registry descriptor. Tooltips from the same descriptor may add context
  but never rename. A unit test compares every rendered label against the
  registry.
- **CE-NAME-02 Duplicates.** C0 lists every action reachable from more than
  one persistent surface. No control is removed this release (CE-ASK-02);
  every copy takes the registry label. This covers:
  - **Frame:** keep it in the dock and on the `R` key, with the registry name;
    the NavBar copy stays and takes the registry label too.
  - **Dock Analyse:** it opens the Analyse home.
- **CE-NAME-03 Mode and dock agree.** A dock tool that opens a rail page shows
  the same pressed state as the rail's active page. Two surfaces never disagree
  about what is active.

## 7. Predictable mode tabs

- **CE-MODE-01 Mode home (CE-ASK-01).** Clicking a mode tab
  opens that mode's **home**. The home's first row is **Continue: \<page\>**
  when the mode has a remembered page, naming the page and its state, for
  example `Continue: Measure · 3 measurements`. This keeps the memory users
  rely on and removes the surprise landing. This work overlaps the router changes already on main; the WebKit
  heading-focus behaviour after a rail click (#1128) is retested with it.
- **CE-MODE-02 Stored page key.** `olv.workspace.left.page` keeps its meaning
  (the remembered page), so no stored preference is stranded.

## 8. Right rail becomes View

- **CE-VIEW-01 Labels.** The right rail's visible title (today "Scan
  Intelligence"), its collapse-toggle label, the tour step (today "Inspector"),
  and Help references read **View**, the label the phone already uses.
- **CE-VIEW-02 Subtitle.** A one-line subtitle reads "How the scan is drawn",
  reusing the phone's existing wording.
- **CE-VIEW-03 Unchanged internals.** Ids, classes, storage keys and the
  `Inspector` module name stay as they are. The name "Inspector" is kept for
  a later selection inspector.
- **CE-VIEW-04 Section order.** Sections follow task frequency, measured in C0
  from the screenshot journeys: appearance, then filters, then navigation,
  then saved views. Change detection gets a link row,
  `Two-epoch change detection → Analyse`; its controls stay where they are.

## 9. Scientific state strip (read-only)

- **CE-STRIP-00 Providers first.** Before C4 starts, C0 confirms a canonical
  provider exists for each item in CE-STRIP-02. Where one does not, creating it
  shall not grow `main.ts` and shall not derive values in the presentation
  layer.
- **CE-STRIP-01 Placement.** One row across the foot of the viewport on
  desktop, and a compact row above the dock on the phone, shown whenever a
  scan is open.
- **CE-STRIP-02 Items.** Each item is read through its provider
  (CE-SCOPE-05): dataset name; horizontal CRS and unit; vertical reference, or
  `Vertical: unknown`; basis of the active layer (full, resident-only or
  sampled); processing (idle, or task and progress); open review and blocked
  states, as a count plus the worst glyph.
- **CE-STRIP-03 Interaction.** Each item is a labelled button that navigates to
  where the fact is explained (CRS goes to Data; the warnings count goes to a
  list of the affected items). There are no other controls.
- **CE-STRIP-04 Glyph fix.** `withheld` gets its own glyph and a distinct
  state token, different from `blocked`. All glyph-only renders are re-tested.
- **CE-STRIP-05 Severity placement.** The strip carries level 0 status and the
  presence of level 2 cautions, following the severity table in
  [PRINCIPLES.md](PRINCIPLES.md#state-and-feedback) (UX-D10). Level 1 notes stay
  inline beside their result. Level 3 blockers stay in the tool. Level 4 stays
  a confirmation modal. The strip never shows a toast or modal of its own.

## 10. Measure: the model workflow

The most-used task gets the full treatment, and later tasks copy it.

- **CE-MEA-01 Task states.** The Measure page follows this table. Each state
  has one line of microcopy and at most one primary action.

  | State | Controls shown | Cursor | Escape | Microcopy |
  | --- | --- | --- | --- | --- |
  | IDLE (no scan) | None active; the empty state | Default | Leaves the page | Names what the tool measures and that a scan must be open |
  | READY | Measurement type; primary: none until the first click | Crosshair | Leaves the page | One line on what the first click does |
  | CAPTURING | Undo last point, Cancel | Crosshair with snap feedback | Cancels the capture, stays on the page | The next step only |
  | RESULT | Value with unit, caveats, primary: Export or Save | Crosshair (ready for the next) | Clears the selection, then leaves | The result, then what to do with it |

- **CE-MEA-02 Warning placement.** Warnings sit beside the value they affect,
  using the existing caveat primitive and state chips, never only in a
  tooltip.
- **CE-MEA-03 Numbers.** Result values use tabular figures, with the unit
  beside the value (non-breaking space). Display precision follows the existing
  formatters, unchanged in value.
- **CE-MEA-04 Empty state.** The empty state names what fills it and the one
  action that does. Wording rule: "\<What appears here\>. \<Verb\> to add one."
  for example "Measurements appear here. Click two points in the scan to add
  one."
- **CE-MEA-05 One primary action.** At most one primary button per state.

## 11. Proof

### 11.1 New e2e specs

Deterministic project, six viewports where the harness supports it.

| Spec | Asserts |
| --- | --- |
| `ceLocation.spec.ts` | For every route and workspace, the location bar text equals the route path. It is visible with the rail collapsed and at 390×844. Crumbs navigate (CE-LOC) |
| `ceExit.spec.ts` | Every non-home surface has a visible, labelled Back naming its destination. Escape follows CE-EXIT-02 and focus is restored. No dead ends (CE-EXIT) |
| `ceLabsAsPages.spec.ts` | Each lab opens as a page, the canvas stays visible and interactive, and Back returns to its parent (CE-LAB-01 to 05) |
| `ceLabGuidance.spec.ts` | Each lab page shows its purpose line, a readiness checklist whose missing items link to their fix, a disabled run control with a visible reason while anything is missing, 3 to 5 numbered stages with one current, a "How to read this" block after a run, and a first-use action in its empty state (CE-LAB-06 to 10) |
| `cePaletteGoTo.spec.ts` | Every registered page is reachable by `Go to …`. Unavailable pages show their reason (CE-LOC-06) |
| `ceModeHome.spec.ts` | A mode tab opens its home with the Continue row when a page is remembered (CE-MODE) |
| `ceStrip.spec.ts` | On the unknown-vertical, feet-unit, resident-only and stale fixtures, each fact is visible in the strip without hover (CE-STRIP) |
| `ceGlyphs.spec.ts` | Glyph-only state renders are pairwise distinct (CE-STRIP-04) |
| `ceTargets.spec.ts` | Controls added or changed in this release are at least 24×24 CSS px (WCAG 2.2 SC 2.5.8, level AA), and 44×44 CSS px on touch viewports as a house target. No AAA claim is made |

### 11.2 Unit tests

- Labels match the registry (CE-NAME-01).
- The crumb derivation is a pure function of route plus registry.
- Strip providers return canonical values unchanged.
- The Measure page renders the microcopy and primary action of each state in CE-MEA-01.

### 11.3 Ratchets (shrink-only)

Both lints run in `test:release` (the static group of `scripts/gates.json`),
with their banked counts in `docs/validation/style-tokens-baseline.json` and
`docs/validation/tooltip-length-baseline.json`. `--update` banks a drop and
refuses a raise. `lint:ux-rules` checks the house rules source text can decide
(UX-D4, no `<details>` written inside another) and states which rules it
leaves to review.

- `lint:style-tokens`: colour literals and px font sizes outside
  `01-tokens.css`, counted as in §2, starting from the C0 baseline. Files this
  release touches reach 0.
- `lint:tooltip-length`: 160 characters.

### 11.4 Wayfinding journeys

Journeys run locally, scripted on the existing `workspaceJourneys` A to F
harness, and are recorded in `docs/ux/metrics/ce-<phase>.json`. C0 adds the
recorder: clicks, surface switches, Back and Escape presses, and time to the
success signal.

- **J1 First open to first measurement.** Open a fixture, measure one
  distance, read its value and unit.
- **J2 Measurement to export.** From a finished measurement, export
  measurements.
- **J3 Lab and back.** Open Observatory from Analyse, run it on the fixture,
  return to Measure.
- **J4 Recover orientation.** With the rail collapsed and a workspace open,
  read the current location from the location bar and return to the scan.
- **J5 Trust check.** On the unknown-vertical fixture, find the vertical
  reference of a height value.
- **J6 Phone.** J1 and J3 at 390×844.
- **J7 First lab use.** From the Analyse home, run Flow Pulse, Terrain Access
  and Observatory each to a result with no outside help. Records clicks,
  stages revisited and time, in addition to the common measures.

Before C2 and after C5, every journey (J7 before and after C3) is equal or better on clicks and surface
switches. J4 succeeds without any rail interaction.

### 11.5 Review pack

Each phase regenerates the `OLV_UX_SHOTS` screenshots, before and after, with
a one-page checklist: the 3-second orientation test, the
return-after-interruption test (both in
[PRINCIPLES.md](PRINCIPLES.md#review-checklist)), and the dead-end list, which
must be empty.

## 12. Decisions

- **CE-ASK-01 Mode tabs (decided).** A mode tab opens the mode home, whose first row is `Continue: <page>` when a page is remembered (CE-MODE-01).
- **CE-ASK-02 Duplicates (decided).** No duplicate control is removed this release. Every duplicate uses the registry label; Frame stays in the dock and the NavBar, both labelled from `camera.frame-all`.
- **CE-ASK-03 Persisted keys and selectors (decided).** All are kept. Any unavoidable change ships with a migration and a test.
- **CE-ASK-04 Accessibility audit dependency (decided).** `@axe-core/playwright` is added as a development-only dependency.
- **CE-ASK-05 Unused font package (decided).** `@fontsource-variable/inter` is removed after the typeface change on main lands.
- **CE-ASK-06 Visual identity (decided).** Out of scope for this specification.
- **CE-ASK-07 Labs as pages (decided).** Labs become Analyse pages in C3, and the results shelf routes their results to those pages. This supersedes reopening lab results in modals (#1121).

## 13. Phases

Each phase passes its gates before the next starts, and `npm run lint:v070-status`
stays green.

| Phase | Scope | Exit evidence |
| --- | --- | --- |
| C0 | Audit and map. Re-verify §2. Write `docs/ux/NAVIGATION_MAP.md`: every surface, how it is entered and left, its names, and the duplicates list. Panel pressure inventory: every visible element assigned one surface role from [PRINCIPLES.md](PRINCIPLES.md#surface-roles), with duplicates and mixed responsibilities listed. Confirm strip providers (CE-STRIP-00). Build the journey recorder and record the J1 to J7 baseline and screenshots. | Map, inventory, baseline JSON, screenshots |
| C1 | Action labels from the registry, glyph fix, token and tooltip ratchets, `ceGlyphs` and `ceTargets` specs | Unit and e2e green; ratchets live in `test:release` |
| C2 | Location bar, palette Go to, exit convention on every surface | `ceLocation`, `cePaletteGoTo`, `ceExit` green; J4 passes |
| C3 | Labs to Analyse pages with purpose, readiness, stages, reading aid and first-use example (per CE-ASK-07); right rail renamed View; mode home and Continue (per CE-ASK-01); registry labels on every duplicate | `ceLabsAsPages`, `ceLabGuidance`, `ceModeHome` green; J7 better than its C0 baseline; migrated lab specs green with unchanged scientific assertions |
| C4 | State strip | `ceStrip` green |
| C5 | Measure model workflow; tour teaches the location bar, Back and strip in three steps; hardening across themes and viewports | J1 to J7 equal or better than C0; `npm run test:release` passes |

## 14. Requirements and the principles they implement

| Requirement | Principle |
| --- | --- |
| CE-LOC | Law 4 (keep it visible); design intent: where you are |
| CE-EXIT | Design intent: how to get back; UX-D22 (closing never destroys state) |
| CE-LAB | Surface roles (modal only for short blocking decisions); Law 1; UX-D10, UX-D11, UX-D12 for CE-LAB-06 to 10 |
| CE-NAME | UX-D17 (one name per action); UX-D18 (icons supplement labels) |
| CE-MODE | Law 4; UX-D8 (active state unmistakable) |
| CE-VIEW | Surface roles (right side shows view settings); UX-D21 (source vs view state) |
| CE-STRIP | Law 5 (hide complexity, never validity); UX-D9; UX-D10 |
| CE-MEA | UX-D2, UX-D11, UX-D12, UX-D14, UX-D15, UX-D16 |
| ceTargets | Accessibility section (24 px AA, 44 px touch house target) |

## 15. Definition of done

- At every route and workspace, on desktop and phone, the screen shows where
  the user is (location bar), how to get back (labelled Back and Escape), and
  what is true about the data (strip).
- Every action has one name.
- No lab hides the scan.
- No surface is a dead end.
- The glyph collision is fixed.
- Ratchets are live and lower than baseline.
- J1 to J7 are equal or better than C0, and J4 succeeds without touching the rail.
- No scientific output changed; the lab specs' scientific assertions are unchanged.
- Bundle and monolith budgets hold.
- `npm run test:release` passes.
