/**
 * fullFileActions.ts — the "Export all N points" action for a scan the loader
 * reduced to a display sample.
 *
 * Every number comes from the layer it targets: its declared and resident
 * counts, its own format and attributes for the memory estimate, and the
 * device's memory for the ceiling. The action shows only for a layer the
 * loader actually reduced (stride or voxel) that still has its local source
 * file; a complete load, a truncated file and a streamed scan get nothing.
 *
 * The action does not decode anything itself. It opens the Export panel with
 * full resolution ticked, and the panel's existing confirm, class guard,
 * re-decode and progress run from there. The class-edit refusal is shown up
 * front, before any decode.
 */

import './fullFileActions.css';
import {
  E57_COLUMN_BYTES,
  E57_DECODE_CEILING_BYTES,
  estimateMemoryBytes,
  memoryCeilingBytes,
  planLoad,
  type PointAttributes,
} from '../io/loadPlan';
import { GPU_HARD_POINT_CEILING, deviceTier, type DeviceTier } from '../render/deviceProfile';
import { evaluateFullResClassExport } from '../export/fullResClassGuard';
import { compactPointCount } from '../terrain/datasetIntelligence';
import { isTouchFirstDevice } from '../ui/isMobileDevice';
import { openConfirm } from '../ui/Modal';
import type { PointCloud } from '../model/PointCloud';

type SourceFormat = PointCloud['sourceFormat'];

/** What one layer says about itself; built from the live cloud and its source file. */
export interface FullFileLayerFacts {
  readonly id: string;
  /** The local source file is still held, so it can be re-read. */
  readonly hasSource: boolean;
  /** The loader reduced the layer for display (stride or voxel). */
  readonly reduced: boolean;
  /** The file ended before its declared count. */
  readonly truncated: boolean;
  /** Points held for display. */
  readonly resident: number;
  /** The source's declared point count, or null when it declared none. */
  readonly declared: number | null;
  readonly fileBytes: number;
  readonly format: SourceFormat;
  readonly attributes: PointAttributes;
  /** The layer carries in-session classification edits. */
  readonly hasClassEdits: boolean;
  /**
   * Why the layer's classes differ from the file: manual edits to source
   * classes (`edited`), or classes derived or cleared in the app (`derived`).
   * A derived layer's epoch also moves without a hand edit, so `edited` is set
   * only for source classes. Absent when only `hasClassEdits` is known.
   */
  readonly classCauses?: { readonly edited: boolean; readonly derived: boolean };
  /** The Export panel will write the classification channel. */
  readonly includeClassification: boolean;
  /** Saved findings kept for the layer; a reload clears them. */
  readonly findings?: number;
  /** The shown compare difference was computed on the layer; a reload clears it. */
  readonly inCompare?: boolean;
  /** E57 only: the decode planner's full-file estimate, when the load recorded it. */
  readonly e57FullDecodeEstimateBytes?: number;
}

export interface FullFileDevice {
  readonly deviceMemoryGB: number | undefined;
  readonly isMobile: boolean;
}

export interface FullFileAvailability {
  /** Show the action at all. */
  readonly show: boolean;
  /** The action may proceed to the Export panel. */
  readonly allowed: boolean;
  /** Why it is refused, when it is. */
  readonly reason?: string;
  /** "Export all 15.6 M points". */
  readonly label: string;
  /** One honest sentence about what the export does and does not change. */
  readonly hint: string;
  readonly estimateBytes: number;
  readonly ceilingBytes: number;
  /** The browser did not report device memory, so the ceiling is a fallback. */
  readonly memoryEstimated: boolean;
}

const HIDDEN: FullFileAvailability = {
  show: false, allowed: false, label: '', hint: '', estimateBytes: 0, ceilingBytes: 0, memoryEstimated: false,
};

/** "0.6 GB". */
export function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** The action label for a layer: "Export all {N} points". */
export function fullFileLabel(declared: number): string {
  return `Export all ${compactPointCount(declared)} points`;
}

/**
 * Float64 columns the E57 decode materialises per record for these
 * attributes: xyz, then colour, intensity, classification and normals. Used
 * only when the load did not record the planner's own estimate.
 */
export function e57DecodeBytesFromAttributes(a: PointAttributes): number {
  let columns = 3;
  if (a.hasColor) columns += 3;
  if (a.hasIntensity) columns += 1;
  if (a.hasClassification) columns += 1;
  if (a.hasNormals) columns += 3;
  return columns * E57_COLUMN_BYTES;
}

/**
 * Bytes a re-decode of every point needs. For E57 this is the decode planner's
 * figure (`planE57Decode`), which counts the Float64 decode columns and the
 * structured-grid buffers; the generic estimate leaves both out.
 */
export function fullFileEstimateBytes(f: FullFileLayerFacts, declared: number): number {
  if (f.format === 'e57' && f.e57FullDecodeEstimateBytes !== undefined && f.e57FullDecodeEstimateBytes > 0) {
    return f.e57FullDecodeEstimateBytes;
  }
  return estimateMemoryBytes({
    pointCount: declared,
    attributes: f.attributes,
    fileBytes: f.fileBytes,
    format: f.format,
    ...(f.format === 'e57' ? { decodeBytesPerPoint: e57DecodeBytesFromAttributes(f.attributes) } : {}),
  });
}

/** The ceiling a full re-decode is judged against: E57 is also held to the whole-file decode cap. */
export function fullFileCeilingBytes(format: SourceFormat, device: FullFileDevice): number {
  const deviceCeiling = memoryCeilingBytes(device.deviceMemoryGB, device.isMobile);
  return format === 'e57' ? Math.min(deviceCeiling, E57_DECODE_CEILING_BYTES) : deviceCeiling;
}

/**
 * The refusal for a full-resolution re-decode that did not read every point,
 * or null when it did. Three shortfalls count: a strided decode, a file that
 * ended before its declared count (`metadata.truncation`), and a decode that
 * holds fewer points than it declares. Such a cloud is never written or
 * labelled as the full file.
 */
export function fullDecodeRefusal(cloud: {
  readonly pointCount: number;
  readonly loadStride?: number;
  readonly declaredPointCount?: number;
  readonly metadata?: { readonly truncation?: { readonly read: number; readonly declared: number } } | null;
}): string | null {
  const stride = cloud.loadStride ?? 1;
  if (stride > 1) {
    const of = cloud.declaredPointCount !== undefined ? ` of ${compactPointCount(cloud.declaredPointCount)}` : '';
    return `The full-resolution re-decode read ${compactPointCount(cloud.pointCount)}${of} points (one record in ${stride}) to fit memory, so nothing was exported.`;
  }
  const t = cloud.metadata?.truncation;
  if (t && t.read < t.declared) {
    return `The source file ends after ${compactPointCount(t.read)} of its ${compactPointCount(t.declared)} declared points, so nothing was exported as the full file.`;
  }
  const declared = cloud.declaredPointCount;
  if (declared !== undefined && cloud.pointCount < declared) {
    return `The full-resolution re-decode read ${compactPointCount(cloud.pointCount)} of ${compactPointCount(declared)} declared points, so nothing was exported as the full file.`;
  }
  return null;
}

/** Whether, and how, a layer may export every point in its file. */
export function assessFullFile(f: FullFileLayerFacts | null, device: FullFileDevice): FullFileAvailability {
  if (!f || !f.hasSource || !f.reduced || f.truncated) return HIDDEN;
  if (f.declared === null || !(f.declared > f.resident)) return HIDDEN;
  const declared = f.declared;
  const estimateBytes = fullFileEstimateBytes(f, declared);
  const ceilingBytes = fullFileCeilingBytes(f.format, device);
  const memoryEstimated = device.deviceMemoryGB === undefined;
  const base = {
    show: true,
    label: fullFileLabel(declared),
    hint: `Exports every point in the file. Analyses still use the ${compactPointCount(f.resident)} display sample.`,
    estimateBytes, ceilingBytes, memoryEstimated,
  };
  if (estimateBytes > ceilingBytes) {
    const allows = memoryEstimated ? `about ${formatGb(ceilingBytes)} (estimated)` : `about ${formatGb(ceilingBytes)}`;
    return { ...base, allowed: false, reason: `Exporting every point needs about ${formatGb(estimateBytes)}; this device allows ${allows}.` };
  }
  const gate = evaluateFullResClassExport({ fullRes: true, includeClassification: f.includeClassification, hasClassEdits: f.hasClassEdits });
  if (!gate.allowed) return { ...base, allowed: false, reason: gate.reason };
  return { ...base, allowed: true };
}

// ─── Point basis ───────────────────────────────────────────────────────────

export { pointBasisLine } from '../export/exportSummary';

/** Tooltip for a REVIEW badge on a layer whose figures came from its sample. */
export function sampleReviewTip(resident: number, declared: number): string {
  return `Computed on the ${compactPointCount(resident)} display sample of ${compactPointCount(declared)} points. ${fullFileLabel(declared)} from Export writes every point; analyses still read the sample.`;
}

// ─── Host binding ──────────────────────────────────────────────────────────

/** What the shell wires in: per-layer facts and a way to open the Export panel. */
export interface FullFileHost {
  facts(id: string): FullFileLayerFacts | null;
  activeId(): string | null;
  /** Make the layer active, open Export with full resolution ticked, and show `refusal` when set. */
  openExport(id: string, refusal?: string): void;
  /** Open the layer's source file again at `budget` points, replacing the layer. */
  reload?(id: string, budget: number): Promise<void>;
  /** Say why an action cannot run. */
  notify?(message: string): void;
}

let host: FullFileHost | null = null;

export function bindFullFile(h: FullFileHost | null): void {
  host = h;
}

function deviceMemory(): number | undefined {
  const m = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof m === 'number' && m > 0 ? m : undefined;
}

export function currentDevice(): FullFileDevice {
  return { deviceMemoryGB: deviceMemory(), isMobile: isTouchFirstDevice() };
}

/** Availability for a layer (the active one when `id` is omitted). */
export function fullFileAvailability(id?: string, device: FullFileDevice = currentDevice()): FullFileAvailability {
  const target = id ?? host?.activeId() ?? null;
  if (!host || !target) return HIDDEN;
  return assessFullFile(host.facts(target), device);
}

/** Tooltip for the REVIEW badge on a layer the loader reduced, or '' when it is not reduced. */
export function reviewSampleTip(id?: string): string {
  const target = id ?? host?.activeId() ?? null;
  const f = host && target ? host.facts(target) : null;
  if (!f || !f.reduced || f.truncated || f.declared === null || !(f.declared > f.resident)) return '';
  return sampleReviewTip(f.resident, f.declared);
}

/**
 * Run the action. Opens the Export panel on that layer with full resolution
 * ticked; a refusal is shown there before any decode starts.
 */
export function useFullFile(id?: string, device: FullFileDevice = currentDevice()): FullFileAvailability {
  const target = id ?? host?.activeId() ?? null;
  const a = fullFileAvailability(target ?? undefined, device);
  if (!host || !target || !a.show) return a;
  host.openExport(target, a.allowed ? undefined : a.reason);
  return a;
}

/** The link the entry points append, or null when the layer offers none. */
export function fullFileLink(id?: string): HTMLButtonElement | null {
  const a = fullFileAvailability(id);
  if (!a.show) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'olv-fullfile-link';
  b.dataset.fullFile = 'export';
  if (id) b.dataset.layer = id;
  b.textContent = a.label;
  b.title = a.allowed ? a.hint : `${a.hint} ${a.reason ?? ''}`.trim();
  b.addEventListener('click', (e) => { e.stopPropagation(); useFullFile(id); });
  return b;
}

/** Facts for a held cloud. Pure: the caller supplies the file and the flags. */
export function layerFacts(input: {
  readonly id: string;
  readonly cloud: {
    readonly pointCount: number;
    readonly declaredPointCount?: number;
    readonly sourceDeclaredPointCount?: number;
    readonly sourceFormat: SourceFormat;
    readonly colors?: unknown; readonly intensity?: unknown; readonly classification?: unknown;
    readonly normals?: unknown; readonly gpsTime?: unknown; readonly returnNumber?: unknown;
    readonly metadata?: {
      readonly truncation?: { readonly read: number; readonly declared: number };
      readonly e57FullDecodeEstimateBytes?: number;
    } | null;
  };
  readonly file: { readonly size: number } | null;
  readonly reduced: boolean;
  readonly hasClassEdits: boolean;
  readonly classCauses?: { readonly edited: boolean; readonly derived: boolean };
  readonly includeClassification: boolean;
  readonly findings?: number;
  readonly inCompare?: boolean;
}): FullFileLayerFacts {
  const c = input.cloud;
  const declared = c.sourceDeclaredPointCount ?? c.declaredPointCount;
  const t = c.metadata?.truncation;
  return {
    id: input.id,
    hasSource: input.file !== null,
    reduced: input.reduced,
    truncated: !!t && t.read < t.declared,
    resident: c.pointCount,
    declared: declared !== undefined && Number.isFinite(declared) ? declared : null,
    fileBytes: input.file?.size ?? 0,
    format: c.sourceFormat,
    attributes: {
      hasColor: !!c.colors, hasIntensity: !!c.intensity, hasClassification: !!c.classification,
      hasNormals: !!c.normals, hasLasExtras: !!(c.gpsTime || c.returnNumber),
    },
    hasClassEdits: input.hasClassEdits,
    ...(input.classCauses ? { classCauses: input.classCauses } : {}),
    includeClassification: input.includeClassification,
    findings: input.findings ?? 0,
    inCompare: input.inCompare ?? false,
    ...(c.metadata?.e57FullDecodeEstimateBytes !== undefined
      ? { e57FullDecodeEstimateBytes: c.metadata.e57FullDecodeEstimateBytes }
      : {}),
  };
}

// ─── Reload at higher density ──────────────────────────────────────────────

export interface ReloadDevice extends FullFileDevice {
  readonly tier: DeviceTier;
}

export interface ReloadPlan {
  readonly show: boolean;
  readonly allowed: boolean;
  readonly reason?: string;
  /** Points the reload would hold. */
  readonly target: number;
  /** The reload would hold every declared point. */
  readonly allPoints: boolean;
  readonly label: string;
  /** The confirm sentence, with the numbers. */
  readonly confirm: string;
  readonly estimateBytes: number;
}

const NO_RELOAD: ReloadPlan = { show: false, allowed: false, target: 0, allPoints: false, label: '', confirm: '', estimateBytes: 0 };

/**
 * The reload target for a reduced layer: min(GPU ceiling, memory fit, declared
 * count), from the same planLoad the first open used, with the budget raised.
 */
export function assessReload(f: FullFileLayerFacts | null, device: ReloadDevice): ReloadPlan {
  if (!f || !f.hasSource || !f.reduced || f.truncated) return NO_RELOAD;
  if (f.declared === null || !(f.declared > f.resident)) return NO_RELOAD;
  const declared = f.declared;
  const plan = planLoad({
    sourceCount: declared,
    budget: Math.min(GPU_HARD_POINT_CEILING, declared),
    fileBytes: f.fileBytes,
    format: f.format,
    attributes: f.attributes,
    isMobile: device.isMobile,
    deviceMemoryGB: device.deviceMemoryGB,
  });
  const target = Math.min(plan.targetCount, GPU_HARD_POINT_CEILING, declared);
  const allPoints = target >= declared;
  const label = allPoints ? `Reload all ${compactPointCount(declared)} points` : `Reload at ${compactPointCount(target)} points`;
  const gb = formatGb(plan.memoryEstimateBytes);
  const shows = allPoints
    ? `Shows all ${compactPointCount(declared)} points. Needs about ${gb} (estimated). May run slower.`
    : `Shows ${compactPointCount(target)} of ${compactPointCount(declared)} points (still a sample). Needs about ${gb} (estimated). May run slower.`;
  const confirm = [shows, reloadClears(f)].filter((t) => t !== '').join(' ');
  const base = { show: true, target, allPoints, label, confirm, estimateBytes: plan.memoryEstimateBytes };
  const held = `${compactPointCount(f.resident)} of ${compactPointCount(declared)} points are loaded`;
  const ceiling = formatGb(memoryCeilingBytes(device.deviceMemoryGB, device.isMobile));
  if (f.hasClassEdits) {
    return { ...base, allowed: false, reason: `${held}. ${classDiffersReason(f)}` };
  }
  if (device.isMobile) return { ...base, allowed: false, reason: `${held}. A denser reload is not offered on a phone or tablet.` };
  if (device.tier === 'low') return { ...base, allowed: false, reason: `${held}. This device is in the low performance tier, so a denser reload is not offered.` };
  if (plan.buildThenStream) {
    // planLoad routes a LAS or LAZ this large to the out-of-core tile build: it
    // would open as a streamed scan, not as the denser loaded layer a reload makes.
    return { ...base, allowed: false, reason: `${held}. Loading more needs about ${gb}, over the ${ceiling} this device allows for a loaded layer. At that size the file opens as a streamed scan, and a reload only replaces a loaded layer.` };
  }
  if (plan.mayExceedCeiling) {
    return { ...base, allowed: false, reason: `${held}. A denser reload needs about ${gb}, more than the ${ceiling} this device allows.` };
  }
  if (target <= f.resident) return { ...base, allowed: false, reason: `${held}. A reload would not add points on this device.` };
  return { ...base, allowed: true };
}

/**
 * Why a reload is unavailable for a layer whose classes differ from its file.
 * An export that includes classification keeps the classes; a session file
 * does not save them. Neither makes them match the file, so the reload stays
 * unavailable afterwards too.
 */
function classDiffersReason(f: FullFileLayerFacts): string {
  const c = f.classCauses ?? { edited: true, derived: false };
  const cause = c.derived ? 'its classes were derived or cleared in the app, not read from the file' : 'it has manual class edits';
  return `A reload reads the original file, so it is unavailable while this layer's classes differ from the file: ${cause}. Exporting with classification keeps them; a saved session does not.`;
}

/** What a reload clears for the layer, as a sentence, or '' when nothing is held. */
function reloadClears(f: FullFileLayerFacts): string {
  const n = f.findings ?? 0;
  const parts = [
    ...(n > 0 ? [`its ${n} saved ${n === 1 ? 'finding' : 'findings'}`] : []),
    ...(f.inCompare ? ['the compare difference computed on it'] : []),
  ];
  return parts.length ? `Reloading clears ${parts.join(' and ')}.` : '';
}

export function currentReloadDevice(): ReloadDevice {
  const d = currentDevice();
  const cores = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency;
  return { ...d, tier: deviceTier({ deviceMemoryGB: d.deviceMemoryGB, hardwareConcurrency: cores, isMobile: d.isMobile }) };
}

export function reloadAvailability(id?: string, device: ReloadDevice = currentReloadDevice()): ReloadPlan {
  const target = id ?? host?.activeId() ?? null;
  if (!host?.reload || !target) return NO_RELOAD;
  return assessReload(host.facts(target), device);
}

/** The budget a reload hands to the open of one specific file. */
let pendingReload: { readonly file: File; readonly budget: number } | null = null;

/** Hand `budget` to the next open of `file`, and to no other open. */
export function armReloadBudget(file: File, budget: number): void {
  pendingReload = { file, budget };
}

/** Withdraw an armed budget that no open took. */
export function disarmReloadBudget(): void {
  pendingReload = null;
}

/**
 * The raised budget for opening `file`, or null. The open path calls this once
 * per open; a budget armed for another file is left alone.
 */
export function takeReloadBudget(file: File): number | null {
  if (pendingReload === null || pendingReload.file !== file) return null;
  const b = pendingReload.budget;
  pendingReload = null;
  return b;
}

/** What a reload compares before it replaces a layer: the cloud, the file and the class state. */
export interface ReloadStamp {
  readonly cloud: object | null;
  readonly file: File | null;
  readonly epoch: number;
  readonly provenance: string | null;
}

/** Why a layer no longer matches its stamp, in plain words; empty when it matches. */
export function reloadStampChanges(before: ReloadStamp, after: ReloadStamp): string[] {
  const out: string[] = [];
  if (before.cloud !== after.cloud) out.push('the layer was replaced or closed');
  if (before.file !== after.file) out.push('its source file changed');
  if (before.provenance !== after.provenance || before.epoch !== after.epoch) out.push('its classes changed');
  return out;
}

/**
 * Run the reload: refuse with the reason, or confirm with the numbers and then
 * reopen the layer's file at the target budget. `ask` is the confirm dialog.
 */
export async function useReload(
  id?: string,
  device: ReloadDevice = currentReloadDevice(),
  ask: (message: string, confirmLabel: string) => Promise<boolean> = defaultAsk,
): Promise<ReloadPlan> {
  const target = id ?? host?.activeId() ?? null;
  const plan = reloadAvailability(target ?? undefined, device);
  if (!host?.reload || !target || !plan.show) return plan;
  if (!plan.allowed) { host.notify?.(plan.reason ?? ''); return plan; }
  if (!(await ask(plan.confirm, 'Reload'))) return plan;
  // The layer can change while the dialog is open, so the decision is made
  // again on its current facts before anything starts.
  const now = reloadAvailability(target, device);
  if (!now.show || !now.allowed) {
    host.notify?.(now.allowed || !now.reason ? 'The layer changed while you confirmed, so the reload did not start.' : now.reason);
    return now;
  }
  await host.reload(target, now.target);
  return now;
}

function defaultAsk(message: string, confirmLabel: string): Promise<boolean> {
  return openConfirm({ title: 'Reload at higher density', message, confirmLabel });
}

/** The reload link beside a sample notice, or null when the layer offers none. */
export function reloadLink(id?: string): HTMLButtonElement | null {
  const p = reloadAvailability(id);
  if (!p.show) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'olv-fullfile-link';
  b.dataset.fullFile = 'reload';
  if (id) b.dataset.layer = id;
  b.textContent = p.label;
  // A refused reload keeps its link: the click explains why, with the figures.
  b.title = p.allowed ? p.confirm : p.reason ?? '';
  if (!p.allowed) b.setAttribute('aria-disabled', 'true');
  b.addEventListener('click', (e) => { e.stopPropagation(); void useReload(id); });
  return b;
}

/** Both sample actions for a layer, in reading order. */
export function sampleActionLinks(id?: string): HTMLButtonElement[] {
  return [fullFileLink(id), reloadLink(id)].filter((b): b is HTMLButtonElement => b !== null);
}
