/**
 * tests/helpers/politeLiveRegion.ts
 *
 * A fake `.olv-visually-hidden[role="status"]` live region plus a
 * `document.querySelector` stub that resolves to it — how
 * classLegendLiveAnnounce/inspectCopyAnnounce/projectCardAnnounce pin that
 * `announcePolite()` (politeAnnounce.ts) actually reaches the shared region,
 * not just that a visual caption updated.
 *
 * `announcePolite` clears the region (writes '') before setting the real
 * text, so `history` records only the non-empty writes — the announcements a
 * screen reader would actually hear.
 */
export function withLiveRegion(): { textOf: () => string; history: string[] } {
  const history: string[] = [];
  let current = '';
  const region = {
    get textContent(): string {
      return current;
    },
    set textContent(v: string) {
      current = v;
      if (v !== '') history.push(v);
    },
  };
  const g = globalThis as unknown as { document: Record<string, unknown> };
  g.document.querySelector = (sel: string): unknown =>
    sel === '.olv-visually-hidden[role="status"]' ? region : null;
  return { textOf: () => region.textContent, history };
}
