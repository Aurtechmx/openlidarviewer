/**
 * classificationAgreement.ts
 *
 * Label agreement for ground filtering: how well a predicted ground/non-ground
 * labelling matches a reference labelling.
 *
 * Why this is not just an accuracy number. Ground filtering is usually heavily
 * imbalanced, so plain accuracy is dominated by whichever class is larger and a
 * filter that labels everything non-ground can score well. Precision, recall,
 * balanced accuracy, IoU and MCC are reported together because each one fails
 * in a different direction, and a reader comparing two filters needs to see
 * which trade was made.
 *
 * Why `ambiguous` is a first-class label. A human labeller looking at a low
 * point under dense canopy often cannot say whether it is ground, and forcing
 * that call produces a reference that is confidently wrong. Ambiguous pairs are
 * excluded from every binary metric and counted on their own, so a reader can
 * see how much of the scene the metrics decline to speak for. `unclassified` is
 * kept separate again: that is the classifier abstaining, not the truth being
 * unclear.
 *
 * A missing measurement is `null`, never `0`: precision with no positive
 * predictions is undefined, and reporting it as 0 would claim a measured
 * failure where there was no measurement.
 *
 * Pure arithmetic over plain arrays. No I/O, no DOM.
 */

/**
 * The label vocabulary.
 *
 * `ambiguous` means "cannot be decided" and is excluded from binary metrics.
 * `unclassified` means "no label was produced" and is counted as an abstention.
 */
export const CLASS_LABELS = ['ground', 'non-ground', 'ambiguous', 'unclassified'] as const;

export type ClassLabel = (typeof CLASS_LABELS)[number];

/** 2x2 counts over the pairs that survived exclusion. Ground is the positive. */
export interface ConfusionMatrix {
  /** Truth ground, predicted ground. */
  readonly truePositive: number;
  /** Truth non-ground, predicted ground. */
  readonly falsePositive: number;
  /** Truth ground, predicted non-ground. */
  readonly falseNegative: number;
  /** Truth non-ground, predicted non-ground. */
  readonly trueNegative: number;
}

export type ClassificationRefusalReason =
  | 'length-mismatch'
  | 'empty-input'
  | 'unknown-label'
  | 'no-binary-pairs'
  | 'below-min-pairs'
  | 'invalid-min-pairs';

export interface ClassificationRefusal {
  readonly status: 'refused';
  readonly reason: ClassificationRefusalReason;
  readonly detail: string;
}

export interface ClassificationAgreement {
  readonly status: 'compared';
  /** Pairs supplied, including everything excluded below. */
  readonly pairs: number;
  /** Pairs that entered the binary metrics. */
  readonly evaluated: number;
  /** Excluded because either side was `ambiguous`. */
  readonly ambiguousCount: number;
  /** Excluded because either side was `unclassified`. */
  readonly abstainedCount: number;
  readonly confusion: ConfusionMatrix;
  readonly groundPrecision: number | null;
  readonly groundRecall: number | null;
  readonly groundF1: number | null;
  readonly nonGroundPrecision: number | null;
  readonly nonGroundRecall: number | null;
  readonly balancedAccuracy: number | null;
  /**
   * Matthews correlation coefficient in [-1, 1]. Defined at the degenerate
   * margins by the convention documented on `MCC_DEGENERATE_VALUE`; check
   * `mccDegenerate` before reading a 0 as a measurement.
   */
  readonly mcc: number;
  readonly mccDegenerate: boolean;
  /** Intersection over union for the ground class (Jaccard index). */
  readonly groundIoU: number | null;
}

export type ClassificationComparison = ClassificationAgreement | ClassificationRefusal;

export interface ClassificationOptions {
  /** Refuse a comparison with fewer evaluated pairs than this. Default 1. */
  readonly minPairs?: number;
}

/**
 * The value MCC takes when its denominator is zero.
 *
 * The denominator vanishes exactly when one of the four margins is empty: the
 * reference holds a single class, or the classifier emitted a single class. In
 * both cases the labelling carries no information about the other axis, because
 * a constant output cannot be distinguished from a perfect one. Zero is the
 * value that says "no measurable correlation", it keeps the coefficient inside
 * its stated [-1, 1] range, and it matches the convention used by
 * scikit-learn's `matthews_corrcoef`, so a figure computed here can be compared
 * against one computed there.
 *
 * The cost of the convention is that a degenerate 0 looks like an ordinary 0,
 * which is why `mccDegenerate` is reported alongside it rather than left for
 * the reader to infer.
 */
export const MCC_DEGENERATE_VALUE = 0;

function refuse(
  reason: ClassificationRefusalReason,
  detail: string,
): ClassificationRefusal {
  return { status: 'refused', reason, detail };
}

function isLabel(v: string): v is ClassLabel {
  return (CLASS_LABELS as readonly string[]).includes(v);
}

function ratio(numerator: number, denominator: number): number | null {
  // null, not 0: an empty denominator means the quantity was never measured.
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Compare a predicted labelling against a reference labelling.
 *
 * Exclusion order matters and is fixed: `unclassified` on either side is an
 * abstention, `ambiguous` on either side is undecidable, and a pair is counted
 * under abstention when both apply, because an abstention is a property of the
 * classifier and is the more actionable of the two.
 */
export function classificationAgreement(
  truth: readonly ClassLabel[],
  predicted: readonly ClassLabel[],
  options: ClassificationOptions = {},
): ClassificationComparison {
  const minPairs = options.minPairs ?? 1;
  if (!Number.isInteger(minPairs) || minPairs < 1) {
    return refuse('invalid-min-pairs', `minPairs must be an integer >= 1, got ${minPairs}`);
  }
  if (truth.length !== predicted.length) {
    return refuse(
      'length-mismatch',
      `truth holds ${truth.length} labels, prediction holds ${predicted.length}`,
    );
  }
  if (truth.length === 0) {
    return refuse('empty-input', 'no label pairs supplied; a zero-pair comparison is not reported');
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let ambiguousCount = 0;
  let abstainedCount = 0;

  for (let i = 0; i < truth.length; i++) {
    const t = truth[i];
    const p = predicted[i];
    if (!isLabel(t) || !isLabel(p)) {
      return refuse('unknown-label', `pair ${i} holds an unknown label: "${t}" / "${p}"`);
    }
    if (t === 'unclassified' || p === 'unclassified') {
      abstainedCount++;
      continue;
    }
    if (t === 'ambiguous' || p === 'ambiguous') {
      ambiguousCount++;
      continue;
    }
    if (t === 'ground') {
      if (p === 'ground') tp++;
      else fn++;
    } else {
      if (p === 'ground') fp++;
      else tn++;
    }
  }

  const evaluated = tp + fp + fn + tn;
  if (evaluated === 0) {
    return refuse(
      'no-binary-pairs',
      `every one of ${truth.length} pairs was ambiguous (${ambiguousCount}) or ` +
        `unclassified (${abstainedCount}); no binary metric is reported`,
    );
  }
  if (evaluated < minPairs) {
    return refuse('below-min-pairs', `${evaluated} evaluated pairs, ${minPairs} required`);
  }

  const groundPrecision = ratio(tp, tp + fp);
  const groundRecall = ratio(tp, tp + fn);
  const nonGroundPrecision = ratio(tn, tn + fn);
  const nonGroundRecall = ratio(tn, tn + fp);
  const f1Denominator = 2 * tp + fp + fn;
  const groundF1 = ratio(2 * tp, f1Denominator);
  const balancedAccuracy =
    groundRecall === null || nonGroundRecall === null
      ? null
      : (groundRecall + nonGroundRecall) / 2;

  // Multiply the four margins in float before the square root; the products stay
  // exact for the cell counts a raster or a point cloud produces.
  const mccDenominatorSq = (tp + fp) * (tp + fn) * (tn + fp) * (tn + fn);
  const mccDegenerate = mccDenominatorSq === 0;
  const mcc = mccDegenerate
    ? MCC_DEGENERATE_VALUE
    : (tp * tn - fp * fn) / Math.sqrt(mccDenominatorSq);

  return {
    status: 'compared',
    pairs: truth.length,
    evaluated,
    ambiguousCount,
    abstainedCount,
    confusion: { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn },
    groundPrecision,
    groundRecall,
    groundF1,
    nonGroundPrecision,
    nonGroundRecall,
    balancedAccuracy,
    mcc,
    mccDegenerate,
    groundIoU: ratio(tp, tp + fp + fn),
  };
}

/**
 * Specificity: the true-negative rate, TN / (TN + FP).
 *
 * This is the same quantity `classificationAgreement` already reports as
 * `nonGroundRecall`, the recall of the non-ground class. It is given here under
 * its standard name because a ground-filter report is read for two things at
 * once: how much ground a filter keeps, which is recall, and how cleanly it
 * holds the non-ground line, which is specificity. Naming the second one after
 * the first would read as a different measurement to anyone but the author.
 * Both come from the one confusion matrix through the same `ratio`, so the two
 * names cannot drift into two numbers.
 *
 * Null, not 0, when the reference held no non-ground: the rate was never
 * measured, and a 0 would claim a filter that failed on non-ground it never
 * saw.
 */
export function specificity(confusion: ConfusionMatrix): number | null {
  return ratio(confusion.trueNegative, confusion.trueNegative + confusion.falsePositive);
}
