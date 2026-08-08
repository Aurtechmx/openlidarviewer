/**
 * ProcessStudioPanel.ts
 *
 * The Process Studio view: for the loaded scan it shows the adaptive processing
 * stages that apply, each product's eligibility (ready / review / blocked with a
 * reason), and the independent QA checks (pass / review / block). It reads the
 * pure Phase-1/2 services — `ProcessService`, `processStages`, `qaChecks` — and
 * renders them; it decides nothing itself, so the panel and the exporters can
 * never disagree about what is eligible.
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

  /** Render for a scan's facts, or an empty state when none is loaded. */
  update(facts: ScanFacts | null): void {
    this._stages.replaceChildren();
    this._products.replaceChildren();
    this._qa.replaceChildren();

    if (!facts) {
      this._stages.append(el('p', { className: 'olv-ps-empty', text: 'Load a scan to see its processing stages, products and checks.' }));
      return;
    }

    // Adaptive stages.
    for (const stage of relevantStages({ scans: [facts] })) {
      this._stages.append(el('span', { className: 'olv-ps-stage', text: stage.title, tip: stage.reason }));
    }

    // Product eligibility.
    const svc = ProcessService.fromFacts([facts]);
    for (const p of PRODUCTS) {
      const cap = svc.capability(p.id);
      const readiness = cap?.readiness ?? 'blocked';
      this._products.append(
        el('li', { className: `olv-ps-product olv-ps-${readiness}`, tip: cap?.reason }, [
          el('span', { className: 'olv-ps-product-name', text: p.label }),
          el('span', { className: 'olv-ps-badge', text: readiness }),
        ]),
      );
    }

    // Independent QA checks.
    for (const check of runQaChecks(facts)) {
      this._qa.append(
        el('li', { className: `olv-ps-check olv-ps-${check.status}`, tip: check.reason }, [
          el('span', { className: 'olv-ps-check-name', text: check.label }),
          el('span', { className: 'olv-ps-badge', text: check.status }),
        ]),
      );
    }
  }
}
