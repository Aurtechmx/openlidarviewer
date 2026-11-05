/**
 * railReveal.ts
 *
 * Bring a rail back for a press that asked for something inside it. Always
 * one-off: the stored collapse stays the user's own choice from the grabber, so
 * a reload restores it, and only explicit opens call in here, never automatic
 * routing. Focus mode exits first, because it restores its own snapshot.
 */
import type { FocusRail } from './focusMode';
import type { WorkspaceMode } from '../../ui/workspace/DesktopWorkspace';

export interface RailRevealDeps {
  mobile(): boolean;
  focus(): { exit(): void } | null;
  left: FocusRail;
}

export function revealLeftRail(d: RailRevealDeps): void {
  if (d.mobile()) return;
  d.focus()?.exit();
  d.left.setCollapsed(false, { persist: false });
}

/**
 * What opening a tool's page does to a hidden rail. Clip's controls are on its
 * page, and a page asked for by name is there to be read. Measure and Annotate
 * work on the scene with their own visible hint, so a user who hid the rail
 * keeps the scene and is told where the page went.
 */
export function toolPageReveal(page: string, options: { readonly reveal?: boolean } | undefined, collapsed: boolean): 'reveal' | 'note' | null {
  if (options?.reveal || page === 'clip') return 'reveal';
  return collapsed ? 'note' : null;
}

export interface SectionRevealDeps extends RailRevealDeps {
  right: FocusRail;
  rightRail: { contains(n: Node): boolean };
  modeHost(m: WorkspaceMode): { contains(n: Node): boolean };
  route(): { readonly mode: WorkspaceMode; readonly page: string | null };
  navigate(route: { mode: WorkspaceMode; page: string | null }): void;
  selectTab(tab: string): void;
}

const MODES: readonly WorkspaceMode[] = ['data', 'work', 'analyse', 'output'];

/**
 * Make an Inspector section reachable before it is scrolled to: the mode that
 * hosts it (at its home), then the sheet tab on a phone or the rail on a desktop.
 */
export function revealSection(d: SectionRevealDeps, target: HTMLElement): void {
  const mode = MODES.find((m) => d.modeHost(m).contains(target));
  if (mode) {
    const r = d.route();
    if (r.mode !== mode || r.page !== null) d.navigate({ mode, page: null });
  }
  if (d.mobile()) {
    const tab = target.closest<HTMLElement>('.olv-msheet-slot')?.dataset.tab;
    if (tab) d.selectTab(tab);
    return;
  }
  if (mode) { revealLeftRail(d); return; }
  if (d.rightRail.contains(target)) {
    d.focus()?.exit();
    d.right.setCollapsed(false, { persist: false });
  }
}
