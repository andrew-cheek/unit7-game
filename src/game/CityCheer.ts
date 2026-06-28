import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Current zone, so cheers only fire on Earth. */
  zone: () => Zone
}

/**
 * City cheer: a reactive celebration layer. When the player does something
 * stylish near the crowd (a capture, a traversal-combo milestone), the Game
 * calls cheer(x,y,z,intensity) and the city throws a quick neon CONFETTI/SPARK
 * burst at that spot — particles fan up + outward, arc back down under gravity,
 * spin a little, and fade out over ~1.1s. Purely cosmetic: it never feeds
 * physics, so the spread can use Math.random freely.
 *
 * Draw-call budget: the whole particle pool is ONE InstancedMesh of a tiny quad.
 * At rest every particle is collapsed to a zero-scale matrix, so the system is
 * ~1 draw call and costs almost nothing when nothing is celebrating. Active
 * particles rebuild their per-instance matrix + instanceColor each frame from
 * reused scratch objects (no per-frame heap allocation). The pool is sized by
 * quality tier (high 80 / medium 48 / low 24) and the whole layer is Earth-gated;
 * leaving Earth clears active particles. Spawning past the pool size reuses the
 * oldest/dead slots, so a burst never allocates.
 *
 * Reduced motion: config.reducedMotion is read live. When set, a cheer is
 * SOFTENED into a calm sparkle — fewer particles, lower velocities, no spin,
 * gentler gravity and a slower rise — never an explosive pop or a flash.
 */

interface Particle {
  active: boolean
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  rot: number    // current spin angle
  spin: number   // angular velocity (0 under reduced motion)
  life: number   // seconds remaining
  ttl: number    // original lifetime, for fade/scale normalisation
  size: number   // base quad size for this particle
  tint: THREE.Color
}

const GRAVITY = 9.5            // downward accel on active particles (m/s^2)
const LIFE = 1.1              // base particle lifetime (seconds)
const QUAD = 0.16            // base quad edge (meters)
const RISE_MIN = 3.2         // upward launch speed floor
const RISE_VAR = 3.0         // + up to this much upward speed
const OUT_SPEED = 2.6        // outward (horizontal) launch speed scale
const SPIN_VAR = 8.0         // angular velocity spread (rad/s)

// Bright neon palette, picked per-particle at spawn (no allocation: copied into
// each particle's owned tint Color).
const PALETTE = [
  new THREE.Color(0x49e0ff),
  new THREE.Color(0x9bff6a),
  new THREE.Color(0xffd24a),
  new THREE.Color(0xff5ad0),
  new THREE.Color(0xb07cff),
  new THREE.Color(0xffffff),
]

export class CityCheer implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private particles: Particle[] = []
  private mesh!: THREE.InstancedMesh
  private cursor = 0       // round-robin start for finding free slots
  private activeCount = 0  // live particles this frame; drives needsUpdate flag

  // Per-frame scratch (no heap allocation in update()/cheer()).
  private readonly mtx = new THREE.Matrix4()
  private readonly mPos = new THREE.Vector3()
  private readonly mQuat = new THREE.Quaternion()
  private readonly mScl = new THREE.Vector3()
  private readonly mEuler = new THREE.Euler()
  private readonly scratch = new THREE.Color()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const n = tier === 'high' ? 80 : tier === 'medium' ? 48 : 24

    // Shared geometry: one tiny quad (a single plane) instanced for the whole pool.
    const geo = this.ownG(new THREE.PlaneGeometry(QUAD, QUAD))

    // One additive, double-sided material; per-particle brightness/tint rides on
    // instanceColor (dimmer colour reads like lower opacity as it fades).
    const mat = this.own(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }))

    this.mesh = new THREE.InstancedMesh(geo, mat, n)
    // Bursts can happen anywhere across the map; skip per-frame frustum tests.
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.group.add(this.mesh)

    // Pre-allocate every particle struct up front; cheer() only mutates them, so
    // spawning a burst never allocates.
    for (let i = 0; i < n; i++) {
      this.particles.push({
        active: false,
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        rot: 0, spin: 0,
        life: 0, ttl: LIFE,
        size: 1,
        tint: new THREE.Color(0xffffff),
      })
    }

    // Seed all-collapsed matrices once so the mesh renders as nothing on frame one.
    for (let i = 0; i < n; i++) {
      this.mtx.makeScale(0, 0, 0)
      this.mesh.setMatrixAt(i, this.mtx)
      this.mesh.setColorAt(i, this.scratch.setRGB(0, 0, 0))
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true

    this.group.visible = this.deps.zone() === 'earth'
    scene.add(this.group)
  }

  /**
   * Throw a cheer burst at a world position. `intensity` (0..1, default 0.6)
   * scales how many particles spawn and how big/fast the burst is. Earth-only;
   * a no-op off Earth. Allocation-free: claims free (or oldest) pooled slots and
   * mutates their pre-allocated structs in place.
   */
  cheer(x: number, y: number, z: number, intensity = 0.6) {
    if (this.deps.zone() !== 'earth') return

    const calm = config.reducedMotion
    const amt = Math.max(0, Math.min(1, intensity))

    // Particle count scales with intensity; reduced motion thins it out further so
    // it reads as a sparkle, not a pop. Always at least a couple so it's visible.
    const pool = this.particles.length
    const frac = calm ? 0.22 + amt * 0.28 : 0.4 + amt * 0.6
    const count = Math.max(2, Math.min(pool, Math.round(pool * frac)))

    // Burst energy: gentler everywhere under reduced motion.
    const sizeMul = (calm ? 0.7 : 1.0) * (0.8 + amt * 0.5)
    const riseMul = calm ? 0.45 : 1.0
    const outMul = calm ? 0.4 : 1.0
    const spinMul = calm ? 0 : 1.0
    const gravMul = calm ? 0.55 : 1.0

    for (let k = 0; k < count; k++) {
      const p = this.claimSlot()

      // Slight spawn jitter so particles don't all originate from one exact point.
      const jx = (Math.random() * 2 - 1) * 0.18
      const jz = (Math.random() * 2 - 1) * 0.18
      p.x = x + jx
      p.y = y + Math.random() * 0.1
      p.z = z + jz

      // Outward fan in a random horizontal direction + upward launch.
      const ang = Math.random() * Math.PI * 2
      const out = (0.3 + Math.random() * 0.7) * OUT_SPEED * outMul
      p.vx = Math.cos(ang) * out
      p.vz = Math.sin(ang) * out
      p.vy = (RISE_MIN + Math.random() * RISE_VAR) * riseMul

      p.rot = Math.random() * Math.PI * 2
      p.spin = (Math.random() * 2 - 1) * SPIN_VAR * spinMul

      // Reduced motion lives a touch longer and falls slower, for a soft drift.
      p.ttl = LIFE * (calm ? 1.15 : 0.85 + Math.random() * 0.35)
      p.life = p.ttl
      p.size = sizeMul * (0.7 + Math.random() * 0.6)
      p.tint.copy(PALETTE[(Math.random() * PALETTE.length) | 0])
      p.active = true
    }

    // Stash gravity scale on the group via a field so update() applies it. We keep
    // a single global gravity (cheers are short and frequent); reduced-motion
    // softening is baked into per-particle launch above, plus a lighter pull here.
    this.gravMul = gravMul
    if (!this.group.visible) this.group.visible = true
  }

  private gravMul = 1.0

  /** Find a free pooled slot; if the pool is busy, reuse the oldest (lowest life)
   *  active slot. Allocation-free round-robin scan over the small pool. */
  private claimSlot(): Particle {
    const pool = this.particles.length
    for (let s = 0; s < pool; s++) {
      const i = this.cursor
      this.cursor = (this.cursor + 1) % pool
      if (!this.particles[i].active) return this.particles[i]
    }
    // All busy: steal the one with the least life left (the oldest burst).
    let oldest = 0
    let minLife = Infinity
    for (let i = 0; i < pool; i++) {
      if (this.particles[i].life < minLife) { minLife = this.particles[i].life; oldest = i }
    }
    return this.particles[oldest]
  }

  setZone(zone: Zone) {
    const onEarth = zone === 'earth'
    this.group.visible = onEarth
    // Leaving Earth: clear active particles and collapse them so nothing lingers.
    if (!onEarth) this.clear()
  }

  /** Deactivate every particle and collapse the instance buffers. */
  private clear() {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      if (!p.active) continue
      p.active = false
      this.mtx.makeScale(0, 0, 0)
      this.mesh.setMatrixAt(i, this.mtx)
    }
    this.activeCount = 0
    this.mesh.instanceMatrix.needsUpdate = true
  }

  update(dt: number) {
    const onEarth = this.deps.zone() === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    // Off Earth: nothing to integrate (particles were cleared on zone change).
    if (!onEarth) return

    const g = GRAVITY * this.gravMul
    let active = 0
    let dirty = false

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      if (!p.active) continue

      // Integrate motion (cosmetic; never feeds physics).
      p.life -= dt
      if (p.life <= 0) {
        // Expired: deactivate and collapse this slot.
        p.active = false
        this.mtx.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(i, this.mtx)
        dirty = true
        continue
      }

      p.vy -= g * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.rot += p.spin * dt

      // Normalised lifetime 1->0; ease the scale up at the very start so particles
      // "pop in", then fade/shrink toward the end.
      const t = p.life / p.ttl                 // 1 at birth -> 0 at death
      const age = 1 - t
      const grow = age < 0.12 ? age / 0.12 : 1  // quick scale-in over first 12%
      const fade = t                            // linear fade-out
      const scl = p.size * grow * (0.5 + 0.5 * fade)

      this.mEuler.set(0, 0, p.rot)
      this.mQuat.setFromEuler(this.mEuler)
      this.mPos.set(p.x, p.y, p.z)
      this.mScl.setScalar(scl)
      this.mtx.compose(this.mPos, this.mQuat, this.mScl)
      this.mesh.setMatrixAt(i, this.mtx)

      // Additive: brightness fades with life, so the colour doubles as opacity.
      this.scratch.copy(p.tint).multiplyScalar(0.4 + 0.6 * fade)
      this.mesh.setColorAt(i, this.scratch)

      active++
      dirty = true
    }

    this.activeCount = active
    // Only touch the GPU buffers when something actually changed this frame.
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    }
  }

  dispose() {
    this.mesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
