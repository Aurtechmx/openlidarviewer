/**
 * contourStudioWorkspaceClaim.test.ts
 *
 * The Contour Studio Claim line and the review summary's Evidence row render
 * the export permit's decision, not a reading of the launch status. One
 * resolver (`resolveWorkspaceClaim`) mints the words from the same permit the
 * complete package exports under, and both surfaces print them verbatim. Under
 * the real register no contour product resolves validated today
 * (`exportPermitRealRegistry.test.ts`), so the label an available launch
 * shows is "Exploratory", never "Supported".
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolveWorkspaceClaim } from '../src/export/workspaceClaim';
import { permitContextFor, resolveContourExportPermit, type ContourExportFrameFacts } from '../src/export/contourExportPermit';
import { buildContourReviewSummary } from '../src/terrain/contourStudio/contourReviewSummary';
import { baseContourStudioState } from '../src/terrain/contourStudio/contourStudioState';
import { renderContourStudioWorkspace } from '../src/ui/contourStudioWorkspace';
import { createContourStudioController } from '../src/terrain/contourStudio/contourStudioController';
import { ProcessService } from '../src/process/ProcessService';
import type { ScanFacts } from '../src/process/ProcessPlan';
import type { ContourStudioLaunchState } from '../src/terrain/contourStudio/contourStudioLaunchState';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import { knownUnit } from '../src/units/units';

class FakeEl {
  className = '';
  textContent = '';
  title = '';
  type = '';
  disabled = false;
  readonly children: FakeEl[] = [];
  readonly classList = { contains: (c: string): boolean => this.className.split(/\s+/).includes(c) };
  append(...kids: FakeEl[]): void { for (const k of kids) this.children.push(k); }
  replaceChildren(): void { this.children.length = 0; }
  setAttribute(): void {}
  addEventListener(): void {}
  byClass(c: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => { if (n.classList.contains(c)) out.push(n); n.children.forEach(walk); };
    walk(this); return out;
  }
  allText(): string { return this.children.reduce((t, c) => t + ' ' + c.allText(), this.textContent); }
}
beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = { createElement: () => new FakeEl() };
});

const AVAILABLE: ContourStudioLaunchState = {
  status: 'available', title: 't', message: 'm', visible: true, actionEnabled: true, actionLabel: 'Create Contour Deliverable',
};
const UNAVAILABLE: ContourStudioLaunchState = {
  status: 'unavailable', title: 't', message: 'm', reasons: ['No terrain surface.'], visible: true, actionEnabled: false,
};

function facts(): ScanFacts {
  return {
    kind: 'static', coverage: 'full',
    crs: { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1 } as ScanFacts['crs'],
    pointCount: 1_000_000, hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
    classification: 'full', classificationProvenance: 'producer', groundClassified: true, hasBuildingClass: false,
  };
}
const ready = { readiness: 'ready', reasonCode: 'GROUND_TRUSTED', reason: 'Trusted ground.' } as const;

function frame(launch: ContourStudioLaunchState): ContourExportFrameFacts {
  const svc = ProcessService.fromFacts([facts()]);
  return {
    launchStatus: launch.status,
    verticalUnitsKnown: true,
    crsProjected: true,
    blockedReasons: 'reasons' in launch ? launch.reasons : undefined,
    precision: null,
    capabilities: { contours: ready, dtm: ready },
    artifactClaimIds: { contours: ['CONTOURS', 'DTM'], dtm: ['DTM'] },
    authorizeFor: (product) => ({ product, token: svc.authorize(product), verify: (t, p) => svc.verifyAuthorization(t, p) }),
  };
}

const result = {
  cellStatusTally: { measured: 800, interpolated: 150, empty: 50, lowConfidence: 0, edgeRisk: 0, total: 1000 },
  gridRecommendation: { cellSizeM: 0.25, contourIntervalM: 0.5, cellOptionsM: [0.25], pointSpacingM: 0.2, reasons: [] },
  intervalM: 0.5, gate: { options: [], recommendedM: 0.5, warnings: [] }, validation: { rmse: 0.09 },
  contours: [], verticalScaleResolved: true,
} as unknown as AnalyseContoursResult;

describe('the workspace claim is the export permit', () => {
  it('maps the permit status to the one label the user reads, with its caveats', () => {
    const f = frame(AVAILABLE);
    const claim = resolveWorkspaceClaim(f);
    const permit = resolveContourExportPermit('complete-package', permitContextFor('complete-package', f, false));
    expect(permit.ok).toBe(true);
    if (!permit.ok) return;
    const expected = { validated: 'Supported (internal validation only)', exploratory: 'Exploratory' }[permit.decision.status];
    expect(claim.label).toBe(expected);
    expect(claim.rationale).toEqual(permit.decision.caveats);
    expect(claim.supported).toBe(permit.decision.status === 'validated');
  });

  it('under the real register an available launch reads Exploratory, not Supported', () => {
    // exportPermitRealRegistry.test.ts: `validated` is [] for every exporter.
    const claim = resolveWorkspaceClaim(frame(AVAILABLE));
    expect(claim.label).toBe('Exploratory');
    expect(claim.rationale.length).toBeGreaterThan(0);
  });

  it('a blocked launch reads Blocked with the refusal reasons', () => {
    const claim = resolveWorkspaceClaim(frame(UNAVAILABLE));
    expect(claim.label).toBe('Blocked');
    expect(claim.rationale).toContain('No terrain surface.');
  });

  it('the review Evidence row and the ladder Claim line print the same object', () => {
    const claim = resolveWorkspaceClaim(frame(AVAILABLE));
    const review = buildContourReviewSummary(result, {
      launch: AVAILABLE, state: baseContourStudioState(), verticalUnit: knownUnit(1), sourceUnitLabel: 'm', crsProjected: true, claim,
    });
    const evidence = review.rows.find((r) => r.key === 'evidence')!;
    expect(evidence.value).toBe(claim.label);
    expect(evidence.rationale).toEqual([...claim.rationale]);
    expect(evidence.confidence).toBe('low');

    const host = renderContourStudioWorkspace({ controller: createContourStudioController(), launch: AVAILABLE, review, claim }) as unknown as FakeEl;
    const line = host.byClass('olv-cs-ladder-claim')[0];
    expect(line.byClass('olv-cs-ladder-claim-value')[0].textContent).toBe(claim.label);
    expect(line.classList.contains('is-warn')).toBe(true);
    expect(line.allText()).not.toContain('Supported');
    for (const why of claim.rationale) expect(line.allText()).toContain(why);
  });
});
