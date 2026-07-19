/**
 * numerics.ts
 *
 * Compensated accumulators for statistics taken over many samples. Two failure
 * modes they guard against:
 *
 *   • the one-pass variance form Σx²/n − mean² catastrophically cancels when the
 *     spread is tiny next to the mean (a tall pile with a smooth top, a residual
 *     set clustered far from zero) — most significant digits are lost in the
 *     subtraction;
 *   • a long naive running sum drifts by ~O(N·ε), which becomes visible once N
 *     reaches the millions a full-resolution cloud carries.
 *
 * `WelfordStats` streams mean + variance in one pass with no cancellation.
 * `neumaierSum` / `NeumaierSum` are Kahan–Neumaier compensated summation (the
 * eager and the streaming form).
 *
 * Pure, dependency-free — unit-tested in Node.
 */

/**
 * Kahan–Neumaier compensated sum of a sequence of finite numbers. Carries the
 * low-order bits lost at each addition in a separate compensation term, so the
 * total stays accurate even when large and small magnitudes are mixed or N is
 * very large. Non-finite inputs propagate as they would in a plain sum.
 */
export function neumaierSum(values: Iterable<number>): number {
  const acc = new NeumaierSum();
  for (const x of values) acc.add(x);
  return acc.total;
}

/** The streaming form of {@link neumaierSum} — feed values with `add`. */
export class NeumaierSum {
  private _sum = 0;
  private _c = 0; // running compensation for lost low-order bits

  add(x: number): void {
    const t = this._sum + x;
    // Route the rounding loss to the compensation depending on which operand is
    // larger, so no bits are dropped regardless of the magnitudes' order.
    if (Math.abs(this._sum) >= Math.abs(x)) {
      this._c += this._sum - t + x;
    } else {
      this._c += x - t + this._sum;
    }
    this._sum = t;
  }

  /** The compensated running total. */
  get total(): number {
    return this._sum + this._c;
  }
}

/**
 * Streaming mean + variance via Welford's recurrence — numerically stable where
 * the one-pass Σx²/n − mean² form loses precision to cancellation. Reports the
 * POPULATION variance (÷N) to match the estimators that feed it; the sample
 * variance (÷N−1) is exposed too.
 */
export class WelfordStats {
  private _n = 0;
  private _mean = 0;
  private _m2 = 0; // Σ (x − running mean)², accumulated incrementally

  push(x: number): void {
    this._n += 1;
    const delta = x - this._mean;
    this._mean += delta / this._n;
    this._m2 += delta * (x - this._mean);
  }

  get count(): number {
    return this._n;
  }

  get mean(): number {
    return this._n > 0 ? this._mean : 0;
  }

  /** Population variance (÷N). Zero with no samples; clamped against fp noise. */
  get populationVariance(): number {
    return this._n > 0 ? Math.max(0, this._m2) / this._n : 0;
  }

  /** Sample variance (÷N−1). Zero with fewer than two samples. */
  get sampleVariance(): number {
    return this._n > 1 ? Math.max(0, this._m2) / (this._n - 1) : 0;
  }

  get populationStd(): number {
    return Math.sqrt(this.populationVariance);
  }

  get sampleStd(): number {
    return Math.sqrt(this.sampleVariance);
  }
}
