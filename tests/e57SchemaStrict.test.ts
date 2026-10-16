/**
 * e57SchemaStrict.test.ts — malformed-schema hardening for the E57 reader.
 *
 * Two defects from the fourth audit pass:
 *   1. bitWidthFor() looped `while (2 ** bits <= range)` with no finite guard —
 *      two individually-finite bounds whose difference overflows to Infinity
 *      (min=-1e308, max=1e308) made it spin forever, hanging the main thread on
 *      a hostile file.
 *   2. Geometry/schema numbers (min/max, scale/offset, pose translation) used a
 *      silent fallback: a malformed value became 0/1 with no warning, decoding
 *      into a plausible but wrong coordinate. They now throw.
 *
 * These build the minimal e57 XML the schema reader consumes and assert the
 * reader rejects the bad file promptly instead of hanging or silently
 * defaulting. The valid-file path is covered by the real-fixture e57.test.ts.
 */

import { describe, expect, test } from 'vitest';
import { parseXml } from '../src/io/e57/xml';
import { readE57Document } from '../src/io/e57/schema';

/** Wrap a prototype field list in the smallest data3D scan the reader accepts. */
function docWithField(field: string): string {
  return `<e57Root>
    <data3D>
      <vectorChild type="Structure">
        <name>Scan</name>
        <points type="CompressedVector" recordCount="10" fileOffset="0">
          <prototype type="Structure">
            ${field}
          </prototype>
        </points>
      </vectorChild>
    </data3D>
  </e57Root>`;
}

function read(xml: string): ReturnType<typeof readE57Document> {
  return readE57Document(parseXml(xml));
}

describe('E57 schema — malformed bounds no longer hang', () => {
  test('an integer field whose bounds overflow to an Infinity range is rejected, not looped', () => {
    // Pre-fix: range = 1e308 − (−1e308) = Infinity, and `2**bits <= Infinity`
    // never goes false → infinite loop. The strict reader now rejects the
    // non-integer bound first; either way the call must RETURN (throw), not hang.
    const xml = docWithField(
      '<cartesianX type="Integer" minimum="-1e308" maximum="1e308"/>',
    );
    expect(() => read(xml)).toThrow(/E57/);
  });

  test('an integer bound beyond the safe-integer range is rejected', () => {
    const xml = docWithField('<cartesianX type="Integer" minimum="0" maximum="1e16"/>');
    expect(() => read(xml)).toThrow(/non-integer|safe-integer/i);
  });

  test('a non-numeric integer maximum is rejected instead of collapsing to 0', () => {
    const xml = docWithField('<cartesianX type="Integer" minimum="0" maximum="garbage"/>');
    expect(() => read(xml)).toThrow(/non-finite|non-integer/i);
  });

  test('a non-finite ScaledInteger scale is rejected instead of defaulting to 1', () => {
    const xml = docWithField(
      '<cartesianX type="ScaledInteger" minimum="0" maximum="1023" scale="nonsense" offset="0"/>',
    );
    expect(() => read(xml)).toThrow(/non-finite/i);
  });

  test('a valid integer field parses to the expected bit width', () => {
    const xml = docWithField('<cartesianX type="Integer" minimum="0" maximum="255"/>');
    const doc = read(xml);
    expect(doc.scans[0].prototype[0]).toMatchObject({ type: 'integer', bitWidth: 8 });
  });
});

describe('E57 schema — malformed pose translation no longer silently misplaces', () => {
  test('a non-finite translation component is rejected instead of becoming 0', () => {
    const xml = `<e57Root>
      <data3D>
        <vectorChild type="Structure">
          <name>Scan</name>
          <pose>
            <translation><x>bad</x><y>0</y><z>0</z></translation>
          </pose>
          <points type="CompressedVector" recordCount="10" fileOffset="0">
            <prototype type="Structure">
              <cartesianX type="Integer" minimum="0" maximum="255"/>
            </prototype>
          </points>
        </vectorChild>
      </data3D>
    </e57Root>`;
    expect(() => read(xml)).toThrow(/translation.*non-finite|non-finite.*translation/i);
  });

  test('a valid pose translation round-trips', () => {
    const xml = `<e57Root>
      <data3D>
        <vectorChild type="Structure">
          <name>Scan</name>
          <pose>
            <translation><x>100.5</x><y>-200</y><z>3</z></translation>
          </pose>
          <points type="CompressedVector" recordCount="10" fileOffset="0">
            <prototype type="Structure">
              <cartesianX type="Integer" minimum="0" maximum="255"/>
            </prototype>
          </points>
        </vectorChild>
      </data3D>
    </e57Root>`;
    expect(read(xml).scans[0].pose?.translation).toEqual([100.5, -200, 3]);
  });
});

describe('E57 schema — absent Integer bounds take the ASTM E2807 int64 defaults', () => {
  test('an Integer field with no minimum/maximum is refused, not packed in 0 bits', () => {
    // Defaulting both to 0 packed the field in 0 bits and decoded every value
    // as 0. The spec defaults are -2^63 and 2^63-1, a range this reader cannot
    // decode exactly, so the file is refused with a message.
    const xml = docWithField('<intensity type="Integer"/>');
    expect(() => read(xml)).toThrow(/declares no minimum or maximum/);
  });

  test('a ScaledInteger field missing only its maximum is refused', () => {
    const xml = docWithField('<cartesianX type="ScaledInteger" minimum="0" scale="0.001"/>');
    expect(() => read(xml)).toThrow(/declares no maximum/);
  });

  test('declared bounds still size the field', () => {
    const doc = read(docWithField('<intensity type="Integer" minimum="-1024" maximum="1023"/>'));
    const f = doc.scans[0]!.prototype.find((p) => p.name === 'intensity')!;
    expect(f.minimum).toBe(-1024);
    expect(f.maximum).toBe(1023);
    expect(f.bitWidth).toBe(11);
  });
});
