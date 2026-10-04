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
import { estimateMemoryBytes, memoryCeilingBytes, type PointAttributes } from '../io/loadPlan';
import { evaluateFullResClassExport } from '../export/fullResClassGuard';
import { compactPointCount } from '../terrain/datasetIntelligence';
import { isTouchFirstDevice } from '../ui/isMobileDevice';
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
  /** The Export panel will write the classification channel. */
  readonly includeClassification: boolean;
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

/** Whether, and how, a layer may export every point in its file. */
export function assessFullFile(f: FullFileLayerFacts | null, device: FullFileDevice): FullFileAvailability {
  if (!f || !f.hasSource || !f.reduced || f.truncated) return HIDDEN;
  if (f.declared === null || !(f.declared > f.resident)) return HIDDEN;
  const declared = f.declared;
  const estimateBytes = estimateMemoryBytes({
    pointCount: declared, attributes: f.attributes, fileBytes: f.fileBytes, format: f.format,
  });
  const ceilingBytes = memoryCeilingBytes(device.deviceMemoryGB, device.isMobile);
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
    readonly metadata?: { readonly truncation?: { readonly read: number; readonly declared: number } } | null;
  };
  readonly file: { readonly size: number } | null;
  readonly reduced: boolean;
  readonly hasClassEdits: boolean;
  readonly includeClassification: boolean;
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
    includeClassification: input.includeClassification,
  };
}
