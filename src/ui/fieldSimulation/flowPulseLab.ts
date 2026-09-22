/**
 * flowPulseLab.ts — the Field Simulation Lab's Flow Pulse view.
 *
 * Opened from the command palette and loaded on demand: the routing core and
 * this view ride their own chunk, so a session that never asks for a flow run
 * never downloads either.
 *
 * The view decides nothing about the run. `runFlowPulse` owns the order of the
 * steps, the refusals and the wording of every limitation; this module turns
 * the analysed DTM and its frame into the runner's inputs, and turns the
 * runner's answer into rows. Each limitation is shown as the runner wrote it,
 * because a paraphrase is a second statement about the run that nothing tests.
 *
 * Square metres appear only when the basis permits them. The runner already
 * leaves the area null in that case; the view checks `mayReportMetricArea` as
 * well, so a future change to the summary cannot put a metric figure on screen
 * behind a basis that forbids one.
 */

import { el } from '../dom';
import { openModal, type ModalHandle } from '../Modal';
import {
  FLOW_PULSE_DEFAULTS,
  runFlowPulse,
  type FlowPulseResult,
  type FlowRefusal,
} from '../../simulation/flowPulse/flowPulseRunner';
import { mayReportMetricArea } from '../../simulation/simulationInputBasis';
import { dtmProductDigest } from '../../science/dtmProductDigest';
import type { HorizontalScale } from '../../simulation/flowPulse/dtmFlowGrid';
import type { AnalyseContoursResult } from '../../terrain/contour/analyseContours';

/** The analysed surface and the frame facts the Analyse panel holds for it. */
export interface FlowPulseLabInput {
  readonly result: AnalyseContoursResult;
  readonly isGeographic: boolean;
  /** World Y of the load-time recentring origin; null when the scene has no single one. */
  readonly worldOriginY: number | null;
  /** Metres per source unit from the resolved frame; null when unknown. */
  readonly resolvedUnitToMetres: number | null;
  readonly layerId: string | null;
  readonly filename: string | null;
}

/**
 * The horizontal scale the DTM was built under.
 *
 * On a geographic frame the latitude is the grid centre in world coordinates,
 * which needs the world origin. The map context leaves that origin undefined
 * when the scene has more than one origin or a layer has been placed, and in
 * that case the latitude is unknown: the scale reports null and the runner
 * refuses. Reading a missing origin as zero would put a site at 60° N on the
 * equator, route with cos φ ≈ 1 and roughly double every area. A projected
 * frame needs no latitude and is unaffected.
 */
export function flowScaleOf(input: FlowPulseLabInput): HorizontalScale {
  const dtm = input.result.dtm;
  const latitudeDeg = input.isGeographic && input.worldOriginY != null
    ? input.worldOriginY + dtm.originH2 + (dtm.rows / 2) * dtm.cellSizeM
    : null;
  const latitudeKnown = latitudeDeg != null && Number.isFinite(latitudeDeg);
  return {
    isGeographic: input.isGeographic,
    latitudeDeg: latitudeKnown ? latitudeDeg : null,
    unitToMetres: input.resolvedUnitToMetres ?? 1,
    resolved: input.result.horizontalScaleResolved && (!input.isGeographic || latitudeKnown),
  };
}

/** Stand-ins for a run that refuses before it reads a frame or an identity. */
const NO_FRAME: HorizontalScale = {
  isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: false,
};
const NO_IDENTITY = {
  layerId: null, filename: null, sourceDigest: null, analysisInputDigest: '',
  build: '', id: '', generatedAt: '', processingManifestHead: null,
} as const;

/** Run Flow Pulse on the analysed surface, or report that there is none. */
export function runLabFlowPulse(input: FlowPulseLabInput | null): FlowPulseResult | FlowRefusal {
  if (!input) {
    return runFlowPulse(null, NO_FRAME, FLOW_PULSE_DEFAULTS, NO_IDENTITY);
  }
  const dtm = input.result.dtm;
  return runFlowPulse(dtm, flowScaleOf(input), FLOW_PULSE_DEFAULTS, {
    layerId: input.layerId,
    filename: input.filename,
    sourceDigest: null,
    // A getter, because the runner reads the digest only when it seals a
    // record. A refused run then never hashes the grid it declined to read.
    get analysisInputDigest() { return dtmProductDigest(dtm); },
    build: __APP_VERSION__,
    id: globalThis.crypto?.randomUUID?.() ?? `flow-${Date.now()}`,
    generatedAt: new Date().toISOString(),
    processingManifestHead: null,
  });
}

function row(label: string, value: string): HTMLElement {
  return el('div', { className: 'olv-story-row' }, [
    el('span', { className: 'olv-story-k', text: label }),
    el('span', { className: 'olv-story-v', text: value }),
  ]);
}

/** The run's answer as a card: a refusal's reason, or the figures and every limitation. */
export function renderFlowPulseLab(outcome: FlowPulseResult | FlowRefusal): HTMLElement {
  const card = el('aside', { className: 'olv-story-card' });
  if (!outcome.ok) {
    card.append(
      el('div', { className: 'olv-story-headline', text: 'Flow Pulse did not run' }),
      el('div', { className: 'olv-story-next', text: outcome.reason }),
    );
    return card;
  }

  const s = outcome.summary;
  const metric = mayReportMetricArea(outcome.basis) && s.maxContributingAreaM2 != null;
  card.append(
    el('div', { className: 'olv-story-headline', text: 'D8 flow routing over the analysed DTM' }),
    row('Cells routed', `${s.readableCells} of ${s.cells}`),
    row('Outlets', String(s.outletCount)),
    row('Sinks', String(s.sinkCount)),
    row('Flats', String(s.flatCount)),
    row('Largest upstream count', `${s.maxUpstreamCells} cells`),
    row(
      'Largest contributing area',
      metric ? `${s.maxContributingAreaM2!.toFixed(1)} m²` : 'Withheld: the horizontal scale is not resolved',
    ),
  );
  const list = el('ul');
  for (const sentence of outcome.limitations) list.append(el('li', { text: sentence }));
  card.append(row('Limitations', ''), list);
  return card;
}

/** Run and show Flow Pulse in a dialog. */
export function openFlowPulseLab(input: FlowPulseLabInput | null): ModalHandle {
  return openModal({ title: 'Field Simulation Lab: Flow Pulse', body: renderFlowPulseLab(runLabFlowPulse(input)) });
}
