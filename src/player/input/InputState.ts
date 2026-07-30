/**
 * The one shape every input source writes and the player reads, so desktop and
 * touch never diverge and adding a gamepad later means one more writer.
 *
 * Look deltas accumulate between frames and are zeroed when consumed; movement
 * axes are a continuous intent that the player smooths into velocity itself.
 */
export interface InputState {
  /** Accumulated yaw request in radians. Positive turns right. */
  lookDeltaYaw: number;
  /** Accumulated pitch request in radians. Positive looks down. */
  lookDeltaPitch: number;
  /** -1 back .. 1 forward. */
  moveForward: number;
  /** -1 left .. 1 right. */
  moveRight: number;
  /** Slightly faster stroll. */
  boost: boolean;
}

export function createInputState(): InputState {
  return {
    lookDeltaYaw: 0,
    lookDeltaPitch: 0,
    moveForward: 0,
    moveRight: 0,
    boost: false,
  };
}

export function consumeLook(state: InputState, out: { yaw: number; pitch: number }): void {
  out.yaw = state.lookDeltaYaw;
  out.pitch = state.lookDeltaPitch;
  state.lookDeltaYaw = 0;
  state.lookDeltaPitch = 0;
}
