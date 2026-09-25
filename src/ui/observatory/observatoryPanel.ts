/**
 * observatoryPanel.ts — OB-UI-01's five sections (Sources, Evidence, Shadow,
 * Planning, Record), lazily loaded behind the `analyse.observatory` command
 * (ASK O9-2: one panel, one chunk, five sections together — not five
 * sub-chunks).
 *
 * UI ONLY (ASK O9-1): this module never calls into `src/observation` itself.
 * It renders whatever `ObservatoryRunnerState` it is given and asks the
 * runner (`src/app/observatoryRunner.ts`) to run again; the science and the
 * run lifecycle live entirely on that side of the seam.
 *
 * WORDING (OB-UI-05): every string this file writes into the DOM avoids
 * "probability", "confidence", "accuracy", "optimal", "guaranteed",
 * "complete coverage" and "free space" (outside the one definitional
 * sentence that equates it with OBSERVED_EMPTY) — `tests/observatoryPanelWording.test.ts`
 * renders this panel and asserts it.
 */
import { el } from '../dom';
import { openModal, type ModalHandle } from '../Modal';
import type { ObservatoryRunner, ObservatoryRunnerState } from '../../app/observatoryRunner';
import { originChip, basisChip, suggestedStationChip, type ObservatoryBasis } from './stateChip';
import type { ObservationRunRecord } from '../../observation/runRecord';
import type { ObservatoryOverlayHost } from '../../render/ObservatoryOverlay';
import { triggerDownload } from '../../io/download';
import { loadObservatoryOverlay, loadObservatoryPackage } from '../../lazyChunks';

export interface ObservatoryPanelInput {
  readonly runner: ObservatoryRunner;
  /** Scene membership for the shadow-voxel overlay, `Viewer.derivedLayerHost()`. Omitted ⇒ the overlay is simply not drawn; the panel's own counts still show. */
  readonly overlayHost: ObservatoryOverlayHost | null;
  /** WORLD → LOCAL (render) frame offset, i.e. `cloud.sourceOrigin`, so the overlay draws in the same recentred frame the scan itself renders in. */
  readonly worldToLocal: (p: readonly [number, number, number]) => readonly [number, number, number];
}

function sectionCard(title: string, body: HTMLElement): HTMLElement {
  return el('section', { className: 'olv-observatory-section' }, [
    el('h3', { className: 'olv-observatory-section-title', text: title }),
    body,
  ]);
}

function sourcesSection(record: ObservationRunRecord | null): HTMLElement {
  const body = el('div', { className: 'olv-observatory-sources' });
  if (!record) {
    body.append(el('p', { text: 'No run yet.' }));
  } else {
    for (const station of record.stations) {
      const row = el('div', { className: 'olv-observatory-station-row' });
      row.append(el('span', { className: 'olv-observatory-station-id', text: station.id }));
      row.append(originChip(station.originStatus as Parameters<typeof originChip>[0]));
      row.append(basisChip(record.source.basis as ObservatoryBasis));
      body.append(row);
    }
  }
  return sectionCard('Sources', body);
}

function evidenceSection(record: ObservationRunRecord | null): HTMLElement {
  const body = el('div', { className: 'olv-observatory-evidence' });
  if (!record) {
    body.append(el('p', { text: 'No run yet.' }));
  } else {
    const list = el('ul', { className: 'olv-observatory-state-counts' });
    for (const [state, count] of Object.entries(record.stateCounts)) {
      list.append(el('li', { text: `${state}: ${count}` }));
    }
    body.append(list);
  }
  return sectionCard('Evidence', body);
}

function shadowSection(record: ObservationRunRecord | null): HTMLElement {
  const body = el('div', { className: 'olv-observatory-shadow' });
  if (!record || !record.frontier) {
    body.append(el('p', { text: 'No run yet.' }));
  } else {
    const f = record.frontier;
    body.append(el('p', { text: `Frontier voxels: ${f.frontierVoxelCount}` }));
    body.append(el('p', { text: `Shadowed voxels: ${record.stateCounts.SHADOWED}` }));
    body.append(el('p', { text: `Not addressed: ${record.stateCounts.UNADDRESSED}` }));
    body.append(el('p', { text: f.areaSquareMetres != null ? `Frontier area: ${f.areaSquareMetres.toFixed(2)} m²` : 'Frontier area: unresolved (unknown linear unit)' }));
  }
  return sectionCard('Shadow', body);
}

function planningSection(): HTMLElement {
  const body = el('div', { className: 'olv-observatory-planning' });
  body.append(el('p', { text: 'Station suggestion is not implemented in this release.' }));
  body.append(suggestedStationChip());
  return sectionCard('Planning', body);
}

function recordSection(record: ObservationRunRecord | null, onExport: () => void): HTMLElement {
  const body = el('div', { className: 'olv-observatory-record' });
  if (!record) {
    body.append(el('p', { text: 'No run yet.' }));
  } else {
    body.append(el('p', { text: `Methods: ${record.methods.join(', ')}` }));
    body.append(el('p', { text: `Digest: ${record.digest.slice(0, 16)}…` }));
    const exportBtn = el('button', { className: 'olv-observatory-export', type: 'button', text: 'Export bundle', tip: 'Write the observatory/ export bundle (OB-EXP-01).' });
    exportBtn.addEventListener('click', onExport);
    body.append(exportBtn);
  }
  return sectionCard('Record', body);
}

function ineligibleBody(reason: string): HTMLElement {
  return el('div', { className: 'olv-observatory-ineligible' }, [
    el('p', { text: `Observatory is not available for this scan: ${reason}.` }),
  ]);
}

function refusedBody(reason: string): HTMLElement {
  return el('div', { className: 'olv-observatory-refused' }, [
    el('p', { text: `The run was refused: ${reason}. Try a coarser voxel edge or a smaller region.` }),
  ]);
}

/** Pure render: state -> DOM. No runner calls, no side effects beyond building nodes (unit-tested directly by `tests/observatoryPanel.test.ts`). */
export function renderObservatoryPanel(
  state: ObservatoryRunnerState,
  actions: { readonly run: () => void; readonly onExport: () => void },
): HTMLElement {
  const root = el('div', { className: 'olv-observatory-panel' });
  const runBtn = el('button', { className: 'olv-observatory-run', type: 'button', text: 'Run Observatory', tip: 'Build the evidence ledger over this scan’s declared stations.' });
  runBtn.addEventListener('click', actions.run);
  root.append(runBtn);

  if (state.phase === 'idle') {
    root.append(el('p', { className: 'olv-observatory-status', text: 'Idle. No scan, or no run yet.' }));
    return root;
  }
  if (state.phase === 'running') {
    root.append(el('p', { className: 'olv-observatory-status', text: 'Running…' }));
    return root;
  }
  if (state.phase === 'stale') {
    root.append(el('p', { className: 'olv-observatory-status', text: 'The last run went stale before it could be shown (the scan or CRS changed mid-run). Run again.' }));
    return root;
  }

  const outcome = state.outcome;
  if (outcome.status === 'ineligible') {
    root.append(ineligibleBody(outcome.reason === 'no-stations' ? 'no declared stations' : 'the scan has no measurable extent'));
    return root;
  }
  if (outcome.status === 'refused') {
    root.append(refusedBody(String(outcome.reason)));
    return root;
  }

  const record = outcome.record;
  root.append(sourcesSection(record));
  root.append(evidenceSection(record));
  root.append(shadowSection(record));
  root.append(planningSection());
  root.append(recordSection(record, actions.onExport));
  return root;
}

let openHandle: ModalHandle | null = null;
let overlay: import('../../render/ObservatoryOverlay').ObservatoryOverlay | null = null;

async function drawOverlay(input: ObservatoryPanelInput, state: ObservatoryRunnerState): Promise<void> {
  if (!input.overlayHost) return;
  if (state.phase !== 'committed' || state.outcome.status !== 'ok') {
    overlay?.show([], { nx: 0, ny: 0 }, 1, [0, 0, 0]);
    return;
  }
  const { ObservatoryOverlay } = await loadObservatoryOverlay();
  if (!overlay) overlay = new ObservatoryOverlay(input.overlayHost);
  const outcome = state.outcome;
  const shadowedKeys: number[] = [];
  for (const [key, decision] of outcome.stateByKey) {
    if (decision.state === 'SHADOWED') shadowedKeys.push(key);
  }
  overlay.show(shadowedKeys, outcome.grid, outcome.voxelEdge, input.worldToLocal(outcome.domain.min));
}

/**
 * Open the modal panel, subscribing to `input.runner` so it re-renders on
 * every state change and draws (or clears) the shadow overlay through
 * `input.overlayHost` — visible in the 3D scene the moment a run commits, per
 * SPEC's own "not only behind a modal" requirement; the overlay's host add()
 * happens independently of whether this modal stays open.
 */
export function openObservatoryPanel(input: ObservatoryPanelInput): ModalHandle {
  const body = el('div');
  function rerender(): void {
    body.replaceChildren(renderObservatoryPanel(input.runner.getState(), {
      run: () => input.runner.run(),
      onExport: () => { void exportCurrent(input.runner.getState()); },
    }));
    void drawOverlay(input, input.runner.getState());
  }
  rerender();
  const unsubscribe = input.runner.subscribe(rerender);
  input.runner.setOverlayClear(() => { overlay?.show([], { nx: 0, ny: 0 }, 1, [0, 0, 0]); });

  openHandle?.close();
  openHandle = openModal({
    title: 'Observatory',
    body,
    onClose: () => { unsubscribe(); openHandle = null; },
  });
  return openHandle;
}

async function exportCurrent(state: ObservatoryRunnerState): Promise<void> {
  if (state.phase !== 'committed' || state.outcome.status !== 'ok') return;
  const outcome = state.outcome;
  const { buildObservatoryPackage } = await loadObservatoryPackage();
  const pkg = buildObservatoryPackage(outcome.record, outcome.rows, outcome.frontier.frontierVoxelKeys);
  triggerDownload(new Blob([pkg as unknown as BlobPart], { type: 'application/zip' }), `observatory-${outcome.record.id}.zip`);
}
