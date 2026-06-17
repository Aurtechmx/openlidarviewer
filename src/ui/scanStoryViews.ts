/**
 * scanStoryViews.ts
 *
 * Render functions for the fitness-for-use synthesis ({@link scanStory}).
 * Pure DOM builders — they take the already-synthesised {@link ScanStory} /
 * {@link ExportHealth} and return a detached element. No state, no engine, no
 * I/O: the host mounts the Dataset Story card in a panel and wraps the Export
 * Health summary in its confirm dialog. Structure is unit-tested via the
 * recording DOM stub; pixels are covered by the e2e specs.
 */

import { el } from './dom';
import type { ScanStory, ExportHealth, HealthVerdict } from '../intelligence/scanStory';

const join = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(' · ') : '—');

/** A label · value row. Hidden entirely when `skipEmpty` and the value is "—". */
function row(label: string, value: string): HTMLElement {
  return el('div', { className: 'olv-story-row' }, [
    el('span', { className: 'olv-story-k', text: label }),
    el('span', { className: 'olv-story-v', text: value }),
  ]);
}

/**
 * The Dataset Story card — one compact "what is this, how good, what's it for,
 * what to watch, what to do next" surface over data already computed.
 */
export function renderDatasetStoryCard(story: ScanStory): HTMLElement {
  const tierClass = `is-${story.assessment.toLowerCase()}`;
  const card = el('aside', { className: 'olv-story-card' });

  card.append(
    el('div', { className: 'olv-story-head' }, [
      el('span', { className: 'olv-story-title', text: 'Dataset Story' }),
      el('span', { className: `olv-story-assess ${tierClass}`, text: story.assessment }),
    ]),
    el('div', { className: 'olv-story-headline', text: story.headline }),
    row('Primary limiter', story.primaryLimiter),
    row('Best for', join(story.bestFor)),
  );

  // Caution / not-recommended only render when there is something to say, so a
  // clean scan's card stays short.
  if (story.useCaution.length > 0) card.append(row('Use with caution', join(story.useCaution)));
  if (story.notRecommended.length > 0) {
    card.append(row('Not recommended', join(story.notRecommended)));
  }

  card.append(
    row('Not established', join(story.notEstablished)),
    el('div', { className: 'olv-story-next', text: `→ ${story.nextStep}` }),
  );
  return card;
}

const VERDICT_LABEL: Readonly<Record<HealthVerdict, string>> = {
  ready: 'Ready to export',
  caution: 'Export with caution',
  blocked: 'Export blocked',
};

/**
 * The Export Health summary — the content of the pre-export confirmation. The
 * host adds the Export / Cancel controls around it.
 */
export function renderExportHealthPanel(health: ExportHealth): HTMLElement {
  const panel = el('div', { className: 'olv-health' });

  panel.append(
    el('div', {
      className: `olv-health-verdict is-${health.verdict}`,
      text: VERDICT_LABEL[health.verdict],
    }),
  );

  const rows = el('div', { className: 'olv-health-rows' });
  for (const r of health.rows) {
    rows.append(
      el('div', { className: `olv-health-row is-${r.tier}` }, [
        el('span', { className: 'olv-health-k', text: r.label }),
        el('span', { className: 'olv-health-v', text: r.value }),
      ]),
    );
  }
  panel.append(rows);

  if (health.blockers.length > 0) {
    const list = el('ul', { className: 'olv-health-blockers' });
    for (const b of health.blockers) list.append(el('li', { text: b }));
    panel.append(
      el('div', { className: 'olv-health-blockers-title', text: 'Before you hand this off' }),
      list,
    );
  }
  return panel;
}
