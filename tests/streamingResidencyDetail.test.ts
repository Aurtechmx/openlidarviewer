/**
 * streamingResidencyDetail.test.ts — what the Inspector's Detail readout states
 * for a STREAMING source.
 *
 * A streaming source holds a bounded subset of its file on the GPU. The Detail
 * readout used to be handed the source total as BOTH arguments of the static
 * `setDetail(shown, total)` seam, so a 90 M point COPC of which 3 M were
 * resident rendered "89.6M / 89.6M points" with a full bar. Three quantities
 * were collapsed into one: what the source declares it holds, what is resident
 * now, and whether the current view is ready.
 *
 * These cases pin the two that this readout owns. Source and resident are
 * separate fields of one typed object, so they cannot be transposed; the
 * residency percentage is resident over source and reads 100 % only when the
 * whole source is resident. The third quantity — current-view readiness — comes
 * from the scheduler's wanted set and is asserted here only to prove the two
 * are independent: a 5 % resident source can carry a settled view.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  streamingDetailReadout,
  renderStreamingDetail,
  clearStreamingDetail,
  type StreamingDetail,
} from '../src/ui/streamingDetail';
import { evaluateRefinementReadiness } from '../src/render/streaming/refinementReadiness';

/** A source that declares an authoritative total. */
function declared(residentPointCount: number, sourcePointCount: number): StreamingDetail {
  return { residentPointCount, sourcePointCount, sourcePointCountKnown: true };
}

/** A source that declares no total (some 3D Tiles tilesets). */
function undeclared(residentPointCount: number): StreamingDetail {
  return { residentPointCount, sourcePointCount: null, sourcePointCountKnown: false };
}

/** Everything the readout would put on screen, as one string. */
function shown(detail: StreamingDetail): string {
  return streamingDetailReadout(detail).lines.join(' | ');
}

// ── A recording DOM node: `el()` needs createElement, textContent and append ──
class FakeEl {
  className = '';
  private _text = '';
  innerHTML = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  setAttribute(): void {
    /* no-op */
  }
  set textContent(v: string) {
    this._text = v;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids.filter(Boolean));
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids.filter(Boolean));
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
});

describe('a bounded resident set against a declared source total', () => {
  it('reports 3 M resident of a 90 M source as 3.33 % residency', () => {
    const r = streamingDetailReadout(declared(3_000_000, 90_000_000));
    expect(r.resident).toBe('Resident 3.0M points');
    expect(r.source).toBe('Source 90.0M points');
    expect(r.residency).toBe('Current residency 3.33%');
  });

  it('never states the whole source is held when it is not', () => {
    const text = shown(declared(3_000_000, 90_000_000));
    expect(text).not.toMatch(/100\s*%/);
    expect(text).not.toMatch(/loaded|loading|downloaded|complete/i);
  });

  it('reads 100 % only when the whole source is resident', () => {
    const r = streamingDetailReadout(declared(1_000_000, 1_000_000));
    expect(r.residency).toBe('Current residency 100%');
    expect(r.resident).toBe('Resident 1.0M points');
    expect(r.source).toBe('Source 1.0M points');
  });

  it('keeps a tiny non-zero residency visible rather than rounding it to nothing', () => {
    expect(streamingDetailReadout(declared(1, 100_000_000)).residency).toBe(
      'Current residency <0.01%',
    );
  });
});

describe('a source that declares no total', () => {
  it('states the resident count and that the source declares no total', () => {
    const r = streamingDetailReadout(undeclared(2_000_000));
    expect(r.resident).toBe('Resident 2.0M points');
    expect(r.source).toBe('Source total not declared by the source');
    expect(r.residency).toBeNull();
  });

  it('publishes no percentage at all, invented or otherwise', () => {
    expect(shown(undeclared(2_000_000))).not.toMatch(/%/);
  });

  it('treats a total that disagrees with its own known flag as undeclared', () => {
    // Either half of the pair saying "no total" is enough. A number arriving
    // with `sourcePointCountKnown: false` is a caller that has not established
    // it, and a `true` flag over a null total states nothing at all.
    expect(streamingDetailReadout({
      residentPointCount: 2_000_000,
      sourcePointCount: 90_000_000,
      sourcePointCountKnown: false,
    }).residency).toBeNull();
    expect(streamingDetailReadout({
      residentPointCount: 2_000_000,
      sourcePointCount: null,
      sourcePointCountKnown: true,
    }).residency).toBeNull();
  });

  it('offers no residency for an empty declared source rather than dividing by zero', () => {
    const r = streamingDetailReadout(declared(0, 0));
    expect(r.source).toBe('Source 0 points');
    expect(r.residency).toBeNull();
  });
});

describe('the rendered readout', () => {
  it('writes the three statements as text, never as markup', () => {
    const host = new FakeEl('div');
    renderStreamingDetail(host as unknown as HTMLElement, declared(3_000_000, 90_000_000));
    expect(host.textContent).toContain('Resident 3.0M points');
    expect(host.textContent).toContain('Source 90.0M points');
    expect(host.textContent).toContain('Current residency 3.33%');
    expect(host.innerHTML).toBe('');
  });

  it('clears a previous source total when the next source declares none', () => {
    // The replacement case: a 90 M COPC closes and a tileset that states no
    // total opens. Leaving the previous figure would attribute it to the scan
    // now on screen.
    const host = new FakeEl('div');
    renderStreamingDetail(host as unknown as HTMLElement, declared(3_000_000, 90_000_000));
    renderStreamingDetail(host as unknown as HTMLElement, undeclared(2_000_000));
    expect(host.textContent).toContain('Resident 2.0M points');
    expect(host.textContent).toContain('Source total not declared by the source');
    expect(host.textContent).not.toContain('90.0M');
    expect(host.textContent).not.toMatch(/%/);
  });
});

describe('a closed scan leaves no figure behind', () => {
  it('empties the readout when the Inspector leaves streaming layout', () => {
    const host = new FakeEl('div');
    renderStreamingDetail(host as unknown as HTMLElement, declared(3_000_000, 90_000_000));
    clearStreamingDetail(host as unknown as HTMLElement);
    expect(host.textContent).toBe('');
    expect(host.children.length).toBe(0);
  });
});

describe('residency and current-view readiness are different questions', () => {
  it('lets a 5 % resident source carry a settled current view', () => {
    // The scheduler wants 40 nodes for this camera and has all 40; the view is
    // settled. The source is 100 M points of which 5 M are resident. Both are
    // true at once, and neither figure is derived from the other.
    const readiness = evaluateRefinementReadiness({
      wantedCount: 40,
      residentCount: 40,
      inFlightCount: 0,
      queuedCount: 0,
      decodedPendingCount: 0,
      failedCount: 0,
    });
    const r = streamingDetailReadout(declared(5_000_000, 100_000_000));
    expect(readiness.phase).toBe('settled');
    expect(r.residency).toBe('Current residency 5%');
    expect(shown(declared(5_000_000, 100_000_000))).not.toMatch(/ready|view/i);
  });
});
