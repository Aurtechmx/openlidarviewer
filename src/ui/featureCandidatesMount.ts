/**
 * featureCandidatesMount.ts — the review surface for extracted feature candidates.
 *
 * The building-footprint and conductor-fit cores propose candidates; this is
 * where a person reviews them. It loads as one split chunk the first time a
 * layer is found to carry building- or wire-classified points, so a session that
 * never opens such data loads none of it. The only route in is
 * `loadFeatureCandidatesMount()` in `lazyChunks.ts`.
 *
 * WHAT THIS SURFACE PROMISES, AND WHAT IT REFUSES TO. Every row is a DERIVED
 * CANDIDATE, never a detected building or a surveyed conductor. It is a proposal
 * from classified points, and when that classification was the viewer's own
 * heuristic rather than the file's, the header says so — a candidate over a
 * guess is a guess. Measures are shown in the source unit always, and in metres
 * only when the linear unit is known; a candidate never invents a metric figure.
 * Nothing here claims a footprint is a building outline of record, and nothing
 * asserts a cadastral or survey accuracy.
 *
 * A conductor is ONE fit over ALL wire-classified points: the core reports a
 * single span and sag, or declines when the points are not linear enough to be a
 * conductor. It is labelled as a parabolic fit, not a calibrated catenary.
 *
 * The review decisions live in a `CandidateReviewStore`, keyed by each
 * candidate's geometry-derived id, so a re-open re-attaches a judgment to the
 * thing it was made about rather than to a list position.
 */

import type { PointCloud } from '../model/PointCloud';
import {
  buildFeatureExtractionInput,
  type FeatureExtractionInput,
} from '../app/featureExtractionInput';
import {
  extractBuildingCandidates,
  extractConductorCandidate,
  type BuildingCandidate,
  type ConductorCandidate,
} from '../features/FeatureExtractionService';
import { CandidateReviewStore, type CandidateStatus } from '../features/candidateReview';
import { el } from './dom';

export interface MountFeatureCandidatesOptions {
  readonly cloud: PointCloud;
  /** Where the launcher card is rendered. */
  readonly launcherHost: HTMLElement;
  /** The container the review list is rendered into, revealed on launch. */
  readonly reviewHost: HTMLElement;
  /** Reveals `reviewHost`. */
  readonly onLaunch: () => void;
}

export interface MountedFeatureCandidates {
  readonly dispose: () => void;
}

/** A source-unit measure, plus its metric twin only when the unit is known. */
function measure(source: number, metric: number | null, unitSuffix: string): string {
  const s = source.toFixed(2);
  return metric === null ? `${s} ${unitSuffix} (source unit)` : `${metric.toFixed(2)} ${unitSuffix}`;
}

/**
 * Render the launcher and wire the review list behind it.
 *
 * Extraction runs on the first launch, not on mount, so a layer whose launcher
 * is never pressed costs one card.
 */
export function mountFeatureCandidates(
  opts: MountFeatureCandidatesOptions,
): MountedFeatureCandidates {
  const { cloud, launcherHost, reviewHost, onLaunch } = opts;
  const review = new CandidateReviewStore();
  let built = false;

  const card = el('div', { className: 'olv-feature-launcher' });
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Feature candidates');
  card.append(el('div', { className: 'olv-feature-launcher-head', text: 'Feature Candidates' }));
  card.append(
    el('div', {
      className: 'olv-feature-launcher-title',
      text: 'Propose footprints and conductors from classified points',
    }),
  );

  // Read the building/wire points once, here, so the gate that showed this
  // launcher (any classification present) is separated from the specific fact.
  const input = buildFeatureExtractionInput(cloud);
  if (!input) {
    card.append(
      el('div', {
        className: 'olv-feature-launcher-fact',
        text: 'This scan carries no building- or wire-classified points.',
      }),
    );
    launcherHost.replaceChildren(card);
    return {
      dispose: () => {
        launcherHost.replaceChildren();
        reviewHost.replaceChildren();
      },
    };
  }

  const counts = `${input.buildingPoints.length.toLocaleString()} building-classified, ${input.conductorPoints.length.toLocaleString()} wire-classified point(s)`;
  card.append(el('div', { className: 'olv-feature-launcher-fact', text: counts }));
  card.append(
    el('p', {
      className: 'olv-feature-launcher-message',
      text: 'Each result is a derived candidate for review, not a detected building or surveyed conductor.',
    }),
  );

  const button = el('button', {
    className: 'olv-feature-launcher-action',
    text: 'Extract candidates',
  });
  button.type = 'button';
  button.addEventListener('click', () => {
    if (!built) {
      built = true;
      reviewHost.replaceChildren(buildReview(input, review));
    }
    onLaunch();
  });
  card.append(button);

  launcherHost.replaceChildren(card);

  return {
    dispose: () => {
      launcherHost.replaceChildren();
      reviewHost.replaceChildren();
    },
  };
}

/** Build the review list element from the extraction input. */
function buildReview(input: FeatureExtractionInput, review: CandidateReviewStore): HTMLElement {
  const root = el('div', { className: 'olv-feature-review' });

  if (input.classificationIsDerived) {
    root.append(
      el('p', {
        className: 'olv-feature-note olv-feature-derived',
        text: 'These candidates are built on the viewer’s own heuristic classification, not classes from the file — a candidate about a guess.',
      }),
    );
  }

  const buildings = extractBuildingCandidates(
    input.buildingPoints,
    input.buildingGrid,
    input.unit,
  );
  const conductor = extractConductorCandidate(input.conductorPoints, input.unit, input.up);
  const conductors = conductor ? [conductor] : [];

  root.append(renderBuildingSection(buildings, review));
  root.append(renderConductorSection(conductors, input.conductorPoints.length, review));
  return root;
}

function statusChips(
  id: string,
  review: CandidateReviewStore,
  row: HTMLElement,
): HTMLElement {
  const chips = el('div', { className: 'olv-feature-chips' });
  const paint = (): void => {
    const status: CandidateStatus = review.statusOf(id);
    row.dataset.status = status;
    for (const [value, btn] of entries) {
      btn.classList.toggle('is-active', value === status);
      btn.setAttribute('aria-pressed', value === status ? 'true' : 'false');
    }
  };
  const entries: ReadonlyArray<readonly [CandidateStatus, HTMLButtonElement]> = (
    [
      ['accepted', 'Accept'],
      ['review', 'Pending'],
      ['rejected', 'Reject'],
    ] as ReadonlyArray<readonly [CandidateStatus, string]>
  ).map(([value, label]) => {
    const btn = el('button', { className: 'olv-feature-chip', text: label });
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (value === 'accepted') review.accept(id);
      else if (value === 'rejected') review.reject(id);
      else review.reset(id);
      paint();
    });
    chips.append(btn);
    return [value, btn] as const;
  });
  paint();
  return chips;
}

function renderBuildingSection(
  buildings: readonly BuildingCandidate[],
  review: CandidateReviewStore,
): HTMLElement {
  const section = el('div', { className: 'olv-feature-section' });
  section.append(
    el('h4', { text: `Building footprints — ${buildings.length} candidate(s)` }),
  );
  section.append(
    el('p', {
      className: 'olv-feature-note',
      text: 'Connected regions of building-classified points. A region can be trees or noise that survived classification; it is not asserted to be a building.',
    }),
  );
  if (buildings.length === 0) {
    section.append(el('p', { className: 'olv-feature-empty', text: 'No footprint candidates.' }));
    return section;
  }
  for (const b of buildings) {
    const row = el('div', { className: 'olv-feature-row' });
    row.append(el('div', { className: 'olv-feature-id', text: b.id }));
    row.append(
      el('div', {
        className: 'olv-feature-measure',
        text: `Area ${measure(b.areaSource, b.areaM2, 'm²')} · ${b.cellCount} cells`,
      }),
    );
    row.append(statusChips(b.id, review, row));
    section.append(row);
  }
  return section;
}

function renderConductorSection(
  conductors: readonly ConductorCandidate[],
  wirePointCount: number,
  review: CandidateReviewStore,
): HTMLElement {
  const section = el('div', { className: 'olv-feature-section' });
  section.append(el('h4', { text: `Conductor fit — ${conductors.length} candidate(s)` }));
  section.append(
    el('p', {
      className: 'olv-feature-note',
      text: 'A single parabolic fit over all wire-classified points — a small-sag approximation, not a calibrated catenary. The fit is declined when the points are not linear enough to be one span.',
    }),
  );
  if (conductors.length === 0) {
    section.append(
      el('p', {
        className: 'olv-feature-empty',
        text:
          wirePointCount > 0
            ? 'Wire points were present but did not fit a single conductor span.'
            : 'No wire-classified points.',
      }),
    );
    return section;
  }
  for (const c of conductors) {
    const row = el('div', { className: 'olv-feature-row' });
    row.append(el('div', { className: 'olv-feature-id', text: c.id }));
    row.append(
      el('div', {
        className: 'olv-feature-measure',
        text: `Span ${measure(c.spanSource, c.spanM, 'm')} · sag ${measure(c.sagSource, c.sagM, 'm')} · linearity ${c.linearity.toFixed(3)} · RMS ${measure(c.residualRmsSource, c.residualRmsM, 'm')}`,
      }),
    );
    row.append(statusChips(c.id, review, row));
    section.append(row);
  }
  return section;
}
