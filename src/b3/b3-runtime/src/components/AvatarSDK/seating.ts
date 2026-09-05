/**
 * Rig seating — best-fit transform that maps one skeleton onto another.
 *
 * When a head part and a body part come from *different* characters (e.g. a
 * "male-02" head on the "male" body) their skeletons are authored in different
 * rest spaces, so dropping the head at the origin does not seat it on the
 * neck. This module solves the rigid + uniform-scale transform
 *
 *     q ≈ s · R · p + t        (Umeyama / Kabsch alignment)
 *
 * that maps the source (head) skeleton's shared bone rest positions `p` onto
 * the target (body) skeleton's `q`. The caller applies the result as a static
 * "seat" wrapper around the head scene before the per-frame offset nudge, so
 * identity user-offsets read as "head seated on the neck" even across
 * characters.
 *
 * Pure math on plain arrays — no `three` runtime import, so it is unit-testable
 * outside the renderer.
 */

export interface SeatPoints {
  /** [n][3] source (head) bone rest positions. */
  source: number[][]
  /** [n][3] target (body) bone rest positions, same order. */
  target: number[][]
}

export interface SeatResult {
  /** Row-major 3×3 rotation `R`. */
  rotation: number[]
  /** Uniform scale `s`. */
  scale: number
  /** Translation `t`. */
  position: number[]
  /** Mean per-point residual after fit (diagnostics). */
  residual: number
  /** Number of shared bones used. */
  points: number
}

const EPS = 1e-12

function mean(pts: number[][]): number[] {
  const out = [0, 0, 0]
  if (!pts.length) return out
  for (const p of pts) for (let i = 0; i < 3; i++) out[i] += p[i]
  return out.map((v) => v / pts.length)
}

function det3(m: number[]): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  )
}

function mul3(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]
  return o
}

function transpose3(m: number[]): number[] {
  const o = new Array(9).fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = m[c * 3 + r]
  return o
}

/**
 * Cyclic-Jacobi eigendecomposition of a real symmetric 3×3 matrix (row-major).
 * Each sweep applies a plane rotation as a full similarity `A ← J^T A J` using
 * scratch copies (exact, symmetry-preserving). Returns eigenvalues (descending)
 * and matching eigenvectors as columns.
 */
function jacobiSym3(m: number[]): { values: number[]; vec: number[] } {
  let a = m.slice()
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]

  for (let iter = 0; iter < 50; iter++) {
    let p = 0
    let q = 1
    let max = 0
    for (let r = 0; r < 3; r++)
      for (let c = r + 1; c < 3; c++) {
        const av = Math.abs(a[r * 3 + c])
        if (av > max) {
          max = av
          p = r
          q = c
        }
      }
    if (max < 1e-14) break

    const apq = a[p * 3 + q]
    const tau = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
    const t = tau === 0 ? 1 : Math.sign(tau) / (Math.abs(tau) + Math.hypot(1, tau))
    const c = 1 / Math.hypot(1, t)
    const s = t * c

    // A ← L·A  (rotate rows p,q across all columns), then A ← (L·A)·Lᵀ.
    const b = a.slice()
    for (let k = 0; k < 3; k++) {
      const aPk = a[p * 3 + k]
      const aQk = a[q * 3 + k]
      b[p * 3 + k] = c * aPk - s * aQk
      b[q * 3 + k] = s * aPk + c * aQk
    }
    const d = b.slice()
    for (let k = 0; k < 3; k++) {
      const bP = b[k * 3 + p]
      const bQ = b[k * 3 + q]
      d[k * 3 + p] = c * bP - s * bQ
      d[k * 3 + q] = s * bP + c * bQ
    }
    a = d

    // Accumulate eigenvectors V ← V · J
    for (let k = 0; k < 3; k++) {
      const vkp = v[k * 3 + p]
      const vkq = v[k * 3 + q]
      v[k * 3 + p] = c * vkp - s * vkq
      v[k * 3 + q] = s * vkp + c * vkq
    }
  }

  const values = [a[0], a[4], a[8]]
  const order = [0, 1, 2].sort((i, j) => values[j] - values[i])
  const sortedV = order.map((k) => values[k])
  const sortedVec = new Array(9)
  for (let col = 0; col < 3; col++) {
    const k = order[col]
    sortedVec[col] = v[k]
    sortedVec[3 + col] = v[3 + k]
    sortedVec[6 + col] = v[6 + k]
  }
  return { values: sortedV, vec: sortedVec }
}

/**
 * Solves the Umeyama alignment for paired 3D points: returns `R` (row-major),
 * uniform `s`, and `t` such that `q ≈ s·R·p + t`.
 */
export function solveRigAlign(points: SeatPoints): SeatResult {
  const n = Math.min(points.source.length, points.target.length)
  const src = points.source.slice(0, n)
  const tgt = points.target.slice(0, n)

  if (n < 2) {
    const ps = mean(src)
    const qt = mean(tgt)
    return {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      scale: 1,
      position: qt.map((v, i) => v - ps[i]),
      residual: 0,
      points: n,
    }
  }

  const pMean = mean(src)
  const qMean = mean(tgt)
  const a = src.map((p) => [p[0] - pMean[0], p[1] - pMean[1], p[2] - pMean[2]])
  const b = tgt.map((q) => [q[0] - qMean[0], q[1] - qMean[1], q[2] - qMean[2]])

  // Covariance H = Σ a_i b_i^T ; M = H^T H for the V basis.
  const h = new Array(9).fill(0)
  let denom = 0
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 3; r++) {
      denom += a[i][r] * a[i][r]
      for (let c = 0; c < 3; c++) h[r * 3 + c] += a[i][r] * b[i][c]
    }
  }
  const m = new Array(9).fill(0)
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) m[r * 3 + c] += h[k * 3 + r] * h[k * 3 + c]

  const { values, vec } = jacobiSym3(m)
  // vec: column k = vec[k], vec[3+k], vec[6+k]  (row-major storage).
  const vCols = [
    [vec[0], vec[3], vec[6]],
    [vec[1], vec[4], vec[7]],
    [vec[2], vec[5], vec[8]],
  ]
  const svals = values.map((x) => Math.sqrt(Math.max(0, x)))

  // Unit-length eigenvectors with det(V)=+1: Jacobi hands back an arbitrary
  // handedness, so flip the smallest direction's sign when needed.
  for (const c of vCols) {
    const nl = Math.hypot(c[0], c[1], c[2])
    if (nl > EPS) for (let i = 0; i < 3; i++) c[i] /= nl
  }
  const detV = det3([
    vCols[0][0], vCols[1][0], vCols[2][0],
    vCols[0][1], vCols[1][1], vCols[2][1],
    vCols[0][2], vCols[1][2], vCols[2][2],
  ])
  if (detV < 0) for (let i = 0; i < 3; i++) vCols[2][i] *= -1

  // U from the SVD identity u_k = H·v_k / σ_k, then Gram–Schmidt. When the data
  // is congruent (source ≡ target) this reproduces U = V and R = identity.
  const uCols = vCols.map((v, k) => {
    if (svals[k] <= EPS) return null
    const ux = h[0] * v[0] + h[1] * v[1] + h[2] * v[2]
    const uy = h[3] * v[0] + h[4] * v[1] + h[5] * v[2]
    const uz = h[6] * v[0] + h[7] * v[1] + h[8] * v[2]
    const nl = Math.hypot(ux, uy, uz)
    return nl > EPS ? [ux / nl, uy / nl, uz / nl] : null
  })

  const done: number[][] = []
  for (let k = 0; k < 3; k++) {
    const col = uCols[k] ?? (k === 0 ? [1, 0, 0] : k === 1 ? [0, 1, 0] : [0, 0, 1])
    for (const d0 of done) {
      const dp = col[0] * d0[0] + col[1] * d0[1] + col[2] * d0[2]
      for (let i = 0; i < 3; i++) col[i] -= dp * d0[i]
    }
    let nl = Math.hypot(col[0], col[1], col[2])
    if (nl < EPS && k >= 2) {
      const a0 = done[0]
      const a1 = done[1]
      col[0] = a0[1] * a1[2] - a0[2] * a1[1]
      col[1] = a0[2] * a1[0] - a0[0] * a1[2]
      col[2] = a0[0] * a1[1] - a0[1] * a1[0]
      nl = Math.hypot(col[0], col[1], col[2])
    }
    if (nl > EPS) for (let i = 0; i < 3; i++) col[i] /= nl
    done.push(col)
  }
  const [u0, u1, u2] = done

  const U = [
    u0[0], u1[0], u2[0],
    u0[1], u1[1], u2[1],
    u0[2], u1[2], u2[2],
  ]
  const V = [
    vCols[0][0], vCols[1][0], vCols[2][0],
    vCols[0][1], vCols[1][1], vCols[2][1],
    vCols[0][2], vCols[1][2], vCols[2][2],
  ]

  // Umeyama: R = V·S·Uᵀ. d = det(V)·det(U); when −1 the data wants a reflection
  // in the smallest direction, so S flips it and R stays a proper rotation.
  const d = det3(U) * det3(V)
  const S = [1, 0, 0, 0, 1, 0, 0, 0, d]
  const R = mul3(mul3(V, S), transpose3(U))

  const scale =
    denom > EPS ? (svals[0] + svals[1] + d * svals[2]) / denom : 1

  const Rp = [
    R[0] * pMean[0] + R[1] * pMean[1] + R[2] * pMean[2],
    R[3] * pMean[0] + R[4] * pMean[1] + R[5] * pMean[2],
    R[6] * pMean[0] + R[7] * pMean[1] + R[8] * pMean[2],
  ]
  const position = qMean.map((v, i) => v - scale * Rp[i])

  let sum = 0
  for (let i = 0; i < n; i++) {
    const px = scale * (R[0] * a[i][0] + R[1] * a[i][1] + R[2] * a[i][2])
    const py = scale * (R[3] * a[i][0] + R[4] * a[i][1] + R[5] * a[i][2])
    const pz = scale * (R[6] * a[i][0] + R[7] * a[i][1] + R[8] * a[i][2])
    sum += Math.hypot(px - b[i][0], py - b[i][1], pz - b[i][2])
  }

  return {
    rotation: R,
    scale,
    position,
    residual: sum / n,
    points: n,
  }
}

/**
 * Seats a head part onto a body using only the neck→head chain, which is the
 * region that actually has to line up for a head swap. This is deliberately a
 * *local* alignment:
 *
 * - scale = (target neck→head length) ÷ (source neck→head length), so a head
 *   authored for a slightly different character is resized to the body's head.
 * - translation places the source Head bone exactly on the target Head bone.
 * - rotation is left identity — cross-character spine orientations agree to a
 *   couple of degrees, and inferring rotation from the (near-collinear) spine
 *   is numerically unsafe. Residual orientation is left to the offset editor.
 *
 * Same-character pairs produce scale 1 and zero translation (identity seat).
 */
export interface HeadSeat {
  scale: number
  position: number[]
  rotation: number[]
}

export interface HeadSeatInput {
  /** Source (head-part) Head bone rest position. */
  head: number[]
  /** Source (head-part) Neck bone rest position. */
  neck: number[]
  /** Target (body) Head bone rest position. */
  targetHead: number[]
  /** Target (body) Neck bone rest position. */
  targetNeck: number[]
}

export function seatHeadAlign(input: HeadSeatInput): HeadSeat {
  const sLen = Math.hypot(
    input.neck[0] - input.head[0],
    input.neck[1] - input.head[1],
    input.neck[2] - input.head[2],
  )
  const tLen = Math.hypot(
    input.targetNeck[0] - input.targetHead[0],
    input.targetNeck[1] - input.targetHead[1],
    input.targetNeck[2] - input.targetHead[2],
  )
  let scale = sLen > 1e-6 && tLen > 1e-6 ? tLen / sLen : 1
  scale = Math.min(2, Math.max(0.5, scale))
  return {
    scale,
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    position: input.targetHead.map((v, i) => v - scale * input.head[i]),
  }
}
