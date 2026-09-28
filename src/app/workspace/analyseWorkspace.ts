/**
 * analyseWorkspace.ts
 *
 * The Analyse mode as a home and its task pages. The home lists one row per
 * analysis with its status (ready, review or blocked) and a one-line reason,
 * read from the verdicts Process Studio already renders
 * (`process/analysisStatus.ts`). A blocked row that something can lift shows
 * that fix as a button. Terrain, its Contours, Objects & Space and the
 * scan-dependent Feature candidates and Range frames are router pages. The
 * Flow Pulse and Terrain Access labs are pages under Terrain and Observatory
 * is a page of its own: each lab places its body here through
 * `ui/labSurface.ts`, so the scene stays in view while it is open.
 *
 * Every page leads with its conclusion (status and reason), then a `Why?`
 * disclosure with the full reasons (on Terrain, the whole Process Studio
 * panel), then the task itself with its Evidence and Method.
 *
 * The panels are live nodes, never recreated: the Analyse panel, the sections
 * it lends out (`AnalysePanel.part`), the Object panel and the Process Studio
 * panel are re-parented into the page shells on the desktop and handed back
 * on a phone. This module imports no analysis subsystem, so the home costs
 * nothing until a row is opened.
 */

import { el } from '../../ui/dom';
import {
  analysisRows,
  contoursStatus,
  type AnalysisId,
  type AnalysisRemedy,
  type AnalysisRow,
  type AnalysisStatusInput,
  type TerrainRunUsability,
} from '../../process/analysisStatus';
import type { ProcessStudioState } from '../processStudioMount';
import type { PreflightActionId, ToolId } from '../../process/toolPreflight';
import type { WorkspacePage, WorkspaceRouter } from './workspaceRouter';
import { LAB_NAME, LAB_PURPOSE, type LabId } from '../../process/labGuideCopy';
import { labReturn, setLabReturn } from '../labReturn';
import { setLabPageHost } from '../../ui/labSurface';

/** The slice of the mounted Process Studio the home reads. */
export interface AnalyseStudio {
  state(): ProcessStudioState;
  subscribe(fn: () => void): () => void;
  canRemediate(action: PreflightActionId, tool: ToolId): boolean;
  remediate(action: PreflightActionId, tool: ToolId): void;
}

/** The slice of the Analyse panel the pages borrow. */
export interface AnalyseHostPanel {
  readonly element: HTMLElement;
  part(name: 'contours' | 'range' | 'features'): HTMLElement;
  hasPart(name: 'contours' | 'range' | 'features'): boolean;
  restoreParts(): void;
  linksHost(): HTMLElement;
  setPartsListener(fn: (() => void) | null): void;
  /** The last run's own usability, or null before a run. */
  runUsability(): TerrainRunUsability | null;
}

export interface AnalyseWorkspaceDeps {
  readonly studio: AnalyseStudio;
  /** The Process Studio panel, shown in the Terrain page's `Why?`. */
  readonly processStudio: HTMLElement;
  readonly analysePanel: () => AnalyseHostPanel | null;
  readonly objectPanel: () => { readonly element: HTMLElement } | null;
  /** Mount and show the Analyse panel (never runs anything). */
  readonly showTerrain: () => Promise<unknown> | void;
  /** Mount and show the Object panel. */
  readonly showObjects: () => Promise<unknown> | void;
  /** Run a command-palette action by id (the lab and Observatory entries). */
  readonly runAction: (id: string) => void;
  /** True while the phone layout owns the panels. */
  readonly isMobile: () => boolean;
  /** Whether the active scan declares scanner setups; absent when not known. */
  readonly hasStations?: () => boolean | undefined;
  /** Whether a scan is open; without one the labs have no page to show. */
  readonly hasScan?: () => boolean;
  /** Bring the Analyse pages on screen (the phone sheet, when lowered). */
  readonly reveal?: () => void;
}

/** The Analyse pages: Contours, Flow Pulse and Terrain Access sit under Terrain. */
export type AnalysePage = 'terrain' | 'contours' | 'objects' | 'features' | 'range' | LabId;

export interface AnalyseWorkspace {
  /** The home, mounted as the first child of the Analyse mode. */
  readonly home: HTMLElement;
  readonly pages: Record<AnalysePage, WorkspacePage>;
  /** Wire the router the pages navigate with. */
  attach(router: WorkspaceRouter): void;
  /** Put the live panels in their page shells (desktop) or give them back (phone). */
  place(host: HTMLElement): void;
  /** Mount what a page needs, then show it. */
  open(page: AnalysePage): Promise<void>;
  /** Re-read the statuses and repaint the home and the page headers. */
  refresh(): void;
}

const STATUS_TEXT = { ready: 'Ready', review: 'Review', blocked: 'Blocked', present: 'Scanner grid present' } as const;

/** A lab row runs the same entry the palette offers; the lab then shows its page. */
const LAB_ACTION: Partial<Record<AnalysisId, string>> = {
  'flow-pulse': 'analyse.flowPulse',
  'terrain-access': 'analyse.terrainAccess',
  observatory: 'analyse.observatory',
};

function badge(status: AnalysisRow['status']): HTMLElement {
  return el('span', { className: `olv-ah-badge is-${status}`, text: STATUS_TEXT[status] });
}

interface PageShell {
  readonly root: HTMLElement;
  readonly verdict: HTMLElement;
  readonly why: HTMLElement;
  readonly whyBody: HTMLElement;
  readonly body: HTMLElement;
}

function pageShell(page: AnalysePage, extra: HTMLElement | null = null): PageShell {
  const verdict = el('div', { className: 'olv-at-verdict' });
  verdict.setAttribute('role', 'status');
  const whyBody = el('div', { className: 'olv-why-body' });
  const why = el('details', { className: 'olv-why' }, [el('summary', { className: 'olv-why-summary', text: 'Why?' }), whyBody]);
  const body = el('div', { className: 'olv-at-body' });
  const root = el('section', { className: 'olv-analyse-page' }, extra ? [verdict, extra, why, body] : [verdict, why, body]);
  root.dataset.page = page;
  return { root, verdict, why, whyBody, body };
}

export function createAnalyseWorkspace(d: AnalyseWorkspaceDeps): AnalyseWorkspace {
  let router: WorkspaceRouter | null = null;
  const list = el('ul', { className: 'olv-ah-list' });
  const home = el('section', { className: 'olv-analyse-home', ariaLabel: 'Analyses' }, [list]);
  // The way back to a lab that started the terrain run.
  const backLink = el('div', { className: 'olv-at-back-host' });
  const shells: Record<AnalysePage, PageShell> = {
    terrain: pageShell('terrain', backLink),
    contours: pageShell('contours'),
    objects: pageShell('objects'),
    features: pageShell('features'),
    range: pageShell('range'),
    'flow-pulse': pageShell('flow-pulse'),
    'terrain-access': pageShell('terrain-access'),
    observatory: pageShell('observatory'),
  };
  const scanOpen = (): boolean => (d.hasScan ? d.hasScan() : !!d.studio.state().facts);
  // Each open lab's close, run when the lab is replaced or closed.
  const labClose: Partial<Record<LabId, () => void>> = {};
  setLabPageHost((lab, body, onClose) => {
    // With no scan the workspace is not on screen: the lab takes a dialog.
    if (!scanOpen()) return null;
    labClose[lab]?.();
    const shell = shells[lab];
    shell.body.replaceChildren(body);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (labClose[lab] === close) delete labClose[lab];
      body.remove();
      onClose?.();
      api.refresh();
    };
    labClose[lab] = close;
    api.refresh();
    router?.navigate({ mode: 'analyse', page: lab }, true);
    d.reveal?.();
    return { element: shell.root, close };
  });
  // A panel shown or hidden by its owner (the scan route, the dock toggle)
  // changes which pages exist, so the home and the route follow it.
  const watched = new WeakSet<HTMLElement>();
  const watch = (n: HTMLElement): void => {
    if (watched.has(n) || typeof MutationObserver === 'undefined') return;
    watched.add(n);
    new MutationObserver(() => api.refresh()).observe(n, { attributes: true, attributeFilter: ['style', 'class'] });
  };
  // The Terrain page's primary action once a run has produced a result.
  const contoursLink = el('button', { className: 'olv-at-link is-primary', type: 'button' });

  contoursLink.addEventListener('click', () => { void api.open('contours'); });

  const input = (): AnalysisStatusInput => {
    const s = d.studio.state();
    const panel = d.analysePanel();
    return {
      ...s,
      hasRange: panel?.hasPart('range') ?? false,
      hasFeatures: panel?.hasPart('features') ?? false,
      terrainRun: panel?.runUsability() ?? null,
      hasStations: d.hasStations?.(),
      canRemediate: (a, t) => d.studio.canRemediate(a, t),
    };
  };

  /** Whether a page has something live to show; its shell is hidden otherwise. */
  function available(page: AnalysePage): boolean {
    const panel = d.analysePanel();
    const shown = (n: HTMLElement | undefined): boolean => !!n && n.style.display !== 'none' && !n.classList.contains('olv-hidden');
    switch (page) {
      case 'terrain': return shown(panel?.element);
      case 'contours': return !!panel;
      case 'objects': return shown(d.objectPanel()?.element);
      case 'features': return !!panel?.hasPart('features');
      case 'range': return !!panel?.hasPart('range');
      default: return !!shells[page].body.firstChild;
    }
  }

  const remedyButton = (r: AnalysisRemedy): HTMLElement => {
    const b = el('button', { className: 'olv-ah-remedy', type: 'button', text: r.label });
    b.addEventListener('click', () => {
      if (r.kind === 'page') void api.open(r.page);
      else d.studio.remediate(r.action, r.tool);
    });
    return b;
  };

  function openRow(id: AnalysisId): void {
    const lab = LAB_ACTION[id];
    if (lab) d.runAction(lab);
    else void api.open(id as AnalysePage);
  }

  function renderVerdict(shell: PageShell, v: Pick<AnalysisRow, 'status' | 'reason' | 'remedy'>): void {
    shell.verdict.className = `olv-at-verdict is-${v.status}`;
    shell.verdict.replaceChildren(badge(v.status), el('span', { className: 'olv-at-reason', text: v.reason }));
    if (v.remedy) shell.verdict.append(remedyButton(v.remedy));
  }

  const pageOf: Partial<Record<AnalysisId, AnalysePage>> = {
    terrain: 'terrain', objects: 'objects', features: 'features', range: 'range',
    'flow-pulse': 'flow-pulse', 'terrain-access': 'terrain-access', observatory: 'observatory',
  };

  const api: AnalyseWorkspace = {
    home,
    pages: {
      terrain: { title: 'Terrain', element: () => shells.terrain.root },
      contours: { title: 'Contours', element: () => shells.contours.root, parent: 'terrain' },
      objects: { title: 'Objects & Space', element: () => shells.objects.root },
      features: { title: 'Feature candidates', element: () => shells.features.root },
      range: { title: 'Range frames', element: () => shells.range.root },
      'flow-pulse': { title: LAB_NAME['flow-pulse'], element: () => shells['flow-pulse'].root, parent: 'terrain' },
      'terrain-access': { title: LAB_NAME['terrain-access'], element: () => shells['terrain-access'].root, parent: 'terrain' },
      observatory: { title: LAB_NAME.observatory, element: () => shells.observatory.root },
    },
    attach(r) {
      router = r;
    },
    place(host) {
      const panel = d.analysePanel();
      if (home.parentElement !== host) host.insertBefore(home, host.firstChild);
      for (const s of Object.values(shells)) if (s.root.parentElement !== host) host.append(s.root);
      if (panel) {
        panel.setPartsListener(() => api.refresh());
        watch(panel.element);
        shells.terrain.body.append(panel.element);
        panel.linksHost().replaceChildren(contoursLink);
        shells.contours.body.append(panel.part('contours'));
        shells.features.body.append(panel.part('features'));
        shells.range.body.append(panel.part('range'));
      }
      shells.terrain.whyBody.append(d.processStudio);
      const object = d.objectPanel();
      if (object) {
        shells.objects.body.append(object.element);
        watch(object.element);
      }
      api.refresh();
    },
    async open(page) {
      // A lab already on its page is shown as it is; otherwise its entry
      // loads the chunk and the lab places itself on the page.
      const lab = LAB_ACTION[page as AnalysisId];
      if (lab && !available(page)) { d.runAction(lab); return; }
      if (page === 'terrain' || page === 'contours') await d.showTerrain();
      if (page === 'objects') await d.showObjects();
      router?.navigate({ mode: 'analyse', page }, true);
    },
    refresh() {
      // Closing the scan ends every open lab; a new scan starts them afresh.
      if (!scanOpen()) for (const close of Object.values(labClose)) close?.();
      const inp = input();
      const rows = analysisRows(inp);
      const items = rows.map((row) => {
        const open = el('button', { className: 'olv-ah-open', type: 'button' }, [
          el('span', { className: 'olv-ah-name', text: row.label }),
          badge(row.status),
        ]);
        open.addEventListener('click', () => openRow(row.id));
        const li = el('li', { className: `olv-ah-row is-${row.status}` }, [
          open,
          el('p', { className: 'olv-ah-reason', text: row.reason, title: row.reason }),
        ]);
        li.dataset.analysis = row.id;
        const purpose = LAB_PURPOSE[row.id as LabId];
        if (purpose) li.append(el('p', { className: 'olv-ah-hint', text: purpose }));
        if (row.remedy) li.append(remedyButton(row.remedy));
        // Before a run, the Terrain row carries the run itself: one click from home.
        if (row.id === 'terrain' && !inp.produced.has('dtm') && row.status !== 'blocked') {
          const run = el('button', { className: 'olv-ah-remedy', type: 'button', text: 'Run terrain analysis' });
          run.addEventListener('click', () => d.runAction('analyse.run'));
          li.append(run);
        }
        return li;
      });
      // With contours produced, Contours is a child row under Terrain, one click from home.
      const contours = contoursStatus(inp);
      if (inp.produced.has('contours')) {
        const open = el('button', { className: 'olv-ah-open', type: 'button' }, [
          el('span', { className: 'olv-ah-name', text: 'Contours' }),
          badge(contours.status),
        ]);
        open.addEventListener('click', () => { void api.open('contours'); });
        const child = el('li', { className: `olv-ah-row is-child is-${contours.status}` }, [
          open,
          el('p', { className: 'olv-ah-reason', text: contours.reason, title: contours.reason }),
        ]);
        child.dataset.analysis = 'contours';
        items.splice(1, 0, child);
      }
      list.replaceChildren(...items);
      // After a terrain run a lab started, the Terrain page offers the way back.
      const back = labReturn();
      backLink.replaceChildren();
      if (back && inp.produced.has('dtm')) {
        const b = el('button', { className: 'olv-at-link olv-at-back', type: 'button', text: `Back to ${LAB_NAME[back]}`, tip: `Reopen ${LAB_NAME[back]} on the new ground surface.` });
        b.addEventListener('click', () => { setLabReturn(null); d.runAction(LAB_ACTION[back]!); });
        backLink.append(b);
      }
      // Before contours exist the link offers to make them; after, it opens them.
      const made = inp.produced.has('contours');
      contoursLink.replaceChildren(el('span', { className: 'olv-ah-name', text: made ? 'Contours' : 'Create contours' }), badge(contours.status));
      contoursLink.dataset.made = String(made);
      renderVerdict(shells.contours, contours);
      for (const row of rows) {
        const page = pageOf[row.id];
        if (!page) continue;
        // The Terrain page shows the run's verdict in full just below, so its
        // header points there instead of repeating the same sentence.
        const repeatsRun = page === 'terrain' && row.status === 'review' && !!inp.terrainRun && row.reason === inp.terrainRun.verdict;
        renderVerdict(shells[page], repeatsRun ? { ...row, reason: 'The terrain verdict and what to do next are below.' } : row);
        // Terrain's Why? is the Process Studio panel; the others carry the full reason.
        if (page !== 'terrain') shells[page].whyBody.replaceChildren(el('p', { className: 'olv-why-reason', text: row.reason }));
      }
      shells.contours.whyBody.replaceChildren(el('p', { className: 'olv-why-reason', text: contours.reason }));
      for (const [page, s] of Object.entries(shells) as [AnalysePage, PageShell][]) {
        s.root.classList.toggle('olv-hidden', !available(page));
      }
      router?.sync();
    },
  };
  d.studio.subscribe(() => api.refresh());
  return api;
}
