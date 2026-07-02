/**
 * e57Pose.test.ts — pose-quaternion validation in the E57 schema reader.
 *
 * The rotation formula downstream assumes a UNIT quaternion: a non-unit one
 * silently scales the merged geometry and a zero one collapses it. readPose
 * therefore normalises finite non-unit quaternions (with a warning) and
 * substitutes the identity for degenerate ones (with a warning). Pinned here
 * against hand-written XML so the policy cannot regress silently.
 */

import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/io/e57/xml';
import { readE57Document } from '../src/io/e57/schema';

/** Minimal one-scan document with the given <pose> block (or none). */
function docWith(poseXml: string): string {
  return (
    '<e57Root type="Structure">' +
    '<data3D type="Vector"><vectorChild type="Structure">' +
    '<name type="String">roof</name>' +
    poseXml +
    '<points type="CompressedVector" recordCount="1" fileOffset="0">' +
    '<prototype><cartesianX type="Float" precision="single"/></prototype>' +
    '</points>' +
    '</vectorChild></data3D></e57Root>'
  );
}

function poseXml(w: number, x: number, y: number, z: number): string {
  return (
    '<pose type="Structure">' +
    `<rotation type="Structure"><w type="Float">${w}</w><x type="Float">${x}</x>` +
    `<y type="Float">${y}</y><z type="Float">${z}</z></rotation>` +
    '<translation type="Structure"><x type="Float">1</x><y type="Float">2</y>' +
    '<z type="Float">3</z></translation>' +
    '</pose>'
  );
}

describe('readPose — quaternion validation policy', () => {
  it('accepts a unit quaternion untouched, with no warning', () => {
    const doc = readE57Document(parseXml(docWith(poseXml(1, 0, 0, 0))));
    expect(doc.scans[0].pose?.rotation).toEqual([1, 0, 0, 0]);
    expect(doc.warnings).toEqual([]);
  });

  it('normalises a non-unit quaternion and records a warning naming the scan', () => {
    // [2, 0, 0, 0]: norm 2, direction = identity → normalised to [1, 0, 0, 0].
    const doc = readE57Document(parseXml(docWith(poseXml(2, 0, 0, 0))));
    expect(doc.scans[0].pose?.rotation).toEqual([1, 0, 0, 0]);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/"roof"/);
    expect(doc.warnings[0]).toMatch(/norm 2\.000000/);
    expect(doc.warnings[0]).toMatch(/normalised/);
  });

  it('normalises a rotated non-unit quaternion preserving its direction', () => {
    // [0, 0, 0, 2]: a 180° yaw written at twice unit length → [0, 0, 0, 1].
    const doc = readE57Document(parseXml(docWith(poseXml(0, 0, 0, 2))));
    expect(doc.scans[0].pose?.rotation).toEqual([0, 0, 0, 1]);
    expect(doc.warnings).toHaveLength(1);
  });

  it('substitutes the identity for a zero quaternion, with a warning', () => {
    const doc = readE57Document(parseXml(docWith(poseXml(0, 0, 0, 0))));
    expect(doc.scans[0].pose?.rotation).toEqual([1, 0, 0, 0]);
    // Translation survives — only the rotation was unusable.
    expect(doc.scans[0].pose?.translation).toEqual([1, 2, 3]);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/"roof"/);
    expect(doc.warnings[0]).toMatch(/degenerate/);
    expect(doc.warnings[0]).toMatch(/identity/);
  });

  it('emits no warnings for a scan without a pose', () => {
    const doc = readE57Document(parseXml(docWith('')));
    expect(doc.scans[0].pose).toBeNull();
    expect(doc.warnings).toEqual([]);
  });
});
