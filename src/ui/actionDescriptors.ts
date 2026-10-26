/**
 * actionDescriptors.ts
 *
 * The name table keyed by registry id, and the descriptors of actions offered
 * by a control but not listed in the palette. The names themselves are the
 * constants in `actionNames.ts`; this module is read by the registry, the lazy
 * surfaces and the tests, so it stays out of the startup chunk.
 */

import type { ActionDescriptor } from './actionRegistry';
import { FRAME_ALL, ORTHOGRAPHIC, PLAN_VIEW, NAVIGATION_PANEL, MEASURE, INSPECT, PROBE, ANNOTATE, CLIP_BOX, SAVE_SNAPSHOT, COPY_VIEW_LINK, ANALYSE, COMMANDS, HELP, OPEN_SCAN, CLOSE_SCAN, SAVE_SESSION, OPEN_SESSION, REPORT_PDF } from './actionNames';
export const ACTION_TITLES = {
  'camera.frame-all': FRAME_ALL,
  'camera.orthographic': ORTHOGRAPHIC,
  'camera.plan-view': PLAN_VIEW,
  'camera.navigation-panel': NAVIGATION_PANEL,
  'tool.measure': MEASURE,
  'tool.inspect': INSPECT,
  'tool.probe': PROBE,
  'tool.annotate': ANNOTATE,
  'tool.clip': CLIP_BOX,
  'tool.snapshot': SAVE_SNAPSHOT,
  'tool.share': COPY_VIEW_LINK,
  'tool.analyse': ANALYSE,
  'palette.open': COMMANDS,
  'help.open': HELP,
  'scan.open': OPEN_SCAN,
  'scan.close': CLOSE_SCAN,
  'session.export': SAVE_SESSION,
  'session.open': OPEN_SESSION,
  'report.pdf': REPORT_PDF,
} as const;

export type NamedActionId = keyof typeof ACTION_TITLES;

/** The one visible name of an action. */
export function actionTitle(id: NamedActionId): string {
  return ACTION_TITLES[id];
}

/**
 * Descriptors for actions offered by a control but not listed in the palette.
 * Opening a scan, the session file and the PDF report are palette actions
 * (`app/actions/exportActions.ts`), so they are not here.
 */
export const SURFACE_DESCRIPTORS: readonly ActionDescriptor[] = [
  { id: 'tool.probe', title: ACTION_TITLES['tool.probe'], section: 'Tools', hint: 'Hover the scan to read each point live, with no click.' },
  { id: 'tool.analyse', title: ACTION_TITLES['tool.analyse'], section: 'Analyse', hint: 'Show or hide the terrain analysis panel.' },
  { id: 'palette.open', title: ACTION_TITLES['palette.open'], section: 'Help', hint: 'Search every action.' },
  { id: 'help.open', title: ACTION_TITLES['help.open'], section: 'Help', hint: 'Workflows, navigation and scientific states.' },
  { id: 'scan.close', title: ACTION_TITLES['scan.close'], section: 'Data', hint: 'Close the scan and return to the start.' },
];
