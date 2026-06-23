/**
 * confirmFullExport.ts
 *
 * Lazy gate for full-resolution export. Kept out of the eager startup chunk —
 * it pulls the styled confirm dialog and the byte formatter, and full-res
 * export is a deliberate, lazy action, so its memory confirmation only loads
 * when the user actually asks for it.
 */

import { assessFullExportMemory } from './exportMemoryGuard';
import { formatByteSize } from '../io/formatByteSize';
import { openConfirm } from '../ui/Modal';

/**
 * Whether a full-resolution export of `file` should proceed: trivially true for
 * routine sizes, or the user's decision for a file large enough that the
 * re-decode could exhaust the tab's memory.
 */
export async function confirmFullExport(file: File): Promise<boolean> {
  const mem = assessFullExportMemory(file.size);
  if (!mem.needsConfirm) return true;
  return openConfirm({
    title: 'Large full-resolution export',
    message:
      `Re-decoding ${file.name} at full resolution reads the whole ${formatByteSize(file.size)} ` +
      `file into memory (roughly ${formatByteSize(mem.estimatedPeakBytes)} at peak) and may ` +
      `crash the tab. For multi-GB datasets, convert to COPC or EPT for progressive loading. ` +
      `Export anyway?`,
    confirmLabel: 'Export anyway',
  });
}
