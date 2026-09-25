/**
 * copyDiagnostics.ts
 *
 * Builds the report behind the Help action "Copy diagnostics" and puts it on
 * the clipboard. Lazily loaded (see `loadCopyDiagnostics` in lazyChunks.ts).
 *
 * The report says what ran and how, never what was opened: build identity,
 * browser brand and major version, platform class, render backend, device tier,
 * pixel ratio, the source format, the streaming state, resident counts and the
 * error ledger, and a runtime section (generic form factor plus the
 * standards-only capability probe). File names, URLs, coordinates and annotations are left out, and
 * every free-text field passes through `ledgerToken`, which keeps only short
 * plain tokens.
 */
import { BUILD_IDENTITY, type BuildIdentity } from '../../build/buildIdentity';
import { deviceTier, type DeviceTier } from '../../render/deviceProfile';
import { isMobileDevice } from '../../ui/isMobileDevice';
import { probeCapabilities, type CapabilityReport, type ProbeGl } from '../../platform/capabilityProbe';
import { runtimeFormFactor, type RuntimeFormFactor } from '../../platform/runtimeFormFactor';
import { errorLedgerSnapshot, ledgerToken, type ErrorLedgerEntry } from './errorLedger';
import { recoveryStatus } from '../recovery/recoveryStatus';

/** The Viewer surface the report reads. */
export interface DiagnosticsViewer {
  activeBackend(): string;
  readonly streamingCloud: {
    readonly kind: string;
    readonly residentPointCount: number;
    readonly octree: { nodes(): ReadonlyArray<{ readonly state: string }> };
  } | null;
  residentPointTotal(): number;
  clouds(): string[];
  getCloud(id: string): { readonly sourceFormat?: string | null } | undefined;
}

/** The environment facts the report reads, injectable for tests. */
export interface DiagnosticsEnvironment {
  readonly userAgent: string;
  readonly brands?: ReadonlyArray<{ readonly brand: string; readonly version: string }>;
  readonly isMobile: boolean;
  readonly deviceMemoryGB?: number;
  readonly hardwareConcurrency?: number;
  readonly devicePixelRatio: number;
  /** Generic form factor and capability probe; absent when not probed. */
  readonly runtime?: DiagnosticsRuntime;
}

export interface DiagnosticsRuntime {
  readonly formFactor: RuntimeFormFactor;
  readonly capabilities: CapabilityReport;
}

export interface DiagnosticsReport {
  readonly schema: 'olv-diagnostics/1';
  readonly build: Pick<BuildIdentity, 'version' | 'commit' | 'dirty' | 'channel' | 'builtAt'>;
  readonly browser: { readonly brand: string; readonly majorVersion: number | null };
  readonly platform: { readonly class: 'mobile' | 'desktop'; readonly os: string };
  readonly render: { readonly backend: string | null; readonly deviceTier: DeviceTier; readonly devicePixelRatio: number };
  readonly source: { readonly formats: string[]; readonly streaming: string | null };
  readonly resident: { readonly nodes: number | null; readonly points: number | null };
  readonly errors: ErrorLedgerEntry[];
  readonly runtime: DiagnosticsRuntime | null;
  /** Session recovery journal state, e.g. `on:indexeddb` or `off:storage-unavailable`. */
  readonly recovery: string;
}

const BROWSERS: ReadonlyArray<[string, RegExp]> = [
  ['Edge', /Edg\/(\d+)/],
  ['Firefox', /Firefox\/(\d+)/],
  ['Chrome', /Chrom(?:e|ium)\/(\d+)/],
  ['Safari', /Version\/(\d+).*Safari/],
];

function browserOf(env: DiagnosticsEnvironment): DiagnosticsReport['browser'] {
  const named = env.brands?.find((b) => !/not.?a.?brand/i.test(b.brand) && b.brand !== 'Chromium')
    ?? env.brands?.find((b) => !/not.?a.?brand/i.test(b.brand));
  if (named) {
    const major = Number.parseInt(named.version, 10);
    return { brand: ledgerToken(named.brand.replace(/\s+/g, '-')), majorVersion: Number.isFinite(major) ? major : null };
  }
  for (const [brand, re] of BROWSERS) {
    const m = re.exec(env.userAgent);
    if (m) return { brand, majorVersion: Number.parseInt(m[1], 10) };
  }
  return { brand: 'other', majorVersion: null };
}

function osOf(userAgent: string): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'macOS';
  if (/CrOS/.test(userAgent)) return 'ChromeOS';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'other';
}

const matchOr = (value: string, re: RegExp): string => (re.test(value) ? value : 'other');

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function buildDiagnosticsReport(
  viewer: DiagnosticsViewer | null,
  env: DiagnosticsEnvironment,
  ledger: ErrorLedgerEntry[] = errorLedgerSnapshot(),
  build: BuildIdentity = BUILD_IDENTITY,
): DiagnosticsReport {
  const streaming = viewer ? safely(() => viewer.streamingCloud, null) : null;
  const formats = viewer
    ? safely(() => [...new Set(viewer.clouds().map((id) => ledgerToken(viewer.getCloud(id)?.sourceFormat ?? 'unknown')))], [])
    : [];
  const nodes = streaming ? safely(() => streaming.octree.nodes().filter((n) => n.state === 'resident').length, null) : null;
  return {
    schema: 'olv-diagnostics/1',
    build: {
      version: matchOr(build.version, /^\d+\.\d+\.\d+[A-Za-z0-9.+-]{0,24}$/),
      commit: matchOr(build.commit, /^[0-9a-f]{4,40}$|^[A-Za-z][A-Za-z0-9-]{0,39}$/),
      dirty: build.dirty,
      channel: ledgerToken(build.channel),
      builtAt: matchOr(build.builtAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    },
    browser: browserOf(env),
    platform: { class: env.isMobile ? 'mobile' : 'desktop', os: osOf(env.userAgent) },
    render: {
      backend: viewer ? ledgerToken(safely(() => viewer.activeBackend(), 'other')) : null,
      deviceTier: deviceTier({ deviceMemoryGB: env.deviceMemoryGB, hardwareConcurrency: env.hardwareConcurrency, isMobile: env.isMobile }),
      devicePixelRatio: Math.round(env.devicePixelRatio * 100) / 100,
    },
    source: { formats, streaming: streaming ? ledgerToken(streaming.kind) : null },
    resident: {
      nodes,
      points: viewer ? safely(() => Math.round(viewer.residentPointTotal()), null) : null,
    },
    errors: ledger.map((e) => ({
      t: Math.round(e.t),
      subsystem: ledgerToken(e.subsystem),
      code: ledgerToken(e.code),
      recoverable: e.recoverable === true,
      action: ledgerToken(e.action),
    })),
    runtime: env.runtime ?? null,
    recovery: recoveryStatus().split(':').map((t) => ledgerToken(t)).join(':'),
  };
}

/**
 * The renderer's own WebGL 2 context, only when the viewer runs on WebGL 2.
 * `getContext('webgl2')` on a canvas that already holds a webgl2 context
 * returns that same context, so nothing new is created. On WebGPU, or with no
 * viewer yet, it returns null and the probe falls back to a throwaway context
 * (asking the stage canvas before the viewer exists would claim it).
 */
function rendererGl(viewer: DiagnosticsViewer | null): ProbeGl | null {
  if (!viewer || safely(() => viewer.activeBackend(), '') !== 'webgl2') return null;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.olv-canvas');
  return safely(() => (canvas?.getContext('webgl2') as ProbeGl | null) ?? null, null);
}

/** Probe the runtime section. Never throws. */
export function browserRuntime(viewer: DiagnosticsViewer | null): DiagnosticsRuntime | undefined {
  return safely(() => {
    const backend = viewer ? safely(() => viewer.activeBackend(), '') : '';
    return {
      formFactor: runtimeFormFactor(),
      capabilities: probeCapabilities({
        existingGl: rendererGl(viewer),
        backend: backend === 'webgpu' || backend === 'webgl2' ? backend : null,
      }),
    };
  }, undefined);
}

/** Read the environment from the running browser. */
export function browserEnvironment(viewer: DiagnosticsViewer | null = null): DiagnosticsEnvironment {
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }> };
    deviceMemory?: number;
  };
  return {
    userAgent: nav.userAgent,
    brands: nav.userAgentData?.brands,
    isMobile: isMobileDevice(),
    deviceMemoryGB: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio || 1,
    runtime: browserRuntime(viewer),
  };
}

export const DIAGNOSTICS_COPIED = 'Diagnostics copied. The report holds no file names, links or coordinates.';
export const DIAGNOSTICS_COPY_FAILED =
  'Could not copy diagnostics: the browser refused clipboard access. Nothing was changed. Allow clipboard access and try again.';

/** Copy the report to the clipboard and say whether it worked. */
export async function copyDiagnostics(
  getViewer: () => DiagnosticsViewer | null | undefined,
  notify: (message: string) => void,
  writeText: (text: string) => Promise<void> = (text) => navigator.clipboard.writeText(text),
): Promise<void> {
  const viewer = safely(() => getViewer() ?? null, null);
  const json = JSON.stringify(buildDiagnosticsReport(viewer, browserEnvironment(viewer)), null, 2);
  try {
    await writeText(json);
    notify(DIAGNOSTICS_COPIED);
  } catch {
    notify(DIAGNOSTICS_COPY_FAILED);
  }
}
