// Style combo — turns the movement kit into a playground. Expressive traversal
// (airborne, jetpacking, boarding, gliding in plane form, at speed) builds a
// style meter with a climbing multiplier; the longer you keep the flow alive
// the higher it goes. Touch down and coast for a beat and the combo banks into
// credits + XP. Plain ground running does NOT build it, so it rewards using the
// jetpack/board/plane rather than holding W.
//
// Pure logic, no scene objects, zero per-frame allocation. Reads player state
// through accessors (same pattern as Collectibles) and pays out via onBank.

import type { GameSystem } from './System'

export interface TraversalHost {
  /** On foot and in control (not piloting a vehicle). */
  active(): boolean
  /** Horizontal speed, m/s. */
  speed(): number
  grounded(): boolean
  /** Jetpack actively thrusting (held + airborne). */
  jetting(): boolean
  boarding(): boolean
  /** Morphed into the gliding plane form. */
  plane(): boolean
  /** Bank a completed combo: credits + XP, plus the multiplier + raw points for the banner. */
  onBank(credits: number, xp: number, mult: number, points: number): void
}

export class TraversalScore implements GameSystem {
  private host: TraversalHost
  private points = 0
  private flowTime = 0 // continuous seconds in flow (drives the multiplier)
  private breakTimer = 0 // seconds since flow last broke (grace before banking)
  private comboActive = false

  // Tunables.
  private static readonly SPEED_MIN = 4 // must be moving to count
  private static readonly BANK_GRACE = 1.0 // seconds grounded/idle before banking
  private static readonly MIN_BANK = 40 // raw points below this bank nothing
  private static readonly MAX_MULT = 5

  constructor(host: TraversalHost) {
    this.host = host
  }

  private mult(): number {
    return Math.min(TraversalScore.MAX_MULT, 1 + this.flowTime * 0.35)
  }

  /** Live combo state for the HUD meter. */
  combo(): { active: boolean; points: number; mult: number } {
    return { active: this.comboActive, points: Math.round(this.points), mult: this.mult() }
  }

  update(dt: number) {
    const speed = this.host.speed()
    const inFlow =
      this.host.active() &&
      speed > TraversalScore.SPEED_MIN &&
      (!this.host.grounded() || this.host.boarding() || this.host.plane() || this.host.jetting())

    if (inFlow) {
      this.breakTimer = 0
      this.flowTime += dt
      // Style rate climbs with speed and rewards air time over grinding low.
      const rate = 8 + speed * 0.7 + (this.host.grounded() ? 0 : 6)
      this.points += rate * dt
      this.comboActive = this.points > 30
      return
    }

    // Flow broken: hold the meter briefly (chain across a quick touchdown), then bank.
    if (this.points > 0) {
      this.breakTimer += dt
      if (this.breakTimer >= TraversalScore.BANK_GRACE) this.bank()
    } else {
      this.flowTime = 0
      this.comboActive = false
    }
  }

  private bank() {
    const mult = this.mult()
    const pts = this.points
    if (pts >= TraversalScore.MIN_BANK) {
      const credits = Math.round((pts * mult) / 9)
      const xp = Math.max(2, Math.round((pts * mult) / 36))
      this.host.onBank(credits, xp, mult, Math.round(pts))
    }
    this.points = 0
    this.flowTime = 0
    this.breakTimer = 0
    this.comboActive = false
  }

  dispose() {
    /* pure logic; nothing to free */
  }
}
