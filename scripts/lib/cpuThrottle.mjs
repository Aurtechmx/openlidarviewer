/**
 * CPU throttling rate for the navigation benchmark, from an environment value
 * (OLV_NAV_CPU_THROTTLE, OLV_CAL_AB_CPU_THROTTLE). Unset, empty, "off" or 1
 * means no throttling and returns 1. Anything else must be a finite number
 * from 1 to 20 (Chromium's Emulation.setCPUThrottlingRate factor).
 * See validation/protocols/render-budget-calibration-v2.md.
 */
export function parseCpuThrottle(value) {
  if (value === undefined || value === null) return 1;
  const s = String(value).trim().toLowerCase().replace(/x$/, '');
  if (s === '' || s === 'off') return 1;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`CPU throttle "${value}" is not a number`);
  const rate = Number(s);
  if (!(rate >= 1 && rate <= 20)) throw new Error(`CPU throttle ${rate} is outside 1 to 20`);
  return rate;
}

/** Fingerprint flag for a rate, or null when unthrottled. */
export const cpuThrottleFlag = (rate) => (rate > 1 ? `cpu-throttle=${rate}x` : null);
