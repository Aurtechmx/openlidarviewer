/**
 * Every session save says what the file holds and that the scan is not in it.
 * When the open scan carries class edits the toast also says they are not
 * stored, because a session file keeps the class filter and not per-point
 * classes, and points to the LAS export that keeps them.
 */
import { describe, it, expect } from 'vitest';
import { SESSION_CLASS_EDITS_NOT_STORED, sessionSavedNotice } from '../src/export/exportScanIdentity';
import { classificationDiffersFromSource } from '../src/export/fullResClassGuard';

const work = { measurements: 2, annotations: 1, views: 3 };

describe('session saved notice', () => {
  it('states the counts and that the file holds no points', () => {
    expect(sessionSavedNotice(work, false)).toBe(
      'Session saved: 2 measurements, 1 annotation, 3 saved views. It holds no points; open it with the same scan file.',
    );
    expect(sessionSavedNotice({ measurements: 0, annotations: 0, views: 1 }, false)).toMatch(/^Session saved: 0 measurements, 0 annotations, 1 saved view\./);
  });

  it('adds the class-edit warning, and points to a LAS export, when the scan has class edits', () => {
    const edited = classificationDiffersFromSource('source', 1);
    const text = sessionSavedNotice(work, edited);
    expect(text.startsWith('Session saved: 2 measurements')).toBe(true);
    expect(text.endsWith(SESSION_CLASS_EDITS_NOT_STORED)).toBe(true);
    expect(SESSION_CLASS_EDITS_NOT_STORED).toMatch(/not stored in the session/);
    expect(SESSION_CLASS_EDITS_NOT_STORED).toMatch(/export the scan as LAS/);
  });

  it('leaves the warning off for an unedited scan', () => {
    expect(sessionSavedNotice(work, classificationDiffersFromSource('source', 0))).not.toContain('Class edits');
    expect(sessionSavedNotice(work, classificationDiffersFromSource('none', 0))).not.toContain('Class edits');
  });
});
