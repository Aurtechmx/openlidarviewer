export type ReleaseChannel = 'stable' | 'prerelease';
export function releaseChannelFor(version: unknown): ReleaseChannel | null;
export function releaseChannelProblems(args: {
  version: string | null | undefined;
  tag: string | null | undefined;
  channel: string | null | undefined;
}): string[];
