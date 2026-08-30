import { describe, it, expect } from 'vitest';
import {
  severityAriaLabel,
  severityText,
  SEVERITY_LABEL,
} from '../src/ui/issueSeverityStyle';
import type { IssueSeverity } from '../src/render/annotate/issueWorkflow';

/**
 * tests/issueSeverityStyle.test.ts
 *
 * The module's job is one canonical presentation of the four ranks. The
 * accessible name must use the same capitalised word the sighted label shows,
 * not the raw lowercase enum.
 */
const RANKS: readonly IssueSeverity[] = ['low', 'medium', 'high', 'critical'];

describe('severityAriaLabel', () => {
  it('uses the capitalised label, not the raw enum', () => {
    expect(severityAriaLabel('high')).toBe('Severity: High');
    expect(severityAriaLabel('low')).toBe('Severity: Low');
  });

  it('matches the word shown in the visible severityText for every rank', () => {
    for (const r of RANKS) {
      expect(severityAriaLabel(r)).toBe(`Severity: ${SEVERITY_LABEL[r]}`);
      expect(severityText(r).endsWith(SEVERITY_LABEL[r])).toBe(true);
    }
  });
});
