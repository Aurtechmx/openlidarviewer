/**
 * contourStudioReducer.ts
 *
 * The pure state transition function for Contour Studio (v0.5.9 spec §8). Every
 * action returns a new `ContourStudioState`; nothing mutates in place, so the
 * reducer is trivially testable and replayable.
 *
 * User edits (`set-setting`) record the changed path in `overrides`, so a later
 * `set-purpose` re-applies the purpose defaults without discarding what the user
 * deliberately changed. `reset` returns to the neutral base AND clears overrides.
 */

import {
  baseContourStudioState,
  type ContourArea,
  type ContourStudioPurpose,
  type ContourStudioState,
} from './contourStudioState';
import { applyPurpose } from './contourStudioPurpose';

/** A settable path into the state's presentation settings. */
export type ContourSettingPath =
  | 'surface.cartographicSmoothing'
  | 'contour.analytical'
  | 'contour.cartographic'
  | 'contour.indexEvery'
  | 'labels.enabled'
  | 'labels.indexOnly'
  | 'appearance.hillshade'
  | 'appearance.hypsometricTint'
  | 'validation.appendixRequired'
  | 'deliverable.pdf'
  | 'deliverable.geojson'
  | 'deliverable.dxf'
  | 'deliverable.completePackage'
  | 'deliverable.allowExploratory';

export type ContourStudioAction =
  | { readonly type: 'set-purpose'; readonly purpose: ContourStudioPurpose }
  | { readonly type: 'set-area'; readonly area: ContourArea }
  | { readonly type: 'set-setting'; readonly path: ContourSettingPath; readonly value: boolean | number }
  | { readonly type: 'reset' };

export function contourStudioReducer(
  state: ContourStudioState,
  action: ContourStudioAction,
): ContourStudioState {
  switch (action.type) {
    case 'set-purpose':
      return applyPurpose(state, action.purpose);

    case 'set-area':
      return { ...state, area: action.area };

    case 'set-setting': {
      const withValue = setPath(state, action.path, action.value);
      // Mark this path as a user override so a future purpose switch keeps it.
      return {
        ...withValue,
        overrides: { ...state.overrides, [action.path]: true },
      };
    }

    case 'reset':
      return baseContourStudioState();
  }
}

type SettingGroup =
  | 'surface'
  | 'contour'
  | 'labels'
  | 'appearance'
  | 'validation'
  | 'deliverable';

function setPath(
  state: ContourStudioState,
  path: ContourSettingPath,
  value: boolean | number,
): ContourStudioState {
  const [group, key] = path.split('.') as [SettingGroup, string];
  return {
    ...state,
    [group]: { ...(state[group] as unknown as Record<string, unknown>), [key]: value },
  };
}
