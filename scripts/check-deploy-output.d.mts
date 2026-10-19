export const DEPLOY_CHECKS: ReadonlyArray<{ name: string; script: string }>;
export function runDeployChecks(
  dir: string,
  checks?: ReadonlyArray<{ name: string; script: string }>,
): Array<{ name: string; ok: boolean; output: string }>;
