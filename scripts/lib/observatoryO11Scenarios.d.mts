type O11Vec3 = readonly [number, number, number];
interface O11Box { readonly minCorner: O11Vec3; readonly maxCorner: O11Vec3 }
export interface O11RoomScenario {
  readonly id: 'small' | 'medium' | 'large';
  readonly kind: 'room';
  readonly room: O11Box;
  readonly pillars: readonly O11Box[];
  readonly stations: readonly { readonly id: string; readonly origin: O11Vec3 }[];
  readonly angularGrid: { readonly azimuthSteps: number; readonly elevationSteps: number; readonly elevationDeg: readonly [number, number] };
  readonly stride: number;
  readonly voxelEdge: number;
}
export interface O11StressScenario {
  readonly id: 'stress';
  readonly kind: 'synthetic';
  readonly grid: { readonly nx: number; readonly ny: number; readonly nz: number };
  readonly blockEdge: number;
  readonly seed: number;
  readonly voxelEdge: number;
}
export type O11Scenario = O11RoomScenario | O11StressScenario;
export function buildO11Scenarios(): O11Scenario[];
export function castO11Returns(scene: O11RoomScenario): { positions: Float32Array; recordRanges: { start: number; end: number }[] };
export function buildO11StressStates(scene: O11StressScenario, states: number): Uint8Array;
