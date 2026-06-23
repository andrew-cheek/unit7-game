// Capture combo — a chain multiplier on the core capture loop. Net (or missile,
// or shared-claim) another alien within the window and the chain climbs, scaling
// the score + credits each capture pays out. Let the window lapse and it resets.
// A single capture is never penalised (chain of 1 = ×1); the reward is for
// stringing captures together, which pulls the player to hunt aggressively.
//
// Pure logic, zero allocation. The window is ticked in update(); captures are
// registered by Game, which reads back the multiplier to apply.

import { clamp } from './utils'
import type { GameSystem } from './System'

export class CaptureCombo implements GameSystem {
  private window = 0 // seconds left to keep the chain alive
  private chain = 0
  private static readonly WINDOW = 2.5
  private static readonly MAX_MULT = 5

  /** Multiplier for the current chain: ×1 (single), ×1.5 (2), ×2 (3) … capped ×5. */
  mult(): number {
    return this.chain <= 1 ? 1 : Math.min(CaptureCombo.MAX_MULT, 1 + (this.chain - 1) * 0.5)
  }

  /** Register a capture, extending/raising the chain, and return the multiplier
   *  to apply to THIS capture's payout. */
  registerCapture(): number {
    this.chain = this.window > 0 ? this.chain + 1 : 1
    this.window = CaptureCombo.WINDOW
    return this.mult()
  }

  /** HUD payload while a chain is live (>×1), else null so the indicator hides. */
  hud(): { mult: number; remaining01: number } | null {
    if (this.chain <= 1) return null
    return { mult: this.mult(), remaining01: clamp(this.window / CaptureCombo.WINDOW, 0, 1) }
  }

  update(dt: number) {
    if (this.window > 0) {
      this.window -= dt
      if (this.window <= 0) {
        this.window = 0
        this.chain = 0
      }
    }
  }

  dispose() {
    /* pure logic; nothing to free */
  }
}
