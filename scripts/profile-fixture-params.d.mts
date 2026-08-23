export const RAMP_A: number[];
export const RAMP_B: number[];
export const RAMP_SAMPLES: number;
export const RAMP_BAND: number;
export const RAMP_T_START: number;
export const RAMP_T_STEP: number;
export const RAMP_T_COUNT: number;
export const RAMP_CROSS: number;
export const RAMP_DECOY_T: number;
export const RAMP_DECOY_LIFT: number;
export const RAMP_END_DECOYS: number[];
export const rampGround: (s: number) => number;
export const RAMP_BIN_STEP: number;
export const rampExpected: (i: number, p: number) => number;

export const SCATTER_A: number[];
export const SCATTER_B: number[];
export const SCATTER_SAMPLES: number;
export const SCATTER_BAND: number;
export const SCATTER_BIN_STEP: number;
export const SCATTER_EDGE_MARGIN: number;
export const SCATTER_EMPTY_BINS: number[];
export const SCATTER_SEED: number;

export const PERCENTILE_PRIMARY: number;
export const PERCENTILE_SECONDARY: number;
export const EXCLUDED_CLASSES: number[];
export const UP: number[];

export const CAPS_A: number[];
export const CAPS_B: number[];
export const CAPS_SAMPLES: number;
export const CAPS_BAND: number;
export const CAPS_BIN_STEP: number;
export const CAPS_T_START: number;
export const CAPS_T_STEP: number;
export const CAPS_T_COUNT: number;
export const CAPS_CROSS: number;
export const CAPS_DECOY_T: number;
export const CAPS_DECOY_LIFT: number;
export const CAPS_REJECT_LIFT: number;
export const capsGround: (s: number) => number;
export const CAPS_PROBES: Array<[number, number, boolean]>;
export const capsExpected: (i: number, p: number) => number;

export interface EndcapProbe {
  id: string;
  caseNo: number;
  x: number;
  y: number;
  admitted: boolean;
}
export const ENDCAP_A: number[];
export const ENDCAP_B: number[];
export const ENDCAP_SAMPLES: number;
export const ENDCAP_BAND: number;
export const ENDCAP_BIN_STEP: number;
export const ENDCAP_Z: number;
export const ENDCAP_PROBES: EndcapProbe[];
export const endcapDistance: (probe: { x: number; y: number }) => number;
export const endcapRectangle: (probe: { x: number; y: number }) => boolean;
