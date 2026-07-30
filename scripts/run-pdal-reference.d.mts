/**
 * Types for `run-pdal-reference.mjs`.
 *
 * Only `PARAMS` is imported by the test, and that is the point of the file: the
 * parameters the reference ran under and the parameters our side runs under
 * have to be one definition, or the study is comparing two configurations and
 * reporting the difference as a modelling disagreement.
 */

export interface SmrfParams {
  readonly cell: number;
  readonly window: number;
  readonly slope: number;
  readonly threshold: number;
  readonly scalar: number;
  readonly cut: number;
  readonly groundClass: number;
  readonly otherClass: number;
}

export interface DtmParams {
  readonly outputType: string;
  readonly resolution: number;
  readonly radius: number;
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly nodata: number;
  readonly dataType: string;
  readonly decimalPrecision: number;
}

export declare const PARAMS: {
  readonly smrf: SmrfParams;
  readonly dtm: DtmParams;
};
