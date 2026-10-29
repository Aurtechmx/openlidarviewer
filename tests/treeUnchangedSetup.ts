/**
 * Global setup that fails the run when tests leave the working tree changed.
 *
 * Tests that inject faults must do it in their own temporary directories. A
 * test that writes into the repository and restores it afterwards still leaves
 * the change behind when its worker is killed, and a concurrent run can read or
 * restore the injected content. This compares the tree before and after the run.
 *
 * Skipped outside a git checkout (an extracted source archive has no history to
 * compare against) and when OLV_ALLOW_TREE_CHANGES=1, for editing during watch mode.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotTree, describeTreeChange } from './support/treeSnapshot';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default function setup(): (() => void) | undefined {
  if (process.env.OLV_ALLOW_TREE_CHANGES === '1') return undefined;
  const before = snapshotTree(ROOT);
  if (!before) return undefined;
  return () => {
    const after = snapshotTree(ROOT);
    if (!after) return;
    const change = describeTreeChange(before, after);
    if (change) throw new Error(change);
  };
}
