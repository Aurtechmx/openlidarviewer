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
 * `ui/labSurface.ts`, so the scene stays in view while it is open. A Flow
 * Pulse or Terrain Access row runs its lab in one click: the lab's entry runs
 * terrain first when there is no result yet.
 *
 * Every page leads with its conclusion (status and reason), then a `Why?`
 * disclosure with the full reasons (on Terrain, the whole Process Studio
 * panel), then the task itself with its Evidence and Method. The Flow Pulse
 * and Terrain Access pages fold both into the lab's own status chip instead,
 * so their map comes first, and Contours folds them into one status line the
 * same way, so its action comes first. After a run the Terrain page's next
 * step sits under its verdict: Make contours opens the Contours page with
 * Contour Studio open, so a contour file is one export away.
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
  TERRAIN_FIRST,
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
import { setLabPageHost, setLabPageStatus } from '../../ui/labSurface';
import { publishAnalysisRows } from '../../process/analysisRowsFeed';

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
  /** The slot under the run's verdict, shown only while the panel holds a result. */
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

/** The labs whose page leads with their map and fold the verdict into a status chip. */
const CHIP_LABS: ReadonlySet<AnalysePage> = new Set(['flow-pulse', 'terrain-access']);

/** Pages whose header verdict and `Why?` are folded into one status line. */
const FOLDED: ReadonlySet<AnalysePage> = new Set([...CHIP_LABS, 'contours']);

/** A routine missing prerequisite reads as what the step needs, not as Blocked. */
const tone = (r: Pick<AnalysisRow, 'status' | 'needs'>): string => (r.needs ? 'needs' : r.status);

function badge(r: Pick<AnalysisRow, 'status' | 'needs'>): HTMLElement {
  return el('span', { className: `olv-ah-badge is-${tone(r)}`, text: r.needs ?? STATUS_TEXT[r.status] });
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
  // A status line (the lab's chip, or Contours' own) carries the verdict and its reasons.
  if (FOLDED.has(page)) { verdict.hidden = true; why.hidden = true; }
  return { root, verdict, why, whyBody, body };
}

/**
 * A page's verdict as one line, the labs' status chip (`ui/labGuide.ts`): the
 * badge and the reason on one line, which opens to the whole reason. Built
 * here, with the same classes, so the home's chunk takes in no lab code.
 */
function statusLine(): { element: HTMLElement; set: (v: Pick<AnalysisRow, 'status' | 'reason' | 'needs'>) => void } {
  const mark = el('span', { className: 'olv-ah-badge' });
  const text = el('span', { className: 'olv-lab-chip-text' });
  const details = el('details', { className: 'olv-lab-chip' }, [el('summary', { className: 'olv-lab-chip-summary' }, [mark, text])]);
  const wrap = el('div', { className: 'olv-lab-chip-wrap' }, [details]);
  wrap.setAttribute('role', 'status');
  return {
    element: wrap,
    set(v) {
      details.className = `olv-lab-chip is-${tone(v)}`;
      mark.className = `olv-ah-badge is-${tone(v)}`;
      mark.textContent = v.needs ?? STATUS_TEXT[v.status];
      text.textContent = v.reason;
    },
  };
}

export function createAnalyseWorkspace(d: AnalyseWorkspaceDeps): AnalyseWorkspace {
  let router: WorkspaceRouter | null = null;
  const list = el('ul', { className: 'olv-ah-list' });
  const home = el('section', { className: 'olv-analyse-home', ariaLabel: 'Analyses' }, [list]);
  // The Terrain page's next step once a run has produced a result: Make
  // contours (Contour Studio open), or the Contours page when they are blocked.
  // It sits in the panel's slot under the run's verdict, which the panel shows
  // only while it holds a result.
  const contoursLink = el('button', { className: 'olv-at-link is-primary', type: 'button', tip: 'Contour lines from this run: open Contour Studio, or see what blocks it.' });
  const nextStep = el('div', { className: 'olv-at-next' }, [contoursLink]);
  const contoursLine = statusLine();
  const shells: Record<AnalysePage, PageShell> = {
    terrain: pageShell('terrain'),
    contours: pageShell('contours', contoursLine.element),
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
    const shell = shells[lab];
    // A lab that finishes after the reader left its progress page lands
    // quietly: they are not pulled back from where they went.
    const route = router?.route();
    const quiet = !!shell.body.querySelector('.olv-lab-preparing') && !(route?.mode === 'analyse' && route.page === lab);
    labClose[lab]?.();
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
    if (!quiet) {
      router?.navigate({ mode: 'analyse', page: lab }, true);
      d.reveal?.();
    }
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
  /**
   * Contours, straight into Contour Studio: the launcher on the Contours page
   * opens it, as the palette's Go to does. A blocked launcher, or none, leaves
   * the Contours page, which says why.
   */
  async function openContours(): Promise<void> {
    await api.open('contours');
    const launch = await launcherAction();
    const route = router?.route();
    if (launch && !launch.disabled && route?.mode === 'analyse' && route.page === 'contours') launch.click();
  }
  /** The launcher's action; its chunk mounts it just after a run, so wait a moment for it. */
  function launcherAction(): Promise<HTMLButtonElement | null> {
    const find = (): HTMLButtonElement | null => shells.contours.body.querySelector<HTMLButtonElement>('.olv-contour-launcher-action');
    const now = find();
    if (now || typeof MutationObserver === 'undefined') return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (b: HTMLButtonElement | null): void => { obs.disconnect(); clearTimeout(timer); resolve(b); };
      const obs = new MutationObserver(() => { const b = find(); if (b) done(b); });
      obs.observe(shells.contours.body, { childList: true, subtree: true });
      const timer = setTimeout(() => done(null), 5000);
    });
  }
  contoursLink.addEventListener('click', () => { void openContours(); });

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

  /**
   * A lab row's primary action: open the lab's page when it is already
   * showing a result, else run it (terrain first when there is none). None
   * when the row is blocked before any terrain run by something else.
   */
  function labRunButton(row: AnalysisRow, hasDtm: boolean): HTMLElement | null {
    if (row.status === 'blocked' && row.needs !== TERRAIN_FIRST && !hasDtm) return null;
    const page = row.id as AnalysePage;
    const shown = available(page);
    const name = LAB_NAME[row.id as LabId];
    const b = el('button', {
      className: 'olv-ah-run', type: 'button', text: `${shown ? 'Open' : 'Run'} ${name}`,
      tip: shown ? `Show the ${name} result.` : hasDtm ? `Run ${name} on the latest ground surface.` : `Run terrain analysis, then ${name}.`,
    });
    b.addEventListener('click', () => { void api.open(page); });
    return b;
  }

  /** A lab already showing a result opens as it is; otherwise its entry runs it. */
  function openRow(id: AnalysisId): void {
    void api.open(id as AnalysePage);
  }

  function renderVerdict(shell: PageShell, v: Pick<AnalysisRow, 'status' | 'reason' | 'remedy' | 'needs'>): void {
    shell.verdict.className = `olv-at-verdict is-${tone(v)}`;
    shell.verdict.replaceChildren(badge(v), el('span', { className: 'olv-at-reason', text: v.reason }));
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
        panel.linksHost().replaceChildren(nextStep);
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
      publishAnalysisRows(rows);
      const items = rows.map((row) => {
        const lab = CHIP_LABS.has(row.id as AnalysePage);
        // One action per card. A lab's is its Run (or Open) button, so its
        // heading is a title, not a second control for the same thing. Before
        // a run the Terrain card's is the run itself, one click from home, and
        // its heading opens the page without running. Every other card's
        // heading is its one way in.
        let action: HTMLElement | null = null;
        if (lab) action = labRunButton(row, inp.produced.has('dtm'));
        else if (row.id === 'terrain' && !inp.produced.has('dtm') && row.status !== 'blocked') {
          action = el('button', { className: 'olv-ah-run', type: 'button', text: 'Run terrain analysis', tip: 'Build the ground surface and check it for terrain products.' });
          action.addEventListener('click', () => d.runAction('analyse.run'));
        }
        const title = [el('span', { className: 'olv-ah-name', text: row.label }), badge(row)];
        let head: HTMLElement;
        if (lab && action) {
          head = el('div', { className: 'olv-ah-head' }, title);
        } else {
          head = el('button', { className: 'olv-ah-open', type: 'button' }, title);
          head.addEventListener('click', () => openRow(row.id));
        }
        // A lab with nothing to review shows its purpose alone; the badge says the rest.
        const quiet = lab && (row.status === 'ready' || row.needs === TERRAIN_FIRST);
        const li = el('li', { className: `olv-ah-row is-${tone(row)}` }, quiet ? [head] : [
          head,
          el('p', { className: 'olv-ah-reason', text: row.reason, title: row.reason }),
        ]);
        li.dataset.analysis = row.id;
        const purpose = LAB_PURPOSE[row.id as LabId];
        if (purpose) li.append(el('p', { className: 'olv-ah-hint', text: purpose }));
        if (row.remedy) li.append(remedyButton(row.remedy));
        if (action) li.append(action);
        return li;
      });
      // With contours produced, Contours is a child row under Terrain, one click
      // from home; it opens straight into Contour Studio, as Make contours does.
      const contours = contoursStatus(inp);
      if (inp.produced.has('contours')) {
        const open = el('button', { className: 'olv-ah-open', type: 'button' }, [
          el('span', { className: 'olv-ah-name', text: 'Contours' }),
          badge(contours),
        ]);
        open.addEventListener('click', () => { void openContours(); });
        const child = el('li', { className: `olv-ah-row is-child is-${tone(contours)}` }, [
          open,
          el('p', { className: 'olv-ah-reason', text: contours.reason, title: contours.reason }),
        ]);
        child.dataset.analysis = 'contours';
        items.splice(1, 0, child);
      }
      list.replaceChildren(...items);
      // The Terrain page's next step: Make contours, which opens Contour
      // Studio; a blocked result keeps a quiet link to the page that says why.
      const made = inp.produced.has('contours');
      const blocked = contours.status === 'blocked';
      contoursLink.className = blocked ? 'olv-at-link' : 'olv-at-link is-primary';
      contoursLink.replaceChildren(...(blocked
        ? [el('span', { className: 'olv-ah-name', text: 'Contours' }), badge(contours)]
        : [el('span', { className: 'olv-ah-name', text: 'Make contours' })]));
      contoursLink.dataset.made = String(made);
      contoursLine.set(contours);
      // Whether the Terrain page's own verdict says more than the run's: a
      // sampled scan is held at Review whatever the run found, and that must
      // stay in view above "Ready for terrain products".
      let terrainHeaderAdds = false;
      for (const row of rows) {
        const page = pageOf[row.id];
        if (!page) continue;
        if (CHIP_LABS.has(page)) {
          setLabPageStatus(page as LabId, { tone: tone(row), badge: row.needs ?? STATUS_TEXT[row.status], reason: row.reason });
          continue;
        }
        // The Terrain page shows the run's verdict in full just below, so its
        // header points there instead of repeating the same sentence.
        const repeatsRun = page === 'terrain' && row.status === 'review' && !!inp.terrainRun && row.reason === inp.terrainRun.verdict;
        renderVerdict(shells[page], repeatsRun ? { ...row, reason: 'The terrain verdict and what to do next are below.' } : row);
        if (page === 'terrain') terrainHeaderAdds = row.status !== 'ready' && !repeatsRun;
        // Terrain's Why? is the Process Studio panel; the others carry the full reason.
        if (page !== 'terrain') shells[page].whyBody.replaceChildren(el('p', { className: 'olv-why-reason', text: row.reason }));
      }
      // After a run the panel's verdict is the Terrain page's status line, with
      // Make contours under it and Why? first among the details below; the
      // page's own verdict stays above it only when it says more (a sample).
      // Before one, the page leads with its own verdict and Why?.
      const t = shells.terrain;
      const links = d.analysePanel()?.linksHost();
      t.verdict.hidden = !!inp.terrainRun && !!links && !terrainHeaderAdds;
      if (inp.terrainRun && links) {
        if (t.why.parentElement !== links) links.append(t.why);
      } else if (t.why.parentElement !== t.root) {
        t.root.insertBefore(t.why, t.body);
      }
      for (const [page, s] of Object.entries(shells) as [AnalysePage, PageShell][]) {
        s.root.classList.toggle('olv-hidden', !available(page));
      }
      router?.sync();
    },
  };
  d.studio.subscribe(() => api.refresh());
  return api;
}
