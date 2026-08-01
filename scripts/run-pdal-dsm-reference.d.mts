/**
 * Types for `run-pdal-dsm-reference.mjs`.
 *
 * Only `PARAMS_DSM` is imported by the test, and that is the point: the
 * parameters the DSM reference ran under and the parameters buildDsm runs under
 * have to be one definition, or the study compares two configurations and reports
 * the difference as a modelling disagreement. Same arrangement as
 * `run-pdal-reference.d.mts`.
 */

export interface DsmParams {
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

export declare const PARAMS_DSM: DsmParams;
