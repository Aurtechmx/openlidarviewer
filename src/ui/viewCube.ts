/**
 * viewCube.ts — the lazy-loaded on-canvas ViewCube.
 *
 * A small CSS-3D cube that turns with the camera (pitch, yaw and roll), with
 * six labelled faces, twelve edges and eight corners to click, and a Home
 * control that refits the scan. Lazy on purpose: it is only mounted when
 * enabled and a scan is open, so none of this ships in the startup shell. Its
 * stylesheet (`viewCube.css`) is split into the lazy chunk with it, themed
 * through the app's custom properties, so the eager stylesheet does not grow.
 * Sizes and transforms are set through the CSSOM, which the CSP permits.
 *
 * The geometry (targets, directions, matrices, placement) lives in
 * `src/render/viewCubeMath.ts` and is unit-tested; this file is the thin DOM
 * renderer over it. The host supplies callbacks, so the widget never imports
 * the Viewer and never moves the camera itself.
 */

import {
  CUBE_TARGETS,
  activeCubeFace,
  cubeFaceLabel,
  cubeFaceMatrix,
  cubeTargetName,
  cubeTargetOrientation,
  cubeViewMatrix,
  placeCube,
  projectCubePoint,
  type CameraOrientation,
  type CubeOrientation,
  type CubeTarget,
  type PlacementRect,
  type SceneVec,
  type StandardView,
} from '../render/viewCubeMath';
import './viewCube.css';

export interface ViewCubeOptions {
  /** Where to mount the cube (the stage overlay). */
  readonly host: HTMLElement;
  /** The camera's orientation in the scene basis, read each drawn frame; null holds the cube. */
  readonly getOrientation: () => CameraOrientation | null;
  /**
   * Whether the active scan's horizontal axes are a known map grid — read each
   * frame. True shows N/E/S/W on the side faces; false shows the truthful
   * standard view names. Defaults to false.
   */
  readonly isGeographic?: () => boolean;
  /** A face was chosen: the standard view, and the orientation to turn to. */
  readonly onView: (view: StandardView, orientation: CubeOrientation) => void;
  /** An edge or corner was chosen. */
  readonly onOrient: (target: CubeTarget, orientation: CubeOrientation) => void;
  /** The Home control: refit the whole scan (the existing Frame all). */
  readonly onHome: () => void;
  /**
   * Elements the cube must stay clear of, and which way each pushes it.
   * Defaults to the expanded right rail and its tab (left), and the header and
   * a floating colour key (down).
   */
  readonly obstacles?: () => readonly CubeObstacle[];
}

/** An element the cube keeps clear of, and the way it moves the cube. */
export interface CubeObstacle {
  readonly el: Element;
  readonly push: 'left' | 'down';
}

export interface ViewCubeHandle {
  /** Re-read the orientation and turn the cube. Call after each drawn frame. */
  readonly update: () => void;
  /** Re-run the collision-aware placement (also runs on resize / rail changes). */
  readonly place: () => void;
  /** Remove the cube and detach every observer and listener. */
  readonly dispose: () => void;
}

/** True when the user asked the OS for reduced motion. */
function matches(query: string): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Desktop and touch geometry, in CSS px. */
const SIZE = {
  fine: { box: 120, half: 34, hit: 22, home: 24 },
  coarse: { box: 156, half: 42, hit: 44, home: 44 },
} as const;


/** The Home glyph, built as DOM (no markup strings): a roof over a box. */
function homeIcon(): Element | null {
  if (typeof document.createElementNS !== 'function') return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const [k, v] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.5'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) {
    svg.setAttribute(k, v);
  }
  for (const d of ['M2.5 7.5 8 3l5.5 4.5', 'M4 6.5V13h8V6.5']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** The default obstacles: rail and rail tab push left; header and floating colour key push down. */
function defaultObstacles(): CubeObstacle[] {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
  const all = (sel: string, push: CubeObstacle['push']): CubeObstacle[] =>
    [...document.querySelectorAll(sel)].map((el) => ({ el, push }));
  return [
    ...all('.olv-right-rail:not(.olv-right-collapsed)', 'left'),
    ...all('.olv-right-rail-tab', 'left'),
    ...all('.olv-topbar', 'down'),
    ...all('.olv-colorbar-floating', 'down'),
  ];
}

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

/** Mount the cube. Returns a handle with `update()`, `place()` and `dispose()`. */
export function mountViewCube(opts: ViewCubeOptions): ViewCubeHandle {
  const geo = matches('(pointer: coarse)') ? SIZE.coarse : SIZE.fine;
  const isGeographic = opts.isGeographic ?? ((): boolean => false);

  const root = document.createElement('div');
  root.className = 'olv-viewcube';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'View cube: choose a face, edge or corner to turn the camera');
  root.setAttribute('data-testid', 'viewcube');
  // The stage is the cube's square; Home sits in a strip below it, so it never
  // covers an edge or corner target.
  const height = geo.box + geo.home + 4;
  root.style.cssText = `width:${geo.box}px;height:${height}px;top:14px;right:14px;`;

  const stage = document.createElement('div');
  stage.className = 'olv-viewcube-stage';
  stage.style.cssText = `width:${geo.box}px;height:${geo.box}px;`;
  root.appendChild(stage);

  const cube = document.createElement('div');
  cube.className = 'olv-viewcube-cube';
  stage.appendChild(cube);

  const choose = (target: CubeTarget): void => {
    const o = cubeTargetOrientation(target);
    if (target.view) opts.onView(target.view, o);
    else opts.onOrient(target, o);
  };

  // ── Faces ─────────────────────────────────────────────────────────────
  const faces = new Map<StandardView, HTMLButtonElement>();
  const faceTargets = CUBE_TARGETS.filter((t) => t.kind === 'face');
  for (const t of faceTargets) {
    const view = t.view as StandardView;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'olv-viewcube-face';
    b.setAttribute('data-testid', `viewcube-${view}`);
    b.setAttribute('data-shade', view === 'top' ? 'top' : view === 'bottom' ? 'bottom' : 'side');
    b.title = cubeTargetName(t, false); // replaced by applyLabels with the frame-aware name
    const side = geo.half * 2;
    b.style.cssText =
      `width:${side}px;height:${side}px;left:${-geo.half}px;top:${-geo.half}px;` +
      `transform:matrix3d(${cubeFaceMatrix(view, geo.half).map(fmt).join(',')});`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      choose(t);
    });
    cube.appendChild(b);
    faces.set(view, b);
  }

  // ── Edges and corners: small dots in 2D over the projected cube ───────
  const spots: { readonly target: CubeTarget; readonly el: HTMLButtonElement; readonly at: SceneVec }[] = [];
  for (const t of CUBE_TARGETS) {
    if (t.kind === 'face') continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'olv-viewcube-spot';
    b.setAttribute('data-testid', `viewcube-${t.id}`);
    // Pointer and touch shortcuts; the faces, Home and the command palette carry
    // the keyboard path, so these stay out of the tab order.
    b.tabIndex = -1;
    b.title = cubeTargetName(t, false); // replaced by applyLabels with the frame-aware name
    b.style.cssText = `width:${geo.hit}px;height:${geo.hit}px;`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      choose(t);
    });
    stage.appendChild(b);
    spots.push({ target: t, el: b, at: [t.signs[0] * geo.half, t.signs[1] * geo.half, t.signs[2] * geo.half] });
  }

  // ── Home ──────────────────────────────────────────────────────────────
  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'olv-viewcube-home';
  home.setAttribute('data-testid', 'viewcube-home');
  home.setAttribute('aria-label', 'View cube home: frame all');
  home.title = 'Frame all (R): fit the camera to the entire scan';
  const icon = homeIcon();
  if (icon) home.appendChild(icon);
  home.addEventListener('click', (e) => {
    e.stopPropagation();
    home.blur();
    opts.onHome();
  });
  root.appendChild(home);

  // ── Labels (only rewritten when the frame's geographic state flips) ───
  let lastGeographic: boolean | null = null;
  const applyLabels = (geographic: boolean): void => {
    if (geographic === lastGeographic) return;
    lastGeographic = geographic;
    for (const t of faceTargets) {
      const view = t.view as StandardView;
      const el = faces.get(view);
      if (!el) continue;
      const label = cubeFaceLabel(view, geographic);
      el.textContent = label;
      const name = cubeTargetName(t, geographic);
      el.setAttribute('aria-label', name);
      el.title = name;
      el.setAttribute('data-north', geographic && label === 'N' ? 'true' : 'false');
    }
    for (const s of spots) {
      const name = cubeTargetName(s.target, geographic);
      s.el.setAttribute('aria-label', name);
      s.el.title = name;
    }
  };
  applyLabels(isGeographic());

  opts.host.appendChild(root);

  // ── Placement ─────────────────────────────────────────────────────────
  const obstacles = opts.obstacles ?? defaultObstacles;
  let lastPlacement = '';
  const place = (): void => {
    const host = opts.host;
    if (typeof host.getBoundingClientRect !== 'function') return;
    const h = host.getBoundingClientRect();
    if (h.width === 0 || h.height === 0) return;
    const rects: PlacementRect[] = [];
    for (const { el, push } of obstacles()) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Only what actually sits over the stage counts.
      if (r.right <= h.left || r.left >= h.right || r.bottom <= h.top || r.top >= h.bottom) continue;
      rects.push({ left: r.left - h.left, top: r.top - h.top, right: r.right - h.left, bottom: r.bottom - h.top, push });
    }
    const p = placeCube({ width: h.width, height: h.height }, { width: geo.box, height }, rects);
    const next = `left:${Math.round(p.left)}px;top:${Math.round(p.top)}px`;
    if (next === lastPlacement) return;
    lastPlacement = next;
    root.style.left = `${Math.round(p.left)}px`;
    root.style.top = `${Math.round(p.top)}px`;
    root.style.right = 'auto';
  };

  // Re-place on stage resize, on rail resize, on the rail collapsing or
  // expanding (a class flip, then a slide that ends in a transition) and on
  // window resize. Every one of these is detached by dispose().
  const cleanups: (() => void)[] = [];
  // Placement reads a few rects; every trigger below is already coalesced by
  // the browser (observers batch per frame), so it runs directly.
  const schedule = (): void => place();
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(schedule);
    ro.observe(opts.host);
    for (const o of obstacles()) ro.observe(o.el);
    cleanups.push(() => ro.disconnect());
  }
  if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
    // Obstacles come and go (the colour key floats only while the rail is
    // collapsed, and can mount after the cube): watch class flips and mounts
    // in the page, and re-place only when one touches an obstacle.
    const OBSTACLE = '.olv-right-rail, .olv-right-rail-tab, .olv-topbar, .olv-colorbar';
    const touches = (n: Node): boolean => n instanceof Element && (n.matches(OBSTACLE) || n.querySelector(OBSTACLE) !== null);
    if (typeof MutationObserver === 'function' && document.body) {
      const mo = new MutationObserver((records) => {
        for (const r of records) {
          if (touches(r.target) || [...r.addedNodes].some(touches)) { schedule(); return; }
        }
      });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      cleanups.push(() => mo.disconnect());
    }
    const rail = document.querySelector('.olv-right-rail');
    if (rail) {
      rail.addEventListener('transitionend', schedule);
      cleanups.push(() => rail.removeEventListener('transitionend', schedule));
    }
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', schedule);
    cleanups.push(() => window.removeEventListener('resize', schedule));
  }
  place();

  // ── Per-frame follow ──────────────────────────────────────────────────
  let lastTransform = '';
  let lastActive: StandardView | null | undefined;
  const update = (): void => {
    applyLabels(isGeographic());
    const o = opts.getOrientation();
    if (!o) return;
    const m = cubeViewMatrix(o);
    const transform = `matrix3d(${m.map(fmt).join(',')})`;
    if (transform === lastTransform) return; // the camera did not turn
    lastTransform = transform;
    cube.style.transform = transform;
    const centre = geo.box / 2;
    for (const s of spots) {
      const [x, y, z] = projectCubePoint(m, s.at);
      // Only the edges and corners on the near side are clickable.
      const visible = z > geo.half * 0.15;
      s.el.hidden = !visible;
      if (visible) {
        s.el.style.left = `${fmt(centre + x)}px`;
        s.el.style.top = `${fmt(centre + y)}px`;
      }
    }
    const active = activeCubeFace(o);
    if (active !== lastActive) {
      for (const [view, el] of faces) {
        el.classList.toggle('is-active', view === active);
        if (view === active) el.setAttribute('aria-current', 'true');
        else el.removeAttribute('aria-current');
      }
      lastActive = active;
    }
  };
  update();

  return {
    update,
    place,
    dispose: () => {
      for (const c of cleanups.splice(0)) c();
      root.remove();
    },
  };
}
