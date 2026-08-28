/**
 * analyseProfileVisibility.ts — remember the AnalysePanel's visibility across a
 * profile-workbench open, and restore it on close.
 *
 * Opening the Profile workbench hides the whole AnalysePanel to give the profile
 * chart room. That hide has to be reversible: closing the workbench must put the
 * AnalysePanel back to the visibility it had the instant the profile opened —
 * visible if it was visible, still hidden if the user had it hidden. The kind
 * change fires on open but not on close, so the close signal arrives separately
 * (main.ts wires it through the mount's onWorkbenchClose).
 *
 * The one hazard this guards is a scan close, which hides the panel and THEN
 * closes the workbench: the close must not resurrect the panel. `clear()` drops
 * the saved mark so a close-triggered restore is a no-op, and it is also called
 * whenever an explicit user choice or a new scan's route sets the visibility, so
 * a later restore can never override it.
 *
 * Pure and Node-testable: no Viewer, no DOM. main.ts passes accessors that read
 * and write the shell's live `analyseDesiredVisible`, panel, and dock.
 */

/** The shell hooks this controller reads and drives. */
export interface AnalyseProfileVisibilityDeps {
  /** Current tracked desired-visibility of the AnalysePanel. */
  getDesired: () => boolean;
  /** Write the tracked desired-visibility. */
  setDesired: (value: boolean) => void;
  /** Show/hide the mounted AnalysePanel (no-op before it mounts). */
  setPanelVisible: (value: boolean) => void;
  /** Reflect the Analyse dock button's active state. */
  setDockActive: (value: boolean) => void;
}

/** The save / restore / clear controller main.ts drives. */
export interface AnalyseProfileVisibility {
  /** Profile open: save the pre-profile visibility once, then hide the panel. */
  hideForProfile(): void;
  /** Workbench close: restore the saved visibility, then drop the mark. */
  restore(): void;
  /** Drop the mark so a pending restore becomes a no-op. */
  clear(): void;
}

export function createAnalyseProfileVisibility(
  deps: AnalyseProfileVisibilityDeps,
): AnalyseProfileVisibility {
  // Null = not currently hidden-for-profile; a boolean = the visibility to
  // restore when the workbench closes.
  let before: boolean | null = null;
  return {
    hideForProfile() {
      if (before === null) before = deps.getDesired();
      deps.setDesired(false);
      deps.setPanelVisible(false);
      deps.setDockActive(false);
    },
    restore() {
      if (before === null) return;
      const value = before;
      before = null;
      deps.setDesired(value);
      deps.setPanelVisible(value);
      deps.setDockActive(value);
    },
    clear() {
      before = null;
    },
  };
}
