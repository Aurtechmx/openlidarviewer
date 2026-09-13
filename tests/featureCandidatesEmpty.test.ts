/**
 * featureCandidatesEmpty.test.ts
 *
 * A scan that carries a classification but no building- or wire-classified
 * points has nothing for the feature launcher to propose. It used to render
 * the card anyway, with a line saying so; now it renders nothing, and the
 * card appears once the scan has something to offer.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  className = '';
  textContent = '';
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void {}
  get classList() {
    return { add: () => {}, remove: () => {}, toggle: () => false, contains: () => false };
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

function cloudWith(codes: number[]) {
  const positions = new Float32Array(codes.length * 3);
  for (let i = 0; i < codes.length; i++) { positions[i * 3] = i; positions[i * 3 + 1] = i * 2; positions[i * 3 + 2] = 5; }
  return {
    positions,
    classification: new Uint8Array(codes),
    classificationIsDerived: false,
    derivedClassificationFrameInvalid: false,
    sourceFormat: 'las',
    metadata: {},
  };
}

async function mount(codes: number[]) {
  const { mountFeatureCandidates } = await import('../src/ui/featureCandidatesMount');
  const launcherHost = new FakeEl('div');
  const reviewHost = new FakeEl('div');
  mountFeatureCandidates({
    cloud: cloudWith(codes) as never,
    unitToMetres: 1,
    crsLabel: null,
    upAxis: 'z' as never,
    toLonLat: null,
    launcherHost: launcherHost as unknown as HTMLElement,
    reviewHost: reviewHost as unknown as HTMLElement,
    onLaunch: () => {},
  } as never);
  return launcherHost;
}

describe('mountFeatureCandidates with nothing to propose', () => {
  it('renders no card when the classification holds no class 6 or 14', async () => {
    const host = await mount([2, 2, 3, 5, 1, 2]);
    expect(host.children).toHaveLength(0);
  });

  it('renders the card once building-classified points exist', async () => {
    const host = await mount([2, 6, 6, 6, 2, 6]);
    expect(host.children).toHaveLength(1);
    expect(host.children[0].className).toBe('olv-feature-launcher');
  });
});
