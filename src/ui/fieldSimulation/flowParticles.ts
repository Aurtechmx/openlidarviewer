/**
 * flowParticles.ts — moving marks along the D8 flow directions of a Flow
 * Pulse result grid, drawn on a transparent canvas over the grid.
 *
 * What the motion encodes: each particle sits on a routed cell and moves
 * towards that cell's D8 receiver, at a speed proportional to the cell's
 * log-scaled upstream count (the same `logScale` the grid colour and the 3D
 * overlay use). Faster particles therefore mark cells more cells drain
 * through. Particles spawn only on cells at or above SPAWN_MIN_T of that
 * scale, so motion follows the drainage lines rather than covering hillslopes.
 * At the end of a path (outlet, sink, flat) a particle respawns.
 *
 * Rules it keeps:
 * - It never hides data: dots are small and drawn on their own canvas, with no
 *   trails and no fill under them, and the grid, path and marks stay beneath.
 * - Under prefers-reduced-motion it never starts, and it stops if the setting
 *   turns on while running. The grid alone is the static view.
 * - It runs only while the canvas is on screen and the page is visible, and
 *   halves its particle count when a frame's own work exceeds FRAME_BUDGET_MS.
 * - The caller offers a pause control (WCAG 2.2.2).
 * - It is deterministic for a given seed, so screenshots and tests repeat.
 */

import { logScale } from '../../render/flowOverlayGeometry';
import { prefersReducedMotion } from './labColormaps';

/** Cells per second at the top of the log scale. Speed is this times the scale value. */
export const MAX_SPEED_CELLS_PER_S = 4;
/** Lowest log-scale value a particle may spawn on. */
export const SPAWN_MIN_T = 0.35;
/** Most particles drawn at once. */
export const MAX_PARTICLES = 220;
/** Work per frame above which the particle count is halved. */
export const FRAME_BUDGET_MS = 4;
const MAX_LIFE_S = 6;

export interface FlowParticleField {
  readonly cols: number;
  readonly rows: number;
  /** D8 receiver per cell, or -1 where flow stops or leaves. */
  readonly receiver: Int32Array;
  readonly upstreamCells: Uint32Array;
  readonly maxUpstream: number;
}

export interface Particle {
  cell: number;
  /** 0 at the cell centre, 1 at the receiver's centre. */
  progress: number;
  age: number;
}

/** mulberry32: a small deterministic PRNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speed in cells per second for a cell: proportional to its log-scaled upstream count. */
export function particleSpeed(field: FlowParticleField, cell: number): number {
  return MAX_SPEED_CELLS_PER_S * logScale(field.upstreamCells[cell]!, field.maxUpstream);
}

/** Cells a particle may spawn on: routed, with a receiver, at or above SPAWN_MIN_T. */
export function spawnCells(field: FlowParticleField): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < field.cols * field.rows; i++) {
    if (field.receiver[i]! < 0) continue;
    if (logScale(field.upstreamCells[i]!, field.maxUpstream) >= SPAWN_MIN_T) out.push(i);
  }
  return Int32Array.from(out);
}

function spawn(cells: Int32Array, rand: () => number): Particle {
  return { cell: cells[Math.floor(rand() * cells.length)]!, progress: rand(), age: 0 };
}

/** Advance every particle by `dt` seconds along its D8 direction; respawn at path ends. */
export function stepParticles(
  field: FlowParticleField, particles: Particle[], cells: Int32Array, dt: number, rand: () => number,
): void {
  for (let k = 0; k < particles.length; k++) {
    const p = particles[k]!;
    p.age += dt;
    p.progress += particleSpeed(field, p.cell) * dt;
    while (p.progress >= 1) {
      const next = field.receiver[p.cell]!;
      if (next < 0) { particles[k] = spawn(cells, rand); break; }
      p.cell = next;
      p.progress -= 1;
      if (field.receiver[p.cell]! < 0) { particles[k] = spawn(cells, rand); break; }
    }
    if (particles[k]!.age > MAX_LIFE_S) particles[k] = spawn(cells, rand);
  }
}

/** Particle count for a field: about one per eight spawnable cells, capped. */
export function particleCount(spawnable: number): number {
  return Math.min(MAX_PARTICLES, Math.ceil(spawnable / 8));
}

export class FlowParticles {
  readonly canvas: HTMLCanvasElement;
  private _field: FlowParticleField | null = null;
  private _cells: Int32Array = new Int32Array(0);
  private _particles: Particle[] = [];
  private _rand = seededRandom(1);
  private _raf = 0;
  private _last = 0;
  private _paused = false;
  private _onScreen = true;
  private _count = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'olv-lab-particles';
    this.canvas.setAttribute('aria-hidden', 'true');
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver((entries) => {
        this._onScreen = entries.some((e) => e.isIntersecting);
        this._sync();
      }).observe(this.canvas);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => this._sync());
    }
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => this._sync());
    }
  }

  get running(): boolean {
    return this._raf !== 0;
  }

  get paused(): boolean {
    return this._paused;
  }

  /** Load a routed field; starts motion when allowed. */
  load(field: FlowParticleField): void {
    this._field = field;
    this._cells = spawnCells(field);
    this._rand = seededRandom(field.cols * 73856093 ^ field.rows * 19349663);
    this._count = particleCount(this._cells.length);
    this._particles = [];
    for (let i = 0; i < this._count && this._cells.length > 0; i++) this._particles.push(spawn(this._cells, this._rand));
    this._sync();
  }

  setPaused(paused: boolean): void {
    this._paused = paused;
    this._sync();
  }

  /** True when motion is allowed right now. */
  private _allowed(): boolean {
    return !!this._field && this._cells.length > 0 && !this._paused && this._onScreen
      && !prefersReducedMotion()
      && !(typeof document !== 'undefined' && document.visibilityState === 'hidden')
      && typeof requestAnimationFrame === 'function';
  }

  private _sync(): void {
    if (this._allowed()) {
      if (!this._raf) {
        this._last = performance.now();
        this._raf = requestAnimationFrame((t) => this._frame(t));
      }
      return;
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._clear();
  }

  private _clear(): void {
    const ctx = typeof this.canvas.getContext === 'function' ? this.canvas.getContext('2d') : null;
    ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private _frame(now: number): void {
    this._raf = 0;
    if (!this.canvas.isConnected || !this._allowed()) { this._clear(); return; }
    const t0 = performance.now();
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    const field = this._field!;
    stepParticles(field, this._particles, this._cells, dt, this._rand);
    this._draw(field);
    if (performance.now() - t0 > FRAME_BUDGET_MS && this._particles.length > 16) {
      this._particles.length = Math.floor(this._particles.length / 2);
    }
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  private _draw(field: FlowParticleField): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 1 ? Math.min(3, devicePixelRatio) : 1;
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    const sx = w / field.cols, sy = h / field.rows;
    const r = Math.max(1, Math.min(sx, sy) * 0.14);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    for (const p of this._particles) {
      const a = p.cell, b = field.receiver[a]!;
      if (b < 0) continue;
      const ax = (a % field.cols) + 0.5, ay = Math.floor(a / field.cols) + 0.5;
      const bx = (b % field.cols) + 0.5, by = Math.floor(b / field.cols) + 0.5;
      // North-up: row 0 is the southern row, drawn at the bottom.
      const x = (ax + (bx - ax) * p.progress) * sx, y = h - (ay + (by - ay) * p.progress) * sy;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}
