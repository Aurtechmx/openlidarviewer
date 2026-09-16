/**
 * helpCatalog.test.ts
 *
 * Help cannot drift from the app: every action a topic references exists in
 * the registry, topic ids are unique, search finds the concepts a user types,
 * and the keyboard rows come from the binding table with an action's title or
 * the binding's own line. The registry here is the real one, assembled from
 * the contributors over inert fakes. Nothing renders. The registry is built
 * once for the file. Each case reads the catalogue through its exported
 * functions only.
 */
import { describe, it, expect } from 'vitest';
import { HELP_TOPICS, helpActionRows, helpKeyRows, orphanActionReferences, searchHelp } from '../src/app/helpCatalog';
import { buildTestActionRegistry } from './helpers/actionRegistryFixture';
import { shortcutDescriptors } from '../src/ui/keyBindings';

const actions = buildTestActionRegistry();

describe('help catalogue', () => {
  it('topic ids are unique and every topic has prose', () => {
    expect(new Set(HELP_TOPICS.map((t) => t.id)).size).toBe(HELP_TOPICS.length);
    for (const t of HELP_TOPICS) expect(t.paragraphs.length + (t.terms?.length ?? 0), t.id).toBeGreaterThan(0);
  });

  it('references no action the registry does not have', () => {
    expect(orphanActionReferences(actions)).toEqual([]);
  });

  it('action rows carry the canonical title, hint and key', () => {
    const tools = HELP_TOPICS.find((t) => t.id === 'tools')!;
    const rows = helpActionRows(tools, actions);
    const measure = rows.find((r) => r.id === 'tool.measure')!;
    expect(measure.title).toBe('Measure');
    expect(measure.keys).toBe('M');
    expect(measure.hint).toMatch(/measurement/i);
  });

  // The clip is applied to the exported cloud in ExportPanel, so a summary
  // that promised an untouched export was telling the user the opposite of
  // what the file would contain.
  it('the clip summary says exports follow the clip', () => {
    const clip = actions.find((a) => a.id === 'tool.clip')!;
    expect(clip.help?.summary).toMatch(/export/i);
    expect(clip.help?.summary).not.toMatch(/no export is changed/i);
  });

  it('search finds the concepts a user types', () => {
    for (const [query, topicId] of [
      ['volume', 'tools'], ['CRS', 'export-trust'], ['preview', 'scientific-states'], ['classification', 'analyse'],
      ['keyboard', 'keyboard'], ['terrain', 'analyse'], ['export', 'export-trust'], ['orbit', 'navigation'],
    ] as const) {
      const hits = searchHelp(query, actions);
      expect(hits.map((h) => h.topic.id), query).toContain(topicId);
    }
    expect(searchHelp('', actions)).toHaveLength(HELP_TOPICS.length);
    expect(searchHelp('zzz-nothing', actions)).toHaveLength(0);
  });

  it('the scientific states topic names every state the app uses', () => {
    const terms = HELP_TOPICS.find((t) => t.id === 'scientific-states')!.terms!.map(([term]) => term);
    for (const state of ['Preview', 'Measured', 'Review', 'Blocked', 'Derived classification', 'Full source vs resident subset', 'CRS and units']) {
      expect(terms).toContain(state);
    }
  });

  it('keyboard rows describe every labelled binding by its action or its own line', () => {
    const shortcuts = shortcutDescriptors();
    const rows = helpKeyRows(shortcuts, actions);
    expect(rows).toHaveLength(shortcuts.filter((s) => s.displayKeys).length);
    expect(rows.find((r) => r.keys === 'M')?.text).toBe('Measure');
    expect(rows.find((r) => r.keys === 'Delete / Backspace')?.text).toMatch(/annotation/);
    expect(rows.find((r) => r.keys.startsWith('1–4'))?.text).toMatch(/Navigation/);
  });
});
