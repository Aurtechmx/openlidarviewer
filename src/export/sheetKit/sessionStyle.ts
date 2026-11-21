/**
 * sessionStyle.ts: the sheet style chosen in this tab.
 *
 * Shared by every drawn export (map sheet, contour SVG and PNG, profile sheet
 * and section image, the text reports, the floor plan and the Studio image
 * card), so one choice styles them all. Module state on purpose: it lasts the
 * session and is never written to storage. Light until the user picks another.
 */
export type SheetStyleChoice = 'light' | 'dark' | 'classic';

let current: SheetStyleChoice = 'light';

/** The style the next drawn export uses. */
export function sheetStyle(): SheetStyleChoice {
  return current;
}

/** Remember the style the user chose. */
export function setSheetStyle(style: SheetStyleChoice): void {
  current = style;
}

