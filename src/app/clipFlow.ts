/**
 * clipFlow.ts: the Box → clip flow and the result card, over narrow ports.
 *
 *   - "Draw clipping box" (Clip page) arms the EXISTING Box measurement tool
 *     through the shell's canonical scene-tool command; it adds no tool state.
 *   - "Isolate this box" and the Measurements row's "Use as clipping region"
 *     are the same function, {@link useBoxAsClip}, so the validation, the
 *     refusal messages and the independent-copy behaviour cannot drift apart.
 *   - After a measurement completes, one compact result card shows the latest
 *     result (value, caveats, Copy / Open details / clip) beside the viewport.
 *     It is dismissed by the next tool activation and by closing the scan.
 *
 * The active-clipping chip lives here too, driven by the Clip panel's own
 * subscription. Everything the shell must supply is an accessor, so the flow
 * is testable in Node and adds one factory call to `main.ts`.
 */

import { useBoxAsClip, type BoxToClipDeps } from './boxToClip';
import { buildResultModel } from './measureResultModel';
import { MeasureResultCard } from '../ui/MeasureResultCard';
import { ClipIndicator, type ClipIndicatorSource } from '../ui/ClipIndicator';
import { el } from '../ui/dom';
import { seatClear, seatFit, watchSeat } from '../ui/hudSeat';
import { copyToClipboard } from '../render/InspectTool';
import type { MeasurementSummary } from '../render/measure/MeasureController';
import type { MeasureSceneContext } from '../render/measure/measureConfidence';
import type { CrsService } from '../geo/CrsService';
import { buildMeasureConfidenceContext } from './measureConfidenceContext';
import type { Viewer } from '../render/Viewer';
import type { MeasurePanel } from '../ui/MeasurePanel';

/** The clip panel as the flow sees it. */
export interface ClipFlowPanel extends ClipIndicatorSource {
  subscribe(fn: () => void): () => void;
}

export interface ClipFlowDeps {
  readonly clipPanel: ClipFlowPanel;
  /** The stage overlay the lane is appended to. */
  readonly overlay: { append(...nodes: Node[]): void };
  readonly box: BoxToClipDeps;
  /** Completed measurements' summaries (the Measurements list's own text). */
  readonly summaries: () => readonly MeasurementSummary[];
  /** The scene facts the Measurements panel grades each row against. */
  readonly scene: () => MeasureSceneContext;
  readonly measureOn: () => boolean;
  /** The canonical scene-tool command for Measure (records, opens the page). */
  readonly runMeasureTool: () => void;
  readonly openMeasurePage: () => void;
  readonly setBoxKind: () => void;
  /** Reveal and focus a measurement's row in the Measure page. */
  readonly openDetails: (id: string) => void;
  /** Defaults to the app's clipboard helper. */
  readonly copy?: (text: string) => Promise<boolean>;
}

export interface ClipFlow {
  readonly lane: HTMLElement;
  readonly card: MeasureResultCard;
  readonly indicator: ClipIndicator;
  /** Clip page entry point: arm the Box tool and remember why. */
  drawClippingBox(): void;
  /** The one conversion both "Isolate this box" and the row action run. */
  isolate(id: string): boolean;
  /** Call after every measurement change. */
  onMeasurementsChanged(): void;
  /** A different tool was activated: the result no longer applies. */
  dismissCard(): void;
  /** The scan closed. */
  reset(): void;
  dispose(): void;
}

/**
 * What the lane stays below: the measurement toolbar, the progress toast and
 * the project card, wherever they share its column at the top of the stage.
 */
const LANE_CLEAR_OF = ['.olv-measure-bar:not(.olv-hidden)', '.olv-toast:not(.olv-hidden)', '.olv-project-card.olv-visible'];
/** What the lane must end above: the active-tool pill, the navigation row and the dock at the bottom. */
const LANE_FLOORS = ['.olv-ati:not(.olv-hidden)', '.olv-navbar', '.olv-dock'];

export function createClipFlow(deps: ClipFlowDeps): ClipFlow {
  /** Set by Draw clipping box; names the card's clip action "Isolate this box". */
  let drawIntent = false;
  let lastCount = 0;
  let lastId: string | null = null;

  const isolate = (id: string): boolean => {
    const ok = useBoxAsClip(deps.box, id);
    if (ok) { drawIntent = false; card.hide(); }
    return ok;
  };
  const clipLabel = (): string => (drawIntent ? 'Isolate this box' : 'Use as clipping region');

  const card = new MeasureResultCard({
    onCopy: (m) => {
      if (m.copyText === null) return;
      void (deps.copy ?? copyToClipboard)(m.copyText).then((ok) => deps.box.toast(ok ? 'Result copied.' : 'Could not copy the result.'));
    },
    onOpenDetails: (id) => deps.openDetails(id),
    onUseAsClip: (id) => { isolate(id); },
    onDismiss: () => dismissCard(),
  });
  const indicator = new ClipIndicator(deps.clipPanel);
  const lane = el('div', { className: 'olv-flow-lane' }, [card.element, indicator.element]);
  deps.overlay.append(lane);
  const unsubscribe = deps.clipPanel.subscribe(() => indicator.sync());

  // The lane drops below whatever shares its column at the top of the stage:
  // the measurement toolbar, a progress toast, the project card. Each changes
  // size and comes and goes, so they are watched rather than assumed.
  const unwatch = watchSeat(lane, [...LANE_CLEAR_OF, ...LANE_FLOORS], () => {
    seatClear(lane, LANE_CLEAR_OF, 'down');
    seatFit(lane, LANE_FLOORS);
  });

  function dismissCard(): void {
    drawIntent = false;
    card.hide();
  }

  const latest = (): MeasurementSummary | null => {
    const all = deps.summaries();
    return all.length ? all[all.length - 1] : null;
  };

  return {
    lane, card, indicator,
    drawClippingBox() {
      if (deps.measureOn()) deps.openMeasurePage();
      else deps.runMeasureTool();
      deps.setBoxKind();
      // After the tool switch, which dismisses any previous result.
      drawIntent = true;
    },
    isolate,
    onMeasurementsChanged() {
      const all = deps.summaries();
      const grewByOne = all.length === lastCount + 1;
      lastCount = all.length;
      const s = latest();
      if (!s) { lastId = null; dismissCard(); return; }
      if (grewByOne && s.id !== lastId) {
        lastId = s.id;
        // A box that follows Draw clipping box is the one being isolated;
        // any other result leaves that intent for the box still to come.
        card.show(buildResultModel(s, deps.scene()), s.kind === 'box' ? clipLabel() : 'Use as clipping region');
        return;
      }
      lastId = s.id;
      // Edited or renamed in place: keep the card on the same figure as the list.
      if (card.shownId === s.id) card.show(buildResultModel(s, deps.scene()), s.kind === 'box' ? clipLabel() : 'Use as clipping region');
      else if (card.shownId !== null && !all.some((x) => x.id === card.shownId)) dismissCard();
    },
    dismissCard,
    reset() {
      lastCount = 0;
      lastId = null;
      dismissCard();
    },
    dispose() {
      unsubscribe();
      unwatch();
      card.hide();
      lane.remove();
    },
  };
}

/** What `main.ts` hands over: the shell's late-bound services, as thunks. */
export interface ClipFlowShell {
  readonly clipPanel: ClipFlowPanel & { setOnDrawBox(fn: () => void): void; adoptBounds: BoxToClipDeps['adoptClip'] };
  readonly overlay: ClipFlowDeps['overlay'];
  readonly viewer: () => Viewer;
  /** False until the first scan resolves the (deferred) Viewer. */
  readonly ready: () => boolean;
  readonly activeLayerId: () => string | null;
  readonly openPage: (page: 'clip' | 'measure') => void;
  readonly measurePanel: () => Pick<MeasurePanel, 'focusRow'> | null;
  /** The shell's one scene-tool command (dock, key, palette, launcher). */
  readonly runTool: (tool: 'measure') => void;
  readonly toast: (message: string) => void;
  /** The CRS service the panel's scene facts are read from. */
  readonly crs: Pick<CrsService, 'current' | 'context'>;
}

/** Build the flow from the shell and give the Clip page its entry point. */
export function createClipFlowFromShell(sh: ClipFlowShell): ClipFlow {
  const v = (): Viewer => sh.viewer();
  const flow = createClipFlow({
    clipPanel: sh.clipPanel,
    overlay: sh.overlay,
    box: {
      measurements: () => v().measure.getMeasurements(),
      activeLayerId: sh.activeLayerId,
      layerCount: () => v().clouds().length,
      verticalExtent: () => v().clipVerticalExtent(),
      adoptClip: (c) => sh.clipPanel.adoptBounds(c),
      openClipPage: () => sh.openPage('clip'),
      frameClip: () => { v().frameClip(); },
      toast: sh.toast,
    },
    summaries: () => (sh.ready() ? v().measure.getSummaries() : []),
    scene: () => buildMeasureConfidenceContext(v(), sh.crs.current(), sh.crs.context()),
    measureOn: () => sh.ready() && v().measureMode,
    runMeasureTool: () => sh.runTool('measure'),
    openMeasurePage: () => sh.openPage('measure'),
    setBoxKind: () => v().measure.setKind('box'),
    openDetails: (id) => { sh.openPage('measure'); sh.measurePanel()?.focusRow(id); },
  });
  sh.clipPanel.setOnDrawBox(() => flow.drawClippingBox());
  return flow;
}
