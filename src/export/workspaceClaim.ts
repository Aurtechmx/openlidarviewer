/**
 * workspaceClaim.ts — the Contour Studio "Claim" line, minted from the permit.
 *
 * The review summary's Evidence row and the workspace ladder's Claim line used
 * to derive "Supported / Exploratory / Blocked" from the launch status alone,
 * consulting neither the registry nor the capability verdict. Both now render
 * this object, minted from the same permit the complete package exports under,
 * so the interface says what the file says.
 */

import { permitContextFor, resolveContourExportPermit, type ContourExportFrameFacts } from './contourExportPermit';

export interface WorkspaceClaim {
  /** The words the user reads. */
  readonly label: 'Supported (internal validation only)' | 'Exploratory' | 'Blocked';
  readonly state: 'met' | 'warn' | 'blocked';
  /** The permit's caveats or refusal reasons, verbatim. */
  readonly rationale: readonly string[];
  readonly supported: boolean;
}

export function resolveWorkspaceClaim(frame: ContourExportFrameFacts): WorkspaceClaim {
  const permit = resolveContourExportPermit('complete-package', permitContextFor('complete-package', frame, false));
  if (!permit.ok) return { label: 'Blocked', state: 'blocked', rationale: permit.reasons, supported: false };
  if (permit.decision.status === 'validated') {
    return { label: 'Supported (internal validation only)', state: 'met', rationale: permit.decision.caveats, supported: true };
  }
  return { label: 'Exploratory', state: 'warn', rationale: permit.decision.caveats, supported: false };
}
