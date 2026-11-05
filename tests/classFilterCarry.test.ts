/**
 * Choosing the active layer is not a load: the legend reseeds for the new
 * layer, and the filter the user set carries over, or a toast says it went.
 */
import { describe, expect, it, vi } from 'vitest';
import { carryClassFilter } from '../src/app/ScanService';

function legend(hidden: number[], classes = true) {
  return {
    getVisibility: () => ({ hiddenCodes: () => hidden }),
    hasClasses: () => classes,
    applyFilter: vi.fn(),
  };
}

describe('carryClassFilter', () => {
  it('reapplies the hidden classes after the switch, in order', () => {
    const l = legend([1, 6]);
    const order: string[] = [];
    l.applyFilter.mockImplementation(() => order.push('apply'));
    const toast = vi.fn();
    carryClassFilter(l, () => order.push('switch'), toast);
    expect(order).toEqual(['switch', 'apply']);
    expect(l.applyFilter).toHaveBeenCalledWith([1, 6]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does nothing extra with no filter set', () => {
    const l = legend([]);
    const toast = vi.fn();
    carryClassFilter(l, () => {}, toast);
    expect(l.applyFilter).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('says the filter went when the new layer has no classes', () => {
    const l = legend([1], false);
    const toast = vi.fn();
    carryClassFilter(l, () => {}, toast);
    expect(l.applyFilter).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Class filter cleared: all classes are shown. Set it again in Classes.');
  });
});
