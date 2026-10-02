/**
 * workflowRecorderCap.test.ts: a recording that reaches the event limit shows
 * one notice and stays saveable with the events it took.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowController } from '../src/ui/WorkflowController';
import { MAX_WORKFLOW_EVENTS, WorkflowSession } from '../src/render/workflow/workflowRecorder';

function fakeElement(): unknown {
  const node = {
    className: '',
    textContent: '',
    title: '',
    tagName: 'DIV',
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    setAttribute: () => {},
    addEventListener: () => {},
    append: () => {},
    blur: () => {},
  };
  return node;
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: fakeElement, body: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workflow recorder event limit', () => {
  it('counts the events the cap refused', () => {
    const s = new WorkflowSession(() => 0);
    for (let i = 0; i < MAX_WORKFLOW_EVENTS; i++) expect(s.push({ type: 'frame-all' })).toBe(0);
    expect(s.push({ type: 'frame-all' })).toBe(1);
    expect(s.push({ type: 'frame-all' })).toBe(2);
  });

  it('shows one notice at the limit and still saves the recording', () => {
    const toast = vi.fn();
    const c = new WorkflowController(toast);
    c.startRecording();
    for (let i = 0; i < MAX_WORKFLOW_EVENTS; i++) c.capture({ type: 'frame-all' });
    expect(toast).not.toHaveBeenCalled();
    c.capture({ type: 'frame-all' });
    c.capture({ type: 'frame-all' });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toBe('Workflow · recording full at 10,000 events. Stop to save it.');
    const wf = c.stopRecording();
    expect(wf?.events.length).toBe(MAX_WORKFLOW_EVENTS);
  });
});
