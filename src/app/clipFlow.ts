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
import { copyToClipboard } from '../render/InspectTool';
import type { MeasurementSummary } from '../render/measure/MeasureController';
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
  readonly measureOn: () => boolean;
  /**
   * The measurement toolbar, once the Viewer exists. The lane sits under it
   * while it shows, so the two never overlap (see {@link placeLane}).
   */
  readonly measureBar?: () => HTMLElement | null;
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
  const unsubscribe = deps.clipPanel.subscribe(() => { indicator.sync(); bindBar(); });

  // The lane sits under the measurement toolbar while it shows, and under the
  // header otherwise. The toolbar's height changes with the width and with its
  // Finish button, so it is watched rather than assumed.
  let boundBar: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  const placeLane = (): void => {
    const bar = boundBar;
    const h = bar ? bar.offsetHeight : 0;
    if (!bar || h <= 0) { lane.style.removeProperty('--olv-flow-top'); return; }
    lane.style.setProperty('--olv-flow-top', `${Math.round(bar.getBoundingClientRect().bottom) + 8}px`);
  };
  function bindBar(): void {
    const bar = deps.measureBar?.() ?? null;
    if (!bar || bar === boundBar) return;
    observer?.disconnect();
    boundBar = bar;
    if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(placeLane); observer.observe(bar); }
    if (typeof window !== 'undefined') window.addEventListener('resize', placeLane);
    placeLane();
  }

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
      bindBar();
      if (deps.measureOn()) deps.openMeasurePage();
      else deps.runMeasureTool();
      deps.setBoxKind();
      // After the tool switch, which dismisses any previous result.
      drawIntent = true;
    },
    isolate,
    onMeasurementsChanged() {
      bindBar();
      const all = deps.summaries();
      const grewByOne = all.length === lastCount + 1;
      lastCount = all.length;
      const s = latest();
      if (!s) { lastId = null; dismissCard(); return; }
      if (grewByOne && s.id !== lastId) {
        lastId = s.id;
        // A box that follows Draw clipping box is the one being isolated;
        // any other result leaves that intent for the box still to come.
        card.show(buildResultModel(s), s.kind === 'box' ? clipLabel() : 'Use as clipping region');
        return;
      }
      lastId = s.id;
      // Edited or renamed in place: keep the card on the same figure as the list.
      if (card.shownId === s.id) card.show(buildResultModel(s), s.kind === 'box' ? clipLabel() : 'Use as clipping region');
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
      observer?.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', placeLane);
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
      adoptClip: (c) => sh.clipPanel.adoptBounds(c),
      openClipPage: () => sh.openPage('clip'),
      toast: sh.toast,
    },
    summaries: () => (sh.ready() ? v().measure.getSummaries() : []),
    measureOn: () => sh.ready() && v().measureMode,
    measureBar: () => (sh.ready() ? v().measureElements.hint : null),
    runMeasureTool: () => sh.runTool('measure'),
    openMeasurePage: () => sh.openPage('measure'),
    setBoxKind: () => v().measure.setKind('box'),
    openDetails: (id) => { sh.openPage('measure'); sh.measurePanel()?.focusRow(id); },
  });
  sh.clipPanel.setOnDrawBox(() => flow.drawClippingBox());
  return flow;
}
