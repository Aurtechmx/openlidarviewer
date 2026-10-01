/**
 * Shape checks for the messages between the page and the parse worker. Each
 * side checks what it receives before reading fields off it.
 */

type Rec = Record<string, unknown>;

const XYZ = 'positions';

const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null;
const optBudget = (v: unknown): boolean =>
  v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0);
/** Whether `r[key]` is a Float32Array of xyz triples. */
const hasXyz = (r: Rec, key: string): boolean => {
  const v = r[key];
  return v instanceof Float32Array && v.length % 3 === 0;
};

/** A parse request carries bytes or a file, a format and a name. */
export function isParseRequest(x: unknown): boolean {
  return (
    isRec(x) &&
    (x.buffer instanceof ArrayBuffer || x.file instanceof Blob) &&
    typeof x.format === 'string' &&
    typeof x.name === 'string' &&
    optBudget(x.budget) &&
    optBudget(x.previewBudget)
  );
}

/** A parse reply is one of the four known types, in its shape. */
export function isParseReply(x: unknown): boolean {
  if (!isRec(x)) return false;
  switch (x.type) {
    case 'progress':
      return typeof x.stage === 'string';
    case 'previewChunk':
      return hasXyz(x, XYZ);
    case 'error':
      return typeof x.error === 'string';
    case 'done':
      return isRec(x.cloud) && hasXyz(x.cloud, XYZ);
    default:
      return false;
  }
}
