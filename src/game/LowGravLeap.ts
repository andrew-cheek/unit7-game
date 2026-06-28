import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

/**
 * LowGravLeap: an off-world (Moon + Mars only) LOW-GRAVITY LEAP COURSE.
 *
 * A chain of floating glowing rings climbs in a gentle ascending arc above the
 * surface, spaced and heighted for the big, floaty jumps the low planet gravity
 * affords. Pass THROUGH the bright "next" ring and it advances the chain, pays a
 * small credits/XP reward, and lights the following ring to beckon you on.
 * Clearing the whole chain pays a bigger completion bonus, then the course
 * re-arms at a fresh seeded layout. Missing the next ring for a while (or just
 * never reaching it) quietly resets the chain to ring 0 — no penalty, kid-safe.
 *
 * It is ACTIVE + visible only on moon/mars (driven by deps.zone() every frame
 * and setZone); on Earth the group is hidden and no reward checks run. The two
 * worlds get distinct palettes (Moon cyan/white, Mars warm amber).
 *
 * Perf: rings share one additive torus geo + one solid frame geo. Per-ring
 * material instances are needed only to pulse the active ring's opacity, but the
 * geometry/material set is fixed and fully disposed. Ring tests are O(n)
 * squared-distance against the player using a single reused scratch vector — no
 * per-frame heap allocation. No colliders: rings are pure visuals, so the player
 * can never be trapped.
 *
 * Constructor deps (the orchestrator wires onReward to credits/XP/popup/audio):
 *   {
 *     playerPos: () => THREE.Vector3,        // player world position (read each step)
 *     zone:      () => Zone,                  // current zone; gate active/visible on moon/mars
 *     groundY:   (x: number, z: number) => number, // surface height at XZ (rings float above it)
 *     onReward:  (credits: number, xp: number, x: number, y: number, z: number, label: string) => void,
 *   }
 */
interface Deps {
  /** Player world position (read each step; not mutated). */
  playerPos: () => THREE.Vector3
  /** Current zone — the course only runs/shows on 'moon' or 'mars'. */
  zone: () => Zone
  /** Surface height at an XZ so every ring floats a fixed amount above ground. */
  groundY: (x: number, z: number) => number
  /** Award (credits, xp) and pop a floating label at a world point. */
  onReward: (credits: number, xp: number, x: number, y: number, z: number, label: string) => void
}

interface Ring {
  /** Bright additive torus (its opacity is pulsed when this is the active ring). */
  glow: THREE.Mesh
  /** Thin solid frame so the ring still reads against bright skies / bloom. */
  frame: THREE.Mesh
  /** Per-ring glow material (instanced so only the active ring can pulse). */
  mat: THREE.MeshBasicMaterial
  pos: THREE.Vector3
}

interface Palette {
  glow: number // additive torus tint
  frame: number // solid frame tint
}

// Distinct feel per world: Moon reads icy cyan/white, Mars warm amber/orange.
const MOON_PAL: Palette = { glow: 0x7fe9ff, frame: 0xeafcff }
const MARS_PAL: Palette = { glow: 0xffb14a, frame: 0xffd98a }

const RING_R = 3.2 // ring radius (m) — generous so floaty jumps thread it easily
const HIT = RING_R + 1.4 // pass radius (3D distance from player to ring centre)
const MISS_RESET = 9 // seconds without clearing the next ring before the chain resets

// Heights/spacings chosen for low-grav arcs: a gentle ascending climb that
// crests then eases back down, so each leap carries naturally into the next.
const RING_COUNT_LOW = 4
const RING_COUNT_MED = 6
const RING_COUNT_HIGH = 8

/** Small deterministic PRNG so each re-armed layout is stable within a run. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class LowGravLeap implements GameSystem {
  private group = new THREE.Group()
  private rings: Ring[] = []
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private torusGeo: THREE.TorusGeometry
  private frameGeo: THREE.TorusGeometry
  private frameMat: THREE.MeshBasicMaterial

  private zone: Zone = 'earth'
  private count: number
  private seed = 0x9e3779b1 // advances on each re-arm for a fresh layout

  private current = 0 // index of the next ring to pass
  private chain = 0 // rings passed this run (the combo)
  private sinceProgress = 0 // seconds since the last successful pass (miss timer)
  private t = 0
  private built = false // rings positioned for the active off-world zone yet?

  // Scratch reused every step — update() allocates nothing.
  private readonly tmp = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    this.count = tier === 'low' ? RING_COUNT_LOW : tier === 'medium' ? RING_COUNT_MED : RING_COUNT_HIGH

    // Glow detail (tube segments) scales with tier; counts are tier-gated above.
    const radial = tier === 'low' ? 8 : tier === 'medium' ? 12 : 16
    const tubular = tier === 'low' ? 20 : tier === 'medium' ? 28 : 36
    this.torusGeo = this.ownG(new THREE.TorusGeometry(RING_R, 0.42, radial, tubular))
    // A thinner torus as a crisp solid frame so the ring still reads over bloom.
    this.frameGeo = this.ownG(new THREE.TorusGeometry(RING_R, 0.12, 6, tubular))
    this.frameMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, fog: true }))

    for (let i = 0; i < this.count; i++) {
      const mat = this.own(new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }))
      const glow = new THREE.Mesh(this.torusGeo, mat)
      const frame = new THREE.Mesh(this.frameGeo, this.frameMat)
      frame.renderOrder = 1
      const pos = new THREE.Vector3()
      this.group.add(glow)
      this.group.add(frame)
      this.rings.push({ glow, frame, mat, pos })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    const off = zone === 'moon' || zone === 'mars'
    this.group.visible = off
    // Surfaces for a just-entered planet are only correct a frame later, so the
    // actual ring layout is (re)built lazily in update() — flag a rebuild.
    this.built = false
    this.resetChain()
  }

  private palette(): Palette {
    return this.zone === 'mars' ? MARS_PAL : MOON_PAL
  }

  /**
   * Lay the chain out as a gentle ascending-then-cresting arc tuned for big
   * low-grav leaps. Seeded so a layout is stable; the seed advances on each
   * re-arm so a completed course respawns somewhere fresh.
   */
  private build() {
    const rnd = mulberry32(this.seed)
    const pal = this.palette()
    this.frameMat.color.setHex(pal.frame)

    // Anchor the run near a seeded spot, then walk outward along a wandering
    // heading. Spacing is wide (low grav = long jumps) and rings rise in a
    // smooth bell so the route climbs into the sky and settles back down.
    const startAngle = rnd() * Math.PI * 2
    const radius0 = 26 + rnd() * 30
    let x = Math.cos(startAngle) * radius0
    let z = Math.sin(startAngle) * radius0
    let heading = startAngle + (rnd() - 0.5) * 1.2
    const span = this.count - 1 || 1

    for (let i = 0; i < this.count; i++) {
      // Bell-shaped height profile: low at the ends, cresting in the middle.
      const t = i / span // 0..1
      const arc = Math.sin(t * Math.PI) // 0..1..0
      const h = 6 + arc * 16 // 6m at the ends up to ~22m at the crest
      const gy = this.deps.groundY(x, z)
      const ring = this.rings[i]
      ring.pos.set(x, gy + h, z)
      ring.glow.position.copy(ring.pos)
      ring.frame.position.copy(ring.pos)
      ring.mat.color.setHex(pal.glow)

      // Aim each ring like a doorway toward the next so it reads as a gate.
      // Step to the next ring's XZ before orienting; the last inherits the prior.
      const step = 18 + rnd() * 8 // wide gaps suit floaty jumps
      heading += (rnd() - 0.5) * 0.9
      const nx = x + Math.cos(heading) * step
      const nz = z + Math.sin(heading) * step
      if (i < this.count - 1) {
        const ny = this.deps.groundY(nx, nz) + (6 + Math.sin(((i + 1) / span) * Math.PI) * 16)
        this.tmp.set(nx, ny, nz)
        ring.glow.lookAt(this.tmp)
        ring.frame.quaternion.copy(ring.glow.quaternion)
      } else if (i > 0) {
        ring.glow.quaternion.copy(this.rings[i - 1].glow.quaternion)
        ring.frame.quaternion.copy(ring.glow.quaternion)
      }
      x = nx
      z = nz
    }
    this.built = true
    this.refreshGlow()
  }

  /** Brighten the active target ring; dim the rest. */
  private refreshGlow() {
    for (let i = 0; i < this.rings.length; i++) {
      this.rings[i].mat.opacity = i === this.current ? 1 : 0.4
      this.rings[i].glow.scale.setScalar(1)
    }
  }

  private resetChain() {
    this.current = 0
    this.chain = 0
    this.sinceProgress = 0
  }

  /** Re-seed and rebuild after a full clear so the course respawns fresh. */
  private rearm() {
    this.seed = (Math.imul(this.seed, 0x6d2b79f5) ^ 0x9e3779b1) >>> 0
    this.resetChain()
    this.built = false
  }

  update(dt: number) {
    const off = this.zone === 'moon' || this.zone === 'mars'
    if (this.group.visible !== off) this.group.visible = off
    if (!off) return

    // (Re)build once the just-entered planet's surfaces are live.
    if (!this.built) this.build()

    this.t += dt

    const target = this.rings[this.current]

    // Pulse the active ring so the next beckon-point is obvious at a glance.
    if (target) {
      const pulse = 0.7 + 0.3 * Math.abs(Math.sin(this.t * 3.2))
      target.mat.opacity = pulse
      target.glow.scale.setScalar(1.05 + 0.05 * Math.sin(this.t * 3.2))
    }

    // Miss handling: if the chain is underway and the player hasn't cleared the
    // next ring in a while, quietly reset to the start (no penalty, just resets).
    if (this.chain > 0) {
      this.sinceProgress += dt
      if (this.sinceProgress >= MISS_RESET) {
        this.resetChain()
        this.refreshGlow()
        return
      }
    }

    if (!target) return
    const p = this.deps.playerPos()
    this.tmp.copy(target.pos).sub(p)
    if (this.tmp.lengthSq() < HIT * HIT) {
      // Passed the active ring: advance, grow the combo, pay a modest reward.
      this.current++
      this.chain++
      this.sinceProgress = 0
      // Modest, economy-safe payout that grows a little with the combo.
      const credits = 8 + 4 * (this.chain - 1)
      const xp = 4 + 2 * (this.chain - 1)
      this.deps.onReward(credits, xp, target.pos.x, target.pos.y + 1.5, target.pos.z, `+${credits}c`)
      target.glow.scale.setScalar(1.5) // brief pop, eased back below

      if (this.current >= this.rings.length) {
        // Whole chain cleared: a slightly bigger completion bonus, then re-arm.
        const bonus = 40 + 10 * this.chain
        this.deps.onReward(bonus, Math.round(bonus * 0.5), p.x, p.y + 2, p.z, `LEAP CHAIN x${this.chain}!`)
        this.rearm()
        return
      }
      this.refreshGlow()
    }

    // Ease any per-pass pop back toward rest on the non-active rings.
    for (let i = 0; i < this.rings.length; i++) {
      if (i === this.current) continue
      const s = this.rings[i].glow.scale.x
      if (s > 1.001) this.rings[i].glow.scale.setScalar(Math.max(1, s - dt * 3))
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
