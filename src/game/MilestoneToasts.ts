import type { GameSystem } from './System'

/**
 * Watches the player's running stats and fires a celebratory banner + popup the
 * first time they cross meaningful milestones (captures, credits, level-ups).
 * Logic only: no meshes. Each milestone fires at most once per session, one toast
 * per update with a short cooldown so a burst spreads out instead of stacking.
 */

interface Deps {
  stats: () => { captured: number; credits: number; level: number }
  banner: (text: string) => void
  notify: (text: string) => void // a celebratory popup at the player (caller positions it)
}

// Constant module-level tables: iterate by index, never rebuilt per frame.
const CAPTURES = [1, 5, 10, 25, 50, 100]
const CREDITS = [1000, 5000, 10000, 50000]
const LEVELS = [5, 10, 20, 30]

const COOLDOWN = 1.5

export class MilestoneToasts implements GameSystem {
  private fired = new Set<string>()
  private seeded = false
  private cooldown = 0

  constructor(private deps: Deps) {}

  update(dt: number): void {
    const s = this.deps.stats()

    // First update: snapshot baseline. Any milestone already at-or-below the
    // current value is marked fired so resuming a save doesn't spam old toasts.
    if (!this.seeded) {
      this.seeded = true
      for (let i = 0; i < CAPTURES.length; i++) if (s.captured >= CAPTURES[i]) this.fired.add('cap:' + CAPTURES[i])
      for (let i = 0; i < CREDITS.length; i++) if (s.credits >= CREDITS[i]) this.fired.add('cr:' + CREDITS[i])
      for (let i = 0; i < LEVELS.length; i++) if (s.level >= LEVELS[i]) this.fired.add('lv:' + LEVELS[i])
      return
    }

    if (this.cooldown > 0) {
      this.cooldown -= dt
      return
    }

    // Fire at most one newly-reached milestone per update; the rest wait for
    // subsequent frames so several crossing at once don't stack on screen.
    for (let i = 0; i < CAPTURES.length; i++) {
      const v = CAPTURES[i]
      const key = 'cap:' + v
      if (s.captured >= v && !this.fired.has(key)) {
        this.fire(key, '★ ' + format(v) + (v === 1 ? ' CAPTURE' : ' CAPTURES'))
        return
      }
    }
    for (let i = 0; i < CREDITS.length; i++) {
      const v = CREDITS[i]
      const key = 'cr:' + v
      if (s.credits >= v && !this.fired.has(key)) {
        this.fire(key, '★ ' + format(v) + ' CREDITS')
        return
      }
    }
    for (let i = 0; i < LEVELS.length; i++) {
      const v = LEVELS[i]
      const key = 'lv:' + v
      if (s.level >= v && !this.fired.has(key)) {
        this.fire(key, '★ LEVEL ' + v)
        return
      }
    }
  }

  private fire(key: string, text: string): void {
    this.fired.add(key)
    this.cooldown = COOLDOWN
    this.deps.banner(text)
    this.deps.notify(text)
  }

  dispose(): void {
    // No scene objects to free.
  }
}

/** Group digits with thousands separators (e.g. 5000 -> "5,000"). */
function format(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
