// SPDX-License-Identifier: MIT
// Type declarations for the vendored spe_check.mjs (A. Urias, MIT; see LICENSE in this directory).
// spe_check.mjs is kept byte-for-byte as published. It is the ES-module build of upstream spe_check.js,
// SHA-256 53229a0e2682fb103097eaef028079a40b6fa1a5f0c78fbf1da2b0b3c4598b6b, and differs from it only in the
// export statement (tests/speCheckVendor.test.ts pins both facts). These declarations add types only.

export type Vec3 = readonly [number, number, number] | readonly number[] | Float64Array | Float32Array;
export type Contract = 'rn' | 'faithful';
export type BoundState = 'PASS_BOUND' | 'NOT_CERTIFIED_BOUND' | 'NOT_TESTED' | 'NOT_APPLICABLE';

export interface Evidence {
  boundState: BoundState;
  measuredState: string;
  verificationState: string;
  consistent: boolean;
  clean: boolean;
}

export interface CheckResult extends Evidence {
  bound: number | null;
  contract: string;
  expression: string | null;
  expressionSupported: boolean;
  unsupportedReason: string | null;
}

export interface EncodedTile {
  enc: Float32Array;
  rho: number[];
  r: number[];
}

export declare function encodeLocal(P64: ArrayLike<number>, origin: ArrayLike<number>): EncodedTile;
export declare function validateDraw(rho: Vec3, r: Vec3, A64: number[][], contract?: string): { rho: number[]; r: number[]; u: number };
export declare function boundAffineDraw(rho: Vec3, r: Vec3, A64: number[][], contract?: string): number;
export declare function evaluateEvidence(
  tau: number | null | undefined,
  evidence?: { bound?: number | null; measured?: number | readonly number[] | null; eta?: number | readonly number[] | null; arithmeticContractOk?: boolean; measurementDomainOk?: boolean },
): Evidence;
export declare function checkDraw(
  tau: number | null | undefined,
  rho: Vec3,
  r: Vec3,
  A64: number[][],
  contract?: string,
  options?: { expression?: string | null; measured?: number | readonly number[] | null; eta?: number | readonly number[] | null; measurementDomainOk?: boolean },
): CheckResult;
export declare class UnsupportedDraw extends Error {}
export declare class InvalidEvidence extends Error {}
export declare const CONTRACTS: Readonly<Record<Contract, number>>;
export declare const SUPPORTED_EXPRESSIONS: Readonly<Record<string, string>>;
export declare const HOST_INFLATION: number;
export declare const LAMBDA: number;
