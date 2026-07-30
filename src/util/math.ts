export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function saturate(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function remap(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);
}

/** Hermite ease between two edges, clamped. Matches GLSL smoothstep. */
export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = saturate((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach. `lambda` is roughly how many
 * e-foldings per second, so higher is snappier. Prefer this to a lerp with a
 * fixed alpha, which changes feel with frame rate.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export interface SpringState {
  velocity: number;
}

/**
 * One step of a damped spring, solved semi-implicitly so it stays stable at any
 * dt. `omega` is angular frequency in rad/s; `zeta` is the damping ratio, where
 * 1 is critically damped and below 1 overshoots.
 */
export function spring(
  current: number,
  target: number,
  state: SpringState,
  omega: number,
  zeta: number,
  dt: number,
): number {
  const f = 1 + 2 * dt * zeta * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * current + dt * state.velocity + hhoo * target;
  const detV = state.velocity + hoo * (target - current);
  state.velocity = detV * detInv;
  return detX * detInv;
}
