// A lightweight contract for gameplay systems that Game owns and drives.
//
// Game.ts has historically been one large orchestrator: every subsystem is a
// field, and the single update() method calls each one in code order. That is
// fine for the systems that already exist, but it means every NEW feature grows
// the same 2000-line file. This interface + the registry below give new systems
// a place to live so they plug in without editing Game's update body.
//
// Existing systems are NOT being retro-fitted onto this; the win is purely that
// new content (FX pools, world content, activities) registers here instead of
// adding another hand-wired line to update(). Registration is explicit and
// ordered because the fixed-timestep sim cares about update order.

/** Something Game can advance once per fixed sim step and tear down on dispose. */
export interface GameSystem {
  /** Advance one fixed simulation step. */
  update(dt: number): void
  /** Free any GPU resources / scene objects this system owns. */
  dispose(): void
  /** Optional: react to a zone change (earth/mars/moon). */
  setZone?(zone: import('./types').Zone): void
}

/**
 * An ordered set of systems. Game holds one of these and calls update()/dispose()
 * on it, so adding a system is a single register() call rather than edits spread
 * across the constructor, update, and dispose.
 */
export class SystemRegistry {
  private systems: GameSystem[] = []

  /** Add a system (kept in registration order) and return it for convenience. */
  register<T extends GameSystem>(system: T): T {
    this.systems.push(system)
    return system
  }

  /** Advance every registered system in order. */
  update(dt: number) {
    for (const s of this.systems) s.update(dt)
  }

  /** Forward a zone change to systems that care. */
  setZone(zone: import('./types').Zone) {
    for (const s of this.systems) s.setZone?.(zone)
  }

  /** Dispose in reverse registration order (mirrors typical teardown). */
  dispose() {
    for (let i = this.systems.length - 1; i >= 0; i--) this.systems[i].dispose()
    this.systems = []
  }
}
