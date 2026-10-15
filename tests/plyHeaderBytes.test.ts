import { loadPly, plyParseInput } from '../src/io/loadPly';

/**
 * A binary PLY body starts at the byte after `end_header` and its line break.
 * A CRLF header or a UTF-8 comment makes that byte offset differ from the
 * header's character count; both must still decode to the written values.
 */

const POINTS: Array<[number, number, number]> = [
  [500123.456, 4100876.789, 210.123],
  [500124.5, 4100877.25, 211.0],
];

function binaryPly(nl: string, comment: string, type: 'double' | 'float'): ArrayBuffer {
  const header =
    [
      'ply',
      'format binary_little_endian 1.0',
      `comment ${comment}`,
      `element vertex ${POINTS.length}`,
      `property ${type} x`,
      `property ${type} y`,
      `property ${type} z`,
      'end_header',
    ].join(nl) + nl;
  const head = new TextEncoder().encode(header);
  const width = type === 'double' ? 8 : 4;
  const buf = new ArrayBuffer(head.length + POINTS.length * 3 * width);
  new Uint8Array(buf).set(head);
  const view = new DataView(buf, head.length);
  POINTS.flat().forEach((v, i) => {
    if (width === 8) view.setFloat64(i * 8, v, true);
    else view.setFloat32(i * 4, v, true);
  });
  return buf;
}

const CASES: Array<[string, string, string, 'double' | 'float']> = [
  ['CRLF', '\r\n', 'plain', 'double'],
  ['UTF-8 comment', '\n', 'Généré — été', 'double'],
  ['CRLF + UTF-8 comment', '\r\n', 'Généré — été', 'double'],
  ['CRLF', '\r\n', 'plain', 'float'],
  ['UTF-8 comment', '\n', 'Généré — été', 'float'],
];

describe('loadPly: binary body offset is measured in bytes', () => {
  test.each(CASES)('%s header, %s… %s body decodes to the written points', async (_label, nl, comment, type) => {
    const pc = await loadPly(binaryPly(nl, comment, type));
    expect(pc.pointCount).toBe(POINTS.length);
    // float32 storage of a UTM coordinate is only good to ~0.25 m.
    const tol = type === 'double' ? 2e-5 : 0.5;
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < POINTS.length; i++) {
      pc.worldXYZ(i, out);
      for (let a = 0; a < 3; a++) expect(Math.abs(out[a] - POINTS[i][a])).toBeLessThanOrEqual(tol);
    }
  });

  test('a plain LF ASCII header is handed to the parser unchanged', () => {
    const buf = binaryPly('\n', 'plain', 'double');
    const before = new Uint8Array(buf.slice(0));
    const input = plyParseInput(buf);
    expect(input.buffer).toBe(buf);
    expect(new Uint8Array(input.buffer)).toEqual(before);
  });

  test('a CRLF / UTF-8 header is rewritten as ASCII LF ahead of the original body bytes', () => {
    const buf = binaryPly('\r\n', 'Généré', 'double');
    const input = plyParseInput(buf);
    const bytes = new Uint8Array(input.buffer);
    const bodyOffset = input.bodyOffset ?? -1;
    expect(bodyOffset).toBeGreaterThan(0);
    const headerText = new TextDecoder('latin1').decode(bytes.subarray(0, bodyOffset));
    expect(headerText).not.toMatch(/\r|[^\x00-\x7f]/);
    expect(headerText.endsWith('end_header\n')).toBe(true);
    const src = new Uint8Array(buf);
    const bodyLen = POINTS.length * 3 * 8;
    expect(bytes.subarray(bodyOffset)).toEqual(src.subarray(src.length - bodyLen));
  });
});

describe('loadPly: count plausibility has no gaps', () => {
  const enc = new TextEncoder();

  test('refuses an element with a count but no properties', async () => {
    const head = 'ply\nformat binary_little_endian 1.0\nelement vertex 1000000000000000\nend_header\n';
    await expect(loadPly(enc.encode(head).buffer as ArrayBuffer)).rejects.toThrow(/no properties/);
  });

  test('refuses a header that runs past the probe window', async () => {
    const pad = Array.from({ length: 2000 }, () => 'comment ' + 'x'.repeat(40)).join('\n');
    const head = `ply\nformat binary_little_endian 1.0\n${pad}\nelement vertex 1000000000\nproperty double x\nproperty double y\nproperty double z\nend_header\n`;
    expect(head.length).toBeGreaterThan(65536);
    await expect(loadPly(enc.encode(head).buffer as ArrayBuffer)).rejects.toThrow(/header/);
  });
});
