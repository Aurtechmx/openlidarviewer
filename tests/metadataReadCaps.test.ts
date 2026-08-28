/**
 * metadataReadCaps.test.ts
 *
 * Report and workflow files are read whole into a single string with
 * `file.text()`. Unlike `.olvsession` (capped at 256 MB), those reads were
 * uncapped, so a mistaken or hostile multi-hundred-MB file could exhaust memory
 * before the parser rejected it. Both now refuse an over-ceiling file up front.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_REPORT_TEXT_BYTES,
  oversizeReportResult,
} from '../src/ui/reportVerifier';
import {
  MAX_WORKFLOW_TEXT_BYTES,
  assertWorkflowFileSize,
} from '../src/ui/WorkflowController';

describe('report verifier read cap', () => {
  it('caps the read in the tens of megabytes', () => {
    expect(MAX_REPORT_TEXT_BYTES).toBe(32 * 1024 * 1024);
  });

  it('refuses an over-ceiling file with a recognised:false result', () => {
    const result = oversizeReportResult(MAX_REPORT_TEXT_BYTES + 1);
    expect(result).toBeDefined();
    expect(result?.recognised).toBe(false);
    expect(result?.valid).toBe(false);
    expect(result?.reason).toMatch(/too large/i);
  });

  it('passes a file at or under the ceiling', () => {
    expect(oversizeReportResult(MAX_REPORT_TEXT_BYTES)).toBeUndefined();
    expect(oversizeReportResult(1_000)).toBeUndefined();
  });
});

describe('workflow read cap', () => {
  it('caps the read in the tens of megabytes', () => {
    expect(MAX_WORKFLOW_TEXT_BYTES).toBe(32 * 1024 * 1024);
  });

  it('throws on an over-ceiling file', () => {
    expect(() => assertWorkflowFileSize(MAX_WORKFLOW_TEXT_BYTES + 1)).toThrow(/too large/i);
  });

  it('accepts a file at or under the ceiling', () => {
    expect(() => assertWorkflowFileSize(MAX_WORKFLOW_TEXT_BYTES)).not.toThrow();
    expect(() => assertWorkflowFileSize(1_000)).not.toThrow();
  });
});
