/**
 * reportSigningState.ts
 *
 * The two choices the Export panel hands to the report export: whether to sign,
 * and the signer label. In memory only, per page load, default off. The label
 * is free text the signer types; verifiers show it as unverified.
 */

let enabled = false;
let label = '';

export function reportSigningRequested(): boolean { return enabled; }
export function setReportSigningRequested(on: boolean): void { enabled = on; }
export function reportSignerLabel(): string { return label; }
export function setReportSignerLabel(text: string): void { label = text; }
