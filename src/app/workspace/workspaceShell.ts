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
 *
 * The Analyse mode works the same way: its home lists the analyses with their
 * status, and Terrain, Contours (under Terrain) and Objects & Space are pages.
 * See `analyseWorkspace.ts`.
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
import { createRailIntent, createWorkspaceRouter, type WorkspacePage, type WorkspaceRouter } from './workspaceRouter';
import { createAnalyseWorkspace, type AnalyseHostPanel, type AnalysePage, type AnalyseStudio } from './analyseWorkspace';
import { createDataHome } from './dataHome';
import { mountStateStrip, type StateStripCrs } from '../stateStrip/stateStripMount';
import { mountResultsShelf, type ResultsShelfSources, type ShelfExportPanel, type ShelfTerrainPanel } from '../results/resultsShelfMount';
import { mountLocationBar } from '../../ui/locationBar';
import { decorateViewRail } from './viewRail';
import { createModeHome, type ModeHome } from './modeHome';

/** The scene tools that open a page in the Tools mode. */
export type ToolPage = 'measure' | 'annotate' | 'clip';

interface Panel {
  readonly element: HTMLElement;
}

export interface WorkspaceShellDeps {
  overlay: HTMLElement;
  addTeardown: (fn: () => void) => void;
  rightRail: HTMLElement;
  inspector: Panel & {
    readonly sheetToggle: HTMLElement;
    workspaceDataElements(): { layers: HTMLElement };
    sourceSummary(): string;
    focusLayerHealth(): boolean;
    focusSource(): boolean;
    onSourceChange(fn: () => void): () => void;
  };
  classLegend: Panel & { presentCodes(): number[] };
  annotation: HTMLElement;
  toolLauncher: HTMLElement;
  clip: HTMLElement;
  processStudio: HTMLElement;
  /** The mounted Process Studio whose verdicts the Analyse home lists. */
  studio: AnalyseStudio;
  /** Mount and show the Analyse panel, or the Object panel. Never runs anything. */
  showTerrain: () => Promise<unknown>;
  showObjects: () => Promise<unknown>;
  /** Run a command-palette action by id. */
  runAction: (id: string) => void;
  export: ShelfExportPanel;
  measureHint: HTMLElement;
  dock: HTMLElement;
  /** Overlay layers that paint above the rails, appended in this order. */
  overlayTail: readonly HTMLElement[];
  analysePanel: () => (Panel & AnalyseHostPanel & ShelfTerrainPanel) | null;
  objectPanel: () => Panel | null;
  measurePanel: () => Panel | null;
  setMeasureMountElement: (fn: (el: HTMLElement) => void) => void;
  hasScan: () => boolean;
  onModeChange: () => void;
  /** The owners the Results shelf reads. Absent: no shelf. */
  results?: ResultsShelfSources;
  /** The CRS service the state strip reads. Absent: no strip. */
  crsService?: StateStripCrs;
}

export interface WorkspaceShell {
  readonly router: WorkspaceRouter;
  readonly mobileSheet: MobileSheet;
  /** Switch mode; the mode's remembered page comes back with it (not a tab click). */
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
  /** Re-apply the route and re-read the Results shelf's owners. */
  sync(): void;
  /** Re-evaluate the phone sheet and the rail's availability. */
  applyMobileSheet(): void;
  /** Mount what an Analyse page needs, then show it. */
  openAnalysePage(page: AnalysePage): void;
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
  let refreshDataHome = (): void => {};
  const workspace = new DesktopWorkspace({
    onModeChange: (m) => {
      // The dock's Analyse button reads pressed only while Analyse is the mode
      // shown with its panel up, so it never stays lit over another mode.
      const a = d.dock.querySelector<HTMLElement>('.olv-tool-analyse[aria-pressed]');
      if (a) {
        const p = d.analysePanel()?.element;
        const on = m === 'analyse' && !!p && p.style.display !== 'none' && !p.classList.contains('olv-hidden');
        a.classList.toggle('olv-tool-active', on);
        a.setAttribute('aria-pressed', String(on));
      }
      router?.sync();
      mobileSheet?.select(sheetTabForMode(m));
      refreshDataHome();
      d.onModeChange();
    },
  });
  const pages: Partial<Record<string, WorkspacePage>> = {
    measure: { title: 'Measure', element: () => d.measurePanel()?.element },
    annotate: { title: 'Annotate', element: () => d.annotation },
    clip: { title: 'Clip box', element: () => d.clip },
  };
  const dataPages: Record<string, WorkspacePage> = {
    classes: { title: 'Classes', element: () => d.classLegend.element },
  };
  // Keyed to the shared mobile-layout condition so JS and CSS agree.
  const mobileMql = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_LAYOUT_QUERY) : null;
  const analyse = createAnalyseWorkspace({
    studio: d.studio,
    processStudio: d.processStudio,
    analysePanel: d.analysePanel,
    objectPanel: d.objectPanel,
    showTerrain: d.showTerrain,
    showObjects: d.showObjects,
    runAction: d.runAction,
    isMobile: () => mobileMql?.matches ?? false,
    hasScan: d.hasScan,
    // A lab opened on a phone raises a lowered sheet so its page is on screen.
    reveal: () => { if (mobileSheet && mobileSheet.getDetent() === 'peek' && mobileMql?.matches) mobileSheet.setDetent('half'); },
    // The Observatory needs declared scanner setups; unknown until a layer is active.
    hasStations: () => {
      const id = d.results?.scans.activeExportTargetId();
      const cloud = id ? d.results?.viewer.getCloud(id) : undefined;
      return cloud ? (cloud.acquisitionStations?.stations.length ?? 0) > 0 : undefined;
    },
  });
  const allPages = { work: pages as Record<string, WorkspacePage>, data: dataPages, analyse: analyse.pages };
  let modeHome: ModeHome | null = null;
  router = createWorkspaceRouter(workspace, allPages, storage(), () => modeHome?.refresh());
  analyse.attach(router);
  const shown = (n: HTMLElement | null | undefined): boolean => !!n && !n.classList.contains('olv-hidden') && n.style.display !== 'none';
  modeHome = createModeHome({
    router,
    pages: allPages,
    host: (m) => workspace.mode(m),
    open: (m, page) => {
      if (m === 'analyse') void analyse.open(page as AnalysePage);
      else if (m === 'work' && !shown(pages[page]?.element())) d.runAction(`tool.${page}`);
      else router?.navigate({ mode: m, page }, true);
    },
    stateOf: (m, page) => {
      if (m === 'work' && page === 'measure') {
        const n = d.results?.viewer.measure.getMeasurements().length ?? 0;
        return n ? `${n} measurement${n === 1 ? '' : 's'}` : null;
      }
      if (m === 'analyse') return analyse.home.querySelector(`.olv-ah-row[data-analysis="${page}"] .olv-ah-badge`)?.textContent ?? null;
      return null;
    },
  });
  // A tab that switches mode opens that mode's home, which offers the
  // remembered page back. Captured before the tab's own handler switches.
  workspace.element.addEventListener('click', (e) => {
    const m = (e.target as Element | null)?.closest?.<HTMLElement>('.olv-ws-tab')?.dataset.mode;
    if (m && m !== workspace.getMode()) router?.navigate({ mode: m as WorkspaceMode, page: null });
  }, true);
  const placeAnalyse = (): void => analyse.place(workspace.mode('analyse'));
  const leftPanels = workspace.element;
  const railIntent = createRailIntent(leftPanels);
  d.addTeardown(railIntent.dispose);
  // Data home = the live layer list (re-parented out of the Inspector, which
  // keeps updating it) + compact rows. The class legend is the Classes page;
  // Layer Health stays in the Inspector, which is per-scan.
  const dataEls = d.inspector.workspaceDataElements();
  const rightCollapsed = (): boolean => d.rightRail.classList.contains('olv-right-collapsed');
  const dataHome = createDataHome({
    hasScan: d.hasScan,
    classCount: () => d.classLegend.presentCodes().length,
    sourceSummary: () => d.inspector.sourceSummary(),
    inspectorCollapsed: rightCollapsed,
    openClasses: () => router?.navigate({ mode: 'data', page: 'classes' }, true),
    openSource: () => { if (rightCollapsed()) expandRightRail(); d.inspector.focusSource(); },
    openLayerHealth: () => { if (rightCollapsed()) expandRightRail(); d.inspector.focusLayerHealth(); },
    // The empty state's own open control, so both paths share the approval gate.
    openFile: () => document.querySelector<HTMLButtonElement>('.olv-open-btn')?.click(),
  });
  refreshDataHome = dataHome.refresh;
  d.addTeardown(d.inspector.onSourceChange(dataHome.refresh));
  decorateViewRail(d.inspector.element, () => router?.navigate({ mode: 'analyse', page: null }, true));
  const expandRightRail = (): void => d.overlay.querySelector<HTMLButtonElement>('.olv-right-rail-tab')?.click();
  const workspacePanels = {
    dataLayers: dataEls.layers,
    dataHome: dataHome.element,
    classLegend: d.classLegend.element,
    annotation: d.annotation,
    toolLauncher: d.toolLauncher,
    clip: d.clip,
    analyseHome: analyse.home,
    export: d.export.element,
  };
  workspace.layoutDesktop(workspacePanels);
  placeAnalyse();
  d.export.element.classList.remove('olv-collapsed'); // one mode at a time, from first build
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
    label: 'View',
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
      if (m) router?.navigate({ mode: m, page: null }); // the mode's home, with Continue
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
    if (shelf) sheet.slot('data').prepend(shelf.element); // the Results row leads the Data tab
    d.export.element.classList.remove('olv-collapsed');
    // The now-empty left column would still capture touches over its band.
    leftPanels.classList.add('olv-hidden');
    d.inspector.sheetToggle.classList.add('olv-hidden');
    router?.sync();
  };
  const toDesktopLayout = (): void => {
    d.analysePanel()?.element.classList.remove('olv-collapsed');
    d.export.element.classList.remove('olv-collapsed');
    for (const m of modes) wsBody.append(workspace.mode(m));
    leftPanels.classList.remove('olv-hidden');
    d.inspector.sheetToggle.classList.remove('olv-hidden');
    d.rightRail.append(d.inspector.element);
    router?.sync();
    if (shelf) leftPanels.append(shelf.element);
  };

  // Results shelf: the rail's footer on desktop, a row atop the phone sheet's
  // Data tab. Placed by the two layout functions above. A route change selects
  // the matching sheet tab through the mode change.
  const shelf = d.results ? mountResultsShelf(d.results, d.analysePanel, d.export, (route) => router?.navigate(route), d.runAction) : null;
  if (shelf) { leftPanels.append(shelf.element); d.addTeardown(() => shelf.dispose()); }

  // The state strip: one row at the foot of the viewport, above the dock on a
  // phone. It reads the owners through its providers and only navigates.
  const results = d.results;
  const strip = d.crsService && results ? mountStateStrip({
    crs: d.crsService,
    streamingName: () => results.viewer.streamingCloud?.name,
    activeCloudName: () => results.scans.activeCloud?.()?.name,
    onActiveChange: (fn) => results.scans.onActiveChange(fn),
    studio: d.studio,
    results: shelf?.index ?? null,
    hasScan: d.hasScan,
    open: (item) => {
      if (item === 'processing' || item === 'review') { router?.navigate({ mode: 'analyse', page: null }, true); return; }
      router?.navigate({ mode: 'data', page: null }, item === 'dataset');
      if (item === 'dataset') return;
      if (rightCollapsed()) expandRightRail();
      if (item === 'basis') d.inspector.focusLayerHealth() || d.inspector.focusSource();
      else d.inspector.focusSource();
    },
  }) : null;
  if (strip) { d.overlay.insertBefore(strip.element, d.dock); d.addTeardown(() => strip.dispose()); }

  let mobileApplied = false;
  let located = false;
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
    if (!d.hasScan()) analyse.refresh(); // a closed scan ends its labs
    // The location bar arrives with the first scan (spec CE-1, section 3).
    if (d.hasScan() && !located) {
      located = true;
      d.addTeardown(mountLocationBar(router as WorkspaceRouter, allPages, d.runAction, analyse.open).dispose);
    }
    dataHome.refresh();
    strip?.refresh();
  };
  mobileMql?.addEventListener('change', applyMobileSheet);
  mobileMql?.addEventListener('change', placeAnalyse); // after the layout flip above
  d.addTeardown(() => {
    mobileMql?.removeEventListener('change', applyMobileSheet);
    mobileMql?.removeEventListener('change', placeAnalyse);
  });
  // Class counts and the rail collapse change outside any route; keep the rows current.
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => dataHome.refresh());
    mo.observe(d.classLegend.element, { childList: true, subtree: true });
    mo.observe(d.rightRail, { attributes: true, attributeFilter: ['class'] });
    d.addTeardown(() => mo.disconnect());
  }
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
    sync: () => { live.sync(); shelf?.refresh(); },
    resumeToolPage: (id) => {
      const page = id.slice(5) as ToolPage;
      const node = id.startsWith('tool.') ? pages[page]?.element() : null;
      const up = !!node && !node.classList.contains('olv-hidden') && node.style.display !== 'none';
      if (up) live.navigate({ mode: 'work', page }, railIntent.startedInRail());
      return up;
    },
    openToolPage: (page) => {
      live.navigate({ mode: 'work', page }, railIntent.startedInRail());
      // A tool just started: on a phone, drop the sheet so the scene is free to
      // tap. The Tools tab keeps the page, so opening the sheet again shows it.
      if (mobileApplied) sheet.setDetent('peek');
    },
    applyMobileSheet,
    openAnalysePage: (page) => { void analyse.open(page); },
    mountAnalysePanel: (el) => {
      el.classList.remove('olv-collapsed'); // constructs collapsed; hides its action
      workspace.mountInMode('analyse', el);
      placeAnalyse();
      shelf?.refresh(); // the index subscribes to the new panel's result signal
    },
    mountObjectPanel: (el) => {
      workspace.mountInMode('analyse', el);
      placeAnalyse();
    },
  };
}
