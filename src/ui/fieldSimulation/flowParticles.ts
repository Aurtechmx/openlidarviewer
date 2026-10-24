/**
 * flowParticles.ts — moving marks along the drainage lines of a Flow Pulse
 * result grid, drawn on a transparent canvas over the grid.
 *
 * What the motion encodes: each particle sits on a channel cell and moves
 * towards that cell's D8 receiver, at a speed proportional to the cell's
 * log-scaled upstream count (the same `logScale` the grid lines and the 3D
 * overlay use). Speed is a display encoding of that count, never a water
 * velocity: nothing in Flow Pulse computes one. Particles spawn only on
 * channel cells, so motion follows the drawn drainage lines rather than
 * covering hillslopes. Without a rainfall estimate the channel cells are the
 * log-scaled count threshold (`FLOW_CHANNEL_THRESHOLD`) and brightness follows
 * the count; with one, the caller passes the cells whose estimated peak flow
 * reaches the display threshold and a strength on a log scale of that flow,
 * and stronger channels get brighter particles and more of them. Between cells a particle
 * follows a curve through the link midpoints, so turns are smooth. At the end
 * of a path (outlet, sink, flat) a particle respawns.
 *
 * Rules it keeps:
 * - It never hides data: particles are small, drawn on their own canvas, and
 *   their trails fade within a fraction of a second; the grid, path and marks
 *   stay beneath.
 * - Under prefers-reduced-motion it never starts, and it stops if the setting
 *   turns on while running. The grid alone is the static view.
 * - It runs only while the canvas is on screen and the page is visible, and
 *   halves its particle count when a frame's own work exceeds FRAME_BUDGET_MS.
 * - The caller offers a pause control (WCAG 2.2.2).
 * - It is deterministic for a given seed, so screenshots and tests repeat.
 */

import { channelStrength, isChannel, logScale, waterRampColor } from '../../render/flowOverlayGeometry';
import { prefersReducedMotion } from './labColormaps';

/** Cells per second at the top of the log scale. Speed is this times the scale value. */
export const MAX_SPEED_CELLS_PER_S = 4;
/** Most particles drawn at once. */
export const MAX_PARTICLES = 900;
/** Particles per channel cell, before the cap. */
export const PARTICLES_PER_CHANNEL_CELL = 0.5;
/** Work per frame above which the particle count is halved. */
export const FRAME_BUDGET_MS = 4;
/** Share of the previous frame's trail removed each frame (0 clears, 1 keeps forever). */
export const TRAIL_FADE = 0.16;
/** Colour buckets: each is one canvas path per frame, so draw cost stays flat in particle count. */
const DRAW_BUCKETS = 8;
const MAX_LIFE_S = 6;

export interface FlowParticleField {
  readonly cols: number;
  readonly rows: number;
  /** D8 receiver per cell, or -1 where flow stops or leaves. */
  readonly receiver: Int32Array;
  readonly upstreamCells: Uint32Array;
  readonly maxUpstream: number;
  /** 1 for each channel cell; absent, the log-scaled count threshold decides. */
  readonly channel?: Uint8Array | null;
  /** Display strength per channel cell in [0, 1]; absent, the log-scaled count. */
  readonly strength?: Float32Array | null;
}

/** Extra spawn weight per unit of strength: a full-strength channel draws four times the particles of a faint one. */
const SPAWN_WEIGHT_PER_STRENGTH = 3;

export interface Particle {
  cell: number;
  /** 0 at the cell centre, 1 at the receiver's centre. */
  progress: number;
  age: number;
  /** The cell this particle came from, or -1 / absent after a spawn. Smooths the turn. */
  prev?: number;
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

/** Log-scaled upstream count of a cell, 0 to 1. */
function cellT(field: FlowParticleField, cell: number): number {
  return logScale(field.upstreamCells[cell]!, field.maxUpstream);
}

/** Speed in cells per second for a cell: proportional to its log-scaled upstream count. */
export function particleSpeed(field: FlowParticleField, cell: number): number {
  return MAX_SPEED_CELLS_PER_S * cellT(field, cell);
}

/** True when a cell is drawn as a channel in this field. */
export function isChannelCell(field: FlowParticleField, i: number): boolean {
  return field.channel ? field.channel[i] === 1 : isChannel(cellT(field, i));
}

/** Channel strength of a cell in [0, 1], as the colour ramp reads it. */
export function cellStrength(field: FlowParticleField, i: number): number {
  return field.strength ? field.strength[i]! : channelStrength(cellT(field, i));
}

/**
 * Cells a particle may spawn on: routed, with a receiver, and drawn as a
 * channel. With a strength field each cell appears 1 + round(3 × strength)
 * times, so sampling the list uniformly favours the stronger channels.
 */
export function spawnCells(field: FlowParticleField): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < field.cols * field.rows; i++) {
    if (field.receiver[i]! < 0) continue;
    if (!isChannelCell(field, i)) continue;
    const copies = field.strength ? 1 + Math.round(SPAWN_WEIGHT_PER_STRENGTH * field.strength[i]!) : 1;
    for (let k = 0; k < copies; k++) out.push(i);
  }
  return Int32Array.from(out);
}

/** Distinct channel cells with a receiver: what the particle count scales with. */
export function channelCellCount(field: FlowParticleField): number {
  let n = 0;
  for (let i = 0; i < field.cols * field.rows; i++) if (field.receiver[i]! >= 0 && isChannelCell(field, i)) n++;
  return n;
}

function spawn(cells: Int32Array, rand: () => number): Particle {
  return { cell: cells[Math.floor(rand() * cells.length)]!, progress: rand(), age: 0, prev: -1 };
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
      p.prev = p.cell;
      p.cell = next;
      p.progress -= 1;
      if (field.receiver[p.cell]! < 0) { particles[k] = spawn(cells, rand); break; }
    }
    if (particles[k]!.age > MAX_LIFE_S) particles[k] = spawn(cells, rand);
  }
}

/** Particle count for a field: one per two channel cells, capped at MAX_PARTICLES. */
export function particleCount(spawnable: number): number {
  return Math.min(MAX_PARTICLES, Math.ceil(spawnable * PARTICLES_PER_CHANNEL_CELL));
}

const centreX = (field: FlowParticleField, i: number): number => (i % field.cols) + 0.5;
const centreY = (field: FlowParticleField, i: number): number => Math.floor(i / field.cols) + 0.5;

/** Quadratic Bezier from a to c with control b, at u in [0, 1]. */
function bezier(a: number, b: number, c: number, u: number): number {
  const v = 1 - u;
  return v * v * a + 2 * v * u * b + u * u * c;
}

/**
 * A particle's position in cell units (x east, y north, cell centres at
 * +0.5). The track runs through link midpoints with each cell centre as a
 * Bezier control point, so it is continuous across cells and turns smoothly;
 * a straight line is used where the previous or next link is unknown.
 * Null when the particle's cell has no receiver.
 */
export function particlePosition(field: FlowParticleField, p: Particle): [number, number] | null {
  const a = p.cell, b = field.receiver[a]!;
  if (b < 0) return null;
  const ax = centreX(field, a), ay = centreY(field, a);
  const bx = centreX(field, b), by = centreY(field, b);
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const prev = p.prev ?? -1;
  if (p.progress < 0.5 && prev >= 0) {
    const px = (centreX(field, prev) + ax) / 2, py = (centreY(field, prev) + ay) / 2;
    const u = p.progress + 0.5;
    return [bezier(px, ax, mx, u), bezier(py, ay, my, u)];
  }
  const c = field.receiver[b]!;
  if (p.progress >= 0.5 && c >= 0) {
    const nx = (bx + centreX(field, c)) / 2, ny = (by + centreY(field, c)) / 2;
    const u = p.progress - 0.5;
    return [bezier(mx, bx, nx, u), bezier(my, by, ny, u)];
  }
  return [ax + (bx - ax) * p.progress, ay + (by - ay) * p.progress];
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
  private _disposed = false;
  private readonly _observer: IntersectionObserver | null = null;
  private readonly _motionQuery: MediaQueryList | null = null;
  private readonly _onChange = (): void => this._sync();
  /** Per-bucket colours, built once. */
  private readonly _colors: string[] = Array.from({ length: DRAW_BUCKETS }, (_, b) => {
    const [r, g, bl] = waterRampColor(0.25 + (0.75 * (b + 0.5)) / DRAW_BUCKETS);
    return `rgb(${r} ${g} ${bl})`;
  });

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'olv-lab-particles';
    this.canvas.setAttribute('aria-hidden', 'true');
    if (typeof IntersectionObserver === 'function') {
      this._observer = new IntersectionObserver((entries) => {
        this._onScreen = entries.some((e) => e.isIntersecting);
        this._sync();
      });
      this._observer.observe(this.canvas);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this._onChange);
    }
    if (typeof matchMedia === 'function') {
      this._motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      this._motionQuery.addEventListener?.('change', this._onChange);
    }
  }

  /** Stop the loop and release the observer, both listeners and the field arrays. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._observer?.disconnect();
    if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', this._onChange);
    this._motionQuery?.removeEventListener?.('change', this._onChange);
    this._field = null;
    this._cells = new Int32Array(0);
    this._particles = [];
  }

  get running(): boolean {
    return this._raf !== 0;
  }

  get paused(): boolean {
    return this._paused;
  }

  /** Particles currently alive (after any frame-budget halving). */
  get count(): number {
    return this._particles.length;
  }

  /** Load a routed field; starts motion when allowed. */
  load(field: FlowParticleField): void {
    if (this._disposed) return;
    this._field = field;
    this._cells = spawnCells(field);
    this._rand = seededRandom(field.cols * 73856093 ^ field.rows * 19349663);
    this._count = particleCount(field.strength ? channelCellCount(field) : this._cells.length);
    this._particles = [];
    for (let i = 0; i < this._count && this._cells.length > 0; i++) this._particles.push(spawn(this._cells, this._rand));
    this._clear();
    this._sync();
  }

  /**
   * Swap in a new channel field over the same grid (a rainfall change) without
   * restarting the motion: particles still on a channel keep their place, the
   * rest respawn, and the count follows the new number of channel cells.
   */
  update(field: FlowParticleField): void {
    if (this._disposed) return;
    if (!this._field || this._field.cols !== field.cols || this._field.rows !== field.rows) { this.load(field); return; }
    this._field = field;
    this._cells = spawnCells(field);
    this._count = particleCount(field.strength ? channelCellCount(field) : this._cells.length);
    const kept = this._particles.filter((p) => field.receiver[p.cell]! >= 0 && isChannelCell(field, p.cell));
    if (kept.length > this._count) kept.length = this._count;
    while (kept.length < this._count && this._cells.length > 0) kept.push(spawn(this._cells, this._rand));
    this._particles = kept;
    this._sync();
  }

  setPaused(paused: boolean): void {
    this._paused = paused;
    this._sync();
  }

  /** True when motion is allowed right now. */
  private _allowed(): boolean {
    return !this._disposed && !!this._field && this._cells.length > 0 && !this._paused && this._onScreen
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
    // Resizing clears the canvas, so a new size starts without stale trails.
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    // Fade last frame's marks rather than clearing them: the remainder is the comet trail.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
    ctx.fillRect(0, 0, w, h);
    const sx = w / field.cols, sy = h / field.rows;
    const cell = Math.min(sx, sy);
    // Bucket by channel strength: one path per bucket for the glow, one for the core.
    const buckets: Array<Array<[number, number]>> = Array.from({ length: DRAW_BUCKETS }, () => []);
    for (const p of this._particles) {
      const pos = particlePosition(field, p);
      if (!pos) continue;
      const s = cellStrength(field, p.cell);
      // North-up: row 0 is the southern row, drawn at the bottom.
      buckets[Math.min(DRAW_BUCKETS - 1, Math.floor(s * DRAW_BUCKETS))]!.push([pos[0] * sx, h - pos[1] * sy]);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (let b = 0; b < DRAW_BUCKETS; b++) {
      const pts = buckets[b]!;
      if (pts.length === 0) continue;
      const strength = (b + 0.5) / DRAW_BUCKETS;
      const core = Math.max(0.8, cell * (0.08 + 0.12 * strength));
      ctx.fillStyle = this._colors[b]!;
      for (const [radius, alpha] of [[core * 2.6, 0.12], [core, 0.9]] as const) {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (const [x, y] of pts) {
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
