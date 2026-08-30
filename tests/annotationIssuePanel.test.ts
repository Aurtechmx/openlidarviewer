/**
 * tests/annotationIssuePanel.test.ts
 *
 * The inspection workflow as a user meets it: the severity and status controls
 * on the annotation editor, the issue list and roll-up in the annotations
 * panel, and the controller write path underneath them.
 *
 * What these pin is that the UI DELEGATES. `render/annotate/issueWorkflow.ts`
 * owns which annotations are issues, how they rank, what the counts are, and
 * what a write does; the panel and the editor are views over that. So the
 * cases here are the ones where a hand-rolled view would drift from the model:
 * a `type: 'issue'` annotation with no workflow block (not an issue), a roster
 * with nothing open (no severity may be reported), a re-ordered input (the
 * ranking must not move), and a no-op status click (nothing to record).
 *
 * The honesty case has its own tests: a resolved issue is only ever "marked
 * resolved", because a person set a status and the viewer checked nothing.
 *
 * Runs in the node environment like the other panel suites, driving the real
 * UI through a recording DOM stub.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { AnnotationSummary } from '../src/render/annotate/AnnotationController';
import type { IssueDetails, IssueSeverity } from '../src/render/annotate/issueWorkflow';

type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface these views touch. */
class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  private _text = '';
  title = '';
  value = '';
  type = '';
  placeholder = '';
  rows = 0;
  maxLength = 0;
  checked = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  set className(v: string) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (...c: string[]): void => void c.forEach((x) => classes.add(x)),
      remove: (...c: string[]): void => void c.forEach((x) => classes.delete(x)),
      contains: (c: string): boolean => classes.has(c),
      toggle: (c: string, force?: boolean): boolean => {
        const want = force === undefined ? !classes.has(c) : force;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    };
  }
  set textContent(v: string) {
    this._text = v;
  }
  /** Aggregated, so a strip built from spans can be read as one string. */
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) {
    /* icon markup — not parsed by this stub */
  }

  private _adopt(kid: unknown): FakeEl {
    if (kid instanceof FakeEl) {
      kid.parent = this;
      return kid;
    }
    const t = new FakeEl('#text');
    t.textContent = String(kid);
    t.parent = this;
    return t;
  }
  append(...kids: unknown[]): void {
    for (const k of kids) this.children.push(this._adopt(k));
  }
  appendChild(kid: unknown): unknown {
    this.children.push(this._adopt(kid));
    return kid;
  }
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(this._adopt(k));
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }

  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  removeEventListener(): void {
    /* not exercised */
  }
  /** Fire a listener the view registered — how these tests click. */
  click(): void {
    for (const fn of this.handlers.get('click') ?? []) fn({ type: 'click', clientX: 0, clientY: 0 });
  }
  focus(): void {}
  blur(): void {}
  select(): void {}

  private _matches(sel: string): boolean {
    const parts = sel.split('.');
    const tag = parts[0];
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    for (const c of parts.slice(1)) if (!this._classes.has(c)) return false;
    return true;
  }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) {
      if (c._matches(sel)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      for (const c of n.children) {
        if (c._matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    // The polite live region belongs to DropZone, which is not mounted here;
    // announcing into a document without one is a no-op, not a failure.
    querySelector: () => null,
  };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.HTMLTextAreaElement = class HTMLTextAreaElement {};
  g.window = { innerWidth: 1280, innerHeight: 800 };
});

let seq = 0;

/** A panel summary, optionally carrying the inspection workflow. */
function summary(
  id: string,
  issue?: IssueDetails,
  over: Partial<AnnotationSummary> = {},
): AnnotationSummary {
  seq += 1;
  return {
    id,
    index: seq,
    title: id,
    type: issue ? 'issue' : 'note',
    note: '',
    createdAt: 1_000 + seq,
    updatedAt: 1_000 + seq,
    selected: false,
    localPosition: { x: 0, y: 0, z: 0 },
    ...(issue ? { issue } : {}),
    ...over,
  };
}

const open = (severity: IssueSeverity, observedAt?: number): IssueDetails => ({
  severity,
  status: 'open',
  ...(observedAt === undefined ? {} : { observedAt }),
});
const resolved = (severity: IssueSeverity): IssueDetails => ({ severity, status: 'resolved' });

interface Mounted {
  el: FakeEl;
  onSetIssueStatus: ReturnType<typeof vi.fn>;
  update: (list: AnnotationSummary[]) => void;
  rollup: () => string;
  rows: () => FakeEl[];
  headers: () => FakeEl[];
  showIssues: () => void;
}

async function mount(list: AnnotationSummary[]): Promise<Mounted> {
  const { AnnotationPanel } = await import('../src/ui/AnnotationPanel');
  const onSetIssueStatus = vi.fn();
  const panel = new AnnotationPanel({
    onActivate: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onClearAll: () => {},
    onHover: () => {},
    onSetIssueStatus,
  });
  panel.update(list);
  const el = panel.element as unknown as FakeEl;
  return {
    el,
    onSetIssueStatus,
    update: (next) => panel.update(next),
    rollup: () => el.querySelectorAll('.olv-ap-issues')[0]?.textContent ?? '',
    rows: () => el.querySelectorAll('.olv-ap-row'),
    headers: () => el.querySelectorAll('.olv-ap-group'),
    showIssues: () => {
      const views = el.querySelectorAll('.olv-ap-view');
      views[1].click();
    },
  };
}

/** The row's title, for order assertions. */
const titleOf = (row: FakeEl): string =>
  row.querySelectorAll('.olv-ap-name')[0]?.textContent ?? '';

describe('the issue roll-up counts what is open', () => {
  it('reports the open total, the per-severity counts and the worst open rank', async () => {
    const panel = await mount([
      summary('a', open('low')),
      summary('b', open('critical')),
      summary('c', open('high')),
      summary('d', resolved('critical')),
    ]);
    const text = panel.rollup();
    expect(text).toContain('3 open issues');
    expect(text).toContain('worst open');
    expect(text).toContain('Critical');
    // One chip per severity that has something open, and none for the rest.
    const chips = panel.el.querySelectorAll('.olv-ap-issues-chip').map((c) => c.textContent);
    expect(chips.some((c) => c.includes('Critical') && c.includes('1'))).toBe(true);
    expect(chips.some((c) => c.includes('High'))).toBe(true);
    expect(chips.some((c) => c.includes('Medium'))).toBe(false);
  });

  it('reports no severity at all when nothing is open', async () => {
    // The model leaves `highestOpenSeverity` absent here, and "nothing
    // outstanding" must not be rendered as the bottom rank.
    const panel = await mount([summary('a', resolved('critical')), summary('b', resolved('low'))]);
    const text = panel.rollup();
    expect(text).toContain('0 open issues');
    expect(panel.el.querySelectorAll('.olv-ap-issues-worst')).toHaveLength(0);
    expect(text).not.toContain('Low');
    expect(text).not.toContain('worst open');
  });

  it('says resolved issues were marked, never that anything was verified', async () => {
    const panel = await mount([summary('a', open('high')), summary('b', resolved('high'))]);
    expect(panel.rollup()).toContain('1 marked resolved');
    const note = panel.el.querySelectorAll('.olv-ap-issues-resolved')[0];
    expect(note.title).toContain('does not verify');
    expect(panel.rollup()).not.toMatch(/verified|fixed|checked/i);
  });

  it('leaves a type: issue annotation with no workflow block out of the count', async () => {
    // The category styles the marker; the block is what says it is tracked.
    // A session saved before this workflow existed must gain neither.
    const panel = await mount([summary('a', undefined, { type: 'issue' })]);
    expect(panel.el.querySelectorAll('.olv-ap-issues')[0].className).toContain('olv-hidden');
    expect(panel.el.querySelectorAll('.olv-ap-views')[0].className).toContain('olv-hidden');
    expect(panel.el.querySelectorAll('.olv-ap-sev-mark')).toHaveLength(0);
  });
});

describe('the issue view ranks open issues worst first', () => {
  it('orders by severity and keeps resolved issues out of the open list', async () => {
    const panel = await mount([
      summary('minor', open('low')),
      summary('done', resolved('critical')),
      summary('urgent', open('critical')),
      summary('bad', open('high')),
    ]);
    panel.showIssues();
    expect(panel.rows().map(titleOf)).toEqual(['urgent', 'bad', 'minor']);
    expect(panel.headers().map((h) => h.textContent)).toEqual([
      expect.stringContaining('Critical'),
      expect.stringContaining('High'),
      expect.stringContaining('Low'),
    ]);
  });

  it('ranks the same however the annotations arrive', async () => {
    const rows = [
      summary('one', open('high', 10)),
      summary('two', open('high', 5)),
      summary('three', open('critical')),
    ];
    const panel = await mount(rows);
    panel.showIssues();
    const first = panel.rows().map(titleOf);
    panel.update([...rows].reverse());
    expect(panel.rows().map(titleOf)).toEqual(first);
    // Within a rank the older observation leads, so it is not input order.
    expect(first).toEqual(['three', 'two', 'one']);
  });

  it('keeps resolved issues reachable behind a disclosure', async () => {
    const panel = await mount([summary('live', open('medium')), summary('done', resolved('high'))]);
    panel.showIssues();
    expect(panel.rows().map(titleOf)).toEqual(['live']);
    const toggle = panel.el.querySelectorAll('.olv-ap-resolved-toggle')[0];
    expect(toggle.textContent).toContain('Marked resolved (1)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(panel.rows().map(titleOf)).toEqual(['live', 'done']);
  });

  it('offers resolve on an open issue and reopen on a resolved one', async () => {
    const panel = await mount([summary('live', open('medium')), summary('done', resolved('high'))]);
    panel.showIssues();
    panel.el.querySelectorAll('.olv-ap-resolved-toggle')[0].click();
    const buttons = panel.el.querySelectorAll('.olv-ap-issue-status');
    expect(buttons.map((b) => b.textContent)).toEqual(['Resolve', 'Reopen']);
    buttons[0].click();
    expect(panel.onSetIssueStatus).toHaveBeenCalledWith('live', 'resolved');
    buttons[1].click();
    expect(panel.onSetIssueStatus).toHaveBeenCalledWith('done', 'open');
  });

  it('carries severity in shape and words, not colour alone', async () => {
    const panel = await mount([
      summary('a', open('low')),
      summary('b', open('medium')),
      summary('c', open('high')),
      summary('d', open('critical')),
    ]);
    panel.showIssues();
    const marks = panel.el.querySelectorAll('.olv-ap-sev-mark');
    expect(marks).toHaveLength(4);
    // Four distinct glyphs: the rank survives greyscale and forced colours.
    expect(new Set(marks.map((m) => m.textContent)).size).toBe(4);
    for (const mark of marks) {
      expect(mark.getAttribute('aria-label')).toMatch(/^Severity: (Low|Medium|High|Critical)$/);
    }
    // And the word itself is on the section header above the rows.
    expect(panel.headers().map((h) => h.textContent).join(' ')).toContain('Critical');
  });
});

/** The editor, mounted with a save spy. */
async function editor() {
  const { AnnotationEditor } = await import('../src/ui/AnnotationEditor');
  const card = new AnnotationEditor();
  const onSave = vi.fn();
  const el = card.element as unknown as FakeEl;
  return {
    card,
    onSave,
    el,
    save: () => el.querySelectorAll('.olv-anno-editor-save')[0].click(),
    pick: (sel: string) => el.querySelectorAll(sel)[0].click(),
  };
}

describe('the annotation editor collects the inspection workflow', () => {
  it('leaves an untouched annotation untracked', async () => {
    const e = await editor();
    e.card.open({ x: 0, y: 0, onSave: e.onSave, onCancel: () => {} });
    e.save();
    expect(e.onSave.mock.calls[0][0].issue).toBeNull();
  });

  it('marks the annotation as an issue when a severity is picked', async () => {
    const e = await editor();
    e.card.open({ x: 0, y: 0, onSave: e.onSave, onCancel: () => {} });
    // The status row is the thing that has nothing to say until then.
    expect(e.el.querySelectorAll('.olv-anno-editor-status')[0].className).toContain('olv-hidden');
    e.pick('.olv-anno-sev-high');
    expect(e.el.querySelectorAll('.olv-anno-editor-status')[0].className).not.toContain(
      'olv-hidden',
    );
    e.save();
    expect(e.onSave.mock.calls[0][0].issue).toEqual({ severity: 'high', status: 'open' });
  });

  it('resolves and reopens an existing issue', async () => {
    const e = await editor();
    e.card.open({
      x: 0,
      y: 0,
      initial: { issue: { severity: 'low', status: 'open' } },
      onSave: e.onSave,
      onCancel: () => {},
    });
    e.pick('.olv-anno-status-resolved');
    e.save();
    expect(e.onSave.mock.calls[0][0].issue).toEqual({ severity: 'low', status: 'resolved' });
  });

  it('carries the observation date through an edit that never shows it', async () => {
    // `attachIssue` replaces the whole block, so a date recorded in the field
    // would otherwise be erased by a title edit made back at the office.
    const e = await editor();
    e.card.open({
      x: 0,
      y: 0,
      initial: { issue: { severity: 'medium', status: 'open', observedAt: 1_700_000_000_000 } },
      onSave: e.onSave,
      onCancel: () => {},
    });
    e.pick('.olv-anno-sev-critical');
    e.save();
    expect(e.onSave.mock.calls[0][0].issue).toEqual({
      severity: 'critical',
      status: 'open',
      observedAt: 1_700_000_000_000,
    });
  });
});

describe('the controller routes issue writes through the model', () => {
  async function controller() {
    const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
    const c = new AnnotationController();
    const card = c.editorElement as unknown as FakeEl;
    return {
      c,
      pick: (sel: string) => card.querySelectorAll(sel)[0].click(),
      save: () => card.querySelectorAll('.olv-anno-editor-save')[0].click(),
    };
  }

  it('attaches the workflow, and the issue category with it, on create', async () => {
    const h = await controller();
    h.c.beginDraft({ x: 1, y: 2, z: 3 }, 0, 0);
    h.pick('.olv-anno-sev-critical');
    h.save();
    const [a] = h.c.getAnnotations();
    expect(a.issue).toEqual({ severity: 'critical', status: 'open' });
    // attachIssue sets the category so the marker agrees with the workflow.
    expect(a.type).toBe('issue');
    // One user action, one undo step: the triage folds into the creation.
    h.c.undo();
    expect(h.c.getAnnotations()).toHaveLength(0);
  });

  it('moves an issue between open and resolved', async () => {
    const h = await controller();
    h.c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0);
    h.pick('.olv-anno-sev-low');
    h.save();
    const id = h.c.getAnnotations()[0].id;
    h.c.setIssueStatus(id, 'resolved');
    expect(h.c.getAnnotations()[0].issue?.status).toBe('resolved');
    h.c.setIssueStatus(id, 'open');
    expect(h.c.getAnnotations()[0].issue?.status).toBe('open');
  });

  it('records nothing when the status is already what was asked for', async () => {
    const h = await controller();
    h.c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0);
    h.pick('.olv-anno-sev-medium');
    h.save();
    const before = h.c.getAnnotations()[0];
    h.c.setIssueStatus(before.id, 'open');
    // Same object: no edit to timestamp, and no undo step to step back over.
    expect(h.c.getAnnotations()[0]).toBe(before);
    h.c.undo();
    expect(h.c.getAnnotations()).toHaveLength(0);
  });

  it('leaves a plain annotation alone', async () => {
    const h = await controller();
    h.c.beginDraft({ x: 0, y: 0, z: 0 }, 0, 0);
    h.save();
    const [a] = h.c.getAnnotations();
    expect(a.issue).toBeUndefined();
    h.c.setIssueStatus(a.id, 'resolved');
    expect(h.c.getAnnotations()[0]).toBe(a);
  });
});
