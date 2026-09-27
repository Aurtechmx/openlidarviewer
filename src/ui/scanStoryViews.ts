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
import {
  renderStateGlyph,
  stateFromHealthTier,
  stateFromFitnessTier,
  type SciState,
} from './stateChip';
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
      el('span', { className: `olv-story-assess ${tierClass}` }, [
        renderStateGlyph(stateFromFitnessTier(story.assessment), `Dataset fitness ${story.assessment}`),
        el('span', { text: story.assessment }),
      ]),
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

/** The verdict in the shared state vocabulary, so one glyph names both. */
const VERDICT_STATE: Readonly<Record<HealthVerdict, SciState>> = {
  ready: 'measured',
  caution: 'review',
  blocked: 'blocked',
};

/**
 * The readiness header: calm and specific. A condition that only limits the
 * export reads as something to review (amber); red is kept for a condition
 * that makes the export wrong.
 */
export function exportHealthHeader(health: ExportHealth): { readonly text: string; readonly tone: 'ready' | 'review' | 'wrong' } {
  const n = health.items.length;
  const count = `${n} item${n === 1 ? '' : 's'}`;
  if (health.verdict === 'ready') return { text: 'Ready to export', tone: 'ready' };
  if (health.verdict === 'blocked' || health.items.some((i) => i.wrong)) {
    return { text: n > 0 ? `Export blocked · ${count}` : 'Export blocked', tone: 'wrong' };
  }
  return { text: n > 0 ? `Review before hand-off · ${count}` : 'Review before hand-off', tone: 'review' };
}

/**
 * The Export Health summary — the content of the pre-export confirmation. The
 * host adds the Export / Cancel controls around it.
 */
export function renderExportHealthPanel(
  health: ExportHealth,
  actions: { readonly fullResolution?: () => void } = {},
): HTMLElement {
  const panel = el('div', { className: 'olv-health' });
  const head = exportHealthHeader(health);
  panel.append(
    el('div', { className: `olv-health-verdict is-${health.verdict} is-tone-${head.tone}` }, [
      renderStateGlyph(VERDICT_STATE[health.verdict], head.text),
      el('span', { text: ` ${head.text}` }),
    ]),
  );

  // Each item is one plain line with its fix, straight under the header.
  if (health.items.length > 0) {
    const list = el('ul', { className: 'olv-health-blockers' });
    for (const item of health.items) {
      const li = el('li', { className: item.wrong ? 'is-wrong' : 'is-limit', text: item.text });
      const fix = item.remedy === 'full-resolution' ? actions.fullResolution : undefined;
      if (fix) {
        const b = el('button', {
          className: 'olv-health-fix',
          text: 'Use full resolution',
          title: 'Tick Convert at full resolution so the export writes every point.',
        });
        b.setAttribute('type', 'button');
        b.addEventListener('click', fix);
        li.append(b);
      }
      list.append(li);
    }
    panel.append(list);
  }

  const rows = el('div', { className: 'olv-health-rows' });
  for (const r of health.rows) {
    rows.append(
      el('div', { className: `olv-health-row is-${r.tier}` }, [
        renderStateGlyph(stateFromHealthTier(r.tier), r.label),
        el('span', { className: 'olv-health-k', text: r.label }),
        el('span', { className: 'olv-health-v', text: r.value }),
      ]),
    );
  }
  panel.append(rows);
  return panel;
}
