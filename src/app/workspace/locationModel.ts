/**
 * locationModel.ts
 *
 * The location bar's crumbs as a pure function of the route, the page registry
 * the router already holds, and the registered workspace names (spec CE-1,
 * CE-LOC-02). Nothing here reads the DOM or sets text: the bar renders what
 * this returns, so no surface can name a location on its own.
 */

import type { WorkspaceMode } from '../../ui/workspace/DesktopWorkspace';

/** The part of a registered page the crumbs read. */
export interface LocationPage {
  readonly title: string;
  readonly parent?: string;
}

/** A workspace that opens inside a page and adds one crumb while open. */
export interface LocationWorkspace {
  readonly name: string;
  readonly mode: WorkspaceMode;
  readonly page: string;
}

export interface LocationRegistry {
  readonly modeLabel: (m: WorkspaceMode) => string;
  readonly pages: Partial<Record<WorkspaceMode, Record<string, LocationPage>>>;
  readonly workspaces: Readonly<Record<string, LocationWorkspace>>;
}

export interface LocationRoute {
  readonly mode: WorkspaceMode;
  readonly page: string | null;
}

/** One crumb. `to` is where it navigates; the last crumb has none. */
export interface Crumb {
  readonly label: string;
  /** The full path up to and including this crumb, for its accessible name. */
  readonly path: string;
  readonly to: LocationRoute | null;
}

/** The separator the bar draws between crumbs and the path text uses. */
export const CRUMB_SEPARATOR = ' › ';

/**
 * The registered workspaces. A workspace belongs to one page, so its crumb
 * follows that page's. Names match the regions the workspaces label themselves
 * with.
 */
export const WORKSPACES: Readonly<Record<string, LocationWorkspace>> = {
  'contour-studio': { name: 'Contour Studio', mode: 'analyse', page: 'contours' },
  'range-workbench': { name: 'Range Workbench', mode: 'analyse', page: 'range' },
  'feature-review': { name: 'Feature review', mode: 'analyse', page: 'features' },
  'profile-workbench': { name: 'Profile Workbench', mode: 'work', page: 'measure' },
};

/**
 * Crumbs for a route and an open workspace (or null). A workspace that does not
 * belong to the route's page is ignored, so a stale open flag can never name a
 * place the user is not in.
 */
export function locationCrumbs(route: LocationRoute, reg: LocationRegistry, workspace: string | null = null): Crumb[] {
  const steps: Array<{ label: string; to: LocationRoute }> = [];
  steps.push({ label: reg.modeLabel(route.mode), to: { mode: route.mode, page: null } });
  const list = reg.pages[route.mode] ?? {};
  const page = route.page ? list[route.page] : undefined;
  if (route.page && page) {
    if (page.parent && list[page.parent]) steps.push({ label: list[page.parent].title, to: { mode: route.mode, page: page.parent } });
    steps.push({ label: page.title, to: { mode: route.mode, page: route.page } });
    const ws = workspace ? reg.workspaces[workspace] : undefined;
    if (ws && ws.mode === route.mode && ws.page === route.page) steps.push({ label: ws.name, to: route });
  }
  const out: Crumb[] = [];
  let path = '';
  steps.forEach((s, i) => {
    path = i === 0 ? s.label : `${path}${CRUMB_SEPARATOR}${s.label}`;
    out.push({ label: s.label, path, to: i === steps.length - 1 ? null : s.to });
  });
  return out;
}

/** The whole location as one line of text. */
export function locationText(crumbs: readonly Crumb[]): string {
  return crumbs.length ? crumbs[crumbs.length - 1].path : '';
}

/**
 * What Back does and says from a location: close the open workspace, go to the
 * page's parent, or go to the mode home. Null at a mode home.
 */
export type BackTarget =
  | { readonly kind: 'workspace'; readonly id: string; readonly label: string; readonly name: string }
  | { readonly kind: 'route'; readonly to: LocationRoute; readonly label: string; readonly name: string };

export function backTarget(route: LocationRoute, reg: LocationRegistry, workspace: string | null = null): BackTarget | null {
  const crumbs = locationCrumbs(route, reg, workspace);
  if (crumbs.length < 2) return null;
  const ws = workspace ? reg.workspaces[workspace] : undefined;
  if (ws && crumbs[crumbs.length - 1].label === ws.name && route.page === ws.page) {
    return { kind: 'workspace', id: workspace as string, label: `Close ${ws.name}`, name: `Close ${ws.name}` };
  }
  const prev = crumbs[crumbs.length - 2];
  return { kind: 'route', to: prev.to as LocationRoute, label: `← ${prev.label}`, name: `Back to ${prev.label}` };
}
