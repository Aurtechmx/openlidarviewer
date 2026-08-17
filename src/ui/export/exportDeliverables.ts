/**
 * exportDeliverables.ts
 *
 * The three deliverable sections of the Output panel: point-cloud file formats,
 * the Visual Export Studio (PNG image export), and the PDF report. These moved
 * out of the Inspector so every export lives in one Output Center; the UX is
 * unchanged (the same collapsible sections, the same buttons, the same gating),
 * only the mount point differs.
 *
 * `main.ts` owns the lazy imports and the download wiring behind the three
 * callbacks; this module owns the buttons, the template picker, and the
 * empty-state gating that disables everything until a scan is loaded.
 */

import { el } from '../dom';
import { collapsibleSection } from '../collapsibleSection';
import type { ExportFormat } from '../../io/exporters';
import type { ExportMode } from '../../export/types';
// Direct subpath import — NOT the `'../../report'` barrel, which pulls pdf-lib
// into the static graph. `ReportTemplates.ts` is a pure-data module.
import {
  REPORT_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  getReportTemplate,
} from '../../report/ReportTemplates';
import type { ReportTemplateId } from '../../report/types';

/** The point-cloud file formats the quick exporter offers. */
const EXPORT_FORMATS: ExportFormat[] = ['ply', 'obj', 'xyz', 'csv'];

/**
 * Visual Export Studio — the PNG export modes. Each entry is `mode / label /
 * title`; the title doubles as the disabled-state hover hint. The specific
 * colour-mode buttons come first because they reliably produce distinct images;
 * the generic "View capture" comes last (it captures whatever colour mode is
 * active, so it can match Height map when the user is already in elevation).
 */
const IMAGE_EXPORT_BUTTONS: ReadonlyArray<{
  readonly mode: ExportMode;
  readonly label: string;
  readonly title: string;
}> = [
  {
    mode: 'height-map',
    label: 'Height map',
    title: 'Forces elevation colouring. Always distinct from view-capture-in-other-modes.',
  },
  {
    mode: 'intensity',
    label: 'Intensity',
    title: 'Forces LiDAR-intensity colouring. Disabled on clouds without an intensity channel.',
  },
  {
    mode: 'classification',
    label: 'Class map',
    title: 'Forces ASPRS-classification colouring. Disabled on clouds without a classification channel.',
  },
  {
    mode: 'normal',
    label: 'Normal map',
    title:
      'RGB-encodes per-point surface normals. Disabled on clouds without normals ' +
      '(PCD / PTX / GLTF carry them; raw LiDAR rarely does).',
  },
  {
    mode: 'orthographic-rgb',
    label: 'View capture',
    title:
      'Captures the current on-screen view in whatever colour mode is active. ' +
      'To get a distinct image, switch the Color by chip before clicking — ' +
      'otherwise this matches Height Map when you are viewing in elevation. ' +
      'Georeferenced scans (known CRS + world origin) instead download a ' +
      'top-down ortho ZIP with .pgw/.prj sidecars that GIS tools place directly.',
  },
];

/** The callbacks the deliverables fire; main.ts owns the lazy engines behind them. */
export interface ExportDeliverablesCallbacks {
  /** Export the active cloud to a point-cloud file format. */
  readonly onExport: (format: ExportFormat) => void;
  /** Render the live scan in one Studio mode and download it as a PNG. */
  readonly onExportImage: (mode: ExportMode) => void;
  /** Generate a PDF report from the live scan using the named template. */
  readonly onExportReport: (templateId: string) => void;
}

/** The mounted deliverables plus the gating controller the shell drives. */
export interface ExportDeliverables {
  /** The section element to place in the Output panel body. */
  readonly element: HTMLElement;
  /** The format-export section, shown only for a resolvable cloud (hidden while streaming-only). */
  readonly formatSection: HTMLElement;
  /**
   * Enable or disable the image-export and report buttons as a group. A report
   * or an image against no cloud has nothing to draw, so they gate together and
   * start disabled.
   */
  setImageExportEnabled(enabled: boolean): void;
  /**
   * Per-mode availability override for the image-export buttons — disable the
   * ones the loaded cloud cannot supply (Normal map on a LAZ, Intensity on a raw
   * PLY) with the reason in the tooltip. Callers gate on
   * {@link setImageExportEnabled}(true) first; a mode missing from the map is
   * left as-is (a new exporter without per-mode flags still works).
   */
  setImageExportAvailability(
    availability: ReadonlyMap<ExportMode, { readonly available: boolean; readonly reason?: string }>,
  ): void;
}

/**
 * Build the three export sections and their gating. Returns the element to mount
 * and the controller the composition root drives on each scan load.
 */
export function buildExportDeliverables(cb: ExportDeliverablesCallbacks): ExportDeliverables {
  const imageExportButtons = new Map<ExportMode, HTMLButtonElement>();
  const imageExportTitles = new Map<ExportMode, string>();

  // Point-cloud file formats — one button per supported output format.
  const formatButtons = EXPORT_FORMATS.map((format) => {
    const button = el('button', {
      className: 'olv-export-btn',
      text: format.toUpperCase(),
      title: `Export the cloud as ${format.toUpperCase()}`,
    });
    button.addEventListener('click', () => {
      button.blur();
      cb.onExport(format);
    });
    return button;
  });
  const formatRow = el('div', { className: 'olv-export' }, formatButtons);
  const formatSection = collapsibleSection('Export', formatRow);

  // Visual Export Studio — one button per PNG mode. Start disabled so a user
  // cannot fire an export with nothing to draw; the class matches the format
  // row so the CSS layout is shared.
  const imageButtons = IMAGE_EXPORT_BUTTONS.map(({ mode, label, title }) => {
    const button = el('button', { className: 'olv-export-btn', text: label, title });
    button.disabled = true;
    button.title = `${title} (load a scan first)`;
    button.addEventListener('click', () => {
      button.blur();
      cb.onExportImage(mode);
    });
    imageExportButtons.set(mode, button);
    imageExportTitles.set(mode, title);
    return button;
  });
  // The image row carries several buttons — too many for one flex row inside a
  // narrow panel; the 2-column grid wraps cleanly.
  const imageRow = el('div', { className: 'olv-export-grid' }, imageButtons);

  // PDF report — a native <select> picks the template, a single button fires it.
  const reportSelect = el('select', {
    className: 'olv-report-select',
    ariaLabel: 'PDF report template',
  }) as HTMLSelectElement;
  for (const t of REPORT_TEMPLATES) {
    const option = el('option', { text: t.label, title: t.description });
    option.value = t.id;
    if (t.id === DEFAULT_TEMPLATE_ID) option.selected = true;
    reportSelect.append(option);
  }
  reportSelect.disabled = true;
  const reportButton = el('button', {
    className: 'olv-export-btn',
    text: 'Report PDF',
    title: 'Generate a multi-page PDF report from the selected template.',
  });
  reportButton.disabled = true;
  reportButton.title = `${reportButton.title} (load a scan first)`;
  reportButton.addEventListener('click', () => {
    reportButton.blur();
    const templateId = reportSelect.value as ReportTemplateId;
    // Defence-in-depth: the select is populated from REPORT_TEMPLATES, but a
    // devtools-injected option or a future rename could surface an unknown id.
    // Flash a visible button state so the click is observably acknowledged.
    if (!getReportTemplate(templateId)) {
      const original = reportButton.textContent;
      reportButton.textContent = 'Unknown template';
      reportButton.disabled = true;
      window.setTimeout(() => {
        reportButton.textContent = original;
        reportButton.disabled = false;
      }, 1500);
      return;
    }
    cb.onExportReport(templateId);
  });
  const reportRow = el('div', { className: 'olv-report-row' }, [reportSelect, reportButton]);

  const element = el('div', {}, [
    formatSection,
    collapsibleSection('Image export', imageRow),
    collapsibleSection('Report PDF', reportRow),
  ]);

  const setImageExportEnabled = (enabled: boolean): void => {
    for (const [mode, button] of imageExportButtons) {
      button.disabled = !enabled;
      const baseTitle = imageExportTitles.get(mode) ?? '';
      button.title = enabled ? baseTitle : `${baseTitle} (load a scan first)`;
    }
    // The report button + picker share the same gate (a report against no cloud
    // has nothing to summarise).
    reportButton.disabled = !enabled;
    const base = 'Generate a multi-page PDF report from the selected template.';
    reportButton.title = enabled ? base : `${base} (load a scan first)`;
    reportSelect.disabled = !enabled;
  };

  const setImageExportAvailability = (
    availability: ReadonlyMap<ExportMode, { readonly available: boolean; readonly reason?: string }>,
  ): void => {
    for (const [mode, button] of imageExportButtons) {
      const entry = availability.get(mode);
      if (!entry) continue; // unknown mode → leave as-is
      const baseTitle = imageExportTitles.get(mode) ?? '';
      if (entry.available) {
        button.disabled = false;
        button.title = baseTitle;
      } else {
        button.disabled = true;
        button.title = entry.reason
          ? `${baseTitle} — ${entry.reason}`
          : `${baseTitle} (unavailable on this cloud)`;
      }
    }
  };

  return { element, formatSection, setImageExportEnabled, setImageExportAvailability };
}
