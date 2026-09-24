/**
 * terrainAccessLab.ts — the Field Simulation Lab's Terrain Access view.
 *
 * Opened from the command palette and loaded on demand, exactly like
 * `flowPulseLab.ts`: the routing core, the preview and this view ride their
 * own chunk, so a session that never asks for a Terrain Access run never
 * downloads any of it.
 *
 * The view decides nothing about the run. `runTerrainAccess` (the search) and
 * `prepareTerrainAccessPreview` (everything up to it) own the order of the
 * steps, the refusals and the wording of every limitation; this module turns
 * the analysed DTM into their inputs and turns their answer into rows and a
 * grid. Every refusal is shown with its NAMED reason (§30) as the core wrote
 * it, never paraphrased.
 *
 * ── FLOW: PROFILE → PREVIEW → START/GOAL → RUN ──────────────────────────────
 * A mobility profile alone already determines the traversability map (which
 * cells are eligible, and how costly each one is) — it says nothing about a
 * route until two endpoints are chosen. So the view has four states in order:
 *   1. the blank profile form (no preset — see `terrainAccessProfileForm.ts`);
 *   2. the traversability-map preview, once the profile parses and
 *      `prepareTerrainAccessPreview` accepts it, where start/goal are chosen
 *      on the result grid (keyboard: arrows + Enter/Space) and any cell can
 *      be inspected with "Why not?" without needing a route at all (§12.11);
 *   3. the completed run (§12.9 diagnostics, the route drawn on the grid and,
 *      when the caller supplies scene membership, in 3D through
 *      `TerrainAccessOverlay`);
 *   4. export, refused on a stale result exactly as Flow Pulse refuses one.
 *
 * §22: nothing here, or in any string this module builds, calls a route
 * "safe", "drivable" or "passable" — see `renderTerrainAccessRunCard`.
 */

import { el } from '../dom';
import { openModal, type ModalHandle } from '../Modal';
import {
  TERRAIN_ACCESS_DEFAULTS,
  runTerrainAccess,
  type TerrainAccessParams,
  type TerrainAccessResult,
  type TerrainAccessRefusal,
} from '../../simulation/terrainAccess/terrainAccessRunner';
import {
  prepareTerrainAccessPreview,
  type TerrainAccessPreview,
} from '../../simulation/terrainAccess/terrainAccessPreview';
import { whyNotSentence, type ElevationReference, type GridCell } from '../../simulation/terrainAccess/terrainAccessGridCursor';
import type { HorizontalScale } from '../../simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../../simulation/terrainAccess/terrainAccessTypes';
import { dtmProductDigest } from '../../science/dtmProductDigest';
import { buildIdentityProvenance } from '../../build/buildIdentity';
import { verticalUnitLabel } from '../../units/units';
import { TerrainAccessResultGrid, maskFromIndices } from './terrainAccessResultGrid';
import {
  buildTerrainAccessMapBuffers,
  buildTerrainAccessRouteBuffers,
  terrainAccessOverlayFrame,
  type TerrainAccessOverlayFrame,
} from '../../render/terrainAccessOverlayGeometry';
import { TerrainAccessOverlay, type TerrainAccessOverlayHost } from '../../render/TerrainAccessOverlay';
import {
  EMPTY_TERRAIN_ACCESS_PROFILE_FORM,
  parseTerrainAccessProfileForm,
  type TerrainAccessProfileFormValues,
} from './terrainAccessProfileForm';
import { loadTerrainAccessPackage, registerTerrainAccessOverlayInvalidator } from '../../lazyChunks';
import { downloadBytes } from '../../io/download';
import type { buildTerrainAccessPackage } from '../../export/terrainAccessPackage';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';
import type { SurfaceGrid } from '../../terrain/surface/buildDsm';

/** The analysed surface and the frame facts a Terrain Access run needs. */
export interface TerrainAccessLabInput {
  readonly dtm: DtmGrid;
  readonly scale: HorizontalScale;
  readonly layerId: string | null;
  readonly filename: string | null;
  /** Optional above-ground surface; obstruction is inactive without it (§12.4). */
  readonly dsm?: SurfaceGrid | null;
  readonly sceneUpAxis?: 'z' | 'y' | null;
  readonly overlayHost?: TerrainAccessOverlayHost | null;
  readonly isStale?: () => boolean;
  /**
   * Whether the DTM's own claimed vertical factor actually resolved — the
   * same fact `AnalyseContoursResult.verticalScaleResolved` carries for Flow
   * Pulse. Absent/undefined is treated as unresolved, never as resolved by
   * default: an elevation reading is withheld unless this says otherwise.
   */
  readonly verticalScaleResolved?: boolean;
  /**
   * The load-time recentring origin and CRS/georeferencing facts the result
   * grid's real-elevation readout and the export package's real corner need
   * — the same `worldOrigin`/`wkt`/`crsName` `flowPulseLab.ts` reads off
   * `getMapContext()`. All null when the scene has no single resolved
   * origin or CRS.
   */
  readonly worldOriginX?: number | null;
  readonly worldOriginY?: number | null;
  readonly worldOriginZ?: number | null;
  readonly wkt?: string | null;
  readonly crsName?: string | null;
}

/**
 * How to recover a real elevation from the routed grid's local z — the same
 * rule `flowPulseLab.ts`'s `flowElevationReference` uses: the DTM's own
 * claimed vertical factor, gated on the caller's own statement that the
 * vertical scale actually resolved, never the geometry placeholder a
 * CRS-less scan pins to 1.
 */
export function terrainAccessElevationReference(input: TerrainAccessLabInput): ElevationReference {
  const zFactor = input.verticalScaleResolved === false
    ? null
    : (input.dtm.verticalUnitToMetres ?? null);
  const unitLabel = zFactor == null ? 'units' : verticalUnitLabel(zFactor);
  return { originZ: input.worldOriginZ ?? null, unitLabel };
}

const NO_IDENTITY = {
  layerId: null, filename: null, sourceDigest: null, analysisInputDigest: '',
  build: '', id: '', generatedAt: '', processingManifestHead: null,
} as const;

function labIdentity(input: TerrainAccessLabInput): {
  readonly layerId: string | null;
  readonly filename: string | null;
  readonly sourceDigest: string | null;
  readonly analysisInputDigest: string;
  readonly build: string;
  readonly id: string;
  readonly generatedAt: string;
  readonly processingManifestHead: string | null;
} {
  const dtm = input.dtm;
  return {
    layerId: input.layerId,
    filename: input.filename,
    sourceDigest: null,
    get analysisInputDigest() { return dtmProductDigest(dtm); },
    build: buildIdentityProvenance(),
    id: globalThis.crypto?.randomUUID?.() ?? `terrain-access-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    processingManifestHead: null,
  };
}

const PREVIEW_PARAMS = (): TerrainAccessParams => ({ ...TERRAIN_ACCESS_DEFAULTS });

/**
 * §18: the same staleness gate `flowClickGuard.ts`'s `STALE_INPUT` refusal
 * enforces for Flow Pulse. The Lab is a modal that can outlive the terrain it
 * was opened over (a re-run, a classification edit, a closed scan); a click
 * or a run that lands after that would act on a field no longer drawn. Named
 * so the caller shows the SAME sentence at both gates (selection and run)
 * rather than two independently-worded refusals for one fact.
 */
export const TERRAIN_ACCESS_STALE_REASON =
  'The terrain behind this preview has changed since it was built. Re-apply the mobility '
  + 'profile before selecting a cell or running Terrain Access.';

/** A staleness refusal the Lab itself detects (§18), not one `runTerrainAccess`
 * produces — the core is a synchronous pure function with no notion of "since
 * this preview was built"; only the Lab, which holds a preview open across
 * time, can observe that. Kept as its own code rather than one of
 * {@link TerrainAccessRefusalCode} so the core's own refusal union is never
 * stretched to cover a precondition it cannot check itself. */
export interface TerrainAccessStaleRefusal {
  readonly ok: false;
  readonly code: 'STALE_INPUT';
  readonly reason: string;
}

export type TerrainAccessLabOutcome = TerrainAccessResult | TerrainAccessRefusal | TerrainAccessStaleRefusal;

/** Build the preview (grid/features/eligibility/map) from the lab input and a parsed profile. */
export function buildLabPreview(
  input: TerrainAccessLabInput | null,
  profile: TerrainAccessProfile,
): TerrainAccessPreview | TerrainAccessRefusal {
  if (!input) {
    return {
      ok: false, code: 'NO_DTM',
      reason: 'No terrain surface is available. Run terrain analysis on a loaded scan first.',
    };
  }
  return prepareTerrainAccessPreview(input.dtm, input.scale, profile, {
    ...PREVIEW_PARAMS(),
    dsm: input.dsm ?? null,
  });
}

/** Run Terrain Access from `startIndex` to `endIndex` on the analysed surface. */
export function runLabTerrainAccess(
  input: TerrainAccessLabInput | null,
  profile: TerrainAccessProfile,
  startIndex: number,
  endIndex: number,
): TerrainAccessResult | TerrainAccessRefusal {
  if (!input) {
    return runTerrainAccess(null, { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: false }, profile, startIndex, endIndex, PREVIEW_PARAMS(), NO_IDENTITY);
  }
  return runTerrainAccess(input.dtm, input.scale, profile, startIndex, endIndex, {
    ...PREVIEW_PARAMS(),
    dsm: input.dsm ?? null,
  }, labIdentity(input));
}

/** Result of {@link buildTerrainAccessExport}: bytes/filename to download, or a refusal reason. */
export type TerrainAccessExportOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly filename: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The real-world placement facts the export package needs to georeference
 * its raster/GeoJSON — see `FlowPulseGeoref`, which this mirrors exactly.
 * All null when the scene has no single resolved origin or CRS, in which
 * case the package writes a local (0, 0) origin and no .prj, and says so in
 * its README.
 */
export interface TerrainAccessGeoref {
  readonly worldOrigin: { readonly x: number; readonly y: number } | null;
  readonly crsName: string | null;
  readonly wkt: string | null;
}

/** Build the export package from the CURRENT run, refusing on a stale result. Pure and DOM-free. */
export function buildTerrainAccessExport(
  outcome: TerrainAccessLabOutcome | null,
  stale: boolean,
  filename: string | null,
  layerId: string | null,
  build: typeof buildTerrainAccessPackage,
  georef: TerrainAccessGeoref | null = null,
): TerrainAccessExportOutcome {
  if (!outcome || !outcome.ok) {
    return { ok: false, reason: 'Terrain Access has not produced a run to export.' };
  }
  if (stale) {
    return { ok: false, reason: 'the result is stale; rerun Terrain Access before exporting.' };
  }
  const basename = filename ?? layerId ?? 'terrain-access';
  const bytes = build(outcome, {
    basename,
    worldOrigin: georef?.worldOrigin ?? null,
    crsName: georef?.crsName ?? null,
    wkt: georef?.wkt ?? null,
  });
  return { ok: true, bytes, filename: `${basename}-terrain-access.zip` };
}

function row(label: string, value: string): HTMLElement {
  return el('div', { className: 'olv-story-row' }, [
    el('span', { className: 'olv-story-k', text: label }),
    el('span', { className: 'olv-story-v', text: value }),
  ]);
}

/** The run's answer as a card: a refusal's named reason, or the route diagnostics.
 * §22: never a safety/passability word appears here. */
export function renderTerrainAccessRunCard(outcome: TerrainAccessLabOutcome | null): HTMLElement {
  const card = el('aside', { className: 'olv-story-card' });
  if (!outcome) {
    card.append(el('div', { className: 'olv-story-next', text: 'Choose a start and a goal cell, then run.' }));
    return card;
  }
  if (!outcome.ok) {
    card.append(
      el('div', { className: 'olv-story-headline', text: `Terrain Access did not run — ${outcome.code}` }),
      el('div', { className: 'olv-story-next', text: outcome.reason }),
    );
    return card;
  }
  const d = outcome.diagnostics;
  card.append(
    el('div', { className: 'olv-story-headline', text: 'A geometric traversability screening — not a safety or passability guarantee' }),
    row('Method', outcome.record.methods.join(' → ')),
    row('Route cells', String(d.cellCount)),
    row('Horizontal length', `${d.horizontalLengthM.toFixed(1)} m`),
    row('Ascent / descent', `${d.totalAscentM.toFixed(1)} m / ${d.totalDescentM.toFixed(1)} m`),
    row('Max longitudinal grade', `${d.maxLongitudinalGrade.toFixed(3)} (tangent)`),
    row('Max cross slope', `${d.maxCrossSlope.toFixed(3)} (tangent)`),
    row('Max step (limit applies here)', `${d.maxEdgeStepM.toFixed(3)} m`),
    row('Terrain relief within the footprint window', `${d.maxLocalReliefM.toFixed(3)} m`),
    row('Min terrain confidence', Number.isFinite(d.minTerrainConfidence) ? d.minTerrainConfidence.toFixed(0) : 'n/a'),
  );
  const list = el('ul', { className: 'olv-story-v' });
  for (const sentence of outcome.limitations) list.append(el('li', { text: sentence }));
  card.append(el('span', { className: 'olv-story-k', text: 'Limitations' }), list);
  return card;
}

// ── interactive layer ───────────────────────────────────────────────────────

type SelectMode = 'start' | 'goal' | 'inspect';

function button(text: string, className: string, tip: string): HTMLButtonElement {
  return el('button', { className, text, type: 'button', tip }) as HTMLButtonElement;
}

function makeRetryButton(onRetry: () => void): HTMLButtonElement {
  const b = button('Retry', 'olv-ta-retry', 'Retry loading the terrain surface.');
  b.addEventListener('click', onRetry);
  return b;
}

function liveRegion(): HTMLElement {
  const node = el('div', { className: 'olv-ta-live olv-visually-hidden' });
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  return node;
}

function labeledInput(labelText: string, hint: string | null): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'olv-ta-field-input';
  const label = el('label', { className: 'olv-ta-field-label' }, [
    el('span', { text: labelText }),
    input,
    ...(hint ? [el('span', { className: 'olv-ta-field-hint', text: hint })] : []),
  ]);
  const wrap = el('div', { className: 'olv-ta-field' }, [label]);
  return { wrap, input };
}

function segmentedControl<T extends string>(
  ariaLabel: string,
  options: ReadonlyArray<{ value: T; label: string; tip: string }>,
  current: () => T,
  onSelect: (value: T) => void,
): { element: HTMLElement; sync: () => void } {
  const group = el('div', { className: 'olv-ta-segmented', ariaLabel });
  group.setAttribute('role', 'group');
  const buttons = options.map((opt) => {
    const b = button(opt.label, 'olv-ta-segmented-btn', opt.tip);
    b.dataset.value = opt.value;
    b.addEventListener('click', () => onSelect(opt.value));
    return b;
  });
  group.append(...buttons);
  const sync = (): void => {
    const cur = current();
    for (const b of buttons) b.setAttribute('aria-pressed', b.dataset.value === cur ? 'true' : 'false');
  };
  sync();
  return { element: group, sync };
}

/** Build the mobility-profile form. Returns the element and a live-read accessor
 * for its current values — no field is pre-filled with a number (no preset). */
function buildProfileForm(onSubmit: () => void): {
  element: HTMLElement;
  values: () => TerrainAccessProfileFormValues;
  showProblems: (problems: readonly { field: string; reason: string }[]) => void;
} {
  const state: { -readonly [K in keyof TerrainAccessProfileFormValues]: TerrainAccessProfileFormValues[K] } = {
    ...EMPTY_TERRAIN_ACCESS_PROFILE_FORM,
  };

  const name = labeledInput('Profile name', 'e.g. "Illustrative — confirm for your platform"');
  const longGrade = labeledInput('Max longitudinal grade', 'degrees');
  const crossSlope = labeledInput('Max cross slope', 'degrees');
  const stepHeight = labeledInput('Max step height', 'metres');
  const vehicleWidth = labeledInput('Vehicle width', 'metres — 0 for a point footprint');
  const confidence = labeledInput('Minimum terrain confidence', '0–100');

  const ruggednessToggle = document.createElement('input');
  ruggednessToggle.type = 'checkbox';
  const ruggedness = labeledInput('Max ruggedness (VRM)', '0–1');
  ruggedness.input.disabled = true;

  const lengthToggle = document.createElement('input');
  lengthToggle.type = 'checkbox';
  const vehicleLength = labeledInput('Vehicle length', 'metres — recorded, not enforced');
  vehicleLength.input.disabled = true;

  const obstacleToggle = document.createElement('input');
  obstacleToggle.type = 'checkbox';
  const obstacleHeight = labeledInput('Obstacle height threshold', 'metres, above-ground');
  obstacleHeight.input.disabled = true;

  const unknownPolicyCtl = segmentedControl<'block' | 'penalize'>(
    'Weak-evidence policy',
    [
      { value: 'block', label: 'Block weak-evidence cells', tip: 'Treat a cell with no confidence value as impassable.' },
      { value: 'penalize', label: 'Allow, cost-penalize', tip: 'Allow a cell with no confidence value, at an extra route cost.' },
    ],
    () => state.unknownPolicy,
    (value) => { state.unknownPolicy = value; unknownPolicyCtl.sync(); },
  );

  const problemsBox = el('div', { className: 'olv-ta-form-problems' });
  const submitBtn = button('Apply profile', 'olv-ta-form-submit', 'Apply this traversability profile to the current run.');
  submitBtn.addEventListener('click', () => {
    state.name = name.input.value;
    state.maxLongitudinalGradeDeg = longGrade.input.value;
    state.maxCrossSlopeDeg = crossSlope.input.value;
    state.maxStepHeightM = stepHeight.input.value;
    state.maxRuggednessEnabled = ruggednessToggle.checked;
    state.maxRuggedness = ruggedness.input.value;
    state.vehicleWidthM = vehicleWidth.input.value;
    state.vehicleLengthEnabled = lengthToggle.checked;
    state.vehicleLengthM = vehicleLength.input.value;
    state.minimumTerrainConfidence = confidence.input.value;
    state.obstacleHeightEnabled = obstacleToggle.checked;
    state.obstacleHeightThresholdM = obstacleHeight.input.value;
    onSubmit();
  });

  const toggleRow = (toggle: HTMLInputElement, field: { wrap: HTMLElement; input: HTMLInputElement }, label: string): HTMLElement => {
    toggle.addEventListener('change', () => { field.input.disabled = !toggle.checked; });
    return el('div', { className: 'olv-ta-toggle-row' }, [
      el('label', {}, [toggle, el('span', { text: label })]),
      field.wrap,
    ]);
  };

  const element = el('form', { className: 'olv-ta-form' }, [
    name.wrap, longGrade.wrap, crossSlope.wrap, stepHeight.wrap, vehicleWidth.wrap, confidence.wrap,
    toggleRow(ruggednessToggle, ruggedness, 'Constrain ruggedness'),
    toggleRow(lengthToggle, vehicleLength, 'Record vehicle length'),
    toggleRow(obstacleToggle, obstacleHeight, 'Constrain above-ground obstruction'),
    el('div', { className: 'olv-ta-field' }, [
      el('span', { className: 'olv-ta-field-label', text: 'Weak-evidence policy' }),
      unknownPolicyCtl.element,
    ]),
    problemsBox,
    submitBtn,
  ]);
  element.addEventListener('submit', (e) => e.preventDefault());

  return {
    element,
    values: () => ({ ...state }),
    showProblems: (problems) => {
      problemsBox.replaceChildren();
      if (problems.length === 0) return;
      const list = el('ul', { className: 'olv-ta-form-problems-list' });
      for (const p of problems) list.append(el('li', { text: `${p.field}: ${p.reason}` }));
      problemsBox.append(list);
    },
  };
}

/**
 * The 3D traversability-map/route overlay (see `TerrainAccessOverlay.ts`)
 * outlives the modal that built it, mirroring `flowPulseLab.ts`'s
 * `persistentFlowOverlay` exactly and for the same reason: the Lab's modal
 * covers the scene while open, so disposing the overlay unconditionally on
 * close meant a user who turned it on never actually saw it. A single
 * module-level session, kept until the user turns it off or the terrain/CRS
 * it was built from goes stale, is the smallest correct home for it — the
 * one Viewer in this application has exactly one scene.
 */
let persistentTerrainAccessOverlay: {
  readonly overlay: TerrainAccessOverlay;
  /** Re-pointed to the CURRENT mount's staleness check on every open. */
  isStale: (() => boolean) | null;
  overlayOn: boolean;
} | null = null;

/**
 * The overlay for this mount: the persisted one, when it exists and its
 * terrain/CRS have not gone stale, else a fresh one. A stale persisted
 * overlay is disposed here rather than left attached to a scene whose frame
 * it no longer describes. Exported for `terrainAccessOverlayInvalidation.test.ts`
 * to exercise the disposal-registry path directly.
 */
export function acquireTerrainAccessOverlay(
  host: TerrainAccessOverlayHost | null,
  isStale: (() => boolean) | null,
): TerrainAccessOverlay | null {
  if (!host) return null;
  if (persistentTerrainAccessOverlay && persistentTerrainAccessOverlay.isStale?.() === true) {
    persistentTerrainAccessOverlay.overlay.dispose();
    persistentTerrainAccessOverlay = null;
  }
  if (!persistentTerrainAccessOverlay) {
    persistentTerrainAccessOverlay = { overlay: new TerrainAccessOverlay(host), isStale, overlayOn: false };
  } else {
    persistentTerrainAccessOverlay.isStale = isStale;
  }
  return persistentTerrainAccessOverlay.overlay;
}

/**
 * Unconditionally dispose the persisted overlay, when one exists. Reached
 * through `registerTerrainAccessOverlayInvalidator`/`invalidateTerrainAccessOverlay`
 * (see `lazyChunks.ts`) by every eager caller that clears the cached terrain
 * core — a scan closing, a different scan loading, a CRS change, or a
 * classification edit — none of which reopens the Lab to trigger the
 * `isStale()` check `acquireTerrainAccessOverlay` makes on its own.
 * Idempotent: a second call with nothing to dispose is a no-op.
 */
export function disposePersistentTerrainAccessOverlay(): void {
  if (!persistentTerrainAccessOverlay) return;
  persistentTerrainAccessOverlay.overlay.dispose();
  persistentTerrainAccessOverlay = null;
}

// Registered once, at module load (the first time this lazy chunk actually
// loads — opening the Lab, or its export action).
registerTerrainAccessOverlayInvalidator(disposePersistentTerrainAccessOverlay);

/**
 * The interactive Terrain Access view: profile form → preview/selection →
 * run → export. Owns one `TerrainAccessResultGrid` for the modal's own
 * lifetime and shares the persisted `TerrainAccessOverlay` (see
 * {@link acquireTerrainAccessOverlay}). `dispose()` releases the overlay's
 * GPU resources only when the user left it OFF — an overlay the user turned
 * on stays drawn on the scan after the modal closes, mirroring
 * `flowPulseLab.ts`'s `mountFlowPulseInteractive` exactly.
 */
function mountTerrainAccessInteractive(input: TerrainAccessLabInput | null): { element: HTMLElement; dispose: () => void } {
  const root = el('div', { className: 'olv-ta-lab' });
  const live = liveRegion();
  const body = el('div', { className: 'olv-ta-body' });
  root.append(live, body);
  const announce = (msg: string): void => { live.textContent = msg; };

  let profile: TerrainAccessProfile | null = null;
  let preview: TerrainAccessPreview | TerrainAccessRefusal | null = null;
  let outcome: TerrainAccessLabOutcome | null = null;
  let mode: SelectMode = 'start';
  let startCell: GridCell | null = null;
  let goalCell: GridCell | null = null;
  let overlayFrame: TerrainAccessOverlayFrame | null = null;
  let busy = false;
  let exportBusy = false;

  const overlayHost = input?.overlayHost ?? null;
  const overlay = acquireTerrainAccessOverlay(overlayHost, input?.isStale ?? null);
  // Reflects whatever the persisted overlay is already showing: reopening
  // the Lab after leaving the overlay on picks the toggle back up in the
  // "on" state rather than forgetting it was ever shown.
  let overlayOn = persistentTerrainAccessOverlay?.overlayOn ?? false;

  const grid = new TerrainAccessResultGrid({
    ariaLabel: 'Terrain access traversability grid — arrow keys move, Enter or Space acts on the selected cell',
    onMove: () => {},
    onActivate: (cell) => handleActivate(cell),
    elevationRef: input ? terrainAccessElevationReference(input) : null,
  });

  const inspectorPanel = el('div', { className: 'olv-ta-inspector' });
  const selectionPanel = el('div', { className: 'olv-ta-selection' });
  const runCard = el('div', { className: 'olv-ta-run-card' });

  const modeCtl = segmentedControl<SelectMode>(
    'What a selected cell does',
    [
      { value: 'start', label: 'Set start', tip: "Click a cell on the map to set the route's starting point." },
      { value: 'goal', label: 'Set goal', tip: "Click a cell on the map to set the route's destination." },
      { value: 'inspect', label: "Why not? (inspect)", tip: 'Click a cell to see why it can or cannot be reached.' },
    ],
    () => mode,
    (value) => { mode = value; modeCtl.sync(); },
  );

  const runButton = button('Run Terrain Access', 'olv-ta-run', 'Run the least-cost route search between the start and goal cells.');
  const exportButton = button('Export package (ZIP)', 'olv-ta-export', 'Export the run as a ZIP package: route, grid, and report.');

  function applyOverlayVisibility(): void {
    if (!overlay || !preview || !preview.ok || !overlayFrame) return;
    if (overlayOn) {
      overlay.setMap(buildTerrainAccessMapBuffers(preview.grid, preview.map, overlayFrame));
      overlay.setMapVisible(true);
    } else {
      overlay.setMapVisible(false);
    }
  }

  const overlayToggle = button('Show traversability map', 'olv-ta-overlay-toggle', 'Toggle the traversability map overlay on the 3D view.');
  overlayToggle.setAttribute('aria-pressed', overlayOn ? 'true' : 'false');
  overlayToggle.addEventListener('click', () => {
    overlayOn = !overlayOn;
    if (persistentTerrainAccessOverlay) persistentTerrainAccessOverlay.overlayOn = overlayOn;
    overlayToggle.setAttribute('aria-pressed', overlayOn ? 'true' : 'false');
    applyOverlayVisibility();
    announce(overlayOn ? 'Traversability map overlay on.' : 'Traversability map overlay off.');
  });

  function renderSelection(): void {
    selectionPanel.replaceChildren(
      row('Start', startCell ? `col ${startCell.col}, row ${startCell.row}` : 'not set'),
      row('Goal', goalCell ? `col ${goalCell.col}, row ${goalCell.row}` : 'not set'),
    );
    runButton.disabled = !(startCell && goalCell) || busy;
  }

  function handleActivate(cell: GridCell): void {
    if (!preview || !preview.ok) return;
    if (input?.isStale?.()) {
      announce(TERRAIN_ACCESS_STALE_REASON);
      inspectorPanel.replaceChildren(el('div', { className: 'olv-ta-inspector-text', text: TERRAIN_ACCESS_STALE_REASON }));
      return;
    }
    if (mode === 'start') {
      startCell = cell;
      grid.setStart(cell);
      renderSelection();
      announce(`Start set to column ${cell.col}, row ${cell.row}.`);
    } else if (mode === 'goal') {
      goalCell = cell;
      grid.setGoal(cell);
      renderSelection();
      announce(`Goal set to column ${cell.col}, row ${cell.row}.`);
    } else {
      const sentence = whyNotSentence(preview.grid, preview.features, preview.eligibility, profile!, cell);
      inspectorPanel.replaceChildren(el('div', { className: 'olv-ta-inspector-text', text: sentence }));
      announce(sentence);
    }
  }

  async function handleExport(): Promise<void> {
    if (!outcome || !outcome.ok || busy || exportBusy) return;
    const label = exportButton.textContent ?? 'Export package (ZIP)';
    exportBusy = true;
    exportButton.disabled = true;
    exportButton.textContent = 'Building…';
    try {
      const { buildTerrainAccessPackage } = await loadTerrainAccessPackage();
      const built = buildTerrainAccessExport(
        outcome, input?.isStale?.() ?? false, input?.filename ?? null, input?.layerId ?? null, buildTerrainAccessPackage,
        input ? {
          worldOrigin: input.worldOriginX != null && input.worldOriginY != null
            ? { x: input.worldOriginX, y: input.worldOriginY }
            : null,
          crsName: input.crsName ?? null,
          wkt: input.wkt ?? null,
        } : null,
      );
      if (!built.ok) {
        announce(`Export refused — ${built.reason}`);
        return;
      }
      downloadBytes(built.filename, built.bytes, 'application/zip');
      announce('Terrain Access package downloaded.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      announce(`Export failed: ${msg}`);
    } finally {
      exportBusy = false;
      exportButton.disabled = false;
      exportButton.textContent = label;
    }
  }
  exportButton.addEventListener('click', () => void handleExport());

  function renderPreview(): void {
    if (!preview) return;
    if (!preview.ok) {
      body.replaceChildren(
        renderTerrainAccessRunCard(preview),
        makeRetryButton(() => { preview = null; profile = null; renderRoot(); }),
      );
      return;
    }
    // A `const` alias: TypeScript cannot narrow the outer mutable `let preview`
    // inside the closures below (`runButton.onclick`), but it narrows a `const`
    // captured at this point, once, to the `ok: true` branch just checked above.
    const readyPreview = preview;
    const dtm = input!.dtm;
    overlayFrame = terrainAccessOverlayFrame(input?.sceneUpAxis, dtm.originH1, dtm.originH2, dtm.cellSizeM);
    grid.load(readyPreview.grid, readyPreview.map);
    startCell = null;
    goalCell = null;
    outcome = null;
    grid.setRouteMask(null);
    overlay?.clearRoute();
    renderSelection();
    applyOverlayVisibility();

    runButton.disabled = true;
    runButton.onclick = () => {
      if (!startCell || !goalCell || !profile) return;
      if (input?.isStale?.()) {
        outcome = { ok: false, code: 'STALE_INPUT', reason: TERRAIN_ACCESS_STALE_REASON };
        runCard.replaceChildren(renderTerrainAccessRunCard(outcome));
        announce(TERRAIN_ACCESS_STALE_REASON);
        return;
      }
      busy = true;
      runButton.disabled = true;
      const startIndex = startCell.row * readyPreview.grid.cols + startCell.col;
      const endIndex = goalCell.row * readyPreview.grid.cols + goalCell.col;
      outcome = runLabTerrainAccess(input, profile, startIndex, endIndex);
      busy = false;
      if (outcome.ok) {
        grid.setRouteMask(maskFromIndices(readyPreview.grid.cols * readyPreview.grid.rows, outcome.path));
        if (overlay && overlayFrame) overlay.setRoute(buildTerrainAccessRouteBuffers(readyPreview.grid, outcome.path, overlayFrame));
        announce('Terrain Access route found.');
      } else {
        grid.setRouteMask(null);
        overlay?.clearRoute();
        announce(`Terrain Access did not run: ${outcome.reason}`);
      }
      runCard.replaceChildren(renderTerrainAccessRunCard(outcome));
      renderSelection();
    };

    runCard.replaceChildren(renderTerrainAccessRunCard(null));
    inspectorPanel.replaceChildren();

    body.replaceChildren(
      modeCtl.element,
      grid.element,
      selectionPanel,
      runButton,
      inspectorPanel,
      runCard,
      overlayHost ? el('div', { className: 'olv-ta-overlay-section' }, [overlayToggle]) : el('div', {
        className: 'olv-ta-overlay-unavailable',
        text: 'The 3D traversability overlay is not available in this view; the 2D result grid still carries every interaction.',
      }),
      exportButton,
    );
  }

  const form = buildProfileForm(() => {
    const values = form.values();
    const parsed = parseTerrainAccessProfileForm(values);
    if (!parsed.ok) {
      form.showProblems(parsed.problems);
      return;
    }
    form.showProblems([]);
    profile = parsed.profile;
    preview = buildLabPreview(input, profile);
    renderPreview();
  });

  function renderRoot(): void {
    if (!preview) {
      body.replaceChildren(form.element);
      return;
    }
    renderPreview();
  }

  renderRoot();

  return {
    element: root,
    // An overlay the user left ON stays attached to the scene — only an
    // overlay left OFF (nothing visible to keep) is torn down here. The
    // "on" case leaves `persistentTerrainAccessOverlay` untouched: the next
    // Lab open reclaims the SAME instance via `acquireTerrainAccessOverlay`
    // rather than constructing a second one that would orphan the first.
    dispose: () => {
      if (!overlayOn && persistentTerrainAccessOverlay) {
        persistentTerrainAccessOverlay.overlay.dispose();
        persistentTerrainAccessOverlay = null;
      }
    },
  };
}

/** Run and show Terrain Access in a dialog. */
export function openTerrainAccessLab(input: TerrainAccessLabInput | null): ModalHandle {
  const interactive = mountTerrainAccessInteractive(input);
  return openModal({
    title: 'Field Simulation Lab: Terrain Access',
    body: interactive.element,
    onClose: () => interactive.dispose(),
  });
}
