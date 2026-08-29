import type { WorkflowController } from '../ui/WorkflowController';

/**
 * The mutually-exclusive interaction tools that toggle a Viewer mode and are
 * recorded by the workflow recorder. Probe is deliberately excluded: no path
 * records a probe toggle, so it is not funnelled through here.
 */
export type ToggleableTool = 'measure' | 'inspect' | 'annotate';

/** The slice of the Viewer this helper needs — a getter and a setter per tool. */
export interface ToolToggleViewer {
  readonly measureMode: boolean;
  readonly inspectMode: boolean;
  readonly annotateMode: boolean;
  setMeasureMode(on: boolean): void;
  setInspectMode(on: boolean): void;
  setAnnotateMode(on: boolean): void;
}

const READ: Record<ToggleableTool, (v: ToolToggleViewer) => boolean> = {
  measure: (v) => v.measureMode,
  inspect: (v) => v.inspectMode,
  annotate: (v) => v.annotateMode,
};

const WRITE: Record<ToggleableTool, (v: ToolToggleViewer, on: boolean) => void> = {
  measure: (v, on) => v.setMeasureMode(on),
  inspect: (v, on) => v.setInspectMode(on),
  annotate: (v, on) => v.setAnnotateMode(on),
};

/**
 * Flip one interaction tool and record the toggle, returning the new state.
 *
 * The toolbar, the command palette, and the keyboard each toggled a tool by
 * hand — reading `viewer.<tool>Mode`, calling `set<Tool>Mode`, and (in the
 * palette only) recording the change. The toolbar and keyboard paths omitted
 * that recording, so a workflow captured through the palette differed from one
 * captured through the toolbar for the same action. This centralises the flip
 * and the capture so every path records identically. `capture` is a no-op
 * unless a recording is live, so calling it here is always safe. Callers use
 * the returned next-state for their own extra work (e.g. revealing a
 * workspace) without re-reading the mode.
 */
export function toggleTool(
  viewer: ToolToggleViewer,
  workflow: Pick<WorkflowController, 'capture'>,
  tool: ToggleableTool,
): boolean {
  const next = !READ[tool](viewer);
  WRITE[tool](viewer, next);
  workflow.capture({ type: 'tool', tool, on: next });
  return next;
}
