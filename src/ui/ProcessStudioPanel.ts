/**
 * ProcessStudioPanel.ts
 *
 * The Process Studio view: for the loaded scan it shows the adaptive processing
 * stages that apply, each product's eligibility (ready / review / blocked with a
 * reason), and the independent QA checks (pass / review / block). It reads the
 * pure Phase-1/2 services — `ProcessService`, `processStages`, `qaChecks` — and
 * renders them; it decides nothing itself.
 *
 * It shows `ProcessService`'s coarse readiness (ready / review / blocked). That
 * is NOT the same gate the file exporters enforce: a contour or DEM export is
 * permitted by `src/export/contourExportPermit.ts`, a finer decision that also
 * reads launch state, the evidence grade, and the in-memory precision permit,
 * and that deliberately allows a `cartographic-only` exploratory export where
 * `ProcessService` reports `review`. So the panel and an exporter CAN show
 * different verdicts for the same product, and that is by design — the panel
 * describes whether a metric-grade product is READY, the permit decides whether
 * a specific file (graded or exploratory) may be written. They are not yet a
 * single authorization backbone; unifying them is deferred work, not a claim
 * this panel makes.
 *
 * DISPLAY ONLY, in the same vocabulary as ClassLegendPanel / MeasurePanel: a
 * `readonly element`, `el(...)`-built DOM, and `mount()/show()/hide()/update()`.
 * It never touches three.js, the GPU, or the analysis pipeline. Every readiness
 * and QA verdict carries its reason, and an unknown scan fact reads as the
 * conservative state, never as capability.
 */

import { el } from './dom';
import type { ScanFacts, ProductId } from '../process/ProcessPlan';
import { ProcessService } from '../process/ProcessService';
import { relevantStages } from '../process/processStages';
import { runQaChecks } from '../qa/qaChecks';

const PRODUCTS: ReadonlyArray<{ id: ProductId; label: string }> = [
  { id: 'classify-gaps', label: 'Classify gaps' },
  { id: 'dtm', label: 'DTM' },
  { id: 'dsm', label: 'DSM' },
  { id: 'contours', label: 'Contours' },
  { id: 'building-footprints', label: 'Building footprints' },
  { id: 'cross-epoch-change', label: 'Change (cross-epoch)' },
  { id: 'volume-cut-fill', label: 'Volume (cut/fill)' },
];

export class ProcessStudioPanel {
  readonly element: HTMLElement;
  private readonly _stages: HTMLElement;
  private readonly _products: HTMLElement;
  private readonly _qa: HTMLElement;
  /** Products already generated for the loaded scan (e.g. DTM + contours after an analysis run). */
  private _produced = new Set<ProductId>();
  /** The facts last rendered, so `setProduced` can re-render without a re-fetch. */
  private _lastFacts: ScanFacts | null = null;

  constructor() {
    this.element = el('section', { className: 'olv-process-studio', ariaLabel: 'Process Studio' }, [
      el('h2', { className: 'olv-ps-title', text: 'Process Studio' }),
      el('div', { className: 'olv-ps-stages' }),
      el('h3', { className: 'olv-ps-subtitle', text: 'Products' }),
      el('ul', { className: 'olv-ps-products' }),
      el('h3', { className: 'olv-ps-subtitle', text: 'Quality checks' }),
      el('ul', { className: 'olv-ps-qa' }),
    ]);
    this._stages = this.element.querySelector('.olv-ps-stages') as HTMLElement;
    this._products = this.element.querySelector('.olv-ps-products') as HTMLElement;
    this._qa = this.element.querySelector('.olv-ps-qa') as HTMLElement;
  }

  mount(parent: HTMLElement): void {
    parent.append(this.element);
  }

  show(): void {
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  /**
   * Mark a set of products as generated (produced) for the loaded scan and
   * re-render. Called after an analysis run so DTM / contours read "produced"
   * rather than only their pre-run eligibility.
   */
  setProduced(ids: Iterable<ProductId>): void {
    this._produced = new Set(ids);
    this.update(this._lastFacts);
  }

  /** Render for a scan's facts, or an empty state when none is loaded. */
  update(facts: ScanFacts | null): void {
    this._lastFacts = facts;
    this._stages.replaceChildren();
    this._products.replaceChildren();
    this._qa.replaceChildren();

    if (!facts) {
      this._produced.clear(); // no scan → nothing produced
      this._stages.append(el('p', { className: 'olv-ps-empty', text: 'Load a scan to see its processing stages, products and checks.' }));
      return;
    }

    // Adaptive stages. A stage's reason is supplementary (it explains why a
    // stage applies), so it stays a native `title` tooltip — which, unlike the
    // measure-bar-scoped `data-tip`, actually shows here.
    for (const stage of relevantStages({ scans: [facts] })) {
      this._stages.append(el('span', { className: 'olv-ps-stage', text: stage.title, title: stage.reason }));
    }

    // Product eligibility. The readiness reason is the whole point of the row —
    // WHY a product is review/blocked — so it is a VISIBLE caption, not a
    // hover-only attribute a keyboard user can never reach.
    const svc = ProcessService.fromFacts([facts]);
    for (const p of PRODUCTS) {
      const cap = svc.capability(p.id);
      const readiness = cap?.readiness ?? 'blocked';
      // A product generated by the last analysis run reads "produced" — a state
      // above eligibility, so the panel shows what has actually been made, not
      // just what could be. The produced note and the eligibility reason both
      // ride through _verdictRow, so they stay VISIBLE captions, not hover-only.
      const produced = this._produced.has(p.id);
      const status = produced ? 'produced' : readiness;
      const reason = produced
        ? `Produced by the last analysis — ready to export.${cap?.reason ? ` (${cap.reason})` : ''}`
        : cap?.reason;
      this._products.append(
        this._verdictRow(
          `olv-ps-product olv-ps-${readiness}${produced ? ' olv-ps-produced' : ''}`,
          p.label,
          status,
          reason,
        ),
      );
    }

    // Independent QA checks — same treatment: the failure reason is reachable
    // without hovering.
    for (const check of runQaChecks(facts)) {
      this._qa.append(this._verdictRow(`olv-ps-check olv-ps-${check.status}`, check.label, check.status, check.reason));
    }
  }

  /**
   * A verdict row: the name and its status badge on one line, with the reason
   * one click/keypress away in a native `<details>` — compact by default, so a
   * panel of a dozen verdicts is not a wall of text, yet every reason is
   * reachable without hover (Enter/Space toggles the summary; a screen reader
   * announces it). The reason reuses `cap.reason` / `check.reason` verbatim.
   *
   * A withheld verdict must never read as a bare badge with no explanation, so
   * when the service carries no reason (a product the plan does not model reads
   * `blocked` by default) a truthful fallback fills in rather than leaving the
   * disclosure empty. A good verdict with no reason is just a plain line.
   */
  private _verdictRow(className: string, name: string, status: string, reason?: string): HTMLElement {
    const line = [
      el('span', { className: 'olv-ps-name', text: name }),
      el('span', { className: 'olv-ps-badge', text: status }),
    ];
    const withheld = status !== 'ready' && status !== 'pass';
    const shown = reason ?? (withheld ? 'This product is not available for the loaded scan.' : undefined);
    if (!shown) {
      return el('li', { className }, [el('div', { className: 'olv-ps-line' }, line)]);
    }
    return el('li', { className }, [
      el('details', { className: 'olv-ps-verdict' }, [
        el('summary', { className: 'olv-ps-line' }, line),
        el('p', { className: 'olv-ps-reason', text: shown }),
      ]),
    ]);
  }
}
