import { ModuleRegistry } from '../src/analysis/ModuleApi';
import type { AnalysisModule } from '../src/analysis/ModuleApi';
import { PointCloud } from '../src/model/PointCloud';

function makeStub(id: string, label: string): AnalysisModule {
  return {
    id,
    label,
    run(_cloud: PointCloud) {
      return { rows: [] };
    },
  };
}

describe('ModuleRegistry', () => {
  test('list() returns all registered modules in insertion order', () => {
    const reg = new ModuleRegistry();
    const a = makeStub('mod-a', 'Module A');
    const b = makeStub('mod-b', 'Module B');
    reg.register(a);
    reg.register(b);
    const listed = reg.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toBe(a);
    expect(listed[1]).toBe(b);
  });

  test('get() returns the correct module by id', () => {
    const reg = new ModuleRegistry();
    const a = makeStub('mod-a', 'Module A');
    const b = makeStub('mod-b', 'Module B');
    reg.register(a);
    reg.register(b);
    expect(reg.get('mod-a')).toBe(a);
    expect(reg.get('mod-b')).toBe(b);
  });

  test('get() returns undefined for unknown id', () => {
    const reg = new ModuleRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  test('register() throws on duplicate id', () => {
    const reg = new ModuleRegistry();
    reg.register(makeStub('dup', 'First'));
    expect(() => reg.register(makeStub('dup', 'Second'))).toThrow();
  });

  test('list() returns empty array when nothing is registered', () => {
    const reg = new ModuleRegistry();
    expect(reg.list()).toHaveLength(0);
  });
});
