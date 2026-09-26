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
 * `workspaceRouter.ts`. On a phone the four mode hosts move into the bottom
 * sheet's tabs whole, so the phone shows the same homes and pages.
 */

import { DesktopWorkspace, type WorkspaceMode } from '../../ui/workspace/DesktopWorkspace';
import { MobileSheet, modeForSheetTab, sheetTabForMode } from '../../ui/MobileSheet';
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
}

export interface WorkspaceShell {
  readonly router: WorkspaceRouter;
  readonly mobileSheet: MobileSheet;
  /** Switch mode; the mode's remembered page comes back with it. */
  showMode(m: WorkspaceMode): void;
  /**
   * Open a scene tool's page in Tools. Focus follows to the task heading only
   * when it was already in the rail (a launcher click), never off the canvas.
   * On a phone the sheet drops to its head so the tool can be used.
   */
  openToolPage(page: ToolPage): void;
  /**
   * For a launcher row: when the tool's panel is already up (its tool on,
   * results placed, or the clip box, which has its own switch), reopen its page
   * and return true, so the row does not switch the tool off.
   */
  resumeToolPage(actionId: string): boolean;
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
  let mobileSheet: MobileSheet | null = null;
  const workspace = new DesktopWorkspace({
    onModeChange: (m) => {
      router?.sync();
      mobileSheet?.select(sheetTabForMode(m));
      d.onModeChange();
    },
  });
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

  // Phone bottom sheet: the same four modes plus View (the Inspector). The
  // desktop mode hosts themselves are re-parented into the sheet's slots, so a
  // phone tab shows exactly the home or task page the router has for that mode.
  // One route model, two presentations; panels never leave their mode host.
  const sheet = new MobileSheet({
    initialTab: sheetTabForMode(workspace.getMode()),
    onTabChange: (tab) => {
      const m = modeForSheetTab(tab);
      if (m) workspace.setMode(m); // the mode's remembered page comes back with it
    },
  });
  mobileSheet = sheet;
  d.overlay.append(sheet.element);
  const modes: readonly WorkspaceMode[] = ['data', 'work', 'analyse', 'output'];
  const wsBody = workspace.mode('data').parentElement as HTMLElement;

  const toMobileLayout = (): void => {
    sheet.slot('view').append(d.inspector.element);
    for (const m of modes) sheet.slot(m).append(workspace.mode(m));
    if (sheet.getActive() !== 'view') sheet.select(sheetTabForMode(workspace.getMode()));
    d.analysePanel()?.element.classList.remove('olv-collapsed');
    d.export.classList.remove('olv-collapsed');
    // The now-empty left column would still capture touches over its band.
    leftPanels.classList.add('olv-hidden');
    d.inspector.sheetToggle.classList.add('olv-hidden');
    router?.sync();
  };
  const toDesktopLayout = (): void => {
    d.analysePanel()?.element.classList.remove('olv-collapsed');
    d.export.classList.remove('olv-collapsed');
    for (const m of modes) wsBody.append(workspace.mode(m));
    leftPanels.classList.remove('olv-hidden');
    d.inspector.sheetToggle.classList.remove('olv-hidden');
    d.rightRail.append(d.inspector.element);
    router?.sync();
  };

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
    sheet.setVisible(isMobile && d.hasScan());
    workspace.setAvailable(d.hasScan());
  };
  mobileMql?.addEventListener('change', applyMobileSheet);
  applyMobileSheet();

  // Lazy panels mount into their mode host on either layout; on a phone that
  // host already sits in the sheet.
  d.setMeasureMountElement((el) => {
    workspace.mountInMode('work', el);
    router?.sync();
  });
  router.sync();

  const live = router;
  return {
    router,
    mobileSheet: sheet,
    showMode: (m) => workspace.setMode(m),
    resumeToolPage: (id) => {
      const page = id.slice(5) as ToolPage;
      const node = id.startsWith('tool.') ? pages[page]?.element() : null;
      const up = !!node && !node.classList.contains('olv-hidden') && node.style.display !== 'none';
      if (up) live.navigate({ mode: 'work', page }, leftPanels.contains(document.activeElement));
      return up;
    },
    openToolPage: (page) => {
      live.navigate({ mode: 'work', page }, leftPanels.contains(document.activeElement));
      // A tool just started: on a phone, drop the sheet so the scene is free to
      // tap. The Tools tab keeps the page, so opening the sheet again shows it.
      if (mobileApplied) sheet.setDetent('peek');
    },
    applyMobileSheet,
    mountAnalysePanel: (el) => {
      el.classList.remove('olv-collapsed'); // constructs collapsed; hides its action
      workspace.mountInMode('analyse', el);
    },
    mountObjectPanel: (el) => workspace.mountInMode('analyse', el),
  };
}
