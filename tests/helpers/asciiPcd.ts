/**
 * asciiPcd.ts: an in-memory ascii PCD builder with x y z fields, shared by the
 * organized-range and acquisition-station specs.
 */
export interface PcdHeaderOptions {
  readonly width: number;
  readonly height: number;
  readonly points?: number;
  readonly viewpoint?: string | null;
}

/** An ascii PCD with x y z fields. `viewpoint: null` omits the line entirely. */
export function asciiPcd(options: PcdHeaderOptions, rows: readonly string[]): ArrayBuffer {
  const { width, height, points = width * height, viewpoint = '0 0 0 1 0 0 0' } = options;
  const lines = [
    '# .PCD v0.7',
    'VERSION 0.7',
    'FIELDS x y z',
    'SIZE 8 8 8',
    'TYPE F F F',
    'COUNT 1 1 1',
    `WIDTH ${width}`,
    `HEIGHT ${height}`,
    ...(viewpoint === null ? [] : [`VIEWPOINT ${viewpoint}`]),
    `POINTS ${points}`,
    'DATA ascii',
    ...rows,
    '',
  ];
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
}

/**
 * A 4-column by 3-row grid whose coordinates encode their own address:
 * x is the column, y is the row. Non-square on purpose, so a transposed read
 * cannot hide on a square grid, and the coordinates make an off-by-one in
 * the record link visible rather than merely a different number.
 */
export const GRID_ROWS: readonly string[] = (() => {
  const rows: string[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) rows.push(`${column} ${row} 0`);
  }
  return rows;
})();
