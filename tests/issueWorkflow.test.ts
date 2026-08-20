import { describe, it, expect } from 'vitest';
import {
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  FALLBACK_ISSUE_SEVERITY,
  FALLBACK_ISSUE_STATUS,
  attachIssue,
  compareIssueSeverity,
  filterIssuesByStatus,
  isIssueAnnotation,
  isIssueSeverity,
  isIssueStatus,
  isOpenIssue,
  isResolvedIssue,
  issueSeverityRank,
  parseIssueDetails,
  setIssueStatus,
  sortIssuesBySeverity,
  summarizeIssues,
} from '../src/render/annotate/issueWorkflow';
import type { IssueSeverity } from '../src/render/annotate/issueWorkflow';
import { createAnnotation, editAnnotation } from '../src/render/annotate/types';
import type { Annotation } from '../src/render/annotate/types';
import { serializeSession, parseSession, SESSION_VERSION } from '../src/io/session';
import type { InspectionSession } from '../src/io/session';

/** A plain annotation with a fixed id, so tests never lean on list position. */
function plain(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    title: `Annotation ${id}`,
    type: 'note',
    createdAt: 1_000,
    updatedAt: 1_000,
    localPosition: { x: 0, y: 0, z: 0 },
    ...over,
  };
}

/** An issue with a chosen severity/status, built through the public helper. */
function issue(
  id: string,
  severity: IssueSeverity,
  status: 'open' | 'resolved' = 'open',
  over: Partial<Annotation> = {},
): Annotation {
  return attachIssue(plain(id, over), { severity, status }, 2_000);
}

/** A session envelope carrying whatever annotations a test wants to persist. */
function sessionWith(annotations: Annotation[]): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
  return {
    upAxis: 'z',
    origin: [0, 0, 0],
    unitSystem: 'metric',
    views: [],
    measurements: [],
    annotations,
  };
}

describe('severity ordering', () => {
  /**
   * Catches a scale that is not a scale: a rank table that skips or duplicates
   * a value, a `critical` that does not outrank `high`, or a comparator whose
   * sign is inverted so a worst-first roster silently lists the least severe
   * finding at the top of an inspection report.
   */
  it('ranks the four severities strictly ascending, low through critical', () => {
    expect(ISSUE_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
    expect(issueSeverityRank('critical')).toBeGreaterThan(issueSeverityRank('high'));
    expect(issueSeverityRank('high')).toBeGreaterThan(issueSeverityRank('medium'));
    expect(issueSeverityRank('medium')).toBeGreaterThan(issueSeverityRank('low'));
    // Ranks are distinct, so no two severities collapse into one bucket.
    expect(new Set(ISSUE_SEVERITIES.map(issueSeverityRank)).size).toBe(4);
  });

  /**
   * Catches a comparator that is not a total order — an incomparable pair, a
   * non-antisymmetric result, or an intransitive chain — any of which makes a
   * sorted issue list depend on the engine's sort implementation.
   */
  it('compares as a total order over every pair', () => {
    for (const a of ISSUE_SEVERITIES) {
      for (const b of ISSUE_SEVERITIES) {
        const ab = compareIssueSeverity(a, b);
        const ba = compareIssueSeverity(b, a);
        expect(Number.isFinite(ab)).toBe(true);
        // Antisymmetry: exactly one of a<b, a=b, a>b. Summed rather than
        // negated because `Math.sign(0)` is +0 and `-Math.sign(0)` is -0.
        expect(Math.sign(ab) + Math.sign(ba)).toBe(0);
        expect(ab === 0).toBe(a === b);
        for (const c of ISSUE_SEVERITIES) {
          // Transitivity: a < b and b < c implies a < c.
          if (ab < 0 && compareIssueSeverity(b, c) < 0) {
            expect(compareIssueSeverity(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });

  /**
   * Catches a roster ordered by insertion order rather than by severity, and a
   * tiebreak that reads array position, which would reorder the same issues
   * after a session reload.
   */
  it('sorts issues worst first, breaking ties on the stable id', () => {
    const list = [
      issue('b', 'low'),
      issue('a', 'critical'),
      issue('d', 'medium'),
      issue('c', 'critical'),
      plain('z'),
    ];
    expect(sortIssuesBySeverity(list).map((a) => a.id)).toEqual(['a', 'c', 'd', 'b']);
    // The same set in a different input order ranks identically.
    const shuffled = [list[4], list[3], list[2], list[1], list[0]];
    expect(sortIssuesBySeverity(shuffled).map((a) => a.id)).toEqual(['a', 'c', 'd', 'b']);
  });

  /**
   * Catches a sort that reorders the caller's array in place, which would make
   * a read-only roster view silently rewrite the controller's annotation list.
   */
  it('does not mutate the list it was given', () => {
    const list = [issue('b', 'low'), issue('a', 'critical')];
    sortIssuesBySeverity(list);
    expect(list.map((a) => a.id)).toEqual(['b', 'a']);
  });
});

describe('a plain annotation is not an issue', () => {
  /**
   * Catches the whole backward-compatibility failure: work saved before this
   * workflow existed being read as an issue, and in particular a `type:'issue'`
   * annotation from an older session acquiring a severity and an open status
   * nobody ever recorded for it.
   */
  it('treats an annotation with no workflow block as a plain annotation', () => {
    const note = plain('n1');
    const legacyIssueCategory = plain('n2', { type: 'issue' });
    for (const a of [note, legacyIssueCategory]) {
      expect(a.issue).toBeUndefined();
      expect(isIssueAnnotation(a)).toBe(false);
      expect(isOpenIssue(a)).toBe(false);
      expect(isResolvedIssue(a)).toBe(false);
    }
    expect(summarizeIssues([note, legacyIssueCategory])).toEqual({
      total: 0,
      open: 0,
      resolved: 0,
      openBySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    });
    expect(sortIssuesBySeverity([note, legacyIssueCategory])).toEqual([]);
  });

  /**
   * Catches a status change that invents a workflow on an annotation that has
   * none, turning every note in the list into a tracked issue.
   */
  it('leaves a non-issue untouched when a status change is requested', () => {
    const note = plain('n1');
    const after = setIssueStatus(note, 'resolved', 9_000);
    expect(after).toBe(note);
    expect(after.issue).toBeUndefined();
    expect(after.updatedAt).toBe(1_000);
  });

  /**
   * Catches the plain-annotation edit path regressing: editing a note must not
   * gain a workflow block, and editing an issue must not drop the one it has.
   */
  it('keeps editAnnotation free of workflow side effects in both directions', () => {
    const renamedNote = editAnnotation(plain('n1'), { title: 'Renamed' }, 3_000);
    expect(renamedNote.issue).toBeUndefined();
    expect(isIssueAnnotation(renamedNote)).toBe(false);

    const renamedIssue = editAnnotation(issue('i1', 'high'), { title: 'Renamed' }, 3_000);
    expect(renamedIssue.issue).toEqual({ severity: 'high', status: 'open' });
  });
});

describe('attaching and advancing the workflow', () => {
  /**
   * Catches an issue being modelled as a replacement for an annotation rather
   * than an extension of one: a lost id, a lost anchor, a lost camera view, or
   * a lost measurement link would each break "jump to this finding".
   */
  it('keeps the annotation identity and payload when the workflow is attached', () => {
    const base = createAnnotation(
      {
        title: 'Spalled concrete',
        note: 'Delamination on the north face',
        type: 'warning',
        localPosition: { x: 4, y: 5, z: 6 },
        linkedMeasurementId: 'm-7',
        cameraState: { position: [1, 2, 3], target: [4, 5, 6] },
      },
      1_000,
    );
    const tracked = attachIssue(base, { severity: 'high', observedAt: 500 }, 7_000);
    expect(tracked.id).toBe(base.id);
    expect(tracked.title).toBe('Spalled concrete');
    expect(tracked.note).toBe('Delamination on the north face');
    expect(tracked.localPosition).toEqual({ x: 4, y: 5, z: 6 });
    expect(tracked.linkedMeasurementId).toBe('m-7');
    expect(tracked.cameraState).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
    expect(tracked.createdAt).toBe(1_000);
    expect(tracked.updatedAt).toBe(7_000);
    // The category follows the workflow so the marker matches.
    expect(tracked.type).toBe('issue');
    expect(tracked.issue).toEqual({ severity: 'high', status: 'open', observedAt: 500 });
    // The original is untouched, as with every other annotation edit.
    expect(base.issue).toBeUndefined();
    expect(base.type).toBe('warning');
  });

  /**
   * Catches an observation date defaulting to "now" or to the creation time,
   * which would date a report by when it was typed rather than by when the
   * condition was seen.
   */
  it('omits the observation date when none was supplied', () => {
    const tracked = attachIssue(plain('i1'), { severity: 'low' }, 7_000);
    expect(tracked.issue.observedAt).toBeUndefined();
    expect('observedAt' in tracked.issue).toBe(false);
  });

  /**
   * Catches a resolve step that does not record an edit time, and a redundant
   * one that bumps the edit time with no workflow change behind it.
   */
  it('records a real status change and no-ops an identical one', () => {
    const open = issue('i1', 'critical');
    const resolved = setIssueStatus(open, 'resolved', 9_000);
    expect(resolved.issue?.status).toBe('resolved');
    expect(resolved.issue?.severity).toBe('critical');
    expect(resolved.updatedAt).toBe(9_000);
    expect(open.issue?.status).toBe('open'); // the original is untouched

    expect(setIssueStatus(resolved, 'resolved', 11_000)).toBe(resolved);
    expect(setIssueStatus(open, 'open', 11_000)).toBe(open);
  });
});

describe('open / resolved filtering and counts', () => {
  const list: Annotation[] = [
    plain('n1'),
    plain('n2', { type: 'issue' }), // legacy category, no workflow
    issue('i-open-low', 'low'),
    issue('i-open-critical', 'critical'),
    issue('i-open-high', 'high'),
    issue('i-done-high', 'high', 'resolved'),
  ];

  /**
   * Catches a filter that leaks non-issues into either bucket. A `type:'issue'`
   * note with no workflow appearing under "open" would inflate an outstanding
   * defect count with untriaged annotations.
   */
  it('splits issues by status and excludes annotations that are not issues', () => {
    expect(filterIssuesByStatus(list, 'open').map((a) => a.id)).toEqual([
      'i-open-low',
      'i-open-critical',
      'i-open-high',
    ]);
    expect(filterIssuesByStatus(list, 'resolved').map((a) => a.id)).toEqual(['i-done-high']);
    // The two buckets partition the issues exactly, with nothing else in them.
    expect(
      filterIssuesByStatus(list, 'open').length + filterIssuesByStatus(list, 'resolved').length,
    ).toBe(4);
    expect(list.filter(isIssueAnnotation)).toHaveLength(4);
  });

  /**
   * Catches a roll-up counting annotations instead of issues, per-severity
   * buckets that include resolved work, and a missing severity key that would
   * make a badge read `undefined` instead of zero.
   */
  it('rolls the list up into issue counts, not annotation counts', () => {
    expect(summarizeIssues(list)).toEqual({
      total: 4,
      open: 3,
      resolved: 1,
      openBySeverity: { low: 1, medium: 0, high: 1, critical: 1 },
      highestOpenSeverity: 'critical',
    });
  });

  /**
   * Catches "nothing outstanding" being reported as a low-severity finding,
   * which would light up a status badge on a clean inspection.
   */
  it('reports no highest severity when nothing is open', () => {
    const summary = summarizeIssues([plain('n1'), issue('i1', 'critical', 'resolved')]);
    expect(summary.open).toBe(0);
    expect(summary.resolved).toBe(1);
    expect(summary.highestOpenSeverity).toBeUndefined();
    expect(summarizeIssues([]).highestOpenSeverity).toBeUndefined();
  });

  /**
   * Catches a "worst open" that tracks the last one seen, the first one seen,
   * or a resolved issue, rather than the most severe outstanding one.
   */
  it('takes the highest OPEN severity regardless of position or resolved work', () => {
    expect(
      summarizeIssues([issue('a', 'critical'), issue('b', 'low')]).highestOpenSeverity,
    ).toBe('critical');
    expect(
      summarizeIssues([issue('a', 'low'), issue('b', 'critical')]).highestOpenSeverity,
    ).toBe('critical');
    expect(
      summarizeIssues([issue('a', 'medium'), issue('b', 'critical', 'resolved')])
        .highestOpenSeverity,
    ).toBe('medium');
  });
});

describe('reading a persisted workflow block', () => {
  /**
   * Catches a parser that throws, or that drops a real finding, on a value it
   * does not recognise — a file hand-edited to `severity: "blocker"` must not
   * take the whole session down or quietly delete the issue.
   */
  it('degrades an unknown severity to the mid-rank fallback without throwing', () => {
    const parsed = parseIssueDetails({ severity: 'blocker', status: 'open' });
    expect(parsed).toEqual({ severity: FALLBACK_ISSUE_SEVERITY, status: 'open' });
    expect(isIssueSeverity(FALLBACK_ISSUE_SEVERITY)).toBe(true);
    // Mid-rank: neither below every asserted severity nor above every one.
    expect(issueSeverityRank(FALLBACK_ISSUE_SEVERITY)).toBeGreaterThan(issueSeverityRank('low'));
    expect(issueSeverityRank(FALLBACK_ISSUE_SEVERITY)).toBeLessThan(issueSeverityRank('critical'));
  });

  /**
   * Catches a fail-OPEN status default: an unreadable status being treated as
   * resolved would close a defect that was never fixed.
   */
  it('degrades an unknown status to open, never to resolved', () => {
    expect(FALLBACK_ISSUE_STATUS).toBe('open');
    expect(parseIssueDetails({ severity: 'high', status: 'wontfix' })?.status).toBe('open');
    expect(parseIssueDetails({ severity: 'high' })?.status).toBe('open');
    expect(parseIssueDetails({})).toEqual({ severity: FALLBACK_ISSUE_SEVERITY, status: 'open' });
    expect(isIssueStatus(FALLBACK_ISSUE_STATUS)).toBe(true);
    expect(ISSUE_STATUSES).toEqual(['open', 'resolved']);
  });

  /**
   * Catches an absent block being materialised into an issue, which is the
   * legacy-session failure seen from the file side.
   */
  it('returns nothing for an absent or non-object block', () => {
    for (const v of [undefined, null, 'open', 42, true, ['high'], NaN]) {
      expect(parseIssueDetails(v)).toBeUndefined();
    }
  });

  /**
   * Catches a NaN or Infinity observation date surviving into the model, where
   * it would poison the date tiebreak in the severity sort.
   */
  it('drops a non-finite or non-numeric observation date', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, '2026-08-19', null, {}]) {
      expect(parseIssueDetails({ severity: 'low', status: 'open', observedAt: v })?.observedAt)
        .toBeUndefined();
    }
    expect(parseIssueDetails({ severity: 'low', status: 'open', observedAt: 0 })?.observedAt).toBe(0);
  });

  /**
   * Catches a hostile severity value reaching the rank table and producing a
   * comparator result of NaN, which would scramble the sorted roster.
   */
  it('keeps the sort well defined after a degraded parse', () => {
    const degraded = parseIssueDetails({ severity: { evil: true } });
    const a: Annotation = { ...plain('a'), issue: degraded };
    const b = issue('b', 'critical');
    expect(sortIssuesBySeverity([a, b]).map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('session round trip', () => {
  /**
   * Catches the workflow being written but not read back, or read back with a
   * changed severity/status/date — an inspection whose findings reset to
   * "open, medium, undated" every time the file is reopened.
   */
  it('preserves severity, status and observation date across save and load', () => {
    const tracked = attachIssue(
      plain('i1', { title: 'Corroded bracket', note: 'Section loss at the base' }),
      { severity: 'critical', status: 'resolved', observedAt: 1_712_000_000_000 },
      2_000,
    );
    const back = parseSession(serializeSession(sessionWith([tracked])));
    expect(back.version).toBe(SESSION_VERSION);
    expect(back.annotations).toHaveLength(1);
    const [read] = back.annotations;
    expect(read.id).toBe('i1');
    expect(read.title).toBe('Corroded bracket');
    expect(read.note).toBe('Section loss at the base');
    expect(read.issue).toEqual({
      severity: 'critical',
      status: 'resolved',
      observedAt: 1_712_000_000_000,
    });
    expect(isIssueAnnotation(read)).toBe(true);
    expect(isResolvedIssue(read)).toBe(true);
  });

  /**
   * Catches a schema-version bump smuggled in with an additive optional field,
   * which would make every file this build writes unreadable to the readers
   * already in the field.
   */
  it('stays on the existing schema version and keeps a plain session byte-identical', () => {
    expect(SESSION_VERSION).toBe(8);
    const notes = sessionWith([plain('n1'), plain('n2', { type: 'issue' })]);
    const json = serializeSession(notes);
    const doc = JSON.parse(json) as { version: number; annotations: Record<string, unknown>[] };
    expect(doc.version).toBe(8);
    // No annotation without a workflow gains an `issue` key on the way out.
    for (const a of doc.annotations) expect('issue' in a).toBe(false);
    expect(serializeSession(notes)).toBe(json);
  });

  /**
   * Catches the legacy-file path from end to end: a session written before the
   * workflow existed must load as plain annotations, including its `issue`
   * CATEGORY rows, and must not report outstanding findings.
   */
  it('loads a pre-workflow session as plain annotations', () => {
    const legacy = JSON.stringify({
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 2,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [
        {
          id: 'old1',
          title: 'Cracked panel',
          type: 'issue',
          createdAt: 1,
          updatedAt: 1,
          localPosition: { x: 1, y: 2, z: 3 },
        },
      ],
    });
    const back = parseSession(legacy);
    expect(back.annotations).toHaveLength(1);
    expect(back.annotations[0].type).toBe('issue');
    expect(back.annotations[0].issue).toBeUndefined();
    expect(isIssueAnnotation(back.annotations[0])).toBe(false);
    expect(summarizeIssues(back.annotations).total).toBe(0);
  });

  /**
   * Catches a malformed persisted block failing the whole import, and catches
   * it degrading to something a reader would present as resolved.
   */
  it('imports a corrupt workflow block as an open issue rather than failing', () => {
    const corrupt = JSON.stringify({
      app: 'OpenLiDARViewer',
      kind: 'measurement-session',
      version: 8,
      upAxis: 'z',
      origin: [0, 0, 0],
      unitSystem: 'metric',
      views: [],
      measurements: [],
      annotations: [
        {
          id: 'bad1',
          title: 'Unreadable',
          type: 'issue',
          createdAt: 1,
          updatedAt: 1,
          localPosition: { x: 0, y: 0, z: 0 },
          issue: { severity: 'catastrophic', status: 'archived', observedAt: 'yesterday' },
        },
        {
          id: 'bad2',
          title: 'Block is a string',
          type: 'note',
          createdAt: 1,
          updatedAt: 1,
          localPosition: { x: 0, y: 0, z: 0 },
          issue: 'critical',
        },
      ],
    });
    const back = parseSession(corrupt);
    expect(back.annotations.map((a) => a.id)).toEqual(['bad1', 'bad2']);
    expect(back.annotations[0].issue).toEqual({
      severity: FALLBACK_ISSUE_SEVERITY,
      status: 'open',
    });
    // A block that is not an object is absent, not an issue with defaults.
    expect(back.annotations[1].issue).toBeUndefined();
    expect(summarizeIssues(back.annotations)).toMatchObject({ total: 1, open: 1, resolved: 0 });
  });
});
