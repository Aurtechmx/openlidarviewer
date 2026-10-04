/**
 * classFilterAfterEdit.test.ts
 *
 * The class-visibility filter reads the per-point `aClass` GPU attribute, a
 * float copy of the codes made at load. A swap, a reclassify, an Undo and a
 * Redo must refresh that copy, or hiding the new class leaves the edited
 * points drawn. The shipped Viewer methods run against a fake `this` that
 * holds one real geometry.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Viewer } from '../src/render/Viewer';
import { PointCloud } from '../src/model/PointCloud';

const CODES = [2, 2, 2, 5, 6, 1];

function setup() {
  const cloud = new PointCloud({
    positions: new Float32Array(CODES.length * 3).map((_, i) => i),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'tile.las',
    classification: Uint8Array.from(CODES),
  });
  const geometry = new THREE.BufferGeometry();
  const aClass = new THREE.InstancedBufferAttribute(Float32Array.from(CODES), 1);
  geometry.setAttribute('aClass', aClass);
  const entry = {
    cloud,
    mesh: { geometry },
    material: {},
    colorAttr: { array: new Float32Array(CODES.length * 3), needsUpdate: false },
    mode: 'classification',
  };
  const v = Object.assign(Object.create(Viewer.prototype) as object, {
    _clouds: new Map([['a', entry]]),
    _classHistory: new Map(),
    _classEpochs: { bump: () => {} },
    _demand: { changed: () => {} },
    _materialsWithClass: new Set(),
    _applySizeMode: () => {},
  }) as unknown as Viewer;
  const gpu = () => [...(geometry.getAttribute('aClass').array as Float32Array)];
  return { v, cloud, aClass, gpu };
}

describe('GPU class filter after a classification edit', () => {
  it('swap, reclassify, undo and redo all refresh aClass', () => {
    const { v, cloud, aClass, gpu } = setup();

    const v0 = aClass.version;
    v.swapClassification('a', 2, 6);
    expect(gpu()).toEqual([6, 6, 6, 5, 6, 1]);
    expect(aClass.version).toBeGreaterThan(v0);

    v.editClassification('a', (buf) => { buf[3] = 9; });
    expect(gpu()).toEqual([6, 6, 6, 9, 6, 1]);

    expect(v.undoClassification('a')).toBe(true);
    expect(gpu()).toEqual([6, 6, 6, 5, 6, 1]);

    expect(v.undoClassification('a')).toBe(true);
    expect(gpu()).toEqual(CODES);

    expect(v.redoClassification('a')).toBe(true);
    expect(gpu()).toEqual([6, 6, 6, 5, 6, 1]);
    expect(gpu()).toEqual([...cloud.classification!]);
  });
});
