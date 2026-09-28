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
import { showBusyScan } from '../busyScan';
import { el } from '../dom';
import { openModal, type ModalHandle } from '../Modal';
import type { ObservatoryRunner, ObservatoryRunnerState } from '../../app/observatoryRunner';
import { originChip, basisChip, suggestedStationChip, type ObservatoryBasis } from './stateChip';
import type { ObservationRunRecord } from '../../observation/runRecord';
import type { ObservationState } from '../../observation/types';
import type { StationPlanningResult } from '../../observation/stationSuggestion';
import type { CandidateGainTerms } from '../../observation/coverageGain';
import type { ObservatoryOverlayHost } from '../../render/ObservatoryOverlay';
import { triggerDownload } from '../../io/download';
import { announcePolite } from '../politeAnnounce';
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
    body.append(el('p', {
      className: 'olv-observatory-marker-key',
      text: 'In 3D: a solid blue diamond marks each observed source station; a hollow dashed orange ring marks each suggested station, which was not observed.',
    }));
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

/**
 * OB-PR-02's slice control: one level slider for the empty-space slice plane.
 * The legend and the slider's starting level are filled in once the overlay
 * chunk has drawn the plane (`drawOverlay`).
 */
function sliceControl(nz: number, onLevel: ((iz: number) => void) | undefined): HTMLElement {
  const box = el('div', { className: 'olv-observatory-slice' });
  box.append(el('p', { text: 'Slice plane: one voxel level through the field, drawn in 3D.' }));
  box.append(el('p', { className: 'olv-observatory-slice-legend', text: '' }));
  const label = el('span', { className: 'olv-observatory-slice-label', text: `Level 1 of ${nz}` });
  const slider = el('input', { className: 'olv-observatory-slice-level', type: 'range', ariaLabel: 'Slice level' });
  slider.setAttribute('min', '0');
  slider.setAttribute('max', String(Math.max(0, nz - 1)));
  slider.setAttribute('step', '1');
  slider.addEventListener('input', () => {
    const iz = Number((slider as HTMLInputElement).value);
    label.textContent = `Level ${iz + 1} of ${nz}`;
    onLevel?.(iz);
  });
  box.append(label, slider);
  return box;
}

function shadowSection(record: ObservationRunRecord | null, nz = 0, onLevel?: (iz: number) => void): HTMLElement {
  const body = el('div', { className: 'olv-observatory-shadow' });
  if (!record || !record.frontier) {
    body.append(el('p', { text: 'No run yet.' }));
  } else {
    const f = record.frontier;
    body.append(el('p', { text: `Frontier voxels: ${f.frontierVoxelCount}` }));
    body.append(el('p', { text: `Shadowed voxels: ${record.stateCounts.SHADOWED}` }));
    body.append(el('p', { text: `Not addressed: ${record.stateCounts.UNADDRESSED}` }));
    body.append(el('p', { text: f.areaSquareMetres != null ? `Frontier area: ${f.areaSquareMetres.toFixed(2)} m²` : 'Frontier area: unresolved (unknown linear unit)' }));
    if (nz > 0) body.append(sliceControl(nz, onLevel));
  }
  return sectionCard('Shadow', body);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** OB-UI-04's candidate probe: every Coverage Gain term, one line. */
export function candidateTermsText(t: CandidateGainTerms, redundancyWeight: number): string {
  const c = t.weightedCounts;
  return `weighted sum ${fmt(t.weightedVisibilitySum)} − ${redundancyWeight} × ${t.redundantCount} revisited = gain ${fmt(t.gain)}; `
    + `visible ${t.visibleVoxelCount}: shadowed ${c.SHADOWED}, not addressed ${c.UNADDRESSED}, fired, no return ${c.NO_RETURN_PATH}, `
    + `conflict ${c.CONFLICT}, weak surface ${c.WEAK_SURFACE}, not read in this load ${t.excludedVoxelCount}`;
}

function planningSection(record: ObservationRunRecord | null, planning: StationPlanningResult | null | undefined): HTMLElement {
  const body = el('div', { className: 'olv-observatory-planning' });
  if (!record || !planning) {
    body.append(el('p', { text: record ? 'Coverage Gain was not run for this field.' : 'No run yet.' }));
    return sectionCard('Planning', body);
  }
  const unit = record.source.metresPerUnit != null ? 'm' : 'source units';
  const perUnit = record.source.metresPerUnit ?? 1;
  const len = (v: number): string => `${(v * perUnit).toFixed(2)} ${unit}`;
  const m = planning.instrumentModel;
  const authority = planning.authority;
  body.append(el('p', {
    className: 'olv-observatory-planning-authority',
    text: authority.authority === 'preview'
      ? `Authority: preview (${authority.reasons.join('; ')})`
      : 'Authority: measured',
  }));
  body.append(el('p', {
    text: `Instrument model: height ${len(m.heightAboveSurface)}, range ${len(m.minRange)} to ${len(m.maxRange)}, `
      + `vertical field of view ${m.verticalFieldOfViewDegrees}°, planning step ${m.angularStepDegrees}° (${planning.planningRayCount} rays per candidate)`,
  }));
  body.append(el('p', {
    text: `Candidates: ${planning.candidates.length} scored (${planning.qualifyingCount} qualifying, cap ${planning.candidateCap}, ${planning.droppedByCap} dropped by the cap)`,
  }));
  body.append(el('p', { text: `Not read in this load: ${planning.notReadVoxelCount} voxel(s), weight 0` }));

  const s = planning.suggestion;
  const list = el('ol', { className: 'olv-observatory-suggestions' });
  s.selectedCandidateIndices.forEach((index, rank) => {
    const c = planning.candidates.find((k) => k.candidateIndex === index)!;
    const row = el('li', { className: 'olv-observatory-suggestion' });
    row.append(suggestedStationChip());
    row.append(el('span', { text: ` ${planning.label} ${rank + 1}: candidate ${index} at (${c.position.map((v) => v.toFixed(2)).join(', ')}), gain ${fmt(s.gainAtSelection[rank]!)}` }));
    row.append(el('p', { className: 'olv-observatory-candidate-terms', text: candidateTermsText(s.termsAtSelection[rank]!, planning.parameters.redundancyWeight) }));
    list.append(row);
  });
  if (s.selectedCandidateIndices.length === 0) {
    body.append(el('p', {
      text: s.stopReason === 'no-candidates'
        ? 'No suggested station: no level, clear surface voxel qualified as a candidate.'
        : 'No suggested station: no candidate adds coverage to this field.',
    }));
  } else {
    body.append(list);
  }
  if (s.stopReason === 'no-positive-gain' && s.selectedCandidateIndices.length > 0) {
    body.append(el('p', { text: `Stopped after ${s.selectedCandidateIndices.length} of ${s.declaredStationCount}: no remaining candidate adds coverage.` }));
  }
  body.append(el('p', { text: 'Reachability is not checked: Terrain Access gives no reachability verdict for suggested stations in this release.' }));
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
  actions: { readonly run: () => void; readonly onExport: () => void; readonly onSliceLevel?: (iz: number) => void },
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
    const status = el('p', { className: 'olv-observatory-status' });
    showBusyScan(status, 'Running…');
    root.append(status);
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
  root.append(shadowSection(record, outcome.grid.nz, actions.onSliceLevel));
  root.append(planningSection(record, outcome.planning));
  root.append(recordSection(record, actions.onExport));
  return root;
}

let openHandle: ModalHandle | null = null;
let overlay: import('../../render/ObservatoryOverlay').ObservatoryOverlay | null = null;
let markers: import('../../render/ObservatoryOverlay').ObservatoryStationMarkers | null = null;

type Committed = Extract<Extract<ObservatoryRunnerState, { phase: 'committed' }>['outcome'], { status: 'ok' }>;

/**
 * The 3D marker input for a committed run, in the render frame: every
 * record station as an observed marker, every selected candidate as a
 * suggested one. Read-only over the record; a suggested station is never
 * added to `record.stations` (OB-INV-05).
 */
export function stationMarkerInput(
  outcome: Pick<Committed, 'record' | 'planning' | 'voxelEdge'>,
  worldToLocal: ObservatoryPanelInput['worldToLocal'],
  size: number,
): import('../../render/ObservatoryStationMarkers').StationMarkerInput {
  const observed = outcome.record.stations.map((s) => ({
    id: s.id,
    position: worldToLocal(s.worldTranslation),
    assumedOrigin: s.originStatus === 'ASSUMED',
  }));
  const planning = outcome.planning;
  const suggested = planning
    ? planning.suggestion.selectedCandidateIndices.map((index, rank) => ({
      rank: rank + 1,
      position: worldToLocal(planning.candidates.find((c) => c.candidateIndex === index)!.position),
    }))
    : [];
  return { observed, suggested, size, suggestedLabel: planning?.label ?? '' };
}

/** The slice level shown, kept across a redraw; `null` until a run picks its default. */
let sliceLevel: number | null = null;

function setSliceLevel(iz: number): void {
  sliceLevel = iz;
  overlay?.setLevel(iz);
}

/** Put the drawn level and the legend into the open panel's slice control, if there is one. */
function syncSliceControl(nz: number, legend: string): void {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const slider = document.querySelector('.olv-observatory-slice-level') as HTMLInputElement | null;
  if (slider && sliceLevel !== null) slider.value = String(sliceLevel);
  const label = document.querySelector('.olv-observatory-slice-label');
  if (label && sliceLevel !== null) label.textContent = `Level ${sliceLevel + 1} of ${nz}`;
  const legendEl = document.querySelector('.olv-observatory-slice-legend');
  if (legendEl) legendEl.textContent = `Shows ${legend}. Every other state is left clear.`;
}

/** Detach and release both overlays; the next committed run builds fresh ones. */
function clearOverlays(): void {
  sliceLevel = null;
  overlay?.dispose();
  markers?.dispose();
  overlay = null;
  markers = null;
}

/** The panel input the overlays were last drawn for, so a restored context can redraw them. */
let lastInput: ObservatoryPanelInput | null = null;
let restoreListening = false;

export const OVERLAYS_REDRAWN_NOTICE = 'Observatory overlays were redrawn after the graphics context was restored. The run was not recomputed.';

/**
 * After the canvas's WebGL context is restored, rebuild both overlays from the
 * run already in memory: no recompute, and a short notice says so. Listens on
 * the document in the capture phase, because `webglcontextrestored` does not
 * bubble, so nothing in `main.ts` or `Viewer.ts` has to forward it.
 */
async function redrawAfterRestore(): Promise<void> {
  const input = lastInput;
  if (!input || !overlay) return;
  const state = input.runner.getState();
  if (state.phase !== 'committed' || state.outcome.status !== 'ok') return;
  const keep = sliceLevel;
  clearOverlays();
  sliceLevel = keep;
  await drawOverlay(input, state);
  announcePolite(OVERLAYS_REDRAWN_NOTICE);
  const note = document.querySelector('.olv-observatory-panel');
  if (note) {
    // One notice however many restores: replace, never stack.
    note.querySelectorAll('.olv-observatory-redrawn').forEach((n) => n.remove());
    note.prepend(el('p', { className: 'olv-observatory-redrawn', text: OVERLAYS_REDRAWN_NOTICE }));
  }
}

function listenForRestore(): void {
  if (restoreListening || typeof document === 'undefined') return;
  restoreListening = true;
  // Registered once for the page's lifetime and never removed: the overlays
  // outlive the modal, and the handler does nothing while none is drawn.
  document.addEventListener('webglcontextrestored', () => { void redrawAfterRestore(); }, true);
}

async function drawOverlay(input: ObservatoryPanelInput, state: ObservatoryRunnerState): Promise<void> {
  if (!input.overlayHost) return;
  if (state.phase !== 'committed' || state.outcome.status !== 'ok') {
    clearOverlays();
    return;
  }
  const { ObservatoryOverlay, ObservatoryStationMarkers, stationMarkerSize, defaultSliceLevel, sliceLegendText } = await loadObservatoryOverlay();
  // A newer state may have cleared or replaced the run while the chunk loaded.
  const now = input.runner.getState();
  if (now.phase !== 'committed' || now.outcome !== state.outcome) return;
  lastInput = input;
  listenForRestore();
  if (!overlay) overlay = new ObservatoryOverlay(input.overlayHost);
  if (!markers) markers = new ObservatoryStationMarkers(input.overlayHost);
  const outcome = state.outcome;
  const shadowedKeys: number[] = [];
  for (const [key, decision] of outcome.stateByKey) {
    if (decision.state === 'SHADOWED') shadowedKeys.push(key);
  }
  if (sliceLevel === null || sliceLevel >= outcome.grid.nz) sliceLevel = defaultSliceLevel(shadowedKeys, outcome.grid);
  overlay.show({
    stateOf: (key) => outcome.stateByKey.get(key)?.state as ObservationState | undefined,
    frontier: new Set(outcome.frontier.frontierVoxelKeys),
    grid: outcome.grid,
    voxelEdge: outcome.voxelEdge,
    domainMin: input.worldToLocal(outcome.domain.min),
  }, sliceLevel);
  syncSliceControl(outcome.grid.nz, sliceLegendText());
  markers.show(stationMarkerInput(outcome, input.worldToLocal, stationMarkerSize(outcome.voxelEdge)));
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
      onSliceLevel: setSliceLevel,
    }));
    void drawOverlay(input, input.runner.getState());
  }
  rerender();
  const unsubscribe = input.runner.subscribe(rerender);
  input.runner.setOverlayClear(clearOverlays);

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
  const pkg = buildObservatoryPackage(outcome.record, outcome.rows, outcome.frontier.frontierVoxelKeys, { planning: outcome.planning ?? null });
  triggerDownload(new Blob([pkg as unknown as BlobPart], { type: 'application/zip' }), `observatory-${outcome.record.id}.zip`);
}
