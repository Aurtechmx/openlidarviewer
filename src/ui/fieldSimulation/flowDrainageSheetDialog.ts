/**
 * flowDrainageSheetDialog.ts: the Flow Pulse Lab's "Drainage sheet (PDF)"
 * dialog and export. The user ticks the sections to include; the PDF builder
 * (`export/flowDrainageSheetPdf.ts`) rides its own lazy chunk and is handed
 * in by the caller, so this module never imports pdf-lib.
 */

import { el } from '../dom';
import type { FlowPulseResult, FlowRefusal } from '../../simulation/flowPulse/flowPulseRunner';
import type { FlowCatchmentTrace, FlowClickRefusal, FlowPathTrace } from '../../simulation/flowPulse/flowClickGuard';
import type { RainfallSetting } from '../../simulation/flowPulse/rationalDischarge';
import type {
  DrainageLinearUnit, DrainageSheetSection, FlowDrainageSheetOptions, buildFlowDrainageSheetPdf,
} from '../../export/flowDrainageSheetPdf';
import type { FlowPulseGeoref } from './flowPulseLab';
import { UNIT_TO_METRES } from '../../export/flowDrainageSheetUnits';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';

/** Metres per vertical unit for the study: metres, or feet when the horizontal frame names which foot. */
export function verticalToMetresOf(label: 'm' | 'ft' | 'units', linear: DrainageLinearUnit): number | null {
  if (label === 'm') return 1;
  if (label === 'ft' && (linear === 'foot' || linear === 'us-survey-foot')) return UNIT_TO_METRES[linear];
  return null;
}

const SECTIONS: readonly { readonly id: DrainageSheetSection; readonly label: string }[] = [
  { id: 'map', label: 'Drainage map' },
  { id: 'summary', label: 'Hydrology summary' },
  { id: 'catchment', label: 'Catchment study (shape, profile, data quality)' },
  { id: 'traced', label: 'Traced path and catchment' },
  { id: 'depressions', label: 'Depression table' },
];

const TRACED_UNAVAILABLE = 'Trace a path or set a catchment outlet on the map first.';

export interface DrainageDialogOptions {
  readonly hasPath: boolean;
  readonly hasCatchment: boolean;
  /** Why the catchment study is unavailable for this run, or null. */
  readonly catchmentReason?: string | null;
  readonly onExport: (sections: Record<DrainageSheetSection, boolean>) => void;
  readonly onCancel: () => void;
}

/** The section picker: every available section ticked; the traced one disabled, with its reason, when nothing is traced. */
export function drainageSheetDialog(opts: DrainageDialogOptions): HTMLElement {
  const tracedOk = opts.hasPath || opts.hasCatchment;
  const boxes = new Map<DrainageSheetSection, HTMLInputElement>();
  const exportBtn = el('button', { className: 'olv-flow-drainage-export', type: 'button', text: 'Export PDF', tip: 'Build the drainage sheet with the ticked sections and download it.' }) as HTMLButtonElement;
  const sync = (): void => { exportBtn.disabled = ![...boxes.values()].some((b) => b.checked && !b.disabled); };
  const items = SECTIONS.map(({ id, label }) => {
    const box = el('input', { className: 'olv-flow-drainage-opt', tip: `Include the ${label.toLowerCase()} in the sheet.` }) as HTMLInputElement;
    box.type = 'checkbox';
    box.dataset.section = id;
    const reason = id === 'traced' && !tracedOk ? TRACED_UNAVAILABLE : id === 'catchment' ? opts.catchmentReason ?? null : null;
    const disabled = reason != null;
    box.checked = !disabled;
    box.disabled = disabled;
    box.addEventListener('change', sync);
    boxes.set(id, box);
    return el('label', { className: 'olv-flow-drainage-item' }, [
      box, ` ${label}`,
      ...(reason ? [el('span', { className: 'olv-flow-drainage-reason', text: ` (${reason})` })] : []),
    ]);
  });
  const cancel = el('button', { className: 'olv-flow-drainage-cancel', type: 'button', text: 'Cancel', tip: 'Close without exporting.' });
  cancel.addEventListener('click', () => opts.onCancel());
  exportBtn.addEventListener('click', () => {
    const picked = {} as Record<DrainageSheetSection, boolean>;
    for (const [id, b] of boxes) picked[id] = b.checked && !b.disabled;
    opts.onExport(picked);
  });
  const root = el('div', { className: 'olv-flow-drainage-dialog' }, [
    el('p', { className: 'olv-flow-drainage-title', text: 'Drainage sheet: sections to include' }),
    ...items,
    el('div', { className: 'olv-lab-actions' }, [exportBtn, cancel]),
  ]);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Drainage sheet sections');
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') opts.onCancel(); });
  sync();
  return root;
}

/** The Lab state a drainage sheet is built from. */
export interface DrainageSheetRequest {
  readonly outcome: FlowPulseResult | FlowRefusal;
  readonly stale: boolean;
  readonly path: FlowPathTrace | FlowClickRefusal | null;
  readonly catchment: FlowCatchmentTrace | FlowClickRefusal | null;
  readonly basename: string;
  readonly georef: FlowPulseGeoref | null;
  readonly rainfall: RainfallSetting | null;
  readonly snappedFrom: number | null;
  readonly linearUnit: DrainageLinearUnit;
  readonly dtm?: DtmGrid | null;
  readonly verticalToMetres?: number | null;
  readonly sections: Record<DrainageSheetSection, boolean>;
}

/** The builder's options for a request, or the reason no sheet is built. Pure. */
export function drainageSheetOptions(req: DrainageSheetRequest):
  { ok: true; result: FlowPulseResult; options: FlowDrainageSheetOptions } | { ok: false; reason: string } {
  if (!req.outcome.ok) return { ok: false, reason: 'Flow Pulse has not produced a run to export.' };
  if (req.stale) return { ok: false, reason: 'the result is stale; rerun Flow Pulse before exporting.' };
  const g = req.georef;
  const cols = req.outcome.grid.cols;
  return {
    ok: true,
    result: req.outcome,
    options: {
      basename: req.basename,
      sections: req.sections,
      path: req.path && req.path.ok ? { cells: req.path.path } : null,
      catchment: req.catchment && req.catchment.ok
        ? { mask: req.catchment.mask, outletCell: req.catchment.cell.row * cols + req.catchment.cell.col, snappedFrom: req.snappedFrom }
        : null,
      worldOrigin: g?.worldOrigin ?? null,
      crsName: g?.crsName ?? null,
      verticalUnitLabel: g?.verticalUnitLabel ?? 'units',
      elevationOrigin: g?.elevationOrigin ?? null,
      terrainCaveat: g?.terrainCaveat ?? null,
      gridFrame: g?.gridFrame ?? null,
      verticalResolved: (g?.verticalUnitLabel ?? 'units') !== 'units',
      sourceInterpretation: g?.sourceInterpretation ?? null,
      digests: g?.digests ?? null,
      rainfall: req.rainfall,
      linearUnit: req.linearUnit,
      dtm: req.dtm ?? null,
      verticalToMetres: req.verticalToMetres ?? null,
    },
  };
}

/** Build the sheet and hand it to `download`; returns the announcement. */
export async function exportDrainageSheet(
  req: DrainageSheetRequest,
  build: typeof buildFlowDrainageSheetPdf,
  download: (filename: string, bytes: Uint8Array, mime: string) => void,
): Promise<string> {
  const o = drainageSheetOptions(req);
  if (!o.ok) return `Export refused: ${o.reason}`;
  const bytes = await build(o.result, o.options);
  download(`${req.basename}-drainage.pdf`, bytes, 'application/pdf');
  return 'Drainage sheet downloaded.';
}
