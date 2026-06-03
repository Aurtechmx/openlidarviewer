/**
 * TerrainErrors.ts
 *
 * Typed errors the terrain subsystem can throw. Tagged so the host
 * can branch on `name` rather than parsing free-text messages.
 */

export type TerrainErrorKind =
  | 'cancelled'
  | 'budget-exceeded'
  | 'invalid-request'
  | 'partition-missing'
  | 'worker-unavailable'
  | 'internal';

/** Base terrain error. */
export class TerrainError extends Error {
  readonly kind: TerrainErrorKind;
  constructor(kind: TerrainErrorKind, message: string) {
    super(message);
    this.name = 'TerrainError';
    this.kind = kind;
  }
}

/** Thrown when a running job is cancelled via its abort signal. */
export class TerrainCancelledError extends TerrainError {
  constructor() {
    super('cancelled', 'Terrain job cancelled.');
    this.name = 'TerrainCancelledError';
  }
}
