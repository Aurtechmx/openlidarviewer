/**
 * rangeWorkbenchMount.ts — the lazy entry point for the Range Frame Workbench.
 *
 * The launcher, the workbench, the raster core and the diagnostics all load as
 * one split chunk, the first time a loaded layer is found to carry an
 * acquisition grid. A session that opens a LAS file and never touches
 * structured data loads none of it: nothing in the eager startup shell imports
 * this module, and the only route in is `loadRangeWorkbenchMount()` in
 * `lazyChunks.ts`, which is where every dynamic-import literal in this project
 * lives so the live source transform cannot scramble the specifier.
 *
 * The launcher is CONTEXT-SENSITIVE rather than permanent. It renders nothing
 * at all unless the active layer actually carries a grid, so a panel that has
 * never seen structured data shows no dead entry point, no disabled button and
 * no explanation of a feature that does not apply.
 */

import type { OrganizedRangeSet } from '../model/OrganizedRange';
import type { RecordPosition, UpAxis } from '../model/acquisitionCoverage';
import { requestOrganizedHighlight, subscribeOrganizedPick } from '../model/organizedRangeLink';
import { RangeWorkbench } from './RangeWorkbench';
import { el } from './dom';

/**
 * One line describing how a layer is organized, for the launcher.
 *
 * A single setup names its grid; several name the count, because eight grid
 * shapes on one line is a list rather than a fact. "Structured" is the word the
 * formats themselves use for a grid-organized scan.
 */
export function organizationFact(set: OrganizedRangeSet): string {
  if (set.frames.length === 1) {
    const f = set.frames[0];
    return `Organization: Structured, ${f.width} × ${f.height}`;
  }
  return `Organization: Structured, ${set.frames.length} scanner setups`;
}

export interface MountRangeWorkbenchOptions {
  readonly set: OrganizedRangeSet;
  /** The renderer's own layer id. The link keys on this, never on a name. */
  readonly layerId: string;
  /** Record → position, for the acquisition-extent summary. Absent omits it. */
  readonly recordPosition?: RecordPosition;
  /** The layer's up axis, so the extent fit projects onto the ground plane. */
  readonly upAxis?: UpAxis;
  /** Where the launcher card is rendered. */
  readonly launcherHost: HTMLElement;
  /** The container the workbench is rendered into, revealed on launch. */
  readonly workbenchHost: HTMLElement;
  /** Reveals `workbenchHost`. */
  readonly onLaunch: () => void;
}

export interface MountedRangeWorkbench {
  readonly dispose: () => void;
}

/**
 * Render the launcher and wire the workbench behind it.
 *
 * The workbench is built on the first launch, not on mount, so a layer whose
 * launcher is never pressed costs one card. The inspector subscription is taken
 * at the same moment for the same reason.
 */
export function mountRangeWorkbench(opts: MountRangeWorkbenchOptions): MountedRangeWorkbench {
  const { set, layerId, recordPosition, upAxis, launcherHost, workbenchHost, onLaunch } = opts;

  let workbench: RangeWorkbench | null = null;
  let unsubscribe: (() => void) | null = null;

  const card = el('div', { className: 'olv-range-launcher' });
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Structured data');
  card.append(el('div', { className: 'olv-range-launcher-head', text: 'Structured Data' }));
  card.append(
    el('div', {
      className: 'olv-range-launcher-title',
      text: 'This layer carries its acquisition grid',
    }),
  );
  card.append(el('div', { className: 'olv-range-launcher-fact', text: organizationFact(set) }));
  card.append(
    el('p', {
      className: 'olv-range-launcher-message',
      text: 'Inspect the grid the scanner sampled, including the cells that produced no display point.',
    }),
  );

  const button = el('button', {
    className: 'olv-range-launcher-action',
    text: 'Open Range Frame Workbench',
  });
  button.type = 'button';
  button.addEventListener('click', () => {
    if (!workbench) {
      workbench = new RangeWorkbench({
        set,
        layerId,
        recordPosition,
        upAxis,
        onHighlightRecord: (record) =>
          requestOrganizedHighlight(record === null ? null : { layerId, record }),
      });
      workbenchHost.replaceChildren(workbench.element);
      // The 3D to 2D half. A pick on ANOTHER layer is ignored rather than
      // resolved against this grid: the identity is per layer, and a record
      // index only means something inside the record stream it came from.
      unsubscribe = subscribeOrganizedPick((pick) => {
        if (!pick || pick.layerId !== layerId) return;
        workbench?.showRecord(pick.record);
      });
    }
    onLaunch();
  });
  card.append(button);

  launcherHost.replaceChildren(card);

  return {
    dispose: () => {
      unsubscribe?.();
      unsubscribe = null;
      workbench?.dispose();
      workbench = null;
      launcherHost.replaceChildren();
      workbenchHost.replaceChildren();
    },
  };
}
