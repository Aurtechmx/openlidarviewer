/**
 * renderProvenance.ts
 *
 * The Inspector's "Provenance" fingerprint body, split out of `Inspector.ts`
 * as a lazy chunk (loaded via `loadRenderProvenance()` in `lazyChunks.ts`).
 * Self-contained: headline, signal list, literature-bounds ribbon,
 * disclaimer, and the capture-type override `<select>` (a static 7-option
 * list). No shared state beyond its arguments.
 *
 * Pure render function. `Inspector.setProvenance()` keeps its synchronous
 * signature; it shows a loading placeholder, imports this module, then
 * calls `renderProvenance` once the chunk resolves.
 */

import { el } from '../dom';
import type { ProvenanceFingerprint, CaptureType } from '../../diagnostics/provenance';

/** Render the full Provenance fingerprint body into `body`. */
export function renderProvenance(
  body: HTMLElement,
  f: ProvenanceFingerprint,
  onOverride: (type: CaptureType) => void,
): void {
  body.replaceChildren();

  // Headline — capture type + confidence badge.
  const headline = el('div', { className: 'olv-prov-headline' }, [
    el('span', { className: 'olv-prov-label', text: f.label }),
    el('span', {
      className: `olv-prov-confidence olv-prov-confidence-${f.confidence}`,
      text: `${f.confidence} confidence`,
    }),
  ]);
  body.append(headline);

  // Signals — what made the classifier pick this.
  if (f.signals.length > 0) {
    const signals = el('div', { className: 'olv-prov-signals' });
    for (const s of f.signals) {
      signals.append(el('div', { className: 'olv-prov-signal', text: `· ${s}` }));
    }
    body.append(signals);
  }

  // Literature ribbon — every bound carries its source.
  if (f.bounds.length > 0) {
    const ribbon = el('div', { className: 'olv-prov-ribbon' });
    ribbon.append(
      el('div', {
        className: 'olv-prov-ribbon-title',
        text: 'Expected accuracy ranges',
      }),
    );
    for (const b of f.bounds) {
      ribbon.append(
        el('div', { className: 'olv-prov-bound' }, [
          el('div', { className: 'olv-prov-bound-label', text: b.label }),
          el('div', { className: 'olv-prov-bound-value', text: b.value }),
          el('div', { className: 'olv-prov-bound-source', text: b.source }),
        ]),
      );
    }
    body.append(ribbon);
  }

  // Disclaimer — always present, deliberately verbose.
  body.append(el('div', { className: 'olv-prov-disclaimer', text: f.disclaimer }));

  // User override — a small dropdown the user can use when the classifier
  // got it wrong. Caller is wired via Inspector.setOnProvenanceOverride.
  const overrideRow = el('div', { className: 'olv-prov-override-row' });
  overrideRow.append(
    el('span', { className: 'olv-prov-override-label', text: 'Override:' }),
  );

  const select = el('select', {
    className: 'olv-prov-override-select',
    ariaLabel: 'Capture type override',
    tip: 'Set how this scan was captured if the automatic guess is wrong.',
  });
  const options: Array<[CaptureType, string]> = [
    ['iphone-lidar', 'iPhone / handheld'],
    ['drone-lidar', 'Drone / UAV ALS'],
    ['terrestrial', 'Terrestrial laser scan'],
    ['mobile-slam', 'Mobile SLAM'],
    ['aerial-als', 'Aerial / airborne ALS'],
    ['spaceborne', 'Spaceborne'],
    ['unknown', 'Unknown'],
  ];
  for (const [type, label] of options) {
    const option = el('option', { text: label }) as HTMLOptionElement;
    option.value = type;
    if (type === f.captureType) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const next = select.value as CaptureType;
    if (next !== f.captureType) onOverride(next);
  });
  overrideRow.append(select);
  body.append(overrideRow);
}
