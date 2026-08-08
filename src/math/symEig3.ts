/**
 * symEig3.ts — eigen-decomposition of a symmetric 3×3 matrix.
 *
 * Returns eigenvalues sorted DESCENDING (l0 ≥ l1 ≥ l2) with their unit
 * eigenvectors, the form point-cloud geometry descriptors need (the smallest
 * eigenvalue's vector is the surface normal; the ratios of the three are the
 * shape features). Classic cyclic Jacobi rotations — robust and exact for the
 * symmetric 3×3 case, no external solver. Pure and allocation-light.
 */

export interface SymEig3 {
  /** Eigenvalues, sorted descending: [l0 ≥ l1 ≥ l2]. */
  readonly values: [number, number, number];
  /** Unit eigenvectors aligned with `values` (vectors[i] ↔ values[i]). */
  readonly vectors: [[number, number, number], [number, number, number], [number, number, number]];
}

/**
 * Decompose a symmetric matrix given by its upper triangle
 * (axx, axy, axz, ayy, ayz, azz). The lower triangle is taken as the mirror.
 */
export function symEig3(axx: number, axy: number, axz: number, ayy: number, ayz: number, azz: number): SymEig3 {
  // Working symmetric matrix and accumulated rotation (columns = eigenvectors).
  const m = [
    [axx, axy, axz],
    [axy, ayy, ayz],
    [axz, ayz, azz],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 64; iter++) {
    // Largest off-diagonal magnitude.
    let p = 0, q = 1, max = Math.abs(m[0][1]);
    if (Math.abs(m[0][2]) > max) { max = Math.abs(m[0][2]); p = 0; q = 2; }
    if (Math.abs(m[1][2]) > max) { max = Math.abs(m[1][2]); p = 1; q = 2; }
    if (max < 1e-14) break;
    const phi = 0.5 * Math.atan2(2 * m[p][q], m[q][q] - m[p][p]);
    const c = Math.cos(phi), s = Math.sin(phi);
    for (let k = 0; k < 3; k++) {
      const mkp = m[k][p], mkq = m[k][q];
      m[k][p] = c * mkp - s * mkq;
      m[k][q] = s * mkp + c * mkq;
    }
    for (let k = 0; k < 3; k++) {
      const mpk = m[p][k], mqk = m[q][k];
      m[p][k] = c * mpk - s * mqk;
      m[q][k] = s * mpk + c * mqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p], vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  // Eigenvalues on the diagonal; columns of v are eigenvectors.
  const eig = [
    { val: m[0][0], vec: [v[0][0], v[1][0], v[2][0]] as [number, number, number] },
    { val: m[1][1], vec: [v[0][1], v[1][1], v[2][1]] as [number, number, number] },
    { val: m[2][2], vec: [v[0][2], v[1][2], v[2][2]] as [number, number, number] },
  ];
  eig.sort((a, b) => b.val - a.val); // descending
  const unit = (u: [number, number, number]): [number, number, number] => {
    const n = Math.hypot(u[0], u[1], u[2]) || 1;
    return [u[0] / n, u[1] / n, u[2] / n];
  };
  return {
    values: [eig[0].val, eig[1].val, eig[2].val],
    vectors: [unit(eig[0].vec), unit(eig[1].vec), unit(eig[2].vec)],
  };
}
