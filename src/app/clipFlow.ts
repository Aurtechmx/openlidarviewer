/**
 * clipFlow.ts: the Box → clip flow and the result card, over narrow ports.
 *
 *   - "Draw clipping box" (Clip page) arms the EXISTING Box measurement tool
 *     and stays on the Clip page, which shows the tool's corner hint; it adds
 *     no tool state. The box it draws is a footprint: the clip takes the
 *     scan's full height (so does a box drawn looking straight down).
 *   - "Isolate this box" and the Measurements row's "Use as clipping region"
 *     are the same function, {@link useBoxAsClip}, so the validation, the
 *     refusal messages and the independent-copy behaviour cannot drift apart.
 *     Once a box drawn from the Clip page has become the clip, the Measure
 *     tool is switched off, so the next clicks on the scene do not start
 *     another box.
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
import { copyToClipboard } from '../ui/clipboard';
import type { MeasurementSummary } from '../render/measure/MeasureController';
import type { MeasureSceneContext } from '../render/measure/measureConfidence';
import type { CrsService } from '../geo/CrsService';
import { buildMeasureConfidenceContext } from './measureConfidenceContext';
import type { Viewer } from '../render/Viewer';
import type { MeasurePanel } from '../ui/MeasurePanel';

/** The clip panel as the flow sees it. */
export interface ClipFlowPanel extends ClipIndicatorSource {
  subscribe(fn: () => void): () => void;
  /** The Box tool's corner hint on the Clip page while a clipping box is drawn; null hides it. */
  setDrawHint?(text: string | null): void;
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
  /** Turn the Measure tool on (recorded, as every entry point does) without leaving the Clip page. */
  readonly armMeasureTool: () => void;
  /** Turn the Measure tool off (recorded) when it is on. */
  readonly stopMeasureTool: () => void;
  readonly setBoxKind: () => void;
  /** Reveal and focus a measurement's row in the Measure page. */
  readonly openDetails: (id: string) => void;
  /** Defaults to the app's clipboard helper. */
  readonly copy?: (text: string) => Promise<boolean>;
  /** True while the camera looks straight down: a box completed then is a footprint. */
  readonly lookingDown?: () => boolean;
  /** Make the Box tool's hint say the box drawn to clip spans the scan's full height. */
  readonly setFootprintHint?: (on: boolean) => void;
  /** Follow the Box tool's hint text; returns the unsubscribe. */
  readonly watchHint?: (fn: (text: string) => void) => () => void;
  /** On a phone, lower the sheet so the scene takes the corner taps. */
  readonly revealScene?: () => void;
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
 * What the lane stays below: the measurement toolbar, the progress toast, the
 * project card and the recommended-view chip, wherever they share its column
 * at the top of the stage.
 */
const LANE_CLEAR_OF = ['.olv-measure-bar:not(.olv-hidden)', '.olv-toast:not(.olv-hidden)', '.olv-project-card.olv-visible', '.olv-rvc:not(.olv-hidden)'];
/** What the lane must end above: the active-tool pill, the navigation row and the dock at the bottom. */
const LANE_FLOORS = ['.olv-ati:not(.olv-hidden)', '.olv-navbar', '.olv-dock'];

export function createClipFlow(deps: ClipFlowDeps): ClipFlow {
  /** Set by Draw clipping box; names the card's clip action "Isolate this box". */
  let drawIntent = false;
  let lastCount = 0;
  let lastId: string | null = null;
  /** Boxes that are footprints: drawn to clip, or completed looking straight down. */
  const footprints = new Set<string>();
  let unwatchHint: (() => void) | null = null;

  /** Draw clipping box is over (a box became the clip, or the tool moved on). */
  const endDraw = (): void => {
    if (!drawIntent && !unwatchHint) return;
    drawIntent = false;
    unwatchHint?.();
    unwatchHint = null;
    deps.setFootprintHint?.(false);
    deps.clipPanel.setDrawHint?.(null);
  };

  const isolate = (id: string): boolean => {
    // Drawn from the Clip page: the Box tool was armed only to draw this box.
    const fromDraw = drawIntent;
    const ok = useBoxAsClip(deps.box, id, { fullHeight: footprints.has(id) });
    if (ok) {
      endDraw();
      card.hide();
      // The box is now the clip; further clicks on the scene must not start
      // Box 2. A box measured on purpose leaves the user's Measure tool as it was.
      if (fromDraw && deps.measureOn()) deps.stopMeasureTool();
    }
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
    endDraw();
    card.hide();
  }

  const latest = (): MeasurementSummary | null => {
    const all = deps.summaries();
    return all.length ? all[all.length - 1] : null;
  };

  return {
    lane, card, indicator,
    drawClippingBox() {
      // The Clip page stays: the tool is armed in place, never toggled off.
      if (!deps.measureOn()) deps.armMeasureTool();
      deps.setBoxKind();
      // After the tool switch, which dismisses any previous result.
      drawIntent = true;
      deps.setFootprintHint?.(true);
      unwatchHint?.();
      unwatchHint = deps.watchHint?.((text) => { if (drawIntent) deps.clipPanel.setDrawHint?.(text); }) ?? null;
      deps.revealScene?.();
    },
    isolate,
    onMeasurementsChanged() {
      // Esc or another tool ended the Box tool while a clipping box was being drawn.
      if (drawIntent && !deps.measureOn()) endDraw();
      const all = deps.summaries();
      const grewByOne = all.length === lastCount + 1;
      lastCount = all.length;
      const s = latest();
      if (!s) { lastId = null; footprints.clear(); dismissCard(); return; }
      if (grewByOne && s.id !== lastId) {
        lastId = s.id;
        if (s.kind === 'box' && (drawIntent || deps.lookingDown?.() === true)) footprints.add(s.id);
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
      footprints.clear();
      dismissCard();
    },
    dispose() {
      endDraw();
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
  /** Flip Measure and record it, as the shell's scene-tool command does, without opening its page. */
  readonly toggleMeasure: () => void;
  readonly toast: (message: string) => void;
  /** The CRS service the panel's scene facts are read from. */
  readonly crs: Pick<CrsService, 'current' | 'context'>;
  /** On a phone, lower the sheet so the scene takes the corner taps. */
  readonly revealScene?: () => void;
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
    armMeasureTool: () => { if (!v().measureMode) sh.toggleMeasure(); },
    stopMeasureTool: () => { if (v().measureMode) sh.toggleMeasure(); },
    setBoxKind: () => v().measure.setKind('box'),
    openDetails: (id) => { sh.openPage('measure'); sh.measurePanel()?.focusRow(id); },
    lookingDown: () => sh.ready() && looksDown(v().getCameraPose(), v().measure.worldUp),
    setFootprintHint: (on) => { if (sh.ready()) v().measure.boxFootprint = on; },
    watchHint: (fn) => (sh.ready() ? watchHintText(v().measureElements.hint, fn) : () => {}),
    revealScene: sh.revealScene,
  });
  sh.clipPanel.setOnDrawBox(() => flow.drawClippingBox());
  return flow;
}

/**
 * Follow the Box tool's hint line (the measure bar's polite status text) and
 * hand each new text to `fn`, now and on every change. Returns the stop.
 */
export function watchHintText(bar: HTMLElement, fn: (text: string) => void): () => void {
  const read = (): string => (bar.querySelector('.olv-measure-hint-text')?.textContent ?? '').trim();
  let last = read();
  fn(last);
  if (typeof MutationObserver !== 'function') return () => {};
  const mo = new MutationObserver(() => {
    const text = read();
    if (text !== last) { last = text; fn(text); }
  });
  mo.observe(bar, { childList: true, characterData: true, subtree: true });
  return () => mo.disconnect();
}

/** A box completed with the camera this close to straight down is a footprint (plan view and near it). */
const PLAN_VIEW_DEGREES = 15;

/** Whether a camera at `pose` looks within {@link PLAN_VIEW_DEGREES} of straight down the scene's `up`. */
export function looksDown(
  pose: { readonly position: readonly number[]; readonly target: readonly number[] },
  up: readonly number[],
): boolean {
  const d = [0, 1, 2].map((i) => (pose.target[i] ?? 0) - (pose.position[i] ?? 0));
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 0)) return false;
  const along = (d[0] * (up[0] ?? 0) + d[1] * (up[1] ?? 0) + d[2] * (up[2] ?? 0)) / len;
  return along < -Math.cos((PLAN_VIEW_DEGREES * Math.PI) / 180);
}
