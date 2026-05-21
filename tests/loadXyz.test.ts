import { loadXyz } from '../src/io/loadXyz';

/** Encode a string to a tight ArrayBuffer for the loader. */
function xyzBuffer(text: string): ArrayBuffer {
  const u = new TextEncoder().encode(text);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

test('parses whitespace-delimited x y z lines', async () => {
  const cloud = await loadXyz(xyzBuffer('0 0 0\n1 2 3\n4 5 6\n'));
  expect(cloud.pointCount).toBe(3);
  expect(cloud.sourceFormat).toBe('xyz');
  expect(cloud.colors).toBeUndefined();
});

test('parses comma-delimited lines', async () => {
  const cloud = await loadXyz(xyzBuffer('0,0,0\n10,20,30\n'));
  expect(cloud.pointCount).toBe(2);
});

test('skips comment lines and a non-numeric header row', async () => {
  const cloud = await loadXyz(xyzBuffer('x,y,z\n# a comment\n0,0,0\n1,1,1\n'));
  expect(cloud.pointCount).toBe(2);
});

test('reads six-column files as positions plus 0-255 colour', async () => {
  const cloud = await loadXyz(xyzBuffer('0 0 0 255 128 0\n1 1 1 0 64 255\n'));
  expect(cloud.pointCount).toBe(2);
  expect(cloud.colors).toBeDefined();
  expect(Array.from(cloud.colors!.slice(0, 6))).toEqual([255, 128, 0, 0, 64, 255]);
});

test('scales 0-1 float colour up to 0-255', async () => {
  const cloud = await loadXyz(xyzBuffer('0 0 0 1 0.5 0\n'));
  expect(cloud.colors?.[0]).toBe(255);
  expect(cloud.colors?.[1]).toBe(128);
  expect(cloud.colors?.[2]).toBe(0);
});

test('recentres large survey coordinates via the coordinate bridge', async () => {
  const cloud = await loadXyz(xyzBuffer('500100 4100200 50\n500101 4100201 51\n'));
  expect(cloud.origin).toEqual([500100, 4100200, 50]);
  // First point sits at the origin → local (0,0,0).
  expect(cloud.positions[0]).toBeCloseTo(0, 4);
  expect(cloud.positions[1]).toBeCloseTo(0, 4);
  expect(cloud.positions[2]).toBeCloseTo(0, 4);
  expect(cloud.positions[3]).toBeCloseTo(1, 4);
});

test('records the decoded point count', async () => {
  const cloud = await loadXyz(xyzBuffer('0 0 0\n1 1 1\n2 2 2\n'));
  expect(cloud.decodedPointCount).toBe(3);
});

test('throws on a file with no readable points', async () => {
  await expect(loadXyz(xyzBuffer('# nothing here\n\n'))).rejects.toThrow();
});
