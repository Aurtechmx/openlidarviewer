/**
 * The UI's "supported formats" copy is GENERATED from these registries —
 * these tests are what stops the registries drifting from the sniffer's
 * actual behaviour (the hand-typed splash line once said 10 formats beside
 * an 11-format sniffer and silently omitted .xyz).
 */
import { describe, it, expect } from 'vitest';
import {
  SOURCE_FORMATS,
  XYZ_ALIAS_EXTENSIONS,
  sniffFormat,
} from '../src/io/sniffFormat';

const NO_MAGIC = new ArrayBuffer(0);

describe('format registries match the sniffer', () => {
  it('every listed format extension sniffs to itself', () => {
    for (const f of SOURCE_FORMATS) {
      expect(sniffFormat(NO_MAGIC, `scan.${f}`)).toBe(f);
    }
  });

  it('every xyz alias extension sniffs to the xyz family', () => {
    for (const ext of XYZ_ALIAS_EXTENSIONS) {
      expect(sniffFormat(NO_MAGIC, `points.${ext}`)).toBe('xyz');
    }
  });

  it('aliases are not counted as formats', () => {
    for (const ext of XYZ_ALIAS_EXTENSIONS) {
      expect((SOURCE_FORMATS as readonly string[]).includes(ext)).toBe(false);
    }
  });
});
