/**
 * actionNames.ts
 *
 * One name per action (CE-NAME-01). Every surface that offers an action (the
 * dock, the NavBar, the top bar, the Tools launcher, the command palette, Help
 * and the canvas context menu) shows the name defined here, and the action
 * modules build their registry descriptors from it. A tooltip may add context
 * after the name; it never replaces it. The startup modules (the dock, the
 * NavBar and the empty state) write the name out so the initial chunk carries
 * no lookup; `tests/actionNames.test.ts` and `tests/e2e/ceNames.spec.ts` hold
 * each of those copies to this file.
 *
 * `actionDescriptors.ts` keys these names by registry id, and its
 * `SURFACE_DESCRIPTORS` covers the actions that have a control but no palette
 * entry (the palette itself, Help, closing a scan, the live probe and the
 * Analyse mode), so they have a registry descriptor too. Opening a scan,
 * saving and opening a session and the PDF report used to be left out of the
 * palette on purpose, as file-picker and download actions; they are listed
 * now, so a user who searches for them finds them.
 *
 * Pure data with no imports, so the startup shell can read it without pulling
 * in the palette matcher or the id table.
 */

export const FRAME_ALL = 'Frame all';
export const ORTHOGRAPHIC = 'Orthographic projection';
/** The projection command's title while the scene is already orthographic. */
export const PERSPECTIVE = 'Switch to perspective projection';
export const PLAN_VIEW = 'Plan view';
export const NAVIGATION_PANEL = 'Show navigation panel';
export const MEASURE = 'Measure';
export const INSPECT = 'Inspect';
export const PROBE = 'Probe';
export const ANNOTATE = 'Annotate';
export const CLIP_BOX = 'Clip box';
export const SAVE_SNAPSHOT = 'Save a snapshot';
export const COPY_VIEW_LINK = 'Copy view link';
export const ANALYSE = 'Analyse';
export const COMMANDS = 'Commands';
export const HELP = 'Help';
export const OPEN_SCAN = 'Open scan';
export const CLOSE_SCAN = 'Close scan';
export const SAVE_SESSION = 'Save session';
export const OPEN_SESSION = 'Open session';
export const REPORT_PDF = 'Report PDF';

/** A camera preset's name, from the preset's own label ("Top" gives "Top view"). */
export function cameraPresetTitle(label: string): string {
  return `${label} view`;
}

/** A standard axis view's name ("Front" gives "Front view (axis aligned)"). */
export function standardViewTitle(label: string): string {
  return `${label} view (axis aligned)`;
}
