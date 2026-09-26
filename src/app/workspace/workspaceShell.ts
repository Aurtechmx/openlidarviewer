/**
 * workspaceShell.ts
 *
 * Builds the desktop left rail and the phone sheet around the live panels, and
 * owns the route that decides which of them shows. Moved out of `main.ts`
 * unchanged in behaviour: panels are re-parented, never recreated, and the
 * rail keeps `#olv-left-panels` so the collapse chrome and clearance vars still
 * find it.
 *
 * The Tools mode is one task at a time: its home is the tool launcher, and
 * each scene tool (Measure, Annotate, Clip) is a page that shows only its own
 * panel under a task header. The route is presentation only; see
 * `workspaceRouter.ts`.
 */

import { DesktopWorkspace, type WorkspaceMode } from '../../ui/workspace/DesktopWorkspace';
import { MobileSheet } from '../../ui/MobileSheet';
import { MOBILE_LAYOUT_QUERY } from '../../ui/isMobileDevice';
import {
  wireMeasureBarClearance,
  wireDockClearance,
  wireRailToggle,
  containPanelWheel,
  RAIL_CHEVRON_LEFT,
  RAIL_CHEVRON_RIGHT,
} from '../../ui/panelChrome';
import { createWorkspaceRouter, type WorkspacePage, type WorkspaceRouter } from './workspaceRouter';
import { mountResultsShelf, type ResultsShelfSources } from '../results/resultsShelfMount';

/** The scene tools that open a page in the Tools mode. */
export type ToolPage = 'measure' | 'annotate' | 'clip';

interface Panel {
  readonly element: HTMLElement;
}

export interface WorkspaceShellDeps {
  overlay: HTMLElement;
  addTeardown: (fn: () => void) => void;
  rightRail: HTMLElement;
  inspector: Panel & { readonly sheetToggle: HTMLElement; workspaceDataElements(): { layers: HTMLElement; layerHealth: HTMLElement } };
  classLegend: HTMLElement;
  annotation: HTMLElement;
  toolLauncher: HTMLElement;
  clip: HTMLElement;
  processStudio: HTMLElement;
  export: HTMLElement;
  measureHint: HTMLElement;
  dock: HTMLElement;
  /** Overlay layers that paint above the rails, appended in this order. */
  overlayTail: readonly HTMLElement[];
  analysePanel: () => Panel | null;
  objectPanel: () => Panel | null;
  measurePanel: () => Panel | null;
  setMeasureMountElement: (fn: (el: HTMLElement) => void) => void;
  hasScan: () => boolean;
  onModeChange: () => void;
  /** The owners the Results shelf reads. Absent: no shelf. */
  results?: ResultsShelfSources;
}

export interface WorkspaceShell {
  readonly router: WorkspaceRouter;
  readonly mobileSheet: MobileSheet;
  /** Switch mode; the mode's remembered page comes back with it. */
  showMode(m: WorkspaceMode): void;
  /**
   * Open a scene tool's page in Tools. Focus follows to the task heading only
   * when it was already in the rail (a launcher click), never off the canvas.
   */
  openToolPage(page: ToolPage): void;
  /**
   * For a launcher row: when the tool's panel is already up (its tool on,
   * results placed, or the clip box, which has its own switch), reopen its page
   * and return true, so the row does not switch the tool off.
   */
  resumeToolPage(actionId: string): boolean;
  /** Re-apply the route and re-read the Results shelf's owners. */
  sync(): void;
  /** Re-evaluate the phone sheet and the rail's availability. */
  applyMobileSheet(): void;
  mountAnalysePanel(el: HTMLElement): void;
  mountObjectPanel(el: HTMLElement): void;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function mountWorkspaceShell(d: WorkspaceShellDeps): WorkspaceShell {
  // One Data/Tools/Analyse/Export mode visible at a time, re-hosting the live
  // panels. measure/analyse/object lazy-mount into their modes below.
  let router: WorkspaceRouter | null = null;
  const workspace = new DesktopWorkspace({ onModeChange: () => { router?.sync(); d.onModeChange(); } });
  const pages: Partial<Record<string, WorkspacePage>> = {
    measure: { title: 'Measure', element: () => d.measurePanel()?.element },
    annotate: { title: 'Annotate', element: () => d.annotation },
    clip: { title: 'Clip box', element: () => d.clip },
  };
  router = createWorkspaceRouter(workspace, { work: pages as Record<string, WorkspacePage> }, storage());
  const leftPanels = workspace.element;
  // Data mode = the live layer browser (re-parented out of the Inspector, which
  // keeps updating the same nodes) + the class legend. Reused on mobile return.
  const dataEls = d.inspector.workspaceDataElements();
  const workspacePanels = {
    dataLayers: dataEls.layers,
    dataLayerHealth: dataEls.layerHealth,
    classLegend: d.classLegend,
    annotation: d.annotation,
    toolLauncher: d.toolLauncher,
    clip: d.clip,
    processStudio: d.processStudio,
    export: d.export,
  };
  workspace.layoutDesktop(workspacePanels);
  d.export.classList.remove('olv-collapsed'); // one mode at a time, from first build
  d.overlay.append(leftPanels);
  d.addTeardown(() => workspace.dispose());
  // Wheel ownership: a wheel over a panel scrolls the panel and never reaches
  // the camera (passive, never preventDefault).
  containPanelWheel(leftPanels);
  containPanelWheel(d.rightRail);
  // Push the column below the measure toolbar whenever it is visible; see
  // wireMeasureBarClearance for why this is measured, not static CSS.
  d.addTeardown(wireMeasureBarClearance(d.measureHint, leftPanels));
  // Keep the column above the real dock height, and add the one-tap rail collapse.
  d.addTeardown(wireDockClearance(d.dock, leftPanels));
  d.addTeardown(wireRailToggle({
    overlay: d.overlay,
    panels: [leftPanels],
    tabClass: 'olv-rail-tab',
    chevron: RAIL_CHEVRON_LEFT,
    collapsedClass: 'olv-rail-collapsed',
    storageKey: 'olv.leftRail.collapsed',
    ariaControls: 'olv-left-panels',
  }));
  // One grabber collapses the whole right context rail (Streaming + Inspector),
  // under the Inspector's persisted collapse key.
  d.addTeardown(wireRailToggle({
    overlay: d.overlay,
    panels: [d.rightRail],
    tabClass: 'olv-right-rail-tab',
    chevron: RAIL_CHEVRON_RIGHT,
    collapsedClass: 'olv-right-collapsed',
    storageKey: 'olv.rightRail.inspector.collapsed',
    ariaControls: 'olv-right-rail',
  }));
  d.overlay.append(...d.overlayTail);

  // Phone bottom sheet: below the mobile breakpoint one sheet hosts the panels
  // behind a View · Analyse · Layers tablist. The same live nodes are
  // re-parented into its slots and restored on a wider viewport.
  const mobileSheet = new MobileSheet();
  d.overlay.append(mobileSheet.element);

  const toMobileLayout = (): void => {
    const analyse = d.analysePanel();
    const object = d.objectPanel();
    const measure = d.measurePanel();
    mobileSheet.slot('view').append(d.inspector.element);
    if (analyse) mobileSheet.slot('analyse').append(analyse.element);
    if (object) mobileSheet.slot('analyse').append(object.element);
    mobileSheet.slot('layers').append(...(shelf ? [shelf.element] : []), dataEls.layers, dataEls.layerHealth);
    const layersPanels: HTMLElement[] = [d.classLegend, d.processStudio];
    if (measure) layersPanels.push(measure.element);
    layersPanels.push(d.clip, d.annotation, d.export);
    mobileSheet.slot('layers').append(...layersPanels);
    analyse?.element.classList.remove('olv-collapsed');
    d.export.classList.remove('olv-collapsed');
    // The now-empty left column would still capture touches over its band.
    leftPanels.classList.add('olv-hidden');
    d.inspector.sheetToggle.classList.add('olv-hidden');
  };
  const toDesktopLayout = (): void => {
    d.analysePanel()?.element.classList.remove('olv-collapsed');
    d.export.classList.remove('olv-collapsed');
    leftPanels.classList.remove('olv-hidden');
    d.inspector.sheetToggle.classList.remove('olv-hidden');
    d.rightRail.append(d.inspector.element);
    workspace.layoutDesktop({
      ...workspacePanels,
      measure: d.measurePanel()?.element,
      analyse: d.analysePanel()?.element,
      object: d.objectPanel()?.element,
    });
    router?.sync();
    if (shelf) leftPanels.append(shelf.element);
  };

  // Results shelf: the rail's footer on desktop, a row atop the phone sheet's
  // Layers tab. Placed by the two layout functions above.
  const shelf = d.results
    ? mountResultsShelf(d.results, (route) => {
      router?.navigate(route);
      if (mobileApplied) mobileSheet.setActive(route.mode === 'analyse' ? 'analyse' : 'layers');
    })
    : null;
  if (shelf) { leftPanels.append(shelf.element); d.addTeardown(() => shelf.dispose()); }

  // Keyed to the shared mobile-layout condition so JS and CSS agree.
  const mobileMql = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_LAYOUT_QUERY) : null;
  let mobileApplied = false;
  const applyMobileSheet = (): void => {
    const isMobile = mobileMql ? mobileMql.matches : false;
    if (isMobile !== mobileApplied) {
      if (isMobile) toMobileLayout();
      else toDesktopLayout();
      mobileApplied = isMobile;
    }
    // The sheet shows only on a phone WITH a scan; the tab strip only with a scan.
    mobileSheet.setVisible(isMobile && d.hasScan());
    workspace.setAvailable(d.hasScan());
  };
  mobileMql?.addEventListener('change', applyMobileSheet);
  applyMobileSheet();

  // Lazy Measurements panel: before the annotations panel in the mobile Layers
  // slot, else in Tools. Falls back to append so a mid-flip mount never throws.
  d.setMeasureMountElement((el) => {
    if (mobileApplied) {
      const slot = mobileSheet.slot('layers');
      if (d.annotation.parentElement === slot) slot.insertBefore(el, d.annotation);
      else slot.append(el);
    } else {
      workspace.mountInMode('work', el);
      router?.sync();
    }
  });
  router.sync();

  const live = router;
  return {
    router,
    mobileSheet,
    showMode: (m) => workspace.setMode(m),
    sync: () => { live.sync(); shelf?.refresh(); },
    resumeToolPage: (id) => {
      const page = id.slice(5) as ToolPage;
      const node = id.startsWith('tool.') ? pages[page]?.element() : null;
      const up = !!node && !node.classList.contains('olv-hidden') && node.style.display !== 'none';
      if (up) live.navigate({ mode: 'work', page }, leftPanels.contains(document.activeElement));
      return up;
    },
    openToolPage: (page) => live.navigate({ mode: 'work', page }, leftPanels.contains(document.activeElement)),
    applyMobileSheet,
    // Lazy Analyse panel: first in the mobile Analyse slot, else the Analyse mode.
    mountAnalysePanel: (el) => {
      el.classList.remove('olv-collapsed'); // constructs collapsed; hides its action
      if (mobileApplied) {
        const slot = mobileSheet.slot('analyse');
        slot.insertBefore(el, slot.firstChild);
      } else {
        workspace.mountInMode('analyse', el);
      }
    },
    // Lazy Object panel: after Analyse in the mobile slot, else the Analyse mode.
    mountObjectPanel: (el) => {
      if (mobileApplied) mobileSheet.slot('analyse').append(el);
      else workspace.mountInMode('analyse', el);
    },
  };
}
