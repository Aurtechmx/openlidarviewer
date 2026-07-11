/**
 * contourStudioWorkspace.ts
 *
 * The Contour Studio workspace shell (v0.5.9 spec §5.3, §6, §7). A DOM-builder
 * (same node-testable style as workflowCardRender / contourStudioLauncher) that
 * renders the focused post-analysis workflow: purpose cards, a compact settings
 * summary, an evidence ladder tied to the real launch state, and an export bar.
 *
 * It is driven by a `ContourStudioController`: clicking a purpose card dispatches
 * `set-purpose`, and the workspace re-renders its dynamic body from the new
 * state. The evidence claim shown in the ladder comes from the launch state, not
 * from anything minted here — the science stays stricter than the UI looks.
 *
 * SHELL SCOPE: this establishes the workflow surface + purpose selection +
 * evidence ladder + export bar. The review bar's live recommendation values
 * (grid, interval, support percentages) arrive with PR5, and functional exports
 * with PR9–PR11; those slots are labelled honestly here, not faked.
 */

import type { ContourStudioController } from '../terrain/contourStudio/contourStudioController';
import type { ContourStudioState } from '../terrain/contourStudio/contourStudioState';
import type { ContourStudioLaunchState } from '../terrain/contourStudio/contourStudioLaunchState';
import type { ContourReviewSummary } from '../terrain/contourStudio/contourReviewSummary';
import {
  PURPOSE_META,
  type PurposeMeta,
} from '../terrain/contourStudio/contourStudioPurpose';
import type { ContourStudioPurpose } from '../terrain/contourStudio/contourStudioState';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text) node.textContent = opts.text;
  return node;
}

/**
 * The export products Contour Studio can offer. Defined here (the lower module)
 * so the mount can re-export it without an import cycle. The host maps each to a
 * real, honesty-gated exporter.
 */
export type ContourStudioExportProduct =
  | 'pdf'
  | 'geojson'
  | 'dxf'
  | 'svg'
  | 'package'
  | 'report';

export interface ContourStudioWorkspaceOptions {
  readonly controller: ContourStudioController;
  readonly launch: ContourStudioLaunchState;
  /** The review-bar recommendations built from the analysis result (PR5). */
  readonly review?: ContourReviewSummary;
  /** Fires when an export product is chosen; the host runs the real exporter. */
  readonly onExport?: (product: ContourStudioExportProduct) => void;
}

/** Render the review bar (spec §7.1): one row per recommendation with its
 *  rationale exposed via the title attribute (no black-box values). */
function renderReviewBar(review: ContourReviewSummary): HTMLElement {
  const wrap = el('div', { className: 'olv-cs-review' });
  wrap.append(el('div', { className: 'olv-cs-section-head', text: 'Review' }));
  const list = el('dl', { className: 'olv-cs-review-list' });
  for (const row of review.rows) {
    const dt = el('dt', { className: `olv-cs-review-label is-${row.confidence}`, text: row.label });
    const dd = el('dd', { className: 'olv-cs-review-value', text: row.value });
    if (row.rationale.length > 0) dd.title = row.rationale.join(' ');
    list.append(dt, dd);
  }
  wrap.append(list);
  return wrap;
}

const PURPOSE_ORDER: readonly ContourStudioPurpose[] = [
  'engineering-plan',
  'survey-review',
  'terrain-research',
  'presentation-map',
  'custom',
];

/** Evidence-ladder rows, derived HONESTLY from the launch state. */
type LadderState = 'met' | 'warn' | 'blocked';
const LADDER_GLYPH: Record<LadderState, string> = { met: '✓', warn: '!', blocked: '✕' };

/** The six evidence checks (glyph rows). The overall claim is rendered
 *  separately as a statement line, so its sentence is never crushed into a
 *  status badge. */
function ladderRows(launch: ContourStudioLaunchState): ReadonlyArray<{ label: string; state: LadderState }> {
  const status = launch.status;
  const base: LadderState = status === 'unavailable' ? 'blocked' : 'met';
  const support: LadderState = status === 'available' ? 'met' : status === 'exploratory' ? 'warn' : 'blocked';
  const validation: LadderState = status === 'unavailable' ? 'blocked' : 'warn';
  return [
    { label: 'Source', state: base },
    { label: 'Surface', state: base },
    { label: 'Support', state: support },
    { label: 'Validation', state: validation },
    { label: 'Contours', state: base },
    { label: 'Package', state: base },
  ];
}

/** The overall evidence claim, shown as a statement line under the checks. */
function ladderClaim(launch: ContourStudioLaunchState): { text: string; state: LadderState } {
  switch (launch.status) {
    case 'available':
      return { text: 'Supported (internal validation only)', state: 'met' };
    case 'exploratory':
      return { text: 'Exploratory', state: 'warn' };
    default:
      return { text: 'Blocked', state: 'blocked' };
  }
}

function renderPurposeCards(
  current: ContourStudioPurpose,
  onPick: (p: ContourStudioPurpose) => void,
): HTMLElement {
  const wrap = el('div', { className: 'olv-cs-purposes' });
  wrap.append(el('div', { className: 'olv-cs-section-head', text: 'Choose a purpose' }));
  const grid = el('div', { className: 'olv-cs-purpose-grid' });
  for (const id of PURPOSE_ORDER) {
    const meta: PurposeMeta = PURPOSE_META[id];
    const card = el('button', {
      className: `olv-cs-purpose-card${id === current ? ' is-selected' : ''}`,
    });
    card.type = 'button';
    card.setAttribute('aria-pressed', id === current ? 'true' : 'false');
    card.append(el('span', { className: 'olv-cs-purpose-label', text: meta.label }));
    card.append(el('span', { className: 'olv-cs-purpose-summary', text: meta.summary }));
    card.addEventListener('click', () => onPick(id));
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

function renderSettingsSummary(state: ContourStudioState): HTMLElement {
  const wrap = el('div', { className: 'olv-cs-summary' });
  wrap.append(el('div', { className: 'olv-cs-section-head', text: 'This deliverable' }));
  const rows: Array<[string, string]> = [
    ['Geometry', [state.contour.analytical ? 'analytical' : null, state.contour.cartographic ? 'cartographic' : null].filter(Boolean).join(' + ') || 'none'],
    ['Cartographic smoothing', state.surface.cartographicSmoothing ? 'on' : 'off'],
    ['Labels', state.labels.enabled ? (state.labels.indexOnly ? 'index only' : 'on') : 'off'],
    ['Validation appendix', state.validation.appendixRequired ? 'required' : 'optional'],
    ['Exploratory output', state.deliverable.allowExploratory ? 'allowed' : 'not for this purpose'],
  ];
  const list = el('dl', { className: 'olv-cs-summary-list' });
  for (const [k, v] of rows) {
    list.append(el('dt', { text: k }));
    list.append(el('dd', { text: v }));
  }
  wrap.append(list);
  return wrap;
}

function renderLadder(launch: ContourStudioLaunchState): HTMLElement {
  const wrap = el('div', { className: 'olv-cs-ladder' });
  wrap.append(el('div', { className: 'olv-cs-section-head', text: 'Evidence' }));
  for (const row of ladderRows(launch)) {
    const r = el('div', { className: `olv-cs-ladder-row is-${row.state}` });
    r.append(el('span', { className: 'olv-cs-ladder-mark', text: LADDER_GLYPH[row.state] }));
    r.append(el('span', { className: 'olv-cs-ladder-label', text: row.label }));
    wrap.append(r);
  }
  const claim = ladderClaim(launch);
  const claimLine = el('div', { className: `olv-cs-ladder-claim is-${claim.state}` });
  claimLine.append(el('span', { className: 'olv-cs-ladder-claim-label', text: 'Claim' }));
  claimLine.append(el('span', { className: 'olv-cs-ladder-claim-value', text: claim.text }));
  wrap.append(claimLine);
  return wrap;
}

/**
 * The premium export section (§7.4): one honesty-gated surface, Gestalt-grouped
 * by deliverable kind (Vector / Map sheet / Data package / Report). Each button
 * fires `onExport(product)`; the host runs the real, gated exporter. A blocked
 * launch disables every product and says why — no polished deliverable is
 * offered when the surface can't support one.
 */
function renderExportBar(
  launch: ContourStudioLaunchState,
  onExport?: (product: ContourStudioExportProduct) => void,
): HTMLElement {
  const wrap = el('div', { className: 'olv-cs-export' });
  wrap.append(el('div', { className: 'olv-cs-section-head', text: 'Export' }));
  const blocked = launch.status === 'unavailable';
  const groups: ReadonlyArray<{
    label: string;
    items: ReadonlyArray<{ id: ContourStudioExportProduct; label: string }>;
  }> = [
    { label: 'Vector', items: [
      { id: 'geojson', label: 'GeoJSON' },
      { id: 'dxf', label: 'DXF' },
      { id: 'svg', label: 'SVG' },
    ] },
    { label: 'Map sheet', items: [{ id: 'pdf', label: 'PDF' }] },
    { label: 'Data package', items: [{ id: 'package', label: 'DEM (ZIP)' }] },
    { label: 'Report', items: [{ id: 'report', label: 'Intelligence (PDF)' }] },
  ];
  for (const g of groups) {
    const group = el('div', { className: 'olv-cs-export-group' });
    group.append(el('div', { className: 'olv-cs-export-group-label', text: g.label }));
    const btns = el('div', { className: 'olv-cs-export-btns' });
    for (const it of g.items) {
      const b = el('button', { className: 'olv-cs-export-btn', text: it.label });
      b.type = 'button';
      b.disabled = blocked;
      if (!blocked && onExport) b.addEventListener('click', () => onExport(it.id));
      btns.append(b);
    }
    group.append(btns);
    wrap.append(group);
  }
  if (blocked) {
    wrap.append(el('p', {
      className: 'olv-cs-export-note',
      text: 'Exports unlock once the blocking reasons above are resolved.',
    }));
  }
  return wrap;
}

/**
 * Build the workspace element. Re-renders its dynamic body when the controller
 * state changes (purpose switch). Returns the root element; the caller owns
 * mounting and, if needed, unsubscription via the returned element's lifetime.
 */
export function renderContourStudioWorkspace(
  opts: ContourStudioWorkspaceOptions,
): HTMLElement {
  const { controller, launch, review, onExport } = opts;
  const root = el('div', { className: 'olv-contour-studio-workspace' });
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Contour Studio');

  const header = el('div', { className: 'olv-cs-header' });
  header.append(el('div', { className: 'olv-cs-title', text: 'Contour Studio' }));
  header.append(
    el('p', {
      className: 'olv-cs-subtitle',
      text: 'Create a contour deliverable from the analyzed terrain surface. Validation limits stay visible in the export.',
    }),
  );
  root.append(header);

  const body = el('div', { className: 'olv-cs-body' });
  root.append(body);

  const paint = (state: ContourStudioState): void => {
    body.replaceChildren();
    body.append(
      renderPurposeCards(state.purpose, (p) =>
        controller.dispatch({ type: 'set-purpose', purpose: p }),
      ),
    );
    if (review) body.append(renderReviewBar(review));
    body.append(
      renderSettingsSummary(state),
      renderLadder(launch),
      renderExportBar(launch, onExport),
    );
  };

  paint(controller.getState());
  controller.subscribe(paint);
  return root;
}
