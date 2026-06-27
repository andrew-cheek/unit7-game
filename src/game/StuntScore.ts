// Stunt scoring — turns every jump, ramp, trampoline and gravity-lift into a
// trick opportunity. While airborne it tracks airtime, total accumulated spin
// (yaw rotation) and peak height above the takeoff point; on landing it names
// the trick (BIG AIR / 360 / BACKFLIP / TRIPLE SPIN / HANG TIME), pays style
// credits + XP scaled by the trick, and chains a combo multiplier if you keep
// landing tricks back-to-back without idling. Plain walking never triggers:
// the airtime + (big-air OR spin) gate filters out hops and ledge walk-offs.
//
// Pure logic, no scene objects, zero per-frame allocation. Reads player state
// through accessors and pays out via onStunt (same pattern as TraversalScore).

import * as THREE from 'three'
import type { GameSystem } from './System'

export interface Deps {
  /** Player world position (for popup placement). */
  focus: () => THREE.Vector3
  /** On the ground. */
  grounded: () => boolean
  /** Player facing in radians (to measure spins). */
  yaw: () => number
  /** Player velocity (to gate on real air, not tiny hops). */
  velocity: () => THREE.Vector3
  /** Reward + popup: credits, xp, popup x/y/z and the trick label. */
  onStunt: (credits: number, xp: number, x: number, y: number, z: number, label: string) => void
}

const TWO_PI = Math.PI * 2

export class StuntScore implements GameSystem {
  private airborne = false
  private prevGrounded = true
  private lastYaw = 0

  // Per-flight accumulators.
  private takeoffY = 0
  private airtime = 0
  private spin = 0 // total |yaw delta| accumulated, radians
  private peakY = 0

  // Combo chaining.
  private combo = 0
  private comboTimer = 0 // seconds of grace left to chain the next trick

  // Tunables.
  private static readonly MIN_AIRTIME = 0.7 // seconds aloft to count at all
  private static readonly MIN_BIG_AIR = 2.5 // metres gained to count as air
  private static readonly MIN_SPINS = 0.6 // full rotations to count as a spin
  private static readonly COMBO_GRACE = 3.0 // seconds to land the next trick
  private static readonly COMBO_STEP = 0.5 // +0.5x per chained trick
  private static readonly MAX_COMBO_MULT = 4 // multiplier ceiling
  private static readonly MAX_CREDITS = 240 // payout clamp

  constructor(private deps: Deps) {}

  update(dt: number) {
    const grounded = this.deps.grounded()
    const yaw = this.deps.yaw()
    const y = this.deps.focus().y

    // Bleed the combo grace while on the ground; idle too long and the chain
    // resets so back-to-back means back-to-back.
    if (grounded && this.comboTimer > 0) {
      this.comboTimer -= dt
      if (this.comboTimer <= 0) {
        this.comboTimer = 0
        this.combo = 0
      }
    }

    // Takeoff: grounded true -> false. Start a fresh flight.
    if (this.prevGrounded && !grounded) {
      this.airborne = true
      this.takeoffY = y
      this.peakY = y
      this.airtime = 0
      this.spin = 0
      this.lastYaw = yaw
    }

    if (this.airborne && !grounded) {
      this.airtime += dt
      if (y > this.peakY) this.peakY = y
      // Smallest signed yaw delta since last frame, wrapped to (-π, π] so a
      // continuous spin accumulates and crossing ±π adds no bogus jump.
      let d = yaw - this.lastYaw
      d -= TWO_PI * Math.floor((d + Math.PI) / TWO_PI) // wrap to [-π, π)
      this.spin += Math.abs(d)
      this.lastYaw = yaw
    }

    // Landing: grounded false -> true. Evaluate the trick.
    if (this.airborne && !this.prevGrounded && grounded) {
      this.airborne = false
      this.evaluate()
    }

    this.prevGrounded = grounded
  }

  private evaluate() {
    const bigAir = this.peakY - this.takeoffY // metres gained
    const spins = this.spin / TWO_PI // full rotations

    // Real trick? Otherwise it was a hop or a walk-off — pay nothing.
    const isTrick =
      this.airtime > StuntScore.MIN_AIRTIME &&
      (bigAir > StuntScore.MIN_BIG_AIR || spins > StuntScore.MIN_SPINS)
    if (!isTrick) return

    // Score scales with the trick: airtime base + spin/air bonuses.
    let credits = Math.round(this.airtime * 8 + spins * 15 + bigAir * 2)

    // Combo: refresh the chain and apply a modest, capped multiplier.
    this.combo += 1
    this.comboTimer = StuntScore.COMBO_GRACE
    const mult = Math.min(
      StuntScore.MAX_COMBO_MULT,
      1 + (this.combo - 1) * StuntScore.COMBO_STEP,
    )
    credits = Math.min(StuntScore.MAX_CREDITS, Math.round(credits * mult))
    const xp = Math.max(1, Math.round(credits * 0.5))

    // Name the trick by its dominant component.
    let label: string
    if (spins >= 1.5) label = 'TRIPLE SPIN'
    else if (spins >= 0.9) label = bigAir > 4 ? 'BACKFLIP' : '360'
    else if (bigAir > 6) label = 'BIG AIR'
    else if (this.airtime > 2.2) label = 'HANG TIME'
    else label = 'STUNT'
    if (this.combo > 1) label += `  x${this.combo}`

    const f = this.deps.focus()
    this.deps.onStunt(credits, xp, f.x, this.peakY + 1.6, f.z, label)
  }

  dispose() {}
}
