/**
 * Save session warns when the open scan carries class edits, because a
 * session file stores the class filter and not per-point classes.
 */
import { describe, it, expect } from 'vitest';
import { SESSION_CLASS_EDITS_NOT_STORED, sessionSaveNotice } from '../src/export/exportScanIdentity';
import { classificationDiffersFromSource } from '../src/export/fullResClassGuard';

describe('session save notice for class edits', () => {
  it('warns, and points to a LAS export, when the scan has class edits', () => {
    const edited = classificationDiffersFromSource('source', 1);
    expect(sessionSaveNotice(edited)).toBe(SESSION_CLASS_EDITS_NOT_STORED);
    expect(SESSION_CLASS_EDITS_NOT_STORED).toMatch(/not stored in the session/);
    expect(SESSION_CLASS_EDITS_NOT_STORED).toMatch(/export the scan as LAS/);
  });

  it('says nothing for an unedited scan', () => {
    expect(sessionSaveNotice(classificationDiffersFromSource('source', 0))).toBeNull();
    expect(sessionSaveNotice(classificationDiffersFromSource('none', 0))).toBeNull();
  });
});
