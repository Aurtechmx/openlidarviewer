/**
 * A findings report is built from the scan the findings were measured on, even
 * when the active scan changes while the export chunk is still loading.
 */
import { describe, it, expect } from 'vitest';
import { collectForOpenScan, findingsScanOpen, runFindingsExport } from '../src/export/exportScanIdentity';
import type { MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import type { ReportFinding } from '../src/render/measure/reportManifest';

type Actions = Parameters<typeof runFindingsExport>[0] extends () => Promise<infer A> ? A : never;

function setup() {
  let active = 'scan-A';
  const scan = { 'scan-A': { name: 'A.laz', epoch: 1, crsKnown: true }, 'scan-B': { name: 'B.laz', epoch: 7, crsKnown: false } } as const;
  const measure = {
    getMeasurements: () => [],
    worldUp: [0, 0, 1],
    unitToMetres: 1,
    verticalUnitToMetres: 1,
    get crsKnown() { return scan[active as 'scan-A'].crsKnown; },
    get geographicCrs() { return false; },
  };
  const deps = {
    measure,
    geo: () => ({ name: scan[active as 'scan-A'].name }),
    activeClassificationEpoch: () => scan[active as 'scan-A'].epoch,
  } as unknown as MeasurementExportActionDeps;
  let release!: () => void;
  const seen: { name?: string | null; epoch?: number; crsKnown?: boolean; findings?: readonly ReportFinding[] } = {};
  const actions = {
    exportFindingsReport: async (d: MeasurementExportActionDeps, f: readonly ReportFinding[]) => {
      seen.name = d.geo().name;
      seen.epoch = d.activeClassificationEpoch();
      seen.crsKnown = d.measure.crsKnown;
      seen.findings = f;
    },
  } as unknown as Actions;
  const load = () => new Promise<Actions>((r) => { release = () => r(actions); });
  return { deps, load, seen, switchTo: (id: string) => { active = id; }, current: () => active, release: () => release() };
}

const findings: ReportFinding[] = [{ label: 'on A', value: 1, unit: 'm' }];

describe('runFindingsExport', () => {
  it('refuses when the scan changes while the export chunk loads', async () => {
    const s = setup();
    const run = runFindingsExport(s.load, s.deps, findings, () => s.current() === 'scan-A');
    s.switchTo('scan-B');
    s.release();
    expect(await run).toBe('stale');
    expect(s.seen.name).toBeUndefined();
  });

  it('builds the report from the scan read at click time', async () => {
    const s = setup();
    const run = runFindingsExport(s.load, s.deps, findings, () => true);
    s.switchTo('scan-B');
    s.release();
    expect(await run).toBe('done');
    expect(s.seen).toMatchObject({ name: 'A.laz', epoch: 1, crsKnown: true });
  });
});

describe('closed scans', () => {
  it('a findings export with no open scan is refused', async () => {
    const s = setup();
    const run = runFindingsExport(s.load, s.deps, findings, () => findingsScanOpen(null, () => null));
    s.release();
    expect(await run).toBe('stale');
  });

  it('measurements collected while their scan closes are not added', async () => {
    let active: string | null = 'scan-A';
    let release!: () => void;
    const pending = collectForOpenScan('scan-A', () => active, () =>
      new Promise<readonly ReportFinding[]>((r) => { release = () => r(findings); }));
    active = null;
    release();
    expect(await pending).toEqual([]);
  });
});
