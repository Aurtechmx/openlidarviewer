/**
 * A text export writes the points the viewer HOLDS, which is not always the
 * points the file HAD. A budget cap or a load stride leaves the cloud holding
 * a fraction of the source, and the written file looks exactly like a complete
 * export of a smaller scan — same name, same shape, no way to tell.
 *
 * The module contract already says a dropped CHANNEL must be disclosed. Dropped
 * POINTS fell through that rule: a real 46.8 M-point scan exported as 5.8 M
 * rows with no header at all. These tests pin the general behaviour — every
 * text format that has a comment convention, on any cloud whose declared count
 * exceeds what it holds.
 */
import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { toXyz, toPly, toObj, toCsv } from '../src/io/exporters';

/** A cloud holding `held` points that declares `declared` came from the file. */
function sampledCloud(held: number, declared?: number, loadStride?: number): PointCloud {
  const positions = new Float32Array(held * 3);
  for (let i = 0; i < held; i++) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = i * 2;
    positions[i * 3 + 2] = i * 3;
  }
  return new PointCloud({
    positions,
    origin: [0, 0, 0],
    sourceFormat: 'xyz',
    name: 'sample',
    ...(declared === undefined ? {} : { declaredPointCount: declared }),
    ...(loadStride === undefined ? {} : { loadStride }),
  });
}

/** The `#`/`comment` lines a writer emitted, without their marker. */
function commentLines(text: string, marker: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith(marker))
    .map((l) => l.slice(marker.length).trim());
}

describe('subset disclosure in text exports', () => {
  it('states the held/declared split when the cloud is a sample', () => {
    const text = toXyz(sampledCloud(250, 1000, 4));
    const notes = commentLines(text, '#');
    const subset = notes.find((l) => /subset|sample/i.test(l));
    expect(subset).toBeDefined();
    // Both counts must be legible — a bare "this is a subset" leaves the
    // reader unable to judge how much is missing.
    expect(subset).toContain('250');
    expect(subset).toContain('1,000');
    // The rows written must match the held count, not the declared one.
    expect(text.split('\n').filter((l) => l && !l.startsWith('#')).length).toBe(250);
  });

  it('names the load stride when one caused the subset', () => {
    const notes = commentLines(toXyz(sampledCloud(250, 1000, 4)), '#');
    expect(notes.some((l) => /stride/i.test(l) && l.includes('4'))).toBe(true);
  });

  it('says nothing when the cloud holds every declared point', () => {
    const notes = commentLines(toXyz(sampledCloud(1000, 1000)), '#');
    expect(notes.some((l) => /subset|sample|stride/i.test(l))).toBe(false);
  });

  it('says nothing when the file declared no count', () => {
    const notes = commentLines(toXyz(sampledCloud(250)), '#');
    expect(notes.some((l) => /subset|sample|stride/i.test(l))).toBe(false);
  });

  it('never claims a subset when the cloud holds MORE than declared', () => {
    // A merged or densified cloud is not a subset; a naive `held < declared`
    // inversion would mislabel it.
    const notes = commentLines(toXyz(sampledCloud(1200, 1000)), '#');
    expect(notes.some((l) => /subset|sample/i.test(l))).toBe(false);
  });

  it('discloses through each format\'s own comment convention', () => {
    const cloud = sampledCloud(250, 1000, 4);
    expect(commentLines(toPly(cloud), 'comment').some((l) => /subset|sample/i.test(l))).toBe(true);
    expect(commentLines(toObj(cloud), '#').some((l) => /subset|sample/i.test(l))).toBe(true);
  });

  it('leaves CSV pure data, as the module contract requires', () => {
    const csv = toCsv(sampledCloud(250, 1000, 4));
    expect(csv.startsWith('x,y,z')).toBe(true);
    expect(csv).not.toMatch(/subset|sample/i);
  });
});

describe('a streaming resident snapshot discloses its scope', () => {
  it('states resident-of-source through the comment channel', () => {
    // A streaming export IS the resident set — the snapshot is internally
    // consistent (declared == held, so the Health Check stays quiet), and the
    // source's own declared total rides a dedicated field so the written file
    // still says what fraction of the SCAN it carries.
    const positions = new Float32Array(300 * 3);
    const c = new PointCloud({
      positions,
      origin: [0, 0, 0],
      sourceFormat: 'laz',
      name: 'stream-snap',
      declaredPointCount: 300,
      decodedPointCount: 300,
      sourceDeclaredPointCount: 46_000_000,
    });
    const notes = toXyz(c).split('\n').filter((l) => l.startsWith('#'));
    const subset = notes.find((l) => /resident|streamed/i.test(l));
    expect(subset).toBeDefined();
    expect(subset).toContain('300');
    expect(subset).toContain('46,000,000');
    expect(subset).not.toMatch(/load stride/);
  });

  it('stays silent when the source total is unknown', () => {
    const c = new PointCloud({
      positions: new Float32Array(9),
      origin: [0, 0, 0],
      sourceFormat: 'laz',
      name: 's',
      declaredPointCount: 3,
    });
    expect(toXyz(c)).not.toMatch(/resident|streamed/i);
  });
});
