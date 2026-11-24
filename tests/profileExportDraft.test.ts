/**
 * profileExportDraft.test.ts: closing the profile export dialog without
 * exporting keeps what was typed for that measurement, in memory only; Discard,
 * an export, another scan or a replaced measurement ends it.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ modals: [] as Array<{ body: unknown; footer: unknown; close: () => void }>, writes: 0 }));
vi.mock('../src/ui/Modal', async () => {
  const { FakeEl } = await import('./helpers/liveFakeDom');
  return {
    openModal: (o: { body: unknown; footer: unknown; onClose?: () => void }) => {
      let shut = false;
      const rec = { body: o.body, footer: o.footer, close: () => { if (!shut) { shut = true; o.onClose?.(); } } };
      h.modals.push(rec);
      return { element: new FakeEl('div'), close: rec.close };
    },
  };
});
vi.mock('../src/ui/companyStore', () => ({ rememberedCompany: () => null, rememberCompany: () => { h.writes++; return true; } }));
vi.mock('../src/ui/exportLanguageControl', async () => {
  const { FakeEl } = await import('./helpers/liveFakeDom');
  return { exportLanguageControl: () => new FakeEl('div') };
});
vi.mock('../src/ui/sheetStyleControl', async () => {
  const { FakeEl } = await import('./helpers/liveFakeDom');
  return { sheetStyleControl: () => new FakeEl('div') };
});

import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';
import { companyDetails, jobDetails, setCompanyDetails, setJobDetails } from '../src/model/deliverableFields';
import { openProfileExportDialog, type ProfileExportChoice, type ProfileExportDialogInput } from '../src/ui/profileExportDialog';

beforeAll(() => {
  installLiveFakeDom();
  (FakeEl.prototype as unknown as { prepend(...k: FakeEl[]): void }).prepend = function (this: FakeEl, ...k: FakeEl[]) { for (const n of k) this.insertBefore(n, this.firstChild); };
});
beforeEach(() => { setCompanyDetails({}); setJobDetails({}); h.writes = 0; });

type Box = FakeEl & { value: string };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function open(owner: object, over: Partial<ProfileExportDialogInput> = {}, run: (c: ProfileExportChoice) => Promise<void> = async () => {}) {
  void openProfileExportDialog({
    profileName: 'Profile 1', scanName: 'scan', lengthM: 50, unitSystem: 'metric', fields: {}, defaultFileName: 'a.pdf', draftOwner: owner, ...over,
  }, run);
  const m = h.modals.at(-1)!;
  const body = m.body as FakeEl, footer = m.footer as FakeEl;
  const byLabel = (label: string): Box => {
    const l = body.find((e) => e.tagName === 'label' && e.ownText === label)!;
    return body.find((e) => e.id === l.attrs.for)! as Box;
  };
  const button = (text: string): FakeEl => [body, footer].flatMap((r) => r.findAll((e) => e.tagName === 'button' && e.ownText === text))[0]!;
  return {
    body, byLabel, button, close: m.close,
    cell: (name: string): Box | undefined => body.find((e) => e.attrs['aria-label'] === name) as Box | undefined,
    held: (): string | undefined => body.querySelector('.olv-pe-held')?.textContent,
    logo: (): FakeEl => body.querySelector('.olv-pe-logo')!,
    addMark: (chainage: string, text: string): void => {
      button('Add a marked point').fire('click');
      const rows = body.findAll((e) => /^Chainage, marked point/.test(e.attrs['aria-label'] ?? '')).length;
      (body.find((e) => e.attrs['aria-label'] === `Chainage, marked point ${rows}`) as Box).value = chainage;
      (body.find((e) => e.attrs['aria-label'] === `Text, marked point ${rows}`) as Box).value = text;
    },
    export: async (): Promise<void> => { button('Export PDF').fire('click'); for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); },
  };
}

describe('unexported profile details', () => {
  it('come back for the same profile, say so, and touch nothing else', () => {
    const owner = {}, before = JSON.stringify(owner);
    let d = open(owner);
    expect(d.held()).toBeUndefined();
    d.byLabel('Title').value = 'Reach 4';
    d.byLabel('Client').value = 'Ayuntamiento';
    d.byLabel('Company').value = 'Norte';
    d.byLabel('Notes').value = 'Nota';
    d.button('Add an issue').fire('click');
    d.cell('Description, issue 1')!.value = 'For comment';
    d.addMark('12.5', 'Culvert');
    d.button('Cancel').fire('click');
    expect([JSON.stringify(owner), companyDetails(), jobDetails(), h.writes]).toEqual([before, {}, {}, 0]);
    d = open(owner);
    expect(d.held()).toContain('Unexported details from last time.');
    expect(['Title', 'Client', 'Company', 'Notes'].map((l) => d.byLabel(l).value)).toEqual(['Reach 4', 'Ayuntamiento', 'Norte', 'Nota']);
    expect([d.cell('Description, issue 1')!.value, d.cell('Chainage, marked point 1')!.value, d.cell('Text, marked point 1')!.value]).toEqual(['For comment', '12.5', 'Culvert']);
    d.close();
    expect(open({}).byLabel('Title').value).toBe('');
  });

  it('nothing typed leaves nothing, and a field left alone follows its source', () => {
    const owner = {};
    open(owner).close();
    expect(open(owner).held()).toBeUndefined();
    const d = open(owner);
    d.byLabel('Title').value = 'T';
    d.close();
    setCompanyDetails({ company: 'From another profile' });
    expect(open(owner).byLabel('Company').value).toBe('From another profile');
  });

  it('Discard puts the fields back and forgets', () => {
    const owner = {};
    let d = open(owner, { fields: { title: 'Saved', marks: [{ chainage: 3, text: 'Peg' }] } });
    d.byLabel('Title').value = 'Typed';
    d.addMark('9', 'New');
    d.close();
    d = open(owner, { fields: { title: 'Saved', marks: [{ chainage: 3, text: 'Peg' }] } });
    expect(d.cell('Chainage, marked point 2')!.value).toBe('9');
    d.button('Discard').fire('click');
    expect([d.byLabel('Title').value, d.cell('Chainage, marked point 1')!.value, d.cell('Chainage, marked point 2'), d.held()]).toEqual(['Saved', '3', undefined, undefined]);
    d.close();
    expect(open(owner, { fields: { title: 'Saved' } }).held()).toBeUndefined();
  });

  it('ends once exported, and the paper is remembered', async () => {
    const owner = {};
    let d = open(owner);
    d.byLabel('Title').value = 'T';
    d.byLabel('Paper').value = 'tabloid';
    d.close();
    expect(open({}).byLabel('Paper').value).toBe('a3');
    d = open(owner);
    expect(d.byLabel('Paper').value).toBe('tabloid');
    await d.export();
    expect(open(owner).held()).toBeUndefined();
    expect(open({}).byLabel('Paper').value).toBe('tabloid');
  });

  it('a failed export keeps the draft', async () => {
    const owner = {};
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = open(owner, {}, async () => { throw new Error('no'); });
    d.byLabel('Title').value = 'T';
    await d.export();
    d.close();
    expect(open(owner).byLabel('Title').value).toBe('T');
  });

  it('does not follow the profile to another scan', () => {
    const owner = {};
    const d = open(owner);
    d.byLabel('Title').value = 'T';
    d.close();
    expect(open(owner, { scanName: 'other' }).held()).toBeUndefined();
    expect(open(owner).held()).toBeUndefined();
  });

  it('a removed logo stays removed', () => {
    setCompanyDetails({ company: 'C', logoDataUrl: PNG });
    const owner = {};
    let d = open(owner);
    expect(d.logo().hidden).toBe(false);
    d.button('Remove logo').fire('click');
    d.close();
    d = open(owner);
    expect(d.logo().hidden).toBe(true);
    d.button('Discard').fire('click');
    expect(d.logo().hidden).toBe(false);
  });

  it('marked points are converted when the unit changed, or their chainage is left out', () => {
    const owner = {};
    let d = open(owner);
    d.addMark('0+030.48', 'Culvert');
    d.addMark('somewhere', 'Peg');
    d.close();
    d = open(owner, { unitSystem: 'imperial' });
    expect([d.cell('Chainage, marked point 1')!.value, d.cell('Chainage, marked point 2')!.value, d.cell('Text, marked point 2')!.value]).toEqual(['100', '', 'Peg']);
    expect(d.held()).toContain('Type them again in ft.');
    d.close();
    d = open(owner);
    expect(d.cell('Chainage, marked point 1')!.value).toBe('30.48');
    expect(d.held()).toContain('converted to m');
    d.close();
    d = open(owner, { unitSystem: 'unverified' });
    expect([d.cell('Chainage, marked point 1')!.value, d.cell('Text, marked point 1')!.value]).toEqual(['', 'Culvert']);
  });
});
