/** Types for pin-ios-simulator.mjs, which tests import. */
export declare function pinSimulator(
  listing: unknown,
  wantRuntime?: string,
  wantDevice?: string,
): { udid: string; name: string; runtime: string } | { error: string };
